/**
 * 服务端镜像存储：外部 AI 通过 REST API 写入的书籍 / 书摘 / 批注 / 笔记 / 文件夹，
 * 以及浏览器端上报的阅读动作快照，保存在这里供机器读取。
 * 浏览器端的本地 IndexedDB 仍是阅读器的主存储；此镜像面向机器消费。
 */
import {
  mysqlTable,
  serial,
  varchar,
  text,
  longtext,
  timestamp,
  int,
  index,
} from "drizzle-orm/mysql-core";

/** 书籍镜像：外部 AI 可注册书目 + 章节正文，供问答与检索 */
export const mirrorBooks = mysqlTable(
  "mirror_books",
  {
    id: serial("id").primaryKey(),
    /** 调用方提供的稳定 id（如 Hermes 内的书籍标识），唯一 */
    extId: varchar("ext_id", { length: 64 }).notNull().unique(),
    title: varchar("title", { length: 255 }).notNull(),
    author: varchar("author", { length: 255 }).notNull().default(""),
    format: varchar("format", { length: 16 }).notNull().default("unknown"),
    folder: varchar("folder", { length: 255 }).notNull().default(""),
    contentHash: varchar("content_hash", { length: 64 }).notNull().default(""),
    /** 章节数组 JSON：[{ id, title, paragraphs: string[] }] */
    chapters: longtext("chapters").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  t => [index("idx_mirror_books_hash").on(t.contentHash)]
);

export type MirrorBook = typeof mirrorBooks.$inferSelect;

/** 书摘 / 批注镜像（含 AI 问答记录） */
export const mirrorHighlights = mysqlTable(
  "mirror_highlights",
  {
    id: serial("id").primaryKey(),
    extId: varchar("ext_id", { length: 64 }).notNull().unique(),
    bookExtId: varchar("book_ext_id", { length: 64 }).notNull().default(""),
    bookTitle: varchar("book_title", { length: 255 }).notNull().default(""),
    /** book | chapter | content；旧数据按 content 兼容 */
    citationLevel: varchar("citation_level", { length: 16 })
      .notNull()
      .default("content"),
    /** 章节稳定 id；书籍级引用为空串 */
    chapterId: varchar("chapter_id", { length: 64 }).notNull().default(""),
    chapterTitle: varchar("chapter_title", { length: 255 })
      .notNull()
      .default(""),
    text: text("text").notNull(),
    /** 可排版内容的段落与字符级锚点 */
    paraIndex: int("para_index"),
    start: int("start_offset"),
    end: int("end_offset"),
    /** PDF 页码与归一化矩形 JSON */
    pdfAnchor: text("pdf_anchor"),
    /** underline | background | color | none */
    styleKind: varchar("style_kind", { length: 16 })
      .notNull()
      .default("underline"),
    styleColor: varchar("style_color", { length: 32 })
      .notNull()
      .default("orange"),
    /** 内联批注内容 */
    note: text("note"),
    /** 引用到的笔记 extId */
    noteExtId: varchar("note_ext_id", { length: 64 }).notNull().default(""),
    /** AI 问答记录 JSON：[{ q, a, ts }] */
    aiQa: text("ai_qa"),
    /** 卡片标签 JSON：string[] */
    tags: text("tags"),
    /** 挖空项 JSON：string[]（复习时遮挡的词） */
    cloze: text("cloze"),
    /** 复习状态 JSON：{ due, reps, lapses, interval, lastRating?, lastReviewedAt?, addedAt }；null = 未加入复习 */
    review: text("review"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  t => [
    index("idx_mirror_hl_book").on(t.bookExtId),
    index("idx_mirror_hl_chapter").on(t.bookExtId, t.chapterId),
  ]
);

export type MirrorHighlight = typeof mirrorHighlights.$inferSelect;

/**
 * 内容关联镜像。source/target 均为精确文段锚点；字段平铺后可按任一端书籍检索。
 * pairKey 可因 PDF 多行矩形而很长，因此以完整 SHA-256 摘要建立唯一约束。
 */
export const mirrorAssociations = mysqlTable(
  "mirror_associations",
  {
    id: serial("id").primaryKey(),
    extId: varchar("ext_id", { length: 64 }).notNull().unique(),
    sourceKind: varchar("source_kind", { length: 8 }).notNull(),
    sourceBookExtId: varchar("source_book_ext_id", { length: 64 }).notNull(),
    sourceChapterId: varchar("source_chapter_id", { length: 64 }).notNull(),
    sourceChapterTitle: varchar("source_chapter_title", { length: 255 })
      .notNull()
      .default(""),
    sourceText: text("source_text").notNull(),
    sourceParaIndex: int("source_para_index"),
    sourceStart: int("source_start_offset"),
    sourceEnd: int("source_end_offset"),
    sourcePdfAnchor: longtext("source_pdf_anchor"),
    targetKind: varchar("target_kind", { length: 8 }).notNull(),
    targetBookExtId: varchar("target_book_ext_id", { length: 64 }).notNull(),
    targetChapterId: varchar("target_chapter_id", { length: 64 }).notNull(),
    targetChapterTitle: varchar("target_chapter_title", { length: 255 })
      .notNull()
      .default(""),
    targetText: text("target_text").notNull(),
    targetParaIndex: int("target_para_index"),
    targetStart: int("target_start_offset"),
    targetEnd: int("target_end_offset"),
    targetPdfAnchor: longtext("target_pdf_anchor"),
    /** bidirectional | source-to-target */
    direction: varchar("direction", { length: 32 }).notNull(),
    label: varchar("label", { length: 255 }),
    pairKey: longtext("pair_key").notNull(),
    /** 完整 pairKey 的 SHA-256；规避 MySQL TEXT 唯一索引前缀限制。 */
    pairKeyHash: varchar("pair_key_hash", { length: 64 }).notNull().unique(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  t => [
    index("idx_mirror_assoc_source_book").on(t.sourceBookExtId),
    index("idx_mirror_assoc_target_book").on(t.targetBookExtId),
  ]
);

export type MirrorAssociation = typeof mirrorAssociations.$inferSelect;

/** 笔记镜像（[[双链]] markdown-lite 文本） */
export const mirrorNotes = mysqlTable("mirror_notes", {
  id: serial("id").primaryKey(),
  extId: varchar("ext_id", { length: 64 }).notNull().unique(),
  title: varchar("title", { length: 255 }).notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

export type MirrorNote = typeof mirrorNotes.$inferSelect;

/** 文件夹镜像 */
export const mirrorFolders = mysqlTable("mirror_folders", {
  id: serial("id").primaryKey(),
  extId: varchar("ext_id", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type MirrorFolder = typeof mirrorFolders.$inferSelect;

/** 翻译结果镜像：划选译文与章节译文，供外部 AI 检索复用 */
export const mirrorTranslations = mysqlTable(
  "mirror_translations",
  {
    id: serial("id").primaryKey(),
    extId: varchar("ext_id", { length: 64 }).notNull().unique(),
    bookExtId: varchar("book_ext_id", { length: 64 }).notNull().default(""),
    bookTitle: varchar("book_title", { length: 255 }).notNull().default(""),
    chapterTitle: varchar("chapter_title", { length: 255 })
      .notNull()
      .default(""),
    targetLang: varchar("target_lang", { length: 32 }).notNull(),
    /** passage | chapter */
    scope: varchar("scope", { length: 16 }).notNull().default("passage"),
    text: text("text").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  t => [index("idx_mirror_translations_book").on(t.bookExtId)]
);

export type MirrorTranslation = typeof mirrorTranslations.$inferSelect;

/** 脑图镜像：root 为 MindNode 树 JSON */
export const mirrorMindmaps = mysqlTable(
  "mirror_mindmaps",
  {
    id: serial("id").primaryKey(),
    extId: varchar("ext_id", { length: 64 }).notNull().unique(),
    title: varchar("title", { length: 255 }).notNull(),
    bookExtId: varchar("book_ext_id", { length: 64 }).notNull().default(""),
    bookTitle: varchar("book_title", { length: 255 }).notNull().default(""),
    root: text("root").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  t => [index("idx_mirror_mindmaps_book").on(t.bookExtId)]
);

export type MirrorMindmap = typeof mirrorMindmaps.$inferSelect;
