import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  inserted: null as Record<string, unknown> | null,
  upserted: null as Record<string, unknown> | null,
  updated: null as Record<string, unknown> | null,
  events: [] as Record<string, unknown>[],
}));

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    select: () => {
      const builder = {
        from: () => builder,
        where: () => builder,
        limit: async (count: number) => state.rows.slice(0, count),
        then: (
          resolve: (value: Record<string, unknown>[]) => unknown,
          reject: (reason: unknown) => unknown
        ) => Promise.resolve(state.rows).then(resolve, reject),
      };
      return builder;
    },
    insert: () => ({
      values: (value: Record<string, unknown>) => {
        state.inserted = value;
        return {
          onDuplicateKeyUpdate: async ({
            set,
          }: {
            set: Record<string, unknown>;
          }) => {
            state.upserted = set;
            return [{ insertId: 1 }];
          },
        };
      },
    }),
    update: () => ({
      set: (value: Record<string, unknown>) => ({
        where: async () => {
          state.updated = value;
        },
      }),
    }),
    delete: () => ({ where: async () => undefined }),
  }),
}));

vi.mock("./lib/openapi-auth", () => ({
  requireApiKey: async (
    _context: unknown,
    next: () => Promise<void>
  ): Promise<void> => next(),
}));

vi.mock("./lib/webhooks", () => ({
  EVENT_TYPES: [],
  fanout: (event: Record<string, unknown>) => state.events.push(event),
}));

vi.mock("./lib/codex", () => ({ askCodex: vi.fn() }));

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
    state.inserted = null;
    state.upserted = null;
    state.updated = null;
    state.events = [];
  });

  it("persists and emits every POST content anchor", async () => {
    const pdfAnchor = {
      page: 8,
      rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.04 }],
    };
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
    expect(state.events[0]).toMatchObject({
      type: "highlight.created",
      data: {
        citationLevel: "content",
        chapterId: "chapter-1",
        pdfAnchor,
        noteExtId: "note-1",
      },
    });
  });

  it("returns structured anchors from GET", async () => {
    state.rows = [storedContentCitation];

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
      noteExtId: "",
    });
  });

  it("mirrors a full browser event and rejects malformed hierarchy", async () => {
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
    });

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
      noteExtId: "",
    });
    expect(state.events[0]).toMatchObject({
      type: "highlight.updated",
      data: { noteExtId: null },
    });
  });

  it("upserts complete note snapshots from browser events", async () => {
    const response = await v1.request(
      "/events",
      jsonRequest("POST", {
        type: "note.updated",
        data: {
          extId: "note-1",
          title: "Citation note",
          content: "A structured citation block",
        },
      })
    );

    expect(response.status).toBe(200);
    expect(state.inserted).toEqual({
      extId: "note-1",
      title: "Citation note",
      content: "A structured citation block",
    });
    expect(state.upserted).toEqual({
      title: "Citation note",
      content: "A structured citation block",
    });
  });
});
