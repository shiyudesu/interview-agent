import {
  AnswerEvaluationModelError,
  type AnswerEvaluationModelErrorCode,
} from "./answer-evaluation-model.js";
import {
  InterviewerTextModelError,
  type InterviewerTextModelErrorCode,
} from "./interviewer-text-model.js";
import { OperationRunnerError } from "./operation-errors.js";
import type { OperationFailure } from "./operation-types.js";
import { ReportAnalysisModelError } from "./report-analysis-model.js";

export function operationFailure(
  message: string,
  retryable: boolean,
  classification?: OperationFailure["classification"],
): OperationFailure {
  return {
    code: "operation_failed",
    message: message.trim().length === 0 ? "Operation failed" : message,
    retryable,
    ...(classification === undefined ? {} : { classification }),
  };
}

export function classifyModelFailure(error: unknown): OperationFailure | null {
  if (error instanceof AnswerEvaluationModelError) {
    return modelFailure(error.code, error.message);
  }
  if (error instanceof InterviewerTextModelError) {
    return modelFailure(error.code, error.message);
  }
  return null;
}

export function classifyReportFailure(error: unknown): OperationFailure | null {
  if (error instanceof ReportAnalysisModelError) {
    return {
      code: "model_failure",
      message: "Report analysis failed",
      retryable: true,
    };
  }
  if (error instanceof OperationRunnerError) {
    return {
      code: "operation_failed",
      message: "Report generation failed",
      retryable: true,
    };
  }
  return null;
}

function modelFailure(
  code: AnswerEvaluationModelErrorCode | InterviewerTextModelErrorCode,
  message: string,
): OperationFailure {
  return {
    code: "model_failure",
    message,
    retryable: code !== "invalid_request",
  };
}
