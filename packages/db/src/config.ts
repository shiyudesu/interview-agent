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
