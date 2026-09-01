import type { RuntimeState, SessionRuntimeReport, SessionState } from "@first-tree/shared";
import type pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { FirstTreeHubSDK } from "../cloud/sdk.js";
import type { AgentHandler, HandlerFactory, SessionContext, SessionMessage } from "../runtime/handler.js";
import { SessionRuntime } from "../runtime/session-runtime.js";
import { silentLogger } from "./_logger-helpers.js";
import { mockEntry } from "./test-helpers.js";

/**
 * Tests for per-session state notifications (onStateChange callback),
 * deduplication via lastReportedStates, getSessionStates(), and shutdown reporting.
 */

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
    inject: vi.fn(),
    suspend: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createCapturingFactory() {
  const contexts = new Map<string, SessionContext>();
  const messages = new Map<string, SessionMessage>();
  const factory: HandlerFactory = () => {
    return createMockHandler({
      async start(message, ctx) {
        contexts.set(message.chatId, ctx);
        messages.set(message.chatId, message);
        return { sessionId: `session-${message.chatId}`, route: { kind: "owned" as const, mode: "queued" as const } };
      },
      async resume(message, _sessionId, ctx) {
        if (message) {
          contexts.set(message.chatId, ctx);
          messages.set(message.chatId, message);
        }
        return {
          sessionId: `session-${message?.chatId ?? "unknown"}`,
          route: { kind: "owned" as const, mode: "queued" as const },
        };
      },
    });
  };
  const finish = async (chatId: string) => {
    const ctx = contexts.get(chatId);
    const message = messages.get(chatId);
    if (!ctx || !message) throw new Error(`${chatId} context missing`);
    await ctx.finishTurn(message, { status: "success", terminal: true });
  };
  return { factory, finish };
}

function createSessionRuntime(opts: {
  sdk?: FirstTreeHubSDK;
  handler?: AgentHandler;
  handlerFactory?: HandlerFactory;
  session?: {
    idle_timeout: number;
    max_sessions: number;
    working_grace_seconds: number;
    reconcile_interval_seconds: number;
  };
  concurrency?: number;
  log?: pino.Logger;
  onStateChange?: (chatId: string, state: SessionState) => void;
  onSessionRuntimeChange?: (chatId: string, report: SessionRuntimeReport) => void;
  recoverChat?: (chatId: string) => Promise<void>;
}) {
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
    ackEntry: vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined),
    onStateChange: opts.onStateChange,
    onSessionRuntimeChange: opts.onSessionRuntimeChange,
    recoverChat: opts.recoverChat,
  });
}

describe("SessionRuntime: state notifications", () => {
  it("fires onStateChange('active') when a new session starts", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const sm = createSessionRuntime({
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));

    expect(stateChanges).toHaveLength(1);
    expect(stateChanges[0]).toEqual({ chatId: "chat-a", state: "active" });

    await sm.shutdown();
  });

  it("fires onStateChange('suspended') when a session is preempted", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const sm = createSessionRuntime({
      concurrency: 1,
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));

    // chat-a: active, then suspended (preempted); chat-b: active
    const chatAChanges = stateChanges.filter((c) => c.chatId === "chat-a");
    const chatBChanges = stateChanges.filter((c) => c.chatId === "chat-b");

    expect(chatAChanges).toEqual([
      { chatId: "chat-a", state: "active" },
      { chatId: "chat-a", state: "suspended" },
    ]);
    expect(chatBChanges).toEqual([{ chatId: "chat-b", state: "active" }]);

    await sm.shutdown();
  });

  it("withdraws runtime and reports suspended when a session is LRU-evicted", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const runtimeChanges: Array<{ chatId: string; state: RuntimeState }> = [];
    const capturing = createCapturingFactory();
    const sm = createSessionRuntime({
      session: { idle_timeout: 300, max_sessions: 2, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
      handlerFactory: capturing.factory,
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
      onSessionRuntimeChange: (chatId, { runtimeState: state }) => runtimeChanges.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await capturing.finish("chat-a");
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));
    // Third chat triggers eviction of idle chat-a (LRU)
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-c" }));

    const chatAChanges = stateChanges.filter((c) => c.chatId === "chat-a");
    expect(chatAChanges).toEqual([
      { chatId: "chat-a", state: "active" },
      { chatId: "chat-a", state: "suspended" },
    ]);
    // The prior projection was already idle. Removing it must still produce
    // an observable, idempotent idle revocation instead of silently deleting
    // the local map entry.
    expect(runtimeChanges.filter((c) => c.chatId === "chat-a").at(-1)).toEqual({
      chatId: "chat-a",
      state: "idle",
    });

    await sm.shutdown();
  });

  it("emits idle before suspended when preemption removes a working projection", async () => {
    const emissions: Array<{ chatId: string; kind: "state" | "runtime"; value: string }> = [];
    const handlers = [
      createMockHandler({
        async start(message, _ctx, token) {
          token.processingStarted(message);
          return { sessionId: "session-chat-a", route: { kind: "owned" as const, mode: "queued" as const } };
        },
      }),
      createMockHandler(),
    ];
    const sm = createSessionRuntime({
      concurrency: 1,
      handlerFactory: () => handlers.shift() ?? createMockHandler(),
      onStateChange: (chatId, state) => emissions.push({ chatId, kind: "state", value: state }),
      onSessionRuntimeChange: (chatId, { runtimeState: state }) =>
        emissions.push({ chatId, kind: "runtime", value: state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    expect(emissions).toContainEqual({ chatId: "chat-a", kind: "runtime", value: "working" });

    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));

    expect(emissions.filter((event) => event.chatId === "chat-a").slice(-2)).toEqual([
      { chatId: "chat-a", kind: "runtime", value: "idle" },
      { chatId: "chat-a", kind: "state", value: "suspended" },
    ]);

    await sm.shutdown();
  });

  it("fires onStateChange('active') on resume after suspension", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const recoverChat = vi.fn().mockResolvedValue(undefined);
    let chatBContext: SessionContext | undefined;
    let chatBMessage: SessionMessage | undefined;
    const handlerA = createMockHandler({
      start: vi
        .fn()
        .mockResolvedValue({ sessionId: "session-chat-a", route: { kind: "owned" as const, mode: "queued" as const } }),
      resume: vi
        .fn()
        .mockResolvedValue({ sessionId: "session-chat-a", route: { kind: "owned" as const, mode: "queued" as const } }),
    });
    const handlerB = createMockHandler({
      async start(message, ctx) {
        chatBMessage = message;
        chatBContext = ctx;
        return { sessionId: "session-chat-b", route: { kind: "owned" as const, mode: "queued" as const } };
      },
    });
    const handlers = [handlerA, handlerB];
    const sm = createSessionRuntime({
      concurrency: 1,
      handlerFactory: () => handlers.shift() ?? createMockHandler(),
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
      recoverChat,
    });

    // chat-a starts, chat-b preempts it, then the redelivered chat-a frame
    // waits until chat-b finishes and yields the only active slot.
    const chatA = mockEntry({ id: 1, chatId: "chat-a" });
    const chatB = mockEntry({ id: 2, chatId: "chat-b" });
    await sm.dispatch(chatA);
    await sm.dispatch(chatB);
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith("chat-a"));
    await new Promise((resolve) => setImmediate(resolve));
    await sm.dispatch(chatA);
    if (!chatBContext || !chatBMessage) throw new Error("chat-b context missing");
    await chatBContext.finishTurn(chatBMessage, { status: "success", terminal: true });
    await vi.waitFor(() => expect(handlerA.resume).toHaveBeenCalledTimes(1));

    const chatAChanges = stateChanges.filter((c) => c.chatId === "chat-a");
    expect(chatAChanges).toEqual([
      { chatId: "chat-a", state: "active" },
      { chatId: "chat-a", state: "suspended" },
      { chatId: "chat-a", state: "active" },
    ]);

    await sm.shutdown();
  });

  it("does not fire onStateChange when no callback is provided", async () => {
    // Should not throw
    const sm = createSessionRuntime({});
    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await sm.shutdown();
  });
});

describe("SessionRuntime: state-before-runtime ordering (codex review P2)", () => {
  // The server's `setSessionRuntime` is active-gated — if `session:state
  // active` hasn't landed yet, any `session:runtime` for the same
  // (agent, chat) is dropped. Runtime projection is now coordinator-derived,
  // so SessionRuntime must emit `active` before it projects the fresh
  // delivery to `working`, and both must happen before handler.start().
  it("emits active before coordinator-derived idle runtime and before handler.start", async () => {
    const emissions: Array<{ kind: "state" | "runtime"; value: string }> = [];
    let observedActiveBeforeHandlerCompletion = false;

    const handler = createMockHandler({
      start: vi.fn(async () => {
        // Snapshot the state emissions seen so far — if the `active`
        // notification fired before invoking start, it must already be in
        // `emissions`.
        observedActiveBeforeHandlerCompletion = emissions.some((e) => ({
          sessionId: e.kind === "state" && e.value === "active",
          route: { kind: "owned" as const, mode: "queued" as const },
        }));
        return { sessionId: "session-id-mock", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
    });

    const sm = createSessionRuntime({
      handler,
      onStateChange: (_chatId, state) => emissions.push({ kind: "state", value: state }),
      onSessionRuntimeChange: (_chatId, { runtimeState }) => emissions.push({ kind: "runtime", value: runtimeState }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-codex" }));

    // The snapshot captured at the top of handler.start() must have already
    // included the `active` state — proving notifySessionState fired BEFORE
    // we entered the handler.
    expect(observedActiveBeforeHandlerCompletion).toBe(true);

    // Belt-and-braces: the first emission overall must be the active state
    // notification (no runtime frame slipped in before it).
    expect(emissions[0]).toEqual({ kind: "state", value: "active" });
    expect(emissions[1]).toEqual({ kind: "runtime", value: "idle" });

    await sm.shutdown();
  });
});

describe("SessionRuntime: state deduplication", () => {
  it("does not fire duplicate 'active' notifications for the same session", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];

    // Concurrency 1: chat-a starts, chat-b preempts, chat-a resumes, chat-b preempts again
    const sm = createSessionRuntime({
      concurrency: 1,
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" })); // active
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" })); // a→suspended, b→active
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-a" })); // b→suspended, a→active
    await sm.dispatch(mockEntry({ id: 4, chatId: "chat-b" })); // a→suspended, b→active

    // Each chat should alternate active/suspended with no duplicates
    const chatAChanges = stateChanges.filter((c) => c.chatId === "chat-a");
    const chatBChanges = stateChanges.filter((c) => c.chatId === "chat-b");

    // No two consecutive identical states
    for (const changes of [chatAChanges, chatBChanges]) {
      for (let i = 1; i < changes.length; i++) {
        expect(changes[i]?.state).not.toBe(changes[i - 1]?.state);
      }
    }

    await sm.shutdown();
  });
});

describe("SessionRuntime: getSessionStates()", () => {
  it("returns all current session states", async () => {
    const sm = createSessionRuntime({
      concurrency: 1,
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));

    const states = sm.getSessionStates();
    expect(states).toHaveLength(2);

    const chatA = states.find((s) => s.chatId === "chat-a");
    const chatB = states.find((s) => s.chatId === "chat-b");

    // chat-b preempted chat-a, so chat-a is suspended, chat-b is active
    expect(chatA?.state).toBe("suspended");
    expect(chatB?.state).toBe("active");

    await sm.shutdown();
  });

  it("returns empty array when no sessions exist", async () => {
    const sm = createSessionRuntime({});
    expect(sm.getSessionStates()).toEqual([]);
    await sm.shutdown();
  });
});

describe("SessionRuntime: getEvictedChatIds()", () => {
  // After a process restart, SessionRegistry hydrates every persisted
  // (chatId → claudeSessionId) row into `evictedMappings` — `sessions` is
  // empty. The agent-slot full-state-sync uses these chatIds to advertise
  // them as "suspended" on the wire so the server's
  // `agent_chat_sessions.state` isn't stuck on a pre-restart snapshot.
  it("returns evictedMappings keys (LRU-evicted chats included)", async () => {
    const capturing = createCapturingFactory();
    const sm = createSessionRuntime({
      session: { idle_timeout: 300, max_sessions: 2, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
      handlerFactory: capturing.factory,
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await capturing.finish("chat-a");
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));
    // chat-c forces LRU eviction of the older idle chat (chat-a is evicted
    // out of `sessions` into `evictedMappings`).
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-c" }));

    const evicted = new Set(sm.getEvictedChatIds());
    expect(evicted.has("chat-a")).toBe(true);

    await sm.shutdown();
  });

  it("returns empty array when nothing has been evicted", async () => {
    const sm = createSessionRuntime({});
    expect(sm.getEvictedChatIds()).toEqual([]);
    await sm.shutdown();
  });
});

describe("SessionRuntime: shutdown state reporting", () => {
  it("withdraws runtime before reporting active sessions as suspended on shutdown", async () => {
    const emissions: Array<{ chatId: string; kind: "state" | "runtime"; value: string }> = [];
    const sm = createSessionRuntime({
      onStateChange: (chatId, state) => emissions.push({ chatId, kind: "state", value: state }),
      onSessionRuntimeChange: (chatId, { runtimeState: state }) =>
        emissions.push({ chatId, kind: "runtime", value: state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));

    emissions.length = 0;

    await sm.shutdown();

    for (const chatId of ["chat-a", "chat-b"]) {
      expect(emissions.filter((event) => event.chatId === chatId).slice(0, 2)).toEqual([
        { chatId, kind: "runtime", value: "idle" },
        { chatId, kind: "state", value: "suspended" },
      ]);
    }
  });

  it("does not report already-suspended sessions on shutdown", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const sm = createSessionRuntime({
      concurrency: 1,
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));

    // chat-a is already suspended (preempted by chat-b)
    stateChanges.length = 0;

    await sm.shutdown();

    // Only chat-b (active) should get a suspended notification
    // chat-a was already suspended (and dedup prevents re-notification)
    const chatAChanges = stateChanges.filter((c) => c.chatId === "chat-a");
    expect(chatAChanges).toHaveLength(0);

    const chatBChanges = stateChanges.filter((c) => c.chatId === "chat-b");
    expect(chatBChanges).toEqual([{ chatId: "chat-b", state: "suspended" }]);
  });
});

describe("SessionRuntime: terminate + reconcile", () => {
  it("handleCommand('session:terminate') withdraws runtime without inventing a client-owned terminal state", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const runtimeChanges: Array<{ chatId: string; state: RuntimeState }> = [];
    const sm = createSessionRuntime({
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
      onSessionRuntimeChange: (chatId, { runtimeState: state }) => runtimeChanges.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    stateChanges.length = 0;
    runtimeChanges.length = 0;

    await sm.handleCommand("chat-a", "session:terminate");
    // Direct SessionRuntime callers simulate server-confirmed Reset finalization.
    sm.releaseParkedResetFenceRecovery("chat-a");

    expect(stateChanges).toHaveLength(0); // server is authoritative
    expect(runtimeChanges).toEqual([{ chatId: "chat-a", state: "idle" }]);
    expect(sm.getSessionStates()).toEqual([]);
    expect(sm.getHeldChatIds()).toEqual([]);

    await sm.shutdown();
  });

  it("getHeldChatIds() unions active sessions and evicted mappings", async () => {
    const sm = createSessionRuntime({
      session: { idle_timeout: 300, max_sessions: 2, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));
    // LRU evicts chat-a into evictedMappings when chat-c enters
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-c" }));

    const held = new Set(sm.getHeldChatIds());
    expect(held.has("chat-a")).toBe(true); // evictedMappings
    expect(held.has("chat-b") || held.has("chat-c")).toBe(true); // live sessions

    await sm.shutdown();
  });

  it("applyStaleChatIds() cleans up both live sessions and evicted mappings", async () => {
    const stateChanges: Array<{ chatId: string; state: SessionState }> = [];
    const capturing = createCapturingFactory();
    const sm = createSessionRuntime({
      session: { idle_timeout: 300, max_sessions: 2, working_grace_seconds: 3600, reconcile_interval_seconds: 300 },
      handlerFactory: capturing.factory,
      onStateChange: (chatId, state) => stateChanges.push({ chatId, state }),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-a" }));
    await capturing.finish("chat-a");
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-b" }));
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-c" })); // chat-a → evictedMappings

    const held = sm.getHeldChatIds();
    expect(held).toContain("chat-a");

    stateChanges.length = 0;
    sm.applyStaleChatIds(held);

    // Wait a tick for the async handleCommand chain to drain
    await new Promise((r) => setTimeout(r, 10));

    expect(sm.getHeldChatIds()).toEqual([]);
    // Terminate should not emit wire notifications; server is authoritative
    expect(stateChanges).toHaveLength(0);

    await sm.shutdown();
  });
});
