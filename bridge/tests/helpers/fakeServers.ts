/**
 * Real TCP servers on ephemeral loopback ports that mimic each plugin's
 * framing, for testing the socket clients.
 */

import * as net from "node:net";

export interface FakeServer {
  port: number;
  requests: any[];
  close(): Promise<void>;
}

export type Reply =
  | { kind: "json"; body: unknown }
  /** Raw bytes, optionally split into chunks with a delay between them. */
  | { kind: "raw"; chunks: string[]; delayMs?: number; end?: boolean }
  | { kind: "hang" }
  | { kind: "close" };

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as net.AddressInfo).port;
}

function closer(server: net.Server, sockets: Set<net.Socket>) {
  return () =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
}

async function sendReply(socket: net.Socket, reply: Reply, newline: boolean) {
  switch (reply.kind) {
    case "json":
      socket.write(JSON.stringify(reply.body) + (newline ? "\n" : ""));
      if (!newline) socket.end();
      return;
    case "raw":
      for (const c of reply.chunks) {
        socket.write(c);
        if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
      }
      if (reply.end) socket.end();
      return;
    case "hang":
      return;
    case "close":
      socket.destroy();
      return;
  }
}

/**
 * Civil 3D style: read until the accumulated bytes parse as one JSON object,
 * reply once, close. Records whether the client half-closed early.
 */
export async function startFakeCivil(handler: (req: any) => Reply): Promise<FakeServer & { halfClosedEarly: boolean }> {
  const requests: any[] = [];
  const sockets = new Set<net.Socket>();
  const state = { halfClosedEarly: false };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buf = "";
    let answered = false;
    socket.on("end", () => {
      if (!answered) state.halfClosedEarly = true;
    });
    socket.on("data", (d) => {
      if (answered) return;
      buf += d.toString("utf8");
      let req: any;
      try {
        req = JSON.parse(buf);
      } catch {
        return;
      }
      answered = true;
      requests.push(req);
      void sendReply(socket, handler(req), false);
    });
  });
  const port = await listen(server);
  return {
    port,
    requests,
    get halfClosedEarly() {
      return state.halfClosedEarly;
    },
    close: closer(server, sockets),
  };
}

/** Revit style: newline-delimited JSON requests and responses. */
export async function startFakeRevit(handler: (req: any) => Reply): Promise<FakeServer> {
  const requests: any[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const req = JSON.parse(line);
        requests.push(req);
        void sendReply(socket, handler(req), true);
      }
    });
  });
  const port = await listen(server);
  return { port, requests, close: closer(server, sockets) };
}

/** A port with nothing listening (bind, read the port, close). */
export async function closedPort(): Promise<number> {
  const s = net.createServer();
  const port = await listen(s);
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
