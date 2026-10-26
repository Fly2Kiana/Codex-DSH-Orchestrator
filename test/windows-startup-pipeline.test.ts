import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const tools = new URL("../docs/operator-tools/windows/", import.meta.url);
const statusFilter = fileURLToPath(new URL("safe-handoff-status.mjs", tools));
const success = "Authorized caller started; credential retained only in process memory. No Host RPC or model request was sent by this helper.";
const failure = (code: string) => `Local authorization handoff failed (${code}); no credential or raw startup output is included`;

async function runFixture(executable: string, args: string[], input: string[] = [], env = process.env) {
  const child = spawn(executable, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    const closed = once(child, "close", { signal: AbortSignal.timeout(20_000) });
    for (const chunk of input) child.stdin.write(chunk);
    child.stdin.end();
    const [code] = await closed;
    assert.equal(code, 0, stderr);
    assert.equal(stderr, "");
    return stdout;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill(); // Only this test's inert Node/PowerShell fixture.
      await closed;
    }
  }
}

test("Windows startup status reports fixed outcomes without leaking raw output", async () => {
  const stdout = await runFixture(process.execPath, [statusFilter], [
    "PRIVATE_FIXTURE_OUTPUT\nhttp://127.0.0.1:45678/?token=" + "A".repeat(43) + "\n",
    success.slice(0, 27), success.slice(27) + "\r\n" + success + "\n",
    failure("startup_timeout") + "\n" + failure("unknown_code") + "\n",
  ]);
  assert.equal(stdout, "[handoff] caller_launch_requested\n[handoff] failed: startup_timeout\n");
});

test("Windows startup status discards oversized lines and accepts the next fixed error", async () => {
  const stdout = await runFixture(process.execPath, [statusFilter], [
    "X".repeat(9000), success + "\n", failure("caller_preflight_failed").slice(0, 40),
    failure("caller_preflight_failed").slice(40) + "\n",
  ]);
  assert.equal(stdout, "[handoff] failed: caller_preflight_failed\n");
});

test("Windows PowerShell 5.1 native startup pipe consumes input before its producer exits", {
  skip: process.platform !== "win32",
}, async () => {
  const powershell = join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const tempRoot = await realpath(tmpdir());
  const home = await mkdtemp(join(tempRoot, "dsh native pipe fixture-"));
  assert.equal(dirname(home), tempRoot);
  try {
    // Parse the real operator script without executing its app-launch commands.
    await runFixture(powershell, ["-NoProfile", "-NonInteractive", "-Command",
      "$t=$null;$e=$null;$null=[System.Management.Automation.Language.Parser]::ParseFile($env:CODEX_DSH_TEST_SCRIPT,[ref]$t,[ref]$e);if($e.Count){exit 1}"],
    [], { ...process.env, CODEX_DSH_TEST_SCRIPT: fileURLToPath(new URL("launch-official-desktop.ps1", tools)) });

    const pipeline = join(home, "native-pipeline.cmd");
    const desktop = join(home, "inert-desktop.cmd");
    const producer = join(home, "inert-producer.mjs");
    const consumer = join(home, "inert-consumer.mjs");
    const consumed = join(home, "consumed");
    const finished = join(home, "finished");
    await copyFile(fileURLToPath(new URL("native-pipeline.cmd", tools)), pipeline);
    await copyFile(statusFilter, join(home, "safe-handoff-status.mjs"));
    await writeFile(desktop, '@echo off\r\n"%CODEX_DSH_PIPE_NODE%" "%CODEX_DSH_TEST_PRODUCER%"\r\n');
    await writeFile(producer, `
      import { existsSync, writeFileSync } from 'node:fs';
      const deadline = setTimeout(() => process.exit(1), 10_000);
      const poll = setInterval(() => {
        if (!existsSync(${JSON.stringify(consumed)})) return;
        writeFileSync(${JSON.stringify(finished)}, 'producer-finished');
        clearInterval(poll); clearTimeout(deadline);
      }, 10);
      process.stdout.write('NON_SECRET_SYNTHETIC_PIPE_INPUT\\n');
    `);
    await writeFile(consumer, `
      import { existsSync, writeFileSync } from 'node:fs';
      process.stdin.once('data', () => {
        writeFileSync(${JSON.stringify(consumed)}, String(!existsSync(${JSON.stringify(finished)})));
        process.stderr.write(${JSON.stringify(success + "\n")});
      });
      process.stdin.resume();
    `);
    const stdout = await runFixture(powershell, ["-NoProfile", "-NonInteractive", "-Command",
      "& $env:CODEX_DSH_TEST_PIPE; exit $LASTEXITCODE"], [], {
      ...process.env,
      CODEX_DSH_TEST_PIPE: pipeline,
      CODEX_DSH_TEST_PRODUCER: producer,
      CODEX_DSH_PIPE_NODE: process.execPath,
      CODEX_DSH_PIPE_DESKTOP: desktop,
      CODEX_DSH_PIPE_HELPER: consumer,
      CODEX_DSH_PIPE_CALLER: join(home, "unused-caller.exe"),
    });
    assert.equal(stdout.replaceAll("\r\n", "\n"), "[handoff] caller_launch_requested\n");
    assert.equal(await readFile(consumed, "utf8"), "true");
    assert.equal(await readFile(finished, "utf8"), "producer-finished");
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
  }
});
