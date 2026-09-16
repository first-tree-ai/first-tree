---
id: managed-skills-admission-recovery
description: Validate legacy Skills migration and a single actionable failure for an unusable local ledger without repeated provider retries.
areas: [cross-surface]
surfaces: [cli, client, runtime, web]
---

# Managed Skills Admission Recovery

## Goal

A valid legacy v1 Skills ledger must reach the existing ownership-aware migration
and allow the original Agent to run. A ledger that needs operator recovery must
preserve the projection and produce one terminal failure instead of recurring
retry rows. Deterministic parser, version-fence, classifier, and session-timer
behavior belongs in the corresponding client product tests.

## Preconditions

- Candidate CLI/daemon and a disposable Agent workspace; do not use an operator
  or customer home.
- A resolved Context source and authoritative runtime configuration, the
  Agent's configured provider, and a chat that can complete a simple reply
  before preparing a fixture.
- Snapshot the workspace state and provider-native Skills while the daemon is
  stopped. Record the exact CLI and daemon versions.

## Operate

1. Prepare a valid v1 ledger and provably owned legacy Core Skills. Include the
   empty `skills: []` ledger with exact legacy Claude-to-Agents symlink ownership
   evidence. Start the candidate and send a simple request to the original Agent.
   Verify the existing migrator produces a valid v2 ledger, the expected Skills
   are usable, and the Agent replies without managed-state failure/retry rows.
2. In separate stopped-daemon fixtures, use malformed JSON, a future schema, and
   a non-regular ledger path. Attempt one start and one resume. Verify each
   failed attempt reports one actionable terminal failure, keeps the existing
   Skills/state unchanged, and adds no retry-started/retry-scheduled rows for at
   least two minutes without new input.
3. Restore the matching state/Skills snapshot and send a new request. Verify
   normal processing resumes and an already-settled failed request is not replayed.
4. Repeat a recoverable Context/configuration availability failure. Verify it
   retains the existing retry/recovery behavior rather than being classified as
   a broken local ledger. An existing v1 ledger with unavailable runtime config
   and no captured payload must still block publication. With unresolved Context
   or unowned conflicting Skills, verify legacy migration does not bypass their
   admission checks.

## Evidence and Expected Result

Record exact versions, fixture hashes, migrated schema, provider reply and Skill
use, terminal timeline event and notice, and the quiet observation window.
Successful migration is silent to the chat; unsafe state remains protected and
stops automatic retries until an explicit recovery attempt. Product tests alone
do not establish live provider, Web, or release acceptance. Restore/remove only
the task-owned fixtures after the run.
