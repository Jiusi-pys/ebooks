import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveMigrationsFolder } from "./migration-path";

describe("resolveMigrationsFolder", () => {
  it("resolves migrations from the application working directory", () => {
    expect(resolveMigrationsFolder("/app")).toBe(
      resolve("/app", "db/migrations")
    );
  });
});
