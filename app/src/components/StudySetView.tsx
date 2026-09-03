import { useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  Check,
  GitBranch,
  GraduationCap,
  Layers,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import type { Library } from "@/hooks/useLibrary";
import type { StudySet } from "@/types";
import { countNodes } from "@/lib/mind";
import { formatDate } from "@/lib/covers";

/** 学习集是跨文件夹的逻辑集合；同一本书可以同时加入多个学习集。 */
export function StudySetView({ lib }: { lib: Library }) {
  const setId = lib.route.studySetId;
  const studySet = lib.studySets.find(set => set.id === setId);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [now] = useState(Date.now);

  if (setId && studySet) {
    return (
      <StudySetDetail
        key={studySet.id}
        lib={lib}
        studySet={studySet}
        now={now}
      />
    );
  }

  const create = async () => {
    if (!newName.trim()) return;
    const created = await lib.createStudySet(newName);
    setNewName("");
    setCreating(false);
    lib.navigate({ view: "studyset", studySetId: created.id });
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-10 pb-24 pt-12">
        <header className="mb-8 border-b border-foreground/15 pb-6">
          <div className="font-meta text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            学习集 · {lib.studySets.length} 个
          </div>
          <div className="mt-2 flex items-center justify-between gap-4">
            <h1 className="font-reading text-[34px] font-bold tracking-wide">
              学习集
            </h1>
            <button
              onClick={() => setCreating(true)}
              className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-[12.5px] font-medium text-primary-foreground"
            >
              <Plus size={14} /> 新建学习集
            </button>
          </div>
          <p className="font-meta mt-2 max-w-2xl text-[11.5px] leading-5 text-muted-foreground">
            按主题、课程或研究目标组织书籍。学习集独立于书架文件夹，同一本书可以加入多个学习集。
          </p>
        </header>

        {creating && (
          <div className="mb-6 flex items-center gap-2 rounded-lg border border-border bg-card p-3 shadow-sm">
            <input
              autoFocus
              value={newName}
              onChange={event => setNewName(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter") void create();
                if (event.key === "Escape") setCreating(false);
              }}
              placeholder="例如：认知科学研究"
              className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary"
            />
            <button
              onClick={() => void create()}
              disabled={!newName.trim()}
              className="rounded-full bg-primary px-4 py-2 text-xs text-primary-foreground disabled:opacity-40"
            >
              创建
            </button>
            <button
              onClick={() => {
                setCreating(false);
                setNewName("");
              }}
              className="rounded-md p-2 text-muted-foreground hover:bg-secondary"
              title="取消"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {lib.studySets.length === 0 ? (
          <div className="flex flex-col items-center py-20 text-muted-foreground">
            <Layers size={28} strokeWidth={1.4} />
            <p className="mt-3 text-sm">
              还没有学习集。新建一个主题，然后选择需要共同学习的书籍。
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {lib.studySets.map(set => {
              const stats = setStats(lib, set, now);
              return (
                <button
                  key={set.id}
                  onClick={() =>
                    lib.navigate({ view: "studyset", studySetId: set.id })
                  }
                  className="rounded-lg bg-card p-5 text-left shadow-sm transition-shadow hover:shadow-md"
                >
                  <div className="flex items-center gap-2">
                    <Layers size={15} className="text-primary" />
                    <span className="font-reading text-[16px] font-semibold">
                      {set.name}
                    </span>
                  </div>
                  {set.description && (
                    <p className="mt-2 line-clamp-2 text-[12px] leading-5 text-muted-foreground">
                      {set.description}
                    </p>
                  )}
                  <div className="font-meta mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                    <span>{stats.books} 本书</span>
                    <span>{stats.cards} 张卡片</span>
                    <span>{stats.mindmaps} 张脑图</span>
                    <span
                      className={
                        stats.due > 0 ? "font-medium text-primary" : ""
                      }
                    >
                      {stats.due} 张待复习
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function setStats(lib: Library, studySet: StudySet, now: number) {
  const bookIds = new Set(studySet.bookIds);
  const books = lib.books.filter(book => bookIds.has(book.id));
  const cards = lib.highlights.filter(highlight =>
    bookIds.has(highlight.bookId)
  );
  const mindmaps = lib.mindMaps.filter(
    map => map.bookId && bookIds.has(map.bookId)
  );
  const due = cards.filter(
    card => card.review && card.review.due <= now
  ).length;
  return {
    books: books.length,
    cards: cards.length,
    mindmaps: mindmaps.length,
    due,
  };
}

function StudySetDetail({
  lib,
  studySet,
  now,
}: {
  lib: Library;
  studySet: StudySet;
  now: number;
}) {
  const [editing, setEditing] = useState(studySet.bookIds.length === 0);
  const [name, setName] = useState(studySet.name);
  const [description, setDescription] = useState(studySet.description ?? "");
  const [bookIds, setBookIds] = useState<string[]>(studySet.bookIds);
  const selectedIds = new Set(studySet.bookIds);
  const books = lib.books.filter(book => selectedIds.has(book.id));
  const cards = lib.highlights
    .filter(highlight => selectedIds.has(highlight.bookId))
    .sort((a, b) => b.createdAt - a.createdAt);
  const mindmaps = lib.mindMaps.filter(
    map => map.bookId && selectedIds.has(map.bookId)
  );
  const due = cards.filter(card => card.review && card.review.due <= now);

  const toggleBook = (bookId: string) =>
    setBookIds(current =>
      current.includes(bookId)
        ? current.filter(id => id !== bookId)
        : [...current, bookId]
    );
  const cancelEdit = () => {
    setName(studySet.name);
    setDescription(studySet.description ?? "");
    setBookIds(studySet.bookIds);
    setEditing(false);
  };
  const save = async () => {
    if (!name.trim()) return;
    await lib.saveStudySet({
      ...studySet,
      name,
      description: description.trim(),
      bookIds,
    });
    setEditing(false);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-10 pb-24 pt-12">
        <button
          onClick={() => lib.navigate({ view: "studyset" })}
          className="font-meta mb-5 flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={12} /> 全部学习集
        </button>
        <header className="mb-8 border-b border-foreground/15 pb-6">
          <div className="font-meta text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            独立学习集
          </div>
          <div className="mt-2 flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="font-reading text-[34px] font-bold tracking-wide">
                {studySet.name}
              </h1>
              {studySet.description && (
                <p className="mt-2 text-[13px] leading-6 text-muted-foreground">
                  {studySet.description}
                </p>
              )}
            </div>
            <button
              onClick={() => setEditing(true)}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-card"
            >
              <Pencil size={12} /> 编辑
            </button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={() =>
                lib.navigate({ view: "review", studySetId: studySet.id })
              }
              className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-[12.5px] font-medium text-primary-foreground"
            >
              <GraduationCap size={13} /> 复习本集
              {due.length > 0 ? `（${due.length} 张到期）` : ""}
            </button>
            <button
              onClick={() => lib.navigate({ view: "mind" })}
              className="flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-[12.5px] text-muted-foreground hover:bg-card"
            >
              <GitBranch size={13} /> 打开脑图
            </button>
          </div>
        </header>

        {editing && (
          <section className="mb-9 rounded-lg border border-border bg-card p-5 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-reading text-lg font-semibold">编辑学习集</h2>
              <button
                onClick={cancelEdit}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary"
                title="取消编辑"
              >
                <X size={15} />
              </button>
            </div>
            <label className="font-meta block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              名称
              <input
                value={name}
                onChange={event => setName(event.target.value)}
                className="mt-1.5 block h-9 w-full rounded-md border border-border bg-background px-3 text-sm normal-case tracking-normal text-foreground outline-none focus:border-primary"
              />
            </label>
            <label className="font-meta mt-4 block text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              学习目标 / 说明
              <textarea
                value={description}
                onChange={event => setDescription(event.target.value)}
                rows={2}
                placeholder="说明这个学习集要解决的问题"
                className="mt-1.5 block w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm normal-case tracking-normal text-foreground outline-none focus:border-primary"
              />
            </label>
            <div className="font-meta mb-2 mt-4 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              选择书籍 · {bookIds.length}
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border p-2">
              {lib.books.map(book => {
                const checked = bookIds.includes(book.id);
                const folderName = lib.folders.find(
                  folder => folder.id === book.folderId
                )?.name;
                return (
                  <button
                    key={book.id}
                    onClick={() => toggleBook(book.id)}
                    className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm ${checked ? "bg-primary/10" : "hover:bg-secondary"}`}
                  >
                    <span
                      className={`flex size-4 shrink-0 items-center justify-center rounded border ${checked ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
                    >
                      {checked && <Check size={11} />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {book.title}
                    </span>
                    {folderName && (
                      <span className="font-meta shrink-0 text-[10px] text-muted-foreground">
                        书架：{folderName}
                      </span>
                    )}
                  </button>
                );
              })}
              {lib.books.length === 0 && (
                <p className="p-3 text-xs text-muted-foreground">
                  书架中还没有书籍。
                </p>
              )}
            </div>
            <div className="mt-5 flex items-center justify-between">
              <button
                onClick={() => {
                  if (
                    window.confirm(
                      `删除学习集“${studySet.name}”？书籍本身不会被删除。`
                    )
                  )
                    void lib.removeStudySet(studySet.id);
                }}
                className="flex items-center gap-1.5 text-xs text-destructive hover:underline"
              >
                <Trash2 size={12} /> 删除学习集
              </button>
              <button
                onClick={() => void save()}
                disabled={!name.trim()}
                className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-medium text-primary-foreground disabled:opacity-40"
              >
                <Save size={12} /> 保存
              </button>
            </div>
          </section>
        )}

        <section className="mb-10">
          <div className="font-meta mb-3 text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
            书籍 · {books.length}
          </div>
          {books.length === 0 ? (
            <p className="text-[12.5px] text-muted-foreground">
              这个学习集还没有书。点击“编辑”从整个书架中选择。
            </p>
          ) : (
            <div className="space-y-1.5">
              {books.map(book => (
                <button
                  key={book.id}
                  onClick={() =>
                    lib.navigate({
                      view: "reader",
                      bookId: book.id,
                      studySetId: studySet.id,
                    })
                  }
                  className="flex w-full items-center gap-2.5 rounded-md bg-card p-3 text-left shadow-sm hover:opacity-80"
                >
                  <BookOpen size={13} className="shrink-0 text-primary" />
                  <span className="font-reading flex-1 truncate text-[14px] font-medium">
                    {book.title}
                  </span>
                  <span className="font-meta shrink-0 text-[10px] text-muted-foreground">
                    {
                      lib.highlights.filter(
                        highlight => highlight.bookId === book.id
                      ).length
                    }{" "}
                    卡片
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="mb-10">
          <div className="font-meta mb-3 text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
            脑图 · {mindmaps.length}
          </div>
          {mindmaps.length === 0 ? (
            <p className="text-[12.5px] text-muted-foreground">
              本集还没有与所选书籍关联的脑图。
            </p>
          ) : (
            <div className="space-y-1.5">
              {mindmaps.map(map => (
                <button
                  key={map.id}
                  onClick={() => lib.navigate({ view: "mind" })}
                  className="flex w-full items-center gap-2.5 rounded-md bg-card p-3 text-left shadow-sm hover:opacity-80"
                >
                  <GitBranch size={13} className="shrink-0 text-primary" />
                  <span className="flex-1 truncate text-[13.5px]">
                    {map.title}
                  </span>
                  <span className="font-meta shrink-0 text-[10px] text-muted-foreground">
                    {countNodes(map.root)} 节点 · {formatDate(map.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="font-meta mb-3 text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
            最近卡片 · {cards.length}
          </div>
          {cards.length === 0 ? (
            <p className="text-[12.5px] text-muted-foreground">
              阅读本集中的书并划线，卡片会聚合到这里。
            </p>
          ) : (
            <div className="space-y-2">
              {cards.slice(0, 10).map(highlight => (
                <button
                  key={highlight.id}
                  onClick={() =>
                    lib.navigate({
                      view: "reader",
                      bookId: highlight.bookId,
                      chapterId: highlight.chapterId,
                      highlightId: highlight.id,
                    })
                  }
                  className="block w-full rounded-md bg-card p-3 text-left shadow-sm hover:opacity-80"
                >
                  <p className="font-reading truncate text-[13px] leading-6">
                    {highlight.text}
                  </p>
                  <div className="font-meta mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span>{highlight.chapterTitle}</span>
                    {highlight.review && (
                      <span className="text-primary">复习中</span>
                    )}
                    {(highlight.tags ?? []).map(tag => (
                      <span key={tag}># {tag}</span>
                    ))}
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
