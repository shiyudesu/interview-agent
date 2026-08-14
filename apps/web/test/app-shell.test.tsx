import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppProviders } from "../src/app/app-providers.js";
import { AppShell } from "../src/components/app-shell.js";
import { HomePage } from "../src/pages/home-page.js";
import { WorkspacePage } from "../src/pages/workspace-page.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("application shell", () => {
  it("renders the primary navigation and routes without a document reload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "account-shell",
            email: "candidate@example.test",
            displayName: "候选人",
            linkedIdentities: [],
            sessions: [],
            createdAt: "2026-08-13T00:00:00.000Z",
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        {
          path: "/",
          element: <AppShell />,
          children: [
            { index: true, element: <HomePage /> },
            { path: "app", element: <WorkspacePage /> },
          ],
        },
      ],
      { initialEntries: ["/"] },
    );
    render(
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>,
    );

    expect(screen.getByRole("navigation", { name: "主要导航" })).toBeInTheDocument();
    expect(screen.getByText("变成下一次进步的证据。")).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "进入面试空间" }));
    expect(await screen.findByRole("heading", { name: "候选人，欢迎回来" })).toBeInTheDocument();
  });
});
