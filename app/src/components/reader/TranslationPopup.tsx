import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Languages, Loader2, X } from "lucide-react";
import type { ReaderTheme } from "@/types";
import { trpc } from "@/providers/trpc";
import { friendlyAiError } from "@/lib/aiError";
import { useAiConfig } from "@/lib/aiConfig";

export type TranslationLang =
  "中文" | "English" | "日本語" | "Français" | "Deutsch";

const LANGS: TranslationLang[] = ["中文", "English", "日本語"];

interface Props {
  top: number;
  left: number;
  sourceText: string;
  bookTitle: string;
  chapterTitle: string;
  theme: ReaderTheme;
  onSave: (translation: string, targetLang: TranslationLang) => void;
  onClose: () => void;
}

/** 划选即时翻译气泡：自动判断中英方向，可切换目标语言并保存为批注 */
export function TranslationPopup({
  top,
  left,
  sourceText,
  bookTitle,
  chapterTitle,
  theme,
  onSave,
  onClose,
}: Props) {
  const defaultLang: TranslationLang = /[\u3400-\u9fff]/.test(sourceText)
    ? "English"
    : "中文";
  const [lang, setLang] = useState<TranslationLang>(defaultLang);
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const utils = trpc.useUtils();
  const [aiConfig] = useAiConfig();
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node))
        onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const run = useCallback(
    async (target: TranslationLang) => {
      setLang(target);
      setLoading(true);
      setError("");
      setSaved(false);
      try {
        const resp = await utils.client.ai.translate.mutate({
          config: aiConfig,
          text: sourceText,
          targetLang: target,
          mode: "passage",
        });
        setResult(resp.translation);
      } catch (e) {
        setResult("");
        setError(friendlyAiError(e, "翻译服务暂时不可用，请稍后再试。"));
      } finally {
        setLoading(false);
      }
    },
    [sourceText, utils, aiConfig]
  );

  useEffect(() => {
    void run(defaultLang);
    // 弹层按一次划选挂载一次；语言切换由按钮显式触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceText]);

  return (
    <div
      ref={boxRef}
      className="float-pop absolute z-40 w-[360px] -translate-x-1/2 rounded-lg border"
      style={{
        top,
        left,
        background: theme.panel,
        borderColor: theme.border,
        color: theme.text,
      }}
      onMouseDown={e => e.stopPropagation()}
    >
      <div
        className="flex h-10 items-center gap-2 border-b px-3"
        style={{ borderColor: theme.border }}
      >
        <Languages size={14} className="text-primary" />
        <span className="text-[12.5px] font-medium">即时翻译</span>
        <div className="ml-auto flex items-center gap-1">
          {LANGS.map(l => (
            <button
              key={l}
              onClick={() => void run(l)}
              disabled={loading}
              className={`rounded-full px-2 py-1 text-[11px] transition-opacity hover:opacity-75 disabled:opacity-40 ${
                lang === l ? "bg-primary text-primary-foreground" : ""
              }`}
              style={lang === l ? undefined : { color: theme.muted }}
            >
              {l === "中文" ? "中" : l === "English" ? "EN" : "日"}
            </button>
          ))}
          <button
            onClick={onClose}
            className="rounded p-1 hover:opacity-70"
            style={{ color: theme.muted }}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="max-h-[320px] overflow-y-auto p-3">
        <div className="rounded-md border-l-[3px] border-primary/70 py-1 pl-2.5">
          <div className="font-reading text-[12.5px] leading-6 opacity-75">
            {sourceText.length > 160
              ? sourceText.slice(0, 160) + "…"
              : sourceText}
          </div>
          <div
            className="font-meta mt-1 text-[9.5px]"
            style={{ color: theme.muted }}
          >
            《{bookTitle}》· {chapterTitle}
          </div>
        </div>

        <div
          className="mt-3 min-h-20 rounded-md p-3 text-[13px] leading-7"
          style={{ background: theme.bg }}
        >
          {loading ? (
            <span
              className="flex items-center gap-2 text-[12px]"
              style={{ color: theme.muted }}
            >
              <Loader2 size={14} className="animate-spin text-primary" /> Codex
              正在翻译…
            </span>
          ) : error ? (
            <span className="text-[12px] text-destructive">{error}</span>
          ) : (
            <span className="whitespace-pre-wrap">{result}</span>
          )}
        </div>
      </div>

      <div
        className="flex items-center justify-between border-t px-3 py-2"
        style={{ borderColor: theme.border }}
      >
        <span className="font-meta text-[9.5px]" style={{ color: theme.muted }}>
          {lang} · 可保存为命名批注
        </span>
        <button
          onClick={() => {
            if (!result) return;
            onSave(result, lang);
            setSaved(true);
          }}
          disabled={!result || loading || saved}
          className="flex items-center gap-1 rounded-full bg-primary px-3 py-1 text-[12px] font-medium text-primary-foreground disabled:opacity-40"
        >
          {saved ? <Check size={12} /> : null}
          {saved ? "已保存" : "存为批注"}
        </button>
      </div>
    </div>
  );
}
