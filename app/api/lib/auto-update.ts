import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repositoryDirectory = resolve(appDirectory, "..");
type CommandRunner = (
  command: string,
  args: string[],
  cwd: string
) => Promise<string>;

function runCommand(
  command: string,
  args: string[],
  cwd: string
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32" && command.endsWith(".cmd"),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", chunk => (stderr += chunk));
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} exited with ${code}`));
    });
  });
}

export function millisecondsUntilNextRun(now: Date, time: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) throw new Error("AUTO_UPDATE_TIME must use HH:mm format");
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new Error("AUTO_UPDATE_TIME must be a valid 24-hour time");
  }
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export async function replaceApplication(
  currentApp: string,
  stagedApp: string,
  beforeInstall: () => Promise<void> = async () => {}
) {
  const backupApp = `${currentApp}.auto-update-backup`;
  await rm(backupApp, { recursive: true, force: true });
  for (const name of [".env", ".runtime"]) {
    const source = join(currentApp, name);
    if (existsSync(source)) {
      await cp(source, join(stagedApp, name), { recursive: true, force: true });
    }
  }

  await rename(currentApp, backupApp);
  try {
    await beforeInstall();
    await rename(stagedApp, currentApp);
  } catch (error) {
    await rm(currentApp, { recursive: true, force: true });
    await rename(backupApp, currentApp);
    throw error;
  }
  await rm(backupApp, { recursive: true, force: true }).catch(error => {
    console.warn("Unable to remove application backup:", error);
  });
}

export function createUpdater(options: {
  repoUrl: string;
  time: string;
  branch: string;
  currentApp: string;
  repositoryDirectory: string;
  runCommand: CommandRunner;
  exit: (code: number) => void;
}) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  async function update() {
    const temporaryDirectory = await mkdtemp(
      join(dirname(options.repositoryDirectory), ".shufang-update-")
    );
    try {
      const git = process.platform === "win32" ? "git.exe" : "git";
      await options.runCommand(
        git,
        ["clone", "--depth", "1", "--branch", options.branch, options.repoUrl, temporaryDirectory],
        options.repositoryDirectory
      );
      const remoteCommit = await options.runCommand(
        git,
        ["-C", temporaryDirectory, "rev-parse", "HEAD"],
        options.repositoryDirectory
      );
      const statePath = join(options.currentApp, ".runtime", "auto-update-commit");
      if (existsSync(statePath) && readFileSync(statePath, "utf8").trim() === remoteCommit) {
        console.log("GitHub source is unchanged; skipping restart.");
        return;
      }
      const stagedApp = join(temporaryDirectory, "app");
      if (
        !existsSync(join(stagedApp, "package.json")) ||
        !existsSync(join(stagedApp, "package-lock.json"))
      ) {
        throw new Error("GitHub source must contain app/package.json and app/package-lock.json");
      }
      await options.runCommand(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["ci", "--no-audit", "--no-fund"],
        stagedApp
      );
      await options.runCommand(
        process.platform === "win32" ? "npm.cmd" : "npm",
        ["run", "build"],
        stagedApp
      );

      await mkdir(join(stagedApp, ".runtime"), { recursive: true });
      await writeFile(
        join(stagedApp, ".runtime", "auto-update-commit"),
        remoteCommit
      );
      console.log("GitHub update built successfully; switching application files.");
      await replaceApplication(options.currentApp, stagedApp);
      console.log("GitHub update installed; exiting for supervisor restart.");
      options.exit(75);
    } catch (error) {
      console.error("Automatic GitHub update failed; current version remains active:", error);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  function scheduleNext() {
    if (stopped) return;
    timeout = setTimeout(() => {
      void update().finally(scheduleNext);
    }, millisecondsUntilNextRun(new Date(), options.time));
    timeout.unref?.();
  }

  return {
    start() {
      if (!/^[A-Za-z0-9._/-]+$/.test(options.branch)) {
        throw new Error("AUTO_UPDATE_BRANCH contains unsupported characters");
      }
      scheduleNext();
    },
    stop() {
      stopped = true;
      if (timeout) clearTimeout(timeout);
    },
    update,
  };
}

export function startAutoUpdate(exit: (code: number) => void = code => process.exit(code)) {
  if (process.env.AUTO_UPDATE_ENABLED !== "true") return;
  const repoUrl = process.env.AUTO_UPDATE_GITHUB_URL?.trim();
  const time = process.env.AUTO_UPDATE_TIME?.trim();
  if (!repoUrl || !time) {
    throw new Error(
      "AUTO_UPDATE_ENABLED requires AUTO_UPDATE_GITHUB_URL and AUTO_UPDATE_TIME"
    );
  }
  if (!existsSync(join(repositoryDirectory, ".git"))) {
    console.warn("Automatic updates require a local Git checkout; updater disabled.");
    return;
  }
  if (process.env.AUTO_UPDATE_RESTART_SUPERVISED !== "true") {
    throw new Error(
      "Automatic updates require AUTO_UPDATE_RESTART_SUPERVISED=true after configuring a process supervisor"
    );
  }
  const updater = createUpdater({
    repoUrl,
    time,
    branch: process.env.AUTO_UPDATE_BRANCH?.trim() || "main",
    currentApp: appDirectory,
    repositoryDirectory,
    runCommand,
    exit,
  });
  const git = process.platform === "win32" ? "git.exe" : "git";
  void runCommand(git, ["-C", repositoryDirectory, "remote", "get-url", "origin"], repositoryDirectory)
    .then(remote => {
      const normalize = (value: string) => value.trim().replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
      if (normalize(remote) !== normalize(repoUrl)) {
        throw new Error(
          `AUTO_UPDATE_GITHUB_URL does not match this checkout's origin (${remote})`
        );
      }
      updater.start();
      console.log(
        `Automatic GitHub updates enabled for ${process.env.AUTO_UPDATE_BRANCH || "main"} at ${time} daily.`
      );
    })
    .catch(error => {
      console.error("Automatic updater was not started:", error);
    });
  process.once("SIGINT", () => updater.stop());
  process.once("SIGTERM", () => updater.stop());
}
