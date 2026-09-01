import { EventEmitter } from "node:events";
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

type ClientConnectionPrivate = {
  ws: FakeWebSocket | null;
  closing: boolean;
  registered: boolean;
  pausedReason: "auth_rejected" | "auth_refresh_failed" | null;
  nextReconnectMinDelayMs: number;
  desiredBindings: Map<string, { agentId: string; runtimeType: string; runtimeVersion?: string }>;
  boundAgents: Map<string, BoundAgent>;
  pendingBinds: Map<string, PendingBind>;
  openWebSocket(): Promise<void>;
  handleMessage(msg: Record<string, unknown>, connectResolve?: () => void): void;
  sendBind(agentId: string, runtimeType: string, runtimeVersion?: string): Promise<BoundAgent>;
  rebindAgents(): void;
  scheduleReconnect(): void;
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
    clientId: "client_ws_coverage",
    getAccessToken: async () => makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    ...overrides,
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function parseSent(socket: FakeWebSocket, index: number): Record<string, unknown> {
  return JSON.parse(socket.sent[index] ?? "{}") as Record<string, unknown>;
}

async function openRegisteredConnection(
  connection: ClientConnectionInstance,
  capabilities: Record<string, boolean> = {},
) {
  const internal = priv(connection);
  const openPromise = internal.openWebSocket();
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("missing fake socket");
  socket.emitOpen();
  await flushMicrotasks();
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

describe("ClientConnection — WebSocket edge coverage", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("ws");
    vi.resetModules();
  });

  it("covers successful mocked open, malformed frames, pong, and user-agent headers", async () => {
    vi.useFakeTimers();
    const connection = await makeConnection({ userAgent: "first-tree-test" });
    const internal = priv(connection);

    const openPromise = internal.openWebSocket();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("missing fake socket");

    expect(socket.url).toBe("ws://ws.test/api/v1/agent/ws/client");
    expect(socket.options).toEqual({ headers: { "User-Agent": "first-tree-test" } });

    socket.emitMessage("{bad json");
    socket.emitPong();
    socket.emitOpen();
    await flushMicrotasks();
    expect(JSON.parse(socket.sent[0] ?? "{}")).toMatchObject({ type: "auth" });

    socket.emitMessage({ type: "client:registered" });
    await expect(openPromise).resolves.toBeUndefined();

    internal.clearTimers();
  });

  it("covers the connect timeout path and late settle guard", async () => {
    vi.useFakeTimers();
    const connection = await makeConnection();
    const internal = priv(connection);

    const openPromise = internal.openWebSocket();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("missing fake socket");

    expect(socket.options).toBeUndefined();

    const rejection = expect(openPromise).rejects.toThrow("WebSocket connect timeout");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(socket.terminate).toHaveBeenCalledOnce();

    socket.emitOpen();
    await flushMicrotasks();
    socket.emitMessage({ type: "client:registered" });

    internal.clearTimers();
  });

  it("covers auth failures during open, including rate-limit retry floors", async () => {
    const rateLimited = new Error("limited");
    rateLimited.name = "AuthRefreshRateLimitedError";
    const rateLimitedConnection = await makeConnection({
      getAccessToken: async () => {
        throw rateLimited;
      },
    });
    const rateLimitedPromise = priv(rateLimitedConnection).openWebSocket();
    const rateLimitedRejection = expect(rateLimitedPromise).rejects.toThrow("limited");
    const rateLimitedSocket = FakeWebSocket.instances[0];
    if (!rateLimitedSocket) throw new Error("missing fake socket");
    rateLimitedSocket.emitOpen();

    await rateLimitedRejection;
    expect(priv(rateLimitedConnection).nextReconnectMinDelayMs).toBe(30_000);
    expect(rateLimitedSocket.closeCalls.length).toBe(1);

    const plainConnection = await makeConnection({
      getAccessToken: async () => {
        throw "plain auth failure";
      },
    });
    const plainPromise = priv(plainConnection).openWebSocket();
    const plainRejection = expect(plainPromise).rejects.toThrow("plain auth failure");
    const plainSocket = FakeWebSocket.instances[0];
    if (!plainSocket) throw new Error("missing fake socket");
    plainSocket.emitOpen();

    await plainRejection;
    expect(plainSocket.closeCalls.length).toBe(1);
  });

  it("does not send post-auth frames before the auth frame during open", async () => {
    let resolveToken!: (token: string) => void;
    const tokenPromise = new Promise<string>((resolve) => {
      resolveToken = resolve;
    });
    const connection = await makeConnection({
      getAccessToken: async () => tokenPromise,
    });
    const internal = priv(connection);

    const openPromise = internal.openWebSocket();
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("missing fake socket");

    socket.emitOpen();
    await flushMicrotasks();

    connection.reportSessionState("agent-1", "chat-1", "active");
    connection.reportRuntimeState("agent-1", "working");
    connection.reportSessionRuntime("agent-1", "chat-1", { runtimeState: "working", backgroundWork: false });
    connection.reportSessionEvent("agent-1", "chat-1", {
      kind: "error",
      payload: { source: "runtime", message: "still handshaking" },
    });
    connection.sendSessionReconcile("agent-1", ["chat-1"]);
    await connection.unbindAgent("agent-1");
    await expect(connection.sendInboxAck(50, "agent-1")).resolves.toBeUndefined();

    expect(socket.sent).toEqual([]);

    resolveToken(makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }));
    await flushMicrotasks();
    expect(parseSent(socket, 0)).toMatchObject({ type: "auth" });

    socket.emitMessage({ type: "auth:ok" });
    socket.emitMessage({ type: "client:registered" });
    await openPromise;

    internal.clearTimers();
  });

  it("does not send agent data-plane frames before the agent is bound on the current socket", async () => {
    const connection = await makeConnection();
    const socket = await openRegisteredConnection(connection);
    const start = socket.sent.length;

    connection.reportSessionState("agent-1", "chat-1", "active");
    connection.reportRuntimeState("agent-1", "working");
    connection.reportSessionRuntime("agent-1", "chat-1", { runtimeState: "working", backgroundWork: false });
    connection.reportSessionEvent("agent-1", "chat-1", {
      kind: "error",
      payload: { source: "runtime", message: "before bind" },
    });
    connection.sendSessionReconcile("agent-1", ["chat-1"]);
    await connection.unbindAgent("agent-1");
    await expect(connection.sendInboxAck(50, "agent-1")).resolves.toBeUndefined();

    expect(socket.sent.slice(start)).toEqual([]);

    priv(connection).clearTimers();
  });

  it("sends agent data-plane frames after the agent is bound on the current socket", async () => {
    const connection = await makeConnection();
    const internal = priv(connection);
    const socket = await openRegisteredConnection(connection, { wsInboxAckConfirm: true });

    const bindPromise = internal.sendBind("agent-1", "codex");
    const bindFrame = parseSent(socket, socket.sent.length - 1);
    socket.emitMessage({
      type: "agent:bound",
      ref: bindFrame.ref,
      agentId: "agent-1",
      displayName: "Agent One",
      agentType: "agent",
      runtimeSessionToken: "runtime-token-1",
    });
    const bound = await bindPromise;
    expect(bound.runtimeSessionToken).toBe("runtime-token-1");
    expect(bound.sdk.runtimeSessionToken).toBe("runtime-token-1");

    const start = socket.sent.length;
    connection.reportSessionState("agent-1", "chat-1", "active");
    connection.reportRuntimeState("agent-1", "working");
    connection.reportSessionRuntime("agent-1", "chat-1", { runtimeState: "working", backgroundWork: false });
    connection.reportSessionEvent("agent-1", "chat-1", {
      kind: "error",
      payload: { source: "runtime", message: "after bind" },
    });
    connection.sendSessionReconcile("agent-1", ["chat-1"]);
    await connection.unbindAgent("agent-1");

    const sentTypes = socket.sent.slice(start).map((raw) => (JSON.parse(raw) as { type?: string }).type);
    expect(sentTypes).toEqual([
      "session:state",
      "runtime:state",
      "session:runtime",
      "session:event",
      "session:reconcile",
      "agent:unbind",
    ]);
  });

  it("keeps bind token presentation out of agent:bind while SDK reads the token provider", async () => {
    const connection = await makeConnection();
    const internal = priv(connection);
    const socket = await openRegisteredConnection(connection);
    let currentToken = "runtime-token-file-1";
    connection.setRuntimeSessionTokenProvider("agent-1", () => currentToken);

    const bindPromise = internal.sendBind("agent-1", "codex");
    const bindFrame = parseSent(socket, socket.sent.length - 1);
    expect(bindFrame).toMatchObject({
      type: "agent:bind",
      agentId: "agent-1",
    });
    expect(bindFrame).not.toHaveProperty("currentRuntimeSessionToken");

    socket.emitMessage({
      type: "agent:bound",
      ref: bindFrame.ref,
      agentId: "agent-1",
      displayName: "Agent One",
      agentType: "agent",
      runtimeSessionToken: "runtime-token-minted",
    });
    const bound = await bindPromise;
    expect(bound.runtimeSessionToken).toBe("runtime-token-minted");
    expect(bound.sdk.runtimeSessionToken).toBe("runtime-token-file-1");

    currentToken = "runtime-token-file-2";
    expect(bound.sdk.runtimeSessionToken).toBe("runtime-token-file-2");
  });

  it("sends confirmed session events and settles on accepted or rejected frames", async () => {
    const connection = await makeConnection();
    const internal = priv(connection);
    const socket = await openRegisteredConnection(connection, { wsSessionEventConfirm: true });

    const bindPromise = internal.sendBind("agent-1", "codex");
    const bindFrame = parseSent(socket, socket.sent.length - 1);
    socket.emitMessage({
      type: "agent:bound",
      ref: bindFrame.ref,
      agentId: "agent-1",
      displayName: "Agent One",
      agentType: "agent",
    });
    await bindPromise;

    const accepted = connection.reportSessionEventConfirmed("agent-1", "chat-1", {
      kind: "error",
      payload: { source: "runtime", message: "confirmed" },
    });
    const acceptedFrame = parseSent(socket, socket.sent.length - 1);
    expect(acceptedFrame).toMatchObject({ type: "session:event", agentId: "agent-1", chatId: "chat-1" });
    expect(typeof acceptedFrame.ref).toBe("string");

    socket.emitMessage({
      type: "session:event:accepted",
      ref: acceptedFrame.ref,
      agentId: "agent-1",
      chatId: "chat-1",
    });
    await expect(accepted).resolves.toBeUndefined();

    const rejected = connection.reportSessionEventConfirmed("agent-1", "chat-2", {
      kind: "error",
      payload: { source: "runtime", message: "rejected" },
    });
    const rejectedFrame = parseSent(socket, socket.sent.length - 1);
    socket.emitMessage({
      type: "session:event:rejected",
      ref: rejectedFrame.ref,
      agentId: "agent-1",
      chatId: "chat-2",
      reason: "persist_failed",
    });
    await expect(rejected).rejects.toThrow("persist_failed");
  });

  it("rejects confirmed session events when the agent is not bound on the current socket", async () => {
    const connection = await makeConnection();
    await openRegisteredConnection(connection, { wsSessionEventConfirm: true });

    await expect(
      connection.reportSessionEventConfirmed("agent-1", "chat-1", {
        kind: "error",
        payload: { source: "runtime", message: "not bound" },
      }),
    ).rejects.toThrow("socket not bound");
  });

  it("covers non-Error initial connect failures and paused-after-backoff exit", async () => {
    vi.useFakeTimers();
    const connection = await makeConnection();
    const internal = priv(connection);
    const errors: string[] = [];
    internal.openWebSocket = vi.fn(async () => {
      throw "plain connect failure";
    });
    connection.on("error", (err) => errors.push(err.message));

    const connectPromise = connection.connect();
    const rejection = expect(connectPromise).rejects.toBe("plain connect failure");
    await flushMicrotasks();
    internal.pausedReason = "auth_rejected";
    await vi.advanceTimersByTimeAsync(1000);

    await rejection;
    expect(errors).toEqual(["plain connect failure"]);
  });

  it("covers non-Error rebind and reconnect catches", async () => {
    vi.useFakeTimers();
    const connection = await makeConnection();
    const internal = priv(connection);
    const events: string[] = [];
    connection.on("agent:unbound", (agentId) => events.push(`unbound:${agentId}`));
    connection.on("error", (err) => {
      events.push(`error:${err.message}`);
      internal.closing = true;
    });

    internal.desiredBindings.set("agent_plain", { agentId: "agent_plain", runtimeType: "codex" });
    internal.sendBind = vi.fn(async () => {
      throw "plain rebind failure";
    });
    internal.rebindAgents();
    await flushMicrotasks();
    expect(events).toContain("unbound:agent_plain");

    internal.closing = false;
    internal.openWebSocket = vi.fn(async () => {
      throw "plain reconnect failure";
    });
    internal.scheduleReconnect();
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(events).toContain("error:plain reconnect failure");

    internal.clearTimers();
  });

  it("emits force-disconnect reason on agent:unbound", async () => {
    const connection = await makeConnection();
    const internal = priv(connection);
    const events: Array<{ agentId: string; reason?: string }> = [];
    connection.on("agent:unbound", (agentId, reason) => events.push({ agentId, reason }));

    internal.boundAgents.set("agent-suspended", {
      agentId: "agent-suspended",
      displayName: "Suspended Agent",
      agentType: "agent",
      sdk: {} as BoundAgent["sdk"],
    });

    internal.handleMessage({
      type: "agent:force_disconnect",
      agentId: "agent-suspended",
      reason: "agent_suspended",
    });

    expect(events).toEqual([{ agentId: "agent-suspended", reason: "agent_suspended" }]);
    expect(internal.boundAgents.has("agent-suspended")).toBe(false);
  });

  it("covers proactive refresh rate-limit fallback without Retry-After", async () => {
    const rateLimited = new Error("limited");
    rateLimited.name = "AuthRefreshRateLimitedError";
    const connection = await makeConnection({
      getAccessToken: async () => {
        throw rateLimited;
      },
    });
    const internal = priv(connection);

    await internal.runProactiveAuthRefresh();

    expect(internal.nextReconnectMinDelayMs).toBe(30_000);
  });

  it("sends confirmed inbox ACKs with refs and resolves on accepted", async () => {
    const connection = await makeConnection();
    const socket = await openRegisteredConnection(connection, { wsInboxAckConfirm: true });

    const ackPromise = connection.sendInboxAck(42);
    const frame = parseSent(socket, socket.sent.length - 1);
    expect(frame).toMatchObject({ type: "inbox:ack", entryId: 42 });
    expect(typeof frame.ref).toBe("string");

    socket.emitMessage({
      type: "inbox:ack:accepted",
      entryId: 42,
      ref: frame.ref,
      disposition: "acked",
    });
    await expect(ackPromise).resolves.toBeUndefined();
  });

  it("falls back to legacy inbox ACKs when the server does not advertise confirmations", async () => {
    const connection = await makeConnection();
    const socket = await openRegisteredConnection(connection, {});

    await expect(connection.sendInboxAck(43)).resolves.toBeUndefined();
    expect(parseSent(socket, socket.sent.length - 1)).toEqual({ type: "inbox:ack", entryId: 43 });
  });

  it("coalesces duplicate confirmed inbox ACKs and rejects on server rejection", async () => {
    const connection = await makeConnection();
    const socket = await openRegisteredConnection(connection, { wsInboxAckConfirm: true });

    const first = connection.sendInboxAck(44);
    const second = connection.sendInboxAck(44);
    expect(second).toBe(first);
    const ackFrames = socket.sent
      .map((raw) => JSON.parse(raw) as { type?: string })
      .filter((m) => m.type === "inbox:ack");
    expect(ackFrames).toHaveLength(1);
    const frame = parseSent(socket, socket.sent.length - 1);

    socket.emitMessage({
      type: "inbox:ack:rejected",
      entryId: 44,
      ref: frame.ref,
      reason: "not_found_or_not_bound",
    });
    await expect(first).rejects.toThrow("not_found_or_not_bound");
  });

  it("retries confirmed inbox ACKs after timeout using the same ref", async () => {
    vi.useFakeTimers();
    const connection = await makeConnection();
    const socket = await openRegisteredConnection(connection, { wsInboxAckConfirm: true });

    const ackPromise = connection.sendInboxAck(45);
    const first = parseSent(socket, socket.sent.length - 1);
    await vi.advanceTimersByTimeAsync(3000);
    const retry = parseSent(socket, socket.sent.length - 1);

    expect(retry).toEqual(first);
    socket.emitMessage({
      type: "inbox:ack:accepted",
      entryId: 45,
      ref: first.ref,
      disposition: "acked",
    });
    await expect(ackPromise).resolves.toBeUndefined();
    expect(socket.closeCalls).toHaveLength(0);
  });

  it("fail-closes confirmed inbox ACKs after the second timeout without sending a third frame", async () => {
    vi.useFakeTimers();
    const connection = await makeConnection();
    const events: string[] = [];
    connection.on("reconnecting", () => events.push("reconnecting"));
    const socket = await openRegisteredConnection(connection, { wsInboxAckConfirm: true });

    const firstAck = connection.sendInboxAck(80);
    const secondAck = connection.sendInboxAck(81);
    const initialAckFrames = socket.sent
      .map((raw) => JSON.parse(raw) as { type?: string; entryId?: number; ref?: string })
      .filter((message) => message.type === "inbox:ack");
    expect(initialAckFrames).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3000);
    const ackFramesAfterRetry = socket.sent
      .map((raw) => JSON.parse(raw) as { type?: string; entryId?: number; ref?: string })
      .filter((message) => message.type === "inbox:ack");
    expect(ackFramesAfterRetry).toHaveLength(4);
    expect(ackFramesAfterRetry[2]).toEqual(initialAckFrames[0]);
    expect(ackFramesAfterRetry[3]).toEqual(initialAckFrames[1]);

    const firstRejection = expect(firstAck).rejects.toThrow("inbox ack timeout");
    const secondRejection = expect(secondAck).rejects.toThrow("inbox ack timeout");
    await vi.advanceTimersByTimeAsync(3000);
    await firstRejection;
    await secondRejection;

    const ackFramesAfterClose = socket.sent
      .map((raw) => JSON.parse(raw) as { type?: string })
      .filter((message) => message.type === "inbox:ack");
    expect(ackFramesAfterClose).toHaveLength(4);
    expect(socket.closeCalls).toEqual([{ code: 1011, reason: "inbox ack timeout" }]);
    expect(events).toContain("reconnecting");

    priv(connection).clearTimers();
  });

  it("fail-closes when the pending confirmed ACK cap is hit", async () => {
    const connection = await makeConnection();
    const socket = await openRegisteredConnection(connection, { wsInboxAckConfirm: true });

    const pending = Array.from({ length: 1024 }, (_, index) => connection.sendInboxAck(index + 1, "agent-cap"));
    const overflow = connection.sendInboxAck(2000, "agent-cap");
    await expect(overflow).rejects.toThrow("inbox ack timeout");
    await Promise.all(pending.map((ack) => expect(ack).rejects.toThrow("inbox ack timeout")));
    expect(socket.closeCalls).toEqual([{ code: 1011, reason: "inbox ack timeout" }]);
    expect(
      socket.sent.map((raw) => JSON.parse(raw) as { type?: string }).filter((message) => message.type === "inbox:ack"),
    ).toHaveLength(0);

    priv(connection).clearTimers();
  });

  it("sends inbox recovery requests and settles on accepted or rejected frames", async () => {
    const connection = await makeConnection();
    const internal = priv(connection);
    const socket = await openRegisteredConnection(connection, { wsInboxAckConfirm: true });

    const bindPromise = internal.sendBind("agent-1", "codex");
    const bindFrame = parseSent(socket, socket.sent.length - 1);
    socket.emitMessage({
      type: "agent:bound",
      ref: bindFrame.ref,
      agentId: "agent-1",
      displayName: "Agent One",
      agentType: "agent",
    });
    await bindPromise;

    const accepted = connection.sendInboxRecover("agent-1", "chat-1");
    const recoverFrame = parseSent(socket, socket.sent.length - 1);
    expect(recoverFrame).toMatchObject({ type: "inbox:recover", agentId: "agent-1", chatId: "chat-1" });
    expect(typeof recoverFrame.ref).toBe("string");

    socket.emitMessage({
      type: "inbox:recover:accepted",
      ref: recoverFrame.ref,
      agentId: "agent-1",
      chatId: "chat-1",
      resetCount: 1,
      unackedOutstanding: 3,
    });
    await expect(accepted).resolves.toEqual({ resetCount: 1, unackedOutstanding: 3 });

    const rejected = connection.sendInboxRecover("agent-1", "chat-2");
    const rejectFrame = parseSent(socket, socket.sent.length - 1);
    socket.emitMessage({
      type: "inbox:recover:rejected",
      ref: rejectFrame.ref,
      agentId: "agent-1",
      chatId: "chat-2",
      reason: "recover_failed",
    });
    await expect(rejected).rejects.toThrow("recover_failed");
    expect(socket.closeCalls).toHaveLength(0);
  });

  it("sends fence probes and settles on accepted or rejected frames without any destructive effect", async () => {
    const connection = await makeConnection();
    const internal = priv(connection);
    const socket = await openRegisteredConnection(connection, { wsInboxAckConfirm: true });

    const bindPromise = internal.sendBind("agent-1", "codex");
    const bindFrame = parseSent(socket, socket.sent.length - 1);
    socket.emitMessage({
      type: "agent:bound",
      ref: bindFrame.ref,
      agentId: "agent-1",
      displayName: "Agent One",
      agentType: "agent",
    });
    await bindPromise;

    const accepted = connection.sendInboxFenceProbe("agent-1", "chat-1", ["msg-1", "msg-2"]);
    const probeFrame = parseSent(socket, socket.sent.length - 1);
    expect(probeFrame).toMatchObject({
      type: "inbox:fence-probe",
      agentId: "agent-1",
      chatId: "chat-1",
      messageIds: ["msg-1", "msg-2"],
    });
    expect(typeof probeFrame.ref).toBe("string");

    socket.emitMessage({
      type: "inbox:fence-probe:accepted",
      ref: probeFrame.ref,
      agentId: "agent-1",
      chatId: "chat-1",
      settledMessageIds: ["msg-1"],
    });
    await expect(accepted).resolves.toEqual({ settledMessageIds: ["msg-1"] });

    const rejected = connection.sendInboxFenceProbe("agent-1", "chat-2", ["msg-3"]);
    const rejectFrame = parseSent(socket, socket.sent.length - 1);
    socket.emitMessage({
      type: "inbox:fence-probe:rejected",
      ref: rejectFrame.ref,
      agentId: "agent-1",
      chatId: "chat-2",
      reason: "agent_not_bound",
    });
    await expect(rejected).rejects.toThrow("agent_not_bound");
    // Read-only probe: a rejection never tears down the socket.
    expect(socket.closeCalls).toHaveLength(0);
  });

  it("forces a reconnect when an inbox recovery confirmation times out", async () => {
    vi.useFakeTimers();
    const connection = await makeConnection();
    const internal = priv(connection);
    const events: string[] = [];
    connection.on("reconnecting", () => events.push("reconnecting"));
    const socket = await openRegisteredConnection(connection, { wsInboxAckConfirm: true });

    const bindPromise = internal.sendBind("agent-1", "codex");
    const bindFrame = parseSent(socket, socket.sent.length - 1);
    socket.emitMessage({
      type: "agent:bound",
      ref: bindFrame.ref,
      agentId: "agent-1",
      displayName: "Agent One",
      agentType: "agent",
    });
    await bindPromise;

    const recovering = connection.sendInboxRecover("agent-1", "chat-timeout");
    const rejection = expect(recovering).rejects.toThrow("inbox:recover rejected (timeout)");
    await vi.advanceTimersByTimeAsync(3000);

    await rejection;
    expect(socket.closeCalls.at(-1)).toEqual({ code: 1011, reason: "inbox recover timeout" });
    expect(events).toContain("reconnecting");

    internal.clearTimers();
  });

  it("holds agent-scoped confirmed inbox ACKs until that agent is rebound on the current socket", async () => {
    const connection = await makeConnection();
    const internal = priv(connection);
    const socket = await openRegisteredConnection(connection, { wsInboxAckConfirm: true });

    const ackPromise = connection.sendInboxAck(47, "agent-1");
    const ackFramesBeforeBind = socket.sent
      .map((raw) => JSON.parse(raw) as { type?: string })
      .filter((m) => m.type === "inbox:ack");
    expect(ackFramesBeforeBind).toHaveLength(0);

    const bindPromise = internal.sendBind("agent-1", "codex");
    const bindFrame = parseSent(socket, socket.sent.length - 1);
    socket.emitMessage({
      type: "agent:bound",
      ref: bindFrame.ref,
      agentId: "agent-1",
      displayName: "Agent One",
      agentType: "agent",
    });
    await bindPromise;

    const ackFrame = parseSent(socket, socket.sent.length - 1);
    expect(ackFrame).toMatchObject({ type: "inbox:ack", entryId: 47 });
    socket.emitMessage({
      type: "inbox:ack:accepted",
      entryId: 47,
      ref: ackFrame.ref,
      disposition: "acked",
    });
    await expect(ackPromise).resolves.toBeUndefined();
  });

  it("rejects held agent-scoped ACKs when the bind is rejected", async () => {
    const connection = await makeConnection();
    const internal = priv(connection);
    const socket = await openRegisteredConnection(connection, { wsInboxAckConfirm: true });

    const ackPromise = connection.sendInboxAck(48, "agent-1");
    const bindPromise = internal.sendBind("agent-1", "codex");
    const bindFrame = parseSent(socket, socket.sent.length - 1);
    socket.emitMessage({
      type: "agent:bind:rejected",
      ref: bindFrame.ref,
      reason: "wrong_client",
    });

    await expect(bindPromise).rejects.toThrow("wrong_client");
    await expect(ackPromise).rejects.toThrow("agent_bind_rejected:wrong_client");
  });

  it("rejects held agent-scoped ACKs when the socket closes", async () => {
    const connection = await makeConnection();
    const internal = priv(connection);
    const socket = await openRegisteredConnection(connection, { wsInboxAckConfirm: true });

    const ackPromise = connection.sendInboxAck(49, "agent-1");
    internal.closing = true;
    socket.close(1006, "test close");

    await expect(ackPromise).rejects.toThrow("WebSocket closed");
    await connection.unbindAgent("agent-1");
  });

  it("does not flush old confirmed inbox ACKs after a later socket bind", async () => {
    const connection = await makeConnection();
    const internal = priv(connection);
    const firstSocket = await openRegisteredConnection(connection, { wsInboxAckConfirm: true });

    const ackPromise = connection.sendInboxAck(46);
    const firstAck = parseSent(firstSocket, firstSocket.sent.length - 1);
    expect(firstAck).toMatchObject({ type: "inbox:ack", entryId: 46 });
    internal.closing = true;
    firstSocket.close(1006, "test close");
    await expect(ackPromise).rejects.toThrow("WebSocket closed");
    internal.closing = false;

    const secondSocket = await openRegisteredConnection(connection, { wsInboxAckConfirm: true });
    const bindPromise = internal.sendBind("agent-1", "codex");
    const bindFrame = parseSent(secondSocket, secondSocket.sent.length - 1);
    secondSocket.emitMessage({
      type: "agent:bound",
      ref: bindFrame.ref,
      agentId: "agent-1",
      displayName: "Agent One",
      agentType: "agent",
    });
    await bindPromise;

    expect(
      secondSocket.sent
        .map((raw) => JSON.parse(raw) as { type?: string; entryId?: number })
        .filter((message) => message.type === "inbox:ack"),
    ).toEqual([]);
  });
});
