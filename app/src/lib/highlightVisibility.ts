import type { Highlight } from "@/types";

/** Old AI-only anchors can survive after their last answer is removed. */
export function isReaderHighlightInteractive(highlight: Highlight): boolean {
  return (
    highlight.style?.kind !== "none" ||
    !!highlight.note ||
    !!highlight.name ||
    !!highlight.noteId ||
    (highlight.aiQa?.length ?? 0) > 0 ||
    (highlight.tags?.length ?? 0) > 0 ||
    (highlight.cloze?.length ?? 0) > 0 ||
    !!highlight.review
  );
}
