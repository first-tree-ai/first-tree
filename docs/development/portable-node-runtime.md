# Portable Node Runtime Policy

First Tree's portable installer ships a bundled Node.js runtime inside each
portable release artifact:

```text
<prefix>/versions/<version>/
  node/   # bundled Node.js runtime
  app/    # built CLI package
```

Portable users do not depend on the Node.js version installed on the host
machine. Each portable self-update installs the target release artifact into a
new `versions/<version>` directory, switches `current`, rewrites the shims, and
lets the service manager restart through the shim. The restarted process then
uses the Node.js runtime bundled with the target artifact.

## Ownership

The Distribution / Portable Node owner owns the bundled Node.js policy and bump
PRs. The current Context Tree owner for portable Node distribution is
`bestony`. Normal repository CODEOWNERS still apply for review, but the owner
of this area is responsible for noticing when the runtime line must move and
for cutting a First Tree release when a Node patch needs to reach portable
users.

## Pin Location

The bundled Node.js runtime is pinned to an exact version in a single file:

```text
scripts/portable/node-version.txt   # e.g. v24.18.0
```

`scripts/portable/build-portable.mjs` and `scripts/portable/build-release.sh`
read this file as their default `--node-version`, and the portable smoke job in
`.github/workflows/ci.yml` uses it via `node-version-file` so CI exercises the
pinned runtime before release. A bump PR only needs to change this one file.

Floating specs such as `latest-v<major>.x` are rejected by design: portable
release publication treats versioned S3 artifacts as immutable, and a resumed
or re-run release must rebuild byte-identical tarballs. A floating Node spec
would make the same channel/version resolve to different runtime bytes over
time. The pinned version's tarball is checksum-verified against the official
`SHASUMS256.txt` at build time.

## Bump Triggers

Bump the bundled Node.js major when any of these is true:

- The currently bundled major is approaching end of life and the next supported
  major has had enough staging exposure.
- First Tree needs a runtime or dependency feature that is only supported on a
  newer Node.js major.
- A Node.js security advisory makes staying on the current major an unacceptable
  risk, or the fixed line requires moving majors.

Patch-level security fixes are coupled to First Tree releases. Because the
bundled runtime is pinned in `scripts/portable/node-version.txt`, portable
users receive a new Node.js patch only when the pin is bumped and a new First
Tree portable release is cut. For a high-impact Node.js advisory that affects
the bundled major, bump the pin and cut a First Tree release even if the app
code did not otherwise need one.

## Cross-Major Verification

Before the first real bump to a new Node.js major, run the automated portable
handover test and the portable artifact smoke:

```bash
pnpm --filter first-tree-dev test -- update-portable-install
pnpm --filter first-tree-dev test -- portable-builder
```

The handover test covers the critical invariant: an old portable install can
run the updater while the target artifact contains a different bundled Node.js
major, because the new runtime is not executed in place before the symlink
switch and service restart.

For release rehearsal, build a staging portable artifact with the candidate
Node line, update an older staging portable install to it, then verify:

- `$FIRST_TREE_HOME` still points through the channel shim.
- `<prefix>/current/INSTALL.json` records the candidate `nodeVersion`.
- `first-tree-staging status` reports the target CLI version after restart.

## Legacy npm-Mode Runtime Policy

New prod and staging installations use the channel-aware shell installer.
Existing npm-mode installations remain upgrade-compatible during migration,
but they use the user's system Node.js runtime. They do not and cannot replace
Node.js during `first-tree upgrade`.

Before npm-mode self-update runs `npm install -g`, the CLI performs a
best-effort metadata preflight against the target package's `engines.node`.
When the current process Node.js version does not satisfy the target package's
range, the update fails before install with guidance to either:

- upgrade the system Node.js runtime and rerun `first-tree upgrade`; or
- migrate by running the shell-installer command from the web console.

If npm metadata cannot be read, the CLI falls back to the existing npm install
path and classifies npm's own error output. `EBADENGINE` remains a permanent
operator-action failure.

On Linux, an npm-mode daemon managed by systemd performs automatic updates in a
transient `systemd-run` unit outside the daemon's service cgroup. The worker
stops the daemon before npm reifies the global package tree, moves the current
package and channel links aside for rollback, and starts the daemon only after
the install completes. This prevents a supervisor restart from killing npm
halfway through a reify and booting a daemon against a partial `node_modules`
tree. Foreground and manually invoked npm updates retain the direct npm path.
