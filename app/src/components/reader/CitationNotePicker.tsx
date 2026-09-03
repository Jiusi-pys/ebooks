import { useState } from "react";
import { Loader2, Quote } from "lucide-react";
import type { Note } from "@/types";

interface Props {
  notes: readonly Note[];
  sourceText: string;
  onSelect: (noteId: string | "new") => Promise<void> | void;
  onClose: () => void;
  embedded?: boolean;
}

/** Pick the destination note for the passage that is already selected. */
export function CitationNotePicker({
  notes,
  sourceText,
  onSelect,
  onClose,
  embedded = false,
}: Props) {
  const [noteId, setNoteId] = useState<string>("new");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await onSelect(noteId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "引用失败，请重试");
      setBusy(false);
    }
  };

  return (
    <div
      className={embedded ? "w-full pt-2" : "w-[300px] p-3"}
      role="group"
      aria-label="引用到笔记"
    >
      <div className="font-meta flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        <Quote size={12} /> 引用当前选中文段
      </div>
      <p className="font-reading mt-2 line-clamp-3 rounded-md bg-secondary/50 px-2.5 py-2 text-[12px] leading-5 text-muted-foreground">
        「{sourceText}」
      </p>
      <label className="font-meta mt-2.5 block text-[10px] uppercase tracking-wider text-muted-foreground">
        目标笔记
        <select
          value={noteId}
          disabled={busy}
          onChange={event => setNoteId(event.target.value)}
          className="mt-1.5 h-8 w-full rounded-md border border-border bg-card px-2 text-[12px] normal-case tracking-normal text-foreground outline-none focus:border-primary/60 disabled:opacity-50"
        >
          <option value="new">＋ 新建书摘笔记</option>
          {notes.map(note => (
            <option key={note.id} value={note.id}>
              {note.title}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="mt-1.5 text-[11px] text-destructive">{error}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className="rounded-md px-2.5 py-1 text-[12px] text-muted-foreground hover:bg-secondary disabled:opacity-50"
        >
          返回
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-[12px] font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy && <Loader2 size={12} className="animate-spin" />}
          确认引用
        </button>
      </div>
    </div>
  );
}
