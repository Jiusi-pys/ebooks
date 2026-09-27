import { describe, expect, it } from "vitest";
import {
  applyOperation,
  makeOperation,
  materialize,
  nextClock,
  compareClock,
  mergeStates,
} from "./sync";

describe("replica convergence", () => {
  it("preserves legacy translation IDs containing a language name", () => {
    const id = "book:chapter:中文";
    const op = makeOperation("w", "a", "translations", id, { text: "译文" });
    expect(materialize(applyOperation(undefined, op))?.id).toBe(id);
    expect(() => makeOperation("w", "a", "notes", "bad/id", {})).toThrow();
  });
  it("merges a fixed snapshot without replacing unacknowledged local fields", () => {
    const local = applyOperation(
      undefined,
      makeOperation("w", "a", "notes", "n", { title: "unsent" }, 5)
    );
    const snapshot = applyOperation(
      undefined,
      makeOperation(
        "w",
        "b",
        "notes",
        "n",
        { title: "old", content: "remote" },
        2
      )
    );
    expect(materialize(mergeStates(local, snapshot))).toEqual({
      id: "n",
      title: "unsent",
      content: "remote",
    });
  });
  it("treats special mind map identifiers as data", () => {
    const op = makeOperation(
      "w",
      "a",
      "mindMaps",
      "m",
      { "@node:__proto__:text": "safe", "@node:__proto__:parent": null },
      1
    );
    expect(
      (materialize(applyOperation(undefined, op))!.root as { text: string })
        .text
    ).toBe("safe");
    expect(Object.prototype).not.toHaveProperty("text");
  });
  it("keeps clocks exact beyond JavaScript safe integers", () => {
    expect(nextClock("9007199254740993:1", 1)).toBe("9007199254740993:2");
    expect(compareClock("9007199254740993:0", "9007199254740992:9")).toBe(1);
  });
  it("merges independently edited mind map nodes and set memberships", () => {
    const a = makeOperation(
      "w",
      "a",
      "mindMaps",
      "m",
      {
        root: {
          id: "r",
          text: "Root",
          children: [{ id: "a", text: "A", children: [] }],
        },
      },
      1
    );
    const b = makeOperation(
      "w",
      "b",
      "mindMaps",
      "m",
      { "@node:b:text": "B", "@node:b:parent": "r", "@node:b:order": 0 },
      2
    );
    const merge = materialize(applyOperation(applyOperation(undefined, a), b));
    expect(merge).toEqual(
      materialize(applyOperation(applyOperation(undefined, b), a))
    );
    expect((merge!.root as { children: unknown[] }).children).toHaveLength(2);
    const x = makeOperation("w", "a", "studySets", "s", { bookIds: ["a"] }, 1);
    const y = makeOperation("w", "b", "studySets", "s", { bookIds: ["b"] }, 1);
    expect(
      materialize(applyOperation(applyOperation(undefined, x), y))!.bookIds
    ).toEqual(["a", "b"]);
  });
  it("converges independently of arrival order, preserves unrelated fields and never resurrects deletes", () => {
    const a = makeOperation(
      "w",
      "a",
      "notes",
      "n",
      { title: "A", content: "old" },
      10
    );
    const b = makeOperation("w", "b", "notes", "n", { content: "new" }, 11);
    const first = applyOperation(applyOperation(undefined, a), b);
    const second = applyOperation(applyOperation(undefined, b), a);
    expect(materialize(first)).toEqual(materialize(second));
    expect(materialize(first)).toEqual({ id: "n", title: "A", content: "new" });
    const gone = { ...b, operationId: "delete", deleted: true };
    expect(
      materialize(
        applyOperation(applyOperation(first, gone), { ...a, clock: "999:0" })
      )
    ).toBeNull();
  });

  it("breaks concurrent ties consistently and keeps removed fields removed", () => {
    const a = makeOperation("w", "a", "notes", "n", { title: "A" }, 10);
    const b = {
      ...makeOperation("w", "b", "notes", "n", {}, 10),
      unset: ["title"],
    };
    expect(
      materialize(applyOperation(applyOperation(undefined, a), b))
    ).toEqual({ id: "n" });
    expect(
      materialize(applyOperation(applyOperation(undefined, b), a))
    ).toEqual({ id: "n" });
  });
});
