import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  tableRows: new Map<unknown, Record<string, unknown>[]>(),
  selectResults: [] as Record<string, unknown>[][],
  inserted: [] as { table: unknown; value: Record<string, unknown> }[],
  updated: [] as { table: unknown; value: Record<string, unknown> }[],
  deletedTables: [] as unknown[],
  events: [] as Record<string, unknown>[],
}));

vi.mock("./queries/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: (table: unknown) => {
        const rows = () =>
          state.selectResults.shift() ?? state.tableRows.get(table) ?? [];
        const builder = {
          where: () => builder,
          limit: async (count: number) => rows().slice(0, count),
          then: (
            resolve: (value: Record<string, unknown>[]) => unknown,
            reject: (reason: unknown) => unknown
          ) => Promise.resolve(rows()).then(resolve, reject),
        };
        return builder;
      },
    }),
    insert: (table: unknown) => ({
      values: (value: Record<string, unknown>) => {
        state.inserted.push({ table, value });
        return {
          onDuplicateKeyUpdate: async () => [{ insertId: 1 }],
        };
      },
    }),
    update: (table: unknown) => ({
      set: (value: Record<string, unknown>) => ({
        where: async () => {
          state.updated.push({ table, value });
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async () => {
        state.deletedTables.push(table);
      },
    }),
  }),
}));

vi.mock("./lib/openapi-auth", () => ({
  requireApiKey: async (
    _context: unknown,
    next: () => Promise<void>
  ): Promise<void> => next(),
}));

vi.mock("./lib/webhooks", () => ({
  EVENT_TYPES: [
    "association.created",
    "association.updated",
    "association.deleted",
  ],
  fanout: (event: Record<string, unknown>) => state.events.push(event),
}));

vi.mock("./lib/codex", () => ({ askCodex: vi.fn() }));

import {
  associationDbValues,
  associationPairKey,
  type AssociationSnapshot,
  type PassageAnchor,
} from "./lib/association";
import { v1 } from "./v1";
import { mirrorAssociations, mirrorBooks } from "@db/mirror-schema";

const source: PassageAnchor = {
  kind: "text",
  bookId: "book-a",
  chapterId: "chapter-a",
  chapterTitle: "第一章",
  text: "学而不思则罔",
  paraIndex: 3,
  start: 2,
  end: 9,
};
const target: PassageAnchor = {
  kind: "pdf",
  bookId: "book-b",
  chapterId: "page-2",
  chapterTitle: "第 2 页",
  text: "思而不学则殆",
  pdfAnchor: {
    page: 2,
    rects: [{ x: 0.1, y: 0.2, width: 0.4, height: 0.04 }],
  },
};

function association(
  overrides: Partial<AssociationSnapshot> = {}
): AssociationSnapshot {
  const direction = overrides.direction ?? "bidirectional";
  const nextSource = overrides.source ?? source;
  const nextTarget = overrides.target ?? target;
  return {
    extId: "association-1",
    source: nextSource,
    target: nextTarget,
    direction,
    label: "相似观点",
    pairKey: associationPairKey(nextSource, nextTarget, direction),
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

function stored(value = association()) {
  return { id: 1, ...associationDbValues(value) };
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("v1 passage associations", () => {
  beforeEach(() => {
    state.tableRows.clear();
    state.selectResults = [];
    state.inserted = [];
    state.updated = [];
    state.deletedTables = [];
    state.events = [];
  });

  it("POST persists a flattened snapshot and emits association.created", async () => {
    const item = association();
    const response = await v1.request(
      "/associations",
      jsonRequest("POST", item)
    );

    expect(response.status).toBe(201);
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({
      table: mirrorAssociations,
      value: {
        extId: "association-1",
        sourceKind: "text",
        sourceBookExtId: "book-a",
        sourceParaIndex: 3,
        targetKind: "pdf",
        targetBookExtId: "book-b",
        targetPdfAnchor: JSON.stringify(target.pdfAnchor),
        pairKey: item.pairKey,
      },
    });
    expect(state.events).toContainEqual({
      type: "association.created",
      source: "api",
      data: item,
    });
  });

  it("rejects forged pair keys before persistence", async () => {
    const response = await v1.request(
      "/associations",
      jsonRequest("POST", { ...association(), pairKey: "citation-like-link" })
    );

    expect(response.status).toBe(400);
    expect(state.inserted).toEqual([]);
    expect(state.events).toEqual([]);
  });

  it("treats a retried POST with the same stable id and pair as idempotent", async () => {
    const item = association();
    state.tableRows.set(mirrorAssociations, [stored(item)]);

    const response = await v1.request(
      "/associations",
      jsonRequest("POST", item)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      created: false,
      extId: item.extId,
    });
    expect(state.inserted).toEqual([]);
    expect(state.updated).toEqual([]);
    expect(state.events).toEqual([]);
  });

  it("rejects the same pair under a different id without rewriting stable identity", async () => {
    const existing = association();
    state.tableRows.set(mirrorAssociations, [stored(existing)]);

    const response = await v1.request(
      "/associations",
      jsonRequest("POST", { ...existing, extId: "association-2" })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "association_conflict",
    });
    expect(state.inserted).toEqual([]);
    expect(state.updated).toEqual([]);
    expect(state.events).toEqual([]);
  });

  it("GET returns nested anchors sorted by updatedAt and filters by either book", async () => {
    const older = association();
    const newer = association({
      extId: "association-2",
      source: target,
      target: source,
      updatedAt: 3_000,
    });
    state.tableRows.set(mirrorAssociations, [stored(older), stored(newer)]);

    const response = await v1.request("/associations?book=book-b");
    const body = (await response.json()) as {
      associations: AssociationSnapshot[];
    };

    expect(response.status).toBe(200);
    expect(body.associations.map(item => item.extId)).toEqual([
      "association-2",
      "association-1",
    ]);
    expect(body.associations[0].source).toEqual(target);
    expect(body.associations[0].target).toEqual(source);
  });

  it("PATCH recomputes direction-sensitive pairKey and emits a full snapshot", async () => {
    state.tableRows.set(mirrorAssociations, [stored()]);
    // The route first loads by id, then checks whether the new pair is owned.
    // This lightweight DB mock does not interpret Drizzle's SQL predicates.
    state.selectResults = [[stored()], []];

    const response = await v1.request(
      "/associations/association-1",
      jsonRequest("PATCH", {
        direction: "source-to-target",
        label: null,
        updatedAt: 4_000,
      })
    );
    const body = (await response.json()) as {
      association: AssociationSnapshot;
    };

    expect(response.status).toBe(200);
    expect(body.association).toMatchObject({
      extId: "association-1",
      direction: "source-to-target",
      updatedAt: 4_000,
      pairKey: associationPairKey(source, target, "source-to-target"),
    });
    expect(body.association).not.toHaveProperty("label");
    expect(state.updated[0]).toMatchObject({
      table: mirrorAssociations,
      value: {
        direction: "source-to-target",
        label: null,
        pairKey: associationPairKey(source, target, "source-to-target"),
      },
    });
    expect(state.events[0]).toMatchObject({
      type: "association.updated",
      source: "api",
      data: body.association,
    });
  });

  it("DELETE removes only the requested association and emits its id", async () => {
    state.tableRows.set(mirrorAssociations, [stored()]);

    const response = await v1.request(
      "/associations/association-1",
      jsonRequest("DELETE", undefined)
    );

    expect(response.status).toBe(200);
    expect(state.deletedTables).toEqual([mirrorAssociations]);
    expect(state.events).toEqual([
      {
        type: "association.deleted",
        source: "api",
        data: { extId: "association-1" },
      },
    ]);
  });

  it("mirrors strict browser association events", async () => {
    const item = association();
    const response = await v1.request(
      "/events",
      jsonRequest("POST", { type: "association.updated", data: item })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, mirrored: true });
    expect(state.inserted[0]).toMatchObject({
      table: mirrorAssociations,
      value: { extId: item.extId, pairKey: item.pairKey },
    });
    expect(state.events[0]).toEqual({
      type: "association.updated",
      source: "reader",
      data: item,
    });
  });

  it("mirrors browser association deletion without treating it as a citation", async () => {
    const response = await v1.request(
      "/events",
      jsonRequest("POST", {
        type: "association.deleted",
        data: { extId: "association-1" },
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, mirrored: true });
    expect(state.deletedTables).toEqual([mirrorAssociations]);
    expect(state.events).toEqual([
      {
        type: "association.deleted",
        source: "reader",
        data: { extId: "association-1" },
      },
    ]);
  });

  it("deleting a book cascades its associations before the book", async () => {
    state.tableRows.set(mirrorBooks, [
      {
        id: 7,
        extId: "book-a",
        title: "A",
        author: "",
        format: "txt",
        folder: "",
        contentHash: "",
        chapters: "[]",
        createdAt: new Date(1_000),
        updatedAt: new Date(1_000),
      },
    ]);
    state.tableRows.set(mirrorAssociations, [stored()]);

    const response = await v1.request(
      "/books/book-a",
      jsonRequest("DELETE", undefined)
    );

    expect(response.status).toBe(200);
    expect(state.deletedTables).toEqual([mirrorAssociations, mirrorBooks]);
    expect(state.events.map(event => event.type)).toEqual([
      "association.deleted",
      "book.deleted",
    ]);
  });
});
