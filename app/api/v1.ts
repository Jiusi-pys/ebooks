/**
 * 書房开放 API —— /api/v1
 *
 * 供外部 AI（Hermes / OpenClaw 等）以机器方式访问书房：
 *   GET    /api/v1/                     接口目录与事件类型清单
 *   GET    /api/v1/books                书目列表（?folder= 过滤）
 *   POST   /api/v1/books                注册书籍（含章节正文）→ book.imported
 *   GET    /api/v1/books/:extId         书籍详情（不含正文）
 *   PATCH  /api/v1/books/:extId         重命名 / 移文件夹 → book.updated
 *   DELETE /api/v1/books/:extId         删除 → book.deleted
 *   GET    /api/v1/books/:extId/chapters      章节目录
 *   GET    /api/v1/books/:extId/chapters/:idx 章节正文
 *   GET    /api/v1/digest/:contentHash  全书结构 + AI 导读缓存
 *
 *   GET    /api/v1/highlights           书摘/批注列表（?book= 过滤；含 tags/cloze/review 字段）
 *   POST   /api/v1/highlights           新增书摘/批注 → highlight.created
 *   PATCH  /api/v1/highlights/:extId    修改批注/样式/标签/挖空/复习状态 → highlight.updated（+ highlight.tagged / review.updated）
 *   DELETE /api/v1/highlights/:extId    删除 → highlight.deleted
 *   GET    /api/v1/review/due           到期复习队列（?all=1 返回全部复习卡片，按 due 排序）
 *
 *   GET    /api/v1/notes                笔记列表
 *   POST   /api/v1/notes                新建笔记（[[双链]] 文本）→ note.created
 *   GET    /api/v1/notes/:extId
 *   PATCH  /api/v1/notes/:extId         → note.updated
 *   DELETE /api/v1/notes/:extId
 *
 *   GET/POST/DELETE /api/v1/folders     文件夹管理 → folder.created / folder.deleted
 *
 *   POST   /api/v1/ask                  Codex 伴读问答（携带全书结构与章节上下文；可落库为问答记录 → qa.recorded）
 *   POST   /api/v1/translate            文段/章节翻译（结果可入镜像 → translation.created）
 *   GET/POST /api/v1/translations       翻译结果镜像
 *   GET/POST /api/v1/mindmaps           脑图镜像（MindNode 树 JSON）→ mindmap.created
 *   GET/PATCH/DELETE /api/v1/mindmaps/:extId
 *   POST   /api/v1/events               浏览器端阅读事件上报入口（前端调用；转发给 WebHook 订阅者）
 *
 *   GET    /api/v1/webhooks             订阅列表
 *   POST   /api/v1/webhooks             注册订阅 { url, secret?, events?, description? }
 *   PATCH  /api/v1/webhooks/:id         启停 / 改事件
 *   DELETE /api/v1/webhooks/:id
 *   POST   /api/v1/webhooks/:id/test    发送测试事件
 *
 * 鉴权：所有机器路由（除 GET /api/v1/）需要 X-API-Key 头；/events 额外允许本站同源浏览器上报。
 */
import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { getDb } from "./queries/connection";
import { bookDigests, webhookSubscriptions } from "@db/schema";
import {
  mirrorBooks,
  mirrorHighlights,
  mirrorNotes,
  mirrorFolders,
  mirrorTranslations,
  mirrorMindmaps,
} from "@db/mirror-schema";
import { requireApiKey } from "./lib/openapi-auth";
import { fanout, EVENT_TYPES, type ShufangEvent } from "./lib/webhooks";
import { askCodex } from "./lib/codex";

export const v1 = new Hono();

/* 统一错误格式：业务错误一律 JSON */
v1.onError((err, c) => {
  console.error("[v1]", err.message);
  return c.json({ error: "internal", message: err.message.slice(0, 300) }, 500);
});

/* ---------- 接口目录（公开，方便发现） ---------- */

v1.get("/", c =>
  c.json({
    name: "書房开放 API",
    version: "1.0",
    auth: "请求头 X-API-Key: <OPEN_API_KEY>（未配置时回退 APP_SECRET）",
    eventTypes: EVENT_TYPES,
    webhookSignature: "X-Shufang-Signature: sha256=<hmac(secret, body)>",
    endpoints: [
      "GET/POST /api/v1/books",
      "GET/PATCH/DELETE /api/v1/books/:extId",
      "GET /api/v1/books/:extId/chapters",
      "GET /api/v1/books/:extId/chapters/:index",
      "GET /api/v1/digest/:contentHash",
      "GET/POST /api/v1/highlights",
      "PATCH/DELETE /api/v1/highlights/:extId",
      "GET /api/v1/review/due",
      "GET/POST /api/v1/notes",
      "GET/PATCH/DELETE /api/v1/notes/:extId",
      "GET/POST /api/v1/folders",
      "DELETE /api/v1/folders/:extId",
      "POST /api/v1/ask",
      "POST /api/v1/translate",
      "GET/POST /api/v1/translations",
      "DELETE /api/v1/translations/:extId",
      "GET/POST /api/v1/mindmaps",
      "GET/PATCH/DELETE /api/v1/mindmaps/:extId",
      "POST /api/v1/events",
      "GET/POST /api/v1/webhooks",
      "PATCH/DELETE /api/v1/webhooks/:id",
      "POST /api/v1/webhooks/:id/test",
    ],
  })
);

v1.use("/*", async (c, next) => {
  if (c.req.path === "/api/v1" || c.req.path === "/api/v1/") return next();
  // 浏览器阅读端的事件上报是同域请求，允许免 key；外部机器调用仍必须带 X-API-Key
  if (c.req.path === "/api/v1/events") {
    const origin = c.req.header("origin");
    try {
      if (origin && new URL(origin).host === new URL(c.req.url).host)
        return next();
    } catch {
      /* fall through to API key */
    }
  }
  return requireApiKey(c, next);
});

/* ---------- 书籍 ---------- */

const chapterSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(255),
  paragraphs: z.array(z.string().max(20000)).max(2000),
});

const bookBody = z.object({
  extId: z.string().min(1).max(64),
  title: z.string().min(1).max(255),
  author: z.string().max(255).default(""),
  format: z.string().max(16).default("unknown"),
  folder: z.string().max(255).default(""),
  contentHash: z.string().max(64).default(""),
  chapters: z.array(chapterSchema).max(500),
});

function bookJson(b: typeof mirrorBooks.$inferSelect, withChapters = false) {
  return {
    extId: b.extId,
    title: b.title,
    author: b.author,
    format: b.format,
    folder: b.folder,
    contentHash: b.contentHash,
    chapterCount: (JSON.parse(b.chapters) as unknown[]).length,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    ...(withChapters ? { chapters: JSON.parse(b.chapters) as unknown[] } : {}),
  };
}

v1.get("/books", async c => {
  const folder = c.req.query("folder");
  const rows = await getDb().select().from(mirrorBooks);
  const list = rows.filter(r => folder === undefined || r.folder === folder);
  return c.json({ books: list.map(b => bookJson(b)) });
});

v1.post("/books", zValidator("json", bookBody), async c => {
  const b = c.req.valid("json");
  await getDb()
    .insert(mirrorBooks)
    .values({ ...b, chapters: JSON.stringify(b.chapters) })
    .onDuplicateKeyUpdate({
      set: {
        title: b.title,
        author: b.author,
        format: b.format,
        folder: b.folder,
        contentHash: b.contentHash,
        chapters: JSON.stringify(b.chapters),
      },
    });
  fanout({
    type: "book.imported",
    source: "api",
    data: {
      extId: b.extId,
      title: b.title,
      author: b.author,
      folder: b.folder,
    },
  });
  return c.json({ ok: true, extId: b.extId }, 201);
});

async function findBook(extId: string) {
  const rows = await getDb()
    .select()
    .from(mirrorBooks)
    .where(eq(mirrorBooks.extId, extId))
    .limit(1);
  return rows[0] ?? null;
}

v1.get("/books/:extId", async c => {
  const b = await findBook(c.req.param("extId"));
  if (!b) return c.json({ error: "not_found" }, 404);
  return c.json(bookJson(b));
});

v1.patch(
  "/books/:extId",
  zValidator(
    "json",
    z.object({
      title: z.string().min(1).max(255).optional(),
      folder: z.string().max(255).optional(),
    })
  ),
  async c => {
    const extId = c.req.param("extId");
    const b = await findBook(extId);
    if (!b) return c.json({ error: "not_found" }, 404);
    const patch = c.req.valid("json");
    await getDb()
      .update(mirrorBooks)
      .set(patch)
      .where(eq(mirrorBooks.extId, extId));
    fanout({ type: "book.updated", source: "api", data: { extId, ...patch } });
    return c.json({ ok: true });
  }
);

v1.delete("/books/:extId", async c => {
  const extId = c.req.param("extId");
  const b = await findBook(extId);
  if (!b) return c.json({ error: "not_found" }, 404);
  await getDb().delete(mirrorBooks).where(eq(mirrorBooks.extId, extId));
  fanout({
    type: "book.deleted",
    source: "api",
    data: { extId, title: b.title },
  });
  return c.json({ ok: true });
});

v1.get("/books/:extId/chapters", async c => {
  const b = await findBook(c.req.param("extId"));
  if (!b) return c.json({ error: "not_found" }, 404);
  const chapters = JSON.parse(b.chapters) as {
    id: string;
    title: string;
    paragraphs: string[];
  }[];
  return c.json({
    chapters: chapters.map((ch, i) => ({
      index: i,
      id: ch.id,
      title: ch.title,
      paragraphs: ch.paragraphs.length,
      chars: ch.paragraphs.reduce((s, p) => s + p.length, 0),
    })),
  });
});

v1.get("/books/:extId/chapters/:index", async c => {
  const b = await findBook(c.req.param("extId"));
  if (!b) return c.json({ error: "not_found" }, 404);
  const idx = parseInt(c.req.param("index"), 10);
  const chapters = JSON.parse(b.chapters) as {
    id: string;
    title: string;
    paragraphs: string[];
  }[];
  const ch = chapters[idx];
  if (!ch) return c.json({ error: "not_found" }, 404);
  return c.json({ index: idx, ...ch });
});

/* ---------- 全书结构 / 导读缓存 ---------- */

v1.get("/digest/:contentHash", async c => {
  const rows = await getDb()
    .select()
    .from(bookDigests)
    .where(eq(bookDigests.contentHash, c.req.param("contentHash")))
    .limit(1);
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  return c.json(rows[0]);
});

/* ---------- 书摘 / 批注 ---------- */

/** 间隔重复复习状态（与浏览器端 ReviewState 同构） */
const reviewStateSchema = z.object({
  due: z.number(),
  reps: z.number().int().min(0),
  lapses: z.number().int().min(0),
  interval: z.number().min(0),
  lastRating: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
    .optional(),
  lastReviewedAt: z.number().optional(),
  addedAt: z.number(),
});

const highlightBody = z.object({
  extId: z.string().min(1).max(64),
  bookExtId: z.string().max(64).default(""),
  bookTitle: z.string().max(255).default(""),
  chapterTitle: z.string().max(255).default(""),
  text: z.string().min(1).max(20000),
  styleKind: z
    .enum(["underline", "background", "color", "none"])
    .default("underline"),
  styleColor: z.string().max(32).default("orange"),
  note: z.string().max(20000).optional(),
  noteExtId: z.string().max(64).default(""),
  aiQa: z
    .array(z.object({ q: z.string(), a: z.string(), ts: z.number() }))
    .optional(),
  tags: z.array(z.string().min(1).max(64)).max(32).optional(),
  cloze: z.array(z.string().min(1).max(255)).max(32).optional(),
  /** 传入对象 = 加入/更新复习；null = 移出复习；缺省 = 不变 */
  review: reviewStateSchema.nullable().optional(),
});

function highlightJson(h: typeof mirrorHighlights.$inferSelect) {
  return {
    extId: h.extId,
    bookExtId: h.bookExtId,
    bookTitle: h.bookTitle,
    chapterTitle: h.chapterTitle,
    text: h.text,
    style: { kind: h.styleKind, color: h.styleColor },
    note: h.note ?? undefined,
    noteExtId: h.noteExtId || undefined,
    aiQa: h.aiQa ? (JSON.parse(h.aiQa) as unknown[]) : [],
    tags: h.tags ? (JSON.parse(h.tags) as string[]) : [],
    cloze: h.cloze ? (JSON.parse(h.cloze) as string[]) : [],
    review: h.review
      ? (JSON.parse(h.review) as z.infer<typeof reviewStateSchema>)
      : null,
    createdAt: h.createdAt,
  };
}

v1.get("/highlights", async c => {
  const book = c.req.query("book");
  const rows = await getDb().select().from(mirrorHighlights);
  const list = rows.filter(r => book === undefined || r.bookExtId === book);
  return c.json({ highlights: list.map(highlightJson) });
});

v1.post("/highlights", zValidator("json", highlightBody), async c => {
  const h = c.req.valid("json");
  await getDb()
    .insert(mirrorHighlights)
    .values({
      ...h,
      aiQa: h.aiQa ? JSON.stringify(h.aiQa) : null,
      tags: h.tags ? JSON.stringify(h.tags) : null,
      cloze: h.cloze ? JSON.stringify(h.cloze) : null,
      review: h.review ? JSON.stringify(h.review) : null,
    })
    .onDuplicateKeyUpdate({
      set: {
        text: h.text,
        styleKind: h.styleKind,
        styleColor: h.styleColor,
        note: h.note ?? null,
        noteExtId: h.noteExtId,
        aiQa: h.aiQa ? JSON.stringify(h.aiQa) : null,
        tags: h.tags ? JSON.stringify(h.tags) : null,
        cloze: h.cloze ? JSON.stringify(h.cloze) : null,
        review: h.review ? JSON.stringify(h.review) : null,
      },
    });
  fanout({
    type: "highlight.created",
    source: "api",
    data: {
      extId: h.extId,
      bookExtId: h.bookExtId,
      bookTitle: h.bookTitle,
      text: h.text.slice(0, 200),
      note: h.note,
    },
  });
  return c.json({ ok: true, extId: h.extId }, 201);
});

v1.patch(
  "/highlights/:extId",
  zValidator(
    "json",
    z.object({
      note: z.string().max(20000).optional(),
      styleKind: z
        .enum(["underline", "background", "color", "none"])
        .optional(),
      styleColor: z.string().max(32).optional(),
      noteExtId: z.string().max(64).optional(),
      tags: z.array(z.string().min(1).max(64)).max(32).optional(),
      cloze: z.array(z.string().min(1).max(255)).max(32).optional(),
      review: reviewStateSchema.nullable().optional(),
    })
  ),
  async c => {
    const extId = c.req.param("extId");
    const rows = await getDb()
      .select()
      .from(mirrorHighlights)
      .where(eq(mirrorHighlights.extId, extId))
      .limit(1);
    if (!rows[0]) return c.json({ error: "not_found" }, 404);
    const body = c.req.valid("json");
    const patch: Record<string, unknown> = {};
    if (body.note !== undefined) patch.note = body.note;
    if (body.styleKind !== undefined) patch.styleKind = body.styleKind;
    if (body.styleColor !== undefined) patch.styleColor = body.styleColor;
    if (body.noteExtId !== undefined) patch.noteExtId = body.noteExtId;
    if (body.tags !== undefined) patch.tags = JSON.stringify(body.tags);
    if (body.cloze !== undefined) patch.cloze = JSON.stringify(body.cloze);
    if (body.review !== undefined)
      patch.review = body.review ? JSON.stringify(body.review) : null;
    if (Object.keys(patch).length)
      await getDb()
        .update(mirrorHighlights)
        .set(patch)
        .where(eq(mirrorHighlights.extId, extId));
    fanout({
      type: "highlight.updated",
      source: "api",
      data: { extId, ...body },
    });
    if (body.tags !== undefined)
      fanout({
        type: "highlight.tagged",
        source: "api",
        data: { extId, tags: body.tags },
      });
    if (body.review !== undefined)
      fanout({
        type: "review.updated",
        source: "api",
        data: { extId, review: body.review },
      });
    return c.json({ ok: true });
  }
);

/* ---------- 复习 ---------- */

/** 到期复习队列：默认只返回到期卡片，?all=1 返回全部复习卡片 */
v1.get("/review/due", async c => {
  const includeAll = c.req.query("all") === "1";
  const now = Date.now();
  const rows = await getDb().select().from(mirrorHighlights);
  const list = rows
    .map(highlightJson)
    .filter(h => h.review && (includeAll || h.review.due <= now))
    .sort((a, b) => a.review!.due - b.review!.due);
  return c.json({ now, count: list.length, cards: list });
});

v1.delete("/highlights/:extId", async c => {
  const extId = c.req.param("extId");
  const rows = await getDb()
    .select()
    .from(mirrorHighlights)
    .where(eq(mirrorHighlights.extId, extId))
    .limit(1);
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  await getDb()
    .delete(mirrorHighlights)
    .where(eq(mirrorHighlights.extId, extId));
  fanout({
    type: "highlight.deleted",
    source: "api",
    data: { extId, bookTitle: rows[0].bookTitle },
  });
  return c.json({ ok: true });
});

/* ---------- 笔记 ---------- */

const noteBody = z.object({
  extId: z.string().min(1).max(64),
  title: z.string().min(1).max(255),
  content: z.string().max(200000).default(""),
});

v1.get("/notes", async c => {
  const rows = await getDb().select().from(mirrorNotes);
  return c.json({
    notes: rows.map(n => ({
      extId: n.extId,
      title: n.title,
      chars: n.content.length,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
    })),
  });
});

v1.post("/notes", zValidator("json", noteBody), async c => {
  const n = c.req.valid("json");
  await getDb()
    .insert(mirrorNotes)
    .values(n)
    .onDuplicateKeyUpdate({ set: { title: n.title, content: n.content } });
  fanout({
    type: "note.created",
    source: "api",
    data: { extId: n.extId, title: n.title },
  });
  return c.json({ ok: true, extId: n.extId }, 201);
});

v1.get("/notes/:extId", async c => {
  const rows = await getDb()
    .select()
    .from(mirrorNotes)
    .where(eq(mirrorNotes.extId, c.req.param("extId")))
    .limit(1);
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  const n = rows[0];
  return c.json({
    extId: n.extId,
    title: n.title,
    content: n.content,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  });
});

v1.patch("/notes/:extId", zValidator("json", noteBody.partial()), async c => {
  const extId = c.req.param("extId");
  const rows = await getDb()
    .select()
    .from(mirrorNotes)
    .where(eq(mirrorNotes.extId, extId))
    .limit(1);
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  const { extId: _drop, ...patch } = c.req.valid("json");
  await getDb()
    .update(mirrorNotes)
    .set(patch)
    .where(eq(mirrorNotes.extId, extId));
  fanout({
    type: "note.updated",
    source: "api",
    data: { extId, title: patch.title ?? rows[0].title },
  });
  return c.json({ ok: true });
});

v1.delete("/notes/:extId", async c => {
  const extId = c.req.param("extId");
  const rows = await getDb()
    .select()
    .from(mirrorNotes)
    .where(eq(mirrorNotes.extId, extId))
    .limit(1);
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  await getDb().delete(mirrorNotes).where(eq(mirrorNotes.extId, extId));
  return c.json({ ok: true });
});

/* ---------- 文件夹 ---------- */

v1.get("/folders", async c => {
  const rows = await getDb().select().from(mirrorFolders);
  return c.json({
    folders: rows.map(f => ({
      extId: f.extId,
      name: f.name,
      createdAt: f.createdAt,
    })),
  });
});

v1.post(
  "/folders",
  zValidator(
    "json",
    z.object({
      extId: z.string().min(1).max(64),
      name: z.string().min(1).max(255),
    })
  ),
  async c => {
    const f = c.req.valid("json");
    await getDb()
      .insert(mirrorFolders)
      .values(f)
      .onDuplicateKeyUpdate({ set: { name: f.name } });
    fanout({ type: "folder.created", source: "api", data: f });
    return c.json({ ok: true, extId: f.extId }, 201);
  }
);

v1.delete("/folders/:extId", async c => {
  const extId = c.req.param("extId");
  const rows = await getDb()
    .select()
    .from(mirrorFolders)
    .where(eq(mirrorFolders.extId, extId))
    .limit(1);
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  await getDb().delete(mirrorFolders).where(eq(mirrorFolders.extId, extId));
  fanout({
    type: "folder.deleted",
    source: "api",
    data: { extId, name: rows[0].name },
  });
  return c.json({ ok: true });
});

/* ---------- 翻译 ---------- */

const translationBody = z.object({
  extId: z.string().min(1).max(64),
  bookExtId: z.string().max(64).default(""),
  bookTitle: z.string().max(255).default(""),
  chapterTitle: z.string().max(255).default(""),
  targetLang: z.string().min(1).max(32),
  scope: z.enum(["passage", "chapter"]).default("passage"),
  text: z.string().min(1).max(120000),
});

function translationJson(t: typeof mirrorTranslations.$inferSelect) {
  return {
    extId: t.extId,
    bookExtId: t.bookExtId,
    bookTitle: t.bookTitle,
    chapterTitle: t.chapterTitle,
    targetLang: t.targetLang,
    scope: t.scope,
    text: t.text,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

v1.get("/translations", async c => {
  const book = c.req.query("book");
  const rows = await getDb().select().from(mirrorTranslations);
  const list = rows.filter(r => book === undefined || r.bookExtId === book);
  return c.json({ translations: list.map(translationJson) });
});

v1.post("/translations", zValidator("json", translationBody), async c => {
  const t = c.req.valid("json");
  await getDb()
    .insert(mirrorTranslations)
    .values(t)
    .onDuplicateKeyUpdate({
      set: {
        bookExtId: t.bookExtId,
        bookTitle: t.bookTitle,
        chapterTitle: t.chapterTitle,
        targetLang: t.targetLang,
        scope: t.scope,
        text: t.text,
      },
    });
  fanout({
    type: "translation.created",
    source: "api",
    data: {
      extId: t.extId,
      bookExtId: t.bookExtId,
      bookTitle: t.bookTitle,
      chapterTitle: t.chapterTitle,
      targetLang: t.targetLang,
      scope: t.scope,
    },
  });
  return c.json({ ok: true, extId: t.extId }, 201);
});

v1.delete("/translations/:extId", async c => {
  const extId = c.req.param("extId");
  const rows = await getDb()
    .select()
    .from(mirrorTranslations)
    .where(eq(mirrorTranslations.extId, extId))
    .limit(1);
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  await getDb()
    .delete(mirrorTranslations)
    .where(eq(mirrorTranslations.extId, extId));
  return c.json({ ok: true });
});

v1.post(
  "/translate",
  zValidator(
    "json",
    z.object({
      text: z.string().min(1).max(120000),
      targetLang: z
        .enum(["中文", "English", "日本語", "Français", "Deutsch"])
        .default("中文"),
      sourceLang: z.string().max(40).default(""),
      mode: z.enum(["passage", "chapter"]).default("passage"),
      extId: z.string().max(64).optional(),
      bookExtId: z.string().max(64).default(""),
      bookTitle: z.string().max(255).default(""),
      chapterTitle: z.string().max(255).default(""),
    })
  ),
  async c => {
    const q = c.req.valid("json");
    const boundaryRule =
      q.mode === "chapter"
        ? "严格保持输入段落的顺序；相邻译文段落之间用一个空行分隔。不要编号、不要合并或拆分段落。"
        : "保持原文的语气、专名和必要的段落结构。";
    const translation = await askCodex([
      {
        role: "system",
        content: `你是专业的文学与学术翻译。把用户给出的文字翻译成${q.targetLang}。${boundaryRule}只输出译文本身。`,
      },
      {
        role: "user",
        content: `${q.sourceLang ? `原文语言：${q.sourceLang}\n` : ""}待翻译文本：\n${q.text}`,
      },
    ]);
    const extId = q.extId || crypto.randomUUID();
    await getDb()
      .insert(mirrorTranslations)
      .values({
        extId,
        bookExtId: q.bookExtId,
        bookTitle: q.bookTitle,
        chapterTitle: q.chapterTitle,
        targetLang: q.targetLang,
        scope: q.mode,
        text: translation,
      })
      .onDuplicateKeyUpdate({
        set: { text: translation, targetLang: q.targetLang, scope: q.mode },
      });
    fanout({
      type: "translation.created",
      source: "api",
      data: {
        extId,
        bookExtId: q.bookExtId,
        bookTitle: q.bookTitle,
        chapterTitle: q.chapterTitle,
        targetLang: q.targetLang,
        scope: q.mode,
      },
    });
    return c.json({ extId, translation, targetLang: q.targetLang });
  }
);

/* ---------- 脑图 ---------- */

interface MindNodeInput {
  id: string;
  text: string;
  chapterId?: string;
  collapsed?: boolean;
  children: MindNodeInput[];
}

const mindNodeSchema: z.ZodType<MindNodeInput> = z.lazy(() =>
  z.object({
    id: z.string().min(1).max(64),
    text: z.string().min(1).max(255),
    chapterId: z.string().max(64).optional(),
    collapsed: z.boolean().optional(),
    children: z.array(mindNodeSchema).max(200).default([]),
  })
);

const mindmapBody = z.object({
  extId: z.string().min(1).max(64),
  title: z.string().min(1).max(255),
  bookExtId: z.string().max(64).default(""),
  bookTitle: z.string().max(255).default(""),
  root: mindNodeSchema,
});

function mindmapJson(m: typeof mirrorMindmaps.$inferSelect) {
  return {
    extId: m.extId,
    title: m.title,
    bookExtId: m.bookExtId,
    bookTitle: m.bookTitle,
    root: JSON.parse(m.root) as MindNodeInput,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

v1.get("/mindmaps", async c => {
  const book = c.req.query("book");
  const rows = await getDb().select().from(mirrorMindmaps);
  const list = rows.filter(r => book === undefined || r.bookExtId === book);
  return c.json({ mindmaps: list.map(mindmapJson) });
});

v1.post("/mindmaps", zValidator("json", mindmapBody), async c => {
  const m = c.req.valid("json");
  await getDb()
    .insert(mirrorMindmaps)
    .values({ ...m, root: JSON.stringify(m.root) })
    .onDuplicateKeyUpdate({
      set: {
        title: m.title,
        bookExtId: m.bookExtId,
        bookTitle: m.bookTitle,
        root: JSON.stringify(m.root),
      },
    });
  fanout({
    type: "mindmap.created",
    source: "api",
    data: { extId: m.extId, title: m.title, bookExtId: m.bookExtId },
  });
  return c.json({ ok: true, extId: m.extId }, 201);
});

v1.get("/mindmaps/:extId", async c => {
  const rows = await getDb()
    .select()
    .from(mirrorMindmaps)
    .where(eq(mirrorMindmaps.extId, c.req.param("extId")))
    .limit(1);
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  return c.json(mindmapJson(rows[0]));
});

v1.patch(
  "/mindmaps/:extId",
  zValidator("json", mindmapBody.partial()),
  async c => {
    const extId = c.req.param("extId");
    const rows = await getDb()
      .select()
      .from(mirrorMindmaps)
      .where(eq(mirrorMindmaps.extId, extId))
      .limit(1);
    if (!rows[0]) return c.json({ error: "not_found" }, 404);
    const p = c.req.valid("json");
    await getDb()
      .update(mirrorMindmaps)
      .set({
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(p.bookExtId !== undefined ? { bookExtId: p.bookExtId } : {}),
        ...(p.bookTitle !== undefined ? { bookTitle: p.bookTitle } : {}),
        ...(p.root !== undefined ? { root: JSON.stringify(p.root) } : {}),
      })
      .where(eq(mirrorMindmaps.extId, extId));
    fanout({
      type: "mindmap.updated",
      source: "api",
      data: { extId, title: p.title ?? rows[0].title },
    });
    return c.json({ ok: true });
  }
);

v1.delete("/mindmaps/:extId", async c => {
  const extId = c.req.param("extId");
  const rows = await getDb()
    .select()
    .from(mirrorMindmaps)
    .where(eq(mirrorMindmaps.extId, extId))
    .limit(1);
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  await getDb().delete(mirrorMindmaps).where(eq(mirrorMindmaps.extId, extId));
  fanout({
    type: "mindmap.deleted",
    source: "api",
    data: { extId, title: rows[0].title },
  });
  return c.json({ ok: true });
});

/* ---------- Codex 伴读问答 ---------- */

v1.post(
  "/ask",
  zValidator(
    "json",
    z.object({
      question: z.string().min(1).max(20000),
      /** 划线文段（可选） */
      selection: z.string().max(20000).default(""),
      /** 提供 contentHash 时自动带上全书结构与导读（首次则现场生成并缓存） */
      contentHash: z.string().length(64).optional(),
      /** 首次提问时携带全书结构（scanBookStructure 的 JSON 字符串），用于生成导读 */
      structure: z.string().max(100000).optional(),
      title: z.string().max(255).default(""),
      chapterContext: z.string().max(30000).default(""),
      chapterTitle: z.string().max(255).default(""),
      /** 提供后把本次问答追加到该书摘镜像上 */
      highlightExtId: z.string().max(64).optional(),
    })
  ),
  async c => {
    const q = c.req.valid("json");
    let overview = "";
    let structure = q.structure ?? "";

    if (q.contentHash) {
      const rows = await getDb()
        .select()
        .from(bookDigests)
        .where(eq(bookDigests.contentHash, q.contentHash))
        .limit(1);
      if (rows[0]) {
        overview = rows[0].overview ?? "";
        structure = rows[0].structure;
      } else if (q.structure) {
        // 首次提问：基于结构生成导读并入库，之后直接复用
        try {
          overview = await askCodex([
            {
              role: "system",
              content:
                "你是伴读助手。根据书籍的章节结构与摘录，写一段 200 字以内的全书导读，供后续回答读者提问时作为全局背景。只输出导读正文。",
            },
            {
              role: "user",
              content: `《${q.title || "未命名"}》的结构如下：\n${q.structure.slice(0, 12000)}`,
            },
          ]);
        } catch {
          overview = ""; // 导读失败不阻塞问答
        }
        await getDb()
          .insert(bookDigests)
          .values({
            contentHash: q.contentHash,
            title: q.title || "未命名",
            author: "",
            structure: q.structure,
            overview,
          })
          .onDuplicateKeyUpdate({ set: { structure: q.structure, overview } });
      }
    }

    const system = [
      "你是读者的伴读助手，熟悉这本书的全貌。回答紧扣文段与全书，简洁、有依据，中文作答。",
      overview && `【全书导读】\n${overview}`,
      structure && `【全书结构】\n${structure.slice(0, 8000)}`,
      q.chapterContext &&
        `【当前章节《${q.chapterTitle || "?"}》节选】\n${q.chapterContext}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const user = q.selection
      ? `读者划线的文段：\n「${q.selection}」\n\n读者的问题：${q.question}`
      : q.question;

    const answer = await askCodex([
      { role: "system", content: system },
      { role: "user", content: user },
    ]);

    // 落库为问答记录
    if (q.highlightExtId) {
      const rows = await getDb()
        .select()
        .from(mirrorHighlights)
        .where(eq(mirrorHighlights.extId, q.highlightExtId))
        .limit(1);
      if (rows[0]) {
        const qa = rows[0].aiQa ? (JSON.parse(rows[0].aiQa) as unknown[]) : [];
        qa.push({ q: q.question, a: answer, ts: Date.now() });
        await getDb()
          .update(mirrorHighlights)
          .set({ aiQa: JSON.stringify(qa) })
          .where(eq(mirrorHighlights.extId, q.highlightExtId));
      }
    }
    fanout({
      type: "qa.recorded",
      source: "api",
      data: {
        highlightExtId: q.highlightExtId,
        contentHash: q.contentHash,
        question: q.question.slice(0, 200),
      },
    });
    return c.json({ answer, cachedDigest: Boolean(overview && q.contentHash) });
  }
);

/* ---------- 浏览器端事件上报（转发给 WebHook 订阅者） ---------- */

v1.post(
  "/events",
  zValidator(
    "json",
    z.object({
      type: z.string().min(1).max(64),
      data: z.record(z.string(), z.unknown()).default({}),
    })
  ),
  async c => {
    const ev = c.req.valid("json");
    const event: ShufangEvent = {
      type: ev.type,
      data: ev.data,
      source: "reader",
    };
    fanout(event);

    // 阅读动作同时落入镜像库，外部 AI 可读
    try {
      const d = ev.data as Record<string, unknown>;
      if (
        ev.type === "highlight.created" &&
        typeof d.extId === "string" &&
        typeof d.text === "string"
      ) {
        await getDb()
          .insert(mirrorHighlights)
          .values({
            extId: d.extId,
            bookExtId: String(d.bookExtId ?? ""),
            bookTitle: String(d.bookTitle ?? ""),
            chapterTitle: String(d.chapterTitle ?? ""),
            text: d.text,
            styleKind: String(d.styleKind ?? "underline"),
            styleColor: String(d.styleColor ?? "orange"),
            note: typeof d.note === "string" ? d.note : null,
          })
          .onDuplicateKeyUpdate({
            set: {
              note: typeof d.note === "string" ? d.note : null,
              styleKind: String(d.styleKind ?? "underline"),
              styleColor: String(d.styleColor ?? "orange"),
            },
          });
      } else if (
        ev.type === "highlight.updated" &&
        typeof d.extId === "string"
      ) {
        const patch: Record<string, unknown> = {};
        if (typeof d.note === "string") patch.note = d.note;
        if (typeof d.styleKind === "string") patch.styleKind = d.styleKind;
        if (typeof d.styleColor === "string") patch.styleColor = d.styleColor;
        if (Array.isArray(d.aiQa)) patch.aiQa = JSON.stringify(d.aiQa);
        if (Array.isArray(d.tags)) patch.tags = JSON.stringify(d.tags);
        if (Array.isArray(d.cloze)) patch.cloze = JSON.stringify(d.cloze);
        if (Object.keys(patch).length)
          await getDb()
            .update(mirrorHighlights)
            .set(patch)
            .where(eq(mirrorHighlights.extId, d.extId));
      } else if (
        ev.type === "highlight.deleted" &&
        typeof d.extId === "string"
      ) {
        await getDb()
          .delete(mirrorHighlights)
          .where(eq(mirrorHighlights.extId, d.extId));
      } else if (ev.type === "note.deleted" && typeof d.extId === "string") {
        await getDb().delete(mirrorNotes).where(eq(mirrorNotes.extId, d.extId));
      } else if (
        ev.type === "highlight.tagged" &&
        typeof d.extId === "string" &&
        Array.isArray(d.tags)
      ) {
        await getDb()
          .update(mirrorHighlights)
          .set({
            tags: JSON.stringify(
              d.tags.filter((t): t is string => typeof t === "string")
            ),
          })
          .where(eq(mirrorHighlights.extId, d.extId));
      } else if (ev.type === "review.updated" && typeof d.extId === "string") {
        // 浏览器端上报：inReview=false 移出复习；带完整 review 对象则落库
        if (d.inReview === false) {
          await getDb()
            .update(mirrorHighlights)
            .set({ review: null })
            .where(eq(mirrorHighlights.extId, d.extId));
        } else if (d.review && typeof d.review === "object") {
          await getDb()
            .update(mirrorHighlights)
            .set({ review: JSON.stringify(d.review) })
            .where(eq(mirrorHighlights.extId, d.extId));
        } else if (typeof d.due === "number") {
          // 只有评分结果：合并进已有 review
          const rows = await getDb()
            .select()
            .from(mirrorHighlights)
            .where(eq(mirrorHighlights.extId, d.extId))
            .limit(1);
          const cur = rows[0]?.review
            ? (JSON.parse(rows[0].review) as Record<string, unknown>)
            : null;
          if (cur) {
            const next = {
              ...cur,
              due: d.due,
              ...(typeof d.reps === "number" ? { reps: d.reps } : {}),
              ...(typeof d.lapses === "number" ? { lapses: d.lapses } : {}),
              ...(typeof d.rating === "number"
                ? { lastRating: d.rating, lastReviewedAt: Date.now() }
                : {}),
            };
            await getDb()
              .update(mirrorHighlights)
              .set({ review: JSON.stringify(next) })
              .where(eq(mirrorHighlights.extId, d.extId));
          }
        }
      } else if (
        ev.type === "qa.recorded" &&
        typeof d.extId === "string" &&
        Array.isArray(d.aiQa)
      ) {
        await getDb()
          .update(mirrorHighlights)
          .set({ aiQa: JSON.stringify(d.aiQa) })
          .where(eq(mirrorHighlights.extId, d.extId));
      } else if (
        ev.type === "book.imported" &&
        typeof d.extId === "string" &&
        typeof d.title === "string" &&
        Array.isArray(d.chapters)
      ) {
        await getDb()
          .insert(mirrorBooks)
          .values({
            extId: d.extId,
            title: d.title,
            author: String(d.author ?? ""),
            format: String(d.format ?? "unknown"),
            folder: String(d.folder ?? ""),
            contentHash: String(d.contentHash ?? ""),
            chapters: JSON.stringify(d.chapters),
          })
          .onDuplicateKeyUpdate({
            set: { title: d.title, chapters: JSON.stringify(d.chapters) },
          });
      } else if (
        ev.type === "translation.created" &&
        typeof d.extId === "string" &&
        typeof d.text === "string"
      ) {
        await getDb()
          .insert(mirrorTranslations)
          .values({
            extId: d.extId,
            bookExtId: String(d.bookExtId ?? ""),
            bookTitle: String(d.bookTitle ?? ""),
            chapterTitle: String(d.chapterTitle ?? ""),
            targetLang: String(d.targetLang ?? "中文"),
            scope: String(d.scope ?? "passage"),
            text: d.text,
          })
          .onDuplicateKeyUpdate({
            set: {
              text: d.text,
              targetLang: String(d.targetLang ?? "中文"),
              scope: String(d.scope ?? "passage"),
            },
          });
      } else if (
        (ev.type === "mindmap.created" || ev.type === "mindmap.updated") &&
        typeof d.extId === "string" &&
        typeof d.title === "string" &&
        d.root
      ) {
        await getDb()
          .insert(mirrorMindmaps)
          .values({
            extId: d.extId,
            title: d.title,
            bookExtId: String(d.bookExtId ?? ""),
            bookTitle: String(d.bookTitle ?? ""),
            root: JSON.stringify(d.root),
          })
          .onDuplicateKeyUpdate({
            set: {
              title: d.title,
              bookExtId: String(d.bookExtId ?? ""),
              bookTitle: String(d.bookTitle ?? ""),
              root: JSON.stringify(d.root),
            },
          });
      } else if (ev.type === "mindmap.deleted" && typeof d.extId === "string") {
        await getDb()
          .delete(mirrorMindmaps)
          .where(eq(mirrorMindmaps.extId, d.extId));
      }
    } catch {
      /* 镜像失败不影响事件分发 */
    }
    return c.json({ ok: true });
  }
);

/* ---------- WebHook 订阅管理 ---------- */

const webhookBody = z.object({
  url: z.string().url().max(1024),
  secret: z.string().max(255).default(""),
  events: z.array(z.string().max(64)).max(50).default([]),
  description: z.string().max(255).default(""),
});

v1.get("/webhooks", async c => {
  const rows = await getDb().select().from(webhookSubscriptions);
  return c.json({
    webhooks: rows.map(w => ({
      id: w.id,
      url: w.url,
      events: JSON.parse(w.events) as string[],
      active: w.active,
      failCount: w.failCount,
      description: w.description,
      createdAt: w.createdAt,
    })),
  });
});

v1.post("/webhooks", zValidator("json", webhookBody), async c => {
  const w = c.req.valid("json");
  const res = await getDb()
    .insert(webhookSubscriptions)
    .values({
      url: w.url,
      secret: w.secret,
      events: JSON.stringify(w.events),
      description: w.description,
    });
  const id = Number(res[0].insertId);
  return c.json({ ok: true, id }, 201);
});

v1.patch(
  "/webhooks/:id",
  zValidator(
    "json",
    z.object({
      url: z.string().url().max(1024).optional(),
      events: z.array(z.string().max(64)).max(50).optional(),
      active: z.boolean().optional(),
      description: z.string().max(255).optional(),
    })
  ),
  async c => {
    const id = parseInt(c.req.param("id"), 10);
    const rows = await getDb()
      .select()
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.id, id))
      .limit(1);
    if (!rows[0]) return c.json({ error: "not_found" }, 404);
    const p = c.req.valid("json");
    await getDb()
      .update(webhookSubscriptions)
      .set({
        ...(p.url !== undefined ? { url: p.url } : {}),
        ...(p.events !== undefined ? { events: JSON.stringify(p.events) } : {}),
        ...(p.active !== undefined ? { active: p.active } : {}),
        ...(p.description !== undefined ? { description: p.description } : {}),
        failCount: 0,
      })
      .where(eq(webhookSubscriptions.id, id));
    return c.json({ ok: true });
  }
);

v1.delete("/webhooks/:id", async c => {
  const id = parseInt(c.req.param("id"), 10);
  await getDb()
    .delete(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, id));
  return c.json({ ok: true });
});

v1.post("/webhooks/:id/test", async c => {
  const id = parseInt(c.req.param("id"), 10);
  const rows = await getDb()
    .select()
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, id))
    .limit(1);
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  const row = rows[0];
  const payload = JSON.stringify({
    id: crypto.randomUUID(),
    type: "test.ping",
    source: "api",
    timestamp: new Date().toISOString(),
    data: { message: "書房 WebHook 测试" },
  });
  const { createHmac } = await import("node:crypto");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Shufang-Event": "test.ping",
    "User-Agent": "Shufang-Webhook/1.0",
  };
  if (row.secret)
    headers["X-Shufang-Signature"] =
      `sha256=${createHmac("sha256", row.secret).update(payload).digest("hex")}`;
  try {
    const resp = await fetch(row.url, {
      method: "POST",
      headers,
      body: payload,
      signal: AbortSignal.timeout(10000),
    });
    return c.json({ ok: resp.ok, status: resp.status });
  } catch (e) {
    return c.json(
      { ok: false, error: e instanceof Error ? e.message : "deliver failed" },
      502
    );
  }
});
