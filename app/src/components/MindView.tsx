import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Crosshair,
  GitBranch,
  ListTree,
  Loader2,
  Network,
  Plus,
  Sparkles,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { BatchAction, BatchBar, SelectDot } from "./BatchBar";
import { useSelection } from "@/hooks/useSelection";
import type { Book, MindMap, MindNode } from "@/types";
import type { Library } from "@/hooks/useLibrary";
import { formatDate } from "@/lib/covers";
import { emitEvent } from "@/lib/events";
import { friendlyAiError } from "@/lib/aiError";
import { useAiConfig } from "@/lib/aiConfig";
import {
  appendChild,
  appendSibling,
  countNodes,
  createMindFromBook,
  findNode,
  findParent,
  layoutMind,
  newNode,
  removeNode,
  updateNode,
} from "@/lib/mind";
import { trpc } from "@/lib/trpc-client";

interface TopicNode {
  title: string;
  children: TopicNode[];
}

function topicToNode(topic: TopicNode): MindNode {
  return {
    id: crypto.randomUUID(),
    text: topic.title,
    children: topic.children.map(topicToNode),
  };
}

function truncate(text: string, max: number) {
  return Array.from(text).length > max
    ? Array.from(text).slice(0, max).join("") + "…"
    : text;
}

export function MindView({ lib }: { lib: Library }) {
  const [selectedMapId, setSelectedMapId] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [bookId, setBookId] = useState("");
  const [aiChapterId, setAiChapterId] = useState("");
  const [draft, setDraft] = useState("");
  const [zoom, setZoom] = useState(1);
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState("");
  /** 焦点模式：只显示该节点的子树 */
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
  /** 脑图画布 / 大纲视图 */
  const [viewMode, setViewMode] = useState<"map" | "outline">("map");
  const sel = useSelection();

  const batchDeleteMaps = async () => {
    const n = sel.selected.size;
    if (n === 0) return;
    if (!confirm(`确定删除选中的 ${n} 张脑图？`)) return;
    for (const id of sel.selected) {
      const m = maps.find(x => x.id === id);
      await lib.removeMindMap(id);
      emitEvent("mindmap.deleted", { extId: id, title: m?.title ?? "" });
    }
    if (current && sel.selected.has(current.id)) setSelectedMapId("");
    sel.exit();
  };
  const inspectorRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();
  const [aiConfig] = useAiConfig();

  const maps = lib.mindMaps;
  const current = maps.find(m => m.id === selectedMapId) ?? maps[0] ?? null;
  const currentRef = useRef(current);
  const currentBook = current?.bookId
    ? lib.books.find(b => b.id === current.bookId)
    : undefined;
  const selectedNode = current ? findNode(current.root, selectedNodeId) : null;
  const focusNode =
    current && focusNodeId ? findNode(current.root, focusNodeId) : null;
  const layout = useMemo(
    () => (current ? layoutMind(focusNode ?? current.root) : null),
    [current, focusNode]
  );
  const selectedBook = lib.books.find(b => b.id === bookId) ?? lib.books[0];

  useEffect(() => {
    if (!selectedMapId && maps[0]) setSelectedMapId(maps[0].id);
  }, [maps, selectedMapId]);

  useEffect(() => {
    if (!bookId && lib.books[0]) setBookId(lib.books[0].id);
  }, [bookId, lib.books]);

  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  useEffect(() => {
    const selectedMap = currentRef.current;
    if (selectedMap) {
      setSelectedNodeId(selectedMap.root.id);
      setDraft(selectedMap.root.text);
      setFocusNodeId(null);
    }
  }, [current?.id]);

  useEffect(() => {
    setDraft(selectedNode?.text ?? "");
  }, [selectedNodeId, selectedNode?.text, current?.id]);

  const saveMap = useCallback(
    async (map: MindMap, type: "mindmap.created" | "mindmap.updated") => {
      const saved = await lib.saveMindMap(map);
      const bookTitle = saved.bookId
        ? (lib.books.find(b => b.id === saved.bookId)?.title ?? "")
        : "";
      setError("");
      try {
        await emitEvent(type, {
          extId: saved.id,
          title: saved.title,
          bookExtId: saved.bookId ?? "",
          bookTitle,
          root: saved.root,
          nodeCount: countNodes(saved.root),
        });
      } catch {
        setError(
          saved.bookId
            ? "脑图已保存在此设备，但 MySQL 镜像同步失败，请检查连接后重试。"
            : "空白脑图已保存在此设备；未关联书籍，因此不会写入 MySQL 镜像。"
        );
      }
      return saved;
    },
    [lib]
  );

  const commitRoot = useCallback(
    async (root: MindNode) => {
      if (!current) return;
      await saveMap({ ...current, root }, "mindmap.updated");
    },
    [current, saveMap]
  );

  const createFromBook = async (book: Book | undefined) => {
    if (!book) return;
    const map = createMindFromBook(book);
    await saveMap(map, "mindmap.created");
    setSelectedMapId(map.id);
    setSelectedNodeId(map.root.id);
  };

  const createBlank = async () => {
    const now = Date.now();
    const map: MindMap = {
      id: crypto.randomUUID(),
      title: "空白脑图",
      root: newNode("中心主题"),
      createdAt: now,
      updatedAt: now,
    };
    await saveMap(map, "mindmap.created");
    setSelectedMapId(map.id);
    setSelectedNodeId(map.root.id);
  };

  const renameSelected = async () => {
    if (!current || !selectedNode) return;
    const text = draft.trim();
    if (!text || text === selectedNode.text) return;
    await commitRoot(updateNode(current.root, selectedNode.id, { text }));
  };

  const addChild = async () => {
    if (!current || !selectedNode) return;
    const child = newNode("新节点");
    await commitRoot(appendChild(current.root, selectedNode.id, child));
    setSelectedNodeId(child.id);
    window.setTimeout(() => inspectorRef.current?.focus(), 0);
  };

  const addSibling = async () => {
    if (!current || !selectedNode || selectedNode.id === current.root.id)
      return;
    const sibling = newNode("新节点");
    await commitRoot(appendSibling(current.root, selectedNode.id, sibling));
    setSelectedNodeId(sibling.id);
    window.setTimeout(() => inspectorRef.current?.focus(), 0);
  };

  const deleteSelected = async () => {
    if (!current || !selectedNode || selectedNode.id === current.root.id)
      return;
    const parent = findParent(current.root, selectedNode.id);
    await commitRoot(removeNode(current.root, selectedNode.id));
    setSelectedNodeId(parent?.id ?? current.root.id);
  };

  const toggleCollapse = async () => {
    if (!current || !selectedNode || !selectedNode.children.length) return;
    await commitRoot(
      updateNode(current.root, selectedNode.id, {
        collapsed: !selectedNode.collapsed,
      })
    );
  };

  const aiExpandChapter = async () => {
    if (!current || !currentBook || !aiChapterId || aiBusy) return;
    const chapter = currentBook.chapters.find(c => c.id === aiChapterId);
    if (!chapter) return;
    setAiBusy(true);
    setError("");
    try {
      const resp = await utils.client.ai.mindmap.mutate({
        config: aiConfig,
        bookTitle: currentBook.title,
        chapterTitle: chapter.title,
        text: chapter.paragraphs.join("\n").slice(0, 50000),
        maxTopics: 6,
      });
      let root = current.root;
      let chapterNode = root.children.find(n => n.chapterId === chapter.id);
      if (!chapterNode) {
        chapterNode = { ...newNode(chapter.title, chapter.id), children: [] };
        root = appendChild(root, root.id, chapterNode);
      }
      const additions = (resp.topics as TopicNode[]).map(topicToNode);
      root = updateNode(root, chapterNode.id, {
        collapsed: false,
        children: [
          ...(findNode(root, chapterNode.id)?.children ?? []),
          ...additions,
        ],
      });
      await commitRoot(root);
      setSelectedNodeId(chapterNode.id);
    } catch (e) {
      setError(friendlyAiError(e, "AI 提炼暂时不可用，请稍后再试。"));
    } finally {
      setAiBusy(false);
    }
  };

  const nodeActionsDisabled = !selectedNode;

  return (
    <div className="flex h-full min-h-0">
      {/* 左侧脑图索引 */}
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-sidebar">
        <div className="border-b border-sidebar-border px-5 pb-4 pt-6">
          <div className="font-meta text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
            Mind Maps · {maps.length}
          </div>
          <h1 className="font-reading mt-2 text-[28px] font-bold tracking-wide">
            脑图
          </h1>
        </div>

        <div className="border-b border-sidebar-border p-3">
          <select
            value={selectedBook?.id ?? ""}
            onChange={e => setBookId(e.target.value)}
            className="mb-2 h-9 w-full rounded-md border border-border bg-card px-2 text-[12.5px] outline-none focus:border-primary/60"
          >
            {lib.books.map(b => (
              <option key={b.id} value={b.id}>
                {b.title}
              </option>
            ))}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => void createFromBook(selectedBook)}
              disabled={!selectedBook}
              className="flex items-center justify-center gap-1 rounded-full bg-primary px-3 py-2 text-[12px] font-medium text-primary-foreground disabled:opacity-40"
            >
              <GitBranch size={13} /> 目录生成
            </button>
            <button
              onClick={() => void createBlank()}
              className="flex items-center justify-center gap-1 rounded-full border border-border px-3 py-2 text-[12px] text-muted-foreground hover:bg-card"
            >
              <Plus size={13} /> 空白脑图
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {maps.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-4 text-center text-muted-foreground">
              <Network size={26} strokeWidth={1.4} />
              <p className="mt-3 text-[13px] leading-6">还没有脑图。</p>
              <p className="font-meta mt-1 text-[10px] leading-5">
                从一本书的目录生成，或从空白主题开始。
              </p>
            </div>
          ) : (
            <>
              {/* 多选开关 */}
              {!sel.selecting ? (
                <button
                  onClick={sel.start}
                  className="font-meta mb-2 flex items-center gap-1 px-1 text-[10px] tracking-wider text-muted-foreground/70 hover:text-foreground"
                >
                  <CheckSquare size={11} /> 多选
                </button>
              ) : (
                <button
                  onClick={() => sel.selectAll(maps.map(m => m.id))}
                  className="font-meta mb-2 flex items-center gap-1 px-1 text-[10px] tracking-wider text-primary"
                >
                  <CheckSquare size={11} />{" "}
                  {maps.every(m => sel.selected.has(m.id)) ? "全不选" : "全选"}
                  （{sel.selected.size}）
                </button>
              )}
              {maps.map(m => (
                <button
                  key={m.id}
                  onClick={() =>
                    sel.selecting ? sel.toggle(m.id) : setSelectedMapId(m.id)
                  }
                  className={`mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left transition-colors ${
                    sel.selecting && sel.selected.has(m.id)
                      ? "bg-primary/10 ring-1 ring-primary/40"
                      : current?.id === m.id
                        ? "bg-sidebar-accent"
                        : "hover:bg-sidebar-accent/60"
                  }`}
                >
                  {sel.selecting && (
                    <SelectDot checked={sel.selected.has(m.id)} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">
                      {m.title}
                    </span>
                    <span className="font-meta mt-1 block text-[10px] text-muted-foreground">
                      {countNodes(m.root)} 节点 · {formatDate(m.updatedAt)}
                    </span>
                  </span>
                </button>
              ))}
            </>
          )}
        </div>
      </aside>

      {/* 右侧画布 */}
      <section className="relative min-w-0 flex-1 overflow-hidden bg-background">
        {current && layout ? (
          <>
            <div className="absolute left-0 right-0 top-0 z-10 flex h-14 items-center gap-2 border-b border-border bg-background/92 px-4 backdrop-blur">
              <input
                key={current.id}
                defaultValue={current.title}
                onBlur={async e => {
                  const title = e.target.value.trim();
                  if (title && title !== current.title)
                    await saveMap({ ...current, title }, "mindmap.updated");
                }}
                className="h-8 w-56 rounded-md border border-transparent bg-transparent px-2 text-[14px] font-medium outline-none focus:border-border focus:bg-card"
              />
              <span className="font-meta text-[10px] text-muted-foreground">
                {countNodes(current.root)} 节点
              </span>
              {/* 脑图 / 大纲 切换 */}
              <div className="ml-2 flex overflow-hidden rounded-full border border-border">
                <button
                  onClick={() => setViewMode("map")}
                  className={`flex items-center gap-1 px-2.5 py-1.5 text-[11px] ${viewMode === "map" ? "bg-foreground text-background" : "text-muted-foreground hover:bg-card"}`}
                >
                  <GitBranch size={11} /> 脑图
                </button>
                <button
                  onClick={() => setViewMode("outline")}
                  className={`flex items-center gap-1 px-2.5 py-1.5 text-[11px] ${viewMode === "outline" ? "bg-foreground text-background" : "text-muted-foreground hover:bg-card"}`}
                >
                  <ListTree size={11} /> 大纲
                </button>
              </div>
              {/* 焦点模式 */}
              {focusNode ? (
                <span className="ml-1 flex items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-[11px] text-primary">
                  <Crosshair size={11} /> 焦点：{truncate(focusNode.text, 8)}
                  <button
                    onClick={() => setFocusNodeId(null)}
                    aria-label="退出焦点"
                    className="opacity-60 hover:opacity-100"
                  >
                    <X size={10} />
                  </button>
                </span>
              ) : (
                <button
                  onClick={() =>
                    selectedNode &&
                    selectedNode.id !== current.root.id &&
                    setFocusNodeId(selectedNode.id)
                  }
                  disabled={
                    !selectedNode || selectedNode.id === current.root.id
                  }
                  className="ml-1 flex items-center gap-1 rounded-full border border-border px-2.5 py-1.5 text-[11px] text-muted-foreground hover:bg-card disabled:opacity-40"
                  title="只显示选中节点的子树"
                >
                  <Crosshair size={11} /> 焦点
                </button>
              )}
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  onClick={() =>
                    setZoom(z => Math.max(0.6, Number((z - 0.15).toFixed(2))))
                  }
                  className="rounded-full border border-border p-2 text-muted-foreground hover:bg-card"
                  title="缩小"
                >
                  <ZoomOut size={13} />
                </button>
                <span className="font-meta w-11 text-center text-[10px] text-muted-foreground">
                  {Math.round(zoom * 100)}%
                </span>
                <button
                  onClick={() =>
                    setZoom(z => Math.min(1.6, Number((z + 0.15).toFixed(2))))
                  }
                  className="rounded-full border border-border p-2 text-muted-foreground hover:bg-card"
                  title="放大"
                >
                  <ZoomIn size={13} />
                </button>
                <button
                  onClick={async () => {
                    await lib.removeMindMap(current.id);
                    emitEvent("mindmap.deleted", {
                      extId: current.id,
                      title: current.title,
                    });
                    setSelectedMapId("");
                  }}
                  className="rounded-full border border-border p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  title="删除脑图"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>

            {/* 节点检查器 */}
            <div className="absolute right-4 top-[72px] z-20 w-[292px] rounded-lg border border-border bg-popover p-3 shadow-lg">
              <div className="font-meta mb-2 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                选中节点
              </div>
              <input
                ref={inspectorRef}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onBlur={() => void renameSelected()}
                onKeyDown={e => {
                  if (e.key === "Enter") void renameSelected();
                }}
                disabled={nodeActionsDisabled}
                className="h-9 w-full rounded-md border border-border bg-card px-2.5 text-[13px] outline-none focus:border-primary/60 disabled:opacity-50"
              />
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                <button
                  onClick={() => void addChild()}
                  disabled={nodeActionsDisabled}
                  className="rounded-md border border-border px-2 py-1.5 text-[12px] hover:bg-card disabled:opacity-40"
                >
                  添加子节点
                </button>
                <button
                  onClick={() => void addSibling()}
                  disabled={
                    nodeActionsDisabled || selectedNode?.id === current.root.id
                  }
                  className="rounded-md border border-border px-2 py-1.5 text-[12px] hover:bg-card disabled:opacity-40"
                >
                  添加同级
                </button>
                <button
                  onClick={() => void toggleCollapse()}
                  disabled={!selectedNode?.children.length}
                  className="rounded-md border border-border px-2 py-1.5 text-[12px] hover:bg-card disabled:opacity-40"
                >
                  {selectedNode?.collapsed ? "展开" : "折叠"}
                </button>
                <button
                  onClick={() => void deleteSelected()}
                  disabled={
                    nodeActionsDisabled || selectedNode?.id === current.root.id
                  }
                  className="rounded-md border border-border px-2 py-1.5 text-[12px] text-destructive hover:bg-destructive/10 disabled:opacity-40"
                >
                  删除节点
                </button>
              </div>
              {selectedNode?.chapterId && current.bookId && (
                <button
                  onClick={() =>
                    selectedNode.sourceHighlightId
                      ? lib.navigate({
                          view: "reader",
                          bookId: current.bookId,
                          chapterId: selectedNode.chapterId,
                          highlightId: selectedNode.sourceHighlightId,
                        })
                      : lib.openReader(
                          current.bookId ?? "",
                          selectedNode.chapterId
                        )
                  }
                  className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-2 py-1.5 text-[12px] font-medium text-primary-foreground"
                >
                  <BookOpen size={12} />{" "}
                  {selectedNode.sourceHighlightId
                    ? "回到原文卡片"
                    : "打开对应章节"}
                </button>
              )}

              {currentBook && (
                <div className="mt-3 border-t border-border pt-3">
                  <div className="font-meta mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                    <Sparkles size={11} /> Codex 提炼章节
                  </div>
                  <div className="flex gap-1.5">
                    <select
                      value={aiChapterId || currentBook.chapters[0]?.id || ""}
                      onChange={e => setAiChapterId(e.target.value)}
                      className="h-8 min-w-0 flex-1 rounded-md border border-border bg-card px-2 text-[11.5px] outline-none"
                    >
                      {currentBook.chapters.map(c => (
                        <option key={c.id} value={c.id}>
                          {c.title}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => void aiExpandChapter()}
                      disabled={aiBusy}
                      className="flex h-8 items-center gap-1 rounded-md bg-primary px-2.5 text-[11.5px] font-medium text-primary-foreground disabled:opacity-50"
                    >
                      {aiBusy ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Sparkles size={12} />
                      )}
                      提炼
                    </button>
                  </div>
                  {error && (
                    <p className="mt-2 text-[11px] leading-5 text-destructive">
                      {error}
                    </p>
                  )}
                </div>
              )}
            </div>

            {viewMode === "outline" ? (
              /* 大纲视图：树形缩进列表 */
              <div className="h-full overflow-y-auto px-6 pb-16 pt-[72px]">
                <OutlineTree
                  node={focusNode ?? current.root}
                  depth={0}
                  bookId={current.bookId}
                  selectedNodeId={selectedNodeId}
                  onSelect={setSelectedNodeId}
                  onToggle={(id, collapsed) =>
                    void commitRoot(updateNode(current.root, id, { collapsed }))
                  }
                  onOpenChapter={chapterId =>
                    current.bookId && lib.openReader(current.bookId, chapterId)
                  }
                />
              </div>
            ) : (
              <div className="h-full overflow-auto pt-14">
                <div
                  style={{
                    width: layout.width * zoom,
                    height: layout.height * zoom,
                  }}
                >
                  <svg
                    width={layout.width * zoom}
                    height={layout.height * zoom}
                    viewBox={`0 0 ${layout.width} ${layout.height}`}
                    className="block"
                  >
                    {layout.links.map((l, i) => (
                      <path
                        key={i}
                        d={l.path}
                        fill="none"
                        stroke="#8a7d6b"
                        strokeOpacity="0.42"
                        strokeWidth="1.3"
                      />
                    ))}
                    {layout.nodes.map(n => {
                      const active = n.node.id === selectedNodeId;
                      const isRoot = n.depth === 0;
                      const fill = isRoot
                        ? "#f54001"
                        : active
                          ? "#ffc198"
                          : n.depth === 1
                            ? "#fffbf5"
                            : "#f4f0ea";
                      const textFill = isRoot ? "#fffbf5" : "#4f483e";
                      return (
                        <g
                          key={n.node.id}
                          className="cursor-pointer select-none"
                          onClick={() => setSelectedNodeId(n.node.id)}
                          onDoubleClick={() => inspectorRef.current?.focus()}
                        >
                          <rect
                            x={n.x}
                            y={n.y - n.h / 2}
                            width={n.w}
                            height={n.h}
                            rx={isRoot ? 6 : 18}
                            fill={fill}
                            stroke={active ? "#f54001" : "rgba(79,72,62,0.22)"}
                            strokeWidth={active ? 2 : 1}
                          />
                          <text
                            x={n.x + n.w / 2}
                            y={n.y + 4}
                            textAnchor="middle"
                            fontSize={isRoot ? 14 : n.depth === 1 ? 12.5 : 11.5}
                            fontWeight={isRoot || n.depth === 1 ? 600 : 400}
                            fill={textFill}
                            style={{ pointerEvents: "none" }}
                          >
                            {truncate(n.node.text, isRoot ? 12 : 15)}
                          </text>
                          {n.node.children.length > 0 && (
                            <g
                              onClick={e => {
                                e.stopPropagation();
                                setSelectedNodeId(n.node.id);
                                void commitRoot(
                                  updateNode(current.root, n.node.id, {
                                    collapsed: !n.node.collapsed,
                                  })
                                );
                              }}
                            >
                              <circle
                                cx={n.x + n.w}
                                cy={n.y}
                                r="9"
                                fill="#fffbf5"
                                stroke="#f54001"
                              />
                              {n.node.collapsed ? (
                                <text
                                  x={n.x + n.w}
                                  y={n.y + 3}
                                  textAnchor="middle"
                                  fontSize="9"
                                  fill="#f54001"
                                  style={{ pointerEvents: "none" }}
                                >
                                  +{n.node.children.length}
                                </text>
                              ) : (
                                <path
                                  d={`M ${n.x + n.w - 3} ${n.y} L ${n.x + n.w + 3} ${n.y}`}
                                  stroke="#f54001"
                                  strokeWidth="1.5"
                                  style={{ pointerEvents: "none" }}
                                />
                              )}
                            </g>
                          )}
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </div>
            )}

            <div className="font-meta pointer-events-none absolute bottom-4 left-5 text-[10px] leading-5 text-muted-foreground/70">
              单击选中 · 双击改名 · 节点旁 +N 可展开折叠
            </div>
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
            <Network size={30} strokeWidth={1.3} />
            <p className="mt-4 text-sm">从左侧选择一本书，生成第一张脑图。</p>
            <p className="font-meta mt-2 text-[10px]">
              书 → 章节 → 段落线索；之后每个节点都可以继续编辑。
            </p>
          </div>
        )}
      </section>

      {/* 批量操作条 */}
      {sel.selecting && (
        <BatchBar
          count={sel.selected.size}
          total={maps.length}
          onSelectAll={() => sel.selectAll(maps.map(m => m.id))}
          onExit={sel.exit}
        >
          <BatchAction
            disabled={sel.selected.size === 0}
            danger
            onClick={() => void batchDeleteMaps()}
          >
            <Trash2 size={13} /> 删除
          </BatchAction>
        </BatchBar>
      )}
    </div>
  );
}

/** 大纲视图行：缩进树，支持折叠与跳章节 */
function OutlineTree({
  node,
  depth,
  bookId,
  selectedNodeId,
  onSelect,
  onToggle,
  onOpenChapter,
}: {
  node: MindNode;
  depth: number;
  bookId?: string;
  selectedNodeId: string;
  onSelect: (id: string) => void;
  onToggle: (id: string, collapsed: boolean) => void;
  onOpenChapter: (chapterId: string) => void;
}) {
  const active = node.id === selectedNodeId;
  return (
    <div>
      <div
        className={`group flex items-center gap-1 rounded-md py-[5px] pr-2 ${active ? "bg-accent/60" : "hover:bg-accent/30"}`}
        style={{ paddingLeft: depth * 22 + 6 }}
      >
        {node.children.length > 0 ? (
          <button
            onClick={() => onToggle(node.id, !node.collapsed)}
            className="p-0.5 text-muted-foreground hover:text-foreground"
            aria-label={node.collapsed ? "展开" : "折叠"}
          >
            {node.collapsed ? (
              <ChevronRight size={13} />
            ) : (
              <ChevronDown size={13} />
            )}
          </button>
        ) : (
          <span className="w-[17px]" />
        )}
        <button
          onClick={() => onSelect(node.id)}
          className={`min-w-0 flex-1 truncate text-left ${
            depth === 0
              ? "font-reading text-[15px] font-semibold"
              : depth === 1
                ? "text-[13.5px] font-medium"
                : "text-[13px] text-foreground/85"
          }`}
        >
          {node.text}
        </button>
        {node.collapsed && node.children.length > 0 && (
          <span className="font-meta shrink-0 text-[10px] text-primary">
            +{node.children.length}
          </span>
        )}
        {node.chapterId && bookId && (
          <button
            onClick={() => onOpenChapter(node.chapterId!)}
            className="shrink-0 p-1 text-muted-foreground opacity-0 hover:text-primary group-hover:opacity-100"
            title="打开对应章节"
          >
            <BookOpen size={12} />
          </button>
        )}
      </div>
      {!node.collapsed &&
        node.children.map(c => (
          <OutlineTree
            key={c.id}
            node={c}
            depth={depth + 1}
            bookId={bookId}
            selectedNodeId={selectedNodeId}
            onSelect={onSelect}
            onToggle={onToggle}
            onOpenChapter={onOpenChapter}
          />
        ))}
    </div>
  );
}
