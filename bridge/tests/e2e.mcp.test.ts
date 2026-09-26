/**
 * End to end: MCP client -> McpServer (in-memory transport) -> real
 * Civil3DClient/RevitClient -> loopback TCP fakes that speak each plugin's
 * framing and dispatch to the in-memory fakes' handlers.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Civil3DClient } from "../src/clients/civil3d.js";
import { RevitClient } from "../src/clients/revit.js";
import { PreviewStore } from "../src/core/previewStore.js";
import { registerTools, TOOL_NAMES } from "../src/tools/register.js";
import { FakeCivil, FakeRevit } from "./helpers/fakes.js";
import { startFakeCivil, startFakeRevit, type FakeServer } from "./helpers/fakeServers.js";

const fakeCivil = new FakeCivil();
const fakeRevit = new FakeRevit();
let civilServer: FakeServer;
let revitServer: FakeServer;
let client: Client;

function rpcReply(id: string, run: () => unknown, civilStyle: boolean) {
  try {
    return { jsonrpc: "2.0", id, result: run() };
  } catch (e: any) {
    const notFound = /not (found|implemented)/i.test(e.message);
    return {
      jsonrpc: "2.0",
      id,
      error: civilStyle
        ? { code: notFound ? -32601 : -32000, message: e.message, data: { code: notFound ? "CIVIL3D.METHOD_NOT_FOUND" : "CIVIL3D.API_ERROR" } }
        : { code: notFound ? -32601 : -32603, message: e.message },
    };
  }
}

beforeAll(async () => {
  civilServer = await startFakeCivil((req) => ({
    kind: "json",
    body: rpcReply(req.id, () => {
      const h = fakeCivil.handlers[req.method];
      if (!h) throw new Error(`Plugin method '${req.method}' is not implemented yet.`);
      fakeCivil.calls.push({ method: req.method, params: req.params });
      return h(req.params);
    }, true),
  }));
  revitServer = await startFakeRevit((req) => ({
    kind: "json",
    body: rpcReply(req.id, () => {
      const h = fakeRevit.handlers[req.method];
      if (!h) throw new Error(`Method '${req.method}' not found`);
      fakeRevit.calls.push({ method: req.method, params: req.params });
      return h(req.params);
    }, false),
  }));

  const server = new McpServer({ name: "civil3d-revit-bridge", version: "test" });
  registerTools(server, {
    civil: new Civil3DClient({ port: civilServer.port }),
    revit: new RevitClient({ port: revitServer.port }),
    previews: new PreviewStore(),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  client = new Client({ name: "e2e", version: "1" });
  await client.connect(b);
});

afterAll(async () => {
  await client?.close();
  await civilServer?.close();
  await revitServer?.close();
});

function parse(result: any): any {
  return JSON.parse(result.content[0].text);
}

describe("MCP end to end", () => {
  it("lists exactly the five bridge tools with read-only hints where appropriate", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.bridge_status.annotations?.readOnlyHint).toBe(true);
    expect(byName.bridge_check_consistency.annotations?.readOnlyHint).toBe(true);
    expect(byName.bridge_align_coordinates.annotations?.readOnlyHint).toBe(false);
    expect(byName.bridge_align_coordinates.inputSchema.properties).toHaveProperty("civil3dPoint");
  });

  it("bridge_status over real sockets", async () => {
    const r = parse(await client.callTool({ name: "bridge_status", arguments: {} }));
    expect(r.ok).toBe(true);
    expect(r.civil3d.units.unit).toBe("feet");
    expect(r.civil3d.pendingCommands.getSurfaceTinVertices).toBe("missing");
    expect(r.revit.endpoint).toBe(`127.0.0.1:${revitServer.port}`);
  });

  it("align: preview -> apply -> toposolid preview -> apply, over MCP", async () => {
    const alignArgs = { civil3dPoint: { pointNumber: 1 } };
    const p = parse(await client.callTool({ name: "bridge_align_coordinates", arguments: alignArgs }));
    expect(p.mode).toBe("preview");
    const a = parse(await client.callTool({ name: "bridge_align_coordinates", arguments: { ...alignArgs, apply: true, previewId: p.previewId } }));
    expect(a.verification.pass).toBe(true);

    const topoArgs = {
      surfaceName: "FG",
      maxPoints: 80,
      boundary: { coordinateSystem: "revitInternal", points: [{ x: -6000, y: -6000 }, { x: 6000, y: -6000 }, { x: 6000, y: 6000 }, { x: -6000, y: 6000 }] },
    };
    const tp = parse(await client.callTool({ name: "bridge_surface_to_toposolid", arguments: topoArgs }));
    expect(tp.blocking).toEqual([]);
    const ta = parse(await client.callTool({ name: "bridge_surface_to_toposolid", arguments: { ...topoArgs, apply: true, previewId: tp.previewId } }));
    expect(ta.wroteToRevit).toBe(true);
    expect(fakeRevit.state.toposolids).toHaveLength(1);
  });

  it("apply without preview is an MCP error result, not a write", async () => {
    const before = fakeRevit.writes().length;
    const r: any = await client.callTool({ name: "bridge_align_coordinates", arguments: { civil3dPoint: { pointNumber: 2 }, apply: true } });
    expect(r.isError).toBe(true);
    expect(parse(r).error).toMatch(/requires previewId/);
    expect(fakeRevit.writes().length).toBe(before);
  });

  it("invalid arguments are rejected by schema validation", async () => {
    const r: any = await client.callTool({ name: "bridge_surface_to_toposolid", arguments: { surfaceName: "FG", maxPoints: 1 } });
    expect(r.isError).toBe(true);
  });

  it("Civil 3D is only ever read", () => {
    const writes = fakeCivil.calls.filter((c) => /^(create|delete|add|set|save|import|edit|update|resize|assign|connect)/.test(c.method));
    expect(writes).toEqual([]);
  });
});
