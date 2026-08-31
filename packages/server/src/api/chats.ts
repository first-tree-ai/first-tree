import {
  addMeChatParticipantsSchema,
  askAgentQuestionSchema,
  CHAT_ENGAGEMENT_STATUSES,
  type ChatEngagementStatus,
  followGithubEntityRequestSchema,
  followGitlabEntitySchema,
  paginationQuerySchema,
  parseLandingCampaignTrialChatMetadata,
  patchChatEngagementSchema,
  pinMeChatSchema,
  sendMessageSchema,
  updateChatSchema,
} from "@first-tree/shared";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chatUserState } from "../db/schema/chat-user-state.js";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { members } from "../db/schema/members.js";
import { messages } from "../db/schema/messages.js";
import { users } from "../db/schema/users.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors.js";
import { createTimingCollector } from "../observability/timing.js";
import { assertAllAgentsVisibleInOrg, requireChatAccess } from "../scope/require-resource.js";
import { resolveAvatarImageUrl } from "../services/agents/identity.js";
import { resolveCanonicalTeamSkillInvocation } from "../services/agents/resources/catalog.js";
import { ensureParticipant, leaveChat, removeParticipant, updateChatMetadata } from "../services/chat/conversation.js";
import {
  encodeMessageHistoryCursor,
  listOpenRequestsForViewer,
  messageHistoryOrderBy,
  messageHistoryWhere,
  sendMessage,
} from "../services/chat/message.js";
import { WIRE_RECIPIENT_MODE } from "../services/chat/message-dispatcher.js";
import { extractChatSummary, resolveChatTitle } from "../services/chat/read-model.js";
import { listChatSpeakerEvents, summarizeChatTokenUsage } from "../services/chat/sessions/events.js";
import { getChatAgentStatuses } from "../services/chat/sessions/status.js";
import {
  addMeChatParticipants,
  joinMeChat,
  leaveMeChat,
  markMeChatRead,
  markMeChatUnread,
  pinMeChat,
  setChatEngagement,
} from "../services/chat/workspace/me-chat.js";
import { listRequestThread } from "../services/chat/workspace/need-you.js";
import { isFeishuBridgedChat } from "../services/integrations/feishu/chat-binding.js";
import {
  hasRemainingLandingCampaignTrialBudget,
  normalizeLandingCampaignTrialChatMetadataForRead,
} from "../services/landing-campaigns/chat-state.js";
import { assertNoLandingCampaignTrialAgents } from "../services/landing-campaigns/guards.js";
import { notifyRecipients } from "../services/notifier.js";
import {
  declareEntityFollow,
  listChatGithubEntities,
  removeEntityFollow,
} from "../services/scm/github/entity-follow.js";
import {
  declareGitlabEntityFollowWithStatus,
  listChatGitlabEntities,
  listVisibleChatGitlabEntities,
  projectChatGitlabEntity,
  removeCurrentGitlabEntityFollow,
  removeGitlabEntityFollow,
} from "../services/scm/gitlab/entity-follow.js";
import { resolveHumanScmBindingPair } from "../services/scm/shared/attention-line.js";
import { sendFollowResult } from "./github-entity-reply.js";

/**
 * Class C — resource-scoped chat routes. Mounted at
 * `/api/v1/chats/:chatId/...`. The chat's `organizationId` locates its
 * org; `requireChatAccess` resolves the caller's membership in that org
 * and gates participation/supervision.
 */
export async function chatRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Web-scope Feishu boundary. Shares `isFeishuBridgedChat` with the agent
   * scope so both answer "is this chat mirrored to Feishu right now?" the same
   * way; see that module for why the answer is active-bindings-only.
   *
   * BEHAVIOR CHANGE: this used to match ANY binding row, including detached
   * ones, which left a detached chat permanently blocked in Web while the agent
   * scope had already let go of it.
   *
   * WORDING: not "read-only". The signed-in user's own view state —
   * read/unread, pin, archive — deliberately keeps working, so "read-only"
   * describes a stricter product than the one we ship and sends people hunting
   * for a workaround they do not need. Name the blocked class instead. (The
   * Web scope blocks more than the agent scope does: a rename is a structural
   * write here, while an agent is required to keep topic/description current.)
   */
  async function assertWebMutableChat(chatId: string): Promise<void> {
    if (await isFeishuBridgedChat(app.db, chatId)) {
      throw new ForbiddenError(
        "This chat is bridged to a Feishu conversation, so structural changes are blocked in the Web app: " +
          "messages, membership, rename and entity follows all land where the humans in this chat — who only ever " +
          "see the Feishu group — cannot see them. Reply in the Feishu conversation instead. Reading the chat, and " +
          "your own read/pin/archive state, keep working normally.",
      );
    }
  }

  async function requireDirectHumanChatMembership(chatId: string, humanAgentId: string): Promise<void> {
    const [direct] = await app.db
      .select({ chatId: chatMembership.chatId })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.agentId, humanAgentId)))
      .limit(1);
    if (!direct) throw new NotFoundError(`Chat "${chatId}" not found`);
  }

  function assertLandingCampaignTrialChatAcceptsHumanMessage(
    metadata: Record<string, unknown> | null,
    body: { metadata?: Record<string, unknown> },
  ): void {
    const trial = parseLandingCampaignTrialChatMetadata(metadata);
    if (!trial) return;
    const resolves = body.metadata?.resolves;
    const resolvesRequest = resolves !== null && typeof resolves === "object";
    if (trial.state === "completed" || trial.state === "failed" || !hasRemainingLandingCampaignTrialBudget(trial)) {
      throw new ForbiddenError("This landing campaign trial chat is locked.");
    }
    if (trial.state === "awaiting_user" && trial.awaitingUserKind !== "follow_up" && !resolvesRequest) {
      throw new ForbiddenError("This landing campaign trial chat is waiting for a request answer.");
    }
  }

  app.get<{ Params: { chatId: string } }>("/:chatId", async (request) => {
    const { chat, scope } = await requireChatAccess(request, app.db);

    // Participants are resolved via INNER JOIN `agents` so each row
    // already carries `name / displayName / type`. The trust boundary
    // for chat-scoped identity is `chat_membership`, not org-level
    // discovery — we deliberately do **not** apply
    // `agentVisibilityCondition` here. See
    // `docs/agent-space-and-mention-visibility-design.zh-CN.md` §4.3.3.
    // v2: chat_membership.mode is decision-inert; we no longer SELECT it.
    // The wire `mode` field is projected from `WIRE_RECIPIENT_MODE` below
    // so already-deployed admin web clients see a stable constant. Drop
    // together with the wire field in v3 (proposals/hub-chat-message-v2-
    // simplify-mode.20260520.md §七).
    const participants = await app.db
      .select({
        agentId: chatMembership.agentId,
        role: chatMembership.role,
        joinedAt: chatMembership.joinedAt,
        name: agents.name,
        displayName: agents.displayName,
        type: agents.type,
        avatarColorToken: agents.avatarColorToken,
        avatarImageUpdatedAt: agents.avatarImageUpdatedAt,
        userAvatarUrl: users.avatarUrl,
      })
      .from(chatMembership)
      .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
      .leftJoin(members, eq(members.agentId, agents.uuid))
      .leftJoin(users, eq(users.id, members.userId))
      .where(and(eq(chatMembership.chatId, chat.id), eq(chatMembership.accessMode, "speaker")));

    const firstMsgRows = (await app.db.execute<{ content: unknown }>(sql`
      SELECT content FROM messages
       WHERE chat_id = ${chat.id}
       ORDER BY created_at ASC
       LIMIT 1
    `)) as unknown as Array<{ content: unknown }>;
    const firstMessagePreview = firstMsgRows[0] ? extractChatSummary(firstMsgRows[0].content) : null;

    const participantsForTitle = participants.map((p) => ({
      agentId: p.agentId,
      displayName: p.displayName,
      type: p.type,
      avatarColorToken: p.avatarColorToken ?? null,
      avatarImageUrl: resolveAvatarImageUrl({
        uuid: p.agentId,
        type: p.type,
        avatarImageUpdatedAt: p.avatarImageUpdatedAt,
        userAvatarUrl: p.userAvatarUrl,
      }),
    }));
    const title = resolveChatTitle(chat.topic, firstMessagePreview, participantsForTitle, scope.humanAgentId);

    const [callerState] = await app.db.execute<{
      engagement_status: ChatEngagementStatus | null;
      access_mode: "speaker" | "watcher" | null;
      last_read_at: Date | string | null;
    }>(sql`
      SELECT
        (
          SELECT ${chatUserState.engagementStatus}
            FROM ${chatUserState}
           WHERE ${chatUserState.chatId} = ${chat.id}
             AND ${chatUserState.agentId} = ${scope.humanAgentId}
           LIMIT 1
        ) AS engagement_status,
        (
          SELECT ${chatMembership.accessMode}
            FROM ${chatMembership}
           WHERE ${chatMembership.chatId} = ${chat.id}
             AND ${chatMembership.agentId} = ${scope.humanAgentId}
           LIMIT 1
        ) AS access_mode,
        (
          SELECT ${chatUserState.lastReadAt}
            FROM ${chatUserState}
           WHERE ${chatUserState.chatId} = ${chat.id}
             AND ${chatUserState.agentId} = ${scope.humanAgentId}
           LIMIT 1
        ) AS last_read_at
    `);
    const engagementStatus = callerState?.engagement_status ?? CHAT_ENGAGEMENT_STATUSES.ACTIVE;
    // Caller's own membership row drives speaker-vs-watcher UI. `null` means
    // the caller reaches the chat through supervision rather than direct
    // membership.
    const viewerMembershipKind: "participant" | "watching" | null = callerState?.access_mode
      ? callerState.access_mode === "speaker"
        ? "participant"
        : "watching"
      : null;

    return {
      ...chat,
      metadata: normalizeLandingCampaignTrialChatMetadataForRead(chat.metadata),
      title,
      firstMessagePreview,
      engagementStatus,
      viewerMembershipKind,
      createdAt: chat.createdAt.toISOString(),
      updatedAt: chat.updatedAt.toISOString(),
      // Task-summary freshness: the description-specific time, and the caller's
      // prior last-read cursor (captured BEFORE the open marks the chat read)
      // so the client can decide unread/auto-expand.
      descriptionUpdatedAt: chat.descriptionUpdatedAt ? chat.descriptionUpdatedAt.toISOString() : null,
      lastReadAt: callerState?.last_read_at ? new Date(callerState.last_read_at).toISOString() : null,
      participants: participants.map((p) => ({
        agentId: p.agentId,
        role: p.role,
        mode: WIRE_RECIPIENT_MODE,
        name: p.name,
        displayName: p.displayName,
        type: p.type,
        joinedAt: p.joinedAt.toISOString(),
        avatarColorToken: p.avatarColorToken ?? null,
        avatarImageUrl: resolveAvatarImageUrl({
          uuid: p.agentId,
          type: p.type,
          avatarImageUpdatedAt: p.avatarImageUpdatedAt,
          userAvatarUrl: p.userAvatarUrl,
        }),
      })),
    };
  });

  /**
   * Composite per-agent status for this chat's non-human speakers — the
   * server-authoritative aggregation (reachability + session + live activity)
   * that the right-sidebar AgentRow and the compose status bar
   * consume. Access is the standard chat-visibility gate; the response set
   * depends only on the chat, not the caller's role.
   */
  app.get<{ Params: { chatId: string } }>("/:chatId/agent-status", async (request) => {
    const { chat } = await requireChatAccess(request, app.db);
    return getChatAgentStatuses(app.db, chat.id);
  });

  /**
   * Recent runtime evidence for every non-human speaker in this chat. Chat
   * access is the disclosure boundary: a private agent invited into the room
   * is inspectable here without becoming discoverable anywhere else. The
   * service re-filters event owners against current speaker membership and
   * applies the limit independently per agent.
   */
  app.get<{
    Params: { chatId: string };
    Querystring: { limit?: string; direction?: string };
  }>("/:chatId/session-events", async (request) => {
    const { chat } = await requireChatAccess(request, app.db);
    const limit = request.query.limit !== undefined ? Number.parseInt(request.query.limit, 10) : undefined;
    const direction = request.query.direction === "desc" ? "desc" : "asc";
    return listChatSpeakerEvents(app.db, chat.id, {
      limit: Number.isFinite(limit) ? limit : undefined,
      direction,
    });
  });

  /**
   * Cumulative token usage for this chat — the SUM over every persisted
   * `token_usage` event (across all participating agents). Drives the marker
   * the composer renders above the input box. Standard chat-visibility gate;
   * the figure depends only on the chat. Resets when a session is terminated
   * (its events are cleared).
   */
  app.get<{ Params: { chatId: string } }>("/:chatId/token-usage", async (request, reply) => {
    const timing = createTimingCollector();
    const { chat } = await timing.time("access", () => requireChatAccess(request, app.db));
    const usage = await timing.time("aggregate", () => summarizeChatTokenUsage(app.db, chat.id));
    reply.header("Server-Timing", timing.serverTimingHeader());
    return usage;
  });

  /**
   * List GitHub entities bound to this chat. Reads the binding rows from
   * `github_entity_chat_mappings` and projects lifecycle state from the
   * webhook-synced `entity_state` column. The route deliberately does not
   * mint GitHub tokens or call GitHub; `title` remains nullable because the
   * mapping table does not persist titles.
   *
   * Returns an empty list when the chat has no bindings.
   */
  app.get<{ Params: { chatId: string } }>("/:chatId/github-entities", async (request) => {
    const { chat } = await requireChatAccess(request, app.db);
    return listChatGithubEntities(app.db, { chatId: chat.id });
  });

  /**
   * Follow a GitHub entity from the user scope (web UI / human terminal).
   * The caller's human agent is the binding's human side; the delegate side
   * comes from their `delegate_mention` configuration — without one there is
   * no (human, delegate) pair to wire, so the request is rejected with
   * guidance. Agents follow through the Class D route instead.
   *
   * The delegate must be an ACTIVE SPEAKER of this chat before the mapping
   * is recorded: GitHub delivery addresses event cards to the delegate, and
   * `sendMessage` only fans out to active speaker rows — a mapping whose
   * delegate isn't in the room would "succeed" while every event lands as a
   * silently stored card that wakes nobody, violating the follow contract
   * (every event wakes the wiring agent). Rejecting with guidance beats
   * silently wiring a dead line; inviting the delegate is one explicit
   * `chat invite` away.
   */
  app.post<{ Params: { chatId: string } }>(
    "/:chatId/github-entities",
    { config: { otelRecordBody: true } },
    async (request, reply) => {
      const { chat, scope } = await requireChatAccess(request, app.db);
      await assertWebMutableChat(chat.id);
      const body = followGithubEntityRequestSchema.parse(request.body);

      const pair = await resolveHumanScmBindingPair(app.db, chat.id, scope.humanAgentId);
      if (!pair) {
        throw new BadRequestError(
          "Following needs delegate_mention to identify an active delegate speaker in this chat; the configured " +
            "delegate is not an active speaker. Invite that delegate into the chat, then retry.",
        );
      }

      const result = await declareEntityFollow(
        app.db,
        { appCredentials: app.config.oauth?.githubApp },
        {
          chatId: chat.id,
          organizationId: pair.organizationId,
          humanAgentId: pair.humanAgentId,
          delegateAgentId: pair.wakeAgentId,
          boundVia: "human_declared",
          entity: body.entity,
          rebind: body.rebind,
        },
      );
      return sendFollowResult(reply, result, body.entity);
    },
  );

  /**
   * Unfollow a GitHub entity: sever every line wired into this chat for it.
   * Always 200 + `{ removed }` — idempotent by design (`removed: 0` is
   * terminal success, not an error).
   */
  app.delete<{ Params: { chatId: string }; Querystring: { entity?: string } }>(
    "/:chatId/github-entities",
    async (request) => {
      const { chat } = await requireChatAccess(request, app.db);
      await assertWebMutableChat(chat.id);
      const entity = request.query.entity;
      if (!entity) {
        throw new BadRequestError("Pass ?entity=<GitHub PR/Issue/Discussion URL | owner/repo#N> to unfollow.");
      }
      return removeEntityFollow(app.db, { chatId: chat.id, entity });
    },
  );

  app.get<{ Params: { chatId: string } }>("/:chatId/gitlab-entities", async (request) => {
    const { chat } = await requireChatAccess(request, app.db);
    return {
      // Retain the legacy explicit-row field for response compatibility.
      entities: await listChatGitlabEntities(app.db, chat.id),
      ...(await listVisibleChatGitlabEntities(app.db, chat.id)),
    };
  });

  app.post<{ Params: { chatId: string } }>(
    "/:chatId/gitlab-entities",
    { config: { otelRecordBody: true } },
    async (request, reply) => {
      const { chat, scope } = await requireChatAccess(request, app.db);
      await assertWebMutableChat(chat.id);
      await requireDirectHumanChatMembership(chat.id, scope.humanAgentId);
      const body = followGitlabEntitySchema.parse(request.body);
      const pair = await resolveHumanScmBindingPair(app.db, chat.id, scope.humanAgentId);
      if (!pair) {
        throw new BadRequestError(
          "Following needs delegate_mention to identify an active delegate speaker in this chat; the configured " +
            "delegate is not an active speaker. Invite that delegate into the chat, then retry.",
        );
      }
      const result = await declareGitlabEntityFollowWithStatus(app.db, {
        organizationId: pair.organizationId,
        connectionId: body.connectionId,
        chatId: chat.id,
        declaredByAgentId: scope.humanAgentId,
        humanAgentId: pair.humanAgentId,
        delegateAgentId: pair.wakeAgentId,
        boundVia: "human_declared",
        entityUrl: body.entityUrl,
        rebind: body.rebind,
      });
      if (result.outcome === "conflict") {
        return reply.status(409).send({
          error: "ENTITY_FOLLOWED_ELSEWHERE",
          message:
            `This GitLab attention line already lives in chat ${result.conflict.chatId}. ` +
            "Work there, or re-issue with rebind to move it into this chat.",
          conflict: result.conflict,
        });
      }
      return reply.status(result.outcome === "already_following" ? 200 : 201).send({
        status: result.outcome,
        entity: projectChatGitlabEntity(result.row),
      });
    },
  );

  app.delete<{ Params: { chatId: string }; Querystring: { entity?: string; mappingId?: string } }>(
    "/:chatId/gitlab-entities",
    async (request) => {
      const { chat, scope } = await requireChatAccess(request, app.db);
      await assertWebMutableChat(chat.id);
      await requireDirectHumanChatMembership(chat.id, scope.humanAgentId);
      if (request.query.entity) {
        return removeCurrentGitlabEntityFollow(app.db, {
          organizationId: scope.organizationId,
          chatId: chat.id,
          entityUrl: request.query.entity,
        });
      }
      if (!request.query.mappingId) {
        throw new BadRequestError(
          "Pass ?entity=<GitLab Issue or Merge Request URL> to unfollow. Legacy clients may pass ?mappingId=<id>.",
        );
      }
      return {
        removed: await removeGitlabEntityFollow(app.db, {
          organizationId: scope.organizationId,
          chatId: chat.id,
          mappingId: request.query.mappingId,
        }),
      };
    },
  );

  app.post<{ Params: { chatId: string } }>(
    "/:chatId/engagement",
    { config: { otelRecordBody: true } },
    async (request, reply) => {
      const { scope } = await requireChatAccess(request, app.db);
      const body = patchChatEngagementSchema.parse(request.body);
      await setChatEngagement(app.db, request.params.chatId, scope.humanAgentId, body.status);
      // Engagement is private per user, so notify only this viewer's sockets.
      // Other tabs/devices use the frame to refresh both their conversation
      // projection and the Active-scoped Need you queue.
      void app.notifier.notifyMeChatsChanged(scope.humanAgentId, scope.organizationId);
      return reply.status(200).send({ chatId: request.params.chatId, engagementStatus: body.status });
    },
  );

  app.patch<{ Params: { chatId: string } }>("/:chatId", { config: { otelRecordBody: true } }, async (request) => {
    // Access enforcement only — the patch attributes to no specific actor now.
    await requireChatAccess(request, app.db);
    await assertWebMutableChat(request.params.chatId);
    const body = updateChatSchema.parse(request.body);
    // Both the console rename / re-describe and the agent `chat update` path go
    // through `updateChatMetadata`, so description-freshness stamping stays in
    // one place.
    const { chat: updated, descriptionChanged } = await updateChatMetadata(app.db, request.params.chatId, body);
    // A real description change must reach an already-open client: the pinned
    // task summary reads the summary + freshness off chat-detail, which the web
    // only refetches on a realtime kick.
    if (descriptionChanged) void app.notifier.notifyChatUpdated(request.params.chatId);
    return {
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  });

  app.get<{ Params: { chatId: string } }>("/:chatId/messages", async (request) => {
    await requireChatAccess(request, app.db);
    const query = paginationQuerySchema.parse(request.query);

    const where = messageHistoryWhere(request.params.chatId, query.cursor);

    const rows = await app.db
      .select({
        id: messages.id,
        chatId: messages.chatId,
        senderId: messages.senderId,
        senderKind: messages.senderKind,
        senderProvider: messages.senderProvider,
        format: messages.format,
        content: messages.content,
        metadata: messages.metadata,
        inReplyTo: messages.inReplyTo,
        source: messages.source,
        createdAt: messages.createdAt,
        deliveryStatus: sql<string>`(
          SELECT CASE
            WHEN EXISTS (SELECT 1 FROM ${inboxEntries} ie WHERE ie.message_id = "messages"."id" AND ie.status = 'acked') THEN 'acked'
            WHEN EXISTS (SELECT 1 FROM ${inboxEntries} ie WHERE ie.message_id = "messages"."id" AND ie.status = 'delivered') THEN 'delivered'
            WHEN EXISTS (SELECT 1 FROM ${inboxEntries} ie WHERE ie.message_id = "messages"."id" AND ie.status = 'pending') THEN 'pending'
            ELSE 'sent'
          END
        )`,
      })
      .from(messages)
      .where(where)
      .orderBy(...messageHistoryOrderBy())
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const items = hasMore ? rows.slice(0, query.limit) : rows;
    const last = items[items.length - 1];
    const nextCursor = hasMore && last ? encodeMessageHistoryCursor(last.createdAt, last.id) : null;

    return {
      items: items.map((m) => ({
        id: m.id,
        chatId: m.chatId,
        senderId: m.senderId,
        senderKind: m.senderKind,
        senderProvider: m.senderProvider,
        format: m.format,
        content: m.content,
        metadata: m.metadata,
        inReplyTo: m.inReplyTo,
        source: m.source,
        deliveryStatus: m.deliveryStatus,
        createdAt: m.createdAt.toISOString(),
      })),
      nextCursor,
    };
  });

  // The caller's currently-open questions in this chat, window-independent —
  // the blocking takeover UI reads this so an open ask that has scrolled past
  // the (capped, unpaginated) message page above still surfaces. Scoped to the
  // member's own human-agent uuid, the same id carried in `metadata.mentions`.
  app.get<{ Params: { chatId: string } }>("/:chatId/open-requests", async (request) => {
    const { scope } = await requireChatAccess(request, app.db);
    const items = await listOpenRequestsForViewer(app.db, request.params.chatId, scope.humanAgentId);
    return {
      items: items.map((m) => ({ ...m, createdAt: m.createdAt.toISOString() })),
    };
  });

  /** Durable request/clarification thread, independent of the latest-50 window. */
  app.get<{ Params: { chatId: string; requestId: string } }>("/:chatId/requests/:requestId/thread", async (request) => {
    await requireChatAccess(request, app.db);
    return listRequestThread(app.db, request.params.chatId, request.params.requestId);
  });

  /**
   * Ask the original agent for clarification without resolving the request.
   * The service validates the request again inside the message transaction and
   * stamps the trusted Ask agent marker; this route accepts visible text only.
   */
  app.post<{ Params: { chatId: string; requestId: string } }>(
    "/:chatId/requests/:requestId/ask-agent",
    async (request, reply) => {
      const { scope } = await requireChatAccess(request, app.db);
      await assertWebMutableChat(request.params.chatId);
      const body = askAgentQuestionSchema.parse(request.body);
      await ensureParticipant(app.db, request.params.chatId, scope.humanAgentId);

      const [parent] = await app.db
        .select({ senderId: messages.senderId })
        .from(messages)
        .where(and(eq(messages.id, request.params.requestId), eq(messages.chatId, request.params.chatId)))
        .limit(1);
      if (!parent) throw new NotFoundError(`Message "${request.params.requestId}" not found in this chat`);

      const result = await sendMessage(
        app.db,
        request.params.chatId,
        scope.humanAgentId,
        {
          source: "web",
          format: "markdown",
          content: body.content,
          metadata: { mentions: [parent.senderId] },
          inReplyTo: request.params.requestId,
        },
        { askAgentRequestId: request.params.requestId },
      );
      notifyRecipients(app.notifier, result.recipients, result.message.id);

      return reply.status(201).send({
        id: result.message.id,
        chatId: result.message.chatId,
        senderId: result.message.senderId,
        senderKind: result.message.senderKind,
        senderProvider: result.message.senderProvider,
        format: result.message.format,
        content: result.message.content,
        metadata: result.message.metadata,
        inReplyTo: result.message.inReplyTo,
        source: result.message.source,
        createdAt: result.message.createdAt.toISOString(),
      });
    },
  );

  // `POST /:chatId/join` (v1 supervision-check join) was removed alongside
  // its `services/chat/conversation.ts::joinChat` service — the v2 watcher-based path
  // `POST /:chatId/workspace-join` (below, see also
  // `services/chat/workspace/me-chat.ts::joinMeChat`) supersedes it and is the only "manager joins
  // chat" route the web / CLI actually call.

  app.post<{ Params: { chatId: string } }>("/:chatId/leave", async (request, reply) => {
    const { scope } = await requireChatAccess(request, app.db);
    await assertWebMutableChat(request.params.chatId);
    const participants = await leaveChat(app.db, request.params.chatId, scope.humanAgentId);
    return reply.status(200).send({
      chatId: request.params.chatId,
      participants: participants.map((p) => ({
        agentId: p.agentId,
        role: p.role,
        // v2: wire `mode` field is decision-inert. Project the constant.
        mode: WIRE_RECIPIENT_MODE,
        joinedAt: p.joinedAt.toISOString(),
      })),
    });
  });

  /**
   * POST /chats/:chatId/messages — caller speaks as their HUMAN agent in the
   * chat's org.
   *
   * Image messages carry only references (`{imageId, mimeType, filename}`):
   * the composer uploads bytes to `POST /orgs/:orgId/attachments` first, then
   * sends this ref-only message. So the body stays small and Fastify's default
   * `bodyLimit` is sufficient — no inline base64 ever rides this route.
   */
  app.post<{ Params: { chatId: string } }>("/:chatId/messages", async (request, reply) => {
    const { chat, scope } = await requireChatAccess(request, app.db);
    await assertWebMutableChat(request.params.chatId);
    const body = sendMessageSchema.parse(request.body);
    assertLandingCampaignTrialChatAcceptsHumanMessage(chat.metadata, body);

    await ensureParticipant(app.db, request.params.chatId, scope.humanAgentId);

    // Explicit-recipient enforcement is the default in `sendMessage()`; this
    // route carries no business flag. The web composer resolves `@<name>` chips
    // client-side via `segmentMentions(content, participants)` and posts the
    // resolved uuids in `metadata.mentions`. In 2-speaker chats the composer
    // auto-injects the peer's uuid so 1:1 typing without an `@` still reaches
    // the recipient. Either way, `metadata.mentions` is expected to be non-empty
    // here; the server no longer parses content. See `services/chat/message.ts`
    // Routing contract.
    const result = await sendMessage(
      app.db,
      request.params.chatId,
      scope.humanAgentId,
      { ...body, source: "web" },
      {
        // Trusted seam: only through this resources-backed validator can a
        // web send have the server persist the Team Skill invocation marker.
        validateTeamSkillInvocation: (precondition) =>
          resolveCanonicalTeamSkillInvocation(app.resourcesService, precondition),
      },
    );

    notifyRecipients(app.notifier, result.recipients, result.message.id);

    return reply.status(201).send({
      id: result.message.id,
      chatId: result.message.chatId,
      senderId: result.message.senderId,
      senderKind: result.message.senderKind,
      senderProvider: result.message.senderProvider,
      format: result.message.format,
      content: result.message.content,
      // Return the STORED row's metadata + inReplyTo (mirrors the GET list
      // shape above). The web composer swaps its optimistic row for this
      // response; omitting these fields stripped `metadata.resolves` /
      // `metadata.mentions` / threading from the cache row during the
      // POST-success → refetch window, flipping a just-answered request back
      // to open and unthreading docked replies.
      metadata: result.message.metadata,
      inReplyTo: result.message.inReplyTo,
      source: result.message.source,
      createdAt: result.message.createdAt.toISOString(),
    });
  });

  /** POST /chats/:chatId/read — chat-first-workspace read cursor. Idempotent. */
  app.post<{ Params: { chatId: string } }>("/:chatId/read", async (request) => {
    const { scope } = await requireChatAccess(request, app.db);
    return markMeChatRead(app.db, request.params.chatId, scope.humanAgentId);
  });

  /** POST /chats/:chatId/unread — manual "mark as unread" affordance. Idempotent. */
  app.post<{ Params: { chatId: string } }>("/:chatId/unread", async (request) => {
    const { scope } = await requireChatAccess(request, app.db);
    return markMeChatUnread(app.db, request.params.chatId, scope.humanAgentId);
  });

  /** POST /chats/:chatId/pin — set/clear the caller's per-user pin. Idempotent. */
  app.post<{ Params: { chatId: string } }>("/:chatId/pin", async (request) => {
    const { scope } = await requireChatAccess(request, app.db);
    const { pinned } = pinMeChatSchema.parse(request.body);
    const result = await pinMeChat(app.db, request.params.chatId, scope.humanAgentId, pinned);
    // Fan a PRIVATE me-chats invalidation to the caller's OTHER devices so the
    // pin regroups everywhere in realtime. User-scoped (never broadcast to other
    // members — pin state is private per-user); fire-and-forget, the 30s
    // me-chats poll is the durable floor.
    void app.notifier.notifyMeChatsChanged(scope.humanAgentId, scope.organizationId);
    return result;
  });

  /** POST /chats/:chatId/participants — add speaking participants. Idempotent. */
  app.post<{ Params: { chatId: string } }>("/:chatId/participants", async (request, reply) => {
    const { chat, scope } = await requireChatAccess(request, app.db);
    await assertWebMutableChat(request.params.chatId);
    if (parseLandingCampaignTrialChatMetadata(chat.metadata)) {
      throw new ForbiddenError("Landing campaign trial chats are managed by First Tree.");
    }
    const body = addMeChatParticipantsSchema.parse(request.body);
    await assertAllAgentsVisibleInOrg(app.db, scope, body.participantIds);
    await assertNoLandingCampaignTrialAgents(app.db, body.participantIds);
    await addMeChatParticipants(app.db, request.params.chatId, scope.humanAgentId, scope.organizationId, body);
    return reply.status(204).send();
  });

  /**
   * DELETE /chats/:chatId/participants/:agentId — remove another speaking
   * participant. Same membership mutation as the agent-JWT DELETE route:
   * any speaker may remove any other speaker (human or agent). Self-removal
   * stays on `workspace-leave` / `leaveMeChat`.
   */
  app.delete<{ Params: { chatId: string; agentId: string } }>(
    "/:chatId/participants/:agentId",
    async (request, reply) => {
      const { scope } = await requireChatAccess(request, app.db);
      await assertWebMutableChat(request.params.chatId);
      await removeParticipant(app.db, request.params.chatId, scope.humanAgentId, request.params.agentId);
      return reply.status(204).send();
    },
  );

  /** Watcher → speaking participant. State-carry. */
  app.post<{ Params: { chatId: string } }>("/:chatId/workspace-join", async (request, reply) => {
    const { scope } = await requireChatAccess(request, app.db);
    await assertWebMutableChat(request.params.chatId);
    await joinMeChat(app.db, request.params.chatId, scope.humanAgentId);
    return reply.status(204).send();
  });

  /** Speaking participant → watcher (or detach). */
  app.post<{ Params: { chatId: string } }>("/:chatId/workspace-leave", async (request) => {
    const { scope } = await requireChatAccess(request, app.db);
    await assertWebMutableChat(request.params.chatId);
    return leaveMeChat(app.db, request.params.chatId, scope.humanAgentId);
  });
}
