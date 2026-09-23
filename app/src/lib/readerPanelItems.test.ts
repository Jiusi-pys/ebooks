import { describe, expect, it } from "vitest";
import type { Highlight } from "@/types";
import { buildCombinedReaderPanelItems } from "./readerPanelItems";

const highlight = (id: string, createdAt: number): Highlight => ({
  id,
  bookId: "book",
  chapterId: "chapter",
  chapterTitle: "章节",
  text: id,
  createdAt,
});

describe("combined reader panel items", () => {
  it("interleaves excerpts, annotations and Q&A in one chronological stream", () => {
    const mark = highlight("mark", 10);
    const note = { ...highlight("note", 20), note: "批注" };
    const qa = {
      ...highlight("qa", 5),
      aiQa: [{ q: "问题", a: "回答", ts: 30 }],
    };

    expect(buildCombinedReaderPanelItems([mark], [note], [qa])).toEqual([
      expect.objectContaining({ kind: "qa", highlight: qa, qaIndex: 0 }),
      expect.objectContaining({ kind: "note", highlight: note }),
      expect.objectContaining({ kind: "mark", highlight: mark }),
    ]);
  });
});
