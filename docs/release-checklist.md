# Release checklist

## Identity and source inventory

- Keep the English/Chinese README consistent and link [Project overview](project-overview.md), architecture, validation and contribution guidance.
- Preserve `LICENSE`, `NOTICE`, MIT terms and visible [dsh-Agentlink attribution](https://github.com/hootandy321/dsh-Agentlink).
- Describe the shared source as a Codex-to-DSH orchestration/MCP bridge with Windows/macOS official Desktop support; identify which build and environment were tested.
- Keep `package.json` private. npm distribution requires its own reviewed release decision.
- Exclude `node_modules/`, local `dist/`, generated `.agents/skills/codex-dsh-orchestrator/`, bridge state, credentials, logs and archives from the tracked source release. Package preview intentionally includes built `dist/`.

## Privacy and provenance

Inspect the exact candidate tree and its newly reachable history for personal paths, internal hostnames, credentials, private keys, real identifiers and internal maintenance material. A corrected tree can still leave sensitive history reachable.

Review third-party licenses and copied assets. If sensitive material is found, stop publication, record its history exposure and obtain approval for the proposed correction. Keep internal plans and approval/backup records outside the public payload; review a deliberate source diff rather than blindly merging private maintenance history.

## Candidate and automated gate

Choose the release version after scope approval. Keep package version, changelog, tag and release notes consistent; documentation work alone does not create a release.

From a clean checkout of the final candidate:

```sh
npm ci
npm run check
npm pack --dry-run --ignore-scripts
git diff --check
```

Record the SHA/tree, resolved dependency versions, build/test counts, package inventory and Git cleanliness. Review dependency advisories without automatic remediation.

Require that exact candidate's CI on Ubuntu, Windows and macOS with Node 22/24/26, plus applicable CodeQL review. Separate these results from historical CI and previously accepted test-only findings.

The alpha.6 runtime source `85fd145` has the Windows/Mac minimal live evidence in [Validation](validation.md). Public source `89bdd59` also passed nine-job CI, both CodeQL analyses and its author-policy check. For subsequent documentation-only commits, record their own GitHub checks without repeating unchanged runtime qualification. Private Review snapshots use their CI results; they do not replace the public CodeQL evidence.

## Same-candidate Windows/Mac acceptance

Follow [Validation](validation.md) on each platform:

1. Record actual caller, Desktop/core, Node and installed bridge/Skill identity.
2. Obtain installation/downtime approval, back up the intended files and keep the old installation.
3. Apply only reviewed targets. Use the operator-controlled startup handoff after finishing active tasks; keep the startup terminal open.
4. Confirm MCP/Skill loading and connection-only Gateway admission.
5. After model-use approval, run one inherited read-only disposable task, then a same-root follow-up.
6. Check final answers, file hashes, claim release and absence of unexpected model/approval behavior. Record Desktop UI visibility separately.

Native vision, ModLens, extra callers or broader interaction tests require their own scope and budget. Missing evidence must remain a stated limit.

## Release review

- Keep Host lifecycle, login, permissions and provider credentials with the operator. Retain human approval for escalation and explicit review before model-default changes.
- Explain installer replacements, restart requirements, Skill scope, authorization lifetime and rollback.
- Use the approved maintainer identity and squash-only PR path. Keep the required author status and existing CI/CodeQL protection in place.
- Record implemented capabilities and remaining gaps without promoting a protocol reference or operator declaration into a verified product version.
- Review the final public diff and reachable history before requesting approval to push, open/merge a PR, create a tag or publish a release.
- After approved publication, inspect the landing page, links, release notes and source archive from a clean user-facing view.

Record deferred work in the [roadmap](deferred-roadmap.md). Re-check upstream attribution and dependency alerts at each release.
