import { expect, it, vi } from "vitest";
import { draftSaver } from "./draftSaver";

it("flushes the latest draft and retains dirty state after failures", async () => {
  vi.useFakeTimers();
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("disk full"))
    .mockResolvedValue(undefined);
  const saver = draftSaver(save);
  saver.update("first");
  saver.update("latest");
  expect(saver.dirty()).toBe(true);
  await expect(saver.flush()).rejects.toThrow("disk full");
  expect(saver.dirty()).toBe(true);
  await saver.flush();
  expect(save).toHaveBeenLastCalledWith("latest");
  expect(saver.dirty()).toBe(false);
  vi.useRealTimers();
});

it("does not acknowledge a newer draft when an earlier save completes", async () => {
  let finish!: () => void;
  const save = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    )
    .mockResolvedValue(undefined);
  const saver = draftSaver(save);
  saver.update("one");
  const pending = saver.flush();
  saver.update("two");
  finish();
  await pending;
  expect(save).toHaveBeenLastCalledWith("two");
  expect(saver.dirty()).toBe(false);
});
