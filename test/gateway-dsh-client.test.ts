import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BridgeService } from "../src/bridge-service.js";
import { DshConnectionManager } from "../src/connection-manager.js";
import { EventLedger } from "../src/event-ledger.js";
import { TaskStore } from "../src/task-store.js";
import { GatewayConnection } from "../src/gateway-connection.js";
import { GatewayDshClient } from "../src/gateway-dsh-client.js";
import { getDshUnaryMetadata } from "../src/dsh-types.js";
import { startMockGatewayHost } from "./support/mock-gateway-host.js";

test("official session adapter preserves create/model/prompt contracts and durable prompt correlation", async () => {
  const host = await startMockGatewayHost();
  const wire = new GatewayConnection({ endpoint: { mode: "static",
    resolve: async () => ({ baseUrl: host.baseUrl, source: "configured" }) }, getConnectToken: () => "fixture", timeoutMs: 1_000 });
  const api = new GatewayDshClient(wire, 1_000);
  host.handle("session/create", ({ request }) => ({ sessionId: request.sessionId ?? "sample" }));
  host.handle("session/modelCatalog", () => ({
    default: { provider: "deepseek-account", model: "deepseek-flash" }, routableProviders: ["deepseek-account"],
    groups: [{ id: "deepseek-account", name: "Account", models: [{ id: "deepseek-flash", name: "Flash" }] }], failures: [],
  }));
  host.handle("session/projections", () => ({ kind: "sequenced", asOfSeq: 0, values: {
    modelSelection: { next: { provider: "deepseek-account", model: "deepseek-flash", reasoningEffort: "high" }, lastUsed: null },
  } }));
  host.handle("session/prompt", () => ({ accepted: true }));
  try {
    assert.equal((await api.sessionCreate({ cwd: "/fixture/project" })).sessionId, "sample");
    assert.deepEqual((await api.sessionModels("sample")).current, {
      provider: "deepseek-account", model: "deepseek-flash", reasoningEffort: "high",
    });
    const result = await api.sessionPrompt({ sessionId: "sample", mode: "queue", content: [{ type: "text", text: "read only" }] });
    assert.deepEqual(result, { accepted: true });
    const request = host.requests.find((item) => item.method === "session/prompt")!;
    assert.equal(typeof request.args.request.requestId, "string");
    assert.equal(getDshUnaryMetadata(result).issuedRpcId, request.args.request.requestId);
    assert.equal(getDshUnaryMetadata(result).method, "session.prompt");
    assert.equal(host.requests.filter((item) => item.method === "session/prompt").length, 1);
  } finally { wire.close(); await host.close(); }
});

test("official missing authorization is reported distinctly and does not trigger background reauthentication", async () => {
  const home = await mkdtemp(join(tmpdir(), "gateway-auth-test-"));
  let attempts = 0;
  const wire = new GatewayConnection({ endpoint: { mode: "static", resolve: async () => { throw new Error("must not discover before authorization"); } },
    getConnectToken: () => { attempts++; return undefined; }, timeoutMs: 100 });
  const api = new GatewayDshClient(wire, 100);
  const config = { hostUrl: "http://127.0.0.1:1", homeDir: home, hostProtocol: "gateway" as const, requestTimeoutMs: 100, allowRemoteHost: false };
  const connection = new DshConnectionManager(config, api, new TaskStore(home), new EventLedger(home), { reconnectDelayMs: 2 });
  try {
    connection.start();
    const deadline = Date.now() + 2_000;
    while (connection.snapshot().availability === "connecting" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(connection.snapshot().availability, "auth_required");
    // Wait across several configured retry intervals to prove no retry occurs.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(connection.snapshot().availability, "auth_required");
    assert.equal(attempts, 1);
  } finally { await connection.stop(); wire.close(); await rm(home, { recursive: true, force: true }); }
});

test("official observation scopes history and requires an explicit exactly-once approval response", async () => {
  const host = await startMockGatewayHost();
  const wire = new GatewayConnection({ endpoint: { mode: "static", resolve: async () => ({ baseUrl: host.baseUrl, source: "configured" }) },
    getConnectToken: () => "fixture", timeoutMs: 1_000 });
  const api = new GatewayDshClient(wire, 1_000);
  const controller = new AbortController();
  host.onStream((stream) => host.send(stream, { type: "snapshot", header: { id: "sample" }, cursor: 0,
    records: [{ type: "event", event: { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } } }],
    hasMore: false, projections: { asOfSeq: 0, values: {} } }));
  host.handle("$events/result", () => undefined);
  let mux: ReturnType<GatewayDshClient["openMux"]> | undefined;
  try {
    api.trackSessions(["sample"]);
    mux = api.openMux(controller.signal);
    assert.equal((await mux.next()).value?.payload.type, "session/subscribed");
    assert.equal((await mux.next()).value?.payload.type, "session/event");
    const source = host.streams.find((stream) => stream.endpoint === "$events")!;
    host.send(source, { type: "waterfall", event: "approval/request", eventId: "other-event", agentId: "other-session", request: { toolName: "write" } });
    host.send(source, { type: "waterfall", event: "approval/request", eventId: "own-event", agentId: "sample", request: { toolName: "read" } });
    const pending = (await mux.next()).value!;
    assert.equal(pending.rpcId, "own-event");
    assert.equal(pending.payload.type, "approval/requested");
    assert.equal(host.requests.filter((r) => r.method === "$events/result" && r.args.eventId === "own-event").length, 0);
    const response = { type: "client-response" as const, rpcId: "own-event", result: { ok: true as const,
      value: { sessionId: "sample", approvalId: "own-event", outcome: "allowed-once" as const } } };
    assert.deepEqual(await api.respond(response), { accepted: true });
    assert.deepEqual(await api.respond(response), { accepted: false, reason: "not-pending" });
    const responses = host.requests.filter((r) => r.method === "$events/result");
    assert.deepEqual(responses.map((r) => r.args), [
      { clientId: "fixture-client", eventId: "other-event", outcome: { kind: "next" } },
      { clientId: "fixture-client", eventId: "own-event", outcome: { kind: "result", value: "allowed-once" } },
    ]);
    assert.equal(host.streams.filter((s) => s.endpoint === "session/follow" && s.args.request.address.sessionId !== "sample").length, 0);
  } finally { controller.abort(); await mux?.return(); wire.close(); await host.close(); }
});

test("official history uses the exact follow cut for paging and does not request assistant presentation streams", async () => {
  const host = await startMockGatewayHost();
  const wire = new GatewayConnection({ endpoint: { mode: "static", resolve: async () => ({ baseUrl: host.baseUrl, source: "configured" }) },
    getConnectToken: () => "fixture", timeoutMs: 1_000 });
  const api = new GatewayDshClient(wire, 1_000);
  const event = { type: "turn/end", seq: 7, time: 1, data: { reason: { kind: "completed" } } };
  host.onStream((stream) => host.send(stream, { type: "snapshot", header: { id: "sample" }, cursor: 7,
    records: [{ type: "event", event }], hasMore: false, projections: { asOfSeq: 7, values: {} } }));
  host.handle("session/page", ({ request }) => {
    assert.equal(request.throughSeq, 7);
    assert.deepEqual(request.address, { kind: "session", sessionId: "sample" });
    return { records: [{ type: "event", event }], hasMore: false };
  });
  try {
    const history = await api.sessionHistory("sample", { maxMessages: 3 });
    assert.deepEqual(history.events, [{ event }]);
    assert.equal(history.hasMore, false);
    assert.equal(host.streams.find((stream) => stream.endpoint === "session/follow")?.args.request.assistantStream, undefined);
    assert.equal(host.requests.filter((request) => request.method === "session/page").length, 1);
  } finally { wire.close(); await host.close(); }
});

test("official question events remain typed, cancelled requests cannot be replayed and timed waits stay with the Host", async () => {
  const host = await startMockGatewayHost();
  const wire = new GatewayConnection({ endpoint: { mode: "static", resolve: async () => ({ baseUrl: host.baseUrl, source: "configured" }) },
    getConnectToken: () => "fixture", timeoutMs: 1_000 });
  const api = new GatewayDshClient(wire, 1_000);
  const controller = new AbortController();
  host.onStream((stream) => host.send(stream, { type: "snapshot", header: { id: "sample" }, cursor: -1, records: [], hasMore: false,
    projections: { asOfSeq: -1, values: {} } }));
  host.handle("$events/result", () => undefined);
  api.trackSessions(["sample"]);
  const mux = api.openMux(controller.signal);
  try {
    await mux.next();
    const source = host.streams.find((stream) => stream.endpoint === "$events")!;
    const question = { type: "waterfall", event: "user-questions/request", eventId: "question-one", agentId: "sample",
      request: { questions: [{ id: "q1", question: "Which?", options: [{ label: "A" }] }] } };
    host.send(source, question);
    assert.equal((await mux.next()).value?.payload.type, "question/requested");
    const reply = { type: "client-response" as const, rpcId: "question-one", result: { ok: true as const,
      value: { sessionId: "sample", answer: { answers: [{ id: "q1", selected: ["A"] }] } } } };
    assert.deepEqual(await api.respond(reply), { accepted: true });
    host.send(source, { ...question, eventId: "question-cancelled" });
    await mux.next();
    host.send(source, { type: "cancel", eventId: "question-cancelled" });
    assert.equal((await mux.next()).value?.payload.type, "question/resolved");
    assert.deepEqual(await api.respond({ ...reply, rpcId: "question-cancelled" }), { accepted: false, reason: "not-pending" });
    host.send(source, { ...question, eventId: "timed", request: { ...question.request, wait: { callId: "call", timed: true } } });
    // A later ordinary question acts as a delivery barrier for the timed handoff.
    host.send(source, { ...question, eventId: "barrier" });
    assert.equal((await mux.next()).value?.rpcId, "barrier");
    assert.deepEqual(host.requests.find((request) => request.args.eventId === "timed")?.args.outcome, { kind: "next" });
    assert.equal(host.requests.some((request) => request.args.eventId === "question-cancelled"), false);
  } finally { controller.abort(); await mux.return(); wire.close(); await host.close(); }
});

test("official mock Host completes the bridge delegate/result/follow-up loop without selecting a model", { timeout: 10_000 }, async () => {
  const host = await startMockGatewayHost();
  const home = await mkdtemp(join(tmpdir(), "gateway-bridge-test-"));
  const wire = new GatewayConnection({ endpoint: { mode: "static", configuredBaseUrl: host.baseUrl,
    resolve: async () => ({ baseUrl: host.baseUrl, source: "configured" }) }, getConnectToken: () => "fixture", timeoutMs: 1_000 });
  const api = new GatewayDshClient(wire, 1_000);
  const config = { hostUrl: host.baseUrl, homeDir: home, hostProtocol: "gateway" as const, requestTimeoutMs: 1_000, allowRemoteHost: false };
  const tasks = new TaskStore(home);
  const ledger = new EventLedger(home);
  const connection = new DshConnectionManager(config, api, tasks, ledger, { reconnectDelayMs: 20 });
  const service = new BridgeService(config, api, tasks, connection, ledger);
  let created = false;
  let turns = 0;
  const events: Array<{ type: string; seq: number; time: number; data: unknown }> = [];
  host.handle("session/list", () => ({ items: created ? [{ sessionId: "sample", updatedAt: turns,
    running: false, blank: turns === 0, cwd: home, agentAvailable: true }] : [] }));
  host.handle("session/create", () => { created = true; return { sessionId: "sample" }; });
  host.handle("session/modelCatalog", () => ({ default: { provider: "deepseek-account", model: "deepseek-flash" },
    routableProviders: ["deepseek-account"], groups: [{ id: "deepseek-account", name: "Account", models: [{ id: "deepseek-flash", name: "Flash" }] }], failures: [] }));
  host.handle("session/projections", () => ({ kind: "sequenced", asOfSeq: events.length - 1, values: {} }));
  host.handle("session/rename", () => ({ title: "Fixture", seq: 0 }));
  host.handle("session/page", ({ request }) => ({ records: events.filter((event) => event.seq <= request.throughSeq &&
    (request.beforeSeq === undefined || event.seq < request.beforeSeq)).map((event) => ({ type: "event", event })), hasMore: false }));
  host.onStream((stream) => host.send(stream, { type: "snapshot", header: { id: "sample" }, cursor: events.length - 1,
    records: events.map((event) => ({ type: "event", event })), hasMore: false, projections: { asOfSeq: events.length - 1, values: {} } }));
  host.handle("session/prompt", () => {
    turns++;
    const turn = [
      { type: "turn/start", data: { turn: turns } },
      { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "text", text: `OK ${turns}` }] } } },
      { type: "turn/end", data: { reason: { kind: "completed" } } },
    ];
    for (const value of turn) {
      const event = { ...value, seq: events.length, time: events.length + 1 }; events.push(event);
      for (const stream of host.streams.filter((stream) => stream.endpoint === "session/follow")) host.send(stream, { type: "event", event });
    }
    return { accepted: true };
  });
  async function final(taskId: string, text: string) {
    let observed;
    for (let attempt = 0; attempt < 40; attempt++) {
      const status = await service.status(taskId);
      observed = { execution: status.execution, finalMessage: status.finalMessage,
        connection: connection.snapshot().availability, error: connection.snapshot().lastError,
        pointer: status.finalMessagePointer };
      if (status.execution === "turn_completed" && status.finalMessage === text) return status;
      const snapshot = await ledger.snapshot(taskId);
      await connection.waitForTaskChange(taskId, snapshot.cursor, connection.snapshot().revision, 25);
    }
    assert.fail("mock Gateway did not produce the expected final result: " + JSON.stringify(observed));
  }
  try {
    connection.start();
    const task = await service.delegate({ cwd: home, prompt: "Return OK", workspaceMode: "read-only" });
    await final(task.taskId, "OK 1");
    await service.continueTask(task.taskId, "Return OK again", "queue");
    await final(task.taskId, "OK 2");
    assert.equal(host.requests.filter((request) => request.method === "session/create").length, 1);
    assert.equal(host.requests.filter((request) => request.method === "session/selectModel").length, 0);
    assert.ok(host.requests.filter((request) => request.method === "session/prompt").every((request) => request.args.request.sessionId === "sample"));
    assert.equal(connection.snapshot().capabilities.queueSnapshot, false);
    await service.releaseWorkspace(task.taskId);
  } finally {
    await connection.stop(); wire.close(); await host.close(); await rm(home, { recursive: true, force: true });
  }
});
