export type DatabaseToolchainModules = {
  readonly drizzle: typeof import("drizzle-orm");
  readonly postgres: typeof import("pg");
  readonly testcontainers: typeof import("testcontainers");
};
