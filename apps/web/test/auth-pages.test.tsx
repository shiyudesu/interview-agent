import "@testing-library/jest-dom/vitest";

import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppQueryClient } from "../src/lib/query-client.js";
import { AccountSettingsPage } from "../src/pages/account-settings-page.js";
import { AuthErrorPage } from "../src/pages/auth-error-page.js";
import { SignInPage } from "../src/pages/sign-in-page.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("authentication pages", () => {
  it("guides an unlinked GitHub user back through the existing login method", () => {
    renderRoute(<AuthErrorPage />, "/auth/error?error=account_not_linked");

    expect(screen.getByRole("heading", { name: "这个 GitHub 身份尚未关联" })).toBeInTheDocument();
    expect(screen.getByText(/先使用原来的邮箱验证码登录/u)).toBeInTheDocument();
  });

  it("requests an email OTP before presenting the verification form", async () => {
    const user = userEvent.setup();
    const requestFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: { code: "unauthorized", message: "Authentication required" },
          },
          401,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true }, 200));
    vi.stubGlobal("fetch", requestFetch);
    renderRoute(<SignInPage />, "/sign-in");

    await user.type(screen.getByRole("textbox", { name: "邮箱地址" }), "candidate@example.test");
    await user.click(screen.getByRole("button", { name: "发送验证码" }));

    expect(await screen.findByRole("textbox", { name: "6 位验证码" })).toBeInTheDocument();
    expect(requestFetch).toHaveBeenLastCalledWith(
      "/api/auth/email-otp/send-verification-otp",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows linked identities, sessions, and the explicit GitHub link action", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            id: "account-settings",
            email: "candidate@example.test",
            displayName: "候选人",
            linkedIdentities: [
              {
                provider: "email_otp",
                providerAccountId: "candidate@example.test",
                linkedAt: "2026-08-13T00:00:00.000Z",
              },
            ],
            sessions: [
              {
                id: "session-current",
                expiresAt: "2026-08-14T00:00:00.000Z",
                createdAt: "2026-08-13T00:00:00.000Z",
                updatedAt: "2026-08-13T00:00:00.000Z",
                ipAddress: null,
                userAgent: "Chrome",
                current: true,
              },
            ],
            createdAt: "2026-08-13T00:00:00.000Z",
          },
          200,
        ),
      ),
    );
    renderRoute(<AccountSettingsPage />, "/settings");

    expect(await screen.findByText("邮箱验证码")).toBeInTheDocument();
    expect(screen.getByText("当前会话")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "绑定 GitHub" })).toBeInTheDocument();
  });
});

function renderRoute(element: ReactNode, initialEntry: string) {
  const router = createMemoryRouter([{ path: "*", element }], {
    initialEntries: [initialEntry],
  });
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function jsonResponse(value: unknown, status: number) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
