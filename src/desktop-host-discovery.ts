import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, win32 } from "node:path";

import { DshClient } from "./dsh-client.js";

const execFileAsync = promisify(execFile);
const DESKTOP_PROCESS_NAME = "DSH Desktop";
const DESKTOP_EXECUTABLE_NAME = "DSH Desktop.exe";

export type DesktopHostDiscoveryErrorCode =
  | "unsupported_platform"
  | "desktop_not_running"
  | "desktop_host_not_found"
  | "ambiguous_desktop_host";

export class DesktopHostDiscoveryError extends Error {
  constructor(
    readonly code: DesktopHostDiscoveryErrorCode,
    message: string,
    readonly details: Record<string, number> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DesktopHostDiscoveryError";
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
  source: "windows-process-listener";
  desktopPids: number[];
  candidateCount: number;
}

export interface DesktopHostDiscoveryDependencies {
  platform: NodeJS.Platform;
  listProcesses: () => Promise<DesktopProcess[]>;
  listListeners: () => Promise<TcpListener[]>;
  probe: (baseUrl: string) => Promise<boolean>;
}

function exactDesktopProcess(process: DesktopProcess): boolean {
  return (
    Number.isInteger(process.pid) &&
    process.pid > 0 &&
    process.name === DESKTOP_PROCESS_NAME &&
    win32.basename(process.executablePath).toLowerCase() === DESKTOP_EXECUTABLE_NAME.toLowerCase()
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

  const processes = (await dependencies.listProcesses()).filter(exactDesktopProcess);
  const desktopPids = [...new Set(processes.map((process) => process.pid))].sort((left, right) => left - right);
  if (desktopPids.length === 0) {
    throw new DesktopHostDiscoveryError("desktop_not_running", "no exact DSH Desktop process was found");
  }

  const pidSet = new Set(desktopPids);
  const candidates = [
    ...new Set(
      (await dependencies.listListeners())
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
    "$items=@(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | ForEach-Object { " +
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
