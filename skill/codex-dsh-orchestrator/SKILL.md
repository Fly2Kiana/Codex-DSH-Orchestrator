---
name: codex-dsh-orchestrator
description: Orchestrate bounded Codex-to-DSH collaboration through the existing dsh_agentlink MCP bridge, including delegation decisions, compact handoff, semantic Flash/Pro/ModLens routing, task follow-up, supervision, and final Codex review. Use whenever the user invokes $codex-dsh-orchestrator, says “请委派给 DSH”, “交给 DSH”, “让 DeepSeek 处理”, asks Codex to choose whether or how much work to delegate, requests a Flash/Pro/reasoning-effort route, requests ModLens for visual work, or asks to continue or inspect an existing DSH task or Desktop session.
---

# Codex DSH Orchestrator

Use the already-loaded `dsh_agentlink` MCP tools. If they are unavailable, report that the bridge is not loaded and stop; do not create another MCP configuration or an alternate transport.

## Preserve the role boundary

- Keep Codex as the Principal Agent and Tech Lead. Codex owns requirement interpretation, planning, architecture, task decomposition, technical decisions, review, and final acceptance.
- Use DSH as a Worker for bounded code search, routine implementation, refactoring, tests, lint/type/test repair, long-log analysis, and follow-up changes from Codex review.
- Keep small tasks in Codex when delegation and handoff would cost more than the work.
- Keep architecture ownership, sensitive decisions, approvals, and final acceptance in Codex. Never present DSH output as accepted before independent verification.

## Decide the delegation size

1. Identify a bounded worker slice with an objective, workspace, constraints, expected evidence, and completion condition.
2. Delegate only the slice DSH can execute independently. Keep cross-cutting decisions and integration judgment in Codex.
3. Prefer one focused task over a broad repository-wide assignment. Split unrelated work into separate delegations.
4. Reuse the same known BridgeTask for revisions to the same work. Never guess an old task id across Codex tasks.

## Choose cross-task reuse conservatively

Report exactly one of three decisions with a short reason.

| Decision | Conditions | Action |
| --- | --- | --- |
| same-known-task | The current Codex task retains the exact BridgeTask id and the request continues the same bounded workstream | Inspect status and freshness, then use dsh_followup |
| attached-existing-task | A new Codex task has explicit continuation evidence; filtered discovery returns one exact-canonical-cwd, mapped, idle root; title and current workstream agree; fresh preconditions pass | Call dsh_attach_session, then dsh_followup |
| new-session | A new or unrelated objective, a different cwd/branch or security boundary, ambiguous candidates, mapping conflict, stale metadata, noisy or long context, or no explicit continuation evidence | Use dsh_delegate |

Reuse only the same known BridgeTask for the same workstream. For attached-existing-task, call metadata-only dsh_find_sessions with the exact canonical cwd plus mappedOnly and idleOnly, then require exactly one unique unambiguous candidate that is idle, mapped, and cwd-matching. Attach only with the returned exact sessionId, updatedAt, cwd, and title preconditions, and fail closed on ambiguous, running, stale, missing-cwd, or mapping-conflict candidates. Never choose a session by title or similarity, and never read history for discovery. Merely similar or merely ambiguous candidates must not be reused or guessed. Attachment reacquires the cooperative workspace claim, sends no prompt, and performs no model selection; the subsequent dsh_followup targets the same root session.

For work expected to span multiple Codex tasks, pass a concise non-sensitive stable title to dsh_delegate. A title helps discovery but is never identity or sufficient authorization. Prefer a fresh new-session when isolation is safer or the retained context is no longer relevant.

## Report reuse and cost honestly

Report the chosen decision and a short reason. When a session is reused, state that the same DSH root session was retained and that repository rereads may be reduced. Reuse and avoided rescans are not proof of provider prompt-cache hits or token discounts; provider cache evidence is unknown and not proven unless DSH exposes documented aggregate cached-token usage. Set providerCacheEvidence=not_exposed unless that telemetry exists. Never infer cache hits from lower latency, session identity, or a successful follow-up. A retained long or noisy context may increase input tokens, so reuse is a cost optimization only while continuity stays relevant.

## Select the model route

The user's explicit route choice always wins.

- Use `modelProfile="flash"` for routine search, implementation, refactoring, test writing, and lint/type/test repair.
- Use `modelProfile="pro"` for architecture analysis, difficult multi-step debugging, high-risk changes, or work requiring substantially deeper reasoning.
- Use `modelProfile="modlens-flash"` when ordinary visual evidence is essential to the task.
- Use `modelProfile="modlens-pro"` only for complex visual reasoning that justifies the higher-cost route.
- Omit routing or use `inherit` when the current DSH route is suitable or changing the global default is unacceptable.

When choosing a non-inherit profile autonomously, include a concise `selectionReason`. Pass `reasoningEffort` when the user explicitly requests it; otherwise prefer the selected model's advertised default. Never invent an effort value: the live DSH catalog must advertise it.

ModLens receives text prompts through Agentlink. Include DSH-accessible absolute local image paths in the prompt; do not claim that the bridge uploads image bytes. If the image is not accessible to DSH, stop and explain what path or attachment is needed. When the live Host matches the verified collapsed Code Mode behavior, follow the visual protocol below; otherwise follow the Host's verified live capability.

Explicit model selection calls `session.selectModel`, which on the currently supported DSH rc.6 persists the selection as DSH's global default for later sessions. Inspect and disclose the returned routing warning. A failed verification sends no prompt, but a selection write may already have changed that default.

Normally omit `agentPreset` and retain the installation-time default. Do not change DSH profiles, authentication, permissions, or plugin configuration as part of orchestration.

## Handle visual work through DSH Code Mode

On the locally verified DSH rc.6 collapsed Code Mode path, `run_code` is the direct model tool and registered tools such as `modlens_read_image` remain available inside the program through the injected `tools` SDK. A top-level `run_code` call is expected on that path and does not show that ModLens is missing or misrouted. If another Host exposes native tools differently, follow its verified live capability instead of imposing the rc.6 transport.

For a ModLens handoff on the verified collapsed Code Mode path, include every accessible absolute image path and the bounded visual objective, then use this compact block:

```text
Use DSH Code Mode for this visual task. Call run_code, and inside that program use the injected tools SDK capability tools.modlens_read_image for these absolute image paths: <paths>. Base the answer only on the returned ModLens evidence. Do not use shell commands, direct filesystem or network code, browser tools, OCR libraries, or Python image libraries. If the SDK capability is absent or the nested call fails, report the exact underlying error and stop.
```

Do not bypass ModLens with shell, direct filesystem or network code, browsers, OCR, or image libraries. Do not forbid `run_code` when it is the verified transport. If the SDK capability is absent or the nested call fails, require the exact underlying error and stop.

Supervise visual turns with repeated bounded `dsh_wait` calls and advance from `dsh_tail.nextCursor`. A top-level `run_code` followed by `tool/code-dispatch-start` means the Code Mode program is active; one or two quiet wait windows are not a failure signal. Continue normal user updates while the registered tool works. Never use a locally documented nested-tool timeout as the outer delegation deadline. Treat an exact nested timeout or tool error, a terminal task failure, or an explicit user cancellation as failure; treat `tool/result` followed by the requested final answer as success.

## Build a compact handoff

Before `dsh_delegate` or a work-producing `dsh_followup`, assemble a compact handoff from the current Codex task and read-only workspace evidence:

- objective and bounded deliverable;
- completed work and decisions already made;
- Git HEAD, status, and changed paths when available;
- focus code or Markdown paths;
- relevant tests and their latest known state;
- constraints, safety boundaries, unresolved issues, and expected verification.

Tell DSH to read the focus paths first and avoid a repository-wide scan unless blocked. Never include secrets, credentials, raw large diffs, whole file bodies, caller chat, or internal reasoning. Agentlink does not gain prior Codex conversation state or new filesystem authorization; the handoff is an explicit summary in the prompt.

## Run the supervised workflow

1. Call `dsh_host_status` when Host availability is unknown. The bridge is connect-only: never start, stop, or restart DSH Desktop or the Web Host.
2. For new work, call `dsh_delegate` with the compact handoff and an existing absolute `cwd`.
3. For the same known BridgeTask, call `dsh_followup(mode="queue")`. Use `mode="steer"` only when guidance must enter the active turn's next step.
4. When the user explicitly identifies an existing DSH Desktop session, call `dsh_find_sessions`, require one intended idle root result, then call `dsh_attach_session` with the exact returned `sessionId`, `updatedAt`, `cwd`, and title preconditions. Attachment alone must not prompt or change the model; send work separately with `dsh_followup`.
5. Observe with bounded `dsh_wait` calls and continue from `dsh_tail.nextCursor`. Use `dsh_status` to inspect availability, execution, queue, final message, workspace claim, and pending interactions. For ModLens work on a verified collapsed Code Mode Host, apply the visual supervision rules above.
6. Before mutations, retain the latest task cursor and connection revision and pass the supported freshness preconditions. On `stale_view`, inspect the changes and reassess instead of blindly retrying.
7. Answer a pending question only through `dsh_answer_question` using the exact request id and typed answers. Do not use follow-up as an answer channel.
8. Treat every approval as a human-gated sandbox escalation. Never auto-approve. Call `dsh_resolve_approval(..., outcome="allow_once")` only after the user approves that exact request; otherwise reject or stop.
9. Cancel only the intended scope. Prefer `dsh_cancel(scope="turn")`; use queue cancellation only with a current queue snapshot and treat it as non-atomic.
10. When collaboration is complete, call `dsh_release_workspace`. Releasing the claim does not close the DSH session.

## Coordinate workspace access

- Use the default `exclusive-write` bridge claim for tasks that may edit files, preferably in a dedicated Git worktree.
- Use `read-only` only for analysis or review tasks, while remembering it is a cooperative Agentlink claim rather than a DSH filesystem sandbox.
- While DSH holds `exclusive-write`, Codex must not edit the same cwd. Warn that manual DSH Desktop, editor, shell, or another bridge-home activity is outside claim enforcement and can race with the supervised task.
- Preserve the latest cursor and revision if the user interacts with the same DSH session. Re-read status before issuing another mutation.
- The session can remain visible in DSH Desktop, but Agentlink communicates through the Web Host and does not operate the Desktop GUI.

## Review and accept

After DSH reports completion, Codex independently reviews the produced diff and relevant files, runs or verifies proportionate tests, checks the work against the original requirements, and sends bounded follow-up corrections when necessary. Report unresolved failures, routing side effects, pending interactions, and any manual steps. Accept the task only after Codex's own verification passes.

Stop and report rather than improvising when the Host is unreachable, the task/session identity is unknown, a catalog route or effort is unavailable, content is unavailable, a cursor gap cannot be recovered, an approval needs human judgment, or safe workspace ownership cannot be established.
