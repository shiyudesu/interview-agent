import {
  type OperationId,
  parseAccountId,
  parseInterviewId,
  parseOperationId,
} from "@interview-agent/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  type DatabaseClient,
  interviewSessions,
  operations,
  PgLifecycleRepository,
  PgOperationRepository,
  PgRepositoryUnitOfWork,
  questionBankVersions,
  RepositoryCorruptionError,
  RepositoryIdempotencyConflictError,
  RepositoryInterviewExpiredError,
  RepositoryInterviewUnavailableError,
  RepositoryOperationLeaseConflictError,
  RepositoryOperationRetryConflictError,
  RepositoryUnsafePayloadError,
  sessionQuestionSnapshots,
  user,
} from "../src/index.js";
import { type PostgresTestDatabase, PostgresTestHarness } from "./support/postgres-test-harness.js";
import { questionBankFixtureSourceHash } from "./support/question-bank-fixture.js";

const NOW = new Date("2026-08-10T00:00:00.000Z");
const OWNER_ID = parseAccountId("operation-owner");
const INTERVIEW_ID = parseInterviewId("operation-interview");
const INPUT = { questionPosition: 1, text: "immutable answer" } as const;

let harness: PostgresTestHarness;
let testDatabase: PostgresTestDatabase;
let client: DatabaseClient;
let repository: PgOperationRepository;
let unitOfWork: PgRepositoryUnitOfWork;
let lifecycleRepository: PgLifecycleRepository;
let sequence = 0;

function operationId(prefix: string): OperationId {
  sequence += 1;
  return parseOperationId(`${prefix}-${sequence}`);
}

function claim(operationIdValue: OperationId, owner: string, leaseDurationMs = 10_000) {
  return {
    operationId: operationIdValue,
    accountId: OWNER_ID,
    leaseOwner: owner,
    leaseDurationMs,
  };
}

function completionLease(claimed: Awaited<ReturnType<PgOperationRepository["claimPending"]>>) {
  if (claimed === null) {
    throw new Error("Expected claimed Operation");
  }
  return {
    leaseOwner: claimed.leaseOwner,
    leaseToken: claimed.leaseToken,
    attemptCount: claimed.attemptCount,
  };
}

async function setLeaseWindow(id: OperationId, window: "expired" | "live"): Promise<void> {
  const acquiredInterval = window === "expired" ? "2 minutes" : "1 minute";
  const expiryInterval = window === "expired" ? "-1 minute" : "1 minute";
  await client.pool.query(
    `update operations
        set lease_acquired_at = statement_timestamp() - $2::interval,
            lease_expires_at = statement_timestamp() + $3::interval
      where id = $1`,
    [id, acquiredInterval, expiryInterval],
  );
}

async function seedInterview(
  interviewIdValue = INTERVIEW_ID,
  status: "active" | "abandoned" = "active",
): Promise<void> {
  await client.database.transaction(async (transaction) => {
    await transaction.insert(interviewSessions).values({
      id: interviewIdValue,
      ownerUserId: OWNER_ID,
      selectedQuestionCount: 5,
      selectionSeed: `${interviewIdValue}-seed`,
      status,
      activePhase: status === "active" ? "awaiting_response" : null,
      endedAt: status === "abandoned" ? NOW : null,
      createdAt: NOW,
      lastEffectiveActivityAt: NOW,
    });
    await transaction.insert(sessionQuestionSnapshots).values(
      Array.from({ length: 5 }, (_, index) => {
        const position = index + 1;
        return {
          id: `${interviewIdValue}-snapshot-${position}`,
          interviewId: interviewIdValue,
          position,
          sourceQuestionId: `operation-question-${position}`,
          sourceQuestionVersion: 1,
          domain: "go_language" as const,
          sourceWording: `Question ${position}`,
          displayWording: `Question ${position}`,
          rubric: [],
          followUpGoals: [],
          knowledgeExplanation: "Internal",
          createdAt: NOW,
        };
      }),
    );
  });
}

async function createOperation(
  id = operationId("operation"),
  overrides: Partial<Parameters<PgOperationRepository["createOrLoad"]>[0]> = {},
) {
  return repository.createOrLoad({
    id,
    accountId: OWNER_ID,
    interviewId: INTERVIEW_ID,
    idempotencyScope: "interview-command",
    type: "submit_answer",
    idempotencyKey: `key-${id}`,
    expectedVersion: 1,
    input: INPUT,
    createdAt: NOW,
    ...overrides,
  });
}

describe.sequential("PostgreSQL Operation lifecycle", () => {
  beforeAll(async () => {
    harness = await PostgresTestHarness.start();
    testDatabase = await harness.createDatabase({ name: "operation_lifecycle_tests" });
    client = testDatabase.client;
    repository = new PgOperationRepository(client.database);
    unitOfWork = new PgRepositoryUnitOfWork(client.database);
    lifecycleRepository = new PgLifecycleRepository(client.database);
  }, 120_000);

  beforeEach(async () => {
    sequence = 0;
    await client.pool.query(
      `truncate table "user", question_bank_versions restart identity cascade`,
    );
    await client.database.insert(user).values({
      id: OWNER_ID,
      name: "Operation Owner",
      email: "operation-owner@example.com",
    });
    await client.database.insert(questionBankVersions).values(
      Array.from({ length: 5 }, (_, index) => {
        const position = index + 1;
        return {
          questionId: `operation-question-${position}`,
          contentVersion: 1,
          domain: "go_language" as const,
          sourceWording: `Question ${position}`,
          rubric: [],
          followUpGoals: [],
          knowledgeExplanation: "Internal",
          importSourceName: "operation-test",
          importSourceVersion: 1,
          sourceHash: questionBankFixtureSourceHash(`operation-question-${position}`),
        };
      }),
    );
    await seedInterview();
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it("creates once and loads the immutable canonical Operation and result", async () => {
    const firstId = operationId("duplicate");
    const first = await createOperation(firstId, { idempotencyKey: "duplicate-key" });
    const second = await createOperation(operationId("duplicate"), {
      idempotencyKey: "duplicate-key",
    });

    expect(first.created).toBe(true);
    expect(second).toEqual({ operation: first.operation, created: false });

    const ownedClaim = await repository.claimPending(claim(firstId, "worker-a"));
    expect(ownedClaim).toMatchObject({ attemptCount: 1, operation: { attemptCount: 1 } });
    const completed = await repository.completeSuccess({
      operationId: firstId,
      accountId: OWNER_ID,
      ...completionLease(ownedClaim),
      result: { accepted: true },
    });
    const duplicateAfterSuccess = await createOperation(operationId("duplicate"), {
      idempotencyKey: "duplicate-key",
    });
    expect(duplicateAfterSuccess).toEqual({ operation: completed, created: false });
    expect(duplicateAfterSuccess.operation.input).toEqual(INPUT);
    expect(duplicateAfterSuccess.operation.result).toEqual({ accepted: true });
  });

  it("lazily expires the interview before rejecting a pending duplicate", async () => {
    const id = operationId("expired-pending-duplicate");
    await createOperation(id, { idempotencyKey: "expired-pending-duplicate-key" });
    await client.pool.query(
      `update interview_sessions
          set last_effective_activity_at = statement_timestamp() - interval '25 hours'
        where id = $1`,
      [INTERVIEW_ID],
    );

    await expect(
      createOperation(operationId("expired-pending-duplicate"), {
        idempotencyKey: "expired-pending-duplicate-key",
      }),
    ).rejects.toBeInstanceOf(RepositoryInterviewExpiredError);
    expect(await repository.findById(id, OWNER_ID)).toMatchObject({
      id,
      status: "failed",
      retryable: false,
      error: { code: "interview_expired" },
    });
    expect(
      (
        await client.database
          .select({
            status: interviewSessions.status,
            version: interviewSessions.version,
          })
          .from(interviewSessions)
          .where(eq(interviewSessions.id, INTERVIEW_ID))
      )[0],
    ).toEqual({ status: "abandoned", version: 2 });
  });

  it("preserves a succeeded result after rejecting access to its expired interview", async () => {
    const id = operationId("expired-success-duplicate");
    await createOperation(id, { idempotencyKey: "expired-success-duplicate-key" });
    const ownedClaim = await repository.claimPending(claim(id, "worker-a"));
    const succeeded = await repository.completeSuccess({
      operationId: id,
      accountId: OWNER_ID,
      ...completionLease(ownedClaim),
      result: { accepted: true },
    });
    await client.pool.query(
      `update interview_sessions
          set last_effective_activity_at = statement_timestamp() - interval '25 hours'
        where id = $1`,
      [INTERVIEW_ID],
    );

    await expect(
      createOperation(operationId("expired-success-duplicate"), {
        idempotencyKey: "expired-success-duplicate-key",
      }),
    ).rejects.toBeInstanceOf(RepositoryInterviewExpiredError);
    expect(await repository.findById(id, OWNER_ID)).toEqual(succeeded);
    expect(
      (
        await client.database
          .select({
            status: interviewSessions.status,
            version: interviewSessions.version,
          })
          .from(interviewSessions)
          .where(eq(interviewSessions.id, INTERVIEW_ID))
      )[0],
    ).toEqual({ status: "abandoned", version: 2 });
  });

  it("persists lazy expiry before a corrupt protected read can proceed", async () => {
    const id = operationId("expired-corrupt-read");
    await client.database.insert(operations).values({
      id,
      ownerUserId: OWNER_ID,
      interviewId: INTERVIEW_ID,
      idempotencyScope: "interview-command",
      idempotencyKey: "expired-corrupt-read-key",
      type: "submit_answer",
      expectedVersion: 1,
      inputHash: "0".repeat(64),
      input: INPUT,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await client.pool.query(
      `update interview_sessions
          set last_effective_activity_at = statement_timestamp() - interval '25 hours'
        where id = $1`,
      [INTERVIEW_ID],
    );

    await expect(repository.findById(id, OWNER_ID)).rejects.toBeInstanceOf(
      RepositoryInterviewExpiredError,
    );
    expect(
      (
        await client.database
          .select({
            status: interviewSessions.status,
            version: interviewSessions.version,
          })
          .from(interviewSessions)
          .where(eq(interviewSessions.id, INTERVIEW_ID))
      )[0],
    ).toEqual({ status: "abandoned", version: 2 });
    expect(
      (
        await client.database
          .select({ status: operations.status, error: operations.error })
          .from(operations)
          .where(eq(operations.id, id))
      )[0],
    ).toEqual({ status: "failed", error: { code: "interview_expired" } });
  });

  it("aborts a transaction-bound read and persists expiry outside its transaction", async () => {
    const id = operationId("expired-bound-read");
    await createOperation(id);
    await client.pool.query(
      `update interview_sessions
          set last_effective_activity_at = statement_timestamp() - interval '25 hours'
        where id = $1`,
      [INTERVIEW_ID],
    );

    await expect(
      unitOfWork.run(async (repositories) => {
        await repositories.operations.findById(id, OWNER_ID);
        throw new Error("injected read failure");
      }),
    ).rejects.toBeInstanceOf(RepositoryInterviewExpiredError);

    expect(
      (
        await client.database
          .select({
            status: interviewSessions.status,
            version: interviewSessions.version,
          })
          .from(interviewSessions)
          .where(eq(interviewSessions.id, INTERVIEW_ID))
      )[0],
    ).toEqual({ status: "abandoned", version: 2 });
    expect(
      (
        await client.database
          .select({ status: operations.status, error: operations.error })
          .from(operations)
          .where(eq(operations.id, id))
      )[0],
    ).toEqual({ status: "failed", error: { code: "interview_expired" } });
  });

  it("rolls back interview expiry when Operation cancellation is injected to fail", async () => {
    const id = operationId("expired-completion");
    await createOperation(id);
    const ownedClaim = await repository.claimPending(claim(id, "worker-a"));
    await client.pool.query(
      `update interview_sessions
          set last_effective_activity_at = statement_timestamp() - interval '25 hours'
        where id = $1`,
      [INTERVIEW_ID],
    );

    await client.pool.query(
      `alter table operations
         add constraint injected_expiry_cancellation_failure
         check (status <> 'failed')`,
    );
    try {
      await expect(
        repository.completeSuccess({
          operationId: id,
          accountId: OWNER_ID,
          ...completionLease(ownedClaim),
          result: { accepted: true },
        }),
      ).rejects.toThrow();
    } finally {
      await client.pool.query(
        "alter table operations drop constraint injected_expiry_cancellation_failure",
      );
    }

    expect(
      (
        await client.database
          .select({
            status: interviewSessions.status,
            version: interviewSessions.version,
          })
          .from(interviewSessions)
          .where(eq(interviewSessions.id, INTERVIEW_ID))
      )[0],
    ).toEqual({ status: "active", version: 1 });
    expect(
      (
        await client.database
          .select({
            status: operations.status,
            leaseOwner: operations.leaseOwner,
            error: operations.error,
          })
          .from(operations)
          .where(eq(operations.id, id))
      )[0],
    ).toEqual({ status: "processing", leaseOwner: "worker-a", error: null });
  });

  it("rejects scoped key reuse with a different command, interview, or input fingerprint", async () => {
    await createOperation(operationId("conflict"), { idempotencyKey: "conflict-key" });
    const secondInterviewId = parseInterviewId("operation-interview-old");
    await seedInterview(secondInterviewId, "abandoned");

    for (const override of [
      { type: "submit_supplement" as const },
      { interviewId: secondInterviewId },
      { input: { questionPosition: 1, text: "changed answer" } },
    ]) {
      await expect(
        createOperation(operationId("conflict"), {
          idempotencyKey: "conflict-key",
          ...override,
        }),
      ).rejects.toBeInstanceOf(RepositoryIdempotencyConflictError);
    }
  });

  it("loads canonical nested duplicates and rejects a corrupt persisted fingerprint", async () => {
    const id = operationId("nested");
    const first = await createOperation(id, {
      idempotencyKey: "nested-key",
      input: {
        z: [{ b: 1e21, a: "换行\n文本" }, true, null],
        a: { tiny: 1e-7, integerLike: 1.0 },
        numericKeys: { "2": "two", "10": "ten" },
      },
    });

    const duplicate = await createOperation(operationId("nested"), {
      idempotencyKey: "nested-key",
      input: {
        a: { integerLike: 1, tiny: 0.0000001 },
        numericKeys: { "10": "ten", "2": "two" },
        z: [{ a: "换行\n文本", b: 1e21 }, true, null],
      },
    });
    expect(duplicate).toEqual({ operation: first.operation, created: false });

    const corruptId = operationId("corrupt-fingerprint");
    await client.database.insert(operations).values({
      id: corruptId,
      ownerUserId: OWNER_ID,
      interviewId: INTERVIEW_ID,
      idempotencyScope: "interview-command",
      idempotencyKey: "corrupt-fingerprint",
      type: "submit_answer",
      expectedVersion: 1,
      inputHash: "0".repeat(64),
      input: INPUT,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await expect(repository.findById(corruptId, OWNER_ID)).rejects.toBeInstanceOf(
      RepositoryCorruptionError,
    );
  });

  it("never returns an existing key after its owner or interview is deletion-marked", async () => {
    const id = operationId("deletion-hidden");
    await createOperation(id, { idempotencyKey: "deletion-hidden-key" });

    await client.database
      .update(interviewSessions)
      .set({ deletionRequestedAt: NOW })
      .where(eq(interviewSessions.id, INTERVIEW_ID));
    await expect(repository.findById(id, OWNER_ID)).resolves.toBeNull();
    await expect(
      repository.findByIdempotencyKey(OWNER_ID, "interview-command", "deletion-hidden-key"),
    ).resolves.toBeNull();
    await expect(
      repository.claimPending(claim(id, "deletion-hidden-worker")),
    ).rejects.toBeInstanceOf(RepositoryInterviewUnavailableError);
    await expect(
      createOperation(operationId("deletion-hidden"), {
        idempotencyKey: "deletion-hidden-key",
      }),
    ).rejects.toBeInstanceOf(RepositoryInterviewUnavailableError);

    await client.database
      .update(interviewSessions)
      .set({ deletionRequestedAt: null })
      .where(eq(interviewSessions.id, INTERVIEW_ID));
    await client.database
      .update(user)
      .set({ deletionRequestedAt: NOW })
      .where(eq(user.id, OWNER_ID));
    await expect(repository.findById(id, OWNER_ID)).resolves.toBeNull();
    await expect(
      repository.findByIdempotencyKey(OWNER_ID, "interview-command", "deletion-hidden-key"),
    ).resolves.toBeNull();
    await expect(
      createOperation(operationId("deletion-hidden"), {
        idempotencyKey: "deletion-hidden-key",
      }),
    ).rejects.toBeInstanceOf(RepositoryInterviewUnavailableError);
  });

  it("serializes Operation creation before account deletion and cancels the new row", async () => {
    const id = operationId("create-before-delete");
    let operationCreated: (() => void) | undefined;
    const created = new Promise<void>((resolve) => {
      operationCreated = resolve;
    });
    let releaseCreation: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseCreation = resolve;
    });
    const creation = unitOfWork.run(async (repositories) => {
      const result = await repositories.operations.createOrLoad({
        id,
        accountId: OWNER_ID,
        interviewId: INTERVIEW_ID,
        idempotencyScope: "interview-command",
        type: "submit_answer",
        idempotencyKey: "create-before-delete-key",
        expectedVersion: 1,
        input: INPUT,
        createdAt: NOW,
      });
      operationCreated?.();
      await release;
      return result;
    });
    await created;

    const deletion = lifecycleRepository.markAccountDeleting(OWNER_ID);
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseCreation?.();
    await expect(creation).resolves.toMatchObject({ created: true });
    await expect(deletion).resolves.toMatchObject({ scope: "account" });
    expect(
      (
        await client.database
          .select({ status: operations.status, error: operations.error })
          .from(operations)
          .where(eq(operations.id, id))
      )[0],
    ).toMatchObject({
      status: "failed",
      error: { code: "account_deletion_requested" },
    });
    await expect(repository.findById(id, OWNER_ID)).resolves.toBeNull();
  });

  it("waits for concurrent account deletion and refuses to insert afterward", async () => {
    let deletionMarked: (() => void) | undefined;
    const marked = new Promise<void>((resolve) => {
      deletionMarked = resolve;
    });
    let releaseDeletion: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    const deletion = unitOfWork.run(async (repositories) => {
      const result = await repositories.lifecycle.markAccountDeleting(OWNER_ID);
      deletionMarked?.();
      await release;
      return result;
    });
    await marked;

    const creation = createOperation(operationId("delete-before-create"), {
      idempotencyKey: "delete-before-create-key",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseDeletion?.();
    await expect(deletion).resolves.toMatchObject({ scope: "account" });
    await expect(creation).rejects.toBeInstanceOf(RepositoryInterviewUnavailableError);
    expect(await client.database.select({ id: operations.id }).from(operations)).toHaveLength(0);
  });

  it("allows only one concurrent pending claimant", async () => {
    const id = operationId("concurrent");
    await createOperation(id);
    const claims = await Promise.all([
      repository.claimPending(claim(id, "worker-a")),
      repository.claimPending(claim(id, "worker-b")),
    ]);

    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
    expect((await repository.findById(id, OWNER_ID))?.attemptCount).toBe(1);
  });

  it("rejects live leases and reclaims only strictly stale processing", async () => {
    const id = operationId("reclaim");
    await createOperation(id);
    await repository.claimPending(claim(id, "worker-a"));

    await setLeaseWindow(id, "live");
    await expect(
      repository.reclaimStaleProcessing({
        ...claim(id, "worker-b"),
        input: INPUT,
      }),
    ).rejects.toBeInstanceOf(RepositoryOperationRetryConflictError);

    await setLeaseWindow(id, "expired");
    const reclaimed = await repository.reclaimStaleProcessing({
      ...claim(id, "worker-b"),
      input: INPUT,
    });
    expect(reclaimed).toMatchObject({
      attemptCount: 2,
      leaseOwner: "worker-b",
      operation: {
        status: "processing",
        attemptCount: 2,
        leaseOwner: "worker-b",
      },
    });
  });

  it("retries only retryable failures with unchanged immutable input", async () => {
    const nonRetryableId = operationId("non-retryable");
    await createOperation(nonRetryableId);
    const nonRetryableClaim = await repository.claimPending(claim(nonRetryableId, "worker-a"));
    await repository.completeFailure({
      operationId: nonRetryableId,
      accountId: OWNER_ID,
      ...completionLease(nonRetryableClaim),
      error: { code: "invalid_command" },
      retryable: false,
    });
    await expect(
      repository.retryFailedAndClaim({
        ...claim(nonRetryableId, "worker-b"),
        input: INPUT,
      }),
    ).rejects.toBeInstanceOf(RepositoryOperationRetryConflictError);

    const retryableId = operationId("retryable");
    await createOperation(retryableId);
    const retryableClaim = await repository.claimPending(claim(retryableId, "worker-a"));
    await repository.completeFailure({
      operationId: retryableId,
      accountId: OWNER_ID,
      ...completionLease(retryableClaim),
      error: { code: "provider_unavailable" },
      retryable: true,
    });
    await expect(
      repository.retryFailedAndClaim({
        ...claim(retryableId, "worker-b"),
        input: { ...INPUT, text: "changed" },
      }),
    ).rejects.toBeInstanceOf(RepositoryIdempotencyConflictError);

    const retried = await repository.retryFailedAndClaim({
      ...claim(retryableId, "worker-b"),
      input: INPUT,
    });
    expect(retried).toMatchObject({
      attemptCount: 2,
      operation: {
        status: "processing",
        attemptCount: 2,
        error: null,
        retryable: false,
      },
    });
  });

  it("serializes retry with account deletion and never resurrects the Operation", async () => {
    const id = operationId("retry-during-deletion");
    await createOperation(id);
    const initialClaim = await repository.claimPending(claim(id, "worker-a"));
    await repository.completeFailure({
      operationId: id,
      accountId: OWNER_ID,
      ...completionLease(initialClaim),
      error: { code: "provider_unavailable" },
      retryable: true,
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
      const result = await repositories.lifecycle.markAccountDeleting(OWNER_ID);
      deletionMarked?.();
      await release;
      return result;
    });
    await marked;

    const retry = expect(
      repository.retryFailedAndClaim({
        ...claim(id, "worker-b"),
        input: INPUT,
      }),
    ).rejects.toBeInstanceOf(RepositoryInterviewUnavailableError);
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseDeletion?.();
    await expect(deletion).resolves.toMatchObject({ scope: "account" });
    await retry;

    expect(
      (
        await client.database
          .select({
            status: operations.status,
            retryable: operations.retryable,
            error: operations.error,
          })
          .from(operations)
          .where(eq(operations.id, id))
      )[0],
    ).toEqual({
      status: "failed",
      retryable: true,
      error: { code: "provider_unavailable" },
    });
    await expect(repository.findById(id, OWNER_ID)).resolves.toBeNull();
  });

  it("rejects stale worker completion after a reclaim", async () => {
    const id = operationId("stale-completion");
    await createOperation(id);
    const staleClaim = await repository.claimPending(claim(id, "same-worker"));
    await setLeaseWindow(id, "expired");
    const currentClaim = await repository.reclaimStaleProcessing({
      ...claim(id, "same-worker"),
      input: INPUT,
    });
    expect(currentClaim.leaseToken).not.toBe(staleClaim?.leaseToken);

    await expect(
      repository.completeSuccess({
        operationId: id,
        accountId: OWNER_ID,
        ...completionLease(staleClaim),
        result: { accepted: true },
      }),
    ).rejects.toBeInstanceOf(RepositoryOperationLeaseConflictError);
    await expect(
      repository.completeSuccess({
        operationId: id,
        accountId: OWNER_ID,
        ...completionLease(currentClaim),
        attemptCount: currentClaim.attemptCount - 1,
        result: { accepted: true },
      }),
    ).rejects.toBeInstanceOf(RepositoryOperationLeaseConflictError);
    await expect(
      repository.completeSuccess({
        operationId: id,
        accountId: OWNER_ID,
        ...completionLease(currentClaim),
        result: { accepted: true },
      }),
    ).resolves.toMatchObject({ status: "succeeded", attemptCount: 2 });
  });

  it("returns canonical duplicate success and conflicts on a different completion", async () => {
    const id = operationId("duplicate-success");
    await createOperation(id);
    const ownedClaim = await repository.claimPending(claim(id, "worker-a"));
    const completion = {
      operationId: id,
      accountId: OWNER_ID,
      ...completionLease(ownedClaim),
      result: { accepted: true, sequence: 1 },
    };
    const first = await repository.completeSuccess(completion);

    await expect(repository.completeSuccess(completion)).resolves.toEqual(first);
    await expect(
      repository.completeSuccess({ ...completion, result: { accepted: false } }),
    ).rejects.toBeInstanceOf(RepositoryOperationLeaseConflictError);
  });

  it("rolls back transaction-bound completion without changing the Operation", async () => {
    const id = operationId("rollback");
    await createOperation(id);
    const ownedClaim = await repository.claimPending(claim(id, "worker-a"));

    await expect(
      unitOfWork.run(async (repositories) => {
        await repositories.operations.completeSuccess({
          operationId: id,
          accountId: OWNER_ID,
          ...completionLease(ownedClaim),
          result: { accepted: true },
        });
        throw new Error("rollback sentinel");
      }),
    ).rejects.toThrow("rollback sentinel");

    expect(await repository.findById(id, OWNER_ID)).toMatchObject({
      status: "processing",
      leaseOwner: "worker-a",
      result: null,
    });
    const interview = await client.database
      .select({ version: interviewSessions.version })
      .from(interviewSessions)
      .where(eq(interviewSessions.id, INTERVIEW_ID));
    expect(interview[0]?.version).toBe(1);
  });

  it("uses database time for completion and rejects an explicitly expired lease", async () => {
    const liveId = operationId("expiry-live");
    await createOperation(liveId);
    const liveClaim = await repository.claimPending(claim(liveId, "worker-a"));
    const completed = await repository.completeSuccess({
      operationId: liveId,
      accountId: OWNER_ID,
      ...completionLease(liveClaim),
      result: { accepted: true },
    });
    expect(completed.status).toBe("succeeded");
    expect(completed.completedAt).toBeInstanceOf(Date);
    expect(completed.updatedAt).toEqual(completed.completedAt);

    const expiredId = operationId("expiry-past");
    await createOperation(expiredId);
    const expiredClaim = await repository.claimPending(claim(expiredId, "worker-a"));
    await setLeaseWindow(expiredId, "expired");
    await expect(
      repository.completeSuccess({
        operationId: expiredId,
        accountId: OWNER_ID,
        ...completionLease(expiredClaim),
        result: { accepted: true },
      }),
    ).rejects.toBeInstanceOf(RepositoryOperationLeaseConflictError);
    expect((await repository.findById(expiredId, OWNER_ID))?.status).toBe("processing");
  });

  it("generates bounded fresh lease tokens and persists only their hashes", async () => {
    const invalidId = operationId("invalid-duration");
    await createOperation(invalidId);
    for (const leaseDurationMs of [0, -1, 1.5, 86_400_001]) {
      await expect(
        repository.claimPending(claim(invalidId, "worker-a", leaseDurationMs)),
      ).rejects.toBeInstanceOf(RepositoryOperationLeaseConflictError);
    }

    const claimed = await repository.claimPending(claim(invalidId, "worker-a", 1_000));
    expect(claimed?.leaseToken).toHaveLength(43);
    expect(claimed?.operation).not.toHaveProperty("leaseToken");
    expect(claimed?.operation.lastAttemptAt).toEqual(claimed?.operation.leaseAcquiredAt);
    expect(claimed?.operation.updatedAt).toEqual(claimed?.operation.leaseAcquiredAt);
    expect(
      requiredDate(claimed?.operation.leaseExpiresAt).getTime() -
        requiredDate(claimed?.operation.leaseAcquiredAt).getTime(),
    ).toBe(1_000);
    const persisted = await client.database
      .select({ leaseTokenHash: operations.leaseTokenHash })
      .from(operations)
      .where(eq(operations.id, invalidId));
    expect(persisted[0]?.leaseTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted[0]?.leaseTokenHash).not.toBe(claimed?.leaseToken);
  });

  it("rejects unsafe secret-bearing JSON before persistence", async () => {
    await expect(
      createOperation(operationId("unsafe"), {
        input: { questionPosition: 1, accessToken: "must-not-persist" },
      }),
    ).rejects.toBeInstanceOf(RepositoryUnsafePayloadError);
    expect(await client.database.select({ id: operations.id }).from(operations)).toHaveLength(0);
  });
});

function requiredDate(value: Date | null | undefined): Date {
  if (value === null || value === undefined) {
    throw new Error("Expected persisted lease timestamp");
  }
  return value;
}
