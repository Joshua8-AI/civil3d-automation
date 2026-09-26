/**
 * Linear unit handling. Every value that crosses the bridge is converted
 * explicitly; nothing is ever assumed to already be in millimetres.
 *
 * Revit's wire unit (for the RevitMCPSDK commands this bridge calls) is the
 * millimetre. Civil 3D drawings are usually in international feet, US survey
 * feet or metres.
 */

export type LinearUnit = "meters" | "feet" | "usSurveyFeet" | "millimeters" | "inches";

/** Exact millimetres per unit. US survey foot = 1200/3937 m (exact by definition). */
export const MM_PER_UNIT: Readonly<Record<LinearUnit, number>> = Object.freeze({
  meters: 1000,
  feet: 304.8,
  usSurveyFeet: 1_200_000 / 3937,
  millimeters: 1,
  inches: 25.4,
});

export const LINEAR_UNITS = Object.keys(MM_PER_UNIT) as LinearUnit[];

export function isLinearUnit(value: unknown): value is LinearUnit {
  return typeof value === "string" && (LINEAR_UNITS as string[]).includes(value);
}

export function toMm(value: number, unit: LinearUnit): number {
  return value * MM_PER_UNIT[unit];
}

export function fromMm(valueMm: number, unit: LinearUnit): number {
  return valueMm / MM_PER_UNIT[unit];
}

export function convert(value: number, from: LinearUnit, to: LinearUnit): number {
  if (from === to) return value;
  return (value * MM_PER_UNIT[from]) / MM_PER_UNIT[to];
}

export interface ResolvedDrawingUnits {
  unit: LinearUnit;
  /** Where the unit came from: an explicit override, or the plugin's report. */
  source: "override" | "civil3d";
  /** What the Civil 3D plugin reported (e.g. "feet", "meters", "other"). */
  reported: string | null;
  warnings: string[];
}

/**
 * Resolve the Civil 3D drawing's linear unit.
 *
 * The Civil 3D plugin's `linearUnits` field collapses international feet and
 * US survey feet into "feet" (see CivilObjectUtils.LinearUnits). The two
 * differ by 2 ppm, which is ~0.6 m at a 1,000 km state-plane false easting, so
 * the ambiguity is surfaced as a warning and callers may override it.
 */
export function resolveDrawingUnits(
  reported: string | null | undefined,
  override?: LinearUnit,
): ResolvedDrawingUnits {
  const warnings: string[] = [];
  const reportedNorm = typeof reported === "string" ? reported.trim().toLowerCase() : null;

  if (override) {
    if (reportedNorm === "meters" && override !== "meters" && override !== "millimeters") {
      warnings.push(`Civil 3D reports '${reported}' but drawingUnits override '${override}' was used.`);
    }
    if (reportedNorm === "feet" && override === "meters") {
      warnings.push(`Civil 3D reports '${reported}' but drawingUnits override 'meters' was used.`);
    }
    return { unit: override, source: "override", reported: reported ?? null, warnings };
  }

  switch (reportedNorm) {
    case "meters":
    case "metres":
    case "m":
      return { unit: "meters", source: "civil3d", reported: reported ?? null, warnings };
    case "feet":
    case "foot":
    case "ft":
      warnings.push(
        "Civil 3D reports 'feet' without distinguishing international feet from US survey feet; " +
          "assuming international feet (0.3048 m, which is what Revit uses when it links a DWG in feet). " +
          "Pass drawingUnits: 'usSurveyFeet' if the drawing's INSUNITS is US Survey Feet.",
      );
      return { unit: "feet", source: "civil3d", reported: reported ?? null, warnings };
    case "us survey feet":
    case "ussurveyfeet":
    case "survey feet":
      return { unit: "usSurveyFeet", source: "civil3d", reported: reported ?? null, warnings };
    case "millimeters":
    case "millimetres":
    case "mm":
      return { unit: "millimeters", source: "civil3d", reported: reported ?? null, warnings };
    default:
      throw new Error(
        `Civil 3D drawing linear units are '${reported ?? "unknown"}', which the bridge cannot convert safely. ` +
          "Pass drawingUnits explicitly ('feet', 'usSurveyFeet' or 'meters').",
      );
  }
}
