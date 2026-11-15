# CLI

Install the CLI with the shell installer for your release channel, then sign
the computer in with a connect code from the First Tree web console.

## Production

```bash
curl -fsSL --proto '=https' --proto-redir '=https' https://download.first-tree.ai/releases/prod/install.sh | sh
~/.local/bin/first-tree login <connect-code>
```

## Staging

```bash
curl -fsSL --proto '=https' --proto-redir '=https' https://download.first-tree.ai/releases/staging/install.sh | sh
~/.local/bin/first-tree-staging login <connect-code>
```

The macOS/Linux installers bundle Node.js. The explicit `~/.local/bin` paths
work immediately, even before the current shell reloads `PATH`. The two lines
are intentionally independent and do not provide shell-level transaction
protection: when pasted together, an install-line failure does not automatically
prevent the login line from running, and POSIX `sh` does not guarantee that
`curl | sh` preserves a `curl` failure status. For a self-hosted deployment,
use the exact two-line command shown by its web console so the installer and
login command receive the correct server and download-base overrides.

Development builds use `scripts/dev-install.sh` from a source checkout and
sign in with `first-tree-dev login <connect-code>`.

## Installer output and flags

The installer names each phase as it runs and shows a byte-level progress bar
while downloading. Colour, the bar, and the full banner appear only on a
terminal, so piped and CI output stays plain text; `NO_COLOR` disables colour
on a terminal as well.

Flags go after `--` when piping:

```bash
curl -fsSL --proto '=https' --proto-redir '=https' https://download.first-tree.ai/releases/prod/install.sh | sh -s -- --quiet
```

`--quiet` prints only errors and the final summary, and `--no-banner` drops the
banner while keeping the phase reporting. `--version`, `--prefix`, `--bin-dir`,
`--no-path-edit`, and `--path-mode` are documented in
[the CLI reference](https://github.com/agent-team-foundation/first-tree/blob/main/docs/cli-reference.md#installer-flags).
