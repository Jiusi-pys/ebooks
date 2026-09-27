// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./dialog";

it("does not send dialog wheel events to its React parent", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const backgroundWheel = vi.fn();
  const dialogWheel = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(
        "div",
        { onWheel: backgroundWheel },
        createElement(
          Dialog,
          { open: true },
          createElement(
            DialogContent,
            { onWheel: dialogWheel },
            createElement(DialogTitle, null, "测试弹窗"),
            createElement(DialogDescription, null, "滚轮隔离测试"),
            createElement("div", { className: "overflow-y-auto" }, "内容")
          )
        )
      )
    )
  );
  const content = document.querySelector('[data-slot="dialog-content"]')!;
  const wheel = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY: 100,
  });
  await act(async () => content.dispatchEvent(wheel));
  expect(backgroundWheel).not.toHaveBeenCalled();
  expect(dialogWheel).toHaveBeenCalledOnce();
  expect(wheel.defaultPrevented).toBe(false);
  expect(content.className).toContain("overscroll-contain");
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
