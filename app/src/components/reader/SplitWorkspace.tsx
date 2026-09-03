import type { ReactNode } from "react";
import { Columns2 } from "lucide-react";
import type { Book, ReaderTheme, TypeSettings } from "@/types";
import type { ReaderPane, SplitDirection } from "@/lib/splitLayout";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { SplitPane, type SplitTarget } from "./SplitPane";

export function SplitWorkspace({
  node,
  main,
  books,
  theme,
  type,
  canSplit,
  scopeLabel,
  showMainSplitControls = true,
  onSplit,
  onChange,
  onClose,
}: {
  node: ReaderPane;
  main: ReactNode;
  books: Book[];
  theme: ReaderTheme;
  type: TypeSettings;
  canSplit: boolean;
  scopeLabel?: string;
  showMainSplitControls?: boolean;
  onSplit: (paneId: string, direction: SplitDirection) => void;
  onChange: (paneId: string, target: SplitTarget) => void;
  onClose: (paneId: string) => void;
}) {
  if (node.kind === "main") {
    return (
      <div className="relative h-full min-h-0 min-w-0">
        {main}
        {showMainSplitControls && (
          <div
            className="absolute right-3 top-14 z-30 flex overflow-hidden rounded-full border shadow-sm"
            style={{ borderColor: theme.border, background: theme.panel }}
          >
            <button
              onClick={() => onSplit(node.id, "horizontal")}
              disabled={!canSplit}
              className="flex items-center gap-1 px-2.5 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-35"
              style={{ color: theme.muted }}
              title={canSplit ? "向右拆分主窗格" : "最多支持 4 个窗格"}
            >
              <Columns2 size={11} /> 左右
            </button>
            <button
              onClick={() => onSplit(node.id, "vertical")}
              disabled={!canSplit}
              className="flex items-center gap-1 border-l px-2.5 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-35"
              style={{ borderColor: theme.border, color: theme.muted }}
              title={canSplit ? "向下拆分主窗格" : "最多支持 4 个窗格"}
            >
              <Columns2 className="rotate-90" size={11} /> 上下
            </button>
          </div>
        )}
      </div>
    );
  }
  if (node.kind === "reference") {
    return (
      <SplitPane
        books={books}
        value={node.target}
        onChange={target => onChange(node.id, target)}
        onClose={() => onClose(node.id)}
        onSplit={direction => onSplit(node.id, direction)}
        canSplit={canSplit}
        scopeLabel={scopeLabel}
        theme={theme}
        type={type}
      />
    );
  }

  return (
    <ResizablePanelGroup
      orientation={node.direction}
      className="min-h-0 min-w-0"
      id={node.id}
    >
      <ResizablePanel defaultSize="50%" minSize="20%">
        <SplitWorkspace
          node={node.first}
          main={main}
          books={books}
          theme={theme}
          type={type}
          canSplit={canSplit}
          scopeLabel={scopeLabel}
          showMainSplitControls={showMainSplitControls}
          onSplit={onSplit}
          onChange={onChange}
          onClose={onClose}
        />
      </ResizablePanel>
      <ResizableHandle withHandle className="z-20 bg-primary/25" />
      <ResizablePanel defaultSize="50%" minSize="20%">
        <SplitWorkspace
          node={node.second}
          main={main}
          books={books}
          theme={theme}
          type={type}
          canSplit={canSplit}
          scopeLabel={scopeLabel}
          showMainSplitControls={showMainSplitControls}
          onSplit={onSplit}
          onChange={onChange}
          onClose={onClose}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
