import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);

const ignoredDirectoryNames = new Set([".agents", ".git", ".worktrees", "dist", "node_modules"]);
const ignoredFilePaths = new Set(["test/public-surface.test.ts"]);
const publicSurfaceRules = [
  ["drive-qualified user path", /[A-Za-z]:[\\/]+Users[\\/]+/i],
  ["AppData path segment", /(?:^|[\\/])AppData(?:[\\/]|$)/i],
  ["internal runner identity", new RegExp(["Codex", "SandboxOffline"].join(""))],
  ["maintenance backup reference", new RegExp(["refs", "/", "backup", "/"].join(""))],
  ["agent-only sub-skill directive", new RegExp(["REQUIRED", "\\s+", "SUB-SKILL"].join(""))],
  ["internal agent workflow marker", new RegExp(["super", "powers", ":"].join(""))],
] as const;

async function collectRepositoryFiles(directory: string, relativeDirectory = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || ignoredDirectoryNames.has(entry.name)) continue;

    const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectRepositoryFiles(absolutePath, relativePath)));
    } else if (entry.isFile() && !ignoredFilePaths.has(relativePath.replaceAll("\\", "/"))) {
      files.push(relativePath);
    }
  }
  return files;
}

test("public documentation identifies Codex-DSH-Orchestrator at the repository entry point", async () => {
  const [readme, readmeZh, overview, changelog, gitignore, validation] = await Promise.all([
    readFile(new URL("README.md", root), "utf8"),
    readFile(new URL("README.zh-CN.md", root), "utf8"),
    readFile(new URL("docs/project-overview.md", root), "utf8"),
    readFile(new URL("CHANGELOG.md", root), "utf8"),
    readFile(new URL(".gitignore", root), "utf8"),
    readFile(new URL("docs/validation.md", root), "utf8"),
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
    assert.match(
      document,
      /\[DSH Desktop\]\(https:\/\/github\.com\/anywhere-labs\/dsh-desktop\)/,
      label + " must identify the DSH Desktop repository",
    );
    assert.match(
      document,
      /\[ModLens\]\(https:\/\/github\.com\/liustack\/modlens\)/,
      label + " must identify the ModLens repository",
    );
  }

  assert.match(readme, /Not maintained by or affiliated with this project/);
  assert.match(readmeZh, /本项目不维护 ModLens，也不与其存在隶属关系/);

  assert.doesNotMatch(readme, /exact upstream repository is not identified/i);
  assert.doesNotMatch(readmeZh, /未指明其确切的上游仓库/);

  assert.ok(readme.indexOf("## Project boundary") < readme.indexOf("## Quick start"));
  assert.ok(readme.indexOf("## Quick start") < readme.indexOf("## For AI Agents"));
  assert.ok(readme.indexOf("### Recommended: copy/paste the Agent installation prompt") < readme.indexOf("### Manual setup and verification"));
  assert.ok(readmeZh.indexOf("## 项目边界") < readmeZh.indexOf("## 快速上手"));
  assert.ok(readmeZh.indexOf("## 快速上手") < readmeZh.indexOf("## 给 AI Agents"));
  assert.ok(readmeZh.indexOf("### 推荐：复制给 Agent 的安装 Prompt") < readmeZh.indexOf("### 手动配置与验收"));
  for (const [label, document, phrases] of [
    [
      "README.md",
      readme,
      ["npm run setup -- --yes", ".agents/skills/codex-dsh-orchestrator", "--no-skill", "--replace-skill", "For AI Agents"],
    ],
    [
      "README.zh-CN.md",
      readmeZh,
      ["npm run setup -- --yes", ".agents/skills/codex-dsh-orchestrator", "--no-skill", "--replace-skill", "给 AI Agents"],
    ],
  ] as const) {
    for (const phrase of phrases) assert.equal(document.includes(phrase), true, `${label} lost setup phrase: ${phrase}`);
  }
  assert.doesNotMatch(readme, /npm run setup[^\n]*does not install.*skill/i);
  assert.doesNotMatch(readmeZh, /npm run setup[^\n]*不会安装.*skill/i);

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
  assert.match(gitignore, /^\/\.agents\/skills\/codex-dsh-orchestrator\/$/m);
  assert.match(validation, /^# Validation guide$/m);
  assert.match(validation, /^## Visual routing validation$/m);
  assert.doesNotMatch(validation, /[A-Za-z]:[\\/]+Users[\\/]+/i);
  assert.doesNotMatch(validation, /refs[\\/]backup[\\/]/i);
  assert.doesNotMatch(validation, /\b(?:task|session)\s+id\b/i);
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

test("public source surface excludes machine-specific and internal maintenance data", async () => {
  const files = await collectRepositoryFiles(rootPath);

  for (const relativePath of files) {
    const document = await readFile(join(rootPath, relativePath), "utf8");
    for (const [label, rule] of publicSurfaceRules) {
      assert.doesNotMatch(document, rule, `${relativePath} contains ${label}`);
    }
  }
});
