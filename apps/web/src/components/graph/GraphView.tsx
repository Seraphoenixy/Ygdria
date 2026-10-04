import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type { GraphEdge } from "@ygdria/shared";
import type { YgdriaClient } from "@ygdria/api-client";
import { t, type Locale } from "../../lib/i18n";
import {
  buildAdjacency,
  countEdgesByKind,
  decorateNodes,
  fitTransform,
  nodeRadius,
  screenToWorld,
  worldToScreen,
  type GraphNodeView,
  type ViewTransform,
} from "./graphModel";

type SimNode = GraphNodeView & SimulationNodeDatum;
type SimLink = SimulationLinkDatum<SimNode> & { kind: GraphEdge["kind"] };

type GraphColors = {
  node: string;
  nodeStroke: string;
  nodeProtected: string;
  edgeRelation: string;
  edgeLink: string;
  edgeDim: string;
  label: string;
  labelHalo: string;
  highlightRing: string;
};

function readGraphColors(canvas: HTMLCanvasElement): GraphColors {
  const style = getComputedStyle(canvas);
  const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    node: pick("--graph-node", "#2f81f7"),
    nodeStroke: pick("--graph-node-stroke", "#ffffff"),
    nodeProtected: pick("--graph-node-protected", "#8b949e"),
    edgeRelation: pick("--graph-edge-relation", "rgba(47, 129, 247, 0.55)"),
    edgeLink: pick("--graph-edge-link", "rgba(139, 148, 158, 0.4)"),
    edgeDim: pick("--graph-edge-dim", "rgba(139, 148, 158, 0.12)"),
    label: pick("--graph-label", "#34353a"),
    labelHalo: pick("--graph-label-halo", "rgba(255, 255, 255, 0.85)"),
    highlightRing: pick("--graph-highlight-ring", "#0f6cbd"),
  };
}

type GraphViewProps = {
  client: YgdriaClient;
  locale: Locale;
  onOpenNote: (noteId: string) => void;
};

/** Force-directed knowledge graph on a self-drawn canvas. */
export function GraphView({ client, locale, onOpenNote }: GraphViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const transformRef = useRef<ViewTransform>({ x: 0, y: 0, k: 1 });
  const hoverRef = useRef<string | undefined>(undefined);
  const colorsRef = useRef<GraphColors | null>(null);
  const dragRef = useRef<
    | { kind: "node"; id: string; moved: boolean }
    | { kind: "pan"; startX: number; startY: number; origin: ViewTransform; moved: boolean }
    | null
  >(null);

  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  const graphQuery = useQuery({
    queryKey: ["graph"],
    queryFn: () => client.graph(),
    staleTime: 60_000,
  });

  const protectedLabel = t(locale, "graphProtectedNode");
  const viewNodes = useMemo(
    () => (graphQuery.data ? decorateNodes(graphQuery.data, protectedLabel) : []),
    [graphQuery.data, protectedLabel],
  );
  const edgeCounts = useMemo(
    () => countEdgesByKind(graphQuery.data?.edges ?? []),
    [graphQuery.data],
  );
  const adjacency = useMemo(
    () => buildAdjacency(graphQuery.data?.edges ?? []),
    [graphQuery.data],
  );
  const adjacencyRef = useRef(adjacency);
  adjacencyRef.current = adjacency;
  const links = graphQuery.data?.edges ?? [];

  const draw = useRef(() => {});
  draw.current = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const dpr = window.devicePixelRatio || 1;
    // Clear the whole backing store: the CSS box can briefly lag the backing
    // size during layout, and a clientWidth-based clear would leave ghosts.
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = colorsRef.current;
    if (!colors) return;
    const transform = transformRef.current;
    const hover = hoverRef.current;
    const neighbors = hover ? adjacencyRef.current.get(hover) : undefined;

    for (const link of linksRef.current) {
      const source = link.source as SimNode;
      const target = link.target as SimNode;
      if (source.x === undefined || source.y === undefined || target.x === undefined || target.y === undefined)
        continue;
      const dimmed = Boolean(hover) && source.id !== hover && target.id !== hover;
      context.strokeStyle = dimmed
        ? colors.edgeDim
        : link.kind === "relation"
          ? colors.edgeRelation
          : colors.edgeLink;
      context.lineWidth = dimmed ? 1 : 1.4;
      const a = worldToScreen({ x: source.x, y: source.y }, transform);
      const b = worldToScreen({ x: target.x, y: target.y }, transform);
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
    }

    context.textAlign = "center";
    for (const node of nodesRef.current) {
      if (node.x === undefined || node.y === undefined) continue;
      const screen = worldToScreen({ x: node.x, y: node.y }, transform);
      const radius = nodeRadius(node.degree);
      const dimmed = Boolean(hover) && node.id !== hover && !neighbors?.has(node.id);
      context.globalAlpha = dimmed ? 0.25 : 1;
      context.beginPath();
      context.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
      context.fillStyle = node.isProtected ? colors.nodeProtected : colors.node;
      context.fill();
      context.lineWidth = 1.5;
      context.strokeStyle = colors.nodeStroke;
      context.stroke();
      if (node.id === hover) {
        context.beginPath();
        context.arc(screen.x, screen.y, radius + 3, 0, Math.PI * 2);
        context.strokeStyle = colors.highlightRing;
        context.stroke();
      }
      const showLabel = transform.k >= 0.85 || node.id === hover;
      if (showLabel) {
        const label = node.label.length > 24 ? `${node.label.slice(0, 23)}…` : node.label;
        context.font = "11px system-ui, sans-serif";
        context.fillStyle = colors.labelHalo;
        context.fillText(label, screen.x, screen.y + radius + 12);
        context.fillStyle = colors.label;
        context.fillText(label, screen.x, screen.y + radius + 11);
      }
      context.globalAlpha = 1;
    }
  };

  // Canvas backing resolution + theme-aware colors.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      setSize({ width, height });
      draw.current();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    const themeObserver = new MutationObserver(() => {
      colorsRef.current = readGraphColors(canvas);
      draw.current();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    colorsRef.current = readGraphColors(canvas);
    draw.current();
    return () => {
      observer.disconnect();
      themeObserver.disconnect();
    };
  }, []);

  // Rebuild the simulation whenever graph data or viewport size arrives.
  useEffect(() => {
    if (!graphQuery.data || size.width === 0) return;
    const nodes: SimNode[] = viewNodes.map((node, index) => ({
      ...node,
      x: size.width / 2 + Math.cos(index * 2.4) * (60 + index * 4),
      y: size.height / 2 + Math.sin(index * 2.4) * (60 + index * 4),
    }));
    const links: SimLink[] = graphQuery.data.edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
    }));
    nodesRef.current = nodes;
    linksRef.current = links;
    const simulation = forceSimulation<SimNode, SimLink>(nodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((node) => node.id)
          .distance(90)
          .strength(0.5),
      )
      .force("charge", forceManyBody<SimNode>().strength(-160))
      .force("collide", forceCollide<SimNode>((node) => nodeRadius(node.degree) + 6))
      .force("x", forceX<SimNode>(size.width / 2).strength(0.04))
      .force("y", forceY<SimNode>(size.height / 2).strength(0.06))
      .alpha(1)
      .alphaDecay(0.028);
    simulation.on("tick", () => draw.current());
    simRef.current = simulation;
    transformRef.current = { x: 0, y: 0, k: 1 };
    return () => {
      simulation.stop();
      simRef.current = null;
    };
  }, [graphQuery.data, viewNodes, size.width, size.height]);

  const fitView = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const points = nodesRef.current
      .filter((node) => node.x !== undefined && node.y !== undefined)
      .map((node) => ({ x: node.x!, y: node.y! }));
    transformRef.current = fitTransform(points, {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
    });
    draw.current();
  };

  const relayout = () => {
    const simulation = simRef.current;
    if (!simulation) return;
    for (const [index, node] of nodesRef.current.entries()) {
      node.fx = undefined;
      node.fy = undefined;
      node.x = size.width / 2 + Math.cos(index * 2.4) * (60 + index * 4);
      node.y = size.height / 2 + Math.sin(index * 2.4) * (60 + index * 4);
    }
    simulation.alpha(1).restart();
  };

  const hitTest = (clientX: number, clientY: number): SimNode | undefined => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const bounds = canvas.getBoundingClientRect();
    const pointer = screenToWorld({ x: clientX - bounds.left, y: clientY - bounds.top }, transformRef.current);
    let closest: SimNode | undefined;
    let closestDistance = Infinity;
    for (const node of nodesRef.current) {
      if (node.x === undefined || node.y === undefined) continue;
      const distance = Math.hypot(node.x - pointer.x, node.y - pointer.y);
      const reach = nodeRadius(node.degree) + 4 / transformRef.current.k;
      if (distance <= reach && distance < closestDistance) {
        closest = node;
        closestDistance = distance;
      }
    }
    return closest;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const node = hitTest(event.clientX, event.clientY);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (node) dragRef.current = { kind: "node", id: node.id, moved: false };
    else
      dragRef.current = {
        kind: "pan",
        startX: event.clientX,
        startY: event.clientY,
        origin: { ...transformRef.current },
        moved: false,
      };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      const hovered = hitTest(event.clientX, event.clientY);
      const changed = hovered?.id !== hoverRef.current;
      hoverRef.current = hovered?.id;
      event.currentTarget.style.cursor = hovered ? "pointer" : "grab";
      if (changed) draw.current();
      return;
    }
    if (drag.kind === "node") {
      const node = nodesRef.current.find((item) => item.id === drag.id);
      if (!node) return;
      const canvas = canvasRef.current!;
      const bounds = canvas.getBoundingClientRect();
      const pointer = screenToWorld(
        { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
        transformRef.current,
      );
      node.fx = pointer.x;
      node.fy = pointer.y;
      drag.moved = true;
      simRef.current?.alphaTarget(0.25).restart();
      draw.current();
      return;
    }
    transformRef.current = {
      ...drag.origin,
      x: drag.origin.x + (event.clientX - drag.startX),
      y: drag.origin.y + (event.clientY - drag.startY),
    };
    if (Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY) > 4)
      drag.moved = true;
    draw.current();
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    simRef.current?.alphaTarget(0);
    if (drag?.kind === "node") {
      const node = nodesRef.current.find((item) => item.id === drag.id);
      if (node) {
        node.fx = undefined;
        node.fy = undefined;
      }
      if (!drag.moved) onOpenNote(drag.id);
    }
    event.currentTarget.style.cursor = "grab";
  };

  const onWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const canvas = canvasRef.current!;
    const bounds = canvas.getBoundingClientRect();
    const pointer = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    const factor = Math.exp(-event.deltaY * 0.0015);
    const k = Math.min(Math.max(transformRef.current.k * factor, 0.05), 4);
    const world = screenToWorld(pointer, transformRef.current);
    transformRef.current = { k, x: pointer.x - world.x * k, y: pointer.y - world.y * k };
    draw.current();
  };

  const hasData = Boolean(graphQuery.data);
  const hasEdges = links.length > 0;

  return (
    <div className="graph-view">
      <div className="graph-header">
        <span className="graph-stats">
          {graphQuery.isLoading
            ? t(locale, "loading")
            : t(locale, "graphStats", {
                nodes: String(viewNodes.length),
                edges: String(links.length),
              })}
        </span>
        <span className="graph-legend">
          <span className="graph-legend-item">
            <i className="graph-legend-swatch relation" />
            {t(locale, "graphLegendRelation")} ({edgeCounts.relation})
          </span>
          <span className="graph-legend-item">
            <i className="graph-legend-swatch link" />
            {t(locale, "graphLegendLink")} ({edgeCounts.link})
          </span>
        </span>
        <span className="graph-actions">
          <button className="graph-btn" onClick={fitView} disabled={!hasData}>
            {t(locale, "graphFit")}
          </button>
          <button className="graph-btn" onClick={relayout} disabled={!hasData}>
            {t(locale, "graphRelayout")}
          </button>
        </span>
      </div>
      {graphQuery.isError ? (
        <div className="graph-empty">
          <h2>{t(locale, "graphLoadFailed")}</h2>
          <p>{String((graphQuery.error as Error | null)?.message ?? "")}</p>
        </div>
      ) : hasData && viewNodes.length === 0 ? (
        <div className="graph-empty">
          <h2>{t(locale, "graphView")}</h2>
          <p>{t(locale, "graphEmpty")}</p>
        </div>
      ) : (
        <div className="graph-canvas-wrap" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            className="graph-canvas"
            style={{ cursor: "grab" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => {
              hoverRef.current = undefined;
              draw.current();
            }}
            onWheel={onWheel}
            onDoubleClick={fitView}
          />
          {hasData && !hasEdges && (
            <div className="graph-hint">{t(locale, "graphEmpty")}</div>
          )}
        </div>
      )}
    </div>
  );
}
