---
id: idle-background-task-qualifier
description: An idle chat says why it is idle when its provider is parked on work it started, and stops saying so when that stops being true.
areas: [cross-surface]
surfaces: [client, server, web]
---

# Idle background-task qualifier

Validate the `Idle · Background task` qualifier end to end: it appears when an
agent is parked on work it launched, disappears when a turn starts, disappears
when the work ends, and decays on its own when the client stops reporting.

The qualifier exists because "Idle" alone reads as *finished, nothing happens
unless you say something*, which is wrong for an agent that will wake itself
up. That framing also sets the bar for failure: a qualifier that is on when
nothing is running is worse than no qualifier at all, because it moves the lie
rather than removing it, and it makes plain `Idle` the rare state.

## The failure this case exists to catch

Ask first whether the marker is on for the right reason. Take an ordinary
agent, let it finish a turn with no background work outstanding, and read the
row. It must say plain `Idle`.

That check is not academic. The signal underneath is a process probe, and a
provider keeps long-lived children that have nothing to do with a turn — a
stdio MCP server is spawned at session start and lives for the whole session.
A probe that answers "does the provider have any child" is therefore true for
every MCP-configured agent, forever. Prefer a host where at least one agent has
an MCP server configured; if none does, say so in the report rather than
reporting `PASS` on a host that cannot see this class of defect.

## The sequence to walk

Give an agent a message that makes it launch background work and then finish
its turn — the work outlives the turn. Then read the sidebar row, the compose
bar and the chat row at each edge:

- while the turn runs — `Working`, no qualifier;
- after the turn closes with the work still running — `Idle · Background task`;
- when a new turn starts — `Working`, qualifier gone;
- once the work finishes and the agent settles — plain `Idle`.

Then kill the client without a clean shutdown. The qualifier must disappear on
its own within the runtime freshness window; a marker that survives a dead
client is asserting local state nobody is maintaining.

## Credible evidence

Read the composite status the API returns, not only the rendered row, and tie
each sample to the same `(agent, chat)` pair. A chat whose row shows the
qualifier next to any state other than `Idle` is a failure — `Offline ·
Background task` in particular means the qualifier escaped the state it is
supposed to be a footnote on.

Prefer a real provider with a real background task. A synthetic frame proves
the wire, the persistence and the rendering, but it cannot tell you whether the
client's own signal means what it claims, which is where this feature's
interesting failure lives — say which of the two you did.

Report `BLOCKED` or `INCONCLUSIVE` rather than `PASS` when background work
cannot be launched on a real provider, or when the composite status cannot be
observed apart from the timeline.

## Related

`packages/qa/cases/runtime/provider-owned-turn-status.md` covers the Working
half of the same status contract.
