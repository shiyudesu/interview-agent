import { type Static, Type } from "typebox";

const environmentProperties = {
  NODE_ENV: Type.Optional(
    Type.Union([Type.Literal("development"), Type.Literal("test"), Type.Literal("production")]),
  ),
  HOST: Type.Optional(Type.String({ minLength: 1 })),
  PORT: Type.Optional(Type.String({ pattern: "^[0-9]+$" })),
  DATABASE_URL: Type.String({ minLength: 1 }),
  BETTER_AUTH_SECRET: Type.String({ minLength: 32 }),
  BETTER_AUTH_URL: Type.String({ format: "uri" }),
  GITHUB_CLIENT_ID: Type.Optional(Type.String({ minLength: 1 })),
  GITHUB_CLIENT_SECRET: Type.Optional(Type.String({ minLength: 1 })),
  MODEL_ID: Type.String({ minLength: 1 }),
  MODEL_BASE_URL: Type.Optional(Type.String({ format: "uri" })),
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
  OTEL_EXPORTER_OTLP_ENDPOINT: Type.Optional(Type.String({ format: "uri" })),
} as const;

export const FauxServerEnvironmentSchema = Type.Object(
  {
    ...environmentProperties,
    MODEL_PROVIDER: Type.Literal("faux"),
  },
  { additionalProperties: false },
);

export const RealProviderServerEnvironmentSchema = Type.Object(
  {
    ...environmentProperties,
    MODEL_PROVIDER: Type.String({
      minLength: 1,
      not: Type.Literal("faux"),
    }),
    MODEL_API_KEY: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const ServerEnvironmentSchema = Type.Union([
  FauxServerEnvironmentSchema,
  RealProviderServerEnvironmentSchema,
]);

export type FauxServerEnvironment = Static<typeof FauxServerEnvironmentSchema>;
export type RealProviderServerEnvironment = Static<typeof RealProviderServerEnvironmentSchema>;
export type ServerEnvironment = Static<typeof ServerEnvironmentSchema>;
