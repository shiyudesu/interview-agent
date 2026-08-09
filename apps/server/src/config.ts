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
  readonly model:
    | {
        readonly provider: "faux";
        readonly id: string;
        readonly baseUrl?: string;
      }
    | {
        readonly provider: string;
        readonly id: string;
        readonly apiKey: string;
        readonly baseUrl?: string;
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

const SERVER_ENVIRONMENT_KEYS = [
  "NODE_ENV",
  "HOST",
  "PORT",
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "MODEL_PROVIDER",
  "MODEL_ID",
  "MODEL_API_KEY",
  "MODEL_BASE_URL",
  "LOG_LEVEL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
] as const;

function selectServerEnvironment(environment: Readonly<Record<string, string | undefined>>) {
  return Object.fromEntries(
    SERVER_ENVIRONMENT_KEYS.flatMap((key) => {
      const value = environment[key];
      return value === undefined ? [] : [[key, value] as const];
    }),
  );
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
  const selectedEnvironment = selectServerEnvironment(environment);
  if (!Check(ServerEnvironmentSchema, selectedEnvironment)) {
    throw new ConfigurationError(validationIssues(selectedEnvironment));
  }

  const github = githubConfig(selectedEnvironment);
  const otlpEndpoint = selectedEnvironment.OTEL_EXPORTER_OTLP_ENDPOINT;
  const modelBaseUrl = selectedEnvironment.MODEL_BASE_URL;
  let model: ServerConfig["model"];
  if (selectedEnvironment.MODEL_PROVIDER === "faux") {
    model = {
      provider: "faux",
      id: selectedEnvironment.MODEL_ID,
      ...(modelBaseUrl === undefined ? {} : { baseUrl: modelBaseUrl }),
    };
  } else {
    if (!("MODEL_API_KEY" in selectedEnvironment)) {
      throw new ConfigurationError(["/MODEL_API_KEY is required"]);
    }
    model = {
      provider: selectedEnvironment.MODEL_PROVIDER,
      id: selectedEnvironment.MODEL_ID,
      apiKey: selectedEnvironment.MODEL_API_KEY,
      ...(modelBaseUrl === undefined ? {} : { baseUrl: modelBaseUrl }),
    };
  }

  return {
    environment: selectedEnvironment.NODE_ENV ?? "development",
    host: selectedEnvironment.HOST ?? DEFAULT_HOST,
    port: parsePort(selectedEnvironment.PORT),
    databaseUrl: selectedEnvironment.DATABASE_URL,
    auth: {
      secret: selectedEnvironment.BETTER_AUTH_SECRET,
      baseUrl: selectedEnvironment.BETTER_AUTH_URL,
      ...(github === undefined ? {} : { github }),
    },
    model,
    logLevel: selectedEnvironment.LOG_LEVEL ?? "info",
    telemetry: {
      ...(otlpEndpoint === undefined ? {} : { otlpEndpoint }),
    },
  };
}
