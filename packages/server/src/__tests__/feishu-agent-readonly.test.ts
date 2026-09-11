import { legacyRuntimeNoticeSendBody, RUNTIME_NOTICE_METADATA_KEY } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { FEISHU_AGENT_CHAT_WRITE_CODE, FEISHU_AGENT_CHAT_WRITE_MESSAGE } from "../api/agent/feishu-chat-guard.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { imBotBindings } from "../db/schema/im-bot-bindings.js";
import { imChatBindings } from "../db/schema/im-chat-bindings.js";
import { messages } from "../db/schema/messages.js";
import { serverInstances } from "../db/schema/server-instances.js";
import { createChat } from "../services/chat/conversation.js";
import { sendMessage } from "../services/chat/message.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * The complete refusal body, asserted with `toEqual` rather than a status +
 * code spot-check. The message is the actionable half of this boundary — it is
 * what tells an agent to answer through Feishu instead — so a route that
 * refuses with the right code and the wrong (or missing) guidance is still a
 * regression, and only a full-body comparison catches it.
 */
const FEISHU_REFUSAL_BODY = {
  error: FEISHU_AGENT_CHAT_WRITE_MESSAGE,
  code: FEISHU_AGENT_CHAT_WRITE_CODE,
};

/** What a non-member sees on any of these routes, bridged chat or not. */
const NOT_A_PARTICIPANT_BODY = { error: "Not a participant of this chat" };

/**
 * Agent-scope mirror of `feishu-web-readonly.test.ts`. The Web boundary keeps
 * a Feishu-bridged chat readable but structurally immutable for the signed-in
 * user; this pins the symmetric boundary for the agent's own chat tools, whose
 * writes would otherwise land where no Feishu human can see them.
 */
describe("Feishu agent chat-tool boundary", () => {
  const getApp = useTestApp();

  async function setup() {
    const app = getApp();
    const a = await createTestAgent(app, { displayName: "Agent A" });
    const b = await createTestAgent(app, { displayName: "Agent B" });
    const c = await createTestAgent(app, { displayName: "Agent C" });
    const chat = await createChat(app.db, a.agent.uuid, { type: "group", participantIds: [b.agent.uuid] });
    const foreignInstanceId = `foreign-${crypto.randomUUID()}`;
    await app.db.insert(serverInstances).values({ instanceId: foreignInstanceId, lastHeartbeat: new Date() });
    const [botBinding] = await app.db
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
    if (!botBinding) throw new Error("binding setup failed");
    const chatBindingId = `chat-binding-${crypto.randomUUID()}`;
    await app.db.insert(imChatBindings).values({
      id: chatBindingId,
      botBindingId: botBinding.id,
      feishuChatId: "oc_feishu",
      chatId: chat.id,
      feishuChatType: "group",
      status: "active",
    });
    // An ordinary agent message that exists in the bridged chat. Seeded through
    // the service, which is deliberately unguarded (the Feishu bridge reuses
    // it), so the edit route has a row that is NOT bridge-authored to aim at —
    // `editMessage`'s own Feishu-history rule would otherwise mask the gap.
    const seeded = await sendMessage(app.db, chat.id, a.agent.uuid, {
      source: "cli",
      format: "text",
      content: "an ordinary agent message",
      metadata: { mentions: [b.agent.uuid] },
    });
    return { app, a, b, c, chat, chatBindingId, seededMessageId: seeded.message.id };
  }

  it("rejects `chat send`, `chat ask` and `chat invite` with an actionable code", async () => {
    const { a, b, c, chat } = await setup();

    const send = await a.request("POST", `/api/v1/agent/chats/${chat.id}/messages`, {
      format: "text",
      content: "this would vanish",
      source: "cli",
      metadata: { mentions: [b.agent.uuid] },
    });
    expect(send.statusCode).toBe(403);
    const sendBody = send.json<{ code?: string; error: string }>();
    expect(sendBody.code).toBe(FEISHU_AGENT_CHAT_WRITE_CODE);
    // The refusal must name the path that actually delivers, not just refuse.
    expect(sendBody.error).toContain("feishu intent");
    expect(sendBody.error).toContain("lark-cli");

    // `chat ask` is the same route with `format: "request"` — one guard covers both.
    const ask = await a.request("POST", `/api/v1/agent/chats/${chat.id}/messages`, {
      format: "request",
      content: "should I proceed?",
      source: "cli",
      metadata: { mentions: [b.agent.uuid] },
    });
    expect(ask.statusCode).toBe(403);
    expect(ask.json<{ code?: string }>().code).toBe(FEISHU_AGENT_CHAT_WRITE_CODE);

    const invite = await a.request("POST", `/api/v1/agent/chats/${chat.id}/participants`, {
      agentIds: [c.agent.uuid],
    });
    expect(invite.statusCode).toBe(403);
    expect(invite.json<{ code?: string }>().code).toBe(FEISHU_AGENT_CHAT_WRITE_CODE);
  });

  /**
   * The documented boundary is "messages AND MEMBERSHIP CHANGES". Adding a
   * participant was guarded from the start; removing one mutates the same
   * shared membership of the same invisible room, and editing a message
   * rewrites the same unreadable history — a boundary that stops one and not
   * the others is just a differently-shaped hole.
   */
  it("blocks membership removal and message edits with the same actionable refusal", async () => {
    const { app, a, b, chat, seededMessageId } = await setup();

    const removal = await a.request("DELETE", `/api/v1/agent/chats/${chat.id}/participants/${b.agent.uuid}`);
    expect(removal.statusCode).toBe(403);
    expect(removal.json()).toEqual(FEISHU_REFUSAL_BODY);

    const edit = await a.request("PATCH", `/api/v1/agent/chats/${chat.id}/messages/${seededMessageId}`, {
      content: "rewritten after the fact",
    });
    expect(edit.statusCode).toBe(403);
    expect(edit.json()).toEqual(FEISHU_REFUSAL_BODY);

    // A refusal that still mutated would be the worst of both worlds.
    const [stillMember] = await app.db
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(and(eq(chatMembership.chatId, chat.id), eq(chatMembership.agentId, b.agent.uuid)));
    expect(stillMember).toBeDefined();

    const [stored] = await app.db.select().from(messages).where(eq(messages.id, seededMessageId));
    expect(stored?.content).toBe("an ordinary agent message");
  });

  /** The send and invite refusals carry the same complete body. */
  it("gives `chat send` and `chat invite` the identical full refusal body", async () => {
    const { a, b, c, chat } = await setup();

    const send = await a.request("POST", `/api/v1/agent/chats/${chat.id}/messages`, {
      format: "text",
      content: "this would vanish",
      source: "cli",
      metadata: { mentions: [b.agent.uuid] },
    });
    expect(send.json()).toEqual(FEISHU_REFUSAL_BODY);

    const invite = await a.request("POST", `/api/v1/agent/chats/${chat.id}/participants`, {
      agentIds: [c.agent.uuid],
    });
    expect(invite.json()).toEqual(FEISHU_REFUSAL_BODY);
  });

  it("keeps reads, `chat update` and the bridge signal working", async () => {
    const { a, chat } = await setup();

    const detail = await a.request("GET", `/api/v1/agent/chats/${chat.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ externalChannel: string | null }>().externalChannel).toBe("feishu");

    const history = await a.request("GET", `/api/v1/agent/chats/${chat.id}/messages`);
    expect(history.statusCode).toBe(200);

    const participants = await a.request("GET", `/api/v1/agent/chats/${chat.id}/participants`);
    expect(participants.statusCode).toBe(200);

    // Deliberately still allowed: the agent briefing requires it to keep the
    // chat's topic/description current, and neither is a message to a human.
    const update = await a.request("PATCH", `/api/v1/agent/chats/${chat.id}`, {
      topic: "Feishu bridge triage",
      description: "Answering in the Feishu group.",
    });
    expect(update.statusCode).toBe(200);
  });

  /**
   * The exemption is a property of the ROUTE, so the genuine runtime notice
   * has to keep landing: an agent that cannot run at all must not also go
   * silent on the operator watching the chat.
   */
  it("delivers a genuine runtime notice through the dedicated route and marks it server-side", async () => {
    const { app, a, chat } = await setup();

    const notice = await a.request("POST", `/api/v1/agent/chats/${chat.id}/runtime-notices`, {
      content: "Claude Code could not run this turn: credentials need attention.",
    });
    expect(notice.statusCode).toBe(201);

    const [stored] = await app.db.select().from(messages).where(eq(messages.id, notice.json<{ id: string }>().id));
    expect(stored?.metadata).toMatchObject({ [RUNTIME_NOTICE_METADATA_KEY]: true });
  });

  /**
   * Regression for the old blanket body exemption: ANY send that carried the
   * final-text purpose plus the marker used to pass, which made the boundary
   * depend on what the caller said it was doing. Only the exact legacy wire
   * shape is honoured now (see the rolling-deploy test above), and these
   * decorated ordinary sends are not it.
   */
  it("rejects a forged runtime notice from an ordinary agent credential", async () => {
    const { app, a, b, chat } = await setup();

    const forged = await a.request("POST", `/api/v1/agent/chats/${chat.id}/messages`, {
      format: "text",
      content: "arbitrary content wearing a runtime-notice costume",
      source: "cli",
      purpose: "agent-final-text",
      metadata: { [RUNTIME_NOTICE_METADATA_KEY]: true },
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.json<{ code?: string }>().code).toBe(FEISHU_AGENT_CHAT_WRITE_CODE);

    // The silent delivery profile alone never opened the door either.
    const bareFinalText = await a.request("POST", `/api/v1/agent/chats/${chat.id}/messages`, {
      format: "text",
      content: "not a runtime notice",
      source: "cli",
      purpose: "agent-final-text",
    });
    expect(bareFinalText.statusCode).toBe(403);
    expect(bareFinalText.json<{ code?: string }>().code).toBe(FEISHU_AGENT_CHAT_WRITE_CODE);

    // And even in an ORDINARY chat, where the send succeeds, the smuggled
    // marker must not survive onto the stored row — otherwise the forgery just
    // moves one chat over.
    const plain = await createChat(app.db, a.agent.uuid, { type: "group", participantIds: [b.agent.uuid] });
    const smuggled = await a.request("POST", `/api/v1/agent/chats/${plain.id}/messages`, {
      format: "text",
      content: "ordinary send carrying the marker",
      source: "cli",
      metadata: { [RUNTIME_NOTICE_METADATA_KEY]: true, mentions: [b.agent.uuid] },
    });
    expect(smuggled.statusCode).toBe(201);
    const [stored] = await app.db.select().from(messages).where(eq(messages.id, smuggled.json<{ id: string }>().id));
    expect(stored?.metadata).not.toHaveProperty(RUNTIME_NOTICE_METADATA_KEY);
  });

  /**
   * The notice route is a narrower capability, not an open door: it still
   * requires membership, and it refuses to let the caller shape the stored row.
   */
  it("keeps the runtime-notice route membership-gated and strict about its body", async () => {
    const { a, c, chat } = await setup();

    const outsider = await c.request("POST", `/api/v1/agent/chats/${chat.id}/runtime-notices`, {
      content: "not my chat",
    });
    expect(outsider.statusCode).toBe(403);
    expect(outsider.json<{ code?: string }>().code).not.toBe(FEISHU_AGENT_CHAT_WRITE_CODE);

    const overreaching = await a.request("POST", `/api/v1/agent/chats/${chat.id}/runtime-notices`, {
      content: "trying to address a teammate",
      metadata: { mentions: [c.agent.uuid] },
    });
    expect(overreaching.statusCode).toBe(400);
  });

  /**
   * The guard must not become an oracle: a non-member who guesses a chat UUID
   * should not be able to tell a Feishu-bound chat from an ordinary one by the
   * difference in error.
   */
  it("authorizes membership before the boundary, so the 403 cannot be probed", async () => {
    const { app, a, b, c, chat, seededMessageId } = await setup();
    const plain = await createChat(app.db, a.agent.uuid, { type: "group", participantIds: [b.agent.uuid] });

    // Full-body equality across BOTH targets is the actual property under test:
    // the bridged and the ordinary chat must be indistinguishable to a
    // non-member, and comparing whole bodies leaves no field free to leak the
    // difference.
    for (const target of [chat, plain]) {
      const invite = await c.request("POST", `/api/v1/agent/chats/${target.id}/participants`, {
        agentIds: [c.agent.uuid],
      });
      expect(invite.statusCode).toBe(403);
      expect(invite.json()).toEqual(NOT_A_PARTICIPANT_BODY);

      const send = await c.request("POST", `/api/v1/agent/chats/${target.id}/messages`, {
        format: "text",
        content: "probing",
        source: "cli",
        metadata: { mentions: [a.agent.uuid] },
      });
      expect(send.statusCode).toBe(403);
      expect(send.json()).toEqual(NOT_A_PARTICIPANT_BODY);

      const removal = await c.request("DELETE", `/api/v1/agent/chats/${target.id}/participants/${b.agent.uuid}`);
      expect(removal.statusCode).toBe(403);
      expect(removal.json()).toEqual(NOT_A_PARTICIPANT_BODY);

      // The message id only exists in the bridged chat; a non-member must not
      // learn even that much, so the membership check has to come first.
      const edit = await c.request("PATCH", `/api/v1/agent/chats/${target.id}/messages/${seededMessageId}`, {
        content: "probing",
      });
      expect(edit.statusCode).toBe(403);
      expect(edit.json()).toEqual(NOT_A_PARTICIPANT_BODY);
    }
  });

  /**
   * ROLLING DEPLOY, old client → new server. A client that predates
   * `/runtime-notices` publishes the same notice as a decorated send, and
   * clients upgrade on their own schedule. Dropping it would silence exactly
   * the operator signal a deploy is most likely to produce.
   */
  it("still delivers a runtime notice sent in the legacy shape by an older client", async () => {
    const { app, a, chat } = await setup();

    const legacy = await a.request(
      "POST",
      `/api/v1/agent/chats/${chat.id}/messages`,
      legacyRuntimeNoticeSendBody("Claude Code could not run this turn: credentials need attention."),
    );
    expect(legacy.statusCode).toBe(201);

    // Same stored shape as the dedicated route produces: the marker is stamped
    // by the server, not carried over from the request metadata.
    const [stored] = await app.db.select().from(messages).where(eq(messages.id, legacy.json<{ id: string }>().id));
    expect(stored?.metadata).toMatchObject({ [RUNTIME_NOTICE_METADATA_KEY]: true });
    expect(stored?.metadata).not.toHaveProperty("agentFinalText");
  });

  /**
   * The compatibility path is an EXACT shape match for what older clients
   * emit, not a general "say it is a notice and the boundary lifts" escape.
   */
  it("does not extend the legacy shape to near-misses", async () => {
    const { a, b, chat } = await setup();

    const nearMisses = [
      // A different source: the legacy call sites all sent `api`.
      { ...legacyRuntimeNoticeSendBody("wrong source"), source: "cli" as const },
      // Extra metadata — a notice addresses nobody.
      {
        ...legacyRuntimeNoticeSendBody("addressed"),
        metadata: { [RUNTIME_NOTICE_METADATA_KEY]: true, mentions: [b.agent.uuid] },
      },
      // The silent delivery purpose on its own never meant "runtime notice".
      { ...legacyRuntimeNoticeSendBody("no marker"), metadata: {} },
    ];

    for (const body of nearMisses) {
      const res = await a.request("POST", `/api/v1/agent/chats/${chat.id}/messages`, body);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual(FEISHU_REFUSAL_BODY);
    }
  });

  it("releases the boundary once the Feishu binding detaches", async () => {
    const { app, a, b, chat, chatBindingId } = await setup();

    await app.db.update(imChatBindings).set({ status: "detached" }).where(eq(imChatBindings.id, chatBindingId));

    const detail = await a.request("GET", `/api/v1/agent/chats/${chat.id}`);
    expect(detail.json<{ externalChannel: string | null }>().externalChannel).toBeNull();

    const send = await a.request("POST", `/api/v1/agent/chats/${chat.id}/messages`, {
      format: "text",
      content: "the bridge is gone; this is an ordinary chat again",
      source: "cli",
      metadata: { mentions: [b.agent.uuid] },
    });
    expect(send.statusCode).toBe(201);
  });

  it("leaves an unbridged chat untouched", async () => {
    const { app, a, b } = await setup();
    const plain = await createChat(app.db, a.agent.uuid, { type: "group", participantIds: [b.agent.uuid] });

    const detail = await a.request("GET", `/api/v1/agent/chats/${plain.id}`);
    expect(detail.json<{ externalChannel: string | null }>().externalChannel).toBeNull();

    const send = await a.request("POST", `/api/v1/agent/chats/${plain.id}/messages`, {
      format: "text",
      content: "ordinary send",
      source: "cli",
      metadata: { mentions: [b.agent.uuid] },
    });
    expect(send.statusCode).toBe(201);
  });
});
