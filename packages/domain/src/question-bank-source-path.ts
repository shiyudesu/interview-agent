export function normalizeQuestionBankSourcePath(sourcePath: string): string {
  const slashPath = sourcePath.replaceAll("\\", "/");
  if (
    slashPath.length === 0 ||
    slashPath.includes("\0") ||
    slashPath.startsWith("/") ||
    slashPath.startsWith("//") ||
    /^[A-Za-z]:/u.test(slashPath)
  ) {
    throw new TypeError("Question-bank source path must be root-relative");
  }

  const segments: string[] = [];
  for (const segment of slashPath.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        throw new TypeError("Question-bank source path escapes its root");
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    return ".";
  }
  return segments.join("/");
}
