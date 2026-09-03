import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_AUTH_REQUIRED_EVENT } from "./auth-events";
import { readCodexAuthJson } from "./codexAuthResponse";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("readCodexAuthJson", () => {
  it("dispatches auth-required before reading a malformed 401 body", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    const response = new Response("not-json", { status: 401 });

    await expect(readCodexAuthJson(response)).rejects.toThrow(
      "Codex 登录服务返回 401"
    );
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
      type: APP_AUTH_REQUIRED_EVENT,
    });
  });

  it("preserves a 401 message and ignores non-session failures", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });

    await expect(
      readCodexAuthJson(
        new Response(JSON.stringify({ message: "请重新登录书房" }), {
          status: 401,
        })
      )
    ).rejects.toThrow("请重新登录书房");
    await expect(
      readCodexAuthJson(new Response("{}", { status: 409 }))
    ).rejects.toThrow("Codex 登录服务返回 409");
    expect(dispatchEvent).toHaveBeenCalledOnce();
  });

  it("does not confuse a successful unauthenticated CLI status with app auth", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });

    await expect(
      readCodexAuthJson<{ authenticated: boolean }>(
        new Response(JSON.stringify({ authenticated: false }), { status: 200 })
      )
    ).resolves.toEqual({ authenticated: false });
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});
