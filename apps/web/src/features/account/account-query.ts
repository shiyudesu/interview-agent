import {
  type AccountResponseDto,
  isAccountResponseDto,
} from "@interview-agent/contracts/responses";
import { queryOptions, type UseQueryResult, useQuery } from "@tanstack/react-query";

import { apiClient } from "../../lib/api-client.js";

export const ACCOUNT_QUERY_KEY = ["account"] as const;

const accountQuery = queryOptions<AccountResponseDto>({
  queryKey: ACCOUNT_QUERY_KEY,
  queryFn: ({ signal }) =>
    apiClient.request("/api/v1/account", {
      decode(value) {
        if (!isAccountResponseDto(value)) {
          throw new TypeError("Invalid account response");
        }
        return value;
      },
      signal,
    }),
});

export function useCurrentAccount(): UseQueryResult<AccountResponseDto, Error> {
  return useQuery(accountQuery);
}
