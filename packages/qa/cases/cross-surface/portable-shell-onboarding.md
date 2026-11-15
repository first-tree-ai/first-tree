---
id: portable-shell-onboarding
description: Validate that hosted prod and staging onboarding copy the server-authored bootstrap verbatim and complete the public portable install, channel-correct login, and daemon startup path.
areas: [cross-surface]
surfaces: [server, web, cli]
---

# Portable Shell Onboarding

## Goal

Confirm the fresh-computer path across server, web, the public download service, and CLI: a prod or staging server mints
the canonical two-line shell bootstrap, the web displays and copies it without reconstructing it, the public installer
selects the matching channel artifact, and the installed full-path binary completes `login` and starts its daemon.

Run both hosted channels. The expected commands, with the minted connect code substituted for `<connect-code>`, are:

```sh
# Production
curl -fsSL --proto '=https' --proto-redir '=https' https://download.first-tree.ai/releases/prod/install.sh | sh
~/.local/bin/first-tree login <connect-code>

# Staging
curl -fsSL --proto '=https' --proto-redir '=https' https://download.first-tree.ai/releases/staging/install.sh | sh
~/.local/bin/first-tree-staging login <connect-code>
```

The two lines are intentionally independent and provide no shell-level transaction protection. If both are submitted
together, a failure on the install line does not automatically stop the login line, and POSIX `sh` does not guarantee
that `curl | sh` preserves a `curl` failure status. This is an accepted usability tradeoff, not a fault-injection claim
owned by this case.

Deterministic product tests own exact string construction and escaping. This case owns the live boundaries those tests
cannot prove: the server-to-web handoff, byte-for-byte clipboard content, public installer chain, installed channel
identity, real first login, daemon startup, and server-side client registration.

## Preconditions

- Run the target ref in an isolated Docker + temporary git-worktree run cell. Do not install either channel on the
  operator host or reuse its First Tree homes, credentials, daemon, or shell profile.
- Build the shipped server/web artifact from the target ref. Run separate prod and staging server stacks, or reset all
  database and client state before switching channel configuration.
- Give each channel a clean writable `HOME`. The runner must have `sh`, `curl`, CA certificates, and the installer's
  normal archive/checksum tools, but no system Node.js requirement; the portable artifact must supply its own runtime.
- On Linux, match the service-manager precondition to the user under test. For a normal user, give the runner a real
  systemd user manager and D-Bus user session, and verify that `systemctl --user status` can reach the manager before
  testing. For root, give the runner a working system systemd manager and verify `systemctl status` can reach it; root
  login installs the channel service in system scope and must not depend on a root user bus. A plain container without
  the required manager for the chosen user cannot validate this case: `login` must install and start the background
  daemon, so a missing manager is `BLOCKED`. Do not add `--no-start`, mock the supervisor, or accept a credentials-only
  login as a substitute.
- Public network access to `https://download.first-tree.ai` is required. Record the resolved public metadata/version for
  each mutable `install.sh` entry point so the report distinguishes the tested public release from the source target ref.
- Use throwaway server secrets, databases, users, and connect codes. A non-production QA auth bootstrap may be enabled
  inside the run cell, but never bridge a real hosted account or credentials into it.

Configure each isolated server with the channel's canonical public URL when capturing the hosted command
(`https://cloud.first-tree.ai` for prod and `https://dev.cloud.first-tree.ai` for staging). The CLI still needs to reach
the isolated server to exchange the code. Supply a run-local `FIRST_TREE_SERVER_URL` to the CLI runner process, outside
the copied bootstrap text, while leaving the server's canonical public URL in place so issuer validation and the emitted
hosted command remain representative. Record this routing override as QA harness configuration, not product output.

## Operate

For each of `prod` and `staging`:

- Start the candidate server/web stack with the matching `FIRST_TREE_CHANNEL`, create a throwaway authenticated user, and
  exercise the onboarding connection step and **Computers -> New Connection**. When the new-agent no-computer path is
  available, confirm that it presents the same server-supplied bootstrap instead of building a different command.
- Capture the `POST /api/v1/me/connect-tokens` response and the command copied from every exercised UI surface. Compare
  them byte-for-byte before redaction. The UI copy must equal `bootstrapCommand`; `installerUrl`, `binName`, and the
  standalone installed-CLI `command` must all describe the same channel. Redact the connect code in shared evidence.
- Fetch the public `install.sh` separately for HTTP status and `sh -n` evidence. The default latest install path reads
  `latest.json` directly and downloads the matching platform asset from that document; record its channel, version,
  binary name, asset URL, and checksum. Independently fetch the immutable manifest referenced by `manifestUrl` and that
  version's `SHA256SUMS`, then cross-check their identity and checksum data without modifying public objects. Do not
  report the manifest or `SHA256SUMS` as files consumed by the installer itself.
- In the clean CLI runner, execute the exact copied two-line bootstrap once. The only harness addition is the externally
  supplied run-local `FIRST_TREE_SERVER_URL` needed to route login to the isolated server. Do not rewrite the installer
  URL, binary path, connect code, or command lines; do not add a shell guard or append `--no-start`.
- Observe the installed executable, daemon, and isolated server after login. Use current black-box CLI/API surfaces to
  confirm that the client registration belongs to the throwaway user and was created by the channel-correct binary.

## Observe

- `observe browser-ui`: every exercised web entry point displays and copies the server response exactly. There is no npm
  install step, Node.js fallback, or PATH-dependent bare login command.
- `observe http-api`: prod returns the prod installer URL, `first-tree`, and the exact prod two-line bootstrap. Staging
  returns the staging installer URL, `first-tree-staging`, and the exact staging two-line bootstrap. The first line uses
  `curl -fsSL ... | sh`; the second uses the channel's full binary path. The connect code appears only in the login line,
  never in `installerUrl` or public download requests.
- `observe public-http`: both public installers return successfully and pass `sh -n`; each default install reads its
  channel's `latest.json` asset and verifies that tarball's checksum. As a separate consistency check, the referenced
  immutable manifest and versioned `SHA256SUMS` agree with the latest metadata and downloaded asset.
- `observe filesystem`: from a clean home, the installer creates `~/.local/bin/first-tree` for prod or
  `~/.local/bin/first-tree-staging` for staging. The full path in the second line works immediately without sourcing a
  shell profile, and installed metadata identifies the matching channel and portable install mode.
- `observe cli-output`: the installed executable launches with its bundled Node.js runtime and the first `login` exits
  successfully against the isolated server without `--no-start`.
- `observe installer-output`: the installer identifies itself as First Tree before doing any work, names each phase as it
  runs, and reports the resolved channel, platform, version, and download size. The payload download reports byte
  progress against the size in the release metadata rather than going silent. Because the bootstrap is piped through
  `sh`, the installer's own stdin is not a terminal — confirm the progress reporting is gated on stdout/stderr, so a
  runner that captures stdout receives plain text with no carriage returns or ANSI escapes while a terminal run shows
  the bar. A failure surfaces which phase failed, and the checksum, smoke-check, and PATH-guidance messages keep their
  existing wording. `--quiet` is limited to errors and the final summary, including any output the installer relays from
  the CLI's own service lifecycle.
- `observe service-readiness`: this flow installs before any login exists, which is the deferred case, not the ready one.
  Confirm the installer reports readiness only when the unit is actually installed and running: after a first install
  with no credentials it relays the command's own "run login" notice and must not follow it with a line claiming the
  background service is set up, and a genuine service-repair failure produces a warning rather than either. Judge this
  from the installer's own reporting against the observed unit state, not from the exit status of the install alone.
- `observe process-state`: interrupting the installer mid-download stops the payload transfer itself, not just the shell
  that waits on it. After the installer exits, no `curl`/`wget` child remains reparented to init writing into the
  removed work directory, and the previously active version is left untouched.
- `observe service-state`: login installs and starts the channel-correct systemd service. For a normal Linux user,
  `systemctl --user` reports the user unit active through the runner's real user manager and bus. For root,
  `systemctl status <channel-service-unit>` reports the system unit active, and `journalctl -u <channel-service-unit>`
  is the supervisor fallback.
- `observe http-api`: the isolated server reports the newly registered client for the throwaway user after login. Prod
  and staging homes and clients stay isolated; neither flow invokes the other channel's binary.

Follow current typed response and installed-metadata schemas if field names evolve, but keep the evidence tied to the
same cross-surface claims. Do not treat source inspection, unit-test output, or a successful installer download alone as
proof that first login worked.

## Expected Result

`PASS`: both prod and staging web/API flows supplied the exact hosted two-line command, every exercised web surface
copied it byte-for-byte, each live public installer installed its matching channel artifact in a clean Node-free runner,
the full-path binary completed login with its background service active, and the isolated server observed the expected
channel-correct client.

`FAIL`: a reproducible product defect, such as web copy diverging from `bootstrapCommand`, an npm/Node fallback appearing,
the public URL or metadata crossing channels, the expected full-path binary being absent, a bundled-runtime launch
failure, daemon installation/start failing despite a healthy user manager and bus, or a valid fresh connect code failing
to register against a healthy isolated server.

`BLOCKED`: Docker or public download access is unavailable, QA auth/data bootstrap cannot mint a connect code, a required
public channel release has not been published, or the Linux runner lacks the reachable systemd manager required for the
chosen user (user manager + D-Bus user session for normal users, system manager for root). Do not downgrade this case to
`login --no-start`.

`INCONCLUSIVE`: only one channel completed, the mutable public installer changed during the run, the public artifact
could not be attributed to the recorded metadata/version, or clipboard, login, daemon, or registration evidence was
partial or unstable.

## Evidence

Keep redacted API responses, browser screenshots plus clipboard capture, installer, latest metadata, immutable-manifest,
and `SHA256SUMS` HTTP responses, `sh -n` output, checksum/install logs, installed binary/version/channel evidence, CLI
login output, systemd service state (user scope for normal users, system scope for root), and server-side client
registration. Record the target ref, public artifact versions, container image digests, and run-local routing overrides.
Never retain connect codes, bearer tokens, cookies, or generated client credentials in shared artifacts.
