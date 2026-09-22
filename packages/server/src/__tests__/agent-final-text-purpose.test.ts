import { RUNTIME_NOTICE_METADATA_KEY } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { inboxEntries } from "../db/schema/inbox-entries.js";
import { createChat } from "../services/chat/conversation.js";
import { sendMessage } from "../services/chat/message.js";
import { createMeChat, listMeChats } from "../services/chat/workspace/me-chat.js";
import { createTestAdmin, createTestAgent, useTestApp } from "./helpers.js";

/**
 * `purpose: "agent-final-text"` bypass channel.
 *
 * `result-sink.forwardResult` calls `sdk.sendMessage` with this tag set.
 * Without the bypass, the server's default explicit-recipient guard rejects
 * every write that has no explicit `metadata.mentions` / `receiverNames` / `addressedTo`.
 * These tests pin:
 *
 *   1. chat + no mentions + `purpose` tag → message stored, every fan-out
 *      row is `notify=false`, no recipients are woken;
 *   2. chat + no mentions + NO `purpose` tag → still 400 (regression
 *      guard);
 *   3. direct chat: bypass also flips fan-out to silent so peer agents
 *      don't get woken by a stray final text;
 *   4. chat WITH explicit mentions + `purpose` tag → still silent (the
 *      bypass also mutes wakeups it would otherwise produce — final text
 *      never wakes, even if it incidentally names someone).
 */

describe("sendMessage — agent-final-text bypass (v1 §四 改造 4 b)", () => {
  const getApp = useTestApp();

  it("accepts a send with no mentions when purpose='agent-final-text' (no 400)", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const peerA = await createTestAgent(app, { type: "agent" });
    const peerB = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peerA.agent.uuid, peerB.agent.uuid],
    });

    const result = await sendMessage(app.db, chat.id, peerA.agent.uuid, {
      source: "api",
      format: "text",
      content: "i am done — turn ended",
      purpose: "agent-final-text",
    });

    expect(result.message).toBeDefined();
    // No wake-ups: recipients list is empty (the inbox writes still happen
    // but every row is notify=false, see below).
    expect(result.recipients).toEqual([]);
  });

  it("forces every fan-out row to notify=false when purpose='agent-final-text'", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const peerA = await createTestAgent(app, { type: "agent" });
    const peerB = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peerA.agent.uuid, peerB.agent.uuid],
    });

    const r = await sendMessage(app.db, chat.id, peerA.agent.uuid, {
      source: "api",
      format: "text",
      content: "final text broadcast",
      purpose: "agent-final-text",
    });

    // Every fan-out row for this message must be notify=false.
    const fanRows = await app.db
      .select({ inboxId: inboxEntries.inboxId, notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(eq(inboxEntries.messageId, r.message.id));
    expect(fanRows.length).toBeGreaterThan(0);
    for (const row of fanRows) {
      expect(row.notify).toBe(false);
    }
  });

  it("persists metadata.agentFinalText=true so the web can identify final-text mirror rows", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const peerA = await createTestAgent(app, { type: "agent" });
    const peerB = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peerA.agent.uuid, peerB.agent.uuid],
    });

    const r = await sendMessage(app.db, chat.id, peerA.agent.uuid, {
      source: "api",
      format: "text",
      content: "i am done — turn ended",
      purpose: "agent-final-text",
    });

    expect(r.message.metadata.agentFinalText).toBe(true);
  });

  it("does not mark runtime notices as agent final text even though they use the silent delivery profile", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const peerA = await createTestAgent(app, { type: "agent" });
    const peerB = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peerA.agent.uuid, peerB.agent.uuid],
    });

    // The marker is a trusted OPTION now, not a request field — see the
    // smuggling test below.
    const r = await sendMessage(
      app.db,
      chat.id,
      peerA.agent.uuid,
      {
        source: "api",
        format: "text",
        content: "provider failed after retry handling",
        purpose: "agent-final-text",
      },
      { runtimeNotice: true },
    );

    expect(r.recipients).toEqual([]);
    expect(r.message.metadata[RUNTIME_NOTICE_METADATA_KEY]).toBe(true);
    expect(r.message.metadata.agentFinalText).toBeUndefined();
  });

  /**
   * The stored marker decides whether a row counts as an agent final-text
   * mirror, which the staging view toggle filters on. Keeping it server-stamped
   * means the classification always reflects which endpoint was called rather
   * than what a body claimed — the route layer decides that, never the service.
   */
  it("strips a client-smuggled runtimeNotice flag so the marker stays server-owned", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const peerA = await createTestAgent(app, { type: "agent" });
    const peerB = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peerA.agent.uuid, peerB.agent.uuid],
    });

    const r = await sendMessage(app.db, chat.id, peerA.agent.uuid, {
      source: "api",
      format: "text",
      content: "pretending to be a runtime notice",
      metadata: { [RUNTIME_NOTICE_METADATA_KEY]: true, mentions: [peerB.agent.uuid] },
    });

    expect(r.message.metadata[RUNTIME_NOTICE_METADATA_KEY]).toBeUndefined();
  });

  it("does NOT mark a normal agent send, and strips a client-smuggled agentFinalText flag", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const peerA = await createTestAgent(app, { type: "agent" });
    const peerB = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peerA.agent.uuid, peerB.agent.uuid],
    });

    // A deliberate agent send (has a recipient, no purpose) that tries to
    // smuggle the flag in via metadata. The flag is server-owned, so it must
    // be stripped — a real `chat send` must never look like a final-text row.
    const r = await sendMessage(app.db, chat.id, peerA.agent.uuid, {
      source: "api",
      format: "text",
      content: `@${peerB.agent.name} please look`,
      metadata: { mentions: [peerB.agent.uuid], agentFinalText: true },
    });

    expect(r.message.metadata.agentFinalText).toBeUndefined();
  });

  it("does NOT mark a human/web send carrying purpose='agent-final-text' (sender-type gate, R5)", async () => {
    // `purpose` rides the shared sendMessage schema, so the human/web route
    // (`POST /chats/:id/messages`, source="web") can set it. Such a send still
    // takes the silent enforcement profile, but must NOT be persisted as a
    // final-text mirror — otherwise a human send could be hidden by the toggle.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `r5-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    const r = await sendMessage(app.db, chatId, admin.humanAgentUuid, {
      source: "web",
      format: "text",
      content: "human pretending to be final text",
      purpose: "agent-final-text",
    });

    expect(r.message.metadata.agentFinalText).toBeUndefined();
  });

  it("still 400s when purpose is absent and no mentions declared (regression guard for the enforce rule)", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { type: "human" });
    const peerA = await createTestAgent(app, { type: "agent" });
    const peerB = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, owner.agent.uuid, {
      type: "group",
      participantIds: [peerA.agent.uuid, peerB.agent.uuid],
    });

    await expect(
      sendMessage(app.db, chat.id, peerA.agent.uuid, {
        source: "api",
        format: "text",
        content: "i am done — turn ended",
      }),
    ).rejects.toThrow(/explicit recipient/i);
  });

  it("direct chat: bypass forces fan-out notify=false even when peer would normally wake on mention", async () => {
    // direct chat agent↔agent is `mention_only` post-migration 0029. Without
    // the bypass, an explicit @<peer> here would wake peer; the bypass tag
    // must override that so final text never wakes anyone in any chat
    // shape — same invariant client-side `silent-turn` guards against.
    const app = getApp();
    const a = await createTestAgent(app, { type: "agent" });
    const b = await createTestAgent(app, { type: "agent" });

    const chat = await createChat(app.db, a.agent.uuid, {
      type: "group",
      participantIds: [b.agent.uuid],
    });

    const r = await sendMessage(app.db, chat.id, a.agent.uuid, {
      source: "api",
      format: "text",
      content: `@${b.agent.name} thanks`,
      metadata: { mentions: [b.agent.uuid] },
      purpose: "agent-final-text",
    });

    expect(r.recipients).toEqual([]);
    const fanRows = await app.db
      .select({ notify: inboxEntries.notify })
      .from(inboxEntries)
      .where(and(eq(inboxEntries.messageId, r.message.id), eq(inboxEntries.inboxId, b.agent.inboxId)));
    expect(fanRows.length).toBe(1);
    expect(fanRows[0]?.notify).toBe(false);
  });

  it("API integration: POST /agent/chats/:id/messages with purpose='agent-final-text' returns 201 on a group send without @", async () => {
    const app = getApp();
    const sender = await createTestAgent(app, { type: "agent" });
    const peer = await createTestAgent(app, { type: "agent" });

    const chatRes = await sender.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [peer.agent.uuid],
    });
    expect(chatRes.statusCode).toBe(201);
    const chatId = chatRes.json().id as string;

    const res = await sender.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: "this is my final text",
      purpose: "agent-final-text",
    });
    expect(res.statusCode).toBe(201);
  });

  /*
   * Unread badge propagation on `agent-final-text`.
   *
   * The original symptom (production bug, 2026-06-01): after PR #633 retired
   * implicit routing, an agent's final-text turn output stopped bumping the
   * human peer's `chat_user_state.unread_mention_count`, because the message
   * carries empty `metadata.mentions` and `chat-projection.applyAfterFanOut`
   * early-returned on `mentionedAgentIds.length === 0`. The chat list lost
   * its red dot when an agent finished a turn — the "agent done" signal
   * humans rely on.
   *
   * The fix opts the projection into a final-text-specific bump branch that
   * targets only human stakeholders:
   *   - speaker branch: human speakers in this chat (the 1:1 peer)
   *   - watcher branch: watchers whose managed agent IS the sender (the
   *     group case where the manager doesn't speak)
   * Other agent speakers are NOT bumped — final-text never wakes another
   * agent, and we don't want to pollute their unread state either.
   */
  it("bumps the human peer's unread counter in a 1:1 chat (regression for the lost red dot)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `ft1-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    await sendMessage(app.db, chatId, peer.agent.uuid, {
      source: "api",
      format: "text",
      content: "i am done — turn ended",
      purpose: "agent-final-text",
    });

    const list = await listMeChats(app.db, admin.humanAgentUuid, admin.memberId, admin.organizationId, {
      limit: 10,
      filter: "all",
      engagement: "all",
    });
    const row = list.rows.find((r) => r.chatId === chatId);
    expect(row?.unreadMentionCount).toBeGreaterThanOrEqual(1);
  });

  it("bumps the manager-watcher's unread when the watched agent emits final text in a group chat", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app);
    const { createAgent } = await import("../services/agents/identity.js");
    const managed = await createAgent(app.db, {
      name: `ftw-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Watched",
      managerId: admin.memberId,
      organizationId: admin.organizationId,
      clientId: undefined,
    });
    // Peer is owned by a different admin, so admin is a watcher of `managed`
    // only — not a speaker of this chat.
    const peer = await createTestAgent(app, { name: `ftp-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, peer.agent.uuid, peer.organizationId, {
      participantIds: [managed.uuid],
    });

    await sendMessage(app.db, chatId, managed.uuid, {
      source: "api",
      format: "text",
      content: "turn done from managed",
      purpose: "agent-final-text",
    });

    const list = await listMeChats(app.db, admin.humanAgentUuid, admin.memberId, admin.organizationId, {
      limit: 10,
      filter: "all",
      engagement: "all",
    });
    const row = list.rows.find((r) => r.chatId === chatId);
    expect(row?.unreadMentionCount).toBeGreaterThanOrEqual(1);
  });

  it("counts +1 per message even when final-text also names the human peer explicitly (no double-bump)", async () => {
    // Regression guard for the codex review point on PR #728:
    // `agent-final-text` + explicit `metadata.mentions: [human]` previously
    // hit both the final-text speaker branch AND the mention speaker
    // branch in two separate UPSERTs, incrementing the human's counter
    // twice for a single message. The UNION'd UPSERT collapses the
    // duplicate target row so the counter advances by exactly +1.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `ftd-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    await sendMessage(app.db, chatId, peer.agent.uuid, {
      source: "api",
      format: "text",
      content: "done",
      metadata: { mentions: [admin.humanAgentUuid] },
      purpose: "agent-final-text",
    });

    const list = await listMeChats(app.db, admin.humanAgentUuid, admin.memberId, admin.organizationId, {
      limit: 10,
      filter: "all",
      engagement: "all",
    });
    const row = list.rows.find((r) => r.chatId === chatId);
    expect(row?.unreadMentionCount).toBe(1);
  });

  it("does NOT bump on a human-sender send that smuggles `purpose: agent-final-text` (sender-type gate)", async () => {
    // Regression guard for the codex review point on PR #728:
    // `purpose` lives on the shared sendMessage schema, so nothing at
    // the route layer forbids a human sender from setting
    // `agent-final-text`. The unread-bump branch is gated on
    // `senderRow.type !== "human"` so a human's send never lands
    // unread-bumps on co-speakers from this code path; mention-driven
    // unread (the explicit path) is unaffected and still works.
    const app = getApp();
    const admin = await createTestAdmin(app);
    const peer = await createTestAgent(app, { name: `fth-${crypto.randomUUID().slice(0, 6)}` });

    const { chatId } = await createMeChat(app.db, admin.humanAgentUuid, admin.organizationId, {
      participantIds: [peer.agent.uuid],
    });

    // Human sends with the agent-final-text marker but NO mentions. The
    // bump should not fire because the sender is human.
    await sendMessage(app.db, chatId, admin.humanAgentUuid, {
      source: "api",
      format: "text",
      content: "human-flavoured 'final text'",
      purpose: "agent-final-text",
    });

    // Peer is an agent — query chat_user_state directly. The lazy-
    // materialised row should be absent (or 0) since neither branch
    // fired.
    const { sql } = await import("drizzle-orm");
    const rows = (await app.db.execute(
      sql`SELECT unread_mention_count FROM chat_user_state WHERE chat_id = ${chatId} AND agent_id = ${peer.agent.uuid}`,
    )) as unknown as Array<{ unread_mention_count: number }>;
    expect(rows[0]?.unread_mention_count ?? 0).toBe(0);
  });

  it("does NOT bump non-human speaker peers' unread state on final text (avoid polluting agent unread state)", async () => {
    // Two agents under one admin; admin watches both. The sender's final
    // text should bump the watcher (admin) but NOT the other agent peer.
    // Pins the narrow target set: humans + watchers-of-sender only.
    const app = getApp();
    const a = await createTestAgent(app, { name: `ftns-${crypto.randomUUID().slice(0, 6)}` });
    const { createAgent } = await import("../services/agents/identity.js");
    const b = await createAgent(app.db, {
      name: `ftnp-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Other",
      managerId: a.memberId,
      organizationId: a.organizationId,
      clientId: undefined,
    });

    const chat = await createChat(app.db, a.agent.uuid, {
      type: "group",
      participantIds: [b.uuid],
    });

    await sendMessage(app.db, chat.id, a.agent.uuid, {
      source: "api",
      format: "text",
      content: "final from a",
      purpose: "agent-final-text",
    });

    // Lookup `b`'s row directly via the chat_user_state — listMeChats is
    // user-scoped and `b` doesn't have a human-side identity, so query
    // the table directly.
    const { sql } = await import("drizzle-orm");
    const rows = (await app.db.execute(
      sql`SELECT unread_mention_count FROM chat_user_state WHERE chat_id = ${chat.id} AND agent_id = ${b.uuid}`,
    )) as unknown as Array<{ unread_mention_count: number }>;
    // Either no row (lazy-materialised, 0 by default) or a row with 0.
    expect(rows[0]?.unread_mention_count ?? 0).toBe(0);
  });

  it("API integration: same endpoint without `purpose` still rejects no-mention sends with 400 (regression)", async () => {
    // The default explicit-recipient guard applies to every chat shape (no
    // more 1:1 bypass); pick a real group here for parity with the original
    // regression scenario.
    const app = getApp();
    const sender = await createTestAgent(app, { type: "agent" });
    const peer1 = await createTestAgent(app, { type: "agent" });
    const peer2 = await createTestAgent(app, { type: "agent" });

    const chatRes = await sender.request("POST", "/api/v1/agent/chats", {
      type: "group",
      participantIds: [peer1.agent.uuid, peer2.agent.uuid],
    });
    const chatId = chatRes.json().id as string;

    const res = await sender.request("POST", `/api/v1/agent/chats/${chatId}/messages`, {
      format: "text",
      content: "this is my final text",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/explicit recipient/i);
  });
});
