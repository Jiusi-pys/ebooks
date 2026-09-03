import type { Book, OutlineItem } from "@/types";

export const MAX_OUTLINE_DEPTH = 3;

export function getBookOutline(book: Book): OutlineItem[] {
  return (
    book.outline ??
    book.chapters.map(chapter => ({
      id: `chapter:${chapter.id}`,
      title: chapter.title,
      chapterId: chapter.id,
      depth: 0,
    }))
  ).map(item => ({ ...item }));
}

/**
 * Imported chapter entries use a deterministic id. Everything else in the
 * editable outline was created by the reader and may be removed.
 */
export function isUserOutlineItem(book: Book, item: OutlineItem): boolean {
  return !book.chapters.some(chapter => item.id === `chapter:${chapter.id}`);
}

function subtreeEnd(items: OutlineItem[], index: number) {
  const depth = items[index].depth;
  let end = index + 1;
  while (end < items.length && items[end].depth > depth) end += 1;
  return end;
}

export function renameOutlineItem(
  items: OutlineItem[],
  id: string,
  title: string
): OutlineItem[] {
  const nextTitle = title.trim();
  if (!nextTitle) return items;
  return items.map(item =>
    item.id === id ? { ...item, title: nextTitle } : item
  );
}

export function removeOutlineItem(
  items: OutlineItem[],
  id: string
): OutlineItem[] {
  const index = items.findIndex(item => item.id === id);
  if (index < 0) return items;
  const end = subtreeEnd(items, index);
  return items
    .filter((_, itemIndex) => itemIndex !== index)
    .map((item, itemIndex) =>
      itemIndex >= index && itemIndex < end - 1
        ? { ...item, depth: Math.max(0, item.depth - 1) }
        : item
    );
}

/**
 * Remove only a reader-created entry. Children are promoted one level instead
 * of being discarded, so their chapter/paragraph navigation anchors survive.
 */
export function removeUserOutlineItem(
  book: Book,
  items: OutlineItem[],
  id: string
): OutlineItem[] {
  const item = items.find(candidate => candidate.id === id);
  if (!item || !isUserOutlineItem(book, item)) return items;
  return removeOutlineItem(items, id);
}

export function changeOutlineDepth(
  items: OutlineItem[],
  id: string,
  delta: -1 | 1
): OutlineItem[] {
  const index = items.findIndex(item => item.id === id);
  if (index < 0) return items;
  const current = items[index];
  if (delta < 0 && current.depth === 0) return items;
  if (delta > 0) {
    if (current.depth >= MAX_OUTLINE_DEPTH || index === 0) return items;
    let previous = index - 1;
    while (previous >= 0 && items[previous].depth > current.depth)
      previous -= 1;
    if (previous < 0 || items[previous].depth !== current.depth) return items;
  }
  const end = subtreeEnd(items, index);
  return items.map((item, itemIndex) =>
    itemIndex >= index && itemIndex < end
      ? { ...item, depth: item.depth + delta }
      : item
  );
}

export function moveOutlineItem(
  items: OutlineItem[],
  id: string,
  direction: -1 | 1
): OutlineItem[] {
  const index = items.findIndex(item => item.id === id);
  if (index < 0) return items;
  const depth = items[index].depth;
  const end = subtreeEnd(items, index);
  const block = items.slice(index, end);

  if (direction < 0) {
    let previous = index - 1;
    while (previous >= 0 && items[previous].depth > depth) previous -= 1;
    if (previous < 0 || items[previous].depth !== depth) return items;
    return [
      ...items.slice(0, previous),
      ...block,
      ...items.slice(previous, index),
      ...items.slice(end),
    ];
  }

  let next = end;
  while (next < items.length && items[next].depth > depth) next += 1;
  if (next >= items.length || items[next].depth !== depth) return items;
  const nextEnd = subtreeEnd(items, next);
  return [
    ...items.slice(0, index),
    ...items.slice(next, nextEnd),
    ...block,
    ...items.slice(nextEnd),
  ];
}

export function addOutlineTarget(
  items: OutlineItem[],
  target: Omit<OutlineItem, "depth">
): OutlineItem[] {
  const chapterIndex = items.findIndex(
    item => item.chapterId === target.chapterId && item.paraIndex === undefined
  );
  if (chapterIndex < 0) return [...items, { ...target, depth: 0 }];
  const insertAt = subtreeEnd(items, chapterIndex);
  const depth = Math.min(MAX_OUTLINE_DEPTH, items[chapterIndex].depth + 1);
  return [
    ...items.slice(0, insertAt),
    { ...target, depth },
    ...items.slice(insertAt),
  ];
}

export function outlineTitle(text: string, maxLength = 36): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxLength
    ? `${compact.slice(0, maxLength)}…`
    : compact;
}
