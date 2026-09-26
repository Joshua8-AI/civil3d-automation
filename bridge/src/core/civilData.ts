/**
 * Read-side adapters over the Civil 3D plugin: resolve points, sample
 * surfaces, and normalise gravity/pressure pipes and parcels into plain
 * geometry in DRAWING units. Nothing here writes to Civil 3D.
 */

import type { Civil3DApi } from "../clients/civil3d.js";
import { PluginError } from "../clients/tcpRpc.js";
import { resolveDrawingUnits, type LinearUnit, type ResolvedDrawingUnits } from "./units.js";
import type { Vec2, Vec3 } from "./transform.js";

export interface DrawingContext {
  drawingName: string | null;
  filePath: string | null;
  coordinateSystem: {
    code: string | null;
    zone: string | null;
    datum: string | null;
    projection: string | null;
  };
  units: ResolvedDrawingUnits;
  warnings: string[];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Drawing identity, CRS and resolved linear units. */
export async function getDrawingContext(civil: Civil3DApi, drawingUnits?: LinearUnit): Promise<DrawingContext> {
  const info = await civil.call<Record<string, any>>("getDrawingInfo");
  const warnings: string[] = [];
  let cs: Record<string, any> = {};
  try {
    cs = await civil.call<Record<string, any>>("getCoordinateSystemInfo");
  } catch (e) {
    warnings.push(`getCoordinateSystemInfo failed: ${(e as Error).message}`);
  }
  const units = resolveDrawingUnits(str(info.linearUnits) ?? str(info.units) ?? str(cs.linearUnits), drawingUnits);
  const code = str(cs.name) ?? str(info.coordinateSystem);
  if (!code) {
    warnings.push("The Civil 3D drawing has no coordinate system assigned; drawing coordinates are treated as the shared (survey) frame as-is.");
  }
  return {
    drawingName: str(info.drawingName) ?? str(info.fileName),
    filePath: str(info.filePath),
    coordinateSystem: { code, zone: str(cs.zone), datum: str(cs.datum), projection: str(cs.projection) },
    units,
    warnings: [...warnings, ...units.warnings],
  };
}

export type CivilPointSpec =
  | { pointNumber: number }
  | { pointName: string }
  | { easting: number; northing: number; elevation: number };

export interface ResolvedCivilPoint {
  point: Vec3;
  source: string;
  number?: number;
  name?: string | null;
  description?: string | null;
}

function toPoint(raw: Record<string, any>, label: string): Vec3 {
  const x = num(raw.x);
  const y = num(raw.y);
  const z = num(raw.z);
  if (x === null || y === null || z === null) throw new Error(`${label} has no finite x/y/z`);
  return { x, y, z };
}

/** Resolve a point number, COGO point name, or explicit N/E/Z (drawing units). */
export async function resolveCivilPoint(civil: Civil3DApi, spec: CivilPointSpec): Promise<ResolvedCivilPoint> {
  if ("easting" in spec) {
    return { point: { x: spec.easting, y: spec.northing, z: spec.elevation }, source: "explicit northing/easting/elevation" };
  }
  if ("pointNumber" in spec) {
    const raw = await civil.call<Record<string, any>>("getCogoPoint", { pointNumber: spec.pointNumber });
    return {
      point: toPoint(raw, `COGO point ${spec.pointNumber}`),
      source: `COGO point number ${spec.pointNumber}`,
      number: num(raw.number) ?? spec.pointNumber,
      name: str(raw.name),
      description: str(raw.fullDescription) ?? str(raw.rawDescription),
    };
  }
  // By name: page through listCogoPoints (the plugin has no get-by-name).
  const wanted = spec.pointName.trim().toLowerCase();
  const pageSize = 5000;
  for (let offset = 0; offset < 1_000_000; offset += pageSize) {
    const page = await civil.call<Record<string, any>>("listCogoPoints", { limit: pageSize, offset });
    const points: Array<Record<string, any>> = Array.isArray(page.points) ? page.points : [];
    const hit = points.find((p) => typeof p.name === "string" && p.name.trim().toLowerCase() === wanted);
    if (hit) {
      return {
        point: toPoint(hit, `COGO point '${spec.pointName}'`),
        source: `COGO point name '${spec.pointName}'`,
        number: num(hit.number) ?? undefined,
        name: str(hit.name),
        description: str(hit.fullDescription) ?? str(hit.rawDescription),
      };
    }
    const total = num(page.totalCount) ?? 0;
    if (points.length < pageSize || offset + pageSize >= total) break;
  }
  throw new PluginError(`civil3d: no COGO point named '${spec.pointName}'`, "civil3d", "CIVIL3D.OBJECT_NOT_FOUND", -32004, "listCogoPoints");
}

export interface SurfaceSummary {
  name: string;
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null;
  minElevation: number | null;
  maxElevation: number | null;
  numberOfPoints: number | null;
}

export async function getSurfaceSummary(civil: Civil3DApi, name: string): Promise<SurfaceSummary> {
  const s = await civil.call<Record<string, any>>("getSurface", { name });
  const bb = s.boundingBox ?? null;
  const stats = s.statistics ?? {};
  return {
    name: str(s.name) ?? name,
    bbox:
      bb && [bb.minX, bb.minY, bb.maxX, bb.maxY].every((v) => typeof v === "number")
        ? { minX: bb.minX, minY: bb.minY, maxX: bb.maxX, maxY: bb.maxY }
        : null,
    minElevation: num(stats.minimumElevation),
    maxElevation: num(stats.maximumElevation),
    numberOfPoints: num(stats.numberOfPoints),
  };
}

/** Max points per sampleSurfaceElevations request (plugin caps requests at 1 MiB). */
export const SAMPLE_CHUNK = 4000;

export interface SampleResult {
  samples: Vec3[];
  /** Requested points the surface could not answer (outside surface / holes). */
  missing: Vec2[];
  requests: number;
}

/**
 * Sample surface elevations at plan points via sampleSurfaceElevations
 * (method "points"), chunked. The plugin silently drops points it cannot
 * evaluate, so results are matched back by exact coordinates.
 */
export async function sampleSurface(civil: Civil3DApi, surfaceName: string, points: readonly Vec2[]): Promise<SampleResult> {
  const samples: Vec3[] = [];
  const missing: Vec2[] = [];
  let requests = 0;
  for (let i = 0; i < points.length; i += SAMPLE_CHUNK) {
    const chunk = points.slice(i, i + SAMPLE_CHUNK);
    const res = await civil.call<Record<string, any>>("sampleSurfaceElevations", {
      name: surfaceName,
      method: "points",
      points: chunk.map((p) => ({ x: p.x, y: p.y })),
    });
    requests++;
    const got = new Map<string, number>();
    for (const s of Array.isArray(res.samples) ? res.samples : []) {
      if (typeof s?.x === "number" && typeof s?.y === "number" && typeof s?.elevation === "number" && Number.isFinite(s.elevation)) {
        got.set(`${s.x}|${s.y}`, s.elevation);
      }
    }
    for (const p of chunk) {
      const z = got.get(`${p.x}|${p.y}`);
      if (z === undefined) missing.push(p);
      else samples.push({ x: p.x, y: p.y, z });
    }
  }
  return { samples, missing, requests };
}

/**
 * PENDING plugin command. Proposed contract:
 *   getSurfaceTinVertices { name, boundary?: [{x,y}], maxPoints?: number }
 *     -> { surfaceName, vertices: [{x,y,z}], totalVertexCount, truncated, units }
 */
export async function getSurfaceTinVertices(
  civil: Civil3DApi,
  name: string,
  boundary: readonly Vec2[] | undefined,
  maxPoints: number,
): Promise<{ vertices: Vec3[]; totalVertexCount: number | null; truncated: boolean }> {
  const res = await civil.call<Record<string, any>>("getSurfaceTinVertices", {
    name,
    ...(boundary ? { boundary: boundary.map((p) => ({ x: p.x, y: p.y })) } : {}),
    maxPoints,
  });
  const vertices: Vec3[] = (Array.isArray(res.vertices) ? res.vertices : [])
    .filter((v: any) => [v?.x, v?.y, v?.z].every((n) => typeof n === "number" && Number.isFinite(n)))
    .map((v: any) => ({ x: v.x, y: v.y, z: v.z }));
  return { vertices, totalVertexCount: num(res.totalVertexCount), truncated: res.truncated === true };
}

export type PipeKind = "gravity" | "pressure";

/** A Civil 3D pipe normalised to centreline endpoints in drawing units. */
export interface SitePipe {
  network: string;
  kind: PipeKind;
  name: string;
  handle: string | null;
  start: Vec3;
  end: Vec3;
  /** Inner diameter in drawing units (Civil 3D API reports drawing units). */
  diameter: number;
  startInvert: number;
  endInvert: number;
  material: string | null;
  /** How the endpoints were derived, for traceability. */
  geometrySource: string;
}

export interface SkippedPipe {
  network: string;
  kind: PipeKind;
  name: string;
  reason: string;
}

function point3(v: any): Vec3 | null {
  if (v && [v.x, v.y, v.z].every((n: unknown) => typeof n === "number" && Number.isFinite(n))) return { x: v.x, y: v.y, z: v.z };
  return null;
}

/**
 * Normalise one gravity pipe from getPipeNetwork. The current plugin returns
 * centreline start/end elevations and start/end structure names but no pipe
 * XY, so plan position comes from the connected structures' insertion points.
 * If a future plugin adds startPoint/endPoint (and/or startInvert/endInvert),
 * those are preferred automatically.
 */
export function normaliseGravityPipe(
  network: string,
  pipe: Record<string, any>,
  structures: Map<string, Vec2>,
): SitePipe | SkippedPipe {
  const name = str(pipe.name) ?? "(unnamed)";
  const diameter = num(pipe.diameter) ?? num(pipe.innerDiameter);
  if (diameter === null || diameter <= 0) return { network, kind: "gravity", name, reason: "pipe has no positive diameter" };
  const r = diameter / 2;

  let start = point3(pipe.startPoint);
  let end = point3(pipe.endPoint);
  let source = "pipe startPoint/endPoint";

  if (!start || !end) {
    const s = str(pipe.startStructure) ? structures.get(pipe.startStructure) : undefined;
    const e = str(pipe.endStructure) ? structures.get(pipe.endStructure) : undefined;
    if (!s || !e) {
      return {
        network,
        kind: "gravity",
        name,
        reason:
          "no plan geometry: the plugin's getPipeNetwork does not return pipe XY and the pipe is not connected to structures at both ends " +
          "(needs pending plugin change: startPoint/endPoint on pipe data)",
      };
    }
    const invS = num(pipe.startInvert);
    const invE = num(pipe.endInvert);
    const clS = num(pipe.centerlineStartElevation) ?? (invS !== null ? invS + r : null);
    const clE = num(pipe.centerlineEndElevation) ?? (invE !== null ? invE + r : null);
    if (clS === null || clE === null) return { network, kind: "gravity", name, reason: "pipe has no centreline or invert elevations" };
    start = { x: s.x, y: s.y, z: clS };
    end = { x: e.x, y: e.y, z: clE };
    source = num(pipe.centerlineStartElevation) !== null ? "structure XY + pipe centreline elevations" : "structure XY + inverts + diameter/2";
  }

  const startInvert = num(pipe.startInvert) ?? start.z - r;
  const endInvert = num(pipe.endInvert) ?? end.z - r;
  return {
    network,
    kind: "gravity",
    name,
    handle: str(pipe.handle),
    start,
    end,
    diameter,
    startInvert,
    endInvert,
    material: str(pipe.material),
    geometrySource: source,
  };
}

export function normalisePressurePipe(network: string, pipe: Record<string, any>): SitePipe | SkippedPipe {
  const name = str(pipe.name) ?? "(unnamed)";
  const diameter = num(pipe.diameter);
  if (diameter === null || diameter <= 0) return { network, kind: "pressure", name, reason: "pipe has no positive diameter" };
  const start = point3(pipe.startPoint);
  const end = point3(pipe.endPoint);
  if (!start || !end) return { network, kind: "pressure", name, reason: "pipe has no startPoint/endPoint" };
  const r = diameter / 2;
  return {
    network,
    kind: "pressure",
    name,
    handle: str(pipe.handle),
    start,
    end,
    diameter,
    startInvert: start.z - r,
    endInvert: end.z - r,
    material: str(pipe.material),
    geometrySource: "pressure pipe startPoint/endPoint (centreline)",
  };
}

export interface PipeQuery {
  include: "gravity" | "pressure" | "both";
  /** Restrict to these network names (case-insensitive). Omit for all. */
  networks?: string[];
}

export async function collectPipes(civil: Civil3DApi, q: PipeQuery): Promise<{ pipes: SitePipe[]; skipped: SkippedPipe[]; networks: Array<{ name: string; kind: PipeKind }> }> {
  const wanted = q.networks?.map((n) => n.toLowerCase());
  const keep = (n: string) => !wanted || wanted.includes(n.toLowerCase());
  const pipes: SitePipe[] = [];
  const skipped: SkippedPipe[] = [];
  const networks: Array<{ name: string; kind: PipeKind }> = [];

  if (q.include !== "pressure") {
    const list = await civil.call<Record<string, any>>("listPipeNetworks");
    for (const n of Array.isArray(list.networks) ? list.networks : []) {
      const name = str(n?.name);
      if (!name || !keep(name)) continue;
      networks.push({ name, kind: "gravity" });
      const detail = await civil.call<Record<string, any>>("getPipeNetwork", { name });
      const structures = new Map<string, Vec2>();
      for (const s of Array.isArray(detail.structures) ? detail.structures : []) {
        if (str(s?.name) && typeof s.x === "number" && typeof s.y === "number") structures.set(s.name, { x: s.x, y: s.y });
      }
      for (const p of Array.isArray(detail.pipes) ? detail.pipes : []) {
        const r = normaliseGravityPipe(name, p, structures);
        if ("reason" in r) skipped.push(r);
        else pipes.push(r);
      }
    }
  }

  if (q.include !== "gravity") {
    const list = await civil.call<Record<string, any>>("listPressureNetworks");
    for (const n of Array.isArray(list.networks) ? list.networks : []) {
      const name = str(n?.name);
      if (!name || !keep(name)) continue;
      networks.push({ name, kind: "pressure" });
      const detail = await civil.call<Record<string, any>>("getPressureNetworkInfo", { name });
      for (const p of Array.isArray(detail.pipes) ? detail.pipes : []) {
        const r = normalisePressurePipe(name, p);
        if ("reason" in r) skipped.push(r);
        else pipes.push(r);
      }
    }
  }

  if (wanted) {
    const found = new Set(networks.map((n) => n.name.toLowerCase()));
    for (const w of q.networks!) {
      if (!found.has(w.toLowerCase())) skipped.push({ network: w, kind: "gravity", name: "*", reason: "network not found in the drawing" });
    }
  }
  return { pipes, skipped, networks };
}

/**
 * Parcel boundary in drawing units. Tries the PENDING getParcelGeometry
 * command first, then the existing reportParcels(includeCoordinates), whose
 * vertex extraction is reflection-based and may return no vertices on some
 * Civil 3D versions.
 *
 * Proposed contract:
 *   getParcelGeometry { siteName, parcelName } -> { name, vertices:[{x,y}], closed:true, units }
 */
export async function getParcelBoundary(
  civil: Civil3DApi,
  siteName: string,
  parcelName: string,
): Promise<{ vertices: Vec2[]; source: string; notes: string[] }> {
  const notes: string[] = [];
  try {
    const g = await civil.call<Record<string, any>>("getParcelGeometry", { siteName, parcelName });
    const v = (Array.isArray(g.vertices) ? g.vertices : []).filter((p: any) => typeof p?.x === "number" && typeof p?.y === "number");
    if (v.length >= 3) return { vertices: v.map((p: any) => ({ x: p.x, y: p.y })), source: "getParcelGeometry", notes };
    notes.push("getParcelGeometry returned fewer than 3 vertices");
  } catch (e) {
    if (!(e instanceof PluginError && e.isMethodNotFound)) throw e;
    notes.push("getParcelGeometry is not implemented by the Civil 3D plugin (pending); fell back to reportParcels.");
  }
  const rep = await civil.call<Record<string, any>>("reportParcels", { siteName, parcelNames: [parcelName], includeCoordinates: true });
  const row = (Array.isArray(rep.parcels) ? rep.parcels : []).find(
    (p: any) => typeof p?.name === "string" && p.name.toLowerCase() === parcelName.toLowerCase(),
  );
  if (!row) throw new PluginError(`civil3d: parcel '${parcelName}' not found in site '${siteName}'`, "civil3d", "CIVIL3D.OBJECT_NOT_FOUND", -32004, "reportParcels");
  const v = (Array.isArray(row.vertices) ? row.vertices : []).filter((p: any) => typeof p?.x === "number" && typeof p?.y === "number");
  // reportParcels writes (0,0) for vertices it cannot read; treat all-zero as unavailable.
  const real = v.filter((p: any) => !(p.x === 0 && p.y === 0));
  if (real.length < 3) {
    throw new PluginError(
      `civil3d: parcel '${parcelName}' boundary vertices are not available from this plugin build (reportParcels returned ${v.length}). ` +
        "Pass parcelBoundary explicitly, or add the pending getParcelGeometry command.",
      "civil3d",
      "BRIDGE.UNSUPPORTED",
      null,
      "reportParcels",
    );
  }
  return { vertices: real.map((p: any) => ({ x: p.x, y: p.y })), source: "reportParcels(includeCoordinates)", notes };
}
