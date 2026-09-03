import { describe, expect, it } from "vitest";
import { isRecallHighlightConcealed, revealRecallHighlight } from "./recall";

describe("recall highlight reveal", () => {
  it("reveals every rendered part that shares the clicked highlight id", () => {
    const initial = new Set<string>();

    expect(isRecallHighlightConcealed(true, initial, "highlight-1")).toBe(true);

    const revealed = revealRecallHighlight(initial, "highlight-1");

    expect(initial.size).toBe(0);
    expect(isRecallHighlightConcealed(true, revealed, "highlight-1")).toBe(
      false
    );
    expect(isRecallHighlightConcealed(true, revealed, "highlight-2")).toBe(
      true
    );
  });

  it("does not conceal highlights outside recall mode", () => {
    expect(
      isRecallHighlightConcealed(false, new Set<string>(), "highlight-1")
    ).toBe(false);
  });
});
