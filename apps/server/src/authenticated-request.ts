import type { AccountId } from "@interview-agent/domain";
import type { FastifyReply, FastifyRequest } from "fastify";
import { unauthorizedError } from "./api-route-errors.js";
import type { AuthenticatedRequestContext } from "./auth.js";

declare module "fastify" {
  interface FastifyRequest {
    authContext: AuthenticatedRequestContext | null;
  }
}

export function authenticatedRequestContext(
  request: FastifyRequest,
  reply: FastifyReply,
): AuthenticatedRequestContext | null {
  const context = request.authContext;
  if (context === null) {
    reply.code(401).send(unauthorizedError());
    return null;
  }
  return context;
}

export function authenticatedAccountId(
  request: FastifyRequest,
  reply: FastifyReply,
): AccountId | null {
  return authenticatedRequestContext(request, reply)?.accountId ?? null;
}
