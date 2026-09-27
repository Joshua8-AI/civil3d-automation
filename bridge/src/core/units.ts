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
 * Map the Civil 3D plugin's `getDrawingUnits.lengthUnit` (an AutoCAD
 * UnitsValue name such as "Feet", "USSurveyFeet" or "Meters") to a bridge
 * unit. Returns null for units the bridge does not convert.
 */
export function linearUnitFromLengthUnit(lengthUnit: string | null | undefined): LinearUnit | null {
  switch (lengthUnit) {
    case "Feet":
      return "feet";
    case "USSurveyFeet":
      return "usSurveyFeet";
    case "Meters":
      return "meters";
    case "Millimeters":
      return "millimeters";
    case "Inches":
      return "inches";
    default:
      return null;
  }
}

/**
 * Resolve the drawing's linear unit from the plugin's getDrawingUnits report.
 * Unlike the legacy `linearUnits` field, `lengthUnit` distinguishes US survey
 * feet from international feet, so no ambiguity warning is added; the
 * plugin's own warnings (e.g. INSUNITS disagreeing with the Civil 3D drawing
 * settings) are passed through.
 */
export function resolveDrawingUnitsFromReport(
  report: { lengthUnit: string | null; warnings?: readonly string[] },
  override?: LinearUnit,
): ResolvedDrawingUnits {
  const warnings = [...(report.warnings ?? [])];
  const mapped = linearUnitFromLengthUnit(report.lengthUnit);
  if (override) {
    if (mapped && mapped !== override) {
      warnings.push(`Civil 3D reports '${report.lengthUnit}' (getDrawingUnits) but drawingUnits override '${override}' was used.`);
    }
    return { unit: override, source: "override", reported: report.lengthUnit, warnings };
  }
  if (!mapped) {
    throw new Error(
      `Civil 3D drawing length unit is '${report.lengthUnit ?? "unknown"}', which the bridge cannot convert safely. ` +
        "Pass drawingUnits explicitly ('feet', 'usSurveyFeet' or 'meters').",
    );
  }
  return { unit: mapped, source: "civil3d", reported: report.lengthUnit, warnings };
}

/**
 * Resolve the Civil 3D drawing's linear unit (legacy path, used when the
 * plugin has no getDrawingUnits command).
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
