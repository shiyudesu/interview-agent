import { parseAccountId } from "@interview-agent/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  account,
  deletionRequests,
  PgAccountAccessRepository,
  session,
  user,
} from "../src/index.js";
import {
  databaseNow,
  type PostgresTestDatabase,
  PostgresTestHarness,
} from "./support/postgres-test-harness.js";

let harness: PostgresTestHarness;
let testDatabase: PostgresTestDatabase;
let repository: PgAccountAccessRepository;

describe.sequential("account access PostgreSQL projections", () => {
  beforeAll(async () => {
    harness = await PostgresTestHarness.start();
    testDatabase = await harness.createDatabase({ name: "account_access" });
    repository = new PgAccountAccessRepository(testDatabase.client.database);
  }, 120_000);

  beforeEach(async () => {
    await testDatabase.pool.query(
      `truncate table deletion_requests, "user" restart identity cascade`,
    );
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it("projects the primary email, linked providers, and current database session", async () => {
    const accountId = parseAccountId("account-owner");
    const now = await databaseNow(testDatabase);
    await testDatabase.client.database.insert(user).values({
      id: accountId,
      name: "Candidate",
      email: "candidate@example.test",
      emailVerified: true,
      image: "https://images.example.test/candidate.png",
      createdAt: now,
      updatedAt: now,
    });
    await testDatabase.client.database.insert(account).values({
      id: "github-link",
      accountId: "github-user-42",
      providerId: "github",
      userId: accountId,
      createdAt: now,
      updatedAt: now,
    });
    await testDatabase.client.database.insert(account).values({
      id: "credential-account",
      accountId: accountId,
      providerId: "credential",
      userId: accountId,
      password: "internal-password-hash",
      createdAt: now,
      updatedAt: now,
    });
    await testDatabase.client.database.insert(session).values([
      {
        id: "session-current",
        token: "token-current",
        userId: accountId,
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
        updatedAt: now,
        ipAddress: "127.0.0.1",
        userAgent: "current-agent",
      },
      {
        id: "session-other",
        token: "token-other",
        userId: accountId,
        expiresAt: new Date(now.getTime() + 120_000),
        createdAt: new Date(now.getTime() + 1_000),
        updatedAt: new Date(now.getTime() + 1_000),
        ipAddress: "192.0.2.10",
        userAgent: "other-agent",
      },
      {
        id: "session-expired",
        token: "token-expired",
        userId: accountId,
        expiresAt: new Date(now.getTime() - 1_000),
        createdAt: new Date(now.getTime() - 10_000),
        updatedAt: new Date(now.getTime() - 10_000),
        ipAddress: "198.51.100.20",
        userAgent: "expired-agent",
      },
    ]);

    const projection = await repository.findAccountAccess(accountId, "session-current");

    expect(projection).toEqual({
      profile: {
        accountId,
        name: "Candidate",
        email: "candidate@example.test",
        emailVerified: true,
        image: "https://images.example.test/candidate.png",
        createdAt: now,
      },
      linkedIdentities: [
        {
          providerId: "email-otp",
          providerAccountId: "candidate@example.test",
          linkedAt: now,
        },
        {
          providerId: "github",
          providerAccountId: "github-user-42",
          linkedAt: now,
        },
      ],
      sessions: [
        {
          sessionId: "session-current",
          expiresAt: new Date(now.getTime() + 60_000),
          createdAt: now,
          updatedAt: now,
          ipAddress: "127.0.0.1",
          userAgent: "current-agent",
          current: true,
        },
        {
          sessionId: "session-other",
          expiresAt: new Date(now.getTime() + 120_000),
          createdAt: new Date(now.getTime() + 1_000),
          updatedAt: new Date(now.getTime() + 1_000),
          ipAddress: "192.0.2.10",
          userAgent: "other-agent",
          current: false,
        },
      ],
    });
  });

  it("projects a missing OTP display name as null", async () => {
    const accountId = parseAccountId("nameless-owner");
    const now = await databaseNow(testDatabase);
    await testDatabase.client.database.insert(user).values({
      id: accountId,
      name: "",
      email: "nameless@example.test",
      createdAt: now,
      updatedAt: now,
    });

    await expect(repository.findAccountAccess(accountId)).resolves.toMatchObject({
      profile: { accountId, name: null, email: "nameless@example.test" },
    });
  });

  it("returns no account projection after deletion becomes inaccessible", async () => {
    const accountId = parseAccountId("deleting-owner");
    const now = await databaseNow(testDatabase);
    await testDatabase.client.database.insert(user).values({
      id: accountId,
      name: "Deleting Candidate",
      email: "deleting@example.test",
      createdAt: now,
      updatedAt: now,
    });
    await testDatabase.client.database.insert(deletionRequests).values({
      id: "account-delete-request",
      ownerUserId: accountId,
      scope: "account",
      requestedAt: now,
      inaccessibleAt: now,
      purgeDueAt: now,
      purgeDeadlineAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000),
    });

    await expect(repository.findAccountAccess(accountId)).resolves.toBeNull();
  });
});
