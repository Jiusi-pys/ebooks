/** Build a compact plain-text preview from the supported Markdown subset. */
export function plainExcerpt(content: string, max = 90): string {
  const text = content
    .replace(/^#+\s+/gm, "")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
