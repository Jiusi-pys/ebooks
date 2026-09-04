import { useEffect, useRef } from "react";
import { ArrowLeftRight, ArrowUpDown } from "lucide-react";
import type { TypeSettings } from "@/types";
import {
  PAGE_MARGIN_MAX,
  PAGE_MARGIN_MIN,
  READER_FONTS,
  READER_THEMES,
} from "@/lib/reading";

interface Props {
  value: TypeSettings;
  onChange: (t: TypeSettings) => void;
  onClose: () => void;
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <div className="font-meta mb-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

function Slider({
  min,
  max,
  step,
  value,
  onChange,
  format,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="h-1 flex-1 cursor-pointer accent-[#f54001]"
      />
      <span className="font-meta w-11 text-right text-[11px] text-muted-foreground">
        {format(value)}
      </span>
    </div>
  );
}

/** Apple Books 式排版面板 */
export function TypePanel({ value, onChange, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const set = (patch: Partial<TypeSettings>) =>
    onChange({ ...value, ...patch });

  return (
    <div
      ref={ref}
      className="float-pop absolute right-0 top-11 z-40 w-[300px] rounded-lg border border-border bg-popover p-4"
    >
      {/* 字号 */}
      <Row label="字号">
        <div className="flex items-center justify-between rounded-md border border-border">
          <button
            onClick={() => set({ fontSize: Math.max(14, value.fontSize - 1) })}
            className="flex-1 py-1.5 text-[13px] text-muted-foreground hover:bg-secondary"
          >
            A−
          </button>
          <span className="font-meta text-[12px]">{value.fontSize}px</span>
          <button
            onClick={() => set({ fontSize: Math.min(26, value.fontSize + 1) })}
            className="flex-1 py-1.5 text-[16px] text-muted-foreground hover:bg-secondary"
          >
            A＋
          </button>
        </div>
      </Row>

      {/* 字体 */}
      <Row label="字体">
        <div className="grid grid-cols-4 gap-1.5">
          {READER_FONTS.map(f => (
            <button
              key={f.id}
              onClick={() => set({ fontId: f.id })}
              className={`rounded-md border px-1 py-1.5 text-[12.5px] transition-colors ${
                value.fontId === f.id
                  ? "border-primary bg-accent/40 text-foreground"
                  : "border-border text-muted-foreground hover:bg-secondary"
              }`}
              style={{ fontFamily: f.stack }}
            >
              {f.name}
            </button>
          ))}
        </div>
      </Row>

      {/* 行距 / 字距 */}
      <Row label="行间距">
        <Slider
          min={14}
          max={26}
          step={1}
          value={value.lineHeight * 10}
          onChange={v => set({ lineHeight: v / 10 })}
          format={v => (v / 10).toFixed(1)}
        />
      </Row>
      <Row label="字间距">
        <Slider
          min={0}
          max={12}
          step={1}
          value={value.letterSpacing * 100}
          onChange={v => set({ letterSpacing: v / 100 })}
          format={v => `${v}%`}
        />
      </Row>
      <Row label="页边距">
        <Slider
          min={PAGE_MARGIN_MIN}
          max={PAGE_MARGIN_MAX}
          step={4}
          value={value.pageMargin}
          onChange={v => set({ pageMargin: v })}
          format={v => `${v}px`}
        />
      </Row>

      <Row label="翻页方式">
        <div className="grid grid-cols-2 gap-2 rounded-xl bg-secondary/50 p-1">
          {(
            [
              ["vertical", "上下连续", ArrowUpDown],
              ["horizontal", "左右翻页", ArrowLeftRight],
            ] as const
          ).map(([mode, label, Icon]) => (
            <button
              key={mode}
              type="button"
              aria-pressed={value.pageTurnMode === mode}
              onClick={() => set({ pageTurnMode: mode })}
              className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[12px] transition-all ${
                value.pageTurnMode === mode
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title={
                mode === "vertical"
                  ? "上下连续滚动，到章节边界后继续滚轮可切章"
                  : "按屏幕宽度左右逐页阅读"
              }
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
      </Row>

      {/* 粗细 + 单双栏 */}
      <div className="mb-4 grid grid-cols-2 gap-3">
        <div>
          <div className="font-meta mb-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            粗细
          </div>
          <div className="flex rounded-md border border-border">
            {([300, 400, 600] as const).map((w, i) => (
              <button
                key={w}
                onClick={() => set({ fontWeight: w })}
                className={`flex-1 py-1.5 text-[12px] ${i > 0 ? "border-l border-border" : ""} ${
                  value.fontWeight === w
                    ? "bg-sidebar-accent font-medium"
                    : "text-muted-foreground hover:bg-secondary"
                }`}
                style={{ fontWeight: w }}
              >
                {w === 300 ? "细" : w === 400 ? "常" : "粗"}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="font-meta mb-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            页面
          </div>
          <div className="flex rounded-md border border-border">
            {([1, 2] as const).map((c, i) => (
              <button
                key={c}
                onClick={() => set({ columns: c })}
                className={`flex-1 py-1.5 text-[12px] ${i > 0 ? "border-l border-border" : ""} ${
                  value.columns === c
                    ? "bg-sidebar-accent font-medium"
                    : "text-muted-foreground hover:bg-secondary"
                }`}
              >
                {c === 1 ? "单页" : "双页"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 背景主题 */}
      <Row label="背景">
        <div className="flex gap-2">
          {READER_THEMES.map(t => (
            <button
              key={t.id}
              onClick={() => set({ themeId: t.id })}
              className={`flex h-11 flex-1 flex-col items-center justify-center rounded-md border text-[11px] transition-all ${
                value.themeId === t.id
                  ? "border-primary ring-1 ring-primary"
                  : "border-border"
              }`}
              style={{ background: t.bg, color: t.text }}
            >
              <span className="font-reading text-[13px] font-semibold">文</span>
              {t.name}
            </button>
          ))}
        </div>
      </Row>
    </div>
  );
}
