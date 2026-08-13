import { QueryClient } from "@tanstack/react-query";

import { ApiClientError } from "./api-client.js";

export function createAppQueryClient() {
  return new QueryClient({
    defaultOptions: {
      mutations: {
        retry: false,
      },
      queries: {
        refetchOnWindowFocus: false,
        retry(failureCount, error) {
          if (error instanceof ApiClientError && error.status >= 400 && error.status < 500) {
            return false;
          }
          return failureCount < 1;
        },
        staleTime: 15_000,
      },
    },
  });
}

export const appQueryClient = createAppQueryClient();
