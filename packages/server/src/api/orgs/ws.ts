import { AGENT_STATUSES, AGENT_VISIBILITY, type AgentChatStatus } from "@first-tree/shared";
import { and, eq, inArray, ne, or } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { jwtVerify } from "jose";
import type { WebSocket } from "ws";
import type { Database } from "../../db/connection.js";
import { agents } from "../../db/schema/agents.js";
import { members } from "../../db/schema/members.js";
import { users } from "../../db/schema/users.js";
import {
  createLogger,
  endWsConnectionSpan,
  setWsConnectionAttrs,
  startWsConnectionSpan,
} from "../../observability/index.js";
import { registerAdminBroadcaster } from "../../services/admin-broadcast.js";
import { getCachedAudience } from "../../services/chat/membership/audience-cache.js";
import { getChatAgentStatus } from "../../services/chat/sessions/status.js";
import type { Notifier } from "../../services/notifier.js";

const log = createLogger("OrgWs");

/**
 * Class B — `/api/v1/orgs/:orgId/ws`. Real-time admin push channel.
 * Org is taken from the path; JWT only needs `sub`. Membership in the
 * target org is probed in real time on every handshake — a revoked
 * membership refuses immediately.
 */

type SocketMeta = {
  organizationId: string;
  memberId: string;
  humanAgentId: string;
  visibleAgentIds: Set<string>;
  admitted: boolean;
};

async function loadVisibleAgentIds(db: Database, organizationId: string, memberId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: agents.uuid })
    .from(agents)
    .where(
      and(
        eq(agents.organizationId, organizationId),
        ne(agents.status, AGENT_STATUSES.DELETED),
        or(eq(agents.visibility, AGENT_VISIBILITY.ORGANIZATION), eq(agents.managerId, memberId)),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

function filterPulseAgents(agentsMap: Record<string, unknown>, visible: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [agentId, buckets] of Object.entries(agentsMap)) {
    if (visible.has(agentId)) out[agentId] = buckets;
  }
  return out;
}

export function orgWsRoutes(notifier: Notifier, jwtSecret: string): (app: FastifyInstance) => Promise<void> {
  const adminSockets = new Map<WebSocket, SocketMeta>();
  const secret = new TextEncoder().encode(jwtSecret);

  function evictMembershipSocket(ws: WebSocket, meta: SocketMeta): void {
    if (!adminSockets.has(ws)) return;
    adminSockets.delete(ws);
    if (ws.readyState === 1) {
      try {
        ws.send(
          JSON.stringify({
            type: "membership:changed",
            memberId: meta.memberId,
            organizationId: meta.organizationId,
          }),
        );
      } catch {
        // The close below remains the authoritative client signal.
      }
    }
    ws.close(4403, "Membership changed");
  }

  /**
   * Local, in-memory pre-gate for session-frame enrichment: is there any
   * currently open + admitted socket in `organizationId` whose human agent
   * is in `audience`? No DB revalidation here (cheap by design) — the
   * delivery loop's `liveSocketEntries` stays the DB-backed authority.
   */
  function hasAudienceSocket(organizationId: string, audience: ReadonlySet<string>): boolean {
    for (const [ws, meta] of adminSockets) {
      if (
        ws.readyState === 1 &&
        meta.admitted &&
        meta.organizationId === organizationId &&
        audience.has(meta.humanAgentId)
      ) {
        return true;
      }
    }
    return false;
  }

  function closeAuthorizationUnavailable(ws: WebSocket): void {
    adminSockets.delete(ws);
    try {
      ws.close(1013, "Authorization unavailable");
    } catch {
      // Socket transport errors are terminal for this connection.
    }
  }

  async function loadLiveMembershipAuthorization(
    db: Database,
    userId: string,
    organizationId: string,
    memberId?: string,
  ): Promise<{ id: string; role: string; agentId: string } | null> {
    const [row] = await db
      .select({ id: members.id, role: members.role, agentId: members.agentId })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(
        and(
          eq(members.userId, userId),
          eq(members.organizationId, organizationId),
          eq(members.status, "active"),
          eq(users.status, "active"),
          ...(memberId ? [eq(members.id, memberId)] : []),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async function liveSocketEntries(
    predicate: (meta: SocketMeta) => boolean = () => true,
  ): Promise<Array<[WebSocket, SocketMeta]>> {
    const candidates = [...adminSockets].filter(
      ([ws, meta]) => ws.readyState === 1 && meta.admitted && predicate(meta),
    );
    if (candidates.length === 0) return [];
    try {
      const rows = await getDbForChatLookup()
        .select({ id: members.id, organizationId: members.organizationId })
        .from(members)
        .innerJoin(users, eq(users.id, members.userId))
        .where(
          and(
            inArray(
              members.id,
              candidates.map(([, meta]) => meta.memberId),
            ),
            eq(members.status, "active"),
            eq(users.status, "active"),
          ),
        );
      const liveKeys = new Set(rows.map((row) => `${row.id}:${row.organizationId}`));
      const live: Array<[WebSocket, SocketMeta]> = [];
      for (const [ws, meta] of candidates) {
        if (liveKeys.has(`${meta.memberId}:${meta.organizationId}`)) live.push([ws, meta]);
        else evictMembershipSocket(ws, meta);
      }
      return live;
    } catch (err) {
      // Fail closed for the data plane. Closing with a retryable code makes
      // clients reconnect, re-authorize, and run their catch-up invalidation;
      // cached handshake state never substitutes for the failed live check.
      log.warn({ err }, "admin WS live membership revalidation failed");
      for (const [ws] of candidates) closeAuthorizationUnavailable(ws);
      return [];
    }
  }

  async function broadcastOrgScoped(payload: Record<string, unknown>): Promise<void> {
    const orgId = payload.organizationId;
    if (typeof orgId !== "string" || orgId.length === 0) return;

    const isPulseTick = payload.type === "pulse:tick" && typeof payload.agents === "object" && payload.agents !== null;
    const sharedData = isPulseTick ? null : JSON.stringify(payload);

    for (const [ws, meta] of await liveSocketEntries((candidate) => candidate.organizationId === orgId)) {
      if (isPulseTick) {
        const filtered = filterPulseAgents(payload.agents as Record<string, unknown>, meta.visibleAgentIds);
        ws.send(JSON.stringify({ ...payload, agents: filtered }));
      } else {
        ws.send(sharedData as string);
      }
    }
  }

  registerAdminBroadcaster(broadcastOrgScoped);

  notifier.onSessionStateChange((payload) => {
    void dispatchSessionFrame("session:state", payload);
  });

  notifier.onSessionEvent((payload) => {
    void dispatchSessionFrame("session:event", payload);
  });

  notifier.onSessionRuntime((payload) => {
    // Same shape as session:state — a per-(agent,chat) flip whose composite
    // status the audience patches in place. Audience filter is the same
    // (status carries narration via the freshly-recomputed activity).
    void dispatchSessionFrame("session:runtime", payload);
  });

  notifier.onChatMessage(({ chatId }) => {
    void dispatchChatMessage(chatId);
  });

  notifier.onChatUpdated(({ chatId }) => {
    void dispatchChatUpdated(chatId);
  });

  notifier.onMeChatsChanged(({ humanAgentId, organizationId }) => {
    void dispatchMeChatsChanged(humanAgentId, organizationId);
  });

  notifier.onMembershipChanged(({ memberId, organizationId }) => {
    for (const [ws, meta] of adminSockets) {
      if (meta.memberId === memberId && meta.organizationId === organizationId) evictMembershipSocket(ws, meta);
    }
  });

  /**
   * Deliver a session:state / session:event / session:runtime frame. The
   * recomputed agent status carries the agent's narration (activity.detail
   * / turnText), so it is attached ONLY for sockets whose viewer can access
   * the chat — NEVER sent org-wide. Audience members get the enriched frame
   * and patch `["chat-agent-status", chatId]` in place; every other org
   * socket gets the bare routing frame (invalidate-only). Computed once per
   * NOTIFY, only while admin sockets are connected.
   *
   * `session:runtime` rides on the same path as `session:state` because
   * they are semantically siblings — both signal "a per-(agent,chat)
   * composite axis flipped", just on different axes (lifecycle vs D-axis
   * runtime). Sharing the path keeps the web cache reconciliation
   * deterministic (one in-place patch, no invalidate races).
   *
   * The enrichment is resolved for the frame's OWN agent only
   * (`getChatAgentStatus`), never for the whole chat — and only when at
   * least one currently connected + admitted socket in this org belongs to
   * the chat audience. The latter is a performance gate, not authorization:
   * the DB-backed liveSocketEntries revalidation and the per-socket
   * audience filter below remain the delivery authority.
   */
  async function dispatchSessionFrame(
    type: "session:state" | "session:event" | "session:runtime",
    payload: { agentId: string; chatId: string; organizationId: string } & Record<string, unknown>,
  ): Promise<void> {
    if (adminSockets.size === 0) return;
    let status: AgentChatStatus | undefined;
    let audience: ReadonlySet<string> | null = null;
    try {
      const db = getDbForChatLookup();
      audience = await getCachedAudience(db, payload.chatId);
      // Performance gate (not authorization): when no currently ready +
      // admitted socket in the event's org has a human agent in the cached
      // audience, no enriched frame can be delivered — skip the whole status
      // computation (bare frames below still reach every live org socket).
      if (audience && audience.size > 0 && hasAudienceSocket(payload.organizationId, audience)) {
        status = await getChatAgentStatus(db, payload.chatId, payload.agentId);
      }
    } catch (err) {
      // Best-effort enrichment: on any failure fall back to the bare frame
      // everywhere (the client's invalidate path + refetch floor still cover it).
      // Logged (not silent) so a sustained DB hiccup that degrades the realtime
      // delta to refetch-latency is visible rather than invisible.
      log.warn({ err, chatId: payload.chatId, agentId: payload.agentId }, "session-frame status enrichment failed");
      status = undefined;
    }
    const bareFrame = JSON.stringify({ type, ...payload });
    const enrichedFrame = status ? JSON.stringify({ type, ...payload, status }) : bareFrame;
    for (const [ws, meta] of await liveSocketEntries(
      (candidate) => candidate.organizationId === payload.organizationId,
    )) {
      const frame = status && audience?.has(meta.humanAgentId) ? enrichedFrame : bareFrame;
      try {
        ws.send(frame);
      } catch {
        // socket-level errors surface via close handler
      }
    }
  }

  async function dispatchChatMessage(chatId: string): Promise<void> {
    if (adminSockets.size === 0) return;
    const audience = await getCachedAudience(getDbForChatLookup(), chatId);
    if (!audience || audience.size === 0) return;
    const frame = JSON.stringify({ type: "chat:message", chatId });
    for (const [ws, meta] of await liveSocketEntries()) {
      if (!audience.has(meta.humanAgentId)) continue;
      try {
        ws.send(frame);
      } catch {
        // socket-level errors surface via close handler
      }
    }
  }

  // Metadata-change sibling of dispatchChatMessage: same chat-audience gate, but
  // emits a `chat:updated` frame (no messageId) so clients refresh chat-detail +
  // the conversation list without touching the message timeline.
  async function dispatchChatUpdated(chatId: string): Promise<void> {
    if (adminSockets.size === 0) return;
    const audience = await getCachedAudience(getDbForChatLookup(), chatId);
    if (!audience || audience.size === 0) return;
    const frame = JSON.stringify({ type: "chat:updated", chatId });
    for (const [ws, meta] of await liveSocketEntries()) {
      if (!audience.has(meta.humanAgentId)) continue;
      try {
        ws.send(frame);
      } catch {
        // socket-level errors surface via close handler
      }
    }
  }

  // Per-USER sibling of dispatchChatUpdated: a private me-chats change (pin or
  // engagement) fans a bare `me-chats:changed` invalidation to ONLY the acting
  // user's own sockets in that org. Deliberately NO chat-audience lookup — pin
  // state is private and must never reach another member's devices, so the gate
  // is identity (`humanAgentId`) + org, not chat membership. One user with two
  // devices in the org sees both rails regroup; nobody else is touched.
  // Delivery still revalidates the socket's live membership before sending.
  async function dispatchMeChatsChanged(humanAgentId: string, organizationId: string): Promise<void> {
    if (adminSockets.size === 0) return;
    const frame = JSON.stringify({ type: "me-chats:changed" });
    for (const [ws] of await liveSocketEntries(
      (candidate) => candidate.humanAgentId === humanAgentId && candidate.organizationId === organizationId,
    )) {
      try {
        ws.send(frame);
      } catch {
        // socket-level errors surface via close handler
      }
    }
  }

  let cachedDbForChatLookup: Database | null = null;
  function getDbForChatLookup(): Database {
    if (!cachedDbForChatLookup) throw new Error("admin WS: db not initialised yet");
    return cachedDbForChatLookup;
  }
  function rememberDb(db: Database): void {
    if (!cachedDbForChatLookup) cachedDbForChatLookup = db;
  }

  return async (app: FastifyInstance): Promise<void> => {
    app.get<{ Params: { orgId: string } }>(
      "/",
      {
        websocket: true,
        config: {
          rateLimit: {
            max: 60,
            timeWindow: "1 minute",
            keyGenerator: async (request: FastifyRequest): Promise<string> => {
              const token = (request.query as Record<string, string | undefined>).token;
              if (token) {
                try {
                  const { payload } = await jwtVerify(token, secret);
                  if (payload.type === "access" && typeof payload.sub === "string") return `user:${payload.sub}`;
                } catch {
                  // Invalid and expired credentials remain in the unauthenticated
                  // client-IP bucket so hostile handshakes are still capped.
                }
              }
              return `ip:${request.ip}`;
            },
          },
        },
      },
      async (socket, request) => {
        const ua = request.headers["user-agent"];
        startWsConnectionSpan(socket, {
          remoteIp: request.ip,
          userAgent: typeof ua === "string" ? ua.slice(0, 200) : undefined,
        });

        const orgIdFromPath = (request.params as { orgId?: string }).orgId;
        const token = (request.query as Record<string, string>).token;
        if (!token || !orgIdFromPath) {
          socket.send(JSON.stringify({ type: "error", message: "Missing token or org" }));
          socket.close(4001, "Missing token");
          endWsConnectionSpan(socket, 4001);
          return;
        }

        let userId: string;
        try {
          const { payload } = await jwtVerify(token, secret);
          if (payload.type !== "access" || typeof payload.sub !== "string") {
            socket.send(JSON.stringify({ type: "error", message: "Invalid token type" }));
            socket.close(4001, "Invalid token");
            endWsConnectionSpan(socket, 4001);
            return;
          }
          userId = payload.sub;
        } catch {
          socket.send(JSON.stringify({ type: "error", message: "Invalid or expired token" }));
          socket.close(4001, "Auth failed");
          endWsConnectionSpan(socket, 4001);
          return;
        }

        const organizationId = orgIdFromPath;
        let memberRow: Awaited<ReturnType<typeof loadLiveMembershipAuthorization>>;
        try {
          memberRow = await loadLiveMembershipAuthorization(app.db, userId, organizationId);
        } catch (err) {
          log.warn({ err, organizationId, userId }, "admin WS handshake authorization failed");
          closeAuthorizationUnavailable(socket);
          endWsConnectionSpan(socket, 1013);
          return;
        }
        if (!memberRow) {
          socket.send(JSON.stringify({ type: "error", message: "Not an active member of this organization" }));
          socket.close(4403, "Not a member");
          endWsConnectionSpan(socket, 4403);
          return;
        }
        const memberId = memberRow.id;

        setWsConnectionAttrs(socket, { organizationId, memberId });
        rememberDb(app.db);
        const provisionalMeta: SocketMeta = {
          organizationId,
          memberId,
          humanAgentId: memberRow.agentId,
          visibleAgentIds: new Set(),
          admitted: false,
        };
        adminSockets.set(socket, provisionalMeta);
        socket.on("close", (code) => {
          adminSockets.delete(socket);
          endWsConnectionSpan(socket, code);
        });

        let visibleAgentIds: Set<string>;
        let humanAgentId: string;
        let finalAuthorization: Awaited<ReturnType<typeof loadLiveMembershipAuthorization>>;
        try {
          visibleAgentIds = await loadVisibleAgentIds(app.db, organizationId, memberId);
          const [humanAgentRow] = await app.db
            .select({ uuid: agents.uuid })
            .from(agents)
            .where(eq(agents.uuid, memberRow.agentId))
            .limit(1);
          humanAgentId = humanAgentRow?.uuid ?? memberRow.agentId;
          finalAuthorization = await loadLiveMembershipAuthorization(app.db, userId, organizationId, memberId);
        } catch (err) {
          log.warn({ err, organizationId, userId }, "admin WS handshake preparation failed");
          closeAuthorizationUnavailable(socket);
          return;
        }

        // The membership-change notifier can evict this provisional socket while
        // preparation awaits. Never resurrect it after that causal fence.
        if (adminSockets.get(socket) !== provisionalMeta) return;
        if (!finalAuthorization) {
          evictMembershipSocket(socket, provisionalMeta);
          return;
        }
        provisionalMeta.humanAgentId = humanAgentId;
        provisionalMeta.visibleAgentIds = visibleAgentIds;
        provisionalMeta.admitted = true;
        socket.send(JSON.stringify({ type: "admin:connected" }));
      },
    );
  };
}
