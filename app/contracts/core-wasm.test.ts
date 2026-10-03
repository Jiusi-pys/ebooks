import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WasmCore } from "./core-wasm";
import {
  applyOperation as publicApplyOperation,
  mergeStates as publicMergeStates,
  validatePatch,
  type Operation,
} from "./sync";
import {
  applyOperation,
  flattenFields,
  makeOperation,
  materialize,
  mergeStates,
  nextClock,
  compareClock,
  stableJson as legacyStableJson,
} from "./testing/legacy-sync";

const core = new WasmCore(
  readFileSync(
    new URL(
      "../../base/target/wasm32-unknown-unknown/release/shufang_bindings.wasm",
      import.meta.url
    )
  )
);

describe("native/WASM workspace-v2 compatibility", () => {
  it("hashes chunked field bytes synchronously without enlarging the JSON ABI", () => {
    const handle = core.execute<number>("fieldHashBegin", {});
    core.execute("fieldHashAppend", { handle, hex: "61" });
    core.execute("fieldHashAppend", { handle, hex: "6263" });
    expect(core.execute("fieldHashFinish", { handle })).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    expect(() => core.execute("fieldHashFinish", { handle })).toThrow();
    expect(core.execute("externalFieldPolicy", { size: 131072 })).toBe(false);
    expect(core.execute("externalFieldPolicy", { size: 131073 })).toBe(true);
    expect(() =>
      core.execute("externalFieldPolicy", { size: 268435457 })
    ).toThrow();
  });
  it("plans the same folder deletion cascade for Web and native callers", () => {
    const books = [
      { id: "a", folderId: "folder" },
      { id: "b", folderId: "other" },
      { id: "c" },
      { id: "d", folderId: "folder" },
      { id: "\ud800", folderId: "folder" },
      { id: "unrelated", folderId: "\udfff" },
    ];
    expect(
      JSON.parse(
        core.execute<string>("planFolderDeletion", {
          folderJson: JSON.stringify("folder"),
          booksJson: JSON.stringify(books),
        })
      )
    ).toEqual(["a", "d", "\ud800"]);
    expect(
      JSON.parse(
        core.execute<string>("planFolderDeletion", {
          folderJson: JSON.stringify("missing"),
          booksJson: JSON.stringify(books),
        })
      )
    ).toEqual([]);
  });
  it("requires a complete persisted receipt set before acknowledging operations", () => {
    const operationIds = ["one", "two"];
    const receipts = [
      { operationId: "one", seq: "1", duplicate: false },
      { operationId: "two", seq: "18446744073709551615", persisted: true },
    ];
    expect(
      core.execute("validateSyncReceipts", { operationIds, receipts })
    ).toBe(true);
    for (const invalid of [
      null,
      {},
      receipts.slice(0, 1),
      [...receipts, receipts[0]],
      [...receipts].reverse(),
      [receipts[0], { ...receipts[1], operationId: "other" }],
      [receipts[0], { ...receipts[1], persisted: false }],
      [receipts[0], { ...receipts[1], error: null }],
      ...["0", "-1", "1.5", "1e2", "", "18446744073709551616", 2].map(seq => [
        receipts[0],
        { ...receipts[1], seq },
      ]),
    ]) {
      expect(() =>
        core.execute("validateSyncReceipts", {
          operationIds,
          receipts: invalid,
        })
      ).toThrow();
    }
  });
  it("normalizes study-set edits in core while retaining UTF-16 and extension fields", () => {
    const value = {
      id: "set",
      name: " \ufeff\ud800 ",
      description: "\udfff",
      bookIds: ["b", "a", "b", "\ud800", "\ud800"],
      createdAt: 1,
      updatedAt: 2,
      future: { "\ud800": "keep" },
    };
    const result = JSON.parse(
      core.execute<string>("normalizeStudySet", {
        recordJson: JSON.stringify(value),
        now: 100,
      })
    );
    expect(result).toEqual({
      ...value,
      name: value.name.trim(),
      bookIds: [...new Set(value.bookIds)],
      updatedAt: 100,
    });
    const empty = { ...value, name: " \ufeff " };
    expect(
      JSON.parse(
        core.execute<string>("normalizeStudySet", {
          recordJson: JSON.stringify(empty),
          now: 101,
        })
      ).name
    ).toBe("未命名学习集");
  });
  it("creates library records with the browser's defaults and exact UTF-16 trimming", () => {
    for (const name of ["", " \t\ufeff", " \ud800 \n", "　中文😀　"]) {
      for (const kind of ["notes", "folders", "studySets"]) {
        const actual = JSON.parse(
          core.execute<string>("createLibraryRecord", {
            kind,
            id: "new-id",
            nameJson: JSON.stringify(name),
            createdAt: 100,
            updatedAt: 101,
          })
        );
        const normalized = name.trim();
        const expected =
          kind === "notes"
            ? {
                id: "new-id",
                title: normalized || "未命名笔记",
                content: "",
                createdAt: 100,
                updatedAt: 101,
              }
            : kind === "folders"
              ? {
                  id: "new-id",
                  name: normalized || "未命名文件夹",
                  createdAt: 100,
                }
              : {
                  id: "new-id",
                  name: normalized || "未命名学习集",
                  description: "",
                  bookIds: [],
                  createdAt: 100,
                  updatedAt: 101,
                };
        expect(actual).toEqual(expected);
      }
    }
  });
  it("applies and merges actual surrogate payloads without host slots", () => {
    const first = makeOperation(
      "w",
      "a",
      "notes",
      "n",
      { "\ud800": { title: "\udfff", slot: 0 }, title: "\ud800" },
      10
    );
    const second = makeOperation(
      "w",
      "b",
      "notes",
      "n",
      { content: "\udfff" },
      11
    );
    const state = JSON.parse(
      core.execute<string>("applyReplicaOperation", {
        priorJson: null,
        operationJson: JSON.stringify(first),
      })
    );
    expect(state).toEqual(applyOperation(undefined, first));
    const incoming = JSON.parse(
      core.execute<string>("applyReplicaOperation", {
        priorJson: null,
        operationJson: JSON.stringify(second),
      })
    );
    expect(
      JSON.parse(
        core.execute<string>("mergeReplicaStates", {
          priorJson: JSON.stringify(state),
          incomingJson: JSON.stringify(incoming),
        })
      )
    ).toEqual(mergeStates(state, incoming));
    const deletion = {
      ...second,
      operationId: "delete",
      unset: ["\ud800"],
      clock: "12:0",
      deleted: true,
    };
    expect(
      JSON.parse(
        core.execute<string>("applyReplicaOperation", {
          priorJson: JSON.stringify(state),
          operationJson: JSON.stringify(deletion),
        })
      )
    ).toEqual(applyOperation(state, deletion));
  });
  it("canonicalizes arbitrary UTF-16 keys/text and binary64 numbers exactly like JavaScript", () => {
    const values: unknown[] = [
      {
        "\ud800": "\udfff",
        "😀": "\ud800\ud800",
        "\ue000": -0,
        marker: "@core-key:0",
      },
      [
        null,
        true,
        false,
        1e21,
        1e20,
        1e-7,
        1e-6,
        Number.MIN_VALUE,
        Number.MAX_VALUE,
        9007199254740992,
      ],
    ];
    const bits = new DataView(new ArrayBuffer(8));
    let seed = 0x12345678;
    for (let i = 0; i < 10000; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      bits.setUint32(0, seed);
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      bits.setUint32(4, seed);
      const value = bits.getFloat64(0);
      if (Number.isFinite(value)) values.push(value);
    }
    for (const value of values) {
      expect(
        core.execute("normalizeJson", {
          json: JSON.stringify(value),
          canonical: true,
        })
      ).toBe(legacyStableJson(value));
    }
  });
  it("matches legacy partial projection validation for known fields and blob references", () => {
    const cases: [Operation["kind"], Record<string, unknown>][] = [
      ["notes", { title: "正文", createdAt: 0, updatedAt: -1 }],
      ["notes", { title: 42 }],
      ["notes", { content: null }],
      ["notes", { unknownFutureField: [1, { nested: true }] }],
      ["books", { format: "epub" }],
      ["books", { format: "unknown" }],
      [
        "books",
        { chapters: [{ id: "c", title: "Chapter", paragraphs: ["text"] }] },
      ],
      [
        "books",
        { chapters: [{ id: "c", title: "Chapter", paragraphs: [42] }] },
      ],
      ["books", { progress: { chapterId: "c", ratio: 2, future: true } }],
      ["books", { progress: { ratio: 1 } }],
      [
        "books",
        {
          readingSessions: [
            { id: "s", bookId: "中文", startedAt: 0, endedAt: 1 },
          ],
        },
      ],
      [
        "books",
        {
          readingSessions: [{ id: "s", bookId: "b", startedAt: 2, endedAt: 1 }],
        },
      ],
      [
        "books",
        {
          readingSessions: [
            { id: "s", bookId: "b", startedAt: 0, endedAt: 1, extra: true },
          ],
        },
      ],
      ["folders", { name: false }],
      ["highlights", { chapterTitle: "Title", text: "Text" }],
      ["highlights", { bookId: [] }],
      ["translations", { updatedAt: "now" }],
      [
        "mindMaps",
        { root: { id: "r", text: "Root", children: [null, 42, {}] } },
      ],
      ["mindMaps", { root: { id: "r", text: "Root" } }],
      ["studySets", { bookIds: ["a", "b"] }],
      ["studySets", { bookIds: [1] }],
      [
        "associations",
        { source: { bookId: "a", extra: true }, direction: "bidirectional" },
      ],
      ["associations", { target: {}, direction: "reverse" }],
      [
        "sources",
        {
          sha256: "a".repeat(64),
          size: 268435456,
          name: "😀".repeat(127),
          type: "",
        },
      ],
      ["sources", { sha256: "A".repeat(64) }],
      ["sources", { size: -1 }],
      ["sources", { size: 0.5 }],
      ["sources", { size: 268435457 }],
      ["sources", { name: "😀".repeat(128) }],
      ["sources", { type: "x".repeat(129) }],
      ["notes", { title: { $blob: { sha256: "a".repeat(64), size: 0 } } }],
      ["notes", { title: { $blob: { sha256: "invalid", size: 0 } } }],
      ["reviews", { rating: "legacy extension" }],
      ["preferences", { theme: null }],
    ];
    for (const [kind, patch] of cases) {
      const operation = {
        workspaceId: "w",
        replicaId: "a",
        operationId: "op",
        entityId: "n",
        clock: "1:0",
        kind,
        patch,
        unset: [],
        deleted: false,
      } as Operation;
      let oldValid = true;
      try {
        validatePatch(operation);
      } catch {
        oldValid = false;
      }
      let coreValid = true;
      try {
        core.execute("validatePatch", { operation });
      } catch {
        coreValid = false;
      }
      expect(coreValid, JSON.stringify({ kind, patch })).toBe(oldValid);
    }
  });
  it("keeps exact clocks including values outside the JS safe integer range", () => {
    for (const [clock, now] of [
      ["0:0", 100],
      ["9007199254740993:1", 1],
    ] as const)
      expect(core.execute("nextClock", { previous: clock, now })).toBe(
        nextClock(clock, now)
      );
    expect(core.execute("compareClock", { a: "10:2", b: "9:99" })).toBe(
      compareClock("10:2", "9:99")
    );
  });

  it.each([
    ["notes", { title: "书房😀", content: "正文" }],
    [
      "books",
      {
        progress: { chapterId: "c", ratio: 0.25 },
        readingSessions: [{ id: "a", bookId: "n", startedAt: 1, endedAt: 2 }],
      },
    ],
    ["studySets", { bookIds: ["😀", "中", "a"] }],
    [
      "mindMaps",
      {
        root: {
          id: "root",
          text: "Root",
          children: [{ id: "__proto__", text: "safe", children: [] }],
        },
      },
    ],
  ] as const)(
    "matches existing flatten/apply/project for %s",
    (kind, patch) => {
      expect(core.execute("flattenFields", { kind, value: patch })).toEqual(
        flattenFields(kind, patch)
      );
      const op = makeOperation("w", "a", kind, "n", patch, 123);
      const old = applyOperation(undefined, op);
      const state = core.execute("applyOperation", {
        prior: null,
        operation: op,
      });
      expect(state).toEqual(old);
      expect(core.execute("materialize", { state })).toEqual(materialize(old));
      expect(
        core.execute("mergeStates", { prior: null, incoming: state })
      ).toEqual(mergeStates(undefined, old));
    }
  );

  it("rejects invalid commands without corrupting subsequent calls", () => {
    expect(() => core.execute("not-a-command", {})).toThrow("invalid_command");
    expect(core.execute("nextClock", { previous: "0:0", now: 1 })).toBe("1:0");
  });

  it("preserves legacy JSON text containing an unpaired UTF-16 code unit", () => {
    const op = makeOperation("w", "a", "notes", "n", { content: "\ud800" }, 1);
    // Opaque host value slots preserve text through version merging. Direct
    // UTF-8 JSON commands still reject the invalid Unicode scalar sequence.
    expect(publicApplyOperation(undefined, op)).toEqual(
      applyOperation(undefined, op)
    );
    expect(() =>
      core.execute("applyOperation", { prior: null, operation: op })
    ).toThrow("invalid_json");
  });

  it("preserves large fields, legacy field names and values that resemble slot markers", () => {
    const op = makeOperation(
      "w",
      "a",
      "notes",
      "n",
      {
        content: "x".repeat(17 * 1024 * 1024),
        "\ud800": { slot: 0, text: "\udfff" },
        "@core-key:0": "ordinary user field",
        metadata: null,
      },
      10
    );
    const expected = applyOperation(undefined, op);
    const actual = publicApplyOperation(undefined, op);
    expect(actual).toEqual(expected);
    const incoming = applyOperation(
      undefined,
      makeOperation("w", "b", "notes", "n", { title: "remote" }, 11)
    );
    expect(publicMergeStates(actual, incoming)).toEqual(
      mergeStates(expected, incoming)
    );
  });

  it.each([null, false, 0, ""])(
    "preserves legacy progress truthiness for %s",
    progress => {
      const op = makeOperation("w", "a", "books", "n", { progress }, 1);
      expect(publicApplyOperation(undefined, op)).toEqual(
        applyOperation(undefined, op)
      );
    }
  );

  it("converges with the frozen implementation for reordered, repeated and deleted operations", () => {
    for (let index = 0; index < 64; index++) {
      const operations = [
        makeOperation(
          "w",
          "a",
          "notes",
          "n",
          {
            title: `标题${index}😀`,
            content: "old",
            metadata: { empty: null, tags: ["中", "en"] },
          },
          index + 1
        ),
        makeOperation("w", "b", "notes", "n", { content: "new" }, index + 2),
        {
          ...makeOperation("w", "c", "notes", "n", {}, index + 2),
          unset: ["title"],
          deleted: index % 7 === 0,
        },
      ];
      for (const sequence of [
        operations,
        [...operations].reverse(),
        [...operations, operations[0]],
      ]) {
        let expected: ReturnType<typeof applyOperation> | undefined;
        let actual: ReturnType<typeof applyOperation> | null = null;
        for (const operation of sequence) {
          expected = applyOperation(expected, operation);
          actual = core.execute("applyOperation", { prior: actual, operation });
        }
        expect(actual).toEqual(expected);
        expect(core.execute("materialize", { state: actual })).toEqual(
          materialize(expected!)
        );
      }
    }
  });
});
