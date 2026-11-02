---
id: runtime-external-context-tree-cli
description: Validate external Context Tree mode with the bundled context-tree 1.x CLI across login, session start, upgrade from 0.1, and revert.
areas: [runtime]
surfaces: [cli, client]
---

# External Context Tree Mode (context-tree 1.x)

## Goal

Confirm that a machine with `context_tree.repository` set gives each Claude Code
and Codex Agent workspace the bundled `context-tree-*` Skills, a connection to
the configured tree, and a `context-tree` command from the same release, and
that an Agent can read the tree and publish a settled write through them.

Use this case for release qualification when the bundled CLI version, the
per-workspace Skill or connection setup, the shim, or the external-mode
briefing changes. Payload parsing, ref resolution, Skill-name scoping, and
revert bookkeeping belong in product tests; this case validates the real
provider, CLI artifact, GitHub boundary, and Agent behavior together.

## Preconditions

- Run the target release artifact in an isolated QA cell with real Claude Code
  and Codex provider bridges.
- Use a throwaway private GitHub tree repository with a valid 1.x root
  `NODE.md` and Git credentials available to the daemon (`gh auth setup-git`).
- Create at least two Agents before `login` and one after it.
- For the upgrade path, start from a cell that ran external mode on a release
  bundling context-tree 0.1.12, so `~/.claude/skills`, `~/.codex/skills`, the
  channel-bin shim, and `~/.context-tree/connections.json` hold 0.1 state.
- Establish provider readiness with `runtime-provider-readiness` first.

## Operate And Observe

- Set `context_tree.repository` (and once without, once with
  `context_tree.ref`) and run `login`. Confirm the login line names the CLI
  version and branch, and that every existing workspace has the Skills in
  `.claude/skills` and `.agents/skills` and a `.context-tree.json` declaring
  the repository and branch. `doctor` reports external mode with the version.
- Start a session for the Agent created after login. Confirm its workspace is
  set up at session start without another `login`.
- In a Claude Code and a Codex session, ask the Agent to read a stored
  decision, then to record a settled one. Confirm the read uses
  `context-tree-read`, the write finishes with `--publish`, and the commit lands
  on the configured branch of the tree repository.
- With a different `@first-tree-ai/context-tree` installed globally, confirm
  the Agent's `context-tree --version` is the bundled release.
- Upgrade path: install the target release over the 0.1 cell through the
  daemon's auto-update (no `login`). Confirm the first session removes First
  Tree's unedited 0.1 account-level Skills and its old channel shim, preserves
  hand-edited ones, and Agents load only the 1.x Skills.
- Change `context_tree.ref` and start a session. Confirm the workspace's
  declaration moves to the new branch and an Agent-connected tree, if any, is
  kept.
- Unset `context_tree.repository` and run `login`. Confirm the workspace Skills,
  First Tree's declarations, and the shim are gone, First Tree's Core Skills
  (including `context-tree-review` / `context-tree-audit`) are projected again,
  and admission still succeeds.

## Pass

- Every observation above holds on both providers, with no admission or
  projection failure and no Agent directed to a Skill that is not installed.

## Evidence

- `login` and `doctor` output, the relevant workspace file listings and
  `.context-tree.json` contents, provider transcripts of the read and write, and
  the published commit on the tree repository.
