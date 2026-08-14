import {
  type DeletionAcceptedResponseDto,
  isDeletionAcceptedResponseDto,
} from "@interview-agent/contracts/deletion";

import { apiClient } from "../../lib/api-client.js";

export function deleteInterview(interviewId: string): Promise<DeletionAcceptedResponseDto> {
  return deletionRequest(`/api/v1/interviews/${interviewId}`);
}

export function deleteAccount(): Promise<DeletionAcceptedResponseDto> {
  return deletionRequest("/api/v1/account");
}

export function broadcastAccountDeletion(): void {
  broadcastDeletion("interview-agent:account-deleted", String(Date.now()));
}

export function broadcastInterviewDeletion(interviewId: string): void {
  broadcastDeletion("interview-agent:interview-deleted", interviewId);
}

function broadcastDeletion(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
    localStorage.removeItem(key);
  } catch {
    return;
  }
}

function deletionRequest(path: `/api/${string}`): Promise<DeletionAcceptedResponseDto> {
  return apiClient.request(path, {
    decode(value) {
      if (!isDeletionAcceptedResponseDto(value)) {
        throw new TypeError("Invalid deletion response");
      }
      return value;
    },
    json: { confirmed: true },
    method: "DELETE",
  });
}
