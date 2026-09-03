import type { SplitTarget } from "@/components/reader/SplitPane";

export type SplitDirection = "horizontal" | "vertical";

export type ReaderPane =
  | { kind: "main"; id: "main" }
  | { kind: "reference"; id: string; target: SplitTarget }
  | {
      kind: "split";
      id: string;
      direction: SplitDirection;
      first: ReaderPane;
      second: ReaderPane;
    };

export const MAIN_READER_PANE: ReaderPane = { kind: "main", id: "main" };

const uid = (prefix: string) =>
  `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;

export function countReaderPanes(node: ReaderPane): number {
  return node.kind === "split"
    ? countReaderPanes(node.first) + countReaderPanes(node.second)
    : 1;
}

export function splitReaderPane(
  node: ReaderPane,
  paneId: string,
  direction: SplitDirection,
  target: SplitTarget,
  referenceId = uid("reference"),
  splitId = uid("split")
): ReaderPane {
  if (countReaderPanes(node) >= 4) return node;
  if (node.kind !== "split") {
    return node.id === paneId
      ? {
          kind: "split",
          id: splitId,
          direction,
          first: node,
          second: { kind: "reference", id: referenceId, target },
        }
      : node;
  }

  const first = splitReaderPane(
    node.first,
    paneId,
    direction,
    target,
    referenceId,
    splitId
  );
  if (first !== node.first) return { ...node, first };
  const second = splitReaderPane(
    node.second,
    paneId,
    direction,
    target,
    referenceId,
    splitId
  );
  return second === node.second ? node : { ...node, second };
}

export function updateReferencePane(
  node: ReaderPane,
  paneId: string,
  target: SplitTarget
): ReaderPane {
  if (node.kind === "reference") {
    return node.id === paneId ? { ...node, target } : node;
  }
  if (node.kind === "main") return node;
  return {
    ...node,
    first: updateReferencePane(node.first, paneId, target),
    second: updateReferencePane(node.second, paneId, target),
  };
}

/** Close a reference leaf and promote its sibling into the removed branch. */
export function closeReferencePane(
  node: ReaderPane,
  paneId: string
): ReaderPane {
  if (node.kind !== "split") return node;
  if (node.first.kind === "reference" && node.first.id === paneId) {
    return node.second;
  }
  if (node.second.kind === "reference" && node.second.id === paneId) {
    return node.first;
  }
  const first = closeReferencePane(node.first, paneId);
  if (first !== node.first) return { ...node, first };
  const second = closeReferencePane(node.second, paneId);
  return second === node.second ? node : { ...node, second };
}
