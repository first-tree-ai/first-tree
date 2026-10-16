---
id: cli-doctor-http-reachability
description: Verify the built dist CLI `doctor` reaches a running server over HTTP and reports a coherent readiness snapshot (config, server, provider detection).
areas: [cross-surface]
surfaces: [cli, server]
---

# CLI Doctor HTTP Reachability

## Goal

Confirm the built dist CLI binary reaches a running server across process lines over HTTP via the credentials-free
`doctor` readiness command, and resolves config and provider capability. This exercises the CLI handoff through the built
dist binary that `system/cloud/release/verification.md` marks as unguarded by automated tests.

**Scope caution — this case does NOT cover the WebSocket upgrade/protocol layer.** `doctor`'s "WebSocket" line is not a
real WebSocket connection: `checkWebSocket()` in `apps/cli/src/core/doctor.ts` performs an HTTP `GET ${serverUrl}/healthz`
and, on success, relabels it `ws://<server> (server reachable)`. It never opens a WebSocket or attempts the upgrade/
framing. So a PASS here proves HTTP reachability only; the real WS protocol + inbox-delivery layer stays unguarded and
needs a separate case that opens an actual WebSocket.

Use this case for release-candidate QA of CLI-to-server HTTP reachability and the dist-binary readiness report. It is a
reachability smoke, not a WebSocket, authenticated-session, or agent-turn test.

## Preconditions

- Isolated run cell with the server running (see `release-boot-health`) and the CLI built from the target ref.
- The CLI runtime can resolve the server host — same Docker network with `FIRST_TREE_SERVER_URL` set. (Top-level
  `doctor` has no `--server` flag; it reads config / `FIRST_TREE_SERVER_URL` via the shared resolver.)
- No login, agent, or provider credentials required. `doctor`'s config, server-reachability, and provider-detection
  checks are credential-free; the agent and background-service checks are expected to report not-configured in a fresh
  run cell.

## Operate

- `operate cli-command`: run the built dist CLI `doctor` with the server URL in the environment, e.g.
  `FIRST_TREE_SERVER_URL=http://server:8000 node apps/cli/dist/cli/index.mjs doctor`.

If the CLI is an installed package rather than an in-tree dist build, run the packaged `doctor` and record the exact
invocation in the plan and report.

## Observe

- `observe command-output`: `doctor` reports, at minimum:
  - Node.js version check passes;
  - config resolves (config file + env vars);
  - Server URL check passes for the configured server;
  - the "WebSocket" line reports `(server reachable)` — understood as the HTTP `/healthz` reachability indicator, NOT a
    real WebSocket connection (see Scope caution);
  - provider capability checks resolve (bundled or path per provider);
  - Agents and Background service are reported not-configured in a fresh, unlogged-in run cell — expected, not a product
    failure.
- `observe command-output`: the command exits 0 even when it prints expected no-login "issues" (agents / background
  service).

If the readiness report format changes during product work, follow the current output but keep the evidence focused on
the same behavior: the dist CLI reaches the server over HTTP and reports coherent readiness.

## Expected Result

`PASS`: the dist CLI reached the server over HTTP and the config / server-reachability / provider checks are healthy; the
agent and background-service "issues" are the expected no-login state. (This PASS asserts HTTP reachability only, not the
WebSocket protocol layer.)

`FAIL`: a reproducible product defect — the CLI cannot reach a healthy server, config fails to resolve, or `doctor`
crashes.

`BLOCKED`: the CLI cannot be built, or the server is not running in the run cell.

`INCONCLUSIVE`: output was partial, unstable, or not attributable to the target ref.

## Evidence

Keep the full `doctor` output, including the server URL line and exit status. Redact any tokens or credentials before
sharing outside the run.
