---
id: provider-owned-turn-status
description: A turn the provider starts on its own reads as Working from its boundary and returns to Idle when it closes.
areas: [runtime]
surfaces: [client, server, web]
---

# Provider-owned turn status

Validate that an agent reads as **Working** for a turn nobody sent it a message
for, and returns to **Idle** when that turn closes.

Not every turn begins with a delivery. A provider re-invokes itself when work
it launched finishes — a background task completing is the common case — and
that turn runs tools, produces output, and spends tokens with no inbox entry
behind it. The failure this case exists to catch is silent and looks like
nothing: the agent works normally while every status surface says Idle, so a
human watching concludes it stalled.

## Preconditions

An isolated test agent with a live client, and a provider that can be driven
to start a turn without an inbound message. Deliver one ordinary message, have
the agent launch background work inside that turn, and let the turn close
while the background work continues. The wake-up that follows is the turn
under test. Do not simulate it by sending a second message — that restores the
inbox custody whose absence is the whole point, and the case would pass
against the bug.

## What to observe

Watch the chat right-sidebar row, the compose status bar, and the chat-list row
across the whole sequence. Read them against the server's composite status for
the same `(agent, chat)` rather than against the timeline alone, since live
activity and composite status come from different paths.

The turn is Working from its **boundary**, not from its first visible output.
The head of a turn is model latency with nothing displayable in it, and a row
that only lights up once text or a tool call appears will look correct in a
quick smoke test while still being wrong for exactly the turns this case
covers. If the provider exposes a turn-start event, check the window between
that event and the first assistant output specifically.

When the turn closes, the row returns to Idle without needing another message,
and stays Idle through whatever out-of-turn traffic the provider emits
afterwards. Late token-usage accounting for a closed turn is the known
instance: it must not resurrect Working, and a chat left Working after its turn
ended is a failure even though the transient display looked right earlier.

## Credible evidence

A result is credible when the composite status is sampled at each edge — before
the wake-up, during the woken turn, and after it closes — and the samples are
tied to the same chat and agent as the observed turn. A single screenshot of a
Working badge proves nothing about the boundary or the return to Idle.

Report `BLOCKED` or `INCONCLUSIVE` rather than `PASS` when the provider cannot
be made to start a turn on its own, or when composite status cannot be observed
independently of the live-activity timeline.

## Related

`sessions-and-status` in the Context Tree carries the durable rule: turn
liveness follows the provider producing for the chat, whoever triggered it, and
delivery bookkeeping is not a substitute.
