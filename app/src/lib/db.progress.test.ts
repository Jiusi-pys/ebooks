import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import type { Book } from "@/types";
import {
  deleteBook,
  deleteFolder,
  getAllBooks,
  getAllFolders,
  patchBookFolder,
  patchBookLastOpenedAt,
  patchBookMetadata,
  patchBookCustomCover,
  patchBookOutline,
  patchBookProgress,
  patchBookReaderMode,
  patchBookTitle,
  patchFolderIcon,
  patchFolderName,
  putBook,
  putFolder,
} from "./db";

const createdIds: string[] = [];
const createdFolderIds: string[] = [];

function book(id: string): Book {
  return {
    id,
    title: "Concurrency",
    author: "Tester",
    format: "epub",
    cover: "data:image/png;base64,builtin",
    customCover: "data:image/png;base64,custom",
    coverTone: 4,
    chapters: [
      { id: "chapter-1", title: "One", paragraphs: ["First"] },
      { id: "chapter-2", title: "Two", paragraphs: ["Second"] },
    ],
    createdAt: 1,
    progress: { chapterId: "chapter-1", ratio: 0.1 },
    folderId: "folder-1",
    readerMode: "reflow",
    outline: [
      {
        id: "custom-outline",
        title: "Keep me",
        chapterId: "chapter-2",
        paraIndex: 0,
        depth: 0,
      },
    ],
  };
}

describe("atomic book progress updates", () => {
  afterEach(async () => {
    await Promise.all(createdIds.splice(0).map(deleteBook));
    await Promise.all(createdFolderIds.splice(0).map(deleteFolder));
  });

  it("patches progress without replacing newer book-owned fields", async () => {
    const id = `progress-${Date.now()}-${Math.random()}`;
    createdIds.push(id);
    const staleScrollSnapshot = book(id);
    await putBook(staleScrollSnapshot);
    const stored = {
      ...staleScrollSnapshot,
      title: "Edited while the scroll callback was waiting",
      outline: [
        ...(staleScrollSnapshot.outline ?? []),
        { id: "new-outline", title: "New", depth: 0 },
      ],
    } satisfies Book;
    await putBook(stored);

    const updated = await patchBookProgress(id, "chapter-2", 1.5);
    const persisted = (await getAllBooks()).find(item => item.id === id);

    expect(updated?.progress).toEqual({ chapterId: "chapter-2", ratio: 1 });
    expect(persisted).toMatchObject({
      customCover: stored.customCover,
      folderId: stored.folderId,
      outline: stored.outline,
      readerMode: stored.readerMode,
      progress: { chapterId: "chapter-2", ratio: 1 },
    });
  });

  it("does not recreate a book that was deleted before the patch", async () => {
    const id = `deleted-progress-${Date.now()}-${Math.random()}`;
    await expect(
      patchBookProgress(id, "chapter-1", 0.5)
    ).resolves.toBeUndefined();
    expect((await getAllBooks()).some(item => item.id === id)).toBe(false);
  });

  it("updates and clears only the custom cover field", async () => {
    const id = `cover-${Date.now()}-${Math.random()}`;
    createdIds.push(id);
    const stored = book(id);
    await putBook(stored);

    await patchBookCustomCover(id, "data:image/jpeg;base64,replacement");
    await patchBookProgress(id, "chapter-2", 0.75);
    const cleared = await patchBookCustomCover(id);

    expect(cleared?.customCover).toBeUndefined();
    expect(cleared).toMatchObject({
      cover: stored.cover,
      outline: stored.outline,
      progress: { chapterId: "chapter-2", ratio: 0.75 },
    });
  });

  it("serializes field edits from two stale library instances", async () => {
    const id = `stale-instances-${Date.now()}-${Math.random()}`;
    createdIds.push(id);
    const instanceA = book(id);
    const instanceB = structuredClone(instanceA);
    await putBook(instanceA);
    const outline = [{ id: "other-tab", title: "Other tab", depth: 0 }];

    // Both callers made their decision from the original snapshot. Separate
    // readwrite transactions must merge their owned fields into the latest
    // record instead of letting the last stale object win.
    await Promise.all([
      patchBookTitle(instanceA.id, "Renamed in A"),
      patchBookReaderMode(instanceB.id, "original"),
      patchBookOutline(instanceA.id, outline),
      patchBookFolder(instanceB.id, undefined),
      patchBookCustomCover(instanceA.id, "data:image/png;base64,from-a"),
    ]);

    const persisted = (await getAllBooks()).find(item => item.id === id);
    expect(persisted).toMatchObject({
      title: "Renamed in A",
      readerMode: "original",
      outline,
      customCover: "data:image/png;base64,from-a",
      progress: instanceA.progress,
    });
    expect(persisted).not.toHaveProperty("folderId");
  });

  it("updates catalogue metadata without replacing reading-owned fields", async () => {
    const id = `metadata-${Date.now()}-${Math.random()}`;
    createdIds.push(id);
    const stored = book(id);
    await putBook(stored);

    const updated = await patchBookMetadata(id, {
      title: "Edited title",
      author: "Alice；Bob",
      metadata: {
        version: 1,
        publisher: "Example Press",
        languages: ["zh-Hans"],
      },
    });

    expect(updated).toMatchObject({
      title: "Edited title",
      author: "Alice；Bob",
      metadata: { publisher: "Example Press", languages: ["zh-Hans"] },
      progress: stored.progress,
      customCover: stored.customCover,
      outline: stored.outline,
    });
  });

  it("keeps last-opened timestamps monotonic across delayed writes", async () => {
    const id = `last-opened-${Date.now()}-${Math.random()}`;
    createdIds.push(id);
    await putBook(book(id));

    await patchBookLastOpenedAt(id, 900);
    const updated = await patchBookLastOpenedAt(id, 500);

    expect(updated?.lastOpenedAt).toBe(900);
  });

  it("updates a folder icon without replacing its name", async () => {
    const id = `folder-icon-${Date.now()}-${Math.random()}`;
    createdFolderIds.push(id);
    await putFolder({ id, name: "Research", createdAt: 10 });

    const updated = await patchFolderIcon(id, "sparkles");
    const persisted = (await getAllFolders()).find(folder => folder.id === id);

    expect(updated).toEqual({
      id,
      name: "Research",
      icon: "sparkles",
      createdAt: 10,
    });
    expect(persisted).toEqual(updated);
  });

  it("merges concurrent folder name and icon edits", async () => {
    const id = `folder-fields-${Date.now()}-${Math.random()}`;
    createdFolderIds.push(id);
    await putFolder({ id, name: "Original", icon: "folder", createdAt: 10 });

    await Promise.all([
      patchFolderName(id, "Renamed"),
      patchFolderIcon(id, "archive"),
    ]);

    expect((await getAllFolders()).find(folder => folder.id === id)).toEqual({
      id,
      name: "Renamed",
      icon: "archive",
      createdAt: 10,
    });
  });

  it("removes a folder without overwriting a concurrent book field edit", async () => {
    const folderId = `delete-folder-${Date.now()}-${Math.random()}`;
    const bookId = `delete-folder-book-${Date.now()}-${Math.random()}`;
    createdFolderIds.push(folderId);
    createdIds.push(bookId);
    await putFolder({ id: folderId, name: "Delete", createdAt: 10 });
    await putBook({ ...book(bookId), folderId });

    await Promise.all([
      deleteFolder(folderId),
      patchBookCustomCover(bookId, "data:image/png;base64,concurrent"),
    ]);

    const persisted = (await getAllBooks()).find(item => item.id === bookId);
    expect(persisted?.customCover).toBe("data:image/png;base64,concurrent");
    expect(persisted).not.toHaveProperty("folderId");
  });

  it("does not assign a book to a folder that is being deleted", async () => {
    const folderId = `racing-folder-${Date.now()}-${Math.random()}`;
    const bookId = `racing-folder-book-${Date.now()}-${Math.random()}`;
    createdFolderIds.push(folderId);
    createdIds.push(bookId);
    await putFolder({ id: folderId, name: "Racing", createdAt: 10 });
    const unfiledBook = book(bookId);
    delete unfiledBook.folderId;
    await putBook(unfiledBook);

    // deleteFolder creates the first overlapping readwrite transaction. The
    // queued move must re-check the folder after that transaction commits.
    const deleting = deleteFolder(folderId);
    const assigning = patchBookFolder(bookId, folderId);
    const [, assigned] = await Promise.all([deleting, assigning]);

    expect(assigned).toBeUndefined();
    expect((await getAllFolders()).some(folder => folder.id === folderId)).toBe(
      false
    );
    const persisted = (await getAllBooks()).find(item => item.id === bookId);
    expect(persisted).not.toHaveProperty("folderId");
  });
});
