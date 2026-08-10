import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const MIGRATION_DIALECT = "postgresql";
export const MIGRATION_SNAPSHOT_VERSION = "7";
const ROOT_SNAPSHOT_ID = "00000000-0000-0000-0000-000000000000";

export interface MigrationJournalEntry {
  readonly idx: number;
  readonly tag: string;
  readonly version: string;
  readonly when: number;
}

export interface MigrationJournal {
  readonly dialect: string;
  readonly entries: readonly MigrationJournalEntry[];
  readonly version: string;
}

export interface MigrationSnapshotIdentity {
  readonly dialect: string;
  readonly id: string;
  readonly prevId: string;
  readonly version: string;
}

export interface MigrationMetadata {
  readonly journal: MigrationJournal;
  readonly snapshots: Readonly<Record<string, MigrationSnapshotIdentity>>;
  readonly sqlTags: readonly string[];
}

export interface MigrationChecksumManifest {
  readonly algorithm: "sha256";
  readonly migrations: Readonly<Record<string, string>>;
  readonly version: 1;
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

export async function loadAndValidateMigrationMetadata(
  migrationsRoot: string,
): Promise<MigrationMetadata> {
  const metaRoot = resolve(migrationsRoot, "meta");
  const [journalSource, migrationFiles, metadataFiles] = await Promise.all([
    readFile(resolve(metaRoot, "_journal.json"), "utf8"),
    readdir(migrationsRoot),
    readdir(metaRoot),
  ]);
  const journal = parseJson<MigrationJournal>(journalSource, "migration journal");
  const sqlFiles = migrationFiles.filter((name) => name.endsWith(".sql")).sort();
  const invalidSqlFile = sqlFiles.find((name) => !/^\d{4}_.+\.sql$/.test(name));
  if (invalidSqlFile !== undefined) {
    throw new Error(`Orphan or malformed SQL migration ${invalidSqlFile}.`);
  }
  const snapshotNames = metadataFiles.filter((name) => name !== "_journal.json").sort();
  const invalidSnapshot = snapshotNames.find((name) => !/^\d{4}_snapshot\.json$/.test(name));
  if (invalidSnapshot !== undefined) {
    throw new Error(`Orphan or malformed migration metadata file ${invalidSnapshot}.`);
  }
  const snapshots = Object.fromEntries(
    await Promise.all(
      snapshotNames.map(async (name) => [
        name,
        parseJson<MigrationSnapshotIdentity>(
          await readFile(resolve(metaRoot, name), "utf8"),
          `migration snapshot ${name}`,
        ),
      ]),
    ),
  );
  const metadata = {
    journal,
    snapshots,
    sqlTags: sqlFiles.map((name) => name.slice(0, -4)),
  };
  validateMigrationMetadata(metadata);
  return metadata;
}

export function validateMigrationMetadata(metadata: MigrationMetadata): void {
  const { entries } = metadata.journal;
  if (
    metadata.journal.version !== MIGRATION_SNAPSHOT_VERSION ||
    metadata.journal.dialect !== MIGRATION_DIALECT
  ) {
    throw new Error(
      `Migration journal must use ${MIGRATION_DIALECT} snapshot version ${MIGRATION_SNAPSHOT_VERSION}.`,
    );
  }

  const indices = new Set<number>();
  const tags = new Set<string>();
  let previousWhen = Number.NEGATIVE_INFINITY;
  let previousTag = "";
  for (const [position, entry] of entries.entries()) {
    if (entry.idx !== position || indices.has(entry.idx)) {
      throw new Error(`Migration journal index ${entry.idx} is duplicated or out of order.`);
    }
    if (tags.has(entry.tag) || (previousTag !== "" && entry.tag <= previousTag)) {
      throw new Error(`Migration journal tag ${entry.tag} is duplicated or out of order.`);
    }
    const expectedPrefix = `${String(entry.idx).padStart(4, "0")}_`;
    if (!entry.tag.startsWith(expectedPrefix)) {
      throw new Error(`Migration journal tag ${entry.tag} does not match index ${entry.idx}.`);
    }
    if (entry.version !== MIGRATION_SNAPSHOT_VERSION) {
      throw new Error(`Migration journal entry ${entry.tag} has an incompatible version.`);
    }
    if (!Number.isSafeInteger(entry.when) || entry.when <= previousWhen) {
      throw new Error(`Migration journal timestamp for ${entry.tag} is not strictly ordered.`);
    }
    indices.add(entry.idx);
    tags.add(entry.tag);
    previousWhen = entry.when;
    previousTag = entry.tag;
  }

  const expectedSqlTags = entries.map((entry) => entry.tag);
  if (!sameValues(metadata.sqlTags, expectedSqlTags)) {
    throw new Error("SQL migrations do not exactly match the ordered migration journal.");
  }

  const expectedSnapshotNames = entries.map(
    (entry) => `${String(entry.idx).padStart(4, "0")}_snapshot.json`,
  );
  const actualSnapshotNames = Object.keys(metadata.snapshots).sort();
  if (!sameValues(actualSnapshotNames, expectedSnapshotNames)) {
    throw new Error("Migration snapshots do not exactly match the ordered migration journal.");
  }

  const snapshotIds = new Set<string>();
  let expectedPrevId = ROOT_SNAPSHOT_ID;
  for (const snapshotName of expectedSnapshotNames) {
    const snapshot = metadata.snapshots[snapshotName];
    if (snapshot === undefined) {
      throw new Error(`Missing migration snapshot ${snapshotName}.`);
    }
    if (snapshot.version !== MIGRATION_SNAPSHOT_VERSION || snapshot.dialect !== MIGRATION_DIALECT) {
      throw new Error(`Migration snapshot ${snapshotName} has an incompatible dialect or version.`);
    }
    if (snapshotIds.has(snapshot.id)) {
      throw new Error(`Migration snapshot ${snapshotName} has a duplicate id.`);
    }
    if (snapshot.prevId !== expectedPrevId) {
      throw new Error(`Migration snapshot ${snapshotName} breaks the prevId/id chain.`);
    }
    snapshotIds.add(snapshot.id);
    expectedPrevId = snapshot.id;
  }
}

export async function readAndVerifyMigrationChecksums(
  migrationsRoot: string,
  metadata?: MigrationMetadata,
): Promise<MigrationChecksumManifest> {
  const validatedMetadata = metadata ?? (await loadAndValidateMigrationMetadata(migrationsRoot));
  const manifest = parseJson<MigrationChecksumManifest>(
    await readFile(resolve(migrationsRoot, "migration-checksums.json"), "utf8"),
    "migration checksum manifest",
  );
  if (manifest.version !== 1 || manifest.algorithm !== "sha256") {
    throw new Error("Migration checksum manifest has an unsupported format.");
  }
  const expectedTags = validatedMetadata.journal.entries.map((entry) => entry.tag);
  const manifestTags = Object.keys(manifest.migrations);
  if (!sameValues(manifestTags, expectedTags)) {
    throw new Error("Migration checksum manifest does not exactly match the migration journal.");
  }
  for (const tag of expectedTags) {
    const expectedHash = manifest.migrations[tag];
    if (!/^[a-f0-9]{64}$/.test(expectedHash ?? "")) {
      throw new Error(`Migration checksum for ${tag} is not a SHA-256 digest.`);
    }
    const actualHash = createHash("sha256")
      .update(await readFile(resolve(migrationsRoot, `${tag}.sql`)))
      .digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error(`Immutable migration ${tag}.sql does not match its pinned checksum.`);
    }
  }
  return manifest;
}

export function assertDrizzleNoSchemaChanges(result: ProcessResult): void {
  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  if (result.exitCode !== 0) {
    throw new Error(
      `drizzle-kit generate failed with exit code ${String(result.exitCode)}:\n${output}`,
    );
  }
  const diagnostics =
    /\b(?:error|warning|warn|malformed|collision|incompatible|unsupported|failed|exception|enoent)\b/i;
  if (diagnostics.test(output)) {
    throw new Error(`drizzle-kit generate emitted an error or warning diagnostic:\n${output}`);
  }
  if (!/^No schema changes, nothing to migrate(?:\s+😴)?\s*$/m.test(output)) {
    throw new Error(
      `drizzle-kit generate did not report the recognized no-change result:\n${output}`,
    );
  }
}

function parseJson<Value>(source: string, description: string): Value {
  try {
    return JSON.parse(source) as Value;
  } catch (error) {
    throw new Error(`Unable to parse ${description}.`, { cause: error });
  }
}

function sameValues(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function stripAnsi(value: string): string {
  const escapeSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
  return value.replaceAll(escapeSequence, "");
}
