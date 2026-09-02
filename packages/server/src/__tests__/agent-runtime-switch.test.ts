import type { CapabilityEntry, RuntimeProvider } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agentConfigs } from "../db/schema/agent-configs.js";
import { agents } from "../db/schema/agents.js";
import { clients } from "../db/schema/clients.js";
import { members } from "../db/schema/members.js";
import { sessionEvents } from "../db/schema/session-events.js";
import { createAgent } from "../services/agents/identity.js";
import { bindAgentRuntimeSession } from "../services/agents/runtime/session.js";
import { recoverAgentRuntimeSwitch, switchAgentRuntime } from "../services/agents/runtime/switch.js";
import { createChat } from "../services/chat/conversation.js";
import * as sessionEventService from "../services/chat/sessions/events.js";
import { retireClient } from "../services/runtime/client.js";
import { createAdminContext, seedClient, useTestApp } from "./helpers.js";

type GuardedRequest = {
  method: "DELETE" | "PATCH" | "POST";
  url: string;
  headers?: Record<string, string>;
  payload?: Record<string, unknown>;
};

function capability(state: CapabilityEntry["state"]): CapabilityEntry {
  return {
    state,
    available: state === "ok",
    sdkVersion: state === "ok" ? "1.0.0-test" : null,
    detectedAt: new Date().toISOString(),
  };
}

async function setClientRuntimeSupport(
  app: FastifyInstance,
  clientId: string,
  caps: Partial<Record<RuntimeProvider, CapabilityEntry>>,
): Promise<void> {
  await app.db
    .update(clients)
    .set({ sdkVersion: "0.5.12", metadata: { capabilities: caps } })
    .where(eq(clients.id, clientId));
}

describe("POST /agents/:uuid/switch-runtime", () => {
  const getApp = useTestApp();

  it("rejects fault injection headers when fault injection is disabled", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    const agent = await createAgent(app.db, {
      name: `switch-fault-disabled-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Switch Fault Disabled",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      runtimeProvider: "claude-code",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/switch-runtime`,
      headers: {
        authorization: `Bearer ${ctx.accessToken}`,
        "x-first-tree-runtime-switch-fault": "after_claim",
      },
      payload: {
        clientId: ctx.clientId,
        runtimeProvider: "codex",
        confirmLocalDataLoss: true,
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toContain("fault injection is disabled");
  });

  it("switches runtime with a metadata claim, config retag, and session eviction", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    await setClientRuntimeSupport(app, ctx.clientId, {
      "claude-code": capability("ok"),
      codex: capability("ok"),
    });
    const agent = await createAgent(app.db, {
      name: `switch-ok-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Switch OK",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      runtimeProvider: "claude-code",
    });
    const chat = await createChat(app.db, ctx.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    const staleChat = await createChat(app.db, ctx.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await app.db.insert(agentChatSessions).values({ agentId: agent.uuid, chatId: chat.id, state: "active" });
    await app.db.insert(agentChatSessions).values({ agentId: agent.uuid, chatId: staleChat.id, state: "evicted" });
    await sessionEventService.appendEvent(app.db, agent.uuid, chat.id, {
      kind: "error",
      payload: { source: "sdk", message: "pre-switch" },
    });
    await sessionEventService.appendEvent(app.db, agent.uuid, staleChat.id, {
      kind: "error",
      payload: { source: "sdk", message: "stale-evicted" },
    });
    const oldRuntimeSessionToken = await bindAgentRuntimeSession(app.db, agent.uuid, ctx.clientId);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/switch-runtime`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        clientId: ctx.clientId,
        runtimeProvider: "codex",
        confirmLocalDataLoss: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      uuid: agent.uuid,
      clientId: ctx.clientId,
      runtimeProvider: "codex",
      status: "active",
    });

    const [row] = await app.db
      .select({ metadata: agents.metadata, status: agents.status, runtimeProvider: agents.runtimeProvider })
      .from(agents)
      .where(eq(agents.uuid, agent.uuid))
      .limit(1);
    expect(row?.status).toBe("active");
    expect(row?.runtimeProvider).toBe("codex");
    expect(row?.metadata.runtimeSwitch).toBeUndefined();
    expect(row?.metadata.runtimeSession).toBeUndefined();

    const staleRuntimeHttp = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: {
        authorization: `Bearer ${ctx.accessToken}`,
        "x-agent-id": agent.uuid,
        "x-agent-runtime-session": oldRuntimeSessionToken,
      },
    });
    expect(staleRuntimeHttp.statusCode).toBe(403);

    const [cfg] = await app.db
      .select({ payload: agentConfigs.payload })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, agent.uuid))
      .limit(1);
    expect(cfg?.payload.kind).toBe("codex");

    const [session] = await app.db
      .select({ state: agentChatSessions.state, runtimeState: agentChatSessions.runtimeState })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.agentId, agent.uuid), eq(agentChatSessions.chatId, chat.id)))
      .limit(1);
    expect(session).toMatchObject({ state: "evicted", runtimeState: "idle" });
    const events = await app.db
      .select({ id: sessionEvents.id })
      .from(sessionEvents)
      .where(eq(sessionEvents.agentId, agent.uuid));
    expect(events).toEqual([]);
  });

  it("rejects a retired target client without changing the current route", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    await setClientRuntimeSupport(app, ctx.clientId, {
      "claude-code": capability("ok"),
      codex: capability("ok"),
    });
    const retiredClientId = await seedClient(app, ctx.userId, ctx.organizationId);
    await setClientRuntimeSupport(app, retiredClientId, { codex: capability("ok") });
    await app.db
      .update(clients)
      .set({ retiredAt: new Date(), status: "disconnected" })
      .where(eq(clients.id, retiredClientId));
    const agent = await createAgent(app.db, {
      name: `switch-retired-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Switch Retired",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      runtimeProvider: "claude-code",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/switch-runtime`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        clientId: retiredClientId,
        runtimeProvider: "codex",
        confirmLocalDataLoss: true,
      },
    });

    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("has been retired") });
    const [row] = await app.db
      .select({ clientId: agents.clientId, runtimeProvider: agents.runtimeProvider, status: agents.status })
      .from(agents)
      .where(eq(agents.uuid, agent.uuid));
    expect(row).toMatchObject({ clientId: ctx.clientId, runtimeProvider: "claude-code", status: "active" });
  });

  it("switches a retired-cleared suspended agent onto a new runtime", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    const targetClientId = await seedClient(app, ctx.userId, ctx.organizationId);
    await setClientRuntimeSupport(app, targetClientId, {
      "claude-code": capability("ok"),
      codex: capability("ok"),
    });
    const agent = await createAgent(app.db, {
      name: `switch-cleared-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Switch Cleared",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      runtimeProvider: "claude-code",
    });
    const chat = await createChat(app.db, ctx.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await app.db.insert(agentChatSessions).values({ agentId: agent.uuid, chatId: chat.id, state: "active" });

    await retireClient(app.db, ctx.clientId);
    const [cleared] = await app.db
      .select({ status: agents.status, clientId: agents.clientId })
      .from(agents)
      .where(eq(agents.uuid, agent.uuid))
      .limit(1);
    expect(cleared).toMatchObject({ status: "suspended", clientId: null });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/switch-runtime`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        clientId: targetClientId,
        runtimeProvider: "codex",
        confirmLocalDataLoss: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      uuid: agent.uuid,
      clientId: targetClientId,
      runtimeProvider: "codex",
      status: "active",
    });

    const [row] = await app.db
      .select({
        metadata: agents.metadata,
        status: agents.status,
        clientId: agents.clientId,
        runtimeProvider: agents.runtimeProvider,
      })
      .from(agents)
      .where(eq(agents.uuid, agent.uuid))
      .limit(1);
    expect(row).toMatchObject({ status: "active", clientId: targetClientId, runtimeProvider: "codex" });
    expect(row?.metadata.runtimeSwitch).toBeUndefined();
    expect(row?.metadata.runtimeSession).toBeUndefined();

    const [cfg] = await app.db
      .select({ payload: agentConfigs.payload })
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, agent.uuid))
      .limit(1);
    expect(cfg?.payload.kind).toBe("codex");

    const [session] = await app.db
      .select({ state: agentChatSessions.state, runtimeState: agentChatSessions.runtimeState })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.agentId, agent.uuid), eq(agentChatSessions.chatId, chat.id)))
      .limit(1);
    expect(session).toMatchObject({ state: "evicted", runtimeState: "idle" });
  });

  it("blocks ordinary reactivation and direct first-bind for retired-cleared agents", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    const targetClientId = await seedClient(app, ctx.userId, ctx.organizationId);
    const agent = await createAgent(app.db, {
      name: `switch-cleared-guard-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Switch Cleared Guard",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      runtimeProvider: "claude-code",
    });

    await retireClient(app.db, ctx.clientId);
    const [cleared] = await app.db
      .select({ status: agents.status, clientId: agents.clientId })
      .from(agents)
      .where(eq(agents.uuid, agent.uuid))
      .limit(1);
    expect(cleared).toMatchObject({ status: "suspended", clientId: null });

    const reactivateRes = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/reactivate`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(reactivateRes.statusCode).toBe(400);
    expect(reactivateRes.json()).toMatchObject({ error: expect.stringContaining("runtime switch") });

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/agents/${agent.uuid}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { clientId: targetClientId },
    });
    expect(patchRes.statusCode).toBe(400);
    expect(patchRes.json()).toMatchObject({ error: expect.stringContaining("runtime switch") });

    const [row] = await app.db
      .select({ status: agents.status, clientId: agents.clientId })
      .from(agents)
      .where(eq(agents.uuid, agent.uuid))
      .limit(1);
    expect(row).toMatchObject({ status: "suspended", clientId: null });
  });

  it("switches a delegate agent without clearing the member delegate mention", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    await setClientRuntimeSupport(app, ctx.clientId, {
      "claude-code": capability("ok"),
      codex: capability("ok"),
    });
    const agent = await createAgent(app.db, {
      name: `switch-delegate-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Switch Delegate",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      runtimeProvider: "claude-code",
    });
    await app.db.update(agents).set({ delegateMention: agent.uuid }).where(eq(agents.uuid, ctx.humanAgentUuid));
    const oldRuntimeSessionToken = await bindAgentRuntimeSession(app.db, agent.uuid, ctx.clientId);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/switch-runtime`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        clientId: ctx.clientId,
        runtimeProvider: "codex",
        confirmLocalDataLoss: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      uuid: agent.uuid,
      clientId: ctx.clientId,
      runtimeProvider: "codex",
      status: "active",
    });

    const [human] = await app.db
      .select({ delegateMention: agents.delegateMention })
      .from(agents)
      .where(eq(agents.uuid, ctx.humanAgentUuid))
      .limit(1);
    expect(human?.delegateMention).toBe(agent.uuid);

    const [row] = await app.db
      .select({ metadata: agents.metadata, runtimeProvider: agents.runtimeProvider })
      .from(agents)
      .where(eq(agents.uuid, agent.uuid))
      .limit(1);
    expect(row?.runtimeProvider).toBe("codex");
    expect(row?.metadata.runtimeSwitch).toBeUndefined();
    expect(row?.metadata.runtimeSession).toBeUndefined();

    const staleRuntimeHttp = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: {
        authorization: `Bearer ${ctx.accessToken}`,
        "x-agent-id": agent.uuid,
        "x-agent-runtime-session": oldRuntimeSessionToken,
      },
    });
    expect(staleRuntimeHttp.statusCode).toBe(403);
  });

  it("allows an offline target client when its known version and capabilities are sufficient", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    const targetClientId = await seedClient(app, ctx.userId, ctx.organizationId);
    await setClientRuntimeSupport(app, targetClientId, {
      "claude-code": capability("ok"),
      codex: capability("ok"),
    });
    await app.db.update(clients).set({ status: "disconnected" }).where(eq(clients.id, targetClientId));
    const agent = await createAgent(app.db, {
      name: `switch-offline-target-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Switch Offline Target",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      runtimeProvider: "claude-code",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/switch-runtime`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        clientId: targetClientId,
        runtimeProvider: "codex",
        confirmLocalDataLoss: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      uuid: agent.uuid,
      clientId: targetClientId,
      runtimeProvider: "codex",
      status: "active",
    });
  });

  it("rejects target runtime when the target client reports it missing", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    await setClientRuntimeSupport(app, ctx.clientId, {
      "claude-code": capability("ok"),
      codex: capability("missing"),
    });
    const agent = await createAgent(app.db, {
      name: `switch-missing-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Switch Missing",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      runtimeProvider: "claude-code",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/switch-runtime`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        clientId: ctx.clientId,
        runtimeProvider: "codex",
        confirmLocalDataLoss: true,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('runtime provider "codex"');
  });

  it("blocks lifecycle mutations while a runtime switch claim exists", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    const agent = await createAgent(app.db, {
      name: `switch-claim-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Switch Claim",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
    });
    await app.db
      .update(agents)
      .set({
        metadata: {
          runtimeSwitch: {
            claimId: "claim-test",
            phase: "claimed",
            claimedAt: new Date().toISOString(),
            claimedByUserId: ctx.userId,
            claimedByMemberId: ctx.memberId,
            oldClientId: ctx.clientId,
            oldRuntimeProvider: "claude-code",
            targetClientId: ctx.clientId,
            targetRuntimeProvider: "codex",
          },
        },
      })
      .where(eq(agents.uuid, agent.uuid));

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/suspend`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toContain("claim-test");
  });

  it("fail-closes lifecycle guards when the runtime switch claim is malformed", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    await setClientRuntimeSupport(app, ctx.clientId, {
      "claude-code": capability("ok"),
      codex: capability("ok"),
    });
    const agent = await createAgent(app.db, {
      name: `switch-malformed-claim-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Switch Malformed Claim",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      runtimeProvider: "claude-code",
    });

    const setMalformedClaim = async (status: "active" | "suspended" = "active") => {
      await app.db
        .update(agents)
        .set({
          status,
          displayName: "Switch Malformed Claim",
          metadata: { runtimeSwitch: { claimId: "qa-claim-guard" } },
        })
        .where(eq(agents.uuid, agent.uuid));
    };

    const expectBlocked = async (request: GuardedRequest, status: "active" | "suspended" = "active") => {
      await setMalformedClaim(status);
      const res = await app.inject({
        ...request,
        headers: { authorization: `Bearer ${ctx.accessToken}`, ...(request.headers ?? {}) },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: string }>().error).toContain("qa-claim-guard");
    };

    await expectBlocked({
      method: "PATCH",
      url: `/api/v1/agents/${agent.uuid}`,
      payload: { displayName: "Changed During Claim" },
    });
    const [afterPatch] = await app.db
      .select({ displayName: agents.displayName })
      .from(agents)
      .where(eq(agents.uuid, agent.uuid))
      .limit(1);
    expect(afterPatch?.displayName).toBe("Switch Malformed Claim");

    await expectBlocked({ method: "POST", url: `/api/v1/agents/${agent.uuid}/disconnect` });
    await expectBlocked({ method: "POST", url: `/api/v1/agents/${agent.uuid}/suspend` });
    await expectBlocked({ method: "POST", url: `/api/v1/agents/${agent.uuid}/reactivate` }, "suspended");
    const [afterReactivate] = await app.db
      .select({ status: agents.status, metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.uuid, agent.uuid))
      .limit(1);
    expect(afterReactivate).toMatchObject({
      status: "suspended",
      metadata: { runtimeSwitch: { claimId: "qa-claim-guard" } },
    });

    await expectBlocked({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/switch-runtime`,
      payload: {
        clientId: ctx.clientId,
        runtimeProvider: "codex",
        confirmLocalDataLoss: true,
      },
    });
  });
});

describe("POST /agents/:uuid/switch-runtime recovery", () => {
  const getApp = useTestApp({ runtimeSwitchFaultInjection: true });

  it("rejects unknown fault injection headers", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    const agent = await createAgent(app.db, {
      name: `switch-fault-unknown-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Switch Fault Unknown",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      runtimeProvider: "claude-code",
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/switch-runtime`,
      headers: {
        authorization: `Bearer ${ctx.accessToken}`,
        "x-first-tree-runtime-switch-fault": "not-a-fault",
      },
      payload: {
        clientId: ctx.clientId,
        runtimeProvider: "codex",
        confirmLocalDataLoss: true,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('Unknown runtime switch fault "not-a-fault"');
  });

  it("aborts the claim and preserves sessions when a pre-commit fault occurs", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    await setClientRuntimeSupport(app, ctx.clientId, {
      "claude-code": capability("ok"),
      codex: capability("ok"),
    });
    const agent = await createAgent(app.db, {
      name: `switch-precommit-fault-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Switch Precommit Fault",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      runtimeProvider: "claude-code",
    });
    const chat = await createChat(app.db, ctx.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await app.db.insert(agentChatSessions).values({ agentId: agent.uuid, chatId: chat.id, state: "active" });
    await sessionEventService.appendEvent(app.db, agent.uuid, chat.id, {
      kind: "error",
      payload: { source: "sdk", message: "pre-switch" },
    });
    const oldRuntimeSessionToken = await bindAgentRuntimeSession(app.db, agent.uuid, ctx.clientId);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/switch-runtime`,
      headers: {
        authorization: `Bearer ${ctx.accessToken}`,
        "x-first-tree-runtime-switch-fault": "after_claim",
      },
      payload: {
        clientId: ctx.clientId,
        runtimeProvider: "codex",
        confirmLocalDataLoss: true,
      },
    });

    expect(res.statusCode).toBe(500);
    const [row] = await app.db
      .select({
        status: agents.status,
        clientId: agents.clientId,
        runtimeProvider: agents.runtimeProvider,
        metadata: agents.metadata,
      })
      .from(agents)
      .where(eq(agents.uuid, agent.uuid))
      .limit(1);
    expect(row).toMatchObject({
      status: "active",
      clientId: ctx.clientId,
      runtimeProvider: "claude-code",
    });
    expect(row?.metadata.runtimeSwitch).toBeUndefined();
    const [session] = await app.db
      .select({ state: agentChatSessions.state })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.agentId, agent.uuid), eq(agentChatSessions.chatId, chat.id)))
      .limit(1);
    expect(session?.state).toBe("active");
    const events = await app.db
      .select({ id: sessionEvents.id })
      .from(sessionEvents)
      .where(eq(sessionEvents.agentId, agent.uuid));
    expect(events).toHaveLength(1);

    const oldRuntimeHttp = await app.inject({
      method: "GET",
      url: "/api/v1/agent/me",
      headers: {
        authorization: `Bearer ${ctx.accessToken}`,
        "x-agent-id": agent.uuid,
        "x-agent-runtime-session": oldRuntimeSessionToken,
      },
    });
    expect(oldRuntimeHttp.statusCode).toBe(200);
  });

  it("forward-recovers a committed claim and evicts sessions", async () => {
    const app = getApp();
    const ctx = await createAdminContext(app);
    await setClientRuntimeSupport(app, ctx.clientId, {
      "claude-code": capability("ok"),
      codex: capability("ok"),
    });
    const agent = await createAgent(app.db, {
      name: `switch-committed-fault-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Switch Committed Fault",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      runtimeProvider: "claude-code",
    });
    const chat = await createChat(app.db, ctx.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    await app.db.insert(agentChatSessions).values({ agentId: agent.uuid, chatId: chat.id, state: "active" });
    await sessionEventService.appendEvent(app.db, agent.uuid, chat.id, {
      kind: "error",
      payload: { source: "sdk", message: "pre-switch" },
    });

    const failed = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/switch-runtime`,
      headers: {
        authorization: `Bearer ${ctx.accessToken}`,
        "x-first-tree-runtime-switch-fault": "after_commit",
      },
      payload: {
        clientId: ctx.clientId,
        runtimeProvider: "codex",
        confirmLocalDataLoss: true,
      },
    });

    expect(failed.statusCode).toBe(500);
    const [stuck] = await app.db
      .select({
        status: agents.status,
        runtimeProvider: agents.runtimeProvider,
        metadata: agents.metadata,
      })
      .from(agents)
      .where(eq(agents.uuid, agent.uuid))
      .limit(1);
    expect(stuck).toMatchObject({
      status: "suspended",
      runtimeProvider: "codex",
      metadata: { runtimeSwitch: { phase: "committed" } },
    });

    const recovered = await app.inject({
      method: "POST",
      url: `/api/v1/agents/${agent.uuid}/switch-runtime/recover`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({
      uuid: agent.uuid,
      status: "active",
      runtimeProvider: "codex",
    });
    const [row] = await app.db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.uuid, agent.uuid))
      .limit(1);
    expect(row?.metadata.runtimeSwitch).toBeUndefined();
    const [session] = await app.db
      .select({ state: agentChatSessions.state })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.agentId, agent.uuid), eq(agentChatSessions.chatId, chat.id)))
      .limit(1);
    expect(session?.state).toBe("evicted");
    const events = await app.db
      .select({ id: sessionEvents.id })
      .from(sessionEvents)
      .where(eq(sessionEvents.agentId, agent.uuid));
    expect(events).toEqual([]);
  });
});

describe("agent runtime switch service preconditions", () => {
  const getApp = useTestApp();

  async function createSwitchFixture(app: FastifyInstance): Promise<{
    ctx: Awaited<ReturnType<typeof createAdminContext>>;
    agent: Awaited<ReturnType<typeof createAgent>>;
    targetClientId: string;
  }> {
    const ctx = await createAdminContext(app);
    const targetClientId = await seedClient(app, ctx.userId, ctx.organizationId);
    await setClientRuntimeSupport(app, targetClientId, {
      "claude-code": capability("ok"),
      codex: capability("ok"),
    });
    const agent = await createAgent(app.db, {
      name: `switch-service-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Switch Service",
      managerId: ctx.memberId,
      clientId: ctx.clientId,
      runtimeProvider: "claude-code",
    });
    return { ctx, agent, targetClientId };
  }

  it("rejects missing, human, invalid-state, and no-op switch targets before claiming", async () => {
    const app = getApp();
    const { ctx, agent, targetClientId } = await createSwitchFixture(app);
    const actor = { userId: ctx.userId, memberId: ctx.memberId };

    await expect(
      switchAgentRuntime(app.db, crypto.randomUUID(), { clientId: targetClientId, runtimeProvider: "codex" }, actor),
    ).rejects.toThrow("not found");

    await expect(
      switchAgentRuntime(app.db, ctx.humanAgentUuid, { clientId: targetClientId, runtimeProvider: "codex" }, actor),
    ).rejects.toThrow("Human agents");

    await app.db.update(agents).set({ status: "suspended" }).where(eq(agents.uuid, agent.uuid));
    await expect(
      switchAgentRuntime(app.db, agent.uuid, { clientId: targetClientId, runtimeProvider: "codex" }, actor),
    ).rejects.toThrow("Only active agents");

    await app.db.update(agents).set({ status: "active" }).where(eq(agents.uuid, agent.uuid));
    await expect(
      switchAgentRuntime(app.db, agent.uuid, { clientId: ctx.clientId, runtimeProvider: "claude-code" }, actor),
    ).rejects.toThrow("current configuration");
  });

  it("rejects manager and target-client ownership preconditions", async () => {
    const app = getApp();
    const { ctx, agent, targetClientId } = await createSwitchFixture(app);
    const actor = { userId: ctx.userId, memberId: ctx.memberId };

    await app.db.update(members).set({ status: "inactive" }).where(eq(members.id, ctx.memberId));
    await expect(
      switchAgentRuntime(app.db, agent.uuid, { clientId: targetClientId, runtimeProvider: "codex" }, actor),
    ).rejects.toThrow("Manager");
    await app.db.update(members).set({ status: "active" }).where(eq(members.id, ctx.memberId));

    await expect(
      switchAgentRuntime(app.db, agent.uuid, { clientId: "missing-client", runtimeProvider: "codex" }, actor),
    ).rejects.toThrow("not found");

    const unclaimedClientId = `cli-unclaimed-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values({
      id: unclaimedClientId,
      userId: null,
      organizationId: ctx.organizationId,
      status: "connected",
      sdkVersion: "0.5.12",
      metadata: { capabilities: { codex: capability("ok") } },
    });
    await expect(
      switchAgentRuntime(app.db, agent.uuid, { clientId: unclaimedClientId, runtimeProvider: "codex" }, actor),
    ).rejects.toThrow("has not been claimed");

    const otherCtx = await createAdminContext(app);
    await setClientRuntimeSupport(app, otherCtx.clientId, { codex: capability("ok") });
    await expect(
      switchAgentRuntime(app.db, agent.uuid, { clientId: otherCtx.clientId, runtimeProvider: "codex" }, actor),
    ).rejects.toThrow("not owned");
  });

  it.each([
    null,
    "0.5.11",
    "0.14.8",
    "0.5.12-staging.123.1",
  ])("rejects unsupported target Client version %s", async (sdkVersion) => {
    const app = getApp();
    const { ctx, agent, targetClientId } = await createSwitchFixture(app);
    await app.db.update(clients).set({ sdkVersion }).where(eq(clients.id, targetClientId));

    await expect(
      switchAgentRuntime(
        app.db,
        agent.uuid,
        { clientId: targetClientId, runtimeProvider: "codex" },
        { userId: ctx.userId, memberId: ctx.memberId },
      ),
    ).rejects.toThrow("0.5.12");
  });

  it("accepts a staging Client released after stable 0.5.12", async () => {
    const app = getApp();
    const { ctx, agent, targetClientId } = await createSwitchFixture(app);
    await app.db.update(clients).set({ sdkVersion: "0.5.20-staging.123.1" }).where(eq(clients.id, targetClientId));

    await expect(
      switchAgentRuntime(
        app.db,
        agent.uuid,
        { clientId: targetClientId, runtimeProvider: "codex" },
        { userId: ctx.userId, memberId: ctx.memberId },
      ),
    ).resolves.toMatchObject({
      agent: { clientId: targetClientId, runtimeProvider: "codex" },
      targetClientId,
    });
  });

  it.each([
    ["absent", undefined],
    ["empty", { capabilities: {} }],
  ] as const)("rejects Antigravity switch with %s capability metadata", async (_shape, metadata) => {
    const app = getApp();
    const { ctx, agent } = await createSwitchFixture(app);
    const targetClientId = `cli-gated-${crypto.randomUUID().slice(0, 8)}`;
    await app.db.insert(clients).values({
      id: targetClientId,
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      status: "connected",
      sdkVersion: "0.5.12",
      metadata,
    });

    await expect(
      switchAgentRuntime(
        app.db,
        agent.uuid,
        { clientId: targetClientId, runtimeProvider: "antigravity" },
        { userId: ctx.userId, memberId: ctx.memberId },
      ),
    ).rejects.toThrow(/disabled for new selection/);

    const [row] = await app.db
      .select({ clientId: agents.clientId, metadata: agents.metadata, runtimeProvider: agents.runtimeProvider })
      .from(agents)
      .where(eq(agents.uuid, agent.uuid))
      .limit(1);
    expect(row).toMatchObject({
      clientId: ctx.clientId,
      metadata: {},
      runtimeProvider: "claude-code",
    });
  });

  it("rejects recovery when state is missing, malformed, or the agent is gone", async () => {
    const app = getApp();
    const { agent } = await createSwitchFixture(app);

    await expect(recoverAgentRuntimeSwitch(app.db, crypto.randomUUID())).rejects.toThrow("not found");

    await expect(recoverAgentRuntimeSwitch(app.db, agent.uuid)).rejects.toThrow("no runtime switch recovery state");

    await app.db
      .update(agents)
      .set({ metadata: { runtimeSwitch: { claimId: "claim-malformed" } } })
      .where(eq(agents.uuid, agent.uuid));
    await expect(recoverAgentRuntimeSwitch(app.db, agent.uuid)).rejects.toThrow("claim-malformed");

    await app.db
      .update(agents)
      .set({ metadata: { runtimeSwitch: true } })
      .where(eq(agents.uuid, agent.uuid));
    await expect(recoverAgentRuntimeSwitch(app.db, agent.uuid)).rejects.toThrow("malformed");
  });

  it("aborts a persisted claimed recovery state through the service", async () => {
    const app = getApp();
    const { ctx, agent, targetClientId } = await createSwitchFixture(app);
    await app.db
      .update(agents)
      .set({
        status: "suspended",
        metadata: {
          runtimeSwitch: {
            claimId: "claim-service-abort",
            phase: "claimed",
            claimedAt: new Date().toISOString(),
            claimedByUserId: ctx.userId,
            claimedByMemberId: ctx.memberId,
            oldClientId: ctx.clientId,
            oldRuntimeProvider: "claude-code",
            targetClientId,
            targetRuntimeProvider: "codex",
          },
        },
      })
      .where(eq(agents.uuid, agent.uuid));

    const recovered = await recoverAgentRuntimeSwitch(app.db, agent.uuid);

    expect(recovered).toMatchObject({
      claimId: "claim-service-abort",
      oldClientId: ctx.clientId,
      targetClientId,
      terminatedChatIds: [],
      recoveryAction: "aborted",
    });
    expect(recovered.agent).toMatchObject({
      status: "active",
      clientId: ctx.clientId,
      runtimeProvider: "claude-code",
    });
    expect(recovered.agent.metadata.runtimeSwitch).toBeUndefined();
  });
});
