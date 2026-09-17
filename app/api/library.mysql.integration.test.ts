import { createHash } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mirrorBooks, librarySourceChunks } from "@db/mirror-schema";
import { getDb } from "./queries/connection";
import { library } from "./library";

// Authentication is exercised independently in auth.test.ts. These requests
// exercise the real SQL persistence and transactions behind an accepted session.
vi.mock("./auth", () => ({
  requireBrowserSession: (_c: unknown, next: () => Promise<void>) => next(),
  requireBrowserMutation: (_c: unknown, next: () => Promise<void>) => next(),
}));
const id = `library-it-${Date.now()}`;
const bytes = Buffer.from("%PDF-1.4\noriginal source bytes\n");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const source = {
  uploadId: sha256,
  sha256,
  size: bytes.length,
  chunks: 1,
  name: "跨浏览器.pdf",
  type: "application/pdf",
};
const state = {
  cover: "data:image/png;base64,aGVsbG8=",
  coverTone: 2,
  readerMode: "original",
  pageCount: 2,
  outline: [{ id: "o1", title: "目录", chapterId: "c1", depth: 0 }],
  progress: { chapterId: "c1", ratio: 0.6 },
};
const request = (path: string, method = "GET", body?: unknown) =>
  library.request(`/books/${id}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

describe.skipIf(process.env.RUN_MYSQL_INTEGRATION !== "1")(
  "MySQL library persistence",
  () => {
    afterAll(async () => {
      await getDb().delete(mirrorBooks).where(eq(mirrorBooks.extId, id));
    });
    it("persists complete reader state and validates uploads before publishing originals", async () => {
      await getDb()
        .insert(mirrorBooks)
        .values({
          extId: id,
          title: "Integration",
          author: "Tester",
          format: "pdf",
          folder: "",
          contentHash: sha256,
          chapters: JSON.stringify([
            { id: "c1", title: "One", paragraphs: ["Text"] },
          ]),
        });
      expect(
        (
          await request("/state", "PATCH", {
            ...state,
            progress: { chapterId: "c1", ratio: 2 },
          })
        ).status
      ).toBe(400);
      expect((await request("/state", "PATCH", state)).status).toBe(200);
      expect((await request("/source/complete", "POST", source)).status).toBe(
        400
      );
      expect((await request("/source")).status).toBe(404);
      expect(
        (
          await request("/source/chunks", "PUT", {
            uploadId: sha256,
            index: 0,
            payload: bytes.toString("base64"),
          })
        ).status
      ).toBe(200);
      expect((await request("/source/complete", "POST", source)).status).toBe(
        200
      );
      const restored = (await (await request("")).json()) as {
        book: unknown;
        source: unknown;
      };
      expect(restored.book).toMatchObject(state);
      expect(restored.source).toEqual(source);
      expect(
        Buffer.from(await (await request("/source")).arrayBuffer())
      ).toEqual(bytes);
    });
    it("does not let a retry corrupt an already committed original", async () => {
      expect(
        (
          await request("/source/chunks", "PUT", {
            uploadId: sha256,
            index: 0,
            payload: bytes.toString("base64"),
          })
        ).status
      ).toBe(200);
      expect(
        (
          await request("/source/chunks", "PUT", {
            uploadId: sha256,
            index: 0,
            payload: Buffer.from("corrupt").toString("base64"),
          })
        ).status
      ).toBe(409);
      expect(
        Buffer.from(await (await request("/source")).arrayBuffer())
      ).toEqual(bytes);
    });
    it("cascades source chunks when the book is deleted", async () => {
      await getDb().delete(mirrorBooks).where(eq(mirrorBooks.extId, id));
      expect(
        await getDb()
          .select()
          .from(librarySourceChunks)
          .where(eq(librarySourceChunks.bookExtId, id))
      ).toHaveLength(0);
      expect((await request("/state", "PATCH", state)).status).toBe(404);
    });
  }
);
