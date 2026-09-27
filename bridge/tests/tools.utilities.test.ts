import { describe, expect, it } from "vitest";
import { PreviewStore } from "../src/core/previewStore.js";
import { computeProjectPosition } from "../src/core/transform.js";
import { extractSystemTypeNames, matchRule, runUtilities } from "../src/tools/utilities.js";
import { FakeCivil, FakeRevit } from "./helpers/fakes.js";

const E = 6_000_000;
const N = 2_000_000;

function setup() {
  const civil = new FakeCivil();
  const revit = new FakeRevit({
    position: computeProjectPosition({ civilBasePoint: { x: E, y: N, z: 100 }, drawingUnit: "feet", internalPoint_mm: { x: 0, y: 0, z: 0 }, angleToTrueNorth_deg: 0 }),
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

const mapping = [
  { network: "/^SS-/", systemTypeName: "Sanitary", pipeTypeName: "PVC - Sch 40" },
  { kind: "pressure" as const, systemTypeName: "Domestic Cold Water" },
];

describe("bridge_utilities_to_revit: report", () => {
  it("selects pipes within a distance of the footprint and reports connection points", async () => {
    const { ctx, revit } = setup();
    const r: any = await runUtilities(ctx, { footprint, distance: 30 });
    expect(r.mode).toBe("report");
    expect(r.wroteToRevit).toBe(false);
    const names = r.pipes.map((p: any) => p.name).sort();
    expect(names).toEqual(["P-1", "P-2", "W-1"]);
    expect(r.skipped.map((s: any) => s.name)).toContain("P-orphan");

    const p1 = r.pipes.find((p: any) => p.name === "P-1");
    expect(p1.diameter_mm).toBeCloseTo(152.4, 6);
    expect(p1.start.invert).toBeCloseTo(92.0, 9); // 92.25 centreline - 0.25 radius
    expect(p1.distanceToFootprint).toBeCloseTo(20, 9);
    expect(p1.connectionPoint.end).toBe("start");
    expect(p1.connectionPoint.invertElevation).toBeCloseTo(92.0, 9);
    expect(p1.connectionPoint.shared_mm.x).toBeCloseTo((E - 20) * 304.8, 3);

    const w1 = r.pipes.find((p: any) => p.name === "W-1");
    expect(w1.connectionPoint.end).toBe("end");
    expect(w1.connectionPoint.invertElevation).toBeCloseTo(95.75, 9);
    expect(w1.distanceToFootprint).toBeCloseTo(5, 9);
    expect(r.connectionPoints).toHaveLength(3);
    expect(revit.calls).toHaveLength(0);
  });

  it("boundary selection and network filtering", async () => {
    const { ctx } = setup();
    const r: any = await runUtilities(ctx, {
      include: "gravity",
      networks: ["ss-main", "missing-net"],
      boundary: { coordinateSystem: "civil3d", points: [{ x: E - 30, y: N }, { x: E - 10, y: N }, { x: E - 10, y: N + 200 }, { x: E - 30, y: N + 200 }] },
    });
    expect(r.pipes.map((p: any) => p.name).sort()).toEqual(["P-1", "P-2"]);
    expect(r.skipped.some((s: any) => s.reason.includes("network not found"))).toBe(true);
  });

  it("distance without footprint is refused", async () => {
    const { ctx } = setup();
    await expect(runUtilities(ctx, { distance: 10 })).rejects.toThrow(/requires footprint/);
  });
});

describe("bridge_utilities_to_revit: create", () => {
  it("previews Revit pipes in shared mm with mapped systems, then applies", async () => {
    const { ctx, revit } = setup();
    const args = { mode: "create" as const, footprint, distance: 30, levelName: "Level 1", systemMapping: mapping };
    const p: any = await runUtilities(ctx, args);
    expect(p.mode).toBe("create-preview");
    expect(p.blocking).toEqual([]);
    expect(p.createPipe.pipeCount).toBe(3);
    const ss = p.createPipe.pipes.find((x: any) => x.systemTypeName === "Sanitary");
    expect(ss.pipeTypeName).toBe("PVC - Sch 40");
    expect(ss.levelName).toBe("Level 1");
    expect(ss.diameter_mm).toBeCloseTo(152.4, 6);
    expect(ss.start_mm.z).toBeCloseTo(92.25 * 304.8, 3); // centreline elevation, not invert
    expect(revit.writes()).toHaveLength(0);

    const a: any = await runUtilities(ctx, { ...args, apply: true, previewId: p.previewId });
    expect(a.mode).toBe("create-apply");
    expect(revit.state.pipes).toHaveLength(3);
    expect(revit.writes()[0].params.coordinateSystem).toBe("shared");
  });

  it("requires levelName", async () => {
    const { ctx } = setup();
    await expect(runUtilities(ctx, { mode: "create", footprint, distance: 30 })).rejects.toThrow(/levelName/);
  });

  it("blocks when nothing maps to a Revit system", async () => {
    const { ctx } = setup();
    const r: any = await runUtilities(ctx, { mode: "create", footprint, distance: 30, levelName: "Level 1" });
    expect(r.previewId).toBeNull();
    expect(r.blocking.join(" ")).toMatch(/No pipes to create/);
    expect(r.warnings.join(" ")).toMatch(/no system mapping/);
  });

  it("diameterUnits inches", async () => {
    const civil = new FakeCivil();
    civil.handlers.getPipeNetwork = () => ({
      name: "SS-Main",
      structures: [
        { name: "A", x: E - 10, y: N },
        { name: "B", x: E - 40, y: N },
      ],
      pipes: [{ name: "X", startStructure: "A", endStructure: "B", diameter: 12, centerlineStartElevation: 95, centerlineEndElevation: 94 }],
    });
    const ctx = { civil, revit: new FakeRevit(), previews: new PreviewStore() };
    const r: any = await runUtilities(ctx, { include: "gravity", diameterUnits: "inches" });
    expect(r.pipes[0].diameter_mm).toBeCloseTo(304.8, 6);
    const r2: any = await runUtilities(ctx, { include: "gravity" });
    expect(r2.warnings.join(" ")).toMatch(/diameterUnits: 'inches'/);
  });
});

describe("mapping helpers", () => {
  it("matchRule: first match wins; regex and kind filters", () => {
    expect(matchRule(mapping, { network: "SS-Main", kind: "gravity" })?.systemTypeName).toBe("Sanitary");
    expect(matchRule(mapping, { network: "W-Main", kind: "pressure" })?.systemTypeName).toBe("Domestic Cold Water");
    expect(matchRule(mapping, { network: "SD-1", kind: "gravity" })).toBeNull();
    expect(matchRule([{ network: "sd-1", systemTypeName: "Storm" }], { network: "SD-1", kind: "gravity" })?.systemTypeName).toBe("Storm");
  });
  it("extractSystemTypeNames tolerates shapes", () => {
    expect([...extractSystemTypeNames({ pipingSystemTypes: [{ name: "Sanitary" }] })]).toEqual(["sanitary"]);
    expect([...extractSystemTypeNames([{ systemTypeName: "Vent" }])]).toEqual(["vent"]);
  });
});
