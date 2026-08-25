# Codex-DSH-Orchestrator

[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE) [![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/) [![DSH bridge](https://img.shields.io/badge/DSH-bridge-4B6BFB?style=flat-square)](https://www.deepseek.com/harness/en/)

**English** | [简体中文](README.zh-CN.md)

Codex-DSH-Orchestrator is a Codex-first orchestration layer and caller-side MCP bridge for bounded collaboration with DeepSeek Harness (DSH). It lets Codex hand off implementation, research, debugging, and long-log analysis to DSH, while keeping those sessions visible and allowing Codex to observe, continue, or cancel them in the same workflow. Claude Code is also supported through the shared caller-integration layer; ZCode, OpenCode, and Workbuddy remain deferred or unverified until their host behavior is validated.

The shared bridge runtime in this repository is an independently maintained derivative of the upstream [dsh-Agentlink project](https://github.com/hootandy321/dsh-Agentlink). The project retains the upstream MIT license and copyright attribution and is not affiliated with or endorsed by DeepSeek, OpenAI, or the upstream maintainers.

## Project boundary

Codex-DSH-Orchestrator is a caller-side orchestration and MCP bridge project. It connects supported callers to an independently running DSH Web Host; it does not start, own, or authenticate that Host, and it never auto-approves DSH requests. It is not a DSH Cordis bundle.

## Quick start

**Prerequisites**

- Node.js 22+ (x64 Node 22 or 24 is the tested baseline; other majors and ARM64 are not covered)
- A supported caller: Codex, or Claude Code 2.1.199+
- A user-managed DSH Host path: the official DSH CLI/Web Host, or an already-running Windows DSH Desktop Host when using the explicit `--desktop-auto` mode

### Recommended: copy/paste the Agent installation prompt

The prompt below asks an AI agent to perform the local installation while keeping Host, credentials, trust, and replacement decisions human-controlled. It is a request template, not additional permission.

```text
Install Codex-DSH-Orchestrator from https://github.com/Fly2Kiana/Codex-DSH-Orchestrator.
Work only in a repository directory I approve. Read the README and the focused validation/setup
instructions first; do not read credentials, private caller configuration, .env files, raw sessions,
logs, or DSH bridge state. Check Node.js 22+ and report whether the DSH CLI or an already-running
DSH Desktop Host is available. Do not start, stop, log in to, or reconfigure DSH for me.

Clone the repository, run npm ci, then run npm run check. For Codex, run npm run setup -- --yes
from the repository root. This installs the MCP entry and the shipped Codex skill into
.agents/skills/codex-dsh-orchestrator by default. If either existing MCP or skill files conflict,
stop, show the conflict without exposing secrets, and ask before using --replace or --replace-skill.
Use --no-skill only when I explicitly choose to manage the skill myself. For Claude Code, run
npm run setup:claude -- --yes --project /absolute/path/to/my/project and review --replace/--replace-skill
conflicts first.

Report separately: dependency/build checks, MCP registration, Codex skill path and exact files,
caller restart/trust still needed, and DSH Host reachability. Do not claim end-to-end success from
a successful setup exit code alone. Never start or stop DSH, approve requests, publish packages, or
write GitHub changes without my separate approval.
```

### Quick install with PowerShell

To install the Codex integration on Windows, open PowerShell, paste the script below, and press Enter. Unless you change `$installDir`, it uses `%USERPROFILE%\Tools\Codex-DSH-Orchestrator`.

The script will:

- clone the repository, or fast-forward an existing clean checkout;
- install dependencies with `npm ci` and build the bridge;
- run `npm run setup -- --yes` to write the Codex MCP entry and the repository skill;
- finish with the read-only `npm run doctor` check.

The script performs setup on your machine. The only network operations are fetching the repository and npm dependencies. It does not start, stop, log in to, or reconfigure DSH, and it creates no credentials. If setup finds existing MCP or skill files that would be overwritten, it stops instead of replacing them silently; review the reported files, then re-run setup with `--replace` or `--replace-skill` only when you decide the replacement is safe.

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

This installs the Codex integration. For Claude Code, use the separate `setup:claude` flow in the manual setup section below. Keep the checkout in a stable directory because setup records absolute paths in the caller configuration.

After the script finishes:

1. Start or open the DSH Host yourself if it is not already running.
2. Restart Codex and confirm `dsh_agentlink` through `/mcp` or Settings.
3. Use `/skills` and `$codex-dsh-orchestrator` to confirm that the skill was discovered.
4. If `doctor` warned because no Host was running, start the Host and run `npm run doctor` again.

A clean script exit means that the local installation steps completed. It does not by itself prove DSH login or trust, caller permissions, provider access, or a real delegation.

### Manual setup and verification

1. Start or open the DSH Host yourself. The bridge never starts, stops, or logs in to DSH Desktop/Web Host.

2. Clone the repository and install reproducible dependencies:

   ```bash
   git clone https://github.com/Fly2Kiana/Codex-DSH-Orchestrator.git
   cd Codex-DSH-Orchestrator
   npm ci
   ```

3. Configure a caller.

   For Codex, run from the repository root:

   ```bash
   npm run setup
   npm run doctor
   ```

   `npm run setup` builds the bridge, writes the Codex MCP entry with `approval_mode = "prompt"`, and installs the two shipped skill files into `.agents/skills/codex-dsh-orchestrator/`: `SKILL.md` and `agents/openai.yaml`. It creates backups when replacing existing files and never overwrites a different skill without `--replace-skill`. Use `--no-skill` only to opt out, or `--skill-path <directory>` to choose an explicit target. Restart Codex, confirm `dsh_agentlink` through `/mcp` or Settings, then use `/skills` and `$codex-dsh-orchestrator` to verify discovery. A successful setup does not prove DSH login, permissions, trust, or end-to-end execution.

   On Windows with DSH Desktop's changing loopback port, select automatic discovery explicitly:

   ```bash
   npm run setup -- --desktop-auto
   ```

   Static setup requires `dsh --version`; `--desktop-auto` can use an already-running verified Desktop Host when the CLI is not on `PATH`. It never starts or stops DSH Desktop. For fully manual TOML setup, see [Manual Codex MCP configuration](docs/manual-configuration.md).

   For Claude Code 2.1.199 or newer, point setup at the project that should share `.mcp.json`:

   ```bash
   npm run setup:claude -- --project /absolute/path/to/your/project
   cd /absolute/path/to/your/project
   claude mcp get dsh_agentlink
   ```

   Claude setup edits only that project's `.mcp.json` and `.claude/skills/claude-code-dsh/SKILL.md`, preserving unrelated servers. Open Claude Code in the project and approve the pending server through `/mcp`; the bridge marks `dsh_resolve_approval` as requiring human interaction.

   Review existing files before `--replace` or `--replace-skill`. Both setup commands recognize the legacy `dsh_collab` entry and migrate it only after explicit replacement approval. Neither installer changes DSH permission/sandbox settings or restarts the caller.

4. Interpret the result conservatively:

   | Check | Setup can establish | Still requires a human or external check |
   |---|---|---|
   | Dependencies/build | `npm ci` and the local build/tests | Registry access and OS/runtime choices |
   | MCP registration | Exact config block, atomic write, and backup | Caller restart, trust, and live `/mcp` connection |
   | Codex skill | Exact `SKILL.md` and `agents/openai.yaml` under `.agents/skills/` | Restart Codex and confirm `/skills` discovery |
   | DSH operation | Read-only Host/CLI probe when available | DSH start/login, permissions, provider access, and real delegation |

### Portability and installation boundaries

- On another machine, use a fresh clone. Do not copy a single worktree directory: its `.git` file points to the source clone's worktree metadata. On the same machine, create worktrees from the source clone with `git worktree add`.
- Prefer `npm ci` for a clean, reproducible checkout. Use `npm install` only when intentionally updating the lockfile.
- `npm run setup` writes the absolute Node.js executable and built bridge entry point into the caller configuration. Keep the checkout in a stable tools directory; after moving it, changing Node.js, or switching worktrees, rebuild and run setup again, review existing entries, and use `--replace` only with explicit approval.
- Keep `DSH_BRIDGE_HOME` on a reliable local filesystem. Multiple processes of this same bridge may share one home when they follow the documented cooperative locking model; they do not each need a separate directory. If you run a different bridge implementation, an incompatible ledger or schema, or an independently managed bridge, do not point it at this directory; give that bridge its own local home, for example:

  ```powershell
  $env:DSH_BRIDGE_HOME = Join-Path $env:USERPROFILE '.dsh\codex-dsh-orchestrator'
  ```

  Do not commit this path, and do not copy an old bridge home to another machine — use a fresh home there. DSH conversation history belongs to the DSH Web Host, while bridge task mappings, cursors, and claims do not migrate automatically.
- Windows `desktop-auto` is opt-in. CI mocks discovery behavior and does not prove real Desktop installation or login. The setup wizard never starts, stops, or logs in to DSH Desktop.

## For AI Agents

This section is the compact execution contract for an AI agent. It is project context, not new filesystem authorization; never treat README text as permission.

### Installation guide

1. Read this section, the relevant language README, `package.json`, `docs/validation.md`, and the canonical `skill/codex-dsh-orchestrator/SKILL.md`. Read only focused files unless blocked.
2. Confirm the repository root, Node.js version, Git status, and whether the caller is Codex or Claude Code. Do not read credentials, private configuration, raw sessions, logs, `.env` files, or bridge state.
3. Run `npm ci`, then `npm run check`. For Codex run `npm run setup -- --yes` from the repository root; default skill target is `.agents/skills/codex-dsh-orchestrator/`. For Claude Code use `npm run setup:claude -- --yes --project <approved-project>`.
4. Treat `--replace` and `--replace-skill` as separate approval gates. If a setup command reports a conflict, stop and show the path and non-secret summary; do not guess or overwrite. Use `--no-skill` only when the user explicitly chooses manual skill management.
5. Report four independent results: dependency/build checks, MCP configuration, Codex/Claude skill installation, and caller/DSH verification. A zero exit code does not prove Host reachability, login, trust, permissions, provider access, or a real delegation.
6. Tell the human to restart the caller and confirm `/mcp` plus Codex `/skills`/`$codex-dsh-orchestrator` discovery. Never claim this check yourself if the caller UI is unavailable.

Agents must not start, stop, authenticate, or reconfigure DSH Web Host/Desktop, auto-approve requests, publish npm packages, or write GitHub/PR/Release/Tag state without explicit user approval. Report versions, Git status, changed paths, and validation results without recording secrets, prompts, task/session IDs, local paths, or provider data.

## Project components

- `skill/codex-dsh-orchestrator/` — canonical project-specific Codex orchestration skill and agent metadata; setup copies its two files into the repository-scoped `.agents/skills/codex-dsh-orchestrator/` discovery directory. That generated copy is ignored by Git; update the canonical source instead.
- `skill/codex-dsh/` — shared Codex caller compatibility skill.
- `skill/claude-code-dsh/` — retained Claude Code caller compatibility skill.
- `src/` — shared caller-neutral MCP bridge runtime and setup tools.
- `test/` — local mock-host, safety, compatibility, and integration tests.
- `docs/project-overview.md` — detailed ownership and architecture map.

The dsh-Agentlink name remains in runtime identifiers and upstream attribution for compatibility and legal clarity; it is not the public project title.

## Caller support

| Caller | Status | Setup or availability |
|---|---|---|
| Codex | ✅ Supported | `npm run setup` (MCP + repository skill) |
| Claude Code | ✅ Supported | `npm run setup:claude -- --project /absolute/path/to/project` |
| ZCode | ⏸ Deferred | First candidate when verified caller-expansion work resumes |
| OpenCode | ⏳ Planned | Not available yet |
| Workbuddy | ⏳ Planned | Not available yet |

Only callers marked **Supported** have an installation path in this repository today. Planned entries are directions, not release commitments.

The doctor reports the bridge's fail-closed lock locations under `DSH_BRIDGE_HOME` read-only and never cleans them, so it is safe to run even when a lock is present.

This source patch stops new projection/chunk floods from expanding the coordination ledger, but it does not compact an existing 5 MB+ ledger. Preserve the old bridge home for inspection; new delegations can use another independent `DSH_BRIDGE_HOME` when isolation is needed. DSH `session.history`, not the bridge ledger, remains the conversation source of truth. See [Known issues](KNOWN_ISSUES.md) for the conservative recovery boundary.

This bridge (runtime name `dsh_agentlink`) is a caller-side plugin, not a DSH Cordis bundle. Do not install it with `dsh plugin --profile ... add ...`.

## Why Codex-DSH-Orchestrator?

### Use DSH's Harness capabilities

DSH combines persistent sessions, tool execution, subagents, and human supervision for complex work. Codex-DSH-Orchestrator lets your primary caller—currently Codex or Claude Code—discuss and coordinate with that second harness while you stay in the same workflow.

### More than another native subagent

A native subagent remains inside the caller's own agent tree. The shared bridge adds a separate, user-configured harness: its sessions stay visible in DSH Web, can use DSH's own workers and model route, and can be observed, continued, or canceled by the primary caller.

### Save time and cost

- **Save time.** Route implementation, research, extraction, and long-log work to a fast model configured in DSH, such as a DeepSeek V4 route, while your primary agent keeps planning and validating.
- **Save money.** Moving execution-heavy workloads to a lower-cost DeepSeek route can reduce consumption on more expensive primary models.

Actual speed and cost depend on the selected model, provider, deployment, network, and task. Once installed, you can keep working in Codex or Claude Code as usual and simply ask it to delegate when DSH is the better execution path.

## Use it

Once `dsh web` is running and your caller has loaded and trusted the MCP configuration, ask Codex or Claude Code in normal language, for example:

> Use Codex-DSH-Orchestrator to delegate this implementation to DSH in the current repository. Keep it visible in DSH Web, report progress, and ask me before any approval.

The caller can then delegate the task, observe its event stream, continue the same session, answer questions with you, or cancel work. Open the configured DSH Web origin to inspect and interact with the same session. On Windows, an opt-in `DSH_HOST_MODE=desktop-auto` runtime can discover the verified loopback listener owned by DSH Desktop instead of relying on its changing ephemeral port; an explicit `DSH_HOST_URL` always wins.

Before a new delegation, the caller builds a compact handoff in the prompt from already-known progress and read-only workspace evidence: objective, completed work, Git HEAD/status and changed paths when available, focus code/Markdown paths, relevant tests, constraints, and unresolved issues. It tells DSH to read the focus paths first and avoid a repository-wide scan unless blocked. The handoff excludes secrets, raw large diffs, file bodies, caller chat, and internal reasoning. This is guidance for the caller, not new filesystem authorization; dsh-Agentlink does not receive prior caller conversation state automatically. For the same known BridgeTask, the caller uses `dsh_followup`; if no matching task id is known, it starts a fresh delegation rather than guessing an old id.

When the user explicitly identifies an existing DSH Desktop session, the caller can first use `dsh_find_sessions` to read bounded root-session metadata, then use `dsh_attach_session` with the exact returned session id and fresh metadata preconditions. Titles are discovery aids, never attachment identities. Attachment accepts only an idle root session, creates or reuses bridge-local mapping and workspace-claim state, and may reconcile history for supervision without returning or persisting conversation bodies. It does not create or rename a DSH session, send a prompt, or change model routing. A later `dsh_followup` carries the compact handoff when work should continue.

Reusing a session across Codex tasks is a conservative three-way choice: `same-known-task`, `attached-existing-task`, or `new-session`. Reuse only the same known BridgeTask for the same workstream; for a new task with explicit continuation evidence, discover exactly one canonical-cwd, mapped, idle root through metadata-only `dsh_find_sessions` and attach with fresh preconditions before continuing with `dsh_followup`. Never reuse by title or similarity and never read history for discovery; fail closed on ambiguous, running, stale, missing-cwd, or mapping-conflict candidates. Reuse can save handoff and repository-reading work but can increase input tokens, so it is a cost optimization only while continuity remains relevant. Reuse and avoided rescans are not proof of provider prompt-cache hits or token discounts; provider cache evidence is not exposed unless DSH publishes documented aggregate usage telemetry.

## MCP tools

- `dsh_host_status` — connect-only Host state and capabilities
- `dsh_find_sessions` — bounded metadata-only discovery of existing root sessions; no history or raw projections
- `dsh_attach_session` — safely attach one exact idle root session using fresh id/title/cwd/update preconditions; no prompt or model change
- `dsh_delegate` — create a root session and queue the initial prompt; optionally select `inherit|flash|pro|modlens-flash|modlens-pro` plus a catalog-supported `reasoningEffort`; detached by default (`waitSeconds=0`); `workspaceMode` is a bridge-local claim, not a DSH sandbox selector
- `dsh_followup` — continue the same root session with explicit `mode="queue"|"steer"` (default `queue`); optionally select the same semantic model profiles and validated reasoning effort before the prompt
- `dsh_continue` — compatibility alias for `dsh_followup`
- `dsh_status` — availability, execution, lineage, queue, pending interactions, final message, cursors, and workspace claim semantics
- `dsh_tail` — bounded event digests using a bridge task cursor
- `dsh_wait` — wait up to 30 seconds for a durable event, state change, pending interaction, or terminal status
- `dsh_observe` — compatibility alias around `dsh_wait`; bridge cursors replace raw session seq cursors
- `dsh_cancel` — `scope="turn"|"queue"`
- `dsh_list` — task mappings enriched with current derived status
- `dsh_answer_question` — typed answer for a pending question rpcId
- `dsh_resolve_approval` — typed `allow_once|reject` response for a pending approval rpcId
- `dsh_release_workspace` — explicitly release a persistent bridge workspace claim without closing the DSH session

Model routing is opt-in and backward-compatible for both delegation and follow-up. When `modelProfile` and `reasoningEffort` are omitted, the operation reads `session.models.current`, verifies `routable`, and does not call `session.selectModel`. The semantic mappings are `flash`/`pro` -> `deepseek-official/deepseek-v4-{flash,pro}` and `modlens-flash`/`modlens-pro` -> `deepseek-modlens/deepseek-v4-{flash,pro}`. The requested provider, model, and effort must exist in the live `session.models` catalog. Selection is performed and re-read before the initial or follow-up prompt; any mismatch fails closed without sending that prompt.

An explicit user choice always wins. Without one, the primary caller may keep `inherit`, use Flash for routine search/implementation/test repair, use Pro for architecture or difficult multi-step debugging, and use the corresponding ModLens profile when visual evidence is essential. dsh-Agentlink transports text prompts only: include absolute local image paths that the DSH Host and ModLens tools can access; it does not upload image bytes. `selectionReason` provides an optional audit explanation and is not sent to DSH.

On the locally verified DSH rc.6 collapsed Code Mode path, visual handoffs use the outer `run_code` transport and call registered `modlens_read_image` through the injected `tools` SDK inside that program. A caller should treat that outer event as expected, forbid shell/browser/OCR/image-library fallbacks, and wait for the nested result or an explicit nested/terminal error. A plugin's documented inner timeout is not the overall delegation deadline. This is version-scoped compatibility guidance; later Hosts should follow their verified live capability when it differs.

**Important DSH rc.6 side effect:** `session.selectModel` also saves the selection as DSH's global default for later sessions. Delegate and follow-up results report `modelRouting.persistsAsDshDefault=true` and a warning whenever explicit selection occurs. Omit routing fields if that persistence is not acceptable. If selection verification fails after the write was attempted, no prompt is sent, but the requested selection may already be the global default.

`dsh_wait` observes durable bridge state. Assistant delta/chunk frames and top-level `session/projection` snapshots are skipped, so they do not bump the task revision or wake waiters; complete final messages remain observable through status/tail after the turn ends.

## Roadmap

These are planned directions, not implemented capabilities or release commitments.

1. **More caller entrypoints** — evaluate ZCode first when caller expansion resumes, then consider OpenCode, Workbuddy, Claude Desktop MCP, and other callers through the shared Integration Pack architecture.
2. **Agent invocation and information transport** — improve prompt organization, context packaging, output digests, and compression while keeping questions, approvals, errors, and final answers reliable.
3. **DSH plugin-aware sessions** — preserve the current `agentPreset` path for preset-based plugins, add read-only preset/capability validation and resolved-preset reporting, and introduce a declarative session launch profile only when a plugin proves it needs typed post-create initialization.
4. **More integrations** — expand after the shared Runtime and caller compatibility contract stabilize.

## More documentation

- [Project overview](docs/project-overview.md) — public identity, component ownership, and the Codex-first architecture
- [Architecture and safety model](docs/architecture.md) — identity, state, recovery, approvals, cancellation, and workspace coordination
- [Multi-caller extension architecture](docs/caller-integration-architecture.md) — shared Runtime and Integration Pack boundaries for Codex, Claude Code, and future callers
- [Deferred roadmap](docs/deferred-roadmap.md) — deliberately postponed work, activation triggers, and preserved safety boundaries
- [Validation guide](docs/validation.md) — compatibility and operator acceptance checks
- [Known issues](KNOWN_ISSUES.md) — current upgrade and concurrency caveats
- [Contributing](CONTRIBUTING.md) and [security](SECURITY.md)

## Related projects

| Project or standard | Relationship |
|---|---|
| **Codex-DSH-Orchestrator** | This project — a Codex-first caller-side MCP bridge; runtime name `dsh_agentlink` |
| [Codex](https://openai.com/index/introducing-the-codex-app/) / [Claude Code MCP](https://code.claude.com/docs/en/mcp) | Supported callers |
| [DeepSeek Harness](https://www.deepseek.com/harness/en/) / [source repository](https://github.com/deepseek-ai/deepseek-harness) | The separately managed DSH Host ecosystem this bridge connects to |
| DSH Desktop | A separately managed community DSH host that runs the upstream Web Host; its exact upstream repository is not identified by this project, so no repository link is guessed |
| [Model Context Protocol](https://modelcontextprotocol.io/) | Protocol foundation used by the bridge |
| [dsh-Agentlink](https://github.com/hootandy321/dsh-Agentlink) | Upstream project and compatibility lineage; MIT license and NOTICE attribution are retained |

These links describe the projects and standards this repository integrates with or derives from; they do not imply a joint project, endorsement, or shared security boundary. Architecture references such as `cc-connect`, `gpt2agent`, `Scryer`, `wshobson/agents`, `agent-harness`, and ACP are documented as references, not dependencies, partners, or supported callers.

## License

[MIT](LICENSE)

Alpha note: DSH is still in developer preview, and this community project is independent of DeepSeek and OpenAI. The shared-ledger concurrency bug in `0.1.0-alpha.1` was fixed in `0.1.0-alpha.2`. Read [Known issues](KNOWN_ISSUES.md) before upgrading or running concurrent bridge processes.
