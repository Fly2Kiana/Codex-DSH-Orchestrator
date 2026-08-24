import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../src/config.js";
import { createHostEndpointResolver } from "../src/host-endpoint.js";

test("static endpoint resolution never invokes Desktop discovery", async () => {
  let discoveryCalls = 0;
  const config = loadConfig({
    DSH_HOME: "/tmp/dsh-test-home",
    DSH_HOST_URL: "http://127.0.0.1:43123",
    DSH_BRIDGE_TIME_ZONE: "UTC",
  });
  const resolver = createHostEndpointResolver(config, async () => {
    discoveryCalls += 1;
    throw new Error("must not run");
  });

  assert.equal(resolver.mode, "static");
  assert.deepEqual(await resolver.resolve(), {
    baseUrl: "http://127.0.0.1:43123",
    source: "configured",
  });
  assert.equal(discoveryCalls, 0);
});

test("desktop-auto delegates each fresh resolution to verified Desktop discovery", async () => {
  let discoveryCalls = 0;
  const config = loadConfig({
    DSH_HOME: "/tmp/dsh-test-home",
    DSH_HOST_MODE: "desktop-auto",
    DSH_BRIDGE_TIME_ZONE: "UTC",
  });
  const resolver = createHostEndpointResolver(config, async () => ({
    baseUrl: `http://127.0.0.1:${1655 + ++discoveryCalls}`,
    source: "windows-process-listener",
    desktopPids: [29108],
    candidateCount: 1,
  }));

  assert.equal(resolver.mode, "desktop-auto");
  assert.deepEqual(await resolver.resolve(), {
    baseUrl: "http://127.0.0.1:1656",
    source: "windows-process-listener",
  });
  assert.deepEqual(await resolver.resolve(), {
    baseUrl: "http://127.0.0.1:1657",
    source: "windows-process-listener",
  });
});
