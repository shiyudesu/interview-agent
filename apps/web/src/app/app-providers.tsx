import { QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";

import { appQueryClient } from "../lib/query-client.js";

export function AppProviders({ children }: PropsWithChildren) {
  return <QueryClientProvider client={appQueryClient}>{children}</QueryClientProvider>;
}
