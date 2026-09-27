import { describe, expect, it } from "vitest";
import { PreviewStore } from "../src/core/previewStore.js";
import { computeProjectPosition } from "../src/core/transform.js";
import { runConsistency } from "../src/tools/consistency.js";
import { runStatus } from "../src/tools/status.js";
import { defaultCivilData, FakeCivil, FakeRevit, type FakeCivilData } from "./helpers/fakes.js";

const E = 6_000_000;
const N = 2_000_000;

function setup(levelElevation_mm = 304.8, civilInit: Partial<FakeCivilData> = {}) {
  const civil = new FakeCivil(civilInit);
  const revit = new FakeRevit({
    position: computeProjectPosition({ civilBasePoint: { x: E, y: N, z: 100 }, drawingUnit: "feet", internalPoint_mm: { x: 0, y: 0, z: 0 }, angleToTrueNorth_deg: 0 }),
    surveyPoint_mm: { x: E * 304.8, y: N * 304.8, z: 100 * 304.8 },
    levels: [
      { id: 1, name: "Level 1", elevation: levelElevation_mm },
      { id: 2, name: "Level 2", elevation: 4000 },
    ],
  });
  return { civil, revit, ctx: { civil, revit, previews: new PreviewStore() } };
}

const footprint = {
  coordinateSystem: "civil3d" as const,
  points: [
    { x: E, y: N },
    { x: E + 50, y: N },
    { x: E + 50, y: N + 50 },
    { x: E, y: N + 50 },
  ],
};

describe("bridge_check_consistency", () => {
  it("FFE passes when the floor is high enough above the highest adjacent grade", async () => {
    // FFE = 100 ft + 1 ft = 101; grade 100..100.5 => 0.5 ft above highest grade.
    const { ctx, revit } = setup();
    const r: any = await runConsistency(ctx, { footprint, ffe: { surfaceName: "FG", minAboveGrade: 0.4, maxAboveGrade: 1.5 } });
    const c = r.checks.find((x: any) => x.check === "ffe:building");
    expect(c.status).toBe("pass");
    expect(c.details.ffe).toBeCloseTo(101, 9);
    expect(c.details.grade.max).toBeCloseTo(100.5, 9);
    expect(c.details.freeboardAboveHighestGrade).toBeCloseTo(0.5, 9);
    expect(r.overall).toBe("pass");
    expect(r.readOnly).toBe(true);
    expect(revit.writes()).toHaveLength(0);
  });

  it("FFE fails with too little freeboard, and on too much height", async () => {
    const { ctx } = setup();
    const low: any = await runConsistency(ctx, { footprint, ffe: { surfaceName: "FG", minAboveGrade: 0.6 } });
    expect(low.overall).toBe("fail");
    const high: any = await runConsistency(ctx, { footprint, ffe: { surfaceName: "FG", minAboveGrade: 0, maxAboveGrade: 0.5 } });
    expect(high.checks[0].status).toBe("fail");
  });

  it("FFE supports several pads with their own levels", async () => {
    const { ctx } = setup();
    const r: any = await runConsistency(ctx, {
      ffe: {
        surfaceName: "FG",
        minAboveGrade: 0.4,
        pads: [
          { name: "A", footprint },
          { name: "B", footprint, levelName: "Level 2" },
        ],
      },
    });
    expect(r.checks.map((c: any) => c.check)).toEqual(["ffe:A", "ffe:B"]);
    expect(r.checks[1].details.level.name).toBe("Level 2");
  });

  it("setbacks from the Civil 3D parcel (reportParcels vertices)", async () => {
    const { ctx } = setup();
    const ok: any = await runConsistency(ctx, { footprint, setbacks: { parcel: { siteName: "Site 1", parcelName: "Lot 1" }, default: 25 } });
    const c = ok.checks[0];
    expect(c.status).toBe("pass");
    expect(c.details.parcelSource).toBe("reportParcels(includeCoordinates)");
    expect(c.details.edges.map((e: any) => e.actual)).toEqual([50, 100, 100, 50]);
    expect(ok.warnings.join(" ")).toMatch(/getParcelGeometry is not implemented/);

    const bad: any = await runConsistency(ctx, {
      footprint,
      setbacks: { parcel: { siteName: "Site 1", parcelName: "Lot 1" }, default: 25, perEdge: [{ edgeIndex: 0, distance: 60, label: "front" }] },
    });
    expect(bad.checks[0].status).toBe("fail");
    expect(bad.checks[0].details.edges[0]).toMatchObject({ label: "front", pass: false });
  });

  it("setbacks: footprint outside the parcel fails; explicit boundary works", async () => {
    const { ctx } = setup();
    const r: any = await runConsistency(ctx, {
      footprint,
      setbacks: {
        parcelBoundary: { coordinateSystem: "civil3d", points: [{ x: E + 10, y: N + 10 }, { x: E + 20, y: N + 10 }, { x: E + 20, y: N + 20 }] },
        default: 0,
      },
    });
    expect(r.checks[0].status).toBe("fail");
    expect(r.checks[0].summary).toMatch(/not entirely inside/);
  });

  it("setbacks: plugin without parcel vertices yields an error check, not a crash", async () => {
    const { ctx, civil } = setup();
    civil.handlers.reportParcels = () => ({ parcels: [{ name: "Lot 1", vertices: [] }] });
    const r: any = await runConsistency(ctx, { footprint, setbacks: { parcel: { siteName: "S", parcelName: "Lot 1" }, default: 5 } });
    expect(r.checks[0].status).toBe("error");
    expect(r.checks[0].summary).toMatch(/parcelBoundary/);
    expect(r.overall).toBe("incomplete");
  });

  it("alignment: survey point vs COGO point", async () => {
    const { ctx, revit } = setup();
    const ok: any = await runConsistency(ctx, { alignment: { civil3dPoint: { pointNumber: 1 } } });
    expect(ok.checks[0].status).toBe("pass");
    revit.state.surveyPoint_mm = { x: E * 304.8 + 100, y: N * 304.8, z: 100 * 304.8 };
    const bad: any = await runConsistency(ctx, { alignment: { civil3dPoint: { pointNumber: 1 } } });
    expect(bad.checks[0].status).toBe("fail");
    expect(bad.checks[0].details.deltaEasting).toBeCloseTo(100 / 304.8, 9);
  });

  it("alignment: internal point via shared transform", async () => {
    const { ctx } = setup();
    const r: any = await runConsistency(ctx, {
      alignment: { civil3dPoint: { pointNumber: 3 }, revitReference: { internalPoint_mm: { x: 30_480, y: 0, z: 609.6 } } },
    });
    expect(r.checks[0].status).toBe("pass");
  });

  it("Revit unreachable: checks report errors and overall is incomplete", async () => {
    const { ctx, revit } = setup();
    revit.reachable = false;
    const r: any = await runConsistency(ctx, { footprint, ffe: { surfaceName: "FG", minAboveGrade: 0.4 }, alignment: { civil3dPoint: { pointNumber: 1 } } });
    expect(r.overall).toBe("incomplete");
    expect(r.checks.every((c: any) => c.status === "error")).toBe(true);
  });

  it("no checks requested", async () => {
    const { ctx } = setup();
    const r: any = await runConsistency(ctx, {});
    expect(r.overall).toBe("skipped");
  });
});

describe("bridge_status", () => {
  it("reports both apps, units, CRS, location and pending command availability", async () => {
    const { ctx } = setup();
    const r: any = await runStatus(ctx, {});
    expect(r.ok).toBe(true);
    expect(r.civil3d.units).toMatchObject({ unit: "feet", source: "civil3d", reported: "feet" });
    expect(r.civil3d.coordinateSystem.code).toBe("CA83-VIF");
    expect(r.civil3d.pendingCommands).toEqual({ getSurfaceTinVertices: "missing", getParcelGeometry: "missing", getDrawingUnits: "missing" });
    expect(r.revit.endpoint).toBe("127.0.0.1:8081");
    expect(r.revit.levels).toHaveLength(2);
    expect(r.revit.projectLocation.internalOriginInCivil3D.x).toBeCloseTo(E, 6);
    expect(r.revit.pendingCommands.get_project_location).toBe("available");
    expect(r.revit.pendingCommands.get_toposolids).toBe("available");
  });

  it("reports unreachable apps without throwing", async () => {
    const { ctx, civil, revit } = setup();
    civil.reachable = false;
    revit.reachable = false;
    const r: any = await runStatus(ctx, { probeCommands: false });
    expect(r.ok).toBe(false);
    expect(r.civil3d.reachable).toBe(false);
    expect(r.revit.reachable).toBe(false);
    expect(r.summary).toMatch(/NOT reachable/);
  });

  it("reports Revit without the pending location command", async () => {
    const { ctx, revit } = setup();
    revit.implementsPending = false;
    const r: any = await runStatus(ctx, {});
    expect(r.revit.reachable).toBe(true);
    expect(r.revit.projectLocationNote).toMatch(/pending/);
    expect(r.revit.pendingCommands.get_project_location).toBe("missing");
    expect(r.revit.pendingCommands.get_mep_systems).toBe("missing");
  });
});

// Shapes from Civil3D-mcp feature/bridge-support-commands.
const usSurveyFeetReport = {
  insunits: 21,
  insunitsName: "USSurveyFeet",
  lengthUnit: "USSurveyFeet",
  lengthUnitSource: "INSUNITS",
  isUsSurveyFoot: true,
  metersPerUnit: 1200 / 3937,
  mmPerUnit: 1_200_000 / 3937,
  linearUnits: "feet",
  civilLinearUnit: "Feet",
  civilImperialToMetricConversion: "UsSurveyFoot",
  civilLengthUnit: "USSurveyFeet",
  unitsConsistent: true,
  warnings: [],
};

describe("plugin bridge-support commands", () => {
  it("getDrawingUnits resolves US survey feet with no ambiguity warning, and the probes find the commands", async () => {
    const { ctx } = setup(304.8, { drawingUnits: usSurveyFeetReport, parcelGeometry: true, surface: { ...defaultCivilData().surface, tin: [{ x: E, y: N, z: 100 }] } });
    const r: any = await runStatus(ctx, {});
    expect(r.civil3d.units).toMatchObject({ unit: "usSurveyFeet", source: "civil3d", reported: "USSurveyFeet" });
    expect(r.civil3d.warnings.join(" ")).not.toMatch(/without distinguishing/);
    expect(r.civil3d.pendingCommands).toEqual({ getSurfaceTinVertices: "available", getParcelGeometry: "available", getDrawingUnits: "available" });
  });

  it("getDrawingUnits 'Feet' is international feet without the legacy ambiguity warning; plugin warnings pass through", async () => {
    const warning = "INSUNITS is Feet but the Civil 3D drawing settings use the US survey foot for imperial-to-metric conversion.";
    const { ctx } = setup(304.8, {
      drawingUnits: { ...usSurveyFeetReport, insunits: 2, insunitsName: "Feet", lengthUnit: "Feet", isUsSurveyFoot: false, unitsConsistent: false, warnings: [warning] },
    });
    const r: any = await runStatus(ctx, { probeCommands: false });
    expect(r.civil3d.units).toMatchObject({ unit: "feet", source: "civil3d", reported: "Feet" });
    expect(r.civil3d.warnings).toContain(warning);
    expect(r.civil3d.warnings.join(" ")).not.toMatch(/without distinguishing/);
  });

  it("an explicit drawingUnits override still wins over getDrawingUnits, with a warning", async () => {
    const { ctx } = setup(304.8, { drawingUnits: usSurveyFeetReport });
    const r: any = await runStatus(ctx, { drawingUnits: "feet", probeCommands: false });
    expect(r.civil3d.units).toMatchObject({ unit: "feet", source: "override", reported: "USSurveyFeet" });
    expect(r.civil3d.warnings.join(" ")).toMatch(/override 'feet' was used/);
  });

  it("setbacks use getParcelGeometry when the plugin has it", async () => {
    const { ctx, civil } = setup(304.8, { parcelGeometry: true });
    const r: any = await runConsistency(ctx, { footprint, setbacks: { parcel: { siteName: "Site 1", parcelName: "Lot 1" }, default: 25 } });
    expect(r.checks[0].status).toBe("pass");
    expect(r.checks[0].details.parcelSource).toBe("getParcelGeometry");
    expect(civil.methodsCalled()).not.toContain("reportParcels");
  });
});
