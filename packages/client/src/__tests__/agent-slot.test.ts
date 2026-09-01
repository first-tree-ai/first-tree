import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type FirstTreeHubSDK, type RegisterResult, SdkError } from "../cloud/sdk.js";
import type { AgentSlotConfig } from "../runtime/agent-slot.js";
import type { ClientConnection, SessionReconcileResult } from "../runtime/client-connection.js";
import type { HandlerConfig } from "../runtime/handler.js";
import { RuntimeSessionTokenFile } from "../runtime/runtime-session-token-file.js";
import type { ResetFenceReleaseVerdict } from "../runtime/session-runtime.js";

type FakeLogger = {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  child: ReturnType<typeof vi.fn<(bindings: Record<string, unknown>) => FakeLogger>>;
};

type FakeSessionState = {
  activeCount: number;
  lastActivityMs: number;
  sessionStates: Array<{ chatId: string; state: "active" | "suspended" | "evicted" }>;
  evictedChatIds: string[];
  runtimeStates: Array<{ chatId: string; runtimeState: "idle" | "working" | "blocked" | "error" }>;
  aggregateRuntimeState: "idle" | "working" | "blocked" | "error" | null;
  heldChatIds: string[];
  dispatch: ReturnType<typeof vi.fn<(entry: unknown) => Promise<void>>>;
  handleCommand: ReturnType<
    typeof vi.fn<
      (chatId: string, type: "session:suspend" | "session:terminate", options?: { resetRef?: string }) => Promise<void>
    >
  >;
  applyStaleChatIds: ReturnType<typeof vi.fn<(chatIds: string[]) => void>>;
  noteBindRecoveryComplete: ReturnType<typeof vi.fn<() => void>>;
  releaseParkedResetFenceRecovery: ReturnType<typeof vi.fn<(chatId: string, ref?: string) => ResetFenceReleaseVerdict>>;
  supersedeResetGeneration: ReturnType<typeof vi.fn<(chatId: string, reason: string) => ResetFenceReleaseVerdict>>;
  reconcileReplayFencesWithServer: ReturnType<typeof vi.fn<() => Promise<void>>>;
  reconcileAckSettlementAfterBind: ReturnType<typeof vi.fn<() => Promise<void>>>;
  updateTransport: ReturnType<typeof vi.fn<(sdk: unknown, agentConfigCache?: unknown) => void>>;
  shutdown: ReturnType<typeof vi.fn<(reason?: string, opts?: unknown) => Promise<void>>>;
};

type MockState = {
  logger: FakeLogger;
  syncResult: { path: string; repoUrl: string; branch: string } | null;
  syncCalls: Array<{ sdk: unknown; messages: string[] }>;
  sessions: FakeSessionState[];
  sessionConfigs: unknown[];
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

class FakeClientConnection extends EventEmitter {
  tokenProviders = new Map<string, () => string | undefined>();
  bindAgent = vi.fn(async () => {
    const token = (this.sdk as { runtimeSessionToken?: unknown }).runtimeSessionToken;
    return {
      agentId: "agent-1",
      displayName: "Agent One",
      agentType: "agent",
      sdk: this.sdk,
      ...(typeof token === "string" && token.length > 0 ? { runtimeSessionToken: token } : {}),
    };
  });
  unbindAgent = vi.fn(async () => {});
  setRuntimeSessionTokenProvider = vi.fn((agentId: string, provider: () => string | undefined) => {
    this.tokenProviders.set(agentId, provider);
  });
  clearRuntimeSessionTokenProvider = vi.fn((agentId: string, provider?: () => string | undefined) => {
    if (provider && this.tokenProviders.get(agentId) !== provider) return;
    this.tokenProviders.delete(agentId);
  });
  sendInboxAck = vi.fn();
  reportSessionState = vi.fn();
  reportRuntimeState = vi.fn();
  reportSessionEvent = vi.fn();
  reportSessionEventConfirmed = vi.fn(async () => {});
  reportSessionRuntime = vi.fn();
  reportSessionCommandApplied = vi.fn();
  reportSessionCommandFinalizedAck = vi.fn();
  reportSessionCommandAbortedAck = vi.fn();
  sendSessionReconcile = vi.fn();
  /** Negotiated per connection; flip to false to model an old server. */
  supportsSessionResetV1 = true;

  constructor(private readonly sdk: unknown) {
    super();
  }
}

function makeLogger(): FakeLogger {
  const logger: FakeLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeAgent(overrides: Partial<RegisterResult> = {}): RegisterResult {
  return {
    agentId: "agent-1",
    inboxId: "inbox-1",
    status: "online",
    displayName: "Agent One",
    type: "agent",
    visibility: "organization",
    delegateMention: null,
    metadata: {},
    ...overrides,
  };
}

function makeSdk(options?: {
  agent?: RegisterResult;
  configError?: unknown;
  /** Throw `error` on the first `times` config fetches, then succeed — models a transient blip. */
  configErrorsThenSucceed?: { error: unknown; times: number };
  activeRuntimeChatIds?: string[];
  activeSessionChatIds?: string[];
  activeRuntimeChatIdsError?: unknown;
  runtimeSessionToken?: string;
}): FirstTreeHubSDK {
  const agent = options?.agent ?? makeAgent();
  let configCalls = 0;
  const sdk = {
    register: vi.fn(async () => agent),
    fetchAgentConfig: vi.fn(async () => {
      configCalls++;
      const blip = options?.configErrorsThenSucceed;
      if (blip && configCalls <= blip.times) throw blip.error;
      if (options?.configError) throw options.configError;
      return {
        agentId: agent.agentId,
        version: 7,
        payload: {
          kind: "claude-code",
          prompt: { append: "" },
          model: "claude-sonnet",
          mcpServers: [],
          env: [],
          gitRepos: [],
          resourceSkills: [],
          reasoningEffort: "",
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
        updatedBy: "user-1",
      };
    }),
    serverUrl: "https://first-tree.example",
    runtimeSessionToken: options?.runtimeSessionToken,
    listActiveRuntimeChatIds: vi.fn(async () => {
      if (options?.activeRuntimeChatIdsError) throw options.activeRuntimeChatIdsError;
      const chatIds = options?.activeRuntimeChatIds ?? ["chat-1", "chat-2", "chat-evicted"];
      return {
        chatIds,
        activeSessionChatIds: options?.activeSessionChatIds ?? chatIds,
      };
    }),
  };
  // AgentSlot only uses this SDK subset; the concrete SDK type has many HTTP methods irrelevant here.
  return sdk as unknown as FirstTreeHubSDK;
}

function makeFrame(overrides: Record<string, unknown> = {}) {
  return {
    entryId: 42,
    inboxId: "inbox-1",
    chatId: "chat-1",
    message: {
      id: "msg-1",
      chatId: "chat-1",
      senderId: "user-1",
      format: "text",
      content: "hello",
      metadata: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

function installMocks(
  options: {
    syncResult?: MockState["syncResult"];
    syncDelayMs?: number;
    dispatchRejectEntryId?: number;
    dataDir?: string;
  } = {},
): MockState {
  vi.resetModules();
  const state: MockState = {
    logger: makeLogger(),
    syncResult:
      options.syncResult === undefined
        ? { path: "/tmp/tree", repoUrl: "git@example/tree.git", branch: "main" }
        : options.syncResult,
    syncCalls: [],
    sessions: [],
    sessionConfigs: [],
  };

  vi.doMock("@first-tree/shared/config", () => ({
    defaultDataDir: () => options.dataDir ?? join(realpathSync(tmpdir()), "first-tree-test-data"),
  }));
  vi.doMock("../cloud/observability/logger.js", () => ({
    createLogger: () => state.logger,
  }));
  vi.doMock("../runtime/context-source.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../runtime/context-source.js")>();
    return {
      ...actual,
      resolveAgentContextSource: vi.fn(async (sdk: unknown, _workspaceRoot: string, log: (msg: string) => void) => {
        const messages: string[] = [];
        log("sync log");
        messages.push("sync log");
        state.syncCalls.push({ sdk, messages });
        if (options.syncDelayMs && options.syncDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.syncDelayMs));
        }
        if (state.syncResult === null) {
          return { kind: "none" as const, reason: "unknown" as const };
        }
        return {
          kind: "remote" as const,
          path: state.syncResult.path,
          repoUrl: state.syncResult.repoUrl,
          branch: state.syncResult.branch,
        };
      }),
    };
  });
  vi.doMock("../runtime/session-runtime.js", () => ({
    SessionRuntime: class {
      state: FakeSessionState;

      constructor(readonly config: unknown) {
        state.sessionConfigs.push(config);
        this.state = {
          activeCount: 2,
          lastActivityMs: 123,
          sessionStates: [{ chatId: "chat-1", state: "active" }],
          evictedChatIds: ["chat-evicted"],
          runtimeStates: [{ chatId: "chat-1", runtimeState: "working" }],
          aggregateRuntimeState: "working",
          heldChatIds: ["chat-1", "chat-2"],
          dispatch: vi.fn(async (entry: unknown) => {
            if (
              typeof entry === "object" &&
              entry !== null &&
              Reflect.get(entry, "id") === options.dispatchRejectEntryId
            ) {
              throw new Error("buffered dispatch failed");
            }
          }),
          handleCommand: vi.fn(async () => {}),
          applyStaleChatIds: vi.fn(),
          noteBindRecoveryComplete: vi.fn(),
          releaseParkedResetFenceRecovery: vi.fn<(chatId: string, ref?: string) => ResetFenceReleaseVerdict>(
            () => "accepted",
          ),
          supersedeResetGeneration: vi.fn<(chatId: string, reason: string) => ResetFenceReleaseVerdict>(
            () => "accepted",
          ),
          reconcileReplayFencesWithServer: vi.fn(async () => {}),
          reconcileAckSettlementAfterBind: vi.fn(async () => {}),
          updateTransport: vi.fn(),
          shutdown: vi.fn(async () => {}),
        };
        state.sessions.push(this.state);
      }

      getQuietGateSnapshot(): { activeCount: number; lastActivityMs: number } {
        return { activeCount: this.state.activeCount, lastActivityMs: this.state.lastActivityMs };
      }

      getSessionStates(activeChatIds?: ReadonlySet<string> | null): FakeSessionState["sessionStates"] {
        if (!activeChatIds) return this.state.sessionStates;
        return this.state.sessionStates.filter(({ chatId }) => activeChatIds.has(chatId));
      }

      getEvictedChatIds(activeChatIds?: ReadonlySet<string> | null): string[] {
        if (!activeChatIds) return this.state.evictedChatIds;
        return this.state.evictedChatIds.filter((chatId) => activeChatIds.has(chatId));
      }

      getSessionRuntimeStates(activeChatIds?: ReadonlySet<string> | null): FakeSessionState["runtimeStates"] {
        if (!activeChatIds) return this.state.runtimeStates;
        return this.state.runtimeStates.filter(({ chatId }) => activeChatIds.has(chatId));
      }

      getAggregateRuntimeState(): FakeSessionState["aggregateRuntimeState"] {
        return this.state.aggregateRuntimeState;
      }

      dispatch(entry: unknown): Promise<void> {
        return this.state.dispatch(entry);
      }

      handleCommand(
        chatId: string,
        type: "session:suspend" | "session:terminate",
        options?: { resetRef?: string },
      ): Promise<void> {
        // Forward the arity the caller used so assertions stay readable for
        // the legacy unref'd path.
        return options === undefined
          ? this.state.handleCommand(chatId, type)
          : this.state.handleCommand(chatId, type, options);
      }

      applyStaleChatIds(chatIds: string[]): void {
        this.state.applyStaleChatIds(chatIds);
      }

      noteBindRecoveryComplete(): void {
        this.state.noteBindRecoveryComplete();
      }

      releaseParkedResetFenceRecovery(chatId: string, ref?: string): ResetFenceReleaseVerdict {
        return ref === undefined
          ? this.state.releaseParkedResetFenceRecovery(chatId)
          : this.state.releaseParkedResetFenceRecovery(chatId, ref);
      }

      supersedeResetGeneration(chatId: string, reason: string): ResetFenceReleaseVerdict {
        return this.state.supersedeResetGeneration(chatId, reason);
      }

      reconcileReplayFencesWithServer(): Promise<void> {
        return this.state.reconcileReplayFencesWithServer();
      }

      reconcileAckSettlementAfterBind(): Promise<void> {
        return this.state.reconcileAckSettlementAfterBind();
      }

      updateTransport(sdk: unknown, agentConfigCache?: unknown): void {
        this.state.updateTransport(sdk, agentConfigCache);
      }

      getHeldChatIds(activeChatIds?: ReadonlySet<string> | null): string[] {
        if (!activeChatIds) return this.state.heldChatIds;
        return this.state.heldChatIds.filter((chatId) => activeChatIds.has(chatId));
      }

      shutdown(reason?: string, opts?: unknown): Promise<void> {
        return this.state.shutdown(reason, opts);
      }
    },
  }));

  return state;
}

async function makeSlot(options?: {
  agent?: RegisterResult;
  configError?: unknown;
  configErrorsThenSucceed?: { error: unknown; times: number };
  activeRuntimeChatIds?: string[];
  activeSessionChatIds?: string[];
  activeRuntimeChatIdsError?: unknown;
  runtimeSessionToken?: string;
  runtimeType?: string;
  syncResult?: MockState["syncResult"];
  syncDelayMs?: number;
  dispatchRejectEntryId?: number;
  omitReconcileInterval?: boolean;
  deferSuspendOnSubprocess?: boolean;
  dataDir?: string;
}): Promise<{
  slot: import("../runtime/agent-slot.js").AgentSlot;
  connection: FakeClientConnection;
  sdk: FirstTreeHubSDK;
  state: MockState;
}> {
  const state = installMocks({
    syncResult: options?.syncResult,
    syncDelayMs: options?.syncDelayMs,
    dispatchRejectEntryId: options?.dispatchRejectEntryId,
    dataDir: options?.dataDir,
  });
  const sdk = makeSdk({
    agent: options?.agent,
    configError: options?.configError,
    configErrorsThenSucceed: options?.configErrorsThenSucceed,
    activeRuntimeChatIds: options?.activeRuntimeChatIds,
    activeSessionChatIds: options?.activeSessionChatIds,
    activeRuntimeChatIdsError: options?.activeRuntimeChatIdsError,
    runtimeSessionToken: options?.runtimeSessionToken,
  });
  const connection = new FakeClientConnection(sdk);
  const { AgentSlot } = await import("../runtime/agent-slot.js");
  const handlerFactory = vi.fn((config: HandlerConfig) => ({
    start: vi.fn(async () => ({ sessionId: "session-1", route: { kind: "owned" as const, mode: "queued" as const } })),
    resume: vi.fn(async () => ({ sessionId: "session-1", route: { kind: "owned" as const, mode: "queued" as const } })),
    inject: vi.fn(),
    suspend: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    config,
  }));
  const config: AgentSlotConfig = {
    name: "agent-one",
    agentId: "agent-1",
    serverUrl: "https://first-tree.example",
    type: "claude-code",
    runtimeType: options?.runtimeType,
    runtimeVersion: "1.2.3",
    handlerFactory,
    session: {
      idle_timeout: 300,
      max_sessions: 3,
      working_grace_seconds: 60,
      ...(options?.deferSuspendOnSubprocess === undefined
        ? {}
        : { defer_suspend_on_subprocess: options.deferSuspendOnSubprocess }),
      // AgentSlot has a defensive default for older configs; the runtime schema normally supplies a number.
      reconcile_interval_seconds: (options?.omitReconcileInterval ? undefined : 1) as unknown as number,
    },
    concurrency: 2,
    // AgentSlot only calls the public connection methods mocked above.
    clientConnection: connection as unknown as ClientConnection,
  };
  return { slot: new AgentSlot(config), connection, sdk, state };
}

describe("AgentSlot", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.doUnmock("@first-tree/shared/config");
    vi.doUnmock("../cloud/observability/logger.js");
    vi.doUnmock("../runtime/bootstrap.js");
    vi.doUnmock("../runtime/session-runtime.js");
    vi.resetModules();
  });

  it("exposes identity and stays idle before start", async () => {
    const { slot, connection } = await makeSlot();

    expect(slot.name).toBe("agent-one");
    expect(slot.agentId).toBe("agent-1");
    expect(slot.getQuietGateSnapshot()).toEqual({ activeCount: 0, lastActivityMs: 0 });

    const dispatch = Reflect.get(slot, "dispatchPushedFrame");
    const sync = Reflect.get(slot, "fullStateSync");
    const reconcile = Reflect.get(slot, "reconcileNow");
    if (typeof dispatch !== "function" || typeof sync !== "function" || typeof reconcile !== "function") {
      throw new Error("private methods missing");
    }

    await dispatch.call(slot, makeFrame());
    sync.call(slot);
    reconcile.call(slot);

    expect(connection.sendSessionReconcile).not.toHaveBeenCalled();
  });

  it("returns early for human agents and leaves message processing disabled", async () => {
    const { slot, connection, state } = await makeSlot({ agent: makeAgent({ type: "human" }) });

    await expect(slot.start()).resolves.toMatchObject({ type: "human" });

    expect(connection.bindAgent).toHaveBeenCalledWith("agent-1", "claude-code", "1.2.3");
    expect(state.sessions).toHaveLength(0);
    expect(state.logger.info).toHaveBeenCalledWith("server reports type=human — message processing disabled");
  });

  it("migrates a legacy regular runtime marker before the first bound-source resolution", async () => {
    const dataDir = mkdtempSync(join(realpathSync(tmpdir()), "first-tree-agent-slot-legacy-marker-"));
    const workspace = join(dataDir, "workspaces", "agent-one");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, ".first-tree-workspace"), "legacy marker\n");
    const { slot } = await makeSlot({ dataDir });

    await expect(slot.start()).resolves.toMatchObject({ agentId: "agent-1" });
    expect(statSync(join(workspace, ".first-tree-workspace")).isDirectory()).toBe(true);
    await slot.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses to construct SessionRuntime when runtimeType is not a known RuntimeProvider", async () => {
    const { slot, connection, state } = await makeSlot({ runtimeType: "not-a-provider" });

    await expect(slot.start()).rejects.toThrow(/Unsupported agent runtime type "not-a-provider"/);

    expect(connection.bindAgent).toHaveBeenCalledWith("agent-1", "not-a-provider", "1.2.3");
    expect(connection.unbindAgent).toHaveBeenCalledWith("agent-1");
    expect(state.sessions).toHaveLength(0);
    expect(state.sessionConfigs).toHaveLength(0);
    expect(Reflect.get(slot, "sessionRuntime")).toBeNull();
  });

  it("aborts the bind immediately on a permanent (4xx) config rejection — no retry", async () => {
    const { slot, connection, sdk, state } = await makeSlot({ configError: new SdkError(403, "forbidden") });

    await expect(slot.start()).rejects.toThrow(/rejected agent config \(config_unauthorized\)/);

    // A deterministic 4xx must not be retried — exactly one fetch, then abort.
    expect(vi.mocked(sdk.fetchAgentConfig)).toHaveBeenCalledTimes(1);
    expect(connection.unbindAgent).toHaveBeenCalledWith("agent-1");
    expect(state.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ reasonCode: "config_unauthorized" }),
      "agent config fetch rejected — bind aborted",
    );
  });

  it("cleans pre-bind listeners after a failed bind so the same slot can retry", async () => {
    const { slot, connection } = await makeSlot();
    connection.bindAgent.mockRejectedValueOnce(new Error("agent:bind rejected (agent_suspended)"));

    await expect(slot.start()).rejects.toThrow("agent_suspended");

    expect(connection.unbindAgent).not.toHaveBeenCalled();
    expect(connection.listenerCount("inbox:deliver")).toBe(0);
    expect(connection.listenerCount("agent:bound")).toBe(0);
    expect(connection.listenerCount("agent:unbound")).toBe(0);
    expect(connection.listenerCount("session:reconcile:result")).toBe(0);

    await expect(slot.start()).resolves.toMatchObject({ agentId: "agent-1" });

    expect(connection.bindAgent).toHaveBeenCalledTimes(2);
    expect(connection.listenerCount("inbox:deliver")).toBe(1);
    expect(connection.listenerCount("agent:bound")).toBe(1);
    expect(connection.listenerCount("agent:unbound")).toBe(1);
    expect(connection.listenerCount("session:reconcile:result")).toBe(1);
  });

  it("self-heals a transient config fetch failure: retries with backoff, then binds", async () => {
    vi.useFakeTimers();
    const { slot, connection, sdk, state } = await makeSlot({
      configErrorsThenSucceed: { error: new SdkError(503, "boom"), times: 1 },
    });

    const startPromise = slot.start();
    // Advance past the first backoff (~1s base + jitter) so the retry runs.
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(startPromise).resolves.toMatchObject({ agentId: "agent-1" });

    expect(vi.mocked(sdk.fetchAgentConfig)).toHaveBeenCalledTimes(2);
    expect(connection.unbindAgent).not.toHaveBeenCalled();
    // SessionRuntime built → the agent is genuinely online, not a dead slot.
    expect(state.sessions).toHaveLength(1);
  });

  it("aborts a transient config backoff immediately when stop is requested", async () => {
    const { slot, sdk, state } = await makeSlot({
      configErrorsThenSucceed: { error: new SdkError(503, "boom"), times: 1 },
    });

    const startOutcome = slot.start().then(
      () => ({ ok: true }) as const,
      (err: unknown) => ({ ok: false, err }) as const,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.mocked(sdk.fetchAgentConfig)).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(state.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: 1, reasonCode: "claude_server_error" }),
        "agent config fetch failed — retrying with backoff",
      ),
    );

    const stopOutcome = slot.stop().then(
      () => ({ ok: true }) as const,
      (err: unknown) => ({ ok: false, err }) as const,
    );
    const settled = await startOutcome;
    await stopOutcome;

    expect(settled.ok).toBe(false);
    if (!settled.ok) expect((settled.err as Error).message).toContain("agent config fetch aborted");
    expect(state.sessions).toHaveLength(0);
  });

  it("aborts the bind after exhausting retries on a sustained transient failure", async () => {
    vi.useFakeTimers();
    const { slot, connection, sdk } = await makeSlot({ configError: new SdkError(503, "down") });

    const outcome = slot.start().then(
      () => ({ ok: true }) as const,
      (err: unknown) => ({ ok: false, err }) as const,
    );
    // Drain every backoff sleep; each is scheduled after the prior fetch rejects.
    await vi.advanceTimersByTimeAsync(200_000);
    await vi.advanceTimersByTimeAsync(200_000);
    const settled = await outcome;

    expect(settled.ok).toBe(false);
    if (!settled.ok) {
      expect((settled.err as Error).message).toMatch(/after \d+ attempts/);
    }
    // Bounded retry: far more than the SDK's ~1.5s transport budget, then give up.
    expect(vi.mocked(sdk.fetchAgentConfig)).toHaveBeenCalledTimes(8);
    expect(connection.unbindAgent).toHaveBeenCalledWith("agent-1");
  });

  it("does not build a session if stop() aborts while the config fetch is in flight", async () => {
    const { slot, sdk, state } = await makeSlot();
    // The server unbinds us (→ stop()) while the config fetch is in flight, and
    // the fetch then resolves successfully — the slot must NOT come online.
    vi.mocked(sdk.fetchAgentConfig).mockImplementationOnce(async () => {
      void slot.stop();
      return {
        agentId: "agent-1",
        version: 7,
        payload: {
          kind: "claude-code",
          prompt: { append: "" },
          model: "claude-sonnet",
          mcpServers: [],
          env: [],
          gitRepos: [],
          resourceSkills: [],
          reasoningEffort: "",
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
        updatedBy: "user-1",
      };
    });

    await expect(slot.start()).rejects.toThrow(/aborted — slot stopping/);
    expect(state.sessions).toHaveLength(0);
  });

  it("starts processing, dispatches pushed frames, reconciles state, and stops cleanly", async () => {
    vi.useFakeTimers();
    const { slot, connection, sdk, state } = await makeSlot({ runtimeType: "codex" });

    await expect(slot.start()).resolves.toMatchObject({ agentId: "agent-1" });

    expect(connection.bindAgent).toHaveBeenCalledWith("agent-1", "codex", "1.2.3");
    expect(state.syncCalls).toEqual([{ sdk, messages: ["sync log"] }]);
    expect(state.sessions).toHaveLength(1);
    expect(slot.getQuietGateSnapshot()).toEqual({ activeCount: 2, lastActivityMs: 123 });

    const wrongFrame = makeFrame({ inboxId: "other-inbox" });
    connection.emit("inbox:deliver", "other-inbox", wrongFrame);
    connection.emit("inbox:deliver", "inbox-1", makeFrame());
    await Promise.resolve();
    await Promise.resolve();

    const session = state.sessions[0];
    if (!session) throw new Error("session missing");
    expect(session.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 42,
        inboxId: "inbox-1",
        messageId: "msg-1",
        chatId: "chat-1",
        status: "delivered",
        retryCount: 0,
        ackedAt: null,
      }),
    );
    expect(session.dispatch).toHaveBeenCalledTimes(1);

    session.noteBindRecoveryComplete.mockClear();
    connection.emit("agent:bound", { agentId: "other-agent" });
    connection.emit("agent:bound", { agentId: "agent-1" });
    await vi.advanceTimersByTimeAsync(5000);

    expect(session.noteBindRecoveryComplete).not.toHaveBeenCalled();
    expect(connection.reportSessionState).toHaveBeenCalledWith("agent-1", "chat-1", "active");
    expect(connection.reportSessionState).toHaveBeenCalledWith("agent-1", "chat-evicted", "suspended");
    expect(connection.reportSessionRuntime).toHaveBeenCalledWith("agent-1", "chat-1", {
      runtimeState: "working",
      backgroundWork: false,
    });
    expect(connection.reportRuntimeState).toHaveBeenCalledWith("agent-1", "working");
    expect(connection.sendSessionReconcile).toHaveBeenCalledWith("agent-1", ["chat-1", "chat-2"]);

    const sessionConfig = state.sessionConfigs[0];
    if (typeof sessionConfig !== "object" || sessionConfig === null) throw new Error("session config missing");
    const ackEntry = Reflect.get(sessionConfig, "ackEntry");
    const onStateChange = Reflect.get(sessionConfig, "onStateChange");
    const onRuntimeStateChange = Reflect.get(sessionConfig, "onRuntimeStateChange");
    const onSessionEvent = Reflect.get(sessionConfig, "onSessionEvent");
    const confirmSessionEvent = Reflect.get(sessionConfig, "confirmSessionEvent");
    const onSessionRuntimeChange = Reflect.get(sessionConfig, "onSessionRuntimeChange");
    if (
      typeof ackEntry !== "function" ||
      typeof onStateChange !== "function" ||
      typeof onRuntimeStateChange !== "function" ||
      typeof onSessionEvent !== "function" ||
      typeof confirmSessionEvent !== "function" ||
      typeof onSessionRuntimeChange !== "function"
    ) {
      throw new Error("session callbacks missing");
    }
    await ackEntry(123);
    onStateChange("chat-callback", "suspended");
    onRuntimeStateChange("blocked");
    onSessionEvent("chat-callback", { type: "error", message: "oops" });
    await confirmSessionEvent("chat-callback", { type: "error", message: "oops" });
    onSessionRuntimeChange("chat-callback", { runtimeState: "error", backgroundWork: false });

    expect(connection.sendInboxAck).toHaveBeenCalledWith(123, "agent-1");
    expect(connection.reportSessionState).toHaveBeenCalledWith("agent-1", "chat-callback", "suspended");
    expect(connection.reportRuntimeState).toHaveBeenCalledWith("agent-1", "blocked");
    expect(connection.reportSessionEvent).toHaveBeenCalledWith("agent-1", "chat-callback", {
      type: "error",
      message: "oops",
    });
    expect(connection.reportSessionEventConfirmed).toHaveBeenCalledWith("agent-1", "chat-callback", {
      type: "error",
      message: "oops",
    });
    expect(connection.reportSessionRuntime).toHaveBeenCalledWith("agent-1", "chat-callback", {
      runtimeState: "error",
      backgroundWork: false,
    });

    connection.emit("session:reconcile:result", {
      agentId: "other-agent",
      staleChatIds: ["x"],
    } satisfies SessionReconcileResult);
    connection.emit("session:reconcile:result", {
      agentId: "agent-1",
      staleChatIds: ["chat-old"],
    } satisfies SessionReconcileResult);
    expect(session.applyStaleChatIds).toHaveBeenCalledWith(["chat-old"]);

    connection.emit("session:command", { agentId: "other-agent", chatId: "chat-1", type: "session:suspend" });
    connection.emit("session:command", { agentId: "agent-1", chatId: "chat-1", type: "session:suspend" });
    await Promise.resolve();
    expect(session.handleCommand).toHaveBeenCalledWith("chat-1", "session:suspend");

    await slot.stop();

    expect(connection.unbindAgent).toHaveBeenCalledWith("agent-1");
    expect(session.shutdown).toHaveBeenCalled();
    expect(state.logger.info).toHaveBeenCalledWith("stopped");

    connection.emit("inbox:deliver", "inbox-1", makeFrame({ entryId: 99 }));
    expect(session.dispatch).toHaveBeenCalledTimes(1);
  });

  it("acks a ref'd session:terminate only after handleCommand has fully resolved", async () => {
    const { slot, connection, state } = await makeSlot({ omitReconcileInterval: true });
    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");

    // No ref → legacy fire-and-forget path, never an ack.
    connection.emit("session:command", { agentId: "agent-1", chatId: "chat-1", type: "session:terminate" });
    await Promise.resolve();
    expect(session.handleCommand).toHaveBeenCalledWith("chat-1", "session:terminate");
    expect(connection.reportSessionCommandApplied).not.toHaveBeenCalled();

    // Ref'd terminate: the ack must NOT fire while the apply is in flight —
    // the server treats it as proof the provider mapping is already gone.
    const pending = deferred<void>();
    session.handleCommand.mockReturnValueOnce(pending.promise);
    connection.emit("session:command", {
      agentId: "agent-1",
      chatId: "chat-2",
      type: "session:terminate",
      ref: "ref-1",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(session.handleCommand).toHaveBeenCalledWith("chat-2", "session:terminate", { resetRef: "ref-1" });
    expect(connection.reportSessionCommandApplied).not.toHaveBeenCalled();

    pending.resolve();
    await vi.waitFor(() =>
      expect(connection.reportSessionCommandApplied).toHaveBeenCalledWith({
        ref: "ref-1",
        agentId: "agent-1",
        chatId: "chat-2",
        command: "session:terminate",
        applied: true,
      }),
    );

    // A failed apply reports applied:false — never a success ack.
    session.handleCommand.mockRejectedValueOnce(new Error("boom"));
    connection.emit("session:command", {
      agentId: "agent-1",
      chatId: "chat-3",
      type: "session:terminate",
      ref: "ref-2",
    });
    await vi.waitFor(() =>
      expect(connection.reportSessionCommandApplied).toHaveBeenCalledWith({
        ref: "ref-2",
        agentId: "agent-1",
        chatId: "chat-3",
        command: "session:terminate",
        applied: false,
      }),
    );

    await slot.stop();
  });

  it("releases parked Reset-fence recovery only after session:command:finalized", async () => {
    const { slot, connection, state } = await makeSlot({ omitReconcileInterval: true });
    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");

    session.handleCommand.mockResolvedValueOnce(undefined);
    connection.emit("session:command", {
      agentId: "agent-1",
      chatId: "chat-finalize",
      type: "session:terminate",
      ref: "ref-finalize-1",
    });
    await vi.waitFor(() =>
      expect(connection.reportSessionCommandApplied).toHaveBeenCalledWith({
        ref: "ref-finalize-1",
        agentId: "agent-1",
        chatId: "chat-finalize",
        command: "session:terminate",
        applied: true,
      }),
    );
    expect(session.releaseParkedResetFenceRecovery).not.toHaveBeenCalled();

    connection.emit("session:command:finalized", {
      type: "session:command:finalized",
      ref: "ref-finalize-1",
      ackRef: "ack-finalize-1",
      agentId: "agent-1",
      chatId: "chat-finalize",
      command: "session:terminate",
      state: "evicted",
    });
    expect(session.releaseParkedResetFenceRecovery).toHaveBeenCalledWith("chat-finalize", "ref-finalize-1");
    expect(session.releaseParkedResetFenceRecovery).toHaveBeenCalledTimes(1);
    // The server holds the Reset request open until this receipt lands.
    expect(connection.reportSessionCommandFinalizedAck).toHaveBeenCalledWith({
      ref: "ref-finalize-1",
      ackRef: "ack-finalize-1",
      agentId: "agent-1",
      chatId: "chat-finalize",
      command: "session:terminate",
      released: true,
    });

    await slot.stop();
  });

  it("reports the SessionRuntime's release verdict verbatim on the finalized receipt", async () => {
    const { slot, connection, state } = await makeSlot({ omitReconcileInterval: true });
    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");

    const finalize = (ref: string, ackRef: string, agentId = "agent-1") => {
      connection.emit("session:command:finalized", {
        type: "session:command:finalized",
        ref,
        ackRef,
        agentId,
        chatId: "chat-gen",
        command: "session:terminate",
        state: "evicted",
      });
    };

    connection.emit("session:command", {
      agentId: "agent-1",
      chatId: "chat-gen",
      type: "session:terminate",
      ref: "ref-a",
    });
    await vi.waitFor(() =>
      expect(connection.reportSessionCommandApplied).toHaveBeenCalledWith(
        expect.objectContaining({ ref: "ref-a", applied: true }),
      ),
    );

    // The slot keeps no generation bookkeeping of its own: whatever the
    // manager rules is exactly what the wire receipt says.
    session.releaseParkedResetFenceRecovery.mockReturnValueOnce("accepted");
    finalize("ref-a", "ack-a");
    expect(session.releaseParkedResetFenceRecovery).toHaveBeenCalledWith("chat-gen", "ref-a");
    expect(connection.reportSessionCommandFinalizedAck).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "ref-a", ackRef: "ack-a", released: true }),
    );

    // A duplicate for an already-released generation is still a lifted fence.
    session.releaseParkedResetFenceRecovery.mockReturnValueOnce("idempotent");
    finalize("ref-a", "ack-a-late");
    expect(connection.reportSessionCommandFinalizedAck).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "ref-a", ackRef: "ack-a-late", released: true }),
    );

    // A superseded / unknown ref is answered honestly so the server's Reset
    // fails closed instead of claiming a fence that is still up.
    session.releaseParkedResetFenceRecovery.mockReturnValueOnce("stale");
    finalize("ref-a", "ack-a-superseded");
    expect(connection.reportSessionCommandFinalizedAck).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "ref-a", ackRef: "ack-a-superseded", released: false }),
    );

    // A finalized for another agent is not ours to answer at all — the
    // manager is not even consulted.
    const consulted = session.releaseParkedResetFenceRecovery.mock.calls.length;
    finalize("ref-a", "ack-foreign", "other-agent");
    expect(session.releaseParkedResetFenceRecovery).toHaveBeenCalledTimes(consulted);
    expect(connection.reportSessionCommandFinalizedAck).not.toHaveBeenCalledWith(
      expect.objectContaining({ ackRef: "ack-foreign" }),
    );

    await slot.stop();
  });

  it("answers session:command:aborted through the same generation authority as finalized", async () => {
    // The local truth after `applied: true` is identical either way: the
    // provider session is already gone, so an abort has nothing to restore and
    // simply lifts the generation that fenced provider admission afterwards.
    // Without this listener the client would hold that fence forever whenever
    // the server failed to commit the eviction.
    const { slot, connection, state } = await makeSlot({ omitReconcileInterval: true });
    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");

    const abort = (
      ref: string,
      ackRef: string,
      reason: "reactivated" | "route_refused" | "cleanup_failed" = "reactivated",
      agentId = "agent-1",
    ) => {
      connection.emit("session:command:aborted", {
        type: "session:command:aborted",
        ref,
        ackRef,
        agentId,
        chatId: "chat-abort",
        command: "session:terminate",
        reason,
      });
    };

    connection.emit("session:command", {
      agentId: "agent-1",
      chatId: "chat-abort",
      type: "session:terminate",
      ref: "ref-abort",
    });
    await vi.waitFor(() =>
      expect(connection.reportSessionCommandApplied).toHaveBeenCalledWith(
        expect.objectContaining({ ref: "ref-abort", applied: true }),
      ),
    );
    // Applying alone releases nothing — only an exact disposition does.
    expect(session.releaseParkedResetFenceRecovery).not.toHaveBeenCalled();

    session.releaseParkedResetFenceRecovery.mockReturnValueOnce("accepted");
    abort("ref-abort", "ack-abort", "cleanup_failed");
    expect(session.releaseParkedResetFenceRecovery).toHaveBeenCalledWith("chat-abort", "ref-abort");
    expect(connection.reportSessionCommandAbortedAck).toHaveBeenCalledWith({
      ref: "ref-abort",
      ackRef: "ack-abort",
      agentId: "agent-1",
      chatId: "chat-abort",
      command: "session:terminate",
      released: true,
    });
    // The two dispositions are distinct on the wire, so a server waiting on one
    // can never be settled by the other.
    expect(connection.reportSessionCommandFinalizedAck).not.toHaveBeenCalled();

    // Duplicate → still a lifted fence; superseded/unknown → answered honestly
    // so a late abort cannot claim it released a newer generation.
    session.releaseParkedResetFenceRecovery.mockReturnValueOnce("idempotent");
    abort("ref-abort", "ack-abort-late");
    expect(connection.reportSessionCommandAbortedAck).toHaveBeenCalledWith(
      expect.objectContaining({ ackRef: "ack-abort-late", released: true }),
    );
    session.releaseParkedResetFenceRecovery.mockReturnValueOnce("stale");
    abort("ref-superseded", "ack-superseded");
    expect(connection.reportSessionCommandAbortedAck).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "ref-superseded", ackRef: "ack-superseded", released: false }),
    );

    // Another agent's abort is not this slot's to answer at all.
    const consulted = session.releaseParkedResetFenceRecovery.mock.calls.length;
    abort("ref-abort", "ack-foreign", "reactivated", "other-agent");
    expect(session.releaseParkedResetFenceRecovery).toHaveBeenCalledTimes(consulted);
    expect(connection.reportSessionCommandAbortedAck).not.toHaveBeenCalledWith(
      expect.objectContaining({ ackRef: "ack-foreign" }),
    );

    await slot.stop();
    // The listener is torn down with the slot, so a late abort cannot reach a
    // manager that no longer holds the generation it named.
    const afterStop = session.releaseParkedResetFenceRecovery.mock.calls.length;
    abort("ref-abort", "ack-after-stop");
    expect(session.releaseParkedResetFenceRecovery).toHaveBeenCalledTimes(afterStop);
  });

  it("an unref'd terminate supersedes the armed generation so its late finalized cannot release", async () => {
    const { slot, connection, state } = await makeSlot({ omitReconcileInterval: true });
    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");

    connection.emit("session:command", {
      agentId: "agent-1",
      chatId: "chat-mixed",
      type: "session:terminate",
      ref: "ref-armed",
    });
    await vi.waitFor(() =>
      expect(connection.reportSessionCommandApplied).toHaveBeenCalledWith(
        expect.objectContaining({ ref: "ref-armed", applied: true }),
      ),
    );

    // Legacy path: the server archived and finalized before sending, so it
    // carries its own authority — an EXPLICIT supersede, never the incidental
    // unref'd release that a delayed reconcile would take.
    connection.emit("session:command", { agentId: "agent-1", chatId: "chat-mixed", type: "session:terminate" });
    await vi.waitFor(() =>
      expect(session.supersedeResetGeneration).toHaveBeenCalledWith("chat-mixed", "unrefd_server_terminate"),
    );
    expect(session.releaseParkedResetFenceRecovery).not.toHaveBeenCalled();

    session.releaseParkedResetFenceRecovery.mockReturnValueOnce("stale");
    connection.emit("session:command:finalized", {
      type: "session:command:finalized",
      ref: "ref-armed",
      ackRef: "ack-armed",
      agentId: "agent-1",
      chatId: "chat-mixed",
      command: "session:terminate",
      state: "evicted",
    });
    expect(connection.reportSessionCommandFinalizedAck).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "ref-armed", released: false }),
    );

    await slot.stop();
  });

  it("refuses a ref'd Reset before applying it when the connection has no v1 Reset protocol", async () => {
    const { slot, connection, state } = await makeSlot({ omitReconcileInterval: true });
    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");
    // Old server: welcome never advertised the composite Reset capability.
    connection.supportsSessionResetV1 = false;

    connection.emit("session:command", {
      agentId: "agent-1",
      chatId: "chat-skew",
      type: "session:terminate",
      ref: "ref-skew",
    });
    await vi.waitFor(() =>
      expect(connection.reportSessionCommandApplied).toHaveBeenCalledWith({
        ref: "ref-skew",
        agentId: "agent-1",
        chatId: "chat-skew",
        command: "session:terminate",
        applied: false,
      }),
    );
    // Nothing destructive ran: no local terminate, no park to release.
    expect(session.handleCommand).not.toHaveBeenCalledWith("chat-skew", "session:terminate", expect.anything());
    expect(session.releaseParkedResetFenceRecovery).not.toHaveBeenCalled();

    // A legacy unref'd terminate is still honoured on an old server.
    connection.emit("session:command", { agentId: "agent-1", chatId: "chat-skew", type: "session:terminate" });
    await vi.waitFor(() => expect(session.handleCommand).toHaveBeenCalledWith("chat-skew", "session:terminate"));

    await slot.stop();
  });

  it("acks concurrent ref'd terminates for the same chat only after the shared apply settles", async () => {
    const { slot, connection, state } = await makeSlot({ omitReconcileInterval: true });
    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");

    // SessionRuntime coalesces a duplicate terminate onto the in-flight
    // apply; both refs must ack only after that shared work settles, and a
    // legacy unref'd terminate overlapping them never acks at all.
    const shared = deferred<void>();
    session.handleCommand.mockReturnValue(shared.promise);
    connection.emit("session:command", { agentId: "agent-1", chatId: "chat-1", type: "session:terminate" });
    connection.emit("session:command", {
      agentId: "agent-1",
      chatId: "chat-1",
      type: "session:terminate",
      ref: "ref-1",
    });
    connection.emit("session:command", {
      agentId: "agent-1",
      chatId: "chat-1",
      type: "session:terminate",
      ref: "ref-2",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(session.handleCommand).toHaveBeenCalledTimes(3);
    expect(connection.reportSessionCommandApplied).not.toHaveBeenCalled();

    shared.resolve();
    await vi.waitFor(() => expect(connection.reportSessionCommandApplied).toHaveBeenCalledTimes(2));
    expect(connection.reportSessionCommandApplied).toHaveBeenCalledWith({
      ref: "ref-1",
      agentId: "agent-1",
      chatId: "chat-1",
      command: "session:terminate",
      applied: true,
    });
    expect(connection.reportSessionCommandApplied).toHaveBeenCalledWith({
      ref: "ref-2",
      agentId: "agent-1",
      chatId: "chat-1",
      command: "session:terminate",
      applied: true,
    });

    await slot.stop();
  });

  it("acks applied:false for every ref sharing a failed terminate apply", async () => {
    const { slot, connection, state } = await makeSlot({ omitReconcileInterval: true });
    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");

    const shared = deferred<void>();
    session.handleCommand.mockReturnValue(shared.promise);
    connection.emit("session:command", {
      agentId: "agent-1",
      chatId: "chat-1",
      type: "session:terminate",
      ref: "ref-1",
    });
    connection.emit("session:command", {
      agentId: "agent-1",
      chatId: "chat-1",
      type: "session:terminate",
      ref: "ref-2",
    });
    await Promise.resolve();
    expect(connection.reportSessionCommandApplied).not.toHaveBeenCalled();

    shared.reject(new Error("boom"));
    await vi.waitFor(() => expect(connection.reportSessionCommandApplied).toHaveBeenCalledTimes(2));
    // Neither ref may report success: the shared apply failed for both.
    for (const ref of ["ref-1", "ref-2"]) {
      expect(connection.reportSessionCommandApplied).toHaveBeenCalledWith({
        ref,
        agentId: "agent-1",
        chatId: "chat-1",
        command: "session:terminate",
        applied: false,
      });
    }
    expect(connection.reportSessionCommandApplied).not.toHaveBeenCalledWith(expect.objectContaining({ applied: true }));

    await slot.stop();
  });

  it("buffers bind-time inbox pushes until the SessionRuntime exists", async () => {
    const { slot, connection, sdk, state } = await makeSlot({
      dispatchRejectEntryId: 78,
      omitReconcileInterval: true,
    });
    connection.bindAgent.mockImplementationOnce(async () => {
      connection.emit("inbox:deliver", "inbox_agent-1", makeFrame({ entryId: 77, inboxId: "inbox_agent-1" }));
      connection.emit("inbox:deliver", "inbox_agent-1", makeFrame({ entryId: 78, inboxId: "inbox_agent-1" }));
      return { agentId: "agent-1", displayName: "Agent One", agentType: "agent", sdk };
    });

    await slot.start();
    await Promise.resolve();
    await Promise.resolve();

    const session = state.sessions[0];
    if (!session) throw new Error("session missing");
    expect(session.dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: 77, inboxId: "inbox_agent-1" }));
    expect(session.dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: 78, inboxId: "inbox_agent-1" }));
    expect(state.logger.info).toHaveBeenCalledWith(
      { buffered: 2 },
      "flushing early inbox:deliver buffer — frames received during init window",
    );
    expect(state.logger.warn).toHaveBeenCalledWith(
      { err: new Error("buffered dispatch failed"), entryId: 78 },
      "buffered inbox:deliver dispatch error",
    );

    await slot.stop();
  });

  it("omits the subprocess probe when the session config disables defer-on-subprocess", async () => {
    const { slot, state } = await makeSlot({ deferSuspendOnSubprocess: false });

    await slot.start();

    const sessionConfig = state.sessionConfigs[0];
    if (typeof sessionConfig !== "object" || sessionConfig === null) throw new Error("session config missing");
    expect(Reflect.get(sessionConfig, "subprocessProbe")).toBeUndefined();

    await slot.stop();
  });

  it("uses all active server sessions for runtime revocation but the human-scoped set for reconcile", async () => {
    const { slot, connection, sdk, state } = await makeSlot({
      activeRuntimeChatIds: ["chat-1"],
      activeSessionChatIds: ["chat-1", "chat-hidden-session"],
    });

    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");

    session.runtimeStates = [
      { chatId: "chat-1", runtimeState: "working" },
      { chatId: "chat-2", runtimeState: "idle" },
    ];
    connection.reportSessionRuntime.mockClear();
    const sync = Reflect.get(slot, "fullStateSync");
    if (typeof sync !== "function") throw new Error("private method missing");
    sync.call(slot);

    expect(vi.mocked(sdk.listActiveRuntimeChatIds)).toHaveBeenCalledTimes(1);
    expect(connection.reportSessionState).toHaveBeenCalledWith("agent-1", "chat-1", "active");
    expect(connection.reportSessionState).not.toHaveBeenCalledWith("agent-1", "chat-evicted", "suspended");
    expect(connection.reportSessionRuntime).toHaveBeenCalledWith("agent-1", "chat-1", {
      runtimeState: "working",
      backgroundWork: false,
    });
    expect(connection.reportSessionRuntime).toHaveBeenCalledWith("agent-1", "chat-2", {
      runtimeState: "idle",
      backgroundWork: false,
    });
    expect(connection.reportSessionRuntime).toHaveBeenCalledWith("agent-1", "chat-hidden-session", {
      runtimeState: "idle",
      backgroundWork: false,
    });
    expect(connection.reportSessionState).not.toHaveBeenCalledWith("agent-1", "chat-hidden-session", "suspended");

    const reconcile = Reflect.get(slot, "reconcileNow");
    if (typeof reconcile !== "function") throw new Error("private method missing");

    connection.sendSessionReconcile.mockClear();
    session.heldChatIds = ["chat-1", "chat-2"];
    reconcile.call(slot);
    expect(connection.sendSessionReconcile).toHaveBeenCalledWith("agent-1", ["chat-1"]);

    connection.emit("inbox:deliver", "inbox-1", makeFrame({ chatId: "chat-2" }));
    await Promise.resolve();
    await Promise.resolve();

    connection.sendSessionReconcile.mockClear();
    reconcile.call(slot);
    expect(connection.sendSessionReconcile).toHaveBeenCalledWith("agent-1", ["chat-1", "chat-2"]);

    await slot.stop();
  });

  it("reconciles a debt-only chat via the production active-set path and applies the stale retry", async () => {
    const { slot, connection, state } = await makeSlot({ activeRuntimeChatIds: ["chat-1"] });
    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");

    // The real SessionRuntime force-keeps teardown-debt chats even when the
    // active set excludes them (pinned in session-manager tests); spy the
    // slot's manager to reproduce that contract and pin the wire path:
    // reconcileNow must pass the active runtime set through and still send
    // the debt chat.
    const manager = Reflect.get(slot, "sessionRuntime") as {
      getHeldChatIds(activeChatIds?: ReadonlySet<string> | null): string[];
    };
    const heldSpy = vi.spyOn(manager, "getHeldChatIds").mockReturnValue(["chat-debt-only"]);
    const reconcile = Reflect.get(slot, "reconcileNow");
    if (typeof reconcile !== "function") throw new Error("private method missing");

    connection.sendSessionReconcile.mockClear();
    reconcile.call(slot);
    expect(heldSpy).toHaveBeenCalledWith(new Set(["chat-1"]));
    expect(connection.sendSessionReconcile).toHaveBeenCalledWith("agent-1", ["chat-debt-only"]);

    // Server judges the debt chat stale → the client applies the strict
    // terminate retry.
    connection.emit("session:reconcile:result", {
      agentId: "agent-1",
      staleChatIds: ["chat-debt-only"],
    } satisfies SessionReconcileResult);
    expect(session.applyStaleChatIds).toHaveBeenCalledWith(["chat-debt-only"]);

    await slot.stop();
  });

  it("adopts the latest runtime SDK after a reconnect rebind", async () => {
    const { slot, connection, sdk, state } = await makeSlot({ activeRuntimeChatIds: ["chat-1"] });
    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");

    const nextSdk = makeSdk({ activeRuntimeChatIds: ["chat-2"] });
    vi.mocked(sdk.listActiveRuntimeChatIds).mockClear();
    session.reconcileReplayFencesWithServer.mockClear();

    connection.emit("agent:bound", {
      agentId: "agent-1",
      displayName: "Agent One",
      agentType: "agent",
      sdk: nextSdk,
      runtimeSessionToken: "runtime-token-2",
    });
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(vi.mocked(nextSdk.listActiveRuntimeChatIds)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sdk.listActiveRuntimeChatIds)).not.toHaveBeenCalled();
    expect(session.updateTransport).toHaveBeenCalledWith(nextSdk, expect.anything());
    expect(session.noteBindRecoveryComplete).toHaveBeenCalled();
    expect(session.reconcileReplayFencesWithServer).toHaveBeenCalledTimes(1);
    expect(session.reconcileAckSettlementAfterBind).toHaveBeenCalledTimes(1);

    await slot.stop();
  });

  it("reconciles ACK settlement on this agent's bind without using runtime-proof recovery", async () => {
    const { slot, connection, state } = await makeSlot({ activeRuntimeChatIds: ["chat-1"] });
    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");
    session.noteBindRecoveryComplete.mockClear();
    session.reconcileAckSettlementAfterBind.mockClear();
    session.reconcileReplayFencesWithServer.mockClear();

    connection.emit("agent:bound", { agentId: "other-agent" });
    expect(session.reconcileAckSettlementAfterBind).not.toHaveBeenCalled();
    expect(session.noteBindRecoveryComplete).not.toHaveBeenCalled();

    connection.emit("agent:bound", { agentId: "agent-1" });
    await Promise.resolve();

    expect(session.reconcileAckSettlementAfterBind).toHaveBeenCalledTimes(1);
    expect(session.noteBindRecoveryComplete).not.toHaveBeenCalled();
    expect(session.reconcileReplayFencesWithServer).toHaveBeenCalledTimes(1);

    await slot.stop();
  });

  it("coalesces concurrent runtime-proof failures into one agent rebind", async () => {
    const { slot, connection, sdk, state } = await makeSlot({ activeRuntimeChatIds: ["chat-1"] });
    await slot.start();
    const config = state.sessionConfigs[0] as {
      recoverRuntimeSessionProof?: (reasonCode: string) => Promise<void>;
    };
    if (!config.recoverRuntimeSessionProof) throw new Error("runtime proof recovery callback missing");

    const rebind = deferred<{
      agentId: string;
      displayName: string;
      agentType: string;
      sdk: FirstTreeHubSDK;
      runtimeSessionToken: string;
    }>();
    connection.bindAgent.mockImplementationOnce(() => rebind.promise);

    const first = config.recoverRuntimeSessionProof("runtime_session_missing");
    const second = config.recoverRuntimeSessionProof("runtime_session_invalid");
    expect(connection.bindAgent).toHaveBeenCalledTimes(2);

    rebind.resolve({
      agentId: "agent-1",
      displayName: "Agent One",
      agentType: "agent",
      sdk,
      runtimeSessionToken: "runtime-token-2",
    });
    await Promise.all([first, second]);

    await config.recoverRuntimeSessionProof("runtime_session_invalid");
    expect(connection.bindAgent).toHaveBeenCalledTimes(3);

    await slot.stop();
  });

  it("writes a stable runtime session token file that updates after a reconnect rebind", async () => {
    const tokenFile = join(realpathSync(tmpdir()), "first-tree-test-data/runtime-session-tokens/agent-1.token");
    const { slot, connection, state } = await makeSlot({
      activeRuntimeChatIds: ["chat-1"],
      runtimeSessionToken: "runtime-token-1",
    });

    try {
      await slot.start();
      expect(readFileSync(tokenFile, "utf8").trim()).toBe("runtime-token-1");
      expect((state.sessionConfigs[0] as { runtimeSessionTokenFile?: string }).runtimeSessionTokenFile).toBe(tokenFile);
      expect(connection.setRuntimeSessionTokenProvider).toHaveBeenCalledWith("agent-1", expect.any(Function));
      expect(connection.tokenProviders.get("agent-1")?.()).toBe("runtime-token-1");

      const nextSdk = makeSdk({ activeRuntimeChatIds: ["chat-1"], runtimeSessionToken: "runtime-token-2" });
      connection.emit("agent:bound", {
        agentId: "agent-1",
        displayName: "Agent One",
        agentType: "agent",
        sdk: nextSdk,
        runtimeSessionToken: "runtime-token-2",
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(readFileSync(tokenFile, "utf8").trim()).toBe("runtime-token-2");
      expect(connection.tokenProviders.get("agent-1")?.()).toBe("runtime-token-2");
    } finally {
      await slot.stop();
    }

    expect(existsSync(tokenFile)).toBe(false);
    expect(connection.clearRuntimeSessionTokenProvider).toHaveBeenCalledWith("agent-1", expect.any(Function));
    expect(connection.tokenProviders.has("agent-1")).toBe(false);
  });

  it("does not delete a newer token generation written by a replacement slot", async () => {
    const dataDir = mkdtempSync(join(realpathSync(tmpdir()), "first-tree-agent-slot-owner-"));
    const tokenFile = join(dataDir, "runtime-session-tokens", "agent-1.token");
    const { slot, connection } = await makeSlot({
      dataDir,
      activeRuntimeChatIds: ["chat-1"],
      runtimeSessionToken: "runtime-token-A",
    });
    const replacementStore = new RuntimeSessionTokenFile(tokenFile);

    try {
      await slot.start();
      replacementStore.persist("runtime-token-B");

      expect(connection.tokenProviders.get("agent-1")?.()).toBe("runtime-token-B");
      await slot.stop();

      expect(replacementStore.read()).toBe("runtime-token-B");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps a slot unavailable when the per-agent mutation lock cannot be acquired", async () => {
    const dataDir = mkdtempSync(join(realpathSync(tmpdir()), "first-tree-agent-slot-lock-"));
    const tokenFile = join(dataDir, "runtime-session-tokens", "agent-1.token");
    mkdirSync(join(dataDir, "runtime-session-tokens"), { recursive: true, mode: 0o700 });
    writeFileSync(`${tokenFile}.lock`, `${process.pid}\n`, { mode: 0o600 });
    const { slot, connection, sdk, state } = await makeSlot({
      dataDir,
      runtimeSessionToken: "runtime-token-A",
    });
    const tokenStore = Reflect.get(slot, "runtimeSessionTokenStore");
    if (typeof tokenStore !== "object" || tokenStore === null) throw new Error("runtime token store missing");
    Reflect.set(tokenStore, "lockAcquireTimeoutMs", 20);
    Reflect.set(tokenStore, "lockRetryDelayMs", 2);

    try {
      await expect(slot.start()).rejects.toThrow(/cannot become healthy/);

      expect(connection.unbindAgent).toHaveBeenCalledWith("agent-1");
      expect(vi.mocked(sdk.register)).not.toHaveBeenCalled();
      expect(state.sessions).toHaveLength(0);
      expect(existsSync(tokenFile)).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("keeps a slot unavailable when atomic token replacement fails", async () => {
    const dataDir = mkdtempSync(join(realpathSync(tmpdir()), "first-tree-agent-slot-write-"));
    const tokenFile = join(dataDir, "runtime-session-tokens", "agent-1.token");
    mkdirSync(tokenFile, { recursive: true });
    const { slot, connection, sdk, state } = await makeSlot({
      dataDir,
      runtimeSessionToken: "runtime-token-A",
    });

    try {
      await expect(slot.start()).rejects.toThrow(/cannot become healthy/);

      expect(connection.unbindAgent).toHaveBeenCalledWith("agent-1");
      expect(vi.mocked(sdk.register)).not.toHaveBeenCalled();
      expect(state.sessions).toHaveLength(0);
      expect(existsSync(`${tokenFile}.lock`)).toBe(false);
      expect(statSync(tokenFile).isDirectory()).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("failed-start cleanup preserves a generation written by a later bind", async () => {
    const dataDir = mkdtempSync(join(realpathSync(tmpdir()), "first-tree-agent-slot-failed-start-"));
    const tokenFile = join(dataDir, "runtime-session-tokens", "agent-1.token");
    const { slot, sdk } = await makeSlot({
      dataDir,
      runtimeSessionToken: "runtime-token-A",
    });
    const configFetch = deferred<never>();
    vi.mocked(sdk.fetchAgentConfig).mockImplementationOnce(() => configFetch.promise);
    const replacementStore = new RuntimeSessionTokenFile(tokenFile);

    try {
      const startPromise = slot.start();
      await vi.waitFor(() => expect(readFileSync(tokenFile, "utf8").trim()).toBe("runtime-token-A"));
      replacementStore.persist("runtime-token-B");
      configFetch.reject(new SdkError(403, "config rejected"));

      await expect(startPromise).rejects.toThrow(/rejected agent config/);
      expect(replacementStore.read()).toBe("runtime-token-B");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("failed-start cleanup removes the generation written by that slot", async () => {
    const dataDir = mkdtempSync(join(realpathSync(tmpdir()), "first-tree-agent-slot-owned-failed-start-"));
    const tokenFile = join(dataDir, "runtime-session-tokens", "agent-1.token");
    const { slot } = await makeSlot({
      dataDir,
      runtimeSessionToken: "runtime-token-A",
      configError: new SdkError(403, "config rejected"),
    });

    try {
      await expect(slot.start()).rejects.toThrow(/rejected agent config/);
      expect(existsSync(tokenFile)).toBe(false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("stops a healthy slot and preserves the file when reconnect persistence cannot lock", async () => {
    const dataDir = mkdtempSync(join(realpathSync(tmpdir()), "first-tree-agent-slot-rebind-lock-"));
    const tokenFile = join(dataDir, "runtime-session-tokens", "agent-1.token");
    const { slot, connection, state } = await makeSlot({
      dataDir,
      activeRuntimeChatIds: ["chat-1"],
      runtimeSessionToken: "runtime-token-A",
    });

    try {
      await slot.start();
      const session = state.sessions[0];
      if (!session) throw new Error("session missing");
      const tokenStore = Reflect.get(slot, "runtimeSessionTokenStore");
      if (typeof tokenStore !== "object" || tokenStore === null) throw new Error("runtime token store missing");
      Reflect.set(tokenStore, "lockAcquireTimeoutMs", 20);
      Reflect.set(tokenStore, "lockRetryDelayMs", 2);
      writeFileSync(`${tokenFile}.lock`, `${process.pid}\n`, { mode: 0o600 });
      connection.unbindAgent.mockClear();
      session.noteBindRecoveryComplete.mockClear();

      connection.emit("agent:bound", {
        agentId: "agent-1",
        displayName: "Agent One",
        agentType: "agent",
        sdk: makeSdk({ runtimeSessionToken: "runtime-token-B" }),
        runtimeSessionToken: "runtime-token-B",
      });

      await vi.waitFor(() => expect(connection.unbindAgent).toHaveBeenCalledWith("agent-1"));
      await vi.waitFor(() => expect(state.logger.info).toHaveBeenCalledWith("stopped"));
      expect(session.noteBindRecoveryComplete).not.toHaveBeenCalled();
      expect(connection.tokenProviders.has("agent-1")).toBe(false);
      expect(readFileSync(tokenFile, "utf8").trim()).toBe("runtime-token-A");
      expect(state.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        "runtime session token cleanup failed; leaving any remaining file untouched",
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("starts a fresh active-runtime-chat refresh after rebind even when the old refresh is in flight", async () => {
    const { slot, connection, sdk, state } = await makeSlot({ activeRuntimeChatIds: ["chat-1"] });
    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");
    session.sessionStates = [
      { chatId: "stale-chat", state: "active" },
      { chatId: "chat-2", state: "active" },
    ];

    const refreshActiveRuntimeChatIds = Reflect.get(slot, "refreshActiveRuntimeChatIds");
    if (typeof refreshActiveRuntimeChatIds !== "function") throw new Error("private method missing");
    const staleRefresh = deferred<{ chatIds: string[] }>();
    vi.mocked(sdk.listActiveRuntimeChatIds).mockImplementationOnce(() => staleRefresh.promise);
    const stalePromise = refreshActiveRuntimeChatIds.call(slot, "periodic") as Promise<void>;
    await Promise.resolve();

    connection.reportSessionState.mockClear();
    const nextSdk = makeSdk({ activeRuntimeChatIds: ["chat-2"], runtimeSessionToken: "runtime-token-2" });
    connection.emit("agent:bound", {
      agentId: "agent-1",
      displayName: "Agent One",
      agentType: "agent",
      sdk: nextSdk,
      runtimeSessionToken: "runtime-token-2",
    });
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(vi.mocked(nextSdk.listActiveRuntimeChatIds)).toHaveBeenCalledTimes(1);
    expect(connection.reportSessionState).toHaveBeenCalledWith("agent-1", "chat-2", "active");
    expect(connection.reportSessionState).not.toHaveBeenCalledWith("agent-1", "stale-chat", "active");

    staleRefresh.resolve({ chatIds: ["stale-chat"] });
    await stalePromise;
    await slot.stop();
  });

  it("chunks reconcile frames so a large held set never exceeds the wire schema limit", async () => {
    const chatIds = Array.from({ length: 501 }, (_, i) => `chat-${i}`);
    const { slot, connection, state } = await makeSlot({ activeRuntimeChatIds: chatIds });

    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");
    session.heldChatIds = chatIds;

    const reconcile = Reflect.get(slot, "reconcileNow");
    if (typeof reconcile !== "function") throw new Error("private method missing");
    connection.sendSessionReconcile.mockClear();
    reconcile.call(slot);

    expect(connection.sendSessionReconcile).toHaveBeenCalledTimes(2);
    expect(connection.sendSessionReconcile).toHaveBeenNthCalledWith(1, "agent-1", chatIds.slice(0, 500));
    expect(connection.sendSessionReconcile).toHaveBeenNthCalledWith(2, "agent-1", chatIds.slice(500));

    await slot.stop();
  });

  it("does not resurrect the active runtime chat refresh timer after stop", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { slot, connection, sdk } = await makeSlot({ omitReconcileInterval: true });

    await slot.start();
    expect(vi.mocked(sdk.listActiveRuntimeChatIds)).toHaveBeenCalledTimes(1);

    const refresh = deferred<{ chatIds: string[] }>();
    vi.mocked(sdk.listActiveRuntimeChatIds).mockImplementationOnce(() => refresh.promise);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(vi.mocked(sdk.listActiveRuntimeChatIds)).toHaveBeenCalledTimes(2);

    const unbind = deferred<void>();
    connection.unbindAgent.mockImplementationOnce(() => unbind.promise);
    const stopPromise = slot.stop();
    await Promise.resolve();

    refresh.resolve({ chatIds: ["chat-1"] });
    await Promise.resolve();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    expect(vi.mocked(sdk.listActiveRuntimeChatIds)).toHaveBeenCalledTimes(2);

    unbind.resolve();
    await stopPromise;
  });

  it("reschedules periodic active-runtime-chat refreshes while the slot remains live", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { slot, sdk } = await makeSlot({ omitReconcileInterval: true });

    await slot.start();
    vi.mocked(sdk.listActiveRuntimeChatIds).mockClear();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(vi.mocked(sdk.listActiveRuntimeChatIds)).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(vi.mocked(sdk.listActiveRuntimeChatIds)).toHaveBeenCalledTimes(2);

    await slot.stop();
  });

  it("keeps startup alive when active runtime chat refresh fails", async () => {
    const err = new Error("active chat list failed");
    const { slot, state } = await makeSlot({ activeRuntimeChatIdsError: err, omitReconcileInterval: true });

    await slot.start();

    expect(state.sessions).toHaveLength(1);
    expect(state.logger.warn).toHaveBeenCalledWith(
      { err, reason: "startup" },
      "active runtime chat ids refresh failed; keeping previous snapshot",
    );

    await slot.stop();
  });

  it("shuts down sessions even when unbind fails during stop", async () => {
    const { slot, connection, state } = await makeSlot();

    await slot.start();
    const err = new Error("unbind failed");
    connection.unbindAgent.mockRejectedValueOnce(err);

    await expect(
      slot.stop("runtime switched by server", {
        sessionShutdown: {
          clearPersistedRegistry: true,
          reportSuspendedSessions: false,
        },
      }),
    ).rejects.toThrow("unbind failed");

    const session = state.sessions[0];
    if (!session) throw new Error("session missing");
    expect(session.shutdown).toHaveBeenCalledWith("runtime switched by server", {
      clearPersistedRegistry: true,
      reportSuspendedSessions: false,
    });
    expect(state.logger.warn).toHaveBeenCalledWith({ err }, "failed to unbind agent while stopping");
    expect(state.logger.info).toHaveBeenCalledWith("stopped");
  });

  it("surfaces session shutdown failures and still unbinds afterward", async () => {
    const { slot, connection, state } = await makeSlot();
    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");
    const err = new Error("shutdown failed");
    session.shutdown.mockRejectedValueOnce(err);

    await expect(slot.stop("operator stop")).rejects.toThrow("shutdown failed");

    expect(session.shutdown).toHaveBeenCalled();
    expect(connection.unbindAgent).toHaveBeenCalledWith("agent-1");
    const shutdownOrder = session.shutdown.mock.invocationCallOrder[0];
    const unbindOrder = connection.unbindAgent.mock.invocationCallOrder[0];
    const clearOrder = connection.clearRuntimeSessionTokenProvider.mock.invocationCallOrder[0];
    expect(shutdownOrder).toBeTypeOf("number");
    expect(unbindOrder).toBeTypeOf("number");
    expect(clearOrder).toBeTypeOf("number");
    expect(shutdownOrder as number).toBeLessThan(unbindOrder as number);
    // Proof provider must outlive SM.shutdown so notice HTTP can still resolve
    // the current runtime-session token during drain.
    expect(shutdownOrder as number).toBeLessThan(clearOrder as number);
    expect(state.logger.warn).toHaveBeenCalledWith({ err }, "failed to shut down sessions while stopping");
    expect(state.logger.info).toHaveBeenCalledWith("stopped");
  });

  it("keeps the runtime-session token provider registered while sessionRuntime.shutdown runs", async () => {
    const { slot, connection, state } = await makeSlot({
      activeRuntimeChatIds: ["chat-1"],
      runtimeSessionToken: "runtime-token-live",
    });
    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");

    const seenDuringShutdown: Array<string | undefined> = [];
    session.shutdown.mockImplementationOnce(async () => {
      seenDuringShutdown.push(connection.tokenProviders.get("agent-1")?.());
    });

    await slot.stop("agent_runtime_switch");

    expect(seenDuringShutdown).toEqual(["runtime-token-live"]);
    expect(connection.tokenProviders.has("agent-1")).toBe(false);
    const shutdownOrder = session.shutdown.mock.invocationCallOrder[0] as number;
    const clearOrder = connection.clearRuntimeSessionTokenProvider.mock.invocationCallOrder[0] as number;
    expect(shutdownOrder).toBeLessThan(clearOrder);
  });

  it("logs a forced-stop failure raised by a server unbind event", async () => {
    const { slot, connection, state } = await makeSlot();
    await slot.start();
    const err = new Error("forced unbind failed");
    connection.unbindAgent.mockRejectedValueOnce(err);

    connection.emit("agent:unbound", "agent-1", "agent_suspended");

    await vi.waitFor(() =>
      expect(state.logger.warn).toHaveBeenCalledWith({ err }, "failed to unbind agent while stopping"),
    );
    await vi.waitFor(() =>
      expect(state.logger.error).toHaveBeenCalledWith({ err, reason: "agent_suspended" }, "forced agent stop failed"),
    );
  });

  it("starts the bind-time reconcile grace window after startup full state sync", async () => {
    vi.useFakeTimers();
    const { slot, connection, sdk } = await makeSlot({ syncDelayMs: 4_900, omitReconcileInterval: true });
    connection.bindAgent.mockImplementationOnce(async () => {
      connection.emit("agent:bound", { agentId: "agent-1" });
      return { agentId: "agent-1", displayName: "Agent One", agentType: "agent", sdk };
    });

    const startPromise = slot.start();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(4_900);
    await expect(startPromise).resolves.toMatchObject({ agentId: "agent-1" });

    expect(connection.reportSessionState).toHaveBeenCalledWith("agent-1", "chat-evicted", "suspended");
    expect(connection.sendSessionReconcile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(connection.sendSessionReconcile).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4_900);
    expect(connection.sendSessionReconcile).toHaveBeenCalledWith("agent-1", ["chat-1", "chat-2"]);

    await slot.stop();
  });

  it("logs cleanup unbind failures after an aborted post-bind start", async () => {
    const { slot, connection, sdk, state } = await makeSlot({ configError: new SdkError(403, "forbidden") });
    const err = new Error("cleanup unbind failed");
    connection.unbindAgent.mockRejectedValueOnce(err);

    await expect(slot.start()).rejects.toThrow(/rejected agent config/);

    expect(vi.mocked(sdk.fetchAgentConfig)).toHaveBeenCalledTimes(1);
    expect(state.logger.warn).toHaveBeenCalledWith({ err }, "failed to unbind after aborted agent start");
  });

  it("stops only the matching slot when the server force-unbounds an agent", async () => {
    const { slot, connection, state } = await makeSlot();
    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");

    connection.emit("agent:unbound", "other-agent", "agent_suspended");
    await Promise.resolve();
    expect(connection.unbindAgent).not.toHaveBeenCalled();
    expect(session.shutdown).not.toHaveBeenCalled();

    connection.emit("agent:unbound", "agent-1", "agent_suspended");
    await Promise.resolve();
    await Promise.resolve();

    expect(connection.unbindAgent).toHaveBeenCalledWith("agent-1");
    expect(session.shutdown).toHaveBeenCalled();
    connection.emit("inbox:deliver", "inbox-1", makeFrame({ entryId: 99 }));
    expect(session.dispatch).not.toHaveBeenCalled();
  });

  it("uses destructive shutdown for a runtime-switch force unbind before pinned reconfigure joins the stop", async () => {
    const { slot, connection, state } = await makeSlot();
    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");

    const shutdown = deferred<void>();
    const unbind = deferred<void>();
    session.shutdown.mockImplementationOnce(() => shutdown.promise);
    connection.unbindAgent.mockImplementationOnce(() => unbind.promise);

    connection.emit("agent:unbound", "agent-1", "agent_runtime_switch");
    await Promise.resolve();

    const joinedStop = slot.stop("runtime switched by server", {
      sessionShutdown: {
        clearPersistedRegistry: true,
        reportSuspendedSessions: false,
      },
    });
    await Promise.resolve();
    // Session settlement runs before unbind so provider-entered custody can ACK.
    expect(session.shutdown).toHaveBeenCalledTimes(1);
    expect(connection.unbindAgent).not.toHaveBeenCalled();

    shutdown.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(connection.unbindAgent).toHaveBeenCalledWith("agent-1");

    unbind.resolve();
    await joinedStop;

    expect(session.shutdown).toHaveBeenCalledTimes(1);
    // AgentSlot forwards the diagnostic reason; SessionRuntime maps full graceful
    // drain to handler.shutdown(..., { settleProviderEntered: true }) independently
    // of that string (see pi-session-custody runtime-switch regressions).
    expect(session.shutdown).toHaveBeenCalledWith("agent_runtime_switch", {
      clearPersistedRegistry: true,
      reportSuspendedSessions: false,
    });
  });

  it("logs optional context-tree, push-dispatch, and session-command failures without crashing", async () => {
    const { slot, connection, state } = await makeSlot({ syncResult: null, omitReconcileInterval: true });
    await slot.start();
    const session = state.sessions[0];
    if (!session) throw new Error("session missing");
    session.dispatch.mockRejectedValueOnce(new Error("dispatch failed"));
    session.handleCommand.mockRejectedValueOnce(new Error("command failed"));
    session.aggregateRuntimeState = null;
    session.heldChatIds = [];

    connection.emit("inbox:deliver", "inbox-1", makeFrame({ entryId: 55 }));
    connection.emit("session:command", { agentId: "agent-1", chatId: "chat-2", type: "session:terminate" });
    await Promise.resolve();
    await Promise.resolve();

    const sync = Reflect.get(slot, "fullStateSync");
    const reconcile = Reflect.get(slot, "reconcileNow");
    if (typeof sync !== "function" || typeof reconcile !== "function") throw new Error("private methods missing");
    sync.call(slot);
    reconcile.call(slot);

    expect(state.logger.info).toHaveBeenCalledWith(
      { reason: "unknown" },
      "context source unresolved — agent will start without organizational context",
    );
    expect(state.logger.warn).toHaveBeenCalledWith(
      { err: new Error("dispatch failed"), entryId: 55 },
      "inbox:deliver dispatch error",
    );
    expect(state.logger.error).toHaveBeenCalledWith(
      { err: new Error("command failed"), chatId: "chat-2", type: "session:terminate" },
      "session command error",
    );
    expect(connection.reportRuntimeState).toHaveBeenCalledWith("agent-1", "idle");
    expect(connection.sendSessionReconcile).not.toHaveBeenCalled();
  });
});
