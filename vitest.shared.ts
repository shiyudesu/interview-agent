import { defineConfig } from "vitest/config";

export interface SharedVitestOptions {
  readonly passWithNoTests?: boolean;
}

export function createVitestConfig(
  environment: "jsdom" | "node",
  options: SharedVitestOptions = {},
) {
  return defineConfig({
    test: {
      clearMocks: true,
      environment,
      passWithNoTests: options.passWithNoTests ?? false,
      restoreMocks: true,
      coverage: {
        include: ["src/**/*.{ts,tsx}"],
        provider: "v8",
        reporter: ["text", "json-summary", "html"],
        reportsDirectory: "coverage",
      },
    },
  });
}
