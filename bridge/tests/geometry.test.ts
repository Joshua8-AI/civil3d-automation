import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  area,
  bbox,
  decimate,
  densifyPerimeter,
  isDegeneratePlan,
  openRing,
  planGrid,
  pointInPolygon,
  polygonContainsPolygon,
  polygonSegmentDistance,
  segmentPolygonDistance,
  segmentSegmentDistance,
  segmentsIntersect,
  signedArea,
  validatePolygon,
} from "../src/core/geometry.js";

const square = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

describe("geometry basics", () => {
  it("area and orientation", () => {
    expect(area(square)).toBe(100);
    expect(signedArea(square)).toBe(100);
    expect(signedArea([...square].reverse())).toBe(-100);
    expect(openRing([...square, { x: 0, y: 0 }])).toHaveLength(4);
  });

  it("point in polygon", () => {
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, square)).toBe(false);
    expect(pointInPolygon({ x: -0.1, y: 5 }, square)).toBe(false);
  });

  it("segments", () => {
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(true);
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 })).toBe(false);
    expect(segmentSegmentDistance({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 })).toBe(1);
  });

  it("segment-polygon distance", () => {
    expect(segmentPolygonDistance({ x: 20, y: 5 }, { x: 30, y: 5 }, square)).toBe(10);
    expect(segmentPolygonDistance({ x: -5, y: 5 }, { x: 30, y: 5 }, square)).toBe(0); // crosses
    expect(segmentPolygonDistance({ x: 2, y: 2 }, { x: 3, y: 3 }, square)).toBe(0); // inside
  });

  it("polygon-segment distance and containment", () => {
    const inner = [
      { x: 2, y: 2 },
      { x: 4, y: 2 },
      { x: 4, y: 4 },
      { x: 2, y: 4 },
    ];
    expect(polygonSegmentDistance(inner, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(2);
    expect(polygonContainsPolygon(square, inner)).toBe(true);
    expect(polygonContainsPolygon(inner, square)).toBe(false);
  });

  it("validatePolygon rejects degenerate input", () => {
    expect(() => validatePolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toThrow();
    expect(() => validatePolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }])).toThrow(/zero area/);
  });

  it("densifyPerimeter covers the perimeter at the requested spacing", () => {
    const pts = densifyPerimeter(square, 2.5);
    expect(pts).toHaveLength(16);
    expect(() => densifyPerimeter(square, 0)).toThrow();
  });

  it("isDegeneratePlan", () => {
    expect(isDegeneratePlan([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }])).toBe(true);
    expect(isDegeneratePlan(square)).toBe(false);
  });
});

describe("planGrid", () => {
  it("respects maxPoints and includes boundary vertices", () => {
    const g = planGrid({ polygon: square }, 50);
    expect(g.points.length).toBeLessThanOrEqual(50);
    expect(g.points.slice(0, 4)).toEqual(square);
    for (const p of g.points.slice(4)) expect(pointInPolygon(p, square) || p.x === 0 || p.y === 0).toBe(true);
  });

  it("never repeats a plan point when boundary vertices land on grid nodes", () => {
    // Live on Civil 3D 2027 + Revit 2027: a 200 x 200 ft boundary with 10 ft spacing put the
    // corners on grid nodes, and Revit rejected the toposolid ("Duplicate point in plan").
    const box = [
      { x: 4470.42, y: 3922.4 },
      { x: 4670.42, y: 3922.4 },
      { x: 4670.42, y: 4122.4 },
      { x: 4470.42, y: 4122.4 },
    ];
    const g = planGrid({ polygon: box }, 2000, 10);
    const keys = g.points.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("coarsens an over-dense requested spacing", () => {
    const g = planGrid({ bbox: { minX: 0, minY: 0, maxX: 100, maxY: 100 } }, 100, 0.1);
    expect(g.coarsened).toBe(true);
    expect(g.points.length).toBeLessThanOrEqual(100);
  });

  it("keeps an adequate requested spacing", () => {
    const g = planGrid({ bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 } }, 1000, 1);
    expect(g.coarsened).toBe(false);
    expect(g.points).toHaveLength(121);
  });

  it("property: never exceeds maxPoints", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1e4, noNaN: true }),
        fc.double({ min: 1, max: 1e4, noNaN: true }),
        fc.integer({ min: 4, max: 3000 }),
        fc.option(fc.double({ min: 0.01, max: 100, noNaN: true }), { nil: undefined }),
        (w, h, max, spacing) => {
          const g = planGrid({ bbox: { minX: 0, minY: 0, maxX: w, maxY: h } }, max, spacing);
          expect(g.points.length).toBeLessThanOrEqual(max);
          expect(g.points.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("decimate", () => {
  it("returns input unchanged under budget (minus duplicates)", () => {
    const pts = [
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: 2 },
      { x: 1, y: 0, z: 1 },
    ];
    const d = decimate(pts, 10);
    expect(d.points).toHaveLength(2);
    expect(d.cellSize).toBeNull();
  });

  it("property: result is within budget, a subset of the input, and spans the extent", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ x: fc.double({ min: 0, max: 1000, noNaN: true }), y: fc.double({ min: 0, max: 1000, noNaN: true }), z: fc.double({ min: 0, max: 50, noNaN: true }) }), { minLength: 50, maxLength: 2000 }),
        fc.integer({ min: 10, max: 200 }),
        (pts, max) => {
          const d = decimate(pts, max);
          expect(d.points.length).toBeLessThanOrEqual(max);
          const set = new Set(pts);
          for (const p of d.points) expect(set.has(p)).toBe(true);
          if (d.points.length > 0) {
            const b0 = bbox(pts);
            const b1 = bbox(d.points);
            // Binning keeps something from the extreme cells: extent shrinks by at most ~one cell.
            const slack = (d.cellSize ?? 0) * 1.5 + 1e-9;
            expect(b1.minX - b0.minX).toBeLessThanOrEqual(slack);
            expect(b0.maxX - b1.maxX).toBeLessThanOrEqual(slack);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
