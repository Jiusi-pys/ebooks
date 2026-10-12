// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { createHash, webcrypto } from "node:crypto";
import { deleteDB, openDB } from "idb";
import { afterEach, expect, it, vi } from "vitest";
import type { Book } from "@/types";
import { applyOperation, makeOperation } from "@contracts/sync";
import { createEpubLayoutEntry, epubLayoutKey } from "./epubLayoutStore";
import { upgradeSyncDatabase } from "./syncDatabase";

const database = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("./db", () => ({ syncDatabase: async () => database.current }));
vi.mock("./syncPreferences", () => ({
  applyPreferences: async () => {},
  preferenceKeys: [],
}));
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.resetModules();
});

it.each(["projection", "hydration"] as const)(
  "clears layout during workspace %s without emitting an operation",
  async mode => {
    vi.stubGlobal("crypto", webcrypto);
    const name = crypto.randomUUID();
    const db = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore("books", { keyPath: "id" });
        db.createObjectStore("files", { keyPath: "id" });
        db.createObjectStore("metadata", { keyPath: "key" });
        upgradeSyncDatabase(db);
      },
    });
    database.current = db;
    const book: Book = {
      id: "book",
      title: "Book",
      author: "",
      format: "epub",
      coverTone: 0,
      chapters: [{ id: "chapter", title: "Chapter", paragraphs: ["before"] }],
      createdAt: 1,
      progress: { chapterId: "chapter", ratio: 0 },
    };
    const nextChapters = [
      { id: "chapter", title: "Chapter", paragraphs: ["after"] },
    ];
    const bytes = new TextEncoder().encode(JSON.stringify(nextChapters));
    const hash = createHash("sha256").update(bytes).digest("hex");
    const { id, ...fields } = book;
    const state = applyOperation(
      undefined,
      makeOperation(
        "workspace",
        "server",
        "books",
        id,
        {
          ...fields,
          chapters:
            mode === "projection"
              ? nextChapters
              : {
                  $blob: {
                    sha256: hash,
                    size: bytes.byteLength,
                    name: "field.json",
                    type: "application/json",
                  },
                },
        },
        10
      )
    );
    try {
      await db.put("books", book);
      await db.put("sources", {
        id: book.id,
        sha256: "a".repeat(64),
        size: 1,
        name: "book.epub",
        type: "application/epub+zip",
        format: "epub",
      });
      await db.put(
        "metadata",
        createEpubLayoutEntry(book, "a".repeat(64), {
          version: 1,
          assets: {},
          chapters: {
            chapter: { items: [{ kind: "paragraph", paraIndex: 0 }] },
          },
        })
      );
      await db.put("syncEntities", { id: "books:book", state });
      for (const id of [
        "seeded",
        "seeded-files",
        ...(mode === "hydration" ? ["projection-v1"] : []),
      ])
        await db.put("syncMeta", { id, complete: true });
      await db.put("syncMeta", {
        id: "identity",
        workspace: "workspace",
        replica: "local",
        clock: "1:0",
      });
      await db.put("syncMeta", {
        id: "cursor:server:epoch",
        cursor: "current",
        snapshotAt: Date.now(),
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (path: string) => {
          if (path.endsWith("/capabilities"))
            return Response.json({
              version: 2,
              workspaceId: "workspace",
              nodeId: "server",
              epoch: "epoch",
            });
          if (path.includes("/sync/changes"))
            return Response.json({
              operations: [],
              cursor: "next",
              hasMore: false,
            });
          if (path.endsWith(`/blobs/${hash}`)) return new Response(bytes);
          throw new Error(`Unexpected request ${path}`);
        })
      );
      const { trySyncWorkspace } = await import("./workspaceSync");
      await expect(trySyncWorkspace()).resolves.toBe(true);
      expect((await db.get("books", "book")).chapters).toEqual(nextChapters);
      expect(await db.get("metadata", epubLayoutKey("book"))).toBeUndefined();
      expect(await db.count("syncOutbox")).toBe(0);
      expect(await db.get("syncEntities", "books:book")).toEqual({
        id: "books:book",
        state,
      });
    } finally {
      db.close();
      await deleteDB(name);
    }
  }
);
