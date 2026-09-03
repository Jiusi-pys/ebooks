import { CheckSquare, Plus, StickyNote, Trash2 } from "lucide-react";
import type { Library } from "@/hooks/useLibrary";
import { formatDate } from "@/lib/covers";
import { extractLinks } from "@/lib/links";
import { plainExcerpt } from "@/lib/markdown";
import { BatchAction, BatchBar, SelectDot } from "./BatchBar";
import { useSelection } from "@/hooks/useSelection";

export function NotesView({ lib }: { lib: Library }) {
  const sel = useSelection();

  const batchDelete = () => {
    const n = sel.selected.size;
    if (n === 0) return;
    if (confirm(`确定删除选中的 ${n} 篇笔记？`)) {
      for (const id of sel.selected) {
        void lib.removeNote(id);
      }
      sel.exit();
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-10 pb-24 pt-12">
        <header className="mb-8 flex items-end justify-between border-b border-foreground/15 pb-6">
          <div>
            <div className="font-meta text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
              笔记 · {lib.notes.length} 篇
            </div>
            <h1 className="font-reading mt-2 text-[34px] font-bold tracking-wide">
              笔记
            </h1>
            {lib.notes.length > 0 && !sel.selecting && (
              <button
                onClick={sel.start}
                className="font-meta mt-3 flex items-center gap-1.5 rounded-full border border-foreground/20 px-3 py-1.5 text-[11px] tracking-wider text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
              >
                <CheckSquare size={12} /> 多选
              </button>
            )}
          </div>
          <button
            onClick={async () => {
              const n = await lib.createNote("未命名笔记");
              lib.navigate({ view: "note", noteId: n.id });
            }}
            className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Plus size={15} /> 新建笔记
          </button>
        </header>

        {lib.notes.length === 0 ? (
          <div className="flex flex-col items-center py-20 text-muted-foreground">
            <StickyNote size={28} strokeWidth={1.4} />
            <p className="mt-3 text-sm">还没有笔记。读完一段，记下一句。</p>
          </div>
        ) : (
          <div>
            {lib.notes.map((n, i) => {
              const links = extractLinks(n.content);
              const checked = sel.selected.has(n.id);
              return (
                <button
                  key={n.id}
                  onClick={() =>
                    sel.selecting
                      ? sel.toggle(n.id)
                      : lib.navigate({ view: "note", noteId: n.id })
                  }
                  className={`group flex w-full items-baseline gap-5 border-b border-border/70 px-2 py-4 text-left transition-colors hover:bg-card/70 ${
                    checked ? "bg-accent/50" : ""
                  }`}
                >
                  {sel.selecting ? (
                    <span className="w-8 shrink-0 self-center">
                      <SelectDot checked={checked} />
                    </span>
                  ) : (
                    <span className="font-meta w-8 shrink-0 text-[11px] text-muted-foreground/50">
                      {String(lib.notes.length - i).padStart(2, "0")}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="font-reading block truncate text-[16px] font-semibold group-hover:text-primary">
                      {n.title}
                    </span>
                    <span className="mt-1 block truncate text-[12.5px] text-muted-foreground">
                      {plainExcerpt(n.content) || "（空）"}
                    </span>
                  </span>
                  {links.length > 0 && (
                    <span className="font-meta shrink-0 rounded-full bg-accent/60 px-2 py-0.5 text-[10px] text-accent-foreground">
                      {links.length} 链
                    </span>
                  )}
                  <span className="font-meta shrink-0 text-[10.5px] text-muted-foreground/70">
                    {formatDate(n.updatedAt)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {sel.selecting && (
        <BatchBar
          count={sel.selected.size}
          total={lib.notes.length}
          onSelectAll={() => sel.selectAll(lib.notes.map(n => n.id))}
          onExit={sel.exit}
        >
          <BatchAction
            disabled={sel.selected.size === 0}
            danger
            onClick={batchDelete}
          >
            <Trash2 size={13} /> 删除
          </BatchAction>
        </BatchBar>
      )}
    </div>
  );
}
