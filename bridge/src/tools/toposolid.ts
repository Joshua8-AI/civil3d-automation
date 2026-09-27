import { z } from "zod";
import { PluginError } from "../clients/tcpRpc.js";
import { getDrawingContext, getSurfaceSummary, getSurfaceTinVertices, sampleSurface } from "../core/civilData.js";
import { bboxPolygon, decimate, isDegeneratePlan, planGrid, pointInPolygon, type BBox } from "../core/geometry.js";
import { tryGetProjectLocation } from "../core/revitData.js";
import { civilToSharedMm, distance2d, REVIT_MAX_DISTANCE_FROM_ORIGIN_MM, sharedToInternal, type Vec2, type Vec3 } from "../core/transform.js";
import {
  applySchema,
  BridgeRefusal,
  drawingUnitsSchema,
  errorInfo,
  dryRunRejected,
  lazyLocation,
  polygonSchema,
  round,
  toCivilPolygon,
  type BridgeContext,
} from "./common.js";

export const TOOL = "bridge_surface_to_toposolid";
export const MAX_TOPO_POINTS = 20_000;

export const toposolidSchema = {
  surfaceName: z.string().min(1).describe("Civil 3D surface name."),
  sampling: z
    .enum(["grid", "tin"])
    .optional()
    .default("grid")
    .describe("grid = regular grid sampled with sampleSurfaceElevations (works today). tin = actual TIN vertices (needs pending plugin command getSurfaceTinVertices)."),
  gridSpacing: z
    .number()
    .positive()
    .optional()
    .describe("Grid spacing in DRAWING units. Default: derived from the region area and maxPoints. Coarsened automatically if it would exceed maxPoints."),
  boundary: polygonSchema
    .optional()
    .describe("Optional region to sample (e.g. building footprint plus margin). Default: the surface bounding box."),
  maxPoints: z
    .number()
    .int()
    .min(4)
    .max(MAX_TOPO_POINTS)
    .optional()
    .default(2000)
    .describe(`Maximum points sent to Revit (4..${MAX_TOPO_POINTS}, default 2000). TIN vertices are decimated by plan grid binning to fit.`),
  toposolidTypeName: z.string().optional().describe("Revit toposolid type name. Default: the plugin's default type."),
  levelName: z.string().optional().describe("Revit level to host the toposolid. Default: the plugin's choice."),
  name: z.string().optional().describe("Name/comment for the new toposolid."),
  includePoints: z.boolean().optional().default(false).describe("Include every point in the response (large). Default false: a sample of 10."),
  drawingUnits: drawingUnitsSchema,
  ...applySchema,
};

const argsObject = z.object(toposolidSchema);
export type ToposolidArgs = z.input<typeof argsObject>;

/** Round shared-mm coordinates to 0.001 mm so previews hash stably. */
function roundMm(p: Vec3): Vec3 {
  return { x: round(p.x, 3), y: round(p.y, 3), z: round(p.z, 3) };
}

export async function runToposolid(ctx: BridgeContext, rawArgs: ToposolidArgs) {
  const args = argsObject.parse(rawArgs);
  const warnings: string[] = [];
  const location = lazyLocation(ctx.revit);

  const drawing = await getDrawingContext(ctx.civil, args.drawingUnits);
  warnings.push(...drawing.warnings);
  const unit = drawing.units.unit;
  const surface = await getSurfaceSummary(ctx.civil, args.surfaceName);

  // Region in drawing coordinates.
  let polygon: Vec2[] | undefined;
  let regionBox: BBox | undefined;
  if (args.boundary) {
    polygon = await toCivilPolygon(args.boundary, unit, location, "boundary");
  } else {
    if (!surface.bbox) throw new BridgeRefusal(`Surface '${args.surfaceName}' has no bounding box; pass a boundary.`);
    regionBox = surface.bbox;
  }

  let civilPoints: Vec3[];
  let samplingDetail: Record<string, unknown>;
  if (args.sampling === "grid") {
    const plan = planGrid({ polygon, bbox: regionBox }, args.maxPoints, args.gridSpacing);
    if (plan.coarsened && args.gridSpacing) {
      warnings.push(`gridSpacing ${args.gridSpacing} would exceed maxPoints; coarsened to ${plan.spacing.toFixed(4)} ${unit}.`);
    }
    const res = await sampleSurface(ctx.civil, args.surfaceName, plan.points);
    civilPoints = res.samples;
    samplingDetail = {
      method: "grid",
      spacing: plan.spacing,
      spacingUnit: unit,
      requested: plan.points.length,
      sampled: res.samples.length,
      outsideSurface: res.missing.length,
      civil3dRequests: res.requests,
    };
    if (res.missing.length > 0) warnings.push(`${res.missing.length} grid points fell outside the surface (or in holes) and were dropped.`);
  } else {
    let tin;
    try {
      tin = await getSurfaceTinVertices(ctx.civil, args.surfaceName, polygon ?? (regionBox ? bboxPolygon(regionBox) : undefined), MAX_TOPO_POINTS * 5);
    } catch (e) {
      if (e instanceof PluginError && e.isMethodNotFound) {
        throw new BridgeRefusal(
          "sampling 'tin' needs the Civil 3D plugin command getSurfaceTinVertices, which is not implemented yet (see README 'Pending plugin commands'). Use sampling: 'grid'.",
          errorInfo(e),
        );
      }
      throw e;
    }
    const inRegion = polygon ? tin.vertices.filter((v) => pointInPolygon(v, polygon!)) : tin.vertices;
    const dec = decimate(inRegion, args.maxPoints);
    civilPoints = dec.points;
    samplingDetail = {
      method: "tin",
      tinVerticesReturned: tin.vertices.length,
      tinVertexTotal: tin.totalVertexCount,
      truncatedByPlugin: tin.truncated,
      inRegion: inRegion.length,
      afterDecimation: dec.points.length,
      decimationCellSize: dec.cellSize,
    };
    if (dec.cellSize !== null) warnings.push(`TIN vertices decimated from ${inRegion.length} to ${dec.points.length} (cell ${dec.cellSize.toFixed(3)} ${unit}).`);
  }

  if (civilPoints.length < 3 || isDegeneratePlan(civilPoints)) {
    throw new BridgeRefusal(`Only ${civilPoints.length} usable, non-collinear surface points in the region; a toposolid needs at least 3.`, samplingDetail);
  }

  const points_mm = civilPoints.map((p) => roundMm(civilToSharedMm(p, unit)));

  // Revit-side sanity: how far from the internal origin will these land?
  const loc = await tryGetProjectLocation(ctx.revit);
  let placement: Record<string, unknown> | null = null;
  const blocking: string[] = [];
  if (loc.location) {
    let maxDist = 0;
    for (const p of points_mm) maxDist = Math.max(maxDist, distance2d(sharedToInternal(loc.location.position, p), { x: 0, y: 0 }));
    placement = {
      maxDistanceFromInternalOrigin_mm: maxDist,
      revitLimit_mm: REVIT_MAX_DISTANCE_FROM_ORIGIN_MM,
    };
    if (maxDist > REVIT_MAX_DISTANCE_FROM_ORIGIN_MM) {
      blocking.push(
        `Points would land ${(maxDist / 1e6).toFixed(2)} km from Revit's internal origin (limit ~32 km). Revit shared coordinates are probably not aligned to this Civil 3D drawing; run bridge_align_coordinates first.`,
      );
    }
  } else if (loc.note) {
    warnings.push(`Could not check placement against Revit shared coordinates: ${loc.note}`);
  }

  const zs = civilPoints.map((p) => p.z);
  const payload = {
    points_mm,
    coordinateSystem: "shared" as const,
    ...(args.toposolidTypeName ? { toposolidTypeName: args.toposolidTypeName } : {}),
    ...(args.levelName ? { levelName: args.levelName } : {}),
    ...(args.name ? { name: args.name } : {}),
  };

  const common = {
    civil3d: { drawing: drawing.drawingName, surface: surface.name, units: unit, unitsSource: drawing.units.source },
    sampling: samplingDetail,
    pointCount: points_mm.length,
    elevationRange: { min: Math.min(...zs), max: Math.max(...zs), unit },
    region: polygon ? { type: "boundary", vertices: polygon.length } : { type: "surfaceBoundingBox", bbox: regionBox },
    placement,
    createToposolid: {
      ...payload,
      points_mm: args.includePoints ? points_mm : points_mm.slice(0, 10),
      ...(args.includePoints ? {} : { pointsTruncatedInResponse: points_mm.length > 10 }),
    },
  };

  if (!args.apply) {
    let revitDryRun: unknown = null;
    if (blocking.length === 0) {
      try {
        revitDryRun = await ctx.revit.call("create_toposolid", { ...payload, dryRun: true }, 120_000);
      } catch (e) {
        const info = errorInfo(e);
        revitDryRun = { unavailable: !dryRunRejected(info), ...info };
        if (dryRunRejected(info)) blocking.push(`Revit rejected the dry run: ${info.message}`);
        else warnings.push(`Revit dry run not performed: ${info.message}`);
      }
    }
    const rec = blocking.length === 0 ? ctx.previews.record(TOOL, rawArgs as Record<string, unknown>, payload) : null;
    return {
      mode: "preview",
      wroteToRevit: false,
      wroteToCivil3d: false,
      previewId: rec?.id ?? null,
      previewExpiresAt: rec ? new Date(rec.expiresAt).toISOString() : null,
      blocking,
      next: rec
        ? `Review, then call ${TOOL} again with the SAME arguments plus apply: true and previewId: "${rec.id}".`
        : "Resolve the blocking issues and preview again.",
      ...common,
      revitDryRun,
      warnings,
    };
  }

  if (blocking.length > 0) throw new BridgeRefusal("Refusing to apply: " + blocking.join(" "), common);
  const refusal = ctx.previews.check(TOOL, rawArgs as Record<string, unknown>, args.previewId, payload);
  if (refusal) throw new BridgeRefusal(refusal);
  const result = await ctx.revit.call("create_toposolid", { ...payload, dryRun: false }, 300_000);
  ctx.previews.consume(args.previewId!);
  return { mode: "apply", wroteToRevit: true, wroteToCivil3d: false, revitResult: result, ...common, warnings };
}
