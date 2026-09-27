// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { APP_VERSION } from "@/lib/appVersion";
import { AccountSettingsDialog } from "./AccountSettingsDialog";

describe("AccountSettingsDialog", () => {
  it("shows the application version when opened from the user card", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(AccountSettingsDialog, {
          open: true,
          username: "reader",
          onOpenChange: vi.fn(),
          onUpdate: vi.fn(async () => undefined),
        })
      )
    );

    expect(document.body.textContent).toContain(`应用版本v${APP_VERSION}`);

    await act(async () => root.unmount());
    host.remove();
  });
});
