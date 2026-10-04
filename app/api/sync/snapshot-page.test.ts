import { describe, expect, it } from "vitest";
import { boundedSnapshotEntities } from "./snapshot-page";

describe("snapshot page byte limit", () => {
  it("advances only past entities included in the response", () => {
    const states = Array.from({ length: 3 }, (_, index) => ({
      kind: "notes",
      id: String(index),
      fields: { content: "x".repeat(500) },
    }));
    const first = boundedSnapshotEntities(states, "checkpoint", 900);
    expect(first.entities).toHaveLength(1);
    expect(first.next).toBe("notes:0");
    expect(
      Buffer.byteLength(JSON.stringify({ ...first, cursor: "checkpoint" }))
    ).toBeLessThanOrEqual(900);
    expect(
      boundedSnapshotEntities(states.slice(1), "checkpoint", 900).next
    ).toBe("notes:1");
  });
  it("rejects an entity too large for any page", () => {
    expect(() =>
      boundedSnapshotEntities(
        [{ kind: "notes", id: "x", fields: { content: "x".repeat(1000) } }],
        "checkpoint",
        100
      )
    ).toThrow("snapshot_entity_too_large");
  });
});
