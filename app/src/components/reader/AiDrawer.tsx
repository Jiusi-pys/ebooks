import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  BookOpenCheck,
  BrainCircuit,
  Loader2,
  Send,
  Settings2,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import type { Book, Chapter, Highlight, ReaderTheme } from "@/types";
import { trpc } from "@/lib/trpc-client";
import { contentHashOfBook, scanBookStructure } from "@/lib/reading";
import { AI_PROVIDERS, useAiConfig } from "@/lib/aiConfig";
import { AiSettingsPanel } from "./AiSettingsPanel";

interface Props {
  book: Book;
  chapter: Chapter;
  /** 本次问答锚定的文段（可能刚创建，aiQa 会增长） */
  target: Highlight;
  theme: ReaderTheme;
  onSaveQa: (qa: { q: string; a: string; ts: number }) => void;
  onApplyStudyCard: (card: {
    title: string;
    note: string;
    cloze: string[];
    tags: string[];
  }) => Promise<void>;
  headerAction?: ReactNode;
  onClose: () => void;
}

type Phase = "digest" | "ready" | "asking";

/** 截取章节正文作为上下文（控制 token 规模） */
function chapterContext(chapter: Chapter, aroundText: string): string {
  const full = chapter.paragraphs.join("\n");
  if (full.length <= 7000) return full;
  const idx = full.indexOf(aroundText.slice(0, 40));
  const center = idx >= 0 ? idx : 0;
  const start = Math.max(0, center - 3500);
  return full.slice(start, start + 7000);
}

export function AiDrawer({
  book,
  chapter,
  target,
  theme,
  onSaveQa,
  onApplyStudyCard,
  headerAction,
  onClose,
}: Props) {
  const [phase, setPhase] = useState<Phase>("digest");
  const [digestLine, setDigestLine] = useState("正在扫描全书结构…");
  const [digest, setDigest] = useState<{
    structure: string;
    overview: string;
  } | null>(null);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [aiConfig, setAiConfig] = useAiConfig();
  const utils = trpc.useUtils();

  /* 把后端原始错误转成读者可读的提示 */
  const friendlyError = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("DeepSeek API Key 未配置"))
      return "请在 AI 后台设置中填写 DeepSeek API Key。";
    if (msg.includes("api_key_path_forbidden") || msg.includes("(403)"))
      return "Codex CLI 尚未使用 ChatGPT 登录，请先在本机运行 codex login。";
    if (msg.includes("(401)"))
      return "模型服务凭证失效，请重新保存版本后再试。";
    if (msg.toLowerCase().includes("fetch") || msg.includes("(500)"))
      return "网络波动，模型服务暂时不可用，请稍后再试。";
    return "提问失败，请重试";
  };
  const listRef = useRef<HTMLDivElement>(null);

  const qaList = useMemo(() => target.aiQa ?? [], [target.aiQa]);

  /* 首次提问：扫描全书 → 缓存结构 → 生成导读（已有缓存则直接复用） */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const hash = book.contentHash ?? (await contentHashOfBook(book));
        const existing = await utils.client.ai.getDigest.query({
          contentHash: hash,
        });
        if (cancelled) return;
        if (existing) {
          setDigest({
            structure: existing.structure,
            overview: existing.overview ?? "",
          });
          setPhase("ready");
          return;
        }
        setDigestLine("首次提问：正在通读全书，提炼结构…");
        const structure = JSON.stringify(scanBookStructure(book), null, 1);
        setDigestLine(
          `正在请 ${AI_PROVIDERS[aiConfig.provider].label} 为全书写导读…`
        );
        let overview = "";
        try {
          const resp = await utils.client.ai.chat.mutate({
            config: aiConfig,
            messages: [
              {
                role: "system",
                content:
                  "你是一位资深编辑。根据给出的书籍结构信息（目录、各章字数与开篇摘录），用中文写一段 200 字以内的全书导读：说明这本书大概讲什么、结构如何组织、阅读时值得留意的线索。只输出导读正文。",
              },
              { role: "user", content: structure },
            ],
          });
          overview = resp.content;
        } catch {
          // 导读生成失败不阻塞：结构仍会缓存，问答仍带全书结构上下文
        }
        if (cancelled) return;
        await utils.client.ai.saveDigest.mutate({
          contentHash: hash,
          title: book.title,
          author: book.author,
          structure,
          overview,
        });
        setDigest({ structure, overview });
        setPhase("ready");
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "初始化失败");
          setPhase("ready");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id, aiConfig.provider, aiConfig.model, aiConfig.effort]);

  useEffect(() => {
    listRef.current?.scrollTo({
      top: listRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [qaList.length, phase]);

  const ask = useCallback(async () => {
    const q = input.trim();
    if (!q || phase === "asking") return;
    setInput("");
    setError("");
    setPhase("asking");
    try {
      const system = [
        `你是《${book.title}》的 AI 伴读助手。请结合全书信息与当前章节内容，用中文简洁准确地回答读者对划线文段的疑问。`,
        digest?.overview ? `【全书导读】\n${digest.overview}` : "",
        digest?.structure
          ? `【全书结构】\n${digest.structure.slice(0, 3000)}`
          : "",
        `【当前章节《${chapter.title}》节选】\n${chapterContext(chapter, target.text)}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      const user = `读者划线的文段：\n「${target.text}」\n\n读者的问题：${q}`;
      const { content } = await utils.client.ai.chat.mutate({
        config: aiConfig,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      onSaveQa({ q, a: content, ts: Date.now() });
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setPhase("ready");
    }
  }, [
    input,
    phase,
    book.title,
    chapter,
    target.text,
    digest,
    utils,
    onSaveQa,
    aiConfig,
  ]);

  const makeStudyCard = useCallback(async () => {
    if (phase !== "ready") return;
    setError("");
    setPhase("asking");
    try {
      const card = await utils.client.ai.studyCard.mutate({
        config: aiConfig,
        bookTitle: book.title,
        chapterTitle: chapter.title,
        text: target.text,
        context: chapterContext(chapter, target.text),
      });
      await onApplyStudyCard(card);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setPhase("ready");
    }
  }, [
    phase,
    utils,
    book.title,
    chapter,
    target.text,
    onApplyStudyCard,
    aiConfig,
  ]);

  return (
    <div
      className="relative flex h-full w-full min-w-0 flex-col"
      style={{
        background: theme.panel,
        borderColor: theme.border,
        color: theme.text,
      }}
    >
      <div
        className="flex h-11 shrink-0 items-center gap-2 border-b px-4"
        style={{ borderColor: theme.border }}
      >
        <Sparkles size={15} className="text-primary" />
        <span className="text-[13px] font-medium">AI 伴读</span>
        <span
          className="font-meta min-w-0 truncate text-[10px]"
          style={{ color: theme.muted }}
        >
          {aiConfig.provider} · {aiConfig.model.replace(/^deepseek-|^gpt-/, "")}{" "}
          · {aiConfig.effort}
        </span>
        {headerAction}
        <button
          onClick={() => setShowSettings(value => !value)}
          className={`rounded p-1 ${headerAction ? "" : "ml-auto"} ${showSettings ? "bg-primary/10 text-primary" : "hover:opacity-70"}`}
          style={{ color: showSettings ? undefined : theme.muted }}
          title="AI 后台设置"
          aria-label="AI 后台设置"
        >
          <Settings2 size={15} />
        </button>
        <button
          onClick={onClose}
          className="rounded p-1 hover:opacity-70"
          style={{ color: theme.muted }}
        >
          <X size={15} />
        </button>
      </div>

      {showSettings && (
        <AiSettingsPanel
          value={aiConfig}
          onChange={setAiConfig}
          theme={theme}
        />
      )}

      {/* 文段锚点 */}
      <div
        className="shrink-0 border-b px-4 py-3"
        style={{ borderColor: theme.border }}
      >
        <div
          className="font-reading rounded-md border-l-[3px] border-primary p-2.5 text-[12.5px] leading-6"
          style={{ background: theme.bg }}
        >
          {target.text.length > 120
            ? target.text.slice(0, 120) + "…"
            : target.text}
        </div>
        <div
          className="font-meta mt-1.5 text-[10px]"
          style={{ color: theme.muted }}
        >
          《{book.title}》· {chapter.title}
        </div>
      </div>

      {/* 对话区 */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3">
        {phase === "digest" && (
          <div
            className="flex items-center gap-2 rounded-md p-3 text-[12.5px]"
            style={{ background: theme.bg, color: theme.muted }}
          >
            <Loader2 size={14} className="animate-spin text-primary" />
            {digestLine}
          </div>
        )}
        {digest?.overview && (
          <div
            className="mb-3 rounded-md p-3 text-[12px] leading-6"
            style={{ background: theme.bg }}
          >
            <div
              className="font-meta mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em]"
              style={{ color: theme.muted }}
            >
              <BookOpenCheck size={11} /> 全书导读（已缓存，后续提问直接复用）
            </div>
            {digest.overview}
          </div>
        )}
        {qaList.map((qa, i) => (
          <div key={i} className="mb-3">
            <div className="ml-8 rounded-md bg-primary p-2.5 text-[12.5px] leading-6 text-primary-foreground">
              {qa.q}
            </div>
            <div
              className="mt-1.5 mr-4 whitespace-pre-wrap rounded-md p-2.5 text-[12.5px] leading-6"
              style={{ background: theme.bg }}
            >
              {qa.a}
            </div>
          </div>
        ))}
        {phase === "asking" && (
          <div
            className="flex items-center gap-2 p-2 text-[12px]"
            style={{ color: theme.muted }}
          >
            <Loader2 size={13} className="animate-spin" /> AI 正在结合全书思考…
          </div>
        )}
        {error && (
          <div className="rounded-md bg-destructive/10 p-2.5 text-[12px] text-destructive">
            {error}
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div
        className="shrink-0 border-t p-3"
        style={{ borderColor: theme.border }}
      >
        <div className="mb-2 grid grid-cols-2 gap-1.5">
          <button
            onClick={() =>
              setInput("解释这段话的核心概念，并说明它与本章主线的关系。")
            }
            disabled={phase !== "ready"}
            className="flex items-center justify-center gap-1 rounded-md border px-2 py-1.5 text-[11px] disabled:opacity-40"
            style={{ borderColor: theme.border }}
          >
            <BrainCircuit size={11} /> 深入解释
          </button>
          <button
            onClick={() => void makeStudyCard()}
            disabled={phase !== "ready"}
            className="flex items-center justify-center gap-1 rounded-md bg-primary px-2 py-1.5 text-[11px] font-medium text-primary-foreground disabled:opacity-40"
          >
            <WandSparkles size={11} /> AI 制卡
          </button>
        </div>
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask();
              }
            }}
            placeholder={
              phase === "digest" ? "等待全书扫描完成…" : "就这段文字向 AI 提问…"
            }
            disabled={phase === "digest"}
            rows={2}
            className="flex-1 resize-none rounded-md border p-2 text-[13px] leading-6 outline-none focus:border-primary/60 disabled:opacity-50"
            style={{
              background: theme.bg,
              borderColor: theme.border,
              color: theme.text,
            }}
          />
          <button
            onClick={ask}
            disabled={!input.trim() || phase !== "ready"}
            className="rounded-full bg-primary p-2 text-primary-foreground transition-opacity disabled:opacity-40"
          >
            <Send size={14} />
          </button>
        </div>
        <div
          className="font-meta mt-1.5 text-[9.5px]"
          style={{ color: theme.muted }}
        >
          回答会记录在这条文段上 · Enter 发送
        </div>
      </div>
    </div>
  );
}
