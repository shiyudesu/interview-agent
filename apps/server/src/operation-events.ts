import { fastifySSE } from "@fastify/sse";
import {
  ErrorEnvelopeSchema,
  mapOperationTextDeltaEvent,
  mapOperationToTerminalEvent,
  type OperationEventDto,
  type OperationEventStreamHeadersDto,
  OperationEventStreamHeadersSchema,
  OperationReadParamsSchema,
  type OperationTerminalEventDto,
  type OperationTextDeltaEventDto,
} from "@interview-agent/contracts";
import type { PgRepositoryUnitOfWork, StoredOperation } from "@interview-agent/db";
import {
  type AccountId,
  type InterviewId,
  type OperationId,
  parseOperationId,
} from "@interview-agent/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  createApiRouteErrorHandler,
  internalError,
  notFoundError,
  unauthorizedError,
} from "./api-route-errors.js";
import { authenticatedRequestContext } from "./authenticated-request.js";
import { retryAfterRepositoryInterviewExpiry } from "./repository-interview-expiry.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 1_000;
const DEFAULT_HISTORY_LIMIT = 8;
const DEFAULT_HISTORY_OPERATION_LIMIT = 1_000;
const DEFAULT_REPLAY_TTL_MS = 60_000;
const DEFAULT_ERASURE_TTL_MS = 10 * 60_000;
const DEFAULT_TERMINAL_PUBLICATION_GRACE_MS = 250;
const OPERATION_EVENT_TRANSACTION = {
  isolationLevel: "repeatable read",
  accessMode: "read write",
} as const;

const operationEventRouteErrorHandler = createApiRouteErrorHandler({
  logEvent: "operation_event_route_failed",
  logMessage: "Operation event route failed",
  mapContentTypeParserErrors: false,
});

type OperationEventListener = (event: OperationEventDto) => void;

interface OperationEventListenerRegistration {
  readonly listener: OperationEventListener;
  readonly close: () => void;
}

interface OperationEventState {
  readonly accountId: AccountId;
  readonly interviewId: InterviewId;
  readonly events: OperationEventDto[];
  readonly listeners: Set<OperationEventListenerRegistration>;
  attemptCount: number;
  continuityUnknown: boolean;
  nextSequence: number;
  touchedAt: number;
  historyExpiresAt: number | null;
  historyTimer: NodeJS.Timeout | undefined;
}

export interface OperationEventSubscriptionOptions {
  readonly allowTruncatedStart?: boolean;
}

export interface OperationEventBrokerOptions {
  readonly historyLimit?: number;
  readonly historyOperationLimit?: number;
  readonly replayTtlMs?: number;
  readonly erasureTtlMs?: number;
  readonly now?: () => Date;
}

export interface OperationEventSubscription {
  readonly replay: readonly OperationEventDto[];
  readonly terminalSequence: number | null;
  unsubscribe(): void;
}

export interface OperationEventPublisher {
  beginAttempt(operation: StoredOperation): void;
  publishTextDelta(
    operation: StoredOperation,
    text: string,
    occurredAt: Date,
  ): OperationTextDeltaEventDto | null;
  publishTextAndTerminal(
    operation: StoredOperation,
    text: string,
    occurredAt: Date,
  ): readonly [OperationTextDeltaEventDto, OperationTerminalEventDto] | null;
  publishTerminal(
    operation: StoredOperation,
    continuityUnknown?: boolean,
  ): OperationTerminalEventDto | null;
}

export class OperationEventReplayUnavailableError extends Error {
  constructor(readonly operationId: OperationId) {
    super("Operation event replay is unavailable");
    this.name = "OperationEventReplayUnavailableError";
  }
}

export class OperationEventBroker implements OperationEventPublisher {
  private readonly states = new Map<OperationId, OperationEventState>();
  private readonly historyLimit: number;
  private readonly historyOperationLimit: number;
  private readonly replayTtlMs: number;
  private readonly erasureTtlMs: number;
  private readonly now: () => Date;
  private readonly erasedOperations = new Map<OperationId, number>();
  private readonly erasedInterviews = new Map<string, number>();
  private readonly erasedAccounts = new Map<AccountId, number>();
  private readonly tombstoneTimers = new Set<NodeJS.Timeout>();
  private closed = false;

  constructor(options: OperationEventBrokerOptions = {}) {
    this.historyLimit = positiveInteger(options.historyLimit, DEFAULT_HISTORY_LIMIT, 2);
    this.historyOperationLimit = positiveInteger(
      options.historyOperationLimit,
      DEFAULT_HISTORY_OPERATION_LIMIT,
      1,
    );
    this.replayTtlMs = positiveInteger(options.replayTtlMs, DEFAULT_REPLAY_TTL_MS, 1);
    this.erasureTtlMs = positiveInteger(options.erasureTtlMs, DEFAULT_ERASURE_TTL_MS, 1);
    this.now = options.now ?? (() => new Date());
  }

  beginAttempt(operation: StoredOperation): void {
    if (this.closed) {
      return;
    }
    this.expireHistory(operation.id);
    const state = this.states.get(operation.id);
    if (state === undefined) {
      return;
    }
    if (!sameTarget(state, operation)) {
      this.deleteState(operation.id, state, true);
      return;
    }
    this.syncAttempt(operation, state);
  }

  publishTextDelta(
    operation: StoredOperation,
    text: string,
    occurredAt: Date,
  ): OperationTextDeltaEventDto | null {
    if (this.closed) {
      return null;
    }
    const state = this.state(operation);
    if (state === null || !this.syncAttempt(operation, state)) {
      return null;
    }
    if (terminalSequence(state.events) !== null) {
      return null;
    }
    const sequence = this.takeSequence(operation.id, state);
    if (sequence === null) {
      return null;
    }
    const event = mapOperationTextDeltaEvent(operation.id, sequence, text, occurredAt);
    this.publish(operation.id, state, event);
    return event;
  }

  publishTerminal(
    operation: StoredOperation,
    continuityUnknown = false,
  ): OperationTerminalEventDto | null {
    if (this.closed) {
      return null;
    }
    if (operation.status === "pending" || operation.status === "processing") {
      return null;
    }
    const state = this.state(operation, continuityUnknown);
    if (state === null || !this.syncAttempt(operation, state)) {
      return null;
    }
    const existing = terminalEvent(state.events);
    if (existing !== null) {
      return existing;
    }
    const sequence = this.takeSequence(operation.id, state);
    if (sequence === null) {
      return null;
    }
    const event = mapOperationToTerminalEvent(operation, sequence);
    if (event === null) {
      return null;
    }
    this.publish(operation.id, state, event);
    return event;
  }

  publishTextAndTerminal(
    operation: StoredOperation,
    text: string,
    occurredAt: Date,
  ): readonly [OperationTextDeltaEventDto, OperationTerminalEventDto] | null {
    if (this.closed || operation.status === "pending" || operation.status === "processing") {
      return null;
    }
    const state = this.state(operation);
    if (
      state === null ||
      !this.syncAttempt(operation, state) ||
      terminalSequence(state.events) !== null
    ) {
      return null;
    }
    const textSequence = this.takeSequence(operation.id, state);
    const terminalEventSequence = this.takeSequence(operation.id, state);
    if (textSequence === null || terminalEventSequence === null) {
      return null;
    }
    const textEvent = mapOperationTextDeltaEvent(operation.id, textSequence, text, occurredAt);
    const terminal = mapOperationToTerminalEvent(operation, terminalEventSequence);
    if (terminal === null) {
      return null;
    }
    this.publish(operation.id, state, textEvent);
    this.publish(operation.id, state, terminal);
    return [textEvent, terminal];
  }

  subscribe(
    operation: StoredOperation,
    lastSequence: number,
    listener: OperationEventListener,
    close: () => void,
    options: OperationEventSubscriptionOptions = {},
  ): OperationEventSubscription {
    if (this.isErased(operation)) {
      throw new OperationEventReplayUnavailableError(operation.id);
    }
    this.expireHistory(operation.id);
    let state = this.states.get(operation.id);
    if (state !== undefined && !sameTarget(state, operation)) {
      this.eraseOperation(operation.id);
      state = undefined;
    }
    if (state === undefined) {
      if (lastSequence > 0 || this.closed) {
        throw new OperationEventReplayUnavailableError(operation.id);
      }
      state = this.state(operation) ?? undefined;
    }
    if (state === undefined || !this.syncAttempt(operation, state)) {
      throw new OperationEventReplayUnavailableError(operation.id);
    }
    if (state.continuityUnknown && lastSequence > 0) {
      throw new OperationEventReplayUnavailableError(operation.id);
    }
    const earliest = state.events[0]?.sequence;
    const latest = state.events.at(-1)?.sequence;
    const lastPublished = state.nextSequence - 1;
    if (
      (earliest !== undefined &&
        lastSequence < earliest - 1 &&
        options.allowTruncatedStart !== true) ||
      (latest === undefined &&
        lastSequence < lastPublished &&
        options.allowTruncatedStart !== true) ||
      lastSequence > lastPublished
    ) {
      throw new OperationEventReplayUnavailableError(operation.id);
    }
    const registration = { listener, close };
    state.listeners.add(registration);
    state.touchedAt = this.now().getTime();
    let subscribed = true;
    return {
      replay: Object.freeze(state.events.filter((event) => event.sequence > lastSequence)),
      terminalSequence: terminalSequence(state.events),
      unsubscribe: () => {
        if (!subscribed) {
          return;
        }
        subscribed = false;
        state?.listeners.delete(registration);
        if (state?.listeners.size === 0 && state.events.length === 0) {
          this.deleteState(operation.id, state);
        }
        this.trimHistoryOperations();
      },
    };
  }

  hasState(operation: StoredOperation): boolean {
    this.expireHistory(operation.id);
    const state = this.states.get(operation.id);
    return state !== undefined && sameTarget(state, operation);
  }

  history(operation: StoredOperation): readonly OperationEventDto[] {
    this.expireHistory(operation.id);
    const state = this.states.get(operation.id);
    return Object.freeze(
      state !== undefined && sameTarget(state, operation) ? [...state.events] : [],
    );
  }

  listenerCount(operation: StoredOperation): number {
    const state = this.states.get(operation.id);
    return state !== undefined && sameTarget(state, operation) ? state.listeners.size : 0;
  }

  eraseOperation(operationId: OperationId): void {
    this.markErased(this.erasedOperations, operationId);
    const state = this.states.get(operationId);
    if (state !== undefined) {
      this.deleteState(operationId, state, true);
    }
  }

  eraseInterview(accountId: AccountId, interviewId: InterviewId): void {
    this.markErased(this.erasedInterviews, interviewErasureKey(accountId, interviewId));
    for (const [operationId, state] of [...this.states]) {
      if (state.accountId === accountId && state.interviewId === interviewId) {
        this.deleteState(operationId, state, true);
      }
    }
  }

  eraseAccount(accountId: AccountId): void {
    this.markErased(this.erasedAccounts, accountId);
    for (const [operationId, state] of [...this.states]) {
      if (state.accountId === accountId) {
        this.deleteState(operationId, state, true);
      }
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const [operationId, state] of [...this.states]) {
      this.deleteState(operationId, state, true);
    }
    for (const timer of this.tombstoneTimers) {
      clearTimeout(timer);
    }
    this.tombstoneTimers.clear();
    this.erasedOperations.clear();
    this.erasedInterviews.clear();
    this.erasedAccounts.clear();
  }

  private state(operation: StoredOperation, continuityUnknown = false): OperationEventState | null {
    if (this.isErased(operation)) {
      const existing = this.states.get(operation.id);
      if (existing !== undefined) {
        this.deleteState(operation.id, existing, true);
      }
      return null;
    }
    this.expireHistory(operation.id);
    const existing = this.states.get(operation.id);
    if (existing !== undefined) {
      if (!sameTarget(existing, operation)) {
        this.deleteState(operation.id, existing, true);
        return this.createState(operation, continuityUnknown);
      }
      existing.continuityUnknown ||= continuityUnknown;
      existing.touchedAt = this.now().getTime();
      return existing;
    }
    return this.createState(operation, continuityUnknown);
  }

  private createState(
    operation: StoredOperation,
    continuityUnknown = false,
  ): OperationEventState | null {
    if (this.closed) {
      return null;
    }
    const created: OperationEventState = {
      accountId: operation.accountId,
      interviewId: operation.interviewId,
      events: [],
      listeners: new Set(),
      attemptCount: operation.attemptCount,
      continuityUnknown: continuityUnknown || operation.attemptCount > 1,
      nextSequence: 1,
      touchedAt: this.now().getTime(),
      historyExpiresAt: null,
      historyTimer: undefined,
    };
    this.states.set(operation.id, created);
    this.trimHistoryOperations();
    return created;
  }

  private syncAttempt(operation: StoredOperation, state: OperationEventState): boolean {
    if (operation.attemptCount < state.attemptCount) {
      return false;
    }
    if (operation.attemptCount > state.attemptCount) {
      state.attemptCount = operation.attemptCount;
      this.clearHistory(operation.id, state);
    }
    return true;
  }

  private takeSequence(operationId: OperationId, state: OperationEventState): number | null {
    const sequence = state.nextSequence;
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      this.deleteState(operationId, state, true);
      return null;
    }
    state.nextSequence += 1;
    return sequence;
  }

  private publish(
    operationId: OperationId,
    state: OperationEventState,
    event: OperationEventDto,
  ): void {
    state.events.push(event);
    if (state.events.length > this.historyLimit) {
      state.events.splice(0, state.events.length - this.historyLimit);
    }
    const now = this.now().getTime();
    state.touchedAt = now;
    state.historyExpiresAt = now + this.replayTtlMs;
    this.scheduleHistoryExpiry(operationId, state);
    for (const registration of [...state.listeners]) {
      try {
        registration.listener(event);
      } catch {
        state.listeners.delete(registration);
      }
    }
    this.trimHistoryOperations();
  }

  private scheduleHistoryExpiry(operationId: OperationId, state: OperationEventState): void {
    if (state.historyTimer !== undefined) {
      clearTimeout(state.historyTimer);
    }
    const expiresAt = state.historyExpiresAt;
    if (expiresAt === null) {
      return;
    }
    const delay = Math.min(Math.max(1, expiresAt - this.now().getTime()), 2_147_483_647);
    state.historyTimer = setTimeout(() => {
      state.historyTimer = undefined;
      const current = this.states.get(operationId);
      if (current !== state || state.historyExpiresAt === null) {
        return;
      }
      if (state.historyExpiresAt > this.now().getTime()) {
        this.scheduleHistoryExpiry(operationId, state);
        return;
      }
      this.expireHistory(operationId);
    }, delay);
    state.historyTimer.unref();
  }

  private expireHistory(operationId: OperationId): void {
    const state = this.states.get(operationId);
    if (
      state === undefined ||
      state.historyExpiresAt === null ||
      state.historyExpiresAt > this.now().getTime()
    ) {
      return;
    }
    this.clearHistory(operationId, state);
    if (state.listeners.size === 0) {
      this.deleteState(operationId, state);
    }
  }

  private clearHistory(operationId: OperationId, state: OperationEventState): void {
    state.events.splice(0);
    state.historyExpiresAt = null;
    if (state.historyTimer !== undefined) {
      clearTimeout(state.historyTimer);
      state.historyTimer = undefined;
    }
    if (state.listeners.size === 0 && this.closed) {
      this.states.delete(operationId);
    }
  }

  private deleteState(
    operationId: OperationId,
    state: OperationEventState,
    closeListeners = false,
  ): void {
    if (this.states.get(operationId) !== state) {
      return;
    }
    this.states.delete(operationId);
    if (state.historyTimer !== undefined) {
      clearTimeout(state.historyTimer);
      state.historyTimer = undefined;
    }
    state.events.splice(0);
    state.historyExpiresAt = null;
    if (closeListeners) {
      for (const registration of [...state.listeners]) {
        try {
          registration.close();
        } catch {
          // Stream closure is best-effort during erasure.
        }
      }
    }
    state.listeners.clear();
  }

  private trimHistoryOperations(): void {
    const retained = [...this.states.entries()].filter(([, state]) => state.events.length > 0);
    if (retained.length <= this.historyOperationLimit) {
      return;
    }
    retained
      .filter(([, state]) => state.listeners.size === 0)
      .sort((left, right) => left[1].touchedAt - right[1].touchedAt)
      .slice(0, retained.length - this.historyOperationLimit)
      .forEach(([operationId, state]) => {
        this.deleteState(operationId, state);
      });
  }

  private isErased(operation: StoredOperation): boolean {
    const now = this.now().getTime();
    return (
      activeTombstone(this.erasedOperations, operation.id, now) ||
      activeTombstone(this.erasedAccounts, operation.accountId, now) ||
      activeTombstone(
        this.erasedInterviews,
        interviewErasureKey(operation.accountId, operation.interviewId),
        now,
      )
    );
  }

  private markErased<Key>(tombstones: Map<Key, number>, key: Key): void {
    const expiresAt = this.now().getTime() + this.erasureTtlMs;
    tombstones.set(key, expiresAt);
    const timer = setTimeout(() => {
      this.tombstoneTimers.delete(timer);
      if (tombstones.get(key) === expiresAt) {
        tombstones.delete(key);
      }
    }, this.erasureTtlMs);
    timer.unref();
    this.tombstoneTimers.add(timer);
  }
}

export interface OperationEventAccessReader {
  findAccessible(
    accountId: AccountId,
    sessionId: string,
    operationId: OperationId,
  ): Promise<StoredOperation | null>;
  isSessionActive?(accountId: AccountId, sessionId: string): Promise<boolean>;
}

export interface OperationEventRouteDependencies {
  readonly broker: OperationEventBroker;
  readonly access: OperationEventAccessReader;
  readonly heartbeatIntervalMs?: number;
  readonly statusPollIntervalMs?: number;
  readonly terminalPublicationGraceMs?: number;
  readonly now?: () => Date;
}

export function createOperationEventRouteDependencies(
  unitOfWork: PgRepositoryUnitOfWork,
  broker: OperationEventBroker,
): OperationEventRouteDependencies {
  return {
    broker,
    access: {
      findAccessible: (accountId, sessionId, operationId) =>
        retryAfterRepositoryInterviewExpiry(() =>
          unitOfWork.run(async (repositories) => {
            if (!(await repositories.accounts.isSessionActive(accountId, sessionId))) {
              return null;
            }
            return repositories.operations.findById(operationId, accountId);
          }, OPERATION_EVENT_TRANSACTION),
        ),
      isSessionActive: (accountId, sessionId) =>
        unitOfWork.run(
          (repositories) => repositories.accounts.isSessionActive(accountId, sessionId),
          {
            isolationLevel: "repeatable read",
            accessMode: "read only",
          },
        ),
    },
  };
}

export async function registerOperationEventRoutes(
  app: FastifyInstance,
  dependencies: OperationEventRouteDependencies,
): Promise<void> {
  const activeStreams = new Set<() => void>();
  await app.register(fastifySSE, {
    heartbeatInterval: dependencies.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
  });
  app.addHook("preClose", async () => {
    for (const close of [...activeStreams]) {
      close();
    }
    dependencies.broker.close();
  });

  app.get<{
    Params: { readonly operationId: string };
    Headers: OperationEventStreamHeadersDto;
  }>(
    "/api/v1/operations/:operationId/events",
    {
      sse: { kind: "only" },
      schema: {
        params: OperationReadParamsSchema,
        headers: OperationEventStreamHeadersSchema,
        response: {
          400: ErrorEnvelopeSchema,
          401: ErrorEnvelopeSchema,
          404: ErrorEnvelopeSchema,
          409: ErrorEnvelopeSchema,
          500: ErrorEnvelopeSchema,
        },
      },
      errorHandler: operationEventRouteErrorHandler,
    },
    async (request, reply) => streamOperationEvents(request, reply, dependencies, activeStreams),
  );
}

async function streamOperationEvents(
  request: FastifyRequest<{
    Params: { readonly operationId: string };
    Headers: OperationEventStreamHeadersDto;
  }>,
  reply: FastifyReply,
  dependencies: OperationEventRouteDependencies,
  activeStreams: Set<() => void>,
) {
  const context = authenticatedRequestContext(request, reply);
  if (context === null) {
    return;
  }
  const accountId = context.accountId;
  const sessionId = context.sessionId;
  const operationId = parseOperationId(request.params.operationId);
  const lastEventId = request.headers["last-event-id"];
  const lastSequence = parseLastEventId(lastEventId);
  if (lastSequence === null) {
    return reply.code(400).send(invalidLastEventId());
  }

  let closed = false;
  let pollTimer: NodeJS.Timeout | undefined;
  let subscription: OperationEventSubscription | undefined;
  let writeQueue = Promise.resolve();

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    activeStreams.delete(close);
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
    }
    subscription?.unsubscribe();
    if (reply.sse.isConnected) {
      reply.sse.close();
    }
  }

  activeStreams.add(close);
  reply.sse.onClose(close);

  let operation: StoredOperation | null;
  try {
    operation = await dependencies.access.findAccessible(accountId, sessionId, operationId);
  } catch {
    close();
    request.log.error({ event: "operation_event_status_failed" }, "Operation event status failed");
    return reply.code(500).send(internalError());
  }
  if (closed) {
    return;
  }
  if (operation === null) {
    let sessionActive: boolean;
    try {
      sessionActive = await isSessionActive(dependencies.access, accountId, sessionId);
    } catch {
      close();
      request.log.error(
        { event: "operation_event_session_status_failed" },
        "Operation event session status failed",
      );
      return reply.code(500).send(internalError());
    }
    close();
    if (!sessionActive) {
      return reply.code(401).send(unauthorizedError());
    }
    return reply.code(404).send(notFoundError("operation"));
  }

  if (!dependencies.broker.hasState(operation) && lastSequence > 0) {
    close();
    return reply.code(409).send(replayUnavailable(operationId));
  }
  const brokerHadState = dependencies.broker.hasState(operation);
  if (canonicalTerminalReady(operation, dependencies)) {
    dependencies.broker.publishTerminal(operation, !brokerHadState);
  }

  try {
    subscription = dependencies.broker.subscribe(operation, lastSequence, enqueue, close, {
      allowTruncatedStart: lastEventId === undefined,
    });
  } catch (error) {
    if (error instanceof OperationEventReplayUnavailableError) {
      close();
      return reply.code(409).send(replayUnavailable(operationId));
    }
    close();
    throw error;
  }
  if (subscription === undefined) {
    throw new Error("Operation event subscription was not created");
  }

  if (subscription.terminalSequence !== null && subscription.terminalSequence <= lastSequence) {
    close();
    return reply.code(204).send();
  }

  function enqueue(event: OperationEventDto): void {
    writeQueue = writeQueue
      .then(async () => {
        if (closed || !reply.sse.isConnected) {
          return;
        }
        const current = await dependencies.access.findAccessible(accountId, sessionId, operationId);
        if (current === null) {
          if (await isSessionActive(dependencies.access, accountId, sessionId)) {
            dependencies.broker.eraseOperation(operationId);
          }
          close();
          return;
        }
        if (closed || !reply.sse.isConnected) {
          return;
        }
        await reply.sse.send({
          id: String(event.sequence),
          event: event.type,
          data: event,
        });
        if (event.type === "succeeded" || event.type === "failed") {
          close();
        }
      })
      .catch(() => {
        request.log.error(
          { event: "operation_event_write_failed" },
          "Operation event write failed",
        );
        close();
      });
  }

  if (closed) {
    return;
  }
  reply.sse.keepAlive();
  reply.sse.sendHeaders(200);
  for (const event of subscription.replay) {
    enqueue(event);
  }

  const pollInterval = dependencies.statusPollIntervalMs ?? DEFAULT_STATUS_POLL_INTERVAL_MS;
  let pollInFlight = false;
  pollTimer = setInterval(() => {
    if (closed || pollInFlight) {
      return;
    }
    pollInFlight = true;
    void dependencies.access
      .findAccessible(accountId, sessionId, operationId)
      .then(async (current) => {
        if (closed) {
          return;
        }
        if (current === null) {
          if (await isSessionActive(dependencies.access, accountId, sessionId)) {
            dependencies.broker.eraseOperation(operationId);
          }
          close();
          return;
        }
        if (closed) {
          return;
        }
        if (canonicalTerminalReady(current, dependencies)) {
          dependencies.broker.publishTerminal(current, !dependencies.broker.hasState(current));
        }
      })
      .catch(() => {
        request.log.error(
          { event: "operation_event_status_poll_failed" },
          "Operation event status poll failed",
        );
        close();
      })
      .finally(() => {
        pollInFlight = false;
      });
  }, pollInterval);
  pollTimer.unref();

  await writeQueue;
}

function terminalEvent(events: readonly OperationEventDto[]): OperationTerminalEventDto | null {
  const event = events.findLast(
    (candidate) => candidate.type === "succeeded" || candidate.type === "failed",
  );
  return event?.type === "succeeded" || event?.type === "failed" ? event : null;
}

function terminalSequence(events: readonly OperationEventDto[]): number | null {
  return terminalEvent(events)?.sequence ?? null;
}

function sameTarget(state: OperationEventState, operation: StoredOperation): boolean {
  return state.accountId === operation.accountId && state.interviewId === operation.interviewId;
}

function canonicalTerminalReady(
  operation: StoredOperation,
  dependencies: OperationEventRouteDependencies,
): boolean {
  if (operation.status !== "succeeded" && operation.status !== "failed") {
    return false;
  }
  const completedAt = operation.completedAt;
  if (completedAt === null) {
    return false;
  }
  const grace = dependencies.terminalPublicationGraceMs ?? DEFAULT_TERMINAL_PUBLICATION_GRACE_MS;
  return (dependencies.now?.() ?? new Date()).getTime() - completedAt.getTime() >= grace;
}

function interviewErasureKey(accountId: AccountId, interviewId: InterviewId): string {
  return `${accountId}\u0000${interviewId}`;
}

function activeTombstone<Key>(tombstones: Map<Key, number>, key: Key, now: number): boolean {
  const expiresAt = tombstones.get(key);
  if (expiresAt === undefined) {
    return false;
  }
  if (expiresAt <= now) {
    tombstones.delete(key);
    return false;
  }
  return true;
}

function isSessionActive(
  access: OperationEventAccessReader,
  accountId: AccountId,
  sessionId: string,
): Promise<boolean> {
  return access.isSessionActive?.(accountId, sessionId) ?? Promise.resolve(true);
}

function parseLastEventId(value: string | undefined): number | null {
  if (value === undefined) {
    return 0;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function invalidLastEventId() {
  return {
    error: {
      code: "validation_error",
      message: "The request is invalid.",
      issues: [
        {
          path: "/headers/last-event-id",
          code: "invalid_last_event_id",
          message: "Last-Event-ID must be a non-negative safe integer.",
        },
      ],
    },
  };
}

function positiveInteger(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`Expected an integer greater than or equal to ${minimum}`);
  }
  return value;
}

function replayUnavailable(operationId: OperationId) {
  return {
    error: {
      code: "operation_event_replay_unavailable",
      message: "Operation event replay is no longer available; reload canonical state.",
      operationId: String(operationId),
    },
  };
}
