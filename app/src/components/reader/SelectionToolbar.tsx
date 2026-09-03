import { useEffect, useRef, useState } from "react";
import {
  Languages,
  ListPlus,
  MessageSquarePlus,
  Quote,
  Sparkles,
  Underline,
  Highlighter,
  Type as TypeIcon,
} from "lucide-react";
import type { HighlightStyle } from "@/types";
import { SWATCH_COLORS } from "@/lib/reading";

type Mode = "menu" | "comment";

interface Props {
  top: number;
  left: number;
  onHighlight: (style: HighlightStyle) => void;
  onComment: (text: string, name: string) => void;
  /** 打开三级引用浏览器（书 → 章节 → 文段） */
  onOpenCiteBrowser: () => void;
  /** 打开划选即时翻译气泡 */
  onTranslate: () => void;
  /** 把当前选区作为段落级锚点加入自定义目录。 */
  onAddToOutline: () => void;
  onAskAi: () => void;
  onClose: () => void;
}

/** 划选浮动工具条：划线样式 / 批注（可命名）/ 引用 / 问AI */
export function SelectionToolbar({
  top,
  left,
  onHighlight,
  onComment,
  onOpenCiteBrowser,
  onTranslate,
  onAddToOutline,
  onAskAi,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>("menu");
  const [comment, setComment] = useState("");
  const [name, setName] = useState("");

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const styleRow = (
    kind: HighlightStyle["kind"],
    label: string,
    icon: React.ReactNode
  ) => (
    <div className="flex items-center gap-2 px-1 py-1">
      <span className="flex w-14 items-center gap-1 text-[11px] text-muted-foreground">
        {icon}
        {label}
      </span>
      {SWATCH_COLORS.map(c => (
        <button
          key={c.id}
          title={c.name}
          onClick={() => onHighlight({ kind, color: c.id })}
          className="h-4.5 w-4.5 rounded-full border border-black/10 transition-transform hover:scale-125"
          style={{
            width: 18,
            height: 18,
            background: kind === "background" ? c.soft : c.solid,
          }}
        />
      ))}
    </div>
  );

  return (
    <div
      ref={ref}
      className="float-pop absolute z-40 -translate-x-1/2 rounded-lg border border-border bg-popover"
      style={{ top, left }}
    >
      {mode === "menu" && (
        <div className="w-[304px] p-2">
          {styleRow("underline", "下划线", <Underline size={12} />)}
          {styleRow("background", "背景", <Highlighter size={12} />)}
          {styleRow("color", "字色", <TypeIcon size={12} />)}
          <div className="mt-1.5 flex border-t border-border pt-1.5">
            <button
              onClick={() => setMode("comment")}
              className="flex flex-1 items-center justify-center gap-1 rounded-md py-1.5 text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <MessageSquarePlus size={13} /> 批注
            </button>
            <button
              onClick={() => {
                onClose();
                onOpenCiteBrowser();
              }}
              className="flex flex-1 items-center justify-center gap-1 rounded-md py-1.5 text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <Quote size={13} /> 引用
            </button>
            <button
              onClick={onTranslate}
              className="flex flex-1 items-center justify-center gap-1 rounded-md py-1.5 text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <Languages size={13} /> 翻译
            </button>
            <button
              onClick={onAddToOutline}
              className="flex flex-1 items-center justify-center gap-1 rounded-md py-1.5 text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <ListPlus size={13} /> 目录
            </button>
            <button
              onClick={onAskAi}
              className="flex flex-1 items-center justify-center gap-1 rounded-md py-1.5 text-[12px] font-medium text-primary hover:bg-accent/40"
            >
              <Sparkles size={13} /> 问 AI
            </button>
          </div>
        </div>
      )}

      {mode === "comment" && (
        <div className="w-[280px] p-3">
          <div className="font-meta mb-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            为这段文字写批注
          </div>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="批注名称（可选，便于引用时辨认）"
            className="mb-2 h-7 w-full rounded-md border border-border bg-card px-2 text-[12px] outline-none focus:border-primary/60"
          />
          <textarea
            autoFocus
            value={comment}
            onChange={e => setComment(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                onComment(comment.trim(), name.trim());
              }
            }}
            placeholder="想法、疑问、感悟……"
            className="h-20 w-full resize-none rounded-md border border-border bg-card p-2 text-[13px] leading-6 outline-none focus:border-primary/60"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              onClick={() => setMode("menu")}
              className="rounded-md px-2.5 py-1 text-[12px] text-muted-foreground hover:bg-secondary"
            >
              返回
            </button>
            <button
              onClick={() => onComment(comment.trim(), name.trim())}
              disabled={!comment.trim()}
              className="rounded-full bg-primary px-3 py-1 text-[12px] font-medium text-primary-foreground disabled:opacity-40"
            >
              保存批注 ⌘↵
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
