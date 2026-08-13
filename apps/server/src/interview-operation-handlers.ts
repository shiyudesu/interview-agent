import type { StoredOperation } from "@interview-agent/db";

import {
  type OperationExecution,
  ServerOwnedOperationExecution,
} from "./operation-execution-supervisor.js";
import type {
  AcceptedOperationExecution,
  CreateInterviewOperationInput,
  OperationCommandInput,
  ProgressCommandRequest,
  ProgressOperationType,
  RetryInterviewOperationInput,
  TextInterviewOperationInput,
} from "./operation-types.js";

interface OperationRunnerCommands {
  createInterview(input: CreateInterviewOperationInput): Promise<StoredOperation>;
  run(request: ProgressCommandRequest): Promise<StoredOperation>;
  accept(request: ProgressCommandRequest): Promise<AcceptedOperationExecution>;
  retry(input: RetryInterviewOperationInput): Promise<StoredOperation>;
  acceptRetry(input: RetryInterviewOperationInput): Promise<AcceptedOperationExecution>;
}

export class InterviewOperationHandlers {
  constructor(
    private readonly runner: OperationRunnerCommands,
    private readonly execution: OperationExecution = new ServerOwnedOperationExecution(),
  ) {}

  createInterview(input: CreateInterviewOperationInput): Promise<StoredOperation> {
    return this.execute(() => this.runner.createInterview(input));
  }

  async acceptCreateInterview(
    input: CreateInterviewOperationInput,
  ): Promise<AcceptedOperationExecution> {
    return { operation: await this.runner.createInterview(input), work: null };
  }

  submitAnswer(input: TextInterviewOperationInput): Promise<StoredOperation> {
    return this.progress("submit_answer", input);
  }

  acceptSubmitAnswer(input: TextInterviewOperationInput): Promise<AcceptedOperationExecution> {
    return this.acceptProgress("submit_answer", input);
  }

  submitSupplement(input: TextInterviewOperationInput): Promise<StoredOperation> {
    return this.progress("submit_supplement", input);
  }

  acceptSubmitSupplement(input: TextInterviewOperationInput): Promise<AcceptedOperationExecution> {
    return this.acceptProgress("submit_supplement", input);
  }

  requestQuestionClarification(input: OperationCommandInput): Promise<StoredOperation> {
    return this.progress("request_question_clarification", input);
  }

  acceptQuestionClarification(input: OperationCommandInput): Promise<AcceptedOperationExecution> {
    return this.acceptProgress("request_question_clarification", input);
  }

  markUnknown(input: OperationCommandInput): Promise<StoredOperation> {
    return this.progress("mark_question_unknown", input);
  }

  acceptMarkUnknown(input: OperationCommandInput): Promise<AcceptedOperationExecution> {
    return this.acceptProgress("mark_question_unknown", input);
  }

  skip(input: OperationCommandInput): Promise<StoredOperation> {
    return this.progress("skip_question", input);
  }

  acceptSkip(input: OperationCommandInput): Promise<AcceptedOperationExecution> {
    return this.acceptProgress("skip_question", input);
  }

  continueInterview(input: OperationCommandInput): Promise<StoredOperation> {
    return this.progress("continue_interview", input);
  }

  acceptContinueInterview(input: OperationCommandInput): Promise<AcceptedOperationExecution> {
    return this.acceptProgress("continue_interview", input);
  }

  endEarly(input: OperationCommandInput): Promise<StoredOperation> {
    return this.progress("end_interview_early", input);
  }

  acceptEndEarly(input: OperationCommandInput): Promise<AcceptedOperationExecution> {
    return this.acceptProgress("end_interview_early", input);
  }

  abandon(input: OperationCommandInput): Promise<StoredOperation> {
    return this.progress("abandon_interview", input);
  }

  acceptAbandon(input: OperationCommandInput): Promise<AcceptedOperationExecution> {
    return this.acceptProgress("abandon_interview", input);
  }

  retry(input: RetryInterviewOperationInput): Promise<StoredOperation> {
    return this.execute(() => this.runner.retry(input));
  }

  acceptRetry(input: RetryInterviewOperationInput): Promise<AcceptedOperationExecution> {
    return this.runner.acceptRetry(input);
  }

  private progress(
    type: ProgressOperationType,
    input: OperationCommandInput | TextInterviewOperationInput,
  ): Promise<StoredOperation> {
    return this.execute(() =>
      this.runner.run({
        type,
        ...input,
        ...("text" in input ? { text: input.text } : {}),
      }),
    );
  }

  private execute(operation: () => Promise<StoredOperation>): Promise<StoredOperation> {
    return this.execution.execute(operation);
  }

  private acceptProgress(
    type: ProgressOperationType,
    input: OperationCommandInput | TextInterviewOperationInput,
  ): Promise<AcceptedOperationExecution> {
    return this.runner.accept({
      type,
      ...input,
      ...("text" in input ? { text: input.text } : {}),
    });
  }
}
