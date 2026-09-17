import { useMemo, useRef, useState, type DragEvent } from "react";
import {
  BookOpenText,
  BookUp2,
  CheckSquare,
  ChevronLeft,
  FileText,
  FolderPlus,
  FolderInput,
  ImagePlus,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  Shapes,
  Trash2,
} from "lucide-react";
import type { Library } from "@/hooks/useLibrary";
import {
  BOOK_FILE_ACCEPT,
  splitImportFiles,
  SUPPORTED_FORMAT_LABEL,
} from "@/lib/bookFormats";
import type { Book, Folder } from "@/types";
import { BookCover } from "./BookCover";
import { LibrarySyncButton } from "./LibrarySyncButton";
import { FolderGlyph } from "./FolderGlyph";
import { FOLDER_ICON_OPTIONS } from "@/lib/folderIcons";
import { BatchAction, BatchBar, SelectDot } from "./BatchBar";
import { ImportModeDialog } from "./ImportModeDialog";
import { useSelection } from "@/hooks/useSelection";
import { citationLevelOf } from "@/lib/citations";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { prepareCoverImage } from "@/lib/coverImage";
import { BookMetadataDialog } from "./BookMetadataDialog";

function bookProgress(b: Book): number {
  const idx = b.chapters.findIndex(c => c.id === b.progress.chapterId);
  if (idx < 0 || b.chapters.length === 0) return 0;
  return Math.round(((idx + b.progress.ratio) / b.chapters.length) * 100);
}

/* ---------- 重命名对话框（书 / 文件夹共用） ---------- */

function RenameDialog({
  open,
  title,
  initial,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  initial: string;
  onSubmit: (v: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? initial;

  const close = () => {
    setDraft(null);
    onClose();
  };

  const submit = () => {
    const v = value.trim();
    if (v) onSubmit(v);
    close();
  };

  return (
    <Dialog open={open} onOpenChange={o => !o && close()}>
      <DialogContent className="max-w-sm bg-card">
        <DialogHeader>
          <DialogTitle className="text-[15px]">{title}</DialogTitle>
        </DialogHeader>
        <input
          autoFocus
          value={value}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") submit();
          }}
          onFocus={e => e.target.select()}
          className="w-full rounded-md border border-foreground/20 bg-background px-3 py-2 text-sm outline-none focus:border-primary"
        />
        <div className="mt-1 flex justify-end gap-2">
          <button
            onClick={close}
            className="rounded-md px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground"
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={!value.trim()}
            className="rounded-md bg-primary px-4 py-1.5 text-[13px] font-medium text-primary-foreground disabled:opacity-40"
          >
            确定
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ---------- 书籍卡片 ---------- */

function BookCard({
  book,
  folders,
  lib,
  selecting,
  checked,
  onToggleSelect,
}: {
  book: Book;
  folders: Folder[];
  lib: Library;
  selecting: boolean;
  checked: boolean;
  onToggleSelect: () => void;
}) {
  const pct = bookProgress(book);
  const [metadataEditing, setMetadataEditing] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const coverInputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      className="group relative"
      draggable={!selecting}
      onDragStart={e => {
        e.dataTransfer.setData("text/x-book-id", book.id);
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      <button
        onClick={() => (selecting ? onToggleSelect() : lib.openReader(book.id))}
        className="block w-full text-left"
      >
        <div className="relative">
          <BookCover
            book={book}
            className={`aspect-[3/4.2] w-full transition-transform duration-200 group-hover:-translate-y-1.5 ${
              checked
                ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
                : ""
            }`}
          />
          {selecting && (
            <span className="absolute left-2 top-2 z-10">
              <SelectDot checked={checked} />
            </span>
          )}
        </div>
        <div className="mt-3">
          <div
            className="truncate text-[13.5px] font-medium leading-snug"
            title={book.title}
          >
            {book.title}
          </div>
          <div className="font-meta mt-1 flex items-center gap-2 text-[10.5px] text-muted-foreground">
            <FileText size={10} />
            <span>{book.author || "佚名"}</span>
            <span>·</span>
            <span>{book.chapters.length} 章</span>
          </div>
          <div className="mt-2 h-[3px] w-full overflow-hidden rounded-full bg-foreground/10">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </button>

      {/* 操作菜单 */}
      {!selecting && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              onClick={e => e.stopPropagation()}
              className="absolute right-2 top-2 hidden rounded-full bg-card/90 p-1.5 text-muted-foreground shadow hover:text-foreground group-hover:block"
              title="更多操作"
            >
              <MoreHorizontal size={13} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48 bg-card">
            <DropdownMenuItem onClick={() => setMetadataEditing(true)}>
              <Pencil size={13} className="mr-2" /> 编辑元数据
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={coverBusy}
              onClick={() => coverInputRef.current?.click()}
            >
              <ImagePlus size={13} className="mr-2" />
              {coverBusy ? "正在处理封面…" : "自定义封面"}
            </DropdownMenuItem>
            {book.customCover && (
              <DropdownMenuItem
                onClick={() => void lib.setBookCustomCover(book.id)}
              >
                <RotateCcw size={13} className="mr-2" /> 恢复书籍封面
              </DropdownMenuItem>
            )}
            {book.format === "pdf" && (
              <DropdownMenuItem
                onClick={async () => {
                  const target =
                    book.readerMode === "original" ? "reflow" : "original";
                  const ok = await lib.setReaderMode(book.id, target);
                  if (!ok)
                    alert(
                      "未找到该书的原始 PDF 文件（可能是旧版本导入），无法切换到原版模式。"
                    );
                }}
              >
                <BookOpenText size={13} className="mr-2" />
                {book.readerMode === "original"
                  ? "切换为重排文本"
                  : "切换为原版版面"}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <div className="font-meta px-2 pb-1 pt-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              <FolderInput size={10} className="mr-1 inline" /> 移动到
            </div>
            {folders.map(f => (
              <DropdownMenuItem
                key={f.id}
                disabled={book.folderId === f.id}
                onClick={() => lib.moveBook(book.id, f.id)}
              >
                <FolderGlyph icon={f.icon} size="sm" className="mr-2" />
                {f.name}
                {book.folderId === f.id && (
                  <span className="ml-auto text-[10px] text-primary">当前</span>
                )}
              </DropdownMenuItem>
            ))}
            {book.folderId && (
              <DropdownMenuItem
                onClick={() => lib.moveBook(book.id, undefined)}
              >
                <ChevronLeft size={13} className="mr-2" /> 移出文件夹
              </DropdownMenuItem>
            )}
            {folders.length === 0 && !book.folderId && (
              <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                还没有文件夹
              </div>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={deleteBusy}
              className="text-destructive focus:text-destructive"
              onClick={() => {
                if (
                  !confirm(
                    `确定删除《${book.title}》？相关书摘、译文、脑图和文段关联会一并移除。`
                  )
                )
                  return;
                setDeleteBusy(true);
                void lib
                  .removeBook(book.id)
                  .catch(error =>
                    alert(
                      error instanceof Error
                        ? error.message
                        : "删除失败，本地书籍仍然保留。"
                    )
                  )
                  .finally(() => setDeleteBusy(false));
              }}
            >
              <Trash2 size={13} className="mr-2" />
              {deleteBusy ? "正在删除…" : "删除"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <input
        ref={coverInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          setCoverBusy(true);
          void prepareCoverImage(file)
            .then(dataUrl => lib.setBookCustomCover(book.id, dataUrl))
            .catch(error =>
              alert(error instanceof Error ? error.message : String(error))
            )
            .finally(() => setCoverBusy(false));
        }}
      />

      <BookMetadataDialog
        book={book}
        open={metadataEditing}
        onOpenChange={setMetadataEditing}
        onSave={metadata => lib.updateBookMetadata(book.id, metadata)}
      />
    </div>
  );
}

/* ---------- 文件夹卡片 ---------- */

function FolderCard({
  folder,
  count,
  lib,
  onOpen,
}: {
  folder: Folder;
  count: number;
  lib: Library;
  onOpen: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [choosingIcon, setChoosingIcon] = useState(false);
  const [over, setOver] = useState(false);

  return (
    <div
      className="group relative"
      onDragOver={e => {
        if (e.dataTransfer.types.includes("text/x-book-id")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={e => {
        e.preventDefault();
        setOver(false);
        const bookId = e.dataTransfer.getData("text/x-book-id");
        if (bookId) lib.moveBook(bookId, folder.id);
      }}
    >
      <button onClick={onOpen} className="block w-full text-left">
        <div
          className={`flex aspect-[3/4.2] w-full flex-col items-center justify-center gap-2 rounded-md border transition-all duration-200 group-hover:-translate-y-1.5 ${
            over
              ? "border-primary bg-accent/60 shadow-md"
              : "border-foreground/15 bg-accent/30 hover:bg-accent/50"
          }`}
        >
          <FolderGlyph icon={folder.icon} size="lg" />
          <span className="font-meta text-[10px] uppercase tracking-wider text-muted-foreground">
            {count} 册
          </span>
        </div>
        <div className="mt-3">
          <div className="truncate text-[13.5px] font-medium leading-snug">
            {folder.name}
          </div>
          <div className="font-meta mt-1 text-[10.5px] text-muted-foreground">
            文件夹
          </div>
        </div>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            onClick={e => e.stopPropagation()}
            className="absolute right-2 top-2 hidden rounded-full bg-card/90 p-1.5 text-muted-foreground shadow hover:text-foreground group-hover:block"
            title="更多操作"
          >
            <MoreHorizontal size={13} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44 bg-card">
          <DropdownMenuItem onClick={() => setRenaming(true)}>
            <Pencil size={13} className="mr-2" /> 重命名
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setChoosingIcon(true)}>
            <Shapes size={13} className="mr-2" /> 更换图标
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => {
              if (
                confirm(
                  `删除文件夹「${folder.name}」？其中 ${count} 本书会移回书架。`
                )
              )
                lib.removeFolder(folder.id);
            }}
          >
            <Trash2 size={13} className="mr-2" /> 删除文件夹
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <RenameDialog
        open={renaming}
        title="重命名文件夹"
        initial={folder.name}
        onSubmit={v => lib.renameFolder(folder.id, v)}
        onClose={() => setRenaming(false)}
      />
      <Dialog open={choosingIcon} onOpenChange={setChoosingIcon}>
        <DialogContent className="max-w-sm rounded-[22px] bg-card">
          <DialogHeader>
            <DialogTitle className="text-[15px]">选择文件夹图标</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-4 gap-2 pt-1">
            {FOLDER_ICON_OPTIONS.map(option => (
              <button
                key={option.id}
                type="button"
                className={`flex flex-col items-center gap-1.5 rounded-[14px] border px-2 py-3 text-[10px] transition hover:-translate-y-0.5 hover:bg-accent/60 ${
                  folder.icon === option.id
                    ? "border-primary/60 bg-primary/5 text-primary"
                    : "border-border"
                }`}
                onClick={() => {
                  void lib
                    .setFolderIcon(folder.id, option.id)
                    .then(() => setChoosingIcon(false));
                }}
              >
                <FolderGlyph icon={option.id} size="sm" />
                <span>{option.label}</span>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ---------- 书架主视图 ---------- */

export function LibraryView({ lib }: { lib: Library }) {
  const [dragging, setDragging] = useState(false);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [pendingPdfs, setPendingPdfs] = useState<File[] | null>(null);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const sel = useSelection();

  /** 导入入口：PDF 先选择排版方式，其余支持格式直接导入 */
  const handleImport = (files: File[]) => {
    const { pdfs, others } = splitImportFiles(files);
    if (others.length) void lib.importFiles(others);
    if (pdfs.length) setPendingPdfs(pdfs);
  };

  const activeFolder = lib.folders.find(f => f.id === activeFolderId) ?? null;

  const booksIn = useMemo(
    () =>
      (id: string | null): Book[] =>
        lib.books.filter(b =>
          id
            ? b.folderId === id
            : !b.folderId || !lib.folders.some(f => f.id === b.folderId)
        ),
    [lib.books, lib.folders]
  );
  const visibleBooks = booksIn(activeFolderId);

  /* 批量操作 */
  const batchMove = (folderId: string | undefined) => {
    for (const id of sel.selected) void lib.moveBook(id, folderId);
    sel.exit();
  };
  const batchDelete = async () => {
    const n = sel.selected.size;
    if (n === 0 || batchDeleting) return;
    if (
      confirm(
        `确定删除选中的 ${n} 本书？相关书摘、译文、脑图和文段关联会一并移除。`
      )
    ) {
      const ids = [...sel.selected];
      setBatchDeleting(true);
      try {
        // Serialize deletions so each transaction observes the note rewrites
        // made by the preceding book and shared-digest cleanup stays bounded.
        const failures: unknown[] = [];
        for (const id of ids) {
          try {
            await lib.removeBook(id);
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0) {
          const first = failures[0];
          alert(
            `${failures.length} 本书删除失败，本地数据仍然保留。${
              first instanceof Error ? `\n${first.message}` : ""
            }`
          );
        }
        sel.exit();
      } finally {
        setBatchDeleting(false);
      }
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) handleImport(files);
  };

  /* 拖书到「移出文件夹」条 */
  const [unfileOver, setUnfileOver] = useState(false);

  return (
    <div
      className="h-full overflow-y-auto"
      onDragOver={e => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="mx-auto max-w-5xl px-10 pb-24 pt-12">
        {/* 刊头 */}
        <header className="mb-10 border-b border-foreground/15 pb-6">
          <div className="font-meta flex items-baseline justify-between text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            <span>私人阅览室</span>
            <span>
              Vol. {String(lib.books.length).padStart(2, "0")} 册 ·{" "}
              {lib.notes.length} 篇笔记 ·{" "}
              {
                lib.highlights.filter(h => citationLevelOf(h) === "content")
                  .length
              }{" "}
              条书摘
            </span>
          </div>
          {activeFolder ? (
            <div className="mt-3 flex items-end justify-between">
              <div>
                <button
                  onClick={() => setActiveFolderId(null)}
                  className="font-meta mb-2 flex items-center gap-1 text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
                >
                  <ChevronLeft size={12} /> 书架
                </button>
                <h1 className="font-reading flex items-center gap-3 text-[42px] font-bold leading-tight tracking-wide">
                  <FolderGlyph icon={activeFolder.icon} />
                  {activeFolder.name}
                </h1>
              </div>
              <span className="font-meta pb-2 text-[11px] text-muted-foreground">
                {visibleBooks.length} 册
              </span>
            </div>
          ) : (
            <h1 className="font-reading mt-3 text-[42px] font-bold leading-tight tracking-wide">
              书架
            </h1>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <LibrarySyncButton
              onSync={lib.syncLibrary}
              disabled={lib.imports.some(task => task.status === "working")}
            />
            {/* 多选开关 */}
            {visibleBooks.length > 0 && !sel.selecting && (
              <button
                onClick={sel.start}
                className="font-meta flex items-center gap-1.5 rounded-full border border-foreground/20 px-3 py-1.5 text-[11px] tracking-wider text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
              >
                <CheckSquare size={12} /> 多选
              </button>
            )}
          </div>
        </header>

        {/* 导入区（仅根目录显示） */}
        {!activeFolder && (
          <label
            className={`mb-12 flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed px-6 py-8 text-center transition-colors ${
              dragging
                ? "border-primary bg-accent/40"
                : "border-foreground/25 bg-card/50 hover:bg-card"
            }`}
          >
            <BookUp2 size={22} strokeWidth={1.6} className="text-primary" />
            <span className="mt-2 text-sm font-medium">
              拖入文件，或点击选择
            </span>
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
        )}

        {/* 文件夹内：移出条 */}
        {activeFolder && (
          <div
            onDragOver={e => {
              if (e.dataTransfer.types.includes("text/x-book-id")) {
                e.preventDefault();
                setUnfileOver(true);
              }
            }}
            onDragLeave={() => setUnfileOver(false)}
            onDrop={e => {
              e.preventDefault();
              setUnfileOver(false);
              const bookId = e.dataTransfer.getData("text/x-book-id");
              if (bookId) lib.moveBook(bookId, undefined);
            }}
            className={`font-meta mb-8 flex items-center justify-center gap-2 rounded-md border border-dashed px-4 py-3 text-[11px] tracking-wider transition-colors ${
              unfileOver
                ? "border-primary bg-accent/60 text-foreground"
                : "border-foreground/20 text-muted-foreground"
            }`}
          >
            <ChevronLeft size={12} /> 把书拖到这里移出文件夹
          </div>
        )}

        {/* 网格 */}
        {visibleBooks.length > 0 || !activeFolder ? (
          <div className="grid grid-cols-2 gap-x-8 gap-y-12 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {!activeFolder &&
              lib.folders.map(f => (
                <FolderCard
                  key={f.id}
                  folder={f}
                  count={booksIn(f.id).length}
                  lib={lib}
                  onOpen={() => setActiveFolderId(f.id)}
                />
              ))}
            {visibleBooks.map(b => (
              <BookCard
                key={b.id}
                book={b}
                folders={lib.folders}
                lib={lib}
                selecting={sel.selecting}
                checked={sel.selected.has(b.id)}
                onToggleSelect={() => sel.toggle(b.id)}
              />
            ))}

            {/* 新建文件夹卡片（仅根目录） */}
            {!activeFolder && (
              <button
                onClick={() => setNewFolderOpen(true)}
                className="group flex aspect-[3/4.2] w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed border-foreground/20 text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
              >
                <FolderPlus size={30} strokeWidth={1.2} />
                <span className="font-meta text-[10.5px] uppercase tracking-wider">
                  新建文件夹
                </span>
              </button>
            )}
          </div>
        ) : (
          <div className="py-16 text-center text-sm text-muted-foreground">
            {activeFolder
              ? "这个文件夹是空的，把书拖进来或从菜单移动。"
              : `书架是空的。拖入一本 ${SUPPORTED_FORMAT_LABEL} 书籍开始吧。`}
          </div>
        )}
      </div>

      <RenameDialog
        open={newFolderOpen}
        title="新建文件夹"
        initial=""
        onSubmit={v => void lib.createFolder(v)}
        onClose={() => setNewFolderOpen(false)}
      />

      {/* PDF 排版方式选择 */}
      <ImportModeDialog
        files={pendingPdfs}
        onCancel={() => setPendingPdfs(null)}
        onConfirm={modes => {
          const files = pendingPdfs ?? [];
          setPendingPdfs(null);
          void lib.importFiles(files, modes);
        }}
      />

      {/* 批量操作条 */}
      {sel.selecting && (
        <BatchBar
          count={sel.selected.size}
          total={visibleBooks.length}
          onSelectAll={() => sel.selectAll(visibleBooks.map(b => b.id))}
          onExit={sel.exit}
        >
          {/* 移动到文件夹 */}
          {lib.folders.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  disabled={sel.selected.size === 0}
                  className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] text-foreground transition-colors hover:bg-secondary disabled:opacity-35"
                >
                  <FolderInput size={13} /> 移动到
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="center"
                side="top"
                className="w-44 bg-card"
              >
                {lib.folders
                  .filter(f => f.id !== activeFolderId)
                  .map(f => (
                    <DropdownMenuItem
                      key={f.id}
                      onClick={() => batchMove(f.id)}
                    >
                      <FolderGlyph icon={f.icon} size="sm" className="mr-2" />
                      {f.name}
                    </DropdownMenuItem>
                  ))}
                {activeFolderId && (
                  <DropdownMenuItem onClick={() => batchMove(undefined)}>
                    <ChevronLeft size={13} className="mr-2" /> 移出文件夹
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {activeFolderId && lib.folders.length === 0 && (
            <BatchAction
              disabled={sel.selected.size === 0}
              onClick={() => batchMove(undefined)}
            >
              <ChevronLeft size={13} /> 移出文件夹
            </BatchAction>
          )}
          <BatchAction
            disabled={sel.selected.size === 0 || batchDeleting}
            danger
            onClick={() => void batchDelete()}
          >
            <Trash2 size={13} /> {batchDeleting ? "正在删除…" : "删除"}
          </BatchAction>
        </BatchBar>
      )}
    </div>
  );
}
