# Codex-DSH-Orchestrator project overview

**English** | [简体中文](project-overview.zh-CN.md)

Codex-DSH-Orchestrator is a Codex-first orchestration layer and caller-side MCP bridge for bounded collaboration with the official DeepSeek Harness (DSH) Web Host.

## What the project owns

The project owns the Codex orchestration experience, caller-side handoff guidance, task supervision, session continuation decisions, and the shared bridge/runtime changes maintained in this derivative. It keeps the final decision, approval boundary, and independent verification in the primary caller.

The repository does not start, stop, daemonize, or own the DSH Web Host. It is not an authentication boundary, does not automatically approve DSH requests, and is not a DSH Cordis bundle.

## Component map

~~~text
Codex-DSH-Orchestrator
├── skill/codex-dsh-orchestrator/
│   └── Codex-first orchestration skill and agent metadata
├── skill/codex-dsh/
│   └── shared Codex caller compatibility skill
├── skill/claude-code-dsh/
│   └── retained Claude Code caller compatibility skill
├── src/
│   └── shared caller-neutral MCP bridge runtime and setup tools
├── test/
│   └── local mock-host, safety, compatibility, and integration tests
└── docs/
    └── architecture, validation, roadmap, and maintenance-facing guidance
~~~

## Relationship to dsh-Agentlink

The shared bridge runtime is an independently maintained derivative of [dsh-Agentlink](https://github.com/hootandy321/dsh-Agentlink). The original MIT license, copyright notice, and upstream attribution are retained in [LICENSE](../LICENSE) and [NOTICE](../NOTICE). Runtime package names, CLI names, and MCP identifiers remain compatible with dsh-Agentlink in this source release.

Codex-DSH-Orchestrator is independent of DeepSeek, OpenAI, and the upstream maintainers. DSH remains a separate, user-managed Host and service.

## Caller support

- Codex is the primary supported caller and uses skill/codex-dsh-orchestrator/ together with the shared bridge.
- Claude Code is supported through the retained caller integration pack.
- ZCode, OpenCode, Workbuddy, and other callers remain deferred until their host behavior and safety boundaries are verified.

## Safety boundary

The bridge is connect-only. Conversation content remains in DSH session history; bridge persistence is limited to coordination state and content pointers. Approval responses remain human-gated, and workspace claims coordinate cooperating bridge processes without claiming to enforce the DSH Host sandbox.

## Distribution status

The initial distribution is a GitHub source snapshot. package.json remains private: true; npm publication is a separate future decision and is not part of this source release.
