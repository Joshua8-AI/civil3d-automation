import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  convert,
  fromMm,
  LINEAR_UNITS,
  linearUnitFromLengthUnit,
  MM_PER_UNIT,
  resolveDrawingUnits,
  resolveDrawingUnitsFromReport,
  toMm,
} from "../src/core/units.js";

describe("units: known answers", () => {
  it("international foot is exactly 304.8 mm", () => {
    expect(toMm(1, "feet")).toBe(304.8);
  });
  it("US survey foot is 1200/3937 m", () => {
    expect(toMm(1, "usSurveyFeet")).toBeCloseTo(304.8006096012192, 12);
    expect(toMm(3937, "usSurveyFeet")).toBeCloseTo(1_200_000, 6);
  });
  it("meters and inches", () => {
    expect(toMm(2.5, "meters")).toBe(2500);
    expect(toMm(12, "inches")).toBeCloseTo(304.8, 12);
  });
  it("the survey/international difference at a state-plane easting is material", () => {
    const e = 6_000_000; // ft
    const diff = toMm(e, "usSurveyFeet") - toMm(e, "feet");
    expect(diff).toBeCloseTo(3657.6073, 3); // ~3.66 m
  });
  it("convert between units", () => {
    expect(convert(1, "meters", "feet")).toBeCloseTo(3.280839895, 9);
    expect(convert(5, "feet", "feet")).toBe(5);
  });
});

describe("units: properties", () => {
  it("toMm/fromMm round trip for every unit", () => {
    fc.assert(
      fc.property(fc.constantFrom(...LINEAR_UNITS), fc.double({ min: -1e8, max: 1e8, noNaN: true }), (u, v) => {
        const back = fromMm(toMm(v, u), u);
        expect(Math.abs(back - v)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(v)));
      }),
    );
  });
  it("convert is consistent with mm factors", () => {
    fc.assert(
      fc.property(fc.constantFrom(...LINEAR_UNITS), fc.constantFrom(...LINEAR_UNITS), fc.double({ min: -1e6, max: 1e6, noNaN: true }), (a, b, v) => {
        expect(convert(v, a, b) * MM_PER_UNIT[b]).toBeCloseTo(v * MM_PER_UNIT[a], 3);
      }),
    );
  });
});

describe("resolveDrawingUnits", () => {
  it("maps plugin 'feet' to international feet with an ambiguity warning", () => {
    const r = resolveDrawingUnits("feet");
    expect(r.unit).toBe("feet");
    expect(r.source).toBe("civil3d");
    expect(r.warnings.join(" ")).toMatch(/US survey feet/);
  });
  it("maps meters without warnings", () => {
    const r = resolveDrawingUnits("meters");
    expect(r.unit).toBe("meters");
    expect(r.warnings).toHaveLength(0);
  });
  it("honours an override", () => {
    const r = resolveDrawingUnits("feet", "usSurveyFeet");
    expect(r.unit).toBe("usSurveyFeet");
    expect(r.source).toBe("override");
  });
  it("warns when an override contradicts the plugin", () => {
    expect(resolveDrawingUnits("meters", "feet").warnings.length).toBe(1);
  });
  it("refuses unknown units rather than guessing", () => {
    expect(() => resolveDrawingUnits("other")).toThrow(/cannot convert safely/);
    expect(() => resolveDrawingUnits(null)).toThrow();
  });
});

describe("resolveDrawingUnitsFromReport (plugin getDrawingUnits.lengthUnit)", () => {
  it("maps the AutoCAD UnitsValue names the plugin reports", () => {
    expect(linearUnitFromLengthUnit("Feet")).toBe("feet");
    expect(linearUnitFromLengthUnit("USSurveyFeet")).toBe("usSurveyFeet");
    expect(linearUnitFromLengthUnit("Meters")).toBe("meters");
    expect(linearUnitFromLengthUnit("Millimeters")).toBe("millimeters");
    expect(linearUnitFromLengthUnit("Inches")).toBe("inches");
    expect(linearUnitFromLengthUnit("Centimeters")).toBeNull();
    expect(linearUnitFromLengthUnit(null)).toBeNull();
  });
  it("US survey feet and international feet resolve without the ambiguity warning", () => {
    expect(resolveDrawingUnitsFromReport({ lengthUnit: "USSurveyFeet" })).toEqual({ unit: "usSurveyFeet", source: "civil3d", reported: "USSurveyFeet", warnings: [] });
    expect(resolveDrawingUnitsFromReport({ lengthUnit: "Feet" })).toEqual({ unit: "feet", source: "civil3d", reported: "Feet", warnings: [] });
  });
  it("passes the plugin's warnings through", () => {
    expect(resolveDrawingUnitsFromReport({ lengthUnit: "Feet", warnings: ["INSUNITS vs Civil 3D"] }).warnings).toEqual(["INSUNITS vs Civil 3D"]);
  });
  it("honours an override and warns when it contradicts the plugin", () => {
    const r = resolveDrawingUnitsFromReport({ lengthUnit: "Feet" }, "usSurveyFeet");
    expect(r).toMatchObject({ unit: "usSurveyFeet", source: "override", reported: "Feet" });
    expect(r.warnings).toHaveLength(1);
    expect(resolveDrawingUnitsFromReport({ lengthUnit: "USSurveyFeet" }, "usSurveyFeet").warnings).toHaveLength(0);
  });
  it("refuses units it cannot convert unless overridden", () => {
    expect(() => resolveDrawingUnitsFromReport({ lengthUnit: "Centimeters" })).toThrow(/cannot convert safely/);
    expect(() => resolveDrawingUnitsFromReport({ lengthUnit: null })).toThrow();
    expect(resolveDrawingUnitsFromReport({ lengthUnit: null }, "meters").unit).toBe("meters");
  });
});
