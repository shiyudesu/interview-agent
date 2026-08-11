import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  assertDrizzleNoSchemaChanges,
  loadAndValidateMigrationMetadata,
  type MigrationMetadata,
  readAndVerifyMigrationChecksums,
  validateMigrationMetadata,
} from "../src/migration-integrity.js";

const migrationsRoot = fileURLToPath(new URL("../drizzle", import.meta.url));

describe("migration integrity", () => {
  it("pins every checked SQL migration to its immutable SHA-256 checksum", async () => {
    const metadata = await loadAndValidateMigrationMetadata(migrationsRoot);
    await expect(readAndVerifyMigrationChecksums(migrationsRoot, metadata)).resolves.toMatchObject({
      algorithm: "sha256",
      version: 1,
    });
  });

  it("rejects an exit-zero metadata diagnostic instead of trusting the process status", () => {
    expect(() =>
      assertDrizzleNoSchemaChanges({
        exitCode: 0,
        stdout: "Error: 0004_snapshot.json data is malformed",
        stderr: "",
      }),
    ).toThrow(/diagnostic/i);
  });

  it("requires the explicit recognized no-change message and rejects warnings", () => {
    expect(() =>
      assertDrizzleNoSchemaChanges({
        exitCode: 0,
        stdout: "Warning: incompatible snapshot ignored",
        stderr: "",
      }),
    ).toThrow(/diagnostic/i);
    expect(() =>
      assertDrizzleNoSchemaChanges({
        exitCode: 0,
        stdout: "Generation completed",
        stderr: "",
      }),
    ).toThrow(/recognized no-change/i);
    expect(() =>
      assertDrizzleNoSchemaChanges({
        exitCode: 0,
        stdout: "No schema changes, nothing to migrate 😴",
        stderr: "",
      }),
    ).not.toThrow();
  });

  it("rejects a broken snapshot prevId/id chain before generation", async () => {
    const metadata = await loadAndValidateMigrationMetadata(migrationsRoot);
    const secondSnapshot = metadata.snapshots["0001_snapshot.json"];
    if (secondSnapshot === undefined) {
      throw new Error("Expected the second migration snapshot");
    }
    const broken: MigrationMetadata = {
      ...metadata,
      snapshots: {
        ...metadata.snapshots,
        "0001_snapshot.json": {
          ...secondSnapshot,
          prevId: "00000000-0000-0000-0000-000000000000",
        },
      },
    };
    expect(() => validateMigrationMetadata(broken)).toThrow(/prevId\/id chain/);
  });

  it("rejects orphan SQL migrations and snapshots", async () => {
    const metadata = await loadAndValidateMigrationMetadata(migrationsRoot);
    expect(() =>
      validateMigrationMetadata({
        ...metadata,
        sqlTags: [...metadata.sqlTags, "0009_orphan"],
      }),
    ).toThrow(/SQL migrations/);
    expect(() =>
      validateMigrationMetadata({
        ...metadata,
        snapshots: {
          ...metadata.snapshots,
          "0010_snapshot.json": {
            id: "orphan",
            prevId: "orphan-parent",
            version: "7",
            dialect: "postgresql",
          },
        },
      }),
    ).toThrow(/snapshots/);
  });
});
