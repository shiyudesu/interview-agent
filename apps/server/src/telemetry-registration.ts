import type { NodeSDK } from "@opentelemetry/sdk-node";

import { validateOtlpEndpoint } from "./telemetry.js";

let telemetrySdk: NodeSDK | null = null;
let shutdownPromise: Promise<void> | null = null;

const endpoint = validateOtlpEndpoint(process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]);
if (endpoint !== undefined) {
  const { createTelemetrySdk } = await import("./telemetry-sdk.js");
  telemetrySdk = await createTelemetrySdk(endpoint);
  telemetrySdk.start();
}

export function shutdownTelemetry(): Promise<void> {
  if (telemetrySdk === null) {
    return Promise.resolve();
  }
  shutdownPromise ??= telemetrySdk.shutdown();
  return shutdownPromise;
}
