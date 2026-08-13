import { parseAccountId } from "@interview-agent/domain";
import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedRequestContext } from "../src/auth.js";
import {
  authenticatedAccountId,
  authenticatedRequestContext,
} from "../src/authenticated-request.js";

function replyHarness() {
  const send = vi.fn();
  const code = vi.fn(() => ({ send }));
  return {
    code,
    send,
    reply: { code } as unknown as FastifyReply,
  };
}

describe("authenticated request access", () => {
  const context: AuthenticatedRequestContext = {
    accountId: parseAccountId("account-1"),
    sessionId: "session-1",
    email: "candidate@example.test",
    name: "Candidate",
  };

  it("returns the authenticated context and account without touching the reply", () => {
    const request = { authContext: context } as FastifyRequest;
    const harness = replyHarness();

    expect(authenticatedRequestContext(request, harness.reply)).toBe(context);
    expect(authenticatedAccountId(request, harness.reply)).toBe(context.accountId);
    expect(harness.code).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("returns null and sends the stable 401 envelope instead of throwing", () => {
    const request = { authContext: null } as FastifyRequest;
    const harness = replyHarness();

    expect(authenticatedRequestContext(request, harness.reply)).toBeNull();
    expect(harness.code).toHaveBeenCalledWith(401);
    expect(harness.send).toHaveBeenCalledWith({
      error: {
        code: "unauthorized",
        message: "Authentication is required",
      },
    });
  });
});
