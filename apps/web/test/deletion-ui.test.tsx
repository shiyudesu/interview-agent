import "@testing-library/jest-dom/vitest";

import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeleteInterviewButton } from "../src/components/delete-interview-button.js";
import { broadcastAccountDeletion } from "../src/features/deletion/deletion-api.js";
import { ACCOUNT_OWNED_QUERY_KEY } from "../src/features/interview/interview-query.js";
import { createAppQueryClient } from "../src/lib/query-client.js";
import { AccountSettingsPage } from "../src/pages/account-settings-page.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("deletion confirmations", () => {
  it("keeps account cleanup independent from unavailable Web Storage", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "SecurityError");
    });

    expect(() => broadcastAccountDeletion()).not.toThrow();
  });

  it("confirms interview deletion, clears account-owned resources, and leaves the deleted route", async () => {
    const user = userEvent.setup();
    const queryClient = createAppQueryClient();
    queryClient.setQueryData([...ACCOUNT_OWNED_QUERY_KEY, "account", "interview"], {
      id: "interview-delete",
    });
    const requestFetch = vi.fn<typeof fetch>().mockResolvedValue(deletionResponse());
    vi.stubGlobal("fetch", requestFetch);
    const router = createMemoryRouter(
      [
        {
          path: "/interviews/interview-delete",
          element: <DeleteInterviewButton interviewId="interview-delete" />,
        },
        { path: "/history", element: <h1>History after deletion</h1> },
      ],
      { initialEntries: ["/interviews/interview-delete"] },
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await user.click(screen.getByRole("button", { name: "删除此面试" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("删除这场面试？");
    await user.click(screen.getByRole("button", { name: "确认删除面试" }));

    expect(
      await screen.findByRole("heading", { name: "History after deletion" }),
    ).toBeInTheDocument();
    expect(queryClient.getQueriesData({ queryKey: ACCOUNT_OWNED_QUERY_KEY })).toEqual([]);
    expect(requestFetch).toHaveBeenCalledWith(
      "/api/v1/interviews/interview-delete",
      expect.objectContaining({
        body: JSON.stringify({ confirmed: true }),
        method: "DELETE",
      }),
    );
  });

  it("requires confirmation before account deletion and removes all cached user data", async () => {
    const user = userEvent.setup();
    const queryClient = createAppQueryClient();
    let finishDeletion: ((response: Response) => void) | undefined;
    const deletionPending = new Promise<Response>((resolve) => {
      finishDeletion = resolve;
    });
    const requestFetch = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/account" && init?.method !== "DELETE") {
        return accountResponse();
      }
      if (String(input) === "/api/v1/account" && init?.method === "DELETE") {
        return deletionPending;
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", requestFetch);
    const router = createMemoryRouter(
      [
        { path: "/settings", element: <AccountSettingsPage /> },
        { path: "/", element: <h1>Signed-out home</h1> },
      ],
      { initialEntries: ["/settings"] },
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "删除我的账户" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("永久删除账户？");
    await user.click(screen.getByRole("button", { name: "确认删除账户" }));

    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正在删除…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    finishDeletion?.(deletionResponse());
    expect(await screen.findByRole("heading", { name: "Signed-out home" })).toBeInTheDocument();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
});

function deletionResponse() {
  return new Response(
    JSON.stringify({
      status: "deleting",
      requestedAt: "2026-08-14T00:00:00.000Z",
      purgeDeadlineAt: "2026-08-21T00:00:00.000Z",
    }),
    { status: 202, headers: { "content-type": "application/json" } },
  );
}

function accountResponse() {
  return new Response(
    JSON.stringify({
      id: "account-delete",
      email: "candidate@example.test",
      displayName: "候选人",
      linkedIdentities: [],
      sessions: [],
      createdAt: "2026-08-14T00:00:00.000Z",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
