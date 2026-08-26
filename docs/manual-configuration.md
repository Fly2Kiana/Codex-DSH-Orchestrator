# Manual Codex MCP configuration

**English** | [简体中文](manual-configuration.zh-CN.md)

Use this guide only when the setup wizard cannot edit your Codex configuration or when you need advanced environment overrides.

Codex reads MCP servers from `~/.codex/config.toml` by default, or from `$CODEX_HOME/config.toml` when that environment variable already points to a custom Codex home. Back up the file before editing it. The official [Codex MCP documentation](https://developers.openai.com/codex/mcp) also describes app, CLI, and TOML configuration.

## Build and resolve paths

From the repository:

```bash
npm install
npm run build
command -v node
pwd
```

Use the absolute Node.js path and append `/dist/index.js` to the absolute repository path.

## Add the MCP server

```toml
[mcp_servers.dsh_agentlink]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/dsh-Agentlink/dist/index.js"]

[mcp_servers.dsh_agentlink.env]
DSH_HOST_URL = "http://127.0.0.1:3080"
DSH_HOST_VERSION = "0.1.0-rc.6"
DSH_BRIDGE_AGENT_PRESET = "code"

[mcp_servers.dsh_agentlink.tools.dsh_resolve_approval]
approval_mode = "prompt"
```

For Windows DSH Desktop automatic discovery, replace the `DSH_HOST_URL` line above with the following line; never configure both:

```toml
DSH_HOST_MODE = "desktop-auto"
```

The setup equivalent is `npm run setup -- --desktop-auto`. Updating an existing bridge entry requires reviewed `--replace` approval. Desktop mode can proceed when `dsh` is not on `PATH`; setup then omits `DSH_HOST_VERSION`, capability-probes the running Desktop Host, and reports package-version compatibility as unverified.

Keep `approval_mode = "prompt"`: a DSH approval can authorize a sandbox escalation, so `allow_once` must remain human-gated.

Restart the Codex desktop app, restart the IDE extension, or exit and reopen the CLI after changing the file. Then use `/mcp` or Codex Settings to confirm that `dsh_agentlink` is connected.

If an earlier installation still uses `dsh_collab`, do not keep both entries: run `npm run setup -- --replace` after reviewing the generated block. The setup command removes the legacy tables and writes one `dsh_agentlink` entry while preserving unrelated MCP servers.

## Environment variables

- `DSH_HOST_URL` — official Web Host origin; default `http://127.0.0.1:3080`
- `DSH_HOST_MODE` — `static` (default) or opt-in `desktop-auto` on Windows. `desktop-auto` inspects only listeners owned by an exact `DSH Desktop.exe` process, accepts loopback only, verifies candidates with `host.describe`, and refuses zero or multiple verified Hosts. It does not scan ports or start/stop Desktop. Omit `DSH_HOST_URL` to use it; an explicit URL always selects `static` mode.
- `DSH_HOME` — DSH home used to derive the bridge home; default `~/.dsh`
- `DSH_BRIDGE_HOME` — override for task mappings, workspace claims, and the coordination index
- `DSH_REQUEST_TIMEOUT_MS` — unary and WebSocket-connect timeout; default 30 seconds
- `DSH_BRIDGE_AGENT_PRESET` — optional installed DSH agent preset; omit it to follow DSH's own default. This selects DSH agent composition, not a workspace claim or verified sandbox policy.
- `DSH_BRIDGE_TIME_ZONE` — optional IANA time zone for human prompts
- `DSH_HOST_VERSION` — optional operator-declared DSH package version; never inferred from `host.describe.version`
- `DSH_APPROVAL_TIMEOUT_MS` — disabled by default; enables one best-effort rejection while the current bridge process and connection remain alive
- `DSH_ALLOW_REMOTE_HOST=true` — explicitly opt in to a trusted non-loopback Host

Delegation and follow-up accept only the semantic `inherit|flash|pro|official-flash-vision|modlens-flash|modlens-pro` profiles plus a live-catalog-supported reasoning effort; arbitrary provider/model strings are rejected. Omitting routing inherits and verifies DSH's current route. Explicit selection can persist as the DSH global default. For visual work, declare `visualIntent=required` with `complexity=low|high`: low complexity uses the official native Flash Vision; high complexity requires an explicit user choice between `official-flash-vision` and `modlens-pro`. Only the visual route selection/verification stage may retry, and only for timeout, unreachable Host, or HTTP 5xx; after those bounded retries, ModLens Flash is attempted once and disclosed at task end. Invalid input, missing models, protocol/configuration errors, and permission or credential refusals do not trigger fallback. If the visual policy fields are omitted, an explicitly supplied legacy `modlens-flash` profile remains accepted for compatibility; it is not the default visual route. `workspaceMode` is a bridge-local cooperative claim only; it does not select, enforce, or verify the DSH Host filesystem sandbox.

## Host and version notes

The bridge is connect-only: it never starts, daemonizes, stops, or owns `dsh web`. Start the Host yourself:

```bash
dsh web --host 127.0.0.1 --port 3080
npm run doctor
```

DSH CLI `0.1.0-rc.6` is the current tested target. In rc.6, `host.describe.version` reports the placeholder product value `0.0.1`; it is not the CLI/package version. Doctor checks the CLI version and probes Host capabilities separately. It also reports the bridge's fail-closed lock locations under `DSH_BRIDGE_HOME` (`claims/registry.lock` and `ledgers/<task>/events.lock`) read-only and never cleans them. Lock diagnostics expose only structural presence/type and bounded `entriesObserved`/`entriesTruncated` observations; they never read `owner.json` content or report pid, token, or `createdAt`.

The ingestion fix does not compact an existing 5 MB+ ledger. Preserve the old bridge home for inspection. If necessary, configure a separate `DSH_BRIDGE_HOME` for new delegations, understanding that bridge task ids, cursors, and claims begin fresh there. DSH `session.history` remains the authoritative conversation record. There is intentionally no automatic ledger or lock cleanup command.

The rc.6 Web API has no auth token. Loopback-only is the safe default. A remote URL must be an explicitly trusted deployment and requires `DSH_ALLOW_REMOTE_HOST=true`.

dsh-Agentlink is not a DSH Cordis bundle. Do not install it with `dsh plugin --profile ... add ...`.
