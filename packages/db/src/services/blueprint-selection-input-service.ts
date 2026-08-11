import type {
  AccountId,
  BlueprintSelectionInput,
  InterviewId,
  InterviewQuestionCount,
  QuestionBankRepository,
} from "@interview-agent/domain";

export const RECENT_INTERVIEW_AVOIDANCE_LIMIT = 3;
export const BLUEPRINT_SELECTION_ALGORITHM_VERSION = "v1";

export interface LoadBlueprintSelectionInput {
  readonly accountId: AccountId;
  readonly interviewId: InterviewId;
  readonly questionCount: InterviewQuestionCount;
}

export class BlueprintSelectionInputService {
  constructor(private readonly questionBankRepository: QuestionBankRepository) {}

  async load(input: LoadBlueprintSelectionInput): Promise<BlueprintSelectionInput> {
    const eligibleQuestions = await this.questionBankRepository.listEligibleQuestions();
    const recentQuestionIds = await this.questionBankRepository.findRecentQuestionIds(
      input.accountId,
      RECENT_INTERVIEW_AVOIDANCE_LIMIT,
    );
    return {
      questionCount: input.questionCount,
      selectionSeed: selectionSeedForInterview(input.interviewId),
      eligibleQuestions,
      recentQuestionIds,
    };
  }
}

export function selectionSeedForInterview(interviewId: InterviewId): string {
  return `interview-blueprint:${BLUEPRINT_SELECTION_ALGORITHM_VERSION}:${interviewId}`;
}
