import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  QuestionBankValidationError,
  QuestionBankVersionConflictError,
  RepositoryCorruptionError,
  RepositoryImmutableConflictError,
} from "../packages/db/src/index.js";
import {
  type PostgresTestDatabase,
  PostgresTestHarness,
} from "../packages/db/test/support/postgres-test-harness.js";
import { runQuestionBankImportCli } from "../scripts/import-question-bank.js";

const questionBankRoot = fileURLToPath(new URL("../question-bank", import.meta.url));
const emptyQuestionBankRoot = fileURLToPath(
  new URL("./fixtures/empty-question-bank", import.meta.url),
);

describe.sequential("question-bank import CLI", () => {
  let harness: PostgresTestHarness;
  let testDatabase: PostgresTestDatabase;

  beforeAll(async () => {
    harness = await PostgresTestHarness.start();
    testDatabase = await harness.createDatabase({ name: "root_question_bank_import_cli" });
  }, 120_000);

  afterAll(async () => {
    await harness?.stop();
  });

  it("imports an empty development bank as a no-op", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runQuestionBankImportCli(["--root", resolve(emptyQuestionBankRoot)], {
      environment: { DATABASE_URL: testDatabase.databaseUrl },
      io: {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      },
    });

    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain("0 inserted");
    expect(stderr).toEqual([]);
  });

  it("does not expose driver messages or query parameters from an unknown database error", async () => {
    const stderr: string[] = [];
    const sensitiveWording = "SECRET SOURCE WORDING";
    const sensitiveRubric = "SECRET RUBRIC";
    const code = await runQuestionBankImportCli(["--root", resolve(questionBankRoot)], {
      environment: { DATABASE_URL: "postgres://unused.example/interview" },
      importer: {
        synchronize: async () => {
          const error = new Error(
            `Failed query with params: ${sensitiveWording}; ${sensitiveRubric}`,
          ) as Error & { params: readonly string[] };
          error.params = [sensitiveWording, sensitiveRubric];
          throw error;
        },
      },
      io: {
        stdout: () => undefined,
        stderr: (message) => stderr.push(message),
      },
    });

    expect(code).toBe(1);
    expect(stderr).toEqual(["Question-bank import failed due to a database error."]);
    expect(stderr.join("\n")).not.toContain(sensitiveWording);
    expect(stderr.join("\n")).not.toContain(sensitiveRubric);
    expect(stderr.join("\n")).not.toContain("params");
  });

  it.each([
    [
      new QuestionBankValidationError("go.safe.validation", 2, "active_unreviewed"),
      "go.safe.validation@2 (question_bank_validation:active_unreviewed)",
    ],
    [
      new QuestionBankVersionConflictError("go.safe.version", 2, 3),
      "go.safe.version@2 (question_bank_version_conflict)",
    ],
    [
      new RepositoryImmutableConflictError("question-bank version", "go.safe.immutable@4"),
      "go.safe.immutable@4 (repository_immutable_conflict)",
    ],
    [
      new RepositoryCorruptionError(
        "question-bank version",
        "go.safe.corruption@5",
        "SECRET SOURCE WORDING AND RUBRIC",
      ),
      "go.safe.corruption@5 (repository_corruption)",
    ],
  ])("maps known repository errors to stable identity and code", async (error, expected) => {
    const stderr: string[] = [];
    const code = await runQuestionBankImportCli(["--root", resolve(questionBankRoot)], {
      environment: { DATABASE_URL: "postgres://unused.example/interview" },
      importer: {
        synchronize: async () => {
          throw error;
        },
      },
      io: {
        stdout: () => undefined,
        stderr: (message) => stderr.push(message),
      },
    });

    expect(code).toBe(1);
    expect(stderr).toEqual([`Question-bank import rejected ${expected}.`]);
    expect(stderr.join("\n")).not.toContain("SECRET");
    expect(stderr.join("\n")).not.toContain("Rubric");
  });
});
