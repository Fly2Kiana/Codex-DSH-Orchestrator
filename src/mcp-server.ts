import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { BridgeService, FollowupOptions, WritePreconditions } from "./bridge-service.js";
import { DelegationSetupError } from "./bridge-service.js";
import { PendingInteractionError } from "./connection-manager.js";
import { DshRpcError, DshTransportError } from "./dsh-client.js";
import { EventLedgerError } from "./event-ledger.js";
import { modelProfiles, type Complexity, type VisualIntent } from "./model-routing.js";
import { PACKAGE_VERSION } from "./version.js";

const taskIdSchema = z.string().regex(/^dsh_[a-f0-9]{12}$/);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const writeOnce = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

export const serverInstructions =
  "Before dsh_delegate, build a compact handoff in prompt from known progress and read-only workspace evidence: objective, completed work, Git HEAD/status and changed paths when available, focus paths, relevant tests, constraints, and unresolved issues. Tell DSH to read focus paths first and avoid repo-wide scanning unless blocked. Never include secrets, raw large diffs, file bodies, Codex chat, or internal reasoning. User context and routes win. For the same known BridgeTask use dsh_followup; never guess an old task id. Reuse the same known BridgeTask for the same workstream; across caller tasks, metadata discovery may narrow candidates by exact cwd/mapping/idle state, but ambiguous or merely similar candidates must not be guessed. " +
  "For a new Codex caller with explicit continuation evidence, use metadata-only dsh_find_sessions with the exact canonical cwd plus mappedOnly and idleOnly; require exactly one unique candidate and fresh exact sessionId/updatedAt/cwd/title preconditions before dsh_attach_session in exclusive-write mode, then use dsh_followup on the same BridgeTask. Only when there is no known task and no safe explicit continuation should the caller use fresh delegation; never select by title or similarity. " +
  "When the user explicitly identifies an existing DSH Desktop session, call dsh_find_sessions, require one intended root result, then attach using its exact sessionId plus the returned updatedAt/cwd/title preconditions. Never attach by title alone or guess an id. dsh_attach_session does not prompt or change the model; send a compact handoff with dsh_followup only after attachment. If that follow-up explicitly routes a model, apply the same user-priority/catalog-validation rules as delegation and disclose that session.selectModel persists the DSH global default. " +
  "Only when there is no known matching BridgeTask and no safe explicit continuation evidence should the caller use fresh delegation. This is caller guidance, not new filesystem authorization; dsh-Agentlink does not receive prior caller conversation state automatically. " +
  "For visual work, declare visualIntent=required with complexity. Visual low complexity routes to the official native Flash Vision. Visual high complexity requires an explicit user choice between modelProfile official-flash-vision and modlens-pro; never choose silently. modlens-flash is never a first visual choice under the declared visual policy: only after the approved visual route exhausts bounded retries caused by timeout, unreachable Host, or HTTP 5xx does the bridge attempt ModLens Flash once. If visual policy fields are omitted, an explicitly supplied legacy modlens-flash route remains compatible. If a delegate or followup result reports visualRouting.fallback.used=true, briefly tell the user at task end using the short non-sensitive notice the result provides.";

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorBody(error: unknown): Record<string, unknown> {
  if (error instanceof DshRpcError) {
    return { error: error.name, code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof DshTransportError) {
    return { error: error.name, code: "host_unreachable", message: error.message };
  }
  if (error instanceof PendingInteractionError) {
    return { error: error.name, code: error.code, message: error.message };
  }
  if (error instanceof EventLedgerError) {
    return { error: error.name, code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof DelegationSetupError) {
    return {
      error: error.name,
      code: "delegation_setup_failed",
      stage: error.stage,
      message: error.message,
      sessionId: error.sessionId,
      taskId: error.taskId,
      ...(error.failureClass === undefined ? {} : { failureClass: error.failureClass }),
    };
  }
  if (error instanceof Error) {
    const extra = "code" in error && typeof error.code === "string" ? { code: error.code } : {};
    const details = "details" in error ? { details: error.details } : {};
    return { error: error.name, ...extra, message: error.message, ...details };
  }
  return { error: "UnknownError", message: String(error) };
}

function failure(error: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(errorBody(error), null, 2) }] };
}

function writePreconditions(sinceCursor?: number, expectedRevision?: number): WritePreconditions {
  return {
    ...(sinceCursor === undefined ? {} : { sinceCursor }),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
}

function followupOptions(input: {
  sinceCursor?: number | undefined;
  expectedRevision?: number | undefined;
  modelProfile?: (typeof modelProfiles)[number] | undefined;
  reasoningEffort?: string | undefined;
  selectionReason?: string | undefined;
  visualIntent?: VisualIntent | undefined;
  complexity?: Complexity | undefined;
}): FollowupOptions {
  return {
    ...writePreconditions(input.sinceCursor, input.expectedRevision),
    ...(input.modelProfile === undefined ? {} : { modelProfile: input.modelProfile }),
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    ...(input.selectionReason === undefined ? {} : { selectionReason: input.selectionReason }),
    ...(input.visualIntent === undefined ? {} : { visualIntent: input.visualIntent }),
    ...(input.complexity === undefined ? {} : { complexity: input.complexity }),
  };
}

async function handled<T>(operation: () => Promise<T>) {
  try {
    return result(await operation());
  } catch (error) {
    return failure(error);
  }
}

export function createMcpServer(service: BridgeService): McpServer {
  const server = new McpServer(
    { name: "dsh-agentlink", version: PACKAGE_VERSION },
    { instructions: serverInstructions },
  );

  server.registerTool(
    "dsh_host_status",
    {
      description: "Report the connect-only bridge state and current official DSH Web Host capabilities.",
      inputSchema: z.object({}).strict(),
      annotations: readOnly,
    },
    async () => handled(() => service.hostStatus()),
  );

  server.registerTool(
    "dsh_find_sessions",
    {
      description:
        "Read bounded metadata for existing root sessions from DSH session.list. It can filter titles exactly or by a case-sensitive substring, or narrow candidates by an exact canonical cwd, an unambiguous BridgeTask mapping, or idle state; it returns no history or raw projections. These filters narrow candidates but never authorize automatic selection, history reads, attachment, or prompting. Use the returned exact sessionId and precondition fields with dsh_attach_session; never select a session by title alone.",
      inputSchema: z
        .object({
          title: z.string().trim().min(1).optional(),
          titleMatch: z.enum(["exact", "contains"]).default("exact"),
          cwd: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Optional absolute existing workspace path; matches only sessions whose advertised cwd resolves to the same canonical directory.",
            ),
          mappedOnly: z
            .boolean()
            .default(false)
            .describe("Return only sessions with one unambiguous existing BridgeTask mapping."),
          idleOnly: z
            .boolean()
            .default(false)
            .describe("Return only sessions whose root turn is not running."),
          includeBlank: z.boolean().default(false),
          maxResults: z.number().int().min(1).max(50).default(20),
        })
        .strict(),
      annotations: readOnly,
    },
    async ({ title, titleMatch, cwd, mappedOnly, idleOnly, includeBlank, maxResults }) =>
      handled(() =>
        service.findSessions({
          titleMatch,
          mappedOnly,
          idleOnly,
          includeBlank,
          maxResults,
          ...(title === undefined ? {} : { title }),
          ...(cwd === undefined ? {} : { cwd }),
        }),
      ),
  );

  server.registerTool(
    "dsh_attach_session",
    {
      description:
        "Attach one idle existing root DSH session to the bridge using its exact sessionId and fresh discovery preconditions. This creates or reuses bridge-local mapping/claim state and starts normal supervision reconciliation: it does not prompt DSH, create or rename a DSH session, return or persist conversation bodies, or change model routing. After success, use dsh_followup with a compact handoff when work should continue.",
      inputSchema: z
        .object({
          sessionId: z.string().trim().min(1),
          expectedUpdatedAt: z.number().finite(),
          expectedCwd: z.string().min(1).describe("Absolute cwd copied from the selected dsh_find_sessions result."),
          expectedTitle: z.string().nullable().describe("Exact title copied from dsh_find_sessions, including null when no title is present."),
          allowBlank: z.boolean().default(false),
          workspaceMode: z
            .enum(["read-only", "exclusive-write"])
            .default("exclusive-write")
            .describe("Bridge-local cooperative workspace claim only; it does not configure the DSH sandbox."),
        })
        .strict(),
      annotations: writeOnce,
    },
    async ({ sessionId, expectedUpdatedAt, expectedCwd, expectedTitle, allowBlank, workspaceMode }) =>
      handled(() =>
        service.attachSession({
          sessionId,
          expectedUpdatedAt,
          expectedCwd,
          expectedTitle,
          allowBlank,
          workspaceMode,
        }),
      ),
  );

  server.registerTool(
    "dsh_delegate",
    {
      description:
        "Create a root session on the configured official DSH Web Host and queue the initial prompt. Before calling, put a compact handoff in prompt from known progress plus read-only Git/workspace evidence; identify focus paths and tell DSH to read those focus paths first instead of scanning the whole repository unless blocked. An explicit user choice of modelProfile or reasoningEffort always takes precedence. Otherwise the caller may choose pro for complex non-visual work; visual work must declare visualIntent=required with complexity instead of choosing a modlens profile directly; omit routing fields to inherit DSH's configured model. For visual work pass visualIntent=required with complexity: visual low selects the official native Flash Vision; visual high requires an explicit user choice between official-flash-vision and modlens-pro; modlens-flash is never a first visual choice under the declared visual policy. After the approved visual route exhausts bounded retries caused by timeout, unreachable Host, or HTTP 5xx, the bridge tries ModLens Flash exactly once and marks the result with visualRouting.fallback plus a short non-sensitive notice to show the user at task end. If visual policy fields are omitted, an explicitly supplied legacy modlens-flash route remains compatible. Explicit selection uses session.selectModel, which also persists the selection as the DSH default for later sessions. Detached by default. workspaceMode is only a bridge-local cooperative claim and does not select or verify the DSH sandbox.",
      inputSchema: z
        .object({
          prompt: z.string().min(1),
          cwd: z.string().min(1).describe("Existing absolute directory visible to the DSH Host."),
          agentPreset: z
            .string()
            .min(1)
            .optional()
            .describe("DSH agent composition/preset name. This does not express workspace ownership or verified sandbox policy."),
          title: z.string().min(1).optional(),
          waitSeconds: z.number().int().min(0).max(30).default(0),
          workspaceMode: z
            .enum(["read-only", "exclusive-write"])
            .default("exclusive-write")
            .describe("Bridge-local cooperative workspace claim only; it is not a DSH Host filesystem sandbox selector or verifier."),
          modelProfile: z
            .enum(modelProfiles)
            .optional()
            .describe(
              "Semantic route: flash/pro use deepseek-official; official-flash-vision uses the official native Flash Vision; modlens-flash/modlens-pro use deepseek-modlens, where modlens-flash is never a first visual choice; inherit keeps the current route. Explicit user choice takes precedence over caller heuristics.",
            ),
          visualIntent: z
            .enum(["none", "required"])
            .optional()
            .describe(
              "Declare visual work explicitly. required applies the visual policy: low complexity selects the official native Flash Vision, high complexity requires an explicit user choice between official-flash-vision and modlens-pro. Omitted/none preserves the non-visual policy.",
            ),
          complexity: z
            .enum(["low", "high"])
            .optional()
            .describe(
              "Task complexity for policy defaulting when no explicit user modelProfile is given. Non-visual low selects official Flash and high selects official Pro; visual low selects official Flash Vision and visual high requires an explicit user choice.",
            ),
          reasoningEffort: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("Optional effort id. It must be advertised by the selected model in session.models."),
          selectionReason: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("Optional audit explanation for the caller's explicit or autonomous profile choice; never sent to DSH."),
        })
        .strict(),
      annotations: writeOnce,
    },
    async ({ prompt, cwd, agentPreset, title, waitSeconds, workspaceMode, modelProfile, reasoningEffort, selectionReason, visualIntent, complexity }) =>
      handled(() =>
        service.delegate({
          prompt,
          cwd,
          waitSeconds,
          workspaceMode,
          ...(agentPreset === undefined ? {} : { agentPreset }),
          ...(title === undefined ? {} : { title }),
          ...(modelProfile === undefined ? {} : { modelProfile }),
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
          ...(selectionReason === undefined ? {} : { selectionReason }),
          ...(visualIntent === undefined ? {} : { visualIntent }),
          ...(complexity === undefined ? {} : { complexity }),
        }),
      ),
  );

  const followupSchema = z
    .object({
      taskId: taskIdSchema,
      prompt: z.string().min(1),
      mode: z.enum(["queue", "steer"]).default("queue"),
      sinceCursor: z.number().int().min(0).optional(),
      expectedRevision: z.number().int().min(0).optional(),
      modelProfile: z
        .enum(modelProfiles)
        .optional()
        .describe(
          "Optional semantic route selected and re-verified before this follow-up prompt; omit to inherit the session route. Explicit selection persists as the DSH default.",
        ),
      visualIntent: z
        .enum(["none", "required"])
        .optional()
        .describe(
          "Declare visual work explicitly. required applies the visual policy: low complexity selects the official native Flash Vision, high complexity requires an explicit user choice between official-flash-vision and modlens-pro.",
        ),
      complexity: z
        .enum(["low", "high"])
        .optional()
        .describe(
          "Task complexity for policy defaulting when no explicit user modelProfile is given. Non-visual low/high select official Flash/Pro; visual low selects official Flash Vision and visual high requires an explicit user choice.",
        ),
      reasoningEffort: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Optional effort id advertised by the selected live session catalog model."),
      selectionReason: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("Optional audit explanation for the route choice; never sent to DSH."),
    })
    .strict();
  const followupDescription =
    "Continue the same known BridgeTask and root DSH session instead of creating another delegation for the same work. Never guess an old task id; start a fresh delegation when no matching task id is known. queue targets the next turn; steer targets the active turn's next step. Optional semantic model routing is catalog-validated and re-read before the prompt; selection failure sends no prompt, but an attempted session.selectModel may already have persisted as the DSH global default. Omit routing to inherit. Visual routing follows the same policy: visualIntent=required with complexity low selects the official native Flash Vision and complexity high requires an explicit user choice between official-flash-vision and modlens-pro. After timeout, unreachable Host, or HTTP 5xx failures exhaust the bounded retries on the approved visual route, the bridge tries ModLens Flash exactly once and marks the result with visualRouting.fallback plus a short non-sensitive notice for the user; when visual policy fields are omitted, an explicitly supplied legacy modlens-flash route remains compatible; the prompt write itself is never automatically retried.";
  server.registerTool(
    "dsh_followup",
    { description: followupDescription, inputSchema: followupSchema, annotations: writeOnce },
    async ({ taskId, prompt, mode, sinceCursor, expectedRevision, modelProfile, reasoningEffort, selectionReason, visualIntent, complexity }) =>
      handled(() =>
        service.continueTask(
          taskId,
          prompt,
          mode,
          followupOptions({ sinceCursor, expectedRevision, modelProfile, reasoningEffort, selectionReason, visualIntent, complexity }),
        ),
      ),
  );
  server.registerTool(
    "dsh_continue",
    { description: `Compatibility alias for dsh_followup. ${followupDescription}`, inputSchema: followupSchema, annotations: writeOnce },
    async ({ taskId, prompt, mode, sinceCursor, expectedRevision, modelProfile, reasoningEffort, selectionReason, visualIntent, complexity }) =>
      handled(() =>
        service.continueTask(
          taskId,
          prompt,
          mode,
          followupOptions({ sinceCursor, expectedRevision, modelProfile, reasoningEffort, selectionReason, visualIntent, complexity }),
        ),
      ),
  );

  server.registerTool(
    "dsh_status",
    {
      description:
        "Return separate availability/execution state, root and descendant sessions, queue depths, pending interactions, final message, bridge cursor/watermarks, and bridge-local workspace claim semantics.",
      inputSchema: z.object({ taskId: taskIdSchema }).strict(),
      annotations: readOnly,
    },
    async ({ taskId }) => handled(() => service.status(taskId)),
  );

  server.registerTool(
    "dsh_tail",
    {
      description:
        "Read bounded event digests using bridge coordination cursors. Conversation content is fetched from DSH history when reachable and is never copied into bridge persistence.",
      inputSchema: z
        .object({
          taskId: taskIdSchema,
          sinceCursor: z.number().int().min(0).default(0),
          maxEvents: z.number().int().min(1).max(500).default(50),
          maxBytes: z.number().int().min(1_024).max(1_000_000).default(64_000),
        })
        .strict(),
      annotations: readOnly,
    },
    async ({ taskId, sinceCursor, maxEvents, maxBytes }) =>
      handled(() => service.tail(taskId, sinceCursor, maxEvents, maxBytes)),
  );

  server.registerTool(
    "dsh_wait",
    {
      description:
        "Wait at most 30 seconds for a new task cursor, status/availability change, terminal state, or pending interaction. It never waits for whole-task completion.",
      inputSchema: z
        .object({
          taskId: taskIdSchema,
          timeoutSec: z.number().int().min(0).max(30).default(30),
          sinceCursor: z.number().int().min(0).optional(),
        })
        .strict(),
      annotations: readOnly,
    },
    async ({ taskId, timeoutSec, sinceCursor }) => handled(() => service.wait(taskId, timeoutSec, sinceCursor)),
  );

  server.registerTool(
    "dsh_observe",
    {
      description: "Compatibility observation alias. Prefer dsh_wait plus dsh_tail task cursors.",
      inputSchema: z
        .object({
          taskId: taskIdSchema,
          afterCursor: z.number().int().min(0).optional(),
          waitSeconds: z.number().int().min(0).max(30).default(0),
        })
        .strict(),
      annotations: readOnly,
    },
    async ({ taskId, afterCursor, waitSeconds }) => handled(() => service.observe(taskId, afterCursor, waitSeconds)),
  );

  server.registerTool(
    "dsh_cancel",
    {
      description:
        "scope=turn cancels only the active root turn and preserves queued work. scope=queue non-atomically removes each item from the latest mux queue snapshot.",
      inputSchema: z
        .object({
          taskId: taskIdSchema,
          scope: z.enum(["turn", "queue"]).default("turn"),
          sinceCursor: z.number().int().min(0).optional(),
          expectedRevision: z.number().int().min(0).optional(),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ taskId, scope, sinceCursor, expectedRevision }) =>
      handled(() => service.cancel(taskId, scope, writePreconditions(sinceCursor, expectedRevision))),
  );

  server.registerTool(
    "dsh_list",
    {
      description: "List bridge task mappings enriched with current derived DSH status and bridge-local workspace claim semantics when the Host is reachable.",
      inputSchema: z.object({}).strict(),
      annotations: readOnly,
    },
    async () => handled(() => service.listTasks()),
  );

  server.registerTool(
    "dsh_release_workspace",
    {
      description:
        "Explicitly release this bridge task's persistent workspace claim. This does not close the DSH session or stop other clients from editing the directory.",
      inputSchema: z.object({ taskId: taskIdSchema }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ taskId }) => handled(() => service.releaseWorkspace(taskId)),
  );

  server.registerTool(
    "dsh_answer_question",
    {
      description:
        "Answer one currently pending typed DSH question request. The requestId, task lineage, question ids/order, and selections are validated locally before one non-retried /api/respond write.",
      inputSchema: z
        .object({
          taskId: taskIdSchema,
          requestId: z.string().min(1),
          sinceCursor: z.number().int().min(0).optional(),
          expectedRevision: z.number().int().min(0).optional(),
          answers: z
            .array(
              z
                .object({
                  id: z.string().min(1),
                  selected: z.array(z.string()),
                  custom: z.string().optional(),
                })
                .strict(),
            )
            .min(1),
        })
        .strict(),
      annotations: writeOnce,
    },
    async ({ taskId, requestId, answers, sinceCursor, expectedRevision }) =>
      handled(() => service.answerQuestion(taskId, requestId, answers, writePreconditions(sinceCursor, expectedRevision))),
  );

  server.registerTool(
    "dsh_resolve_approval",
    {
      description:
        "Resolve one pending DSH sandbox-escalation approval as allow_once or reject. Never auto-allows; keep this tool behind the caller's human approval prompt before permitting allow_once.",
      inputSchema: z
        .object({
          taskId: taskIdSchema,
          requestId: z.string().min(1),
          outcome: z.enum(["allow_once", "reject"]),
          sinceCursor: z.number().int().min(0).optional(),
          expectedRevision: z.number().int().min(0).optional(),
        })
        .strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      _meta: { "anthropic/requiresUserInteraction": true },
    },
    async ({ taskId, requestId, outcome, sinceCursor, expectedRevision }) =>
      handled(() => service.resolveApproval(taskId, requestId, outcome, writePreconditions(sinceCursor, expectedRevision))),
  );

  return server;
}
