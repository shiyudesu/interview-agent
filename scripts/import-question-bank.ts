import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { mapQuestionBankQuestionDtoToDefinition } from "../packages/contracts/src/question-bank-mappings.js";
import { createDatabaseClient } from "../packages/db/src/client.js";
import { loadDatabaseEnvironment, requireDatabaseUrl } from "../packages/db/src/config.js";
import {
  QuestionBankValidationError,
  QuestionBankVersionConflictError,
  RepositoryCorruptionError,
  RepositoryImmutableConflictError,
} from "../packages/db/src/repositories/errors.js";
import {
  PgQuestionBankRepository,
  type QuestionBankImportRequest,
  type QuestionBankImportResult,
} from "../packages/db/src/repositories/question-bank-repository.js";
import { QuestionBankImportService } from "../packages/db/src/services/question-bank-import-service.js";
import { loadQuestionBankDirectory } from "./validate-question-bank.js";

interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

interface ImportCliOptions {
  readonly help: boolean;
  readonly root: string;
}

interface ImportCliDependencies {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly importer?: {
    readonly synchronize: (request: QuestionBankImportRequest) => Promise<QuestionBankImportResult>;
  };
  readonly io?: CliIo;
}

function stableIdentity(value: string): string {
  return /^[A-Za-z0-9._:@-]+$/u.test(value) ? value : "unknown";
}

function questionIdentity(questionId: string | undefined, version: number | undefined): string {
  const identity = questionId === undefined ? "unknown" : stableIdentity(questionId);
  return version === undefined || !Number.isInteger(version) ? identity : `${identity}@${version}`;
}

function safeImportError(error: unknown): string {
  if (error instanceof QuestionBankValidationError) {
    return `Question-bank import rejected ${questionIdentity(error.questionId, error.contentVersion)} (${error.code}:${stableIdentity(error.validationCode)}).`;
  }
  if (error instanceof QuestionBankVersionConflictError) {
    return `Question-bank import rejected ${questionIdentity(error.questionId, error.attemptedVersion)} (${error.code}).`;
  }
  if (error instanceof RepositoryImmutableConflictError) {
    return `Question-bank import rejected ${stableIdentity(error.identifier)} (${error.code}).`;
  }
  if (error instanceof RepositoryCorruptionError) {
    return `Question-bank import rejected ${stableIdentity(error.identifier)} (${error.code}).`;
  }
  return "Question-bank import failed due to a database error.";
}

function parseOptions(args: readonly string[]): ImportCliOptions {
  let root = resolve("question-bank");
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--root") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--root requires a directory");
      }
      root = resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { help, root };
}

const usage = `Usage: pnpm question-bank:import [--root <directory>]

Validates repository YAML and atomically synchronizes immutable question versions into PostgreSQL.
DATABASE_URL is required. An empty development bank succeeds without changing persisted rows.`;

export async function runQuestionBankImportCli(
  args: readonly string[],
  dependencies: ImportCliDependencies = {},
): Promise<number> {
  const io = dependencies.io ?? {
    stdout: (message: string) => console.log(message),
    stderr: (message: string) => console.error(message),
  };

  let options: ImportCliOptions;
  try {
    options = parseOptions(args);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "Invalid command-line arguments");
    io.stderr(usage);
    return 2;
  }
  if (options.help) {
    io.stdout(usage);
    return 0;
  }

  const loaded = await loadQuestionBankDirectory(options.root);
  if (!loaded.valid) {
    for (const issue of loaded.issues) {
      const question = issue.questionId === undefined ? "" : ` [question ${issue.questionId}]`;
      io.stderr(`${issue.file}${question} ${issue.path} (${issue.code}): ${issue.message}`);
    }
    io.stderr(`Question-bank import rejected ${loaded.issues.length} validation error(s).`);
    return 1;
  }

  let databaseUrl: string;
  try {
    if (dependencies.environment === undefined) {
      loadDatabaseEnvironment();
    }
    databaseUrl = requireDatabaseUrl(dependencies.environment ?? process.env);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "DATABASE_URL is required");
    return 2;
  }

  let client: ReturnType<typeof createDatabaseClient> | undefined;
  try {
    const importer =
      dependencies.importer ??
      (() => {
        client = createDatabaseClient({ databaseUrl });
        return new QuestionBankImportService(new PgQuestionBankRepository(client.database));
      })();
    const result = await importer.synchronize({
      sourceName: "repository-question-bank",
      sourceVersion: 1,
      entries: loaded.files.flatMap((file) =>
        file.questions.map((question) => ({
          definition: mapQuestionBankQuestionDtoToDefinition(question),
          schemaVersion: file.schemaVersion,
          sourceFile: file.file,
        })),
      ),
    });
    await client?.close();
    client = undefined;
    io.stdout(
      `Question-bank import complete at ${result.importedAt.toISOString()}: ${result.insertedCount} inserted, ${result.noOpCount} unchanged, ${result.activatedCount} activated, ${result.retiredCount} retired.`,
    );
    return 0;
  } catch (error) {
    io.stderr(safeImportError(error));
    return 1;
  } finally {
    try {
      await client?.close();
    } catch {
      // The import error has already been sanitized; connection cleanup must not expose driver data.
    }
  }
}

const mainPath = process.argv[1];
if (mainPath !== undefined && pathToFileURL(resolve(mainPath)).href === import.meta.url) {
  process.exitCode = await runQuestionBankImportCli(process.argv.slice(2));
}
