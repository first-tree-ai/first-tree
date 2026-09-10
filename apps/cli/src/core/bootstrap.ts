import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clientConfigSchema, defaultConfigDir, resolveConfigReadonly } from "@first-tree/shared/config";
import { channelConfig } from "./channel.js";
import { cliFetch } from "./cli-fetch.js";

// Function rather than top-level const: a `const = join(defaultConfigDir(), …)`
// would lock at module load — same bundle eval-order foot-gun that
// motivated function-izing the resolver. See `channel-env.ts` history note.
function credentialsPath(): string {
  return join(defaultConfigDir(), "credentials.json");
}

export class ServerUrlNotConfiguredError extends Error {
  constructor() {
    super(
      "Server URL not configured.\n" +
        "  Provide via: --server <url>, FIRST_TREE_SERVER_URL env var, or\n" +
        `  ${channelConfig.binName} config set server.url <url>`,
    );
    this.name = "ServerUrlNotConfiguredError";
  }
}

type StoredCredentials = {
  accessToken: string;
  refreshToken: string;
  serverUrl: string;
};

/**
 * Resolve First Tree server URL from flag, env, or config.
 *
 * Uses resolveConfigReadonly (not the singleton getClientConfig) so CLI entry
 * points don't have to remember to call initConfig() first.
 */
export function resolveServerUrl(flagValue?: string): string {
  if (flagValue) return flagValue;
  if (process.env.FIRST_TREE_SERVER_URL) return process.env.FIRST_TREE_SERVER_URL;

  const config = resolveConfigReadonly({ schema: clientConfigSchema, role: "client" });
  const server = config.server;
  if (server !== null && typeof server === "object") {
    const url = Reflect.get(server, "url");
    if (typeof url === "string" && url.length > 0) return url;
  }

  throw new ServerUrlNotConfiguredError();
}

/**
 * Resolve the current member access JWT from persisted credentials.
 *
 * Unified-user-token milestone: the CLI has a single credential store and a
 * single onboarding path (`<bin> login <code>`). Callers without
 * a credentials.json get a clear error pointing at `login <code>`.
 */
export function resolveAccessToken(): string {
  const creds = loadCredentials();
  if (!creds) {
    throw new Error(`No credentials found. Run \`${channelConfig.binName} login <code>\` to sign in.`);
  }
  return creds.accessToken;
}

/**
 * Thrown when `/auth/refresh` returns 401 — i.e. the persisted refresh
 * token has expired or been revoked, so no amount of retrying will get
 * us back online without operator action. Callers (the WS reconnect
 * loop in particular) catch this distinctly from generic network/HTTP
 * errors so they can stop the 1Hz reconnect-and-fail thrash and ask
 * systemd/launchd to back off.
 */
export class AuthRefreshFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthRefreshFailedError";
  }
}

/**
 * Thrown when `/auth/refresh` returns 429. Carries the server-suggested
 * retry-after (or a sane default) so the WS reconnect loop can wait at
 * least that long instead of pounding the limiter inside the same window
 * with its default 1/2/4/8s exponential backoff — which would just keep
 * the rate-limit bucket full and stretch the outage. Defaults to 30s when
 * the server omits the header.
 */
export class AuthRefreshRateLimitedError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number, message?: string) {
    super(message ?? `Refresh request rate-limited; retry after ${Math.round(retryAfterMs / 1000)}s.`);
    this.name = "AuthRefreshRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

class AuthRefreshHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number) {
    super(`Refresh request failed with status ${statusCode}.`);
    this.name = "AuthRefreshHttpError";
    this.statusCode = statusCode;
  }
}

/**
 * Parse an HTTP `Retry-After` header. Accepts either an integer seconds
 * value (the form fastify-rate-limit emits) or an RFC 7231 HTTP-date.
 * Returns ms, or `null` when the header is absent / malformed.
 */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

/**
 * In-flight refresh operation. Multiple callers (WS handshake, proactive
 * refresh timer, every SDK request) can see an expired token within the same
 * millisecond — without dedupe each would fire an independent `/auth/refresh`
 * round-trip and race to write `credentials.json`. Share one in-flight
 * request so N concurrent callers resolve from a single HTTP call.
 *
 * The flight carries its credential snapshot: callers only join when their
 * resolved authority (home + server URL + refresh token) AND access-token
 * snapshot match. A re-login that lands while an old refresh is still
 * pending — even one that keeps the same refresh token and only rewrites
 * the access token — gets its own flight immediately, and the old flight
 * settles fenced-off in the background — it can never clear or poison the
 * new one (every slot handoff compares object identity, never recency).
 *
 * Each caller can still carry its own deadline. The underlying request is
 * aborted once every waiter has abandoned it; one short-lived caller never
 * aborts a refresh that another live caller still needs.
 */
type InflightRefresh = {
  authority: CredentialAuthority;
  /** Access-token snapshot from when the flight started (late-write fencing). */
  accessTokenSnapshot: string;
  controller: AbortController;
  promise: Promise<string>;
  settled: boolean;
  waiters: number;
};

let inflightRefresh: InflightRefresh | null = null;

/**
 * Thrown when a refresh settles after its credential authority was replaced
 * (re-login, logout, home switch) while the request was in flight.
 * Deliberately NOT an {@link AuthRefreshFailedError}: the outcome belongs to
 * the dead authority and must never trigger the terminal fail-stop paths
 * (e.g. the WS reconnect pause) that a real 401 on the CURRENT credentials
 * causes. Callers classify it like any transient error and retry against
 * the new credentials normally.
 */
export class AuthRefreshSupersededError extends Error {
  constructor(message?: string) {
    super(message ?? "Credentials changed while a token refresh was in flight; retry with the new credentials.");
    this.name = "AuthRefreshSupersededError";
  }
}

/**
 * Credential authority identity for the refresh flight/latch below: the
 * resolved credentials file path (FIRST_TREE_HOME-derived) plus server URL
 * plus the refresh token. Two homes holding byte-identical credentials are
 * still distinct authorities, so a terminal failure in one can never
 * suppress the other.
 */
type CredentialAuthority = {
  credentialsPath: string;
  serverUrl: string;
  refreshToken: string;
};

function authorityFor(creds: StoredCredentials): CredentialAuthority {
  return { credentialsPath: credentialsPath(), serverUrl: creds.serverUrl, refreshToken: creds.refreshToken };
}

function sameAuthority(a: CredentialAuthority, b: CredentialAuthority): boolean {
  return a.credentialsPath === b.credentialsPath && a.serverUrl === b.serverUrl && a.refreshToken === b.refreshToken;
}

/**
 * Terminal 401 latch. A 401 from `/auth/refresh` means the refresh token is
 * expired or revoked — retrying the same credential authority can never
 * succeed, yet every caller (WS reconnect loop, SDK requests, proactive
 * refresh) used to fire its own doomed HTTP round-trip (synthetic reproduction:
 * 20 sequential callers -> 20 refreshes). After the first 401 we latch the
 * failure and rethrow it without touching the network.
 *
 * Keyed to the full credential authority (home + server URL + refresh
 * token): a re-login — or a home switch — never matches the latched entry,
 * so recovery with new credentials is immediate. Bounded state: a single
 * entry, replaced by each new terminal failure; an entry whose authority
 * was superseded simply never matches again (it is never cleared by
 * mismatched lookups, so an old authority's completion cannot poison the
 * new authority's latch either). Never logged — it identifies credential
 * material.
 */
let terminalRefreshFailure: { authority: CredentialAuthority; message: string } | null = null;

function latchedRefreshFailure(authority: CredentialAuthority): AuthRefreshFailedError | null {
  if (!terminalRefreshFailure || !sameAuthority(terminalRefreshFailure.authority, authority)) return null;
  return new AuthRefreshFailedError(terminalRefreshFailure.message);
}

function latchTerminalRefreshFailure(authority: CredentialAuthority, message: string): void {
  terminalRefreshFailure = { authority, message };
}

/**
 * Fencing for late completions: the credentials file may have been replaced
 * (re-login, logout, home switch — or a concurrent login/refresh that
 * already persisted a newer access token for the same refresh authority)
 * while this request was in flight. Compares the full authority plus the
 * access-token snapshot taken when the request started; any drift means the
 * in-flight result is obsolete and must neither be persisted nor allowed to
 * latch/return anything terminal.
 */
function authorityFence(request: { authority: CredentialAuthority; accessTokenSnapshot: string }): boolean {
  const current = loadCredentials();
  if (!current) return true;
  return (
    credentialsPath() !== request.authority.credentialsPath ||
    current.serverUrl !== request.authority.serverUrl ||
    current.refreshToken !== request.authority.refreshToken ||
    current.accessToken !== request.accessTokenSnapshot
  );
}

/** Default freshness window for HTTP callers: refresh if token expires within 30s. */
const DEFAULT_MIN_VALIDITY_MS = 30_000;

/**
 * Ensure the persisted access token is fresh. Call before any API request
 * when using persisted credentials. Returns the (possibly refreshed) access
 * token. Service-user API keys are out of scope for this milestone.
 *
 * `opts.minValidityMs` raises the freshness bar — refresh when the cached
 * token has less than that much life left. The WS proactive-refresh path
 * passes a value that overlaps its lead window so it never receives a
 * token already inside the "about to expire" zone.
 *
 * Sliding-window note: the server now rotates the refresh token on every
 * successful `/auth/refresh`. We persist the rotated token alongside the
 * new access token so an actively-used client never hits the absolute
 * `refreshTokenExpiry` ceiling. If the response omits `refreshToken`
 * (i.e. an older server) we keep the existing one — the cost is just
 * losing the sliding behaviour against that backend, not a correctness
 * regression.
 */
export async function ensureFreshAccessToken(opts?: { minValidityMs?: number; signal?: AbortSignal }): Promise<string> {
  opts?.signal?.throwIfAborted();
  const minValidityMs = opts?.minValidityMs ?? DEFAULT_MIN_VALIDITY_MS;
  const creds = loadCredentials();
  if (!creds) {
    throw new Error(`No credentials found. Run \`${channelConfig.binName} login <code>\` to sign in.`);
  }

  if (!isTokenStale(creds.accessToken, minValidityMs)) {
    opts?.signal?.throwIfAborted();
    return creds.accessToken;
  }

  // A previous refresh with this exact credential authority already got a
  // terminal 401: fail fast instead of adding another doomed HTTP call.
  const authority = authorityFor(creds);
  const latched = latchedRefreshFailure(authority);
  if (latched) throw latched;

  // Join the active flight only when it carries the exact same credential
  // snapshot (authority + access token). A re-login that lands while an old
  // refresh is still pending — even one that keeps the same refresh token
  // and only rewrites the access token — starts its own flight immediately
  // instead of inheriting the superseded flight's outcome.
  if (
    !inflightRefresh ||
    inflightRefresh.settled ||
    !sameAuthority(inflightRefresh.authority, authority) ||
    inflightRefresh.accessTokenSnapshot !== creds.accessToken
  ) {
    inflightRefresh = startRefresh(creds, authority);
  }
  return waitForRefresh(inflightRefresh, opts?.signal);
}

function startRefresh(creds: StoredCredentials, authority: CredentialAuthority): InflightRefresh {
  const controller = new AbortController();
  const refresh: InflightRefresh = {
    authority,
    accessTokenSnapshot: creds.accessToken,
    controller,
    promise: Promise.resolve(""),
    settled: false,
    waiters: 0,
  };

  refresh.promise = performRefresh(creds, authority, controller.signal).finally(() => {
    refresh.settled = true;
    if (inflightRefresh === refresh) {
      inflightRefresh = null;
    }
  });
  return refresh;
}

async function performRefresh(
  creds: StoredCredentials,
  authority: CredentialAuthority,
  cancellation: AbortSignal,
): Promise<string> {
  const signal = AbortSignal.any([cancellation, AbortSignal.timeout(10_000)]);
  const res = await cliFetch(`${creds.serverUrl}/api/v1/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: creds.refreshToken }),
    signal,
  });

  // A caller abort (or the internal 10s timeout) must never latch a 401 or
  // save a 200 — even when the transport or a slow body ignores the abort.
  signal.throwIfAborted();

  if (res.status === 401) {
    const message =
      `Refresh token rejected by server. Re-run \`${channelConfig.binName} login <code>\` ` +
      "(get a fresh token from the Web Computers page → New Connection).";
    // Fence BEFORE latching or returning anything terminal: if the authority
    // was replaced while this request was in flight, the 401 belongs to dead
    // credentials and must not pause the new login.
    if (authorityFence({ authority, accessTokenSnapshot: creds.accessToken })) {
      throw new AuthRefreshSupersededError();
    }
    // Terminal for this exact credential authority: subsequent callers fail
    // fast without hitting the network until the credentials change.
    latchTerminalRefreshFailure(authority, message);
    throw new AuthRefreshFailedError(message);
  }
  if (res.status === 429) {
    const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after")) ?? 30_000;
    throw new AuthRefreshRateLimitedError(retryAfterMs);
  }
  if (!res.ok) {
    throw new AuthRefreshHttpError(res.status);
  }

  const data = (await res.json()) as { accessToken: string; refreshToken?: string };
  // Same cancellation fence on the success path, before any side effect.
  signal.throwIfAborted();
  if (authorityFence({ authority, accessTokenSnapshot: creds.accessToken })) {
    // The credential snapshot changed (re-login / logout / home switch)
    // while this request was in flight. The replacement may belong to a
    // DIFFERENT user, and this caller may carry the old user's agent ids /
    // request context — credentials from another authority are never handed
    // to the old caller. Fail non-terminally; a new caller independently
    // reads the new credentials. No nested refresh is started here.
    throw new AuthRefreshSupersededError();
  }
  saveCredentials({
    ...creds,
    accessToken: data.accessToken,
    // Older servers won't echo a rotated refreshToken back — keep the existing one.
    refreshToken: data.refreshToken ?? creds.refreshToken,
  });
  return data.accessToken;
}

async function waitForRefresh(refresh: InflightRefresh, signal: AbortSignal | undefined): Promise<string> {
  refresh.waiters++;
  try {
    if (!signal) return await refresh.promise;
    signal.throwIfAborted();
    return await waitForPromiseWithSignal(refresh.promise, signal);
  } finally {
    refresh.waiters--;
    if (signal?.aborted && refresh.waiters === 0 && !refresh.settled) {
      if (inflightRefresh === refresh) {
        inflightRefresh = null;
      }
      refresh.controller.abort(signal.reason);
    }
  }
}

function waitForPromiseWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => {
      finish(() => reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        finish(() => resolve(value));
      },
      (error: unknown) => {
        finish(() => reject(error));
      },
    );
    if (signal.aborted) onAbort();
  });
}

/** Back-compat alias retained so existing call sites keep compiling. */
export const ensureFreshAdminToken = ensureFreshAccessToken;

function isTokenStale(token: string, minValidityMs: number): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return true;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as { exp?: number };
    if (!payload.exp) return false;
    return payload.exp * 1000 < Date.now() + minValidityMs;
  } catch {
    return true;
  }
}

/**
 * Persist credentials to disk atomically.
 *
 * Plain `writeFileSync` opens with `O_TRUNC` then writes — between those
 * calls the file is empty, and a concurrent `loadCredentials()` (e.g. a
 * background daemon refreshing while the user runs a foreground CLI command)
 * reads "" → `JSON.parse` throws → we fall back to "no credentials" and
 * surface a misleading "run `login <code>` again" error. write-to-temp +
 * rename gives readers an all-or-nothing view: they see the old file or the
 * new file, never a half-written one. Server-side the sliding-window design
 * already accepts last-writer-wins semantics for the refresh token itself
 * (see auth service comment), so atomicity at the file level is enough.
 */
export function saveCredentials(creds: StoredCredentials): void {
  const dir = dirname(credentialsPath());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${credentialsPath()}.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
    renameSync(tmp, credentialsPath());
  } catch (err) {
    // Best-effort cleanup so a failed write doesn't leave behind orphan
    // temp files. Swallow the unlink error — the original failure is what
    // the caller cares about.
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Load persisted credentials saved by the `connect` command.
 */
export function loadCredentials(): StoredCredentials | null {
  try {
    const raw = JSON.parse(readFileSync(credentialsPath(), "utf-8")) as unknown;
    const data = raw as StoredCredentials;
    if (data.accessToken && data.refreshToken && data.serverUrl) return data;
    return null;
  } catch {
    return null;
  }
}

/**
 * Write agent config (agentId + runtime) to disk.
 */
export function saveAgentConfig(agentName: string, agentId: string, runtime: string): string {
  const agentDir = join(defaultConfigDir(), "agents", agentName);
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(agentDir, "agent.yaml"), `agentId: "${agentId}"\nruntime: ${runtime}\n`, { mode: 0o600 });
  return agentDir;
}

/** Mask a JWT/token for display: show first 6 + last 2 chars. */
export function maskToken(token: string): string {
  return token.length > 8 ? `${token.slice(0, 6)}***${token.slice(-2)}` : "***";
}
