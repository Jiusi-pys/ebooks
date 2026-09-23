// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Library } from "@/hooks/useLibrary";
import { GlobalSearch } from "./GlobalSearch";

const pdfMock = vi.hoisted(() => ({ pages: vi.fn() }));
vi.mock("@/lib/searchPdf", () => ({ searchPdfPages: pdfMock.pages }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("searches from the global entry and opens a matching note", async () => {
  const navigate = vi.fn();
  const lib = {
    route: { view: "library" },
    books: [],
    highlights: [],
    studySets: [],
    notes: [
      {
        id: "n",
        title: "目标笔记",
        content: "测试正文",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    navigate,
  } as unknown as Library;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(GlobalSearch, { lib })));
    await act(async () =>
      host.querySelector<HTMLButtonElement>("button")!.click()
    );
    const scope = document.querySelector<HTMLSelectElement>(
      '[aria-label="搜索范围"]'
    )!;
    expect(scope.value).toBe("all");
    expect(
      scope.querySelector<HTMLOptionElement>('[value="book"]')!.disabled
    ).toBe(true);
    expect(
      scope.querySelector<HTMLOptionElement>('[value="studySet"]')!.disabled
    ).toBe(true);
    const input = document.querySelector<HTMLInputElement>(
      '[aria-label="搜索内容"]'
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!.call(input, "测试");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      input
        .closest("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    );
    const result = document.querySelector<HTMLButtonElement>(
      "[data-search-result]"
    )!;
    expect(result.textContent).toContain("目标笔记");
    expect(result.querySelector("mark")!.textContent).toBe("测试");
    await act(async () => result.click());
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ view: "note", noteId: "n" })
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("defaults to the active study set and lets users explicitly choose another set", async () => {
  const lib = {
    route: { view: "studyset", studySetId: "s2" },
    books: [],
    notes: [],
    highlights: [],
    studySets: [
      { id: "s1", name: "学习集一", bookIds: [] },
      { id: "s2", name: "学习集二", bookIds: [] },
    ],
  } as unknown as Library;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(GlobalSearch, { lib })));
    await act(async () =>
      host.querySelector<HTMLButtonElement>("button")!.click()
    );
    expect(
      document.querySelector<HTMLSelectElement>('[aria-label="搜索范围"]')!
        .value
    ).toBe("studySet");
    const sets = document.querySelector<HTMLSelectElement>(
      '[aria-label="选择学习集"]'
    )!;
    expect(sets.value).toBe("s2");
    expect(
      document
        .querySelector<HTMLOptionElement>('[value="studySet"]')!
        .textContent
    ).toBe("本合集：学习集二");
    await act(async () => {
      sets.value = "s1";
      sets.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(sets.value).toBe("s1");
    expect(
      document
        .querySelector<HTMLOptionElement>('[value="studySet"]')!
        .textContent
    ).toBe("本合集：学习集一");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("names the current book and selected study set in scope choices", async () => {
  const lib = {
    route: { view: "reader", bookId: "b1", studySetId: "s1" },
    books: [
      { id: "b1", title: "正在阅读的书", author: "", format: "txt", chapters: [] },
    ],
    notes: [],
    highlights: [],
    studySets: [{ id: "s1", name: "当前合集", bookIds: ["b1"] }],
  } as unknown as Library;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(GlobalSearch, { lib })));
    await act(async () =>
      host.querySelector<HTMLButtonElement>("button")!.click()
    );
    const scope = document.querySelector<HTMLSelectElement>(
      '[aria-label="搜索范围"]'
    )!;
    expect(
      scope.querySelector<HTMLOptionElement>('[value="book"]')!.textContent
    ).toBe("本书：正在阅读的书");
    expect(
      scope.querySelector<HTMLOptionElement>('[value="studySet"]')!
        .textContent
    ).toBe("本合集：当前合集");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it("discards a pending PDF search after the query changes", async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => {
    release = resolve;
  });
  let signal: AbortSignal | undefined;
  pdfMock.pages.mockImplementation(async function* (_book, inputSignal) {
    signal = inputSignal;
    await wait;
    yield { page: 1, text: "old keyword" };
  });
  const lib = {
    route: { view: "library" },
    books: [{ id: "p", title: "PDF", author: "", format: "pdf", chapters: [] }],
    notes: [],
    highlights: [],
    studySets: [],
  } as unknown as Library;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(GlobalSearch, { lib })));
    await act(async () =>
      host.querySelector<HTMLButtonElement>("button")!.click()
    );
    const input = document.querySelector<HTMLInputElement>(
      '[aria-label="搜索内容"]'
    )!;
    const change = (value: string) => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => change("old"));
    await act(async () =>
      input
        .closest("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    );
    // Flush the lazy module import before cancelling the extraction.
    await act(async () => {
      await vi.waitFor(() => expect(pdfMock.pages).toHaveBeenCalled(), {
        interval: 5,
      });
    });
    await act(async () => change("new"));
    expect(signal?.aborted).toBe(true);
    await act(async () => release());
    expect(document.querySelector("[data-search-result]")).toBeNull();
    expect(
      document.querySelector('[role="status"]')!.textContent
    ).not.toContain("找到");
  } finally {
    release();
    await act(async () => root.unmount());
    host.remove();
  }
});
