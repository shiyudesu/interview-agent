import { describe, expect, it } from "vitest";

import { createDatabaseClient } from "../src/client.js";

describe("database client", () => {
  it("creates no PostgreSQL connections until the client is used", async () => {
    const client = createDatabaseClient({
      databaseUrl: "postgresql://user:password@127.0.0.1:1/interview",
    });

    expect(client.pool.totalCount).toBe(0);
    await client.close();
  });

  it("has an idempotent close lifecycle", async () => {
    const client = createDatabaseClient({
      databaseUrl: "postgresql://user:password@127.0.0.1:1/interview",
    });

    const firstClose = client.close();
    const secondClose = client.close();

    expect(secondClose).toBe(firstClose);
    await firstClose;
  });

  it("rejects invalid URLs without echoing credentials", () => {
    const credential = "private-password";

    expect(() =>
      createDatabaseClient({
        databaseUrl: `http://user:${credential}@localhost/interview`,
      }),
    ).toThrowError(expect.not.stringContaining(credential));
  });
});
