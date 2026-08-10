import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  type ExpectedPostgresCatalog,
  postgresCatalogHash,
  readPostgresCatalog,
} from "../test/support/postgres-catalog.js";
import { PostgresTestHarness } from "../test/support/postgres-test-harness.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const outputPath = resolve(packageRoot, "test/fixtures/postgres-catalog.snapshot.json");
const executeFile = promisify(execFile);

const harness = await PostgresTestHarness.start();
try {
  const database = await harness.createDatabase({ name: "release_catalog_snapshot" });
  const catalog = await readPostgresCatalog(database.pool);
  const snapshot: ExpectedPostgresCatalog = {
    formatVersion: 1,
    catalogHash: postgresCatalogHash(catalog),
    catalog,
  };
  await mkdir(resolve(packageRoot, "test/fixtures"), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await executeFile(resolve(packageRoot, "../../node_modules/.bin/biome"), [
    "format",
    "--write",
    outputPath,
  ]);
  console.info(`Updated ${outputPath}`);
} finally {
  await harness.stop();
}
