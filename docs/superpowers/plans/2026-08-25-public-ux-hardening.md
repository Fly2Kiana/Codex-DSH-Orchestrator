# Public UX Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the public-facing installation experience and portability guidance without changing the bridge communication protocol, DSH lifecycle, or authentication behavior.

**Architecture:** Keep runtime behavior unchanged in the first stage. Put user-facing guidance in the English and Chinese README files and validation documentation, and keep all generated Codex skill output outside the tracked source surface. Any later setup or smoke changes must remain explicit, isolated, and independently verifiable.

**Tech Stack:** Markdown, PowerShell documentation, Node.js 22+, npm, TypeScript, Git worktrees, existing `npm run check` and `npm pack --dry-run` validation.

## Global Constraints

- Candidate base is `755afaa5418b6c0679c22c6c5eed18b622897251` on `codex/skill-install-readme-20260825`.
- Do not modify bridge communication semantics, DSH Host lifecycle, Codex/DSH/MCP configuration, system networking, or credentials.
- Preserve upstream MIT license, copyright, NOTICE, and attribution.
- Do not commit `dist/`, `node_modules/`, generated `.agents/skills/` copies, bridge state, credentials, transcripts, or machine-specific paths.
- Do not use `git push --all`, force push, reset, clean, or history replacement.
- Any remote push, pull request, Release, Tag, npm operation, or public-state change requires explicit user approval at the relevant checkpoint.
- A local backup ref is required before and after each implementation batch; every handoff must report the commit, changed paths, and rollback ref.
- DSH may provide bounded copy suggestions only; Codex independently decides wording, edits files, tests, and accepts the result.

---

## Approved scope: Stage 1 — public UX and documentation hardening

### Task 1: Record the baseline and create a local rollback point

**Files:**
- Create: `docs/superpowers/plans/2026-08-25-public-ux-hardening.md`
- Git ref: `refs/backup/pre-public-ux-hardening-20260825`

- [ ] **Step 1: Confirm the candidate worktree is clean**

Run from `C:\Users\30317\Documents\ChatGPT\DSH-Codex\.worktrees\skill-install-readme-20260825`:

```powershell
git status --short --branch
git rev-parse HEAD
```

Expected: branch `codex/skill-install-readme-20260825`, HEAD `755afaa5418b6c0679c22c6c5eed18b622897251`, and no working-tree changes before Stage 1 edits.

- [ ] **Step 2: Create and verify the pre-change backup ref**

```powershell
git update-ref refs/backup/pre-public-ux-hardening-20260825 755afaa5418b6c0679c22c6c5eed18b622897251
git show -s --format='%H %s' refs/backup/pre-public-ux-hardening-20260825
```

Expected: the backup resolves to the candidate HEAD. Rollback for this batch is `git revert <stage-1-commit>`; if the commit has not been shared, the saved backup ref is the inspection point and must not be used for destructive reset without separate approval.

### Task 2: Remove development-specific wording from related-project documentation

**Files:**
- Modify: `README.md` related-projects table
- Modify: `README.zh-CN.md` related-projects table
- Test if needed: `test/public-surface.test.ts`

- [ ] **Step 1: Replace the English wording**

Replace `its exact repository is not identified in this worktree, so no repository link is guessed` with `its exact repository is not identified here, so no repository link is guessed`.

- [ ] **Step 2: Replace the Chinese wording**

Replace `本 worktree 未标识其确切仓库，因此不猜测仓库链接` with `此处未识别其确切仓库，因此不猜测仓库链接`.

- [ ] **Step 3: Preserve the attribution meaning**

Keep the statement that DSH Desktop is separately managed and that this repository does not guess an unverified repository URL.

### Task 3: Document bridge-home isolation for multiple bridge implementations

**Files:**
- Modify: `README.md` portability or environment section
- Modify: `README.zh-CN.md` portability or environment section
- Modify: `docs/validation.md` portability checks

- [ ] **Step 1: Add the English rule**

Document all of the following points:

1. Multiple processes of this same bridge may use the same bridge home when they share the documented cooperative locking model.
2. A different bridge implementation, incompatible ledger/schema, or independently managed bridge must not reuse the same `DSH_BRIDGE_HOME`.
3. Use a separate local directory when bridges must coexist, for example:

```powershell
$env:DSH_BRIDGE_HOME = Join-Path $env:USERPROFILE '.dsh\codex-dsh-orchestrator'
```

4. Do not commit this path or copy an old bridge home to another machine.

- [ ] **Step 2: Add the equivalent Chinese rule**

State the same distinction without implying that every second process requires a new home. Keep the terms `DSH_BRIDGE_HOME`, ledger, schema, lock, and fresh home unchanged where they are technical identifiers.

- [ ] **Step 3: Add validation expectations**

Add a read-only checklist item confirming that a fresh disposable home is used for a new machine and that any explicitly configured shared path has been reviewed for bridge/schema compatibility.

### Task 4: Add a safe human-readable PowerShell quick-install block

**Files:**
- Modify: `README.md` Quick Start
- Modify: `README.zh-CN.md` 快速上手
- Modify: `docs/validation.md` installation validation

- [ ] **Step 1: Add the exact human workflow block**

The documented block must be visibly labeled as a user-run command block, not a remote installer, and must follow this sequence:

```powershell
$ErrorActionPreference = 'Stop'
$repoUrl = 'https://github.com/Fly2Kiana/Codex-DSH-Orchestrator.git'
$installDir = Join-Path $env:USERPROFILE 'Tools\Codex-DSH-Orchestrator'

if (Test-Path -LiteralPath $installDir) {
  if (-not (Test-Path -LiteralPath (Join-Path $installDir '.git'))) {
    throw "The install directory exists but is not a Git checkout: $installDir"
  }
  Set-Location -LiteralPath $installDir
  if (@(git status --porcelain).Count -ne 0) {
    throw 'The existing checkout has local changes; review them before updating.'
  }
  git pull --ff-only
  if ($LASTEXITCODE -ne 0) { throw 'git pull --ff-only failed.' }
} else {
  New-Item -ItemType Directory -Force (Split-Path -Parent $installDir) | Out-Null
  git clone --single-branch $repoUrl $installDir
  if ($LASTEXITCODE -ne 0) { throw 'git clone failed.' }
  Set-Location -LiteralPath $installDir
}

npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' }
npm run setup -- --yes
if ($LASTEXITCODE -ne 0) { throw 'npm run setup failed.' }
npm run doctor
$doctorExitCode = $LASTEXITCODE
if ($doctorExitCode -ne 0) {
  Write-Warning 'doctor did not complete successfully; confirm that the DSH Host is running, then review the doctor output.'
}
```

- [ ] **Step 2: Add the safety boundary next to the block**

Explain that the block is for Codex, does not start or authenticate DSH, does not create credentials, and does write the intended Codex MCP configuration and repository skill. Explain that DSH login, Host availability, `/mcp`, `/skills`, caller restart/trust, and any real delegation remain separate acceptance steps. Explain that a non-zero doctor result can mean the Host is not running and is not by itself an installation failure.

- [ ] **Step 3: Keep the AI-agent path separate**

Do not merge this block into the compact Agent contract. Human instructions should optimize for visible progress and troubleshooting; Agent instructions should optimize for bounded, low-token execution and explicit acceptance evidence.

### Task 5: Review copy, run validation, and create the local Stage 1 handoff

**Files:**
- Review: all files changed by Tasks 2–4
- Git ref: `refs/backup/post-public-ux-hardening-20260825`

- [ ] **Step 1: Run formatting and repository checks**

```powershell
git diff --check
npm run check
npm pack --dry-run
```

Expected: no whitespace errors, all tests pass, and the tarball does not contain `node_modules/`, generated `.agents/skills/`, credentials, transcripts, or machine-specific paths.

- [ ] **Step 2: Inspect the final diff and tracked file list**

```powershell
git diff --stat
git status --short
git diff -- README.md README.zh-CN.md docs/validation.md test/public-surface.test.ts
```

Expected: only the approved documentation/test scope is changed.

- [ ] **Step 3: Create the post-change backup ref**

After the approved local commit is created:

```powershell
git update-ref refs/backup/post-public-ux-hardening-20260825 HEAD
git show -s --format='%H %s' refs/backup/post-public-ux-hardening-20260825
```

- [ ] **Step 4: Stop for user review before remote write**

Report the commit, changed paths, test results, backup refs, and rollback command. Do not push, open a PR, create a tag, or alter visibility until the user confirms the exact remote target.

---

## Deferred scope after Stage 1

### Task 6: Add non-blocking Codex availability reporting

**Files:**
- Create or modify: `src/codex-detection.ts`
- Modify: `src/setup-codex.ts`
- Test: `test/setup-codex.test.ts`
- Modify: `README.md`, `README.zh-CN.md`, `docs/validation.md`

Define a probe result with `state: "available" | "unavailable" | "unknown"`, optional version, and a human-readable reason. Probe `codex --version` when available and separately report whether the selected config path is readable. Do not make default setup fail solely because the CLI is not on PATH. Add an explicit strict mode only if a later acceptance requirement needs it.

### Task 7: Add an isolated offline MCP smoke command

**Files:**
- Create: `src/smoke.ts`
- Modify: `package.json`
- Test: `test/smoke.test.ts`
- Modify: `README.md`, `README.zh-CN.md`, `docs/validation.md`

Run the built MCP bridge with a disposable temporary `DSH_BRIDGE_HOME`, send only protocol-level initialization and tool-list requests, verify a clean response and shutdown, and never contact a real DSH Host by default. Keep live Host/Codex acceptance as a separately approved operator procedure.

### Task 8: Prepare npm and community metadata only when release work resumes

**Files:**
- Modify: `package.json`
- Review: `CHANGELOG.md`, `SUPPORT.md`, `docs/project-overview.md`, `docs/project-overview.zh-CN.md`
- Optional create: `CODE_OF_CONDUCT.md`

Before any npm publication, decide the privacy-safe author identity, include only intentional documentation in `files`, run `npm pack --dry-run`, and obtain separate approval for registry operations. A missing author field, omitted package documentation, or missing Code of Conduct is not a current public-repository blocker.

### Task 9: Reassess upgrade/uninstall and generic bridge warnings from real usage

**Files:**
- Review: `src/setup-codex.ts`, `src/codex-skill-install.ts`, `src/config.ts`
- Add tests only after a concrete behavior specification exists

Do not add destructive uninstall or broad MCP/bridge scanning without ownership markers, dry-run output, exact-scope guarantees, backup behavior, and a separate approval. Existing explicit `--replace` and `--replace-skill` remain the safe update path.

## Current execution decision

- Stage 1: approved for local implementation.
- Stage 2–Task 9: recorded for later review; not approved for implementation in this batch.
- Remote push: requires a final report and explicit confirmation of the exact remote branch/repository target after local validation.
