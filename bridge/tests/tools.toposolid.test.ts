import { describe, expect, it } from "vitest";
import { pointInPolygon } from "../src/core/geometry.js";
import { PreviewStore } from "../src/core/previewStore.js";
import { computeProjectPosition } from "../src/core/transform.js";
import { runToposolid } from "../src/tools/toposolid.js";
import { PluginError } from "../src/clients/tcpRpc.js";
import { FakeCivil, FakeRevit } from "./helpers/fakes.js";

const E = 6_000_000;
const N = 2_000_000;

function setup(aligned = true, civilInit = {}) {
  const civil = new FakeCivil(civilInit);
  const revit = new FakeRevit(
    aligned
      ? { position: computeProjectPosition({ civilBasePoint: { x: E, y: N, z: 100 }, drawingUnit: "feet", internalPoint_mm: { x: 0, y: 0, z: 0 }, angleToTrueNorth_deg: 0 }) }
      : {},
  );
  return { civil, revit, ctx: { civil, revit, previews: new PreviewStore() } };
}

const footprint = {
  coordinateSystem: "civil3d" as const,
  points: [
    { x: E - 50, y: N - 50 },
    { x: E + 50, y: N - 50 },
    { x: E + 50, y: N + 50 },
    { x: E - 50, y: N + 50 },
  ],
};

describe("bridge_surface_to_toposolid", () => {
  it("grid-samples inside the boundary, converts to shared mm, previews without writing", async () => {
    const { ctx, revit } = setup();
    const r: any = await runToposolid(ctx, { surfaceName: "FG", boundary: footprint, maxPoints: 200, includePoints: true });
    expect(r.mode).toBe("preview");
    expect(r.blocking).toEqual([]);
    expect(r.pointCount).toBeLessThanOrEqual(200);
    expect(r.pointCount).toBeGreaterThan(50);
    expect(r.createToposolid.coordinateSystem).toBe("shared");
    const poly = footprint.points.map((p) => ({ x: p.x * 304.8, y: p.y * 304.8 }));
    for (const p of r.createToposolid.points_mm) {
      const inside = pointInPolygon(p, poly) || Math.abs(Math.abs(p.x / 304.8 - E) - 50) < 1e-6 || Math.abs(Math.abs(p.y / 304.8 - N) - 50) < 1e-6;
      expect(inside).toBe(true);
      // z is the surface plane, converted exactly (rounded to 0.001 mm).
      expect(p.z).toBeCloseTo((100 + 0.01 * (p.x / 304.8 - E)) * 304.8, 2);
    }
    expect(r.placement.maxDistanceFromInternalOrigin_mm).toBeLessThan(30_000);
    expect(revit.writes()).toHaveLength(0);
    expect(revit.calls.find((c) => c.method === "create_toposolid")?.params.dryRun).toBe(true);
  });

  it("applies with the previewId and sends exactly the previewed points", async () => {
    const { ctx, revit } = setup();
    const args = { surfaceName: "FG", boundary: footprint, maxPoints: 100, levelName: "Level 1", toposolidTypeName: "Toposolid 300mm" };
    const p: any = await runToposolid(ctx, args);
    const a: any = await runToposolid(ctx, { ...args, apply: true, previewId: p.previewId });
    expect(a.wroteToRevit).toBe(true);
    expect(revit.state.toposolids).toHaveLength(1);
    const sent = revit.state.toposolids[0];
    expect(sent.points_mm).toHaveLength(p.pointCount);
    expect(sent).toMatchObject({ coordinateSystem: "shared", levelName: "Level 1", toposolidTypeName: "Toposolid 300mm", dryRun: false });
  });

  it("blocks when Revit shared coordinates are not aligned (points > 32 km from origin)", async () => {
    const { ctx, revit } = setup(false);
    const r: any = await runToposolid(ctx, { surfaceName: "FG", boundary: footprint, maxPoints: 50 });
    expect(r.previewId).toBeNull();
    expect(r.blocking.join(" ")).toMatch(/bridge_align_coordinates/);
    expect(revit.calls.some((c) => c.method === "create_toposolid")).toBe(false);
  });

  it("uses the surface bounding box when no boundary is given, and respects maxPoints", async () => {
    const { ctx } = setup();
    const r: any = await runToposolid(ctx, { surfaceName: "FG", maxPoints: 400 });
    expect(r.region.type).toBe("surfaceBoundingBox");
    expect(r.pointCount).toBeLessThanOrEqual(400);
  });

  it("accepts a boundary in Revit internal millimetres", async () => {
    const { ctx } = setup();
    const r: any = await runToposolid(ctx, {
      surfaceName: "FG",
      maxPoints: 100,
      includePoints: true,
      boundary: {
        coordinateSystem: "revitInternal",
        points: [
          { x: -3048, y: -3048 },
          { x: 3048, y: -3048 },
          { x: 3048, y: 3048 },
          { x: -3048, y: 3048 },
        ],
      },
    });
    for (const p of r.createToposolid.points_mm) {
      expect(Math.abs(p.x / 304.8 - E)).toBeLessThanOrEqual(10 + 1e-6);
      expect(Math.abs(p.y / 304.8 - N)).toBeLessThanOrEqual(10 + 1e-6);
    }
  });

  it("tin sampling reports the missing plugin command", async () => {
    const { ctx } = setup();
    await expect(runToposolid(ctx, { surfaceName: "FG", sampling: "tin" })).rejects.toThrow(/getSurfaceTinVertices/);
  });

  it("tin sampling decimates plugin vertices when the command exists", async () => {
    const tin = [];
    for (let i = 0; i < 60; i++) for (let j = 0; j < 60; j++) tin.push({ x: E - 150 + i * 5, y: N - 150 + j * 5, z: 100 + i * 0.05 });
    const { ctx } = setup(true, {
      surface: { name: "FG", bbox: { minX: E - 200, minY: N - 200, maxX: E + 200, maxY: N + 200 }, z: () => 100, tin },
    });
    const r: any = await runToposolid(ctx, { surfaceName: "FG", sampling: "tin", maxPoints: 300, boundary: footprint });
    expect(r.sampling.method).toBe("tin");
    expect(r.sampling.inRegion).toBeLessThan(tin.length);
    expect(r.pointCount).toBeLessThanOrEqual(300);
    expect(r.warnings.join(" ")).toMatch(/decimated/);
  });

  it("blocks (no previewId) when Revit rejects the dry run", async () => {
    const { ctx, revit } = setup();
    revit.handlers.create_toposolid = () => {
      throw new PluginError("revit: create_toposolid failed: Duplicate point in plan", "revit", "REVIT.COMMAND_FAILED", null, "create_toposolid");
    };
    const r: any = await runToposolid(ctx, { surfaceName: "FG", boundary: footprint, maxPoints: 60 });
    expect(r.previewId).toBeNull();
    expect(r.blocking.join(" ")).toMatch(/Revit rejected the dry run: .*Duplicate point/);
  });

  it("still previews (with a warning) when Revit is unreachable for the dry run", async () => {
    const { ctx, revit } = setup();
    revit.handlers.create_toposolid = () => {
      throw new PluginError("revit: cannot connect", "revit", "REVIT.UNREACHABLE", null, "create_toposolid");
    };
    const r: any = await runToposolid(ctx, { surfaceName: "FG", boundary: footprint, maxPoints: 60 });
    expect(r.previewId).toBeTruthy();
    expect(r.warnings.join(" ")).toMatch(/dry run not performed/);
  });

  it("refuses apply if the surface changed after the preview", async () => {
    const { ctx, civil, revit } = setup();
    const args = { surfaceName: "FG", boundary: footprint, maxPoints: 60 };
    const p: any = await runToposolid(ctx, args);
    const old = civil.handlers.sampleSurfaceElevations;
    civil.handlers.sampleSurfaceElevations = (q) => {
      const r = old(q);
      r.samples = r.samples.map((s: any) => ({ ...s, elevation: s.elevation + 0.1 }));
      return r;
    };
    await expect(runToposolid(ctx, { ...args, apply: true, previewId: p.previewId })).rejects.toThrow(/changed since the preview/);
    expect(revit.writes()).toHaveLength(0);
  });

  it("refuses when the region has too few surface points", async () => {
    const { ctx } = setup();
    await expect(
      runToposolid(ctx, {
        surfaceName: "FG",
        boundary: { coordinateSystem: "civil3d", points: [{ x: E + 1000, y: N + 1000 }, { x: E + 1100, y: N + 1000 }, { x: E + 1100, y: N + 1100 }] },
      }),
    ).rejects.toThrow(/at least 3/);
  });
});
