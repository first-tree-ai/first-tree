import { z } from "zod";

export const PRESENCE_STATUSES = {
  ONLINE: "online",
  OFFLINE: "offline",
} as const;

export const presenceStatusSchema = z.enum(["online", "offline"]);
export type PresenceStatus = z.infer<typeof presenceStatusSchema>;

/**
 * Reason a client is online-but-paused (Bug 2 / client-resilience design §5.2).
 * The client is still connected and answering heartbeats, but is intentionally
 * not processing inbox messages until the underlying issue resolves. Server
 * may surface this in admin UIs; clients on the wire just ignore the field.
 */
export const CLIENT_PAUSED_REASONS = {
  AUTH_REJECTED: "auth_rejected",
  AUTH_REFRESH_FAILED: "auth_refresh_failed",
} as const;
export const clientPausedReasonSchema = z.enum(["auth_rejected", "auth_refresh_failed"]);
export type ClientPausedReason = z.infer<typeof clientPausedReasonSchema>;

// -- Runtime State --

export const RUNTIME_STATES = {
  IDLE: "idle",
  WORKING: "working",
  BLOCKED: "blocked",
  ERROR: "error",
} as const;

export const runtimeStateSchema = z.enum(["idle", "working", "blocked", "error"]);
export type RuntimeState = z.infer<typeof runtimeStateSchema>;

// -- Session State --

export const SESSION_STATES = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
  EVICTED: "evicted",
  /**
   * Handler-start (or resume) raised an exception before the session was
   * usable. Distinct from `suspended` (which is the client's idle / preempted
   * state and means "resumable on next message"); `errored` records a
   * concrete failure that ops / admin / the user should see. The next inbound
   * message for the chat is still allowed to start a fresh session — see
   * docs/workspace-session-branch-collision-fix-design.md §3.3.
   */
  ERRORED: "errored",
} as const;

/** DB + admin surface. `evicted` is server-only (admin Terminate); never carried on the wire. */
export const sessionStateSchema = z.enum(["active", "suspended", "evicted", "errored"]);
export type SessionState = z.infer<typeof sessionStateSchema>;

/** Wire-level states a client may report. `evicted` from a stale client is rejected. */
export const clientSessionStateSchema = z.enum(["active", "suspended", "errored"]);
export type ClientSessionState = z.infer<typeof clientSessionStateSchema>;

export const sessionStateMessageSchema = z.object({
  chatId: z.string().min(1),
  state: clientSessionStateSchema,
});
export type SessionStateMessage = z.infer<typeof sessionStateMessageSchema>;

/** Client-reported runtime state override (client → server, per-agent). */
export const runtimeStateMessageSchema = z.object({
  runtimeState: runtimeStateSchema,
});
export type RuntimeStateMessage = z.infer<typeof runtimeStateMessageSchema>;

/**
 * Client-reported runtime state at **per-(agent, chat)** granularity
 * (client → server). The agent-global `runtimeStateMessageSchema` (no chatId)
 * is a lossy aggregate that the per-chat composite cannot consume safely (an
 * agent working in chat A would light chat B — #366). This frame carries
 * the chatId so the server can persist the D-axis on
 * `agent_chat_sessions.runtime_state` at the granularity the status surfaces
 * actually need, replacing the previous `session_events` freshness proxy.
 */
export const sessionRuntimeMessageSchema = z.object({
  chatId: z.string().min(1),
  runtimeState: runtimeStateSchema,
  /**
   * The provider for this chat is parked on work it started itself — a
   * `run_in_background` task, for instance — and will resume on its own when
   * that work finishes. Descriptive only: it never makes a chat `working`
   * (the turn is not running and no tokens are burning), it explains why an
   * idle chat is not finished. Optional so an older client that never sends
   * it simply reads as "no background work".
   */
  backgroundWork: z.boolean().optional(),
});
export type SessionRuntimeMessage = z.infer<typeof sessionRuntimeMessageSchema>;

/**
 * One per-chat runtime report, named rather than threaded positionally. The
 * report crosses four layers (projection -> slot -> connection -> frame), and
 * every descriptive field added to it would otherwise be another positional
 * parameter sweep through all of them.
 */
export type SessionRuntimeReport = Omit<SessionRuntimeMessage, "chatId"> & { backgroundWork: boolean };

// -- Agent Bind Payload (client -> server) --
// WS bind authorization derives from the WS-level JWT and the client_id pinned
// to the agent (Rule R-RUN). A successful bind separately returns an ephemeral
// runtime-session token for subsequent agent-scoped HTTP.

export const agentBindRequestSchema = z.object({
  agentId: z.string().min(1),
  runtimeType: z.string().max(50),
  runtimeVersion: z.string().max(50).optional(),
});
export type AgentBindRequest = z.infer<typeof agentBindRequestSchema>;

export const AGENT_BIND_REJECT_REASONS = {
  WRONG_CLIENT: "wrong_client",
  NOT_OWNED: "not_owned",
  AGENT_SUSPENDED: "agent_suspended",
  WRONG_ORG: "wrong_org",
  UNKNOWN_AGENT: "unknown_agent",
  RUNTIME_PROVIDER_MISMATCH: "runtime_provider_mismatch",
} as const;

export const agentBindRejectReasonSchema = z.enum([
  "wrong_client",
  "not_owned",
  "agent_suspended",
  "wrong_org",
  "unknown_agent",
  "runtime_provider_mismatch",
]);
export type AgentBindRejectReason = z.infer<typeof agentBindRejectReasonSchema>;

/** Header used on agent-scoped HTTP calls to select which managed agent the JWT acts as. */
export const AGENT_SELECTOR_HEADER = "x-agent-id";

/** Header used on agent-scoped HTTP calls to prove the current runtime WS bind. */
export const AGENT_RUNTIME_SESSION_HEADER = "x-agent-runtime-session";

/**
 * Stable HTTP error codes for bind-scoped runtime proof failures. Callers
 * must route these separately from provider credentials: a fresh `agent:bind`
 * can mint a new proof without asking the operator to re-authenticate the
 * provider.
 */
export const AGENT_RUNTIME_SESSION_ERROR_CODES = {
  MISSING: "AGENT_RUNTIME_SESSION_MISSING",
  INVALID: "AGENT_RUNTIME_SESSION_INVALID",
} as const;
export type AgentRuntimeSessionErrorCode =
  (typeof AGENT_RUNTIME_SESSION_ERROR_CODES)[keyof typeof AGENT_RUNTIME_SESSION_ERROR_CODES];

// -- Extended Agent Presence --

export const agentPresenceSchema = z.object({
  agentId: z.string(),
  status: presenceStatusSchema,
  connectedAt: z.string().nullable(),
  lastSeenAt: z.string(),
  clientId: z.string().nullable().optional(),
  runtimeType: z.string().nullable().optional(),
  runtimeVersion: z.string().nullable().optional(),
  runtimeState: runtimeStateSchema.nullable().optional(),
  activeSessions: z.number().int().nullable().optional(),
  totalSessions: z.number().int().nullable().optional(),
  runtimeUpdatedAt: z.string().nullable().optional(),
});
export type AgentPresence = z.infer<typeof agentPresenceSchema>;

// -- Activity Overview (admin response) --

export const activityOverviewSchema = z.object({
  total: z.number().int(),
  running: z.number().int(),
  byState: z.object({
    idle: z.number().int(),
    working: z.number().int(),
    blocked: z.number().int(),
    error: z.number().int(),
  }),
  clients: z.number().int(),
});
export type ActivityOverview = z.infer<typeof activityOverviewSchema>;
