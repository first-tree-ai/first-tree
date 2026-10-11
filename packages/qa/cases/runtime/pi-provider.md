---
id: pi-provider
description: Validate the external Pi CLI RPC provider end to end — long-lived RPC session, steer/abort settlement, auth, skills, and process drain.
areas: [runtime]
surfaces: [web, cli, server, client]
---

# Pi Runtime Provider

## Goal

Confirm that an agent bound to `pi` runs through the official external `pi --mode rpc`
JSONL protocol, reuses provider-owned host-local authentication without giving First Tree
token custody, and preserves First Tree's delivery, session, configuration, Context Tree I/O,
and process-drain contracts.

Use this case when the Pi handler, RPC client, binary resolver, capability probe, model
surface, skills projection, or provider supervisor changes.

## Preconditions

- Run in the isolated QA cell selected by the plan: Docker plus a temporary source worktree, with an explicit native
  bridge only where the OS process authority cannot live inside Docker. Never modify the operator checkout.
- Install a Pi version in the product's supported `>=0.80.5` range (any stable 0.x or 1.x release) on the client host using
  `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`, then complete provider-owned setup by running
  `pi` then `/login`. The test may prove the login by completing a real turn, but must not read, copy, print, or
  archive provider credential files.
- Use disposable source and Context Tree fixtures. Provider tool calls must not modify the product checkout.
- Windows acceptance requires the separately owner-reviewed drain-authority decision and a product Job Object
  supervisor. Until both exist, the Windows branch must fail closed before any Pi invocation and cannot PASS.
- V1 has no native MCP: keep the agent `mcpServers` empty. A non-empty set is a deterministic configuration failure.

## Checklist

- Capability: the connected client reports `pi` as `missing` or `ok` solely from the same binary resolver used by the
  handler. Re-probing must not launch Pi, inspect auth/config, list models, or contact a model provider. Windows stays
  unavailable.
- Provider selection: Web and CLI expose Pi only on a client advertising the capability. The config defaults to an empty
  model, accepts an exact provider-native `provider/model` or `provider/model:<thinking>` string, and exposes no
  separate reasoning-effort control. Empty model keeps an existing persisted Pi session's model; only a brand-new
  session uses Pi's local default (no forced host-default reset on resume).
- Runtime gates: the first active use launches `pi --version` through the provider supervisor and requires a stable
  release at or above `0.80.5` (the RPC spawn contract is stable across 0.x and 1.x); only below-`0.80.5`, prerelease,
  and unparseable output fail closed. Transient launch timeouts remain retryable.
- Spawn contract: observe one long-lived
  `pi --mode rpc --no-extensions --no-skills --skill <cwd>/.agents/skills --no-prompt-templates --no-approve
  --tools read,bash,edit,write,grep,find,ls --session-id <stable-id>
  --session-dir <cwd>/.first-tree-workspace/pi-sessions` process per active `(agent, chat)`,
  plus `--model` only when configured. Do **not** pass `--offline`: native `find` relies on Pi's
  provider-owned `fd` helper acquisition, which offline mode blocks on a clean supported install.
  Child env must force `PI_SKIP_VERSION_CHECK=1` and `PI_TELEMETRY=0` (overriding host/payload); First Tree
  must not inject `PI_OFFLINE` by default, but an operator-provided truthy `PI_OFFLINE` is preserved as an
  advanced override that requires helpers already available. Prompt text rides JSONL stdin as a command object
  (`{"id","type":"prompt","message"}`), never as a wrapped `{type:"request",command,params}` envelope and never as argv.
- Active config: while a chat is live, change model/env/Skills (and attempt a newly non-empty MCP set). The next idle
  turn must read the latest immutable config snapshot, reconcile managed Skills, restart the supervised RPC process for
  spawn-scoped changes against the same stable session id, and fail closed before prompt acceptance when MCP becomes
  non-empty. First Tree must not mutate operator-global Pi config.
- Child boundary: observe the First Tree identity/drain envelope and runtime-session token-file path in the child
  environment. Token contents and provider credentials must not enter argv, logs, Server data, or retained evidence.
- Real turn: verify normalized assistant, thinking, tool, token-usage, and successful terminal events. Turn completion
  is only `agent_settled` — never treat `agent_end` as delivery settlement. Prove disposable lowercase Pi tools
  (`read`/`grep`/`find`/`ls`/`write`/`edit`/`bash`) with stable `toolCallId` correlation and Context Tree git-status
  delta refs on successful write tools.
- Protocol failure: malformed or truncated JSONL and process-exit-before-settlement must reject the settlement waiter
  into the shared failure/custody path (no hang). A prompt-response timeout after the command line was written is
  unknown/`provider_entered` custody: fence the transport and do not auto-resend the same prompt as pre-provider.
- Session and inject: the session id survives suspend/resume plus process restart against the same `--session-dir`
  through First Tree's persisted mapping (the id is derived from the first inbound message, never recomputed per turn).
  A successful `session:terminate` / Reset retires the provider session at a durable mapping+tombstone boundary: the
  next addressed message — including same-row redelivery after Client restart when the first turn settled but ACK
  never committed — must start a fresh Pi session identity with no access to the discarded transcript/model state,
  while crash-redelivery of the same uncommitted first message *before* any Reset keeps the same identity. When a
  Reset registry flush fails, provider route admission stays fenced until a successful terminate retry; an intervening
  delivery must not start/resume/inject or ACK, cannot consume the pending Reset nonce, and must not open repeated
  same-socket inbox recovery that trips the server's no-progress circuit. A non-persistence terminate failure
  (teardown / quiesce) that rejects before the durable flush similarly leaves parked rows parked with zero
  recover/provider/ACK until a genuine successful terminate retry. After that successful Reset apply is
  `session:command:applied` and the server finishes Reset finalization (`session:command:finalized` / session
  `evicted`), that exact durable row recovers on the same socket (no reconnect, no HTTP conflict, no no-progress
  circuit) into one fresh nonce-derived Pi identity — apply/finalization precedes the single recovery.
- Reset fence window: the window between `session:command:applied` and that generation's exact receipted terminal
  disposition (`session:command:finalized` or `session:command:aborted`) is closed even for a clean Reset that had
  nothing queued when it applied. A message delivered inside that window must park — no start/resume/inject, no ACK,
  no same-socket recovery — and must settle into one fresh nonce-derived Pi identity only after that exact disposition
  is accepted. On the success path the clean post-apply/pre-finalized window still ends only on matching `finalized`.
- Reset generation authority: refs that join one in-flight terminate are aliases of a single generation, so either
  one's exact receipted terminal disposition (`finalized` or `aborted`) releases the fence once and its duplicate is
  idempotent, while a superseded or unknown ref is answered `released: false` and releases nothing. A stale-reconcile
  terminate carries no generation and must not release an armed one. When a terminal disposition is lost after a
  durable eviction, the operator's retried Reset (a NEW terminate ref) is what releases the row parked by the abandoned
  attempt — exactly once, on the same socket.
- Post-apply disposition boundary: once `session:command:applied` reports `applied: true`, the provider session is
  already gone, so every Server outcome for that terminate ref must reach a terminal wire disposition before the
  operator's HTTP result. A durable eviction sends `session:command:finalized`; a Server exit that does not commit the
  eviction (the addressed row re-activating the chat inside the ACK/finalize window, a refused route, a rolled-back
  cleanup) sends `session:command:aborted` with its reason. An abort lifts only that exact generation: it never restores
  the retired provider mapping or the discarded transcript, and the row it releases must still enter one fresh
  nonce-derived Pi identity through a single same-socket recovery — no extra Pause/Reset, no reconnect, no no-progress
  circuit. Before that exact disposition arrives nothing may start/resume/inject, recover, or ACK. Both dispositions
  carry the same generation authority as `finalized`: duplicates are idempotent, and a stale, superseded, or
  foreign-agent ref is answered `released: false` and lifts nothing. Delivery and receipt are scoped to the Client
  identity that applied, so a route change after the apply still converges instead of stranding the fence, and a
  disposition whose receipt never lands fails the operator's Reset closed rather than reporting success.
- Reset protocol version: Reset is offered and accepted only when client and server both advertise the composite
  `wsSessionResetV1` capability (welcome before `auth:ok`, answered in `client:register`). A client that declares only
  the legacy apply-only flag is refused with 503 before anything destructive is applied, and a current client never
  advertises that legacy flag, so an older server cannot mistake it for a pre-v1 peer and start a Reset whose fence it
  will never lift. The capability is revalidated at command delivery and at apply-ACK, not only at the HTTP preflight:
  a same-client, same-instance reconnect that comes back without `wsSessionResetV1` receives no terminate frame (direct
  or fanned out) and cannot persist or resolve the apply-ACK. Both post-apply terminal dispositions (`finalized` and
  `aborted`) stay identity-scoped on delivery and receipt — original applying Client identity, not the current agent
  route or live Reset capability — so a client that already applied still converges if its route or advertised
  capability changes afterwards.
  Inject during streaming
  uses `steer`; non-streaming input starts the next prompt. Accepted steered messages keep DeliveryToken custody
  through `agent_settled`. A settle-vs-steer rejection queues the inbound message for the next prompt rather than
  fabricating terminal-rejection evidence.
- Abort / suspend: abort mid-stream, wait for both the abort response and `agent_settled` in either order, then close
  stdin/process cleanly without orphaning the RPC child.
- Managed Skills: projected Skills live under `.agents/skills` (shared Codex native root). Confirm `--no-skills --skill
  ...` still discovers a disposable First Tree skill. Do not create `.pi/skills`.
- Auth and failure custody: a logged-out real turn produces a durable error notice directing the operator to run `pi`
  then `/login`; First Tree offers no in-product OAuth and never reads Pi credentials. A `success:false` preflight
  without `agent_settled` must not hang. Terminal failures are consumed only after the durable notice.
- MCP boundary: a non-empty effective `mcpServers` set fails as a visible configuration failure before a prompt is
  launched, including on an already-live chat. An empty set proceeds normally.
- Context Tree I/O: Pi `read`/`grep`/`find`/`ls` record `pi_read_tool`; `write`/`edit` record `pi_write_tool`;
  qualifying `bash` commands produce the provider-neutral shell evidence with repo/path qualification; write tools also
  surface git-status deltas.
- Process safety: on POSIX, prove the existing environment-attributed OS process-tree drain observes and clears the Pi
  root and descendants. On Windows, prove pre-admission Job Object authority before any invocation. Child registry
  evidence is diagnostic only and must never authorize a client switch.

## Expected Result

`PASS` requires a real authenticated two-turn First Tree/Pi RPC flow with session continuity, steer or queued inject
evidence (including accepted-steer token settlement), a deterministic tool effect, Skills evidence under
`.agents/skills`, correct delivery and failure custody, normalized events, Context Tree I/O, and platform-accepted
process-drain proof.

`FAIL` includes prompt text in argv, an unconditional `--offline` spawn that blocks native `find` helper acquisition on a
clean supported install, missing forced `PI_SKIP_VERSION_CHECK=1` / `PI_TELEMETRY=0` child env, the rejected
`{type:"request"}` envelope, credentials retained by First Tree, an unadmitted runtime process, silent model fallback,
treating `agent_end` as settlement, hanging on credential preflight or corrupted JSONL, silent non-empty MCP acceptance,
unsafe side-effect replay, auto-resending a timed-out prompt as pre-provider, terminal failure consumed before its
durable notice, a message admitted between Reset `applied` and `finalized`, a `finalized` receipt that claims a
release the client did not perform, a truthfully applied Reset whose Server outcome returns with no receipted
`finalized` or `aborted` disposition (leaving the chat fenced), an abort that restores the retired provider session or
lifts a newer generation, a Reset offered across mismatched protocol versions, or a client switch authorized
by child registry alone.

`BLOCKED` means a compatible CLI, provider login/entitlement/network, isolated platform bridge, owner-reviewed Windows
drain authority, or product Job supervisor is absent. Unit tests and a raw Pi CLI probe alone do not turn a blocked
First Tree product branch into PASS. `INCONCLUSIVE` means a live turn ran but retained evidence cannot distinguish the
claimed behavior.

## Evidence

Keep sanitized capability snapshots, exact binary/version and argv/cwd observations, session ID continuity across
suspend/resume, event-kind sequence including `agent_settled`, disposable file hashes, Context Tree rows,
delivery/retry/notice transitions, and authoritative drain receipts. Never retain provider request bodies, credential
files, runtime-session token contents, private prompts, or raw stderr before redaction.
