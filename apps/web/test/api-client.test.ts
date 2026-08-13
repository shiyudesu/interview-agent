import "@testing-library/jest-dom/vitest";

import { describe, expect, it, vi } from "vitest";

import { ApiResponseError, createApiClient } from "../src/lib/api-client.js";

function jsonResponse(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

describe("API client", () => {
  it("uses same-origin credentials and decodes successful JSON", async () => {
    const requestFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        value: "ok",
      }),
    );
    const client = createApiClient({ fetch: requestFetch });

    await expect(
      client.request("/api/v1/example", {
        decode(value) {
          if (
            typeof value !== "object" ||
            value === null ||
            !("value" in value) ||
            value.value !== "ok"
          ) {
            throw new Error("invalid response");
          }
          return value.value;
        },
      }),
    ).resolves.toBe("ok");
    expect(requestFetch).toHaveBeenCalledWith(
      "/api/v1/example",
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        method: "GET",
      }),
    );
  });

  it("surfaces stable API errors without exposing an invalid body", async () => {
    const requestFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: "unauthorized",
            message: "Authentication required",
          },
        },
        { status: 401 },
      ),
    );
    const client = createApiClient({ fetch: requestFetch });

    await expect(
      client.request("/api/v1/account", {
        decode: () => null,
      }),
    ).rejects.toMatchObject({
      name: "ApiClientError",
      status: 401,
      apiError: {
        code: "unauthorized",
      },
    });
  });

  it("rejects successful responses that do not match the caller decoder", async () => {
    const client = createApiClient({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ unexpected: true })),
    });

    await expect(
      client.request("/api/v1/example", {
        decode() {
          throw new Error("schema mismatch");
        },
      }),
    ).rejects.toEqual(new ApiResponseError("服务器返回了无法识别的数据"));
  });

  it("rejects non-JSON responses before decoding", async () => {
    const client = createApiClient({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("not-json", {
          headers: { "content-type": "text/plain" },
        }),
      ),
    });

    await expect(
      client.request("/api/v1/example", {
        decode: () => null,
      }),
    ).rejects.toEqual(new ApiResponseError("服务器返回了非 JSON 响应"));
  });

  it("uses a fixed fallback for malformed error envelopes", async () => {
    const client = createApiClient({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: "version_conflict",
              message: "Version conflict",
            },
          },
          { status: 409 },
        ),
      ),
    });

    await expect(
      client.request("/api/v1/example", {
        decode: () => null,
      }),
    ).rejects.toMatchObject({
      name: "ApiClientError",
      message: "请求失败，请稍后重试。",
      status: 409,
      apiError: null,
    });
  });
});
