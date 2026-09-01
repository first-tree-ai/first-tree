import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { hostname as getHostname, platform } from "node:os";
import {
  type AgentBindRejectReason,
  type AgentPinnedMessage,
  type AuthRejectedCode,
  agentPinnedMessageSchema,
  authExpiredFrameSchema,
  authRejectedFrameSchema,
  authRetryableFrameSchema,
  type ClientPausedReason,
  type InboxDeliverFrame,
  inboxAckAcceptedFrameSchema,
  inboxAckRejectedFrameSchema,
  inboxDeliverFrameSchema,
  inboxFenceProbeAcceptedFrameSchema,
  inboxFenceProbeRejectedFrameSchema,
  inboxRecoverAcceptedFrameSchema,
  inboxRecoverRejectedFrameSchema,
  PROVIDER_MODELS_LIST_TYPE,
  PROVIDER_MODELS_RESULT_TYPE,
  type ProviderModelCatalog,
  providerModelsListCommandSchema,
  RUNTIME_AUTH_START_TYPE,
  type RuntimeAuthMethod,
  type RuntimeAuthProvider,
  type RuntimeProvider,
  type RuntimeState,
  runtimeAuthStartCommandSchema,
  type ServerWelcomeFrame,
  type SessionCommandAbortedFrame,
  type SessionCommandFinalizedFrame,
  type SessionEvent,
  type SessionRuntimeReport,
  type SessionState,
  serverWelcomeFrameSchema,
  sessionCommandAbortedFrameSchema,
  sessionCommandFinalizedFrameSchema,
  sessionEventAcceptedFrameSchema,
  sessionEventRejectedFrameSchema,
  type UpdateAttempt,
} from "@first-tree/shared";
import WebSocket from "ws";
import { createLogger, type pino } from "../cloud/observability/logger.js";
import { type AccessTokenProvider, FirstTreeHubSDK, type RuntimeSessionTokenProvider } from "../cloud/sdk.js";
import { classify, ERROR_KINDS, nextRetryDelayMs } from "./error-taxonomy.js";

/**
 * Per-agent bind retry bookkeeping (Bug 5). A failed `agent:bind` no longer
 * retries on every reconnect; instead each agent gets its own
 * exponential-backoff window and degraded reasons (org_mismatch,
 * unknown_agent) flip to permanent skip.
 */
type BindRetryRecord = {
  attempts: number;
  nextAllowedAt: number;
  lastReason: string | null;
};

type PendingInboxAck = {
  entryId: number;
  agentId?: string;
  ref: string;
  attempts: number;
  firstSentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
};

type PendingInboxRecover = {
  agentId: string;
  chatId: string;
  ref: string;
  firstSentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  promise: Promise<InboxRecoverResult>;
  resolve: (result: InboxRecoverResult) => void;
  reject: (err: Error) => void;
};

type PendingInboxFenceProbe = {
  agentId: string;
  chatId: string;
  ref: string;
  firstSentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  promise: Promise<InboxFenceProbeResult>;
  resolve: (result: InboxFenceProbeResult) => void;
  reject: (err: Error) => void;
};

/** Result of a fence settlement probe: the probed ids proven settled server-side. */
export type InboxFenceProbeResult = {
  settledMessageIds: string[];
};

/**
 * Result of an accepted inbox recovery. `resetCount` only covers rows the
 * reset moved out of `delivered`; `unackedOutstanding` is the server's
 * authoritative pending+delivered backlog for the chat scope. Only
 * `unackedOutstanding === 0` or an explicit id list may prove settlement;
 * older servers omit them, and absence must be treated as unknown, never as
 * zero/empty.
 */
export type InboxRecoverResult = {
  resetCount: number;
  unackedOutstanding?: number;
};

type PendingSessionEvent = {
  agentId: string;
  chatId: string;
  ref: string;
  firstSentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: Error) => void;
};

export type ClientConnectionConfig = {
  serverUrl: string;
  /** Stable per-machine client identifier. Generated if omitted. */
  clientId?: string;
  sdkVersion?: string;
  /**
   * Returns the current member access JWT. Called before the WS handshake
   * and before each bind so short-lived tokens refresh transparently. When
   * the server sends `auth:expired` the connection re-invokes this provider
   * after reconnecting.
   */
  getAccessToken: AccessTokenProvider;
  /**
   * Optional `User-Agent` string forwarded to every per-agent SDK created by
   * `agent:bound`. Distinct from `sdkVersion` (which is the value advertised
   * to the server in `client:register`); this one only decorates outbound
   * HTTP traffic so trace backends can identify the install. See SdkConfig.userAgent.
   */
  userAgent?: string;
  /**
   * Optional accessor for the most recent self-update outcome — the
   * command layer reads `$FIRST_TREE_HOME/state/update-state.json` and
   * returns the parsed record. The connection forwards it on every
   * `client:register` so the server can persist into
   * `clients.metadata.lastUpdateAttempt`, giving the admin dashboard
   * visibility into clients that are failing to auto-update without
   * needing SSH access. Sync (the underlying read is a single small JSON
   * file) so the register frame can be built inline. The runtime
   * gracefully tolerates omission — clients without the update-state
   * wiring don't supply this, and the server's `clientRegisterSchema`
   * keeps the field optional.
   */
  getLastUpdateAttempt?: () => UpdateAttempt | null;
  /**
   * Override the heartbeat tick interval (default 30s). Lower values are
   * primarily useful in tests that need to exercise the silence watchdog or
   * proactive-refresh paths in sub-second budgets.
   */
  heartbeatIntervalMs?: number;
  /**
   * Override the silence watchdog timeout (default 90s — ~3 heartbeat ticks).
   * Surfaces wedged sockets (OS-suspend resume, silent network drops) that
   * leave readyState=OPEN but no bytes flowing. Test-friendly hook; the
   * production default already handles real-world drops fine.
   */
  heartbeatTimeoutMs?: number;
};

export type BoundAgent = {
  agentId: string;
  /**
   * Always populated post-Phase 2 of the agent-naming refactor — the
   * `agent:pinned` WebSocket frame resolves the label server-side.
   */
  displayName: string;
  agentType: string;
  /** Ephemeral token returned by the current successful WS `agent:bind`. */
  runtimeSessionToken?: string;
  sdk: FirstTreeHubSDK;
};

export type SessionCommand = {
  type: "session:suspend" | "session:resume" | "session:terminate";
  agentId: string;
  chatId: string;
  /**
   * Present only when the server waits for an apply-acknowledgement (the
   * chat-session Reset path). The handler must answer with a
   * `session:command:applied` frame once the command has fully taken local
   * effect — never earlier.
   */
  ref?: string;
};

export type SessionReconcileResult = {
  agentId: string;
  staleChatIds: string[];
};

/**
 * Server→client command to begin an in-product runtime-auth login (connect a
 * provider's credentials on this host without a separate CLI install). The
 * daemon runs the provider's official login and surfaces progress by
 * re-PATCHing capabilities. See `runtimeAuthStartCommandSchema` in shared.
 */
export type RuntimeAuthCommand = {
  /**
   * Narrower than `RuntimeProvider`: only the server-accepted in-product auth
   * targets can start a login. The wire shape is unchanged - this is the same
   * set `runtimeAuthStartCommandSchema` already parses, now visible in the
   * type so the daemon dispatches by a key that cannot be a host-login-only
   * provider.
   */
  provider: RuntimeAuthProvider;
  method?: RuntimeAuthMethod;
  ref: string;
};

/** Server→client command to discover host-local provider models. */
export type ProviderModelsListCommand = {
  provider: RuntimeProvider;
  ref: string;
};

/**
 * Welcome frame received after `auth:ok`. `isReconnect` is true for every
 * occurrence after the first welcome in the lifetime of this `ClientConnection`
 * — lets consumers (UpdateManager) distinguish a cold-start install from a
 * reconnect into a newer Server.
 */
export type ServerWelcome = {
  frame: ServerWelcomeFrame;
  isReconnect: boolean;
};

type ClientConnectionEvents = {
  connected: [];
  disconnected: [];
  reconnecting: [attempt: number];
  reconnected: [];
  error: [error: Error];
  "agent:bound": [agent: BoundAgent];
  "agent:unbound": [agentId: string, reason?: string];
  /**
   * Server pushed a fully-assembled inbox entry over the WS data plane.
   * First arg is `frame.inboxId` (not agentId). ACK is deferred until the
   * handler turn closes inside SessionRuntime — do not ACK from this listener
   * merely because the frame reached the session manager / early buffer.
   */
  "inbox:deliver": [inboxId: string, frame: InboxDeliverFrame];
  "agent:bind:rejected": [reason: AgentBindRejectReason, agentId: string];
  /**
   * Server announced that an agent has been pinned to this client (either
   * created with `clientId` or bound via PATCH NULL → ID). Consumers can use
   * this to auto-register the agent locally without a manual
   * `agent add`.
   */
  "agent:pinned": [message: AgentPinnedMessage];
  "session:command": [command: SessionCommand];
  /**
   * Success-side post-apply Reset disposition: server confirmed durable
   * eviction after `session:command:applied` — `finalizeTerminatedSession`
   * committed `evicted`. Parked Reset-fence recovery may release after this
   * frame or the matching `session:command:aborted` disposition for the same
   * generation; neither waits on the other.
   */
  "session:command:finalized": [frame: SessionCommandFinalizedFrame];
  /**
   * Server gave up on a Reset it had already accepted `session:command:applied`
   * for: the eviction never committed (the session re-activated, the route was
   * refused, or the cleanup transaction rolled back). The armed generation must
   * still be released — the local provider session is gone either way — so this
   * frame lifts exactly that generation's fence and is receipted like
   * `session:command:finalized`.
   */
  "session:command:aborted": [frame: SessionCommandAbortedFrame];
  "runtime-auth:start": [command: RuntimeAuthCommand];
  "provider-models:list": [command: ProviderModelsListCommand];
  "session:reconcile:result": [result: SessionReconcileResult];
  "auth:expired": [];
  /**
   * Unrecoverable auth failure — the credential provider rejected with an
   * `AuthRefreshFailedError` (refresh token expired/revoked). The connection
   * has stopped trying to reconnect; the consumer should surface a recovery
   * prompt to the operator (re-run `<binName> login <code>`) and
   * usually exit so a supervisor can back off instead of looping at 1 Hz.
   *
   * Bug 2 fix (client-resilience design §5.2): consumers should NO LONGER
   * exit the process on this event — they should listen for `auth:paused`
   * instead and pause work, then resume when fresh credentials arrive. The
   * `auth:fatal` channel is kept for backward compatibility and emitted in
   * tandem with `auth:paused` for the same root cause.
   */
  "auth:fatal": [error: Error];
  /**
   * The connection has entered paused mode — refresh credentials cannot
   * recover the current session and we are deliberately not retrying.
   * Reconnect attempts are suspended until {@link ClientConnection.clearPaused}
   * is called (typically by a credentials-file watcher that detects a fresh
   * channel-aware login). The WebSocket may be closed at the time of emit;
   * the connection still answers `isConnected === false` and `isPaused
   * === true`.
   */
  "auth:paused": [reason: ClientPausedReason, error: Error];
  /**
   * Mirror of {@link "auth:paused"} — emitted when paused mode is cleared
   * (credentials refreshed). Consumers can use this to log resumption or
   * re-enable slot processing UIs.
   */
  "auth:resumed": [previousReason: ClientPausedReason];
  "server:welcome": [welcome: ServerWelcome];
  // -----------------------------------------------------------------------
  // Bug-fix observability events (client-resilience design §6.1). Untyped
  // payload (Record) — consumers cast to a known shape; the contract is
  // documented in the design doc and stays out of the typed event union so
  // adding a new event later doesn't ripple through downstream listeners.
  // -----------------------------------------------------------------------
  "resilience.connection.paused": [payload: { reason: ClientPausedReason }];
  "resilience.connection.resumed": [payload: { previousReason: ClientPausedReason }];
  "resilience.bind.skipped": [
    payload: { agentId: string; attempts: number; nextAllowedAt: number; lastReasonCode: string | null },
  ];
  "resilience.bind.disabled": [payload: { agentId: string; reasonCode: string }];
  "resilience.bind.recovered": [payload: { agentId: string; totalAttempts: number }];
  "resilience.update.failed": [payload: { targetVersion: string; retryable: boolean; reasonCode: string }];
};

/**
 * Thrown (emitted on `error` and rejected from `connect()`) when the server
 * refuses a `client:register` because the local clientId is bound to a
 * different organization. Retained for wire compatibility — the read paths
 * that produced this code were retired in decouple-client-from-identity §4.1.
 */
export class ClientOrgMismatchError extends Error {
  readonly code = "CLIENT_ORG_MISMATCH";
  constructor(message = "Client belongs to a different organization") {
    super(message);
    this.name = "ClientOrgMismatchError";
  }
}

/**
 * Thrown when the server refuses `client:register` because the local
 * client.yaml is owned by a different user. The CLI detects this via
 * `instanceof` and guides the operator through local-client switching before
 * logging in with another account. The switch is local-only: it parks this
 * machine's client identity and agent runtime state without deleting
 * server-side clients, pinned agents, chats, or history.
 */
export class ClientUserMismatchError extends Error {
  readonly code = "CLIENT_USER_MISMATCH";
  constructor(message = "Client belongs to a different user") {
    super(message);
    this.name = "ClientUserMismatchError";
  }
}

/**
 * Thrown when the server refuses `client:register` because this local
 * client identity was retired server-side. Retrying the same client id cannot
 * recover; the operator must reset local identity and register a fresh client.
 */
export class ClientRetiredError extends Error {
  readonly code = "CLIENT_RETIRED";
  constructor(message = "Client has been retired") {
    super(message);
    this.name = "ClientRetiredError";
  }
}

class ServerAuthRejectedError extends Error {
  readonly authCode: AuthRejectedCode | undefined;
  readonly authMessage: string | undefined;

  constructor(opts: { code?: AuthRejectedCode; message?: string; legacyReason?: string; unsupportedCode?: string }) {
    const detail =
      opts.code !== undefined
        ? `code ${opts.code}${opts.message ? `: ${opts.message}` : ""}`
        : opts.unsupportedCode !== undefined
          ? `unsupported code ${opts.unsupportedCode}`
          : opts.legacyReason !== undefined
            ? `legacy reason: ${opts.legacyReason}`
            : "legacy frame without code";
    super(`Server rejected access token (auth:rejected, ${detail})`);
    this.name = "ServerAuthRejectedError";
    this.authCode = opts.code;
    this.authMessage = opts.message;
  }
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const WS_CONNECT_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const INBOX_ACK_CONFIRM_TIMEOUT_MS = 3_000;
const INBOX_ACK_MAX_SENDS = 2;
const INBOX_ACK_PENDING_CAP = 1024;
const INBOX_ACK_TIMEOUT_CLOSE_CODE = 1011;
const INBOX_ACK_TIMEOUT_CLOSE_REASON = "inbox ack timeout";
const INBOX_RECOVER_CONFIRM_TIMEOUT_MS = 3_000;
const SESSION_EVENT_CONFIRM_TIMEOUT_MS = 3_000;
const INBOX_RECOVER_TIMEOUT_CLOSE_CODE = 1011;
const INBOX_RECOVER_TIMEOUT_CLOSE_REASON = "inbox recover timeout";
/**
 * Silence watchdog: if no server frame (data message OR control-frame pong)
 * arrives within this many ms, the socket is presumed dead and terminated so
 * the close handler can drive a reconnect. Sized to ~3 heartbeat ticks so a
 * single missed pong is tolerated, but a wedged socket (e.g. after the OS
 * resumes from suspend with a half-open TCP connection) is broken within one
 * minute of the next heartbeat tick.
 */
const HEARTBEAT_TIMEOUT_MS = 90_000;
/**
 * Unified-user-token C5: reconnect PROACTIVELY this many ms before the JWT's
 * `exp` claim so the client rotates to a fresh JWT without ever hitting the
 * server-side `auth:expired` push. The provider's next `getAccessToken()` call
 * is expected to return a refreshed token — the CLI stores it in
 * `credentials.json` and the web app uses its refresh-on-401 loop.
 */
const AUTH_REFRESH_LEAD_MS = 60_000;

/**
 * Sleep for `ms`, resolving early if the abort signal fires. Used by
 * {@link ClientConnection.connect} so a `disconnect()` during the initial-
 * connect backoff doesn't block for the full retry interval.
 */
function waitWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Decode a JWT payload without verifying. Returns null if malformed. */
function decodeJwtExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const rawPayload = parts[1];
  if (!rawPayload) return null;
  try {
    const b64 = rawPayload.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
    const json = Buffer.from(b64 + pad, "base64").toString("utf-8");
    const payload = JSON.parse(json) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Bash stdout reaches handlers as `string` via Buffer.toString('utf8'), so a
 * tool whose output is binary (e.g. `gh api .../actions/runs/<id>/logs`
 * returns a ZIP archive) lands in `resultPreview` peppered with U+FFFD
 * replacements and embedded NULs. PostgreSQL JSONB rejects NUL outright, which
 * used to drop the entire session event server-side; a forest of `(replacement chars)` would
 * also be useless to the UI. Replace such previews with a placeholder so the
 * event still persists and the timeline shows the call happened.
 */
const REPLACEMENT_CHAR_BINARY_THRESHOLD = 8;

function looksBinary(s: string): boolean {
  if (s.includes("\u0000")) return true;
  return (s.match(/\uFFFD/g)?.length ?? 0) > REPLACEMENT_CHAR_BINARY_THRESHOLD;
}

export function sanitizeSessionEventForTransport(event: SessionEvent): SessionEvent {
  if (event.kind !== "tool_call") return event;
  const preview = event.payload.resultPreview;
  if (preview === undefined || !looksBinary(preview)) return event;
  return {
    ...event,
    payload: {
      ...event.payload,
      resultPreview: `[binary content, ${preview.length} chars elided]`,
    },
  };
}

/**
 * Client WS — one socket per client, many agents multiplexed.
 *
 * Handshake sequence (unified-user-token):
 *   1. TCP/WS upgrade to `/api/v1/agent/ws/client` — no Authorization header.
 *   2. Send `{type:"auth", token}` where `token` is a member access JWT.
 *      Server replies `auth:ok`; without it the socket is closed (code 4401).
 *   3. Send `client:register`; server claims/verifies `clients.user_id`.
 *   4. Per agent: `agent:bind {agentId, runtimeType, runtimeVersion}` —
 *      server runs Rule R-RUN, replies `agent:bound` or `agent:bind:rejected`.
 */
export class ClientConnection extends EventEmitter<ClientConnectionEvents> {
  readonly clientId: string;
  private readonly serverUrl: string;
  private readonly sdkVersion: string | undefined;
  private readonly userAgent: string | undefined;
  private readonly getAccessToken: AccessTokenProvider;
  private readonly getLastUpdateAttempt: (() => UpdateAttempt | null) | undefined;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;

  private ws: WebSocket | null = null;
  private wsConnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Fires ~60s before JWT exp so we reconnect with a fresh token first. */
  private authRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  /**
   * Monotonic timestamp of the last frame received from the server (data
   * message OR pong control frame). Consulted by the heartbeat tick to
   * detect a half-open socket (no FIN/RST yet, readyState still OPEN) so we
   * can `terminate()` it and let the close handler reconnect. Required
   * because nothing else surfaces "socket alive but peer gone" in time —
   * Linux's default TCP keep-alive only probes after ~2h of idle.
   */
  private lastServerMessageAt = 0;
  /**
   * AbortController consumed by {@link connect}'s backoff sleep so a caller
   * that runs {@link disconnect} while the initial-connect loop is between
   * attempts isn't blocked for up to RECONNECT_MAX_MS waiting for the next
   * tick to notice `closing`.
   */
  private connectAbort: AbortController | null = null;
  /**
   * If the most recent refresh attempt was rate-limited (HTTP 429), the
   * server-suggested wait in ms — consumed by the next `scheduleReconnect`
   * to floor its delay so we don't keep retrying inside the same 60s
   * limiter window. Cleared after one use.
   */
  private nextReconnectMinDelayMs = 0;
  /** Guards the shared ACK confirm fail-close so a timeout and cap hit close the socket once. */
  private inboxAckFailCloseStarted = false;
  private closing = false;
  private registered = false;
  /**
   * Paused state (Bug 2): refresh failed / token revoked. Reconnect attempts
   * are suspended until {@link clearPaused} fires. Heartbeat tick still
   * decorates frames with the reason while paused, so admin surfaces can
   * show "client alive but waiting on operator".
   */
  private pausedReason: ClientPausedReason | null = null;
  /** Count of `server:welcome` frames received; drives `isReconnect` flag. */
  private welcomeFramesReceived = 0;
  private serverSupportsInboxAckConfirm = false;
  private serverSupportsSessionEventConfirm = false;
  /**
   * Does the CURRENT server speak version 1 of the composite Reset protocol
   * (ref'd terminate apply-ack + receipted post-apply terminal dispositions
   * `session:command:finalized` / `session:command:aborted` + matching
   * receipts)? Reset parks inbox recovery behind a fence only an exact
   * receipted terminal disposition lifts, so a server without this capability
   * must make the client refuse the ref'd terminate BEFORE applying it locally
   * rather than tear the session down and park forever. Cleared on every new
   * socket and re-learned from that connection's welcome, which the server
   * sends ahead of `auth:ok`.
   */
  private serverSupportsSessionResetV1 = false;
  /**
   * Last handshake error, stashed for the `close` handler to surface a typed
   * reason (e.g. {@link ClientOrgMismatchError}) instead of a generic
   * "closed before ready" when `connect()` is pending.
   */
  private lastHandshakeError: Error | null = null;

  private readonly wsLogger: pino.Logger;
  private readonly authLogger: pino.Logger;

  private readonly boundAgents = new Map<string, BoundAgent>();
  private readonly runtimeSessionTokenProviders = new Map<string, RuntimeSessionTokenProvider>();

  /** Agents scheduled to rebind automatically on every reconnect. */
  private readonly desiredBindings = new Map<
    string,
    { agentId: string; runtimeType: string; runtimeVersion?: string }
  >();

  private pendingBinds = new Map<
    string,
    {
      agentId: string;
      runtimeType: string;
      runtimeVersion?: string;
      resolve: (agent: BoundAgent) => void;
      reject: (err: Error) => void;
    }
  >();

  /**
   * Bug 5: per-agent bind retry state. Keyed by agentId. A successful
   * `agent:bound` clears the entry; a `bind:rejected` updates it according
   * to the error taxonomy (transient → exponential next attempt; degraded /
   * permanent → never).
   */
  private readonly bindRetryRecords = new Map<string, BindRetryRecord>();
  private readonly pendingInboxAcks = new Map<number, PendingInboxAck>();
  private readonly pendingInboxRecovers = new Map<string, PendingInboxRecover>();
  private readonly pendingInboxFenceProbes = new Map<string, PendingInboxFenceProbe>();
  private readonly pendingSessionEvents = new Map<string, PendingSessionEvent>();
  private readonly socketBoundAgentIds = new Set<string>();

  constructor(config: ClientConnectionConfig) {
    super();
    this.clientId = config.clientId ?? process.env.FIRST_TREE_CLIENT_ID ?? `client_${randomUUID().slice(0, 8)}`;
    this.serverUrl = config.serverUrl.replace(/\/+$/, "");
    this.sdkVersion = config.sdkVersion;
    this.userAgent = config.userAgent;
    this.getAccessToken = config.getAccessToken;
    this.getLastUpdateAttempt = config.getLastUpdateAttempt;
    this.heartbeatIntervalMs = config.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.wsLogger = createLogger("ws").child({ clientId: this.clientId });
    this.authLogger = createLogger("auth").child({ clientId: this.clientId });

    // Tombstone listener: Node's EventEmitter re-throws `error` events that
    // have no listener, so a stray ECONNRESET would crash the host. Consumers
    // (AgentRuntime / ClientRuntime) attach their own listeners for logging —
    // this one is the fallback for raw-SDK users who don't.
    this.on("error", () => {});
  }

  setRuntimeSessionTokenProvider(agentId: string, provider: RuntimeSessionTokenProvider): void {
    this.runtimeSessionTokenProviders.set(agentId, provider);
  }

  clearRuntimeSessionTokenProvider(agentId: string, provider?: RuntimeSessionTokenProvider): void {
    if (provider && this.runtimeSessionTokenProviders.get(agentId) !== provider) return;
    this.runtimeSessionTokenProviders.delete(agentId);
  }

  private resolveRuntimeSessionToken(agentId: string): string | undefined {
    const provider = this.runtimeSessionTokenProviders.get(agentId);
    if (!provider) return undefined;
    try {
      const token = provider()?.trim();
      return token || undefined;
    } catch (err) {
      this.wsLogger.warn({ err, agentId }, "runtime session token provider failed");
      return undefined;
    }
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.registered;
  }

  /** Whether the connection is currently in {@link "auth:paused"} mode. */
  isPaused(): boolean {
    return this.pausedReason !== null;
  }

  /** Last paused reason. `null` when not paused. */
  getPausedReason(): ClientPausedReason | null {
    return this.pausedReason;
  }

  /**
   * Clear paused mode and kick off a reconnect attempt. Intended to be
   * called by the consumer's credentials-file watcher after the operator
   * runs `<binName> login <new-token>` (which writes a fresh JWT to
   * credentials.json).
   */
  clearPaused(): void {
    if (this.pausedReason === null) return;
    const prev = this.pausedReason;
    this.pausedReason = null;
    this.wsLogger.info(
      { previousReason: prev, resilienceEvent: "resilience.connection.resumed" },
      "auth paused cleared",
    );
    this.emit("auth:resumed", prev);
    this.emit("resilience.connection.resumed", { previousReason: prev });
    if (!this.closing && !this.isConnected) {
      this.scheduleReconnect();
    }
  }

  get agents(): ReadonlyMap<string, BoundAgent> {
    return this.boundAgents;
  }

  /**
   * Ack a delivered inbox entry over the WS data plane. New servers confirm
   * ACKs with a correlated response; confirmed ACKs send at most twice on the
   * same socket (initial + one retry) and never replay across a new socket.
   * Legacy servers keep the old fire-and-forget behaviour.
   */
  sendInboxAck(entryId: number, agentId?: string): Promise<void> {
    if (!this.serverSupportsInboxAckConfirm) {
      this.sendLegacyInboxAck(entryId, agentId);
      return Promise.resolve();
    }

    const existing = this.pendingInboxAcks.get(entryId);
    if (existing) return existing.promise;

    if (this.pendingInboxAcks.size >= INBOX_ACK_PENDING_CAP) {
      const pending = this.createPendingInboxAck(entryId, agentId);
      this.pendingInboxAcks.set(entryId, pending);
      this.failCloseInboxAckConfirmations("inbox ack timeout");
      return pending.promise;
    }

    const pending = this.createPendingInboxAck(entryId, agentId);
    this.pendingInboxAcks.set(entryId, pending);
    this.sendPendingInboxAck(pending, false);
    return pending.promise;
  }

  /**
   * Ask the server to reset delivered-but-unacked entries for one chat and
   * redeliver them on this socket. Unlike ACKs, recovery is bounded: callers
   * must get an accepted/rejected/timeout outcome instead of waiting forever
   * behind a per-chat recovery gate. Resolves with the server's reset count
   * plus (on new servers) the authoritative unacked outstanding count —
   * the only client-visible server ACK truth for crash-safe reconciliation.
   */
  sendInboxRecover(agentId: string, chatId: string): Promise<InboxRecoverResult> {
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.registered ||
      !this.socketBoundAgentIds.has(agentId)
    ) {
      return Promise.reject(new Error("inbox:recover unavailable; socket not bound"));
    }

    const pending: PendingInboxRecover = {
      agentId,
      chatId,
      ref: `recover_${randomUUID().slice(0, 12)}`,
      firstSentAt: Date.now(),
      timer: null,
      promise: Promise.resolve({ resetCount: 0 }),
      resolve: () => {},
      reject: () => {},
    };
    pending.promise = new Promise<InboxRecoverResult>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    this.pendingInboxRecovers.set(pending.ref, pending);
    this.ws.send(JSON.stringify({ type: "inbox:recover", ref: pending.ref, agentId, chatId }));
    this.wsLogger.debug(
      {
        agentId,
        chatId,
        ref: pending.ref,
        recoverEvent: "inbox_recover_sent",
      },
      "inbox:recover sent",
    );
    pending.timer = setTimeout(() => {
      if (!this.pendingInboxRecovers.has(pending.ref)) return;
      this.rejectPendingInboxRecover(pending, "timeout");
      this.forceReconnectAfterInboxRecoverTimeout(pending);
    }, INBOX_RECOVER_CONFIRM_TIMEOUT_MS);
    return pending.promise;
  }

  /**
   * Read-only settlement probe for concrete fenced deliveries. Resolves
   * with the probed message ids the server proves settled (no unsettled
   * notify row), computed inside the server's serialized recovery
   * boundary. Bounded confirmation like recovery, but never destructive:
   * no reset, no redelivery, and timeout only rejects.
   */
  sendInboxFenceProbe(agentId: string, chatId: string, messageIds: string[]): Promise<InboxFenceProbeResult> {
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.registered ||
      !this.socketBoundAgentIds.has(agentId)
    ) {
      return Promise.reject(new Error("inbox:fence-probe unavailable; socket not bound"));
    }

    const pending: PendingInboxFenceProbe = {
      agentId,
      chatId,
      ref: `fenceprobe_${randomUUID().slice(0, 12)}`,
      firstSentAt: Date.now(),
      timer: null,
      promise: Promise.resolve({ settledMessageIds: [] }),
      resolve: () => {},
      reject: () => {},
    };
    pending.promise = new Promise<InboxFenceProbeResult>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    this.pendingInboxFenceProbes.set(pending.ref, pending);
    this.ws.send(JSON.stringify({ type: "inbox:fence-probe", ref: pending.ref, agentId, chatId, messageIds }));
    this.wsLogger.debug(
      { agentId, chatId, ref: pending.ref, probeCount: messageIds.length, recoverEvent: "inbox_fence_probe_sent" },
      "inbox:fence-probe sent",
    );
    pending.timer = setTimeout(() => {
      if (!this.pendingInboxFenceProbes.has(pending.ref)) return;
      this.pendingInboxFenceProbes.delete(pending.ref);
      pending.reject(new Error("inbox:fence-probe confirmation timed out"));
    }, INBOX_RECOVER_CONFIRM_TIMEOUT_MS);
    return pending.promise;
  }

  private resolvePendingInboxFenceProbe(pending: PendingInboxFenceProbe, settledMessageIds: string[]): void {
    this.clearPendingInboxFenceProbeTimer(pending);
    this.pendingInboxFenceProbes.delete(pending.ref);
    this.wsLogger.debug(
      {
        agentId: pending.agentId,
        chatId: pending.chatId,
        ref: pending.ref,
        settledCount: settledMessageIds.length,
        latencyMs: Date.now() - pending.firstSentAt,
        recoverEvent: "inbox_fence_probe_accepted",
      },
      "inbox:fence-probe accepted",
    );
    pending.resolve({ settledMessageIds });
  }

  private rejectPendingInboxFenceProbe(pending: PendingInboxFenceProbe, reason: string): void {
    this.clearPendingInboxFenceProbeTimer(pending);
    this.pendingInboxFenceProbes.delete(pending.ref);
    this.wsLogger.warn(
      {
        agentId: pending.agentId,
        chatId: pending.chatId,
        ref: pending.ref,
        reason,
        latencyMs: Date.now() - pending.firstSentAt,
        recoverEvent: "inbox_fence_probe_rejected",
      },
      "inbox:fence-probe rejected",
    );
    pending.reject(new Error(`inbox:fence-probe rejected (${reason})`));
  }

  private clearPendingInboxFenceProbeTimer(pending: PendingInboxFenceProbe): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
  }

  private rejectAllPendingInboxFenceProbes(reason: string): void {
    for (const pending of this.pendingInboxFenceProbes.values()) {
      this.clearPendingInboxFenceProbeTimer(pending);
      pending.reject(new Error(reason));
    }
    this.pendingInboxFenceProbes.clear();
  }

  private rejectPendingInboxFenceProbesForAgent(agentId: string, reason: string): void {
    for (const pending of [...this.pendingInboxFenceProbes.values()]) {
      if (pending.agentId === agentId) this.rejectPendingInboxFenceProbe(pending, reason);
    }
  }

  private canSendClientFrame(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.registered;
  }

  private canSendAgentFrame(agentId?: string): boolean {
    return this.canSendClientFrame() && (agentId === undefined || this.socketBoundAgentIds.has(agentId));
  }

  private sendLegacyInboxAck(entryId: number, agentId?: string): void {
    const ws = this.ws;
    if (!this.canSendAgentFrame(agentId) || !ws) {
      this.wsLogger.warn(
        { entryId, agentId, connectionState: this.inboxAckConnectionState() },
        "inbox:ack dropped — socket not ready",
      );
      return;
    }
    ws.send(JSON.stringify({ type: "inbox:ack", entryId }));
    this.wsLogger.debug(
      {
        entryId,
        attempt: 1,
        ackEvent: "inbox_ack_sent",
        mode: "legacy",
        connectionState: this.inboxAckConnectionState(),
      },
      "inbox:ack sent",
    );
  }

  private createPendingInboxAck(entryId: number, agentId?: string): PendingInboxAck {
    const pending: PendingInboxAck = {
      entryId,
      ...(agentId ? { agentId } : {}),
      ref: `ack_${randomUUID().slice(0, 12)}`,
      attempts: 0,
      firstSentAt: 0,
      timer: null,
      promise: Promise.resolve(),
      resolve: () => {},
      reject: () => {},
    };
    pending.promise = new Promise<void>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    return pending;
  }

  private sendPendingInboxAck(pending: PendingInboxAck, retry: boolean): void {
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN ||
      !this.registered ||
      (pending.agentId && !this.socketBoundAgentIds.has(pending.agentId))
    ) {
      this.wsLogger.warn(
        {
          entryId: pending.entryId,
          agentId: pending.agentId,
          ref: pending.ref,
          attempt: pending.attempts + 1,
          connectionState: this.inboxAckConnectionState(),
        },
        "inbox:ack pending — socket not ready",
      );
      return;
    }

    if (!this.serverSupportsInboxAckConfirm) {
      this.sendLegacyInboxAck(pending.entryId, pending.agentId);
      this.resolvePendingInboxAck(pending, "legacy_fallback");
      return;
    }

    if (pending.attempts >= INBOX_ACK_MAX_SENDS) {
      this.failCloseInboxAckConfirmations("inbox ack timeout");
      return;
    }

    this.clearPendingInboxAckTimer(pending);
    if (pending.firstSentAt === 0) pending.firstSentAt = Date.now();
    pending.attempts += 1;
    this.ws.send(JSON.stringify({ type: "inbox:ack", entryId: pending.entryId, ref: pending.ref }));
    this.wsLogger.debug(
      {
        entryId: pending.entryId,
        agentId: pending.agentId,
        ref: pending.ref,
        attempt: pending.attempts,
        connectionState: this.inboxAckConnectionState(),
        ackEvent: retry ? "inbox_ack_retry" : "inbox_ack_sent",
      },
      retry ? "inbox:ack retry sent" : "inbox:ack sent",
    );

    pending.timer = setTimeout(() => {
      pending.timer = null;
      if (!this.pendingInboxAcks.has(pending.entryId)) return;
      this.wsLogger.warn(
        {
          entryId: pending.entryId,
          agentId: pending.agentId,
          ref: pending.ref,
          attempt: pending.attempts,
          timeoutMs: INBOX_ACK_CONFIRM_TIMEOUT_MS,
          connectionState: this.inboxAckConnectionState(),
          ackEvent: "inbox_ack_timeout",
        },
        "inbox:ack confirmation timed out",
      );
      if (pending.attempts >= INBOX_ACK_MAX_SENDS) {
        this.failCloseInboxAckConfirmations("inbox ack timeout");
        return;
      }
      this.sendPendingInboxAck(pending, true);
    }, INBOX_ACK_CONFIRM_TIMEOUT_MS);
  }

  private failCloseInboxAckConfirmations(reason: string): void {
    if (this.inboxAckFailCloseStarted) return;
    this.inboxAckFailCloseStarted = true;
    this.rejectAllPendingInboxAcks(reason);
    this.nextReconnectMinDelayMs = Math.max(this.nextReconnectMinDelayMs, RECONNECT_MAX_MS);
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this.closing) return;
    this.wsLogger.warn(
      {
        closeCode: INBOX_ACK_TIMEOUT_CLOSE_CODE,
        pendingCap: INBOX_ACK_PENDING_CAP,
        ackEvent: "inbox_ack_timeout_reconnect",
      },
      "inbox:ack confirmation exhausted — closing socket to force bind recovery",
    );
    ws.close(INBOX_ACK_TIMEOUT_CLOSE_CODE, INBOX_ACK_TIMEOUT_CLOSE_REASON);
  }

  private flushPendingInboxAcks(): void {
    for (const pending of this.pendingInboxAcks.values()) {
      if (pending.timer === null) this.sendPendingInboxAck(pending, pending.attempts > 0);
    }
  }

  private resolvePendingInboxAck(pending: PendingInboxAck, disposition: string): void {
    this.clearPendingInboxAckTimer(pending);
    this.pendingInboxAcks.delete(pending.entryId);
    const latencyMs = pending.firstSentAt === 0 ? 0 : Date.now() - pending.firstSentAt;
    this.wsLogger.debug(
      {
        entryId: pending.entryId,
        agentId: pending.agentId,
        ref: pending.ref,
        attempt: pending.attempts,
        disposition,
        latencyMs,
        connectionState: this.inboxAckConnectionState(),
        ackEvent: "inbox_ack_accepted",
        latencyEvent: "inbox_ack_latency_ms",
      },
      "inbox:ack accepted",
    );
    pending.resolve();
  }

  private rejectPendingInboxAck(pending: PendingInboxAck, reason: string): void {
    this.clearPendingInboxAckTimer(pending);
    this.pendingInboxAcks.delete(pending.entryId);
    this.wsLogger.warn(
      {
        entryId: pending.entryId,
        agentId: pending.agentId,
        ref: pending.ref,
        attempt: pending.attempts,
        reason,
        latencyMs: pending.firstSentAt === 0 ? 0 : Date.now() - pending.firstSentAt,
        connectionState: this.inboxAckConnectionState(),
        ackEvent: "inbox_ack_rejected",
      },
      "inbox:ack rejected",
    );
    pending.reject(new Error(`inbox:ack rejected (${reason})`));
  }

  private clearPendingInboxAckTimer(pending: PendingInboxAck): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
  }

  private resolvePendingInboxRecover(
    pending: PendingInboxRecover,
    resetCount: number,
    unackedOutstanding?: number,
  ): void {
    this.clearPendingInboxRecoverTimer(pending);
    this.pendingInboxRecovers.delete(pending.ref);
    this.wsLogger.debug(
      {
        agentId: pending.agentId,
        chatId: pending.chatId,
        ref: pending.ref,
        resetCount,
        unackedOutstanding,
        latencyMs: Date.now() - pending.firstSentAt,
        recoverEvent: "inbox_recover_accepted",
      },
      "inbox:recover accepted",
    );
    pending.resolve({ resetCount, unackedOutstanding });
  }

  private rejectPendingInboxRecover(pending: PendingInboxRecover, reason: string): void {
    this.clearPendingInboxRecoverTimer(pending);
    this.pendingInboxRecovers.delete(pending.ref);
    this.wsLogger.warn(
      {
        agentId: pending.agentId,
        chatId: pending.chatId,
        ref: pending.ref,
        reason,
        latencyMs: Date.now() - pending.firstSentAt,
        recoverEvent: "inbox_recover_rejected",
      },
      "inbox:recover rejected",
    );
    pending.reject(new Error(`inbox:recover rejected (${reason})`));
  }

  private forceReconnectAfterInboxRecoverTimeout(pending: PendingInboxRecover): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.registered || this.closing) return;
    this.wsLogger.warn(
      {
        agentId: pending.agentId,
        chatId: pending.chatId,
        ref: pending.ref,
        closeCode: INBOX_RECOVER_TIMEOUT_CLOSE_CODE,
        recoverEvent: "inbox_recover_timeout_reconnect",
      },
      "inbox:recover confirmation timed out — closing socket to force bind recovery",
    );
    ws.close(INBOX_RECOVER_TIMEOUT_CLOSE_CODE, INBOX_RECOVER_TIMEOUT_CLOSE_REASON);
  }

  private clearPendingInboxRecoverTimer(pending: PendingInboxRecover): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
  }

  private resolvePendingSessionEvent(pending: PendingSessionEvent): void {
    this.clearPendingSessionEventTimer(pending);
    this.pendingSessionEvents.delete(pending.ref);
    this.wsLogger.debug(
      {
        agentId: pending.agentId,
        chatId: pending.chatId,
        ref: pending.ref,
        latencyMs: Date.now() - pending.firstSentAt,
        sessionEvent: "session_event_accepted",
      },
      "session:event accepted",
    );
    pending.resolve();
  }

  private rejectPendingSessionEvent(pending: PendingSessionEvent, reason: string): void {
    this.clearPendingSessionEventTimer(pending);
    this.pendingSessionEvents.delete(pending.ref);
    this.wsLogger.warn(
      {
        agentId: pending.agentId,
        chatId: pending.chatId,
        ref: pending.ref,
        reason,
        latencyMs: Date.now() - pending.firstSentAt,
        sessionEvent: "session_event_rejected",
      },
      "session:event rejected",
    );
    pending.reject(new Error(`session:event rejected (${reason})`));
  }

  private clearPendingSessionEventTimer(pending: PendingSessionEvent): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
  }

  private inboxAckConnectionState(): string {
    if (!this.ws) return "no_socket";
    if (this.ws.readyState !== WebSocket.OPEN) return `socket_${this.ws.readyState}`;
    if (!this.registered) return "open_unregistered";
    if (this.socketBoundAgentIds.size === 0) return "open_registered_unbound";
    return this.serverSupportsInboxAckConfirm ? "open_registered_confirmed" : "open_registered_legacy";
  }

  /**
   * Bring up the socket, retrying transient handshake failures with the same
   * exponential schedule as {@link scheduleReconnect}. Resolves once the
   * server has acknowledged `client:register`; rejects only when something
   * unrecoverable has flipped `closing` (auth:fatal, register:rejected for
   * user/org mismatch). Without this loop, a temporary DNS hiccup at startup
   * propagated up to `client-runtime.start` and exited the process — which
   * leaned on systemd's restart to recover instead of the in-process backoff
   * the live reconnect path already uses.
   */
  async connect(): Promise<void> {
    this.closing = false;
    this.connectAbort = new AbortController();
    let attempt = 0;
    try {
      while (true) {
        try {
          await this.openWebSocket();
          return;
        } catch (err) {
          if (this.closing) throw err;
          // Bug 2: paused mode (auth_rejected / auth_refresh_failed) is an
          // operator-recovery state — keep the initial-connect promise from
          // looping forever. Surface the error so the consumer knows the
          // initial handshake failed; the credentials watcher will trigger
          // a fresh `connect()` once login succeeds.
          if (this.pausedReason !== null) throw err;
          attempt++;
          const { delayMs, floorMs } = this.consumeReconnectDelay(attempt);
          this.wsLogger.warn(
            { attempt, delayMs, floorMs: floorMs || undefined, err: err instanceof Error ? err.message : String(err) },
            "initial connect failed, will retry",
          );
          this.emit("error", err instanceof Error ? err : new Error(String(err)));
          await waitWithAbort(delayMs, this.connectAbort.signal);
          if (this.closing) throw err;
          if (this.pausedReason !== null) throw err;
        }
      }
    } finally {
      this.connectAbort = null;
    }
  }

  /**
   * Bind an agent to this client connection. The server decides whether the
   * agent may actually run here (Rule R-RUN); if not, a rejection arrives on
   * the `agent:bind:rejected` event and the returned promise rejects.
   */
  async bindAgent(agentId: string, runtimeType: string, runtimeVersion?: string): Promise<BoundAgent> {
    if (!this.isConnected) {
      throw new Error("Client not connected");
    }

    this.desiredBindings.set(agentId, { agentId, runtimeType, runtimeVersion });
    // Bug 5: an explicit bindAgent call is operator intent — clear any
    // backoff so this attempt isn't silently skipped.
    this.bindRetryRecords.delete(agentId);
    return this.sendBind(agentId, runtimeType, runtimeVersion);
  }

  async unbindAgent(agentId: string): Promise<void> {
    const shouldNotifyServer = this.canSendAgentFrame(agentId);
    this.desiredBindings.delete(agentId);
    this.boundAgents.delete(agentId);
    this.socketBoundAgentIds.delete(agentId);
    this.rejectPendingInboxAcksForAgent(agentId, "agent_unbound");
    this.rejectPendingInboxRecoversForAgent(agentId, "agent_unbound");
    this.rejectPendingInboxFenceProbesForAgent(agentId, "agent_unbound");
    this.rejectPendingSessionEventsForAgent(agentId, "agent_unbound");
    if (!shouldNotifyServer || !this.ws) return;
    this.ws.send(JSON.stringify({ type: "agent:unbind", agentId }));
  }

  reportSessionState(agentId: string, chatId: string, state: SessionState): void {
    if (!this.canSendAgentFrame(agentId) || !this.ws) return;
    this.ws.send(JSON.stringify({ type: "session:state", agentId, chatId, state }));
  }

  /**
   * Answer a ref'd `session:terminate` command. Callers (the agent slot's
   * command handler) invoke this ONLY after `handleCommand` has fully
   * resolved — the server treats `applied: true` as proof that the local
   * provider-session mapping is gone, so acking early would fake a fresh
   * session guarantee.
   */
  reportSessionCommandApplied(input: {
    ref: string;
    agentId: string;
    chatId: string;
    command: "session:terminate";
    applied: boolean;
  }): void {
    if (!this.canSendAgentFrame(input.agentId) || !this.ws) return;
    this.ws.send(
      JSON.stringify({
        type: "session:command:applied",
        ref: input.ref,
        agentId: input.agentId,
        chatId: input.chatId,
        command: input.command,
        applied: input.applied,
      }),
    );
  }

  /**
   * Did this connection negotiate version 1 of the composite Reset protocol?
   * The agent slot consults this BEFORE applying a ref'd terminate: on a
   * server that speaks only the legacy apply-only flow no post-apply terminal
   * disposition (`finalized` / `aborted`) ever arrives, so the Reset must fail
   * closed instead of destroying the local session and parking its queued work
   * behind a fence nothing will lift.
   */
  get supportsSessionResetV1(): boolean {
    return this.serverSupportsSessionResetV1;
  }

  /**
   * Receipt for `session:command:finalized`. The server holds the Reset HTTP
   * request open until this lands on the exact client route, so it is sent
   * after the parked-fence release decision for that ref is made — including
   * `released: false` when the ref did not match a locally armed generation,
   * which is still an honest answer about this client's state.
   */
  reportSessionCommandFinalizedAck(input: {
    ref: string;
    ackRef: string;
    agentId: string;
    chatId: string;
    command: "session:terminate";
    released: boolean;
  }): void {
    this.sendSessionCommandDispositionAck("session:command:finalized:ack", input);
  }

  /**
   * Receipt for `session:command:aborted` — the exact counterpart of
   * {@link reportSessionCommandFinalizedAck} for a Reset the server accepted the
   * apply for but could not finalize. The server holds the Reset HTTP request
   * open until this lands, so it is sent after the release decision for that ref
   * is made, `released: false` included.
   */
  reportSessionCommandAbortedAck(input: {
    ref: string;
    ackRef: string;
    agentId: string;
    chatId: string;
    command: "session:terminate";
    released: boolean;
  }): void {
    this.sendSessionCommandDispositionAck("session:command:aborted:ack", input);
  }

  private sendSessionCommandDispositionAck(
    type: "session:command:finalized:ack" | "session:command:aborted:ack",
    input: {
      ref: string;
      ackRef: string;
      agentId: string;
      chatId: string;
      command: "session:terminate";
      released: boolean;
    },
  ): void {
    if (!this.canSendAgentFrame(input.agentId) || !this.ws) return;
    this.ws.send(
      JSON.stringify({
        type,
        ref: input.ref,
        ackRef: input.ackRef,
        agentId: input.agentId,
        chatId: input.chatId,
        command: input.command,
        released: input.released,
      }),
    );
  }

  reportRuntimeState(agentId: string, runtimeState: RuntimeState): void {
    if (!this.canSendAgentFrame(agentId) || !this.ws) return;
    this.ws.send(JSON.stringify({ type: "runtime:state", agentId, runtimeState }));
  }

  /**
   * Report the per-(agent,chat) D-axis runtime (idle / working / blocked /
   * error). This is the per-chat counterpart to `reportRuntimeState`'s
   * agent-global aggregate — the per-chat field is the authoritative source
   * the server-side composite status reads (working / errored axes), while
   * the agent-global runtime is double-written and kept around for the
   * admin overview / fault notification path until that consumer migrates.
   */
  reportSessionRuntime(agentId: string, chatId: string, report: SessionRuntimeReport): void {
    if (!this.canSendAgentFrame(agentId) || !this.ws) return;
    // Omitted rather than sent as `false`: an absent field and an explicit
    // `false` mean the same thing to the server, and omitting keeps the
    // common frame byte-identical to what older clients send.
    this.ws.send(
      JSON.stringify({
        type: "session:runtime",
        agentId,
        chatId,
        runtimeState: report.runtimeState,
        ...(report.backgroundWork ? { backgroundWork: true } : {}),
      }),
    );
  }

  reportSessionEvent(agentId: string, chatId: string, event: SessionEvent): void {
    if (!this.canSendAgentFrame(agentId) || !this.ws) return;
    const sanitized = sanitizeSessionEventForTransport(event);
    this.ws.send(JSON.stringify({ type: "session:event", agentId, chatId, event: sanitized }));
  }

  reportSessionEventConfirmed(agentId: string, chatId: string, event: SessionEvent): Promise<void> {
    if (!this.serverSupportsSessionEventConfirm) {
      this.reportSessionEvent(agentId, chatId, event);
      return Promise.reject(new Error("session:event confirmation unsupported by server"));
    }
    if (!this.canSendAgentFrame(agentId) || !this.ws) {
      return Promise.reject(new Error("session:event unavailable; socket not bound"));
    }

    const pending: PendingSessionEvent = {
      agentId,
      chatId,
      ref: `session_event_${randomUUID().slice(0, 12)}`,
      firstSentAt: Date.now(),
      timer: null,
      promise: Promise.resolve(),
      resolve: () => {},
      reject: () => {},
    };
    pending.promise = new Promise<void>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });
    this.pendingSessionEvents.set(pending.ref, pending);
    const sanitized = sanitizeSessionEventForTransport(event);
    this.ws.send(JSON.stringify({ type: "session:event", agentId, chatId, event: sanitized, ref: pending.ref }));
    this.wsLogger.debug(
      {
        agentId,
        chatId,
        ref: pending.ref,
        eventKind: sanitized.kind,
        sessionEvent: "session_event_sent",
      },
      "session:event sent",
    );
    pending.timer = setTimeout(() => {
      if (!this.pendingSessionEvents.has(pending.ref)) return;
      this.rejectPendingSessionEvent(pending, "timeout");
    }, SESSION_EVENT_CONFIRM_TIMEOUT_MS);
    return pending.promise;
  }

  /** Ask the server which of the supplied chatIds the client should drop. */
  sendSessionReconcile(agentId: string, chatIds: string[]): void {
    if (!this.canSendAgentFrame(agentId) || !this.ws) return;
    this.ws.send(JSON.stringify({ type: "session:reconcile", agentId, chatIds }));
  }

  /** Reply to a `provider-models:list` reverse command with the host catalog. */
  sendProviderModelsResult(ref: string, catalog: ProviderModelCatalog): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: PROVIDER_MODELS_RESULT_TYPE, ref, catalog }));
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    this.connectAbort?.abort();
    this.clearTimers();
    this.rejectAllPendingBinds("Client disconnected");
    this.rejectAllPendingInboxAcks("Client disconnected");
    this.rejectAllPendingInboxRecovers("Client disconnected");
    this.rejectAllPendingInboxFenceProbes("Client disconnected");
    this.rejectAllPendingSessionEvents("Client disconnected");
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close(1000, "Client disconnect");
      } else if (this.ws.readyState === WebSocket.CONNECTING) {
        // CONNECTING socket would otherwise sit on the kernel TCP timeout
        // (~1–2 min) before resolving. With the new connect() retry loop the
        // odds of disconnect racing an in-flight handshake go from "rare"
        // (old behaviour: connect failure threw immediately) to "every shut-
        // down during backoff is one tick away from this case", so reach for
        // terminate to abort the handshake right now.
        this.ws.terminate();
      }
      this.ws = null;
    }
    this.registered = false;
    this.boundAgents.clear();
    this.socketBoundAgentIds.clear();
    this.emit("disconnected");
  }

  // ---- Bind helper --------------------------------------------------------

  private sendBind(agentId: string, runtimeType: string, runtimeVersion?: string): Promise<BoundAgent> {
    return new Promise<BoundAgent>((resolve, reject) => {
      const ref = randomUUID().slice(0, 12);
      this.pendingBinds.set(ref, { agentId, runtimeType, runtimeVersion, resolve, reject });
      this.ws?.send(
        JSON.stringify({
          type: "agent:bind",
          ref,
          agentId,
          runtimeType,
          runtimeVersion,
        }),
      );
    });
  }

  // ---- WebSocket management ----------------------------------------------

  private openWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = `${this.serverUrl.replace(/^http/, "ws")}/api/v1/agent/ws/client`;
      this.wsLogger.info({ url: wsUrl }, "connecting");
      // UA on the WS upgrade request closes a forensic gap: failures during
      // the upgrade (4401 close, expired token, handshake aborts) happen
      // before `client:register` lands, so without UA the trace has no install
      // identifier at all. Issue #246.
      const ws = new WebSocket(wsUrl, this.userAgent ? { headers: { "User-Agent": this.userAgent } } : undefined);
      let settled = false;

      const settle = (fn: typeof resolve | typeof reject, value?: unknown) => {
        if (settled) return;
        settled = true;
        if (this.wsConnectTimer) {
          clearTimeout(this.wsConnectTimer);
          this.wsConnectTimer = null;
        }
        if (fn === resolve) {
          (fn as typeof resolve)();
        } else {
          (fn as typeof reject)(value);
        }
      };

      this.wsConnectTimer = setTimeout(() => {
        this.wsConnectTimer = null;
        ws.terminate();
        settle(reject, new Error("WebSocket connect timeout"));
      }, WS_CONNECT_TIMEOUT_MS);

      ws.on("open", async () => {
        this.ws = ws;
        this.inboxAckFailCloseStarted = false;
        // Capability negotiation is per-connection: never carry a previous
        // server's Reset support into the register frame of a socket that may
        // have landed on a rolled-back replica.
        this.serverSupportsSessionResetV1 = false;
        // Don't reset reconnectAttempt here — a TCP/WS handshake succeeding
        // but the auth phase failing is exactly the loop the client.log
        // captured at 19:40 (1 Hz reconnect storm with `failed to obtain
        // access token`). Resetting on `open` collapsed the exponential
        // backoff to attempt=1 forever. Reset on the application-layer
        // success signal — `client:registered` — instead.
        this.wsLogger.debug("socket opened, sending auth");

        try {
          // Ask for a token still valid past our proactive-refresh lead
          // time, otherwise the cached token returned here would already be
          // inside the lead window and the next proactive refresh would be
          // a no-op — server would push `auth:expired` instead.
          //
          // The +5_000 is just a readability slack so the boundary check
          // explicitly clears the lead window rather than comparing equal.
          // Any positive epsilon would do; 5s reads as deliberate at a
          // glance and is small enough to never matter operationally.
          const token = await this.getAccessToken({ minValidityMs: AUTH_REFRESH_LEAD_MS + 5_000 });
          ws.send(JSON.stringify({ type: "auth", token }));
          // C5: arm the proactive refresh timer as soon as we've sent the
          // auth frame — auth:ok only confirms the token was accepted, the
          // exp itself is already fixed on the token payload.
          this.scheduleProactiveAuthRefresh(token);
        } catch (err) {
          this.authLogger.error({ err }, "failed to obtain access token");
          // Refresh token expired / revoked is unrecoverable from inside the
          // process — no amount of retrying will succeed without the
          // operator running `<binName> login <new-token>`. Mark the
          // connection closed so `ws.on("close")` doesn't reschedule, and
          // surface an `auth:fatal` event so the consumer (typically the
          // CLI) can print a recovery prompt and exit, letting systemd /
          // launchd back off instead of looping at the WS reconnect base.
          //
          // `name` duck-typed instead of `instanceof` so this file doesn't
          // pull a runtime dependency on the command package (one-way:
          // command depends on client, not the other way around).
          const e = err instanceof Error ? err : new Error(String(err));
          if (e.name === "AuthRefreshFailedError") {
            // Bug 2: instead of marking the connection permanently closed and
            // letting the consumer process.exit, enter paused mode. The
            // operator can recover by running the channel-aware login command and the
            // credentials-watcher will call clearPaused() to resume.
            this.enterPausedMode("auth_refresh_failed", e);
          } else if (e.name === "AuthRefreshRateLimitedError") {
            // Pull the server-suggested wait off the typed error and stash it
            // for the next scheduleReconnect; falls back to 30s if absent.
            // Without this floor the WS layer's 1/2/4/8s exponential backoff
            // hammers the rate-limit window from below and stretches the
            // outage from "1 minute" to "however long until the bucket
            // empties under our own load".
            const retryAfterMs = (e as { retryAfterMs?: number }).retryAfterMs ?? 30_000;
            this.nextReconnectMinDelayMs = Math.max(this.nextReconnectMinDelayMs, retryAfterMs);
            this.authLogger.warn({ retryAfterMs }, "refresh rate-limited; deferring reconnect");
          }
          settle(reject, e);
          ws.close();
        }
      });

      ws.on("message", (data) => {
        // Any inbound frame proves the peer is alive — refresh the silence
        // watchdog before parsing so malformed frames still count.
        this.lastServerMessageAt = Date.now();
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          this.handleMessage(msg, () => settle(resolve));
        } catch {
          // ignore malformed messages
        }
      });

      // RFC 6455 pong: the ws library auto-replies to peer pings, but we also
      // send our own pings from the heartbeat tick — those round-trips are
      // what surface a wedged socket within HEARTBEAT_TIMEOUT_MS.
      ws.on("pong", () => {
        this.lastServerMessageAt = Date.now();
      });

      ws.on("close", (code) => {
        this.stopHeartbeat();
        this.clearAuthRefreshTimer();
        this.clearPendingInboxRecoverTimers();
        this.clearPendingSessionEventTimers();
        const wasRegistered = this.registered;
        this.registered = false;
        this.socketBoundAgentIds.clear();
        this.rejectAllPendingBinds("WebSocket closed");
        this.rejectAllPendingInboxAcks("WebSocket closed");
        this.rejectAllPendingInboxRecovers("WebSocket closed");
        this.rejectAllPendingInboxFenceProbes("WebSocket closed");
        this.rejectAllPendingSessionEvents("WebSocket closed");

        if (!settled) {
          this.wsLogger.warn({ code }, "closed before ready");
          const typedErr = this.lastHandshakeError;
          this.lastHandshakeError = null;
          settle(reject, typedErr ?? new Error(`WebSocket closed before ready (code ${code})`));
          return;
        }

        // Code 1000 is a clean close — the only one we issue ourselves is
        // the proactive auth refresh, which is expected and recovers
        // silently. Surface it at info so genuine drops (4401, 1006, etc.)
        // remain warn-visible.
        if (code === 1000) {
          this.wsLogger.info({ code, wasRegistered }, "disconnected");
        } else {
          this.wsLogger.warn({ code, wasRegistered }, "disconnected");
        }
        if (!this.closing) {
          this.emit("disconnected");
          if (wasRegistered) this.scheduleReconnect();
        }
      });

      ws.on("error", (err) => {
        this.emit("error", err);
      });
    });
  }

  private handleMessage(msg: Record<string, unknown>, connectResolve?: () => void): void {
    const type = msg.type as string;

    if (type === "auth:ok") {
      this.authLogger.info("auth accepted, registering client");
      // Pull the last update attempt synchronously off disk so the
      // register frame carries up-to-date status. Throwing here would
      // kill registration, so we swallow any unexpected error (the
      // accessor reads a small JSON file — disk errors are the only
      // realistic failure mode, and the worst-case outcome is just
      // omitting the field, which the server schema already tolerates).
      let lastUpdateAttempt: UpdateAttempt | null = null;
      try {
        lastUpdateAttempt = this.getLastUpdateAttempt?.() ?? null;
      } catch (err) {
        this.authLogger.warn({ err }, "getLastUpdateAttempt threw; omitting from register frame");
      }
      this.ws?.send(
        JSON.stringify({
          type: "client:register",
          clientId: this.clientId,
          hostname: getHostname(),
          os: platform(),
          sdkVersion: this.sdkVersion,
          // Two-sided, VERSIONED Reset negotiation. `wsSessionResetV1` is the
          // whole protocol (apply-ack + parked-fence release + BOTH receipted
          // post-apply terminal dispositions: finalized for durable eviction
          // and aborted when the server could not finalize) and is declared
          // ONLY when this connection's welcome (sent before auth:ok)
          // advertised the same version. The legacy apply-only flag is
          // deliberately never sent: an old server reads it as Reset consent,
          // runs the pre-disposition flow, and answers the operator with a 200
          // while this client's inbox rows stay parked behind a fence that
          // server will never lift. Withholding it makes both skew directions
          // fail closed before anything destructive is applied locally. Old
          // servers ignore the unknown v1 field.
          wireCapabilities: {
            ...(this.serverSupportsSessionResetV1 ? { wsSessionResetV1: true } : {}),
          },
          ...(lastUpdateAttempt ? { lastUpdateAttempt } : {}),
        }),
      );
      return;
    }

    if (type === "server:welcome") {
      const parsed = serverWelcomeFrameSchema.safeParse(msg);
      if (!parsed.success) {
        // Malformed welcome frame from a buggy server build — log and drop.
        // Old clients that never knew about this frame simply fall through,
        // so treating a parse failure the same way keeps behaviour aligned.
        this.wsLogger.warn(
          { issues: parsed.error.issues.map((i) => i.message) },
          "ignoring malformed server:welcome frame",
        );
        return;
      }
      const isReconnect = this.welcomeFramesReceived > 0;
      this.welcomeFramesReceived++;
      this.serverSupportsInboxAckConfirm = parsed.data.capabilities?.wsInboxAckConfirm === true;
      this.serverSupportsSessionEventConfirm = parsed.data.capabilities?.wsSessionEventConfirm === true;
      this.serverSupportsSessionResetV1 = parsed.data.capabilities?.wsSessionResetV1 === true;
      this.emit("server:welcome", { frame: parsed.data, isReconnect });
      return;
    }

    if (type === "auth:expired") {
      // The close handler reads `this.registered` to decide whether to
      // reconnect; clearing it here would make that decision see post-close
      // state and skip the reconnect after a mid-session auth:expired push.
      const parsed = authExpiredFrameSchema.safeParse(msg);
      if (!parsed.success) {
        this.authLogger.warn(
          { issues: parsed.error.issues.map((i) => i.message) },
          "auth:expired frame did not match current schema; treating by frame type",
        );
      }
      this.authLogger.info("token expired, reconnecting with fresh token");
      this.emit("auth:expired");
      this.ws?.close(4401, type);
      return;
    }

    if (type === "auth:retryable") {
      const parsed = authRetryableFrameSchema.safeParse(msg);
      if (parsed.success) {
        const { code, retryAfterMs, message } = parsed.data;
        if (retryAfterMs !== undefined) {
          this.nextReconnectMinDelayMs = Math.max(this.nextReconnectMinDelayMs, retryAfterMs);
        }
        this.authLogger.warn({ code, retryAfterMs, message }, "server reported retryable auth handshake failure");
      } else {
        this.authLogger.warn(
          { issues: parsed.error.issues.map((i) => i.message) },
          "auth:retryable frame did not match current schema; retrying by frame type",
        );
      }
      this.ws?.close(1013, "auth retryable");
      return;
    }

    if (type === "auth:rejected") {
      // auth:rejected means deterministic credential/identity failure.
      // Retryable server-side handshake failures must arrive as
      // auth:retryable or a retryable close code, never as a message string
      // that the client has to interpret.
      const parsed = authRejectedFrameSchema.safeParse(msg);
      const err = parsed.success
        ? new ServerAuthRejectedError({ code: parsed.data.code, message: parsed.data.message })
        : new ServerAuthRejectedError({
            unsupportedCode: typeof msg.code === "string" ? msg.code : undefined,
            legacyReason: typeof msg.reason === "string" ? msg.reason : undefined,
          });
      if (parsed.success) {
        this.authLogger.warn({ code: parsed.data.code, message: parsed.data.message }, "auth rejected by server");
      } else {
        this.authLogger.warn(
          {
            rawCode: typeof msg.code === "string" ? msg.code : undefined,
            legacyReason: typeof msg.reason === "string" ? msg.reason : undefined,
            issues: parsed.error.issues.map((i) => i.message),
          },
          "auth:rejected frame did not match current schema; treating as deterministic auth rejection",
        );
      }
      this.lastHandshakeError = err;
      this.enterPausedMode("auth_rejected", err);
      this.ws?.close(4401, "auth rejected");
      return;
    }

    if (type === "client:register:rejected") {
      const code = typeof msg.code === "string" ? msg.code : undefined;
      const message = typeof msg.message === "string" ? msg.message : "unknown";
      // Mark closing so the WS `close` handler does not auto-reconnect — a
      // reconnect with the same clientId would just re-trigger the rejection.
      // The caller (CLI) is expected to surface the mismatch to the user and
      // guide account switches through local-client switching.
      this.closing = true;
      const err =
        code === "CLIENT_USER_MISMATCH"
          ? new ClientUserMismatchError(message)
          : code === "CLIENT_RETIRED"
            ? new ClientRetiredError(message)
            : code === "CLIENT_ORG_MISMATCH"
              ? new ClientOrgMismatchError(message)
              : new Error(`client:register rejected: ${message}`);
      this.lastHandshakeError = err;
      this.wsLogger.error({ code, message }, "client register rejected");
      this.emit("error", err);
      this.ws?.close(4403, "register rejected");
      return;
    }

    if (type === "client:registered") {
      const isReconnect = this.boundAgents.size > 0 || this.desiredBindings.size > 0;
      this.registered = true;
      // Application-layer success — only now is it safe to reset the backoff
      // counter. A TCP-only success (`ws.on("open")`) is not enough; an auth
      // failure between `open` and `client:registered` would otherwise
      // collapse the exponential backoff to attempt=1.
      this.reconnectAttempt = 0;
      this.startHeartbeat();
      this.wsLogger.info({ isReconnect }, "registered");
      this.emit("connected");
      connectResolve?.();

      if (isReconnect) {
        this.rebindAgents();
      }
      return;
    }

    if (type === "agent:bound") {
      const agentId = msg.agentId as string;
      const ref = msg.ref as string | undefined;
      const pending = ref ? this.pendingBinds.get(ref) : undefined;
      if (ref) this.pendingBinds.delete(ref);
      if (pending) {
        const runtimeSessionToken =
          typeof msg.runtimeSessionToken === "string" && msg.runtimeSessionToken.length > 0
            ? msg.runtimeSessionToken
            : undefined;
        const sdk = new FirstTreeHubSDK({
          serverUrl: this.serverUrl,
          getAccessToken: this.getAccessToken,
          agentId,
          runtimeSessionToken: () =>
            this.runtimeSessionTokenProviders.has(agentId)
              ? this.resolveRuntimeSessionToken(agentId)
              : runtimeSessionToken,
          userAgent: this.userAgent,
        });
        const agent: BoundAgent = {
          agentId,
          // Phase 2: server always sends a non-null displayName; fall back to
          // the agentId defensively so a schema-mismatched frame from an
          // older server doesn't crash the runtime.
          displayName: (msg.displayName as string | null) ?? agentId,
          agentType: (msg.agentType as string) ?? "agent",
          runtimeSessionToken,
          sdk,
        };
        this.boundAgents.set(agentId, agent);
        this.socketBoundAgentIds.add(agentId);
        this.emit("agent:bound", agent);
        pending.resolve(agent);
        this.flushPendingInboxAcks();
      }
      return;
    }

    if (type === "agent:bind:rejected") {
      const ref = msg.ref as string | undefined;
      const reason = (msg.reason as AgentBindRejectReason) ?? "wrong_client";
      const pending = ref ? this.pendingBinds.get(ref) : undefined;
      if (ref && pending) {
        this.pendingBinds.delete(ref);
        // Bug 5: classify the reason and update the per-agent retry record.
        // Transient → exponential backoff; degraded/permanent → never retry.
        const classification = classify({ reason }, { source: "bind" });
        const record = this.bindRetryRecords.get(pending.agentId) ?? {
          attempts: 0,
          nextAllowedAt: 0,
          lastReason: null,
        };
        record.attempts += 1;
        record.lastReason = classification.reasonCode;
        if (classification.kind === ERROR_KINDS.TRANSIENT) {
          record.nextAllowedAt = Date.now() + nextRetryDelayMs(classification.strategy, record.attempts);
        } else {
          record.nextAllowedAt = Number.MAX_SAFE_INTEGER;
          this.wsLogger.warn(
            {
              agentId: pending.agentId,
              reason,
              reasonCode: classification.reasonCode,
              resilienceEvent: "resilience.bind.disabled",
            },
            "bind permanently disabled — operator action required",
          );
          this.emit("resilience.bind.disabled", {
            agentId: pending.agentId,
            reasonCode: classification.reasonCode,
          });
        }
        this.bindRetryRecords.set(pending.agentId, record);
        this.rejectPendingInboxAcksForAgent(pending.agentId, `agent_bind_rejected:${reason}`);
        this.rejectPendingInboxRecoversForAgent(pending.agentId, `agent_bind_rejected:${reason}`);
        this.rejectPendingSessionEventsForAgent(pending.agentId, `agent_bind_rejected:${reason}`);
        this.emit("agent:bind:rejected", reason, pending.agentId);
        pending.reject(new Error(`agent:bind rejected (${reason})`));
      }
      return;
    }

    if (type === "agent:unbound") {
      const agentId = msg.agentId as string;
      this.boundAgents.delete(agentId);
      this.socketBoundAgentIds.delete(agentId);
      this.rejectPendingInboxAcksForAgent(agentId, "agent_unbound");
      this.rejectPendingInboxRecoversForAgent(agentId, "agent_unbound");
      this.rejectPendingInboxFenceProbesForAgent(agentId, "agent_unbound");
      this.rejectPendingSessionEventsForAgent(agentId, "agent_unbound");
      this.emit("agent:unbound", agentId);
      return;
    }

    if (type === "agent:pinned") {
      const parsed = agentPinnedMessageSchema.safeParse(msg);
      if (parsed.success) {
        // Bug 5: a fresh pin from the server is operator intent — clear any
        // existing bind backoff so the next rebindAgents attempt picks the
        // agent up immediately instead of sitting inside its window.
        this.bindRetryRecords.delete(parsed.data.agentId);
        this.emit("agent:pinned", parsed.data);
      }
      return;
    }

    if (type === "agent:force_disconnect") {
      const agentId = msg.agentId as string;
      if (agentId && this.boundAgents.has(agentId)) {
        this.boundAgents.delete(agentId);
        this.socketBoundAgentIds.delete(agentId);
        this.rejectPendingInboxAcksForAgent(agentId, "agent_force_disconnect");
        this.rejectPendingInboxRecoversForAgent(agentId, "agent_force_disconnect");
        this.rejectPendingSessionEventsForAgent(agentId, "agent_force_disconnect");
        this.emit("agent:unbound", agentId, typeof msg.reason === "string" ? msg.reason : "server_forced");
      }
      return;
    }

    if (type === "session:suspend" || type === "session:resume" || type === "session:terminate") {
      const agentId = msg.agentId as string;
      const chatId = msg.chatId as string;
      const ref = typeof msg.ref === "string" && msg.ref.length > 0 ? msg.ref : undefined;
      if (agentId && chatId) {
        this.emit("session:command", {
          type: type as SessionCommand["type"],
          agentId,
          chatId,
          ...(ref ? { ref } : {}),
        });
      }
      return;
    }

    if (type === "session:command:finalized") {
      const parsed = sessionCommandFinalizedFrameSchema.safeParse(msg);
      if (!parsed.success) {
        this.wsLogger.warn(
          { issues: parsed.error.issues.map((i) => i.message) },
          "ignoring malformed session:command:finalized frame",
        );
        return;
      }
      this.emit("session:command:finalized", parsed.data);
      return;
    }

    if (type === "session:command:aborted") {
      const parsed = sessionCommandAbortedFrameSchema.safeParse(msg);
      if (!parsed.success) {
        this.wsLogger.warn(
          { issues: parsed.error.issues.map((i) => i.message) },
          "ignoring malformed session:command:aborted frame",
        );
        return;
      }
      this.emit("session:command:aborted", parsed.data);
      return;
    }

    if (type === RUNTIME_AUTH_START_TYPE) {
      const parsed = runtimeAuthStartCommandSchema.safeParse(msg);
      if (parsed.success) {
        const { provider, method, ref } = parsed.data;
        this.emit("runtime-auth:start", { provider, method, ref });
      }
      return;
    }

    if (type === PROVIDER_MODELS_LIST_TYPE) {
      const parsed = providerModelsListCommandSchema.safeParse(msg);
      if (parsed.success) {
        const { provider, ref } = parsed.data;
        this.emit("provider-models:list", { provider, ref });
      }
      return;
    }

    if (type === "session:reconcile:result") {
      const agentId = msg.agentId as string;
      const staleChatIds = Array.isArray(msg.staleChatIds) ? (msg.staleChatIds as string[]) : null;
      if (agentId && staleChatIds) {
        this.emit("session:reconcile:result", { agentId, staleChatIds });
      }
      return;
    }

    if (type === "session:event:accepted") {
      const parsed = sessionEventAcceptedFrameSchema.safeParse(msg);
      if (!parsed.success) {
        this.wsLogger.warn(
          { issues: parsed.error.issues.map((i) => i.message) },
          "ignoring malformed session:event:accepted frame",
        );
        return;
      }
      const pending = this.pendingSessionEvents.get(parsed.data.ref);
      if (!pending || pending.agentId !== parsed.data.agentId || pending.chatId !== parsed.data.chatId) {
        this.wsLogger.debug(
          {
            agentId: parsed.data.agentId,
            chatId: parsed.data.chatId,
            ref: parsed.data.ref,
            sessionEvent: "session_event_no_match",
          },
          "session:event:accepted matched no pending event",
        );
        return;
      }
      this.resolvePendingSessionEvent(pending);
      return;
    }

    if (type === "session:event:rejected") {
      const parsed = sessionEventRejectedFrameSchema.safeParse(msg);
      if (!parsed.success) {
        this.wsLogger.warn(
          { issues: parsed.error.issues.map((i) => i.message) },
          "ignoring malformed session:event:rejected frame",
        );
        return;
      }
      const pending = this.pendingSessionEvents.get(parsed.data.ref);
      if (!pending || pending.agentId !== parsed.data.agentId) {
        this.wsLogger.debug(
          {
            agentId: parsed.data.agentId,
            chatId: parsed.data.chatId ?? null,
            ref: parsed.data.ref,
            sessionEvent: "session_event_no_match",
          },
          "session:event:rejected matched no pending event",
        );
        return;
      }
      this.rejectPendingSessionEvent(pending, parsed.data.reason);
      return;
    }

    if (type === "inbox:ack:accepted") {
      const parsed = inboxAckAcceptedFrameSchema.safeParse(msg);
      if (!parsed.success) {
        this.wsLogger.warn(
          { issues: parsed.error.issues.map((i) => i.message) },
          "ignoring malformed inbox:ack:accepted frame",
        );
        return;
      }
      const pending = this.pendingInboxAcks.get(parsed.data.entryId);
      if (!pending || pending.ref !== parsed.data.ref) {
        this.wsLogger.debug(
          {
            entryId: parsed.data.entryId,
            ref: parsed.data.ref,
            ackEvent: "inbox_ack_no_match",
          },
          "inbox:ack:accepted matched no pending ack",
        );
        return;
      }
      this.resolvePendingInboxAck(pending, parsed.data.disposition);
      return;
    }

    if (type === "inbox:ack:rejected") {
      const parsed = inboxAckRejectedFrameSchema.safeParse(msg);
      if (!parsed.success) {
        this.wsLogger.warn(
          { issues: parsed.error.issues.map((i) => i.message) },
          "ignoring malformed inbox:ack:rejected frame",
        );
        return;
      }
      const pending = this.pendingInboxAcks.get(parsed.data.entryId);
      if (!pending || pending.ref !== parsed.data.ref) {
        this.wsLogger.debug(
          {
            entryId: parsed.data.entryId,
            ref: parsed.data.ref,
            ackEvent: "inbox_ack_no_match",
          },
          "inbox:ack:rejected matched no pending ack",
        );
        return;
      }
      this.rejectPendingInboxAck(pending, parsed.data.reason);
      return;
    }

    if (type === "inbox:recover:accepted") {
      const parsed = inboxRecoverAcceptedFrameSchema.safeParse(msg);
      if (!parsed.success) {
        this.wsLogger.warn(
          { issues: parsed.error.issues.map((i) => i.message) },
          "ignoring malformed inbox:recover:accepted frame",
        );
        return;
      }
      const pending = this.pendingInboxRecovers.get(parsed.data.ref);
      if (!pending || pending.agentId !== parsed.data.agentId || pending.chatId !== parsed.data.chatId) {
        this.wsLogger.debug(
          {
            agentId: parsed.data.agentId,
            chatId: parsed.data.chatId,
            ref: parsed.data.ref,
            recoverEvent: "inbox_recover_no_match",
          },
          "inbox:recover:accepted matched no pending recovery",
        );
        return;
      }
      this.resolvePendingInboxRecover(pending, parsed.data.resetCount, parsed.data.unackedOutstanding);
      return;
    }

    if (type === "inbox:fence-probe:accepted") {
      const parsed = inboxFenceProbeAcceptedFrameSchema.safeParse(msg);
      if (!parsed.success) {
        this.wsLogger.warn(
          { issues: parsed.error.issues.map((i) => i.message) },
          "ignoring malformed inbox:fence-probe:accepted frame",
        );
        return;
      }
      const pending = this.pendingInboxFenceProbes.get(parsed.data.ref);
      if (!pending || pending.agentId !== parsed.data.agentId || pending.chatId !== parsed.data.chatId) {
        this.wsLogger.debug(
          { agentId: parsed.data.agentId, chatId: parsed.data.chatId, ref: parsed.data.ref },
          "inbox:fence-probe:accepted matched no pending probe",
        );
        return;
      }
      this.resolvePendingInboxFenceProbe(pending, parsed.data.settledMessageIds);
      return;
    }

    if (type === "inbox:fence-probe:rejected") {
      const parsed = inboxFenceProbeRejectedFrameSchema.safeParse(msg);
      if (!parsed.success) {
        this.wsLogger.warn(
          { issues: parsed.error.issues.map((i) => i.message) },
          "ignoring malformed inbox:fence-probe:rejected frame",
        );
        return;
      }
      const pending = this.pendingInboxFenceProbes.get(parsed.data.ref);
      if (!pending) return;
      this.rejectPendingInboxFenceProbe(pending, parsed.data.reason);
      return;
    }

    if (type === "inbox:recover:rejected") {
      const parsed = inboxRecoverRejectedFrameSchema.safeParse(msg);
      if (!parsed.success) {
        this.wsLogger.warn(
          { issues: parsed.error.issues.map((i) => i.message) },
          "ignoring malformed inbox:recover:rejected frame",
        );
        return;
      }
      const pending = this.pendingInboxRecovers.get(parsed.data.ref);
      if (!pending || pending.agentId !== parsed.data.agentId) {
        this.wsLogger.debug(
          {
            agentId: parsed.data.agentId,
            chatId: parsed.data.chatId ?? null,
            ref: parsed.data.ref,
            recoverEvent: "inbox_recover_no_match",
          },
          "inbox:recover:rejected matched no pending recovery",
        );
        return;
      }
      this.rejectPendingInboxRecover(pending, parsed.data.reason);
      return;
    }

    if (type === "inbox:deliver") {
      const parsed = inboxDeliverFrameSchema.safeParse(msg);
      if (!parsed.success) {
        // Do not ack malformed deliver frames. `inbox:ack` is ack-through
        // now, so using it here could commit earlier delivered rows whose
        // handler work has not completed. Leave the row delivered; the next
        // bind reset will replay it and surface the schema drift again.
        const rawEntryId = msg.entryId;
        const entryIdDropped =
          typeof rawEntryId === "number" && Number.isInteger(rawEntryId) && rawEntryId >= 0 ? rawEntryId : null;
        // Per-issue path/message + the receiving frame keys so we can pinpoint
        // shape drift between server build and client schema during gradual
        // rollouts. Frame body intentionally not logged in full — message
        // content can be sensitive — but the top-level keys + missing/extra
        // fields are enough to spot e.g. a renamed/dropped column.
        this.wsLogger.warn(
          {
            issues: parsed.error.issues.map((i) => ({
              path: i.path.join("."),
              code: i.code,
              message: i.message,
            })),
            frameKeys: Object.keys(msg),
            messageKeys: msg.message && typeof msg.message === "object" ? Object.keys(msg.message) : null,
            entryIdDropped,
          },
          "malformed inbox:deliver frame — dropping",
        );
        return;
      }
      this.emit("inbox:deliver", parsed.data.inboxId, parsed.data);
      return;
    }

    if (type === "error") {
      const errorMsg = msg.message as string;
      const ref = msg.ref as string | undefined;
      const pending = ref ? this.pendingBinds.get(ref) : undefined;
      if (pending && ref) {
        this.pendingBinds.delete(ref);
        pending.reject(new Error(errorMsg));
      } else {
        this.emit("error", new Error(errorMsg));
      }
    }
  }

  /**
   * Re-bind all agents after reconnection. Bug 5: each agent has its own
   * per-rejection backoff window, so a single bad agent does not spam the
   * server or our logs on every reconnect. Agents that exhausted their
   * window are skipped; logs note them at debug level.
   */
  private rebindAgents(): void {
    this.emit("reconnected");
    const now = Date.now();
    for (const desired of this.desiredBindings.values()) {
      const record = this.bindRetryRecords.get(desired.agentId);
      if (record && record.nextAllowedAt > now) {
        // Within backoff window — skip but emit a structured event so the
        // operator / future web surface can see how many agents are paused.
        this.wsLogger.debug(
          {
            agentId: desired.agentId,
            attempts: record.attempts,
            nextAllowedAt: record.nextAllowedAt,
            lastReason: record.lastReason,
            resilienceEvent: "resilience.bind.skipped",
          },
          "bind skipped — within backoff window",
        );
        this.emit("resilience.bind.skipped", {
          agentId: desired.agentId,
          attempts: record.attempts,
          nextAllowedAt: record.nextAllowedAt,
          lastReasonCode: record.lastReason,
        });
        this.rejectPendingInboxAcksForAgent(desired.agentId, "agent_rebind_skipped");
        this.rejectPendingInboxRecoversForAgent(desired.agentId, "agent_rebind_skipped");
        this.rejectPendingSessionEventsForAgent(desired.agentId, "agent_rebind_skipped");
        continue;
      }
      const previousAttempts = record?.attempts ?? 0;
      this.sendBind(desired.agentId, desired.runtimeType, desired.runtimeVersion)
        .then((rebound) => {
          this.bindRetryRecords.delete(rebound.agentId);
          this.boundAgents.set(rebound.agentId, rebound);
          this.wsLogger.info(
            { agentId: rebound.agentId, resilienceEvent: "resilience.bind.recovered" },
            "agent rebind recovered",
          );
          if (previousAttempts > 0) {
            this.emit("resilience.bind.recovered", {
              agentId: rebound.agentId,
              totalAttempts: previousAttempts,
            });
          }
        })
        .catch((err) => {
          this.boundAgents.delete(desired.agentId);
          // The `agent:bind:rejected` handler already updated the retry
          // record + emitted any structured event. We still drop the
          // unbound notification so listeners see the agent went away.
          this.emit("agent:unbound", desired.agentId);
          this.wsLogger.debug(
            { agentId: desired.agentId, err: err instanceof Error ? err.message : String(err) },
            "rebind attempt rejected",
          );
        });
    }
  }

  /**
   * Clear the per-agent bind backoff so the next reconnect retries this
   * agent immediately. Called from `bindAgent` (operator just asked to bind
   * a specific agent) and exposed for higher-level recovery flows.
   */
  resetBindRetry(agentId: string): void {
    if (this.bindRetryRecords.delete(agentId)) {
      this.wsLogger.info({ agentId }, "bind retry record cleared");
    }
  }

  /**
   * Enter paused mode (Bug 2): suspend reconnect attempts, keep the
   * connection object alive so the operator can recover by writing fresh
   * credentials. Emits both `auth:paused` (preferred) and `auth:fatal` (back-
   * compat for consumers that haven't migrated yet).
   */
  private enterPausedMode(reason: ClientPausedReason, error: Error): void {
    if (this.pausedReason === reason) {
      // Already paused for the same reason; still emit so a duplicate auth
      // rejection during reconnect is observable, but don't kick the
      // reconnect timer.
      this.emit("auth:paused", reason, error);
      this.emit("auth:fatal", error);
      this.emit("resilience.connection.paused", { reason });
      return;
    }
    this.pausedReason = reason;
    this.wsLogger.warn(
      { reason, resilienceEvent: "resilience.connection.paused" },
      "entering auth paused mode — will await fresh credentials",
    );
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.emit("auth:paused", reason, error);
    this.emit("auth:fatal", error);
    this.emit("resilience.connection.paused", { reason });
  }

  private consumeReconnectDelay(attempt: number): { delayMs: number; floorMs: number } {
    const exponential = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
    const floorMs = this.nextReconnectMinDelayMs;
    this.nextReconnectMinDelayMs = 0;
    let delayMs = Math.max(exponential, floorMs);
    if (floorMs > 0) {
      // Add up to 20% jitter only to explicit retry floors, where many
      // clients may otherwise wake at the same server-suggested deadline.
      // Never subtract from the floor: Retry-After is a lower bound.
      const jitter = delayMs * 0.2 * Math.random();
      delayMs = Math.round(delayMs + jitter);
    }
    return { delayMs, floorMs };
  }

  private scheduleReconnect(): void {
    // Guard against an entry from auth:fatal / disconnect() racing with the
    // close handler — `closing=true` means "no more reconnects", honoured here.
    if (this.closing) return;
    // Bug 2: paused mode suspends reconnect until clearPaused() fires.
    if (this.pausedReason !== null) {
      this.wsLogger.debug({ pausedReason: this.pausedReason }, "skipping reconnect — connection is paused");
      return;
    }
    this.reconnectAttempt++;
    this.emit("reconnecting", this.reconnectAttempt);

    const { delayMs, floorMs } = this.consumeReconnectDelay(this.reconnectAttempt);
    this.wsLogger.debug(
      { attempt: this.reconnectAttempt, delayMs, floorMs: floorMs || undefined },
      "scheduling reconnect",
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closing) {
        this.openWebSocket().catch((err) => {
          this.emit("error", err instanceof Error ? err : new Error(String(err)));
          if (!this.closing) this.scheduleReconnect();
        });
      }
    }, delayMs);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // Seed the watchdog so the first tick doesn't immediately trip on a fresh
    // socket that has only seen the welcome frame.
    this.lastServerMessageAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      // Silence watchdog: if neither a data frame nor a pong has come back
      // within HEARTBEAT_TIMEOUT_MS, the TCP half is presumably dead (this
      // is exactly the OS-suspend / NAT-rebind / silent-router-drop shape
      // where readyState stays OPEN but bytes never arrive). Force a close
      // so the existing handler reschedules a reconnect — sending another
      // heartbeat on a wedged socket would just queue bytes nobody reads.
      const silenceMs = Date.now() - this.lastServerMessageAt;
      if (silenceMs > this.heartbeatTimeoutMs) {
        this.wsLogger.warn(
          { silenceMs, timeoutMs: this.heartbeatTimeoutMs },
          "no server activity within heartbeat timeout — terminating socket to force reconnect",
        );
        ws.terminate();
        return;
      }

      // Application-level heartbeat keeps server-side presence /
      // last-seen counters fresh (clientService.heartbeatClient,
      // presenceService.touchAgent). RFC 6455 ping is what the watchdog
      // actually relies on — the ws library on the server side
      // auto-replies with a pong, giving us a transport-level liveness
      // check independent of any application handler. Both are wrapped:
      // a send() race against readyState (e.g. the socket transitioned to
      // CLOSING between the guard and the call) would otherwise propagate
      // out of the interval callback as an unhandled exception. The
      // silence watchdog above is the source of truth — losing a single
      // send is fine.
      try {
        const frame: { type: string; pausedReason?: ClientPausedReason } = { type: "heartbeat" };
        if (this.pausedReason !== null) frame.pausedReason = this.pausedReason;
        ws.send(JSON.stringify(frame));
        ws.ping();
      } catch {
        // ignore — the silence watchdog above is the source of truth
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private rejectAllPendingBinds(reason: string): void {
    for (const [, pending] of this.pendingBinds) {
      pending.reject(new Error(reason));
    }
    this.pendingBinds.clear();
  }

  private rejectAllPendingInboxAcks(reason: string): void {
    for (const pending of this.pendingInboxAcks.values()) {
      this.clearPendingInboxAckTimer(pending);
      pending.reject(new Error(reason));
    }
    this.pendingInboxAcks.clear();
  }

  private rejectPendingInboxAcksForAgent(agentId: string, reason: string): void {
    for (const pending of [...this.pendingInboxAcks.values()]) {
      if (pending.agentId === agentId) this.rejectPendingInboxAck(pending, reason);
    }
  }

  private rejectAllPendingInboxRecovers(reason: string): void {
    for (const pending of this.pendingInboxRecovers.values()) {
      this.clearPendingInboxRecoverTimer(pending);
      pending.reject(new Error(reason));
    }
    this.pendingInboxRecovers.clear();
  }

  private rejectPendingInboxRecoversForAgent(agentId: string, reason: string): void {
    for (const pending of [...this.pendingInboxRecovers.values()]) {
      if (pending.agentId === agentId) this.rejectPendingInboxRecover(pending, reason);
    }
  }

  private rejectAllPendingSessionEvents(reason: string): void {
    for (const pending of this.pendingSessionEvents.values()) {
      this.clearPendingSessionEventTimer(pending);
      pending.reject(new Error(reason));
    }
    this.pendingSessionEvents.clear();
  }

  private rejectPendingSessionEventsForAgent(agentId: string, reason: string): void {
    for (const pending of [...this.pendingSessionEvents.values()]) {
      if (pending.agentId === agentId) this.rejectPendingSessionEvent(pending, reason);
    }
  }

  private clearPendingSessionEventTimers(): void {
    for (const pending of this.pendingSessionEvents.values()) {
      this.clearPendingSessionEventTimer(pending);
    }
  }

  private clearPendingInboxAckTimers(): void {
    for (const pending of this.pendingInboxAcks.values()) {
      this.clearPendingInboxAckTimer(pending);
    }
  }

  private clearPendingInboxRecoverTimers(): void {
    for (const pending of this.pendingInboxRecovers.values()) {
      this.clearPendingInboxRecoverTimer(pending);
    }
  }

  private clearTimers(): void {
    this.stopHeartbeat();
    if (this.wsConnectTimer) {
      clearTimeout(this.wsConnectTimer);
      this.wsConnectTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearAuthRefreshTimer();
    this.clearPendingInboxAckTimers();
    this.clearPendingInboxRecoverTimers();
  }

  private clearAuthRefreshTimer(): void {
    if (this.authRefreshTimer) {
      clearTimeout(this.authRefreshTimer);
      this.authRefreshTimer = null;
    }
  }

  /**
   * Proactive JWT refresh (C5). Schedule a silent reconnect ~60s before the
   * access token expires so `getAccessToken()` is asked for a fresh JWT
   * before the server's scheduleAuthExpiry timer fires. Short-lived tokens
   * (exp <= lead window) skip the proactive reconnect entirely — we let the
   * server push `auth:expired` and handle that path.
   *
   * Order is "refresh-then-close", not "close-then-let-reconnect-refresh".
   * The earlier shape relied on the new connection's open handler to do the
   * `/auth/refresh` HTTP, which forced ≥1s of WS downtime per cycle even on
   * the happy path (one base reconnect delay + the refresh round-trip) and
   * compounded badly under 429: every retry attempt also closed/reopened the
   * WS, holding the agent offline for 15-20s while the limiter cooled down.
   * Refreshing first lets us swap the new token onto a still-open WS with no
   * observable disconnect when the refresh succeeds; the original close-and-
   * reconnect flow only runs on failure as a last-ditch fallback (it'll hit
   * the same 429 on its next retry, but at least the Retry-After floor is
   * now wired up so we don't pile attempts inside the same window).
   */
  private scheduleProactiveAuthRefresh(token: string): void {
    this.clearAuthRefreshTimer();
    const exp = decodeJwtExp(token);
    if (!exp) return;
    const delay = exp * 1000 - Date.now() - AUTH_REFRESH_LEAD_MS;
    if (delay <= 0) return;
    this.authLogger.debug({ delayMs: delay }, "scheduled proactive auth refresh");
    this.authRefreshTimer = setTimeout(() => {
      void this.runProactiveAuthRefresh();
    }, delay);
  }

  private async runProactiveAuthRefresh(): Promise<void> {
    this.authRefreshTimer = null;
    if (this.closing) return;
    this.authLogger.info("triggering proactive auth refresh");
    try {
      // Force a fetch — the cached token is by definition still inside the
      // 60s lead window here, so we ask for >lead validity to make
      // ensureFreshAccessToken treat it as stale and call /auth/refresh.
      // The returned token is also written to credentials.json by the
      // bootstrap layer, so the reconnect that follows can pick it up
      // without a second HTTP round-trip.
      await this.getAccessToken({ minValidityMs: AUTH_REFRESH_LEAD_MS + 5_000 });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (e.name === "AuthRefreshRateLimitedError") {
        // Stash Retry-After for the close-handler-driven scheduleReconnect
        // that fires below — without this it would reuse the 1s base delay
        // and hammer the limiter inside the same 60s window.
        const retryAfterMs = (e as { retryAfterMs?: number }).retryAfterMs ?? 30_000;
        this.nextReconnectMinDelayMs = Math.max(this.nextReconnectMinDelayMs, retryAfterMs);
        this.authLogger.warn({ retryAfterMs }, "proactive refresh rate-limited; deferring reconnect");
      } else if (e.name === "AuthRefreshFailedError") {
        // Refresh token revoked/expired — Bug 2: enter paused mode instead
        // of marking the connection closed. Skip the close-and-reconnect
        // dance; reconnecting would just throw the same error from the open
        // handler. clearPaused() (driven by the credentials watcher) will
        // resume.
        this.enterPausedMode("auth_refresh_failed", e);
        return;
      } else {
        this.authLogger.warn({ err: e }, "proactive refresh failed; falling back to reconnect path");
      }
      // Fall through to close — the legacy reconnect-driven retry path
      // takes over from here.
    }

    // Close gracefully whether refresh succeeded or not. On success the
    // close handler triggers a reconnect whose open handler reads the
    // freshly-cached token (no second /auth/refresh), collapsing the
    // disconnect window to a single TCP/WS handshake (~1 RTT). On failure
    // it falls back to the original close-then-retry flow with the
    // 429-aware backoff floor in place.
    this.ws?.close(1000, "proactive auth refresh");
  }
}
