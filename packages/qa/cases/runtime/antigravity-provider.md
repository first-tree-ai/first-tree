---
id: antigravity-provider
description: Validate the Google Antigravity CLI runtime provider end to end — headless stream protocol, conversation resume, managed workspace projection, and fail-closed recovery.
areas: [runtime]
surfaces: [web, cli, client]
---

# Google Antigravity Runtime Provider

## Goal

Confirm that an agent bound to `antigravity` runs through the operator-owned
Google Antigravity CLI in headless `stream-json` mode, preserves the provider
conversation across turns, and keeps First Tree's lifecycle, workspace, and
failure boundaries intact.

Use this case when the Antigravity handler, capability probe, provider catalog,
or managed MCP projection changes.

## Preconditions

- Run in the isolated QA run cell selected by the plan; do not use the
  operator checkout.
- The host is macOS or Linux and has the official `agy` CLI installed with
  `curl -fsSL https://antigravity.google/cli/install.sh | bash`.
- The operator has completed provider-owned setup by running `agy` once. Do
  not copy or inspect provider credential files.
- Do not modify the tested product object; fixtures and config stay in the run
  cell.

## Checklist

- Capability: without `agy`, the client reports setup-incomplete with the
  official installer; with it installed, probing reports the executable path.
  Probing must not launch `agy`, open auth, or read credentials.
- Turn posture: an authenticated turn starts from the agent workspace, sends
  the prompt as one JSON `user` event on stdin, and uses `--output-format
  stream-json`, `--input-format stream-json`, and the explicit unattended
  permission policy. The prompt must not appear in argv.
- Conversation continuity: the first successful result adopts exactly one
  provider conversation id; the next turn passes exactly that opaque id with
  `--conversation`. A missing, duplicate, or changed id fails closed rather
  than silently starting a replacement conversation.
- Lifecycle: queued injections run FIFO one process at a time; suspend or
  shutdown terminates the process and redelivers unacknowledged work without
  deleting the agent workspace.
- Managed workspace: managed Skills use `.agents/skills`; managed MCP servers
  are projected into `.agents/mcp_config.json` under the reserved
  `first-tree-managed-*` namespace, preserve user entries, and are removed on
  config removal. A modified managed entry or reserved-name collision fails
  closed.
- Auth and failure recovery: a provider auth failure points the operator to
  `agy`, while a missing CLI points to installation. Malformed stream output,
  non-success result status, and resume identity mismatch produce a terminal
  provider failure; no silent retry can create a second conversation.
- Platform gate: Windows is reported unavailable in V1 because the default
  process supervisor does not yet provide the required pre-admission child
  tree containment.

## Expected Result

`PASS` means the live authenticated turn, exact conversation resume, FIFO
queueing, workspace projections, and recovery surfaces all match the checks
above without exposing provider credentials.

`BLOCKED` means `agy`, provider auth, network access, or a supported host is
unavailable; exercise deterministic parser/probe tests separately and do not
turn a missing external prerequisite into a product failure.

## Evidence

Keep capability snapshots, sanitized argv/cwd observations, conversation ids,
MCP/Skills projection listings, and the runtime failure notice. Redact prompts,
headers, account identifiers, and all provider credentials.
