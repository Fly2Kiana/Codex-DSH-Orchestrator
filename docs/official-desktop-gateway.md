# Official Desktop Gateway

The official DeepSeek Harness Desktop uses the authenticated Gateway adapter. Select it with `--gateway`. The legacy rc.6 adapter remains the setup default; protocols are selected explicitly.

The wire reference is `dsh-v0.2.1-rc.2` (`687f282`). The rc.3 source review found the scoped Connection/Gateway contracts unchanged and added synthetic model-catalog regressions. See [Validation](validation.md) for automated and live evidence.

## Install and preview

Build an approved checkout, then preview:

```sh
npm ci
npm run check
npm run setup -- --yes --gateway --desktop-auto --no-preset --dry-run
```

Official `--desktop-auto` works on Windows and macOS. A known origin can instead use `--gateway --host <origin>`. Gateway setup can proceed without a DSH CLI on PATH.

Choose one Skill scope: the default is `.agents/skills/codex-dsh-orchestrator` in the checkout. Use `--skill-path <directory>` for a user-wide install or to update an existing global copy. Review MCP and Skill conflicts before adding `--replace` or `--replace-skill`. Apply the reviewed command without `--dry-run`; retain its backups.

Setup records the selected Node executable and `dist/index.js`. Its Gateway block contains:

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

`env_vars` forwards names from Codex's process environment. Token values stay out of TOML. `--no-preset` follows DSH's default composition rather than adding the installer's legacy preset override. Preserve unrelated MCP entries.

## Operator startup

**The commands in this section start Desktop and Codex. First finish active work and quit both apps normally.** Run from a separate Terminal or PowerShell window, not from inside Codex. The helper refuses a caller that is already running; it cannot refresh an existing GUI process's environment.

Use the Node executable recorded by setup, the approved repository, and the actual trusted caller executable. On macOS this is the binary inside `.app/Contents/MacOS/`; the bundle directory and `open -a` are unsuitable. Some Codex installations use the `ChatGPT.app` bundle name shown below.

The examples feed Desktop stdout directly to the existing `authorized-caller.js` helper. Edit the paths before use. Keep startup output private: do not use `tee`, save a startup log, paste an authorization URL or expose Desktop stderr.

### Windows PowerShell

Use the bundled launcher below. It checks file paths, running apps and launch flags, then invokes a native batch pipe. Windows PowerShell 5.1 can buffer a direct PowerShell data pipeline until Desktop exits, leaving Codex unopened.

Select the actual Codex GUI binary, which may be named `ChatGPT.exe` in the installed app package. A `codex.exe` on PATH may be the CLI instead. Recheck the GUI path after app updates.

```powershell
$bridgeRepo = Join-Path $HOME 'Tools/Codex-DSH-Orchestrator'
& "$bridgeRepo/docs/operator-tools/windows/launch-official-desktop.ps1" `
  -BridgeRepository $bridgeRepo `
  -NodePath 'C:/Program Files/nodejs/node.exe' `
  -DesktopExecutable (Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/DeepSeek Harness.exe') `
  -CallerExecutable 'C:/path/to/installed/app/ChatGPT.exe'
```

The launcher starts both apps but never stops a running app. It keeps Desktop stdout in the native pipe and prints only fixed handoff outcomes. `caller_launch_requested` means the helper launched the selected executable; verify the GUI and connection separately. On failure, report the fixed error and leave the terminal open. Do not run the batch file directly or pipe the launcher through PowerShell output commands.

### macOS Terminal

The subshell clears launch/debug flags for its children only. The OS check uses the repository's existing process-inspection helper.

```sh
(
  bridge_repo="$HOME/Tools/Codex-DSH-Orchestrator"
  bridge_node="/usr/local/bin/node"
  desktop_exe="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
  caller_exe="/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"

  unset ELECTRON_RUN_AS_NODE ELECTRON_NO_ASAR NODE_OPTIONS NODE_PATH \
    NODE_V8_COVERAGE NODE_REDIRECT_WARNINGS ELECTRON_ENABLE_LOGGING \
    ELECTRON_LOG_FILE ELECTRON_ENABLE_STACK_DUMPING

  if [ -x "$bridge_node" ] && [ -x "$desktop_exe" ] && [ -x "$caller_exe" ] &&
    [ -f "$bridge_repo/dist/authorized-caller.js" ] &&
    "$bridge_node" --input-type=module - "$bridge_repo" "$desktop_exe" "$caller_exe" >/dev/null 2>&1 <<'NODE'
import { pathToFileURL } from 'node:url';
const { macosCallerIsRunning } = await import(
  pathToFileURL(process.argv[2] + '/dist/macos-process-inspection.js').href
);
for (const executable of process.argv.slice(3)) {
  if (await macosCallerIsRunning(executable)) process.exit(1);
}
NODE
  then
    "$desktop_exe" </dev/null 2>/dev/null |
      "$bridge_node" "$bridge_repo/dist/authorized-caller.js" \
        --caller "$caller_exe" >/dev/null 2>&1
  else
    printf '%s\n' 'Not started: check paths and finish any running Codex/DeepSeek Harness work.'
  fi
)
```

Keep the startup terminal open while using the integration. Closing it or pressing Ctrl+C can interrupt the pipeline or its applications. If Codex fails to open, stop and report the symptom; repeated launches can leave extra instances. A Host restart requires a fresh handoff and a newly launched caller.

The helper has an inert `--help` command. It only launches the selected caller after receiving valid startup authorization; Desktop is launched by the operator's pipeline. Caller stdin is isolated from that startup stream.

## Check loading and connection

After the controlled launch:

1. Confirm `dsh_agentlink` in `/mcp` or Settings and the intended `dist/index.js` path.
2. Confirm `codex-dsh-orchestrator` in the Skill selector or through explicit invocation.
3. With connection approval, call `dsh_host_status` once. It can perform `/connect` and establish an API Peer, but sends no model request.
4. Expect `availability=connected`, `reachable=true` and successful connection/resolution epochs. Keep endpoint details private.

`npm run doctor` checks configuration and lock structure without Gateway admission; `not_probed` is expected there. A model task is a separate acceptance step using `inherit` in a disposable workspace.

## Authorization and discovery

The supported startup input is one official loopback HTTP-root announcement with a 32-byte base64url token. Capture is bounded to 256 KiB total, 8 KiB per line and 90 seconds. A handoff is single-use; source closure or cancellation revokes an unused handoff.

Only the newly launched caller receives `DSH_CONNECT_TOKEN`, bound `DSH_CONNECT_ORIGIN` and the token input-variable name. Parent/system environment settings remain unchanged. Select a trusted caller and plugins: its process environment contains authorization.

`DSH_CONNECT_ORIGIN` binds authorization to an OS-confirmed owned loopback listener. It is not a static Host setting. With multiple listeners, only an exact binding can select the intended origin; an absent binding leaves ambiguity unresolved. IPv4 and IPv6 origins are distinct.

Windows discovery selects exact `DeepSeek Harness` processes and owned loopback listeners. macOS selects the packaged `DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness` binary, including user-installed or translocated locations; it uses `/bin/ps` metadata and PID-restricted `/usr/sbin/lsof` queries. Neither path scans arbitrary ports. Executable-path matching does not verify an app signature.

Admission validates the same-origin Mux redirect and authority-bound API cookie, then owns one API socket. Cookies stay in memory. Missing/rejected authorization, unsupported framing and Peer conflicts stop that attempt; network observation can reconnect, but mutation writes are not replayed after uncertain outcomes.

## Connection diagnostics

Use the returned fixed `connection.diagnostic.stage` and `reason`. These distinguish process/listener inspection, candidate selection, authorization binding, HTTP admission and WebSocket opening without printing native command output or authorization.

`host_unreachable` can occur before a network request. An inspection failure is not evidence that no process exists. For `ambiguous_desktop_host`, preserve the current processes and inspect sanitized counts/binding; do not kill an instance or substitute a guessed port. After a new connection or unrelated failure, the previous diagnostic is cleared.

The helper's Windows caller queries have a 30-second bound; macOS queries use a 10-second bound. Failed inspection refuses launch. Timeout or cancellation does not authorize app termination.

## Models and capabilities

- Session route inspection uses `session/modelCatalog` plus the exact `modelSelection` projection. Only an explicitly empty selection permits inheriting the global default; missing projection data is refused.
- Flash recognizes current `deepseek-flash` and legacy `deepseek-v4-flash`; Pro requires its own advertised `deepseek-v4-pro`. Account/API-key boundaries and advertised reasoning efforts are checked on every selection, then re-read before prompting.
- rc.3 can change model availability through provider listing, cache and client-version gates. The bridge follows the Host catalog; it does not bypass `CLIENT_UPGRADE_REQUIRED` or `MODEL_UNSUPPORTED`. Synthetic rejection tests prove no selection/prompt replay or ModLens switch.
- Explicit selection persists the selection as DSH's global default. Use `inherit` for an installation smoke.
- The scoped rc.3 session catalog omits image modalities. Native vision requires trustworthy exact-route image evidence. The legacy exception is limited to `deepseek-official/deepseek-v4-flash-vision-exp` and an explicit text-only declaration overrides it.
- rc.3 provider source includes `discoverModels` callbacks, but callback presence does not establish an authenticated `llm/discoverModels` wire capability. The bridge continues to use session metadata.
- Pending queues come from the mapped root's exact follow snapshot: `next-turn` is queued and `next-step` is steering. Invalid, missing, duplicate or mismatched-cut data makes the queue unknown. Queue removal is non-atomic, and already-claimed items are reported separately.
- Ordinary questions/approvals are scoped to mapped roots and the current event generation. Human replies are sent at most once; timed question ownership stays with the Host. Subagent-mode discovery remains unavailable. Settled/cancelled interactions cannot be replayed within the same bounded generation.
- History uses the verified follow cut and durable prompt `requestId`. Ending observation leaves the DSH task running. Queue bodies and conversation content are not stored in the coordination ledger.

### Visual and legacy Code Mode

The visual policy uses official Flash Vision for low complexity when capability is verified; high complexity asks the user to choose that route or ModLens Pro. ModLens Flash is attempted once after the approved route's bounded qualifying failures. Invalid input, missing models, permissions, credentials, configuration and prompt-write errors do not trigger fallback. Show the result's short fallback notice at task end.

The bridge carries text and DSH-accessible local image paths. On the previously verified legacy rc.6 collapsed Code Mode path, the ModLens handoff calls `run_code`, then `tools.modlens_read_image` inside the injected SDK. Keep the work on that verified tool path and wait for its nested result or explicit error. Its inner timeout does not set the overall task deadline. Other Hosts follow their verified tool contract. Current official native vision/ModLens execution remains unqualified.

## Validation and rollback

Runtime candidate `85fd145` passed all nine Ubuntu/Windows/macOS x Node 22/24/26 CI jobs and the local Windows 298-test gate. Mac's local check passed 297 tests with one Windows-only skip. Windows exercised `26f22a5` with all 93 built runtime files byte-identical to the candidate; Mac exercised the exact `85fd145` controlled-start installation.

Both platforms completed one inherited read-only task and same-root follow-up, with unchanged fixture/configuration/Skill and released claims. Mac retained one Dock icon; Windows taskbar grouping remains a known limitation. An unrelated historical Windows task-lock warning was preserved. Current vision execution, real rc.3 product behavior and manual Desktop session visibility remain unverified. See [Validation](validation.md) for exact environments and the Mac output-format/claim-recovery notes.

Preserve the old checkout and installer backups. Before rollback, review subsequent edits, restore only the intended MCP/Skill content and relaunch during an agreed window. Leave DSH configuration and active tasks untouched during preparation.

## Contract references

- [Official Connection](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/README.md)
- [Gateway stream protocol](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/api/gateway/src/stream-protocol.ts)
- [rc.3 session types](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.3/packages/api/session-controller/src/types.ts)
- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp)
