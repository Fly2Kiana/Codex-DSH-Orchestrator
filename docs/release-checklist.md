# Codex-DSH-Orchestrator release checklist

This checklist describes the public source-release expectations for
Codex-DSH-Orchestrator. It is maintainer guidance, not a promise that every
future release will use the same schedule or hosting configuration.

## Project identity

Use a description that makes the caller-side boundary clear:

> Codex-first orchestration layer and caller-side MCP bridge for bounded collaboration with the official DeepSeek Harness (DSH) Web Host.

Suggested repository topics:

- `codex`
- `mcp`
- `deepseek-harness`
- `agent-orchestration`
- `agent-collaboration`
- `dsh`

The project is an independently maintained derivative. It is not affiliated
with or endorsed by DeepSeek, OpenAI, or the dsh-Agentlink maintainers.

## Source-release gate

- Confirm that the repository root opens with the Codex-DSH-Orchestrator README.
- Keep the English and Chinese README files semantically aligned.
- Link the [project overview](project-overview.md), architecture, validation,
  and contribution guidance from the public documentation.
- Retain `LICENSE`, `NOTICE`, the upstream copyright notice, and a visible
  attribution link to the [dsh-Agentlink project](https://github.com/hootandy321/dsh-Agentlink).
- Keep the upstream MIT terms intact when modifying or redistributing the
  shared bridge runtime.
- Remove generated files and local state from the release tree, including
  `node_modules/`, `dist/`, `.env` files, logs, archives, editor metadata, and
  bridge state.
- Search the complete release tree for credentials, private keys, tokens,
  personal absolute paths, internal hostnames, and real session identifiers.
- Verify that every third-party asset and copied source has a documented
  license or attribution.

## Functional validation

From a clean checkout, run:

```bash
npm ci
npm run check
npm pack --dry-run
```

Also run the live procedure in [`validation.md`](validation.md) against the
DSH version and supported caller versions documented by the README. Confirm
that the procedure does not require starting or stopping DSH on behalf of the
user.

## Safety and compatibility gate

- The bridge remains connect-only and does not own the DSH Web Host lifecycle.
- Authentication, Host permissions, and approval decisions remain outside
  the bridge; approval responses remain human-gated.
- The project does not present itself as a DSH Cordis bundle.
- Runtime package names, CLI names, MCP identifiers, and compatibility
  boundaries are changed only with an explicit migration note.
- `package.json` remains `private: true` unless npm distribution has its own
  reviewed package, ownership, security, and release decision.

## Version and release notes

- Update `CHANGELOG.md` with user-visible changes and known limitations.
- Keep the package version, release notes, and Git tag aligned.
- Record breaking changes, migration steps, and compatibility-impacting
  changes before publishing a release.
- After publication, verify the repository landing page, README links, release
  notes, and source archive from a clean user-facing view.

## Maintainer follow-up

- Review open security reports and dependency alerts.
- Confirm CI runs on the Node.js versions supported by the README.
- Re-check the upstream license, attribution, and any newly added assets.
- Record deferred work in the roadmap instead of implying that it is shipped.
