import { RateLimitErrorResponseSchema } from "@interview-agent/contracts";
import { Check } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiRouteErrorHandler } from "../src/api-route-errors.js";
import { API_BODY_LIMITS, API_RATE_LIMITS, registerSecurityControls } from "../src/security.js";
import { createServer } from "../src/server.js";

const apps: ReturnType<typeof createServer>[] = [];
const productionConfig = {
  environment: "production",
  auth: {
    secret: "0123456789abcdef0123456789abcdef",
    baseUrl: "https://interview.example.test",
  },
} as const;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function securityApp() {
  const app = createServer({ logger: false });
  apps.push(app);
  await registerSecurityControls(app, productionConfig);
  return app;
}

describe("security controls", () => {
  it("sets production security headers without permissive CORS", async () => {
    const app = await securityApp();
    app.get("/probe", async () => ({ ok: true }));

    const response = await app.inject({ method: "GET", url: "/probe" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["strict-transport-security"]).toBe(
      "max-age=31536000; includeSubDomains; preload",
    );
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects cross-origin API mutations before their handler runs", async () => {
    const app = await securityApp();
    const handler = vi.fn(async () => ({ ok: true }));
    app.post("/api/v1/probe", handler);

    const foreignOrigin = await app.inject({
      method: "POST",
      url: "/api/v1/probe",
      headers: { origin: "https://attacker.example.test" },
    });
    const fetchMetadata = await app.inject({
      method: "POST",
      url: "/api/v1/probe",
      headers: { "sec-fetch-site": "cross-site" },
    });
    const sameOrigin = await app.inject({
      method: "POST",
      url: "/api/v1/probe",
      headers: { origin: "https://interview.example.test" },
    });

    expect(foreignOrigin.statusCode).toBe(403);
    expect(foreignOrigin.json()).toEqual({
      error: {
        code: "cross_origin_request",
        message: "Cross-origin requests are not allowed.",
      },
    });
    expect(fetchMetadata.statusCode).toBe(403);
    expect(sameOrigin.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("returns a stable 429 envelope for an endpoint-specific limit", async () => {
    const app = await securityApp();
    app.get(
      "/api/v1/limited",
      {
        config: {
          rateLimit: {
            ...API_RATE_LIMITS.read,
            max: 2,
            groupId: "security-test-read",
          },
        },
        errorHandler: createApiRouteErrorHandler({
          logEvent: "security_test_rate_limit_failed",
          logMessage: "Security test rate limit failed",
          mapContentTypeParserErrors: false,
        }),
      },
      async () => ({ ok: true }),
    );

    const first = await app.inject({ method: "GET", url: "/api/v1/limited" });
    const second = await app.inject({ method: "GET", url: "/api/v1/limited" });
    const limited = await app.inject({ method: "GET", url: "/api/v1/limited" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(limited.statusCode).toBe(429);
    expect(Check(RateLimitErrorResponseSchema, limited.json())).toBe(true);
    expect(limited.json()).toMatchObject({
      error: {
        code: "rate_limit_exceeded",
        retryAfterSeconds: expect.any(Number),
      },
    });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("returns 413 before parsing an oversized endpoint payload", async () => {
    const app = await securityApp();
    const handler = vi.fn(async () => ({ ok: true }));
    app.post(
      "/api/v1/body",
      {
        bodyLimit: API_BODY_LIMITS.deletion,
        errorHandler: createApiRouteErrorHandler({
          logEvent: "security_test_route_failed",
          logMessage: "Security test route failed",
          mapContentTypeParserErrors: true,
        }),
      },
      handler,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/body",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ value: "x".repeat(API_BODY_LIMITS.deletion + 1) }),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      error: {
        code: "payload_too_large",
        message: "The request body is too large.",
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });
});
