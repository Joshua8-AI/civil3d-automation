import { z } from "zod";
import { getDrawingContext, getParcelBoundary, resolveCivilPoint, sampleSurface } from "../core/civilData.js";
import { densifyPerimeter, edges, polygonContainsPolygon, polygonSegmentDistance } from "../core/geometry.js";
import { getProjectInfo, type RevitLevel, type RevitProjectLocation } from "../core/revitData.js";
import { civilToSharedMm, distance2d, internalToShared, sharedMmToCivil, type Vec2 } from "../core/transform.js";
import { fromMm, type LinearUnit } from "../core/units.js";
import {
  civilPointSchema,
  drawingUnitsSchema,
  errorInfo,
  lazyLocation,
  polygonSchema,
  round,
  toCivilPointSpec,
  toCivilPolygon,
  vec3Schema,
  type BridgeContext,
} from "./common.js";

export const TOOL = "bridge_check_consistency";

export const consistencySchema = {
  footprint: polygonSchema.optional().describe("Building footprint, used by the ffe and setbacks checks."),
  ffe: z
    .object({
      surfaceName: z.string().min(1).describe("Civil 3D finished-grade surface."),
      levelName: z.string().optional().describe("Revit level holding the finished floor. Default: the level whose internal elevation is closest to 0."),
      minAboveGrade: z.number().describe("Minimum FFE above the HIGHEST adjacent grade, drawing units (e.g. 0.5 ft)."),
      maxAboveGrade: z.number().optional().describe("Optional maximum FFE above the LOWEST adjacent grade, drawing units."),
      sampleSpacing: z.number().positive().optional().describe("Spacing of grade samples along the footprint perimeter, drawing units. Default: perimeter/40."),
      pads: z
        .array(z.object({ name: z.string(), footprint: polygonSchema, levelName: z.string().optional() }))
        .optional()
        .describe("Several pads/footprints instead of the top-level footprint."),
    })
    .optional()
    .describe("Finished-floor elevation (Revit level) vs Civil 3D surface grade at the footprint."),
  setbacks: z
    .object({
      parcel: z.object({ siteName: z.string(), parcelName: z.string() }).optional().describe("Civil 3D parcel to read the boundary from."),
      parcelBoundary: polygonSchema.optional().describe("Explicit parcel boundary (use if the plugin cannot return parcel vertices)."),
      default: z.number().nonnegative().describe("Required setback for every parcel edge, drawing units."),
      perEdge: z
        .array(z.object({ edgeIndex: z.number().int().nonnegative(), distance: z.number().nonnegative(), label: z.string().optional() }))
        .optional()
        .describe("Overrides per parcel edge; edge i runs from vertex i to vertex i+1 of the boundary."),
    })
    .optional()
    .describe("Building footprint vs parcel setbacks."),
  alignment: z
    .object({
      civil3dPoint: civilPointSchema,
      revitReference: z
        .union([z.literal("surveyPoint"), z.object({ internalPoint_mm: vec3Schema })])
        .optional()
        .default("surveyPoint")
        .describe("'surveyPoint' = Revit survey point's shared coordinates; or {internalPoint_mm} = a Revit internal point pushed through the shared transform."),
      horizontalTolerance: z.number().positive().optional().describe("Drawing units. Default 0.01 ft / 0.003 m."),
      verticalTolerance: z.number().positive().optional().describe("Drawing units. Default 0.01 ft / 0.003 m."),
    })
    .optional()
    .describe("Coordinate alignment check (Revit vs Civil 3D point)."),
  drawingUnits: drawingUnitsSchema,
};

const argsObject = z.object(consistencySchema);
export type ConsistencyArgs = z.input<typeof argsObject>;

type Status = "pass" | "fail" | "skipped" | "error";

interface CheckResult {
  check: string;
  status: Status;
  summary: string;
  details?: unknown;
}

function defaultTolerance(unit: LinearUnit): number {
  return unit === "meters" ? 0.003 : unit === "millimeters" ? 3 : 0.01;
}

function pickLevel(levels: RevitLevel[], name?: string): RevitLevel {
  if (levels.length === 0) throw new Error("Revit reports no levels.");
  if (name) {
    const l = levels.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!l) throw new Error(`Revit has no level named '${name}'. Levels: ${levels.map((x) => x.name).join(", ")}`);
    return l;
  }
  return [...levels].sort((a, b) => Math.abs(a.elevation_mm) - Math.abs(b.elevation_mm))[0];
}

export async function runConsistency(ctx: BridgeContext, rawArgs: ConsistencyArgs) {
  const args = argsObject.parse(rawArgs);
  const warnings: string[] = [];
  const checks: CheckResult[] = [];
  const location = lazyLocation(ctx.revit);

  const drawing = await getDrawingContext(ctx.civil, args.drawingUnits);
  warnings.push(...drawing.warnings);
  const unit = drawing.units.unit;

  if (!args.ffe && !args.setbacks && !args.alignment) {
    return {
      overall: "skipped",
      readOnly: true,
      checks: [],
      warnings: ["No checks requested. Pass one or more of: ffe, setbacks, alignment."],
    };
  }

  // ---------------- FFE vs grade ----------------
  if (args.ffe) {
    const ffe = args.ffe;
    const pads = ffe.pads ?? (args.footprint ? [{ name: "building", footprint: args.footprint, levelName: ffe.levelName }] : []);
    if (pads.length === 0) {
      checks.push({ check: "ffe", status: "skipped", summary: "ffe needs footprint (top-level) or ffe.pads." });
    }
    let loc: RevitProjectLocation | null = null;
    let levels: RevitLevel[] | null = null;
    for (const pad of pads) {
      const label = `ffe:${pad.name}`;
      try {
        loc ??= await location();
        levels ??= (await getProjectInfo(ctx.revit)).levels;
        const level = pickLevel(levels, pad.levelName ?? ffe.levelName);
        // Level.Elevation is from the internal origin; rotation does not affect Z.
        const ffeShared_mm = internalToShared(loc.position, { x: 0, y: 0, z: level.elevation_mm }).z;
        const ffeCivil = fromMm(ffeShared_mm, unit);
        const poly = await toCivilPolygon(pad.footprint, unit, location, `${pad.name} footprint`);
        let perimeter = 0;
        for (const [a, b] of edges(poly)) perimeter += distance2d(a, b);
        const spacing = ffe.sampleSpacing ?? perimeter / 40;
        const pts = densifyPerimeter(poly, spacing);
        const sampled = await sampleSurface(ctx.civil, ffe.surfaceName, pts);
        if (sampled.samples.length === 0) {
          checks.push({ check: label, status: "error", summary: `Surface '${ffe.surfaceName}' has no elevations along the footprint (outside the surface?).` });
          continue;
        }
        const zs = sampled.samples.map((s) => s.z);
        const gradeMax = Math.max(...zs);
        const gradeMin = Math.min(...zs);
        const gradeMean = zs.reduce((a, b) => a + b, 0) / zs.length;
        const freeboardMin = ffeCivil - gradeMax;
        const freeboardMax = ffeCivil - gradeMin;
        const okMin = freeboardMin >= ffe.minAboveGrade - 1e-9;
        const okMax = ffe.maxAboveGrade === undefined || freeboardMax <= ffe.maxAboveGrade + 1e-9;
        checks.push({
          check: label,
          status: okMin && okMax ? "pass" : "fail",
          summary:
            `FFE ${round(ffeCivil, 3)} (${level.name}) vs grade ${round(gradeMin, 3)}..${round(gradeMax, 3)} ${unit}: ` +
            `${round(freeboardMin, 3)} above highest grade (min ${ffe.minAboveGrade})` +
            (ffe.maxAboveGrade !== undefined ? `, ${round(freeboardMax, 3)} above lowest grade (max ${ffe.maxAboveGrade})` : ""),
          details: {
            level: { name: level.name, internalElevation_mm: level.elevation_mm, sharedElevation_mm: ffeShared_mm },
            ffe: ffeCivil,
            grade: { min: gradeMin, max: gradeMax, mean: gradeMean, samples: sampled.samples.length, missing: sampled.missing.length, spacing },
            freeboardAboveHighestGrade: freeboardMin,
            heightAboveLowestGrade: freeboardMax,
            unit,
          },
        });
        if (sampled.missing.length > 0) warnings.push(`${label}: ${sampled.missing.length} perimeter samples were outside the surface.`);
      } catch (e) {
        checks.push({ check: label, status: "error", summary: errorInfo(e).message });
      }
    }
  }

  // ---------------- Setbacks ----------------
  if (args.setbacks) {
    const sb = args.setbacks;
    try {
      if (!args.footprint) throw new Error("setbacks needs the top-level footprint.");
      const foot = await toCivilPolygon(args.footprint, unit, location, "footprint");
      let parcel: Vec2[];
      let parcelSource: string;
      if (sb.parcelBoundary) {
        parcel = await toCivilPolygon(sb.parcelBoundary, unit, location, "parcelBoundary");
        parcelSource = "explicit parcelBoundary";
      } else if (sb.parcel) {
        const pb = await getParcelBoundary(ctx.civil, sb.parcel.siteName, sb.parcel.parcelName);
        parcel = pb.vertices;
        parcelSource = pb.source;
        warnings.push(...pb.notes);
      } else {
        throw new Error("setbacks needs parcel {siteName, parcelName} or parcelBoundary.");
      }
      const overrides = new Map((sb.perEdge ?? []).map((e) => [e.edgeIndex, e]));
      const edgeResults = edges(parcel).map(([a, b], i) => {
        const o = overrides.get(i);
        const required = o?.distance ?? sb.default;
        const actual = polygonSegmentDistance(foot, a, b);
        return { edgeIndex: i, label: o?.label ?? null, from: a, to: b, required, actual: round(actual, 4), pass: actual >= required - 1e-9 };
      });
      for (const idx of overrides.keys()) {
        if (idx >= edgeResults.length) warnings.push(`setbacks.perEdge edgeIndex ${idx} does not exist (parcel has ${edgeResults.length} edges).`);
      }
      const inside = polygonContainsPolygon(parcel, foot);
      const failures = edgeResults.filter((e) => !e.pass);
      checks.push({
        check: "setbacks",
        status: inside && failures.length === 0 ? "pass" : "fail",
        summary: !inside
          ? "Footprint is not entirely inside the parcel."
          : failures.length === 0
            ? `All ${edgeResults.length} parcel edges meet their setbacks.`
            : `${failures.length} of ${edgeResults.length} parcel edges violate setbacks (worst: edge ${failures.sort((a, b) => a.actual - a.required - (b.actual - b.required))[0].edgeIndex}).`,
        details: { parcelSource, footprintInsideParcel: inside, unit, edges: edgeResults },
      });
    } catch (e) {
      checks.push({ check: "setbacks", status: "error", summary: errorInfo(e).message });
    }
  }

  // ---------------- Coordinate alignment ----------------
  if (args.alignment) {
    const al = args.alignment;
    try {
      const civilPt = await resolveCivilPoint(ctx.civil, toCivilPointSpec(al.civil3dPoint));
      const loc = await location();
      let revitShared_mm;
      let refLabel: string;
      if (al.revitReference === "surveyPoint") {
        if (!loc.surveyPoint_mm) throw new Error("Revit did not report the survey point.");
        revitShared_mm = loc.surveyPoint_mm;
        refLabel = "Revit survey point";
      } else {
        revitShared_mm = internalToShared(loc.position, al.revitReference.internalPoint_mm);
        refLabel = "Revit internal point via shared transform";
      }
      const revitCivil = sharedMmToCivil(revitShared_mm, unit);
      const dh = distance2d(revitCivil, civilPt.point);
      const dv = Math.abs(revitCivil.z - civilPt.point.z);
      const hTol = al.horizontalTolerance ?? defaultTolerance(unit);
      const vTol = al.verticalTolerance ?? defaultTolerance(unit);
      checks.push({
        check: "alignment",
        status: dh <= hTol && dv <= vTol ? "pass" : "fail",
        summary: `${refLabel} is ${round(dh, 4)} ${unit} horizontally and ${round(dv, 4)} ${unit} vertically from ${civilPt.source} (tolerance ${hTol}/${vTol}).`,
        details: {
          civil3d: civilPt.point,
          revitInCivil3dUnits: revitCivil,
          revitShared_mm,
          civil3dAsShared_mm: civilToSharedMm(civilPt.point, unit),
          deltaEasting: revitCivil.x - civilPt.point.x,
          deltaNorthing: revitCivil.y - civilPt.point.y,
          deltaElevation: revitCivil.z - civilPt.point.z,
          unit,
        },
      });
    } catch (e) {
      checks.push({ check: "alignment", status: "error", summary: errorInfo(e).message });
    }
  }

  const anyFail = checks.some((c) => c.status === "fail");
  const anyIncomplete = checks.some((c) => c.status === "error" || c.status === "skipped");
  return {
    overall: anyFail ? "fail" : anyIncomplete ? "incomplete" : "pass",
    readOnly: true,
    civil3d: { drawing: drawing.drawingName, units: unit, unitsSource: drawing.units.source },
    checks,
    warnings,
  };
}
