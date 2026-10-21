import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DshRpcError } from "./dsh-client.js";
import {
  attachDshUnaryMetadata, dshModelSelectionSchema, dshSessionCancelValueSchema,
  dshSessionCreateValueSchema, dshSessionListValueSchema, dshSessionModelsSchema,
  dshSessionPromptValueSchema, dshSessionRenameValueSchema, dshSessionSelectModelValueSchema,
  dshSessionUpdateQueueValueSchema,
  dshSessionEventSchema, type DshSubagentAddress,
  dshQuestionRequestedFrameSchema, dshApprovalRequestedFrameSchema, dshQuestionAnswerSchema,
  type DshApi, type DshUnaryResult, type DshClientResponse, type DshRpcReceipt,
  type DshMuxFrame, type DshServerRequest,
} from "./dsh-types.js";
import { GatewayConnection, GatewayConnectionError } from "./gateway-connection.js";

const catalogSchema = z.object({
  default: dshModelSelectionSchema, routableProviders: z.array(z.string()),
  groups: dshSessionModelsSchema.shape.groups, failures: dshSessionModelsSchema.shape.failures,
});
const projectionsSchema = z.object({ kind: z.literal("sequenced"), asOfSeq: z.number().int(),
  values: z.object({ modelSelection: z.object({ next: dshModelSelectionSchema.nullable(),
    lastUsed: dshModelSelectionSchema.nullable() }) }).passthrough() });
const recordSchema = z.object({ type: z.literal("event"), event: dshSessionEventSchema });
const snapshotSchema = z.object({ type: z.literal("snapshot"), header: z.object({ id: z.string() }).passthrough(),
  cursor: z.number().int().min(-1), records: z.array(recordSchema), hasMore: z.boolean(),
  projections: z.object({ asOfSeq: z.number().int(), values: z.record(z.unknown()) }) });
const pageSchema = z.object({ records: z.array(recordSchema), hasMore: z.boolean() });
const inboxMessageSchema = z.object({ id: z.string().min(1), role: z.string(), content: z.array(z.unknown()) }).passthrough();
const inboxSchema = z.object({ "next-turn": z.array(inboxMessageSchema), "next-step": z.array(inboxMessageSchema) }).strict();

function pendingInbox(snapshot: z.infer<typeof snapshotSchema>) {
  if (snapshot.projections.asOfSeq !== snapshot.cursor) return null;
  const inbox = inboxSchema.safeParse(snapshot.projections.values.inbox);
  if (!inbox.success) return null;
  const items = [
    ...inbox.data["next-turn"].map((message) => ({ id: message.id, placement: "queued" as const, message })),
    ...inbox.data["next-step"].map((message) => ({ id: message.id, placement: "steering" as const, message })),
  ];
  return new Set(items.map((item) => item.id)).size === items.length ? items : null;
}
type Envelope = DshServerRequest<DshMuxFrame>;
class MuxInbox {
  items: Envelope[] = [];
  bytes = 0;
  ended = false;
  error: unknown;
  wake: (() => void) | undefined;
  push(frame: DshMuxFrame, rpcId: string = randomUUID()): void {
    if (this.ended) return;
    const item: Envelope = { type: "server-request", rpcId, method: "events.mux", payload: frame };
    const bytes = Buffer.byteLength(JSON.stringify(item));
    if (this.items.length >= 256 || this.bytes + bytes > 8 * 1024 * 1024) {
      throw new GatewayConnectionError("buffer_overflow", "Gateway normalized observation exceeded its bounded buffer");
    }
    this.items.push(item); this.bytes += bytes; this.wake?.(); this.wake = undefined;
  }
  end(error?: unknown): void { this.ended = true; this.error ??= error; this.wake?.(); this.wake = undefined; }
  async next(): Promise<IteratorResult<Envelope, void>> {
    while (true) {
      if (this.error) throw this.error;
      const item = this.items.shift();
      if (item) { this.bytes -= Buffer.byteLength(JSON.stringify(item)); return { done: false, value: item }; }
      if (this.ended) return { done: true, value: undefined };
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}
interface Generation {
  controller: AbortController;
  inbox: MuxInbox;
  watchers: Map<string, AbortController>;
  pumps: Set<Promise<void>>;
  clientId: string;
  interactions: Set<string>;
}
interface Pending {
  sessionId: string;
  type: "approval" | "question";
  generation: Generation;
  answering: boolean;
}

/** Official Gateway business mapping; the legacy DshClient remains separate. */
export class GatewayDshClient implements DshApi {
  readonly protocolCapabilities = { queueSnapshot: true, forceFreshHistoryCut: true,
    timedQuestions: false, subagentModeDiscovery: false } as const;
  private watched = new Set<string>();
  private generation: Generation | undefined;
  private pending = new Map<string, Pending>();
  constructor(private readonly wire: GatewayConnection, private readonly timeoutMs = 30_000) {}

  private async rpc<T extends object>(method: string, args: Record<string, unknown>, schema: z.ZodType<T>, signal?: AbortSignal)
    : Promise<DshUnaryResult<T>> {
    const result = await this.wire.call(method, args, schema, signal).catch((error: unknown) => {
      if (method === "session/updateQueue" && error instanceof GatewayConnectionError &&
          error.rpcCode === "session/queue-item-not-found") {
        throw new DshRpcError("queue-item-not-found", "queued item is no longer pending", {});
      }
      throw error;
    });
    return attachDshUnaryMetadata(result.value, { issuedRpcId: result.rpcId, method: method.replace("/", ".") });
  }

  async hostDescribe(signal?: AbortSignal) {
    await this.wire.connect(signal);
    const sessions = await this.sessionList(signal);
    return attachDshUnaryMetadata({ version: "unknown", cwd: "", attachedSessions: sessions.items.length,
      canOpenPath: false, protocol: "gateway", protocolContract: "dsh-v0.2.1-rc.2", productVersionVerified: false },
    { issuedRpcId: randomUUID(), method: "host.describe" });
  }

  sessionList(signal?: AbortSignal) {
    return this.rpc("session/list", { _request: {} }, dshSessionListValueSchema, signal);
  }

  sessionCreate(payload: Parameters<DshApi["sessionCreate"]>[0], signal?: AbortSignal) {
    return this.rpc("session/create", { request: payload }, dshSessionCreateValueSchema, signal);
  }

  async sessionModels(sessionId: string, signal?: AbortSignal) {
    const catalog = await this.wire.call("session/modelCatalog", {}, catalogSchema, signal);
    const projection = await this.wire.call("session/projections", { request: { sessionId } }, z.unknown(), signal);
    const parsed = projectionsSchema.safeParse(projection.value);
    if (!parsed.success) throw new DshRpcError("gateway/projections-unavailable",
      "exact session projections are unavailable; the session model cannot be verified", {});
    const selection = parsed.data.values.modelSelection;
    // Only an explicitly empty selection projection proves that the session
    // inherits the deployment default. A missing projection is unknown.
    const current = selection.next ?? selection.lastUsed ?? catalog.value.default;
    return attachDshUnaryMetadata({ current, groups: catalog.value.groups, failures: catalog.value.failures,
      routable: catalog.value.routableProviders.includes(current.provider) && catalog.value.groups.some((group) =>
        group.id === current.provider && group.models.some((model) => model.id === current.model)) },
    { issuedRpcId: catalog.rpcId, method: "session.models" });
  }

  sessionSelectModel(payload: Parameters<DshApi["sessionSelectModel"]>[0], signal?: AbortSignal) {
    return this.rpc("session/selectModel", { request: payload }, dshSessionSelectModelValueSchema, signal);
  }

  async sessionPrompt(payload: Parameters<DshApi["sessionPrompt"]>[0], signal?: AbortSignal) {
    // In the Gateway protocol the durable user/message source correlates to
    // requestId, not to the carrier's separate RPC id. Keep the bridge ledger
    // metadata tied to that durable identity so follow-up/result folding works.
    const requestId = randomUUID();
    const result = await this.wire.call("session/prompt", { request: { ...payload, requestId } }, dshSessionPromptValueSchema, signal);
    return attachDshUnaryMetadata(result.value, { issuedRpcId: requestId, method: "session.prompt" });
  }

  sessionRename(sessionId: string, title: string, signal?: AbortSignal) {
    return this.rpc("session/rename", { request: { sessionId, title } }, dshSessionRenameValueSchema, signal);
  }

  sessionCancel(sessionId: string, signal?: AbortSignal) {
    return this.rpc("session/cancel", { request: { sessionId } }, dshSessionCancelValueSchema, signal);
  }

  sessionUpdateQueue(sessionId: string, itemId: string, action: { kind: "remove" }, signal?: AbortSignal) {
    return this.rpc("session/updateQueue", { request: { sessionId, itemId, action } }, dshSessionUpdateQueueValueSchema, signal);
  }

  private async history(address: Record<string, string>, options: { beforeSeq?: number; maxMessages?: number }, signal?: AbortSignal) {
    const bounded = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]);
    const stream = this.wire.stream("session/follow", { request: { address, maxMessages: 1 } }, bounded);
    let opening: z.infer<typeof snapshotSchema>;
    try {
      const first = await stream.next();
      const parsed = snapshotSchema.safeParse(first.value);
      if (first.done || !parsed.success || parsed.data.header.id !== (address.sessionId ?? address.childSessionId)) {
        throw new DshRpcError("gateway/unsupported-snapshot", "the official session opening snapshot could not be verified", {});
      }
      opening = parsed.data;
    } finally { await stream.return(); }
    const page = await this.wire.call("session/page", { request: { address, throughSeq: opening.cursor, ...options } }, pageSchema, bounded);
    if (page.value.records.some((record) => record.event.seq > opening.cursor ||
        (options.beforeSeq !== undefined && record.event.seq >= options.beforeSeq))) {
      throw new DshRpcError("gateway/invalid-history-cut", "the Host history page exceeded the verified cut", {});
    }
    return attachDshUnaryMetadata({ events: page.value.records.map((record) => ({ event: record.event })),
      hasMore: page.value.hasMore, projections: opening.projections.values, queueSnapshot: pendingInbox(opening) },
    { issuedRpcId: page.rpcId, method: "session.history" });
  }

  sessionHistory(sessionId: string, options: { beforeSeq?: number; maxMessages?: number } = {}, signal?: AbortSignal) {
    return this.history({ kind: "session", sessionId }, options, signal);
  }

  subagentHistory(address: DshSubagentAddress, options: { beforeSeq?: number; maxMessages?: number } = {}, signal?: AbortSignal) {
    return this.history({ kind: "subagent", ...address }, options, signal);
  }

  async subagentList(_parentSessionId: string): Promise<never> {
    throw new DshRpcError("gateway/subagent-catalog-unsupported", "subagent mode discovery is not verified on this Gateway contract", {});
  }

  trackSessions(sessionIds: readonly string[]): void {
    this.watched = new Set(sessionIds);
    const generation = this.generation;
    if (!generation) return;
    for (const [id, controller] of generation.watchers) {
      if (!this.watched.has(id)) { controller.abort(); generation.watchers.delete(id); }
    }
    for (const id of this.watched) this.startWatcher(id, generation);
  }

  private pump(generation: Generation, run: () => Promise<void>): void {
    const promise = run().catch((error: unknown) => {
      if (!generation.controller.signal.aborted) generation.inbox.end(error);
    });
    generation.pumps.add(promise);
    void promise.finally(() => { generation.pumps.delete(promise); });
  }

  private startWatcher(sessionId: string, generation: Generation): void {
    if (generation.watchers.has(sessionId)) return;
    const controller = new AbortController();
    generation.watchers.set(sessionId, controller);
    const signal = AbortSignal.any([generation.controller.signal, controller.signal]);
    this.pump(generation, async () => {
      const openingTimer = setTimeout(() => controller.abort(), this.timeoutMs);
      let opened = false;
      try {
        for await (const value of this.wire.stream("session/follow", { request: {
          address: { kind: "session", sessionId }, maxMessages: 50,
        } }, signal)) {
          if (!opened) {
            const parsed = snapshotSchema.safeParse(value);
            if (!parsed.success || parsed.data.header.id !== sessionId) {
              throw new GatewayConnectionError("unsupported_protocol", "session follow opening is invalid");
            }
            opened = true; clearTimeout(openingTimer);
            generation.inbox.push({ type: "session/subscribed", sessionId, lastSeq: parsed.data.cursor });
            for (const record of parsed.data.records) generation.inbox.push({ type: "session/event", sessionId, event: record.event });
          } else {
            const parsed = recordSchema.safeParse(value);
            if (!parsed.success) throw new GatewayConnectionError("unsupported_protocol", "unsupported durable session frame");
            generation.inbox.push({ type: "session/event", sessionId, event: parsed.data.event });
          }
        }
        if (!signal.aborted) throw new DshRpcError("gateway/follow-ended", "session follow ended before cancellation", {});
      } catch (error) {
        if (!signal.aborted) throw error;
        if (!opened && this.watched.has(sessionId) && !generation.controller.signal.aborted) {
          throw new DshRpcError("gateway/snapshot-timeout", "session follow opening timed out", {});
        }
      } finally { clearTimeout(openingTimer); }
    });
  }

  private async receiveEvent(value: unknown, generation: Generation): Promise<void> {
    const record = z.object({ type: z.string() }).passthrough().safeParse(value);
    if (!record.success) throw new GatewayConnectionError("unsupported_protocol", "invalid forwarded event");
    const frame = record.data;
    if (frame.type === "cancel" && typeof frame.eventId === "string") {
      const pending = this.pending.get(frame.eventId);
      if (pending?.generation !== generation) return;
      this.pending.delete(frame.eventId);
      generation.inbox.push(pending.type === "approval"
        ? { type: "approval/resolved", sessionId: pending.sessionId, approvalId: frame.eventId, outcome: "cancelled" }
        : { type: "question/resolved", sessionId: pending.sessionId, questionRpcId: frame.eventId, outcome: "cancelled" });
      return;
    }
    if (frame.type !== "waterfall") return; // Do not forward unrelated account/settings notifications.
    const invocation = z.object({ event: z.string(), eventId: z.string().min(1), agentId: z.string().min(1), request: z.record(z.unknown()) }).safeParse(frame);
    if (!invocation.success) throw new GatewayConnectionError("unsupported_protocol", "invalid forwarded interaction");
    const { event, eventId, agentId: sessionId, request } = invocation.data;
    if (generation.interactions.has(eventId)) return;
    // Retain delivery identities after settlement/cancellation. Forgetting an
    // answered event would make a duplicate look like a new human approval.
    // Bound this generation instead of evicting identities and allowing replay.
    if (generation.interactions.size >= 1_024) {
      throw new GatewayConnectionError("buffer_overflow", "Gateway interaction generation exceeded its bounded history");
    }
    generation.interactions.add(eventId);
    const wait = request.wait as { timed?: unknown } | undefined;
    if (!this.watched.has(sessionId) || !["approval/request", "user-questions/request"].includes(event) || wait?.timed === true) {
      // Delegating to the Host's next human answerer is not granting approval.
      await this.wire.call("$events/result", { clientId: generation.clientId, eventId, outcome: { kind: "next" } }, z.undefined(), generation.controller.signal);
      return;
    }
    if (this.pending.has(eventId)) return;
    const pending = event === "approval/request"
      ? dshApprovalRequestedFrameSchema.safeParse({ ...request, type: "approval/requested", sessionId, approvalId: eventId })
      : dshQuestionRequestedFrameSchema.safeParse({ questions: request.questions, type: "question/requested", sessionId });
    if (!pending.success) throw new GatewayConnectionError("unsupported_protocol", "interaction cannot be normalized safely");
    this.pending.set(eventId, { sessionId, type: event === "approval/request" ? "approval" : "question", generation, answering: false });
    generation.inbox.push(pending.data, eventId);
  }

  async respond(message: DshClientResponse, signal?: AbortSignal): Promise<DshRpcReceipt> {
    const pending = this.pending.get(message.rpcId);
    if (!pending || pending.generation !== this.generation || pending.answering || !this.watched.has(pending.sessionId)) {
      return { accepted: false, reason: "not-pending" };
    }
    const value = message.result.value;
    if (value.sessionId !== pending.sessionId) return { accepted: false, reason: "bad-response" };
    let answer: unknown;
    if (pending.type === "approval") {
      if (!("approvalId" in value) || value.approvalId !== message.rpcId ||
          !["allowed-once", "rejected"].includes(value.outcome)) return { accepted: false, reason: "bad-response" };
      answer = value.outcome;
    } else {
      if (!("answer" in value) || !z.object({ answers: z.array(dshQuestionAnswerSchema) }).safeParse(value.answer).success) {
        return { accepted: false, reason: "bad-response" };
      }
      answer = value.answer;
    }
    pending.answering = true; // Never replay a response after an uncertain HTTP outcome.
    await this.wire.call("$events/result", { clientId: pending.generation.clientId, eventId: message.rpcId,
      outcome: { kind: "result", value: answer } }, z.undefined(), signal);
    this.pending.delete(message.rpcId);
    return { accepted: true };
  }

  async *openMux(signal: AbortSignal, onOpen?: () => void): AsyncGenerator<Envelope, void> {
    if (this.generation) throw new DshRpcError("gateway/duplicate-observer", "only one bridge observer may own the API generation", {});
    const ready = await this.wire.connect(signal);
    const generation: Generation = { controller: new AbortController(), inbox: new MuxInbox(), watchers: new Map(),
      pumps: new Set(), clientId: ready.clientId, interactions: new Set() };
    const abort = () => { generation.controller.abort(); generation.inbox.end(); };
    signal.addEventListener("abort", abort, { once: true });
    this.generation = generation;
    this.pending.clear();
    if (signal.aborted) abort();
    try {
      this.pump(generation, async () => {
        for await (const frame of this.wire.events(generation.controller.signal)) await this.receiveEvent(frame, generation);
        if (!generation.controller.signal.aborted) throw new DshRpcError("gateway/events-ended", "forwarded-event generation ended", {});
      });
      for (const id of this.watched) this.startWatcher(id, generation);
      onOpen?.();
      while (!signal.aborted) {
        const item = await generation.inbox.next();
        if (item.done) return;
        yield item.value;
      }
    } finally {
      signal.removeEventListener("abort", abort);
      generation.controller.abort();
      await Promise.allSettled([...generation.pumps]);
      this.pending.clear();
      if (this.generation === generation) this.generation = undefined;
    }
  }

  close(): void { this.wire.close(); }
  endpointSnapshot() { return this.wire.endpointSnapshot(); }
}
