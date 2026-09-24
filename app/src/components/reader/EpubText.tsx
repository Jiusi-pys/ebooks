import { Fragment, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import type { EpubFootnote } from "@/types";

/** Render text as text; note contents never become HTML or navigation links. */
export function EpubText({
  text,
  notes = [],
  offset = 0,
  dismissSignal,
}: {
  text: string;
  notes?: readonly EpubFootnote[];
  offset?: number;
  /** Incremented by the reader when page navigation starts. */
  dismissSignal?: number;
}) {
  const [openNote, setOpenNote] = useState<{
    key: string;
    signal: number | undefined;
  } | null>(null);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const note of [...notes].sort((a, b) => a.start - b.start)) {
    const start = Math.max(0, note.start - offset);
    const end = Math.min(text.length, note.end - offset);
    if (start < cursor || end <= start || !note.content) continue;
    if (start > cursor) nodes.push(text.slice(cursor, start));
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
              style={{ font: "inherit" }}
              onMouseDown={event => event.stopPropagation()}
              onClick={event => event.stopPropagation()}
            >
              {label}
            </button>
          </Popover.Trigger>
        </sup>
        <Popover.Portal>
          <Popover.Content
            aria-label="书内注释"
            sideOffset={8}
            collisionPadding={12}
            className="z-[100] max-h-[50vh] w-80 max-w-[calc(100vw-24px)] overflow-auto rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg"
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
  nodes.push(text.slice(cursor));
  return (
    <>
      {nodes.map((node, index) => (
        <Fragment key={index}>{node}</Fragment>
      ))}
    </>
  );
}
