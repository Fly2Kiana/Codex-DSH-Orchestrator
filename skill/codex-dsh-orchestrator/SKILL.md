---
name: codex-dsh-orchestrator
description: Orchestrate bounded Codex-to-DSH collaboration through the existing dsh_agentlink MCP bridge, including delegation decisions, compact handoff, semantic Flash/Pro/ModLens routing, task follow-up, supervision, and final Codex review. Use whenever the user invokes $codex-dsh-orchestrator, says “请委派给 DSH”, “交给 DSH”, “让 DeepSeek 处理”, asks Codex to choose whether or how much work to delegate, requests a Flash/Pro/reasoning-effort route, requests ModLens for visual work, or asks to continue or inspect an existing DSH task or Desktop session.
---

# Codex DSH Orchestrator

Use the already-loaded `dsh_agentlink` MCP tools. If unavailable, report the missing bridge and stop. Setup and authorization belong to the operator; orchestration does not install a replacement transport or restart applications. Never auto-approve a DSH request.

The official Desktop Gateway requires startup authorization in the caller's environment. On `auth_required`, `auth_rejected` or `unsupported_protocol`, report the condition. Leave tokens, credential stores, private keys, browser cookies and Desktop memory untouched. `dsh_host_status` may perform Gateway admission; use it with connection approval, not as an authentication-free probe.

## Roles and delegation size

- Codex is the Principal Agent and Tech Lead: requirements, planning, architecture, task decomposition, technical decisions and final acceptance.
- DSH is the Worker for bounded code search, implementation, refactoring, tests, lint/type/test repair, long-log analysis and review corrections.
- Keep small tasks in Codex when handoff would cost more than the work.

Delegate one independently executable slice with a workspace, deliverable, constraints and expected evidence. Keep integration judgment and sensitive decisions in Codex. Split unrelated work into separate tasks.

## Session continuity

Report one reuse decision with a short reason:

| Decision | Conditions and action |
| --- | --- |
| same-known-task | The exact BridgeTask is known and the request continues its workstream. Inspect freshness, then use dsh_followup. |
| attached-existing-task | Explicit continuation evidence plus one unique mapped, idle root at the exact canonical cwd. Attach with fresh preconditions, then follow up. |
| new-session | New work, a changed workspace/branch or security boundary, stale/ambiguous candidates, noisy context, or a need for isolation. Use dsh_delegate. |

For cross-chat continuation, use metadata-only `dsh_find_sessions` with exact canonical cwd, `mappedOnly` and `idleOnly`. Require exactly one unique candidate and fresh `sessionId`, `updatedAt`, `cwd` and title preconditions for `dsh_attach_session`. Never read history for discovery. Merely similar or ambiguous candidates must not be reused. A user-named Desktop session still needs exact metadata checks.

Attachment reacquires the cooperative claim, sends no prompt and performs no model selection. Work resumes with `dsh_followup` on the same root. A concise stable title helps discovery but does not identify a session.

Reuse may reduce repository rereads and can increase input tokens when context grows. Provider cache hits are not proven by reuse, latency or follow-up success. Keep `providerCacheEvidence=not_exposed` unless documented aggregate cached-token telemetry is available.

## Model routing

The user's explicit route choice always wins, within catalog and visual-policy constraints.

| Route | Use |
| --- | --- |
| `modelProfile="flash"` | Routine search, implementation, refactoring, test writing and repair |
| `modelProfile="pro"` | Difficult debugging, high-risk changes or deeper analysis |
| Omit routing / `inherit` | Current route is suitable, or a global-default change is unacceptable |
| Visual work | Declare `visualIntent="required"` and `complexity="low"|"high"` |

Include a concise `selectionReason` for an autonomous non-inherit choice. Pass `reasoningEffort` when requested; otherwise use the advertised default. The current catalog must support the exact model and effort.

For non-visual work without an explicit profile, `complexity="low"` selects Flash and `complexity="high"` selects Pro.

Current Flash can be `deepseek-account/deepseek-flash` or an API-key route; older catalogs use V4 IDs. An unavailable Pro is an error. Keep account/API-key providers separate and recheck the result after selection. A catalog refresh can remove a route or effort.

Explicit `session.selectModel` persists the selection as DSH's global default on the supported contracts. Disclose the returned routing warning. Verification failure sends no prompt, but the selection write may already have changed that default. Normally omit `agentPreset` and retain the installation-time default.

## Visual policy

- Low complexity selects the verified official native Flash Vision route. Current Flash needs explicit image-input evidence; the historical exception is the exact `deepseek-official/deepseek-v4-flash-vision-exp` pair. A text-only declaration overrides it.
- High complexity requires the user's choice of `modelProfile="official-flash-vision"` or `modelProfile="modlens-pro"`. Without it, `user_choice_required` stops before creating a session or prompting. Ask for the choice; retain no new persistent preference.
- `modelProfile="modlens-flash"` is never a first visual choice under declared visual policy. Only after the approved route exhausts bounded timeout/unreachable/HTTP 5xx selection attempts does the bridge try it once. Cancellation, invalid input, missing models/efforts, provider ambiguity, permissions, credentials and configuration errors do not trigger fallback. Prompt writes are not retried.
- If visual-policy fields are omitted, an explicitly supplied legacy ModLens profile remains compatible.
- If `visualRouting.fallback.used=true`, show its short non-sensitive `notice` at task end. Report a failed fallback as a failure.

The rc.3 Gateway session catalog omits modalities. A Vision name, provider default or source callback alone cannot establish active image support. Missing evidence and `CLIENT_UPGRADE_REQUIRED`/`MODEL_UNSUPPORTED` are stopping conditions, not fallback triggers.

The bridge sends text prompts and DSH-accessible absolute local image paths. If DSH cannot access the image, report the missing input. Images are not uploaded by the bridge.

### ModLens Code Mode

Use this procedure only for an active ModLens route on the previously verified rc.6 collapsed Code Mode contract. Official native vision uses its own image path. Other Hosts follow their verified tool capability.

A top-level `run_code` is expected on collapsed Code Mode; registered tools run inside it through the injected SDK. Include the image paths and bounded objective with this handoff:

```text
Use DSH Code Mode for this visual task. Call run_code, and inside that program use the injected tools SDK capability tools.modlens_read_image for these absolute image paths: <paths>. Base the answer only on the returned ModLens evidence. Do not use shell commands, direct filesystem or network code, browser tools, OCR libraries, or Python image libraries. If the SDK capability is absent or the nested call fails, report the exact underlying error and stop.
```

Keep ModLens work on that tool path. A top-level `run_code` followed by `tool/code-dispatch-start` means the program is active; one or two quiet wait windows are not a failure signal. Never use a locally documented nested-tool timeout as the outer delegation deadline. Wait for the nested result, exact underlying error, terminal failure or user cancellation. A `tool/result` followed by the requested final answer establishes completion.

## Compact handoff

Before `dsh_delegate` or a work-producing `dsh_followup`, summarize the objective, completed work/decisions, Git HEAD/status and changed paths, focus code/Markdown files, relevant tests, constraints and unresolved issues from known progress and read-only evidence.

Tell DSH to read the focus paths first and expand its search only if blocked. Never include secrets, credentials, raw large diffs, whole file bodies, caller chat or internal reasoning. The summary grants no additional filesystem access.

## Supervision

1. Use `dsh_host_status` when availability is unknown. The Runtime is connect-only: never start, stop, or restart DSH Desktop or the Web Host.
2. New work uses `dsh_delegate` with the compact handoff and an existing absolute `cwd`. Same known work uses `dsh_followup(mode="queue")`; `mode="steer"` targets the active turn's next step.
3. For an intended existing Desktop session, discover its metadata, check the exact idle root and attach before sending work.
4. Observe with repeated bounded `dsh_wait`, advance `dsh_tail.nextCursor`, and use `dsh_status` for execution, availability, final message, queues and pending interactions. A wait window is not the task deadline; continue until a real terminal state, confirmed unreachable Host or required human action.
5. Before mutations, retain the latest cursor/revision and pass supported freshness preconditions. On `stale_view`, inspect and reassess.
6. Answer ordinary pending questions through `dsh_answer_question` with exact request/typed answers. Timed questions stay with the Host's human answerer; follow-up is not their answer channel.
7. Approvals need a human decision for that exact request. Use `dsh_resolve_approval(..., outcome="allow_once")` only after approval; otherwise reject or stop.
8. Cancel the intended scope. Prefer `dsh_cancel(scope="turn")`; queue cancellation needs a current snapshot and is non-atomic.
9. After the work and follow-ups finish, use `dsh_release_workspace`. The DSH session remains open.

## Workspace ownership and review

Use `exclusive-write` for edits, preferably in an isolated Git worktree. While DSH holds that claim, Codex must not edit the same cwd. A `read-only` claim is cooperative coordination; DSH's own permissions enforce filesystem access. Manual Desktop/editor/shell work or another bridge home can still race with the task, so refresh status after user interaction.

Agentlink communicates through the Host; session visibility in Desktop is a separate UI observation.

After DSH completes, Codex independently reviews the diff and relevant files, verifies proportionate tests and checks the original requirements. Send bounded corrections through the same task when needed. Report unresolved failures, routing side effects, pending interactions and manual steps before final acceptance.

Stop for missing identity, unsupported capabilities, unrecoverable cursor gaps or unresolved workspace ownership. Keep DSH profiles, authentication, permissions, plugins and network settings unchanged during orchestration.
