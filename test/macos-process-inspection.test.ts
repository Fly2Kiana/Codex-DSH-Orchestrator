import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { discoverOfficialDesktopHostEndpoint } from "../src/desktop-host-discovery.js";
import { listMacosProcesses, listMacosTcpListeners, macosCallerIsRunning, parseMacosProcessList, parseMacosTcpListeners } from "../src/macos-process-inspection.js";

test("macOS command metadata preserves full spaced app paths without requesting arguments", () => {
  assert.deepEqual(parseMacosProcessList("  101 /Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness\n" +
    "  102 /Users/example/Applications/Codex.app/Contents/MacOS/Codex\n  103 (node)\n"), [
    { pid: 101, name: "DeepSeek Harness", executablePath: "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" },
    { pid: 102, name: "Codex", executablePath: "/Users/example/Applications/Codex.app/Contents/MacOS/Codex" },
    { pid: 103, name: "node", executablePath: "" },
  ]);
  for (const output of ["", "not-process-metadata-SYNTHETIC-SECRET", "0 /a", "101 /a\n101 /b\n"]) {
    assert.throws(() => parseMacosProcessList(output), (error: any) =>
      error.code === "process_metadata_invalid" && !String(error).includes("SYNTHETIC-SECRET"));
  }
});

test("macOS caller checks conservatively refuse same-name instances and sanitize failed OS inspection", async () => {
  const caller = "/Applications/Codex.app/Contents/MacOS/Codex";
  assert.equal(await macosCallerIsRunning(caller, async () => parseMacosProcessList(
    "101 /Users/example/Other/Codex.app/Contents/MacOS/Codex\n")), true);
  assert.equal(await macosCallerIsRunning(caller, async () => parseMacosProcessList("101 (Codex)\n")), true);
  assert.equal(await macosCallerIsRunning(caller, async () => parseMacosProcessList("101 /Applications/Helper.app/Contents/MacOS/Codex Helper\n")), false);
  await assert.rejects(macosCallerIsRunning(caller, async () => { throw new Error("SYNTHETIC-SECRET"); }),
    (error: any) => error.code === "process_query_failed" && !String(error).includes("SYNTHETIC-SECRET"));
});

test("native macOS inspection finds only its own synthetic listener without Desktop or authentication", async () => {
  if (process.platform !== "darwin") {
    await assert.rejects(listMacosProcesses(), { code: "unsupported_platform" });
    await assert.rejects(listMacosTcpListeners([process.pid]), { code: "unsupported_platform" });
    return;
  }
  const processes = await listMacosProcesses();
  assert.equal(processes.some((row) => row.pid === process.pid), true);
  assert.deepEqual(await listMacosTcpListeners([]), []);
  for (const pids of [[0], [-1], [NaN], [2_147_483_648], Array(129).fill(process.pid)]) {
    await assert.rejects(listMacosTcpListeners(pids), { code: "invalid_pid_scope" });
  }
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const listeners = await listMacosTcpListeners([process.pid]);
    assert.equal(listeners.every((row) => row.pid === process.pid), true);
    assert.equal(listeners.some((row) => row.address === "127.0.0.1" && row.port === address.port), true);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("macOS lsof field output retains PID ownership and only numeric loopback listeners", () => {
  assert.deepEqual(parseMacosTcpListeners("p101\nf12\nn127.0.0.1:24001\nf13\nn[::1]:24002\n" +
    "p102\nn*:24003\nn192.168.1.2:24004\n"), [
    { pid: 101, address: "127.0.0.1", port: 24001 },
    { pid: 101, address: "::1", port: 24002 },
  ]);
  assert.deepEqual(parseMacosTcpListeners(""), []);
  for (const output of ["p0\nn127.0.0.1:24001", "n127.0.0.1:24001", "p101\nn127.0.0.1:0",
    "p101\nn127.0.0.1:65536", "p101\nnSYNTHETIC-SECRET"]) {
    assert.throws(() => parseMacosTcpListeners(output), (error: any) =>
      error.code === "listener_metadata_invalid" && !String(error).includes("SYNTHETIC-SECRET"));
  }
});

test("native macOS spaced-bundle fixture is discovered by PID without launching Desktop or probing a Host", async () => {
  if (process.platform !== "darwin") {
    await assert.rejects(listMacosProcesses(), { code: "unsupported_platform" });
    return;
  }
  const home = await mkdtemp(join(await realpath(tmpdir()), "dsh-native-bundle-fixture-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const directory = join(home, "DeepSeek Harness.app", "Contents", "MacOS");
    await mkdir(directory, { recursive: true });
    const executable = join(directory, "DeepSeek Harness");
    await copyFile(process.execPath, executable);
    child = spawn(executable, ["-e", `const server=require('node:net').createServer();
      server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));`],
      { stdio: ["ignore", "ignore", "ignore", "ipc"], env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
    const [message] = await once(child, "message", { signal: AbortSignal.timeout(10_000) });
    const endpoint = await discoverOfficialDesktopHostEndpoint({ platform: "darwin",
      listProcesses: async () => (await listMacosProcesses()).filter((row) => row.pid === child!.pid),
      listListeners: listMacosTcpListeners });
    assert.equal(endpoint.baseUrl, `http://127.0.0.1:${message.port}`);
    assert.equal(endpoint.source, "macos-process-listener");
    assert.equal(endpoint.protocolVerified, false);
    assert.deepEqual(endpoint.desktopPids, [child.pid]);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill(); // Only the inert Node fixture created above, never Desktop.
      await closed;
    }
    await rm(home, { recursive: true, force: true });
  }
});
