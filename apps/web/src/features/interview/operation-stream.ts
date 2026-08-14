import {
  isOperationEventDto,
  type OperationEventDto,
} from "@interview-agent/contracts/operation-events";

export class OperationReplayUnavailableError extends Error {
  constructor() {
    super("Operation event replay is unavailable");
    this.name = "OperationReplayUnavailableError";
  }
}

export class OperationStreamError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "OperationStreamError";
  }
}

export interface OperationStreamOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly lastEventId?: number;
  readonly onEvent: (event: OperationEventDto) => void;
  readonly onOpen?: () => void;
  readonly operationId: string;
  readonly signal: AbortSignal;
}

export async function consumeOperationEvents(options: OperationStreamOptions): Promise<void> {
  const headers = new Headers({ accept: "text/event-stream" });
  if (options.lastEventId !== undefined) {
    headers.set("last-event-id", String(options.lastEventId));
  }
  const response = await (options.fetch ?? globalThis.fetch)(
    `/api/v1/operations/${options.operationId}/events`,
    {
      cache: "no-store",
      credentials: "same-origin",
      headers,
      signal: options.signal,
    },
  );
  if (response.status === 204) {
    return;
  }
  if (response.status === 409) {
    throw new OperationReplayUnavailableError();
  }
  if (!response.ok) {
    throw new OperationStreamError("Operation event stream failed", response.status);
  }
  if (!response.body) {
    throw new OperationStreamError("Operation event stream has no body", response.status);
  }
  options.onOpen?.();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/gu, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseBlock(block, options.operationId);
        if (event !== null) {
          options.onEvent(event);
        }
        boundary = buffer.indexOf("\n\n");
      }
      if (done) {
        if (buffer.trim().length > 0) {
          const event = parseSseBlock(buffer, options.operationId);
          if (event !== null) {
            options.onEvent(event);
          }
        }
        return;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block: string, operationId: string): OperationEventDto | null {
  const fields = new Map<string, string>();
  for (const line of block.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }
    const separator = line.indexOf(":");
    const name = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).trimStart();
    fields.set(name, value);
  }
  const data = fields.get("data");
  if (data === undefined) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new OperationStreamError("Operation event data is invalid JSON");
  }
  if (
    !isOperationEventDto(value) ||
    value.operationId !== operationId ||
    fields.get("event") !== value.type ||
    fields.get("id") !== String(value.sequence)
  ) {
    throw new OperationStreamError("Operation event does not match its stream envelope");
  }
  return value;
}
