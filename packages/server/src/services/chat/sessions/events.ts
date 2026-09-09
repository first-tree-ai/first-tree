import type {
  ChatTokenUsage,
  ContextTreeUsageEvent,
  ContextTreeUsageSummary,
  SessionEvent,
  SessionEventKind,
} from "@first-tree/shared";
import { sessionEventSchema } from "@first-tree/shared";
import { and, asc, desc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "../../../db/connection.js";
import { agentChatSessions } from "../../../db/schema/agent-chat-sessions.js";
import { agents } from "../../../db/schema/agents.js";
import { chatMembership } from "../../../db/schema/chat-membership.js";
import { chats } from "../../../db/schema/chats.js";
import { sessionEvents } from "../../../db/schema/session-events.js";
import { uuidv7 } from "../../../uuid.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
// Worst-case under READ COMMITTED, N concurrent appendEvent calls on the same
// (agent, chat) all snapshot `MAX(seq)` together and lock-step into the same
// candidate seq — each round eliminates exactly one loser, so up to N retries
// can be needed before the last caller finds a free slot. 8 leaves slack for
// the realistic burst ceiling (production is ~1 concurrent per session); a
// CI herd at N=5 with the old budget of 3 flaked.
const MAX_SEQ_RETRIES = 8;
// Spread retriers so they don't re-read `MAX(seq)` in lock-step after losing
// the previous round. Skipped on the first attempt — the happy path stays
// zero-latency.
const RETRY_JITTER_MS = 20;

export type SessionEventRow = {
  id: string;
  agentId: string;
  chatId: string;
  seq: number;
  kind: SessionEventKind;
  payload: SessionEvent["payload"];
  createdAt: string;
};

export type ChatSessionEventFeed = {
  agentId: string;
  items: SessionEventRow[];
  nextCursor: number | null;
  /** Stable start of the active turn, independent of the capped event window. */
  turnStartedAt: string | null;
};

const NUL_CHAR = "\u0000";

function stripNulFromJsonbValue(value: unknown): unknown {
  if (typeof value === "string") return value.replaceAll(NUL_CHAR, "");
  if (Array.isArray(value)) return value.map(stripNulFromJsonbValue);
  if (value === null || typeof value !== "object") return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    sanitized[key.replaceAll(NUL_CHAR, "")] = stripNulFromJsonbValue(nested);
  }
  return sanitized;
}

function stringifyJsonbPayload(payload: SessionEvent["payload"]): string {
  const json = JSON.stringify(stripNulFromJsonbValue(payload));
  if (json === undefined) {
    throw new Error("session event payload could not be serialized");
  }
  return json;
}

function rowToEvent(row: {
  id: string;
  agentId: string;
  chatId: string;
  seq: number;
  kind: string;
  payload: unknown;
  createdAt: Date;
}): SessionEventRow {
  return {
    id: row.id,
    agentId: row.agentId,
    chatId: row.chatId,
    seq: row.seq,
    kind: row.kind as SessionEventKind,
    payload: row.payload as SessionEvent["payload"],
    createdAt: row.createdAt.toISOString(),
  };
}

/** Append one event; throws after MAX_SEQ_RETRIES on persistent seq contention. */
export async function appendEvent(
  db: Database,
  agentId: string,
  chatId: string,
  event: SessionEvent,
): Promise<SessionEventRow> {
  const validated = sessionEventSchema.parse(event);

  for (let attempt = 0; attempt < MAX_SEQ_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, Math.random() * RETRY_JITTER_MS));
    }
    const id = uuidv7();
    // PG JSONB rejects U+0000 outright. Strip the actual NUL characters before
    // serializing so ordinary text containing the literal sequence `\u0000`
    // (for example source code previews) remains valid and unchanged.
    const payloadJson = stringifyJsonbPayload(validated.payload);
    const result = await db.execute<{
      id: string;
      agent_id: string;
      chat_id: string;
      seq: number;
      kind: string;
      payload: unknown;
      created_at: Date;
    }>(sql`
      INSERT INTO session_events (id, agent_id, chat_id, seq, kind, payload)
      SELECT ${id}, ${agentId}, ${chatId},
             COALESCE(MAX(seq), 0) + 1, ${validated.kind}, ${payloadJson}::jsonb
        FROM session_events
       WHERE agent_id = ${agentId} AND chat_id = ${chatId}
      ON CONFLICT (agent_id, chat_id, seq) DO NOTHING
      RETURNING id, agent_id, chat_id, seq, kind, payload, created_at
    `);

    const row = result[0];
    if (row) {
      const persisted = rowToEvent({
        id: row.id,
        agentId: row.agent_id,
        chatId: row.chat_id,
        seq: row.seq,
        kind: row.kind,
        payload: row.payload,
        createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
      });

      return persisted;
    }
  }

  throw new Error(`session_events seq contention on ${agentId}/${chatId}`);
}

/**
 * Append one event only while the session is still live. Returns null when
 * the session row is `evicted` — a stale producer (an old turn racing the
 * operator's terminate, or a late frame after eviction) must never recreate
 * the traces terminate just cleared.
 *
 * The check takes the session row FOR UPDATE inside the insert transaction,
 * serializing against `transitionSessionState` (which takes the same lock
 * before evicting). Terminate runs its awaited `clearEvents` only after that
 * transition commits, so one of two orderings always holds: the event insert
 * commits first and the cleanup delete covers it, or the insert observes the
 * committed evicted state and is dropped here.
 *
 * A missing session row does not gate — legitimate producers can emit before
 * the server-side projection materializes. `appendEvent` stays the ungated
 * variant for seeds and tests.
 */
export async function appendLiveEvent(
  db: Database,
  agentId: string,
  chatId: string,
  event: SessionEvent,
): Promise<SessionEventRow | null> {
  const validated = sessionEventSchema.parse(event);

  for (let attempt = 0; attempt < MAX_SEQ_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, Math.random() * RETRY_JITTER_MS));
    }
    const outcome = await db.transaction(async (tx) => {
      const [session] = await tx
        .select({ state: agentChatSessions.state })
        .from(agentChatSessions)
        .where(and(eq(agentChatSessions.agentId, agentId), eq(agentChatSessions.chatId, chatId)))
        .for("update");
      if (session?.state === "evicted") return null;
      const id = uuidv7();
      const payloadJson = stringifyJsonbPayload(validated.payload);
      const result = await tx.execute<{
        id: string;
        agent_id: string;
        chat_id: string;
        seq: number;
        kind: string;
        payload: unknown;
        created_at: Date;
      }>(sql`
        INSERT INTO session_events (id, agent_id, chat_id, seq, kind, payload)
        SELECT ${id}, ${agentId}, ${chatId},
               COALESCE(MAX(seq), 0) + 1, ${validated.kind}, ${payloadJson}::jsonb
          FROM session_events
         WHERE agent_id = ${agentId} AND chat_id = ${chatId}
        ON CONFLICT (agent_id, chat_id, seq) DO NOTHING
        RETURNING id, agent_id, chat_id, seq, kind, payload, created_at
      `);
      return result[0] ?? undefined;
    });
    if (outcome === null) return null;
    if (outcome) {
      return rowToEvent({
        id: outcome.id,
        agentId: outcome.agent_id,
        chatId: outcome.chat_id,
        seq: outcome.seq,
        kind: outcome.kind,
        payload: outcome.payload,
        createdAt: outcome.created_at instanceof Date ? outcome.created_at : new Date(outcome.created_at),
      });
    }
  }

  throw new Error(`session_events seq contention on ${agentId}/${chatId}`);
}

/**
 * List events for a session with cursor pagination.
 *
 * - `direction: "asc"` (default) walks oldest → newest; cursor is the last
 *   seq seen on the previous page (next page starts at seq > cursor).
 * - `direction: "desc"` walks newest → oldest; cursor is the last seq seen
 *   on the previous page (next page starts at seq < cursor). The chat UI
 *   uses desc so its turn-grouping filter always sees the most recent
 *   `turn_end` even when the chat has thousands of events.
 */
export async function listEvents(
  db: Database,
  agentId: string,
  chatId: string,
  options?: { limit?: number; cursor?: number; direction?: "asc" | "desc" },
): Promise<{ items: SessionEventRow[]; nextCursor: number | null }> {
  const limit = Math.min(Math.max(options?.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const direction = options?.direction ?? "asc";

  const conditions = [eq(sessionEvents.agentId, agentId), eq(sessionEvents.chatId, chatId)];
  if (options?.cursor !== undefined) {
    conditions.push(
      direction === "desc" ? lt(sessionEvents.seq, options.cursor) : gt(sessionEvents.seq, options.cursor),
    );
  }

  const rows = await db
    .select({
      id: sessionEvents.id,
      agentId: sessionEvents.agentId,
      chatId: sessionEvents.chatId,
      seq: sessionEvents.seq,
      kind: sessionEvents.kind,
      payload: sessionEvents.payload,
      createdAt: sessionEvents.createdAt,
    })
    .from(sessionEvents)
    .where(and(...conditions))
    .orderBy(direction === "desc" ? desc(sessionEvents.seq) : asc(sessionEvents.seq))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map(rowToEvent);
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? last.seq : null;

  return { items, nextCursor };
}

/**
 * List the newest event window for every non-human speaker in one chat.
 *
 * The caller-facing route gates the viewer with `requireChatAccess`; this
 * query independently constrains event owners to current speaker membership.
 * That makes chat membership the disclosure boundary without broadening the
 * agent's org-level discoverability.
 *
 * Query shape (one SQL statement / snapshot):
 *   - `authorized_speakers`: the chat's current speaker membership with the
 *     agent type / same-org constraints — the disclosure boundary.
 *   - Per speaker, a `CROSS JOIN LATERAL` event window that uses the unique
 *     `(agent_id, chat_id, seq)` index (`ORDER BY seq` + `LIMIT limit + 1`,
 *     asc or desc). Payloads are carried ONLY for these returned rows.
 *   - Per speaker, current-turn metadata (last `turn_end` seq + `MIN(created_at)`
 *     of the eligible kinds after it) is computed ONCE per speaker in a
 *     MATERIALIZED CTE over seq/kind/created_at only — never once per
 *     returned event, and never over full-history window sorts. It stays
 *     independent of the capped event window, so a limit=2 desc page still
 *     reports a turn that started outside the window. `MIN(created_at)` is
 *     kept exactly — seq order does not prove monotonic timestamps.
 */
export async function listChatSpeakerEvents(
  db: Database,
  chatId: string,
  options?: { limit?: number; direction?: "asc" | "desc" },
): Promise<{ feeds: ChatSessionEventFeed[] }> {
  const limit = Math.min(Math.max(options?.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const direction = options?.direction ?? "asc";
  const orderFragment = direction === "desc" ? sql`DESC` : sql`ASC`;

  const rows = await db.execute<SpeakerWindowRow>(sql`
    WITH authorized_speakers AS MATERIALIZED (
      SELECT cm.agent_id AS agent_id
        FROM chat_membership cm
        INNER JOIN agents a ON a.uuid = cm.agent_id
        INNER JOIN chats ch ON ch.id = cm.chat_id
       WHERE cm.chat_id = ${chatId}
         AND cm.access_mode = 'speaker'
         AND a.type = 'agent'
         AND a.organization_id = ch.organization_id
    ),
    -- Per-speaker current-turn metadata, computed once per speaker from
    -- seq/kind/created_at only (never full payloads): the last turn_end seq
    -- and the earliest created_at of the eligible current-turn kinds after
    -- it. Materialized so the planner cannot inline it per returned row.
    speaker_meta AS MATERIALIZED (
      SELECT sp.agent_id                    AS agent_id,
             coalesce(last_end.last_turn_end_seq, 0) AS last_turn_end_seq,
             turn_start.turn_started_at     AS turn_started_at
        FROM authorized_speakers sp
        LEFT JOIN LATERAL (
          SELECT max(se.seq) AS last_turn_end_seq
            FROM session_events se
           WHERE se.agent_id = sp.agent_id
             AND se.chat_id  = ${chatId}
             AND se.kind     = 'turn_end'
        ) last_end ON TRUE
        LEFT JOIN LATERAL (
          SELECT min(se.created_at) AS turn_started_at
            FROM session_events se
           WHERE se.agent_id = sp.agent_id
             AND se.chat_id  = ${chatId}
             AND se.kind     IN ('tool_call', 'thinking', 'assistant_text')
             AND se.seq > coalesce(last_end.last_turn_end_seq, 0)
        ) turn_start ON TRUE
    )
    SELECT sp.agent_id       AS "agentId",
           w.id              AS id,
           w.chat_id         AS "chatId",
           w.seq             AS seq,
           w.kind            AS kind,
           w.payload         AS payload,
           w.created_at      AS "createdAt",
           m.turn_started_at AS "turnStartedAt"
      FROM authorized_speakers sp
      CROSS JOIN LATERAL (
        SELECT se.id AS id, se.chat_id AS chat_id, se.seq AS seq, se.kind AS kind,
               se.payload AS payload, se.created_at AS created_at
          FROM session_events se
         WHERE se.agent_id = sp.agent_id
           AND se.chat_id  = ${chatId}
         ORDER BY se.seq ${orderFragment}
         LIMIT ${limit + 1}
      ) w
      LEFT JOIN speaker_meta m ON m.agent_id = sp.agent_id
     ORDER BY sp.agent_id, w.seq ${orderFragment}
  `);

  const rowsByAgent = new Map<string, SpeakerWindowRow[]>();
  for (const row of rows) {
    const feedRows = rowsByAgent.get(row.agentId);
    if (feedRows) feedRows.push(row);
    else rowsByAgent.set(row.agentId, [row]);
  }

  return {
    feeds: [...rowsByAgent].map(([agentId, feedRows]) => {
      const hasMore = feedRows.length > limit;
      const items = (hasMore ? feedRows.slice(0, limit) : feedRows).map(toEventRow).map(rowToEvent);
      const last = items[items.length - 1];
      const turnStartedAt = feedRows[0]?.turnStartedAt ?? null;
      const turnStartedAtIso =
        turnStartedAt instanceof Date
          ? turnStartedAt.toISOString()
          : typeof turnStartedAt === "string"
            ? new Date(turnStartedAt).toISOString()
            : null;
      return {
        agentId,
        items,
        nextCursor: hasMore && last ? last.seq : null,
        turnStartedAt: turnStartedAtIso,
      };
    }),
  };
}

/** Raw row shape returned by `listChatSpeakerEvents` (snake_case columns
 *  aliased to camelCase in SQL). Timestamp values may arrive as JS `Date` or
 *  as ISO/format strings depending on the driver's timestamp parsing, so
 *  `createdAt` / `turnStartedAt` are normalized defensively before use. */
type SpeakerWindowRow = {
  agentId: string;
  id: string;
  chatId: string;
  seq: number;
  kind: string;
  payload: unknown;
  createdAt: Date | string;
  turnStartedAt: Date | string | null;
};

function toEventRow(row: SpeakerWindowRow): {
  id: string;
  agentId: string;
  chatId: string;
  seq: number;
  kind: string;
  payload: unknown;
  createdAt: Date;
} {
  return {
    id: row.id,
    agentId: row.agentId,
    chatId: row.chatId,
    seq: row.seq,
    kind: row.kind,
    payload: row.payload,
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
  };
}

/** Delete all events for a session — called on eviction / termination. */
export async function clearEvents(db: Database, agentId: string, chatId: string): Promise<void> {
  await db.delete(sessionEvents).where(and(eq(sessionEvents.agentId, agentId), eq(sessionEvents.chatId, chatId)));
}

const CONTEXT_TREE_USAGE_FEED_LIMIT = 50;

/**
 * Read the tree-root-relative `nodePath` out of a stored context_tree_usage
 * payload (jsonb). Pre-P0 events predate the field and resolve to null; the
 * payload is `unknown` from the DB driver so we narrow defensively.
 */
function nodePathFromPayload(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "nodePath" in payload) {
    const value = (payload as { nodePath?: unknown }).nodePath;
    if (typeof value === "string") return value;
  }
  return null;
}

/**
 * The caller's identity within the org whose usage feed is being read.
 * Used to decide, per event, whether the caller may actually open the chat
 * (`viewerCanAccess`). Both fields are scoped to the same org as the feed,
 * so they mirror the values `requireChatAccess` would resolve for the chat.
 */
export type ContextTreeUsageViewer = {
  /** The caller's HUMAN agent in this org (the chat_membership anchor). */
  humanAgentId: string;
  /** The caller's `members.id` in this org (the manage-a-speaker anchor). */
  memberId: string;
};

/**
 * Of `chatIds` (all in the viewer's org), the subset the viewer may open.
 * Mirrors `requireChatAccess` exactly: a chat is accessible if the caller's
 * human agent has any `chat_membership` row (speaker OR watcher), or the
 * caller manages an agent that is a `speaker` in the chat. Two batched
 * queries bounded by `chatIds` — no per-event N+1.
 */
async function accessibleChatIdSet(
  db: Database,
  viewer: ContextTreeUsageViewer,
  chatIds: string[],
): Promise<Set<string>> {
  const accessible = new Set<string>();
  if (chatIds.length === 0) return accessible;

  // Direct membership — caller's human agent is a speaker or watcher.
  const directRows = await db
    .select({ chatId: chatMembership.chatId })
    .from(chatMembership)
    .where(and(inArray(chatMembership.chatId, chatIds), eq(chatMembership.agentId, viewer.humanAgentId)));
  for (const row of directRows) accessible.add(row.chatId);

  // Supervised speaker — caller manages an agent that speaks in the chat.
  const supervisedRows = await db
    .select({ chatId: chatMembership.chatId })
    .from(chatMembership)
    .innerJoin(agents, eq(agents.uuid, chatMembership.agentId))
    .where(
      and(
        inArray(chatMembership.chatId, chatIds),
        eq(chatMembership.accessMode, "speaker"),
        eq(agents.managerId, viewer.memberId),
      ),
    );
  for (const row of supervisedRows) accessible.add(row.chatId);

  return accessible;
}

/**
 * Org-wide aggregate counts + the most recent context-tree usage events
 * for the org. The Context Tab is an org-wide transparency surface — any
 * member can see who has been using the tree, including the chat topic
 * each session belongs to. Chat *content* stays gated by
 * `requireChatAccess` on the chat-detail route; this feed only exposes
 * the topic label (and id, for routing).
 *
 * The only chat-related gate here is **cross-org**: an event whose
 * `chat_id` points at a chat outside this org has both `chatId` and
 * `chatTitle` masked to null. `chats` is left-joined under an explicit
 * `organization_id = $org` predicate so the planner cannot accidentally
 * surface a foreign org's topic; the resulting `joinedChatId` is the
 * authoritative signal for "this chat lives in this org".
 *
 * `viewerCanAccess` is layered on top: the topic/id stay org-wide visible,
 * but only a `viewer` who passes `requireChatAccess`'s membership rule for a
 * given chat gets `viewerCanAccess: true` (the web feed turns that into a
 * clickable deep link; everyone else sees inert text). Fail-closed: when no
 * `viewer` is supplied every event is `viewerCanAccess: false`.
 */
export async function summarizeContextTreeUsage(
  db: Database,
  organizationId: string,
  windowDays: number,
  viewer?: ContextTreeUsageViewer,
): Promise<ContextTreeUsageSummary> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const [aggregate] = await db
    .select({
      agentCount: sql<number>`count(distinct ${sessionEvents.agentId})::int`,
      usageCount: sql<number>`count(*)::int`,
    })
    .from(sessionEvents)
    .innerJoin(agents, eq(agents.uuid, sessionEvents.agentId))
    .where(
      and(
        eq(agents.organizationId, organizationId),
        eq(sessionEvents.kind, "context_tree_usage"),
        gte(sessionEvents.createdAt, since),
      ),
    );

  const recentRows = await db
    .select({
      id: sessionEvents.id,
      agentId: sessionEvents.agentId,
      agentName: agents.displayName,
      agentAvatarColorToken: agents.avatarColorToken,
      rawChatId: sessionEvents.chatId,
      // chats.id from a left join is null iff the join did not match —
      // distinct from chats.topic being null (chat exists but the manager
      // has not set a topic). We branch on this to decide whether the chat
      // lives in the same org as the caller's snapshot.
      joinedChatId: chats.id,
      chatTopic: chats.topic,
      payload: sessionEvents.payload,
      createdAt: sessionEvents.createdAt,
    })
    .from(sessionEvents)
    .innerJoin(agents, eq(agents.uuid, sessionEvents.agentId))
    .leftJoin(chats, and(eq(chats.id, sessionEvents.chatId), eq(chats.organizationId, organizationId)))
    .where(
      and(
        eq(agents.organizationId, organizationId),
        eq(sessionEvents.kind, "context_tree_usage"),
        gte(sessionEvents.createdAt, since),
      ),
    )
    .orderBy(desc(sessionEvents.createdAt))
    .limit(CONTEXT_TREE_USAGE_FEED_LIMIT);

  // Resolve which in-org chats the caller may actually open, in one batch up
  // front so the per-event map stays O(1). Cross-org events are excluded here
  // because their chatId is masked away anyway.
  const inOrgChatIds = [...new Set(recentRows.filter((row) => row.joinedChatId !== null).map((row) => row.rawChatId))];
  const accessibleChatIds = viewer ? await accessibleChatIdSet(db, viewer, inOrgChatIds) : new Set<string>();

  const recentEvents: ContextTreeUsageEvent[] = recentRows.map((row) => {
    const sameOrgChat = row.joinedChatId !== null;
    return {
      id: row.id,
      agentId: row.agentId,
      agentName: row.agentName,
      agentAvatarColorToken: row.agentAvatarColorToken,
      // Mask both together when the chat is not in this org — chatId is
      // identifying info on its own. Topic being null for an in-org chat
      // is a legitimate "no topic set" signal and stays as `chatTitle: null`
      // with a non-null `chatId`.
      chatId: sameOrgChat ? row.rawChatId : null,
      chatTitle: sameOrgChat ? row.chatTopic : null,
      // Surface which node the agent read straight from the stored payload.
      // No node-frequency aggregation here — that's P1.
      nodePath: nodePathFromPayload(row.payload),
      // Org-wide we expose the chat label, but only a viewer who passes the
      // chat's membership rule gets a clickable link. Cross-org rows have no
      // chatId, so they can never be accessible.
      viewerCanAccess: sameOrgChat && accessibleChatIds.has(row.rawChatId),
      createdAt: row.createdAt.toISOString(),
    };
  });

  return {
    windowDays,
    agentCount: aggregate?.agentCount ?? 0,
    usageCount: aggregate?.usageCount ?? 0,
    recentEvents,
  };
}

/**
 * Sum every `token_usage` event for a chat into a single cumulative total.
 * Each event carries per-turn deltas (input/cached/output), so the SUM is the
 * chat's whole-history consumption. Spans every agent that participated in the
 * chat, not just the primary speaker.
 *
 * Summed in SQL as `bigint` and serialized via `::text` so a busy chat can't
 * overflow JS's safe-integer range mid-aggregation; we parse back with
 * `Number()` at the edge where the magnitudes are realistic.
 */
export async function summarizeChatTokenUsage(db: Database, chatId: string): Promise<ChatTokenUsage> {
  const [row] = await db
    .select({
      inputTokens: sql<string>`coalesce(sum((${sessionEvents.payload}->>'inputTokens')::bigint), 0)::text`,
      cachedInputTokens: sql<string>`coalesce(sum((${sessionEvents.payload}->>'cachedInputTokens')::bigint), 0)::text`,
      outputTokens: sql<string>`coalesce(sum((${sessionEvents.payload}->>'outputTokens')::bigint), 0)::text`,
    })
    .from(sessionEvents)
    .where(and(eq(sessionEvents.chatId, chatId), eq(sessionEvents.kind, "token_usage")));

  const inputTokens = Number(row?.inputTokens ?? 0);
  const cachedInputTokens = Number(row?.cachedInputTokens ?? 0);
  const outputTokens = Number(row?.outputTokens ?? 0);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: inputTokens + cachedInputTokens + outputTokens,
  };
}
