import { createHash } from "node:crypto";

export function questionBankFixtureSourceHash(questionId: string): string {
  return createHash("sha256").update(`question-bank-fixture:${questionId}`).digest("hex");
}
