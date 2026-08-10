import type { Database } from "../client.js";
import { PgInterviewRepository } from "./interview-repository.js";
import { PgOperationRepository } from "./operation-repository.js";
import { PgReportRepository } from "./report-repository.js";
import { RepositoryExecution, type TransactionOptions, withTransaction } from "./transaction.js";

export interface PgRepositories {
  readonly interviews: PgInterviewRepository;
  readonly operations: PgOperationRepository;
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
    return withTransaction(
      this.database,
      (transaction) => {
        const execution = this.execution.bind(transaction);
        return callback({
          interviews: new PgInterviewRepository(this.database, execution),
          operations: new PgOperationRepository(this.database, execution),
          reports: new PgReportRepository(this.database, execution),
        });
      },
      options,
    );
  }
}
