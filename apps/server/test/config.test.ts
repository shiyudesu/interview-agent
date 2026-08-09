import { describe, expect, it } from "vitest";

import { ConfigurationError, loadServerConfig } from "../src/config.js";

const validEnvironment = {
  DATABASE_URL: "postgresql://interview:interview@localhost:5432/interview",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:3000",
  MODEL_PROVIDER: "faux",
  MODEL_ID: "test-model",
} as const;

describe("loadServerConfig", () => {
  it("loads required values and applies local defaults", () => {
    expect(loadServerConfig(validEnvironment)).toEqual({
      environment: "development",
      host: "0.0.0.0",
      port: 3000,
      databaseUrl: validEnvironment.DATABASE_URL,
      auth: {
        secret: validEnvironment.BETTER_AUTH_SECRET,
        baseUrl: validEnvironment.BETTER_AUTH_URL,
      },
      model: {
        provider: "faux",
        id: "test-model",
      },
      logLevel: "info",
      telemetry: {},
    });
  });

  it("rejects missing required settings without exposing values", () => {
    expect(() => loadServerConfig({})).toThrow(ConfigurationError);
    expect(() => loadServerConfig({})).toThrow("/DATABASE_URL");
  });

  it("rejects ports outside the TCP range", () => {
    expect(() => loadServerConfig({ ...validEnvironment, PORT: "65536" })).toThrow(
      "/PORT must be between 1 and 65535",
    );
  });

  it("requires both GitHub OAuth settings", () => {
    expect(() => loadServerConfig({ ...validEnvironment, GITHUB_CLIENT_ID: "client-id" })).toThrow(
      "/GITHUB_CLIENT_ID and /GITHUB_CLIENT_SECRET must be configured together",
    );
  });
});
