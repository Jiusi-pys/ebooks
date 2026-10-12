import { Fragment, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import type { EpubFootnote } from "@/types";
import { EpubImage, type EpubTextImage } from "./EpubImage";

/** Render text as text; note contents never become HTML or navigation links. */
export function EpubText({
  text,
  notes = [],
  offset = 0,
  dismissSignal,
  images = [],
  endOfParagraph = true,
}: {
  text: string;
  notes?: readonly EpubFootnote[];
  offset?: number;
  /** Incremented by the reader when page navigation starts. */
  dismissSignal?: number;
  /** Offsets remain relative to the original full paragraph. */
  images?: readonly EpubTextImage[];
  /** Only the final highlight segment owns images at the right boundary. */
  endOfParagraph?: boolean;
}) {
  const [openNote, setOpenNote] = useState<{
    key: string;
    signal: number | undefined;
  } | null>(null);
  const nodes: ReactNode[] = [];
  const orderedImages = [...images].sort(
    (a, b) => a.offset - b.offset || a.order - b.order
  );
  const renderedImages = new Set<number>();
  const renderText = (start: number, end: number, includeEnd = false) => {
    const parts: ReactNode[] = [];
    let position = start;
    for (const [index, image] of orderedImages.entries()) {
      const at = image.offset - offset;
      if (
        at < start ||
        at > end ||
        (at === end && !includeEnd) ||
        renderedImages.has(index)
      )
        continue;
      if (at > position) parts.push(text.slice(position, at));
      parts.push(
        <EpubImage
          key={`image:${index}`}
          asset={image.asset}
          alt={image.alt}
          inline
        />
      );
      renderedImages.add(index);
      position = at;
    }
    if (position < end) parts.push(text.slice(position, end));
    return parts;
  };
  let cursor = 0;
  for (const note of [...notes].sort((a, b) => a.start - b.start)) {
    const start = Math.max(0, note.start - offset);
    const end = Math.min(text.length, note.end - offset);
    if (start < cursor || end <= start || !note.content) continue;
    // A picture at the marker's boundary precedes the marker; it is not part
    // of the small superscript button or its click target.
    nodes.push(...renderText(cursor, start, true));
    const label = text.slice(start, end);
    nodes.push(
      <Popover.Root
        key={`${note.start}:${note.end}`}
        open={
          openNote?.key === `${note.start}:${note.end}` &&
          openNote.signal === dismissSignal
        }
        onOpenChange={open =>
          setOpenNote(
            open
              ? { key: `${note.start}:${note.end}`, signal: dismissSignal }
              : null
          )
        }
      >
        <sup className="relative -top-[0.5em] align-baseline text-[0.65em] leading-[0]">
          <Popover.Trigger asChild>
            <button
              type="button"
              aria-label={`查看注释 ${label.trim()}`}
              className="cursor-pointer rounded-sm text-primary focus-visible:outline focus-visible:outline-2"
              style={{ font: "inherit", lineHeight: 1 }}
              onMouseDown={event => event.stopPropagation()}
              onClick={event => event.stopPropagation()}
            >
              {renderText(start, end)}
            </button>
          </Popover.Trigger>
        </sup>
        <Popover.Portal>
          <Popover.Content
            aria-label="书内注释"
            sideOffset={8}
            collisionPadding={12}
            className="z-[100] max-h-[50vh] w-80 max-w-[calc(100vw-24px)] overflow-auto overscroll-contain rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg"
            onClick={event => event.stopPropagation()}
            onWheel={event => event.stopPropagation()}
          >
            <div className="mb-2 flex items-center justify-between text-sm font-medium">
              <span>注释</span>
              <Popover.Close
                aria-label="关闭注释"
                className="rounded px-2 py-1"
              >
                ×
              </Popover.Close>
            </div>
            <div className="whitespace-pre-wrap break-words text-sm leading-7">
              {note.content}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
    cursor = end;
  }
  nodes.push(...renderText(cursor, text.length, endOfParagraph));
  return (
    <>
      {nodes.map((node, index) => (
        <Fragment key={index}>{node}</Fragment>
      ))}
    </>
  );
}
