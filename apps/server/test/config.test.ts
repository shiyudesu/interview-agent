import { describe, expect, it } from "vitest";

import { ConfigurationError, loadServerConfig } from "../src/config.js";

const validEnvironment = {
  DATABASE_URL: "postgresql://interview:interview@localhost:5432/interview",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:3000",
  SMTP_HOST: "localhost",
  SMTP_PORT: "1025",
  SMTP_FROM: "interview-agent@example.test",
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
      email: {
        smtpHost: "localhost",
        smtpPort: 1025,
        from: "interview-agent@example.test",
      },
      model: {
        provider: "faux",
        id: "test-model",
      },
      logLevel: "info",
      telemetry: {},
    });
  });

  it("rejects the Faux Provider in production", () => {
    expect(() =>
      loadServerConfig({
        ...validEnvironment,
        NODE_ENV: "production",
      }),
    ).toThrow(ConfigurationError);
  });

  it("requires an API key for a real provider", () => {
    expect(() =>
      loadServerConfig({
        ...validEnvironment,
        MODEL_PROVIDER: "openai",
      }),
    ).toThrow("/MODEL_API_KEY");
  });

  it("propagates real-provider credentials and an optional base URL", () => {
    expect(
      loadServerConfig({
        ...validEnvironment,
        MODEL_PROVIDER: "custom-provider",
        MODEL_API_KEY: "model-secret",
        MODEL_BASE_URL: "https://models.example.test/v1",
      }).model,
    ).toEqual({
      provider: "custom-provider",
      id: "test-model",
      apiKey: "model-secret",
      baseUrl: "https://models.example.test/v1",
    });
  });

  it("ignores unrelated process environment variables before strict validation", () => {
    expect(loadServerConfig({ ...validEnvironment, PATH: "/usr/bin" }).model).toEqual({
      provider: "faux",
      id: "test-model",
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

  it("rejects SMTP ports outside the TCP range", () => {
    expect(() => loadServerConfig({ ...validEnvironment, SMTP_PORT: "0" })).toThrow(
      "/SMTP_PORT must be between 1 and 65535",
    );
  });

  it("requires both GitHub OAuth settings", () => {
    expect(() => loadServerConfig({ ...validEnvironment, GITHUB_CLIENT_ID: "client-id" })).toThrow(
      "/GITHUB_CLIENT_ID and /GITHUB_CLIENT_SECRET must be configured together",
    );
  });
});
