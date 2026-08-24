import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { PACKAGE_VERSION } from "../src/version.js";

test("runtime MCP version matches the package manifest", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  assert.equal(PACKAGE_VERSION, manifest.version);
});
