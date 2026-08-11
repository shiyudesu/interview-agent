import type { Dirent } from "node:fs";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { open, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Check } from "typebox/value";
import { CST, isAlias, isScalar, Lexer, LineCounter, parseAllDocuments, visit } from "yaml";

import {
  type QuestionBankSourceDto,
  QuestionBankSourceSchema,
  type QuestionBankValidationIssue,
  validateQuestionBankSource,
} from "../packages/contracts/src/question-bank.js";
import { normalizeQuestionBankSourcePath } from "../packages/domain/src/question-bank-source-path.js";

const SUPPORTED_SCHEMA_VERSION = "1.0";
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 1_000;
const MAX_DIRECTORY_DEPTH = 8;
const MAX_YAML_DEPTH = 24;
const MAX_YAML_LINES = 5_000;
const MAX_YAML_TOKENS = 50_000;
const MAX_YAML_COLLECTION_ENTRIES = 5_000;
const MAX_YAML_NODES = 10_000;
const MAX_SCALAR_LENGTH = 100_000;
const READ_CHUNK_BYTES = 64 * 1024;
const UNSAFE_MAPPING_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface QuestionBankFileIssue extends QuestionBankValidationIssue {
  readonly file: string;
  readonly questionId?: string;
}

export interface ParsedQuestionBankYaml {
  readonly value?: unknown;
  readonly issues: readonly QuestionBankValidationIssue[];
}

export interface QuestionBankValidationResult {
  readonly valid: boolean;
  readonly root: string;
  readonly fileCount: number;
  readonly questionCount: number;
  readonly activeReviewedCount: number;
  readonly issues: readonly QuestionBankFileIssue[];
}

export interface LoadedQuestionBankFile {
  readonly file: string;
  readonly schemaVersion: "1.0";
  readonly questions: QuestionBankSourceDto["questions"];
}

export interface QuestionBankLoadResult extends QuestionBankValidationResult {
  readonly files: readonly LoadedQuestionBankFile[];
}

interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

interface CliOptions {
  readonly root: string;
  readonly help: boolean;
  readonly mode: "development" | "release";
}

interface UnknownRecord {
  readonly [key: string]: unknown;
  readonly code?: unknown;
  readonly id?: unknown;
  readonly questions?: unknown;
  readonly schemaVersion?: unknown;
}

type ParseAllDocuments = typeof parseAllDocuments;

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function yamlPosition(error: {
  readonly linePos?:
    | readonly [{ readonly line: number; readonly col: number }]
    | readonly [
        { readonly line: number; readonly col: number },
        { readonly line: number; readonly col: number },
      ]
    | undefined;
}): string {
  const start = error.linePos?.[0];
  return start === undefined ? "" : ` at line ${start.line}, column ${start.col}`;
}

function schemaIssue(message: string): ParsedQuestionBankYaml {
  return {
    issues: [{ path: "/", code: "schema", message }],
  };
}

function preScanQuestionBankYaml(source: string): string | null {
  const lines = source.split(/\r?\n/u);
  if (lines.length > MAX_YAML_LINES) {
    return `YAML source exceeds ${MAX_YAML_LINES} lines`;
  }

  let tokenCount = 0;
  let collectionEntryCount = 0;
  let column = 0;
  let lineIndent = 0;
  let linePrepared = false;
  let blockKeyStart: number | null = null;
  const flowCollections: string[] = [];
  const blockCollections: Array<{ readonly indent: number; readonly type: "map" | "seq" }> = [];

  const depthExceeded = () => blockCollections.length + flowCollections.length > MAX_YAML_DEPTH;
  const prepareBlockLine = () => {
    if (linePrepared) {
      return;
    }
    while (blockCollections.length > 0 && (blockCollections.at(-1)?.indent ?? -1) > lineIndent) {
      blockCollections.pop();
    }
    linePrepared = true;
  };
  const openBlockCollection = (indent: number, type: "map" | "seq") => {
    prepareBlockLine();
    const existingIndex = blockCollections.findIndex((collection) => collection.indent === indent);
    if (existingIndex >= 0) {
      if (blockCollections[existingIndex]?.type === type) {
        blockCollections.splice(existingIndex + 1);
        return;
      }
      blockCollections.splice(existingIndex);
    } else {
      const deeperIndex = blockCollections.findIndex((collection) => collection.indent > indent);
      if (deeperIndex >= 0) {
        blockCollections.splice(deeperIndex);
      }
    }
    blockCollections.push({ indent, type });
  };

  try {
    for (const lexeme of new Lexer().lex(source)) {
      tokenCount += 1;
      if (tokenCount > MAX_YAML_TOKENS) {
        return `YAML source exceeds ${MAX_YAML_TOKENS} lexical tokens`;
      }
      if (lexeme.length > MAX_SCALAR_LENGTH) {
        return `YAML scalar exceeds ${MAX_SCALAR_LENGTH} characters`;
      }

      const tokenType = CST.tokenType(lexeme);
      if (tokenType === "newline") {
        column = 0;
        lineIndent = 0;
        linePrepared = false;
        blockKeyStart = null;
        continue;
      }
      if (tokenType === "space") {
        if (column === 0) {
          lineIndent = lexeme.length;
        }
        column += lexeme.length;
        continue;
      }
      if (tokenType === "anchor" || tokenType === "alias") {
        return "YAML anchors and aliases are not allowed";
      }
      if (tokenType === "tag") {
        return "Explicit YAML tags are not allowed";
      }
      if (
        tokenType === "map-value-ind" ||
        tokenType === "seq-item-ind" ||
        tokenType === "flow-map-start" ||
        tokenType === "flow-seq-start" ||
        tokenType === "comma"
      ) {
        collectionEntryCount += 1;
        if (collectionEntryCount > MAX_YAML_COLLECTION_ENTRIES) {
          return `YAML source exceeds ${MAX_YAML_COLLECTION_ENTRIES} collection entries`;
        }
      }

      if (tokenType === "flow-map-start" || tokenType === "flow-seq-start") {
        prepareBlockLine();
        flowCollections.push(tokenType);
        if (depthExceeded()) {
          return `YAML structure exceeds depth ${MAX_YAML_DEPTH}`;
        }
      } else if (tokenType === "flow-map-end" || tokenType === "flow-seq-end") {
        flowCollections.pop();
      } else if (flowCollections.length === 0 && tokenType === "seq-item-ind") {
        openBlockCollection(column, "seq");
        blockKeyStart = null;
        if (depthExceeded()) {
          return `YAML structure exceeds depth ${MAX_YAML_DEPTH}`;
        }
      } else if (flowCollections.length === 0 && tokenType === "map-value-ind") {
        openBlockCollection(blockKeyStart ?? lineIndent, "map");
        blockKeyStart = null;
        if (depthExceeded()) {
          return `YAML structure exceeds depth ${MAX_YAML_DEPTH}`;
        }
      } else if (
        flowCollections.length === 0 &&
        blockKeyStart === null &&
        tokenType !== "doc-mode" &&
        tokenType !== "scalar"
      ) {
        blockKeyStart = column;
      }

      if (tokenType !== "doc-mode" && tokenType !== "scalar") {
        column += lexeme.length;
      }
    }
  } catch {
    return "YAML source could not be scanned safely";
  }
  return null;
}

export function parseQuestionBankYaml(
  source: string,
  parseDocuments: ParseAllDocuments = parseAllDocuments,
): ParsedQuestionBankYaml {
  if (Buffer.byteLength(source, "utf8") > MAX_FILE_BYTES) {
    return schemaIssue(`YAML file exceeds the ${MAX_FILE_BYTES}-byte audit limit`);
  }

  const unsafeReason = preScanQuestionBankYaml(source);
  if (unsafeReason !== null) {
    return schemaIssue(unsafeReason);
  }

  const lineCounter = new LineCounter();
  const documents = parseDocuments(source, {
    lineCounter,
    merge: false,
    prettyErrors: false,
    schema: "core",
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
  });
  if (documents.length !== 1) {
    return {
      issues: [
        {
          path: "/",
          code: "schema",
          message: "Each YAML file must contain exactly one document",
        },
      ],
    };
  }

  const document = documents[0];
  if (document === undefined) {
    return {
      issues: [{ path: "/", code: "schema", message: "YAML document is missing" }],
    };
  }
  const parseProblems = [...document.errors, ...document.warnings];
  if (parseProblems.length > 0) {
    return {
      issues: parseProblems.map((error) => ({
        path: "/",
        code: "schema" as const,
        message: `YAML parse error (${error.code})${yamlPosition(error)}`,
      })),
    };
  }

  let nodeCount = 0;
  let nodeSafetyIssue: string | null = null;
  visit(document, {
    Node(_key, node, path) {
      nodeCount += 1;
      if (nodeCount > MAX_YAML_NODES) {
        nodeSafetyIssue = `YAML structure exceeds ${MAX_YAML_NODES} nodes`;
        return visit.BREAK;
      }
      if (path.length > MAX_YAML_DEPTH) {
        nodeSafetyIssue = `YAML structure exceeds depth ${MAX_YAML_DEPTH}`;
        return visit.BREAK;
      }
      if (isAlias(node) || node.anchor !== undefined) {
        nodeSafetyIssue = "YAML anchors and aliases are not allowed";
        return visit.BREAK;
      }
      if (node.tag !== undefined) {
        nodeSafetyIssue = "Explicit YAML tags are not allowed";
        return visit.BREAK;
      }
      if (
        isScalar(node) &&
        typeof node.value === "string" &&
        node.value.length > MAX_SCALAR_LENGTH
      ) {
        nodeSafetyIssue = `YAML scalar exceeds ${MAX_SCALAR_LENGTH} characters`;
        return visit.BREAK;
      }
      return undefined;
    },
    Pair(_key, pair) {
      if (
        isScalar(pair.key) &&
        typeof pair.key.value === "string" &&
        UNSAFE_MAPPING_KEYS.has(pair.key.value)
      ) {
        nodeSafetyIssue = `Unsafe YAML mapping key ${pair.key.value} is not allowed`;
        return visit.BREAK;
      }
      return undefined;
    },
  });
  if (nodeSafetyIssue !== null) {
    return schemaIssue(nodeSafetyIssue);
  }

  try {
    return { value: document.toJS({ maxAliasCount: 0 }), issues: [] };
  } catch {
    return {
      issues: [
        {
          path: "/",
          code: "schema",
          message: "YAML document could not be converted safely",
        },
      ],
    };
  }
}

async function readQuestionBankYamlFile(
  file: string,
): Promise<
  | { readonly source: string; readonly issue?: never }
  | { readonly source?: never; readonly issue: string }
> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      return { issue: "Question-bank YAML path is not a regular file" };
    }
    if (metadata.size > MAX_FILE_BYTES) {
      return { issue: `YAML file exceeds the ${MAX_FILE_BYTES}-byte audit limit` };
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_FILE_BYTES) {
      const remaining = MAX_FILE_BYTES + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_FILE_BYTES) {
      return { issue: `YAML file exceeds the ${MAX_FILE_BYTES}-byte audit limit` };
    }
    try {
      return {
        source: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, totalBytes)),
      };
    } catch {
      return { issue: "Question-bank YAML file must contain valid UTF-8" };
    }
  } catch {
    return { issue: "Question-bank YAML file could not be read safely" };
  } finally {
    await handle?.close();
  }
}

function questionIdAtPath(value: unknown, path: string): string | undefined {
  const indexMatch = /^\/questions\/(\d+)(?:\/|$)/u.exec(path);
  if (indexMatch === null) {
    return undefined;
  }
  const index = Number(indexMatch[1]);
  const questions = record(value)?.questions;
  const question = Array.isArray(questions) ? record(questions[index]) : null;
  const id = question?.id;
  return typeof id === "string" ? id : undefined;
}

function relativeFile(root: string, file: string): string {
  const path = relative(root, file);
  return path.length === 0 ? "." : normalizeQuestionBankSourcePath(path);
}

async function discoverYamlFiles(root: string): Promise<{
  readonly files: readonly string[];
  readonly issues: readonly QuestionBankFileIssue[];
}> {
  const files: string[] = [];
  const issues: QuestionBankFileIssue[] = [];
  let fileLimitReached = false;

  async function walk(directory: string, depth: number): Promise<void> {
    if (fileLimitReached) {
      return;
    }
    if (depth > MAX_DIRECTORY_DEPTH) {
      issues.push({
        file: relativeFile(root, directory),
        path: "/",
        code: "schema",
        message: `Directory nesting exceeds depth ${MAX_DIRECTORY_DEPTH}`,
      });
      return;
    }

    let entries: Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      const code = record(error)?.code;
      if (depth === 0 && code === "ENOENT") {
        issues.push({
          file: ".",
          path: "/",
          code: "schema",
          message: "Question-bank root does not exist",
        });
        return;
      }
      issues.push({
        file: relativeFile(root, directory),
        path: "/",
        code: "schema",
        message: "Question-bank directory could not be read",
      });
      return;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        issues.push({
          file: relativeFile(root, path),
          path: "/",
          code: "schema",
          message: "Symbolic links are not allowed in the question bank",
        });
      } else if (entry.isDirectory()) {
        await walk(path, depth + 1);
      } else if (entry.isFile() && /\.ya?ml$/iu.test(entry.name)) {
        if (files.length === MAX_FILES) {
          issues.push({
            file: ".",
            path: "/",
            code: "schema",
            message: `Question bank exceeds ${MAX_FILES} YAML files`,
          });
          fileLimitReached = true;
          return;
        }
        files.push(path);
      }
    }
  }

  await walk(root, 0);
  return { files, issues };
}

export async function loadQuestionBankDirectory(
  rootInput: string,
): Promise<QuestionBankLoadResult> {
  const root = resolve(rootInput);
  const discovery = await discoverYamlFiles(root);
  const issues: QuestionBankFileIssue[] = [...discovery.issues];
  const loadedFiles: LoadedQuestionBankFile[] = [];
  const versions = new Map<string, { readonly file: string; readonly questionId: string }>();
  let questionCount = 0;
  let activeReviewedCount = 0;

  for (const file of discovery.files) {
    const fileName = relativeFile(root, file);
    const boundedRead = await readQuestionBankYamlFile(file);
    if (boundedRead.issue !== undefined) {
      issues.push({
        file: fileName,
        path: "/",
        code: "schema",
        message: boundedRead.issue,
      });
      continue;
    }

    const parsed = parseQuestionBankYaml(boundedRead.source);
    for (const issue of parsed.issues) {
      issues.push({ ...issue, file: fileName });
    }
    if (parsed.value === undefined || parsed.issues.length > 0) {
      continue;
    }

    const sourceRecord = record(parsed.value);
    if (sourceRecord?.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
      issues.push({
        file: fileName,
        path: "/schemaVersion",
        code: "schema",
        message: `Unsupported schemaVersion; expected ${SUPPORTED_SCHEMA_VERSION}`,
      });
    }

    for (const issue of validateQuestionBankSource(parsed.value)) {
      if (
        issue.path === "/schemaVersion" &&
        sourceRecord?.schemaVersion !== SUPPORTED_SCHEMA_VERSION
      ) {
        continue;
      }
      const questionId = questionIdAtPath(parsed.value, issue.path);
      issues.push(
        questionId === undefined
          ? { ...issue, file: fileName }
          : { ...issue, file: fileName, questionId },
      );
    }
    if (!Check(QuestionBankSourceSchema, parsed.value)) {
      continue;
    }

    const bankSource = parsed.value as QuestionBankSourceDto;
    const domainDirectory = fileName.split(/[\\/]/u)[0];
    if (domainDirectory !== bankSource.domain) {
      issues.push({
        file: fileName,
        path: "/domain",
        code: "domain_mismatch",
        message: `File domain ${bankSource.domain} must match directory ${domainDirectory ?? "."}`,
      });
    }
    questionCount += bankSource.questions.length;
    activeReviewedCount += bankSource.questions.filter(
      (question) => question.active && question.reviewed,
    ).length;
    bankSource.questions.forEach((question, index) => {
      const key = `${question.id}\0${question.contentVersion}`;
      const previous = versions.get(key);
      if (previous !== undefined) {
        issues.push({
          file: fileName,
          questionId: question.id,
          path: `/questions/${index}/contentVersion`,
          code: "duplicate_question_version",
          message: `Question ${question.id} contentVersion ${question.contentVersion} duplicates ${previous.file}`,
        });
      } else {
        versions.set(key, { file: fileName, questionId: question.id });
      }
    });
    loadedFiles.push({
      file: fileName,
      schemaVersion: bankSource.schemaVersion,
      questions: bankSource.questions,
    });
  }

  return {
    valid: issues.length === 0,
    root,
    fileCount: discovery.files.length,
    questionCount,
    activeReviewedCount,
    issues,
    files: loadedFiles,
  };
}

export async function validateQuestionBankDirectory(
  rootInput: string,
): Promise<QuestionBankValidationResult> {
  const { files: _files, ...result } = await loadQuestionBankDirectory(rootInput);
  return result;
}

function parseCliOptions(args: readonly string[]): CliOptions {
  let root = resolve("question-bank");
  let help = false;
  let mode: CliOptions["mode"] = "development";
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
    } else if (argument === "--mode") {
      const value = args[index + 1];
      if (value !== "development" && value !== "release") {
        throw new Error("--mode must be development or release");
      }
      mode = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { root, help, mode };
}

const usage = `Usage: pnpm question-bank:validate [--root <directory>] [--mode development|release]

Development mode validates YAML format and semantics without cardinality requirements.
Release mode additionally requires 90 active reviewed questions, at least 15 per domain, and one active version per stable question ID.`;

function releaseValidationIssues(result: QuestionBankLoadResult): QuestionBankFileIssue[] {
  const issues: QuestionBankFileIssue[] = [];
  const domainCounts = new Map<string, number>();
  const questionsById = new Map<
    string,
    Array<{
      readonly file: string;
      readonly index: number;
      readonly question: QuestionBankSourceDto["questions"][number];
    }>
  >();

  for (const file of result.files) {
    file.questions.forEach((question, index) => {
      const versions = questionsById.get(question.id) ?? [];
      versions.push({ file: file.file, index, question });
      questionsById.set(question.id, versions);
    });
  }

  let currentActiveReviewedCount = 0;
  for (const [questionId, versions] of questionsById) {
    versions.sort((left, right) => left.question.contentVersion - right.question.contentVersion);
    const current = versions.at(-1);
    if (current === undefined) {
      continue;
    }
    const activeVersions = versions.filter((version) => version.question.active);
    for (const duplicate of activeVersions.slice(1)) {
      const previous = activeVersions[0];
      if (previous !== undefined) {
        issues.push({
          file: duplicate.file,
          questionId,
          path: `/questions/${duplicate.index}/id`,
          code: "duplicate_active_question_id",
          message: `Active question ID ${questionId} duplicates ${previous.file} /questions/${previous.index}`,
        });
      }
    }
    for (const stale of activeVersions.filter((version) => version !== current)) {
      issues.push({
        file: stale.file,
        questionId,
        path: `/questions/${stale.index}/active`,
        code: "stale_active_question_version",
        message: `Active question ${questionId}@${stale.question.contentVersion} is superseded by version ${current.question.contentVersion}`,
      });
    }
    if (current.question.active && current.question.reviewed) {
      currentActiveReviewedCount += 1;
      domainCounts.set(
        current.question.domain,
        (domainCounts.get(current.question.domain) ?? 0) + 1,
      );
    }
  }

  if (currentActiveReviewedCount < 90) {
    issues.push({
      file: ".",
      path: "/questions",
      code: "release_cardinality",
      message: `Release question bank requires at least 90 current active reviewed questions; found ${currentActiveReviewedCount}`,
    });
  }
  for (const domain of [
    "go_language",
    "concurrency_runtime_performance",
    "http_rpc_api",
    "database_storage",
    "cache_messaging_distributed",
    "testing_observability_engineering",
  ]) {
    const count = domainCounts.get(domain) ?? 0;
    if (count < 15) {
      issues.push({
        file: domain,
        path: "/questions",
        code: "release_cardinality",
        message: `Release domain ${domain} requires at least 15 active reviewed questions; found ${count}`,
      });
    }
  }
  return issues;
}

export async function runQuestionBankCli(
  args: readonly string[],
  io: CliIo = {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  },
): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliOptions(args);
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
  const issues =
    loaded.valid && options.mode === "release"
      ? [...loaded.issues, ...releaseValidationIssues(loaded)]
      : loaded.issues;
  if (issues.length > 0) {
    for (const issue of issues) {
      const question = issue.questionId === undefined ? "" : ` [question ${issue.questionId}]`;
      io.stderr(`${issue.file}${question} ${issue.path} (${issue.code}): ${issue.message}`);
    }
    io.stderr(
      `Question-bank validation failed with ${issues.length} error(s) across ${loaded.fileCount} YAML file(s).`,
    );
    return 1;
  }

  io.stdout(
    `Question bank is valid in ${options.mode} mode: ${loaded.fileCount} file(s), ${loaded.questionCount} question(s), ${loaded.activeReviewedCount} active reviewed.`,
  );
  return 0;
}

const mainPath = process.argv[1];
if (mainPath !== undefined && pathToFileURL(resolve(mainPath)).href === import.meta.url) {
  process.exitCode = await runQuestionBankCli(process.argv.slice(2));
}
