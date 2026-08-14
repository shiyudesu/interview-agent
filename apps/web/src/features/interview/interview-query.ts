import type { CurrentInterviewResponseDto } from "@interview-agent/contracts/responses";
import { queryOptions, type UseQueryResult, useQuery } from "@tanstack/react-query";

import { getActiveInterview } from "./interview-api.js";

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
