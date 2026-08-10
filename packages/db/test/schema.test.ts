import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { account, session, user, verification } from "../src/schema/index.js";

describe("Better Auth PostgreSQL schema", () => {
  it("uses the Better Auth model table names", () => {
    expect(
      [user, account, session, verification].map((table) => getTableConfig(table).name),
    ).toEqual(["user", "account", "session", "verification"]);
  });

  it("keeps primary email and session token unique", () => {
    expect(user.email.isUnique).toBe(true);
    expect(session.token.isUnique).toBe(true);
  });

  it("defines the Better Auth lookup indexes", () => {
    const accountIndexes = getTableConfig(account).indexes.map((item) => item.config);

    expect(accountIndexes.map((item) => item.name)).toEqual([
      "account_userId_idx",
      "account_providerId_accountId_idx",
    ]);
    expect(accountIndexes[1]?.unique).toBe(true);
    expect(getTableConfig(session).indexes.map((item) => item.config.name)).toEqual([
      "session_userId_idx",
    ]);
    expect(getTableConfig(verification).indexes.map((item) => item.config.name)).toEqual([
      "verification_identifier_idx",
    ]);
  });

  it("keeps framework timestamps compatible and uses timestamptz for project deletion state", () => {
    expect(user.createdAt.columnType).toBe("PgTimestamp");
    expect(user.createdAt.withTimezone).toBe(false);
    expect(user.createdAt.hasDefault).toBe(true);
    expect(session.expiresAt.notNull).toBe(true);
    expect(session.expiresAt.hasDefault).toBe(false);
    expect(session.updatedAt.notNull).toBe(true);
    expect(session.updatedAt.default).toBeUndefined();
    expect(session.updatedAt.defaultFn).toBeUndefined();
    expect(session.updatedAt.onUpdateFn).toBeTypeOf("function");
    expect(verification.updatedAt.hasDefault).toBe(true);
    expect(user.deletionRequestedAt.withTimezone).toBe(true);
  });

  it("supports linking while preserving the user primary email", () => {
    expect(account.accountId.notNull).toBe(true);
    expect(account.providerId.notNull).toBe(true);
    expect(account.userId.notNull).toBe(true);
    expect(user.email.notNull).toBe(true);
    expect(user.deletionRequestedAt.notNull).toBe(false);
  });
});
