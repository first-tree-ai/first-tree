# One-time OpenCode Windows Docker E2E

This branch-scoped harness exercises OpenCode 1.18.7 on a real Windows
container kernel. It is test infrastructure only and does not modify First
Tree product code.

The Windows Server Core LTSC 2022 manifest, Node 24.18.0 archive, npm package,
and Windows native OpenCode packages are pinned and verified. The runtime
performs a serial database readiness gate, deterministic concurrent new and
resume turns in separate workdirs, stdin-only prompts, explicit agent/model
selection, JSONL terminal validation, and real shell-tool execution against a
local OpenAI-compatible QA provider.

All runtime OpenCode invocations, including the runtime version probe, are
admitted through a wrapper assigned to a supervisor-owned nested Job Object
before execution. The Docker build-time version gate only validates the pinned
artifact and version; it is not a runtime invocation or Job-admission proof.
The final tool creates a detached child. The harness stops the OpenCode root,
confirms the same child remains a Job member, invokes `TerminateJobObject`, and
requires two empty process-list snapshots 500 ms apart.

Run on a Windows Docker engine:

```powershell
.\windows\run-windows.ps1
```

The entrypoint writes machine-readable runtime, runner/engine identity, and
cleanup receipts. It removes only project containers, networks, and the local
service image; it does not prune the cached LTSC base image. The one-time
workflow uploads only an allowlisted evidence set, with provider request
bodies removed.

Static inspection on any host with Node:

```sh
node windows/static-check.mjs
```
