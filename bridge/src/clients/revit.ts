/**
 * Client for the Revit MCP plugin (revit-mcp-server repo, RevitMCPSDK host).
 *
 * Wire: newline-delimited JSON-RPC 2.0 on 127.0.0.1, port 8080 sliding to
 * 8081-8089 when taken. The plugin writes the port it actually bound to
 * %APPDATA%\Autodesk\Revit\Addins\<year>\revit_mcp_plugin\mcp-port.txt
 * (plugin/Core/SocketService.cs WritePortFile). Method names on the wire are
 * the same snake_case names as the MCP tools (e.g. "create_level").
 *
 * Successful results are usually an AIResult envelope serialised by
 * Newtonsoft with PascalCase keys: { Success, Message, Response }. Both
 * casings are unwrapped; a Success:false envelope becomes a PluginError.
 * All lengths on the wire are millimetres.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PluginError, sendJsonRpc, type TcpRpcOptions } from "./tcpRpc.js";

export const REVIT_PORT_MIN = 8080;
export const REVIT_PORT_MAX = 8089;

export const REVIT_METHODS_USED = {
  existing: ["get_project_info"],
  /** Being added to the Revit plugin by a parallel change; designed against its contract. */
  pending: [
    "get_project_location",
    "set_shared_coordinates",
    "create_toposolid",
    "get_toposolids",
    "create_pipe",
    "get_mep_systems",
  ],
} as const;

export interface PortDiscovery {
  port: number;
  source: "env" | "portFile" | "default";
  portFile: string | null;
  candidates: Array<{ file: string; port: number | null; modified: string | null; valid: boolean }>;
}

export interface PortDiscoveryDeps {
  env?: NodeJS.ProcessEnv;
  appData?: string;
  readdir?: (p: string) => string[];
  readFile?: (p: string) => string;
  mtimeMs?: (p: string) => number;
  exists?: (p: string) => boolean;
}

function isValidPort(n: number): boolean {
  return Number.isInteger(n) && n >= REVIT_PORT_MIN && n <= REVIT_PORT_MAX;
}

/**
 * Find the Revit plugin port: REVIT_MCP_PORT env override, else the most
 * recently written valid mcp-port.txt across all Revit year folders, else 8080.
 * (The upstream Node server scans years newest-first; picking the newest file
 * instead handles several installed Revit versions where only one is running.)
 */
export function discoverRevitPort(deps: PortDiscoveryDeps = {}): PortDiscovery {
  const env = deps.env ?? process.env;
  const readdir = deps.readdir ?? ((p: string) => fs.readdirSync(p));
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
  const mtimeMs = deps.mtimeMs ?? ((p: string) => fs.statSync(p).mtimeMs);
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));

  const override = env.REVIT_MCP_PORT ?? env.REVIT_PORT;
  if (override !== undefined && override !== "") {
    const port = parseInt(override, 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`REVIT_MCP_PORT='${override}' is not a valid TCP port`);
    }
    return { port, source: "env", portFile: null, candidates: [] };
  }

  const appData = deps.appData ?? env.APPDATA ?? "";
  const candidates: PortDiscovery["candidates"] = [];
  const addinsRoot = path.join(appData, "Autodesk", "Revit", "Addins");
  let years: string[] = [];
  try {
    if (appData && exists(addinsRoot)) years = readdir(addinsRoot).filter((y) => /^\d{4}$/.test(y));
  } catch {
    years = [];
  }

  let best: { file: string; port: number; mtime: number } | null = null;
  for (const year of years) {
    const file = path.join(addinsRoot, year, "revit_mcp_plugin", "mcp-port.txt");
    if (!exists(file)) continue;
    let port: number | null = null;
    let mtime: number | null = null;
    try {
      port = parseInt(readFile(file).trim(), 10);
      mtime = mtimeMs(file);
    } catch {
      port = null;
    }
    const valid = port !== null && isValidPort(port);
    candidates.push({ file, port: Number.isNaN(port as number) ? null : port, modified: mtime !== null ? new Date(mtime).toISOString() : null, valid });
    if (valid && mtime !== null && (!best || mtime > best.mtime)) best = { file, port: port!, mtime };
  }

  if (best) return { port: best.port, source: "portFile", portFile: best.file, candidates };
  return { port: REVIT_PORT_MIN, source: "default", portFile: null, candidates };
}

export interface RevitClientOptions {
  host?: string;
  /** Fixed port; if omitted the port is discovered on every call. */
  port?: number;
  discover?: () => PortDiscovery;
  connectTimeoutMs?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface RevitApi {
  call<T = any>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  describeEndpoint(): { host: string; port: number; discovery: PortDiscovery | null };
}

export class RevitClient implements RevitApi {
  private readonly host: string;
  private readonly fixedPort: number | undefined;
  private readonly discover: () => PortDiscovery;
  private readonly connectTimeoutMs: number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  /** The Revit plugin marshals every command onto Revit's UI thread; serialise. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: RevitClientOptions = {}) {
    this.host = options.host ?? process.env.REVIT_HOST ?? "127.0.0.1";
    this.fixedPort = options.port;
    this.discover = options.discover ?? (() => discoverRevitPort());
    this.connectTimeoutMs = options.connectTimeoutMs ?? parseInt(process.env.REVIT_CONNECT_TIMEOUT ?? "5000", 10);
    this.timeoutMs = options.timeoutMs ?? parseInt(process.env.REVIT_COMMAND_TIMEOUT ?? "120000", 10);
    this.maxResponseBytes = options.maxResponseBytes ?? 33_554_432;
  }

  describeEndpoint(): { host: string; port: number; discovery: PortDiscovery | null } {
    if (this.fixedPort !== undefined) return { host: this.host, port: this.fixedPort, discovery: null };
    const discovery = this.discover();
    return { host: this.host, port: discovery.port, discovery };
  }

  call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const run = async () => {
      const { port } = this.describeEndpoint();
      const opts: TcpRpcOptions = {
        host: this.host,
        port,
        framing: "ndjson",
        connectTimeoutMs: this.connectTimeoutMs,
        timeoutMs: timeoutMs ?? this.timeoutMs,
        maxResponseBytes: this.maxResponseBytes,
      };
      const response = await sendJsonRpc("revit", opts, method, params);
      return unwrapRevit<T>(response, method);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(obj, k)) return obj[k];
  return undefined;
}

export function unwrapRevit<T>(response: { result?: unknown; error?: any }, method: string): T {
  if (response.error != null) {
    const e = response.error;
    const rpcCode = typeof e?.code === "number" ? e.code : null;
    throw new PluginError(
      `revit: ${typeof e?.message === "string" ? e.message : "unknown error"}`,
      "revit",
      rpcCode === -32601 ? "REVIT.METHOD_NOT_FOUND" : "REVIT.RPC_ERROR",
      rpcCode,
      method,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(response, "result")) {
    throw new PluginError(`revit: response to '${method}' has neither result nor error`, "revit", "BRIDGE.BAD_RESPONSE", null, method);
  }
  const result = response.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    const success = pick(r, "Success", "success");
    if (typeof success === "boolean" && (pick(r, "Response", "response", "Message", "message") !== undefined)) {
      if (!success) {
        const msg = pick(r, "Message", "message");
        throw new PluginError(`revit: ${typeof msg === "string" && msg ? msg : `${method} reported failure`}`, "revit", "REVIT.COMMAND_FAILED", null, method);
      }
      const inner = pick(r, "Response", "response", "Data", "data");
      return (inner === undefined ? r : inner) as T;
    }
  }
  return result as T;
}
