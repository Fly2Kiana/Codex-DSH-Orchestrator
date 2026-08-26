# Validation guide

This guide separates checks that can be repeated from a clean checkout from
acceptance steps that require an operator and a live DSH Host. A passing local
suite does not claim that a particular DSH installation, provider route, or
desktop profile is available.

## Automated checks

From a clean checkout, use the lockfile-driven install and run the same checks
used by CI:

```bash
npm ci
npm run check
npm pack --dry-run --ignore-scripts
```

The automated matrix covers x64 Ubuntu and Windows with Node.js 22 and 24.
Node.js 22 is the project floor; other operating systems, architectures, and
future Node.js majors need their own validation.

The test suite uses mock DSH Hosts for deterministic coverage. It exercises
bridge state, cursor recovery, event reduction, questions and approvals,
cancellation, workspace claims, existing-session attachment, reconnection,
MCP schemas, and model-routing policy without requiring a live model request.

## Visual routing validation

The visual-routing policy is validated at the model-routing, bridge-service, event-ledger,
MCP-contract, and skill-instruction boundaries:

- Non-visual routine work keeps the Flash route; non-visual difficult work
  keeps the Pro route.
- Low-complexity visual work selects the official native Flash Vision route.
- High-complexity visual work requires an explicit user choice between the
  official Flash Vision route and ModLens Pro. Without that choice, the bridge
  fails closed before sending a prompt.
- ModLens Flash is never a first-choice visual route. After the approved visual
  route exhausts bounded retries caused only by timeout, an unreachable Host,
  or HTTP 5xx, the bridge attempts ModLens Flash once.
- Invalid input, missing models, protocol or configuration errors, permission
  failures, credential rejections, and prompt-write failures do not trigger
  the fallback.
- A successful fallback returns a short non-sensitive notice and a minimal
  `dsh_status.visualFallback` coordination marker. The caller should briefly
  tell the user at task completion.
- When visual policy fields are omitted, an explicitly supplied legacy
  `modelProfile="modlens-flash"` remains compatible; this does not make that
  route the default for new visual requests.
- A failed initial prompt or follow-up does not persist a fallback marker.

The tests also verify that the bridge transports text prompts only. For visual
work, the caller supplies image paths that the DSH Host and the selected tool
can access; the bridge does not upload image bytes.

## Public-surface and package checks

Before a release candidate is staged, inspect the tracked tree and the package
dry-run inventory. Public files must not contain credentials, personal email
addresses, local absolute paths, private bridge state, task or session
identifiers, internal backup references, or agent-only maintenance directives.

The public-surface regression test checks the project identity, upstream
attribution, license and repository metadata, installation guidance, related
project links, and the absence of machine-specific or internal-maintenance
content. Keep environment-specific observations in private operator notes,
not in the public repository.

The package remains source-only and `private: true`. A successful pack dry run
does not publish to npm and does not prove that a live DSH or Codex installation
is available.

## Fresh checkout and portability boundary

- Prefer `npm ci` for validation. Use `npm install` only when intentionally
  changing the lockfile.
- Use a fresh clone on another machine. Do not copy one worktree as an
  installation package; on the same machine, create a new worktree from the
  source clone.
- Keep the checkout in a stable tools directory. Setup records the Node.js
  executable and built bridge entry point in the caller configuration, so a
  move, Node.js change, or worktree change requires a rebuild and setup again.
- Codex setup has two outputs: the MCP entry in the selected Codex TOML file
  and the shipped skill files under the selected skill target. By default,
  `npm run setup` installs `SKILL.md` and `agents/openai.yaml`; `--no-skill`
  opts out, `--skill-path <dir>` selects another target, and `--replace-skill`
  is required for conflicting files. After restarting Codex, verify both the
  MCP entry and the installed skill. Setup success alone does not prove caller
  trust, DSH login, permissions, or end-to-end execution.
- Keep `DSH_BRIDGE_HOME` on a reliable local filesystem. An independently
  managed or incompatible bridge must use a separate directory. On a new
  machine, use a fresh bridge home and do not copy bridge state. DSH session
  history remains owned by the Host.
- `DSH_HOST_MODE=desktop-auto` is an opt-in Windows discovery mode. It requires
  an already-running supported DSH Desktop Host and the documented loopback
  discovery prerequisites; CI mocks these behaviors and does not constitute a
  real Desktop installation or login check.

## Codex skill installation check

The shipped Codex skill check is separate from live caller acceptance:

1. Run `npm ci` and `npm run check`.
2. Run `npm run setup -- --yes`, or use `--skill-path` with a disposable target
   and disposable Codex configuration.
3. Confirm that exactly `SKILL.md` and `agents/openai.yaml` were installed in
   the reported target and that no unrelated files changed.
4. Run setup again and confirm the expected idempotent result. Create a
   deliberate non-secret conflict in a disposable target and confirm that the
   installer refuses it until `--replace-skill` is supplied.
5. Restart Codex and confirm that the skill is listed and invocable. This is an
   operator check and must not be inferred from setup output alone.

## Cross-task session reuse acceptance

The mock reuse checks must prove the safety contract without touching a live
Host:

1. Exact metadata-only filtering returns one idle candidate without reading
   conversation history.
2. Attachment reuses the existing bridge mapping and reacquires the requested
   cooperative workspace claim without creating a duplicate mapping.
3. Attachment sends no prompt and performs no model selection.
4. A follow-up stays on the same root session and does not create a new root.
5. Ambiguous, running, stale, incomplete, and mapping-conflict candidates fail
   closed.

Any live reuse check must use a disposable workspace, a non-sensitive prompt,
and operator approval. Keep task/session identifiers, prompts, credentials,
local paths, and provider data private. Record only aggregate, directly
observed outcomes.

## Live Host preflight

Start the DSH Web Host under its normal user or service ownership, then run:

```bash
npm run doctor
```

Keep any environment-specific versions, routes, capabilities, and identifiers
in private operator notes. The public repository should describe what must be
checked, not publish values from one machine or one account.

The preflight is read-only. It must not create or attach a session, send a
prompt, select a model, claim a workspace, modify a plugin or profile, or
change credentials, authentication, or network settings.

## Browser-visible acceptance

Only after separate operator approval for live state changes:

1. Open the DSH Web Host used by the bridge.
2. Delegate a harmless task in a disposable workspace and confirm the response
   distinguishes bridge-local workspace claims from a DSH filesystem sandbox.
3. Confirm that the root session appears in DSH Web.
4. Confirm that `dsh_wait` and cursor-based `dsh_tail` observe progress without
   dropping or duplicating the terminal event.
5. Confirm that `dsh_status` reaches `turn_completed` and returns the final
   message.
6. Send one follow-up to the same task and confirm that it remains on the same
   root session. Treat explicit model selection as a separate state-changing
   operation because it may persist a DSH default.
7. If a harmless test produces a typed question, answer it through
   `dsh_answer_question` and confirm that an ordinary follow-up does not
   resolve it.
8. Do not manufacture a sandbox escape to test approval forwarding. When a
   legitimate approval occurs, verify that it is never auto-allowed and that
   rejection remains available.
9. Release the workspace claim and confirm that the DSH session remains
   visible.

For existing-session attachment, use an idle disposable session and a fresh
bridge home. Verify metadata-only discovery, exact precondition checking, no
prompt/model selection during attachment, and fail-closed behavior for stale
or running candidates. Issue a follow-up only when that separate write has
been approved.

Repeat live acceptance after a DSH version change, Web API change, model-route
change, agent-preset change, event-reconciliation change, or mutation-semantics
change. A single live success proves only the specific environment and route
that were tested.

## Evidence boundary

Automated checks establish reproducible source and package properties. Mock
tests establish the visual-routing and fail-closed contracts. Neither proves live
provider availability, a particular DSH Desktop profile, a Codex restart, or a
real visual completion. Those claims require a separately approved disposable
acceptance run and must be recorded outside the public repository unless the
facts have first been sanitized for public release.
