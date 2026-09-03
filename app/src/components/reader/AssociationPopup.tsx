import { useMemo, useState } from "react";
import {
  ArrowLeftRight,
  ArrowRight,
  ExternalLink,
  Link2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type { Association, Book, PassageAnchor } from "@/types";
import { passageAnchorKey } from "@/lib/associations";

interface Props {
  top: number;
  left: number;
  current: PassageAnchor;
  associations: readonly Association[];
  books: readonly Book[];
  onNavigate: (anchor: PassageAnchor) => void;
  onDelete: (associationId: string) => void | Promise<void>;
  onAdd: () => void;
  onClose: () => void;
  position?: "absolute" | "fixed";
}

/**
 * MarginNote-style relation card: the current passage keeps a compact list of
 * its peers. A single click previews the full peer passage; double-click or
 * the explicit jump button navigates to its exact source anchor.
 */
export function AssociationPopup({
  top,
  left,
  current,
  associations,
  books,
  onNavigate,
  onDelete,
  onAdd,
  onClose,
  position = "absolute",
}: Props) {
  const currentKey = passageAnchorKey(current);
  const related = useMemo(
    () =>
      associations
        .flatMap(association => {
          const sourceKey = passageAnchorKey(association.source);
          const targetKey = passageAnchorKey(association.target);
          if (sourceKey === currentKey)
            return [{ association, peer: association.target, outgoing: true }];
          if (targetKey === currentKey)
            return [{ association, peer: association.source, outgoing: false }];
          return [];
        })
        .sort(
          (left, right) =>
            right.association.updatedAt - left.association.updatedAt ||
            left.association.id.localeCompare(right.association.id)
        ),
    [associations, currentKey]
  );
  const [previewId, setPreviewId] = useState<string | null>(
    related[0]?.association.id ?? null
  );

  return (
    <section
      role="dialog"
      aria-label="管理文段关联"
      className={`float-pop ${position} z-[70] w-[340px] -translate-x-1/2 rounded-lg border border-border bg-popover p-3 shadow-xl`}
      style={{ top, left }}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-meta flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] text-primary">
            <Link2 size={11} /> 关联 · {related.length}
          </div>
          <p className="font-reading mt-1 line-clamp-2 text-[11.5px] leading-5 text-muted-foreground">
            「{current.text}」
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
          aria-label="关闭关联面板"
        >
          <X size={14} />
        </button>
      </div>

      <div className="mt-2 max-h-64 space-y-1.5 overflow-y-auto pr-0.5">
        {related.length === 0 ? (
          <p className="rounded-md bg-secondary/50 px-2.5 py-3 text-center text-[11.5px] text-muted-foreground">
            这段内容还没有关联
          </p>
        ) : (
          related.map(({ association, peer, outgoing }) => {
            const bookTitle =
              books.find(book => book.id === peer.bookId)?.title ?? "未知书籍";
            const expanded = previewId === association.id;
            const direction =
              association.direction === "bidirectional"
                ? "双向"
                : outgoing
                  ? "指向"
                  : "来自";
            return (
              <article
                key={association.id}
                data-association-id={association.id}
                className="rounded-md border border-border bg-card p-2"
              >
                <button
                  type="button"
                  onClick={() => setPreviewId(expanded ? null : association.id)}
                  onDoubleClick={() => onNavigate(peer)}
                  className="block w-full text-left"
                  aria-expanded={expanded}
                  aria-label={`预览关联：${bookTitle}，${peer.chapterTitle}`}
                >
                  <span className="font-meta flex items-center gap-1 text-[9.5px] uppercase tracking-wide text-primary">
                    {association.direction === "bidirectional" ? (
                      <ArrowLeftRight size={10} />
                    ) : (
                      <ArrowRight
                        size={10}
                        className={outgoing ? undefined : "rotate-180"}
                      />
                    )}
                    {direction} · {bookTitle} · {peer.chapterTitle}
                  </span>
                  <span
                    className={`font-reading mt-1 block text-[12px] leading-5 ${
                      expanded ? "" : "line-clamp-2"
                    }`}
                  >
                    {peer.text}
                  </span>
                  {association.label && (
                    <span className="mt-1 block rounded bg-accent/40 px-1.5 py-1 text-[10.5px] text-muted-foreground">
                      {association.label}
                    </span>
                  )}
                </button>
                {expanded && (
                  <div className="mt-1.5 flex justify-end gap-1 border-t border-border pt-1.5">
                    <button
                      type="button"
                      onClick={() => onNavigate(peer)}
                      className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10.5px] text-primary hover:bg-primary/10"
                      aria-label={`跳转到 ${bookTitle} ${peer.chapterTitle}`}
                    >
                      <ExternalLink size={10} /> 跳转
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDelete(association.id)}
                      className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10.5px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label={`删除与 ${bookTitle} ${peer.chapterTitle} 的关联`}
                    >
                      <Trash2 size={10} /> 删除关联
                    </button>
                  </div>
                )}
              </article>
            );
          })
        )}
      </div>

      <button
        type="button"
        onClick={onAdd}
        className="mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-primary/40 py-1.5 text-[11.5px] text-primary hover:bg-primary/10"
      >
        <Plus size={11} /> 新建关联
      </button>
    </section>
  );
}
