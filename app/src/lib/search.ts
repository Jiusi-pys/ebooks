import type { Book, Highlight, Note, Route, StudySet } from "@/types";

export type SearchScope = "book" | "studySet" | "all";
export type SearchContentType = "all" | "mark" | "note" | "qa";
export interface SearchContext {
  scope: SearchScope;
  bookId?: string;
  studySetId?: string;
  contentType?: SearchContentType;
}
export interface SearchData {
  books: Book[];
  notes: Note[];
  highlights: Highlight[];
  studySets: StudySet[];
}
export interface SearchResult {
  id: string;
  kind:
    | "书籍"
    | "章节"
    | "正文"
    | "笔记"
    | "划线批注"
    | "书摘"
    | "批注"
    | "问答"
    | "PDF 正文";
  title: string;
  location?: string;
  snippet: string;
  matchStart: number;
  matchEnd: number;
  route: Route;
  readerMode?: "original" | "reflow";
}
export interface SearchResponse {
  results: SearchResult[];
  total: number;
  truncated: boolean;
  warnings: string[];
}
export interface PdfSearchPage {
  page: number;
  text: string;
}
export interface SearchOptions {
  limit?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  pdfPages?: (book: Book, signal?: AbortSignal) => AsyncIterable<PdfSearchPage>;
}

/** Scope is explicit: a missing/deleted context must never widen a search. */
export function searchBooks(data: SearchData, context: SearchContext): Book[] {
  if (context.scope === "all") return data.books;
  if (context.scope === "book")
    return data.books.filter(b => b.id === context.bookId);
  const set = data.studySets.find(s => s.id === context.studySetId);
  const ids = new Set(set?.bookIds ?? []);
  return data.books.filter(b => ids.has(b.id));
}

export async function searchLibrary(
  data: SearchData,
  query: string,
  context: SearchContext,
  options: SearchOptions = {}
): Promise<SearchResponse> {
  const response: SearchResponse = {
    results: [],
    total: 0,
    truncated: false,
    warnings: [],
  };
  options.signal?.throwIfAborted();
  const keyword = query.trim();
  if (!keyword) return response;
  const pattern = new RegExp(
    keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "iu"
  );
  const books = searchBooks(data, context);
  const contentType = context.contentType ?? "all";
  const bookIds = new Set(books.map(b => b.id));
  const byId = new Map(books.map(b => [b.id, b]));
  const highlights = data.highlights.filter(h => bookIds.has(h.bookId));
  const noteIds = new Set(highlights.map(h => h.noteId).filter(Boolean));
  const notes =
    context.scope === "all"
      ? data.notes
      : data.notes.filter(n => noteIds.has(n.id));
  const limit = Math.max(1, options.limit ?? 200);
  let visited = 0;
  const checkpoint = async () => {
    options.signal?.throwIfAborted();
    if (++visited % 100 === 0)
      await new Promise(resolve => setTimeout(resolve, 0));
    options.signal?.throwIfAborted();
  };
  const add = (
    text: string,
    result: Omit<SearchResult, "snippet" | "matchStart" | "matchEnd">
  ) => {
    const match = pattern.exec(text);
    if (!match) return;
    response.total++;
    if (response.results.length >= limit) {
      response.truncated = true;
      return;
    }
    const from = Math.max(0, match.index - 45);
    const to = Math.min(text.length, match.index + match[0].length + 80);
    const prefix = from ? "…" : "";
    response.results.push({
      ...result,
      snippet: prefix + text.slice(from, to) + (to < text.length ? "…" : ""),
      matchStart: prefix.length + match.index - from,
      matchEnd: prefix.length + match.index - from + match[0].length,
    });
  };
  if (contentType === "all")
    for (const book of books) {
      options.onProgress?.(`正在搜索《${book.title}》`);
      const route: Route = {
        view: "reader",
        bookId: book.id,
        studySetId:
          context.scope === "studySet" ? context.studySetId : undefined,
      };
      add(`${book.title}\n${book.author}`, {
        id: `book:${book.id}`,
        kind: "书籍",
        title: book.title,
        route,
      });
      for (const chapter of book.chapters) {
        const chapterRoute = {
          ...route,
          chapterId: chapter.id,
          outlineParaIndex: 0,
        };
        add(chapter.title, {
          id: `chapter:${book.id}:${chapter.id}`,
          kind: "章节",
          title: book.title,
          location: chapter.title,
          route: chapterRoute,
          readerMode: "reflow",
        });
        for (const [paraIndex, text] of chapter.paragraphs.entries()) {
          await checkpoint();
          const match = pattern.exec(text);
          if (!match) continue;
          add(text, {
            id: `text:${book.id}:${chapter.id}:${paraIndex}`,
            kind: "正文",
            title: book.title,
            location: chapter.title,
            readerMode: "reflow",
            route: {
              ...chapterRoute,
              outlineParaIndex: undefined,
              passageAnchor: {
                kind: "text",
                bookId: book.id,
                chapterId: chapter.id,
                chapterTitle: chapter.title,
                paraIndex,
                start: match.index,
                end: match.index + match[0].length,
                text: match[0],
              },
            },
          });
        }
      }
      if (
        book.format === "pdf" &&
        !book.chapters.some(c => c.paragraphs.some(p => p.trim()))
      ) {
        let emptyPages = 0;
        let pageCount = 0;
        try {
          if (!options.pdfPages) throw new Error("尚未加载 PDF 文本");
          for await (const page of options.pdfPages(book, options.signal)) {
            await checkpoint();
            pageCount++;
            if (!page.text.trim()) emptyPages++;
            options.onProgress?.(`正在搜索《${book.title}》第 ${page.page} 页`);
            add(page.text, {
              id: `pdf:${book.id}:${page.page}`,
              kind: "PDF 正文",
              title: book.title,
              location: `第 ${page.page} 页`,
              readerMode: "original",
              route: {
                ...route,
                passageAnchor: {
                  kind: "pdf",
                  bookId: book.id,
                  chapterId: `pdf-original:${book.id}`,
                  chapterTitle: `第 ${page.page} 页`,
                  text: keyword,
                  pdfAnchor: { page: page.page, rects: [] },
                },
              },
            });
          }
          if (!pageCount || emptyPages)
            response.warnings.push(
              `《${book.title}》${pageCount ? `有 ${emptyPages} 页` : ""}未提取到文字，图片中的文字不参与搜索（未启用 OCR）。`
            );
        } catch (error) {
          options.signal?.throwIfAborted();
          response.warnings.push(
            `《${book.title}》正文未完整搜索：${error instanceof Error ? error.message : "PDF 读取失败"}`
          );
        }
      }
      await checkpoint();
    }
  if (contentType === "all")
    for (const note of notes) {
      await checkpoint();
      const visibleContent = note.content.replace(/<!--[\s\S]*?-->/g, comment =>
        " ".repeat(comment.length)
      );
      const titleMatch = pattern.exec(note.title);
      const match = titleMatch ?? pattern.exec(visibleContent);
      if (!match) continue;
      add(titleMatch ? note.title : visibleContent, {
        id: `note:${note.id}`,
        kind: "笔记",
        title: note.title,
        route: {
          view: "note",
          noteId: note.id,
          searchNoteRange: {
            field: titleMatch ? "title" : "content",
            start: match.index,
            end: match.index + match[0].length,
          },
        },
      });
    }
  for (const h of highlights) {
    await checkpoint();
    const result = {
      title: byId.get(h.bookId)!.title,
      location: h.chapterTitle,
      readerMode: h.pdfAnchor ? ("original" as const) : ("reflow" as const),
      route: {
        view: "reader" as const,
        bookId: h.bookId,
        chapterId: h.chapterId,
        highlightId: h.id,
        studySetId:
          context.scope === "studySet" ? context.studySetId : undefined,
      },
    };
    if (contentType === "all") {
      add([h.name, h.text, h.note].filter(Boolean).join("\n"), {
        id: `highlight:${h.id}`,
        kind: "划线批注",
        ...result,
      });
    }
    if (contentType === "mark") {
      add([h.name, h.text].filter(Boolean).join("\n"), {
        id: `mark:${h.id}`,
        kind: "书摘",
        ...result,
      });
    }
    if (contentType === "note" && h.note) {
      add(h.note, { id: `annotation:${h.id}`, kind: "批注", ...result });
    }
    if (contentType === "qa") {
      for (const [index, qa] of (h.aiQa ?? []).entries()) {
        add(`${qa.q}\n${qa.a}`, {
          id: `qa:${h.id}:${index}`,
          kind: "问答",
          ...result,
        });
      }
    }
  }
  options.signal?.throwIfAborted();
  return response;
}
