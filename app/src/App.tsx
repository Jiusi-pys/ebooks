import { useCallback, useEffect, useRef, useState } from "react";
import { PanelLeftOpen } from "lucide-react";
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

export default function App() {
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
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="font-reading text-[40px] font-bold tracking-[0.2em] text-foreground">
            書房
          </div>
          <div className="font-meta mt-3 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
            Loading your library…
          </div>
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
        mode={sidebarMode}
        open={sidebarOpen}
        floating={!sidebarPinned}
        mobile={isMobile}
        onModeChange={changeSidebarMode}
        onNavigate={closeTransientSidebar}
        onRequestClose={closeTransientSidebar}
        onInteractionStart={cancelSidebarClose}
        onInteractionEnd={isMobile ? cancelSidebarClose : scheduleSidebarClose}
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
