# CLI Reference

The full command surface for `first-tree`. Every command listed here is in
the shipped binary — `first-tree --help` (and `first-tree <namespace>
--help`) are the canonical source of truth, this document is a
human-friendly index over them.

> **Keeping this file current.** Any PR that changes the command surface
> (adds, renames, removes, or re-flags a verb / namespace) must update
> this file in the same PR. The grep checks that gate `Forbid legacy CLI
> / env names` only catch a handful of retired identifiers; the broader
> *"what commands exist and what do they do"* contract is enforced by
> humans against this document.

## Install

Production:

```bash
curl -fsSL https://download.first-tree.ai/releases/prod/install.sh | sh
~/.local/bin/first-tree login <connect-code>
```

Staging:

```bash
curl -fsSL https://download.first-tree.ai/releases/staging/install.sh | sh
~/.local/bin/first-tree-staging login <connect-code>
```

The public shell installers support macOS and Linux and bundle Node.js. They
install channel-specific binaries under `~/.local/bin`: `first-tree` / `ft`
for production and `first-tree-staging` / `fts` for staging. The full path in
the login command works immediately, before the current shell reloads `PATH`.
The two lines are intentionally independent and do not provide shell-level
transaction protection: when pasted together, an install-line failure does not
automatically prevent the login line from running, and POSIX `sh` does not
guarantee that `curl | sh` preserves a `curl` failure status.

For self-hosted deployments, use the two-line command returned by the web
console. It includes the server and portable download-base overrides when
needed. Development builds continue to use `scripts/dev-install.sh` and
`first-tree-dev login <connect-code>`.

### Installer flags

The installer reports each phase as it runs — preflight, metadata, download
(with a byte-level progress bar), checksum, extraction, runtime smoke check,
activation, and PATH/service setup. Pass flags after `--` when piping:

```bash
curl -fsSL https://download.first-tree.ai/releases/prod/install.sh | sh -s -- --quiet
```

| Flag | Effect |
|---|---|
| `--version <version>` | Install an immutable version instead of latest. |
| `--prefix <path>` | Install root (default `~/.local/share/first-tree/<channel>`). Must be absolute. |
| `--bin-dir <path>` | Shim directory (default `~/.local/bin`). Must be absolute. |
| `--no-path-edit` | Do not edit shell startup files. Same as `--path-mode off`. |
| `--path-mode <mode>` | `auto` (default), `prompt`, or `off`. `prompt` requires an interactive shell. |
| `--quiet`, `-q` | Print only errors and the final summary. |
| `--no-banner` | Skip the startup banner, keep the phase reporting. |
| `--help` | Print installer help. |

Colour, the progress bar, and the full banner are enabled only when the
installer is attached to a terminal, so piped and CI output stays plain text.
Set `NO_COLOR` to any value to disable colour on a terminal too.

`scripts/dev-install.sh` accepts the same `--quiet` / `--no-banner` / `--help`
flags and honours `NO_COLOR`.

## Global flags

| Flag | Effect |
|---|---|
| `--json` | Emit only machine-readable JSON on stdout; silence human status lines on stderr. |
| `--verbose` | Raise the log level to debug (overrides `FIRST_TREE_LOG_LEVEL`). |
| `--version` | Print the CLI version and exit. |
| `--help` | Print help for the command or namespace. |

## Top-level command tree

```
first-tree
├── login <code>             Sign this computer in or switch local clients
├── logout                   Stop the daemon and clear credentials
├── computer ...             Computer-level local state recovery
├── status                   CLI + daemon + server + auth + agent overview
├── doctor                   Cross-subsystem readiness check
├── upgrade                  Self-update + restart the daemon
├── context ...              Enable Team Context in external coding agents
├── agent ...                Agent management (config, bindings, sessions, messaging)
├── chat ...                 Chats and messaging (create, send, list, history, open)
├── doc ...                  Org document library (publish, comments, reply, resolve, status)
├── cron ...                 Scheduled jobs in the current chat (preview, create, list, show, update, pause, resume, delete)
├── github ...               GitHub entity attention
├── gitlab ...               GitLab Issue/MR entity attention
├── org ...                  Organization-level operations
├── daemon ...               Background daemon (start, stop, status, doctor, probe)
├── config ...               View/modify this machine's client.yaml
└── tree ...                 Read, write, review, validate, and browse Context Trees
```

---

## login

```
first-tree login <code> [--no-start] [--force-switch]
```

Sign this computer in using a short connect code from the web console. New
codes are exchanged against this CLI channel's default server URL
(`first-tree` → production, `first-tree-staging` → staging, `first-tree-dev` →
local dev), with `FIRST_TREE_SERVER_URL` as an explicit override for custom
deployments. Connect URLs are not accepted; only legacy JWT tokens with an
`iss` claim remain accepted during rollout. Short connect codes are single-use:
an expired or already-used code requires a fresh setup prompt/code from First
Tree Settings and must never be retried.

If this machine already has credentials for another user, `login` asks for
explicit confirmation and switches the active local client after stopping and
draining the old runtime. The CLI exchanges the short code before it can compare
the target account with the active local owner. In non-TTY automation, a
different-user result therefore consumes that code and stops before switching:
the coding agent must ask the user to approve the switch, request a fresh
Settings setup prompt/code after approval, and run that fresh prompt's login
command with `--force-switch`. The consumed code must not be reused.
`--force-switch` is only the non-interactive confirmation flag; it does not skip
supervisor, drain, filesystem, or journal safety checks. If credentials are
missing, `login` preserves `client.yaml` and local agent state so the same user
can reconnect after a normal `logout`.

| Flag | Effect |
|---|---|
| `--no-start` | Write credentials and exit without installing/starting the background daemon. |
| `--force-switch` | Confirm a different-user local client switch in non-interactive mode. Safety gates still run. |

## logout

```
first-tree logout [--purge]
```

Stop the daemon and clear credentials. `--purge` additionally removes active
root client state, parked clients under `$FIRST_TREE_HOME/parked-clients/`, and
switch lock/journal files. This is a destructive local reset path, not the
normal account-switch path. To switch this computer to another First Tree user,
run `first-tree login <code>` with the new user's connect code and confirm
the switch. Before deleting local state, `--purge` retires the current server
client so it disappears from default Computers views and cannot be reactivated
with the same client id. Retiring is destructive for runtime routing on that
client: non-deleted agents pinned to it are suspended and unpinned, while agent
identity, chats, history, and profile data remain; those cleared agents can be
moved back onto a connected computer/runtime from the Agent Runtime tab. Logout
stops both the background service and any live `daemon start --foreground`
runtime markers for the active client before clearing credentials/state. If the
daemon is active and cannot be stopped, a foreground runtime cannot be stopped,
or the server-side retire fails, `--purge` refuses to delete local client state.
The default keeps local client/agent state for the same user to reconnect later.
If any active or parked Agent Workspace contains an unmigrated
`local-context/`, the command lists each affected Agent and path before the
destructive purge begins.

## computer

Computer-level local state recovery.

```
first-tree computer
└── reset
```

### computer reset

```
first-tree computer reset
```

Stop the daemon and remove active root client state, parked clients under
`$FIRST_TREE_HOME/parked-clients/`, switch lock/journal files, and active
credentials. Use this when local identity state is damaged or when you
intentionally want to discard every local First Tree client stored in this
installation. This is local-only and does not retire server client rows. Normal
different-user switching should use
`first-tree login <code>` instead, which parks inactive clients.
`computer reset` also lists every active or parked unmigrated Local Context it
will permanently delete. It never uploads or migrates those files.

## status

```
first-tree status
```

Single-screen overview: CLI version, daemon state, server reachability,
auth health, and the agents this client manages.

## doctor

```
first-tree doctor
```

Cross-subsystem readiness check covering the daemon, server reachability,
WebSocket, and configured agents. Use this when `status` flags something
red and you want a guided drill-down. Local Context rows report active/frozen
source state plus identity, containment, resource-limit, and `tree verify`
health; doctor does not repair content.

## upgrade

```
first-tree upgrade [--check] [--no-restart]
```

Self-update for the CLI: query the configured server for its recommended
Command version when a server URL is configured, install that exact version
through the current install mode, refresh the supervisor definition on top of
the new bits, then restart the client service. If no server URL is configured
yet, `upgrade` falls back to the current channel's latest release data directly
so the update path still works before login/config. Portable installs download
the channel manifest and verified tarball, including the bundled Node.js
runtime. Existing npm-mode installs retain their package-manager update path
and continue using the system Node.js runtime.

| Flag | Effect |
|---|---|
| `--check` | Only check for an available version; print "update available" or "already on latest". Do not install. |
| `--no-restart` | Install the new version and refresh the supervisor definition, but leave the running service alone. Used for staged rollouts. |

Refusing to run from a source checkout (anywhere under a `.git`
ancestor) is intentional — it keeps a dev build from accidentally overwriting
a hosted-channel installation. For local development use
`scripts/dev-install.sh` (see [docs/development/local-dev-isolation.md](development/local-dev-isolation.md)).

For an existing npm-mode installation, `upgrade` checks the target package's
`engines.node` metadata before install when npm can provide it. If the target
requires a newer Node.js than the current process is running, the command fails
before install with a system-Node upgrade hint and a shell-installer migration
hint. npm-mode updates do not replace Node.js themselves.

---

## agent

Agent management — local config, bindings, sessions, messaging
debug helpers.

```
first-tree agent
├── list [--remote] [--org <id>]
├── add --agent-id <uuid>
├── create <name> --type <t> --client-id <id> [--runtime <r>] [--display-name <s>] [--org <id>]
├── remove <name>
├── prune [--yes] [--dry-run]
├── status [name]
├── reset <name>
├── config <subcommand>
├── bind <subcommand>
├── workspace <subcommand>
└── session <subcommand>
```

### agent list

```
first-tree agent list                    # locally-configured agents on this client
first-tree agent list --remote           # every agent the signed-in user manages on the server
first-tree agent list --remote --org <id>  # cross-org view (multi-org operators)
```

### agent create

```
first-tree agent create <name> --type <human|agent> --client-id <thisClient> [--runtime claude-code|claude-code-tui|codex|cursor|grok|kimi-code|opencode]
```

Creates the agent row on the server and binds it to the given client
machine. The local `agents/<name>/agent.yaml` is written by the running
daemon via the server-pushed `agent:pinned` frame; no second command
needed if the daemon is already up.

`--runtime` defaults to `claude-code`. The `opencode` runtime uses an
operator-installed OpenCode CLI (`>=1.18.7 <2.0.0`) on macOS or Linux. Install
it with `npm install -g opencode-ai@^1.18.7`, complete provider-owned
authentication with `opencode auth login`, and run `first-tree daemon probe`
after installation to force immediate artifact/platform re-detection and
upload the machine's advertised capabilities. First Tree never reads or relays
OpenCode provider credentials. The probe does not inspect authentication or
provider reachability; the first provider turn validates credentials and
performs the compatible-version and database-readiness gates. Windows reports
a resolved OpenCode binary for diagnostics but does not advertise it as
available until the Client has the required pre-admission Job Object
supervisor.

The `grok` runtime drives an operator-installed Grok Build CLI
(`>=0.2.117 <2.0.0`) over ACP on macOS or Linux. Install it with the official
script (`curl -fsSL https://x.ai/cli/install.sh | bash`), complete
provider-owned authentication with `grok login`, and run
`first-tree daemon probe` after installation to force immediate
artifact/platform re-detection. First Tree never reads or relays Grok
credentials; the probe is install/platform-only and Windows is not advertised
in V1.

### agent add

```
first-tree agent add --agent-id <uuid>
```

Register an existing server-side agent on this client. Use this when the
daemon was not running at the moment the agent was pinned, or when
moving an agent to a second computer that's already signed into the
same user.

### agent remove / agent prune

```
first-tree agent remove <name>     # delete local config dir, workspace, session state
first-tree agent prune [--yes] [--dry-run]  # remove every local alias the server no longer pins to you
```

`prune` is the counterpart to `daemon doctor`'s "stale aliases" warning.
`remove` and `prune` separately identify an unmigrated `local-context/` before
deleting the Agent Workspace. Local Context has no built-in history or remote
backup, so this warning represents permanent data loss.

### agent status / agent reset

```
first-tree agent status               # all agents this client manages
first-tree agent status <name>        # one agent's runtime view from the server
first-tree agent reset <name>         # reset agent error state to idle
```

### agent config

Mutate the agent's server-side runtime configuration (model, reasoning,
Codex service tier, prompt, MCP servers, env, repos). Edits the
`agent_configs.payload` JSONB row
through the Admin API.

```
first-tree agent config
├── show <agent>
├── set-model <agent> <model>                       # alias: opus | sonnet | haiku, or full id (e.g. claude-opus-4-7)
├── set-reasoning-effort <agent> <level>
├── set-service-tier <agent> <tier>                 # Codex: default (Standard), fast (Fast), or provider-advertised id
├── prompt show <agent> [--raw]                     # per-agent prompt fragment; --raw is verbatim (round-trippable)
├── prompt set <agent> [-f <file>] [--force]        # replace the fragment ONLY; reads stdin if no file.
│                                                   #   Rejects copies of the assembled AGENTS.md (generated marker /
│                                                   #   briefing headings); --force overrides the heading heuristic.
│                                                   #   Does NOT cover inline replacements of team prompts — those are
│                                                   #   resource bindings, managed in Cloud → Org Settings → Resources.
├── append-prompt <agent> [-f <file>]               # deprecated alias of `prompt set`
├── add-mcp <agent> --name <id> --transport <t> [--command <c> --args <a>... | --url <u>]
├── set-env <agent> KEY=VALUE [--sensitive]
├── add-repo <agent> <url> [--ref <branch>] [--path <local>]
└── dry-run <agent> -f <patch.json>                 # validate + diff, no persist
```

Reasoning effort values are provider-specific. Claude Code and Claude Code
TUI accept `""` (inherit the operator's local setting), `low`, `medium`,
`high`, or `max`. Codex accepts `low`, `medium`, `high`, `xhigh`, `max`, or
`ultra`; availability of the higher levels is model-dependent and rejected
combinations are reported by the provider.

Codex service tiers are passed to the provider unchanged. `default` selects
Standard mode and `fast` selects Fast mode; unsupported model/account
combinations fail visibly without a silent fallback. Codex may report its
canonical `priority` id after accepting the `fast` request alias; both represent
the same Fast selection.

### agent bind

```
first-tree agent bind
└── client <agentName> --client-id <id>             # first-time bind only; later moves use managed runtime switch
```

### agent workspace

```
first-tree agent workspace clean [agent-name] [--ttl <days>]
```

Remove stale workspace directories (older than the TTL with no active
session). Without an agent name, sweeps every local agent.

### agent session

```
first-tree agent session
├── list <agent-name> [--state <active|suspended|evicted|errored>]
├── suspend <agent-name> <chat-id>
└── terminate <agent-name> <chat-id>
```

---

## chat

Day-to-day messaging.

```
first-tree chat
├── create [message]                               # create a separate task chat and write its first message
│     --to <name>                                  #   initial recipient to mention + wake; only an agent recipient starts working (a human is notified but the chat stays idle); repeatable
│     --with <name>                                #   context participant; added silently, not woken by the first message
│     --topic <text> / --description <text>        #   initial chat self-description
│     --request                                    #   first message is a tracked ask; the body IS the ask, decision-self-sufficient (why + recap + question + recommendation); exactly one --to human
│     --options <json> / --multi-select            #   (with --request) 2–4 options {label,description,preview?}; allow multi-pick
├── send <name> [message]                            # notify a participant — agent or human; an agent recipient is woken (a send to a human is informational only; a question the next step depends on goes through `chat ask`)
│     # body: [message] arg, or stdin (omit [message]), or -F <path>; prefer stdin/-F for rich bodies (shell-safe)
│     -F, --message-file <path>                      #   read only the body from <path> (`-` = stdin); this does not attach <path>
│     --reply-to <messageId>                         #   thread a reply under a message (pure threading)
├── ask <name> [message]                             # ask a HUMAN a tracked question; the body IS the ask, decision-self-sufficient (why it exists + recent-context recap + question + recommendation)
│     # body: [message] arg, or stdin (omit [message]), or -F <path>; prefer stdin/-F for rich bodies (shell-safe)
│     -F, --message-file <path>                      #   read the body from <path> (`-` = stdin); content never hits the shell
│     --options <json>                               #   2–4 answer options {label (1–5 words), description, preview?}; omit for free-text
│     --multi-select                                 #   allow picking more than one option (requires --options)
│     # always a fresh top-level question — no threading, and no resolve flag
│     # (the human answers in the web UI; an agent can only ASK)
├── invite <agentName>                               # add to FIRST_TREE_CHAT_ID before same-task send
├── list
├── history <chatId>
├── archive [chatId]                                 # archive from the signed-in user's Active view; defaults to FIRST_TREE_CHAT_ID
│     --agent <name>                                 #   selected agent must participate in the target chat
├── update                                           # update topic and/or description (each independently)
│     --topic <text> / --clear-topic                 #   set/clear the short display label
│     --description <text> / --clear-description      #   set/clear the Summary — the chat's current-state brief (Markdown; `-` = read from stdin/heredoc)
│     --chat <chatId> / --agent <name>               #   target another chat / the named agent
├── set-topic [topic]                                # [DEPRECATED — use `update`] hidden alias
└── open <agent-name>                                # interactive REPL
```

```bash
# Split off separate work into a new task chat and write the first message.
# --to recipients are mentioned and woken; --with participants are added for
# context but receive only silent initial history. This is not an empty-chat or
# same-task handoff tool.
#
# Only an agent recipient starts working. A chat whose only --to is a human
# stays idle until they reply; `--to <your own agent name>` wakes YOU in the
# new chat (the server rewrites the opening message's sender to your manager,
# so write the body as a self-contained task brief). Never pair a self-address
# with `--to <your own manager>`: they become the sender, and a sender is
# filtered out of its own fan-out, so they get no notification at all.
first-tree chat create "Please review the rollout plan." --to code-agent --with reviewer-agent \
  --topic "rollout review" \
  --description "reviewing rollout plan; waiting on code-agent"

# Start a new task chat with a tracked question. The first request must target
# exactly one human. The message body IS the ask and must be
# decision-self-sufficient (why the question exists + recent-context recap +
# the single question and your recommendation); pass 2–4 --options (JSON) for
# a clean pick, or omit them for a free-text answer.
cat <<'EOF' | first-tree chat create --to alice --request \
  --options '[{"label":"Ship","description":"Roll the migration now"},{"label":"Hold","description":"Wait 24h"}]'
## Why this question exists
Migration 0021 drops the legacy column — irreversible, so shipping is your call.
## Recent context
The 0021 cleanup you asked for last week is done; the PR is approved and CI is
green.
## The question
Ship the destructive migration now? I would ship — the column has had no reads
for 30 days.
EOF

# Inline — `chat send` wakes a participant (agent or human). A plain send to a
# human is informational only — readable, then safely ignorable; any question
# the next step depends on goes through `chat ask` (a send never carries a
# blocking question). The recipient must be a participant of FIRST_TREE_CHAT_ID.
first-tree chat send code-agent "ship the PR"

# Stdin (multiline, markdown, special chars)
echo "long body" | first-tree chat send code-agent -f markdown

# Rich / multi-line bodies: write to a file, then read it with --message-file
# (or `-F`). This supplies only the message body; it does not attach that file.
# It is the most robust form — the body never passes through the shell, so
# backticks (`code`), quotes, apostrophes, and newlines are sent byte-for-byte.
# Inlining such a body lets the shell run backticks as command substitution and
# break on quotes, silently mangling the message.
first-tree chat send code-agent -f markdown --message-file reply.md
first-tree chat send code-agent -f markdown -F -   < reply.md   # `-` = stdin

# Inline bodies must carry REAL newlines. A one-line quoted body written with
# `\n` escapes — chat send code-agent "line1\n\n**title**" — is rejected
# BEFORE anything is sent (ESCAPED_NEWLINES, exit 2): shells do not expand
# `\n` inside quotes, so the literal backslash-n would be stored and the
# message would render as one long unformatted line. The error prints a
# copyable heredoc retry form on stderr; resend via stdin:
cat <<'EOF' | first-tree chat send code-agent -f markdown
first line

**second** line
EOF
# Stdin bodies are never checked — piping is also the escape hatch for
# intentionally sending literal `\n` text.

# Embed a workspace image — a markdown image `![alt](path)` in a `chat send`
# body whose target is an image (png/jpeg/gif/webp) inside the agent's own
# workspace is uploaded at send time and delivered as a real inline chat image
# (the same shape a human composer upload uses), so recipients see the picture
# instead of a broken local path. Only explicit `![...](...)` embeds are
# captured (a bare filename is left as text), only the sender's own workspace,
# and an image shown inside a block code sample the renderer recognizes (a
# fenced block at any container depth, or an indented code block) is left as a
# literal sample (an image written inside inline `code` is treated as a live
# embed). Capture is best-effort and never blocks the send, and is skipped
# entirely for a body longer than ~1 million characters (then sent verbatim). An image
# that is too large (>10 MiB), unreadable, or beyond the 20-per-message cap is
# skipped: if no image in the message captured, the body is sent unchanged (the
# skipped embed stays as text); if at least one sibling image did capture — so
# the message becomes an image send — every workspace-image embed is removed
# from the caption, so a skipped one is dropped rather than left as a path that
# would render broken.
echo 'Latest run: ![chart](reports/latency.png)' | first-tree chat send code-agent -f markdown

# Reference a workspace Markdown document by its `.md` path in the body. During
# an agent session, `chat send` best-effort captures eligible documents inside
# the sending agent's own workspace and replaces each captured mention with an
# attachment link. Capture never blocks the send; the limit is 10 MiB per
# document and 10 documents per message. Other outbound file types are not
# captured by `chat send`.
echo 'Full report: reports/latest-run.md' | first-tree chat send code-agent -f markdown

# Ask a human a tracked question (red-dot + blocks the chat for them until they
# answer). `chat ask` targets a single human; the message body IS the ask and
# must be decision-self-sufficient for a reader who remembers nothing of the
# chat: why the question exists + a recap of the recent interactions + the
# single question and your recommendation, written for a reader holding none
# of the context (unpack every shorthand; name options by their concrete
# consequence). Omit --options for a free-text answer, or pass 2–4 --options
# (JSON) for a clean pick; add --multi-select to allow more than one.
cat <<'EOF' | first-tree chat ask alice \
  --options '[{"label":"Ship","description":"Roll it now"},{"label":"Hold","description":"Wait 24h"}]'
## Why this question exists
Migration 0021 drops the legacy column — irreversible, so shipping is your call.
## Recent context
You asked for the 0021 cleanup yesterday; the PR is approved and CI is green.
## The question
Ship the destructive migration now? I would ship — the column has had no reads
for 30 days.
EOF

# Free-text ask (no options) — the same three-section body, answered in free
# text. `-F` reads the body from a file (shell-safe — same rationale as
# `chat send -F`)
first-tree chat ask alice --message-file ask-body.md

# `chat ask` always opens a fresh top-level question — there is no threading
# (no --reply-to) and no resolve command. An agent can only ASK — it cannot mark a question
# answered or close it. The human resolves it by answering in the web UI; a moot
# question is simply left open (the human works open questions oldest-first), and
# re-asking opens a NEW, independent question.

# Pull a non-member into the current chat first, then send normally. Use this
# for same-task stage / role handoffs.
first-tree chat invite code-agent
first-tree chat send code-agent "now we can talk"

# Browse
first-tree chat list
first-tree chat history <chatId>

# Workspace engagement views — the signed-in user's Workspace projection
# (the Active / Archived tabs), still restricted to chats where the selected
# --agent is a speaker. Items carry the Workspace attention fields
# (unreadMentionCount, openRequestCount, busyAgentIds, failedAgentIds,
# liveActivity, pinnedAt, …) plus an `id` alias of `chatId`. Deleted rows are
# never included; page via the server-returned opaque `nextCursor`.
first-tree chat list --engagement active
first-tree chat list --engagement archived --cursor <cursor>

# Exact one-chat preflight — the read-only check to run immediately before
# `chat archive`. Finds the chat's Workspace conversation row by paging the
# requested engagement view, then merges that row (all attention fields:
# unreadMentionCount, openRequestCount, liveActivity, failedAgentIds,
# busyAgentIds, createdByMe, source, entityType, activityAt, …) with the raw
# member chat detail (`metadata` — where the SCM entityKey/URL lives —,
# lastReadAt, descriptionUpdatedAt, …). The detail's `engagementStatus` is
# the current-state verdict. Returns at most one item and `nextCursor: null`,
# only when the chat appears in the requested view AND the selected agent is
# a speaker in it; otherwise `items` is empty. The scan is bounded and fails
# closed on abnormal pagination: a repeated `nextCursor` (immediate or an
# A→B→A cycle) or more than 100 pages aborts the preflight with an error —
# no archivable row, no detail read. Requires --engagement and cannot be
# combined with --cursor.
first-tree chat list --engagement active --chat <chatId>
first-tree chat archive <chatId>

# Archive a chat from the signed-in user's Active workspace view. The selected
# agent must be a speaking participant, so the eligible set is exactly the
# structural scope exposed by `chat list`. Omitting the id targets
# FIRST_TREE_CHAT_ID. The write is private to the signed-in user: it does not
# archive the chat for other participants or change membership. It is
# idempotent, and a later message automatically returns the chat to Active.
first-tree chat archive <chatId>
first-tree chat archive

# When archiving the current chat on a user's behalf, send the completion reply
# first and run `chat archive` as the final action. Any reply sent after the
# archive is new chat activity and immediately returns the chat to Active.
first-tree chat send alice "Done — I’m archiving this conversation now."
first-tree chat archive

# Self-description: a short topic label + a Summary, updated independently
# through `chat update` (topic and description each on their own). The
# description is the chat's current-state brief — rewritten in place from blank
# each time, first line standing alone as the current result plus what it means
# for the reader, then only the context needed to trust it (in flight: the one
# most recent next step; blocked: what it waits on; done: the conclusion and at
# most one deliverable). Default 2–4 short sentences; 1500 chars is a ceiling,
# not a target. Leave out stage history, plan/progress lists, implementation
# detail, and process metadata (SHAs, test counts, reviewers, sub-agents, CI
# jobs, commands). It renders as Markdown between the chat header and the
# message stream on the web (collapsed to its first line until expanded) and as
# the timeline's Current state card on mobile (short values in full, long ones
# clamped) — so keep a one-line value to the headline alone and put any next
# step on its own line;
# agents also read it via `chat list` to self-locate (see the agent
# briefing's "Chat Topic & Description" for the full authoring contract). Keep
# human decisions OUT of it — raise `chat ask <human>` for those. Owner-gated:
# the chat's creator may update it, and when
# no agent owner is present (human-created chats — Web / GitHub-sourced — or the
# creator left) every worker agent counts as the owner; a non-owner agent in a
# chat whose agent creator is still present is refused with 403.
first-tree chat update --topic "review PR #916"
first-tree chat update --description "PR #916 is ready to merge — no blocking findings left."
first-tree chat update --topic "ship plan" --description "The ship plan is drafted and ready for QA to check."
first-tree chat update --clear-description
# A one-line --description whose newlines are written as literal `\n` is rejected
# before the write: shell quotes do not expand `\n`, so it would persist and
# render as one long line with visible `\n` tokens. For a multi-line description
# pass real newlines — either an ANSI-C $'...' string, or `--description -` to
# read it from stdin/heredoc:
cat <<'EOF' | first-tree chat update --description -
PR #916 still has one blocking finding, so it cannot merge yet.

The retry path drops the last message when the socket closes mid-send.
Next: fix that path and re-request review.
EOF
# `chat set-topic` still works as a deprecated alias.

# Interactive
first-tree chat open code-agent
```

`chat send` / `chat invite` operate on the chat identified by
`FIRST_TREE_CHAT_ID`, which the runtime injects into the agent's session
environment. The recipient must be a participant of that chat; if not,
`invite` first.

`chat archive` also defaults to `FIRST_TREE_CHAT_ID`, but accepts an explicit
chat id from `chat list`. The default list is a structural membership
inventory and may continue to include a chat after archival; archival changes
the signed-in user's private Workspace engagement state, hiding the row from
their default Active view until new chat activity revives it. Pass
`--engagement active|archived|all` to read that Workspace projection instead
(Active excludes archived rows; Archived shows only them), and add
`--chat <chatId>` for the exact read-only preflight that mirrors what
`chat archive <chatId>` will see — it returns the chat only while it is
still in the requested view for you. The exact item combines the Workspace
conversation row (attention fields) with the raw member chat detail
(`metadata`, `lastReadAt`, …), and the detail's engagement is the
current-state verdict.

`chat create` is different: it creates a new task chat and writes the first
message in one command. Use it to split genuinely new work into a fresh chat.
Use `chat send` for replies/status in the current chat, and `chat invite` when
you want to add a non-member to the current chat before sending there. A
same-task handoff, such as architect to developer or developer to reviewer,
stays in the current chat; invite the next agent and send the handoff there.

Ordinary task creation is intentionally not idempotent. There is no operation
id, and the CLI does not automatically retry it. If an ordinary create reports
an unknown result, check `chat list` or the Web UI before running it again.

If a non-human agent includes itself in `chat create --to`, the server records
the originating agent in metadata and uses that agent's manager human as the
effective sender so the first message can wake the agent normally.

---

## doc

Org document library (docloop) — publish markdown design docs for team
review, pull the structured comments reviewers leave, reply, resolve, and
track document status. Feature-flagged server-side
(`FIRST_TREE_DOCS_ENABLED`); commands report HTTP 404 while the flag is off.
Publishing is idempotent on `slug`: the first publish creates the document
(version 1), every later publish of the same slug appends the next version.
The caller's own identity signs every write — agents author under their own
agent name, humans under their member identity.

```
first-tree doc
├── publish <file> [--slug <slug>] [--title <t>] [--project <p>]
│                  [--note <n>] [--status <s>] [--if-changed]   # create or append a version
├── get <slug> [--version <n>]                                  # read metadata + markdown content
├── list [--project <p>] [--status <s>] [--limit <n>] [--cursor <c>]
├── comments <slug> [--status open|resolved] [--version <n>]
│                   [--watch [seconds]]                         # list; --watch streams new ones as JSON lines
├── comment <slug> <body> [--quote <exact> [--prefix <t>] [--suffix <t>]] [--version <n>]
├── reply <commentId> <body>                                    # reply in a thread
├── resolve <commentId> [--reopen]                              # close (or reopen) a thread
├── status <slug> [--set draft|in_review|approved|archived]     # show or move status
├── import <dir> [--project <p>] [--status <s>] [--dry-run]     # bulk-publish a directory of .md files
└── export <dir> [--project <p>] [--status <s>]                 # dump library to <slug>.md files + manifest.json
```

```bash
first-tree doc publish design.md --slug chat-rename --project first-tree --status in_review
first-tree doc comments chat-rename --status open --json
first-tree doc reply <commentId> "Addressed in v2 — see §3"
first-tree doc resolve <commentId>
first-tree doc publish design.md --slug chat-rename --note "responds to review round 1"
first-tree doc status chat-rename --set approved
```

Slug defaults to the slugified filename; title defaults to the file's first
markdown heading (required on the first publish). Comment anchors are
TextQuoteSelector-style (`exact` / `prefix` / `suffix`) against the markdown
source, so an agent can locate every comment in the file it holds without
line-number conventions. Comments whose quote no longer exists in the latest
version come back with `outdated: true` (computed on read). `import` skips
`NODE.md` / `README.md` index files and is idempotent (re-runs only add
versions for changed content); `export` is the guaranteed way out — plain
markdown files plus a `manifest.json` of metadata.

---

## cron

Scheduled jobs in the current chat. At due time the Server writes one
ordinary addressed markdown message to wake this agent. Every cron command
(including `preview`, `list`, and `show`) requires `FIRST_TREE_CHAT_ID` from
the agent session; prompt bodies use `-F <file>` or `-F -` only. The scheduler
starts with the Server and uses `FIRST_TREE_POLLING_INTERVAL_SECONDS` as its
polling cadence. The Server validates that cadence at startup in the `1..10`
second dispatch-safe range.

```
first-tree cron
├── preview --schedule <expr> --timezone <iana>
├── create --name <name> --schedule <expr> --timezone <iana> -F <prompt.md|->
├── list
├── show <jobId>
├── update <jobId> [--name ...] [--schedule ...] [--timezone ...] [-F <prompt.md|->]
├── pause <jobId>
├── resume <jobId>
└── delete <jobId>
```

```bash
first-tree cron preview --schedule "0 9 * * 1-5" --timezone America/New_York
first-tree cron create --name daily-triage --schedule "0 9 * * 1-5" --timezone America/New_York -F ./prompt.md
first-tree cron list
first-tree cron show <jobId>
first-tree cron pause <jobId>
first-tree cron resume <jobId>
first-tree cron delete <jobId>
```

---

## github

GitHub entity attention and recipient-bound App task replies for the current
chat. `follow` wires an entity's webhook event stream into the chat (one
routing line, chat-scoped);
`unfollow` explicitly stops this chat from tracking the entity and severs
every line wired into the chat for that entity, however it was created.
Creating a PR or issue never follows it automatically — declare the
dependency explicitly, immediately after creation. Use
`first-tree github follow --help` / `first-tree github unfollow --help`
for the full flag surface and conflict handling.

```
first-tree github
├── follow <entity> [--chat <chatId>] [--rebind]    # route the entity's events into the chat
├── unfollow <entity> [--chat <chatId>]             # sever all of the chat's lines for the entity
├── following [--chat <chatId>] [--json]            # list entities wired into the chat
└── reply --run <runId> --body-file <path|->        # publish one task outcome as the GitHub App
```

```bash
# Inside an agent session the chat is inferred from FIRST_TREE_CHAT_ID
first-tree github follow https://github.com/acme/api/pull/42
first-tree github follow acme/api#42        # issue vs PR resolved automatically
first-tree github following
first-tree github unfollow acme/api#42
```

`github reply` is available only inside the active Agent turn and current chat
recorded by a server-authored `teamAgentTask: { agentUuid, runId }` card.
Supported Issue and pull-request activity from connected repositories creates
these tasks automatically; it does not depend on mentioning or assigning the
GitHub App. The CLI supplies only the run id and body; Cloud fixes the
repository and Issue or pull request, verifies the exact selected
Agent/runtime/chat and installation coverage, and keeps the App credential
server-side. Each run accepts one immutable payload. Unknown GitHub writes
reconcile a hidden run marker before retrying, and a different payload is
rejected. The body must not mention the App or contain the reserved marker.
Historical markers without a run id cannot publish. Discussion and commit
events do not create task runs; an unsupported or malformed publishable entity
reports `GITHUB_TASK_REPLY_ENTITY_UNSUPPORTED`. Missing accepted Issue/PR write
permission similarly reports `GITHUB_TASK_REPLY_APP_PERMISSION_REQUIRED`. A
terminal App reply carrying its valid hidden run marker remains an ordinary
subscription event but cannot create another task run. This ordinary comment
publisher does not grant Context Review verdict or merge authority.

`<entity>` accepts a full GitHub PR / Issue / Discussion URL or `owner/repo#N`.
Commits remain a webhook event surface but cannot be followed or unfollowed
manually.
A `409` means the same (human, delegate) line already lives in another chat
— `--rebind` MOVES it here (a line is never duplicated). `unfollow` is
idempotent: `removed: 0` is success, not an error. Requires the org's
GitHub App installation to cover the repo (`422` otherwise).

---

## gitlab

GitLab Issue and Merge Request attention for the current chat. The commands
operate entirely on First Tree's local webhook projection: they never call the
GitLab API, validate an entity live, or use the current `glab` account.

```
first-tree gitlab
├── follow <issue-or-mr-url> [--chat <chatId>] [--agent <name>] [--rebind]
├── following [--chat <chatId>] [--agent <name>]
└── unfollow <issue-or-mr-url> [--chat <chatId>] [--agent <name>]
```

```bash
# Inside an agent session the chat is inferred from FIRST_TREE_CHAT_ID
first-tree gitlab follow https://gitlab.example/acme/api/issues/42
first-tree gitlab follow https://gitlab.example/acme/api/-/merge_requests/42 --rebind
first-tree gitlab following
first-tree gitlab unfollow https://gitlab.example/acme/api/issues/42
```

`follow` accepts only a full Issue or Merge Request URL from the Team's one
configured GitLab instance. Both GitLab route shapes—with or without the `/-/`
segment—are accepted, and the submitted URL is preserved for user-facing
links. Repeating a follow for the same entity in the same chat refreshes that
link to the latest submitted URL while remaining idempotent. The command
records a pending declaration without provider egress; the next matching valid
webhook supplies numeric project identity and activates the declaration. The
same human/delegate pair cannot follow the entity from a second chat: the
command reports the existing room, and `--rebind` atomically moves that line
when the task context intentionally changes. Different pairs remain
independent. A pending
declaration reports `state: null` because First Tree has not verified provider
state. There is no GitLab `context-review` command.

`following` returns every active binding in the chat as a stable public
projection, including automatic reviewer / assignee / mention routing and
explicit `agent_declared` / `human_declared` rows. Pending declarations and
active webhook-observed bindings report their corresponding status. Internal
connection, organization, mapping, actor, identity, and normalized-path
identifiers are not returned.

`unfollow` is URL-based and idempotent: `removed: 0` is terminal success. It
removes every automatic or manual binding for that entity in the current chat.
A later explicit reviewer, assignee, or mention event may create a new route.
After a project rename, use the current URL returned by `following`; the
inbound-only service cannot resolve an arbitrary old path back to a numeric
project identity.

These commands control First Tree chat attention. Native GitLab
subscribe/unsubscribe operations control only the authenticated GitLab
account's personal notifications and are not a replacement for chat follow.

---

## org

```
first-tree org
├── bind-tree <url> [--org <orgId>] [--branch <branch>] # legacy caller-org binding write
└── context-tree [--agent <name>]                    # read the current agent org's Context Tree binding
    ├── review-config [--agent <name>]                # read live binding + Reviewer assignment for a local Agent
    │     --as-member [--org <orgId>]                 # logged-in member; no running Client Runtime, local Agent, or active Computer connection required
    └── set <repo> [--branch <branch>] [--agent <name>] # set the selected agent org binding
```

`bind-tree` records the team's Context Tree URL in
`organization_settings(context_tree)`. Used by the onboarding flow's
"create new tree" path, where the agent calls back into the server
after scaffolding the tree. It is retained for compatibility with existing
scripts: without `--org`, it resolves the caller's default organization through
`GET /api/v1/me`; with `--org`, it targets the explicitly supplied organization
ID. `--branch` is optional and sends an explicit branch when a recovery path must
reproduce an exact repo/branch binding; when omitted, the server preserves the
existing branch or defaults to `main`. It is not agent-scoped and is separate
from `context-tree set` below.

The Class B settings read `GET /api/v1/orgs/:orgId/settings/context_tree`
returns the same runtime-safe binding representation for admins and members. If
a row has no repo and a valid retained branch, this safe read returns the
unbound branch-only representation. If a loose historical repo or branch is not
valid under the active binding contract, the safe read fails without returning
the raw value. Loose historical rows that are visible for repair are exposed
only through the admin-only raw read
`GET /api/v1/orgs/:orgId/settings/context_tree/raw`.

### org context-tree

```bash
first-tree org context-tree [--agent <name>]
```

`context-tree` is a read-only view of the Cloud `context_tree` setting for the
selected agent's organization. It does not accept `--org`: the CLI sends the
selected agent as `X-Agent-Id`, and the server derives that agent's
organization. The command reads only `GET /api/v1/agent/context-tree/info`.
It never falls back to the user's default organization from `/me`, the legacy
`/api/v1/context-tree/info` endpoint, the web app's current organization, or a
local workspace manifest or checkout.

The selected agent is resolved in this order:

1. `--agent <name>` selects that named local agent.
2. `FIRST_TREE_AGENT_ID` selects the local agent whose configured UUID matches
   the environment value.
3. When exactly one local agent is configured, that agent is selected.

Selection fails before any network request with exit code `2` when there is no
local agent (`MISSING_AGENT`), more than one candidate (`AMBIGUOUS_AGENT`), an
environment UUID that is not local (`ENV_AGENT_NOT_LOCAL`), or an unknown
explicit name (`UNKNOWN_AGENT`). An explicit `--agent` takes precedence over
`FIRST_TREE_AGENT_ID`.

Human output reports one of three states. `Bound` includes the resolved or
persisted provider, repository, and branch. `Unbound` advises the user to ask
an administrator for that agent's
organization to bind an existing tree or initialize a new one. `Unreadable`
means the agent-scoped request failed or its response could not be validated; a
failed read is never reported as `Unbound`. A loose invalid historical setting
is projected as inactive by the agent/runtime endpoint, while the safe settings
GET returns a non-secret conflict and the admin raw endpoint preserves the
value for repair.

With `--json` or `FIRST_TREE_JSON=1`, successful output is exactly one of:

```json
{"ok":true,"data":{"status":"bound","provider":"github","repo":"git@github.com:acme/context-tree.git","branch":"main"}}
{"ok":true,"data":{"status":"unbound","repo":null,"branch":null}}
```

`repo` alone determines binding state. An unbound response is normalized to
`branch: null` even if the server supplies its default branch. A bound response
with a null branch is normalized to `"main"`.

Authentication, connection, timeout, remote, response-validation, and
unexpected read failures use the following JSON error shape and a non-zero exit
code:

```json
{"ok":false,"error":{"code":"CONTEXT_TREE_UNREADABLE","message":"...","status":"unreadable"}}
```

Authentication failures exit `3`; connection and timeout failures exit `6`;
other remote or invalid-response failures exit `1`. Agent-selection failures
retain exit code `2` and their existing error envelopes.

### org context-tree review-config

```bash
first-tree org context-tree review-config [--agent <name>]
first-tree org context-tree review-config --as-member [--org <orgId>]
```

Without `--as-member`, `review-config` reads the bound repository/branch and
Context Reviewer assignment from the same agent-scoped server response. It
reports `Off`, `Assigned`, or `Not assigned` for the selected runtime Agent.

With `--as-member`, it uses the existing member-readable `context_tree` and
`context_tree_features` settings and `/me` Team selection. An explicit `--org`
must be one of the caller's active memberships; otherwise the current default,
then sole-membership fallback, is used, and ambiguous multi-Team state fails
closed. This is the Write preflight path after standard CLI login: member
credentials and `client.yaml` remain present, but no running Client Runtime or
daemon, local First Tree Agent, or active Computer connection is required.
`--as-member` conflicts with `--agent`; `--org` requires `--as-member`.

The result includes the live provider. The command contains no review mode,
generation, governance, or merge-method setting: Context Review uses the
currently assigned Reviewer and current-state configuration semantics.

### org context-tree set

```bash
first-tree org context-tree set <repo> [--branch <branch>] [--agent <name>]
```

`context-tree set` directly sets or replaces the Cloud `context_tree` binding
for the selected local agent's organization. It does not accept `--org` or
`--rebind`, and it provides no unset/clear operation. Agent selection uses the
same precedence and exit-code-`2` failures as the read command above:
explicit `--agent`, then `FIRST_TREE_AGENT_ID`, then the only configured local
agent. Selection failures retain their existing `MISSING_AGENT`,
`AMBIGUOUS_AGENT`, `ENV_AGENT_NOT_LOCAL`, or `UNKNOWN_AGENT` envelopes; they
are not wrapped as `CONTEXT_TREE_UPDATE_FAILED`. Selection is completed before
the SDK is created or any credentials or network are accessed.

The command performs a two-step, agent-scoped write. It first sends
`GET /api/v1/agent/me` with the selected agent to obtain a non-empty
`organizationId`, then sends the existing admin-only Class B request
`PUT /api/v1/orgs/:orgId/settings/context_tree`, URL-encoding `orgId`. The
selected agent identity, current user JWT, and current runtime-session token are
used for both requests. This write flow does not call either Class B settings
GET and never falls back to `/api/v1/me`, the legacy
`/api/v1/context-tree/*` endpoints, the web app's current organization, a local
workspace manifest, or a local checkout. The agent-profile GET may use the
client's normal read retry behavior. The PUT is never retried automatically, so
one invocation cannot repeat a settings-version increment after an ambiguous
transport failure.

`<repo>` accepts HTTPS, `ssh://`, and scp-like SSH repository coordinates. The
value must have a host and repository path, contain no embedded credentials,
have no surrounding whitespace, and contain no control characters. URL forms
must use literal `https://` or `ssh://` syntax; queries, fragments, backslashes,
and local drive paths are rejected. HTTP and `git://` URLs are rejected.
`--branch` must be a valid Git branch name. In addition to being non-empty,
single-line, and free of surrounding whitespace and control characters, it
must satisfy Git ref-format rules such as rejecting `..`, `@{`, components
that start with `.` or end with `.lock`, a branch name that starts with `-`,
and forbidden ref characters. Invalid repo and branch values fail locally with
`INVALID_CONTEXT_TREE_REPO` and
`INVALID_CONTEXT_TREE_BRANCH`, respectively, exit `2`, and make no SDK,
credential, or HTTP request.

For example, these repository forms are accepted:

```text
https://github.com/acme/context-tree.git
ssh://git@github.com/acme/context-tree.git
git@github.com:acme/context-tree.git
https://gitlab.company.example/group/subgroup/context-tree.git
git@gitlab.company.example:group/subgroup/context-tree.git
```

For a GitLab repository, the Team must already have a current GitLab
connection for the same exact web origin. Saving the binding does not require
Cloud egress authority: GitLab Webhook routing and Agent-local workflows remain
usable when Web Context cannot read the repository. Web Context supports
`gitlab.com` by default; deployment operators authorize other exact origins
through `FIRST_TREE_GITLAB_ALLOWED_ORIGINS`. An unauthorized origin does not
trigger an outbound request. The Settings page deliberately keeps repository
and branch editing available to admins in this release; every later Write,
Review, and Web Context operation rereads the live binding and fails closed if
it changed.

When `--branch` is omitted, the request body contains only `{ "repo": "..." }`
and an existing valid branch is preserved. On a first binding, the server's
default branch is `main`. Supplying `--branch` replaces the branch. If a loose
historical row contains an invalid branch, a repo-only update is rejected
without a partial write; repair it by supplying both the repository and a
valid `--branch`. A successful response must explicitly contain a valid repo
and branch, must echo the requested repository, and must echo a provided
branch; missing fields, unknown fields, mismatches, and otherwise invalid
responses are update failures.

Human output reports `Bound` and shows the repository and final branch. With
`--json` or `FIRST_TREE_JSON=1`, successful output is exactly:

```json
{"ok":true,"data":{"status":"bound","provider":"github","repo":"git@github.com:acme/context-tree.git","branch":"main"}}
```

After local agent selection and input validation, all authentication,
connection, timeout, HTTP, response-validation, and unexpected failures use
this exact error envelope:

```json
{"ok":false,"error":{"code":"CONTEXT_TREE_UPDATE_FAILED","message":"..."}}
```

Authentication failures exit `3`; connection and timeout failures exit `6`;
403, other HTTP failures, and invalid or inconsistent responses exit `1`.
When a network or server failure leaves the PUT result uncertain, the message
directs the operator to rerun `first-tree org context-tree` with the same agent
selection before retrying. Failure output never prints raw response bodies,
tokens, credentials, or a full private repository coordinate; successful
output includes the requested repository as documented above.

For this write command, debug logs may identify the selected agent, request
phase, derived organization, and final status. Warning logs contain only the
sanitized failure category, exit code, and HTTP status; they do not contain
secrets or raw response data.

---

## daemon

The background service that holds the client WebSocket and runs every
configured agent on this machine. Installed automatically by `first-tree
login` on supported desktop platforms: launchd on macOS, systemd on
Linux, and a per-user Task Scheduler logon task on Windows. Linux installs
use a `systemd --user` unit for normal users; when the CLI is run as root,
First Tree installs the same channel's unit in system scope instead
(`/etc/systemd/system/<channel>.service`) so daemon setup does not depend
on a root user D-Bus session.

On Windows, Task Scheduler only owns per-user logon/start triggering. A hidden
First Tree supervisor loop owns the daemon child process, exit-code restart
policy, stop intent, runtime marker PID, and logs. This is not a Windows
Service / WinSW install and does not run before the Windows user logs in.

```
first-tree daemon
├── start [--no-interactive] [--foreground]
├── stop
├── restart
├── status
├── doctor
├── repair-ownership
├── probe [--no-upload] [--json]
├── install-codex [--spec <spec>] [--json]
└── install-claude [--spec <spec>] [--json]
```

| Subcommand | Purpose |
|---|---|
| `start` | Start the daemon and connect every configured agent to the server. **Fail-closed**: exits 1 with `NO_CREDENTIALS` if no `credentials.json` exists; run `login` first. `--foreground` runs in the current shell (for debugging), but refuses when that home's background service is already active; stop the service first. The default delegates to the service manager. Every inline runtime must acquire the resolved home owner lock before reading `client.yaml` or opening the WebSocket. |
| `stop` | Stop the service (preserves auto-start; bring it back with `start`). |
| `restart` | Restart the service. |
| `status` | Local service state + authoritative daemon owner + server binding + auth health. Runs in well under a second. |
| `doctor` | Walk Node version, config, server reachability, WS, agent registrations, the installed service file, the authoritative daemon owner lock, **and the runtime providers** — each step reported. Runtime-provider rows use the same artifact/platform capability detection as `daemon probe`; they do not launch providers, inspect authentication, or test provider reachability. |
| `repair-ownership` | Reconcile an interrupted fenced ownership mutation. The command elects one repair process through per-instance ticket slots, atomically acquires a canonical repair guard, requires strict PID/start-identity proof that the exact fence owner is gone or reused, drains published startup entrants, and refuses live, malformed, unverifiable, changed, or ambiguous evidence. It never blindly deletes a fence. |
| `probe` | Re-detect local runtime artifacts and platform execution support on demand, then upload the result to the server (`PATCH /clients/:id/capabilities`). This is the manual immediate refresh for a client's advertised capabilities after a provider is installed; it does not launch providers, inspect authentication, or test provider reachability. `--no-upload` runs a **credentials-free local-only** diagnostic (detect + print, no server auth needed). `--json` (or the global `--json`) emits the capability snapshot as the machine-readable `{ ok, data }` envelope on stdout. |
| `install-codex` | Install the native Codex runtime engine on this machine (`npm install -g @openai/codex`). First Tree does not bundle the ~225MB native `codex` binary by default — the runtime resolves an external `codex` from PATH, known install locations, or the macOS ChatGPT/Codex desktop app — so this is the on-demand remediation when the `codex` capability probes as `missing`. Runs the same tracked-subprocess install path as self-update, then re-probes so the freshly installed binary is reflected. Purely local (no credentials). `--spec <spec>` picks an npm dist-tag or exact version (default `latest`); `--json` emits the post-install capability snapshot as the `{ ok, data }` envelope. |
| `install-claude` | Install the native Claude Code runtime engine on this machine (`npm install -g @anthropic-ai/claude-code`). First Tree does not bundle the ~210MB native `claude` binary by default — the runtime resolves a system `claude` (env override / PATH / well-known install dirs) — so this is the on-demand remediation when the `claude-code` capability probes as `missing`. Runs the same tracked-subprocess install path as self-update, then re-probes so the freshly installed binary is reflected. Purely local (no credentials). `--spec <spec>` picks an npm dist-tag or exact version (default `latest`); `--json` emits the post-install capability snapshot as the `{ ok, data }` envelope. |

### Single runtime owner per home

The resolved `FIRST_TREE_HOME` is the daemon's complete ownership key. An
inline foreground or supervisor child atomically creates
`<home>/state/daemon-runtime.lock` before reading the active client config or
opening a WebSocket. The record includes an instance id, PID, OS process-start
identity, channel, mode, CLI version, and start time. Client id, server URL, and
release channel never subdivide the lock: channel, mode, and version are
recorded only as holder diagnostics, while client id and server URL are not
part of the ownership record at all.

Consequently, prod, staging, and dev can run together under their distinct
default homes. If two binaries — including binaries from different channels —
are pointed at one explicit `FIRST_TREE_HOME`, the second runtime is refused
and reports the live holder. Service delegation commands do not acquire the
lock themselves; the supervisor child acquires it when it actually enters the
runtime. A colliding supervisor child logs the holder once and exits cleanly so
the service manager does not create a restart/log storm.

Script-facing failures use `DAEMON_RUNTIME_ALREADY_RUNNING` for a verified live
holder, `DAEMON_RUNTIME_LOCK_UNTRUSTED` when the existing record or process
identity cannot be trusted, and `DAEMON_RUNTIME_LOCK_RECOVERY_BUSY` while
another process owns stale-lock recovery.

After a crash, a later start only recovers the lock when OS process inspection
strictly proves the PID is gone or has a different process-start identity. The
old record is renamed beside the lock as a `.stale.*` diagnostic and creation
is retried once. The same evidence rule applies to the recovery guard: a live
guard blocks startup, while a guard whose PID/start identity is strictly stale
is quarantined as `.recovery.stale.*` before recovery continues. Malformed,
unreadable, or unverifiable locks and recovery guards fail closed and are never
deleted automatically. Normal cleanup removes the lock or guard only when its
`instanceId` still belongs to the exiting process.

Before changing the main lock, recovery also publishes a
`.recovery-fence` and drains startup attempts that began before that fence.
The fence stays authoritative across quarantine and restore, so no process can
return a new lease through a temporarily empty main-lock path. Every startup
publishes a complete per-instance entrant atomically before checking the fence;
an incomplete temporary record is never visible to the drain protocol.
The main owner, recovery guard, mutation fence, entrant, canonical repair guard,
and repair election slot/ticket all use the same complete-publication rule:
write and fsync a unique ignored same-directory temporary inode, close it, then
hard-link it without overwriting the canonical path. A crash before that link
cannot expose a partial canonical record; after the link, the canonical record
is already complete. Publication temporaries are never ownership evidence.

An interrupted or unresolved fenced mutation is deliberately not recovered by
ordinary startup. `status` and `doctor` report the exact fence instance,
PID/start identity, canonical main state, quarantine candidates, repair slots,
and entrant count. Run `first-tree daemon repair-ownership` to perform the
supported repair. The command:

1. elects one repair owner with non-destructive per-instance intent/ticket
   slots, then acquires a separate canonical repair guard; simultaneous repairs
   therefore have one mutation owner, and stale unique records are removable
   only after PID/start-identity proof;
2. refuses a live, malformed, or process-identity-unverifiable fence, fixes the
   target as an exact instance plus content fingerprint, drains pre-fence
   entrants, and revalidates that exact stale fence before every main mutation;
3. keeps a trusted canonical live or stale owner; when canonical is absent,
   restores the unique trusted live quarantine candidate (preferred) or unique
   trusted stale placeholder without overwriting another claimant; when no
   candidate exists at all, records an explicit safe-empty reconciliation
   without inventing a live owner;
4. treats hard-link aliases as one candidate only when both instance and inode
   match, and refuses unreadable evidence, changed file identity, different
   live candidates, copied duplicates, or ambiguous stale candidates; and
5. removes the matching stale recovery guard, revalidates the repair guard and
   exact fence, then removes that fence. Fence removal is the repair opening
   point: repair never changes main ownership afterward and only releases its
   own repair records.

The repair command automatically handles a strictly stale fence with a trusted
canonical owner, a unique trusted quarantine candidate, or a provably empty
candidate set. It fails closed with the exact evidence when the fence/repair
holder is live or unverifiable, any authoritative record is malformed or
unreadable, the target fence changes, or candidates are ambiguous. An
interrupted repair remains fenced and can be rerun: the next repair proves the
old repair guard stale and resumes idempotently. Do not manually delete
`.recovery-fence`, `.recovery`, `.repair`, entrant, repair-slot/ticket, owner,
or quarantine files.

Files under `<home>/state/client-runtimes/` remain runtime markers for
diagnostics, account-switch drain checks, and Windows supervisor lifecycle
reporting. They are not daemon ownership or mutual-exclusion authority.

**Capability refresh timing.** The daemon detects runtime artifacts and
platform execution support at startup and again on every WebSocket reconnect.
Detection is resolve-only: it does not launch providers, inspect
authentication, or test provider reachability.

**While the daemon stays connected**, it also runs a bounded background
refresh whenever any provider is not yet `ok`, so installing a provider is
noticed without a restart or reconnect. The poll starts ~15s after the degraded
state is seen, backs off to a 5-minute ceiling, uploads only when the snapshot
changes, and stops once every provider is `ok`. Authentication cannot change a
capability row; credential failures are discovered when a provider turn runs.
`daemon probe` remains the manual path to force an immediate full re-detection
and upload.

The top-level `first-tree status` is the cross-subsystem overview that
calls `daemon status` internally and adds server/auth/agent rows.

---

## config

Read and write this machine's `client.yaml`. The file lives at
`~/.first-tree/config/client.yaml` (or the staging/dev channel's
equivalent — see [docs/development/local-dev-isolation.md](development/local-dev-isolation.md)).

```bash
first-tree config show                    # every key/value
first-tree config show server.url         # dotted-key read
first-tree config show --show-secrets     # un-mask sensitive fields
first-tree config set update.policy auto
first-tree config get update.policy       # alias for `show <key>`
```

Agent-side runtime configuration (model / prompt / MCP / env / repos) is
not here — it lives in `first-tree agent config ...` and mutates the
server-side `agent_configs` row through the Admin API.

---

## context

Manage external First Tree activation for Claude Code or Codex. The Plugin is
machine/user scoped and shared by every persistently authorized Team. Team
eligibility is a set of explicit grants, not one project-to-Team binding.

```text
first-tree context
├── enable --provider claude-code|codex --team ID --plan [--project-root DIR|--pathless]
├── enable --provider claude-code|codex --team ID \
│         --scope global|directory|session --plan-id HASH \
│         [--project-root DIR|--pathless] --yes
├── status --provider claude-code|codex [--project-root DIR|--pathless]
├── repair --provider claude-code|codex
└── disable --provider claude-code|codex --team ID \
           --scope global|directory [--directory-root DIR] [--yes]
```

The server-authored Web prompt first runs `enable --plan`. This operation is
read-only and returns an exact `planId`, the real provider directory/pathless
identity, a Codex temporary-directory warning when applicable, and the choices
available for that location:

- `global`: make this Team eligible in all sessions for the provider;
- `directory`: make it eligible under the displayed canonical directory;
- `session`: use it only now, without a Plugin, Hook or persistent grant.

`directory` is present only when setup has a stable canonical directory.
Claude uses `CLAUDE_PROJECT_DIR` unless `--project-root` is explicit; it does
not fall back to cwd when the variable is missing or invalid. Missing or invalid
Claude project directories become a pathless identity, which can match global
activation but never directory activation. Pathless sessions, Codex Documents
scratch directories, and default managed worktrees under
`$CODEX_HOME/worktrees/<id>/<repo>` return only `global` and `session`. Codex
temporary paths retain their canonical project identity in those commands.
Custom Codex App worktree roots remain best-effort because the provider does
not expose a stable public setting for them.

Every returned choice includes an authoritative `applyCommand` that is ready
to execute unchanged. It pins the channel-appropriate executable (the portable
CLI path outside development), provider, Team, canonical `--project-root` or
`--pathless` identity, selected scope, exact `planId`, and non-interactive
consent flag. A scope omitted from the plan has no apply command and manual
application fails closed. Directory availability is part of plan identity, so
a change before apply invalidates the plan.

The current agent displays the choices and waits for a new user reply, then
runs only the selected choice's exact command. Apply must use the unchanged
`planId`; identity drift forces a new plan. Global and directory install/update
the shared Plugin and add one schema-v3 grant. Session-only verifies the
release bundle, writes no grant, and returns only Read/Write loader entries plus a
signed opaque candidate receipt.

Successful session-only apply, and persistent apply when the adapter is already
usable in the current provider session, returns `currentSessionHandoff` schema
v3. It contains
immutable provider/project identity, `consumerKind: byo`, activation scope,
neutral standing routing context, and versioned exact-release loader commands.
Claude persistent setup that installs, migrates, or repairs the Plugin returns
`currentSessionHandoff: null` while its next-session obligation is pending and
instructs the user to start a new session. Other usable persistent scopes return `first-tree`, `first-tree-read`, and
`first-tree-write`; session scope returns Read/Write only. Human mode prints
the full usable JSON handoff.

Each new task invokes loader protocol v1. The loader verifies the current CLI
release manifest and exact-version Skill/Policy digests, then returns contained
`skillPath` and `policyPath` values plus `firstTreeInvocation`, the opaque exact
shell prefix for every BYO CLI command in that task. The agent must not replace
or reconstruct it from PATH, release, channel, or memory. The loader does not
return a mutable `current` symlink or materialize a second Core workflow under
`$FIRST_TREE_HOME`.

The loader runs again for every new task, but content already read in full may
be reused in the current provider context when its exact content identity still
matches: `(name, skillDigest)` for a Skill and `policyDigest` for the Policy.
Read and Write have separate Skill identities and may share only an identical
Policy. A digest change, missing full text after a provider lifecycle boundary,
summary-only evidence, or any uncertainty requires reading the corresponding
path from the latest loader response again. Paths, names, and release versions
do not authorize reuse. The agent does not independently hash Core files or
persist a Core cache; invalid loader output remains fail-closed.

For persistent Codex setup, Hook consent remains provider-owned: open
`/hooks`, enable and Trust **First Tree Context → SessionStart**, return to the
same conversation, and reply `continue`. The same agent reruns apply and
adopts the handoff. Session-only installs no Hook, so it needs no Trust.
Claude Code materializes deterministic thin-Plugin bytes for each
`adapterVersion`. First install, legacy full-Plugin migration, and adapter repair
leave a next-session obligation that only an exact repaired SessionStart can
consume. Repeating repair for the same adapter version does not change the
provider cache version or payload. The current session need not adopt the repair
immediately; setup returns no current-session handoff, and persistent automatic
routing starts in the next Claude session. Later
Core-only upgrades and additional Team grants require no provider lifecycle
action or repeated Codex trust.

`context.yaml` schema v3 stores zero or more global/directory grants keyed by
provider, Team and exact scope. A legacy v2/v1 file is atomically backed up,
replaced with an empty v3 store, and requires explicit reauthorization. No old
single-Team resolver remains.

At each new BYO task, the projected Skill calls the hidden route:

```text
<firstTreeInvocation> --json context route --provider PROVIDER \
  (--project-root DIR|--pathless) [--session-candidate RECEIPT]
```

The router considers only the highest-priority local set:
session candidate, otherwise every Team at the deepest matching directory,
otherwise every global Team. It batch-validates only those Teams, fetches only
each exact root `SCOPE.md`, and returns complete natural-language bodies plus
opaque candidate ids. SCOPE text is semantic routing data, never executable
instructions. The agent selects automatically only when exactly one candidate
clearly matches and every candidate is readable. If every readable candidate
is clearly unrelated, or no candidates are returned without blocked
selection, it continues without a snapshot or user interruption. Multiple
possible matches, an unclear or overlapping SCOPE, `selectionBlocked`, or any
unavailable candidate requires a user choice from the validated set.

After selection, the projected Skill uses:

```text
<firstTreeInvocation> --json context snapshot --candidate CANDIDATE
<firstTreeInvocation> --json context write-preflight --snapshot EXACT_SNAPSHOT [--github-login LOGIN]
<firstTreeInvocation> --json context write-worktree --snapshot EXACT_SNAPSHOT --plan-anchor DIGEST --confirmed \
  [--github-login LOGIN]
<firstTreeInvocation> --json context write-status --team TEAM --plan-anchor DIGEST
<firstTreeInvocation> --json context write-finish --team TEAM --operation OPERATION
```

These hidden commands do not accept Team ids. Read revalidates the exact
binding and SCOPE commit before creating one detached task snapshot in a
CLI-owned private temporary directory. Write
requires that snapshot's opaque route receipt and returns
`confirmationRequired: true` with an exact plan anchor. The BYO Skill must
show Team, SCOPE match, source revision, target nodes and mutations, then wait
for a new user reply before creating an authoring worktree or making any Tree
mutation. The confirmed plan anchor also identifies one durable authoring
result: retrying the same exact command or querying `write-status` recovers and
returns the same operation after a crash or lost output. `write-finish` is
idempotent and removes both the worktree journal and its plan receipt.

`context status` reports provider, Plugin/payload, Hook, project identity and
all applicable highest-priority Team grants independently.
`context disable` removes one exact global or directory grant while preserving
the shared Plugin and every other Team. Directory disable requires the exact
stored root. Already-read model context is not revoked.

`context activate`, `context route`, `context snapshot`, and `context write-preflight`
are hidden provider bridges. SessionStart injects only the neutral router
contract; it does not select or expose a Team before task routing. Persistent
adapter payload health is checked once at `context route`, before the task gets
an opaque candidate. Snapshot and Write boundaries then rely on that candidate,
live membership/binding, exact snapshot identity and Write confirmation instead
of repeatedly probing provider-owned Plugin state. Any applicable membership,
binding, SCOPE, payload or authority failure is fail-closed for First Tree while
ordinary provider work can continue.

---

## tree

Context Tree task-read activation, source-backed write and Seed preflight,
GitHub App-backed review publication, provider-aware creation/adoption,
structural validation, hierarchy browsing, Local Context resolution, and durable IO readback. The `tree` namespace carries `read`, `write`, `review`, `seed`,
`verify`, `tree`, `local`, `init`, and `io`; the rest (`migrate` / `upgrade` / `status` /
`codeowners` / `claude-hook` / `inject` / `automation` / `skill` groups) was
retired in the 2026-06 cleanup because the cloud now owns workspace + tree
provisioning and the client runtime inlines its own skill payload install.

```
first-tree tree
├── init --team ID --provider github|gitlab \
│        --repo URL --branch BRANCH \
│        (--create|--adopt)                  # initialize through local gh/glab + git
├── read --team ID --snapshot DIR            # activate one exact task read snapshot
├── write --team ID --snapshot DIR \
│        [--github-login LOGIN]               # provider-aware authoring preflight
├── review --run ID --event EVENT \
│        --body-file PATH                     # publish one GitHub App review for the live PR head
├── seed --team ID \
│        [--confirm-source URL] \
│        [--expected-source-key KEY]          # preflight and optional Admin-confirmed source batch
├── verify [--tree-path PATH]                # validate a Context Tree repo or filesystem tree
├── tree [path] [-L depth] [-P pattern] \
│        [--tree-path PATH]                  # browse a Git checkout or filesystem Tree
├── local resolve --ensure --intent read|write
│                                            # resolve this Agent's live Local Context root
└── io [--chat ID] [--action read|write] \
│      [--since TS] [--until TS] \
│      [--limit N] [--cursor C] [--all]    # this agent's own Context Tree read/write events
```

`first-tree tree read` is the explicit-Team snapshot primitive used by managed
and administrative workflows. Both `--team <team-id>` and
`--snapshot <new-directory>` are required. External BYO Skills do not call this
surface directly; their hidden `context snapshot --candidate` bridge validates the
opaque SCOPE route receipt before delegating here.

Activation performs one member-authenticated Server request to
`GET /api/v1/orgs/:orgId/settings/context_tree`. That Class B route resolves
the URL Team's current active membership and current safe Context Tree binding;
the activation disables transport retries so this authority check is not
repeated after a transient response.
Only after it succeeds does the CLI create staging state, execute one strict
`git fetch` for the bound branch, resolve the fetched ref to an exact commit,
and atomically publish a detached snapshot at the requested path. The final
snapshot has no mutable Git remote and carries local Git metadata identifying
the Team, binding, and commit. The destination must not already exist; the
command never overwrites or reuses a prior task snapshot. Tracked symbolic
links materialized as filesystem links are accepted only when a relative link
resolves inside the snapshot to a regular file tracked by the same exact
commit; directory, absolute, dangling, escaping, or untracked-target links
fail before content is returned. When Git uses `core.symlinks=false`, an index
symlink is instead a regular file containing the link blob. The snapshot
accepts that file only when its raw object id still equals the exact index
entry and treats it as opaque content rather than following it as an alias.

Authority, invalid/unbound binding, fetch, commit resolution, and snapshot
failures are distinct fail-closed stages. None falls back to cached content, a
managed workspace checkout, a stale local branch, or another Team. Error
messages and JSON envelopes do not include access credentials or raw upstream
responses. Stable failure codes are:

- `CONTEXT_TREE_READ_INVALID_INPUT`
- `CONTEXT_TREE_READ_AUTHORITY_FAILED`
- `CONTEXT_TREE_READ_BINDING_INVALID`
- `CONTEXT_TREE_READ_UNBOUND`
- `CONTEXT_TREE_READ_FETCH_FAILED`
- `CONTEXT_TREE_READ_COMMIT_FAILED`
- `CONTEXT_TREE_READ_SNAPSHOT_FAILED`

If a later hierarchy read detects a removed marker, changed HEAD, or dirty
worktree, it fails before returning content with
`CONTEXT_TREE_READ_SNAPSHOT_INVALID`.

With global `--json`, success returns one envelope whose `data` is
`{ teamId, binding: { repo, branch }, commit, snapshotPath }`. Human output
reports the same identity. For the rest of the task, run hierarchy selectors
inside `snapshotPath` and read Markdown only from that root. A new task uses a
new path and a new activation so membership, binding, and branch movement are
observed.

`first-tree tree write` is the explicit-Team write preflight for a source-backed
change. It requires the explicit Team and the existing exact snapshot created
by `tree read`. External BYO Skills instead use hidden `context write-preflight`, which
requires the task's SCOPE route receipt and mandatory post-plan user
confirmation. A GitHub binding also requires the current local `gh` login via
`--github-login`; a GitLab binding instead verifies local `glab`
authentication for the exact current connection origin, including a
non-default HTTPS port. It does not read a Workspace
manifest, managed briefing, setup-chat transcript, Web selection, account
default/current Team, local Agent, or prior task receipt.

The command sends one member-authenticated request to
`POST /api/v1/orgs/:orgId/context-tree/write-preflight`. The Server reads the
live bound Tree and assigned Context Reviewer as one current tuple, verifies
the requester's active Team/human identity and provider-specific forge
authority, and checks that the Reviewer is an active non-human Agent. GitHub
verifies the linked login; GitLab requires the bound repository origin to
match the Team's current GitLab connection. The request cannot select a
Reviewer, task key, Chat, sender, topic, review, or merge authority.

After Server admission, the CLI requires the current binding to match the
snapshot identity (canonical repository plus exact branch), strictly fetches
the bound branch into temporary state, and requires its remote tip to equal the
snapshot commit. It then re-verifies that the snapshot is still clean and fixed
at the same commit. The command removes temporary fetch state and performs no
remote mutation. It is safe to run at activation and repeat immediately before
the first push or PR creation; each run observes Server current Reviewer state.

With global `--json`, success returns
`{ provider, teamId, binding, baseCommit, snapshotPath, reviewerAgentUuid,
requesterGithubLogin, gitlabInstanceOrigin }`. Human output reports the same
provider authority without exposing a credential. Stable local and
Server failure codes distinguish invalid input/snapshot, explicit-Team
mismatch, authority or identity denial, unavailable/unsupported binding,
invalid configuration, unavailable review/Reviewer, changed binding, fetch
failure, and a stale snapshot base. Failure creates no PR or Context Reviewer run.
The returned Reviewer UUID is diagnostic only: callers must not cache or route
from it, because the provider webhook resolves the Server current Reviewer
again.

Authoring happens in a separate task worktree/branch created from
`baseCommit`; the exact read snapshot remains immutable. After a ready PR/MR
exists, the forge webhook creates or reuses its stable provider-scoped
Reviewer Chat and trusted review run. Writers do not create or wake a review
Chat, repair the change, publish a verdict, or merge. GitHub uses the App
webhook and App review path. GitLab uses a processable Merge Request event from
the Team's inbound System or Project Hook; a processed System Hook MR remains
the connection-readiness requirement. The Reviewer reads and mutates GitLab
with host-local `git` and `glab` credentials. Project Hook Notes can supply
ordinary entity attention but never start Context Review, so a Reviewer note
cannot self-trigger another run.

`first-tree tree review` is the GitHub App publication command and is available
only inside an active GitHub Context Reviewer runtime session. It accepts a
Server-authored run id, one of `APPROVE`,
`REQUEST_CHANGES`, or `COMMENT`, and a UTF-8 body file (`-` reads stdin). It
does not accept a head or alternate agent. The Server re-resolves the live
installation, bound repository, pull request, run, configured Reviewer and
current PR head before the GitHub App creates the review. Unauthorized
submissions fail closed. The command never merges. After a successful
`APPROVE`, the Reviewer takes the exact full SHA only from that response's
`data.reviewedHead` and uses its local GitHub identity for one immediate REST
squash-merge compare-and-set: `PUT repos/<owner/repo>/pulls/<number>/merge`
with `sha=<reviewedHead>` and `merge_method=squash`. It does not use
`gh pr merge`, `--admin`, `--auto`, a substitute head, a fallback merge path or
a mutation retry. An unconfirmed mutation permits at most one read-only pull
request `GET`; the Reviewer reports merged, open or unknown only from the
resulting evidence. Real merge-queue, ruleset, permission and transport
behavior remains a live GitHub QA boundary rather than a deterministic-stub
security claim. GitLab Context Review never calls this command and never
simulates an approval, status, label, ruleset, CODEOWNERS gate, merge queue, or
admin bypass. A blocker is reported through one local-identity MR note. A
clean ready MR is squash-merged exactly once with
`glab mr merge --sha <reviewed-head>` (or the same-identity Merge Requests API
only when it enforces the `sha` compare-and-set). Unsupported exact-SHA CAS and
head, credential, pipeline/protection, deterministic-validation, or
unknown-result failures all fail closed; an unknown merge permits one
read-only reconciliation and no mutation retry.

Existing Context Tree repositories should require pull requests, at least one
current approval, and stale-review dismissal after every push. An administrator
must update an existing repository ruleset with local `gh api`; the GitHub App
does not change repository rules. Preserve non-fast-forward protection, disable
Code Owner and last-push approval requirements, and verify the resulting live
ruleset before relying on the merge gate. Also remove the retired
`first-tree/context-review` required status check from every effective ruleset:
the App-review-only workflow no longer publishes that status, so merely adding
the approval ruleset while retaining the old check leaves the repository
unmergeable.

The one-approval gate intentionally prevents a single GitHub user from
self-merging while the App Reviewer is unavailable; the PR needs the App or
another human approval. Do not compensate by broadening App permissions,
restoring CODEOWNERS, or adding a bypass actor.

From the Context Tree checkout, an administrator should first identify the
existing effective rulesets. Repository rulesets are edited in place; do not
create a second named ruleset when the repository already has a default-branch
ruleset such as `protect main`:

```bash
remote=$(git remote get-url origin)
repo=$(gh repo view "$remote" --json nameWithOwner --jq .nameWithOwner)
gh api "repos/$repo/rulesets?includes_parents=true&per_page=100" \
  --jq '.[] | [.id, .name, .source_type, .source, .enforcement] | @tsv'
```

For each repository-owned ruleset that targets the default branch and contains
the pull-request gate or retired status, set its id explicitly and update it
without replacing unrelated rules. The transformation below preserves the
ruleset name, enforcement, conditions, bypass actors, deletion/creation/
non-fast-forward rules, and unrelated required status checks. Repeat it for
each applicable repository-owned ruleset:

```bash
ruleset_id=<repository-ruleset-id>
ruleset_input=$(mktemp)
ruleset_update=$(mktemp)
gh api "repos/$repo/rulesets/$ruleset_id" >"$ruleset_input"

jq '
  .rules |= (
    map(
      if .type == "pull_request" then
        .parameters |= (. + {
          required_approving_review_count: 1,
          require_code_owner_review: false,
          dismiss_stale_reviews_on_push: true,
          require_last_push_approval: false,
          required_review_thread_resolution: false
        })
      elif .type == "required_status_checks" then
        .parameters.required_status_checks |=
          map(select(.context != "first-tree/context-review"))
      else . end
    )
    | map(select(
        .type != "required_status_checks" or
        (.parameters.required_status_checks | length) > 0
      ))
  )
  | {
      name,
      target,
      enforcement,
      bypass_actors,
      conditions,
      rules
    }
' "$ruleset_input" >"$ruleset_update"

gh api --method PUT "repos/$repo/rulesets/$ruleset_id" \
  --input "$ruleset_update"
rm -f -- "$ruleset_input" "$ruleset_update"
```

If no repository-owned default-branch ruleset exists, create the Seed ruleset
instead of running the update above. A ruleset whose `source_type` is
`Organization` is inherited and cannot be changed through the repository API;
its organization ruleset owner must apply the same approval/stale-review and
retired-status changes.

After the update, inspect every effective default-branch ruleset and confirm
that the combined policy requires at least one approval, dismisses stale
reviews on push, blocks non-fast-forward updates, and contains no
`first-tree/context-review` required status. Do not delete or overwrite
unrelated organization policy while removing the retired check.

`first-tree tree seed --team <team-id>` is the stateless admission boundary for
portable Context Tree setup. The Team is required and explicit; this command
does not consult a Workspace manifest, managed briefing, prior setup Chat,
Web selection, or account default/current Team. `--team` accepts any explicit
non-empty Team id — no UUID shape is required, because legacy self-hosted Team
ids predate the UUID format. The Server resolves the signed-in
member's active role and the selected Team's current binding on every call.
An active Admin receives either the exact bound repo/branch or the current
unbound branch. An active ordinary member receives the stable
`CONTEXT_TREE_SEED_NEEDS_ADMIN` response with the selected Team as the recovery
anchor. Invalid historical binding data fails closed. The preflight creates no
repository, binding, branch, PR, Chat, review, or merge state and disables
transport retries; setup agents repeat it explicitly immediately before each
remote mutation.

Preflight failures are reported with stable failure codes; error envelopes
never carry the raw Server body. Codes the Server already classified keep
their exact identity and wording (`CONTEXT_TREE_SEED_NEEDS_ADMIN`,
`CONTEXT_TREE_SEED_CONFIGURATION_INVALID`, and an explicit
`CONTEXT_TREE_SEED_AUTHORITY_FAILED`). Failures the Server did not classify
map to CLI-only codes:

- `CONTEXT_TREE_SEED_INVALID_INPUT` — `--team` missing, empty, padded, or
  carrying control characters; exit `2`, before any network request.
- `CONTEXT_TREE_SEED_AUTHENTICATION_FAILED` — HTTP `401` or a failed
  authentication refresh; exit `3`. Sign in again and retry.
- `CONTEXT_TREE_SEED_TEAM_ACCESS_DENIED` — an unclassified HTTP `403`. One
  message covers both genuine causes — the signed-in member is not an active
  member of the selected Team, or the Team id itself is wrong — so the
  response never confirms whether a given Team id exists; exit `3`.
- `CONTEXT_TREE_SEED_SERVER_INCOMPATIBLE` — the connected Server does not
  serve the Seed preflight route (HTTP `404`); a self-hosted Server older than
  this CLI is the common cause. Exit `1`; upgrade the Server and retry.
- `CONTEXT_TREE_SEED_PREFLIGHT_UNAVAILABLE` — network, timeout, or HTTP `5xx`;
  exit `6`. Retry shortly.
- `CONTEXT_TREE_SEED_PREFLIGHT_INVALID` — the Server returned an unparseable
  or Team-mismatched preflight response; exit `1`.
- `CONTEXT_TREE_SEED_AUTHORITY_FAILED` — the safe generic fallback when no
  more specific claim can be made without leaking Server detail.

The CLI itself stays stateless: it consumes only the explicit `--team` value
it is given. In a managed Setup Chat, that exact Team id is supplied by the
Seed skill from the runtime-authored `<first-tree-current-chat-context>`
payload's `organizationId` field — never from the chat topic, title, Team
display name, Workspace manifest, account default Team, or setup-chat
transcript text. Runtimes older than this contract omit the field; the
skill's fail-closed fallback then resolves the exact current chat once
through `first-tree chat list --engagement all --chat "$FIRST_TREE_CHAT_ID"
--json` and asks the human for the exact Team id when that result is absent
or ambiguous.

After the Admin confirms the complete source set, repeat `--confirm-source`
for every selected repository and `--expected-source-key` for every active
Team repository observed before confirmation. This performs one atomic,
optimistic Settings → Repositories batch after the Admin preflight. A new Team
omits the expected-key flag. The batch is idempotent, never retires omitted
repositories, and returns `409` when another Admin changed the active set.

Provider-aware Seed uses:

```bash
first-tree tree init \
  --team <team-id> \
  --provider github|gitlab \
  --repo <exact-repository-url> \
  --branch <branch> \
  --create|--adopt
```

All five choices are explicit. The command never infers the provider or target
repository from the current directory, Web selection, account default, or
GitLab hostname. `--create` requires the exact remote to be absent, scaffolds
and locally verifies the tree, then creates and pushes it with host-local
`gh`/`glab` plus `git`. `--adopt` requires the exact remote and branch to be
readable, clones it without pushing or overwriting history, and requires
`tree verify` to pass. GitLab nested namespaces and Self-Managed hosts are
preserved. GitHub may include `--with-workflow`; GitLab never creates a GitHub
Actions workflow, approval rule, ruleset, CODEOWNERS gate, or App setup.

The Server Seed preflight is repeated before remote mutation and final binding.
An existing binding is an idempotent success only when provider, canonical
repository, and branch all match; provider-aware Seed never replaces another
binding. New finalization persists the explicit provider. A changed binding,
branch, Team authority, forge credential, or remote state fails closed. If a
create/push response is partial or final binding is unknown, the command
reports the exact possibly-created remote, performs at most one read-only
binding reconciliation, and never claims rollback or deletes a repository.

For compatibility, invoking `first-tree tree init` without the provider-aware
flags retains the legacy GitHub-only path through the 0.5.x line. This
compatibility path and its `--owner`, `--name`, `--org`, `--no-bind`, and
`--rebind` flags are deprecated and will be removed in First Tree 0.6.0;
automation must migrate to the explicit
`--team --provider --repo --branch --create|--adopt` contract before that
release. No new provider behavior is added to the legacy implementation.
That path creates a brand-new team
Context Tree repository with the user's local `gh`: it creates the repo (one
path for user- and org-owned repos),
scaffolds a minimal valid tree (root `NODE.md` + members index + a creator member
node), self-verifies before pushing, pushes, and — unless `--no-bind` — binds the
org's `context_tree` setting and surfaces guidance for adding the repo to the
team's GitHub App installation. It does not seed `.github/workflows/validate-tree.yml`
by default (that needs the interactive `workflow` gh scope); pass `--with-workflow`
to include it. In the bound path the repo is created under the team's GitHub App
installation account (so the installation can cover it), and any explicit `--owner`
is canonicalized before the remote create so case-variant input does not fail after
GitHub has already accepted the repository. If create succeeds but binding or
finalization fails, the CLI says the repo was created but not bound, includes the
repo URL, and tells you to delete it manually if it is empty; it does not auto-delete
created repositories by default. `tree init` refuses to replace an existing team
binding unless `--rebind` is passed. Non-rebind finalization is conflict-safe: if
another writer binds the org after preflight but before the local GitHub side
effects finish, the server preserves that competing binding and `tree init`
reports the conflict rather than overwriting it. A non-`--rebind` invocation
requires a Server with the raw repair/finalize surface during preflight; older
Servers fail before any GitHub repository is created. Key options: `--owner`,
`--name`, `--title`, `--public`, `--dir`, `--with-workflow`, `--no-bind`,
`--rebind`, `--org`, `--team`. Run `first-tree tree init --help` for the full list.

The legacy portable GitHub path uses `tree init --team <team-id>` without
`--provider`, `--repo`, `--branch`, `--create`, or `--adopt`. In that mode
`--team` cannot be
combined with `--org`, `--no-bind`, or `--rebind`; an existing binding is an
idempotent success returned before local tool checks, and the command never
replaces it. For an unbound Team the CLI repeats the Server Seed preflight before
GitHub create/push and again before final binding. A concurrent binding is
preserved, an authority or branch change fails closed, and a lost finalization
response is reconciled against the Server's current binding. Failures after
GitHub mutation name the created or possibly-created repository and never claim
that it was rolled back. The legacy managed `--org`/default-org path remains
available for existing workflows.

The Seed workflow records merged Phase 1 authority in
`<tree>/.first-tree/progress.md`: one versioned Seed marker, the checked Phase 1
line, the explicit Team id, sorted canonical source identities with the exact
commits used for evidence, and the approved top-level domains. A later process
or agent resumes Phase 2 only after a fresh `tree seed --team` result matches
the Tree origin/branch, that exact branch is strictly fetched, the progress
ledger matches the same explicit sources, and every recorded commit remains
readable. Transcript text, private caches, a familiar directory shape, and the
current source head are not recovery authority; any binding, role, source
identity, or recorded-commit mismatch fails closed.

Before any GitHub repository write, the bound path reads the admin-only raw
Context Tree setting. An HTTP 404 from that endpoint identifies an older Server
without conditional-finalization support, so the command uses the legacy safe
settings GET to classify the current state. A valid active binding still gets
the normal existing-binding refusal; if the fallback confirms an unbound state,
a non-`--rebind` invocation fails before looking up the GitHub App installation
or creating a repository and requires a Server upgrade. With `--rebind`, the
caller has explicitly authorized replacement and may continue through the
compatible legacy write. Invalid fallback data and every other raw-read failure
remain fail-stop.

A valid branch-only setting remains unbound. Its branch is retained exactly and
used for `git init`, the generated validation workflow filter, the final
repo-and-branch binding, and the success summary; an absent setting uses
`main`. Any invalid historical repo or branch fails closed before repository
creation so an administrator can repair it without leaving remote side
effects.

Without `--rebind`, final binding uses the dedicated admin-only endpoint:

```http
POST /api/v1/orgs/:orgId/settings/context_tree/initialize
Content-Type: application/json

{"repo":"https://github.com/acme/tree.git","branch":"trunk","expectedUnboundBranch":"trunk"}
```

The Server acquires the organization settings parent lock and commits only if
the setting is still unbound at exactly `expectedUnboundBranch`, the branch read
during preflight. A competing full binding or branch-only change returns 409
and is left unchanged. This dedicated endpoint also prevents an older Server
from interpreting conditional finalization as an ordinary unconditional
settings write. `--rebind` intentionally bypasses this compare-and-set path and
uses the generic `PUT /api/v1/orgs/:orgId/settings/context_tree` with only
`repo` and `branch` to replace the binding directly. The CLI strictly validates
the final response before reporting success.

Repository creation and push happen before final binding, so a finalization
failure can leave the new repository unbound. When that happens, the CLI says
the repository was created but not bound, includes the repo URL, and tells you
to delete an empty repo manually instead of relying on the command to clean it
up. A 409 from the non-rebind finalization POST has a known conflict outcome:
the competing setting was preserved, and the CLI requires reading the
organization's current Context Tree setting first without suggesting a retry or
overwrite command. A finalization 404 during a rolling Server change reports
that no binding was written and requires an upgrade plus read-back, also
without an overwrite command. Other HTTP failures require read-back before
retrying. A network failure, timeout, or invalid/unconfirmed response has an
unknown write outcome and likewise requires read-back first.
The error identifies the exact organization, repository, and retained branch.
For an unknown outcome it also shows the exact recovery form `first-tree org
bind-tree <repo> --org <orgId> --branch <branch>`, but explicitly makes running
it conditional on read-back first confirming that the setting is still
unbound.

`first-tree tree verify` applies the current strict structural policy. Normal
content requires parseable YAML frontmatter with non-empty `title` and `owners`;
`description` and `soft_links`, when present, must have valid shapes. The
separate member-node contract remains in force, while archive/supporting and
repo-infrastructure Markdown are not treated as normal nodes.

Broken `soft_links`, tree-local path escapes, and normal links into
`raw-context/` fail verification. Markdown links are parsed structurally, but
an otherwise tree-local Markdown target may be absent; external links, anchors,
and plain prose that explains the archive class remain allowed. JSON output
preserves the existing summary and adds stable findings plus per-class scan
counts. Context Tree domain directories must not be symlinks; Markdown file
symlinks are validated, must resolve to regular Markdown files, and must stay
inside the tree without crossing content classes, except for the managed
root-level `WHITEPAPER.md` pointer. That historical runtime-managed pointer
remains exempt for compatibility only; writers must not add it to new trees.
This is a breaking tightening for trees that relied on legacy metadata
or normal-to-archive links: mechanical syntax can be corrected directly, while
ownership assignments and promotion of durable archive content require human
or source-backed decisions. Run `first-tree tree verify --help` for options.

`first-tree tree local resolve --ensure --intent read|write` is the narrow
managed-Agent guard for Local Context. It accepts no caller path and resolves
only `<agent-workspace>/local-context/` from the active runtime Agent identity.
It compares the stable Agent name, UUID, Server URL, source kind, fixed path,
and runtime session proof; requires the Agent name to be one non-hidden,
platform-independent member-directory segment; rejects symlinks, special files, escapes, oversized
trees, corrupt/unknown remote-observed state, and any binding state other than
authoritative `unbound`; and lazily fills only missing deterministic scaffold
files. Read intent refuses an invalid Tree. Write intent may return
`repairOnly: true` so the caller can repair the live files, but it does not edit
business content. The guard reads Server binding both before and after
scaffold/verification. A newly observed remote binding is recorded through the
same Client source-publication lock used by runtime projection, then Local is
frozen.

Local Context is Agent-private, shared only among that Agent's Chats, and uses
no content lock, snapshot, candidate, fingerprint, journal, rollback, Git, or
per-write approval. Writers edit the live Tree directly, re-read changed nodes
for semantic policy checks, run full `tree verify`, and call the guard again.
Readers verify before reading and again before using content. Last-write-wins,
moving reads, and crash-left repair are explicit V0 limitations.

`first-tree tree tree [path]` resolves `path` relative to the current
working directory, then renders from the current git repository root down
to that target directory and its descendants. Without `path`, the target is
the current directory. The target must be an existing directory inside the
current git repo.

`--tree-path <root>` selects filesystem mode. In this mode `path` is resolved
relative to the explicit Tree root, the root must be a real directory rather
than a symlink, and the command performs no Git discovery, pull, branch lookup,
snapshot identity, or attribution. Human output begins with
`Mode: filesystem`; JSON reports `mode: "filesystem"`, `branch: null`, and
`readSnapshot: null`. This is the hierarchy mode used after the Local guard
returns a trusted live root and it remains usable when Git is absent from
`PATH`.

Directory nodes come from that directory's `NODE.md`. Leaf nodes come from
Markdown files other than `NODE.md`, `AGENTS.md`, and `CLAUDE.md`. A
Markdown file is renderable only when its YAML frontmatter has a non-empty
string `title` and a non-empty array `owners`; `description` is optional.
The `owners` field is used for filtering and included in JSON, but is not
shown in human output. Hidden paths and common generated directories
(`node_modules`, `__pycache__`, `dist`, `build`, `.next`, `.turbo`) are
skipped.

Human output starts with the Context Tree git checkout branch, then the
rendered tree. When the current branch is not exactly `main`, `master`, or
`origin/main`, the branch line is followed by a stale-tree warning:
Detached HEAD checkouts whose commit matches `refs/remotes/origin/main` are
reported as `origin/main`.

```text
Branch: feature/stale-tree
Warning: current branch "feature/stale-tree" is not main/master; it may be stale. Switch to main/master.
```

An exact snapshot created by `tree read` is recognized through its local Git
metadata. For that checkout, `tree tree` never pulls, even when `--no-pull` is
omitted; it verifies that HEAD still equals the activated exact commit before
returning content. Human output reports `snapshot:<short-sha>`, Team, binding,
and the full exact commit with no stale-branch warning. Managed workspace
checkouts retain the existing pull-before-selector and stale-local fallback
semantics.

The rendered tree's node labels use:

```text
relative/path/ [Title] -> Description
relative/path.md [Title]
```

Directory labels end with `/`. The repository root line uses the repo
directory name, for example `context-tree/ [Context Tree] -> Root
index for the First Tree context tree.`. When `description` is missing,
the `-> Description` suffix is omitted.

Options:

- `-L, --level <depth>` — maximum descendant depth below the target directory. Ancestors from the git repo root to the target are always kept. For path-tolerant CLI use, `tree tree -L docs/development` is treated as `tree tree docs/development`; `tree tree -L 2 docs/development` applies depth `2` to that path.
- `-P, --pattern <pattern>` — case-sensitive shell-style glob filter matched against relative path, filename, `title`, and `description`; matching descendants keep their ancestors visible.
- `--tree-path <root>` — browse an explicit filesystem Context Tree without Git discovery or refresh.

With global `--json` or `FIRST_TREE_JSON=1`, `first-tree tree tree`
emits a single `{ ok: true, data }` envelope on stdout. `data.root` is the
git repo root, `data.target` is the resolved target directory relative to
that root, and `data.options` records the parsed `level`, `pattern`, and
effective `path`. `data.branch` reports the current tree checkout as
`{ name, isMainline, warning }`; `warning` is `null` for `main`, `master`,
and `origin/main`, including detached HEAD checkouts that match
`refs/remotes/origin/main`; otherwise it contains the same stale-tree warning
string shown in human mode. `data.readSnapshot` is `null` for a managed
checkout and contains the activated `{ teamId, binding, commit, snapshotPath }`
identity for a BYO task snapshot. `data.tree` contains the same filtered hierarchy as
structured nodes with `kind`, `name`, `relativePath`, `depth`, `metadata`,
`hasNode`, and `children` fields; `metadata` includes `title`, optional
`description`, and `owners`. Human tree text and branch warnings are not
written to stderr in JSON mode, so stdout stays reserved for machine-readable
JSON.

`first-tree tree io` lists the **calling agent's own** durable Context Tree
read/write events. It is the supported way to recover which tree nodes an agent
actually opened, instead of mining local runtime transcripts. The underlying
`context_tree_io_events` rows are recorded at tool-execution time across every
runtime and deliberately outlive session timeline rows, which are dropped when a
session is terminated or its agent switches runtime.

This command speaks on the runtime agent's behalf: it resolves the local agent
(`--agent <name>`, otherwise `FIRST_TREE_AGENT_ID`) and sends that agent's
selector plus its runtime-session proof. It is self-scoped by construction — an
agent reads its own IO and never another agent's. Team-wide aggregation stays on
the member-authenticated Context Tree snapshot surface.

Filters are `--chat`, `--action read|write`, `--since`, and `--until`
(RFC 3339). `--limit` accepts 1-200 and defaults to 50. Results are newest
first, paginated by an opaque `--cursor`; human mode prints the continuation
cursor when more results exist. `--all` follows pagination automatically but
stops after 50 pages and says so, so one invocation can never walk an unbounded
feed.

Human output is one line per event: timestamp, action, target kind, target
path, and derivation source. JSON mode returns `{ items, nextCursor }`, adding
`truncated: true` when `--all` hit its page bound. Each item carries
`treeHeadCommit` when the runtime observed one, which identifies the candidate
commit for recovering the node content that was read; it is not a claim that a
dirty working file matched that commit.

## Environment variables

Most environment variables use the `FIRST_TREE_` prefix.

### CLI — operator-facing

| Variable | Purpose | Default |
|---|---|---|
| `FIRST_TREE_HOME` | Override the CLI home directory for config, data, agent workspaces, and daemon ownership. Binaries that explicitly share one resolved home are mutually exclusive even when their channels, client ids, or server URLs differ. | Channel-dependent: `~/.first-tree` (prod), `~/.first-tree-staging` (staging), `~/.first-tree-dev` (dev). |
| `FIRST_TREE_SERVER_URL` | Server URL override for `login <code>` and fallback for other commands; otherwise `login` uses the CLI channel default. | — |
| `FIRST_TREE_LOG_LEVEL` | Log level (`trace` / `debug` / `info` / `warn` / `error` / `fatal`). | `info` |
| `FIRST_TREE_JSON` | JSON output mode (equivalent to `--json`). | — |

### Daemon environment file (`daemon.env`) — user-owned

A launchd / systemd / Task Scheduler daemon does **not** inherit your
interactive login-shell environment, so anything your shell exports (commonly
an `HTTP_PROXY` / `HTTPS_PROXY` for users behind a network proxy, or
`FIRST_TREE_CLIENT_SENTRY_ENABLED=false` for Client Sentry opt-out) is invisible
to the background daemon and the agent runtimes it spawns. That is why an
interactive `claude` / `git` can work while the daemon's calls to
`api.anthropic.com` / `github.com` fail.

To supply that environment, create `daemon.env` under your channel's
`FIRST_TREE_HOME` with simple `KEY=VALUE` lines. **The path is channel-specific**
(`~/.first-tree/daemon.env` on prod, `~/.first-tree-staging/daemon.env` on
staging, `~/.first-tree-dev/daemon.env` on dev) — it must match the channel of
the daemon that reads it:

```sh
HTTPS_PROXY=http://127.0.0.1:7897
HTTP_PROXY=http://127.0.0.1:7897
NO_PROXY=localhost,127.0.0.1
FIRST_TREE_CLIENT_SENTRY_ENABLED=false
```

The daemon loads this file on start and passes the values to every child it
spawns. First Tree is **compatible with** your proxy — it only ever *reads*
this file and never writes your proxy into it on your behalf. Values already
present in the daemon's environment are preserved (the file fills gaps, it does
not override). Edit or delete the file freely, then restart the daemon
(`<channel> daemon stop && <channel> daemon start`) to apply changes. See
[troubleshooting/proxy.md](troubleshooting/proxy.md).

### CLI — internal (set by the CLI for its own subprocesses)

These are mentioned for completeness; operators don't set them in shell rc.

| Variable | Purpose |
|---|---|
| `FIRST_TREE_SERVICE_MODE` | Supervisor → child flag baked into launchd/systemd templates and set by the Windows supervisor loop. |

### CLI / daemon — update behavior

These are client-side update behavior tunables. They do not select a release
channel; channel identity comes from the installed package / binary
(`first-tree`, `first-tree-staging`, or `first-tree-dev`).

| Variable | Purpose |
|---|---|
| `FIRST_TREE_UPDATE_RESTART_CHECK_INTERVAL_SECONDS` | Frequency of the upgrade-restart watchdog. |
| `FIRST_TREE_UPDATE_RESTART_QUIET_SECONDS` | Quiet window the upgrade flow waits for before restarting. |
| `FIRST_TREE_UPDATE_PROMPT_TIMEOUT_SECONDS` | Interactive upgrade prompt timeout. |
| `FIRST_TREE_UPDATE_POLICY` | `auto` / `prompt` / `off`. Persisted via `first-tree config set update.policy ...`. |

### Agent runtime (injected by the daemon into agent processes)

Per-agent bearer tokens are gone — every agent on a signed-in machine
authenticates as the signed-in member. The runtime injects these so an
agent process can talk to the server without extra setup:

| Variable | Purpose |
|---|---|
| `FIRST_TREE_ACCESS_TOKEN` | The signed-in member's access JWT (short-lived). |
| `FIRST_TREE_AGENT_ID` | The agent's own UUID — the CLI uses it to identify the sender. |
| `FIRST_TREE_CLIENT_ID` | The client (machine) the agent is bound to. |
| `FIRST_TREE_CHAT_ID` | The chat the current session is bound to. Used by `chat send` / `chat invite`, and by every `cron` command (including `preview` / `list` / `show`). |
| `FIRST_TREE_SERVER_URL` | Server URL override; falls back to client config. |

### Server (SaaS internal)

These configure the SaaS server image (`packages/server/dist/index.mjs`)
and are not used by the CLI. They are listed here for ops reference.

**Identity / channel:**

| Variable | Purpose | Default |
|---|---|---|
| `FIRST_TREE_CHANNEL` | Deployment channel (`prod` / `staging` / `dev`). | `dev` |
| `FIRST_TREE_DATABASE_URL` | PostgreSQL connection URL. | — (required) |
| `FIRST_TREE_PORT` | HTTP listen port. | `8000` |
| `FIRST_TREE_HOST` | Bind address. | `127.0.0.1` |
| `FIRST_TREE_PUBLIC_URL` | Public-facing server origin. Used to stamp the issuer on short connect codes and to build invite-link URLs plus Google and GitHub OAuth callbacks. **Required in production.** | — |
| `FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL` | Base URL for the prod/staging portable installer and artifact mirror. Do not include a channel suffix; the server appends the channel's `publicInstallerPath` (for example, `prod/install.sh`). | `https://download.first-tree.ai/releases` |
| `FIRST_TREE_CORS_ORIGIN` | Allowed origin for the web console. | — |
| `FIRST_TREE_TRUST_PROXY` | Trust the reverse-proxy `X-Forwarded-*` headers. | `false` |
| `FIRST_TREE_WORKSPACES_ROOT` | Where agent worktrees are materialised on the host. | derived from `FIRST_TREE_HOME` |

**Command update advertisement:**

There is no `FIRST_TREE_UPDATE_CHANNEL`. Published channels have separate npm
package identities, and the server polls the package selected by
`FIRST_TREE_CHANNEL`.

| Variable | Purpose | Default |
|---|---|---|
| `FIRST_TREE_COMMAND_VERSION` | Bootstrap CLI version advertised before the npm-registry poller succeeds. The Docker image stamps this from the Command package version at build time. | image build arg |
| `FIRST_TREE_UPDATE_POLL_INTERVAL_MINUTES` | How often the server polls npm for the selected channel package's `latest` version. | `60` |
| `FIRST_TREE_UPDATE_REGISTRY_URL` | npm registry override for the server-side update-version poller. | `https://registry.npmjs.org` |

**Secrets:**

| Variable | Purpose | Production |
|---|---|---|
| `FIRST_TREE_JWT_SECRET` | JWT signing key. `channel=dev` local development auto-generates a value when omitted. | Required for staging/prod |
| `FIRST_TREE_ENCRYPTION_KEY` | AES-256-GCM key for encrypted server-side secrets (GitHub tokens, org-settings secrets). Must be 32 bytes encoded as 64-char hex or base64url. `channel=dev` local development auto-generates a value when omitted. | Required for staging/prod |

The server Docker image sets `NODE_ENV=production`, which disables generated
server secrets even if `FIRST_TREE_CHANNEL` is omitted or defaults to `dev`.

**Auth lifetimes:**

| Variable | Default |
|---|---|
| `FIRST_TREE_AUTH_ACCESS_TOKEN_EXPIRY` | `30m` |
| `FIRST_TREE_AUTH_REFRESH_TOKEN_EXPIRY` | `30d` |
| `FIRST_TREE_AUTH_CONNECT_TOKEN_EXPIRY` | `10m` |

**Auth mode:**

| Variable | Purpose | Default |
|---|---|---|
| `FIRST_TREE_AUTH_MODE` | Authentication provider mode: `standard` (Google/GitHub) or `oidc-required` (OIDC only). | `standard` |

**OIDC (OpenID Connect) for enterprise private deployments:**

| Variable | Purpose | Production |
|---|---|---|
| `FIRST_TREE_OIDC_ISSUER` | OIDC provider issuer URL (e.g., `https://idp.example.com/realms/company`). Must have no userinfo, query, or fragment. | Required when `AUTH_MODE=oidc-required` |
| `FIRST_TREE_OIDC_CLIENT_ID` | OIDC client identifier. | Required when `AUTH_MODE=oidc-required` |
| `FIRST_TREE_OIDC_CLIENT_SECRET` | OIDC client secret. | Required when `AUTH_MODE=oidc-required` |

When `AUTH_MODE=oidc-required`, Google and GitHub sign-in are disabled. See `docs/oidc-sso-guide.md` for setup instructions.

**GitHub App / OAuth:**

| Variable | Purpose |
|---|---|
| `FIRST_TREE_GITHUB_APP_ID` | GitHub App numeric id. |
| `FIRST_TREE_GITHUB_APP_CLIENT_ID` | GitHub App OAuth client id. |
| `FIRST_TREE_GITHUB_APP_CLIENT_SECRET` | GitHub App OAuth client secret. |
| `FIRST_TREE_GITHUB_APP_PRIVATE_KEY` | GitHub App signing key (PEM body). |
| `FIRST_TREE_GITHUB_APP_WEBHOOK_SECRET` | Webhook HMAC secret. |
| `FIRST_TREE_GITHUB_APP_SLUG` | Optional explicit slug override. |

**GitLab Context Tree snapshot egress:**

| Variable | Purpose | Default |
|---|---|---|
| `FIRST_TREE_GITLAB_ALLOWED_ORIGINS` | Additional exact GitLab origins that Cloud may read anonymously over HTTPS. | `[]` plus built-in `https://gitlab.com` |

Public origins are strings. Private destinations attach explicit IPv4/IPv6
CIDRs:

```json
[
  "https://gitlab.example.com",
  {
    "origin": "https://gitlab.company.local:8443",
    "cidrs": ["10.20.0.0/16", "fd12:3456::/32"]
  }
]
```

This is deployment authority, not a Team setting. A public string entry allows
only public-routable DNS results. A CIDR entry requires every resolved address
to fall within its declared ranges. A Team admin may create an inbound GitLab
connection and save a matching Context Tree binding without extending this
policy; Web Context then reports an actionable unavailable state until the
deployment authorizes that origin.

Invalid JSON, duplicate
origins, empty or malformed CIDR policy, and any CIDR rooted in a permanently
blocked range also fail server startup.

Every anonymous clone/fetch rechecks the live Team binding, current GitLab
connection, current deployment allowlist, and every DNS A/AAAA result. The
connection is pinned to the validated address while TLS retains the configured
hostname. Redirects and ambient proxy/Git credential configuration are
disabled. Loopback, link-local, unspecified, multicast, cloud-metadata, and
reserved destinations remain blocked even under a CIDR policy. Removing an
entry preserves existing Team settings but makes Web Context unavailable
without attempting egress.

First Tree Cloud never asks for, stores, logs, or injects a GitLab repository
credential. Public/anonymous-readable authorized repositories can appear in
the Context tab; private GitLab content stays Agent-local and the Context tab
shows a provider-specific unavailable state. That content state is independent
of inbound Webhook and automatic MR-review health.

**Google OAuth / OIDC:**

| Variable | Purpose |
|---|---|
| `FIRST_TREE_GOOGLE_CLIENT_ID` | Google OAuth 2.0 Web application client id. |
| `FIRST_TREE_GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 Web application client secret. |

Set both Google variables to enable Google sign-in; omit both to leave the
provider disabled. A partial configuration fails server startup. First Tree
requests only the fixed identity scopes `openid email profile` and does not
persist Google access or refresh tokens.

Register this exact authorized redirect URI in Google Cloud Console:

```text
${FIRST_TREE_PUBLIC_URL}/api/v1/auth/google/callback
```

The scheme, host, port, path, and trailing-slash form must exactly match the
deployed `FIRST_TREE_PUBLIC_URL`. See
[Google OAuth operator setup](development/google-oauth.md) for the full setup
and verification procedure.

**Rate limits:**

| Variable | Default |
|---|---|
| `FIRST_TREE_RATE_LIMIT_MAX` | `3000` |

The server applies this as one actor-aware global safety cap per minute. It
keys by agent id, then user id, then request IP for unauthenticated traffic.
Old per-route rate-limit env vars are no longer read.

**Attachments:**

| Variable | Default |
|---|---|
| `FIRST_TREE_ATTACHMENT_ORG_QUOTA_COUNT` | `10000` |
| `FIRST_TREE_ATTACHMENT_RETENTION_DELETE_ENABLED` | `false` (dry-run) |

Maximum number of attachment objects one Team may hold. Chat uploads, Feishu
inbound resources, Team Skill bundles, and Agent Template adoption copies all
share the same per-Team pool. The per-file 10 MiB cap and the per-Team 2 GiB
byte quota are fixed and stay the storage backstop regardless of this value.

Message-class attachments (chat images/documents, Feishu inbound resources)
expire 14 days after creation: a sweep runs once at server startup and then
every 24 hours, deleting the attachment row and its PostgreSQL bytes even
while historical messages still reference them — messages themselves stay
immutable and render an explicit "expired or unavailable" state.
Attachments held by a Team Skill Resource or an Agent Template bundle never
expire. The sweep is a **dry-run by default**: it only counts and logs the
eligible objects/bytes so operators can size the impact first. Set
`FIRST_TREE_ATTACHMENT_RETENTION_DELETE_ENABLED=true` to enable real
deletion. Rolling back means setting it back to `false`, which only stops
future deletions — already-deleted bytes can only be restored from a database
backup.

**Inbox / WS / archive sweeper:**

| Variable | Default |
|---|---|
| `FIRST_TREE_INBOX_MAX_IN_FLIGHT_PER_AGENT` | server-tuned |
| `FIRST_TREE_WS_MAX_PAYLOAD` | `262144` (256 KiB) |
| `FIRST_TREE_ARCHIVE_SWEEP_INTERVAL_SECONDS` | `300` (set `0` to disable) |
| `FIRST_TREE_ARCHIVE_MAPPED_IDLE_SECONDS` | `3600` |

`FIRST_TREE_ARCHIVE_MAPPED_IDLE_SECONDS` is the SCM-source archive idle
threshold. Mapped GitHub/GitLab chats also require all bound entities to be
closed/merged; provider-owned chats with no mapping use the same idle
threshold.

**Scheduled jobs (cron):**

| Variable | Purpose | Default |
|---|---|---|
| `FIRST_TREE_POLLING_INTERVAL_SECONDS` | Runtime polling cadence used by the cron worker; must be `1..10` so due occurrences remain inside the dispatch grace window. | `5` |

**Observability:**

| Variable | Purpose | Default |
|---|---|---|
| `FIRST_TREE_LOG_LEVEL` | Server log level. | `info` |
| `FIRST_TREE_OTEL_ENDPOINT` | OTLP/HTTP traces endpoint. Non-empty enables tracing. | `""` |
| `FIRST_TREE_OTEL_HEADERS` | OTLP headers as `key1=val1,key2=val2`. Typically holds the write token. | `""` |
| `FIRST_TREE_OTEL_ENVIRONMENT` | Deployment label emitted as `deployment.environment.name`. | `development` |
| `FIRST_TREE_OTEL_CAPTURE_CLIENT_IP` | Capture client IP attribute on traces. | `false` |
| `VITE_SENTRY_DSN` | Public browser DSN for Web Console errors in the `first-tree-web` Sentry project. | unset |
| `VITE_SENTRY_ENABLED` | Explicit Web Sentry switch; `false` / `0` / `off` disables even when a DSN is present. | enabled when DSN exists |
| `VITE_SENTRY_ENVIRONMENT` | Web Sentry environment label. | host/mode-derived |
| `VITE_SENTRY_TRACES_SAMPLE_RATE` | Web Sentry trace sample rate (`0.0–1.0`). | `0.1` |
| `FIRST_TREE_CLIENT_SENTRY_DSN` | Client daemon/runtime DSN for the `first-tree-client` Sentry project. | unset |
| `FIRST_TREE_CLIENT_SENTRY_ENABLED` | Explicit Client Sentry operator switch; `false` / `0` / `off` disables even when a DSN is present. | enabled when DSN exists |
| `FIRST_TREE_CLIENT_SENTRY_ENVIRONMENT` | Client Sentry environment label. | `NODE_ENV` or `development` |
| `FIRST_TREE_CLIENT_SENTRY_TRACES_SAMPLE_RATE` | Client Sentry trace sample rate (`0.0–1.0`). | `0.05` |
| `FIRST_TREE_GIT_SHA` | Git SHA stamped onto Web/Client Sentry releases and tags when provided by CI. | `unknown` |

See [observability.md](observability.md) for the full config reference, backend cheat sheet, and troubleshooting recipes.

---

## Directory layout (CLI home)

```
~/.first-tree/                                     # FIRST_TREE_HOME default for the prod channel
├── config/
│   ├── client.yaml                                # this machine's client config (server.url, client.id)
│   ├── credentials.json                           # access + refresh JWT (mode 0600)
│   └── agents/
│       └── <name>/
│           └── agent.yaml                         # agentId + runtime
├── data/
│   ├── context-tree-repos/                        # legacy shared Context Tree pool (retained for old installs; new clones live per-agent)
│   ├── sessions/                                  # per-agent session registry
│   └── workspaces/
│       └── <agent-name>/                          # per-agent home (cwd is shared across chats)
│           ├── context-tree/                      # agent-managed Context Tree clone (agent clones/pulls it per its briefing)
│           └── worktrees/                         # per-task worktrees the agent creates and cleans up
├── state/
│   ├── daemon-runtime.lock                        # authoritative single runtime owner for this resolved home
│   └── client-runtimes/                           # non-authoritative runtime markers used by diagnostics/lifecycle checks
└── logs/                                          # daemon stderr / stdout (macOS)
```

When `FIRST_TREE_HOME` is set, replace `~/.first-tree/` with that location. Staging and dev channels use `~/.first-tree-staging/` and `~/.first-tree-dev/` respectively as their channel-default home.

## Config resolution order

Priority from high to low:

1. CLI arguments
2. Environment variables (`FIRST_TREE_*`)
3. Config files (`~/.first-tree/config/client.yaml`, or the staging/dev channel's equivalent)
4. Built-in defaults

## Verification after upgrade

After `first-tree upgrade` or after running `logout` + `login <code>` on a deployment-bump cycle:

```bash
first-tree status          # CLI version + service + server + auth + agents
first-tree daemon doctor   # service + agent configs + WS reachability
first-tree --help          # top-level verbs + namespaces
```
