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
  it("keeps wheel events inside an open note from reaching the reader", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const parentWheel = vi.fn();
    const root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(
          "div",
          { onWheel: parentWheel },
          createElement(EpubText, {
            text: "正文[1]结束",
            notes: [{ paraIndex: 0, start: 2, end: 5, content: "较长注释" }],
          })
        )
      )
    );
    await act(async () => host.querySelector("button")!.click());
    const note = document.querySelector('[aria-label="书内注释"]')!;
    await act(async () =>
      note.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 80 }))
    );
    expect(parentWheel).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("closes an open note when the reader navigates to another page", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const render = (dismissSignal: number) =>
      createElement(EpubText, {
        text: "正文[1]结束",
        notes: [{ paraIndex: 0, start: 2, end: 5, content: "注释" }],
        dismissSignal,
      });
    await act(async () => root.render(render(0)));
    await act(async () => host.querySelector("button")!.click());
    expect(document.querySelector('[aria-label="书内注释"]')).not.toBeNull();
    await act(async () => root.render(render(1)));
    expect(document.querySelector('[aria-label="书内注释"]')).toBeNull();
    await act(async () => root.unmount());
  });

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
