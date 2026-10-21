import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DesktopHostDiscoveryError,
  discoverDesktopHostEndpoint,
  discoverOfficialDesktopHostEndpoint,
  parseWindowsNetstatListeners,
} from "../src/desktop-host-discovery.js";

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

test("official Desktop discovery refuses missing, ambiguous and unsupported candidates before connecting", async () => {
  const process = { pid: 101, name: "DeepSeek Harness", executablePath: "C:\\Apps\\DeepSeek Harness.exe" };
  const dependencies = { platform: "win32" as const, listProcesses: async () => [process],
    listListeners: async () => [{ pid: 101, address: "127.0.0.1", port: 24001 }] };
  await assert.rejects(discoverOfficialDesktopHostEndpoint({ ...dependencies, platform: "darwin" }), { code: "unsupported_platform" });
  await assert.rejects(discoverOfficialDesktopHostEndpoint({ ...dependencies, listProcesses: async () => [] }), { code: "desktop_not_running" });
  await assert.rejects(discoverOfficialDesktopHostEndpoint({ ...dependencies, listListeners: async () => [] }), { code: "desktop_host_not_found" });
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
