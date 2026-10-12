// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Book } from "@/types";
import type { EpubLayout } from "@/lib/epubLayout";
import { useEpubLayout } from "./useEpubLayout";

const { getEpubLayout } = vi.hoisted(() => ({ getEpubLayout: vi.fn() }));
vi.mock("@/lib/epubLayoutStore", () => ({ getEpubLayout }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const book = (id: string): Book => ({
  id,
  title: id,
  author: "",
  format: "epub",
  coverTone: 0,
  chapters: [{ id: "chapter", title: "Chapter", paragraphs: ["body"] }],
  createdAt: 1,
  progress: { chapterId: "chapter", ratio: 0 },
});
const layout = (marker: string): EpubLayout => ({
  version: 1,
  assets: {},
  chapters: { [marker]: { items: [] } },
});
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  getEpubLayout.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function View({ value }: { value: Book }) {
  const result = useEpubLayout(value);
  return createElement(
    "div",
    null,
    result ? Object.keys(result.chapters).join() : "none"
  );
}
async function render(bookValue: Book) {
  await act(async () => root.render(createElement(View, { value: bookValue })));
}

it("does not reread unchanged chapters when only reading progress or catalogue fields change", async () => {
  getEpubLayout.mockResolvedValue(layout("loaded"));
  const original = book("book");
  const serialize = vi.fn(() => []);
  Object.assign(original.chapters, { toJSON: serialize });
  await render(original);
  await render({
    ...original,
    title: "Renamed",
    progress: { chapterId: "chapter", ratio: 0.5 },
  });
  expect(getEpubLayout).toHaveBeenCalledTimes(1);
  expect(serialize).toHaveBeenCalledTimes(1);
  expect(host.textContent).toBe("loaded");
  await act(async () =>
    window.dispatchEvent(new Event("shufang:sync-updated"))
  );
  expect(getEpubLayout).toHaveBeenLastCalledWith({
    ...original,
    title: "Renamed",
    progress: { chapterId: "chapter", ratio: 0.5 },
  });
});

it("refreshes only its book on cross-tab messages and closes the channel on unmount", async () => {
  const channels: {
    onmessage?: (event: { data: unknown }) => void;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage?: (event: { data: unknown }) => void;
      close = vi.fn();
      constructor() {
        channels.push(this);
      }
    }
  );
  getEpubLayout.mockResolvedValue(layout("loaded"));
  await render(book("book"));
  await act(async () =>
    channels[0].onmessage?.({ data: { bookId: "another" } })
  );
  expect(getEpubLayout).toHaveBeenCalledTimes(1);
  getEpubLayout.mockResolvedValue(layout("updated"));
  await act(async () => channels[0].onmessage?.({ data: { bookId: "book" } }));
  expect(host.textContent).toBe("updated");
  await act(async () => root.unmount());
  expect(channels[0].close).toHaveBeenCalledOnce();
});

it("still subscribes locally when BroadcastChannel creation fails", async () => {
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      constructor() {
        throw new Error("unsupported");
      }
    }
  );
  getEpubLayout.mockResolvedValue(layout("loaded"));
  await render(book("book"));
  expect(host.textContent).toBe("loaded");
});

it("hides a loaded layout immediately while the next book's read is pending", async () => {
  getEpubLayout.mockResolvedValueOnce(layout("a"));
  await render(book("a"));
  getEpubLayout.mockReturnValueOnce(new Promise(() => undefined));
  await render(book("b"));
  expect(host.textContent).toBe("none");
});

it("never displays another book's late response and immediately clears old layout on a switch", async () => {
  let releaseA!: (value: EpubLayout) => void;
  const pendingA = new Promise<EpubLayout>(resolve => {
    releaseA = resolve;
  });
  getEpubLayout.mockImplementation((value: Book) =>
    value.id === "a" ? pendingA : Promise.resolve(layout("b"))
  );
  await render(book("a"));
  await render(book("b"));
  expect(host.textContent).toBe("b");
  await act(async () => releaseA(layout("a")));
  expect(host.textContent).toBe("b");
});

it("refreshes committed local layout and sync changes without replacing text", async () => {
  getEpubLayout.mockResolvedValue(layout("first"));
  await render(book("book"));
  expect(host.textContent).toBe("first");
  getEpubLayout.mockResolvedValue(layout("second"));
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent("shufang:epub-layout-updated", {
        detail: { bookId: "book" },
      })
    )
  );
  expect(host.textContent).toBe("second");
  getEpubLayout.mockResolvedValue(undefined);
  await act(async () =>
    window.dispatchEvent(new Event("shufang:sync-updated"))
  );
  expect(host.textContent).toBe("none");
});

it("ignores late reads after a newer refresh and degrades storage errors to text", async () => {
  let release!: (value: EpubLayout) => void;
  getEpubLayout.mockReturnValueOnce(
    new Promise<EpubLayout>(resolve => {
      release = resolve;
    })
  );
  await render(book("book"));
  getEpubLayout.mockResolvedValue(layout("new"));
  await act(async () =>
    window.dispatchEvent(new Event("shufang:sync-updated"))
  );
  await act(async () => release(layout("old")));
  expect(host.textContent).toBe("new");
  getEpubLayout.mockRejectedValue(new Error("offline storage"));
  await act(async () =>
    window.dispatchEvent(new Event("shufang:sync-updated"))
  );
  expect(host.textContent).toBe("none");
});
