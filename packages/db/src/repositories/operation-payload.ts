import { createHash } from "node:crypto";

import type { JsonObject, JsonValue } from "../schema/interview.js";
import { RepositoryUnsafePayloadError } from "./errors.js";

const MAX_DEPTH = 16;
const MAX_ENTRIES = 2_000;
const MAX_SERIALIZED_BYTES = 256 * 1024;
const forbiddenKeys = new Set([
  "__proto__",
  "accesstoken",
  "apikey",
  "authorization",
  "constructor",
  "cookie",
  "idtoken",
  "otp",
  "password",
  "prototype",
  "refreshtoken",
  "secret",
  "token",
]);

export interface SafeOperationPayload {
  readonly value: JsonObject;
  readonly canonicalJson: string;
  readonly hash: string;
}

export function validateOperationPayload(value: unknown, field: string): SafeOperationPayload {
  const state = { entries: 0 };
  const normalized = normalizeValue(value, field, 0, state);
  if (!isObject(normalized)) {
    throw new RepositoryUnsafePayloadError(field);
  }
  const canonicalJson = canonicalizeJson(normalized);
  if (Buffer.byteLength(canonicalJson, "utf8") > MAX_SERIALIZED_BYTES) {
    throw new RepositoryUnsafePayloadError(field);
  }
  return {
    value: normalized,
    canonicalJson,
    hash: createHash("sha256").update(canonicalJson).digest("hex"),
  };
}

export function hashLeaseToken(token: string): string {
  if (token.trim().length < 16 || token.length > 512) {
    throw new RepositoryOperationLeaseTokenError();
  }
  return createHash("sha256").update(token).digest("hex");
}

export function payloadsEqual(left: unknown, right: SafeOperationPayload): boolean {
  try {
    return validateOperationPayload(left, "payload").hash === right.hash;
  } catch {
    return false;
  }
}

class RepositoryOperationLeaseTokenError extends RepositoryUnsafePayloadError {
  constructor() {
    super("lease token");
    this.name = "RepositoryOperationLeaseTokenError";
  }
}

function normalizeValue(
  value: unknown,
  field: string,
  depth: number,
  state: { entries: number },
): JsonValue {
  if (depth > MAX_DEPTH || state.entries > MAX_ENTRIES) {
    throw new RepositoryUnsafePayloadError(field);
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    state.entries += value.length;
    return value.map((item) => normalizeValue(item, field, depth + 1, state));
  }
  if (!isObject(value)) {
    throw new RepositoryUnsafePayloadError(field);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RepositoryUnsafePayloadError(field);
  }
  const normalized: Record<string, JsonValue> = {};
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  state.entries += entries.length;
  for (const [key, item] of entries) {
    const normalizedKey = key.replaceAll(/[_-]/g, "").toLowerCase();
    if (
      forbiddenKeys.has(normalizedKey) ||
      normalizedKey.endsWith("password") ||
      normalizedKey.endsWith("secret") ||
      normalizedKey.endsWith("token")
    ) {
      throw new RepositoryUnsafePayloadError(field);
    }
    normalized[key] = normalizeValue(item, field, depth + 1, state);
  }
  return normalized;
}

/**
 * Canonical Operation JSON recursively sorts object keys by JavaScript UTF-16 code-unit order,
 * preserves array order, and uses JSON.stringify's primitive encodings. Migration 0004 implements
 * the same byte representation before hashing legacy jsonb inputs.
 */
function canonicalizeJson(value: JsonValue): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new RepositoryUnsafePayloadError("payload");
    }
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  }
  const objectValue = value as JsonObject;
  return `{${Object.keys(objectValue)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(objectValue[key] as JsonValue)}`)
    .join(",")}}`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
