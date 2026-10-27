import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BridgeService, DelegationSetupError } from "../src/bridge-service.js";
import { DshConnectionManager } from "../src/connection-manager.js";
import type { DshModelSelection, DshSessionModels } from "../src/dsh-types.js";
import { EventLedger } from "../src/event-ledger.js";
import { GatewayConnection } from "../src/gateway-connection.js";
import { GatewayDshClient } from "../src/gateway-dsh-client.js";
import { isForceMajeureFailure, ModelRoutingError, resolveModelSelection } from "../src/model-routing.js";
import { TaskStore } from "../src/task-store.js";
import { startMockGatewayHost } from "./support/mock-gateway-host.js";

// Synthetic session/modelCatalog + session/projections contracts scoped to the
// rc.3 source review. No provider listing, credentials or real Host are used.
async function catalogFixture() {
  const host = await startMockGatewayHost();
  const wire = new GatewayConnection({ endpoint: { mode: "static",
    resolve: async () => ({ baseUrl: host.baseUrl, source: "configured" }) },
    getConnectToken: () => "fixture", timeoutMs: 1_000 });
  return { host, wire, api: new GatewayDshClient(wire, 1_000),
    async close() { wire.close(); await host.close(); } };
}

async function routingFixture() {
  const fixture = await catalogFixture();
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-rc3-route-"));
  const config = { hostUrl: fixture.host.baseUrl, homeDir: home, hostProtocol: "gateway" as const,
    requestTimeoutMs: 1_000, allowRemoteHost: false };
  const tasks = new TaskStore(home);
  const ledger = new EventLedger(home);
  const connection = new DshConnectionManager(config, fixture.api, tasks, ledger);
  const service = new BridgeService(config, fixture.api, tasks, connection, ledger);
  fixture.host.handle("session/list", () => ({ items: [] }));
  fixture.host.handle("session/create", () => ({ sessionId: "sample" }));
  // Do not start background supervision: these tests qualify synchronous route
  // selection/prompt failure. Separate suites cover observation and admission.
  return { ...fixture, home, service,
    async close() { await connection.stop(); await fixture.close(); await rm(home, { recursive: true, force: true }); } };
}

test("rc.3 catalog refresh reflects withdrawn/restored Pro and effort changes without crossing providers", async () => {
  const fixture = await catalogFixture();
  const { host, api } = fixture;
  const pro = { id: "deepseek-v4-pro", name: "Pro", reasoning: {
    efforts: [{ id: "high", name: "High" }, { id: "max", name: "Max" }], defaultEffort: "high",
  } };
  const flash = { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash" };
  let accountModels: DshSessionModels["groups"][number]["models"] = [flash, pro];
  let failures: DshSessionModels["failures"] = [];
  host.handle("session/modelCatalog", () => ({
    default: { provider: "deepseek-official", model: "deepseek-v4-pro" },
    routableProviders: ["deepseek-account", "deepseek-official"], failures,
    groups: [
      { id: "deepseek-account", name: "Account", models: accountModels },
      { id: "deepseek-official", name: "API key", models: [pro] },
    ],
  }));
  host.handle("session/projections", () => ({ kind: "sequenced", asOfSeq: 0, values: {
    modelSelection: { next: { provider: "deepseek-account", model: "deepseek-flash" }, lastUsed: null },
  } }));
  try {
    const initial = await api.sessionModels("sample");
    assert.equal(initial.current.provider, "deepseek-account", "session projection takes precedence over global default");
    assert.deepEqual(resolveModelSelection(initial, "pro", "max"), {
      provider: "deepseek-account", model: "deepseek-v4-pro", reasoningEffort: "max",
    });

    accountModels = [flash];
    failures = [{ id: "deepseek-account", name: "Account", message: "synthetic catalog refresh failure" }];
    const withdrawn = await api.sessionModels("sample");
    assert.deepEqual(withdrawn.failures, failures);
    assert.throws(() => resolveModelSelection(withdrawn, "pro", "max"), { code: "profile_unavailable" });
    assert.equal(withdrawn.groups[1]?.models[0]?.id, "deepseek-v4-pro", "API-key Pro is available but must not be substituted");

    accountModels = [flash, { ...pro, reasoning: { efforts: [{ id: "high", name: "High" }], defaultEffort: "high" } }];
    failures = [];
    const limited = await api.sessionModels("sample");
    assert.throws(() => resolveModelSelection(limited, "pro", "max"), { code: "reasoning_effort_unsupported" });
    assert.deepEqual(resolveModelSelection(limited, "pro", "high"), {
      provider: "deepseek-account", model: "deepseek-v4-pro", reasoningEffort: "high",
    });

    accountModels = [flash, pro];
    assert.deepEqual(resolveModelSelection(await api.sessionModels("sample"), "pro", "max"), {
      provider: "deepseek-account", model: "deepseek-v4-pro", reasoningEffort: "max",
    });
    assert.deepEqual(host.requests.map((request) => request.method),
      Array.from({ length: 4 }, () => ["session/modelCatalog", "session/projections"]).flat());
    assert.equal(host.connectCount, 1);
  } finally { await fixture.close(); }
});

test("rc.3 Gateway keeps current/legacy Flash ids and each advertised effort on its exact provider", async () => {
  const fixture = await catalogFixture();
  const { host, api } = fixture;
  try {
    for (const provider of ["deepseek-account", "deepseek-official"]) {
      for (const model of ["deepseek-flash", "deepseek-v4-flash"]) {
        host.handle("session/modelCatalog", () => ({ default: { provider, model },
          routableProviders: [provider], failures: [], groups: [{ id: provider, name: "Fixture provider", models: [
            { id: model, name: "Fixture Flash", reasoning: { defaultEffort: "high",
              efforts: ["off", "low", "high", "max"].map((id) => ({ id, name: id })) } },
          ] }],
        }));
        host.handle("session/projections", () => ({ kind: "sequenced", asOfSeq: 0,
          values: { modelSelection: { next: null, lastUsed: null } } }));
        const catalog = await api.sessionModels("sample");
        assert.equal(catalog.routable, true);
        for (const effort of ["off", "low", "high", "max"]) {
          assert.deepEqual(resolveModelSelection(catalog, "flash", effort), { provider, model, reasoningEffort: effort });
        }
        assert.throws(() => resolveModelSelection(catalog, "flash", "ultra"), { code: "reasoning_effort_unsupported" });
      }
    }
    assert.equal(host.requests.length, 8, "only session catalog and selection projection reads are allowed");
    assert.equal(host.requests.every((request) => ["session/modelCatalog", "session/projections"].includes(request.method)), true);
  } finally { await fixture.close(); }
});

test("rc.3 Gateway catalog names cannot authorize native vision or unverified discovery", async () => {
  const fixture = await catalogFixture();
  const { host, api } = fixture;
  let model: DshSessionModels["groups"][number]["models"][number] = {
    id: "deepseek-flash", name: "DeepSeek Flash Vision",
  };
  host.handle("session/modelCatalog", () => ({ default: { provider: "deepseek-official", model: "deepseek-flash" },
    routableProviders: ["deepseek-official"], failures: [],
    groups: [{ id: "deepseek-official", name: "API key", models: [model] }],
  }));
  host.handle("session/projections", () => ({ kind: "sequenced", asOfSeq: 0,
    values: { modelSelection: { next: null, lastUsed: null } } }));
  try {
    for (const inputModalities of [undefined, ["text"]]) {
      model = { id: "deepseek-flash", name: "DeepSeek Flash Vision",
        ...(inputModalities === undefined ? {} : { inputModalities }) };
      const catalog = await api.sessionModels("sample");
      assert.deepEqual(catalog.groups[0]?.models[0]?.inputModalities, inputModalities);
      assert.throws(() => resolveModelSelection(catalog, "official-flash-vision"), (error: unknown) => {
        assert.ok(error instanceof ModelRoutingError);
        assert.equal(error.code, "vision_capability_unverified");
        assert.equal(isForceMajeureFailure(error), false);
        return true;
      });
    }
    assert.deepEqual(host.requests.map((request) => request.method), [
      "session/modelCatalog", "session/projections", "session/modelCatalog", "session/projections",
    ]);
  } finally { await fixture.close(); }
});

for (const code of ["CLIENT_UPGRADE_REQUIRED", "MODEL_UNSUPPORTED", "permission-denied", "invalid-configuration"]) {
  test(`rc.3 ${code} rejection never retries a selection/prompt or switches to ModLens`, async () => {
    for (const rejectedMethod of ["session/selectModel", "session/prompt"]) {
      const fixture = await routingFixture();
      const { host, home, service } = fixture;
      const privateMarker = "synthetic-untrusted-provider-detail";
      const selected = { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "high" };
      const reasoning = { efforts: [{ id: "high", name: "High" }], defaultEffort: "high" };
      host.handle("session/modelCatalog", () => ({ default: selected,
        routableProviders: ["deepseek-official", "deepseek-modlens"], failures: [], groups: [
          { id: "deepseek-official", name: "API key", models: [
            { id: "deepseek-flash", name: "Flash", inputModalities: ["text", "image"], reasoning },
          ] },
          { id: "deepseek-modlens", name: "ModLens", models: [{ id: "deepseek-v4-flash", name: "Flash", reasoning }] },
        ],
      }));
      host.handle("session/projections", () => ({ kind: "sequenced", asOfSeq: 0,
        values: { modelSelection: { next: selected, lastUsed: null } } }));
      host.handle("session/selectModel", () => ({ selected }));
      host.reject(rejectedMethod, { code, message: privateMarker, details: { value: privateMarker } });
      try {
        await assert.rejects(service.delegate({ prompt: "synthetic visual route only", cwd: home,
          visualIntent: "required", complexity: "low", reasoningEffort: "high" }), (error: unknown) => {
          assert.ok(error instanceof DelegationSetupError);
          assert.equal(error.stage, rejectedMethod === "session/selectModel" ? "model-selection" : "prompt");
          if (error.stage === "model-selection") assert.equal(error.failureClass, "configuration_error");
          for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
            assert.equal(cause.message.includes(privateMarker), false);
          }
          return true;
        });
        const selections = host.requests.filter((request) => request.method === "session/selectModel");
        assert.equal(selections.length, 1);
        assert.deepEqual(selections[0]?.args.request, { sessionId: "sample", ...selected });
        assert.equal(host.requests.filter((request) => request.method === "session/prompt").length,
          rejectedMethod === "session/prompt" ? 1 : 0);
        assert.equal(host.requests.filter((request) => request.method === "session/modelCatalog").length,
          rejectedMethod === "session/prompt" ? 2 : 1);
        assert.equal(host.connectCount, 1);
      } finally { await fixture.close(); }
    }
  });
}

test("rc.3 withdrawal after accepted selection prevents prompting even when the projection still matches", async () => {
  const fixture = await routingFixture();
  const { host, home, service } = fixture;
  const selected = { provider: "deepseek-account", model: "deepseek-v4-pro", reasoningEffort: "max" };
  let current: DshModelSelection = { provider: "deepseek-account", model: "deepseek-flash" };
  let proAvailable = true;
  host.handle("session/modelCatalog", () => ({ default: current, routableProviders: ["deepseek-account"], failures: [],
    groups: [{ id: "deepseek-account", name: "Account", models: [
      { id: "deepseek-flash", name: "Flash" },
      ...(proAvailable ? [{ id: "deepseek-v4-pro", name: "Pro", reasoning: {
        efforts: [{ id: "max", name: "Max" }], defaultEffort: "max",
      } }] : []),
    ] }],
  }));
  host.handle("session/projections", () => ({ kind: "sequenced", asOfSeq: 0,
    values: { modelSelection: { next: current, lastUsed: null } } }));
  host.handle("session/selectModel", () => {
    current = selected;
    proAvailable = false;
    return { selected };
  });
  try {
    await assert.rejects(service.delegate({ prompt: "synthetic non-visual work", cwd: home,
      modelProfile: "pro", reasoningEffort: "max" }), (error: unknown) => {
      assert.ok(error instanceof DelegationSetupError);
      assert.equal(error.stage, "model-selection");
      assert.ok(error.cause instanceof ModelRoutingError);
      assert.equal(error.cause.code, "selection_mismatch");
      assert.match(error.message, /selection may already be the DSH default/);
      return true;
    });
    assert.equal(host.requests.filter((request) => request.method === "session/modelCatalog").length, 2);
    assert.equal(host.requests.filter((request) => request.method === "session/selectModel").length, 1);
    assert.equal(host.requests.some((request) => request.method === "session/prompt"), false);
    assert.equal(host.connectCount, 1);
  } finally { await fixture.close(); }
});
