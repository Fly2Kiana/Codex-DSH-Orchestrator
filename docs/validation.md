# Validation guide

## Automated checks

From a clean checkout:

```sh
npm ci
npm run check
npm pack --dry-run --ignore-scripts
git diff --check
```

The CI definition runs build, tests and package preview on Ubuntu/Windows/macOS with Node 22/24/26. Record results for the exact candidate SHA; a workflow definition or an older green run is not a result for a new dependency tree.

Tests use synthetic Hosts and inert caller fixtures. They cover MCP schemas, authorization handoff, process/listener inspection, Gateway admission, session attachment, durable observation, cancellation, questions/approvals, coordination locks and model routing. No inference is required.

## Current evidence

| Area | Evidence | Remaining check |
| --- | --- | --- |
| Runtime source `85fd145` | Windows Node 26.7.0: build and 298/298 tests; Mac Node 24.20.0: build, 297 passed and one Windows-only skip; all nine Ubuntu/Windows/macOS x Node 22/24/26 CI jobs passed; 119 expected package entries | A later documentation-only commit has not yet run remote CI; no runtime or dependency change is included in that refresh |
| Official Windows Desktop, 2026-10-26 | Native startup, owned-listener discovery and Gateway admission; one inherited read-only task plus same-root follow-up completed; fixture unchanged and claim released | Historical task reconciliation retains an unrelated lock warning; Desktop session visibility and original pinned-icon grouping were not qualified |
| Apple Silicon Mac, 2026-10-27 | Controlled-start `85fd145`, Gateway admission and one inherited read-only task plus same-root follow-up completed; fixture unchanged and final claim released | Intel live parity and Desktop session visibility remain unverified; first reply included one extra confirmation sentence |
| rc.3 contract | Scoped source comparison plus synthetic dynamic-catalog, effort and rejection regressions | Real rc.3 account/catalog availability |
| Vision/ModLens | Automated route policy and failure behavior | Current provider/tool execution and visual completion |

The qualified runtime source is `85fd1451d4c8ac1e3234e4ec8237f49d58545e97`, tree `3c48cefe7f9511b512369e36b6dbe9a69ba27cf2`. Windows exercised installed `26f22a5807e374ffa1de761644b19dde84aac9e1`: all 93 built runtime files were byte-identical to `85fd145`, with the same lockfile and canonical Skill. Mac exercised the exact `85fd145` installation. Subsequent publication-document changes do not change those runtime identities.

Recorded environments:

| Component | Windows | Apple Silicon Mac |
| --- | --- | --- |
| Node / npm | 26.7.0 x64 / 11.19.0 | 24.20.0 arm64 / 11.19.0 |
| Codex app metadata | OpenAI.Codex 26.1021.3705.0 | 26.1021.31345, bundle build 21828 |
| Official Desktop bundle | 0.2.1-rc.2 | 0.2.1-rc.2 |
| Packaged core metadata | 0.2.1-rc.2 | Not independently sampled |

These are recorded installation metadata, not guarantees about later automatic updates. Mac hardware/OS were reported as M5 Max and macOS 26.5.1. A wire-reference label does not establish the running core version.

Both smokes used `inherit` and reported `deepseek-official/deepseek-flash/high` with `persistsAsDshDefault=false`. No unexpected model selection, visual fallback, pending interaction or automatic approval occurred. Source, build, configuration and Skill stayed unchanged. Two prompts were submitted per qualified run; provider-internal inference counts, billing and cache hits were not exposed.

On Mac, the first answer correctly described the manifest but added a confirmation sentence beyond the requested three lines. After an early claim release, one metadata lookup and an exact-root read-only attach reacquired that same mapping without a prompt or model selection. The single follow-up completed on the original root. This qualifies communication and read-only continuation, not exact-format compliance. Earlier Mac attempts retaining a pre-installation connection are excluded from the alpha.6 evidence.

The Mac user observed one original Dock icon; Windows direct startup showed a separate taskbar group. Manual Desktop session visibility, Intel live parity, filesystem crash behavior, current visual providers and broader question/approval/cancel flows remain outside these smokes.

Private Review CI covered the exact runtime source; CodeQL was unavailable because code scanning was not enabled there. The later public candidate still needs its applicable CI/CodeQL review.

## Visual routing validation

The automated contract covers:

- Non-visual low/high complexity selects Flash/Pro when no explicit profile is supplied.
- Visual low selects official Flash Vision with exact image-capability evidence; high asks for an explicit choice between that route and ModLens Pro.
- ModLens Flash is never a first-choice route under declared visual policy. Selection/verification can make three attempts for qualifying timeout, unreachable-Host or HTTP 5xx failures, then one ModLens Flash fallback attempt.
- Cancellation, invalid input, missing models/efforts, provider ambiguity, permissions, credentials, protocol/configuration errors and prompt-write failures do not trigger fallback.
- Fallback results provide a short notice and a `dsh_status.visualFallback` marker. A failed prompt does not persist a success marker.
- Omitting visual-policy fields preserves an explicitly supplied legacy `modelProfile="modlens-flash"`.
- Text prompts carry DSH-accessible image paths; image bytes are not uploaded by the bridge.

The official rc.3 session catalog omits modalities. A model name alone cannot authorize image input. The separately scoped legacy vision exception and Code Mode instructions are described in [Gateway capabilities](official-desktop-gateway.md#models-and-capabilities).

## rc.3 catalog regressions

`test/rc3-model-contract.test.ts` exercises the real adapter against a synthetic Gateway:

- Fresh session projections take precedence over the global default.
- Model withdrawal/restoration and changing effort availability are reflected on the next read.
- An available API-key Pro cannot replace a missing account Pro.
- Current/legacy Flash IDs retain their exact provider, and unadvertised efforts are rejected.
- `CLIENT_UPGRADE_REQUIRED`, `MODEL_UNSUPPORTED`, permission and configuration rejections at selection or prompting cause no replay or ModLens switch; raw provider details stay out of errors.
- Withdrawal after an accepted selection prevents prompting even when the projection still matches.

These injections qualify bridge behavior at an RPC boundary, not the exact error shape produced by every provider deployment. The adapter retains its rc.2 wire qualification label separately from actual product-version evidence.

## Installation and portability

Use a fresh clone on another machine. Same-machine worktrees depend on the source clone's metadata. Keep the tools checkout and Node path stable, and use a fresh local bridge home for a new machine.

Official Desktop setup uses `--gateway --desktop-auto --no-preset` on Windows or macOS. Legacy community Desktop automatic discovery remains Windows-only. A static official Gateway uses an explicit `--gateway --host <origin>`.

Preview before writing. Review conflicts, then verify the selected MCP entry and the two Skill files against canonical source. Setup replaces only approved targets and reports backups or partial success. Repository scope is `.agents/skills/codex-dsh-orchestrator/`; user-wide scope can use `$HOME/.agents/skills/codex-dsh-orchestrator`. Update existing legacy global installations in place to avoid duplicate names.

The startup handoff launches applications. Schedule downtime, finish active work, quit Desktop/Codex normally and follow the [operator startup instructions](official-desktop-gateway.md#operator-startup). Preserve the old install and backups for rollback.

### Verify runtime loading

1. Record candidate SHA/tree, package version and actual Node executable.
2. Verify MCP points at that candidate's built entry and that one `dsh_agentlink` is loaded.
3. Confirm the Skill selector/explicit invocation loads the canonical content.
4. Confirm unrelated MCP/Skill configuration and the source tree remain intact.

After replacement, a reconnect timestamp alone cannot prove new code loaded: an older process can reconnect after sleep. Verify the effective entry point, fixed build files, startup context and new caller process together. A retained pre-installation connection does not qualify the replacement build.

Repeat this after moving a checkout, changing Node or replacing an installation.

### Connection-only acceptance

`npm run doctor` is a configuration/lock preflight. In Gateway mode it intentionally leaves admission `not_probed`.

After separate connection approval, call `dsh_host_status` once. It can exchange startup authorization and open one API Peer, but creates no session or prompt. Record successful connection/resolution epochs, availability and capabilities without exposing endpoint or authorization details.

On failure, use sanitized stage/reason diagnostics. Leave processes and lock directories intact; report the failure before changing the installation or restarting applications.

## Windows and macOS non-visual acceptance

Use the same approved source SHA and dependency tree on both platforms. Obtain approval for model use, keep the DSH route inherited, and use a disposable workspace containing a small non-sensitive package manifest.

1. Record file hashes and current source/configuration identity.
2. Delegate one read-only task asking for the manifest's project name, version and short purpose.
3. Observe with `dsh_status`, bounded `dsh_wait` and `dsh_tail.nextCursor` until a real terminal outcome. A quiet 30-second window is only an observation window.
4. Check the returned answer and unchanged workspace hashes. Confirm no automatic approval, unexpected model selection or visual fallback.
5. After a clean first turn, send one `dsh_followup` asking for a one-line summary. Confirm the same root continues.
6. Release the claim after the follow-up. A cooperative read-only claim does not enforce the DSH filesystem sandbox.
7. Separately record whether the intended session is visible in Desktop. API success alone cannot establish UI visibility.

Report failures before attempting another root session. Record sanitized outcomes; keep credentials, prompts, personal paths, endpoint details and real identifiers in private operator notes.

## Optional interaction and reuse acceptance

Questions, approvals, cancellation and existing-session attachment are separate tests. Use ordinary harmless interactions; do not create a sandbox escape to provoke an approval. Answer typed questions through `dsh_answer_question`, and confirm each approval requires the user's explicit decision.

For reuse, metadata-only discovery must find one unique mapped idle root at the exact canonical workspace. Attach with fresh `sessionId`, `updatedAt`, `cwd` and title preconditions; attachment sends no prompt or model-selection write. A later approved follow-up continues that root. Stale, running, incomplete or ambiguous candidates are refused.

## Public package and release evidence

Inspect the exact tracked tree, new reachable history and package inventory. Keep credentials, personal paths, real identifiers and internal maintenance plans out of public artifacts. Preserve MIT/NOTICE attribution and `private: true`.

A source archive and an npm package have different inventories: `dist/` is ignored in Git and generated locally, while the package preview includes it. Exclude local `node_modules`, generated Skill copies, bridge state, logs and archives from the source release. See [Release checklist](release-checklist.md).

Revalidate the final candidate after dependency/runtime, Host, caller, routing or reconciliation changes. Keep automated results, connection acceptance and real task completion as distinct evidence.
