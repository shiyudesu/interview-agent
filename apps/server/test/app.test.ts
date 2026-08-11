import { parseAccountId } from "@interview-agent/domain";
import type { BetterAuthOptions } from "better-auth";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerApplication } from "../src/app.js";
import type { AuthenticatedRequestContext, Authentication } from "../src/auth.js";

const apps: ReturnType<typeof Fastify>[] = [];
const config = {
  auth: {
    secret: "0123456789abcdef0123456789abcdef",
    baseUrl: "http://localhost:3000",
  },
} as const;

function authentication(changes: Partial<Authentication> = {}): Authentication {
  const options: BetterAuthOptions = {};
  return {
    handler: async () => new Response(null, { status: 404 }),
    options,
    getSession: async () => ({ context: null, headers: new Headers() }),
    ...changes,
  };
}

function app() {
  const instance = Fastify({ logger: false });
  apps.push(instance);
  return instance;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((instance) => instance.close()));
});

describe("registerApplication", () => {
  it("mounts Better Auth and preserves request, response, and Set-Cookie headers", async () => {
    let receivedRequest: Request | undefined;
    const handler = vi.fn(async (request: Request) => {
      receivedRequest = request;
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", "session=one; HttpOnly; SameSite=Lax");
      headers.append("set-cookie", "state=two; HttpOnly; SameSite=Lax");
      return new Response(JSON.stringify({ ok: true }), { status: 201, headers });
    });
    const instance = app();
    await registerApplication(instance, {
      authentication: authentication({ handler }),
      config,
    });

    const response = await instance.inject({
      method: "POST",
      url: "/api/auth/email-otp/send-verification-otp",
      headers: {
        cookie: "existing=value",
        origin: "http://localhost:3000",
        "x-interview-client-ip": "spoofed-client",
      },
      payload: {
        email: "candidate@example.test",
        type: "sign-in",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ ok: true });
    expect(response.headers["set-cookie"]).toEqual([
      "session=one; HttpOnly; SameSite=Lax",
      "state=two; HttpOnly; SameSite=Lax",
    ]);
    expect(receivedRequest?.url).toBe(
      "http://localhost:3000/api/auth/email-otp/send-verification-otp",
    );
    expect(receivedRequest?.headers.get("x-interview-client-ip")).toBe("127.0.0.1");
    await expect(receivedRequest?.json()).resolves.toEqual({
      email: "candidate@example.test",
      type: "sign-in",
    });
  });

  it("forwards URL-encoded authentication bodies without JSON conversion", async () => {
    let receivedBody = "";
    const instance = app();
    await registerApplication(instance, {
      authentication: authentication({
        handler: async (request) => {
          receivedBody = await request.text();
          return Response.json({ ok: true });
        },
      }),
      config,
    });

    const response = await instance.inject({
      method: "POST",
      url: "/api/auth/sign-in/social",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: "provider=github&callbackURL=%2F",
    });

    expect(response.statusCode).toBe(200);
    expect(receivedBody).toBe("provider=github&callbackURL=%2F");
  });

  it("loads a normalized authentication context for API v1 requests only", async () => {
    const context: AuthenticatedRequestContext = {
      accountId: parseAccountId("account-1"),
      sessionId: "session-1",
      email: "candidate@example.test",
      name: "Candidate",
    };
    const sessionHeaders = new Headers();
    sessionHeaders.append("set-cookie", "session=refreshed; HttpOnly; SameSite=Lax");
    const getSession = vi.fn(async () => ({
      context,
      headers: sessionHeaders,
    }));
    const instance = app();
    await registerApplication(instance, {
      authentication: authentication({ getSession }),
      config,
    });
    instance.get("/api/v1/context", async (request) => request.authContext);
    instance.get("/health", async (request) => request.authContext);

    const protectedResponse = await instance.inject({
      method: "GET",
      url: "/api/v1/context",
      headers: { cookie: "better-auth.session_token=test" },
    });
    const encodedResponse = await instance.inject({
      method: "GET",
      url: "/api/%76%31/context",
      headers: { cookie: "better-auth.session_token=test" },
    });
    const healthResponse = await instance.inject({ method: "GET", url: "/health" });

    expect(protectedResponse.json()).toEqual(context);
    expect(encodedResponse.json()).toEqual(context);
    expect(protectedResponse.headers["set-cookie"]).toEqual([
      "session=refreshed; HttpOnly; SameSite=Lax",
    ]);
    expect(healthResponse.json()).toBeNull();
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it("returns a sanitized failure when the authentication handler throws", async () => {
    const instance = app();
    await registerApplication(instance, {
      authentication: authentication({
        handler: async () => {
          throw new Error("SMTP rejected candidate@example.test with OTP 123456");
        },
      }),
      config,
    });

    const response = await instance.inject({
      method: "POST",
      url: "/api/auth/email-otp/send-verification-otp",
      payload: { email: "candidate@example.test", type: "sign-in" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "authentication_failure",
        message: "Authentication request failed",
      },
    });
    expect(response.body).not.toContain("candidate@example.test");
    expect(response.body).not.toContain("123456");
  });
});
