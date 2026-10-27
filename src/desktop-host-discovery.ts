import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, posix, win32 } from "node:path";

import { DshClient } from "./dsh-client.js";
import { listMacosProcesses, listMacosTcpListeners, MacosInspectionError } from "./macos-process-inspection.js";

const execFileAsync = promisify(execFile);
const DESKTOP_PROCESS_NAME = "DSH Desktop";

export type DesktopHostDiscoveryErrorCode =
  | "unsupported_platform"
  | "desktop_not_running"
  | "desktop_host_not_found"
  | "desktop_inspection_failed"
  | "invalid_authorized_origin"
  | "authorized_origin_not_found"
  | "ambiguous_desktop_host";

export interface DesktopDiscoveryDiagnostic {
  stage: "platform" | "process-query" | "process-matching" | "listener-query" | "candidate-selection" | "origin-binding";
  reason: DesktopHostDiscoveryErrorCode | "process_query_failed" | "process_metadata_invalid"
    | "listener_query_failed" | "listener_metadata_invalid" | "listener_scope_mismatch" | "invalid_pid_scope";
}

const discoveryStages: Record<DesktopHostDiscoveryErrorCode, DesktopDiscoveryDiagnostic["stage"]> = {
  unsupported_platform: "platform", desktop_not_running: "process-matching",
  desktop_host_not_found: "candidate-selection", desktop_inspection_failed: "candidate-selection",
  ambiguous_desktop_host: "candidate-selection", invalid_authorized_origin: "origin-binding",
  authorized_origin_not_found: "origin-binding",
};

export class DesktopHostDiscoveryError extends Error {
  readonly diagnostic: DesktopDiscoveryDiagnostic;
  constructor(
    readonly code: DesktopHostDiscoveryErrorCode,
    message: string,
    readonly details: Record<string, number> = {},
    options?: ErrorOptions & { diagnostic?: DesktopDiscoveryDiagnostic },
  ) {
    super(message, options);
    this.name = "DesktopHostDiscoveryError";
    this.diagnostic = options?.diagnostic ?? { stage: discoveryStages[code], reason: code };
  }
}

export interface DesktopProcess {
  pid: number;
  name: string;
  executablePath: string;
}

export interface TcpListener {
  address: string;
  port: number;
  pid: number;
}

export interface DesktopHostResolution {
  baseUrl: string;
  source: "windows-process-listener" | "macos-process-listener";
  desktopPids: number[];
  candidateCount: number;
}

export interface DesktopHostDiscoveryDependencies {
  platform: NodeJS.Platform;
  listProcesses: () => Promise<DesktopProcess[]>;
  listListeners: (pids: number[]) => Promise<TcpListener[]>;
  probe: (baseUrl: string) => Promise<boolean>;
}

export interface OfficialDesktopDiscoveryOptions {
  /** Constraint on OS-owned candidates, never a static endpoint or a probe target. */
  authorizedOrigin?: string;
}

function authorizationOrigin(raw: string): string {
  // Only literal loopback roots: never resolve DNS or echo untrusted input.
  if (/^https?:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/i.test(raw)) {
    try { return new URL(raw).origin; } catch { /* Fail closed below. */ }
  }
  throw new DesktopHostDiscoveryError("invalid_authorized_origin", "invalid official Desktop authorization origin");
}

async function inspectOfficialMetadata<T>(stage: "process-query" | "listener-query", query: () => Promise<T>): Promise<T> {
  try { return await query(); } catch (error) {
    let reason: DesktopDiscoveryDiagnostic["reason"] = stage === "process-query" ? "process_query_failed" : "listener_query_failed";
    // Preserve only audited native codes, never subprocess output/message/cause.
    if (error instanceof MacosInspectionError) {
      if (stage === "process-query" && error.code === "process_metadata_invalid") reason = "process_metadata_invalid";
      if (stage === "listener-query") {
        if (error.code === "listener_metadata_invalid") reason = "listener_metadata_invalid";
        if (error.code === "listener_scope_mismatch") reason = "listener_scope_mismatch";
        if (error.code === "invalid_pid_scope") reason = "invalid_pid_scope";
      }
    }
    throw new DesktopHostDiscoveryError("desktop_inspection_failed", "official Desktop metadata inspection failed; refusing to guess a Host",
      {}, { diagnostic: { stage, reason } });
  }
}

function exactDesktopProcess(process: DesktopProcess, name = DESKTOP_PROCESS_NAME): boolean {
  return (
    Number.isInteger(process.pid) &&
    process.pid > 0 &&
    process.name === name &&
    win32.basename(process.executablePath).toLowerCase() === `${name}.exe`.toLowerCase()
  );
}

function loopbackOrigin(listener: TcpListener): string | undefined {
  if (!Number.isInteger(listener.port) || listener.port < 1 || listener.port > 65_535) return undefined;
  if (listener.address === "127.0.0.1") return `http://127.0.0.1:${listener.port}`;
  if (listener.address === "::1") return `http://[::1]:${listener.port}`;
  return undefined;
}

export async function discoverDesktopHostEndpoint(
  dependencies: DesktopHostDiscoveryDependencies,
): Promise<DesktopHostResolution> {
  if (dependencies.platform !== "win32") {
    throw new DesktopHostDiscoveryError(
      "unsupported_platform",
      `DSH Desktop automatic Host discovery is not supported on ${dependencies.platform}`,
    );
  }

  const processes = (await dependencies.listProcesses()).filter((process) => exactDesktopProcess(process));
  const desktopPids = [...new Set(processes.map((process) => process.pid))].sort((left, right) => left - right);
  if (desktopPids.length === 0) {
    throw new DesktopHostDiscoveryError("desktop_not_running", "no exact DSH Desktop process was found");
  }

  const pidSet = new Set(desktopPids);
  const candidates = [
    ...new Set(
      (await dependencies.listListeners(desktopPids))
        .filter((listener) => pidSet.has(listener.pid))
        .map(loopbackOrigin)
        .filter((origin): origin is string => origin !== undefined),
    ),
  ].sort();

  const verified: string[] = [];
  for (const candidate of candidates) {
    try {
      if (await dependencies.probe(candidate)) verified.push(candidate);
    } catch {
      // A failed protocol probe is not a verified DSH Host candidate.
    }
  }

  if (verified.length === 0) {
    throw new DesktopHostDiscoveryError(
      "desktop_host_not_found",
      "DSH Desktop is running, but none of its loopback listeners passed the DSH Host protocol probe",
      { desktopProcessCount: desktopPids.length, candidateCount: candidates.length },
    );
  }
  if (verified.length !== 1) {
    throw new DesktopHostDiscoveryError(
      "ambiguous_desktop_host",
      "multiple DSH Desktop loopback listeners passed the DSH Host protocol probe; refusing to guess",
      {
        desktopProcessCount: desktopPids.length,
        candidateCount: candidates.length,
        verifiedCount: verified.length,
      },
    );
  }

  return {
    baseUrl: verified[0]!,
    source: "windows-process-listener",
    desktopPids,
    candidateCount: candidates.length,
  };
}

/**
 * Read-only candidate discovery, not authentication or proof of a Gateway.
 * The official product owns a randomized loopback Host. An authorization
 * origin may narrow only OS-owned candidates; otherwise refuse ambiguity
 * before any credential is sent. The authenticated transport must validate
 * the selected Host afterwards. Never probe /connect here (it creates a Peer).
 */
export async function discoverOfficialDesktopHostEndpoint(
  dependencies: Omit<DesktopHostDiscoveryDependencies, "probe">,
  options: OfficialDesktopDiscoveryOptions = {},
): Promise<DesktopHostResolution & { protocolVerified: false }> {
  if (dependencies.platform !== "win32" && dependencies.platform !== "darwin") {
    throw new DesktopHostDiscoveryError("unsupported_platform", "official Desktop automatic discovery requires Windows or macOS");
  }
  const macos = dependencies.platform === "darwin";
  const processes = (await inspectOfficialMetadata("process-query", dependencies.listProcesses)).filter((process) => macos
    ? Number.isInteger(process.pid) && process.pid > 0 && process.name === "DeepSeek Harness" &&
      posix.isAbsolute(process.executablePath) && posix.normalize(process.executablePath) === process.executablePath &&
      process.executablePath.endsWith("/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness")
    : exactDesktopProcess(process, "DeepSeek Harness"));
  const desktopPids = [...new Set(processes.map((process) => process.pid))].sort((a, b) => a - b);
  if (desktopPids.length === 0) {
    throw new DesktopHostDiscoveryError("desktop_not_running", "no exact DeepSeek Harness process was found");
  }
  const pids = new Set(desktopPids);
  const candidates = [...new Set((await inspectOfficialMetadata("listener-query", () => dependencies.listListeners(desktopPids)))
    .filter((listener) => pids.has(listener.pid)).map(loopbackOrigin)
    .filter((origin): origin is string => origin !== undefined))];
  if (candidates.length === 0) {
    throw new DesktopHostDiscoveryError("desktop_host_not_found", "official Desktop has no owned loopback Host candidate");
  }
  const authorizedOrigin = options.authorizedOrigin === undefined ? undefined : authorizationOrigin(options.authorizedOrigin);
  const selected = authorizedOrigin === undefined ? candidates
    : candidates.filter((candidate) => new URL(candidate).origin === authorizedOrigin);
  if (selected.length === 0) {
    throw new DesktopHostDiscoveryError("authorized_origin_not_found",
      "authorization origin is not an observed official Desktop listener; refusing to send credentials");
  }
  if (selected.length !== 1) {
    throw new DesktopHostDiscoveryError("ambiguous_desktop_host",
      "multiple official Desktop loopback candidates; refusing to guess or send credentials", { candidateCount: candidates.length });
  }
  return { baseUrl: selected[0]!, source: macos ? "macos-process-listener" : "windows-process-listener", desktopPids,
    candidateCount: candidates.length, protocolVerified: false };
}

function parseLocalEndpoint(raw: string): { address: string; port: number } | undefined {
  const ipv6 = /^\[([^\]]+)\]:(\d+)$/.exec(raw);
  if (ipv6 !== null) return { address: ipv6[1]!, port: Number(ipv6[2]) };
  const ipv4 = /^([^:]+):(\d+)$/.exec(raw);
  if (ipv4 !== null) return { address: ipv4[1]!, port: Number(ipv4[2]) };
  return undefined;
}

export function parseWindowsNetstatListeners(output: string): TcpListener[] {
  const listeners: TcpListener[] = [];
  for (const line of output.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 5 || fields[0]?.toUpperCase() !== "TCP" || fields[3]?.toUpperCase() !== "LISTENING") {
      continue;
    }
    const endpoint = parseLocalEndpoint(fields[1]!);
    const pid = Number(fields[4]);
    if (endpoint === undefined || !Number.isInteger(pid) || pid <= 0) continue;
    listeners.push({ ...endpoint, pid });
  }
  return listeners;
}

function windowsSystemTool(name: string): string {
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined || systemRoot.trim() === "") {
    throw new DesktopHostDiscoveryError(
      "desktop_host_not_found",
      "SystemRoot is unavailable, so Windows Desktop Host discovery cannot query local process ownership",
    );
  }
  return join(systemRoot, "System32", name);
}

function parseProcessJson(output: string): DesktopProcess[] {
  if (output.trim() === "") return [];
  const value: unknown = JSON.parse(output);
  if (!Array.isArray(value)) throw new Error("Windows process query returned a non-array JSON value");
  return value.flatMap((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as Record<string, unknown>).pid !== "number" ||
      typeof (item as Record<string, unknown>).name !== "string" ||
      typeof (item as Record<string, unknown>).executablePath !== "string"
    ) {
      return [];
    }
    return [
      {
        pid: (item as Record<string, unknown>).pid as number,
        name: (item as Record<string, unknown>).name as string,
        executablePath: (item as Record<string, unknown>).executablePath as string,
      },
    ];
  });
}

export async function listWindowsDesktopProcesses(): Promise<DesktopProcess[]> {
  const script =
    "$ErrorActionPreference='Stop'; " +
    "$items=@(Get-Process -Name 'DSH Desktop','DeepSeek Harness' -ErrorAction SilentlyContinue | ForEach-Object { " +
    "[pscustomobject]@{pid=$_.Id;name=$_.ProcessName;executablePath=$_.Path} }); " +
    "ConvertTo-Json -InputObject $items -Compress";
  const { stdout } = await execFileAsync(windowsSystemTool("WindowsPowerShell\\v1.0\\powershell.exe"), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
  return parseProcessJson(stdout);
}

export async function listWindowsTcpListeners(): Promise<TcpListener[]> {
  const { stdout } = await execFileAsync(windowsSystemTool("netstat.exe"), ["-ano", "-p", "tcp"]);
  return parseWindowsNetstatListeners(stdout);
}

export async function discoverRunningWindowsDesktopHost(timeoutMs = 2_000): Promise<DesktopHostResolution> {
  return discoverDesktopHostEndpoint({
    platform: process.platform,
    listProcesses: listWindowsDesktopProcesses,
    listListeners: listWindowsTcpListeners,
    probe: async (baseUrl) => {
      await new DshClient(baseUrl, timeoutMs).hostDescribe();
      return true;
    },
  });
}

export function discoverRunningWindowsOfficialDesktopHost(options: OfficialDesktopDiscoveryOptions = {}): Promise<DesktopHostResolution & { protocolVerified: false }> {
  if (process.platform !== "win32") {
    return Promise.reject(new DesktopHostDiscoveryError("unsupported_platform", "Windows discovery requires Windows"));
  }
  return discoverOfficialDesktopHostEndpoint({ platform: process.platform,
    listProcesses: listWindowsDesktopProcesses, listListeners: listWindowsTcpListeners }, options);
}

export async function discoverRunningOfficialDesktopHost(options: OfficialDesktopDiscoveryOptions = {}): Promise<DesktopHostResolution & { protocolVerified: false }> {
  if (process.platform !== "darwin") return discoverRunningWindowsOfficialDesktopHost(options);
  return discoverOfficialDesktopHostEndpoint({ platform: "darwin",
    listProcesses: listMacosProcesses, listListeners: listMacosTcpListeners }, options);
}
