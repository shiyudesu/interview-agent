import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const domainRoot = resolve(repositoryRoot, "packages/domain");
const forbiddenImports = [
  "@interview-agent/contracts",
  "@fastify",
  "@sinclair/typebox",
  "typebox",
  "fastify",
  "drizzle",
  "pi-ai",
  "@mariozechner/pi",
  "better-auth",
];
const browserGlobals = new Set([
  "document",
  "window",
  "navigator",
  "fetch",
  "WebSocket",
  "EventSource",
  "localStorage",
  "sessionStorage",
  "indexedDB",
]);

async function domainSourceFiles(
  directory = resolve(domainRoot, "src"),
): Promise<readonly string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await domainSourceFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

function importSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  const staticImport = /\b(?:import|export)\s+(?:type\s+)?(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/gs;
  const dynamicImport = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(staticImport)) {
    if (match[1] !== undefined) {
      specifiers.push(match[1]);
    }
  }
  for (const match of source.matchAll(dynamicImport)) {
    if (match[1] !== undefined) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function codeWithoutCommentsAndStrings(source: string): string {
  let result = "";
  let index = 0;
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (current === "/" && next === "/") {
      const end = source.indexOf("\n", index + 2);
      index = end === -1 ? source.length : end;
      result += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      result += " ";
      continue;
    }
    if (current === '"' || current === "'" || current === "`") {
      const quote = current;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      result += " ";
      continue;
    }
    result += current;
    index += 1;
  }
  return result;
}

function usedBrowserGlobals(source: string): readonly string[] {
  const code = codeWithoutCommentsAndStrings(source);
  return [...browserGlobals].filter((name) => new RegExp(`\\b${name}\\b`, "u").test(code));
}

describe("domain architecture boundary", () => {
  it("declares no runtime dependencies", async () => {
    const manifest = JSON.parse(await readFile(resolve(domainRoot, "package.json"), "utf8"));
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      expect(manifest[field] ?? {}, field).toEqual({});
    }
  });

  it("imports no contracts or infrastructure and uses no browser globals", async () => {
    const violations: string[] = [];
    for (const file of await domainSourceFiles()) {
      const source = await readFile(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (
          forbiddenImports.some(
            (forbidden) =>
              specifier === forbidden ||
              specifier.startsWith(`${forbidden}/`) ||
              specifier.startsWith(`${forbidden}-`),
          )
        ) {
          violations.push(`${file}: forbidden import ${specifier}`);
        }
      }
      for (const browserGlobal of usedBrowserGlobals(source)) {
        violations.push(`${file}: forbidden browser global ${browserGlobal}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
