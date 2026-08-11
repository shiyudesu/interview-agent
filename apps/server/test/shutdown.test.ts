import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installGracefulShutdown } from "../src/shutdown.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("installGracefulShutdown", () => {
  it.each(["SIGINT", "SIGTERM"] as const)("closes Fastify once on %s", async (signal) => {
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.ready();
    const listeners = new Map<string, () => void>();
    const target = {
      exitCode: undefined as number | undefined,
      once: vi.fn((name: "SIGINT" | "SIGTERM", listener: () => void) => {
        listeners.set(name, listener);
      }),
    };
    const close = vi.spyOn(app, "close");
    const handle = installGracefulShutdown(app, target);

    listeners.get(signal)?.();
    await handle.shutdown();
    await handle.shutdown();

    expect(close).toHaveBeenCalledTimes(1);
    expect(target.exitCode).toBeUndefined();
  });
});
