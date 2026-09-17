// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { LibrarySyncButton } from "./LibrarySyncButton";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("waits for server confirmation, prevents duplicate clicks and supports retry", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  let finish!: (success: boolean) => void;
  const onSync = vi.fn(
    () =>
      new Promise<boolean>(resolve => {
        finish = resolve;
      })
  );
  await act(async () =>
    root.render(createElement(LibrarySyncButton, { onSync }))
  );
  const button = host.querySelector("button")!;
  expect(button.textContent).toContain("同步到 MySQL");
  await act(async () => button.click());
  expect(button.disabled).toBe(true);
  expect(host.textContent).toContain("同步中");
  await act(async () => button.click());
  expect(onSync).toHaveBeenCalledTimes(1);
  await act(async () => finish(false));
  expect(host.textContent).toContain("同步失败");
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  await act(async () => finish(true));
  expect(host.querySelector('[role="status"]')?.textContent).toContain(
    "书籍已保存到 MySQL"
  );
  await act(async () => root.unmount());
});
