/** Whether a rendered part of a highlight is still covered in recall mode. */
export function isRecallHighlightConcealed(
  recall: boolean,
  revealedHighlightIds: ReadonlySet<string>,
  highlightId: string
): boolean {
  return recall && !revealedHighlightIds.has(highlightId);
}

/**
 * Reveal by highlight id so every rendered part of the same excerpt is shown
 * together after a single click.
 */
export function revealRecallHighlight(
  revealedHighlightIds: Set<string>,
  highlightId: string
): Set<string> {
  if (revealedHighlightIds.has(highlightId)) return revealedHighlightIds;
  return new Set([...revealedHighlightIds, highlightId]);
}
