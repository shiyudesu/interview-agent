import { posix } from "node:path";

export function normalizeQuestionBankSourcePath(sourcePath: string): string {
  const slashPath = sourcePath.replaceAll("\\", "/");
  if (
    slashPath.length === 0 ||
    slashPath.includes("\0") ||
    posix.isAbsolute(slashPath) ||
    slashPath.startsWith("//") ||
    /^[A-Za-z]:/u.test(slashPath)
  ) {
    throw new TypeError("Question-bank source path must be root-relative");
  }

  const normalized = posix.normalize(slashPath);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new TypeError("Question-bank source path escapes its root");
  }
  return normalized;
}
