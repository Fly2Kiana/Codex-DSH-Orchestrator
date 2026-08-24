import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { WebSocket } from "ws";

import { DshConnectionManager } from "../src/connection-manager.js";
import { DshClient } from "../src/dsh-client.js";
import { EventLedger } from "../src/event-ledger.js";
import { TaskStore } from "../src/task-store.js";
import { startMockDshHost } from "./support/mock-dsh-host.js";

async function eventually(operation: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (operation()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not met before timeout");
}

test("connection manager re-resolves Desktop endpoint after the mux transport disconnects", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-dynamic-endpoint-"));
  const first = await startMockDshHost();
  const second = await startMockDshHost();
  let activeBaseUrl = first.baseUrl;
  let resolveCalls = 0;
  for (const [host, version] of [
    [first, "first"],
    [second, "second"],
  ] as const) {
    host.setUnaryHandler("host.describe", () => ({
      version,
      cwd: home,
      attachedSessions: 0,
      canOpenPath: true,
    }));
    host.setUnaryHandler("session.list", () => ({ items: [] }));
    host.setMuxBaseline([]);
  }

  const config = {
    hostUrl: "http://127.0.0.1:3080",
    hostMode: "desktop-auto" as const,
    homeDir: home,
    requestTimeoutMs: 500,
    allowRemoteHost: false,
  };
  const api = new DshClient(
    {
      mode: "desktop-auto",
      resolve: async () => {
        resolveCalls += 1;
        return { baseUrl: activeBaseUrl, source: "windows-process-listener" };
      },
    },
    config.requestTimeoutMs,
    globalThis.fetch,
    (url) => new WebSocket(url) as unknown as globalThis.WebSocket,
  );
  const manager = new DshConnectionManager(config, api, new TaskStore(home), new EventLedger(home), {
    reconnectDelayMs: 20,
  });

  try {
    manager.start();
    await eventually(() => manager.snapshot().availability === "connected");
    assert.equal(manager.snapshot().baseUrl, first.baseUrl);

    activeBaseUrl = second.baseUrl;
    first.closeMux(1012, "desktop generation changed");
    await eventually(() => manager.snapshot().connectionEpoch >= 2 && manager.snapshot().availability === "connected");

    assert.equal(manager.snapshot().baseUrl, second.baseUrl);
    assert.ok(resolveCalls >= 2);
    assert.equal(first.requests.some((request) => request.method === "session.prompt"), false);
    assert.equal(second.requests.some((request) => request.method === "session.prompt"), false);
  } finally {
    await manager.stop();
    await first.close().catch(() => undefined);
    await second.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
});
