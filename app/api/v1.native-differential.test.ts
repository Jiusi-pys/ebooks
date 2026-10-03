import { describe, expect, it } from "vitest";
import { v1 } from "./v1";
import { associationPairKey, type PassageAnchor } from "./lib/association";

const enabled = process.env.RUN_NATIVE_DIFFERENTIAL === "1";
const prefix = `diff-${Date.now()}`;
async function pair(path: string, method = "GET", body?: unknown) {
  const old = await v1.request(path, {
    method,
    headers: {
      "X-API-Key": process.env.OPEN_API_KEY!,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const native = await fetch(
    process.env.NATIVE_TEST_ORIGIN + "/api/v1" + path,
    {
      method,
      headers: {
        "X-API-Key": process.env.NATIVE_TEST_TOKEN!,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }
  );
  return {
    old: { status: old.status, body: await old.json() },
    native: { status: native.status, body: await native.json() },
  };
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !["createdAt", "updatedAt", "revision", "now"].includes(key)
        )
        .map(([key, value]) => [key, stable(value)])
    );
  return value;
}
describe.skipIf(!enabled)("old Hono/MySQL vs native HTTP REST", () => {
  const book = `${prefix}-book`;
  it("creates the shared book fixture", async () => {
    const result = await pair("/books", "POST", {
      extId: book,
      title: "Book",
      author: "Author",
      chapters: [{ id: "c", title: "Chapter", paragraphs: ["abcdef"] }],
    });
    expect(result.native).toEqual(result.old);
  });
  const fixtures: [string, string, Record<string, unknown>, boolean][] = [
    ["note defaults", "/notes", { title: "Note" }, true],
    [
      "large note",
      "/notes",
      { title: "Long", content: "a".repeat(20001) },
      true,
    ],
    [
      "note too large",
      "/notes",
      { title: "Long", content: "a".repeat(200001) },
      false,
    ],
    [
      "note strict",
      "/notes",
      { title: "Note", content: "", unknown: true },
      false,
    ],
    ["folder", "/folders", { name: "Folder" }, true],
    [
      "custom format",
      "/books",
      { title: "Custom", format: "custom", chapters: [] },
      true,
    ],
    [
      "invalid date",
      "/books",
      {
        title: "Book",
        chapters: [],
        metadata: { version: 1, publishedDate: "2025-02-30" },
      },
      false,
    ],
    [
      "invalid rating",
      "/books",
      { title: "Book", chapters: [], metadata: { version: 1, rating: 6 } },
      false,
    ],
    [
      "invalid language",
      "/books",
      {
        title: "Book",
        chapters: [],
        metadata: { version: 1, languages: ["bad_underscore"] },
      },
      false,
    ],
    [
      "metadata strict",
      "/books",
      { title: "Book", chapters: [], metadata: { version: 1, secret: "x" } },
      false,
    ],
    [
      "book unknown fields stripped",
      "/books",
      { title: "Book", chapters: [], unknown: "stripped" },
      true,
    ],
    [
      "metadata normalization",
      "/books",
      {
        title: "Book",
        chapters: [],
        metadata: {
          version: 1,
          contributors: [{ name: " Author ", role: "author" }],
          identifiers: [{ scheme: " ISBN ", value: " 123 " }],
          publishedDate: "2024-02-29",
          languages: ["zh-CN", "x-private"],
          rating: 4.5,
        },
      },
      true,
    ],
    [
      "translation defaults",
      "/translations",
      { bookExtId: book, targetLang: "中文", text: "Translation" },
      true,
    ],
    [
      "translation named book",
      "/translations",
      {
        bookExtId: book,
        bookTitle: "Supplied",
        targetLang: "中文",
        text: "Translation",
        scope: "chapter",
      },
      true,
    ],
    [
      "translation invalid scope",
      "/translations",
      {
        bookExtId: book,
        targetLang: "中文",
        text: "Translation",
        scope: "other",
      },
      false,
    ],
    [
      "highlight defaults",
      "/highlights",
      { bookExtId: book, text: "abc" },
      true,
    ],
    [
      "highlight tags",
      "/highlights",
      { bookExtId: book, text: "abc", tags: [""] },
      false,
    ],
    [
      "highlight cloze",
      "/highlights",
      { bookExtId: book, text: "abc", cloze: [""] },
      false,
    ],
    [
      "highlight style color",
      "/highlights",
      { bookExtId: book, text: "abc", styleColor: "x".repeat(33) },
      false,
    ],
    [
      "highlight bad review",
      "/highlights",
      {
        bookExtId: book,
        text: "abc",
        review: { due: 1, reps: -1, lapses: 0, interval: 0, addedAt: 1 },
      },
      false,
    ],
    [
      "highlight qa strict",
      "/highlights",
      {
        bookExtId: book,
        text: "abc",
        aiQa: [{ q: "q", a: "a", ts: 1, extra: true }],
      },
      false,
    ],
    [
      "mindmap children default",
      "/mindmaps",
      { bookExtId: book, title: "Map", root: { id: "r", text: "Root" } },
      true,
    ],
    [
      "mindmap invalid collapsed",
      "/mindmaps",
      {
        bookExtId: book,
        title: "Map",
        root: { id: "r", text: "Root", collapsed: "true" },
      },
      false,
    ],
  ];
  for (const [index, [name, path, body, valid]] of fixtures.entries()) {
    it(name, async () => {
      const id = `${prefix}-${index}`;
      const result = await pair(path, "POST", { extId: id, ...body });
      expect(result.native.status, JSON.stringify(result)).toBe(
        result.old.status
      );
      if (!valid) {
        expect(result.old.status).toBe(400);
        return;
      }
      expect(result.old.status).toBe(201);
      expect(stable(result.native.body)).toEqual(stable(result.old.body));
      if (path === "/notes" || path === "/books" || path === "/mindmaps") {
        const detail = await pair(`${path}/${id}`);
        expect(stable(detail.native)).toEqual(stable(detail.old));
      } else {
        const list = await pair(path);
        const key = path.slice(1);
        const a = resultRow(list.old.body, key, id),
          b = resultRow(list.native.body, key, id);
        expect(stable(b)).toEqual(stable(a));
      }
    });
  }
  it("note empty PATCH validation", async () => {
    const id = `${prefix}-patch`;
    await pair("/notes", "POST", { extId: id, title: "Patch", content: "" });
    const result = await pair(`/notes/${id}`, "PATCH", {});
    expect(result.native.status).toBe(result.old.status);
    expect(result.old.status).toBe(200);
  });
  it("chapter list, exact chapter, state and missing chapter", async () => {
    for (const path of [
      `/books/${book}/chapters`,
      `/books/${book}/chapters/0`,
      `/books/${book}/state`,
      `/books/${book}/chapters/3`,
    ]) {
      const result = await pair(path);
      expect(stable(result.native)).toEqual(stable(result.old));
    }
  });
  it("null clearing, PATCH, filters, deletion and tombstone", async () => {
    const id = `${prefix}-edited`,
      note = `${prefix}-linked`;
    await pair("/notes", "POST", { extId: note, title: "Linked", content: "" });
    await pair("/highlights", "POST", {
      extId: id,
      bookExtId: book,
      text: "abc",
      note: "annotation",
      name: "Name",
    });
    const patch = await pair(`/highlights/${id}`, "PATCH", {
      note: null,
      name: null,
      tags: ["tag"],
      cloze: ["abc"],
    });
    expect(stable(patch.native)).toEqual(stable(patch.old));
    const list = await pair(`/highlights?book=${book}`);
    expect(stable(resultRow(list.native.body, "highlights", id))).toEqual(
      stable(resultRow(list.old.body, "highlights", id))
    );
    const removed = await pair(`/notes/${note}`, "DELETE");
    expect(removed.native.status).toBe(removed.old.status);
    const recreated = await pair("/notes", "POST", {
      extId: note,
      title: "Again",
      content: "",
    });
    expect(recreated.native.status).toBe(recreated.old.status);
    expect(recreated.old.status).toBe(409);
  });
  it("event receipts reject different replays and acknowledge exact duplicates", async () => {
    const event = {
      deliveryId: `${prefix}-receipt`,
      type: "note.created",
      data: { extId: `${prefix}-event`, title: "Event", content: "Text" },
    };
    for (const body of [
      event,
      event,
      { ...event, data: { ...event.data, title: "Conflict" } },
    ]) {
      const result = await pair("/events", "POST", body);
      expect(result.native.status).toBe(result.old.status);
    }
  });
  it("digest miss and due queue", async () => {
    for (const path of ["/digest/missing", "/review/due"]) {
      const result = await pair(path);
      expect(stable(result.native)).toEqual(stable(result.old));
    }
  });
  it("association identity, idempotence, update and conflict", async () => {
    const source: PassageAnchor = {
      kind: "text",
      bookId: book,
      chapterId: "c",
      chapterTitle: "Chapter",
      paraIndex: 0,
      start: 0,
      end: 1,
      text: "a",
    };
    const target: PassageAnchor = { ...source, start: 1, end: 2, text: "b" };
    const id = `${prefix}-association`;
    const body = {
      extId: id,
      source,
      target,
      direction: "bidirectional",
      pairKey: associationPairKey(source, target, "bidirectional"),
      createdAt: Date.now() - 86400000,
      updatedAt: Date.now() - 86400000,
    };
    for (const input of [
      body,
      body,
      { ...body, extId: `${prefix}-duplicate` },
    ]) {
      const result = await pair("/associations", "POST", input);
      expect(result.native.status).toBe(result.old.status);
      if (result.old.status < 400)
        expect(stable(result.native.body)).toEqual(stable(result.old.body));
    }
    const update = await pair(`/associations/${id}`, "PATCH", {
      label: "Link",
    });
    expect(stable(update.native)).toEqual(stable(update.old));
    const detail = await pair(`/associations/${id}`);
    expect(stable(detail.native)).toEqual(stable(detail.old));
    for (const extra of [
      { source: { ...source, unknown: true } },
      { createdAt: Date.now(), updatedAt: 1 },
    ]) {
      const invalid = await pair("/associations", "POST", {
        ...body,
        ...extra,
        extId: `${prefix}-invalid-association`,
      });
      expect(invalid.native.status).toBe(invalid.old.status);
      expect(invalid.old.status).toBe(400);
    }
  });
});
function resultRow(body: unknown, key: string, id: string) {
  return (
    (body as Record<string, unknown>)[key] as Record<string, unknown>[]
  ).find(row => row.extId === id);
}
