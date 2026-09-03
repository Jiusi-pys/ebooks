import { describe, expect, it } from "vitest";
import type { Association, Book, Highlight, Note } from "@/types";
import { buildGraph } from "./links";

const book = {
  id: "book-1",
  title: "论语",
  author: "",
  chapters: [
    {
      id: "chapter-1",
      title: "为政第二",
      paragraphs: ["学而不思则罔"],
    },
  ],
} as unknown as Book;
const note = {
  id: "note-1",
  title: "学习笔记",
  content: "",
  createdAt: 1,
  updatedAt: 1,
} satisfies Note;
const highlight = {
  id: "highlight-1",
  bookId: book.id,
  chapterId: "chapter-1",
  chapterTitle: "为政第二",
  text: "学而不思则罔",
  noteId: note.id,
  createdAt: 1,
} satisfies Highlight;

describe("citation graph relationships", () => {
  it("keeps an explicit book citation at book level", () => {
    const citedBook: Highlight = {
      ...highlight,
      chapterId: "",
      chapterTitle: "整本书",
      text: book.title,
      citation: { level: "book" },
    };
    const graph = buildGraph(
      [book],
      [{ ...note, content: "> 书籍引用：[[论语]]" }],
      [citedBook]
    );
    expect(graph.nodes).toEqual([
      {
        id: "book:book-1",
        kind: "book",
        label: "论语",
        bookId: "book-1",
      },
      { id: "note:note-1", kind: "note", label: "学习笔记" },
    ]);
    expect(graph.edges).toEqual([
      { source: "note:note-1", target: "book:book-1" },
    ]);
  });

  it("builds book to chapter and note to chapter for a chapter citation", () => {
    const citedChapter: Highlight = {
      ...highlight,
      text: "为政第二",
      citation: { level: "chapter", chapterId: "chapter-1" },
    };
    const graph = buildGraph(
      [book],
      [{ ...note, content: "> 章节引用：[[论语]] → 为政第二" }],
      [citedChapter]
    );
    expect(graph.nodes).toEqual([
      {
        id: "book:book-1",
        kind: "book",
        label: "论语",
        bookId: "book-1",
      },
      { id: "note:note-1", kind: "note", label: "学习笔记" },
      {
        id: "chapter:book-1:chapter-1",
        kind: "chapter",
        label: "为政第二",
        bookId: "book-1",
        chapterId: "chapter-1",
      },
    ]);
    expect(graph.edges).toEqual([
      { source: "book:book-1", target: "chapter:book-1:chapter-1" },
      { source: "note:note-1", target: "chapter:book-1:chapter-1" },
    ]);
  });

  it("builds the complete book to chapter to content path without a flat shortcut", () => {
    const citedContent: Highlight = {
      ...highlight,
      paraIndex: 0,
      start: 0,
      end: 7,
      citation: {
        level: "content",
        chapterId: "chapter-1",
        paraIndex: 0,
        start: 0,
        end: 7,
      },
    };
    const graph = buildGraph(
      [book],
      [
        {
          ...note,
          content: "> 学而不思则罔\n\n—— [[论语]] → 为政第二 → 具体内容",
        },
      ],
      [citedContent]
    );
    const contentNode = graph.nodes.find(node => node.kind === "content");
    expect(contentNode).toMatchObject({
      kind: "content",
      label: "学而不思则罔",
      bookId: "book-1",
      chapterId: "chapter-1",
      highlightId: "highlight-1",
    });
    expect(contentNode?.id).not.toBe(`content:${citedContent.id}`);
    expect(graph.nodes).toEqual([
      {
        id: "book:book-1",
        kind: "book",
        label: "论语",
        bookId: "book-1",
      },
      { id: "note:note-1", kind: "note", label: "学习笔记" },
      {
        id: "chapter:book-1:chapter-1",
        kind: "chapter",
        label: "为政第二",
        bookId: "book-1",
        chapterId: "chapter-1",
      },
      contentNode,
    ]);
    expect(graph.edges).toEqual([
      { source: "book:book-1", target: "chapter:book-1:chapter-1" },
      {
        source: "chapter:book-1:chapter-1",
        target: contentNode?.id,
      },
      { source: "note:note-1", target: contentNode?.id },
    ]);
  });

  it("treats legacy citation highlights as content-level", () => {
    const graph = buildGraph([book], [note], [highlight]);
    const contentNode = graph.nodes.find(node => node.kind === "content");
    expect(graph.edges).toEqual([
      { source: "book:book-1", target: "chapter:book-1:chapter-1" },
      {
        source: "chapter:book-1:chapter-1",
        target: contentNode?.id,
      },
      { source: "note:note-1", target: contentNode?.id },
    ]);
  });

  it("shares one text-source node when multiple notes cite the same content", () => {
    const secondNote: Note = { ...note, id: "note-2", title: "第二条笔记" };
    const sourceAnchor = {
      level: "content" as const,
      chapterId: "chapter-1",
      paraIndex: 0,
      start: 0,
      end: 7,
    };
    const firstCitation: Highlight = {
      ...highlight,
      citation: sourceAnchor,
      paraIndex: 0,
      start: 0,
      end: 7,
    };
    const secondCitation: Highlight = {
      ...firstCitation,
      id: "highlight-2",
      noteId: secondNote.id,
      // Record-local display text does not define an anchored source's identity.
      text: "学而不思则罔（摘录标题不同）",
    };

    const graph = buildGraph(
      [book],
      [note, secondNote],
      [firstCitation, secondCitation]
    );
    const contentNodes = graph.nodes.filter(node => node.kind === "content");
    expect(contentNodes).toHaveLength(1);
    expect(contentNodes[0]).toMatchObject({
      highlightId: "highlight-1",
      bookId: "book-1",
      chapterId: "chapter-1",
    });
    expect(graph.edges).toContainEqual({
      source: "note:note-1",
      target: contentNodes[0].id,
    });
    expect(graph.edges).toContainEqual({
      source: "note:note-2",
      target: contentNodes[0].id,
    });
  });

  it("keeps distinct text anchors as distinct content nodes", () => {
    const secondNote: Note = { ...note, id: "note-2", title: "第二条笔记" };
    const firstCitation: Highlight = {
      ...highlight,
      paraIndex: 0,
      start: 0,
      end: 2,
      citation: {
        level: "content",
        chapterId: "chapter-1",
        paraIndex: 0,
        start: 0,
        end: 2,
      },
    };
    const secondCitation: Highlight = {
      ...firstCitation,
      id: "highlight-2",
      noteId: secondNote.id,
      start: 2,
      end: 4,
      citation: {
        ...firstCitation.citation!,
        start: 2,
        end: 4,
      },
    };

    const graph = buildGraph(
      [book],
      [note, secondNote],
      [firstCitation, secondCitation]
    );
    expect(graph.nodes.filter(node => node.kind === "content")).toHaveLength(2);
  });

  it("uses PDF page and geometry before text coordinates for source identity", () => {
    const secondNote: Note = { ...note, id: "note-2", title: "第二条笔记" };
    const pdfAnchor = {
      page: 3,
      rects: [
        { x: 0.1, y: 0.4, width: 0.2, height: 0.03 },
        { x: 0.1, y: 0.3, width: 0.4, height: 0.03 },
      ],
    };
    const firstCitation: Highlight = {
      ...highlight,
      paraIndex: 0,
      start: 0,
      end: 2,
      pdfAnchor,
      citation: { level: "content", chapterId: "chapter-1", pdfAnchor },
    };
    const secondCitation: Highlight = {
      ...firstCitation,
      id: "highlight-2",
      noteId: secondNote.id,
      paraIndex: 99,
      start: 20,
      end: 30,
      // Reversed rect order still represents the same page selection.
      pdfAnchor: { ...pdfAnchor, rects: [...pdfAnchor.rects].reverse() },
      citation: {
        level: "content",
        chapterId: "chapter-1",
        pdfAnchor: { ...pdfAnchor, rects: [...pdfAnchor.rects].reverse() },
      },
    };

    const graph = buildGraph(
      [book],
      [note, secondNote],
      [firstCitation, secondCitation]
    );
    expect(graph.nodes.filter(node => node.kind === "content")).toHaveLength(1);
  });

  it("keeps a shared hierarchy branch when only one citation is unlinked", () => {
    const secondNote: Note = { ...note, id: "note-2", title: "第二条笔记" };
    const anchored: Highlight = {
      ...highlight,
      paraIndex: 0,
      start: 0,
      end: 7,
    };
    const remainingCitation: Highlight = {
      ...anchored,
      id: "highlight-2",
      noteId: secondNote.id,
    };
    const graph = buildGraph(
      [book],
      [note, secondNote],
      [{ ...anchored, noteId: undefined }, remainingCitation]
    );
    const contentNodes = graph.nodes.filter(node => node.kind === "content");

    expect(contentNodes).toHaveLength(1);
    expect(contentNodes[0].highlightId).toBe("highlight-2");
    expect(graph.edges).toContainEqual({
      source: "book:book-1",
      target: "chapter:book-1:chapter-1",
    });
    expect(graph.edges).toContainEqual({
      source: "chapter:book-1:chapter-1",
      target: contentNodes[0].id,
    });
    expect(graph.edges).toContainEqual({
      source: "note:note-2",
      target: contentNodes[0].id,
    });
    expect(graph.edges).not.toContainEqual({
      source: "note:note-1",
      target: contentNodes[0].id,
    });
  });

  it("deduplicates equivalent legacy records by their known source fields", () => {
    const secondNote: Note = { ...note, id: "note-2", title: "第二条笔记" };
    const firstLegacy: Highlight = {
      ...highlight,
      paraIndex: undefined,
      start: undefined,
      end: undefined,
    };
    const secondLegacy: Highlight = {
      ...firstLegacy,
      id: "highlight-2",
      noteId: secondNote.id,
    };
    const graph = buildGraph(
      [book],
      [note, secondNote],
      [firstLegacy, secondLegacy]
    );
    const contentNodes = graph.nodes.filter(node => node.kind === "content");

    expect(contentNodes).toHaveLength(1);
    expect(contentNodes[0].highlightId).toBe("highlight-1");
    expect(
      graph.edges.filter(edge => edge.target === contentNodes[0].id)
    ).toHaveLength(3);
  });

  it("falls back to the book instead of creating orphan nodes for a missing chapter", () => {
    const broken = {
      ...highlight,
      chapterId: "missing",
      citation: { level: "content" as const, chapterId: "missing" },
    };
    expect(buildGraph([book], [note], [broken]).edges).toEqual([
      { source: "note:note-1", target: "book:book-1" },
    ]);
  });

  it("removes the edge as soon as the citation is unlinked", () => {
    const unlinked: Highlight = { ...highlight, noteId: undefined };
    expect(buildGraph([book], [note], [unlinked]).edges).toEqual([]);
  });

  it("keeps the chapter and content hierarchy for an original scanned PDF", () => {
    const scannedBook: Book = {
      ...book,
      id: "scanned-citation-pdf",
      title: "扫描资料",
      format: "pdf",
      readerMode: "original",
      chapters: [],
      progress: {
        chapterId: "pdf-original:scanned-citation-pdf",
        ratio: 0,
      },
    };
    const pdfAnchor = {
      page: 4,
      rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
    };
    const citation: Highlight = {
      ...highlight,
      id: "scanned-pdf-citation",
      bookId: scannedBook.id,
      chapterId: `pdf-original:${scannedBook.id}`,
      chapterTitle: "原版 PDF · 第 4 页",
      text: "扫描页中的观点",
      noteId: note.id,
      pdfAnchor,
      citation: {
        level: "content",
        chapterId: `pdf-original:${scannedBook.id}`,
        pdfAnchor,
      },
    };

    const graph = buildGraph([scannedBook], [note], [citation]);
    const chapterNodeId =
      "chapter:scanned-citation-pdf:pdf-original:scanned-citation-pdf";
    const contentNode = graph.nodes.find(node => node.kind === "content");

    expect(graph.nodes).toContainEqual(
      expect.objectContaining({
        id: chapterNodeId,
        kind: "chapter",
        label: "原版 PDF",
      })
    );
    expect(contentNode).toMatchObject({
      kind: "content",
      bookId: scannedBook.id,
      anchor: expect.objectContaining({ kind: "pdf", pdfAnchor }),
    });
    expect(graph.edges).toContainEqual({
      source: `book:${scannedBook.id}`,
      target: chapterNodeId,
    });
    expect(graph.edges).toContainEqual({
      source: chapterNodeId,
      target: contentNode?.id,
    });
    expect(graph.edges).toContainEqual({
      source: `note:${note.id}`,
      target: contentNode?.id,
    });
  });
});

describe("passage association graph relationships", () => {
  const secondBook = {
    ...book,
    id: "book-2",
    title: "孟子",
    chapters: [
      {
        id: "chapter-2",
        title: "告子上",
        paragraphs: ["心之官则思。"],
      },
    ],
  } as Book;
  const association = {
    id: "association-1",
    source: {
      kind: "text",
      bookId: book.id,
      chapterId: "chapter-1",
      chapterTitle: "为政第二",
      text: "学而不思则罔",
      paraIndex: 0,
      start: 0,
      end: 7,
    },
    target: {
      kind: "text",
      bookId: secondBook.id,
      chapterId: "chapter-2",
      chapterTitle: "告子上",
      text: "心之官则思。",
      paraIndex: 0,
      start: 0,
      end: 7,
    },
    direction: "bidirectional",
    label: "相似观点",
    pairKey: "pair-1",
    createdAt: 1,
    updatedAt: 1,
  } satisfies Association;

  it("creates precise content nodes and a distinct bidirectional edge", () => {
    const graph = buildGraph([book, secondBook], [], [], [association]);
    const contentNodes = graph.nodes.filter(node => node.kind === "content");
    const edge = graph.edges.find(item => item.kind === "association");

    expect(contentNodes).toHaveLength(2);
    expect(contentNodes.map(node => node.anchor)).toEqual([
      association.source,
      association.target,
    ]);
    expect(edge).toMatchObject({
      kind: "association",
      associationId: association.id,
      directed: false,
      label: "相似观点",
    });
    expect(new Set([edge?.source, edge?.target])).toEqual(
      new Set(contentNodes.map(node => node.id))
    );
  });

  it("preserves A-to-B direction and removes only the relation edge on delete", () => {
    const directed = {
      ...association,
      direction: "source-to-target" as const,
      pairKey: "directed-pair",
    };
    const graph = buildGraph([book, secondBook], [], [], [directed]);
    expect(graph.edges.find(item => item.kind === "association")).toMatchObject(
      {
        directed: true,
      }
    );

    const afterDelete = buildGraph([book, secondBook], [], [], []);
    expect(afterDelete.edges.some(item => item.kind === "association")).toBe(
      false
    );
  });

  it("keeps association nodes for an original PDF without reflow chapters", () => {
    const scannedBook = {
      ...book,
      id: "scanned-pdf",
      title: "扫描资料",
      format: "pdf",
      readerMode: "original",
      chapters: [],
    } as Book;
    const pdfAssociation: Association = {
      ...association,
      id: "pdf-association",
      source: {
        kind: "pdf",
        bookId: scannedBook.id,
        chapterId: `pdf-original:${scannedBook.id}`,
        chapterTitle: "原版 PDF · 第 4 页",
        text: "扫描页中的观点",
        pdfAnchor: {
          page: 4,
          rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
        },
      },
      pairKey: "pdf-pair",
    };

    const graph = buildGraph(
      [scannedBook, secondBook],
      [],
      [],
      [pdfAssociation]
    );
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({
        id: `chapter:${scannedBook.id}:pdf-original:${scannedBook.id}`,
        kind: "chapter",
        label: "原版 PDF",
      })
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        kind: "association",
        associationId: "pdf-association",
      })
    );
  });
});
