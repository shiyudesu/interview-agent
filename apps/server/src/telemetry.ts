import { type Attributes, type Span, SpanStatusCode, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("interview-agent-server");

export interface OperationTelemetryInput {
  readonly id: string;
  readonly interviewId: string;
  readonly type: string;
  readonly expectedVersion: number;
  readonly attemptCount?: number;
}

export interface ModelTelemetryInput {
  readonly provider: string;
  readonly modelId: string;
  readonly purpose: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly questionVersion: number | null;
}

export interface ModelTelemetryResult {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export class TelemetryConfigurationError extends Error {
  constructor() {
    super(
      "OTEL_EXPORTER_OTLP_ENDPOINT must be an HTTP(S) URL without credentials, query, or fragment",
    );
    this.name = "TelemetryConfigurationError";
  }
}

export function validateOtlpEndpoint(endpoint: string | undefined): string | undefined {
  if (endpoint === undefined) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new TelemetryConfigurationError();
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new TelemetryConfigurationError();
  }
  return endpoint;
}

export function otlpTraceEndpoint(endpoint: string): string {
  validateOtlpEndpoint(endpoint);
  const parsed = new URL(endpoint);
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, "")}/v1/traces`;
  return parsed.toString();
}

export function shouldIgnoreHttpUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && url.includes("?");
}

export function operationTelemetryAttributes(
  operation: OperationTelemetryInput,
  retry: boolean,
): Attributes {
  return {
    "interview.id": operation.interviewId,
    "interview.operation.id": operation.id,
    "interview.operation.type": operation.type,
    "interview.operation.expected_version": operation.expectedVersion,
    "interview.operation.retry": retry,
    ...(operation.attemptCount === undefined
      ? {}
      : { "interview.operation.attempt_count": operation.attemptCount }),
  };
}

export function modelTelemetryAttributes(input: ModelTelemetryInput): Attributes {
  return {
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": input.provider,
    "gen_ai.request.model": input.modelId,
    "interview.model.purpose": input.purpose,
    "interview.prompt.version": input.promptVersion,
    "interview.schema.version": input.schemaVersion,
    ...(input.questionVersion === null
      ? {}
      : { "interview.question.version": input.questionVersion }),
  };
}

export function withTelemetrySpan<Value>(
  name: string,
  attributes: Attributes,
  operation: (span: Span) => Promise<Value>,
): Promise<Value> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await operation(span);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function completeOperationTelemetrySpan(
  span: Span,
  operation: { readonly id: string; readonly type: string; readonly status: string },
  failureIsError: boolean,
): void {
  span.setAttributes({
    "interview.operation.response_id": operation.id,
    "interview.operation.response_type": operation.type,
    "interview.operation.status": operation.status,
  });
  span.setStatus({
    code:
      failureIsError && operation.status === "failed" ? SpanStatusCode.ERROR : SpanStatusCode.OK,
  });
}

export function completeModelTelemetrySpan(
  span: Span,
  result: ModelTelemetryResult,
  input: {
    readonly outcome: "success" | "fallback";
    readonly transientRetries?: number;
    readonly repairAttempted?: boolean;
  },
): void {
  span.setAttributes({
    "interview.model.outcome": input.outcome,
    ...(input.transientRetries === undefined
      ? {}
      : { "interview.model.transient_retry_count": input.transientRetries }),
    ...(input.repairAttempted === undefined
      ? {}
      : { "interview.model.repair_attempted": input.repairAttempted }),
    ...(result.inputTokens === null ? {} : { "gen_ai.usage.input_tokens": result.inputTokens }),
    ...(result.outputTokens === null ? {} : { "gen_ai.usage.output_tokens": result.outputTokens }),
  });
  span.setStatus({ code: SpanStatusCode.OK });
}

export function failModelTelemetrySpan(
  span: Span,
  errorCode: string,
  result: ModelTelemetryResult | null,
  input: {
    readonly transientRetries?: number;
    readonly repairAttempted?: boolean;
  } = {},
): void {
  span.setAttributes({
    "interview.model.error_code": errorCode,
    ...(input.transientRetries === undefined
      ? {}
      : { "interview.model.transient_retry_count": input.transientRetries }),
    ...(input.repairAttempted === undefined
      ? {}
      : { "interview.model.repair_attempted": input.repairAttempted }),
    ...(result?.inputTokens === null || result === null
      ? {}
      : { "gen_ai.usage.input_tokens": result.inputTokens }),
    ...(result?.outputTokens === null || result === null
      ? {}
      : { "gen_ai.usage.output_tokens": result.outputTokens }),
  });
  span.setStatus({ code: SpanStatusCode.ERROR });
}
