---
id: legacy-github-scan-launchd-retirement
description: Validate that a published-channel CLI safely retires only a task-owned legacy github-scan launchd runner and releases its listener.
areas: [runtime]
surfaces: [cli]
---

# Legacy GitHub-Scan Launchd Retirement

## Goal

Confirm through the shipped CLI boundary that a published-channel macOS CLI automatically retires the exact stranded
legacy github-scan launchd runner, removes its canonical plist only after launchd has evicted the label, and releases
`127.0.0.1:7878` without touching current prod, staging, or dev services. Also confirm that help is read-only and that a
second eligible action is safe after retirement.

The stable parser, matching, pagination, marker, and failure branches belong in product tests. This case owns the live
boundary those tests cannot prove: a release-shaped CLI entrypoint, the effective account home, real launchd state, an
attributable KeepAlive process, and an independently rebindable TCP port.

## Harness And Preconditions

Reach the repository's full `QA READY` gate before selecting this case. Build the exact target ref in a disposable
Docker-backed cell owned by a run-local bare clone and temporary git worktree, initialize every formal product surface,
and keep run artifacts outside the tested repository. Launchd is the explicit native macOS bridge; it does not replace
the Docker cell or reduce its readiness requirements.

Build the CLI with the repository's real release procedure for the staging channel and record the resulting artifact,
channel identity, version, commit, and digest. Exercise that built `first-tree-staging` entrypoint, not a source module,
dev-channel build, migration helper, or fake supervisor. Give each CLI invocation a run-local `FIRST_TREE_HOME` outside
the operator's channel homes and, where the entrypoint permits, a different run-local `HOME`. This isolates normal
staging state and distinguishes the trusted account lookup from environment-selected homes, but must not redirect the
migration: independently establish that the legacy root is derived from the effective account's canonical home and
remains `<effective-home>/.first-tree/github-scan/runner/` despite the overrides.

The native bridge may proceed only after a read-only, recorded preflight establishes all of the following:

- the effective UID, launchd `gui/<uid>` domain, and effective account home are unambiguous, and each existing component
  from that home through `.first-tree/github-scan/runner/launchd` is the expected directory rather than a symlink;
- the canonical launchd directory contains no pre-existing filename-valid legacy `.default` target, and the product's
  fixed retirement marker is absent; never use this case to clean up or probe a real stranded artifact;
- `127.0.0.1:7878` is free by both listener inspection and an actual temporary bind. If it is occupied, report `BLOCKED`
  and do not signal or kill the owner;
- current `first-tree`, `first-tree-staging`, and `first-tree-dev` launchd identities have been snapshotted where present,
  including exact labels, plist paths and hashes, `launchctl print` state, and attributable PIDs; and
- every path, label, helper, process, and directory that the run may create has a unique run identifier and is listed in
  a teardown manifest before the first mutation.

Snapshot any non-target legacy data and leave it byte-for-byte untouched. An unsafe path component, an existing
retirement marker or exact legacy candidate, an unattributable listener, insufficient permission, or any host state
that prevents unambiguous fixture ownership is a safety precondition failure. Stop `BLOCKED`; do not rename, repair,
boot out, unlink, or recursively remove host state to make the case runnable.

## Task-Owned Native Fixture

Create the listener helper and logs under the external QA run root. Create only the missing canonical directories that
the teardown manifest can prove belong to this run, and write one regular plist at the exact canonical legacy path. Its
filename and embedded `Label` must be the same unique
`com.first-tree.github-scan.runner.<run-id>.default` value, where the run identifier uses only the historical label's
allowed `[A-Za-z0-9._-]` characters. Its launchd domain must be the effective user's `gui/<uid>`, and its KeepAlive
program must bind only `127.0.0.1:7878` and remain alive until launchd unloads it.

Bootstrap that one label with launchctl. Before invoking the CLI, independently attribute all three views to the same
fixture:

- `launchctl print gui/<uid>/<label>` reports the exact label and a concrete PID;
- the PID's executable/arguments identify the run-local listener helper; and
- socket-owner inspection identifies that same PID as the listener on `127.0.0.1:7878`; when the host has no socket-owner
  utility, a run-nonce challenge response from the listener must report that same launchctl PID. An independent bind must
  fail because the fixture owns the port.

Do not continue on label, PID, process, or socket ambiguity. Never kill a PID solely because it occupies port 7878.

## Operate And Observe

First invoke representative root and nested/positional help through the built staging CLI with the run-local
`FIRST_TREE_HOME`. Help must return without running retirement: the exact fixture label remains loaded with its
attributed listener, its plist is unchanged, the port is still owned by that PID, and no marker appears. Include version
or no-action coverage when the target's public CLI contract exposes it without starting unrelated host services.

Then invoke an eligible ordinary action through the same entrypoint, such as `status --json`. Record its exit status and
stdout/stderr separately. Do not require a success JSON envelope when the current action does not promise one; JSON mode
must keep stdout machine-clean, while a retained migration failure must remain diagnosable on stderr. The action may use
the run-local current-channel home, but retirement must act on the effective-home canonical legacy fixture.

Wait within the product's documented bounded settling policy and independently observe this order and outcome:

1. launchd no longer reports the exact `gui/<uid>/<label>` service;
2. only after that label eviction is the exact canonical fixture plist absent;
3. the task-owned listener PID exits and no process listens on `127.0.0.1:7878`; and
4. a fresh process can bind that exact address and port, then closes it cleanly.

Compare the current-channel snapshot after retirement. Present prod, staging, and dev labels must still exist, their
plist bytes must be unchanged, and no observed service change may be attributable to the migration. If a PID changed
for an independently explainable reason, retain enough launchd and process evidence to distinguish that external event
from a migration target; otherwise report `INCONCLUSIVE` rather than assuming non-interference.

Finally run the same eligible action again. It must remain safe with no legacy plist or loaded service, must not reclaim
port 7878, and must not mutate current-channel services. Keep command-continuation and diagnostics evidence from both
runs; source inspection or unit-test results are supporting evidence only.

## Teardown Safety

Install fail-closed teardown before bootstrapping the fixture. On every exit path, boot out only the exact run label and
terminate only a PID that is freshly re-attributed to the run-local helper and that exact launchd label. Unlink only the
recorded fixture plist, helper, logs, and any product-created marker whose pre-run absence and post-run identity make its
ownership unambiguous. Remove only directories created by this run, in leaf-to-root order and only when empty; never use
a glob or recursive deletion.

If identity changes, a path becomes a symlink, port 7878 gains an unknown owner, or the run cannot prove ownership of an
artifact, stop mutating and preserve evidence. Report `BLOCKED` when the unsafe state existed before product execution,
or `INCONCLUSIVE` when attribution was lost during or after it. A teardown problem can never be hidden behind a product
`PASS`, and an unknown process must never be killed to restore the preflight state.

## Expected Result

`PASS` means the complete Docker + temporary-worktree harness reached `QA READY`, the native published-staging bridge
passed every safety precondition, help left the fixture untouched, an ordinary CLI action retired the exact task-owned
label and plist in the required order, the attributed listener exited and port 7878 was independently rebindable, a
repeat action was idempotent, current channel services were untouched, and teardown restored every run-owned host
mutation.

`FAIL` means real product behavior at the exact target reproducibly violates that contract—for example help triggers
retirement, an eligible action leaves the exact service/plist/listener unresolved, the plist disappears before label
eviction, the port cannot be rebound after confirmed cleanup, JSON stdout is polluted, or a current channel service is
targeted despite valid and attributable fixture state.

`BLOCKED` means the complete harness cannot reach readiness, a release-shaped staging CLI cannot be built, a safe native
launchd bridge is unavailable, the canonical path contains real or unsafe state, port 7878 is already occupied, or the
fixture cannot be loaded and attributed without affecting host state.

`INCONCLUSIVE` means the operation ran but label/PID/socket ownership, cleanup order, current-service non-interference,
artifact identity, or teardown evidence became incomplete, unstable, or attributable to something other than the
target ref.

## Evidence

Keep the exact target ref, detached worktree identity, Docker image/artifact digests, full readiness record, staging CLI
build provenance and digest, run-local `FIRST_TREE_HOME`, and redacted effective-home/path preflight. Retain the
before/after current-service snapshot; fixture plist and helper hashes; exact launchctl domain/label output; PID,
arguments, and socket-owner or nonce-challenge attribution; help and ordinary-action exit/stream captures; timestamps showing label
eviction before plist disappearance; listener-exit evidence; port bind probes; the repeat-run observation; and the
teardown manifest plus final host-state check.

Redact usernames, home paths, unrelated process details, credentials, and private channel data in shared evidence while
preserving structural paths, exact task labels, target identity, and the facts needed to audit attribution.
