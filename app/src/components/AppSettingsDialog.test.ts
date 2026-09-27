// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppSettingsDialog } from "./AppSettingsDialog";

const state = (enabled: boolean, installed = true) => ({
  supported: true,
  installed,
  enabled,
  platform: "windows",
});

describe("AppSettingsDialog automatic startup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("explains how to install the startup task when it is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(state(false, false))))
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(AppSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("install-autostart.ps1");

    await act(async () => root.unmount());
    host.remove();
  });

  it("explains that Docker manages startup for container deployments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              supported: false,
              installed: false,
              enabled: false,
              platform: "linux",
              reason: "managed_externally",
            })
          )
      )
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(AppSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("由 Docker 管理");
    expect(document.body.textContent).toContain("自动重启策略");

    await act(async () => root.unmount());
    host.remove();
  });

  it("lets the user switch an installed startup task on or off", async () => {
    let enabled = false;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          enabled = JSON.parse(String(init.body)).enabled;
        }
        return new Response(JSON.stringify(state(enabled)));
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(AppSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const enable = Array.from(document.querySelectorAll("button")).find(
      button => button.textContent?.includes("启用")
    );
    expect(enable).toBeTruthy();
    await act(async () => {
      enable!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/autostart/status",
      expect.objectContaining({ method: "POST" })
    );
    expect(document.body.textContent).toContain("已启用");

    await act(async () => root.unmount());
    host.remove();
  });
});
