import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeftRight, BookOpen, Languages, Loader2 } from 'lucide-react';
import type { Book, Chapter, ChapterTranslation, ReaderTheme } from '@/types';
import type { Library } from '@/hooks/useLibrary';
import { getChapterTranslation, putChapterTranslation, translationId } from '@/lib/db';
import { emitEvent } from '@/lib/events';
import { fontStack, loadTypeSettings, themeById } from '@/lib/reading';
import { trpc } from '@/providers/trpc';
import { friendlyAiError } from '@/lib/aiError';
import type { TranslationLang } from './reader/TranslationPopup';

interface PaneState {
  bookId: string;
  chapterId: string;
}

type RightMode = 'original' | 'translation';

function pickChapter(book: Book | undefined, chapterId: string): Chapter | undefined {
  if (!book) return undefined;
  return book.chapters.find((c) => c.id === chapterId) ?? book.chapters[0];
}

function splitTranslation(text: string): string[] {
  const byBlank = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (byBlank.length > 1) return byBlank;
  return text.split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
}

function PaneSelects({
  books,
  value,
  onChange,
  compact = false,
}: {
  books: Book[];
  value: PaneState;
  onChange: (next: PaneState) => void;
  compact?: boolean;
}) {
  const book = books.find((b) => b.id === value.bookId) ?? books[0];
  const chapter = pickChapter(book, value.chapterId);
  return (
    <div className={`flex min-w-0 items-center gap-2 ${compact ? 'text-[11px]' : 'text-[12px]'}`}>
      <select
        value={book?.id ?? ''}
        onChange={(e) => {
          const nextBook = books.find((b) => b.id === e.target.value);
          onChange({ bookId: e.target.value, chapterId: nextBook?.chapters[0]?.id ?? '' });
        }}
        className="h-8 min-w-0 flex-1 rounded-md border border-border bg-card px-2 outline-none focus:border-primary/60"
      >
        {books.map((b) => (
          <option key={b.id} value={b.id}>
            {b.title}
          </option>
        ))}
      </select>
      <select
        value={chapter?.id ?? ''}
        onChange={(e) => onChange({ bookId: book?.id ?? '', chapterId: e.target.value })}
        className="h-8 w-36 shrink-0 rounded-md border border-border bg-card px-2 outline-none focus:border-primary/60"
      >
        {(book?.chapters ?? []).map((c, i) => (
          <option key={c.id} value={c.id}>
            {String(i + 1).padStart(2, '0')} {c.title}
          </option>
        ))}
      </select>
    </div>
  );
}

function ReadingPane({
  label,
  books,
  value,
  onChange,
  theme,
  right,
  rightMode,
  onRightMode,
  targetLang,
  onTargetLang,
  translation,
  translationLoading,
  translationError,
  onTranslate,
  onOpenReader,
}: {
  label: string;
  books: Book[];
  value: PaneState;
  onChange: (next: PaneState) => void;
  theme: ReaderTheme;
  right?: boolean;
  rightMode?: RightMode;
  onRightMode?: (mode: RightMode) => void;
  targetLang?: TranslationLang;
  onTargetLang?: (lang: TranslationLang) => void;
  translation?: ChapterTranslation | null;
  translationLoading?: boolean;
  translationError?: string;
  onTranslate?: () => void;
  onOpenReader: () => void;
}) {
  const type = loadTypeSettings();
  const book = books.find((b) => b.id === value.bookId) ?? books[0];
  const chapter = pickChapter(book, value.chapterId);
  const paragraphs = chapter?.paragraphs ?? [];
  const translated = translation ? splitTranslation(translation.text) : [];

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ background: theme.bg, color: theme.text }}>
      <div
        className="shrink-0 space-y-2 border-b px-5 py-3"
        style={{ borderColor: theme.border, background: theme.panel }}
      >
        <div className="flex items-center gap-2">
          <span className="font-meta text-[10px] uppercase tracking-[0.18em]" style={{ color: theme.muted }}>
            {label}
          </span>
          <button
            onClick={onOpenReader}
            className="ml-auto flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition-opacity hover:opacity-70"
            style={{ borderColor: theme.border, color: theme.muted }}
          >
            <BookOpen size={11} /> 打开阅读器
          </button>
        </div>
        <PaneSelects books={books} value={value} onChange={onChange} compact />
        {right && onRightMode && onTargetLang && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-full border p-0.5" style={{ borderColor: theme.border }}>
              {(['original', 'translation'] as RightMode[]).map((mode) => (
                <button
                  key={mode}
                  onClick={() => onRightMode(mode)}
                  className={`rounded-full px-3 py-1 text-[11px] ${rightMode === mode ? 'bg-primary text-primary-foreground' : ''}`}
                  style={rightMode === mode ? undefined : { color: theme.muted }}
                >
                  {mode === 'original' ? '原文' : '译文'}
                </button>
              ))}
            </div>
            <select
              value={targetLang}
              onChange={(e) => onTargetLang(e.target.value as TranslationLang)}
              className="h-7 rounded-full border bg-transparent px-2 text-[11px] outline-none"
              style={{ borderColor: theme.border, color: theme.muted }}
            >
              <option value="中文">译成中文</option>
              <option value="English">译成 English</option>
              <option value="日本語">译成日本語</option>
            </select>
            {rightMode === 'translation' && (
              <button
                onClick={onTranslate}
                disabled={translationLoading}
                className="flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
              >
                {translationLoading ? <Loader2 size={11} className="animate-spin" /> : <Languages size={11} />}
                {translation ? '重新翻译本章' : '翻译本章'}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!chapter ? (
          <div className="flex h-full items-center justify-center text-sm" style={{ color: theme.muted }}>
            选择一本书开始对比
          </div>
        ) : (
          <article className="mx-auto max-w-[680px] px-8 pb-24 pt-10">
            <div className="font-meta mb-2 text-[10px] uppercase tracking-[0.18em]" style={{ color: theme.muted }}>
              {book?.author || '佚名'} · {paragraphs.length} 段
            </div>
            <h2 className="font-reading mb-10 text-center text-[25px] font-bold tracking-wide">{chapter.title}</h2>

            {right && rightMode === 'translation' ? (
              translationLoading ? (
                <div className="flex items-center justify-center gap-2 py-16 text-[13px]" style={{ color: theme.muted }}>
                  <Loader2 size={15} className="animate-spin text-primary" /> 正在翻译整章…
                </div>
              ) : translationError ? (
                <div className="rounded-md bg-destructive/10 p-4 text-[13px] leading-6 text-destructive">
                  {translationError}
                </div>
              ) : translation ? (
                <div
                  className="reader-body"
                  style={{
                    fontFamily: fontStack(type.fontId),
                    fontSize: Math.max(16, type.fontSize - 1),
                    lineHeight: type.lineHeight,
                    letterSpacing: `${type.letterSpacing}em`,
                  }}
                >
                  {translated.map((p, i) => (
                    <div key={i} className="grid grid-cols-[30px_1fr] gap-3">
                      <span className="font-meta pt-1 text-right text-[9px]" style={{ color: theme.muted }}>
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <p>{p}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center py-16 text-center" style={{ color: theme.muted }}>
                  <Languages size={24} strokeWidth={1.5} />
                  <p className="mt-3 text-[13px] leading-6">右侧可切换为本章译文。</p>
                  <p className="font-meta mt-1 text-[10px]">译文会保存在本机，下次打开直接使用。</p>
                </div>
              )
            ) : (
              <div
                className="reader-body"
                style={{
                  fontFamily: fontStack(type.fontId),
                  fontSize: type.fontSize,
                  lineHeight: type.lineHeight,
                  letterSpacing: `${type.letterSpacing}em`,
                  fontWeight: type.fontWeight,
                }}
              >
                {paragraphs.map((p, i) => (
                  <div key={i} className="grid grid-cols-[30px_1fr] gap-3">
                    <span className="font-meta pt-1 text-right text-[9px]" style={{ color: theme.muted }}>
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <p>{p}</p>
                  </div>
                ))}
              </div>
            )}
          </article>
        )}
      </div>
    </section>
  );
}

export function CompareView({ lib }: { lib: Library }) {
  const first = lib.books[0];
  const [left, setLeft] = useState<PaneState>({ bookId: first?.id ?? '', chapterId: first?.chapters[0]?.id ?? '' });
  const [right, setRight] = useState<PaneState>({ bookId: first?.id ?? '', chapterId: first?.chapters[1]?.id ?? first?.chapters[0]?.id ?? '' });
  const [rightMode, setRightMode] = useState<RightMode>('original');
  const [targetLang, setTargetLang] = useState<TranslationLang>('中文');
  const [translation, setTranslation] = useState<ChapterTranslation | null>(null);
  const [translationLoading, setTranslationLoading] = useState(false);
  const [translationError, setTranslationError] = useState('');
  const utils = trpc.useUtils();
  const theme = themeById(loadTypeSettings().themeId);

  useEffect(() => {
    if (!lib.books.length) return;
    setLeft((s) => (s.bookId ? s : { bookId: lib.books[0].id, chapterId: lib.books[0].chapters[0]?.id ?? '' }));
    setRight((s) =>
      s.bookId
        ? s
        : {
            bookId: lib.books[0].id,
            chapterId: lib.books[0].chapters[1]?.id ?? lib.books[0].chapters[0]?.id ?? '',
          },
    );
  }, [lib.books]);

  const rightBook = useMemo(() => lib.books.find((b) => b.id === right.bookId) ?? lib.books[0], [lib.books, right.bookId]);
  const rightChapter = pickChapter(rightBook, right.chapterId);

  /* 右侧译文优先读本机缓存 */
  useEffect(() => {
    let cancelled = false;
    setTranslation(null);
    setTranslationError('');
    if (rightMode !== 'translation' || !rightBook || !rightChapter) return;
    void getChapterTranslation(rightBook.id, rightChapter.id, targetLang).then((cached) => {
      if (!cancelled) setTranslation(cached ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [rightMode, rightBook, rightChapter, targetLang]);

  const translateChapter = useCallback(async () => {
    if (!rightBook || !rightChapter || translationLoading) return;
    setTranslationLoading(true);
    setTranslationError('');
    try {
      const resp = await utils.client.ai.translate.mutate({
        text: rightChapter.paragraphs.join('\n\n'),
        targetLang,
        mode: 'chapter',
      });
      const now = Date.now();
      const cached: ChapterTranslation = {
        id: translationId(rightBook.id, rightChapter.id, targetLang),
        bookId: rightBook.id,
        chapterId: rightChapter.id,
        targetLang,
        text: resp.translation,
        createdAt: now,
        updatedAt: now,
      };
      await putChapterTranslation(cached);
      setTranslation(cached);
      emitEvent('translation.created', {
        extId: cached.id,
        bookExtId: rightBook.id,
        bookTitle: rightBook.title,
        chapterTitle: rightChapter.title,
        targetLang,
        text: resp.translation,
        sourceLength: rightChapter.paragraphs.join('\n').length,
        scope: 'chapter',
      });
    } catch (e) {
      setTranslationError(friendlyAiError(e, '整章翻译暂时不可用，请稍后再试。'));
    } finally {
      setTranslationLoading(false);
    }
  }, [rightBook, rightChapter, targetLang, translationLoading, utils]);

  if (!lib.books.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
        <BookOpen size={28} strokeWidth={1.4} />
        <p className="mt-3 text-sm">书架还空着。先导入 PDF / EPUB，再来对比阅读。</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-4 border-b border-foreground/15 px-8 py-4">
        <div className="min-w-0">
          <div className="font-meta text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Compare Reading · 双栏对照
          </div>
          <h1 className="font-reading mt-1 text-[24px] font-bold tracking-wide">对比阅读</h1>
        </div>
        <button
          onClick={() => {
            setLeft(right);
            setRight(left);
          }}
          className="ml-auto flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-card"
        >
          <ArrowLeftRight size={13} /> 交换左右
        </button>
        <button
          onClick={() => setRight(left)}
          className="rounded-full border border-border px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-card"
        >
          右侧对齐左栏
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 divide-y lg:grid-cols-2 lg:divide-x lg:divide-y-0" style={{ borderColor: theme.border }}>
        <ReadingPane
          label="Left / 参考栏"
          books={lib.books}
          value={left}
          onChange={setLeft}
          theme={theme}
          onOpenReader={() => left.bookId && lib.openReader(left.bookId, left.chapterId)}
        />
        <ReadingPane
          label="Right / 对照栏"
          books={lib.books}
          value={right}
          onChange={setRight}
          theme={theme}
          right
          rightMode={rightMode}
          onRightMode={setRightMode}
          targetLang={targetLang}
          onTargetLang={setTargetLang}
          translation={translation}
          translationLoading={translationLoading}
          translationError={translationError}
          onTranslate={() => void translateChapter()}
          onOpenReader={() => right.bookId && lib.openReader(right.bookId, right.chapterId)}
        />
      </div>
    </div>
  );
}
