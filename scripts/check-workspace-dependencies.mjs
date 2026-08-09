import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const workspaceRules = new Map([
  ["apps/server", new Set(["@interview-agent/contracts", "@interview-agent/db", "@interview-agent/domain"])],
  ["apps/web", new Set(["@interview-agent/contracts"])],
  ["packages/contracts", new Set(["@interview-agent/domain"])],
  ["packages/db", new Set(["@interview-agent/domain"])],
  ["packages/domain", new Set()],
]);

const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const runtimeDependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"];
const errors = [];

for (const [workspacePath, allowedDependencies] of workspaceRules) {
  const packageJsonPath = resolve(workspacePath, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const internalDependencies = new Map();

  if (workspacePath === "packages/domain") {
    for (const field of runtimeDependencyFields) {
      for (const name of Object.keys(packageJson[field] ?? {})) {
        errors.push(`packages/domain must not declare runtime dependency ${name}`);
      }
    }
  }

  for (const field of dependencyFields) {
    for (const [name, version] of Object.entries(packageJson[field] ?? {})) {
      if (name.startsWith("@interview-agent/")) {
        internalDependencies.set(name, version);
      }
    }
  }

  for (const [name, version] of internalDependencies) {
    if (!allowedDependencies.has(name)) {
      errors.push(`${workspacePath} must not depend on ${name}`);
    }

    if (typeof version !== "string" || !version.startsWith("workspace:")) {
      errors.push(`${workspacePath} must use the workspace: protocol for ${name}`);
    }
  }

  for (const name of allowedDependencies) {
    if (!internalDependencies.has(name)) {
      errors.push(`${workspacePath} must declare ${name}`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Workspace dependency direction is valid.");
}
