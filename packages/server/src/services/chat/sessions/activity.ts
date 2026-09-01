import { RUNTIME_STALE_MS, type RuntimeState, type SessionState } from "@first-tree/shared";
import { and, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import type { Database } from "../../../db/connection.js";
import { agentChatSessions } from "../../../db/schema/agent-chat-sessions.js";
import { agentPresence } from "../../../db/schema/agent-presence.js";
import { agents } from "../../../db/schema/agents.js";
import { clients } from "../../../db/schema/clients.js";
import type { OrgScope } from "../../../scope/types.js";
import { agentVisibilityCondition } from "../../agents/access-control.js";
import type { Notifier } from "../../notifier.js";

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
) {
  const now = new Date();
  const revokesRuntime = state !== "active";
  let projectionChanged = false;
  await db.transaction(async (tx) => {
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
          ? { agentId, chatId, state, runtimeState: "idle", runtimeStateAt: now, backgroundWork: false, updatedAt: now }
          : { agentId, chatId, state, updatedAt: now },
      )
      .onConflictDoUpdate({
        target: [agentChatSessions.agentId, agentChatSessions.chatId],
        set: revokesRuntime
          ? { state, runtimeState: "idle", runtimeStateAt: now, backgroundWork: false, updatedAt: now }
          : { state, updatedAt: now },
        // An inactive row retaining a non-idle runtime is also a real
        // projection change even when its lifecycle value is already equal.
        // Repair it once, then keep duplicate inactive frames as no-ops.
        setWhere: revokesRuntime
          ? or(
              ne(agentChatSessions.state, state),
              ne(agentChatSessions.runtimeState, "idle"),
              // A leftover background-work marker is the same class of stale
              // projection as a leftover non-idle runtime: repair it once so a
              // later activation cannot revive a previous session's marker.
              eq(agentChatSessions.backgroundWork, true),
            )
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

  if (projectionChanged && notifier) {
    notifier.notifySessionStateChange(agentId, chatId, state, organizationId).catch(() => {});
    if (revokesRuntime) {
      notifier.notifySessionRuntime(agentId, chatId, "idle", organizationId).catch(() => {});
    }
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
  /**
   * Descriptive marker riding the same frame: the provider is parked on work
   * it started itself and will resume unprompted. Absent (old client) is
   * written as `false` — the same fail-closed default a client that stopped
   * reporting decays to.
   */
  backgroundWork = false,
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
             runtime_state_at AS prev_runtime_state_at,
             background_work  AS prev_background_work
        FROM agent_chat_sessions
       WHERE agent_id = ${agentId} AND chat_id = ${chatId}
    )
    UPDATE agent_chat_sessions
       SET runtime_state    = ${runtimeState},
           runtime_state_at = NOW(),
           background_work  = ${backgroundWork}
      FROM prev
     WHERE agent_chat_sessions.agent_id = ${agentId}
       AND agent_chat_sessions.chat_id  = ${chatId}
       AND agent_chat_sessions.state    = 'active'
    RETURNING prev.prev_runtime_state, prev.prev_runtime_state_at, prev.prev_background_work
  `)) as unknown as Array<{
    prev_runtime_state: string | null;
    prev_runtime_state_at: Date | string | null;
    prev_background_work: boolean | null;
  }>;

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
  // A background-work flip changes what the surfaces render ("Idle" vs
  // "Idle · background task"), so it earns a notify on its own even when the
  // runtime state itself is an unchanged, still-fresh `idle`.
  const valueChanged = prevRuntimeState !== runtimeState || (row.prev_background_work ?? false) !== backgroundWork;
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
