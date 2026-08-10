import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { type ExpectedPostgresCatalog, postgresCatalogHash } from "./support/postgres-catalog.js";

const snapshotPath = fileURLToPath(
  new URL("./fixtures/postgres-catalog.snapshot.json", import.meta.url),
);

describe("PostgreSQL catalog canonicalization", () => {
  it("keeps the checked catalog structure consistent with its pinned hash", async () => {
    const expected = await readExpectedCatalog();
    expect(postgresCatalogHash(expected.catalog)).toBe(expected.catalogHash);
  });

  it("changes the canonical hash when an index predicate changes", async () => {
    const expected = await readExpectedCatalog();
    const index = expected.catalog.indexes.find((candidate) => candidate.predicate !== null);
    if (index === undefined) {
      throw new Error("Expected a partial index in the release catalog");
    }
    const changed = {
      ...expected.catalog,
      indexes: expected.catalog.indexes.map((candidate) =>
        candidate === index
          ? { ...candidate, predicate: `${candidate.predicate} AND false` }
          : candidate,
      ),
    };
    expect(postgresCatalogHash(changed)).not.toBe(expected.catalogHash);
  });

  it("changes the canonical hash when enum label order changes", async () => {
    const expected = await readExpectedCatalog();
    const enumDefinition = expected.catalog.enums.find((candidate) => candidate.labels.length > 1);
    if (enumDefinition === undefined) {
      throw new Error("Expected a multi-label enum in the release catalog");
    }
    const changed = {
      ...expected.catalog,
      enums: expected.catalog.enums.map((candidate) =>
        candidate === enumDefinition
          ? { ...candidate, labels: candidate.labels.toReversed() }
          : candidate,
      ),
    };
    expect(postgresCatalogHash(changed)).not.toBe(expected.catalogHash);
  });

  it("changes the canonical hash when a function body changes", async () => {
    const expected = await readExpectedCatalog();
    const functionDefinition = expected.catalog.functions[0];
    if (functionDefinition === undefined) {
      throw new Error("Expected a project function in the release catalog");
    }
    const changed = {
      ...expected.catalog,
      functions: expected.catalog.functions.map((candidate) =>
        candidate === functionDefinition
          ? { ...candidate, definition: `${candidate.definition}\n-- changed body` }
          : candidate,
      ),
    };
    expect(postgresCatalogHash(changed)).not.toBe(expected.catalogHash);
  });
});

async function readExpectedCatalog(): Promise<ExpectedPostgresCatalog> {
  return JSON.parse(await readFile(snapshotPath, "utf8")) as ExpectedPostgresCatalog;
}
