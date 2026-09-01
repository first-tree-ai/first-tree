import { z } from "zod";
import { type LiveActivity, liveActivitySchema } from "./me-chat.js";
import { type AgentStatusReason, agentStatusReasonSchema } from "./provider-retry.js";

/**
 * Composite "main" status — the single value a compact surface (a status
 * dot, a one-line chip) shows for an agent *in a specific chat*. It is a
 * lossy projection of the four orthogonal status axes onto one token:
 *
 *   - reachability (A) — is the runtime/client reachable at all
 *   - engagement   (C) — the per-(agent,chat) session lifecycle
 *   - activity     (D) — is the agent producing output right now
 *
 * `deriveMainStatus` resolves the projection using `MAIN_STATUS_PRIORITY`.
 *
 * IMPORTANT: this is the *per-(agent,chat) composite* vocabulary. It is
 * deliberately distinct from the agent-global runtime vocabulary
 * (`idle/working/blocked/error/offline`, see `schemas/presence.ts`
 * `RuntimeState`). The two share visual tokens (color / shape) but NOT enum
 * values — surfaces must not feed one where the other is expected (that is
 * the class of bug that left SessionContext rendering every session as
 * "Offline").
 */
export const AGENT_MAIN_STATUSES = {
  OFFLINE: "offline",
  FAILED: "failed",
  WORKING: "working",
  PAUSED: "paused",
  READY: "ready",
} as const;

export const agentMainStatusSchema = z.enum(["offline", "failed", "working", "paused", "ready"]);
export type AgentMainStatus = z.infer<typeof agentMainStatusSchema>;

/**
 * Priority for the lossy projection, highest-attention first. When several
 * axes are simultaneously true, the earliest entry wins the single display
 * slot. Two principles stack:
 *   1. logical gating — an unreachable agent cannot be "working", so
 *      `offline` dominates everything;
 *   2. attention value — among the rest, the more the human needs to act,
 *      the earlier it sorts (failure > working > paused > ready).
 *
 * Lower index = higher priority. Also used by surfaces that *rank* agents
 * (e.g. the compose status bar puts the highest-priority agent on top).
 */
export const MAIN_STATUS_PRIORITY = [
  "offline",
  "failed",
  "working",
  "paused",
  "ready",
] as const satisfies readonly AgentMainStatus[];

/** Per-(agent,chat) engagement = the agent's session lifecycle in THIS chat. */
export const AGENT_ENGAGEMENTS = {
  ACTIVE: "active",
  SUSPENDED: "suspended",
  NONE: "none",
} as const;

export const agentEngagementSchema = z.enum(["active", "suspended", "none"]);
export type AgentEngagement = z.infer<typeof agentEngagementSchema>;

/**
 * Freshness window (ms) for the per-(agent,chat) D-axis runtime state. The
 * client re-affirms `working` / `blocked` / `error` sessions on a ~20s timer
 * (RUNTIME_REAFFIRM_BASE_MS) with ±20% jitter so a long turn keeps
 * `runtime_state_at` fresh; if no re-affirm lands within this window the
 * server stops treating the session as *working*. Stale in-flight runtime
 * (`working` / `blocked` / `error`) still lights recovery so a silent client
 * death does not look idle. 60s = 3× the nominal re-affirm interval, matching
 * the approved spec (proposals/hub-agent-status-working-freshness.20260525.md
 * §6.1 §10) for the working cutoff.
 *
 * Direct consequence: when a client process crashes mid-turn, composite
 * `working` clears once RUNTIME_STALE_MS elapses. Recovery attention then
 * stays on the `errored` axis (chat-row `failedAgentIds`) so a dead in-flight
 * turn does not look merely idle.
 */
export const RUNTIME_STALE_MS = 60_000;

/** Inputs to the projection — one field per status axis. */
export type DeriveMainStatusInput = {
  /** Reachability (A): is the agent's runtime/client reachable at all? */
  reachable: boolean;
  /** Recovery the user should see: session `errored`, runtime `error`/`blocked`, or a stale in-flight D-axis. */
  errored: boolean;
  /** Activity (D): the agent is producing output right now (live activity present). */
  working: boolean;
  /** Engagement (C): the per-(agent,chat) session lifecycle. */
  engagement: AgentEngagement;
};

/**
 * Reduce the four axes to a single `AgentMainStatus`. Pure and deterministic;
 * the if-ladder is exactly `MAIN_STATUS_PRIORITY` order. Shared by server
 * (authority) and client (so a unit test pins the contract once).
 */
export function deriveMainStatus(input: DeriveMainStatusInput): AgentMainStatus {
  // Gating: nothing else can be true if the agent can't be reached.
  if (!input.reachable) return "offline";
  if (input.errored) return "failed";
  if (input.working) return "working";
  if (input.engagement === "suspended") return "paused";
  return "ready";
}

/**
 * Compare two main statuses by attention priority. Returns < 0 when `a`
 * should sort before `b` (higher attention). Stable input for `Array.sort`.
 */
export function compareMainStatus(a: AgentMainStatus, b: AgentMainStatus): number {
  return MAIN_STATUS_PRIORITY.indexOf(a) - MAIN_STATUS_PRIORITY.indexOf(b);
}

/**
 * Server-derived composite status for one agent in one chat. Produced
 * server-side — the authority, because only the server can aggregate
 * reachability, session, and live activity across the
 * data plane — and consumed read-only by every UI surface.
 *
 * INVARIANT: `main === deriveMainStatus(the other fields)`. The schema's
 * `superRefine` enforces it on parse, so a self-contradictory payload (e.g.
 * `{ main: "ready", working: true }`) is rejected rather than silently
 * trusted. Always construct via `buildAgentChatStatus` to keep `main`
 * derived rather than hand-set.
 */
export const agentChatStatusSchema = z
  .object({
    agentId: z.string(),
    main: agentMainStatusSchema,
    reachable: z.boolean(),
    engagement: agentEngagementSchema,
    working: z.boolean(),
    errored: z.boolean(),
    /**
     * The live activity driving `working` (tool name / "Thinking" / "Writing"
     * + startedAt), or null when not working. Carried so per-agent surfaces
     * (AgentRow / compose) can render the "Using <tool> · 12s" detail without
     * a second round-trip. Not an input to `main` — purely descriptive.
     */
    activity: liveActivitySchema.nullable(),
    /**
     * Current retry/waiting/terminal reason projected from runtime-owned
     * resilience events. Descriptive only: it is not an input to `main`, and
     * consumers must not infer busy state from it.
     */
    statusReason: agentStatusReasonSchema.optional(),
    /**
     * The provider for this chat is parked on work it started itself (a
     * background task) and will resume on its own when that work finishes.
     *
     * Descriptive only, exactly like `activity` and `statusReason`: it is NOT
     * an input to `main`, and a chat carrying it stays `ready`. A parked
     * provider burns no tokens and runs no turn, so calling it `working`
     * would be a lie; but plain "Idle" is also a lie by omission, because it
     * reads as "finished, nothing will happen without you" when in fact the
     * agent wakes itself up. Surfaces render it as a qualifier on Idle.
     */
    backgroundWork: z.boolean().optional(),
    /**
     * The agent's live client connection declares the composite Reset
     * capability `wsSessionResetV1` — i.e. it answers a ref'd terminate with
     * an apply-ack, parks intervening inbox rows behind the Reset fence, and
     * releases them only against the matching receipted terminal disposition
     * (`session:command:finalized` for a durable eviction, or
     * `session:command:aborted` when the server could not finalize), which it
     * receipts. A client that declares only the legacy apply-only flag reads
     * as `false` here, because the server would otherwise evict its session
     * into a fence it never lifts. Absent/false for old clients and offline
     * agents; Web shows Reset only when this is `=== true`.
     */
    sessionResetSupported: z.boolean().optional(),
    /**
     * The agent's live, route-consistent client connection runs a version
     * that parses the server-owned `teamSkillInvocation` message metadata
     * marker fail-closed (`supportsTeamSkillInvocationClientVersion` over
     * `clients.sdk_version`). Absent/false for old, unknown-version,
     * offline, or unbound clients; the Web composer offers Team Skill menu
     * entries only when this is `=== true`, so a client that would hand
     * the base literal to a same-named local Skill never sees the entry
     * point. Derived from existing rows — no new persisted state.
     */
    teamSkillInvocationSupported: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    const expected = deriveMainStatus(val);
    if (val.main !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `main "${val.main}" must equal deriveMainStatus(...) = "${expected}"`,
        path: ["main"],
      });
    }
  });
export type AgentChatStatus = z.infer<typeof agentChatStatusSchema>;

/** Inputs to `buildAgentChatStatus` — the axis fields plus the agent id and
 * the optional descriptive live activity. */
export type AgentChatStatusInput = DeriveMainStatusInput & {
  agentId: string;
  activity?: LiveActivity | null;
  statusReason?: AgentStatusReason;
  backgroundWork?: boolean;
  sessionResetSupported?: boolean;
  teamSkillInvocationSupported?: boolean;
};

/**
 * Construct an `AgentChatStatus` with `main` always derived from the axes
 * (never hand-set), keeping the schema invariant true by construction. This
 * is the only sanctioned way to build the composite status server-side.
 */
export function buildAgentChatStatus(input: AgentChatStatusInput): AgentChatStatus {
  return {
    agentId: input.agentId,
    reachable: input.reachable,
    engagement: input.engagement,
    working: input.working,
    errored: input.errored,
    main: deriveMainStatus(input),
    activity: input.activity ?? null,
    ...(input.statusReason ? { statusReason: input.statusReason } : {}),
    ...(input.backgroundWork ? { backgroundWork: true } : {}),
    ...(input.sessionResetSupported !== undefined ? { sessionResetSupported: input.sessionResetSupported } : {}),
    ...(input.teamSkillInvocationSupported !== undefined
      ? { teamSkillInvocationSupported: input.teamSkillInvocationSupported }
      : {}),
  };
}
