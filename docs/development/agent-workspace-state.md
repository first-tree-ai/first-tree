# Agent Workspace State Files

This page documents the CLI-owned state under an agent workspace. Read it
before changing managed Skill projection, session bootstrap, or workspace
migrations.

## Ownership boundary

The Client owns only runtime projection and its bookkeeping:

- Core and Team Skills in the active provider's native discovery root.
- Stable agent identity and generated briefings.
- Narrow transaction, lock, and migration records under
  `.first-tree-workspace/`.

Source repositories and the Context Tree checkout remain agent-managed. The
runtime declares their coordinates but never creates, updates, or deletes
their clones.

## Managed Skill paths

Each runtime discovers Skills from one workspace-relative root:

| Runtime | Managed discovery root |
| --- | --- |
| Claude Code / Claude Code TUI | `.claude/skills/` |
| Codex | `.agents/skills/` |
| Cursor | `.cursor/skills/` |
| Grok Build | `.grok/skills/` |
| Google Antigravity | `.agents/skills/` |
| Kimi Code | `.kimi-code/skills/` |
| OpenCode | `.opencode/skills/` |

The reconciler projects both bundled Core Skills and Cloud-configured Team
Skills into that one active root. It does not maintain cross-provider
symlinks. On a provider switch, it installs and verifies the new projection
before retiring targets recorded for the previous provider.

Every installed directory contains `.first-tree-managed.json`. The marker and
the state ledger are ownership evidence; neither authorizes writes outside the
known provider roots.

## State files

| Workspace-relative path | Purpose |
| --- | --- |
| `.first-tree-workspace/managed.json` | Schema-v2 ledger, final installed digests, and monotonic Team Resource version fence. |
| `.first-tree-workspace/managed-skills.lock` | Persistent regular file whose descriptor carries the cross-process kernel lock. The path is never renamed or removed; owner death releases the OS lock automatically, and file existence alone does not indicate ownership. |
| `.first-tree-workspace/managed-skills-journal.json` | Single in-flight install or removal transaction used for crash recovery. |
| `.first-tree-workspace/migrations-applied.json` | Applied one-shot workspace-layout migration ids. |

JSON state and journal writes use file fsync, atomic rename, and a best-effort
parent-directory fsync. The journal is absent after a settled reconcile. The
persistent lock file remains, but no process holds its OS lock.

### `managed.json` schema v2

```json
{
  "schemaVersion": 2,
  "resourceConfigVersion": 18,
  "updatedAt": "2026-07-29T08:00:00.000Z",
  "skills": [
    {
      "key": "resource:019f-example",
      "target": ".agents/skills/review",
      "requestedSlug": "review",
      "effectiveName": "review",
      "revision": "sha256:...",
      "installedDigest": "sha256:..."
    }
  ]
}
```

- `key` is the stable logical identity: `core:<bundled-name>` or
  `resource:<resource-id>`.
- `target` is a validated workspace-relative provider-native directory.
- `requestedSlug` is the normalized Team name or fixed Core name.
- `effectiveName` includes a deterministic suffix when an unmanaged Team
  target already occupies the requested name.
- `revision` identifies the source. Core Skills use bundled `VERSION`; inline
  Team Skills use a stable DTO digest.
- `installedDigest` hashes the final installed directory after runtime
  transformations, including the effective manifest name, generated
  `VERSION`, ownership marker, supporting files, file type, and executable
  bits.
- `resourceConfigVersion` is a monotonic fence. A lower authoritative Cloud
  snapshot may not change Team Skill files or lower the persisted version.

Malformed state and future schema versions fail closed: the reconciler reports
the problem and performs no managed target mutation. A missing state file is a
first run. Schema v1 enters the conservative migration described below.

### Transaction journal

The journal records `beforeState`, `afterState`, the target, optional staging
and backup paths, expected final digest, and a phase:

1. `prepared`
2. `target_backed_up`
3. `target_installed` (install only)
4. `state_committed`

Each target change follows prepare → rename/swap → verify/commit → cleanup.
Before starting new work, the reconciler resolves any journal by comparing the
recorded phase with actual target, backup, staging, digest, and state facts. It
either completes a proven install/removal or restores the proven prior state.
Ambiguous facts fail closed instead of guessing.

## Team snapshot semantics

The handler passes one of two explicit inputs:

- `authoritative(resourceConfigVersion, skills)` — the Cloud Resource catalog
  is known for this start/resume/hot refresh.
- `unavailable` — configuration could not be resolved.

For an authoritative snapshot:

- A higher version advances the fence before Team target mutation.
- The same version may retry an interrupted reconcile.
- A lower version is stale and cannot install, update, or revoke Team Skills.
- An omitted previously managed Team Skill is revoked only after the snapshot
  passes the fence.

For an unavailable snapshot, Team Skills remain last-known-good on disk and a
warning is logged. This is intentionally eventual consistency: revocation
waits for the next authoritative snapshot. Core reconciliation can continue.

The generated briefing consumes immutable Team rows returned by the same
reconcile call. It never reconstructs rows by rereading a different state
snapshot, and it does not expose filesystem paths.

## Name and content safety

- Names containing path separators, control characters, empty normalized
  slugs, or Windows device names are rejected.
- Current Core names are reserved and cannot be shadowed by Team Skills.
- An unmanaged Team name conflict receives `-first-tree`, then a stable numeric
  suffix if needed.
- An unowned Core target is not overwritten unless its entire directory
  exactly matches the bundled payload.
- Bundles reject symlinks, special files, case-insensitive path collisions,
  a supplied ownership marker, excessive depth, excessive file count, and
  excessive byte size.
- Every managed and temporary path is containment-checked against the
  workspace and an allow-listed discovery root.

## Schema-v1 migration

Schema v1 recorded only Skill names and previously relied on
`.agents/skills/<name>` plus matching Claude symlinks. It cannot prove every
same-name directory was CLI-owned, so migration adopts a target only with at
least one conservative proof:

- the name is in the v1 ledger;
- the exact legacy `.claude/skills/<name>` symlink points to
  `../../.agents/skills/<name>`;
- the target has a valid First Tree ownership marker; or
- the complete target digest exactly matches the current bundled Core payload.

Anything else remains user-owned. After migration, the active provider
projection is installed first and only proven old targets are retired.

Legacy per-chat Claude resumes use the same reconciler against their legacy
cwd. That cwd gets only the narrow managed state/lock/journal and
provider-native Skills; it does not run the broader agent-home bootstrap or
source-repository declaration flow.

## Workspace migrations

`ensureAgentBootstrap` runs `applyPendingMigrations` before stable identity and
briefing work. A migration can:

- return normally: record its id;
- return `"deferred"`: do not record it, and retry on a later resolved start;
- throw: log the failure, do not record it, and retry later.

Workspace migrations do not delete Skill directories by name. Skill cleanup
requires reconciler ownership evidence. They also never delete source or
Context Tree clones.

When adding a migration:

1. Append a new stable id to `MIGRATIONS_REGISTRY`.
2. Make the operation idempotent and narrowly shape-checked.
3. Defer if deletion correctness depends on unresolved live config.
4. Never delete repositories or broad Skill paths.
5. Test the happy path, repeated run, and at least one protected user-owned
   shape.

## See also

- `runtime/managed-skills.ts` — reconcile, locking, transactions, migration,
  validation, and provider placement.
- `runtime/managed-state.ts` — schema parsing and atomic state/journal I/O.
- `runtime/agent-bootstrap.ts` — stable workspace bootstrap and briefing write.
- `runtime/workspace-migrations.ts` — one-shot layout migrations.
- `runtime/first-tree-skills/installer.ts` — bundled Core Skill catalog and
  package payload resolver.
