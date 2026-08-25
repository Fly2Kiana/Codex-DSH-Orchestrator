import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicInstallText, readConfigSnapshot } from "./setup-engine.js";
import type { AtomicInstallTextResult, ConfigSnapshot } from "./setup-engine.js";

const CODEX_SKILL_NAME = "codex-dsh-orchestrator";
const CODEX_SKILL_FILES = ["SKILL.md", join("agents", "openai.yaml")] as const;

export interface CodexSkillFilePlan {
  relativePath: string;
  sourcePath: string;
  targetPath: string;
  content: string;
  snapshot: ConfigSnapshot;
}

export interface CodexSkillInstallPlan {
  targetPath: string;
  replace: boolean;
  files: readonly CodexSkillFilePlan[];
  changed: boolean;
}

export interface CodexSkillInstallResult {
  changed: boolean;
  targetPath: string;
  backupPaths: readonly string[];
}

function canonicalCodexSkillSourcePath(relativePath: string): string {
  return fileURLToPath(new URL(`../skill/${CODEX_SKILL_NAME}/${relativePath.replaceAll("\\", "/")}`, import.meta.url));
}

export function resolveCodexSkillTarget(cwd: string, explicitPath?: string): string {
  if (explicitPath !== undefined && explicitPath.trim() === "") {
    throw new Error("--skill-path requires a non-empty directory path");
  }
  return resolve(cwd, explicitPath ?? join(".agents", "skills", CODEX_SKILL_NAME));
}

async function assertRegularSource(path: string): Promise<void> {
  const details = await lstat(path);
  if (details.isSymbolicLink()) throw new Error(`refusing to read symlinked Codex skill source: ${path}`);
  if (!details.isFile()) throw new Error(`Codex skill source is not a regular file: ${path}`);
}

async function assertExistingParentDirectoriesAreSafe(targetPath: string): Promise<void> {
  let current = dirname(targetPath);
  while (true) {
    const details = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      if (error.code === "ENOTDIR") {
        throw new Error(`Codex skill parent path is not a directory: ${current}`, { cause: error });
      }
      throw error;
    });
    if (details !== undefined) {
      if (details.isSymbolicLink()) {
        throw new Error(`refusing to install Codex skill through symlinked directory: ${current}`);
      }
      if (!details.isDirectory()) throw new Error(`Codex skill parent path is not a directory: ${current}`);
    }

    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function assertTargetDirectoryIsSafe(targetPath: string): Promise<void> {
  const details = await lstat(targetPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (details === undefined) return;
  if (details.isSymbolicLink()) throw new Error(`refusing to install Codex skill into symlinked directory: ${targetPath}`);
  if (!details.isDirectory()) throw new Error(`Codex skill target path is not a directory: ${targetPath}`);
}

export async function prepareCodexSkillInstall(targetPath: string, replace: boolean): Promise<CodexSkillInstallPlan> {
  const resolvedTarget = resolve(targetPath);
  await assertExistingParentDirectoriesAreSafe(resolvedTarget);
  await assertTargetDirectoryIsSafe(resolvedTarget);

  const files: CodexSkillFilePlan[] = [];
  for (const relativePath of CODEX_SKILL_FILES) {
    const sourcePath = canonicalCodexSkillSourcePath(relativePath);
    await assertRegularSource(sourcePath);
    const [content, snapshot] = await Promise.all([
      readFile(sourcePath, "utf8"),
      readConfigSnapshot(join(resolvedTarget, relativePath)),
    ]);
    const targetFilePath = join(resolvedTarget, relativePath);
    if (snapshot.exists && snapshot.content !== content && !replace) {
      throw new Error(
        `Codex skill file already exists at ${targetFilePath}; rerun with --replace-skill after reviewing it, or use --no-skill`,
      );
    }
    files.push({ relativePath, sourcePath, targetPath: targetFilePath, content, snapshot });
  }

  return {
    targetPath: resolvedTarget,
    replace,
    files,
    changed: files.some((file) => !file.snapshot.exists || file.snapshot.content !== file.content),
  };
}

export async function installCodexSkill(plan: CodexSkillInstallPlan): Promise<CodexSkillInstallResult> {
  const backupPaths: string[] = [];
  let changed = false;
  for (const file of plan.files) {
    const result: AtomicInstallTextResult = await atomicInstallText({
      path: file.targetPath,
      content: file.content,
      expected: file.snapshot,
      backupLabel: "dsh-agentlink-codex-skill",
      tempLabel: "dsh-agentlink-codex-skill",
      verify: (installed) => installed === file.content,
    });
    changed = changed || result.changed;
    if (result.backupPath !== undefined) backupPaths.push(result.backupPath);
  }
  return { changed, targetPath: plan.targetPath, backupPaths };
}
