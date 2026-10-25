# Changelog

This file records user-visible changes to Codex-DSH-Orchestrator. The project
is distributed as source code; `package.json` remains private and this file
does not announce an npm publication.

## Unreleased

- Added an opt-in authenticated official Desktop Gateway adapter with owned
  loopback discovery on Windows and macOS, in-memory startup authorization,
  and a caller handoff helper. The operator controls application startup.
- Added exact-root history/queue reconciliation, sanitized connection diagnostics
  and current Flash catalog routing with account/API-key separation.
- Updated MCP SDK to 1.32.0 and Zod to 4.6.7, with scoped transitive security
  updates and the required Gateway record-schema migration.
- Added rc.3 catalog refresh, effort and rejection regressions; the Windows
  Node 26.7.0 source gate passes 293 tests. CI is defined for Node 22/24/26
  on Ubuntu, Windows and macOS.
- Updated bilingual setup/Skill guidance and operator startup instructions.
  The earlier Apple Silicon read-only smoke covers an older adapter build;
  final-candidate Windows/Mac live acceptance and current vision execution remain pending.

## 0.1.0-alpha.5 — source release

- Added a bounded visual-routing policy: non-visual routine and difficult work
  keeps the existing Flash/Pro distinction; low-complexity visual work uses
  the official native Flash Vision route.
- High-complexity visual work now requires an explicit choice between official
  Flash Vision and ModLens Pro. ModLens Flash remains a one-time fallback only
  after bounded timeout, unreachable-Host, or HTTP 5xx failures; other failure
  classes remain fail-closed.
- Added non-sensitive fallback status reporting and regression coverage for
  prompt-failure handling and legacy explicit model-profile compatibility.
- Added macOS Node.js 22/24 CI coverage and normalized the macOS temporary
  directory fixture so the test suite respects the existing symlink-safe
  installation policy.

## 0.1.0-alpha.4 — portability documentation candidate

- Documented fresh-clone/worktree and stable-directory requirements.
- Made Codex setup install the shipped repository-scoped skill by default, with `--no-skill`, `--skill-path`, and explicit `--replace-skill` conflict handling.
- Reorganized human Quick Start and the compact AI-agent installation contract around the real MCP-plus-skill setup flow.
- Documented the tested Node.js 22/24 matrix and DSH Desktop/bridge-home boundaries.
- Kept the package private; this source candidate does not announce an npm publication.

## 0.1.0-alpha.2 — source snapshot

- Established Codex-DSH-Orchestrator as the public project identity.
- Added a project overview describing ownership, component boundaries,
  supported callers, and the DSH Web Host safety boundary.
- Clarified that the shared bridge runtime is an independently maintained
  derivative of dsh-Agentlink.
- Retained the upstream MIT license, copyright attribution, runtime package
  names, CLI names, and MCP identifiers for legal and compatibility reasons.
- Added maintainer-facing source-release checks and aligned the public README,
  architecture documentation, and contribution guidance.
- No core communication protocol or bridge behavior changes are included in
  this documentation-focused snapshot.
