import { z } from "zod";
import { getDrawingContext, resolveCivilPoint } from "../core/civilData.js";
import { getProjectLocation, tryGetProjectLocation } from "../core/revitData.js";
import {
  civilToSharedMm,
  compareProjectPositions,
  computeProjectPosition,
  describeRotation,
  distance3d,
  internalToShared,
  normalizeAngleDeg,
  ORIGIN,
  rotationFromTwoPoints,
  sharedMmToCivil,
  sharedToInternal,
  type ProjectPosition,
  type Vec3,
} from "../core/transform.js";
import {
  applySchema,
  BridgeRefusal,
  civilPointSchema,
  drawingUnitsSchema,
  errorInfo,
  dryRunRejected,
  roundVec,
  toCivilPointSpec,
  vec3Schema,
  type BridgeContext,
} from "./common.js";

export const TOOL = "bridge_align_coordinates";

export const alignSchema = {
  civil3dPoint: civilPointSchema.describe(
    "Civil 3D base point: {pointNumber} | {pointName} | {northing, easting, elevation} (drawing units).",
  ),
  revitInternalPoint_mm: vec3Schema
    .optional()
    .describe("Revit INTERNAL point (mm) that must coincide with the Civil 3D base point. Default: internal origin (0,0,0)."),
  rotation: z
    .discriminatedUnion("source", [
      z.object({
        source: z.literal("explicit"),
        angleToTrueNorth_deg: z
          .number()
          .describe("CCW rotation (deg) from Revit internal axes to Civil 3D grid axes (Revit ProjectPosition.Angle). Positive = Civil grid north is clockwise of project north."),
      }),
      z.object({
        source: z.literal("civil3dNorth").describe("Revit project north = Civil 3D drawing grid north (+Y). Angle 0."),
      }),
      z.object({
        source: z.literal("twoPoints"),
        civil3dPoint: civilPointSchema.describe("Second Civil 3D point"),
        revitInternalPoint_mm: vec3Schema.describe("Revit internal point (mm) corresponding to the second Civil 3D point"),
        maxScaleError: z
          .number()
          .positive()
          .optional()
          .default(0.001)
          .describe("Refuse if the two point pairs disagree in distance by more than this fraction (default 0.001 = 0.1%)."),
      }),
    ])
    .optional()
    .default({ source: "civil3dNorth" })
    .describe("Rotation source. Default civil3dNorth."),
  locationName: z.string().optional().describe("Optional Revit project location (site) name passed to set_shared_coordinates."),
  toleranceMm: z.number().positive().optional().default(1).describe("Verification tolerance in mm (default 1)."),
  drawingUnits: drawingUnitsSchema,
  ...applySchema,
};

const argsObject = z.object(alignSchema);
export type AlignArgs = z.input<typeof argsObject>;

function payloadFor(position: ProjectPosition, locationName?: string) {
  return {
    eastWest_mm: position.eastWest_mm,
    northSouth_mm: position.northSouth_mm,
    elevation_mm: position.elevation_mm,
    angleToTrueNorth_deg: position.angleToTrueNorth_deg,
    internalPoint_mm: position.internalPoint_mm,
    ...(locationName ? { locationName } : {}),
  };
}

export async function runAlign(ctx: BridgeContext, rawArgs: AlignArgs) {
  const args = argsObject.parse(rawArgs);
  const warnings: string[] = [];

  // 1. Civil 3D side (read-only).
  const drawing = await getDrawingContext(ctx.civil, args.drawingUnits);
  warnings.push(...drawing.warnings);
  const unit = drawing.units.unit;
  const base = await resolveCivilPoint(ctx.civil, toCivilPointSpec(args.civil3dPoint));
  const internalPoint = args.revitInternalPoint_mm ?? { ...ORIGIN };

  // 2. Rotation.
  let angle: number;
  let rotationDetail: Record<string, unknown>;
  const rot = args.rotation;
  if (rot.source === "explicit") {
    angle = normalizeAngleDeg(rot.angleToTrueNorth_deg);
    rotationDetail = { source: "explicit" };
  } else if (rot.source === "civil3dNorth") {
    angle = 0;
    rotationDetail = {
      source: "civil3dNorth",
      note: "Revit project north is aligned with Civil 3D grid north (+Y). Grid-to-true-north convergence is not applied: shared coordinates are the Civil 3D grid.",
    };
  } else {
    const second = await resolveCivilPoint(ctx.civil, toCivilPointSpec(rot.civil3dPoint));
    const r = rotationFromTwoPoints(base.point, second.point, internalPoint, rot.revitInternalPoint_mm, unit);
    angle = r.angleToTrueNorth_deg;
    const scaleError = Math.abs(r.scaleRatio - 1);
    rotationDetail = {
      source: "twoPoints",
      secondCivil3dPoint: { ...second.point, source: second.source },
      secondRevitInternalPoint_mm: rot.revitInternalPoint_mm,
      civilDistance_mm: r.civilDistance_mm,
      internalDistance_mm: r.internalDistance_mm,
      scaleRatio: r.scaleRatio,
    };
    if (scaleError > rot.maxScaleError) {
      throw new BridgeRefusal(
        `The two point pairs are ${(scaleError * 100).toFixed(3)}% different in length (limit ${(rot.maxScaleError * 100).toFixed(3)}%). ` +
          "They cannot be matched by a rigid move+rotate; check drawingUnits (feet vs US survey feet vs meters) and the chosen points.",
        rotationDetail,
      );
    }
  }

  // 3. Target project position.
  const target = computeProjectPosition({ civilBasePoint: base.point, drawingUnit: unit, internalPoint_mm: internalPoint, angleToTrueNorth_deg: angle });
  const payload = payloadFor(target, args.locationName);

  // 4. Pure round-trip verification of the computed transform.
  const probes: Vec3[] = [
    internalPoint,
    { x: internalPoint.x + 10_000, y: internalPoint.y + 25_000, z: internalPoint.z + 3_000 },
    { ...ORIGIN },
  ];
  const roundTrip = probes.map((p) => {
    const shared = internalToShared(target, p);
    const civil = sharedMmToCivil(shared, unit);
    const back = sharedToInternal(target, civilToSharedMm(civil, unit));
    return { internal_mm: p, civil3d: roundVec(civil, 6), shared_mm: roundVec(shared, 3), roundTripError_mm: distance3d(p, back) };
  });
  const baseLanding = sharedMmToCivil(internalToShared(target, internalPoint), unit);
  const baseError = distance3d(internalToShared(target, internalPoint), civilToSharedMm(base.point, unit));
  const computedVerification = {
    baseInternalPointLandsOn: roundVec(baseLanding, 6),
    expectedCivil3dPoint: base.point,
    baseError_mm: baseError,
    maxRoundTripError_mm: Math.max(...roundTrip.map((r) => r.roundTripError_mm)),
    probes: roundTrip,
    pass: baseError <= args.toleranceMm && roundTrip.every((r) => r.roundTripError_mm <= args.toleranceMm),
  };

  // 5. Revit "before" state (read-only).
  const before = await tryGetProjectLocation(ctx.revit);
  if (before.note) warnings.push(before.note);
  let movement: Record<string, unknown> | null = null;
  if (before.location) {
    const cmp = compareProjectPositions(target, before.location.position);
    movement = {
      note: "How far Revit's current shared coordinates are from the target (probe points pushed through both transforms).",
      maxHorizontal_mm: cmp.maxHorizontalDelta_mm,
      maxVertical_mm: cmp.maxVerticalDelta_mm,
      rotationChange_deg: -cmp.rotationDelta_deg,
      alreadyAligned: cmp.maxHorizontalDelta_mm <= args.toleranceMm && cmp.maxVerticalDelta_mm <= args.toleranceMm,
    };
  }

  const common = {
    civil3d: {
      drawing: drawing.drawingName,
      coordinateSystem: drawing.coordinateSystem,
      units: drawing.units.unit,
      unitsSource: drawing.units.source,
      basePoint: { ...base.point, source: base.source, number: base.number, name: base.name },
    },
    rotation: { angleToTrueNorth_deg: angle, description: describeRotation(angle), ...rotationDetail },
    setSharedCoordinates: payload,
    before: before.location
      ? {
          activeLocationName: before.location.activeLocationName,
          surveyPoint_mm: before.location.surveyPoint_mm,
          projectBasePoint: before.location.projectBasePoint,
          internalOriginInShared_mm: {
            x: before.location.position.eastWest_mm,
            y: before.location.position.northSouth_mm,
            z: before.location.position.elevation_mm,
          },
          angleToTrueNorth_deg: before.location.position.angleToTrueNorth_deg,
        }
      : null,
    movement,
    computedVerification,
  };

  if (!computedVerification.pass) {
    throw new BridgeRefusal("Internal round-trip verification failed; refusing to proceed.", common);
  }

  // ---- Preview ----
  if (!args.apply) {
    let revitDryRun: unknown = null;
    try {
      revitDryRun = await ctx.revit.call("set_shared_coordinates", { ...payload, dryRun: true }, 60_000);
    } catch (e) {
      const info = errorInfo(e);
      if (dryRunRejected(info)) throw new BridgeRefusal(`Revit rejected the dry run: ${info.message}`, common);
      revitDryRun = { unavailable: true, ...info };
      warnings.push(`Revit dry run not performed: ${info.message}`);
    }
    const rec = ctx.previews.record(TOOL, rawArgs as Record<string, unknown>, payload);
    return {
      mode: "preview",
      wroteToRevit: false,
      wroteToCivil3d: false,
      previewId: rec.id,
      previewExpiresAt: new Date(rec.expiresAt).toISOString(),
      next: `Review, then call ${TOOL} again with the SAME arguments plus apply: true and previewId: "${rec.id}".`,
      ...common,
      revitDryRun,
      warnings,
    };
  }

  // ---- Apply ----
  const refusal = ctx.previews.check(TOOL, rawArgs as Record<string, unknown>, args.previewId, payload);
  if (refusal) throw new BridgeRefusal(refusal);
  const result = await ctx.revit.call("set_shared_coordinates", { ...payload, dryRun: false }, 120_000);
  ctx.previews.consume(args.previewId!);

  // Verify by reading Revit back and pushing probes through its transform.
  let after: unknown = null;
  let verification: Record<string, unknown>;
  try {
    const loc = await getProjectLocation(ctx.revit);
    const cmp = compareProjectPositions(target, loc.position);
    const testInternal = { x: internalPoint.x + 10_000, y: internalPoint.y + 25_000, z: internalPoint.z + 3_000 };
    const revitShared = internalToShared(loc.position, testInternal);
    const revitCivil = sharedMmToCivil(revitShared, unit);
    const backInternal = sharedToInternal(loc.position, civilToSharedMm(revitCivil, unit));
    after = {
      activeLocationName: loc.activeLocationName,
      surveyPoint_mm: loc.surveyPoint_mm,
      projectBasePoint: loc.projectBasePoint,
      internalOriginInShared_mm: { x: loc.position.eastWest_mm, y: loc.position.northSouth_mm, z: loc.position.elevation_mm },
      angleToTrueNorth_deg: loc.position.angleToTrueNorth_deg,
    };
    const pass =
      cmp.maxHorizontalDelta_mm <= args.toleranceMm &&
      cmp.maxVerticalDelta_mm <= args.toleranceMm &&
      distance3d(backInternal, testInternal) <= args.toleranceMm;
    verification = {
      pass,
      toleranceMm: args.toleranceMm,
      maxHorizontalDelta_mm: cmp.maxHorizontalDelta_mm,
      maxVerticalDelta_mm: cmp.maxVerticalDelta_mm,
      rotationDelta_deg: cmp.rotationDelta_deg,
      testPoint: {
        internal_mm: testInternal,
        civil3dViaRevit: roundVec(revitCivil, 6),
        civil3dExpected: roundVec(sharedMmToCivil(internalToShared(target, testInternal), unit), 6),
        roundTripError_mm: distance3d(backInternal, testInternal),
      },
      ...(pass
        ? {}
        : {
            hint:
              Math.abs(Math.abs(cmp.rotationDelta_deg) - 2 * Math.abs(angle)) < 1e-6 && angle !== 0
                ? "Revit reports the opposite rotation sign: the plugin's angle convention differs from the bridge's (see README 'Rotation convention')."
                : "Revit's reported shared transform differs from the target.",
          }),
    };
  } catch (e) {
    verification = { pass: null, error: errorInfo(e).message, note: "Wrote to Revit but could not read back get_project_location to verify." };
  }

  return {
    mode: "apply",
    wroteToRevit: true,
    wroteToCivil3d: false,
    revitResult: result,
    ...common,
    after,
    verification,
    warnings,
  };
}
