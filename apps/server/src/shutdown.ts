import type { FastifyInstance } from "fastify";

export interface ShutdownSignalTarget {
  exitCode: string | number | null | undefined;
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface GracefulShutdownHandle {
  shutdown(): Promise<void>;
}

export function installGracefulShutdown(
  app: FastifyInstance,
  target: ShutdownSignalTarget = process,
): GracefulShutdownHandle {
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    shutdownPromise ??= app.close().catch(() => {
      target.exitCode = 1;
      app.log.error({ event: "graceful_shutdown_failed" }, "Graceful shutdown failed");
    });
    return shutdownPromise;
  };
  target.once("SIGINT", () => void shutdown());
  target.once("SIGTERM", () => void shutdown());
  return { shutdown };
}
