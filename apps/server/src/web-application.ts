import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

export interface WebApplicationOptions {
  readonly environment: "development" | "test" | "production";
  readonly root?: string;
}

export async function registerWebApplication(
  app: FastifyInstance,
  options: WebApplicationOptions,
): Promise<void> {
  if (options.environment !== "production") {
    return;
  }
  const root = options.root ?? fileURLToPath(new URL("../public", import.meta.url));
  await app.register(fastifyStatic, {
    root,
    index: false,
    redirect: false,
    wildcard: false,
  });
  app.setNotFoundHandler((request, reply) => {
    if (isBrowserNavigation(request.method, request.url, request.headers.accept)) {
      return reply
        .code(200)
        .header("cache-control", "no-cache")
        .type("text/html; charset=utf-8")
        .sendFile("index.html", { cacheControl: false });
    }
    return reply.code(404).send({
      error: "Not Found",
      message: "Route not found",
      statusCode: 404,
    });
  });
}

function isBrowserNavigation(method: string, url: string, accept: string | undefined): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return (
    (method === "GET" || method === "HEAD") &&
    pathname !== "/api" &&
    !pathname.startsWith("/api/") &&
    accept?.includes("text/html") === true
  );
}
