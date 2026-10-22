import { execFile } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";

import type { DesktopProcess, TcpListener } from "./desktop-host-discovery.js";

export class MacosInspectionError extends Error {
  constructor(readonly code: string) {
    super(`macOS process inspection failed (${code}); native output is not included`);
    this.name = "MacosInspectionError";
  }
}

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0 && pid <= 2_147_483_647;
}

/** Parses only `ps -axww -o pid=,comm=`; never ask ps for args or environment. */
export function parseMacosProcessList(output: string): DesktopProcess[] {
  const rows: DesktopProcess[] = [];
  const seen = new Set<number>();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\S[^\r\n\0]*)$/.exec(line);
    const pid = Number(match?.[1]);
    if (!match || !validPid(pid) || seen.has(pid)) throw new MacosInspectionError("process_metadata_invalid");
    seen.add(pid);
    const command = match[2]!.trimEnd();
    const absolute = posix.isAbsolute(command);
    rows.push({ pid, name: absolute ? posix.basename(command) : command.replace(/^\((.*)\)$/, "$1"),
      executablePath: absolute ? command : "" });
  }
  if (!rows.length) throw new MacosInspectionError("process_metadata_invalid");
  return rows;
}

/** Input comes only from PID-scoped `lsof -iTCP -sTCP:LISTEN -Fpn`. */
export function parseMacosTcpListeners(output: string): TcpListener[] {
  const listeners: TcpListener[] = [];
  let pid: number | undefined;
  for (const field of output.split("\n")) {
    if (!field) continue;
    if (/^p\d+$/.test(field) && validPid(Number(field.slice(1)))) {
      pid = Number(field.slice(1));
    } else if (/^f\d+[rwu]?$/.test(field)) {
      // lsof may include its mandatory file delimiter even with selected fields.
      continue;
    } else if (field.startsWith("n") && pid !== undefined) {
      const endpoint = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(field.slice(1));
      const port = Number(endpoint?.[3]);
      if (!endpoint || !Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new MacosInspectionError("listener_metadata_invalid");
      }
      const address = endpoint[1] ?? endpoint[2]!;
      if (address === "127.0.0.1" || address === "::1") listeners.push({ pid, address, port });
    } else {
      throw new MacosInspectionError("listener_metadata_invalid");
    }
  }
  return listeners;
}

const execFileAsync = promisify(execFile);
const queryOptions = { timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
  env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C", LANG: "C" } };

export async function listMacosProcesses(): Promise<DesktopProcess[]> {
  if (process.platform !== "darwin") throw new MacosInspectionError("unsupported_platform");
  let output: string;
  try {
    const { stdout, stderr } = await execFileAsync("/bin/ps", ["-axww", "-o", "pid=,comm="], queryOptions);
    if (stderr) throw new Error();
    output = stdout;
  } catch { throw new MacosInspectionError("process_query_failed"); }
  return parseMacosProcessList(output);
}

export async function listMacosTcpListeners(pids: number[]): Promise<TcpListener[]> {
  if (process.platform !== "darwin") throw new MacosInspectionError("unsupported_platform");
  if (pids.length > 128 || pids.some((pid) => !validPid(pid))) throw new MacosInspectionError("invalid_pid_scope");
  if (!pids.length) return []; // An empty -p must never become an all-process query.
  const scope = [...new Set(pids)];
  let output: string;
  try {
    const { stdout, stderr } = await execFileAsync("/usr/sbin/lsof",
      ["-nP", "-a", "-p", scope.join(","), "-iTCP", "-sTCP:LISTEN", "-Fpn"], queryOptions);
    if (stderr) throw new Error();
    output = stdout;
  } catch (error) {
    const failure = error as { code?: unknown; killed?: boolean; stdout?: unknown; stderr?: unknown };
    if (failure.code === 1 && !failure.killed && failure.stdout === "" && failure.stderr === "") return [];
    throw new MacosInspectionError("listener_query_failed");
  }
  const listeners = parseMacosTcpListeners(output);
  if (listeners.some((listener) => !scope.includes(listener.pid))) throw new MacosInspectionError("listener_scope_mismatch");
  return listeners;
}
