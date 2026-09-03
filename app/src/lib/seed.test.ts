import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Note } from "@/types";
import {
  closeDatabaseConnection,
  deleteBook,
  getAllBooks,
  getAllNotes,
  getHighlights,
  putNote,
  SHUFANG_DB_NAME,
} from "./db";
import { seedIfEmpty } from "./seed";

function deleteTestDatabase() {
  closeDatabaseConnection();
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(SHUFANG_DB_NAME);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("test database deletion blocked"));
    request.onsuccess = () => resolve();
  });
}

describe("example library seeding", () => {
  beforeEach(deleteTestDatabase);
  afterEach(deleteTestDatabase);

  it("does not seed or replace records when books are empty but user data exists", async () => {
    const userNote: Note = {
      id: "seed-n1",
      title: "User-owned note",
      content: "This must never be replaced by demo content.",
      createdAt: 1,
      updatedAt: 2,
    };
    await putNote(userNote);

    await seedIfEmpty();
    await seedIfEmpty();

    expect(await getAllBooks()).toEqual([]);
    expect(await getAllNotes()).toEqual([userNote]);
    expect(await getHighlights()).toEqual([]);
  });

  it("does not restore examples or overwrite an edited seed note after deletion", async () => {
    await seedIfEmpty();
    const seedNote = (await getAllNotes()).find(note => note.id === "seed-n1");
    expect(seedNote).toBeDefined();
    const edited = {
      ...seedNote!,
      title: "My note now",
      content: "user edit",
      updatedAt: Date.now(),
    };
    await putNote(edited);
    await deleteBook("seed-lunyu");

    await seedIfEmpty();

    expect(await getAllBooks()).toEqual([]);
    expect((await getAllNotes()).find(note => note.id === "seed-n1")).toEqual(
      edited
    );
  });

  it("serializes simultaneous first-run seed attempts", async () => {
    await Promise.all([seedIfEmpty(), seedIfEmpty()]);

    expect((await getAllBooks()).map(book => book.id)).toEqual(["seed-lunyu"]);
    expect((await getAllNotes()).map(note => note.id).sort()).toEqual([
      "seed-n1",
      "seed-n2",
    ]);
    expect((await getHighlights()).map(highlight => highlight.id)).toEqual([
      "seed-h1",
    ]);
  });
});
