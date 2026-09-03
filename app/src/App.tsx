import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, PanelLeftOpen, RefreshCw } from "lucide-react";
import { useLibrary } from "@/hooks/useLibrary";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  loadSidebarMode,
  parseSidebarMode,
  saveSidebarMode,
  sidebarIsVisible,
  sidebarOccupiesLayout,
  SIDEBAR_MODE_STORAGE_KEY,
  type SidebarMode,
} from "@/lib/sidebarMode";
import { Sidebar } from "@/components/Sidebar";
import { LibraryView } from "@/components/LibraryView";
import { ReaderView } from "@/components/ReaderView";
import { NotesView } from "@/components/NotesView";
import { NoteEditor } from "@/components/NoteEditor";
import { HighlightsView } from "@/components/HighlightsView";
import { GraphView } from "@/components/GraphView";
import { MindView } from "@/components/MindView";
import { ReviewView } from "@/components/ReviewView";
import { StudySetView } from "@/components/StudySetView";
import { ImportTray } from "@/components/ImportTray";
import { LoginView } from "@/components/LoginView";
import { useAppSession } from "@/lib/appAuth";

export default function App() {
  const auth = useAppSession();

  if (auth.loading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="font-reading text-[40px] font-bold tracking-[0.2em] text-foreground">
            書房
          </div>
          <div className="font-meta mt-3 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
            Verifying your session…
          </div>
        </div>
      </div>
    );
  }

  if (!auth.session?.authenticated || !auth.session.user) {
    return (
      <LoginView
        configured={auth.session?.configured ?? Boolean(auth.error)}
        serverError={auth.error}
        onLogin={auth.login}
        onRetry={auth.refresh}
      />
    );
  }

  return (
    <WorkspaceApp
      key={auth.session.user.id}
      userId={auth.session.user.id}
      onLogout={auth.logout}
    />
  );
}

function WorkspaceApp({
  userId,
  onLogout,
}: {
  userId: string;
  onLogout: () => Promise<void>;
}) {
  const lib = useLibrary();
  const isMobile = useIsMobile();
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(() =>
    loadSidebarMode()
  );
  const [sidebarOverlayOpen, setSidebarOverlayOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  const cancelSidebarClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const closeTransientSidebar = useCallback(() => {
    cancelSidebarClose();
    setSidebarOverlayOpen(false);
    setMobileSidebarOpen(false);
  }, [cancelSidebarClose]);

  const scheduleSidebarClose = useCallback(() => {
    cancelSidebarClose();
    closeTimerRef.current = window.setTimeout(() => {
      setSidebarOverlayOpen(false);
      closeTimerRef.current = null;
    }, 240);
  }, [cancelSidebarClose]);

  const changeSidebarMode = useCallback(
    (mode: SidebarMode) => {
      setSidebarMode(mode);
      saveSidebarMode(mode);
      if (!isMobile) setSidebarOverlayOpen(mode === "auto");
    },
    [isMobile]
  );

  const openSidebar = useCallback(() => {
    cancelSidebarClose();
    if (isMobile) setMobileSidebarOpen(true);
    else setSidebarOverlayOpen(true);
  }, [cancelSidebarClose, isMobile]);

  useEffect(() => {
    const syncSidebarMode = (event: StorageEvent) => {
      if (event.key !== SIDEBAR_MODE_STORAGE_KEY) return;
      setSidebarMode(parseSidebarMode(event.newValue));
      setSidebarOverlayOpen(false);
    };
    window.addEventListener("storage", syncSidebarMode);
    return () => window.removeEventListener("storage", syncSidebarMode);
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeTransientSidebar();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeTransientSidebar]);

  useEffect(() => {
    return () => cancelSidebarClose();
  }, [cancelSidebarClose]);

  if (!lib.ready) {
    const initializationMessage =
      lib.initializationError || lib.databaseIssue?.message;
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="font-reading text-[40px] font-bold tracking-[0.2em] text-foreground">
            書房
          </div>
          {initializationMessage ? (
            <div className="mx-auto mt-6 max-w-md rounded-[18px] border border-destructive/20 bg-card p-5 text-left shadow-lg">
              <p className="flex items-center gap-2 text-sm font-medium text-destructive">
                <AlertTriangle size={16} /> 无法打开本地书库
              </p>
              <p className="mt-2 text-xs leading-6 text-muted-foreground">
                {initializationMessage}
              </p>
              {lib.databaseIssue?.kind === "upgrade-blocked" && (
                <p className="mt-1 text-xs leading-6 text-muted-foreground">
                  请关闭其他仍打开书房的标签页，再重试数据库升级。
                </p>
              )}
              <button
                type="button"
                className="mt-4 inline-flex items-center gap-1.5 rounded-[12px] bg-primary px-4 py-2 text-xs font-medium text-primary-foreground"
                onClick={lib.retryInitialization}
              >
                <RefreshCw size={13} /> 重试
              </button>
            </div>
          ) : (
            <div className="font-meta mt-3 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
              Loading your library…
            </div>
          )}
        </div>
      </div>
    );
  }

  const book = lib.books.find(b => b.id === lib.route.bookId);
  const note = lib.notes.find(n => n.id === lib.route.noteId);
  const sidebarOpen = sidebarIsVisible(
    sidebarMode,
    sidebarOverlayOpen,
    mobileSidebarOpen,
    isMobile
  );
  const sidebarPinned = sidebarOccupiesLayout(sidebarMode, isMobile);

  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-background text-foreground">
      {lib.databaseIssue && (
        <div
          role="status"
          className="fixed left-1/2 top-3 z-[70] flex -translate-x-1/2 items-center gap-2 rounded-[14px] border border-amber-500/25 bg-card/95 px-3 py-2 text-xs shadow-lg backdrop-blur"
        >
          <AlertTriangle size={14} className="text-amber-600" />
          <span>{lib.databaseIssue.message}</span>
          <button
            type="button"
            className="app-icon-button h-7 w-7"
            onClick={lib.retryInitialization}
            aria-label="重新连接本地书库"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      )}
      {isMobile && sidebarOpen && (
        <button
          type="button"
          aria-label="关闭侧栏"
          className="fixed inset-0 z-30 bg-foreground/20 backdrop-blur-[1px]"
          onClick={closeTransientSidebar}
        />
      )}
      <Sidebar
        lib={lib}
        userId={userId}
        mode={sidebarMode}
        open={sidebarOpen}
        floating={!sidebarPinned}
        mobile={isMobile}
        onModeChange={changeSidebarMode}
        onNavigate={closeTransientSidebar}
        onRequestClose={closeTransientSidebar}
        onInteractionStart={cancelSidebarClose}
        onInteractionEnd={isMobile ? cancelSidebarClose : scheduleSidebarClose}
        onLogout={onLogout}
      />
      {!sidebarOpen && (
        <>
          {!isMobile && sidebarMode === "auto" && (
            <div
              aria-hidden="true"
              className="fixed inset-y-0 left-0 z-20 w-2"
              onPointerEnter={event => {
                if (event.pointerType === "mouse") openSidebar();
              }}
            />
          )}
          <button
            type="button"
            aria-label="打开侧栏"
            aria-controls="app-sidebar"
            aria-expanded="false"
            title={
              sidebarMode === "auto"
                ? "打开侧栏（也可移动到左侧边缘）"
                : "打开侧栏"
            }
            onClick={openSidebar}
            className="fixed left-0 top-1/2 z-30 flex h-14 w-8 -translate-y-1/2 items-center justify-center rounded-r-lg border border-l-0 border-sidebar-border bg-sidebar/95 text-muted-foreground shadow-md backdrop-blur transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <PanelLeftOpen size={17} />
          </button>
        </>
      )}
      <main className="min-w-0 flex-1 bg-background">
        {lib.route.view === "library" && <LibraryView lib={lib} />}
        {lib.route.view === "reader" &&
          (book ? (
            <ReaderView key={book.id} lib={lib} book={book} />
          ) : (
            <LibraryView lib={lib} />
          ))}
        {lib.route.view === "notes" && <NotesView lib={lib} />}
        {lib.route.view === "note" &&
          (note ? (
            <NoteEditor key={note.id} lib={lib} note={note} />
          ) : (
            <NotesView lib={lib} />
          ))}
        {lib.route.view === "highlights" && <HighlightsView lib={lib} />}
        {lib.route.view === "mind" && <MindView lib={lib} />}
        {lib.route.view === "review" && <ReviewView lib={lib} />}
        {lib.route.view === "studyset" && <StudySetView lib={lib} />}
        {lib.route.view === "graph" && <GraphView lib={lib} />}
      </main>
      <ImportTray lib={lib} />
    </div>
  );
}
