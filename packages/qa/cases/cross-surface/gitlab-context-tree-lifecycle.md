---
id: gitlab-context-tree-lifecycle
description: Validate GitLab Context Tree Seed, provider-aware authoring, inbound review dispatch, local repair, exact-SHA merge, and anonymous-only Web Context.
areas: [cross-surface]
surfaces: [cli, server, web, gitlab, runtime]
---

# GitLab Context Tree Lifecycle

## Goal

Validate the assembled GitLab Context Tree path against an old Self-Managed
GitLab: explicit create/adopt, exact provider binding, Agent-local Read/Write,
inbound MR review dispatch, repair and complete re-review, exact-SHA squash
merge, and Phase 2 continuation. Separately validate the deployment-managed
anonymous Web Context boundary without treating content availability as
automatic-review health.

Stable URL, policy, schema, error-classification, and prompt wording checks
belong in product tests and Skill evals. This case proves the real provider,
runtime, network, credential, and cross-surface behavior.

## Preconditions

- Use an isolated candidate First Tree deployment, disposable Team, disposable
  old-version Self-Managed GitLab project/group (including a nested namespace),
  and an eligible Work Agent plus independent Review Agent.
- Configure one exact GitLab connection and an instance-wide System Hook from
  the derived `/admin/hooks` page, with Push and Merge Request events enabled,
  the default payload, and no custom template. Reuse the same one-time URL in a
  trusted Project Hook with Merge Request, Issue, and Note events enabled.
  First Tree must observe a processable System Hook Merge Request before
  full-instance routing is ready. Context Reviewer enablement records Team
  intent without requiring prior webhook traffic; every delivered MR must
  still pass the live exact-repository, binding, connection, and Reviewer
  authority checks. Connection creation must not depend on Web Context egress
  policy.
  For a Self-Managed origin, the deployment operator—not the Team
  admin—separately authorizes the exact HTTPS origin through
  `FIRST_TREE_GITLAB_ALLOWED_ORIGINS`. Retain evidence of policy shape but no
  bearer or repository credential.
- Authenticate `git`, `glab`, and the Review Agent's git identity only on the
  Agent hosts. Do not give First Tree Cloud a GitLab API/repository token.
- Prepare public anonymous-readable and private repositories on the same
  disposable instance, plus protected/pipeline-failing branches and a way to
  introduce a concurrent source-branch push.
- Store redacted run evidence outside the repositories.

## Operate and Observe

- Run provider-aware `tree init` with exact Team, provider, repo, branch, and
  `--create`. Confirm local verify precedes remote mutation, nested namespace
  and host/port are preserved, GitLab receives no approval/ruleset/App setup,
  and final binding includes `provider=gitlab`. Repeat for `--adopt`; require a
  readable exact branch, no push/history rewrite, and deterministic validation.
  Exercise remote-created/binding-failed and unknown response branches; confirm
  no repository deletion or invented rollback.
- Complete Seed Phase 1, merge its MR, then resume Phase 2 only from merged
  durable Tree state and exact source commits. Confirm Work Agent Read/Write
  uses local git/glab, strictly rechecks the live binding and current connection
  before push, creates and follows the MR, then stops without creating the
  Reviewer Chat, repairing, noting, approving, or merging.
- Deliver old-GitLab open/reopen/update and draft-to-ready MR payloads. Confirm
  the current exact connection/project/binding and configured active Review
  Agent select one stable MR-scoped Reviewer Chat. Replay a stable delivery id,
  deliver the same MR occurrence through System and Project Hooks in both
  orders, replace the connection, send a wrong project/host, and send ordinary
  Project Hook Notes. Require one card/Reviewer dispatch for each overlapping
  MR occurrence, System Hook readiness evidence even when its copy is
  suppressed, ordinary Issue/Note routing, no stale dispatch, and no Note
  self-trigger. Repeat an MR pair without `updated_at`, `oldrev`, or `changes`
  and confirm the documented fail-open duplicate risk rather than false
  suppression.
  Generic GitLab entity attention remains independently observable.
- Observe connection health in Web Settings and Getting Started with only a Project Hook,
  only a System Hook, and both hooks. Require each observed source to appear
  independently. A Project-only Issue or Note must show the Project Hook as
  observed without claiming untested event types, and without a System Hook
  warning or Merge Request prompt. When both sources are observed, Project Hook
  activity must remain visible while an incomplete System Hook shows its own
  source-specific completion prompt. A System Hook Merge Request must establish
  full-instance routing readiness. Before any inbound traffic, enable Automatic
  Review and require the saved enabled state with no red webhook-readiness
  blocker. With only a Project Hook, deliver a Merge Request first from a
  different project and then from the bound Context Tree: the wrong repository
  must not dispatch, while the first exact-repository event must immediately
  dispatch the configured Reviewer. Repository automation continues to report
  Project Hook scope rather than full-instance readiness. An unobserved optional
  hook source must not appear broken or incomplete. Also load a pre-source-health
  connection with valid historical transport: require a neutral unidentified-
  source state that asks for an enabled event from the already configured Hook,
  never a guessed System Hook recovery.
- On a ready same-project MR, confirm the Reviewer resolves live state with the
  exact-host `glab` identity, fetches a detached exact head, runs
  `tree verify` before semantic reads, and completes Evidence plus Challenge
  passes. Introduce a safe deterministic defect; require local repair,
  commit/push, then full validator-first re-review on the successor head.
  Blocking or protected findings receive one local-identity MR note and leave
  the MR open. No GitLab approval, status, label, ruleset, CODEOWNERS gate, App
  verdict, queue, admin bypass, force push, or Cloud token may appear.
- On a blocker-free ready MR with acceptable pipeline/protection state, capture
  the reviewed full SHA and perform one squash merge using GitLab's `sha`
  compare-and-set. Push a successor commit immediately before merge and require
  a head-mismatch failure with the MR left open. Exercise credential,
  pipeline/protection, deterministic-validation, unsupported-CAS, and transport
  failures. There is no mutation retry; an unknown result permits one
  read-only reconciliation and is reported as merged/open/unknown only from
  exact-head evidence.
- Open the Context tab for the operator-authorized public repository and
  confirm anonymous content renders. Repeat for the private repository and
  require a provider-specific unavailable state directing the user to an
  Agent with local git/glab access. Confirm Cloud never requests, stores, logs,
  or injects a credential and never publishes an Agent snapshot.
- On GitLab 11.11.3, have the Work Agent cite a node through `tree source-link`
  and open the resulting source in its final reply. Require `/blob/`, the full
  commit read by the Agent, and the correct file, including nested namespaces
  and a path with spaces or Unicode. Confirm the Context page's cited-node
  link also uses `/blob/` once the connection has observed the instance version.
  Repeat on GitLab 12.7 or later and require `/-/blob/`. With no observed version,
  the Context page must show plain text; the Agent formatter must either obtain
  a version through local `glab` or omit the citation. A seven-character SHA
  must fail source-link generation, and complete old/new links must yield
  readable impact records. Capture actual browser access separately from
  parser acceptance; no guessed link, Cloud credential, or MR mutation may be
  introduced by citation formatting.
- Separately exercise built-in `https://gitlab.com` with public DNS answers.
  Confirm it needs no additional origin entry. For a Self-Managed public
  origin, use the simplified string form; for a private destination, use
  `{ origin, cidrs }`. Confirm the deprecated legacy variable still preserves
  its exact old policy and simultaneous old/new variables fail startup.
- Remove the allowed-origin entry while preserving the Team binding and
  connection. Confirm the next Web Context refresh performs no GitLab egress
  and reports an actionable origin-not-authorized state, while the saved
  binding, inbound Webhook health, and automatic MR review remain ready.
  Exercise DNS-unavailable, exact port mismatch, mixed allowed/denied A/AAAA
  answers, DNS changes, redirect, loopback/link-local/private/ULA/
  reserved/metadata destinations, ambient proxy, credential helper, and local
  Git config. Require distinct Web recovery copy for origin, DNS, address,
  anonymous-auth, redirect, and repository/branch failures. Only an
  operator-authorized CIDR may admit private/ULA addresses; permanently blocked
  destinations stay denied.

## Expected Result

`PASS`: explicit Seed converges without overwriting remote or Team truth; Work
Agent stops after MR/follow; inbound Webhook selects the independent Reviewer;
safe repair converges through a complete final-head review; one exact-SHA
squash merge uses only Agent-local identity; every race or provider failure
fails closed; public Web Context is anonymous; private or unauthorized content
degrades without credentials; and Web Context availability never changes
Webhook/reviewer readiness.

`FAIL`: provider or origin is guessed; a writer reviews/repairs/merges; Cloud
stores or uses a GitLab repository credential; a Note self-triggers review;
an old/stale connection dispatches; review skips validation or final-head
re-review; merge lacks exact-SHA CAS, retries, queues, bypasses, or approves;
an unauthorized/redirected/rebound destination receives egress; cached content
bypasses a narrowed policy; or content degradation disables healthy inbound
automation.

`BLOCKED`: the isolated cell cannot provide the candidate surfaces, disposable
old GitLab, webhook reachability, two eligible runtimes, exact-SHA-capable
instance/API, or operator egress policy.

`INCONCLUSIVE`: only source/tests/mocks/logs are available, or the observed
remote mutations, Webhook dispatch, local identity, exact head, and egress
destination cannot be tied to the candidate ref.

## Evidence

Keep target refs; exact redacted origins/ports and address-policy class;
create/adopt and binding summaries; webhook delivery ids; stable Reviewer Chat
and run ids; validation output; repair diff and successor head; MR note, pipeline
and exact-SHA merge records; anonymous/private/unauthorized Context states; and
network observations proving pinned authorized egress and denied alternatives.
Never retain webhook bearers, GitLab tokens, private Tree content, hidden
prompts, proxy credentials, ambient auth files, or unrelated customer data.
