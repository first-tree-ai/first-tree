---
name: first-tree-seed
version: 0.6.0
cliCompat:
  first-tree: ">=0.5.16 <0.6.0"
description: "Bootstrap a team's Context Tree from readable source repos — for an onboarding \"build / set up the Context Tree\" task on a tree that has no domain structure yet: either no tree exists (creates and binds it) or a bound-but-empty tree (fills it). Supports clean explicit-Team invocation without a Workspace manifest, managed briefing, or prior setup-chat transcript, while preserving managed-workspace compatibility. Proposes an initial top-level + second-level domain structure for approval, then drafts initial leaf content — each as a reviewable PR/MR. Refuses unrelated re-seeding once the tree has domain structure and recovers Phase 2 from durable merged Tree state plus the same explicit sources."
---

# First Tree — Seed

Read this skill **before** drafting the first content into a Context Tree
that has no domain structure yet. It owns the bootstrap from "the tree has
no domain structure — either none exists, or a bound-but-empty one" to "the
tree has real top + second level structure plus initial leaf nodes drawn
from readable source repos". It first resolves the tree's state, then — for
a tree that needs building — creates the repo with `first-tree tree init`
when none exists (see *Resolve the tree's state*). Every subsequent write —
one PR/MR at a time, one decision at a time — belongs to `first-tree-write`,
not here.

## When To Use This Skill

| Use `first-tree-seed`                                                 | Use a different skill                                                                                |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The team has no tree yet, **or** a bound tree with no normal domain structure per the generated policy's content classes | The tree already has a normal domain structure → `first-tree-write` (incremental source-driven write) |
| First content pass on resolved readable sources                       | Broad maintenance or drift-audit work on an existing tree                                            |
| Invoked by name — by a human, an agent, or an onboarding kickoff prompt (see Resolve the tree's state) | Not an org admin, or the selected provider's local `gh` / `glab` identity is unauthenticated, and the team has no tree |

The skill is **single-shot per tree setup**: once the tree has domain
structure, a new or unrelated seed request refuses and routes further work
through `first-tree-write` or a focused maintenance task. The one exception is
a verified Phase 2 continuation recovered from the merged Tree's durable Seed
progress and exact source ledger. It may run in a new process, agent, or chat;
it is completion of the same seed, not a second seed.

## Policy Baseline

Before drafting anything, load this skill and use the generated Context Tree
Policy already present in `AGENTS.md` / `CLAUDE.md` as the content baseline.
Every node this skill creates must satisfy that policy: durable decision,
current truth, rationale, source-system boundary, Double Test, smallest correct
edit, no implementation detail, no history, and no actionable future work in
normal tree content.

## Invocation modes and live authority

Seed has two compatible entry modes:

- **Portable / clean invocation.** The task supplies one explicit
  `selectedTeamId`, one task-local `treePath`, and at least one explicit readable
  source input. Do not require or reconstruct a Workspace manifest, managed
  briefing, setup-chat transcript, Web selection, or account default/current
  Team. If the Team or every source input is missing, ask only for the missing
  input and stop before touching local or remote state.
- **Managed workspace.** Keep using the generated workspace paths and declared
  sources when they exist. A non-empty manifest source list remains
  authoritative. Managed state is a path/source convenience, not authority for
  role or binding, and no prior setup-chat transcript is required for recovery.
  Resolve `selectedTeamId` per *Resolve the managed Team id* below before any
  Seed preflight.

### Resolve the managed Team id (`selectedTeamId`)

In a managed session the exact Team id comes from runtime-authored context,
never from conversation text:

- **Primary source:** the `organizationId` field of the runtime-authored
  `<first-tree-current-chat-context>` JSON block for the current chat. Use
  that exact value as `selectedTeamId` for every Seed/init preflight in this
  task.
- **Never substitute** the chat topic, title, Team display name, a local
  workspace manifest value, an account default/current Team, or setup-chat
  transcript text for the Team id.
- **Compatibility path (older runtime without the field):** when the current
  chat context JSON has no non-empty `organizationId`, query the exact
  current chat once with the current Agent identity:

  ```bash
  first-tree chat list --engagement all --chat "$FIRST_TREE_CHAT_ID" --json
  ```

  Continue only when the result carries exactly one matching chat item whose
  `organizationId` is a non-empty string, and use that value. On zero or
  ambiguous results, or a missing/empty `organizationId`, ask the human for
  the exact Team id and stop before any Seed command.

When an explicit Team is available, start every invocation with this online,
read-only admission check:

```bash
first-tree tree seed --team "<selectedTeamId>" --json
```

The response is the only current admission view: the Server resolves active
membership, active Admin role, and that exact Team's current binding. Do not
cache the Admin result or substitute an owner, prior task, local manifest, Web
selection, or another Team. An ordinary active member receives stable
`CONTEXT_TREE_SEED_NEEDS_ADMIN`; report the same selected Team and ask an active
Admin of that Team to continue. Do not fall back to a default Team and do not
run `gh`, create a branch/repo/PR, or change a binding.

Repeat the same preflight immediately before every remote mutation: `tree init`,
the Phase 1 push, Phase 1 PR/MR creation, the Phase 2 push, and Phase 2 PR/MR
creation. `tree init --team` also repeats it internally before forge creation
and before final binding. A failure before remote mutation creates no remote
state. A failure after a branch, repository, binding, or PR/MR may exist must
report and query that real state; never claim rollback. On retry, inspect the
selected Team's current binding, the deterministic Seed branch, and any existing
PR/MR by head branch before creating anything.

Before authoring Phase 1 or evaluating any populated tree for Phase 2, read
[`references/durable-progress.md`](references/durable-progress.md) completely.
It owns the exact marker, canonical source-ledger shape, fixed-commit recovery
algorithm, and fail-closed mismatch outcomes. Do not invent a second progress
format in this file, chat, or local cache.

### Optional Welcome Reviewer contract

Ordinary Seed keeps Context Review optional. Apply the stronger onboarding
Reviewer contract only when the current tree-build task explicitly says all of
the following: open the Structure PR/MR first, preserve an existing Reviewer,
use the Agent running this tree-build task as the default only when none is
selected, and do not open the Content PR/MR until a selected Reviewer is
enabled. Do not infer this contract from a greeting, chat title, or hidden
provenance.

Write the corresponding exact progress line during Phase 1 so a fresh-process
Phase 2 recovery preserves the choice:

- `Review gate: automatic-review-required` for that explicit Welcome contract.
- `Review gate: optional` for every ordinary Seed task.

This line is operational Seed state, not normal Context Tree content. It does
not authorize the Agent to change the Team Reviewer configuration.

## Resolve the tree's state (three states; stop on refuse)

This skill runs whenever a human or another agent invokes it — **the tree's
state is the gate, not the prompt's origin.** Before reading any source,
resolve which of three states the team's Context Tree is in and act
accordingly: create it when none exists, fill it when it is bound but empty,
and refuse when it already has domain structure (state C below), routing
that work to `first-tree-write` or a focused maintenance task.

**Check durable Phase 2 recovery before classifying state C.** Continue the same
Seed into Phase 2, including from a new process, agent, or chat, only when all of
these are true:

1. a fresh Seed preflight says the selected Team is still bound, and a strict
   fetch of that exact repo/branch succeeds;
2. the fetched default branch contains `.first-tree/progress.md` with the exact
   `<!-- first-tree-seed-progress:v1 -->` marker and checked Phase 1 item defined
   in the durable-progress reference, but no checked Phase 2 item;
3. the same file's canonical source ledger matches the freshly re-resolved
   explicit source identities entry-for-entry, and every recorded exact commit
   is still readable; and
4. the approved Phase 1 top-level structure exists on that fetched branch.

When all four hold, enter Phase 2 through its trigger below even though domain
directories now exist. The old Chat transcript and private local cache are
irrelevant. A checked Phase 2 item means Seed is complete. A populated tree
without the durable marker is state C, not a continuation. A missing source,
identity mismatch, unreadable recorded commit, or changed binding fails closed
and names the exact mismatch; it never starts another Seed.

**A — No tree yet.** In portable mode, the fresh Seed preflight says the
explicit Team is unbound. In managed mode, the workspace manifest has no
non-empty `tree` field and the compatible Team binding path is unbound. This is
the agent-driven creation path. First resolve readable sources using the
section below and detect each source forge from its supplied URL or `origin`.
Source access may use `gh` for GitHub or `glab` for GitLab, but current
`first-tree tree init` requires an explicit Context Tree provider, exact
repository URL, branch and create/adopt mode. Do not infer the tree provider
from a source repository or silently choose the current CLI account:

```bash
# Portable / clean invocation
first-tree tree init --team "<selectedTeamId>" \
  --provider "<github|gitlab>" --repo "<exact-repository-url>" \
  --branch "<default-branch>" --create --dir "<treePath>"

# Managed workspace (resolve the trusted task's Team id first)
first-tree tree init --team "<selectedTeamId>" \
  --provider "<github|gitlab>" \
  --repo "<exact-repository-url>" --branch "<default-branch>" \
  --create --dir "<workspaceRoot>/<manifest.tree>"
```

Provider-aware `tree init` always requires `--team`, including in a managed
workspace. Resolve that id per *Resolve the managed Team id
(`selectedTeamId`)* above and
repeat the live Server authority preflight for that exact Team. If no trusted
Team id is available, ask the human for it and do not invoke `tree init`;
never infer a default Team from local workspace state.

Use `--adopt` instead of `--create` only when the explicit target repository
already exists and is intended to become the tree. Adopt is non-destructive:
the remote and selected branch must be readable and compatible; never overwrite
different history or force-push. A partial remote success is not rolled back or
deleted. Re-read the live Team binding and remote state and report an orphan or
unknown result truthfully.

**Keep source identity separate from the tree host.** Ask the Team Admin to
confirm the target `provider`, exact `repo`, `branch`, and `create` or `adopt`
mode. For each declared source, independently classify its own host:

- GitHub: keep the owner segment, such as `acme` in
  `github.com/acme/app`, and use `gh` for host access/authentication.
- GitLab: keep the complete namespace before the repository, such as
  `acme/platform` in `gitlab.com/acme/platform/app`, and use `glab`. Never
  flatten a nested namespace to only `acme` or `platform`.

**`manifest.sources` holds directory names (for example `first-tree`), not
forge identities.** Never infer an owner, namespace or Context Tree host from a
clone directory. Preserve GitLab's complete nested namespace and explicit host,
including Self-Managed hosts and ports.

`tree init` seeds a minimal valid tree
(root `NODE.md`, a `members/` index, and the creator's member node),
pushes, and binds the org's `context_tree` setting. It is **admin-only** and
needs an authenticated exact-provider CLI (`gh` for GitHub; `glab` for the
exact GitLab host). If the caller is not an org admin or the selected identity
cannot create/adopt and push that repository, surface that exact gap and stop.
New finalization persists the provider; a legacy binding whose provider cannot
be safely classified remains automation-degraded and is never guessed for a
mutation.
Take the Team display name from the explicit task handoff when available. In a
managed workspace, `first-tree agent status` remains a compatible source. Do
not infer a portable Team from that command; `--team` remains the explicit id.
After init succeeds the tree is bound and in state **B** — proceed.

**Run it directly — do not ask the human "who runs the bind?".** This create +
bind is the sanctioned agent path (a general "tree binding is an operator
action" note in your briefing does **not** apply to this task) — running it IS
the task the user asked for, so binding needs no separate go-ahead. You do not
need to independently "confirm admin" first: `tree init` enforces it
server-side (it fails closed for a non-admin or unauthenticated provider CLI). So run
it; only if it fails on that admin/authentication check do you surface the
exact gap (not an admin / `gh` not authenticated) and stop.

**Pin the local checkout with `--dir` — this is load-bearing.** `tree init`
defaults to `<cwd>/<repo-name>`. Portable Seed must pass its explicit
`treePath`; managed Seed must pass `<workspaceRoot>/<manifest.tree>` (usually
`context-tree`). Seed does not rewrite `workspace.json`. Without `--dir`, Phase
1 can operate on a missing or stale checkout even though another repo was
created and bound. If a managed manifest carries no tree name yet, use the
conventional `<workspaceRoot>/context-tree`.

**Configure GitHub branch rules after a newly created Context Repo.**
This applies only in state A, only after `tree init` succeeds, and only when the
new Context Repo is a GitHub repository. Do not run it for an already-bound tree,
a non-GitHub remote, or a failed/partial `tree init`. Use host `gh`; do not send
the user to the browser first.

GitHub owns the repository merge gate here: changes go through pull requests,
force / non-fast-forward pushes are blocked, and the current diff requires at
least one approval. The gate is intentionally generic: do not bind it to a
specific GitHub App or Code Owner, and do not create a root `CODEOWNERS`
mapping. Keep this rule independent of the organization's current Context
Review workflow; changing that workflow never removes the repository approval
gate.

Resolve the repository from the new tree checkout:

```bash
remote=$(git -C "<tree>" remote get-url origin)
repo=$(gh repo view "$remote" --json nameWithOwner --jq .nameWithOwner)
```

Then upsert one active repository-local ruleset scoped to the default branch:

```bash
ruleset_id=$(gh api "repos/$repo/rulesets?includes_parents=false&per_page=100" --jq 'map(select(.name == "First Tree Context Repo branch rules" and (.source_type == null or .source_type == "Repository")))[0].id // empty')
```

Use `gh api` to `POST repos/$repo/rulesets` when no existing repository-local
ruleset has that name, otherwise `PUT repos/$repo/rulesets/$ruleset_id`. Do not
look up inherited organization rulesets, and do not use a pipeline such as
`gh api ... | head` because it can mask a failed list request as an empty lookup.
The payload must keep these exact semantics:

```json
{
  "name": "First Tree Context Repo branch rules",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 1,
        "require_code_owner_review": false,
        "dismiss_stale_reviews_on_push": true,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    }
  ]
}
```

The ruleset blocks force / non-fast-forward pushes, requires changes through a
pull request, and requires at least one current approval. Pushing a new commit
dismisses stale approvals. Code Owner and last-push approval remain disabled.
This intentionally means a single GitHub user cannot self-merge while the App
Reviewer is unavailable; the PR needs either the App approval or another human
approval. Do not compensate by broadening App permissions, restoring
CODEOWNERS, or adding a ruleset bypass.
If any `gh` or ruleset
step fails after you know the repo is a GitHub Context Repo, continue with the
seed flow and tell the user automatic GitHub branch-rule setup failed. Give a
manual checklist in plain words: require pull requests, require at least one
current approval, dismiss stale approvals on push, block force pushes, and do
not require Code Owner review. Do not treat this setup failure as
a reason to delete or recreate the Context Repo.

For GitLab, stop after provider-aware init and local authentication checks.
The Team Admin configures the project's First Tree inbound Webhook. Never
create or simulate an approval rule, GitHub App verdict, ruleset, CODEOWNERS
gate, merge queue, branch bypass or admin merge. The GitLab Context Reviewer
is dispatched only by valid inbound MR Webhooks and later uses its host-local
`git` / `glab` identity for review, repair and exact-SHA merge.

**Keep repository coverage separate from entity attention, and delay coverage
guidance until there is a reviewable milestone.** Detect the Context Tree repo's
forge from its own `origin`; do not infer it from a source repo. A GitHub init
prints GitHub App coverage guidance; a GitLab init has no GitHub App coverage
step and instead requires the Team Admin's matching inbound Webhook connection.
After each Phase 1 or Phase 2 GitLab MR is created or an existing
deterministic MR is resolved/reused, run `first-tree gitlab follow <mr-url>` in
that task Chat. A returned pending or active state is success; only pending waits
for a matching valid webhook. Failure does not invalidate the MR, so report only
the First Tree Chat attention gap. This follow is not an installation detour; do
not interrupt source resolution, structure review, or Phase 1 work. Relay a
separate GitLab integration recovery target only when First Tree returns one
explicitly; never invent a product path.

**After the Phase 1 PR/MR is open**, or earlier only when the next requested
operation actually needs Cloud snapshot/reviewer access, collect any uncovered
tree-repo recovery returned by `tree init` or another authoritative First Tree
command. Do not send a coverage prompt yet: first perform the Review Agent read
below, then send at most one combined setup handoff. This workflow supersedes
the generated briefing's generic GitHub-follow setup prompt for these Tree
PRs/MRs; report the attention gap, but consolidate the action here.

- **GitHub tree, selected-repositories install excludes it:** `tree init`
  prints a GitHub installation-settings URL — an absolute `https://` link, so
  it renders clickable in chat. Relay it and say to add the tree repo there.
- **GitHub tree, no App installed:** give the admin a clickable link to the web
  console's Getting Started surface, built from the server URL the agent knows — take
  the `Server:` value from `first-tree agent status` and append
  `/settings/setup` (an absolute `https://…/settings/setup` renders
  clickable; a bare `/settings/setup` path does **not** — the chat link guard
  drops relative paths). Tell them to open it and complete GitHub App
  installation or repository coverage there.
  This assumes the web console shares the server's origin (the standard
  deployment); if it does not, the link may not resolve — then name the
  destination in words: **Settings → Getting Started** in the web app. Do **not**
  fabricate a raw GitHub App install URL yourself — the install must run
  through the web console so it binds back to your org. Add the **placement
  caveat**: the tree repo was created under the GitHub account shown as
  `<owner>` in `tree init`'s output, from `--owner`, so install the App on that
  same account; installing it elsewhere will not cover this repo.
- **GitHub tree, suspended install:** `tree init` prints the
  installation-settings URL — relay it and say to reactivate the First Tree App
  installation there.
- **GitLab-hosted existing tree:** no GitHub App coverage guidance applies. MR
  attention uses `first-tree gitlab follow` after creation or recovery/reuse.
  Relay any separate recovery target only when First Tree returns it explicitly.
  Never substitute a GitHub App URL or tell the user to install the GitHub App
  for GitLab. Use **Settings → Getting Started** only for an actual Team capability
  handoff after the milestone below; do not invent a GitLab-specific product
  path.

**After the Phase 1 PR/MR is open, check Review Agent configuration once.**
Do not introduce it before this reviewable milestone. Before any user-facing
coverage handoff, read the selected Team:

```bash
first-tree org context-tree review-config --as-member --org "<team-id>" --json
```

- Use only the JSON `enabled` and `agentUuid` fields to distinguish three
  durable configuration states. This is not a health or readiness check:
  - `agentUuid` is null: include selecting an eligible managed Review Agent and
    enabling Automatic Review through **Settings → Getting Started**. Under the explicit
    Welcome Reviewer contract, during this same Phase 1 process name the Agent
    that opened the Structure PR/MR as the default choice; do not replace a
    later human selection. A fresh-process Phase 2 recovery does not know that
    original Agent from durable progress and must not substitute the recovery
    Agent.
  - `agentUuid` is present and `enabled` is false: the selection is retained;
    include only enabling Automatic Review through **Settings → Getting Started**.
  - `agentUuid` is present and `enabled` is true: add no Review setup handoff
    and infer no Reviewer health from this command.
  Any other or ambiguous result creates no inferred debt.
- Send one milestone response: combine any GitHub App recovery or repository
  coverage action with the applicable Review setup action above. If only one is
  missing, mention only that action. If neither is missing, add no setup
  guidance. The owning Settings surfaces hold provider prerequisites and the
  Team mutation; Getting Started only summarizes readiness and links there.
- A failed or ambiguous read creates no inferred debt. It does not block
  ordinary Seed. Context Review remains optional for Team, Chat, basic Tree use,
  and ordinary Seed completion. Under the explicit Welcome Reviewer contract,
  the later pre-Content-PR/MR check below must obtain an unambiguous selected
  and enabled result before that remote mutation. For a newly created GitHub
  tree, mention baseline approval rules only when this run verified that
  ruleset setup succeeded. For an existing tree or failed ruleset setup, report
  the governance actually observed instead of implying that baseline approval
  rules exist.

Use this response matrix after the milestone:

| Tree provider / coverage | Review config read | User-facing setup action |
| --- | --- | --- |
| GitHub coverage missing | No selected Agent | One combined handoff: authoritative coverage recovery plus select and enable Automatic Review in Settings → Getting Started |
| GitHub coverage missing | Selected but off | One combined handoff: authoritative coverage recovery plus enable Automatic Review in Settings → Getting Started |
| GitHub coverage missing | Enabled or read failed/ambiguous | Coverage recovery only; infer no Review debt |
| GitHub covered | No selected Agent | Select and enable Automatic Review in Settings → Getting Started only |
| GitHub covered | Selected but off | Enable Automatic Review in Settings → Getting Started only |
| GitHub covered | Enabled or read failed/ambiguous | No setup handoff |
| GitLab | No selected Agent | Select and enable Automatic Review in Settings → Getting Started only; no GitHub App guidance |
| GitLab | Selected but off | Enable Automatic Review in Settings → Getting Started only; no GitHub App guidance |
| GitLab | Enabled or read failed/ambiguous | No setup handoff |

**B — Bound but unseeded.** The tree is bound and holds at most non-normal
supporting/member structure under the generated policy's content classes,
with **no normal top-level domain directory** yet.
This is the normal seed entry, whether the bootstrap came from state A's
`tree init` above or from an earlier provision. Proceed to Phase 1. Phase 1
layers the normal domain skeleton plus any missing supporting/member structure
on top of whatever bootstrap nodes already exist: **extend** the root `NODE.md`
index and supporting trees rather than recreating them.

**C — Already seeded.** Outside the verified Phase 2 continuation above, the
tree has one or more **normal top-level domain
directories** — any directory directly under the explicit `<treePath>` in
portable mode or `<workspaceRoot>/<manifest.tree>/` in managed mode
other than `.git/`, `.first-tree/`, `.github/`, `members/`, `raw-context/`, and
dotfile-prefixed dirs. Refuse with a one-line explanation pointing at
`first-tree-write` for incremental source-driven writes, or ask for a
focused maintenance scope. Do **not** delete nodes to force a re-seed —
that is human-owned.

The generated policy's archive/supporting and member content classes are not
normal domains. A tree that has only those non-normal classes plus bootstrap
nodes is still unseeded for this skill's purposes.

### Resolve readable sources

Use one ordered source-resolution rule and call its result
`resolvedSources` throughout both phases:

1. **A non-empty `manifest.sources` is authoritative.** Require every declared
   source on disk. Do not let a URL or local path supplied in the request hide a
   half-provisioned declared workspace.
2. **An empty or absent `manifest.sources` is valid.** Use an explicit local
   project folder or GitHub/GitLab repository URL supplied in the current
   invocation or task handoff. If neither exists, ask the user for exactly one of them and stop
   until they answer. Do not send them to Settings and do not make GitHub App
   installation a prerequisite.
3. **Validate before reading.** A local folder must exist, be readable, and be
   a Git repository. A GitHub or GitLab URL must be a repository URL that the
   matching host CLI (`gh` or `glab`) or `git` can access; materialize a
   task-local read checkout under the workspace `worktrees/` directory. These
   reads do not register team resources or mutate the source repo.

In a clean explicit-Team setup, source discovery stays read-only until the
Admin explicitly confirms the exact `resolvedSources`. After that confirmation
and before Phase 1, register the whole set with one optimistic batch:

```bash
first-tree tree seed --team <team-id> \
  --expected-source-key <each-active-key-observed-before-confirmation> \
  --confirm-source <each-confirmed-repository-url>
```

Repeat both flags as needed. For a new Team with no active repositories, omit
`--expected-source-key`. A `409` means another Admin changed Settings →
Repositories after confirmation; refresh the current set and ask the Admin to
confirm the resulting selection again. Never fall back to individual resource
creates, and never retire repositories omitted from this batch. A managed
workspace whose declared sources were already registered by the Web setup
continuation does not repeat this mutation.

For every resolved source, determine `sourceForge` from the supplied URL or,
for a local repository, `git remote get-url origin` before choosing host tools.
Use `gh` for GitHub and `glab` for GitLab; use plain `git` for an unrecognized
host unless the user supplies its supported CLI. Preserve the full GitLab
namespace, including nested groups, in source identity and diagnostics.

For a local non-bare repository, inspect its identity in place but materialize
the evidence read at one exact commit. For a local bare repository, follow the
worktree protocol below. For a GitHub or
GitLab URL, clone/fetch it into task-local read storage, then read its default
branch. Private URLs may rely on the user's existing `gh` / `glab` / git
credentials; if access fails, report that exact credential/access gap rather
than asking for the First Tree GitHub App.

The selected Context Tree target remains independent from source locations.
Never turn a parsed source owner or GitLab namespace into the tree target
without the Admin's explicit provider/repository confirmation. If a local repo
has no recognized forge remote, keep it as source evidence and do not guess a
tree host from its directory name. Revalidate the same `resolvedSources` before Phase 2 so a later
process cannot silently switch inputs. Phase 1 records each canonical source
identity and exact evidence commit in the durable ledger; Phase 2 must
materialize those recorded commits, not newer default-branch tips.

**For declared sources, require every clone on disk.** Each source
clone lives at `<workspaceRoot>/<manifest.sourcesRoot>/<manifest.sources[i]>`
— the runtime writes `sourcesRoot: "source-repos"`, so the path is
`<workspaceRoot>/source-repos/<name>` (a legacy flat manifest omits
`sourcesRoot` and keeps sources at `<workspaceRoot>/<name>`). Every entry
must exist (each is a **bare** clone — see *Materialize source read
worktrees* below). A missing source means the workspace is
half-provisioned; surface to the user and stop. Do not seed from a partial
workspace. The resulting declared clones become `resolvedSources`.

### Materialize source read worktrees

Under the agent-managed repo model the declared sources are **bare**
clones (a git object store, no working tree) — you cannot `ls` or read
files at the clone path directly. Resolve each source's bare-clone path
from the manifest's `sourcesRoot` (do NOT hard-code it — the field is
optional):

- `sourcesRoot` present (current manifests, value `source-repos`):
  `<source-clone>` = `<workspaceRoot>/<sourcesRoot>/<source>`
  (e.g. `<workspaceRoot>/source-repos/<source>`)
- `sourcesRoot` absent (legacy flat manifest):
  `<source-clone>` = `<workspaceRoot>/<source>`

Before any structural read, materialize one read worktree per source off
its declared/pinned ref when one exists, otherwise off the source's latest
default branch. Follow the **Worktrees** protocol in your `AGENTS.md` /
`CLAUDE.md` briefing:

```bash
# for each <source> in manifest.sources, with <source-clone> resolved as above:
git -C <source-clone> fetch origin
source_ref="<declared-or-pinned-ref-if-present>"
if [ -n "$source_ref" ]; then
  remote_ref="refs/remotes/origin/$source_ref"
  if git -C <source-clone> rev-parse --verify --quiet "$remote_ref^{commit}" >/dev/null; then
    source_ref="origin/$source_ref"
  fi
fi
if [ -z "$source_ref" ]; then
  source_ref="$(git -C <source-clone> symbolic-ref --quiet --short refs/remotes/origin/HEAD || true)"
fi
if [ -z "$source_ref" ]; then
  git -C <source-clone> remote set-head origin --auto
  source_ref="$(git -C <source-clone> symbolic-ref --quiet --short refs/remotes/origin/HEAD)"
fi
git -C <source-clone> worktree add <workspaceRoot>/worktrees/seed-<source> "$source_ref"
```

Do not hard-code `origin/main`: GitLab and imported repositories often use
`master`, `trunk`, or another default branch. Do not pass a branch-like declared
ref such as `main` or `release` directly to `worktree add`; prefer the freshly
fetched remote-tracking ref (`origin/main`, `origin/release`) when it exists.
Preserve pinned SHAs, tags, and fully qualified refs that do not resolve as a
remote-tracking branch. Every "read every resolved source" / Tier 0–2 scan in
Phase 1 operates on these read worktrees, not the bare clone paths. Remove them
(`git -C <source-clone> worktree remove <path>`) once both PRs/MRs are open.

## The Two Phases

Resolving the tree's state comes first; the two phases below are the build
itself — they run for a tree that needs building (states A and B). State C
refuses before reaching them.

Before opening either review request, detect the Context Tree repo's forge from
its own `origin`: use `gh` and PR terminology for GitHub, or `glab` and MR
terminology for GitLab. Do not infer the tree forge from a source repo. Both
state A and state B use the provider recorded by the live binding; an uncertain
legacy provider stops remote mutation.

```
Phase 1 — Structure  (~3–10 min, main agent only)
  └─ Tiered structural read of every resolved source
  └─ Propose top + second-level domain skeleton
  └─ User approves checklist
  └─ Create NODE.md stubs + members/<owner> + raw-context
  └─ PR/MR 1 on chore/seed-phase1-structure

User merges PR/MR 1 ────────────────────────────────────────────

Phase 2 — Content    (parallel; ~10–20 min wall-clock per batch)
  └─ Allocate sub-agents (cap 6 concurrent; split big top-levels,
     merge thin ones, batch dispatch when total work units > 6)
  └─ Each sub-agent: deep-read its subtree, draft leaves, report coverage
  └─ Main agent: consolidate + cross-check + collect escalations
  └─ PR/MR 2 on chore/seed-phase2-content
```

The hand-off point between phases is the merge of PR/MR 1. Do not start
Phase 2 work before the user has signed off on the structure — the
sub-agent fan-out is expensive and Phase 2 inherits Phase 1's
structural decisions.

---

## Phase 1 — Structure

Phase 1 also proposes the root `SCOPE.md`. A new Tree has no SCOPE from which
to route, so Seed always starts from an explicit Team authority; never use the
multi-Team router to choose a Seed target. Draft a short, domain-neutral
natural-language description of what knowledge and work this Tree covers.
Do not require fixed headings, examples, or an exclusions section. Frontmatter
uses `schemaVersion: 1` and may include `relatedRepositories` when relevant.
Show the complete proposed SCOPE body in the Phase 1 human confirmation.
`SCOPE.md` is never silently inferred and committed: its later review also
requires the Context Reviewer manager's exact-head approval.

**Goal:** produce a top + second-level domain skeleton that reflects
the team's concern axes (not the codebase's directory layout), drawn
from observable signals across all resolved source repos.

### Tiered exploration

Read in three tiers; escalate from one to the next only when the prior
tier left a specific question unanswered.

| Tier | Action                                                                                                                                                                                                                                                                                                            | Cost                  | Yields                                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------- |
| 0    | Filesystem walk over every resolved source checkout (including declared bare-source read worktrees): **one listing pass per source** (a single `find`-style enumeration, depth-capped at 3–4 levels on huge repos), not repeated re-walks. List directories and well-known meta files. Filter out build artefacts (`node_modules`, `dist`, `build`, `.next`, `.turbo`, `.venv`, `target`, `.git`). Count file extensions, package boundaries, presence of `docs/`, `infra/`, `terraform/`, `k8s/`, `.github/workflows/`, `.gitlab-ci.yml`, and `.gitlab/`. | seconds, even on 10k+ files | monorepo shape, package boundaries, docs hierarchy, ops signals, file-type distribution |
| 1    | First-line / first-paragraph reads of meta files surfaced by Tier 0: top `README.md`, every `packages/*/README.md`, `docs/*.md` first H1, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`, `SECURITY.md`, `package.json` description fields, `gh repo view --json description,topics,homepageUrl` / `glab repo view` metadata where available (skip silently on **any** failure — 4xx, missing token, no network, no `gh` / `glab` binary; READMEs are the fallback). | 1–3 min total across all sources | one-sentence description per observed concept; product positioning; ops/contrib focus   |
| 2    | Surgical content read of a **specific** file that Tier 0+1 left ambiguous (e.g. `packages/foo/` exists, README is empty → read `packages/foo/src/index.ts` head 30 lines). Triggered per uncertainty, not as a blanket sweep.                                                                                       | 1–3 min per question, 0 if not needed | answer one structural question |

**Tier 2 is targeted, not exhaustive.** If you cannot articulate the
specific question Tier 2 will answer, do not do Tier 2 — you have
enough already. Sub-agents are allowed at this tier when multiple
independent Tier-2 questions exist, but the default is "main agent
reads in-line".

### From observations to domain candidates

Aggregate observations across all sources, then abstract:

- **Top-level domain candidates** describe a concern axis the team
  reasons about: e.g. `system/` for technical reality, `product/` for
  product intent, `customer/` for who is served, `marketing/` for how
  they are reached, `team-practice/` for working agreements, `goal/`
  for organisation-level direction. On a well-factored monorepo the
  concern axes and the package layout may largely coincide — that is
  fine. The rule guards against blindly mirroring directories, not
  against agreeing with a good layout; what matters is that each
  candidate is justified as a concern the team reasons about, even
  when the directory of the same name happens to exist.
- **No archetype templates.** Do not load a pre-baked "SaaS default"
  or "OSS default" set. Every candidate must be justified by a
  signal observed in the resolved sources. A domain that the sources do
  not motivate is a domain that does not belong.
- **Second-level domain candidates** under each top-level emerge from
  the same observations. For `system/`, package boundaries and docs
  organisation are the strongest signals. For `product/` and
  `customer/`, README positioning and marketing-site content are the
  strongest signals.
- **Supporting structure is automatic, not a candidate.** Ensure the
  generated policy's member content and archive/supporting intake nodes
  exist — in today's tree shape, `members/<owner>/NODE.md` and
  `raw-context/NODE.md`. State A's `tree init` may have already created a
  member index and creator node, so **extend those rather than recreating
  them** (add the computed owner if it differs from the creator). These are
  scaffolding, not concern axes; do not put them in the user checklist as
  toggles — but **do compute the primary owner now**
  (one `git log` per source, seconds) and show the derived name in
  the confirmation message, so the user confirms structure and owner
  in one round-trip instead of being asked twice.
- **ON / OFF marking rule.** Mark a candidate **ON** when ≥ 2
  independent signals support it, or one strong structural signal
  (a dedicated package, repo, or docs section). Mark it
  **ON, weak signal** when exactly one soft signal supports it (a
  README phrase, a single doc) — recommended but flagged so the user
  knows the evidence is thin. Mark it **OFF** when you considered it
  (because it is a common concern axis) but found no signal in the
  sources; listing OFF candidates shows the user what was looked at
  and rejected, which is itself information.

The generated policy's "add a directory only when the domain shape justifies
it" rule applies here as the ≥3 leaves threshold: Phase 1 may open a domain
when ≥3 leaves are **foreseeable**; Phase 2's job is to land them. There is no
separate "provisional" lifecycle — a domain that ends Phase 2 with 0 leaves is
ordinary follow-up maintenance later.

### User confirmation

Present the candidate skeleton as a markdown checklist in chat,
grouped by recommendation strength, with one-line evidence per item.
Example:

```
Based on a structural read of N source repo(s), here is the proposed
top + second-level skeleton:

system/                       [recommended ON]
 ├─ architecture.md           ← evidence: docs/architecture.md exists
 ├─ cli/                      ← evidence: apps/cli/ + docs/cli-reference.md
 └─ cloud/                    ← evidence: packages/server/ + packages/web/

product/                      [recommended ON, weak signal]
 └─ evidence: README L1-3 frames a product positioning (single soft
              signal — flagged so you know the evidence is thin)

team-practice/                [recommended ON]
 └─ evidence: CONTRIBUTING.md + AGENTS.md describe team workflow

customer/                     [recommended OFF]
 └─ evidence: no marketing site repo, no user-facing positioning

Proposed primary owner: gandy (412 commits in the last 6 months) —
say so if someone else should own the seed.

Reply with the domains you want to open (default: all "ON"). You can
add custom domains the signals did not surface.
```

Wait for the user's reply. Default behavior on plain "ok" / "yes" is
"create everything marked ON, skip everything marked OFF". The user
may toggle individual items, drop the OFF defaults entirely, or add
their own top-level domains. **Accept free-form replies** — the
box-drawing layout above is for reading, not a form the user must
echo back. "open system and ops, skip customer, also add compliance"
is a complete answer; interpret it and restate the final set in one
line before writing.

**This user-checklist step is what satisfies the policy requirement that
top-level domains require explicit human-owner approval.** The main agent
proposes candidates with evidence; the human is the one who actually opens
each one. Without an explicit "yes" from the user, do not create any top-level
domain — even ones marked "recommended ON".

### What to write

After the user confirms, create on the seed branch:

- `<tree>/NODE.md` — root index, with `## Active Domains`, `## Members`, and
  `## Raw Context` sections enumerating what was opened. Its description
  paragraph is drawn verbatim from the most-authoritative source README first
  paragraph, or summarised in ≤30 words if that paragraph is too long.
- `<tree>/SCOPE.md` — the approved domain-neutral routing description with
  strict schemaVersion 1 frontmatter; its complete body is the primary routing
  signal and optional related repository URLs are only supporting signals.
- `<tree>/members/<owner>/NODE.md` — see frontmatter spec below.
  Body has the owner's identity line plus a `## Recent Contributors`
  list (top 5 from `git log --since='6 months ago'`).
- `<tree>/raw-context/NODE.md` — one-paragraph statement of purpose
  ("intake for meeting notes, explorations, and material not yet
  promoted to a durable domain").
- For each approved top-level domain: a `<tree>/<domain>/NODE.md`
  stub with `title`, `owners`, one-paragraph statement of what the
  domain covers, and a `## Leaves` section listing the approved
  second-level entries (or "(none yet — Phase 2 will populate)" when
  the domain is opened without a second-level skeleton).
- For each approved second-level entry: a sub-`NODE.md` stub or a
  placeholder `.md` file, again with `title`, `owners`, and a
  one-paragraph charter — no leaf content yet.
- `<tree>/.first-tree/progress.md` — the exact Phase 1 marker, checked Phase 1
  line, Review gate line, Team id, canonical source ledger, and approved
  top-level list from `references/durable-progress.md`. Do not add an unchecked
  Phase 2 item.

### Frontmatter shape

Domain and leaf nodes carry the standard shape:

```yaml
---
title: "<noun phrase>"   # default = directory name titlecased (e.g. system/ → "System")
owners: [<primary owner>] # one entry; user reassigns later
---
```

Member nodes carry the extended shape required by
`first-tree tree verify`'s member validator:

```yaml
---
title: "<forge handle>"
owners: [<forge handle>]
type: human                # or "agent" — agents only when seeding an agent-team workspace
role: "Owner"              # neutral default; user adjusts to "Engineer" / "Product" / etc.
domains:                   # non-empty; default = the list of top-level domains opened in Phase 1
  - <domain-1>
  - <domain-2>
---
```

Notes on defaults:

- **Primary owner** = the most-active recent contributor across the
  resolved sources, computed from `git log --since='6 months ago'
  --format='%aN <%aE>' | sort | uniq -c | sort -rn | head -1`. Use
  the forge handle when `gh repo view` or `glab repo view` resolves the email;
  fall back to the `%aN` author name otherwise. Compute this **during
  Phase 1 exploration** and surface it in the confirmation checklist
  (see above) — the user's reply to that checklist is the owner
  confirmation; do not ask a second time unless the derivation was
  ambiguous (e.g. two contributors within ~10% of each other).
- **Member-node `role`** defaults to `"Owner"` because seed does
  not know the real role. Validator only requires non-empty; the
  user adjusts later.
- **Member-node `domains`** defaults to the list of opened
  top-level domain names (one entry per opened domain). Validator
  requires non-empty.
- Do **not** set `lastReviewed`. That field marks owner-reviewed
  state and is written only after a real owner review;
  stamping it on a bootstrap node makes unreviewed content look
  reviewed and hides it from future audits.
- Do **not** set `decisionLocksCode` (defaults false).

### PR/MR 1

- Branch: `chore/seed-phase1-structure`
- Show the diff to the user before push.
- Commit message: `chore: seed initial tree structure from <N> source repo(s)`
- PR/MR title: `Seed Phase 1 — initial tree structure`
- PR/MR body: enumerate which top + second-level domains were opened
  and which were proposed-but-skipped (one line each, with the
  user's reason if given). Do not list the source PRs/MRs or commits — the
  audit trail is `git log`.
- Run `first-tree tree verify --tree-path <tree>` locally before
  opening the PR/MR. Non-zero exit blocks.
- In portable mode, repeat `tree seed --team` immediately before the push and
  again before PR/MR creation. Require current Admin plus the same canonical
  binding repo and branch. Query the forge by the deterministic head branch
  first; reuse an existing branch or PR/MR instead of duplicating it.
- After creating or resolving/reusing the task's GitLab MR, run `first-tree
  gitlab follow <mr-url>`. A returned pending or active state is success; a
  follow failure does not invalidate the MR.
- Stop after the PR/MR is open. Do **not** start Phase 2 work until the
  approved structure and durable progress record are merged.

---

## Phase 2 — Content

**Goal:** populate each approved top-level domain with initial leaf
nodes drawn from a real read of the resolved source code, under a time
budget, with explicit coverage reports surfacing what was and was not
extracted.

### Trigger

Any explicit request to resume Seed after PR/MR 1 may trigger recovery; it can
arrive in a new process, agent, or chat. The agent does **not** poll the remote,
inbox, or any other source between phases. Run the exact Phase 2 recovery
algorithm in `references/durable-progress.md`: fresh explicit-Team preflight,
strict bound-branch fetch, detached merged-state inspection, marker and Team
validation, entry-for-entry source-identity comparison, recorded-commit
readability checks, and source worktrees materialized at those commits.

The old transcript and any private setup cache are irrelevant. A current-message
claim or familiar domain layout cannot replace the durable checks. `git ls-tree`
may inspect the exact Context Tree commit, but do not use `git ls-tree`, `git
show`, `git grep`, or similar content reads directly against a source bare clone.
Removing a temporary source read worktree after its evidence read is expected;
the proof is the materialize/read event, not a leftover checkout.

### Sub-agent allocation

Phase 2 must balance parallelism against three costs: token spend,
main-agent consolidation complexity, and the user's PR/MR 2 review
burden. The allocation policy below caps each batch at 6 concurrent
sub-agents and uses queue-batched dispatch so no approved domain is
deferred.

**No sub-agent dispatch available?** Some runtimes give the seeding
agent no sub-agent / task-dispatch tool (and sub-agents themselves
never get one — do not design nested fan-out). Fall back to
**sequential self-dispatch**: the main agent works through the same
queue one unit at a time, under the same per-unit contract — subtree
scope, time budget, stopping discipline, and a coverage report per
unit. Wall-clock is slower; the outputs and the PR/MR 2 shape are
identical. Everything below that says "sub-agent" applies to a
self-dispatched unit unchanged, except the parallel-write-safety
rules, which become trivial. **In sequential mode, still defer all
git commits until after the consolidation pass** — name normalisation
and the soft_links resolution check happen across every unit's
output and may rewrite earlier drafts; committing per-unit inline
would force consolidation fixes into extra commits and blur the
per-unit `git log` boundaries that PR/MR 2 review depends on.

**Concurrency cap: 6 sub-agents per batch.** Empirical limit.
Beyond this, wall-clock savings flatten while token cost and
consolidation overhead grow. Adjust in a future skill version if
real usage proves the number too low or too high.

**Default allocation: one sub-agent per approved top-level domain.**
When the user approved N ≤ 6 top-level domains and none meet the
split criteria below, dispatch one sub-agent per top-level. The
sub-agent's scope is the whole top-level subtree; second-level
entries are its working surface, not separate units.

**Split a top-level into multiple sub-agents** (one per second-level
under it). Splitting is a **cost decision**: split when the projected
work for one sub-agent exceeds what its budget can absorb. The
structural test is only the **eligibility filter** — a split needs
natural seams to split along. Both must hold:

1. *Eligibility:* the top-level has **≥ 3 second-level entries**
   opened in Phase 1 (fewer means no clean seams; an over-budget
   2-entry domain gets a bigger budget, not a split).
2. *Cost:* any of these indicators says one sub-agent's budget is
   not enough:
   - Source aggregate signal weight for this top-level ≥ 30 files
     of Tier-1 meta material to read (like the 6-cap, an empirical
     threshold — adjust in a future skill version if real usage
     proves it wrong).
   - A source repo / package is **dedicated to one specific
     second-level** (e.g. `apps/cli/` maps naturally to
     `system/cli/`). The mapping is then 1 source package →
     1 sub-agent.
   - The main agent's estimate of total work would push a single
     sub-agent past the 20-minute budget. Estimate it mechanically:
     ~1 min per Tier-1 meta file in scope, plus ~2–3 min per open
     Tier-2 question carried over from Phase 1, plus ~2 min per
     expected leaf for drafting.

Each split sub-agent's authority shrinks to its assigned
second-level path. It cannot touch sibling second-levels under the
same top-level — those belong to their own sub-agents and the
authority table's "modify a sibling domain's files = forbidden" rule
applies between split siblings, not just between top-level
siblings.

**Merge multiple thin top-levels into one sub-agent** when each
top-level has ≤ 2 source signals (counted as distinct Tier-1 meta
hits — the files / forge fields that motivated the domain in Phase 1)
AND ≤ 1 leaf expected **to be drafted by Phase 2 in this seed run**
(not "ever"). Weigh the **commit-boundary cost** before merging: a
merged pair lands as one commit spanning two domains, which blurs
the per-domain review boundary PR/MR 2 otherwise preserves. Merge only
when both domains are thin enough that the combined commit is still
trivially reviewable; when in doubt, run the thin domain as its own
quick work unit instead. A merged sub-agent's authority covers
**both assigned top-level paths in full** — the
"sibling = forbidden" rule applies between work units, not inside a
merged unit's pair. Surface the pairing in the PR/MR 2 body so the user
sees why one commit spans two domains.

**Batched dispatch when total work units > 6.** Maintain a queue of
work units (one per top-level, plus split children, minus merged
pairs). Fan out the first 6; as any sub-agent returns its drafts +
coverage report, immediately dispatch the next from the queue.
Continue until the queue is empty. **No work unit is deferred to
"Known Gaps" — every approved domain is seeded eventually**, just
across multiple waves. Wall-clock for a queue of ~12 ends up roughly
2× a single batch's runtime, not a linear blow-up, because the
slowest sub-agent in batch N gates the start of batch N+1 only if
its slot is the last to free.

Record the actual allocation (splits, merges, batches) in the PR/MR 2
body so the user can see why each commit covers the subtree it does
— and so they can spot if the main agent split or merged something
they would have left alone.

### Parallel write safety

Sub-agents run in parallel and may touch the filesystem simultaneously.
To keep them out of `.git/index.lock` contention and out of each
other's commit history, enforce two invariants:

1. **Sub-agents write files only.** They use Read / Write / Edit
   against `<tree>/<assigned-subtree>/` paths but do **not** call
   `git add`, `git commit`, `git push`, or any other git-mutating
   command. Their disjoint sub-paths guarantee filesystem-level safety.
2. **The main agent serialises every git operation.** After all
   sub-agents return their drafts + coverage reports, the main agent
   runs the consolidation pass (below), then groups files by
   sub-agent and lands one commit per sub-agent (`git add
   <sub-path>/... && git commit -m "..."`) on
   `chore/seed-phase2-content`. This keeps domain boundaries visible
   in `git log` without ever risking concurrent index writes.

### Sub-agent contract

Each sub-agent receives:

- The path of its assigned subtree (e.g. `<tree>/system/`).
- The Phase 1 stub it inherits (NODE.md text + the second-level
  entries already laid out, if any).
- The list of resolved sources and their on-disk paths.
- The time budget (default 15 minutes wall-clock; the main agent
  may set a lower budget for thin domains).
- The generated Context Tree Policy plus the seed-specific hard rules below.
- The **leaf shape target**: **up to ~60 lines** per leaf, structured
  as `## Decision` / `## Rationale` / `## Constraints` (matching
  the normal node shape; omit a section you don't need).
  Shorter is better when the signal is thin — a six-line node that
  captures the decision cleanly beats a sixty-line node that buries
  it; do not pad to hit a length. Consistently longer is a smell
  that implementation detail is leaking in; push it back to the
  source repo and keep the durable claim.

The sub-agent's authority within its assigned subtree:

| Action                                                                                                                                | Authority      |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Restructure inside its subtree (split / merge second-level, add third-level, rewrite NODE.md descriptions, adjust internal soft_links) | full           |
| Add new sub-domain branches (new sub-directories) under its assigned top-level                                                        | full           |
| Write `soft_links:` entries that **point into** sibling subtrees (read-only cross-domain reference; target file is not modified)      | full           |
| Modify a sibling domain's files or a parent NODE.md                                                                                   | **forbidden**  |
| Create a new top-level domain                                                                                                         | **forbidden**  |
| Modify `members/`, `raw-context/`, or other supporting structures                                                                     | **forbidden**  |
| Run any `git` command (`add` / `commit` / `push` / `checkout` / ...) — the main agent serialises git ops                              | **forbidden**  |

Forbidden actions become entries in the sub-agent's
**escalations list**, returned to the main agent: "I observed N
decisions that suggest a new top-level domain `security/`; I did not
create it." The main agent aggregates these for the user.

### Stopping discipline

Sub-agents **do not chase completeness**. Stop when any of these
holds, whichever comes first:

- **Time budget exhausted.** Wall-clock since dispatch ≥ assigned
  budget (default 15 min).
- **Three consecutive Read / Grep tool calls returned no new
  candidate leaf.** One tool call = one stop-check tick; an
  exploratory `Grep` that turns up nothing counts the same as a
  `Read` of a file that has nothing tree-worthy. After three ticks
  in a row, the domain's high-value veins are mined out.
- **Twelve leaves drafted in this domain.** Empirical cap from
  observing real seed runs; not a hard architectural limit. A single
  seed pass should not create a sixty-leaf domain — defer the rest
  to `first-tree-write` writes after the user has reviewed PR/MR 2.
  Adjust in a future skill version if real usage shows the number is
  consistently too low or too high.

### Mandatory coverage report

Every sub-agent returns, alongside its drafted nodes, a structured
coverage report:

```
## Coverage in <subtree>

Read:
- <path> (full)
- <path> (sampled)
- <path> (first paragraph)

Skipped (budget / out-of-scope):
- <path> — reason
- <path> — reason

Leaves created: N (see commits <sha-range>)

Known gaps:
- <one-line description of an unread area worth flagging>
- <one-line description of an open question worth flagging>

Escalations (forbidden actions surfaced for main agent):
- <one-line description>
```

Use exactly three read-depth tags, so reports aggregate cleanly
across sub-agents:

- `(full)` — the entire file was read.
- `(sampled)` — representative sections / head reads, not the whole
  file.
- `(first paragraph)` — only the first paragraph or first H1 block.

The main agent stitches every sub-agent's coverage report into the
PR/MR 2 description so the user can see, at merge time, exactly what was
and was not covered — and decide whether to accept, manually fill, or
re-run seed with a focused prompt.

### Main agent consolidation

After all sub-agents return:

1. Resolve naming inconsistencies across subtrees (different
   sub-agents may have named the same cross-cutting concept
   differently — normalise to one name).
2. Verify `soft_links` references resolve — mechanically, not by
   eyeball, and with the **same criteria `tree verify` enforces**: a
   valid target is either an existing `.md` file, or an existing
   directory that contains a `NODE.md`. A bare `test -e` is not
   enough — a directory without `NODE.md` (or a non-markdown file)
   exists on disk but still fails verify. Extract every
   `soft_links:` entry from every drafted node and check:

   ```bash
   # entries are tree-root-relative, e.g. /system/cli.md
   t="<tree>${entry}"
   { [ -f "$t" ] && case "$t" in *.md) true;; *) false;; esac; } \
     || [ -f "$t/NODE.md" ] \
     || echo "DANGLING: ${src} -> ${entry}"
   ```

   Where a sub-agent linked to a target that fails this check, drop
   the link and surface it as a known gap.
3. Aggregate escalations into a single section in the PR/MR 2 body
   ("Sub-agents flagged the following as out of their scope; user to
   decide whether to act now or later").
4. Run `first-tree tree verify --tree-path <tree>` from a clean
   checkout of `chore/seed-phase2-content`. Non-zero blocks.

### PR/MR 2

- Branch: `chore/seed-phase2-content`
- One commit per sub-agent (preserve domain boundaries for review),
  plus one consolidation commit at the end.
- PR/MR title: `Seed Phase 2 — initial leaves across <N> domain(s)`
- PR/MR body sections, in order:
  1. **Coverage report** — concatenated coverage reports from every
     sub-agent.
  2. **Escalations** — items sub-agents flagged as out of scope.
  3. **Known gaps** — the union of all per-domain known gaps.
  4. **Next steps** — point the user at `first-tree-write` for any
     follow-up source-driven writes and describe any broad maintenance
     gaps as focused follow-up tasks.
- Add the exact checked `Seed Phase 2 content` line to
  `.first-tree/progress.md` without changing its Team, source ledger, or
  approved top-level list.
- In portable mode, repeat the Seed preflight immediately before push and
  before PR/MR creation; require the same Team and binding, and reuse an
  existing deterministic branch or PR/MR by head.
- When the durable progress line is
  `Review gate: automatic-review-required`, re-run the exact selected-Team
  `review-config --as-member` read immediately before PR/MR creation. Require
  unambiguous JSON with a non-null `agentUuid` and `enabled: true`. Otherwise,
  do not open the Content PR/MR and handle only the observed state:
  - `agentUuid` is null: guide the Admin to **Settings → Getting Started** to select and
    enable a Reviewer. Repeat the Structure-PR Agent as the default only when
    this is still the same Phase 1 process and its identity remains explicit in
    working context; a fresh-process recovery asks the Admin to choose without
    naming the recovery Agent as that default.
  - `agentUuid` is present and `enabled` is false: preserve the selection and
    guide the Admin only to enable Automatic Review in **Settings → Getting Started**.
  - the read fails or is ambiguous: say that Reviewer configuration could not
    be confirmed and retry the read; infer no selection or enablement action.
  This gate delays only the Content PR/MR remote mutation, not Structure
  review, Context reads, or content drafting.
- After creating or resolving/reusing the task's GitLab MR, run `first-tree
  gitlab follow <mr-url>`. A returned pending or active state is success; a
  follow failure does not invalidate the MR.

After PR/MR 2 opens, the seed skill is done. Do not repeat the Review Agent
handoff from Phase 1. Under the explicit Welcome Reviewer contract, say only
that this Content PR/MR is the concrete Automatic Review verification
milestone; do not poll for, simulate, or claim a Reviewer verdict. Subsequent
writes are owned by `first-tree-write`; subsequent maintenance uses focused
tasks with explicit scope.

### Recovery path: PR/MR 1 merged, Phase 2 abandoned

A user may merge PR/MR 1 and then never come back for Phase 2. The tree ends up
with real structure and a durable checked Phase 1 record but zero leaves. **This
is not a new re-seed condition.** A later explicit continuation from any new
process, agent, or chat can complete Phase 2 only after the durable recovery
algorithm passes. A populated tree without that record remains state C and
refuses. For that unrelated path:

- Future writes go through `first-tree-write` one source at a
  time, exactly as they would on any other live tree.
- A team that wants to back-fill the missing leaf content can ask for
  a focused maintenance pass with explicit source scopes; any actual
  writes still go through `first-tree-write` one source at a time.

Communicate this fallback to the user in PR/MR 1's body so the choice
is visible: "If you merge PR/MR 1 without coming back for Phase 2, the
tree is fully usable but empty; later writes go through
`first-tree-write` or a focused maintenance follow-up."

---

## Hard Rules

These apply the generated Context Tree Policy to the seed-specific surface.

- **Smallest correct edit.** A six-line NODE.md that captures the
  domain's charter beats a sixty-line one that buries it. Phase 1
  stubs are short on purpose; Phase 2 leaves are short on purpose.
- **No diffs, no code detail in nodes.** Function signatures,
  request shapes, retry constants stay in the source repo. The tree
  records the durable decision and the rationale.
- **No PR/MR references in node bodies.** The audit trail for "which
  PR/MR delivered this seed" lives in `git log`. Nodes carry their
  present-tense claim alone.
- **No history.** Nodes state current truth. Past states live in
  `git log`. Do not preface a node with "Originally we…" or
  "Update 2026-XX-XX:".
- **`first-tree tree verify` must pass before PR/MR 1 and PR/MR 2 land.**
  Non-zero exit blocks the commit.
- **Remote failures preserve truth.** Recheck live Admin and binding before
  every push and PR/MR creation. After a possible mutation, inspect the
  repository, deterministic branch, PR/MR-by-head, and Server binding before
  reporting; never claim rollback.
- **Ownership changes go through humans.** Phase 1 sets `owners` to
  the workspace's primary owner as the default; reassignment is the
  user's job, not the agent's.
- **Do not invent.** If a fact is not in the read signals, leave it
  out. A missing node is a question; a fabricated node is a trap.

## What This Skill Does NOT Do

- Run the Cloud one-click **server** bootstrap. When the team has no tree
  (state A), seed creates and binds it with `first-tree tree init` (the user's
  local `gh`/`glab` and `git` identity selected by the explicit provider), not
  the server `/initialize` path — the two coexist. Seed does not write the
  workspace-root `workspace.json`; that stays a runtime concern.
- Install GitHub automation beyond the default-branch ruleset applied after a
  newly created GitHub Context Repo (validate workflows, CODEOWNERS ownership,
  extra rulesets) — out of scope. If the team wants those, they are separate
  follow-on workflows after seed lands.
- Touch `AGENTS.md` / `CLAUDE.md` managed blocks at the tree root —
  those are owned by the CLI runtime.
- Generate content beyond what the signals support. If a candidate
  domain has weak evidence and the user does not opt it in, leave it
  out.
- Start a second seed on the same tree. Once the tree has domain structure,
  only the verified durable Phase 2 continuation remains in scope;
  other work hands off to `first-tree-write` or a focused maintenance task.

## References

The generated `AGENTS.md` / `CLAUDE.md` briefing carries the shared Context
Tree Policy. Read `references/durable-progress.md` only when writing Phase 1
progress or evaluating/resuming Phase 2; it is the single detailed recovery
contract.
