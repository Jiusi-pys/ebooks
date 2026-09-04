import { describe, expect, it } from "vitest";
import { mirrorSafeBookField } from "./parseMetadataField";

describe("mirrorSafeBookField", () => {
  it("normalizes and limits parser-derived book fields to 255 characters", () => {
    expect(mirrorSafeBookField(`  ${"书".repeat(300)}\0  `)).toBe(
      "书".repeat(255)
    );
  });

  it("does not leave a split surrogate pair at the boundary", () => {
    expect(mirrorSafeBookField(`${"a".repeat(254)}😀x`)).toBe("a".repeat(254));
  });
});
