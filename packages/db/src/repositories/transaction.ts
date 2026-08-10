import type { Database } from "../client.js";

type TransactionCallback = Parameters<Database["transaction"]>[0];
export type DatabaseTransaction = Parameters<TransactionCallback>[0];
export type DatabaseExecutor = Database | DatabaseTransaction;

export interface TransactionOptions {
  readonly isolationLevel?:
    | "read uncommitted"
    | "read committed"
    | "repeatable read"
    | "serializable";
  readonly accessMode?: "read only" | "read write";
  readonly deferrable?: boolean;
}

export function withTransaction<Result>(
  database: Database,
  callback: (transaction: DatabaseTransaction) => Promise<Result>,
  options: TransactionOptions = {},
): Promise<Result> {
  return database.transaction(callback, options);
}

export class RepositoryExecution {
  constructor(
    readonly database: Database,
    readonly executor: DatabaseExecutor = database,
    private readonly transactionBound = false,
  ) {}

  inTransaction<Result>(
    callback: (executor: DatabaseExecutor) => Promise<Result>,
    options: TransactionOptions = {},
  ): Promise<Result> {
    if (this.transactionBound) {
      return callback(this.executor);
    }
    return withTransaction(this.database, callback, options);
  }

  bind(transaction: DatabaseTransaction): RepositoryExecution {
    return new RepositoryExecution(this.database, transaction, true);
  }
}
