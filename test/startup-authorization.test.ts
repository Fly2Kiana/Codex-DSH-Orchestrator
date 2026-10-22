import assert from "node:assert/strict";
import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { win32 } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { captureStartupAuthorization } from "../src/startup-authorization.js";
import { runAuthorizedCaller } from "../src/authorized-caller.js";
import { startMockGatewayHost } from "./support/mock-gateway-host.js";

// Synthetic startup only. Never launch Desktop/Codex or read an operator credential.
const token = "A".repeat(43);
const origin = "http://127.0.0.1:45678";
const announcement = `dsh web: ${origin}/?token=${token}\n`;
const callerScript = `process.stdout.write(JSON.stringify({
  tokenReceived: process.env.DSH_CONNECT_TOKEN === 'A'.repeat(43),
  originReceived: process.env.DSH_CONNECT_ORIGIN === 'http://127.0.0.1:45678',
  inputName: process.env.DSH_CONNECT_TOKEN_ENV,
  tokenInArguments: process.argv.some(value => value.includes('A'.repeat(43)))
}));`;

test("operator startup pipe hands authorization to one real child environment without mutating the parent", async () => {
  const source = new PassThrough();
  const capture = captureStartupAuthorization(source);
  source.write("ordinary startup notice\ndsh web: http://127.0.");
  source.write(`0.1:45678/?token=${token}\n`);
  const handoff = await capture;
  const env = { ...process.env, DSH_CONNECT_TOKEN: "stale", dsh_connect_origin: "http://untrusted.invalid",
    DSH_CONNECT_TOKEN_ENV: "OLD_INPUT" };
  try {
    assert.equal(JSON.stringify(handoff).includes(token), false);
    const child = await handoff.launchCaller({ executable: process.execPath, args: ["-e", callerScript],
      stdio: ["ignore", "pipe", "pipe"] }, env);
    let output = "";
    child.stdout!.on("data", (chunk) => { output += chunk; });
    const [exit] = await once(child, "close");
    assert.equal(exit, 0);
    assert.deepEqual(JSON.parse(output), { tokenReceived: true, originReceived: true,
      inputName: "DSH_CONNECT_TOKEN", tokenInArguments: false });
    assert.equal(output.includes(token), false);
    assert.equal(env.DSH_CONNECT_TOKEN, "stale");
    assert.equal(env.dsh_connect_origin, "http://untrusted.invalid");
  } finally { source.end(); }
});

test("startup authorization refuses untrusted or malformed URL announcements without leaking their contents", async () => {
  for (const url of [
    `http://untrusted.invalid/?token=${token}`, `https://127.0.0.1:45678/?token=${token}`,
    `http://user:password@127.0.0.1:45678/?token=${token}`, `${origin}/api?token=${token}`,
    `${origin}/?token=${token}&token=${token}`, `${origin}/?token=${token}#fragment`,
    `${origin}/?token=short`, `${origin}/?other=${token}`, `http://[invalid/?token=${token}`,
  ]) {
    const source = new PassThrough();
    const capture = captureStartupAuthorization(source);
    source.write(`dsh web: ${url}\n`);
    try {
      await assert.rejects(capture, (error: any) => {
        assert.equal(error.code, "invalid_announcement");
        assert.equal(String(error).includes(token), false);
        assert.equal(String(error).includes("password"), false);
        assert.equal(error.cause, undefined);
        return true;
      });
    } finally { source.end(); }
  }
});

test("ending the startup source revokes an unused handoff instead of launching with stale authorization", async () => {
  const source = new PassThrough();
  const capture = captureStartupAuthorization(source);
  source.write(announcement);
  const handoff = await capture;
  source.end();
  await once(source, "end");
  await assert.rejects(handoff.launchCaller({ executable: process.execPath, args: ["-e", ""] }),
    { code: "authorization_unavailable" });
});

test("startup capture has a finite deadline without closing the operator-owned stream", async () => {
  const source = new PassThrough();
  const capture = captureStartupAuthorization(source, { timeoutMs: 20 });
  source.write("no authorization yet\n");
  try {
    await assert.rejects(capture, { code: "startup_timeout" });
    assert.equal(source.destroyed, false);
    source.write(announcement); // Late output is drained, not reused or printed.
  } finally { source.end(); }
});

test("cancelled and closed startup captures fail safely and revoke ready authorizations", async () => {
  const cancelled = new AbortController();
  cancelled.abort(new Error(token));
  const first = new PassThrough();
  try { await assert.rejects(captureStartupAuthorization(first, { signal: cancelled.signal }), { code: "aborted" }); }
  finally { first.end(); }

  const source = new PassThrough();
  const controller = new AbortController();
  const capture = captureStartupAuthorization(source, { signal: controller.signal });
  source.write(announcement);
  const handoff = await capture;
  controller.abort(new Error(token));
  try {
    await assert.rejects(handoff.launchCaller({ executable: process.execPath, args: ["-e", ""] }),
      { code: "authorization_unavailable" });
  } finally { source.end(); }

  for (const mode of ["end", "error"] as const) {
    const source = new PassThrough();
    const capture = captureStartupAuthorization(source);
    if (mode === "end") source.end(); else source.destroy(new Error(token));
    await assert.rejects(capture, (error: any) => error.code === "startup_closed" && !String(error).includes(token));
  }
});

test("startup input is byte-bounded and an incomplete announcement cannot be handed off", async () => {
  for (const input of ["x".repeat(9_000), "notice\n".repeat(40_000)]) {
    const source = new PassThrough();
    const capture = captureStartupAuthorization(source, { timeoutMs: 100 });
    source.write(input);
    try { await assert.rejects(capture, { code: "startup_output_limit" }); }
    finally { source.end(); }
  }
  const source = new PassThrough();
  const capture = captureStartupAuthorization(source, { timeoutMs: 100 });
  source.end(announcement.trimEnd());
  await assert.rejects(capture, { code: "startup_closed" });
});

test("a handoff cannot launch twice or retry after a failed child spawn", async () => {
  for (const executable of [process.execPath, `${process.execPath}.missing`]) {
    const source = new PassThrough();
    const capture = captureStartupAuthorization(source);
    source.write(announcement);
    const handoff = await capture;
    try {
      if (executable === process.execPath) {
        const child = await handoff.launchCaller({ executable, args: ["-e", ""], stdio: "ignore" });
        await once(child, "close");
      } else {
        await assert.rejects(handoff.launchCaller({ executable }), (error: any) =>
          error.code === "caller_launch_failed" && error.cause === undefined && !String(error).includes(token));
      }
      await assert.rejects(handoff.launchCaller({ executable: process.execPath }), { code: "authorization_unavailable" });
      assert.equal(JSON.stringify(handoff).includes(token), false);
    } finally { source.end(); }
  }
});

test("operator CLI help and rejected preflight do not consume startup authorization", async () => {
  const source = new PassThrough();
  const messages: string[] = [];
  const dependencies = { callerIsRunning: async () => true, output: (message: string) => { messages.push(message); } };
  try {
    assert.equal(await runAuthorizedCaller(["--help"], source, dependencies), undefined);
    await assert.rejects(runAuthorizedCaller(["--caller", process.execPath], source, dependencies), { code: "caller_already_running" });
    await assert.rejects(runAuthorizedCaller(["--caller", "relative.exe"], source, dependencies), { code: "invalid_arguments" });
    assert.equal(source.readableFlowing, null);
    assert.equal(source.destroyed, false);
    assert.equal(messages.join("").includes(token), false);
  } finally { source.end(); }
});

test("a caller argument cannot expose the startup credential through its command line", async () => {
  const source = new PassThrough();
  const capture = captureStartupAuthorization(source);
  source.write(announcement);
  const handoff = await capture;
  try {
    await assert.rejects(handoff.launchCaller({ executable: process.execPath, args: ["-e", `/*${token}*/`] }),
      { code: "invalid_caller" });
  } finally { source.end(); }
});

test("startup pipe reaches a real fake caller and the bound Gateway factory against only a mock Host", async () => {
  const host = await startMockGatewayHost({ connectToken: token });
  host.handle("session/list", () => ({ items: [] }));
  const source = new PassThrough();
  const messages: string[] = [];
  const script = `
    import { loadConfig } from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)};
    import { createDshApi } from ${JSON.stringify(new URL("../src/dsh-api-factory.ts", import.meta.url).href)};
    const config = loadConfig();
    const api = createDshApi(config);
    try { await api.hostDescribe(); console.log(JSON.stringify({connected:true,bound:config.connectTokenOrigin===config.hostUrl})); }
    finally { api.close?.(); }
  `;
  try {
    const pending = runAuthorizedCaller(["--caller", process.execPath, "--", "--import", "tsx", "--input-type=module", "-e", script], source, {
      callerIsRunning: async () => false, output: (message) => { messages.push(message); },
      stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DSH_HOST_PROTOCOL: "gateway", DSH_HOST_URL: host.baseUrl },
    });
    source.write(`dsh web: ${host.baseUrl}/?token=${token}\n`);
    const child = (await pending)!;
    let output = "";
    child.stdout!.on("data", (chunk) => { output += chunk; });
    child.stderr!.on("data", (chunk) => { output += chunk; });
    const [code] = await once(child, "close");
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(output), { connected: true, bound: true });
    assert.equal(output.includes(token), false);
    assert.equal(messages.join("").includes(token), false);
    assert.equal(host.connectCount, 1);
    assert.equal(host.requests.some((request) => /prompt|create|selectModel/.test(request.method)), false);
  } finally { source.end(); await host.close(); }
});

test("a caller opened during startup cannot receive authorization", async () => {
  const source = new PassThrough();
  let checked = false;
  const pending = runAuthorizedCaller(["--caller", process.execPath], source, {
    callerIsRunning: async () => { if (checked) return true; checked = true; return false; }, output: () => undefined,
  });
  source.write(announcement);
  try { await assert.rejects(pending, { code: "caller_already_running" }); }
  finally { source.end(); }
});

test("default caller stdin is isolated from the secret-bearing startup pipe", async () => {
  const caller = `const deadline=setTimeout(()=>{console.log(JSON.stringify({isolated:false}));process.exit(0)},1500);
    process.stdin.once('end',()=>{clearTimeout(deadline);console.log(JSON.stringify({isolated:true}));process.exit(0)});
    process.stdin.resume();`;
  const runnerScript = `
    import { once } from 'node:events';
    import { captureStartupAuthorization } from ${JSON.stringify(new URL("../src/startup-authorization.ts", import.meta.url).href)};
    const handoff = await captureStartupAuthorization(process.stdin);
    const caller = await handoff.launchCaller({executable:process.execPath,args:['-e',${JSON.stringify(caller)}]});
    await once(caller,'close');
    process.stdin.destroy(); // Fixture pipe only; not an actual Desktop stream.
  `;
  const runner = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", runnerScript],
    { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  runner.stdout!.on("data", (chunk) => { output += chunk; });
  runner.stderr!.on("data", (chunk) => { output += chunk; });
  runner.stdin!.write(announcement); // Intentionally keep the parent startup pipe open.
  const [code] = await once(runner, "close");
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(output), { isolated: true });
});

test("non-byte startup input cannot escape as an uncaught secret-bearing exception", async () => {
  const source = new PassThrough({ objectMode: true });
  const capture = captureStartupAuthorization(source, { timeoutMs: 100 });
  try {
    assert.doesNotThrow(() => source.write({ secret: token }));
    await assert.rejects(capture, (error: any) => error.code === "invalid_announcement" && !String(error).includes(token));
  } finally { source.end(); await capture.catch(() => undefined); }
});

test("real CLI refuses an already-running caller without printing the supplied startup secret", async (context) => {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/authorized-caller.ts", import.meta.url)),
    "--caller", process.execPath], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  child.stdin!.end(announcement);
  const [code] = await once(child, "close");
  assert.equal(code, 1);
  if (process.platform === "win32" && !output.includes("caller_already_running")) {
    // Failure-only CI evidence: no startup input, raw subprocess output, paths,
    // environment values, command lines, or operator processes are inspected.
    for (const mode of ["startup-only", "minimal-open", "minimal-closed", "os-env-closed"]) {
      const env: NodeJS.ProcessEnv = { SystemRoot: process.env.SystemRoot, DSH_HANDOFF_CALLER_NAME: "node" };
      if (mode === "os-env-closed") {
        for (const key of ["WINDIR", "PATH", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PSModulePath"]) {
          if (process.env[key] !== undefined) env[key] = process.env[key];
        }
      }
      const script = "[Console]::Write('started;'); " + (mode === "startup-only" ? "" :
        "$ErrorActionPreference='Stop'; $p=@(Get-Process -Name $env:DSH_HANDOFF_CALLER_NAME -ErrorAction SilentlyContinue); " +
        "if($p.Count -gt 0){[Console]::Write('running')}else{[Console]::Write('stopped')}");
      const startedAt = Date.now();
      await new Promise<void>((resolve) => {
        const probe = execFile(win32.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
          { env, timeout: 5_000, maxBuffer: 1024, windowsHide: true }, (error, stdout, stderr) => {
            context.diagnostic(JSON.stringify({ mode, elapsedMs: Date.now() - startedAt,
              code: error?.code ?? 0, killed: error?.killed ?? false, signal: error?.signal ?? null,
              started: stdout.startsWith("started;"),
              knownResult: stdout === "started;running" || stdout === "started;stopped",
              hasStderr: stderr.length > 0 }));
            resolve();
          });
        if (mode.endsWith("closed")) probe.stdin!.end();
      });
    }
  }
  assert.match(output, process.platform === "win32" ? /caller_already_running/ : /unsupported_platform/);
  assert.equal(output.includes(token), false);
  assert.equal(output.includes(origin), false);
});
