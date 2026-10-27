# Deferred roadmap

**English** | [简体中文](deferred-roadmap.zh-CN.md)

## Implemented

The shared Runtime provides Codex orchestration, a retained Claude Code legacy installer, delegation/follow-up, durable observation, typed interactions and cooperative workspace claims. Official Desktop Gateway adds authenticated Windows/macOS discovery and an operator-controlled in-memory caller handoff.

Model/effort routing follows the session catalog and keeps account/API-key providers separate. Session reuse uses `same-known-task`, `attached-existing-task` or `new-session`. Exact canonical `cwd`, `mappedOnly`, `idleOnly` and fresh attachment preconditions govern cross-chat continuation; titles or similarity cannot select a session. Compact handoff carries the caller's summary, not automatic access to its conversation.

Reuse can reduce rereads while increasing retained-context input. Keep `providerCacheEvidence=not_exposed` unless documented aggregate cached-token telemetry exists.

[Validation](validation.md) records the completed Windows and Apple Silicon Mac read-only task and same-root follow-up, together with source CI, CodeQL and author-policy evidence. Real rc.3 product runs, Intel Mac and extended visual/interaction tests remain separately scoped work.

## Deferred work

| Work | Activation condition |
| --- | --- |
| Extended live interactions | Approve disposable attachment, routed follow-up, questions/cancellation/approval tests and any global model-default side effect. Use ordinary interactions rather than manufacturing a sandbox escape. |
| Agent Preset discovery | Host offers a stable read-only roster, trust/broken state and capability/resolved-preset contract. |
| Declarative Session Launch Profile | A verified plugin needs initialization beyond `agentPreset`; design a typed allowlist and postconditions without executable third-party hooks. |
| Resident coordinator / ACP / cross-caller transfer | A concrete external-agent or multi-process need justifies a design for authentication, discovery, upgrades and state ownership. This is separate from the implemented official Host Gateway adapter. |
| Additional callers | Verify ZCode first when expansion resumes, then evaluate OpenCode, Workbuddy, Claude Desktop and other Integration Packs individually. |
| Structured handoff fields | Measured use shows compact prompt summaries are insufficient. Known image size, dimensions or downscale state can already be text; typed `imageAssets` must earn their schema cost. |
| Routing/coordinator refactor | Stable public behavior warrants extracting shared delegate/follow-up transactions and splitting BridgeService. Preserve schemas and mutation semantics. |
| Cross-file crash recovery | Observed mapping/claim crash residue or an approved state-format migration justifies journaling or a combined record. Ordinary exception recovery is already implemented. |
| ModLens resilience / data egress | Choose upstream contribution or fork, then approve timeout passthrough, structured `nextSteps`, fidelity/downscale tradeoffs, any second provider and its credentials/cost/data policy. |
| Gateway capability gaps | Verified Host wire contracts support image-modality discovery, timed-question ownership or subagent-mode discovery. Provider callback code alone is insufficient. |

For another machine or a changed runtime/dependency tree, repeat the relevant portability and acceptance checks. Review the final tree/history before publication; the recorded Windows/Mac evidence applies to its tested builds and environments.

## Operating limits

The Runtime leaves DSH installation, app lifecycle, login, profiles and network settings with the operator. It requires human approval for escalation, retains conversation content at DSH and transports startup authorization only through the explicit private process handoff.

General provider failover, automatic image preprocessing, semantic search through prior conversation bodies and reuse based on similar wording remain deferred. npm distribution and native DSH bundle packaging need separate release decisions.
