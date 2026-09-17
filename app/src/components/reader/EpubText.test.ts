// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EpubText } from "./EpubText";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  document.body.innerHTML = "";
});

describe("EPUB note interaction", () => {
  it("opens an accessible note without navigation or parent click, then closes with Escape", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const parentClick = vi.fn();
    const root = createRoot(host);
    const before = location.href;
    await act(async () =>
      root.render(
        createElement(
          "p",
          { onClick: parentClick },
          createElement(EpubText, {
            text: "正文[1]结束",
            notes: [
              {
                paraIndex: 0,
                start: 2,
                end: 5,
                content: "注释内容 <script>bad()</script>",
              },
            ],
          })
        )
      )
    );
    const trigger = host.querySelector("button")!;
    expect(trigger.closest("sup")).not.toBeNull();
    expect(host.textContent).toBe("正文[1]结束");
    await act(async () => trigger.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "注释内容"
    );
    expect(document.querySelector("script")).toBeNull();
    expect(location.href).toBe(before);
    expect(parentClick).not.toHaveBeenCalled();
    await act(async () =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      )
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => root.unmount());
  });
});
