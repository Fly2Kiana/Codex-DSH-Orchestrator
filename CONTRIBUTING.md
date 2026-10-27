# Contributing

Thanks for helping improve Codex-DSH-Orchestrator. This project is a Codex-first MCP integration for the official DSH Web Host, with a shared dsh-Agentlink-derived runtime; it is not a DSH Cordis bundle.

## Development setup

Requirements:

- Node.js 22 or newer
- npm
- DSH only for live compatibility checks; the unit test suite uses local mock hosts

From a fresh checkout:

```bash
npm ci
npm run check
```

Useful commands:

```bash
npm run dev
npm run doctor
npm test
npm run build
```

`dist/` is generated and intentionally ignored. A package tarball builds and validates it through the `prepack` script.

## Change expectations

- Preserve the connect-only Host lifecycle: the bridge does not start, daemonize, stop, or reconfigure `dsh web`.
- Never persist prompts, assistant messages, tool arguments/results, question bodies, or approval bodies in bridge state.
- Never auto-allow a DSH approval. Keep `allow_once` behind the supervising human/Codex approval boundary.
- Preserve fresh Host reads before mutations and explicit `stale_view` handling.
- Keep workspace claims cooperative and explicit; do not describe them as OS-level locking.
- Add or update tests for externally visible behavior.
- Update the README when changing MCP tools, environment variables, compatibility assumptions, or limitations.

## DSH compatibility changes

DSH is in developer preview. A compatibility update should record:

- the exact DSH CLI version tested;
- which Host capabilities were probed;
- unit-test results;
- the live acceptance steps in [`docs/validation.md`](docs/validation.md);
- any behavior that remains inferred or unverified.

Do not generalize one successful local run into compatibility with untested versions.

## Pull requests

Only the maintainer `Fly2Kiana` (GitHub account ID `171018150`) is currently approved for commit attribution in `main`. Use `Fly2Kiana <171018150+Fly2Kiana@users.noreply.github.com>`; a matching display name alone does not pass the author check. Additional authors require the owner's explicit approval before changing the policy. The workflow never adds identities automatically.

Dependency bots can continue to report security updates and open PRs. Their commits are not merged directly: after review, the maintainer reintegrates useful changes under the approved identity and records the original PR as their source. Preserve upstream LICENSE/NOTICE attribution.

Main accepts squash merges only, with the required author-policy status alongside existing checks. The policy checks all PR commit authors, linked GitHub account IDs and coauthor trailers, including the prospective squash title/body. Its privileged PR workflow uses trusted base code and reads metadata without executing PR code. Main pushes also scan reachable author history. Author metadata checks, GitHub account attribution and cached Contributors displays are separate; the check is not a cryptographic authorship proof.

Before opening a pull request:

```bash
npm ci
npm run check
npm pack --dry-run
```

Keep pull requests focused. Do not commit `node_modules/`, `dist/`, local bridge state, `.env` files, DSH credentials, or session transcripts.
