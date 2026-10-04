import { describe, expect, it } from "vitest";
import {
  buildAdjacency,
  countEdgesByKind,
  fitTransform,
  nodeRadius,
  screenToWorld,
  worldToScreen,
} from "./graphModel.js";
import type { GraphEdge } from "@ygdria/shared";

const edge = (source: string, target: string): GraphEdge =>
  ({ source, target, kind: source < target ? "relation" : "link" }) as GraphEdge;

describe("graphModel", () => {
  it("builds undirected adjacency and treats isolated nodes as empty", () => {
    const adjacency = buildAdjacency([edge("a", "b"), edge("b", "c")]);
    expect([...adjacency.get("b")!].sort()).toEqual(["a", "c"]);
    expect(adjacency.get("a")).toEqual(new Set(["b"]));
    expect(adjacency.get("z")).toBeUndefined();
  });

  it("counts edges by kind", () => {
    expect(
      countEdgesByKind([edge("a", "b"), edge("b", "a"), edge("c", "d")]),
    ).toEqual({ relation: 2, link: 1 });
  });

  it("scales node radius by degree with a cap", () => {
    expect(nodeRadius(0)).toBe(3.5);
    expect(nodeRadius(10)).toBeGreaterThan(nodeRadius(1));
    expect(nodeRadius(400)).toBe(14);
  });

  it("round-trips between world and screen coordinates", () => {
    const transform = { x: 120, y: -40, k: 1.5 };
    const screen = worldToScreen({ x: 10, y: -20 }, transform);
    expect(screen).toEqual({ x: 135, y: -70 });
    expect(screenToWorld(screen, transform)).toEqual({ x: 10, y: -20 });
  });

  it("fits a point cloud inside the viewport with padding", () => {
    const transform = fitTransform(
      [{ x: 0, y: 0 }, { x: 100, y: 50 }],
      { width: 400, height: 300 },
      50,
    );
    expect(transform.k).toBe(2);
    const screen = [
      worldToScreen({ x: 0, y: 0 }, transform),
      worldToScreen({ x: 100, y: 50 }, transform),
    ];
    for (const point of screen) {
      expect(point.x).toBeGreaterThanOrEqual(50);
      expect(point.x).toBeLessThanOrEqual(350);
      expect(point.y).toBeGreaterThanOrEqual(50);
      expect(point.y).toBeLessThanOrEqual(250);
    }
  });

  it("returns a centered identity transform for an empty graph", () => {
    expect(fitTransform([], { width: 400, height: 300 })).toEqual({ x: 200, y: 150, k: 1 });
  });
});
