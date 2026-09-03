import { useState } from "react";
import {
  BookOpen,
  GitBranch,
  GraduationCap,
  Highlighter,
  Import,
  Layers,
  LibraryBig,
  Network,
  PanelLeftClose,
  PanelLeftDashed,
  Pin,
  StickyNote,
} from "lucide-react";
import type { Library } from "@/hooks/useLibrary";
import {
  BOOK_FILE_ACCEPT,
  splitImportFiles,
  SUPPORTED_FORMAT_LABEL,
} from "@/lib/bookFormats";
import { toggleSidebarMode, type SidebarMode } from "@/lib/sidebarMode";
import { citationLevelOf } from "@/lib/citations";
import type { Route } from "@/types";
import { BookCover } from "./BookCover";
import { ImportModeDialog } from "./ImportModeDialog";

const NAV = [
  { view: "library" as const, label: "书架", icon: LibraryBig },
  { view: "notes" as const, label: "笔记", icon: StickyNote },
  { view: "highlights" as const, label: "书摘", icon: Highlighter },
  { view: "mind" as const, label: "脑图", icon: GitBranch },
  { view: "review" as const, label: "复习", icon: GraduationCap },
  { view: "studyset" as const, label: "学习集", icon: Layers },
  { view: "graph" as const, label: "图谱", icon: Network },
];

interface SidebarProps {
  lib: Library;
  mode: SidebarMode;
  open: boolean;
  floating: boolean;
  mobile: boolean;
  onModeChange: (mode: SidebarMode) => void;
  onNavigate: () => void;
  onRequestClose: () => void;
  onInteractionStart: () => void;
  onInteractionEnd: () => void;
}

export function Sidebar({
  lib,
  mode,
  open,
  floating,
  mobile,
  onModeChange,
  onNavigate,
  onRequestClose,
  onInteractionStart,
  onInteractionEnd,
}: SidebarProps) {
  const { route, navigate, books, notes, highlights, mindMaps, studySets } =
    lib;
  const [pendingPdfs, setPendingPdfs] = useState<File[] | null>(null);

  const go = (next: Route) => {
    navigate(next);
    onNavigate();
  };

  const handleImport = (files: File[]) => {
    const { pdfs, others } = splitImportFiles(files);
    if (others.length) void lib.importFiles(others);
    if (pdfs.length) setPendingPdfs(pdfs);
  };
  const today = new Date();
  const contentHighlights = highlights.filter(
    highlight => citationLevelOf(highlight) === "content"
  );
  const counts: Record<string, number> = {
    library: books.length,
    notes: notes.length,
    highlights: contentHighlights.length,
    mind: mindMaps.length,
    review: contentHighlights.filter(
      h => h.review && h.review.due <= today.getTime()
    ).length,
    studyset: studySets.length,
  };
  const dateLine = `${today.getFullYear()} 年 ${today.getMonth() + 1} 月 ${today.getDate()} 日`;

  return (
    <aside
      id="app-sidebar"
      aria-hidden={!open}
      inert={!open}
      onPointerEnter={onInteractionStart}
      onPointerLeave={event => {
        if (!event.currentTarget.matches(":focus-within")) onInteractionEnd();
      }}
      onFocusCapture={onInteractionStart}
      onBlurCapture={event => {
        if (
          !event.currentTarget.contains(event.relatedTarget) &&
          !event.currentTarget.matches(":hover")
        ) {
          onInteractionEnd();
        }
      }}
      className={`flex h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[transform,opacity] duration-200 motion-reduce:transition-none ${
        floating
          ? `fixed inset-y-0 left-0 z-40 shadow-2xl ${
              mobile ? "w-[min(288px,calc(100vw-48px))]" : "w-[232px]"
            } ${
              open
                ? "translate-x-0 opacity-100"
                : "pointer-events-none -translate-x-full opacity-0"
            }`
          : "relative w-[232px]"
      }`}
    >
      <div className="px-5 pb-5 pt-6">
        <div className="flex items-start justify-between gap-2">
          <button onClick={() => go({ view: "library" })} className="text-left">
            <div className="font-reading text-[26px] font-bold leading-none tracking-wide">
              書房
            </div>
            <div className="font-meta mt-2 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              Personal Library
            </div>
            <div className="font-meta mt-1 text-[10px] text-muted-foreground/70">
              NO.001 · {dateLine}
            </div>
          </button>
          {mobile ? (
            <button
              type="button"
              onClick={onRequestClose}
              className="-mr-2 -mt-2 rounded-md p-2 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
              aria-label="关闭侧栏"
              title="关闭侧栏"
            >
              <PanelLeftClose size={16} />
            </button>
          ) : (
            <button
              type="button"
              onClick={event => {
                onModeChange(toggleSidebarMode(mode));
                // Do not let mouse focus keep auto-hide open after the pointer
                // leaves the sidebar.
                if (event.detail > 0) event.currentTarget.blur();
              }}
              className="-mr-2 -mt-2 rounded-md p-2 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={mode === "pinned" ? "切换为自动隐藏" : "固定显示侧栏"}
              aria-pressed={mode === "pinned"}
              title={mode === "pinned" ? "切换为自动隐藏" : "固定显示侧栏"}
            >
              {mode === "pinned" ? (
                <PanelLeftDashed size={16} aria-hidden="true" />
              ) : (
                <Pin size={16} aria-hidden="true" />
              )}
            </button>
          )}
        </div>
      </div>

      <nav className="px-3">
        {NAV.map(({ view, label, icon: Icon }) => {
          const active =
            route.view === view ||
            (view === "notes" && route.view === "note") ||
            (view === "library" && route.view === "reader");
          return (
            <button
              key={view}
              onClick={() => go({ view })}
              className={`group mb-0.5 flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[13.5px] transition-colors ${
                active
                  ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60"
              }`}
            >
              <Icon
                size={16}
                strokeWidth={1.8}
                className={active ? "text-primary" : "text-muted-foreground"}
              />
              <span className="flex-1 text-left">{label}</span>
              {counts[view] !== undefined && (
                <span className="font-meta text-[10px] text-muted-foreground/70">
                  {counts[view]}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="mt-7 flex-1 overflow-y-auto px-3">
        <div className="font-meta px-2.5 pb-2 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70">
          在读 · Reading
        </div>
        {books.slice(0, 6).map(b => (
          <button
            key={b.id}
            onClick={() => {
              lib.openReader(b.id);
              onNavigate();
            }}
            className={`mb-1 flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-sidebar-accent/60 ${
              route.view === "reader" && route.bookId === b.id
                ? "bg-sidebar-accent"
                : ""
            }`}
          >
            <BookCover
              book={b}
              className="h-9 w-7 shrink-0"
              textClass="text-[7px]"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] leading-tight">
                {b.title}
              </span>
              <span className="font-meta block text-[10px] text-muted-foreground/70">
                {b.chapters.length} 章
              </span>
            </span>
            <BookOpen size={13} className="shrink-0 text-muted-foreground/50" />
          </button>
        ))}
        {books.length === 0 && (
          <p className="px-2.5 text-xs leading-6 text-muted-foreground">
            书架还空着，先导入一本书吧。
          </p>
        )}
      </div>

      <div className="border-t border-sidebar-border p-3">
        <label
          className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
          title={`导入 ${SUPPORTED_FORMAT_LABEL}`}
        >
          <Import size={15} strokeWidth={2} />
          导入书籍
          <input
            type="file"
            accept={BOOK_FILE_ACCEPT}
            multiple
            className="hidden"
            onChange={e => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) handleImport(files);
              e.target.value = "";
            }}
          />
        </label>
        <p className="font-meta mt-2 text-center text-[10px] leading-4 text-muted-foreground/60">
          支持 {SUPPORTED_FORMAT_LABEL}
          <br />
          原始文件仅本地；提取正文可写入同源服务端镜像
        </p>
      </div>

      <ImportModeDialog
        files={pendingPdfs}
        onCancel={() => setPendingPdfs(null)}
        onConfirm={modes => {
          const files = pendingPdfs ?? [];
          setPendingPdfs(null);
          void lib.importFiles(files, modes);
        }}
      />
    </aside>
  );
}
