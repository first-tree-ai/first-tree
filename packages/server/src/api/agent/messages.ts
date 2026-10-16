import {
  isLegacyRuntimeNoticeSend,
  paginationQuerySchema,
  runtimeNoticeRequestSchema,
  sendMessageSchema,
} from "@first-tree/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAgent } from "../../middleware/require-identity.js";
import { requireUser } from "../../scope/require-user.js";
import { expiryToSeconds, signAgentOutboxToken } from "../../services/auth/tokens.js";
import * as chatService from "../../services/chat/conversation.js";
import * as messageService from "../../services/chat/message.js";
import { notifyRecipients } from "../../services/notifier.js";
import { assertAgentMutableChat } from "./feishu-chat-guard.js";

const editMessageSchema = z.object({
  format: z.string().optional(),
  content: z.unknown(),
});

export async function agentMessageRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { chatId: string } }>("/:chatId/outbox-token", async (request) => {
    const identity = requireAgent(request);
    const user = requireUser(request);
    await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
    // Runtime-authenticated agents may delegate a narrow send-only capability
    // to a scoped sandbox. The token is accepted only for this agent/chat's
    // `POST /api/v1/agent/chats/:chatId/messages` path.
    return {
      accessToken: await signAgentOutboxToken(
        app.config.secrets.jwtSecret,
        user.userId,
        { agentId: identity.uuid, chatId: request.params.chatId },
        app.config.auth.accessTokenExpiry,
      ),
      expiresIn: expiryToSeconds(app.config.auth.accessTokenExpiry),
    };
  });

  app.post<{ Params: { chatId: string } }>(
    "/:chatId/messages",
    { config: { otelRecordBody: true } },
    async (request, reply) => {
      const identity = requireAgent(request);
      await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
      // NOTE: `sendMessageSchema.source` defaults to "api" when omitted
      // (see shared/schemas/message.ts). This is an intentional HTTP-
      // boundary tolerance for SDK callers; production callers all set
      // source explicitly (web/cli/api/github). Do not "fix" this
      // to require explicit source — it would break unaudited third-
      // party integrations.
      const body = sendMessageSchema.parse(request.body);

      // ROLLING-DEPLOY COMPATIBILITY. A client older than `/runtime-notices`
      // publishes its provider-failure and usage-limit notices as this exact
      // send shape, and clients upgrade on their own schedule, so "old client,
      // new server" is a normal steady state rather than a brief window.
      // Recognising the legacy shape routes it to the same handling the
      // dedicated endpoint gets: the notice still lands, and the server — not
      // the body — stamps the stored marker.
      //
      // This is not an authorization decision, and it grants nothing: the
      // runtime-notice endpoint is membership-gated exactly like this route, so
      // any caller that could assemble this body could equally have called that
      // endpoint. Both are misuse-prevention rails around a notice the client
      // runtime reports, not a security boundary. `isLegacyRuntimeNoticeSend`
      // is deliberately an exact shape match; remove it once no supported
      // client predates the endpoint.
      const legacyRuntimeNotice = isLegacyRuntimeNoticeSend(body);

      // Feishu boundary for `chat send` AND `chat ask` (same route; `chat ask`
      // is just `format: "request"`). Applied here rather than inside
      // `messageService.sendMessage`, which the Feishu bridge itself reuses —
      // see `feishu-chat-guard.ts` for that collision.
      //
      // Ordered after `assertParticipant` above so the 403 cannot be probed by
      // a non-member.
      if (!legacyRuntimeNotice) {
        await assertAgentMutableChat(app.db, request.params.chatId);
      }
      const { message: msg, recipients } = await messageService.sendMessage(
        app.db,
        request.params.chatId,
        identity.uuid,
        body,
        {
          // Legacy spelling of the dedicated endpoint; the marker is still
          // server-stamped, never carried over from the request metadata.
          runtimeNotice: legacyRuntimeNotice,
          // Explicit-recipient enforcement is the default in `sendMessage()`;
          // this route carries no business flag. Agent SDK callers (CLI
          // `chat send`, result-sink, etc.) declare routing via `receiverNames`
          // or `metadata.mentions`, or set `purpose: "agent-final-text"` for
          // silent history-only sends. The server no longer parses `@<name>`
          // out of content — see `services/chat/message.ts` Routing contract.
          //
          // Auto-prepend `@<name>` for declared mentions missing from the
          // body so the rendered message matches the routing decision
          // (mainly: result-sink puts the trigger sender in `mentions` but
          // the agent's text rarely includes the @).
          normalizeMentionsInContent: true,
        },
      );

      notifyRecipients(app.notifier, recipients, msg.id);

      return reply.status(201).send({
        ...msg,
        createdAt: msg.createdAt.toISOString(),
      });
    },
  );

  /**
   * Operator-facing runtime notice — "the provider failed", "the usage limit is
   * reached". Its own route on purpose.
   *
   * A runtime notice is exempt from the Feishu-bridged chat write boundary,
   * because an agent that could not run at all must not also go silent: the
   * operator needs that row in First Tree history even when ordinary agent
   * sends into the chat are refused.
   *
   * WHAT THIS ROUTE IS, PRECISELY. It is a MISUSE-PREVENTION RAIL carrying a
   * notice the client runtime reports about itself — NOT a security or
   * authorization boundary, and the exemption it grants is NOT unforgeable.
   * The route is gated on chat membership and nothing else, exactly like
   * `POST /messages`, so every credential that can reach one can reach the
   * other; an agent determined to write into a bridged chat can simply call
   * this endpoint and label the text a runtime notice. Nothing here verifies
   * that a provider actually failed.
   *
   * What the separate route DOES buy is worth having anyway: the ordinary send
   * path stays uniformly guarded with no shape of body that opens it, the
   * server authors the entire stored row so a notice cannot quietly become an
   * addressed message, and the narrow surface makes accidental misuse visible
   * in review instead of plausible. Whether the capability should be narrowed
   * further — to the daemon, or scoped to a chat/turn — is an open posture
   * question, deliberately not settled here.
   *
   * The server authors everything that carries meaning: `source`, `format`,
   * the silent recipientless delivery profile, and the `runtimeNotice` marker
   * (a trusted `sendMessage` option — `stripUntrustedMetadataKeys` deletes any
   * inbound copy). The request contributes only the notice text, and
   * `runtimeNoticeRequestSchema` is strict, so a caller that tries to attach
   * `purpose` or `metadata` gets a 400 instead of a quietly ignored field.
   */
  app.post<{ Params: { chatId: string } }>(
    "/:chatId/runtime-notices",
    { config: { otelRecordBody: true } },
    async (request, reply) => {
      const identity = requireAgent(request);
      await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
      const body = runtimeNoticeRequestSchema.parse(request.body);

      const { message: msg } = await messageService.sendMessage(
        app.db,
        request.params.chatId,
        identity.uuid,
        {
          source: "api",
          format: "text",
          content: body.content,
          // Server-authored delivery profile: recipientless and silent, so a
          // notice wakes nobody and cannot be used to address a teammate.
          purpose: "agent-final-text",
        },
        { runtimeNotice: true },
      );

      return reply.status(201).send({
        ...msg,
        createdAt: msg.createdAt.toISOString(),
      });
    },
  );

  app.patch<{ Params: { chatId: string; messageId: string } }>(
    "/:chatId/messages/:messageId",
    { config: { otelRecordBody: true } },
    async (request) => {
      const identity = requireAgent(request);
      // Membership first, boundary second — the same ordering the send and
      // participant routes use, so neither error reveals a chat's binding
      // state to a non-member.
      await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
      // An edit is a message write. `editMessage` already refuses to touch a
      // bridge-authored row, but ordinary agent messages and runtime notices in
      // a bridged chat are editable without this, and rewriting First Tree
      // history that the Feishu humans cannot see is exactly what the boundary
      // exists to stop. Feishu carries no edit, so the two sides would also
      // silently diverge.
      await assertAgentMutableChat(app.db, request.params.chatId);
      const body = editMessageSchema.parse(request.body);
      const msg = await messageService.editMessage(
        app.db,
        request.params.chatId,
        request.params.messageId,
        identity.uuid,
        body,
        app.attachmentBlobStore,
      );

      return {
        ...msg,
        createdAt: msg.createdAt.toISOString(),
      };
    },
  );

  app.get<{ Params: { chatId: string } }>("/:chatId/messages", async (request) => {
    const identity = requireAgent(request);
    await chatService.assertParticipant(app.db, request.params.chatId, identity.uuid);
    const query = paginationQuerySchema.parse(request.query);
    const result = await messageService.listMessages(app.db, request.params.chatId, query.limit, query.cursor);
    return {
      items: result.items.map((m) => ({
        ...m,
        createdAt: m.createdAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
    };
  });
}
