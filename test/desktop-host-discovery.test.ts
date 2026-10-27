import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DesktopHostDiscoveryError,
  discoverDesktopHostEndpoint,
  discoverOfficialDesktopHostEndpoint,
  parseWindowsNetstatListeners,
} from "../src/desktop-host-discovery.js";
import { MacosInspectionError } from "../src/macos-process-inspection.js";

test("official Desktop discovery selects only its exact executable and owned loopback listener without authentication", async () => {
  const endpoint = await discoverOfficialDesktopHostEndpoint({
    platform: "win32",
    listProcesses: async () => [
      { pid: 101, name: "DeepSeek Harness", executablePath: "C:\\Apps\\DeepSeek Harness.exe" },
      { pid: 102, name: "DSH Desktop", executablePath: "C:\\Apps\\DSH Desktop.exe" },
      { pid: 103, name: "DeepSeek Harness", executablePath: "C:\\Apps\\unrelated.exe" },
    ],
    listListeners: async () => [
      { pid: 101, address: "127.0.0.1", port: 24001 },
      { pid: 101, address: "0.0.0.0", port: 24002 },
      { pid: 102, address: "127.0.0.1", port: 24003 },
      { pid: 103, address: "127.0.0.1", port: 24004 },
    ],
  });
  assert.deepEqual(endpoint, { baseUrl: "http://127.0.0.1:24001", source: "windows-process-listener",
    desktopPids: [101], candidateCount: 1, protocolVerified: false });
});

test("bound authorization selects one observed official listener without probing other owned ports", async () => {
  let inspectedPids: number[] = [];
  const executablePath = "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness";
  const endpoint = await discoverOfficialDesktopHostEndpoint({
    platform: "darwin",
    listProcesses: async () => [101, 102].map((pid) => ({ pid, name: "DeepSeek Harness", executablePath })),
    listListeners: async (pids) => {
      inspectedPids = pids;
      return [
        { pid: 102, address: "127.0.0.1", port: 24001 },
        { pid: 102, address: "127.0.0.1", port: 24002 },
      ];
    },
  }, { authorizedOrigin: "http://127.0.0.1:24002" });
  assert.deepEqual(inspectedPids, [101, 102]);
  assert.deepEqual(endpoint, { baseUrl: "http://127.0.0.1:24002", source: "macos-process-listener",
    desktopPids: [101, 102], candidateCount: 2, protocolVerified: false });
});

test("bound authorization cannot bypass process ownership, inspection or address-family matching", async () => {
  for (const platform of ["win32", "darwin"] as const) {
    const dependencies = { platform, listProcesses: async () => [{ pid: 101, name: "DeepSeek Harness",
      executablePath: platform === "win32" ? "C:\\Apps\\DeepSeek Harness.exe"
        : "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" }],
      listListeners: async () => [
        { pid: 101, address: "127.0.0.1", port: 24001 },
        { pid: 999, address: "127.0.0.1", port: 24002 },
        { pid: 101, address: "0.0.0.0", port: 24003 },
      ] };
    for (const authorizedOrigin of ["http://127.0.0.1:24002", "http://127.0.0.1:24003", "http://[::1]:24001"])
      await assert.rejects(discoverOfficialDesktopHostEndpoint(dependencies, { authorizedOrigin }),
        { code: "authorized_origin_not_found", diagnostic: { stage: "origin-binding", reason: "authorized_origin_not_found" } });
    await assert.rejects(discoverOfficialDesktopHostEndpoint({ ...dependencies, listProcesses: async () => [] },
      { authorizedOrigin: "http://127.0.0.1:24001" }), { code: "desktop_not_running" });
    await assert.rejects(discoverOfficialDesktopHostEndpoint({ ...dependencies,
      listProcesses: async () => { throw new Error("private-output"); } }, { authorizedOrigin: "http://127.0.0.1:24001" }),
      { code: "desktop_inspection_failed", diagnostic: { stage: "process-query", reason: "process_query_failed" } });
  }
});

test("bound authorization normalizes default ports, deduplicates observations and preserves unbound ambiguity", async () => {
  const dependencies = { platform: "win32" as const,
    listProcesses: async () => [{ pid: 101, name: "DeepSeek Harness", executablePath: "C:\\Apps\\DeepSeek Harness.exe" }],
    listListeners: async () => [
      { pid: 101, address: "127.0.0.1", port: 80 }, { pid: 101, address: "127.0.0.1", port: 80 },
      { pid: 101, address: "::1", port: 24002 }, { pid: 101, address: "127.0.0.1", port: 24003 },
    ] };
  for (const [authorizedOrigin, expected] of [["http://127.0.0.1/", "http://127.0.0.1:80"],
    ["http://[::1]:24002", "http://[::1]:24002"]]) {
    const endpoint = await discoverOfficialDesktopHostEndpoint(dependencies, { authorizedOrigin });
    assert.equal(endpoint.baseUrl, expected);
    assert.equal(endpoint.candidateCount, 3);
  }
  await assert.rejects(discoverOfficialDesktopHostEndpoint(dependencies), { code: "ambiguous_desktop_host",
    diagnostic: { stage: "candidate-selection", reason: "ambiguous_desktop_host" } });
});

test("official discovery rejects malformed origin constraints without including their content", async () => {
  for (const authorizedOrigin of ["secret", "http://user:secret@127.0.0.1:24001", "http://127.0.0.1:24001/path",
    "http://127.0.0.1:24001?token=secret", "http://127.0.0.1:24001/#secret", "http://untrusted.invalid:24001",
    " http://127.0.0.1:24001", "http://127.0.0.1:99999", "http://127.0.0.1:24001\n"]) {
    await assert.rejects(discoverOfficialDesktopHostEndpoint({ platform: "win32",
      listProcesses: async () => [{ pid: 101, name: "DeepSeek Harness", executablePath: "C:\\Apps\\DeepSeek Harness.exe" }],
      listListeners: async () => [{ pid: 101, address: "127.0.0.1", port: 24001 }],
    }, { authorizedOrigin }), (error: unknown) => {
      assert.ok(error instanceof DesktopHostDiscoveryError);
      assert.equal(error.code, "invalid_authorized_origin");
      for (const value of [authorizedOrigin, "secret", "127.0.0.1", "24001"]) assert.equal(JSON.stringify(error).includes(value), false);
      return true;
    });
  }
});

test("official discovery preserves only audited native inspection reasons and never raw causes", async () => {
  for (const [stage, reasons] of [
    ["process-query", ["process_metadata_invalid", "process_query_failed"]],
    ["listener-query", ["listener_metadata_invalid", "listener_scope_mismatch", "invalid_pid_scope", "listener_query_failed"]],
  ] as const) {
    for (const reason of [...reasons, "private-token-at-address"]) {
      await assert.rejects(discoverOfficialDesktopHostEndpoint({ platform: "darwin",
        listProcesses: async () => {
          if (stage === "process-query") throw new MacosInspectionError(reason);
          return [{ pid: 101, name: "DeepSeek Harness", executablePath: "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" }];
        },
        listListeners: async () => { throw new MacosInspectionError(reason); },
      }), (error: unknown) => {
        assert.ok(error instanceof DesktopHostDiscoveryError);
        assert.deepEqual(error.diagnostic, { stage, reason: reason === "private-token-at-address"
          ? stage === "process-query" ? "process_query_failed" : "listener_query_failed" : reason });
        assert.equal(error.cause, undefined);
        assert.equal(JSON.stringify(error).includes("private-token-at-address"), false);
        return true;
      });
    }
  }
});

test("official Desktop discovery refuses missing, ambiguous and unsupported candidates before connecting", async () => {
  const process = { pid: 101, name: "DeepSeek Harness", executablePath: "C:\\Apps\\DeepSeek Harness.exe" };
  const dependencies = { platform: "win32" as const, listProcesses: async () => [process],
    listListeners: async () => [{ pid: 101, address: "127.0.0.1", port: 24001 }] };
  await assert.rejects(discoverOfficialDesktopHostEndpoint({ ...dependencies, platform: "linux" }), { code: "unsupported_platform" });
  await assert.rejects(discoverOfficialDesktopHostEndpoint({ ...dependencies, listProcesses: async () => [] }), { code: "desktop_not_running" });
  await assert.rejects(discoverOfficialDesktopHostEndpoint({ ...dependencies, listListeners: async () => [] }), { code: "desktop_host_not_found" });
  await assert.rejects(discoverOfficialDesktopHostEndpoint({ ...dependencies, listListeners: async () => [
    { pid: 101, address: "127.0.0.1", port: 24001 }, { pid: 101, address: "::1", port: 24002 },
  ] }), { code: "ambiguous_desktop_host" });
});

test("official macOS discovery scopes listener inspection to the packaged app and never probes a Host", async () => {
  let inspectedPids: number[] = [];
  const endpoint = await discoverOfficialDesktopHostEndpoint({
    platform: "darwin",
    listProcesses: async () => [
      { pid: 101, name: "DeepSeek Harness", executablePath: "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" },
      { pid: 102, name: "DeepSeek Harness", executablePath: "/Applications/Other.app/Contents/MacOS/DeepSeek Harness" },
      { pid: 103, name: "DeepSeek Harness", executablePath: "/tmp/DeepSeek Harness" },
      { pid: 104, name: "DeepSeek Harness Helper", executablePath: "/Applications/DeepSeek Harness.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper" },
    ],
    listListeners: async (pids: number[]) => {
      inspectedPids = pids;
      return [
        { pid: 101, address: "127.0.0.1", port: 24001 },
        { pid: 101, address: "0.0.0.0", port: 24002 },
        { pid: 102, address: "127.0.0.1", port: 24003 },
      ];
    },
  });
  assert.deepEqual(inspectedPids, [101]);
  assert.deepEqual(endpoint, { baseUrl: "http://127.0.0.1:24001", source: "macos-process-listener",
    desktopPids: [101], candidateCount: 1, protocolVerified: false });
});

test("official macOS discovery accepts relocated bundles but refuses lookalikes and ambiguous origins", async () => {
  const app = { pid: 101, name: "DeepSeek Harness",
    executablePath: "/private/var/folders/example/AppTranslocation/ABC/d/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" };
  const dependencies = { platform: "darwin" as const, listProcesses: async () => [app],
    listListeners: async () => [{ pid: 101, address: "::1", port: 24001 }] };
  assert.equal((await discoverOfficialDesktopHostEndpoint(dependencies)).baseUrl, "http://[::1]:24001");
  for (const path of ["/tmp/DeepSeek Harness", "/tmp/Other.app/Contents/MacOS/DeepSeek Harness",
    "/tmp/DeepSeek Harness.app/../Other.app/Contents/MacOS/DeepSeek Harness",
    "/tmp/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness --argument"]) {
    await assert.rejects(discoverOfficialDesktopHostEndpoint({ ...dependencies,
      listProcesses: async () => [{ ...app, executablePath: path }] }), { code: "desktop_not_running" });
  }
  await assert.rejects(discoverOfficialDesktopHostEndpoint({ ...dependencies, listListeners: async () => [] }),
    { code: "desktop_host_not_found" });
  await assert.rejects(discoverOfficialDesktopHostEndpoint({ ...dependencies, listListeners: async () => [
    { pid: 101, address: "127.0.0.1", port: 24001 }, { pid: 101, address: "::1", port: 24002 },
  ] }), { code: "ambiguous_desktop_host" });
});

test("desktop discovery probes only loopback listeners owned by exact DSH Desktop processes", async () => {
  const probed: string[] = [];
  const resolution = await discoverDesktopHostEndpoint({
    platform: "win32",
    listProcesses: async () => [
      { pid: 101, name: "DSH Desktop", executablePath: "C:\\Apps\\DSH Desktop\\DSH Desktop.exe" },
      { pid: 202, name: "Other App", executablePath: "C:\\Apps\\Other App.exe" },
      { pid: 303, name: "DSH Desktop", executablePath: "C:\\Apps\\spoof.exe" },
    ],
    listListeners: async () => [
      { address: "127.0.0.1", port: 1656, pid: 101 },
      { address: "0.0.0.0", port: 2000, pid: 101 },
      { address: "127.0.0.1", port: 3000, pid: 202 },
      { address: "127.0.0.1", port: 4000, pid: 303 },
    ],
    probe: async (baseUrl) => {
      probed.push(baseUrl);
      return baseUrl === "http://127.0.0.1:1656";
    },
  });

  assert.deepEqual(probed, ["http://127.0.0.1:1656"]);
  assert.deepEqual(resolution, {
    baseUrl: "http://127.0.0.1:1656",
    source: "windows-process-listener",
    desktopPids: [101],
    candidateCount: 1,
  });
});

test("desktop discovery fails closed when no Desktop process or no verified Host exists", async () => {
  await assert.rejects(
    () =>
      discoverDesktopHostEndpoint({
        platform: "win32",
        listProcesses: async () => [],
        listListeners: async () => [],
        probe: async () => true,
      }),
    (error: unknown) => error instanceof DesktopHostDiscoveryError && error.code === "desktop_not_running",
  );

  await assert.rejects(
    () =>
      discoverDesktopHostEndpoint({
        platform: "win32",
        listProcesses: async () => [
          { pid: 101, name: "DSH Desktop", executablePath: "C:\\Apps\\DSH Desktop.exe" },
        ],
        listListeners: async () => [{ address: "127.0.0.1", port: 1656, pid: 101 }],
        probe: async () => false,
      }),
    (error: unknown) => error instanceof DesktopHostDiscoveryError && error.code === "desktop_host_not_found",
  );
});

test("desktop discovery rejects multiple verified Desktop Hosts instead of guessing", async () => {
  await assert.rejects(
    () =>
      discoverDesktopHostEndpoint({
        platform: "win32",
        listProcesses: async () => [
          { pid: 101, name: "DSH Desktop", executablePath: "C:\\Apps\\DSH Desktop.exe" },
        ],
        listListeners: async () => [
          { address: "127.0.0.1", port: 1656, pid: 101 },
          { address: "::1", port: 2656, pid: 101 },
        ],
        probe: async () => true,
      }),
    (error: unknown) =>
      error instanceof DesktopHostDiscoveryError &&
      error.code === "ambiguous_desktop_host" &&
      error.details.verifiedCount === 2,
  );
});

test("desktop discovery is Windows-only and does not silently fall back to scanning", async () => {
  await assert.rejects(
    () =>
      discoverDesktopHostEndpoint({
        platform: "linux",
        listProcesses: async () => [],
        listListeners: async () => [],
        probe: async () => true,
      }),
    (error: unknown) => error instanceof DesktopHostDiscoveryError && error.code === "unsupported_platform",
  );
});

test("Windows netstat parser returns only TCP listeners with numeric pids", () => {
  const listeners = parseWindowsNetstatListeners(`
  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:1656         0.0.0.0:0              LISTENING       29108
  TCP    [::1]:2656             [::]:0                 LISTENING       29108
  TCP    127.0.0.1:1656         127.0.0.1:5000         ESTABLISHED     29108
  UDP    127.0.0.1:9999         *:*                                    29108
  `);

  assert.deepEqual(listeners, [
    { address: "127.0.0.1", port: 1656, pid: 29108 },
    { address: "::1", port: 2656, pid: 29108 },
  ]);
});
