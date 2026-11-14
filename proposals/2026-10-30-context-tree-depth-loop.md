# Context Tree Depth Loop Proposal

**Status:** Draft
**Date:** 2026-10-30
**Scope:** Context Tree content model, authoring skills, verify/impact/eval surface

## Summary

First Tree's Context Tree is intentionally decision-level: `first-tree-seed`
and `first-tree-write` capture durable decisions, constraints, ownership, and
cross-domain relationships, while implementation detail stays in source repos.
That default is correct, and this proposal does not change it.

The gap is what happens after the first pass. In practice, authors stop as soon
as a node exists. The node states the decision, but not the decisive facts a
future agent needs to answer a judgment question: default values, branch order,
state registration, config read paths, failure handling, and the exact source
of each claim. There is also no quality signal beyond `tree verify` structure,
so a team cannot tell whether adding more nodes improved answerability.

This proposal adds an **opt-in depth mode** in three parts:

1. an evidence sidecar that stores claim-level, source-anchored facts outside
   node prose;
2. a `first-tree-deepen` skill that proposes evidence patches for one domain;
3. a `first-tree-eval` skill (and `tree eval` surface) that measures whether
   the tree can answer blind judgment questions and maps failures back to
   missing claims.

The default remains concise. Depth mode is per-domain, lazy-read, and
non-canonical, so the Double Test and the "no code detail in nodes" rule still
hold.

## Problem

### What authors produce today

The current authoring loop optimizes for a valid node:

- `first-tree-seed` targets up to ~60 lines per leaf;
- `first-tree-write` says "No code detail in nodes" and "default to not
  writing";
- `tree verify` checks frontmatter, node shape, members, scope, and tree state.

An agent that follows these rules exactly produces a clean decision record. It
has no reason to add the operational facts that make the record answerable,
because nothing in the loop asks for them and nothing measures their absence.

### Why this is not just "write more"

The Double Test deliberately rejects information that would rot when the next
refactor lands. Much of the missing material looks like implementation detail
at first glance. But a large subset is **operational invariant**:

- which value is the default when a config key is absent;
- which branch runs first, and which branch becomes dead code;
- whether a state is registered or only declared as an enum;
- which config node is global and which is per-application;
- what happens when a downstream call fails or returns a non-zero code.

These facts survive many refactors and are exactly what a future agent needs
to answer "is this safe to ship", "why did this stop", or "what do we do now".
Today they have no sanctioned home: they are either omitted, or written into
node prose where they drift and violate the policy.

### What we measured

We applied a blind evaluation loop to a real 98-leaf tree (12 structural checks
green, 691 cross-domain edges, 1,221 file anchors):

| Signal | Result |
| --- | --- |
| Blind answerability, first pass | 40.9%–54.1% coverage; 57.5%–60.0% decision accuracy |
| Source facts that contradicted the first write-up | 3–10 per deepening batch, 40+ total |
| Expected answers that were themselves wrong | 7 |
| Blind answerability after evidence-level deepening | 60.2%–83.8% coverage |
| Structural checks after deepening | unchanged (still 12/12) |

The structural checks never moved. The difference was entirely whether the
decisive claim existed and was anchored to source.

This is the failure mode to design against: **a tree can be structurally
perfect and still unable to answer the questions it exists for.**

## Goals

- Give source-anchored operational facts a first-class, opt-in home that does
  not pollute node prose.
- Make tree depth measurable with blind questions, not word count.
- Turn evaluation failures into scoped evidence patches, not whole-node
  rewrites.
- Preserve the current default: decision-level nodes, lazy reads, no
  implementation walkthroughs in normal content.

## Non-Goals

- Replacing source repos as the implementation source of truth.
- Encouraging every team to write runbooks into the tree.
- Adding a general-purpose RAG index or vector store.
- Changing node frontmatter or the node shape by default.
- Making evaluation a CI gate for every tree on day one.

## Design

### Three layers

| Layer | Content | Read policy | Canonical? |
| --- | --- | --- | --- |
| Node | Decision / Rationale / Constraints / Cross-Domain | always | yes |
| Evidence | Claim records with source anchors | on demand | no, evidence |
| Evaluation | Blind questions, answers, scores | never in agent context | no, measurement |

Node prose stays as it is. Evidence and evaluation live beside the tree, not
inside node bodies.

### Evidence sidecar

**Placement (MVP):** `raw-context/evidence/<domain>/<leaf>.jsonl`.

This reuses the existing `archive-supporting` content class: `tree verify`
already treats `raw-context/` as evidence rather than canonical truth, and
normal reads do not load it. No new content class, no node schema change.

**Record schema:**

```json
{
  "id": "system/log-police/local-lock-reset",
  "node": "system/log-police.md",
  "kind": "default",
  "claim": "When the local lock cannot be acquired, the counter for the same key is reset to 0 before returning failure.",
  "sources": [
    {
      "repo": "log-police",
      "path": "src/main/java/.../LockUtilsLocalCache.java",
      "line": 33,
      "quote": "counter.set(0);"
    }
  ],
  "validAt": "2026-10-30",
  "confidence": "verified",
  "supersedes": [],
  "contradicts": [],
  "dependsOn": ["system/log-police/local-lock-enabled"]
}
```

Rules:

- `confidence: verified` requires at least one source with `line` and verbatim
  `quote`.
- `kind` is a small closed set: `decision`, `constraint`, `default`, `branch`,
  `failure`, `metric`, `contract`.
- `validAt` is the date the quote was last checked, not the date the claim was
  written.
- `supersedes` and `contradicts` are claim ids; contradictions must be resolved
  by a human before the next release.
- `repo` resolves through a tree-level `raw-context/evidence/sources.json`
  mapping repo id to a checkout or URL. This avoids absolute paths and works
  for multi-repo trees.

### Typed relationships

Evidence records can declare a small set of typed edges:

| Edge | Meaning |
| --- | --- |
| `dependsOn` | This claim is only true while the target claim holds |
| `guards` | This claim protects the target behavior |
| `failsWhen` | The condition under which the claim stops holding |
| `measuredBy` | The metric, log, or probe that observes the claim |
| `contradicts` | Two claims cannot both be true |

Edges are intentionally few. A large ontology would recreate the documentation
problem in a new format.

### Skills

#### `first-tree-deepen`

A source-driven second pass over one domain. It:

1. reads the domain's nodes and existing evidence;
2. reads the declared source repos;
3. proposes **claim patches**: add, supersede, or contradict;
4. optionally proposes a minimal node edit when the decision itself changed;
5. never rewrites a node wholesale;
6. stops when the evidence budget for the domain is reached or the source stops
   producing decisive facts.

The skill reuses the existing write guardrails: explicit source artifact,
scoped PR, human review, no unilateral ownership edits.

#### `first-tree-eval`

A three-party isolation loop:

```text
question writer (source only, no tree)
  -> answerer (tree + evidence only)
  -> judge (expected answer + rubric only)
  -> attribution (missing claim / protocol / runbook)
  -> evidence patch proposal
```

Outputs per run:

- coverage: required constraints present in the answer;
- decision accuracy: answer matches the expected decision;
- hallucination: claim conflicts with its own quoted evidence;
- irrelevant: claim is true but does not answer the question;
- gap map: question id -> missing claim ids -> node.

The eval set is frozen per run and never used to author the same run's
evidence. New sets are generated from source, not from the tree.

### CLI surface

```text
tree verify --evidence          # anchors, quotes, contradictions, staleness
tree impact <claim-id|field>    # affected nodes, claims, questions
tree eval run --set <path>      # blind loop, writes a report
tree eval report <run-id>       # coverage / decision / hallucination
```

`tree verify --evidence` is additive: existing trees without `raw-context/evidence/`
pass unchanged.

`tree impact` answers the question node links cannot: if this claim changes,
which nodes and which judgment questions are affected?

### Read path and token budget

- Evidence is never loaded by the default read path.
- When an agent asks an operational question, the read skill retrieves the top
  claims by node and keyword, capped at a small budget (for example 8 claims /
  1,500 tokens).
- Claims are returned with `claim + source path + one-line quote`, not the full
  record.
- Node prose does not grow in depth mode; the extra context is paid only when
  a question needs it.

## Compatibility With The Current Policy

| Policy rule | How depth mode complies |
| --- | --- |
| Tree records what was decided and why; source records how | Evidence records are explicitly non-canonical and live under `raw-context/`, which is already an evidence class |
| Double Test | Evidence does not enter normal content; the decision layer still passes the Double Test |
| No code detail in nodes | No node prose change; code anchors live in the sidecar |
| Default to not writing | Depth mode is opt-in per domain; default authoring behavior is unchanged |
| `tree verify` must pass | `--evidence` is additive; base verify behavior is untouched |
| Keep tree prose current-state | `validAt` plus `tree verify --evidence` detects stale anchors instead of hiding them in prose |

## Rollout

### Phase 0: schema and verify (1 week)

- add the evidence schema and `sources.json`;
- implement `tree verify --evidence` for anchors, quotes, contradictions;
- pilot on one 10–15 leaf domain;
- success: 100% of pilot claims have a verifiable quote.

### Phase 1: deepen skill (2 weeks)

- implement `first-tree-deepen` with a claim-patch output;
- run one domain end to end with human review;
- measure review time per patch and claim density;
- success: ≥5 verified claims per leaf, review time <10 minutes per patch set.

### Phase 2: eval loop (2 weeks)

- implement `first-tree-eval` and `tree eval run`;
- generate a 40-question blind set for the pilot domain;
- measure coverage, decision accuracy, hallucination;
- success: coverage +10pp over the structural-only baseline, hallucination ≤1%.

### Phase 3: impact and depth score (optional)

- implement `tree impact`;
- publish a depth score per domain: claim density, decision coverage,
  relational completeness, freshness, contradiction resolution.
- success: a config/field change lists affected nodes and questions in under a
  minute.

## Success Criteria

Pilot domain:

- blind coverage improves by ≥10 percentage points;
- decision accuracy ≥70%;
- hallucination ≤1% of required constraints;
- node length growth ≤20%;
- every verified claim has a source quote and passes `tree verify --evidence`.

Repository level:

- `tree verify --evidence` completes in under 2 seconds for 1,000 claims;
- a delta regression (affected questions + 20% control) runs in under 10
  minutes;
- no evidence record is read by the default agent context.

## Risks

| Risk | Mitigation |
| --- | --- |
| Evidence rot after refactors | `validAt`, `tree verify --evidence`, and a stale-anchor report; fail closed on merge |
| Policy drift toward runbooks | Sidecar is non-canonical and lazy; normal content unchanged; depth mode is opt-in |
| Token bloat | Retrieval cap per question; one-line quotes in context; no node growth |
| Eval overfitting | Frozen blind sets, rotation, and a rule that the current run's evidence cannot be authored from its own questions |
| Claim explosion | Closed `kind` set, one claim per atomic fact, dedupe by `id`, domain budget |
| Multi-repo path drift | `sources.json` indirection; no absolute paths in records |

## Open Questions

1. Should evidence live under `raw-context/evidence/` for MVP, or should we add a
   distinct `evidence` content class to keep it out of archive exports?
2. Who approves a claim: the node owner, a domain reviewer, or the audit
   workflow?
3. Should stale evidence block `tree verify` or only warn until the next
   review cycle?
4. Is `tree eval` a CLI command, a skill-only workflow, or both?
5. How should the depth score interact with the existing `lastReviewed` and
   `decisionLocksCode` frontmatter?

## Additional Context

The measurement methodology, frozen-set protocol, and scoring scripts are
independent of any specific tree. A de-identified calibration set and a pilot
domain with before/after numbers can be provided if the direction is useful.
