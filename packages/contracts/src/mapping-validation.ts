import type { Static, TSchema } from "typebox";
import { Check, Errors, Parse } from "typebox/value";

import { IsoTimestampSchema } from "./common.js";

export interface ContractMappingIssue {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export class ContractMappingError extends Error {
  constructor(
    readonly mapping: string,
    readonly issues: readonly ContractMappingIssue[],
  ) {
    super(`Invalid ${mapping}`);
    this.name = "ContractMappingError";
  }
}

export class InboundRequestValidationError extends ContractMappingError {
  constructor(mapping: string, issues: readonly ContractMappingIssue[]) {
    super(mapping, issues);
    this.name = "InboundRequestValidationError";
  }
}

function validationIssues<const Schema extends TSchema>(
  schema: Schema,
  value: unknown,
): readonly ContractMappingIssue[] {
  return [...Errors(schema, value)].map((error) => ({
    path: error.instancePath || "/",
    code: error.keyword,
    message: error.message,
  }));
}

export function checkDto<const Schema extends TSchema>(
  schema: Schema,
  value: unknown,
  mapping: string,
): Static<Schema> {
  if (Check(schema, value)) {
    return value;
  }

  throw new ContractMappingError(mapping, validationIssues(schema, value));
}

export function checkInboundRequestDto<const Schema extends TSchema>(
  schema: Schema,
  value: unknown,
  mapping: string,
): Static<Schema> {
  if (Check(schema, value)) {
    return value;
  }

  throw new InboundRequestValidationError(mapping, validationIssues(schema, value));
}

export function parseMappedDto<const Schema extends TSchema>(
  schema: Schema,
  value: unknown,
  mapping: string,
): Static<Schema> {
  try {
    return Parse(schema, value);
  } catch {
    throw new ContractMappingError(mapping, [
      {
        path: "/",
        code: "invalid_domain_value",
        message: `Domain data cannot be serialized as ${mapping}`,
      },
    ]);
  }
}

export function parseIsoTimestamp(value: string, field: string): Date {
  const checked = checkDto(IsoTimestampSchema, value, field);
  const timestamp = new Date(checked);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new ContractMappingError(field, [
      {
        path: `/${field}`,
        code: "invalid_timestamp",
        message: `${field} must be a valid ISO timestamp`,
      },
    ]);
  }
  return timestamp;
}

export function serializeIsoTimestamp(value: Date, field: string): string {
  if (!Number.isFinite(value.getTime())) {
    throw new ContractMappingError(field, [
      {
        path: `/${field}`,
        code: "invalid_timestamp",
        message: `${field} must be a valid date`,
      },
    ]);
  }
  return value.toISOString();
}
