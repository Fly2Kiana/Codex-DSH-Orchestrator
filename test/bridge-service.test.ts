import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  BridgeCapabilityError,
  BridgeService,
  DelegationSetupError,
  FollowupPromptError,
  FollowupRoutingError,
  StaleViewError,
} from "../src/bridge-service.js";
import type { BridgeConfig } from "../src/config.js";
import { DshRpcError } from "../src/dsh-client.js";
import { EventLedger } from "../src/event-ledger.js";
import { DuplicateSessionMappingError, TaskStore } from "../src/task-store.js";
import { WorkspaceClaimConflictError, WorkspaceClaimStore } from "../src/workspace-claim.js";
import { FakeConnection, FakeDshApi } from "./support/fakes.js";

function config(homeDir: string): BridgeConfig {
  return {
    hostUrl: "http://127.0.0.1:3080",
    homeDir,
    requestTimeoutMs: 1_000,
    allowRemoteHost: false,
  };
}

async function makeDirLink(target: string, linkPath: string): Promise<void> {
  if (process.platform === "win32") {
    await symlink(target, linkPath, "junction");
  } else {
    await symlink(target, linkPath, "dir");
  }
}

test("delegate validates cwd, never passes model, stays detached, and followup preserves the root session", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    const tasks = new TaskStore(home);
    const ledger = new EventLedger(home);
    const connection = new FakeConnection(ledger);
    const service = new BridgeService(config(home), api, tasks, connection, ledger);

    const delegated = await service.delegate({ prompt: "Implement this", cwd: home });
    assert.equal(delegated.accepted, true);
    assert.equal(delegated.detached, true);
    assert.equal(delegated.rootSessionId, "root-session");
    assert.deepEqual(delegated.workspaceClaimSemantics, {
      enforcement: "bridge-cooperative-only",
      controlsDshSandbox: false,
      description:
        "workspaceMode is a bridge-local coordination claim shared only by bridge processes using the same bridge home; it does not select, enforce, or verify the DSH Host filesystem sandbox.",
    });
    const create = api.calls.find((call) => call.method === "session.create");
    const prompt = api.calls.find((call) => call.method === "session.prompt");
    assert.deepEqual(create?.payload, { cwd: await realpath(home) });
    assert.equal("model" in (create?.payload as Record<string, unknown>), false);
    assert.equal("model" in (prompt?.payload as Record<string, unknown>), false);

    await service.continueTask(delegated.taskId, "later", "queue");
    await service.continueTask(delegated.taskId, "now", "steer");
    const followups = api.calls.filter((call) => call.method === "session.prompt").slice(1);
    assert.deepEqual(followups.map((call) => (call.payload as { mode: string }).mode), ["queue", "steer"]);
    assert.deepEqual(followups.map((call) => (call.payload as { sessionId: string }).sessionId), ["root-session", "root-session"]);

    const released = await service.releaseWorkspace(delegated.taskId);
    assert.equal(released.sessionClosedByRelease, false);
    assert.equal(released.sessionExistence, "not_checked");
    await assert.rejects(
      () => service.continueTask(delegated.taskId, "after release", "queue"),
      (error: unknown) => error instanceof BridgeCapabilityError && error.code === "workspace_claim_missing",
    );

    const beforeInvalid = api.calls.length;
    await assert.rejects(() => service.delegate({ prompt: "bad", cwd: join(home, "missing") }), /cwd does not exist/);
    assert.equal(api.calls.length, beforeInvalid);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("findSessions returns bounded root metadata without history or raw projections", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.sessions = [
      {
        sessionId: "root-new",
        updatedAt: 20,
        running: false,
        blank: false,
        cwd: home,
        agentPreset: "code",
        projections: { asOfSeq: 8, values: { title: "DeepSeek常用技能插件整理", secret: "must-not-surface" } },
      },
      {
        sessionId: "root-old",
        updatedAt: 10,
        running: false,
        blank: false,
        cwd: home,
        projections: { values: { title: "DeepSeek常用技能插件整理" } },
      },
      {
        sessionId: "child",
        parentSessionId: "root-new",
        origin: "subagent",
        updatedAt: 30,
        running: false,
        blank: false,
        cwd: home,
        projections: { values: { title: "DeepSeek常用技能插件整理" } },
      },
      { sessionId: "blank", updatedAt: 40, running: false, blank: true, cwd: home },
    ];
    const tasks = new TaskStore(home);
    const existing = await tasks.create("root-old");
    const ledger = new EventLedger(home);
    const service = new BridgeService(config(home), api, tasks, new FakeConnection(ledger), ledger);

    const found = await service.findSessions({ title: "DeepSeek常用技能插件整理", titleMatch: "exact", maxResults: 10 });

    assert.deepEqual(found.sessions, [
      {
        sessionId: "root-new",
        title: "DeepSeek常用技能插件整理",
        titleTruncated: false,
        updatedAt: 20,
        running: false,
        blank: false,
        cwd: await realpath(home),
        agentPreset: "code",
        bridgeTaskId: null,
        bridgeMappingConflict: false,
      },
      {
        sessionId: "root-old",
        title: "DeepSeek常用技能插件整理",
        titleTruncated: false,
        updatedAt: 10,
        running: false,
        blank: false,
        cwd: await realpath(home),
        agentPreset: null,
        bridgeTaskId: existing.taskId,
        bridgeMappingConflict: false,
      },
    ]);
    assert.equal(found.matchCount, 2);
    assert.equal(found.truncated, false);
    assert.equal(JSON.stringify(found).includes("must-not-surface"), false);
    assert.equal(api.calls.some((call) => call.method === "session.history"), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("findSessions filters exact canonical cwd, mapped-only, idle-only, and excludes children without history", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  const requestedCwd = await mkdtemp(join(tmpdir(), "codex-dsh-requested-"));
  const otherCwd = await mkdtemp(join(tmpdir(), "codex-dsh-other-"));
  const probe = join(requestedCwd, "probe");
  await mkdir(probe);
  try {
    const api = new FakeDshApi();
    api.sessions = [
      {
        sessionId: "mapped-idle-exact",
        updatedAt: 30,
        running: false,
        blank: false,
        cwd: requestedCwd,
        projections: { values: { title: "Exact candidate" } },
      },
      { sessionId: "mapped-idle-other", updatedAt: 25, running: false, blank: false, cwd: otherCwd },
      { sessionId: "unmapped-idle-exact", updatedAt: 20, running: false, blank: false, cwd: requestedCwd },
      { sessionId: "mapped-running-exact", updatedAt: 15, running: true, blank: false, cwd: requestedCwd },
      { sessionId: "mapped-idle-unavailable", updatedAt: 12, running: false, blank: false, cwd: join(requestedCwd, "no-such-dir") },
      {
        sessionId: "child-excluded",
        parentSessionId: "mapped-idle-exact",
        origin: "subagent",
        updatedAt: 40,
        running: false,
        blank: false,
        cwd: requestedCwd,
      },
    ];
    const tasks = new TaskStore(home);
    await tasks.create("mapped-idle-exact");
    await tasks.create("mapped-idle-other");
    await tasks.create("mapped-running-exact");
    await tasks.create("mapped-idle-unavailable");
    const ledger = new EventLedger(home);
    const service = new BridgeService(config(home), api, tasks, new FakeConnection(ledger), ledger);

    const found = await service.findSessions({
      cwd: join(probe, ".."),
      mappedOnly: true,
      idleOnly: true,
      maxResults: 10,
    });

    assert.deepEqual(
      found.sessions.map((session) => session.sessionId),
      ["mapped-idle-exact"],
    );
    assert.equal(found.matchCount, 1);
    assert.equal(found.truncated, false);
    assert.equal(found.metadataOnly, true);
    assert.equal(found.conversationHistoryRead, false);
    assert.equal(api.calls.some((call) => call.method === "session.history"), false);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(requestedCwd, { recursive: true, force: true });
    await rm(otherCwd, { recursive: true, force: true });
  }
});

test("findSessions rejects missing or relative cwd before listing and preserves legacy discovery when cwd is omitted", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.sessions = [{ sessionId: "legacy-root", updatedAt: 5, running: false, blank: false, cwd: home }];
    const tasks = new TaskStore(home);
    const ledger = new EventLedger(home);
    const service = new BridgeService(config(home), api, tasks, new FakeConnection(ledger), ledger);

    const beforeMissing = api.calls.length;
    await assert.rejects(() => service.findSessions({ cwd: join(home, "missing") }), /cwd does not exist/);
    assert.equal(api.calls.length, beforeMissing);

    const beforeRelative = api.calls.length;
    await assert.rejects(() => service.findSessions({ cwd: "relative" }), /cwd must be an absolute path/);
    assert.equal(api.calls.length, beforeRelative);

    const found = await service.findSessions({ maxResults: 10 });
    assert.deepEqual(found.sessions.map((session) => session.sessionId), ["legacy-root"]);
    assert.equal(found.metadataOnly, true);
    assert.equal(found.conversationHistoryRead, false);
    assert.equal(api.calls.some((call) => call.method === "session.history"), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("findSessions returns discovery-time canonical cwd and attach detects a retargeted link", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  const targetA = await mkdtemp(join(tmpdir(), "codex-dsh-target-a-"));
  const targetB = await mkdtemp(join(tmpdir(), "codex-dsh-target-b-"));
  const link = join(home, "workspace-link");
  try {
    try {
      await makeDirLink(targetA, link);
    } catch (error) {
      t.skip("directory symlink/junction creation unavailable: " + String(error));
      return;
    }
    const canonicalA = await realpath(link);

    const api = new FakeDshApi();
    api.sessions = [
      {
        sessionId: "linked-root",
        updatedAt: 50,
        running: false,
        blank: false,
        cwd: link,
        projections: { values: { title: "Linked workspace" } },
      },
    ];
    const tasks = new TaskStore(home);
    const ledger = new EventLedger(home);
    const service = new BridgeService(config(home), api, tasks, new FakeConnection(ledger), ledger);

    const found = await service.findSessions({ cwd: link, maxResults: 10 });
    assert.equal(found.sessions.length, 1);
    assert.equal(found.sessions[0]?.cwd, canonicalA);
    assert.notEqual(found.sessions[0]?.cwd, link);

    await rm(link, { force: true });
    await makeDirLink(targetB, link);

    await assert.rejects(
      () =>
        service.attachSession({
          sessionId: "linked-root",
          expectedUpdatedAt: 50,
          expectedTitle: "Linked workspace",
          expectedCwd: canonicalA,
        }),
      (error: unknown) => error instanceof StaleViewError,
    );
    assert.equal((await tasks.list()).length, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(targetA, { recursive: true, force: true });
    await rm(targetB, { recursive: true, force: true });
  }
});

test("findSessions without a cwd filter returns canonical cwd and attach reports and enforces it", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  const targetA = await mkdtemp(join(tmpdir(), "codex-dsh-target-a-"));
  const targetB = await mkdtemp(join(tmpdir(), "codex-dsh-target-b-"));
  const link = join(home, "workspace-link");
  try {
    try {
      await makeDirLink(targetA, link);
    } catch (error) {
      t.skip("directory symlink/junction creation unavailable: " + String(error));
      return;
    }
    const canonicalA = await realpath(link);

    const api = new FakeDshApi();
    api.sessions = [
      {
        sessionId: "linked-root",
        updatedAt: 50,
        running: false,
        blank: false,
        cwd: link,
        projections: { values: { title: "Linked workspace" } },
      },
    ];
    const tasks = new TaskStore(home);
    const ledger = new EventLedger(home);
    const connection = new FakeConnection(ledger);
    const service = new BridgeService(config(home), api, tasks, connection, ledger);

    const found = await service.findSessions({ maxResults: 10 });
    assert.equal(found.sessions.length, 1);
    assert.equal(found.sessions[0]?.cwd, canonicalA);
    assert.notEqual(found.sessions[0]?.cwd, link);

    const attached = await service.attachSession({
      sessionId: "linked-root",
      expectedUpdatedAt: 50,
      expectedTitle: "Linked workspace",
      expectedCwd: canonicalA,
    });
    assert.equal(attached.session.cwd, canonicalA);

    await rm(link, { force: true });
    await makeDirLink(targetB, link);
    await assert.rejects(
      () =>
        service.attachSession({
          sessionId: "linked-root",
          expectedUpdatedAt: 50,
          expectedTitle: "Linked workspace",
          expectedCwd: canonicalA,
        }),
      (error: unknown) => error instanceof StaleViewError,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(targetA, { recursive: true, force: true });
    await rm(targetB, { recursive: true, force: true });
  }
});

test("findSessions excludes invalid advertised cwds and preserves the existing filters", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  const otherCwd = await mkdtemp(join(tmpdir(), "codex-dsh-other-"));
  const aFile = join(home, "a-file.txt");
  await writeFile(aFile, "x", "utf8");
  try {
    const api = new FakeDshApi();
    api.sessions = [
      { sessionId: "valid-idle", updatedAt: 30, running: false, blank: false, cwd: home, projections: { values: { title: "Alpha" } } },
      { sessionId: "valid-beta", updatedAt: 29, running: false, blank: false, cwd: otherCwd, projections: { values: { title: "Beta" } } },
      { sessionId: "valid-running", updatedAt: 28, running: true, blank: false, cwd: home },
      { sessionId: "valid-blank", updatedAt: 27, running: false, blank: true, cwd: home },
      { sessionId: "valid-unmapped", updatedAt: 26, running: false, blank: false, cwd: home },
      { sessionId: "invalid-missing", updatedAt: 40, running: false, blank: false },
      { sessionId: "invalid-empty", updatedAt: 39, running: false, blank: false, cwd: "" },
      { sessionId: "invalid-relative", updatedAt: 38, running: false, blank: false, cwd: "relative/path" },
      { sessionId: "invalid-unresolvable", updatedAt: 37, running: false, blank: false, cwd: join(home, "no-such-dir") },
      { sessionId: "invalid-file", updatedAt: 36, running: false, blank: false, cwd: aFile },
      { sessionId: "invalid-null", updatedAt: 35, running: false, blank: false, cwd: null as unknown as string },
    ];
    const tasks = new TaskStore(home);
    await tasks.create("valid-idle");
    await tasks.create("valid-beta");
    await tasks.create("valid-running");
    await tasks.create("valid-blank");
    const ledger = new EventLedger(home);
    const service = new BridgeService(config(home), api, tasks, new FakeConnection(ledger), ledger);

    const found = await service.findSessions({ maxResults: 50 });
    const ids = found.sessions.map((session) => session.sessionId);
    for (const invalid of ["invalid-missing", "invalid-empty", "invalid-relative", "invalid-unresolvable", "invalid-file", "invalid-null"]) {
      assert.equal(ids.includes(invalid), false, invalid + " should be excluded");
    }
    assert.equal(ids.includes("valid-idle"), true);

    const withBlank = await service.findSessions({ includeBlank: true, maxResults: 50 });
    assert.equal(withBlank.sessions.map((session) => session.sessionId).includes("valid-blank"), true);

    const exact = await service.findSessions({ title: "Alpha", titleMatch: "exact", maxResults: 50 });
    assert.deepEqual(exact.sessions.map((session) => session.sessionId), ["valid-idle"]);

    const contains = await service.findSessions({ title: "et", titleMatch: "contains", maxResults: 50 });
    assert.deepEqual(contains.sessions.map((session) => session.sessionId), ["valid-beta"]);

    const mapped = await service.findSessions({ mappedOnly: true, maxResults: 50 });
    assert.equal(mapped.sessions.map((session) => session.sessionId).includes("valid-unmapped"), false);
    assert.equal(mapped.sessions.map((session) => session.sessionId).includes("valid-idle"), true);

    const idle = await service.findSessions({ idleOnly: true, maxResults: 50 });
    assert.equal(idle.sessions.map((session) => session.sessionId).includes("valid-running"), false);
    assert.equal(idle.sessions.map((session) => session.sessionId).includes("valid-idle"), true);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(otherCwd, { recursive: true, force: true });
  }
});

test("findSessions mappedOnly excludes mapping conflicts and attach fails closed on them", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.sessions = [
      {
        sessionId: "conflict-root",
        updatedAt: 7,
        running: false,
        blank: false,
        cwd: home,
        projections: { values: { title: "Conflict" } },
      },
    ];
    const tasks = new TaskStore(home);
    await tasks.create("conflict-root");
    await writeFile(
      join(home, "tasks", "dsh_bbbbbbbbbbbb.json"),
      JSON.stringify({ sessionId: "conflict-root", taskId: "dsh_bbbbbbbbbbbb" }),
      "utf8",
    );
    const ledger = new EventLedger(home);
    const service = new BridgeService(config(home), api, tasks, new FakeConnection(ledger), ledger);

    const mapped = await service.findSessions({ cwd: home, mappedOnly: true, maxResults: 10 });
    assert.deepEqual(mapped.sessions.map((session) => session.sessionId), []);

    const all = await service.findSessions({ cwd: home, maxResults: 10 });
    assert.equal(all.sessions[0]?.bridgeMappingConflict, true);
    assert.equal(all.sessions[0]?.bridgeTaskId, null);

    await assert.rejects(
      () =>
        service.attachSession({
          sessionId: "conflict-root",
          expectedUpdatedAt: 7,
          expectedTitle: "Conflict",
          expectedCwd: home,
        }),
      (error: unknown) => error instanceof DuplicateSessionMappingError,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("attachSession reuses a pre-existing mapping and reacquires its cooperative workspace claim", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.sessions = [
      {
        sessionId: "premapped-root",
        updatedAt: 8,
        running: false,
        blank: false,
        cwd: home,
        projections: { values: { title: "Premapped" } },
      },
    ];
    const tasks = new TaskStore(home);
    const preexisting = await tasks.create("premapped-root");
    const claims = new WorkspaceClaimStore(home);
    const canonicalHome = await realpath(home);
    await claims.acquire({
      canonicalCwd: canonicalHome,
      taskId: preexisting.taskId,
      sessionId: "premapped-root",
      mode: "exclusive-write",
    });
    await claims.release(preexisting.taskId);
    assert.equal(await claims.get(preexisting.taskId), undefined);
    const ledger = new EventLedger(home);
    const connection = new FakeConnection(ledger);
    const service = new BridgeService(config(home), api, tasks, connection, ledger, claims);

    const attached = await service.attachSession({
      sessionId: "premapped-root",
      expectedUpdatedAt: 8,
      expectedTitle: "Premapped",
      expectedCwd: home,
      workspaceMode: "exclusive-write",
    });

    assert.equal(attached.mappingCreated, false);
    assert.equal(attached.taskId, preexisting.taskId);
    assert.equal(attached.promptSent, false);
    assert.equal((await tasks.list()).length, 1);
    const claim = await claims.get(attached.taskId);
    assert.equal(claim?.mode, "exclusive-write");
    assert.equal(claim?.sessionId, "premapped-root");
    assert.equal(claim?.cwd, canonicalHome);
    for (const method of ["session.create", "session.prompt", "session.selectModel", "session.rename"]) {
      assert.equal(api.calls.some((call) => call.method === method), false, "unexpected " + method);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("attachSession maps an exact idle root without creating, prompting, or selecting a model", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.sessions = [
      {
        sessionId: "desktop-root",
        updatedAt: 123,
        running: false,
        blank: false,
        cwd: home,
        agentPreset: "code",
        projections: { values: { title: "DeepSeek常用技能插件整理" } },
      },
    ];
    const tasks = new TaskStore(home);
    const ledger = new EventLedger(home);
    const connection = new FakeConnection(ledger);
    const claims = new WorkspaceClaimStore(home);
    const service = new BridgeService(config(home), api, tasks, connection, ledger, claims);

    const attach = () =>
      service.attachSession({
        sessionId: "desktop-root",
        expectedUpdatedAt: 123,
        expectedTitle: "DeepSeek常用技能插件整理",
        expectedCwd: home,
        workspaceMode: "exclusive-write" as const,
      });
    const [attached, again] = await Promise.all([attach(), attach()]);

    assert.equal(attached.taskId, again.taskId);
    assert.equal([attached, again].filter((result) => result.mappingCreated).length, 1);
    assert.equal(attached.promptSent, false);
    assert.equal(attached.session.title, "DeepSeek常用技能插件整理");
    assert.equal((await claims.get(attached.taskId))?.mode, "exclusive-write");
    assert.equal((await tasks.list()).length, 1);
    assert.equal(connection.tracked.some((task) => task.taskId === attached.taskId), true);
    for (const method of ["session.create", "session.prompt", "session.selectModel", "session.rename"]) {
      assert.equal(api.calls.some((call) => call.method === method), false, `unexpected ${method}`);
    }

    const followup = await service.continueTask(attached.taskId, "continue the work", "queue");
    assert.equal(followup.accepted, true);
    const prompts = api.calls.filter((call) => call.method === "session.prompt");
    assert.equal(prompts.length, 1);
    assert.equal((prompts[0]?.payload as { sessionId: string }).sessionId, "desktop-root");
    assert.equal(api.calls.filter((call) => call.method === "session.create").length, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("attachSession fails closed on stale metadata, running sessions, and descendants", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.sessions = [
      {
        sessionId: "running-root",
        updatedAt: 3,
        running: true,
        blank: false,
        cwd: home,
        projections: { values: { title: "Running" } },
      },
      {
        sessionId: "child",
        parentSessionId: "running-root",
        origin: "subagent",
        updatedAt: 4,
        running: false,
        blank: false,
        cwd: home,
      },
      {
        sessionId: "idle-root",
        updatedAt: 5,
        running: false,
        blank: false,
        cwd: home,
        projections: { values: { title: "Current" } },
      },
    ];
    const tasks = new TaskStore(home);
    const ledger = new EventLedger(home);
    const service = new BridgeService(config(home), api, tasks, new FakeConnection(ledger), ledger);

    await assert.rejects(
      () =>
        service.attachSession({
          sessionId: "idle-root",
          expectedUpdatedAt: 4,
          expectedTitle: "Old",
          expectedCwd: home,
        }),
      (error: unknown) => error instanceof StaleViewError,
    );
    await assert.rejects(
      () => service.attachSession({ sessionId: "running-root", expectedUpdatedAt: 3, expectedTitle: "Running", expectedCwd: home }),
      (error: unknown) => error instanceof BridgeCapabilityError && error.code === "session_running",
    );
    await assert.rejects(
      () => service.attachSession({ sessionId: "child", expectedUpdatedAt: 4, expectedTitle: null, expectedCwd: home }),
      (error: unknown) => error instanceof BridgeCapabilityError && error.code === "session_not_root",
    );
    assert.deepEqual(await tasks.list(), []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("attachSession requires and enforces a null title precondition", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.sessions = [{ sessionId: "untitled-root", updatedAt: 9, running: false, blank: false, cwd: home }];
    const tasks = new TaskStore(home);
    const ledger = new EventLedger(home);
    const service = new BridgeService(config(home), api, tasks, new FakeConnection(ledger), ledger);

    const attached = await service.attachSession({
      sessionId: "untitled-root",
      expectedUpdatedAt: 9,
      expectedTitle: null,
      expectedCwd: home,
    });
    assert.equal(attached.session.title, null);

    await assert.rejects(
      () =>
        service.attachSession({
          sessionId: "untitled-root",
          expectedUpdatedAt: 9,
          expectedTitle: "stale title",
          expectedCwd: home,
        }),
      (error: unknown) => error instanceof StaleViewError,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("failed attach leaves no mapping or supervision after a workspace conflict", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.sessions = [
      {
        sessionId: "conflicting-root",
        updatedAt: 12,
        running: false,
        blank: false,
        cwd: home,
        projections: { values: { title: "Conflicting attach" } },
      },
    ];
    const tasks = new TaskStore(home);
    const ledger = new EventLedger(home);
    const connection = new FakeConnection(ledger);
    const claims = new WorkspaceClaimStore(home);
    const canonicalHome = await realpath(home);
    await claims.acquire({
      canonicalCwd: canonicalHome,
      taskId: "dsh_aaaaaaaaaaaa",
      sessionId: "blocking-session",
      mode: "exclusive-write",
    });
    const service = new BridgeService(config(home), api, tasks, connection, ledger, claims);

    await assert.rejects(
      () =>
        service.attachSession({
          sessionId: "conflicting-root",
          expectedUpdatedAt: 12,
          expectedTitle: "Conflicting attach",
          expectedCwd: home,
        }),
      (error: unknown) => error instanceof WorkspaceClaimConflictError && error.code === "workspace_conflict",
    );
    assert.deepEqual(await tasks.list(), []);
    assert.equal(connection.tracked.some((task) => task.sessionId === "conflicting-root"), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("delegate selects and verifies an explicit model profile before the first prompt", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.models = {
      current: { provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "high" },
      routable: true,
      groups: [
        {
          id: "deepseek-official",
          name: "DeepSeek",
          models: [{ id: "deepseek-v4-flash", name: "Flash" }],
        },
        {
          id: "deepseek-modlens",
          name: "DeepSeek ModLens",
          models: [
            {
              id: "deepseek-v4-pro",
              name: "Pro (modlens vision)",
              reasoning: {
                efforts: [{ id: "high", name: "High" }],
                defaultEffort: "high",
              },
            },
          ],
        },
      ],
      failures: [],
    };
    const tasks = new TaskStore(home);
    const ledger = new EventLedger(home);
    const service = new BridgeService(config(home), api, tasks, new FakeConnection(ledger), ledger);

    const delegated = await service.delegate({
      prompt: "Inspect the screenshot path in the prompt",
      cwd: home,
      modelProfile: "modlens-pro",
      reasoningEffort: "high",
      selectionReason: "Visual analysis plus a complex implementation",
    });

    const orderedMethods = api.calls.map((call) => call.method);
    const firstModels = orderedMethods.indexOf("session.models");
    const select = orderedMethods.indexOf("session.selectModel");
    const secondModels = orderedMethods.indexOf("session.models", firstModels + 1);
    const prompt = orderedMethods.indexOf("session.prompt");
    assert.equal(firstModels < select && select < secondModels && secondModels < prompt, true);
    assert.deepEqual(api.calls[select]?.payload, {
      sessionId: "root-session",
      provider: "deepseek-modlens",
      model: "deepseek-v4-pro",
      reasoningEffort: "high",
    });
    assert.deepEqual(delegated.model, {
      provider: "deepseek-modlens",
      model: "deepseek-v4-pro",
      reasoningEffort: "high",
    });
    assert.deepEqual(delegated.modelRouting, {
      mode: "selected",
      profile: "modlens-pro",
      requested: {
        provider: "deepseek-modlens",
        model: "deepseek-v4-pro",
        reasoningEffort: "high",
      },
      selected: {
        provider: "deepseek-modlens",
        model: "deepseek-v4-pro",
        reasoningEffort: "high",
      },
      selectionReason: "Visual analysis plus a complex implementation",
      persistsAsDshDefault: true,
      warning: "DSH session.selectModel also persists this selection as the DSH default for later sessions.",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("delegate leaves the configured model untouched when routing is omitted", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    const tasks = new TaskStore(home);
    const ledger = new EventLedger(home);
    const service = new BridgeService(config(home), api, tasks, new FakeConnection(ledger), ledger);

    const delegated = await service.delegate({ prompt: "Use the configured default", cwd: home });

    assert.equal(api.calls.some((call) => call.method === "session.selectModel"), false);
    assert.deepEqual(delegated.modelRouting, {
      mode: "inherited",
      profile: "inherit",
      selected: api.models.current,
      persistsAsDshDefault: false,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("delegate can change only the reasoning effort on the inherited route", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.models = {
      current: { provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "high" },
      routable: true,
      groups: [
        {
          id: "deepseek-official",
          name: "DeepSeek",
          models: [
            {
              id: "deepseek-v4-flash",
              name: "Flash",
              reasoning: {
                efforts: [
                  { id: "low", name: "Low" },
                  { id: "high", name: "High" },
                ],
                defaultEffort: "high",
              },
            },
          ],
        },
      ],
      failures: [],
    };
    const tasks = new TaskStore(home);
    const ledger = new EventLedger(home);
    const service = new BridgeService(config(home), api, tasks, new FakeConnection(ledger), ledger);

    const delegated = await service.delegate({ prompt: "Use less reasoning", cwd: home, reasoningEffort: "low" });

    const select = api.calls.find((call) => call.method === "session.selectModel");
    assert.deepEqual(select?.payload, {
      sessionId: "root-session",
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      reasoningEffort: "low",
    });
    assert.equal(delegated.modelRouting.mode, "selected");
    assert.equal(delegated.modelRouting.profile, "inherit");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("delegate preserves the mapping and never prompts when explicit model selection fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.models = {
      current: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      routable: true,
      groups: [
        {
          id: "deepseek-official",
          name: "DeepSeek",
          models: [{ id: "deepseek-v4-pro", name: "Pro" }],
        },
      ],
      failures: [],
    };
    api.sessionSelectModel = async (payload) => {
      api.calls.push({ method: "session.selectModel", payload });
      throw new DshRpcError("provider-failed", "route unavailable", {});
    };
    const tasks = new TaskStore(home);
    const ledger = new EventLedger(home);
    const service = new BridgeService(config(home), api, tasks, new FakeConnection(ledger), ledger);

    await assert.rejects(
      () => service.delegate({ prompt: "Use Pro", cwd: home, modelProfile: "pro" }),
      (error: unknown) =>
        error instanceof DelegationSetupError && error.stage === "model-selection" && error.taskId !== undefined,
    );
    assert.equal((await tasks.list()).length, 1);
    assert.equal(api.calls.some((call) => call.method === "session.prompt"), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("delegate fails closed when the Host does not activate the requested route", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.models = {
      current: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      routable: true,
      groups: [
        {
          id: "deepseek-official",
          name: "DeepSeek",
          models: [
            { id: "deepseek-v4-flash", name: "Flash" },
            { id: "deepseek-v4-pro", name: "Pro" },
          ],
        },
      ],
      failures: [],
    };
    const selectModel = api.sessionSelectModel.bind(api);
    api.sessionSelectModel = async (payload) => {
      const result = await selectModel(payload);
      api.models = {
        ...api.models,
        current: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      };
      return result;
    };
    const tasks = new TaskStore(home);
    const ledger = new EventLedger(home);
    const service = new BridgeService(config(home), api, tasks, new FakeConnection(ledger), ledger);

    await assert.rejects(
      () => service.delegate({ prompt: "Use Pro", cwd: home, modelProfile: "pro" }),
      (error: unknown) => error instanceof DelegationSetupError && error.stage === "model-selection",
    );
    assert.equal(api.calls.filter((call) => call.method === "session.models").length, 2);
    assert.equal(api.calls.some((call) => call.method === "session.prompt"), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("delegate read-only is only a bridge claim and does not mutate DSH permissions", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    const tasks = new TaskStore(home);
    const ledger = new EventLedger(home);
    const connection = new FakeConnection(ledger);
    const service = new BridgeService(config(home), api, tasks, connection, ledger);

    const delegated = await service.delegate({ prompt: "Inspect this", cwd: home, workspaceMode: "read-only" });
    const create = api.calls.find((call) => call.method === "session.create");
    const claim = await new WorkspaceClaimStore(home).get(delegated.taskId);

    assert.deepEqual(create?.payload, { cwd: await realpath(home) });
    assert.equal(api.calls.some((call) => /permission|sandbox/i.test(call.method)), false);
    assert.equal(claim?.mode, "read-only");
    assert.equal(delegated.workspaceClaimSemantics.controlsDshSandbox, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("delegate retains the task mapping when route verification fails and does not prompt", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.models = { ...api.models, routable: false };
    const tasks = new TaskStore(home);
    const ledger = new EventLedger(home);
    const service = new BridgeService(config(home), api, tasks, new FakeConnection(ledger), ledger);

    await assert.rejects(
      () => service.delegate({ prompt: "work", cwd: home }),
      (error: unknown) => error instanceof DelegationSetupError && error.stage === "models" && error.taskId !== undefined,
    );
    assert.equal((await tasks.list()).length, 1);
    assert.equal(api.calls.some((call) => call.method === "session.prompt"), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status separates availability from execution and reports terminal_missing_final", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.sessions = [{ sessionId: "root-session", updatedAt: 1, running: false, blank: false }];
    const tasks = new TaskStore(home);
    const task = await tasks.create("root-session");
    const ledger = new EventLedger(home);
    await ledger.append(task.taskId, {
      sourceSessionId: "root-session",
      sourceSeq: 0,
      origin: "root",
      type: "session/event",
      raw: { type: "session/event", sessionId: "root-session", event: { type: "turn/start", seq: 0, time: 1, data: { turn: 4 } } },
    });
    await ledger.append(task.taskId, {
      sourceSessionId: "root-session",
      sourceSeq: 1,
      origin: "root",
      type: "session/event",
      raw: {
        type: "session/event",
        sessionId: "root-session",
        event: { type: "turn/end", seq: 1, time: 2, data: { turn: 4, reason: { kind: "aborted", reason: { kind: "user" } } } },
      },
    });
    const connection = new FakeConnection(ledger);
    connection.lineage = [
      { sessionId: "root-session", found: true, origin: "root", running: false, blank: false, historyCapability: "session.history" },
    ];
    const service = new BridgeService(config(home), api, tasks, connection, ledger);

    const connected = await service.status(task.taskId);
    assert.equal(connected.availability, "connected");
    assert.equal(connected.workspaceClaimSemantics.controlsDshSandbox, false);
    assert.equal(connected.execution, "canceled");
    assert.equal(connected.status, "canceled");
    assert.equal(connected.finalMessage, null);
    assert.equal(connected.finalMessageStatus, "terminal_missing_final");
    assert.equal(connected.turn, null);

    connection.state = { ...connection.state, availability: "host_unreachable", revision: 2 };
    const unavailable = await service.status(task.taskId);
    assert.equal(unavailable.availability, "host_unreachable");
    assert.equal(unavailable.status, "unknown");
    assert.equal(unavailable.lastKnownExecutionStatus, "canceled");

    connection.state = { ...connection.state, availability: "connected", revision: 3 };
    connection.pending = [
      {
        type: "server-request",
        rpcId: "stale-question",
        method: "question/requested",
        payload: {
          type: "question/requested",
          sessionId: "root-session",
          questions: [{ id: "q", question: "stale" }],
        },
      },
    ];
    connection.queue = {
      known: true,
      stale: false,
      connectionEpoch: 1,
      items: [{ id: "stale-item", placement: "queued", message: { role: "user", content: [] } }],
    };
    connection.lineage = [
      { sessionId: "root-session", found: false, origin: "root", historyCapability: "session.history" },
    ];
    const missing = await service.status(task.taskId);
    assert.equal(missing.availability, "session_not_found");
    assert.equal(missing.status, "unknown");
    assert.deepEqual(missing.pendingInteractions, []);
    assert.deepEqual(missing.queueDepth, {
      known: false,
      stale: false,
      nextTurn: 0,
      nextStep: 0,
      steering: 0,
      context: 0,
      total: 0,
    });
    assert.equal(missing.running, null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status does not report a vanished active turn as still running after Host recovery", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.sessions = [{ sessionId: "root-session", updatedAt: 2, running: false, blank: false }];
    const tasks = new TaskStore(home);
    const task = await tasks.create("root-session");
    const ledger = new EventLedger(home);
    await ledger.append(task.taskId, {
      sourceSessionId: "root-session",
      sourceSeq: 0,
      origin: "root",
      type: "session/event",
      raw: {
        type: "session/event",
        sessionId: "root-session",
        event: { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } },
      },
    });
    const connection = new FakeConnection(ledger);
    connection.lineage = [
      {
        sessionId: "root-session",
        found: true,
        origin: "root",
        running: false,
        blank: false,
        historyCapability: "session.history",
      },
    ];
    const service = new BridgeService(config(home), api, tasks, connection, ledger);

    const status = await service.status(task.taskId);
    assert.equal(status.availability, "connected");
    assert.equal(status.execution, "interrupted");
    assert.equal(status.lastKnownExecutionStatus, "interrupted");
    assert.equal(status.finalMessageStatus, "terminal_missing_final");
    assert.equal((await ledger.snapshot(task.taskId)).lastKnownExecutionStatus, "interrupted");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("cancel turn preserves queue while cancel queue performs non-atomic per-item removals", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    const tasks = new TaskStore(home);
    const task = await tasks.create("root-session");
    const ledger = new EventLedger(home);
    const connection = new FakeConnection(ledger);
    connection.lineage = [
      { sessionId: "root-session", found: true, origin: "root", running: true, blank: false, historyCapability: "session.history" },
    ];
    connection.queue = {
      known: true,
      stale: false,
      connectionEpoch: 1,
      items: [
        { id: "one", placement: "queued", message: { role: "user", content: [] } },
        { id: "two", placement: "steering", message: { role: "user", content: [] } },
        { id: "three", placement: "context", message: { role: "user", content: [] } },
      ],
    };
    api.updateQueueErrors.set("two", new DshRpcError("queue-item-not-found", "claimed", { itemId: "two" }));
    api.updateQueueErrors.set("three", new Error("transport ambiguous"));
    const service = new BridgeService(config(home), api, tasks, connection, ledger);

    const turn = await service.cancel(task.taskId, "turn");
    assert.equal(turn.scope, "turn");
    assert.equal(turn.queuedMessagesPreserved, true);
    assert.equal(turn.runInBackgroundJobsPreserved, true);

    const queue = await service.cancel(task.taskId, "queue");
    assert.equal(queue.nonAtomic, true);
    assert.deepEqual(queue.requested, ["one", "two", "three"]);
    assert.deepEqual(queue.removed, ["one"]);
    assert.deepEqual(queue.alreadyClaimed, ["two"]);
    assert.equal(queue.failed.length, 1);
    assert.equal(api.calls.filter((call) => call.method === "session.updateQueue").length, 3);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("wait is bounded and tail returns task cursors plus current pending snapshot", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.sessions = [{ sessionId: "root-session", updatedAt: 1, running: false, blank: true }];
    const tasks = new TaskStore(home);
    const task = await tasks.create("root-session");
    const ledger = new EventLedger(home);
    const connection = new FakeConnection(ledger);
    connection.lineage = [
      { sessionId: "root-session", found: true, origin: "root", running: false, blank: true, historyCapability: "session.history" },
    ];
    const service = new BridgeService(config(home), api, tasks, connection, ledger);

    const waited = await service.wait(task.taskId, 1, 0);
    assert.equal(waited.timedOut, true);
    assert.equal(waited.status.execution, "starting");
    assert.equal(waited.nextCursor, 0);
    await assert.rejects(() => service.wait(task.taskId, 31), /between 0 and 30/);

    const tailed = await service.tail(task.taskId, 0, 10, 10_000);
    assert.deepEqual(tailed.events, []);
    assert.equal(tailed.nextCursor, 0);
    assert.equal(tailed.delivery.startsWith("at-least-once"), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("followup refreshes route state and rejects stale cursor or revision views before writing", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    const tasks = new TaskStore(home);
    const task = await tasks.create("root-session");
    await new WorkspaceClaimStore(home).acquire({
      canonicalCwd: home,
      taskId: task.taskId,
      sessionId: task.sessionId,
      mode: "exclusive-write",
    });
    const ledger = new EventLedger(home);
    await ledger.append(task.taskId, {
      sourceSessionId: "root-session",
      sourceSeq: 0,
      origin: "root",
      type: "session/event",
      raw: {
        type: "session/event",
        sessionId: "root-session",
        event: {
          type: "user/message",
          seq: 0,
          time: 1,
          data: { content: [{ type: "text", text: "external web change" }], source: { kind: "user" } },
        },
      },
    });
    const connection = new FakeConnection(ledger);
    connection.lineage = [
      { sessionId: "root-session", found: true, origin: "root", running: true, blank: false, historyCapability: "session.history" },
    ];
    const service = new BridgeService(config(home), api, tasks, connection, ledger);

    await assert.rejects(
      () => service.continueTask(task.taskId, "write", "queue", { sinceCursor: 0 }),
      (error: unknown) =>
        error instanceof StaleViewError &&
        error.code === "stale_view" &&
        error.details.currentCursor === 1,
    );
    await assert.rejects(
      () => service.continueTask(task.taskId, "write", "queue", { expectedRevision: 0 }),
      (error: unknown) => error instanceof StaleViewError,
    );
    assert.equal(api.calls.some((call) => call.method === "session.prompt"), false);

    const result = await service.continueTask(task.taskId, "write", "queue", {
      sinceCursor: 1,
      expectedRevision: 1,
    });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.model, api.models.current);
    assert.deepEqual(result.modelRouting, {
      mode: "inherited",
      profile: "inherit",
      selected: api.models.current,
      persistsAsDshDefault: false,
    });
    assert.equal(api.calls.some((call) => call.method === "session.selectModel"), false);
    assert.equal(typeof result.issuedRpcId, "string");
    assert.equal((await ledger.tail(task.taskId, 0, 10)).records.some((record) => record.type === "bridge/prompt-issued"), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("followup selects and verifies an explicit model route before prompting", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.models = {
      current: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      routable: true,
      groups: [
        {
          id: "deepseek-modlens",
          name: "ModLens",
          models: [
            {
              id: "deepseek-v4-pro",
              name: "Pro",
              reasoning: { efforts: [{ id: "high", name: "High" }], defaultEffort: "high" },
            },
          ],
        },
      ],
      failures: [],
    };
    const tasks = new TaskStore(home);
    const task = await tasks.create("root-session");
    await new WorkspaceClaimStore(home).acquire({
      canonicalCwd: home,
      taskId: task.taskId,
      sessionId: task.sessionId,
      mode: "exclusive-write",
    });
    const ledger = new EventLedger(home);
    const connection = new FakeConnection(ledger);
    connection.lineage = [
      { sessionId: "root-session", found: true, origin: "root", running: false, blank: false, historyCapability: "session.history" },
    ];
    const service = new BridgeService(config(home), api, tasks, connection, ledger);

    const result = await service.continueTask(task.taskId, "analyze the image", "queue", {
      modelProfile: "modlens-pro",
      reasoningEffort: "high",
      selectionReason: "Visual analysis needs ModLens Pro",
    });

    assert.deepEqual(
      api.calls.filter((call) => ["session.models", "session.selectModel", "session.prompt"].includes(call.method)).map((call) => call.method),
      ["session.models", "session.selectModel", "session.models", "session.prompt"],
    );
    assert.deepEqual(result.modelRouting, {
      mode: "selected",
      profile: "modlens-pro",
      requested: { provider: "deepseek-modlens", model: "deepseek-v4-pro", reasoningEffort: "high" },
      selected: { provider: "deepseek-modlens", model: "deepseek-v4-pro", reasoningEffort: "high" },
      selectionReason: "Visual analysis needs ModLens Pro",
      persistsAsDshDefault: true,
      warning: "DSH session.selectModel also persists this selection as the DSH default for later sessions.",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("followup fails closed without prompting when route verification fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.models = {
      current: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      routable: true,
      groups: [
        {
          id: "deepseek-official",
          name: "DeepSeek",
          models: [{ id: "deepseek-v4-pro", name: "Pro" }],
        },
      ],
      failures: [],
    };
    const selectModel = api.sessionSelectModel.bind(api);
    api.sessionSelectModel = async (payload) => {
      const receipt = await selectModel(payload);
      api.models = { ...api.models, current: { provider: "deepseek-official", model: "deepseek-v4-flash" } };
      return receipt;
    };
    const tasks = new TaskStore(home);
    const task = await tasks.create("root-session");
    await new WorkspaceClaimStore(home).acquire({
      canonicalCwd: home,
      taskId: task.taskId,
      sessionId: task.sessionId,
      mode: "exclusive-write",
    });
    const ledger = new EventLedger(home);
    const connection = new FakeConnection(ledger);
    connection.lineage = [
      { sessionId: "root-session", found: true, origin: "root", running: false, blank: false, historyCapability: "session.history" },
    ];
    const service = new BridgeService(config(home), api, tasks, connection, ledger);

    await assert.rejects(
      () => service.continueTask(task.taskId, "must not send", "queue", { modelProfile: "pro" }),
      (error: unknown) =>
        error instanceof FollowupRoutingError &&
        error.code === "followup_model_selection_failed" &&
        error.details.modelSelectionMayHavePersisted === true,
    );
    assert.equal(api.calls.some((call) => call.method === "session.prompt"), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("followup reports model persistence when the routed prompt transport fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.models = {
      current: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      routable: true,
      groups: [
        {
          id: "deepseek-official",
          name: "DeepSeek",
          models: [{ id: "deepseek-v4-pro", name: "Pro" }],
        },
      ],
      failures: [],
    };
    api.sessionPrompt = async (payload) => {
      api.calls.push({ method: "session.prompt", payload });
      throw new Error("response lost");
    };
    const tasks = new TaskStore(home);
    const task = await tasks.create("root-session");
    await new WorkspaceClaimStore(home).acquire({
      canonicalCwd: home,
      taskId: task.taskId,
      sessionId: task.sessionId,
      mode: "exclusive-write",
    });
    const ledger = new EventLedger(home);
    const connection = new FakeConnection(ledger);
    connection.lineage = [
      { sessionId: "root-session", found: true, origin: "root", running: false, blank: false, historyCapability: "session.history" },
    ];
    const service = new BridgeService(config(home), api, tasks, connection, ledger);

    await assert.rejects(
      () => service.continueTask(task.taskId, "may have been accepted", "queue", { modelProfile: "pro" }),
      (error: unknown) =>
        error instanceof FollowupPromptError &&
        error.details.modelSelectionPersisted === true &&
        error.details.promptMayHaveBeenAccepted === true,
    );
    assert.equal(api.calls.filter((call) => call.method === "session.prompt").length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("status and tail hydrate conversation content from live DSH history without persisting it", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-service-"));
  try {
    const api = new FakeDshApi();
    api.sessions = [{ sessionId: "root-session", updatedAt: 1, running: false, blank: false }];
    const tasks = new TaskStore(home);
    const task = await tasks.create("root-session");
    const ledger = new EventLedger(home);
    const entries = [
      { event: { type: "turn/start", seq: 0, time: 1, data: { turn: 1 } } },
      {
        event: {
          type: "assistant/message",
          seq: 1,
          time: 2,
          data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "live final only" }] } },
        },
      },
      { event: { type: "turn/end", seq: 2, time: 3, data: { turn: 1, reason: { kind: "completed" } } } },
    ];
    for (const entry of entries) {
      await ledger.append(task.taskId, {
        sourceSessionId: "root-session",
        sourceSeq: entry.event.seq,
        origin: "root",
        type: "session/event",
        raw: { type: "session/event", sessionId: "root-session", event: entry.event },
      });
    }
    const connection = new FakeConnection(ledger);
    connection.lineage = [
      { sessionId: "root-session", found: true, origin: "root", running: false, blank: false, historyCapability: "session.history" },
    ];
    connection.histories.set("root-session", { events: entries, hasMore: false });
    const service = new BridgeService(config(home), api, tasks, connection, ledger);

    const status = await service.status(task.taskId);
    assert.equal(status.finalMessage, "live final only");
    assert.deepEqual(status.finalMessagePointer, { sessionId: "root-session", seq: 1 });
    assert.equal(status.contentUnavailable, false);
    const tail = await service.tail(task.taskId, 0, 10, 10_000);
    assert.equal(
      tail.events.some((event) => JSON.stringify(event.digest).includes("live final only")),
      true,
    );
    assert.equal((await readFile(status.logPath, "utf8")).includes("live final only"), false);

    connection.state = { ...connection.state, availability: "host_unreachable", revision: 2 };
    const offline = await service.status(task.taskId);
    assert.equal(offline.finalMessage, null);
    assert.deepEqual(offline.finalMessagePointer, { sessionId: "root-session", seq: 1 });
    assert.notEqual(offline.contentUnavailable, false);
    const offlineTail = await service.tail(task.taskId, 0, 10, 10_000);
    assert.notEqual(offlineTail.contentUnavailable, false);
    assert.equal(offlineTail.events.some((event) => JSON.stringify(event.digest).includes("live final only")), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
