import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { parseDocument } from "yaml";

const ROOT = resolve(".");
const CHANGE_ROOT = resolve("openspec/changes/build-interview-mvp");
const SPECS_ROOT = resolve(CHANGE_ROOT, "specs");
const COVERAGE_PATH = resolve(CHANGE_ROOT, "scenario-coverage.yaml");
const SCENARIO_PATTERN = /^#### Scenario: (.+)$/gmu;

interface SpecScenario {
  readonly capability: string;
  readonly scenario: string;
}

interface CoverageEntry {
  readonly capability: string;
  readonly scenario: string;
  readonly coverage:
    | {
        readonly kind: "automated";
        readonly tests: readonly string[];
        readonly evidence: string;
      }
    | {
        readonly kind: "manual";
        readonly steps: readonly string[];
        readonly expected: string;
      };
}

async function loadSpecScenarios(): Promise<readonly SpecScenario[]> {
  const capabilities = (await readdir(SPECS_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const scenarios: SpecScenario[] = [];
  for (const capability of capabilities) {
    const source = await readFile(resolve(SPECS_ROOT, capability, "spec.md"), "utf8");
    for (const match of source.matchAll(SCENARIO_PATTERN)) {
      const scenario = match[1]?.trim();
      if (scenario === undefined || scenario.length === 0) {
        throw new Error(`Empty Scenario heading in ${capability}`);
      }
      scenarios.push({ capability, scenario });
    }
  }
  return scenarios;
}

async function loadCoverageEntries(): Promise<readonly CoverageEntry[]> {
  const document = parseDocument(await readFile(COVERAGE_PATH, "utf8"), {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(document.errors.map(({ message }) => message).join("\n"));
  }
  const source: unknown = document.toJS({ maxAliasCount: 0 });
  const root = record(source, "coverage root");
  if (root["schemaVersion"] !== "1.0" || root["change"] !== "build-interview-mvp") {
    throw new Error("Scenario coverage metadata is invalid");
  }
  if (!Array.isArray(root["scenarios"])) {
    throw new Error("Scenario coverage entries must be an array");
  }
  return await Promise.all(root["scenarios"].map(parseCoverageEntry));
}

async function parseCoverageEntry(value: unknown, index: number): Promise<CoverageEntry> {
  const entry = record(value, `scenario coverage ${index + 1}`);
  const capability = nonBlankString(entry["capability"], "capability");
  const scenario = nonBlankString(entry["scenario"], "scenario");
  const coverage = record(entry["coverage"], "coverage");
  if (coverage["kind"] === "automated") {
    if (!Array.isArray(coverage["tests"]) || coverage["tests"].length === 0) {
      throw new Error(`${capability}/${scenario} has no automated test references`);
    }
    const tests = await Promise.all(
      coverage["tests"].map(async (candidate) => {
        const path = nonBlankString(candidate, "test path");
        await validateTestPath(path);
        return path;
      }),
    );
    return {
      capability,
      scenario,
      coverage: {
        kind: "automated",
        tests,
        evidence: nonBlankString(coverage["evidence"], "automated evidence"),
      },
    };
  }
  if (coverage["kind"] === "manual") {
    if (!Array.isArray(coverage["steps"]) || coverage["steps"].length < 2) {
      throw new Error(`${capability}/${scenario} requires at least two manual steps`);
    }
    return {
      capability,
      scenario,
      coverage: {
        kind: "manual",
        steps: coverage["steps"].map((step) => nonBlankString(step, "manual step")),
        expected: nonBlankString(coverage["expected"], "manual expected result"),
      },
    };
  }
  throw new Error(`${capability}/${scenario} has an unsupported coverage kind`);
}

async function validateTestPath(path: string): Promise<void> {
  const absolute = resolve(ROOT, path);
  if (!absolute.startsWith(`${ROOT}${sep}`)) {
    throw new Error(`Test path escapes the repository: ${path}`);
  }
  if (!path.includes("/test/") && !path.includes("/e2e/") && !path.startsWith("test/")) {
    throw new Error(`Automated evidence is not a test path: ${path}`);
  }
  const metadata = await stat(absolute).catch(() => null);
  if (metadata === null || !metadata.isFile()) {
    throw new Error(`Automated evidence does not exist: ${path}`);
  }
}

function validateExactCoverage(
  specs: readonly SpecScenario[],
  entries: readonly CoverageEntry[],
): void {
  const expected = new Map(specs.map((entry) => [key(entry), entry]));
  const actual = new Map<string, CoverageEntry>();
  for (const entry of entries) {
    const entryKey = key(entry);
    if (actual.has(entryKey)) {
      throw new Error(`Duplicate scenario coverage: ${entry.capability}/${entry.scenario}`);
    }
    actual.set(entryKey, entry);
  }
  const missing = [...expected].filter(([entryKey]) => !actual.has(entryKey));
  const extra = [...actual].filter(([entryKey]) => !expected.has(entryKey));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      [
        ...missing.map(([, entry]) => `Missing: ${entry.capability}/${entry.scenario}`),
        ...extra.map(([, entry]) => `Extra: ${entry.capability}/${entry.scenario}`),
      ].join("\n"),
    );
  }
}

function key(value: { readonly capability: string; readonly scenario: string }): string {
  return `${value.capability}\0${value.scenario}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonBlankString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-blank string`);
  }
  return value.trim();
}

const specs = await loadSpecScenarios();
const entries = await loadCoverageEntries();
validateExactCoverage(specs, entries);
const automated = entries.filter(({ coverage }) => coverage.kind === "automated").length;
const manual = entries.length - automated;
console.log(
  `Scenario coverage valid: ${entries.length} total, ${automated} automated, ${manual} manual.`,
);
