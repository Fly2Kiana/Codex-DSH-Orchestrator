import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

/** Synthetic official Gateway boundary. No provider or real credentials. */
export async function startMockGatewayHost() {
  let cookie = "";
  const requests: Array<{ method: string; rpcId: string; args: Record<string, any> }> = [];
  const handlers = new Map<string, (args: Record<string, any>) => unknown>();
  const streams: Array<{ socket: WebSocket; streamId: string; endpoint: string; args: Record<string, any> }> = [];
  const server = createServer(async (req, res) => {
    if (req.url === "/connect?token=fixture&interactions=answer") {
      res.writeHead(302, { location: "./api/remote.mux", "set-cookie": `${cookie}; Path=/; HttpOnly; SameSite=Strict` }).end();
      return;
    }
    if (req.headers.cookie !== cookie) { res.writeHead(401).end(); return; }
    let text = "";
    for await (const part of req) text += part;
    const body = JSON.parse(text);
    requests.push({ method: body.method, rpcId: body.rpcId, args: body.payload.args });
    const handler = handlers.get(body.method);
    const result = handler === undefined
      ? { ok: false, error: { code: "test/unexpected-endpoint", message: "unexpected endpoint", details: {} } }
      : { ok: true, value: handler(body.payload.args) };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ type: "server-response", rpcId: body.rpcId, result }));
  });
  const sockets = new WebSocketServer({ server, path: "/api/remote.mux" });
  const send = (stream: (typeof streams)[number], value: unknown) => stream.socket.send(JSON.stringify({ type: "item", streamId: stream.streamId, value }));
  let streamHandler: ((stream: (typeof streams)[number]) => void) | undefined;
  sockets.on("connection", (socket) => {
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type !== "open") return;
      const stream = { socket, streamId: frame.streamId, endpoint: frame.endpoint, args: frame.payload.args };
      streams.push(stream);
      if (frame.endpoint === "$events") send(stream, { type: "ready", clientId: "fixture-client", host: { home: "/fixture" } });
      else streamHandler?.(stream);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fixture did not listen");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  cookie = `dsh-auth-${createHash("sha256").update(new URL(baseUrl).host).digest("base64url")}=v2.fixture.signature`;
  return { baseUrl, requests, streams, send,
    handle: (method: string, handler: (args: Record<string, any>) => unknown) => { handlers.set(method, handler); },
    onStream: (handler: NonNullable<typeof streamHandler>) => { streamHandler = handler; },
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
