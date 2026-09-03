import { COVER_TONES } from "@/lib/covers";
import type { Book } from "@/types";

/** 书封：有图用图，无图用确定性布面配色 + 竖排题签 */
export function BookCover({
  book,
  className = "",
  textClass = "text-lg",
}: {
  book: Book;
  className?: string;
  textClass?: string;
}) {
  const image = book.customCover || book.cover;
  if (image) {
    return (
      <div
        className={`overflow-hidden rounded-[3px] shadow-[0_10px_24px_-10px_rgba(62,49,32,0.45)] ${className}`}
      >
        <img
          src={image}
          alt={book.title}
          className="h-full w-full object-cover"
          draggable={false}
        />
      </div>
    );
  }
  const tone = COVER_TONES[book.coverTone % COVER_TONES.length];
  return (
    <div
      className={`relative rounded-[3px] shadow-[0_10px_24px_-10px_rgba(62,49,32,0.45)] ${className}`}
      style={{ background: tone.bg }}
    >
      {/* 书脊 */}
      <div
        className="absolute inset-y-0 left-0 w-[7%]"
        style={{ background: "rgba(0,0,0,0.22)" }}
      />
      {/* 题签 */}
      <div
        className="absolute right-[10%] top-[9%] flex max-h-[82%] flex-col items-center px-1.5 py-2"
        style={{ background: tone.fg, boxShadow: "0 1px 3px rgba(0,0,0,0.25)" }}
      >
        <span
          className={`font-reading font-semibold leading-snug ${textClass}`}
          style={{
            color: tone.bg,
            writingMode: "vertical-rl",
            letterSpacing: "0.12em",
          }}
        >
          {book.title.slice(0, 9)}
        </span>
      </div>
      <div
        className="absolute bottom-[8%] left-[16%] right-[12%] h-px"
        style={{ background: tone.band, opacity: 0.7 }}
      />
    </div>
  );
}
