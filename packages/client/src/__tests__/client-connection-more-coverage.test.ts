import { EventEmitter } from "node:events";
import { type ClientPausedReason, runtimeAuthProviderSchema, type SessionEvent } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoundAgent } from "../runtime/client-connection.js";

type ClientConnectionModule = typeof import("../runtime/client-connection.js");
type ClientConnectionInstance = InstanceType<ClientConnectionModule["ClientConnection"]>;
type ClientConnectionConfig = ConstructorParameters<ClientConnectionModule["ClientConnection"]>[0];

type PendingBind = {
  agentId: string;
  runtimeType: string;
  runtimeVersion?: string;
  resolve: (agent: BoundAgent) => void;
  reject: (err: Error) => void;
};

type BindRetryRecord = {
  attempts: number;
  nextAllowedAt: number;
  lastReason: string | null;
};

type ClientConnectionPrivate = {
  ws: FakeWebSocket | null;
  closing: boolean;
  registered: boolean;
  pausedReason: ClientPausedReason | null;
  authRefreshTimer: ReturnType<typeof setTimeout> | null;
  nextReconnectMinDelayMs: number;
  desiredBindings: Map<string, { agentId: string; runtimeType: string; runtimeVersion?: string }>;
  boundAgents: Map<string, BoundAgent>;
  bindRetryRecords: Map<string, BindRetryRecord>;
  pendingBinds: Map<string, PendingBind>;
  openWebSocket(): Promise<void>;
  handleMessage(msg: Record<string, unknown>, connectResolve?: () => void): void;
  sendBind(agentId: string, runtimeType: string, runtimeVersion?: string): Promise<BoundAgent>;
  rebindAgents(): void;
  runProactiveAuthRefresh(): Promise<void>;
  clearTimers(): void;
};

type FakeWebSocketOptions = {
  headers?: Record<string, string>;
};

class FakeWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly options?: FakeWebSocketOptions;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  terminate = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED;
  });
  ping = vi.fn();

  constructor(url: string, options?: FakeWebSocketOptions) {
    super();
    this.url = url;
    this.options = options;
    FakeWebSocket.instances.push(this);
  }

  send(raw: string): void {
    this.sent.push(raw);
  }

  close(code?: number, reason?: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.closeCalls.push({ code, reason });
    this.emit("close", code ?? 1000);
  }

  removeAllListeners(eventName?: string | symbol): this {
    super.removeAllListeners(eventName);
    return this;
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  emitMessage(frame: string | Record<string, unknown>): void {
    this.emit("message", typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  emitPong(): void {
    this.emit("pong");
  }
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function priv(connection: ClientConnectionInstance): ClientConnectionPrivate {
  return connection as unknown as ClientConnectionPrivate;
}

async function loadClientConnection(): Promise<ClientConnectionModule> {
  vi.resetModules();
  FakeWebSocket.instances = [];
  vi.doMock("ws", () => ({ default: FakeWebSocket }));
  return import("../runtime/client-connection.js");
}

async function makeConnection(overrides: Partial<ClientConnectionConfig> = {}): Promise<ClientConnectionInstance> {
  const { ClientConnection } = await loadClientConnection();
  return new ClientConnection({
    serverUrl: "http://ws.test",
    clientId: "client_more_coverage",
    getAccessToken: async () => makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    ...overrides,
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForLatestSocket(previousLength = 0): Promise<FakeWebSocket> {
  for (let i = 0; i < 30; i++) {
    if (FakeWebSocket.instances.length > previousLength) {
      const socket = FakeWebSocket.instances.at(-1);
      if (socket) return socket;
    }
    await Promise.resolve();
  }
  throw new Error("missing fake socket");
}

function parseSent(socket: FakeWebSocket, index: number): Record<string, unknown> {
  return JSON.parse(socket.sent[index] ?? "{}") as Record<string, unknown>;
}

async function openRegisteredConnection(
  connection: ClientConnectionInstance,
  capabilities: Record<string, boolean> = {},
): Promise<FakeWebSocket> {
  const internal = priv(connection);
  const previousLength = FakeWebSocket.instances.length;
  const openPromise = internal.openWebSocket();
  const socket = await waitForLatestSocket(previousLength);
  socket.emitOpen();
  await flushMicrotasks();
  socket.emitMessage({ type: "auth:ok" });
  socket.emitMessage({
    type: "server:welcome",
    serverCommandVersion: "1.0.0",
    serverTimeMs: Date.now(),
    capabilities,
  });
  socket.emitMessage({ type: "client:registered" });
  await openPromise;
  return socket;
}

async function bindAgent(
  connection: ClientConnectionInstance,
  socket: FakeWebSocket,
  agentId = "agent-1",
): Promise<BoundAgent> {
  const bindPromise = priv(connection).sendBind(agentId, "codex");
  const bindFrame = parseSent(socket, socket.sent.length - 1);
  socket.emitMessage({
    type: "agent:bound",
    ref: bindFrame.ref,
    agentId,
    displayName: "Agent One",
    agentType: "agent",
    runtimeSessionToken: `runtime-token-${agentId}`,
  });
  return bindPromise;
}

function sessionEvent(message: string): SessionEvent {
  return { kind: "error", payload: { source: "runtime", message } };
}

describe("ClientConnection — additional branch coverage", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("ws");
    vi.resetModules();
  });

  it("swallows malformed and unknown frames without settling pending confirmations", async () => {
    const connection = await makeConnection();
    const socket = await openRegisteredConnection(connection, {
      wsInboxAckConfirm: true,
      wsSessionEventConfirm: true,
    });
    await bindAgent(connection, socket);

    const delivered: unknown[] = [];
    const commands: unknown[] = [];
    const pins: unknown[] = [];
    const runtimeAuthStarts: unknown[] = [];
    connection.on("inbox:deliver", (inboxId, frame) => delivered.push({ inboxId, frame }));
    connection.on("session:command", (command) => commands.push(command));
    connection.on("agent:pinned", (message) => pins.push(message));
    connection.on("runtime-auth:start", (command) => runtimeAuthStarts.push(command));

    const eventPromise = connection.reportSessionEventConfirmed("agent-1", "chat-1", sessionEvent("pending"));
    const eventFrame = parseSent(socket, socket.sent.length - 1);
    const ackPromise = connection.sendInboxAck(101);
    const ackFrame = parseSent(socket, socket.sent.length - 1);
    const recoverPromise = connection.sendInboxRecover("agent-1", "chat-1");
    const recoverFrame = parseSent(socket, socket.sent.length - 1);

    socket.emitMessage("{not json");
    socket.emitMessage({ type: "unknown:frame", arbitrary: true });
    socket.emitMessage({ type: "agent:pinned", agentId: 42 });
    socket.emitMessage({ type: "runtime-auth:start", provider: "not-a-provider", ref: "bad" });
    socket.emitMessage({ type: "session:suspend", agentId: "agent-1" });
    socket.emitMessage({ type: "session:reconcile:result", agentId: "agent-1", staleChatIds: "chat-1" });
    socket.emitMessage({ type: "session:event:accepted", ref: eventFrame.ref, agentId: "agent-1" });
    socket.emitMessage({
      type: "session:event:accepted",
      ref: eventFrame.ref,
      agentId: "agent-1",
      chatId: "other-chat",
    });
    socket.emitMessage({ type: "inbox:ack:accepted", entryId: 101, ref: "wrong-ref", disposition: "acked" });
    socket.emitMessage({
      type: "inbox:ack:accepted",
      entryId: "bad",
      ref: ackFrame.ref,
      disposition: "acked",
    });
    socket.emitMessage({
      type: "inbox:recover:accepted",
      ref: recoverFrame.ref,
      agentId: "agent-1",
      chatId: "chat-1",
      resetCount: "bad",
    });
    socket.emitMessage({
      type: "inbox:recover:accepted",
      ref: recoverFrame.ref,
      agentId: "agent-1",
      chatId: "other-chat",
      resetCount: 1,
    });
    socket.emitMessage({ type: "inbox:deliver", entryId: "bad", message: { not: "valid" } });

    expect(delivered).toEqual([]);
    expect(commands).toEqual([]);
    expect(pins).toEqual([]);
    expect(runtimeAuthStarts).toEqual([]);

    const deliveredFrame = {
      type: "inbox:deliver",
      entryId: 102,
      inboxId: "inbox-agent-1",
      chatId: "chat-1",
      message: {
        id: "message-1",
        chatId: "chat-1",
        senderId: "agent-sender",
        senderKind: "member",
        senderProvider: null,
        format: "text",
        content: "hello",
        metadata: {},
        inReplyTo: null,
        source: null,
        createdAt: "2026-07-10T00:00:00.000Z",
        configVersion: 1,
        recipientMode: "full",
        precedingMessages: [],
      },
    };
    socket.emitMessage(deliveredFrame);
    expect(delivered).toEqual([{ inboxId: "inbox-agent-1", frame: deliveredFrame }]);

    socket.emitMessage({
      type: "session:event:accepted",
      ref: eventFrame.ref,
      agentId: "agent-1",
      chatId: "chat-1",
    });
    socket.emitMessage({
      type: "inbox:ack:accepted",
      entryId: 101,
      ref: ackFrame.ref,
      disposition: "acked",
    });
    socket.emitMessage({
      type: "inbox:recover:accepted",
      ref: recoverFrame.ref,
      agentId: "agent-1",
      chatId: "chat-1",
      resetCount: 2,
    });

    await expect(eventPromise).resolves.toBeUndefined();
    await expect(ackPromise).resolves.toBeUndefined();
    await expect(recoverPromise).resolves.toEqual({ resetCount: 2, unackedOutstanding: undefined });
  });

  it("times out confirmed session events and keeps later rejection frames from double-settling", async () => {
    vi.useFakeTimers();
    const connection = await makeConnection();
    const socket = await openRegisteredConnection(connection, { wsSessionEventConfirm: true });
    await bindAgent(connection, socket);

    const pending = connection.reportSessionEventConfirmed("agent-1", "chat-timeout", sessionEvent("timeout"));
    const frame = parseSent(socket, socket.sent.length - 1);
    const rejection = expect(pending).rejects.toThrow("session:event rejected (timeout)");

    await vi.advanceTimersByTimeAsync(3_000);
    socket.emitMessage({
      type: "session:event:rejected",
      ref: frame.ref,
      agentId: "agent-1",
      chatId: "chat-timeout",
      reason: "late_rejection",
    });

    await rejection;
  });

  it("rejects agent-scoped recoveries and session events when a rebind is rejected or skipped", async () => {
    const connection = await makeConnection();
    const internal = priv(connection);
    const socket = await openRegisteredConnection(connection, {
      wsInboxAckConfirm: true,
      wsSessionEventConfirm: true,
    });
    await bindAgent(connection, socket);

    const recovering = connection.sendInboxRecover("agent-1", "chat-recover");
    const reporting = connection.reportSessionEventConfirmed("agent-1", "chat-report", sessionEvent("reporting"));
    const rebindPromise = internal.sendBind("agent-1", "codex");
    const rebindFrame = parseSent(socket, socket.sent.length - 1);
    socket.emitMessage({
      type: "agent:bind:rejected",
      ref: rebindFrame.ref,
      reason: "wrong_client",
    });

    await expect(rebindPromise).rejects.toThrow("wrong_client");
    await expect(recovering).rejects.toThrow("agent_bind_rejected:wrong_client");
    await expect(reporting).rejects.toThrow("agent_bind_rejected:wrong_client");

    const skippedRecover = connection.sendInboxRecover("agent-1", "chat-skipped-recover");
    const skippedEvent = connection.reportSessionEventConfirmed(
      "agent-1",
      "chat-skipped-event",
      sessionEvent("skipped"),
    );
    internal.desiredBindings.set("agent-1", { agentId: "agent-1", runtimeType: "codex" });
    internal.bindRetryRecords.set("agent-1", {
      attempts: 2,
      nextAllowedAt: Date.now() + 60_000,
      lastReason: "bind_wrong_client",
    });
    internal.rebindAgents();

    await expect(skippedRecover).rejects.toThrow("agent_rebind_skipped");
    await expect(skippedEvent).rejects.toThrow("agent_rebind_skipped");
  });

  it("handles auth and proactive refresh edges without source changes", async () => {
    const pausedError = new Error("refresh token revoked");
    pausedError.name = "AuthRefreshFailedError";
    let tokenCalls = 0;
    const pausedConnection = await makeConnection({
      getAccessToken: async () => {
        tokenCalls += 1;
        if (tokenCalls === 1) return makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
        throw pausedError;
      },
    });
    const pausedSocket = await openRegisteredConnection(pausedConnection);
    const paused: ClientPausedReason[] = [];
    pausedConnection.on("auth:paused", (reason) => paused.push(reason));

    await priv(pausedConnection).runProactiveAuthRefresh();

    expect(pausedConnection.isPaused()).toBe(true);
    expect(paused).toEqual(["auth_refresh_failed"]);
    expect(pausedSocket.closeCalls).toEqual([]);

    let genericCalls = 0;
    const genericConnection = await makeConnection({
      getAccessToken: async () => {
        genericCalls += 1;
        if (genericCalls === 1) return makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
        throw "plain proactive failure";
      },
    });
    const genericSocket = await openRegisteredConnection(genericConnection);

    await priv(genericConnection).runProactiveAuthRefresh();

    expect(genericSocket.closeCalls.at(-1)).toEqual({ code: 1000, reason: "proactive auth refresh" });
  });

  it("skips proactive timers for malformed, no-exp, and near-expiry tokens", async () => {
    for (const token of ["not-a-jwt", makeJwt({ sub: "user-1" }), makeJwt({ exp: Math.floor(Date.now() / 1000) })]) {
      const connection = await makeConnection({ getAccessToken: async () => token });
      await openRegisteredConnection(connection);

      expect(priv(connection).authRefreshTimer).toBeNull();
      priv(connection).clearTimers();
    }
  });

  it("continues registration when update metadata throws and surfaces socket errors", async () => {
    const connection = await makeConnection({
      getLastUpdateAttempt: () => {
        throw "metadata read failed";
      },
    });
    const errors: string[] = [];
    connection.on("error", (err) => errors.push(err.message));

    const socket = await openRegisteredConnection(connection);
    const registerFrame = socket.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .find((msg) => {
        return msg.type === "client:register";
      });
    expect(registerFrame).toMatchObject({ type: "client:register", clientId: "client_more_coverage" });
    expect(registerFrame).not.toHaveProperty("lastUpdateAttempt");

    socket.emit("error", new Error("socket broke"));

    expect(errors).toEqual(["socket broke"]);
  });

  it("rejects pending binds on error frames and terminates connecting sockets during disconnect", async () => {
    const connection = await makeConnection();
    const socket = await openRegisteredConnection(connection);

    const bindPromise = priv(connection).sendBind("agent-error", "codex");
    const bindFrame = parseSent(socket, socket.sent.length - 1);
    socket.emitMessage({ type: "error", ref: bindFrame.ref, message: "bind failed remotely" });
    await expect(bindPromise).rejects.toThrow("bind failed remotely");

    const unhandledErrors: string[] = [];
    connection.on("error", (err) => unhandledErrors.push(err.message));
    socket.emitMessage({ type: "error", message: "unscoped server error" });
    expect(unhandledErrors).toEqual(["unscoped server error"]);

    const connectingConnection = await makeConnection();
    const connectingSocket = new FakeWebSocket("ws://ws.test/api/v1/agent/ws/client");
    priv(connectingConnection).ws = connectingSocket;
    await connectingConnection.disconnect();

    expect(connectingSocket.terminate).toHaveBeenCalledOnce();
  });

  it("rejects every pending operation during disconnect", async () => {
    const connection = await makeConnection({ clientId: "client_disconnect_pending" });
    const internal = priv(connection);
    const socket = await openRegisteredConnection(connection, {
      wsInboxAckConfirm: true,
      wsSessionEventConfirm: true,
    });
    await bindAgent(connection, socket);

    const pendingBind = internal.sendBind("agent-2", "codex");
    const pendingAck = connection.sendInboxAck(404, "agent-1");
    const pendingRecover = connection.sendInboxRecover("agent-1", "chat-disconnect");
    const pendingEvent = connection.reportSessionEventConfirmed(
      "agent-1",
      "chat-disconnect",
      sessionEvent("disconnect"),
    );
    const rejections = [pendingBind, pendingAck, pendingRecover, pendingEvent].map((pending) =>
      expect(pending).rejects.toThrow("Client disconnected"),
    );

    await connection.disconnect();

    await Promise.all(rejections);
  });

  it("rejects unavailable operations and falls back before reporting unsupported confirmation", async () => {
    const connection = await makeConnection({ clientId: "client_unavailable_operations" });

    connection.clearPaused();
    expect(connection.isPaused()).toBe(false);
    await expect(connection.sendInboxRecover("agent-1", "chat-unavailable")).rejects.toThrow("socket not bound");
    await expect(connection.bindAgent("agent-1", "codex")).rejects.toThrow("Client not connected");

    const socket = await openRegisteredConnection(connection);
    await bindAgent(connection, socket);
    const sentBeforeReport = socket.sent.length;

    await expect(
      connection.reportSessionEventConfirmed("agent-1", "chat-legacy", sessionEvent("legacy")),
    ).rejects.toThrow("confirmation unsupported by server");
    expect(parseSent(socket, sentBeforeReport)).toMatchObject({
      type: "session:event",
      agentId: "agent-1",
      chatId: "chat-legacy",
    });

    priv(connection).clearTimers();
  });

  it("covers legacy inbox acks, duplicate confirmed acks, and rejection confirmations", async () => {
    vi.useFakeTimers();
    const connection = await makeConnection();

    await expect(connection.sendInboxAck(1, "agent-1")).resolves.toBeUndefined();

    const legacySocket = await openRegisteredConnection(connection);
    await bindAgent(connection, legacySocket);
    expect(connection.agents.has("agent-1")).toBe(true);

    await expect(connection.sendInboxAck(2, "agent-1")).resolves.toBeUndefined();
    expect(parseSent(legacySocket, legacySocket.sent.length - 1)).toEqual({ type: "inbox:ack", entryId: 2 });

    const confirmed = await makeConnection({ clientId: "client_confirmed_rejections" });
    const socket = await openRegisteredConnection(confirmed, {
      wsInboxAckConfirm: true,
      wsSessionEventConfirm: true,
    });
    await bindAgent(confirmed, socket);

    const ackPromise = confirmed.sendInboxAck(202, "agent-1");
    const sameAckPromise = confirmed.sendInboxAck(202, "agent-1");
    expect(sameAckPromise).toBe(ackPromise);
    const ackFrame = parseSent(socket, socket.sent.length - 1);
    socket.emitMessage({ type: "inbox:ack:rejected", entryId: "bad", ref: ackFrame.ref, reason: "prefix_gap" });
    socket.emitMessage({ type: "inbox:ack:rejected", entryId: 202, ref: "wrong", reason: "failed_or_dead" });
    socket.emitMessage({ type: "inbox:ack:rejected", entryId: 202, ref: ackFrame.ref, reason: "prefix_gap" });
    await expect(ackPromise).rejects.toThrow("inbox:ack rejected (prefix_gap)");

    const recoverPromise = confirmed.sendInboxRecover("agent-1", "chat-reject");
    const recoverFrame = parseSent(socket, socket.sent.length - 1);
    socket.emitMessage({
      type: "inbox:recover:rejected",
      ref: recoverFrame.ref,
      agentId: 42,
      chatId: "chat-reject",
      reason: "recover_failed",
    });
    socket.emitMessage({
      type: "inbox:recover:rejected",
      ref: recoverFrame.ref,
      agentId: "other-agent",
      chatId: "chat-reject",
      reason: "agent_not_bound",
    });
    socket.emitMessage({
      type: "inbox:recover:rejected",
      ref: recoverFrame.ref,
      agentId: "agent-1",
      chatId: "chat-reject",
      reason: "recover_failed",
    });
    await expect(recoverPromise).rejects.toThrow("inbox:recover rejected (recover_failed)");

    const eventPromise = confirmed.reportSessionEventConfirmed("agent-1", "chat-reject", sessionEvent("reject"));
    const eventFrame = parseSent(socket, socket.sent.length - 1);
    socket.emitMessage({
      type: "session:event:rejected",
      ref: eventFrame.ref,
      agentId: 42,
      chatId: "chat-reject",
      reason: "malformed",
    });
    socket.emitMessage({
      type: "session:event:rejected",
      ref: eventFrame.ref,
      agentId: "other-agent",
      chatId: "chat-reject",
      reason: "agent_not_bound",
    });
    socket.emitMessage({
      type: "session:event:rejected",
      ref: eventFrame.ref,
      agentId: "agent-1",
      chatId: "chat-reject",
      reason: "persist_failed",
    });
    await expect(eventPromise).rejects.toThrow("session:event rejected (persist_failed)");

    priv(connection).clearTimers();
    priv(confirmed).clearTimers();
  });

  it("handles auth control frames and register rejection variants", async () => {
    vi.useFakeTimers();
    const retryable = await makeConnection({ clientId: "client_retryable_auth" });
    const retryableSocket = await openRegisteredConnection(retryable);

    retryableSocket.emitMessage({
      type: "auth:retryable",
      code: "auth_backend_unavailable",
      retryAfterMs: 12_345,
      message: "try later",
    });

    expect(retryableSocket.closeCalls.at(-1)).toEqual({ code: 1013, reason: "auth retryable" });

    const malformedRetryable = await makeConnection({ clientId: "client_retryable_malformed" });
    const malformedRetryableSocket = await openRegisteredConnection(malformedRetryable);
    malformedRetryableSocket.emitMessage({ type: "auth:retryable", code: "unknown_retryable_code" });
    expect(malformedRetryableSocket.closeCalls.at(-1)).toEqual({ code: 1013, reason: "auth retryable" });

    const rejected = await makeConnection({ clientId: "client_auth_rejected" });
    const rejectedSocket = await openRegisteredConnection(rejected);
    const paused: ClientPausedReason[] = [];
    const fatalNames: string[] = [];
    rejected.on("auth:paused", (reason) => paused.push(reason));
    rejected.on("auth:fatal", (err) => fatalNames.push(err.name));

    rejectedSocket.emitMessage({ type: "auth:rejected", code: "invalid_token", message: "bad jwt" });
    rejectedSocket.emitMessage({ type: "auth:rejected", code: "future_code", reason: "legacy bad" });

    expect(rejected.isPaused()).toBe(true);
    expect(paused).toEqual(["auth_rejected", "auth_rejected"]);
    expect(fatalNames).toEqual(["ServerAuthRejectedError", "ServerAuthRejectedError"]);
    expect(rejectedSocket.closeCalls.at(-1)).toEqual({ code: 4401, reason: "auth rejected" });

    const userMismatch = await makeConnection({ clientId: "client_user_mismatch" });
    const userSocket = await openRegisteredConnection(userMismatch);
    const userErrors: string[] = [];
    userMismatch.on("error", (err) => userErrors.push(`${err.name}:${err.message}`));
    userSocket.emitMessage({
      type: "client:register:rejected",
      code: "CLIENT_USER_MISMATCH",
      message: "belongs to somebody else",
    });
    expect(userErrors).toContain("ClientUserMismatchError:belongs to somebody else");

    const orgMismatch = await makeConnection({ clientId: "client_org_mismatch" });
    const orgSocket = await openRegisteredConnection(orgMismatch);
    const orgErrors: string[] = [];
    orgMismatch.on("error", (err) => orgErrors.push(`${err.name}:${err.message}`));
    orgSocket.emitMessage({
      type: "client:register:rejected",
      code: "CLIENT_ORG_MISMATCH",
      message: "wrong org",
    });
    expect(orgErrors).toContain("ClientOrgMismatchError:wrong org");

    const genericRejected = await makeConnection({ clientId: "client_generic_register_rejected" });
    const genericSocket = await openRegisteredConnection(genericRejected);
    const genericErrors: string[] = [];
    genericRejected.on("error", (err) => genericErrors.push(`${err.name}:${err.message}`));
    genericSocket.emitMessage({ type: "client:register:rejected", message: "schema drift" });
    expect(genericErrors).toContain("Error:client:register rejected: schema drift");

    for (const conn of [retryable, malformedRetryable, rejected, userMismatch, orgMismatch, genericRejected]) {
      priv(conn).clearTimers();
    }
  }, 10_000);

  it("covers rebind recovery, rebind rejection, force disconnect, and control events", async () => {
    const connection = await makeConnection();
    const socket = await openRegisteredConnection(connection, {
      wsInboxAckConfirm: true,
      wsSessionEventConfirm: true,
    });
    await bindAgent(connection, socket, "agent-1");

    const unbound: Array<{ agentId: string; reason?: string }> = [];
    const recovered: unknown[] = [];
    const commands: unknown[] = [];
    const runtimeAuthStarts: unknown[] = [];
    const reconciles: unknown[] = [];
    connection.on("agent:unbound", (agentId, reason) => unbound.push({ agentId, reason }));
    connection.on("resilience.bind.recovered", (payload) => recovered.push(payload));
    connection.on("session:command", (command) => commands.push(command));
    connection.on("runtime-auth:start", (command) => runtimeAuthStarts.push(command));
    connection.on("session:reconcile:result", (result) => reconciles.push(result));

    const pendingRecover = connection.sendInboxRecover("agent-1", "chat-force");
    const pendingEvent = connection.reportSessionEventConfirmed("agent-1", "chat-force", sessionEvent("force"));
    connection.sendInboxAck(303, "agent-1").catch(() => undefined);

    socket.emitMessage({ type: "agent:force_disconnect", agentId: "agent-1", reason: "maintenance" });
    await expect(pendingRecover).rejects.toThrow("agent_force_disconnect");
    await expect(pendingEvent).rejects.toThrow("agent_force_disconnect");
    expect(unbound).toContainEqual({ agentId: "agent-1", reason: "maintenance" });

    priv(connection).desiredBindings.set("agent-1", {
      agentId: "agent-1",
      runtimeType: "codex",
      runtimeVersion: "1.0",
    });
    priv(connection).bindRetryRecords.set("agent-1", {
      attempts: 3,
      nextAllowedAt: 0,
      lastReason: "bind_wrong_client",
    });
    priv(connection).rebindAgents();

    const reboundFrame = parseSent(socket, socket.sent.length - 1);
    socket.emitMessage({
      type: "agent:bound",
      ref: reboundFrame.ref,
      agentId: "agent-1",
      displayName: null,
      runtimeSessionToken: "",
    });
    await flushMicrotasks();
    expect(recovered).toContainEqual({ agentId: "agent-1", totalAttempts: 3 });
    expect(connection.agents.get("agent-1")?.displayName).toBe("agent-1");

    priv(connection).desiredBindings.set("agent-2", { agentId: "agent-2", runtimeType: "codex" });
    priv(connection).bindRetryRecords.set("agent-2", {
      attempts: 1,
      nextAllowedAt: 0,
      lastReason: "bind_retryable",
    });
    priv(connection).rebindAgents();
    const rejectedFrame = parseSent(socket, socket.sent.length - 1);
    socket.emitMessage({
      type: "agent:bind:rejected",
      ref: rejectedFrame.ref,
      reason: "wrong_client",
    });
    await flushMicrotasks();
    expect(unbound).toContainEqual({ agentId: "agent-2" });

    socket.emitMessage({ type: "agent:unbound", agentId: "agent-1" });
    expect(unbound).toContainEqual({ agentId: "agent-1" });

    socket.emitMessage({ type: "session:resume", agentId: "agent-1", chatId: "chat-1" });
    socket.emitMessage({ type: "runtime-auth:start", provider: "codex", method: "browser", ref: "auth-ref" });
    socket.emitMessage({ type: "session:reconcile:result", agentId: "agent-1", staleChatIds: ["chat-1"] });

    expect(commands).toContainEqual({ type: "session:resume", agentId: "agent-1", chatId: "chat-1" });
    expect(runtimeAuthStarts).toContainEqual({ provider: "codex", method: "browser", ref: "auth-ref" });
    expect(reconciles).toContainEqual({ agentId: "agent-1", staleChatIds: ["chat-1"] });

    priv(connection).clearTimers();
  });

  it("emits a typed runtime-auth start for every legal target and for nothing else", async () => {
    const connection = await makeConnection();
    const socket = await openRegisteredConnection(connection);
    await bindAgent(connection, socket);

    const starts: Array<{ provider: string }> = [];
    connection.on("runtime-auth:start", (command) => starts.push(command));

    // The wire already narrows Connect to these four targets; the daemon now
    // dispatches on that key, so an out-of-set target must never reach it.
    // `claude-code-tui` shares Claude's credential and Kimi is a host login.
    for (const provider of runtimeAuthProviderSchema.options) {
      socket.emitMessage({ type: "runtime-auth:start", provider, method: "browser", ref: `ref-${provider}` });
    }
    for (const provider of ["claude-code-tui", "kimi", "opencode", "pi"]) {
      socket.emitMessage({ type: "runtime-auth:start", provider, method: "browser", ref: `ref-${provider}` });
    }

    expect(starts.map((s) => s.provider)).toEqual([...runtimeAuthProviderSchema.options]);

    priv(connection).clearTimers();
  });

  it("advertises no Reset capability at all to a server that never offered v1", async () => {
    const connection = await makeConnection();
    // This harness emits `auth:ok` before `server:welcome` and advertises
    // nothing — an old server. The client must not promise a protocol that
    // server cannot complete, and must NOT fall back to the legacy apply-only
    // flag: an old server reads that as Reset consent, runs the pre-finalize
    // flow, and leaves this client parked behind a fence forever.
    const socket = await openRegisteredConnection(connection);

    const registerFrame = socket.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .find((message) => message.type === "client:register");
    expect(registerFrame?.wireCapabilities).toEqual({});
    expect(connection.supportsSessionResetV1).toBe(false);

    const commands: unknown[] = [];
    connection.on("session:command", (command) => commands.push(command));
    socket.emitMessage({ type: "session:terminate", agentId: "agent-1", chatId: "chat-9", ref: "reset-1" });
    socket.emitMessage({ type: "session:terminate", agentId: "agent-1", chatId: "chat-9" });
    expect(commands).toEqual([
      { type: "session:terminate", agentId: "agent-1", chatId: "chat-9", ref: "reset-1" },
      { type: "session:terminate", agentId: "agent-1", chatId: "chat-9" },
    ]);

    priv(connection).clearTimers();
  });

  it("declares composite Reset v1 to a server that advertises it and answers finalized frames", async () => {
    const connection = await makeConnection();
    const internal = priv(connection);
    const openPromise = internal.openWebSocket();
    const socket = await waitForLatestSocket();
    socket.emitOpen();
    await flushMicrotasks();
    // New server ordering: welcome first, so `client:register` can answer it.
    socket.emitMessage({
      type: "server:welcome",
      serverCommandVersion: "1.0.0",
      serverTimeMs: Date.now(),
      capabilities: { wsSessionResetV1: true },
    });
    socket.emitMessage({ type: "auth:ok" });
    socket.emitMessage({ type: "client:registered" });
    await openPromise;

    const registerFrame = socket.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .find((message) => message.type === "client:register");
    // Composite only: the legacy apply-only flag never rides along, so no
    // server can mistake this client for a pre-v1 one.
    expect(registerFrame?.wireCapabilities).toEqual({ wsSessionResetV1: true });
    expect(connection.supportsSessionResetV1).toBe(true);

    await bindAgent(connection, socket);
    const finalized: unknown[] = [];
    connection.on("session:command:finalized", (frame) => finalized.push(frame));

    // A finalized frame without its rendezvous ref is unanswerable — dropped.
    socket.emitMessage({
      type: "session:command:finalized",
      ref: "reset-1",
      agentId: "agent-1",
      chatId: "chat-9",
      command: "session:terminate",
      state: "evicted",
    });
    expect(finalized).toEqual([]);

    socket.emitMessage({
      type: "session:command:finalized",
      ref: "reset-1",
      ackRef: "ack-1",
      agentId: "agent-1",
      chatId: "chat-9",
      command: "session:terminate",
      state: "evicted",
    });
    expect(finalized).toEqual([
      {
        type: "session:command:finalized",
        ref: "reset-1",
        ackRef: "ack-1",
        agentId: "agent-1",
        chatId: "chat-9",
        command: "session:terminate",
        state: "evicted",
      },
    ]);

    connection.reportSessionCommandFinalizedAck({
      ref: "reset-1",
      ackRef: "ack-1",
      agentId: "agent-1",
      chatId: "chat-9",
      command: "session:terminate",
      released: true,
    });
    expect(parseSent(socket, socket.sent.length - 1)).toEqual({
      type: "session:command:finalized:ack",
      ref: "reset-1",
      ackRef: "ack-1",
      agentId: "agent-1",
      chatId: "chat-9",
      command: "session:terminate",
      released: true,
    });

    // A new socket must re-learn support rather than trust the last server —
    // the next connection may land on a rolled-back replica.
    void internal.openWebSocket().catch(() => {});
    const reconnected = await waitForLatestSocket(1);
    if (reconnected === socket) throw new Error("missing reconnect socket");
    reconnected.emitOpen();
    await flushMicrotasks();
    expect(connection.supportsSessionResetV1).toBe(false);

    priv(connection).clearTimers();
  });

  it("treats a pre-v1 server Reset advertisement as no Reset capability", async () => {
    const connection = await makeConnection();
    const internal = priv(connection);
    const openPromise = internal.openWebSocket();
    const socket = await waitForLatestSocket();
    socket.emitOpen();
    await flushMicrotasks();
    // Mixed fleet: a server build that only knows the pre-v1 finalize flag.
    // Version skew must be decided from the advertised version alone, so this
    // client stays silent and refuses the ref'd Reset later.
    socket.emitMessage({
      type: "server:welcome",
      serverCommandVersion: "0.15.0",
      serverTimeMs: Date.now(),
      capabilities: { wsSessionResetFinalizeHandshake: true },
    });
    socket.emitMessage({ type: "auth:ok" });
    socket.emitMessage({ type: "client:registered" });
    await openPromise;

    const registerFrame = socket.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .find((message) => message.type === "client:register");
    expect(registerFrame?.wireCapabilities).toEqual({});
    expect(connection.supportsSessionResetV1).toBe(false);

    priv(connection).clearTimers();
  });
});

describe("characterization — inbox:deliver identity and deferred ACK", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("ws");
    vi.resetModules();
  });

  it("emits frame.inboxId as the first listener arg and does not ACK merely on deliver", async () => {
    const connection = await makeConnection();
    const socket = await openRegisteredConnection(connection, { wsInboxAckConfirm: true });
    await bindAgent(connection, socket);

    const received: Array<{ firstArg: string; inboxId: string; entryId: number }> = [];
    connection.on("inbox:deliver", (firstArg, frame) => {
      received.push({ firstArg, inboxId: frame.inboxId, entryId: frame.entryId });
    });

    const sentBefore = socket.sent.length;
    const deliveredFrame = {
      type: "inbox:deliver",
      entryId: 777,
      inboxId: "inbox-agent-1",
      chatId: "chat-char",
      message: {
        id: "message-char",
        chatId: "chat-char",
        senderId: "agent-sender",
        format: "text",
        content: "hello",
        metadata: {},
        inReplyTo: null,
        source: null,
        createdAt: "2026-07-10T00:00:00.000Z",
        configVersion: 1,
        recipientMode: "full",
        precedingMessages: [],
      },
    };
    socket.emitMessage(deliveredFrame);
    await flushMicrotasks();

    expect(received).toEqual([{ firstArg: "inbox-agent-1", inboxId: "inbox-agent-1", entryId: 777 }]);
    // Receiving a deliver frame must not emit inbox:ack — ACK is owned by the
    // handler turn completion path (SessionRuntime → ackEntry → sendInboxAck).
    const newFrames = socket.sent.slice(sentBefore).map((raw) => JSON.parse(raw) as { type?: string });
    expect(newFrames.every((frame) => frame.type !== "inbox:ack")).toBe(true);

    // Explicit ACK path remains available and is the only ClientConnection ACK surface.
    const ackPromise = connection.sendInboxAck(777, "agent-1");
    const ackFrame = parseSent(socket, socket.sent.length - 1);
    expect(ackFrame.type).toBe("inbox:ack");
    expect(ackFrame.entryId).toBe(777);
    socket.emitMessage({
      type: "inbox:ack:accepted",
      entryId: 777,
      ref: ackFrame.ref,
      disposition: "acked",
    });
    await expect(ackPromise).resolves.toBeUndefined();

    priv(connection).clearTimers();
  });
});
