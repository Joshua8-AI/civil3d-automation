/**
 * Client for the Civil 3D MCP plugin (Civil3D-mcp repo, Civil3D-MCP-Plugin).
 *
 * Wire: bare JSON-RPC 2.0 object per TCP connection on 127.0.0.1:8757.
 * Errors: { code:number, message, data:{ code:"CIVIL3D.*" } }.
 *
 * This talks to the plugin directly, bypassing the Civil3D-mcp Node server's
 * approval gate. The bridge therefore only ever calls READ commands on
 * Civil 3D (see CIVIL3D_METHODS_USED) and never writes to the drawing.
 */

import { PluginError, sendJsonRpc, type TcpRpcOptions } from "./tcpRpc.js";

export interface Civil3DClientOptions {
  host?: string;
  port?: number;
  connectTimeoutMs?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** Every Civil 3D plugin method the bridge may call. All are read-only. */
export const CIVIL3D_METHODS_USED = {
  existing: [
    "getCivil3DHealth",
    "getDrawingInfo",
    "getCoordinateSystemInfo",
    "getCogoPoint",
    "listCogoPoints",
    "listSurfaces",
    "getSurface",
    "sampleSurfaceElevations",
    "listPipeNetworks",
    "getPipeNetwork",
    "listPressureNetworks",
    "getPressureNetworkInfo",
    "reportParcels",
  ],
  /** Proposed; not implemented by the plugin at the time of writing. */
  pending: ["getSurfaceTinVertices", "getParcelGeometry", "getDrawingUnits"],
} as const;

const READ_ONLY = new Set<string>([...CIVIL3D_METHODS_USED.existing, ...CIVIL3D_METHODS_USED.pending]);

export interface Civil3DApi {
  call<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  readonly endpoint: string;
}

export class Civil3DClient implements Civil3DApi {
  private readonly opts: TcpRpcOptions;

  constructor(options: Civil3DClientOptions = {}) {
    this.opts = {
      host: options.host ?? process.env.CIVIL3D_HOST ?? "127.0.0.1",
      port: options.port ?? parseInt(process.env.CIVIL3D_PORT ?? "8757", 10),
      framing: "json",
      connectTimeoutMs: options.connectTimeoutMs ?? parseInt(process.env.CIVIL3D_CONNECT_TIMEOUT ?? "5000", 10),
      timeoutMs: options.timeoutMs ?? parseInt(process.env.CIVIL3D_COMMAND_TIMEOUT ?? "120000", 10),
      maxResponseBytes: options.maxResponseBytes ?? parseInt(process.env.CIVIL3D_MAX_RESPONSE_BYTES ?? "33554432", 10),
    };
  }

  get endpoint(): string {
    return `${this.opts.host}:${this.opts.port}`;
  }

  async call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!READ_ONLY.has(method)) {
      // Defence in depth: the bridge must never write to Civil 3D.
      throw new PluginError(`civil3d: method '${method}' is not on the bridge's read-only allow-list`, "civil3d", "BRIDGE.FORBIDDEN", null, method);
    }
    const response = await sendJsonRpc("civil3d", this.opts, method, params);
    return unwrapCivil3D<T>(response, method);
  }
}

export function unwrapCivil3D<T>(response: { jsonrpc?: string; result?: unknown; error?: any }, method: string): T {
  const hasResult = Object.prototype.hasOwnProperty.call(response, "result");
  const hasError = Object.prototype.hasOwnProperty.call(response, "error") && response.error != null;
  if (hasError) {
    const e = response.error;
    const domain = typeof e?.data?.code === "string" ? e.data.code : "CIVIL3D.UNKNOWN_ERROR";
    throw new PluginError(
      `civil3d: ${typeof e?.message === "string" ? e.message : "unknown error"}`,
      "civil3d",
      domain,
      typeof e?.code === "number" ? e.code : null,
      method,
    );
  }
  if (!hasResult) {
    throw new PluginError(`civil3d: response to '${method}' has neither result nor error`, "civil3d", "BRIDGE.BAD_RESPONSE", null, method);
  }
  return response.result as T;
}
