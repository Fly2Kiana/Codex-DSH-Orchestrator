# Manual Codex MCP configuration

**English** | [简体中文](manual-configuration.zh-CN.md)

Prefer setup's preview and replacement checks. Manual configuration is useful when the installer cannot write the selected file or you need explicit environment overrides.

Codex normally uses `~/.codex/config.toml`; an existing `CODEX_HOME` changes that root. Back up the file and preserve unrelated servers. See [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp).

## Build and locate the entry point

```sh
npm ci
npm run build
```

Use the actual absolute Node executable and checkout's `dist/index.js`. On PowerShell, `(Get-Command node).Source` locates Node; on macOS, use `command -v node`. Keep both paths stable.

## Official Desktop on Windows or macOS

```toml
[mcp_servers.dsh_agentlink]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/Codex-DSH-Orchestrator/dist/index.js"]
env_vars = ["DSH_CONNECT_TOKEN", "DSH_CONNECT_ORIGIN"]

[mcp_servers.dsh_agentlink.env]
DSH_HOST_PROTOCOL = "gateway"
DSH_HOST_MODE = "desktop-auto"

[mcp_servers.dsh_agentlink.tools.dsh_resolve_approval]
approval_mode = "prompt"
```

The equivalent installer preview is:

```sh
npm run setup -- --yes --gateway --desktop-auto --no-preset --dry-run
```

Omit static `DSH_HOST_URL`, old version declarations and preset overrides for this setup. The in-memory `DSH_CONNECT_ORIGIN` binds authorization to an OS-owned listener; it is not a static endpoint override. If an explicit URL is configured, runtime selects static mode instead.

Setup forwards authorization variable names. The private startup handoff supplies their values to a new Codex process; use the [operator startup guide](official-desktop-gateway.md#operator-startup). Those steps start apps and require an agreed downtime window. A provider API key does not replace Gateway launch authorization.

For a deliberately static official Gateway, replace `DSH_HOST_MODE` with `DSH_HOST_URL = "http://127.0.0.1:3080"` and use the actual authorized origin. The installer accepts `--gateway --host <origin> --no-preset`.

## Skill scope and reload

The installer copies `skill/codex-dsh-orchestrator/SKILL.md` and `agents/openai.yaml`. Its default is repository scope at `.agents/skills/codex-dsh-orchestrator/`. Choose `--skill-path "$HOME/.agents/skills/codex-dsh-orchestrator"` for a user-wide installation. Existing global installs at `~/.codex/skills` can be updated in place; use one discoverable copy per name.

A conflicting MCP entry requires `--replace`; conflicting Skill content requires `--replace-skill`. Review them separately. The installer checks symlink/non-file targets and creates replacement backups. It can report partial success, so inspect both outputs before retrying.

After editing MCP configuration, reload the caller during an agreed window and confirm `/mcp` or Settings. Confirm Skill discovery separately with `/skills` or explicit `$codex-dsh-orchestrator`. Keep `approval_mode = "prompt"` for `dsh_resolve_approval`.

If `dsh_collab` exists, preview migration with the chosen protocol and review `--replace`; retain one `dsh_agentlink` entry. Preserve backups for rollback and check later edits before restoring them.

## Environment reference

| Variable | Meaning |
| --- | --- |
| `DSH_HOST_PROTOCOL` | `legacy` default, or explicit `gateway` |
| `DSH_HOST_MODE` | `static` default; official `desktop-auto` supports Windows/macOS, legacy discovery supports Windows |
| `DSH_HOST_URL` | Static origin; defaults to loopback port 3080 and overrides auto mode when explicitly set |
| `DSH_CONNECT_TOKEN` | Gateway authorization from the private caller environment; keep its value out of files and prompts |
| `DSH_CONNECT_ORIGIN` | Bound authorization origin, also constrains official automatic discovery |
| `DSH_CONNECT_TOKEN_ENV` | Optional runtime variable-name override; setup uses the standard name |
| `DSH_HOME` | Base home for deriving bridge state, default `~/.dsh` |
| `DSH_BRIDGE_HOME` | Local coordination home, default `~/.dsh/codex-bridge` |
| `DSH_REQUEST_TIMEOUT_MS` | Unary/connect timeout, default 30000 ms; not a task deadline |
| `DSH_BRIDGE_AGENT_PRESET` | Optional composition/preset override; omit to follow DSH |
| `DSH_BRIDGE_TIME_ZONE` | Optional IANA time zone for prompts |
| `DSH_HOST_VERSION` | Optional operator declaration, kept separate from verified product/wire evidence |
| `DSH_APPROVAL_TIMEOUT_MS` | Optional best-effort approval rejection timer while connected, disabled by default; timed questions remain separate |
| `DSH_ALLOW_REMOTE_HOST=true` | Explicit trust for a non-loopback static deployment |

Read-only doctor reports lock structure under the selected home and leaves locks intact. Gateway admission remains `not_probed`; a separately approved `dsh_host_status` can authenticate and open an API Peer.

Routing inherits unless the caller provides policy/profile fields. Selection and effort require current catalog evidence, and explicit selection may persist as the DSH default. Workspace claims coordinate bridge activity; DSH enforces its own filesystem permissions. See [Gateway capabilities](official-desktop-gateway.md#models-and-capabilities).

## Legacy Host

The legacy protocol targets the previously tested DSH CLI `0.1.0-rc.6` Web Host and community Windows Desktop. It is a separate adapter.

```toml
[mcp_servers.dsh_agentlink]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/Codex-DSH-Orchestrator/dist/index.js"]

[mcp_servers.dsh_agentlink.env]
DSH_HOST_PROTOCOL = "legacy"
DSH_HOST_URL = "http://127.0.0.1:3080"

[mcp_servers.dsh_agentlink.tools.dsh_resolve_approval]
approval_mode = "prompt"
```

Static setup requires `dsh --version`; Windows community Desktop can use `npm run setup -- --desktop-auto --no-preset`. That discovery inspects exact `DSH Desktop.exe` owners and verifies loopback candidates with `host.describe`. Official Desktop instead needs `--gateway`.

The legacy rc.6 Web API has no token authentication. Its `host.describe.version` placeholder `0.0.1` is not a package version. Start/login remain operator actions. If you choose to start that legacy CLI Host yourself, `dsh web --host 127.0.0.1 --port 3080` starts it; `npm run doctor` then performs the legacy capability check.

Preserve failed or oversized bridge state for diagnosis; a fresh home starts new mappings/cursors/claims. See [Known issues](../KNOWN_ISSUES.md) before any lock cleanup.

This is not a DSH Cordis bundle. Do not install it with `dsh plugin --profile ... add ...`.
