import { randomUUID } from "node:crypto";

import {
  type AbandonInterviewRequestDto,
  AbandonInterviewRequestSchema,
  type CanonicalInterviewStateDto,
  type ContinueInterviewRequestDto,
  ContinueInterviewRequestSchema,
  type CreateInterviewRequestDto,
  CreateInterviewRequestSchema,
  type EndInterviewEarlyRequestDto,
  EndInterviewEarlyRequestSchema,
  type ErrorEnvelopeDto,
  ErrorEnvelopeSchema,
  type IdempotencyHeadersDto,
  IdempotencyHeadersSchema,
  type InterviewCommandParamsDto,
  InterviewCommandParamsSchema,
  type MarkQuestionUnknownRequestDto,
  MarkQuestionUnknownRequestSchema,
  mapOperationToStatusResponse,
  OperationResponseSchema,
  parseMappedDto,
  type RequestClarificationRequestDto,
  RequestClarificationRequestSchema,
  type RetryOperationRequestDto,
  RetryOperationRequestSchema,
  type SkipQuestionRequestDto,
  SkipQuestionRequestSchema,
  type SubmitAnswerRequestDto,
  SubmitAnswerRequestSchema,
  type SubmitSupplementRequestDto,
  SubmitSupplementRequestSchema,
} from "@interview-agent/contracts";
import {
  ActiveInterviewExistsError,
  RepositoryIdempotencyConflictError,
  RepositoryImmutableConflictError,
  RepositoryInterviewExpiredError,
  RepositoryInterviewUnavailableError,
  RepositoryNotFoundError,
  RepositoryOperationLeaseConflictError,
  RepositoryOperationRetryConflictError,
  RepositoryVersionConflictError,
  type StoredOperation,
} from "@interview-agent/db";
import {
  type AccountId,
  type Interview,
  InterviewDomainError,
  type InterviewId,
  InterviewVersionConflictError,
  type OperationId,
  parseInterviewId,
  parseOperationId,
} from "@interview-agent/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { createApiRouteErrorHandler, internalError, notFoundError } from "./api-route-errors.js";
import { authenticatedAccountId } from "./authenticated-request.js";
import {
  type AcceptedOperationExecution,
  type CreateInterviewOperationInput,
  ServerOwnedOperationSupervisor as DefaultOperationStarter,
  type InterviewOperationHandlers,
  type OperationCommandInput,
  type OperationExecutionStarter,
  type RetryInterviewOperationInput,
  type TextInterviewOperationInput,
} from "./operation-runner.js";

interface InterviewCommandHandlers {
  createInterview(input: CreateInterviewOperationInput): Promise<CommandAcceptance>;
  submitAnswer(input: TextInterviewOperationInput): Promise<CommandAcceptance>;
  submitSupplement(input: TextInterviewOperationInput): Promise<CommandAcceptance>;
  requestQuestionClarification(input: OperationCommandInput): Promise<CommandAcceptance>;
  markUnknown(input: OperationCommandInput): Promise<CommandAcceptance>;
  skip(input: OperationCommandInput): Promise<CommandAcceptance>;
  continueInterview(input: OperationCommandInput): Promise<CommandAcceptance>;
  endEarly(input: OperationCommandInput): Promise<CommandAcceptance>;
  abandon(input: OperationCommandInput): Promise<CommandAcceptance>;
  retry(input: RetryInterviewOperationInput): Promise<CommandAcceptance>;
}

type CommandAcceptance = AcceptedOperationExecution | StoredOperation;

export interface InterviewCommandStateReader {
  findById(
    interviewId: InterviewId,
    accountId: AccountId,
  ): Promise<Pick<Interview, "version" | "status" | "phase"> | null>;
}

export interface InterviewCommandRouteDependencies {
  readonly handlers: InterviewCommandHandlers;
  readonly starter: OperationExecutionStarter;
  readonly states: InterviewCommandStateReader;
  readonly now: () => Date;
  readonly nextInterviewId: () => InterviewId;
  readonly nextOperationId: () => OperationId;
}

export function createInterviewCommandRouteDependencies(
  handlers: InterviewOperationHandlers,
  states: InterviewCommandStateReader,
  starter: OperationExecutionStarter = new DefaultOperationStarter(),
): InterviewCommandRouteDependencies {
  return {
    handlers: {
      createInterview: (input) => handlers.acceptCreateInterview(input),
      submitAnswer: (input) => handlers.acceptSubmitAnswer(input),
      submitSupplement: (input) => handlers.acceptSubmitSupplement(input),
      requestQuestionClarification: (input) => handlers.acceptQuestionClarification(input),
      markUnknown: (input) => handlers.acceptMarkUnknown(input),
      skip: (input) => handlers.acceptSkip(input),
      continueInterview: (input) => handlers.acceptContinueInterview(input),
      endEarly: (input) => handlers.acceptEndEarly(input),
      abandon: (input) => handlers.acceptAbandon(input),
      retry: (input) => handlers.acceptRetry(input),
    },
    starter,
    states,
    now: () => new Date(),
    nextInterviewId: () => parseInterviewId(`interview-${randomUUID()}`),
    nextOperationId: () => parseOperationId(`operation-${randomUUID()}`),
  };
}

const commandResponses = {
  200: OperationResponseSchema,
  202: OperationResponseSchema,
  400: ErrorEnvelopeSchema,
  401: ErrorEnvelopeSchema,
  404: ErrorEnvelopeSchema,
  409: ErrorEnvelopeSchema,
  500: ErrorEnvelopeSchema,
  503: ErrorEnvelopeSchema,
} as const;

const commandRouteErrorHandler = createApiRouteErrorHandler({
  logEvent: "interview_command_route_failed",
  logMessage: "Interview command route failed",
  mapContentTypeParserErrors: true,
});

export async function registerInterviewCommandRoutes(
  app: FastifyInstance,
  dependencies: InterviewCommandRouteDependencies,
): Promise<void> {
  app.post<{
    Headers: IdempotencyHeadersDto;
    Body: CreateInterviewRequestDto;
  }>(
    "/api/v1/interviews",
    {
      schema: {
        headers: IdempotencyHeadersSchema,
        body: CreateInterviewRequestSchema,
        response: commandResponses,
      },
      errorHandler: commandRouteErrorHandler,
    },
    async (request, reply) => {
      const accountId = authenticatedAccountId(request, reply);
      if (accountId === null) {
        return;
      }
      const input: CreateInterviewOperationInput = {
        ...commandBase(request, dependencies, accountId, dependencies.nextInterviewId()),
        questionCount: request.body.questionCount,
      };
      return executeCommand(request, reply, dependencies, accountId, input.interviewId, () =>
        dependencies.handlers.createInterview(input),
      );
    },
  );

  app.post<{
    Headers: IdempotencyHeadersDto;
    Params: InterviewCommandParamsDto;
    Body: SubmitAnswerRequestDto;
  }>(
    "/api/v1/interviews/:interviewId/answers",
    commandRouteOptions(SubmitAnswerRequestSchema),
    async (request, reply) =>
      executeTextCommand(request, reply, dependencies, (input) =>
        dependencies.handlers.submitAnswer(input),
      ),
  );

  app.post<{
    Headers: IdempotencyHeadersDto;
    Params: InterviewCommandParamsDto;
    Body: SubmitSupplementRequestDto;
  }>(
    "/api/v1/interviews/:interviewId/supplements",
    commandRouteOptions(SubmitSupplementRequestSchema),
    async (request, reply) =>
      executeTextCommand(request, reply, dependencies, (input) =>
        dependencies.handlers.submitSupplement(input),
      ),
  );

  app.post<{
    Headers: IdempotencyHeadersDto;
    Params: InterviewCommandParamsDto;
    Body: RequestClarificationRequestDto;
  }>(
    "/api/v1/interviews/:interviewId/clarifications",
    commandRouteOptions(RequestClarificationRequestSchema),
    async (request, reply) =>
      executeControlCommand(request, reply, dependencies, (input) =>
        dependencies.handlers.requestQuestionClarification(input),
      ),
  );

  app.post<{
    Headers: IdempotencyHeadersDto;
    Params: InterviewCommandParamsDto;
    Body: MarkQuestionUnknownRequestDto;
  }>(
    "/api/v1/interviews/:interviewId/unknown",
    commandRouteOptions(MarkQuestionUnknownRequestSchema),
    async (request, reply) =>
      executeControlCommand(request, reply, dependencies, (input) =>
        dependencies.handlers.markUnknown(input),
      ),
  );

  app.post<{
    Headers: IdempotencyHeadersDto;
    Params: InterviewCommandParamsDto;
    Body: SkipQuestionRequestDto;
  }>(
    "/api/v1/interviews/:interviewId/skip",
    commandRouteOptions(SkipQuestionRequestSchema),
    async (request, reply) =>
      executeControlCommand(request, reply, dependencies, (input) =>
        dependencies.handlers.skip(input),
      ),
  );

  app.post<{
    Headers: IdempotencyHeadersDto;
    Params: InterviewCommandParamsDto;
    Body: ContinueInterviewRequestDto;
  }>(
    "/api/v1/interviews/:interviewId/continue",
    commandRouteOptions(ContinueInterviewRequestSchema),
    async (request, reply) =>
      executeControlCommand(request, reply, dependencies, (input) =>
        dependencies.handlers.continueInterview(input),
      ),
  );

  app.post<{
    Headers: IdempotencyHeadersDto;
    Params: InterviewCommandParamsDto;
    Body: EndInterviewEarlyRequestDto;
  }>(
    "/api/v1/interviews/:interviewId/end-early",
    commandRouteOptions(EndInterviewEarlyRequestSchema),
    async (request, reply) =>
      executeControlCommand(request, reply, dependencies, (input) =>
        dependencies.handlers.endEarly(input),
      ),
  );

  app.post<{
    Headers: IdempotencyHeadersDto;
    Params: InterviewCommandParamsDto;
    Body: AbandonInterviewRequestDto;
  }>(
    "/api/v1/interviews/:interviewId/abandon",
    commandRouteOptions(AbandonInterviewRequestSchema),
    async (request, reply) =>
      executeControlCommand(request, reply, dependencies, (input) =>
        dependencies.handlers.abandon(input),
      ),
  );

  app.post<{
    Headers: IdempotencyHeadersDto;
    Params: InterviewCommandParamsDto;
    Body: RetryOperationRequestDto;
  }>(
    "/api/v1/interviews/:interviewId/retry",
    commandRouteOptions(RetryOperationRequestSchema),
    async (request, reply) => {
      const accountId = authenticatedAccountId(request, reply);
      if (accountId === null) {
        return;
      }
      const interviewId = parseInterviewId(request.params.interviewId);
      const input: RetryInterviewOperationInput = {
        ...commandBase(request, dependencies, accountId, interviewId),
        targetOperationId: parseOperationId(request.body.operationId),
      };
      return executeCommand(request, reply, dependencies, accountId, interviewId, () =>
        dependencies.handlers.retry(input),
      );
    },
  );
}

function commandRouteOptions(body: object) {
  return {
    schema: {
      headers: IdempotencyHeadersSchema,
      params: InterviewCommandParamsSchema,
      body,
      response: commandResponses,
    },
    errorHandler: commandRouteErrorHandler,
  };
}

async function executeTextCommand(
  request: FastifyRequest<{
    Headers: IdempotencyHeadersDto;
    Params: InterviewCommandParamsDto;
    Body: { readonly expectedVersion: number; readonly text: string };
  }>,
  reply: FastifyReply,
  dependencies: InterviewCommandRouteDependencies,
  invoke: (input: TextInterviewOperationInput) => Promise<CommandAcceptance>,
) {
  const accountId = authenticatedAccountId(request, reply);
  if (accountId === null) {
    return;
  }
  const interviewId = parseInterviewId(request.params.interviewId);
  const input: TextInterviewOperationInput = {
    ...commandBase(request, dependencies, accountId, interviewId),
    text: request.body.text,
  };
  return executeCommand(request, reply, dependencies, accountId, interviewId, () => invoke(input));
}

async function executeControlCommand(
  request: FastifyRequest<{
    Headers: IdempotencyHeadersDto;
    Params: InterviewCommandParamsDto;
    Body: { readonly expectedVersion: number };
  }>,
  reply: FastifyReply,
  dependencies: InterviewCommandRouteDependencies,
  invoke: (input: OperationCommandInput) => Promise<CommandAcceptance>,
) {
  const accountId = authenticatedAccountId(request, reply);
  if (accountId === null) {
    return;
  }
  const interviewId = parseInterviewId(request.params.interviewId);
  const input = commandBase(request, dependencies, accountId, interviewId);
  return executeCommand(request, reply, dependencies, accountId, interviewId, () => invoke(input));
}

function commandBase(
  request: FastifyRequest<{
    Headers: IdempotencyHeadersDto;
    Body: { readonly expectedVersion: number };
  }>,
  dependencies: InterviewCommandRouteDependencies,
  accountId: AccountId,
  interviewId: InterviewId,
): OperationCommandInput {
  return {
    accountId,
    interviewId,
    operationId: dependencies.nextOperationId(),
    idempotencyKey: request.headers["idempotency-key"],
    expectedVersion: request.body.expectedVersion,
    occurredAt: dependencies.now(),
  };
}

async function executeCommand(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: InterviewCommandRouteDependencies,
  accountId: AccountId,
  interviewId: InterviewId,
  invoke: () => Promise<CommandAcceptance>,
) {
  try {
    const result = await invoke();
    const accepted = "operation" in result ? result : { operation: result, work: null };
    const { operation } = accepted;
    const response = mapOperationToStatusResponse(operation);
    if (response.status === "pending" || response.status === "processing") {
      const sent = reply.code(202).send(response);
      if (accepted.work !== null) {
        dependencies.starter.start(accepted.work);
      }
      return sent;
    }
    if (response.status === "succeeded") {
      return reply.code(200).send(response);
    }
    if (response.failure.code === "model_failure" || response.failure.retryable) {
      return reply.code(503).send({
        error: {
          code: "operation_failure",
          operationId: response.operationId,
          failure: response.failure,
        },
      });
    }
    const classification = (operation.error as { readonly classification?: unknown } | null)
      ?.classification;
    if (classification === "command_rejected") {
      return reply.code(409).send(commandRejected());
    }
    const current = await dependencies.states.findById(interviewId, accountId);
    if (
      current !== null &&
      (classification === "version_conflict" || current.version !== operation.expectedVersion)
    ) {
      return reply.code(409).send(versionConflict(interviewId, current));
    }
    return reply.code(409).send(commandRejected());
  } catch (error) {
    return sendCommandError(request, reply, dependencies, accountId, interviewId, error);
  }
}

async function sendCommandError(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: InterviewCommandRouteDependencies,
  accountId: AccountId,
  interviewId: InterviewId,
  error: unknown,
) {
  if (
    error instanceof InterviewVersionConflictError ||
    error instanceof RepositoryVersionConflictError
  ) {
    const current = await dependencies.states.findById(interviewId, accountId);
    if (current === null) {
      return reply.code(404).send(notFoundError("interview"));
    }
    return reply.code(409).send(versionConflict(interviewId, current));
  }
  if (error instanceof RepositoryNotFoundError) {
    return reply.code(404).send(notFoundError(publicResource(error.resource)));
  }
  if (error instanceof RepositoryInterviewUnavailableError) {
    if (error.status === "deleting") {
      return reply.code(404).send(notFoundError("interview"));
    }
    return reply.code(409).send(commandRejected());
  }
  if (error instanceof RepositoryInterviewExpiredError) {
    return reply.code(409).send(commandRejected());
  }
  if (
    error instanceof ActiveInterviewExistsError ||
    error instanceof InterviewDomainError ||
    error instanceof RepositoryIdempotencyConflictError ||
    error instanceof RepositoryImmutableConflictError ||
    error instanceof RepositoryOperationLeaseConflictError ||
    error instanceof RepositoryOperationRetryConflictError
  ) {
    return reply.code(409).send(commandRejected());
  }
  request.log.error({ event: "interview_command_failed" }, "Interview command failed");
  return reply.code(500).send(internalError());
}

function versionConflict(
  interviewId: InterviewId,
  current: Pick<Interview, "version" | "status" | "phase">,
): ErrorEnvelopeDto {
  let currentState: CanonicalInterviewStateDto;
  if (current.status === "active") {
    if (current.phase === null) {
      throw new Error("Active canonical interview state has no phase");
    }
    currentState = {
      status: "active",
      phase: current.phase,
    };
  } else {
    currentState = {
      status: current.status,
      phase: null,
    };
  }
  return parseMappedDto(
    ErrorEnvelopeSchema,
    {
      error: {
        code: "version_conflict",
        message: "Interview state changed; reload the canonical state and retry.",
        interviewId: String(interviewId),
        currentVersion: current.version,
        currentState,
      },
    },
    "version conflict error",
  );
}

function commandRejected(): ErrorEnvelopeDto {
  return parseMappedDto(
    ErrorEnvelopeSchema,
    {
      error: {
        code: "command_rejected",
        message: "The interview does not accept this command in its current state.",
      },
    },
    "command rejection error",
  );
}

function publicResource(resource: string): "account" | "interview" | "operation" | "report" {
  const normalized = resource.toLowerCase();
  if (normalized.includes("account")) {
    return "account";
  }
  if (normalized.includes("operation")) {
    return "operation";
  }
  if (normalized.includes("report")) {
    return "report";
  }
  return "interview";
}
