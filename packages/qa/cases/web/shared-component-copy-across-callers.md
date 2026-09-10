---
id: shared-component-copy-across-callers
description: Copy removed from a shared UI component because it duplicated a neighbouring line must still leave every other caller able to state its own remedy.
areas: [web]
surfaces: [web]
---

# Shared component copy across callers

## Goal

Validate that a change to a copy slot inside a **shared** UI component leaves every screen that
mounts that component still saying what the reader needs. The specific risk is a deletion justified
by local redundancy — "this repeats the sentence directly above it" — when the sentence that made it
redundant is contributed by one caller and not by the others. On those other callers the deleted
line was the only statement of the remedy, and both the diff and the screen the author was asked to
fix read as correct.

The same question applies in the other direction: copy added at one caller can duplicate a line that
the shared component already renders for a different caller.

Deterministic caller-level rendering tests own the sentence once it is known to belong to a given
caller. This case owns the discovery step that precedes them — deciding which callers lose meaning,
which are genuinely unaffected, and whether the surrounding frame still tells the truth — which
requires reading assembled screens rather than the component in isolation.

## Trigger

Select this case when a change touches copy on either side of the shared/caller boundary, in a
component that has more than one importer:

- **Removal side** — it removes, moves, or narrows a copy slot, lead line, empty-state sentence,
  helper text, or its reserved layout row inside the shared component, and the stated rationale is
  duplication, redundancy, density, or spacing. That rationale is the signal: it was assessed
  against one caller's assembled screen, and this case exists to test it against the rest.
- **Addition side** — it adds copy at one caller, whether to say something the shared component no
  longer says or to say it in that caller's own words. The added line is scoped to one caller while
  the component's copy is not, so it can duplicate what the component already renders for another
  caller, or for another state of the same caller.

Both shapes reach the same validation question: which callers does this copy actually reach, and
what does each of them read like once assembled. A fix for a finding on the removal side usually
arrives as an addition, so the follow-up commit re-selects the case on the other branch.

## Preconditions

- A run cell that can build and serve the real web bundle for two refs — the change under test and
  its merge base — against the same seeded data. Reusing one warm environment across both builds is
  preferred so the only difference is the ref.
- Seeded state that actually reaches the affected component state on **each** caller. Callers often
  differ in how the state is entered, and a state that is trivial to seed on one screen may require
  a different fixture on another.
- When the copy is localized, every locale it exists in; when the slot also carried layout, at
  least one narrow viewport.

## Operate and observe

- Enumerate the importers of the component from source, then for each caller read what it renders
  **around** the slot — not merely that it renders the component. Record, per caller, whether the
  neighbouring sentence that made the slot redundant is present. Treat a caller that does not render
  it as losing content until a live observation says otherwise.
- Drive each caller to the affected state in a real browser and capture the rendered text of the
  region, not a source reading. A caller that cannot be reached with the available fixtures is an
  unverified caller; say so rather than reasoning about it from the diff.
- Check the **mode or variant** each caller passes. A component may expose states one caller can
  never enter — for example a create-style mode whose initial state skips the state whose copy was
  removed. That is a genuine exemption, but it must be verified live on that caller, not assumed by
  symmetry with the caller that was fixed.
- Read the surrounding frame after the removal. A step footer, progress hint, or heading that
  instructs the reader to "complete the action above" becomes false when the only remaining content
  above it is an escape hatch such as a reinstall or support link. Judge the assembled step, not the
  removed line.
- When the change instead adds caller-local copy, check it against everything the shared component
  already says: the other states of that same caller, where two sentences that previously shared one
  slot can now appear together, and the other callers, where the component may already contribute
  the same line. Decide for each pair whether it reads as complementary or as a duplicate, and
  record the judgement so a later reader does not file it as a regression.
- If the fix is accompanied by a regression test that asserts the restored copy, judge whether that
  guard is specific to the **sentence** or only to its container. Read the assertion: it should
  match the exact restored string, or an accessible name that only that copy can satisfy, on the
  caller that lost it and in the state that lost it. A guard that asserts a wrapper rendered, a test
  id exists, or some non-empty text appeared would still pass with the sentence gone — say so
  instead of treating the test's presence as coverage. Do not modify product source to find out;
  that is forbidden while testing at every tier. Where the author already ran a mutation check, cite
  their result rather than reproducing it.

## Evidence

- A per-caller table: caller, entry path, mode/variant, state reached, and the rendered text of the
  affected region, at base and at the target.
- Base-versus-target screenshots of the **same** seeded state on each affected caller, plus the
  narrow-viewport and non-default-locale captures when the slot carried layout or localized copy.
- The base control must be a real build of the merge base driven through the product, never a diff
  reading. Verify the base build actually rendered base copy before trusting it: any generated-copy
  step that was not re-run for the base build will silently serve target copy from a base checkout,
  which reads as "no change" and hides the finding. A cached shell, a stale prebuilt bundle, a
  compiled message catalog left unregenerated, and code-generated string constants are all
  instances of it.
- When a regression guard accompanies the change, the quoted assertion and the caller and state it
  runs against, plus the author's own mutation-check result if they reported one.
- Browser console and page errors for each observed state.

## Expected result

`PASS`: every caller was reached live, each one either still states its own remedy or was shown to be
unable to enter the affected state, any added copy reads as complementary rather than duplicated
wherever the component already speaks, the surrounding frame remains truthful, and any accompanying
regression guard asserts the sentence itself rather than its container.

`FAIL`: a caller renders the affected state with no statement of the remedy, a frame instructs the
reader toward content that no longer exists, an added line duplicates existing copy on another
caller, or an accompanying guard asserts only a container and would still pass with the sentence
gone.

`BLOCKED`: the base build, a caller's entry path, or the seeded state required to reach the affected
state on some caller is unavailable, so the comparison cannot be made.

`INCONCLUSIVE`: some callers were verified and others only reasoned about from source, the base
control cannot be shown to have rendered base copy, or the observations cannot be attributed to the
exact refs.
