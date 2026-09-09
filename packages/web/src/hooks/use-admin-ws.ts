import { type AgentChatStatus, agentChatStatusSchema } from "@first-tree/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { chatAgentStatusQueryKey } from "../api/agent-status.js";
import {
  ADMIN_WS_MEMBERSHIP_CHANGED_EVENT,
  ADMIN_WS_ORG_CHANGED_EVENT,
  getApiSelectedOrganizationId,
  getStoredTokens,
  refreshAccessToken,
} from "../api/client.js";
import { upsertAgentStatus } from "../lib/agent-status-view.js";

type WsMessage = {
  type: string;
  [key: string]: unknown;
};

type UseAdminWsOptions = {
  /** Called for every incoming WS message. */
  onMessage?: (msg: WsMessage) => void;
  /** Whether the hook is enabled (default: true). */
  enabled?: boolean;
};

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30_000;
const ADMISSION_TIMEOUT_MS = 10_000;
const ADMISSION_TIMEOUT_CLOSE_CODE = 4013;

// Module-level singleton connection shared across all hook instances.
type QC = ReturnType<typeof useQueryClient>;
type Subscriber = (msg: WsMessage) => void;

let ws: WebSocket | null = null;
let closing = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let cancelCurrentAdmissionTimer: (() => void) | null = null;
const subscribers = new Set<Subscriber>();
let latestQc: QC | null = null;
let refCount = 0;

// `session:state` and `session:event` frames burst when an agent ticks
// through tool calls — every frame would otherwise force an invalidation
// per frame and the React-Query default (`staleTime: 0`) wouldn't dedupe.
// Leading-edge fire keeps the working ring / WorkingChip snappy; the
// trailing window collapses the burst into at most one extra round-trip
// after it ends.
//
// 1s is the long-enough-to-fold-a-burst, short-enough-to-feel-live
// trade-off — `liveActivity` (WorkingChip / chat-list dot) updates with at
// most ~1s lag, well inside the 60s server-side `liveActivity` window. Also
// applied to `chat:message` to fold storm-of-messages flurries, and to the
// `session:event` timeline keys (per-chat / per-pair throttle below) — all
// formerly invalidated every frame without a throttle.
//
// Each cache key gets its OWN leading + trailing pair via the factory
// below so bursts in one channel don't starve another. The server's
// `session:state` short-circuit (services/chat/sessions/activity.ts) is the primary
// defence — this throttle is the client-side safety net for any frame
// that does reach us (and for `chat:message` which has no server-side
// dedupe).
const INVALIDATE_THROTTLE_MS = 1000;

type ThrottledInvalidator = {
  invalidate: (qc: QC) => void;
  dispose: () => void;
};

function createThrottledInvalidator(queryKey: readonly unknown[], throttleMs: number): ThrottledInvalidator {
  let lastAt = 0;
  let trailingTimer: ReturnType<typeof setTimeout> | null = null;
  return {
    invalidate(qc: QC) {
      const now = Date.now();
      const elapsed = now - lastAt;
      if (elapsed >= throttleMs) {
        lastAt = now;
        qc.invalidateQueries({ queryKey });
        return;
      }
      if (trailingTimer === null) {
        trailingTimer = setTimeout(() => {
          trailingTimer = null;
          lastAt = Date.now();
          if (latestQc) latestQc.invalidateQueries({ queryKey });
        }, throttleMs - elapsed);
      }
    },
    dispose() {
      if (trailingTimer) {
        clearTimeout(trailingTimer);
        trailingTimer = null;
      }
    },
  };
}

const meChatsInvalidator = createThrottledInvalidator(["me", "chats"], INVALIDATE_THROTTLE_MS);
const needYouInvalidator = createThrottledInvalidator(["need-you"], INVALIDATE_THROTTLE_MS);
// `["activity"]` and `["sessions"]` are read by 5+ workspace components
// each (chat-view, roster, agent-context, new-chat-draft, team, clients,
// command-palette). A non-throttled invalidation on every `session:state`
// frame fans out into one GET per mounted component per frame — measured
// at "dozens per second" while an agent ticks through tool calls. Same
// 1s window as `me/chats` so all three keys stay roughly in lock-step.
const activityInvalidator = createThrottledInvalidator(["activity"], INVALIDATE_THROTTLE_MS);
const sessionsInvalidator = createThrottledInvalidator(["sessions"], INVALIDATE_THROTTLE_MS);
// `["chat-agent-status", chatId]` powers the right-sidebar AgentStatusPanel
// (and step 7's compose bar). Its composite per-agent status moves with
// session:state (engagement / suspend) and session:event (live activity →
// working). Prefix-invalidate so every open chat's panel refreshes; throttled
// like the rest.
const chatAgentStatusInvalidator = createThrottledInvalidator(["chat-agent-status"], INVALIDATE_THROTTLE_MS);
// Replaces the per-component `refetchInterval` previously wired into
// SessionContext, ChatView's right-sidebar session card, the per-agent
// roster panel, and AgentRow. The frame carries `agentId` + `chatId`
// (see api/orgs/ws.ts:75 — `{ type, ...payload }`), so we invalidate the
// exact three keys the affected agent reads — `["session", agentId,
// chatId]`, `["chat-right-sidebar", "session", agentId, chatId]`,
// `["agent-sessions", agentId]` — rather than fanning out a prefix
// invalidate over every other agent in the chat. Throttling is per
// (agentId, chatId) pair so bursts from one agent don't starve another
// nor leak invalidations onto unrelated agents.
//
// `["chat-right-sidebar", "session", ...]` is targeted explicitly to keep
// the sibling `["chat-right-sidebar", "github-entities", chatId]` query
// (github-section.tsx) — a periodic GitHub-entity DB projection — out of
// the invalidation path on every `session:state` burst.
type SessionPairThrottleState = {
  lastAt: number;
  trailingTimer: ReturnType<typeof setTimeout> | null;
};
const sessionPairThrottle = new Map<string, SessionPairThrottleState>();

function fireSessionInvalidations(qc: QC, agentId: string, chatId: string): void {
  qc.invalidateQueries({ queryKey: ["session", agentId, chatId] });
  qc.invalidateQueries({ queryKey: ["chat-right-sidebar", "session", agentId, chatId] });
  qc.invalidateQueries({ queryKey: ["agent-sessions", agentId] });
}

function invalidateSessionPair(qc: QC, agentId: string, chatId: string): void {
  const throttleKey = `${agentId}:${chatId}`;
  const now = Date.now();
  const state = sessionPairThrottle.get(throttleKey) ?? { lastAt: 0, trailingTimer: null };
  const elapsed = now - state.lastAt;
  if (elapsed >= INVALIDATE_THROTTLE_MS) {
    state.lastAt = now;
    sessionPairThrottle.set(throttleKey, state);
    fireSessionInvalidations(qc, agentId, chatId);
    return;
  }
  if (state.trailingTimer === null) {
    state.trailingTimer = setTimeout(() => {
      const cur = sessionPairThrottle.get(throttleKey);
      if (cur) {
        cur.trailingTimer = null;
        cur.lastAt = Date.now();
      }
      if (latestQc) fireSessionInvalidations(latestQc, agentId, chatId);
    }, INVALIDATE_THROTTLE_MS - elapsed);
    sessionPairThrottle.set(throttleKey, state);
  }
}

function disposeSessionPairThrottle(): void {
  for (const state of sessionPairThrottle.values()) {
    if (state.trailingTimer) clearTimeout(state.trailingTimer);
  }
  sessionPairThrottle.clear();
}

// `session:event` frames stream once per tool_call / thinking /
// assistant_text / turn_end. ChatView mounts two reads off that stream — the
// per-(agent, chat) agent feed `["session-events", agentId, chatId]` and the
// per-chat aggregate `["chat-session-events", chatId]` — and every frame used
// to invalidate both: one invalidation per frame per mounted timeline while
// an agent ticks through a burst (each invalidation is a potential refetch;
// the query library may coalesce concurrent requests). Same window as
// everything above (INVALIDATE_THROTTLE_MS): a leading fire keeps the
// timeline feeling live, a trailing fire folds the burst into at most one
// extra refresh once it settles.
//
// The window is keyed per (agentId, chatId) pair for the agent feed and per
// chatId for the aggregate, so concurrent chats — and concurrent agents
// streaming into the same chat — never block one another (same per-pair
// reasoning as `sessionPairThrottle` above).
//
// Unlike the fixed invalidators, these keys arrive for arbitrary chats, so
// the maps self-clean instead of accumulating one entry per chat ever seen:
// every actual fire (leading or trailing) keeps `lastAt` for a full cooldown
// — so a frame landing right on a fire boundary schedules the next trailing
// refresh instead of re-firing a leading one — and an idle sweep drops the
// entry once the cooldown elapses with no pending trailing refresh.
type SessionEventThrottleEntry = {
  lastAt: number;
  trailingTimer: ReturnType<typeof setTimeout> | null;
  sweepTimer: ReturnType<typeof setTimeout> | null;
};

const chatSessionEventsThrottle = new Map<string, SessionEventThrottleEntry>();
const sessionEventPairThrottle = new Map<string, SessionEventThrottleEntry>();

function armSessionEventThrottleSweep(
  map: Map<string, SessionEventThrottleEntry>,
  key: string,
  entry: SessionEventThrottleEntry,
): void {
  if (entry.sweepTimer !== null) {
    clearTimeout(entry.sweepTimer);
  }
  entry.sweepTimer = setTimeout(() => {
    entry.sweepTimer = null;
    // Idle cleanup only: a pending trailing refresh still owns the entry, and
    // a re-armed entry (fresh `lastAt`) must not be deleted by a stale sweep
    // that fires late.
    if (map.get(key) !== entry || entry.trailingTimer !== null) return;
    if (Date.now() - entry.lastAt >= INVALIDATE_THROTTLE_MS) {
      map.delete(key);
    }
  }, INVALIDATE_THROTTLE_MS);
}

/**
 * Leading + trailing throttle for one keyed timeline invalidation. Fires
 * `fire` immediately on the first frame of a burst (or once the previous
 * cooldown fully elapsed), then at most once more via a trailing timer while
 * frames keep arriving inside the cooldown. `lastAt` is retained for a full
 * cooldown after every actual fire so frames at the fire boundary fold into
 * the next trailing refresh; entries are swept once idle, keeping the maps
 * bounded. Note a fire is a cache-invalidation request, not a promise that
 * exactly one HTTP/DB execution follows — query libraries coalesce.
 */
function scheduleSessionEventInvalidation(
  map: Map<string, SessionEventThrottleEntry>,
  key: string,
  fire: () => void,
): void {
  const now = Date.now();
  let entry = map.get(key);
  if (!entry) {
    // Fresh key (map self-cleans, so absence means idle). Seed `lastAt` a
    // full window back so the first-ever frame fires immediately even when
    // `Date.now()` is 0 under a fake clock.
    entry = { lastAt: now - INVALIDATE_THROTTLE_MS, trailingTimer: null, sweepTimer: null };
    map.set(key, entry);
  }
  if (entry.trailingTimer !== null) {
    // A trailing refresh for this key is already pending and will refetch at
    // the end of the cooldown — this frame is folded into it.
    return;
  }
  const elapsed = now - entry.lastAt;
  if (elapsed >= INVALIDATE_THROTTLE_MS) {
    // Leading edge of a fresh burst (or the previous cooldown elapsed):
    // refresh immediately and keep the entry for the full cooldown.
    entry.lastAt = now;
    armSessionEventThrottleSweep(map, key, entry);
    fire();
    return;
  }
  // Inside the cooldown with no trailing pending: guarantee exactly one
  // refresh once the burst settles. The entry (with the refreshed `lastAt`)
  // stays in place for the next cooldown.
  entry.trailingTimer = setTimeout(() => {
    entry.trailingTimer = null;
    if (map.get(key) !== entry) return;
    entry.lastAt = Date.now();
    armSessionEventThrottleSweep(map, key, entry);
    fire();
  }, INVALIDATE_THROTTLE_MS - elapsed);
}

function invalidateChatSessionEvents(chatId: string): void {
  scheduleSessionEventInvalidation(chatSessionEventsThrottle, chatId, () => {
    if (latestQc) latestQc.invalidateQueries({ queryKey: ["chat-session-events", chatId] });
  });
}

function invalidateSessionEventPair(agentId: string, chatId: string): void {
  scheduleSessionEventInvalidation(sessionEventPairThrottle, `${agentId}:${chatId}`, () => {
    if (latestQc) latestQc.invalidateQueries({ queryKey: ["session-events", agentId, chatId] });
  });
}

function disposeSessionEventThrottles(): void {
  for (const map of [chatSessionEventsThrottle, sessionEventPairThrottle]) {
    for (const entry of map.values()) {
      if (entry.trailingTimer) clearTimeout(entry.trailingTimer);
      if (entry.sweepTimer) clearTimeout(entry.sweepTimer);
    }
    map.clear();
  }
}

/**
 * Apply a session frame's per-agent status delta. When the server attached the
 * recomputed `status` (only for sockets whose viewer can access the chat),
 * upsert it into `["chat-agent-status", chatId]` so compose / panel update
 * without a refetch. Otherwise fall back to the throttled prefix invalidation.
 * The 30s `refetchInterval` on those queries remains the safety floor either way.
 */
function patchOrInvalidateAgentStatus(qc: QC, msg: WsMessage): void {
  const chatId = typeof msg.chatId === "string" ? msg.chatId : null;
  const parsed = agentChatStatusSchema.safeParse(msg.status);
  if (chatId && parsed.success) {
    qc.setQueryData<AgentChatStatus[]>(chatAgentStatusQueryKey(chatId), (prev) =>
      // No cached query (panel/compose not mounted) → nothing to patch; the
      // next mount/refetch populates it fresh.
      prev ? upsertAgentStatus(prev, parsed.data) : prev,
    );
    return;
  }
  chatAgentStatusInvalidator.invalidate(qc);
}

function broadcast(msg: WsMessage) {
  for (const sub of subscribers) {
    try {
      sub(msg);
    } catch {
      // swallow subscriber errors to avoid poisoning siblings
    }
  }
  if (latestQc) {
    if (msg.type === "session:state") {
      activityInvalidator.invalidate(latestQc);
      sessionsInvalidator.invalidate(latestQc);
      // A `session:state` change mutates the per-(agent,chat) session
      // lifecycle, which feeds the conversation-list status projections
      // (live-dot / failed). Invalidate the list so they refresh in real time
      // without waiting for the refetchInterval. Throttled because the upstream
      // frames can burst tool-call-fast.
      meChatsInvalidator.invalidate(latestQc);
      patchOrInvalidateAgentStatus(latestQc, msg);
      // Precise invalidate for the (agent, chat) the frame is about, so a
      // burst for one agent doesn't fan out onto every sibling agent's
      // sessionQuery in the same chat. See `invalidateSessionPair` for the
      // per-pair throttle. Falls back to a no-op if either id is missing
      // (defensive — the wider `activity` / `sessions` keys already covered
      // above will still refresh broad UI state).
      const agentId = typeof msg.agentId === "string" ? msg.agentId : null;
      const chatId = typeof msg.chatId === "string" ? msg.chatId : null;
      if (agentId && chatId) {
        invalidateSessionPair(latestQc, agentId, chatId);
      }
      // Terminal cleanup: an `evicted` projection means the session's live
      // trace was deleted server-side (Reset finalize / terminate). The
      // `chat-session-events` query has no polling floor and the plain
      // `session:state` branch does not touch it, so without this every
      // other open viewer of the chat keeps the stale trace indefinitely.
      if (chatId && msg.state === "evicted") {
        latestQc.invalidateQueries({ queryKey: ["chat-session-events", chatId] });
        if (agentId) {
          latestQc.invalidateQueries({ queryKey: ["session-events", agentId, chatId] });
        }
      }
    } else if (msg.type === "session:runtime") {
      // The per-(agent,chat) D-axis authority flipped. Same delivery
      // contract as `session:state` — when audience-included, the frame
      // carries the recomputed status to patch in place; otherwise we
      // fall back to invalidate. ALSO kick `me/chats` so the chat-list
      // `busyAgentIds` projection refreshes without waiting for the 30s
      // poll. NOT invalidating `session-events`: a runtime flip does not
      // mutate the timeline.
      meChatsInvalidator.invalidate(latestQc);
      patchOrInvalidateAgentStatus(latestQc, msg);
    } else if (msg.type === "session:event") {
      // `MeChatRow.liveActivity` is derived from the most recent
      // `session_events` row for each chat. The same wire frame produced
      // by tool_call / thinking / assistant_text / turn_end fans out
      // through this socket; invalidate the conversation-list so the
      // WorkingChip in the time slot updates within the throttle window.
      // Re-uses the same leading + trailing throttle helper as
      // `session:state` (window defined by `INVALIDATE_THROTTLE_MS`).
      meChatsInvalidator.invalidate(latestQc);
      patchOrInvalidateAgentStatus(latestQc, msg);
      // Frame carries `chatId` (api/orgs/ws.ts:82 spreads the notifier
      // payload), so target the two timeline reads ChatView mounts — the
      // per-(agent, chat) agent feed and the per-chat aggregate. Both ride
      // the leading + trailing per-key throttle above: a tool-call burst
      // otherwise fires one invalidation per frame per timeline (each a
      // potential refetch, not a guaranteed SQL execution).
      const agentId = typeof msg.agentId === "string" ? msg.agentId : null;
      const chatId = typeof msg.chatId === "string" ? msg.chatId : null;
      if (chatId) {
        invalidateChatSessionEvents(chatId);
        if (agentId) {
          invalidateSessionEventPair(agentId, chatId);
        }
      }
    } else if (msg.type === "chat:message") {
      // Best-effort realtime nudge for the chat-first workspace. The frame
      // carries `{ type, chatId }` (see shared/me-chat.ts:chatMessageFrameSchema);
      // we invalidate the chat list (throttled — bulk arrivals like a
      // backfill or a chatty agent don't need one HTTP per frame), the
      // chat's message timeline, and the chat's detail panel. Failures
      // are swallowed — the parent broadcast wraps each subscriber in
      // try/catch and the user-facing fallback is the 5s polling refetch
      // already wired into ChatView.
      const chatId = typeof msg.chatId === "string" ? msg.chatId : null;
      meChatsInvalidator.invalidate(latestQc);
      // A request may have opened/resolved, or this may be a matching Ask agent
      // `chat send --reply-to`. Refresh the global request queue and the durable
      // request-thread projection without waiting for their polling floors.
      needYouInvalidator.invalidate(latestQc);
      if (chatId) {
        latestQc.invalidateQueries({ queryKey: ["chat-messages", chatId] });
        latestQc.invalidateQueries({ queryKey: ["chat-detail", chatId] });
        // The blocking answer UI reads open requests window-independently;
        // refresh them on the same kick so a new (or just-resolved) ask flips
        // the takeover without waiting for its own 5s poll.
        latestQc.invalidateQueries({ queryKey: ["chat-open-requests", chatId] });
        latestQc.invalidateQueries({ queryKey: ["request-thread", chatId] });
        // The new message may be an accepted cron trigger (or its result),
        // which flips the schedule's outstanding state. The WS frame carries
        // no metadata, so conservatively refresh the chat's schedule list.
        latestQc.invalidateQueries({ queryKey: ["chat-right-sidebar", "cron-jobs", chatId] });
      }
    } else if (msg.type === "chat:updated") {
      // A chat's metadata changed (e.g. an agent ran `chat update --description`).
      // Refresh the open chat's detail — the pinned summary reads description
      // + freshness off `["chat-detail", chatId]` — and the conversation list,
      // whose row renders the description. No message arrived, so the message
      // timeline is deliberately NOT invalidated.
      const chatId = typeof msg.chatId === "string" ? msg.chatId : null;
      meChatsInvalidator.invalidate(latestQc);
      if (chatId) {
        latestQc.invalidateQueries({ queryKey: ["chat-detail", chatId] });
        // Cron CRUD (create/update/pause/resume/delete, by the agent or the
        // owner) reuses this same notifier, so the sidebar schedule list
        // rides the same frame.
        latestQc.invalidateQueries({ queryKey: ["chat-right-sidebar", "cron-jobs", chatId] });
      }
    } else if (msg.type === "me-chats:changed") {
      // The viewer's OWN private me-chats projection changed on another device
      // (pin or engagement). The server sends this frame only to this user's own
      // sockets, so refresh both private projections across their devices.
      // Engagement controls whether a chat belongs to the Active-scoped Need
      // you queue. Pin reuses the same bare event; its extra queue refetch is
      // intentionally harmless.
      meChatsInvalidator.invalidate(latestQc);
      needYouInvalidator.invalidate(latestQc);
    } else if (msg.type === "pulse:tick") {
      // Per-org runtime-state aggregate (pulse-aggregator broadcasts every 5s).
      // The composite `offline` (client_id → null) and runtime-`error` → failed
      // inputs to `chat-agent-status` move ONLY via runtime state, with no
      // session:state / session:event / chat:message frame — so without this
      // branch a silent disconnect or runtime error would wait out the 30s
      // refetchInterval before the sidebar/header point flips. Same throttled
      // prefix invalidator; the server already 5s-throttles + org-scopes pulse.
      chatAgentStatusInvalidator.invalidate(latestQc);
    }
  }
}

function catchUpAfterReconnect(): void {
  // Catch up only after the server has admitted this socket against live
  // account + membership authority. Transport `open` happens before that
  // asynchronous check and therefore cannot reset backoff or refresh caches.
  if (latestQc) {
    latestQc.invalidateQueries({ queryKey: ["activity"] });
    latestQc.invalidateQueries({ queryKey: ["sessions"] });
    latestQc.invalidateQueries({ queryKey: ["me", "chats"] });
    latestQc.invalidateQueries({ queryKey: ["chat-agent-status"] });
    latestQc.invalidateQueries({ queryKey: ["session"] });
    latestQc.invalidateQueries({ queryKey: ["chat-right-sidebar", "session"] });
    latestQc.invalidateQueries({ queryKey: ["chat-right-sidebar", "cron-jobs"] });
    latestQc.invalidateQueries({ queryKey: ["session-events"] });
    latestQc.invalidateQueries({ queryKey: ["chat-session-events"] });
    latestQc.invalidateQueries({ queryKey: ["agent-sessions"] });
    latestQc.invalidateQueries({ queryKey: ["chat-messages"] });
    latestQc.invalidateQueries({ queryKey: ["chat-open-requests"] });
    latestQc.invalidateQueries({ queryKey: ["need-you"] });
    latestQc.invalidateQueries({ queryKey: ["request-thread"] });
    latestQc.invalidateQueries({ queryKey: ["chat-detail"] });
  }
  // Synthetic sentinel for subscriber side effects (for example markRead).
  broadcast({ type: "ws:reconnect" });
}

function connect() {
  const tokens = getStoredTokens();
  if (!tokens?.accessToken) return;

  // Resolve the selected org from the API client's live value (kept in sync by
  // the AuthProvider). The org-scoped admin WS path is
  // `/api/v1/orgs/:orgId/ws/`. Reading localStorage directly is wrong now that
  // the persisted key is per-user; the API-client value is the single source of
  // truth. If no org is selected yet, skip connecting — the hook reconnects once
  // the auth context populates the selection.
  const orgId = getApiSelectedOrganizationId();
  if (!orgId) return;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/api/v1/orgs/${encodeURIComponent(orgId)}/ws/?token=${tokens.accessToken}`;
  const socket = new WebSocket(wsUrl);
  let membershipChangeSignaled = false;
  let admissionConfirmed = false;
  let admissionTimer: ReturnType<typeof setTimeout> | null = null;
  const clearAdmissionTimer = (): void => {
    if (admissionTimer) {
      clearTimeout(admissionTimer);
      admissionTimer = null;
    }
    if (cancelCurrentAdmissionTimer === clearAdmissionTimer) cancelCurrentAdmissionTimer = null;
  };
  ws = socket;
  cancelCurrentAdmissionTimer = clearAdmissionTimer;

  socket.onopen = () => {
    admissionTimer = setTimeout(() => {
      admissionTimer = null;
      if (cancelCurrentAdmissionTimer === clearAdmissionTimer) cancelCurrentAdmissionTimer = null;
      if (socket === ws && !admissionConfirmed) socket.close(ADMISSION_TIMEOUT_CLOSE_CODE, "admission timeout");
    }, ADMISSION_TIMEOUT_MS);
  };
  socket.onmessage = (ev) => {
    if (socket !== ws) return;
    try {
      const msg = JSON.parse(ev.data as string) as WsMessage;
      if (msg.type === "admin:connected" && !admissionConfirmed) {
        admissionConfirmed = true;
        clearAdmissionTimer();
        const isReconnect = reconnectAttempt > 0;
        reconnectAttempt = 0;
        if (isReconnect) catchUpAfterReconnect();
      }
      if (msg.type === "membership:changed") {
        membershipChangeSignaled = true;
        window.dispatchEvent(new CustomEvent(ADMIN_WS_MEMBERSHIP_CHANGED_EVENT, { detail: msg }));
      }
      broadcast(msg);
    } catch {
      // ignore malformed
    }
  };
  socket.onclose = (ev) => {
    clearAdmissionTimer();
    // Only the current (latest) socket's close triggers reconnect.
    // An aborted CONNECTING socket from strict-mode unmount will also close here
    // but must not touch module state.
    if (socket !== ws) return;
    ws = null;
    if (closing || refCount === 0) return;
    if (ev.code === 4403) {
      // Membership revocation is a terminal condition for this Team socket.
      // AuthProvider reconciles /me and selects a remaining/repaired Team or
      // enters the invitation boundary; reconnecting this org would loop.
      if (!membershipChangeSignaled) {
        window.dispatchEvent(
          new CustomEvent(ADMIN_WS_MEMBERSHIP_CHANGED_EVENT, {
            detail: { type: "membership:changed", organizationId: orgId },
          }),
        );
      }
      return;
    }
    // 4001 = server-side auth rejection (see ws-admin.ts close paths). The
    // most common cause is an expired access token: the WS hook reads from
    // `localStorage` but never round-trips through the HTTP refresh
    // interceptor, so without this branch a stale token would loop forever
    // (~3s cadence: handshake → 4001 → 2s backoff → repeat). Drive a refresh
    // and reconnect immediately on success.
    if (ev.code === 4001) {
      refreshAccessToken().then((fresh) => {
        if (closing || refCount === 0) return;
        if (fresh) {
          // A refreshed token makes another handshake possible, but it does
          // not prove live membership admission. Preserve any outstanding
          // retry attempt so only `admin:connected` resets backoff and emits
          // the catch-up sentinel for a real push gap. On an initial 4001 the
          // counter is already zero, so refresh remains a non-reconnect.
          connect();
        } else {
          // Refresh failed — fall through to standard backoff. The HTTP path
          // will eventually surface a 401 on the next API call, dispatch
          // `auth:logout`, and tear us down via refCount=0.
          scheduleReconnect();
        }
      });
      return;
    }
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  reconnectAttempt++;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** (reconnectAttempt - 1), RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!closing && refCount > 0) connect();
  }, delay);
}

function teardown() {
  closing = true;
  window.removeEventListener(ADMIN_WS_ORG_CHANGED_EVENT, reconnectForOrgChange);
  cancelCurrentAdmissionTimer?.();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  // A later first subscriber starts a fresh connection lifecycle. Do not let
  // pre-admission failures from an unmounted workspace turn that initial
  // admission into a synthetic reconnect catch-up.
  reconnectAttempt = 0;
  meChatsInvalidator.dispose();
  needYouInvalidator.dispose();
  activityInvalidator.dispose();
  sessionsInvalidator.dispose();
  chatAgentStatusInvalidator.dispose();
  disposeSessionPairThrottle();
  disposeSessionEventThrottles();
  if (ws) {
    ws.close(1000, "unmount");
    ws = null;
  }
}

/**
 * Rebuild the shared connection against the now-current selected org. Fires on
 * `ADMIN_WS_ORG_CHANGED_EVENT` (a user-driven `selectOrganization`): `connect()`
 * reads the org from `getApiSelectedOrganizationId()` at call time, so closing
 * the stale socket and reconnecting is enough to move to the new org's
 * `/orgs/:orgId/ws/`. No-op when no consumer is mounted — the next mount
 * connects fresh against the new org.
 */
function reconnectForOrgChange(): void {
  if (refCount === 0) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempt = 0;
  cancelCurrentAdmissionTimer?.();
  // A user-driven org switch clears the React-Query cache (auth-context
  // selectOrganization) and swaps this socket to the new org. Drop in-flight
  // session-event throttle state so a pending trailing timer from the
  // previous org cannot fire against the new org's cache.
  disposeSessionEventThrottles();
  const previous = ws;
  // Detach before closing so the stale socket's onclose (`socket !== ws`)
  // no-ops instead of scheduling a backoff reconnect to the previous org.
  ws = null;
  closing = false;
  if (previous) previous.close(1000, "org-switch");
  connect();
}

/**
 * Admin WebSocket hook — maintains a single shared connection to /api/v1/ws/admin.
 *
 * Multiple consumers may subscribe simultaneously; each gets every message.
 * The connection opens on the first subscriber and closes when the last unmounts.
 */
export function useAdminWs(options?: UseAdminWsOptions) {
  const { onMessage, enabled = true } = options ?? {};
  const queryClient = useQueryClient();
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  useEffect(() => {
    latestQc = queryClient;
  }, [queryClient]);

  useEffect(() => {
    if (!enabled) return;

    const subscriber: Subscriber = (msg) => onMessageRef.current?.(msg);
    subscribers.add(subscriber);
    refCount++;

    if (refCount === 1) {
      closing = false;
      connect();
      window.addEventListener(ADMIN_WS_ORG_CHANGED_EVENT, reconnectForOrgChange);
    }

    return () => {
      subscribers.delete(subscriber);
      refCount--;
      if (refCount === 0) teardown();
    };
  }, [enabled]);
}
