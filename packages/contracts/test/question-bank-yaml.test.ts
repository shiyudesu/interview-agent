import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  loadQuestionBankDirectory,
  parseQuestionBankYaml,
  runQuestionBankCli,
  validateQuestionBankDirectory,
} from "../../../scripts/validate-question-bank.js";
import { validateQuestionBankSource } from "../src/question-bank.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures/question-bank", import.meta.url));
const repositoryQuestionBankRoot = fileURLToPath(
  new URL("../../../question-bank", import.meta.url),
);

describe("repository question-bank YAML", () => {
  it("provides exact reviewed question counts for the completed question-bank tasks", async () => {
    const result = await loadQuestionBankDirectory(repositoryQuestionBankRoot);
    const counts = new Map<string, number>();
    for (const file of result.files) {
      for (const question of file.questions) {
        counts.set(question.domain, (counts.get(question.domain) ?? 0) + 1);
      }
    }

    expect(result).toMatchObject({
      valid: true,
      fileCount: 6,
      questionCount: 90,
      activeReviewedCount: 90,
      issues: [],
    });
    expect(Object.fromEntries(counts)).toEqual({
      go_language: 15,
      concurrency_runtime_performance: 15,
      http_rpc_api: 15,
      database_storage: 15,
      cache_messaging_distributed: 15,
      testing_observability_engineering: 15,
    });
  });

  it("accepts a representative reviewed conceptual question", async () => {
    const result = await validateQuestionBankDirectory(`${fixtureRoot}/valid`);

    expect(result).toMatchObject({
      valid: true,
      fileCount: 1,
      questionCount: 1,
      activeReviewedCount: 1,
      issues: [],
    });
  });

  it("reports question-aware semantic errors from an invalid fixture", async () => {
    const result = await validateQuestionBankDirectory(`${fixtureRoot}/invalid`);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "go_language/invalid.yaml",
          questionId: "go.invalid.question",
          path: "/questions/0/sourceWording",
          code: "blank_text",
        }),
        expect.objectContaining({ code: "rubric_total" }),
        expect.objectContaining({ code: "duplicate_rubric_item_id" }),
        expect.objectContaining({ code: "missing_clarification_goal" }),
        expect.objectContaining({ code: "active_not_reviewed" }),
        expect.objectContaining({ code: "domain_mismatch" }),
      ]),
    );
  });

  it("rejects duplicate question ID/content-version pairs across files", async () => {
    const result = await validateQuestionBankDirectory(`${fixtureRoot}/duplicate`);

    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({
        file: "go_language/second.yaml",
        questionId: "go.duplicate.question",
        path: "/questions/0/contentVersion",
        code: "duplicate_question_version",
      }),
    ]);
  });

  it("requires files to live under their declared domain directory", async () => {
    const result = await validateQuestionBankDirectory(`${fixtureRoot}/misplaced`);

    expect(result.issues).toEqual([
      expect.objectContaining({
        file: "go_language/database.yaml",
        path: "/domain",
        code: "domain_mismatch",
      }),
    ]);
  });
});

describe("YAML parser security", () => {
  it("accepts a compact one-line bank with many siblings and five real collection levels", () => {
    const source = JSON.stringify({
      schemaVersion: "1.0",
      domain: "go_language",
      questions: [
        {
          id: "go.compact.question",
          contentVersion: 1,
          domain: "go_language",
          difficulty: "medium",
          questionType: "conceptual",
          sourceWording: "请解释 Go 调度器如何管理可运行的 goroutine。",
          rubric: Array.from({ length: 50 }, (_, index) => ({
            id: `rubric-${index}`,
            description: `评分点 ${index}`,
            weight: 2,
          })),
          followUpGoals: [
            {
              id: "clarify-scheduling",
              kind: "clarification",
              goal: "澄清调度对象和调度时机",
            },
            {
              id: "deepen-scheduling",
              kind: "depth",
              goal: "说明工作窃取的作用",
            },
          ],
          knowledgeExplanation: "调度器协调 G、M 和 P，并使用工作窃取平衡可运行任务。",
          active: true,
          reviewed: true,
          reviewMetadata: {
            reviewedBy: "reviewer-id",
            reviewedAt: "2026-08-10T00:00:00Z",
            simplifiedChineseVerified: true,
            technicalTermsVerified: true,
          },
        },
      ],
    });

    const parsed = parseQuestionBankYaml(source);

    expect(parsed.issues).toEqual([]);
    expect(validateQuestionBankSource(parsed.value)).toEqual([]);
  });

  it("rejects a 50k-key mapping before constructing an AST", () => {
    const source = Array.from({ length: 50_000 }, (_, index) => `key${index}: value`).join("\n");
    const parseDocuments = vi.fn(() => {
      throw new Error("parseAllDocuments must not be called");
    });

    const parsed = parseQuestionBankYaml(source, parseDocuments);

    expect(parsed.issues).toEqual([
      expect.objectContaining({
        code: "schema",
        message: expect.stringMatching(/exceeds (5000 lines|5000 collection entries)/u),
      }),
    ]);
    expect(parseDocuments).not.toHaveBeenCalled();
  });

  it.each([
    ["large flow collection", `[${Array.from({ length: 5_001 }, () => "value").join(",")}]`],
    ["deep flow nesting", `${"[".repeat(30)}value${"]".repeat(30)}`],
    ["deep block sequence nesting", `${"- ".repeat(30)}value`],
    [
      "deep block mapping nesting",
      `${Array.from({ length: 30 }, (_, index) => `${"  ".repeat(index)}key:\n`).join("")}${"  ".repeat(30)}value: true`,
    ],
    [
      "mixed block and flow nesting",
      `${Array.from({ length: 20 }, (_, index) => `${"  ".repeat(index)}key:\n`).join("")}${"  ".repeat(20)}value: ${"[".repeat(20)}item${"]".repeat(20)}`,
    ],
    ["compact sequence-map nesting", `${"- key: ".repeat(20)}value`],
  ])("rejects %s during pre-scan", (_label, source) => {
    const parseDocuments = vi.fn(() => {
      throw new Error("parseAllDocuments must not be called");
    });

    expect(parseQuestionBankYaml(source, parseDocuments).issues).toEqual([
      expect.objectContaining({ message: expect.stringContaining("exceeds") }),
    ]);
    expect(parseDocuments).not.toHaveBeenCalled();
  });

  it("rejects duplicate mapping keys without echoing their values", () => {
    const parsed = parseQuestionBankYaml(`schemaVersion: "1.0"
schemaVersion: "secret-value"
domain: go_language
questions: []
`);

    expect(parsed.issues).toEqual([
      expect.objectContaining({
        code: "schema",
        message: expect.stringContaining("DUPLICATE_KEY"),
      }),
    ]);
    expect(parsed.issues[0]?.message).not.toContain("secret-value");
  });

  it("rejects aliases and anchors", () => {
    const parsed = parseQuestionBankYaml(`schemaVersion: "1.0"
domain: go_language
questions:
  - &question
    id: go.anchor.question
    contentVersion: 1
  - *question
`);

    expect(parsed.issues).toEqual([
      expect.objectContaining({ message: "YAML anchors and aliases are not allowed" }),
    ]);
  });

  it("rejects explicit tags, multiple documents, and excessive nesting", () => {
    expect(parseQuestionBankYaml("schemaVersion: !!str 1.0\n").issues).toEqual([
      expect.objectContaining({ message: "Explicit YAML tags are not allowed" }),
    ]);
    expect(parseQuestionBankYaml("---\na: 1\n---\nb: 2\n").issues).toEqual([
      expect.objectContaining({ message: "Each YAML file must contain exactly one document" }),
    ]);

    const nested = `${Array.from({ length: 30 }, (_, index) => `${"  ".repeat(index)}a:\n`).join("")}${"  ".repeat(30)}value: true\n`;
    expect(parseQuestionBankYaml(nested).issues).toEqual([
      expect.objectContaining({ message: expect.stringContaining("exceeds depth") }),
    ]);
  });

  it("rejects prototype-affecting mapping keys", () => {
    const parsed = parseQuestionBankYaml(`schemaVersion: "1.0"
domain: go_language
__proto__:
  polluted: true
questions: []
`);

    expect(parsed.issues).toEqual([
      expect.objectContaining({ message: "Unsafe YAML mapping key __proto__ is not allowed" }),
    ]);
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});

describe("question-bank CLI", () => {
  it("returns success for development fixtures without a release minimum", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runQuestionBankCli(["--root", `${fixtureRoot}/valid`], {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    });

    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain("1 question(s)");
    expect(stderr).toEqual([]);
  });

  it("returns nonzero with file, question, and schema paths", async () => {
    const stderr: string[] = [];
    const code = await runQuestionBankCli(["--root", `${fixtureRoot}/invalid`], {
      stdout: () => undefined,
      stderr: (message) => stderr.push(message),
    });

    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain(
      "go_language/invalid.yaml [question go.invalid.question] /questions/0/sourceWording",
    );
  });

  it("rejects release mode until the separate 4.12 gate exists", async () => {
    const stderr: string[] = [];
    const code = await runQuestionBankCli(["--mode", "release"], {
      stdout: () => undefined,
      stderr: (message) => stderr.push(message),
    });

    expect(code).toBe(2);
    expect(stderr.join("\n")).toContain("release gate is task 4.12");
  });
});
