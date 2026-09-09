# Adding a runtime provider

One-page contract for extending the known provider set. Keep Handler V1 and
generic lifecycle ownership unchanged — do not invent Handler V2 or move
ACK / Reset / auth / model / persistence protocol into shared catalog.

## Ownership model

**Single known-provider identity + composition-owned exhaustive projections.**

| Layer | Owns |
| --- | --- |
| Zod `runtimeProviderSchema` | Wire IDs → `RuntimeProvider` / `RUNTIME_PROVIDER_IDS` / generated `RUNTIME_PROVIDERS.*` |
| Shared `RUNTIME_PROVIDER_CATALOG` | Labels, display order, creation-time preference prefix, install/login, auth-owner copy |
| `createBuiltinHandlerRegistry` | Frozen `Record<RuntimeProvider, HandlerFactory>` — CLI holds/consumes once per `ClientRuntime` |
| `BUILTIN_PROVIDER_PROBES` | Frozen install-only capability probes |
| `PROVIDER_SKILL_ROOTS` | Frozen native managed-skill roots |
| `RUNTIME_AUTH_DRIVERS` | Frozen `Record<RuntimeAuthProvider, RuntimeAuthDriver>` for in-product login |

Probe/skills paths do **not** consume a full installed handler registry.

`probeCapabilities()` starts enabled probes concurrently, but publishes the
snapshot in `RUNTIME_PROVIDER_IDS` order after all probes settle. Do not write
entries from probe-completion callbacks: agent-creation surfaces intentionally
preserve the Client snapshot order after the Codex / Claude preference prefix.

## 1. Identity

1. Add the wire id to `runtimeProviderSchema` only.
2. Types, `RUNTIME_PROVIDER_IDS`, and `RUNTIME_PROVIDERS` (kebab → `UPPER_SNAKE`) derive from that schema — no parallel handwritten value lists.
3. Narrow unknown strings with `asRuntimeProvider` / `runtimeProviderLabel`.

## 2. Shared catalog (pure data)

Add an exhaustive catalog entry:

- `label` and unique `displayOrder`
- nullable `selectionPriority`: use a unique number only for an explicit
  creation-time preference (Codex then Claude Code today); use `null` to keep
  the selected Client's reported order after that prefix
- `install`: `{ kind: "npm", package, args }` (`args` required, use `[]` when none) or `{ kind: "script", command }`
- `loginSteps`: one shell step, or two for interactive (`kimi` + `/login`)
- `authOwnerLabel` for chat auth-recovery

Helpers derive install/login/chat phrases. Share version constants with
capability gates — do not reverse-parse package strings.

**Auth recovery (`authRecovery`):**
- `{ kind: "host" }` — provider-owned CLI / interactive login may appear on
  computer and setup-incomplete surfaces (Amp / Antigravity / DeepSeek / Kimi /
  OpenCode / Pi today).
- `{ kind: "in-product", target }` — browser-OAuth / Connect from a failing
  chat, with `target` typed by the narrower server-accepted
  `RuntimeAuthProvider` contract. Computer and setup cards stay
  **install-only** (no terminal login copy). Claude Code CLI maps to the shared
  Claude Code target; every direct target maps to itself. Adding in-product
  OAuth requires extending the runtime-auth contract and its exact-target tests.

## 2a. Runtime-auth driver (in-product login only)

Only an `{ kind: "in-product", target }` provider gets a driver, and the target
set is `runtimeAuthProviderSchema` — narrower than `runtimeProviderSchema`.
Host-login providers (Amp / Antigravity / DeepSeek / Kimi / OpenCode / Pi) never appear here, and
`claude-code-tui` is not its own target because it shares Claude Code's
keychain credential.

| Layer | Owns | Where |
| --- | --- | --- |
| Daemon dispatcher | Announce, `pendingAuth`, `authUrl`, re-probe order, `lastAuthError`, redaction + truncation | `apps/cli/src/core/runtime-auth-login.ts` |
| `RUNTIME_AUTH_DRIVERS` | Frozen projection of `RuntimeAuthProvider` → driver | `providers/auth-drivers.ts` |
| `create<Provider>AuthDriver` | Resolve the artifact, spawn the official login, re-probe affected rows | provider family `login.ts` (Claude: `providers/claude/login.ts`, Codex: `providers/codex/login.ts`, Cursor: `providers/cursor/login.ts`, Grok: `providers/grok/login.ts`); all four in-product OAuth owners live in their families |

The dispatcher must stay provider-neutral: no provider literal, no
provider-specific resolver / probe / login import, no `if` / `switch` on a
provider id. A driver contributes only `logLabel` / `loginLabel` /
`artifactLabel` copy plus `resolveLogin()` and `reprobe()`; it never publishes a
capability entry, and it never owns retry, ordering, or error policy.

Because the dispatcher owns ordering, a driver may resolve slowly, print its
sign-in URL at any moment, or throw: entry writes are chained so the URL always
lands before the terminal re-probe, and a thrown resolver or login is contained
and reflected the same way a reported failure is.

`reprobe()` returns rows in publish order and may return more than one when
providers share a credential (a Claude login refreshes both Claude rows while
the TUI is enabled, and neither probes nor writes the TUI row while it is
centrally disabled). Only the row matching the login target carries
`lastAuthError`.

Adding an in-product provider therefore means: extend
`runtimeAuthProviderSchema`, add a `create<Provider>AuthDriver` in that
provider's own login module, and register it in `RUNTIME_AUTH_DRIVERS` — the
`satisfies Record<RuntimeAuthProvider, RuntimeAuthDriver>` will not compile
until you do. Inject a driver (or a whole table) for tests; there is no
process-global mutable registry to install into. Every `create<Provider>AuthDriver`
returns an `Object.freeze`d driver, and the `RuntimeAuthDriver` contract
declares `resolveLogin` / `reprobe` as `readonly` properties (not TS method
shorthand, which is not readonly) — so an importer of `RUNTIME_AUTH_DRIVERS`
cannot repoint a driver's methods for the rest of the process, and the
guarantee holds even for a driver constructed outside the table.

**Login output is bounded.** A browser login may stream for the whole
five-minute window, so the subprocess retains no full output buffer: the
fallback sign-in URL comes from an incremental scanner whose only carried state
is the current partial token, and stderr keeps a bounded tail. `runLoginSubprocess`
feeds both stdout and stderr to the same scanner, so a URL candidate can come
from either stream. Because `pendingAuth.authUrl` is a structured field that
never passes through `redactErrorPreview` itself (see below), URL candidacy is
itself a no-secret boundary: `hasCredentialShape` rejects a candidate the
moment `redactErrorPreview` would change it — URL userinfo, a vendor-prefixed
token shape under any key (or inside a URL fragment), an Authorization/Bearer
shape, or a credential-named key=value pair — rather than re-checking a
narrower subset of those rules that could fall behind. Rejection never
rewrites the URL (an OAuth query string is part of the provider's protocol),
and scanning continues to a later, legitimate URL in the same output.

Every error/failure string the dispatcher republishes — `CapabilityEntry.error`
and `lastAuthError.message`, and nothing else — passes through
`redactErrorPreview` under a hard ceiling that counts the helper's truncation
ellipsis. That covers the login's own verdict and the `error` of *each* row a
`reprobe()` returns, including the extra rows of a shared-credential driver,
whose detection text comes from the same hosts and subprocesses. Structured
fields such as `pendingAuth.authUrl` or the detected version are not error text
and are not redacted.
Starting a login also drops the previous attempt's `error` and `lastAuthError`
instead of carrying them onto the pending entry, so nothing escapes the
boundary by riding an older snapshot. Do not put that ceiling on the shared
wire schema — a `.max()` there breaks rolling daemon/server compatibility.

## 3. Handler V1 contract

Each factory must provide `start` / `resume` / `inject` / `suspend` /
`shutdown`. The adapter only translates provider protocol ↔ First Tree
events. Session lifecycle, ACK / recovery / retry, Reset, and persistence
belong to the generic runtime — adapters must not re-implement them.

## 4. Runtime config

Extend the Zod discriminated runtime payload / defaults first. Supported
fields pass through unchanged; unsupported fields fail explicitly. Silent
fallback to another provider or default config is forbidden.

## 5. Probe + skill root

- **Probe:** installation / artifact / platform only. Reuse the runtime binary
  resolver. Must be async. Must not launch the provider, open network auth,
  or read credentials.
- **Skill root:** only the fixed safe projection in `PROVIDER_SKILL_ROOTS`.
  Prompt / skills / MCP / auth / model provider-specific projection stays in
  adapter-owned modules.

## 6. Client composition checklist

1. Handler factory in `createBuiltinHandlerRegistry`.
2. Install probe in `BUILTIN_PROVIDER_PROBES`.
3. Skill root in `PROVIDER_SKILL_ROOTS`.
4. Auth driver in `RUNTIME_AUTH_DRIVERS` — only for an in-product OAuth target.
5. Binary remediation may re-export catalog install/login helpers; adapter
   protocol keywords stay local.

## 7. Minimum test gates

- Identity / catalog / composition projections exhaustive (and frozen).
- Unique `displayOrder` + unique non-null preference priorities; unprioritized
  providers preserve the selected Client's reported order.
- Handler lifecycle methods present for every known id.
- Probe isolation (no launch / auth / credential read).
- Managed-skill root safety (fixed projection only).
- Final UI copy / order (catalog helpers → rendered install/login + dialog order).
- Architecture guard tokens from `RUNTIME_PROVIDER_IDS`.
- QA case for the provider when coordinator publishes a candidate SHA.

## Out of scope

- Handler V2 / SessionRuntime split
- ACK / retry / Reset / persistence redesign
- Moving adapter protocol / SDK taxonomy into shared catalog
