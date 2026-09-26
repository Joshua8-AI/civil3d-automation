import { z } from "zod";
import { CIVIL3D_METHODS_USED } from "../clients/civil3d.js";
import { REVIT_METHODS_USED } from "../clients/revit.js";
import { PluginError } from "../clients/tcpRpc.js";
import { getDrawingContext } from "../core/civilData.js";
import { getProjectInfo, tryGetProjectLocation } from "../core/revitData.js";
import { describeRotation, sharedMmToCivil } from "../core/transform.js";
import { drawingUnitsSchema, errorInfo, type BridgeContext } from "./common.js";

export const statusSchema = {
  drawingUnits: drawingUnitsSchema,
  probeCommands: z
    .boolean()
    .optional()
    .default(true)
    .describe("Probe which pending plugin commands exist (read-only probes only). Default true."),
};

type Availability = "available" | "missing" | "unknown";

async function probe(fn: () => Promise<unknown>): Promise<Availability> {
  try {
    await fn();
    return "available";
  } catch (e) {
    if (e instanceof PluginError) {
      if (e.isMethodNotFound) return "missing";
      if (e.isUnreachable) return "unknown";
      // Any other error (bad params, object not found) proves the method exists.
      return "available";
    }
    return "unknown";
  }
}

export async function runStatus(ctx: BridgeContext, args: { drawingUnits?: any; probeCommands?: boolean }) {
  const probeCommands = args.probeCommands !== false;

  // ---- Civil 3D ----
  const civil3d: Record<string, unknown> = { endpoint: ctx.civil.endpoint, reachable: false };
  let civilUnit: import("../core/units.js").LinearUnit | null = null;
  try {
    const health = await ctx.civil.call<Record<string, any>>("getCivil3DHealth");
    civil3d.reachable = true;
    civil3d.version = health.civil3dVersion ?? null;
    civil3d.pluginVersion = health.pluginVersion ?? null;
    civil3d.drawingLoaded = health.drawingLoaded ?? null;
    civil3d.busy = health.operationInProgress ?? null;
    if (health.drawingLoaded !== false) {
      try {
        const dc = await getDrawingContext(ctx.civil, args.drawingUnits);
        civilUnit = dc.units.unit;
        civil3d.drawing = { name: dc.drawingName, path: dc.filePath };
        civil3d.units = { unit: dc.units.unit, source: dc.units.source, reported: dc.units.reported };
        civil3d.coordinateSystem = dc.coordinateSystem;
        civil3d.warnings = dc.warnings;
      } catch (e) {
        civil3d.drawingError = errorInfo(e).message;
      }
    }
    if (probeCommands) {
      const pending: Record<string, Availability> = {};
      for (const m of CIVIL3D_METHODS_USED.pending) pending[m] = await probe(() => ctx.civil.call(m, {}));
      civil3d.pendingCommands = pending;
    }
  } catch (e) {
    civil3d.error = errorInfo(e).message;
  }

  // ---- Revit ----
  const revit: Record<string, unknown> = { reachable: false };
  try {
    const ep = ctx.revit.describeEndpoint();
    revit.endpoint = `${ep.host}:${ep.port}`;
    revit.portDiscovery = ep.discovery;
  } catch (e) {
    revit.portDiscoveryError = errorInfo(e).message;
  }
  try {
    const info = await getProjectInfo(ctx.revit);
    revit.reachable = true;
    revit.project = { name: info.projectName, number: info.projectNumber, filePath: info.filePath };
    revit.units = "millimeters (wire unit of the Revit MCP plugin)";
    revit.levels = info.levels;
    const { location, note } = await tryGetProjectLocation(ctx.revit);
    if (location) {
      revit.projectLocation = {
        activeLocationName: location.activeLocationName,
        surveyPoint_mm: location.surveyPoint_mm,
        projectBasePoint: location.projectBasePoint,
        internalOriginInShared_mm: {
          x: location.position.eastWest_mm,
          y: location.position.northSouth_mm,
          z: location.position.elevation_mm,
        },
        angleToTrueNorth_deg: location.position.angleToTrueNorth_deg,
        rotation: describeRotation(location.position.angleToTrueNorth_deg),
        internalOriginInCivil3D: civilUnit
          ? sharedMmToCivil({ x: location.position.eastWest_mm, y: location.position.northSouth_mm, z: location.position.elevation_mm }, civilUnit)
          : null,
        site: { latitude: location.siteLatitude, longitude: location.siteLongitude },
      };
    } else {
      revit.projectLocationNote = note;
    }
    if (probeCommands) {
      const pending: Record<string, Availability | string> = {
        get_project_location: location ? "available" : note?.includes("pending") ? "missing" : "unknown",
        get_toposolids: await probe(() => ctx.revit.call("get_toposolids", { includePoints: false }, 30_000)),
        get_mep_systems: await probe(() => ctx.revit.call("get_mep_systems", {}, 30_000)),
      };
      for (const m of REVIT_METHODS_USED.pending) {
        if (!(m in pending)) pending[m] = "not probed (write command; exercised via dryRun in tool previews)";
      }
      revit.pendingCommands = pending;
    }
  } catch (e) {
    revit.error = errorInfo(e).message;
  }

  const bothUp = civil3d.reachable === true && revit.reachable === true;
  return {
    ok: bothUp,
    summary: bothUp
      ? "Both plugins reachable."
      : `Civil 3D ${civil3d.reachable ? "reachable" : "NOT reachable"}; Revit ${revit.reachable ? "reachable" : "NOT reachable"}.`,
    civil3d,
    revit,
    frames: {
      civil3d: "drawing coordinates, x=easting y=northing z=elevation, drawing units",
      revitShared: "Revit shared coordinates in mm; the bridge defines them as the Civil 3D drawing coordinates converted to mm",
      revitInternal: "Revit internal coordinates in mm",
    },
  };
}
