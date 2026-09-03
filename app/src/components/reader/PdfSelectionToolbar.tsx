import { useEffect, useRef, useState } from "react";
import {
  Copy,
  Highlighter,
  Link2,
  Loader2,
  MessageSquarePlus,
  Quote,
  Type as TypeIcon,
  Underline,
  X,
} from "lucide-react";
import type { HighlightStyle, Note } from "@/types";
import { SWATCH_COLORS } from "@/lib/reading";
import { ExpandableSelectionAction } from "./ExpandableSelectionAction";
import { CitationNotePicker } from "./CitationNotePicker";

type Mode = "menu" | "comment" | "cite";

interface Props {
  top: number;
  left: number;
  onHighlight: (style: HighlightStyle) => Promise<void>;
  onComment: (note: string, name: string) => Promise<void>;
  notes: readonly Note[];
  sourceText: string;
  onCite: (noteId: string | "new") => Promise<void> | void;
  /** Use the current PDF range as endpoint A of a passage association. */
  onAssociate: () => void;
  onCopy: () => Promise<void> | void;
  onClose: () => void;
}

/** PDF selection actions. Operations stay open until persistence succeeds. */
export function PdfSelectionToolbar({
  top,
  left,
  onHighlight,
  onComment,
  notes,
  sourceText,
  onCite,
  onAssociate,
  onCopy,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<Mode>("menu");
  const [note, setNote] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败，请重试");
      setBusy(false);
    }
  };

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
      {SWATCH_COLORS.map(color => (
        <button
          key={color.id}
          type="button"
          title={`${label} · ${color.name}`}
          aria-label={`${label} · ${color.name}`}
          disabled={busy}
          onClick={() => void run(() => onHighlight({ kind, color: color.id }))}
          className="h-[18px] w-[18px] rounded-full border border-black/10 transition-transform hover:scale-125 disabled:opacity-40"
          style={{
            background: kind === "background" ? color.soft : color.solid,
          }}
        />
      ))}
    </div>
  );

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="PDF 划选工具"
      className="float-pop fixed z-50 -translate-x-1/2 rounded-lg border border-border bg-popover shadow-xl"
      style={{
        left:
          typeof window === "undefined"
            ? left
            : Math.max(164, Math.min(window.innerWidth - 164, left)),
        top: Math.max(8, top),
      }}
    >
      {mode === "menu" ? (
        <div className="w-[326px] p-2">
          {styleRow("underline", "下划线", <Underline size={12} />)}
          {styleRow("background", "背景", <Highlighter size={12} />)}
          {styleRow("color", "字色", <TypeIcon size={12} />)}
          <div
            className="mt-1.5 grid grid-cols-3 gap-1 border-t border-border pt-1.5"
            role="toolbar"
            aria-label="PDF 选中文字后的操作"
          >
            <ExpandableSelectionAction
              icon={<MessageSquarePlus size={14} />}
              label="批注"
              disabled={busy}
              onClick={() => setMode("comment")}
              className="w-full text-muted-foreground hover:bg-secondary hover:text-foreground"
            />
            <ExpandableSelectionAction
              icon={<Quote size={14} />}
              label="引用"
              disabled={busy}
              onClick={() => setMode("cite")}
              className="w-full text-muted-foreground hover:bg-secondary hover:text-foreground"
            />
            <ExpandableSelectionAction
              icon={<Link2 size={14} />}
              label="关联"
              disabled={busy}
              onClick={onAssociate}
              className="w-full text-muted-foreground hover:bg-secondary hover:text-foreground"
            />
            <ExpandableSelectionAction
              icon={<Copy size={14} />}
              label="复制"
              disabled={busy}
              onClick={() => void run(async () => onCopy())}
              className="w-full text-muted-foreground hover:bg-secondary hover:text-foreground"
            />
            <ExpandableSelectionAction
              icon={<X size={14} />}
              label="关闭"
              onClick={onClose}
              aria-label="关闭 PDF 划选工具"
              className="w-full text-muted-foreground hover:bg-secondary hover:text-foreground"
            />
          </div>
        </div>
      ) : mode === "comment" ? (
        <div className="w-[300px] p-3">
          <div className="font-meta mb-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            为 PDF 原文写批注
          </div>
          <input
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder="批注名称（可选）"
            className="mb-2 h-7 w-full rounded-md border border-border bg-card px-2 text-[12px] outline-none focus:border-primary/60"
          />
          <textarea
            autoFocus
            value={note}
            onChange={event => setNote(event.target.value)}
            onKeyDown={event => {
              if (
                event.key === "Enter" &&
                (event.metaKey || event.ctrlKey) &&
                note.trim()
              ) {
                void run(() => onComment(note.trim(), name.trim()));
              }
            }}
            placeholder="想法、疑问、感悟……"
            className="h-20 w-full resize-none rounded-md border border-border bg-card p-2 text-[13px] leading-6 outline-none focus:border-primary/60"
          />
          {error && (
            <p className="mt-1 text-[11px] text-destructive">{error}</p>
          )}
          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => setMode("menu")}
              className="rounded-md px-2.5 py-1 text-[12px] text-muted-foreground hover:bg-secondary disabled:opacity-40"
            >
              返回
            </button>
            <button
              type="button"
              disabled={busy || !note.trim()}
              onClick={() =>
                void run(() => onComment(note.trim(), name.trim()))
              }
              className="flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-[12px] font-medium text-primary-foreground disabled:opacity-40"
            >
              {busy && <Loader2 size={12} className="animate-spin" />}
              保存批注
            </button>
          </div>
        </div>
      ) : (
        <CitationNotePicker
          notes={notes}
          sourceText={sourceText}
          onSelect={onCite}
          onClose={() => setMode("menu")}
        />
      )}
      {mode === "menu" && error && (
        <p className="border-t border-border px-3 py-1.5 text-[11px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
