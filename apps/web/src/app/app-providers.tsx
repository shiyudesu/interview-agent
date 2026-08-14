import { QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { useEffect } from "react";

import { appQueryClient } from "../lib/query-client.js";

export function AppProviders({ children }: PropsWithChildren) {
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === "interview-agent:account-deleted" && event.newValue !== null) {
        appQueryClient.clear();
        window.location.replace("/sign-in");
      }
      if (event.key === "interview-agent:interview-deleted" && event.newValue !== null) {
        appQueryClient.clear();
        const encodedId = encodeURIComponent(event.newValue);
        if (
          window.location.pathname === `/interviews/${encodedId}` ||
          window.location.pathname === `/reports/${encodedId}`
        ) {
          window.location.replace("/history");
        } else {
          window.location.reload();
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return <QueryClientProvider client={appQueryClient}>{children}</QueryClientProvider>;
}
