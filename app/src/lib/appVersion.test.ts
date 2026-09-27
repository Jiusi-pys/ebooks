import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import { APP_VERSION } from "./appVersion";

describe("app version", () => {
  it("uses the package version as the displayed application version", () => {
    expect(APP_VERSION).toBe(packageJson.version);
    expect(APP_VERSION).toBe("0.1.0");
  });
});
