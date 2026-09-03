import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  CornerUpLeft,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type { Book, OutlineItem, ReaderTheme } from "@/types";
import {
  changeOutlineDepth,
  getBookOutline,
  isUserOutlineItem,
  moveOutlineItem,
  removeUserOutlineItem,
  renameOutlineItem,
} from "@/lib/outline";

interface Props {
  book: Book;
  activeChapterId: string;
  theme: ReaderTheme;
  onNavigate: (item: OutlineItem) => void;
  onChange: (outline: OutlineItem[]) => void;
}

export function OutlinePanel({
  book,
  activeChapterId,
  theme,
  onNavigate,
  onChange,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [activeItem, setActiveItem] = useState<{
    bookId: string;
    itemId: string;
  } | null>(null);
  const outline = getBookOutline(book);
  const selectedItem =
    activeItem?.bookId === book.id
      ? outline.find(candidate => candidate.id === activeItem.itemId)
      : undefined;
  const activeItemId =
    selectedItem?.chapterId === activeChapterId ? selectedItem.id : null;

  const update = (next: OutlineItem[]) => onChange(next);
  const addGroup = () => {
    update([
      ...outline,
      {
        id: `outline:${crypto.randomUUID()}`,
        title: "新分组",
        depth: 0,
      },
    ]);
  };

  const removeItem = (id: string) => {
    const next = removeUserOutlineItem(book, outline, id);
    if (next === outline) return;
    setActiveItem(current => (current?.itemId === id ? null : current));
    update(next);
  };

  return (
    <div
      className="flex w-64 shrink-0 flex-col border-r"
      style={{ background: theme.panel, borderColor: theme.border }}
    >
      <div
        className="flex items-center justify-between gap-2 border-b px-3 py-2.5"
        style={{ borderColor: theme.border }}
      >
        <div>
          <div
            className="font-meta text-[10px] uppercase tracking-[0.16em]"
            style={{ color: theme.muted }}
          >
            导航目录 · {outline.length} 项
          </div>
          <div className="mt-0.5 text-[10px]" style={{ color: theme.muted }}>
            章节、分组与正文锚点
          </div>
        </div>
        <button
          type="button"
          onClick={() => setEditing(value => !value)}
          className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] ${
            editing
              ? "bg-primary text-primary-foreground"
              : "hover:bg-secondary"
          }`}
          title={editing ? "完成目录编辑" : "编辑目录结构"}
        >
          <Pencil size={11} /> {editing ? "完成" : "编辑"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {outline.map((item, index) => {
          const userCreated = isUserOutlineItem(book, item);
          const active = activeItemId
            ? item.id === activeItemId
            : item.chapterId === activeChapterId &&
              item.paraIndex === undefined;
          return (
            <div
              key={item.id}
              className="group flex min-h-8 items-center gap-1 pr-1"
              style={{
                paddingLeft: 8 + item.depth * 16,
                background: active ? theme.selection : undefined,
              }}
            >
              {editing ? (
                <>
                  <input
                    key={`${item.id}:${item.title}`}
                    defaultValue={item.title}
                    onBlur={event =>
                      update(
                        renameOutlineItem(
                          outline,
                          item.id,
                          event.currentTarget.value
                        )
                      )
                    }
                    onKeyDown={event => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                    className="h-6 min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 text-[12px] outline-none focus:border-primary/50 focus:bg-card"
                    aria-label={`目录标题：${item.title}`}
                  />
                  <div className="flex shrink-0 items-center">
                    <IconButton
                      label="上移"
                      disabled={index === 0}
                      onClick={() =>
                        update(moveOutlineItem(outline, item.id, -1))
                      }
                    >
                      <ChevronUp size={12} />
                    </IconButton>
                    <IconButton
                      label="下移"
                      disabled={index === outline.length - 1}
                      onClick={() =>
                        update(moveOutlineItem(outline, item.id, 1))
                      }
                    >
                      <ChevronDown size={12} />
                    </IconButton>
                    <IconButton
                      label="增加缩进"
                      onClick={() =>
                        update(changeOutlineDepth(outline, item.id, 1))
                      }
                    >
                      <CornerDownLeft size={11} />
                    </IconButton>
                    <IconButton
                      label="减少缩进"
                      disabled={item.depth === 0}
                      onClick={() =>
                        update(changeOutlineDepth(outline, item.id, -1))
                      }
                    >
                      <CornerUpLeft size={11} />
                    </IconButton>
                    <IconButton
                      label={
                        userCreated ? "删除自定义目录项" : "原书目录不可删除"
                      }
                      disabled={!userCreated}
                      preventInputBlur={userCreated}
                      onClick={() => removeItem(item.id)}
                    >
                      <Trash2 size={11} />
                    </IconButton>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  disabled={!item.chapterId}
                  onClick={() => {
                    setActiveItem({ bookId: book.id, itemId: item.id });
                    onNavigate(item);
                  }}
                  className={`min-w-0 flex-1 truncate px-1 py-[7px] text-left text-[13px] ${
                    item.chapterId
                      ? "hover:text-foreground"
                      : "cursor-default font-semibold"
                  }`}
                  style={{ color: active ? theme.text : theme.muted }}
                  title={item.chapterId ? `跳转到：${item.title}` : item.title}
                >
                  {item.paraIndex !== undefined && (
                    <span className="mr-1.5 text-[10px] opacity-55">↳</span>
                  )}
                  {item.title}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {editing && (
        <button
          type="button"
          onClick={addGroup}
          className="m-2 flex items-center justify-center gap-1 rounded-md border py-1.5 text-[11px] hover:bg-secondary"
          style={{ borderColor: theme.border, color: theme.muted }}
        >
          <Plus size={12} /> 添加分组
        </button>
      )}
    </div>
  );
}

function IconButton({
  label,
  disabled,
  preventInputBlur,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  preventInputBlur?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onPointerDown={event => {
        if (preventInputBlur) event.preventDefault();
      }}
      onClick={onClick}
      className="rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-20"
    >
      {children}
    </button>
  );
}
