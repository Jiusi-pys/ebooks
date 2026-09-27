import { execFile } from "node:child_process";
import { promisify } from "node:util";

const TASK_NAME = "ShufangBookManager";
const UNIT_NAME = "shufang-book-manager.service";

export interface AutoStartState {
  supported: boolean;
  installed: boolean;
  enabled: boolean;
  platform: "windows" | "linux" | "unsupported";
  reason?: "managed_externally" | "unsupported_platform";
}

type Platform = string;
type CommandRunner = (command: string, args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);
const runCommand: CommandRunner = async (command, args) => {
  const result = await execFileAsync(command, args, {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 128 * 1024,
  });
  return result.stdout;
};

function platformName(platform: Platform): AutoStartState["platform"] {
  if (platform === "win32") return "windows";
  if (platform === "linux") return "linux";
  return "unsupported";
}

export function createAutoStartManager(
  platform: Platform = process.platform,
  run: CommandRunner = runCommand,
  managed = process.env.AUTO_START_MANAGED !== "false"
) {
  const name = platformName(platform);

  async function status(): Promise<AutoStartState> {
    if (name === "unsupported")
      return {
        supported: false,
        installed: false,
        enabled: false,
        platform: name,
        reason: "unsupported_platform",
      };
    if (!managed)
      return {
        supported: false,
        installed: false,
        enabled: false,
        platform: name,
        reason: "managed_externally",
      };

    if (name === "linux") {
      const output = await run("systemctl", [
        "--user",
        "show",
        "--property=LoadState",
        "--property=UnitFileState",
        UNIT_NAME,
      ]);
      const properties = Object.fromEntries(
        output
          .split(/\r?\n/)
          .filter(Boolean)
          .map(line => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          })
      );
      const installed = properties.LoadState === "loaded";
      return {
        supported: true,
        installed,
        enabled:
          installed &&
          ["enabled", "enabled-runtime", "linked", "linked-runtime"].includes(
            properties.UnitFileState
          ),
        platform: name,
      };
    }

    const output = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `& { $task = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue; if ($null -eq $task) { '{"installed":false,"enabled":false}'; exit 0 }; $enabled = $task.State -ne 'Disabled'; ConvertTo-Json -Compress @{ installed = $true; enabled = [bool]$enabled } }`,
    ]);
    if (!output.trim())
      return {
        supported: true,
        installed: false,
        enabled: false,
        platform: name,
      };
    const task = JSON.parse(output) as {
      installed?: unknown;
      enabled?: unknown;
    };
    if (
      typeof task.installed !== "boolean" ||
      typeof task.enabled !== "boolean"
    )
      throw new Error("Invalid scheduled task status");
    return {
      supported: true,
      installed: task.installed,
      enabled: task.enabled,
      platform: name,
    };
  }

  async function setEnabled(enabled: boolean): Promise<AutoStartState> {
    if (name === "unsupported" || !managed)
      throw new Error("Automatic startup is unsupported on this platform");
    const current = await status();
    if (!current.installed)
      throw new Error("Install the Shufang startup task first");
    if (name === "linux") {
      await run("systemctl", [
        "--user",
        enabled ? "enable" : "disable",
        UNIT_NAME,
      ]);
    } else {
      await run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `${enabled ? "Enable" : "Disable"}-ScheduledTask -TaskName '${TASK_NAME}' | Out-Null`,
      ]);
    }
    return status();
  }

  return { status, setEnabled };
}

export const autoStartManager = createAutoStartManager();
