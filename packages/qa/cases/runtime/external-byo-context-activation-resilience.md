---
id: runtime-external-byo-context-activation-resilience
description: Validate fail-closed BYO Context activation across provider hooks and explicit CLI operations under transient authority failures.
areas: [runtime]
surfaces: [cli, client]
---

# External BYO Context Activation Resilience

## Goal

Confirm that a user-scoped Claude Code or Codex Context Plugin activates only for
the resolved enabled project, remains within the provider hook's execution budget,
and gives explicit Context operations a bounded recovery path when live authority
is temporarily slow or unavailable.

Use this case for release qualification when SessionStart behavior, activation
latency, or live authority resilience changes. Stable retry classification and
timeout values belong in product tests; this case validates the real provider,
installed Plugin, CLI artifact, network boundary, and user-visible behavior
together.

## Preconditions

- Run the target release artifact in an isolated QA cell with a real supported
  Claude Code or Codex provider bridge.
- Install the Context Plugin through the real user-scope lifecycle and enable it
  with two Team grants through Team-scoped handoffs.
- Keep a second path project without applicable grants as a negative control.
- Use only throwaway Team data and credentials. Source repositories must remain
  absent from Team resources.
- Establish provider readiness with `runtime-provider-readiness` before treating
  a hook transcript as product evidence.

## Operate And Observe

- Start, resume, clear, and compact a provider session with applicable grants.
  Observe the real SessionStart hook transcript and measure end-to-end hook time.
- Install an older, complete protocol-v1 thin adapter with a newer CLI release.
  Confirm SessionStart returns `adapter_sync_required` plus one exact action
  within its deadline and never invokes provider installation. Let the agent run
  that action in the normal turn. If update succeeds, current Context work
  continues on the already loaded adapter; if the provider update fails and
  rolls back, confirm `update_deferred` keeps that known-good adapter usable and
  does not surface an internal failure to the user.
- For Claude, verify the current task may continue on its already loaded adapter
  after automatic sync. Trigger resume, clear, and compact on that same session;
  each must use the session-and-old-digest compatibility record, avoid repair
  guidance, and leave any next-session obligation untouched. A different
  session or digest must not reuse that record. Interleave two old sessions'
  sync actions; the first global Plugin update must preserve both sessions and
  make the second action idempotent. Issue a third action after the first sync
  has scanned existing receipts but before provider mutation; issuance itself
  must have already persisted its inert fact and recoverable action. Inject an
  exit after the provider update commits but before the sync command returns;
  the prewritten compatibility fact must make both retry and the next lifecycle
  event usable without repair guidance. Repeat an already successful Claude
  challenge and confirm its TTL-bound terminal result remains idempotently
  successful. Then issue an old-adapter action before a separate repair creates
  a next-session obligation; replay and lock-busy fallback must require a new
  Claude session rather than report `currentAdapterUsable=true`. Hold the
  account-state lock before the repair has written its obligation and confirm
  that lock acquisition failure alone remains fail closed. Issue another Claude
  action after an operation snapshot, force the provider
  update to roll back, and confirm snapshot restoration does not erase the
  action's fact or TTL backup; its original challenge must still retry safely.
  For Codex,
  require `/hooks` trust only when the provider reports a changed Hook identity.
  Both providers must use the updated adapter on the next session.
- Independently tamper one stable stub, one provider-cache file, and one partial
  cache tree while leaving the embedded digest literal unchanged. SessionStart,
  status/setup and the next persistent task route must reject the unhealthy
  payload; session-only loading remains independent. The new Claude Plugin must
  not contain a same-session adoption hook or receipt path. Invoke the retired
  command shape from an already-loaded adapter 1.0.1 and confirm it is a pure
  no-op with no receipt or state mutation. After a route succeeds, snapshot and
  Write boundaries must
  rely on the routed candidate and their live authority checks rather than
  repeatedly hashing the provider-owned Plugin cache.
- Run standalone Claude repair twice for the same adapter version. Confirm the
  provider cache version and complete payload digest remain identical. `context
  status` must report a healthy payload plus a separate next-session obligation;
  manual persistent routing in the old session remains blocked. Start a new
  Claude session and verify its exact SessionStart consumes the obligation and
  persistent routing resumes without another Team setup apply.
- Repeat in the ungranted path and confirm no Team Context is injected. Choose
  session-only in a projectless session and confirm it works now without
  Plugin/Hook/grant state but does not reactivate after clear/compact/new session.
- Exercise `context status`, guarded Read, and guarded Write preflight through the
  shipped CLI artifact while the activation endpoint is healthy.
- Repeat with an access token that requires refresh. Introduce slow refresh,
  refresh-network, and refresh-5xx conditions and confirm they consume the same
  per-attempt budget and retry policy as the validator request rather than
  extending the operation behind the provider hook.
- Introduce controlled transient authority conditions for timeout, network
  failure, and server 5xx. Verify an explicit operation retries only the same
  exact Team, at most once, and reports a stable safe reason if it
  still cannot activate.
- Introduce authentication/authorization failure, a client 4xx, revoked
  membership, and invalid Tree binding. Verify these do not retry as
  transient failures and do not fall back to another Team or cached authority.
- Make live authority slower than the SessionStart internal budget. Confirm the
  provider hook completes within its outer budget with a controlled unavailable
  result, normal coding remains usable, and no Context is injected.

## Evidence

Record provider version, Plugin adapter version/digest and Core release digest, resolved project kind/reason, exact
Team identifier, hook transcript, operation output, endpoint fault used, attempt
count, and latency. Redact credentials and private Context content.

## Expected Result

`PASS`: bound healthy sessions inject the exact Team Context; routine adapter
updates remain user-transparent and perform no install inside SessionStart; unbound sessions
remain inactive; SessionStart always returns within the provider hook budget;
explicit operations make only the allowed same-target transient retry; and every
unresolved authority failure remains fail closed with a stable actionable
classification.

`FAIL`: a hook is killed by its outer timeout under a valid supported latency
condition, an explicit operation exceeds its retry bound, a non-transient failure
is retried, cached or alternate-Team authority is used, or unavailable authority
still permits Read/Write.

`BLOCKED`: the provider cannot be made one-turn-ready, the Plugin cannot be
installed in the isolated environment, or controlled authority faults cannot be
introduced without changing shared production state.

`INCONCLUSIVE`: timing or retry evidence is incomplete, the failure cannot be
attributed to the target release, or provider and authority failures overlap in a
way that prevents classification.
