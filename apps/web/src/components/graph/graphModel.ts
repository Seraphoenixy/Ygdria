import type { GraphData, GraphEdge } from "@ygdria/shared";

export type GraphNodeView = {
  id: string;
  label: string;
  degree: number;
  isProtected: boolean;
};

export type ViewTransform = { x: number; y: number; k: number };

/** Undirected neighbor sets, used for hover highlighting. */
export function buildAdjacency(edges: readonly GraphEdge[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
    adjacency.get(edge.source)!.add(edge.target);
    adjacency.get(edge.target)!.add(edge.source);
  }
  return adjacency;
}

/** Server titles can be empty for protected notes; substitute a localized label. */
export function decorateNodes(data: GraphData, protectedLabel: string): GraphNodeView[] {
  const adjacency = buildAdjacency(data.edges);
  return data.nodes.map((node) => ({
    id: node.id,
    label: node.isProtected || !node.title ? protectedLabel : node.title,
    degree: adjacency.get(node.id)?.size ?? 0,
    isProtected: node.isProtected,
  }));
}

export function countEdgesByKind(edges: readonly GraphEdge[]): { relation: number; link: number } {
  const counts = { relation: 0, link: 0 };
  for (const edge of edges) counts[edge.kind] += 1;
  return counts;
}

/** Area grows with connectivity but stays inside a readable range. */
export function nodeRadius(degree: number): number {
  return Math.min(3.5 + Math.sqrt(degree) * 2.4, 14);
}

export function worldToScreen(
  point: { x: number; y: number },
  transform: ViewTransform,
): { x: number; y: number } {
  return { x: point.x * transform.k + transform.x, y: point.y * transform.k + transform.y };
}

export function screenToWorld(
  point: { x: number; y: number },
  transform: ViewTransform,
): { x: number; y: number } {
  return { x: (point.x - transform.x) / transform.k, y: (point.y - transform.y) / transform.k };
}

/** Transform that centers the world-space bounding box inside the viewport. */
export function fitTransform(
  points: ReadonlyArray<{ x: number; y: number }>,
  viewport: { width: number; height: number },
  padding = 48,
): ViewTransform {
  if (points.length === 0) return { x: viewport.width / 2, y: viewport.height / 2, k: 1 };
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const k = Math.min((viewport.width - padding * 2) / width, (viewport.height - padding * 2) / height, 2);
  const clamped = Math.max(k, 0.05);
  return {
    x: viewport.width / 2 - ((minX + maxX) / 2) * clamped,
    y: viewport.height / 2 - ((minY + maxY) / 2) * clamped,
    k: clamped,
  };
}
