import { useEffect, useMemo, useRef, useState } from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import { Network } from 'lucide-react';
import type { Library } from '@/hooks/useLibrary';
import { buildGraph, type GraphNode } from '@/lib/links';

interface SimNode extends SimulationNodeDatum, GraphNode {
  degree: number;
}

export function GraphView({ lib }: { lib: Library }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 900, h: 600 });
  const [, setTick] = useState(0);
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimulationLinkDatum<SimNode>[]>([]);
  const simRef = useRef<Simulation<SimNode, undefined> | null>(null);
  const dragNode = useRef<SimNode | null>(null);
  const dragMoved = useRef(false);

  const graph = useMemo(
    () => buildGraph(lib.books, lib.notes, lib.highlights),
    [lib.books, lib.notes, lib.highlights],
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const degree = new Map<string, number>();
    for (const e of graph.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const nodes: SimNode[] = graph.nodes.map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 }));
    const links: SimulationLinkDatum<SimNode>[] = graph.edges.map((e) => ({ ...e }));
    nodesRef.current = nodes;
    linksRef.current = links;

    const sim = forceSimulation(nodes)
      .force('link', forceLink<SimNode, SimulationLinkDatum<SimNode>>(links).id((d) => d.id).distance(110))
      .force('charge', forceManyBody().strength(-260))
      .force('center', forceCenter(size.w / 2, size.h / 2))
      .force('collide', forceCollide<SimNode>().radius((d) => (d.kind === 'book' ? 46 : 24 + d.degree * 3)))
      .alphaDecay(0.02)
      .on('tick', () => setTick((t) => t + 1));
    simRef.current = sim;

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
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      sim.stop();
      simRef.current = null;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [graph, size]);

  const openNode = (n: SimNode) => {
    if (dragMoved.current) return;
    const [kind, id] = n.id.split(':');
    if (kind === 'book') lib.openReader(id);
    else lib.navigate({ view: 'note', noteId: id });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-foreground/15 px-10 pb-5 pt-10">
        <div className="font-meta text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          知识图谱 · {graph.nodes.length} 节点 / {graph.edges.length} 连线
        </div>
        <h1 className="font-reading mt-2 text-[34px] font-bold tracking-wide">图谱</h1>
      </header>
      <div ref={wrapRef} className="relative flex-1 overflow-hidden">
        {graph.nodes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
            <Network size={28} strokeWidth={1.4} />
            <p className="mt-3 text-sm">还没有可连接的内容。写笔记时用 [[双链]] 把它们织成网。</p>
          </div>
        ) : (
          <svg width={size.w} height={size.h} className="block">
            {linksRef.current.map((l, i) => {
              const s = l.source as SimNode;
              const t = l.target as SimNode;
              if (s.x == null || t.x == null) return null;
              return (
                <line
                  key={i}
                  x1={s.x}
                  y1={s.y}
                  x2={t.x}
                  y2={t.y}
                  stroke="#8a7d6b"
                  strokeOpacity={0.35}
                  strokeWidth={1}
                />
              );
            })}
            {nodesRef.current.map((n) => {
              if (n.x == null || n.y == null) return null;
              const isBook = n.kind === 'book';
              const w = Math.max(30, n.label.length * 12 + 16);
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  className="cursor-pointer select-none"
                  onPointerDown={() => {
                    dragMoved.current = false;
                    dragNode.current = nodesRef.current.find((x) => x.id === n.id) ?? null;
                  }}
                  onClick={() => openNode(n)}
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
                  ) : (
                    <circle r={10 + n.degree * 2.5} fill="#ffc198" stroke="#f54001" strokeWidth={1.4} />
                  )}
                  {isBook && (
                    <text
                      textAnchor="middle"
                      y={4.5}
                      fontSize={12}
                      fill="#fffbf5"
                      fontWeight={600}
                      style={{ pointerEvents: 'none' }}
                    >
                      {n.label.length > 10 ? n.label.slice(0, 10) + '…' : n.label}
                    </text>
                  )}
                  {!isBook && (
                    <text
                      textAnchor="middle"
                      y={26 + n.degree * 2.5}
                      fontSize={11}
                      fill="#4f483e"
                      style={{ pointerEvents: 'none' }}
                    >
                      {n.label.length > 12 ? n.label.slice(0, 12) + '…' : n.label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
        <div className="font-meta pointer-events-none absolute bottom-4 left-6 text-[10.5px] leading-5 text-muted-foreground/70">
          <span className="mr-4 inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-5 rounded-[2px] bg-[#f54001]" /> 书籍
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-3 rounded-full border border-[#f54001] bg-[#ffc198]" /> 笔记
          </span>
          <span className="ml-4">拖动可整理布局 · 点击打开</span>
        </div>
      </div>
    </div>
  );
}
