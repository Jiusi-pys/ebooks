// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseEpub } from "./parseEpub";
import { createBookMirrorProtocol } from "./mirrorSync";
import {
  assembleBookMirrorUpload,
  bookImportStartedSchema,
  bookImportChunkSchema,
  bookImportCompletedSchema,
} from "../../api/lib/book-mirror-upload";

it("preserves EPUB popup notes through parsing, chunk upload and server validation", async () => {
  const bytes = readFileSync(
    process.env.EPUB_MIRROR_TEST_FILE ?? "src/lib/fixtures/epub-editor.epub"
  );
  const parsed = await parseEpub({
    name: "notes.epub",
    size: bytes.length,
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  } as File);
  expect(parsed.chapters.some(chapter => chapter.footnotes?.length)).toBe(true);
  const protocol = createBookMirrorProtocol({
    ...parsed,
    extId: "epub-notes",
    format: "epub",
  });
  const start = bookImportStartedSchema.parse(protocol.start.data);
  const manifest = {
    ...start,
    bookExtId: start.extId,
    chunkIndex: -1,
    payload: "",
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const result = assembleBookMirrorUpload(
    bookImportCompletedSchema.parse(protocol.complete.data),
    [
      manifest,
      ...protocol.chunks.map(event => {
        const chunk = bookImportChunkSchema.parse(event.data);
        return { ...manifest, chunkIndex: chunk.index, payload: chunk.payload };
      }),
    ]
  );
  expect(result.chapters).toEqual(parsed.chapters);
  expect(JSON.parse(result.chaptersJson)).toEqual(parsed.chapters);
}, 60_000);
