import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";
import { z } from "zod";

import { DshTransportError, type HostEndpointResolver, type HostEndpointSnapshot } from "./dsh-client.js";

export type GatewayFailureCode =
  | "auth_required" | "auth_rejected" | "unsupported_protocol"
  | "transport_failure" | "aborted" | "buffer_overflow" | "rpc_rejected" | "peer_conflict";

/** Deliberately contains no URL, raw response, credential, or underlying cause. */
export class GatewayConnectionError extends DshTransportError {
  constructor(readonly code: GatewayFailureCode, message: string) {
    super(message);
    this.name = "GatewayConnectionError";
  }
}

export interface GatewayReady {
  clientId: string;
  host: { home: string };
}

export interface GatewayConnectionOptions {
  endpoint: HostEndpointResolver;
  /** Explicit operator input only; never a credential-store or browser-cookie lookup. */
  getConnectToken: () => string | undefined;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

const readySchema = z.object({
  type: z.literal("ready"), clientId: z.string().min(1), host: z.object({ home: z.string() }).strict(),
}).strict();
const responseSchema = z.object({
  type: z.literal("server-response"), rpcId: z.string().min(1),
  result: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value: z.unknown().optional() }).strict(),
    z.object({ ok: z.literal(false), error: z.unknown() }).strict(),
  ]),
}).strict();
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const frameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("item"), streamId: z.string().min(1), value: z.unknown().optional() }).strict(),
  z.object({ type: z.literal("end"), streamId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("error"), streamId: z.string().min(1),
    error: z.object({ code: z.string(), message: z.string(), details: z.record(z.unknown()) }).strict() }).strict(),
]);

class StreamInbox {
  #items: Array<{ value: unknown; bytes: number }> = [];
  #wake: (() => void) | undefined;
  #failure: Error | undefined;
  #ended = false;
  #peer: Peer;
  constructor(peer: Peer) { this.#peer = peer; }
  push(value: unknown, bytes: number): void {
    if (this.#ended) return;
    if (this.#items.length >= 256 || this.#peer.bufferedBytes + bytes > MAX_BUFFERED_BYTES) {
      throw failure("buffer_overflow");
    }
    this.#peer.bufferedBytes += bytes;
    this.#items.push({ value, bytes });
    this.#wake?.(); this.#wake = undefined;
  }
  end(error?: Error): void {
    this.#ended = true;
    this.#failure = error;
    if (error) this.clear();
    this.#wake?.(); this.#wake = undefined;
  }
  clear(): void {
    for (const item of this.#items) this.#peer.bufferedBytes -= item.bytes;
    this.#items = [];
  }
  async next(): Promise<IteratorResult<unknown, void>> {
    while (true) {
      if (this.#failure) throw this.#failure;
      const item = this.#items.shift();
      if (item) { this.#peer.bufferedBytes -= item.bytes; return { done: false, value: item.value }; }
      if (this.#ended) return { done: true, value: undefined };
      await new Promise<void>((resolve) => { this.#wake = resolve; });
    }
  }
}

function failure(code: GatewayFailureCode): GatewayConnectionError {
  const messages: Record<GatewayFailureCode, string> = {
    auth_required: "Official Harness requires an explicitly supplied connection token",
    auth_rejected: "Official Harness rejected API Peer authorization; no authentication fallback was attempted",
    unsupported_protocol: "Official Harness returned an unsupported Gateway protocol response",
    transport_failure: "Official Harness Gateway connection failed; a sent operation was not retried",
    aborted: "Official Harness Gateway operation was cancelled",
    buffer_overflow: "Official Harness Gateway observation exceeded its bounded buffer",
    rpc_rejected: "Official Harness rejected the Gateway RPC",
    peer_conflict: "Official Harness refused duplicate API Peer socket ownership",
  };
  return new GatewayConnectionError(code, messages[code]);
}

function originUrl(raw: string): URL {
  // Do not echo invalid input: even a misconfigured endpoint may contain secrets.
  let url: URL;
  try { url = new URL(raw); } catch { throw failure("unsupported_protocol"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) throw failure("unsupported_protocol");
  return url;
}

function apiCookie(response: Response, origin: URL): string {
  const cookies = response.headers.getSetCookie();
  if (cookies.length !== 1) throw failure("unsupported_protocol");
  const parts = cookies[0]!.split(";").map((part) => part.trim());
  const authority = origin.protocol === "https:" ? origin.origin : origin.host;
  const name = `dsh-auth-${createHash("sha256").update(authority).digest("base64url")}`;
  const pair = parts[0]!;
  if (!pair.startsWith(`${name}=v2.`) ||
      !/^dsh-auth-[A-Za-z0-9_-]+=v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(pair) ||
      !parts.some((part) => part.toLowerCase() === "httponly") ||
      !parts.some((part) => part.toLowerCase() === "path=/") ||
      parts.some((part) => /^domain=/i.test(part))) throw failure("unsupported_protocol");
  return pair;
}

interface Peer {
  origin: URL;
  cookie: string;
  controller: AbortController;
  socket?: WebSocket;
  ready?: GatewayReady;
  streams: Map<string, StreamInbox>;
  bufferedBytes: number;
  eventStreamId: string;
  eventConsumer: boolean;
}

/**
 * Opt-in wire transport for official dsh-v0.2.1-rc.2 Connection/Gateway.
 * One /connect exchange owns exactly one socket. No mutation or socket is
 * retried internally. An explicit later connect may establish a new Peer.
 * Not used by the legacy client or by read-only diagnostics.
 */
export class GatewayConnection {
  #endpoint: HostEndpointResolver;
  #getToken: () => string | undefined;
  #timeoutMs: number;
  #fetch: typeof fetch;
  #peer: Peer | undefined;
  #connecting: Promise<Peer> | undefined;
  #disposed = false;
  #endpointSnapshot: HostEndpointSnapshot;

  constructor(options: GatewayConnectionOptions) {
    this.#endpoint = options.endpoint;
    this.#getToken = options.getConnectToken;
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#endpointSnapshot = { mode: options.endpoint.mode, resolutionEpoch: 0,
      ...(options.endpoint.configuredBaseUrl === undefined ? {} : { configuredBaseUrl: originUrl(options.endpoint.configuredBaseUrl).origin }) };
  }

  endpointSnapshot(): HostEndpointSnapshot { return { ...this.#endpointSnapshot }; }

  async connect(signal?: AbortSignal): Promise<GatewayReady> {
    return (await this.#ensurePeer(signal)).ready!;
  }

  /** One consumer owns the event generation; leaving it revokes the API Peer. */
  async *events(signal: AbortSignal): AsyncGenerator<unknown, void> {
    const peer = await this.#ensurePeer(signal);
    if (peer.eventConsumer) throw failure("unsupported_protocol");
    peer.eventConsumer = true;
    try { yield* this.#consume(peer.streams.get(peer.eventStreamId)!, signal); }
    finally { this.#release(peer); }
  }

  /** Logical-stream cancellation never closes another stream's physical socket. */
  async *stream(endpoint: string, args: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<unknown, void> {
    if (!/^[a-zA-Z][a-zA-Z0-9]*\/[a-zA-Z][a-zA-Z0-9]*$/.test(endpoint)) throw failure("unsupported_protocol");
    const peer = await this.#ensurePeer(signal);
    if (peer.streams.size >= 64) throw failure("buffer_overflow");
    const streamId = randomUUID();
    const inbox = new StreamInbox(peer);
    peer.streams.set(streamId, inbox);
    try {
      this.#send(peer, { type: "open", streamId, endpoint, payload: { args } });
      yield* this.#consume(inbox, signal);
    } finally {
      peer.streams.delete(streamId);
      inbox.clear();
      if (peer.socket?.readyState === WebSocket.OPEN) this.#send(peer, { type: "cancel", streamId });
    }
  }

  async *#consume(inbox: StreamInbox, signal: AbortSignal): AsyncGenerator<unknown, void> {
    const abort = () => inbox.end(failure("aborted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      while (true) {
        const item = await inbox.next();
        if (item.done) return;
        yield item.value;
      }
    } finally { signal.removeEventListener("abort", abort); }
  }

  async call<T>(endpoint: string, args: Record<string, unknown>, schema: z.ZodType<T>, signal?: AbortSignal)
    : Promise<{ value: T; rpcId: string }> {
    if (!/^(?:[a-zA-Z][a-zA-Z0-9]*|\$events)\/[a-zA-Z][a-zA-Z0-9]*$/.test(endpoint)) {
      throw failure("unsupported_protocol");
    }
    const peer = await this.#ensurePeer(signal);
    const rpcId = randomUUID();
    const requestSignal = AbortSignal.any([
      peer.controller.signal, AbortSignal.timeout(this.#timeoutMs), ...(signal ? [signal] : []),
    ]);
    try {
      const response = await this.#fetch(new URL(`/api/${endpoint}`, peer.origin), {
        method: "POST", redirect: "manual", credentials: "omit", cache: "no-store",
        headers: { "content-type": "application/json", cookie: peer.cookie },
        body: JSON.stringify({ type: "client-request", rpcId, method: endpoint, payload: { args } }),
        signal: requestSignal,
      });
      if (response.status === 401 || response.status === 403) throw failure("auth_rejected");
      // A missing/method-incompatible endpoint is not a network outage. Stop
      // background reconnect rather than repeatedly minting API Peers against
      // an incompatible Host. Keep untrusted response bodies out of errors.
      if (response.status >= 400 && response.status < 500) throw failure("unsupported_protocol");
      if (!response.ok) throw failure("transport_failure");
      const decoded = responseSchema.safeParse(await this.#json(response));
      if (!decoded.success || decoded.data.rpcId !== rpcId) throw failure("unsupported_protocol");
      if (!decoded.data.result.ok) throw failure("rpc_rejected");
      const result = schema.safeParse(decoded.data.result.value);
      if (!result.success) throw failure("unsupported_protocol");
      return { value: result.data, rpcId };
    } catch (error) {
      const safe = signal?.aborted ? failure("aborted")
        : error instanceof GatewayConnectionError ? error : failure("transport_failure");
      // A rejected business RPC doesn't revoke an otherwise healthy Peer.
      if (safe.code !== "rpc_rejected") this.#release(peer);
      throw safe;
    }
  }

  close(): void {
    this.#disposed = true;
    if (this.#peer) this.#release(this.#peer);
  }

  async #json(response: Response): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw failure("unsupported_protocol");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > MAX_MESSAGE_BYTES) throw failure("buffer_overflow");
        chunks.push(item.value);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
      catch { throw failure("unsupported_protocol"); }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }

  async #ensurePeer(signal?: AbortSignal): Promise<Peer> {
    if (this.#disposed || signal?.aborted) throw failure("aborted");
    if (this.#peer?.ready && !this.#peer.controller.signal.aborted) return this.#peer;
    this.#connecting ??= this.#establish(signal).finally(() => { this.#connecting = undefined; });
    const connecting = this.#connecting;
    if (!signal) return connecting;
    return new Promise<Peer>((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(failure("aborted")); };
      signal.addEventListener("abort", abort, { once: true });
      void connecting.then((peer) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(failure("aborted")); else resolve(peer);
      }, (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      });
      if (signal.aborted) abort();
    });
  }

  async #establish(signal?: AbortSignal): Promise<Peer> {
    let peer: Peer | undefined;
    try {
      const token = this.#getToken();
      if (!token?.trim()) throw failure("auth_required");
      const resolved = await this.#endpoint.resolve();
      const origin = originUrl(resolved.baseUrl);
      this.#endpointSnapshot = { ...this.#endpointSnapshot, resolvedBaseUrl: origin.origin, source: resolved.source,
        resolutionEpoch: this.#endpointSnapshot.resolutionEpoch + 1 };
      if (this.#disposed || signal?.aborted) throw failure("aborted");
      peer = { origin, cookie: "", controller: new AbortController(), streams: new Map(),
        bufferedBytes: 0, eventStreamId: randomUUID(), eventConsumer: false };
      this.#peer = peer;
      const connectSignal = AbortSignal.any([
        peer.controller.signal, AbortSignal.timeout(this.#timeoutMs), ...(signal ? [signal] : []),
      ]);
      const url = new URL("/connect", origin);
      url.searchParams.set("token", token);
      url.searchParams.set("interactions", "answer");
      const response = await this.#fetch(url, {
        method: "GET", redirect: "manual", credentials: "omit", cache: "no-store", signal: connectSignal,
      });
      try {
        if (response.status === 401 || response.status === 403) throw failure("auth_rejected");
        if (response.status !== 302) throw failure("unsupported_protocol");
        const location = response.headers.get("location");
        if (location === null) throw failure("unsupported_protocol");
        const destination = new URL(location, url);
        if (destination.origin !== origin.origin || destination.pathname !== "/api/remote.mux" ||
            destination.search || destination.hash || destination.username || destination.password) {
          throw failure("unsupported_protocol");
        }
        peer.cookie = apiCookie(response, origin);
      } finally { await response.body?.cancel().catch(() => undefined); }
      if (connectSignal.aborted) throw failure("aborted");
      peer.ready = await this.#openSocket(peer, connectSignal);
      if (this.#disposed || connectSignal.aborted) throw failure("aborted");
      return peer;
    } catch (error) {
      if (peer) this.#release(peer);
      throw signal?.aborted || this.#disposed ? failure("aborted")
        : error instanceof GatewayConnectionError ? error : failure("transport_failure");
    }
  }

  #openSocket(peer: Peer, signal: AbortSignal): Promise<GatewayReady> {
    return new Promise((resolve, reject) => {
      const url = new URL("/api/remote.mux", peer.origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url, { headers: { cookie: peer.cookie },
        followRedirects: false, handshakeTimeout: this.#timeoutMs, maxPayload: MAX_MESSAGE_BYTES });
      peer.socket = socket;
      const streamId = peer.eventStreamId;
      peer.streams.set(streamId, new StreamInbox(peer));
      const failSocket = (error: GatewayConnectionError) => {
        signal.removeEventListener("abort", abort);
        reject(error);
        this.#release(peer, error);
      };
      const abort = () => failSocket(failure(this.#disposed || peer.controller.signal.aborted ? "aborted" : "transport_failure"));
      signal.addEventListener("abort", abort, { once: true });
      socket.once("open", () => {
        try { this.#send(peer, { type: "open", streamId, endpoint: "$events", payload: { args: {} } }); }
        catch { failSocket(failure("transport_failure")); }
      });
      socket.on("message", (raw, binary) => {
        try {
          if (binary) throw failure("unsupported_protocol");
          const frame = frameSchema.safeParse(JSON.parse(String(raw)) as unknown);
          if (!frame.success) throw failure("unsupported_protocol");
          const value = frame.data;
          if (!peer.ready) {
            if (value.type !== "item" || value.streamId !== streamId) throw failure("unsupported_protocol");
            const ready = readySchema.safeParse(value.value);
            if (!ready.success) throw failure("unsupported_protocol");
            signal.removeEventListener("abort", abort);
            const { clientId, host } = ready.data;
            peer.ready = { clientId, host };
            resolve(peer.ready);
            return;
          }
          const inbox = peer.streams.get(value.streamId);
          if (!inbox) return; // An already-cancelled stream may have in-flight frames.
          if (value.type === "item") inbox.push(value.value, Buffer.byteLength(String(raw)));
          else if (value.streamId === streamId) throw failure("transport_failure");
          else inbox.end(value.type === "error" ? failure("rpc_rejected") : undefined);
        } catch (error) {
          const safe = error instanceof GatewayConnectionError ? error : failure("unsupported_protocol");
          failSocket(safe);
        }
      });
      socket.once("unexpected-response", (_request, response) => {
        const code = response.statusCode;
        response.destroy();
        failSocket(failure(code === 401 || code === 403 ? "auth_rejected" : code === 409 ? "peer_conflict" : "transport_failure"));
      });
      socket.on("error", () => failSocket(failure("transport_failure")));
      socket.once("close", () => failSocket(failure("transport_failure")));
      if (signal.aborted) abort();
    });
  }

  #send(peer: Peer, frame: unknown): void {
    try {
      if (peer.socket?.readyState !== WebSocket.OPEN) throw failure("transport_failure");
      peer.socket.send(JSON.stringify(frame));
    } catch { this.#release(peer); throw failure("transport_failure"); }
  }

  #release(peer: Peer, error = failure("transport_failure")): void {
    peer.cookie = "";
    for (const inbox of peer.streams.values()) inbox.end(error);
    peer.streams.clear();
    peer.controller.abort();
    if (this.#peer === peer) this.#peer = undefined;
    if (peer.socket && peer.socket.readyState < WebSocket.CLOSING) peer.socket.terminate();
  }
}
