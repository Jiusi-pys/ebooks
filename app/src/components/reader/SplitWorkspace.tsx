import type { ReactNode } from "react";
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
  onSplit: (paneId: string, direction: SplitDirection) => void;
  onChange: (paneId: string, target: SplitTarget) => void;
  onClose: (paneId: string) => void;
}) {
  if (node.kind === "main") return <>{main}</>;
  if (node.kind === "reference") {
    return (
      <SplitPane
        books={books}
        value={node.target}
        onChange={target => onChange(node.id, target)}
        onClose={() => onClose(node.id)}
        onSplit={direction => onSplit(node.id, direction)}
        canSplit={canSplit}
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
          onSplit={onSplit}
          onChange={onChange}
          onClose={onClose}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
