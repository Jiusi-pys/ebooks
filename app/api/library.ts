import { Hono } from "hono";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  mirrorBooks,
  mirrorBookTombstones,
  librarySourceChunks,
  mirrorFolders,
} from "@db/mirror-schema";
import { getDb } from "./queries/connection";
import { requireBrowserSession, requireBrowserMutation } from "./auth";
import {
  readerStateSchema,
  restoreBook,
  sourceSchema,
  validateSourceChunks,
} from "./lib/library-state";

export const library = new Hono();
library.use("*", (c, next) => {
  c.header("Cache-Control", "no-store");
  return c.req.method === "GET"
    ? requireBrowserSession(c, next)
    : requireBrowserMutation(c, next);
});
library.onError((error, c) => {
  console.error("[library]", error.message);
  return c.json(
    {
      error: "library_unavailable",
      message: "服务端书库不可用，请检查数据库及迁移状态",
    },
    503
  );
});
library.get("/books", async c => {
  const db = getDb();
  const books = await db
    .select({
      id: mirrorBooks.extId,
      hasReaderData: sql<number>`${mirrorBooks.readerData} IS NOT NULL`,
      source: mirrorBooks.sourceManifest,
    })
    .from(mirrorBooks);
  const deleted = await db
    .select({ id: mirrorBookTombstones.extId })
    .from(mirrorBookTombstones);
  const folders = await db.select().from(mirrorFolders);
  return c.json({
    books: books.map(b => ({
      id: b.id,
      hasReaderData: Boolean(b.hasReaderData),
      source: b.source ? JSON.parse(b.source) : null,
    })),
    deletedBookIds: deleted.map(b => b.id),
    folders: folders.map(f => ({
      id: f.extId,
      name: f.name,
      createdAt: f.createdAt.getTime(),
    })),
  });
});
library.get("/books/:id", async c => {
  const [row] = await getDb()
    .select()
    .from(mirrorBooks)
    .where(eq(mirrorBooks.extId, c.req.param("id")))
    .limit(1);
  return row
    ? c.json({
        book: restoreBook(row),
        source: row.sourceManifest ? JSON.parse(row.sourceManifest) : null,
      })
    : c.json({ error: "book_not_found" }, 404);
});
library.patch(
  "/books/:id/state",
  zValidator("json", readerStateSchema),
  async c => {
    const patch = c.req.valid("json");
    const found = await getDb().transaction(async tx => {
      const [row] = await tx
        .select({ state: mirrorBooks.readerData })
        .from(mirrorBooks)
        .where(eq(mirrorBooks.extId, c.req.param("id")))
        .for("update");
      if (!row) return false;
      const state = {
        ...readerStateSchema.parse(JSON.parse(row.state ?? "{}")),
        ...patch,
      };
      await tx
        .update(mirrorBooks)
        .set({ readerData: JSON.stringify(state) })
        .where(eq(mirrorBooks.extId, c.req.param("id")));
      return true;
    });
    return found
      ? c.json({ ok: true })
      : c.json({ error: "book_not_found" }, 404);
  }
);
const chunkSchema = z
  .object({
    uploadId: z.string().regex(/^[a-f0-9]{64}$/),
    index: z.number().int().min(0).max(1023),
    payload: z
      .string()
      .min(1)
      .max(350_000)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  })
  .strict();
library.put(
  "/books/:id/source/chunks",
  zValidator("json", chunkSchema),
  async c => {
    const chunk = c.req.valid("json");
    const result = await getDb().transaction(async tx => {
      const [book] = await tx
        .select({ id: mirrorBooks.extId, manifest: mirrorBooks.sourceManifest })
        .from(mirrorBooks)
        .where(eq(mirrorBooks.extId, c.req.param("id")))
        .for("update");
      if (!book) return "book_not_found";
      if (
        book.manifest &&
        sourceSchema.parse(JSON.parse(book.manifest)).uploadId ===
          chunk.uploadId
      ) {
        const [existing] = await tx
          .select()
          .from(librarySourceChunks)
          .where(
            and(
              eq(librarySourceChunks.bookExtId, book.id),
              eq(librarySourceChunks.uploadId, chunk.uploadId),
              eq(librarySourceChunks.chunkIndex, chunk.index)
            )
          );
        return existing?.payload === chunk.payload
          ? null
          : "source_already_committed";
      }
      await tx
        .insert(librarySourceChunks)
        .values({
          bookExtId: book.id,
          uploadId: chunk.uploadId,
          chunkIndex: chunk.index,
          payload: chunk.payload,
        })
        .onDuplicateKeyUpdate({ set: { payload: chunk.payload } });
      return null;
    });
    return result
      ? c.json({ error: result }, result === "book_not_found" ? 404 : 409)
      : c.json({ ok: true });
  }
);
library.post(
  "/books/:id/source/complete",
  zValidator("json", sourceSchema),
  async c => {
    const source = c.req.valid("json");
    const id = c.req.param("id");
    const result = await getDb().transaction(async tx => {
      const [book] = await tx
        .select({ id: mirrorBooks.extId })
        .from(mirrorBooks)
        .where(eq(mirrorBooks.extId, id))
        .for("update");
      if (!book) return "book_not_found";
      const chunks = await tx
        .select()
        .from(librarySourceChunks)
        .where(
          and(
            eq(librarySourceChunks.bookExtId, id),
            eq(librarySourceChunks.uploadId, source.uploadId)
          )
        )
        .orderBy(asc(librarySourceChunks.chunkIndex));
      try {
        validateSourceChunks(source, chunks);
      } catch {
        return "source_integrity_failed";
      }
      await tx
        .update(mirrorBooks)
        .set({ sourceManifest: JSON.stringify(source) })
        .where(eq(mirrorBooks.extId, id));
      await tx
        .delete(librarySourceChunks)
        .where(
          and(
            eq(librarySourceChunks.bookExtId, id),
            ne(librarySourceChunks.uploadId, source.uploadId)
          )
        );
      return null;
    });
    return result
      ? c.json({ error: result }, result === "book_not_found" ? 404 : 400)
      : c.json({ ok: true });
  }
);
library.get("/books/:id/source", async c => {
  const id = c.req.param("id");
  const [row] = await getDb()
    .select({ manifest: mirrorBooks.sourceManifest })
    .from(mirrorBooks)
    .where(eq(mirrorBooks.extId, id))
    .limit(1);
  if (!row?.manifest) return c.json({ error: "source_not_found" }, 404);
  const source = sourceSchema.parse(JSON.parse(row.manifest));
  const chunks = await getDb()
    .select()
    .from(librarySourceChunks)
    .where(
      and(
        eq(librarySourceChunks.bookExtId, id),
        eq(librarySourceChunks.uploadId, source.uploadId)
      )
    )
    .orderBy(asc(librarySourceChunks.chunkIndex));
  const bytes = validateSourceChunks(source, chunks);
  c.header("Content-Type", "application/octet-stream");
  c.header("X-Content-Type-Options", "nosniff");
  c.header(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(source.name)}`
  );
  return c.body(new Uint8Array(bytes));
});
