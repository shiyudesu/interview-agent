import { describe, expect, it, vi } from "vitest";

import {
  consumeOperationEvents,
  OperationReplayUnavailableError,
  OperationStreamError,
} from "../src/features/interview/operation-stream.js";

describe("Operation SSE client", () => {
  it("parses validated events and sends Last-Event-ID on reconnect", async () => {
    const events: unknown[] = [];
    const onOpen = vi.fn();
    const requestFetch = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        eventBlock(3, "text_delta", {
          operationId: "operation-stream",
          sequence: 3,
          occurredAt: "2026-08-14T00:00:00.000Z",
          type: "text_delta",
          text: "已校验的最终文本。",
        }),
        eventBlock(4, "succeeded", {
          operationId: "operation-stream",
          sequence: 4,
          occurredAt: "2026-08-14T00:00:01.000Z",
          type: "succeeded",
        }),
      ]),
    );

    await consumeOperationEvents({
      fetch: requestFetch,
      lastEventId: 2,
      onEvent: (event) => events.push(event),
      onOpen,
      operationId: "operation-stream",
      signal: new AbortController().signal,
    });

    expect(events).toMatchObject([
      { sequence: 3, type: "text_delta" },
      { sequence: 4, type: "succeeded" },
    ]);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(new Headers(requestFetch.mock.calls[0]?.[1]?.headers).get("last-event-id")).toBe("2");
  });

  it("surfaces replay loss so callers can reload canonical state", async () => {
    await expect(
      consumeOperationEvents({
        fetch: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(
            JSON.stringify({
              error: {
                code: "operation_event_replay_unavailable",
                message: "Reload canonical state",
                operationId: "operation-stream",
              },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          ),
        ),
        lastEventId: 8,
        onEvent: () => undefined,
        operationId: "operation-stream",
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(OperationReplayUnavailableError);
  });

  it("preserves permanent HTTP status for the reconnect policy", async () => {
    await expect(
      consumeOperationEvents({
        fetch: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
        ),
        onEvent: () => undefined,
        operationId: "operation-stream",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      name: "OperationStreamError",
      status: 401,
    });
  });

  it("rejects events whose envelope disagrees with validated data", async () => {
    await expect(
      consumeOperationEvents({
        fetch: vi.fn<typeof fetch>().mockResolvedValue(
          sseResponse([
            eventBlock(2, "failed", {
              operationId: "operation-stream",
              sequence: 1,
              occurredAt: "2026-08-14T00:00:00.000Z",
              type: "succeeded",
            }),
          ]),
        ),
        onEvent: () => undefined,
        operationId: "operation-stream",
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(OperationStreamError);
  });

  it("cancels the response stream after invalid event parsing", async () => {
    const cancel = vi.fn();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            eventBlock(2, "failed", {
              operationId: "operation-stream",
              sequence: 1,
              occurredAt: "2026-08-14T00:00:00.000Z",
              type: "succeeded",
            }),
          ),
        );
      },
      cancel,
    });

    await expect(
      consumeOperationEvents({
        fetch: vi.fn<typeof fetch>().mockResolvedValue(
          new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
        onEvent: () => undefined,
        operationId: "operation-stream",
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(OperationStreamError);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

function eventBlock(sequence: number, event: string, data: unknown): string {
  return `id: ${sequence}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseResponse(blocks: readonly string[]): Response {
  return new Response(blocks.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
