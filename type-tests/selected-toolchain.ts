export type RootToolchainModules = {
  readonly playwright: typeof import("@playwright/test");
  readonly vitest: typeof import("vitest");
  readonly vitestConfig: typeof import("vitest/config");
  readonly vitestCoverage: typeof import("@vitest/coverage-v8");
};
