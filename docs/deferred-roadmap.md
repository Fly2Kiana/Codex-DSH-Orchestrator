# Deferred roadmap

**English** | [简体中文](deferred-roadmap.zh-CN.md)

This file records deliberately deferred work so a future development session can recover the current boundaries without treating them as shipped features or release commitments. None of the items below is required for the current Codex → dsh-Agentlink → DSH Desktop collaboration path.

## Current implemented baseline

- One shared connect-only MCP Runtime for Codex and Claude Code.
- Verified Windows DSH Desktop loopback discovery without port scanning or Host lifecycle ownership.
- New delegation, known-task follow-up, bounded observation, cancellation, typed questions, and human-gated approvals.
- Catalog-validated `flash`, `pro`, `modlens-flash`, and `modlens-pro` routing plus advertised reasoning effort; omission inherits the DSH route.
- Metadata-only discovery and explicit attachment of one exact idle root DSH session using fresh id/update/cwd/title preconditions.
- Caller-guided compact handoff through MCP initialization instructions and tool descriptions. Agentlink does not read caller chat or workspace files by itself.

## Implemented cross-task reuse and cost boundary

- Cross-task session reuse is implemented and accepted: a new caller may use metadata-only `dsh_find_sessions` with an exact canonical `cwd`, `mappedOnly`, and `idleOnly`, then attach only one unique mapped idle root with fresh `sessionId`/`updatedAt`/`cwd`/title preconditions before a same-root `dsh_followup`.
- The orchestrator Skill exposes `same-known-task`, `attached-existing-task`, and `new-session`; it never selects by title or similarity, reads history for discovery, or guesses an ambiguous candidate.
- Reuse and avoided rescans are reported separately from provider cache evidence; `providerCacheEvidence=not_exposed` remains the default unless documented aggregate cached-token telemetry is available.
- Remaining deferred gates for this feature are portability hardening across worktrees/new machines and release-surface revalidation. They require the approval triggers documented in [`docs/validation.md`](validation.md); no permanent portability or provider-cache claim is made.

## Deferred tracks and activation triggers

1. **Live state-changing Desktop acceptance**
   - Deferred work: repeatable live delegation, attachment, routed follow-up, question, cancellation, and approval acceptance in disposable state.
   - Activate only when the operator approves a disposable session/workspace and accepts any DSH global model-default side effect. Never manufacture a sandbox escape merely to test approval forwarding.

2. **Agent Preset discovery and capability preflight**
   - Deferred work: read-only preset roster, trust/broken state, required capabilities, and reporting of the exact resolved preset.
   - Activate only after the Host exposes a stable roster and resolution contract that can be capability-probed without rewriting the user profile.

3. **Declarative Session Launch Profile**
   - Deferred work: a typed allowlist of post-create initialization operations and postconditions in the shared backend pipeline.
   - Activate only when a verified plugin cannot be supported through `agentPreset` selection alone. Do not add executable third-party launch hooks or a private plugin Runtime.

4. **Gateway, ACP, and cross-caller task visibility**
   - Deferred work: resident Agentlink Gateway, ACP frontend, and explicit cross-caller task discovery/transfer.
   - Activate only after a first-class external-agent or multi-process topology need exists and loopback binding, authentication, discovery, upgrade, and state ownership have explicit designs.

5. **Additional caller Integration Packs**
   - Deferred work: ZCode, OpenCode, Workbuddy, Claude Desktop MCP, and other caller-specific setup/verification packs.
   - Activate one caller at a time only after its real configuration, permission, reload, and MCP behavior is verified against the shared Integration Pack contract.

6. **Stronger structured handoff transport**
   - Deferred work: a typed handoff object or richer caller-side summarization beyond the current compact prompt workflow.
   - Already-known image byte size, pixel dimensions, and transformation/downscale state may be included as optional text in the compact prompt without changing the MCP schema. Activate typed `imageAssets` fields only if this compact transport proves insufficient in measured use. Agentlink must not receive automatic access to caller chat, secrets, raw large diffs, or unrelated file bodies.

7. **Internal routing/coordinator refactor**
   - Deferred work: extract the duplicated delegate/follow-up model-selection transaction and split the large BridgeService orchestration surface.
   - Activate as maintenance work after public behavior is stable; preserve the MCP schema, fail-closed routing, and non-retried mutation semantics.

8. **Cross-file hard-crash recovery for attachment state**
   - Deferred work: journaling or a combined durable record that can reconcile a process/machine crash between separate task-mapping and workspace-claim file writes.
   - Activate only with observed crash residue or an approved state-format migration. The current transaction handles ordinary claim rejection and runtime exceptions, but does not claim filesystem transaction semantics across two files.

9. **ModLens provider resilience and data-egress policy**
   - Deferred work: upstream timeout passthrough and structured timeout `nextSteps`, evidence-based image downscale/retry, and an optional second vision-provider failover route.
   - Activate only after choosing upstream contribution versus a maintained local fork, and after the operator approves provider credentials, cost, data egress, image-fidelity tradeoffs, and disposable acceptance tests. Agentlink must not automatically rewrite profiles, authentication, provider routes, proxy, DNS, or other network settings.

## Still out of scope

- Starting, stopping, restarting, installing, or reconfiguring DSH Desktop/Web Host.
- Automatic DSH plugin installation or authentication/profile migration.
- Automatic provider failover, image preprocessing/retry, or DSH profile/network changes.
- Semantic matching over prior DSH conversation bodies or automatic reuse based only on similar wording.
- Arbitrary provider/model strings, automatic approval, credential transport, or bridge persistence of conversation bodies.
- npm publication or a native DSH bundle without a separate release and security decision.
