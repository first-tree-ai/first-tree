# Quickstart

A walkthrough that takes a brand-new account from signup to a working chat
with your first agent.

Signing in for the first time drops you into a **full-screen guided setup**.
It walks you through the essentials — name your team, connect a computer, and
create your agent — then hands off to your first chat, where the agent helps
you finish getting set up. A progress rail on the left tracks where you are,
and you can leave and resume later. This page mirrors that flow.

> **Self-hosting?** Use your own deployment's URL wherever this guide says
> <https://first-tree.ai>. The rest is identical — the page gives you a short
> connect code, and `FIRST_TREE_SERVER_URL` can point the CLI at a custom
> deployment when you are not using the channel default.

## Before you start

- A **GitHub account** to sign in with.
- A macOS or Linux computer where your agent will run. The shell installer
  bundles Node.js, so Node does not need to be installed separately.

## 1. Sign in and name your team

Open <https://first-tree.ai> and sign in with GitHub. A personal team is
created for you automatically; the first step, **Name your team**, lets you
confirm or rename it (you can rename it anytime later). Press **Continue**.

## 2. Connect a computer

Your agent runs on a real machine, so the next step links one to your team.
Copy the command the page shows and run it in a terminal on that machine:

```bash
curl -fsSL --proto '=https' --proto-redir '=https' https://download.first-tree.ai/releases/prod/install.sh | sh
~/.local/bin/first-tree login <connect-code>
```

This is the exact command for hosted production. Use the command from the
page for staging or a self-hosted deployment: it selects the correct installer,
binary, and server URL. The explicit `~/.local/bin` path works before a shell
reload adds that directory to `PATH`.

The first line streams the installer to `sh`; the second line signs the
computer in. They are intentionally independent and do not provide shell-level
transaction protection: when pasted together, an install-line failure does not
automatically prevent the login line from running, and POSIX `sh` does not
guarantee that `curl | sh` preserves a `curl` failure status.
`first-tree login`:

- Exchanges the short connect code against the CLI channel's default server
  URL. Use `FIRST_TREE_SERVER_URL` for a custom deployment. Connect URLs are
  not accepted; legacy JWT tokens still work during rollout.
- Persists your member credentials and writes this machine's `client.id`.
- On macOS / Linux, installs and starts a background daemon so the machine
  stays online across reboots. (See the [Onboarding Guide](onboarding-guide.md)
  for exactly what gets written and the `--no-start` flag.)

The page watches for the machine, then confirms a **coding agent** (such as
Claude Code or Codex) is installed and signed in on it. Once it shows your
computer connected with a ready coding agent, press **Continue**. If it
reports that none is ready, install one (e.g. Claude Code) on that computer
and sign in; it appears here automatically.

## 3. Create your agent

Your team agent runs on top of a coding agent already installed on the
computer you just connected. Pick which one to use (Claude Code is selected
by default when detected), give the agent a name (for example `Buddy`), and
choose who can use it:

- **Shared with team** — anyone on your team can talk to this agent.
- **Just me** — only you can see and talk to it.

There is no "type" to choose — every agent you create here is a standard
agent, and the visibility choice is the only difference. Click **Create**.

Setup then waits for the agent to come online on the computer you connected
("Bringing your agent online… usually a few seconds"). This readiness gate is
what guarantees your first message reaches a live agent. The daemon on your
machine picks up the new agent automatically — there is no CLI command to run
by hand. If it doesn't come online within ~30 seconds, check that the
computer is awake and its coding agent is signed in, then try again.

## 4. Start your first chat

The final step launches your first conversation and lands you in the
**Workspace** with the chat open. Setup finishes here — agent-led, in the
chat, not as more wizard steps. Your agent works from what you give it, one
approved step at a time:

- **Lead with the outcome** — describe the result you want in your own words.
  The agent works from your messages, the chat context, and anything you paste
  or attach; no repository or extra setup is needed to get a first task done.
  When the task does need existing code, you can point it at a local project
  folder path or a GitHub or GitLab repo URL, and the agent reads your project
  and works from it. Reading code and history needs no forge setup — the
  filesystem and plain `git` cover it. Only actual forge steps (creating or
  commenting on PRs/MRs and issues, reading checks or provider metadata) use
  the host `gh`/`glab` CLI on the agent's computer, and only those steps are
  blocked when the CLI is missing. Separately, the optional First Tree GitHub
  App or an admin-configured GitLab Webhook adds live CI/review/merge tracking
  and review automation back into the chat; without them everything else keeps
  working.

You reach a working agent first — none of this is a gate you clear up front.
You can also connect code anytime from **Settings**.

The Workspace is a three-panel layout:

- **Left rail** — the conversation list. New chats open inline; pick a
  target from the composer rather than a separate dialog.
- **Center** — the selected conversation. Type a message and press Enter to
  send. Markdown is rendered live; agent-generated document references open
  inline in the right panel's preview mode.
- **Right** — context for the selected chat: session state, agent text
  output, connected computer, coding agent, SDK version, recent
  notifications, and management links.

That's it — you're chatting with your first agent.

## Invited to an existing team?

If you joined through an invite rather than creating the team, setup is
shorter: a brief welcome, **Connect a computer**, **Create your agent**, then
**Start chat**. There is no team-naming step — your team's admin has already
set up the team, so your agent inherits whatever shared context it has (its
connected code and Context Tree) automatically. Its first chat helps you get
settled rather than building the tree from scratch.

## Where to go next

- [Onboarding Guide](onboarding-guide.md) — the same setup driven entirely
  from the CLI (`login` → `agent create` → `daemon start`), plus the SDK and
  troubleshooting reference.
- [CLI Reference](cli-reference.md) — every namespace, every command, every
  env var.
- [Observability](observability.md) — how to wire metrics and logs into your
  stack.

## Adding more later

The guided setup covers your first run. Afterward, manage everything from the
console:

| Need | Where |
|---|---|
| Connect another computer | **Settings → Computers → + New Connection** |
| Connect a code repo | **Settings** → connect GitHub |
| Create another agent | **Team → New agent** (same name + visibility form) |
| One-screen overview of your install | `first-tree status` |
| Send a message to another agent | `first-tree chat send <agent> "..."` |
| Stop the daemon and sign out | `first-tree logout` |
| Switch this computer to another account | `first-tree login <code>` with the new user's connect code, then confirm the switch |
| Update the CLI in place | `first-tree upgrade` |
