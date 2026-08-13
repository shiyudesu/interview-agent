import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EmptyState, ErrorState, LoadingState } from "../src/components/page-state.js";

afterEach(cleanup);

describe("accessible page states", () => {
  it("announces loading progress", () => {
    render(<LoadingState label="正在恢复面试" />);

    expect(screen.getByRole("status")).toHaveTextContent("正在恢复面试");
  });

  it("announces errors and exposes an explicit retry action", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ErrorState onRetry={onRetry} title="加载失败" />);

    expect(screen.getByRole("alert")).toHaveTextContent("加载失败");
    await user.click(screen.getByRole("button", { name: "重新尝试" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("renders an empty state without presenting it as an error", () => {
    render(<EmptyState description="当前没有进行中的面试。" title="暂无面试" />);

    expect(screen.getByText("暂无面试")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
