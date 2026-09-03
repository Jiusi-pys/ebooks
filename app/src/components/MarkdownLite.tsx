import { useMemo, type ReactNode } from "react";

interface Props {
  content: string;
  /** 已存在的链接目标（书名/笔记名，小写） */
  existingTitles: Set<string>;
  onOpenTitle: (title: string) => void;
  compact?: boolean;
}

/** 渲染行内元素：**粗体** 与 [[双链]] */
function renderInline(
  text: string,
  existingTitles: Set<string>,
  onOpenTitle: (t: string) => void
): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\[\[[^\]\n]{1,60}\]\]|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("[[")) {
      const target = tok.slice(2, -2).trim();
      const exists = existingTitles.has(target.toLowerCase());
      out.push(
        <a
          key={k++}
          className={`wikilink${exists ? "" : " wikilink-missing"}`}
          onClick={e => {
            e.stopPropagation();
            onOpenTitle(target);
          }}
          title={exists ? `打开「${target}」` : `创建笔记「${target}」`}
        >
          {target}
        </a>
      );
    } else {
      out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MarkdownLite({
  content,
  existingTitles,
  onOpenTitle,
  compact,
}: Props) {
  const blocks = useMemo(() => {
    const lines = content.split("\n");
    const out: ReactNode[] = [];
    let list: { ordered: boolean; items: string[] } | null = null;
    const flushList = (key: number) => {
      if (!list) return;
      const items = list.items.map((it, i) => (
        <li key={i}>{renderInline(it, existingTitles, onOpenTitle)}</li>
      ));
      out.push(
        list.ordered ? (
          <ol key={`l${key}`}>{items}</ol>
        ) : (
          <ul key={`l${key}`}>{items}</ul>
        )
      );
      list = null;
    };
    lines.forEach((raw, i) => {
      const line = raw.trimEnd();
      const ul = /^\s*[-•]\s+(.*)$/.exec(line);
      const ol = /^\s*\d+[.、)]\s+(.*)$/.exec(line);
      if (ul || ol) {
        const ordered = !!ol;
        const text = (ul?.[1] ?? ol?.[1]) as string;
        if (!list || list.ordered !== ordered) {
          flushList(i);
          list = { ordered, items: [] };
        }
        list.items.push(text);
        return;
      }
      flushList(i);
      if (!line.trim()) return;
      if (line.startsWith("## ")) {
        out.push(
          <h2 key={i}>
            {renderInline(line.slice(3), existingTitles, onOpenTitle)}
          </h2>
        );
      } else if (line.startsWith("# ")) {
        out.push(
          <h1 key={i}>
            {renderInline(line.slice(2), existingTitles, onOpenTitle)}
          </h1>
        );
      } else if (line.startsWith("> ")) {
        out.push(
          <blockquote key={i}>
            {renderInline(line.slice(2), existingTitles, onOpenTitle)}
          </blockquote>
        );
      } else {
        out.push(
          <p key={i}>{renderInline(line, existingTitles, onOpenTitle)}</p>
        );
      }
    });
    flushList(lines.length);
    return out;
  }, [content, existingTitles, onOpenTitle]);

  if (compact) {
    return (
      <div className="note-render text-sm leading-7 line-clamp-6 overflow-hidden">
        {blocks}
      </div>
    );
  }
  return <div className="note-render">{blocks}</div>;
}
