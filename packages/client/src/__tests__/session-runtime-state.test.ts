import type pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { FirstTreeHubSDK } from "../cloud/sdk.js";
import type { AgentHandler, HandlerFactory, SessionContext, SessionMessage } from "../runtime/handler.js";
import { SessionRuntime } from "../runtime/session-runtime.js";
import { silentLogger } from "./_logger-helpers.js";
import { mockEntry } from "./test-helpers.js";

function mockSdk(): FirstTreeHubSDK {
  return {
    register: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ id: "msg-reply" }),
    sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
  } as unknown as FirstTreeHubSDK;
}

function createMockHandler(overrides?: Partial<AgentHandler>): AgentHandler {
  return {
    start: vi
      .fn()
      .mockResolvedValue({ sessionId: "session-id-mock", route: { kind: "owned" as const, mode: "queued" as const } }),
    resume: vi
      .fn()
      .mockResolvedValue({ sessionId: "session-id-mock", route: { kind: "owned" as const, mode: "queued" as const } }),
    inject: vi.fn().mockReturnValue({ kind: "owned", mode: "queued" }),
    suspend: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createSessionRuntime(opts: {
  sdk?: FirstTreeHubSDK;
  handler?: AgentHandler;
  handlerFactory?: HandlerFactory;
  ackEntry?: (entryId: number) => Promise<void>;
  recoverChat?: (chatId: string) => Promise<void>;
  session?: {
    idle_timeout: number;
    max_sessions: number;
    working_grace_seconds: number;
    reconcile_interval_seconds: number;
  };
  concurrency?: number;
  log?: pino.Logger;
  onRuntimeStateChange?: (state: "idle" | "working" | "blocked" | "error") => void;
  onSessionRuntimeChange?: (chatId: string, state: "idle" | "working" | "blocked" | "error") => void;
}): SessionRuntime {
  const handler = opts.handler ?? createMockHandler();
  const factory: HandlerFactory = opts.handlerFactory ?? (() => handler);
  const sdk = opts.sdk ?? mockSdk();

  return new SessionRuntime({
    session: opts.session ?? {
      idle_timeout: 300,
      max_sessions: 10,
      working_grace_seconds: 3600,
      reconcile_interval_seconds: 300,
    },
    concurrency: opts.concurrency ?? 5,
    handlerFactory: factory,
    handlerConfig: { workspaceRoot: "/tmp/test", runtimeProvider: "codex" },
    agentIdentity: {
      agentId: "agent-1",
      inboxId: "inbox-agent-1",
      displayName: "Agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk,
    log: opts.log ?? silentLogger(),
    ackEntry: opts.ackEntry ?? vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined),
    recoverChat: opts.recoverChat,
    onRuntimeStateChange: opts.onRuntimeStateChange,
    onSessionRuntimeChange: opts.onSessionRuntimeChange,
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void } {
  let resolve: () => void = () => {};
  let reject: (err: unknown) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SessionRuntime runtime projection from inbox coordinator work", () => {
  it("projects only processing owned work as working and returns to idle before ACK confirms", async () => {
    const events: Array<{ chatId: string; state: string }> = [];
    let capturedCtx: SessionContext | undefined;
    let capturedMessage: SessionMessage | undefined;
    const ack = deferred();
    const handler = createMockHandler({
      async start(msg, ctx) {
        capturedCtx = ctx;
        capturedMessage = msg;
        return { sessionId: "session-1", route: { kind: "owned" as const, mode: "queued" as const } };
      },
    });
    const sm = createSessionRuntime({
      handler,
      ackEntry: vi.fn().mockReturnValue(ack.promise),
      onRuntimeStateChange: vi.fn(),
      onSessionRuntimeChange: (chatId, state) => events.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    expect(events).toContainEqual({ chatId: "chat-a", state: "idle" });
    expect(sm.getAggregateRuntimeState()).toBe("idle");

    if (!capturedMessage) throw new Error("expected captured message");
    capturedCtx?.markMessagesConsumed(capturedMessage);
    expect(events).toContainEqual({ chatId: "chat-a", state: "working" });
    expect(sm.getAggregateRuntimeState()).toBe("working");

    const finish = capturedCtx?.finishTurn(capturedMessage, { status: "success", terminal: true });
    await Promise.resolve();
    expect(events[events.length - 1]).toEqual({ chatId: "chat-a", state: "idle" });

    ack.resolve();
    await finish;
    expect(events[events.length - 1]).toEqual({ chatId: "chat-a", state: "idle" });
    expect(sm.getAggregateRuntimeState()).toBe("idle");

    await sm.shutdown();
  });

  it("projects a provider turn as working when no inbox delivery owns it", async () => {
    // A provider re-invoked by its own background-task completion runs a full
    // turn with no owned inbox entry. Projecting that as idle is what made a
    // busy agent read as "Idle" on every chat surface.
    const events: Array<{ chatId: string; state: string }> = [];
    let capturedCtx: SessionContext | undefined;
    let capturedMessage: SessionMessage | undefined;
    const handler = createMockHandler({
      async start(msg, ctx) {
        capturedCtx = ctx;
        capturedMessage = msg;
        return { sessionId: "session-1", route: { kind: "owned" as const, mode: "queued" as const } };
      },
    });
    const sm = createSessionRuntime({
      handler,
      onRuntimeStateChange: vi.fn(),
      onSessionRuntimeChange: (chatId, state) => events.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    if (!capturedCtx || !capturedMessage) throw new Error("expected captured session context");
    capturedCtx.markMessagesConsumed(capturedMessage);
    await capturedCtx.finishTurn(capturedMessage, { status: "success", terminal: true });
    capturedCtx.emitEvent({ kind: "turn_end", payload: { status: "success" } });
    expect(events[events.length - 1]).toEqual({ chatId: "chat-a", state: "idle" });

    // The background task completes and the provider starts a fresh turn on
    // its own: no delivery, no ownership, but real work.
    capturedCtx.emitEvent({ kind: "tool_call", payload: { toolUseId: "t1", name: "Bash", args: null, status: "ok" } });
    expect(events[events.length - 1]).toEqual({ chatId: "chat-a", state: "working" });
    expect(sm.getAggregateRuntimeState()).toBe("working");

    capturedCtx.emitEvent({ kind: "turn_end", payload: { status: "success" } });
    expect(events[events.length - 1]).toEqual({ chatId: "chat-a", state: "idle" });
    expect(sm.getAggregateRuntimeState()).toBe("idle");

    await sm.shutdown();
  });

  it("keeps a delivery working when the provider closes one turn but the delivery is unsettled", async () => {
    const events: Array<{ chatId: string; state: string }> = [];
    let capturedCtx: SessionContext | undefined;
    let capturedMessage: SessionMessage | undefined;
    const ack = deferred();
    const handler = createMockHandler({
      async start(msg, ctx) {
        capturedCtx = ctx;
        capturedMessage = msg;
        return { sessionId: "session-1", route: { kind: "owned" as const, mode: "queued" as const } };
      },
    });
    const sm = createSessionRuntime({
      handler,
      ackEntry: vi.fn().mockReturnValue(ack.promise),
      onRuntimeStateChange: vi.fn(),
      onSessionRuntimeChange: (chatId, state) => events.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    if (!capturedCtx || !capturedMessage) throw new Error("expected captured session context");
    capturedCtx.markMessagesConsumed(capturedMessage);
    capturedCtx.emitEvent({ kind: "thinking", payload: {} });
    expect(events[events.length - 1]).toEqual({ chatId: "chat-a", state: "working" });

    // Turn liveness ends, but the owned delivery is still being processed —
    // ownership alone must keep the chat working.
    capturedCtx.emitEvent({ kind: "turn_end", payload: { status: "success" } });
    expect(events[events.length - 1]).toEqual({ chatId: "chat-a", state: "working" });
    expect(sm.getAggregateRuntimeState()).toBe("working");

    ack.resolve();
    await sm.shutdown();
  });

  it("does not resurrect working from out-of-turn provider traffic after a turn closes", async () => {
    // `recordProviderActivity` is broader than turn liveness on purpose: the
    // Codex app-server samples it above its own thread/turn filter, so a late
    // `thread/tokenUsage/updated` for an already-closed turn reaches it and is
    // then recorded as historical usage — with no `turn_end` to follow. Turn
    // liveness must come from in-turn evidence only, or that sample would
    // strand `working` on an idle chat.
    const events: Array<{ chatId: string; state: string }> = [];
    let capturedCtx: SessionContext | undefined;
    let capturedMessage: SessionMessage | undefined;
    const handler = createMockHandler({
      async start(msg, ctx) {
        capturedCtx = ctx;
        capturedMessage = msg;
        return { sessionId: "session-1", route: { kind: "owned" as const, mode: "queued" as const } };
      },
    });
    const sm = createSessionRuntime({
      handler,
      onRuntimeStateChange: vi.fn(),
      onSessionRuntimeChange: (chatId, state) => events.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    if (!capturedCtx || !capturedMessage) throw new Error("expected captured session context");
    capturedCtx.markMessagesConsumed(capturedMessage);
    capturedCtx.emitEvent({ kind: "thinking", payload: {} });
    await capturedCtx.finishTurn(capturedMessage, { status: "success", terminal: true });
    capturedCtx.emitEvent({ kind: "turn_end", payload: { status: "success" } });
    expect(events[events.length - 1]).toEqual({ chatId: "chat-a", state: "idle" });

    // Late traffic for the closed turn: an activity sample and the usage event
    // it carries. Neither is evidence of an open turn.
    capturedCtx.recordProviderActivity();
    capturedCtx.emitEvent({
      kind: "token_usage",
      payload: { provider: "codex", model: "gpt-5", inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
    });
    expect(events[events.length - 1]).toEqual({ chatId: "chat-a", state: "idle" });
    expect(sm.getAggregateRuntimeState()).toBe("idle");

    await sm.shutdown();
  });

  it("keeps ACK failure unsettled and recovers before routing later delivery", async () => {
    const events: Array<{ chatId: string; state: string }> = [];
    const recovery = deferred();
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockReturnValue(recovery.promise);
    const handler = createMockHandler();
    let capturedCtx: SessionContext | undefined;
    let capturedMessage: SessionMessage | undefined;
    handler.start = vi.fn(async (msg, ctx) => {
      capturedCtx = ctx;
      capturedMessage = msg;
      return { sessionId: "session-1", route: { kind: "owned" as const, mode: "queued" as const } };
    });
    const sm = createSessionRuntime({
      handler,
      recoverChat,
      ackEntry: vi.fn().mockRejectedValue(new Error("prefix_gap")),
      onRuntimeStateChange: vi.fn(),
      onSessionRuntimeChange: (chatId, state) => events.push({ chatId, state }),
    });

    const first = mockEntry({ id: 1, chatId: "chat-a" });
    await sm.dispatch(first);
    if (!capturedMessage) throw new Error("expected captured message");
    await capturedCtx?.finishTurn(capturedMessage, { status: "success", terminal: true });

    expect(events[events.length - 1]).toEqual({ chatId: "chat-a", state: "idle" });
    expect(sm.getAggregateRuntimeState()).toBe("idle");
    expect(recoverChat).toHaveBeenCalledWith("chat-a");

    const later = sm.dispatch(mockEntry({ id: 2, chatId: "chat-a" }));
    await Promise.resolve();
    expect(handler.inject).not.toHaveBeenCalledWith(expect.objectContaining({ id: "msg-2" }));
    recovery.resolve();
    await later;

    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-a" }));
    expect(handler.inject).toHaveBeenCalledWith(expect.objectContaining({ id: "msg-2" }), expect.anything());

    await sm.shutdown();
  });

  it("does not route or ACK duplicate-in-flight redelivery", async () => {
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const handler = createMockHandler();
    const sm = createSessionRuntime({ handler, ackEntry });
    const entry = mockEntry({ id: 1, chatId: "chat-a", messageId: "same-message" });

    await sm.dispatch(entry);
    await sm.dispatch(entry);

    expect(handler.start).toHaveBeenCalledTimes(1);
    expect(handler.inject).not.toHaveBeenCalled();
    expect(ackEntry).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("does not let open delivery debt hold the idle reaper until hard cap", async () => {
    vi.useFakeTimers();
    try {
      const handler = createMockHandler();
      const sm = createSessionRuntime({
        handler,
        session: { idle_timeout: 1, max_sessions: 10, working_grace_seconds: 60, reconcile_interval_seconds: 300 },
      });

      await sm.dispatch(mockEntry({ id: 1, chatId: "chat-thinking" }));
      await vi.advanceTimersByTimeAsync(20_000);

      expect(handler.suspend).toHaveBeenCalled();
      await sm.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("processingStarted but non-terminal work is recovered on idle suspend without ACK", async () => {
    vi.useFakeTimers();
    try {
      const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
      const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
      let capturedCtx: SessionContext | undefined;
      let firstMessage: SessionMessage | undefined;
      const handler = createMockHandler({
        async start(msg, ctx) {
          capturedCtx = ctx;
          firstMessage = msg;
          return { sessionId: "session-1", route: { kind: "owned" as const, mode: "queued" as const } };
        },
      });
      const sm = createSessionRuntime({
        handler,
        ackEntry,
        recoverChat,
        session: { idle_timeout: 1, max_sessions: 10, working_grace_seconds: 5, reconcile_interval_seconds: 300 },
      });

      await sm.dispatch(mockEntry({ id: 1, chatId: "chat-stuck" }));
      if (!firstMessage) throw new Error("expected first message");
      capturedCtx?.markMessagesConsumed(firstMessage);
      await sm.dispatch(mockEntry({ id: 2, chatId: "chat-stuck" }));

      await vi.advanceTimersByTimeAsync(30_000);

      expect(handler.suspend).toHaveBeenCalledTimes(1);
      expect(ackEntry).not.toHaveBeenCalled();
      expect(ackEntry).not.toHaveBeenCalledWith(2);
      expect(recoverChat).toHaveBeenCalledWith("chat-stuck");

      await sm.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
