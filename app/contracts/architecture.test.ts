import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? files(file)
      : /\.tsx?$/.test(file)
        ? [file]
        : [];
  });
}

describe("shared domain dependency boundary", () => {
  it("does not let backend production code import the presentation tree", () => {
    const violations = files(path.join(root, "api"))
      .filter(file => !file.endsWith(".test.ts"))
      .filter(file =>
        /(?:from\s*|import\s*\()["'][^"']*(?:\/src\/|@\/)/.test(
          readFileSync(file, "utf8")
        )
      );
    expect(violations.map(file => path.relative(root, file))).toEqual([]);
  });

  it("keeps shared business types independent of view routing and browser APIs", () => {
    const source = readFileSync(path.join(root, "contracts/domain.ts"), "utf8");
    expect(source).not.toMatch(/\b(?:Route|ViewName|ReaderFont|ReaderTheme)\b/);
    expect(source).not.toMatch(
      /\b(?:window|document|localStorage|HTMLElement)\b/
    );
  });

  it("does not import a legacy test oracle from production", () => {
    const violations = ["src", "api", "contracts"]
      .flatMap(directory => files(path.join(root, directory)))
      .filter(
        file =>
          !file.endsWith(".test.ts") &&
          !file.includes(`${path.sep}testing${path.sep}`)
      )
      .filter(file =>
        /from\s*["'][^"']*testing\//.test(readFileSync(file, "utf8"))
      );
    expect(violations).toEqual([]);
  });
});
