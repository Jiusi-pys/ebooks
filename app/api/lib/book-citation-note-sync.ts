import { and, eq, inArray, ne } from "drizzle-orm";

import { mirrorHighlights, mirrorNotes } from "@db/mirror-schema";
import {
  appendCitationBlock,
  citationBlock,
  removeCitationBlocks,
  removeCitationBlock,
  renameCitationBookTitles,
  rewriteCitationBlock,
  type CitationDescriptor,
} from "../../src/lib/citations";
import { getDb } from "../queries/connection";
import { parseStoredCitationLevel } from "./highlight-citation";

type DatabaseClient = ReturnType<typeof getDb>;
type DatabaseTransaction = Parameters<
  Parameters<DatabaseClient["transaction"]>[0]
>[0];
type DatabaseExecutor = Pick<
  DatabaseClient | DatabaseTransaction,
  "select" | "update"
>;

export interface ChangedMirrorNote {
  extId: string;
  title: string;
  content: string;
  updatedAt: number;
}

export type MirrorCitationSnapshot = Pick<
  typeof mirrorHighlights.$inferSelect,
  | "extId"
  | "noteExtId"
  | "citationLevel"
  | "bookTitle"
  | "chapterTitle"
  | "text"
>;

function citationDescriptorFromMirrorHighlight(
  highlight: Pick<
    typeof mirrorHighlights.$inferSelect,
    "extId" | "citationLevel" | "bookTitle" | "chapterTitle" | "text"
  >,
  fallbackBookTitle = ""
): CitationDescriptor {
  return {
    level: parseStoredCitationLevel(highlight.citationLevel),
    highlightId: highlight.extId,
    bookTitle: highlight.bookTitle || fallbackBookTitle,
    chapterTitle: highlight.chapterTitle,
    text: highlight.text,
  };
}

/**
 * Keep generated note content aligned with one already-persisted highlight
 * update. The caller must update the highlight and invoke this function in the
 * same transaction. A link can therefore be rewritten in place, moved to a
 * different note, removed, or newly appended without exposing a half-updated
 * relationship.
 */
export async function syncHighlightCitationNotes(
  database: DatabaseExecutor,
  previous: MirrorCitationSnapshot,
  next: MirrorCitationSnapshot
): Promise<ChangedMirrorNote[]> {
  const previousNoteExtId = previous.noteExtId ?? "";
  const nextNoteExtId = next.noteExtId ?? "";
  const previousDescriptor = citationDescriptorFromMirrorHighlight(previous);
  const nextDescriptor = citationDescriptorFromMirrorHighlight(next);
  if (
    previousNoteExtId === nextNoteExtId &&
    citationBlock(previousDescriptor) === citationBlock(nextDescriptor)
  ) {
    return [];
  }

  const noteExtIds = [...new Set([previousNoteExtId, nextNoteExtId])]
    .filter((extId): extId is string => extId.length > 0)
    .sort();
  if (noteExtIds.length === 0) return [];

  const notes = await database
    .select({
      extId: mirrorNotes.extId,
      title: mirrorNotes.title,
      content: mirrorNotes.content,
      clientUpdatedAt: mirrorNotes.clientUpdatedAt,
    })
    .from(mirrorNotes)
    .where(inArray(mirrorNotes.extId, noteExtIds))
    .for("update");

  // Read the post-update relationships. Re-appending all descriptors for an
  // affected note preserves a shared block when two highlights describe the
  // same passage and only one of them is changed or moved.
  const linkedHighlights = await database
    .select({
      extId: mirrorHighlights.extId,
      noteExtId: mirrorHighlights.noteExtId,
      citationLevel: mirrorHighlights.citationLevel,
      bookTitle: mirrorHighlights.bookTitle,
      chapterTitle: mirrorHighlights.chapterTitle,
      text: mirrorHighlights.text,
    })
    .from(mirrorHighlights)
    .where(inArray(mirrorHighlights.noteExtId, noteExtIds))
    .for("update");
  const currentDescriptors = new Map<string, CitationDescriptor[]>();
  for (const highlight of linkedHighlights) {
    if (!highlight.noteExtId) continue;
    const descriptors = currentDescriptors.get(highlight.noteExtId) ?? [];
    descriptors.push(citationDescriptorFromMirrorHighlight(highlight));
    currentDescriptors.set(highlight.noteExtId, descriptors);
  }

  const changed: ChangedMirrorNote[] = [];
  for (const note of notes) {
    let content = note.content;
    if (note.extId === previousNoteExtId) {
      content =
        note.extId === nextNoteExtId
          ? rewriteCitationBlock(content, previousDescriptor, nextDescriptor)
          : removeCitationBlock(content, previousDescriptor);
    }
    for (const descriptor of currentDescriptors.get(note.extId) ?? []) {
      content = appendCitationBlock(content, descriptor);
    }
    if (content === note.content) continue;
    const updatedAt = Math.max(Date.now(), (note.clientUpdatedAt ?? 0) + 1);
    await database
      .update(mirrorNotes)
      .set({ content, clientUpdatedAt: updatedAt })
      .where(eq(mirrorNotes.extId, note.extId));
    changed.push({
      extId: note.extId,
      title: note.title,
      content,
      updatedAt,
    });
  }
  return changed;
}

/** Rewrite generated citation blocks while locking every affected note row. */
export async function rewriteBookCitationNotes(
  database: DatabaseExecutor,
  bookExtId: string,
  currentTitle: string,
  nextTitle?: string
): Promise<ChangedMirrorNote[]> {
  const highlights = await database
    .select({
      extId: mirrorHighlights.extId,
      noteExtId: mirrorHighlights.noteExtId,
      citationLevel: mirrorHighlights.citationLevel,
      bookTitle: mirrorHighlights.bookTitle,
      chapterTitle: mirrorHighlights.chapterTitle,
      text: mirrorHighlights.text,
    })
    .from(mirrorHighlights)
    .where(
      and(
        eq(mirrorHighlights.bookExtId, bookExtId),
        ne(mirrorHighlights.noteExtId, "")
      )
    )
    .for("update");
  if (highlights.length === 0) return [];

  const byNote = new Map<string, CitationDescriptor[]>();
  for (const highlight of highlights) {
    if (!highlight.noteExtId) continue;
    const descriptors = byNote.get(highlight.noteExtId) ?? [];
    descriptors.push(
      citationDescriptorFromMirrorHighlight(highlight, currentTitle)
    );
    byNote.set(highlight.noteExtId, descriptors);
  }
  const notes = await database
    .select({
      extId: mirrorNotes.extId,
      title: mirrorNotes.title,
      content: mirrorNotes.content,
      clientUpdatedAt: mirrorNotes.clientUpdatedAt,
    })
    .from(mirrorNotes)
    .where(inArray(mirrorNotes.extId, [...byNote.keys()]))
    .for("update");
  const survivingHighlights = await database
    .select({
      extId: mirrorHighlights.extId,
      bookExtId: mirrorHighlights.bookExtId,
      noteExtId: mirrorHighlights.noteExtId,
      citationLevel: mirrorHighlights.citationLevel,
      bookTitle: mirrorHighlights.bookTitle,
      chapterTitle: mirrorHighlights.chapterTitle,
      text: mirrorHighlights.text,
    })
    .from(mirrorHighlights)
    .where(inArray(mirrorHighlights.noteExtId, [...byNote.keys()]))
    .for("update");
  const survivingByNote = new Map<string, CitationDescriptor[]>();
  for (const highlight of survivingHighlights) {
    if (!highlight.noteExtId || highlight.bookExtId === bookExtId) continue;
    const descriptors = survivingByNote.get(highlight.noteExtId) ?? [];
    descriptors.push(citationDescriptorFromMirrorHighlight(highlight));
    survivingByNote.set(highlight.noteExtId, descriptors);
  }
  const changed: ChangedMirrorNote[] = [];
  for (const note of notes) {
    const descriptors = byNote.get(note.extId) ?? [];
    let content =
      nextTitle === undefined
        ? removeCitationBlocks(note.content, descriptors)
        : renameCitationBookTitles(note.content, descriptors, nextTitle);
    if (nextTitle !== undefined) {
      for (const descriptor of descriptors) {
        content = appendCitationBlock(content, {
          ...descriptor,
          bookTitle: nextTitle,
        });
      }
    }
    // Legacy blocks did not carry a stable highlight marker. Removing one
    // deleted book's ambiguous block may therefore also remove an identical
    // surviving reference; re-append every surviving relationship in the new
    // marked format so the note and relational rows converge.
    for (const descriptor of survivingByNote.get(note.extId) ?? []) {
      content = appendCitationBlock(content, descriptor);
    }
    if (content === note.content) continue;
    const updatedAt = Math.max(Date.now(), (note.clientUpdatedAt ?? 0) + 1);
    await database
      .update(mirrorNotes)
      .set({ content, clientUpdatedAt: updatedAt })
      .where(eq(mirrorNotes.extId, note.extId));
    changed.push({
      extId: note.extId,
      title: note.title,
      content,
      updatedAt,
    });
  }
  return changed;
}
