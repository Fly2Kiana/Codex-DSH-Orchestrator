import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

test("public documentation identifies Codex-DSH-Orchestrator at the repository entry point", async () => {
  const [readme, readmeZh, overview, changelog] = await Promise.all([
    readFile(new URL("README.md", root), "utf8"),
    readFile(new URL("README.zh-CN.md", root), "utf8"),
    readFile(new URL("docs/project-overview.md", root), "utf8"),
    readFile(new URL("CHANGELOG.md", root), "utf8"),
  ]);

  for (const [label, document] of [
    ["README.md", readme],
    ["README.zh-CN.md", readmeZh],
  ] as const) {
    assert.match(document, /^# Codex-DSH-Orchestrator$/m, label + " must use the public project title");
    assert.doesNotMatch(document, /^# dsh-Agentlink$/m, label + " must not present the upstream title");
    assert.match(
      document,
      /github\.com\/Fly2Kiana\/Codex-DSH-Orchestrator/,
      label + " must point installation guidance at the maintained repository",
    );
  }

  for (const phrase of [
    "Project components",
    "Project overview",
    "dsh-Agentlink",
    "not a DSH Cordis bundle",
  ]) {
    assert.equal(readme.includes(phrase), true, "README lost public boundary phrase: " + phrase);
  }

  assert.match(overview, /^# Codex-DSH-Orchestrator project overview$/m);
  assert.match(changelog, /^## 0\.1\.0-alpha\.2 — source snapshot$/m);
});

test("public source snapshot preserves license, attribution, and compatibility metadata", async () => {
  const [manifest, license, notice] = await Promise.all([
    readFile(new URL("package.json", root), "utf8").then((raw) => JSON.parse(raw) as {
      name?: string;
      private?: boolean;
      license?: string;
      repository?: { url?: string };
      bin?: Record<string, string>;
    }),
    readFile(new URL("LICENSE", root), "utf8"),
    readFile(new URL("NOTICE", root), "utf8"),
  ]);

  assert.equal(manifest.private, true);
  assert.equal(manifest.name, "dsh-agentlink");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.repository?.url, "https://github.com/Fly2Kiana/Codex-DSH-Orchestrator.git");
  assert.deepEqual(manifest.bin, {
    "dsh-agentlink": "dist/index.js",
    "dsh-agentlink-doctor": "dist/doctor.js",
    "dsh-agentlink-setup": "dist/setup-codex.js",
    "dsh-agentlink-setup-claude": "dist/setup-claude-code.js",
  });
  assert.match(license, /MIT License/);
  assert.match(notice, /dsh-Agentlink/);
  assert.match(notice, /Copyright/);
});
