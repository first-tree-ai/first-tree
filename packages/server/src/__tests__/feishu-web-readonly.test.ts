import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { imBotBindings } from "../db/schema/im-bot-bindings.js";
import { imChatBindings } from "../db/schema/im-chat-bindings.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { createChat } from "../services/chat/conversation.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * "Web write boundary", not "Web read-only": personal view state (read, pin,
 * archive) is deliberately still writable, which is why the 403 text below
 * names the blocked class instead of claiming the whole chat is read-only.
 */
describe("Feishu Web write boundary", () => {
  const getApp = useTestApp();

  async function setup() {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A" });
    const chat = await createChat(app.db, a.agent.uuid, { type: "group", participantIds: [] });
    const foreignInstanceId = `foreign-${crypto.randomUUID()}`;
    await app.db.insert(serverInstances).values({ instanceId: foreignInstanceId, lastHeartbeat: new Date() });
    const [binding] = await app.db
      .insert(imBotBindings)
      .values({
        id: `binding-${crypto.randomUUID()}`,
        organizationId: a.organizationId,
        agentId: a.agent.uuid,
        appId: `cli_${crypto.randomUUID()}`,
        botOpenId: "ou_bot",
        tenantKey: "tenant-a",
        appSecretCipher: "encrypted-test-secret",
        status: "active",
        connectionStatus: "connected",
        connectionOwnerInstanceId: foreignInstanceId,
        connectionLeaseExpiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      })
      .returning();
    if (!binding) throw new Error("binding setup failed");
    const chatBindingId = `chat-binding-${crypto.randomUUID()}`;
    await app.db.insert(imChatBindings).values({
      id: chatBindingId,
      botBindingId: binding.id,
      feishuChatId: "oc_feishu",
      chatId: chat.id,
      feishuChatType: "group",
      status: "active",
    });
    const headers = { authorization: `Bearer ${a.accessToken}` };
    return { app, a, chat, headers, chatBindingId };
  }

  it("allows reads and private view state but rejects structural Web writes", async () => {
    const { app, a, chat, headers } = await setup();
    const detail = await app.inject({ method: "GET", url: `/api/v1/chats/${chat.id}`, headers });
    expect(detail.statusCode).toBe(200);

    const read = await app.inject({ method: "POST", url: `/api/v1/chats/${chat.id}/read`, headers });
    expect(read.statusCode).toBe(200);
    const pin = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${chat.id}/pin`,
      headers,
      payload: { pinned: true },
    });
    expect(pin.statusCode).toBe(200);

    const rename = await app.inject({
      method: "PATCH",
      url: `/api/v1/chats/${chat.id}`,
      headers,
      payload: { topic: "Web must not rename Feishu" },
    });
    expect(rename.statusCode).toBe(403);
    // The refusal must not call the chat read-only: personal state above just
    // succeeded, so that wording would be actively misleading.
    const renameBody = rename.json<{ error: string }>();
    expect(renameBody.error).toContain("structural changes are blocked");
    expect(renameBody.error).toContain("read/pin/archive");
    expect(renameBody.error).not.toContain("read-only");

    const send = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${chat.id}/messages`,
      headers,
      payload: { format: "text", content: "Web must not send", metadata: { mentions: [a.agent.uuid] } },
    });
    expect(send.statusCode).toBe(403);
    const addParticipant = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${chat.id}/participants`,
      headers,
      payload: { agentIds: [a.agent.uuid] },
    });
    expect(addParticipant.statusCode).toBe(403);

    for (const provider of ["github", "gitlab"] as const) {
      const follow = await app.inject({
        method: "POST",
        url: `/api/v1/chats/${chat.id}/${provider}-entities`,
        headers,
        payload: {},
      });
      expect(follow.statusCode).toBe(403);
      const unfollow = await app.inject({
        method: "DELETE",
        url: `/api/v1/chats/${chat.id}/${provider}-entities`,
        headers,
      });
      expect(unfollow.statusCode).toBe(403);
    }
  });

  /**
   * BEHAVIOR CHANGE. The Web guard used to match ANY `im_chat_bindings` row,
   * detached ones included, so a detached chat stayed Web-read-only forever
   * while the agent scope had already released it. Both scopes now share one
   * active-only predicate: once the binding detaches the chat is no longer
   * mirrored into any Feishu conversation, so Web writes are legitimate again.
   */
  it("releases the Web boundary once the binding detaches, matching the agent scope", async () => {
    const { app, a, chat, headers, chatBindingId } = await setup();

    await app.db.update(imChatBindings).set({ status: "detached" }).where(eq(imChatBindings.id, chatBindingId));

    const rename = await app.inject({
      method: "PATCH",
      url: `/api/v1/chats/${chat.id}`,
      headers,
      payload: { topic: "detached, so writable again" },
    });
    expect(rename.statusCode).toBe(200);

    const send = await app.inject({
      method: "POST",
      url: `/api/v1/chats/${chat.id}/messages`,
      headers,
      payload: { format: "text", content: "the bridge is gone", metadata: { mentions: [a.agent.uuid] } },
    });
    expect(send.statusCode).toBe(201);
  });
});
