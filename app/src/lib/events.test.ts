import { describe, expect, it, vi } from "vitest";
import { createMirrorEventEmitter } from "./events";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("emitEvent delivery ordering", () => {
  it("delivers create, update and delete for one entity in call order", async () => {
    const createDelivery = deferred<void>();
    const updateDelivery = deferred<void>();
    const deliver = vi
      .fn()
      .mockReturnValueOnce(createDelivery.promise)
      .mockReturnValueOnce(updateDelivery.promise)
      .mockResolvedValueOnce(undefined);
    const emit = createMirrorEventEmitter(deliver);

    const created = emit("highlight.created", { extId: "highlight-1" });
    const updated = emit("highlight.updated", { extId: "highlight-1" });
    const deleted = emit("highlight.deleted", { extId: "highlight-1" });
    expect(deliver).toHaveBeenCalledTimes(1);

    createDelivery.resolve();
    await created;
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    expect(deliver.mock.calls[1]?.[0]).toMatchObject({
      type: "highlight.updated",
    });

    updateDelivery.resolve();
    await updated;
    await deleted;
    expect(deliver.mock.calls.map(call => call[0].type)).toEqual([
      "highlight.created",
      "highlight.updated",
      "highlight.deleted",
    ]);
  });

  it("does not let a failed delivery block the next event", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const firstDelivery = deferred<void>();
    const deliver = vi
      .fn()
      .mockReturnValueOnce(firstDelivery.promise)
      .mockResolvedValueOnce(undefined);
    const emit = createMirrorEventEmitter(deliver);

    const first = emit("note.created", { extId: "note-1" });
    const second = emit("note.updated", { extId: "note-1" });
    firstDelivery.reject(new Error("offline"));

    await expect(first).rejects.toThrow("offline");
    await expect(second).resolves.toBeUndefined();
    expect(deliver).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  it("allows unrelated entities to deliver concurrently", () => {
    const deliver = vi.fn(() => new Promise<void>(() => undefined));
    const emit = createMirrorEventEmitter(deliver);

    void emit("note.updated", { extId: "note-1" });
    void emit("note.updated", { extId: "note-2" });

    expect(deliver).toHaveBeenCalledTimes(2);
  });
});
