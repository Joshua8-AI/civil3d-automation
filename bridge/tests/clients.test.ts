import { afterEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import { Civil3DClient } from "../src/clients/civil3d.js";
import { discoverRevitPort, RevitClient, unwrapRevit } from "../src/clients/revit.js";
import { PluginError } from "../src/clients/tcpRpc.js";
import { closedPort, startFakeCivil, startFakeRevit, type FakeServer } from "./helpers/fakeServers.js";

const servers: FakeServer[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

async function catchErr(p: Promise<unknown>): Promise<PluginError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(PluginError);
    return e as PluginError;
  }
  throw new Error("expected rejection");
}

describe("Civil3DClient over TCP (bare JSON framing)", () => {
  it("sends one JSON-RPC 2.0 request and returns result", async () => {
    const s = await startFakeCivil((req) => ({ kind: "json", body: { jsonrpc: "2.0", id: req.id, result: { drawingLoaded: true } } }));
    servers.push(s);
    const c = new Civil3DClient({ port: s.port });
    await expect(c.call("getCivil3DHealth")).resolves.toEqual({ drawingLoaded: true });
    expect(s.requests[0]).toMatchObject({ jsonrpc: "2.0", method: "getCivil3DHealth", params: {} });
    expect(typeof s.requests[0].id).toBe("string");
  });

  it("does not half-close before the response (plugin would cancel the request)", async () => {
    const s = await startFakeCivil((req) => ({
      kind: "raw",
      chunks: [JSON.stringify({ jsonrpc: "2.0", id: req.id, result: 1 })],
      delayMs: 50,
      end: true,
    }));
    servers.push(s);
    await new Civil3DClient({ port: s.port }).call("getDrawingInfo");
    expect(s.halfClosedEarly).toBe(false);
  });

  it("reassembles a response split across many chunks", async () => {
    const big = { samples: Array.from({ length: 3000 }, (_, i) => ({ x: i, y: i * 2, elevation: i / 3 })) };
    const s = await startFakeCivil((req) => {
      const text = JSON.stringify({ jsonrpc: "2.0", id: req.id, result: big });
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += 997) chunks.push(text.slice(i, i + 997));
      return { kind: "raw", chunks, delayMs: 1, end: true };
    });
    servers.push(s);
    const r = await new Civil3DClient({ port: s.port }).call("sampleSurfaceElevations", { name: "EG", method: "points", points: [] });
    expect(r).toEqual(big);
  });

  it("maps a plugin error envelope to PluginError with the domain code", async () => {
    const s = await startFakeCivil((req) => ({
      kind: "json",
      body: { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Plugin method 'getSurfaceTinVertices' is not implemented yet.", data: { code: "CIVIL3D.METHOD_NOT_FOUND" } } },
    }));
    servers.push(s);
    const e = await catchErr(new Civil3DClient({ port: s.port }).call("getSurfaceTinVertices", { name: "EG" }));
    expect(e.code).toBe("CIVIL3D.METHOD_NOT_FOUND");
    expect(e.rpcCode).toBe(-32601);
    expect(e.isMethodNotFound).toBe(true);
  });

  it("rejects a mismatched response id", async () => {
    const s = await startFakeCivil(() => ({ kind: "json", body: { jsonrpc: "2.0", id: "someone-else", result: 1 } }));
    servers.push(s);
    const e = await catchErr(new Civil3DClient({ port: s.port }).call("getDrawingInfo"));
    expect(e.code).toBe("BRIDGE.BAD_RESPONSE");
  });

  it("times out a hung command", async () => {
    const s = await startFakeCivil(() => ({ kind: "hang" }));
    servers.push(s);
    const e = await catchErr(new Civil3DClient({ port: s.port, timeoutMs: 150 }).call("getDrawingInfo"));
    expect(e.code).toBe("BRIDGE.TIMEOUT");
  });

  it("reports an unreachable plugin distinctly", async () => {
    const port = await closedPort();
    const e = await catchErr(new Civil3DClient({ port, connectTimeoutMs: 1000 }).call("getDrawingInfo"));
    expect(e.code).toBe("BRIDGE.CONNECT_FAILED");
    expect(e.isUnreachable).toBe(true);
  });

  it("fails cleanly when the server closes without answering", async () => {
    const s = await startFakeCivil(() => ({ kind: "close" }));
    servers.push(s);
    const e = await catchErr(new Civil3DClient({ port: s.port }).call("getDrawingInfo"));
    expect(e.code).toBe("BRIDGE.CONNECTION_CLOSED");
  });

  it("enforces a response size cap", async () => {
    const s = await startFakeCivil((req) => ({ kind: "json", body: { jsonrpc: "2.0", id: req.id, result: "x".repeat(5000) } }));
    servers.push(s);
    const e = await catchErr(new Civil3DClient({ port: s.port, maxResponseBytes: 1000 }).call("getDrawingInfo"));
    expect(e.code).toBe("BRIDGE.RESPONSE_TOO_LARGE");
  });

  it("refuses any Civil 3D method that is not on the read-only allow-list, without connecting", async () => {
    const s = await startFakeCivil((req) => ({ kind: "json", body: { jsonrpc: "2.0", id: req.id, result: {} } }));
    servers.push(s);
    const c = new Civil3DClient({ port: s.port });
    for (const m of ["createCogoPoints", "deleteSurface", "saveDrawing", "createPipeNetwork"]) {
      const e = await catchErr(c.call(m));
      expect(e.code).toBe("BRIDGE.FORBIDDEN");
    }
    expect(s.requests).toHaveLength(0);
  });
});

describe("RevitClient over TCP (newline-delimited framing)", () => {
  it("sends a newline-terminated request and unwraps the AIResult envelope", async () => {
    const s = await startFakeRevit((req) => ({
      kind: "json",
      body: { jsonrpc: "2.0", id: req.id, result: { Success: true, Message: "ok", Response: { levels: [{ name: "L1", elevation: 0 }] } } },
    }));
    servers.push(s);
    const c = new RevitClient({ port: s.port });
    await expect(c.call("get_project_info", { includeLevels: true })).resolves.toEqual({ levels: [{ name: "L1", elevation: 0 }] });
    expect(s.requests[0]).toMatchObject({ jsonrpc: "2.0", method: "get_project_info", params: { includeLevels: true } });
  });

  it("handles a response line split across chunks, ignoring blank lines", async () => {
    const s = await startFakeRevit((req) => {
      const text = JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { value: 42 } });
      return { kind: "raw", chunks: ["\n", text.slice(0, 10), text.slice(10), "\n"], delayMs: 5 };
    });
    servers.push(s);
    await expect(new RevitClient({ port: s.port }).call("get_toposolids")).resolves.toEqual({ value: 42 });
  });

  it("turns Success:false into a PluginError", async () => {
    const s = await startFakeRevit((req) => ({ kind: "json", body: { jsonrpc: "2.0", id: req.id, result: { Success: false, Message: "No active document", Response: null } } }));
    servers.push(s);
    const e = await catchErr(new RevitClient({ port: s.port }).call("get_project_info"));
    expect(e.code).toBe("REVIT.COMMAND_FAILED");
    expect(e.message).toMatch(/No active document/);
  });

  it("recognises Method not found", async () => {
    const s = await startFakeRevit((req) => ({ kind: "json", body: { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method 'get_project_location' not found" } } }));
    servers.push(s);
    const e = await catchErr(new RevitClient({ port: s.port }).call("get_project_location"));
    expect(e.isMethodNotFound).toBe(true);
  });

  it("times out and serialises concurrent calls", async () => {
    const arrivals: number[] = [];
    const s = await startFakeRevit((req) => {
      arrivals.push(Date.now());
      // Reply ~40 ms after the request arrives.
      return { kind: "raw", chunks: ["", JSON.stringify({ jsonrpc: "2.0", id: req.id, result: req.params.n }) + "\n"], delayMs: 40 };
    });
    servers.push(s);
    const c = new RevitClient({ port: s.port });
    const results = await Promise.all([1, 2, 3].map((n) => c.call("get_toposolids", { n })));
    expect(results).toEqual([1, 2, 3]);
    // Each request is sent only after the previous reply: no overlap on Revit's UI thread.
    expect(arrivals[1] - arrivals[0]).toBeGreaterThanOrEqual(35);
    expect(arrivals[2] - arrivals[1]).toBeGreaterThanOrEqual(35);

    const hang = await startFakeRevit(() => ({ kind: "hang" }));
    servers.push(hang);
    const e = await catchErr(new RevitClient({ port: hang.port, timeoutMs: 120 }).call("get_toposolids"));
    expect(e.code).toBe("BRIDGE.TIMEOUT");
    // The queue survives a failure.
    await expect(c.call("get_toposolids", { n: 9 })).resolves.toBe(9);
  });

  it("uses the discovered port on every call", async () => {
    const s = await startFakeRevit((req) => ({ kind: "json", body: { jsonrpc: "2.0", id: req.id, result: "hi" } }));
    servers.push(s);
    const c = new RevitClient({ discover: () => ({ port: s.port, source: "portFile", portFile: "x", candidates: [] }) });
    await expect(c.call("get_mep_systems")).resolves.toBe("hi");
    expect(c.describeEndpoint().port).toBe(s.port);
  });
});

describe("unwrapRevit", () => {
  it("passes through non-envelope results", () => {
    expect(unwrapRevit({ result: [1, 2] }, "m")).toEqual([1, 2]);
    expect(unwrapRevit({ result: { a: 1 } }, "m")).toEqual({ a: 1 });
  });
  it("unwraps camelCase envelopes too", () => {
    expect(unwrapRevit({ result: { success: true, message: "", response: { z: 1 } } }, "m")).toEqual({ z: 1 });
  });
});

describe("discoverRevitPort", () => {
  const root = path.join("C:", "AppData", "Autodesk", "Revit", "Addins");
  const fsFake = (files: Record<string, { text: string; mtime: number }>) => ({
    appData: path.join("C:", "AppData"),
    env: {} as NodeJS.ProcessEnv,
    exists: (p: string) => p === root || p in files,
    readdir: () => ["2025", "2026", "2027", "notayear"],
    readFile: (p: string) => files[p].text,
    mtimeMs: (p: string) => files[p].mtime,
  });
  const f = (year: string) => path.join(root, year, "revit_mcp_plugin", "mcp-port.txt");

  it("picks the most recently written valid port file", () => {
    const d = discoverRevitPort(fsFake({ [f("2027")]: { text: "8081", mtime: 100 }, [f("2025")]: { text: "8083\n", mtime: 500 } }));
    expect(d).toMatchObject({ port: 8083, source: "portFile", portFile: f("2025") });
    expect(d.candidates).toHaveLength(2);
  });

  it("ignores out-of-range or garbage ports", () => {
    const d = discoverRevitPort(fsFake({ [f("2027")]: { text: "9999", mtime: 900 }, [f("2026")]: { text: "abc", mtime: 950 }, [f("2025")]: { text: "8082", mtime: 1 } }));
    expect(d.port).toBe(8082);
    expect(d.candidates.filter((c) => !c.valid)).toHaveLength(2);
  });

  it("falls back to 8080", () => {
    expect(discoverRevitPort(fsFake({}))).toMatchObject({ port: 8080, source: "default" });
    expect(discoverRevitPort({ env: {}, appData: "" })).toMatchObject({ port: 8080, source: "default" });
  });

  it("honours REVIT_MCP_PORT and validates it", () => {
    expect(discoverRevitPort({ env: { REVIT_MCP_PORT: "8085" } })).toMatchObject({ port: 8085, source: "env" });
    expect(() => discoverRevitPort({ env: { REVIT_MCP_PORT: "nope" } })).toThrow();
  });
});
