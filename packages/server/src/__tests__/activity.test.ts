import { RUNTIME_STALE_MS } from "@first-tree/shared";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agentPresence } from "../db/schema/agent-presence.js";
import { createAgent } from "../services/agents/identity.js";
import { createChat } from "../services/chat/conversation.js";
import {
  getAgentWithRuntime,
  resetActivity,
  setSessionRuntime,
  upsertSessionState,
} from "../services/chat/sessions/activity.js";
import type { Notifier } from "../services/notifier.js";
import { createAdminContext, useTestApp } from "./helpers.js";
import { readPresence, seedPresence } from "./session-state-helpers.js";

function makeNotifier(): Notifier {
  return {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    notify: vi.fn(async () => {}),
    notifyStrict: vi.fn(async () => {}),
    notifyConfigChange: vi.fn(async () => {}),
    notifySessionStateChange: vi.fn(async () => {}),
    notifyRuntimeStateChange: vi.fn(async () => {}),
    notifySessionRuntime: vi.fn(async () => {}),
    notifyChatMessage: vi.fn(async () => {}),
    notifyChatAudience: vi.fn(async () => {}),
    notifyChatUpdated: vi.fn(async () => {}),
    notifyMeChatsChanged: vi.fn(async () => {}),
    notifyMembershipChanged: vi.fn(async () => {}),
    notifyAgentRouteChange: vi.fn(async () => {}),
    notifyDaemonClientCommand: vi.fn(async () => {}),
    notifyDaemonClientCommandResult: vi.fn(async () => {}),
    notifySessionEvent: vi.fn(async () => {}),
    pushFrameToInbox: vi.fn(async () => 0),
    onConfigChange: vi.fn(),
    onSessionStateChange: vi.fn(),
    onSessionEvent: vi.fn(),
    onRuntimeStateChange: vi.fn(),
    onSessionRuntime: vi.fn(),
    onChatMessage: vi.fn(),
    onChatAudience: vi.fn(),
    onChatUpdated: vi.fn(),
    onMeChatsChanged: vi.fn(),
    onMembershipChanged: vi.fn(),
    onAgentRouteChange: vi.fn(),
    onDaemonClientCommand: vi.fn(),
    onDaemonClientCommandResult: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  } satisfies Notifier;
}

describe("upsertSessionState — touchPresenceLastSeen option", () => {
  const getApp = useTestApp();

  async function setup() {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `up-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `up-target-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Upsert target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, {
      type: "group",
      participantIds: [agent.uuid],
    });
    return { app, admin, agent, chat };
  }

  it("default behavior touches lastSeenAt to now", async () => {
    const { app, admin, agent, chat } = await setup();
    const oldDate = new Date("2020-01-01T00:00:00Z");
    await seedPresence(app, agent.uuid, oldDate);

    const before = Date.now();
    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId);
    const after = Date.now();

    const row = await readPresence(app, agent.uuid);
    expect(row).toBeDefined();
    const ts = row?.lastSeenAt?.getTime() ?? 0;
    expect(ts).toBeGreaterThanOrEqual(before - 50);
    expect(ts).toBeLessThanOrEqual(after + 50);
  });

  it("touchPresenceLastSeen=false keeps lastSeenAt unchanged but still updates active/total counts", async () => {
    const { app, admin, agent, chat } = await setup();
    const oldDate = new Date("2020-01-01T00:00:00Z");
    await seedPresence(app, agent.uuid, oldDate);

    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId, undefined, {
      touchPresenceLastSeen: false,
    });

    const row = await readPresence(app, agent.uuid);
    expect(row).toBeDefined();
    expect(row?.lastSeenAt?.getTime()).toBe(oldDate.getTime());
    expect(row?.activeSessions).toBe(1);
    expect(row?.totalSessions).toBe(1);
  });

  it("touchPresenceLastSeen=true (explicit) behaves as default", async () => {
    const { app, admin, agent, chat } = await setup();
    const oldDate = new Date("2020-01-01T00:00:00Z");
    await seedPresence(app, agent.uuid, oldDate);

    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId, undefined, {
      touchPresenceLastSeen: true,
    });

    const row = await readPresence(app, agent.uuid);
    expect(row).toBeDefined();
    expect(row?.lastSeenAt?.getTime()).toBeGreaterThan(oldDate.getTime());
  });

  // Predictive write may target an agent whose client has never bound (so
  // `agent_presence` has no row yet). The previous `update ... where agentId`
  // silently dropped the activeSessions/totalSessions refresh in that case;
  // the INSERT ... ON CONFLICT DO UPDATE form must populate the row instead.
  // See PR #198 review §2.
  it("creates the agent_presence row when none exists (predictive write on a never-bound agent)", async () => {
    const { app, admin, agent, chat } = await setup();
    // Do NOT seed presence.
    expect(await readPresence(app, agent.uuid)).toBeUndefined();

    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId, undefined, {
      touchPresenceLastSeen: false,
    });

    const row = await readPresence(app, agent.uuid);
    expect(row).toBeDefined();
    expect(row?.activeSessions).toBe(1);
    expect(row?.totalSessions).toBe(1);
  });

  it("resets runtime state and reads agent runtime presence", async () => {
    const { app, agent } = await setup();
    await seedPresence(app, agent.uuid, new Date("2020-01-01T00:00:00Z"));

    await app.db.update(agentPresence).set({ runtimeState: "working" }).where(eq(agentPresence.agentId, agent.uuid));
    expect((await getAgentWithRuntime(app.db, agent.uuid))?.runtimeState).toBe("working");

    await resetActivity(app.db, agent.uuid);
    const row = await getAgentWithRuntime(app.db, agent.uuid);
    expect(row?.runtimeState).toBe("idle");
    expect(row?.runtimeUpdatedAt).toBeInstanceOf(Date);

    await expect(getAgentWithRuntime(app.db, crypto.randomUUID())).resolves.toBeNull();
  });

  // Steady-state guard: when the (agent, chat) row is already at the target
  // state, a repeat upsert must NOT push a `session:state` NOTIFY and must
  // NOT churn `agent_presence.lastSeenAt` — otherwise the predictive Step 1b
  // in services/chat/message.ts (called once per message) fans into N session:state
  // frames per N messages, which the admin WS then re-broadcasts into a
  // matching N invalidations of `["activity"]` / `["sessions"]` in every open
  // dashboard tab. The client's `heartbeat` frame remains the canonical
  // lastSeenAt path.
  it("does NOT NOTIFY or refresh lastSeenAt when state is unchanged", async () => {
    const { app, admin, agent, chat } = await setup();
    // Bring the row to `active` once so the second call is the no-op case.
    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId);
    const firstSeen = (await readPresence(app, agent.uuid))?.lastSeenAt?.getTime();
    expect(firstSeen).toBeDefined();

    const notifier = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      notify: vi.fn(async () => {}),
      notifyStrict: vi.fn(async () => {}),
      notifyConfigChange: vi.fn(async () => {}),
      notifySessionStateChange: vi.fn(async () => {}),
      notifyRuntimeStateChange: vi.fn(async () => {}),
      notifySessionRuntime: vi.fn(async () => {}),
      notifyChatMessage: vi.fn(async () => {}),
      notifyChatAudience: vi.fn(async () => {}),
      notifyChatUpdated: vi.fn(async () => {}),
      notifyMeChatsChanged: vi.fn(async () => {}),
      notifyMembershipChanged: vi.fn(async () => {}),
      notifyAgentRouteChange: vi.fn(async () => {}),
      notifyDaemonClientCommand: vi.fn(async () => {}),
      notifyDaemonClientCommandResult: vi.fn(async () => {}),
      notifySessionEvent: vi.fn(async () => {}),
      pushFrameToInbox: vi.fn(async () => 0),
      onConfigChange: vi.fn(),
      onSessionStateChange: vi.fn(),
      onSessionEvent: vi.fn(),
      onRuntimeStateChange: vi.fn(),
      onSessionRuntime: vi.fn(),
      onChatMessage: vi.fn(),
      onChatAudience: vi.fn(),
      onChatUpdated: vi.fn(),
      onMeChatsChanged: vi.fn(),
      onMembershipChanged: vi.fn(),
      onAgentRouteChange: vi.fn(),
      onDaemonClientCommand: vi.fn(),
      onDaemonClientCommandResult: vi.fn(),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    } satisfies Notifier;

    // Wait a beat so a stray lastSeenAt write would be detectable.
    await new Promise((r) => setTimeout(r, 20));

    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId, notifier);

    expect(notifier.notifySessionStateChange).not.toHaveBeenCalled();
    expect(notifier.notifySessionRuntime).not.toHaveBeenCalled();
    const secondSeen = (await readPresence(app, agent.uuid))?.lastSeenAt?.getTime();
    expect(secondSeen).toBe(firstSeen);
  });

  it("leaves runtime_state_at NULL on first active write so old-client fallback stays live", async () => {
    const { app, admin, agent, chat } = await setup();
    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId);
    const [row] = await app.db
      .select({
        state: agentChatSessions.state,
        runtimeState: agentChatSessions.runtimeState,
        runtimeStateAt: agentChatSessions.runtimeStateAt,
      })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.agentId, agent.uuid), eq(agentChatSessions.chatId, chat.id)));
    expect(row).toMatchObject({ state: "active", runtimeState: "idle" });
    expect(row?.runtimeStateAt).toBeNull();
  });

  it("does not stamp a NULL runtime_state_at on a later active wake", async () => {
    const { app, admin, agent, chat } = await setup();
    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId);
    const notifier = makeNotifier();
    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId, notifier);
    const [row] = await app.db
      .select({ runtimeStateAt: agentChatSessions.runtimeStateAt })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.agentId, agent.uuid), eq(agentChatSessions.chatId, chat.id)));
    expect(row?.runtimeStateAt).toBeNull();
    expect(notifier.notifySessionStateChange).not.toHaveBeenCalled();
    expect(notifier.notifySessionRuntime).not.toHaveBeenCalled();
  });

  it("keeps a fresh working turn across a same-session wake", async () => {
    const { app, admin, agent, chat } = await setup();
    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId);
    await setSessionRuntime(app.db, agent.uuid, chat.id, "working", admin.organizationId);
    const notifier = makeNotifier();

    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId, notifier);

    const [row] = await app.db
      .select({ runtimeState: agentChatSessions.runtimeState })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.agentId, agent.uuid), eq(agentChatSessions.chatId, chat.id)));
    expect(row?.runtimeState).toBe("working");
    expect(notifier.notifySessionStateChange).not.toHaveBeenCalled();
    expect(notifier.notifySessionRuntime).not.toHaveBeenCalled();
  });

  it("clears stale in-flight working on the next active wake so the chip is not Failed", async () => {
    const { app, admin, agent, chat } = await setup();
    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId);
    const oldAt = new Date(Date.now() - RUNTIME_STALE_MS - 5_000);
    await app.db
      .update(agentChatSessions)
      .set({ runtimeState: "working", runtimeStateAt: oldAt })
      .where(and(eq(agentChatSessions.agentId, agent.uuid), eq(agentChatSessions.chatId, chat.id)));
    const notifier = makeNotifier();

    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId, notifier);

    const [row] = await app.db
      .select({ runtimeState: agentChatSessions.runtimeState, runtimeStateAt: agentChatSessions.runtimeStateAt })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.agentId, agent.uuid), eq(agentChatSessions.chatId, chat.id)));
    expect(row?.runtimeState).toBe("idle");
    expect(row?.runtimeStateAt?.getTime()).toBeGreaterThan(oldAt.getTime());
    expect(notifier.notifySessionStateChange).toHaveBeenCalledTimes(1);
    expect(notifier.notifySessionRuntime).toHaveBeenCalledWith(agent.uuid, chat.id, "idle", admin.organizationId);
  });

  it("clears leftover error runtime on the next active wake", async () => {
    const { app, admin, agent, chat } = await setup();
    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId);
    await setSessionRuntime(app.db, agent.uuid, chat.id, "error", admin.organizationId);
    const notifier = makeNotifier();

    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId, notifier);

    const [row] = await app.db
      .select({ runtimeState: agentChatSessions.runtimeState })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.agentId, agent.uuid), eq(agentChatSessions.chatId, chat.id)));
    expect(row?.runtimeState).toBe("idle");
    expect(notifier.notifySessionRuntime).toHaveBeenCalledWith(agent.uuid, chat.id, "idle", admin.organizationId);
  });

  // The complement of the previous test: a real state transition (active →
  // suspended) must still NOTIFY and still refresh presence. Guards against an
  // over-eager short-circuit that drops the wrong cases.
  it("DOES NOTIFY when state actually transitions", async () => {
    const { app, admin, agent, chat } = await setup();
    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId);
    await setSessionRuntime(app.db, agent.uuid, chat.id, "working", admin.organizationId);

    const notifier = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      notify: vi.fn(async () => {}),
      notifyStrict: vi.fn(async () => {}),
      notifyConfigChange: vi.fn(async () => {}),
      notifySessionStateChange: vi.fn(async () => {}),
      notifyRuntimeStateChange: vi.fn(async () => {}),
      notifySessionRuntime: vi.fn(async () => {}),
      notifyChatMessage: vi.fn(async () => {}),
      notifyChatAudience: vi.fn(async () => {}),
      notifyChatUpdated: vi.fn(async () => {}),
      notifyMeChatsChanged: vi.fn(async () => {}),
      notifyMembershipChanged: vi.fn(async () => {}),
      notifyAgentRouteChange: vi.fn(async () => {}),
      notifyDaemonClientCommand: vi.fn(async () => {}),
      notifyDaemonClientCommandResult: vi.fn(async () => {}),
      notifySessionEvent: vi.fn(async () => {}),
      pushFrameToInbox: vi.fn(async () => 0),
      onConfigChange: vi.fn(),
      onSessionStateChange: vi.fn(),
      onSessionEvent: vi.fn(),
      onRuntimeStateChange: vi.fn(),
      onSessionRuntime: vi.fn(),
      onChatMessage: vi.fn(),
      onChatAudience: vi.fn(),
      onChatUpdated: vi.fn(),
      onMeChatsChanged: vi.fn(),
      onMembershipChanged: vi.fn(),
      onAgentRouteChange: vi.fn(),
      onDaemonClientCommand: vi.fn(),
      onDaemonClientCommandResult: vi.fn(),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    } satisfies Notifier;

    await upsertSessionState(app.db, agent.uuid, chat.id, "suspended", admin.organizationId, notifier);

    expect(notifier.notifySessionStateChange).toHaveBeenCalledTimes(1);
    expect(notifier.notifySessionStateChange).toHaveBeenCalledWith(
      agent.uuid,
      chat.id,
      "suspended",
      admin.organizationId,
    );
    expect(notifier.notifySessionRuntime).toHaveBeenCalledTimes(1);
    expect(notifier.notifySessionRuntime).toHaveBeenCalledWith(agent.uuid, chat.id, "idle", admin.organizationId);

    const [row] = await app.db
      .select({ runtimeState: agentChatSessions.runtimeState, runtimeStateAt: agentChatSessions.runtimeStateAt })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.agentId, agent.uuid), eq(agentChatSessions.chatId, chat.id)));
    expect(row?.runtimeState).toBe("idle");
    expect(row?.runtimeStateAt).toBeInstanceOf(Date);
  });

  it("repairs and notifies a same-state inactive row that retained working", async () => {
    const { app, admin, agent, chat } = await setup();
    await upsertSessionState(app.db, agent.uuid, chat.id, "suspended", admin.organizationId);
    await app.db
      .update(agentChatSessions)
      .set({ runtimeState: "working", runtimeStateAt: new Date() })
      .where(and(eq(agentChatSessions.agentId, agent.uuid), eq(agentChatSessions.chatId, chat.id)));
    const notifier = makeNotifier();

    await upsertSessionState(app.db, agent.uuid, chat.id, "suspended", admin.organizationId, notifier);

    const [row] = await app.db
      .select({ runtimeState: agentChatSessions.runtimeState })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.agentId, agent.uuid), eq(agentChatSessions.chatId, chat.id)));
    expect(row?.runtimeState).toBe("idle");
    expect(notifier.notifySessionStateChange).toHaveBeenCalledTimes(1);
    expect(notifier.notifySessionRuntime).toHaveBeenCalledWith(agent.uuid, chat.id, "idle", admin.organizationId);

    vi.mocked(notifier.notifySessionStateChange).mockClear();
    vi.mocked(notifier.notifySessionRuntime).mockClear();
    await upsertSessionState(app.db, agent.uuid, chat.id, "suspended", admin.organizationId, notifier);
    expect(notifier.notifySessionStateChange).not.toHaveBeenCalled();
    expect(notifier.notifySessionRuntime).not.toHaveBeenCalled();
  });
});

describe("setSessionRuntime — per-(agent,chat) D-axis writer", () => {
  const getApp = useTestApp();

  async function setupActive() {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `sr-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `sr-target-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Session runtime target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, {
      type: "group",
      participantIds: [agent.uuid],
    });
    // Bring the session row into existence + state='active' (default
    // runtime_state='idle', runtime_state_at=NULL — the transient sentinel).
    await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId);
    return { app, admin, agent, chat };
  }

  async function readRuntime(app: Awaited<ReturnType<typeof setupActive>>["app"], agentId: string, chatId: string) {
    const [row] = await app.db
      .select({
        runtimeState: agentChatSessions.runtimeState,
        runtimeStateAt: agentChatSessions.runtimeStateAt,
      })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.agentId, agentId), eq(agentChatSessions.chatId, chatId)))
      .limit(1);
    return row ?? null;
  }

  it("idle → working: bumps row, stamps runtime_state_at, notifies", async () => {
    const { app, admin, agent, chat } = await setupActive();
    const notifier = makeNotifier();

    await setSessionRuntime(app.db, agent.uuid, chat.id, "working", admin.organizationId, notifier);

    const row = await readRuntime(app, agent.uuid, chat.id);
    expect(row?.runtimeState).toBe("working");
    expect(row?.runtimeStateAt).toBeInstanceOf(Date);
    expect(notifier.notifySessionRuntime).toHaveBeenCalledTimes(1);
    expect(notifier.notifySessionRuntime).toHaveBeenCalledWith(agent.uuid, chat.id, "working", admin.organizationId);
  });

  it("fresh same-value re-affirm: bumps timestamp but does NOT notify", async () => {
    const { app, admin, agent, chat } = await setupActive();
    const notifier = makeNotifier();
    // First call: NULL → working (notifies — boundary crossing).
    await setSessionRuntime(app.db, agent.uuid, chat.id, "working", admin.organizationId, notifier);
    const firstAt = (await readRuntime(app, agent.uuid, chat.id))?.runtimeStateAt?.getTime() ?? 0;
    vi.mocked(notifier.notifySessionRuntime).mockClear();
    // Yield to the event loop so the second timestamp is strictly later.
    await new Promise((r) => setTimeout(r, 5));

    // Second call: working → working, fresh (re-affirm). MUST NOT notify.
    await setSessionRuntime(app.db, agent.uuid, chat.id, "working", admin.organizationId, notifier);

    const secondAt = (await readRuntime(app, agent.uuid, chat.id))?.runtimeStateAt?.getTime() ?? 0;
    expect(secondAt).toBeGreaterThan(firstAt);
    expect(notifier.notifySessionRuntime).not.toHaveBeenCalled();
  });

  it("stale same-value report: bumps timestamp AND notifies (crosses fail-closed boundary)", async () => {
    const { app, admin, agent, chat } = await setupActive();
    const notifier = makeNotifier();
    // Seed a stale `working` directly to simulate a long-silent gap (real
    // clients refresh every ~30s, server stale window is 90s; here we
    // forcibly age the row past the cutoff).
    const oldAt = new Date(Date.now() - RUNTIME_STALE_MS - 5_000);
    await app.db
      .update(agentChatSessions)
      .set({ runtimeState: "working", runtimeStateAt: oldAt })
      .where(and(eq(agentChatSessions.agentId, agent.uuid), eq(agentChatSessions.chatId, chat.id)));

    await setSessionRuntime(app.db, agent.uuid, chat.id, "working", admin.organizationId, notifier);

    const row = await readRuntime(app, agent.uuid, chat.id);
    expect(row?.runtimeStateAt?.getTime()).toBeGreaterThan(oldAt.getTime());
    expect(notifier.notifySessionRuntime).toHaveBeenCalledTimes(1);
  });

  it("non-active session: skips write and skips notify", async () => {
    const { app, admin, agent, chat } = await setupActive();
    // Move row to suspended — runtime reports for non-active sessions are stale.
    await upsertSessionState(app.db, agent.uuid, chat.id, "suspended", admin.organizationId);
    const notifier = makeNotifier();

    await setSessionRuntime(app.db, agent.uuid, chat.id, "working", admin.organizationId, notifier);

    const row = await readRuntime(app, agent.uuid, chat.id);
    expect(row?.runtimeState).toBe("idle"); // untouched
    expect(row?.runtimeStateAt).toBeInstanceOf(Date);
    expect(notifier.notifySessionRuntime).not.toHaveBeenCalled();
  });

  it("suspend racing an idle report always converges to suspended idle", async () => {
    const { app, admin, agent, chat } = await setupActive();
    await setSessionRuntime(app.db, agent.uuid, chat.id, "working", admin.organizationId);
    const notifier = makeNotifier();

    await Promise.all([
      setSessionRuntime(app.db, agent.uuid, chat.id, "idle", admin.organizationId, notifier),
      upsertSessionState(app.db, agent.uuid, chat.id, "suspended", admin.organizationId, notifier),
    ]);

    const [row] = await app.db
      .select({ state: agentChatSessions.state, runtimeState: agentChatSessions.runtimeState })
      .from(agentChatSessions)
      .where(and(eq(agentChatSessions.agentId, agent.uuid), eq(agentChatSessions.chatId, chat.id)));
    expect(row).toMatchObject({ state: "suspended", runtimeState: "idle" });
    expect(notifier.notifySessionStateChange).toHaveBeenCalledWith(
      agent.uuid,
      chat.id,
      "suspended",
      admin.organizationId,
    );
    expect(notifier.notifySessionRuntime).toHaveBeenCalledWith(agent.uuid, chat.id, "idle", admin.organizationId);
  });

  it("missing session row: no write, no notify, no throw", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `sr-miss-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `sr-miss-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Missing session target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, {
      type: "group",
      participantIds: [agent.uuid],
    });
    const notifier = makeNotifier();

    await expect(
      setSessionRuntime(app.db, agent.uuid, chat.id, "working", admin.organizationId, notifier),
    ).resolves.toBeUndefined();
    expect(notifier.notifySessionRuntime).not.toHaveBeenCalled();
  });
});
