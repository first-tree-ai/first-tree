import {
  activeRuntimeChatIdsResponseSchema,
  addParticipantSchema,
  archiveChatResponseSchema,
  CHAT_ENGAGEMENT_STATUSES,
  createTaskChatSchema,
  followChatGitlabEntityRequestSchema,
  followGithubEntityRequestSchema,
  legacyCreateChatSchema,
  paginationQuerySchema,
  updateChatSchema,
} from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { members } from "../../db/schema/members.js";
import { BadRequestError, ForbiddenError } from "../../errors.js";
import { requireAgent } from "../../middleware/require-identity.js";
import { createLogger } from "../../observability/index.js";
import * as chatService from "../../services/chat/conversation.js";
import { WIRE_RECIPIENT_MODE } from "../../services/chat/message-dispatcher.js";
import { setChatEngagement } from "../../services/chat/workspace/me-chat.js";
import { notifyRecipients } from "../../services/notifier.js";
import { resolveBindingPair } from "../../services/scm/github/entity-chat.js";
import {
  declareEntityFollow,
  listChatGithubEntities,
  removeEntityFollow,
} from "../../services/scm/github/entity-follow.js";
import {
  declareCurrentGitlabEntityFollow,
  listCurrentChatGitlabEntities,
  removeCurrentGitlabEntityFollow,
} from "../../services/scm/gitlab/entity-follow.js";
import { resolveAgentScmBindingPair } from "../../services/scm/shared/attention-line.js";
import { sendFollowResult } from "../github-entity-reply.js";
import { assertAgentMutableChat, isFeishuBridgedChat } from "./feishu-chat-guard.js";

const log = createLogger("AgentChatsRoute");

function serializeChat(chat: { createdAt: Date; updatedAt: Date; [key: string]: unknown }) {
  return {
    ...chat,
    createdAt: chat.createdAt.toISOString(),
    updatedAt: chat.updatedAt.toISOString(),
  };
}

async function requireCallerHumanAgentId(
  app: FastifyInstance,
  userId: string,
  organizationId: string,
): Promise<string> {
  const [member] = await app.db
    .select({ humanAgentId: members.agentId })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.organizationId, organizationId), eq(members.status, "active")))
    .limit(1);
  if (!member) {
    throw new ForbiddenError("Agent belongs to an organization the caller is not a member of");
  }
  return member.humanAgentId;
}

export async function agentChatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/", async (request, reply) => {
    const identity = requireAgent(request);
    const rawBody = request.body;
    if (rawBody !== null && typeof rawBody === "object" && "mode" in rawBody) {
      if ("campaignAction" in rawBody || "scanFixRepoSlug" in rawBody) {
        throw new BadRequestError("Landing campaign actions can only be started by the signed-in web user.");
      }
      const body = createTaskChatSchema.parse(rawBody);
      const initialRecipientAgentIds = [
        ...body.initialRecipientAgentIds,
        ...(await chatService.resolveAgentIdsByNameInOrg(app.db, identity.organizationId, body.initialRecipientNames)),
      ];
      const contextParticipantAgentIds = [
        ...body.contextParticipantAgentIds,
        ...(await chatService.resolveAgentIdsByNameInOrg(
          app.db,
          identity.organizationId,
          body.contextParticipantNames,
        )),
      ];
      const result = await chatService.createChat(app.db, {
        mode: "task",
        initiatorAgentId: identity.uuid,
        organizationId: identity.organizationId,
        initialRecipientAgentIds,
        contextParticipantAgentIds,
        topic: body.topic ?? null,
        description: body.description ?? null,
        initialMessage: body.initialMessage,
        source: "agent",
      });
      notifyRecipients(app.notifier, result.recipients, result.message.id);
      return reply.status(201).send({
        chatId: result.chat.id,
        messageId: result.message.id,
        topic: result.chat.topic,
        effectiveSenderId: result.effectiveSenderId,
        initialRecipientAgentIds: result.initialRecipientAgentIds,
        contextParticipantAgentIds: result.contextParticipantAgentIds,
      });
    }

    const body = legacyCreateChatSchema.parse(rawBody);
    const result = await chatService.createChat(app.db, identity.uuid, body);
    return reply.status(201).send({
      ...serializeChat(result),
      participants: result.participants.map((p) => ({
        ...p,
        joinedAt: p.joinedAt.toISOString(),
      })),
    });
  });

  app.get("/", async (request) => {
    const identity = requireAgent(request);
    const query = paginationQuerySchema.parse(request.query);
    const result = await chatService.listChats(app.db, identity.uuid, query.limit, query.cursor);
    return {
      items: result.items.map(serializeChat),
      nextCursor: result.nextCursor,
    };
  });

  app.get("/active-runtime-ids", async (request) => {
    const identity = requireAgent(request);
    const user = request.user;
    if (!user) throw new ForbiddenError("User authentication required");

    const humanAgentId = await requireCallerHumanAgentId(app, user.userId, identity.organizationId);

    const [chatIds, activeSessionChatIds] = await Promise.all([
      chatService.listActiveRuntimeChatIds(app.db, identity.uuid, humanAgentId, identity.organizationId),
      chatService.listActiveSessionChatIds(app.db, identity.uuid, identity.organizationId),
    ]);
    return activeRuntimeChatIdsResponseSchema.parse({ chatIds, activeSessionChatIds });
  });

  /**
   * Archive one chat from the signed-in user's private conversation view.
   * The selected runtime agent must be a speaker in the chat, matching the
   * structural scope exposed by `GET /agent/chats` (`first-tree chat list`).
   * The write targets the caller's human-agent row, never another participant's
   * state and never the runtime agent's own projection.
   */
  app.post<{ Params: { chatId: string } }>("/:chatId/archive", async (request, reply) => {
    const identity = requireAgent(request);
    await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);

    const user = request.user;
    if (!user) throw new ForbiddenError("User authentication required");
    const humanAgentId = await requireCallerHumanAgentId(app, user.userId, identity.organizationId);

    await setChatEngagement(app.db, request.params.chatId, humanAgentId, CHAT_ENGAGEMENT_STATUSES.ARCHIVED);
    void app.notifier.notifyMeChatsChanged(humanAgentId, identity.organizationId);

    return reply.status(200).send(
      archiveChatResponseSchema.parse({
        chatId: request.params.chatId,
        engagementStatus: CHAT_ENGAGEMENT_STATUSES.ARCHIVED,
      }),
    );
  });

  app.get<{ Params: { chatId: string } }>("/:chatId", async (request) => {
    const identity = requireAgent(request);
    await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
    const detail = await chatService.getChatDetail(app.db, request.params.chatId, identity.uuid);
    return {
      ...serializeChat(detail),
      // Live bridge state, so an agent-side precondition (`chat create` /
      // `chat open`) can consult the same authority the write boundary uses
      // instead of the stale `metadata.source` label.
      externalChannel: (await isFeishuBridgedChat(app.db, request.params.chatId)) ? "feishu" : null,
      participants: detail.participants.map((p) => ({
        ...p,
        joinedAt: p.joinedAt.toISOString(),
      })),
    };
  });

  /**
   * List chat participants with agent names/displayNames. Used by the client
   * runtime to resolve `@<name>` mentions against the authoritative participant
   * set (see proposals/hub-agent-messaging-reply-and-mentions §4).
   */
  app.get<{ Params: { chatId: string } }>("/:chatId/participants", async (request) => {
    const identity = requireAgent(request);
    await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
    const rows = await chatService.listChatParticipantsWithNames(app.db, request.params.chatId);
    return rows.map((r) => ({
      agentId: r.agentId,
      role: r.role,
      // v2: wire `mode` field is reserved for v3 cleanup; write the constant
      // `WIRE_RECIPIENT_MODE` so already-deployed client runtimes that still
      // parse the field see a stable value. No consumer reads this today.
      mode: WIRE_RECIPIENT_MODE,
      name: r.name,
      displayName: r.displayName,
      type: r.type,
      joinedAt: r.joinedAt.toISOString(),
      avatarColorToken: r.avatarColorToken ?? null,
      avatarImageUrl: r.avatarImageUrl,
    }));
  });

  // Update chat metadata (`topic` and/or `description`) from inside an agent
  // session (`chat update`). Unlike the user-scope PATCH /api/v1/chats/:chatId
  // (which stays participation-gated so a managing human can still rename from
  // the console), this agent route is **owner-gated**: the chat's creator
  // (membership `role == "owner"`) may rename or re-describe it, and in a
  // human-owned chat (Web-created / GitHub-minted) the worker agents count as
  // the owner — see `assertOwner` for the delegate relaxation. A non-owner
  // agent speaker in an agent-created chat is refused with 403.
  app.patch<{ Params: { chatId: string } }>("/:chatId", { config: { otelRecordBody: true } }, async (request) => {
    const identity = requireAgent(request);
    await chatService.assertOwner(app.db, request.params.chatId, identity.uuid);
    const body = updateChatSchema.parse(request.body);
    // The `chat update --description` path that keeps the task-summary freshness
    // line current.
    const { chat: updated, descriptionChanged } = await chatService.updateChatMetadata(
      app.db,
      request.params.chatId,
      body,
    );
    // Push a realtime kick so an open web client's pinned task summary + the
    // conversation list reflect the new summary without waiting for a message.
    if (descriptionChanged) void app.notifier.notifyChatUpdated(request.params.chatId);
    return serializeChat(updated);
  });

  // Participant management
  app.post<{ Params: { chatId: string } }>("/:chatId/participants", async (request, reply) => {
    const identity = requireAgent(request);

    // Reject the deprecated `mode` field early with a clear error. Phase 1
    // moved participant mode to server-derived state; callers that still
    // send `mode` would otherwise have it silently ignored, which is
    // strictly worse than a loud 400. The log entry is the regression
    // signal — operators can grep for `MODE_FIELD_DEPRECATED` to find any
    // remaining caller that needs updating. See design doc §3.2.
    if (request.body !== null && typeof request.body === "object" && "mode" in request.body) {
      log.warn(
        {
          code: "MODE_FIELD_DEPRECATED",
          chatId: request.params.chatId,
          senderAgentId: identity.uuid,
          userAgent: request.headers["user-agent"] ?? "unknown",
        },
        "Rejected: addParticipant body contains deprecated `mode` field",
      );
      return reply.status(400).send({
        error:
          "MODE_FIELD_DEPRECATED: the `mode` field is no longer accepted. Participant mode is derived server-side from chat type + agent type. Remove this field from your request.",
      });
    }

    // Authorize BEFORE the Feishu boundary. `addParticipant` below re-checks
    // membership inside the invite service, but that is too late for this
    // route: running the bridged-chat guard first would answer "is this chat
    // bound to Feishu?" to a caller who is not even a participant, turning the
    // 403 into an oracle over guessed chat UUIDs. Checking membership here
    // makes the two failures indistinguishable to an outsider.
    await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);

    // Feishu boundary for `chat invite`: pulling another agent into a bridged
    // chat only widens a room the Feishu humans cannot see.
    await assertAgentMutableChat(app.db, request.params.chatId);

    const body = addParticipantSchema.parse(request.body);
    const participants = await chatService.addParticipant(app.db, request.params.chatId, identity.uuid, body);
    return reply.status(201).send(
      participants.map((p) => ({
        ...p,
        joinedAt: p.joinedAt.toISOString(),
      })),
    );
  });

  app.delete<{ Params: { chatId: string; agentId: string } }>(
    "/:chatId/participants/:agentId",
    async (request, reply) => {
      const identity = requireAgent(request);

      // Same two-step as the invite route above, and for the same two reasons.
      // `removeParticipant` re-checks membership inside its transaction, but a
      // removal mutates SHARED membership of a chat the Feishu humans cannot
      // see, so the boundary has to apply here too — adding a participant and
      // dropping one are the same class of change. Membership is authorized
      // FIRST so the 403 cannot be used to probe which guessed chat UUIDs are
      // Feishu-bound.
      await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
      await assertAgentMutableChat(app.db, request.params.chatId);

      await chatService.removeParticipant(app.db, request.params.chatId, identity.uuid, request.params.agentId);
      return reply.status(204).send();
    },
  );

  // ── GitHub entity follow / unfollow (`first-tree github …`) ─────────────
  //
  // The agent-side wiring surface. Creating a PR/Issue never auto-follows;
  // an agent that wants the entity's events in this chat declares it here,
  // immediately after creation. The human side of the binding pair is the
  // chat's representative human (see `resolveBindingPair`); the caller is
  // the wake side.

  app.get<{ Params: { chatId: string } }>("/:chatId/github-entities", async (request) => {
    const identity = requireAgent(request);
    await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
    return listChatGithubEntities(app.db, { chatId: request.params.chatId });
  });

  app.post<{ Params: { chatId: string } }>(
    "/:chatId/github-entities",
    { config: { otelRecordBody: true } },
    async (request, reply) => {
      const identity = requireAgent(request);
      await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
      const body = followGithubEntityRequestSchema.parse(request.body);

      const pair = await resolveBindingPair(app.db, request.params.chatId, identity.uuid);
      if (!pair) {
        throw new BadRequestError(
          "No eligible (human, wake-agent) binding pair: the caller must be an active same-Team agent speaker, " +
            "the chat needs an active same-Team human member, and no more than one human may link the caller " +
            "as delegate. Humans follow via the web UI instead.",
        );
      }

      const result = await declareEntityFollow(
        app.db,
        { appCredentials: app.config.oauth?.githubApp },
        {
          chatId: request.params.chatId,
          organizationId: pair.organizationId,
          humanAgentId: pair.humanAgentId,
          delegateAgentId: pair.delegateAgentId,
          boundVia: "agent_declared",
          entity: body.entity,
          rebind: body.rebind,
        },
      );
      return sendFollowResult(reply, result, body.entity);
    },
  );

  app.delete<{ Params: { chatId: string }; Querystring: { entity?: string } }>(
    "/:chatId/github-entities",
    async (request) => {
      const identity = requireAgent(request);
      await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
      const entity = request.query.entity;
      if (!entity) {
        throw new BadRequestError("Pass ?entity=<GitHub PR/Issue/Discussion URL | owner/repo#N> to unfollow.");
      }
      return removeEntityFollow(app.db, { chatId: request.params.chatId, entity });
    },
  );

  app.get<{ Params: { chatId: string } }>("/:chatId/gitlab-entities", async (request) => {
    const identity = requireAgent(request);
    await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
    return listCurrentChatGitlabEntities(app.db, request.params.chatId);
  });

  app.post<{ Params: { chatId: string } }>(
    "/:chatId/gitlab-entities",
    { config: { otelRecordBody: true } },
    async (request, reply) => {
      const identity = requireAgent(request);
      await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
      const body = followChatGitlabEntityRequestSchema.parse(request.body);
      const pair = await resolveAgentScmBindingPair(app.db, request.params.chatId, identity.uuid);
      if (!pair) {
        throw new BadRequestError(
          "No eligible (human, wake-agent) attention pair: the caller must be an active same-Team agent speaker, " +
            "the chat needs an active same-Team human member, and no more than one human may link the caller " +
            "as delegate.",
        );
      }
      const result = await declareCurrentGitlabEntityFollow(app.db, {
        organizationId: pair.organizationId,
        chatId: request.params.chatId,
        declaredByAgentId: identity.uuid,
        humanAgentId: pair.humanAgentId,
        delegateAgentId: pair.wakeAgentId,
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
      return reply.status(result.response.status === "already_following" ? 200 : 201).send(result.response);
    },
  );

  app.delete<{ Params: { chatId: string }; Querystring: { entity?: string } }>(
    "/:chatId/gitlab-entities",
    async (request) => {
      const identity = requireAgent(request);
      await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
      const entityUrl = request.query.entity;
      if (!entityUrl) throw new BadRequestError("Pass ?entity=<full GitLab issue or merge request URL> to unfollow.");
      return removeCurrentGitlabEntityFollow(app.db, {
        organizationId: identity.organizationId,
        chatId: request.params.chatId,
        entityUrl,
      });
    },
  );
}
