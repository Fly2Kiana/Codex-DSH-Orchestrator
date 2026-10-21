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
  replayed internally after a lost response. Missing/method-incompatible RPC
  endpoints are protocol errors, not reconnectable network outages.
- Named Gateway RPCs map to the existing caller tools. Prompt correlation uses
  the Gateway's durable `requestId`. History pages use a cut obtained from a
  verified follow opening, not an invented cursor or unbounded polling.
- Only mapped roots are followed. Ordinary approvals/questions are correlated to
  the owning event generation; a human reply is required and sent at most once.
  Other sessions' requests are delegated to the Host's next answerer, never
  granted. Settled/cancelled event identities cannot be reintroduced by duplicate
  delivery in that generation. The identity history is bounded; exhaustion ends
  observation instead of forgetting identities and allowing replay. Cancelling
  an observation does not cancel the DSH task.
- Read-only doctor deliberately does **not** authenticate or create an API Peer.
  Its Gateway result is `not_probed`, not a fabricated connection success.

## Capability boundaries

- Account and API-key providers are distinct. Flash supports the current
  `deepseek-flash` id as well as the verified legacy id. Pro remains a distinct
  advertised route; unsupported efforts or ambiguous providers are errors.
- Model inspection requires an exact `modelSelection` projection. An omitted
  projection does not prove the session inherits the global default. Only an
  explicitly empty selection projection permits that default to be used.
- Explicit model selection may persist as the Host's global default. Use
  `inherit` for an installation smoke test unless a model change was approved.
- `session/modelCatalog` in the targeted release omits input modalities. Modern
  Flash Vision therefore remains unavailable without explicit capability
  evidence. Do not infer active image support from the display name or silently
  send a visual task to a text-only route. A verified same-provider legacy vision
  route may still be used when a newer Flash lacks image evidence. The historical
  exception belongs only to its exact official provider/model pair and never
  overrides an explicit text-only declaration. The separate `llm/discoverModels`
  draft API is not a substitute: the built-in providers do not register its
  callback, and the bridge does not interrogate providers or ask for their keys.
- Queue snapshots and subagent-mode discovery are not yet mapped and are
  reported unavailable, not empty/supported. Timed question wait claims are not
  implemented; those requests stay with the Host's human answerer. Do not
  auto-approve, synthesize unsupported capabilities, or change DSH permissions.
- The bridge does not launch, stop, restart, log in to, or reconfigure Desktop.
  Actual Windows live validation and provider/vision tests require their own
  operator approval and an already running authorized Host.

## Qualification and outstanding gates

The Windows installed-program metadata and read-only process/listener discovery
were checked against Desktop `0.2.1-rc.2`. Read-only package-manifest inspection
also confirmed bundled `@deepseek-ai/dsh` and `@deepseek-ai/dsh-desktop-host`
at `0.2.1-rc.2`; no packaged code was executed. Its bundled tools manifest declares
Node `24.21.0` and pnpm `11.28.5`. This checks installation identity/discovery,
not Host admission, the active account catalog, or model inference. No model
request is required for these checks.

The Gateway runtime reports a separate `testedProtocolContract`; its
`testedAgainstDshVersion` is `null`, not the legacy `0.1.0-rc.6` qualification.
An operator-declared version is not promoted into verified compatibility.

The current hardening checkpoint passes build and 243 deterministic tests on
Windows with Node `26.7.0`. Package dry-run contains 107 expected entries and
no runtime credentials or maintenance state. CI includes Node 22/24/26 on
Ubuntu/Windows/macOS; a matrix declaration alone is not a successful CI result.
These checks use synthetic HTTP/WebSocket Hosts, never inference providers.

Before calling this adapter live-qualified, separately approve installation,
provide the supported launch credential, restart the caller, and qualify a
disposable non-visual task and same-session follow-up. Model/vision requests
require separate authorization. Do not consume provider tokens merely to check
whether a route works. Native vision capability discovery, queue snapshots,
timed-question ownership and subagent-mode discovery remain explicit gaps.

## Upstream contracts

- [Connection](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/client/connection/README.md)
- [Gateway stream protocol](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/api/gateway/src/stream-protocol.ts)
- [Session Remote types](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/api/session-controller/src/types.ts)
