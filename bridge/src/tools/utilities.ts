import { z } from "zod";
import { collectPipes, getDrawingContext, type SitePipe } from "../core/civilData.js";
import { pointInPolygon, segmentPolygonDistance } from "../core/geometry.js";
import { tryGetProjectLocation } from "../core/revitData.js";
import { civilToSharedMm, distance2d, REVIT_MAX_DISTANCE_FROM_ORIGIN_MM, sharedToInternal, type Vec2, type Vec3 } from "../core/transform.js";
import { toMm, type LinearUnit } from "../core/units.js";
import {
  applySchema,
  BridgeRefusal,
  drawingUnitsSchema,
  errorInfo,
  dryRunRejected,
  lazyLocation,
  polygonSchema,
  round,
  roundVec,
  toCivilPolygon,
  type BridgeContext,
} from "./common.js";

export const TOOL = "bridge_utilities_to_revit";

const mappingRule = z.object({
  network: z
    .string()
    .optional()
    .describe("Civil 3D network name to match (case-insensitive). Wrap in slashes for a regex, e.g. '/^SS-/'. Omit to match any."),
  kind: z.enum(["gravity", "pressure"]).optional().describe("Match only gravity or pressure networks."),
  systemTypeName: z.string().min(1).describe("Revit piping system type name, e.g. 'Sanitary', 'Domestic Cold Water'."),
  pipeTypeName: z.string().optional().describe("Revit pipe type name. Default: plugin default."),
});

export const utilitiesSchema = {
  mode: z
    .enum(["report", "create"])
    .optional()
    .default("report")
    .describe("report (default) = read-only list of selected pipes and building connection points; create = create Revit pipes (preview/apply)."),
  include: z.enum(["gravity", "pressure", "both"]).optional().default("both").describe("Which Civil 3D network kinds to read."),
  networks: z.array(z.string()).optional().describe("Restrict to these Civil 3D network names."),
  boundary: polygonSchema.optional().describe("Select pipes that touch or lie inside this polygon."),
  footprint: polygonSchema.optional().describe("Building footprint. With distance, selects pipes within that plan distance; also used for connection points."),
  distance: z.number().nonnegative().optional().describe("Plan distance from the footprint in DRAWING units (requires footprint)."),
  levelName: z.string().optional().describe("Revit reference level for created pipes (required for mode=create)."),
  systemMapping: z.array(mappingRule).optional().describe("Ordered mapping rules Civil 3D network -> Revit system/pipe type. First match wins."),
  defaultSystemTypeName: z.string().optional().describe("Revit system type for pipes no rule matches."),
  defaultPipeTypeName: z.string().optional().describe("Revit pipe type for pipes whose rule has none."),
  diameterUnits: z
    .enum(["drawing", "inches", "millimeters"])
    .optional()
    .default("drawing")
    .describe("Unit of the Civil 3D pipe diameters. The Civil 3D API reports inner diameter in drawing units (default)."),
  maxPipes: z.number().int().positive().max(5000).optional().default(500).describe("Refuse if more pipes than this are selected."),
  drawingUnits: drawingUnitsSchema,
  ...applySchema,
};

const argsObject = z.object(utilitiesSchema);
export type UtilitiesArgs = z.input<typeof argsObject>;

type Rule = z.infer<typeof mappingRule>;

export function matchRule(rules: readonly Rule[] | undefined, pipe: Pick<SitePipe, "network" | "kind">): Rule | null {
  for (const r of rules ?? []) {
    if (r.kind && r.kind !== pipe.kind) continue;
    if (r.network) {
      const m = /^\/(.*)\/([a-z]*)$/.exec(r.network);
      if (m) {
        const flags = m[2].includes("i") ? m[2] : m[2] + "i";
        if (!new RegExp(m[1], flags).test(pipe.network)) continue;
      } else if (r.network.toLowerCase() !== pipe.network.toLowerCase()) continue;
    }
    return r;
  }
  return null;
}

function diameterToMm(d: number, diameterUnits: "drawing" | "inches" | "millimeters", unit: LinearUnit): number {
  if (diameterUnits === "inches") return toMm(d, "inches");
  if (diameterUnits === "millimeters") return d;
  return toMm(d, unit);
}

export async function runUtilities(ctx: BridgeContext, rawArgs: UtilitiesArgs) {
  const args = argsObject.parse(rawArgs);
  const warnings: string[] = [];
  const location = lazyLocation(ctx.revit);

  if (args.distance !== undefined && !args.footprint) throw new BridgeRefusal("distance requires footprint.");

  const drawing = await getDrawingContext(ctx.civil, args.drawingUnits);
  warnings.push(...drawing.warnings);
  const unit = drawing.units.unit;

  const boundary = args.boundary ? await toCivilPolygon(args.boundary, unit, location, "boundary") : undefined;
  const footprint = args.footprint ? await toCivilPolygon(args.footprint, unit, location, "footprint") : undefined;

  const { pipes, skipped, networks } = await collectPipes(ctx.civil, { include: args.include, networks: args.networks });

  const selected: Array<{ pipe: SitePipe; distanceToFootprint: number | null }> = [];
  for (const pipe of pipes) {
    const dFoot = footprint ? segmentPolygonDistance(pipe.start, pipe.end, footprint) : null;
    const inBoundary = boundary ? segmentPolygonDistance(pipe.start, pipe.end, boundary) === 0 : null;
    const nearFootprint = footprint && args.distance !== undefined ? dFoot! <= args.distance : null;
    let keep: boolean;
    if (inBoundary === null && nearFootprint === null) keep = true;
    else keep = inBoundary === true || nearFootprint === true;
    if (keep) selected.push({ pipe, distanceToFootprint: dFoot });
  }
  if (!boundary && !(footprint && args.distance !== undefined)) {
    warnings.push("No boundary or footprint+distance given: every pipe in the selected networks is included.");
  }
  if (args.diameterUnits === "drawing" && (unit === "feet" || unit === "usSurveyFeet")) {
    const big = selected.filter((s) => s.pipe.diameter > 8);
    if (big.length > 0) {
      warnings.push(`${big.length} pipes have diameter > 8 ${unit}; if these are inches, pass diameterUnits: 'inches'.`);
    }
  }

  const rows = selected.map(({ pipe, distanceToFootprint }) => {
    const d_mm = diameterToMm(pipe.diameter, args.diameterUnits, unit);
    const start_mm = civilToSharedMm(pipe.start, unit);
    const end_mm = civilToSharedMm(pipe.end, unit);
    // Connection point: the endpoint nearest the footprint (or inside it).
    let connection: Record<string, unknown> | null = null;
    if (footprint) {
      const ends: Array<{ which: "start" | "end"; p: Vec3; invert: number }> = [
        { which: "start", p: pipe.start, invert: pipe.startInvert },
        { which: "end", p: pipe.end, invert: pipe.endInvert },
      ];
      const scored = ends.map((e) => ({
        ...e,
        d: pointInPolygon(e.p, footprint) ? 0 : segmentPolygonDistance(e.p, e.p, footprint),
      }));
      scored.sort((a, b) => a.d - b.d);
      const c = scored[0];
      connection = {
        end: c.which,
        civil3d: { easting: c.p.x, northing: c.p.y },
        invertElevation: c.invert,
        centerlineElevation: c.p.z,
        shared_mm: roundVec(civilToSharedMm(c.p, unit), 3),
        invertElevation_shared_mm: round(toMm(c.invert, unit), 3),
        distanceToFootprint: c.d,
      };
    }
    return {
      network: pipe.network,
      kind: pipe.kind,
      name: pipe.name,
      handle: pipe.handle,
      material: pipe.material,
      diameter: pipe.diameter,
      diameter_mm: round(d_mm, 3),
      start: { easting: pipe.start.x, northing: pipe.start.y, centerline: pipe.start.z, invert: pipe.startInvert },
      end: { easting: pipe.end.x, northing: pipe.end.y, centerline: pipe.end.z, invert: pipe.endInvert },
      start_mm: roundVec(start_mm, 3),
      end_mm: roundVec(end_mm, 3),
      distanceToFootprint,
      geometrySource: pipe.geometrySource,
      connectionPoint: connection,
    };
  });

  const common = {
    civil3d: { drawing: drawing.drawingName, units: unit, unitsSource: drawing.units.source, networks },
    selection: {
      boundary: boundary ? boundary.length + " vertices" : null,
      footprint: footprint ? footprint.length + " vertices" : null,
      distance: args.distance ?? null,
      pipesRead: pipes.length,
      pipesSelected: rows.length,
    },
    skipped,
  };

  if (args.mode === "report") {
    return {
      mode: "report",
      wroteToRevit: false,
      wroteToCivil3d: false,
      ...common,
      pipes: rows,
      connectionPoints: footprint ? rows.map((r) => ({ network: r.network, pipe: r.name, ...r.connectionPoint })) : null,
      warnings,
    };
  }

  // ---- create ----
  if (!args.levelName) throw new BridgeRefusal("mode 'create' requires levelName.");
  if (rows.length > args.maxPipes) {
    throw new BridgeRefusal(`${rows.length} pipes selected, more than maxPipes (${args.maxPipes}). Narrow the selection or raise maxPipes.`);
  }

  const unmapped: string[] = [];
  const revitPipes: Array<Record<string, unknown>> = [];
  const mapping: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const rule = matchRule(args.systemMapping, r);
    const systemTypeName = rule?.systemTypeName ?? args.defaultSystemTypeName;
    const pipeTypeName = rule?.pipeTypeName ?? args.defaultPipeTypeName;
    if (!systemTypeName) {
      unmapped.push(`${r.network}/${r.name}`);
      continue;
    }
    if (r.diameter_mm <= 0) continue;
    mapping.push({ network: r.network, pipe: r.name, systemTypeName, pipeTypeName: pipeTypeName ?? null });
    revitPipes.push({
      start_mm: r.start_mm,
      end_mm: r.end_mm,
      diameter_mm: r.diameter_mm,
      systemTypeName,
      ...(pipeTypeName ? { pipeTypeName } : {}),
      levelName: args.levelName,
    });
  }
  if (unmapped.length > 0) {
    warnings.push(`${unmapped.length} pipes have no system mapping and will NOT be created: ${unmapped.slice(0, 20).join(", ")}${unmapped.length > 20 ? ", ..." : ""}. Add systemMapping rules or defaultSystemTypeName.`);
  }

  const blocking: string[] = [];
  if (revitPipes.length === 0) blocking.push("No pipes to create after selection and mapping.");

  const loc = await tryGetProjectLocation(ctx.revit);
  if (loc.location && revitPipes.length > 0) {
    let maxDist = 0;
    for (const p of revitPipes) {
      for (const e of [p.start_mm as Vec3, p.end_mm as Vec3]) {
        maxDist = Math.max(maxDist, distance2d(sharedToInternal(loc.location.position, e), { x: 0, y: 0 } as Vec2));
      }
    }
    if (maxDist > REVIT_MAX_DISTANCE_FROM_ORIGIN_MM) {
      blocking.push(`Pipes would land ${(maxDist / 1e6).toFixed(2)} km from Revit's internal origin; align shared coordinates first (bridge_align_coordinates).`);
    }
  } else if (loc.note) {
    warnings.push(`Could not check placement against Revit shared coordinates: ${loc.note}`);
  }

  // Validate system type names against Revit when possible (read-only).
  let mepSystems: unknown = null;
  try {
    mepSystems = await ctx.revit.call("get_mep_systems", {}, 30_000);
    const names = extractSystemTypeNames(mepSystems);
    if (names.size > 0) {
      const missing = [...new Set(revitPipes.map((p) => String(p.systemTypeName)))].filter((n) => !names.has(n.toLowerCase()));
      // Warning, not blocking: get_mep_systems' exact shape is not final, and
      // create_pipe's own dry run is the authoritative check.
      if (missing.length > 0) warnings.push(`get_mep_systems did not list system type(s): ${missing.join(", ")}. Check the Revit dry run result.`);
    }
  } catch (e) {
    warnings.push(`Could not validate system types with get_mep_systems: ${errorInfo(e).message}`);
  }

  const payload = { pipes: revitPipes, coordinateSystem: "shared" as const };
  const createCommon = { ...common, mapping, createPipe: { pipeCount: revitPipes.length, coordinateSystem: "shared", pipes: revitPipes.slice(0, 25) } };

  if (!args.apply) {
    let revitDryRun: unknown = null;
    if (blocking.length === 0) {
      try {
        revitDryRun = await ctx.revit.call("create_pipe", { ...payload, dryRun: true }, 120_000);
      } catch (e) {
        const info = errorInfo(e);
        revitDryRun = { unavailable: !dryRunRejected(info), ...info };
        if (dryRunRejected(info)) blocking.push(`Revit rejected the dry run: ${info.message}`);
        else warnings.push(`Revit dry run not performed: ${info.message}`);
      }
    }
    const rec = blocking.length === 0 ? ctx.previews.record(TOOL, rawArgs as Record<string, unknown>, payload) : null;
    return {
      mode: "create-preview",
      wroteToRevit: false,
      wroteToCivil3d: false,
      previewId: rec?.id ?? null,
      previewExpiresAt: rec ? new Date(rec.expiresAt).toISOString() : null,
      blocking,
      next: rec
        ? `Review, then call ${TOOL} again with the SAME arguments plus apply: true and previewId: "${rec.id}".`
        : "Resolve the blocking issues and preview again.",
      ...createCommon,
      revitDryRun,
      warnings,
    };
  }

  if (blocking.length > 0) throw new BridgeRefusal("Refusing to apply: " + blocking.join(" "), createCommon);
  const refusal = ctx.previews.check(TOOL, rawArgs as Record<string, unknown>, args.previewId, payload);
  if (refusal) throw new BridgeRefusal(refusal);
  const result = await ctx.revit.call("create_pipe", { ...payload, dryRun: false }, 300_000);
  ctx.previews.consume(args.previewId!);
  return { mode: "create-apply", wroteToRevit: true, wroteToCivil3d: false, revitResult: result, ...createCommon, warnings };
}

/** Pull piping system type names out of get_mep_systems, tolerating shape variations. */
export function extractSystemTypeNames(raw: unknown): Set<string> {
  const names = new Set<string>();
  const visit = (v: unknown, depth: number) => {
    if (depth > 4 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    for (const k of ["systemTypeName", "typeName", "name", "Name"]) {
      if (typeof o[k] === "string") names.add((o[k] as string).toLowerCase());
    }
    for (const k of ["pipingSystemTypes", "systemTypes", "pipingSystems", "systems", "piping", "types"]) {
      if (o[k] !== undefined) visit(o[k], depth + 1);
    }
  };
  visit(raw, 0);
  return names;
}
