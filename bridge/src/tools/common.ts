import { z } from "zod";
import type { Civil3DApi } from "../clients/civil3d.js";
import type { RevitApi } from "../clients/revit.js";
import { PluginError } from "../clients/tcpRpc.js";
import type { PreviewStore } from "../core/previewStore.js";
import { getProjectLocation, type RevitProjectLocation } from "../core/revitData.js";
import { internalToShared, sharedMmToCivil, type Vec2, type Vec3 } from "../core/transform.js";
import { LINEAR_UNITS, type LinearUnit } from "../core/units.js";
import { validatePolygon } from "../core/geometry.js";

export interface BridgeContext {
  civil: Civil3DApi;
  revit: RevitApi;
  previews: PreviewStore;
}

// ---------------------------------------------------------------------------
// Shared zod schemas
// ---------------------------------------------------------------------------

export const drawingUnitsSchema = z
  .enum(LINEAR_UNITS as [LinearUnit, ...LinearUnit[]])
  .optional()
  .describe(
    "Override the Civil 3D drawing's linear unit. The plugin reports only 'feet'/'meters', so pass 'usSurveyFeet' for US-survey-foot drawings. Default: what Civil 3D reports (feet = international feet).",
  );

export const vec3Schema = z.object({ x: z.number(), y: z.number(), z: z.number() });
export const vec2Schema = z.object({ x: z.number(), y: z.number() });

export const civilPointSchema = z
  .union([
    z.object({ pointNumber: z.number().int().positive().describe("Civil 3D COGO point number") }).strict(),
    z.object({ pointName: z.string().min(1).describe("Civil 3D COGO point name") }).strict(),
    z
      .object({
        northing: z.number().describe("Northing (drawing Y), drawing units"),
        easting: z.number().describe("Easting (drawing X), drawing units"),
        elevation: z.number().describe("Elevation, drawing units"),
      })
      .strict(),
  ])
  .describe("A Civil 3D point: {pointNumber} | {pointName} | {northing, easting, elevation} in drawing units.");

export type CivilPointInput = z.infer<typeof civilPointSchema>;

export function toCivilPointSpec(p: CivilPointInput) {
  if ("pointNumber" in p) return { pointNumber: p.pointNumber };
  if ("pointName" in p) return { pointName: p.pointName };
  return { easting: p.easting, northing: p.northing, elevation: p.elevation };
}

export const polygonSchema = z
  .object({
    coordinateSystem: z
      .enum(["civil3d", "revitShared", "revitInternal"])
      .default("civil3d")
      .describe("civil3d = drawing coordinates in drawing units (x=easting, y=northing); revitShared / revitInternal = Revit millimetres."),
    points: z.array(vec2Schema).min(3).describe("Polygon vertices in order (closing vertex optional)."),
  })
  .describe("Plan polygon, e.g. a building footprint or sampling boundary.");

export type PolygonInput = z.infer<typeof polygonSchema>;

export const applySchema = {
  apply: z
    .boolean()
    .optional()
    .default(false)
    .describe("false (default) = preview only; nothing is written. true = perform the write; requires previewId from a preview with identical arguments."),
  previewId: z.string().optional().describe("previewId returned by the preview run. Required when apply is true."),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lazily fetch the Revit project location once per tool invocation. */
export function lazyLocation(revit: RevitApi): () => Promise<RevitProjectLocation> {
  let p: Promise<RevitProjectLocation> | null = null;
  return () => (p ??= getProjectLocation(revit));
}

/** Convert a polygon from any supported frame into Civil 3D drawing coordinates. */
export async function toCivilPolygon(
  poly: PolygonInput,
  unit: LinearUnit,
  location: () => Promise<RevitProjectLocation>,
  label: string,
): Promise<Vec2[]> {
  const pts = poly.points;
  let out: Vec2[];
  switch (poly.coordinateSystem) {
    case "civil3d":
      out = pts.map((p) => ({ x: p.x, y: p.y }));
      break;
    case "revitShared":
      out = pts.map((p) => sharedMmToCivil({ x: p.x, y: p.y, z: 0 }, unit));
      break;
    case "revitInternal": {
      const loc = await location();
      out = pts.map((p) => sharedMmToCivil(internalToShared(loc.position, { x: p.x, y: p.y, z: 0 }), unit));
      break;
    }
  }
  return validatePolygon(out.map((p) => ({ x: p.x, y: p.y })), label);
}

export function round(v: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function roundVec(v: Vec3, digits = 6): Vec3 {
  return { x: round(v.x, digits), y: round(v.y, digits), z: round(v.z, digits) };
}

export function errorInfo(e: unknown): { message: string; code?: string; app?: string; methodNotFound?: boolean } {
  if (e instanceof PluginError) return { message: e.message, code: e.code, app: e.app, methodNotFound: e.isMethodNotFound };
  return { message: e instanceof Error ? e.message : String(e) };
}

/**
 * True when Revit ran a dry run and rejected the change (as opposed to being
 * unreachable). A rejected dry run must block the apply: the same payload will fail.
 */
export function dryRunRejected(info: { code?: string }): boolean {
  return info.code === "REVIT.COMMAND_FAILED";
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function ok(result: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

export function fail(message: string, details?: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: message, ...(details !== undefined ? { details } : {}) }, null, 2) }],
    isError: true,
  };
}

/** Wrap a tool body so every thrown error becomes a structured MCP error result. */
export async function guard(body: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await body());
  } catch (e) {
    if (e instanceof BridgeRefusal) return fail(e.message, e.details);
    const info = errorInfo(e);
    const hint = info.methodNotFound
      ? " The plugin is reachable but does not implement this command; see README 'Plugin command dependencies'."
      : "";
    return fail(info.message + hint, info);
  }
}

export class BridgeRefusal extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = "BridgeRefusal";
  }
}
