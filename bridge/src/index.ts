#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Civil3DClient } from "./clients/civil3d.js";
import { RevitClient } from "./clients/revit.js";
import { PreviewStore } from "./core/previewStore.js";
import { registerTools } from "./tools/register.js";
import { VERSION } from "./version.js";

function log(message: string): void {
  // stdout carries the MCP protocol; diagnostics go to stderr.
  process.stderr.write(`[civil3d-revit-bridge] ${message}\n`);
}

async function main(): Promise<void> {
  const server = new McpServer({ name: "civil3d-revit-bridge", version: VERSION });
  registerTools(server, {
    civil: new Civil3DClient(),
    revit: new RevitClient(),
    previews: new PreviewStore(),
  });
  await server.connect(new StdioServerTransport());
  log(`v${VERSION} started (stdio)`);

  const shutdown = async (signal: string) => {
    log(`shutting down (${signal})`);
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
