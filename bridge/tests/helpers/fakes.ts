/**
 * In-memory fakes of the two plugin APIs, used to test tool logic without
 * sockets. FakeRevit models Revit shared coordinates with the SAME
 * convention the bridge assumes (shared = T + Rz(angle)(internal - P)),
 * unless `angleSign` is set to -1 to simulate a plugin with the opposite
 * convention.
 */

import type { Civil3DApi } from "../../src/clients/civil3d.js";
import type { PortDiscovery, RevitApi } from "../../src/clients/revit.js";
import { PluginError } from "../../src/clients/tcpRpc.js";
import { anchorAtOrigin, type ProjectPosition, type Vec3 } from "../../src/core/transform.js";

export type Handler = (params: any) => any;

export class FakeCivil implements Civil3DApi {
  readonly endpoint = "fake-civil3d:8757";
  calls: Array<{ method: string; params: any }> = [];
  handlers: Record<string, Handler> = {};
  reachable = true;

  constructor(init: Partial<FakeCivilData> = {}) {
    const d: FakeCivilData = { ...defaultCivilData(), ...init };
    this.handlers = {
      getCivil3DHealth: () => ({ connected: true, civil3dVersion: "R26.0", pluginVersion: "1.2.1", drawingLoaded: true, operationInProgress: false }),
      getDrawingInfo: () => ({ drawingName: "Site.dwg", fileName: "Site.dwg", filePath: "C:\\proj\\Site.dwg", coordinateSystem: d.csCode, linearUnits: d.linearUnits, units: d.linearUnits }),
      getCoordinateSystemInfo: () => ({ name: d.csCode, zone: "NAD83 CA", datum: "NAD83", projection: "LM", linearUnits: d.linearUnits }),
      getCogoPoint: (p) => {
        const hit = d.points.find((x) => x.number === p.pointNumber);
        if (!hit) throw new PluginError(`civil3d: Point ${p.pointNumber} not found`, "civil3d", "CIVIL3D.OBJECT_NOT_FOUND", -32004, "getCogoPoint");
        return hit;
      },
      listCogoPoints: (p) => {
        const off = p.offset ?? 0;
        const lim = p.limit ?? 1e9;
        const page = d.points.slice(off, off + lim);
        return { totalCount: d.points.length, returnedCount: page.length, points: page, units: d.linearUnits };
      },
      getSurface: (p) => {
        if (p.name !== d.surface.name) throw new PluginError(`civil3d: surface '${p.name}' not found`, "civil3d", "CIVIL3D.OBJECT_NOT_FOUND", -32004, "getSurface");
        return {
          name: d.surface.name,
          boundingBox: d.surface.bbox,
          statistics: { minimumElevation: 90, maximumElevation: 120, numberOfPoints: d.surface.tin?.length ?? 1000 },
          units: d.linearUnits,
        };
      },
      sampleSurfaceElevations: (p) => {
        if (p.method !== "points") throw new Error("fake only supports method=points");
        const samples = (p.points as Array<{ x: number; y: number }>)
          .filter((q) => inBox(q, d.surface.bbox))
          .map((q) => ({ x: q.x, y: q.y, elevation: d.surface.z(q.x, q.y) }));
        return { surfaceName: p.name, method: "points", sampleCount: samples.length, samples, units: { horizontal: d.linearUnits, vertical: d.linearUnits } };
      },
      listPipeNetworks: () => ({ networks: d.gravity.map((n) => ({ name: n.name, pipeCount: n.pipes.length, structureCount: n.structures.length })) }),
      getPipeNetwork: (p) => {
        const n = d.gravity.find((x) => x.name === p.name);
        if (!n) throw new PluginError("civil3d: network not found", "civil3d", "CIVIL3D.OBJECT_NOT_FOUND", -32004, "getPipeNetwork");
        return { name: n.name, pipes: n.pipes, structures: n.structures };
      },
      listPressureNetworks: () => ({ networks: d.pressure.map((n) => ({ name: n.name })) }),
      getPressureNetworkInfo: (p) => {
        const n = d.pressure.find((x) => x.name === p.name);
        if (!n) throw new PluginError("civil3d: network not found", "civil3d", "CIVIL3D.OBJECT_NOT_FOUND", -32004, "getPressureNetworkInfo");
        return { name: n.name, pipes: n.pipes, fittings: [], appurtenances: [] };
      },
      reportParcels: (p) => ({
        siteName: p.siteName,
        parcelCount: d.parcels.length,
        parcels: d.parcels
          .filter((x) => !p.parcelNames || p.parcelNames.includes(x.name))
          .map((x) => ({ name: x.name, area: 1, ...(p.includeCoordinates ? { vertices: x.vertices } : {}) })),
      }),
    };
    if (d.surface.tin) {
      const tin = d.surface.tin;
      this.handlers.getSurfaceTinVertices = () => ({ surfaceName: d.surface.name, vertices: tin, totalVertexCount: tin.length, truncated: false });
    }
    if (d.drawingUnits) {
      const units = d.drawingUnits;
      this.handlers.getDrawingUnits = () => units;
    }
    if (d.parcelGeometry) {
      // Mirrors the plugin's getParcelGeometry shape (Civil3D-mcp feature/bridge-support-commands).
      this.handlers.getParcelGeometry = (p) => {
        const hit = d.parcels.find((x) => x.name.toLowerCase() === String(p.parcelName).toLowerCase());
        if (!hit) throw new PluginError(`civil3d: Parcel '${p.parcelName}' was not found`, "civil3d", "CIVIL3D.OBJECT_NOT_FOUND", -32004, "getParcelGeometry");
        return { siteName: p.siteName, name: hit.name, vertices: hit.vertices, closed: true, units: d.linearUnits, lengthUnit: "Feet", geometrySource: "baseCurve:Polyline" };
      };
    }
  }

  async call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params });
    if (!this.reachable) throw new PluginError("civil3d: cannot connect", "civil3d", "BRIDGE.CONNECT_FAILED", null, method);
    const h = this.handlers[method];
    if (!h) throw new PluginError(`civil3d: Plugin method '${method}' is not implemented yet.`, "civil3d", "CIVIL3D.METHOD_NOT_FOUND", -32601, method);
    return structuredClone(h(params)) as T;
  }

  methodsCalled(): string[] {
    return this.calls.map((c) => c.method);
  }
}

export interface FakeCivilData {
  linearUnits: string;
  csCode: string | null;
  points: Array<{ number: number; name: string | null; x: number; y: number; z: number; rawDescription?: string; fullDescription?: string }>;
  surface: {
    name: string;
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
    z: (x: number, y: number) => number;
    tin?: Vec3[];
  };
  gravity: Array<{ name: string; pipes: any[]; structures: any[] }>;
  pressure: Array<{ name: string; pipes: any[] }>;
  parcels: Array<{ name: string; vertices: Array<{ x: number; y: number }> }>;
  /** When set, the fake implements getDrawingUnits and returns this report. */
  drawingUnits?: Record<string, unknown>;
  /** When true, the fake implements getParcelGeometry over `parcels`. */
  parcelGeometry?: boolean;
}

function inBox(p: { x: number; y: number }, b: { minX: number; minY: number; maxX: number; maxY: number }) {
  return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
}

/** A US state-plane-like site in feet around E=6,000,000 N=2,000,000. */
export function defaultCivilData(): FakeCivilData {
  const E = 6_000_000;
  const N = 2_000_000;
  return {
    linearUnits: "feet",
    csCode: "CA83-VIF",
    points: [
      { number: 1, name: "CP1", x: E, y: N, z: 100, rawDescription: "CTRL" },
      { number: 2, name: "CP2", x: E, y: N + 100, z: 101, rawDescription: "CTRL" },
      { number: 3, name: "CP3", x: E + 100, y: N, z: 102, rawDescription: "CTRL" },
    ],
    surface: {
      name: "FG",
      bbox: { minX: E - 200, minY: N - 200, maxX: E + 200, maxY: N + 200 },
      // A plane: 100 ft at the control point, rising 1% to the east.
      z: (x: number, _y: number) => 100 + 0.01 * (x - E),
    },
    gravity: [
      {
        name: "SS-Main",
        structures: [
          { name: "MH-1", x: E - 150, y: N + 10, rimElevation: 99, sumpElevation: 90 },
          { name: "MH-2", x: E - 20, y: N + 10, rimElevation: 99.5, sumpElevation: 91 },
          { name: "MH-3", x: E - 20, y: N + 150, rimElevation: 99.5, sumpElevation: 91 },
        ],
        pipes: [
          { name: "P-1", startStructure: "MH-2", endStructure: "MH-1", diameter: 0.5, centerlineStartElevation: 92.25, centerlineEndElevation: 91.25, material: "PVC" },
          { name: "P-2", startStructure: "MH-3", endStructure: "MH-2", diameter: 0.5, centerlineStartElevation: 93.25, centerlineEndElevation: 92.5, material: "PVC" },
          { name: "P-orphan", startStructure: null, endStructure: "MH-1", diameter: 0.5, centerlineStartElevation: 95, centerlineEndElevation: 94 },
        ],
      },
    ],
    pressure: [
      {
        name: "W-Main",
        pipes: [
          { name: "W-1", diameter: 0.5, startPoint: { x: E + 30, y: N - 100, z: 96 }, endPoint: { x: E + 30, y: N - 5, z: 96 }, material: "DIP" },
          { name: "W-far", diameter: 0.5, startPoint: { x: E + 500, y: N + 500, z: 96 }, endPoint: { x: E + 600, y: N + 500, z: 96 } },
        ],
      },
    ],
    parcels: [
      {
        name: "Lot 1",
        vertices: [
          { x: E - 50, y: N - 50 },
          { x: E + 150, y: N - 50 },
          { x: E + 150, y: N + 150 },
          { x: E - 50, y: N + 150 },
        ],
      },
    ],
  };
}

export interface FakeRevitState {
  position: ProjectPosition;
  surveyPoint_mm: Vec3;
  levels: Array<{ id: number; name: string; elevation: number }>;
  toposolids: any[];
  pipes: any[];
}

export class FakeRevit implements RevitApi {
  calls: Array<{ method: string; params: any }> = [];
  reachable = true;
  /** +1 = same rotation convention as the bridge, -1 = opposite. */
  angleSign = 1;
  implementsPending = true;
  state: FakeRevitState;
  handlers: Record<string, Handler>;

  constructor(init: Partial<FakeRevitState> = {}) {
    this.state = {
      position: { eastWest_mm: 0, northSouth_mm: 0, elevation_mm: 0, angleToTrueNorth_deg: 0, internalPoint_mm: { x: 0, y: 0, z: 0 } },
      surveyPoint_mm: { x: 0, y: 0, z: 0 },
      levels: [
        { id: 311, name: "Level 1", elevation: 0 },
        { id: 312, name: "Level 2", elevation: 4000 },
      ],
      toposolids: [],
      pipes: [],
      ...init,
    };
    this.handlers = {
      get_project_info: () => ({
        Success: true,
        Message: "ok",
        Response: { projectName: "Bldg A", projectNumber: "001", filePath: "C:\\proj\\A.rvt", levels: this.state.levels },
      }),
      get_project_location: () => {
        const o = anchorAtOrigin(this.state.position);
        return {
          activeLocationName: "Internal",
          surveyPoint: { eastWest_mm: this.state.surveyPoint_mm.x, northSouth_mm: this.state.surveyPoint_mm.y, elevation_mm: this.state.surveyPoint_mm.z },
          projectBasePoint: { eastWest_mm: o.eastWest_mm, northSouth_mm: o.northSouth_mm, elevation_mm: o.elevation_mm, angleToTrueNorth_deg: o.angleToTrueNorth_deg },
          sharedTransform: { origin_mm: { x: o.eastWest_mm, y: o.northSouth_mm, z: o.elevation_mm }, rotation_deg: o.angleToTrueNorth_deg },
          siteLatitude: 34.0,
          siteLongitude: -118.0,
        };
      },
      set_shared_coordinates: (p) => {
        if (!p.dryRun) {
          this.state.position = {
            eastWest_mm: p.eastWest_mm,
            northSouth_mm: p.northSouth_mm,
            elevation_mm: p.elevation_mm,
            angleToTrueNorth_deg: this.angleSign * p.angleToTrueNorth_deg,
            internalPoint_mm: p.internalPoint_mm ?? { x: 0, y: 0, z: 0 },
          };
        }
        return { success: true, dryRun: !!p.dryRun };
      },
      create_toposolid: (p) => {
        if (!p.dryRun) this.state.toposolids.push(p);
        return { success: true, dryRun: !!p.dryRun, elementId: p.dryRun ? null : 9001, pointCount: p.points_mm.length };
      },
      get_toposolids: () => ({ toposolids: this.state.toposolids.map((_, i) => ({ id: 9001 + i })) }),
      create_pipe: (p) => {
        if (!p.dryRun) this.state.pipes.push(...p.pipes);
        return { success: true, dryRun: !!p.dryRun, created: p.dryRun ? 0 : p.pipes.length };
      },
      get_mep_systems: () => ({ pipingSystemTypes: [{ name: "Sanitary" }, { name: "Domestic Cold Water" }] }),
    };
  }

  describeEndpoint(): { host: string; port: number; discovery: PortDiscovery | null } {
    return { host: "127.0.0.1", port: 8081, discovery: { port: 8081, source: "portFile", portFile: "fake", candidates: [] } };
  }

  async call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ method, params: structuredClone(params) });
    if (!this.reachable) throw new PluginError("revit: cannot connect to plugin", "revit", "BRIDGE.CONNECT_FAILED", null, method);
    const pending = ["get_project_location", "set_shared_coordinates", "create_toposolid", "get_toposolids", "create_pipe", "get_mep_systems"];
    const h = this.handlers[method];
    if (!h || (!this.implementsPending && pending.includes(method))) {
      throw new PluginError(`revit: Method '${method}' not found`, "revit", "REVIT.METHOD_NOT_FOUND", -32601, method);
    }
    const r = h(params);
    // Mirror RevitClient's AIResult unwrapping for the one envelope-shaped handler.
    if (r && typeof r === "object" && "Success" in r && "Response" in r) return structuredClone(r.Response) as T;
    return structuredClone(r) as T;
  }

  writes(): Array<{ method: string; params: any }> {
    return this.calls.filter((c) => ["set_shared_coordinates", "create_toposolid", "create_pipe"].includes(c.method) && !c.params.dryRun);
  }
}
