import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  bookRows: [] as Record<string, unknown>[],
  noteRows: [] as Record<string, unknown>[],
  noteTombstoneRows: [] as Record<string, unknown>[],
  inserted: null as Record<string, unknown> | null,
  upserted: null as Record<string, unknown> | null,
  updated: null as Record<string, unknown> | null,
  noteUpdates: [] as Record<string, unknown>[],
  events: [] as Record<string, unknown>[],
  receiptTable: null as unknown,
  bookTable: null as unknown,
  highlightTable: null as unknown,
  noteTable: null as unknown,
  noteTombstoneTable: null as unknown,
}));

vi.mock("./queries/connection", () => ({
  getDb: () => {
    const operations = {
      select: () => {
        const root = {
          from: (table: unknown) => {
            let limit: number | undefined;
            const rows = () => {
              const values =
                table === state.bookTable
                  ? state.bookRows
                  : table === state.noteTable
                    ? state.noteRows
                    : table === state.noteTombstoneTable
                      ? state.noteTombstoneRows
                      : state.rows;
              return limit === undefined ? values : values.slice(0, limit);
            };
            const builder = {
              where: () => builder,
              limit: (count: number) => {
                limit = count;
                return builder;
              },
              for: async () => rows(),
              then: (
                resolve: (value: Record<string, unknown>[]) => unknown,
                reject: (reason: unknown) => unknown
              ) => Promise.resolve(rows()).then(resolve, reject),
            };
            return builder;
          },
        };
        return root;
      },
      insert: (table: unknown) => ({
        ignore: () => ({
          values: async () => [{ affectedRows: 1 }],
        }),
        values: (value: Record<string, unknown>) => {
          if (table === state.receiptTable) {
            return Promise.resolve([{ affectedRows: 1 }]);
          }
          state.inserted = value;
          return {
            onDuplicateKeyUpdate: async ({
              set,
            }: {
              set: Record<string, unknown>;
            }) => {
              state.upserted = set;
              if (table === state.highlightTable && state.inserted) {
                const extId = state.inserted.extId;
                const index = state.rows.findIndex(row => row.extId === extId);
                if (index >= 0) {
                  state.rows[index] = { ...state.rows[index], ...set };
                } else {
                  state.rows.push({ ...state.inserted });
                }
              } else if (table === state.noteTable && state.inserted) {
                const extId = state.inserted.extId;
                const index = state.noteRows.findIndex(
                  row => row.extId === extId
                );
                if (index >= 0) {
                  state.noteRows[index] = { ...state.noteRows[index], ...set };
                } else {
                  state.noteRows.push({ ...state.inserted });
                }
              } else if (table === state.noteTombstoneTable && state.inserted) {
                const extId = state.inserted.extId;
                if (!state.noteTombstoneRows.some(row => row.extId === extId)) {
                  state.noteTombstoneRows.push({ ...state.inserted });
                }
              }
              return [{ insertId: 1 }];
            },
          };
        },
      }),
      update: (table: unknown) => ({
        set: (value: Record<string, unknown>) => ({
          where: async () => {
            if (table === state.noteTable) {
              state.noteUpdates.push(value);
              state.noteRows = state.noteRows.map(row => ({
                ...row,
                ...value,
              }));
            } else {
              state.updated = value;
              if (table === state.highlightTable) {
                state.rows = state.rows.map(row => ({ ...row, ...value }));
              }
            }
          },
        }),
      }),
      delete: (table: unknown) => {
        const builder = {
          where: () => {
            if (table === state.highlightTable)
              state.rows = state.rows.slice(1);
            if (table === state.noteTable) {
              state.noteRows = state.noteRows.slice(1);
              state.rows = state.rows.map(row => ({
                ...row,
                noteExtId: null,
              }));
            }
            return builder;
          },
          limit: async () => undefined,
          then: (
            resolve: (value: undefined) => unknown,
            reject: (reason: unknown) => unknown
          ) => Promise.resolve(undefined).then(resolve, reject),
        };
        return builder;
      },
    };
    return {
      ...operations,
      transaction: async <T>(
        work: (tx: typeof operations) => Promise<T>
      ): Promise<T> => work(operations),
    };
  },
}));

vi.mock("./lib/openapi-auth", () => ({
  requireApiKey: async (
    _context: unknown,
    next: () => Promise<void>
  ): Promise<void> => next(),
}));

vi.mock("./lib/webhooks", () => ({
  EVENT_TYPES: [
    "highlight.created",
    "highlight.updated",
    "highlight.deleted",
    "note.created",
    "note.updated",
    "note.deleted",
  ],
  fanout: (event: Record<string, unknown>) => state.events.push(event),
}));

vi.mock("./lib/codex", () => ({
  askCodex: vi.fn(),
  codexAuthController: {
    status: vi.fn(),
    startLogin: vi.fn(),
    logout: vi.fn(),
  },
}));

import {
  mirrorBooks,
  mirrorEventReceipts,
  mirrorHighlights,
  mirrorNoteTombstones,
  mirrorNotes,
} from "@db/mirror-schema";
import { citationBlock } from "../src/lib/citations";
import { rewriteBookCitationNotes } from "./lib/book-citation-note-sync";
import { getDb } from "./queries/connection";
import { v1 } from "./v1";

const storedContentCitation = {
  id: 1,
  extId: "highlight-1",
  bookExtId: "book-1",
  bookTitle: "Example",
  citationLevel: "content",
  chapterId: "chapter-1",
  chapterTitle: "Chapter 1",
  text: "selected text",
  paraIndex: 3,
  start: 4,
  end: 17,
  pdfAnchor: JSON.stringify({
    page: 8,
    rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.04 }],
  }),
  styleKind: "none",
  styleColor: "orange",
  note: null,
  noteExtId: "note-1",
  aiQa: null,
  tags: null,
  cloze: null,
  review: null,
  createdAt: new Date("2026-09-04T00:00:00Z"),
};

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("v1 citation hierarchy persistence", () => {
  beforeEach(() => {
    state.rows = [];
    state.bookRows = [{ extId: "book-1", title: "Example" }];
    state.noteRows = [];
    state.noteTombstoneRows = [];
    state.inserted = null;
    state.upserted = null;
    state.updated = null;
    state.noteUpdates = [];
    state.events = [];
    state.receiptTable = mirrorEventReceipts;
    state.bookTable = mirrorBooks;
    state.highlightTable = mirrorHighlights;
    state.noteTable = mirrorNotes;
    state.noteTombstoneTable = mirrorNoteTombstones;
  });

  it("persists and emits every POST content anchor", async () => {
    const pdfAnchor = {
      page: 8,
      rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.04 }],
    };
    state.noteRows = [
      { extId: "note-1", title: "Citation note", content: "Manual" },
    ];
    const response = await v1.request(
      "/highlights",
      jsonRequest("POST", {
        extId: "highlight-1",
        bookExtId: "book-1",
        bookTitle: "Example",
        citationLevel: "content",
        chapterId: "chapter-1",
        chapterTitle: "Chapter 1",
        text: "selected text",
        paraIndex: 3,
        start: 4,
        end: 17,
        pdfAnchor,
        styleKind: "none",
        noteExtId: "note-1",
      })
    );

    expect(response.status).toBe(201);
    expect(state.inserted).toMatchObject({
      citationLevel: "content",
      chapterId: "chapter-1",
      paraIndex: 3,
      start: 4,
      end: 17,
      pdfAnchor: JSON.stringify(pdfAnchor),
      noteExtId: "note-1",
    });
    expect(state.noteUpdates[0].content).toContain(
      "<!-- shufang-citation-id:highlight%2D1 -->"
    );
    expect(state.events[0]).toMatchObject({
      type: "note.updated",
      data: { extId: "note-1", updatedAt: expect.any(Number) },
    });
    expect(state.events[1]).toMatchObject({
      type: "highlight.created",
      data: {
        citationLevel: "content",
        chapterId: "chapter-1",
        pdfAnchor,
        noteExtId: "note-1",
      },
    });
  });

  it("ignores a stale REST bookTitle and uses the locked catalogue title", async () => {
    state.bookRows = [{ extId: "book-1", title: "Canonical title" }];

    const response = await v1.request(
      "/highlights",
      jsonRequest("POST", {
        extId: "highlight-stale-title",
        bookExtId: "book-1",
        bookTitle: "Stale client title",
        text: "selected text",
        name: "REST card",
      })
    );

    expect(response.status).toBe(201);
    expect(state.inserted).toMatchObject({
      bookExtId: "book-1",
      bookTitle: "Canonical title",
      name: "REST card",
    });
    expect(state.events.at(-1)).toMatchObject({
      type: "highlight.created",
      data: { bookTitle: "Canonical title", name: "REST card" },
    });
  });

  it("returns structured anchors from GET", async () => {
    state.rows = [{ ...storedContentCitation, name: "Named card" }];

    const response = await v1.request("/highlights");
    const body = (await response.json()) as {
      highlights: Record<string, unknown>[];
    };

    expect(response.status).toBe(200);
    expect(body.highlights[0]).toMatchObject({
      citationLevel: "content",
      chapterId: "chapter-1",
      paraIndex: 3,
      start: 4,
      end: 17,
      noteExtId: "note-1",
      name: "Named card",
      pdfAnchor: { page: 8 },
    });
  });

  it("PATCH changes level and clears inapplicable anchors", async () => {
    state.rows = [storedContentCitation];

    const response = await v1.request(
      "/highlights/highlight-1",
      jsonRequest("PATCH", { citationLevel: "book", noteExtId: null })
    );

    expect(response.status).toBe(200);
    expect(state.updated).toMatchObject({
      citationLevel: "book",
      chapterId: "",
      paraIndex: null,
      start: null,
      end: null,
      pdfAnchor: null,
      noteExtId: null,
    });
  });

  it("PATCH rewrites with the locked catalogue title before fanout", async () => {
    const previousDescriptor = {
      level: "content" as const,
      bookTitle: "Example",
      chapterTitle: "Chapter 1",
      text: "selected text",
    };
    state.rows = [storedContentCitation];
    state.noteRows = [
      {
        extId: "note-1",
        title: "Citation note",
        content: `Manual introduction\n\n${citationBlock(previousDescriptor)}\n`,
      },
    ];

    const response = await v1.request(
      "/highlights/highlight-1",
      jsonRequest("PATCH", {
        citationLevel: "chapter",
        chapterId: "chapter-2",
        chapterTitle: "Chapter 2",
        bookTitle: "Example revised",
        text: "replacement text",
        name: "Renamed card",
      })
    );

    expect(response.status).toBe(200);
    expect(state.noteUpdates).toHaveLength(1);
    expect(state.noteUpdates[0].content).toContain("Manual introduction");
    expect(state.noteUpdates[0].content).not.toContain("selected text");
    expect(state.noteUpdates[0].content).toContain(
      "> 章节引用：[[Example]] → Chapter 2"
    );
    expect(state.noteUpdates[0].content).not.toContain("[[Example revised]]");
    expect(state.updated).toMatchObject({
      bookTitle: "Example",
      name: "Renamed card",
    });
    expect(state.events.map(event => event.type)).toEqual([
      "note.updated",
      "highlight.updated",
    ]);
    expect(state.events.at(-1)).toMatchObject({
      data: {
        bookExtId: "book-1",
        bookTitle: "Example",
        name: "Renamed card",
      },
    });
  });

  it("mirrors a full browser event and rejects malformed hierarchy", async () => {
    state.noteRows = [
      { extId: "note-2", title: "Browser citation", content: "Manual" },
    ];
    const response = await v1.request(
      "/events",
      jsonRequest("POST", {
        type: "highlight.created",
        data: {
          extId: "highlight-2",
          bookExtId: "book-1",
          bookTitle: "Example",
          citationLevel: "chapter",
          chapterId: "chapter-2",
          chapterTitle: "Chapter 2",
          text: "Chapter 2",
          noteExtId: "note-2",
          styleKind: "none",
          name: "Browser card",
        },
      })
    );

    expect(response.status).toBe(200);
    expect(state.inserted).toMatchObject({
      citationLevel: "chapter",
      chapterId: "chapter-2",
      paraIndex: null,
      pdfAnchor: null,
      noteExtId: "note-2",
      name: "Browser card",
    });
    expect(state.noteUpdates[0].content).toContain(
      "<!-- shufang-citation-id:highlight%2D2 -->"
    );

    state.events = [];
    const invalid = await v1.request(
      "/events",
      jsonRequest("POST", {
        type: "highlight.created",
        data: {
          extId: "invalid",
          text: "Chapter",
          citationLevel: "chapter",
        },
      })
    );
    expect(invalid.status).toBe(400);
    expect(state.events).toEqual([]);
  });

  it("merges browser update anchors and clears legacy noteId links", async () => {
    state.rows = [storedContentCitation];

    const response = await v1.request(
      "/events",
      jsonRequest("POST", {
        type: "highlight.updated",
        data: {
          extId: "highlight-1",
          citationLevel: "chapter",
          chapterId: "chapter-2",
          chapterTitle: "Chapter 2",
          noteId: null,
          name: "Updated browser card",
        },
      })
    );

    expect(response.status).toBe(200);
    expect(state.updated).toMatchObject({
      citationLevel: "chapter",
      chapterId: "chapter-2",
      chapterTitle: "Chapter 2",
      paraIndex: null,
      start: null,
      end: null,
      pdfAnchor: null,
      noteExtId: null,
      name: "Updated browser card",
    });
    expect(state.events[0]).toMatchObject({
      type: "highlight.updated",
      data: { noteExtId: null },
    });
  });

  it("moves a browser citation between notes and fans out both snapshots", async () => {
    const generated = citationBlock({
      level: "content",
      bookTitle: "Example",
      chapterTitle: "Chapter 1",
      text: "selected text",
    });
    state.rows = [storedContentCitation];
    state.noteRows = [
      {
        extId: "note-1",
        title: "Old note",
        content: `Keep old\n\n${generated}\n`,
      },
      {
        extId: "note-2",
        title: "New note",
        content: "Keep new",
      },
    ];

    const response = await v1.request(
      "/events",
      jsonRequest("POST", {
        type: "highlight.updated",
        data: { extId: "highlight-1", noteId: "note-2" },
      })
    );

    expect(response.status).toBe(200);
    const noteEvents = state.events.filter(
      event => event.type === "note.updated"
    );
    expect(noteEvents).toHaveLength(2);
    expect(noteEvents[0]).toMatchObject({
      data: { extId: "note-1", content: "Keep old" },
    });
    expect(noteEvents[1]).toMatchObject({
      data: { extId: "note-2" },
    });
    expect((noteEvents[1].data as { content: string }).content).toContain(
      generated
    );
    expect(state.events.at(-1)).toMatchObject({ type: "highlight.updated" });
  });

  it("REST DELETE removes only the selected marker from an identical pair", async () => {
    const descriptor = {
      level: "content" as const,
      bookTitle: "Example",
      chapterTitle: "Chapter 1",
      text: "selected text",
    };
    const first = {
      ...storedContentCitation,
      extId: "highlight-1",
      noteExtId: "note-1",
    };
    const second = {
      ...storedContentCitation,
      id: 2,
      extId: "highlight-2",
      noteExtId: "note-1",
    };
    state.rows = [first, second];
    state.noteRows = [
      {
        extId: "note-1",
        title: "Shared note",
        content: [
          citationBlock({ ...descriptor, highlightId: "highlight-1" }),
          citationBlock({ ...descriptor, highlightId: "highlight-2" }),
        ].join("\n\n"),
      },
    ];

    const response = await v1.request(
      "/highlights/highlight-1",
      jsonRequest("DELETE", undefined)
    );

    expect(response.status).toBe(200);
    expect(state.noteUpdates[0].content).not.toContain(
      "shufang-citation-id:highlight%2D1"
    );
    expect(state.noteUpdates[0].content).toContain(
      "shufang-citation-id:highlight%2D2"
    );
    expect(state.events.map(event => event.type)).toEqual([
      "note.updated",
      "highlight.deleted",
    ]);
  });

  it("reader highlight.deleted cleans its generated note block", async () => {
    const descriptor = {
      level: "content" as const,
      highlightId: "highlight-1",
      bookTitle: "Example",
      chapterTitle: "Chapter 1",
      text: "selected text",
    };
    state.rows = [storedContentCitation];
    state.noteRows = [
      {
        extId: "note-1",
        title: "Citation note",
        content: `Manual\n\n${citationBlock(descriptor)}`,
      },
    ];

    const response = await v1.request(
      "/events",
      jsonRequest("POST", {
        type: "highlight.deleted",
        data: { extId: "highlight-1" },
      })
    );

    expect(response.status).toBe(200);
    expect(state.noteUpdates[0]).toMatchObject({
      content: "Manual",
      clientUpdatedAt: expect.any(Number),
    });
    expect(state.events.map(event => event.type)).toEqual([
      "note.updated",
      "highlight.deleted",
    ]);
  });

  it("book cleanup trusts each stored highlight title after an independent edit", async () => {
    const futureVersion = Date.now() + 60_000;
    const descriptor = {
      level: "content" as const,
      highlightId: "highlight-1",
      bookTitle: "Independent title",
      chapterTitle: "Chapter 1",
      text: "selected text",
    };
    state.rows = [
      {
        ...storedContentCitation,
        bookTitle: "Independent title",
      },
    ];
    state.noteRows = [
      {
        extId: "note-1",
        title: "Citation note",
        content: citationBlock(descriptor),
        clientUpdatedAt: futureVersion,
      },
    ];

    const changed = await rewriteBookCitationNotes(
      getDb(),
      "book-1",
      "Canonical catalogue title"
    );

    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      content: "",
      updatedAt: futureVersion + 1,
    });
  });

  it("repairs a missing create from a complete non-tombstoned update", async () => {
    const response = await v1.request(
      "/events",
      jsonRequest("POST", {
        type: "note.updated",
        data: {
          extId: "note-1",
          title: "Citation note",
          content: "A structured citation block",
          updatedAt: 1_788_480_000_000,
        },
      })
    );

    expect(response.status).toBe(200);
    expect(state.noteRows).toEqual([
      {
        extId: "note-1",
        title: "Citation note",
        content: "A structured citation block",
        clientUpdatedAt: 1_788_480_000_000,
      },
    ]);
    expect(state.events).toHaveLength(1);
  });

  it("keeps a deleted note tombstoned against delayed full snapshots", async () => {
    state.noteRows = [
      {
        extId: "note-1",
        title: "Citation note",
        content: "Current",
        clientUpdatedAt: 100,
      },
    ];
    const deleted = await v1.request(
      "/events",
      jsonRequest("POST", {
        type: "note.deleted",
        data: { extId: "note-1" },
      })
    );
    expect(deleted.status).toBe(200);
    expect(state.noteRows).toEqual([]);
    expect(state.noteTombstoneRows).toMatchObject([{ extId: "note-1" }]);

    state.events = [];
    const stale = await v1.request(
      "/events",
      jsonRequest("POST", {
        type: "note.updated",
        data: {
          extId: "note-1",
          title: "Citation note",
          content: "Stale",
          updatedAt: 200,
        },
      })
    );
    expect(stale.status).toBe(200);
    expect(state.noteRows).toEqual([]);
    expect(state.events).toEqual([]);
  });

  it("fans out server-discovered citation deletions before note deletion", async () => {
    state.rows = [
      storedContentCitation,
      {
        ...storedContentCitation,
        id: 2,
        extId: "highlight-enriched",
        note: "Personal annotation",
      },
      {
        ...storedContentCitation,
        id: 3,
        extId: "highlight-name-only",
        name: "Named card",
      },
    ];
    state.noteRows = [
      {
        extId: "note-1",
        title: "Citation note",
        content: "Current",
        clientUpdatedAt: 100,
      },
    ];

    const response = await v1.request(
      "/events",
      jsonRequest("POST", {
        type: "note.deleted",
        data: { extId: "note-1" },
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      deletedHighlightIds: ["highlight-1"],
    });
    expect(state.rows).toMatchObject([
      {
        extId: "highlight-enriched",
        note: "Personal annotation",
        noteExtId: null,
      },
      {
        extId: "highlight-name-only",
        name: "Named card",
        noteExtId: null,
      },
    ]);
    expect(state.events.map(event => event.type)).toEqual([
      "highlight.deleted",
      "note.deleted",
    ]);
    expect(state.events[0]).toMatchObject({
      data: { extId: "highlight-1", bookTitle: "Example" },
    });
  });
});
