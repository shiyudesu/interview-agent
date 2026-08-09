import { defineConfig } from "vitest/config";

export function createVitestConfig(environment: "jsdom" | "node") {
  return defineConfig({
    test: {
      clearMocks: true,
      environment,
      passWithNoTests: true,
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
