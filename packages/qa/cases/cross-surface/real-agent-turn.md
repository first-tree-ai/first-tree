---
id: real-agent-turn
description: Verify the full product loop end-to-end — a message to a bound agent triggers a real, provider-authenticated model turn that posts a correct reply back to the chat.
areas: [cross-surface]
surfaces: [server, client, cli]
---

# Real Agent Turn

## Goal

Verify the complete cross-process product loop end-to-end: an authenticated client daemon receives an agent-targeted
message over WebSocket, runs a **real provider-authenticated model turn**, and posts a correct reply back to the chat.
This documents a **manual** model-turn QA slice — the deepest cross-process behavior, the model turn itself, not just
delivery. Scope note: `@first-tree/qa` cases are non-executable, agent-run prompts, not an automated runner or CI gate.
`system/cloud/release/verification.md` defines the gap as *missing automated cross-process verification*, so this case
**reduces risk via a repeatable manual check but does not close that gap** — release and review decisions must still
treat automated cross-process coverage as unguarded until a CI-gated (or scheduled-run) replacement lands and the
release node is updated.

This case extends `authenticated-ws-inbox-delivery` (which stops at delivery + session start). Use it when a release
candidate must prove a real agent can actually answer over the real runtime path.

## Preconditions

- Everything in `authenticated-ws-inbox-delivery` (isolated run cell, dev-auth bootstrap, authenticated WS registration,
  a bound agent), plus:
- **Provider `one-turn-ready`.** A launchable, authenticated provider must be available to the run-cell runtime. Bridge
  only the minimum credential material, read-only, per the provider policy — e.g. copy a single `auth.json` into the
  run-local provider home; never mount the full host provider home. Use a runtime whose credential you can bridge and
  whose binary runs in the run cell (a Linux-compatible bundled/installed provider). If `one-turn-ready` cannot be
  established, this case is `BLOCKED`, not `FAIL`.
- Create the agent with the matching runtime, e.g. `agent create <name> --type agent --runtime <provider> --client-id
  <clientId>` (note: `--type` is `human|agent`; the provider is `--runtime`).

## Operate

- `operate external-service`: bridge the minimal read-only provider credential into the run-local provider home before
  the turn; remove it after the run.
- `operate http-api`: as the bootstrapped user, send the agent a deterministic probe, e.g. `POST /orgs/<orgId>/chats`
  with an `initialMessage` asking the agent to reply with a fixed token.
- `operate runtime-process`: keep the foreground daemon running so the turn executes and the reply is dispatched.

## Observe

- `observe runtime-event`: the daemon log shows the provider turn accepted (e.g. `codex app-server turn started …
  accepted=1`) — the bridged credential authenticated (no immediate process-exit / auth failure).
- `observe http-api`: the chat gains a second message authored by the agent, containing the requested token. The agent
  reply is an ordinary chat message and carries the product's routing mention prefix (`@<recipient> …`); assert on the
  token content, not on byte-for-byte equality with the prompt.

If wire details change during product work, follow the current typed schema, but keep the evidence on the same behavior:
a real authenticated turn produced a correct agent reply over the runtime path.

## Expected Result

`PASS`: the provider turn was accepted with the bridged credential and the agent posted a correct reply (the requested
token) back to the chat.

`FAIL`: a reproducible product defect — a `one-turn-ready` provider is available but the turn crashes, never dispatches a
reply, or the reply is wrong in a reproducible way (a single non-reproducible model deviation is `INCONCLUSIVE`, not
`FAIL`).

`BLOCKED`: no provider can be made `one-turn-ready` in the run cell (missing/auth-incapable provider). This is the gap,
not a product failure.

`INCONCLUSIVE`: the turn was interrupted, unstable, or the reply could not be attributed to the target ref/run.

## Evidence

Keep the daemon turn-accepted log line and the chat messages showing the agent's reply token. Redact all credentials;
never store the bridged auth material in artifacts, and remove it from the run cell after the turn.
