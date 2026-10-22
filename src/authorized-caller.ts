#!/usr/bin/env node

import { execFile, type ChildProcess } from "node:child_process";
import { isAbsolute, resolve, win32 } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { captureStartupAuthorization, StartupAuthorizationError, type AuthorizedCaller } from "./startup-authorization.js";

export interface AuthorizedCallerDependencies {
  callerIsRunning: (executable: string) => Promise<boolean>;
  output: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  stdio?: AuthorizedCaller["stdio"];
  signal?: AbortSignal;
}

/** OS-only check: no credentials, command lines, Host probes, or process mutation. */
async function windowsCallerIsRunning(executable: string): Promise<boolean> {
  if (process.platform !== "win32" || !process.env.SystemRoot) {
    throw new StartupAuthorizationError("unsupported_platform");
  }
  const script = "$ErrorActionPreference='Stop'; " +
    "$dshFound=@(Get-Process -Name $env:DSH_HANDOFF_CALLER_NAME -ErrorAction SilentlyContinue); " +
    "if($dshFound.Count -gt 0){[Console]::Write('running')}else{[Console]::Write('stopped')}";
  // PowerShell's cmdlet/module initialization needs its normal OS context on
  // clean runners. Keep only these OS variables, never the caller's credentials.
  const env: NodeJS.ProcessEnv = { SystemRoot: process.env.SystemRoot,
    DSH_HANDOFF_CALLER_NAME: win32.basename(executable, win32.extname(executable)) };
  for (const key of ["WINDIR", "PATH", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PSModulePath"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  try {
    const { stdout } = await promisify(execFile)(win32.join(process.env.SystemRoot,
      "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      // A failed or timed-out OS query must never mean "not running".
      timeout: 30_000, maxBuffer: 1024, windowsHide: true, env,
    });
    if (stdout.trim() === "running") return true;
    if (stdout.trim() === "stopped") return false;
  } catch { /* Never surface subprocess output/error text. */ }
  throw new StartupAuthorizationError("caller_preflight_failed");
}

/** Explicit operator command, not an MCP wrapper and never a Desktop launcher. */
export async function runAuthorizedCaller(args: string[], input: Readable,
  dependencies: AuthorizedCallerDependencies = {
    callerIsRunning: windowsCallerIsRunning, output: (message) => console.error(message),
  }): Promise<ChildProcess | undefined> {
  if (args.length === 1 && args[0] === "--help") {
    dependencies.output("Usage: authorized-caller --caller <absolute-trusted-executable> [-- <args...>]; trusted startup pipe on stdin. Never starts Desktop.");
    return;
  }
  const executable = args[1];
  if (args[0] !== "--caller" || !executable || !isAbsolute(executable) ||
      (args.length > 2 && args[2] !== "--") || args.length > 131 || /\.(?:cmd|bat|ps1|sh)$/i.test(executable)) {
    throw new StartupAuthorizationError("invalid_arguments");
  }
  if ("isTTY" in input && input.isTTY === true) throw new StartupAuthorizationError("startup_pipe_required");
  if (await dependencies.callerIsRunning(executable)) throw new StartupAuthorizationError("caller_already_running");
  const handoff = await captureStartupAuthorization(input,
    dependencies.signal === undefined ? {} : { signal: dependencies.signal });
  try {
    // A long startup can overlap an operator opening the caller normally.
    if (await dependencies.callerIsRunning(executable)) throw new StartupAuthorizationError("caller_already_running");
    const child = await handoff.launchCaller({ executable, args: args.slice(3),
      ...(dependencies.stdio === undefined ? {} : { stdio: dependencies.stdio }) }, dependencies.env);
    dependencies.output("Authorized caller started; credential retained only in process memory. No Host RPC or model request was sent by this helper.");
    return child;
  } finally { handoff.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  void runAuthorizedCaller(process.argv.slice(2), process.stdin, {
    callerIsRunning: windowsCallerIsRunning, output: (message) => console.error(message), signal: controller.signal,
  }).catch((error: unknown) => {
    const safe = error instanceof StartupAuthorizationError ? error : new StartupAuthorizationError("handoff_failed");
    console.error(safe.message);
    process.exitCode = 1;
    // Do not close the source pipe and disrupt an operator-owned Desktop.
    process.stdin.on("error", () => undefined);
    process.stdin.resume();
  });
}
