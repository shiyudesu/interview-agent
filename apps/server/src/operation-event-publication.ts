import type { OperationEventPublisher } from "./operation-events.js";

export const NO_OPERATION_EVENTS: OperationEventPublisher = {
  beginAttempt: () => undefined,
  publishTextDelta: () => null,
  publishTextAndTerminal: () => null,
  publishTerminal: () => null,
};

export function publishOperationEvent(publish: () => unknown): void {
  try {
    publish();
  } catch {
    return;
  }
}
