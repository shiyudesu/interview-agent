import { describe, expect, it } from "vitest";

import {
  InvalidIdentifierError,
  InvalidQuestionScoreError,
  isSupportedQuestionCount,
  isTerminalInterviewStatus,
  parseAccountId,
  parseInterviewId,
  parsePositiveQuestionScore,
} from "../src/index.js";

describe("domain identifiers", () => {
  it("accepts stable identifier characters without changing the value", () => {
    expect(parseInterviewId("interview_01:J7-x")).toBe("interview_01:J7-x");
  });

  it.each(["", " interview-1", "interview/1", "a".repeat(129)])(
    "rejects invalid identifier %j",
    (value) => {
      expect(() => parseAccountId(value)).toThrow(InvalidIdentifierError);
    },
  );
});

describe("interview primitives", () => {
  it.each([5, 10, 15])("accepts supported question count %i", (questionCount) => {
    expect(isSupportedQuestionCount(questionCount)).toBe(true);
  });

  it("rejects unsupported question counts", () => {
    expect(isSupportedQuestionCount(8)).toBe(false);
  });

  it.each(["completed", "early_ended", "abandoned", "deleting"] as const)(
    "recognizes terminal status %s",
    (status) => {
      expect(isTerminalInterviewStatus(status)).toBe(true);
    },
  );

  it("keeps report-pending non-terminal", () => {
    expect(isTerminalInterviewStatus("report_pending")).toBe(false);
  });

  it.each([1, 50, 100])("accepts positive question score %i", (score) => {
    expect(parsePositiveQuestionScore(score)).toBe(score);
  });

  it.each([0, 1.5, 101])("rejects invalid positive question score %i", (score) => {
    expect(() => parsePositiveQuestionScore(score)).toThrow(InvalidQuestionScoreError);
  });
});
