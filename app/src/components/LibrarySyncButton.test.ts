// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { LibrarySyncButton } from "./LibrarySyncButton";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("offers explicit browser-to-MySQL and MySQL-to-browser actions", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let finish!: (success: boolean) => void;
  const onPush = vi.fn(
    () =>
      new Promise<boolean>(resolve => {
        finish = resolve;
      })
  );
  const onPull = vi.fn(async () => true);
  const onMirror = vi.fn(async () => true);
  await act(async () =>
    root.render(createElement(LibrarySyncButton, { onPush, onPull, onMirror }))
  );
  const [menuButton] = host.querySelectorAll("button");
  expect(menuButton.textContent).toContain("同步书籍");
  await act(async () =>
    menuButton.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0 })
    )
  );
  expect(document.body.textContent).toContain("浏览器 → MySQL");
  expect(document.body.textContent).toContain("MySQL → 浏览器");
  expect(document.body.textContent).toContain("MySQL → 浏览器（镜像）");
  const pushItem = Array.from(
    document.querySelectorAll('[role="menuitem"]')
  ).find(item => item.textContent?.includes("浏览器 → MySQL"))!;
  await act(async () =>
    pushItem.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  );
  expect(menuButton.disabled).toBe(true);
  expect(host.textContent).toContain("同步中");
  expect(onPush).toHaveBeenCalledTimes(1);
  expect(onPull).not.toHaveBeenCalled();
  await act(async () => finish(false));
  expect(host.textContent).toContain("同步失败");
  expect(menuButton.disabled).toBe(false);
  await act(async () =>
    menuButton.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0 })
    )
  );
  const retryPushItem = Array.from(
    document.querySelectorAll('[role="menuitem"]')
  ).find(item => item.textContent?.includes("浏览器 → MySQL"))!;
  await act(async () =>
    retryPushItem.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  );
  await act(async () => finish(true));
  expect(host.querySelector('[role="status"]')?.textContent).toContain(
    "已上传到 MySQL"
  );
  await act(async () => root.unmount());
  host.remove();
});
