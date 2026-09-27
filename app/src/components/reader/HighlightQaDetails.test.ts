// @vitest-environment jsdom
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { HighlightQaDetails } from "./HighlightQaDetails";

it("shows complete multi-turn answers with separate back and continue actions", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onBack = vi.fn();
  const onContinue = vi.fn();
  const answer = "完整回答\n".repeat(150) + "末尾的解释";
  await act(async () =>
    root.render(
      createElement(HighlightQaDetails, {
        qa: [
          { q: "第一问", a: answer, ts: 1 },
          { q: "追问", a: "第二轮完整回答", ts: 2 },
        ],
        onBack,
        onContinue,
      })
    )
  );
  expect(container.textContent).toContain(answer);
  expect(container.textContent).toContain("第二轮完整回答");
  const buttons = Array.from(container.querySelectorAll("button"));
  await act(async () =>
    buttons.find(b => b.textContent?.includes("返回"))!.click()
  );
  expect(onBack).toHaveBeenCalledOnce();
  expect(onContinue).not.toHaveBeenCalled();
  await act(async () =>
    buttons.find(b => b.textContent?.includes("继续追问"))!.click()
  );
  expect(onContinue).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
  container.remove();
});
