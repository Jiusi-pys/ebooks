import { z } from "zod";
import { eq } from "drizzle-orm";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { bookDigests } from "@db/schema";
import { askCodex, CODEX_MODEL, CODEX_REASONING_EFFORT } from "./lib/codex";

const targetLanguageSchema = z.enum([
  "中文",
  "English",
  "日本語",
  "Français",
  "Deutsch",
]);

export interface MindTopic {
  title: string;
  children: MindTopic[];
}

/** 从模型输出中提取并约束脑图 JSON；失败时退化为Markdown项目符号解析 */
function parseMindTopics(raw: string, maxTopics: number): MindTopic[] {
  const clean = (value: unknown, depth = 0): MindTopic[] => {
    if (!Array.isArray(value) || depth > 3) return [];
    return value
      .map((item): MindTopic | null => {
        if (!item || typeof item !== "object") return null;
        const rec = item as Record<string, unknown>;
        const title = typeof rec.title === "string" ? rec.title.trim() : "";
        if (!title) return null;
        return {
          title: title.slice(0, 80),
          children: clean(rec.children, depth + 1).slice(0, 10),
        };
      })
      .filter((x): x is MindTopic => x !== null)
      .slice(0, maxTopics);
  };

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1)) as {
        topics?: unknown;
      };
      const topics = clean(parsed.topics);
      if (topics.length) return topics;
    } catch {
      // 继续走 Markdown 兜底
    }
  }

  return raw
    .split(/\r?\n/)
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.、])\s*/, "").trim())
    .filter(line => line.length >= 2)
    .slice(0, maxTopics)
    .map(title => ({ title: title.slice(0, 80), children: [] }));
}

export interface StudyCardDraft {
  title: string;
  note: string;
  cloze: string[];
  tags: string[];
}

export function parseStudyCard(raw: string, source: string): StudyCardDraft {
  const fallback = {
    title: source.trim().slice(0, 40) || "学习卡片",
    note: raw.trim().slice(0, 1000),
    cloze: [] as string[],
    tags: ["AI 制卡"],
  };
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return fallback;
  try {
    const value = JSON.parse(raw.slice(start, end + 1)) as Record<
      string,
      unknown
    >;
    const strings = (input: unknown, max: number) =>
      Array.isArray(input)
        ? input
            .filter((item): item is string => typeof item === "string")
            .map(item => item.trim())
            .filter(Boolean)
            .slice(0, max)
        : [];
    const cloze = strings(value.cloze, 5).filter(item => source.includes(item));
    return {
      title: (typeof value.title === "string" && value.title.trim()
        ? value.title.trim()
        : fallback.title
      ).slice(0, 80),
      note: (typeof value.note === "string"
        ? value.note.trim()
        : fallback.note
      ).slice(0, 1000),
      cloze,
      tags: strings(value.tags, 5).map(item => item.slice(0, 24)),
    };
  } catch {
    return fallback;
  }
}

export const aiRouter = createRouter({
  status: publicQuery.query(async () => {
    const { getCodexAuthStatus } = await import("./lib/codex");
    return {
      model: CODEX_MODEL,
      reasoningEffort: CODEX_REASONING_EFFORT,
      auth: await getCodexAuthStatus(),
    };
  }),

  /** 通用对话补全 */
  chat: publicQuery
    .input(
      z.object({
        messages: z
          .array(
            z.object({
              role: z.enum(["system", "user", "assistant"]),
              content: z.string().min(1).max(60000),
            })
          )
          .min(1)
          .max(24),
      })
    )
    .mutation(async ({ input }) => {
      const content = await askCodex(input.messages);
      return { content };
    }),

  /** 文段 / 章节翻译：只返回译文，不附加解释 */
  translate: publicQuery
    .input(
      z.object({
        text: z.string().min(1).max(120000),
        targetLang: targetLanguageSchema.default("中文"),
        sourceLang: z.string().max(40).default(""),
        mode: z.enum(["passage", "chapter"]).default("passage"),
      })
    )
    .mutation(async ({ input }) => {
      const boundaryRule =
        input.mode === "chapter"
          ? "严格保持输入段落的顺序；相邻译文段落之间用一个空行分隔。不要编号、不要合并或拆分段落。"
          : "保持原文的语气、专名和必要的段落结构。";
      const source = input.sourceLang ? `原文语言：${input.sourceLang}\n` : "";
      const translation = await askCodex([
        {
          role: "system",
          content:
            `你是专业的文学与学术翻译。把用户给出的文字翻译成${input.targetLang}。${boundaryRule}` +
            "只输出译文本身，不输出解释、评论、前言或 Markdown 代码块。",
        },
        { role: "user", content: `${source}待翻译文本：\n${input.text}` },
      ]);
      return { translation, targetLang: input.targetLang };
    }),

  /** 按章节内容提炼脑图分支（输出可 JSON 解析的主题树） */
  mindmap: publicQuery
    .input(
      z.object({
        bookTitle: z.string().min(1).max(255),
        chapterTitle: z.string().min(1).max(255),
        text: z.string().min(1).max(80000),
        maxTopics: z.number().int().min(3).max(12).default(6),
      })
    )
    .mutation(async ({ input }) => {
      const raw = await askCodex([
        {
          role: "system",
          content:
            "你是阅读结构分析助手。从章节内容中提炼适合脑图的主题树。" +
            '只输出 JSON，形如 {"topics":[{"title":"主题","children":[{"title":"要点","children":[]}]}]}。' +
            "标题必须短（不超过24字）、具体、彼此不重复；最多三层。",
        },
        {
          role: "user",
          content: `书籍：《${input.bookTitle}》\n章节：${input.chapterTitle}\n请提炼 ${input.maxTopics} 个以内的一级主题。\n\n章节正文：\n${input.text}`,
        },
      ]);
      return { topics: parseMindTopics(raw, input.maxTopics) };
    }),

  /** 把原文摘录转成统一的摘录/脑图/复习卡草稿。 */
  studyCard: publicQuery
    .input(
      z.object({
        bookTitle: z.string().min(1).max(255),
        chapterTitle: z.string().min(1).max(255),
        text: z.string().min(2).max(20000),
        context: z.string().max(30000).default(""),
      })
    )
    .mutation(async ({ input }) => {
      const raw = await askCodex([
        {
          role: "system",
          content:
            "你是深度阅读制卡助手。把原文转成一张可复习的原子知识卡。" +
            '只输出 JSON：{"title":"概念或问题","note":"简洁解释","cloze":["原文中适合遮挡的连续短语"],"tags":["标签"]}。' +
            "cloze 每项必须逐字出现在原文中；不要编造事实；最多 5 个挖空和 5 个标签。",
        },
        {
          role: "user",
          content: `书籍：《${input.bookTitle}》\n章节：${input.chapterTitle}\n\n原文：\n${input.text}\n\n附近上下文：\n${input.context}`,
        },
      ]);
      return parseStudyCard(raw, input.text);
    }),

  /** 按内容哈希取全书导读 */
  getDigest: publicQuery
    .input(z.object({ contentHash: z.string().length(64) }))
    .query(async ({ input }) => {
      const rows = await getDb()
        .select()
        .from(bookDigests)
        .where(eq(bookDigests.contentHash, input.contentHash))
        .limit(1);
      return rows[0] ?? null;
    }),

  /** 保存全书结构 + AI 导读 */
  saveDigest: publicQuery
    .input(
      z.object({
        contentHash: z.string().length(64),
        title: z.string().min(1).max(255),
        author: z.string().max(255).default(""),
        structure: z.string().min(1),
        overview: z.string().default(""),
      })
    )
    .mutation(async ({ input }) => {
      await getDb()
        .insert(bookDigests)
        .values(input)
        .onDuplicateKeyUpdate({
          set: {
            structure: input.structure,
            overview: input.overview,
            title: input.title,
            author: input.author,
          },
        });
      return { ok: true };
    }),
});
