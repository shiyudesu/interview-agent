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
    | "duplicate_question_version"
    | "duplicate_active_question_id"
    | "stale_active_question_version"
    | "release_cardinality";
  readonly message: string;
}

const HAN_CHARACTER_PATTERN = /\p{Script=Han}/gu;
const LATIN_CHARACTER_PATTERN = /\p{Script=Latin}/gu;
const LETTER_PATTERN = /\p{Letter}/u;
const ALLOWED_CHINESE_WORDING_LETTER_PATTERN = /[\p{Script=Han}\p{Script=Latin}]/u;
const FENCED_CODE_PATTERN = /```|~~~/u;
const MIN_SOURCE_HAN_CHARACTERS = 6;
const MIN_SOURCE_HAN_RATIO = 0.3;
const TO_SIMPLIFIED_CHINESE = OpenCC.Converter({ from: "t", to: "cn" });
const CODING_CLAUSE_SEPARATOR_PATTERN =
  /[。！？!?，,；;：:\n]+|(?<![A-Za-z0-9_])\.(?![A-Za-z0-9_])/u;
const CHINESE_IMPLEMENTATION_ACTION_PATTERN =
  /(?:实现|编写|编码|开发|创建|构建|搭建|修复|修改|补全|调试)/gu;
const CHINESE_ARTIFACT_ACTION_PATTERN =
  /(?:写出|写|撰写|提供|展示|给出|提交|完成|运行|执行|交付|优化|生成|输出)/gu;
const UNAMBIGUOUS_ARTIFACT_ACTIONS = new Set(["完成", "生成", "输出", "提交", "交付"]);
const CHINESE_CODING_ARTIFACT_PATTERN =
  /(?:完整源代码|源代码|代码|程序|函数|方法|类|算法|伪代码|脚本|命令|(?:容器|Docker)\s*镜像|可运行(?:的)?(?:服务|程序|应用|项目|产物)|SQL(?:\s*查询)?|查询语句|(?:REST\s*)?API(?:\s*(?:endpoint|端点|接口))?|(?:数据库|数据)?访问层|可执行(?:文件|程序|产物)?|自动评测|在线评测|编程题|判题|输入输出格式|stdin|stdout)/iu;
const CHINESE_DIRECT_DELIVERABLE_PATTERN =
  /^(?:一个|一段|一份|该|这个)?[^。！？.!?，,；;：:\n]{0,16}(?:完整源代码|源代码|代码|程序|伪代码|脚本|命令|(?:容器|Docker)\s*镜像|可运行(?:的)?(?:服务|程序|应用|项目|产物)|(?:REST\s*)?API|数据?访问层|可执行(?:文件|程序|产物)?)/iu;
const CHINESE_WRITING_TARGET_PATTERN =
  /^(?:一个|一段|一份|该|这个)?[^。！？.!?，,；;：:\n]{0,24}(?:完整源代码|源代码|代码|程序|函数|方法|类|算法|伪代码|脚本|命令|(?:容器|Docker)\s*镜像|SQL(?:\s*查询)?|查询语句|(?:REST\s*)?API|数据?访问层|服务器|缓存|队列|服务|组件|数据结构|连接池)/iu;
const CHINESE_EXPLANATORY_SUFFIX_PATTERN =
  /(?:时|中).{0,24}(?:需要|应该|应当|要)?(?:考虑|注意)|(?:有何|有哪些|哪些|什么)(?:考虑|因素|取舍|影响|区别|条件|方式|步骤|策略|风险|问题|困难)?/u;
const CHINESE_IMPERATIVE_MARKER_PATTERN =
  /(?:请(?:先|再|直接)?|并|并且|然后|接着|再|同时|此外|需要|必须|应当|你能|能不能|是否能|能否|可否|能|可以(?:请|帮我)?)\s*$/u;
const CHINESE_REQUEST_PREFIX_PATTERN =
  /^(?:请|你能|能不能|是否能|能否|可否|能|可以(?:请|帮我)?)(?!.*(?:解释|说明|分析|讨论|比较).*(?:如何|怎么|怎样)\s*$)/u;
const CHINESE_LANGUAGE_IMPERATIVE_PATTERN =
  /(?:^|请(?:先|再|直接)?|并|并且|然后|接着|再|同时|此外)\s*(?:使用|用)\s*[\p{Letter}\p{Number}+#._ -]{1,32}\s*$/u;
const CHINESE_LOCAL_EXPLANATORY_PREFIX_PATTERN = /(?:如何|怎么|怎样|为何|为什么)\s*$/u;
const CHINESE_EXPLANATORY_FRAMING_PATTERN =
  /^(?:(?:请|能否|可以|可否|是否能|你能)\s*)?(?:解释|说明|分析|讨论|比较|概述|阐述|介绍|总结|谈谈|列举|指出)|^请提供一种/u;
const CHINESE_IMPERATIVE_CONNECTIVE_PATTERN = /(?:并|并且|然后|接着|再|同时|此外)\s*$/u;
const CHINESE_CONCEPTUAL_OUTPUT_PATTERN =
  /(?:思路|常见原因|原因|原理|机制|流程|策略|取舍|影响|风险|优缺点|适用场景|场景|区别|(?:适用|触发|必要|前置)条件|排查方法|学习方向)(?:是什么|有哪些|如何|为什么|为何|吗|？|$)/u;
const ENGLISH_CODING_ACTION_PATTERN =
  /\b(?:create|develop|code|implement|write|modify|fix|repair|debug|run|execute|submit|build)\b/iu;
const ENGLISH_AMBIGUOUS_ACTION_PATTERN = /\b(?:provide|show|display|describe|complete|deliver)\b/iu;
const ENGLISH_CODING_ARTIFACT_PATTERN =
  /\b(?:source code|code|program|function|algorithm|pseudocode|script|executable|automated judge|online judge|coding challenge)\b/iu;
const ENGLISH_EXPLANATORY_FRAMING_PATTERN =
  /\b(?:explain|describe|discuss|analy[sz]e|compare)\b|\bhow\b.{0,24}\b(?:implement|write|develop)\b/iu;
const NONTECHNICAL_ENGLISH_PROSE_PATTERN =
  /\b(?:please|explain|describe|discuss|analy[sz]e|provide|show|implement|create|reclaims?|returns?|uses?|causes?|improves?|reduces?|handles?|works?|automatically|because|when|where|which|that|these|those|with|without|from|into|during|before|after|is|are|was|were|does|can|should|would|could|will)\b/iu;
const INLINE_TECHNICAL_IDENTIFIER_PATTERN =
  /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b/gu;
const QUALIFIED_IDENTIFIER_REFERENCE_PATTERN =
  /\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b/u;
const BACKTICK_SPAN_PATTERN = /`([^`\n]+)`/gu;
const NAMED_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_.]*$/u;
const TECHNICAL_COMPOUND_PATTERN = /\b[A-Za-z][A-Za-z0-9]*(?:[-/][A-Za-z][A-Za-z0-9]*)+\b/gu;
const TECHNICAL_ENGLISH_PHRASE_PATTERN =
  /\b(?:happens\s+before|write\s+ahead\s+log|compare\s+and\s+swap|copy\s+on\s+write|read\s+write\s+lock)\b/giu;
const LATIN_WORD_PATTERN = /\b[A-Za-z][A-Za-z0-9]*\b/gu;
const ENGLISH_WORD_SEQUENCE_PATTERN = /\b[A-Za-z]{3,}(?:\s+[A-Za-z]{3,}){2,}\b/gu;
const ENGLISH_PREDICATE_WORD_PATTERN = /(?:s|ed|ing|ly)$/iu;
const TECHNICAL_ENGLISH_CONNECTORS = new Set(["ahead", "and", "before", "of", "on", "to"]);
const TECHNICAL_ENGLISH_WORDS = new Set([
  "alive",
  "algorithm",
  "api",
  "bash",
  "binary",
  "breaker",
  "cache",
  "call",
  "channel",
  "circuit",
  "class",
  "client",
  "collection",
  "compare",
  "concurrency",
  "connection",
  "context",
  "copy",
  "database",
  "docker",
  "endpoint",
  "function",
  "garbage",
  "gc",
  "go",
  "goroutine",
  "grpc",
  "happens",
  "heap",
  "http",
  "https",
  "index",
  "interface",
  "kafka",
  "keep",
  "least",
  "lock",
  "log",
  "lru",
  "map",
  "method",
  "module",
  "mutex",
  "object",
  "package",
  "pool",
  "postgres",
  "postgresql",
  "procedure",
  "queue",
  "read",
  "recently",
  "redis",
  "remote",
  "rest",
  "rpc",
  "runtime",
  "scheduler",
  "server",
  "sql",
  "stack",
  "storage",
  "swap",
  "tcp",
  "thread",
  "transaction",
  "tree",
  "udp",
  "used",
  "write",
]);
const SQL_MODIFICATION_PATTERN =
  /(?:(?:以下|下列|这个|该|这条|下面(?:的)?)\s*(?:SQL(?:\s*查询)?|查询(?:语句)?)).{0,20}(?:优化|修改|修复|改写)|(?:优化|修改|修复|改写).{0,20}(?:(?:以下|下列|这个|该|这条|下面(?:的)?)\s*(?:SQL(?:\s*查询)?|查询(?:语句)?))/iu;
const CODE_OUTPUT_PREDICTION_PATTERN =
  /(?:(?:以下|下列|这个|该|这段|下面(?:的)?)\s*)?(?:代码|程序|函数|方法|表达式|脚本|SQL(?:\s*查询)?|查询语句).{0,32}(?:输出(?:什么|结果|是什么)|运行结果|返回(?:什么|结果是什么)|是否报错|会报错|报什么错)|(?:输出(?:什么|结果|是什么)|运行结果|返回(?:什么|结果是什么)|是否报错|会报错|报什么错).{0,32}(?:代码|程序|函数|方法|表达式|脚本|SQL(?:\s*查询)?|查询语句)/iu;
const DEICTIC_FUNCTION_READING_PATTERN =
  /(?:分析|解释|说明|描述|指出|判断).{0,12}(?:以下|下列|这个|该|这段|下面(?:的)?)\s*(?:函数|方法|类)/u;
const PSEUDOCODE_FORMAT_REQUEST_PATTERN =
  /(?:请|需要|必须|应当)?\s*(?:使用|用|以|通过)\s*伪代码(?:的?形式)?\s*(?:描述|说明|展示|给出|回答|表示|实现)/u;
const EXECUTABLE_DELIVERY_PATTERN =
  /(?:交付|提交|提供|展示|给出|生成|输出).{0,24}(?:可运行|可执行).{0,16}(?:服务|程序|应用|项目|产物|文件|脚本|镜像)/u;
const AUTOMATED_JUDGING_TASK_PATTERN =
  /(?:提交|完成|作答).{0,32}(?:自动评测|在线评测|判题)|(?:系统|平台|答案).{0,12}(?:会|将|负责|被)\s*(?:自动评测|判题)/u;
const EXPLICIT_PROGRAMMING_TASK_PATTERN =
  /(?:(?:你的|本题|这道题|当前)(?:任务|要求)(?:是|为)?|这(?:是)?一道).{0,40}(?:实现|编写|编码|开发|编程题|在线评测)/u;
const CODE_READING_PATTERN =
  /(?:以下|下列|这段|下面(?:的)?).{0,4}代码(?!库|审查|覆盖)|(?:阅读|查看|判断|根据|指出|审查).{0,12}(?:(?:这个|该|以下|下列|这段|下面(?:的)?)\s*)?(?:代码|函数|方法|类|脚本|SQL(?:\s*查询)?|查询语句|(?:REST\s*)?API)|(?:分析|解释|说明|描述).{0,8}(?:这个|该|以下|下列|这段|下面(?:的)?).{0,4}(?:代码|脚本|SQL(?:\s*查询)?|查询语句|(?:REST\s*)?API)|(?:read|view|inspect).{0,16}(?:the following|this).{0,8}(?:code|function|method|class|SQL|query|API)|(?:analy[sz]e|explain|describe).{0,16}(?:the following|this).{0,8}(?:code|function|method|class|SQL|query|API)/iu;

function isTechnicalEnglishWord(word: string): boolean {
  return (
    TECHNICAL_ENGLISH_WORDS.has(word.toLowerCase()) ||
    (word.length >= 2 && word === word.toUpperCase()) ||
    /[a-z][A-Z]/u.test(word)
  );
}

function isInlineTechnicalReference(content: string): boolean {
  const trimmed = content.trim();
  if (
    NAMED_IDENTIFIER_PATTERN.test(trimmed) ||
    /^[A-Za-z_][A-Za-z0-9_.]*\([^`\n]*\)$/u.test(trimmed)
  ) {
    return true;
  }
  const words = trimmed.match(LATIN_WORD_PATTERN) ?? [];
  return (
    words.length > 0 &&
    words.length <= 4 &&
    words.every(
      (word) =>
        isTechnicalEnglishWord(word) || TECHNICAL_ENGLISH_CONNECTORS.has(word.toLowerCase()),
    )
  );
}

function stripInlineTechnicalReferences(text: string): string {
  return text
    .replace(TECHNICAL_ENGLISH_PHRASE_PATTERN, "")
    .replace(BACKTICK_SPAN_PATTERN, (span, content: string) =>
      isInlineTechnicalReference(content) ? "" : span.slice(1, -1),
    )
    .replace(INLINE_TECHNICAL_IDENTIFIER_PATTERN, "");
}

function hasNamedIdentifierReference(text: string): boolean {
  return (
    QUALIFIED_IDENTIFIER_REFERENCE_PATTERN.test(text) ||
    [...text.matchAll(BACKTICK_SPAN_PATTERN)].some((match) =>
      NAMED_IDENTIFIER_PATTERN.test(match[1]?.trim() ?? ""),
    )
  );
}

function hasInlineCodeReading(text: string): boolean {
  const hasCodeLikeSpan = [...text.matchAll(BACKTICK_SPAN_PATTERN)].some((match) =>
    /(?:\bfunc\b|\breturn\b|:=|[{};]|\n)/u.test(match[1] ?? ""),
  );
  return (
    hasCodeLikeSpan && /(?:阅读|查看|审查|分析|解释|说明|判断|指出|输出|结果|报错|错误)/u.test(text)
  );
}

function stripTechnicalEnglish(text: string): string {
  return stripInlineTechnicalReferences(text)
    .replace(TECHNICAL_COMPOUND_PATTERN, (compound) => {
      const parts = compound.split(/[-/]/u);
      return parts.every(
        (part) =>
          isTechnicalEnglishWord(part) || TECHNICAL_ENGLISH_CONNECTORS.has(part.toLowerCase()),
      )
        ? ""
        : compound;
    })
    .replace(LATIN_WORD_PATTERN, (word) => (isTechnicalEnglishWord(word) ? "" : word));
}

function containsEnglishProse(text: string): boolean {
  const candidate = stripInlineTechnicalReferences(text).replace(
    TECHNICAL_COMPOUND_PATTERN,
    (compound) => {
      const parts = compound.split(/[-/]/u);
      return parts.every(
        (part) =>
          isTechnicalEnglishWord(part) || TECHNICAL_ENGLISH_CONNECTORS.has(part.toLowerCase()),
      )
        ? ""
        : compound;
    },
  );
  const nontechnicalCandidate = candidate.replace(LATIN_WORD_PATTERN, (word) =>
    isTechnicalEnglishWord(word) ? "" : word,
  );
  if (NONTECHNICAL_ENGLISH_PROSE_PATTERN.test(nontechnicalCandidate)) {
    return true;
  }
  return [...candidate.matchAll(ENGLISH_WORD_SEQUENCE_PATTERN)].some((match) => {
    const nontechnicalWords = match[0]
      .split(/\s+/u)
      .filter((word) => !isTechnicalEnglishWord(word));
    return (
      nontechnicalWords.length >= 3 &&
      nontechnicalWords.slice(1).some((word) => ENGLISH_PREDICATE_WORD_PATTERN.test(word))
    );
  });
}

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
  if (
    FENCED_CODE_PATTERN.test(text) ||
    CODE_READING_PATTERN.test(text) ||
    CODE_OUTPUT_PREDICTION_PATTERN.test(text) ||
    SQL_MODIFICATION_PATTERN.test(text) ||
    PSEUDOCODE_FORMAT_REQUEST_PATTERN.test(text) ||
    EXECUTABLE_DELIVERY_PATTERN.test(text) ||
    AUTOMATED_JUDGING_TASK_PATTERN.test(text) ||
    EXPLICIT_PROGRAMMING_TASK_PATTERN.test(text) ||
    hasInlineCodeReading(text)
  ) {
    return true;
  }
  return text.split(CODING_CLAUSE_SEPARATOR_PATTERN).some((rawClause) => {
    const clause = rawClause.trim();
    if (DEICTIC_FUNCTION_READING_PATTERN.test(clause) && !hasNamedIdentifierReference(clause)) {
      return true;
    }
    const requestsConceptualOutput = CHINESE_CONCEPTUAL_OUTPUT_PATTERN.test(clause);
    for (const action of clause.matchAll(CHINESE_IMPLEMENTATION_ACTION_PATTERN)) {
      if (
        isLocallyImperative(clause, action.index) &&
        !isLocallyExplanatory(clause, action.index, action[0].length)
      ) {
        return true;
      }
    }
    for (const action of clause.matchAll(CHINESE_ARTIFACT_ACTION_PATTERN)) {
      const afterAction = clause.slice(action.index + action[0].length);
      if (
        isLocallyImperative(clause, action.index) &&
        !isLocallyExplanatory(clause, action.index, action[0].length) &&
        (CHINESE_DIRECT_DELIVERABLE_PATTERN.test(afterAction) ||
          (UNAMBIGUOUS_ARTIFACT_ACTIONS.has(action[0]) &&
            CHINESE_WRITING_TARGET_PATTERN.test(afterAction)) ||
          (action[0] === "写" &&
            !requestsConceptualOutput &&
            CHINESE_WRITING_TARGET_PATTERN.test(afterAction)))
      ) {
        return true;
      }
      if (
        !requestsConceptualOutput &&
        isLocallyImperative(clause, action.index) &&
        !isLocallyExplanatory(clause, action.index, action[0].length) &&
        CHINESE_CODING_ARTIFACT_PATTERN.test(clause)
      ) {
        return true;
      }
    }

    const englishAction = ENGLISH_CODING_ACTION_PATTERN.exec(clause);
    if (
      englishAction !== null &&
      ENGLISH_CODING_ARTIFACT_PATTERN.test(clause) &&
      !ENGLISH_EXPLANATORY_FRAMING_PATTERN.test(clause)
    ) {
      return true;
    }
    const ambiguousEnglishAction = ENGLISH_AMBIGUOUS_ACTION_PATTERN.exec(clause);
    return (
      ambiguousEnglishAction !== null &&
      ENGLISH_CODING_ARTIFACT_PATTERN.test(clause) &&
      !ENGLISH_EXPLANATORY_FRAMING_PATTERN.test(clause)
    );
  });
}

function hasMeaningfulSimplifiedChinese(
  text: string,
  minimumHanCharacters: number,
  minimumHanRatio: number,
): boolean {
  const hanCharacterCount = text.match(HAN_CHARACTER_PATTERN)?.length ?? 0;
  const languageRatioCandidate = stripTechnicalEnglish(text);
  const latinCharacterCount = languageRatioCandidate.match(LATIN_CHARACTER_PATTERN)?.length ?? 0;
  const hanRatio = hanCharacterCount / Math.max(1, hanCharacterCount + latinCharacterCount);
  const hasUnexpectedScript = [...text].some(
    (character) =>
      LETTER_PATTERN.test(character) && !ALLOWED_CHINESE_WORDING_LETTER_PATTERN.test(character),
  );
  return (
    hanCharacterCount >= minimumHanCharacters &&
    hanRatio >= minimumHanRatio &&
    !hasUnexpectedScript &&
    !containsEnglishProse(text) &&
    TO_SIMPLIFIED_CHINESE(text) === text
  );
}

export function isMeaningfulSimplifiedChineseText(text: string): boolean {
  return hasMeaningfulSimplifiedChinese(text, 2, 0.2);
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

  if (
    !hasMeaningfulSimplifiedChinese(
      value.sourceWording,
      MIN_SOURCE_HAN_CHARACTERS,
      MIN_SOURCE_HAN_RATIO,
    )
  ) {
    issues.push({
      path: "/sourceWording",
      code: "source_wording_language",
      message:
        "Reviewed source wording must contain meaningful Simplified Chinese text while preserving technical terms",
    });
  }

  for (const candidateText of [
    ...value.rubric.map((item, index) => ({
      path: `/rubric/${index}/description`,
      text: item.description,
      minimumHanCharacters: 2,
    })),
    ...value.followUpGoals.map((goal, index) => ({
      path: `/followUpGoals/${index}/goal`,
      text: goal.goal,
      minimumHanCharacters: 2,
    })),
    {
      path: "/knowledgeExplanation",
      text: value.knowledgeExplanation,
      minimumHanCharacters: 4,
    },
  ]) {
    if (
      !hasMeaningfulSimplifiedChinese(candidateText.text, candidateText.minimumHanCharacters, 0.2)
    ) {
      issues.push({
        path: candidateText.path,
        code: "source_wording_language",
        message:
          "Question-bank text must use meaningful Simplified Chinese while preserving technical terms",
      });
    }
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
