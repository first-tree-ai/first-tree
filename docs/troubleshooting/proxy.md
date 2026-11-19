# Proxy & network egress (daemon behind a firewall)

First Tree's background daemon (launchd on macOS, systemd on Linux,
and per-user Task Scheduler on Windows) is **compatible with** whatever proxy
you run — it does not configure, capture, or manage a proxy for you. Linux uses
`systemd --user` for normal users and a system-scoped unit when the CLI is run
as root. This page explains the one thing you must do so the daemon can reach
the network the same way your shell does.

## Symptom

Agents fail with an auth-shaped error even though `claude auth login` /
`claude -p` work in your terminal — for example:

```
authentication_failed / API Error: 403 Request not allowed
```

`403 Request not allowed` is returned by Anthropic **before** authentication.
It almost always means the request never reached Anthropic — most often the
daemon is not going through your proxy — **not** that your login is broken.

## Why it happens

launchd / systemd / Task Scheduler do **not** inherit your interactive
login-shell environment. Anything your shell exports — including `HTTP_PROXY` /
`HTTPS_PROXY` — is absent from the daemon's process, so the daemon and every
agent runtime it spawns (the Claude CLI, `git`, `npm`) attempt **direct**
connections. On a network where direct egress is blocked, those fail. Your
interactive `claude` works only because your terminal already has the proxy in
its environment.

## Fix: tell the daemon your proxy (`daemon.env`)

Create `daemon.env` under your channel's `FIRST_TREE_HOME`, with `KEY=VALUE`
lines, then restart the daemon. **The path is channel-specific** — use the home
that matches the binary you run:

| Channel | Binary | `daemon.env` path |
|---|---|---|
| prod | `first-tree` | `~/.first-tree/daemon.env` |
| staging | `first-tree-staging` | `~/.first-tree-staging/daemon.env` |
| dev | `first-tree-dev` | `~/.first-tree-dev/daemon.env` |

```sh
# Example for the prod channel — swap the home if you run staging/dev.
cat > ~/.first-tree/daemon.env <<'EOF'
HTTPS_PROXY=http://127.0.0.1:7897
HTTP_PROXY=http://127.0.0.1:7897
NO_PROXY=localhost,127.0.0.1
NODE_USE_ENV_PROXY=1
EOF

first-tree daemon stop && first-tree daemon start   # use your channel's binary
```

What each egress path reads, and when, is not the same — this matters when
`daemon.env` is the only place you set your proxy:

| Egress | Honours the proxy from `daemon.env`? | Why |
|---|---|---|
| agent runtimes (`claude`, `git`, `npm`) and anything the daemon spawns | **yes** | they inherit the daemon's environment when they start |
| the daemon's WebSocket to the server | **yes** | the upgrade reads the variables each time it connects |
| the daemon's own `fetch` calls to the server | **no** | Node installs fetch's environment-proxy agent at **process start**, before the daemon loads `daemon.env` |

So `daemon.env` is enough for agent runtimes and for the socket. If the daemon's
own HTTP traffic to the server must go through the proxy too, the variables have
to be in the daemon's environment *before* Node starts — the service unit or the
shell you launch it from — and a CLI switch that injects them into the unit does
not exist yet.

`NO_PROXY` follows the same split. For the socket the daemon checks the
destination itself before building its agent (that agent does not read the
variable); for `fetch`, Node's proxy agent reads it at start. Entries take the
forms `curl` accepts — `*` (proxy nothing), a host and its subdomains
(`example.com` also excludes `api.example.com`), a leading-dot or `*.` suffix,
an optional port (`example.com:8443`), and bracketed IPv6 literals (`[::1]`).
Lowercase `https_proxy` / `no_proxy` win over the uppercase spelling, and a
plain `HTTP_PROXY` is used for TLS destinations when no `https_proxy` is set —
the same choices `fetch` makes.

`KEY=VALUE` only — one per line. A `# comment` is allowed on its own line or as
a trailing ` # ...` on an unquoted value; quote the value (`KEY="..."`) to keep
a literal `#`. An empty `KEY=` is ignored.

This file is **yours**: First Tree reads it on daemon start and never rewrites
it. Edit or delete it any time and restart to apply.

> Upgrade note: earlier versions baked your proxy into the service unit at
> install time, which could go stale and silently freeze. Upgrading migrates any
> such baked proxy into `daemon.env` once; after that the file is yours.

## Proxy types — what works

`daemon.env` covers the common case: tools that read the standard proxy env
vars (`HTTP(S)_PROXY`, `ALL_PROXY`, `NO_PROXY`). Notes for other setups:

- **HTTP / HTTPS proxy** (Clash / mihomo / Surge / V2Ray "mixed" or HTTP port):
  fully supported — put the URL in `daemon.env` and set
  `NODE_USE_ENV_PROXY=1`. That one switch covers HTTP (`fetch`) and the
  WebSocket upgrade alike; `NODE_USE_ENV_PROXY` alone does not, because `ws`
  opens its own socket and reads no proxy env by itself.
- **SOCKS-only** (`ALL_PROXY=socks5://…`): `git` / `curl` honor it, but the
  Claude CLI's HTTP stack does not speak SOCKS — prefer exposing your proxy's
  **HTTP / mixed** port and using that in `daemon.env`.
- **TUN / transparent / "enhanced" mode**: traffic is captured at the network
  layer with no env vars. If the daemon still can't reach out, the tunnel isn't
  capturing the daemon's process — fix that in your proxy app; First Tree has
  nothing to configure here.
- **System / PAC proxy** (set in macOS Network settings): CLI tools do not read
  the system proxy. Put an explicit `HTTP(S)_PROXY` in `daemon.env`.

## Confirm

From a shell that has your proxy, a direct request is blocked but a proxied one
reaches Anthropic (401 = reached, just unauthenticated — which is expected for a
bare request):

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://api.anthropic.com/v1/messages            # 403 (blocked)
curl -sS -o /dev/null -w '%{http_code}\n' -x http://127.0.0.1:7897 https://api.anthropic.com/v1/messages  # 401 (reached)
```

If the proxied request reaches Anthropic but agents still fail after setting
`daemon.env` and restarting, the cause is more likely your Anthropic plan /
region entitlement or genuine auth — re-check those in that order.
