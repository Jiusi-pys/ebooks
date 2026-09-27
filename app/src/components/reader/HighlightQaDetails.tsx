import type { Highlight } from "@/types";
import { ChevronLeft, PanelRightOpen } from "lucide-react";

export function HighlightQaDetails({
  qa,
  onBack,
  onContinue,
}: {
  qa: NonNullable<Highlight["aiQa"]>;
  onBack: () => void;
  onContinue: () => void;
}) {
  return (
    <section aria-label="文段问答详情" className="flex min-h-0 flex-col">
      <div className="mb-2 flex items-center justify-between border-b border-border pb-2">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft size={14} />
          返回文段
        </button>
        <span className="text-xs font-medium">完整问答 · {qa.length} 轮</span>
      </div>
      <div
        className="max-h-[min(55vh,420px)] overflow-y-auto overscroll-contain space-y-4 pr-1"
        tabIndex={0}
        aria-label="完整问答记录"
      >
        {qa.map((turn, index) => (
          <article
            key={`${turn.ts}-${index}`}
            className="space-y-2 text-[13px] leading-6"
          >
            <div className="whitespace-pre-wrap break-words rounded-md bg-primary/10 p-2.5">
              <span className="mb-1 block text-[10px] text-primary">
                第 {index + 1} 轮 · 提问
              </span>
              {turn.q}
            </div>
            <div className="whitespace-pre-wrap break-words rounded-md bg-secondary/50 p-2.5">
              {turn.a}
            </div>
          </article>
        ))}
      </div>
      <button
        onClick={onContinue}
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground"
      >
        <PanelRightOpen size={14} />
        到右侧继续追问
      </button>
    </section>
  );
}
