import type { StoredOperation } from "@interview-agent/db";
import {
  type AnswerEvaluationModel,
  getCurrentQuestion,
  type Interview,
  type InterviewerTextEvent,
  type InterviewerTextModel,
  type InterviewOperationPlan,
  type ModelCallMetadata,
} from "@interview-agent/domain";
import type { ModelOperationFinalizationService } from "./model-operation-finalization.js";
import { OperationRunnerError } from "./operation-errors.js";
import { publishOperationEvent } from "./operation-event-publication.js";
import type { OperationEventPublisher } from "./operation-events.js";
import { classifyModelFailure } from "./operation-failure.js";
import type { ClaimedModelOperation, ModelCompletion } from "./operation-types.js";

export class ModelOperationExecutionService {
  constructor(
    private readonly interviewer: InterviewerTextModel,
    private readonly evaluator: AnswerEvaluationModel,
    private readonly finalization: ModelOperationFinalizationService,
    private readonly events: OperationEventPublisher,
  ) {}

  async execute(execution: ClaimedModelOperation): Promise<StoredOperation> {
    publishOperationEvent(() => this.events.beginAttempt(execution.claimed.operation));
    let completion: ModelCompletion;
    try {
      completion = await this.callModels(execution.plan);
    } catch (error) {
      const failure = classifyModelFailure(error);
      if (failure === null) {
        throw error;
      }
      return this.finalization.fail(execution, failure);
    }
    return this.finalization.complete(execution, completion);
  }

  private async callModels(plan: InterviewOperationPlan): Promise<ModelCompletion> {
    const question = getCurrentQuestion(plan.interview);
    if (plan.operation === "question_clarification") {
      const completed = await collectInterviewerText(
        this.interviewer.stream({ purpose: "clarify_question", question }),
      );
      return {
        kind: "clarification",
        text: completed.text,
        metadata: completed.metadata,
      };
    }

    const questionState = requiredQuestionState(plan.interview, plan.questionPosition);
    const answerMaterial = [...questionState.answerMaterial, plan.material];
    const evaluation = await this.evaluator.evaluate({
      question,
      answerMaterial,
      usedFollowUpGoalIds: new Set(
        questionState.systemFollowUps.map((followUp) => followUp.goalId),
      ),
    });
    if (evaluation.recommendedFollowUpGoal === null) {
      return { kind: "evaluation", evaluation };
    }

    const goal = question.followUpGoals.find(
      (candidate) => candidate.id === evaluation.recommendedFollowUpGoal?.goalId,
    );
    if (goal === undefined) {
      throw new OperationRunnerError("Evaluation selected an unknown follow-up goal");
    }
    const completed = await collectInterviewerText(
      this.interviewer.stream({
        purpose: "phrase_follow_up",
        question,
        goal,
        followUpPurpose: evaluation.recommendedFollowUpGoal.purpose,
        answerMaterial,
      }),
    );
    return {
      kind: "follow_up",
      evaluation,
      text: completed.text,
      metadata: completed.metadata,
    };
  }
}

async function collectInterviewerText(
  events: AsyncIterable<InterviewerTextEvent>,
): Promise<{ readonly text: string; readonly metadata: ModelCallMetadata }> {
  let completed: { readonly text: string; readonly metadata: ModelCallMetadata } | null = null;
  for await (const event of events) {
    if (event.type === "completed") {
      completed = { text: event.text, metadata: event.metadata };
    }
  }
  if (completed === null) {
    throw new OperationRunnerError("Interviewer text stream completed without final text");
  }
  return completed;
}

function requiredQuestionState(interview: Interview, position: number) {
  const question = interview.questions[position - 1];
  if (question === undefined || question.position !== position) {
    throw new OperationRunnerError(`Interview ${interview.id} question state is invalid`);
  }
  return question;
}
