import type { Highlight } from "@/types";

export type CombinedReaderPanelItem =
  | { kind: "mark"; highlight: Highlight; sortAt: number }
  | { kind: "note"; highlight: Highlight; sortAt: number }
  | {
      kind: "qa";
      highlight: Highlight;
      qaIndex: number;
      sortAt: number;
    };

/** Build one chronological feed while preserving every content type. */
export function buildCombinedReaderPanelItems(
  marks: Highlight[],
  notes: Highlight[],
  qaHighlights: Highlight[]
): CombinedReaderPanelItem[] {
  const items: CombinedReaderPanelItem[] = [
    ...marks.map(highlight => ({
      kind: "mark" as const,
      highlight,
      sortAt: highlight.createdAt,
    })),
    ...notes.map(highlight => ({
      kind: "note" as const,
      highlight,
      sortAt: highlight.createdAt,
    })),
    ...qaHighlights.flatMap(highlight =>
      (highlight.aiQa ?? []).map((qa, qaIndex) => ({
        kind: "qa" as const,
        highlight,
        qaIndex,
        sortAt: qa.ts ?? highlight.createdAt,
      }))
    ),
  ];
  return items.sort((left, right) => right.sortAt - left.sortAt);
}
