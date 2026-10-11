---
id: opencode-provider
description: Validate the external OpenCode CLI provider end to end — private config projection, per-turn JSONL, session resume, queueing, auth, and process drain.
areas: [runtime]
surfaces: [web, cli, server, client]
---

# OpenCode Runtime Provider

## Goal

Confirm that an agent bound to `opencode` runs through a supported external CLI, reuses provider-owned
host-local authentication without giving First Tree token custody, and preserves First Tree's delivery, session,
configuration, Context Tree I/O, and process-drain contracts.

Use this case when the OpenCode handler, binary resolver, capability probe, private config projection, parser, model
surface, or provider supervisor changes.

## Preconditions

- Run in the isolated QA cell selected by the plan: Docker plus a temporary source worktree, with an explicit native
  bridge only where the OS process authority cannot live inside Docker. Never modify the operator checkout.
- Install an OpenCode version in the product's supported `>=1.18.7 <3.0.0` range (1.x and 2.x) on the client host and complete provider-owned setup with
  `opencode auth login`. The test may prove the login by completing a real turn, but must not read, copy, print, or
  archive provider credential files.
- Use disposable source, MCP, and Context Tree fixtures. Provider tool calls must not modify the product checkout.
- Windows acceptance requires the separately owner-reviewed drain-authority decision and a product Job Object
  supervisor. Until both exist, the Windows branch must fail closed before any OpenCode invocation and cannot PASS.

## Checklist

- Capability: the connected client reports `opencode` as `missing` or `ok` solely from the same binary resolver used by
  the handler. Re-probing must not launch OpenCode, inspect its config, infer auth, or contact a model provider.
- Provider selection: Web and CLI expose OpenCode only on a client advertising the capability. The config defaults to
  an empty model, accepts an exact provider-native `provider/model` string, and exposes no separate reasoning-effort
  control.
- Runtime gates: the first active use launches `opencode --version` through the provider supervisor and requires a
  stable release in `>=1.18.7 <3.0.0` (1.x and 2.x); prerelease, older, major-three, and unparseable output fail closed.
  The handler branches on the resolved major:
  - OpenCode 1.x: serially runs `opencode db "SELECT 1 AS ready" --format json` before concurrent per-turn processes may
    use the same client data home, then per-turn `run --dir <cwd> --log-level ERROR` with the prompt on stdin.
  - OpenCode 2.x: the `db` readiness gate is skipped (V2 removed the command); V2 runs against a background service, so
    each turn uses `run --standalone` with the prompt as a positional argument and the working directory pinned via `PWD`.
    A real V2 CLI must be exercised here — the unit tests use process fakes and do not prove the V2 `run --standalone`
    contract or the V2 JSONL output shape end to end.
- Private projection: each handler supplies uniquely namespaced First Tree primary-agent and MCP keys so OpenCode's
  deep merge cannot retain colliding operator fields. Small projections use caller-scoped `OPENCODE_CONFIG_CONTENT`;
  large projections use a private runtime-owned config file that is removed after the turn. Current Chat Context and
  the runtime output contract never enter persistent config; they ride stdin as one-shot context and survive
  non-delivery. The projection must not rewrite the operator's global OpenCode config. Projected Skills live only under
  `.opencode/skills` and retain the shared ownership, lock, journal, rollback, and fail-closed reconciliation behavior.
- Child boundary: observe the First Tree identity/drain envelope and runtime-session token-file path in the child
  environment. The token contents and provider credentials must not enter argv, logs, Server data, or retained
  evidence. Prompt text appears only on stdin followed by EOF.
- Real turn: observe
  `opencode run --format json --auto --agent <unique-first-tree-agent> --dir <workspace>` plus `--model` only when configured and
  `--session` only for a confirmed resume. Verify normalized assistant, tool, token-usage, and successful terminal
  events, exactly one non-`tool-calls` terminal event, and a deterministic disposable file tool effect. Every non-empty
  stdout line must be a supported JSON object; malformed and unknown lines fail closed while official `reasoning`
  events are explicitly ignored.
- Session and queue: persist the unique session ID observed in JSONL. Suspend and resume the same chat with an explicit
  `--session`; reject a mismatch or missing terminal event. Inject a message during an active turn and prove it is
  queued for a subsequent process rather than sent to the current stdin.
- Managed MCP: project disposable stdio and remote servers through the private config, complete a real tool call, and
  confirm secret headers are absent from logs/evidence. A config change must apply on the next turn without modifying
  global OpenCode state.
- Auth and failure custody: a logged-out real turn produces a durable error notice directing the operator to
  `opencode auth login`; First Tree offers no in-product OAuth. Deterministic provider/config failures and failures
  after assistant or unsafe tool output are consumed only after the notice. Unknown pre-effect failures remain
  retryable and preserve recovery custody.
- Context Tree I/O: OpenCode `read`/`glob`/`grep` records `opencode_read_tool`; `edit`/`write`/`patch` records
  `opencode_write_tool`; qualifying `bash` commands produce the provider-neutral shell evidence with repo/path
  qualification.
- Process safety: on POSIX, prove the existing environment-attributed OS process-tree drain observes and clears the
  OpenCode root and descendants. On Windows, prove pre-admission to a non-breakaway kill-on-close Job, root exit while
  a detached child remains a Job member, `TerminateJobObject`, PID/start-time identity, and two empty scans at least
  500 ms apart. Child registry evidence is diagnostic only and must never authorize a client switch.

## Expected Result

`PASS` requires a real authenticated two-turn First Tree/OpenCode flow with session continuity, a deterministic tool
effect, private config/MCP/Skills evidence, correct delivery and failure custody, normalized events, Context Tree I/O,
and platform-accepted process-drain proof.

`FAIL` includes prompt text in argv, credentials or secret headers retained by First Tree, an unadmitted runtime
process, global OpenCode config mutation, silent model fallback, synthetic or mismatched resume, missing terminal-event
validation, active-turn steering, unsafe side-effect replay, terminal failure consumed before its durable notice, or a
client switch authorized by child registry alone.

`BLOCKED` means a compatible CLI, provider login/entitlement/network, isolated platform bridge, owner-reviewed Windows
drain authority, or product Job supervisor is absent. Unit tests and the one-time protocol harness do not turn a
blocked First Tree product branch into PASS. `INCONCLUSIVE` means a live turn ran but retained evidence cannot
distinguish the claimed behavior.

## Evidence

Keep sanitized capability snapshots, exact binary/version and argv/cwd observations, private config shape with secrets
removed, session ID continuity, event-kind sequence and token totals, disposable file hashes, MCP call and Context Tree
rows, delivery/retry/notice transitions, and authoritative drain receipts. Never retain provider request bodies,
credential files, auth headers, runtime-session token contents, private prompts, or raw stderr before redaction.
