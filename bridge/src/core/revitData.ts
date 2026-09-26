/**
 * Read-side adapters over the Revit plugin.
 */

import type { RevitApi } from "../clients/revit.js";
import { PluginError } from "../clients/tcpRpc.js";
import { fromSharedTransform, type ProjectPosition, type Vec3 } from "./transform.js";

export interface RevitProjectLocation {
  activeLocationName: string | null;
  surveyPoint_mm: Vec3 | null;
  projectBasePoint: (Vec3 & { angleToTrueNorth_deg: number | null }) | null;
  /** internal -> shared transform, anchored at the internal origin. */
  position: ProjectPosition;
  siteLatitude: number | null;
  siteLongitude: number | null;
  raw: unknown;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function vec(v: any, xk: string, yk: string, zk: string): Vec3 | null {
  const x = num(v?.[xk]);
  const y = num(v?.[yk]);
  const z = num(v?.[zk]);
  return x !== null && y !== null && z !== null ? { x, y, z } : null;
}

/**
 * Parse get_project_location (pending command). Contract:
 * {activeLocationName, surveyPoint:{eastWest_mm,northSouth_mm,elevation_mm},
 *  projectBasePoint:{eastWest_mm,northSouth_mm,elevation_mm,angleToTrueNorth_deg},
 *  sharedTransform:{origin_mm:{x,y,z},rotation_deg}, siteLatitude, siteLongitude}
 */
export function parseProjectLocation(raw: any): RevitProjectLocation {
  const st = raw?.sharedTransform;
  const origin = vec(st?.origin_mm, "x", "y", "z");
  const rot = num(st?.rotation_deg);
  if (!origin || rot === null) {
    throw new PluginError("revit: get_project_location returned no usable sharedTransform {origin_mm, rotation_deg}", "revit", "BRIDGE.BAD_RESPONSE", null, "get_project_location");
  }
  const pbp = vec(raw?.projectBasePoint, "eastWest_mm", "northSouth_mm", "elevation_mm");
  return {
    activeLocationName: typeof raw?.activeLocationName === "string" ? raw.activeLocationName : null,
    surveyPoint_mm: vec(raw?.surveyPoint, "eastWest_mm", "northSouth_mm", "elevation_mm"),
    projectBasePoint: pbp ? { ...pbp, angleToTrueNorth_deg: num(raw?.projectBasePoint?.angleToTrueNorth_deg) } : null,
    position: fromSharedTransform({ origin_mm: origin, rotation_deg: rot }),
    siteLatitude: num(raw?.siteLatitude),
    siteLongitude: num(raw?.siteLongitude),
    raw,
  };
}

export async function getProjectLocation(revit: RevitApi): Promise<RevitProjectLocation> {
  const raw = await revit.call("get_project_location", {}, 30_000);
  return parseProjectLocation(raw);
}

/** Like getProjectLocation but returns null + reason when the command is missing/unreachable. */
export async function tryGetProjectLocation(revit: RevitApi): Promise<{ location: RevitProjectLocation | null; note: string | null }> {
  try {
    return { location: await getProjectLocation(revit), note: null };
  } catch (e) {
    if (e instanceof PluginError && e.isMethodNotFound) {
      return { location: null, note: "Revit plugin does not implement get_project_location yet (pending command)." };
    }
    if (e instanceof PluginError && e.isUnreachable) return { location: null, note: e.message };
    throw e;
  }
}

export interface RevitLevel {
  id: number | string | null;
  name: string;
  /** Elevation from the Revit INTERNAL origin, mm (Level.Elevation * 304.8). */
  elevation_mm: number;
}

export interface RevitProjectInfo {
  projectName: string | null;
  projectNumber: string | null;
  filePath: string | null;
  levels: RevitLevel[];
}

export async function getProjectInfo(revit: RevitApi): Promise<RevitProjectInfo> {
  const r = await revit.call<Record<string, any>>(
    "get_project_info",
    { includePhases: false, includeWorksets: false, includeLinks: false, includeLevels: true },
    30_000,
  );
  const levels: RevitLevel[] = (Array.isArray(r?.levels) ? r.levels : [])
    .filter((l: any) => typeof l?.name === "string" && typeof l?.elevation === "number")
    .map((l: any) => ({ id: l.id ?? null, name: l.name, elevation_mm: l.elevation }));
  return {
    projectName: typeof r?.projectName === "string" ? r.projectName : null,
    projectNumber: typeof r?.projectNumber === "string" ? r.projectNumber : null,
    filePath: typeof r?.filePath === "string" ? r.filePath : null,
    levels,
  };
}
