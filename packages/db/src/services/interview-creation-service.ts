import {
  type AccountId,
  type BlueprintSelector,
  DeterministicBlueprintSelector,
  handleInterviewCommand,
  type InterviewId,
  type InterviewQuestionCount,
  type InterviewTransition,
  type OperationId,
} from "@interview-agent/domain";

import type { PgRepositories, PgRepositoryUnitOfWork } from "../repositories/unit-of-work.js";
import { BlueprintSelectionInputService } from "./blueprint-selection-input-service.js";

export interface CreateInterviewInput {
  readonly accountId: AccountId;
  readonly interviewId: InterviewId;
  readonly operationId: OperationId;
  readonly questionCount: InterviewQuestionCount;
  readonly occurredAt: Date;
  readonly expectedVersion?: number;
}

export class ActiveInterviewExistsError extends Error {
  constructor(readonly interviewId: InterviewId) {
    super(`Account already has active interview ${interviewId}`);
    this.name = "ActiveInterviewExistsError";
  }
}

export class InterviewCreationService {
  constructor(
    private readonly unitOfWork: PgRepositoryUnitOfWork,
    private readonly blueprintSelector: BlueprintSelector = new DeterministicBlueprintSelector(),
  ) {}

  create(input: CreateInterviewInput): Promise<InterviewTransition> {
    return this.unitOfWork.run((repositories) => this.createWithRepositories(repositories, input), {
      isolationLevel: "serializable",
      accessMode: "read write",
    });
  }

  async createWithRepositories(
    repositories: PgRepositories,
    input: CreateInterviewInput,
  ): Promise<InterviewTransition> {
    const activeInterview = await repositories.interviews.findActiveByAccountId(input.accountId);
    if (activeInterview !== null) {
      throw new ActiveInterviewExistsError(activeInterview.id);
    }

    const selectionInput = await new BlueprintSelectionInputService(repositories.questionBank).load(
      {
        accountId: input.accountId,
        interviewId: input.interviewId,
        questionCount: input.questionCount,
      },
    );
    const blueprint = this.blueprintSelector.select(selectionInput);
    const result = handleInterviewCommand(null, {
      type: "create_interview",
      accountId: input.accountId,
      interviewId: input.interviewId,
      operationId: input.operationId,
      expectedVersion: input.expectedVersion ?? 0,
      questionCount: input.questionCount,
      blueprint,
      occurredAt: input.occurredAt,
    });
    if (result.kind !== "transition") {
      throw new Error("Interview creation unexpectedly returned an Operation plan");
    }
    await repositories.interviews.create(result.interview);
    return result;
  }
}
