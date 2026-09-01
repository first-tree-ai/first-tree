import { EventEmitter } from "node:events";
import { AUTH_REJECTED_CODES, type ClientMessage, type InboxEntryWithMessage } from "@first-tree/shared";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientWsRoutes } from "../api/agent/ws-client.js";
import type { inboxEntries } from "../db/schema/inbox-entries.js";
import * as agentRuntimeSessionService from "../services/agents/runtime/session.js";
import * as inboxService from "../services/chat/inbox.js";
import * as activityService from "../services/chat/sessions/activity.js";
import * as sessionEventService from "../services/chat/sessions/events.js";
import * as notificationService from "../services/notification.js";
import * as clientService from "../services/runtime/client.js";
import * as runtimeLivenessService from "../services/runtime/liveness.js";
import * as presenceService from "../services/runtime/presence.js";

type WsHandler = (socket: FakeSocket, request: { headers: Record<string, string | undefined>; ip: string }) => unknown;

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = this.OPEN;
  sent: unknown[] = [];
  closes: Array<{ code: number; reason: string }> = [];
  failSend: ((frame: string) => boolean) | null = null;

  send(frame: string): void {
    if (this.failSend?.(frame)) throw new Error("send failed");
    this.sent.push(JSON.parse(frame));
  }

  close(code: number, reason: string): void {
    this.readyState = this.CLOSED;
    this.closes.push({ code, reason });
    this.emit("close", code);
  }
}

function queryChain(rows: unknown[] | Promise<unknown[]> = []): unknown {
  const promise = Promise.resolve(rows);
  const chain = new Proxy(
    function queryProxy(): unknown {
      return chain;
    },
    {
      get: (_target, prop) => {
        if (prop === "then") return promise.then.bind(promise);
        if (prop === "catch") return promise.catch.bind(promise);
        if (prop === "finally") return promise.finally.bind(promise);
        if (prop === Symbol.iterator) {
          const iterableRows = Array.isArray(rows) ? rows : [];
          return iterableRows[Symbol.iterator].bind(iterableRows);
        }
        return vi.fn(() => chain);
      },
    },
  );
  return chain;
}

function queuedDb(results: Array<unknown[] | Promise<unknown[]>>): unknown {
  return {
    select: vi.fn(() => queryChain(results.shift() ?? [])),
    update: vi.fn(() => queryChain(results.shift() ?? [])),
  };
}

function throwingSelectDb(error: unknown): unknown {
  return {
    select: vi.fn(() => {
      throw error;
    }),
  };
}

function routeHarness(
  db: unknown,
  inbox: { maxInFlightPerAgent?: number; maxInFlightPerAgentChat?: number } = {},
): { handler: WsHandler; notifier: Record<string, unknown> } {
  let handler: WsHandler | null = null;
  const notifier = {
    onAgentRouteChange: vi.fn(),
    onDaemonClientCommand: vi.fn(),
    onDaemonClientCommandResult: vi.fn(),
    notifyDaemonClientCommand: vi.fn(async () => {}),
    notifyDaemonClientCommandResult: vi.fn(async () => {}),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  };
  const app = {
    commandVersion: () => "test-version",
    config: {
      inbox: { maxInFlightPerAgent: 1, maxInFlightPerAgentChat: 1, ...inbox },
      secrets: { jwtSecret: "test-jwt-secret-key-for-vitest" },
    },
    db,
    get: vi.fn((_path: string, _options: unknown, routeHandler: WsHandler) => {
      handler = routeHandler;
    }),
    log: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
  void clientWsRoutes(notifier as never, "fake-instance")(app as never);
  if (!handler) throw new Error("WS route handler was not registered");
  return { handler, notifier };
}

async function signAccess(payload: Record<string, unknown> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT({ sub: "user_1", type: "access", organizationId: "org_1", ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now);
  if (!("exp" in payload)) jwt.setExpirationTime(now + 300);
  return jwt.sign(new TextEncoder().encode("test-jwt-secret-key-for-vitest"));
}

async function emitMessage(socket: FakeSocket, frame: unknown): Promise<void> {
  socket.emit("message", typeof frame === "string" ? frame : JSON.stringify(frame));
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 500) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function messageRow(overrides: Partial<ClientMessage> = {}): ClientMessage {
  return {
    id: "msg_1",
    chatId: "chat_1",
    senderId: "agent_1",
    senderKind: "member",
    senderProvider: null,
    format: "text",
    content: "hello",
    metadata: {},
    inReplyTo: null,
    source: "api",
    createdAt: "2026-01-01T00:00:00.000Z",
    configVersion: 1,
    recipientMode: "full",
    precedingMessages: [],
    ...overrides,
  };
}

function inboxEntry(overrides: Partial<InboxEntryWithMessage> = {}): InboxEntryWithMessage {
  return {
    id: 101,
    inboxId: "inbox_1",
    chatId: "chat_1",
    messageId: "msg_1",
    status: "pending",
    retryCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    deliveredAt: null,
    ackedAt: null,
    message: messageRow(),
    ...overrides,
  };
}

function inboxDbRow(overrides: Partial<typeof inboxEntries.$inferSelect> = {}): typeof inboxEntries.$inferSelect {
  return {
    id: 101,
    inboxId: "inbox_1",
    chatId: "chat_1",
    messageId: "msg_1",
    status: "acked",
    notify: true,
    retryCount: 0,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    deliveredAt: null,
    ackedAt: new Date("2026-01-01T00:00:01.000Z"),
    ...overrides,
  };
}

describe("Agent client WS branch fakes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("swallows auth rejection sends when the socket has already closed", async () => {
    const { handler } = routeHarness(queuedDb([]));
    const socket = new FakeSocket();
    await handler(socket, { headers: { "user-agent": "fake" }, ip: "127.0.0.1" });

    socket.readyState = socket.CLOSED;
    await emitMessage(socket, { type: "not-auth" });

    expect(socket.closes).toContainEqual({ code: 4401, reason: "auth rejected" });
    expect(socket.sent).toEqual([]);
  });

  it("swallows expired-auth sends when the socket has already closed", async () => {
    const { handler } = routeHarness(queuedDb([]));
    const socket = new FakeSocket();
    await handler(socket, { headers: { "user-agent": "fake" }, ip: "127.0.0.1" });

    socket.readyState = socket.CLOSED;
    const expired = await signAccess({ exp: Math.floor(Date.now() / 1000) - 1 });
    await emitMessage(socket, { type: "auth", token: expired });
    await waitUntil(() => socket.closes.length > 0);

    expect(socket.closes).toContainEqual({ code: 4401, reason: "auth expired" });
    expect(socket.sent).toEqual([]);
  });

  it("turns post-auth send failures into retryable closes", async () => {
    const { handler } = routeHarness(queuedDb([[{ id: "user_1", status: "active" }]]));
    const socket = new FakeSocket();
    let sendCount = 0;
    socket.failSend = () => {
      sendCount += 1;
      return sendCount === 2;
    };
    await handler(socket, { headers: { "user-agent": "fake" }, ip: "127.0.0.1" });

    await emitMessage(socket, { type: "auth", token: await signAccess() });
    await waitUntil(() => socket.closes.length > 0);

    // Second send fails: that is `auth:ok`, since `server:welcome` now leads
    // the post-auth handshake. The half-done handshake is retryable.
    expect(socket.sent.some((frame) => (frame as { type?: string }).type === "server:welcome")).toBe(true);
    expect(socket.sent).not.toContainEqual({ type: "auth:ok" });
    expect(socket.sent).toContainEqual({
      type: "auth:retryable",
      code: "handshake_internal_error",
      message: "post-auth handshake failed",
    });
    expect(socket.closes).toContainEqual({ code: 1011, reason: "auth retryable" });
  });

  it("swallows retryable auth frames when the socket closes during retry handling", async () => {
    const { handler } = routeHarness(throwingSelectDb(new Error("lookup unavailable")));
    const socket = new FakeSocket();
    let sendCount = 0;
    socket.failSend = (frame) => {
      const parsed = JSON.parse(frame) as { type?: string };
      sendCount += 1;
      return parsed.type === "auth:retryable";
    };
    await handler(socket, { headers: { "user-agent": "fake" }, ip: "127.0.0.1" });

    await emitMessage(socket, { type: "auth", token: await signAccess() });
    await waitUntil(() => socket.closes.length > 0);

    expect(sendCount).toBe(1);
    expect(socket.sent.some((frame) => (frame as { type?: string }).type === "auth:retryable")).toBe(false);
    expect(socket.closes).toContainEqual({ code: 1013, reason: "auth retryable" });
  });

  it("classifies non-Error auth lookup failures as retryable backend failures", async () => {
    const { handler } = routeHarness(throwingSelectDb("lookup unavailable as string"));
    const socket = new FakeSocket();
    await handler(socket, { headers: { "user-agent": "fake" }, ip: "127.0.0.1" });

    await emitMessage(socket, { type: "auth", token: await signAccess() });
    await waitUntil(() => socket.closes.length > 0);

    expect(socket.sent).toContainEqual({
      type: "auth:retryable",
      code: "auth_backend_unavailable",
      message: "authentication backend unavailable",
    });
    expect(socket.closes).toContainEqual({ code: 1013, reason: "auth retryable" });
  });

  it("maps non-Error client registration failures to the fallback rejection", async () => {
    vi.spyOn(clientService, "registerClient").mockImplementation(async () => {
      throw "register failed as string";
    });
    const { handler } = routeHarness(queuedDb([[{ id: "user_1", status: "active" }]]));
    const socket = new FakeSocket();
    await handler(socket, { headers: { "user-agent": "fake" }, ip: "127.0.0.1" });

    await emitMessage(socket, { type: "auth", token: await signAccess() });
    await waitUntil(() => socket.sent.some((frame) => (frame as { type?: string }).type === "server:welcome"));
    await emitMessage(socket, { type: "client:register", clientId: "client_fake1234" });
    await waitUntil(() => socket.closes.length > 0);

    expect(socket.sent).toContainEqual({
      type: "client:register:rejected",
      message: "client register failed",
    });
    expect(socket.closes).toContainEqual({ code: 4403, reason: "client register rejected" });
  });

  it("rejects client registration when no membership fallback exists", async () => {
    const { handler } = routeHarness(queuedDb([[{ id: "user_1", status: "active" }], []]));
    const socket = new FakeSocket();
    await handler(socket, { headers: { "user-agent": undefined }, ip: "127.0.0.1" });

    await emitMessage(socket, { type: "auth", token: await signAccess({ organizationId: undefined }) });
    await waitUntil(() => socket.sent.some((frame) => (frame as { type?: string }).type === "server:welcome"));
    await emitMessage(socket, { type: "client:register", clientId: "client_fake1234" });
    await waitUntil(() => socket.closes.length > 0);

    expect(socket.sent).toContainEqual({
      type: "client:register:rejected",
      message: "User has no active organization membership",
    });
    expect(socket.closes).toContainEqual({ code: 4403, reason: "no membership" });
  });

  it("uses the invalid-claims code for missing token type", async () => {
    const { handler } = routeHarness(queuedDb([]));
    const socket = new FakeSocket();
    await handler(socket, { headers: { "user-agent": "fake" }, ip: "127.0.0.1" });

    await emitMessage(socket, { type: "auth", token: await signAccess({ type: undefined }) });
    await waitUntil(() => socket.sent.length > 0);

    expect(socket.sent).toContainEqual({
      type: "auth:rejected",
      code: AUTH_REJECTED_CODES.INVALID_CLAIMS,
      message: "member access token required",
    });
  });

  async function authenticateAndRegister(socket: FakeSocket, handler: WsHandler): Promise<void> {
    vi.spyOn(clientService, "registerClient").mockResolvedValue(undefined);
    vi.spyOn(clientService, "listActiveAgentsPinnedToClient").mockResolvedValue([]);
    await handler(socket, { headers: { "user-agent": "fake" }, ip: "127.0.0.1" });
    await emitMessage(socket, { type: "auth", token: await signAccess() });
    await waitUntil(() => socket.sent.some((frame) => (frame as { type?: string }).type === "server:welcome"));
    await emitMessage(socket, { type: "client:register", clientId: "client_fake1234" });
    await waitUntil(() => socket.sent.some((frame) => (frame as { type?: string }).type === "client:registered"));
  }

  function activeAgentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "agent_1",
      displayName: "Agent",
      type: "agent",
      organizationId: "org_1",
      inboxId: "inbox_1",
      status: "active",
      clientId: "client_fake1234",
      managerId: "member_1",
      runtimeProvider: "claude-code",
      clientUserId: "user_1",
      managerUserId: "user_1",
      managerMemberStatus: "active",
      ...overrides,
    };
  }

  function mockSuccessfulBindServices(): void {
    vi.spyOn(agentRuntimeSessionService, "bindAgentRuntimeSession").mockResolvedValue("runtime-token");
    vi.spyOn(agentRuntimeSessionService, "revokeAgentRuntimeSession").mockResolvedValue(true);
    vi.spyOn(agentRuntimeSessionService, "revokeAgentRuntimeSessionIfTokenMatches").mockResolvedValue(true);
    vi.spyOn(presenceService, "bindAgentIfActiveClient").mockResolvedValue(true);
    vi.spyOn(presenceService, "unbindAgent").mockResolvedValue(1);
    vi.spyOn(presenceService, "setRuntimeState").mockResolvedValue(undefined);
    vi.spyOn(notificationService, "markAgentFaultsResolved").mockResolvedValue(undefined);
    vi.spyOn(notificationService, "notifyAgentEvent").mockResolvedValue(undefined);
    vi.spyOn(inboxService, "resetDeliveredForInboxes").mockResolvedValue(1);
    vi.spyOn(inboxService, "claimBacklogForPushFair").mockResolvedValue([]);
    vi.spyOn(inboxService, "claimBacklogForPushForChat").mockResolvedValue([]);
    vi.spyOn(inboxService, "recoverUnackedForScope").mockResolvedValue({ resetEntryIds: [] });
    vi.spyOn(inboxService, "countUnackedForScope").mockResolvedValue(0);
    vi.spyOn(inboxService, "ackEntryByIdForBoundAgents").mockResolvedValue({
      ok: true,
      throughEntry: inboxDbRow(),
      disposition: "acked",
      ackedCount: 1,
      ackedEntryIds: [101],
    });
    vi.spyOn(activityService, "upsertSessionState").mockResolvedValue(undefined);
    vi.spyOn(activityService, "setSessionRuntime").mockResolvedValue(undefined);
    vi.spyOn(runtimeLivenessService, "recordClientHeartbeat").mockResolvedValue({
      clientUpdated: true,
      restoredAgentIds: ["agent_1"],
    });
  }

  async function bindAgent(socket: FakeSocket, handler: WsHandler, ref = "bind-ok"): Promise<void> {
    await authenticateAndRegister(socket, handler);
    await emitMessage(socket, {
      type: "agent:bind",
      agentId: "agent_1",
      ref,
      runtimeType: "claude-code",
      runtimeVersion: "test",
    });
    await waitUntil(() => socket.sent.some((frame) => (frame as { type?: string }).type === "agent:bound"));
  }

  it("rejects first-bind races when the claim update returns no row", async () => {
    const { handler } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        [{ userId: "user_1", retiredAt: null }],
        [activeAgentRow({ clientId: null })],
        [],
      ]),
    );
    const socket = new FakeSocket();
    await authenticateAndRegister(socket, handler);

    await emitMessage(socket, {
      type: "agent:bind",
      agentId: "agent_1",
      ref: "bind-claim-empty",
      runtimeType: "claude-code",
      runtimeVersion: "test",
    });

    expect(socket.sent).toContainEqual({
      type: "agent:bind:rejected",
      ref: "bind-claim-empty",
      reason: "wrong_client",
    });
  });

  it("rejects bind attempts for agents pinned to another client", async () => {
    const { handler } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        [{ userId: "user_1", retiredAt: null }],
        [activeAgentRow({ clientId: "client_other1234" })],
      ]),
    );
    const socket = new FakeSocket();
    await authenticateAndRegister(socket, handler);

    await emitMessage(socket, {
      type: "agent:bind",
      agentId: "agent_1",
      ref: "bind-wrong-client",
      runtimeType: "claude-code",
      runtimeVersion: "test",
    });

    expect(socket.sent).toContainEqual({
      type: "agent:bind:rejected",
      ref: "bind-wrong-client",
      reason: "wrong_client",
    });
  });

  it("rejects bind attempts when the pinned client has no matching user", async () => {
    const { handler } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        [{ userId: "user_1", retiredAt: null }],
        [activeAgentRow({ clientUserId: null })],
      ]),
    );
    const socket = new FakeSocket();
    await authenticateAndRegister(socket, handler);

    await emitMessage(socket, {
      type: "agent:bind",
      agentId: "agent_1",
      ref: "bind-client-user-missing",
      runtimeType: "claude-code",
      runtimeVersion: "test",
    });

    expect(socket.sent).toContainEqual({
      type: "agent:bind:rejected",
      ref: "bind-client-user-missing",
      reason: "not_owned",
    });
  });

  it("binds an agent and drains backlog through the fake inbox push path", async () => {
    mockSuccessfulBindServices();
    vi.spyOn(inboxService, "claimBacklogForPushFair").mockResolvedValueOnce([inboxEntry()]).mockResolvedValue([]);
    const { handler, notifier } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        [{ userId: "user_1", retiredAt: null }],
        [activeAgentRow()],
        [activeAgentRow({ clientId: "client_fake1234", clientUserId: undefined, managerId: undefined })],
      ]),
    );
    const socket = new FakeSocket();
    await bindAgent(socket, handler);
    await waitUntil(() => socket.sent.some((frame) => (frame as { type?: string }).type === "inbox:deliver"));

    expect(socket.sent).toContainEqual(
      expect.objectContaining({ type: "agent:bound", runtimeSessionToken: "runtime-token" }),
    );
    expect(socket.sent).toContainEqual(
      expect.objectContaining({ type: "inbox:deliver", entryId: 101, chatId: "chat_1" }),
    );
    expect(notifier.subscribe).toHaveBeenCalledWith("inbox_1", socket, expect.any(Function));
  });

  it("delivers null-chat inbox entries and accepts acks without refs", async () => {
    mockSuccessfulBindServices();
    vi.spyOn(inboxService, "claimBacklogForPushFair")
      .mockResolvedValueOnce([inboxEntry({ id: 303, chatId: null })])
      .mockResolvedValue([]);
    vi.spyOn(inboxService, "ackEntryByIdForBoundAgents").mockResolvedValueOnce({
      ok: true,
      throughEntry: inboxDbRow({ id: 303, chatId: null }),
      disposition: "acked",
      ackedCount: 1,
      ackedEntryIds: [303],
    });
    const { handler } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        [{ userId: "user_1", retiredAt: null }],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
      ]),
    );
    const socket = new FakeSocket();
    await bindAgent(socket, handler, "bind-null-chat");
    await waitUntil(() => socket.sent.some((frame) => (frame as { entryId?: number }).entryId === 303));

    await emitMessage(socket, { type: "inbox:ack", entryId: 303 });
    await waitUntil(() => vi.mocked(inboxService.ackEntryByIdForBoundAgents).mock.calls.length > 0);

    expect(socket.sent).toContainEqual(expect.objectContaining({ type: "inbox:deliver", entryId: 303, chatId: null }));
    expect(socket.sent).not.toContainEqual(expect.objectContaining({ type: "inbox:ack:accepted", entryId: 303 }));
  });

  it("passes the complete 9-id snapshot when the configured per-chat cap is 12", async () => {
    mockSuccessfulBindServices();
    const entryIds = [201, 209, 202, 208, 203, 207, 204, 206, 205];
    vi.spyOn(inboxService, "claimBacklogForPushFair")
      .mockResolvedValueOnce(
        entryIds.map((id) =>
          inboxEntry({
            id,
            messageId: `msg_${id}`,
            message: messageRow({ id: `msg_${id}`, content: `cap12 ${id}` }),
          }),
        ),
      )
      .mockResolvedValue([]);
    vi.spyOn(inboxService, "ackEntryByIdForBoundAgents").mockResolvedValueOnce({
      ok: true,
      throughEntry: inboxDbRow({ id: 209 }),
      disposition: "acked",
      ackedCount: 9,
      ackedEntryIds: [...entryIds].sort((left, right) => left - right),
    });
    const db = queuedDb([
      [{ id: "user_1", status: "active" }],
      [{ userId: "user_1", retiredAt: null }],
      [activeAgentRow()],
      [activeAgentRow()],
      [activeAgentRow()],
    ]);
    const { handler } = routeHarness(db, { maxInFlightPerAgent: 8192, maxInFlightPerAgentChat: 12 });
    const socket = new FakeSocket();
    await bindAgent(socket, handler, "bind-cap12");
    await waitUntil(
      () => socket.sent.filter((frame) => (frame as { type?: string }).type === "inbox:deliver").length === 9,
    );

    await emitMessage(socket, { type: "inbox:ack", entryId: 209, ref: "ack-cap12-tail" });
    await waitUntil(() => vi.mocked(inboxService.ackEntryByIdForBoundAgents).mock.calls.length > 0);

    expect(inboxService.ackEntryByIdForBoundAgents).toHaveBeenCalledWith(
      db,
      209,
      ["inbox_1"],
      [201, 202, 203, 204, 205, 206, 207, 208, 209],
    );
    expect(socket.sent).toContainEqual({
      type: "inbox:ack:accepted",
      entryId: 209,
      ref: "ack-cap12-tail",
      disposition: "acked",
      ackedCount: 9,
    });
  });

  it("treats runtime-switch claimed routes as no longer routed here without dropping the local binding", async () => {
    mockSuccessfulBindServices();
    const switchClaim = {
      claimId: "claim_1",
      phase: "claimed",
      claimedAt: "2026-01-01T00:00:00.000Z",
      claimedByUserId: "user_1",
      claimedByMemberId: "member_1",
      oldClientId: "client_fake1234",
      oldRuntimeProvider: "claude-code",
      targetClientId: "client_next1234",
      targetRuntimeProvider: "codex",
    };
    const { handler } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        [{ userId: "user_1", retiredAt: null }],
        [activeAgentRow()],
        [activeAgentRow()],
        [
          {
            clientId: "client_fake1234",
            status: "suspended",
            runtimeProvider: "claude-code",
            metadata: { runtimeSwitch: switchClaim },
          },
        ],
      ]),
    );
    const socket = new FakeSocket();
    await bindAgent(socket, handler, "bind-switch-claimed");

    await emitMessage(socket, { type: "session:state", agentId: "agent_1", chatId: "chat_1", state: "active" });

    expect(socket.sent).toContainEqual({ type: "error", message: "Agent not bound" });
  });

  it("throttles heartbeat-triggered inbox repair when the last repair is recent", async () => {
    mockSuccessfulBindServices();
    const { handler } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        [{ userId: "user_1", retiredAt: null }],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
      ]),
    );
    const socket = new FakeSocket();
    await bindAgent(socket, handler, "bind-heartbeat-throttle");

    const heartbeatAckCount = (): number =>
      socket.sent.filter((frame) => (frame as { type?: string }).type === "heartbeat:ack").length;

    await emitMessage(socket, { type: "heartbeat" });
    await waitUntil(() => heartbeatAckCount() === 1);
    await emitMessage(socket, { type: "heartbeat" });
    await waitUntil(() => heartbeatAckCount() === 2);

    expect(runtimeLivenessService.recordClientHeartbeat).toHaveBeenCalledTimes(2);
    expect(socket.sent).toContainEqual({ type: "heartbeat:ack" });
  });

  it("covers inbox cap logging for notify and recover drains", async () => {
    mockSuccessfulBindServices();
    const { handler, notifier } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        [{ userId: "user_1", retiredAt: null }],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
      ]),
    );
    const socket = new FakeSocket();
    await bindAgent(socket, handler);

    vi.spyOn(inboxService, "claimBacklogForPushFair").mockResolvedValueOnce([inboxEntry()]);
    const pushHandler = (notifier.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as
      | ((messageId: string) => Promise<void>)
      | undefined;
    await pushHandler?.("msg_notify");
    await waitUntil(() => socket.sent.some((frame) => (frame as { type?: string }).type === "inbox:deliver"));

    await pushHandler?.("msg_at_cap");
    await emitMessage(socket, { type: "inbox:recover", ref: "recover-at-cap", agentId: "agent_1", chatId: "chat_1" });

    expect(socket.sent).toContainEqual({
      type: "inbox:recover:accepted",
      ref: "recover-at-cap",
      agentId: "agent_1",
      chatId: "chat_1",
      resetCount: 0,
      unackedOutstanding: 0,
    });
  });

  it("answers fence probes with per-delivery settlement truth and rejects unbound agents", async () => {
    mockSuccessfulBindServices();
    const settledSpy = vi.spyOn(inboxService, "listSettledMessageIdsForScope").mockResolvedValue(["msg-settled"]);
    const { handler } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        [{ userId: "user_1", retiredAt: null }],
        ...Array.from({ length: 12 }, () => [activeAgentRow()]),
      ]),
    );
    const socket = new FakeSocket();
    await bindAgent(socket, handler);

    await emitMessage(socket, {
      type: "inbox:fence-probe",
      ref: "probe-1",
      agentId: "agent_1",
      chatId: "chat_1",
      messageIds: ["msg-settled", "msg-pending"],
    });
    expect(socket.sent).toContainEqual({
      type: "inbox:fence-probe:accepted",
      ref: "probe-1",
      agentId: "agent_1",
      chatId: "chat_1",
      settledMessageIds: ["msg-settled"],
    });
    expect(settledSpy).toHaveBeenCalledWith(expect.anything(), {
      inboxId: expect.any(String),
      chatId: "chat_1",
      messageIds: ["msg-settled", "msg-pending"],
    });

    await emitMessage(socket, {
      type: "inbox:fence-probe",
      ref: "probe-2",
      agentId: "agent_unknown",
      chatId: "chat_1",
      messageIds: ["msg-1"],
    });
    expect(socket.sent).toContainEqual({
      type: "inbox:fence-probe:rejected",
      ref: "probe-2",
      agentId: "agent_unknown",
      chatId: "chat_1",
      reason: "agent_not_bound",
    });
  });

  it("opens a same-socket recovery circuit after repeated identical debt without progress", async () => {
    mockSuccessfulBindServices();
    const recoverSpy = vi.spyOn(inboxService, "recoverUnackedForScope").mockResolvedValue({ resetEntryIds: [101] });
    vi.spyOn(inboxService, "countUnackedForScope").mockResolvedValue(1);
    const { handler } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        [{ userId: "user_1", retiredAt: null }],
        ...Array.from({ length: 12 }, () => [activeAgentRow()]),
      ]),
    );
    const socket = new FakeSocket();
    await bindAgent(socket, handler);

    for (const ref of ["recover-1", "recover-2"]) {
      await emitMessage(socket, {
        type: "inbox:recover",
        ref,
        agentId: "agent_1",
        chatId: "chat_no_progress",
      });
      expect(socket.sent).toContainEqual({
        type: "inbox:recover:accepted",
        ref,
        agentId: "agent_1",
        chatId: "chat_no_progress",
        resetCount: 1,
        unackedOutstanding: 1,
      });
    }

    await emitMessage(socket, {
      type: "inbox:recover",
      ref: "recover-3",
      agentId: "agent_1",
      chatId: "chat_no_progress",
    });
    expect(socket.sent).toContainEqual({
      type: "inbox:recover:rejected",
      ref: "recover-3",
      agentId: "agent_1",
      chatId: "chat_no_progress",
      reason: "recover_failed",
    });

    await emitMessage(socket, {
      type: "inbox:recover",
      ref: "recover-4",
      agentId: "agent_1",
      chatId: "chat_no_progress",
    });
    expect(socket.sent).toContainEqual({
      type: "inbox:recover:rejected",
      ref: "recover-4",
      agentId: "agent_1",
      chatId: "chat_no_progress",
      reason: "recover_failed",
    });
    expect(recoverSpy).toHaveBeenCalledTimes(3);
    expect(inboxService.claimBacklogForPushForChat).toHaveBeenCalledTimes(2);

    vi.mocked(inboxService.ackEntryByIdForBoundAgents).mockResolvedValueOnce({
      ok: true,
      throughEntry: inboxDbRow({ chatId: "chat_no_progress" }),
      disposition: "acked",
      ackedCount: 1,
      ackedEntryIds: [101],
    });
    await emitMessage(socket, { type: "inbox:ack", entryId: 101, ref: "ack-progress" });
    expect(socket.sent).toContainEqual({
      type: "inbox:ack:accepted",
      entryId: 101,
      ref: "ack-progress",
      disposition: "acked",
      ackedCount: 1,
    });

    await emitMessage(socket, {
      type: "inbox:recover",
      ref: "recover-after-progress",
      agentId: "agent_1",
      chatId: "chat_no_progress",
    });
    expect(socket.sent).toContainEqual({
      type: "inbox:recover:accepted",
      ref: "recover-after-progress",
      agentId: "agent_1",
      chatId: "chat_no_progress",
      resetCount: 1,
      unackedOutstanding: 1,
    });
    expect(recoverSpy).toHaveBeenCalledTimes(4);
  });

  it("excludes a circuit-open chat from unrelated fair drains until ACK or fresh bind", async () => {
    mockSuccessfulBindServices();
    vi.spyOn(inboxService, "recoverUnackedForScope").mockResolvedValue({ resetEntryIds: [101] });
    const { handler, notifier } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        // Every later select sees a row that satisfies both the bind-time
        // `clients` check (userId, no retiredAt) and the agent-shape checks
        // (clientId/status/runtimeProvider), so select-order drift in this
        // branch-heavy flow cannot misalign the queue.
        ...Array.from({ length: 30 }, () => [activeAgentRow({ userId: "user_1", retiredAt: null })]),
      ]),
    );
    const socket = new FakeSocket();
    await bindAgent(socket, handler);

    const openCircuit = async (refs: string[]) => {
      for (const ref of refs) {
        await emitMessage(socket, {
          type: "inbox:recover",
          ref,
          agentId: "agent_1",
          chatId: "chat_no_progress",
        });
      }
      expect(socket.sent).toContainEqual({
        type: "inbox:recover:rejected",
        ref: refs[refs.length - 1],
        agentId: "agent_1",
        chatId: "chat_no_progress",
        reason: "recover_failed",
      });
    };
    await openCircuit(["recover-1", "recover-2", "recover-3"]);

    const fairSpy = vi.mocked(inboxService.claimBacklogForPushFair);
    const lastBudgets = (): Array<{ chatId: string | null; remaining: number }> =>
      (fairSpy.mock.calls.at(-1)?.[2]?.chatBudgets ?? []) as Array<{ chatId: string | null; remaining: number }>;

    // An unrelated same-agent notify must not redeliver the protected
    // chat's held debt: the fair claim receives a zero budget for it and a
    // budget-aware claim would only emit the unrelated chat's work.
    fairSpy.mockClear();
    fairSpy.mockImplementationOnce(async (_db, _inboxId, opts) => {
      const excluded = new Set(
        opts.chatBudgets.filter((budget) => budget.remaining === 0).map((budget) => budget.chatId),
      );
      return [
        inboxEntry({ id: 101, chatId: "chat_no_progress" }),
        inboxEntry({ id: 102, chatId: "chat_other", messageId: "msg_2" }),
      ].filter((entry) => !excluded.has(entry.chatId));
    });
    const pushHandler = (notifier.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as
      | ((messageId: string) => Promise<void>)
      | undefined;
    await pushHandler?.("msg_unrelated_chat");
    await waitUntil(() => fairSpy.mock.calls.length > 0);
    expect(lastBudgets()).toContainEqual({ chatId: "chat_no_progress", remaining: 0 });
    await waitUntil(() =>
      socket.sent.some((frame) => (frame as { type?: string; chatId?: string }).chatId === "chat_other"),
    );
    expect(socket.sent).not.toContainEqual(
      expect.objectContaining({ type: "inbox:deliver", chatId: "chat_no_progress" }),
    );

    // Scoped recover for the protected chat stays rejected while open.
    await emitMessage(socket, {
      type: "inbox:recover",
      ref: "recover-while-open",
      agentId: "agent_1",
      chatId: "chat_no_progress",
    });
    expect(socket.sent).toContainEqual({
      type: "inbox:recover:rejected",
      ref: "recover-while-open",
      agentId: "agent_1",
      chatId: "chat_no_progress",
      reason: "recover_failed",
    });

    // An ACK for an unrelated chat frees the in-flight slot but must NOT
    // clear the protected chat's exclusion.
    vi.mocked(inboxService.ackEntryByIdForBoundAgents).mockResolvedValueOnce({
      ok: true,
      throughEntry: inboxDbRow({ id: 102, chatId: "chat_other" }),
      disposition: "acked",
      ackedCount: 1,
      ackedEntryIds: [102],
    });
    fairSpy.mockClear();
    await emitMessage(socket, { type: "inbox:ack", entryId: 102, ref: "ack-other" });
    await waitUntil(() => fairSpy.mock.calls.length > 0);
    expect(lastBudgets()).toContainEqual({ chatId: "chat_no_progress", remaining: 0 });

    // An ACK for the protected chat removes the exclusion before the ACK drain.
    vi.mocked(inboxService.ackEntryByIdForBoundAgents).mockResolvedValueOnce({
      ok: true,
      throughEntry: inboxDbRow({ chatId: "chat_no_progress" }),
      disposition: "acked",
      ackedCount: 1,
      ackedEntryIds: [101],
    });
    fairSpy.mockClear();
    await emitMessage(socket, { type: "inbox:ack", entryId: 101, ref: "ack-progress" });
    await waitUntil(() => fairSpy.mock.calls.length > 0);
    expect(lastBudgets()).not.toContainEqual({ chatId: "chat_no_progress", remaining: 0 });

    // Re-open the circuit; a fresh bind clears it before the bind drain.
    await openCircuit(["recover-5", "recover-6", "recover-7"]);
    fairSpy.mockClear();
    await emitMessage(socket, {
      type: "agent:bind",
      agentId: "agent_1",
      ref: "bind-fresh",
      runtimeType: "claude-code",
      runtimeVersion: "test",
    });
    await waitUntil(() =>
      socket.sent.some(
        (frame) =>
          (frame as { type?: string; ref?: string }).type === "agent:bound" &&
          (frame as { ref?: string }).ref === "bind-fresh",
      ),
    );
    await waitUntil(() => fairSpy.mock.calls.length > 0);
    expect(lastBudgets()).not.toContainEqual({ chatId: "chat_no_progress", remaining: 0 });
  });

  it("stops a drain when the socket closes after backlog is claimed", async () => {
    mockSuccessfulBindServices();
    const { handler, notifier } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        [{ userId: "user_1", retiredAt: null }],
        [activeAgentRow()],
        [activeAgentRow()],
      ]),
    );
    const socket = new FakeSocket();
    await bindAgent(socket, handler);

    vi.spyOn(inboxService, "claimBacklogForPushFair").mockImplementationOnce(async () => {
      socket.readyState = socket.CLOSED;
      return [inboxEntry({ id: 202 })] as never;
    });
    const pushHandler = (notifier.subscribe as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as
      | ((messageId: string) => Promise<void>)
      | undefined;
    await pushHandler?.("msg_close_mid_drain");

    expect(socket.sent).not.toContainEqual(expect.objectContaining({ entryId: 202 }));
  });

  it("persists session state and runtime frames after binding", async () => {
    mockSuccessfulBindServices();
    const { handler } = routeHarness(
      queuedDb([
        [{ id: "user_1", status: "active" }],
        [{ userId: "user_1", retiredAt: null }],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
        [activeAgentRow()],
      ]),
    );
    const socket = new FakeSocket();
    await bindAgent(socket, handler);

    await emitMessage(socket, { type: "session:state", agentId: "agent_1", chatId: "chat_1", state: "active" });
    await emitMessage(socket, {
      type: "session:runtime",
      agentId: "agent_1",
      chatId: "chat_1",
      runtimeState: "working",
    });
    await emitMessage(socket, { type: "runtime:state", agentId: "agent_1", runtimeState: "idle" });
    await waitUntil(() => vi.mocked(activityService.setSessionRuntime).mock.calls.length > 0);

    expect(activityService.upsertSessionState).toHaveBeenCalledWith(
      expect.anything(),
      "agent_1",
      "chat_1",
      "active",
      "org_1",
      expect.anything(),
    );
    expect(activityService.setSessionRuntime).toHaveBeenCalledWith(
      expect.anything(),
      "agent_1",
      "chat_1",
      "working",
      "org_1",
      expect.anything(),
      // The descriptive background-work marker rides the same frame; a client
      // that omits it asserts nothing, which persists as `false`.
      false,
    );
    expect(presenceService.setRuntimeState).toHaveBeenCalledWith(
      expect.anything(),
      "agent_1",
      "idle",
      expect.objectContaining({ organizationId: "org_1" }),
    );
  });

  it("preserves a session FIFO when a routed message resumes after socket close", async () => {
    mockSuccessfulBindServices();
    let releaseState: (() => void) | undefined;
    const stateBlocked = new Promise<void>((resolve) => {
      releaseState = resolve;
    });
    let resumeRouteCheck: ((rows: unknown[]) => void) | undefined;
    const routeCheckBlocked = new Promise<unknown[]>((resolve) => {
      resumeRouteCheck = resolve;
    });
    const db = queuedDb([
      [{ id: "user_1", status: "active" }],
      [{ userId: "user_1", retiredAt: null }],
      [activeAgentRow()],
      [activeAgentRow()],
      [activeAgentRow()],
      routeCheckBlocked,
    ]) as { select: ReturnType<typeof vi.fn> };
    const { handler } = routeHarness(db);
    const socket = new FakeSocket();
    const order: string[] = [];
    vi.mocked(activityService.upsertSessionState).mockImplementation(async () => {
      order.push("state:start");
      await stateBlocked;
      order.push("state:end");
    });
    const appendEvent = vi.spyOn(sessionEventService, "appendLiveEvent").mockImplementation(async () => {
      order.push("event");
      return null;
    });
    await bindAgent(socket, handler);

    await emitMessage(socket, { type: "session:state", agentId: "agent_1", chatId: "chat_1", state: "active" });
    await waitUntil(() => order.includes("state:start"));

    await emitMessage(socket, {
      type: "session:event",
      agentId: "agent_1",
      chatId: "chat_1",
      event: { kind: "error", payload: { source: "runtime", message: "test" } },
    });
    await waitUntil(() => db.select.mock.calls.length === 6);

    socket.close(1000, "test close");
    resumeRouteCheck?.([activeAgentRow()]);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(appendEvent).not.toHaveBeenCalled();
    expect(order).toEqual(["state:start"]);

    releaseState?.();
    await waitUntil(() => appendEvent.mock.calls.length === 1);
    expect(order).toEqual(["state:start", "state:end", "event"]);
  });
});
