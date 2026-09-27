import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { alignSchema, runAlign } from "./align.js";
import { guard, type BridgeContext } from "./common.js";
import { consistencySchema, runConsistency } from "./consistency.js";
import { runStatus, statusSchema } from "./status.js";
import { runToposolid, toposolidSchema } from "./toposolid.js";
import { runUtilities, utilitiesSchema } from "./utilities.js";

export const TOOL_NAMES = [
  "bridge_status",
  "bridge_align_coordinates",
  "bridge_surface_to_toposolid",
  "bridge_utilities_to_revit",
  "bridge_check_consistency",
] as const;

const WRITE_NOTE =
  "Two-step write: the default call is a PREVIEW that writes nothing (it may ask Revit for a dryRun) and returns a previewId. " +
  "To write, call again with identical arguments plus apply: true and that previewId. Only Revit is ever written; Civil 3D is read-only.";

export function registerTools(server: McpServer, ctx: BridgeContext): void {
  server.registerTool(
    "bridge_status",
    {
      title: "Bridge status",
      description:
        "Read-only. Reachability of the Civil 3D plugin (127.0.0.1:8757) and the Revit plugin (8080-8089, discovered from mcp-port.txt), " +
        "active drawing/model, Civil 3D linear units and coordinate system, Revit levels and shared-coordinate location, and which pending plugin commands exist.",
      inputSchema: statusSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => guard(() => runStatus(ctx, args)),
  );

  server.registerTool(
    "bridge_align_coordinates",
    {
      title: "Align Revit shared coordinates to Civil 3D",
      description:
        "Compute Revit shared coordinates so a chosen Revit internal point lands on a Civil 3D base point (COGO point number/name or explicit N/E/Z), " +
        "with rotation from an explicit angle, Civil 3D grid north, or a second point pair; then call Revit set_shared_coordinates. " +
        "Returns before/after and a verification that round-trips test points. " +
        WRITE_NOTE,
      inputSchema: alignSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => guard(() => runAlign(ctx, args)),
  );

  server.registerTool(
    "bridge_surface_to_toposolid",
    {
      title: "Civil 3D surface to Revit toposolid",
      description:
        "Sample a Civil 3D surface (regular grid, or TIN vertices when the plugin supports it) within an optional boundary/footprint, " +
        "respecting maxPoints with automatic coarsening/decimation, convert drawing units to mm, and create a Revit toposolid in SHARED coordinates. " +
        WRITE_NOTE,
      inputSchema: toposolidSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => guard(() => runToposolid(ctx, args)),
  );

  server.registerTool(
    "bridge_utilities_to_revit",
    {
      title: "Civil 3D site utilities to Revit pipes",
      description:
        "Read Civil 3D gravity and/or pressure pipe networks, select pipes inside a boundary or within a distance of the building footprint, and either " +
        "report them with building connection points (location + invert; mode 'report', read-only, default) or create Revit pipes in SHARED coordinates " +
        "with centreline elevations and network->system/pipe type mapping (mode 'create'). " +
        WRITE_NOTE,
      inputSchema: utilitiesSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => guard(() => runUtilities(ctx, args)),
  );

  server.registerTool(
    "bridge_check_consistency",
    {
      title: "Civil 3D / Revit consistency checks",
      description:
        "Read-only. Structured pass/fail report: (ffe) Revit finished-floor level vs Civil 3D surface grade along the footprint/pads; " +
        "(setbacks) footprint vs parcel edges with per-edge setback distances; (alignment) Revit survey point or internal point vs a Civil 3D point.",
      inputSchema: consistencySchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => guard(() => runConsistency(ctx, args)),
  );
}
