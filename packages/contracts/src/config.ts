import { type Static, Type } from "typebox";

export const ServerEnvironmentSchema = Type.Object({
  NODE_ENV: Type.Optional(
    Type.Union([Type.Literal("development"), Type.Literal("test"), Type.Literal("production")]),
  ),
  HOST: Type.Optional(Type.String({ minLength: 1 })),
  PORT: Type.Optional(Type.String({ pattern: "^[0-9]+$" })),
  DATABASE_URL: Type.String({ minLength: 1 }),
  BETTER_AUTH_SECRET: Type.String({ minLength: 32 }),
  BETTER_AUTH_URL: Type.String({ minLength: 1 }),
  GITHUB_CLIENT_ID: Type.Optional(Type.String({ minLength: 1 })),
  GITHUB_CLIENT_SECRET: Type.Optional(Type.String({ minLength: 1 })),
  MODEL_PROVIDER: Type.String({ minLength: 1 }),
  MODEL_ID: Type.String({ minLength: 1 }),
  LOG_LEVEL: Type.Optional(
    Type.Union([
      Type.Literal("fatal"),
      Type.Literal("error"),
      Type.Literal("warn"),
      Type.Literal("info"),
      Type.Literal("debug"),
      Type.Literal("trace"),
    ]),
  ),
  OTEL_EXPORTER_OTLP_ENDPOINT: Type.Optional(Type.String({ minLength: 1 })),
});

export type ServerEnvironment = Static<typeof ServerEnvironmentSchema>;
