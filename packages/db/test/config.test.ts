import { describe, expect, it } from "vitest";

import { requireDatabaseUrl } from "../src/config.js";

describe("database configuration", () => {
  it("fails clearly when DATABASE_URL is missing", () => {
    expect(() => requireDatabaseUrl({})).toThrowError(
      "DATABASE_URL is required for database migration and Drizzle schema generation.",
    );
  });

  it("does not include another environment value in the failure", () => {
    const credential = "do-not-include-this-value";

    expect(() => requireDatabaseUrl({ DATABASE_PASSWORD: credential })).toThrowError(
      expect.not.stringContaining(credential),
    );
  });
});
