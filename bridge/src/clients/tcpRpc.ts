/**
 * Minimal one-request-per-connection JSON-RPC 2.0 over TCP.
 *
 * Two framings are supported because the two Autodesk plugins differ:
 *   - "json":   Civil 3D plugin (RpcTcpServer.cs). The request is a bare JSON
 *               object (no delimiter); the server parses as soon as the bytes
 *               form a complete JSON document, answers once, and closes. The
 *               client must NOT half-close its side while waiting: the plugin
 *               treats a FIN as "client went away" and cancels the request.
 *   - "ndjson": Revit plugin (SocketService.cs). Newline-delimited JSON in both
 *               directions; the connection could carry more requests but the
 *               bridge uses one per connection for isolation.
 */

import * as net from "node:net";
import { randomUUID } from "node:crypto";

export type Framing = "json" | "ndjson";
export type AppName = "civil3d" | "revit";

export interface TcpRpcOptions {
  host: string;
  port: number;
  framing: Framing;
  connectTimeoutMs: number;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface JsonRpcResponse {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** Error raised for anything that goes wrong talking to a plugin. */
export class PluginError extends Error {
  constructor(
    message: string,
    public readonly app: AppName,
    /** Domain code, e.g. CIVIL3D.METHOD_NOT_FOUND, REVIT.RPC_ERROR, BRIDGE.CONNECT_FAILED */
    public readonly code: string,
    public readonly rpcCode: number | null = null,
    public readonly method: string | null = null,
  ) {
    super(message);
    this.name = "PluginError";
  }

  /** True when the plugin is reachable but does not implement the method. */
  get isMethodNotFound(): boolean {
    return (
      this.rpcCode === -32601 ||
      this.code.endsWith("METHOD_NOT_FOUND") ||
      /method '.*' (was )?not (found|implemented)/i.test(this.message)
    );
  }

  /** True when the plugin could not be reached at all. */
  get isUnreachable(): boolean {
    return this.code === "BRIDGE.CONNECT_FAILED" || this.code === "BRIDGE.CONNECT_TIMEOUT";
  }
}

export function newRequestId(): string {
  return randomUUID();
}

export function sendJsonRpc(
  app: AppName,
  opts: TcpRpcOptions,
  method: string,
  params: unknown,
  id: string = newRequestId(),
): Promise<JsonRpcResponse> {
  return new Promise<JsonRpcResponse>((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = "";
    let settled = false;
    let connected = false;

    const finish = (err: Error | null, value?: JsonRpcResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(commandTimer);
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.destroy();
      if (err) reject(err);
      else resolve(value!);
    };

    const tryParse = (text: string): JsonRpcResponse | undefined => {
      try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new PluginError(`${app}: response is not a JSON object`, app, "BRIDGE.BAD_RESPONSE", null, method);
        }
        return parsed as JsonRpcResponse;
      } catch (e) {
        if (e instanceof PluginError) throw e;
        return undefined;
      }
    };

    const onPayload = (text: string) => {
      const parsed = tryParse(text);
      if (!parsed) return false;
      if (parsed.id !== undefined && parsed.id !== null && parsed.id !== id) {
        finish(new PluginError(`${app}: response id '${String(parsed.id)}' does not match request id '${id}'`, app, "BRIDGE.BAD_RESPONSE", null, method));
        return true;
      }
      finish(null, parsed);
      return true;
    };

    const connectTimer = setTimeout(() => {
      if (!connected) {
        finish(new PluginError(
          `${app}: connection to ${opts.host}:${opts.port} timed out after ${opts.connectTimeoutMs} ms`,
          app,
          "BRIDGE.CONNECT_TIMEOUT",
          null,
          method,
        ));
      }
    }, opts.connectTimeoutMs);

    let commandTimer: NodeJS.Timeout | undefined;

    socket.on("connect", () => {
      connected = true;
      clearTimeout(connectTimer);
      commandTimer = setTimeout(() => {
        finish(new PluginError(`${app}: '${method}' timed out after ${opts.timeoutMs} ms`, app, "BRIDGE.TIMEOUT", null, method));
      }, opts.timeoutMs);
      const body = JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {}, id });
      socket.write(opts.framing === "ndjson" ? body + "\n" : body);
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > opts.maxResponseBytes) {
        finish(new PluginError(`${app}: response to '${method}' exceeds ${opts.maxResponseBytes} bytes`, app, "BRIDGE.RESPONSE_TOO_LARGE", null, method));
        return;
      }
      try {
        if (opts.framing === "ndjson") {
          let nl: number;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line.length === 0) continue;
            if (onPayload(line)) return;
          }
        } else {
          onPayload(buffer);
        }
      } catch (e) {
        finish(e as Error);
      }
    });

    socket.on("end", () => {
      // Peer closed: accept a final unterminated payload, else fail.
      try {
        const trimmed = buffer.trim();
        if (trimmed.length > 0 && onPayload(trimmed)) return;
      } catch (e) {
        finish(e as Error);
        return;
      }
      finish(new PluginError(`${app}: connection closed before a complete response to '${method}' arrived`, app, "BRIDGE.CONNECTION_CLOSED", null, method));
    });

    socket.on("close", () => {
      finish(new PluginError(`${app}: connection closed before a complete response to '${method}' arrived`, app, "BRIDGE.CONNECTION_CLOSED", null, method));
    });

    socket.on("error", (err: Error) => {
      if (!connected) {
        finish(new PluginError(
          `${app}: cannot connect to plugin at ${opts.host}:${opts.port} (${err.message}). Is the application running with the MCP plugin loaded?`,
          app,
          "BRIDGE.CONNECT_FAILED",
          null,
          method,
        ));
      } else {
        finish(new PluginError(`${app}: socket error during '${method}': ${err.message}`, app, "BRIDGE.SOCKET_ERROR", null, method));
      }
    });

    socket.connect(opts.port, opts.host);
  });
}
