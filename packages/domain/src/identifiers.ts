declare const domainIdentifierBrand: unique symbol;

type DomainIdentifier<Name extends string> = string & {
  readonly [domainIdentifierBrand]: Name;
};

const MAX_IDENTIFIER_LENGTH = 128;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export class InvalidIdentifierError extends Error {
  constructor(
    readonly identifierName: string,
    readonly reason: string,
  ) {
    super(`Invalid ${identifierName}: ${reason}`);
    this.name = "InvalidIdentifierError";
  }
}

function parseIdentifier<Name extends string>(
  identifierName: Name,
  value: string,
): DomainIdentifier<Name> {
  if (value.length === 0) {
    throw new InvalidIdentifierError(identifierName, "value is empty");
  }

  if (value.length > MAX_IDENTIFIER_LENGTH) {
    throw new InvalidIdentifierError(
      identifierName,
      `value exceeds ${MAX_IDENTIFIER_LENGTH} characters`,
    );
  }

  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new InvalidIdentifierError(identifierName, "value contains unsupported characters");
  }

  return value as DomainIdentifier<Name>;
}

export type AccountId = DomainIdentifier<"AccountId">;
export type AnswerMaterialId = DomainIdentifier<"AnswerMaterialId">;
export type DeletionRequestId = DomainIdentifier<"DeletionRequestId">;
export type EvaluationId = DomainIdentifier<"EvaluationId">;
export type FollowUpGoalId = DomainIdentifier<"FollowUpGoalId">;
export type InterviewId = DomainIdentifier<"InterviewId">;
export type MessageId = DomainIdentifier<"MessageId">;
export type OperationId = DomainIdentifier<"OperationId">;
export type QuestionId = DomainIdentifier<"QuestionId">;
export type ReportId = DomainIdentifier<"ReportId">;
export type RubricItemId = DomainIdentifier<"RubricItemId">;

export const parseAccountId = (value: string): AccountId => parseIdentifier("AccountId", value);
export const parseAnswerMaterialId = (value: string): AnswerMaterialId =>
  parseIdentifier("AnswerMaterialId", value);
export const parseDeletionRequestId = (value: string): DeletionRequestId =>
  parseIdentifier("DeletionRequestId", value);
export const parseEvaluationId = (value: string): EvaluationId =>
  parseIdentifier("EvaluationId", value);
export const parseFollowUpGoalId = (value: string): FollowUpGoalId =>
  parseIdentifier("FollowUpGoalId", value);
export const parseInterviewId = (value: string): InterviewId =>
  parseIdentifier("InterviewId", value);
export const parseMessageId = (value: string): MessageId => parseIdentifier("MessageId", value);
export const parseOperationId = (value: string): OperationId =>
  parseIdentifier("OperationId", value);
export const parseQuestionId = (value: string): QuestionId => parseIdentifier("QuestionId", value);
export const parseReportId = (value: string): ReportId => parseIdentifier("ReportId", value);
export const parseRubricItemId = (value: string): RubricItemId =>
  parseIdentifier("RubricItemId", value);
