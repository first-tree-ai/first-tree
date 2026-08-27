---
id: context-tree-seed-managed-team-selection
description: Validate on an exact release head that a managed Context Tree Setup Chat seeds the exact owning Team from runtime-authored chat context, never from names or defaults, and that the Seed CLI preflight classifies authentication, Team access, server compatibility, and availability failures with stable codes on a self-hosted Server.
areas: [cross-surface]
surfaces: [cli, client, server]
---

# Context Tree Seed Managed Team Selection

## Goal

Confirm that a managed Context Tree setup flow running the exact build under
test resolves the Seed Team id only from runtime-authored chat context (or the
documented one-shot CLI fallback), uses that exact id for every Seed/init
preflight, and that the `tree seed` CLI reports actionable, stable failure
codes against a real self-hosted Server without leaking raw response bodies.

Use this case when the runtime Current Chat Context payload, the Seed skill's
managed Team resolution, or the `tree seed` CLI error classification changes.
Deterministic payload rendering, error mapping, and skill floor invariants
belong in product tests; this case validates the real runtime injection, the
real skill behavior in a live Setup Chat, and the real self-hosted Server
boundary together.

## Preconditions

- Install the exact CLI/client build under test (record the exact head SHA and
  the installed version) next to a real self-hosted First Tree Server. Use only
  throwaway Teams and credentials.
- Prepare two Teams on that Server: Team A, where the operator is an active
  Admin, and Team B, where the signed-in member is an ordinary member. Record
  both exact Team ids from server-side data, not from display names.
- Start a managed Context Tree Setup Chat (Settings → Getting Started) in
  Team A with a connected agent running the build under test.
- Keep a second agent or runtime on the previous release as the older-runtime
  control when available.

## Operate And Observe

- In the Team A Setup Chat, ask the agent to begin Context Tree setup. Confirm
  from the session transcript that the agent read the `organizationId` field of
  the runtime-authored `<first-tree-current-chat-context>` block and used that
  exact id in `first-tree tree seed --team <id> --json`. The id must match
  Team A's recorded id byte-for-byte; the chat title, topic, Team display name,
  workspace manifest, and account default Team must never appear as the Team
  argument.
- With the older-runtime control (a runtime whose chat context payload carries
  no `organizationId`), repeat the setup start. Confirm the agent runs exactly
  one `first-tree chat list --engagement all --chat "$FIRST_TREE_CHAT_ID" --json`,
  accepts the result only when exactly one item carries a non-empty
  `organizationId`, and otherwise stops and asks for the exact Team id before
  any Seed command.
- In the Team B Setup Chat (ordinary member), run the same start. The preflight
  must fail with `CONTEXT_TREE_SEED_NEEDS_ADMIN` naming Team B as the recovery
  anchor, and the agent must ask an active Admin of Team B instead of falling
  back to another Team.
- Against the self-hosted Server, exercise the CLI failure ladder directly and
  record the JSON envelope and exit code for each: an expired or revoked token
  (`CONTEXT_TREE_SEED_AUTHENTICATION_FAILED`, exit `3`), an ordinary member or
  a wrong Team id (`CONTEXT_TREE_SEED_TEAM_ACCESS_DENIED`, exit `3` — confirm
  the message does not reveal whether the Team exists), a Server old enough to
  lack the preflight route (`CONTEXT_TREE_SEED_SERVER_INCOMPATIBLE`, exit `1`),
  and a stopped or unreachable Server (`CONTEXT_TREE_SEED_PREFLIGHT_UNAVAILABLE`,
  exit `6`). No envelope may contain raw Server response bodies.
- Pass a legacy non-UUID self-hosted Team id to `tree seed --team` and confirm
  it is accepted as input (no UUID-format rejection) and fails or succeeds only
  on server-side authority.

Record the exact head SHA, CLI and Server versions, both Team ids, the
transcript excerpt showing where the agent sourced the Team id, every CLI
envelope with its exit code, and screenshots of the Setup Chat runs.

## Expected Result

`PASS`: the managed Setup Chat on the exact head seeds Team A using the
runtime-authored `organizationId` with no name/default substitution; the
older-runtime control uses exactly one exact-chat CLI query and fails closed to
a human question otherwise; Team B stops at `CONTEXT_TREE_SEED_NEEDS_ADMIN`;
and every CLI failure ladder step returns its documented code and exit code
with no raw-body leakage, including acceptance of a non-UUID Team id.

`FAIL`: any Seed preflight uses a Team id sourced from title, topic, display
name, manifest, default/current Team, or transcript text; the fallback performs
more than one query or proceeds on zero/ambiguous results; an error envelope
exposes a raw Server body; or a failure class returns the wrong code or exit
code.

`BLOCKED`: the exact build cannot be installed next to a self-hosted Server,
or two Teams with the required role split cannot be prepared.

`INCONCLUSIVE`: the transcript does not show where the Team id was sourced, or
failure-ladder evidence is missing for one or more classes.
