import type { StoredOperation } from "@interview-agent/db";
import { parseOperationId } from "@interview-agent/domain";
import { describe, expect, it, vi } from "vitest";

import {
  type AcceptedOperationWork,
  ServerOwnedOperationSupervisor,
} from "../src/operation-runner.js";

const SETTLED_OPERATION = {} as StoredOperation;

describe("ServerOwnedOperationSupervisor", () => {
  it("starts only one active execution for an Operation ID", async () => {
    const supervisor = new ServerOwnedOperationSupervisor();
    const started = deferred<void>();
    const release = deferred<StoredOperation>();
    const first = work("supervisor-duplicate", async () => {
      started.resolve();
      return release.promise;
    });
    const duplicate = work(
      "supervisor-duplicate",
      vi.fn(async () => SETTLED_OPERATION),
    );

    supervisor.start(first);
    supervisor.start(duplicate);
    await started.promise;

    expect(duplicate.start).not.toHaveBeenCalled();
    expect(supervisor.activeOperationCount).toBe(1);

    release.resolve(SETTLED_OPERATION);
    await supervisor.drain();
    expect(supervisor.activeOperationCount).toBe(0);
  });

  it("reserves an Operation ID before invoking reentrant work", async () => {
    const supervisor = new ServerOwnedOperationSupervisor();
    const duplicateStart = vi.fn(async () => SETTLED_OPERATION);
    const firstStart = vi.fn(async () => {
      supervisor.start(work("supervisor-reentrant", duplicateStart));
      return SETTLED_OPERATION;
    });

    supervisor.start(work("supervisor-reentrant", firstStart));
    await supervisor.drain();

    expect(firstStart).toHaveBeenCalledOnce();
    expect(duplicateStart).not.toHaveBeenCalled();
  });

  it("does not resolve reentrant shutdown before reserved work settles", async () => {
    const supervisor = new ServerOwnedOperationSupervisor();
    const release = deferred<StoredOperation>();
    let shutdown: Promise<void> | undefined;
    supervisor.start(
      work("supervisor-reentrant-shutdown", async () => {
        shutdown = supervisor.shutdown();
        return release.promise;
      }),
    );
    await Promise.resolve();

    if (shutdown === undefined) {
      throw new Error("Reentrant shutdown was not started");
    }
    expect(await Promise.race([shutdown.then(() => "settled"), Promise.resolve("pending")])).toBe(
      "pending",
    );

    release.resolve(SETTLED_OPERATION);
    await shutdown;
    expect(supervisor.activeOperationCount).toBe(0);
  });

  it("rejects new execution after shutdown begins", async () => {
    const supervisor = new ServerOwnedOperationSupervisor();
    const start = vi.fn(async () => SETTLED_OPERATION);

    await supervisor.shutdown();
    supervisor.start(work("supervisor-after-shutdown", start));
    await Promise.resolve();

    expect(start).not.toHaveBeenCalled();
    expect(supervisor.activeOperationCount).toBe(0);
  });

  it("logs a sanitized Operation failure and removes the settled work", async () => {
    const onFailure = vi.fn();
    const supervisor = new ServerOwnedOperationSupervisor(onFailure);

    supervisor.start(
      work("supervisor-failure", async () => {
        throw new Error("provider credential=secret");
      }),
    );
    await supervisor.drain();

    expect(onFailure).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith(parseOperationId("supervisor-failure"));
    expect(JSON.stringify(onFailure.mock.calls)).not.toContain("secret");
    expect(supervisor.activeOperationCount).toBe(0);
  });

  it("waits for all active work and cleans the drain set", async () => {
    const supervisor = new ServerOwnedOperationSupervisor();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const firstRelease = deferred<StoredOperation>();
    const secondRelease = deferred<StoredOperation>();
    supervisor.start(
      work("supervisor-drain-first", async () => {
        firstStarted.resolve();
        return firstRelease.promise;
      }),
    );
    supervisor.start(
      work("supervisor-drain-second", async () => {
        secondStarted.resolve();
        return secondRelease.promise;
      }),
    );
    await Promise.all([firstStarted.promise, secondStarted.promise]);

    const shutdown = supervisor.shutdown();
    expect(await Promise.race([shutdown.then(() => "settled"), Promise.resolve("pending")])).toBe(
      "pending",
    );

    firstRelease.resolve(SETTLED_OPERATION);
    secondRelease.resolve(SETTLED_OPERATION);
    await shutdown;

    expect(supervisor.activeOperationCount).toBe(0);
  });
});

function work(operationId: string, start: AcceptedOperationWork["start"]): AcceptedOperationWork {
  return {
    operationId: parseOperationId(operationId),
    start,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
