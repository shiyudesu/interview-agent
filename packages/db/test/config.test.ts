import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  readBoundedIntegerEnvironment,
  requireDatabaseUrl,
  requirePurgeAuditHashSecret,
} from "../src/config.js";

const maintenanceCli = fileURLToPath(new URL("../dist/cli/maintenance.js", import.meta.url));

function runMaintenanceCli(environment: NodeJS.ProcessEnv): Promise<{
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [maintenanceCli], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stderr, stdout }));
  });
}

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

  it("requires a separate deterministic purge audit hash secret", () => {
    expect(() => requirePurgeAuditHashSecret({ PURGE_AUDIT_HASH_SECRET: "short" })).toThrowError(
      "PURGE_AUDIT_HASH_SECRET must contain at least 32 characters.",
    );
    expect(
      requirePurgeAuditHashSecret({
        PURGE_AUDIT_HASH_SECRET: "a-distinct-secret-with-at-least-32-characters",
        BETTER_AUTH_SECRET: "a-different-auth-secret-with-at-least-32-characters",
      }),
    ).toBe("a-distinct-secret-with-at-least-32-characters");
    expect(() =>
      requirePurgeAuditHashSecret({
        PURGE_AUDIT_HASH_SECRET: "same-secret-with-at-least-32-characters",
        BETTER_AUTH_SECRET: "same-secret-with-at-least-32-characters",
      }),
    ).toThrowError("PURGE_AUDIT_HASH_SECRET must be distinct from BETTER_AUTH_SECRET.");
  });

  it("accepts the minimum bounded integer and rejects disabled or excessive values", () => {
    expect(readBoundedIntegerEnvironment("LIMIT", 10, 1, 1_000, { LIMIT: "1" })).toBe(1);
    for (const value of ["0", "-1", "1.5", "1001"]) {
      expect(() =>
        readBoundedIntegerEnvironment("LIMIT", 10, 1, 1_000, { LIMIT: value }),
      ).toThrowError("LIMIT must be an integer from 1 through 1000.");
    }
  });

  it("exits nonzero with a safe error when maintenance limits are invalid", async () => {
    const secret = "maintenance-cli-test-secret-with-at-least-32-characters";
    const databaseUrl = "postgresql://unused:unused@127.0.0.1:1/unused";
    const result = await runMaintenanceCli({
      ...process.env,
      DATABASE_URL: databaseUrl,
      PURGE_AUDIT_HASH_SECRET: secret,
      INTERVIEW_EXPIRY_BATCH_SIZE: "50",
      INTERVIEW_EXPIRY_MAX_BATCHES_PER_CYCLE: "1000",
      DELETION_PURGE_BATCH_SIZE: "0",
      DELETION_PURGE_LEASE_DURATION_MS: "300000",
      DELETION_PURGE_RETRY_DELAY_MS: "300000",
      DELETION_PURGE_MAX_REQUESTS_PER_CYCLE: "1000",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Lifecycle maintenance failed.");
    expect(result.stderr).toContain(
      "DELETION_PURGE_BATCH_SIZE must be an integer from 1 through 1000.",
    );
    expect(result.stderr).not.toContain(secret);
    expect(result.stderr).not.toContain(databaseUrl);
  });
});
