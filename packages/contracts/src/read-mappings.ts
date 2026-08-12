import type { AccountId, InterviewId, ReportId } from "@interview-agent/domain";

import {
  ContractMappingError,
  parseMappedDto,
  serializeIsoTimestamp,
} from "./mapping-validation.js";
import {
  type AccountResponseDto,
  AccountResponseSchema,
  type InterviewHistoryItemDto,
  InterviewHistoryItemSchema,
  type InterviewHistoryResponseDto,
  InterviewHistoryResponseSchema,
} from "./responses.js";

export interface AccountAccessResponseProjection {
  readonly profile: {
    readonly accountId: AccountId;
    readonly name: string | null;
    readonly email: string;
    readonly createdAt: Date;
  };
  readonly linkedIdentities: readonly {
    readonly providerId: "email-otp" | "github";
    readonly providerAccountId: string;
    readonly linkedAt: Date;
  }[];
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly expiresAt: Date;
    readonly createdAt: Date;
    readonly updatedAt: Date;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
    readonly current: boolean;
  }[];
}

export interface InterviewHistoryResponseProjection {
  readonly interviewId: InterviewId;
  readonly createdAt: Date;
  readonly endedAt: Date;
  readonly direction: "go_backend";
  readonly questionCount: 5 | 10 | 15;
  readonly status: "completed" | "early_ended" | "abandoned";
  readonly overallScore: number | null;
  readonly reportId: ReportId | null;
}

export function mapAccountAccessToResponse(
  account: AccountAccessResponseProjection,
): AccountResponseDto {
  return parseMappedDto(
    AccountResponseSchema,
    {
      id: String(account.profile.accountId),
      email: account.profile.email,
      displayName: account.profile.name,
      linkedIdentities: account.linkedIdentities.map((identity) => ({
        provider: identity.providerId === "email-otp" ? "email_otp" : "github",
        providerAccountId: identity.providerAccountId,
        linkedAt: serializeIsoTimestamp(identity.linkedAt, "linked identity linkedAt"),
      })),
      sessions: account.sessions.map((session) => ({
        id: session.sessionId,
        expiresAt: serializeIsoTimestamp(session.expiresAt, "account session expiresAt"),
        createdAt: serializeIsoTimestamp(session.createdAt, "account session createdAt"),
        updatedAt: serializeIsoTimestamp(session.updatedAt, "account session updatedAt"),
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        current: session.current,
      })),
      createdAt: serializeIsoTimestamp(account.profile.createdAt, "account createdAt"),
    },
    "account response",
  );
}

export function mapInterviewHistoryItemToResponse(
  entry: InterviewHistoryResponseProjection,
): InterviewHistoryItemDto {
  if (entry.endedAt.getTime() < entry.createdAt.getTime()) {
    throw new ContractMappingError("interview history item", [
      {
        path: "/endedAt",
        code: "invalid_chronology",
        message: "Interview end timestamp cannot precede its start timestamp",
      },
    ]);
  }

  const base = {
    id: String(entry.interviewId),
    status: entry.status,
    direction: entry.direction,
    questionCount: entry.questionCount,
    startedAt: serializeIsoTimestamp(entry.createdAt, "history startedAt"),
    endedAt: serializeIsoTimestamp(entry.endedAt, "history endedAt"),
  };
  const mapped =
    entry.status === "completed"
      ? {
          ...base,
          status: "completed",
          overallScore: entry.overallScore,
          reportId: entry.reportId === null ? null : String(entry.reportId),
        }
      : entry.status === "early_ended"
        ? {
            ...base,
            status: "early_ended",
            reportId: entry.reportId === null ? null : String(entry.reportId),
          }
        : {
            ...base,
            status: "abandoned",
          };
  return parseMappedDto(InterviewHistoryItemSchema, mapped, "interview history item");
}

export function mapInterviewHistoryToResponse(
  entries: readonly InterviewHistoryResponseProjection[],
  pageInfo: InterviewHistoryResponseDto["pageInfo"],
): InterviewHistoryResponseDto {
  return parseMappedDto(
    InterviewHistoryResponseSchema,
    {
      items: entries.map(mapInterviewHistoryItemToResponse),
      pageInfo,
    },
    "interview history response",
  );
}
