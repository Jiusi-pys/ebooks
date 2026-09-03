import { describe, expect, it } from "vitest";
import { createLatestRequestGate } from "./latestRequest";

describe("createLatestRequestGate", () => {
  it("accepts only the newest request ticket", () => {
    const gate = createLatestRequestGate();
    const first = gate.begin();
    const second = gate.begin();

    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  it("invalidates an in-flight request on unmount or mutation", () => {
    const gate = createLatestRequestGate();
    const request = gate.begin();
    gate.invalidate();

    expect(gate.isCurrent(request)).toBe(false);
  });
});
