<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/banner-light.png">
    <img src="assets/banner-light.png" alt="First Tree" width="100%">
  </picture>
</p>

<p align="center">
  <a href="https://first-tree.ai/?utm_source=github&utm_medium=readme&utm_campaign=nav-app"><strong>Open App</strong></a> &middot;
  <a href="#get-started"><strong>Get Started</strong></a> &middot;
  <a href="#how-it-works"><strong>How It Works</strong></a> &middot;
  <a href="docs/quickstart.md"><strong>Quickstart</strong></a> &middot;
  <a href="https://github.com/agent-team-foundation/first-tree/discussions"><strong>Discussions</strong></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/first-tree"><img src="https://img.shields.io/npm/v/first-tree?style=for-the-badge&color=FFD700&label=npm" alt="npm version"></a>
  <a href="https://github.com/agent-team-foundation/first-tree/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/agent-team-foundation/first-tree/ci.yml?style=for-the-badge&label=CI" alt="CI"></a>
  <a href="https://github.com/agent-team-foundation/first-tree/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-green?style=for-the-badge" alt="License: Apache 2.0"></a>
  <a href="https://github.com/agent-team-foundation/first-tree/stargazers"><img src="https://img.shields.io/github/stars/agent-team-foundation/first-tree?style=for-the-badge&color=blueviolet" alt="GitHub stars"></a>
</p>

<p align="center">
  English | <a href="README_zh-CN.md">中文</a>
</p>

> checkout our recent work [opentag.build](https://github.com/first-tree-ai/opentag) — the opensource ai coworker. Claude Tag alternative. support using ur own subscription.

# First-Tree

**Context-grounded agentic work for teams.**

First Tree is an open-source workspace where AI agents work from your team's
shared context, not isolated prompts.

At the center is Context Tree: a team-maintained memory of decisions,
ownership, repos, responsibilities, constraints, and prior work. Agents read it
before they work; useful outcomes can flow back into it after the work is done.

The result is a human-agent work loop where every task can start with more team
context, and every useful outcome can make the next task smarter.

<p align="center">
  <img src="assets/workspace-screenshot.png" alt="First Tree workspace: an agent reporting back on a GitHub issue, with team context and participants alongside" width="100%">
</p>

<p align="center">
  <sub><b>The work loop in practice.</b> An agent reports back on what it shipped for a
  GitHub issue &mdash; while the linked issue, the team's chat history, and every human and
  agent participant stay in view, so the next task starts from the same shared context.</sub>
</p>

<div align="center">
<table>
  <tr>
    <td align="center"><strong>Works<br/>with</strong></td>
    <td align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/logos/claude-code-dark.svg"><img src="assets/logos/claude-code-light.svg" width="32" alt="Claude Code" /></picture><br/><sub>Claude Code</sub></td>
    <td align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/logos/codex-dark.svg"><img src="assets/logos/codex-light.svg" width="32" alt="Codex" /></picture><br/><sub>Codex</sub></td>
    <td align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/logos/github-dark.svg"><img src="assets/logos/github-light.svg" width="32" alt="GitHub" /></picture><br/><sub>GitHub</sub></td>
    <td align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="assets/logos/mcp-dark.svg"><img src="assets/logos/mcp-light.svg" width="32" alt="MCP" /></picture><br/><sub>MCP</sub></td>
  </tr>
</table>
</div>

---

## Why First Tree

There are many AI agent workspaces. First Tree's core difference is the context
loop:

```text
user intent -> read team context -> context-aware agent work
-> human review/control -> durable outcome -> updated team context
```

This loop solves the part that usually breaks when teams start using agents:

- context stays private in one person's terminal, prompt, or notes
- agents repeat old decisions because they cannot see team memory
- work finishes in a chat, PR, or document but never updates the shared context
- humans get pulled in without enough background to make a good decision
- each new agent task starts cold, even when the team already learned something

First Tree is built around a different assumption:

> Agent work should be grounded in team context, visible while it runs, guided
> by humans at the right moments, and turned into durable outcomes that can
> update team memory.

That makes First Tree useful in two modes:

- **Focused copilot work** - collaborate deeply with an agent in a persistent
  work stream for design, coding, writing, research, or problem solving.
- **Parallel review work** - let agents move multiple tasks forward and involve
  you only when a decision, blocker, approval, or review is needed.

In both modes, First Tree gives teams one place to:

- give agents the same Context Tree your team uses
- start and continue agent work in persistent chats
- see active work, blocked states, and human review points
- inspect the process, artifacts, and rationale behind a request
- turn useful outcomes back into updated team context

It is not another agent, and not just another workspace. It is a context loop
for human-agent teams.

## How It Works

First Tree connects five pieces around Context Tree:

1. **Context Tree** — a Git-native team memory layer for decisions, ownership,
   responsibilities, constraints, and shared context.
2. **Web workspace** — the daily surface for chats, agents, team members,
   computers, GitHub, and context-backed work.
3. **CLI + daemon** — signs a computer in and keeps local agents connected.
4. **Agent runtime** — runs agents on your machine and routes messages through
   First Tree.
5. **GitHub integration** — connects code work, pull requests, and review back
   to the workspace.

Together, these pieces keep agent work connected to team context before,
during, and after execution.

## Get Started

Open the app at **[first-tree.ai](https://first-tree.ai/?utm_source=github&utm_medium=readme&utm_campaign=getstarted-app)**
(or your own deployment) and sign in. The guided setup walks you through the
first run: name your team, connect a computer, create your first agent, and
start work.

See the [Quickstart](docs/quickstart.md) for the full walkthrough.

At the "connect a computer" step, setup gives you the channel-aware commands
to install the CLI and link the machine. Hosted production uses:

```bash
curl -fsSL https://download.first-tree.ai/releases/prod/install.sh | sh
~/.local/bin/first-tree login <connect-code>
```

Use the exact commands shown in the web console, especially for staging or a
self-hosted deployment. The macOS/Linux installer bundles Node.js, so new
users do not need to install Node separately. The two lines are intentionally
independent and do not provide shell-level transaction protection: when pasted
together, an install-line failure does not automatically prevent the login line
from running, and POSIX `sh` does not guarantee that `curl | sh` preserves a
`curl` failure status. The explicit `~/.local/bin` path works immediately, even
before the shell reloads its `PATH`.

## CLI

```text
first-tree
├── login <code>            Sign this computer in
├── logout                  Stop the daemon and clear credentials
├── status                  CLI / daemon / server / auth overview
├── doctor                  Cross-subsystem readiness check
├── upgrade                 Upgrade to the latest published version
├── agent ...               Agent management
├── chat ...                Chats and messaging
├── org ...                 Organization-level operations
├── daemon ...              Background daemon lifecycle
├── config ...              View / modify this machine's client.yaml
└── tree ...                Context Tree onboarding, validation, automation
```

Run `first-tree <namespace> --help` for the full list under any namespace.

## Repo Layout

- `apps/cli/` — published CLI (`first-tree` / `ft`)
- `packages/shared/` — Zod schemas, types, config system (`@first-tree/shared`)
- `packages/server/` — Fastify API server (`@first-tree/server`)
- `packages/client/` — Cloud SDK/observability, Runtime, and built-in Providers (`@first-tree/client`)
- `packages/web/` — React web workspace (`@first-tree/web`)
- `packages/qa/` — internal QA workflow assets for agent-run validation (`@first-tree/qa`)
- `skills/` — repo-local skill payloads for First Tree agents

## Documentation

- [Quickstart](docs/quickstart.md) — from signup to first agent work
- [Onboarding Guide](docs/onboarding-guide.md) — CLI flow, SDK, troubleshooting
- [CLI Reference](docs/cli-reference.md) — every command and environment variable
- [Observability](docs/observability.md) — logs and OpenTelemetry traces
- [Portable Node Runtime](docs/development/portable-node-runtime.md) — bundled Node policy for portable releases
- [docs/development/](docs/development/) — contributor reference
- [docs/troubleshooting/](docs/troubleshooting/) — environment-specific gotchas
- [docs/migration/](docs/migration/) — coming from `first-tree@0.4.x`

## Development

For the full local setup, including `.env`, migrations, service URLs,
troubleshooting, and optional GitHub App configuration, see
[DEVELOPMENT.md](DEVELOPMENT.md).

```bash
pnpm install                                # Install dependencies
docker compose up -d                        # Dev PostgreSQL
pnpm --filter @first-tree/server dev        # Server
pnpm --filter @first-tree/web dev           # Web workspace
pnpm check && pnpm typecheck                # Lint + type check
pnpm test                                   # Tests
pnpm coverage                               # Local unit coverage
pnpm coverage:summary                       # Summarize generated coverage
```

See [AGENTS.md](AGENTS.md) for architecture, conventions, and the per-package
development workflow. See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR
workflow.

## License

[Apache 2.0](LICENSE)
