import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LoginView } from "./LoginView";

function render(accountInitialized: boolean) {
  return renderToStaticMarkup(
    createElement(LoginView, {
      configured: true,
      accountInitialized,
      onLogin: vi.fn(async () => undefined),
      onRetry: vi.fn(),
    })
  );
}

describe("LoginView account state", () => {
  it("explains bootstrap credentials only before the first account setup", () => {
    const html = render(false);
    expect(html).toContain("首次使用 .env 初始凭据登录并设置账户");
    expect(html).toContain('placeholder="首次登录填写 APP_ID"');
    expect(html).toContain('placeholder="首次登录填写 APP_SECRET"');
  });

  it("asks for the persisted MySQL credentials after setup", () => {
    const html = render(true);
    expect(html).toContain("使用保存于 MySQL 的自定义用户名与密码登录");
    expect(html).toContain('placeholder="自定义用户名"');
    expect(html).toContain('placeholder="当前账户密码"');
    expect(html).not.toContain("首次登录填写 APP_ID");
  });
});
