import { ArrowLeft, BookOpen, Folder, GitBranch, GraduationCap, Layers } from 'lucide-react';
import type { Library } from '@/hooks/useLibrary';
import { countNodes } from '@/lib/mind';
import { formatDate } from '@/lib/covers';

/** 学习集：以书架文件夹为主题的聚合空间（书籍 + 卡片 + 脑图 + 复习），对齐 MarginNote 学习集 */
export function StudySetView({ lib }: { lib: Library }) {
  const setId = lib.route.studySetId;
  const folder = lib.folders.find((f) => f.id === setId);

  if (setId && folder) {
    return <StudySetDetail lib={lib} folderId={folder.id} folderName={folder.name} />;
  }

  /* 学习集列表 */
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-10 pb-24 pt-12">
        <header className="mb-8 border-b border-foreground/15 pb-6">
          <div className="font-meta text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            学习集 · {lib.folders.length} 个
          </div>
          <h1 className="font-reading mt-2 text-[34px] font-bold tracking-wide">学习集</h1>
          <p className="font-meta mt-2 text-[11.5px] leading-5 text-muted-foreground">
            书架上的每个文件夹都是一个学习集：把相关的书、卡片、脑图和复习进度聚在一个主题空间里。
          </p>
        </header>

        {lib.folders.length === 0 ? (
          <div className="flex flex-col items-center py-20 text-muted-foreground">
            <Layers size={28} strokeWidth={1.4} />
            <p className="mt-3 text-sm">还没有学习集。到书架创建文件夹并把书移进去，文件夹会自动成为学习集。</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {lib.folders.map((f) => {
              const s = setStats(lib, f.id);
              return (
                <button
                  key={f.id}
                  onClick={() => lib.navigate({ view: 'studyset', studySetId: f.id })}
                  className="rounded-lg bg-card p-5 text-left shadow-sm transition-shadow hover:shadow-md"
                >
                  <div className="flex items-center gap-2">
                    <Folder size={15} className="text-primary" />
                    <span className="font-reading text-[16px] font-semibold">{f.name}</span>
                  </div>
                  <div className="font-meta mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                    <span>{s.books} 本书</span>
                    <span>{s.cards} 张卡片</span>
                    <span>{s.mindmaps} 张脑图</span>
                    <span className={s.due > 0 ? 'font-medium text-primary' : ''}>{s.due} 张待复习</span>
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

function setStats(lib: Library, folderId: string) {
  const bookIds = new Set(lib.books.filter((b) => b.folderId === folderId).map((b) => b.id));
  const cards = lib.highlights.filter((h) => bookIds.has(h.bookId));
  const mindmaps = lib.mindMaps.filter((m) => m.bookId && bookIds.has(m.bookId));
  const due = cards.filter((h) => h.review && h.review.due <= Date.now()).length;
  return { books: bookIds.size, cards: cards.length, mindmaps: mindmaps.length, due };
}

function StudySetDetail({ lib, folderId, folderName }: { lib: Library; folderId: string; folderName: string }) {
  const books = lib.books.filter((b) => b.folderId === folderId);
  const bookIds = new Set(books.map((b) => b.id));
  const cards = lib.highlights.filter((h) => bookIds.has(h.bookId)).sort((a, b) => b.createdAt - a.createdAt);
  const mindmaps = lib.mindMaps.filter((m) => m.bookId && bookIds.has(m.bookId));
  const due = cards.filter((h) => h.review && h.review.due <= Date.now());

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-10 pb-24 pt-12">
        <button
          onClick={() => lib.navigate({ view: 'studyset' })}
          className="font-meta mb-5 flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={12} /> 全部学习集
        </button>

        <header className="mb-8 border-b border-foreground/15 pb-6">
          <div className="font-meta text-[11px] uppercase tracking-[0.18em] text-muted-foreground">学习集</div>
          <h1 className="font-reading mt-2 text-[34px] font-bold tracking-wide">{folderName}</h1>
          <div className="mt-4 flex gap-2">
            <button
              onClick={() => lib.navigate({ view: 'review', studySetId: folderId })}
              className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-[12.5px] font-medium text-primary-foreground"
            >
              <GraduationCap size={13} /> 复习本集{due.length > 0 ? `（${due.length} 张到期）` : ''}
            </button>
            <button
              onClick={() => lib.navigate({ view: 'mind' })}
              className="flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-[12.5px] text-muted-foreground hover:bg-card"
            >
              <GitBranch size={13} /> 打开脑图
            </button>
          </div>
        </header>

        {/* 书籍 */}
        <section className="mb-10">
          <div className="font-meta mb-3 text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
            书籍 · {books.length}
          </div>
          {books.length === 0 ? (
            <p className="text-[12.5px] text-muted-foreground">这个文件夹还没有书。</p>
          ) : (
            <div className="space-y-1.5">
              {books.map((b) => (
                <button
                  key={b.id}
                  onClick={() => lib.openReader(b.id)}
                  className="flex w-full items-center gap-2.5 rounded-md bg-card p-3 text-left shadow-sm hover:opacity-80"
                >
                  <BookOpen size={13} className="shrink-0 text-primary" />
                  <span className="font-reading flex-1 truncate text-[14px] font-medium">{b.title}</span>
                  <span className="font-meta shrink-0 text-[10px] text-muted-foreground">
                    {lib.highlights.filter((h) => h.bookId === b.id).length} 卡片
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* 脑图 */}
        <section className="mb-10">
          <div className="font-meta mb-3 text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
            脑图 · {mindmaps.length}
          </div>
          {mindmaps.length === 0 ? (
            <p className="text-[12.5px] text-muted-foreground">本集还没有脑图，到「脑图」页从目录生成一张。</p>
          ) : (
            <div className="space-y-1.5">
              {mindmaps.map((m) => (
                <button
                  key={m.id}
                  onClick={() => lib.navigate({ view: 'mind' })}
                  className="flex w-full items-center gap-2.5 rounded-md bg-card p-3 text-left shadow-sm hover:opacity-80"
                >
                  <GitBranch size={13} className="shrink-0 text-primary" />
                  <span className="flex-1 truncate text-[13.5px]">{m.title}</span>
                  <span className="font-meta shrink-0 text-[10px] text-muted-foreground">
                    {countNodes(m.root)} 节点 · {formatDate(m.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* 最近卡片 */}
        <section>
          <div className="font-meta mb-3 text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
            最近卡片 · {cards.length}
          </div>
          {cards.length === 0 ? (
            <p className="text-[12.5px] text-muted-foreground">阅读本集的书并划线，卡片会出现在这里。</p>
          ) : (
            <div className="space-y-2">
              {cards.slice(0, 10).map((h) => (
                <button
                  key={h.id}
                  onClick={() =>
                    lib.navigate({ view: 'reader', bookId: h.bookId, chapterId: h.chapterId, highlightId: h.id })
                  }
                  className="block w-full rounded-md bg-card p-3 text-left shadow-sm hover:opacity-80"
                >
                  <p className="font-reading truncate text-[13px] leading-6">{h.text}</p>
                  <div className="font-meta mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span>{h.chapterTitle}</span>
                    {h.review && <span className="text-primary">复习中</span>}
                    {(h.tags ?? []).map((t) => (
                      <span key={t}># {t}</span>
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
