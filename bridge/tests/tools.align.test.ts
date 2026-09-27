import { describe, expect, it } from "vitest";
import { CIVIL3D_METHODS_USED } from "../src/clients/civil3d.js";
import { PreviewStore } from "../src/core/previewStore.js";
import { internalToCivil, internalToShared } from "../src/core/transform.js";
import { toMm } from "../src/core/units.js";
import { runAlign, type AlignArgs } from "../src/tools/align.js";
import { FakeCivil, FakeRevit } from "./helpers/fakes.js";

function setup() {
  const civil = new FakeCivil();
  const revit = new FakeRevit();
  const ctx = { civil, revit, previews: new PreviewStore() };
  return { civil, revit, ctx };
}

const readOnly = new Set<string>([...CIVIL3D_METHODS_USED.existing, ...CIVIL3D_METHODS_USED.pending]);

async function previewThenApply(ctx: any, args: AlignArgs) {
  const preview: any = await runAlign(ctx, args);
  const applied: any = await runAlign(ctx, { ...args, apply: true, previewId: preview.previewId });
  return { preview, applied };
}

describe("bridge_align_coordinates", () => {
  it("previews by default: computes the payload, asks Revit for a dry run, writes nothing", async () => {
    const { ctx, revit, civil } = setup();
    const r: any = await runAlign(ctx, { civil3dPoint: { pointNumber: 1 } });
    expect(r.mode).toBe("preview");
    expect(r.wroteToRevit).toBe(false);
    expect(r.previewId).toMatch(/[0-9a-f-]{36}/);
    expect(r.setSharedCoordinates).toMatchObject({
      eastWest_mm: 6_000_000 * 304.8,
      northSouth_mm: 2_000_000 * 304.8,
      elevation_mm: toMm(100, "feet"),
      angleToTrueNorth_deg: 0,
      internalPoint_mm: { x: 0, y: 0, z: 0 },
    });
    expect(r.computedVerification.pass).toBe(true);
    expect(r.computedVerification.maxRoundTripError_mm).toBeLessThan(1e-3);
    expect(r.movement.alreadyAligned).toBe(false);
    expect(revit.writes()).toHaveLength(0);
    expect(revit.calls.find((c) => c.method === "set_shared_coordinates")?.params.dryRun).toBe(true);
    expect(civil.methodsCalled().every((m) => readOnly.has(m))).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/US survey feet/);
  });

  it("refuses apply without a previewId", async () => {
    const { ctx, revit } = setup();
    await expect(runAlign(ctx, { civil3dPoint: { pointNumber: 1 }, apply: true })).rejects.toThrow(/requires previewId/);
    expect(revit.writes()).toHaveLength(0);
  });

  it("applies with a valid previewId and verifies by reading Revit back", async () => {
    const { ctx, revit } = setup();
    const { applied } = await previewThenApply(ctx, { civil3dPoint: { pointNumber: 1 } });
    expect(applied.mode).toBe("apply");
    expect(applied.wroteToRevit).toBe(true);
    expect(applied.wroteToCivil3d).toBe(false);
    expect(applied.verification.pass).toBe(true);
    expect(revit.writes()).toHaveLength(1);
    const origin = internalToCivil(revit.state.position, { x: 0, y: 0, z: 0 }, "feet");
    expect(origin.x).toBeCloseTo(6_000_000, 6);
    expect(origin.y).toBeCloseTo(2_000_000, 6);
    expect(origin.z).toBeCloseTo(100, 9);
  });

  it("a previewId is single-use and bound to the arguments", async () => {
    const { ctx } = setup();
    const args: AlignArgs = { civil3dPoint: { pointNumber: 1 } };
    const p: any = await runAlign(ctx, args);
    await expect(runAlign(ctx, { civil3dPoint: { pointNumber: 2 }, apply: true, previewId: p.previewId })).rejects.toThrow(/arguments differ/);
    await runAlign(ctx, { ...args, apply: true, previewId: p.previewId });
    await expect(runAlign(ctx, { ...args, apply: true, previewId: p.previewId })).rejects.toThrow(/already used/);
  });

  it("refuses apply when the Civil 3D point moved after the preview", async () => {
    const { ctx, civil } = setup();
    const args: AlignArgs = { civil3dPoint: { pointNumber: 1 } };
    const p: any = await runAlign(ctx, args);
    const old = civil.handlers.getCogoPoint;
    civil.handlers.getCogoPoint = (q) => ({ ...old(q), x: 6_000_000.5 });
    await expect(runAlign(ctx, { ...args, apply: true, previewId: p.previewId })).rejects.toThrow(/changed since the preview/);
  });

  it("explicit rotation and a non-origin internal point", async () => {
    const { ctx, revit } = setup();
    const P = { x: 5_000, y: 7_000, z: 0 };
    const { applied } = await previewThenApply(ctx, {
      civil3dPoint: { northing: 2_000_010, easting: 6_000_020, elevation: 101.5 },
      revitInternalPoint_mm: P,
      rotation: { source: "explicit", angleToTrueNorth_deg: 30 },
    });
    expect(applied.verification.pass).toBe(true);
    const landed = internalToCivil(revit.state.position, P, "feet");
    expect(landed.x).toBeCloseTo(6_000_020, 6);
    expect(landed.y).toBeCloseTo(2_000_010, 6);
    expect(landed.z).toBeCloseTo(101.5, 9);
  });

  it("detects a Revit plugin that uses the opposite rotation sign", async () => {
    const { ctx, revit } = setup();
    revit.angleSign = -1;
    const { applied } = await previewThenApply(ctx, { civil3dPoint: { pointNumber: 1 }, rotation: { source: "explicit", angleToTrueNorth_deg: 25 } });
    expect(applied.verification.pass).toBe(false);
    expect(applied.verification.hint).toMatch(/opposite rotation sign/);
  });

  it("derives rotation from two point pairs", async () => {
    const { ctx, revit } = setup();
    // CP2 is 100 ft north of CP1; the Revit point 30480 mm along internal +X corresponds to it => +90 deg.
    const { preview, applied } = await previewThenApply(ctx, {
      civil3dPoint: { pointNumber: 1 },
      rotation: { source: "twoPoints", civil3dPoint: { pointName: "cp2" }, revitInternalPoint_mm: { x: 30_480, y: 0, z: 0 } },
    });
    expect(preview.rotation.angleToTrueNorth_deg).toBeCloseTo(90, 9);
    expect(preview.rotation.scaleRatio).toBeCloseTo(1, 12);
    expect(applied.verification.pass).toBe(true);
    const s = internalToShared(revit.state.position, { x: 30_480, y: 0, z: 0 });
    expect(s.x / 304.8).toBeCloseTo(6_000_000, 6);
    expect(s.y / 304.8).toBeCloseTo(2_000_100, 6);
  });

  it("refuses a two-point rotation whose distances disagree (units mistake)", async () => {
    const { ctx, revit } = setup();
    await expect(
      runAlign(ctx, {
        civil3dPoint: { pointNumber: 1 },
        rotation: { source: "twoPoints", civil3dPoint: { pointNumber: 2 }, revitInternalPoint_mm: { x: 100_000, y: 0, z: 0 } },
      }),
    ).rejects.toThrow(/drawingUnits/);
    expect(revit.calls).toHaveLength(0);
  });

  it("US survey feet override changes the payload by ~2 ppm", async () => {
    const { ctx } = setup();
    const a: any = await runAlign(ctx, { civil3dPoint: { pointNumber: 1 } });
    const b: any = await runAlign(ctx, { civil3dPoint: { pointNumber: 1 }, drawingUnits: "usSurveyFeet" });
    expect(b.setSharedCoordinates.eastWest_mm - a.setSharedCoordinates.eastWest_mm).toBeCloseTo(3657.6073, 3);
    expect(b.civil3d.unitsSource).toBe("override");
  });

  it("still previews when Revit lacks the pending commands, and says so", async () => {
    const { ctx, revit } = setup();
    revit.implementsPending = false;
    const r: any = await runAlign(ctx, { civil3dPoint: { pointNumber: 1 } });
    expect(r.before).toBeNull();
    expect(r.revitDryRun.unavailable).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/get_project_location/);
  });

  it("unknown COGO point name is a clean error", async () => {
    const { ctx } = setup();
    await expect(runAlign(ctx, { civil3dPoint: { pointName: "nope" } })).rejects.toThrow(/no COGO point named/);
  });
});
