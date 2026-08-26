import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { BridgeService } from "../src/bridge-service.js";
import type { BridgeConfig } from "../src/config.js";
import { EventLedger } from "../src/event-ledger.js";
import { createMcpServer, serverInstructions } from "../src/mcp-server.js";
import { TaskStore } from "../src/task-store.js";
import { WorkspaceClaimStore } from "../src/workspace-claim.js";
import { FakeConnection, FakeDshApi } from "./support/fakes.js";

function parseToolText(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("expected text tool result");
  return JSON.parse(block.text) as Record<string, unknown>;
}

test("MCP server exposes semantic delegate routing while rejecting arbitrary model arguments", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-mcp-"));
  const delegatedCwd = await mkdtemp(join(tmpdir(), "codex-dsh-delegated-"));
  const attachedCwd = await mkdtemp(join(tmpdir(), "codex-dsh-attached-"));
  const api = new FakeDshApi();
  api.sessions = [
    { sessionId: "root-session", updatedAt: Date.now(), running: false, blank: true },
    {
      sessionId: "desktop-existing",
      updatedAt: 42,
      running: false,
      blank: false,
      cwd: attachedCwd,
      projections: { values: { title: "Existing Desktop task" } },
    },
  ];
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
    { sessionId: "root-session", found: true, origin: "root", running: false, blank: true, historyCapability: "session.history" },
  ];
  const config: BridgeConfig = {
    hostUrl: "http://127.0.0.1:3080",
    homeDir: home,
    requestTimeoutMs: 1_000,
    allowRemoteHost: false,
  };
  const service = new BridgeService(config, api, tasks, connection, ledger);
  const server = createMcpServer(service);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /compact handoff/i);
    assert.match(instructions, /objective.*completed work.*Git HEAD.*status.*changed paths/i);
    assert.match(instructions, /focus.*tests.*constraints.*unresolved issues/i);
    assert.match(instructions, /secrets.*large diffs.*file bodies.*internal reasoning/i);
    assert.match(instructions, /same known BridgeTask.*dsh_followup/i);
    assert.match(instructions, /never guess.*task id/i);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    for (const expected of [
      "dsh_host_status",
      "dsh_find_sessions",
      "dsh_attach_session",
      "dsh_delegate",
      "dsh_followup",
      "dsh_continue",
      "dsh_status",
      "dsh_tail",
      "dsh_wait",
      "dsh_observe",
      "dsh_cancel",
      "dsh_list",
      "dsh_release_workspace",
      "dsh_answer_question",
      "dsh_resolve_approval",
    ]) {
      assert.equal(names.includes(expected), true, `missing ${expected}`);
    }
    const approval = tools.tools.find((tool) => tool.name === "dsh_resolve_approval");
    assert.equal(approval?.annotations?.destructiveHint, true);
    assert.equal(approval?.annotations?.idempotentHint, false);
    assert.deepEqual(approval?._meta, { "anthropic/requiresUserInteraction": true });
    const delegateTool = tools.tools.find((tool) => tool.name === "dsh_delegate");
    assert.match(delegateTool?.description ?? "", /bridge-local cooperative claim/);
    assert.match(delegateTool?.description ?? "", /explicit user choice/i);
    assert.match(delegateTool?.description ?? "", /persists.*DSH default/i);
    assert.match(delegateTool?.description ?? "", /compact handoff/i);
    assert.match(delegateTool?.description ?? "", /focus paths first/i);
    assert.match(JSON.stringify(delegateTool?.inputSchema), /not a DSH Host filesystem sandbox selector/);
    assert.match(JSON.stringify(delegateTool?.inputSchema), /modlens-pro/);
    const followupTool = tools.tools.find((tool) => tool.name === "dsh_followup");
    assert.match(followupTool?.description ?? "", /same known BridgeTask/i);
    assert.match(followupTool?.description ?? "", /never guess.*task id/i);
    assert.match(followupTool?.description ?? "", /persiste.*DSH global default/i);
    assert.match(JSON.stringify(followupTool?.inputSchema), /modlens-pro/);
    const findTool = tools.tools.find((tool) => tool.name === "dsh_find_sessions");
    assert.equal(findTool?.annotations?.readOnlyHint, true);
    assert.match(findTool?.description ?? "", /metadata/i);
    const attachTool = tools.tools.find((tool) => tool.name === "dsh_attach_session");
    assert.equal(attachTool?.annotations?.readOnlyHint, false);
    assert.match(attachTool?.description ?? "", /exact sessionId/i);
    assert.match(attachTool?.description ?? "", /does not prompt/i);
    const attachSchema = attachTool?.inputSchema as { required?: string[] } | undefined;
    assert.equal(attachSchema?.required?.includes("expectedTitle"), true);
    assert.match(JSON.stringify(attachSchema), /including null when no title is present/);

    const found = await client.callTool({
      name: "dsh_find_sessions",
      arguments: { title: "Existing Desktop task", titleMatch: "exact" },
    });
    const foundBody = parseToolText(found);
    assert.equal((foundBody.sessions as Array<{ sessionId: string }>)[0]?.sessionId, "desktop-existing");
    const attached = await client.callTool({
      name: "dsh_attach_session",
      arguments: {
        sessionId: "desktop-existing",
        expectedUpdatedAt: 42,
        expectedTitle: "Existing Desktop task",
        expectedCwd: attachedCwd,
        workspaceMode: "exclusive-write",
      },
    });
    assert.equal(attached.isError, undefined);
    const attachedBody = parseToolText(attached);
    assert.equal(attachedBody.promptSent, false);

    const promptsBeforeInvalidFollowup = api.calls.filter((call) => call.method === "session.prompt").length;
    const invalidFollowup = await client.callTool({
      name: "dsh_followup",
      arguments: { taskId: attachedBody.taskId, prompt: "must not send", model: "raw-provider/model" },
    });
    assert.equal(invalidFollowup.isError, true);
    assert.equal(api.calls.filter((call) => call.method === "session.prompt").length, promptsBeforeInvalidFollowup);

    api.models = {
      current: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      routable: true,
      groups: [
        {
          id: "deepseek-modlens",
          name: "ModLens",
          models: [{ id: "deepseek-v4-flash", name: "Flash" }],
        },
      ],
      failures: [],
    };
    const routedFollowup = await client.callTool({
      name: "dsh_followup",
      arguments: {
        taskId: attachedBody.taskId,
        prompt: "inspect visual evidence",
        modelProfile: "modlens-flash",
        selectionReason: "Visual evidence is required",
      },
    });
    assert.equal(routedFollowup.isError, undefined);
    assert.deepEqual(parseToolText(routedFollowup).modelRouting, {
      mode: "selected",
      profile: "modlens-flash",
      requested: { provider: "deepseek-modlens", model: "deepseek-v4-flash" },
      selected: { provider: "deepseek-modlens", model: "deepseek-v4-flash" },
      selectionReason: "Visual evidence is required",
      persistsAsDshDefault: true,
      warning: "DSH session.selectModel also persists this selection as the DSH default for later sessions.",
    });

    const invalidDelegate = await client.callTool({
        name: "dsh_delegate",
        arguments: { prompt: "work", cwd: home, model: "must-not-be-accepted" },
      });
    assert.equal(invalidDelegate.isError, true);
    assert.equal(api.calls.some((call) => call.method === "session.create"), false);

    api.nextSessionId = "delegated-session";
    api.models = {
      current: { provider: "deepseek-official", model: "deepseek-v4-flash" },
      routable: true,
      groups: [
        {
          id: "deepseek-official",
          name: "DeepSeek",
          models: [
            {
              id: "deepseek-v4-pro",
              name: "Pro",
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
    const explicitDelegate = await client.callTool({
      name: "dsh_delegate",
      arguments: {
        prompt: "complex task",
        cwd: delegatedCwd,
        modelProfile: "pro",
        reasoningEffort: "high",
        selectionReason: "User explicitly requested Pro",
      },
    });
    assert.equal(explicitDelegate.isError, undefined);
    assert.deepEqual(parseToolText(explicitDelegate).modelRouting, {
      mode: "selected",
      profile: "pro",
      requested: { provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "high" },
      selected: { provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "high" },
      selectionReason: "User explicitly requested Pro",
      persistsAsDshDefault: true,
      warning: "DSH session.selectModel also persists this selection as the DSH default for later sessions.",
    });
    connection.lineage = [
      { sessionId: "root-session", found: true, origin: "root", running: false, blank: true, historyCapability: "session.history" },
      {
        sessionId: "delegated-session",
        found: true,
        origin: "root",
        running: true,
        blank: false,
        historyCapability: "session.history",
      },
    ];

    const question = await client.callTool({
      name: "dsh_answer_question",
      arguments: {
        taskId: task.taskId,
        requestId: "question-1",
        answers: [{ id: "q1", selected: ["yes"] }],
      },
    });
    assert.deepEqual(parseToolText(question), {
      requestId: "question-1",
      answers: [{ id: "q1", selected: ["yes"] }],
    });

    const status = await client.callTool({ name: "dsh_status", arguments: { taskId: task.taskId } });
    assert.deepEqual(parseToolText(status).workspaceClaimSemantics, {
      enforcement: "bridge-cooperative-only",
      controlsDshSandbox: false,
      description:
        "workspaceMode is a bridge-local coordination claim shared only by bridge processes using the same bridge home; it does not select, enforce, or verify the DSH Host filesystem sandbox.",
    });

    const approvalResult = await client.callTool({
      name: "dsh_resolve_approval",
      arguments: { taskId: task.taskId, requestId: "approval-1", outcome: "reject" },
    });
    assert.deepEqual(parseToolText(approvalResult), { requestId: "approval-1", outcome: "reject" });

    connection.queue = { known: false, stale: true, connectionEpoch: 1, items: [] };
    const failure = await client.callTool({
      name: "dsh_cancel",
      arguments: { taskId: task.taskId, scope: "queue" },
    });
    assert.equal(failure.isError, true);
    assert.equal(parseToolText(failure).code, "queue_snapshot_unavailable");
  } finally {
    await client.close();
    await server.close();
    await rm(attachedCwd, { recursive: true, force: true });
    await rm(delegatedCwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP server exposes bounded reuse discovery on dsh_find_sessions without history or mutation", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-mcp-"));
  const requestedCwd = await mkdtemp(join(tmpdir(), "codex-dsh-mcp-requested-"));
  const otherCwd = await mkdtemp(join(tmpdir(), "codex-dsh-mcp-other-"));
  const api = new FakeDshApi();
  api.sessions = [
    {
      sessionId: "mapped-idle-exact",
      updatedAt: 30,
      running: false,
      blank: false,
      cwd: requestedCwd,
      projections: { values: { title: "Reuse candidate" } },
    },
    { sessionId: "mapped-idle-other", updatedAt: 25, running: false, blank: false, cwd: otherCwd },
    { sessionId: "unmapped-idle-exact", updatedAt: 20, running: false, blank: false, cwd: requestedCwd },
    { sessionId: "mapped-running-exact", updatedAt: 15, running: true, blank: false, cwd: requestedCwd },
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
  const ledger = new EventLedger(home);
  const config: BridgeConfig = {
    hostUrl: "http://127.0.0.1:3080",
    homeDir: home,
    requestTimeoutMs: 1_000,
    allowRemoteHost: false,
  };
  const service = new BridgeService(config, api, tasks, new FakeConnection(ledger), ledger);
  const server = createMcpServer(service);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const instructions = client.getInstructions() ?? "";
    assert.match(instructions, /same known BridgeTask for the same workstream/i);
    assert.match(instructions, /narrow candidates by exact cwd\/mapping\/idle state/i);
    assert.match(instructions, /ambiguous or merely similar candidates must not be guessed/i);

    const tools = await client.listTools();
    const findTool = tools.tools.find((tool) => tool.name === "dsh_find_sessions");
    const findSchemaText = JSON.stringify(findTool?.inputSchema);
    assert.match(findSchemaText, /cwd/);
    assert.match(findSchemaText, /mappedOnly/);
    assert.match(findSchemaText, /idleOnly/);
    assert.equal(findTool?.annotations?.readOnlyHint, true);
    assert.match(findTool?.description ?? "", /narrow candidates/i);
    assert.match(findTool?.description ?? "", /never authorize/i);

    const callsBefore = api.calls.length;
    const found = await client.callTool({
      name: "dsh_find_sessions",
      arguments: { cwd: requestedCwd, mappedOnly: true, idleOnly: true, maxResults: 10 },
    });
    assert.equal(found.isError, undefined);
    const foundBody = parseToolText(found);
    assert.deepEqual(
      (foundBody.sessions as Array<{ sessionId: string }>).map((session) => session.sessionId),
      ["mapped-idle-exact"],
    );
    assert.equal(foundBody.metadataOnly, true);
    assert.equal(foundBody.conversationHistoryRead, false);
    for (const method of ["session.history", "session.create", "session.prompt", "session.rename", "session.selectModel"]) {
      assert.equal(api.calls.some((call) => call.method === method), false, "unexpected " + method);
    }
    assert.deepEqual(api.calls.slice(callsBefore).map((call) => call.method), ["session.list"]);

    const beforeRelative = api.calls.length;
    const relative = await client.callTool({ name: "dsh_find_sessions", arguments: { cwd: "relative/path" } });
    assert.equal(relative.isError, true);
    assert.equal(api.calls.length, beforeRelative);

    const beforeMissing = api.calls.length;
    const missing = await client.callTool({ name: "dsh_find_sessions", arguments: { cwd: join(home, "no-such-dir") } });
    assert.equal(missing.isError, true);
    assert.equal(api.calls.length, beforeMissing);
  } finally {
    await client.close();
    await server.close();
    await rm(requestedCwd, { recursive: true, force: true });
    await rm(otherCwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("MCP initialization instructions document the cross-task reuse decision seam", () => {
  assert.match(serverInstructions, /metadata-only/i);
  assert.match(serverInstructions, /exact canonical cwd/i);
  assert.match(serverInstructions, /mappedOnly/);
  assert.match(serverInstructions, /idleOnly/);
  assert.match(serverInstructions, /explicit continuation evidence/i);
  assert.match(serverInstructions, /exactly one unique candidate/i);
  assert.match(serverInstructions, /by title or similarity/i);
  assert.match(serverInstructions, /dsh_attach_session/);
  assert.match(serverInstructions, /dsh_followup/);
  assert.match(serverInstructions, /fresh delegation/i);
  assert.match(serverInstructions, /no safe explicit continuation/i);
  assert.doesNotMatch(
    serverInstructions,
    /A new caller task without a known matching BridgeTask or an explicitly identified existing DSH session must start a fresh delegation/i,
  );
});

test("MCP delegate and followup expose the visual routing contract with a fail-closed user choice", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-dsh-mcp-visual-"));
  const delegatedCwd = await mkdtemp(join(tmpdir(), "codex-dsh-mcp-visual-cwd-"));
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
          {
            id: "deepseek-v4-flash-vision-exp",
            name: "DeepSeek-V4-Flash-Vision-Exp",
            reasoning: { efforts: [{ id: "high", name: "High" }], defaultEffort: "high" },
          },
        ],
      },
      {
        id: "deepseek-modlens",
        name: "DeepSeek (modlens vision)",
        models: [
          { id: "deepseek-v4-flash", name: "Flash (modlens vision)" },
          { id: "deepseek-v4-pro", name: "Pro (modlens vision)" },
        ],
      },
    ],
    failures: [],
  };
  const tasks = new TaskStore(home);
  const ledger = new EventLedger(home);
  const connection = new FakeConnection(ledger);
  const config: BridgeConfig = {
    hostUrl: "http://127.0.0.1:3080",
    homeDir: home,
    requestTimeoutMs: 1_000,
    allowRemoteHost: false,
  };
  const service = new BridgeService(config, api, tasks, connection, ledger);
  const server = createMcpServer(service);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const tools = await client.listTools();
    const delegateTool = tools.tools.find((tool) => tool.name === "dsh_delegate");
    assert.match(JSON.stringify(delegateTool?.inputSchema), /visualIntent/);
    assert.match(JSON.stringify(delegateTool?.inputSchema), /complexity/);
    assert.match(delegateTool?.description ?? "", /visual low selects the official native Flash Vision/i);
    assert.match(delegateTool?.description ?? "", /modlens-flash is never a first visual choice/i);
    assert.match(delegateTool?.description ?? "", /declare visualIntent=required/i);
    assert.doesNotMatch(delegateTool?.description ?? "", /a modlens profile for visual work/i);
    const followupTool = tools.tools.find((tool) => tool.name === "dsh_followup");
    assert.match(JSON.stringify(followupTool?.inputSchema), /visualIntent/);
    assert.match(JSON.stringify(followupTool?.inputSchema), /complexity/);
    assert.match(followupTool?.description ?? "", /ModLens Flash exactly once/i);

    const choiceRequired = await client.callTool({
      name: "dsh_delegate",
      arguments: { prompt: "complex visual work", cwd: delegatedCwd, visualIntent: "required", complexity: "high" },
    });
    assert.equal(choiceRequired.isError, true);
    const choiceBody = parseToolText(choiceRequired);
    assert.equal(choiceBody.code, "user_choice_required");
    assert.deepEqual((choiceBody.details as { choices: string[] }).choices, ["official-flash-vision", "modlens-pro"]);
    assert.equal(api.calls.length, 0);

    const visualLow = await client.callTool({
      name: "dsh_delegate",
      arguments: { prompt: "visual low work", cwd: delegatedCwd, visualIntent: "required", complexity: "low" },
    });
    assert.equal(visualLow.isError, undefined);
    const lowBody = parseToolText(visualLow);
    assert.deepEqual(lowBody.visualRouting, {
      visualIntent: "required",
      complexity: "low",
      decision: "official-flash-vision",
      fallback: null,
    });
    const lowRouting = lowBody.modelRouting as { profile: string };
    assert.equal(lowRouting.profile, "official-flash-vision");
    const select = api.calls.find((call) => call.method === "session.selectModel");
    assert.deepEqual(select?.payload, {
      sessionId: "root-session",
      provider: "deepseek-official",
      model: "deepseek-v4-flash-vision-exp",
      reasoningEffort: "high",
    });
  } finally {
    await client.close();
    await server.close();
    await rm(delegatedCwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
