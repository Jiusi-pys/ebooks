export function pdfSelectionPage(range: Range): HTMLElement | null {
  const page = (node: Node): HTMLElement | null =>
    (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)
      ?.closest<HTMLElement>(".pdf-page") ?? null;
  const first = page(range.startContainer);
  return first && first === page(range.endContainer) ? first : null;
}
