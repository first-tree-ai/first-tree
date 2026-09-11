import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { clients } from "../db/schema/clients.js";
import { createAgent } from "../services/agents/identity.js";
import { createChat } from "../services/chat/conversation.js";
import { sendMessage } from "../services/chat/message.js";
import * as activityService from "../services/chat/sessions/activity.js";
import * as sessionEventService from "../services/chat/sessions/events.js";
import * as sessionService from "../services/chat/sessions/lifecycle.js";
import {
  bindAgentToClient,
  removeClientConnection,
  resolveClientReply,
  setClientConnection,
  setClientReplyTimeoutMsForTests,
} from "../services/runtime/connection-manager.js";
import { readSessionCommandRpcResult, storeSessionCommandRpcResult } from "../services/runtime/rpc/session-command.js";
import { createAdminContext, useTestApp } from "./helpers.js";

describe("Admin sessions — Suspend / Terminate (server-authoritative)", () => {
  const getApp = useTestApp();

  async function seedSession(app: FastifyInstance, agentId: string, chatId: string, state: string) {
    await app.db
      .insert(agentChatSessions)
      .values({ agentId, chatId, state })
      .onConflictDoUpdate({
        target: [agentChatSessions.agentId, agentChatSessions.chatId],
        set: { state, updatedAt: new Date() },
      });
  }

  async function readState(app: FastifyInstance, agentId: string, chatId: string): Promise<string | null> {
    const { and, eq } = await import("drizzle-orm");
    const [row] = await app.db
      .select({ state: agentChatSessions.state })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.agentId, agentId), eq(agentChatSessions.chatId, chatId)))
      .limit(1);
    return row?.state ?? null;
  }

  async function setRuntimeState(app: FastifyInstance, agentId: string, chatId: string, runtimeState: string) {
    const { and, eq } = await import("drizzle-orm");
    await app.db
      .update(agentChatSessions)
      .set({ runtimeState, runtimeStateAt: new Date() })
      .where(and(eq(agentChatSessions.agentId, agentId), eq(agentChatSessions.chatId, chatId)));
  }

  async function readRuntimeState(app: FastifyInstance, agentId: string, chatId: string): Promise<string | null> {
    const { and, eq } = await import("drizzle-orm");
    const [row] = await app.db
      .select({ runtimeState: agentChatSessions.runtimeState })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.agentId, agentId), eq(agentChatSessions.chatId, chatId)))
      .limit(1);
    return row?.runtimeState ?? null;
  }

  it("Suspend on an active row transitions to suspended and returns 200 { transitioned: true }", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `suspend-a-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `susp-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Susp target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "active");
    await setRuntimeState(app, agent.uuid, chat.id, "working");
    const runtimeNotify = vi.spyOn(app.notifier, "notifySessionRuntime");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/sessions/${chat.id}/suspend`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ state: string; transitioned: boolean; agentId: string; chatId: string }>();
    expect(body).toMatchObject({ agentId: agent.uuid, chatId: chat.id, state: "suspended", transitioned: true });

    expect(await readState(app, agent.uuid, chat.id)).toBe("suspended");
    expect(await readRuntimeState(app, agent.uuid, chat.id)).toBe("idle");
    expect(runtimeNotify).toHaveBeenCalledWith(agent.uuid, chat.id, "idle", admin.organizationId);
    runtimeNotify.mockRestore();
  });

  it("Suspend on an already-suspended row is a no-op 200 { transitioned: false }", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `suspend-b-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `susp-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Susp target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "suspended");
    await setRuntimeState(app, agent.uuid, chat.id, "working");
    const runtimeNotify = vi.spyOn(app.notifier, "notifySessionRuntime");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/sessions/${chat.id}/suspend`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: "suspended", transitioned: false });
    expect(await readRuntimeState(app, agent.uuid, chat.id)).toBe("idle");
    expect(runtimeNotify).toHaveBeenCalledWith(agent.uuid, chat.id, "idle", admin.organizationId);
    runtimeNotify.mockRestore();
  });

  it("Suspend reports delivered: true and sends session:suspend when the client is connected", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `suspend-d-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `susp-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Susp target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "active");

    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(admin.clientId, ws as unknown as WebSocket);
    bindAgentToClient(admin.clientId, agent.uuid);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/agents/${agent.uuid}/sessions/${chat.id}/suspend`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: "suspended", transitioned: true, delivered: true });
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "session:suspend", chatId: chat.id, agentId: agent.uuid }),
      );
    } finally {
      removeClientConnection(admin.clientId, ws as unknown as WebSocket);
    }
  });

  it("Suspend on a disconnected client reports delivered: false while the state still moves", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `suspend-x-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `susp-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Susp target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "active");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/sessions/${chat.id}/suspend`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: "suspended", transitioned: true, delivered: false });
    expect(await readState(app, agent.uuid, chat.id)).toBe("suspended");
  });

  it("Suspend retry on an already-suspended row re-sends the command idempotently", async () => {
    // A client that missed the first session:suspend (disconnected at the
    // time) converges through the same endpoint: the no-op retry re-sends the
    // command and reports fresh delivery.
    const app = getApp();
    const admin = await createAdminContext(app, { username: `suspend-r-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `susp-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Susp target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "suspended");
    await setRuntimeState(app, agent.uuid, chat.id, "working");

    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(admin.clientId, ws as unknown as WebSocket);
    bindAgentToClient(admin.clientId, agent.uuid);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/agents/${agent.uuid}/sessions/${chat.id}/suspend`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: "suspended", transitioned: false, delivered: true });
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "session:suspend", chatId: chat.id, agentId: agent.uuid }),
      );
    } finally {
      removeClientConnection(admin.clientId, ws as unknown as WebSocket);
    }
  });

  it("Terminate on a suspended row transitions to evicted, clears events, returns 200", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `term-a-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `term-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Term target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "suspended");
    await setRuntimeState(app, agent.uuid, chat.id, "working");
    await sessionEventService.appendEvent(app.db, agent.uuid, chat.id, {
      kind: "error",
      payload: { source: "sdk", message: "pre-terminate event" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/sessions/${chat.id}/terminate`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: "evicted", transitioned: true });

    expect(await readState(app, agent.uuid, chat.id)).toBe("evicted");
    expect(await readRuntimeState(app, agent.uuid, chat.id)).toBe("idle");

    // clearEvents is awaited before the success response, so by the time the
    // client can react (and refetch) the live trace is already gone.
    expect((await sessionEventService.listEvents(app.db, agent.uuid, chat.id, { limit: 10 })).items).toEqual([]);
  });

  it("Terminate on an active row is a no-op 200 { transitioned: false } — UI gates behind Suspend", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `term-b-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `term-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Term target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "active");

    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(admin.clientId, ws as unknown as WebSocket);
    bindAgentToClient(admin.clientId, agent.uuid);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/agents/${agent.uuid}/sessions/${chat.id}/terminate`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      // No command is required for the active no-op, so nothing is sent and
      // delivery is trivially satisfied.
      expect(res.json()).toMatchObject({ state: "active", transitioned: false, delivered: true });
      expect(ws.send).not.toHaveBeenCalled();
    } finally {
      removeClientConnection(admin.clientId, ws as unknown as WebSocket);
    }
    expect(await readState(app, agent.uuid, chat.id)).toBe("active");
  });

  it("Terminate on an errored row transitions to evicted, clears events, and notifies the client", async () => {
    // Chat-session Reset recovery path: a failed session must be terminable
    // directly (no suspend first — there is no live turn to stop). The
    // errored → evicted gate reuses the same cleanup as suspended → evicted:
    // session events cleared, `session:terminate` pushed to the client.
    const app = getApp();
    const admin = await createAdminContext(app, { username: `term-err-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `term-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Term target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "errored");
    await sessionEventService.appendEvent(app.db, agent.uuid, chat.id, {
      kind: "error",
      payload: { source: "sdk", message: "pre-terminate event" },
    });

    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(admin.clientId, ws as unknown as WebSocket);
    bindAgentToClient(admin.clientId, agent.uuid);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/agents/${agent.uuid}/sessions/${chat.id}/terminate`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: "evicted", transitioned: true, delivered: true });
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "session:terminate", chatId: chat.id, agentId: agent.uuid }),
      );
    } finally {
      removeClientConnection(admin.clientId, ws as unknown as WebSocket);
    }

    expect(await readState(app, agent.uuid, chat.id)).toBe("evicted");

    // Awaited cleanup: the live trace is gone before the success response.
    expect((await sessionEventService.listEvents(app.db, agent.uuid, chat.id, { limit: 10 })).items).toEqual([]);
  });

  it("Terminate on an already-evicted row still clears leftover events and re-sends the command (retry converges)", async () => {
    // If a previous terminate committed the evicted state but its cleanup or
    // command delivery failed, the idempotent retry path must finish both
    // rather than skip them because transitioned=false.
    const app = getApp();
    const admin = await createAdminContext(app, { username: `term-ev-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `term-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Term target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "evicted");
    await sessionEventService.appendEvent(app.db, agent.uuid, chat.id, {
      kind: "error",
      payload: { source: "sdk", message: "leftover event" },
    });

    const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
    setClientConnection(admin.clientId, ws as unknown as WebSocket);
    bindAgentToClient(admin.clientId, agent.uuid);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/agents/${agent.uuid}/sessions/${chat.id}/terminate`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: "evicted", transitioned: false, delivered: true });
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "session:terminate", chatId: chat.id, agentId: agent.uuid }),
      );
    } finally {
      removeClientConnection(admin.clientId, ws as unknown as WebSocket);
    }
    expect((await sessionEventService.listEvents(app.db, agent.uuid, chat.id, { limit: 10 })).items).toEqual([]);
  });

  it("Terminate on a disconnected client reports delivered: false but still evicts and clears events", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `term-dc-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `term-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Term target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "suspended");
    await sessionEventService.appendEvent(app.db, agent.uuid, chat.id, {
      kind: "error",
      payload: { source: "sdk", message: "pre-terminate event" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/sessions/${chat.id}/terminate`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: "evicted", transitioned: true, delivered: false });
    expect(await readState(app, agent.uuid, chat.id)).toBe("evicted");
    expect((await sessionEventService.listEvents(app.db, agent.uuid, chat.id, { limit: 10 })).items).toEqual([]);
  });

  it("a successful terminate leaves the trace permanently empty — pre-terminate events cleared, post-evict events dropped", async () => {
    // The full reset trace contract through the real HTTP route:
    //  1. an event that arrived BEFORE terminate is removed by the awaited
    //     cleanup (the success response only fires after the delete commits);
    //  2. a late event arriving AFTER eviction (old turn racing the terminate
    //     command) is dropped at persistence and never recreates the trace;
    //  3. the trace is still empty after the success response, when the Web
    //     refetch of chat-session-events runs.
    const app = getApp();
    const admin = await createAdminContext(app, { username: `trace-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `trace-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Trace target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "suspended");
    await sessionEventService.appendLiveEvent(app.db, agent.uuid, chat.id, {
      kind: "error",
      payload: { source: "sdk", message: "pre-terminate event" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/sessions/${chat.id}/terminate`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: "evicted", transitioned: true });
    // (1) holds at response time — no polling.
    expect((await sessionEventService.listEvents(app.db, agent.uuid, chat.id, { limit: 10 })).items).toEqual([]);

    // (2) a late frame from the terminated turn is rejected by the gate.
    const late = await sessionEventService.appendLiveEvent(app.db, agent.uuid, chat.id, {
      kind: "assistant_text",
      payload: { text: "late output from the old turn" },
    });
    expect(late).toBeNull();

    // (3) the post-success refetch still sees an empty trace.
    expect((await sessionEventService.listEvents(app.db, agent.uuid, chat.id, { limit: 10 })).items).toEqual([]);
  });

  it("appendLiveEvent drops events for an evicted session but accepts them on a live one", async () => {
    // The late-event guard behind terminate: once the row is evicted, a stale
    // producer can never recreate the cleared trace; a live session is
    // unaffected. The check is serialized against the transition via the
    // session row lock (see appendLiveEvent).
    const app = getApp();
    const admin = await createAdminContext(app, { username: `gate-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `gate-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Gate target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    const event = { kind: "error", payload: { source: "sdk", message: "frame" } } as const;

    await seedSession(app, agent.uuid, chat.id, "active");
    const live = await sessionEventService.appendLiveEvent(app.db, agent.uuid, chat.id, event);
    expect(live).not.toBeNull();
    expect(live?.payload).toMatchObject({ message: "frame" });

    await seedSession(app, agent.uuid, chat.id, "evicted");
    const dropped = await sessionEventService.appendLiveEvent(app.db, agent.uuid, chat.id, event);
    expect(dropped).toBeNull();
    expect(
      (await sessionEventService.listEvents(app.db, agent.uuid, chat.id, { limit: 10 })).items.map((i) => i.seq),
    ).toEqual([live?.seq]);
  });

  it("Terminate on an already-evicted row is idempotent 200 { transitioned: false }", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `term-c-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `term-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Term target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "evicted");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/sessions/${chat.id}/terminate`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: "evicted", transitioned: false });
  });

  it("Suspend on a missing chat returns 404", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `term-d-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `term-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Term target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/sessions/chat-does-not-exist/suspend`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("Resume on a disconnected suspended row fails delivery and leaves the row suspended", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `resume-x-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `resume-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Resume target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "suspended");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/sessions/${chat.id}/resume`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(res.statusCode).toBe(503);
    expect(await readState(app, agent.uuid, chat.id)).toBe("suspended");
  });

  it("Resume command delivery does not mark active before the client reports session state", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `resume-y-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `resume-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Resume target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "suspended");

    const ws = {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
    };
    setClientConnection(admin.clientId, ws as unknown as WebSocket);
    bindAgentToClient(admin.clientId, agent.uuid);
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/agents/${agent.uuid}/sessions/${chat.id}/resume`,
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: "suspended", transitioned: false });
      expect(ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "session:resume", chatId: chat.id, agentId: agent.uuid }),
      );
      expect(await readState(app, agent.uuid, chat.id)).toBe("suspended");
    } finally {
      removeClientConnection(admin.clientId, ws as unknown as WebSocket);
    }
  });

  it("allows an evicted row to be overwritten when the client starts a fresh runtime session", async () => {
    // `agent_chat_sessions.(agent_id, chat_id)` is a single-row "current
    // session state" cache, NOT a session history log. After terminate the
    // chat keeps its stable chat_id; the next inbound message legitimately
    // produces a new runtime session whose
    // `active` state MUST overwrite the terminal `evicted` row, otherwise
    // the chat becomes invisible in web listings forever even though it is
    // still functional. Pinning this behaviour so the pre-refactor
    // "revival defense" does not sneak back in.
    const app = getApp();
    const admin = await createAdminContext(app, { username: `revive-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `revive-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Revive target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "evicted");

    // Client reports `active` because a new runtime session just started.
    await activityService.upsertSessionState(app.db, agent.uuid, chat.id, "active", "org-test");

    expect(await readState(app, agent.uuid, chat.id)).toBe("active");
  });

  it("suspended → active upsert still works (non-terminal transitions are unaffected)", async () => {
    // Guards against over-correction: removing the revival defense must not
    // accidentally block legit suspend→active transitions that were already
    // supported.
    const app = getApp();
    const admin = await createAdminContext(app, { username: `susp-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `susp-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Suspend target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, "suspended");

    await activityService.upsertSessionState(app.db, agent.uuid, chat.id, "active", "org-test");

    expect(await readState(app, agent.uuid, chat.id)).toBe("active");
  });

  it("default listing hides evicted rows; explicit ?state=evicted still returns them", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `list-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `list-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "List target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chatActive = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    const chatEvicted = await createChat(app.db, admin.humanAgentUuid, {
      type: "group",
      participantIds: [agent.uuid],
    });
    await seedSession(app, agent.uuid, chatActive.id, "active");
    await seedSession(app, agent.uuid, chatEvicted.id, "evicted");

    const defaultRes = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agent.uuid}/sessions`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(defaultRes.statusCode).toBe(200);
    const defaultChats = defaultRes.json<Array<{ chatId: string; state: string }>>().map((r) => r.chatId);
    expect(defaultChats).toContain(chatActive.id);
    expect(defaultChats).not.toContain(chatEvicted.id);

    const filteredRes = await app.inject({
      method: "GET",
      url: `/api/v1/agents/${agent.uuid}/sessions?state=evicted`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
    expect(filteredRes.statusCode).toBe(200);
    const filteredChats = filteredRes.json<Array<{ chatId: string; state: string }>>().map((r) => r.chatId);
    expect(filteredChats).toContain(chatEvicted.id);
  });

  it("archive vs sendMessage race always resolves to active (sendMessage wins via archive's conservative gate, R3)", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `race-${crypto.randomUUID().slice(0, 6)}` });
    const sender = await createAgent(app.db, {
      name: `race-snd-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Race sender",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const targetName = `race-tgt-${crypto.randomUUID().slice(0, 6)}`;
    const target = await createAgent(app.db, {
      name: targetName,
      type: "agent",
      displayName: "Race target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, {
      type: "group",
      participantIds: [sender.uuid, target.uuid],
    });
    await seedSession(app, target.uuid, chat.id, "suspended");

    // Concurrently fire archive (suspended → evicted, gated by from=['suspended'])
    // and sendMessage (any → active via upsertSessionState, unconditional).
    // Both touch the same agent_chat_sessions row, so PG row-level locks
    // serialize them. Either commit order resolves to active:
    //
    // - archive first → state becomes 'evicted'; the upsert then unconditionally
    //   overrides → 'active'.
    // - upsert first → state becomes 'active'; archive then sees 'active' which
    //   is NOT in its `from=['suspended']` gate, so it becomes a no-op
    //   (transitioned=false).
    //
    // sendMessage always wins, due to archive's conservative gate.
    //
    // The predictive session-activation path fires only for notify=true
    // recipients (`metadata.mentions` or `addressedToAgentIds`); declare
    // the target explicitly so the race semantics are exercised.
    await Promise.all([
      sessionService.archiveSession(app.db, target.uuid, chat.id, admin.organizationId, app.notifier),
      sendMessage(app.db, chat.id, sender.uuid, {
        source: "api",
        format: "text",
        content: `race @${targetName}`,
        metadata: { mentions: [target.uuid] },
      }),
    ]);

    expect(await readState(app, target.uuid, chat.id)).toBe("active");
  });
});

describe("Terminate with apply-ack (?waitForApply=true) — the Web Reset path", () => {
  const getApp = useTestApp();

  async function seedSession(app: FastifyInstance, agentId: string, chatId: string, state: string) {
    await app.db
      .insert(agentChatSessions)
      .values({ agentId, chatId, state })
      .onConflictDoUpdate({
        target: [agentChatSessions.agentId, agentChatSessions.chatId],
        set: { state, updatedAt: new Date() },
      });
  }

  async function readState(app: FastifyInstance, agentId: string, chatId: string): Promise<string | null> {
    const { and, eq } = await import("drizzle-orm");
    const [row] = await app.db
      .select({ state: agentChatSessions.state })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.agentId, agentId), eq(agentChatSessions.chatId, chatId)))
      .limit(1);
    return row?.state ?? null;
  }

  async function setRuntimeState(app: FastifyInstance, agentId: string, chatId: string, runtimeState: string) {
    const { and, eq } = await import("drizzle-orm");
    await app.db
      .update(agentChatSessions)
      .set({ runtimeState, runtimeStateAt: new Date() })
      .where(and(eq(agentChatSessions.agentId, agentId), eq(agentChatSessions.chatId, chatId)));
  }

  async function readRuntimeState(app: FastifyInstance, agentId: string, chatId: string): Promise<string | null> {
    const { and, eq } = await import("drizzle-orm");
    const [row] = await app.db
      .select({ runtimeState: agentChatSessions.runtimeState })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.agentId, agentId), eq(agentChatSessions.chatId, chatId)))
      .limit(1);
    return row?.runtimeState ?? null;
  }

  const LOCAL_INSTANCE = "test-instance";
  const REMOTE_INSTANCE = "remote-instance";

  /**
   * How the fake client answers a post-apply disposition
   * (`session:command:finalized` / `session:command:aborted`):
   * `"released"` — immediate receipt (compliant client);
   * `"refused"` — receipt saying the ref was not the armed generation;
   * `"durable"` — receipt persisted but the wake is lost;
   * `"drop"` — nothing comes back at all.
   */
  type FinalizeReceiptMode = "released" | "refused" | "durable" | "drop";

  /** One post-apply disposition frame the route delivered, as the client saw it. */
  type ObservedDisposition = {
    phase: "finalized" | "aborted";
    ref: string;
    ackRef: string;
    reason?: string;
  };

  /**
   * A fake daemon socket that answers BOTH post-apply dispositions the way a
   * compliant client does, so a Reset request can complete past
   * `finalizeTerminatedSession` and — just as importantly — so a Reset that
   * cannot finalize still gets its abort receipted instead of stalling on the
   * disposition waiter. `dispositions` records what actually arrived, in order.
   */
  function makeFakeClientSocket(
    app: FastifyInstance,
    clientId: string,
    finalizeReceipt: FinalizeReceiptMode = "released",
  ) {
    const dispositions: ObservedDisposition[] = [];
    return {
      readyState: 1,
      dispositions,
      send: vi.fn((raw: string) => {
        let frame: {
          type?: string;
          ref?: string;
          ackRef?: string;
          agentId?: string;
          chatId?: string;
          reason?: string;
        };
        try {
          frame = JSON.parse(raw) as typeof frame;
        } catch {
          return;
        }
        const phase =
          frame.type === "session:command:finalized"
            ? ("finalized" as const)
            : frame.type === "session:command:aborted"
              ? ("aborted" as const)
              : null;
        if (!phase || !frame.ackRef) return;
        dispositions.push({ phase, ref: String(frame.ref ?? ""), ackRef: frame.ackRef, reason: frame.reason });
        if (finalizeReceipt === "drop") return;
        const receipt = {
          command: "session:terminate" as const,
          agentId: frame.agentId as string,
          chatId: frame.chatId as string,
          applied: finalizeReceipt !== "refused",
          phase,
        };
        if (finalizeReceipt === "durable") {
          void storeSessionCommandRpcResult(app.db, clientId, frame.ackRef, receipt, LOCAL_INSTANCE);
          return;
        }
        resolveClientReply(clientId, frame.ackRef, receipt);
      }),
      close: vi.fn(),
    };
  }

  /**
   * Seed the DB-authoritative client route the waitForApply preflight reads:
   * `clients` row (status + owning instance + registered wireCapabilities)
   * and the agent's presence route. `remote: true` points the owning
   * instance at another replica so the route must fan the command out.
   */
  async function setup(
    state: string,
    opts: {
      capable?: boolean;
      connected?: boolean;
      remote?: boolean;
      localSocket?: boolean;
      finalizeReceipt?: FinalizeReceiptMode;
    } = {},
  ) {
    const app = getApp();
    const { capable = true, connected = true, remote = false, localSocket = true, finalizeReceipt = "released" } = opts;
    const admin = await createAdminContext(app, { username: `apply-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `apply-agent-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Apply target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await seedSession(app, agent.uuid, chat.id, state);

    const instanceId = remote ? REMOTE_INSTANCE : LOCAL_INSTANCE;
    const { eq } = await import("drizzle-orm");
    await app.db
      .update(clients)
      .set({
        status: connected ? "connected" : "disconnected",
        instanceId: connected ? instanceId : null,
        metadata: {
          wireCapabilities: capable ? { wsSessionResetV1: true } : {},
        },
      })
      .where(eq(clients.id, admin.clientId));
    await app.db
      .insert(agentPresence)
      .values({
        agentId: agent.uuid,
        status: "online",
        clientId: admin.clientId,
        instanceId,
        runtimeState: "idle",
      })
      .onConflictDoUpdate({
        target: agentPresence.agentId,
        set: { status: "online", clientId: admin.clientId, instanceId, runtimeState: "idle" },
      });

    const ws = makeFakeClientSocket(app, admin.clientId, finalizeReceipt);
    if (localSocket) {
      setClientConnection(admin.clientId, ws as unknown as WebSocket, { wsSessionResetV1: true });
      bindAgentToClient(admin.clientId, agent.uuid);
    }
    return { app, admin, agent, chat, ws };
  }

  function terminateReq(app: FastifyInstance, admin: { accessToken: string }, agentId: string, chatId: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/agents/${agentId}/sessions/${chatId}/terminate?waitForApply=true`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
    });
  }

  /** Wait until the route sent the ref'd command, then ack it through the reply channel. */
  async function ackSentCommand(
    ws: { send: ReturnType<typeof vi.fn> },
    clientId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<void> {
    await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
    const frame = JSON.parse(ws.send.mock.calls[0]?.[0] as string) as { ref: string; agentId: string; chatId: string };
    const resolved = resolveClientReply(clientId, frame.ref, {
      command: "session:terminate",
      agentId: frame.agentId,
      chatId: frame.chatId,
      applied: true,
      ...overrides,
    });
    expect(resolved).toBe(true);
  }

  function cleanup(admin: { clientId: string }, ws: unknown) {
    removeClientConnection(admin.clientId, ws as unknown as WebSocket);
  }

  it("holds the request until the ack, then atomically evicts and clears events", async () => {
    const { app, admin, agent, chat, ws } = await setup("suspended");
    await setRuntimeState(app, agent.uuid, chat.id, "working");
    await sessionEventService.appendEvent(app.db, agent.uuid, chat.id, {
      kind: "error",
      payload: { source: "sdk", message: "pre-reset event" },
    });

    try {
      const pending = terminateReq(app, admin, agent.uuid, chat.id);
      // The command goes out with a ref; the HTTP request is still in flight.
      await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
      const frame = JSON.parse(ws.send.mock.calls[0]?.[0] as string);
      expect(frame).toMatchObject({ type: "session:terminate", chatId: chat.id, agentId: agent.uuid });
      expect(typeof frame.ref).toBe("string");
      expect(await readState(app, agent.uuid, chat.id)).toBe("suspended");

      await ackSentCommand(ws, admin.clientId);
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: "evicted", transitioned: true, delivered: true, applied: true });
      expect(await readState(app, agent.uuid, chat.id)).toBe("evicted");
      expect(await readRuntimeState(app, agent.uuid, chat.id)).toBe("idle");
      // Cleanup committed with the transition — no polling.
      expect((await sessionEventService.listEvents(app.db, agent.uuid, chat.id, { limit: 10 })).items).toEqual([]);
    } finally {
      cleanup(admin, ws);
    }
  });

  it("accepts an errored session (failed sessions reset directly)", async () => {
    const { app, admin, agent, chat, ws } = await setup("errored");
    try {
      const pending = terminateReq(app, admin, agent.uuid, chat.id);
      await ackSentCommand(ws, admin.clientId);
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: "evicted", applied: true });
    } finally {
      cleanup(admin, ws);
    }
  });

  it("rejects an active session with 409 before any route check or command", async () => {
    const { app, admin, agent, chat, ws } = await setup("active");
    try {
      const res = await terminateReq(app, admin, agent.uuid, chat.id);
      expect(res.statusCode).toBe(409);
      expect(ws.send).not.toHaveBeenCalled();
      expect(await readState(app, agent.uuid, chat.id)).toBe("active");
    } finally {
      cleanup(admin, ws);
    }
  });

  it("an evicted row still re-runs the acknowledged terminate — a legacy eviction is not proof", async () => {
    // The row was evicted by the legacy fire-and-forget path and that command
    // was lost, so the client may still hold the provider mapping. The
    // waitForApply path must NOT fast-path success: it re-sends a ref'd
    // terminate, waits for a real ack, and only then reports evicted.
    const { app, admin, agent, chat, ws } = await setup("evicted");
    await setRuntimeState(app, agent.uuid, chat.id, "working");
    await sessionEventService.appendEvent(app.db, agent.uuid, chat.id, {
      kind: "error",
      payload: { source: "sdk", message: "leftover trace" },
    });
    const notifySpy = vi.spyOn(app.notifier, "notifySessionStateChange");
    const runtimeNotifySpy = vi.spyOn(app.notifier, "notifySessionRuntime");
    try {
      const pending = terminateReq(app, admin, agent.uuid, chat.id);
      await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
      // No success before the ack even though the row was already evicted.
      expect(await readState(app, agent.uuid, chat.id)).toBe("evicted");
      await ackSentCommand(ws, admin.clientId);
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: "evicted", transitioned: false, applied: true });
      expect(await readRuntimeState(app, agent.uuid, chat.id)).toBe("idle");
      // The idempotent finalize re-cleared the leftover trace.
      expect((await sessionEventService.listEvents(app.db, agent.uuid, chat.id, { limit: 10 })).items).toEqual([]);
      // …and still broadcast the eviction so every other open viewer drops
      // the stale trace from its event cache (no polling floor on it).
      await vi.waitFor(() =>
        expect(notifySpy).toHaveBeenCalledWith(agent.uuid, chat.id, "evicted", admin.organizationId),
      );
      expect(runtimeNotifySpy).toHaveBeenCalledWith(agent.uuid, chat.id, "idle", admin.organizationId);
    } finally {
      notifySpy.mockRestore();
      runtimeNotifySpy.mockRestore();
      cleanup(admin, ws);
    }
  });

  it("an evicted row produced by archiveAllSessionsForAgent also requires a fresh ack", async () => {
    const { app, admin, agent, chat, ws } = await setup("suspended");
    // Runtime-switch style eviction: no apply-ack was ever involved.
    await setRuntimeState(app, agent.uuid, chat.id, "working");
    await sessionService.archiveAllSessionsForAgent(app.db, agent.uuid, admin.organizationId, app.notifier);
    expect(await readState(app, agent.uuid, chat.id)).toBe("evicted");
    expect(await readRuntimeState(app, agent.uuid, chat.id)).toBe("idle");
    try {
      const pending = terminateReq(app, admin, agent.uuid, chat.id);
      await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
      await ackSentCommand(ws, admin.clientId);
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: "evicted", applied: true });
    } finally {
      cleanup(admin, ws);
    }
  });

  it("fans the command out to the owning replica and resolves via the durable ack wake", async () => {
    // HTTP lands on a replica that does NOT own the daemon socket: the route
    // publishes daemon_client_commands, the owner persists the ack, and the
    // result wake resolves the local HTTP waiter.
    const { app, admin, agent, chat } = await setup("suspended", { remote: true, localSocket: false });
    const notifySpy = vi.spyOn(app.notifier, "notifyDaemonClientCommand");
    try {
      const pending = terminateReq(app, admin, agent.uuid, chat.id);
      await vi.waitFor(() => expect(notifySpy).toHaveBeenCalled());
      const payload = notifySpy.mock.calls[0]?.[0] as {
        type: string;
        clientId: string;
        agentId?: string;
        chatId?: string;
        ref: string;
        targetInstanceId: string;
      };
      expect(payload).toMatchObject({
        type: "session:terminate",
        clientId: admin.clientId,
        agentId: agent.uuid,
        chatId: chat.id,
        targetInstanceId: REMOTE_INSTANCE,
      });
      expect(await readState(app, agent.uuid, chat.id)).toBe("suspended");

      // The owning replica applies the command and makes the ack durable.
      await storeSessionCommandRpcResult(
        app.db,
        admin.clientId,
        payload.ref,
        { command: "session:terminate", agentId: agent.uuid, chatId: chat.id, applied: true },
        REMOTE_INSTANCE,
      );
      await app.notifier.notifyDaemonClientCommandResult({ clientId: admin.clientId, ref: payload.ref });

      // The post-finalize signal takes the SAME exact route — never a local
      // send attempt — and carries its own rendezvous ref for the receipt.
      await vi.waitFor(() => expect(notifySpy).toHaveBeenCalledTimes(2));
      const finalizedPayload = notifySpy.mock.calls[1]?.[0] as {
        type: string;
        clientId: string;
        agentId?: string;
        chatId?: string;
        ref: string;
        ackRef?: string;
        targetInstanceId: string;
      };
      expect(finalizedPayload).toMatchObject({
        type: "session:command:finalized",
        clientId: admin.clientId,
        agentId: agent.uuid,
        chatId: chat.id,
        ref: payload.ref,
        targetInstanceId: REMOTE_INSTANCE,
      });
      expect(finalizedPayload.ackRef).not.toBe(payload.ref);
      await storeSessionCommandRpcResult(
        app.db,
        admin.clientId,
        finalizedPayload.ackRef as string,
        { command: "session:terminate", agentId: agent.uuid, chatId: chat.id, applied: true, phase: "finalized" },
        REMOTE_INSTANCE,
      );
      await app.notifier.notifyDaemonClientCommandResult({
        clientId: admin.clientId,
        ref: finalizedPayload.ackRef as string,
      });

      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: "evicted", transitioned: true, applied: true });
    } finally {
      notifySpy.mockRestore();
    }
  });

  it("falls back to the durable ack when the result wake is lost", async () => {
    const { app, admin, agent, chat, ws } = await setup("suspended");
    setClientReplyTimeoutMsForTests(50);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let resolveSent: ((frame: { ref: string }) => void) | undefined;
      const sent = new Promise<{ ref: string }>((resolve) => {
        resolveSent = resolve;
      });
      ws.send.mockImplementationOnce((raw: string) => {
        resolveSent?.(JSON.parse(raw) as { ref: string });
      });

      const pending = terminateReq(app, admin, agent.uuid, chat.id);
      const frame = await sent;
      // The ack lands durable but the NOTIFY wake is lost (not sent); the
      // waiter will time out and the route must read the durable copy once
      // before failing.
      expect(
        await storeSessionCommandRpcResult(
          app.db,
          admin.clientId,
          frame.ref,
          { command: "session:terminate", agentId: agent.uuid, chatId: chat.id, applied: true },
          LOCAL_INSTANCE,
        ),
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(50);
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: "evicted", applied: true });
    } finally {
      vi.useRealTimers();
      setClientReplyTimeoutMsForTests(null);
      cleanup(admin, ws);
    }
  });

  it("fails 503 when the presence route instance does not match the connected client's instance", async () => {
    // Presence and the client row must agree on the owning instance — a
    // stale presence route must not reach a capable verdict.
    const { app, admin, agent, chat, ws } = await setup("suspended");
    const { eq } = await import("drizzle-orm");
    await app.db
      .update(agentPresence)
      .set({ instanceId: "some-other-instance" })
      .where(eq(agentPresence.agentId, agent.uuid));
    try {
      const res = await terminateReq(app, admin, agent.uuid, chat.id);
      expect(res.statusCode).toBe(503);
      expect(ws.send).not.toHaveBeenCalled();
      expect(await readState(app, agent.uuid, chat.id)).toBe("suspended");
    } finally {
      cleanup(admin, ws);
    }
  });

  it("fails 503 without touching the DB when the client lacks the apply-ack capability", async () => {
    const { app, admin, agent, chat, ws } = await setup("suspended", { capable: false });
    try {
      const res = await terminateReq(app, admin, agent.uuid, chat.id);
      expect(res.statusCode).toBe(503);
      expect(ws.send).not.toHaveBeenCalled();
      expect(await readState(app, agent.uuid, chat.id)).toBe("suspended");
    } finally {
      cleanup(admin, ws);
    }
  });

  it("fails 503 when the client route is disconnected", async () => {
    const { app, admin, agent, chat, ws } = await setup("suspended", { connected: false });
    try {
      const res = await terminateReq(app, admin, agent.uuid, chat.id);
      expect(res.statusCode).toBe(503);
      expect(await readState(app, agent.uuid, chat.id)).toBe("suspended");
    } finally {
      cleanup(admin, ws);
    }
  });

  it("applied:false fails the request and leaves the stopped session untouched", async () => {
    const { app, admin, agent, chat, ws } = await setup("suspended");
    await sessionEventService.appendEvent(app.db, agent.uuid, chat.id, {
      kind: "error",
      payload: { source: "sdk", message: "still here" },
    });
    try {
      const pending = terminateReq(app, admin, agent.uuid, chat.id);
      await ackSentCommand(ws, admin.clientId, { applied: false });
      const res = await pending;
      expect(res.statusCode).toBe(503);
      expect(await readState(app, agent.uuid, chat.id)).toBe("suspended");
      expect((await sessionEventService.listEvents(app.db, agent.uuid, chat.id, { limit: 10 })).items).toHaveLength(1);
    } finally {
      cleanup(admin, ws);
    }
  });

  it("an ack with mismatched chat/agent/command cannot resolve the wait", async () => {
    const { app, admin, agent, chat, ws } = await setup("suspended");
    try {
      const pending = terminateReq(app, admin, agent.uuid, chat.id);
      await ackSentCommand(ws, admin.clientId, { chatId: "some-other-chat" });
      const res = await pending;
      expect(res.statusCode).toBe(503);
      expect(await readState(app, agent.uuid, chat.id)).toBe("suspended");
    } finally {
      cleanup(admin, ws);
    }
  });

  it("a disconnect while waiting rejects the request and frees the waiter", async () => {
    const { app, admin, agent, chat, ws } = await setup("suspended");
    const pending = terminateReq(app, admin, agent.uuid, chat.id);
    await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
    const frame = JSON.parse(ws.send.mock.calls[0]?.[0] as string) as { ref: string };
    // Socket dies before the client processes the command.
    removeClientConnection(admin.clientId, ws as unknown as WebSocket);
    const res = await pending;
    expect(res.statusCode).toBe(503);
    expect(await readState(app, agent.uuid, chat.id)).toBe("suspended");
    // The waiter was released — a late ack resolves nothing.
    expect(resolveClientReply(admin.clientId, frame.ref, { applied: true })).toBe(false);
  });

  it("a slow/no ack times out without a waiter leak", async () => {
    const { app, admin, agent, chat, ws } = await setup("suspended");
    setClientReplyTimeoutMsForTests(50);
    try {
      const pending = terminateReq(app, admin, agent.uuid, chat.id);
      await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
      const frame = JSON.parse(ws.send.mock.calls[0]?.[0] as string) as { ref: string };
      const res = await pending;
      expect(res.statusCode).toBe(503);
      expect(await readState(app, agent.uuid, chat.id)).toBe("suspended");
      expect(resolveClientReply(admin.clientId, frame.ref, { applied: true })).toBe(false);
    } finally {
      setClientReplyTimeoutMsForTests(null);
      cleanup(admin, ws);
    }
  });

  it("a route change after the ack prevents finalize — no evict, no clear, no success", async () => {
    // The ack was legitimately issued for the preflight route, but the agent
    // was rebound before it arrived. The in-transaction revalidation must
    // stop the eviction rather than clear a session on the new route.
    const { app, admin, agent, chat, ws } = await setup("suspended");
    await sessionEventService.appendEvent(app.db, agent.uuid, chat.id, {
      kind: "error",
      payload: { source: "sdk", message: "must survive" },
    });
    try {
      const pending = terminateReq(app, admin, agent.uuid, chat.id);
      await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
      // Rebind the agent elsewhere before the ack lands.
      const { eq } = await import("drizzle-orm");
      await app.db.update(agentPresence).set({ instanceId: "elsewhere" }).where(eq(agentPresence.agentId, agent.uuid));
      await ackSentCommand(ws, admin.clientId);
      const res = await pending;
      expect(res.statusCode).toBe(409);
      expect(await readState(app, agent.uuid, chat.id)).toBe("suspended");
      expect((await sessionEventService.listEvents(app.db, agent.uuid, chat.id, { limit: 10 })).items).toHaveLength(1);
    } finally {
      cleanup(admin, ws);
    }
  });

  it("the durable ack store refuses to persist when the agent route moved", async () => {
    const { app, admin, agent, chat } = await setup("suspended");
    const { eq } = await import("drizzle-orm");
    // Route moved to another instance after the preflight.
    await app.db.update(agentPresence).set({ instanceId: "elsewhere" }).where(eq(agentPresence.agentId, agent.uuid));
    const ref = crypto.randomUUID();
    const stored = await storeSessionCommandRpcResult(
      app.db,
      admin.clientId,
      ref,
      { command: "session:terminate", agentId: agent.uuid, chatId: chat.id, applied: true },
      LOCAL_INSTANCE,
    );
    expect(stored).toBe(false);
    const { readSessionCommandRpcResult } = await import("../services/runtime/rpc/session-command.js");
    expect(await readSessionCommandRpcResult(app.db, admin.clientId, ref)).toBeNull();
  });

  it("a session re-activated while waiting for the ack conflicts without evicting or clearing", async () => {
    const { app, admin, agent, chat, ws } = await setup("suspended");
    await sessionEventService.appendEvent(app.db, agent.uuid, chat.id, {
      kind: "error",
      payload: { source: "sdk", message: "new turn trace" },
    });
    try {
      const pending = terminateReq(app, admin, agent.uuid, chat.id);
      await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
      const terminateRef = (JSON.parse(ws.send.mock.calls[0]?.[0] as string) as { ref: string }).ref;
      // A new addressed message re-activates the session before the ack lands.
      await activityService.upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId);
      await ackSentCommand(ws, admin.clientId);
      const res = await pending;
      expect(res.statusCode).toBe(409);
      expect(await readState(app, agent.uuid, chat.id)).toBe("active");
      expect((await sessionEventService.listEvents(app.db, agent.uuid, chat.id, { limit: 10 })).items).toHaveLength(1);

      // The client TRUTHFULLY applied before this conflict, so its Reset
      // generation is armed and only an exact receipted disposition can lift
      // it. Answering 409 without one would leave the chat fenced forever.
      // The frame carries the terminate ref (so the client can scope the
      // release) on a separate rendezvous ref (so a late apply-ack wake cannot
      // settle it), and the request only resolved because the receipt landed —
      // a dropped receipt fails the request closed instead (see below).
      expect(ws.dispositions).toEqual([
        { phase: "aborted", ref: terminateRef, ackRef: expect.any(String), reason: "reactivated" },
      ]);
      expect(ws.dispositions[0]?.ackRef).not.toBe(terminateRef);
      // Aborting lifts the generation only — it must not resurrect the Reset or
      // disturb the fresh session's state or trace.
      expect(await readState(app, agent.uuid, chat.id)).toBe("active");
      expect((await sessionEventService.listEvents(app.db, agent.uuid, chat.id, { limit: 10 })).items).toHaveLength(1);
    } finally {
      cleanup(admin, ws);
    }
  });

  it("aborts to the ORIGINAL applying client when the agent route moved after the apply", async () => {
    // The finalize transaction refuses to evict against a moved route (409).
    // The abort that follows is addressed by the applying client's identity,
    // not the agent's current route — the replacement client never applied
    // anything and holds no generation to lift, so redirecting there would both
    // lie to it and strand the client that really is fenced.
    const { app, admin, agent, chat, ws } = await setup("suspended");
    const notifySpy = vi.spyOn(app.notifier, "notifyDaemonClientCommand");
    const replacement = makeFakeClientSocket(app, "cli-replacement");
    setClientConnection("cli-replacement", replacement as unknown as WebSocket, { wsSessionResetV1: true });
    try {
      const pending = terminateReq(app, admin, agent.uuid, chat.id);
      await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
      const terminateRef = (JSON.parse(ws.send.mock.calls[0]?.[0] as string) as { ref: string }).ref;
      // Rebind the agent elsewhere, both in the DB route and process-locally,
      // before the ack lands.
      const { eq } = await import("drizzle-orm");
      await app.db.update(agentPresence).set({ instanceId: "elsewhere" }).where(eq(agentPresence.agentId, agent.uuid));
      await ackSentCommand(ws, admin.clientId);
      bindAgentToClient("cli-replacement", agent.uuid);
      const res = await pending;
      expect(res.statusCode).toBe(409);
      expect(await readState(app, agent.uuid, chat.id)).toBe("suspended");

      expect(ws.dispositions).toEqual([
        { phase: "aborted", ref: terminateRef, ackRef: expect.any(String), reason: "route_refused" },
      ]);
      // Never redirected to the replacement, and never fanned out blindly.
      expect(replacement.dispositions).toEqual([]);
      expect(notifySpy).not.toHaveBeenCalled();
    } finally {
      notifySpy.mockRestore();
      cleanup({ clientId: "cli-replacement" }, replacement);
      cleanup(admin, ws);
    }
  });

  it("fails closed when the applied Reset cannot be finalized AND its abort is never receipted", async () => {
    // The honest end state: the Reset did not happen and the client may still
    // be fenced. Reporting the plain conflict here would hide the worse half.
    const { app, admin, agent, chat, ws } = await setup("suspended", { finalizeReceipt: "drop" });
    setClientReplyTimeoutMsForTests(80);
    try {
      const pending = terminateReq(app, admin, agent.uuid, chat.id);
      await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
      await activityService.upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId);
      await ackSentCommand(ws, admin.clientId);
      const res = await pending;
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toContain("was not reset");
      // The abort was attempted exactly once and nothing was evicted.
      expect(ws.dispositions.map((entry) => entry.phase)).toEqual(["aborted"]);
      expect(await readState(app, agent.uuid, chat.id)).toBe("active");
    } finally {
      setClientReplyTimeoutMsForTests(null);
      cleanup(admin, ws);
    }
  });

  it("fails 503 for a client without the composite Reset capability", async () => {
    const { app, admin, agent, chat, ws } = await setup("suspended", { capable: false });
    try {
      const res = await terminateReq(app, admin, agent.uuid, chat.id);
      expect(res.statusCode).toBe(503);
      expect(ws.send).not.toHaveBeenCalled();
      expect(await readState(app, agent.uuid, chat.id)).toBe("suspended");
    } finally {
      cleanup(admin, ws);
    }
  });

  it("fails 503 without sending when the same client reconnected as a legacy build after the preflight", async () => {
    // The preflight's capability verdict is a DB snapshot. `client:register`
    // replaces `wireCapabilities` wholesale, so the SAME clientId on the SAME
    // instance can come back without v1 between preflight and send — identity
    // checks alone still pass. Such a client would destroy its provider
    // session on the terminate and then never answer the finalize, so no
    // destructive frame may go out at all.
    const { app, admin, agent, chat, ws } = await setup("suspended");
    await sessionEventService.appendEvent(app.db, agent.uuid, chat.id, {
      kind: "error",
      payload: { source: "sdk", message: "must survive" },
    });
    const legacyWs = makeFakeClientSocket(app, admin.clientId);
    setClientConnection(admin.clientId, legacyWs as unknown as WebSocket, {});
    bindAgentToClient(admin.clientId, agent.uuid);
    // A regression here sends the frame and then stalls on the ack waiter;
    // keep that failure fast instead of pinning the suite for 25s.
    setClientReplyTimeoutMsForTests(200);
    try {
      const res = await terminateReq(app, admin, agent.uuid, chat.id);
      expect(res.statusCode).toBe(503);
      expect(ws.send).not.toHaveBeenCalled();
      expect(legacyWs.send).not.toHaveBeenCalled();
      expect(await readState(app, agent.uuid, chat.id)).toBe("suspended");
      expect((await sessionEventService.listEvents(app.db, agent.uuid, chat.id, { limit: 10 })).items).toHaveLength(1);
    } finally {
      setClientReplyTimeoutMsForTests(null);
      cleanup(admin, legacyWs);
    }
  });

  it("still resets when the same client reconnects and keeps advertising the composite capability", async () => {
    // Positive control for the delivery-time capability recheck: a same-id
    // reconnect that is still v1 must not be punished for reconnecting.
    const { app, admin, agent, chat } = await setup("suspended");
    const reconnected = makeFakeClientSocket(app, admin.clientId);
    setClientConnection(admin.clientId, reconnected as unknown as WebSocket, { wsSessionResetV1: true });
    bindAgentToClient(admin.clientId, agent.uuid);
    try {
      const pending = terminateReq(app, admin, agent.uuid, chat.id);
      await ackSentCommand(reconnected, admin.clientId);
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: "evicted", applied: true });
      expect(await readState(app, agent.uuid, chat.id)).toBe("evicted");
    } finally {
      cleanup(admin, reconnected);
    }
  });

  it("the durable apply-ack refuses a downgraded client while the finalized receipt stays identity-only", async () => {
    // Apply is the destructive half — persisting it is what lets a waiter
    // conclude the provider mapping is gone — so it re-reads the registered
    // capability. The post-apply receipt must NOT: a client that already
    // applied and then flipped metadata would otherwise stay fenced forever
    // over an already-evicted session.
    const { app, admin, agent, chat, ws } = await setup("suspended");
    const { eq } = await import("drizzle-orm");
    await app.db
      .update(clients)
      .set({ metadata: { wireCapabilities: {} } })
      .where(eq(clients.id, admin.clientId));
    try {
      const appliedRef = crypto.randomUUID();
      expect(
        await storeSessionCommandRpcResult(
          app.db,
          admin.clientId,
          appliedRef,
          { command: "session:terminate", agentId: agent.uuid, chatId: chat.id, applied: true },
          LOCAL_INSTANCE,
        ),
      ).toBe(false);
      expect(await readSessionCommandRpcResult(app.db, admin.clientId, appliedRef)).toBeNull();

      const finalizedRef = crypto.randomUUID();
      expect(
        await storeSessionCommandRpcResult(
          app.db,
          admin.clientId,
          finalizedRef,
          { command: "session:terminate", agentId: agent.uuid, chatId: chat.id, applied: true, phase: "finalized" },
          LOCAL_INSTANCE,
        ),
      ).toBe(true);
      expect(await readSessionCommandRpcResult(app.db, admin.clientId, finalizedRef, "finalized")).toMatchObject({
        applied: true,
        phase: "finalized",
      });
    } finally {
      cleanup(admin, ws);
    }
  });

  it("durable post-apply disposition receipts survive the agent route moving away from the applying client", async () => {
    // A disposition receipt's authority is the applying CLIENT identity
    // (`clients.id` + owning instance), not the agent's current route: it says
    // "this client answered for the generation it armed". Abort exists for
    // exactly the branches where that route moved after a truthful apply, and
    // the eviction receipt can arrive after a rebind too, so keeping the route
    // guard on either would drop the receipt on the socket-owning replica and
    // fail the Reset request over a fence the client already lifted. Only the
    // destructive `applied` phase keeps the route + capability guard.
    const { app, admin, agent, chat, ws } = await setup("suspended");
    const { eq } = await import("drizzle-orm");
    await app.db.update(agentPresence).set({ instanceId: "elsewhere" }).where(eq(agentPresence.agentId, agent.uuid));
    try {
      const receipt = {
        command: "session:terminate" as const,
        agentId: agent.uuid,
        chatId: chat.id,
        applied: true,
      };
      for (const phase of ["aborted", "finalized"] as const) {
        const ref = crypto.randomUUID();
        expect(
          await storeSessionCommandRpcResult(app.db, admin.clientId, ref, { ...receipt, phase }, LOCAL_INSTANCE),
        ).toBe(true);
        expect(await readSessionCommandRpcResult(app.db, admin.clientId, ref, phase)).toMatchObject({
          applied: true,
          phase,
        });
        // A phase mismatch still fails closed, so no disposition receipt can
        // settle another phase's waiter on the durable fallback path.
        const otherPhase = phase === "aborted" ? "finalized" : "aborted";
        expect(await readSessionCommandRpcResult(app.db, admin.clientId, ref, otherPhase)).toBeNull();
        expect(await readSessionCommandRpcResult(app.db, admin.clientId, ref, "applied")).toBeNull();
      }

      // The destructive apply-ack still refuses the moved route…
      expect(
        await storeSessionCommandRpcResult(
          app.db,
          admin.clientId,
          crypto.randomUUID(),
          { ...receipt, phase: "applied" },
          LOCAL_INSTANCE,
        ),
      ).toBe(false);
      // …and client ownership still gates the dispositions themselves.
      expect(
        await storeSessionCommandRpcResult(
          app.db,
          admin.clientId,
          crypto.randomUUID(),
          { ...receipt, phase: "aborted" },
          "not-this-replica",
        ),
      ).toBe(false);
    } finally {
      cleanup(admin, ws);
    }
  });

  it("delivers the finalized signal to the applying client even when the local agent route moved", async () => {
    // `sendToAgent` follows the process-local binding, so a takeover between
    // the ack and the post-finalize signal used to fail this hand-off closed —
    // the eviction was durable but the client that armed the fence never heard
    // about it, and only an operator retry could unstick the chat. Addressing
    // the ORIGINAL applying `clientId` is both safe (it can only ever reach the
    // one identity that applied) and live (that identity still owns the fence).
    const { app, admin, agent, chat, ws } = await setup("suspended");
    const notifySpy = vi.spyOn(app.notifier, "notifyDaemonClientCommand");
    const replacement = makeFakeClientSocket(app, "cli-someone-else");
    setClientConnection("cli-someone-else", replacement as unknown as WebSocket, { wsSessionResetV1: true });
    try {
      const pending = terminateReq(app, admin, agent.uuid, chat.id);
      await ackSentCommand(ws, admin.clientId);
      bindAgentToClient("cli-someone-else", agent.uuid);
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(await readState(app, agent.uuid, chat.id)).toBe("evicted");
      expect(ws.dispositions).toEqual([
        { phase: "finalized", ref: expect.any(String), ackRef: expect.any(String), reason: undefined },
      ]);
      // The replacement client applied nothing and holds no generation, so it
      // must never be handed another client's fence release — and there is
      // still no blind fan-out from the owning replica.
      expect(replacement.dispositions).toEqual([]);
      expect(notifySpy).not.toHaveBeenCalled();
    } finally {
      notifySpy.mockRestore();
      cleanup({ clientId: "cli-someone-else" }, replacement);
      cleanup(admin, ws);
    }
  });

  it("falls back to the durable finalized receipt when its result wake is lost", async () => {
    const { app, admin, agent, chat, ws } = await setup("suspended", { finalizeReceipt: "durable" });
    setClientReplyTimeoutMsForTests(300);
    try {
      const pending = terminateReq(app, admin, agent.uuid, chat.id);
      await ackSentCommand(ws, admin.clientId);
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: "evicted", applied: true });
    } finally {
      setClientReplyTimeoutMsForTests(null);
      cleanup(admin, ws);
    }
  });

  it("fails 503 when the client never answers the post-finalize signal", async () => {
    // Fire-and-forget would have returned 200 over a chat whose queued work
    // is still fenced on the client.
    const { app, admin, agent, chat, ws } = await setup("suspended", { finalizeReceipt: "drop" });
    setClientReplyTimeoutMsForTests(80);
    try {
      const pending = terminateReq(app, admin, agent.uuid, chat.id);
      await ackSentCommand(ws, admin.clientId);
      const res = await pending;
      expect(res.statusCode).toBe(503);
    } finally {
      setClientReplyTimeoutMsForTests(null);
      cleanup(admin, ws);
    }
  });

  it("fails 503 when the client answers that it did not release the parked fence", async () => {
    const { app, admin, agent, chat, ws } = await setup("suspended", { finalizeReceipt: "refused" });
    try {
      const pending = terminateReq(app, admin, agent.uuid, chat.id);
      await ackSentCommand(ws, admin.clientId);
      const res = await pending;
      expect(res.statusCode).toBe(503);
    } finally {
      cleanup(admin, ws);
    }
  });

  it("a cleanup failure rolls the whole transaction back — row stays stopped and retryable", async () => {
    const { app, admin, agent, chat, ws } = await setup("suspended");
    await sessionEventService.appendEvent(app.db, agent.uuid, chat.id, {
      kind: "error",
      payload: { source: "sdk", message: "stubborn trace" },
    });
    const clearSpy = vi.spyOn(sessionEventService, "clearEvents").mockRejectedValueOnce(new Error("delete failed"));
    try {
      const pending = terminateReq(app, admin, agent.uuid, chat.id);
      await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
      const terminateRef = (JSON.parse(ws.send.mock.calls[0]?.[0] as string) as { ref: string }).ref;
      await ackSentCommand(ws, admin.clientId);
      const res = await pending;
      expect(res.statusCode).toBe(500);
      // Rollback: not evicted, events intact — a later retry can still converge.
      expect(await readState(app, agent.uuid, chat.id)).toBe("suspended");
      expect((await sessionEventService.listEvents(app.db, agent.uuid, chat.id, { limit: 10 })).items).toHaveLength(1);
      // The client had already applied, so the failure response is not the end
      // of this server's obligations: the armed generation is aborted and
      // receipted first. Answering 500 with no wire outcome at all is what left
      // the chat fenced behind a generation nobody would lift.
      expect(ws.dispositions).toEqual([
        { phase: "aborted", ref: terminateRef, ackRef: expect.any(String), reason: "cleanup_failed" },
      ]);
      // No `finalized` may ever claim an eviction that rolled back.
      expect(ws.dispositions.some((entry) => entry.phase === "finalized")).toBe(false);
    } finally {
      clearSpy.mockRestore();
      cleanup(admin, ws);
    }
  });
});
