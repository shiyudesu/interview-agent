import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance, FastifySchema } from "fastify";

import { BETTER_AUTH_SESSION_COOKIE_NAME } from "./auth.js";
import type { ServerConfig } from "./config.js";

const DOCUMENTATION_PATH = "/documentation";
const OPERATION_EVENTS_PATH = "/api/v1/operations/:operationId/events";
const BETTER_AUTH_SESSION_SECURITY_SCHEME = "betterAuthSession";

export async function registerOpenApiDocumentation(
  app: FastifyInstance,
  environment: ServerConfig["environment"],
): Promise<void> {
  if (environment === "production") {
    return;
  }

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Interview Agent API",
        description: "Local API reference generated from the Fastify route schemas.",
        version: "1.0.0",
      },
      tags: [
        { name: "Account", description: "Account access and deletion." },
        { name: "Interviews", description: "Interview commands and canonical state." },
        { name: "Operations", description: "Durable Operation status and events." },
      ],
      components: {
        securitySchemes: {
          [BETTER_AUTH_SESSION_SECURITY_SCHEME]: {
            type: "apiKey",
            in: "cookie",
            name: BETTER_AUTH_SESSION_COOKIE_NAME,
            description:
              "Better Auth database session cookie. Secure production cookies use the same name with the standard __Secure- prefix.",
          },
        },
      },
      security: [{ [BETTER_AUTH_SESSION_SECURITY_SCHEME]: [] }],
    },
    transform: ({ schema, url }) => ({
      schema: url === OPERATION_EVENTS_PATH ? operationEventStreamSchema(schema) : schema,
      url,
    }),
  });
  await app.register(swaggerUi, {
    routePrefix: DOCUMENTATION_PATH,
    staticCSP: true,
    uiConfig: {
      deepLinking: true,
      docExpansion: "list",
      withCredentials: true,
    },
  });
}

function operationEventStreamSchema(schema: FastifySchema): FastifySchema {
  const responses =
    schema.response !== null && typeof schema.response === "object" ? schema.response : {};
  return {
    ...schema,
    response: {
      ...responses,
      200: {
        description:
          "A text/event-stream carrying validated text_delta events followed by one terminal event.",
        content: {
          "text/event-stream": {
            schema: {
              type: "string",
              description:
                "SSE frames use the event ID as the monotonic sequence and JSON in each data field.",
            },
          },
        },
      },
      204: {
        type: "null",
        description: "The requested event sequence is already terminal and has no newer events.",
      },
    },
  };
}
