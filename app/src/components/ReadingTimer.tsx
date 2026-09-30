import { useEffect } from "react";
import type { ReadingSession } from "@/types";

const CHECKPOINT_MS = 15_000;

/** Persist foreground reader sessions without rendering a timer control. */
export function ReadingTimer({
  bookId,
  onSave,
}: {
  bookId: string;
  onSave: (session: ReadingSession) => Promise<void> | void;
}) {
  useEffect(() => {
    let current: ReadingSession | undefined;
    const save = (session: ReadingSession) => {
      void Promise.resolve(onSave(session)).catch(error =>
        console.error("Failed to save reading session", error)
      );
    };
    const begin = () => {
      if (current || document.visibilityState !== "visible") return;
      const now = Date.now();
      current = {
        id: crypto.randomUUID(),
        bookId,
        startedAt: now,
        endedAt: now,
      };
      save(current);
    };
    const finish = () => {
      if (!current) return;
      const session = {
        ...current,
        endedAt: Math.max(current.startedAt, Date.now()),
      };
      current = undefined;
      save(session);
    };
    const onVisibilityChange = () =>
      document.visibilityState === "visible" ? begin() : finish();
    const onPageHide = () => finish();
    const onPageShow = () => begin();

    begin();
    const checkpoint = window.setInterval(() => {
      if (current)
        save({ ...current, endedAt: Math.max(current.startedAt, Date.now()) });
    }, CHECKPOINT_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      window.clearInterval(checkpoint);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      finish();
    };
  }, [bookId, onSave]);

  return null;
}
