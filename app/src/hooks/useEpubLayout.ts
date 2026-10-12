import { useEffect, useMemo, useRef, useState } from "react";
import type { Book } from "@/types";
import type { EpubLayout } from "@/lib/epubLayout";
import { getEpubLayout } from "@/lib/epubLayoutStore";

/** A local cache subscription shared by the main, reference and bilingual readers. */
export function useEpubLayout(book: Book): EpubLayout | undefined {
  const identity = useMemo(
    () => JSON.stringify([book.id, book.format, book.chapters]),
    [book.id, book.format, book.chapters]
  );
  const bookId = book.id;
  const latestBook = useRef(book);
  const [snapshot, setSnapshot] = useState<{
    identity: string;
    layout?: EpubLayout;
  }>();
  useEffect(() => {
    latestBook.current = book;
  }, [book]);
  useEffect(() => {
    let active = true;
    let request = 0;
    const refresh = () => {
      const current = ++request;
      void getEpubLayout(latestBook.current).then(
        layout => {
          if (active && current === request) setSnapshot({ identity, layout });
        },
        () => {
          if (active && current === request) setSnapshot({ identity });
        }
      );
    };
    const local = (event: Event) => {
      if ((event as CustomEvent<{ bookId?: string }>).detail?.bookId === bookId)
        refresh();
    };
    let channel: BroadcastChannel | undefined;
    try {
      if (typeof BroadcastChannel !== "undefined")
        channel = new BroadcastChannel("shufang:epub-layout");
    } catch {
      /* Same-tab and sync notifications remain available. */
    }
    if (channel)
      channel.onmessage = event => {
        if (event.data?.bookId === bookId) refresh();
      };
    window.addEventListener("shufang:epub-layout-updated", local);
    window.addEventListener("shufang:sync-updated", refresh);
    refresh();
    return () => {
      active = false;
      window.removeEventListener("shufang:epub-layout-updated", local);
      window.removeEventListener("shufang:sync-updated", refresh);
      channel?.close();
    };
  }, [bookId, identity]);
  return snapshot?.identity === identity ? snapshot.layout : undefined;
}
