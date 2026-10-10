import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import {
  materialize,
  nextClock,
  isBlobReference,
  identifier,
  type Operation,
} from "../../contracts/sync";
import { requireBrowserMutation, requireBrowserSession } from "../auth";
import { requireApiKey, extractKey } from "../lib/openapi-auth";
import { requireReaderOrMachine } from "../lib/reader-auth";
import { restoreBook, sourceSchema } from "../lib/library-state";
import { associationFromRow } from "../lib/association";
import { normalizeReaderMirrorEvent } from "../lib/mirror-event";
import { BlobStore } from "./blobs";
import { SyncStore, SyncError, digest } from "./store";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { ZodError } from "zod";
import { localOperation } from "./local-operation";
import { camelLegacyRow } from "./legacy-row";
import { fanout } from "../lib/webhooks";
import {
  assembleBookMirrorUpload,
  bookImportStartedSchema,
  bookImportChunkSchema,
  bookImportCompletedSchema,
} from "../lib/book-mirror-upload";

export async function legacyBookImport(
  store: SyncStore,
  blobs: BlobStore,
  type: string,
  input: unknown
): Promise<unknown> {
  if (type === "book.import.started") {
    const data = bookImportStartedSchema.parse(input);
    const payload = JSON.stringify(data);
    const [existing] = await store.pool.query<RowDataPacket[]>(
      "SELECT payload FROM mirror_book_upload_chunks WHERE book_ext_id=? AND upload_id=? AND chunk_index=-1",
      [data.extId, data.uploadId]
    );
    if (existing.length) {
      if (existing[0].payload !== payload)
        throw new SyncError("upload_id_reused", 409);
      return;
    }
    await store.pool.query(
      "INSERT IGNORE INTO mirror_book_upload_chunks(book_ext_id,upload_id,chunk_index,chunk_count,encoded_bytes,title,author,format,folder,content_hash,chapter_count,payload) VALUES (?,?,-1,?,?,?,?,?,?,?,?,?)",
      [
        data.extId,
        data.uploadId,
        data.chunkCount,
        data.encodedBytes,
        data.title,
        data.author,
        data.format,
        data.folder,
        data.contentHash,
        data.chapterCount,
        payload,
      ]
    );
    // Re-read catches concurrent reuse of the same upload ID with different content.
    return legacyBookImport(store, blobs, type, input);
  }
  if (type === "book.import.chunk") {
    const data = bookImportChunkSchema.parse(input);
    const [manifest] = await store.pool.query<RowDataPacket[]>(
      "SELECT encoded_bytes,chunk_count FROM mirror_book_upload_chunks WHERE book_ext_id=? AND upload_id=? AND chunk_index=-1",
      [data.extId, data.uploadId]
    );
    if (!manifest.length || manifest[0].chunk_count !== data.chunkCount)
      throw new SyncError("upload_manifest_mismatch", 409);
    const [prior] = await store.pool.query<RowDataPacket[]>(
      "SELECT payload FROM mirror_book_upload_chunks WHERE book_ext_id=? AND upload_id=? AND chunk_index=?",
      [data.extId, data.uploadId, data.index]
    );
    if (prior.length) {
      if (prior[0].payload !== data.payload)
        throw new SyncError("chunk_id_reused", 409);
      return;
    }
    await store.pool.query(
      "INSERT IGNORE INTO mirror_book_upload_chunks(book_ext_id,upload_id,chunk_index,chunk_count,encoded_bytes,payload) VALUES (?,?,?,?,?,?)",
      [
        data.extId,
        data.uploadId,
        data.index,
        data.chunkCount,
        manifest[0].encoded_bytes,
        data.payload,
      ]
    );
    return legacyBookImport(store, blobs, type, input);
  }
  const data = bookImportCompletedSchema.parse(input);
  const operationId = `legacy-upload-${digest(data.extId + ":" + data.uploadId)}`;
  const prior = await store.operation(operationId);
  const [staged] = await store.pool.query<RowDataPacket[]>(
    "SELECT * FROM mirror_book_upload_chunks WHERE book_ext_id=? AND upload_id=? ORDER BY chunk_index",
    [data.extId, data.uploadId]
  );
  const assembled = assembleBookMirrorUpload(
    data,
    staged.map(camelLegacyRow) as Parameters<typeof assembleBookMirrorUpload>[1]
  );
  if (prior) return store.accept(prior);
  const existing = await store.entity("books", data.extId);
  const op = await localOperation(
    store.workspace,
    store.nodeId,
    "books",
    data.extId,
    {
      title: assembled.title,
      author: assembled.author,
      format: assembled.format,
      folderId: assembled.folder,
      contentHash: assembled.contentHash,
      chapters: assembled.chapters,
      ...(!existing
        ? {
            coverTone: 0,
            createdAt: Date.now(),
            progress: { chapterId: assembled.chapters[0]?.id ?? "", ratio: 0 },
          }
        : {}),
    },
    blobs
  );
  op.operationId = operationId;
  op.clock = nextClock((await store.head()).clock);
  return store.accept(op);
}

const kinds: Record<string, Operation["kind"]> = {
  books: "books",
  notes: "notes",
  folders: "folders",
  highlights: "highlights",
  associations: "associations",
  translations: "translations",
  mindmaps: "mindMaps",
  studysets: "studySets",
};
const tables: [string, Operation["kind"]][] = [
  ["mirror_books", "books"],
  ["mirror_notes", "notes"],
  ["mirror_folders", "folders"],
  ["mirror_highlights", "highlights"],
  ["mirror_associations", "associations"],
  ["mirror_translations", "translations"],
  ["mirror_mindmaps", "mindMaps"],
];
export async function importLegacy(store: SyncStore, blobs: BlobStore) {
  if (await store.peerCursor("legacy-import-v1")) return;
  for (const [table, kind] of tables) {
    const [rows] = await store.pool.query<RowDataPacket[]>(
      `SELECT * FROM ${table}`
    );
    for (const raw of rows) {
      const row = camelLegacyRow(raw);
      const id = String(row.extId);
      let data: Record<string, unknown> = {
        ...row,
        id,
        createdAt: Number(new Date(row.createdAt)),
        updatedAt: Number(new Date(row.updatedAt ?? row.createdAt)),
      };
      delete data.extId;
      if (kind === "books") {
        data = { ...restoreBook(row as Parameters<typeof restoreBook>[0]) };
        if (
          !["pdf", "epub", "mobi", "azw3", "fb2", "txt", "builtin"].includes(
            String(data.format)
          )
        ) {
          data.legacyFormat = data.format;
          data.format = "txt";
        }
      } else if (kind === "associations")
        data = {
          ...associationFromRow(
            row as Parameters<typeof associationFromRow>[0]
          ),
          id,
        };
      else {
        if (row.bookExtId) {
          data.bookId = row.bookExtId;
          delete data.bookExtId;
        }
        if (kind === "highlights") {
          data.style = { kind: row.styleKind, color: row.styleColor };
          data.noteId = row.noteExtId;
          data.start = row.startOffset;
          data.end = row.endOffset;
          data.citation = {
            level: row.citationLevel,
            chapterId: row.chapterId,
            paraIndex: row.paraIndex,
            start: row.startOffset,
            end: row.endOffset,
          };
        }
        for (const field of [
          "root",
          "aiQa",
          "tags",
          "cloze",
          "review",
          "pdfAnchor",
        ])
          if (typeof row[field] === "string")
            data[field] = JSON.parse(row[field]);
        if (kind === "translations") data.chapterId = row.chapterId ?? "";
      }
      const { id: _id, ...patch } = data;
      void _id;
      for (const key of Object.keys(patch))
        if (patch[key] == null) delete patch[key];
      let sourcePatch: Record<string, unknown> | undefined;
      if (kind === "books" && row.sourceManifest) {
        const manifest = JSON.parse(row.sourceManifest);
        const upload = await blobs.create(manifest);
        if (!upload.present) {
          const [chunks] = await store.pool.query<RowDataPacket[]>(
            "SELECT chunk_index,payload FROM library_source_chunks WHERE book_ext_id=? AND upload_id=? ORDER BY chunk_index",
            [id, manifest.uploadId]
          );
          for (const chunk of chunks) {
            const bytes = Buffer.from(chunk.payload, "base64");
            await blobs.put(upload.id, chunk.chunk_index, bytes, digest(bytes));
          }
          await blobs.commit(upload.id);
        }
        sourcePatch = { ...manifest, format: row.format };
      }
      const op = await localOperation(
        store.workspace,
        "legacy-import",
        kind,
        id,
        JSON.parse(JSON.stringify(patch)),
        blobs,
        0
      );
      op.operationId = `legacy-${digest(JSON.stringify(op.patch) + kind + id)}`;
      const sourceOp = sourcePatch
        ? await localOperation(
            store.workspace,
            "legacy-import",
            "sources",
            id,
            sourcePatch,
            blobs,
            0
          )
        : undefined;
      if (sourceOp)
        sourceOp.operationId = `legacy-source-${digest(id + sourcePatch!.sha256)}`;
      await store.transaction(async db => {
        await store.accept(op, db);
        if (sourceOp) await store.accept(sourceOp, db);
      });
    }
  }
  for (const [table, kind] of [
    ["mirror_book_tombstones", "books"],
    ["mirror_note_tombstones", "notes"],
  ] as const) {
    const [rows] = await store.pool.query<RowDataPacket[]>(
      `SELECT ext_id FROM ${table}`
    );
    for (const row of rows) {
      const op = await localOperation(
        store.workspace,
        "legacy-import",
        kind,
        row.ext_id,
        {},
        blobs,
        0
      );
      op.operationId = `legacy-delete-${digest(kind + row.ext_id)}`;
      op.deleted = true;
      await store.accept(op);
    }
  }
  await store.savePeerCursor("legacy-import-v1", "complete");
}

/** Compatibility reads/writes use the canonical log while v2 is enabled. */
export function legacyBridge(
  store: SyncStore,
  blobs: BlobStore,
  browserLibrary = false
) {
  const api = new Hono();
  api.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof SyncError
            ? error.code
            : error instanceof ZodError
              ? "validation_failed"
              : "sync_unavailable",
      },
      error instanceof SyncError
        ? (error.status as 400)
        : error instanceof ZodError
          ? 400
          : 503
    )
  );
  api.use("*", async (c, next) => {
    const parts = c.req.path.split("/").filter(Boolean);
    const offset = browserLibrary
      ? parts.indexOf("library")
      : parts.indexOf("v1");
    const resource = parts[offset + 1];
    const id = parts[offset + 2];
    const extra = parts[offset + 3];
    if (!browserLibrary && resource === "events" && c.req.method === "POST") {
      return (extractKey(c) ? requireApiKey : requireBrowserMutation)(
        c,
        async () => {
          const body = await c.req.json();
          const validated = normalizeReaderMirrorEvent(
            body.type,
            body.data ?? {}
          );
          if (!validated.success) {
            c.res = c.json(
              { error: "validation_failed", issues: validated.issues },
              400
            );
            return;
          }
          const singular: Record<string, Operation["kind"]> = {
            book: "books",
            note: "notes",
            folder: "folders",
            highlight: "highlights",
            association: "associations",
            translation: "translations",
            mindmap: "mindMaps",
            studyset: "studySets",
            review: "highlights",
            qa: "highlights",
          };
          const [prefix, action] = String(body.type).split(".");
          const eventKind = singular[prefix];
          if (String(body.type).startsWith("book.import.")) {
            await legacyBookImport(store, blobs, body.type, validated.data);
            c.res = c.json({ ok: true, mirrored: true });
            return;
          }
          if (!eventKind) {
            c.res = c.json(
              {
                error: "upgrade_required",
                message: "Use /api/v2 for resumable imports",
              },
              426
            );
            return;
          }
          const data = { ...validated.data };
          const entityId = String(data.extId);
          delete data.extId;
          if (data.bookExtId) {
            data.bookId = data.bookExtId;
            delete data.bookExtId;
          }
          if (data.noteExtId) {
            data.noteId = data.noteExtId;
            delete data.noteExtId;
          }
          if (data.folder !== undefined) {
            data.folderId = data.folder;
            delete data.folder;
          }
          const operationId = body.deliveryId
            ? `event-${digest(body.deliveryId)}`
            : randomUUID();
          const previous = await store.operation(operationId);
          const clock =
            previous?.clock ?? nextClock((await store.head()).clock);
          if (["created", "imported"].includes(action))
            data.createdAt ??= Number(clock.split(":")[0]);
          const operation = {
            ...(await localOperation(
              store.workspace,
              store.nodeId,
              eventKind,
              entityId,
              data,
              blobs
            )),
            operationId,
            clock,
            deleted: action === "deleted",
          };
          const receipt = await store.mutate(operation);
          if (!receipt.duplicate)
            fanout({ type: body.type, source: "reader", data: validated.data });
          c.res = c.json({ ok: true, mirrored: true });
        }
      );
    }
    const kind = kinds[resource];
    if (!kind || (extra && !["state", "chapters", "source"].includes(extra)))
      return next();
    const authorize = browserLibrary
      ? c.req.method === "GET"
        ? requireBrowserSession
        : requireBrowserMutation
      : requireReaderOrMachine;
    return authorize(c, async () => {
      c.header("Cache-Control", "no-store");
      if (extra === "source") {
        identifier.parse(id);
        const book = await store.entity("books", id);
        if (!book || book.deleted) throw new SyncError("book_not_found", 404);
        if (c.req.method === "GET") {
          const source = await store.entity("sources", id);
          const manifest = source && materialize(source);
          if (!manifest || !(await blobs.has(String(manifest.sha256))))
            throw new SyncError("source_not_found", 404);
          c.res = c.body(
            Readable.toWeb(
              createReadStream(blobs.path(String(manifest.sha256)))
            ) as ReadableStream<Uint8Array>,
            200,
            { "Content-Type": "application/octet-stream" }
          );
          return;
        }
        const body = await c.req.json();
        if (c.req.method === "PUT" && parts[offset + 4] === "chunks") {
          if (
            typeof body.payload !== "string" ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(body.payload)
          )
            throw new SyncError("invalid_chunk");
          await blobs.stageLegacy(
            id,
            body.uploadId,
            body.index,
            Buffer.from(body.payload, "base64")
          );
        } else if (
          c.req.method === "POST" &&
          parts[offset + 4] === "complete"
        ) {
          const manifest = sourceSchema.parse(body);
          await blobs.completeLegacy(id, manifest);
          const operationId = `source-${digest(id + manifest.sha256)}`;
          const prior = await store.operation(operationId);
          const op = await localOperation(
            store.workspace,
            store.nodeId,
            "sources",
            id,
            { ...manifest, format: materialize(book)?.format },
            blobs
          );
          op.operationId = operationId;
          op.clock = nextClock((await store.head()).clock);
          await store.accept(prior ?? op);
        } else throw new SyncError("unsupported_source_method", 405);
        c.res = c.json({ ok: true });
        return;
      }
      if (c.req.method === "GET") {
        let after = "";
        const states = [];
        do {
          const page = await store.entities(kind, after);
          states.push(...page.entities);
          after = page.entities.length === 100 ? (page.next ?? "") : "";
        } while (after);
        let records = states
          .map(materialize)
          .filter((v): v is Record<string, unknown> => v !== null);
        for (const record of records)
          for (const [key, value] of Object.entries(record))
            if (isBlobReference(value))
              record[key] = JSON.parse(
                await readFile(blobs.path(value.$blob.sha256), "utf8")
              );
        if (c.req.query("book"))
          records = records.filter(r => r.bookId === c.req.query("book"));
        if (c.req.query("folder") !== undefined)
          records = records.filter(
            r => (r.folderId ?? "") === c.req.query("folder")
          );
        if (id) {
          const item = records.find(r => r.id === id);
          if (!item) {
            c.res = c.json({ error: "not_found" }, 404);
            return;
          }
          if (extra === "chapters")
            c.res = c.json(
              parts[offset + 4] === undefined
                ? { chapters: item.chapters }
                : (item.chapters as unknown[])?.[Number(parts[offset + 4])]
            );
          else
            c.res = c.json(
              browserLibrary
                ? { book: item, source: null }
                : { ...item, extId: item.id }
            );
          return;
        }
        if (browserLibrary) {
          const folders = (await store.entities("folders")).entities
            .map(materialize)
            .filter(Boolean);
          c.res = c.json({
            books: records.map(r => ({
              id: r.id,
              hasReaderData: true,
              source: null,
            })),
            deletedBookIds: states.filter(s => s.deleted).map(s => s.id),
            folders,
          });
        } else
          c.res = c.json({
            [resource]: records.map(r => ({ ...r, extId: r.id })),
          });
        return;
      }
      if (!["POST", "PATCH", "DELETE"].includes(c.req.method)) return next();
      const body = c.req.method === "DELETE" ? {} : await c.req.json();
      const entityId = id ?? body.extId ?? body.id;
      const patch = { ...body };
      delete patch.extId;
      delete patch.id;
      if (patch.bookExtId) {
        patch.bookId = patch.bookExtId;
        delete patch.bookExtId;
      }
      if (patch.folder !== undefined) {
        patch.folderId = patch.folder;
        delete patch.folder;
      }
      if (c.req.method === "POST") {
        if (kind === "books") {
          patch.author ??= "";
          patch.format ??= "txt";
          patch.chapters ??= [];
          patch.coverTone ??= 0;
          patch.progress ??= {
            chapterId: patch.chapters[0]?.id ?? "",
            ratio: 0,
          };
        }
        if (kind === "notes") patch.content ??= "";
        if (kind === "translations") patch.chapterId ??= "";
        if (kind === "highlights") {
          patch.chapterId ??= "";
          patch.chapterTitle ??= "";
          patch.text ??= "";
        }
      }
      const operationId = c.req.header("Idempotency-Key") ?? randomUUID();
      const previous = await store.operation(operationId);
      const clock = previous?.clock ?? nextClock((await store.head()).clock);
      if (c.req.method === "POST") {
        patch.createdAt ??= Number(clock.split(":")[0]);
        patch.updatedAt ??= patch.createdAt;
      }
      const op = {
        ...(await localOperation(
          store.workspace,
          store.nodeId,
          kind,
          entityId,
          patch,
          blobs
        )),
        clock,
        deleted: c.req.method === "DELETE",
        operationId,
      };
      const receipt = await store.mutate(op);
      if (!receipt.duplicate) {
        const eventResource: Record<string, string> = {
          books: "book",
          notes: "note",
          folders: "folder",
          highlights: "highlight",
          associations: "association",
          translations: "translation",
          mindMaps: "mindmap",
          studySets: "studyset",
        };
        const eventAction =
          c.req.method === "POST"
            ? "created"
            : c.req.method === "DELETE"
              ? "deleted"
              : "updated";
        fanout({
          type: `${eventResource[kind]}.${eventAction}`,
          source: browserLibrary ? "reader" : "api",
          data: { ...body, extId: entityId },
        });
      }
      c.res = c.json({ ok: true, extId: entityId });
    });
  });
  return api;
}
