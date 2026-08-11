import {
  parseAccountId,
  parseFollowUpGoalId,
  parseInterviewId,
  parseOperationId,
  parseRubricItemId,
} from "@interview-agent/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  account,
  createPurgeSubjectIdentifierHash,
  type DatabaseClient,
  deletionRequests,
  interviewMessages,
  interviewSessions,
  LifecycleService,
  MAXIMUM_MAINTENANCE_INTERVAL_MS,
  operations,
  PgInterviewRepository,
  PgLifecycleRepository,
  PgOperationRepository,
  PgRepositoryUnitOfWork,
  purgeAuditEvents,
  questionBankVersions,
  questionEvaluations,
  RepositoryInterviewExpiredError,
  reports,
  session,
  sessionQuestionSnapshots,
  user,
  verification,
} from "../src/index.js";
import { validateOperationPayload } from "../src/repositories/operation-payload.js";
import { type PostgresTestDatabase, PostgresTestHarness } from "./support/postgres-test-harness.js";
import { questionBankFixtureSourceHash } from "./support/question-bank-fixture.js";

const HASH_SECRET = "lifecycle-test-secret-that-is-at-least-32-characters";
const NOW = new Date("2026-08-10T00:00:00.000Z");
const CREATED_AT = new Date("2026-08-01T00:00:00.000Z");
const numericOverflowJson = "1e1000000";
const unsupportedUnicodeEscapeJson = String.raw`{"link":{"userId":"\u0000"}}`;
const LIFECYCLE_DOMAINS = [
  "go_language",
  "concurrency_runtime_performance",
  "http_rpc_api",
  "database_storage",
  "cache_messaging_distributed",
] as const;
let harness: PostgresTestHarness;
let testDatabase: PostgresTestDatabase;
let client: DatabaseClient;
let lifecycleRepository: PgLifecycleRepository;
let lifecycle: LifecycleService;
let interviewRepository: PgInterviewRepository;
let operationRepository: PgOperationRepository;
let unitOfWork: PgRepositoryUnitOfWork;
let requestSequence = 0;

function ownerId(value: string) {
  return parseAccountId(value);
}

function interviewId(value: string) {
  return parseInterviewId(value);
}

function lifecycleDomain(index: number): (typeof LIFECYCLE_DOMAINS)[number] {
  const domain = LIFECYCLE_DOMAINS[index];
  if (domain === undefined) {
    throw new Error(`Missing lifecycle domain fixture at index ${index}`);
  }
  return domain;
}

async function seedOwner(value: string): Promise<void> {
  await client.database.insert(user).values({
    id: value,
    name: value,
    email: `${value}@example.com`,
  });
}

async function seedQuestionBank(): Promise<void> {
  await client.database.insert(questionBankVersions).values(
    Array.from({ length: 5 }, (_, index) => ({
      questionId: `lifecycle-question-${index + 1}`,
      contentVersion: 1,
      domain: lifecycleDomain(index),
      sourceWording: `Question ${index + 1}`,
      rubric: [
        {
          id: parseRubricItemId(`rubric-${index + 1}`),
          description: "Point",
          weight: 100,
        },
      ],
      followUpGoals: [
        {
          id: parseFollowUpGoalId(`clarification-${index + 1}`),
          kind: "clarification" as const,
          goal: "Clarify",
        },
        {
          id: parseFollowUpGoalId(`depth-${index + 1}`),
          kind: "depth" as const,
          goal: "Explore depth",
        },
      ],
      knowledgeExplanation: "Internal",
      active: true,
      sourceActive: true,
      reviewed: true,
      importSourceName: "lifecycle-test",
      importSourceVersion: 1,
      sourceHash: questionBankFixtureSourceHash(`lifecycle-question-${index + 1}`),
    })),
  );
}

async function seedInterview(input: {
  readonly id: string;
  readonly owner: string;
  readonly status?: "active" | "completed";
  readonly lastActivitySql?: string;
}): Promise<void> {
  const status = input.status ?? "active";
  await client.database.transaction(async (transaction) => {
    await transaction.insert(interviewSessions).values({
      id: input.id,
      ownerUserId: input.owner,
      selectedQuestionCount: 5,
      selectionSeed: `${input.id}-seed`,
      status,
      activePhase: status === "active" ? "awaiting_response" : null,
      endedAt: status === "completed" ? NOW : null,
      createdAt: CREATED_AT,
      lastEffectiveActivityAt: NOW,
    });
    await transaction.insert(sessionQuestionSnapshots).values(
      Array.from({ length: 5 }, (_, index) => ({
        id: `${input.id}-snapshot-${index + 1}`,
        interviewId: input.id,
        position: index + 1,
        sourceQuestionId: `lifecycle-question-${index + 1}`,
        sourceQuestionVersion: 1,
        domain: lifecycleDomain(index),
        sourceWording: `Question ${index + 1}`,
        displayWording: `Question ${index + 1}`,
        rubric: [
          {
            id: parseRubricItemId(`rubric-${index + 1}`),
            description: "Point",
            weight: 100,
          },
        ],
        followUpGoals: [
          {
            id: parseFollowUpGoalId(`clarification-${index + 1}`),
            kind: "clarification" as const,
            goal: "Clarify",
          },
          {
            id: parseFollowUpGoalId(`depth-${index + 1}`),
            kind: "depth" as const,
            goal: "Explore depth",
          },
        ],
        knowledgeExplanation: "Internal",
        createdAt: NOW,
      })),
    );
  });
  if (input.lastActivitySql !== undefined) {
    await client.pool.query(
      `update interview_sessions
          set last_effective_activity_at = ${input.lastActivitySql}
        where id = $1`,
      [input.id],
    );
  }
}

async function seedOperation(input: {
  readonly id: string;
  readonly interview: string;
  readonly owner: string;
  readonly processing?: boolean;
}): Promise<void> {
  const payload = validateOperationPayload({ questionPosition: 1, text: "answer" }, "input");
  const processing = input.processing ?? false;
  await client.database.insert(operations).values({
    id: input.id,
    ownerUserId: input.owner,
    interviewId: input.interview,
    idempotencyScope: "submit_answer",
    idempotencyKey: `${input.id}-key`,
    type: "submit_answer",
    status: processing ? "processing" : "pending",
    expectedVersion: 1,
    inputHash: payload.hash,
    input: payload.value,
    attemptCount: processing ? 1 : 0,
    lastAttemptAt: processing ? NOW : null,
    leaseAcquiredAt: processing ? NOW : null,
    leaseExpiresAt: processing ? new Date(NOW.getTime() + 60_000) : null,
    leaseOwner: processing ? "test-worker" : null,
    leaseTokenHash: processing ? "1".repeat(64) : null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  if (processing) {
    await client.pool.query(
      `update interview_sessions
          set active_phase = 'processing',
              version = 2,
              pending_operation_id = $2,
              pending_operation_kind = 'answer_analysis',
              pending_operation_question_position = 1,
              pending_operation_accepted_at = $3,
              pending_operation_previous_phase = 'awaiting_response',
              last_effective_activity_at = $3
        where id = $1`,
      [input.interview, input.id, NOW],
    );
  }
}

async function makeDue(requestId: string): Promise<void> {
  await client.pool.query(
    `update deletion_requests
        set requested_at = statement_timestamp() - interval '8 days',
            purge_due_at = statement_timestamp() - interval '2 days',
            purge_deadline_at = statement_timestamp() - interval '1 day'
      where id = $1`,
    [requestId],
  );
}

function createLifecycle(leaseOwner: string, purgeBatchSize = 10): LifecycleService {
  return new LifecycleService(lifecycleRepository, {
    purgeHashSecret: HASH_SECRET,
    expiryBatchSize: 2,
    purgeBatchSize,
    purgeLeaseOwner: leaseOwner,
    purgeLeaseDurationMs: 60_000,
    failedPurgeRetryDelayMs: 60_000,
    maximumPurgeRequestsPerCycle: 100,
  });
}

describe.sequential("interview expiry and deletion lifecycle", () => {
  beforeAll(async () => {
    harness = await PostgresTestHarness.start();
    testDatabase = await harness.createDatabase({ name: "lifecycle_tests" });
    client = testDatabase.client;
    lifecycleRepository = new PgLifecycleRepository(client.database, undefined, {
      deletionRequestId: () => `deletion-request-${++requestSequence}`,
    });
    lifecycle = createLifecycle("lifecycle-main");
    interviewRepository = new PgInterviewRepository(client.database);
    operationRepository = new PgOperationRepository(client.database);
    unitOfWork = new PgRepositoryUnitOfWork(client.database);
  }, 120_000);

  beforeEach(async () => {
    requestSequence = 0;
    await client.pool.query(
      `truncate table purge_audit_events, verification, "user", question_bank_versions restart identity cascade`,
    );
    await seedQuestionBank();
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it("keeps the exact 24-hour boundary active and lazily expires strictly older activity", async () => {
    const boundary = await client.pool.query<{ exact: boolean; over: boolean }>(
      `select
         (timestamp '2026-08-10 00:00:00+00' - timestamp '2026-08-09 00:00:00+00'
           > interval '24 hours') as exact,
         (timestamp '2026-08-10 00:00:00.000001+00' - timestamp '2026-08-09 00:00:00+00'
           > interval '24 hours') as over`,
    );
    expect(boundary.rows[0]).toEqual({ exact: false, over: true });

    await seedOwner("expiry-owner");
    await seedInterview({
      id: "boundary-interview",
      owner: "expiry-owner",
      lastActivitySql: "statement_timestamp() - interval '24 hours' + interval '2 seconds'",
    });
    expect(
      await lifecycle.expireInterviewBeforeAccess({
        interviewId: interviewId("boundary-interview"),
        accountId: ownerId("expiry-owner"),
        expectedVersion: 1,
      }),
    ).toMatchObject({ kind: "unchanged", status: "active", version: 1 });

    await seedOwner("expired-owner");
    await seedInterview({ id: "expired-interview", owner: "expired-owner" });
    await seedOperation({
      id: "expired-operation",
      interview: "expired-interview",
      owner: "expired-owner",
      processing: true,
    });
    await client.pool.query(
      `update interview_sessions
          set last_effective_activity_at = statement_timestamp() - interval '24 hours 1 second',
              pending_operation_accepted_at = statement_timestamp() - interval '24 hours 1 second'
        where id = 'expired-interview'`,
    );

    await expect(
      interviewRepository.findById(interviewId("expired-interview"), ownerId("expired-owner")),
    ).rejects.toBeInstanceOf(RepositoryInterviewExpiredError);
    const loaded = await interviewRepository.findById(
      interviewId("expired-interview"),
      ownerId("expired-owner"),
    );
    expect(loaded).toMatchObject({
      status: "abandoned",
      phase: null,
      version: 3,
      pendingOperation: null,
      pendingReportKind: null,
      reportRequestedAt: null,
    });
    const cancelled = await client.database
      .select()
      .from(operations)
      .where(eq(operations.id, "expired-operation"));
    expect(cancelled[0]).toMatchObject({
      status: "failed",
      retryable: false,
      error: { code: "interview_expired" },
    });
    expect(
      await client.database
        .select()
        .from(reports)
        .where(eq(reports.interviewId, "expired-interview")),
    ).toHaveLength(0);
  });

  it("lets concurrent expiry sweepers transition every expired interview once", async () => {
    for (let index = 1; index <= 6; index += 1) {
      await seedOwner(`sweeper-owner-${index}`);
      await seedInterview({
        id: `sweeper-interview-${index}`,
        owner: `sweeper-owner-${index}`,
        lastActivitySql: "statement_timestamp() - interval '25 hours'",
      });
    }
    const [first, second] = await Promise.all([
      createLifecycle("expiry-sweeper-a").sweepExpiredInterviews(),
      createLifecycle("expiry-sweeper-b").sweepExpiredInterviews(),
    ]);
    expect(first + second).toBe(6);
    const rows = await client.database
      .select({ status: interviewSessions.status, version: interviewSessions.version })
      .from(interviewSessions);
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.status === "abandoned" && row.version === 2)).toBe(true);
  });

  it("marks interview deletion immediately, cancels Operations, and is idempotent", async () => {
    await seedOwner("interview-delete-owner");
    await seedOwner("interview-delete-stranger");
    await seedInterview({ id: "delete-interview", owner: "interview-delete-owner" });
    await seedOperation({
      id: "delete-operation",
      interview: "delete-interview",
      owner: "interview-delete-owner",
    });
    await expect(
      lifecycle.requestInterviewDeletion(
        interviewId("delete-interview"),
        ownerId("interview-delete-stranger"),
      ),
    ).resolves.toBeNull();
    const first = await lifecycle.requestInterviewDeletion(
      interviewId("delete-interview"),
      ownerId("interview-delete-owner"),
    );
    const second = await lifecycle.requestInterviewDeletion(
      interviewId("delete-interview"),
      ownerId("interview-delete-owner"),
    );
    expect(first).toMatchObject({ created: true, scope: "interview", affectedInterviewCount: 1 });
    expect(second).toMatchObject({
      requestId: first?.requestId,
      created: false,
      scope: "interview",
    });
    expect(second?.purgeDueAt.getTime()).toBe(first?.purgeDueAt.getTime());
    expect(first && first.purgeDueAt.getTime() - first.requestedAt.getTime()).toBe(
      6 * 24 * 60 * 60_000,
    );
    expect(first && first.purgeDeadlineAt.getTime() - first.requestedAt.getTime()).toBe(
      7 * 24 * 60 * 60_000,
    );
    expect(
      await interviewRepository.findById(
        interviewId("delete-interview"),
        ownerId("interview-delete-owner"),
      ),
    ).toBeNull();
    expect(
      await operationRepository.findById(
        parseOperationId("delete-operation"),
        ownerId("interview-delete-owner"),
      ),
    ).toBeNull();
    const operationRows = await client.database
      .select()
      .from(operations)
      .where(eq(operations.id, "delete-operation"));
    expect(operationRows[0]).toMatchObject({
      status: "failed",
      error: { code: "interview_deletion_requested" },
    });
    expect(await client.database.select().from(deletionRequests)).toHaveLength(1);
  });

  it("marks account deletion atomically, revokes sessions, and is idempotent", async () => {
    await seedOwner("account-delete-owner");
    await client.database.insert(account).values({
      id: "auth-account",
      accountId: "external-account",
      providerId: "github",
      userId: "account-delete-owner",
      updatedAt: NOW,
    });
    await client.database.insert(session).values({
      id: "auth-session",
      token: "secret-session-token",
      userId: "account-delete-owner",
      expiresAt: new Date(NOW.getTime() + 60_000),
      updatedAt: NOW,
    });
    await seedInterview({ id: "account-interview-a", owner: "account-delete-owner" });
    await seedInterview({
      id: "account-interview-b",
      owner: "account-delete-owner",
      status: "completed",
    });
    await seedOperation({
      id: "account-delete-operation",
      interview: "account-interview-a",
      owner: "account-delete-owner",
    });

    const first = await lifecycle.requestAccountDeletion(ownerId("account-delete-owner"));
    const second = await lifecycle.requestAccountDeletion(ownerId("account-delete-owner"));
    expect(first).toMatchObject({ created: true, scope: "account", affectedInterviewCount: 2 });
    expect(second).toMatchObject({
      requestId: first?.requestId,
      created: false,
      affectedInterviewCount: 0,
    });
    expect(
      await client.database
        .select()
        .from(session)
        .where(eq(session.userId, "account-delete-owner")),
    ).toHaveLength(0);
    expect(
      await interviewRepository.findById(
        interviewId("account-interview-a"),
        ownerId("account-delete-owner"),
      ),
    ).toBeNull();
    expect(
      await client.database
        .select()
        .from(deletionRequests)
        .where(eq(deletionRequests.scope, "account")),
    ).toHaveLength(1);
  });

  it("serializes session refresh before account deletion without deadlocking", async () => {
    await seedOwner("session-refresh-owner");
    await client.database.insert(session).values({
      id: "refresh-session",
      token: "refresh-session-token",
      userId: "session-refresh-owner",
      expiresAt: new Date(NOW.getTime() + 60_000),
      updatedAt: NOW,
    });

    const blocker = await client.pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query(`select id from "user" where id = 'session-refresh-owner' for update`);

      const deletion = lifecycle.requestAccountDeletion(ownerId("session-refresh-owner"));
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      const refresh = client.pool.query(
        `update session
            set updated_at = statement_timestamp(),
                expires_at = statement_timestamp() + interval '1 hour'
          where id = 'refresh-session'
          returning id`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      await blocker.query("commit");

      const [deletionResult, refreshResult] = await Promise.all([deletion, refresh]);
      expect(deletionResult).toMatchObject({ scope: "account" });
      expect(refreshResult.rowCount).toBe(0);
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      blocker.release();
    }

    expect(
      await client.database
        .select()
        .from(session)
        .where(eq(session.userId, "session-refresh-owner")),
    ).toHaveLength(0);
  });

  it("deletes a session inserted concurrently before the account marker is acquired", async () => {
    await seedOwner("session-insert-first-owner");
    const inserter = await client.pool.connect();
    try {
      await inserter.query("begin");
      await inserter.query(
        `insert into session (id, expires_at, token, updated_at, user_id)
         values (
           'insert-first-session',
           statement_timestamp() + interval '1 hour',
           'insert-first-session-token',
           statement_timestamp(),
           'session-insert-first-owner'
         )`,
      );

      const deletion = lifecycle.requestAccountDeletion(ownerId("session-insert-first-owner"));
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      await inserter.query("commit");

      await expect(deletion).resolves.toMatchObject({ scope: "account" });
    } finally {
      await inserter.query("rollback").catch(() => undefined);
      inserter.release();
    }

    expect(
      await client.database
        .select()
        .from(session)
        .where(eq(session.userId, "session-insert-first-owner")),
    ).toHaveLength(0);
  });

  it("allows normal session refreshes and rejects them after the account marker", async () => {
    await seedOwner("session-trigger-owner");
    await client.database.insert(session).values({
      id: "trigger-session",
      token: "trigger-session-token",
      userId: "session-trigger-owner",
      expiresAt: new Date(NOW.getTime() + 60_000),
      updatedAt: NOW,
    });

    await expect(
      client.pool.query(
        `update session
            set updated_at = statement_timestamp(),
                expires_at = statement_timestamp() + interval '1 hour'
          where id = 'trigger-session'
          returning id`,
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await client.database
      .update(user)
      .set({ deletionRequestedAt: NOW })
      .where(eq(user.id, "session-trigger-owner"));
    await expect(
      client.pool.query(
        `update session
            set updated_at = statement_timestamp()
          where id = 'trigger-session'`,
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "session_user_not_deleting_check",
    });
    await expect(
      client.database.insert(session).values({
        id: "trigger-post-delete-session",
        token: "trigger-post-delete-session-token",
        userId: "session-trigger-owner",
        expiresAt: new Date(NOW.getTime() + 60_000),
        updatedAt: NOW,
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        code: "23514",
        constraint: "session_user_not_deleting_check",
      }),
    });
  });

  it("guards concurrent session issuance after account deletion acquires the marker", async () => {
    await seedOwner("session-guard-owner");
    await client.database.insert(session).values({
      id: "normal-session",
      token: "normal-session-token",
      userId: "session-guard-owner",
      expiresAt: new Date(NOW.getTime() + 60_000),
      updatedAt: NOW,
    });

    let deletionMarked: (() => void) | undefined;
    const marked = new Promise<void>((resolve) => {
      deletionMarked = resolve;
    });
    let releaseDeletion: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    const deletion = unitOfWork.run(async (repositories) => {
      const result = await repositories.lifecycle.markAccountDeleting(
        ownerId("session-guard-owner"),
      );
      deletionMarked?.();
      await release;
      return result;
    });
    await marked;

    const concurrentInsert = client.database.insert(session).values({
      id: "concurrent-session",
      token: "concurrent-session-token",
      userId: "session-guard-owner",
      expiresAt: new Date(NOW.getTime() + 60_000),
      updatedAt: NOW,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseDeletion?.();
    await expect(deletion).resolves.toMatchObject({ scope: "account" });
    await expect(concurrentInsert).rejects.toMatchObject({
      cause: expect.objectContaining({
        code: "23514",
        constraint: "session_user_not_deleting_check",
      }),
    });
    await expect(
      client.database.insert(session).values({
        id: "post-delete-session",
        token: "post-delete-session-token",
        userId: "session-guard-owner",
        expiresAt: new Date(NOW.getTime() + 60_000),
        updatedAt: NOW,
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        code: "23514",
        constraint: "session_user_not_deleting_check",
      }),
    });
    expect(
      await client.database.select().from(session).where(eq(session.userId, "session-guard-owner")),
    ).toHaveLength(0);
  });

  it("allows unrelated and pre-account verification writes but rejects owner writes after deletion", async () => {
    const ownerEmail = "verification-trigger-owner@example.com";
    await seedOwner("verification-trigger-owner");
    await seedOwner("verification-trigger-unrelated");
    await client.database.insert(verification).values([
      {
        id: "pre-account-verification",
        identifier: "sign-in-otp-not-yet-an-account@example.com",
        value: "pre-account-secret",
        expiresAt: new Date(NOW.getTime() + 60_000),
        updatedAt: NOW,
      },
      {
        id: "active-owner-verification",
        identifier: `email-verification-otp-${ownerEmail}`,
        value: "active-owner-secret",
        expiresAt: new Date(NOW.getTime() + 60_000),
        updatedAt: NOW,
      },
      {
        id: "unrelated-verification",
        identifier: `2fa-otp-${ownerEmail}`,
        value: "unrelated-secret",
        expiresAt: new Date(NOW.getTime() + 60_000),
        updatedAt: NOW,
      },
      {
        id: "active-owner-link-state",
        identifier: "random-active-owner-link-state",
        value: JSON.stringify({
          callbackURL: "/settings",
          codeVerifier: "active-owner",
          expiresAt: NOW.getTime() + 60_000,
          link: { email: ownerEmail, userId: "verification-trigger-owner" },
        }),
        expiresAt: new Date(NOW.getTime() + 60_000),
        updatedAt: NOW,
      },
    ]);
    await client.database
      .update(user)
      .set({ deletionRequestedAt: NOW })
      .where(eq(user.id, "verification-trigger-owner"));

    for (const identifier of [
      `sign-in-otp-${ownerEmail}`,
      `forget-password-otp-${ownerEmail}`,
      `change-email-otp-${ownerEmail}-replacement@example.com`,
    ]) {
      await expect(
        client.pool.query(
          `insert into verification (id, identifier, value, expires_at)
           values ($1, $2, 'post-marker-secret', statement_timestamp() + interval '1 hour')`,
          [`post-marker-${identifier}`, identifier],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "verification_user_not_deleting_check",
      });
    }
    await expect(
      client.pool.query(
        `insert into verification (id, identifier, value, expires_at)
         values (
           'post-marker-owner-link-state',
           'random-post-marker-owner-link-state',
           $1,
           statement_timestamp() + interval '1 hour'
         )`,
        [
          JSON.stringify({
            callbackURL: "/settings",
            codeVerifier: "post-marker-owner",
            expiresAt: NOW.getTime() + 60_000,
            link: { email: ownerEmail, userId: "verification-trigger-owner" },
          }),
        ],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "verification_user_not_deleting_check",
    });
    await expect(
      client.pool.query(
        `update verification
            set value = 'updated-secret'
          where id = 'active-owner-verification'`,
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "verification_user_not_deleting_check",
    });
    await expect(
      client.pool.query(
        `insert into verification (id, identifier, value, expires_at)
         values
           (
             'post-marker-unrelated',
             '2fa-otp-verification-trigger-owner@example.com',
             'unrelated-secret',
             statement_timestamp() + interval '1 hour'
           ),
           (
             'post-marker-unrelated-link',
             'random-post-marker-unrelated-link',
             $1,
             statement_timestamp() + interval '1 hour'
           ),
           (
             'post-marker-non-link-state',
             'random-post-marker-non-link-state',
             '{"callbackURL":"/sign-in","codeVerifier":"non-link","expiresAt":1}',
             statement_timestamp() + interval '1 hour'
           ),
           (
             'post-marker-invalid-json',
             'random-post-marker-invalid-json',
             'not-json',
             statement_timestamp() + interval '1 hour'
           ),
           (
             'post-marker-overflow-json',
             'random-post-marker-overflow-json',
             $2,
             statement_timestamp() + interval '1 hour'
           ),
           (
             'post-marker-unsupported-unicode-json',
             'random-post-marker-unsupported-unicode-json',
             $3,
             statement_timestamp() + interval '1 hour'
           )`,
        [
          JSON.stringify({
            callbackURL: "/settings",
            codeVerifier: "unrelated-link",
            expiresAt: NOW.getTime() + 60_000,
            link: {
              email: "verification-trigger-unrelated@example.com",
              userId: "verification-trigger-unrelated",
            },
          }),
          numericOverflowJson,
          unsupportedUnicodeEscapeJson,
        ],
      ),
    ).resolves.toMatchObject({ rowCount: 6 });
  });

  it("serializes an uncommitted GitHub link-state insert with account purge", async () => {
    const owner = "verification-purge-owner";
    const ownerEmail = `${owner}@example.com`;
    await seedOwner(owner);
    const marked = await lifecycle.requestAccountDeletion(ownerId(owner));
    await makeDue(marked?.requestId ?? "");
    await client.database.update(user).set({ deletionRequestedAt: null }).where(eq(user.id, owner));

    const writer = await client.pool.connect();
    let writerCommitted = false;
    try {
      await writer.query("begin");
      await writer.query(
        `insert into verification (id, identifier, value, expires_at)
         values (
           'concurrent-verification',
           'random-concurrent-github-link-state',
           $1,
           statement_timestamp() + interval '1 hour'
         )`,
        [
          JSON.stringify({
            callbackURL: "/settings",
            codeVerifier: "concurrent-link",
            expiresAt: NOW.getTime() + 60_000,
            link: { email: ownerEmail, userId: owner },
          }),
        ],
      );

      const purge = lifecycle.sweepDuePurges();
      await vi.waitFor(
        async () => {
          const rows = await client.database
            .select({ status: deletionRequests.status })
            .from(deletionRequests)
            .where(eq(deletionRequests.id, marked?.requestId ?? ""));
          expect(rows[0]?.status).toBe("processing");
        },
        { interval: 20, timeout: 5_000 },
      );

      await writer.query("commit");
      writerCommitted = true;
      await expect(purge).resolves.toEqual({
        claimed: 1,
        succeeded: 1,
        failed: 0,
      });
    } finally {
      if (!writerCommitted) {
        await writer.query("rollback");
      }
      writer.release();
    }

    expect(await client.database.select().from(verification)).toHaveLength(0);
    expect(await client.database.select().from(user)).toHaveLength(0);
    const audit = await client.database.select().from(purgeAuditEvents);
    expect(audit).toHaveLength(7);
    expect(audit.every((row) => row.result === "succeeded")).toBe(true);
    await expect(
      client.pool.query(
        `insert into verification (id, identifier, value, expires_at)
         values (
           'post-purge-github-link-state',
           'random-post-purge-github-link-state',
           $1,
           statement_timestamp() + interval '1 hour'
         )`,
        [
          JSON.stringify({
            callbackURL: "/settings",
            codeVerifier: "post-purge-link",
            expiresAt: NOW.getTime() + 60_000,
            link: { email: ownerEmail, userId: owner },
          }),
        ],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "verification_user_not_deleting_check",
    });
  });

  it("claims at the six-day eligibility time while the hard deadline is not overdue", async () => {
    await seedOwner("not-due-owner");
    await seedInterview({ id: "not-due-interview", owner: "not-due-owner" });
    const marked = await lifecycle.requestInterviewDeletion(
      interviewId("not-due-interview"),
      ownerId("not-due-owner"),
    );
    await client.pool.query(
      `update deletion_requests
          set requested_at = statement_timestamp() - interval '6 days 1 minute',
              purge_due_at = statement_timestamp() - interval '1 minute',
              purge_deadline_at = statement_timestamp() + interval '23 hours 59 minutes'
        where id = $1`,
      [marked?.requestId],
    );
    await expect(lifecycle.getDeletionOverdueProjection()).resolves.toMatchObject({
      overdueCount: 0,
      oldestPurgeDeadlineAt: null,
    });
    await expect(lifecycle.sweepDuePurges()).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      failed: 0,
    });
  });

  it("does not claim a purge before its database eligibility time", async () => {
    await seedOwner("not-due-owner");
    await seedInterview({ id: "not-due-interview", owner: "not-due-owner" });
    await lifecycle.requestInterviewDeletion(
      interviewId("not-due-interview"),
      ownerId("not-due-owner"),
    );
    await expect(lifecycle.sweepDuePurges()).resolves.toEqual({
      claimed: 0,
      succeeded: 0,
      failed: 0,
    });
    expect(await client.database.select().from(interviewSessions)).toHaveLength(1);
  });

  it("counts overdue requests only after the hard seven-day deadline", async () => {
    await seedOwner("deadline-boundary-owner");
    await seedInterview({
      id: "deadline-boundary-interview",
      owner: "deadline-boundary-owner",
    });
    const marked = await lifecycle.requestInterviewDeletion(
      interviewId("deadline-boundary-interview"),
      ownerId("deadline-boundary-owner"),
    );
    await client.pool.query(
      `update deletion_requests
          set requested_at = statement_timestamp() - interval '7 days' + interval '1 minute',
              purge_due_at = statement_timestamp() - interval '23 hours 59 minutes',
              purge_deadline_at = statement_timestamp() + interval '1 minute'
        where id = $1`,
      [marked?.requestId],
    );
    await expect(lifecycle.getDeletionOverdueProjection()).resolves.toMatchObject({
      overdueCount: 0,
      oldestPurgeDeadlineAt: null,
    });

    await client.pool.query(
      `update deletion_requests
          set requested_at = statement_timestamp() - interval '7 days 1 second',
              purge_due_at = statement_timestamp() - interval '1 day 1 second',
              purge_deadline_at = statement_timestamp() - interval '1 second'
        where id = $1`,
      [marked?.requestId],
    );
    const overdue = await lifecycle.getDeletionOverdueProjection();
    expect(overdue.overdueCount).toBe(1);
    expect(overdue.oldestPurgeDeadlineAt).toBeInstanceOf(Date);
    expect(overdue.maximumOverdueSeconds).toBeGreaterThan(0);
  });

  it("rejects retry delays below one minute", () => {
    expect(
      () =>
        new LifecycleService(lifecycleRepository, {
          purgeHashSecret: HASH_SECRET,
          failedPurgeRetryDelayMs: 59_999,
        }),
    ).toThrow(
      "Failed purge retry delay must be an integer from 60000 through 86400000 milliseconds",
    );
  });

  it("rejects disabled, fractional, and excessive maintenance bounds", () => {
    const invalidOptions = [
      {
        option: { expiryBatchSize: 0 },
        message: "Expiry batch size must be an integer from 1 through 1000",
      },
      {
        option: { expiryBatchSize: 1.5 },
        message: "Expiry batch size must be an integer from 1 through 1000",
      },
      {
        option: { expiryBatchSize: 1_001 },
        message: "Expiry batch size must be an integer from 1 through 1000",
      },
      {
        option: { maximumExpiryBatchesPerCycle: 100_001 },
        message: "Maximum expiry batches per cycle must be an integer from 1 through 100000",
      },
      {
        option: { purgeBatchSize: 0 },
        message: "Purge batch size must be an integer from 1 through 1000",
      },
      {
        option: { purgeBatchSize: -1 },
        message: "Purge batch size must be an integer from 1 through 1000",
      },
      {
        option: { purgeBatchSize: 1_001 },
        message: "Purge batch size must be an integer from 1 through 1000",
      },
      {
        option: { maximumPurgeRequestsPerCycle: 0 },
        message: "Maximum purge requests per cycle must be an integer from 1 through 100000",
      },
    ] as const;

    for (const invalid of invalidOptions) {
      expect(
        () =>
          new LifecycleService(lifecycleRepository, {
            purgeHashSecret: HASH_SECRET,
            ...invalid.option,
          }),
      ).toThrow(invalid.message);
    }
  });

  it("accepts the maximum timer interval and rejects one millisecond more", () => {
    const handle = lifecycle.startPeriodicMaintenance({
      intervalMs: MAXIMUM_MAINTENANCE_INTERVAL_MS,
      runImmediately: false,
    });
    handle.stop();

    expect(() =>
      lifecycle.startPeriodicMaintenance({
        intervalMs: MAXIMUM_MAINTENANCE_INTERVAL_MS + 1,
        runImmediately: false,
      }),
    ).toThrow(
      `Maintenance interval must be an integer from 60000 through ${MAXIMUM_MAINTENANCE_INTERVAL_MS} milliseconds`,
    );
  });

  it("bounds expiry iterations while allowing the minimum batch size", async () => {
    for (const suffix of ["a", "b"]) {
      await seedOwner(`bounded-expiry-owner-${suffix}`);
      await seedInterview({
        id: `bounded-expiry-interview-${suffix}`,
        owner: `bounded-expiry-owner-${suffix}`,
        lastActivitySql: "statement_timestamp() - interval '25 hours'",
      });
    }
    const bounded = new LifecycleService(lifecycleRepository, {
      purgeHashSecret: HASH_SECRET,
      expiryBatchSize: 1,
      maximumExpiryBatchesPerCycle: 1,
    });

    await expect(bounded.sweepExpiredInterviews()).resolves.toBe(1);
    const rows = await client.database
      .select({ status: interviewSessions.status })
      .from(interviewSessions);
    expect(rows.filter((row) => row.status === "abandoned")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "active")).toHaveLength(1);
  });

  it("rejects purge leases shorter than the operational minimum", () => {
    expect(
      () =>
        new LifecycleService(lifecycleRepository, {
          purgeHashSecret: HASH_SECRET,
          purgeLeaseDurationMs: 29_999,
        }),
    ).toThrow("Purge lease duration must be an integer from 30000 through 86400000 milliseconds");
  });

  it("uses the normal purge lease hours before the deadline and caps longer leases", async () => {
    for (const suffix of ["normal", "capped"]) {
      await seedOwner(`lease-hours-owner-${suffix}`);
      await seedInterview({
        id: `lease-hours-interview-${suffix}`,
        owner: `lease-hours-owner-${suffix}`,
      });
      await lifecycle.requestInterviewDeletion(
        interviewId(`lease-hours-interview-${suffix}`),
        ownerId(`lease-hours-owner-${suffix}`),
      );
    }
    const requests = await client.database.select().from(deletionRequests);
    const normal = requests.find((request) => request.ownerUserId === "lease-hours-owner-normal");
    const capped = requests.find((request) => request.ownerUserId === "lease-hours-owner-capped");
    if (normal === undefined || capped === undefined) {
      throw new Error("Expected purge lease requests");
    }
    await client.pool.query(
      `update deletion_requests
          set requested_at = case
                when id = $1 then statement_timestamp() - interval '6 days 20 hours'
                else statement_timestamp() - interval '6 days 22 hours'
              end,
              purge_due_at = statement_timestamp() - interval '1 minute',
              purge_deadline_at = case
                when id = $1 then statement_timestamp() + interval '4 hours'
                else statement_timestamp() + interval '2 hours'
              end
        where id in ($1, $2)`,
      [normal.id, capped.id],
    );

    await lifecycleRepository.claimDueDeletionRequests({
      batchSize: 1,
      leaseOwner: "normal-hours-lease",
      leaseDurationMs: 60_000,
      failedRetryDelayMs: 60_000,
      excludedRequestIds: [capped.id],
    });
    await lifecycleRepository.claimDueDeletionRequests({
      batchSize: 1,
      leaseOwner: "capped-hours-lease",
      leaseDurationMs: 3 * 60 * 60_000,
      failedRetryDelayMs: 60_000,
      excludedRequestIds: [normal.id],
    });

    const leaseDurations = await client.pool.query<{
      id: string;
      lease_ms: number;
      deadline_margin_ms: number;
    }>(
      `select id,
              (extract(epoch from (lease_expires_at - processing_started_at)) * 1000)
                ::double precision as lease_ms,
              (extract(epoch from (purge_deadline_at - lease_expires_at)) * 1000)
                ::double precision as deadline_margin_ms
         from deletion_requests
        where id in ($1, $2)
        order by id`,
      [normal.id, capped.id],
    );
    const normalLease = leaseDurations.rows.find((row) => row.id === normal.id);
    const cappedLease = leaseDurations.rows.find((row) => row.id === capped.id);
    expect(normalLease?.lease_ms).toBe(60_000);
    expect(normalLease?.deadline_margin_ms).toBeGreaterThan(30_000);
    expect(cappedLease?.lease_ms).toBeGreaterThan(0);
    expect(cappedLease?.deadline_margin_ms).toBe(30_000);
  });

  it("uses a short positive lease inside the safety window without passing the deadline", async () => {
    await seedOwner("short-lease-owner");
    await seedInterview({ id: "short-lease-interview", owner: "short-lease-owner" });
    const marked = await lifecycle.requestInterviewDeletion(
      interviewId("short-lease-interview"),
      ownerId("short-lease-owner"),
    );
    await client.pool.query(
      `update deletion_requests
          set requested_at = statement_timestamp() - interval '6 days 23 hours 59 minutes 50 seconds',
              purge_due_at = statement_timestamp() - interval '1 minute',
              purge_deadline_at = statement_timestamp() + interval '10 seconds'
        where id = $1`,
      [marked?.requestId],
    );

    await lifecycleRepository.claimDueDeletionRequests({
      batchSize: 1,
      leaseOwner: "short-deadline-lease",
      leaseDurationMs: 60_000,
      failedRetryDelayMs: 60_000,
    });
    const lease = await client.pool.query<{
      lease_ms: number;
      expires_before_deadline: boolean;
    }>(
      `select (extract(epoch from (lease_expires_at - processing_started_at)) * 1000)
                ::double precision as lease_ms,
              lease_expires_at < purge_deadline_at as expires_before_deadline
         from deletion_requests
        where id = $1`,
      [marked?.requestId],
    );
    expect(lease.rows[0]).toEqual({
      lease_ms: 3_000,
      expires_before_deadline: true,
    });
  });

  it("reclaims a crashed short lease before the deadline and fences the stale worker", async () => {
    await seedOwner("crashed-lease-owner");
    await seedInterview({ id: "crashed-lease-interview", owner: "crashed-lease-owner" });
    const marked = await lifecycle.requestInterviewDeletion(
      interviewId("crashed-lease-interview"),
      ownerId("crashed-lease-owner"),
    );
    await client.pool.query(
      `update deletion_requests
          set requested_at = statement_timestamp() - interval '6 days 23 hours 59 minutes 48 seconds',
              purge_due_at = statement_timestamp() - interval '1 minute',
              purge_deadline_at = statement_timestamp() + interval '12 seconds'
        where id = $1`,
      [marked?.requestId],
    );
    const staleClaim = (
      await lifecycleRepository.claimDueDeletionRequests({
        batchSize: 1,
        leaseOwner: "crashed-worker",
        leaseDurationMs: 60_000,
        failedRetryDelayMs: 60_000,
      })
    )[0];
    if (staleClaim === undefined) {
      throw new Error("Expected initial purge claim");
    }

    await client.pool.query("select pg_sleep(3.1)");
    const replacementClaim = (
      await lifecycleRepository.claimDueDeletionRequests({
        batchSize: 1,
        leaseOwner: "replacement-worker",
        leaseDurationMs: 60_000,
        failedRetryDelayMs: 60_000,
      })
    )[0];
    if (replacementClaim === undefined) {
      throw new Error("Expected replacement purge claim");
    }
    const timing = await client.pool.query<{ before_deadline: boolean }>(
      `select statement_timestamp() < purge_deadline_at as before_deadline
         from deletion_requests
        where id = $1`,
      [marked?.requestId],
    );
    expect(timing.rows[0]?.before_deadline).toBe(true);
    await expect(
      lifecycleRepository.purgeClaimedDeletionRequest(staleClaim, "a".repeat(64)),
    ).resolves.toBe(false);
    await expect(
      lifecycleRepository.purgeClaimedDeletionRequest(replacementClaim, "b".repeat(64)),
    ).resolves.toBe(true);
  }, 10_000);

  it("uses the short DB-time fencing lease for overdue claims", async () => {
    await seedOwner("overdue-lease-owner");
    await seedInterview({ id: "overdue-lease-interview", owner: "overdue-lease-owner" });
    const marked = await lifecycle.requestInterviewDeletion(
      interviewId("overdue-lease-interview"),
      ownerId("overdue-lease-owner"),
    );
    await makeDue(marked?.requestId ?? "");

    await lifecycleRepository.claimDueDeletionRequests({
      batchSize: 1,
      leaseOwner: "overdue-short-lease",
      leaseDurationMs: 60_000,
      failedRetryDelayMs: 60_000,
    });
    const lease = await client.pool.query<{ lease_ms: number; still_positive: boolean }>(
      `select (extract(epoch from (lease_expires_at - processing_started_at)) * 1000)
                ::double precision as lease_ms,
              lease_expires_at > statement_timestamp() as still_positive
         from deletion_requests
        where id = $1`,
      [marked?.requestId],
    );
    expect(lease.rows[0]).toEqual({ lease_ms: 3_000, still_positive: true });
  });

  it("retries at the earlier of normal backoff and the pre-deadline safety point", async () => {
    for (const suffix of ["near", "overdue"]) {
      await seedOwner(`deadline-retry-owner-${suffix}`);
      await seedInterview({
        id: `deadline-retry-interview-${suffix}`,
        owner: `deadline-retry-owner-${suffix}`,
      });
      await lifecycle.requestInterviewDeletion(
        interviewId(`deadline-retry-interview-${suffix}`),
        ownerId(`deadline-retry-owner-${suffix}`),
      );
    }
    const requests = await client.database.select().from(deletionRequests);
    const near = requests.find((request) => request.ownerUserId === "deadline-retry-owner-near");
    const overdue = requests.find(
      (request) => request.ownerUserId === "deadline-retry-owner-overdue",
    );
    if (near === undefined || overdue === undefined) {
      throw new Error("Expected deadline retry requests");
    }
    await client.pool.query(
      `update deletion_requests
          set status = 'failed',
              attempt_count = 1,
              last_attempt_at = statement_timestamp(),
              last_error_category = 'database',
              last_error_code = 'previous_failure',
              requested_at = case
                when id = $1 then statement_timestamp() - interval '7 days' + interval '2 minutes'
                else statement_timestamp() - interval '7 days 1 second'
              end,
              purge_due_at = statement_timestamp() - interval '1 day',
              purge_deadline_at = case
                when id = $1 then statement_timestamp() + interval '2 minutes'
                else statement_timestamp() - interval '1 second'
              end
        where id in ($1, $2)`,
      [near.id, overdue.id],
    );

    const firstClaims = await lifecycleRepository.claimDueDeletionRequests({
      batchSize: 10,
      leaseOwner: "deadline-boundary",
      leaseDurationMs: 60_000,
      failedRetryDelayMs: 10 * 60_000,
    });
    expect(firstClaims.map((claim) => claim.requestId)).toEqual([overdue.id]);

    await client.pool.query(
      `update deletion_requests
          set requested_at = statement_timestamp() - interval '7 days' + interval '30 seconds',
              purge_deadline_at = statement_timestamp() + interval '30 seconds'
        where id = $1`,
      [near.id],
    );
    const safetyClaims = await lifecycleRepository.claimDueDeletionRequests({
      batchSize: 10,
      leaseOwner: "deadline-boundary",
      leaseDurationMs: 60_000,
      failedRetryDelayMs: 10 * 60_000,
      excludedRequestIds: [overdue.id],
    });
    expect(safetyClaims.map((claim) => claim.requestId)).toEqual([near.id]);
  });

  it("purges due business and authentication content and retains only minimized HMAC audit rows", async () => {
    await seedOwner("purge-account-owner");
    await seedOwner("unrelated-auth-owner");
    await client.database.insert(account).values({
      id: "purge-auth-account",
      accountId: "oauth-identifier",
      providerId: "github",
      userId: "purge-account-owner",
      accessToken: "oauth-access-token",
      refreshToken: "oauth-refresh-token",
      updatedAt: NOW,
    });
    await client.database.insert(account).values({
      id: "unrelated-auth-account",
      accountId: "unrelated-oauth-identifier",
      providerId: "github",
      userId: "unrelated-auth-owner",
      updatedAt: NOW,
    });
    await client.database.insert(session).values({
      id: "purge-session",
      token: "purge-session-token",
      userId: "purge-account-owner",
      expiresAt: new Date(NOW.getTime() + 60_000),
      updatedAt: NOW,
    });
    await client.database.insert(session).values({
      id: "unrelated-session",
      token: "unrelated-session-token",
      userId: "unrelated-auth-owner",
      expiresAt: new Date(NOW.getTime() + 60_000),
      updatedAt: NOW,
    });
    const ownerEmail = "purge-account-owner@example.com";
    const unrelatedVerificationIdentifiers = [
      ownerEmail,
      "sign-in-otp-other-owner@example.com",
      `change-email-otp-old-owner@example.com-${ownerEmail}`,
      `change-email-otp-old@example.com-x-${ownerEmail}`,
      "2fa-otp-unrelated-key",
    ];
    const preservedOAuthStateIdentifiers = [
      "random-unrelated-github-link-state",
      "random-non-link-oauth-state",
      "random-invalid-json-value",
      "random-overflow-json-value",
      "random-unsupported-unicode-json-value",
    ];
    await client.database.insert(verification).values(
      [
        `email-verification-otp-${ownerEmail}`,
        `sign-in-otp-${ownerEmail}`,
        `forget-password-otp-${ownerEmail}`,
        `change-email-otp-${ownerEmail}-new-owner@example.com`,
        ...unrelatedVerificationIdentifiers,
      ].map((identifier, index) => ({
        id: `purge-verification-${index + 1}`,
        identifier,
        value: `otp-secret-${index + 1}`,
        expiresAt: new Date(NOW.getTime() + 60_000),
        updatedAt: NOW,
      })),
    );
    await client.database.insert(verification).values([
      {
        id: "purge-owned-github-link-state",
        identifier: "random-owned-github-link-state",
        value: JSON.stringify({
          callbackURL: "/settings",
          codeVerifier: "owned-link",
          expiresAt: NOW.getTime() + 60_000,
          link: { email: ownerEmail, userId: "purge-account-owner" },
        }),
        expiresAt: new Date(NOW.getTime() + 60_000),
        updatedAt: NOW,
      },
      {
        id: "purge-unrelated-github-link-state",
        identifier: "random-unrelated-github-link-state",
        value: JSON.stringify({
          callbackURL: "/settings",
          codeVerifier: "unrelated-link",
          expiresAt: NOW.getTime() + 60_000,
          link: {
            email: "unrelated-auth-owner@example.com",
            userId: "unrelated-auth-owner",
          },
        }),
        expiresAt: new Date(NOW.getTime() + 60_000),
        updatedAt: NOW,
      },
      {
        id: "purge-non-link-oauth-state",
        identifier: "random-non-link-oauth-state",
        value: JSON.stringify({
          callbackURL: "/sign-in",
          codeVerifier: "non-link",
          expiresAt: NOW.getTime() + 60_000,
        }),
        expiresAt: new Date(NOW.getTime() + 60_000),
        updatedAt: NOW,
      },
      {
        id: "purge-invalid-json-value",
        identifier: "random-invalid-json-value",
        value: "not-json",
        expiresAt: new Date(NOW.getTime() + 60_000),
        updatedAt: NOW,
      },
      {
        id: "purge-overflow-json-value",
        identifier: "random-overflow-json-value",
        value: numericOverflowJson,
        expiresAt: new Date(NOW.getTime() + 60_000),
        updatedAt: NOW,
      },
      {
        id: "purge-unsupported-unicode-json-value",
        identifier: "random-unsupported-unicode-json-value",
        value: unsupportedUnicodeEscapeJson,
        expiresAt: new Date(NOW.getTime() + 60_000),
        updatedAt: NOW,
      },
    ]);
    await seedInterview({ id: "purge-account-interview", owner: "purge-account-owner" });
    await seedOperation({
      id: "purge-account-operation",
      interview: "purge-account-interview",
      owner: "purge-account-owner",
    });
    await client.database.insert(interviewMessages).values({
      id: "purge-message",
      interviewId: "purge-account-interview",
      sequence: 1,
      questionSnapshotId: "purge-account-interview-snapshot-1",
      questionPosition: 1,
      role: "user",
      kind: "main_answer",
      answerMaterialKind: "main_answer",
      content: "sensitive answer",
      createdAt: NOW,
    });
    await client.database.insert(questionEvaluations).values({
      id: "purge-evaluation",
      questionSnapshotId: "purge-account-interview-snapshot-1",
      classification: "relevant",
      rubricResults: [],
      outcomeKind: "incorrect",
      score: 0,
      zeroScoreReason: "incorrect",
      modelMetadata: {
        provider: "faux",
        modelId: "faux",
        promptVersion: "1",
        schemaVersion: "1",
        questionVersion: 1,
        purpose: "test",
        latencyMs: 1,
        inputTokens: null,
        outputTokens: null,
      },
      createdAt: NOW,
    });
    const marked = await lifecycle.requestAccountDeletion(ownerId("purge-account-owner"));
    await makeDue(marked?.requestId ?? "");

    await expect(lifecycle.sweepDuePurges()).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      failed: 0,
    });
    for (const table of [
      interviewSessions,
      interviewMessages,
      operations,
      questionEvaluations,
      deletionRequests,
    ] as const) {
      expect(await client.database.select().from(table)).toHaveLength(0);
    }
    expect(await client.database.select({ id: user.id }).from(user)).toEqual([
      { id: "unrelated-auth-owner" },
    ]);
    expect(await client.database.select({ id: account.id }).from(account)).toEqual([
      { id: "unrelated-auth-account" },
    ]);
    expect(await client.database.select({ id: session.id }).from(session)).toEqual([
      { id: "unrelated-session" },
    ]);
    expect(
      (
        await client.database
          .select({ identifier: verification.identifier })
          .from(verification)
          .orderBy(verification.identifier)
      ).map((row) => row.identifier),
    ).toEqual([...unrelatedVerificationIdentifiers, ...preservedOAuthStateIdentifiers].sort());
    const audit = await client.database.select().from(purgeAuditEvents);
    const expectedHash = createPurgeSubjectIdentifierHash(
      HASH_SECRET,
      "account",
      "purge-account-owner",
    );
    expect(audit).toHaveLength(7);
    expect(
      audit.every(
        (row) =>
          row.subjectIdentifierHash === expectedHash &&
          row.result === "succeeded" &&
          /^[0-9a-f]{64}$/.test(row.subjectIdentifierHash),
      ),
    ).toBe(true);
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("purge-account-owner");
    expect(serialized).not.toContain("example.com");
    expect(serialized).not.toContain("sensitive answer");
    expect(serialized).not.toContain("token");
  });

  it("attempts a persistent purge failure once per cycle and retries after the delay", async () => {
    await seedOwner("retry-purge-owner");
    await seedInterview({ id: "retry-purge-interview", owner: "retry-purge-owner" });
    const marked = await lifecycle.requestInterviewDeletion(
      interviewId("retry-purge-interview"),
      ownerId("retry-purge-owner"),
    );
    await makeDue(marked?.requestId ?? "");
    await client.pool.query(
      `update deletion_requests
          set requested_at = statement_timestamp() - interval '6 days',
              purge_due_at = statement_timestamp() - interval '1 minute',
              purge_deadline_at = statement_timestamp() + interval '1 day'
        where id = $1`,
      [marked?.requestId],
    );
    await client.pool.query(
      `create table lifecycle_purge_blocker (
         interview_id text primary key references interview_sessions(id) on delete restrict
       )`,
    );
    await client.pool.query(
      `insert into lifecycle_purge_blocker (interview_id) values ('retry-purge-interview')`,
    );

    const retryLifecycle = createLifecycle("purge-retry", 1);
    await expect(retryLifecycle.sweepDuePurges()).resolves.toEqual({
      claimed: 1,
      succeeded: 0,
      failed: 1,
    });
    const failedRequests = await client.database.select().from(deletionRequests);
    expect(failedRequests[0]).toMatchObject({
      status: "failed",
      attemptCount: 1,
      lastErrorCategory: "constraint",
      lastErrorCode: "postgres_23001",
    });
    expect(await client.database.select().from(purgeAuditEvents)).toHaveLength(0);
    expect(await client.database.select().from(interviewSessions)).toHaveLength(1);
    await expect(retryLifecycle.sweepDuePurges()).resolves.toEqual({
      claimed: 0,
      succeeded: 0,
      failed: 0,
    });
    expect((await client.database.select().from(deletionRequests))[0]?.attemptCount).toBe(1);

    await client.pool.query("drop table lifecycle_purge_blocker");
    await client.pool.query(
      `update deletion_requests
          set last_attempt_at = statement_timestamp() - interval '2 minutes'
        where id = $1`,
      [marked?.requestId],
    );
    await expect(retryLifecycle.sweepDuePurges()).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(await client.database.select().from(interviewSessions)).toHaveLength(0);
    expect(await client.database.select().from(deletionRequests)).toHaveLength(0);
    expect(await client.database.select().from(purgeAuditEvents)).toHaveLength(5);
  });

  it("prioritizes never-attempted due purges across bounded maintenance cycles", async () => {
    await seedOwner("fairness-failure-owner");
    await seedOwner("fairness-healthy-owner");
    await seedInterview({
      id: "fairness-failure-interview",
      owner: "fairness-failure-owner",
    });

    await seedInterview({
      id: "fairness-healthy-interview",
      owner: "fairness-healthy-owner",
    });
    const failure = await lifecycle.requestInterviewDeletion(
      interviewId("fairness-failure-interview"),
      ownerId("fairness-failure-owner"),
    );
    const healthy = await lifecycle.requestInterviewDeletion(
      interviewId("fairness-healthy-interview"),
      ownerId("fairness-healthy-owner"),
    );
    await client.pool.query(
      `update deletion_requests
          set requested_at = case
                when id = $1 then statement_timestamp() - interval '9 days'
                else statement_timestamp() - interval '8 days'
              end,
              purge_due_at = case
                when id = $1 then statement_timestamp() - interval '3 days'
                else statement_timestamp() - interval '2 days'
              end,
              purge_deadline_at = case
                when id = $1 then statement_timestamp() - interval '2 days'
                else statement_timestamp() - interval '1 day'
              end
        where id in ($1, $2)`,
      [failure?.requestId, healthy?.requestId],
    );
    await client.pool.query(
      `create table lifecycle_fairness_blocker (
         interview_id text primary key references interview_sessions(id) on delete restrict
       )`,
    );
    await client.pool.query(
      `insert into lifecycle_fairness_blocker (interview_id)
       values ('fairness-failure-interview')`,
    );

    const fairLifecycle = createLifecycle("purge-fairness", 1);
    try {
      await expect(fairLifecycle.sweepDuePurges()).resolves.toEqual({
        claimed: 1,
        succeeded: 0,
        failed: 1,
      });
      await expect(fairLifecycle.sweepDuePurges()).resolves.toEqual({
        claimed: 1,
        succeeded: 1,
        failed: 0,
      });
      expect(
        await client.database
          .select({ id: interviewSessions.id })
          .from(interviewSessions)
          .orderBy(interviewSessions.id),
      ).toEqual([{ id: "fairness-failure-interview" }]);
      await expect(fairLifecycle.sweepDuePurges()).resolves.toEqual({
        claimed: 1,
        succeeded: 0,
        failed: 1,
      });
      const failedRequest = (
        await client.database
          .select()
          .from(deletionRequests)
          .where(eq(deletionRequests.id, failure?.requestId ?? ""))
      )[0];
      expect(failedRequest?.attemptCount).toBe(2);
    } finally {
      await client.pool.query("drop table lifecycle_fairness_blocker");
    }
  });

  it("prioritizes overdue failed purges ahead of newer pre-deadline work", async () => {
    for (const suffix of ["overdue", "newer"]) {
      await seedOwner(`deadline-priority-owner-${suffix}`);
      await seedInterview({
        id: `deadline-priority-interview-${suffix}`,
        owner: `deadline-priority-owner-${suffix}`,
      });
      await lifecycle.requestInterviewDeletion(
        interviewId(`deadline-priority-interview-${suffix}`),
        ownerId(`deadline-priority-owner-${suffix}`),
      );
    }
    const requests = await client.database
      .select()
      .from(deletionRequests)
      .orderBy(deletionRequests.ownerUserId);
    const newer = requests.find((request) => request.ownerUserId.endsWith("-newer"));
    const overdue = requests.find((request) => request.ownerUserId.endsWith("-overdue"));
    if (newer === undefined || overdue === undefined) {
      throw new Error("Expected deadline-priority deletion requests");
    }
    await client.pool.query(
      `update deletion_requests
          set status = case when id = $1 then 'failed'::deletion_status else 'pending'::deletion_status end,
              last_attempt_at = case when id = $1 then statement_timestamp() else null end,
              last_error_category = case when id = $1 then 'database' else null end,
              last_error_code = case when id = $1 then 'transient_failure' else null end,
              requested_at = case
                when id = $1 then statement_timestamp() - interval '7 days 1 second'
                else statement_timestamp() - interval '6 days'
              end,
              inaccessible_at = case
                when id = $1 then statement_timestamp() - interval '7 days 1 second'
                else statement_timestamp() - interval '6 days'
              end,
              purge_due_at = statement_timestamp() - interval '1 minute',
              purge_deadline_at = case
                when id = $1 then statement_timestamp() - interval '1 second'
                else statement_timestamp() + interval '1 day'
              end
        where id in ($1, $2)`,
      [overdue.id, newer.id],
    );

    const claims = await lifecycleRepository.claimDueDeletionRequests({
      batchSize: 1,
      leaseOwner: "deadline-priority",
      leaseDurationMs: 60_000,
      failedRetryDelayMs: 60_000,
    });

    expect(claims.map((claim) => claim.requestId)).toEqual([overdue.id]);
  });

  it("persists lease-loss failure and does not reclaim the request in the same cycle", async () => {
    await seedOwner("lease-loss-owner");
    await seedInterview({ id: "lease-loss-interview", owner: "lease-loss-owner" });
    const marked = await lifecycle.requestInterviewDeletion(
      interviewId("lease-loss-interview"),
      ownerId("lease-loss-owner"),
    );
    await makeDue(marked?.requestId ?? "");
    const purge = vi
      .spyOn(lifecycleRepository, "purgeClaimedDeletionRequest")
      .mockResolvedValueOnce(false);
    const leaseLossLifecycle = new LifecycleService(lifecycleRepository, {
      purgeHashSecret: HASH_SECRET,
      purgeBatchSize: 1,
      purgeLeaseOwner: "lease-loss",
      purgeLeaseDurationMs: 60_000,
      failedPurgeRetryDelayMs: 10 * 60_000,
      maximumPurgeRequestsPerCycle: 10,
    });

    await expect(leaseLossLifecycle.sweepDuePurges()).resolves.toEqual({
      claimed: 1,
      succeeded: 0,
      failed: 1,
    });
    purge.mockRestore();
    const request = (await client.database.select().from(deletionRequests))[0];
    expect(request).toMatchObject({
      status: "failed",
      attemptCount: 1,
      lastErrorCategory: "database",
      lastErrorCode: "purge_lease_lost",
    });
    expect(request?.lastAttemptAt).toBeInstanceOf(Date);
  });

  it("claims due purges safely across concurrent sweepers and projects overdue work", async () => {
    for (const suffix of ["a", "b"]) {
      await seedOwner(`concurrent-purge-owner-${suffix}`);
      await seedInterview({
        id: `concurrent-purge-interview-${suffix}`,
        owner: `concurrent-purge-owner-${suffix}`,
      });
      const marked = await lifecycle.requestInterviewDeletion(
        interviewId(`concurrent-purge-interview-${suffix}`),
        ownerId(`concurrent-purge-owner-${suffix}`),
      );
      await makeDue(marked?.requestId ?? "");
    }
    const overdue = await lifecycle.getDeletionOverdueProjection();
    expect(overdue.overdueCount).toBe(2);
    expect(overdue.oldestPurgeDeadlineAt).toBeInstanceOf(Date);
    expect(overdue.maximumOverdueSeconds).toBeGreaterThan(0);

    const [first, second] = await Promise.all([
      createLifecycle("purge-sweeper-a", 1).sweepDuePurges(),
      createLifecycle("purge-sweeper-b", 1).sweepDuePurges(),
    ]);
    expect(first.succeeded + second.succeeded).toBe(2);
    expect(await client.database.select().from(deletionRequests)).toHaveLength(0);
    expect(await client.database.select().from(interviewSessions)).toHaveLength(0);
    expect(await client.database.select().from(purgeAuditEvents)).toHaveLength(10);
  });

  it("claims each overdue purge immediately before a slow attempt in the same bounded cycle", async () => {
    const requestIds: string[] = [];
    for (const suffix of ["slow", "next"]) {
      await seedOwner(`sequential-overdue-owner-${suffix}`);
      await seedInterview({
        id: `sequential-overdue-interview-${suffix}`,
        owner: `sequential-overdue-owner-${suffix}`,
      });
      const marked = await lifecycle.requestInterviewDeletion(
        interviewId(`sequential-overdue-interview-${suffix}`),
        ownerId(`sequential-overdue-owner-${suffix}`),
      );
      if (marked === null) {
        throw new Error("Expected overdue deletion request");
      }
      requestIds.push(marked.requestId);
    }
    await client.pool.query(
      `update deletion_requests
            set requested_at = statement_timestamp() - interval '8 days',
                purge_due_at = statement_timestamp() - interval '2 days',
                purge_deadline_at = statement_timestamp() - interval '1 day'
          where id = any($1::text[])`,
      [requestIds],
    );
    await client.pool.query(
      `create function delay_first_lifecycle_purge()
         returns trigger
         language plpgsql
         as $$
         begin
           if old.id = 'sequential-overdue-interview-slow' then
             perform pg_sleep(3.2);
           end if;
           return old;
         end;
         $$`,
    );
    await client.pool.query(
      `create trigger delay_first_lifecycle_purge_trigger
         before delete on interview_sessions
         for each row
         execute function delay_first_lifecycle_purge()`,
    );

    const sequential = new LifecycleService(lifecycleRepository, {
      purgeHashSecret: HASH_SECRET,
      purgeBatchSize: 2,
      purgeLeaseOwner: "sequential-overdue",
      purgeLeaseDurationMs: 60_000,
      failedPurgeRetryDelayMs: 60_000,
      maximumPurgeRequestsPerCycle: 2,
    });
    try {
      await expect(sequential.sweepDuePurges()).resolves.toEqual({
        claimed: 2,
        succeeded: 2,
        failed: 0,
      });
    } finally {
      await client.pool.query(
        "drop trigger if exists delay_first_lifecycle_purge_trigger on interview_sessions",
      );
      await client.pool.query("drop function if exists delay_first_lifecycle_purge()");
    }

    expect(await client.database.select().from(deletionRequests)).toHaveLength(0);
    expect(await client.database.select().from(interviewSessions)).toHaveLength(0);
    expect(await client.database.select().from(purgeAuditEvents)).toHaveLength(10);
  }, 10_000);

  it("bounds the number of purge requests attempted in one maintenance cycle", async () => {
    for (const suffix of ["a", "b"]) {
      await seedOwner(`bounded-purge-owner-${suffix}`);
      await seedInterview({
        id: `bounded-purge-interview-${suffix}`,
        owner: `bounded-purge-owner-${suffix}`,
      });
      const marked = await lifecycle.requestInterviewDeletion(
        interviewId(`bounded-purge-interview-${suffix}`),
        ownerId(`bounded-purge-owner-${suffix}`),
      );
      await makeDue(marked?.requestId ?? "");
    }
    const bounded = new LifecycleService(lifecycleRepository, {
      purgeHashSecret: HASH_SECRET,
      purgeBatchSize: 1,
      purgeLeaseOwner: "bounded-purge",
      purgeLeaseDurationMs: 60_000,
      failedPurgeRetryDelayMs: 60_000,
      maximumPurgeRequestsPerCycle: 10,
    });

    const firstRequest = (await client.database.select().from(deletionRequests))[0];
    if (firstRequest === undefined) {
      throw new Error("Expected bounded purge request");
    }
    await client.pool.query(
      `update deletion_requests
          set requested_at = statement_timestamp() - interval '6 days 23 hours 59 minutes 50 seconds',
              purge_due_at = statement_timestamp() - interval '6 days',
              purge_deadline_at = statement_timestamp() + interval '10 seconds'
        where id = $1`,
      [firstRequest.id],
    );
    await expect(bounded.runMaintenanceCycle()).resolves.toMatchObject({
      purge: { claimed: 1, succeeded: 1, failed: 0 },
    });
    expect(await client.database.select().from(deletionRequests)).toHaveLength(1);
  });
});
