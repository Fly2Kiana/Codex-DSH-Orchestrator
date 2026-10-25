import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { z } from "zod";

import { GatewayConnection, GatewayConnectionError } from "../src/gateway-connection.js";
import { discoverOfficialDesktopHostEndpoint } from "../src/desktop-host-discovery.js";
import { loadConfig } from "../src/config.js";
import { createHostEndpointResolver } from "../src/host-endpoint.js";

// Contract fixtures: official Harness dsh-v0.2.1-rc.2, Connection + Gateway.
// Synthetic credentials only. No real Host, provider, or credential store is used.
const token = "synthetic-launch-token";

test("Gateway reports sanitized process-query diagnostics before any network request", async () => {
  let networkRequests = 0;
  const client = new GatewayConnection({
    endpoint: { mode: "desktop-auto", resolve: () => discoverOfficialDesktopHostEndpoint({
      platform: "darwin",
      listProcesses: async () => { throw new Error(`private-path ${token} http://127.0.0.1:24001`); },
      listListeners: async () => { assert.fail("listener query must not run"); },
    }) },
    getConnectToken: () => token, timeoutMs: 1_000,
    fetchImpl: async () => { networkRequests++; assert.fail("network must not run"); },
  });
  try {
    await assert.rejects(client.connect(), (error: unknown) => {
      assert.ok(error instanceof GatewayConnectionError);
      assert.equal(error.code, "transport_failure");
      assert.deepEqual(error.diagnostic, { stage: "process-query", reason: "process_query_failed" });
      const rendered = `${error.stack} ${JSON.stringify(error)}`;
      for (const secret of [token, "private-path", "127.0.0.1", "24001"]) assert.equal(rendered.includes(secret), false);
      return true;
    });
    assert.equal(networkRequests, 0);
    assert.equal(client.endpointSnapshot().resolutionEpoch, 0);
  } finally { client.close(); }
});

async function gatewayFixture() {
  let cookie = "";
  const requests: Array<{ path: string; cookie?: string; body?: any }> = [];
  let connectStatus = 302;
  let location = "./api/remote.mux";
  let rpcMode: "ok" | "disconnect" | "mismatch" | "rejected" = "ok";
  let socketStatus = 101;
  let sendReady = true;
  let cookieVersion = "v2";
  let rpcStatus = 200;
  const server = createServer(async (req, res) => {
    const entry = { path: req.url!, ...(req.headers.cookie === undefined ? {} : { cookie: req.headers.cookie }) };
    requests.push(entry);
    if (req.url?.startsWith("/connect?")) {
      res.writeHead(connectStatus, { location, "set-cookie": `${cookie.replace("=v2.", `=${cookieVersion}.`)}; Path=/; HttpOnly; SameSite=Strict` });
      res.end();
      return;
    }
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    Object.assign(entry, { body });
    if (rpcMode === "disconnect") { req.socket.destroy(); return; }
    res.writeHead(rpcStatus, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "server-response", rpcId: rpcMode === "mismatch" ? "wrong" : body.rpcId,
      result: rpcMode === "rejected" ? { ok: false, error: { code: "session/denied", message: token, details: { cookie } } }
        : { ok: true, value: { items: [] } } }));
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (socketStatus !== 101) { socket.end(`HTTP/1.1 ${socketStatus} Rejected\r\nConnection: close\r\n\r\n`); return; }
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws, request));
  });
  const opens: any[] = [];
  sockets.on("connection", (socket, req) => {
    assert.equal(req.headers.cookie, cookie);
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      opens.push(message);
      if (message.type === "open" && message.endpoint === "$events" && sendReady) {
        socket.send(JSON.stringify({ type: "item", streamId: message.streamId,
          value: { type: "ready", clientId: "fixture-peer", host: { home: "/fixture" } } }));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  cookie = `dsh-auth-${createHash("sha256").update(new URL(baseUrl).host).digest("base64url")}=v2.synthetic.signature`;
  const connection = (getConnectToken: () => string | undefined = () => token, timeoutMs = 1_000,
    connectTokenOrigin?: string) => new GatewayConnection({
    endpoint: { mode: "static", configuredBaseUrl: baseUrl,
      resolve: async () => ({ baseUrl, source: "configured" }) },
    getConnectToken,
    timeoutMs,
    ...(connectTokenOrigin === undefined ? {} : { connectTokenOrigin }),
  });
  return { baseUrl, requests, opens, sockets, connection, cookie,
    setConnectStatus: (value: number) => { connectStatus = value; },
    setLocation: (value: string) => { location = value; },
    setRpcMode: (value: typeof rpcMode) => { rpcMode = value; },
    setRpcStatus: (value: number) => { rpcStatus = value; },
    setSocketStatus: (value: number) => { socketStatus = value; },
    setSendReady: (value: boolean) => { sendReady = value; },
    setCookieVersion: (value: string) => { cookieVersion = value; },
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("Gateway authenticates only the authorized OS-owned fixture when official Desktop has two listeners", async () => {
  const intended = await gatewayFixture();
  const other = await gatewayFixture();
  const dependencies = { platform: "darwin" as const,
    listProcesses: async () => [101, 102].map((pid) => ({ pid, name: "DeepSeek Harness",
      executablePath: "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" })),
    listListeners: async () => [other, intended].map((host) => ({ pid: 102, address: "127.0.0.1", port: Number(new URL(host.baseUrl).port) })),
  };
  const config = loadConfig({ DSH_HOST_PROTOCOL: "gateway", DSH_HOST_MODE: "desktop-auto", DSH_CONNECT_ORIGIN: intended.baseUrl });
  const endpoint = createHostEndpointResolver(config, async () => { assert.fail("no legacy probe"); },
    (options) => discoverOfficialDesktopHostEndpoint(dependencies, options));
  const { connectTokenOrigin: _binding, ...unboundConfig } = config;
  const client = new GatewayConnection({ endpoint, getConnectToken: () => token, connectTokenOrigin: config.connectTokenOrigin, timeoutMs: 2_000 });
  const unbound = new GatewayConnection({ endpoint: createHostEndpointResolver(unboundConfig,
    async () => { assert.fail("no legacy probe"); }, (options) => discoverOfficialDesktopHostEndpoint(dependencies, options)),
    getConnectToken: () => token, timeoutMs: 2_000 });
  const unowned = new GatewayConnection({ endpoint: createHostEndpointResolver(config,
    async () => { assert.fail("no legacy probe"); }, (options) => discoverOfficialDesktopHostEndpoint({ ...dependencies,
      listListeners: async () => [{ pid: 999, address: "127.0.0.1", port: Number(new URL(intended.baseUrl).port) },
        { pid: 102, address: "127.0.0.1", port: Number(new URL(other.baseUrl).port) }] }, options)),
    getConnectToken: () => token, connectTokenOrigin: config.connectTokenOrigin, timeoutMs: 2_000 });
  try {
    await assert.rejects(unbound.connect(), { code: "transport_failure",
      diagnostic: { stage: "candidate-selection", reason: "ambiguous_desktop_host" } });
    await assert.rejects(unowned.connect(), { code: "auth_rejected",
      diagnostic: { stage: "origin-binding", reason: "authorized_origin_not_found" } });
    assert.equal(intended.requests.length, 0);
    assert.equal(other.requests.length, 0);
    assert.equal(unbound.endpointSnapshot().resolutionEpoch, 0);
    assert.equal(unowned.endpointSnapshot().resolutionEpoch, 0);

    assert.equal((await client.connect()).clientId, "fixture-peer");
    await client.call("session/list", { _request: {} }, z.object({ items: z.array(z.unknown()) }));
    assert.equal(intended.requests.filter((r) => r.path.startsWith("/connect?")).length, 1);
    assert.equal(intended.sockets.clients.size, 1);
    assert.equal(other.requests.length, 0);
    assert.equal(other.sockets.clients.size, 0);
    assert.equal(client.endpointSnapshot().resolutionEpoch, 1);
    assert.equal(client.endpointSnapshot().source, "macos-process-listener");
  } finally { client.close(); unbound.close(); unowned.close(); await intended.close(); await other.close(); }
});

test("Gateway distinguishes authorization input, origin binding, HTTP and WebSocket failures safely", async () => {
  const host = await gatewayFixture();
  try {
    for (const [code, stage, make] of [
      ["auth_required", "authorization-input", () => host.connection(() => undefined)],
      ["auth_rejected", "origin-binding", () => host.connection(undefined, undefined, "http://127.0.0.1:1")],
      ["auth_rejected", "http-connect", () => { host.setConnectStatus(403); return host.connection(); }],
      ["peer_conflict", "websocket-connect", () => { host.setConnectStatus(302); host.setSocketStatus(409); return host.connection(); }],
    ] as const) {
      const client = make();
      try {
        await assert.rejects(client.connect(), (error: unknown) => {
          assert.ok(error instanceof GatewayConnectionError);
          assert.equal(error.code, code);
          assert.deepEqual(error.diagnostic, { stage, reason: code });
          const safe = JSON.stringify(error);
          for (const secret of [token, host.cookie, "127.0.0.1", new URL(host.baseUrl).port]) assert.equal(safe.includes(secret), false);
          return true;
        });
      } finally { client.close(); }
    }
  } finally { await host.close(); }
});

test("Gateway preserves listener-query failures and sanitizes unknown resolver and HTTP errors", async () => {
  for (const stage of ["listener-query", "discovery", "http-connect"] as const) {
    let requests = 0;
    const privateMessage = `${token} private-path http://127.0.0.1:24001`;
    const client = new GatewayConnection({
      endpoint: { mode: "desktop-auto", resolve: async () => {
        if (stage === "discovery") throw new Error(privateMessage);
        if (stage === "listener-query") return discoverOfficialDesktopHostEndpoint({ platform: "darwin",
          listProcesses: async () => [{ pid: 101, name: "DeepSeek Harness", executablePath: "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" }],
          listListeners: async () => { throw new Error(privateMessage); } });
        return { baseUrl: "http://127.0.0.1:24001", source: "macos-process-listener" };
      } }, getConnectToken: () => token, timeoutMs: 1_000,
      fetchImpl: async () => { requests++; throw new Error(privateMessage); },
    });
    try {
      await assert.rejects(client.connect(), (error: unknown) => {
        assert.ok(error instanceof GatewayConnectionError);
        assert.equal(error.code, "transport_failure");
        assert.deepEqual(error.diagnostic, { stage, reason: stage === "listener-query" ? "listener_query_failed" : "transport_failure" });
        assert.equal(error.cause, undefined);
        for (const value of [token, "private-path", "127.0.0.1", "24001"]) assert.equal(JSON.stringify(error).includes(value), false);
        return true;
      });
      assert.equal(requests, stage === "http-connect" ? 1 : 0);
    } finally { client.close(); }
  }
});

test("Gateway exchanges an explicit token once, owns one API socket, and sends named RPC arguments", async () => {
  const host = await gatewayFixture();
  const client = host.connection();
  const cookie = host.cookie;
  try {
    const [ready, result] = await Promise.all([
      client.connect(), client.call("session/list", { _request: {} }, z.object({ items: z.array(z.unknown()) })),
    ]);
    assert.deepEqual(ready, { clientId: "fixture-peer", host: { home: "/fixture" } });
    assert.deepEqual(result.value, { items: [] });
    assert.equal(host.requests.filter((r) => r.path.startsWith("/connect?")).length, 1);
    const connect = new URL(host.requests[0]!.path, "http://fixture");
    assert.equal(connect.searchParams.get("token"), token);
    assert.equal(connect.searchParams.get("interactions"), "answer");
    assert.equal(host.sockets.clients.size, 1);
    assert.equal(host.opens.filter((item) => item.endpoint === "$events").length, 1);
    const request = host.requests.find((r) => r.path === "/api/session/list")!;
    assert.equal(request.cookie, cookie);
    assert.deepEqual(request.body, { type: "client-request", rpcId: result.rpcId,
      method: "session/list", payload: { args: { _request: {} } } });
    assert.equal(JSON.stringify(client).includes(token), false);
    assert.equal(JSON.stringify(client).includes(cookie), false);
  } finally { client.close(); await host.close(); }
});

test("Gateway validates stream-error detail dictionaries without exposing Host content", { timeout: 5_000 }, async () => {
  for (const [details, expectedCode] of [
    [{ nested: { values: [null, 1, true] }, message: token }, "rpc_rejected"],
    [[token], "unsupported_protocol"],
  ] as const) {
    const host = await gatewayFixture();
    const client = host.connection();
    try {
      await client.connect();
      const socket = [...host.sockets.clients][0]!;
      const opened = once(socket, "message");
      const pending = client.stream("session/follow", { request: {} }, AbortSignal.timeout(2_000)).next();
      const rejected = assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof GatewayConnectionError);
        assert.equal(error.code, expectedCode);
        assert.equal(`${error.stack} ${JSON.stringify(error)}`.includes(token), false);
        return true;
      });
      const [raw] = await opened;
      const { streamId } = JSON.parse(String(raw));
      socket.send(JSON.stringify({ type: "error", streamId,
        error: { code: "fixture/rejected", message: token, details } }));
      await rejected;
      if (expectedCode === "rpc_rejected") {
        assert.deepEqual((await client.call("session/list", {}, z.object({ items: z.array(z.unknown()) }))).value, { items: [] });
      }
      assert.equal(host.requests.filter((item) => item.path.startsWith("/connect?")).length, 1);
    } finally { client.close(); await host.close(); }
  }
});

test("Gateway never sends a startup credential to an origin other than its bound Host", async () => {
  const host = await gatewayFixture();
  const client = host.connection(undefined, undefined, "http://127.0.0.1:1");
  try {
    await assert.rejects(client.connect(), { code: "auth_rejected" });
    assert.equal(host.requests.length, 0);
    assert.equal(host.sockets.clients.size, 0);
  } finally { client.close(); await host.close(); }
});

test("Gateway refuses missing or rejected authorization without a socket or legacy fallback", async () => {
  const host = await gatewayFixture();
  const missing = host.connection(() => undefined);
  const rejected = host.connection();
  try {
    await assert.rejects(missing.connect(), { code: "auth_required" });
    assert.equal(host.requests.length, 0);
    host.setConnectStatus(403);
    await assert.rejects(rejected.connect(), { code: "auth_rejected" });
    assert.equal(host.requests.length, 1);
    assert.equal(host.sockets.clients.size, 0);
  } finally { missing.close(); rejected.close(); await host.close(); }
});

test("Gateway rejects cross-authority and non-mux redirects without forwarding the credential", async () => {
  const host = await gatewayFixture();
  try {
    for (const location of ["https://untrusted.invalid/api/remote.mux", "/api/remote.mux?token=echo", "/api/respond"]) {
      host.setLocation(location);
      const client = host.connection();
      try { await assert.rejects(client.connect(), { code: "unsupported_protocol" }); }
      finally { client.close(); }
    }
    assert.equal(host.requests.length, 3);
    assert.equal(host.sockets.clients.size, 0);
  } finally { await host.close(); }
});

test("Gateway treats missing RPC endpoints as protocol errors rather than reconnectable outages", async () => {
  const host = await gatewayFixture();
  try {
    for (const status of [404, 405]) {
      const client = host.connection();
      try {
        host.setRpcStatus(status);
        await assert.rejects(client.call("session/list", { _request: {} }, z.unknown()), { code: "unsupported_protocol" });
      } finally { client.close(); }
    }
  } finally { await host.close(); }
});

test("Gateway classifies socket authorization denial without exposing credentials or opening another socket", async () => {
  const host = await gatewayFixture();
  const client = host.connection();
  try {
    host.setSocketStatus(401);
    await assert.rejects(client.connect(), { code: "auth_rejected" });
    assert.equal(host.requests.length, 1);
    assert.equal(host.sockets.clients.size, 0);
  } finally { client.close(); await host.close(); }
});

test("Gateway refuses browser cookies and duplicate API Peer socket ownership", async () => {
  const host = await gatewayFixture();
  const browser = host.connection();
  const duplicate = host.connection();
  try {
    host.setCookieVersion("v1");
    await assert.rejects(browser.connect(), { code: "unsupported_protocol" });
    assert.equal(host.sockets.clients.size, 0);
    host.setCookieVersion("v2");
    host.setSocketStatus(409);
    await assert.rejects(duplicate.connect(), { code: "peer_conflict" });
    assert.equal(host.requests.length, 2);
  } finally { browser.close(); duplicate.close(); await host.close(); }
});

test("Gateway bounds the opening handshake and cancellation releases a pending logical stream", async () => {
  const host = await gatewayFixture();
  const timed = host.connection(undefined, 150);
  const client = host.connection();
  const controller = new AbortController();
  try {
    host.setSendReady(false);
    await assert.rejects(timed.connect(), { code: "transport_failure" });
    host.setSendReady(true);
    await client.connect();
    const waiting = client.stream("session/follow", { request: {} }, controller.signal).next();
    controller.abort(new Error(token));
    await assert.rejects(waiting, (error: unknown) => {
      assert.ok(error instanceof GatewayConnectionError);
      assert.equal(error.code, "aborted");
      assert.equal(String(error).includes(token), false);
      return true;
    });
    await client.call("session/list", { _request: {} }, z.unknown());
  } finally { timed.close(); client.close(); await host.close(); }
});

test("Gateway lets a concurrent caller cancel its own connection wait without duplicating the Peer", async () => {
  const host = await gatewayFixture();
  const client = host.connection(undefined, 150);
  const controller = new AbortController();
  try {
    host.setSendReady(false);
    const owner = assert.rejects(client.connect(), { code: "transport_failure" });
    const waiter = client.connect(controller.signal);
    controller.abort();
    await assert.rejects(waiter, { code: "aborted" });
    await owner;
    assert.equal(host.requests.length, 1);
  } finally { client.close(); await host.close(); }
});

test("Gateway disconnect fails observation and shutdown does not create another Peer", async () => {
  const host = await gatewayFixture();
  const client = host.connection();
  const controller = new AbortController();
  try {
    await client.connect();
    const observing = client.events(controller.signal).next();
    [...host.sockets.clients][0]!.terminate();
    await assert.rejects(observing, { code: "transport_failure" });
    client.close();
    await assert.rejects(client.connect(), { code: "aborted" });
    assert.equal(host.requests.length, 1);
  } finally { client.close(); await host.close(); }
});

test("Gateway refuses malformed stream frames and fails bounded observation instead of dropping events", { timeout: 5_000 }, async () => {
  const host = await gatewayFixture();
  try {
    for (const malformed of [true, false]) {
      const client = host.connection();
      const controller = new AbortController();
      try {
        await client.connect();
        const socket = [...host.sockets.clients].find((item) => item.readyState === 1)!;
        const streamId = host.opens.filter((item) => item.endpoint === "$events").at(-1)!.streamId;
        const events = client.events(controller.signal);
        const first = events.next().then((result) => ({ result }), (error: unknown) => ({ error }));
        if (malformed) socket.send(JSON.stringify({ type: "unknown", streamId, private: token }));
        else for (let index = 0; index < 300; index++) {
          socket.send(JSON.stringify({ type: "item", streamId, value: { type: "emit", event: "synthetic", args: [] } }));
        }
        await once(socket, "close");
        const outcome = await first;
        const expected = malformed ? "unsupported_protocol" : "buffer_overflow";
        if ("error" in outcome) {
          assert.ok(outcome.error instanceof GatewayConnectionError);
          assert.equal(outcome.error.code, expected);
        } else {
          assert.equal(malformed, false);
          assert.equal(outcome.result.done, false);
          await assert.rejects(events.next(), { code: expected });
        }
        assert.equal(host.requests.filter((item) => item.path.startsWith("/connect?")).length, malformed ? 1 : 2);
      } finally { controller.abort(); client.close(); }
    }
  } finally { await host.close(); }
});

test("Gateway keeps transport exception text out of failures", async () => {
  const client = new GatewayConnection({
    endpoint: { mode: "static", resolve: async () => ({ baseUrl: "http://127.0.0.1:1", source: "configured" }) },
    getConnectToken: () => token, timeoutMs: 100,
    fetchImpl: async () => { throw new Error(`token=${token}; Cookie=synthetic-private-cookie`); },
  });
  try {
    await assert.rejects(client.connect(), (error: unknown) => {
      assert.ok(error instanceof GatewayConnectionError);
      assert.equal(error.code, "transport_failure");
      assert.equal(error.cause, undefined);
      assert.equal(String(error).includes(token), false);
      assert.equal(JSON.stringify(error).includes("synthetic-private-cookie"), false);
      return true;
    });
  } finally { client.close(); }
});

test("Gateway never replays a write after a lost response and requires a fresh Peer on the next explicit attempt", async () => {
  const host = await gatewayFixture();
  const client = host.connection();
  try {
    host.setRpcMode("disconnect");
    await assert.rejects(client.call("session/prompt", { request: { requestId: "one-write" } }, z.unknown()),
      { code: "transport_failure" });
    assert.equal(host.requests.filter((r) => r.path === "/api/session/prompt").length, 1);
    host.setRpcMode("ok");
    await client.call("session/list", { _request: {} }, z.unknown());
    assert.equal(host.requests.filter((r) => r.path.startsWith("/connect?")).length, 2);
    assert.equal(host.requests.filter((r) => r.path === "/api/session/prompt").length, 1);
  } finally { client.close(); await host.close(); }
});

test("Gateway rejects mismatched RPC receipts and redacts untrusted error bodies", async () => {
  const host = await gatewayFixture();
  const client = host.connection();
  try {
    host.setRpcMode("mismatch");
    await assert.rejects(client.call("session/list", { _request: {} }, z.unknown()), { code: "unsupported_protocol" });
    host.setRpcMode("rejected");
    await assert.rejects(client.call("session/list", { _request: {} }, z.unknown()), (error: unknown) => {
      assert.ok(error instanceof GatewayConnectionError);
      assert.equal(error.code, "rpc_rejected");
      assert.equal(String(error).includes(token), false);
      assert.equal(JSON.stringify(error).includes(host.cookie), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  } finally { client.close(); await host.close(); }
});

test("Gateway multiplexes independent streams on the API socket and cancels only the released stream", async () => {
  const host = await gatewayFixture();
  const client = host.connection();
  const controller = new AbortController();
  try {
    await client.connect();
    const socket = [...host.sockets.clients][0]!;
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.type === "open" && message.endpoint === "session/follow") {
        socket.send(JSON.stringify({ type: "item", streamId: message.streamId,
          value: { type: "snapshot", cursor: 3, records: [] } }));
      }
    });
    const follow = client.stream("session/follow", { request: { address: { kind: "session", sessionId: "sample" } } }, controller.signal);
    assert.deepEqual((await follow.next()).value, { type: "snapshot", cursor: 3, records: [] });
    await follow.return();
    // A unary barrier makes the cancellation frame observable without timers.
    await client.call("session/list", { _request: {} }, z.object({ items: z.array(z.unknown()) }));
    assert.equal(host.opens.filter((item) => item.type === "cancel").length, 1);
    assert.equal(host.sockets.clients.size, 1);
    assert.equal(host.requests.filter((r) => r.path.startsWith("/connect?")).length, 1);
  } finally { client.close(); await host.close(); }
});
