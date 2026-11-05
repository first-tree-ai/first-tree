# Local development with isolation from prod / staging

This repo's CLI is a long-running background service on the developer's
machine. Most of us run prod (`first-tree`) or staging
(`first-tree-staging`) somewhere — installed through the channel's shell
installer and kept alive by systemd / launchd. The in-tree dev build must
coexist with both without touching their state.

The channel-specific layout makes this trivial: every channel has its own bin
name, default home, and supervisor identifier. Running
`scripts/dev-install.sh` installs the dev channel (`first-tree-dev` /
`~/.first-tree-dev/` / `first-tree-dev.service`, or the Windows Task Scheduler
task `\FirstTree\first-tree-dev`) alongside whatever prod / staging install you
already have.

| Channel | Install via | Bin | Default home | Supervisor identifier |
|---|---|---|---|---|
| dev | `scripts/dev-install.sh` (in-tree, symlinked) | `first-tree-dev` / `ftd` | `~/.first-tree-dev/` | `first-tree-dev.service` / `\FirstTree\first-tree-dev` |
| staging | `curl -fsSL https://download.first-tree.ai/releases/staging/install.sh \| sh` | `first-tree-staging` / `fts` | `~/.first-tree-staging/` | `first-tree-staging.service` / `\FirstTree\first-tree-staging` |
| prod | `curl -fsSL https://download.first-tree.ai/releases/prod/install.sh \| sh` | `first-tree` / `ft` | `~/.first-tree/` | `first-tree.service` / `\FirstTree\first-tree` |

Each install registers as a separate `clientId` on whichever server it
connects to (dev → local server, staging → `dev.cloud.first-tree.ai`,
prod → `cloud.first-tree.ai`), so server-side state stays cleanly
partitioned too.

## Quickstart

```bash
# from repo root, first-time use
./scripts/dev-install.sh

# Start your local server (any way you like — e.g. `pnpm --filter @first-tree/server dev`)

first-tree-dev login <connect-code>    # code from http://127.0.0.1:8000/clients
first-tree-dev daemon status
journalctl --user -u first-tree-dev -f
```

After editing any source file, re-run `./scripts/dev-install.sh`; it
rebuilds dist and restarts the installed dev daemon so the running
service picks up the new build:

```bash
./scripts/dev-install.sh
```

The script reports each phase (dev home, dependencies, build, linking, CLI
verification, daemon restart) with timings, and passes `pnpm` / `turbo` output
through untouched. `--quiet` buffers that output and replays it only on
failure, printing just errors and the final summary; `--no-banner` drops the
banner and keeps the phase reporting. `NO_COLOR` disables colour, and colour is
off automatically when stdout is not a terminal.

After login, on Linux:

```bash
$ systemctl --user list-units 'first-tree*'
  first-tree.service             loaded active running    # prod (if installed), untouched
  first-tree-staging.service     loaded active running    # staging (if installed), untouched
  first-tree-dev.service         loaded active running    # dev, installed by dev-install.sh
```

Three independent unit files, three PIDs, three journald identifiers,
three home dirs. No cross-contamination. Each daemon takes an atomic owner lock
at `<resolved-home>/state/daemon-runtime.lock`; the home, rather than the
channel/client/server tuple, is the mutual-exclusion boundary.

Do not point a dev command at a live prod or staging home to test another
channel. An explicit shared `FIRST_TREE_HOME` intentionally collapses the
isolation boundary, so the second foreground or service runtime is refused even
when its channel, client id, or server URL differs. Use another temporary dev
home instead:

```bash
FIRST_TREE_HOME="$(mktemp -d)" first-tree-dev daemon start --foreground
```

Distinct temporary dev homes can run concurrently, including while the ordinary
dev background service remains active under its separately configured home.
Foreground preflight compares the canonical current home with the home pinned
into the installed supervisor definition before asking the operator to stop the
service; the per-home owner lock remains the final authority.

## How channel identity is wired

`apps/cli/src/build-info.ts` exports a single `CHANNEL` constant
(`"dev"` in source, rewritten to `"prod"` / `"staging"` by CI before
publish). All downstream identifiers — npm package name, bin name,
default home, default server URL, service unit, launchd label — derive
from this single value via `getChannelConfig` in
[`packages/shared/src/channel/`](../../packages/shared/src/channel/index.ts).

`apps/cli/src/core/channel-env.ts` runs as the very first import in the
CLI entry. It sets `process.env.FIRST_TREE_HOME` from the channel's
default home (unless the operator already set the env explicitly),
which the `@first-tree/shared/config` resolver reads lazily at each call.
That keeps bundled ESM evaluation from freezing a staging/dev process onto the
production fallback before channel initialization.

The published-package `name` and `bin` get rewritten by the CI publish
job alongside `CHANNEL` — the source-tree `apps/cli/package.json`
always carries the dev shape (`name: "first-tree-dev"`, bin
`first-tree-dev` / `ftd`).

## Auto-update across channels

`UpdateManager` keeps polling the server for a target version. The
client-side guard in
[`apps/cli/src/core/update.ts`](../../apps/cli/src/core/update.ts) refuses
to install a version whose channel does not match this binary's
channel — `inferChannelFromVersion("0.5.2-staging.42.1") === "staging"`,
so a prod CLI told to install that target logs an error and skips.
Dev binaries refuse self-update entirely (`packageName === null`).

On macOS, the generated launchd wrapper supervises the daemon across the
reserved self-update exit code `75`. This keeps the already-running launchd job
alive while it reloads the atomically replaced wrapper and starts the newly
installed CLI, including updates that change the resolved command or install
path. It does not depend on a new launchd spawn that macOS may defer while the
GUI session is in on-demand-only mode after display sleep or screen lock. Other
exit codes still return to launchd so its ordinary crash throttling and stop
behavior remain authoritative.

If you need to swap dev for staging without `git pull`, install staging
side-by-side:

```bash
curl -fsSL https://download.first-tree.ai/releases/staging/install.sh | sh
```

After the installer completes successfully, sign in with the staging binary:

```bash
~/.local/bin/first-tree-staging login <connect-code>
# now both `first-tree-dev daemon status` and `first-tree-staging daemon status` work
```

## When to use which install

- **`scripts/dev-install.sh`** — actively iterating on CLI / client /
  shared code. Build is local, with no hosted release round-trip.
  `upgrade` short-circuits because `detectInstallMode()` returns
  `"source"`.
- **Direct `pnpm --filter ... dev`** — running parts of the system in
  isolation (server-only, web-only) where you don't need the full CLI
  surface. `tsx` runs against source.
- **The staging shell installer** — when you want to test the exact portable
  bits that team members run. It coexists with the dev install; binaries live
  under `~/.local/bin`, release data has its own staging prefix, and client data
  stays in `~/.first-tree-staging/`.

## What `dev-install.sh` does NOT isolate

- The PostgreSQL database. The server uses one shared DB by default. If
  you also run an in-tree server (`pnpm --filter @first-tree/server dev`),
  use a separate DB URL via `FIRST_TREE_DATABASE_URL`.
- Hosted-channel release data. If you have both staging and prod portable
  installs, upgrading either (for example, via `first-tree-staging upgrade`)
  follows that channel's configured server target and updates only that
  channel's portable prefix. Existing legacy npm-mode installs retain their
  machine-wide global npm update behavior; managed Linux daemons perform that
  update in a transient unit while the daemon is stopped. Dev is immune
  because its source-checkout install mode short-circuits the upgrade path.

## Tearing down a dev install

```bash
first-tree-dev daemon stop
# Optional — fully remove the unit file + auto-start:
systemctl --user disable first-tree-dev.service
rm ~/.config/systemd/user/first-tree-dev.service
systemctl --user daemon-reload

# Remove the bin symlinks
rm ~/.local/bin/first-tree-dev ~/.local/bin/ftd

# Wipe the isolated home if you want a fresh slate
rm -rf ~/.first-tree-dev
```

Prod / staging installs are unaffected throughout.
