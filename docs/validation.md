# Validation guide

This guide separates repeatable automated checks from operator-observed integration evidence.

## Automated checks

From a clean checkout:

```bash
npm ci
npm run check
npm pack --dry-run
```

The unit tests use mock DSH hosts. They cover bridge state, cursor recovery, event reduction, questions and approvals, cancellation, workspace claims, atomic existing-session attachment, process reconnection, and MCP schemas without requiring a live model route.

## Fresh checkout and portability boundary

- The reproducible clean-checkout sequence is `npm ci`, `npm run check`, and `npm pack --dry-run`. `npm install` is for intentional lockfile updates, not the normal validation path.
- The current automated matrix covers x64 Ubuntu and Windows with Node.js 22 and 24. Node.js 22+ is the project floor, not evidence for every future major or ARM64 environment; use x64 Node.js 22 or 24 as the safest new-machine baseline.
- Use a fresh clone on another machine. A single worktree must not be copied because its `.git` file points to worktree metadata in the source clone. On the same machine, create a new worktree from the source clone with `git worktree add`.
- Setup records absolute paths to the Node.js executable and built bridge entry point in the caller configuration. Keep the checkout in a stable tools directory; after moving it, changing the Node.js installation, or switching worktrees, rebuild and run setup again, review the existing entry, and use `--replace` only after explicit approval.
- Codex setup manages two separate outputs: the MCP entry in the selected Codex TOML file and the shipped skill files in the repository-scoped `.agents/skills/codex-dsh-orchestrator/` directory. By default `npm run setup` installs `SKILL.md` and `agents/openai.yaml`; `--no-skill` opts out, `--skill-path <dir>` selects another target, and `--replace-skill` is required for conflicting files. Confirm `/mcp` and `/skills` after restarting Codex; setup success alone does not prove caller trust, DSH login, permissions, or end-to-end execution. Claude Code setup manages its project skill separately.
- Keep `DSH_BRIDGE_HOME` on a reliable local filesystem. Do not copy an old bridge home across machines: use a fresh home and start new bridge mappings, cursors, and claims. DSH `session.history` remains owned by the Host and is not migrated by copying bridge state.
- Windows `DSH_HOST_MODE=desktop-auto` is opt-in and requires an already-running DSH Desktop Host plus the supported Windows process and loopback discovery prerequisites. CI mocks those behaviors and does not constitute real Desktop installation, login, or plugin acceptance.
- Release source checks do not claim a fresh-machine Codex caller restart/discovery or a live DSH Desktop/login/plugin end-to-end acceptance. Those claims require a separately approved disposable run; the local skill installer check only proves exact file installation and conflict safety.

## Codex skill installation check

The repeatable local check for the shipped Codex skill is separate from live caller acceptance:

1. Build and test the source tree with `npm ci` and `npm run check`.
2. Run `npm run setup -- --yes` from the repository root, or use `--skill-path <temporary-directory>` with a disposable Codex config for an isolated check.
3. Confirm that exactly `SKILL.md` and `agents/openai.yaml` were installed under the reported skill target, with no unrelated files changed. The default repository-local generated copy is ignored by Git; the canonical source remains under `skill/`.
4. Re-run setup to confirm an idempotent no-op. Create a deliberate non-secret conflict in a disposable target and confirm setup refuses it until `--replace-skill` is supplied.
5. Restart Codex and confirm `/skills` lists the skill and `$codex-dsh-orchestrator` can be invoked. This final caller check is operator-observed and must not be inferred from the setup process output.

## Cross-task session reuse acceptance (mock)

The repeatable mock checks must prove the reuse path without touching a live Host:

1. Exact filtering returns one candidate without history: `dsh_find_sessions` with an exact canonical `cwd` plus `mappedOnly` and `idleOnly` returns exactly one candidate, `metadataOnly=true`, `conversationHistoryRead=false`, and never calls `session.history`.
2. Attachment reuses the mapping and claim: `dsh_attach_session` reuses the candidate's existing BridgeTask mapping (no duplicate mapping) and reacquires the requested cooperative workspace claim.
3. Attachment is non-mutating: it sends no prompt and performs no model selection (no `session.prompt`, `session.selectModel`, `session.create`, or `session.rename`).
4. Follow-up stays on the same root: the separate `dsh_followup` targets the same root session id and does not call `session.create`.
5. Fail-closed cases: ambiguous, running, stale-metadata, missing-cwd, and mapping-conflict candidates all fail closed (no attach, no prompt, no mapping).

The live reuse gate stays explicitly operator-approved and disposable: use a temporary worktree, a non-sensitive prompt, and a single titled session. Never record real task/session ids, prompts, credentials, personal local paths, or provider data. Creating, attaching, or following up a live DSH session requires explicit operator approval first.

For any reuse run, record only supportable cost evidence: `sessionReused=true`, `newSessionCreatedForFollowup=false`, `repositoryWideRescanAvoided=true|false` plus `repositoryWideRescanAvoidedEvidence` based only on observed tool actions, and `providerCacheEvidence=not_exposed` unless documented aggregate usage explicitly includes cached input tokens. Never infer provider prompt-cache hits or token discounts from reuse, lower latency, or a successful follow-up. Do not store prompts, conversation content, task/session ids, local paths, or provider account data.

## Cross-task session reuse acceptance (live)

Operator-approved live acceptance recorded only these sanitized facts:

- `decision=attached-existing-task`; `sessionReused=true`; `newSessionCreatedForFollowup=false`.
- `repositoryWideRescanAvoided=true`; `repositoryWideRescanAvoidedEvidence`: exact canonical `cwd` plus mapped+idle metadata-only discovery, no history, attach sent no prompt/model selection, same-root bounded follow-up, and no recursive scan actions observed.
- `bridgeRevision=577c225`; the live runner exercised the implementation HEAD before the evidence commit.
- `providerCacheEvidence=not_exposed`; `model=Pro/High`.
- `metadataOnly=true`; `conversationHistoryRead=false`.
- `attachPromptSent=false`; `attachModelSelectionChanged=false`.
- The cooperative workspace claim was reacquired and released.

### Compatibility evidence (live)

Sanitized operator-observed facts from the same run:

- `dshCliVersion=unverified`: standalone `dsh --version` was not available in the tested acceptance shell.
- `bridgeTestedAgainstDshVersion=0.1.0-rc.6`; `bridgeDeclaredDshVersion=0.1.0-rc.6`, both from read-only Host status.
- `hostDescribeProductVersion=0.0.1`, explicitly a `host.describe` placeholder and not to be called the CLI version.
- `nodeVersion=v26.7.0`; `windowsVersion=10.0.22631.5624`.
- Probed Host capabilities: `unaryRpc=true`, `eventsMuxWebSocket=true`, `muxResumeSince=false`, `historyReconciliation=true`, `queueSnapshot=true`, `queueEmptyBaselineInference=false`, `typedRespond=true`.
- `coreFocusedTests=32/32` pass.
- Historical, isolated-Windows-worktree/pre-restart evidence: `fullAutomatedGate=170/171` with the known docs-security caller-skill CRLF/LF generated-artifact equality baseline. Historical standard `npm pack --dry-run`/prepack was blocked by that baseline plus a Windows npm cache temporary-lock EPERM; the historical `npm pack --dry-run --ignore-scripts` inventory was 96 entries.
- Current post-restart revalidation on the final-instruction tree at revision `6eb052a`: `npm run check=172/172 pass`; standard `npm pack --dry-run` success; inventory=96. This revalidation does not claim the historical root cause is permanently fixed.
- `providerCacheEvidence=not_exposed`.
- One local Windows Desktop Host / bridge compatibility target was observed; standalone DSH CLI version was not tested; no generalization is claimed. The cooperative bridge claim is not DSH sandbox verification, and capabilities not explicitly probed remain unverified.

#### Deferred portability and release baselines

- The historical CRLF/LF and pack observations came from an isolated Windows worktree before restart. Cross-worktree and new-machine portability hardening remains deferred; a current pass must not be generalized into a permanent root-cause fix or release guarantee.
- Standard pack success has current revalidation evidence, while release-surface portability and new-machine hardening remain approval-gated and must be rechecked at the triggers below.
- Standalone `dsh --version` was unavailable in the acceptance shell and the CLI version remains unverified; the current Desktop Host/bridge capability live path passed, but must not be generalized to new versions or new machines.

Approval triggers: new computer install or migration, public GitHub/npm/package release, DSH Desktop/CLI upgrade, or a strict CI/all-green requirement. At any trigger, Codex must first report current state, risks, and repair scope and ask the user whether to repair; it must not auto-fix, install dependencies, or change authentication/network.

## Live Host preflight

Start `dsh web` separately under user or OS-service ownership, then run:

```bash
npm run doctor
```

Record, without credentials or session content:

- `dsh --version`;
- `host.describe.version` and the fact that it may be a product placeholder;
- probed Host capabilities;
- configured model provider/model and `routable` state;
- bridge commit or release tag;
- operating system and Node.js version.

## Browser-visible acceptance

1. Open the same DSH Web Host used by the bridge.
2. Delegate a task with `workspaceMode="read-only"` in a disposable workspace and keep its task/session identifiers private. Confirm the response reports `workspaceClaimSemantics.controlsDshSandbox=false`; this is a bridge-local claim, not a DSH sandbox assertion.
3. Confirm that the root session appears in DSH Web.
4. Confirm that `dsh_wait` and cursor-based `dsh_tail` observe progress without dropping or duplicating the terminal event.
5. Confirm that `dsh_status` reaches `turn_completed` and returns the final message from live DSH history.
6. Send one follow-up to the same task and confirm that it creates another turn in the same root session. In a separate disposable run, explicitly route a follow-up and confirm selection is re-read before the prompt and the response reports the DSH global-default side effect; do not run this check when changing the user's default route is unacceptable.
7. If a harmless test can produce a typed question, answer it through `dsh_answer_question` and confirm that an ordinary follow-up does not resolve it.
8. Do not manufacture a sandbox escape only to test approval forwarding. When a legitimate approval occurs, verify that it is never auto-allowed and that rejection remains available.
9. Release the workspace claim and confirm that the DSH session remains visible.

For existing-session attachment, use a disposable idle root session and a temporary bridge home. Confirm that `dsh_find_sessions` returns metadata but no history/raw projections; copy the exact id and preconditions into `dsh_attach_session`; verify that no prompt, rename, session creation, or model selection occurs. Then issue a harmless `dsh_followup` only if the operator has explicitly approved that separate write. A routed follow-up is also a separate model-selection write with the disclosed global-default side effect. Verify that route verification failure sends no prompt, and that a stale timestamp, descendant id, or running session fails closed.

Repeat this acceptance after changing the DSH version, Web API behavior, model route, agent preset, event reconciliation, or mutation semantics.

## Local Desktop transport evidence (2026-08-18)

- Platform: Windows, Node.js 26.7.0.
- Bridge commit under test: local stage-1 work based on `87435b0`.
- DSH surface: community DSH Desktop running the upstream Web Host; the standalone `dsh` executable was not visible to this shell, so the CLI/package version remains unverified.
- `DSH_HOST_MODE=desktop-auto` resolved one exact Desktop-owned loopback listener without a port scan.
- Read-only doctor probes passed `host.describe`, `session.list`, `events.mux`, and bounded `session.history`; `host.describe.version` remained the known `0.0.1` placeholder.
- The reported configured route was `deepseek-official/deepseek-v4-flash`.
- Mock integration rotated the resolved Host origin between two ephemeral ports after a mux disconnect and reconnected on the next manager iteration. No prompt was issued, and the failed operation was not retried.
- Stage-2 read-only verification ran the production `findSessions` implementation against the live Desktop Host for one operator-supplied exact title. It found one result and returned only the documented metadata fields; no history, attachment, task mapping, claim, model change, or prompt was requested.

This evidence covers endpoint discovery, reconnect, and metadata-only session discovery. It does not prove Desktop profile-switch affinity, live active-turn durability, or the state-changing existing-session attachment flow.

## Final local RC evidence (2026-08-18)

- Packaged bridge commit: `f62e652` (`chore: harden local release candidate`).
- `npm pack` prepack completed the TypeScript build and 161/161 tests successfully.
- The resulting tarball contained 92 entries: all required runtime/setup/skill/documentation files were present, while source, tests, `docs/superpowers/plans`, credentials, bridge state, and other forbidden local paths were absent.
- An offline install of the tarball into a generated temporary directory succeeded without running package install scripts. The packaged Codex setup wrote only a temporary `config.toml` using `DSH_HOST_MODE=desktop-auto`.
- From that isolated install, the MCP server reported version `0.1.0-alpha.2`; Desktop discovery connected to the then-current verified loopback endpoint.
- Read-only `dsh_find_sessions` returned one operator-requested exact-title result with `metadataOnly=true` and `conversationHistoryRead=false`; no session create, attach, prompt, rename, model selection, or workspace claim was requested.
- After Codex restarted onto the built working tree, `/mcp` reported `dsh_agentlink` enabled and `dsh_host_status` reported `connected`, `desktop-auto`, connect-only lifecycle ownership, and the configured `deepseek-official/deepseek-v4-flash` route.
- The generated temporary tarball, install tree, config, and bridge home were removed after their exact temporary path was verified. No real Codex or DSH configuration was changed.

This RC evidence closes the packaged-install and read-only Desktop connectivity checks. It still does not replace an operator-approved disposable live run for state-changing attachment, delegation, routed follow-up, cancellation, question, or approval behavior. Those checks remain explicitly deferred in [the deferred roadmap](deferred-roadmap.md).

## Code Mode visual handoff evidence (2026-08-18)

- Environment under test: community DSH Desktop reporting `0.1.0-rc.6`, Agentlink `46621cf`, and ModLens `3.18.1` on Windows.
- Capability probes showed the collapsed Code Mode surface exposing `run_code` directly while registered ModLens capability remained available inside the injected `tools` SDK. A separate direct native-tool probe did not establish top-level ModLens exposure.
- An operator-approved disposable visual delegation selected `deepseek-modlens/deepseek-v4-flash`, supplied one accessible absolute image path, and explicitly required `run_code` plus `tools.modlens_read_image` without shell, browser, OCR, filesystem, network, or image-library fallback.
- The observed sequence was outer `run_code`, `tool/code-dispatch-start`, successful nested tool result, and a final answer grounded in the returned visual evidence. The route was restored to the prior official Flash default after the check.
- The ModLens provider's documented inner timeout was not treated as the delegation wall-clock deadline. Acceptance required the nested result and final answer; failure would require an exact nested error, terminal task state, or explicit cancellation.
- This evidence validates only the recorded collapsed Code Mode path. Native tool exposure in a later Host remains unverified and must be selected from live capabilities rather than inferred from rc.6.

## DSH rc.7 package-drift preflight (2026-08-19)

- Read-only local package inspection resolved DSH base and Web app `0.1.0-rc.7`, Cordis `4.0.1`, ModLens `3.18.1`, and dshmarket `1.11.0` in the active Web profile.
- Read-only `dsh_host_status` connected through `desktop-auto`, reported a ModLens Flash route, and successfully capability-probed the core Host surface.
- The Host continued to report the known `0.0.1` product placeholder, while Agentlink's published tested-target label remained `0.1.0-rc.6`. This is therefore package-manifest plus capability evidence, not an rc.7 end-to-end compatibility claim.
- The preflight did not create or attach a session, send a prompt, select a model, claim a workspace, or modify a plugin, profile, credential, network setting, or authentication state.

The rc.6 Code Mode visual result above must not be silently promoted to rc.7. A real rc.7 visual claim requires a separately approved disposable, non-sensitive state-changing test that observes the nested ModLens result and final answer. Failure must stop with the exact nested or terminal error; it must not trigger automatic CLI retry, provider failover, proxy changes, or profile rewrites.

## Evidence boundary

A passing unit suite does not prove live Host compatibility. One live success proves only the recorded DSH version, route, preset, workspace, and bridge revision. Host-restart durability requires a separate test and must not be inferred from bridge-process reconnection.
