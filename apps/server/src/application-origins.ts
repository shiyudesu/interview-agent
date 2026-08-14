import type { ServerConfig } from "./config.js";

export function trustedApplicationOrigins(
  config: Pick<ServerConfig, "auth" | "environment">,
): readonly string[] {
  const applicationOrigin = new URL(config.auth.baseUrl).origin;
  const developmentOrigins =
    config.environment === "production" ? [] : ["http://localhost:5173", "http://127.0.0.1:5173"];
  return Object.freeze([...new Set([applicationOrigin, ...developmentOrigins])]);
}
