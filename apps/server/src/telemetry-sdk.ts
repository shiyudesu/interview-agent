import type { RequestOptions } from "node:http";
import type { NodeSDK } from "@opentelemetry/sdk-node";

import { otlpTraceEndpoint, shouldIgnoreHttpUrl } from "./telemetry.js";

export const TELEMETRY_INSTRUMENTATION_NAMES = [
  "@opentelemetry/instrumentation-http",
  "@opentelemetry/instrumentation-pg",
] as const;

const REQUIRED_INSTRUMENTATIONS = new Set<string>(TELEMETRY_INSTRUMENTATION_NAMES);

async function createTelemetryInstrumentations(endpoint: string) {
  const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node");
  const traceEndpoint = new URL(otlpTraceEndpoint(endpoint));
  const instrumentations = getNodeAutoInstrumentations({
    "@opentelemetry/instrumentation-http": {
      enabled: true,
      ignoreIncomingRequestHook: (request) => shouldIgnoreHttpUrl(request.url),
      ignoreOutgoingRequestHook: (request) =>
        shouldIgnoreHttpUrl(request.path) || isOtlpExportRequest(request, traceEndpoint),
    },
    "@opentelemetry/instrumentation-pg": {
      enabled: true,
      enhancedDatabaseReporting: false,
      addSqlCommenterCommentToQueries: false,
      enableTraceContextPropagation: false,
    },
  });
  return instrumentations.filter((instrumentation) => {
    const required = REQUIRED_INSTRUMENTATIONS.has(instrumentation.instrumentationName);
    if (!required) {
      instrumentation.disable();
    }
    return required;
  });
}

export async function createTelemetrySdk(endpoint: string): Promise<NodeSDK> {
  const instrumentations = await createTelemetryInstrumentations(endpoint);
  const [{ OTLPTraceExporter }, { NodeSDK }] = await Promise.all([
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/sdk-node"),
  ]);
  return new NodeSDK({
    autoDetectResources: false,
    serviceName: "interview-agent-server",
    logRecordProcessors: [],
    metricReaders: [],
    traceExporter: new OTLPTraceExporter({
      url: otlpTraceEndpoint(endpoint),
      headers: {},
    }),
    instrumentations,
  });
}

function isOtlpExportRequest(request: RequestOptions, endpoint: URL): boolean {
  const hostname = request.hostname ?? hostWithoutPort(request.host);
  const port = String(
    request.port ?? (request.protocol === "https:" || endpoint.protocol === "https:" ? 443 : 80),
  );
  const path = typeof request.path === "string" ? request.path : "/";
  return (
    request.protocol === endpoint.protocol &&
    hostname === endpoint.hostname &&
    port === effectivePort(endpoint) &&
    path === `${endpoint.pathname}${endpoint.search}`
  );
}

function hostWithoutPort(host: string | null | undefined): string | undefined {
  if (host === null || host === undefined) {
    return undefined;
  }
  return host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : (host.split(":")[0] ?? undefined);
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}
