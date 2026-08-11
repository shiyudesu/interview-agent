import {
  type Api,
  type AssistantMessage,
  fauxAssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  createModelRuntime,
  ModelConfigurationError,
  type ModelRuntime,
} from "../src/model-runtime.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createModelRuntime", () => {
  it("constructs a deterministic Faux Provider without credentials", async () => {
    const runtime = await createModelRuntime({
      provider: "faux",
      id: "automated-test-model",
    });

    expect(runtime.kind).toBe("faux");
    if (runtime.kind !== "faux") {
      throw new Error("Expected the Faux Provider runtime");
    }

    expect(runtime.model.provider).toBe("faux");
    expect(await runtime.client.getAuth()).toEqual({ auth: {} });

    runtime.faux.setResponses([
      fauxAssistantMessage("deterministic response", {
        timestamp: 1,
      }),
    ]);
    const output = await runtime.client.complete({
      messages: [{ role: "user", content: "test input", timestamp: 1 }],
    });

    expect(output.content).toEqual([{ type: "text", text: "deterministic response" }]);
    expect(output.provider).toBe("faux");
    expect(output.model).toBe("automated-test-model");
    expectTypeOf(runtime.model).toEqualTypeOf<Model<string>>();
    expectTypeOf(output).toEqualTypeOf<AssistantMessage>();
  });

  it("passes the configured real-provider key and base URL to pi-ai", async () => {
    const runtime = await createModelRuntime({
      provider: "openai",
      id: "gpt-4o-mini",
      apiKey: "configured-model-secret",
      baseUrl: "https://models.example.test/v1",
    });

    expect(runtime.kind).toBe("real");
    if (runtime.kind !== "real") {
      throw new Error("Expected a real-provider runtime");
    }

    expect(runtime.model.provider).toBe("openai");
    expect(runtime.model.baseUrl).toBe("https://models.example.test/v1");
    expect(await runtime.client.getAuth()).toEqual({
      auth: {
        apiKey: "configured-model-secret",
      },
      env: undefined,
      source: "stored credential",
    });
    expectTypeOf(runtime.model).toEqualTypeOf<Model<Api>>();
  });

  it("rejects an unsupported provider instead of falling back", async () => {
    await expect(
      createModelRuntime({
        provider: "unsupported-provider",
        id: "some-model",
        apiKey: "configured-model-secret",
      }),
    ).rejects.toThrowError(
      new ModelConfigurationError('unsupported MODEL_PROVIDER "unsupported-provider"'),
    );
  });

  it.each([
    {
      name: "unknown model",
      config: {
        provider: "openai",
        id: "not-a-real-openai-model",
        apiKey: "configured-model-secret",
      },
      message: 'MODEL_ID "not-a-real-openai-model" is not available from provider "openai"',
    },
    {
      name: "blank API key",
      config: {
        provider: "openai",
        id: "gpt-4o-mini",
        apiKey: " ",
      },
      message: "MODEL_API_KEY must not be blank",
    },
    {
      name: "non-HTTP base URL",
      config: {
        provider: "openai",
        id: "gpt-4o-mini",
        apiKey: "configured-model-secret",
        baseUrl: "file:///models",
      },
      message: "MODEL_BASE_URL must use http or https",
    },
    {
      name: "provider requiring an explicit base URL",
      config: {
        provider: "azure-openai-responses",
        id: "gpt-4",
        apiKey: "configured-model-secret",
      },
      message:
        'MODEL_BASE_URL is required for provider "azure-openai-responses" because its catalog endpoint is not directly usable',
    },
  ])("rejects malformed configuration: $name", async ({ config, message }) => {
    await expect(createModelRuntime(config)).rejects.toThrowError(
      new ModelConfigurationError(message),
    );
  });

  it("returns a discriminated, typed runtime without caller casts", async () => {
    const runtime: ModelRuntime = await createModelRuntime({
      provider: "faux",
      id: "typed-test-model",
    });

    if (runtime.kind === "faux") {
      expectTypeOf(runtime.faux).not.toBeNever();
      expectTypeOf(runtime.model).toEqualTypeOf<Model<string>>();
    } else {
      expectTypeOf(runtime.model).toEqualTypeOf<Model<Api>>();
    }
  });

  it("refreshes Radius catalogs only through the configured gateway", async () => {
    const requests: Array<{ readonly authorization: string | null; readonly url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
        });
        return Response.json({
          baseUrl: "https://private-gateway.example/v1",
          models: [
            {
              id: "radius-test-model",
              name: "Radius Test Model",
              reasoning: false,
              input: ["text"],
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
              contextWindow: 8_192,
              maxTokens: 2_048,
            },
          ],
        });
      }),
    );

    const runtime = await createModelRuntime({
      provider: "radius",
      id: "radius-test-model",
      apiKey: "radius-private-key",
      baseUrl: "https://private-gateway.example/v1",
    });

    expect(runtime.model.baseUrl).toBe("https://private-gateway.example/v1");
    expect(requests).toEqual([
      {
        url: "https://private-gateway.example/v1/config",
        authorization: "Bearer radius-private-key",
      },
    ]);
  });

  it("exposes no model or credential switching surface", async () => {
    const runtime = await createModelRuntime({
      provider: "faux",
      id: "fixed-model",
    });
    if (runtime.kind !== "faux") {
      throw new Error("Expected the Faux Provider runtime");
    }
    runtime.faux.setResponses([fauxAssistantMessage("unused")]);

    expect(runtime).not.toHaveProperty("models");
    expect(runtime.faux).not.toHaveProperty("provider");
    expect(runtime.client).not.toHaveProperty("login");
    expect(runtime.client).not.toHaveProperty("logout");
    expect(Object.isFrozen(runtime.model)).toBe(true);
    expect(Object.isFrozen(runtime.model.cost)).toBe(true);
    expect(() =>
      Object.assign(runtime.model, {
        baseUrl: "https://attacker.example.test/v1",
      }),
    ).toThrow(TypeError);
    expect(runtime.client.complete).toHaveLength(1);
    const selected = await runtime.client.complete({
      messages: [{ role: "user", content: "test input", timestamp: 1 }],
    });
    expect(selected.content).toEqual([{ type: "text", text: "unused" }]);
  });
});
