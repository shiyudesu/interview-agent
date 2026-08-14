import type {
  CurrentInterviewResponseDto,
  InterviewDetailResponseDto,
} from "@interview-agent/contracts/responses";
import { queryOptions, type UseQueryResult, useQuery } from "@tanstack/react-query";

import { getActiveInterview, getInterviewDetail } from "./interview-api.js";

export const ACCOUNT_OWNED_QUERY_KEY = ["account-owned"] as const;

export function activeInterviewQueryKey(accountId: string) {
  return [...ACCOUNT_OWNED_QUERY_KEY, accountId, "interview", "active"] as const;
}

export function useActiveInterview(
  accountId: string | undefined,
): UseQueryResult<CurrentInterviewResponseDto | null, Error> {
  return useQuery(
    queryOptions<CurrentInterviewResponseDto | null>({
      queryKey: activeInterviewQueryKey(accountId ?? "signed-out"),
      queryFn: ({ signal }) => getActiveInterview(signal),
      enabled: accountId !== undefined,
    }),
  );
}

export function interviewDetailQueryKey(accountId: string, interviewId: string) {
  return [...ACCOUNT_OWNED_QUERY_KEY, accountId, "interview", interviewId] as const;
}

export function historyQueryKey(accountId: string) {
  return [...ACCOUNT_OWNED_QUERY_KEY, accountId, "history"] as const;
}

export function useInterviewDetail(
  accountId: string | undefined,
  interviewId: string | undefined,
): UseQueryResult<InterviewDetailResponseDto, Error> {
  return useQuery(
    queryOptions<InterviewDetailResponseDto>({
      queryKey: interviewDetailQueryKey(accountId ?? "signed-out", interviewId ?? "missing"),
      queryFn: ({ signal }) => getInterviewDetail(interviewId ?? "", signal),
      enabled: accountId !== undefined && interviewId !== undefined,
    }),
  );
}
