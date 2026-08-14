import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { broadcastInterviewDeletion, deleteInterview } from "../features/deletion/deletion-api.js";
import { ACCOUNT_OWNED_QUERY_KEY } from "../features/interview/interview-query.js";
import { ApiClientError } from "../lib/api-client.js";
import { Button } from "./button.js";
import { ConfirmationDialog } from "./confirmation-dialog.js";

export function DeleteInterviewButton({ interviewId }: { readonly interviewId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const deletion = useMutation({
    mutationFn: () => deleteInterview(interviewId),
    onSuccess() {
      broadcastInterviewDeletion(interviewId);
      queryClient.removeQueries({ queryKey: ACCOUNT_OWNED_QUERY_KEY });
      navigate("/history", { replace: true });
    },
    onError(error) {
      if (error instanceof ApiClientError && error.status === 401) {
        queryClient.clear();
        navigate("/sign-in", { replace: true });
      }
    },
  });
  return (
    <div>
      <ConfirmationDialog
        confirmLabel={deletion.isPending ? "正在删除…" : "确认删除面试"}
        description="确认后，该面试的记录、评价、Operation 和报告会立即从账户中消失且无法恢复，并在七天内物理清除。"
        disabled={deletion.isPending}
        {...(deletion.error === null ? {} : { error: deletion.error.message })}
        onConfirm={() => deletion.mutate()}
        title="删除这场面试？"
        trigger={<Button tone="secondary">删除此面试</Button>}
      />
    </div>
  );
}
