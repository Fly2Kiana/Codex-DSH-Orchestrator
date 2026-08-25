import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  installCodexSkill,
  prepareCodexSkillInstall,
  resolveCodexSkillTarget,
} from "../src/codex-skill-install.js";

async function temporaryProject(context: { after: (callback: () => void | Promise<void>) => void }): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), "dsh-agentlink-codex-skill-"));
  context.after(() => rm(project, { recursive: true, force: true }));
  return project;
}

test("Codex skill target defaults to the repository-scoped discovery directory", async (context) => {
  const project = await temporaryProject(context);
  assert.equal(
    resolveCodexSkillTarget(project),
    join(project, ".agents", "skills", "codex-dsh-orchestrator"),
  );
  assert.equal(
    resolveCodexSkillTarget(project, "custom/skill"),
    join(project, "custom", "skill"),
  );
});

test("Codex skill installation writes the canonical files exactly and is idempotent", async (context) => {
  const project = await temporaryProject(context);
  const target = resolveCodexSkillTarget(project);

  const prepared = await prepareCodexSkillInstall(target, false);
  assert.equal(prepared.changed, true);
  assert.deepEqual(
    prepared.files.map((file) => file.relativePath),
    ["SKILL.md", join("agents", "openai.yaml")],
  );

  const installed = await installCodexSkill(prepared);
  assert.equal(installed.changed, true);
  for (const file of prepared.files) {
    assert.equal(await readFile(file.targetPath, "utf8"), file.content);
  }

  const again = await prepareCodexSkillInstall(target, false);
  assert.equal(again.changed, false);
  assert.equal((await installCodexSkill(again)).changed, false);
});

test("Codex skill preflight rejects conflicts before writing any canonical file", async (context) => {
  const project = await temporaryProject(context);
  const target = resolveCodexSkillTarget(project);
  await mkdir(join(target, "agents"), { recursive: true });
  const skillPath = join(target, "SKILL.md");
  await writeFile(skillPath, "locally customized skill\n");

  await assert.rejects(
    () => prepareCodexSkillInstall(target, false),
    /Codex skill file already exists at .*SKILL\.md; rerun with --replace-skill/,
  );
  assert.equal(await readFile(skillPath, "utf8"), "locally customized skill\n");
  await assert.rejects(() => lstat(join(target, "agents", "openai.yaml")), { code: "ENOENT" });
});

test("Codex skill replacement creates per-file backups and preserves unrelated files", async (context) => {
  const project = await temporaryProject(context);
  const target = resolveCodexSkillTarget(project);
  await mkdir(join(target, "agents"), { recursive: true });
  await writeFile(join(target, "SKILL.md"), "old skill\n");
  await writeFile(join(target, "agents", "openai.yaml"), "old metadata\n");
  await writeFile(join(target, "keep.txt"), "do not touch\n");

  const prepared = await prepareCodexSkillInstall(target, true);
  const result = await installCodexSkill(prepared);
  assert.equal(result.changed, true);
  assert.equal(result.backupPaths.length, 2);
  assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "do not touch\n");
  assert.equal(await readFile(result.backupPaths[0] as string, "utf8"), "old skill\n");
  assert.equal(await readFile(result.backupPaths[1] as string, "utf8"), "old metadata\n");
});

test("Codex skill installation rejects a non-directory parent", async (context) => {
  const project = await temporaryProject(context);
  await writeFile(join(project, ".agents"), "not a directory\n");

  await assert.rejects(
    () => prepareCodexSkillInstall(resolveCodexSkillTarget(project), false),
    /Codex skill parent path is not a directory/,
  );
});

test("Codex skill installation rejects a symlinked parent", async (context) => {
  const project = await temporaryProject(context);
  const realAgents = join(project, "real-agents");
  await mkdir(realAgents);
  try {
    await symlink(realAgents, join(project, ".agents"), process.platform === "win32" ? "junction" : undefined);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "UNKNOWN") {
      context.skip(`symlink creation is unavailable on this runner: ${code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(
    () => prepareCodexSkillInstall(resolveCodexSkillTarget(project), false),
    /refusing to install Codex skill through symlinked directory/,
  );
});
