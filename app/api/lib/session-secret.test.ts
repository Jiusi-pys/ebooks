import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDataSecret, resolveSessionSecret } from "./session-secret";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "shufang-session-secret-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("session signing secret", () => {
  it("requires at least 32 bytes when explicitly configured", () => {
    expect(() =>
      resolveSessionSecret(
        { APP_SESSION_SECRET: "too-short" },
        temporaryDirectory()
      )
    ).toThrow("APP_SESSION_SECRET must contain at least 32 bytes");
  });

  it("generates and reuses a persistent local secret when omitted", () => {
    const directory = temporaryDirectory();
    const first = resolveSessionSecret({}, directory);
    const second = resolveSessionSecret({}, directory);
    expect(Buffer.byteLength(first, "utf8")).toBeGreaterThanOrEqual(32);
    expect(second).toBe(first);
    expect(readFileSync(join(directory, "session-secret"), "utf8").trim()).toBe(
      first
    );
  });
});

describe("application data secret", () => {
  it("requires at least 32 bytes when explicitly configured", () => {
    expect(() =>
      resolveDataSecret({ APP_DATA_SECRET: "too-short" }, temporaryDirectory())
    ).toThrow("APP_DATA_SECRET must contain at least 32 bytes");
  });

  it("is generated separately from the session key", () => {
    const directory = temporaryDirectory();
    const session = resolveSessionSecret({}, directory);
    const data = resolveDataSecret({}, directory);
    expect(data).not.toBe(session);
    expect(readFileSync(join(directory, "data-secret"), "utf8").trim()).toBe(
      data
    );
  });
});
