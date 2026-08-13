import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createServer } from "../src/server.js";
import { registerWebApplication } from "../src/web-application.js";

const apps: ReturnType<typeof createServer>[] = [];
let webRoot = "";

beforeAll(async () => {
  webRoot = await mkdtemp(join(tmpdir(), "interview-agent-web-"));
  await mkdir(join(webRoot, "assets"));
  await Promise.all([
    writeFile(
      join(webRoot, "index.html"),
      '<!doctype html><html><body><div id="root">WEB SHELL</div></body></html>',
    ),
    writeFile(join(webRoot, "assets", "app.js"), "globalThis.__WEB_SHELL__ = true;"),
  ]);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

afterAll(async () => {
  await rm(webRoot, { recursive: true, force: true });
});

function app() {
  const instance = createServer({ logger: false });
  apps.push(instance);
  return instance;
}

describe("production web application", () => {
  it("serves built assets and returns the SPA shell for browser routes", async () => {
    const instance = app();
    instance.get("/api/v1/health", async () => ({ status: "ok" }));
    await registerWebApplication(instance, {
      environment: "production",
      root: webRoot,
    });

    const asset = await instance.inject({
      method: "GET",
      url: "/assets/app.js",
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain("__WEB_SHELL__");

    const navigation = await instance.inject({
      method: "GET",
      url: "/interviews/example",
      headers: { accept: "text/html" },
    });
    expect(navigation.statusCode).toBe(200);
    expect(navigation.headers["cache-control"]).toBe("no-cache");
    expect(navigation.body).toContain("WEB SHELL");

    const api = await instance.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { accept: "text/html" },
    });
    expect(api.json()).toEqual({ status: "ok" });

    const missingApi = await instance.inject({
      method: "GET",
      url: "/api/v1/missing",
      headers: { accept: "text/html" },
    });
    expect(missingApi.statusCode).toBe(404);
    expect(missingApi.headers["content-type"]).toContain("application/json");
  });

  it("does not register static routes outside production", async () => {
    const instance = app();
    await registerWebApplication(instance, {
      environment: "development",
      root: webRoot,
    });

    const response = await instance.inject({
      method: "GET",
      url: "/",
      headers: { accept: "text/html" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("WEB SHELL");
  });
});
