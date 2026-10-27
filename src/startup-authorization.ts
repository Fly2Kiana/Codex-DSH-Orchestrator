import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Readable } from "node:stream";

export class StartupAuthorizationError extends Error {
  constructor(readonly code: string) {
    super(`Local authorization handoff failed (${code}); no credential or raw startup output is included`);
    this.name = "StartupAuthorizationError";
  }
}

export interface AuthorizedCaller {
  executable: string;
  args?: string[];
  /** Never inherit the secret-bearing startup stdin. Only child output may be inherited. */
  stdio?: "ignore" | ["ignore", "inherit" | "ignore" | "pipe", "inherit" | "ignore" | "pipe"];
}

/** Opaque, single-use input. Not a credential store or a Desktop lifecycle owner. */
export class StartupAuthorizationHandoff {
  #credential: { origin: string; token: string } | undefined;

  constructor(origin: string, token: string) { this.#credential = { origin, token }; }

  dispose(): void { this.#credential = undefined; }

  async launchCaller(caller: AuthorizedCaller, env: NodeJS.ProcessEnv = process.env): Promise<ChildProcess> {
    const credential = this.#credential;
    this.#credential = undefined;
    if (!credential) throw new StartupAuthorizationError("authorization_unavailable");
    if (!isAbsolute(caller.executable) || [caller.executable, ...(caller.args ?? [])]
      .some((value) => value.includes(credential.token))) throw new StartupAuthorizationError("invalid_caller");
    const stdio = caller.stdio ?? ["ignore", "inherit", "inherit"];
    if (stdio !== "ignore" && (!Array.isArray(stdio) || stdio.length !== 3 || stdio[0] !== "ignore")) {
      throw new StartupAuthorizationError("invalid_caller");
    }
    const childEnv = Object.fromEntries(Object.entries(env).filter(([name]) =>
      !["DSH_CONNECT_TOKEN", "DSH_CONNECT_TOKEN_ENV", "DSH_CONNECT_ORIGIN"].includes(name.toUpperCase())));
    Object.assign(childEnv, { DSH_CONNECT_TOKEN: credential.token, DSH_CONNECT_TOKEN_ENV: "DSH_CONNECT_TOKEN",
      DSH_CONNECT_ORIGIN: credential.origin });
    return new Promise((resolve, reject) => {
      try {
        const child = spawn(caller.executable, caller.args ?? [], {
          shell: false, env: childEnv, stdio, windowsHide: false,
        });
        child.once("error", () => reject(new StartupAuthorizationError("caller_launch_failed")));
        child.once("spawn", () => resolve(child));
      } catch { reject(new StartupAuthorizationError("caller_launch_failed")); }
    });
  }
}

/** Input must be the operator's private startup pipe, never a saved log or scraped IPC. */
export function captureStartupAuthorization(source: Readable,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<StartupAuthorizationHandoff> {
  return new Promise((resolve, reject) => {
    let pending = "";
    let bytes = 0;
    let settled = false;
    let captured: StartupAuthorizationHandoff | undefined;
    const timeoutMs = options.timeoutMs ?? 90_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
      reject(new StartupAuthorizationError("invalid_timeout")); return;
    }
    const timer = setTimeout(() => fail("startup_timeout"), timeoutMs);
    const fail = (code: string) => {
      if (settled) return;
      settled = true;
      pending = "";
      clearTimeout(timer);
      source.removeListener("data", data);
      source.resume(); // Never destroy a pipe owned by the running Desktop.
      reject(new StartupAuthorizationError(code));
    };
    const abort = () => { captured?.dispose(); fail("aborted"); };
    const lost = () => {
      captured?.dispose();
      options.signal?.removeEventListener("abort", abort);
      fail("startup_closed");
    };
    source.once("end", lost);
    source.once("close", lost);
    source.once("error", lost);
    const data = (chunk: Buffer | string) => {
      if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) { fail("invalid_announcement"); return; }
      bytes += Buffer.byteLength(chunk);
      if (bytes > 256 * 1024) { fail("startup_output_limit"); return; }
      pending += chunk.toString();
      for (let newline; (newline = pending.indexOf("\n")) >= 0;) {
        if (Buffer.byteLength(pending.slice(0, newline)) > 8192) { fail("startup_output_limit"); return; }
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (!/^dsh web: \S+:\/\//.test(line)) continue;
        source.removeListener("data", data);
        pending = "";
        try {
          const url = new URL(line.slice(9));
          if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port === "0" ||
              url.username || url.password || url.pathname !== "/" || url.hash ||
              !/^\?token=[A-Za-z0-9_-]{43}$/.test(url.search)) throw new Error();
          captured = new StartupAuthorizationHandoff(url.origin, url.searchParams.get("token")!);
          settled = true;
          clearTimeout(timer);
          resolve(captured);
        } catch { fail("invalid_announcement"); }
        return;
      }
      if (Buffer.byteLength(pending) > 8192) fail("startup_output_limit");
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    else if (source.destroyed || source.readableEnded) lost();
    else source.on("data", data);
  });
}
