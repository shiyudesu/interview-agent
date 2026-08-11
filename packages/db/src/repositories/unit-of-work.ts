import type { Database } from "../client.js";
import { RepositoryInterviewExpirySignal } from "./interview-expiry.js";
import { persistInterviewExpiryAndThrow } from "./interview-expiry-handling.js";
import { PgInterviewRepository } from "./interview-repository.js";
import { PgLifecycleRepository } from "./lifecycle-repository.js";
import { PgOperationRepository } from "./operation-repository.js";
import { PgQuestionBankRepository } from "./question-bank-repository.js";
import { PgReportRepository } from "./report-repository.js";
import { RepositoryExecution, type TransactionOptions, withTransaction } from "./transaction.js";

export interface PgRepositories {
  readonly interviews: PgInterviewRepository;
  readonly lifecycle: PgLifecycleRepository;
  readonly operations: PgOperationRepository;
  readonly questionBank: PgQuestionBankRepository;
  readonly reports: PgReportRepository;
}

export class PgRepositoryUnitOfWork {
  private readonly execution: RepositoryExecution;

  constructor(private readonly database: Database) {
    this.execution = new RepositoryExecution(database);
  }

  run<Result>(
    callback: (repositories: PgRepositories) => Promise<Result>,
    options: TransactionOptions = {},
  ): Promise<Result> {
    return this.runWithExpiryPersistence(callback, options);
  }

  private async runWithExpiryPersistence<Result>(
    callback: (repositories: PgRepositories) => Promise<Result>,
    options: TransactionOptions,
  ): Promise<Result> {
    try {
      return await withTransaction(
        this.database,
        async (transaction) => {
          const execution = this.execution.bind(transaction);
          return callback({
            interviews: new PgInterviewRepository(this.database, execution),
            lifecycle: new PgLifecycleRepository(this.database, execution),
            operations: new PgOperationRepository(this.database, execution),
            questionBank: new PgQuestionBankRepository(this.database, execution),
            reports: new PgReportRepository(this.database, execution),
          });
        },
        options,
      );
    } catch (error) {
      if (error instanceof RepositoryInterviewExpirySignal) {
        return persistInterviewExpiryAndThrow(this.database, error);
      }
      throw error;
    }
  }
}
