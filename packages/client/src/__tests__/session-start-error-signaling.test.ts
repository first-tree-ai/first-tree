import { parseProviderRetryEventMessage, type SessionEvent, type SessionState } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import type { FirstTreeHubSDK } from "../cloud/sdk.js";
import type {
  AgentHandler,
  DeliveryToken,
  HandlerFactory,
  SessionContext,
  SessionMessage,
} from "../runtime/handler.js";
import { SessionRuntime } from "../runtime/session-runtime.js";
import { silentLogger } from "./_logger-helpers.js";
import { mockEntry } from "./test-helpers.js";

/**
 * Pin the F2 contract from
 * docs/workspace-session-branch-collision-fix-design.md §3.3:
 *
 * When `handler.start` or `handler.resume` throws, the SessionRuntime must
 *   1) emit `session:state=errored` to the server so admin / UI see it,
 *   2) emit a structured `error` session event so the chat timeline renders
 *      the failure with its distinct ErrorRow styling (NOT a plain text
 *      message — that would be indistinguishable from a normal agent reply),
 *   3) settle the failed delivery when the terminal error event was emitted,
 *      or fall back to recovery if that durable signal could not be written,
 *      so the next inbound message for the same chat can start a fresh session.
 *
 * Historical note: pre-2026-05 this path forwarded a `⚠️ Session ... failed`
 * **text** message via the result-sink. That worked but rendered identical
 * to a normal agent reply in the chat timeline, so users couldn't tell the
 * agent had crashed vs replied "I failed". The forward path was replaced
 * with a `kind: "error"` session event; the web `ErrorRow` component
 * renders these with a red left-border + tinted background + `error · ...`
 * header so the failure is visually distinguishable.
 */

function mockSdk(): {
  sdk: FirstTreeHubSDK;
  sendMessage: ReturnType<typeof vi.fn>;
  postRuntimeNotice: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn().mockResolvedValue({ id: "msg-reply" });
  const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice" });
  const listChatParticipants = vi.fn().mockResolvedValue([
    { agentId: "agent-1", role: "member", mode: "full", name: "agent", displayName: "Agent", type: "agent" },
    { agentId: "user-1", role: "member", mode: "full", name: "user", displayName: "User", type: "human" },
  ]);
  return {
    sdk: {
      register: vi.fn(),
      sendMessage,
      postRuntimeNotice,
      sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
      listChatParticipants,
    } as unknown as FirstTreeHubSDK,
    sendMessage,
    postRuntimeNotice,
  };
}

function makeSessionRuntime(opts: {
  handlers: AgentHandler[];
  onStateChange?: (chatId: string, state: SessionState) => void;
  onSessionEvent?: (chatId: string, event: SessionEvent) => void;
  sdk?: FirstTreeHubSDK;
  recoverChat?: (chatId: string) => Promise<void>;
  ackEntry?: (entryId: number) => Promise<void>;
  confirmSessionEvent?: (chatId: string, event: SessionEvent) => Promise<void>;
}) {
  const factory: HandlerFactory = () => {
    const next = opts.handlers.shift();
    if (!next) throw new Error("handler factory exhausted");
    return next;
  };
  return new SessionRuntime({
    session: { idle_timeout: 300, max_sessions: 10, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
    concurrency: 5,
    handlerFactory: factory,
    handlerConfig: { workspaceRoot: "/tmp/test", runtimeProvider: "codex" },
    agentIdentity: {
      agentId: "agent-1",
      inboxId: "inbox-agent-1",
      displayName: "Test Agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: opts.sdk ?? mockSdk().sdk,
    log: silentLogger(),
    ackEntry: opts.ackEntry ?? vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined),
    onStateChange: opts.onStateChange,
    onSessionEvent: opts.onSessionEvent,
    confirmSessionEvent: opts.confirmSessionEvent,
    recoverChat: opts.recoverChat,
  });
}

/**
 * Permanent-classified error so the F2 signalling path (Bug 1 design §5.1)
 * actually fires. Transient errors now keep the entry alive for retry — see
 * session-manager-retry.test.ts for those cases.
 */
class FakeClientUserMismatchError extends Error {
  override name = "ClientUserMismatchError";
}

function failingHandler(): AgentHandler {
  return {
    start: vi.fn().mockRejectedValue(new FakeClientUserMismatchError("git worktree add failed: branch already in use")),
    resume: vi.fn(),
    inject: vi.fn().mockReturnValue({ kind: "owned", mode: "queued" }),
    suspend: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

function workingHandler(sessionId = "session-after-recovery"): AgentHandler {
  return {
    start: vi
      .fn()
      .mockResolvedValue({ sessionId: sessionId, route: { kind: "owned" as const, mode: "queued" as const } }),
    resume: vi
      .fn()
      .mockResolvedValue({ sessionId: sessionId, route: { kind: "owned" as const, mode: "queued" as const } }),
    inject: vi.fn().mockReturnValue({ kind: "owned", mode: "queued" }),
    suspend: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => res(value as T | PromiseLike<T>);
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SessionRuntime: session-start failure signalling (F2)", () => {
  it("emits onStateChange('errored') when handler.start throws", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const sm = makeSessionRuntime({
      handlers: [failingHandler()],
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-fail" }));

    // `active` reports BEFORE handler.start (per the runtime-truth fix:
    // server-side `setSessionRuntime` is active-gated, so any runtime frame
    // a handler emits during start() needs the active row to exist first).
    // On a start failure the `errored` transition then overrides it. Both
    // notifications go through — the `lastReportedStates` dedupe only
    // suppresses same-state repeats.
    expect(stateChanges).toEqual([
      { chatId: "chat-fail", state: "active" },
      { chatId: "chat-fail", state: "errored" },
    ]);

    await sm.shutdown();
  });

  it("emits a structured error session event (not a plain text message)", async () => {
    const { sdk, sendMessage } = mockSdk();
    const events: Array<{ chatId: string; event: SessionEvent }> = [];
    const sm = makeSessionRuntime({
      handlers: [failingHandler()],
      sdk,
      onSessionEvent: (chatId, event) => events.push({ chatId, event }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-fail" }));

    // No plain text forward — errors do NOT round-trip through sendMessage
    // anymore; otherwise they'd be indistinguishable from a normal reply.
    expect(sendMessage).not.toHaveBeenCalled();

    const errorEvents = events.filter((e) => e.event.kind === "error");
    expect(errorEvents).toHaveLength(1);
    const errorEvent = errorEvents[0];
    expect(errorEvent?.chatId).toBe("chat-fail");
    expect(errorEvent?.event.kind).toBe("error");
    if (errorEvent?.event.kind === "error") {
      expect(errorEvent.event.payload.source).toBe("runtime");
      const retryPayload = parseProviderRetryEventMessage(errorEvent.event.payload.message);
      expect(retryPayload).toMatchObject({
        event: "provider_failure_terminal",
        scope: "session_start",
        category: "configuration",
        reasonCode: "client_identity_mismatch",
      });
      expect(retryPayload?.messagePreview).toContain("git worktree add failed");
    }

    await sm.shutdown();
  });

  it("truncates the error preview to ~800 characters to keep stderr out of the chat", async () => {
    const giant = `boom: ${"x".repeat(2000)}`;
    const handler = workingHandler();
    handler.start = vi.fn().mockRejectedValue(new FakeClientUserMismatchError(giant));
    const events: SessionEvent[] = [];
    const sm = makeSessionRuntime({
      handlers: [handler],
      onSessionEvent: (_chatId, event) => events.push(event),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-huge-err" }));

    const errEvent = events.find((e) => e.kind === "error");
    expect(errEvent).toBeDefined();
    if (errEvent?.kind === "error") {
      // The event message keeps a short prefix ("Session start failed: "),
      // then up to 800 chars of the original message. Prefix + the 800-char
      // cap puts a hard ceiling well under 900.
      expect(errEvent.payload.message.length).toBeLessThan(900);
      expect(errEvent.payload.message).toContain("boom: ");
    }
  });

  it("ACKs a terminal start failure after emitting the error event so the next inbound starts fresh", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const failing = failingHandler();
    const working = workingHandler("session-after-recovery");
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const confirmSessionEvent = vi.fn<(chatId: string, event: SessionEvent) => Promise<void>>().mockResolvedValue();
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    const sm = makeSessionRuntime({
      handlers: [failing, working],
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
      confirmSessionEvent,
      ackEntry,
      recoverChat,
    });

    // First dispatch: fails. Now reports `active` (pre-start) then `errored`
    // (catch path) per the runtime-truth ordering fix.
    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-recover" }));
    expect(stateChanges).toEqual([
      { chatId: "chat-recover", state: "active" },
      { chatId: "chat-recover", state: "errored" },
    ]);
    expect(confirmSessionEvent).toHaveBeenCalledWith("chat-recover", expect.objectContaining({ kind: "error" }));
    expect(ackEntry).toHaveBeenCalledWith(1);
    expect(recoverChat).not.toHaveBeenCalled();

    // Second dispatch routes as a fresh start without needing server-side
    // recovery redelivery of the failed entry.
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-recover" }));

    // The recovered session emits `active` (notifySessionState dedupes against
    // the last reported state per chat, so going `errored → active` is a real
    // notification, not a no-op).
    expect(stateChanges.at(-1)).toEqual({ chatId: "chat-recover", state: "active" });
    expect(working.start).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("does not ACK a terminal start failure when confirmed error event persistence rejects", async () => {
    const failing = failingHandler();
    const working = workingHandler("session-after-rejected-event");
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    const confirmSessionEvent = vi
      .fn<(chatId: string, event: SessionEvent) => Promise<void>>()
      .mockRejectedValue(new Error("persist failed"));
    const sm = makeSessionRuntime({
      handlers: [failing, working],
      confirmSessionEvent,
      ackEntry,
      recoverChat,
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-event-rejected" }));

    expect(confirmSessionEvent).toHaveBeenCalledWith("chat-event-rejected", expect.objectContaining({ kind: "error" }));
    expect(ackEntry).not.toHaveBeenCalled();
    expect(recoverChat).toHaveBeenCalledWith("chat-event-rejected");

    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-event-rejected" }));
    expect(working.start).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("queues same-chat deliveries while terminal start failure is awaiting confirmed event settlement", async () => {
    const confirm = deferred();
    const failing = failingHandler();
    const working = workingHandler("session-after-terminal-settlement");
    const workingStart = vi.mocked(working.start);
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    const confirmSessionEvent = vi
      .fn<(chatId: string, event: SessionEvent) => Promise<void>>()
      .mockReturnValue(confirm.promise);
    const sm = makeSessionRuntime({
      handlers: [failing, working],
      confirmSessionEvent,
      ackEntry,
      recoverChat,
    });

    const firstDispatch = sm.dispatch(mockEntry({ id: 1, chatId: "chat-confirm-window", messageId: "msg-1" }));
    await vi.waitFor(() => expect(confirmSessionEvent).toHaveBeenCalledTimes(1));

    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-confirm-window", messageId: "msg-2" }));
    expect(working.start).not.toHaveBeenCalled();
    expect(ackEntry).not.toHaveBeenCalled();

    confirm.resolve();
    await firstDispatch;

    await vi.waitFor(() => expect(workingStart).toHaveBeenCalledTimes(1));
    expect(ackEntry).toHaveBeenCalledWith(1);
    expect(ackEntry.mock.invocationCallOrder).toHaveLength(1);
    expect(workingStart.mock.invocationCallOrder).toHaveLength(1);
    const [ackOrder = Number.POSITIVE_INFINITY] = ackEntry.mock.invocationCallOrder;
    const [startOrder = Number.NEGATIVE_INFINITY] = workingStart.mock.invocationCallOrder;
    expect(ackOrder).toBeLessThan(startOrder);
    expect(recoverChat).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("drops queued same-chat delivery copies after terminal fallback recovery clears local custody", async () => {
    const confirm = deferred();
    const failing = failingHandler();
    const working = workingHandler("session-after-recovery-redelivery");
    const workingStart = vi.mocked(working.start);
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    const confirmSessionEvent = vi
      .fn<(chatId: string, event: SessionEvent) => Promise<void>>()
      .mockReturnValue(confirm.promise);
    const sm = makeSessionRuntime({
      handlers: [failing, working],
      confirmSessionEvent,
      ackEntry,
      recoverChat,
    });

    const firstDispatch = sm.dispatch(mockEntry({ id: 1, chatId: "chat-recovery-window", messageId: "msg-1" }));
    await vi.waitFor(() => expect(confirmSessionEvent).toHaveBeenCalledTimes(1));

    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-recovery-window", messageId: "msg-2" }));
    expect(workingStart).not.toHaveBeenCalled();

    confirm.reject(new Error("persist failed"));
    await firstDispatch;
    await flushAsync();

    expect(recoverChat).toHaveBeenCalledWith("chat-recovery-window");
    expect(ackEntry).not.toHaveBeenCalled();
    expect(workingStart).not.toHaveBeenCalled();

    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-recovery-window", messageId: "msg-2" }));
    await vi.waitFor(() => expect(workingStart).toHaveBeenCalledTimes(1));

    await sm.shutdown();
  });

  it("keeps a session whose start turn completed and ACKed before returning a route receipt", async () => {
    const handler = workingHandler("session-live-after-start");
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    handler.start = vi.fn(async (message, _ctx, token) => {
      token?.processingStarted(message);
      await token?.complete(message, { status: "success", terminal: true });
      return { sessionId: "session-live-after-start", route: { kind: "owned", mode: "processing" } } as const;
    });
    const sm = makeSessionRuntime({
      handlers: [handler],
      ackEntry,
      recoverChat: vi.fn().mockResolvedValue(undefined),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-start-settled", messageId: "msg-1" }));

    expect(ackEntry).toHaveBeenCalledWith(1);
    expect(handler.shutdown).not.toHaveBeenCalled();
    expect(sm.getSessionStates().find((session) => session.chatId === "chat-start-settled")?.state).toBe("active");

    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-start-settled", messageId: "msg-2" }));

    expect(handler.start).toHaveBeenCalledTimes(1);
    expect(handler.inject).toHaveBeenCalledTimes(1);
    expect(vi.mocked(handler.inject).mock.calls[0]?.[0].id).toBe("msg-2");

    await sm.shutdown();
  });

  it("still cleans up and recovers when onSessionEvent itself throws", async () => {
    // Defensive contract: a broken event sink (e.g. agent-slot reporting on
    // a dropped WebSocket) must not strand the failed session locally. The
    // cleanup that drops the entry from `sessions` runs even when the
    // emit throws, so the next inbound message routes as a fresh start.
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const failing = failingHandler();
    const working = workingHandler("session-after-broken-emit");
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    const sm = makeSessionRuntime({
      handlers: [failing, working],
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
      onSessionEvent: () => {
        throw new Error("event sink down");
      },
      ackEntry,
      recoverChat,
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-emit-throw" }));
    expect(stateChanges).toEqual([
      { chatId: "chat-emit-throw", state: "active" },
      { chatId: "chat-emit-throw", state: "errored" },
    ]);
    expect(recoverChat).toHaveBeenCalledWith("chat-emit-throw");
    expect(ackEntry).not.toHaveBeenCalled();

    // After accepted recovery, the next dispatch routes through
    // `startNewSession` (no stale entry left behind by the throwing emit).
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-emit-throw" }));
    expect(working.start).toHaveBeenCalledTimes(1);
    expect(stateChanges.at(-1)).toEqual({ chatId: "chat-emit-throw", state: "active" });

    await sm.shutdown();
  });

  it("drops a provider-fatal start session so recovery redelivery uses a fresh handler", async () => {
    const chatId = "chat-provider-fatal-start";
    const reason = "codex_app_server_turn_start_unknown_custody_transient";
    const failed: AgentHandler = {
      start: vi.fn(async (message, ctx, token) => {
        token?.retry(message, reason);
        ctx.failSessionForRecovery?.(reason, "thread-failed-start");
        return { sessionId: "thread-failed-start", route: { kind: "owned", mode: "processing" } as const };
      }),
      resume: vi.fn(),
      inject: vi.fn().mockReturnValue({ kind: "owned", mode: "queued" }),
      suspend: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const recovered = workingHandler("thread-after-start-recovery");
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeSessionRuntime({ handlers: [failed, recovered], recoverChat });

    await sm.dispatch(mockEntry({ id: 1, chatId, messageId: "msg-start" }));
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith(chatId));
    await flushAsync();

    expect(sm.activeCount).toBe(0);

    await sm.dispatch(mockEntry({ id: 1, chatId, messageId: "msg-start" }));

    expect(failed.inject).not.toHaveBeenCalled();
    expect(recovered.resume).toHaveBeenCalledWith(
      expect.objectContaining({ id: "msg-start" }),
      "thread-failed-start",
      expect.any(Object),
      expect.any(Object),
    );

    await sm.shutdown();
  });

  it("drops a provider-fatal active session so recovery redelivery uses a fresh handler", async () => {
    const chatId = "chat-provider-fatal-inject";
    const reason = "codex_app_server_steer_unknown_custody_transient";
    let startCtx: SessionContext | undefined;
    let startToken: DeliveryToken | undefined;
    let startMessage: SessionMessage | undefined;
    const failed: AgentHandler = {
      start: vi.fn(async (message, ctx, token) => {
        startCtx = ctx;
        startToken = token;
        startMessage = message;
        return { sessionId: "thread-failed-inject", route: { kind: "owned", mode: "processing" } as const };
      }),
      resume: vi.fn(),
      inject: vi.fn((message) => {
        if (!startMessage) throw new Error("start message missing");
        startToken?.retry([startMessage, message], reason);
        startCtx?.failSessionForRecovery?.(reason, "thread-failed-inject");
        return { kind: "owned", mode: "queued" } as const;
      }),
      suspend: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const recovered = workingHandler("thread-after-inject-recovery");
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeSessionRuntime({ handlers: [failed, recovered], recoverChat });

    await sm.dispatch(mockEntry({ id: 1, chatId, messageId: "msg-start" }));
    expect(sm.activeCount).toBe(1);

    await sm.dispatch(mockEntry({ id: 2, chatId, messageId: "msg-inject" }));
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith(chatId));
    await flushAsync();

    expect(sm.activeCount).toBe(0);

    await sm.dispatch(mockEntry({ id: 1, chatId, messageId: "msg-start" }));

    expect(failed.inject).toHaveBeenCalledTimes(1);
    expect(recovered.resume).toHaveBeenCalledWith(
      expect.objectContaining({ id: "msg-start" }),
      "thread-failed-inject",
      expect.any(Object),
      expect.any(Object),
    );

    await sm.shutdown();
  });
});

describe("SessionRuntime: session-resume failure signalling (F2, resume path)", () => {
  /**
   * Build a manager whose concurrency is 1 so two consecutive dispatches
   * to different chats preempt the first onto the resume path. The handler
   * factory threads a per-chat queue so each test can stage the exact
   * start/resume outcomes it needs.
   */
  function makeSerializedManager(opts: {
    handlerQueue: AgentHandler[];
    onStateChange?: (chatId: string, state: SessionState) => void;
    onSessionEvent?: (chatId: string, event: SessionEvent) => void;
    sdk?: FirstTreeHubSDK;
    recoverChat?: (chatId: string) => Promise<void>;
  }) {
    const queue = [...opts.handlerQueue];
    return new SessionRuntime({
      session: { idle_timeout: 300, max_sessions: 10, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
      concurrency: 1,
      handlerFactory: () => queue.shift() ?? workingHandler(),
      handlerConfig: { workspaceRoot: "/tmp/test", runtimeProvider: "codex" },
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Test Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk: opts.sdk ?? mockSdk().sdk,
      log: silentLogger(),
      ackEntry: vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined),
      onStateChange: opts.onStateChange,
      onSessionEvent: opts.onSessionEvent,
      recoverChat: opts.recoverChat,
    });
  }

  it("emits onStateChange('errored') and a structured error event when handler.resume throws", async () => {
    // Stage: handlerA.start() succeeds; chat-B start preempts chat-A to
    // suspended; the third dispatch then hits resume on chat-A which throws.
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const events: Array<{ chatId: string; event: SessionEvent }> = [];
    const { sdk, sendMessage } = mockSdk();
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    let chatBContext: SessionContext | undefined;
    let chatBMessage: SessionMessage | undefined;
    const handlerA: AgentHandler = {
      start: vi
        .fn()
        .mockResolvedValue({ sessionId: "session-A", route: { kind: "owned" as const, mode: "queued" as const } }),
      resume: vi.fn().mockRejectedValue(new FakeClientUserMismatchError("git mirror fetch failed: connection refused")),
      inject: vi.fn(),
      suspend: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const handlerB = workingHandler("session-B");
    handlerB.start = vi.fn(async (message, ctx) => {
      chatBMessage = message;
      chatBContext = ctx;
      return { sessionId: "session-B", route: { kind: "owned" as const, mode: "queued" as const } };
    });
    const sm = makeSerializedManager({
      handlerQueue: [handlerA, handlerB],
      sdk,
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
      onSessionEvent: (chatId, event) => events.push({ chatId, event }),
      recoverChat,
    });

    const chatAStart = mockEntry({ id: 1, chatId: "chat-A" });
    const chatBStart = mockEntry({ id: 2, chatId: "chat-B" });
    await sm.dispatch(chatAStart); // starts chat-A
    await sm.dispatch(chatBStart); // starts chat-B and preempts chat-A
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith("chat-A"));
    await new Promise((resolve) => setImmediate(resolve));
    await sm.dispatch(chatAStart); // recovery redelivery queues behind working chat-B
    if (!chatBContext || !chatBMessage) throw new Error("chat-B context missing");
    await chatBContext.finishTurn(chatBMessage, { status: "success", terminal: true });
    await vi.waitFor(() => expect(handlerA.resume).toHaveBeenCalledTimes(1));

    const chatAStates = stateChanges.filter((c) => c.chatId === "chat-A").map((c) => c.state);
    expect(chatAStates.at(-1)).toBe("errored");

    const resumeErrEvent = events.find((e) => {
      if (e.chatId !== "chat-A" || e.event.kind !== "error") return false;
      const payload = parseProviderRetryEventMessage(e.event.payload.message);
      return payload?.event === "provider_failure_terminal" && payload.scope === "session_resume";
    });
    expect(resumeErrEvent).toBeDefined();
    if (resumeErrEvent?.event.kind === "error") {
      expect(resumeErrEvent.event.payload.source).toBe("runtime");
      const retryPayload = parseProviderRetryEventMessage(resumeErrEvent.event.payload.message);
      expect(retryPayload).toMatchObject({
        event: "provider_failure_terminal",
        scope: "session_resume",
        category: "configuration",
        reasonCode: "client_identity_mismatch",
      });
      expect(retryPayload?.messagePreview).toContain("git mirror fetch failed");
    }

    // sendMessage should NOT carry the error — that's the regression we're
    // guarding against. (It may be called for unrelated bookkeeping, so we
    // only check that no call references the error string.)
    for (const call of sendMessage.mock.calls) {
      const content = (call[1] as { content?: string })?.content ?? "";
      expect(content).not.toContain("Session resume failed");
    }

    expect(handlerA.resume).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("allows the next inbound message for the same chat to start a fresh session after a resume failure", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    let chatBContext: SessionContext | undefined;
    let chatBMessage: SessionMessage | undefined;
    const handlerA: AgentHandler = {
      start: vi
        .fn()
        .mockResolvedValue({ sessionId: "session-A", route: { kind: "owned" as const, mode: "queued" as const } }),
      resume: vi.fn().mockRejectedValue(new FakeClientUserMismatchError("resume blew up")),
      inject: vi.fn(),
      suspend: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const handlerB = workingHandler("session-B");
    handlerB.start = vi.fn(async (message, ctx) => {
      chatBMessage = message;
      chatBContext = ctx;
      return { sessionId: "session-B", route: { kind: "owned" as const, mode: "queued" as const } };
    });
    const handlerARecovery = workingHandler("session-A-fresh");
    const sm = makeSerializedManager({
      handlerQueue: [handlerA, handlerB, handlerARecovery],
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
      recoverChat,
    });

    const chatAStart = mockEntry({ id: 1, chatId: "chat-A" });
    const chatBStart = mockEntry({ id: 2, chatId: "chat-B" });
    const chatARecovery = mockEntry({ id: 4, chatId: "chat-A" });
    await sm.dispatch(chatAStart);
    await sm.dispatch(chatBStart);
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith("chat-A"));
    await new Promise((resolve) => setImmediate(resolve));
    await sm.dispatch(chatAStart); // recovery redelivery queues behind working chat-B
    if (!chatBContext || !chatBMessage) throw new Error("chat-B context missing");
    await chatBContext.finishTurn(chatBMessage, { status: "success", terminal: true });
    await vi.waitFor(() => expect(handlerA.resume).toHaveBeenCalledTimes(1)); // resume → errored
    await vi.waitFor(() => expect(sm.getSessionStates().some((session) => session.chatId === "chat-A")).toBe(false));

    // A fresh inbound for chat-A should route as start (entry was dropped
    // on resume failure — the resume catch tears down the same way the
    // start catch does, so there's no "stuck suspended" entry blocking it).
    await sm.dispatch(chatARecovery);
    expect(handlerARecovery.start).toHaveBeenCalledTimes(1);
    expect(stateChanges.filter((c) => c.chatId === "chat-A").at(-1)?.state).toBe("active");

    await sm.shutdown();
  });
});
