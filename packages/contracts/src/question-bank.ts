import OpenCC from "opencc-js";
import { type Static, Type } from "typebox";
import { Check, Errors } from "typebox/value";

import {
  FollowUpGoalIdSchema,
  IsoTimestampSchema,
  KnowledgeDomainSchema,
  PositiveVersionSchema,
  QuestionIdSchema,
  RubricItemIdSchema,
} from "./common.js";
import { FollowUpKindSchema } from "./evaluation.js";

export const QuestionBankRubricItemSchema = Type.Object(
  {
    id: RubricItemIdSchema,
    description: Type.String({ minLength: 1 }),
    weight: Type.Integer({ minimum: 1, maximum: 100 }),
  },
  { additionalProperties: false },
);

export const QuestionBankFollowUpGoalSchema = Type.Object(
  {
    id: FollowUpGoalIdSchema,
    kind: FollowUpKindSchema,
    goal: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export const QuestionTypeSchema = Type.Union([
  Type.Literal("conceptual"),
  Type.Literal("scenario"),
  Type.Literal("design"),
  Type.Literal("troubleshooting"),
]);

export const QuestionReviewMetadataSchema = Type.Object(
  {
    reviewedBy: Type.String({ minLength: 1, maxLength: 128 }),
    reviewedAt: IsoTimestampSchema,
    simplifiedChineseVerified: Type.Literal(true),
    technicalTermsVerified: Type.Literal(true),
  },
  { additionalProperties: false },
);

export const QuestionBankQuestionSchema = Type.Object(
  {
    id: QuestionIdSchema,
    contentVersion: PositiveVersionSchema,
    domain: KnowledgeDomainSchema,
    difficulty: Type.Literal("medium"),
    questionType: QuestionTypeSchema,
    sourceWording: Type.String({ minLength: 1 }),
    rubric: Type.Array(QuestionBankRubricItemSchema, { minItems: 1, uniqueItems: true }),
    followUpGoals: Type.Array(QuestionBankFollowUpGoalSchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    knowledgeExplanation: Type.String({ minLength: 1 }),
    active: Type.Boolean(),
    reviewed: Type.Boolean(),
    reviewMetadata: Type.Union([QuestionReviewMetadataSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export const QuestionBankSourceSchema = Type.Object(
  {
    schemaVersion: Type.Literal("1.0"),
    domain: KnowledgeDomainSchema,
    questions: Type.Array(QuestionBankQuestionSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const QuestionBankImportSchema = Type.Object(
  {
    schemaVersion: Type.Literal("1.0"),
    sourceName: Type.String({ minLength: 1 }),
    sourceVersion: PositiveVersionSchema,
    importedAt: IsoTimestampSchema,
    questions: Type.Array(QuestionBankQuestionSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const InternalQuestionSnapshotSchema = Type.Object(
  {
    questionId: QuestionIdSchema,
    questionVersion: PositiveVersionSchema,
    domain: KnowledgeDomainSchema,
    sourceWording: Type.String({ minLength: 1 }),
    displayedWording: Type.String({ minLength: 1 }),
    rubric: Type.Array(QuestionBankRubricItemSchema, { minItems: 1 }),
    followUpGoals: Type.Array(QuestionBankFollowUpGoalSchema, { minItems: 1 }),
    knowledgeExplanation: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export interface QuestionBankValidationIssue {
  readonly path: string;
  readonly code:
    | "schema"
    | "blank_text"
    | "rubric_total"
    | "duplicate_rubric_item_id"
    | "duplicate_follow_up_goal_id"
    | "missing_clarification_goal"
    | "active_not_reviewed"
    | "invalid_review_metadata"
    | "source_wording_language"
    | "prohibited_coding_task"
    | "domain_mismatch"
    | "duplicate_question_version";
  readonly message: string;
}

const HAN_CHARACTER_PATTERN = /\p{Script=Han}/gu;
const LATIN_CHARACTER_PATTERN = /\p{Script=Latin}/gu;
const LETTER_PATTERN = /\p{Letter}/u;
const ALLOWED_CHINESE_WORDING_LETTER_PATTERN = /[\p{Script=Han}\p{Script=Latin}]/u;
const FENCED_CODE_PATTERN = /```|~~~/u;
const MIN_SOURCE_HAN_CHARACTERS = 6;
const MIN_SOURCE_HAN_RATIO = 0.15;
const TO_SIMPLIFIED_CHINESE = OpenCC.Converter({ from: "t", to: "cn" });
const CODING_CLAUSE_SEPARATOR_PATTERN = /[。！？.!?，,；;：:\n]+/u;
const CHINESE_IMPLEMENTATION_ACTION_PATTERN = /(?:实现|编写|写出|提交|完成|提供|创建|开发|编码)/gu;
const CHINESE_AMBIGUOUS_ACTION_PATTERN = /(?:写|构建)/gu;
const CHINESE_CONCRETE_ARTIFACT_PATTERN =
  /^(?:一个|一段|一份|该|这个)?[^。！？.!?，,；;：:\n]{0,24}(?:完整源代码|源代码|代码|程序|函数|方法|类|算法|伪代码|脚本|SQL(?:\s*查询)?|查询语句|(?:REST\s*)?API(?:\s*(?:endpoint|端点|接口))?|接口|服务器|缓存|队列|服务|组件|数据结构|连接池)/iu;
const CHINESE_ARTIFACT_ACTION_PATTERN = /(?:撰写|写|补全|修改|修复|调试|运行|执行|给出)/gu;
const CHINESE_CODING_ARTIFACT_PATTERN =
  /(?:完整源代码|源代码|代码|程序|函数|方法|类|算法|伪代码|脚本|SQL(?:\s*查询)?|查询语句|(?:REST\s*)?API(?:\s*(?:endpoint|端点|接口))?|可执行(?:文件|程序)?|自动评测|在线评测|编程题|判题|输入输出格式|stdin|stdout)/iu;
const CHINESE_EXPLANATORY_SUFFIX_PATTERN =
  /(?:时|中).{0,24}(?:需要|应该|应当|要)?(?:考虑|注意)|(?:有哪些|哪些|什么)(?:考虑|因素|取舍|影响|区别|条件|方式|步骤|策略)?/u;
const CHINESE_IMPERATIVE_MARKER_PATTERN =
  /(?:请(?:先|再|直接)?|并|并且|然后|接着|再|同时|此外|需要|必须|应当|你能|能不能|是否能|能否|可否|能|可以(?:请|帮我)?)\s*$/u;
const CHINESE_REQUEST_PREFIX_PATTERN =
  /^(?:请|你能|能不能|是否能|能否|可否|能|可以(?:请|帮我)?)(?!.*(?:解释|说明|分析|讨论|比较).*(?:如何|怎么|怎样)\s*$)/u;
const CHINESE_LANGUAGE_IMPERATIVE_PATTERN =
  /(?:^|请(?:先|再|直接)?|并|并且|然后|接着|再|同时|此外)\s*(?:使用|用)\s*[\p{Letter}\p{Number}+#._ -]{1,32}\s*$/u;
const CHINESE_LOCAL_EXPLANATORY_PREFIX_PATTERN = /(?:如何|怎么|怎样|为何|为什么)\s*$/u;
const CHINESE_EXPLANATORY_FRAMING_PATTERN =
  /^(?:(?:请|能否|可以|可否|是否能|你能)\s*)?(?:解释|说明|分析|讨论|比较)/u;
const CHINESE_IMPERATIVE_CONNECTIVE_PATTERN = /(?:并|并且|然后|接着|再|同时|此外)\s*$/u;
const ENGLISH_CODING_ACTION_PATTERN =
  /\b(?:provide|create|develop|code|implement|write|complete|modify|fix|repair|debug|run|execute|submit)\b/iu;
const ENGLISH_CODING_ARTIFACT_PATTERN =
  /\b(?:source code|code|program|function|algorithm|pseudocode|script|executable|automated judge|online judge|coding challenge)\b/iu;
const ENGLISH_EXPLANATORY_FRAMING_PATTERN =
  /\b(?:explain|describe|discuss|analy[sz]e|compare)\b|\bhow\b.{0,24}\b(?:implement|write|develop)\b/iu;
const CODE_READING_PATTERN =
  /(?:以下|下列|这段|下面(?:的)?).{0,4}代码(?!库|审查|覆盖)|(?:阅读|查看|判断|根据|指出).{0,12}(?:(?:这个|该|以下|下列|这段|下面(?:的)?)\s*)?(?:代码|函数|方法|类|脚本|SQL(?:\s*查询)?|查询语句|(?:REST\s*)?API)|(?:分析|解释).{0,8}(?:这个|该|以下|下列|这段|下面(?:的)?).{0,4}(?:代码|函数|方法|类|脚本|SQL(?:\s*查询)?|查询语句|(?:REST\s*)?API)|(?:read|view|inspect).{0,16}(?:the following|this).{0,8}(?:code|function|method|class|SQL|query|API)|(?:analy[sz]e|explain).{0,16}(?:the following|this).{0,8}(?:code|function|method|class|SQL|query|API)/iu;

function isLocallyImperative(clause: string, actionIndex: number): boolean {
  const beforeAction = clause.slice(0, actionIndex);
  if (beforeAction.trimEnd().endsWith("的")) {
    return false;
  }
  return (
    beforeAction.trim().length === 0 ||
    CHINESE_IMPERATIVE_MARKER_PATTERN.test(beforeAction) ||
    CHINESE_LANGUAGE_IMPERATIVE_PATTERN.test(beforeAction) ||
    CHINESE_REQUEST_PREFIX_PATTERN.test(beforeAction.trim())
  );
}

function isLocallyExplanatory(clause: string, actionIndex: number, actionLength: number): boolean {
  const beforeAction = clause.slice(0, actionIndex);
  const afterAction = clause.slice(actionIndex + actionLength);
  return (
    CHINESE_LOCAL_EXPLANATORY_PREFIX_PATTERN.test(beforeAction) ||
    (CHINESE_EXPLANATORY_FRAMING_PATTERN.test(beforeAction) &&
      !CHINESE_IMPERATIVE_CONNECTIVE_PATTERN.test(beforeAction)) ||
    (actionIndex === 0 && CHINESE_EXPLANATORY_SUFFIX_PATTERN.test(afterAction))
  );
}

function isProhibitedCodingTask(text: string): boolean {
  if (FENCED_CODE_PATTERN.test(text) || CODE_READING_PATTERN.test(text)) {
    return true;
  }
  return text.split(CODING_CLAUSE_SEPARATOR_PATTERN).some((rawClause) => {
    const clause = rawClause.trim();
    for (const action of clause.matchAll(CHINESE_IMPLEMENTATION_ACTION_PATTERN)) {
      if (
        isLocallyImperative(clause, action.index) &&
        !isLocallyExplanatory(clause, action.index, action[0].length)
      ) {
        return true;
      }
    }
    for (const action of clause.matchAll(CHINESE_AMBIGUOUS_ACTION_PATTERN)) {
      const afterAction = clause.slice(action.index + action[0].length);
      if (
        isLocallyImperative(clause, action.index) &&
        !isLocallyExplanatory(clause, action.index, action[0].length) &&
        CHINESE_CONCRETE_ARTIFACT_PATTERN.test(afterAction)
      ) {
        return true;
      }
    }
    for (const action of clause.matchAll(CHINESE_ARTIFACT_ACTION_PATTERN)) {
      const afterAction = clause.slice(action.index + action[0].length);
      if (action[0] === "运行" && afterAction.startsWith("时")) {
        continue;
      }
      if (
        isLocallyImperative(clause, action.index) &&
        !isLocallyExplanatory(clause, action.index, action[0].length) &&
        CHINESE_CODING_ARTIFACT_PATTERN.test(clause)
      ) {
        return true;
      }
    }

    const englishAction = ENGLISH_CODING_ACTION_PATTERN.exec(clause);
    return (
      englishAction !== null &&
      ENGLISH_CODING_ARTIFACT_PATTERN.test(clause) &&
      !ENGLISH_EXPLANATORY_FRAMING_PATTERN.test(clause)
    );
  });
}

export function validateQuestionBankQuestion(
  value: unknown,
): readonly QuestionBankValidationIssue[] {
  if (!Check(QuestionBankQuestionSchema, value)) {
    return [...Errors(QuestionBankQuestionSchema, value)].map((error) => ({
      path: error.instancePath || "/",
      code: "schema" as const,
      message: error.message,
    }));
  }

  const issues: QuestionBankValidationIssue[] = [];
  const requireContent = (text: string, path: string, label: string) => {
    if (text.trim().length === 0) {
      issues.push({
        path,
        code: "blank_text",
        message: `${label} must contain non-whitespace text`,
      });
    }
  };

  requireContent(value.sourceWording, "/sourceWording", "Source wording");
  value.rubric.forEach((item, index) => {
    requireContent(item.description, `/rubric/${index}/description`, "Rubric description");
  });
  value.followUpGoals.forEach((goal, index) => {
    requireContent(goal.goal, `/followUpGoals/${index}/goal`, "Follow-up goal");
  });
  requireContent(value.knowledgeExplanation, "/knowledgeExplanation", "Knowledge explanation");

  const hanCharacterCount = value.sourceWording.match(HAN_CHARACTER_PATTERN)?.length ?? 0;
  const latinCharacterCount = value.sourceWording.match(LATIN_CHARACTER_PATTERN)?.length ?? 0;
  const hanRatio = hanCharacterCount / Math.max(1, hanCharacterCount + latinCharacterCount);
  const hasUnexpectedScript = [...value.sourceWording].some(
    (character) =>
      LETTER_PATTERN.test(character) && !ALLOWED_CHINESE_WORDING_LETTER_PATTERN.test(character),
  );
  if (
    hanCharacterCount < MIN_SOURCE_HAN_CHARACTERS ||
    hanRatio < MIN_SOURCE_HAN_RATIO ||
    hasUnexpectedScript ||
    TO_SIMPLIFIED_CHINESE(value.sourceWording) !== value.sourceWording
  ) {
    issues.push({
      path: "/sourceWording",
      code: "source_wording_language",
      message:
        "Reviewed source wording must contain meaningful Simplified Chinese text while preserving technical terms",
    });
  }

  for (const candidateText of [
    { path: "/sourceWording", text: value.sourceWording },
    ...value.followUpGoals.map((goal, index) => ({
      path: `/followUpGoals/${index}/goal`,
      text: goal.goal,
    })),
  ]) {
    if (isProhibitedCodingTask(candidateText.text)) {
      issues.push({
        path: candidateText.path,
        code: "prohibited_coding_task",
        message:
          "Candidate-facing wording must not request code reading/writing, pseudocode, executable programming, or automated judging",
      });
    }
  }

  if (value.active && !value.reviewed) {
    issues.push({
      path: "/reviewed",
      code: "active_not_reviewed",
      message: "Active questions must be reviewed",
    });
  }
  if (value.reviewed !== (value.reviewMetadata !== null)) {
    issues.push({
      path: "/reviewMetadata",
      code: "invalid_review_metadata",
      message: value.reviewed
        ? "Reviewed questions require review metadata"
        : "Unreviewed questions must not include review metadata",
    });
  } else if (value.reviewMetadata !== null && value.reviewMetadata.reviewedBy.trim().length === 0) {
    issues.push({
      path: "/reviewMetadata/reviewedBy",
      code: "blank_text",
      message: "Reviewer identity must contain non-whitespace text",
    });
  }

  const totalWeight = value.rubric.reduce((total, item) => total + item.weight, 0);
  if (totalWeight !== 100) {
    issues.push({
      path: "/rubric",
      code: "rubric_total",
      message: `Rubric weights must total 100, received ${totalWeight}`,
    });
  }

  for (const [items, path, code, label] of [
    [value.rubric, "/rubric", "duplicate_rubric_item_id", "Rubric item"],
    [value.followUpGoals, "/followUpGoals", "duplicate_follow_up_goal_id", "Follow-up goal"],
  ] as const) {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id)) {
        issues.push({
          path,
          code,
          message: `${label} ID ${item.id} must be unique within a question`,
        });
      }
      seen.add(item.id);
    }
  }

  if (!value.followUpGoals.some((goal) => goal.kind === "clarification")) {
    issues.push({
      path: "/followUpGoals",
      code: "missing_clarification_goal",
      message: "At least one clarification follow-up goal is required",
    });
  }

  return issues;
}

export function validateQuestionBankSource(value: unknown): readonly QuestionBankValidationIssue[] {
  if (!Check(QuestionBankSourceSchema, value)) {
    return [...Errors(QuestionBankSourceSchema, value)].map((error) => ({
      path: error.instancePath || "/",
      code: "schema" as const,
      message: error.message,
    }));
  }

  const issues: QuestionBankValidationIssue[] = [];
  const versions = new Set<string>();
  value.questions.forEach((question, index) => {
    const prefix = `/questions/${index}`;
    for (const issue of validateQuestionBankQuestion(question)) {
      issues.push({
        ...issue,
        path: `${prefix}${issue.path === "/" ? "" : issue.path}`,
      });
    }

    if (question.domain !== value.domain) {
      issues.push({
        path: `${prefix}/domain`,
        code: "domain_mismatch",
        message: `Question domain ${question.domain} must match file domain ${value.domain}`,
      });
    }

    const versionKey = `${question.id}\0${question.contentVersion}`;
    if (versions.has(versionKey)) {
      issues.push({
        path: `${prefix}/contentVersion`,
        code: "duplicate_question_version",
        message: `Question ${question.id} contentVersion ${question.contentVersion} is duplicated`,
      });
    }
    versions.add(versionKey);
  });
  return issues;
}

export type QuestionBankRubricItemDto = Static<typeof QuestionBankRubricItemSchema>;
export type QuestionBankFollowUpGoalDto = Static<typeof QuestionBankFollowUpGoalSchema>;
export type QuestionReviewMetadataDto = Static<typeof QuestionReviewMetadataSchema>;
export type QuestionTypeDto = Static<typeof QuestionTypeSchema>;
export type QuestionBankQuestionDto = Static<typeof QuestionBankQuestionSchema>;
export type QuestionBankSourceDto = Static<typeof QuestionBankSourceSchema>;
export type QuestionBankImportDto = Static<typeof QuestionBankImportSchema>;
export type InternalQuestionSnapshotDto = Static<typeof InternalQuestionSnapshotSchema>;
