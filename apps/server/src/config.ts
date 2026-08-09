import { type ServerEnvironment, ServerEnvironmentSchema } from "@interview-agent/contracts";
import { Check, Errors } from "typebox/value";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 3000;

export interface ServerConfig {
  readonly environment: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly auth: {
    readonly secret: string;
    readonly baseUrl: string;
    readonly github?: {
      readonly clientId: string;
      readonly clientSecret: string;
    };
  };
  readonly model: {
    readonly provider: string;
    readonly id: string;
  };
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  readonly telemetry: {
    readonly otlpEndpoint?: string;
  };
}

export class ConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid server configuration:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "ConfigurationError";
    this.issues = issues;
  }
}

function validationIssues(environment: Readonly<Record<string, string | undefined>>) {
  return [...Errors(ServerEnvironmentSchema, environment)].flatMap((error) => {
    if (error.keyword === "required") {
      return error.params.requiredProperties.map((property) => `/${property} is required`);
    }

    return `${error.instancePath || "/"} ${error.message}`;
  });
}

function parsePort(port: string | undefined) {
  const parsedPort = Number.parseInt(port ?? String(DEFAULT_PORT), 10);

  if (parsedPort < 1 || parsedPort > 65_535) {
    throw new ConfigurationError(["/PORT must be between 1 and 65535"]);
  }

  return parsedPort;
}

function githubConfig(environment: ServerEnvironment) {
  const clientId = environment.GITHUB_CLIENT_ID;
  const clientSecret = environment.GITHUB_CLIENT_SECRET;

  if (clientId === undefined && clientSecret === undefined) {
    return undefined;
  }

  if (clientId === undefined || clientSecret === undefined) {
    throw new ConfigurationError([
      "/GITHUB_CLIENT_ID and /GITHUB_CLIENT_SECRET must be configured together",
    ]);
  }

  return {
    clientId,
    clientSecret,
  };
}

export function loadServerConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ServerConfig {
  if (!Check(ServerEnvironmentSchema, environment)) {
    throw new ConfigurationError(validationIssues(environment));
  }

  const github = githubConfig(environment);
  const otlpEndpoint = environment.OTEL_EXPORTER_OTLP_ENDPOINT;

  return {
    environment: environment.NODE_ENV ?? "development",
    host: environment.HOST ?? DEFAULT_HOST,
    port: parsePort(environment.PORT),
    databaseUrl: environment.DATABASE_URL,
    auth: {
      secret: environment.BETTER_AUTH_SECRET,
      baseUrl: environment.BETTER_AUTH_URL,
      ...(github === undefined ? {} : { github }),
    },
    model: {
      provider: environment.MODEL_PROVIDER,
      id: environment.MODEL_ID,
    },
    logLevel: environment.LOG_LEVEL ?? "info",
    telemetry: {
      ...(otlpEndpoint === undefined ? {} : { otlpEndpoint }),
    },
  };
}
