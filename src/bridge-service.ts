import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { BridgeConfig } from "./config.js";
import type { DshConnection, HostConnectionSnapshot, QueueSnapshot, TaskLineageSession } from "./connection-manager.js";
import { DshRpcError, DshTransportError, formatModel, getHostEndpointSnapshot } from "./dsh-client.js";
import type {
  EventLedger,
  LedgerEventPointer,
  LedgerExecution,
  LedgerSnapshot,
  TailDigestRecord,
} from "./event-ledger.js";
import { getDshUnaryMetadata } from "./dsh-types.js";
import type { DshApi, DshHistoryEntry, DshQuestionAnswer, DshSessionSummary } from "./dsh-types.js";
import { resolveModelSelection, verifyModelSelection, type ModelProfile } from "./model-routing.js";
import type { TaskRecord } from "./task-store.js";
import { TaskStore } from "./task-store.js";
import type { WorkspaceClaimMode } from "./workspace-claim.js";
import { WorkspaceClaimConflictError, WorkspaceClaimStore } from "./workspace-claim.js";

export interface DelegateInput {
  prompt: string;
  cwd: string;
  agentPreset?: string;
  title?: string;
  waitSeconds?: number;
  workspaceMode?: WorkspaceClaimMode;
  modelProfile?: ModelProfile;
  reasoningEffort?: string;
  selectionReason?: string;
}

export interface FindSessionsInput {
  title?: string;
  titleMatch?: "exact" | "contains";
  cwd?: string;
  mappedOnly?: boolean;
  idleOnly?: boolean;
  includeBlank?: boolean;
  maxResults?: number;
}

export interface AttachSessionInput {
  sessionId: string;
  expectedUpdatedAt: number;
  expectedCwd: string;
  expectedTitle: string | null;
  allowBlank?: boolean;
  workspaceMode?: WorkspaceClaimMode;
}

export interface WritePreconditions {
  sinceCursor?: number;
  expectedRevision?: number;
}

export interface FollowupOptions extends WritePreconditions {
  modelProfile?: ModelProfile;
  reasoningEffort?: string;
  selectionReason?: string;
}

export type TaskAvailability = "connected" | "host_unreachable" | "session_not_found";

export interface WorkspaceClaimSemantics {
  enforcement: "bridge-cooperative-only";
  controlsDshSandbox: false;
  description: string;
}

export class DelegationSetupError extends Error {
  constructor(
    readonly stage: "mapping" | "workspace-claim" | "models" | "model-selection" | "prompt",
    message: string,
    readonly sessionId: string,
    readonly taskId?: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DelegationSetupError";
  }
}

export class BridgeCapabilityError extends Error {
  constructor(
    readonly code:
      | "queue_snapshot_unavailable"
      | "session_not_found"
      | "session_running"
      | "session_blank"
      | "session_not_root"
      | "session_cwd_unavailable"
      | "host_unreachable"
      | "model_unroutable"
      | "workspace_claim_missing"
      | "unsupported",
    message: string,
    readonly details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BridgeCapabilityError";
  }
}

export class StaleViewError extends Error {
  readonly code = "stale_view";

  constructor(
    message: string,
    readonly details: Record<string, unknown>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StaleViewError";
  }
}

function promptPayload(config: BridgeConfig, sessionId: string, prompt: string, mode: "queue" | "steer") {
  return {
    sessionId,
    mode,
    content: [{ type: "text" as const, text: prompt }],
    ...(config.clientTimeZone === undefined ? {} : { clientTimeZone: config.clientTimeZone }),
  };
}

function deriveTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() ?? "DSH task";
  const compact = firstLine.replace(/\s+/g, " ").slice(0, 72);
  return `Codex · ${compact === "" ? "DSH task" : compact}`;
}

function hostStartCommand(hostUrl: string): string {
  const url = new URL(hostUrl);
  const host = url.hostname === "[::1]" ? "::1" : url.hostname;
  const port = url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port;
  return `dsh web --host ${host} --port ${port}`;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class FollowupRoutingError extends Error {
  readonly code = "followup_model_selection_failed";
  readonly details: Record<string, unknown>;

  constructor(
    message: string,
    taskId: string,
    rootSessionId: string,
    profile: ModelProfile,
    modelSelectionMayHavePersisted: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FollowupRoutingError";
    this.details = { taskId, rootSessionId, profile, modelSelectionMayHavePersisted };
  }
}

export class FollowupPromptError extends Error {
  readonly code = "followup_prompt_failed";
  readonly details: Record<string, unknown>;

  constructor(
    taskId: string,
    rootSessionId: string,
    modelSelectionPersisted: boolean,
    selectedModel: unknown,
    options?: ErrorOptions,
  ) {
    super(
      "the follow-up prompt did not receive an authoritative acceptance receipt and was not retried; it may have been accepted by DSH",
      options,
    );
    this.name = "FollowupPromptError";
    this.details = {
      taskId,
      rootSessionId,
      promptMayHaveBeenAccepted: true,
      modelSelectionPersisted,
      selectedModel,
    };
  }
}

const MAX_SESSION_TITLE_LENGTH = 256;

function sessionTitle(session: DshSessionSummary): string | undefined {
  const title = asObject(asObject(session.projections)?.values)?.title;
  return typeof title === "string" && title.trim() !== "" ? title : undefined;
}

function sessionMetadata(session: DshSessionSummary, tasksBySession: Map<string, TaskRecord[]>, canonicalCwd?: string) {
  const title = sessionTitle(session);
  const mappings = tasksBySession.get(session.sessionId) ?? [];
  return {
    sessionId: session.sessionId,
    title: title === undefined ? null : title.slice(0, MAX_SESSION_TITLE_LENGTH),
    titleTruncated: title !== undefined && title.length > MAX_SESSION_TITLE_LENGTH,
    updatedAt: session.updatedAt,
    running: session.running,
    blank: session.blank,
    cwd: canonicalCwd ?? session.cwd ?? null,
    agentPreset: session.agentPreset ?? null,
    bridgeTaskId: mappings.length === 1 ? mappings[0]!.taskId : null,
    bridgeMappingConflict: mappings.length > 1,
  };
}

function contentText(value: unknown): string | undefined {
  const content = asObject(value)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((block) => {
      const item = asObject(block);
      return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
    })
    .join("");
  return text === "" ? undefined : text;
}

function historyDigest(entry: DshHistoryEntry): unknown {
  const event = entry.event;
  const data = asObject(event.data);
  if (event.type === "user/message") {
    return { eventType: event.type, seq: event.seq, time: event.time, text: contentText(event.data) };
  }
  if (event.type === "assistant/message") {
    return {
      eventType: event.type,
      seq: event.seq,
      time: event.time,
      text: contentText(data?.message),
    };
  }
  if (event.type === "assistant/message/delta" || event.type === "assistant/delta" || event.type === "assistant/chunk") {
    return { eventType: event.type, seq: event.seq, time: event.time, omitted: "assistant_chunk" };
  }
  if (event.type === "tool/result") {
    const meta = asObject(data?.meta);
    return {
      eventType: event.type,
      seq: event.seq,
      time: event.time,
      error: data?.error,
      paths: data?.paths ?? meta?.paths,
      stats: data?.stats ?? meta?.stats,
      result: typeof data?.result === "string" ? data.result.slice(0, 2_000) : undefined,
      truncated: typeof data?.result === "string" && data.result.length > 2_000,
    };
  }
  if (event.type === "tool/call") {
    return { eventType: event.type, seq: event.seq, time: event.time, tool: data?.name };
  }
  if (event.type === "turn/start" || event.type === "turn/end") {
    return { eventType: event.type, seq: event.seq, time: event.time, data: event.data };
  }
  return { eventType: event.type, seq: event.seq, time: event.time };
}

function interactionExecution(pending: ReturnType<DshConnection["pendingForTask"]>): LedgerExecution | undefined {
  if (pending.some((envelope) => envelope.payload.type === "approval/requested")) return "awaiting_approval";
  if (pending.some((envelope) => envelope.payload.type === "question/requested")) return "awaiting_input";
  return undefined;
}

function isTerminal(execution: LedgerExecution): boolean {
  return execution === "turn_completed" || execution === "failed" || execution === "canceled" || execution === "interrupted";
}

function queueDepth(snapshot: QueueSnapshot) {
  const nextTurn = snapshot.items.filter((item) => item.placement === "queued").length;
  const steering = snapshot.items.filter((item) => item.placement === "steering").length;
  const context = snapshot.items.filter((item) => item.placement === "context").length;
  return {
    known: snapshot.known && !snapshot.stale,
    stale: snapshot.stale,
    nextTurn,
    nextStep: steering + context,
    steering,
    context,
    total: snapshot.items.length,
  };
}

function workspaceClaimSemantics(): WorkspaceClaimSemantics {
  return {
    enforcement: "bridge-cooperative-only",
    controlsDshSandbox: false,
    description:
      "workspaceMode is a bridge-local coordination claim shared only by bridge processes using the same bridge home; it does not select, enforce, or verify the DSH Host filesystem sandbox.",
  };
}

function statusShape(
  task: TaskRecord,
  connection: HostConnectionSnapshot,
  ledger: LedgerSnapshot,
  lineage: TaskLineageSession[],
  availability: TaskAvailability,
  execution: LedgerExecution,
  pending: ReturnType<DshConnection["pendingForTask"]>,
  queue: QueueSnapshot,
  workspaceClaim: Awaited<ReturnType<WorkspaceClaimStore["get"]>>,
) {
  return {
    taskId: task.taskId,
    rootSessionId: task.sessionId,
    availability,
    execution,
    status: availability === "connected" ? execution : "unknown",
    lastKnownExecutionStatus: availability === "connected" ? execution : ledger.lastKnownExecutionStatus,
    turn: ledger.currentTurn ?? null,
    pendingInteractions: pending,
    queueDepth: queueDepth(queue),
    finalMessage: null,
    finalMessagePointer: ledger.finalMessagePointer ?? null,
    finalMessageStatus:
      isTerminal(execution) &&
      (ledger.terminalMissingFinal || (execution === "interrupted" && ledger.finalMessagePointer === undefined))
        ? "terminal_missing_final"
        : ledger.finalMessagePointer === undefined
          ? "not_available"
          : "pointer_available",
    contentUnavailable:
      availability === "connected" ? false : { reason: availability, conversationSource: "DSH session.history" },
    cursor: ledger.cursor,
    earliestCursor: ledger.earliestCursor,
    watermarks: ledger.watermarks,
    recovery:
      ledger.unrecoverableGap === undefined
        ? { state: "reconciled" }
        : { state: "unrecoverable_gap", details: ledger.unrecoverableGap },
    logPath: ledger.logPath,
    lineage,
    connection,
    workspaceClaim: workspaceClaim ?? null,
    workspaceClaimSemantics: workspaceClaimSemantics(),
    derivation: "session.list + session.history/event-ledger + events.mux pending/queue snapshots",
  };
}

export class BridgeService {
  constructor(
    private readonly config: BridgeConfig,
    private readonly api: DshApi,
    private readonly tasks: TaskStore,
    private readonly connection: DshConnection,
    private readonly ledger: EventLedger,
    private readonly claims: WorkspaceClaimStore = new WorkspaceClaimStore(config.homeDir),
  ) {}

  private async preflightWrite(taskId: string, preconditions: WritePreconditions = {}, requireWorkspaceClaim = false) {
    const task = await this.tasks.get(taskId);
    const workspaceClaim = await this.claims.get(taskId);
    if (
      workspaceClaim !== undefined &&
      (workspaceClaim.taskId !== task.taskId || workspaceClaim.sessionId !== task.sessionId)
    ) {
      throw new StaleViewError("workspace claim ownership does not match the task mapping", {
        task,
        workspaceClaim,
      });
    }
    if (requireWorkspaceClaim && workspaceClaim === undefined) {
      throw new BridgeCapabilityError(
        "workspace_claim_missing",
        "this mutation requires an active workspace claim; create a new delegation or reacquire a dedicated worktree",
        { taskId, rootSessionId: task.sessionId },
      );
    }
    const beforeConnection = this.connection.snapshot();
    if (beforeConnection.availability !== "connected") {
      throw new BridgeCapabilityError("host_unreachable", "cannot mutate a DSH session while its Host is unavailable", {
        taskId,
        availability: beforeConnection.availability,
      });
    }
    if (
      preconditions.expectedRevision !== undefined &&
      preconditions.expectedRevision !== beforeConnection.revision
    ) {
      throw new StaleViewError("the DSH connection view changed before the write preflight", {
        taskId,
        expectedRevision: preconditions.expectedRevision,
        currentRevision: beforeConnection.revision,
      });
    }

    await this.connection.refreshLineage();
    await this.connection.reconcileTask(taskId);
    const connection = this.connection.snapshot();
    if (connection.availability !== "connected") {
      throw new BridgeCapabilityError("host_unreachable", "the DSH Host became unavailable during write preflight", {
        taskId,
        availability: connection.availability,
      });
    }
    const lineage = this.connection.lineageForTask(taskId);
    const root = lineage.find((row) => row.sessionId === task.sessionId);
    if (root?.found !== true) {
      throw new BridgeCapabilityError("session_not_found", "the mapped root session is not present on the connected DSH Host", {
        taskId,
        rootSessionId: task.sessionId,
      });
    }
    if (preconditions.expectedRevision !== undefined && preconditions.expectedRevision !== connection.revision) {
      throw new StaleViewError("the DSH connection view changed during write preflight", {
        taskId,
        expectedRevision: preconditions.expectedRevision,
        currentRevision: connection.revision,
      });
    }

    const ledger = await this.ledger.snapshot(taskId);
    let changesSinceView: unknown[] = [];
    if (preconditions.sinceCursor !== undefined) {
      const delta = await this.ledger.tail(taskId, preconditions.sinceCursor, 500, 1_000_000);
      changesSinceView = delta.records;
      if (ledger.cursor > preconditions.sinceCursor) {
        throw new StaleViewError("the task changed since the caller's cursor; inspect changes and retry from the new view", {
          taskId,
          sinceCursor: preconditions.sinceCursor,
          currentCursor: ledger.cursor,
          currentRevision: connection.revision,
          changes: changesSinceView,
        });
      }
    }
    return { task, connection, ledger, lineage, workspaceClaim, changesSinceView };
  }

  private async readPointedHistory(
    taskId: string,
    pointers: LedgerEventPointer[],
  ): Promise<Map<string, DshHistoryEntry>> {
    const wantedBySession = new Map<string, Set<number>>();
    for (const pointer of pointers) {
      const wanted = wantedBySession.get(pointer.sessionId) ?? new Set<number>();
      wanted.add(pointer.seq);
      wantedBySession.set(pointer.sessionId, wanted);
    }
    const found = new Map<string, DshHistoryEntry>();
    await Promise.all(
      [...wantedBySession].map(async ([sessionId, wanted]) => {
        let beforeSeq: number | undefined;
        for (let page = 0; page < 10_000 && wanted.size > 0; page += 1) {
          const history = await this.connection.readSessionHistory(taskId, sessionId, {
            ...(beforeSeq === undefined ? {} : { beforeSeq }),
            maxMessages: 50,
          });
          for (const entry of history.events) {
            if (!wanted.has(entry.event.seq)) continue;
            found.set(`${sessionId}:${entry.event.seq}`, entry);
            wanted.delete(entry.event.seq);
          }
          const firstSeq = history.events[0]?.event.seq;
          if (!history.hasMore || firstSeq === undefined) break;
          beforeSeq = firstSeq;
        }
      }),
    );
    return found;
  }

  private async resolveFinalMessage(taskId: string, pointer: LedgerEventPointer | undefined) {
    if (pointer === undefined) return { finalMessage: null, finalMessagePointer: null };
    const entries = await this.readPointedHistory(taskId, [pointer]);
    const entry = entries.get(`${pointer.sessionId}:${pointer.seq}`);
    if (entry === undefined || entry.event.type !== "assistant/message") {
      return {
        finalMessage: null,
        finalMessagePointer: pointer,
        contentUnavailable: { reason: "history_event_not_found", pointer },
      };
    }
    return {
      finalMessage: contentText(asObject(entry.event.data)?.message) ?? null,
      finalMessagePointer: pointer,
    };
  }

  private async hydrateTail(taskId: string, records: TailDigestRecord[]): Promise<TailDigestRecord[]> {
    const pointers = records.flatMap((record) =>
      record.type === "session/event" && record.sourceSeq !== undefined
        ? [{ sessionId: record.sourceSessionId, seq: record.sourceSeq }]
        : [],
    );
    if (pointers.length === 0) return records;
    const entries = await this.readPointedHistory(taskId, pointers);
    return records.map((record) => {
      if (record.type !== "session/event" || record.sourceSeq === undefined) return record;
      const entry = entries.get(`${record.sourceSessionId}:${record.sourceSeq}`);
      if (entry === undefined) {
        return {
          ...record,
          digest: { coordination: record.digest, contentUnavailable: { reason: "history_event_not_found" } },
        };
      }
      return {
        ...record,
        digest: {
          ...((asObject(record.digest) ?? {}) as Record<string, unknown>),
          ...((asObject(historyDigest(entry)) ?? {}) as Record<string, unknown>),
        },
      };
    });
  }

  private boundTailContent(records: TailDigestRecord[], maxBytes: number): TailDigestRecord[] {
    let used = 0;
    return records.map((record) => {
      const size = Buffer.byteLength(JSON.stringify(record), "utf8");
      if (used + size <= maxBytes) {
        used += size;
        return record;
      }
      if (record.protected) {
        used += size;
        return { ...record, exceededMaxBytes: true };
      }
      return {
        ...record,
        digest: { omitted: "digest_exceeds_maxBytes", type: record.type },
        exceededMaxBytes: true,
      };
    });
  }

  async hostStatus() {
    const connection = this.connection.snapshot();
    const endpoint = getHostEndpointSnapshot(this.api, {
      mode: this.config.hostMode,
      configuredBaseUrl: this.config.hostUrl,
    });
    const baseUrl = endpoint.resolvedBaseUrl ?? endpoint.configuredBaseUrl ?? connection.baseUrl;
    return {
      reachable: connection.availability === "connected",
      availability: connection.availability,
      baseUrl,
      endpoint,
      connection,
      connectOnly: true,
      lifecycleOwnership: "user-or-os-service",
      ...(endpoint.mode === "static" && baseUrl !== null ? { startCommand: hostStartCommand(baseUrl) } : {}),
    };
  }

  private async resolveDiscoveryCwd(cwd: string | undefined): Promise<string | undefined> {
    if (cwd === undefined) return undefined;
    if (!isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
    const requestedCwd = resolve(cwd);
    const canonical = await realpath(requestedCwd).catch((error: unknown) => {
      throw new Error(`cwd does not exist or cannot be resolved: ${requestedCwd}`, { cause: error });
    });
    const cwdStat = await stat(canonical);
    if (!cwdStat.isDirectory()) throw new Error(`cwd is not a directory: ${canonical}`);
    return canonical;
  }

  async findSessions(input: FindSessionsInput = {}) {
    const maxResults = input.maxResults ?? 20;
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) {
      throw new Error("maxResults must be an integer between 1 and 50");
    }
    const title = input.title?.trim();
    if (input.title !== undefined && title === "") throw new Error("title must not be empty");
    const titleMatch = input.titleMatch ?? "exact";

    // Validate and canonicalize the requested cwd before any Host call.
    const canonicalCwd = await this.resolveDiscoveryCwd(input.cwd);

    const [list, taskRecords] = await Promise.all([this.api.sessionList(), this.tasks.list()]);
    const tasksBySession = new Map<string, TaskRecord[]>();
    for (const task of taskRecords) {
      const entries = tasksBySession.get(task.sessionId) ?? [];
      entries.push(task);
      tasksBySession.set(task.sessionId, entries);
    }

    // Resolve each candidate's canonical cwd once. Any advertised cwd that is
    // missing, empty, non-absolute, unresolvable, or not a directory is excluded.
    const canonicalBySession = new Map<string, string>();
    const unavailableAbsoluteCwd = new Set<string>();
    await Promise.all(
      list.items.map(async (session) => {
        const advertised = session.cwd;
        if (typeof advertised !== "string" || !isAbsolute(advertised)) {
          unavailableAbsoluteCwd.add(session.sessionId);
          return;
        }
        const canonical = await realpath(resolve(advertised)).catch(() => undefined);
        if (canonical === undefined) {
          unavailableAbsoluteCwd.add(session.sessionId);
          return;
        }
        const cwdStat = await stat(canonical).catch(() => undefined);
        if (cwdStat === undefined || !cwdStat.isDirectory()) {
          unavailableAbsoluteCwd.add(session.sessionId);
          return;
        }
        canonicalBySession.set(session.sessionId, canonical);
      }),
    );

    const matches = list.items
      .filter((session) => session.parentSessionId === undefined && session.origin !== "subagent")
      .filter((session) => input.includeBlank === true || !session.blank)
      .filter((session) => input.idleOnly !== true || !session.running)
      .filter((session) => !unavailableAbsoluteCwd.has(session.sessionId))
      .filter((session) => {
        if (canonicalCwd === undefined) return true;
        return canonicalBySession.get(session.sessionId) === canonicalCwd;
      })
      .filter((session) => {
        if (title === undefined) return true;
        const current = sessionTitle(session);
        return current !== undefined && (titleMatch === "exact" ? current === title : current.includes(title));
      })
      .filter((session) => {
        if (input.mappedOnly !== true) return true;
        return (tasksBySession.get(session.sessionId)?.length ?? 0) === 1;
      })
      .sort((left, right) => right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId));
    return {
      sessions: matches.slice(0, maxResults).map((session) => sessionMetadata(session, tasksBySession, canonicalBySession.get(session.sessionId))),
      matchCount: matches.length,
      truncated: matches.length > maxResults,
      metadataOnly: true,
      conversationHistoryRead: false,
    };
  }

  async attachSession(input: AttachSessionInput) {
    const sessionId = input.sessionId.trim();
    if (sessionId === "") throw new Error("sessionId must not be empty");
    if (!Number.isFinite(input.expectedUpdatedAt)) throw new Error("expectedUpdatedAt must be finite");
    if (!isAbsolute(input.expectedCwd)) throw new Error("expectedCwd must be an absolute path");

    await this.api.hostDescribe();
    const list = await this.api.sessionList();
    const session = list.items.find((candidate) => candidate.sessionId === sessionId);
    if (session === undefined) {
      throw new BridgeCapabilityError("session_not_found", "the exact DSH session id is not present on the connected Host", {
        sessionId,
      });
    }
    if (session.parentSessionId !== undefined || session.origin === "subagent") {
      throw new BridgeCapabilityError("session_not_root", "only a root DSH session can be attached as a BridgeTask", {
        sessionId,
        parentSessionId: session.parentSessionId ?? null,
      });
    }
    if (session.running) {
      throw new BridgeCapabilityError("session_running", "refusing to attach a DSH session while its turn is running", {
        sessionId,
      });
    }
    if (session.blank && input.allowBlank !== true) {
      throw new BridgeCapabilityError("session_blank", "refusing to attach a blank DSH session unless allowBlank is explicit", {
        sessionId,
      });
    }
    const currentTitle = sessionTitle(session);
    const comparableTitle = currentTitle ?? null;
    if (session.updatedAt !== input.expectedUpdatedAt || comparableTitle !== input.expectedTitle) {
      throw new StaleViewError("the DSH session metadata changed since discovery", {
        sessionId,
        expectedUpdatedAt: input.expectedUpdatedAt,
        currentUpdatedAt: session.updatedAt,
        expectedTitle: input.expectedTitle,
        currentTitle: comparableTitle,
      });
    }
    if (session.cwd === undefined || !isAbsolute(session.cwd)) {
      throw new BridgeCapabilityError("session_cwd_unavailable", "the DSH session does not advertise a usable absolute cwd", {
        sessionId,
      });
    }
    const expectedCwd = await realpath(resolve(input.expectedCwd)).catch((error: unknown) => {
      throw new StaleViewError("expectedCwd no longer exists or cannot be resolved", { expectedCwd: input.expectedCwd }, { cause: error });
    });
    const cwd = await realpath(resolve(session.cwd)).catch((error: unknown) => {
      throw new BridgeCapabilityError(
        "session_cwd_unavailable",
        "the DSH session cwd no longer exists or cannot be resolved",
        { sessionId, cwd: session.cwd },
        { cause: error },
      );
    });
    if (cwd !== expectedCwd) {
      throw new StaleViewError("the DSH session cwd changed or differs from the discovered workspace", {
        sessionId,
        expectedCwd,
        currentCwd: cwd,
      });
    }
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) {
      throw new BridgeCapabilityError("session_cwd_unavailable", "the DSH session cwd is not a directory", {
        sessionId,
        cwd,
      });
    }

    const workspaceMode = input.workspaceMode ?? "exclusive-write";
    const prepared = await this.tasks.createOrGetBySessionTransaction(sessionId, async (mapping) => {
      const task = mapping.task;
      let workspaceClaim = await this.claims.get(task.taskId);
      if (workspaceClaim === undefined) {
        try {
          workspaceClaim = await this.claims.acquire({
            canonicalCwd: cwd,
            taskId: task.taskId,
            sessionId,
            mode: workspaceMode,
          });
        } catch (error) {
          if (!(error instanceof WorkspaceClaimConflictError) || error.code !== "stale_view") throw error;
          workspaceClaim = await this.claims.get(task.taskId);
          if (workspaceClaim === undefined) throw error;
        }
      }
      if (
        workspaceClaim.sessionId !== sessionId ||
        workspaceClaim.cwd !== resolve(cwd) ||
        workspaceClaim.mode !== workspaceMode
      ) {
        throw new StaleViewError("the existing workspace claim does not match this attach request", {
          taskId: task.taskId,
          requested: { sessionId, cwd: resolve(cwd), mode: workspaceMode },
          existing: workspaceClaim,
        });
      }
      return { mapping, workspaceClaim };
    });
    const { mapping, workspaceClaim } = prepared;
    const task = mapping.task;
    await this.connection.trackTask(task);
    return {
      taskId: task.taskId,
      rootSessionId: sessionId,
      mappingCreated: mapping.created,
      promptSent: false,
      modelSelectionChanged: false,
      session: sessionMetadata(session, new Map([[sessionId, [task]]]), cwd),
      workspaceClaim,
      workspaceClaimSemantics: workspaceClaimSemantics(),
    };
  }

  async delegate(input: DelegateInput) {
    const prompt = input.prompt.trim();
    if (prompt === "") throw new Error("prompt must not be empty");
    if (!isAbsolute(input.cwd)) throw new Error("cwd must be an absolute path");
    const requestedCwd = resolve(input.cwd);
    const cwd = await realpath(requestedCwd).catch((error: unknown) => {
      throw new Error(`cwd does not exist or cannot be resolved: ${requestedCwd}`, { cause: error });
    });
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
    const waitSeconds = input.waitSeconds ?? 0;
    this.validateWaitSeconds(waitSeconds);
    const modelProfile = input.modelProfile ?? "inherit";
    const reasoningEffort = input.reasoningEffort?.trim();
    if (input.reasoningEffort !== undefined && reasoningEffort === "") {
      throw new Error("reasoningEffort must not be empty");
    }
    const selectionReason = input.selectionReason?.trim() || undefined;

    await this.api.hostDescribe();
    const agentPreset = input.agentPreset?.trim() || this.config.defaultAgentPreset;
    const created = await this.api.sessionCreate({ cwd, ...(agentPreset === undefined ? {} : { agentPreset }) });

    let task: TaskRecord;
    try {
      task = await this.tasks.create(created.sessionId);
    } catch (error) {
      throw new DelegationSetupError(
        "mapping",
        `DSH root session ${created.sessionId} was created, but its bridge task mapping could not be saved`,
        created.sessionId,
        undefined,
        { cause: error },
      );
    }
    await this.connection.trackTask(task);
    const workspaceMode = input.workspaceMode ?? "exclusive-write";
    let workspaceClaim;
    try {
      workspaceClaim = await this.claims.acquire({
        canonicalCwd: cwd,
        taskId: task.taskId,
        sessionId: task.sessionId,
        mode: workspaceMode,
      });
    } catch (error) {
      if (error instanceof WorkspaceClaimConflictError) {
        throw new WorkspaceClaimConflictError(
          error.code,
          `${error.message}; DSH session ${created.sessionId} and task mapping ${task.taskId} exist but were not prompted`,
          { ...error.details, taskId: task.taskId, rootSessionId: created.sessionId },
          { cause: error },
        );
      }
      throw new DelegationSetupError(
        "workspace-claim",
        `DSH root session ${created.sessionId} exists as task ${task.taskId}, but its workspace claim could not be saved`,
        created.sessionId,
        task.taskId,
        { cause: error },
      );
    }
    const beforePrompt = await this.ledger.snapshot(task.taskId);

    let models;
    try {
      models = await this.api.sessionModels(created.sessionId);
    } catch (error) {
      throw new DelegationSetupError(
        "models",
        `DSH root session ${created.sessionId} exists as task ${task.taskId}, but its model route could not be verified`,
        created.sessionId,
        task.taskId,
        { cause: error },
      );
    }
    if (!models.routable) {
      if (modelProfile === "inherit" && reasoningEffort === undefined) {
        throw new DelegationSetupError(
          "models",
          `DSH root session ${created.sessionId} selected ${formatModel(models.current)}, but its provider is not routable (task ${task.taskId})`,
          created.sessionId,
          task.taskId,
        );
      }
    }

    const shouldSelectModel = modelProfile !== "inherit" || reasoningEffort !== undefined;
    let requestedSelection;
    if (shouldSelectModel) {
      try {
        requestedSelection = resolveModelSelection(models, modelProfile, reasoningEffort);
        await this.api.sessionSelectModel({
          sessionId: created.sessionId,
          provider: requestedSelection.provider,
          model: requestedSelection.model,
          ...(requestedSelection.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: requestedSelection.reasoningEffort }),
        });
        models = await this.api.sessionModels(created.sessionId);
        verifyModelSelection(requestedSelection, models);
      } catch (error) {
        throw new DelegationSetupError(
          "model-selection",
          `DSH root session ${created.sessionId} exists as task ${task.taskId}, but the requested model profile ${modelProfile} was not activated; the initial prompt was not sent. If the Host accepted session.selectModel before verification failed, that selection may already be the DSH default`,
          created.sessionId,
          task.taskId,
          { cause: error },
        );
      }
    }

    let promptTrackingWarning: string | undefined;
    let promptIssuedRpcId: string | undefined;
    try {
      const promptReceipt = await this.api.sessionPrompt(promptPayload(this.config, created.sessionId, prompt, "queue"));
      const issuedRpcId = getDshUnaryMetadata(promptReceipt).issuedRpcId;
      promptIssuedRpcId = issuedRpcId;
      await this.ledger
        .append(task.taskId, {
          sourceSessionId: created.sessionId,
          origin: "root",
          type: "bridge/prompt-issued",
          raw: { issuedRpcId, mode: "queue" },
        })
        .catch((error: unknown) => {
          promptTrackingWarning = `prompt was accepted as rpcId ${issuedRpcId}, but coordination metadata could not be recorded: ${String(error)}`;
        });
    } catch (error) {
      throw new DelegationSetupError(
        "prompt",
        `DSH root session ${created.sessionId} exists as task ${task.taskId}, but the initial prompt was not accepted`,
        created.sessionId,
        task.taskId,
        { cause: error },
      );
    }

    let renameWarning: string | undefined;
    try {
      await this.api.sessionRename(created.sessionId, input.title?.trim() || deriveTitle(prompt));
    } catch (error) {
      renameWarning = `session started, but automatic rename failed: ${String(error)}`;
    }
    const base = {
      taskId: task.taskId,
      rootSessionId: task.sessionId,
      accepted: true,
      detached: waitSeconds === 0,
      model: models.current,
      routable: models.routable,
      modelRouting:
        requestedSelection === undefined
          ? {
              mode: "inherited" as const,
              profile: "inherit" as const,
              selected: models.current,
              persistsAsDshDefault: false,
            }
          : {
              mode: "selected" as const,
              profile: modelProfile,
              requested: requestedSelection,
              selected: models.current,
              ...(selectionReason === undefined ? {} : { selectionReason }),
              persistsAsDshDefault: true,
              warning: "DSH session.selectModel also persists this selection as the DSH default for later sessions.",
            },
      ...(promptIssuedRpcId === undefined ? {} : { issuedRpcId: promptIssuedRpcId }),
      baseUrl:
        getHostEndpointSnapshot(this.api, {
          mode: this.config.hostMode,
          configuredBaseUrl: this.config.hostUrl,
        }).resolvedBaseUrl ?? this.config.hostUrl,
      workspaceClaim,
      workspaceClaimSemantics: workspaceClaimSemantics(),
      ...(promptTrackingWarning === undefined ? {} : { coordinationWarning: promptTrackingWarning }),
      ...(renameWarning === undefined ? {} : { warning: renameWarning }),
    };
    if (waitSeconds === 0) return base;
    return { ...base, wait: await this.wait(task.taskId, waitSeconds, beforePrompt.cursor) };
  }

  async continueTask(
    taskId: string,
    prompt: string,
    mode: "queue" | "steer" = "queue",
    options: FollowupOptions = {},
  ) {
    const trimmed = prompt.trim();
    if (trimmed === "") throw new Error("prompt must not be empty");
    const modelProfile = options.modelProfile ?? "inherit";
    const reasoningEffort = options.reasoningEffort?.trim();
    if (options.reasoningEffort !== undefined && reasoningEffort === "") {
      throw new Error("reasoningEffort must not be empty");
    }
    const selectionReason = options.selectionReason?.trim() || undefined;
    const view = await this.preflightWrite(taskId, options, true);
    const { task } = view;
    let models = await this.api.sessionModels(task.sessionId);
    if (!models.routable) {
      if (modelProfile === "inherit" && reasoningEffort === undefined) {
        throw new BridgeCapabilityError(
          "model_unroutable",
          `the root session's current route ${formatModel(models.current)} is not routable`,
          { taskId, rootSessionId: task.sessionId, current: models.current },
        );
      }
    }
    const shouldSelectModel = modelProfile !== "inherit" || reasoningEffort !== undefined;
    let requestedSelection;
    if (shouldSelectModel) {
      let modelSelectionMayHavePersisted = false;
      try {
        requestedSelection = resolveModelSelection(models, modelProfile, reasoningEffort);
        modelSelectionMayHavePersisted = true;
        await this.api.sessionSelectModel({
          sessionId: task.sessionId,
          provider: requestedSelection.provider,
          model: requestedSelection.model,
          ...(requestedSelection.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: requestedSelection.reasoningEffort }),
        });
        models = await this.api.sessionModels(task.sessionId);
        verifyModelSelection(requestedSelection, models);
      } catch (error) {
        throw new FollowupRoutingError(
          `the requested follow-up model profile ${modelProfile} was not verified; the follow-up prompt was not sent. If session.selectModel was attempted, that selection may already be the DSH default`,
          taskId,
          task.sessionId,
          modelProfile,
          modelSelectionMayHavePersisted,
          { cause: error },
        );
      }
    }
    let receipt;
    try {
      receipt = await this.api.sessionPrompt(promptPayload(this.config, task.sessionId, trimmed, mode));
    } catch (error) {
      throw new FollowupPromptError(
        taskId,
        task.sessionId,
        requestedSelection !== undefined,
        models.current,
        { cause: error },
      );
    }
    const issuedRpcId = getDshUnaryMetadata(receipt).issuedRpcId;
    let coordinationWarning: string | undefined;
    await this.ledger
      .append(taskId, {
        sourceSessionId: task.sessionId,
        origin: "root",
        type: "bridge/prompt-issued",
        raw: { issuedRpcId, mode },
      })
      .catch((error: unknown) => {
        coordinationWarning = `prompt was accepted, but issued rpcId metadata could not be recorded: ${String(error)}`;
      });
    return {
      taskId,
      rootSessionId: task.sessionId,
      mode,
      deliveryTarget: mode === "queue" ? "next-turn" : "next-step",
      durableWhenClaimedByDsh: true,
      model: models.current,
      routable: models.routable,
      modelRouting:
        requestedSelection === undefined
          ? {
              mode: "inherited" as const,
              profile: "inherit" as const,
              selected: models.current,
              persistsAsDshDefault: false,
            }
          : {
              mode: "selected" as const,
              profile: modelProfile,
              requested: requestedSelection,
              selected: models.current,
              ...(selectionReason === undefined ? {} : { selectionReason }),
              persistsAsDshDefault: true,
              warning: "DSH session.selectModel also persists this selection as the DSH default for later sessions.",
            },
      issuedRpcId,
      accepted: receipt.accepted,
      ...(receipt.command === undefined ? {} : { command: receipt.command }),
      ...(coordinationWarning === undefined ? {} : { coordinationWarning }),
      preflight: {
        cursor: view.ledger.cursor,
        connectionRevision: view.connection.revision,
        changesSinceView: view.changesSinceView,
      },
    };
  }

  async status(taskId: string) {
    const task = await this.tasks.get(taskId);
    const workspaceClaim = await this.claims.get(taskId);
    let ledger = await this.ledger.snapshot(taskId);
    let connection = this.connection.snapshot();
    let lineage = this.connection.lineageForTask(taskId);
    let pending = this.connection.pendingForTask(taskId);
    let queue = this.connection.queueForSession(task.sessionId);
    let pendingExecution = interactionExecution(pending);
    if (connection.availability !== "connected") {
      return {
        ...statusShape(
          task,
          connection,
          ledger,
          lineage,
          "host_unreachable",
          ledger.execution,
          [],
          queue,
          workspaceClaim,
        ),
        lastKnownPendingInteractions: ledger.pendingInteractions,
      };
    }

    try {
      await this.connection.refreshLineage();
      connection = this.connection.snapshot();
      lineage = this.connection.lineageForTask(taskId);
      pending = this.connection.pendingForTask(taskId);
      pendingExecution = interactionExecution(pending);
      queue = this.connection.queueForSession(task.sessionId);
      const root = lineage.find((row) => row.sessionId === task.sessionId);
      if (root?.found !== true) {
        const missingQueue: QueueSnapshot = {
          known: false,
          stale: false,
          connectionEpoch: connection.connectionEpoch,
          items: [],
        };
        return {
          ...statusShape(task, connection, ledger, lineage, "session_not_found", ledger.execution, [], missingQueue, workspaceClaim),
          running: null,
          blank: null,
        };
      }
      await this.connection.reconcileTask(taskId);
      ledger = await this.ledger.snapshot(taskId);
      connection = this.connection.snapshot();
      pending = this.connection.pendingForTask(taskId);
      pendingExecution = interactionExecution(pending);
      queue = this.connection.queueForSession(task.sessionId);
      const models = await this.api.sessionModels(task.sessionId);
      let execution =
        pendingExecution ??
        (root.running === true
          ? "running"
          : root.blank === true
            ? "starting"
            : ledger.execution === "running"
              ? "interrupted"
              : ledger.execution);
      if (execution === "interrupted" && ledger.execution === "running") {
        await this.ledger.append(taskId, {
          sourceSessionId: task.sessionId,
          origin: "root",
          type: "bridge/turn-interrupted",
          raw: {
            reason: "host-reported-no-active-turn-after-history-reconciliation",
            connectionEpoch: connection.connectionEpoch,
            ...(ledger.currentTurn === undefined ? {} : { turnStartCursor: ledger.currentTurn.startCursor }),
          },
        });
        ledger = await this.ledger.snapshot(taskId);
        execution = ledger.execution;
      }
      const final = await this.resolveFinalMessage(taskId, ledger.finalMessagePointer);
      return {
        ...statusShape(
          task,
          connection,
          ledger,
          lineage,
          "connected",
          execution,
          pending,
          this.connection.queueForSession(task.sessionId),
          workspaceClaim,
        ),
        ...final,
        finalMessageStatus:
          isTerminal(execution) &&
          (ledger.terminalMissingFinal || (execution === "interrupted" && ledger.finalMessagePointer === undefined))
            ? "terminal_missing_final"
            : final.finalMessage === null
              ? "not_available"
              : "available",
        contentUnavailable: "contentUnavailable" in final ? final.contentUnavailable : false,
        running: root.running ?? false,
        blank: root.blank ?? false,
        model: models.current,
        routable: models.routable,
      };
    } catch (error) {
      if (error instanceof DshRpcError && error.code === "session-not-found") {
        const missingQueue: QueueSnapshot = {
          known: false,
          stale: false,
          connectionEpoch: connection.connectionEpoch,
          items: [],
        };
        return {
          ...statusShape(task, connection, ledger, lineage, "session_not_found", ledger.execution, [], missingQueue, workspaceClaim),
          running: null,
          blank: null,
        };
      }
      if (error instanceof DshTransportError) {
        return {
          ...statusShape(
            task,
            this.connection.snapshot(),
            ledger,
            lineage,
            "host_unreachable",
            ledger.execution,
            [],
            queue,
            workspaceClaim,
          ),
          lastKnownPendingInteractions: ledger.pendingInteractions,
        };
      }
      throw error;
    }
  }

  async tail(taskId: string, sinceCursor = 0, maxEvents = 50, maxBytes = 64_000) {
    const status = await this.status(taskId);
    const tail = await this.ledger.tail(taskId, sinceCursor, maxEvents, maxBytes);
    let events = tail.records;
    let contentUnavailable: false | { reason: string; message?: string } =
      status.availability === "connected"
        ? false
        : { reason: status.availability };
    if (status.availability === "connected") {
      try {
        events = await this.hydrateTail(taskId, tail.records);
        events = this.boundTailContent(events, maxBytes);
      } catch (error) {
        contentUnavailable = {
          reason: error instanceof DshTransportError ? "host_unreachable" : "history_unavailable",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return {
      taskId,
      events,
      nextCursor: tail.nextCursor,
      earliestCursor: tail.earliestCursor,
      hasMore: tail.hasMore,
      contentTruncated: events.some((event) => event.exceededMaxBytes === true),
      status,
      pendingInteractions: status.pendingInteractions,
      logPath: status.logPath,
      contentUnavailable,
      contentSource: "DSH session.history (live); bridge persistence contains coordination metadata only",
      delivery: "at-least-once with deterministic (sourceSessionId, sourceSeq) dedupe",
      mergeOrder: "bridge observation/persistence order; not a DSH global causal order",
    };
  }

  async wait(taskId: string, timeoutSec: number, sinceCursor?: number) {
    this.validateWaitSeconds(timeoutSec);
    const initial = await this.status(taskId);
    const cursor = sinceCursor ?? initial.cursor;
    if (cursor < initial.earliestCursor - 1) {
      await this.ledger.tail(taskId, cursor, 1, 1);
    }
    if (
      initial.cursor > cursor ||
      initial.pendingInteractions.length > 0 ||
      (initial.availability === "connected" && isTerminal(initial.execution))
    ) {
      return { timedOut: false, status: initial, nextCursor: initial.cursor };
    }
    if (timeoutSec === 0) return { timedOut: true, status: initial, nextCursor: initial.cursor };
    const change = await this.connection.waitForTaskChange(
      taskId,
      cursor,
      initial.connection.revision,
      timeoutSec * 1_000,
    );
    const status = await this.status(taskId);
    return { timedOut: change.timedOut, status, nextCursor: status.cursor };
  }

  async observe(taskId: string, afterCursor: number | undefined, waitSeconds: number) {
    return {
      deprecatedAlias: "dsh_observe is a compatibility alias; prefer dsh_wait/dsh_tail task cursors",
      ...(await this.wait(taskId, waitSeconds, afterCursor)),
    };
  }

  async cancel(
    taskId: string,
    scope: "turn" | "queue" = "turn",
    preconditions: WritePreconditions = {},
  ) {
    const view = await this.preflightWrite(taskId, preconditions);
    const { task } = view;
    if (scope === "turn") {
      const receipt = await this.api.sessionCancel(task.sessionId);
      const issuedRpcId = getDshUnaryMetadata(receipt).issuedRpcId;
      return {
        taskId,
        rootSessionId: task.sessionId,
        scope: "turn",
        queuedMessagesPreserved: true,
        runInBackgroundJobsPreserved: true,
        cancellationBoundary:
          "DSH aborts the active turn; foreground tools must honor AbortSignal. Built-in foreground shell escalates SIGTERM to SIGKILL, but background jobs require job_kill.",
        preflight: { cursor: view.ledger.cursor, connectionRevision: view.connection.revision },
        accepted: receipt.accepted,
        issuedRpcId,
      };
    }

    const snapshot = this.connection.queueForSession(task.sessionId);
    if (!snapshot.known || snapshot.stale) {
      throw new BridgeCapabilityError(
        "queue_snapshot_unavailable",
        "cannot clear the queue without a current events.mux session/queue baseline",
        { taskId, rootSessionId: task.sessionId, snapshot },
      );
    }
    const requested = snapshot.items.map((item) => item.id);
    const removed: string[] = [];
    const alreadyClaimed: string[] = [];
    const failed: Array<{ itemId: string; error: unknown }> = [];
    for (const itemId of requested) {
      try {
        await this.api.sessionUpdateQueue(task.sessionId, itemId, { kind: "remove" });
        removed.push(itemId);
      } catch (error) {
        if (error instanceof DshRpcError && error.code === "queue-item-not-found") {
          alreadyClaimed.push(itemId);
        } else {
          failed.push({
            itemId,
            error:
              error instanceof DshRpcError
                ? { name: error.name, code: error.code, message: error.message, details: error.details }
                : { name: error instanceof Error ? error.name : "UnknownError", message: String(error) },
          });
        }
      }
    }
    return {
      taskId,
      rootSessionId: task.sessionId,
      scope: "queue",
      nonAtomic: true,
      requested,
      removed,
      alreadyClaimed,
      failed,
      preflight: { cursor: view.ledger.cursor, connectionRevision: view.connection.revision },
      note: "Each rc.6 session.updateQueue(remove) is independent; an item can be claimed between snapshot and removal.",
    };
  }

  async answerQuestion(
    taskId: string,
    requestId: string,
    answers: DshQuestionAnswer[],
    preconditions: WritePreconditions = {},
  ) {
    await this.preflightWrite(taskId, preconditions, true);
    return this.connection.answerQuestion(taskId, requestId, answers);
  }

  async resolveApproval(
    taskId: string,
    requestId: string,
    outcome: "allow_once" | "reject",
    preconditions: WritePreconditions = {},
  ) {
    await this.preflightWrite(taskId, preconditions, outcome === "allow_once");
    return this.connection.resolveApproval(taskId, requestId, outcome);
  }

  async releaseWorkspace(taskId: string) {
    const task = await this.tasks.get(taskId);
    const released = await this.claims.release(taskId);
    return {
      taskId,
      rootSessionId: task.sessionId,
      released,
      sessionClosedByRelease: false,
      sessionExistence: "not_checked",
      warning:
        "Releasing the bridge claim does not close the DSH session or prevent DSH Web/Codex shell edits. Do not continue this session against the released workspace unless a new isolated worktree/claim is established.",
    };
  }

  async listTasks() {
    const tasks = await this.tasks.list();
    return Promise.all(
      tasks.map(async (task) => {
        try {
          return await this.status(task.taskId);
        } catch (error) {
          return {
            taskId: task.taskId,
            rootSessionId: task.sessionId,
            availability: "host_unreachable",
            status: "unknown",
            workspaceClaimSemantics: workspaceClaimSemantics(),
            error: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) },
          };
        }
      }),
    );
  }

  private validateWaitSeconds(waitSeconds: number): void {
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 30) {
      throw new Error("waitSeconds/timeoutSec must be an integer between 0 and 30");
    }
  }
}
