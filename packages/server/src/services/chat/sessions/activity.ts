import { RUNTIME_STALE_MS, type RuntimeState, type SessionState } from "@first-tree/shared";
import { and, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import type { Database } from "../../../db/connection.js";
import { agentChatSessions } from "../../../db/schema/agent-chat-sessions.js";
import { agentPresence } from "../../../db/schema/agent-presence.js";
import { agents } from "../../../db/schema/agents.js";
import { chats } from "../../../db/schema/chats.js";
import { clients } from "../../../db/schema/clients.js";
import type { OrgScope } from "../../../scope/types.js";
import { agentVisibilityCondition } from "../../agents/access-control.js";
import type { Notifier } from "../../notifier.js";

const DEADLOCK_DETECTED_SQLSTATE = "40P01";
const SESSION_TX_MAX_ATTEMPTS = 3;

// Drizzle wraps postgres-js errors in `cause`; guard against cyclic wrappers.
function isDeadlockDetectedError(error: unknown): boolean {
  const visited = new Set<object>();
  let current: unknown = error;
  while (current !== null && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    if (Reflect.get(current, "code") === DEADLOCK_DETECTED_SQLSTATE) return true;
    current = Reflect.get(current, "cause");
  }
  return false;
}

// Jitter separates concurrent retries: 10–19ms, then 20–29ms.
function waitForDeadlockRetry(attempt: number): Promise<void> {
  const delayMs = 10 * attempt + Math.floor(Math.random() * 10);
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Upsert session state + refresh presence aggregates + NOTIFY.
 *
 * `agent_chat_sessions.(agent_id, chat_id)` is a single-row "current session
 * state" cache, not a session history log. A new runtime session starting on
 * the same (agent, chat) pair MUST overwrite whatever ended before — including
 * an `evicted` row left by a previous terminate. The previous "revival
 * defense" conflated two concerns: "this runtime session ended" (which is
 * what `evicted` actually means) and "this chat is permanently archived for
 * this agent" (a chat-level decision that should live on `chats`, not here).
 * See proposals/hub-agent-messaging-reply-and-mentions §M2-session-lifecycle.
 *
 * Presence row contract: this function tolerates a missing `agent_presence`
 * row by using `INSERT ... ON CONFLICT DO UPDATE`. The predictive-write path
 * (sendMessage on first message) may target an agent whose client has never
 * bound, so a prior `update agent_presence ... where agentId` would silently
 * drop the activeSessions/totalSessions refresh. See PR #198 review §2.
 */
export async function upsertSessionState(
  db: Database,
  agentId: string,
  chatId: string,
  state: SessionState,
  organizationId: string,
  notifier?: Notifier,
  options?: { touchPresenceLastSeen?: boolean },
): Promise<void> {
  const revokesRuntime = state !== "active";
  // Retry the complete session/presence transaction after a deadlock rollback.
  // Message and webhook writes belong to the caller and must never be replayed.
  for (let attempt = 1; ; attempt++) {
    // Fresh clock per attempt: a rolled-back attempt's timestamps must not
    // leak into the replayed commit.
    const now = new Date();
    // Attempt-local: a rolled-back attempt must never emit notifications,
    // even if it observed a projection change before the abort.
    let projectionChanged = false;
    try {
      await db.transaction(async (tx) => {
        // Match membership snapshots' chat → agent order before FK checks can
        // acquire the agent first. Lock the agent before session writes, too,
        // matching runtime-switch archive's agent → session order. KEY SHARE
        // parent locks remain compatible with other session writers. Missing
        // parents still produce the INSERT's original foreign-key violation.
        await tx.select({ id: chats.id }).from(chats).where(eq(chats.id, chatId)).for("key share");
        await tx.select({ uuid: agents.uuid }).from(agents).where(eq(agents.uuid, agentId)).for("key share");

        // Short-circuit when the row is already at the target state: skip the
        // updatedAt refresh so steady-state messaging doesn't churn the row.
        // Insertions, lifecycle transitions (evicted → active, active →
        // suspended, etc.), and one-time repair of a non-idle runtime retained by
        // an already-inactive row still take the UPDATE branch.
        //
        // We use `.returning()` to detect whether INSERT/UPDATE actually fired —
        // PostgreSQL omits returning rows when the ON CONFLICT DO UPDATE's
        // `setWhere` predicate is false (same-state, already-revoked no-op). Zero rows back ⇒
        // skip the downstream presence refresh + NOTIFY. This keeps
        // `session:state` frames off the wire when an already-active session
        // receives a burst of steady-state messages (e.g. an agent emitting
        // many intermediate chat results into the same chat) — without this
        // short-circuit, the predictive Step 1b in services/chat/message.ts would
        // NOTIFY once per message and the admin WS would invalidate
        // `["activity"]` / `["sessions"]` dozens of times per second. The
        // client's `heartbeat` frame is the canonical lastSeenAt refresh
        // path (see presence.ts:touchAgent), so dropping the lastSeenAt
        // side-effect here is safe.
        const rows = await tx
          .insert(agentChatSessions)
          .values(
            revokesRuntime
              ? { agentId, chatId, state, runtimeState: "idle", runtimeStateAt: now, updatedAt: now }
              : { agentId, chatId, state, updatedAt: now },
          )
          .onConflictDoUpdate({
            target: [agentChatSessions.agentId, agentChatSessions.chatId],
            set: revokesRuntime
              ? { state, runtimeState: "idle", runtimeStateAt: now, updatedAt: now }
              : { state, updatedAt: now },
            // An inactive row retaining a non-idle runtime is also a real
            // projection change even when its lifecycle value is already equal.
            // Repair it once, then keep duplicate inactive frames as no-ops.
            setWhere: revokesRuntime
              ? or(ne(agentChatSessions.state, state), ne(agentChatSessions.runtimeState, "idle"))
              : ne(agentChatSessions.state, state),
          })
          .returning({ agentId: agentChatSessions.agentId });

        if (rows.length === 0) return;
        projectionChanged = true;

        // Active runtime values are owned by `session:runtime`. Lifecycle
        // inactivation is the revocation authority and atomically writes idle so
        // a dropped/reordered client edge cannot leave working behind.
        const [counts] = await tx
          .select({
            active: sql<number>`count(*) FILTER (WHERE ${agentChatSessions.state} = 'active')::int`,
            total: sql<number>`count(*) FILTER (WHERE ${agentChatSessions.state} != 'evicted')::int`,
          })
          .from(agentChatSessions)
          .where(eq(agentChatSessions.agentId, agentId));

        const activeSessions = counts?.active ?? 0;
        const totalSessions = counts?.total ?? 0;

        // `lastSeenAt` is owned by the client's bind/heartbeat. Skip it on
        // server-predictive writes (e.g. sendMessage upserting active on first
        // message); default-true preserves the WS `session:state` path's behavior.
        // Note: when the row is being inserted (no prior presence), the schema's
        // `lastSeenAt` default (now()) populates it regardless — touchLastSeen
        // only governs subsequent UPDATE behavior.
        const touchLastSeen = options?.touchPresenceLastSeen ?? true;
        const presenceSet = touchLastSeen
          ? { activeSessions, totalSessions, lastSeenAt: now }
          : { activeSessions, totalSessions };

        await tx
          .insert(agentPresence)
          .values({ agentId, activeSessions, totalSessions })
          .onConflictDoUpdate({
            target: [agentPresence.agentId],
            set: presenceSet,
          });
      });
    } catch (error) {
      if (attempt < SESSION_TX_MAX_ATTEMPTS && isDeadlockDetectedError(error)) {
        await waitForDeadlockRetry(attempt);
        continue;
      }
      throw error;
    }

    // Notify only after a successful commit that actually changed the
    // projection — never for a rolled-back attempt, and at most once per
    // call. Notification failure remains best-effort (`.catch`), unchanged.
    if (projectionChanged && notifier) {
      notifier.notifySessionStateChange(agentId, chatId, state, organizationId).catch(() => {});
      if (revokesRuntime) {
        notifier.notifySessionRuntime(agentId, chatId, "idle", organizationId).catch(() => {});
      }
    }
    return;
  }
}

/**
 * Persist the per-(agent,chat) D-axis runtime state reported by a client
 * (`session:runtime` frame plus the ~20s re-affirm). Always bumps
 * `runtime_state_at` so a long working turn stays fresh; kicks the admin
 * WS notifier only when the *effective composite status could change* —
 * i.e. the runtime value changed, OR a same-value report flips the
 * derivation from stale (or NULL sentinel) to fresh (e.g. a `working` that
 * had aged out is live again). A fresh same-value re-affirm changes
 * nothing, so it stays silent (no invalidation spam).
 *
 * Only an `active` session is touched (enforced atomically in the UPDATE
 * `WHERE` clause): the suspend / evict paths own the lifecycle, and a
 * runtime report for a non-active (or missing) session is stale — skip it
 * (the next re-affirm recovers once the session goes active, covering the
 * startup-order race where a `working` report can beat the `session:state
 * active` report).
 *
 * Implementation: a single conditional `UPDATE ... WHERE state='active'
 * RETURNING (prev runtime_state, prev runtime_state_at)`, using the SQL
 * `agent_chat_sessions.runtime_state AS prev_runtime_state` self-reference
 * to read the row's value before the SET assignment lands. This shaves a
 * round-trip vs SELECT-then-UPDATE, makes the active-gate race-free at the
 * SQL level (no longer relying solely on the per-(agent,chat) chainSessionOp
 * + single-client-per-agent invariants), and removes the "future caller
 * forgot to chainSessionOp" footgun flagged in the codex review.
 */
export async function setSessionRuntime(
  db: Database,
  agentId: string,
  chatId: string,
  runtimeState: RuntimeState,
  organizationId: string,
  notifier?: Notifier,
): Promise<void> {
  // CTE captures the previous row before the UPDATE; the UPDATE's WHERE
  // additionally enforces `state='active'` so an inactive / missing row
  // matches nothing and RETURNING is empty. The active gate is now a SQL
  // invariant rather than a TS check on the chainSessionOp-serialised
  // SELECT-then-UPDATE pair. `NOW()` (server clock) is the timestamp
  // source so we don't marshal a Date through postgres-js's raw-execute
  // path (which can't bind Date params).
  const rows = (await db.execute(sql`
    WITH prev AS (
      SELECT runtime_state    AS prev_runtime_state,
             runtime_state_at AS prev_runtime_state_at
        FROM agent_chat_sessions
       WHERE agent_id = ${agentId} AND chat_id = ${chatId}
    )
    UPDATE agent_chat_sessions
       SET runtime_state    = ${runtimeState},
           runtime_state_at = NOW()
      FROM prev
     WHERE agent_chat_sessions.agent_id = ${agentId}
       AND agent_chat_sessions.chat_id  = ${chatId}
       AND agent_chat_sessions.state    = 'active'
    RETURNING prev.prev_runtime_state, prev.prev_runtime_state_at
  `)) as unknown as Array<{ prev_runtime_state: string | null; prev_runtime_state_at: Date | string | null }>;

  // No row returned = WHERE didn't match (row missing or not active). Either
  // way the runtime report is stale; nothing to notify. This replaces the
  // pre-CTE explicit `if (!prev || prev.state !== 'active') return`.
  const row = rows[0];
  if (!row) return;

  // postgres-js surfaces RETURNING timestamp columns as `Date` instances on
  // typed queries, but raw `db.execute(sql\`…\`)` surfaces them as strings
  // — coerce defensively so the freshness comparison is on a stable type.
  const prevRuntimeState = row.prev_runtime_state;
  const prevRuntimeStateAt =
    row.prev_runtime_state_at == null
      ? null
      : row.prev_runtime_state_at instanceof Date
        ? row.prev_runtime_state_at
        : new Date(row.prev_runtime_state_at);

  // Notify when the composite `working` / `errored` could have flipped:
  // a value change, OR a same-value report that crosses the fail-closed
  // boundary (NULL sentinel → fresh, OR stale → fresh). A fresh same-value
  // re-affirm changes nothing, so it stays silent.
  const valueChanged = prevRuntimeState !== runtimeState;
  const wasStale = prevRuntimeStateAt == null || Date.now() - prevRuntimeStateAt.getTime() > RUNTIME_STALE_MS;
  if ((valueChanged || wasStale) && notifier) {
    notifier.notifySessionRuntime(agentId, chatId, runtimeState, organizationId).catch(() => {});
  }
}

export async function resetActivity(db: Database, agentId: string) {
  const now = new Date();
  await db
    .update(agentPresence)
    .set({
      runtimeState: "idle",
      runtimeUpdatedAt: now,
    })
    .where(eq(agentPresence.agentId, agentId));
}

export async function getActivityOverview(db: Database) {
  const [agentCounts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      running: sql<number>`count(*) FILTER (WHERE ${agentPresence.runtimeState} IS NOT NULL)::int`,
      idle: sql<number>`count(*) FILTER (WHERE ${agentPresence.runtimeState} = 'idle')::int`,
      working: sql<number>`count(*) FILTER (WHERE ${agentPresence.runtimeState} = 'working')::int`,
      blocked: sql<number>`count(*) FILTER (WHERE ${agentPresence.runtimeState} = 'blocked')::int`,
      error: sql<number>`count(*) FILTER (WHERE ${agentPresence.runtimeState} = 'error')::int`,
    })
    .from(agentPresence);

  const [clientCounts] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(clients)
    .where(eq(clients.status, "connected"));

  return {
    total: agentCounts?.total ?? 0,
    running: agentCounts?.running ?? 0,
    byState: {
      idle: agentCounts?.idle ?? 0,
      working: agentCounts?.working ?? 0,
      blocked: agentCounts?.blocked ?? 0,
      error: agentCounts?.error ?? 0,
    },
    clients: clientCounts?.count ?? 0,
  };
}

export async function getAgentWithRuntime(db: Database, agentId: string) {
  const [row] = await db.select().from(agentPresence).where(eq(agentPresence.agentId, agentId)).limit(1);
  return row ?? null;
}

/**
 * List agents with active runtime state.
 * When scope is provided, filters to agents visible to the member.
 */
export async function listAgentsWithRuntime(db: Database, scope?: OrgScope) {
  if (!scope) {
    return db.select().from(agentPresence).where(isNotNull(agentPresence.runtimeState));
  }

  // JOIN with agents table to apply visibility filter
  return db
    .select({
      agentId: agentPresence.agentId,
      status: agentPresence.status,
      instanceId: agentPresence.instanceId,
      connectedAt: agentPresence.connectedAt,
      lastSeenAt: agentPresence.lastSeenAt,
      clientId: agentPresence.clientId,
      runtimeType: agentPresence.runtimeType,
      runtimeVersion: agentPresence.runtimeVersion,
      runtimeState: agentPresence.runtimeState,
      activeSessions: agentPresence.activeSessions,
      totalSessions: agentPresence.totalSessions,
      runtimeUpdatedAt: agentPresence.runtimeUpdatedAt,
      type: agents.type,
      managerId: agents.managerId,
    })
    .from(agentPresence)
    .innerJoin(agents, eq(agentPresence.agentId, agents.uuid))
    .where(and(isNotNull(agentPresence.runtimeState), agentVisibilityCondition(scope.organizationId, scope.memberId)));
}
