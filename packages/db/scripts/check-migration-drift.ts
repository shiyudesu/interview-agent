import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertDrizzleNoSchemaChanges,
  loadAndValidateMigrationMetadata,
  type ProcessResult,
  readAndVerifyMigrationChecksums,
} from "../src/migration-integrity.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const checkedMigrations = resolve(packageRoot, "drizzle");

export async function checkMigrationDrift(): Promise<void> {
  const metadata = await loadAndValidateMigrationMetadata(checkedMigrations);
  await readAndVerifyMigrationChecksums(checkedMigrations, metadata);

  const scratchRoot = resolve(
    packageRoot,
    `.test-artifacts/drizzle-drift-${process.pid}-${randomUUID()}`,
  );
  const generatedMigrations = resolve(scratchRoot, "drizzle");
  const configPath = resolve(scratchRoot, "drizzle.config.ts");
  const trackedBefore = await directoryDigest(checkedMigrations);

  try {
    await mkdir(scratchRoot, { recursive: true });
    await cp(checkedMigrations, generatedMigrations, { recursive: true });
    await writeFile(
      configPath,
      [
        'import { defineConfig } from "drizzle-kit";',
        "",
        "export default defineConfig({",
        '  dialect: "postgresql",',
        `  schema: ${JSON.stringify(resolve(packageRoot, "src/schema/index.ts"))},`,
        '  out: "./drizzle",',
        "  strict: true,",
        "  verbose: true,",
        "});",
        "",
      ].join("\n"),
    );

    const generatedBefore = await directoryDigest(generatedMigrations);
    const result = await runDrizzleGenerate(scratchRoot, configPath);
    assertDrizzleNoSchemaChanges(result);
    const generatedAfter = await directoryDigest(generatedMigrations);
    if (generatedAfter !== generatedBefore) {
      throw new Error(
        "Drizzle schema drift detected. Generate and review a new migration explicitly.",
      );
    }
    if ((await directoryDigest(checkedMigrations)) !== trackedBefore) {
      throw new Error("The drift guard mutated the checked migration directory.");
    }
    console.info("Drizzle schema matches the checked migration snapshots.");
  } finally {
    await rm(scratchRoot, { force: true, recursive: true });
  }
}

async function directoryDigest(root: string): Promise<string> {
  const files = await listFiles(root);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.slice(root.length + 1));
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}

async function listFiles(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort();
}

function runDrizzleGenerate(cwd: string, configPath: string): Promise<ProcessResult> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(
      resolve(packageRoot, "node_modules/.bin/drizzle-kit"),
      ["generate", "--config", configPath.slice(cwd.length + 1)],
      {
        cwd,
        env: { ...process.env, DATABASE_URL: undefined },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => resolveProcess({ exitCode, stderr, stdout }));
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkMigrationDrift();
}
