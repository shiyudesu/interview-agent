import type { StoredOperation } from "@interview-agent/db";
import type { OperationId } from "@interview-agent/domain";

import type { AcceptedOperationWork } from "./operation-types.js";

export interface OperationExecution {
  execute(operation: () => Promise<StoredOperation>): Promise<StoredOperation>;
}

export class ServerOwnedOperationExecution implements OperationExecution {
  execute(operation: () => Promise<StoredOperation>): Promise<StoredOperation> {
    return operation();
  }
}

export interface OperationExecutionStarter {
  start(work: AcceptedOperationWork): void;
  shutdown?(): Promise<void>;
}

export class ServerOwnedOperationSupervisor implements OperationExecutionStarter {
  private readonly activeExecutions = new Map<OperationId, Promise<void>>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(private readonly onFailure: (operationId: OperationId) => void = () => undefined) {}

  start(work: AcceptedOperationWork): void {
    if (this.shuttingDown || this.activeExecutions.has(work.operationId)) {
      return;
    }
    let tracked: Promise<void>;
    tracked = Promise.resolve()
      .then(() => this.execute(work))
      .catch(() => this.reportFailure(work.operationId))
      .finally(() => {
        if (this.activeExecutions.get(work.operationId) === tracked) {
          this.activeExecutions.delete(work.operationId);
        }
      });
    this.activeExecutions.set(work.operationId, tracked);
  }

  get activeOperationCount(): number {
    return this.activeExecutions.size;
  }

  shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.shutdownPromise ??= this.drain();
    return this.shutdownPromise;
  }

  async drain(): Promise<void> {
    while (this.activeExecutions.size > 0) {
      await Promise.all(this.activeExecutions.values());
    }
  }

  private async execute(work: AcceptedOperationWork): Promise<void> {
    await work.start();
  }

  private reportFailure(operationId: OperationId): void {
    try {
      this.onFailure(operationId);
    } catch {
      return;
    }
  }
}

export class ServerOwnedOperationStarter extends ServerOwnedOperationSupervisor {}
