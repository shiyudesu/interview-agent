import {
  type OperationId,
  parseAccountId,
  parseInterviewId,
  parseOperationId,
} from "@interview-agent/domain";
import { eq } from "drizzle-orm";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDatabaseClient,
  type DatabaseClient,
  interviewSessions,
  operations,
  PgOperationRepository,
  PgRepositoryUnitOfWork,
  questionBankVersions,
  RepositoryCorruptionError,
  RepositoryIdempotencyConflictError,
  RepositoryOperationLeaseConflictError,
  RepositoryOperationRetryConflictError,
  RepositoryUnsafePayloadError,
  sessionQuestionSnapshots,
  user,
} from "../src/index.js";
import { runDatabaseMigrations } from "../src/migrate.js";

const NOW = new Date("2026-08-10T00:00:00.000Z");
const OWNER_ID = parseAccountId("operation-owner");
const INTERVIEW_ID = parseInterviewId("operation-interview");
const INPUT = { questionPosition: 1, text: "immutable answer" } as const;

let container: StartedTestContainer;
let client: DatabaseClient;
let repository: PgOperationRepository;
let unitOfWork: PgRepositoryUnitOfWork;
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
    container = await new GenericContainer("postgres:18.4-alpine")
      .withEnvironment({
        POSTGRES_DB: "interview",
        POSTGRES_PASSWORD: "interview",
        POSTGRES_USER: "interview",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
      .withStartupTimeout(120_000)
      .start();
    const databaseUrl = new URL("postgresql://localhost/interview");
    databaseUrl.hostname = container.getHost();
    databaseUrl.port = String(container.getMappedPort(5432));
    databaseUrl.username = "interview";
    databaseUrl.password = "interview";
    await runDatabaseMigrations({ databaseUrl: databaseUrl.toString() });
    client = createDatabaseClient({ databaseUrl: databaseUrl.toString(), max: 8 });
    repository = new PgOperationRepository(client.database);
    unitOfWork = new PgRepositoryUnitOfWork(client.database);
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
        };
      }),
    );
    await seedInterview();
  });

  afterAll(async () => {
    await client?.close();
    await container?.stop();
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
