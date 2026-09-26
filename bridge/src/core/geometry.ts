/**
 * Pure 2D geometry helpers (plan view). Units are whatever the caller uses;
 * nothing here converts units.
 */

import type { Vec2, Vec3 } from "./transform.js";

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function bbox(points: readonly Vec2[]): BBox {
  if (points.length === 0) throw new Error("bbox of an empty point set");
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function bboxPolygon(b: BBox): Vec2[] {
  return [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ];
}

/** Drop a closing vertex equal to the first one, if present. */
export function openRing<T extends Vec2>(polygon: readonly T[]): T[] {
  if (polygon.length > 1) {
    const a = polygon[0];
    const b = polygon[polygon.length - 1];
    if (a.x === b.x && a.y === b.y) return polygon.slice(0, -1);
  }
  return polygon.slice();
}

export function validatePolygon(polygon: readonly Vec2[], label = "polygon"): Vec2[] {
  const ring = openRing(polygon);
  if (ring.length < 3) throw new Error(`${label} needs at least 3 distinct vertices.`);
  for (const p of ring) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error(`${label} has a non-finite vertex.`);
  }
  if (Math.abs(signedArea(ring)) === 0) throw new Error(`${label} has zero area.`);
  return ring;
}

/** Shoelace signed area; positive for counter-clockwise rings. */
export function signedArea(polygon: readonly Vec2[]): number {
  const ring = openRing(polygon);
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function area(polygon: readonly Vec2[]): number {
  return Math.abs(signedArea(polygon));
}

/** Even-odd ray casting. Points exactly on an edge may go either way. */
export function pointInPolygon(p: Vec2, polygon: readonly Vec2[]): boolean {
  const ring = openRing(polygon);
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y) {
      const xCross = ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
      if (p.x < xCross) inside = !inside;
    }
  }
  return inside;
}

export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function orient(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

export function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  const onSeg = (p: Vec2, q: Vec2, r: Vec2) =>
    Math.min(p.x, q.x) <= r.x && r.x <= Math.max(p.x, q.x) && Math.min(p.y, q.y) <= r.y && r.y <= Math.max(p.y, q.y);
  if (o1 === 0 && onSeg(a, b, c)) return true;
  if (o2 === 0 && onSeg(a, b, d)) return true;
  if (o3 === 0 && onSeg(c, d, a)) return true;
  if (o4 === 0 && onSeg(c, d, b)) return true;
  return false;
}

export function segmentSegmentDistance(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  );
}

export function edges(polygon: readonly Vec2[]): Array<[Vec2, Vec2]> {
  const ring = openRing(polygon);
  return ring.map((p, i) => [p, ring[(i + 1) % ring.length]] as [Vec2, Vec2]);
}

/** 0 if the segment touches or lies inside the polygon, else the plan distance. */
export function segmentPolygonDistance(a: Vec2, b: Vec2, polygon: readonly Vec2[]): number {
  if (pointInPolygon(a, polygon) || pointInPolygon(b, polygon)) return 0;
  let best = Infinity;
  for (const [c, d] of edges(polygon)) {
    best = Math.min(best, segmentSegmentDistance(a, b, c, d));
    if (best === 0) return 0;
  }
  return best;
}

/** Minimum plan distance from any point of polygon P to segment (a,b). */
export function polygonSegmentDistance(polygon: readonly Vec2[], a: Vec2, b: Vec2): number {
  let best = Infinity;
  for (const [c, d] of edges(polygon)) best = Math.min(best, segmentSegmentDistance(a, b, c, d));
  return best;
}

/** True if every vertex of inner is inside outer and no edges cross. */
export function polygonContainsPolygon(outer: readonly Vec2[], inner: readonly Vec2[]): boolean {
  for (const p of openRing(inner)) if (!pointInPolygon(p, outer)) return false;
  for (const [a, b] of edges(inner)) for (const [c, d] of edges(outer)) if (segmentsIntersect(a, b, c, d)) return false;
  return true;
}

/** Points along a polygon's perimeter: all vertices plus intermediate points every `spacing`. */
export function densifyPerimeter(polygon: readonly Vec2[], spacing: number): Vec2[] {
  if (!(spacing > 0)) throw new Error("spacing must be > 0");
  const out: Vec2[] = [];
  for (const [a, b] of edges(polygon)) {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len / spacing));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
    }
  }
  return out;
}

export interface GridPlan {
  spacing: number;
  points: Vec2[];
  /** True if the spacing was increased to respect maxPoints. */
  coarsened: boolean;
}

function gridIn(b: BBox, spacing: number, polygon: readonly Vec2[] | null): Vec2[] {
  const pts: Vec2[] = [];
  const nx = Math.floor((b.maxX - b.minX) / spacing + 1e-9);
  const ny = Math.floor((b.maxY - b.minY) / spacing + 1e-9);
  for (let i = 0; i <= nx; i++) {
    const x = b.minX + i * spacing;
    for (let j = 0; j <= ny; j++) {
      const y = b.minY + j * spacing;
      const p = { x, y };
      if (!polygon || pointInPolygon(p, polygon)) pts.push(p);
    }
  }
  return pts;
}

/**
 * Plan a regular sampling grid over a polygon (or bbox) with at most maxPoints
 * samples. If `spacing` is omitted it is derived from the area and maxPoints;
 * if the requested spacing would exceed maxPoints it is coarsened.
 * Boundary vertices are always included so the sampled region keeps its shape.
 */
export function planGrid(
  region: { polygon?: readonly Vec2[]; bbox?: BBox },
  maxPoints: number,
  spacing?: number,
): GridPlan {
  if (!(maxPoints >= 4)) throw new Error("maxPoints must be >= 4");
  const polygon = region.polygon ? validatePolygon(region.polygon, "boundary") : null;
  const b = polygon ? bbox(polygon) : region.bbox;
  if (!b) throw new Error("planGrid needs a polygon or a bbox");
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  if (!(w > 0 && h > 0)) throw new Error("Sampling region has zero width or height.");
  const regionArea = polygon ? area(polygon) : w * h;
  const perimeterPoints = polygon ? polygon.length : 0;
  const budget = Math.max(4, maxPoints - perimeterPoints);

  let s = spacing && spacing > 0 ? spacing : Math.sqrt(regionArea / budget);
  let coarsened = false;
  // Pre-coarsen analytically so a tiny spacing never materialises a huge grid.
  const fill = regionArea / (w * h);
  const estimate = (sp: number) => (Math.floor(w / sp) + 1) * (Math.floor(h / sp) + 1) * fill;
  for (let guard = 0; estimate(s) > budget * 2 && guard < 200; guard++) {
    s *= Math.max(1.05, Math.sqrt(estimate(s) / budget));
    coarsened = true;
  }
  let pts = gridIn(b, s, polygon);
  // Coarsen until within budget (a few iterations at most).
  for (let guard = 0; pts.length > budget && guard < 60; guard++) {
    s *= Math.sqrt(pts.length / budget) * 1.02;
    coarsened = true;
    pts = gridIn(b, s, polygon);
  }
  const all = polygon ? [...polygon.map((p) => ({ x: p.x, y: p.y })), ...pts] : pts;
  return { spacing: s, points: all.slice(0, maxPoints), coarsened };
}

/**
 * Decimate a 3D point cloud to at most maxPoints by grid binning in plan:
 * one representative per cell (the point nearest the cell centre), growing
 * the cell until the budget is met. Also removes exact plan duplicates.
 */
export function decimate(points: readonly Vec3[], maxPoints: number): { points: Vec3[]; cellSize: number | null } {
  const unique = dedupePlan(points);
  if (unique.length <= maxPoints) return { points: unique, cellSize: null };
  const b = bbox(unique);
  const w = Math.max(b.maxX - b.minX, 1e-9);
  const h = Math.max(b.maxY - b.minY, 1e-9);
  let cell = Math.sqrt((w * h) / maxPoints);
  for (let guard = 0; guard < 60; guard++) {
    const cells = new Map<string, { p: Vec3; d: number }>();
    for (const p of unique) {
      const i = Math.floor((p.x - b.minX) / cell);
      const j = Math.floor((p.y - b.minY) / cell);
      const cx = b.minX + (i + 0.5) * cell;
      const cy = b.minY + (j + 0.5) * cell;
      const d = Math.hypot(p.x - cx, p.y - cy);
      const key = `${i},${j}`;
      const cur = cells.get(key);
      if (!cur || d < cur.d) cells.set(key, { p, d });
    }
    if (cells.size <= maxPoints) return { points: [...cells.values()].map((c) => c.p), cellSize: cell };
    cell *= Math.sqrt(cells.size / maxPoints) * 1.02;
  }
  return { points: unique.slice(0, maxPoints), cellSize: cell };
}

export function dedupePlan<T extends Vec2>(points: readonly T[], tolerance = 1e-9): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  const q = (v: number) => Math.round(v / tolerance);
  for (const p of points) {
    const key = `${q(p.x)},${q(p.y)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

/** True if the points are all (nearly) collinear in plan, which a toposolid cannot use. */
export function isDegeneratePlan(points: readonly Vec2[]): boolean {
  if (points.length < 3) return true;
  const a = points[0];
  let far = points[1];
  let farD = 0;
  for (const p of points) {
    const d = Math.hypot(p.x - a.x, p.y - a.y);
    if (d > farD) {
      farD = d;
      far = p;
    }
  }
  if (farD === 0) return true;
  for (const p of points) {
    if (Math.abs(orient(a, far, p)) / farD > farD * 1e-9) return false;
  }
  return true;
}
