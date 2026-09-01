import {
  type AgentChatStatus,
  type AgentEngagement,
  type AgentStatusReason,
  ASSISTANT_TEXT_FULL_MAX,
  ASSISTANT_TEXT_PREVIEW_MAX,
  type AssistantTextEventPayload,
  buildAgentChatStatus,
  deriveMainStatus,
  LIVE_ACTIVITY_STALE_MS,
  type LiveActivity,
  parseProviderRetryEventMessage,
  RUNTIME_STALE_MS,
  type RuntimeState,
  statusReasonFromProviderRetryEvent,
  stripShellCommandDisplayWrapper,
  supportsTeamSkillInvocationClientVersion,
  type ToolCallEventPayload,
} from "@first-tree/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../../../db/connection.js";
import { agentChatSessions } from "../../../db/schema/agent-chat-sessions.js";
import { agentPresence } from "../../../db/schema/agent-presence.js";
import { agents } from "../../../db/schema/agents.js";
import { chatMembership } from "../../../db/schema/chat-membership.js";
import { clients } from "../../../db/schema/clients.js";
import { isConsistentAgentRoute, metadataSupportsSessionReset } from "../../runtime/rpc/session-command.js";

/**
 * Single source of truth for per-(agent,chat) composite status.
 *
 * `resolveAgentChatStatuses` is the ONE producer behind every chat surface:
 *   - `GET /chats/:chatId/agent-status` (this file's `getChatAgentStatuses`),
 *   - the chat-list `failedAgentIds` / `liveActivity`
 *     projections in `services/chat/workspace/me-chat.ts`.
 *
 * It folds the orthogonal axes per agent and reduces them via the shared
 * `buildAgentChatStatus` (so `main` is always derived, never hand-set):
 *   - reachability (A): the agent has a bound client (`agent_presence.client_id`)
 *   - engagement   (C): `agent_chat_sessions.state` for this pair
 *   - activity     (D): a fresh, non-terminal latest `session_events` row
 *   - attention       : recovery the user can notice — session `errored`,
 *     fresh runtime `error` / `blocked`, or a stale in-flight D-axis
 *     (`working` / `blocked` / `error`) after the client stopped reaffirming
 *
 * The `errored` predicate lives here ONCE (it used to be duplicated as a TS
 * predicate in this file AND a Drizzle clause in `me-chat.ts:deriveFailedAgents`,
 * "kept in lockstep by test"). The live-activity LATERAL seek also lives here
 * once (it used to be implemented twice — `deriveAgentActivity` here and
 * `deriveLiveActivity` in me-chat.ts).
 */

// ---------------------------------------------------------------------------
// Live-activity preview helpers (moved here from me-chat.ts so the producer
// owns the whole derivation; a one-directional import keeps me-chat.ts → this
// module acyclic).
// ---------------------------------------------------------------------------

/** Max length of the tool-arg preview surfaced in `LiveActivity.detail`. */
const ARG_PREVIEW_MAX = 32;

/**
 * Best-effort short preview of a tool call's args, for the compose status bar's
 * `Using Bash · npm test` detail. Picks a meaningful field for common tools
 * (command / path / query / …), else stringifies; whitespace-collapsed and
 * truncated to {@link ARG_PREVIEW_MAX}. Returns undefined when there's nothing
 * useful to show. Exported for unit testing.
 */
export function previewToolArgs(args: unknown, opts?: { stripShellCommandWrapper?: boolean }): string | undefined {
  let raw: string | undefined;
  if (typeof args === "string") {
    raw = args;
  } else if (args && typeof args === "object") {
    const o = args as Record<string, unknown>;
    // Only fields that hold an *argument value* the user would recognise. NOT
    // `description` (that's a tool's self-description, not what it's running);
    // the JSON.stringify fallback below covers tools with no recognised field.
    const pick = o.command ?? o.cmd ?? o.file_path ?? o.path ?? o.pattern ?? o.query ?? o.url;
    if (typeof pick === "string") raw = pick;
    else if (Object.keys(o).length > 0) raw = JSON.stringify(o); // empty {} → no detail
  }
  if (raw && opts?.stripShellCommandWrapper) raw = stripShellCommandDisplayWrapper(raw);
  if (!raw) return undefined;
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return undefined;
  return oneLine.length > ARG_PREVIEW_MAX ? `${oneLine.slice(0, ARG_PREVIEW_MAX - 1)}…` : oneLine;
}

/**
 * One-line preview of an assistant text block for the compose status bar's
 * liveness detail. Whitespace-collapsed and hard-capped to
 * {@link ASSISTANT_TEXT_PREVIEW_MAX} — no trailing "…" is added, since the
 * rail's CSS owns the visible ellipsis. Returns undefined for an empty /
 * whitespace-only block so the status bar falls back to the static "Writing".
 * Exported for unit testing.
 */
export function previewAssistantText(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return undefined;
  return oneLine.slice(0, ASSISTANT_TEXT_PREVIEW_MAX);
}

/**
 * Full, **newline-preserving** narration for the compose status bar's expand
 * card (`LiveActivity.turnTextFull`). Unlike {@link previewAssistantText} (which
 * flattens all whitespace to a single line and caps at 120), this keeps the
 * block's line structure — collapsing only intra-line runs of spaces/tabs and
 * capping consecutive blank lines to one — and caps at
 * {@link ASSISTANT_TEXT_FULL_MAX}. The card renders the whole string, so an
 * explicit "…" marks a truncation. Returns undefined for an empty/whitespace-only
 * block. Exported for unit testing.
 */
export function previewAssistantTextFull(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const normalized = text
    .replace(/\r\n?/g, "\n") // CRLF/CR → LF
    .replace(/[ \t]+/g, " ") // collapse intra-line whitespace, keep newlines
    .replace(/ *\n */g, "\n") // trim spaces hugging line breaks
    .replace(/\n{3,}/g, "\n\n") // cap blank-line runs
    .trim();
  if (normalized.length === 0) return undefined;
  return normalized.length > ASSISTANT_TEXT_FULL_MAX
    ? `${normalized.slice(0, ASSISTANT_TEXT_FULL_MAX - 1)}…`
    : normalized;
}

/**
 * Translate a `session_events` row into a `LiveActivity`, or null when the
 * kind is terminal (`turn_end` / `error`) or unrecognised. Pure & exported
 * for unit testing.
 */
export function toLiveActivity(row: {
  agent_id: string;
  chat_id: string;
  kind: string;
  payload: unknown;
  created_at: Date | string;
  runtime_provider?: string | null;
}): LiveActivity | null {
  const startedAt = new Date(row.created_at).toISOString();
  // Expiry the client uses to self-clear a lingering chip (matches the read-time
  // stale cutoff this module already applies in `deriveActivities`).
  const staleAt = new Date(new Date(row.created_at).getTime() + LIVE_ACTIVITY_STALE_MS).toISOString();
  switch (row.kind) {
    case "tool_call": {
      const payload = (row.payload ?? {}) as Partial<ToolCallEventPayload>;
      const label = typeof payload.name === "string" && payload.name.length > 0 ? payload.name : "Tool";
      const detail = previewToolArgs(payload.args, {
        stripShellCommandWrapper: row.runtime_provider === "codex" && payload.name === "command",
      });
      return { agentId: row.agent_id, kind: "tool_call", label, startedAt, staleAt, ...(detail ? { detail } : {}) };
    }
    case "thinking":
      return { agentId: row.agent_id, kind: "thinking", label: "Thinking", startedAt, staleAt };
    case "assistant_text": {
      const payload = (row.payload ?? {}) as Partial<AssistantTextEventPayload>;
      const detail = previewAssistantText(payload.text);
      return {
        agentId: row.agent_id,
        kind: "assistant_text",
        label: "Writing",
        startedAt,
        staleAt,
        ...(detail ? { detail } : {}),
      };
    }
    default:
      // turn_end / error / unknown → no live indicator
      return null;
  }
}

/**
 * Sticky narration for a working agent's live activity. Surfaces the current
 * turn's latest `assistant_text` (what the agent is *saying*) on `turnText` so
 * the compose status bar keeps showing the narration even after a `tool_call`
 * arrives — without it the activity is the single newest event, and a tool call
 * fired right after a sentence buries the prose. Leaves `turnText` absent (base
 * activity unchanged) when the turn has produced no prose yet. Base `kind` /
 * `label` / `detail` are preserved, so the sidebar AgentRow and chat-list chip
 * keep reading `Using <tool>`. Pure & exported for unit testing.
 */
export function withTurnNarration(base: LiveActivity | null, narrationText: unknown): LiveActivity | null {
  if (!base) return null;
  const narration = previewAssistantText(narrationText);
  if (!narration) return base;
  const full = previewAssistantTextFull(narrationText);
  // Attach `turnTextFull` only when it carries strictly more than the one-line
  // `turnText` (source longer than 120 chars, or it has line breaks the preview
  // flattened) — so "present" means "there is more to expand" for the client.
  const hasMore = full !== undefined && full !== narration;
  return { ...base, turnText: narration, ...(hasMore ? { turnTextFull: full } : {}) };
}

// ---------------------------------------------------------------------------
// Activity derivation (merged LATERAL — replaces the former twin
// `deriveLiveActivity` (me-chat.ts) and `deriveAgentActivity` (here)).
// ---------------------------------------------------------------------------

/**
 * Per-(agent,chat) live activity for `chatIds`: the latest `session_events`
 * row per pair, mapped through `toLiveActivity` (terminal kinds → absent) and
 * dropped when older than the stale threshold. Per-pair LATERAL seek on the
 * unique `(agent_id, chat_id, seq)` index — a single B-tree descent per pair,
 * independent of `session_events` table size.
 *
 * When `withTurnText`, a second `LEFT JOIN LATERAL` seeks the current turn's
 * latest `assistant_text` (`seq` past the last `turn_end`); `withTurnNarration`
 * rides it along as `turnText` so the compose status bar can show the running
 * narration even while a tool runs. Only the per-agent `/agent-status` path
 * pays for the extra seek; the chat-list passes `withTurnText: false`.
 */
async function deriveActivities(
  db: Database,
  chatIds: string[],
  opts?: { withTurnText?: boolean },
): Promise<Map<string, Map<string, LiveActivity>>> {
  const out = new Map<string, Map<string, LiveActivity>>();
  if (chatIds.length === 0) return out;

  const withTurn = opts?.withTurnText === true;
  // `IN (${...})` rather than `= ANY($1::text[])`: postgres-js binds string[]
  // as a flat string when the driver type hint resolves to text[], which PG
  // rejects. Inlining each value sidesteps the binding mismatch.
  const chatIdInClause = sql.join(
    chatIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const turnTextSelect = withTurn ? sql`, t.text AS turn_text` : sql`, NULL::text AS turn_text`;
  const turnTextJoin = withTurn
    ? sql`
      LEFT JOIN LATERAL (
        -- Raw prefix cap: bounds the bytes pulled from PG while leaving margin
        -- above ASSISTANT_TEXT_FULL_MAX (2000) — the newline-preserving
        -- previewAssistantTextFull is the widest consumer, and margin keeps
        -- pathological leading whitespace from starving the final value.
        SELECT LEFT(se.payload->>'text', ${sql.raw(String(ASSISTANT_TEXT_FULL_MAX + 200))}) AS text
          FROM session_events se
         WHERE se.agent_id = acs.agent_id
           AND se.chat_id  = acs.chat_id
           AND se.kind     = 'assistant_text'
           AND se.seq > COALESCE((
             SELECT MAX(se2.seq)
               FROM session_events se2
              WHERE se2.agent_id = acs.agent_id
                AND se2.chat_id  = acs.chat_id
                AND se2.kind     = 'turn_end'
           ), 0)
         ORDER BY se.seq DESC
         LIMIT 1
      ) t ON TRUE`
    : sql``;

  const rawRows = (await db.execute(sql`
    SELECT acs.agent_id        AS agent_id,
           acs.chat_id         AS chat_id,
           e.kind              AS kind,
           e.payload           AS payload,
           e.created_at        AS created_at,
           a.runtime_provider  AS runtime_provider
           ${turnTextSelect}
      FROM agent_chat_sessions acs
      INNER JOIN agents a ON a.uuid = acs.agent_id
      CROSS JOIN LATERAL (
        SELECT kind, payload, created_at, seq
          FROM session_events se
         WHERE se.agent_id = acs.agent_id
           AND se.chat_id  = acs.chat_id
         ORDER BY se.seq DESC
         LIMIT 1
      ) e
      ${turnTextJoin}
     WHERE acs.chat_id IN (${chatIdInClause})
       AND acs.state <> 'evicted'
  `)) as unknown as Array<{
    agent_id: string;
    chat_id: string;
    kind: string;
    payload: unknown;
    created_at: Date | string;
    runtime_provider: string | null;
    turn_text: string | null;
  }>;

  const now = Date.now();
  for (const r of rawRows) {
    if (now - new Date(r.created_at).getTime() > LIVE_ACTIVITY_STALE_MS) continue;
    const base = toLiveActivity({
      agent_id: r.agent_id,
      chat_id: r.chat_id,
      kind: r.kind,
      payload: r.payload,
      created_at: r.created_at,
      runtime_provider: r.runtime_provider,
    });
    const activity = withTurnNarration(base, r.turn_text);
    if (!activity) continue;
    let perAgent = out.get(r.chat_id);
    if (!perAgent) {
      perAgent = new Map();
      out.set(r.chat_id, perAgent);
    }
    perAgent.set(r.agent_id, activity);
  }
  return out;
}

async function deriveStatusReasons(
  db: Database,
  chatIds: string[],
): Promise<Map<string, Map<string, AgentStatusReason>>> {
  const out = new Map<string, Map<string, AgentStatusReason>>();
  if (chatIds.length === 0) return out;

  const chatIdInClause = sql.join(
    chatIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rawRows = (await db.execute(sql`
    SELECT acs.agent_id AS agent_id,
           acs.chat_id  AS chat_id,
           e.kind       AS kind,
           e.payload    AS payload
      FROM agent_chat_sessions acs
      CROSS JOIN LATERAL (
        SELECT kind, payload, seq
          FROM session_events se
         WHERE se.agent_id = acs.agent_id
           AND se.chat_id  = acs.chat_id
           AND se.kind     IN ('error', 'turn_end')
         ORDER BY se.seq DESC
         LIMIT 10
      ) e
     WHERE acs.chat_id IN (${chatIdInClause})
     ORDER BY acs.chat_id, acs.agent_id, e.seq DESC
  `)) as unknown as Array<{
    agent_id: string;
    chat_id: string;
    kind: string;
    payload: unknown;
  }>;

  const seen = new Set<string>();
  const latestSuccessfulTurnEnd = new Set<string>();
  for (const row of rawRows) {
    const key = pairKey(row.chat_id, row.agent_id);
    if (seen.has(key)) continue;
    if (row.kind === "turn_end") {
      const payload = row.payload as { status?: unknown } | null;
      if (payload?.status === "success") latestSuccessfulTurnEnd.add(key);
      continue;
    }
    if (row.kind !== "error") continue;
    const payload = row.payload as { message?: unknown } | null;
    if (typeof payload?.message !== "string") continue;
    const retryPayload = parseProviderRetryEventMessage(payload.message);
    if (!retryPayload) continue;
    seen.add(key);
    if (retryPayload.scope === "provider_turn" && latestSuccessfulTurnEnd.has(key)) continue;
    const reason = statusReasonFromProviderRetryEvent(retryPayload);
    if (!reason) continue;
    let perAgent = out.get(row.chat_id);
    if (!perAgent) {
      perAgent = new Map();
      out.set(row.chat_id, perAgent);
    }
    perAgent.set(row.agent_id, reason);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The producer
// ---------------------------------------------------------------------------

const ROW_SEP = " ";
const pairKey = (chatId: string, agentId: string) => `${chatId}${ROW_SEP}${agentId}`;

/**
 * Composite per-(agent,chat) status for every relevant non-human agent across
 * `chatIds`, grouped chatId → AgentChatStatus[].
 *
 * Agent set per chat = the non-human speakers (the /agent-status set; every
 * speaker resolves so a reachable-but-idle speaker still reads `ready` and an
 * unbound one `offline`). Non-speaker session-holders are intentionally NOT
 * included: after the chat-list live-dot narrowed to speakers they surface on
 * no list/panel.
 *
 * Callers project per-surface (each already knows its speaker set):
 *   - /agent-status → filter to non-human speakers (getChatAgentStatuses).
 *   - me/chats failed/live-dot → speaker-filtered.
 */
export async function resolveAgentChatStatuses(
  db: Database,
  chatIds: string[],
  opts?: {
    withTurnText?: boolean;
    includeStatusReason?: boolean;
    nonHumanSpeakersByChat?: ReadonlyMap<string, ReadonlySet<string>>;
  },
): Promise<Map<string, AgentChatStatus[]>> {
  const out = new Map<string, AgentChatStatus[]>();
  if (chatIds.length === 0) return out;

  const unionByChat = new Map<string, Set<string>>();
  const addUnion = (chatId: string, agentId: string) => {
    let s = unionByChat.get(chatId);
    if (!s) {
      s = new Set();
      unionByChat.set(chatId, s);
    }
    s.add(agentId);
  };

  // -- Non-human speakers per chat.
  // The conversation-list hydration has already loaded speaker membership for
  // its participant chips. Let that caller provide the same canonical set so a
  // list request does not immediately repeat the membership query. Detail
  // surfaces omit the map and retain the self-contained resolver path.
  if (opts?.nonHumanSpeakersByChat) {
    for (const chatId of chatIds) {
      for (const agentId of opts.nonHumanSpeakersByChat.get(chatId) ?? []) {
        addUnion(chatId, agentId);
      }
    }
  } else {
    const speakerRows = await db
      .select({ chatId: chatMembership.chatId, agentId: chatMembership.agentId })
      .from(chatMembership)
      .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
      .where(
        and(
          inArray(chatMembership.chatId, chatIds),
          eq(chatMembership.accessMode, "speaker"),
          ne(agents.type, "human"),
        ),
      );
    for (const r of speakerRows) addUnion(r.chatId, r.agentId);
  }
  if (unionByChat.size === 0) return out;

  const allAgentIds = [...new Set([...unionByChat.values()].flatMap((s) => [...s]))];

  // -- Engagement (C) + D-axis runtime: per-(agent,chat) session row.
  // `runtime_state` / `runtime_state_at` feed `computeWorking` / `computeErrored`
  // — the per-chat authoritative source replacing the legacy event-proxy
  // (which only knew "fresh event = working" and missed codex no-events).
  const sessionRows = await db
    .select({
      agentId: agentChatSessions.agentId,
      chatId: agentChatSessions.chatId,
      state: agentChatSessions.state,
      runtimeState: agentChatSessions.runtimeState,
      runtimeStateAt: agentChatSessions.runtimeStateAt,
      backgroundWork: agentChatSessions.backgroundWork,
    })
    .from(agentChatSessions)
    .where(and(inArray(agentChatSessions.chatId, chatIds), inArray(agentChatSessions.agentId, allAgentIds)));
  const sessionByPair = new Map(sessionRows.map((s) => [pairKey(s.chatId, s.agentId), s]));

  // -- Reachability (A) + legacy presence runtime (for the old-client
  //    fallback path only — see `computeWorking` / `computeErrored`).
  //    For agents whose client has already reported per-chat runtime at
  //    least once (`runtime_state_at IS NOT NULL`), `presence.runtimeState`
  //    is NOT consumed by composite working / errored — the per-chat path
  //    is authoritative and the reverse-#366 leak stays closed. For agents
  //    that have never reported (NULL stamp = old client in the upgrade
  //    window) we fall back to the legacy `session_events` freshness proxy
  //    for working AND the legacy `presence.runtimeState === 'error'`
  //    OR-fold for errored, for one release cycle. Matches the approved
  //    spec (proposals/hub-agent-status-working-freshness.20260525.md
  //    §6.1 §10).
  const presenceRows = await db
    .select({
      agentId: agentPresence.agentId,
      clientId: agentPresence.clientId,
      instanceId: agentPresence.instanceId,
      runtimeState: agentPresence.runtimeState,
    })
    .from(agentPresence)
    .where(inArray(agentPresence.agentId, allAgentIds));
  const presenceById = new Map(presenceRows.map((p) => [p.agentId, p]));

  // -- Reset capability: derived from the DB via the SAME authoritative
  //    route predicate as the Reset preflight / fan-out / ack store
  //    (see session-command-rpc): durable agent binding + online presence +
  //    connected client must agree on client/instance, and the client must
  //    have registered the composite `wsSessionResetV1` capability. Never
  //    derived from this process's socket ownership, so every replica
  //    projects the same answer.
  const routeRows =
    allAgentIds.length > 0
      ? await db
          .select({
            agentId: agents.uuid,
            agentClientId: agents.clientId,
            agentStatus: agents.status,
            presenceStatus: agentPresence.status,
            presenceClientId: agentPresence.clientId,
            presenceInstanceId: agentPresence.instanceId,
            clientStatus: clients.status,
            clientInstanceId: clients.instanceId,
            clientMetadata: clients.metadata,
            clientSdkVersion: clients.sdkVersion,
          })
          .from(agents)
          .innerJoin(agentPresence, eq(agentPresence.agentId, agents.uuid))
          .innerJoin(clients, eq(clients.id, agentPresence.clientId))
          .where(inArray(agents.uuid, allAgentIds))
      : [];
  const resetCapableAgents = new Set(
    routeRows
      .filter((r) => isConsistentAgentRoute(r) && metadataSupportsSessionReset(r.clientMetadata))
      .map((r) => r.agentId),
  );
  // Team Skill invocation gate: same DB-authoritative route predicate as
  // Reset above, but the verdict comes from the connected client's
  // `sdk_version` via the shared release helper - old, unknown-version,
  // offline, or unbound clients never count, and nothing is persisted.
  const teamSkillCapableAgents = new Set(
    routeRows
      .filter((r) => isConsistentAgentRoute(r) && supportsTeamSkillInvocationClientVersion(r.clientSdkVersion))
      .map((r) => r.agentId),
  );

  // -- Activity (D): per-(agent,chat) live activity (+ turnText when asked).
  //    Pure description: 60s drop here means "5-min-old tool_call is not the
  //    current activity description", not "agent is not working" (which is
  //    decided by `computeWorking` above).
  const activityByChat = await deriveActivities(db, chatIds, { withTurnText: opts?.withTurnText });
  // The list DTO consumes working / errored / activity only. Provider retry
  // reasons belong to the chat-detail agent-status surface, so list hydration
  // explicitly skips this LATERAL session-event seek while the default detail
  // path remains unchanged.
  const statusReasonByChat =
    opts?.includeStatusReason === false
      ? new Map<string, Map<string, AgentStatusReason>>()
      : await deriveStatusReasons(db, chatIds);

  const now = Date.now();
  for (const [chatId, agentSet] of unionByChat) {
    const perAgentActivity = activityByChat.get(chatId);
    const perAgentStatusReason = statusReasonByChat.get(chatId);
    const arr: AgentChatStatus[] = [];
    for (const agentId of agentSet) {
      const sess = sessionByPair.get(pairKey(chatId, agentId));
      const state = sess?.state;
      const p = presenceById.get(agentId);
      const activity = perAgentActivity?.get(agentId) ?? null;
      const engagement: AgentEngagement = state === "active" ? "active" : state === "suspended" ? "suspended" : "none";
      const working = computeWorking(sess, activity, now);
      const axes = {
        reachable: p?.clientId != null,
        errored: computeErrored(sess, p?.runtimeState ?? null, now),
        working,
        engagement,
      };
      // Only a chat that actually reduces to `ready` may carry the qualifier.
      // A disconnect keeps the last runtime row fresh for the stale window, so
      // gating on `!working` alone would render "Offline · Background task".
      const backgroundWork = deriveMainStatus(axes) === "ready" && computeBackgroundWork(sess, now);
      // A `provider_turn`-scoped `terminal` reason (provider_retry_exhausted /
      // provider_failure_terminal) records that a *past* turn's provider attempts
      // gave up. Once the agent is `working` again it is on a NEW turn, so that
      // reason is stale and must be dropped — otherwise the compose status bar
      // (where the reason view overrides the main view) keeps rendering a red
      // "Provider retry exhausted" over an agent that has visibly recovered.
      // `deriveStatusReasons` only clears a provider_turn terminal reason at the
      // next *successful* `turn_end`, which has not landed while the new turn is
      // still in flight; this closes that mid-turn gap.
      //
      // Scoped strictly to `provider_turn`: a `session_start` / `session_resume`
      // terminal reason is session-scoped, not turn-scoped, so a turn-level
      // "working" signal must NOT erase it from the status projection. Web
      // surfaces that should prefer live working over the stale-looking banner
      // can choose to suppress it at presentation time. `retrying` / `waiting`
      // reasons legitimately co-occur with working (an in-turn foreground retry)
      // and are kept. Failed agents (errored ⇒ main "failed", working=false)
      // also keep the reason — that is the correct co-display on the failure row.
      const reason = perAgentStatusReason?.get(agentId);
      const isStaleTurnTerminal = reason?.kind === "terminal" && reason.scope === "provider_turn";
      const statusReason = working && isStaleTurnTerminal ? undefined : reason;
      arr.push(
        buildAgentChatStatus({
          agentId,
          ...axes,
          // The activity is a descriptor of in-flight work — carry it only
          // while working, matching the schema's "null when not working"
          // contract. Codex no-events case (new-client authoritative path):
          // working=true & activity=null ⇒ UI shows a generic "Working"
          // with no tool detail.
          //
          // Transient inversion to note for posterity (non-blocking; matches
          // the spec's "activity is description-only when working"): a
          // `session:event` recompute that races marginally ahead of its
          // corresponding `session:runtime working` (different paths — events
          // aren't in chainSessionOp) briefly emits activity=null; the next
          // runtime frame self-heals.
          activity: working ? activity : null,
          statusReason,
          // Why an idle chat is not finished. Descriptive only — `main` stays
          // `ready` — and suppressed while working, where the running turn is
          // the more specific truth.
          backgroundWork,
          // Live-connection capability gate for the Web chat-session Reset:
          // only a client that negotiated the composite v1 protocol can both
          // prove the old provider mapping is gone and release the rows it
          // parks while the server finalizes.
          sessionResetSupported: resetCapableAgents.has(agentId),
          // Live-connection rollout gate for Team Skill slash commands:
          // only a client whose version parses the server-owned invocation
          // marker fail-closed may be offered Team Skills in the composer.
          teamSkillInvocationSupported: teamSkillCapableAgents.has(agentId),
        }),
      );
    }
    out.set(chatId, arr);
  }
  return out;
}

// ---------------------------------------------------------------------------
// D-axis projection helpers — pure, exported for unit tests.
//
// The composite working / errored axes are fed by the per-chat
// `agent_chat_sessions.runtime_state` (+ `runtime_state_at` freshness) for
// NEW clients (any client that has reported `session:runtime` at least once
// for this pair — `runtime_state_at IS NOT NULL`). For OLD clients in the
// upgrade window (NULL stamp, never reported) we fall back to the legacy
// signals for one release cycle:
//   - working: the latest non-terminal `session_events` row within
//     LIVE_ACTIVITY_STALE_MS (the pre-PR proxy).
//   - errored: the agent-global `presence.runtime_state === 'error'` OR-fold
//     only (never `blocked` — that signal is not chat-scoped and used to
//     false-alarm on long reasoning). Still has the reverse-#366 cross-chat
//     leak for old clients on `error`; that is the existing prod envelope and
//     self-closes when the client upgrades and starts reporting per-chat.
// `state === 'errored'` (C-axis lifecycle) always contributes to errored
// independently of the D-axis on both paths. Fresh `working` is never
// recovery; stale in-flight D-axis is. Per-chat `blocked` recovery requires a
// non-NULL per-chat stamp.
//
// Spec reference: proposals/hub-agent-status-working-freshness.20260525.md
// §6.1 §10 ("保留旧 client 兼容兜底一个发布周期").
// ---------------------------------------------------------------------------

// `runtimeState` is `text` in the DB (no enum constraint at the TS level), so
// it surfaces as plain `string` from drizzle. Helpers compare to literal
// values — a row carrying an unrecognised value falls into the fail-closed
// default (not working, not errored from D-axis), which is the right
// degradation if a buggy producer ever wrote a junk state.
type RuntimeSessionRow =
  | {
      state: string;
      runtimeState: string;
      runtimeStateAt: Date | null;
      backgroundWork?: boolean;
    }
  | undefined;

/**
 * True iff the new-client authoritative path applies — session is active and
 * the client has reported per-chat runtime within the freshness window.
 * Returns false for old clients (NULL stamp), stale stamps, and non-active
 * sessions; the caller should fall back to legacy signals on false-with-
 * NULL-stamp. Stale in-flight runtime is recovery (`computeErrored`), not
 * working.
 */
export function isRuntimeFresh(session: RuntimeSessionRow, now: number): boolean {
  if (!session || session.state !== "active") return false;
  if (session.runtimeStateAt == null) return false;
  return now - session.runtimeStateAt.getTime() <= RUNTIME_STALE_MS;
}

/**
 * Authoritative path: active session + fresh `runtime_state === 'working'`.
 * Old-client fallback (NULL stamp on an active session): the presence of
 * any fresh non-terminal `session_events` row (= `activity != null`), which
 * is exactly what the pre-PR producer used. Old-client fallback for a
 * stale stamp is intentionally NOT applied — once a client has reported
 * per-chat runtime at least once we stay on the new path and let the
 * freshness window decide (so `RUNTIME_STALE_MS` cannot regress for an
 * upgraded client just because of a transient disconnect).
 */
export function computeWorking(session: RuntimeSessionRow, activity: LiveActivity | null, now: number): boolean {
  if (!session || session.state !== "active") return false;
  if (session.runtimeStateAt == null) {
    // Old client (one release cycle): legacy event-proxy fallback.
    return activity != null;
  }
  return isRuntimeFresh(session, now) && session.runtimeState === ("working" satisfies RuntimeState);
}

/**
 * Descriptive companion to `computeWorking`: the client last reported that the
 * provider is parked on work it started itself and will resume unprompted.
 *
 * This answers only "did a live client recently say so", gated on the SAME
 * freshness window as `working` — a client that dies or stops reporting stops
 * asserting background work rather than leaving a permanent "background task"
 * on a chat nobody is running. Whether that claim is worth *showing* is a
 * separate question the caller answers, because the marker qualifies the word
 * "Idle" specifically: an unreachable, failed, paused, or working chat is not
 * idle, and appending "· Background task" to any of those states would state
 * something the composite does not mean. Never an input to `main`.
 */
export function computeBackgroundWork(session: RuntimeSessionRow, now: number): boolean {
  if (!isRuntimeFresh(session, now)) return false;
  return session?.backgroundWork === true;
}

function isFaultRuntime(runtimeState: string): boolean {
  return runtimeState === ("error" satisfies RuntimeState) || runtimeState === ("blocked" satisfies RuntimeState);
}

function isInFlightRuntime(runtimeState: string): boolean {
  return isFaultRuntime(runtimeState) || runtimeState === ("working" satisfies RuntimeState);
}

/**
 * Authoritative path: C-axis `state === 'errored'` always contributes.
 * D-axis recovery contributes when the session is active and either:
 *   - the stamp is fresh and runtime is `error` or `blocked`, or
 *   - the stamp is stale and the last runtime was still in-flight
 *     (`working` / `blocked` / `error`) — a dead client must not look idle.
 * Fresh `working` is never recovery. Old-client fallback (NULL stamp on an
 * active session): legacy `presence.runtime_state === 'error'` only — never
 * agent-global `blocked`, which is not chat-scoped and historically false-
 * alarmed during long reasoning turns. The reverse-#366 cross-chat leak for
 * global `error` remains the existing prod envelope and self-closes when the
 * client upgrades and starts reporting per-chat runtime.
 */
export function computeErrored(session: RuntimeSessionRow, presenceRuntimeState: string | null, now: number): boolean {
  if (session?.state === "errored") return true;
  if (!session || session.state !== "active") return false;
  if (session.runtimeStateAt == null) {
    // Old client (one release cycle): legacy agent-global error fallback only.
    return presenceRuntimeState === "error";
  }
  if (isRuntimeFresh(session, now)) return isFaultRuntime(session.runtimeState);
  return isInFlightRuntime(session.runtimeState);
}

/**
 * Composite status for every non-human speaker in a chat — the
 * server-authoritative aggregation behind `GET /chats/:chatId/agent-status`.
 * Thin projection over `resolveAgentChatStatuses`, filtered to the speaker set
 * (the union may also contain a pending non-speaker, which this surface omits).
 */
export async function getChatAgentStatuses(db: Database, chatId: string): Promise<AgentChatStatus[]> {
  const byChat = await resolveAgentChatStatuses(db, [chatId], { withTurnText: true });
  return byChat.get(chatId) ?? [];
}
