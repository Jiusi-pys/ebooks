import type { ReactNode } from 'react';
import { CheckSquare, Square, X } from 'lucide-react';

/** 底部悬浮批量操作条：多选模式下出现 */
export function BatchBar({
  count,
  total,
  onSelectAll,
  onExit,
  children,
}: {
  count: number;
  total: number;
  onSelectAll: () => void;
  onExit: () => void;
  children: ReactNode;
}) {
  const allSelected = count > 0 && count === total;
  return (
    <div className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-popover py-2 pl-4 pr-2 shadow-xl">
      <span className="font-meta text-[12px] text-muted-foreground">
        已选 <span className="font-semibold text-foreground">{count}</span> 项
      </span>
      <button
        onClick={onSelectAll}
        className="flex items-center gap-1 rounded-full px-2 py-1 text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground"
      >
        {allSelected ? <CheckSquare size={13} className="text-primary" /> : <Square size={13} />}
        {allSelected ? '全不选' : '全选'}
      </button>
      <span className="h-4 w-px bg-border" />
      {children}
      <span className="h-4 w-px bg-border" />
      <button
        onClick={onExit}
        className="flex items-center gap-1 rounded-full px-2 py-1 text-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground"
      >
        <X size={13} /> 完成
      </button>
    </div>
  );
}

/** 批量操作按钮 */
export function BatchAction({
  onClick,
  disabled,
  danger,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] transition-colors disabled:opacity-35 ${
        danger ? 'text-destructive hover:bg-destructive/10' : 'text-foreground hover:bg-secondary'
      }`}
    >
      {children}
    </button>
  );
}

/** 列表行左侧的多选圆框 */
export function SelectDot({ checked }: { checked: boolean }) {
  return (
    <span
      className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border transition-colors ${
        checked ? 'border-primary bg-primary text-primary-foreground' : 'border-foreground/30 bg-card'
      }`}
    >
      {checked && (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M1.5 5.5L4 8L8.5 2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      )}
    </span>
  );
}
