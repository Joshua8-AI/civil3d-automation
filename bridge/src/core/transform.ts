/**
 * Pure coordinate transforms between the three frames the bridge deals with:
 *
 *   1. Civil 3D drawing coordinates (x = easting, y = northing, z = elevation),
 *      in the drawing's linear unit.
 *   2. Revit SHARED coordinates in millimetres (east/west, north/south,
 *      elevation). The bridge defines Revit shared coordinates to be the
 *      Civil 3D drawing coordinates expressed in millimetres, so frame 1 <-> 2
 *      is a pure unit scale with no rotation or offset.
 *   3. Revit INTERNAL coordinates in millimetres.
 *
 * Revit shared <-> internal is a rigid transform described by a project
 * position (Revit ProjectLocation.SetProjectPosition semantics):
 *
 *   shared = T + Rz(theta) * (internal - P)
 *
 * where P is the internal point the position is anchored at (usually the
 * internal origin), T = (eastWest, northSouth, elevation) is P's shared
 * position, and theta = angleToTrueNorth_deg, a counter-clockwise rotation
 * about +Z (the convention of Revit's ProjectPosition.Angle as used with
 * Transform.CreateRotation(XYZ.BasisZ, angle)). With theta > 0 the shared
 * (Civil 3D grid) north lies theta degrees clockwise of Revit project north.
 *
 * All functions here are side-effect free and unit-tested with round-trip
 * property tests and known-answer tests.
 */

import { fromMm, toMm, type LinearUnit } from "./units.js";

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 extends Vec2 {
  z: number;
}

/** A Revit project position anchored at an internal point (all mm / degrees). */
export interface ProjectPosition {
  eastWest_mm: number;
  northSouth_mm: number;
  elevation_mm: number;
  angleToTrueNorth_deg: number;
  internalPoint_mm: Vec3;
}

/** The internal->shared transform as reported by Revit's get_project_location. */
export interface SharedTransform {
  origin_mm: Vec3;
  rotation_deg: number;
}

export const ORIGIN: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 0 });

const DEG = Math.PI / 180;

export function degToRad(deg: number): number {
  return deg * DEG;
}

export function radToDeg(rad: number): number {
  return rad / DEG;
}

/** Normalise an angle to the half-open interval (-180, 180]. */
export function normalizeAngleDeg(deg: number): number {
  if (!Number.isFinite(deg)) throw new Error(`Angle must be finite, got ${deg}`);
  let a = deg % 360;
  if (a <= -180) a += 360;
  if (a > 180) a -= 360;
  // Avoid returning -0.
  return a === 0 ? 0 : a;
}

/** Smallest signed difference a - b in degrees, in (-180, 180]. */
export function angleDiffDeg(a: number, b: number): number {
  return normalizeAngleDeg(a - b);
}

function rotate2d(x: number, y: number, deg: number): Vec2 {
  const r = degToRad(deg);
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: c * x - s * y, y: s * x + c * y };
}

/** Revit internal (mm) -> Revit shared (mm). */
export function internalToShared(position: ProjectPosition, internal: Vec3): Vec3 {
  const P = position.internalPoint_mm;
  const d = rotate2d(internal.x - P.x, internal.y - P.y, position.angleToTrueNorth_deg);
  return {
    x: position.eastWest_mm + d.x,
    y: position.northSouth_mm + d.y,
    z: position.elevation_mm + (internal.z - P.z),
  };
}

/** Revit shared (mm) -> Revit internal (mm). Exact inverse of internalToShared. */
export function sharedToInternal(position: ProjectPosition, shared: Vec3): Vec3 {
  const P = position.internalPoint_mm;
  const d = rotate2d(shared.x - position.eastWest_mm, shared.y - position.northSouth_mm, -position.angleToTrueNorth_deg);
  return {
    x: P.x + d.x,
    y: P.y + d.y,
    z: P.z + (shared.z - position.elevation_mm),
  };
}

/**
 * Re-anchor a project position at the internal origin. Two positions describe
 * the same transform iff their origin-anchored forms are equal.
 */
export function anchorAtOrigin(position: ProjectPosition): ProjectPosition {
  const s = internalToShared(position, ORIGIN);
  return {
    eastWest_mm: s.x,
    northSouth_mm: s.y,
    elevation_mm: s.z,
    angleToTrueNorth_deg: normalizeAngleDeg(position.angleToTrueNorth_deg),
    internalPoint_mm: { ...ORIGIN },
  };
}

export function toSharedTransform(position: ProjectPosition): SharedTransform {
  const o = anchorAtOrigin(position);
  return {
    origin_mm: { x: o.eastWest_mm, y: o.northSouth_mm, z: o.elevation_mm },
    rotation_deg: o.angleToTrueNorth_deg,
  };
}

export function fromSharedTransform(t: SharedTransform): ProjectPosition {
  return {
    eastWest_mm: t.origin_mm.x,
    northSouth_mm: t.origin_mm.y,
    elevation_mm: t.origin_mm.z,
    angleToTrueNorth_deg: t.rotation_deg,
    internalPoint_mm: { ...ORIGIN },
  };
}

/** Civil 3D drawing coordinates (drawing units) -> Revit shared (mm). */
export function civilToSharedMm(p: Vec3, unit: LinearUnit): Vec3 {
  return { x: toMm(p.x, unit), y: toMm(p.y, unit), z: toMm(p.z, unit) };
}

/** Revit shared (mm) -> Civil 3D drawing coordinates (drawing units). */
export function sharedMmToCivil(p: Vec3, unit: LinearUnit): Vec3 {
  return { x: fromMm(p.x, unit), y: fromMm(p.y, unit), z: fromMm(p.z, unit) };
}

export function civilToInternal(position: ProjectPosition, p: Vec3, unit: LinearUnit): Vec3 {
  return sharedToInternal(position, civilToSharedMm(p, unit));
}

export function internalToCivil(position: ProjectPosition, p: Vec3, unit: LinearUnit): Vec3 {
  return sharedMmToCivil(internalToShared(position, p), unit);
}

/** Math-convention direction angle (CCW from +X) of the vector a->b, degrees. */
export function directionDeg(a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) throw new Error("Cannot take the direction of a zero-length vector (points coincide).");
  return radToDeg(Math.atan2(dy, dx));
}

/** Surveying azimuth: clockwise from north (+Y), degrees in [0, 360). */
export function azimuthDeg(a: Vec2, b: Vec2): number {
  const az = 90 - directionDeg(a, b);
  const n = ((az % 360) + 360) % 360;
  return n === 360 ? 0 : n;
}

export function distance2d(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function distance3d(a: Vec3, b: Vec3): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

export interface AlignmentInput {
  /** Base point in Civil 3D drawing coordinates (drawing units). */
  civilBasePoint: Vec3;
  drawingUnit: LinearUnit;
  /** The Revit internal point (mm) that must land on civilBasePoint. */
  internalPoint_mm: Vec3;
  /** CCW rotation (deg) from Revit internal axes to Civil 3D grid axes. */
  angleToTrueNorth_deg: number;
}

/**
 * Compute the project position that makes internalPoint_mm coincide with the
 * Civil 3D base point, i.e. the exact parameters for Revit
 * set_shared_coordinates.
 */
export function computeProjectPosition(input: AlignmentInput): ProjectPosition {
  const s = civilToSharedMm(input.civilBasePoint, input.drawingUnit);
  return {
    eastWest_mm: s.x,
    northSouth_mm: s.y,
    elevation_mm: s.z,
    angleToTrueNorth_deg: normalizeAngleDeg(input.angleToTrueNorth_deg),
    internalPoint_mm: { ...input.internalPoint_mm },
  };
}

export interface TwoPointRotation {
  angleToTrueNorth_deg: number;
  /** Civil distance (converted to mm) / Revit internal distance. 1.0 means consistent. */
  scaleRatio: number;
  civilDistance_mm: number;
  internalDistance_mm: number;
}

/**
 * Derive the rotation from two corresponding point pairs: (civilA <-> internalA)
 * and (civilB <-> internalB). Also reports the scale ratio, which should be
 * ~1.0; anything else means the pairs do not describe a rigid transform
 * (usually a units mistake).
 */
export function rotationFromTwoPoints(
  civilA: Vec2,
  civilB: Vec2,
  internalA: Vec2,
  internalB: Vec2,
  drawingUnit: LinearUnit,
): TwoPointRotation {
  const civilDistance_mm = toMm(distance2d(civilA, civilB), drawingUnit);
  const internalDistance_mm = distance2d(internalA, internalB);
  if (internalDistance_mm === 0 || civilDistance_mm === 0) {
    throw new Error("Two-point rotation needs two distinct points in both Civil 3D and Revit.");
  }
  const angle = angleDiffDeg(directionDeg(civilA, civilB), directionDeg(internalA, internalB));
  return {
    angleToTrueNorth_deg: angle,
    scaleRatio: civilDistance_mm / internalDistance_mm,
    civilDistance_mm,
    internalDistance_mm,
  };
}

export interface TransformComparison {
  /** Horizontal distance between the two transforms' images of each probe (mm). */
  maxHorizontalDelta_mm: number;
  maxVerticalDelta_mm: number;
  rotationDelta_deg: number;
  probes: Array<{ internal_mm: Vec3; expected_mm: Vec3; actual_mm: Vec3; delta_mm: number }>;
}

/**
 * Compare two project positions by pushing probe points through both. Used
 * to verify that what Revit reports after set_shared_coordinates matches what
 * the bridge computed.
 */
export function compareProjectPositions(
  expected: ProjectPosition,
  actual: ProjectPosition,
  probes: Vec3[] = [
    { ...ORIGIN },
    expected.internalPoint_mm,
    { x: expected.internalPoint_mm.x + 100_000, y: expected.internalPoint_mm.y, z: expected.internalPoint_mm.z },
    { x: expected.internalPoint_mm.x, y: expected.internalPoint_mm.y + 100_000, z: expected.internalPoint_mm.z + 3_000 },
  ],
): TransformComparison {
  let maxH = 0;
  let maxV = 0;
  const out: TransformComparison["probes"] = [];
  for (const p of probes) {
    const e = internalToShared(expected, p);
    const a = internalToShared(actual, p);
    const h = distance2d(e, a);
    const v = Math.abs(e.z - a.z);
    maxH = Math.max(maxH, h);
    maxV = Math.max(maxV, v);
    out.push({ internal_mm: p, expected_mm: e, actual_mm: a, delta_mm: Math.hypot(h, v) });
  }
  return {
    maxHorizontalDelta_mm: maxH,
    maxVerticalDelta_mm: maxV,
    rotationDelta_deg: angleDiffDeg(actual.angleToTrueNorth_deg, expected.angleToTrueNorth_deg),
    probes: out,
  };
}

/**
 * Revit geometry must stay within ~20 miles (32 km) of the internal origin;
 * beyond that Revit warns and graphics/precision degrade.
 */
export const REVIT_MAX_DISTANCE_FROM_ORIGIN_MM = 32_186_880; // 20 statute miles

export function describeRotation(angleToTrueNorth_deg: number): string {
  const a = normalizeAngleDeg(angleToTrueNorth_deg);
  if (a === 0) return "Civil 3D grid north coincides with Revit project north.";
  const dir = a > 0 ? "clockwise (east)" : "counter-clockwise (west)";
  return `Civil 3D grid north lies ${Math.abs(a).toFixed(6)} deg ${dir} of Revit project north.`;
}
