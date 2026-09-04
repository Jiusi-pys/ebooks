import { describe, expect, it, vi } from "vitest";

import {
  deleteHighlightWithMirror,
  deleteHighlightsWithMirror,
} from "./highlightDeletion";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("deleteHighlightWithMirror", () => {
  it("waits for one mirror deletion before removing the local highlight", async () => {
    const delivery = deferred<void>();
    const emitMirror = vi.fn(() => delivery.promise);
    const commitLocal = vi.fn().mockResolvedValue("committed");

    const deletion = deleteHighlightWithMirror("highlight-1", "Book", {
      emitMirror,
      commitLocal,
    });

    expect(emitMirror).toHaveBeenCalledWith("highlight.deleted", {
      extId: "highlight-1",
      bookTitle: "Book",
    });
    expect(commitLocal).not.toHaveBeenCalled();

    delivery.resolve();
    await expect(deletion).resolves.toBe("committed");
    expect(commitLocal).toHaveBeenCalledOnce();
    expect(commitLocal).toHaveBeenCalledWith(["highlight-1"]);
  });

  it("retains the local highlight when mirror deletion fails", async () => {
    const error = new Error("mirror unavailable");
    const emitMirror = vi.fn().mockRejectedValue(error);
    const commitLocal = vi.fn().mockResolvedValue(undefined);

    await expect(
      deleteHighlightWithMirror("highlight-2", "Book", {
        emitMirror,
        commitLocal,
      })
    ).rejects.toBe(error);
    expect(commitLocal).not.toHaveBeenCalled();
  });

  it("confirms every unique citation deletion before one local commit", async () => {
    const calls: string[] = [];
    const emitMirror = vi.fn(
      async (_type: string, data: Record<string, unknown>) => {
        calls.push(`mirror:${String(data.extId)}`);
      }
    );
    const beforeLocalCommit = vi.fn(async () => {
      calls.push("server-note-delete");
    });
    const commitLocal = vi.fn(async (ids: string[]) => {
      calls.push(`local:${ids.join(",")}`);
      return ids.length;
    });

    await expect(
      deleteHighlightsWithMirror(
        [
          { id: "highlight-1", bookTitle: "Book" },
          { id: "highlight-2", bookTitle: "Book" },
          { id: "highlight-1", bookTitle: "Ignored duplicate" },
        ],
        { emitMirror, beforeLocalCommit, commitLocal }
      )
    ).resolves.toBe(2);

    expect(calls).toEqual([
      "mirror:highlight-1",
      "mirror:highlight-2",
      "server-note-delete",
      "local:highlight-1,highlight-2",
    ]);
    expect(emitMirror).toHaveBeenCalledTimes(2);
    expect(commitLocal).toHaveBeenCalledOnce();
  });

  it("does not commit locally when the enclosing server mutation fails", async () => {
    const commitLocal = vi.fn().mockResolvedValue(undefined);

    await expect(
      deleteHighlightsWithMirror([], {
        emitMirror: vi.fn().mockResolvedValue(undefined),
        beforeLocalCommit: vi
          .fn()
          .mockRejectedValue(new Error("note delete failed")),
        commitLocal,
      })
    ).rejects.toThrow("note delete failed");
    expect(commitLocal).not.toHaveBeenCalled();
  });

  it("does not delete the note or commit locally after a partial mirror failure", async () => {
    const beforeLocalCommit = vi.fn().mockResolvedValue(undefined);
    const commitLocal = vi.fn().mockResolvedValue(undefined);
    const emitMirror = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second highlight failed"));

    await expect(
      deleteHighlightsWithMirror(
        [
          { id: "highlight-1", bookTitle: "Book" },
          { id: "highlight-2", bookTitle: "Book" },
        ],
        { emitMirror, beforeLocalCommit, commitLocal }
      )
    ).rejects.toThrow("second highlight failed");

    expect(emitMirror).toHaveBeenCalledTimes(2);
    expect(beforeLocalCommit).not.toHaveBeenCalled();
    expect(commitLocal).not.toHaveBeenCalled();
  });
});
