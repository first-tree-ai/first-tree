import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRuntimeConfig,
  InboxEntryWithMessage,
  ProviderRetryEventPayload,
  RuntimeState,
  SessionEvent,
  SessionRuntimeReport,
  SessionState,
} from "@first-tree/shared";
import { encodeProviderRetryEventMessage, parseProviderRetryEventMessage } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FirstTreeHubSDK } from "../cloud/sdk.js";
import type {
  AgentHandler,
  DeliveryToken,
  HandlerFactory,
  SessionContext,
  SessionMessage,
} from "../runtime/handler.js";
import type { DeliveryDecision, DeliveryRouteOwnership, DeliveryWork } from "../runtime/inbox-delivery-coordinator.js";
import type { SubprocessProbe } from "../runtime/process-tree-probe.js";
import { PsSubprocessProbe } from "../runtime/process-tree-probe.js";
import { SessionRegistry } from "../runtime/session-registry.js";
import { SessionRuntime } from "../runtime/session-runtime.js";
import { recordingLogger, silentLogger } from "./_logger-helpers.js";
import { mockEntry } from "./test-helpers.js";

type SessionRecord = {
  chatId: string;
  claudeSessionId: string;
  handler: AgentHandler;
  handlerSourceKey: string;
  status: SessionState;
  lastActivity: number;
  suspending: Promise<void> | null;
  suspendError: { error: unknown } | null;
  handlerStoppedBySuspend: AgentHandler | null;
  teardownError: { error: unknown } | null;
  pendingRuntimeFailureNotice: ProviderRetryEventPayload | null;
};

type SessionSeed = Partial<SessionRecord> & {
  activeSlotHeld?: boolean;
  retryAttempt?: number;
  retryHeadMessage?: SessionMessage | null;
  retryFromEvicted?: { claudeSessionId: string; lastActivity: number } | null;
  lastRetryReason?: string | null;
  lastRetryCategory?: string | null;
  lastRetryScope?: "session_start" | "session_resume" | null;
  lastRetryRawError?: string | null;
  deferredMessages?: SessionMessage[];
  routeTransition?: { generation: number; handler: AgentHandler; phase: "start" | "resume" } | null;
  routeInjectReady?: boolean;
};

type SessionRuntimeInternals = {
  projection: {
    sessions: Map<string, SessionRecord>;
    evictedMappings: Map<string, { claudeSessionId: string; lastActivity: number }>;
    registry: SessionRegistry | null;
    sessionRuntimeStates: Map<string, RuntimeState>;
    currentTrigger: Map<string, { messageId: string; senderId: string }>;
    notifySessionState(chatId: string, state: SessionState): void;
    projectSessionRuntime(chatId: string, opts?: { drainPendingOnIdle?: boolean }): void;
    recomputeRuntimeState(): void;
    reaffirmRuntimeStates(): void;
    hasBackgroundWork(chatId: string): boolean;
    noteProviderTurnStart(chatId: string): void;
    noteProviderTurnEnd(chatId: string): void;
    persistRegistry(): void;
    recordHandlerSource(entry: SessionRecord, sourceKey: string): void;
  };
  resetReplay: {
    terminatingChats: Map<string, Promise<void>>;
    terminatePersistFailures: Set<string>;
    awaitingResetFenceRelease: Set<string>;
  };
  routeTeardown: {
    pendingTeardowns: Map<string, Set<AgentHandler>>;
    quarantinedSessions: Map<
      string,
      {
        handler: AgentHandler;
        generation: number;
        reason: "operator_suspend_timeout";
        routeTransitionInFlight: boolean;
      }
    >;
    routeProducers: Map<string, Set<Promise<void>>>;
    attachLiveSession(entry: SessionRecord): void;
    beginRouteTransition(
      entry: SessionRecord,
      handler: AgentHandler,
      phase: "start" | "resume",
    ): { generation: number; handler: AgentHandler; phase: "start" | "resume" };
    hasInFlightTransition(entry: SessionRecord): boolean;
    isRouteInjectReady(entry: SessionRecord): boolean;
    captureGeneration(entry: SessionRecord): number;
    markRouteInjectReady(entry: SessionRecord): boolean;
    registerPendingTeardown(chatId: string, handler: AgentHandler): void;
    detachHandlerWithPendingTeardown(chatId: string, handler: AgentHandler, reason: string): void;
    discardStaleRouteTransition(
      chatId: string,
      transition: { generation: number; handler: AgentHandler; phase: "start" | "resume" },
      reason: string,
    ): void;
  };
  slotScheduler: {
    pendingQueue: Array<{ message: SessionMessage | null; chatId: string; deliveryKind: string }>;
    activeCount: number;
    attachLiveSession(
      entry: SessionRecord,
      opts?: { resumeFromEvicted?: { claudeSessionId: string; lastActivity: number } | null },
    ): void;
    claimActiveSlot(entry: SessionRecord): void;
    isActiveSlotHeld(entry: SessionRecord): boolean;
    scheduleTransientRetry(
      entry: SessionRecord,
      args: {
        attemptedMessage: SessionMessage | null;
        attempt: number;
        reasonCode: string;
        category: string;
        scope: "session_start" | "session_resume";
        rawError: string | null;
        delayMs: number;
      },
    ): void;
    cancelRetryTimer(entry: SessionRecord): void;
    hasArmedRetryTimer(entry: SessionRecord): boolean;
    deferMessage(entry: SessionRecord, message: SessionMessage): void;
    deferredMessageSnapshot(entry: SessionRecord): readonly SessionMessage[];
    currentRetryAttempt(entry: SessionRecord): number;
    acquireActiveSlot(
      chatId: string,
      message: SessionMessage | null,
      deliveryKind?: string,
      opts?: { queueOnFailure?: boolean },
    ): boolean;
    runRetry(chatId: string): Promise<void>;
    drainPendingQueue(): void;
    triggerImmediateRetry(chatId: string): void;
    evictIfNeeded(): void;
  };
  inboxDelivery: {
    receive(entry: InboxEntryWithMessage): DeliveryDecision;
    markOwned(work: DeliveryWork): DeliveryRouteOwnership;
    hasEntry(work: DeliveryWork): boolean;
    markProcessingStarted(chatId: string, messages: SessionMessage | readonly SessionMessage[]): void;
    prepareOperatorSuspend(chatId: string): Promise<void>;
    drainForTerminate(chatId: string): Promise<void>;
    hasRecoveryDebt(chatId: string): boolean;
    hasUnsettledWork(chatId: string): boolean;
    snapshot(chatId: string): {
      entries: Array<{ entryId: number; messageId: string; phase: string }>;
      recoveryDebt: string;
      admissionPending: boolean;
    };
  };
  routeMessage(chatId: string, message: SessionMessage): Promise<void>;
  startNewSession(chatId: string, message: SessionMessage, deliveryKind?: string): Promise<void>;
  resumeSession(entry: SessionRecord, message: SessionMessage | null | undefined): Promise<void>;
  abortUnownedRoute(entry: SessionRecord, reason: string): void;
  ensureContextTreeBinding(): Promise<unknown>;
  markRouteOwned(
    chatId: string,
    message: SessionMessage,
    receipt: { kind: "owned"; mode: "queued" },
  ): DeliveryRouteOwnership;
  buildSessionContext(chatId: string): SessionContext;
  confirmSessionEventOrThrow(chatId: string, event: SessionEvent): Promise<void>;
};

type TestRuntimeState = RuntimeState;

const sessionConfig = {
  idle_timeout: 300,
  max_sessions: 10,
  working_grace_seconds: 3600,
  reconcile_interval_seconds: 300,
};

function mockSdk(): FirstTreeHubSDK {
  return {
    serverUrl: "https://first-tree.example.test",
    register: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ id: "msg-reply" }),
    sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
    listChatParticipants: vi.fn().mockResolvedValue([
      { agentId: "sender-1", role: "member", mode: "full", name: "alice", displayName: "Alice", type: "human" },
      { agentId: "agent-1", role: "member", mode: "full", name: "helper", displayName: "Helper", type: "agent" },
    ]),
  } as unknown as FirstTreeHubSDK;
}

function handler(overrides: Partial<AgentHandler> = {}): AgentHandler {
  return {
    start: vi
      .fn()
      .mockResolvedValue({ sessionId: "session-id", route: { kind: "owned" as const, mode: "queued" as const } }),
    resume: vi
      .fn()
      .mockResolvedValue({ sessionId: "session-id", route: { kind: "owned" as const, mode: "queued" as const } }),
    inject: vi.fn().mockReturnValue({ kind: "owned", mode: "queued" }),
    suspend: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function runtimeConfig(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return {
    agentId: "agent-1",
    version: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    updatedBy: "tester",
    payload: {
      kind: "claude-code",
      prompt: { append: "" },
      model: "opus",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
      reasoningEffort: "",
    },
    ...overrides,
  };
}

function makeCache(
  opts: {
    config?: AgentRuntimeConfig;
    refreshIfNewer?: (agentId: string, version: number) => Promise<AgentRuntimeConfig>;
  } = {},
) {
  const current = opts.config;
  return {
    get: vi.fn((agentId: string) => (agentId === "agent-1" ? current : undefined)),
    refreshIfNewer: vi.fn(
      opts.refreshIfNewer ??
        (async (agentId: string) => {
          if (current && current.agentId === agentId) return current;
          return runtimeConfig({ agentId });
        }),
    ),
    refresh: vi.fn(),
    updateSdk: vi.fn(),
    updateUrls: vi.fn(),
    allReferencedUrls: vi.fn(() => new Set<string>()),
    forget: vi.fn(),
  };
}

function makeRuntime(
  opts: {
    handlers?: AgentHandler[];
    handlerFactory?: HandlerFactory;
    ackEntry?: (entryId: number) => Promise<void>;
    recoverChat?: (chatId: string) => Promise<void>;
    registryPath?: string;
    concurrency?: number;
    maxSessions?: number;
    sdk?: FirstTreeHubSDK;
    agentConfigCache?: ReturnType<typeof makeCache>;
    log?: ReturnType<typeof silentLogger>;
    subprocessProbe?: SubprocessProbe;
    onStateChange?: (chatId: string, state: SessionState) => void;
    onRuntimeStateChange?: (state: TestRuntimeState) => void;
    onSessionRuntimeChange?: (chatId: string, report: SessionRuntimeReport) => void;
    onSessionEvent?: (chatId: string, event: SessionEvent) => void;
    confirmSessionEvent?: (chatId: string, event: SessionEvent) => Promise<void>;
    workspaceRoot?: string;
    runtimeSessionTokenFile?: string;
  } = {},
): SessionRuntime {
  const handlers = [...(opts.handlers ?? [handler()])];
  const handlerFactory =
    opts.handlerFactory ??
    (() => {
      const next = handlers.shift();
      if (!next) throw new Error("handler factory exhausted");
      return next;
    });

  return new SessionRuntime({
    session: { ...sessionConfig, max_sessions: opts.maxSessions ?? sessionConfig.max_sessions },
    concurrency: opts.concurrency ?? 5,
    subprocessProbe: opts.subprocessProbe,
    handlerFactory,
    handlerConfig: { workspaceRoot: opts.workspaceRoot ?? "/tmp/test-edge/agent-a", runtimeProvider: "codex" },
    agentIdentity: {
      agentId: "agent-1",
      inboxId: "inbox-agent-1",
      displayName: "Agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: opts.sdk ?? mockSdk(),
    log: opts.log ?? silentLogger(),
    registryPath: opts.registryPath,
    agentConfigCache: opts.agentConfigCache,
    runtimeSessionTokenFile: opts.runtimeSessionTokenFile,
    ackEntry: opts.ackEntry ?? vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined),
    recoverChat: opts.recoverChat,
    onStateChange: opts.onStateChange,
    onRuntimeStateChange: opts.onRuntimeStateChange,
    onSessionRuntimeChange: opts.onSessionRuntimeChange,
    onSessionEvent: opts.onSessionEvent,
    confirmSessionEvent: opts.confirmSessionEvent,
  });
}

function internals(sm: SessionRuntime): SessionRuntimeInternals {
  return sm as unknown as SessionRuntimeInternals;
}

function makeMessage(chatId: string): SessionMessage {
  return {
    id: `msg-${chatId}`,
    chatId,
    senderId: "sender-1",
    format: "text",
    content: "hello",
    metadata: {},
    precedingMessages: [],
  };
}

function messageFromEntry(entry: InboxEntryWithMessage): SessionMessage {
  return {
    inboxEntryId: entry.id,
    id: entry.message.id,
    chatId: entry.chatId ?? entry.message.chatId,
    senderId: entry.message.senderId,
    format: entry.message.format,
    content: entry.message.content as string,
    metadata: entry.message.metadata,
    precedingMessages: entry.message.precedingMessages ?? [],
  };
}

const pendingSeeds = new WeakMap<SessionRecord, SessionSeed>();

function makeSessionRecord(chatId: string, overrides: SessionSeed = {}): SessionRecord {
  const status = overrides.status ?? "suspended";
  const record: SessionRecord = {
    chatId,
    claudeSessionId: overrides.claudeSessionId ?? `session-${chatId}`,
    handler: overrides.handler ?? handler(),
    handlerSourceKey: overrides.handlerSourceKey ?? "none",
    status,
    lastActivity: overrides.lastActivity ?? Date.now(),
    suspending: overrides.suspending ?? null,
    suspendError: overrides.suspendError ?? null,
    handlerStoppedBySuspend: overrides.handlerStoppedBySuspend ?? null,
    teardownError: overrides.teardownError ?? null,
    pendingRuntimeFailureNotice: overrides.pendingRuntimeFailureNotice ?? null,
  };
  pendingSeeds.set(record, overrides);
  return record;
}

function bindSeededSession(i: SessionRuntimeInternals, record: SessionRecord): SessionRecord {
  const overrides = pendingSeeds.get(record) ?? {};
  i.projection.sessions.set(record.chatId, record);
  i.projection.recordHandlerSource(record, "none");
  i.slotScheduler.attachLiveSession(record, { resumeFromEvicted: overrides.retryFromEvicted ?? null });
  i.routeTeardown.attachLiveSession(record);
  if (overrides.activeSlotHeld ?? overrides.status === "active") i.slotScheduler.claimActiveSlot(record);
  if ((overrides.retryAttempt ?? 0) > 0) {
    i.slotScheduler.scheduleTransientRetry(record, {
      attemptedMessage: overrides.retryHeadMessage ?? null,
      attempt: overrides.retryAttempt ?? 1,
      reasonCode: overrides.lastRetryReason ?? "unknown",
      category: overrides.lastRetryCategory ?? "unknown",
      scope: overrides.lastRetryScope ?? "session_start",
      rawError: overrides.lastRetryRawError ?? null,
      delayMs: 60_000,
    });
    // Old SessionEntry defaulted retryTimer to null even when retryAttempt > 0.
    // Production re-arm / explicit scheduleTransientRetry still own live timers.
    i.slotScheduler.cancelRetryTimer(record);
  }
  for (const message of overrides.deferredMessages ?? []) {
    i.slotScheduler.deferMessage(record, message);
  }
  if (overrides.routeTransition) {
    i.routeTeardown.beginRouteTransition(record, overrides.routeTransition.handler, overrides.routeTransition.phase);
    if (overrides.routeInjectReady) i.routeTeardown.markRouteInjectReady(record);
  }
  return record;
}

function installSession(i: SessionRuntimeInternals, chatId: string, overrides: SessionSeed = {}): SessionRecord {
  return bindSeededSession(i, makeSessionRecord(chatId, overrides));
}

function requireSession(i: SessionRuntimeInternals, chatId: string): SessionRecord {
  const entry = i.projection.sessions.get(chatId);
  if (!entry) throw new Error(`session missing: ${chatId}`);
  return entry;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("SessionRuntime edge coverage", () => {
  it("filters runtime sync by active set while force-keeping queued work", async () => {
    const sm = makeRuntime();
    const i = internals(sm);
    installSession(i, "chat-active");
    installSession(i, "chat-archived");
    installSession(i, "chat-pending");
    i.projection.evictedMappings.set("chat-evicted-active", { claudeSessionId: "evicted-active", lastActivity: 1 });
    i.projection.evictedMappings.set("chat-evicted-archived", { claudeSessionId: "evicted-archived", lastActivity: 2 });
    i.slotScheduler.pendingQueue.push({
      chatId: "chat-pending",
      message: makeMessage("chat-pending"),
      deliveryKind: "fresh",
    });

    const activeSet = new Set(["chat-active", "chat-evicted-active"]);

    expect(sm.getHeldChatIds(activeSet)).toEqual(["chat-active", "chat-pending", "chat-evicted-active"]);
    expect(sm.getSessionStates(activeSet)).toEqual([
      { chatId: "chat-active", state: "suspended" },
      { chatId: "chat-pending", state: "suspended" },
    ]);
    expect(sm.getEvictedChatIds(activeSet)).toEqual(["chat-evicted-active"]);

    await sm.shutdown();
  });

  it("operator suspend clears routeInjectReady with the routeTransition pointer", async () => {
    const activeHandler = handler();
    const sm = makeRuntime({ handlers: [activeHandler] });
    const i = internals(sm);
    const chatId = "chat-inject-ready-suspend";
    const record = bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        status: "active",
        activeSlotHeld: true,
        handler: activeHandler,
        routeTransition: { generation: 1, handler: activeHandler, phase: "start" },
        routeInjectReady: true,
        deferredMessages: [makeMessage(chatId)],
      }),
    );
    const generation = i.routeTeardown.captureGeneration(record);
    i.slotScheduler.activeCount = 1;

    // Operator suspend clears the transition pointer immediately while keeping
    // generation stable through settle. Probe the entry before awaiting the
    // suspending promise so we observe that latch-clear window.
    const suspendPromise = sm.handleCommand(chatId, "session:suspend");
    const duringSettle = i.projection.sessions.get(chatId);
    expect(duringSettle).toBeDefined();
    if (!duringSettle) throw new Error("session missing during operator suspend");
    expect(i.routeTeardown.hasInFlightTransition(duringSettle)).toBe(false);
    expect(i.routeTeardown.isRouteInjectReady(duringSettle)).toBe(false);
    expect(duringSettle.status).toBe("suspended");
    expect(i.routeTeardown.captureGeneration(duringSettle)).toBe(generation);

    await suspendPromise;
    const afterSettle = i.projection.sessions.get(chatId);
    expect(afterSettle ? i.routeTeardown.hasInFlightTransition(afterSettle) : true).toBe(false);
    expect(afterSettle ? i.routeTeardown.isRouteInjectReady(afterSettle) : true).toBe(false);

    await sm.shutdown();
  });

  it("refreshes newer config before dispatch and logs refresh failures without blocking delivery", async () => {
    const okCache = makeCache();
    const okHandler = handler();
    const ok = makeRuntime({ handlers: [okHandler], agentConfigCache: okCache });

    await ok.dispatch(mockEntry({ id: 1, chatId: "chat-config-ok" }));

    expect(okCache.refreshIfNewer).toHaveBeenCalledWith("agent-1", 1);
    expect(okHandler.start).toHaveBeenCalledTimes(1);
    await ok.shutdown();

    const failingCache = makeCache({
      refreshIfNewer: async () => {
        throw new Error("server unavailable");
      },
    });
    const failHandler = handler();
    const fail = makeRuntime({ handlers: [failHandler], agentConfigCache: failingCache });

    await fail.dispatch(mockEntry({ id: 2, chatId: "chat-config-fail" }));

    expect(failingCache.refreshIfNewer).toHaveBeenCalledWith("agent-1", 1);
    expect(failHandler.start).toHaveBeenCalledTimes(1);
    await fail.shutdown();
  });

  it("handles suspend, terminate, pending-queue cleanup, ack failures, and quiet-gate snapshots", async () => {
    const first = handler({
      async start() {
        return { sessionId: "idle-log-session", route: { kind: "owned" as const, mode: "queued" as const } };
      },
    });
    const ackEntry = vi
      .fn<(entryId: number) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("ack offline"))
      .mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const states: Array<{ chatId: string; state: SessionState }> = [];
    const sm = makeRuntime({
      handlers: [first, handler()],
      ackEntry,
      recoverChat,
      concurrency: 1,
      onStateChange: (chatId, state) => states.push({ chatId, state }),
    });

    const firstEntry = mockEntry({ id: 1, chatId: "chat-active" });
    await sm.dispatch(firstEntry);
    await sm.dispatch(firstEntry);
    expect(sm.activeCount).toBe(1);
    expect(sm.getQuietGateSnapshot().activeCount).toBe(1);
    expect(sm.getQuietGateSnapshot().lastActivityMs).toBeGreaterThan(0);

    await sm.handleCommand("missing", "session:terminate");
    await sm.handleCommand("chat-active", "session:suspend");
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-active" }));
    // Same-socket recovery fail-closed: suspending clears unfinished local
    // entries and newer same-chat input asks the server to reset/redeliver
    // before the handler resumes.
    expect(recoverChat).toHaveBeenCalledTimes(1);
    expect(ackEntry).not.toHaveBeenCalledWith(2);

    internals(sm).slotScheduler.pendingQueue.push({
      chatId: "chat-queued",
      message: makeMessage("chat-queued"),
      deliveryKind: "fresh",
    });
    internals(sm).projection.evictedMappings.set("chat-queued", { claudeSessionId: "queued-session", lastActivity: 1 });
    expect(internals(sm).slotScheduler.pendingQueue.some((item) => item.chatId === "chat-queued")).toBe(true);

    await sm.handleCommand("chat-queued", "session:terminate");
    expect(internals(sm).slotScheduler.pendingQueue.some((item) => item.chatId === "chat-queued")).toBe(false);
    expect(states.some((item) => item.chatId === "chat-active" && item.state === "suspended")).toBe(true);

    await sm.shutdown();
  });

  it("terminates retrying sessions by clearing retry timers and evicted mappings", async () => {
    const sm = makeRuntime();
    bindSeededSession(
      internals(sm),
      makeSessionRecord("chat-retry", {
        status: "suspended",
        retryAttempt: 1,
      }),
    );
    internals(sm).projection.evictedMappings.set("chat-retry", { claudeSessionId: "old-session", lastActivity: 1 });

    await sm.handleCommand("chat-retry", "session:terminate");

    expect(internals(sm).projection.sessions.has("chat-retry")).toBe(false);
    expect(internals(sm).projection.evictedMappings.has("chat-retry")).toBe(false);
    await sm.shutdown();
  });

  it("loads persisted registry mappings, prunes the oldest, resumes from disk, and persists live plus evicted rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-session-registry-"));
    const registryPath = join(dir, "sessions.json");
    const entries: Record<string, { claudeSessionId: string; lastActivity: string; status: SessionState }> = {};
    for (let i = 0; i < 501; i++) {
      entries[`chat-${i}`] = {
        claudeSessionId: `persisted-${i}`,
        lastActivity: new Date(1_000 + i).toISOString(),
        status: "suspended",
      };
    }
    entries["chat-empty-legacy"] = {
      claudeSessionId: "",
      lastActivity: new Date(10_000).toISOString(),
      status: "suspended",
    };
    writeFileSync(registryPath, JSON.stringify({ version: 1, entries }), "utf-8");

    const resumed = handler({
      resume: vi.fn().mockResolvedValue({
        sessionId: "resumed-from-registry",
        route: { kind: "owned" as const, mode: "queued" as const },
      }),
    });
    const sm = makeRuntime({ handlers: [resumed], registryPath, maxSessions: 501 });

    expect(sm.getEvictedChatIds()).not.toContain("chat-0");
    expect(sm.getEvictedChatIds()).toContain("chat-500");
    expect(sm.getEvictedChatIds()).not.toContain("chat-empty-legacy");

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-500" }));
    expect(resumed.resume).toHaveBeenCalledWith(
      expect.anything(),
      "persisted-500",
      expect.anything(),
      expect.anything(),
    );

    internals(sm).projection.evictedMappings.set("chat-extra", {
      claudeSessionId: "evicted-extra",
      lastActivity: 2_000,
    });
    internals(sm).projection.persistRegistry();
    await sm.shutdown();

    rmSync(dir, { recursive: true, force: true });
  });

  it("does not persist an unresolved fresh start as an empty resume mapping across manager restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-session-registry-unresolved-start-"));
    const registryPath = join(dir, "sessions.json");
    let signalStartStarted: (() => void) | undefined;
    let resolveStart: (() => void) | undefined;
    const startStarted = new Promise<void>((resolve) => {
      signalStartStarted = resolve;
    });
    const startGate = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const pendingHandler = handler({
      start: vi.fn().mockImplementation(async () => {
        signalStartStarted?.();
        await startGate;
        return { sessionId: "stale-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
    });
    const first = makeRuntime({ handlers: [pendingHandler], registryPath });
    const chatId = "chat-registry-unresolved-start";
    const entry = mockEntry({ id: 91, chatId, messageId: "msg-registry-unresolved-start" });

    const pendingDispatch = first.dispatch(entry);
    await startStarted;

    // Manager shutdown joins the in-flight route producer: it must not
    // return while the provider start is still gated (the unresolved start
    // could still materialize late).
    const firstShutdown = first.shutdown();
    let firstShutdownSettled = false;
    void firstShutdown.then(() => {
      firstShutdownSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(firstShutdownSettled).toBe(false);

    resolveStart?.();
    await firstShutdown;
    await pendingDispatch;

    const persisted = JSON.parse(readFileSync(registryPath, "utf-8")) as { entries: Record<string, unknown> };
    expect(persisted.entries).toEqual({});

    const replacement = handler({
      start: vi.fn().mockResolvedValue({
        sessionId: "replacement-session",
        route: { kind: "owned" as const, mode: "queued" as const },
      }),
    });
    const second = makeRuntime({ handlers: [replacement], registryPath });
    await second.dispatch(entry);

    expect(replacement.start).toHaveBeenCalledTimes(1);
    expect(replacement.resume).not.toHaveBeenCalled();
    expect(internals(second).projection.sessions.get(chatId)?.claudeSessionId).toBe("replacement-session");

    await second.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("clears persisted mappings on destructive runtime-switch shutdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-session-registry-switch-"));
    const registryPath = join(dir, "sessions.json");
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        entries: {
          "chat-persisted": {
            claudeSessionId: "persisted-session",
            lastActivity: new Date(1_000).toISOString(),
            status: "evicted",
          },
        },
      }),
      "utf-8",
    );

    const onStateChange = vi.fn();
    const activeHandler = handler();
    const sm = makeRuntime({ handlers: [activeHandler], registryPath, onStateChange });
    expect(sm.getEvictedChatIds()).toContain("chat-persisted");

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-active" }));
    expect(activeHandler.start).toHaveBeenCalled();
    onStateChange.mockClear();
    internals(sm).projection.evictedMappings.set("chat-extra", {
      claudeSessionId: "extra-session",
      lastActivity: 2_000,
    });
    internals(sm).projection.persistRegistry();

    await sm.shutdown("runtime switched by server", {
      clearPersistedRegistry: true,
      reportSuspendedSessions: false,
    });

    const data = JSON.parse(readFileSync(registryPath, "utf-8")) as { entries: Record<string, unknown> };
    expect(data.entries).toEqual({});
    expect(onStateChange).not.toHaveBeenCalledWith("chat-active", "suspended");

    const reloaded = makeRuntime({ registryPath });
    expect(reloaded.getEvictedChatIds()).toEqual([]);
    await reloaded.shutdown();

    rmSync(dir, { recursive: true, force: true });
  });

  it("builds session context plumbing from cached config and falls back when self-fence refresh fails", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "ft-session-context-"));
    const sdk = mockSdk();
    const sendMessage = vi.mocked(sdk.sendMessage);
    const config = runtimeConfig({
      payload: {
        kind: "claude-code",
        prompt: { append: "" },
        model: "opus",
        mcpServers: [],
        env: [],
        gitRepos: [{ url: "https://github.com/acme/project.git", localPath: "project" }],
        resourceSkills: [],
        reasoningEffort: "",
      },
    });
    const cache = makeCache({
      config,
      refreshIfNewer: async () => {
        throw new Error("refresh failed");
      },
    });
    let captured: SessionContext | undefined;
    const first = handler({
      async start(_message, ctx) {
        captured = ctx;
        ctx.log("started");
        ctx.recordProviderActivity();
        return { sessionId: "session-context", route: { kind: "owned" as const, mode: "queued" as const } };
      },
    });
    const sm = makeRuntime({
      handlers: [first],
      sdk,
      workspaceRoot,
      agentConfigCache: cache,
      runtimeSessionTokenFile: "/tmp/runtime-session-token",
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-context" }));
    expect(captured).toBeDefined();
    const ctx = captured;
    if (!ctx) throw new Error("context was not captured");

    const env = ctx.buildAgentEnv({ PATH: "/usr/bin" });
    // Single source repo "project" → its clone lives under the `source-repos/`
    // layer, so the narrow doc base and the agentHome-relative repo path both
    // carry the `source-repos/` prefix.
    expect(env.FIRST_TREE_DOC_BASE).toBe(join(workspaceRoot, "source-repos", "project"));
    expect(env.FIRST_TREE_DOC_AGENT_HOME).toBe(workspaceRoot);
    expect(env.FIRST_TREE_DOC_REPO_LOCAL_PATH).toBe("source-repos/project");
    expect(env.FIRST_TREE_WORKSPACES_ROOT).toBe(tmpdir());
    expect(env.FIRST_TREE_AGENT_SLUG).toBe(workspaceRoot.split("/").at(-1));
    expect(env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE).toBe("/tmp/runtime-session-token");

    const formatted = await ctx.formatInboundContent({
      id: "msg-format",
      chatId: "chat-context",
      senderId: "sender-1",
      format: "text",
      content: { text: "structured" },
      metadata: {},
      precedingMessages: [
        {
          id: "prior",
          senderId: "agent-1",
          format: "text",
          content: "prior text",
          metadata: {},
          createdAt: new Date().toISOString(),
        },
      ],
    });
    expect(formatted).toContain("[Earlier in chat");
    // Header now carries name + optional type/sent annotations; assert the
    // attribution prefix and the body rather than the exact bracket close.
    expect(formatted).toContain("[From: helper");
    expect(formatted).toContain("prior text");
    expect(formatted).toContain("[From: alice");
    expect(await ctx.resolveSenderLabel("sender-1")).toBe("alice");

    // Final-text delivery is retired: forwardResult writes nothing to chat.
    await ctx.forwardResult("final answer");
    expect(sendMessage).not.toHaveBeenCalled();

    await sm.shutdown();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("builds context defaults when config cache has no payload", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "ft-session-context-empty-"));
    const cache = makeCache();
    let captured: SessionContext | undefined;
    const sm = makeRuntime({
      handlers: [
        handler({
          async start(_message, ctx) {
            captured = ctx;
            return { sessionId: "session-empty-cache", route: { kind: "owned" as const, mode: "queued" as const } };
          },
        }),
      ],
      workspaceRoot,
      agentConfigCache: cache,
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-empty-cache" }));
    if (!captured) throw new Error("context was not captured");

    const env = captured.buildAgentEnv({});
    expect(env.FIRST_TREE_DOC_BASE).toBe(workspaceRoot);
    expect(env.FIRST_TREE_DOC_AGENT_HOME).toBe(workspaceRoot);
    expect(env.FIRST_TREE_DOC_REPO_LOCAL_PATH).toBeUndefined();

    await sm.shutdown();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("routes entries whose inbox chatId is absent through the message chatId and defaults missing preceding history", async () => {
    let seen: SessionMessage | undefined;
    const first = handler({
      async start(message) {
        seen = message;
        return { sessionId: "session-no-entry-chat", route: { kind: "owned" as const, mode: "queued" as const } };
      },
    });
    const sm = makeRuntime({ handlers: [first] });
    const base = mockEntry({ id: 1, chatId: "message-chat" });
    const entry = {
      ...base,
      chatId: null,
      message: {
        ...base.message,
        precedingMessages: undefined,
      },
    } as unknown as InboxEntryWithMessage;

    await sm.dispatch(entry);

    expect(seen?.chatId).toBe("message-chat");
    expect(seen?.precedingMessages).toEqual([]);
    await sm.shutdown();
  });

  it("waits for in-flight suspension and supports admin resume without a message", async () => {
    const resume = vi.fn().mockResolvedValue("resumed-admin");
    const record = makeSessionRecord("chat-admin-resume", {
      status: "suspended",
      claudeSessionId: "old-session",
      handler: handler({ resume }),
      suspending: Promise.resolve(),
    });
    const sm = makeRuntime();
    bindSeededSession(internals(sm), record);

    await internals(sm).resumeSession(record, null);

    expect(resume).toHaveBeenCalledWith(undefined, "old-session", expect.anything());
    expect(sm.activeCount).toBe(1);
    await sm.shutdown();
  });

  it("queues admin resume as a control item when no active slot can be acquired", async () => {
    const record = makeSessionRecord("chat-queued-resume", { status: "suspended" });
    const sm = makeRuntime({ concurrency: 1 });
    bindSeededSession(internals(sm), record);
    internals(sm).slotScheduler.activeCount = 1;

    await internals(sm).resumeSession(record, null);

    expect(
      internals(sm).slotScheduler.pendingQueue.some(
        (item) => item.chatId === "chat-queued-resume" && item.message === null && item.deliveryKind === "control",
      ),
    ).toBe(true);
    await sm.shutdown();
  });

  it("does not let message-less resume preempt an unrelated working session", async () => {
    const workingSuspend = vi.fn().mockResolvedValue(undefined);
    const working = makeSessionRecord("chat-working", {
      status: "active",
      lastActivity: 1,
      handler: handler({ suspend: workingSuspend }),
    });
    const pausedResume = vi.fn().mockResolvedValue("resumed-paused");
    const paused = makeSessionRecord("chat-paused", {
      status: "suspended",
      handler: handler({ resume: pausedResume }),
    });
    const sm = makeRuntime({ concurrency: 1 });
    bindSeededSession(internals(sm), working);
    bindSeededSession(internals(sm), paused);
    internals(sm).slotScheduler.activeCount = 1;

    const workingEntry = mockEntry({ id: 99, chatId: "chat-working" });
    const decision = internals(sm).inboxDelivery.receive(workingEntry);
    expect(decision.kind).toBe("deliver");
    if (decision.kind === "deliver") {
      internals(sm).inboxDelivery.markOwned(decision.work);
      internals(sm).inboxDelivery.markProcessingStarted("chat-working", messageFromEntry(workingEntry));
    }

    await sm.handleCommand("chat-paused", "session:resume");

    expect(workingSuspend).not.toHaveBeenCalled();
    expect(pausedResume).not.toHaveBeenCalled();
    expect(
      internals(sm).slotScheduler.pendingQueue.some(
        (item) => item.chatId === "chat-paused" && item.message === null && item.deliveryKind === "control",
      ),
    ).toBe(true);
    await sm.shutdown();
  });

  it("routes same-chat delivery after manual suspend without explicit resume", async () => {
    const resume = vi
      .fn()
      .mockResolvedValue({ sessionId: "resumed-paused", route: { kind: "owned" as const, mode: "queued" as const } });
    const paused = makeSessionRecord("chat-paused", {
      status: "suspended",
      claudeSessionId: "old-paused-session",
      handler: handler({ resume }),
    });
    const sm = makeRuntime({ concurrency: 1 });
    bindSeededSession(internals(sm), paused);

    await sm.handleCommand("chat-paused", "session:suspend");

    const entry = mockEntry({ id: 101, chatId: "chat-paused" });
    await sm.dispatch(entry);

    expect(resume).toHaveBeenCalledWith(
      expect.objectContaining({ inboxEntryId: 101, chatId: "chat-paused" }),
      "old-paused-session",
      expect.anything(),
      expect.anything(),
    );
    expect(internals(sm).slotScheduler.pendingQueue.some((item) => item.chatId === "chat-paused")).toBe(false);
    expect(sm.activeCount).toBe(1);
    await sm.shutdown();
  });

  it("queues recovery redelivery instead of preempting a working session", async () => {
    const working = handler({
      async start(message, ctx) {
        ctx.markMessagesConsumed(message);
        return { sessionId: "working-session", route: { kind: "owned" as const, mode: "queued" as const } };
      },
    });
    const recovered = handler();
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({
      concurrency: 1,
      handlers: [working, recovered],
      recoverChat,
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-working", messageId: "msg-working" }));
    internals(sm).projection.evictedMappings.set("chat-recovery", { claudeSessionId: "old-recovery", lastActivity: 1 });

    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-recovery", messageId: "msg-recovery" }));
    expect(recoverChat).toHaveBeenCalledWith("chat-recovery");

    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-recovery", messageId: "msg-recovery" }));

    expect(working.suspend).not.toHaveBeenCalled();
    expect(recovered.start).not.toHaveBeenCalled();
    expect(internals(sm).slotScheduler.pendingQueue.some((item) => item.chatId === "chat-recovery")).toBe(true);

    await sm.shutdown();
  });

  it("keeps the recovery window open across multiple queued recovered frames", async () => {
    const working = handler({
      async start(message, ctx) {
        ctx.markMessagesConsumed(message);
        return { sessionId: "working-session", route: { kind: "owned" as const, mode: "queued" as const } };
      },
    });
    const recovered = handler();
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({
      concurrency: 1,
      handlers: [working, recovered],
      recoverChat,
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-working", messageId: "msg-working" }));
    internals(sm).projection.evictedMappings.set("chat-recovery", { claudeSessionId: "old-recovery", lastActivity: 1 });

    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-recovery", messageId: "msg-recovery-1" }));
    expect(recoverChat).toHaveBeenCalledTimes(1);

    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-recovery", messageId: "msg-recovery-1" }));
    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-recovery", messageId: "msg-recovery-2" }));

    expect(recoverChat).toHaveBeenCalledTimes(1);
    expect(recovered.start).not.toHaveBeenCalled();
    expect(internals(sm).slotScheduler.pendingQueue.filter((item) => item.chatId === "chat-recovery")).toHaveLength(2);

    await sm.shutdown();
  });

  it("does not let a queued recovery steal a slot released for fresh preemption", async () => {
    const lifecycles: Array<{ chatId: string; phase: "start" | "resume" }> = [];
    const makeTrackedHandler = () =>
      handler({
        async start(message, ctx) {
          lifecycles.push({ chatId: message.chatId, phase: "start" });
          if (message.chatId === "chat-working") ctx.markMessagesConsumed(message);
          return { sessionId: `session-${message.chatId}`, route: { kind: "owned" as const, mode: "queued" as const } };
        },
        async resume(message) {
          lifecycles.push({ chatId: message?.chatId ?? "", phase: "resume" });
          return {
            sessionId: `session-${message?.chatId ?? "unknown"}`,
            route: { kind: "owned" as const, mode: "queued" as const },
          };
        },
      });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({
      concurrency: 1,
      handlers: [makeTrackedHandler(), makeTrackedHandler(), makeTrackedHandler()],
      recoverChat,
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-working", messageId: "msg-working" }));
    internals(sm).projection.evictedMappings.set("chat-recovery", { claudeSessionId: "old-recovery", lastActivity: 1 });
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-recovery", messageId: "msg-recovery" }));
    await sm.dispatch(mockEntry({ id: 2, chatId: "chat-recovery", messageId: "msg-recovery" }));
    expect(internals(sm).slotScheduler.pendingQueue.some((item) => item.chatId === "chat-recovery")).toBe(true);

    await sm.dispatch(mockEntry({ id: 3, chatId: "chat-fresh", messageId: "msg-fresh" }));

    expect(sm.activeCount).toBe(1);
    expect(lifecycles).toEqual([
      { chatId: "chat-working", phase: "start" },
      { chatId: "chat-fresh", phase: "start" },
    ]);
    expect(internals(sm).slotScheduler.pendingQueue.some((item) => item.chatId === "chat-recovery")).toBe(true);

    await sm.shutdown();
  });

  it("marks queued inbox work for recovery when pending drain routing fails", async () => {
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    let firstContext: SessionContext | undefined;
    let firstMessage: SessionMessage | undefined;
    let factoryCalls = 0;
    const sm = makeRuntime({
      ackEntry,
      recoverChat,
      concurrency: 1,
      maxSessions: 1,
      handlerFactory: () => {
        factoryCalls++;
        if (factoryCalls > 1) throw new Error("handler factory unavailable");
        return handler({
          async start(message, ctx) {
            firstMessage = message;
            firstContext = ctx;
            ctx.markMessagesConsumed(message);
            return { sessionId: "session-chat-working", route: { kind: "owned" as const, mode: "queued" as const } };
          },
        });
      },
    });

    await sm.dispatch(mockEntry({ id: 10, chatId: "chat-working", messageId: "msg-working" }));
    await sm.dispatch(mockEntry({ id: 11, chatId: "chat-queued", messageId: "msg-queued" }));
    expect(internals(sm).slotScheduler.pendingQueue.some((item) => item.chatId === "chat-queued")).toBe(true);
    if (!firstContext || !firstMessage) throw new Error("first context missing");

    await firstContext.finishTurn(firstMessage, { status: "success", terminal: true });

    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith("chat-queued"));
    expect(internals(sm).inboxDelivery.snapshot("chat-working").entries).toEqual([
      expect.objectContaining({ entryId: 10, phase: "terminal" }),
    ]);
    expect(internals(sm).slotScheduler.pendingQueue.some((item) => item.chatId === "chat-queued")).toBe(false);

    await sm.shutdown();
  });

  it("covers retry early returns, retry re-queue, start, resume fallback, and emit failures", async () => {
    const events: SessionEvent[] = [];
    const sm = makeRuntime({
      concurrency: 1,
      handlers: [
        handler({
          start: vi.fn().mockResolvedValue({
            sessionId: "retry-empty-start",
            route: { kind: "owned" as const, mode: "queued" as const },
          }),
        }),
        handler({
          resume: vi.fn().mockResolvedValue({
            sessionId: "retry-from-evicted",
            route: { kind: "owned" as const, mode: "queued" as const },
          }),
        }),
      ],
      onSessionEvent: (_chatId, event) => events.push(event),
    });

    await internals(sm).slotScheduler.runRetry("missing-chat");
    bindSeededSession(internals(sm), makeSessionRecord("chat-active", { status: "active", retryAttempt: 1 }));
    await internals(sm).slotScheduler.runRetry("chat-active");

    const queued = makeSessionRecord("chat-retry-queue", {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "",
      retryHeadMessage: makeMessage("chat-retry-queue"),
      lastRetryReason: "rate_limit",
    });
    bindSeededSession(internals(sm), queued);
    const activeRecord = internals(sm).projection.sessions.get("chat-active");
    if (!activeRecord) throw new Error("active retry guard record missing");
    activeRecord.status = "suspended";
    internals(sm).slotScheduler.activeCount = 1;
    await internals(sm).slotScheduler.runRetry("chat-retry-queue");
    expect(internals(sm).slotScheduler.hasArmedRetryTimer(queued)).toBe(true);
    internals(sm).slotScheduler.cancelRetryTimer(queued);

    internals(sm).slotScheduler.activeCount = 0;
    await internals(sm).slotScheduler.runRetry("chat-retry-queue");
    expect(queued.claudeSessionId).toBe("retry-empty-start");

    const fromEvicted = makeSessionRecord("chat-retry-evicted", {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "",
      retryFromEvicted: { claudeSessionId: "evicted-session", lastActivity: 1 },
      retryHeadMessage: makeMessage("chat-retry-evicted"),
      lastRetryReason: "network_error",
    });
    bindSeededSession(internals(sm), fromEvicted);
    await internals(sm).slotScheduler.runRetry("chat-retry-evicted");
    expect(fromEvicted.claudeSessionId).toBe("retry-from-evicted");

    expect(events.some((event) => event.kind === "error")).toBe(true);

    internals(sm).slotScheduler.triggerImmediateRetry("missing");
    installSession(internals(sm), "chat-no-retry", { retryAttempt: 0 });
    internals(sm).slotScheduler.triggerImmediateRetry("chat-no-retry");
    await sm.shutdown();
  });

  it("does not let runRetry bypass existing recovery debt", async () => {
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const recovered = handler({
      start: vi.fn().mockResolvedValue({
        sessionId: "should-not-start",
        route: { kind: "owned" as const, mode: "queued" as const },
      }),
    });
    const sm = makeRuntime({ handlers: [recovered], recoverChat });
    const chatId = "chat-retry-debt";
    const inbox = internals(sm).inboxDelivery;

    inbox.receive(mockEntry({ id: 77, chatId, messageId: "msg-retry-debt" }));
    await inbox.prepareOperatorSuspend(chatId);
    expect(inbox.hasRecoveryDebt(chatId)).toBe(true);

    const retrying = makeSessionRecord(chatId, {
      retryAttempt: 1,
      status: "suspended",
      retryHeadMessage: makeMessage(chatId),
      lastRetryReason: "rate_limit",
    });
    bindSeededSession(internals(sm), retrying);

    await internals(sm).slotScheduler.runRetry(chatId);

    expect(recoverChat).toHaveBeenCalledWith(chatId);
    expect(recovered.start).not.toHaveBeenCalled();
    expect(internals(sm).slotScheduler.currentRetryAttempt(retrying)).toBe(0);
    await sm.shutdown();
  });

  it("keeps a message retry head out of the pending queue while a provider slot is busy", async () => {
    vi.useFakeTimers();
    const recovered = handler({
      resume: vi
        .fn()
        .mockResolvedValue({ sessionId: "resumed-once", route: { kind: "owned" as const, mode: "queued" as const } }),
    });
    const sm = makeRuntime({ handlers: [recovered], concurrency: 1 });
    const i = internals(sm);
    const chatId = "chat-retry-slot-message";
    const head = makeMessage(chatId);
    const retrying = makeSessionRecord(chatId, {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "previous-session",
      retryHeadMessage: head,
      lastRetryReason: "network_error",
    });
    const blocker = makeSessionRecord("chat-retry-slot-blocker", { status: "active" });
    bindSeededSession(i, retrying);
    bindSeededSession(i, blocker);
    i.slotScheduler.activeCount = 1;

    const blockerEntry = mockEntry({ id: 901, chatId: blocker.chatId, messageId: "msg-slot-blocker" });
    const blockerMessage = messageFromEntry(blockerEntry);
    i.inboxDelivery.receive(blockerEntry);
    i.inboxDelivery.markOwned({ chatId: blocker.chatId, entryId: blockerEntry.id, messageId: blockerMessage.id });
    i.inboxDelivery.markProcessingStarted(blocker.chatId, blockerMessage);

    await i.slotScheduler.runRetry(chatId);

    expect(recovered.resume).not.toHaveBeenCalled();
    expect(i.slotScheduler.pendingQueue.some((queued) => queued.chatId === chatId)).toBe(false);
    expect(internals(sm).slotScheduler.hasArmedRetryTimer(retrying)).toBe(true);

    blocker.status = "suspended";
    i.slotScheduler.activeCount = 0;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(recovered.resume).toHaveBeenCalledTimes(1);
    expect(recovered.resume).toHaveBeenCalledWith(head, "previous-session", expect.anything(), expect.anything());
    expect(recovered.inject).not.toHaveBeenCalled();
    expect(internals(sm).slotScheduler.currentRetryAttempt(retrying)).toBe(0);
    expect(internals(sm).slotScheduler.hasArmedRetryTimer(retrying)).toBe(false);

    await sm.shutdown();
  });

  it("keeps a control resume retry out of the pending queue while a provider slot is busy", async () => {
    vi.useFakeTimers();
    const recovered = handler({
      resume: vi.fn().mockResolvedValue({
        sessionId: "control-resumed-once",
        route: { kind: "owned" as const, mode: "queued" as const },
      }),
    });
    const sm = makeRuntime({ handlers: [recovered], concurrency: 1 });
    const i = internals(sm);
    const chatId = "chat-retry-slot-control";
    const retrying = makeSessionRecord(chatId, {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "previous-control-session",
      retryHeadMessage: null,
      lastRetryReason: "network_error",
    });
    const blocker = makeSessionRecord("chat-control-slot-blocker", { status: "active" });
    bindSeededSession(i, retrying);
    bindSeededSession(i, blocker);
    i.slotScheduler.activeCount = 1;

    const blockerEntry = mockEntry({ id: 902, chatId: blocker.chatId, messageId: "msg-control-blocker" });
    const blockerMessage = messageFromEntry(blockerEntry);
    i.inboxDelivery.receive(blockerEntry);
    i.inboxDelivery.markOwned({ chatId: blocker.chatId, entryId: blockerEntry.id, messageId: blockerMessage.id });
    i.inboxDelivery.markProcessingStarted(blocker.chatId, blockerMessage);

    await i.slotScheduler.runRetry(chatId);

    expect(recovered.resume).not.toHaveBeenCalled();
    expect(i.slotScheduler.pendingQueue.some((queued) => queued.chatId === chatId)).toBe(false);
    expect(internals(sm).slotScheduler.hasArmedRetryTimer(retrying)).toBe(true);

    blocker.status = "suspended";
    i.slotScheduler.activeCount = 0;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(recovered.resume).toHaveBeenCalledTimes(1);
    expect(recovered.resume).toHaveBeenCalledWith(undefined, "previous-control-session", expect.anything());
    expect(internals(sm).slotScheduler.currentRetryAttempt(retrying)).toBe(0);
    expect(internals(sm).slotScheduler.hasArmedRetryTimer(retrying)).toBe(false);

    await sm.shutdown();
  });

  it("recovers a retry head whose inbox custody is missing before creating a handler", async () => {
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const blockedHandler = handler();
    const factory = vi.fn<HandlerFactory>(() => blockedHandler);
    const events: SessionEvent[] = [];
    const sm = makeRuntime({
      handlerFactory: factory,
      recoverChat,
      onSessionEvent: (_chatId, event) => events.push(event),
    });
    const chatId = "chat-retry-missing-custody";
    const retrying = makeSessionRecord(chatId, {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "previous-session",
      retryHeadMessage: {
        ...makeMessage(chatId),
        id: "settled-message",
        inboxEntryId: 404,
      },
      lastRetryReason: "network_error",
    });
    bindSeededSession(internals(sm), retrying);

    await internals(sm).slotScheduler.runRetry(chatId);

    expect(factory).not.toHaveBeenCalled();
    expect(blockedHandler.start).not.toHaveBeenCalled();
    expect(blockedHandler.resume).not.toHaveBeenCalled();
    expect(recoverChat).toHaveBeenCalledWith(chatId);
    expect(internals(sm).projection.sessions.has(chatId)).toBe(false);
    expect(
      events.some(
        (event) =>
          event.kind === "error" &&
          parseProviderRetryEventMessage(event.payload.message)?.event === "provider_retry_succeeded",
      ),
    ).toBe(false);

    await sm.shutdown();
  });

  it.each([
    "normal",
    "evicted",
    "retry",
  ] as const)("fails closed when a messageful %s resume omits its route receipt", async (resumeKind) => {
    const nullRouteHandler = handler({
      resume: vi.fn().mockResolvedValue({ sessionId: "unowned-session", route: null }),
    });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const retryEvents: string[] = [];
    const sm = makeRuntime({
      handlers: [nullRouteHandler],
      recoverChat,
      onSessionEvent: (_chatId, event) => {
        const parsed = event.kind === "error" ? parseProviderRetryEventMessage(event.payload.message) : null;
        if (parsed) retryEvents.push(parsed.event);
      },
    });
    const i = internals(sm);
    const chatId = `chat-null-resume-route-${resumeKind}`;
    const headEntry = mockEntry({ id: 2, chatId, messageId: `msg-null-route-head-${resumeKind}` });
    const head = messageFromEntry(headEntry);

    if (resumeKind === "normal") {
      bindSeededSession(
        i,
        makeSessionRecord(chatId, {
          handler: nullRouteHandler,
          status: "suspended",
          claudeSessionId: "previous-normal-session",
        }),
      );
      await sm.dispatch(headEntry);
    } else if (resumeKind === "evicted") {
      i.projection.evictedMappings.set(chatId, { claudeSessionId: "previous-evicted-session", lastActivity: 1 });
      i.inboxDelivery.receive(headEntry);
      await i.startNewSession(chatId, head, "recovery");
    } else {
      const tailEntry = mockEntry({ id: 3, chatId, messageId: "msg-null-route-tail-retry" });
      const tail = messageFromEntry(tailEntry);
      i.inboxDelivery.receive(headEntry);
      i.inboxDelivery.receive(tailEntry);
      bindSeededSession(
        i,
        makeSessionRecord(chatId, {
          retryAttempt: 1,
          retryHeadMessage: head,
          deferredMessages: [tail],
          lastRetryReason: "network_error",
          status: "suspended",
          claudeSessionId: "previous-retry-session",
        }),
      );
      await i.slotScheduler.runRetry(chatId);
      expect(nullRouteHandler.inject).not.toHaveBeenCalled();
    }

    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith(chatId));
    expect(nullRouteHandler.resume).toHaveBeenCalledTimes(1);
    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(i.inboxDelivery.hasUnsettledWork(chatId)).toBe(false);
    expect(sm.activeCount).toBe(0);
    expect(retryEvents).not.toContain("provider_retry_succeeded");

    await sm.shutdown();
  });

  it("recovers an unconsumed queued tail after a retry head fails terminally", async () => {
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const terminal = handler({
      resume: vi.fn().mockRejectedValue({ name: "ClientUserMismatchError", message: "runtime authorization changed" }),
    });
    const sm = makeRuntime({
      handlers: [terminal],
      ackEntry,
      recoverChat,
      confirmSessionEvent: vi.fn().mockResolvedValue(undefined),
    });
    const i = internals(sm);
    const chatId = "chat-retry-terminal-tail";
    const headEntry = mockEntry({ id: 2, chatId, messageId: "msg-terminal-head" });
    const tailEntry = mockEntry({ id: 3, chatId, messageId: "msg-terminal-tail" });
    const head = messageFromEntry(headEntry);
    const tail = messageFromEntry(tailEntry);
    i.inboxDelivery.receive(headEntry);
    i.inboxDelivery.receive(tailEntry);
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        retryAttempt: 1,
        status: "suspended",
        claudeSessionId: "previous-session",
        retryHeadMessage: head,
        deferredMessages: [tail],
      }),
    );

    await i.slotScheduler.runRetry(chatId);

    expect(ackEntry).toHaveBeenCalledWith(2);
    expect(recoverChat).toHaveBeenCalledWith(chatId);
    expect(i.inboxDelivery.hasEntry({ chatId, entryId: tailEntry.id, messageId: tail.id })).toBe(false);
    expect(i.inboxDelivery.hasUnsettledWork(chatId)).toBe(false);
    expect(i.projection.sessions.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("fences a late resume success after operator suspend and uses a fresh handler for redelivery", async () => {
    let signalResumeStarted: (() => void) | undefined;
    let resolveResume: (() => void) | undefined;
    const resumeStarted = new Promise<void>((resolve) => {
      signalResumeStarted = resolve;
    });
    const pendingResume = new Promise<void>((resolve) => {
      resolveResume = resolve;
    });
    let staleCtx: SessionContext | undefined;
    let staleHead: SessionMessage | undefined;
    const existingHandler = handler({
      resume: vi.fn().mockImplementation(async (message, _sessionId, ctx, token) => {
        staleCtx = ctx;
        staleHead = message;
        signalResumeStarted?.();
        await pendingResume;
        ctx.replaceSessionId("stale-session", "late success");
        if (message) {
          token?.processingStarted(message);
          await token?.complete(message, { status: "success", terminal: true });
          await ctx.finishTurn(message, { status: "success", terminal: true });
        }
        return { sessionId: "stale-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
    });
    let freshCtx: SessionContext | undefined;
    let freshHead: SessionMessage | undefined;
    const freshHandler = handler({
      resume: vi.fn().mockImplementation(async (message, _sessionId, ctx) => {
        freshCtx = ctx;
        freshHead = message;
        return { sessionId: "fresh-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
    });
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({
      handlers: [freshHandler],
      ackEntry,
      recoverChat,
    });
    const i = internals(sm);
    const chatId = "chat-suspend-late-success-resume";
    const headEntry = mockEntry({ id: 2, chatId, messageId: "msg-late-success-head" });
    const tailEntry = mockEntry({ id: 3, chatId, messageId: "msg-late-success-tail" });
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: existingHandler,
        status: "suspended",
        claudeSessionId: "previous-session",
      }),
    );
    const blocker = makeSessionRecord("chat-suspend-race-blocker", { status: "active" });
    bindSeededSession(i, blocker);
    i.slotScheduler.activeCount = 1;

    const headDispatch = sm.dispatch(headEntry);
    await resumeStarted;
    expect(sm.activeCount).toBe(2);
    await sm.dispatch(tailEntry);
    expect(i.slotScheduler.deferredMessageSnapshot(requireSession(i, chatId))).toHaveLength(1);

    await sm.handleCommand(chatId, "session:suspend");
    await vi.waitFor(() => expect(i.inboxDelivery.hasRecoveryDebt(chatId)).toBe(true));
    expect(sm.activeCount).toBe(1);

    resolveResume?.();
    await headDispatch;

    expect(staleCtx).toBeDefined();
    expect(staleHead?.id).toBe(headEntry.message.id);
    expect(existingHandler.shutdown).toHaveBeenCalledTimes(2);
    expect(existingHandler.inject).not.toHaveBeenCalled();
    expect(i.projection.sessions.get(chatId)?.status).toBe("suspended");
    expect(i.projection.sessions.get(chatId)?.claudeSessionId).toBe("previous-session");
    expect(freshHandler.resume).not.toHaveBeenCalled();
    expect(recoverChat).not.toHaveBeenCalled();
    expect(ackEntry).not.toHaveBeenCalledWith(2);
    expect(ackEntry).not.toHaveBeenCalledWith(3);
    expect(i.inboxDelivery.hasUnsettledWork(chatId)).toBe(true);
    expect(i.projection.sessions.has(blocker.chatId)).toBe(true);
    expect(sm.activeCount).toBe(1);

    await sm.handleCommand(chatId, "session:resume");
    expect(recoverChat).toHaveBeenCalledWith(chatId);
    expect(freshHandler.resume).not.toHaveBeenCalled();

    await sm.dispatch(headEntry);
    await sm.dispatch(tailEntry);

    expect(freshHandler.resume).toHaveBeenCalledTimes(1);
    expect(freshHead?.id).toBe(headEntry.message.id);
    expect(freshHandler.inject).toHaveBeenCalledTimes(1);
    expect(freshHandler.inject).toHaveBeenCalledWith(
      expect.objectContaining({ id: tailEntry.message.id }),
      expect.anything(),
    );
    expect(sm.activeCount).toBe(2);
    if (!freshCtx || !freshHead) throw new Error("fresh recovery route was not captured");
    await freshCtx.finishTurn(freshHead, { status: "success", terminal: true });
    await freshCtx.finishTurn(messageFromEntry(tailEntry), { status: "success", terminal: true });
    expect(ackEntry).toHaveBeenNthCalledWith(1, 2);
    expect(ackEntry).toHaveBeenNthCalledWith(2, 3);

    await sm.shutdown();
  });

  it("redelivers a canceled unresolved start through a fresh start instead of resume", async () => {
    let signalStartStarted: (() => void) | undefined;
    let resolveStart: (() => void) | undefined;
    const startStarted = new Promise<void>((resolve) => {
      signalStartStarted = resolve;
    });
    const pendingStart = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const oldHandler = handler({
      start: vi.fn().mockImplementation(async () => {
        signalStartStarted?.();
        await pendingStart;
        return { sessionId: "stale-start-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
    });
    let freshCtx: SessionContext | undefined;
    let freshHead: SessionMessage | undefined;
    const freshHandler = handler({
      start: vi.fn().mockImplementation(async (message, ctx) => {
        freshCtx = ctx;
        freshHead = message;
        return { sessionId: "fresh-start-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
    });
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({
      handlers: [oldHandler, freshHandler],
      ackEntry,
      recoverChat,
    });
    const i = internals(sm);
    const chatId = "chat-suspend-late-success-start";
    const headEntry = mockEntry({ id: 82, chatId, messageId: "msg-canceled-start-head" });
    const tailEntry = mockEntry({ id: 83, chatId, messageId: "msg-canceled-start-tail" });
    const blocker = makeSessionRecord("chat-canceled-start-blocker", { status: "active" });
    bindSeededSession(i, blocker);
    i.slotScheduler.activeCount = 1;

    const headDispatch = sm.dispatch(headEntry);
    await startStarted;
    await sm.dispatch(tailEntry);
    expect(i.slotScheduler.deferredMessageSnapshot(requireSession(i, chatId))).toHaveLength(1);
    expect(sm.activeCount).toBe(2);

    await sm.handleCommand(chatId, "session:suspend");
    await vi.waitFor(() => expect(i.inboxDelivery.hasRecoveryDebt(chatId)).toBe(true));
    const suspension = i.projection.sessions.get(chatId)?.suspending;
    expect(suspension).not.toBeNull();
    await suspension;

    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(sm.activeCount).toBe(1);
    expect(oldHandler.resume).not.toHaveBeenCalled();

    resolveStart?.();
    await headDispatch;
    expect(ackEntry).not.toHaveBeenCalled();

    await sm.handleCommand(chatId, "session:resume");
    expect(recoverChat).toHaveBeenCalledWith(chatId);

    await sm.dispatch(headEntry);
    await sm.dispatch(tailEntry);

    expect(freshHandler.start).toHaveBeenCalledTimes(1);
    expect(freshHandler.resume).not.toHaveBeenCalled();
    expect(freshHead?.id).toBe(headEntry.message.id);
    expect(freshHandler.inject).toHaveBeenCalledWith(
      expect.objectContaining({ id: tailEntry.message.id }),
      expect.anything(),
    );
    expect(i.projection.sessions.get(chatId)?.claudeSessionId).toBe("fresh-start-session");
    expect(sm.activeCount).toBe(2);

    if (!freshCtx || !freshHead) throw new Error("fresh replacement start route was not captured");
    await freshCtx.finishTurn(freshHead, { status: "success", terminal: true });
    await freshCtx.finishTurn(messageFromEntry(tailEntry), { status: "success", terminal: true });
    expect(ackEntry).toHaveBeenNthCalledWith(1, headEntry.id);
    expect(ackEntry).toHaveBeenNthCalledWith(2, tailEntry.id);

    await sm.shutdown();
  });

  it("keeps canceled fresh-start admission fenced while operator suspend ACK is pending", async () => {
    let signalStartStarted: (() => void) | undefined;
    let resolveStart: (() => void) | undefined;
    const startStarted = new Promise<void>((resolve) => {
      signalStartStarted = resolve;
    });
    const startGate = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    let signalAckStarted: (() => void) | undefined;
    let resolveAck: (() => void) | undefined;
    const ackStarted = new Promise<void>((resolve) => {
      signalAckStarted = resolve;
    });
    const ackGate = new Promise<void>((resolve) => {
      resolveAck = resolve;
    });
    const oldHandler = handler({
      start: vi.fn().mockImplementation(async (message, _ctx, token) => {
        token.processingStarted(message);
        signalStartStarted?.();
        await startGate;
        return { sessionId: "stale-start-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
    });
    const replacement = handler({
      start: vi.fn().mockResolvedValue({
        sessionId: "replacement-tail-session",
        route: { kind: "owned" as const, mode: "queued" as const },
      }),
    });
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockImplementation(async () => {
      signalAckStarted?.();
      await ackGate;
    });
    const sm = makeRuntime({
      handlers: [oldHandler, replacement],
      ackEntry,
    });
    const i = internals(sm);
    const chatId = "chat-canceled-start-pending-operator-ack";
    const headEntry = mockEntry({ id: 85, chatId, messageId: "msg-canceled-start-processing-head" });
    const tailEntry = mockEntry({ id: 86, chatId, messageId: "msg-canceled-start-during-ack" });
    const blocker = makeSessionRecord("chat-canceled-start-ack-blocker", { status: "active" });
    bindSeededSession(i, blocker);
    i.slotScheduler.activeCount = 1;

    const headDispatch = sm.dispatch(headEntry);
    await startStarted;
    expect(sm.activeCount).toBe(2);

    await sm.handleCommand(chatId, "session:suspend");
    await ackStarted;
    expect(i.projection.sessions.get(chatId)?.suspending).not.toBeNull();
    expect(sm.activeCount).toBe(1);

    const tailDispatch = sm.dispatch(tailEntry);
    await Promise.resolve();

    expect(replacement.start).not.toHaveBeenCalled();
    expect(replacement.resume).not.toHaveBeenCalled();
    expect(oldHandler.inject).not.toHaveBeenCalled();
    expect(i.projection.sessions.has(chatId)).toBe(true);
    expect(sm.activeCount).toBe(1);

    resolveAck?.();
    // The tail route now waits for the canceled start's producer to settle
    // (quiesce-before-route) instead of racing its late materialization.
    await Promise.resolve();
    await Promise.resolve();
    expect(replacement.start).not.toHaveBeenCalled();

    resolveStart?.();
    await tailDispatch;

    expect(i.projection.sessions.get(chatId)?.claudeSessionId).toBe("replacement-tail-session");
    expect(replacement.start).toHaveBeenCalledTimes(1);
    expect(replacement.start).toHaveBeenCalledWith(
      expect.objectContaining({ id: tailEntry.message.id }),
      expect.anything(),
      expect.anything(),
    );
    expect(replacement.resume).not.toHaveBeenCalled();
    expect(sm.activeCount).toBe(2);

    resolveStart?.();
    await headDispatch;
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(headEntry.id);

    await sm.shutdown();
  });

  it("does not create an empty resume mapping when LRU evicts a fresh-start retry window", async () => {
    const replacement = handler({
      start: vi.fn().mockResolvedValue({
        sessionId: "replacement-after-lru",
        route: { kind: "owned" as const, mode: "queued" as const },
      }),
    });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({
      handlers: [replacement],
      recoverChat,
      maxSessions: 1,
    });
    const i = internals(sm);
    const chatId = "chat-lru-fresh-start-retry";
    const headEntry = mockEntry({ id: 84, chatId, messageId: "msg-lru-fresh-start-retry" });
    const head = messageFromEntry(headEntry);
    i.inboxDelivery.receive(headEntry);
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        status: "suspended",
        claudeSessionId: "",
        retryAttempt: 1,
        retryHeadMessage: head,
        routeTransition: null,
      }),
    );

    i.slotScheduler.evictIfNeeded();
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith(chatId));

    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(i.projection.evictedMappings.has(chatId)).toBe(false);

    await sm.dispatch(headEntry);

    expect(replacement.start).toHaveBeenCalledTimes(1);
    expect(replacement.resume).not.toHaveBeenCalled();
    expect(i.projection.sessions.get(chatId)?.claudeSessionId).toBe("replacement-after-lru");

    await sm.shutdown();
  });

  it("fences active inject tokens across suspend recovery and same-entry redelivery", async () => {
    let initialCtx: SessionContext | undefined;
    let initialHead: SessionMessage | undefined;
    let staleToken: Parameters<AgentHandler["inject"]>[1] | undefined;
    let signalWinningResumeStarted: (() => void) | undefined;
    let resolveWinningResume: (() => void) | undefined;
    const winningResumeStarted = new Promise<void>((resolve) => {
      signalWinningResumeStarted = resolve;
    });
    const winningResumeGate = new Promise<void>((resolve) => {
      resolveWinningResume = resolve;
    });
    let winningCtx: SessionContext | undefined;
    let winningHead: SessionMessage | undefined;
    const establishedHandler = handler({
      start: vi.fn().mockImplementation(async (message, ctx) => {
        initialCtx = ctx;
        initialHead = message;
        return { sessionId: "established-token-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
      inject: vi.fn().mockImplementation((_message, token) => {
        staleToken = token;
        return { kind: "owned", mode: "queued" } as const;
      }),
      resume: vi.fn().mockImplementation(async (message, _sessionId, ctx) => {
        winningCtx = ctx;
        winningHead = message;
        signalWinningResumeStarted?.();
        await winningResumeGate;
        return { sessionId: "winning-token-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
    });
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({ handlers: [establishedHandler], ackEntry, recoverChat });
    const i = internals(sm);
    const chatId = "chat-active-token-fence";
    const firstEntry = mockEntry({ id: 1, chatId, messageId: "msg-token-first" });
    const redeliveredEntry = mockEntry({ id: 2, chatId, messageId: "msg-token-redelivered" });

    await sm.dispatch(firstEntry);
    if (!initialCtx || !initialHead) throw new Error("initial active route was not captured");
    await initialCtx.finishTurn(initialHead, { status: "success", terminal: true });
    await sm.dispatch(redeliveredEntry);
    expect(staleToken).toBeDefined();

    await sm.handleCommand(chatId, "session:suspend");
    await vi.waitFor(() => expect(i.inboxDelivery.hasRecoveryDebt(chatId)).toBe(true));
    await sm.handleCommand(chatId, "session:resume");
    expect(recoverChat).toHaveBeenCalledTimes(1);

    const winningDispatch = sm.dispatch(redeliveredEntry);
    await winningResumeStarted;
    expect(i.inboxDelivery.snapshot(chatId)).toMatchObject({
      entries: [{ entryId: 2, messageId: redeliveredEntry.message.id, phase: "open" }],
      recoveryDebt: "none",
    });

    const redeliveredMessage = messageFromEntry(redeliveredEntry);
    staleToken?.processingStarted(redeliveredMessage);
    await staleToken?.complete(redeliveredMessage, { status: "success", terminal: true });
    staleToken?.retry(redeliveredMessage, "stale route retry");
    await staleToken?.terminalRejected(redeliveredMessage, "stale route terminal", {
      kind: "server_terminal_record",
      recordId: "stale-record",
    });

    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(recoverChat).toHaveBeenCalledTimes(1);
    expect(i.inboxDelivery.snapshot(chatId)).toMatchObject({
      entries: [{ entryId: 2, messageId: redeliveredEntry.message.id, phase: "open" }],
      recoveryDebt: "none",
    });

    resolveWinningResume?.();
    await winningDispatch;
    if (!winningCtx || !winningHead) throw new Error("winning active route was not captured");
    await winningCtx.finishTurn(winningHead, { status: "success", terminal: true });

    expect(establishedHandler.resume).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenNthCalledWith(1, 1);
    expect(ackEntry).toHaveBeenNthCalledWith(2, 2);
    expect(i.inboxDelivery.hasUnsettledWork(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("operator suspend does not sweep an unentered queued active-inject tail into the resolved prefix", async () => {
    let initialCtx: SessionContext | undefined;
    let initialHead: SessionMessage | undefined;
    let enteredToken: Parameters<AgentHandler["inject"]>[1] | undefined;
    let enteredMessage: SessionMessage | undefined;
    let injectCount = 0;
    const sendMessage = vi.fn().mockResolvedValue({ id: "runtime-notice-inject-tail" });
    const activeHandler = handler({
      start: vi.fn().mockImplementation(async (message, ctx) => {
        initialCtx = ctx;
        initialHead = message;
        return { sessionId: "active-inject-tail-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
      inject: vi.fn().mockImplementation((message, token) => {
        injectCount++;
        if (injectCount === 1) {
          enteredToken = token;
          enteredMessage = message;
          token?.processingStarted([message]);
          return { kind: "owned", mode: "processing" } as const;
        }
        // Unentered queued-mode tail: owned locally but not provider-entered.
        return { kind: "owned", mode: "queued" } as const;
      }),
      suspend: vi.fn().mockImplementation(async (_reason, opts) => {
        if (opts?.settleProviderEntered === true && enteredToken && enteredMessage && initialCtx) {
          // Capture notice while the inject settlement lease is still open, then
          // complete the entered prefix. The queued tail must stay recovery debt.
          initialCtx.emitEvent({
            kind: "error",
            payload: {
              source: "runtime",
              message: encodeProviderRetryEventMessage({
                event: "provider_failure_terminal",
                provider: "pi",
                scope: "provider_turn",
                category: "unknown",
                reasonCode: "unsafe_replay",
                replaySafety: "unsafe",
                userSeverity: "error",
                messagePreview: "active inject suspend settle",
              }),
            },
          });
          await enteredToken.complete([enteredMessage], {
            status: "error",
            completion: "consumed",
            reason: "unsafe_replay",
          });
        }
      }),
    });
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const sdk = mockSdk();
    vi.mocked(sdk.sendMessage).mockImplementation(sendMessage);
    const sm = makeRuntime({
      handlers: [activeHandler],
      ackEntry,
      sdk,
    });
    const i = internals(sm);
    const chatId = "chat-active-inject-queued-tail";

    await sm.dispatch(mockEntry({ id: 1, chatId, messageId: "msg-tail-establish" }));
    if (!initialCtx || !initialHead) throw new Error("initial route was not captured");
    await initialCtx.finishTurn(initialHead, { status: "success", terminal: true });

    await sm.dispatch(mockEntry({ id: 2, chatId, messageId: "msg-tail-entered" }));
    await sm.dispatch(mockEntry({ id: 3, chatId, messageId: "msg-tail-queued" }));
    expect(injectCount).toBe(2);

    // Prove the inject DeliveryToken can settle with notice+ACK (split lease).
    if (!enteredToken || !enteredMessage || !initialCtx) throw new Error("entered inject was not captured");
    initialCtx.emitEvent({
      kind: "error",
      payload: {
        source: "runtime",
        message: encodeProviderRetryEventMessage({
          event: "provider_failure_terminal",
          provider: "pi",
          scope: "provider_turn",
          category: "unknown",
          reasonCode: "unsafe_replay",
          replaySafety: "unsafe",
          userSeverity: "error",
          messagePreview: "entered inject consumed",
        }),
      },
    });
    const disposition = await enteredToken.complete([enteredMessage], {
      status: "error",
      completion: "consumed",
      reason: "unsafe_replay",
    });
    expect(disposition).toBe("settled");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(ackEntry.mock.calls.filter((call) => call[0] === 2)).toHaveLength(1);

    await sm.handleCommand(chatId, "session:suspend");
    const suspending = i.projection.sessions.get(chatId)?.suspending;
    await suspending;

    // Queued tail must not be force-resolved by prepareOperatorSuspend.
    expect(ackEntry.mock.calls.filter((call) => call[0] === 3)).toHaveLength(0);
    expect(i.inboxDelivery.hasRecoveryDebt(chatId)).toBe(true);
    expect(i.inboxDelivery.snapshot(chatId).entries.some((entry) => entry.entryId === 3)).toBe(true);

    await sm.shutdown();
  });

  it.each([
    "rejected",
    "throw",
  ] as const)("revokes a failed active inject token before %s recovery and same-entry redelivery", async (failureMode) => {
    let initialCtx: SessionContext | undefined;
    let initialHead: SessionMessage | undefined;
    let staleToken: Parameters<AgentHandler["inject"]>[1] | undefined;
    let winningToken: Parameters<AgentHandler["inject"]>[1] | undefined;
    let injectCount = 0;
    const activeHandler = handler({
      start: vi.fn().mockImplementation(async (message, ctx) => {
        initialCtx = ctx;
        initialHead = message;
        return { sessionId: "active-attempt-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
      inject: vi.fn().mockImplementation((_message, token) => {
        injectCount++;
        if (injectCount === 1) {
          staleToken = token;
          if (failureMode === "throw") throw new Error("inject failed after capturing token");
          return { kind: "rejected", reason: "inject_failed", retryable: true } as const;
        }
        winningToken = token;
        return { kind: "owned", mode: "queued" } as const;
      }),
    });
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({ handlers: [activeHandler], ackEntry, recoverChat });
    const i = internals(sm);
    const chatId = `chat-active-attempt-${failureMode}`;
    const firstEntry = mockEntry({ id: 1, chatId, messageId: `msg-attempt-first-${failureMode}` });
    const redeliveredEntry = mockEntry({ id: 2, chatId, messageId: `msg-attempt-redelivery-${failureMode}` });

    await sm.dispatch(firstEntry);
    if (!initialCtx || !initialHead) throw new Error("initial route was not captured");
    await initialCtx.finishTurn(initialHead, { status: "success", terminal: true });

    const failedDispatch = sm.dispatch(redeliveredEntry);
    if (failureMode === "throw") {
      await expect(failedDispatch).rejects.toThrow("inject failed after capturing token");
    } else {
      await failedDispatch;
    }
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledTimes(1));
    expect(staleToken).toBeDefined();

    await sm.dispatch(redeliveredEntry);
    expect(winningToken).toBeDefined();
    expect(i.inboxDelivery.snapshot(chatId)).toMatchObject({
      entries: [{ entryId: 2, messageId: redeliveredEntry.message.id, phase: "owned" }],
      recoveryDebt: "none",
    });

    const redeliveredMessage = messageFromEntry(redeliveredEntry);
    staleToken?.processingStarted(redeliveredMessage);
    await staleToken?.complete(redeliveredMessage, { status: "success", terminal: true });
    staleToken?.retry(redeliveredMessage, "stale attempt retry");
    await staleToken?.terminalRejected(redeliveredMessage, "stale attempt terminal", {
      kind: "server_terminal_record",
      recordId: "stale-attempt-record",
    });

    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(recoverChat).toHaveBeenCalledTimes(1);
    expect(i.inboxDelivery.snapshot(chatId)).toMatchObject({
      entries: [{ entryId: 2, messageId: redeliveredEntry.message.id, phase: "owned" }],
      recoveryDebt: "none",
    });

    await winningToken?.complete(redeliveredMessage, { status: "success", terminal: true });
    expect(ackEntry).toHaveBeenNthCalledWith(1, 1);
    expect(ackEntry).toHaveBeenNthCalledWith(2, 2);
    expect(i.inboxDelivery.hasUnsettledWork(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("does not capture a stale confirmed event into a recovered route", async () => {
    let oldCtx: SessionContext | undefined;
    let signalConfirmStarted: (() => void) | undefined;
    let resolveConfirm: (() => void) | undefined;
    const confirmStarted = new Promise<void>((resolve) => {
      signalConfirmStarted = resolve;
    });
    const confirmGate = new Promise<void>((resolve) => {
      resolveConfirm = resolve;
    });
    const routedHandler = handler({
      start: vi.fn().mockImplementation(async (_message, ctx) => {
        oldCtx = ctx;
        return { sessionId: "confirmed-event-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
      resume: vi.fn().mockResolvedValue({
        sessionId: "confirmed-event-recovered-session",
        route: { kind: "owned" as const, mode: "queued" as const },
      }),
    });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({
      handlers: [routedHandler],
      recoverChat,
      confirmSessionEvent: vi.fn().mockImplementation(async () => {
        signalConfirmStarted?.();
        await confirmGate;
      }),
    });
    const i = internals(sm);
    const chatId = "chat-stale-confirmed-event";
    const entry = mockEntry({ id: 80, chatId, messageId: "msg-stale-confirmed-event" });
    const stalePayload: ProviderRetryEventPayload = {
      event: "provider_failure_terminal",
      provider: "claude-code",
      scope: "provider_turn",
      category: "credential",
      reasonCode: "stale_provider_failure",
      replaySafety: "provider_entered",
      userSeverity: "error",
      messagePreview: "stale failure",
    };
    const winningPayload: ProviderRetryEventPayload = {
      ...stalePayload,
      reasonCode: "winning_provider_failure",
      messagePreview: "winning failure",
    };

    await sm.dispatch(entry);
    if (!oldCtx?.emitEventConfirmed) throw new Error("old confirmed event context was not captured");
    const staleConfirmation = oldCtx.emitEventConfirmed({
      kind: "error",
      payload: { source: "runtime", message: encodeProviderRetryEventMessage(stalePayload) },
    });
    await confirmStarted;

    await sm.handleCommand(chatId, "session:suspend");
    await sm.handleCommand(chatId, "session:resume");
    expect(recoverChat).toHaveBeenCalledWith(chatId);
    await sm.dispatch(entry);

    const winningEntry = i.projection.sessions.get(chatId);
    if (!winningEntry) throw new Error("winning route was not established");
    winningEntry.pendingRuntimeFailureNotice = winningPayload;

    resolveConfirm?.();
    await expect(staleConfirmation).rejects.toThrow("route transition invalidated");

    expect(winningEntry.pendingRuntimeFailureNotice).toBe(winningPayload);
    expect(i.inboxDelivery.snapshot(chatId)).toMatchObject({
      entries: [{ entryId: entry.id, messageId: entry.message.id, phase: "owned" }],
      recoveryDebt: "none",
    });

    await sm.shutdown();
  });

  it("does not let a stale notice post clear or settle a recovered delivery", async () => {
    let oldToken: Parameters<AgentHandler["start"]>[2] | undefined;
    let winningToken: Parameters<AgentHandler["resume"]>[3] | undefined;
    let signalNoticeStarted: (() => void) | undefined;
    let resolveNotice: (() => void) | undefined;
    const noticeStarted = new Promise<void>((resolve) => {
      signalNoticeStarted = resolve;
    });
    const noticeGate = new Promise<void>((resolve) => {
      resolveNotice = resolve;
    });
    const routedHandler = handler({
      start: vi.fn().mockImplementation(async (_message, _ctx, token) => {
        oldToken = token;
        return { sessionId: "notice-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
      resume: vi.fn().mockImplementation(async (_message, _sessionId, _ctx, token) => {
        winningToken = token;
        return { sessionId: "notice-recovered-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
    });
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockImplementation(async () => {
      signalNoticeStarted?.();
      await noticeGate;
      return { id: "runtime-notice-message" };
    });
    const sm = makeRuntime({
      handlers: [routedHandler],
      ackEntry,
      recoverChat,
      sdk: { ...mockSdk(), sendMessage } as unknown as FirstTreeHubSDK,
    });
    const i = internals(sm);
    const chatId = "chat-stale-notice-post";
    const entry = mockEntry({ id: 81, chatId, messageId: "msg-stale-notice-post" });
    const message = messageFromEntry(entry);
    const stalePayload: ProviderRetryEventPayload = {
      event: "provider_failure_terminal",
      provider: "claude-code",
      scope: "provider_turn",
      category: "credential",
      reasonCode: "stale_notice",
      replaySafety: "provider_entered",
      userSeverity: "error",
      messagePreview: "stale notice",
    };
    const winningPayload: ProviderRetryEventPayload = {
      ...stalePayload,
      reasonCode: "winning_notice",
      messagePreview: "winning notice",
    };

    await sm.dispatch(entry);
    const oldEntry = i.projection.sessions.get(chatId);
    if (!oldEntry || !oldToken) throw new Error("old notice route was not captured");
    oldEntry.pendingRuntimeFailureNotice = stalePayload;
    const staleCompletion = oldToken.complete(message, {
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "stale provider failure",
    });
    await noticeStarted;

    await sm.handleCommand(chatId, "session:suspend");
    await sm.handleCommand(chatId, "session:resume");
    expect(recoverChat).toHaveBeenCalledWith(chatId);
    await sm.dispatch(entry);

    const winningEntry = i.projection.sessions.get(chatId);
    if (!winningEntry || !winningToken) throw new Error("winning notice route was not captured");
    winningEntry.pendingRuntimeFailureNotice = winningPayload;
    resolveNotice?.();
    await staleCompletion;

    expect(winningEntry.pendingRuntimeFailureNotice).toBe(winningPayload);
    expect(ackEntry).not.toHaveBeenCalled();
    expect(i.inboxDelivery.snapshot(chatId)).toMatchObject({
      entries: [{ entryId: entry.id, messageId: entry.message.id, phase: "owned" }],
      recoveryDebt: "none",
    });

    await winningToken.complete(message, { status: "success", terminal: true });
    expect(ackEntry).toHaveBeenCalledWith(entry.id);
    expect(i.inboxDelivery.hasUnsettledWork(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("runs post-settlement cleanup when a canceled resume materializes resources late", async () => {
    let signalResumeStarted: (() => void) | undefined;
    let resolveResume: (() => void) | undefined;
    const resumeStarted = new Promise<void>((resolve) => {
      signalResumeStarted = resolve;
    });
    const resumeGate = new Promise<void>((resolve) => {
      resolveResume = resolve;
    });
    let providerMaterialized = false;
    let providerClosed = false;
    const lateHandler = handler({
      resume: vi.fn().mockImplementation(async () => {
        signalResumeStarted?.();
        await resumeGate;
        providerMaterialized = true;
        providerClosed = false;
        return { sessionId: "late-materialized-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
      shutdown: vi.fn().mockImplementation(async () => {
        if (providerMaterialized) providerClosed = true;
      }),
    });
    const sm = makeRuntime({ recoverChat: vi.fn().mockResolvedValue(undefined) });
    const i = internals(sm);
    const chatId = "chat-late-materialized-cleanup";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: lateHandler,
        status: "suspended",
        claudeSessionId: "previous-materialized-session",
      }),
    );

    const dispatch = sm.dispatch(mockEntry({ id: 50, chatId, messageId: "msg-late-materialized" }));
    await resumeStarted;
    await sm.handleCommand(chatId, "session:suspend");
    await vi.waitFor(() => expect(lateHandler.shutdown).toHaveBeenCalledTimes(1));
    expect(providerMaterialized).toBe(false);
    expect(providerClosed).toBe(false);

    resolveResume?.();
    await dispatch;
    await vi.waitFor(() => expect(lateHandler.shutdown).toHaveBeenCalledTimes(2));

    expect(providerMaterialized).toBe(true);
    expect(providerClosed).toBe(true);
    expect(i.projection.sessions.get(chatId)?.status).toBe("suspended");
    expect(sm.activeCount).toBe(0);

    await sm.shutdown();
  });

  it("lets recovery replace a preempted pending resume before the old handler succeeds", async () => {
    let signalOldResumeStarted: (() => void) | undefined;
    let resolveOldResume: (() => void) | undefined;
    const oldResumeStarted = new Promise<void>((resolve) => {
      signalOldResumeStarted = resolve;
    });
    const oldResumeGate = new Promise<void>((resolve) => {
      resolveOldResume = resolve;
    });
    const oldHandler = handler({
      resume: vi.fn().mockImplementation(async () => {
        signalOldResumeStarted?.();
        await oldResumeGate;
        return { sessionId: "stale-preempted-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
    });

    const requesterHandler = handler({
      start: vi.fn().mockResolvedValue({
        sessionId: "requester-session",
        route: { kind: "owned" as const, mode: "queued" as const },
      }),
    });
    let signalFreshResumeStarted: (() => void) | undefined;
    let resolveFreshResume: (() => void) | undefined;
    const freshResumeStarted = new Promise<void>((resolve) => {
      signalFreshResumeStarted = resolve;
    });
    const freshResumeGate = new Promise<void>((resolve) => {
      resolveFreshResume = resolve;
    });
    let freshCtx: SessionContext | undefined;
    let freshHead: SessionMessage | undefined;
    const freshHandler = handler({
      resume: vi.fn().mockImplementation(async (message, _sessionId, ctx) => {
        freshCtx = ctx;
        freshHead = message;
        signalFreshResumeStarted?.();
        await freshResumeGate;
        return { sessionId: "fresh-preemption-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
    });
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({
      handlers: [requesterHandler, freshHandler],
      ackEntry,
      recoverChat,
      concurrency: 2,
    });
    const i = internals(sm);
    const chatId = "chat-preempted-late-success";
    const headEntry = mockEntry({ id: 20, chatId, messageId: "msg-preempted-head" });
    const tailEntry = mockEntry({ id: 21, chatId, messageId: "msg-preempted-tail" });
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: oldHandler,
        status: "suspended",
        claudeSessionId: "previous-preemption-session",
      }),
    );
    const blocker = makeSessionRecord("chat-preemption-blocker", {
      status: "active",
      lastActivity: Date.now() + 10_000,
    });
    bindSeededSession(i, blocker);
    i.slotScheduler.activeCount = 1;

    const headDispatch = sm.dispatch(headEntry);
    await oldResumeStarted;
    await sm.dispatch(tailEntry);
    expect(sm.activeCount).toBe(2);

    await sm.dispatch(mockEntry({ id: 30, chatId: "chat-preemption-requester", messageId: "msg-requester" }));
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith(chatId));
    expect(oldHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(requesterHandler.start).toHaveBeenCalledTimes(1);
    expect(sm.activeCount).toBe(2);

    const recoveredHeadDispatch = sm.dispatch(headEntry);
    // The fresh route now waits for the preempted (canceled) old producer
    // to settle instead of racing its late materialization.
    await Promise.resolve();
    await Promise.resolve();
    expect(freshHandler.resume).not.toHaveBeenCalled();

    resolveOldResume?.();
    await headDispatch;
    expect(i.projection.sessions.get(chatId)?.claudeSessionId).toBe("previous-preemption-session");
    expect(oldHandler.inject).not.toHaveBeenCalled();

    await freshResumeStarted;
    await sm.dispatch(tailEntry);
    expect(i.slotScheduler.deferredMessageSnapshot(requireSession(i, chatId))).toHaveLength(1);
    expect(requesterHandler.suspend).toHaveBeenCalledTimes(1);

    resolveFreshResume?.();
    await recoveredHeadDispatch;
    await vi.waitFor(() => expect(freshHandler.inject).toHaveBeenCalledTimes(1));

    expect(freshHandler.resume).toHaveBeenCalledTimes(1);
    expect(freshHead?.id).toBe(headEntry.message.id);
    expect(freshHandler.inject).toHaveBeenCalledWith(
      expect.objectContaining({ id: tailEntry.message.id }),
      expect.anything(),
    );
    expect(i.projection.sessions.has(blocker.chatId)).toBe(true);
    expect(sm.activeCount).toBe(2);

    if (!freshCtx || !freshHead) throw new Error("fresh preemption route was not captured");
    await freshCtx.finishTurn(freshHead, { status: "success", terminal: true });
    await freshCtx.finishTurn(messageFromEntry(tailEntry), { status: "success", terminal: true });
    expect(ackEntry).toHaveBeenNthCalledWith(1, 20);
    expect(ackEntry).toHaveBeenNthCalledWith(2, 21);

    await sm.shutdown();
  });

  it("ignores a late transient resume failure after suspend without releasing the blocker slot", async () => {
    let signalResumeStarted: (() => void) | undefined;
    let rejectResume: ((reason?: unknown) => void) | undefined;
    const resumeStarted = new Promise<void>((resolve) => {
      signalResumeStarted = resolve;
    });
    const pendingResume = new Promise<string>((_resolve, reject) => {
      rejectResume = reject;
    });
    const existingHandler = handler({
      resume: vi.fn().mockImplementation(() => {
        signalResumeStarted?.();
        return pendingResume.then((sessionId) => ({
          sessionId,
          route: { kind: "owned" as const, mode: "queued" as const },
        }));
      }),
    });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({ recoverChat });
    const i = internals(sm);
    const chatId = "chat-suspend-late-transient-resume";
    const headEntry = mockEntry({ id: 2, chatId, messageId: "msg-late-transient-head" });
    const tailEntry = mockEntry({ id: 3, chatId, messageId: "msg-late-transient-tail" });
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: existingHandler,
        status: "suspended",
        claudeSessionId: "previous-session",
      }),
    );
    const blocker = makeSessionRecord("chat-transient-race-blocker", { status: "active" });
    bindSeededSession(i, blocker);
    i.slotScheduler.activeCount = 1;

    const headDispatch = sm.dispatch(headEntry);
    await resumeStarted;
    expect(sm.activeCount).toBe(2);
    await sm.dispatch(tailEntry);

    await sm.handleCommand(chatId, "session:suspend");
    await vi.waitFor(() => expect(i.inboxDelivery.hasRecoveryDebt(chatId)).toBe(true));
    expect(sm.activeCount).toBe(1);

    rejectResume?.({ status: 429, message: "provider still limited" });
    await headDispatch;

    expect(i.slotScheduler.currentRetryAttempt(requireSession(i, chatId))).toBe(0);
    expect(i.projection.sessions.get(chatId)?.status).toBe("suspended");
    expect(sm.activeCount).toBe(1);

    await sm.handleCommand(chatId, "session:resume");

    expect(recoverChat).toHaveBeenCalledWith(chatId);
    expect(i.inboxDelivery.hasUnsettledWork(chatId)).toBe(false);
    expect(i.projection.sessions.has(blocker.chatId)).toBe(true);
    expect(sm.activeCount).toBe(1);

    await sm.shutdown();
  });

  it("does not report retry success when a suspended retry handler succeeds late", async () => {
    let signalRetryStarted: (() => void) | undefined;
    let resolveRetry: (() => void) | undefined;
    const retryStarted = new Promise<void>((resolve) => {
      signalRetryStarted = resolve;
    });
    const retryGate = new Promise<void>((resolve) => {
      resolveRetry = resolve;
    });
    const retryHandler = handler({
      resume: vi.fn().mockImplementation(async () => {
        signalRetryStarted?.();
        await retryGate;
        return { sessionId: "stale-retry-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
    });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const retryEvents: string[] = [];
    const sm = makeRuntime({
      handlers: [retryHandler],
      recoverChat,
      onSessionEvent: (_chatId, event) => {
        const parsed = event.kind === "error" ? parseProviderRetryEventMessage(event.payload.message) : null;
        if (parsed) retryEvents.push(parsed.event);
      },
    });
    const i = internals(sm);
    const chatId = "chat-retry-late-success";
    const headEntry = mockEntry({ id: 40, chatId, messageId: "msg-retry-late-head" });
    const tailEntry = mockEntry({ id: 41, chatId, messageId: "msg-retry-late-tail" });
    const head = messageFromEntry(headEntry);
    i.inboxDelivery.receive(headEntry);
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        retryAttempt: 1,
        retryHeadMessage: head,
        lastRetryReason: "network_error",
        status: "suspended",
        claudeSessionId: "previous-retry-session",
      }),
    );
    const blocker = makeSessionRecord("chat-retry-late-success-blocker", { status: "active" });
    bindSeededSession(i, blocker);
    i.slotScheduler.activeCount = 1;

    const retryPromise = i.slotScheduler.runRetry(chatId);
    await retryStarted;
    expect(sm.activeCount).toBe(2);
    await sm.dispatch(tailEntry);
    expect(i.slotScheduler.deferredMessageSnapshot(requireSession(i, chatId))).toHaveLength(1);

    await sm.handleCommand(chatId, "session:suspend");
    await vi.waitFor(() => expect(i.inboxDelivery.hasRecoveryDebt(chatId)).toBe(true));
    expect(sm.activeCount).toBe(1);

    resolveRetry?.();
    await retryPromise;

    expect(retryHandler.shutdown).toHaveBeenCalledTimes(2);
    expect(retryEvents).toContain("provider_retry_started");
    expect(retryEvents).not.toContain("provider_retry_succeeded");
    expect(i.projection.sessions.get(chatId)?.claudeSessionId).toBe("previous-retry-session");
    expect(i.slotScheduler.currentRetryAttempt(requireSession(i, chatId))).toBe(0);
    expect(i.projection.sessions.get(chatId)?.status).toBe("suspended");
    expect(i.projection.sessions.has(blocker.chatId)).toBe(true);
    expect(sm.activeCount).toBe(1);

    await sm.handleCommand(chatId, "session:resume");
    expect(recoverChat).toHaveBeenCalledWith(chatId);
    expect(i.inboxDelivery.hasUnsettledWork(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("closes same-chat admission while terminate waits for a slow handler shutdown", async () => {
    let signalShutdownStarted: (() => void) | undefined;
    let resolveShutdown: (() => void) | undefined;
    const shutdownStarted = new Promise<void>((resolve) => {
      signalShutdownStarted = resolve;
    });
    const shutdownGate = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    const terminatingHandler = handler({
      shutdown: vi.fn().mockImplementation(async () => {
        signalShutdownStarted?.();
        await shutdownGate;
      }),
    });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({ recoverChat });
    const i = internals(sm);
    const chatId = "chat-terminate-admission";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: terminatingHandler,
        status: "active",
      }),
    );
    const blocker = makeSessionRecord("chat-terminate-admission-blocker", { status: "active" });
    bindSeededSession(i, blocker);
    i.slotScheduler.activeCount = 2;

    const terminate = sm.handleCommand(chatId, "session:terminate");
    await shutdownStarted;
    expect(sm.activeCount).toBe(1);

    const lateEntry = mockEntry({ id: 60, chatId, messageId: "msg-during-terminate" });
    await sm.dispatch(lateEntry);

    expect(terminatingHandler.inject).not.toHaveBeenCalled();
    expect(terminatingHandler.resume).not.toHaveBeenCalled();
    expect(sm.activeCount).toBe(1);
    // Fenced delivery parks without same-socket recoverChat while terminate drains.
    expect(recoverChat).not.toHaveBeenCalled();
    expect(i.inboxDelivery.hasRecoveryDebt(chatId)).toBe(true);

    resolveShutdown?.();
    await terminate;

    // Local success arms parked debt but must not recover until server-confirmed
    // Reset finalization (simulated here via the public release API).
    expect(recoverChat).not.toHaveBeenCalled();
    sm.releaseParkedResetFenceRecovery(chatId);
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith(chatId));
    expect(recoverChat).toHaveBeenCalledTimes(1);
    expect(i.inboxDelivery.hasUnsettledWork(chatId)).toBe(false);
    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(i.projection.sessions.has(blocker.chatId)).toBe(true);
    expect(sm.activeCount).toBe(1);

    await sm.shutdown();
  });

  it("shares one in-flight termination across concurrent same-chat terminates", async () => {
    let signalDrainStarted: (() => void) | undefined;
    let resolveDrain: (() => void) | undefined;
    const drainStarted = new Promise<void>((resolve) => {
      signalDrainStarted = resolve;
    });
    const drainGate = new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });
    const activeHandler = handler();
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-terminate-shared";
    installSession(i, chatId, { handler: activeHandler, status: "active" });
    i.slotScheduler.activeCount = 1;
    const drainForTerminate = vi.fn<(chatId: string) => Promise<void>>().mockImplementation(async () => {
      signalDrainStarted?.();
      await drainGate;
    });
    i.inboxDelivery.drainForTerminate = drainForTerminate;

    const first = sm.handleCommand(chatId, "session:terminate");
    await drainStarted;

    // A duplicate terminate joins the in-flight cleanup — it must not return
    // early while the shared work is still running.
    let secondSettled = false;
    const second = sm.handleCommand(chatId, "session:terminate").then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(drainForTerminate).toHaveBeenCalledTimes(1);
    expect(activeHandler.shutdown).toHaveBeenCalledTimes(1);

    resolveDrain?.();
    await first;
    await second;

    expect(secondSettled).toBe(true);
    expect(drainForTerminate).toHaveBeenCalledTimes(1);
    expect(activeHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("keeps suspend and resume fenced out while a same-chat terminate is in flight", async () => {
    let signalDrainStarted: (() => void) | undefined;
    let resolveDrain: (() => void) | undefined;
    const drainStarted = new Promise<void>((resolve) => {
      signalDrainStarted = resolve;
    });
    const drainGate = new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });
    const activeHandler = handler();
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-terminate-fence";
    installSession(i, chatId, { handler: activeHandler, status: "active" });
    i.slotScheduler.activeCount = 1;
    i.inboxDelivery.drainForTerminate = vi.fn<(chatId: string) => Promise<void>>().mockImplementation(async () => {
      signalDrainStarted?.();
      await drainGate;
    });

    const terminate = sm.handleCommand(chatId, "session:terminate");
    await drainStarted;

    // Suspend/resume keep the old early-return admission fence: they neither
    // join the termination promise nor touch the terminating session.
    await sm.handleCommand(chatId, "session:suspend");
    await sm.handleCommand(chatId, "session:resume");
    expect(activeHandler.suspend).not.toHaveBeenCalled();
    expect(activeHandler.resume).not.toHaveBeenCalled();

    resolveDrain?.();
    await terminate;

    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("rejects every concurrent terminate awaiter and releases the fence for a genuine retry", async () => {
    const boom = new Error("drain failed");
    let signalDrainStarted: (() => void) | undefined;
    const drainStarted = new Promise<void>((resolve) => {
      signalDrainStarted = resolve;
    });
    const activeHandler = handler();
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-terminate-retry";
    installSession(i, chatId, { handler: activeHandler, status: "active" });
    i.slotScheduler.activeCount = 1;
    const drainForTerminate = vi
      .fn<(chatId: string) => Promise<void>>()
      .mockImplementationOnce(async () => {
        signalDrainStarted?.();
        throw boom;
      })
      .mockResolvedValue(undefined);
    i.inboxDelivery.drainForTerminate = drainForTerminate;

    const first = sm.handleCommand(chatId, "session:terminate");
    await drainStarted;
    // The duplicate joins the same in-flight run — it must never resolve
    // early as if the apply had succeeded.
    const second = sm.handleCommand(chatId, "session:terminate");

    await expect(first).rejects.toBe(boom);
    await expect(second).rejects.toBe(boom);
    expect(drainForTerminate).toHaveBeenCalledTimes(1);
    // The fence is released, so a later terminate is a genuine retry instead
    // of a join of the dead run.
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    // Simulate the chat becoming known again (e.g. runtime sync re-adds the
    // evicted mapping): a fresh terminate re-executes the full cleanup.
    i.projection.evictedMappings.set(chatId, { claudeSessionId: `session-${chatId}`, lastActivity: Date.now() });
    await sm.handleCommand(chatId, "session:terminate");
    expect(drainForTerminate).toHaveBeenCalledTimes(2);
    expect(i.projection.evictedMappings.has(chatId)).toBe(false);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("joins an in-flight suspend before terminating and tears down the suspended handler", async () => {
    let signalSuspendStarted: (() => void) | undefined;
    let resolveSuspend: (() => void) | undefined;
    const suspendStarted = new Promise<void>((resolve) => {
      signalSuspendStarted = resolve;
    });
    const suspendGate = new Promise<void>((resolve) => {
      resolveSuspend = resolve;
    });
    const suspendingHandler = handler({
      suspend: vi.fn().mockImplementation(async () => {
        signalSuspendStarted?.();
        await suspendGate;
      }),
    });
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-terminate-joins-suspend";
    installSession(i, chatId, { handler: suspendingHandler, status: "active" });
    i.slotScheduler.activeCount = 1;

    await sm.handleCommand(chatId, "session:suspend");
    await suspendStarted;

    // The terminate must join the in-flight suspend instead of acking over
    // it — handler.suspend() is still running.
    let terminateSettled = false;
    const terminate = sm.handleCommand(chatId, "session:terminate").then(() => {
      terminateSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(terminateSettled).toBe(false);
    expect(suspendingHandler.shutdown).not.toHaveBeenCalled();

    resolveSuspend?.();
    await terminate;

    // The suspend already released the slot, but terminate still tore the
    // handler down — a suspended handler is still a live old run.
    expect(suspendingHandler.suspend).toHaveBeenCalledTimes(1);
    expect(suspendingHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("rejects the terminate when the joined suspend failed, then lets a retry succeed", async () => {
    const boom = new Error("suspend failed");
    let signalSuspendStarted: (() => void) | undefined;
    let rejectSuspend: ((err: unknown) => void) | undefined;
    const suspendStarted = new Promise<void>((resolve) => {
      signalSuspendStarted = resolve;
    });
    const suspendGate = new Promise<void>((_resolve, reject) => {
      rejectSuspend = reject;
    });
    const failingSuspendHandler = handler({
      suspend: vi.fn().mockImplementation(async () => {
        signalSuspendStarted?.();
        await suspendGate;
      }),
    });
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-terminate-suspend-failed";
    installSession(i, chatId, { handler: failingSuspendHandler, status: "active" });
    i.slotScheduler.activeCount = 1;

    await sm.handleCommand(chatId, "session:suspend");
    await suspendStarted;

    const terminate = sm.handleCommand(chatId, "session:terminate");
    rejectSuspend?.(boom);

    // A failed suspend means the old run was never confirmed stopped — the
    // apply must reject (agent-slot maps this to applied:false), not ack.
    await expect(terminate).rejects.toBe(boom);
    expect(i.projection.sessions.has(chatId)).toBe(true);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);
    expect(failingSuspendHandler.shutdown).not.toHaveBeenCalled();

    // Retry after the suspend settled: the recorded suspendError drives a
    // strict teardown of the still-installed handler, and only after it
    // succeeds does the terminate delete state and resolve.
    vi.mocked(failingSuspendHandler.shutdown).mockImplementation(async () => {
      expect(i.projection.sessions.has(chatId)).toBe(true);
    });
    await sm.handleCommand(chatId, "session:terminate");
    expect(failingSuspendHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("gates the retry ack on strict teardown after a failed suspend and stays retryable when teardown fails", async () => {
    const suspendBoom = new Error("suspend failed");
    const teardownBoom = new Error("teardown failed");
    let signalSuspendStarted: (() => void) | undefined;
    let rejectSuspend: ((err: unknown) => void) | undefined;
    const suspendStarted = new Promise<void>((resolve) => {
      signalSuspendStarted = resolve;
    });
    const suspendGate = new Promise<void>((_resolve, reject) => {
      rejectSuspend = reject;
    });
    let signalTeardownStarted: (() => void) | undefined;
    let rejectTeardown: ((err: unknown) => void) | undefined;
    const teardownStarted = new Promise<void>((resolve) => {
      signalTeardownStarted = resolve;
    });
    const teardownGate = new Promise<void>((_resolve, reject) => {
      rejectTeardown = reject;
    });
    const targetHandler = handler({
      suspend: vi.fn().mockImplementation(async () => {
        signalSuspendStarted?.();
        await suspendGate;
      }),
      shutdown: vi.fn().mockImplementation(async () => {
        signalTeardownStarted?.();
        await teardownGate;
      }),
    });
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-terminate-retry-teardown-failed";
    installSession(i, chatId, { handler: targetHandler, status: "active" });
    i.slotScheduler.activeCount = 1;

    await sm.handleCommand(chatId, "session:suspend");
    await suspendStarted;
    const first = sm.handleCommand(chatId, "session:terminate");
    rejectSuspend?.(suspendBoom);
    await expect(first).rejects.toBe(suspendBoom);
    expect(targetHandler.shutdown).not.toHaveBeenCalled();

    // Retry: the terminate must not resolve while the strict teardown of the
    // failed-suspend handler is still in flight.
    const retry = sm.handleCommand(chatId, "session:terminate");
    let retrySettled = false;
    void retry.then(
      () => {
        retrySettled = true;
      },
      () => {
        retrySettled = true;
      },
    );
    await teardownStarted;
    expect(retrySettled).toBe(false);

    // Teardown failure rejects the retry too — and leaves no deadlocked
    // state: the entry and its suspendError survive for a genuine retry.
    rejectTeardown?.(teardownBoom);
    await expect(retry).rejects.toBe(teardownBoom);
    await vi.waitFor(() => expect(retrySettled).toBe(true));
    expect(i.projection.sessions.has(chatId)).toBe(true);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    // Next retry tears down (now succeeding) and completes the apply.
    vi.mocked(targetHandler.shutdown).mockResolvedValue(undefined);
    await sm.handleCommand(chatId, "session:terminate");
    expect(targetHandler.shutdown).toHaveBeenCalledTimes(2);
    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("propagates a joined prior shutdown failure to a strict terminate", async () => {
    const boom = new Error("prior shutdown failed");
    let signalShutdownStarted: (() => void) | undefined;
    let rejectShutdown: ((err: unknown) => void) | undefined;
    const shutdownStarted = new Promise<void>((resolve) => {
      signalShutdownStarted = resolve;
    });
    const shutdownGate = new Promise<void>((_resolve, reject) => {
      rejectShutdown = reject;
    });
    let signalPrepareStarted: (() => void) | undefined;
    let resolvePrepare: (() => void) | undefined;
    const prepareStarted = new Promise<void>((resolve) => {
      signalPrepareStarted = resolve;
    });
    const prepareGate = new Promise<void>((resolve) => {
      resolvePrepare = resolve;
    });
    const targetHandler = handler({
      shutdown: vi
        .fn()
        .mockImplementationOnce(async () => {
          signalShutdownStarted?.();
          await shutdownGate;
        })
        .mockResolvedValue(undefined),
    });
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-terminate-joins-prior-shutdown";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: targetHandler,
        status: "active",
        routeTransition: { generation: 0, handler: targetHandler, phase: "resume" },
      }),
    );
    i.slotScheduler.activeCount = 1;
    // Keep the suspend's promise in flight so the terminate below actually
    // joins it while the canceled transition's shutdown is still gated.
    i.inboxDelivery.prepareOperatorSuspend = vi.fn<(chatId: string) => Promise<void>>().mockImplementation(async () => {
      signalPrepareStarted?.();
      await prepareGate;
    });

    await sm.handleCommand(chatId, "session:suspend");
    // suspendSession invalidated the route transition, which retired the
    // handler into a lenient fire-and-forget shutdown — still gated.
    await shutdownStarted;
    await prepareStarted;

    const terminate = sm.handleCommand(chatId, "session:terminate");
    let terminateSettled = false;
    void terminate.then(
      () => {
        terminateSettled = true;
      },
      () => {
        terminateSettled = true;
      },
    );
    resolvePrepare?.();
    // The suspend boundary now covers the gated shutdown end-to-end:
    // `suspending` stays in flight until the handler is confirmed stopped,
    // so the joined terminate stays pending too (no second shutdown call).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(i.projection.sessions.get(chatId)?.suspending).not.toBe(null);
    expect(targetHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(terminateSettled).toBe(false);

    // The prior was started by a lenient caller, but its rejection must still
    // reach the strict terminate — an applied:true here would ack over a
    // handler that was never confirmed stopped.
    rejectShutdown?.(boom);
    await expect(terminate).rejects.toBe(boom);
    expect(i.projection.sessions.has(chatId)).toBe(true);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    // Retry re-attempts the teardown (the one-shot gated implementation is
    // consumed, the default now resolves) and completes the apply.
    await sm.handleCommand(chatId, "session:terminate");
    expect(targetHandler.shutdown).toHaveBeenCalledTimes(2);
    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("coalesces a strict terminate onto a resolving prior shutdown without double-teardown", async () => {
    let signalShutdownStarted: (() => void) | undefined;
    let resolveShutdown: (() => void) | undefined;
    const shutdownStarted = new Promise<void>((resolve) => {
      signalShutdownStarted = resolve;
    });
    const shutdownGate = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    let resolvePrepare: (() => void) | undefined;
    const prepareGate = new Promise<void>((resolve) => {
      resolvePrepare = resolve;
    });
    const targetHandler = handler({
      shutdown: vi.fn().mockImplementation(async () => {
        signalShutdownStarted?.();
        await shutdownGate;
      }),
    });
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-terminate-prior-shutdown-success";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: targetHandler,
        status: "active",
        routeTransition: { generation: 0, handler: targetHandler, phase: "resume" },
      }),
    );
    i.slotScheduler.activeCount = 1;
    i.inboxDelivery.prepareOperatorSuspend = vi.fn<(chatId: string) => Promise<void>>().mockImplementation(async () => {
      await prepareGate;
    });

    await sm.handleCommand(chatId, "session:suspend");
    await shutdownStarted;

    const terminate = sm.handleCommand(chatId, "session:terminate");
    let terminateSettled = false;
    void terminate.then(() => {
      terminateSettled = true;
    });
    resolvePrepare?.();
    // The suspend boundary covers the gated shutdown: `suspending` (and the
    // joined terminate) stays in flight until the shutdown settles.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(i.projection.sessions.get(chatId)?.suspending).not.toBe(null);
    expect(terminateSettled).toBe(false);

    resolveShutdown?.();
    await terminate;

    // One teardown total: the strict terminate joined the prior shutdown
    // instead of starting a second one, then completed the apply.
    expect(targetHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(terminateSettled).toBe(true);
    expect(i.projection.sessions.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("keeps the suspend boundary in flight until the canceled-transition shutdown settles", async () => {
    const boom = new Error("canceled-transition shutdown failed");
    let signalShutdownStarted: (() => void) | undefined;
    let rejectShutdown: ((err: unknown) => void) | undefined;
    const shutdownStarted = new Promise<void>((resolve) => {
      signalShutdownStarted = resolve;
    });
    const shutdownGate = new Promise<void>((_resolve, reject) => {
      rejectShutdown = reject;
    });
    const targetHandler = handler({
      shutdown: vi
        .fn()
        .mockImplementationOnce(async () => {
          signalShutdownStarted?.();
          await shutdownGate;
        })
        .mockResolvedValue(undefined),
    });
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-suspend-covers-transition-shutdown";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: targetHandler,
        status: "active",
        routeTransition: { generation: 0, handler: targetHandler, phase: "resume" },
      }),
    );
    i.slotScheduler.activeCount = 1;

    // Prepare is NOT gated: it settles immediately. The suspend boundary
    // must still stay in flight — it now covers the canceled transition's
    // gated shutdown of the retired handler end-to-end.
    await sm.handleCommand(chatId, "session:suspend");
    await shutdownStarted;
    await Promise.resolve();
    await Promise.resolve();
    expect(i.projection.sessions.get(chatId)?.suspending).not.toBe(null);

    // The terminate joins that boundary and must not settle (ack) while the
    // handler shutdown is still gated.
    const terminate = sm.handleCommand(chatId, "session:terminate");
    let terminateSettled = false;
    void terminate.then(
      () => {
        terminateSettled = true;
      },
      () => {
        terminateSettled = true;
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(terminateSettled).toBe(false);

    // The gated shutdown rejects: the suspend boundary records the failure
    // and the joined terminate rejects (applied:false), entry retained.
    rejectShutdown?.(boom);
    await expect(terminate).rejects.toBe(boom);
    expect(i.projection.sessions.has(chatId)).toBe(true);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    // Retry converges: strict teardown re-runs (now resolving) and the apply
    // completes.
    await sm.handleCommand(chatId, "session:terminate");
    expect(targetHandler.shutdown).toHaveBeenCalledTimes(2);
    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("treats a falsey suspend rejection as a failure and rejects the terminate", async () => {
    let signalSuspendStarted: (() => void) | undefined;
    let rejectSuspend: ((err: unknown) => void) | undefined;
    const suspendStarted = new Promise<void>((resolve) => {
      signalSuspendStarted = resolve;
    });
    const suspendGate = new Promise<void>((_resolve, reject) => {
      rejectSuspend = reject;
    });
    const targetHandler = handler({
      suspend: vi.fn().mockImplementation(async () => {
        signalSuspendStarted?.();
        await suspendGate;
      }),
    });
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-terminate-falsey-suspend-rejection";
    installSession(i, chatId, { handler: targetHandler, status: "active" });
    i.slotScheduler.activeCount = 1;

    await sm.handleCommand(chatId, "session:suspend");
    await suspendStarted;

    const terminate = sm.handleCommand(chatId, "session:terminate");
    // A Promise can reject(null): the boxed failure marker must not lose it —
    // the apply still rejects (normalized to an Error), never applied:true.
    rejectSuspend?.(null);
    await expect(terminate).rejects.toThrow(/session suspend failed/);
    expect(i.projection.sessions.has(chatId)).toBe(true);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("tears down a replacement handler installed after the suspend-stopped handler was retired", async () => {
    const boom = new Error("replacement shutdown failed");
    const retiredHandler = handler();
    const replacementHandler = handler({
      resume: vi.fn().mockResolvedValue({
        sessionId: "replacement-session",
        route: { kind: "owned" as const, mode: "queued" as const },
      }),
      shutdown: vi.fn().mockRejectedValueOnce(boom).mockResolvedValue(undefined),
    });
    const sm = makeRuntime({ handlers: [replacementHandler] });
    const i = internals(sm);
    const chatId = "chat-terminate-replacement-handler";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: retiredHandler,
        status: "active",
        routeTransition: { generation: 0, handler: retiredHandler, phase: "resume" },
      }),
    );
    i.slotScheduler.activeCount = 1;

    // Suspend cancels the transition and the suspend boundary shuts the
    // retired handler down — the stopped marker binds to THAT handler.
    await sm.handleCommand(chatId, "session:suspend");
    await vi.waitFor(() => expect(i.projection.sessions.get(chatId)?.suspending ?? null).toBe(null));
    expect(retiredHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(i.projection.sessions.get(chatId)?.handlerStoppedBySuspend).toBe(retiredHandler);

    // Resume installs a replacement handler (the old one is retired) and
    // re-acquires the active slot.
    await sm.handleCommand(chatId, "session:resume");
    const entry = i.projection.sessions.get(chatId);
    expect(entry?.handler).toBe(replacementHandler);
    expect(entry ? i.slotScheduler.isActiveSlotHeld(entry) : false).toBe(true);

    // The marker must NOT exempt the replacement: the terminate tears it
    // down strictly, and a shutdown failure rejects the apply (applied:false).
    await expect(sm.handleCommand(chatId, "session:terminate")).rejects.toBe(boom);
    expect(replacementHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(i.projection.sessions.has(chatId)).toBe(true);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    // Retry: teardown succeeds and the apply completes (applied:true).
    await sm.handleCommand(chatId, "session:terminate");
    expect(replacementHandler.shutdown).toHaveBeenCalledTimes(2);
    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("does not double-tear-down when the suspend-stopped handler is still the current handler", async () => {
    const stoppedHandler = handler();
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-terminate-no-double-teardown";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: stoppedHandler,
        status: "active",
        routeTransition: { generation: 0, handler: stoppedHandler, phase: "resume" },
      }),
    );
    i.slotScheduler.activeCount = 1;

    await sm.handleCommand(chatId, "session:suspend");
    await vi.waitFor(() => expect(i.projection.sessions.get(chatId)?.suspending ?? null).toBe(null));
    expect(stoppedHandler.shutdown).toHaveBeenCalledTimes(1);

    // The handler was never replaced, so the marker still matches: the
    // terminate cleans up state without a second shutdown.
    await sm.handleCommand(chatId, "session:terminate");
    expect(stoppedHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("strictly tears down an evicted handler before a terminate may ack", async () => {
    const boom = new Error("evicted shutdown failed");
    let signalShutdownStarted: (() => void) | undefined;
    let rejectShutdown: ((err: unknown) => void) | undefined;
    const shutdownStarted = new Promise<void>((resolve) => {
      signalShutdownStarted = resolve;
    });
    const shutdownGate = new Promise<void>((_resolve, reject) => {
      rejectShutdown = reject;
    });
    const victimHandler = handler({
      shutdown: vi
        .fn()
        .mockImplementationOnce(async () => {
          signalShutdownStarted?.();
          await shutdownGate;
        })
        .mockResolvedValue(undefined),
    });
    const sm = makeRuntime({ maxSessions: 1 });
    const i = internals(sm);
    const chatId = "chat-evicted-pending-teardown";
    bindSeededSession(i, makeSessionRecord(chatId, { handler: victimHandler, status: "active", lastActivity: 1_000 }));
    bindSeededSession(i, makeSessionRecord("chat-evicted-blocker", { status: "active", lastActivity: 2_000 }));
    i.slotScheduler.activeCount = 2;

    // LRU eviction detaches the victim: fire-and-forget shutdown (gated)
    // plus a registered teardown debt.
    i.slotScheduler.evictIfNeeded();
    await shutdownStarted;
    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(i.routeTeardown.pendingTeardowns.get(chatId)?.has(victimHandler)).toBe(true);

    // The terminate joins the in-flight shutdown's raw face — it must not
    // ack while the old handler's stop is unconfirmed.
    const terminate = sm.handleCommand(chatId, "session:terminate");
    let terminateSettled = false;
    void terminate.then(
      () => {
        terminateSettled = true;
      },
      () => {
        terminateSettled = true;
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(victimHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(terminateSettled).toBe(false);

    rejectShutdown?.(boom);
    await expect(terminate).rejects.toBe(boom);
    expect(i.routeTeardown.pendingTeardowns.get(chatId)?.has(victimHandler)).toBe(true);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    // Retry converges: strict teardown re-runs and succeeds, debt cleared.
    await sm.handleCommand(chatId, "session:terminate");
    expect(victimHandler.shutdown).toHaveBeenCalledTimes(2);
    expect(i.routeTeardown.pendingTeardowns.has(chatId)).toBe(false);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("manager shutdown stops a handler left unconfirmed after a completed failed operator suspend", async () => {
    const suspendBoom = new Error("suspend settle failed");
    const targetHandler = handler({
      suspend: vi.fn().mockRejectedValue(suspendBoom),
      shutdown: vi.fn().mockResolvedValue(undefined),
    });
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-shutdown-after-failed-suspend";
    installSession(i, chatId, { handler: targetHandler, status: "active" });
    i.slotScheduler.activeCount = 1;

    await sm.handleCommand(chatId, "session:suspend");
    await vi.waitFor(() => expect(i.projection.sessions.get(chatId)?.suspending ?? null).toBe(null));
    expect(i.projection.sessions.get(chatId)?.suspendError).toEqual({ error: suspendBoom });
    expect(i.projection.sessions.get(chatId)?.handlerStoppedBySuspend).toBe(null);
    // Failed settle intentionally skipped teardown — stop is still unconfirmed.
    expect(targetHandler.shutdown).not.toHaveBeenCalled();

    await sm.shutdown("operator stop");
    expect(targetHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(targetHandler.shutdown).toHaveBeenCalledWith(
      "operator stop",
      expect.not.objectContaining({
        settleProviderEntered: true,
      }),
    );
    expect(i.projection.sessions.has(chatId)).toBe(false);
  });

  it("quarantines a timed-out operator suspend and recovers real inbox debt before a fresh handler", async () => {
    vi.useFakeTimers();
    let initialCtx: SessionContext | undefined;
    let initialHead: SessionMessage | undefined;
    const oldHandler = handler({
      start: vi.fn().mockImplementation(async (message, ctx, token) => {
        initialCtx = ctx;
        initialHead = message;
        token?.processingStarted(message);
        return { sessionId: "established-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
      inject: vi.fn().mockReturnValue({ kind: "owned", mode: "queued" } as const),
      suspend: vi.fn(() => new Promise<void>(() => {})),
      shutdown: vi.fn(() => new Promise<void>(() => {})),
    });
    let freshCtx: SessionContext | undefined;
    let freshMessage: SessionMessage | undefined;
    const freshHandler = handler({
      resume: vi.fn().mockImplementation(async (message, _sessionId, ctx, token) => {
        freshCtx = ctx;
        freshMessage = message;
        if (message) token?.processingStarted(message);
        return { sessionId: "fresh-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
    });
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const onSessionEvent = vi.fn<(chatId: string, event: SessionEvent) => void>();
    const sm = makeRuntime({ handlers: [oldHandler, freshHandler], ackEntry, recoverChat, onSessionEvent });
    const i = internals(sm);
    const chatId = "chat-timeout-recovery-before-fresh-handler";
    const headEntry = mockEntry({ id: 9100, chatId, messageId: "msg-timeout-head" });
    const queuedTailEntry = mockEntry({ id: 9101, chatId, messageId: "msg-timeout-queued-tail" });

    await sm.dispatch(headEntry);
    if (!initialCtx || !initialHead) throw new Error("initial route was not captured");
    await sm.dispatch(queuedTailEntry);
    expect(i.routeTeardown.hasInFlightTransition(requireSession(i, chatId))).toBe(false);

    await sm.handleCommand(chatId, "session:suspend");
    const laterDispatch = sm.dispatch(mockEntry({ id: 9102, chatId, messageId: "msg-after-timeout" }));

    await vi.advanceTimersByTimeAsync(29_999);
    expect(freshHandler.resume).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await laterDispatch;

    expect(ackEntry).toHaveBeenCalledWith(9100);
    expect(ackEntry).not.toHaveBeenCalledWith(9101);
    expect(recoverChat).toHaveBeenCalledTimes(1);
    expect(freshHandler.resume).not.toHaveBeenCalled();
    expect(oldHandler.shutdown).not.toHaveBeenCalled();
    expect(i.routeTeardown.pendingTeardowns.has(chatId)).toBe(false);
    expect(i.routeTeardown.quarantinedSessions.get(chatId)).toEqual(
      expect.objectContaining({
        handler: oldHandler,
        reason: "operator_suspend_timeout",
        routeTransitionInFlight: false,
      }),
    );
    expect(onSessionEvent).toHaveBeenCalledWith(
      chatId,
      expect.objectContaining({
        payload: expect.objectContaining({
          message: expect.stringContaining('"routeTransitionInFlight":false'),
        }),
      }),
    );

    await sm.dispatch(queuedTailEntry);

    const recoveryOrder = recoverChat.mock.invocationCallOrder[0];
    const resumeOrder = vi.mocked(freshHandler.resume).mock.invocationCallOrder[0];
    expect(recoveryOrder).toBeDefined();
    expect(resumeOrder).toBeDefined();
    expect(Number(recoveryOrder)).toBeLessThan(Number(resumeOrder));
    expect(i.projection.sessions.get(chatId)?.handler).toBe(freshHandler);
    if (!freshCtx || !freshMessage) throw new Error("fresh route was not captured");
    await freshCtx.finishTurn(freshMessage, { status: "success", terminal: true });

    await sm.shutdown();
  });

  it("preserves terminal notice debt when operator suspend emits failure and then times out", async () => {
    vi.useFakeTimers();
    let initialCtx: SessionContext | undefined;
    const oldHandler = handler({
      start: vi.fn().mockImplementation(async (message, ctx, token) => {
        initialCtx = ctx;
        token?.processingStarted(message);
        return { sessionId: "established-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
      suspend: vi.fn().mockImplementation(() => {
        if (!initialCtx) throw new Error("initial route context was not captured");
        initialCtx.emitEvent({
          kind: "error",
          payload: {
            source: "runtime",
            message: encodeProviderRetryEventMessage({
              event: "provider_failure_terminal",
              provider: "codex",
              scope: "provider_turn",
              category: "credential",
              reasonCode: "provider_credential_required",
              replaySafety: "provider_entered",
              userSeverity: "error",
              messagePreview: "refresh token revoked while suspending",
            }),
          },
        });
        return new Promise<void>(() => {});
      }),
      shutdown: vi.fn(() => new Promise<void>(() => {})),
    });
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue({ id: "runtime-notice-after-timeout" });
    const sdk = { ...mockSdk(), sendMessage } as unknown as FirstTreeHubSDK;
    const sm = makeRuntime({ handlers: [oldHandler], ackEntry, recoverChat, sdk });
    const i = internals(sm);
    const chatId = "chat-timeout-terminal-notice-debt";
    const headEntry = mockEntry({ id: 9110, chatId, messageId: "msg-timeout-terminal-notice" });

    await sm.dispatch(headEntry);
    await sm.handleCommand(chatId, "session:suspend");
    await vi.advanceTimersByTimeAsync(30_000);
    await i.projection.sessions.get(chatId)?.suspending;

    expect(ackEntry).not.toHaveBeenCalled();
    expect(i.inboxDelivery.snapshot(chatId)).toMatchObject({
      entries: [{ entryId: 9110, messageId: headEntry.message.id, phase: "owned" }],
      recoveryDebt: "required",
    });

    // The first frame opens recovery; the server's redelivery then settles
    // the retained notice debt without re-entering the provider.
    await sm.dispatch(headEntry);
    expect(recoverChat).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(ackEntry).not.toHaveBeenCalled();

    await sm.dispatch(headEntry);
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledTimes(1));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(9110);
    expect(oldHandler.start).toHaveBeenCalledTimes(1);
    const noticeOrder = sendMessage.mock.invocationCallOrder[0];
    const ackOrder = ackEntry.mock.invocationCallOrder[0];
    if (noticeOrder === undefined || ackOrder === undefined) throw new Error("expected notice and ACK order");
    expect(noticeOrder).toBeLessThan(ackOrder);
    expect(oldHandler.shutdown).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("keeps later suspend and resume cycles healthy while the quarantined callback never settles", async () => {
    vi.useFakeTimers();
    const oldHandler = handler({
      suspend: vi.fn(() => new Promise<void>(() => {})),
      shutdown: vi.fn(() => new Promise<void>(() => {})),
    });
    const freshHandler = handler({
      resume: vi
        .fn()
        .mockResolvedValue({ sessionId: "fresh-session", route: { kind: "owned" as const, mode: "queued" as const } }),
    });
    const sm = makeRuntime({ handlers: [freshHandler] });
    const i = internals(sm);
    const chatId = "chat-quarantine-repeated-resume";
    installSession(i, chatId, { handler: oldHandler, status: "active" });
    i.slotScheduler.activeCount = 1;

    await sm.handleCommand(chatId, "session:suspend");
    await vi.advanceTimersByTimeAsync(30_000);
    await i.projection.sessions.get(chatId)?.suspending;
    await sm.handleCommand(chatId, "session:resume");

    expect(freshHandler.resume).toHaveBeenCalledTimes(1);
    expect(i.projection.sessions.get(chatId)?.handler).toBe(freshHandler);
    expect(oldHandler.shutdown).not.toHaveBeenCalled();

    await sm.handleCommand(chatId, "session:suspend");
    await i.projection.sessions.get(chatId)?.suspending;
    await sm.handleCommand(chatId, "session:resume");

    expect(freshHandler.resume).toHaveBeenCalledTimes(2);
    expect(i.projection.sessions.get(chatId)?.handler).toBe(freshHandler);
    expect(i.routeTeardown.quarantinedSessions.get(chatId)?.handler).toBe(oldHandler);
    expect(oldHandler.shutdown).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("fences late output and route adoption from a quarantined generation", async () => {
    vi.useFakeTimers();
    let signalResumeStarted: (() => void) | undefined;
    let resolveResume: (() => void) | undefined;
    let resolveSuspend: (() => void) | undefined;
    let oldCtx: SessionContext | undefined;
    let oldToken: DeliveryToken | undefined;
    let oldMessage: SessionMessage | undefined;
    const resumeStarted = new Promise<void>((resolve) => {
      signalResumeStarted = resolve;
    });
    const resumeGate = new Promise<void>((resolve) => {
      resolveResume = resolve;
    });
    const suspendGate = new Promise<void>((resolve) => {
      resolveSuspend = resolve;
    });
    const oldHandler = handler({
      resume: vi.fn().mockImplementation(async (message, _sessionId, ctx, token) => {
        oldCtx = ctx;
        oldToken = token;
        oldMessage = message;
        token?.processingStarted(message);
        signalResumeStarted?.();
        await resumeGate;
        return { sessionId: "late-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
      suspend: vi.fn(() => suspendGate),
      shutdown: vi.fn(() => new Promise<void>(() => {})),
    });
    const freshHandler = handler();
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const onSessionEvent = vi.fn<(chatId: string, event: SessionEvent) => void>();
    const sm = makeRuntime({ handlers: [freshHandler], ackEntry, onSessionEvent });
    const i = internals(sm);
    const chatId = "chat-quarantined-late-generation";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: oldHandler,
        status: "suspended",
        claudeSessionId: "existing-session",
      }),
    );

    const resumeDispatch = sm.dispatch(mockEntry({ id: 9120, chatId, messageId: "msg-late-generation" }));
    await resumeStarted;
    await sm.handleCommand(chatId, "session:suspend");
    await vi.advanceTimersByTimeAsync(30_000);
    await i.projection.sessions.get(chatId)?.suspending;

    expect(i.routeTeardown.quarantinedSessions.get(chatId)).toEqual(
      expect.objectContaining({
        handler: oldHandler,
        routeTransitionInFlight: true,
      }),
    );
    if (!oldCtx || !oldToken || !oldMessage) throw new Error("old route output handles were not captured");
    const eventCount = onSessionEvent.mock.calls.length;
    const ackCount = ackEntry.mock.calls.length;
    const lastActivity = i.projection.sessions.get(chatId)?.lastActivity;
    const trigger = i.projection.currentTrigger.get(chatId);

    oldCtx.emitEvent({ kind: "assistant_text", payload: { text: "late output" } });
    oldCtx.recordProviderActivity();
    await oldCtx.forwardResult("late result");
    await oldToken.complete(oldMessage, { status: "success", terminal: true });
    resolveSuspend?.();

    expect(onSessionEvent).toHaveBeenCalledTimes(eventCount);
    expect(ackEntry).toHaveBeenCalledTimes(ackCount);
    expect(i.projection.sessions.get(chatId)?.lastActivity).toBe(lastActivity);
    expect(i.projection.currentTrigger.get(chatId)).toEqual(trigger);
    expect(i.projection.sessions.get(chatId)?.claudeSessionId).toBe("existing-session");

    await sm.dispatch(mockEntry({ id: 9121, chatId, messageId: "msg-provider-admission-fenced" }));
    expect(freshHandler.start).not.toHaveBeenCalled();
    expect(freshHandler.resume).not.toHaveBeenCalled();

    await sm.shutdown();
    expect(oldHandler.shutdown).not.toHaveBeenCalled();

    resolveResume?.();
    await resumeDispatch;
    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(i.routeTeardown.pendingTeardowns.has(chatId)).toBe(false);
  });

  it("returns restart-required Reset failure and bounds manager shutdown after suspend timeout", async () => {
    vi.useFakeTimers();
    const oldHandler = handler({
      suspend: vi.fn(() => new Promise<void>(() => {})),
      shutdown: vi.fn(() => new Promise<void>(() => {})),
    });
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-quarantine-reset-restart-required";
    installSession(i, chatId, { handler: oldHandler, status: "active" });
    i.slotScheduler.activeCount = 1;

    await sm.handleCommand(chatId, "session:suspend");
    await vi.advanceTimersByTimeAsync(30_000);
    await i.projection.sessions.get(chatId)?.suspending;

    await expect(sm.handleCommand(chatId, "session:terminate", { resetRef: "ref-restart" })).rejects.toThrow(
      "Reset blocked: operator_suspend_timeout; provider teardown was not confirmed",
    );
    expect(i.projection.sessions.has(chatId)).toBe(true);
    expect(i.routeTeardown.quarantinedSessions.has(chatId)).toBe(true);
    expect(oldHandler.shutdown).not.toHaveBeenCalled();

    await expect(sm.shutdown()).resolves.toBeUndefined();
    expect(oldHandler.shutdown).not.toHaveBeenCalled();
  });

  it("manager shutdown stops a handler after a completed failed suspend with a falsey rejection", async () => {
    const targetHandler = handler({
      suspend: vi.fn().mockRejectedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    });
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-shutdown-after-falsey-suspend-error";
    installSession(i, chatId, { handler: targetHandler, status: "active" });
    i.slotScheduler.activeCount = 1;

    await sm.handleCommand(chatId, "session:suspend");
    await vi.waitFor(() => expect(i.projection.sessions.get(chatId)?.suspending ?? null).toBe(null));
    // Boxed error: falsey rejections are still failures.
    expect(i.projection.sessions.get(chatId)?.suspendError).toEqual({ error: undefined });
    expect(targetHandler.shutdown).not.toHaveBeenCalled();

    await sm.shutdown("manager_shutdown");
    expect(targetHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(i.projection.sessions.has(chatId)).toBe(false);
  });

  it("strictly stops a failed-suspend handler before resume installs a fresh one", async () => {
    const suspendBoom = new Error("suspend failed");
    const stopBoom = new Error("stop failed");
    const oldHandler = handler({
      suspend: vi.fn().mockRejectedValue(suspendBoom),
      shutdown: vi.fn().mockRejectedValueOnce(stopBoom).mockResolvedValue(undefined),
    });
    const freshHandler = handler({
      resume: vi
        .fn()
        .mockResolvedValue({ sessionId: "fresh-session", route: { kind: "owned" as const, mode: "queued" as const } }),
    });
    const sm = makeRuntime({ handlers: [freshHandler] });
    const i = internals(sm);
    const chatId = "chat-resume-after-failed-suspend";
    installSession(i, chatId, { handler: oldHandler, status: "active" });
    i.slotScheduler.activeCount = 1;

    // Suspend fails: the old handler was never confirmed stopped.
    await sm.handleCommand(chatId, "session:suspend");
    await vi.waitFor(() => expect(i.projection.sessions.get(chatId)?.suspending ?? null).toBe(null));
    expect(i.projection.sessions.get(chatId)?.suspendError).not.toBe(null);

    // Resume must NOT reuse or overwrite the unconfirmed-stop reference: it
    // strictly stops the old handler first, and a stop failure propagates
    // instead of silently continuing.
    await expect(sm.handleCommand(chatId, "session:resume")).rejects.toBe(stopBoom);
    expect(oldHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(freshHandler.resume).not.toHaveBeenCalled();
    expect(i.projection.sessions.get(chatId)?.handler).toBe(oldHandler);

    // Retry resume: the stop succeeds, the old handler is retired and
    // replaced by a fresh one, and the route proceeds — strictly after the
    // stop.
    await sm.handleCommand(chatId, "session:resume");
    expect(oldHandler.shutdown).toHaveBeenCalledTimes(2);
    expect(freshHandler.resume).toHaveBeenCalledTimes(1);
    expect(i.projection.sessions.get(chatId)?.handler).toBe(freshHandler);
    const stopOrder = vi.mocked(oldHandler.shutdown).mock.invocationCallOrder[1];
    const resumeOrder = vi.mocked(freshHandler.resume).mock.invocationCallOrder[0];
    expect(stopOrder).toBeDefined();
    expect(resumeOrder).toBeDefined();
    expect(Number(stopOrder)).toBeLessThan(Number(resumeOrder));

    await sm.shutdown();
  });

  it("retains teardown proof when a canceled fresh-start shutdown fails, and converges on terminate", async () => {
    const boom = new Error("start-cancel shutdown failed");
    const startHandler = handler({
      shutdown: vi.fn().mockRejectedValueOnce(boom).mockRejectedValueOnce(boom).mockResolvedValue(undefined),
    });
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-canceled-start-pending-teardown";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: startHandler,
        status: "active",
        routeTransition: { generation: 0, handler: startHandler, phase: "start" },
      }),
    );
    i.slotScheduler.activeCount = 1;

    // Suspend cancels the fresh start; the suspend boundary covers the
    // shutdown, which FAILS. The canceledUnestablishedStart finally drops
    // the entry — but the teardown debt must survive it.
    await sm.handleCommand(chatId, "session:suspend");
    await vi.waitFor(() => expect(i.projection.sessions.has(chatId)).toBe(false));
    expect(i.routeTeardown.pendingTeardowns.get(chatId)?.has(startHandler)).toBe(true);

    // No session, mapping, queue, or inbox custody remains — without the
    // debt this terminate would early-return a false applied:true. Instead
    // it runs the strict teardown and rejects on its failure.
    await expect(sm.handleCommand(chatId, "session:terminate")).rejects.toBe(boom);
    expect(i.routeTeardown.pendingTeardowns.get(chatId)?.has(startHandler)).toBe(true);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    // Retry: strict teardown succeeds and the debt is cleared.
    await sm.handleCommand(chatId, "session:terminate");
    expect(startHandler.shutdown).toHaveBeenCalledTimes(3);
    expect(i.routeTeardown.pendingTeardowns.has(chatId)).toBe(false);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("drains teardown debt registered while a terminate is in flight before it may ack", async () => {
    const boom = new Error("late debt shutdown failed");
    let signalFirstShutdownStarted: (() => void) | undefined;
    let resolveFirstShutdown: (() => void) | undefined;
    const firstShutdownStarted = new Promise<void>((resolve) => {
      signalFirstShutdownStarted = resolve;
    });
    const firstShutdownGate = new Promise<void>((resolve) => {
      resolveFirstShutdown = resolve;
    });
    const debtHandler = handler({
      shutdown: vi
        .fn()
        .mockImplementationOnce(async () => {
          signalFirstShutdownStarted?.();
          await firstShutdownGate;
        })
        .mockResolvedValue(undefined),
    });
    const evictedHandler = handler({
      shutdown: vi.fn().mockRejectedValueOnce(boom).mockResolvedValue(undefined),
    });
    const sm = makeRuntime({ maxSessions: 1 });
    const i = internals(sm);
    const chatId = "chat-late-debt-drain";
    installSession(i, chatId, { handler: evictedHandler, status: "suspended" });
    i.routeTeardown.registerPendingTeardown(chatId, debtHandler);

    const terminate = sm.handleCommand(chatId, "session:terminate");
    let terminateSettled = false;
    void terminate.then(
      () => {
        terminateSettled = true;
      },
      () => {
        terminateSettled = true;
      },
    );
    await firstShutdownStarted;

    // Concurrent lifecycle activity registers a NEW debt mid-drain (late
    // producers include a stale route discard or the suspend finally) —
    // one the in-flight terminate's first snapshot never saw. (Eviction no
    // longer produces it here: chats with debt are force-kept.)
    i.routeTeardown.registerPendingTeardown(chatId, evictedHandler);
    expect(i.routeTeardown.pendingTeardowns.get(chatId)?.has(evictedHandler)).toBe(true);
    expect(terminateSettled).toBe(false);

    // Releasing the first shutdown must NOT ack: the drain loops until the
    // set is stably empty, so the late debt is torn down too — and its
    // failure rejects the apply.
    resolveFirstShutdown?.();
    await expect(terminate).rejects.toBe(boom);
    expect(i.routeTeardown.pendingTeardowns.get(chatId)?.has(debtHandler)).toBe(false);
    expect(i.routeTeardown.pendingTeardowns.get(chatId)?.has(evictedHandler)).toBe(true);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    // Retry converges: the late debt's teardown succeeds, set drained.
    await sm.handleCommand(chatId, "session:terminate");
    expect(debtHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(evictedHandler.shutdown).toHaveBeenCalledTimes(2);
    expect(i.routeTeardown.pendingTeardowns.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("manager shutdown joins and tears down detached pending handlers", async () => {
    let signalDetachShutdownStarted: (() => void) | undefined;
    let rejectDetachShutdown: ((err: unknown) => void) | undefined;
    const detachShutdownStarted = new Promise<void>((resolve) => {
      signalDetachShutdownStarted = resolve;
    });
    const detachShutdownGate = new Promise<void>((_resolve, reject) => {
      rejectDetachShutdown = reject;
    });
    const registerOnlyHandler = handler();
    const failedDetachHandler = handler({
      shutdown: vi.fn().mockImplementation(async () => {
        signalDetachShutdownStarted?.();
        await detachShutdownGate;
      }),
    });
    const sharedHandler = handler();
    const sm = makeRuntime();
    const i = internals(sm);
    // A register-only debt (no shutdown in flight) and a debt whose detach
    // shutdown is still gated, plus the same handler registered under two
    // chats to prove dedupe.
    i.routeTeardown.registerPendingTeardown("chat-pending-register-only", registerOnlyHandler);
    i.routeTeardown.registerPendingTeardown("chat-pending-shared-1", sharedHandler);
    i.routeTeardown.registerPendingTeardown("chat-pending-shared-2", sharedHandler);
    i.routeTeardown.detachHandlerWithPendingTeardown("chat-pending-detach", failedDetachHandler, "test_detach");
    await detachShutdownStarted;

    // Manager shutdown is the last owner of detached handlers: it must join
    // the gated in-flight shutdown instead of returning past it.
    const stopped = sm.shutdown();
    let stopSettled = false;
    void stopped.then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    rejectDetachShutdown?.(new Error("detach shutdown failed"));
    await stopped;

    // Register-only debt got a fresh teardown; the shared handler was torn
    // down once despite two chat registrations. allSettled semantics: the
    // failed join does not reject manager shutdown — but the bounded pass
    // retries the failed stop (detach attempt + sweep join + one bounded
    // retry, all rejecting here, hence three calls).
    expect(registerOnlyHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(failedDetachHandler.shutdown).toHaveBeenCalledTimes(3);
    expect(sharedHandler.shutdown).toHaveBeenCalledTimes(1);
  });

  it("manager shutdown quiesces an in-flight suspend before sweeping teardown debt", async () => {
    const boom = new Error("cancel shutdown failed");
    let signalShutdownStarted: (() => void) | undefined;
    let rejectShutdown: ((err: unknown) => void) | undefined;
    const shutdownStarted = new Promise<void>((resolve) => {
      signalShutdownStarted = resolve;
    });
    const shutdownGate = new Promise<void>((_resolve, reject) => {
      rejectShutdown = reject;
    });
    const startHandler = handler({
      shutdown: vi
        .fn()
        .mockImplementationOnce(async () => {
          signalShutdownStarted?.();
          await shutdownGate;
        })
        .mockResolvedValue(undefined),
    });
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-shutdown-quiesce-suspend";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: startHandler,
        status: "active",
        routeTransition: { generation: 0, handler: startHandler, phase: "start" },
      }),
    );
    i.slotScheduler.activeCount = 1;

    // Canceled fresh-start suspend: the slot is released immediately while
    // the suspend boundary covers the handler shutdown — gated here.
    await sm.handleCommand(chatId, "session:suspend");
    await shutdownStarted;

    // Manager shutdown must quiesce the in-flight suspend boundary: it must
    // NOT return while the handler shutdown it covers is still gated.
    const stopped = sm.shutdown();
    let stopSettled = false;
    void stopped.then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    // The gated stop FAILS. The suspend boundary records the teardown debt
    // as it settles (during quiesce, while the entry is still installed), so
    // the sweep still captures the handler and retries the teardown — the
    // second attempt succeeds and no handler is left unowned.
    rejectShutdown?.(boom);
    await stopped;

    expect(stopSettled).toBe(true);
    expect(startHandler.shutdown).toHaveBeenCalledTimes(2);
  });

  it("registers late-materialization shutdowns in the teardown authority", async () => {
    const boom = new Error("stale shutdown failed");
    let signalStaleStarted: (() => void) | undefined;
    let rejectStale: ((err: unknown) => void) | undefined;
    const staleStarted = new Promise<void>((resolve) => {
      signalStaleStarted = resolve;
    });
    const staleGate = new Promise<void>((_resolve, reject) => {
      rejectStale = reject;
    });
    const staleHandler = handler({
      shutdown: vi
        .fn()
        // First call: the suspend boundary's pre-materialization shutdown.
        .mockResolvedValueOnce(undefined)
        // Second call: the discard's afterPrior shutdown, gated then failed.
        .mockImplementationOnce(async () => {
          signalStaleStarted?.();
          await staleGate;
        })
        .mockResolvedValue(undefined),
    });
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-late-materialization";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: staleHandler,
        status: "active",
        routeTransition: { generation: 0, handler: staleHandler, phase: "start" },
      }),
    );
    i.slotScheduler.activeCount = 1;

    // Suspend cancels the start; the boundary's FIRST shutdown succeeds and
    // the entry is dropped with no debt (the stop was confirmed).
    await sm.handleCommand(chatId, "session:suspend");
    await vi.waitFor(() => expect(i.projection.sessions.has(chatId)).toBe(false));
    expect(staleHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(i.routeTeardown.pendingTeardowns.has(chatId)).toBe(false);

    // The canceled start MATERIALIZES late: the discard's second shutdown
    // (afterPrior — the first was a no-op over a not-yet-started handler)
    // must enter the teardown authority instead of running ownerless.
    i.routeTeardown.discardStaleRouteTransition(
      chatId,
      { generation: 0, handler: staleHandler, phase: "start" },
      "test_stale_completion",
    );
    await staleStarted;
    expect(i.routeTeardown.pendingTeardowns.get(chatId)?.has(staleHandler)).toBe(true);

    // A terminate joins the in-flight second shutdown; its failure rejects
    // the apply and keeps the debt retryable.
    const terminate = sm.handleCommand(chatId, "session:terminate");
    rejectStale?.(boom);
    await expect(terminate).rejects.toBe(boom);
    expect(i.routeTeardown.pendingTeardowns.get(chatId)?.has(staleHandler)).toBe(true);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    // Retry converges.
    await sm.handleCommand(chatId, "session:terminate");
    expect(staleHandler.shutdown).toHaveBeenCalledTimes(3);
    expect(i.routeTeardown.pendingTeardowns.has(chatId)).toBe(false);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("fences resume handler installation while a terminate is draining", async () => {
    const suspendBoom = new Error("suspend failed");
    let signalStopStarted: (() => void) | undefined;
    let resolveStop: (() => void) | undefined;
    const stopStarted = new Promise<void>((resolve) => {
      signalStopStarted = resolve;
    });
    const stopGate = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    const oldHandler = handler({
      suspend: vi.fn().mockRejectedValue(suspendBoom),
      shutdown: vi
        .fn()
        .mockImplementationOnce(async () => {
          signalStopStarted?.();
          await stopGate;
        })
        .mockResolvedValue(undefined),
    });
    const freshHandler = handler();
    const sm = makeRuntime({ handlers: [freshHandler] });
    const i = internals(sm);
    const chatId = "chat-resume-fenced-by-terminate";
    installSession(i, chatId, { handler: oldHandler, status: "active" });
    i.slotScheduler.activeCount = 1;

    await sm.handleCommand(chatId, "session:suspend");
    await vi.waitFor(() => expect(i.projection.sessions.get(chatId)?.suspending ?? null).toBe(null));
    expect(i.projection.sessions.get(chatId)?.suspendError).not.toBe(null);

    // Resume's strict stop of the failed-suspend handler is gated; the
    // terminate joins the same raw shutdown.
    const resume = sm.handleCommand(chatId, "session:resume");
    await stopStarted;
    const terminate = sm.handleCommand(chatId, "session:terminate");

    // The stop succeeds — but with the terminate in flight, the resume must
    // abandon the install instead of installing a fresh handler the
    // terminate would ack over: either the fence rejects it, or the
    // terminate wins and removes the entry first (silent abandon).
    resolveStop?.();
    const [resumeResult] = await Promise.allSettled([resume, terminate]);
    if (resumeResult.status === "rejected") {
      expect((resumeResult.reason as Error).message).toMatch(/fenced/);
    }
    expect(freshHandler.resume).not.toHaveBeenCalled();
    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("terminate waits out a gated provider start and strictly tears down the late-materialized handler", async () => {
    const stopBoom = new Error("late stop failed");
    let signalStartStarted: (() => void) | undefined;
    let resolveStart: (() => void) | undefined;
    const startStarted = new Promise<void>((resolve) => {
      signalStartStarted = resolve;
    });
    const startGate = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    let signalLateStopStarted: (() => void) | undefined;
    let rejectLateStop: ((err: unknown) => void) | undefined;
    const lateStopStarted = new Promise<void>((resolve) => {
      signalLateStopStarted = resolve;
    });
    const lateStopGate = new Promise<void>((_resolve, reject) => {
      rejectLateStop = reject;
    });
    const pendingHandler = handler({
      start: vi.fn().mockImplementation(async () => {
        signalStartStarted?.();
        await startGate;
        return { sessionId: "session-id", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
      shutdown: vi
        .fn()
        // First call: the suspend boundary's pre-materialization stop.
        .mockResolvedValueOnce(undefined)
        // Second call: the discard's afterPrior stop, gated then failed.
        .mockImplementationOnce(async () => {
          signalLateStopStarted?.();
          await lateStopGate;
        })
        .mockResolvedValue(undefined),
    });
    const sm = makeRuntime({ handlers: [pendingHandler] });
    const i = internals(sm);
    const chatId = "chat-terminate-joins-producer";

    const dispatch = sm.dispatch(mockEntry({ id: 95, chatId, messageId: "msg-joins-producer" }));
    await startStarted;

    // Pause cancels the start; the boundary's first stop succeeds (a no-op
    // over the not-yet-materialized handler) and the entry is dropped.
    await sm.handleCommand(chatId, "session:suspend");
    await vi.waitFor(() => expect(i.projection.sessions.has(chatId)).toBe(false));
    expect(pendingHandler.shutdown).toHaveBeenCalledTimes(1);

    // Reset while the provider start is STILL gated: the terminate must join
    // the route producer instead of acking inside the real window.
    const terminate = sm.handleCommand(chatId, "session:terminate");
    let terminateSettled = false;
    void terminate.then(
      () => {
        terminateSettled = true;
      },
      () => {
        terminateSettled = true;
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(terminateSettled).toBe(false);

    // The start materializes late: the discard registers the debt and fires
    // the afterPrior stop — the ack must wait for THAT too.
    resolveStart?.();
    await lateStopStarted;
    expect(terminateSettled).toBe(false);

    // The late stop fails → applied:false, debt retained for retry.
    rejectLateStop?.(stopBoom);
    await expect(terminate).rejects.toBe(stopBoom);
    expect(i.routeTeardown.pendingTeardowns.get(chatId)?.has(pendingHandler)).toBe(true);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    // Retry converges.
    await sm.handleCommand(chatId, "session:terminate");
    expect(pendingHandler.shutdown).toHaveBeenCalledTimes(3);
    expect(i.routeTeardown.pendingTeardowns.has(chatId)).toBe(false);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    await dispatch;
    await sm.shutdown();
  });

  it("terminate waits out a failing provider start and its teardown before acking", async () => {
    const startBoom = new Error("start failed");
    let signalStartStarted: (() => void) | undefined;
    let rejectStart: ((err: unknown) => void) | undefined;
    const startStarted = new Promise<void>((resolve) => {
      signalStartStarted = resolve;
    });
    const startGate = new Promise<void>((_resolve, reject) => {
      rejectStart = reject;
    });
    let signalLateStopStarted: (() => void) | undefined;
    let resolveLateStop: (() => void) | undefined;
    const lateStopStarted = new Promise<void>((resolve) => {
      signalLateStopStarted = resolve;
    });
    const lateStopGate = new Promise<void>((resolve) => {
      resolveLateStop = resolve;
    });
    const pendingHandler = handler({
      start: vi.fn().mockImplementation(async () => {
        signalStartStarted?.();
        await startGate;
        return { sessionId: "session-id", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
      shutdown: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(async () => {
          signalLateStopStarted?.();
          await lateStopGate;
        })
        .mockResolvedValue(undefined),
    });
    const sm = makeRuntime({ handlers: [pendingHandler] });
    const i = internals(sm);
    const chatId = "chat-terminate-producer-failure";

    const dispatch = sm.dispatch(mockEntry({ id: 97, chatId, messageId: "msg-producer-failure" }));
    await startStarted;

    await sm.handleCommand(chatId, "session:suspend");
    await vi.waitFor(() => expect(i.projection.sessions.has(chatId)).toBe(false));

    const terminate = sm.handleCommand(chatId, "session:terminate");
    let terminateSettled = false;
    void terminate.then(() => {
      terminateSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(terminateSettled).toBe(false);

    // The producer FAILS: the stale-failure discard still registers the debt
    // and the ack waits for the materialized handler's confirmed stop.
    rejectStart?.(startBoom);
    await lateStopStarted;
    expect(terminateSettled).toBe(false);

    resolveLateStop?.();
    await terminate;
    expect(pendingHandler.shutdown).toHaveBeenCalledTimes(2);
    expect(i.routeTeardown.pendingTeardowns.has(chatId)).toBe(false);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    await dispatch;
    await sm.shutdown();
  });

  it("manager shutdown joins an in-flight provider start and its late-materialization stop", async () => {
    let signalStartStarted: (() => void) | undefined;
    let resolveStart: (() => void) | undefined;
    const startStarted = new Promise<void>((resolve) => {
      signalStartStarted = resolve;
    });
    const startGate = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    let signalLateStopStarted: (() => void) | undefined;
    let resolveLateStop: (() => void) | undefined;
    const lateStopStarted = new Promise<void>((resolve) => {
      signalLateStopStarted = resolve;
    });
    const lateStopGate = new Promise<void>((resolve) => {
      resolveLateStop = resolve;
    });
    const pendingHandler = handler({
      start: vi.fn().mockImplementation(async () => {
        signalStartStarted?.();
        await startGate;
        return { sessionId: "session-id", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
      shutdown: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(async () => {
          signalLateStopStarted?.();
          await lateStopGate;
        })
        .mockResolvedValue(undefined),
    });
    const sm = makeRuntime({ handlers: [pendingHandler] });
    const chatId = "chat-shutdown-joins-producer";

    const dispatch = sm.dispatch(mockEntry({ id: 99, chatId, messageId: "msg-shutdown-joins-producer" }));
    await startStarted;

    // Manager shutdown must not return while the provider start is gated.
    const stopped = sm.shutdown();
    let stopSettled = false;
    void stopped.then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    // The start materializes late during shutdown: the discard's afterPrior
    // stop must also be joined before shutdown may return.
    resolveStart?.();
    await lateStopStarted;
    expect(stopSettled).toBe(false);

    resolveLateStop?.();
    await stopped;
    expect(pendingHandler.shutdown).toHaveBeenCalledTimes(2);

    await dispatch;
  });

  it("holds a new provider route until teardown debt settles", async () => {
    let signalDebtStopStarted: (() => void) | undefined;
    let resolveDebtStop: (() => void) | undefined;
    const debtStopStarted = new Promise<void>((resolve) => {
      signalDebtStopStarted = resolve;
    });
    const debtStopGate = new Promise<void>((resolve) => {
      resolveDebtStop = resolve;
    });
    const debtHandler = handler({
      shutdown: vi
        .fn()
        .mockImplementationOnce(async () => {
          signalDebtStopStarted?.();
          await debtStopGate;
        })
        .mockResolvedValue(undefined),
    });
    const sessionHandler = handler({
      resume: vi.fn(async (message, _sessionId, _ctx, token) => {
        if (message) token?.processingStarted(message);
        return {
          sessionId: "resumed-session",
          route: { kind: "owned" as const, mode: "queued" as const },
        };
      }),
    });
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-route-waits-for-debt";
    installSession(i, chatId, { handler: sessionHandler, status: "suspended" });
    i.routeTeardown.registerPendingTeardown(chatId, debtHandler);

    const dispatch = sm.dispatch(mockEntry({ id: 96, chatId, messageId: "msg-route-waits" }));
    await debtStopStarted;

    // The old handler's stop is unconfirmed — no new route may be created.
    await Promise.resolve();
    await Promise.resolve();
    expect(sessionHandler.resume).not.toHaveBeenCalled();
    expect(sessionHandler.start).not.toHaveBeenCalled();

    // The stop confirms: the admission fence lifts and the route is created.
    resolveDebtStop?.();
    await dispatch;
    expect(sessionHandler.resume).toHaveBeenCalledTimes(1);
    expect(i.routeTeardown.pendingTeardowns.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("keeps delivery custody when debt settle fails, and routes once it succeeds", async () => {
    const boom = new Error("debt stop failed");
    const debtHandler = handler({
      shutdown: vi.fn().mockRejectedValueOnce(boom).mockResolvedValue(undefined),
    });
    const sessionHandler = handler({
      resume: vi.fn().mockResolvedValue({
        sessionId: "resumed-session",
        route: { kind: "owned" as const, mode: "queued" as const },
      }),
    });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({ recoverChat });
    const i = internals(sm);
    const chatId = "chat-route-debt-fails";
    installSession(i, chatId, { handler: sessionHandler, status: "suspended" });
    i.routeTeardown.registerPendingTeardown(chatId, debtHandler);

    // Settle failure: no route is created, and the delivery keeps its
    // recovery custody instead of being dropped (dispatch surfaces the
    // fenced failure the same way as other route failures).
    await expect(sm.dispatch(mockEntry({ id: 98, chatId, messageId: "msg-route-debt-fails-1" }))).rejects.toThrow(
      /teardown debt settle failed/,
    );
    expect(sessionHandler.resume).not.toHaveBeenCalled();
    expect(sessionHandler.start).not.toHaveBeenCalled();
    expect(debtHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(i.routeTeardown.pendingTeardowns.get(chatId)?.has(debtHandler)).toBe(true);
    // Custody is preserved via the existing recovery semantics: the fenced
    // failure requests server recovery (the message is NOT acked/dropped).
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith(chatId));

    // Redelivery after recovery: the settle retry succeeds and the route is
    // finally created.
    await sm.dispatch(mockEntry({ id: 100, chatId, messageId: "msg-route-debt-fails-2" }));
    expect(sessionHandler.resume).toHaveBeenCalledTimes(1);
    expect(i.routeTeardown.pendingTeardowns.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("abandons a retry install when a terminate wins the debt-settle race", async () => {
    let signalDebtStopStarted: (() => void) | undefined;
    let resolveDebtStop: (() => void) | undefined;
    const debtStopStarted = new Promise<void>((resolve) => {
      signalDebtStopStarted = resolve;
    });
    const debtStopGate = new Promise<void>((resolve) => {
      resolveDebtStop = resolve;
    });
    const debtHandler = handler({
      shutdown: vi
        .fn()
        .mockImplementationOnce(async () => {
          signalDebtStopStarted?.();
          await debtStopGate;
        })
        .mockResolvedValue(undefined),
    });
    const freshHandler = handler();
    const sm = makeRuntime({ handlers: [freshHandler] });
    const i = internals(sm);
    const chatId = "chat-retry-vs-terminate";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        status: "suspended",
        retryAttempt: 1,
        retryHeadMessage: makeMessage(chatId),
      }),
    );
    i.routeTeardown.registerPendingTeardown(chatId, debtHandler);

    // The retry waits on the gated debt stop; the terminate joins the same
    // shutdown and must not ack while it is unconfirmed.
    const retry = i.slotScheduler.runRetry(chatId);
    await debtStopStarted;
    const terminate = sm.handleCommand(chatId, "session:terminate");
    let terminateSettled = false;
    void terminate.then(() => {
      terminateSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(terminateSettled).toBe(false);

    // The stop confirms: the retry's post-settle re-validation sees the
    // in-flight terminate and ABANDONS the install — no fresh handler, no
    // new route producer — and only then may the terminate ack.
    resolveDebtStop?.();
    await retry;
    await terminate;
    expect(freshHandler.start).not.toHaveBeenCalled();
    expect(freshHandler.resume).not.toHaveBeenCalled();
    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("installs the retry route after the debt settles when no terminate intervenes", async () => {
    const debtHandler = handler();
    const freshHandler = handler({
      resume: vi
        .fn()
        .mockResolvedValue({ sessionId: "retry-session", route: { kind: "owned" as const, mode: "queued" as const } }),
    });
    const sm = makeRuntime({ handlers: [freshHandler] });
    const i = internals(sm);
    const chatId = "chat-retry-after-debt-settle";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        status: "suspended",
        retryAttempt: 1,
        retryHeadMessage: makeMessage(chatId),
      }),
    );
    i.routeTeardown.registerPendingTeardown(chatId, debtHandler);

    await i.slotScheduler.runRetry(chatId);

    expect(freshHandler.resume).toHaveBeenCalledTimes(1);
    expect(debtHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(i.projection.sessions.get(chatId)?.handler).toBe(freshHandler);

    await sm.shutdown();
  });

  it("abandons a retry install when manager shutdown starts during the debt settle", async () => {
    let signalDebtStopStarted: (() => void) | undefined;
    let resolveDebtStop: (() => void) | undefined;
    const debtStopStarted = new Promise<void>((resolve) => {
      signalDebtStopStarted = resolve;
    });
    const debtStopGate = new Promise<void>((resolve) => {
      resolveDebtStop = resolve;
    });
    const debtHandler = handler({
      shutdown: vi
        .fn()
        .mockImplementationOnce(async () => {
          signalDebtStopStarted?.();
          await debtStopGate;
        })
        .mockResolvedValue(undefined),
    });
    const freshHandler = handler();
    const sm = makeRuntime({ handlers: [freshHandler] });
    const i = internals(sm);
    const chatId = "chat-retry-vs-shutdown";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        status: "suspended",
        retryAttempt: 1,
        retryHeadMessage: makeMessage(chatId),
      }),
    );
    i.routeTeardown.registerPendingTeardown(chatId, debtHandler);

    const retry = i.slotScheduler.runRetry(chatId);
    await debtStopStarted;

    // Manager shutdown starts while the retry waits on the debt stop: the
    // post-settle re-validation must abandon the install.
    const stopped = sm.shutdown();
    let stopSettled = false;
    void stopped.then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    resolveDebtStop?.();
    await retry;
    await stopped;
    expect(freshHandler.start).not.toHaveBeenCalled();
    expect(freshHandler.resume).not.toHaveBeenCalled();
  });

  it("quiesces a canceled route producer before admitting a fresh route, and force-keeps producer-only chats", async () => {
    let signalStartStarted: (() => void) | undefined;
    let resolveStart: (() => void) | undefined;
    const startStarted = new Promise<void>((resolve) => {
      signalStartStarted = resolve;
    });
    const startGate = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    const canceledHandler = handler({
      start: vi.fn().mockImplementation(async () => {
        signalStartStarted?.();
        await startGate;
        return { sessionId: "stale-canceled-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
    });
    const freshHandler = handler({
      start: vi.fn().mockResolvedValue({
        sessionId: "fresh-route-session",
        route: { kind: "owned" as const, mode: "queued" as const },
      }),
    });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({ handlers: [canceledHandler, freshHandler], recoverChat });
    const i = internals(sm);
    const chatId = "chat-quiesce-before-route";

    const headDispatch = sm.dispatch(mockEntry({ id: 110, chatId, messageId: "msg-quiesce-head" }));
    await startStarted;

    // Pause cancels the start; the boundary stop succeeds and the entry is
    // dropped — the chat is producer-only now (no entry, no debt), and must
    // still be held / force-kept or the reconcile channel breaks.
    await sm.handleCommand(chatId, "session:suspend");
    await vi.waitFor(() => expect(i.projection.sessions.has(chatId)).toBe(false));
    expect(i.routeTeardown.pendingTeardowns.has(chatId)).toBe(false);
    expect(sm.getHeldChatIds(new Set())).toContain(chatId);

    // The next delivery drives the server-side recovery; the redelivery
    // after it must NOT start a fresh route while the canceled producer is
    // still in flight.
    await sm.dispatch(mockEntry({ id: 111, chatId, messageId: "msg-quiesce-recovery" }));
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith(chatId));
    await vi.waitFor(() => expect(i.inboxDelivery.snapshot(chatId).recoveryDebt).toBe("none"));
    const redelivery = sm.dispatch(mockEntry({ id: 112, chatId, messageId: "msg-quiesce-tail" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(freshHandler.start).not.toHaveBeenCalled();
    expect(freshHandler.resume).not.toHaveBeenCalled();

    // The producer settles (stale completion → discard → strict afterPrior
    // stop), and only then is the fresh route admitted.
    resolveStart?.();
    await redelivery;
    expect(freshHandler.start).toHaveBeenCalledTimes(1);
    expect(canceledHandler.shutdown).toHaveBeenCalledTimes(2);
    expect(i.routeTeardown.routeProducers.has(chatId)).toBe(false);

    await headDispatch;
    await sm.shutdown();
  });

  it("serializes concurrent same-chat resumes to exactly one provider resume", async () => {
    let signalDebtStopStarted: (() => void) | undefined;
    let resolveDebtStop: (() => void) | undefined;
    const debtStopStarted = new Promise<void>((resolve) => {
      signalDebtStopStarted = resolve;
    });
    const debtStopGate = new Promise<void>((resolve) => {
      resolveDebtStop = resolve;
    });
    const debtHandler = handler({
      shutdown: vi
        .fn()
        .mockImplementationOnce(async () => {
          signalDebtStopStarted?.();
          await debtStopGate;
        })
        .mockResolvedValue(undefined),
    });
    const sessionHandler = handler({
      resume: vi.fn().mockResolvedValue({
        sessionId: "resumed-session",
        route: { kind: "owned" as const, mode: "queued" as const },
      }),
    });
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-concurrent-resumes";
    installSession(i, chatId, { handler: sessionHandler, status: "suspended" });
    i.routeTeardown.registerPendingTeardown(chatId, debtHandler);

    // Both dispatches reach resumeSession and wait on the same gated debt
    // stop. After it confirms, exactly ONE waiter may install the route.
    const first = sm.dispatch(mockEntry({ id: 112, chatId, messageId: "msg-resume-a" }));
    const second = sm.dispatch(mockEntry({ id: 113, chatId, messageId: "msg-resume-b" }));
    await debtStopStarted;
    await Promise.resolve();
    await Promise.resolve();
    expect(sessionHandler.resume).not.toHaveBeenCalled();

    resolveDebtStop?.();
    await first;
    await second;

    // Exactly one provider resume; the loser's message was deferred onto the
    // winning route (custody) and injected after adoption.
    expect(sessionHandler.resume).toHaveBeenCalledTimes(1);
    expect(sessionHandler.inject).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("runs exactly one provider start for two concurrent dispatches over a gated debt", async () => {
    let signalDebtStopStarted: (() => void) | undefined;
    let resolveDebtStop: (() => void) | undefined;
    const debtStopStarted = new Promise<void>((resolve) => {
      signalDebtStopStarted = resolve;
    });
    const debtStopGate = new Promise<void>((resolve) => {
      resolveDebtStop = resolve;
    });
    const debtHandler = handler({
      shutdown: vi
        .fn()
        .mockImplementationOnce(async () => {
          signalDebtStopStarted?.();
          await debtStopGate;
        })
        .mockResolvedValue(undefined),
    });
    const freshHandler = handler({
      start: vi.fn().mockResolvedValue({
        sessionId: "started-session",
        route: { kind: "owned" as const, mode: "queued" as const },
      }),
    });
    const sm = makeRuntime({ handlers: [freshHandler] });
    const i = internals(sm);
    const chatId = "chat-concurrent-starts";
    i.routeTeardown.registerPendingTeardown(chatId, debtHandler);

    // Two real concurrent dispatches for the same entry-less chat: both
    // starts wait on the same gated debt stop.
    const first = sm.dispatch(mockEntry({ id: 114, chatId, messageId: "msg-start-a" }));
    const second = sm.dispatch(mockEntry({ id: 115, chatId, messageId: "msg-start-b" }));
    await debtStopStarted;
    await Promise.resolve();
    await Promise.resolve();
    expect(freshHandler.start).not.toHaveBeenCalled();

    resolveDebtStop?.();
    await first;
    await second;

    // Exactly one provider start; the loser's message followed the fresh
    // selection (defer/inject) exactly once — custody preserved.
    expect(freshHandler.start).toHaveBeenCalledTimes(1);
    expect(freshHandler.inject).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("confirms the replaced handler stopped before installing a retry route", async () => {
    const boom = new Error("replace stop failed");
    let signalReplaceStopStarted: (() => void) | undefined;
    let rejectReplaceStop: ((err: unknown) => void) | undefined;
    const replaceStopStarted = new Promise<void>((resolve) => {
      signalReplaceStopStarted = resolve;
    });
    const replaceStopGate = new Promise<void>((_resolve, reject) => {
      rejectReplaceStop = reject;
    });
    const oldHandler = handler({
      shutdown: vi
        .fn()
        .mockImplementationOnce(async () => {
          signalReplaceStopStarted?.();
          await replaceStopGate;
        })
        .mockResolvedValue(undefined),
    });
    const freshHandler = handler({
      resume: vi.fn().mockResolvedValue({
        sessionId: "retry-route-session",
        route: { kind: "owned" as const, mode: "queued" as const },
      }),
    });
    const sm = makeRuntime({ handlers: [freshHandler] });
    const i = internals(sm);
    const chatId = "chat-retry-replace-stop";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: oldHandler,
        status: "suspended",
        retryAttempt: 1,
        retryHeadMessage: makeMessage(chatId),
      }),
    );

    // The replacement stop is gated: the fresh handler must NOT be installed
    // while the old one's stop is unconfirmed.
    const firstAttempt = i.slotScheduler.runRetry(chatId);
    await replaceStopStarted;
    await Promise.resolve();
    expect(i.projection.sessions.get(chatId)?.handler).toBe(oldHandler);
    expect(freshHandler.resume).not.toHaveBeenCalled();

    // Stop failure: the retry keeps custody — debt registered, timer
    // re-armed, nothing installed.
    rejectReplaceStop?.(boom);
    await firstAttempt;
    expect(i.routeTeardown.pendingTeardowns.get(chatId)?.has(oldHandler)).toBe(true);
    expect(i.slotScheduler.hasArmedRetryTimer(requireSession(i, chatId))).toBe(true);
    expect(freshHandler.resume).not.toHaveBeenCalled();

    // Next attempt: the stop confirms and the retry route installs.
    const entry = i.projection.sessions.get(chatId);
    if (entry) i.slotScheduler.cancelRetryTimer(entry);
    await i.slotScheduler.runRetry(chatId);
    expect(freshHandler.resume).toHaveBeenCalledTimes(1);
    expect(i.projection.sessions.get(chatId)?.handler).toBe(freshHandler);

    await sm.shutdown();
  });

  it("registers the retry replacement stop as debt before it starts, so terminate must join it", async () => {
    let signalReplaceStopStarted: (() => void) | undefined;
    let resolveReplaceStop: (() => void) | undefined;
    const replaceStopStarted = new Promise<void>((resolve) => {
      signalReplaceStopStarted = resolve;
    });
    const replaceStopGate = new Promise<void>((resolve) => {
      resolveReplaceStop = resolve;
    });
    const oldHandler = handler({
      shutdown: vi
        .fn()
        .mockImplementationOnce(async () => {
          signalReplaceStopStarted?.();
          await replaceStopGate;
        })
        .mockResolvedValue(undefined),
    });
    const freshHandler = handler();
    const sm = makeRuntime({ handlers: [freshHandler] });
    const i = internals(sm);
    const chatId = "chat-retry-stop-debt-first";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: oldHandler,
        status: "suspended",
        retryAttempt: 1,
        retryHeadMessage: makeMessage(chatId),
      }),
    );

    const retry = i.slotScheduler.runRetry(chatId);
    await replaceStopStarted;
    // The stop was registered as debt BEFORE it started — while it is gated
    // the entry is slot-free, but the terminate must still join the debt
    // instead of acking over an unsettled stop.
    expect(i.routeTeardown.pendingTeardowns.get(chatId)?.has(oldHandler)).toBe(true);

    const terminate = sm.handleCommand(chatId, "session:terminate");
    let terminateSettled = false;
    void terminate.then(() => {
      terminateSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(terminateSettled).toBe(false);

    resolveReplaceStop?.();
    await retry;
    await terminate;
    expect(oldHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(freshHandler.resume).not.toHaveBeenCalled();
    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(i.routeTeardown.pendingTeardowns.has(chatId)).toBe(false);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("abandons a stale retry after attachment rematerialization if terminate already finished", async () => {
    const imageId = "11111111-1111-4111-8111-111111111111";
    const home = mkdtempSync(join(tmpdir(), "ft-retry-terminate-fetch-"));
    vi.stubEnv("FIRST_TREE_HOME", home);
    let signalFetchStarted: (() => void) | undefined;
    let releaseFetch: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      signalFetchStarted = resolve;
    });
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchAttachment = vi.fn(async () => {
      signalFetchStarted?.();
      await fetchGate;
      return { bytes: Buffer.from("png bytes") };
    });
    const oldHandler = handler();
    const freshHandler = handler();
    const sdk = { ...mockSdk(), fetchAttachment } as unknown as FirstTreeHubSDK;
    const sm = makeRuntime({ handlers: [freshHandler], sdk });
    const i = internals(sm);
    const chatId = "chat-retry-fetch-vs-terminate";
    try {
      bindSeededSession(
        i,
        makeSessionRecord(chatId, {
          handler: oldHandler,
          status: "suspended",
          retryAttempt: 1,
          retryHeadMessage: {
            ...makeMessage(chatId),
            format: "file",
            content: { imageId, mimeType: "image/png", filename: "one.png" },
          },
        }),
      );

      const retry = i.slotScheduler.runRetry(chatId);
      await fetchStarted;
      expect(fetchAttachment).toHaveBeenCalledWith({ id: imageId });
      expect(i.routeTeardown.pendingTeardowns.has(chatId)).toBe(false);

      await sm.handleCommand(chatId, "session:terminate");
      expect(i.projection.sessions.has(chatId)).toBe(false);
      expect(i.routeTeardown.pendingTeardowns.has(chatId)).toBe(false);
      expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);
      expect(oldHandler.shutdown).toHaveBeenCalledTimes(0);

      releaseFetch?.();
      await retry;

      expect(i.projection.sessions.has(chatId)).toBe(false);
      expect(i.routeTeardown.pendingTeardowns.has(chatId)).toBe(false);
      expect(oldHandler.shutdown).toHaveBeenCalledTimes(0);
      expect(freshHandler.start).not.toHaveBeenCalled();
      expect(freshHandler.resume).not.toHaveBeenCalled();
    } finally {
      await sm.shutdown();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("manager shutdown waits for a gated retry replacement stop", async () => {
    let signalReplaceStopStarted: (() => void) | undefined;
    let resolveReplaceStop: (() => void) | undefined;
    const replaceStopStarted = new Promise<void>((resolve) => {
      signalReplaceStopStarted = resolve;
    });
    const replaceStopGate = new Promise<void>((resolve) => {
      resolveReplaceStop = resolve;
    });
    const oldHandler = handler({
      shutdown: vi
        .fn()
        .mockImplementationOnce(async () => {
          signalReplaceStopStarted?.();
          await replaceStopGate;
        })
        .mockResolvedValue(undefined),
    });
    const freshHandler = handler();
    const sm = makeRuntime({ handlers: [freshHandler] });
    const i = internals(sm);
    const chatId = "chat-shutdown-retry-stop";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: oldHandler,
        status: "suspended",
        retryAttempt: 1,
        retryHeadMessage: makeMessage(chatId),
      }),
    );

    const retry = i.slotScheduler.runRetry(chatId);
    await replaceStopStarted;

    const stopped = sm.shutdown();
    let stopSettled = false;
    void stopped.then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    resolveReplaceStop?.();
    await retry;
    await stopped;
    // Joined, not duplicated; the retry abandoned the install once manager
    // shutdown began.
    expect(oldHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(freshHandler.resume).not.toHaveBeenCalled();
    expect(freshHandler.start).not.toHaveBeenCalled();
  });

  it("coalesces a timer-fired retry and a same-chat dispatch into one replacement route", async () => {
    let signalReplaceStopStarted: (() => void) | undefined;
    let resolveReplaceStop: (() => void) | undefined;
    const replaceStopStarted = new Promise<void>((resolve) => {
      signalReplaceStopStarted = resolve;
    });
    const replaceStopGate = new Promise<void>((resolve) => {
      resolveReplaceStop = resolve;
    });
    const oldHandler = handler({
      shutdown: vi
        .fn()
        .mockImplementationOnce(async () => {
          signalReplaceStopStarted?.();
          await replaceStopGate;
        })
        .mockResolvedValue(undefined),
    });
    const freshHandler = handler({
      resume: vi.fn().mockResolvedValue({
        sessionId: "retry-route-session",
        route: { kind: "owned" as const, mode: "queued" as const },
      }),
    });
    const sm = makeRuntime({ handlers: [freshHandler] });
    const i = internals(sm);
    const chatId = "chat-overlapping-retries";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: oldHandler,
        status: "suspended",
        retryAttempt: 1,
        retryHeadMessage: makeMessage(chatId),
      }),
    );
    const entry = i.projection.sessions.get(chatId);
    if (!entry) throw new Error("entry missing");

    // The scheduled retry timer fires first: it clears its handle and starts
    // the first retry execution.
    i.slotScheduler.cancelRetryTimer(entry);
    i.slotScheduler.scheduleTransientRetry(entry, {
      attemptedMessage: makeMessage(chatId),
      attempt: 1,
      reasonCode: "unknown",
      category: "unknown",
      scope: "session_start",
      rawError: null,
      delayMs: 0,
    });
    await replaceStopStarted;

    // A same-chat delivery triggers the immediate retry, which must JOIN the
    // in-flight execution instead of running a second one.
    const delivery = sm.dispatch(mockEntry({ id: 122, chatId, messageId: "msg-retry-tail" }));
    await vi.waitFor(() => expect(i.slotScheduler.deferredMessageSnapshot(entry)).toHaveLength(1));
    expect(freshHandler.resume).not.toHaveBeenCalled();

    resolveReplaceStop?.();
    await delivery;

    // Exactly one replacement handler install / one provider route, and the
    // delivered message was deferred once and injected once (custody kept).
    await vi.waitFor(() => expect(freshHandler.resume).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(freshHandler.inject).toHaveBeenCalledTimes(1));

    await sm.shutdown();
  });

  it("arms exactly one re-arm timer when the replacement stop fails across overlapping triggers", async () => {
    vi.useFakeTimers();
    const boom = new Error("replace stop failed");
    let signalReplaceStopStarted: (() => void) | undefined;
    let rejectReplaceStop: ((err: unknown) => void) | undefined;
    const replaceStopStarted = new Promise<void>((resolve) => {
      signalReplaceStopStarted = resolve;
    });
    const replaceStopGate = new Promise<void>((_resolve, reject) => {
      rejectReplaceStop = reject;
    });
    const oldHandler = handler({
      shutdown: vi.fn().mockImplementation(async () => {
        signalReplaceStopStarted?.();
        await replaceStopGate;
      }),
    });
    const freshHandler = handler();
    const sm = makeRuntime({ handlers: [freshHandler] });
    const i = internals(sm);
    const chatId = "chat-single-rearm";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: oldHandler,
        status: "suspended",
        retryAttempt: 1,
        retryHeadMessage: makeMessage(chatId),
      }),
    );
    const entry = i.projection.sessions.get(chatId);
    if (!entry) throw new Error("entry missing");
    const retrySpy = vi.spyOn(internals(sm).slotScheduler, "runRetry");

    // Timer fires the first execution; the same-chat dispatch triggers the
    // immediate retry — it joins the single flight instead of running one.
    i.slotScheduler.cancelRetryTimer(entry);
    i.slotScheduler.scheduleTransientRetry(entry, {
      attemptedMessage: makeMessage(chatId),
      attempt: 1,
      reasonCode: "unknown",
      category: "unknown",
      scope: "session_start",
      rawError: null,
      delayMs: 0,
    });
    await vi.advanceTimersByTimeAsync(0);
    await replaceStopStarted;
    const delivery = sm.dispatch(mockEntry({ id: 123, chatId, messageId: "msg-single-rearm-tail" }));

    rejectReplaceStop?.(boom);
    await delivery;
    const retryRun = retrySpy.mock.results[0]?.value;
    if (retryRun) await retryRun;

    // Exactly ONE re-arm handle exists (the single-flight failure path ran
    // once), and manager shutdown clears it — no duplicate retry callback
    // survives.
    expect(i.slotScheduler.hasArmedRetryTimer(entry)).toBe(true);
    await sm.shutdown();
    retrySpy.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(retrySpy).not.toHaveBeenCalled();
  });

  it("rejects the terminate when a joined retry replacement stop fails, then converges on retry", async () => {
    const boom = new Error("replace stop failed");
    let signalReplaceStopStarted: (() => void) | undefined;
    let rejectReplaceStop: ((err: unknown) => void) | undefined;
    const replaceStopStarted = new Promise<void>((resolve) => {
      signalReplaceStopStarted = resolve;
    });
    const replaceStopGate = new Promise<void>((_resolve, reject) => {
      rejectReplaceStop = reject;
    });
    const oldHandler = handler({
      shutdown: vi
        .fn()
        .mockImplementationOnce(async () => {
          signalReplaceStopStarted?.();
          await replaceStopGate;
        })
        .mockResolvedValue(undefined),
    });
    const freshHandler = handler();
    const sm = makeRuntime({ handlers: [freshHandler] });
    const i = internals(sm);
    const chatId = "chat-terminate-retry-stop-fails";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: oldHandler,
        status: "suspended",
        retryAttempt: 1,
        retryHeadMessage: makeMessage(chatId),
      }),
    );
    const entry = i.projection.sessions.get(chatId);
    if (!entry) throw new Error("entry missing");

    const retry = i.slotScheduler.runRetry(chatId);
    await replaceStopStarted;
    const terminate = sm.handleCommand(chatId, "session:terminate");

    // The joined replacement stop fails: the terminate must reject
    // (agent-slot maps this to applied:false), and the session + debt stay
    // retryable.
    rejectReplaceStop?.(boom);
    await expect(terminate).rejects.toBe(boom);
    await retry;
    expect(i.routeTeardown.pendingTeardowns.get(chatId)?.has(oldHandler)).toBe(true);
    expect(i.projection.sessions.has(chatId)).toBe(true);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    // No late re-arm: the terminate's in-flight window canceled the retry
    // timer, and the failed stop's failure path must not resurrect one —
    // nothing may install a provider route before the operator retries.
    expect(i.slotScheduler.hasArmedRetryTimer(entry)).toBe(false);
    expect(freshHandler.resume).not.toHaveBeenCalled();
    expect(freshHandler.start).not.toHaveBeenCalled();

    // The operator's retry path still works: the next terminate re-attempts
    // the strict stop and converges.
    await sm.handleCommand(chatId, "session:terminate");
    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(i.routeTeardown.pendingTeardowns.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("does not re-arm after manager shutdown begins when the replacement stop fails late", async () => {
    vi.useFakeTimers();
    const boom = new Error("replace stop failed");
    let signalStopStarted: (() => void) | undefined;
    let rejectStop: ((err: unknown) => void) | undefined;
    const stopStarted = new Promise<void>((resolve) => {
      signalStopStarted = resolve;
    });
    const stopGate = new Promise<void>((_resolve, reject) => {
      rejectStop = reject;
    });
    const oldHandler = handler({
      shutdown: vi
        .fn()
        .mockImplementationOnce(async () => {
          signalStopStarted?.();
          await stopGate;
        })
        .mockResolvedValue(undefined),
    });
    const freshHandler = handler();
    const sm = makeRuntime({ handlers: [freshHandler] });
    const i = internals(sm);
    const chatId = "chat-shutdown-late-rearm";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: oldHandler,
        status: "suspended",
        retryAttempt: 1,
        retryHeadMessage: makeMessage(chatId),
      }),
    );
    const entry = i.projection.sessions.get(chatId);
    if (!entry) throw new Error("entry missing");
    const retrySpy = vi.spyOn(internals(sm).slotScheduler, "runRetry");

    const retry = i.slotScheduler.runRetry(chatId);
    await stopStarted;
    // Shutdown begins while the replacement stop is gated: its timer sweep
    // runs BEFORE the stop fails — a fail-open re-arm would survive it.
    const stopped = sm.shutdown();
    rejectStop?.(boom);
    await retry;
    await stopped;

    // Fail closed: the failure path must not create a timer once manager
    // shutdown has begun — no re-arm handle exists and nothing fires after
    // shutdown returned.
    expect(i.slotScheduler.hasArmedRetryTimer(entry)).toBe(false);
    expect(freshHandler.resume).not.toHaveBeenCalled();
    expect(freshHandler.start).not.toHaveBeenCalled();
    retrySpy.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(retrySpy).not.toHaveBeenCalled();
  });

  it("manager shutdown does not return before its bounded follow-up attempt settles", async () => {
    const boom = new Error("replace stop failed");
    let signalFirstStopStarted: (() => void) | undefined;
    let rejectFirstStop: ((err: unknown) => void) | undefined;
    const firstStopStarted = new Promise<void>((resolve) => {
      signalFirstStopStarted = resolve;
    });
    const firstStopGate = new Promise<void>((_resolve, reject) => {
      rejectFirstStop = reject;
    });
    let signalSecondStopStarted: (() => void) | undefined;
    let resolveSecondStop: (() => void) | undefined;
    const secondStopStarted = new Promise<void>((resolve) => {
      signalSecondStopStarted = resolve;
    });
    const secondStopGate = new Promise<void>((resolve) => {
      resolveSecondStop = resolve;
    });
    const oldHandler = handler({
      shutdown: vi
        .fn()
        .mockImplementationOnce(async () => {
          signalFirstStopStarted?.();
          await firstStopGate;
        })
        .mockImplementationOnce(async () => {
          signalSecondStopStarted?.();
          await secondStopGate;
        })
        .mockResolvedValue(undefined),
    });
    const freshHandler = handler();
    const sm = makeRuntime({ handlers: [freshHandler] });
    const i = internals(sm);
    const chatId = "chat-shutdown-bounded-followup";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: oldHandler,
        status: "suspended",
        retryAttempt: 1,
        retryHeadMessage: makeMessage(chatId),
      }),
    );

    const retry = i.slotScheduler.runRetry(chatId);
    await firstStopStarted;
    const stopped = sm.shutdown();

    // The sweep joins the failing replacement stop; the bounded follow-up
    // attempt starts a FRESH shutdown — shutdown must not return before
    // that attempt settles.
    rejectFirstStop?.(boom);
    await secondStopStarted;
    let stopSettled = false;
    void stopped.then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    resolveSecondStop?.();
    await stopped;
    await retry;
    expect(oldHandler.shutdown).toHaveBeenCalledTimes(2);
    expect(i.routeTeardown.pendingTeardowns.has(chatId)).toBe(false);
  });

  it("caps concurrent replacement installs at the configured concurrency across chats", async () => {
    let signalStopA: (() => void) | undefined;
    let resolveStopA: (() => void) | undefined;
    let signalStopB: (() => void) | undefined;
    let resolveStopB: (() => void) | undefined;
    const stopStartedA = new Promise<void>((resolve) => {
      signalStopA = resolve;
    });
    const stopStartedB = new Promise<void>((resolve) => {
      signalStopB = resolve;
    });
    const stopGateA = new Promise<void>((resolve) => {
      resolveStopA = resolve;
    });
    const stopGateB = new Promise<void>((resolve) => {
      resolveStopB = resolve;
    });
    const oldHandlerA = handler({
      shutdown: vi.fn().mockImplementation(async () => {
        signalStopA?.();
        await stopGateA;
      }),
    });
    const oldHandlerB = handler({
      shutdown: vi.fn().mockImplementation(async () => {
        signalStopB?.();
        await stopGateB;
      }),
    });
    const freshA = handler({
      resume: vi
        .fn()
        .mockResolvedValue({ sessionId: "session-a", route: { kind: "owned" as const, mode: "queued" as const } }),
    });
    const freshB = handler({
      resume: vi
        .fn()
        .mockResolvedValue({ sessionId: "session-b", route: { kind: "owned" as const, mode: "queued" as const } }),
    });
    const sm = makeRuntime({ handlers: [freshA, freshB], concurrency: 1 });
    const i = internals(sm);
    const entryA = makeSessionRecord("chat-cap-a", {
      handler: oldHandlerA,
      status: "suspended",
      retryAttempt: 1,
      retryHeadMessage: makeMessage("chat-cap-a"),
    });
    const entryB = makeSessionRecord("chat-cap-b", {
      handler: oldHandlerB,
      status: "suspended",
      retryAttempt: 1,
      retryHeadMessage: makeMessage("chat-cap-b"),
    });
    bindSeededSession(i, entryA);
    bindSeededSession(i, entryB);
    // Give chat A owned processing work so its (winning) session cannot be
    // preempted by the loser's acquire — the loser must re-arm instead.
    const ownedEntry = mockEntry({ id: 131, chatId: entryA.chatId, messageId: "msg-cap-a-owned" });
    i.inboxDelivery.receive(ownedEntry);
    i.inboxDelivery.markOwned({ chatId: entryA.chatId, entryId: ownedEntry.id, messageId: ownedEntry.message.id });
    i.inboxDelivery.markProcessingStarted(entryA.chatId, messageFromEntry(ownedEntry));

    // Both retries wait on their own replacement stop; the capacity check
    // now happens AFTER the stop + CAS, so they cannot both pass it.
    const retryA = i.slotScheduler.runRetry(entryA.chatId);
    const retryB = i.slotScheduler.runRetry(entryB.chatId);
    await Promise.all([stopStartedA, stopStartedB]);
    expect(sm.activeCount).toBe(0);

    resolveStopA?.();
    resolveStopB?.();
    await retryA;
    await retryB;

    // Invariant: at most one slot held, exactly one provider route live.
    expect(sm.activeCount).toBe(1);
    expect(freshA.resume).toHaveBeenCalledTimes(1);
    expect(freshB.resume).not.toHaveBeenCalled();
    expect(freshB.start).not.toHaveBeenCalled();
    // The loser keeps retry custody: still in transient-retry, timer armed.
    expect(i.slotScheduler.currentRetryAttempt(entryB)).toBe(1);
    expect(i.slotScheduler.hasArmedRetryTimer(entryB)).toBe(true);
    i.slotScheduler.cancelRetryTimer(entryB);
    await sm.shutdown();
  });

  it("does not install over capacity when another route takes the slot during the replacement stop", async () => {
    let signalStopStarted: (() => void) | undefined;
    let resolveStop: (() => void) | undefined;
    const stopStarted = new Promise<void>((resolve) => {
      signalStopStarted = resolve;
    });
    const stopGate = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    const oldHandler = handler({
      shutdown: vi.fn().mockImplementation(async () => {
        signalStopStarted?.();
        await stopGate;
      }),
    });
    const freshA = handler();
    const handlerC = handler({
      start: vi
        .fn()
        .mockResolvedValue({ sessionId: "c-session", route: { kind: "owned" as const, mode: "queued" as const } }),
    });
    const sm = makeRuntime({ handlers: [handlerC, freshA], concurrency: 1 });
    const i = internals(sm);
    const chatId = "chat-freed-slot-retry";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: oldHandler,
        status: "suspended",
        retryAttempt: 1,
        retryHeadMessage: makeMessage(chatId),
      }),
    );
    const entry = i.projection.sessions.get(chatId);
    if (!entry) throw new Error("entry missing");

    const retry = i.slotScheduler.runRetry(chatId);
    await stopStarted;

    // While the replacement stop is gated, another route takes the freed
    // slot — and holds owned processing work so it cannot be preempted.
    const cEntry = mockEntry({ id: 140, chatId: "chat-freed-slot-c", messageId: "msg-c" });
    await sm.dispatch(cEntry);
    expect(handlerC.start).toHaveBeenCalledTimes(1);
    expect(sm.activeCount).toBe(1);
    i.inboxDelivery.markOwned({ chatId: "chat-freed-slot-c", entryId: cEntry.id, messageId: cEntry.message.id });
    i.inboxDelivery.markProcessingStarted("chat-freed-slot-c", messageFromEntry(cEntry));

    // The stop settles: the retry must NOT install over capacity — it keeps
    // custody via re-arm (not abandon).
    resolveStop?.();
    await retry;
    expect(freshA.start).not.toHaveBeenCalled();
    expect(freshA.resume).not.toHaveBeenCalled();
    expect(sm.activeCount).toBe(1);
    expect(i.slotScheduler.currentRetryAttempt(entry)).toBe(1);
    expect(i.slotScheduler.hasArmedRetryTimer(entry)).toBe(true);
    i.slotScheduler.cancelRetryTimer(entry);
    await sm.shutdown();
  });

  it("never leaves an unsettled route producer when the route fails", async () => {
    const failingHandler = handler({
      start: vi.fn().mockRejectedValue(new Error("provider start failed")),
    });
    const sm = makeRuntime({ handlers: [failingHandler] });
    const i = internals(sm);
    const chatId = "chat-producer-settles-on-failure";

    await sm.dispatch(mockEntry({ id: 115, chatId, messageId: "msg-producer-failure" }));

    // The route failed, but the producer settled through the finally — no
    // quiesce can ever wait on this chat forever, and the failure followed
    // the existing classification path.
    expect(i.routeTeardown.routeProducers.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("manager shutdown bounded-retries a late afterPrior stop failure before returning", async () => {
    const boom = new Error("late stop failed");
    let signalStartStarted: (() => void) | undefined;
    let resolveStart: (() => void) | undefined;
    const startStarted = new Promise<void>((resolve) => {
      signalStartStarted = resolve;
    });
    const startGate = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    let signalLateStopStarted: (() => void) | undefined;
    let rejectLateStop: ((err: unknown) => void) | undefined;
    const lateStopStarted = new Promise<void>((resolve) => {
      signalLateStopStarted = resolve;
    });
    const lateStopGate = new Promise<void>((_resolve, reject) => {
      rejectLateStop = reject;
    });
    const pendingHandler = handler({
      start: vi.fn().mockImplementation(async () => {
        signalStartStarted?.();
        await startGate;
        return { sessionId: "stale-session", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
      shutdown: vi
        .fn()
        // First call: the suspend boundary's pre-materialization stop.
        .mockResolvedValueOnce(undefined)
        // Second call: the discard's afterPrior stop — fails late.
        .mockImplementationOnce(async () => {
          signalLateStopStarted?.();
          await lateStopGate;
        })
        // Third call: the bounded best-effort retry — succeeds.
        .mockResolvedValue(undefined),
    });
    const sm = makeRuntime({ handlers: [pendingHandler] });
    const i = internals(sm);
    const chatId = "chat-shutdown-late-stop-retry";

    const dispatch = sm.dispatch(mockEntry({ id: 116, chatId, messageId: "msg-late-stop-retry" }));
    await startStarted;

    await sm.handleCommand(chatId, "session:suspend");
    await vi.waitFor(() => expect(i.projection.sessions.has(chatId)).toBe(false));

    const stopped = sm.shutdown();
    let stopSettled = false;
    void stopped.then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    // The start materializes late during shutdown; its afterPrior stop
    // fails, and shutdown must not return while the debt is unconfirmed.
    resolveStart?.();
    await lateStopStarted;
    expect(stopSettled).toBe(false);

    rejectLateStop?.(boom);
    await stopped;

    // Bounded: exactly one best-effort retry (3 stops total), then shutdown
    // returns with the debt cleared — the last owner did not drop it.
    expect(pendingHandler.shutdown).toHaveBeenCalledTimes(3);
    expect(i.routeTeardown.pendingTeardowns.has(chatId)).toBe(false);

    await dispatch;
  });

  it("durably deletes the disk mapping on Reset after a terminal resume failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-reset-terminal-401-"));
    const registryPath = join(dir, "sessions.json");
    const chatId = "chat-reset-terminal-401";
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        entries: {
          [chatId]: {
            claudeSessionId: "old-provider-thread",
            lastActivity: new Date(1_000).toISOString(),
            status: "suspended",
          },
        },
      }),
      "utf-8",
    );
    const resumedHandler = handler({
      resume: vi.fn().mockRejectedValue({ name: "ClientUserMismatchError", message: "401 unauthorized" }),
    });
    const sm = makeRuntime({ handlers: [resumedHandler], registryPath });
    const i = internals(sm);
    expect(sm.getEvictedChatIds()).toContain(chatId);

    // Production path: dispatch drives the evicted resume, which fails
    // terminally (provider 401) — terminal cleanup deletes the entry but
    // leaves memory with no session and no evicted mapping.
    await sm.dispatch(mockEntry({ id: 150, chatId, messageId: "msg-terminal-401" }));
    await vi.waitFor(() => expect(i.projection.sessions.has(chatId)).toBe(false));
    expect(i.projection.evictedMappings.has(chatId)).toBe(false);

    // The debounced write may not have landed: the disk still shows the old
    // thread when the Reset arrives (memory is empty). Even so, the
    // terminate must durably flush BEFORE it resolves.
    await sm.handleCommand(chatId, "session:terminate");
    const persisted = JSON.parse(readFileSync(registryPath, "utf-8")) as { entries: Record<string, unknown> };
    expect(persisted.entries).toEqual({});

    // A fresh manager over the same file reloads nothing, and the next real
    // dispatch starts a FRESH provider thread — no resume of the old one.
    const freshHandler = handler({
      start: vi
        .fn()
        .mockResolvedValue({ sessionId: "fresh-thread", route: { kind: "owned" as const, mode: "queued" as const } }),
    });
    const reloaded = makeRuntime({ handlers: [freshHandler], registryPath });
    expect(reloaded.getEvictedChatIds()).toEqual([]);
    await reloaded.dispatch(mockEntry({ id: 151, chatId, messageId: "msg-after-reset" }));
    expect(freshHandler.start).toHaveBeenCalledTimes(1);
    expect(freshHandler.resume).not.toHaveBeenCalled();
    expect(resumedHandler.resume).toHaveBeenCalledTimes(1);

    await sm.shutdown();
    await reloaded.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a no-work terminate when the durable flush fails and converges on retry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-reset-nowork-flush-"));
    const registryPath = join(dir, "sessions.json");
    const chatId = "chat-reset-nowork-flush";
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        entries: {
          [chatId]: {
            claudeSessionId: "old-provider-thread",
            lastActivity: new Date(1_000).toISOString(),
            status: "suspended",
          },
        },
      }),
      "utf-8",
    );
    const sm = makeRuntime({ registryPath });
    const i = internals(sm);
    // Simulate the QA state: the mapping exists ONLY on disk (memory empty).
    i.projection.evictedMappings.delete(chatId);

    const boom = new Error("disk full");
    vi.spyOn(SessionRegistry.prototype, "flushOrThrow").mockImplementationOnce(() => {
      throw boom;
    });

    // No session/mapping/work/debt/producer in memory — the no-work path
    // must still flush, and its failure must reject (agent-slot: applied:false).
    await expect(sm.handleCommand(chatId, "session:terminate")).rejects.toBe(boom);
    const persistedBeforeRetry = JSON.parse(readFileSync(registryPath, "utf-8")) as {
      entries: Record<string, unknown>;
    };
    expect(Object.keys(persistedBeforeRetry.entries)).toContain(chatId);
    expect(i.resetReplay.terminatePersistFailures.has(chatId)).toBe(true);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    // Retry: the flush succeeds, the disk deletion is durable, and a reload
    // does not resurrect the mapping.
    await sm.handleCommand(chatId, "session:terminate");
    const persistedAfterRetry = JSON.parse(readFileSync(registryPath, "utf-8")) as {
      entries: Record<string, unknown>;
    };
    expect(persistedAfterRetry.entries).toEqual({});
    const reloaded = makeRuntime({ registryPath });
    expect(reloaded.getEvictedChatIds()).toEqual([]);

    await sm.shutdown();
    await reloaded.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("preserves other chats on Reset and cancels the pending debounced snapshot", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "ft-reset-debounce-"));
    const registryPath = join(dir, "sessions.json");
    const chatReset = "chat-reset-debounce";
    const chatKeep = "chat-keep-debounce";
    const writeEntries = (entries: Record<string, string>) =>
      writeFileSync(
        registryPath,
        JSON.stringify({
          version: 1,
          entries: Object.fromEntries(
            Object.entries(entries).map(([id, claudeSessionId]) => [
              id,
              { claudeSessionId, lastActivity: new Date(1_000).toISOString(), status: "suspended" },
            ]),
          ),
        }),
        "utf-8",
      );
    writeEntries({ [chatReset]: "thread-reset", [chatKeep]: "thread-keep" });
    const sm = makeRuntime({ registryPath });
    const i = internals(sm);
    const registry = i.projection.registry;
    if (!registry) throw new Error("registry missing");

    // A pending debounced snapshot that still CONTAINS the mapping being
    // reset — scheduled before the terminate, as a suspend-time write would
    // have been — must not resurrect the deletion after the Reset.
    registry.save(
      new Map([
        [chatReset, { claudeSessionId: "thread-reset", lastActivity: 1_000, status: "suspended" }],
        [chatKeep, { claudeSessionId: "thread-keep", lastActivity: 1_000, status: "suspended" }],
      ]),
    );

    await sm.handleCommand(chatReset, "session:terminate");

    const readEntries = () =>
      (
        JSON.parse(readFileSync(registryPath, "utf-8")) as {
          entries: Record<string, { claudeSessionId: string }>;
        }
      ).entries;
    expect(Object.keys(readEntries())).toEqual([chatKeep]);
    expect(readEntries()[chatKeep]?.claudeSessionId).toBe("thread-keep");

    // Fire any surviving debounce timer: the stale snapshot must not
    // rewrite the deleted mapping back to disk.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(Object.keys(readEntries())).toEqual([chatKeep]);

    await sm.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps chats with unresolved teardown debt in the held set", async () => {
    const sm = makeRuntime();
    const i = internals(sm);
    // A chat whose only trace is teardown debt must stay held: dropping it
    // would lose the reconcile retry channel for the unconfirmed stop.
    i.routeTeardown.registerPendingTeardown("chat-debt-only", handler());
    expect(sm.getHeldChatIds()).toContain("chat-debt-only");
    await sm.shutdown();
  });

  it("force-keeps debt chats under a production active set and converges via reconcile retry", async () => {
    const boom = new Error("debt shutdown failed");
    const debtHandler = handler({
      shutdown: vi.fn().mockRejectedValueOnce(boom).mockResolvedValue(undefined),
    });
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-debt-force-keep";
    i.routeTeardown.registerPendingTeardown(chatId, debtHandler);

    // Production shape: AgentSlot.reconcileNow always passes
    // activeRuntimeChatIds, and an archived/hidden chat is not in it. The
    // teardown debt must force-keep the chat in the held report.
    const activeSet = new Set(["chat-other-active"]);
    expect(sm.getHeldChatIds(activeSet)).toContain(chatId);

    // Server declares it stale: the strict teardown runs and fails — the
    // rejection is observed (no unhandled rejection), the debt and the held
    // status survive for the next reconcile pass.
    sm.applyStaleChatIds([chatId]);
    await vi.waitFor(() => expect(debtHandler.shutdown).toHaveBeenCalledTimes(1));
    expect(i.routeTeardown.pendingTeardowns.has(chatId)).toBe(true);
    expect(sm.getHeldChatIds(activeSet)).toContain(chatId);

    // Next reconcile pass: the teardown succeeds, the debt clears, and the
    // chat finally leaves the held set.
    sm.applyStaleChatIds([chatId]);
    await vi.waitFor(() => expect(i.routeTeardown.pendingTeardowns.has(chatId)).toBe(false));
    expect(sm.getHeldChatIds(activeSet)).not.toContain(chatId);

    await sm.shutdown();
  });

  it("does not evict a chat with unresolved teardown debt", async () => {
    const sm = makeRuntime({ maxSessions: 1 });
    const i = internals(sm);
    const debtChat = "chat-force-keep-debt";
    const otherChat = "chat-force-keep-other";
    installSession(i, debtChat, { status: "suspended", lastActivity: 1_000 });
    installSession(i, otherChat, { status: "suspended", lastActivity: 2_000 });
    i.routeTeardown.registerPendingTeardown(debtChat, handler());

    // The debt chat is the older non-active session and would be the
    // preferred victim; the force-keep skips it, so the other chat is
    // evicted instead.
    i.slotScheduler.evictIfNeeded();
    expect(i.projection.sessions.has(debtChat)).toBe(true);
    expect(i.projection.sessions.has(otherChat)).toBe(false);

    await sm.shutdown();
  });

  it("terminal cleanup leaves no fake teardown debt once the stop confirms", async () => {
    const targetHandler = handler({
      resume: vi.fn().mockRejectedValue({ name: "ClientUserMismatchError", message: "wrong client" }),
    });
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-terminal-no-fake-debt";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: targetHandler,
        status: "suspended",
        claudeSessionId: "previous-session",
      }),
    );

    await sm.dispatch(mockEntry({ id: 80, chatId, messageId: "msg-terminal-no-fake-debt" }));

    // The terminal path registers-then-shuts-down the handler: the stop
    // confirmed, so no register-only "fake" debt lingers.
    await vi.waitFor(() => expect(i.projection.sessions.has(chatId)).toBe(false));
    expect(targetHandler.shutdown).toHaveBeenCalled();
    expect(i.routeTeardown.pendingTeardowns.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("rejects an active-slot terminate when handler shutdown fails, then lets a retry succeed", async () => {
    const boom = new Error("shutdown failed");
    const targetHandler = handler({
      shutdown: vi.fn().mockRejectedValueOnce(boom).mockResolvedValue(undefined),
    });
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-terminate-active-shutdown-failed";
    installSession(i, chatId, { handler: targetHandler, status: "active" });
    i.slotScheduler.activeCount = 1;

    // The active-slot teardown is strict too: a shutdown rejection must fail
    // the apply instead of being acked over a possibly-live handler.
    await expect(sm.handleCommand(chatId, "session:terminate")).rejects.toBe(boom);
    expect(targetHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(i.projection.sessions.has(chatId)).toBe(true);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    // The recorded teardownError drives a strict re-attempt on retry even
    // though the slot was already released.
    await sm.handleCommand(chatId, "session:terminate");
    expect(targetHandler.shutdown).toHaveBeenCalledTimes(2);
    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("logs a failed stale-session teardown without unhandled rejection and converges on the next reconcile pass", async () => {
    const boom = new Error("stale teardown failed");
    const { logger, records } = recordingLogger();
    const targetHandler = handler({
      shutdown: vi.fn().mockRejectedValueOnce(boom).mockResolvedValue(undefined),
    });
    const sm = makeRuntime({ log: logger });
    const i = internals(sm);
    const chatId = "chat-stale-teardown-failed";
    installSession(i, chatId, { handler: targetHandler, status: "active" });
    i.slotScheduler.activeCount = 1;

    // First reconcile pass: the strict teardown rejects, but the
    // fire-and-forget path observes the rejection — logged, not an unhandled
    // rejection (vitest would fail the suite on one) — and the entry survives
    // so the chat stays locally held for the next pass.
    sm.applyStaleChatIds([chatId]);
    await vi.waitFor(() =>
      expect(
        records.some(
          (record) => typeof record.msg === "string" && record.msg.includes("stale session terminate failed"),
        ),
      ).toBe(true),
    );
    expect(i.projection.sessions.has(chatId)).toBe(true);
    expect(sm.getHeldChatIds()).toContain(chatId);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    // The server still has no projection for the chat, so the next reconcile
    // declares it stale again; teardown now succeeds and the entry is cleaned
    // up — the retry converges instead of early-returning a false success.
    sm.applyStaleChatIds([chatId]);
    await vi.waitFor(() => expect(i.projection.sessions.has(chatId)).toBe(false));
    expect(targetHandler.shutdown).toHaveBeenCalledTimes(2);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("propagates teardown failure when terminating a session whose suspend just settled", async () => {
    const boom = new Error("shutdown failed");
    let signalSuspendStarted: (() => void) | undefined;
    let resolveSuspend: (() => void) | undefined;
    const suspendStarted = new Promise<void>((resolve) => {
      signalSuspendStarted = resolve;
    });
    const suspendGate = new Promise<void>((resolve) => {
      resolveSuspend = resolve;
    });
    const targetHandler = handler({
      suspend: vi.fn().mockImplementation(async () => {
        signalSuspendStarted?.();
        await suspendGate;
      }),
      shutdown: vi.fn().mockRejectedValue(boom),
    });
    const sm = makeRuntime();
    const i = internals(sm);
    const chatId = "chat-terminate-teardown-failed";
    installSession(i, chatId, { handler: targetHandler, status: "active" });
    i.slotScheduler.activeCount = 1;

    await sm.handleCommand(chatId, "session:suspend");
    await suspendStarted;

    const terminate = sm.handleCommand(chatId, "session:terminate");
    resolveSuspend?.();

    // The handler stayed live after the slot-releasing suspend; teardown
    // failure must fail the apply rather than inherit the swallow semantics.
    await expect(terminate).rejects.toBe(boom);
    expect(i.projection.sessions.has(chatId)).toBe(true);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("persists the mapping deletion to disk before a terminate resolves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-terminate-persist-"));
    const registryPath = join(dir, "sessions.json");
    const chatId = "chat-terminate-persist";
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        entries: {
          [chatId]: {
            claudeSessionId: "persisted-session",
            lastActivity: new Date(1_000).toISOString(),
            status: "evicted",
          },
        },
      }),
      "utf-8",
    );
    const sm = makeRuntime({ registryPath });
    expect(sm.getEvictedChatIds()).toContain(chatId);

    await sm.handleCommand(chatId, "session:terminate");

    // The ack boundary: by the time handleCommand resolves, the deletion must
    // already be durable — a crash right after must not reload the mapping.
    const data = JSON.parse(readFileSync(registryPath, "utf-8")) as { entries: Record<string, unknown> };
    expect(data.entries).toEqual({});
    const reloaded = makeRuntime({ registryPath });
    expect(reloaded.getEvictedChatIds()).toEqual([]);

    await sm.shutdown();
    await reloaded.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects terminate when the durable flush fails and re-executes on retry instead of a false success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-terminate-persist-fail-"));
    const registryPath = join(dir, "sessions.json");
    const chatId = "chat-terminate-persist-fail";
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        entries: {
          [chatId]: {
            claudeSessionId: "persisted-session",
            lastActivity: new Date(1_000).toISOString(),
            status: "evicted",
          },
        },
      }),
      "utf-8",
    );
    const sm = makeRuntime({ registryPath });
    const i = internals(sm);
    expect(i.projection.evictedMappings.has(chatId)).toBe(true);

    const boom = new Error("disk full");
    const flushSpy = vi.spyOn(SessionRegistry.prototype, "flushOrThrow").mockImplementationOnce(() => {
      throw boom;
    });

    await expect(sm.handleCommand(chatId, "session:terminate")).rejects.toBe(boom);
    // In-memory state is gone but the stale mapping is still on disk, and the
    // failed delete is remembered as pending work.
    expect(i.projection.evictedMappings.has(chatId)).toBe(false);
    expect(i.resetReplay.terminatePersistFailures.has(chatId)).toBe(true);
    let data = JSON.parse(readFileSync(registryPath, "utf-8")) as { entries: Record<string, unknown> };
    expect(Object.keys(data.entries)).toContain(chatId);

    // The retry must not early-return a false applied:true: it re-executes
    // the full termination and re-attempts the flush, which now succeeds.
    await sm.handleCommand(chatId, "session:terminate");
    expect(flushSpy).toHaveBeenCalledTimes(2);
    expect(i.resetReplay.terminatePersistFailures.has(chatId)).toBe(false);
    data = JSON.parse(readFileSync(registryPath, "utf-8")) as { entries: Record<string, unknown> };
    expect(data.entries).toEqual({});

    await sm.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("fences provider route admission and force-keeps held-chat sync after a failed Reset flush", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-terminate-persist-fence-"));
    const registryPath = join(dir, "sessions.json");
    const chatId = "chat-terminate-persist-fence";
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        entries: {
          [chatId]: {
            claudeSessionId: "persisted-session",
            lastActivity: new Date(1_000).toISOString(),
            status: "evicted",
          },
        },
      }),
      "utf-8",
    );
    const start = vi.fn().mockResolvedValue({
      sessionId: "should-not-start",
      route: { kind: "owned", mode: "processing" },
    });
    const resume = vi.fn().mockResolvedValue({
      sessionId: "should-not-resume",
      route: { kind: "owned", mode: "processing" },
    });
    const inject = vi.fn().mockReturnValue({ kind: "owned", mode: "processing" });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({
      registryPath,
      handlers: [handler({ start, resume, inject })],
      recoverChat,
    });
    const i = internals(sm);
    expect(i.projection.evictedMappings.has(chatId)).toBe(true);

    const boom = new Error("disk full");
    vi.spyOn(SessionRegistry.prototype, "flushOrThrow").mockImplementationOnce(() => {
      throw boom;
    });
    await expect(sm.handleCommand(chatId, "session:terminate")).rejects.toBe(boom);
    expect(i.resetReplay.terminatePersistFailures.has(chatId)).toBe(true);
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);
    // Empty active set still force-keeps the unresolved Reset persistence boundary.
    expect(sm.getHeldChatIds(new Set())).toContain(chatId);

    await sm.dispatch(mockEntry({ id: 80, chatId, messageId: "msg-fenced-while-persist-failed" }));
    expect(start).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(inject).not.toHaveBeenCalled();
    expect(i.projection.sessions.has(chatId)).toBe(false);
    // Parked behind the fence: no same-socket recoverChat storm.
    expect(recoverChat).not.toHaveBeenCalled();
    expect(i.inboxDelivery.hasRecoveryDebt(chatId)).toBe(true);

    // Genuine terminate retry clears the fence after a successful flush.
    await sm.handleCommand(chatId, "session:terminate");
    expect(i.resetReplay.terminatePersistFailures.has(chatId)).toBe(false);
    expect(recoverChat).not.toHaveBeenCalled();
    sm.releaseParkedResetFenceRecovery(chatId);
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledTimes(1));
    expect(recoverChat).toHaveBeenCalledWith(chatId);
    await vi.waitFor(() => expect(i.inboxDelivery.hasRecoveryDebt(chatId)).toBe(false));
    expect(sm.getHeldChatIds(new Set())).not.toContain(chatId);

    await sm.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("parks failed-Reset fence hits without recovery storm, then same-socket recovers once after successful retry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-terminate-persist-recover-loop-"));
    const registryPath = join(dir, "sessions.json");
    const chatId = "chat-terminate-persist-recover-loop";
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        entries: {
          [chatId]: {
            claudeSessionId: "persisted-session",
            lastActivity: new Date(1_000).toISOString(),
            status: "evicted",
          },
        },
      }),
      "utf-8",
    );

    const intervening = mockEntry({ id: 81, chatId, messageId: "msg-intervening-same-socket" });
    let consecutiveNoProgressResets = 0;
    let lastResetSignature: string | null = null;
    let noProgressCircuitOpen = false;
    const NO_PROGRESS_LIMIT = 2;

    const start = vi.fn().mockImplementation(async (message: SessionMessage, ctx: SessionContext, token) => {
      token?.processingStarted(message);
      await token?.complete(message, { status: "success", terminal: true });
      await ctx.finishTurn(message, { status: "success", terminal: true });
      return `fresh-${message.id}`;
    });
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);

    const recoverChat = vi.fn<(id: string) => Promise<void>>().mockImplementation(async () => {
      // Production-shaped same-socket recover acceptance. Repeated identical
      // resets of the same unacked row open the server's no-progress circuit.
      const resetSignature = String(intervening.id);
      consecutiveNoProgressResets = lastResetSignature === resetSignature ? consecutiveNoProgressResets + 1 : 1;
      lastResetSignature = resetSignature;
      if (consecutiveNoProgressResets > NO_PROGRESS_LIMIT) {
        noProgressCircuitOpen = true;
        throw new Error("recover_failed: no-progress circuit open");
      }
    });

    const sm = makeRuntime({
      registryPath,
      handlers: [handler({ start })],
      recoverChat,
      ackEntry,
    });
    const i = internals(sm);

    const boom = new Error("disk full");
    vi.spyOn(SessionRegistry.prototype, "flushOrThrow").mockImplementationOnce(() => {
      throw boom;
    });
    await expect(sm.handleCommand(chatId, "session:terminate")).rejects.toBe(boom);
    expect(i.resetReplay.terminatePersistFailures.has(chatId)).toBe(true);

    // Intervening durable row while fence is set: park with no provider entry,
    // no ACK, and no recoverChat — even under repeated delivery attempts.
    await sm.dispatch(intervening);
    await sm.dispatch(intervening);
    await sm.dispatch(intervening);
    expect(start).not.toHaveBeenCalled();
    expect(ackEntry).not.toHaveBeenCalledWith(intervening.id);
    expect(recoverChat).not.toHaveBeenCalled();
    expect(noProgressCircuitOpen).toBe(false);
    expect(i.inboxDelivery.hasRecoveryDebt(chatId)).toBe(true);

    // Same-socket Pause + successful Reset retry clears the fence and arms
    // parked debt; recovery waits for server-confirmed finalization.
    await sm.handleCommand(chatId, "session:suspend");
    await sm.handleCommand(chatId, "session:terminate");
    expect(i.resetReplay.terminatePersistFailures.has(chatId)).toBe(false);
    expect(recoverChat).not.toHaveBeenCalled();
    sm.releaseParkedResetFenceRecovery(chatId);
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledTimes(1));
    expect(noProgressCircuitOpen).toBe(false);
    expect(consecutiveNoProgressResets).toBe(1);

    // Server redelivers the exact intervening row on the same socket after the
    // accepted recovery; it must enter one fresh post-Reset session and settle.
    await sm.dispatch(intervening);
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledWith(intervening.id));
    expect(start).toHaveBeenCalledTimes(1);
    expect(vi.mocked(start).mock.calls[0]?.[0]).toMatchObject({ id: intervening.message.id });
    expect(recoverChat).toHaveBeenCalledTimes(1);
    expect(noProgressCircuitOpen).toBe(false);

    await sm.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps late parked deliveries parked after non-persistence terminate failure until genuine retry + release", async () => {
    let signalShutdownStarted: (() => void) | undefined;
    let rejectShutdown: ((err: Error) => void) | undefined;
    const shutdownStarted = new Promise<void>((resolve) => {
      signalShutdownStarted = resolve;
    });
    const shutdownGate = new Promise<void>((_resolve, reject) => {
      rejectShutdown = reject;
    });
    const boom = new Error("handler shutdown failed");
    const terminatingHandler = handler({
      shutdown: vi.fn().mockImplementation(async () => {
        signalShutdownStarted?.();
        await shutdownGate;
      }),
    });
    const start = vi.fn().mockResolvedValue("should-not-start");
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({
      handlers: [terminatingHandler, handler({ start })],
      recoverChat,
      ackEntry,
    });
    const i = internals(sm);
    const chatId = "chat-terminate-teardown-park";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: terminatingHandler,
        status: "active",
      }),
    );
    i.slotScheduler.activeCount = 1;

    const terminate = sm.handleCommand(chatId, "session:terminate");
    await shutdownStarted;

    const lateEntry = mockEntry({ id: 91, chatId, messageId: "msg-late-parked-teardown" });
    await sm.dispatch(lateEntry);
    expect(recoverChat).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(ackEntry).not.toHaveBeenCalledWith(lateEntry.id);
    expect(i.inboxDelivery.hasRecoveryDebt(chatId)).toBe(true);
    expect(i.resetReplay.awaitingResetFenceRelease.has(chatId)).toBe(true);

    rejectShutdown?.(boom);
    await expect(terminate).rejects.toThrow("handler shutdown failed");
    expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false);
    expect(i.resetReplay.terminatePersistFailures.has(chatId)).toBe(false);
    // Non-persistence failure must leave parked debt parked — no recover/provider/ACK.
    expect(recoverChat).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(ackEntry).not.toHaveBeenCalledWith(lateEntry.id);
    expect(i.resetReplay.awaitingResetFenceRelease.has(chatId)).toBe(true);

    // Repeated delivery while still awaiting a successful Reset stays parked.
    await sm.dispatch(lateEntry);
    await sm.dispatch(lateEntry);
    expect(recoverChat).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(ackEntry).not.toHaveBeenCalledWith(lateEntry.id);

    // Genuine retry succeeds; release after simulated server finalization.
    vi.mocked(terminatingHandler.shutdown).mockImplementation(async () => undefined);
    await sm.handleCommand(chatId, "session:terminate");
    expect(recoverChat).not.toHaveBeenCalled();
    sm.releaseParkedResetFenceRecovery(chatId);
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledTimes(1));
    expect(recoverChat).toHaveBeenCalledWith(chatId);

    await sm.shutdown();
  });

  it("ref'd terminate + same-socket finalize releases exactly once after applied/finalized ordering", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-terminate-finalize-order-"));
    const registryPath = join(dir, "sessions.json");
    const chatId = "chat-terminate-finalize-order";
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        entries: {
          [chatId]: {
            claudeSessionId: "persisted-session",
            lastActivity: new Date(1_000).toISOString(),
            status: "evicted",
          },
        },
      }),
      "utf-8",
    );

    const intervening = mockEntry({ id: 92, chatId, messageId: "msg-finalize-order" });
    let consecutiveNoProgressResets = 0;
    let lastResetSignature: string | null = null;
    let noProgressCircuitOpen = false;
    const NO_PROGRESS_LIMIT = 2;
    const order: string[] = [];

    const start = vi.fn().mockImplementation(async (message: SessionMessage, ctx: SessionContext, token) => {
      token?.processingStarted(message);
      await token?.complete(message, { status: "success", terminal: true });
      await ctx.finishTurn(message, { status: "success", terminal: true });
      return `fresh-${message.id}`;
    });
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(id: string) => Promise<void>>().mockImplementation(async () => {
      order.push("recover");
      const resetSignature = String(intervening.id);
      consecutiveNoProgressResets = lastResetSignature === resetSignature ? consecutiveNoProgressResets + 1 : 1;
      lastResetSignature = resetSignature;
      if (consecutiveNoProgressResets > NO_PROGRESS_LIMIT) {
        noProgressCircuitOpen = true;
        throw new Error("recover_failed: no-progress circuit open");
      }
    });

    const sm = makeRuntime({
      registryPath,
      handlers: [handler({ start })],
      recoverChat,
      ackEntry,
    });
    const i = internals(sm);

    // Failed flush + repeated delivery: no recovery/provider/ACK/circuit.
    const boom = new Error("disk full");
    vi.spyOn(SessionRegistry.prototype, "flushOrThrow").mockImplementationOnce(() => {
      throw boom;
    });
    await expect(sm.handleCommand(chatId, "session:terminate")).rejects.toBe(boom);
    await sm.dispatch(intervening);
    await sm.dispatch(intervening);
    await sm.dispatch(intervening);
    expect(start).not.toHaveBeenCalled();
    expect(ackEntry).not.toHaveBeenCalledWith(intervening.id);
    expect(recoverChat).not.toHaveBeenCalled();
    expect(noProgressCircuitOpen).toBe(false);
    expect(i.resetReplay.awaitingResetFenceRelease.has(chatId)).toBe(true);

    // Successful Pause/Reset retry arms debt; simulated applied→finalized then
    // exactly one same-socket recovery (no reconnect / no circuit).
    await sm.handleCommand(chatId, "session:suspend");
    await sm.handleCommand(chatId, "session:terminate");
    expect(i.resetReplay.terminatePersistFailures.has(chatId)).toBe(false);
    expect(recoverChat).not.toHaveBeenCalled();
    order.push("applied");
    order.push("finalized");
    sm.releaseParkedResetFenceRecovery(chatId);
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["applied", "finalized", "recover"]);
    expect(noProgressCircuitOpen).toBe(false);
    expect(consecutiveNoProgressResets).toBe(1);

    await sm.dispatch(intervening);
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledWith(intervening.id));
    expect(start).toHaveBeenCalledTimes(1);
    expect(vi.mocked(start).mock.calls[0]?.[0]).toMatchObject({ id: intervening.message.id });
    expect(recoverChat).toHaveBeenCalledTimes(1);
    expect(noProgressCircuitOpen).toBe(false);

    await sm.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("releases parked Reset debt only for the armed generation's ref", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-reset-ref-scope-"));
    const registryPath = join(dir, "sessions.json");
    const chatId = "chat-reset-ref-scope";
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        entries: {
          [chatId]: {
            claudeSessionId: "persisted-session",
            lastActivity: new Date(1_000).toISOString(),
            status: "evicted",
          },
        },
      }),
      "utf-8",
    );

    const start = vi.fn().mockImplementation(async (message: SessionMessage, ctx: SessionContext, token) => {
      token?.processingStarted(message);
      await token?.complete(message, { status: "success", terminal: true });
      await ctx.finishTurn(message, { status: "success", terminal: true });
      return `fresh-${message.id}`;
    });
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({ registryPath, handlers: [handler({ start }), handler({ start })], recoverChat, ackEntry });
    const i = internals(sm);

    // Park intervening debt behind a failed flush, exactly as a real Reset
    // failure does, then arm generation A with a successful retry.
    const boom = new Error("disk full");
    vi.spyOn(SessionRegistry.prototype, "flushOrThrow").mockImplementationOnce(() => {
      throw boom;
    });
    await expect(sm.handleCommand(chatId, "session:terminate", { resetRef: "ref-a" })).rejects.toBe(boom);
    await sm.dispatch(mockEntry({ id: 601, chatId, messageId: "msg-ref-scope" }));
    expect(ackEntry).not.toHaveBeenCalled();
    expect(i.resetReplay.awaitingResetFenceRelease.has(chatId)).toBe(true);
    await sm.handleCommand(chatId, "session:terminate", { resetRef: "ref-a" });

    // A ref that is not the armed generation may not lift the fence.
    expect(sm.releaseParkedResetFenceRecovery(chatId, "ref-not-armed")).toBe("stale");
    expect(recoverChat).not.toHaveBeenCalled();
    expect(i.resetReplay.awaitingResetFenceRelease.has(chatId)).toBe(true);

    expect(sm.releaseParkedResetFenceRecovery(chatId, "ref-a")).toBe("accepted");
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledTimes(1));

    // Generation B parks new debt and arms over A; A's delayed duplicate is
    // inert, and only the exact B ref releases — once.
    vi.spyOn(SessionRegistry.prototype, "flushOrThrow").mockImplementationOnce(() => {
      throw boom;
    });
    await expect(sm.handleCommand(chatId, "session:terminate", { resetRef: "ref-b" })).rejects.toBe(boom);
    await sm.dispatch(mockEntry({ id: 602, chatId, messageId: "msg-ref-scope-b" }));
    await sm.handleCommand(chatId, "session:terminate", { resetRef: "ref-b" });
    expect(i.resetReplay.awaitingResetFenceRelease.has(chatId)).toBe(true);
    expect(sm.releaseParkedResetFenceRecovery(chatId, "ref-a")).toBe("stale");
    expect(recoverChat).toHaveBeenCalledTimes(1);

    expect(sm.releaseParkedResetFenceRecovery(chatId, "ref-b")).toBe("accepted");
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledTimes(2));
    // A duplicate for the same generation is honest about the fence being
    // down without recovering a second time.
    expect(sm.releaseParkedResetFenceRecovery(chatId, "ref-b")).toBe("idempotent");
    expect(recoverChat).toHaveBeenCalledTimes(2);

    await sm.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("associates every ref that joins one termination with a single generation", async () => {
    let signalShutdownStarted: (() => void) | undefined;
    let resolveShutdown: (() => void) | undefined;
    const shutdownStarted = new Promise<void>((resolve) => {
      signalShutdownStarted = resolve;
    });
    const shutdownGate = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    const terminatingHandler = handler({
      shutdown: vi.fn().mockImplementation(async () => {
        signalShutdownStarted?.();
        await shutdownGate;
      }),
    });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({ handlers: [terminatingHandler], recoverChat });
    const i = internals(sm);
    const chatId = "chat-reset-ref-join";
    installSession(i, chatId, { handler: terminatingHandler, status: "active" });
    i.slotScheduler.activeCount = 1;

    const first = sm.handleCommand(chatId, "session:terminate", { resetRef: "ref-first" });
    await shutdownStarted;
    await sm.dispatch(mockEntry({ id: 610, chatId, messageId: "msg-ref-join" }));
    const second = sm.handleCommand(chatId, "session:terminate", { resetRef: "ref-second" });

    resolveShutdown?.();
    await first;
    await second;

    // A and B share one termination, so they share one generation: either
    // alias is an honest release, and the second one recovers nothing extra.
    expect(sm.releaseParkedResetFenceRecovery(chatId, "ref-first")).toBe("accepted");
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledTimes(1));
    expect(sm.releaseParkedResetFenceRecovery(chatId, "ref-second")).toBe("idempotent");
    expect(recoverChat).toHaveBeenCalledTimes(1);

    // A later generation retires both aliases.
    await sm.handleCommand(chatId, "session:terminate", { resetRef: "ref-third" });
    expect(sm.releaseParkedResetFenceRecovery(chatId, "ref-first")).toBe("stale");
    expect(sm.releaseParkedResetFenceRecovery(chatId, "ref-second")).toBe("stale");
    expect(sm.releaseParkedResetFenceRecovery(chatId, "ref-third")).toBe("accepted");

    await sm.shutdown();
  });

  it("keeps the joining alias releasable when the second ref's finalized lands first", async () => {
    let signalShutdownStarted: (() => void) | undefined;
    let resolveShutdown: (() => void) | undefined;
    const shutdownStarted = new Promise<void>((resolve) => {
      signalShutdownStarted = resolve;
    });
    const shutdownGate = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    const terminatingHandler = handler({
      shutdown: vi.fn().mockImplementation(async () => {
        signalShutdownStarted?.();
        await shutdownGate;
      }),
    });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({ handlers: [terminatingHandler], recoverChat });
    const i = internals(sm);
    const chatId = "chat-reset-alias-order";
    installSession(i, chatId, { handler: terminatingHandler, status: "active" });
    i.slotScheduler.activeCount = 1;

    const first = sm.handleCommand(chatId, "session:terminate", { resetRef: "ref-a" });
    await shutdownStarted;
    await sm.dispatch(mockEntry({ id: 611, chatId, messageId: "msg-alias-order" }));
    const second = sm.handleCommand(chatId, "session:terminate", { resetRef: "ref-b" });

    resolveShutdown?.();
    await first;
    await second;

    // Whichever Reset the server finalizes first is the one that releases;
    // latest-ref-wins would have made this the stale one.
    expect(sm.releaseParkedResetFenceRecovery(chatId, "ref-b")).toBe("accepted");
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledTimes(1));
    expect(sm.releaseParkedResetFenceRecovery(chatId, "ref-a")).toBe("idempotent");
    expect(recoverChat).toHaveBeenCalledTimes(1);

    await sm.shutdown();
  });

  it("keeps a delayed stale reconcile from releasing a newer armed Reset generation", async () => {
    const start = vi.fn().mockResolvedValue("should-not-start");
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({ handlers: [handler({ start }), handler({ start })], recoverChat, ackEntry });
    const i = internals(sm);
    const chatId = "chat-reset-stale-reconcile";

    // Reset B is armed and holding a parked row.
    await sm.handleCommand(chatId, "session:terminate", { resetRef: "ref-b" });
    await sm.dispatch(mockEntry({ id: 620, chatId, messageId: "msg-behind-generation-b" }));
    expect(i.resetReplay.awaitingResetFenceRelease.has(chatId)).toBe(true);
    expect(recoverChat).not.toHaveBeenCalled();

    // A reconcile result computed from older server state declares the chat
    // stale. Its terminate still runs, but it carries no generation, so it
    // must NOT lift B's fence — that would redeliver into a Reset the server
    // has not finalized.
    sm.applyStaleChatIds([chatId]);
    await vi.waitFor(() => expect(i.resetReplay.terminatingChats.has(chatId)).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(recoverChat).not.toHaveBeenCalled();
    expect(i.resetReplay.awaitingResetFenceRelease.has(chatId)).toBe(true);
    expect(start).not.toHaveBeenCalled();
    expect(ackEntry).not.toHaveBeenCalled();

    // Only B's own finalized releases it.
    expect(sm.releaseParkedResetFenceRecovery(chatId, "ref-b")).toBe("accepted");
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledTimes(1));

    await sm.shutdown();
  });

  it("fences the post-apply window of a zero-debt Reset until its exact finalized", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-reset-zero-debt-fence-"));
    const registryPath = join(dir, "sessions.json");
    const chatId = "chat-reset-zero-debt";

    const start = vi.fn().mockImplementation(async (message: SessionMessage, ctx: SessionContext, token) => {
      token?.processingStarted(message);
      await token?.complete(message, { status: "success", terminal: true });
      await ctx.finishTurn(message, { status: "success", terminal: true });
      return `fresh-${message.id}`;
    });
    const inject = vi.fn().mockReturnValue({ kind: "owned", mode: "processing" });
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({ registryPath, handlers: [handler({ start, inject })], recoverChat, ackEntry });
    const i = internals(sm);

    // Clean Reset: no recovery debt and no unsettled work when it applies.
    await sm.handleCommand(chatId, "session:terminate", { resetRef: "ref-clean" });
    expect(i.inboxDelivery.hasRecoveryDebt(chatId)).toBe(false);
    expect(i.inboxDelivery.hasUnsettledWork(chatId)).toBe(false);
    // The fence is armed anyway — the session is gone but the server has not
    // finalized, so the chat is not open for business yet.
    expect(i.resetReplay.awaitingResetFenceRelease.has(chatId)).toBe(true);
    expect(sm.getHeldChatIds(new Set())).toContain(chatId);

    const late = mockEntry({ id: 630, chatId, messageId: "msg-after-applied" });
    await sm.dispatch(late);
    await sm.dispatch(late);
    expect(start).not.toHaveBeenCalled();
    expect(inject).not.toHaveBeenCalled();
    expect(recoverChat).not.toHaveBeenCalled();
    expect(ackEntry).not.toHaveBeenCalled();
    expect(i.inboxDelivery.hasRecoveryDebt(chatId)).toBe(true);

    // A foreign ref still cannot open it.
    expect(sm.releaseParkedResetFenceRecovery(chatId, "ref-other")).toBe("stale");
    expect(recoverChat).not.toHaveBeenCalled();

    expect(sm.releaseParkedResetFenceRecovery(chatId, "ref-clean")).toBe("accepted");
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledTimes(1));
    expect(i.resetReplay.awaitingResetFenceRelease.has(chatId)).toBe(false);

    // The redelivered row now enters one fresh post-Reset session and settles.
    await sm.dispatch(late);
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledWith(late.id));
    expect(start).toHaveBeenCalledTimes(1);
    expect(recoverChat).toHaveBeenCalledTimes(1);

    await sm.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it("cancels admitted delivery when terminate arrives before SessionEntry creation", async () => {
    let signalBindingStarted: (() => void) | undefined;
    let resolveBinding: (() => void) | undefined;
    const bindingStarted = new Promise<void>((resolve) => {
      signalBindingStarted = resolve;
    });
    const bindingGate = new Promise<void>((resolve) => {
      resolveBinding = resolve;
    });
    const pendingHandler = handler();
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({ handlers: [pendingHandler], recoverChat });
    const i = internals(sm);
    const chatId = "chat-terminate-before-session-entry";
    i.ensureContextTreeBinding = vi.fn().mockImplementation(async () => {
      signalBindingStarted?.();
      await bindingGate;
    });

    const dispatch = sm.dispatch(mockEntry({ id: 70, chatId, messageId: "msg-pending-admission" }));
    await bindingStarted;
    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(i.inboxDelivery.snapshot(chatId).admissionPending).toBe(true);

    await sm.handleCommand(chatId, "session:terminate");
    expect(recoverChat).not.toHaveBeenCalled();
    sm.releaseParkedResetFenceRecovery(chatId);
    expect(recoverChat).toHaveBeenCalledWith(chatId);
    expect(pendingHandler.start).not.toHaveBeenCalled();
    expect(sm.activeCount).toBe(0);

    resolveBinding?.();
    await dispatch;

    expect(pendingHandler.start).not.toHaveBeenCalled();
    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(i.inboxDelivery.hasUnsettledWork(chatId)).toBe(false);
    expect(sm.activeCount).toBe(0);

    await sm.shutdown();
  });

  it("does not revive a pre-SessionEntry admission after manager shutdown", async () => {
    let signalBindingStarted: (() => void) | undefined;
    let resolveBinding: (() => void) | undefined;
    const bindingStarted = new Promise<void>((resolve) => {
      signalBindingStarted = resolve;
    });
    const bindingGate = new Promise<void>((resolve) => {
      resolveBinding = resolve;
    });
    const pendingHandler = handler();
    const sm = makeRuntime({ handlers: [pendingHandler] });
    const i = internals(sm);
    const chatId = "chat-manager-shutdown-pending-admission";
    i.ensureContextTreeBinding = vi.fn().mockImplementation(async () => {
      signalBindingStarted?.();
      await bindingGate;
    });

    const dispatch = sm.dispatch(mockEntry({ id: 71, chatId, messageId: "msg-manager-shutdown-admission" }));
    await bindingStarted;
    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(i.inboxDelivery.snapshot(chatId).admissionPending).toBe(true);

    await sm.shutdown();
    resolveBinding?.();
    await dispatch;

    expect(pendingHandler.start).not.toHaveBeenCalled();
    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(sm.activeCount).toBe(0);
    expect(i.inboxDelivery.hasRecoveryDebt(chatId)).toBe(true);
    expect(i.inboxDelivery.hasUnsettledWork(chatId)).toBe(true);
  });

  it("does not enter provider resume after manager shutdown wins a suspension wait", async () => {
    let releaseSuspending: (() => void) | undefined;
    const suspending = new Promise<void>((resolve) => {
      releaseSuspending = resolve;
    });
    let signalBlockerShutdown: (() => void) | undefined;
    let releaseBlockerShutdown: (() => void) | undefined;
    const blockerShutdownStarted = new Promise<void>((resolve) => {
      signalBlockerShutdown = resolve;
    });
    const blockerShutdownGate = new Promise<void>((resolve) => {
      releaseBlockerShutdown = resolve;
    });
    const replacement = handler();
    const handlerFactory = vi.fn<HandlerFactory>(() => replacement);
    const blockerHandler = handler({
      shutdown: vi.fn().mockImplementation(async () => {
        signalBlockerShutdown?.();
        await blockerShutdownGate;
      }),
    });
    const sm = makeRuntime({ handlerFactory });
    const i = internals(sm);
    const chatId = "chat-manager-shutdown-pending-resume";
    const headEntry = mockEntry({ id: 72, chatId, messageId: "msg-manager-shutdown-resume" });
    const head = messageFromEntry(headEntry);
    i.inboxDelivery.receive(headEntry);
    const target = makeSessionRecord(chatId, {
      status: "suspended",
      suspending,
      claudeSessionId: "previous-session",
    });
    bindSeededSession(i, target);
    const blocker = makeSessionRecord("chat-manager-shutdown-pending-resume-blocker", {
      handler: blockerHandler,
      status: "active",
    });
    bindSeededSession(i, blocker);
    i.slotScheduler.activeCount = 1;

    const resume = i.resumeSession(target, head);
    const shutdown = sm.shutdown();
    await blockerShutdownStarted;

    releaseSuspending?.();
    await resume;

    expect(handlerFactory).not.toHaveBeenCalled();
    expect(replacement.resume).not.toHaveBeenCalled();
    expect(sm.activeCount).toBe(1);
    expect(i.inboxDelivery.hasRecoveryDebt(chatId)).toBe(true);
    expect(i.inboxDelivery.hasUnsettledWork(chatId)).toBe(true);

    releaseBlockerShutdown?.();
    await shutdown;

    expect(sm.activeCount).toBe(0);
    expect(i.projection.sessions.size).toBe(0);
    expect(i.inboxDelivery.hasRecoveryDebt(chatId)).toBe(true);
    expect(i.inboxDelivery.hasUnsettledWork(chatId)).toBe(true);
  });

  it("does not ACK terminal failure when termination invalidates its pending confirmation", async () => {
    let signalConfirmStarted: (() => void) | undefined;
    let resolveConfirm: (() => void) | undefined;
    const confirmStarted = new Promise<void>((resolve) => {
      signalConfirmStarted = resolve;
    });
    const pendingConfirm = new Promise<void>((resolve) => {
      resolveConfirm = resolve;
    });
    let signalShutdownStarted: (() => void) | undefined;
    let resolveShutdown: (() => void) | undefined;
    const shutdownStarted = new Promise<void>((resolve) => {
      signalShutdownStarted = resolve;
    });
    const shutdownGate = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const targetHandler = handler({
      resume: vi.fn().mockRejectedValue({ name: "ClientUserMismatchError", message: "wrong client" }),
      shutdown: vi.fn().mockImplementation(async () => {
        signalShutdownStarted?.();
        await shutdownGate;
      }),
    });
    const sm = makeRuntime({
      ackEntry,
      confirmSessionEvent: vi.fn().mockImplementation(() => {
        signalConfirmStarted?.();
        return pendingConfirm;
      }),
    });
    const i = internals(sm);
    const chatId = "chat-terminal-confirm-invalidated";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: targetHandler,
        status: "suspended",
        claudeSessionId: "previous-session",
      }),
    );

    const headDispatch = sm.dispatch(mockEntry({ id: 73, chatId, messageId: "msg-terminal-confirm-invalidated" }));
    await confirmStarted;

    const terminate = sm.handleCommand(chatId, "session:terminate");
    await shutdownStarted;
    resolveConfirm?.();
    await headDispatch;

    expect(ackEntry).not.toHaveBeenCalled();
    expect(i.inboxDelivery.hasRecoveryDebt(chatId)).toBe(true);
    expect(i.inboxDelivery.hasUnsettledWork(chatId)).toBe(true);
    expect(i.projection.sessions.has(chatId)).toBe(false);

    resolveShutdown?.();
    await terminate;

    expect(ackEntry).not.toHaveBeenCalled();
    expect(i.inboxDelivery.hasRecoveryDebt(chatId)).toBe(true);
    expect(i.inboxDelivery.hasUnsettledWork(chatId)).toBe(true);
    expect(sm.activeCount).toBe(0);
  });

  it("releases an errored transition slot when terminate wins before failure event confirmation", async () => {
    let signalConfirmStarted: (() => void) | undefined;
    let resolveConfirm: (() => void) | undefined;
    const confirmStarted = new Promise<void>((resolve) => {
      signalConfirmStarted = resolve;
    });
    const pendingConfirm = new Promise<void>((resolve) => {
      resolveConfirm = resolve;
    });
    const targetHandler = handler({
      resume: vi.fn().mockRejectedValue({ name: "ClientUserMismatchError", message: "wrong client" }),
    });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makeRuntime({
      recoverChat,
      confirmSessionEvent: vi.fn().mockImplementation(() => {
        signalConfirmStarted?.();
        return pendingConfirm;
      }),
    });
    const i = internals(sm);
    const chatId = "chat-terminal-confirm-terminate";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: targetHandler,
        status: "suspended",
        claudeSessionId: "previous-session",
      }),
    );
    const blocker = makeSessionRecord("chat-terminal-confirm-terminate-blocker", { status: "active" });
    bindSeededSession(i, blocker);
    i.slotScheduler.activeCount = 1;

    const headDispatch = sm.dispatch(mockEntry({ id: 2, chatId, messageId: "msg-terminal-confirm-terminate" }));
    await confirmStarted;

    expect(i.projection.sessions.get(chatId)?.status).toBe("errored");
    expect(i.slotScheduler.isActiveSlotHeld(requireSession(i, chatId))).toBe(true);
    expect(sm.activeCount).toBe(2);

    // The terminate must wait for the in-flight route producer (gated on the
    // failure-event confirmation) instead of acking past it.
    const terminate = sm.handleCommand(chatId, "session:terminate");
    let terminateSettled = false;
    void terminate.then(() => {
      terminateSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(terminateSettled).toBe(false);

    resolveConfirm?.();
    await headDispatch;
    await terminate;

    expect(i.projection.sessions.has(chatId)).toBe(false);
    // Two stops: the terminate's strict teardown, then the stale route
    // completion's afterPrior stop of the materialized handler.
    expect(targetHandler.shutdown).toHaveBeenCalledTimes(2);
    expect(sm.activeCount).toBe(1);

    expect(i.projection.sessions.has(blocker.chatId)).toBe(true);
    expect(sm.activeCount).toBe(1);
    await sm.shutdown();
  });

  it("releases an errored transition slot when LRU eviction wins before failure event confirmation", async () => {
    let signalConfirmStarted: (() => void) | undefined;
    let resolveConfirm: (() => void) | undefined;
    const confirmStarted = new Promise<void>((resolve) => {
      signalConfirmStarted = resolve;
    });
    const pendingConfirm = new Promise<void>((resolve) => {
      resolveConfirm = resolve;
    });
    const targetHandler = handler({
      resume: vi.fn().mockRejectedValue({ name: "ClientUserMismatchError", message: "wrong client" }),
    });
    const sm = makeRuntime({
      maxSessions: 2,
      confirmSessionEvent: vi.fn().mockImplementation(() => {
        signalConfirmStarted?.();
        return pendingConfirm;
      }),
    });
    const i = internals(sm);
    const chatId = "chat-terminal-confirm-evict";
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        handler: targetHandler,
        status: "suspended",
        claudeSessionId: "previous-session",
      }),
    );
    const blocker = makeSessionRecord("chat-terminal-confirm-evict-blocker", { status: "active" });
    bindSeededSession(i, blocker);
    i.slotScheduler.activeCount = 1;

    const headDispatch = sm.dispatch(mockEntry({ id: 2, chatId, messageId: "msg-terminal-confirm-evict" }));
    await confirmStarted;

    expect(i.projection.sessions.get(chatId)?.status).toBe("errored");
    expect(i.slotScheduler.isActiveSlotHeld(requireSession(i, chatId))).toBe(true);
    expect(sm.activeCount).toBe(2);

    i.slotScheduler.evictIfNeeded();

    expect(i.projection.sessions.has(chatId)).toBe(false);
    expect(targetHandler.shutdown).toHaveBeenCalledTimes(1);
    expect(sm.activeCount).toBe(1);

    resolveConfirm?.();
    await headDispatch;

    expect(i.projection.sessions.has(blocker.chatId)).toBe(true);
    expect(sm.activeCount).toBe(1);
    await sm.shutdown();
  });

  it("blocks retry, tail, and control resume re-entry while terminal retry confirmation is pending", async () => {
    let signalConfirmStarted: (() => void) | undefined;
    let resolveConfirm: (() => void) | undefined;
    const confirmStarted = new Promise<void>((resolve) => {
      signalConfirmStarted = resolve;
    });
    const pendingConfirm = new Promise<void>((resolve) => {
      resolveConfirm = resolve;
    });
    const terminalRetry = handler({
      resume: vi.fn().mockRejectedValue({ name: "ClientUserMismatchError", message: "wrong client" }),
    });
    const replacement = handler({
      start: vi
        .fn()
        .mockResolvedValue({ sessionId: "tail-session", route: { kind: "owned" as const, mode: "queued" as const } }),
    });
    const sm = makeRuntime({
      handlers: [terminalRetry, replacement],
      confirmSessionEvent: vi.fn().mockImplementation(() => {
        signalConfirmStarted?.();
        return pendingConfirm;
      }),
    });
    const i = internals(sm);
    const chatId = "chat-terminal-confirm-admission";
    const headEntry = mockEntry({ id: 2, chatId, messageId: "msg-terminal-confirm-head" });
    const tailEntry = mockEntry({ id: 3, chatId, messageId: "msg-terminal-confirm-tail" });
    const head = messageFromEntry(headEntry);
    i.inboxDelivery.receive(headEntry);
    bindSeededSession(
      i,
      makeSessionRecord(chatId, {
        retryAttempt: 1,
        status: "suspended",
        claudeSessionId: "previous-session",
        retryHeadMessage: head,
        lastRetryReason: "network_error",
      }),
    );
    const blocker = makeSessionRecord("chat-terminal-confirm-admission-blocker", { status: "active" });
    bindSeededSession(i, blocker);
    i.slotScheduler.activeCount = 1;

    const retryPromise = i.slotScheduler.runRetry(chatId);
    await confirmStarted;

    expect(i.projection.sessions.get(chatId)?.status).toBe("errored");
    expect(i.slotScheduler.isActiveSlotHeld(requireSession(i, chatId))).toBe(true);
    expect(i.slotScheduler.currentRetryAttempt(requireSession(i, chatId))).toBe(0);
    expect(sm.activeCount).toBe(2);

    await sm.dispatch(tailEntry);
    await sm.handleCommand(chatId, "session:resume");
    // Re-entry joins the in-flight single-flight execution instead of
    // running a second retry — the join identity is the single-flight
    // guarantee (previously this returned immediately via the entry guard).
    expect(i.slotScheduler.runRetry(chatId)).toBe(retryPromise);

    expect(terminalRetry.resume).toHaveBeenCalledTimes(1);
    expect(replacement.start).not.toHaveBeenCalled();
    expect(replacement.resume).not.toHaveBeenCalled();
    expect(i.slotScheduler.pendingQueue.some((queued) => queued.message?.id === tailEntry.message.id)).toBe(true);
    expect(sm.activeCount).toBe(2);

    resolveConfirm?.();
    await retryPromise;
    await vi.waitFor(() => expect(replacement.start).toHaveBeenCalledTimes(1));

    expect(replacement.start).toHaveBeenCalledWith(
      expect.objectContaining({ id: tailEntry.message.id }),
      expect.anything(),
      expect.anything(),
    );
    expect(terminalRetry.resume).toHaveBeenCalledTimes(1);
    expect(i.projection.sessions.has(blocker.chatId)).toBe(true);
    expect(sm.activeCount).toBe(2);
    await sm.shutdown();
  });

  it("keeps retry failures in retry mode and tears down permanent retry failures with non-Error previews", async () => {
    const transient = handler({
      start: vi.fn().mockRejectedValue({ status: 429, message: "still limited" }),
    });
    const permanent = handler({
      start: vi.fn().mockRejectedValue({ name: "ClientUserMismatchError", message: "plain failure" }),
    });
    const states: SessionState[] = [];
    const sm = makeRuntime({
      handlers: [transient, permanent],
      onStateChange: (_chatId, state) => states.push(state),
      onSessionEvent: () => {
        throw new Error("event channel closed");
      },
    });

    const retrying = makeSessionRecord("chat-retry-transient", {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "",
      retryHeadMessage: makeMessage("chat-retry-transient"),
      lastRetryReason: "rate_limit",
    });
    bindSeededSession(internals(sm), retrying);
    await internals(sm).slotScheduler.runRetry("chat-retry-transient");
    expect(internals(sm).slotScheduler.currentRetryAttempt(retrying)).toBeGreaterThan(1);

    const failing = makeSessionRecord("chat-retry-permanent", {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "",
      retryHeadMessage: makeMessage("chat-retry-permanent"),
    });
    bindSeededSession(internals(sm), failing);
    await internals(sm).slotScheduler.runRetry("chat-retry-permanent");

    expect(internals(sm).projection.sessions.has("chat-retry-permanent")).toBe(false);
    expect(states).toContain("errored");
    await sm.shutdown();
  });

  it("runs scheduled retry timers and catches retry timer failures", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const limited = handler({
      start: vi.fn().mockRejectedValue({ status: 429, message: "rate limited" }),
    });
    const sm = makeRuntime({ handlers: [limited] });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-timer" }));
    await vi.advanceTimersByTimeAsync(1_000);

    await sm.shutdown();
  });

  it("runs re-armed retry timers and catches rearm failures", async () => {
    vi.useFakeTimers();
    const sm = makeRuntime({
      concurrency: 1,
      handlerFactory: () => {
        throw new Error("rearm factory failed");
      },
    });
    const retrying = makeSessionRecord("chat-rearm", {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "",
      retryHeadMessage: makeMessage("chat-rearm"),
      lastRetryReason: "rate_limit",
    });
    bindSeededSession(internals(sm), retrying);
    internals(sm).slotScheduler.activeCount = 1;

    await internals(sm).slotScheduler.runRetry("chat-rearm");
    internals(sm).slotScheduler.activeCount = 0;
    await vi.advanceTimersByTimeAsync(5_000);

    await sm.shutdown();
  });

  it("uses retry-time config cache, clears existing retry timers, and catches retry-success emit failures", async () => {
    const cache = makeCache();
    const successfulResume = handler({
      resume: vi
        .fn()
        .mockResolvedValue({ sessionId: "retry-resumed", route: { kind: "owned" as const, mode: "queued" as const } }),
    });
    const transientResume = handler({
      resume: vi.fn().mockRejectedValue({ status: 429, message: "still limited" }),
    });
    const sm = makeRuntime({
      handlers: [successfulResume, transientResume],
      agentConfigCache: cache,
      onSessionEvent: () => {
        throw new Error("event channel closed");
      },
    });

    const succeeds = makeSessionRecord("chat-retry-success", {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "previous-session",
      retryHeadMessage: null,
      lastRetryReason: "rate_limit",
    });
    bindSeededSession(internals(sm), succeeds);
    await internals(sm).slotScheduler.runRetry("chat-retry-success");
    expect(successfulResume.resume).toHaveBeenCalledWith(undefined, "previous-session", expect.anything());

    const retriesAgain = makeSessionRecord("chat-retry-again", {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "previous-session-again",
      retryHeadMessage: makeMessage("chat-retry-again"),
      lastRetryReason: "rate_limit",
    });
    bindSeededSession(internals(sm), retriesAgain);
    await internals(sm).slotScheduler.runRetry("chat-retry-again");
    expect(internals(sm).slotScheduler.currentRetryAttempt(retriesAgain)).toBeGreaterThan(1);

    await sm.shutdown();
  });

  it("classifies retry failures with only retryFromEvicted as resume failures", async () => {
    const resumeFails = handler({
      resume: vi.fn().mockRejectedValue({ status: 429, message: "still limited" }),
    });
    const sm = makeRuntime({ handlers: [resumeFails] });
    const retrying = makeSessionRecord("chat-retry-from-evicted", {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "",
      retryFromEvicted: { claudeSessionId: "evicted-session", lastActivity: 1 },
      retryHeadMessage: makeMessage("chat-retry-from-evicted"),
      lastRetryReason: "rate_limit",
    });
    bindSeededSession(internals(sm), retrying);

    await internals(sm).slotScheduler.runRetry("chat-retry-from-evicted");

    expect(resumeFails.resume).toHaveBeenCalledWith(
      expect.anything(),
      "evicted-session",
      expect.anything(),
      expect.anything(),
    );
    expect(internals(sm).slotScheduler.currentRetryAttempt(retrying)).toBeGreaterThan(1);
    await sm.shutdown();
  });

  it("classifies evicted resume failures as resume-phase failures", async () => {
    const states: SessionState[] = [];
    const resumeFails = handler({
      resume: vi.fn().mockRejectedValue({ name: "ClientUserMismatchError", message: "wrong client" }),
    });
    const sm = makeRuntime({
      handlers: [resumeFails],
      onStateChange: (_chatId, state) => states.push(state),
    });
    internals(sm).projection.evictedMappings.set("chat-evicted-fail", {
      claudeSessionId: "evicted-session",
      lastActivity: 1,
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-evicted-fail" }));

    expect(states).toContain("errored");
    await sm.shutdown();
  });

  it("evicts non-active sessions before active ones and prefers the least recently active session", async () => {
    const sm = makeRuntime({ maxSessions: 2 });
    const activeOld = makeSessionRecord("chat-active-old", { status: "active", lastActivity: 10 });
    const activeNew = makeSessionRecord("chat-active-new", { status: "active", lastActivity: 20 });
    bindSeededSession(internals(sm), activeNew);
    bindSeededSession(internals(sm), activeOld);
    internals(sm).slotScheduler.evictIfNeeded();
    expect(internals(sm).projection.evictedMappings.has("chat-active-old")).toBe(true);

    internals(sm).projection.sessions.clear();
    internals(sm).projection.evictedMappings.clear();
    internals(sm).slotScheduler.activeCount = 1;
    const active = makeSessionRecord("chat-active", { status: "active", lastActivity: 10 });
    const suspended = makeSessionRecord("chat-suspended", { status: "suspended", lastActivity: 20 });
    bindSeededSession(internals(sm), active);
    bindSeededSession(internals(sm), suspended);
    internals(sm).slotScheduler.evictIfNeeded();
    expect(internals(sm).projection.evictedMappings.has("chat-suspended")).toBe(true);

    await sm.shutdown();
  });

  it("queues from start-new-session and from same-chat active-slot acquisition", async () => {
    const sm = makeRuntime({ concurrency: 1 });

    internals(sm).slotScheduler.activeCount = 1;
    await internals(sm).routeMessage("chat-start-queued", makeMessage("chat-start-queued"));
    expect(internals(sm).slotScheduler.pendingQueue.some((item) => item.chatId === "chat-start-queued")).toBe(true);

    internals(sm).slotScheduler.pendingQueue.length = 0;
    const active = makeSessionRecord("chat-same", { status: "active" });
    bindSeededSession(internals(sm), active);
    internals(sm).slotScheduler.activeCount = 1;
    expect(internals(sm).slotScheduler.acquireActiveSlot("chat-same", makeMessage("chat-same"))).toBe(false);
    expect(internals(sm).slotScheduler.pendingQueue.some((item) => item.chatId === "chat-same")).toBe(true);

    await sm.shutdown();
  });

  it("covers drainPendingQueue return and edge branches", async () => {
    const sm = makeRuntime({ concurrency: 1, handlers: [handler()] });

    internals(sm).slotScheduler.pendingQueue.push({
      chatId: "chat-held",
      message: makeMessage("chat-held"),
      deliveryKind: "fresh",
    });
    internals(sm).slotScheduler.activeCount = 1;
    internals(sm).slotScheduler.drainPendingQueue();
    expect(internals(sm).slotScheduler.pendingQueue.some((item) => item.chatId === "chat-held")).toBe(true);

    internals(sm).slotScheduler.activeCount = 0;
    internals(sm).slotScheduler.drainPendingQueue();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(internals(sm).projection.sessions.has("chat-held")).toBe(true);

    const emptyShift = internals(makeRuntime());
    emptyShift.slotScheduler.pendingQueue.push({
      chatId: "chat-empty-shift",
      message: makeMessage("chat-empty-shift"),
      deliveryKind: "fresh",
    });
    emptyShift.slotScheduler.pendingQueue.shift = () => undefined;
    emptyShift.slotScheduler.drainPendingQueue();
    await (emptyShift as unknown as SessionRuntime).shutdown();

    await sm.shutdown();
  });

  it("drains pending queue without an entry id and logs asynchronous drain failures", async () => {
    const sm = makeRuntime({
      handlerFactory: () => {
        throw new Error("factory failed during drain");
      },
    });
    internals(sm).slotScheduler.pendingQueue.push({
      chatId: "chat-drain",
      message: makeMessage("chat-drain"),
      deliveryKind: "fresh",
    });
    internals(sm).slotScheduler.drainPendingQueue();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(sm.totalCount).toBe(0);
    await sm.shutdown();
  });

  it("logs rejected suspends without breaking suspension cleanup", async () => {
    const badSuspend = handler({ suspend: vi.fn().mockRejectedValue(new Error("suspend failed")) });
    const sm = makeRuntime({ handlers: [badSuspend] });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-bad-suspend" }));
    await sm.handleCommand("chat-bad-suspend", "session:suspend");
    const suspended = internals(sm).projection.sessions.get("chat-bad-suspend")?.suspending;
    if (suspended) await suspended;

    expect(badSuspend.suspend).toHaveBeenCalledTimes(1);
    await sm.shutdown();
  });

  it("deduplicates explicit state notifications and skips reaffirm when no callback exists", async () => {
    const states: SessionState[] = [];
    const withCallback = makeRuntime({ onStateChange: (_chatId, state) => states.push(state) });
    internals(withCallback).projection.notifySessionState("chat-state", "active");
    internals(withCallback).projection.notifySessionState("chat-state", "active");
    expect(states).toEqual(["active"]);
    await withCallback.shutdown();

    const withoutRuntimeCallback = makeRuntime();
    internals(withoutRuntimeCallback).projection.reaffirmRuntimeStates();
    bindSeededSession(
      internals(withoutRuntimeCallback),
      makeSessionRecord("chat-suspended-snapshot", { status: "suspended" }),
    );
    expect(withoutRuntimeCallback.getSessionRuntimeStates()).toEqual([]);
    await withoutRuntimeCallback.shutdown();
  });

  it("reports runtime snapshots only for active sessions and ignores inactive provider activity", async () => {
    const runtimeChanges: RuntimeState[] = [];
    let captured: SessionContext | undefined;
    const sm = makeRuntime({
      handlers: [
        handler({
          async start(message, ctx) {
            captured = ctx;
            ctx.markMessagesConsumed(message);
            return { sessionId: "runtime-session", route: { kind: "owned" as const, mode: "queued" as const } };
          },
        }),
      ],
      onRuntimeStateChange: (state) => runtimeChanges.push(state),
      onSessionRuntimeChange: vi.fn(),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-runtime" }));
    expect(sm.getSessionRuntimeStates()).toEqual([
      { chatId: "chat-runtime", runtimeState: "working", backgroundWork: false },
    ]);
    if (!captured) throw new Error("context was not captured");
    runtimeChanges.length = 0;
    await sm.handleCommand("chat-runtime", "session:suspend");
    captured.recordProviderActivity();
    expect(runtimeChanges).not.toContain("working");

    internals(sm).projection.reaffirmRuntimeStates();
    await sm.shutdown();
  });

  it("covers session context transport updates and confirmed event channels", async () => {
    const events: SessionEvent[] = [];
    const sm = makeRuntime({
      onSessionEvent: (_chatId, event) => events.push(event),
    });
    const nextSdk = mockSdk();
    const nextCache = makeCache();

    sm.updateTransport(nextSdk, nextCache);
    sm.noteBindRecoveryComplete();

    const ctx = internals(sm).buildSessionContext("chat-context");
    expect(ctx.sdk).toBe(nextSdk);
    await expect(ctx.formatFromHeader(makeMessage("chat-context"))).resolves.toContain("alice");

    const event: SessionEvent = { kind: "error", payload: { source: "runtime", message: "boom" } };
    if (!ctx.emitEventConfirmed) throw new Error("confirmed event callback missing");
    await expect(ctx.emitEventConfirmed(event)).rejects.toThrow("confirmed session event channel unavailable");
    expect(events).toEqual([event]);
    await sm.shutdown();

    const confirmSessionEvent = vi.fn<(chatId: string, event: SessionEvent) => Promise<void>>().mockResolvedValue();
    const confirmed = makeRuntime({ confirmSessionEvent });
    const confirmedCtx = internals(confirmed).buildSessionContext("chat-confirmed");
    if (!confirmedCtx.emitEventConfirmed) throw new Error("confirmed event callback missing");
    await confirmedCtx.emitEventConfirmed(event);
    expect(confirmSessionEvent).toHaveBeenCalledWith("chat-confirmed", event);
    await confirmed.shutdown();
  });

  it("uses idle fallback in evictIdle logging when no runtime state was recorded", async () => {
    vi.useFakeTimers({ now: 100_000 });
    const log = recordingLogger();
    let captured: SessionContext | undefined;
    let capturedMessage: SessionMessage | undefined;
    const first = handler({
      async start(message, ctx) {
        capturedMessage = message;
        captured = ctx;
        return { sessionId: "idle-log-session", route: { kind: "owned" as const, mode: "queued" as const } };
      },
    });
    const sm = new SessionRuntime({
      session: { idle_timeout: 1, max_sessions: 10, working_grace_seconds: 1, reconcile_interval_seconds: 300 },
      concurrency: 5,
      handlerFactory: () => first,
      handlerConfig: { workspaceRoot: "/tmp/test-edge/idle-log", runtimeProvider: "codex" },
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk: mockSdk(),
      log: log.logger,
      ackEntry: vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined),
    });

    await sm.dispatch(mockEntry({ id: 1, chatId: "chat-idle-log" }));
    if (!capturedMessage) throw new Error("message was not captured");
    await captured?.finishTurn(capturedMessage, { status: "success", terminal: true });
    vi.advanceTimersByTime(2_000);

    vi.advanceTimersByTime(10_000);

    expect(log.records.some((entry) => entry.msg === "session idle, suspending" && entry.runtimeState === "idle")).toBe(
      true,
    );
    await sm.shutdown();
  });

  it("reaffirms active runtime states on the jittered timer and recomputes blocked/error aggregates", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const sessionRuntimeChanges: Array<{ chatId: string; state: RuntimeState }> = [];
    const aggregateChanges: RuntimeState[] = [];
    const sm = makeRuntime({
      onSessionRuntimeChange: (chatId, { runtimeState }) => sessionRuntimeChanges.push({ chatId, state: runtimeState }),
      onRuntimeStateChange: (state) => aggregateChanges.push(state),
    });
    const i = internals(sm);
    installSession(i, "chat-working", { status: "active" });
    installSession(i, "chat-error", { status: "errored" });
    installSession(i, "chat-idle", { status: "active" });
    i.projection.sessionRuntimeStates.set("chat-working", "working");
    i.projection.sessionRuntimeStates.set("chat-error", "error");
    i.projection.sessionRuntimeStates.set("chat-idle", "idle");

    await vi.advanceTimersByTimeAsync(20_000);

    expect(sessionRuntimeChanges).toEqual([
      { chatId: "chat-working", state: "working" },
      { chatId: "chat-error", state: "error" },
    ]);

    i.projection.sessionRuntimeStates.clear();
    i.projection.sessionRuntimeStates.set("chat-working", "working");
    i.projection.sessionRuntimeStates.set("chat-blocked", "blocked");
    i.projection.recomputeRuntimeState();
    i.projection.sessionRuntimeStates.set("chat-error", "error");
    i.projection.recomputeRuntimeState();

    expect(aggregateChanges).toContain("blocked");
    expect(aggregateChanges).toContain("error");
    await sm.shutdown();
  });

  it("eagerly fetches valid image batches and logs failed attachment downloads", async () => {
    const home = mkdtempSync(join(tmpdir(), "ft-session-images-"));
    vi.stubEnv("FIRST_TREE_HOME", home);
    const fetchAttachment = vi
      .fn<(params: { id: string }) => Promise<{ bytes: Buffer }>>()
      .mockResolvedValueOnce({ bytes: Buffer.from("png bytes") })
      .mockRejectedValueOnce(new Error("blob missing"));
    const sdk = { ...mockSdk(), fetchAttachment } as unknown as FirstTreeHubSDK;
    const started = handler();
    const sm = makeRuntime({ handlers: [started], sdk });
    const base = mockEntry({ id: 501, chatId: "chat-images", messageId: "msg-images" });
    const entry = {
      ...base,
      message: {
        ...base.message,
        format: "file",
        content: {
          caption: "two images",
          attachments: [
            {
              imageId: "11111111-1111-4111-8111-111111111111",
              mimeType: "image/png",
              filename: "first.png",
            },
            {
              imageId: "22222222-2222-4222-8222-222222222222",
              mimeType: "image/jpeg",
              filename: "second.jpg",
            },
          ],
        },
      },
    } as InboxEntryWithMessage;

    await sm.dispatch(entry);

    expect(fetchAttachment).toHaveBeenCalledTimes(2);
    expect(fetchAttachment).toHaveBeenNthCalledWith(1, { id: "11111111-1111-4111-8111-111111111111" });
    expect(
      readFileSync(
        join(home, "data", "chats", "chat-images", "images", "11111111-1111-4111-8111-111111111111.png"),
        "utf8",
      ),
    ).toBe("png bytes");
    expect(started.start).toHaveBeenCalledTimes(1);

    const singleBase = mockEntry({ id: 502, chatId: "chat-images", messageId: "msg-image-existing" });
    await sm.dispatch({
      ...singleBase,
      message: {
        ...singleBase.message,
        format: "file",
        content: {
          imageId: "11111111-1111-4111-8111-111111111111",
          mimeType: "image/png",
          filename: "first.png",
        },
      },
    } as InboxEntryWithMessage);

    expect(fetchAttachment).toHaveBeenCalledTimes(2);
    expect(started.inject).toHaveBeenCalledTimes(1);
    await sm.shutdown();
    rmSync(home, { recursive: true, force: true });
  });

  it("retries consumed error completions when runtime notice delivery and failure-event emit both fail", async () => {
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockRejectedValue(new Error("notice store offline"));
    const sdk = { ...mockSdk(), sendMessage } as unknown as FirstTreeHubSDK;
    let capturedToken: Parameters<AgentHandler["start"]>[2] | undefined;
    let capturedMessage: SessionMessage | undefined;
    const started = handler({
      async start(message, _ctx, token) {
        capturedMessage = message;
        capturedToken = token;
        return { sessionId: "runtime-notice-session", route: { kind: "owned" as const, mode: "queued" as const } };
      },
    });
    const sm = makeRuntime({
      handlers: [started],
      ackEntry,
      recoverChat,
      sdk,
      onSessionEvent: () => {
        throw new Error("event stream closed");
      },
    });

    await sm.dispatch(mockEntry({ id: 502, chatId: "chat-notice-emit-fail", messageId: "msg-notice-emit-fail" }));
    const entry = internals(sm).projection.sessions.get("chat-notice-emit-fail");
    if (!entry || !capturedMessage || !capturedToken) throw new Error("delivery was not captured");
    entry.pendingRuntimeFailureNotice = {
      event: "provider_failure_terminal",
      provider: "claude-code",
      scope: "provider_turn",
      category: "credential",
      reasonCode: "provider_credential_required",
      replaySafety: "provider_entered",
      userSeverity: "error",
      messagePreview: "auth expired",
    };

    await capturedToken.complete(capturedMessage, {
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "provider_failed",
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(ackEntry).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith("chat-notice-emit-fail"));
    await sm.shutdown();
  });

  it("retries and rethrows admission failures after local custody is still open", async () => {
    const sm = makeRuntime();
    internals(sm).ensureContextTreeBinding = vi.fn().mockRejectedValue(new Error("tree resolver failed"));

    await expect(
      sm.dispatch(mockEntry({ id: 504, chatId: "chat-admission-fail", messageId: "msg-admission-fail" })),
    ).rejects.toThrow("tree resolver failed");

    expect(internals(sm).inboxDelivery.hasRecoveryDebt("chat-admission-fail")).toBe(true);
    await sm.shutdown();
  });

  it("logs resilience emit failures when slot queuing cannot notify listeners", async () => {
    const sm = makeRuntime({
      concurrency: 1,
      onSessionEvent: () => {
        throw new Error("event sink unavailable");
      },
    });
    internals(sm).slotScheduler.activeCount = 1;

    await internals(sm).routeMessage("chat-queue-emit-fail", makeMessage("chat-queue-emit-fail"));

    expect(internals(sm).slotScheduler.pendingQueue.some((item) => item.chatId === "chat-queue-emit-fail")).toBe(true);
    await sm.shutdown();
  });

  it("logs second-stage suspend cleanup failures when the suspend warning path itself throws", async () => {
    const log = silentLogger();
    const warn = vi
      .spyOn(log, "warn")
      .mockImplementationOnce(() => {
        throw new Error("warn transport failed");
      })
      .mockImplementation(() => undefined);
    const sm = makeRuntime({
      handlers: [handler({ suspend: vi.fn().mockRejectedValue(new Error("suspend failed")) })],
      log,
    });

    await sm.dispatch(mockEntry({ id: 505, chatId: "chat-suspend-log-fail", messageId: "msg-suspend-log-fail" }));
    await sm.handleCommand("chat-suspend-log-fail", "session:suspend");
    const suspending = internals(sm).projection.sessions.get("chat-suspend-log-fail")?.suspending;
    if (suspending) await suspending;

    expect(warn).toHaveBeenCalledTimes(2);
    await sm.shutdown();
  });

  it("cleans up unowned routes and logs asynchronous unowned shutdown failures", async () => {
    const badShutdown = vi.fn().mockRejectedValue(new Error("shutdown failed"));
    const sm = makeRuntime();
    const i = internals(sm);
    const record = makeSessionRecord("chat-unowned", {
      status: "active",
      handler: handler({ shutdown: badShutdown }),
    });
    bindSeededSession(i, record);
    i.slotScheduler.activeCount = 1;

    i.abortUnownedRoute(record, "test_unowned_route");

    expect(i.projection.sessions.has("chat-unowned")).toBe(false);
    expect(sm.activeCount).toBe(0);
    await vi.waitFor(() => expect(badShutdown).toHaveBeenCalledWith("test_unowned_route", {}));
    await sm.shutdown();
  });

  it("aborts lost ownership receipts from start, resume, and retry routing branches", async () => {
    const makeOwnedReceipt = (sessionId: string) => ({ sessionId, route: { kind: "owned", mode: "queued" } as const });
    const loseOwnership: SessionRuntimeInternals["markRouteOwned"] = () => "lost";

    const startHandler = handler({
      start: vi.fn().mockResolvedValue({
        sessionId: makeOwnedReceipt("start-lost"),
        route: { kind: "owned" as const, mode: "queued" as const },
      }),
    });
    const startManager = makeRuntime({ handlers: [startHandler] });
    internals(startManager).markRouteOwned = loseOwnership;
    await internals(startManager).routeMessage("chat-start-lost", makeMessage("chat-start-lost"));
    expect(internals(startManager).projection.sessions.has("chat-start-lost")).toBe(false);
    await startManager.shutdown();

    const evictedHandler = handler({
      resume: vi.fn().mockResolvedValue({
        sessionId: makeOwnedReceipt("evicted-lost"),
        route: { kind: "owned" as const, mode: "queued" as const },
      }),
    });
    const evictedManager = makeRuntime({ handlers: [evictedHandler] });
    internals(evictedManager).projection.evictedMappings.set("chat-evicted-lost", {
      claudeSessionId: "old-evicted",
      lastActivity: 1,
    });
    internals(evictedManager).markRouteOwned = loseOwnership;
    await internals(evictedManager).routeMessage("chat-evicted-lost", makeMessage("chat-evicted-lost"));
    expect(internals(evictedManager).projection.sessions.has("chat-evicted-lost")).toBe(false);
    await evictedManager.shutdown();

    const suspendedRecord = makeSessionRecord("chat-resume-lost", {
      status: "suspended",
      handler: handler({
        resume: vi.fn().mockResolvedValue({
          sessionId: makeOwnedReceipt("resume-lost"),
          route: { kind: "owned" as const, mode: "queued" as const },
        }),
      }),
    });
    const resumeManager = makeRuntime();
    bindSeededSession(internals(resumeManager), suspendedRecord);
    internals(resumeManager).markRouteOwned = loseOwnership;
    await internals(resumeManager).resumeSession(suspendedRecord, makeMessage("chat-resume-lost"));
    expect(internals(resumeManager).projection.sessions.has("chat-resume-lost")).toBe(false);
    await resumeManager.shutdown();

    const retryResumeHandler = handler({
      resume: vi.fn().mockResolvedValue({
        sessionId: makeOwnedReceipt("retry-resume-lost"),
        route: { kind: "owned" as const, mode: "queued" as const },
      }),
    });
    const retryResumeManager = makeRuntime({ handlers: [retryResumeHandler] });
    bindSeededSession(
      internals(retryResumeManager),
      makeSessionRecord("chat-retry-resume-lost", {
        retryAttempt: 1,
        status: "suspended",
        claudeSessionId: "previous-retry",
        retryHeadMessage: makeMessage("chat-retry-resume-lost"),
      }),
    );
    internals(retryResumeManager).markRouteOwned = loseOwnership;
    await internals(retryResumeManager).slotScheduler.runRetry("chat-retry-resume-lost");
    expect(internals(retryResumeManager).projection.sessions.has("chat-retry-resume-lost")).toBe(false);
    await retryResumeManager.shutdown();

    const retryStartHandler = handler({
      start: vi.fn().mockResolvedValue({
        sessionId: makeOwnedReceipt("retry-start-lost"),
        route: { kind: "owned" as const, mode: "queued" as const },
      }),
    });
    const retryStartManager = makeRuntime({ handlers: [retryStartHandler] });
    bindSeededSession(
      internals(retryStartManager),
      makeSessionRecord("chat-retry-start-lost", {
        retryAttempt: 1,
        status: "suspended",
        claudeSessionId: "",
        retryHeadMessage: makeMessage("chat-retry-start-lost"),
      }),
    );
    internals(retryStartManager).markRouteOwned = loseOwnership;
    await internals(retryStartManager).slotScheduler.runRetry("chat-retry-start-lost");
    expect(internals(retryStartManager).projection.sessions.has("chat-retry-start-lost")).toBe(false);
    await retryStartManager.shutdown();
  });

  it("drains active and control pending queue branches, including asynchronous requeue failures", async () => {
    const activeManager = makeRuntime();
    const activeInternals = internals(activeManager);
    bindSeededSession(activeInternals, makeSessionRecord("chat-active-drain", { status: "active" }));
    activeInternals.slotScheduler.pendingQueue.push({
      chatId: "chat-active-drain",
      message: null,
      deliveryKind: "control",
    });
    activeInternals.slotScheduler.pendingQueue.push({
      chatId: "chat-active-drain",
      message: makeMessage("chat-active-drain"),
      deliveryKind: "fresh",
    });
    activeInternals.routeMessage = vi.fn().mockRejectedValue(new Error("active drain failed"));

    activeInternals.slotScheduler.drainPendingQueue();
    await vi.waitFor(() => expect(activeInternals.routeMessage).toHaveBeenCalledTimes(1));
    expect(activeInternals.slotScheduler.pendingQueue.some((item) => item.chatId === "chat-active-drain")).toBe(true);
    await activeManager.shutdown();

    const activeInboxManager = makeRuntime();
    const activeInboxInternals = internals(activeInboxManager);
    bindSeededSession(activeInboxInternals, makeSessionRecord("chat-active-inbox-drain", { status: "active" }));
    const activeInboxEntry = mockEntry({
      id: 999,
      chatId: "chat-active-inbox-drain",
      messageId: "msg-chat-active-inbox-drain",
    });
    activeInboxInternals.inboxDelivery.receive(activeInboxEntry);
    activeInboxInternals.slotScheduler.pendingQueue.push({
      chatId: "chat-active-inbox-drain",
      message: { ...makeMessage("chat-active-inbox-drain"), inboxEntryId: 999 },
      deliveryKind: "fresh",
    });
    activeInboxInternals.routeMessage = vi.fn().mockRejectedValue(new Error("active inbox drain failed"));

    activeInboxInternals.slotScheduler.drainPendingQueue();
    await vi.waitFor(() => expect(activeInboxInternals.routeMessage).toHaveBeenCalledTimes(1));
    expect(
      activeInboxInternals.slotScheduler.pendingQueue.some((item) => item.chatId === "chat-active-inbox-drain"),
    ).toBe(false);
    await activeInboxManager.shutdown();

    const controlManager = makeRuntime();
    const controlInternals = internals(controlManager);
    const suspended = makeSessionRecord("chat-control-drain", { status: "suspended" });
    bindSeededSession(controlInternals, suspended);
    controlInternals.slotScheduler.pendingQueue.push({
      chatId: "chat-control-drain",
      message: null,
      deliveryKind: "control",
    });
    controlInternals.resumeSession = vi.fn().mockRejectedValue(new Error("control resume failed"));

    controlInternals.slotScheduler.drainPendingQueue();
    await vi.waitFor(() =>
      expect(controlInternals.resumeSession).toHaveBeenCalledWith(suspended, undefined, "control"),
    );
    expect(controlInternals.slotScheduler.pendingQueue.some((item) => item.chatId === "chat-control-drain")).toBe(true);
    await controlManager.shutdown();
  });

  it.each([
    "rejected",
    "throw",
  ] as const)("stops deferred injection at the first %s result and recovers the untouched suffix", async (failureMode) => {
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const retryHandler = handler({
      resume: vi.fn().mockImplementation(async (message, _sessionId, _ctx, token) => {
        if (!message || !token) throw new Error("retry head token was not provided");
        token.processingStarted(message);
        await token.complete(message, { status: "success", terminal: true });
        return { sessionId: "retry-resumed", route: { kind: "owned" as const, mode: "queued" as const } };
      }),
      inject: vi.fn((message) => {
        if (message.id === "msg-deferred-first") {
          if (failureMode === "throw") throw new Error("provider queue closed");
          return { kind: "rejected", reason: "provider queue closed", retryable: true } as const;
        }
        return { kind: "owned", mode: "queued" } as const;
      }),
    });
    const sm = makeRuntime({ handlers: [retryHandler], ackEntry, recoverChat });
    const i = internals(sm);
    const chatId = "chat-retry-inject-prefix";
    const headEntry = mockEntry({ id: 2, chatId, messageId: "msg-deferred-head" });
    const firstTailEntry = mockEntry({ id: 3, chatId, messageId: "msg-deferred-first" });
    const secondTailEntry = mockEntry({ id: 4, chatId, messageId: "msg-deferred-second" });
    const head = messageFromEntry(headEntry);
    const firstTail = messageFromEntry(firstTailEntry);
    const secondTail = messageFromEntry(secondTailEntry);
    i.inboxDelivery.receive(headEntry);
    i.inboxDelivery.receive(firstTailEntry);
    i.inboxDelivery.receive(secondTailEntry);
    const retrying = makeSessionRecord(chatId, {
      retryAttempt: 1,
      status: "suspended",
      claudeSessionId: "previous-session",
      retryHeadMessage: head,
      deferredMessages: [firstTail, secondTail],
    });
    bindSeededSession(i, retrying);

    await i.slotScheduler.runRetry(chatId);

    expect(retryHandler.inject).toHaveBeenCalledTimes(1);
    expect(retryHandler.inject).toHaveBeenCalledWith(firstTail, expect.anything());
    expect(retryHandler.inject).not.toHaveBeenCalledWith(secondTail, expect.anything());
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(2);
    expect(recoverChat).toHaveBeenCalledWith(chatId);
    expect(i.inboxDelivery.hasUnsettledWork(chatId)).toBe(false);
    await sm.shutdown();
  });

  it("qualifies an idle chat with background work and keeps re-affirming it", async () => {
    // A provider parked on a task it started itself burns no tokens, so the
    // chat is genuinely idle — but it wakes itself up, which plain "Idle"
    // cannot say. The marker rides the runtime frame it qualifies.
    const onSessionRuntimeChange = vi.fn();
    const subprocessProbe: SubprocessProbe = {
      hasLiveSubprocess: vi.fn(() => true),
      hasSessionSpawnedSubprocess: vi.fn((chatId: string) => chatId === "chat-parked"),
      noteTurnBoundary: vi.fn(),
      stop: vi.fn(),
    };
    const sm = makeRuntime({ subprocessProbe, onSessionRuntimeChange });
    const i = internals(sm);
    bindSeededSession(i, makeSessionRecord("chat-parked", { status: "active", lastActivity: Date.now() }));
    i.projection.projectSessionRuntime("chat-parked");
    onSessionRuntimeChange.mockClear();

    i.projection.reaffirmRuntimeStates();
    expect(onSessionRuntimeChange).toHaveBeenCalledWith("chat-parked", { runtimeState: "idle", backgroundWork: true });
    expect(i.projection.hasBackgroundWork("chat-parked")).toBe(true);

    // The server only trusts the marker while the runtime stamp is fresh, so
    // the re-affirm must keep coming for as long as the provider is parked.
    onSessionRuntimeChange.mockClear();
    i.projection.reaffirmRuntimeStates();
    expect(onSessionRuntimeChange).toHaveBeenCalledWith("chat-parked", { runtimeState: "idle", backgroundWork: true });

    await sm.shutdown();
  });

  it("never asserts background work while a turn is running", async () => {
    // The probe answers "the provider has a live child process", which an
    // ordinary foreground tool call satisfies too. Only an idle chat may
    // carry the marker, or a `Bash` step would flap it every turn.
    const onSessionRuntimeChange = vi.fn();
    const subprocessProbe: SubprocessProbe = {
      hasLiveSubprocess: vi.fn(() => true),
      hasSessionSpawnedSubprocess: vi.fn(() => true),
      noteTurnBoundary: vi.fn(),
      stop: vi.fn(),
    };
    const sm = makeRuntime({ subprocessProbe, onSessionRuntimeChange });
    const i = internals(sm);
    const chatId = "chat-running-turn";
    bindSeededSession(i, makeSessionRecord(chatId, { status: "active", lastActivity: Date.now() }));
    i.projection.projectSessionRuntime(chatId);
    i.projection.reaffirmRuntimeStates();
    expect(i.projection.hasBackgroundWork(chatId)).toBe(true);

    // A turn starts: the marker retires with the transition, and the frame
    // carrying `working` carries the cleared value with it.
    onSessionRuntimeChange.mockClear();
    i.projection.noteProviderTurnStart(chatId);
    expect(onSessionRuntimeChange).toHaveBeenCalledWith(chatId, { runtimeState: "working", backgroundWork: false });
    expect(i.projection.hasBackgroundWork(chatId)).toBe(false);

    i.projection.reaffirmRuntimeStates();
    expect(i.projection.hasBackgroundWork(chatId)).toBe(false);

    await sm.shutdown();
  });

  it("seals through a real turn and then reports a watcher that turn launched", async () => {
    // The positive direction, end to end, with nothing about the answer stubbed:
    // a real PsSubprocessProbe fed a real process tree, a real SessionRuntime,
    // and the seal reached ONLY through a turn — never by calling
    // `sealBaseline` directly. Every other runtime-level test here is either a
    // negative (a dead feature also emits no frame) or hands the runtime a
    // stubbed `hasSessionSpawnedSubprocess`, so replacing the one-line seal
    // wiring with a no-op leaves them all green while the qualifier can never
    // appear on any host.
    const chatId = "chat-seal-wiring";
    const T0 = new Date("2026-09-02T00:00:00Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const withMcp = [
      "4242 1 20:00 node",
      "7000 4242 02:00 /opt/homebrew/bin/claude",
      "7001 7000 01:59 npm exec momentic mcp",
    ];
    let rows = [...withMcp];
    const probe = new PsSubprocessProbe({
      log: silentLogger(),
      daemonPid: 4242,
      intervalMs: 1_000_000,
      runProcessSnapshot: async () => rows.join("\n"),
      runEnvForPid: async () => `FIRST_TREE_CHAT_ID=${chatId} /opt/homebrew/bin/claude`,
    });
    await probe.refresh(); // startup scan

    const frames: Array<{ chatId: string; report: { runtimeState: string; backgroundWork: boolean } }> = [];
    let capturedCtx: SessionContext | undefined;
    let capturedMessage: SessionMessage | undefined;
    const sm = makeRuntime({
      subprocessProbe: probe,
      onSessionRuntimeChange: (id, report) => frames.push({ chatId: id, report }),
      handlers: [
        handler({
          start: vi.fn(async (msg: SessionMessage, ctx: SessionContext) => {
            capturedCtx = ctx;
            capturedMessage = msg;
            return { sessionId: "session-seal", route: { kind: "owned" as const, mode: "queued" as const } };
          }) as unknown as AgentHandler["start"],
        }),
      ],
    });
    const i = internals(sm);

    await sm.dispatch(mockEntry({ id: 1, chatId }));
    if (!capturedCtx || !capturedMessage) throw new Error("expected captured session context");

    // A turn runs. This event is the only thing that records the boundary —
    // no test-imposed ordering around it, because the runtime does not provide
    // one: the boundary is an instant, and the scan proving it can run late.
    capturedCtx.emitEvent({
      kind: "tool_call",
      payload: { toolUseId: "t1", name: "Bash", args: null, status: "ok" },
    });
    // …and the turn launches a watcher that outlives it.
    await capturedCtx.finishTurn(capturedMessage, { status: "success", terminal: true });
    capturedCtx.emitEvent({ kind: "turn_end", payload: { status: "success" } });

    vi.setSystemTime(T0 + 30_000);
    rows = [
      "4242 1 20:30 node",
      "7000 4242 02:30 /opt/homebrew/bin/claude",
      "7001 7000 02:29 npm exec momentic mcp",
      "7002 7000 00:20 /bin/zsh",
      "7003 7002 00:20 sleep",
    ];
    await probe.refresh();
    frames.length = 0;
    i.projection.reaffirmRuntimeStates();
    expect(frames).toContainEqual({ chatId, report: { runtimeState: "idle", backgroundWork: true } });

    // The watcher exits; the permanent MCP child must not keep the claim alive.
    vi.setSystemTime(T0 + 60_000);
    rows = ["4242 1 21:00 node", "7000 4242 03:00 /opt/homebrew/bin/claude", "7001 7000 02:59 npm exec momentic mcp"];
    await probe.refresh();
    frames.length = 0;
    i.projection.reaffirmRuntimeStates();
    expect(frames).toContainEqual({ chatId, report: { runtimeState: "idle", backgroundWork: false } });

    probe.stop();
    await sm.shutdown();
    vi.useRealTimers();
  });

  it("signals one turn boundary per turn, not one per in-turn event", async () => {
    // The probe treats each boundary call as a newer candidate, so this guard
    // is what stops a turn's second tool call from moving the boundary past a
    // watcher its first one already launched. It lives here rather than in the
    // probe because only the projection knows where a turn begins and ends.
    const chatId = "chat-one-boundary-per-turn";
    const boundaries: string[] = [];
    const probe: SubprocessProbe = {
      hasLiveSubprocess: vi.fn(() => true),
      hasSessionSpawnedSubprocess: vi.fn(() => false),
      noteTurnBoundary: vi.fn((id: string) => boundaries.push(id)),
      stop: vi.fn(),
    };
    const sm = makeRuntime({ subprocessProbe: probe });
    const i = internals(sm);
    bindSeededSession(i, makeSessionRecord(chatId, { status: "active", lastActivity: Date.now() }));

    i.projection.noteProviderTurnStart(chatId);
    i.projection.noteProviderTurnStart(chatId);
    i.projection.noteProviderTurnStart(chatId);
    expect(boundaries).toEqual([chatId]);

    // A distinct turn must be able to supersede the previous candidate.
    i.projection.noteProviderTurnEnd(chatId);
    i.projection.noteProviderTurnStart(chatId);
    expect(boundaries).toEqual([chatId, chatId]);

    await sm.shutdown();
  });

  it("gives a provider that respawns inside an open turn its own boundary", async () => {
    // Claude's transient retry rebuilds the native process mid-turn without a
    // `turn_end`, so chat-level turn liveness is still in flight when the
    // replacement generation reports its own boundary. That boundary has to
    // reach the probe anyway, or the new process's startup MCP child and every
    // task it launches stay unclassifiable until some later turn.
    const chatId = "chat-respawn";
    const T0 = new Date("2026-09-02T00:00:00Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    let rows = ["4242 1 20:00 node", "8000 4242 02:00 /opt/homebrew/bin/claude", "8001 8000 01:59 npm exec mcp"];
    const probe = new PsSubprocessProbe({
      log: silentLogger(),
      daemonPid: 4242,
      intervalMs: 1_000_000,
      runProcessSnapshot: async () => rows.join("\n"),
      runEnvForPid: async () => `FIRST_TREE_CHAT_ID=${chatId} /opt/homebrew/bin/claude`,
    });
    await probe.refresh();

    let capturedCtx: SessionContext | undefined;
    const sm = makeRuntime({
      subprocessProbe: probe,
      handlers: [
        handler({
          start: vi.fn(async (_msg: SessionMessage, ctx: SessionContext) => {
            capturedCtx = ctx;
            return { sessionId: "session-respawn", route: { kind: "owned" as const, mode: "queued" as const } };
          }) as unknown as AgentHandler["start"],
        }),
      ],
    });
    await sm.dispatch(mockEntry({ id: 1, chatId }));
    if (!capturedCtx) throw new Error("expected captured session context");

    capturedCtx.noteTurnStart(); // the first generation's turn opens

    // The provider respawns mid-turn: new pid, no `turn_end` in between, and
    // the replacement reports its own boundary.
    vi.setSystemTime(T0 + 30_000);
    rows = ["4242 1 20:30 node", "8100 4242 00:03 /opt/homebrew/bin/claude", "8101 8100 00:02 npm exec mcp"];
    capturedCtx.noteTurnStart();

    // It then launches a watcher, and a scan follows.
    vi.setSystemTime(T0 + 90_000);
    rows = [
      "4242 1 21:30 node",
      "8100 4242 01:03 /opt/homebrew/bin/claude",
      "8101 8100 01:02 npm exec mcp",
      "8102 8100 00:30 /bin/zsh",
    ];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(true);
    // …and the replacement's own permanent MCP child is not the reason.
    rows = ["4242 1 21:30 node", "8100 4242 01:03 /opt/homebrew/bin/claude", "8101 8100 01:02 npm exec mcp"];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(false);

    probe.stop();
    await sm.shutdown();
    vi.useRealTimers();
  });

  it("never asserts background work for a session whose only child is its MCP server", async () => {
    // End to end against the REAL probe rather than a stubbed boolean: this is
    // the shape that would have shipped the qualifier onto every idle chat of
    // every MCP-configured agent, and a boolean stub cannot see it because it
    // assumes the probe already answers the product question.
    const chatId = "chat-mcp-only";
    const probe = new PsSubprocessProbe({
      log: silentLogger(),
      daemonPid: 4242,
      intervalMs: 1_000_000,
      runProcessSnapshot: async () =>
        [
          "4242 1 20:00 node",
          "7000 4242 02:00 /opt/homebrew/bin/claude",
          "7001 7000 01:59 npm exec momentic mcp --config /x.yaml",
        ].join("\n"),
      runEnvForPid: async () => `FIRST_TREE_CHAT_ID=${chatId} /opt/homebrew/bin/claude`,
    });
    await probe.refresh();

    const onSessionRuntimeChange = vi.fn();
    const sm = makeRuntime({ subprocessProbe: probe, onSessionRuntimeChange });
    const i = internals(sm);
    bindSeededSession(i, makeSessionRecord(chatId, { status: "active", lastActivity: Date.now() }));
    i.projection.projectSessionRuntime(chatId);
    onSessionRuntimeChange.mockClear();

    i.projection.reaffirmRuntimeStates();
    expect(i.projection.hasBackgroundWork(chatId)).toBe(false);
    expect(onSessionRuntimeChange).not.toHaveBeenCalled();

    probe.stop();
    await sm.shutdown();
  });

  it("stops asserting background work past the idle-sweep hard cap", async () => {
    // A forgotten background watcher must not leave "background task" on an
    // agent forever: past `idle_timeout + working_grace` the sweep reclaims
    // the slot anyway, so the assertion stops at the same boundary.
    const onSessionRuntimeChange = vi.fn();
    const subprocessProbe: SubprocessProbe = {
      hasLiveSubprocess: vi.fn(() => true),
      hasSessionSpawnedSubprocess: vi.fn(() => true),
      noteTurnBoundary: vi.fn(),
      stop: vi.fn(),
    };
    const sm = makeRuntime({ subprocessProbe, onSessionRuntimeChange });
    const i = internals(sm);
    const pastCapMs = (sessionConfig.idle_timeout + sessionConfig.working_grace_seconds) * 1000 + 1_000;
    bindSeededSession(
      i,
      makeSessionRecord("chat-forgotten-watcher", { status: "active", lastActivity: Date.now() - pastCapMs }),
    );
    i.projection.projectSessionRuntime("chat-forgotten-watcher");
    onSessionRuntimeChange.mockClear();

    i.projection.reaffirmRuntimeStates();
    expect(i.projection.hasBackgroundWork("chat-forgotten-watcher")).toBe(false);
    expect(onSessionRuntimeChange).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("evicts idle active sessions with live subprocesses only after no better candidate exists", async () => {
    const subprocessProbe: SubprocessProbe = {
      hasLiveSubprocess: vi.fn((chatId: string) => chatId === "chat-live-subprocess"),
      hasSessionSpawnedSubprocess: vi.fn(() => false),
      noteTurnBoundary: vi.fn(),
      stop: vi.fn(),
    };
    const sm = makeRuntime({ maxSessions: 1, subprocessProbe });
    const i = internals(sm);
    bindSeededSession(
      i,
      makeSessionRecord("chat-live-subprocess", {
        status: "active",
        lastActivity: 1,
      }),
    );

    i.slotScheduler.evictIfNeeded();

    expect(i.projection.evictedMappings.has("chat-live-subprocess")).toBe(true);
    await sm.shutdown();

    const noCandidate = makeRuntime({ maxSessions: 1 });
    const noCandidateInternals = internals(noCandidate);
    bindSeededSession(
      noCandidateInternals,
      makeSessionRecord("chat-working-only", {
        status: "active",
        lastActivity: 1,
      }),
    );
    const entry = mockEntry({ id: 503, chatId: "chat-working-only", messageId: "msg-working-only" });
    const decision = noCandidateInternals.inboxDelivery.receive(entry);
    if (decision.kind !== "deliver") throw new Error("expected working delivery");
    noCandidateInternals.inboxDelivery.markOwned(decision.work);
    noCandidateInternals.inboxDelivery.markProcessingStarted("chat-working-only", messageFromEntry(entry));

    noCandidateInternals.slotScheduler.evictIfNeeded();

    expect(noCandidateInternals.projection.sessions.has("chat-working-only")).toBe(true);
    await noCandidate.shutdown();
  });
});
