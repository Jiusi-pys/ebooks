// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AssociationPopup } from "./AssociationPopup";
import type { PassageAnchor } from "@/types";

const anchor: PassageAnchor = {
  kind: "text",
  bookId: "book",
  chapterId: "chapter",
  chapterTitle: "第一章",
  text: "选中的句子",
  paraIndex: 0,
  start: 0,
  end: 6,
};

it("keeps wheel events inside the association popup", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const readerWheel = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(
        "div",
        { onWheel: readerWheel },
        createElement(AssociationPopup, {
          top: 0,
          left: 0,
          current: anchor,
          associations: [],
          books: [],
          onNavigate: vi.fn(),
          onDelete: vi.fn(),
          onAdd: vi.fn(),
          onClose: vi.fn(),
        })
      )
    )
  );
  const popup = host.querySelector('[aria-label="管理文段关联"]')!;
  const wheel = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    deltaY: 120,
  });
  await act(async () => popup.dispatchEvent(wheel));
  expect(readerWheel).not.toHaveBeenCalled();
  expect(wheel.defaultPrevented).toBe(false);
  expect(popup.className).toContain("overscroll-contain");
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
