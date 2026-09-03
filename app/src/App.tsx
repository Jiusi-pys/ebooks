import { useLibrary } from "@/hooks/useLibrary";
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

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar lib={lib} />
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
