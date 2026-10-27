# Codex-DSH-Orchestrator

[![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE) [![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)

**English** | [简体中文](README.zh-CN.md)

Codex-DSH-Orchestrator lets Codex delegate bounded work to DeepSeek Harness (DSH), follow its progress, continue the same session and review the result. Codex keeps planning and final acceptance; DSH handles implementation, code search, refactoring and tests.

## Project boundary

The connect-only MCP server is registered as `dsh_agentlink` and connects to a user-managed DSH Host. Desktop startup, login, permissions and model credentials stay with the user; approvals require human confirmation. It is not a DSH Cordis bundle. Do not install it with `dsh plugin --profile ... add ...`.

This is an independently maintained derivative of [dsh-Agentlink](https://github.com/hootandy321/dsh-Agentlink). The upstream MIT license and attribution are retained in [LICENSE](LICENSE) and [NOTICE](NOTICE). The project is independent of DeepSeek, OpenAI and the upstream maintainers.

## Quick start

Requirements: Node.js 22+, npm, Git, Codex and the official DeepSeek Harness Desktop for your platform. Keep the checkout in a stable tools directory because setup records absolute paths.

| Host path | Setup choice |
| --- | --- |
| Official Desktop on Windows or macOS | `--gateway --desktop-auto --no-preset` |
| Official Gateway at a known origin | `--gateway --host <origin> --no-preset` |
| Legacy rc.6 Web Host or community Windows Desktop | Use the [legacy configuration](docs/manual-configuration.md#legacy-host) |

This `0.1.0-alpha.6` source snapshot includes official Desktop support on Windows and macOS. Both Windows and Apple Silicon Mac completed an inherited read-only task and same-session follow-up. Source CI covers all nine Ubuntu/Windows/macOS and Node 22/24/26 combinations; public CodeQL and the maintainer-author gate also passed. [Validation](docs/validation.md) records the tested builds and remaining limits. Published tags and release artifacts are listed on [Releases](https://github.com/Fly2Kiana/Codex-DSH-Orchestrator/releases).

### Recommended: copy/paste the Agent installation prompt

```text
Install Codex-DSH-Orchestrator from https://github.com/Fly2Kiana/Codex-DSH-Orchestrator
in a stable tools directory I approve. Check Node.js 22+, npm, Git and the selected source revision.
Run npm ci and npm run check. For official Desktop, preview:
npm run setup -- --yes --gateway --desktop-auto --no-preset --dry-run

Show the MCP and Skill targets and any conflicts. For use across projects, choose one user Skill
target; for repository-only use, retain .agents/skills/codex-dsh-orchestrator. Existing legacy
global Skill installations should be updated in place. Ask before --replace or --replace-skill.
Install only the reviewed targets, retain backups, and report any partial installation.

Leave my apps and active tasks running during preparation. Explain the application launch/restart
steps and wait for my downtime approval before authorization handoff. Keep startup authorization
in the private process pipe; do not print it or save it. Do not request provider API keys.

After I restart, verify MCP and Skill loading, then perform connection-only acceptance.
Ask separately before any model request. Report setup, connection and live-task results separately.
```

### Manual setup and verification

Clone a fresh copy on each machine:

```sh
git clone https://github.com/Fly2Kiana/Codex-DSH-Orchestrator.git
cd Codex-DSH-Orchestrator
npm ci
npm run check
```

For official Desktop on Windows or macOS, preview the configuration:

```sh
npm run setup -- --yes --gateway --desktop-auto --no-preset --dry-run
```

The default Skill target is the checkout's `.agents/skills/codex-dsh-orchestrator/`. For access from any project, add `--skill-path "$HOME/.agents/skills/codex-dsh-orchestrator"` to both preview and installation. Existing installations under `~/.codex/skills` can keep their current target; update that copy explicitly and avoid a second copy with the same skill name. These location rules follow the [Codex Skill documentation](https://learn.chatgpt.com/docs/build-skills).

Once the targets are reviewed, run the same setup command without `--dry-run`:

```sh
npm run setup -- --yes --gateway --desktop-auto --no-preset
```

Setup registers the bridge, keeps `approval_mode = "prompt"` for approvals and copies `SKILL.md` plus `agents/openai.yaml`. Conflicting MCP or Skill content requires `--replace` or `--replace-skill`, respectively. Review the conflict first. `--no-skill` opts out of Skill installation. Successful replacements create backups; if only one part succeeds, review the reported state before retrying.

The official Gateway uses a private in-memory authorization handoff from Desktop to a newly launched Codex process. **This step starts Desktop and Codex and requires both apps to be quit first. Finish active work before following the [Windows/macOS startup instructions](docs/official-desktop-gateway.md#operator-startup).** Keep that terminal open during use.

After the controlled launch, check `/mcp` or Settings for `dsh_agentlink`, and use `/skills` or `$codex-dsh-orchestrator` to confirm Skill discovery. A connection-only `dsh_host_status` then checks admission without creating a task or invoking a model. Unlike doctor, this call can exchange authorization and create a Gateway API Peer. Doctor deliberately reports Gateway admission as `not_probed`.

### Portability and rollback

Use a fresh clone on another computer. A linked worktree's `.git` file refers to the original clone and cannot serve as an independent installation.

Keep `DSH_BRIDGE_HOME` on a reliable local filesystem. Compatible bridge processes can share it under the cooperative locking protocol; independently managed or incompatible builds need separate homes. A new home starts fresh mappings, cursors and claims while DSH retains conversation history.

Preserve the old checkout, configuration backup and installed Skill backup during an upgrade. To roll back, first review any later configuration edits, restore the intended MCP block and Skill files, then relaunch the caller at an agreed time. See [Known issues](KNOWN_ISSUES.md) for lock recovery and Windows filesystem limits.

## For AI Agents

Use the focused setup/validation documents and inspect only the relevant non-sensitive configuration. Preserve unrelated MCP servers and Skills. Preparation does not authorize replacing an installation, closing an application or invoking a model.

Report the source revision, build result, installed MCP/Skill targets, caller reload status and connection result. Keep credentials, real session identifiers and personal paths out of public reports. Only the user can approve application downtime, a DSH approval request or publication.

## Use it

In a project with the bridge and Skill loaded:

> 请委派给 DSH 完成这个有明确范围的任务，按当前项目状态交接，并由 Codex 审阅结果。

Use `$codex-dsh-orchestrator` for explicit invocation. The Skill also matches natural-language delegation requests. It builds a compact handoff from progress, Git state, focus files, relevant tests and constraints. DSH reads those focus files first. The bridge does not receive prior caller conversation state automatically.

Continue the same known task with `dsh_followup`. To resume work from a different Codex chat, metadata-only `dsh_find_sessions` must identify one mapped, idle root with the exact canonical workspace; `dsh_attach_session` checks fresh title/cwd/update preconditions before a follow-up. Titles and similar wording are insufficient for reuse. Session reuse may reduce rereads but can increase input tokens; provider cache evidence remains `not_exposed` without documented usage telemetry.

## Model routing

Model routing is opt-in and backward-compatible for both delegation and follow-up.

| Request | Behavior |
| --- | --- |
| Omit routing, or use `inherit` | Verify the session's current route; no model-selection write |
| `flash` / `pro` | Select an advertised official route on the current account/API-key provider |
| `reasoningEffort` | Require that exact effort in the current catalog |
| Visual low complexity | `visualIntent="required"`, `complexity="low"`: select official Flash Vision only with verified image capability |
| Visual high complexity | Ask the user to choose `official-flash-vision` or `modlens-pro` |

Flash recognizes `deepseek-flash` and the legacy `deepseek-v4-flash`; Pro uses `deepseek-v4-pro`. An unavailable Pro is refused, and account/API-key providers stay separate. The bridge reads the Host catalog again after selection. Delegate and follow-up results report `modelRouting.persistsAsDshDefault=true` when selection saves the global default; a verification failure can leave that side effect even though no prompt was sent.

The official rc.3 session catalog omits image modalities, so a Vision display name alone cannot enable native vision. ModLens Flash is reserved for one fallback after the approved visual route exhausts bounded qualifying failures; invalid input, missing models, permissions and configuration errors do not qualify. The prompt write is never replayed. Explicit legacy `modlens-flash` remains accepted when visual-policy fields are omitted.

Routing policy is covered by automated tests. Current native vision, ModLens and fallback provider execution still need live qualification. [Gateway capabilities](docs/official-desktop-gateway.md#models-and-capabilities) describes the exact limits and the legacy Code Mode handoff.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `dsh_host_status` | Connection state and capabilities |
| `dsh_find_sessions` | Bounded root-session metadata discovery |
| `dsh_attach_session` | Attach an exact idle root with fresh preconditions |
| `dsh_delegate` | Create a root and queue its initial prompt |
| `dsh_followup` / `dsh_continue` | Continue that root; queue or steer |
| `dsh_status` | Execution, pending interactions, final answer and workspace claim semantics |
| `dsh_tail` | Bounded event digests and next cursor |
| `dsh_wait` / `dsh_observe` | Bounded observation; one window is at most 30 seconds |
| `dsh_cancel` | Cancel the current turn or observed queue items |
| `dsh_list` | List mapped tasks |
| `dsh_answer_question` | Answer a typed pending question |
| `dsh_resolve_approval` | Human-approved `allow_once` or rejection |
| `dsh_release_workspace` | Release the cooperative claim; leave the DSH session open |

Retain cursors/revisions before mutations. A wait window ending does not end the task; continue observation until a real terminal state or required human action. Workspace claims coordinate bridge users and do not enforce DSH filesystem permissions.

## Caller support

Codex has the canonical orchestration Skill and setup above. Claude Code has a retained project installer:

```sh
npm run setup:claude -- --yes --project /absolute/path/to/project
```

That installer configures the legacy integration; the new official Gateway path has no fresh Claude Code live qualification. ZCode, OpenCode, Workbuddy and Claude Desktop remain deferred. See [Deferred roadmap](docs/deferred-roadmap.md).

## Project components

- `src/`: shared MCP runtime and setup.
- `skill/codex-dsh-orchestrator/`: canonical Codex Skill; edit this source, not an installed copy.
- `skill/codex-dsh/` and `skill/claude-code-dsh/`: compatibility Skills.
- `test/`: synthetic Host, protocol, persistence and install regressions.
- [Project overview](docs/project-overview.md), [Architecture](docs/architecture.md), [Validation](docs/validation.md), [Manual configuration](docs/manual-configuration.md), [Release checklist](docs/release-checklist.md), [Contributing](CONTRIBUTING.md) and [Security](SECURITY.md).

## Related projects

| Project | Relationship |
| --- | --- |
| [DeepSeek Harness](https://www.deepseek.com/harness/en/) / [source](https://github.com/deepseek-ai/deepseek-harness) | Official Desktop and Host runtime |
| [DSH Desktop](https://github.com/anywhere-labs/dsh-desktop) | Community client, retained Windows legacy discovery |
| [ModLens](https://github.com/liustack/modlens) | Optional vision plugin. Not maintained by or affiliated with this project |
| [Model Context Protocol](https://modelcontextprotocol.io/) | Caller-to-bridge protocol |
| [dsh-Agentlink](https://github.com/hootandy321/dsh-Agentlink) | Upstream MIT code and compatibility lineage |

## License

[MIT](LICENSE). Read [Known issues](KNOWN_ISSUES.md) before upgrading a shared bridge home.
