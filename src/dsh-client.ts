import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  attachDshUnaryMetadata,
  dshHostDescriptionSchema,
  dshMuxFrameSchema,
  dshRpcErrorBodySchema,
  dshRpcReceiptSchema,
  dshServerRequestSchema,
  dshSessionCancelValueSchema,
  dshSessionCreateValueSchema,
  dshSessionHistorySchema,
  dshSessionListValueSchema,
  dshSessionModelsSchema,
  dshSessionPromptValueSchema,
  dshSessionRenameValueSchema,
  dshSessionSelectModelValueSchema,
  dshSessionUpdateQueueValueSchema,
  dshSubagentListValueSchema,
} from "./dsh-types.js";
import type {
  DshApi,
  DshClientResponse,
  DshHostDescription,
  DshModelSelection,
  DshMuxFrame,
  DshServerRequest,
  DshSessionHistory,
  DshSessionModels,
  DshSessionSummary,
  DshSubagentAddress,
  DshUnaryResult,
} from "./dsh-types.js";

export class DshTransportError extends Error {
  constructor(message: string, readonly causeValue?: unknown) {
    super(message, { cause: causeValue });
    this.name = "DshTransportError";
  }
}

export class DshRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: unknown,
  ) {
    super(message);
    this.name = "DshRpcError";
  }
}

type FetchLike = typeof fetch;
type WebSocketLike = WebSocket;
type WebSocketFactory = (url: string) => WebSocketLike;

export interface HostEndpointResolution {
  baseUrl: string;
  source: "configured" | "windows-process-listener";
}

export interface HostEndpointResolver {
  mode: "static" | "desktop-auto";
  configuredBaseUrl?: string;
  resolve(): Promise<HostEndpointResolution>;
}

export interface HostEndpointSnapshot {
  mode: "static" | "desktop-auto";
  configuredBaseUrl?: string;
  resolvedBaseUrl?: string;
  source?: HostEndpointResolution["source"];
  resolutionEpoch: number;
  lastError?: string;
}

export function getHostEndpointSnapshot(
  api: DshApi,
  fallback: { mode: "static" | "desktop-auto" | undefined; configuredBaseUrl: string },
): HostEndpointSnapshot {
  const endpointAware = api as DshApi & { endpointSnapshot?: () => HostEndpointSnapshot };
  if (typeof endpointAware.endpointSnapshot === "function") return endpointAware.endpointSnapshot();
  const mode = fallback.mode ?? "static";
  return {
    mode,
    ...(mode === "desktop-auto" ? {} : { configuredBaseUrl: fallback.configuredBaseUrl }),
    ...(mode === "desktop-auto"
      ? {}
      : { resolvedBaseUrl: fallback.configuredBaseUrl, source: "configured" as const }),
    resolutionEpoch: 0,
  };
}

const WS_CONNECTING = 0;
const WS_OPEN = 1;

const dshServerResponseSchema = z
  .object({
    type: z.literal("server-response"),
    rpcId: z.string(),
    result: z.union([
      z.object({ ok: z.literal(true), value: z.unknown() }).passthrough(),
      z.object({ ok: z.literal(false), error: dshRpcErrorBodySchema }).passthrough(),
    ]),
  })
  .passthrough();

function combinedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
}

function schemaMessage(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length === 0 ? "value" : issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

export function parseServerRequest(value: unknown): DshServerRequest {
  const parsed = dshServerRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new DshTransportError(`invalid DSH server-request envelope: ${schemaMessage(parsed.error)}`, parsed.error);
  }
  return {
    type: "server-request",
    rpcId: parsed.data.rpcId,
    method: parsed.data.method,
    payload: parsed.data.payload,
  };
}

function parseMuxServerRequest(value: unknown): DshServerRequest<DshMuxFrame> {
  const envelope = parseServerRequest(value);
  const payload = dshMuxFrameSchema.safeParse(envelope.payload);
  if (!payload.success) {
    throw new DshTransportError(`invalid DSH events.mux frame: ${schemaMessage(payload.error)}`, payload.error);
  }
  if (envelope.method !== payload.data.type) {
    throw new DshTransportError(
      `invalid DSH events.mux method ${JSON.stringify(envelope.method)} for frame ${JSON.stringify(payload.data.type)}`,
    );
  }
  if (payload.data.type === "stream/error") {
    throw new DshRpcError(payload.data.error.code, payload.data.error.message, payload.data.error.details);
  }
  return { ...envelope, payload: payload.data };
}

export class DshClient implements DshApi {
  private readonly endpointResolver: HostEndpointResolver;
  private resolvedEndpoint: HostEndpointResolution | undefined;
  private endpointPromise: Promise<HostEndpointResolution> | undefined;
  private resolutionEpoch = 0;
  private endpointError: string | undefined;

  constructor(
    endpoint: string | HostEndpointResolver,
    private readonly timeoutMs = 30_000,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    private readonly webSocketFactory: WebSocketFactory = (url) => new WebSocket(url),
  ) {
    this.endpointResolver =
      typeof endpoint === "string"
        ? {
            mode: "static",
            configuredBaseUrl: endpoint.replace(/\/$/, ""),
            resolve: async () => ({ baseUrl: endpoint.replace(/\/$/, ""), source: "configured" }),
          }
        : endpoint;
  }

  get baseUrl(): string {
    return this.resolvedEndpoint?.baseUrl ?? this.endpointResolver.configuredBaseUrl ?? "";
  }

  endpointSnapshot(): HostEndpointSnapshot {
    return {
      mode: this.endpointResolver.mode,
      ...(this.endpointResolver.configuredBaseUrl === undefined
        ? {}
        : { configuredBaseUrl: this.endpointResolver.configuredBaseUrl }),
      ...(this.resolvedEndpoint === undefined
        ? {}
        : { resolvedBaseUrl: this.resolvedEndpoint.baseUrl, source: this.resolvedEndpoint.source }),
      resolutionEpoch: this.resolutionEpoch,
      ...(this.endpointError === undefined ? {} : { lastError: this.endpointError }),
    };
  }

  private async resolveEndpoint(): Promise<HostEndpointResolution> {
    if (this.resolvedEndpoint !== undefined) return this.resolvedEndpoint;
    if (this.endpointPromise !== undefined) return this.endpointPromise;
    const pending = this.endpointResolver
      .resolve()
      .then((resolution) => {
        const normalized = { ...resolution, baseUrl: resolution.baseUrl.replace(/\/$/, "") };
        this.resolvedEndpoint = normalized;
        this.resolutionEpoch += 1;
        this.endpointError = undefined;
        return normalized;
      })
      .catch((error: unknown) => {
        this.endpointError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        throw error;
      });
    this.endpointPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.endpointPromise === pending) this.endpointPromise = undefined;
    }
  }

  private invalidateEndpoint(resolution: HostEndpointResolution, error: unknown): void {
    if (this.resolvedEndpoint?.baseUrl !== resolution.baseUrl) return;
    this.resolvedEndpoint = undefined;
    this.endpointError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  private async call<T extends object>(
    method: string,
    payload: unknown,
    valueSchema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<T>> {
    const endpoint = await this.resolveEndpoint();
    const baseUrl = endpoint.baseUrl;
    const rpcId = randomUUID();
    const request = {
      type: "client-request",
      rpcId,
      method,
      payload,
    };

    let response: Response;
    try {
      response = await this.fetchImpl(new URL(`/api/${method}`, baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: combinedSignal(this.timeoutMs, signal),
      });
    } catch (error) {
      const transportError = new DshTransportError(`failed to reach DSH Host at ${baseUrl}: ${String(error)}`, error);
      this.invalidateEndpoint(endpoint, transportError);
      throw transportError;
    }

    if (!response.ok) {
      const transportError = new DshTransportError(`DSH transport failure for ${method}: HTTP ${response.status}`);
      this.invalidateEndpoint(endpoint, transportError);
      throw transportError;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new DshTransportError(`DSH returned non-JSON data for ${method}`, error);
    }

    const envelope = dshServerResponseSchema.safeParse(body);
    if (!envelope.success) {
      throw new DshTransportError(
        `invalid DSH server-response envelope for ${method}: ${schemaMessage(envelope.error)}`,
        envelope.error,
      );
    }
    if (envelope.data.rpcId !== rpcId) {
      throw new DshTransportError(`mismatched DSH rpcId in response for ${method}`);
    }

    const rpcResult = envelope.data.result;
    if (!rpcResult.ok) {
      throw new DshRpcError(rpcResult.error.code, rpcResult.error.message, rpcResult.error.details);
    }

    const value = valueSchema.safeParse(rpcResult.value);
    if (!value.success) {
      throw new DshTransportError(
        `invalid DSH response value for ${method}: ${schemaMessage(value.error)}`,
        value.error,
      );
    }
    return attachDshUnaryMetadata(value.data, { issuedRpcId: rpcId, method });
  }

  hostDescribe(signal?: AbortSignal): Promise<DshUnaryResult<DshHostDescription>> {
    return this.call("host.describe", {}, dshHostDescriptionSchema, signal);
  }

  sessionList(signal?: AbortSignal): Promise<DshUnaryResult<{ items: DshSessionSummary[] }>> {
    return this.call("session.list", {}, dshSessionListValueSchema, signal);
  }

  sessionCreate(
    payload: { cwd: string; agentPreset?: string; sessionId?: string },
    signal?: AbortSignal,
  ) {
    return this.call("session.create", payload, dshSessionCreateValueSchema, signal);
  }

  sessionModels(sessionId: string, signal?: AbortSignal): Promise<DshUnaryResult<DshSessionModels>> {
    return this.call("session.models", { sessionId }, dshSessionModelsSchema, signal);
  }

  sessionSelectModel(
    payload: { sessionId: string; provider: string; model: string; reasoningEffort?: string },
    signal?: AbortSignal,
  ) {
    return this.call("session.selectModel", payload, dshSessionSelectModelValueSchema, signal);
  }

  sessionPrompt(
    payload: {
      sessionId: string;
      mode: "queue" | "steer";
      content: Array<{ type: "text"; text: string }>;
      clientTimeZone?: string;
    },
    signal?: AbortSignal,
  ) {
    return this.call("session.prompt", payload, dshSessionPromptValueSchema, signal);
  }

  sessionRename(sessionId: string, title: string, signal?: AbortSignal) {
    return this.call("session.rename", { sessionId, title }, dshSessionRenameValueSchema, signal);
  }

  sessionHistory(
    sessionId: string,
    options: { beforeSeq?: number; maxMessages?: number } = {},
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<DshSessionHistory>> {
    return this.call("session.history", { sessionId, ...options }, dshSessionHistorySchema, signal);
  }

  sessionCancel(sessionId: string, signal?: AbortSignal) {
    return this.call("session.cancel", { sessionId }, dshSessionCancelValueSchema, signal);
  }

  sessionUpdateQueue(sessionId: string, itemId: string, action: { kind: "remove" }, signal?: AbortSignal) {
    return this.call("session.updateQueue", { sessionId, itemId, action }, dshSessionUpdateQueueValueSchema, signal);
  }

  subagentList(parentSessionId: string, signal?: AbortSignal) {
    return this.call("subagent.list", { parentSessionId }, dshSubagentListValueSchema, signal);
  }

  subagentHistory(
    address: DshSubagentAddress,
    options: { beforeSeq?: number; maxMessages?: number } = {},
    signal?: AbortSignal,
  ): Promise<DshUnaryResult<DshSessionHistory>> {
    return this.call("subagent.history", { ...address, ...options }, dshSessionHistorySchema, signal);
  }

  async respond(message: DshClientResponse, signal?: AbortSignal) {
    const endpoint = await this.resolveEndpoint();
    const baseUrl = endpoint.baseUrl;
    let response: Response;
    try {
      response = await this.fetchImpl(new URL("/api/respond", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
        signal: combinedSignal(this.timeoutMs, signal),
      });
    } catch (error) {
      const transportError = new DshTransportError(`failed to reach DSH Host at ${baseUrl}: ${String(error)}`, error);
      this.invalidateEndpoint(endpoint, transportError);
      throw transportError;
    }
    if (!response.ok) {
      const transportError = new DshTransportError(`DSH transport failure for respond: HTTP ${response.status}`);
      this.invalidateEndpoint(endpoint, transportError);
      throw transportError;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new DshTransportError("DSH returned non-JSON data for respond", error);
    }
    const receipt = dshRpcReceiptSchema.safeParse(body);
    if (!receipt.success) {
      throw new DshTransportError(`invalid DSH respond receipt: ${schemaMessage(receipt.error)}`, receipt.error);
    }
    return receipt.data;
  }

  openMux(signal: AbortSignal, onOpen?: () => void): AsyncIterable<DshServerRequest<DshMuxFrame>> {
    return this.openResolvedMux(signal, onOpen);
  }

  private async *openResolvedMux(
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<DshServerRequest<DshMuxFrame>> {
    const endpoint = await this.resolveEndpoint();
    try {
      yield* this.openWebSocketStream("/api/events.mux", endpoint.baseUrl, signal, onOpen);
    } catch (error) {
      if (error instanceof DshTransportError) this.invalidateEndpoint(endpoint, error);
      throw error;
    }
  }

  private async *openWebSocketStream(
    path: string,
    baseUrl: string,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<DshServerRequest<DshMuxFrame>> {
    const url = new URL(path, baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = this.webSocketFactory(url.toString());
    const inbox: Array<
      | { kind: "frame"; value: DshServerRequest<DshMuxFrame> }
      | { kind: "error"; error: Error }
      | { kind: "end" }
    > = [];
    let wake: (() => void) | undefined;
    const connectTimer = setTimeout(() => {
      enqueue({ kind: "error", error: new DshTransportError(`DSH WebSocket connect timed out at ${url}`) });
      if (socket.readyState === WS_CONNECTING || socket.readyState === WS_OPEN) socket.close();
    }, this.timeoutMs);

    const enqueue = (item: (typeof inbox)[number]) => {
      inbox.push(item);
      wake?.();
      wake = undefined;
    };

    const onMessage = (event: MessageEvent) => {
      try {
        if (typeof event.data !== "string") throw new DshTransportError("DSH sent a binary WebSocket frame");
        enqueue({ kind: "frame", value: parseMuxServerRequest(JSON.parse(event.data)) });
      } catch (error) {
        enqueue({ kind: "error", error: error instanceof Error ? error : new Error(String(error)) });
      }
    };
    const handleOpen = () => {
      clearTimeout(connectTimer);
      try {
        onOpen?.();
      } catch (error) {
        enqueue({ kind: "error", error: error instanceof Error ? error : new Error(String(error)) });
      }
    };
    const onError = () => enqueue({ kind: "error", error: new DshTransportError(`DSH WebSocket failed at ${url}`) });
    const onClose = (event: CloseEvent) => {
      clearTimeout(connectTimer);
      if (signal.aborted || event.code === 1000 || event.code === 1005) {
        enqueue({ kind: "end" });
      } else {
        enqueue({
          kind: "error",
          error: new DshTransportError(
            `DSH WebSocket closed at ${url} with code ${event.code}${event.reason === "" ? "" : `: ${event.reason}`}`,
          ),
        });
      }
    };
    const onAbort = () => {
      if (socket.readyState === WS_CONNECTING || socket.readyState === WS_OPEN) socket.close();
      enqueue({ kind: "end" });
    };

    socket.addEventListener("open", handleOpen, { once: true });
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError, { once: true });
    socket.addEventListener("close", onClose, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift();
          if (item === undefined || item.kind === "end") return;
          if (item.kind === "error") throw item.error;
          yield item.value;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      clearTimeout(connectTimer);
      signal.removeEventListener("abort", onAbort);
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("message", onMessage);
      if (socket.readyState === WS_CONNECTING || socket.readyState === WS_OPEN) socket.close();
    }
  }
}

export function formatModel(selection: DshModelSelection): string {
  return `${selection.provider}/${selection.model}${selection.reasoningEffort === undefined ? "" : ` (${selection.reasoningEffort})`}`;
}
