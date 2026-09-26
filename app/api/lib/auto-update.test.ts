import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { millisecondsUntilNextRun, replaceApplication } from "./auto-update";

const directories: string[] = [];

function makeDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "shufang-update-test-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("daily update schedule", () => {
  it("schedules the next occurrence in local time", () => {
    const now = new Date(2026, 8, 27, 1, 30, 0);
    expect(millisecondsUntilNextRun(now, "03:00")).toBe(90 * 60 * 1000);
    expect(millisecondsUntilNextRun(new Date(2026, 8, 27, 3), "03:00")).toBe(
      24 * 60 * 60 * 1000
    );
  });

  it("rejects malformed and out-of-range times", () => {
    expect(() => millisecondsUntilNextRun(new Date(), "3:00")).toThrow(
      "HH:mm"
    );
    expect(() => millisecondsUntilNextRun(new Date(), "24:00")).toThrow(
      "24-hour"
    );
  });
});

describe("application replacement", () => {
  it("preserves local environment and runtime data and restores on failure", async () => {
    const root = makeDirectory();
    const app = join(root, "app");
    const staged = join(root, "staged-app");
    mkdirSync(join(app, ".runtime"), { recursive: true });
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(app, ".env"), "LOCAL_SECRET=keep");
    writeFileSync(join(app, ".runtime", "state"), "keep");
    writeFileSync(join(app, "version"), "old");
    writeFileSync(join(staged, "version"), "new");

    await expect(
      replaceApplication(app, staged, async () => {
        throw new Error("injected replacement failure");
      })
    ).rejects.toThrow("injected replacement failure");

    expect(readFileSync(join(app, ".env"), "utf8")).toBe("LOCAL_SECRET=keep");
    expect(readFileSync(join(app, ".runtime", "state"), "utf8")).toBe("keep");
    expect(readFileSync(join(app, "version"), "utf8")).toBe("old");
  });
});
