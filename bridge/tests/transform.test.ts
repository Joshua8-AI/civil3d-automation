import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  anchorAtOrigin,
  angleDiffDeg,
  azimuthDeg,
  civilToInternal,
  civilToSharedMm,
  compareProjectPositions,
  computeProjectPosition,
  describeRotation,
  fromSharedTransform,
  internalToCivil,
  internalToShared,
  normalizeAngleDeg,
  rotationFromTwoPoints,
  sharedMmToCivil,
  sharedToInternal,
  toSharedTransform,
  type ProjectPosition,
  type Vec3,
} from "../src/core/transform.js";
import { LINEAR_UNITS, toMm } from "../src/core/units.js";

const near = (a: Vec3, b: Vec3, tol: number) => {
  expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(tol);
  expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(tol);
  expect(Math.abs(a.z - b.z)).toBeLessThanOrEqual(tol);
};

const pos = (ew: number, ns: number, el: number, ang: number, P: Vec3 = { x: 0, y: 0, z: 0 }): ProjectPosition => ({
  eastWest_mm: ew,
  northSouth_mm: ns,
  elevation_mm: el,
  angleToTrueNorth_deg: ang,
  internalPoint_mm: P,
});

// Realistic ranges: state-plane coordinates up to ~1e10 mm, buildings within 32 km of origin.
const arbCoord = fc.double({ min: -5e9, max: 5e9, noNaN: true, noDefaultInfinity: true });
const arbLocal = fc.double({ min: -3e7, max: 3e7, noNaN: true, noDefaultInfinity: true });
const arbZ = fc.double({ min: -1e6, max: 1e7, noNaN: true, noDefaultInfinity: true });
const arbAngle = fc.double({ min: -720, max: 720, noNaN: true, noDefaultInfinity: true });
const arbVec = fc.record({ x: arbLocal, y: arbLocal, z: arbZ });
const arbPos = fc.record({
  eastWest_mm: arbCoord,
  northSouth_mm: arbCoord,
  elevation_mm: arbZ,
  angleToTrueNorth_deg: arbAngle,
  internalPoint_mm: arbVec,
});

describe("transform: known answers", () => {
  it("identity position maps a point to itself", () => {
    near(internalToShared(pos(0, 0, 0, 0), { x: 1, y: 2, z: 3 }), { x: 1, y: 2, z: 3 }, 0);
  });

  it("pure translation", () => {
    near(internalToShared(pos(1000, 2000, 100, 0), { x: 1, y: 2, z: 3 }), { x: 1001, y: 2002, z: 103 }, 1e-9);
  });

  it("+90 deg rotates internal +X onto shared +Y (counter-clockwise)", () => {
    const p = pos(1000, 2000, 100, 90);
    near(internalToShared(p, { x: 1, y: 0, z: 0 }), { x: 1000, y: 2001, z: 100 }, 1e-9);
    near(internalToShared(p, { x: 0, y: 1, z: 5 }), { x: 999, y: 2000, z: 105 }, 1e-9);
  });

  it("anchored at a non-origin internal point: that point lands exactly on T", () => {
    const p = pos(5e9, 6e8, 30_000, 33.3, { x: 12_345, y: -6_789, z: 1_000 });
    near(internalToShared(p, { x: 12_345, y: -6_789, z: 1_000 }), { x: 5e9, y: 6e8, z: 30_000 }, 1e-6);
  });

  it("state-plane point in US survey feet converts exactly", () => {
    const s = civilToSharedMm({ x: 6_000_000, y: 2_000_000, z: 500 }, "usSurveyFeet");
    expect(s.x).toBeCloseTo(1_828_803_657.6073152, 3);
    expect(s.y).toBeCloseTo(609_601_219.2024384, 3);
    expect(s.z).toBeCloseTo(152_400.3048, 4);
  });

  it("computeProjectPosition makes the chosen internal point land on the Civil 3D point", () => {
    const civil = { x: 6_000_000, y: 2_000_000, z: 100 };
    const P = { x: 5_000, y: 7_000, z: 0 };
    const p = computeProjectPosition({ civilBasePoint: civil, drawingUnit: "feet", internalPoint_mm: P, angleToTrueNorth_deg: 30 });
    near(internalToCivil(p, P, "feet"), civil, 1e-9);
    // A point 10 ft (3048 mm) along internal +X lands 10 ft away at bearing 60 deg CCW from east = azimuth 60.
    const q = internalToCivil(p, { x: P.x + 3048, y: P.y, z: 0 }, "feet");
    expect(Math.hypot(q.x - civil.x, q.y - civil.y)).toBeCloseTo(10, 9);
    expect(azimuthDeg(civil, q)).toBeCloseTo(60, 9);
  });

  it("two-point rotation: internal east maps to civil north => +90", () => {
    const r = rotationFromTwoPoints({ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 0 }, { x: 3048, y: 0 }, "feet");
    expect(r.angleToTrueNorth_deg).toBeCloseTo(90, 12);
    expect(r.scaleRatio).toBeCloseTo(1, 12);
  });

  it("two-point rotation detects a units mistake through the scale ratio", () => {
    const r = rotationFromTwoPoints({ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 0 }, { x: 10_000, y: 0 }, "feet");
    expect(r.scaleRatio).toBeCloseTo(0.3048, 9);
  });

  it("two-point rotation rejects coincident points", () => {
    expect(() => rotationFromTwoPoints({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }, "feet")).toThrow();
  });

  it("azimuth: north 0, east 90, south 180, west 270", () => {
    const o = { x: 0, y: 0 };
    expect(azimuthDeg(o, { x: 0, y: 1 })).toBeCloseTo(0, 12);
    expect(azimuthDeg(o, { x: 1, y: 0 })).toBeCloseTo(90, 12);
    expect(azimuthDeg(o, { x: 0, y: -1 })).toBeCloseTo(180, 12);
    expect(azimuthDeg(o, { x: -1, y: 0 })).toBeCloseTo(270, 12);
  });

  it("normalizeAngleDeg", () => {
    expect(normalizeAngleDeg(180)).toBe(180);
    expect(normalizeAngleDeg(-180)).toBe(180);
    expect(normalizeAngleDeg(270)).toBe(-90);
    expect(normalizeAngleDeg(-450)).toBe(-90);
    expect(normalizeAngleDeg(720)).toBe(0);
    expect(Object.is(normalizeAngleDeg(-360), -0)).toBe(false);
    expect(() => normalizeAngleDeg(NaN)).toThrow();
  });

  it("describeRotation wording", () => {
    expect(describeRotation(0)).toMatch(/coincides/);
    expect(describeRotation(12)).toMatch(/clockwise \(east\)/);
    expect(describeRotation(-12)).toMatch(/counter-clockwise \(west\)/);
  });

  it("compareProjectPositions detects an opposite rotation sign", () => {
    const a = pos(1e6, 2e6, 0, 20);
    const b = pos(1e6, 2e6, 0, -20);
    const c = compareProjectPositions(a, b);
    expect(c.rotationDelta_deg).toBeCloseTo(-40, 9);
    expect(c.maxHorizontalDelta_mm).toBeGreaterThan(1000);
  });
});

describe("transform: round-trip properties", () => {
  it("sharedToInternal is the inverse of internalToShared", () => {
    fc.assert(
      fc.property(arbPos, arbVec, (p, v) => {
        near(sharedToInternal(p, internalToShared(p, v)), v, 1e-4);
      }),
      { numRuns: 500 },
    );
  });

  it("internalToShared is the inverse of sharedToInternal", () => {
    fc.assert(
      fc.property(arbPos, arbVec, (p, v) => {
        const shared = internalToShared(p, v);
        near(internalToShared(p, sharedToInternal(p, shared)), shared, 1e-4);
      }),
      { numRuns: 500 },
    );
  });

  it("the transform is rigid: distances are preserved", () => {
    fc.assert(
      fc.property(arbPos, arbVec, arbVec, (p, a, b) => {
        const d0 = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        const sa = internalToShared(p, a);
        const sb = internalToShared(p, b);
        const d1 = Math.hypot(sa.x - sb.x, sa.y - sb.y, sa.z - sb.z);
        expect(Math.abs(d1 - d0)).toBeLessThanOrEqual(1e-4);
      }),
      { numRuns: 300 },
    );
  });

  it("anchorAtOrigin describes the same transform", () => {
    fc.assert(
      fc.property(arbPos, arbVec, (p, v) => {
        near(internalToShared(anchorAtOrigin(p), v), internalToShared(p, v), 1e-4);
      }),
      { numRuns: 300 },
    );
  });

  it("toSharedTransform/fromSharedTransform round trip", () => {
    fc.assert(
      fc.property(arbPos, arbVec, (p, v) => {
        near(internalToShared(fromSharedTransform(toSharedTransform(p)), v), internalToShared(p, v), 1e-4);
      }),
      { numRuns: 300 },
    );
  });

  it("civil <-> shared mm round trip for every unit", () => {
    fc.assert(
      fc.property(fc.constantFrom(...LINEAR_UNITS), fc.record({ x: arbCoord, y: arbCoord, z: arbZ }), (u, c) => {
        const back = sharedMmToCivil(civilToSharedMm(c, u), u);
        near(back, c, 1e-6 * Math.max(1, Math.abs(c.x), Math.abs(c.y)) * 1e-3);
      }),
      { numRuns: 300 },
    );
  });

  it("civil -> internal -> civil round trip through a computed position", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LINEAR_UNITS.filter((u) => u !== "millimeters" && u !== "inches")),
        fc.record({ x: fc.double({ min: 0, max: 2e7, noNaN: true }), y: fc.double({ min: 0, max: 2e7, noNaN: true }), z: fc.double({ min: -100, max: 3000, noNaN: true }) }),
        arbVec,
        arbAngle,
        fc.record({ x: fc.double({ min: -500, max: 500, noNaN: true }), y: fc.double({ min: -500, max: 500, noNaN: true }), z: fc.double({ min: -10, max: 10, noNaN: true }) }),
        (u, base, P, angle, offset) => {
          const p = computeProjectPosition({ civilBasePoint: base, drawingUnit: u, internalPoint_mm: P, angleToTrueNorth_deg: angle });
          // Base point lands exactly.
          const landed = internalToCivil(p, P, u);
          expect(Math.hypot(toMm(landed.x - base.x, u), toMm(landed.y - base.y, u), toMm(landed.z - base.z, u))).toBeLessThanOrEqual(1e-3);
          // Arbitrary nearby civil point survives civil -> internal -> civil.
          const c = { x: base.x + offset.x, y: base.y + offset.y, z: base.z + offset.z };
          const back = internalToCivil(p, civilToInternal(p, c, u), u);
          expect(Math.hypot(toMm(back.x - c.x, u), toMm(back.y - c.y, u), toMm(back.z - c.z, u))).toBeLessThanOrEqual(1e-3);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("two-point rotation recovers a known rotation", () => {
    fc.assert(
      fc.property(
        arbAngle,
        fc.record({ x: arbLocal, y: arbLocal }),
        fc.record({ x: fc.double({ min: 1000, max: 1e6, noNaN: true }), y: fc.double({ min: -1e6, max: 1e6, noNaN: true }) }),
        (angle, a, d) => {
          const p = computeProjectPosition({ civilBasePoint: { x: 1e6, y: 2e6, z: 0 }, drawingUnit: "meters", internalPoint_mm: { ...a, z: 0 }, angleToTrueNorth_deg: angle });
          const b = { x: a.x + d.x, y: a.y + d.y, z: 0 };
          const ca = internalToCivil(p, { ...a, z: 0 }, "meters");
          const cb = internalToCivil(p, b, "meters");
          const r = rotationFromTwoPoints(ca, cb, a, b, "meters");
          expect(Math.abs(angleDiffDeg(r.angleToTrueNorth_deg, angle))).toBeLessThanOrEqual(1e-6);
          expect(Math.abs(r.scaleRatio - 1)).toBeLessThanOrEqual(1e-9);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("normalizeAngleDeg stays in (-180, 180] and preserves direction", () => {
    fc.assert(
      fc.property(fc.double({ min: -1e5, max: 1e5, noNaN: true }), (a) => {
        const n = normalizeAngleDeg(a);
        expect(n).toBeGreaterThan(-180);
        expect(n).toBeLessThanOrEqual(180);
        const r1 = (a * Math.PI) / 180;
        const r2 = (n * Math.PI) / 180;
        expect(Math.cos(r1)).toBeCloseTo(Math.cos(r2), 6);
        expect(Math.sin(r1)).toBeCloseTo(Math.sin(r2), 6);
      }),
    );
  });

  it("compareProjectPositions of a position with itself is zero", () => {
    fc.assert(
      fc.property(arbPos, (p) => {
        const c = compareProjectPositions(p, anchorAtOrigin(p));
        expect(c.maxHorizontalDelta_mm).toBeLessThanOrEqual(1e-3);
        expect(c.maxVerticalDelta_mm).toBeLessThanOrEqual(1e-6);
        expect(Math.abs(c.rotationDelta_deg)).toBeLessThanOrEqual(1e-9);
      }),
      { numRuns: 200 },
    );
  });
});
