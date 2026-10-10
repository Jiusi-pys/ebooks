// Derived data is usable only while its text anchors match the stored book.
export function matchingChapter(chapter, rendition) {
  const candidate = rendition?.version === 1 && rendition.chapters?.find(c => c.id === chapter.id);
  return candidate && JSON.stringify(candidate.paragraphs) === JSON.stringify(chapter.paragraphs) ? candidate : null;
}
export function localImage(value) {
  return typeof value === "string" && value.length <= 12 * 1024 * 1024 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value);
}
