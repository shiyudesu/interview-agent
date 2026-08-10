import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const rootEnvironmentFile = fileURLToPath(new URL("../../../.env", import.meta.url));

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function loadDatabaseEnvironment(environmentFile = rootEnvironmentFile): void {
  try {
    loadEnvFile(environmentFile);
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }

    throw new Error("Unable to load the database environment file.", { cause: error });
  }
}

export function requireDatabaseUrl(
  environment: Readonly<
    Record<string, string | undefined> & {
      DATABASE_URL?: string;
    }
  > = process.env,
): string {
  const databaseUrl = environment.DATABASE_URL?.trim();

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required for database migration and Drizzle schema generation.",
    );
  }

  return databaseUrl;
}

export function requirePurgeAuditHashSecret(
  environment: Readonly<
    Record<string, string | undefined> & {
      PURGE_AUDIT_HASH_SECRET?: string;
    }
  > = process.env,
): string {
  const secret = environment.PURGE_AUDIT_HASH_SECRET ?? "";
  if (secret.length < 32) {
    throw new Error("PURGE_AUDIT_HASH_SECRET must contain at least 32 characters.");
  }
  return secret;
}

export function readBoundedIntegerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = environment[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}
