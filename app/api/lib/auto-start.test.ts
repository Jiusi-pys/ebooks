import { describe, expect, it, vi } from "vitest";
import { createAutoStartManager } from "./auto-start";

describe("auto-start manager", () => {
  it("reads enabled state from a Linux user service", async () => {
    const run = vi.fn(async () => "LoadState=loaded\nUnitFileState=enabled\n");
    const manager = createAutoStartManager("linux", run);

    await expect(manager.status()).resolves.toEqual({
      supported: true,
      installed: true,
      enabled: true,
      platform: "linux",
    });
    expect(run).toHaveBeenCalledWith("systemctl", [
      "--user",
      "show",
      "--property=LoadState",
      "--property=UnitFileState",
      "shufang-book-manager.service",
    ]);
  });

  it("reports a missing Linux service without enabling it", async () => {
    const manager = createAutoStartManager(
      "linux",
      async () => "LoadState=not-found\nUnitFileState=\n"
    );

    await expect(manager.status()).resolves.toMatchObject({
      installed: false,
      enabled: false,
    });
  });

  it.each([true, false])(
    "sets Linux autostart to %s without starting it",
    async enabled => {
      const run = vi.fn(async (command: string, args: string[]) =>
        command === "systemctl" && args.includes("show")
          ? "LoadState=loaded\nUnitFileState=enabled\n"
          : ""
      );
      const manager = createAutoStartManager("linux", run);

      await manager.setEnabled(enabled);

      expect(run).toHaveBeenCalledWith("systemctl", [
        "--user",
        enabled ? "enable" : "disable",
        "shufang-book-manager.service",
      ]);
    }
  );

  it("reads the Windows scheduled task state", async () => {
    const run = vi.fn(async () => '{"installed":true,"enabled":true}');
    const manager = createAutoStartManager("win32", run);

    await expect(manager.status()).resolves.toEqual({
      supported: true,
      installed: true,
      enabled: true,
      platform: "windows",
    });
  });

  it("reports a disabled Windows scheduled task as installed but disabled", async () => {
    let command = "";
    const run = vi.fn(async (_executable: string, args: string[]) => {
      command = args.at(-1) ?? "";
      return '{"installed":true,"enabled":false}';
    });
    const manager = createAutoStartManager("win32", run);

    await expect(manager.status()).resolves.toMatchObject({
      installed: true,
      enabled: false,
    });
    expect(command).toContain("$task.State -ne 'Disabled'");
  });

  it("does not run operating-system commands on unsupported platforms", async () => {
    const run = vi.fn(async () => "");
    const manager = createAutoStartManager("darwin", run);

    await expect(manager.status()).resolves.toMatchObject({
      supported: false,
      installed: false,
      enabled: false,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("leaves startup management to the container runtime when configured", async () => {
    const run = vi.fn(async () => "");
    const manager = createAutoStartManager("linux", run, false);

    await expect(manager.status()).resolves.toMatchObject({
      supported: false,
      installed: false,
      enabled: false,
    });
    expect(run).not.toHaveBeenCalled();
  });
});
