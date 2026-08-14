import { describe, expect, it } from "vitest";

import {
  modelTelemetryAttributes,
  operationTelemetryAttributes,
  otlpTraceEndpoint,
  shouldIgnoreHttpUrl,
  TelemetryConfigurationError,
  validateOtlpEndpoint,
} from "../src/telemetry.js";
import { TELEMETRY_INSTRUMENTATION_NAMES } from "../src/telemetry-sdk.js";

describe("telemetry configuration", () => {
  it("keeps telemetry disabled when no OTLP endpoint is configured", () => {
    expect(validateOtlpEndpoint(undefined)).toBeUndefined();
  });

  it("builds the standard trace export endpoint", () => {
    expect(otlpTraceEndpoint("https://telemetry.example.test/collector")).toBe(
      "https://telemetry.example.test/collector/v1/traces",
    );
  });

  it.each([
    "ftp://telemetry.example.test",
    "https://user:secret@telemetry.example.test",
    "https://telemetry.example.test?token=secret",
    "https://telemetry.example.test/#secret",
  ])("rejects unsafe OTLP endpoint %s", (endpoint) => {
    expect(() => validateOtlpEndpoint(endpoint)).toThrow(TelemetryConfigurationError);
  });

  it("enables only HTTP and PostgreSQL automatic instrumentation", () => {
    expect(TELEMETRY_INSTRUMENTATION_NAMES).toEqual([
      "@opentelemetry/instrumentation-http",
      "@opentelemetry/instrumentation-pg",
    ]);
  });

  it("skips HTTP spans whenever a URL contains a query string", () => {
    expect(shouldIgnoreHttpUrl("/api/auth/callback?code=secret")).toBe(true);
    expect(shouldIgnoreHttpUrl("/api/v1/interviews")).toBe(false);
    expect(shouldIgnoreHttpUrl(undefined)).toBe(false);
  });
});

describe("telemetry attribute allowlists", () => {
  it("records Operation identity without account or command payload fields", () => {
    expect(
      operationTelemetryAttributes(
        {
          id: "operation-1",
          interviewId: "interview-1",
          type: "submit_answer",
          expectedVersion: 4,
          attemptCount: 2,
        },
        true,
      ),
    ).toEqual({
      "interview.id": "interview-1",
      "interview.operation.id": "operation-1",
      "interview.operation.type": "submit_answer",
      "interview.operation.expected_version": 4,
      "interview.operation.retry": true,
      "interview.operation.attempt_count": 2,
    });
  });

  it("records only model identity, purpose, and version metadata", () => {
    expect(
      modelTelemetryAttributes({
        provider: "faux",
        modelId: "test-model",
        purpose: "answer_evaluation",
        promptVersion: "answer-evaluation-prompt-v1",
        schemaVersion: "answer-evaluation-schema-v1",
        questionVersion: 3,
      }),
    ).toEqual({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "faux",
      "gen_ai.request.model": "test-model",
      "interview.model.purpose": "answer_evaluation",
      "interview.prompt.version": "answer-evaluation-prompt-v1",
      "interview.schema.version": "answer-evaluation-schema-v1",
      "interview.question.version": 3,
    });
  });
});
