## Summary

Describe the user-visible change and why it belongs in Codex-DSH-Orchestrator.

## Validation

- [ ] npm run check
- [ ] npm pack --dry-run
- [ ] Relevant live validation was run, or the reason it was not run is documented.

## Safety and compatibility

- [ ] No DSH credentials, session transcripts, private paths, or generated state are included.
- [ ] The bridge remains connect-only and does not start, stop, or reconfigure the DSH Web Host.
- [ ] Approval behavior remains human-gated.
- [ ] Runtime identifiers and MCP compatibility were preserved or a migration note was added.
- [ ] README, architecture, changelog, and attribution documents were updated when needed.
