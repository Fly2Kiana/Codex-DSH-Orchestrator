# Official Desktop Gateway adapter

This adapter targets the official `deepseek-ai/deepseek-harness` release
`dsh-v0.2.1-rc.2` (`687f282`). It is separate from the legacy rc.6 Host
adapter. Legacy remains the default; there is no automatic protocol fallback.
Automated mock-Host qualification is not real Desktop end-to-end qualification.

## Explicit setup

After building a reviewed checkout, preview without installing:

```sh
npm run setup -- --gateway --desktop-auto --dry-run
```

`--gateway` requires either Windows `--desktop-auto` or an explicit `--host`
origin. Existing MCP/Skill conflicts still require separate explicit replacement
flags. Merely developing the adapter does not authorize replacing an installation.

The generated Codex block selects `DSH_HOST_PROTOCOL="gateway"`, keeps human
approval prompts, and forwards the **name** `DSH_CONNECT_TOKEN` with `env_vars`.
It never stores a token value in TOML. The operator must supply a supported Host
launch token through the environment of the process launching the bridge.
Runtime-only `DSH_CONNECT_TOKEN_ENV` can name a different input variable, but the
setup command intentionally uses the default name. Do not put token values into
command arguments, prompts, source, screenshots, logs, or version control.

Obtaining an operator-supported launch credential from an actual Desktop
installation remains a live-qualification prerequisite. The bridge does not
extract it from Desktop memory, IPC, credential files, or browser cookies. A
connection token is not a provider API key.

## Connection and supervision

- Windows discovery recognizes the exact `DeepSeek Harness` executable and only
  its owned loopback listener. More than one candidate is an error. Discovery is
  not protocol verification and never scans arbitrary ports or exchanges tokens.
- The explicitly selected adapter exchanges the token at `/connect`, validates
  the same-origin Mux redirect and authority-bound API Cookie, and owns one API
  socket. Cookies remain in memory and separate from browser storage.
- Authentication refusal, missing authorization, and unsupported wire framing
  fail closed. They do not trigger background reauthentication or a legacy
  protocol fallback. Network observation may reconnect, but writes are never
  replayed internally after a lost response.
- Named Gateway RPCs map to the existing caller tools. Prompt correlation uses
  the Gateway's durable `requestId`. History pages use a cut obtained from a
  verified follow opening, not an invented cursor or unbounded polling.
- Only mapped roots are followed. Ordinary approvals/questions are correlated to
  the owning event generation; a human reply is required and sent at most once.
  Other sessions' requests are delegated to the Host's next answerer, never
  granted. Cancelling an observation does not cancel the DSH task.
- Read-only doctor deliberately does **not** authenticate or create an API Peer.
  Its Gateway result is `not_probed`, not a fabricated connection success.

## Capability boundaries

- Account and API-key providers are distinct. Flash supports the current
  `deepseek-flash` id as well as the verified legacy id. Pro remains a distinct
  advertised route; unsupported efforts or ambiguous providers are errors.
- Explicit model selection may persist as the Host's global default. Use
  `inherit` for an installation smoke test unless a model change was approved.
- `session/modelCatalog` in the targeted release omits input modalities. Modern
  Flash Vision therefore remains unavailable without explicit capability
  evidence. Do not infer active image support from the display name or silently
  send a visual task to a text-only route.
- Queue snapshots and subagent-mode discovery are not yet mapped and are
  reported unavailable, not empty/supported. Timed question wait claims are not
  implemented; those requests stay with the Host's human answerer. Do not
  auto-approve, synthesize unsupported capabilities, or change DSH permissions.
- The bridge does not launch, stop, restart, log in to, or reconfigure Desktop.
  Actual Windows live validation and provider/vision tests require their own
  operator approval and an already running authorized Host.

## Upstream contracts

- [Connection](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/README.md)
- [Gateway stream protocol](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/api/gateway/src/stream-protocol.ts)
- [Session Remote types](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/api/session-controller/src/types.ts)
