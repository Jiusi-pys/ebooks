import { useEffect, useMemo, useRef, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { Network } from "lucide-react";
import type { Library } from "@/hooks/useLibrary";
import { buildGraph, type GraphEdge, type GraphNode } from "@/lib/links";

interface SimNode extends SimulationNodeDatum, GraphNode {
  degree: number;
}

export function GraphView({ lib }: { lib: Library }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 900, h: 600 });
  const [, setTick] = useState(0);
  const dragNode = useRef<SimNode | null>(null);
  const dragMoved = useRef(false);

  const graph = useMemo(
    () => buildGraph(lib.books, lib.notes, lib.highlights, lib.associations),
    [lib.associations, lib.books, lib.notes, lib.highlights]
  );
  const simNodes = useMemo<SimNode[]>(() => {
    const degree = new Map<string, number>();
    for (const edge of graph.edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
    return graph.nodes.map(
      node =>
        ({
          ...node,
          degree: degree.get(node.id) ?? 0,
        }) satisfies SimNode
    );
  }, [graph]);
  const simLinks = useMemo<SimulationLinkDatum<SimNode>[]>(
    () => graph.edges.map(edge => ({ ...edge })),
    [graph]
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setSize({ w: el.clientWidth, h: el.clientHeight })
    );
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const sim = forceSimulation(simNodes)
      .force(
        "link",
        forceLink<SimNode, SimulationLinkDatum<SimNode>>(simLinks)
          .id(d => d.id)
          .distance(110)
      )
      .force("charge", forceManyBody().strength(-260))
      .force("center", forceCenter(size.w / 2, size.h / 2))
      .force(
        "collide",
        forceCollide<SimNode>().radius(d =>
          d.kind === "book"
            ? 46
            : d.kind === "chapter"
              ? 38
              : d.kind === "content"
                ? 24
                : 24 + d.degree * 3
        )
      )
      .alphaDecay(0.02)
      .on("tick", () => setTick(t => t + 1));

    const onPointerMove = (e: PointerEvent) => {
      const n = dragNode.current;
      if (!n) return;
      dragMoved.current = true;
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      n.fx = e.clientX - rect.left;
      n.fy = e.clientY - rect.top;
      sim.alphaTarget(0.25).restart();
    };
    const onPointerUp = () => {
      if (dragNode.current) {
        dragNode.current.fx = null;
        dragNode.current.fy = null;
        dragNode.current = null;
        sim.alphaTarget(0);
      }
      window.setTimeout(() => (dragMoved.current = false), 0);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      sim.stop();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [simLinks, simNodes, size]);

  const openNode = async (n: SimNode) => {
    if (dragMoved.current) return;
    if (n.kind === "note") {
      lib.navigate({ view: "note", noteId: n.id.slice("note:".length) });
      return;
    }
    if (!n.bookId) return;
    if (n.kind === "book") {
      lib.openReader(n.bookId);
      return;
    }
    const targetBook = lib.books.find(book => book.id === n.bookId);
    if (targetBook?.format === "pdf" && n.anchor) {
      await lib.setReaderMode(
        targetBook.id,
        n.anchor.kind === "pdf" ? "original" : "reflow"
      );
    }
    lib.navigate({
      view: "reader",
      bookId: n.bookId,
      chapterId: n.chapterId,
      highlightId: n.kind === "content" ? n.highlightId : undefined,
      passageAnchor: n.kind === "content" ? n.anchor : undefined,
    });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-foreground/15 px-10 pb-5 pt-10">
        <div className="font-meta text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          知识图谱 · {graph.nodes.length} 节点 / {graph.edges.length} 连线
        </div>
        <h1 className="font-reading mt-2 text-[34px] font-bold tracking-wide">
          图谱
        </h1>
      </header>
      <div ref={wrapRef} className="relative flex-1 overflow-hidden">
        {graph.nodes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
            <Network size={28} strokeWidth={1.4} />
            <p className="mt-3 text-sm">
              还没有可连接的内容。可在阅读器中关联两处原文，或在笔记中使用
              [[双链]]。
            </p>
          </div>
        ) : (
          <svg width={size.w} height={size.h} className="block">
            <defs>
              <marker
                id="association-arrow"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" fill="#0369a1" />
              </marker>
            </defs>
            {simLinks.map((l, i) => {
              const s = l.source as SimNode;
              const t = l.target as SimNode;
              if (s.x == null || s.y == null || t.x == null || t.y == null)
                return null;
              const edge = l as typeof l &
                Pick<
                  GraphEdge,
                  "kind" | "associationId" | "directed" | "label"
                >;
              const association = edge.kind === "association";
              return (
                <g
                  key={edge.associationId ?? i}
                  data-edge-kind={edge.kind}
                  data-association-id={edge.associationId}
                >
                  <line
                    x1={s.x}
                    y1={s.y}
                    x2={t.x}
                    y2={t.y}
                    stroke={association ? "#0369a1" : "#8a7d6b"}
                    strokeOpacity={association ? 0.8 : 0.35}
                    strokeWidth={association ? 1.7 : 1}
                    strokeDasharray={association ? "5 4" : undefined}
                    markerStart={
                      association && !edge.directed
                        ? "url(#association-arrow)"
                        : undefined
                    }
                    markerEnd={
                      association ? "url(#association-arrow)" : undefined
                    }
                  />
                  {association && edge.label && (
                    <text
                      x={(s.x + t.x) / 2}
                      y={(s.y + t.y) / 2 - 5}
                      textAnchor="middle"
                      fontSize={9.5}
                      fill="#075985"
                      stroke="rgba(255,255,255,0.9)"
                      strokeWidth={3}
                      paintOrder="stroke"
                    >
                      {edge.label.length > 16
                        ? `${edge.label.slice(0, 16)}…`
                        : edge.label}
                    </text>
                  )}
                </g>
              );
            })}
            {simNodes.map(n => {
              if (n.x == null || n.y == null) return null;
              const isBook = n.kind === "book";
              const isChapter = n.kind === "chapter";
              const isContent = n.kind === "content";
              const kindLabel = isBook
                ? "书籍"
                : isChapter
                  ? "章节"
                  : isContent
                    ? "内容"
                    : "笔记";
              const w = Math.max(30, n.label.length * 12 + 16);
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  className="cursor-pointer select-none"
                  role="button"
                  tabIndex={0}
                  aria-label={`${kindLabel}：${n.label}`}
                  onPointerDown={() => {
                    dragMoved.current = false;
                    dragNode.current =
                      simNodes.find(x => x.id === n.id) ?? null;
                  }}
                  onClick={() => void openNode(n)}
                  onKeyDown={event => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    void openNode(n);
                  }}
                >
                  {isBook ? (
                    <rect
                      x={-w / 2}
                      y={-15}
                      width={w}
                      height={30}
                      rx={3}
                      fill="#f54001"
                      stroke="rgba(0,0,0,0.18)"
                    />
                  ) : isChapter ? (
                    <rect
                      x={-Math.min(w, 126) / 2}
                      y={-12}
                      width={Math.min(w, 126)}
                      height={24}
                      rx={8}
                      fill="#fff1e8"
                      stroke="#f54001"
                      strokeWidth={1.2}
                    />
                  ) : isContent ? (
                    <rect
                      x={-8}
                      y={-8}
                      width={16}
                      height={16}
                      rx={2}
                      transform="rotate(45)"
                      fill="#ffe3cf"
                      stroke="#b45309"
                      strokeWidth={1.2}
                    />
                  ) : (
                    <circle
                      r={10 + n.degree * 2.5}
                      fill="#ffc198"
                      stroke="#f54001"
                      strokeWidth={1.4}
                    />
                  )}
                  {isBook && (
                    <text
                      textAnchor="middle"
                      y={4.5}
                      fontSize={12}
                      fill="#fffbf5"
                      fontWeight={600}
                    >
                      {n.label.length > 10
                        ? n.label.slice(0, 10) + "…"
                        : n.label}
                    </text>
                  )}
                  {isChapter && (
                    <text
                      textAnchor="middle"
                      y={4}
                      fontSize={10.5}
                      fill="#7c2d12"
                    >
                      {n.label.length > 10
                        ? n.label.slice(0, 10) + "…"
                        : n.label}
                    </text>
                  )}
                  {isContent && (
                    <text
                      textAnchor="middle"
                      y={26}
                      fontSize={10}
                      fill="#6b5f50"
                    >
                      {n.label.length > 12
                        ? n.label.slice(0, 12) + "…"
                        : n.label}
                    </text>
                  )}
                  {n.kind === "note" && (
                    <text
                      textAnchor="middle"
                      y={26 + n.degree * 2.5}
                      fontSize={11}
                      fill="#4f483e"
                    >
                      {n.label.length > 12
                        ? n.label.slice(0, 12) + "…"
                        : n.label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
        <div className="font-meta pointer-events-none absolute bottom-4 left-6 text-[10.5px] leading-5 text-muted-foreground/70">
          <span className="mr-4 inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-5 rounded-[2px] bg-[#f54001]" />{" "}
            书籍
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-full border border-[#f54001] bg-[#ffc198]" />{" "}
            笔记
          </span>
          <span className="ml-4 inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-4 rounded border border-[#f54001] bg-[#fff1e8]" />{" "}
            章节
          </span>
          <span className="ml-4 inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rotate-45 border border-[#b45309] bg-[#ffe3cf]" />{" "}
            内容
          </span>
          <span className="ml-4 inline-flex items-center gap-1.5 text-sky-800">
            <span className="inline-block w-5 border-t-2 border-dashed border-sky-700" />
            内容关联
          </span>
          <span className="ml-4">拖动可整理布局 · 点击打开</span>
        </div>
      </div>
    </div>
  );
}
