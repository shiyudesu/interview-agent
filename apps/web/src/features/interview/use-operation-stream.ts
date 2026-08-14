import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { ACCOUNT_QUERY_KEY } from "../account/account-query.js";
import { getInterviewDetail } from "./interview-api.js";
import {
  activeInterviewQueryKey,
  historyQueryKey,
  interviewDetailQueryKey,
} from "./interview-query.js";
import {
  consumeOperationEvents,
  OperationReplayUnavailableError,
  OperationStreamError,
} from "./operation-stream.js";

const RECONNECT_DELAY_MS = 1_000;

export interface UseOperationStreamInput {
  readonly accountId?: string;
  readonly interviewId?: string;
  readonly operationId?: string;
}

export interface OperationStreamState {
  readonly reconnecting: boolean;
  readonly text: string | null;
}

export function useOperationStream(input: UseOperationStreamInput): OperationStreamState {
  const queryClient = useQueryClient();
  const [text, setText] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    if (
      input.accountId === undefined ||
      input.interviewId === undefined ||
      input.operationId === undefined
    ) {
      setText(null);
      setReconnecting(false);
      return;
    }
    const accountId = input.accountId;
    const interviewId = input.interviewId;
    const operationId = input.operationId;
    const controller = new AbortController();
    let lastEventId: number | undefined;

    async function refreshCanonical() {
      const detailQueryKey = interviewDetailQueryKey(accountId, interviewId);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: detailQueryKey,
          refetchType: "none",
        }),
        queryClient.invalidateQueries({
          queryKey: activeInterviewQueryKey(accountId),
        }),
      ]);
      const canonical = await queryClient.fetchQuery({
        queryKey: detailQueryKey,
        queryFn: ({ signal }) => getInterviewDetail(interviewId, signal),
      });
      if (
        canonical.status === "completed" ||
        canonical.status === "early_ended" ||
        canonical.status === "abandoned"
      ) {
        await queryClient.invalidateQueries({ queryKey: historyQueryKey(accountId) });
      }
      return canonical;
    }

    async function run(): Promise<void> {
      for (;;) {
        try {
          await consumeOperationEvents({
            operationId,
            signal: controller.signal,
            ...(lastEventId === undefined ? {} : { lastEventId }),
            onOpen: () => setReconnecting(false),
            onEvent(event) {
              lastEventId = event.sequence;
              if (event.type === "text_delta") {
                setText(event.text);
              }
            },
          });
          const canonical = await refreshCanonical();
          if (controller.signal.aborted || !operationIsProcessing(canonical, operationId)) {
            return;
          }
          setReconnecting(true);
        } catch (error) {
          if (controller.signal.aborted) {
            return;
          }
          if (error instanceof OperationStreamError && isPermanentStatus(error.status)) {
            if (error.status === 401) {
              await queryClient.invalidateQueries({ queryKey: ACCOUNT_QUERY_KEY });
            } else {
              await queryClient.invalidateQueries({
                queryKey: interviewDetailQueryKey(accountId, interviewId),
              });
            }
            return;
          }
          if (error instanceof OperationReplayUnavailableError) {
            lastEventId = undefined;
          }
          setReconnecting(true);
          const canonical = await refreshCanonical().catch(() => null);
          if (canonical !== null && !operationIsProcessing(canonical, operationId)) {
            return;
          }
        }
        await delay(RECONNECT_DELAY_MS, controller.signal);
      }
    }

    setText(null);
    setReconnecting(false);
    void run();
    return () => controller.abort();
  }, [input.accountId, input.interviewId, input.operationId, queryClient]);

  return { reconnecting, text };
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function operationIsProcessing(
  current: Awaited<ReturnType<typeof getInterviewDetail>>,
  operationId: string,
): boolean {
  return (
    (current.status === "active" || current.status === "report_pending") &&
    "operation" in current &&
    current.operation.operationId === operationId &&
    (current.operation.status === "pending" || current.operation.status === "processing")
  );
}

function isPermanentStatus(status: number | null): boolean {
  return status !== null && status >= 400 && status < 500 && status !== 409;
}
