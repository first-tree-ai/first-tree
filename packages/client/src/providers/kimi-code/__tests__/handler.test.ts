import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CreateSessionOptions,
  Event as KimiEvent,
  KimiHarnessOptions,
  ResumeSessionInput,
  SessionUsage,
} from "@botiverse/kimi-code-sdk";
import type { AgentRuntimeConfigPayload, SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCtxPlumbing } from "../../../__tests__/test-helpers.js";
import type { DeliveryToken, SessionContext, SessionMessage, TurnOutcome } from "../../../runtime/handler.js";
import { noopDeliveryToken } from "../../../runtime/handler.js";
import type { ReplayFenceEntry } from "../../../runtime/replay-fence.js";
import { createKimiCodeHandler, formatKimiCodeError, kimiToolIsReadOnly } from "../index.js";

class FakeSession {
  readonly id: string;
  readonly scripts: KimiEvent[][];
  readonly prompts: string[] = [];
  readonly listeners = new Set<(event: KimiEvent) => void>();
  readonly setPermission = vi.fn().mockResolvedValue(undefined);
  readonly setModel = vi.fn().mockResolvedValue(undefined);
  readonly cancel = vi.fn().mockResolvedValue(undefined);
  readonly close = vi.fn().mockResolvedValue(undefined);
  usage: SessionUsage = {
    currentTurn: { inputOther: 11, inputCacheCreation: 2, inputCacheRead: 3, output: 5 },
  };

  constructor(id: string, scripts: KimiEvent[][]) {
    this.id = id;
    this.scripts = scripts;
  }

  onEvent(listener: (event: KimiEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(input: string): Promise<void> {
    this.prompts.push(input);
    const events = this.scripts.shift();
    if (!events) throw new Error("fake Kimi session called more times than scripted");
    for (const event of events) {
      await invokeAuthorizeHook(this.id, event);
      for (const listener of this.listeners) listener(event);
    }
  }

  async getUsage(): Promise<SessionUsage> {
    return this.usage;
  }
}

type GlobalBeforeToolCall = (info: {
  sessionId?: string;
  agentId?: string;
  toolName: string;
  toolCallId: string;
  args: unknown;
}) => Promise<void> | void;

// Invokes the handler-registered global pre-effect hook exactly where the
// patched SDK's awaited authorizeToolExecution boundary would call it:
// before the tool task starts. Returns false when the hook blocked the call.
async function invokeAuthorizeHook(sessionId: string, value: KimiEvent): Promise<boolean> {
  if (value.type !== "tool.call.started") return true;
  const hook = (globalThis as { __firstTreeBeforeToolCall?: GlobalBeforeToolCall }).__firstTreeBeforeToolCall;
  if (!hook) return true;
  try {
    await hook({
      sessionId,
      agentId: value.agentId,
      toolName: value.name,
      toolCallId: value.toolCallId,
      args: value.args,
    });
    return true;
  } catch {
    return false;
  }
}

// Test-controlled session: `prompt()` records the input and returns without
// emitting anything; tests push events through `emit()` to model subagent
// streams that outlive the prompt call, which a synchronous script cannot.
class GatedFakeSession extends FakeSession {
  private promptSeenResolve: () => void = () => {};
  readonly promptSeen: Promise<void>;

  constructor(id: string) {
    super(id, []);
    this.promptSeen = new Promise((resolvePromise) => {
      this.promptSeenResolve = resolvePromise;
    });
  }

  emit(value: KimiEvent): void {
    void invokeAuthorizeHook(this.id, value);
    for (const listener of this.listeners) listener(value);
  }

  override async prompt(input: string): Promise<void> {
    this.prompts.push(input);
    this.promptSeenResolve();
  }
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
}

// Models the patched SDK's pre-effect contract: the awaited authorize hook
// runs BEFORE the tool task starts; a hook throw blocks the tool so its
// effect never runs (the blocked call still emits its tool.call event, like
// the SDK's settleError path), while an allowed unsafe call counts as an
// executed effect.
class EffectGateFakeSession extends FakeSession {
  effectCount = 0;
  private readonly scriptEvents: KimiEvent[];

  constructor(id: string, scriptEvents: KimiEvent[]) {
    super(id, []);
    this.scriptEvents = scriptEvents;
  }

  override async prompt(input: string): Promise<void> {
    this.prompts.push(input);
    for (const value of this.scriptEvents) {
      const allowed = await invokeAuthorizeHook(this.id, value);
      if (value.type === "tool.call.started" && allowed && !kimiToolIsReadOnly(value.name, value.args)) {
        this.effectCount += 1;
      }
      for (const listener of this.listeners) listener(value);
    }
  }
}

function event(sessionId: string, value: Record<string, unknown>): KimiEvent {
  return { agentId: "main", sessionId, ...value } as KimiEvent;
}

function childEvent(sessionId: string, agentId: string, value: Record<string, unknown>): KimiEvent {
  return { agentId, sessionId, ...value } as KimiEvent;
}

function successfulTurn(sessionId: string, text = "done"): KimiEvent[] {
  return [
    event(sessionId, { type: "turn.started", turnId: 1 }),
    event(sessionId, { type: "thinking.delta", turnId: 1, delta: "private reasoning" }),
    event(sessionId, {
      type: "tool.call.started",
      turnId: 1,
      toolCallId: "tool-1",
      name: "Read",
      args: { path: "AGENTS.md" },
    }),
    event(sessionId, { type: "tool.result", turnId: 1, toolCallId: "tool-1", output: "briefing" }),
    event(sessionId, { type: "assistant.delta", turnId: 1, delta: text }),
    event(sessionId, { type: "turn.ended", turnId: 1, reason: "completed" }),
  ];
}

function failedTurn(
  sessionId: string,
  code: string,
  options: { retryable?: boolean; beforeError?: KimiEvent[] } = {},
): KimiEvent[] {
  const error = {
    code,
    message: code,
    ...(options.retryable === undefined ? {} : { retryable: options.retryable }),
  };
  return [
    event(sessionId, { type: "turn.started", turnId: 1 }),
    ...(options.beforeError ?? []),
    event(sessionId, { type: "error", ...error }),
    event(sessionId, { type: "turn.ended", turnId: 1, reason: "failed", error }),
  ];
}

function makeToken(
  opts: { completeResult?: "settled" | "retry" } = {},
): DeliveryToken & { completed: TurnOutcome[]; retried: string[] } {
  const completed: TurnOutcome[] = [];
  const retried: string[] = [];
  return {
    completed,
    retried,
    processingStarted: () => {},
    complete: async (_messages, outcome) => {
      completed.push(outcome);
      return opts.completeResult;
    },
    retry: (_messages, reason) => void retried.push(reason),
    terminalRejected: async () => {},
  };
}

function message(id: string, content: string): SessionMessage {
  return { id, chatId: "chat-kimi", senderId: "human-1", format: "text", content, metadata: {} };
}

function makeContext(
  events: SessionEvent[],
  opts: { getAgentContextTreeConfig?: () => Promise<unknown> } = {},
): SessionContext {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  return {
    agent: {
      agentId: "agent-kimi",
      inboxId: "inbox-kimi",
      displayName: "kimi-assistant",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: {
      serverUrl: "https://first-tree.test",
      sendMessage,
      ...(opts.getAgentContextTreeConfig ? { getAgentContextTreeConfig: opts.getAgentContextTreeConfig } : {}),
    } as unknown as SessionContext["sdk"],
    chatId: "chat-kimi",
    log: () => {},
    recordProviderActivity: () => {},
    noteTurnStart: () => {},
    emitEvent: (value) => void events.push(value),
    ...mockCtxPlumbing({ sendMessage }, "chat-kimi"),
  };
}

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "kimi-handler-test-"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function makeHandler(
  fakeSession: FakeSession,
  captures: { create?: CreateSessionOptions; resume?: ResumeSessionInput },
  extraConfig: Record<string, unknown> = {},
) {
  const fakeKaos = {
    withCwd: vi.fn().mockReturnThis(),
    withEnv: vi.fn().mockReturnThis(),
  };
  return createKimiCodeHandler({
    workspaceRoot,
    agentName: "kimi-test-agent",
    runtimeProvider: "kimi-code",
    kimiKaosFactory: async () => fakeKaos,
    replayFence: makeFence(),
    kimiHarnessFactory: () => ({
      createSession: async (options: CreateSessionOptions) => {
        captures.create = options;
        return fakeSession;
      },
      resumeSession: async (input: ResumeSessionInput) => {
        captures.resume = input;
        return fakeSession;
      },
      close: async () => {},
    }),
    ...extraConfig,
  });
}

type FakeFence = {
  entries: ReplayFenceEntry[];
  fence: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
};

function makeFence(): FakeFence {
  const fence: FakeFence = {
    entries: [],
    fence: vi.fn((entry: ReplayFenceEntry) => {
      fence.entries.push(entry);
    }),
    clear: vi.fn((chatId: string, messageId: string) => {
      const index = fence.entries.findIndex((entry) => entry.chatId === chatId && entry.messageId === messageId);
      if (index >= 0) fence.entries.splice(index, 1);
    }),
  };
  return fence;
}

function unsafeWriteTurn(sessionId: string, text = "wrote file"): KimiEvent[] {
  return [
    event(sessionId, { type: "turn.started", turnId: 1 }),
    event(sessionId, {
      type: "tool.call.started",
      turnId: 1,
      toolCallId: "write-1",
      name: "Write",
      args: { path: "marker.txt", content: "INTERRUPT_UNSAFE_ONCE" },
    }),
    event(sessionId, { type: "tool.result", turnId: 1, toolCallId: "write-1", output: "ok" }),
    event(sessionId, { type: "assistant.delta", turnId: 1, delta: text }),
    event(sessionId, { type: "turn.ended", turnId: 1, reason: "completed" }),
  ];
}

describe("Kimi Code handler", () => {
  it("creates a yolo session with the standing role contract and translates a successful turn", async () => {
    const fakeSession = new FakeSession("kimi-session-1", [successfulTurn("kimi-session-1", "hello from Kimi")]);
    const captures: { create?: CreateSessionOptions } = {};
    const handler = makeHandler(fakeSession, captures);
    const events: SessionEvent[] = [];
    const token = makeToken();

    const result = await handler.start(message("m1", "do work"), makeContext(events), token);

    expect(result).toMatchObject({ sessionId: "kimi-session-1", route: { kind: "owned", mode: "processing" } });
    expect(captures.create).toMatchObject({
      workDir: workspaceRoot,
      permission: "yolo",
      drainAgentTasksOnStop: true,
    });
    expect(captures.create).not.toHaveProperty("model");
    expect(captures.create).not.toHaveProperty("mcpServers");
    expect(captures.create?.roleAdditional).toContain("First Tree");
    expect(fakeSession.prompts).toEqual(["[From: human-1]\n\ndo work"]);
    expect(events.some((item) => item.kind === "thinking")).toBe(true);
    expect(events).toContainEqual({ kind: "assistant_text", payload: { text: "hello from Kimi" } });
    expect(events).toContainEqual({
      kind: "token_usage",
      payload: {
        provider: "kimi-code",
        model: "kimi-default",
        inputTokens: 13,
        cachedInputTokens: 3,
        outputTokens: 5,
      },
    });
    expect(events.at(-1)).toEqual({ kind: "turn_end", payload: { status: "success" } });
    expect(token.completed).toEqual([{ status: "success" }]);
  });

  it("injects every managed MCP transport directly into createSession", async () => {
    const fakeSession = new FakeSession("kimi-session-mcp", [successfulTurn("kimi-session-mcp")]);
    const captures: { create?: CreateSessionOptions } = {};
    const payload: AgentRuntimeConfigPayload = {
      kind: "kimi-code",
      prompt: { append: "" },
      model: "",
      mcpServers: [
        { name: "docs", transport: "stdio", command: "docs-server", args: ["--stdio"] },
        {
          name: "remote",
          transport: "http",
          url: "https://mcp.example.test/rpc",
          headers: { "X-Test": "http" },
        },
        {
          name: "events",
          transport: "sse",
          url: "https://mcp.example.test/events",
          headers: { "X-Test": "sse" },
        },
      ],
      env: [],
      gitRepos: [],
      resourceSkills: [],
    };
    const events: SessionEvent[] = [];
    const handler = makeHandler(fakeSession, captures, {
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
    });

    await handler.start(message("m1", "use managed tools"), makeContext(events), makeToken());

    expect(captures.create).toHaveProperty("mcpServers", {
      docs: { transport: "stdio", command: "docs-server", args: ["--stdio"] },
      remote: {
        transport: "http",
        url: "https://mcp.example.test/rpc",
        headers: { "X-Test": "http" },
      },
      events: {
        transport: "sse",
        url: "https://mcp.example.test/events",
        headers: { "X-Test": "sse" },
      },
    });
    expect(
      events.some(
        (item) => item.kind === "error" && item.payload.source === "runtime" && /MCP/.test(item.payload.message),
      ),
    ).toBe(false);
  });

  it("resumes with roleAdditional/kaos and reapplies explicit model plus permission", async () => {
    const fakeSession = new FakeSession("kimi-session-2", [successfulTurn("kimi-session-2")]);
    const captures: { resume?: ResumeSessionInput } = {};
    const payload = {
      kind: "kimi-code" as const,
      prompt: { append: "" },
      model: "kimi-for-coding",
      mcpServers: [{ name: "docs", transport: "stdio" as const, command: "docs-server" }],
      env: [],
      gitRepos: [],
      resourceSkills: [],
    };
    const handler = createKimiCodeHandler({
      workspaceRoot,
      agentName: "kimi-test-agent",
      runtimeProvider: "kimi-code",
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
      kimiKaosFactory: async () => ({ withCwd: vi.fn().mockReturnThis(), withEnv: vi.fn().mockReturnThis() }),
      kimiHarnessFactory: () => ({
        createSession: async () => fakeSession,
        resumeSession: async (input: ResumeSessionInput) => {
          captures.resume = input;
          return fakeSession;
        },
        close: async () => {},
      }),
    });

    await handler.resume(message("m2", "continue"), "kimi-session-2", makeContext([]), makeToken());

    expect(captures.resume).toMatchObject({ id: "kimi-session-2", drainAgentTasksOnStop: true });
    expect(captures.resume).toHaveProperty("mcpServers", {
      docs: { transport: "stdio", command: "docs-server" },
    });
    expect(captures.resume?.roleAdditional).toContain("First Tree");
    expect(fakeSession.setPermission).toHaveBeenCalledWith("yolo");
    expect(fakeSession.setModel).toHaveBeenCalledWith("kimi-for-coding");
  });

  it("does not pass declared but unmaterialized workspace repos as SDK additional directories", async () => {
    const fakeSession = new FakeSession("kimi-session-unmaterialized", [successfulTurn("kimi-session-unmaterialized")]);
    const captures: { create?: CreateSessionOptions } = {};
    const payload: AgentRuntimeConfigPayload = {
      kind: "kimi-code",
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [],
      gitRepos: [{ url: "https://example.com/acme/missing-source.git", localPath: "missing-source" }],
      resourceSkills: [],
    };
    const contextTreePath = join(workspaceRoot, "context-tree");
    const handler = createKimiCodeHandler({
      workspaceRoot,
      agentName: "kimi-test-agent",
      runtimeProvider: "kimi-code",
      contextTreePath,
      contextTreeRepoUrl: "https://example.com/acme/context-tree.git",
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
      kimiKaosFactory: async () => ({ withCwd: vi.fn().mockReturnThis(), withEnv: vi.fn().mockReturnThis() }),
      kimiHarnessFactory: () => ({
        createSession: async (options: CreateSessionOptions) => {
          captures.create = options;
          return fakeSession;
        },
        resumeSession: async () => fakeSession,
        close: async () => {},
      }),
    });

    await handler.start(message("m1", "materialize the declared repos"), makeContext([]), makeToken());

    expect(captures.create?.workDir).toBe(workspaceRoot);
    expect(captures.create?.additionalDirs).toEqual([]);
  });

  it.each([
    "provider.connection_error",
    "provider.rate_limit",
  ] as const)("never retries %s after a write even when a later tool is read-only", async (errorCode) => {
    vi.useFakeTimers();
    const id = "kimi-session-unsafe-replay";
    const fakeSession = new FakeSession(id, [
      failedTurn(id, errorCode, {
        retryable: true,
        beforeError: [
          event(id, {
            type: "tool.call.started",
            turnId: 1,
            toolCallId: "write-1",
            name: "Write",
            args: { path: "changed.txt", content: "changed" },
          }),
          event(id, { type: "tool.result", turnId: 1, toolCallId: "write-1", output: "ok" }),
          event(id, {
            type: "tool.call.started",
            turnId: 1,
            toolCallId: "read-1",
            name: "Read",
            args: { path: "changed.txt" },
          }),
          event(id, { type: "tool.result", turnId: 1, toolCallId: "read-1", output: "changed" }),
        ],
      }),
      successfulTurn(id, "must not run"),
    ]);
    const handler = makeHandler(fakeSession, {});
    const token = makeToken();

    const turn = handler.start(message("m1", "write once"), makeContext([]), token);
    await vi.runAllTimersAsync();
    await turn;

    expect(fakeSession.prompts).toHaveLength(1);
    expect(token.completed).toMatchObject([{ status: "error", completion: "consumed", reason: "unsafe_replay" }]);
  });

  it("retries a retryable Kimi rate limit before side effects", async () => {
    vi.useFakeTimers();
    const id = "kimi-session-rate-limit";
    const fakeSession = new FakeSession(id, [
      failedTurn(id, "provider.rate_limit", { retryable: true }),
      successfulTurn(id, "recovered"),
    ]);
    const handler = makeHandler(fakeSession, {});
    const token = makeToken();

    const turn = handler.start(message("m1", "retry safely"), makeContext([]), token);
    await vi.waitFor(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
    await vi.runAllTimersAsync();
    await turn;

    expect(fakeSession.prompts).toHaveLength(2);
    expect(token.completed).toEqual([{ status: "success" }]);
  });

  it.each([
    "permission",
    "model",
  ] as const)("closes the resumed session and harness when %s initialization fails", async (failurePoint) => {
    const fakeSession = new FakeSession("kimi-session-init-failure", []);
    const harnessClose = vi.fn().mockResolvedValue(undefined);
    if (failurePoint === "permission") {
      fakeSession.setPermission.mockRejectedValueOnce(new Error("permission setup failed"));
    } else {
      fakeSession.setModel.mockRejectedValueOnce(new Error("model setup failed"));
    }
    const payload: AgentRuntimeConfigPayload = {
      kind: "kimi-code",
      prompt: { append: "" },
      model: "kimi-for-coding",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
    };
    const handler = createKimiCodeHandler({
      workspaceRoot,
      agentName: "kimi-test-agent",
      runtimeProvider: "kimi-code",
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
      kimiKaosFactory: async () => ({ withCwd: vi.fn().mockReturnThis(), withEnv: vi.fn().mockReturnThis() }),
      kimiHarnessFactory: () => ({
        createSession: async () => fakeSession,
        resumeSession: async () => fakeSession,
        close: harnessClose,
      }),
    });

    await expect(handler.resume(undefined, fakeSession.id, makeContext([]), noopDeliveryToken())).rejects.toThrow(
      `${failurePoint} setup failed`,
    );

    expect(fakeSession.close).toHaveBeenCalledTimes(1);
    expect(harnessClose).toHaveBeenCalledTimes(1);
    await handler.shutdown();
    expect(fakeSession.close).toHaveBeenCalledTimes(1);
    expect(harnessClose).toHaveBeenCalledTimes(1);
  });

  it("turns a typed Kimi auth failure into a terminal provider event and login hint", async () => {
    const id = "kimi-session-auth";
    const error = {
      code: "auth.login_required",
      message: "Login required",
      retryable: false,
    };
    const fakeSession = new FakeSession(id, [
      [
        event(id, { type: "turn.started", turnId: 1 }),
        event(id, { type: "error", ...error }),
        event(id, { type: "turn.ended", turnId: 1, reason: "failed", error }),
      ],
    ]);
    const handler = makeHandler(fakeSession, {});
    const events: SessionEvent[] = [];
    const token = makeToken();

    await handler.start(message("m1", "hello"), makeContext(events), token);

    expect(
      events.some(
        (item) =>
          item.kind === "error" &&
          item.payload.source === "runtime" &&
          item.payload.message.startsWith("provider.retry:"),
      ),
    ).toBe(true);
    expect(
      events.some(
        (item) => item.kind === "error" && item.payload.source === "sdk" && item.payload.message.includes("/login"),
      ),
    ).toBe(true);
    expect(token.completed).toMatchObject([{ status: "error", completion: "consumed" }]);
  });

  it("falls back to a cumulative-total delta when the SDK omits currentTurn", async () => {
    const fakeSession = new FakeSession("kimi-session-usage", [successfulTurn("kimi-session-usage")]);
    let usageRead = 0;
    fakeSession.getUsage = async () => {
      usageRead += 1;
      return {
        total:
          usageRead === 1
            ? { inputOther: 10, inputCacheCreation: 2, inputCacheRead: 3, output: 4 }
            : { inputOther: 25, inputCacheCreation: 5, inputCacheRead: 7, output: 10 },
      };
    };
    const handler = makeHandler(fakeSession, {});
    const events: SessionEvent[] = [];

    await handler.start(message("m1", "usage"), makeContext(events), makeToken());

    expect(events).toContainEqual({
      kind: "token_usage",
      payload: {
        provider: "kimi-code",
        model: "kimi-default",
        inputTokens: 18,
        cachedInputTokens: 4,
        outputTokens: 6,
      },
    });
  });
});

describe("Kimi background subagent lifecycle", () => {
  it("holds the parent turn open across a child stream and completes exactly once", async () => {
    const id = "kimi-session-subagent";
    const fakeSession = new FakeSession(id, [
      [
        event(id, { type: "turn.started", turnId: 1 }),
        childEvent(id, "sub-1", { type: "turn.started", turnId: 2 }),
        childEvent(id, "sub-1", { type: "thinking.delta", turnId: 2, delta: "child reasoning" }),
        childEvent(id, "sub-1", { type: "assistant.delta", turnId: 2, delta: "child leaked text" }),
        childEvent(id, "sub-1", {
          type: "tool.call.started",
          turnId: 2,
          toolCallId: "child-tool-1",
          name: "Write",
          args: { path: "child-out.txt", content: "from child" },
        }),
        childEvent(id, "sub-1", { type: "tool.result", turnId: 2, toolCallId: "child-tool-1", output: "ok" }),
        // The child ends first; this must not settle the parent attempt.
        childEvent(id, "sub-1", { type: "turn.ended", turnId: 2, reason: "completed" }),
        event(id, { type: "assistant.delta", turnId: 1, delta: "parent answer" }),
        event(id, { type: "turn.ended", turnId: 1, reason: "completed" }),
      ],
    ]);
    const handler = makeHandler(fakeSession, {});
    const events: SessionEvent[] = [];
    const token = makeToken();

    await handler.start(message("m1", "run a background subagent"), makeContext(events), token);

    const assistantTexts = events.filter((item) => item.kind === "assistant_text").map((item) => item.payload.text);
    expect(assistantTexts).toEqual(["parent answer"]);
    const toolCalls = events.filter((item) => item.kind === "tool_call");
    expect(toolCalls).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ toolUseId: "sub-1:child-tool-1", name: "Write", status: "pending" }),
      }),
    );
    expect(toolCalls).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ toolUseId: "sub-1:child-tool-1", status: "ok" }),
      }),
    );
    expect(events.filter((item) => item.kind === "turn_end")).toEqual([
      { kind: "turn_end", payload: { status: "success" } },
    ]);
    expect(token.completed).toEqual([{ status: "success" }]);
  });

  it("keeps the delivery pending when a child turn.ended arrives before any main terminal event", async () => {
    const id = "kimi-session-subagent-gate";
    const fakeSession = new GatedFakeSession(id);
    const handler = makeHandler(fakeSession, {});
    const events: SessionEvent[] = [];
    const token = makeToken();
    let settled = false;
    const startPromise = handler
      .start(message("m1", "run a background subagent"), makeContext(events), token)
      .then((result) => {
        settled = true;
        return result;
      });

    await fakeSession.promptSeen;
    fakeSession.emit(childEvent(id, "sub-1", { type: "turn.started", turnId: 2 }));
    fakeSession.emit(childEvent(id, "sub-1", { type: "assistant.delta", turnId: 2, delta: "child text" }));
    fakeSession.emit(childEvent(id, "sub-1", { type: "turn.ended", turnId: 2, reason: "completed" }));
    // The prompt call has returned and every emitted event has been processed;
    // a handler that lets child completion settle the attempt would resolve here.
    await flushAsyncWork();

    expect(settled).toBe(false);
    expect(token.completed).toEqual([]);
    expect(token.retried).toEqual([]);
    expect(events.filter((item) => item.kind === "turn_end")).toEqual([]);
    expect(events.some((item) => item.kind === "assistant_text")).toBe(false);

    fakeSession.emit(event(id, { type: "assistant.delta", turnId: 1, delta: "parent answer" }));
    fakeSession.emit(event(id, { type: "turn.ended", turnId: 1, reason: "completed" }));
    const result = await startPromise;

    expect(result).toMatchObject({ sessionId: id, route: { kind: "owned", mode: "processing" } });
    const assistantTexts = events.filter((item) => item.kind === "assistant_text").map((item) => item.payload.text);
    expect(assistantTexts).toEqual(["parent answer"]);
    expect(events.filter((item) => item.kind === "turn_end")).toEqual([
      { kind: "turn_end", payload: { status: "success" } },
    ]);
    expect(token.completed).toEqual([{ status: "success" }]);
  });

  it("keeps parallel child tool-call ids collision-safe while main ids stay raw", async () => {
    const id = "kimi-session-parallel-subagents";
    const fakeSession = new FakeSession(id, [
      [
        event(id, { type: "turn.started", turnId: 1 }),
        childEvent(id, "sub-a", {
          type: "tool.call.started",
          turnId: 2,
          toolCallId: "dup",
          name: "Write",
          args: { path: "a.txt", content: "a" },
        }),
        childEvent(id, "sub-b", {
          type: "tool.call.started",
          turnId: 3,
          toolCallId: "dup",
          name: "Write",
          args: { path: "b.txt", content: "b" },
        }),
        event(id, {
          type: "tool.call.started",
          turnId: 1,
          toolCallId: "main-1",
          name: "Read",
          args: { path: "a.txt" },
        }),
        childEvent(id, "sub-a", { type: "tool.result", turnId: 2, toolCallId: "dup", output: "ok a" }),
        childEvent(id, "sub-b", { type: "tool.result", turnId: 3, toolCallId: "dup", output: "ok b" }),
        event(id, { type: "tool.result", turnId: 1, toolCallId: "main-1", output: "a" }),
        childEvent(id, "sub-a", { type: "turn.ended", turnId: 2, reason: "completed" }),
        childEvent(id, "sub-b", { type: "turn.ended", turnId: 3, reason: "completed" }),
        event(id, { type: "assistant.delta", turnId: 1, delta: "both done" }),
        event(id, { type: "turn.ended", turnId: 1, reason: "completed" }),
      ],
    ]);
    const handler = makeHandler(fakeSession, {});
    const events: SessionEvent[] = [];
    const token = makeToken();

    await handler.start(message("m1", "run two background subagents"), makeContext(events), token);

    const settled = events.flatMap((item) =>
      item.kind === "tool_call" && item.payload.status === "ok"
        ? [[item.payload.toolUseId, item.payload.resultPreview]]
        : [],
    );
    expect(settled).toEqual([
      ["sub-a:dup", "ok a"],
      ["sub-b:dup", "ok b"],
      ["main-1", "a"],
    ]);
    expect(events.filter((item) => item.kind === "turn_end")).toEqual([
      { kind: "turn_end", payload: { status: "success" } },
    ]);
    expect(token.completed).toEqual([{ status: "success" }]);
  });

  it("ignores a child failure for parent settlement when the main turn still completes", async () => {
    const id = "kimi-session-subagent-failure";
    const failure = { code: "provider.rate_limit", message: "child rate limited", retryable: false };
    const fakeSession = new FakeSession(id, [
      [
        event(id, { type: "turn.started", turnId: 1 }),
        childEvent(id, "sub-1", { type: "error", ...failure }),
        childEvent(id, "sub-1", { type: "turn.ended", turnId: 2, reason: "failed", error: failure }),
        event(id, { type: "assistant.delta", turnId: 1, delta: "parent survived" }),
        event(id, { type: "turn.ended", turnId: 1, reason: "completed" }),
      ],
    ]);
    const handler = makeHandler(fakeSession, {});
    const events: SessionEvent[] = [];
    const token = makeToken();

    await handler.start(message("m1", "tolerate a failed subagent"), makeContext(events), token);

    expect(events).toContainEqual({ kind: "assistant_text", payload: { text: "parent survived" } });
    expect(events.some((item) => item.kind === "error")).toBe(false);
    expect(events.filter((item) => item.kind === "turn_end")).toEqual([
      { kind: "turn_end", payload: { status: "success" } },
    ]);
    expect(token.completed).toEqual([{ status: "success" }]);
  });

  it("installs the dependency patch that applies drainAgentTasksOnStop on resume", () => {
    // The pinned SDK only honors drainAgentTasksOnStop on the create path; the
    // pnpm patch makes resume symmetrical. The SDK core session cannot be
    // constructed without a full runtime, so this guard resolves the exact
    // installed artifact the client package loads and pins the two behavior
    // sites: threading the flag into the resumed core session options and
    // applying it to the resumed main agent.
    const require = createRequire(import.meta.url);
    const sdkEntry = require.resolve("@botiverse/kimi-code-sdk");
    const source = readFileSync(sdkEntry, "utf8");
    expect(source).toContain("drainAgentTasksOnStop: input.drainAgentTasksOnStop");
    expect(source).toMatch(
      /getReadyAgent\("main"\);\s*\n\s*if \(main !== void 0 && this\.options\.drainAgentTasksOnStop\)/,
    );
    // The awaited authorize boundary must invoke the host pre-effect hook,
    // and agents must carry session/agent identity for hook routing.
    expect(source).toContain("__firstTreeBeforeToolCall");
    expect(source).toContain("agent.sessionId = this.options.id");
  });
});

describe("Kimi replay fence", () => {
  it("fences the delivery at the first unsafe tool start and clears it after settled completion", async () => {
    const id = "kimi-session-fence-success";
    const fence = makeFence();
    const fakeSession = new FakeSession(id, [unsafeWriteTurn(id)]);
    const handler = makeHandler(fakeSession, {}, { replayFence: fence });
    const token = makeToken();

    await handler.start(message("m1", "write the marker"), makeContext([]), token);

    expect(fence.fence).toHaveBeenCalledTimes(1);
    expect(fence.clear).toHaveBeenCalledWith("chat-kimi", "m1");
    expect(fence.entries).toEqual([]);
    expect(token.completed).toEqual([{ status: "success" }]);
  });

  it("fences on the resume path with the same create/resume custody", async () => {
    const id = "kimi-session-fence-resume";
    const fence = makeFence();
    const fakeSession = new FakeSession(id, [unsafeWriteTurn(id)]);
    const handler = makeHandler(fakeSession, {}, { replayFence: fence });
    const token = makeToken();

    await handler.resume(message("m2", "continue writing"), id, makeContext([]), token);

    expect(fence.fence).toHaveBeenCalledTimes(1);
    expect(fence.clear).toHaveBeenCalledWith("chat-kimi", "m2");
    expect(fence.entries).toEqual([]);
    expect(token.completed).toEqual([{ status: "success" }]);
  });

  it("records the child-prefixed tool id when a subagent's write starts first", async () => {
    const id = "kimi-session-fence-child";
    const fence = makeFence();
    const fakeSession = new FakeSession(id, [
      [
        event(id, { type: "turn.started", turnId: 1 }),
        childEvent(id, "agent-0", {
          type: "tool.call.started",
          turnId: 2,
          toolCallId: "tool_childwrite",
          name: "Bash",
          args: { command: "echo INTERRUPT_UNSAFE_ONCE >> marker.txt" },
        }),
        childEvent(id, "agent-0", { type: "tool.result", turnId: 2, toolCallId: "tool_childwrite", output: "ok" }),
        childEvent(id, "agent-0", { type: "turn.ended", turnId: 2, reason: "completed" }),
        event(id, { type: "assistant.delta", turnId: 1, delta: "child wrote" }),
        event(id, { type: "turn.ended", turnId: 1, reason: "completed" }),
      ],
    ]);
    const handler = makeHandler(fakeSession, {}, { replayFence: fence });
    const token = makeToken();

    await handler.start(message("m1", "run a background writer"), makeContext([]), token);

    expect(fence.fence).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-kimi",
        messageId: "m1",
        provider: "kimi-code",
        toolName: "Bash",
        toolUseId: "agent-0:tool_childwrite",
      }),
    );
    expect(fence.entries).toEqual([]);
    expect(token.completed).toEqual([{ status: "success" }]);
  });

  it("keeps the fence when the turn is interrupted instead of settled", async () => {
    const id = "kimi-session-fence-interrupt";
    const fence = makeFence();
    const fakeSession = new GatedFakeSession(id);
    fakeSession.cancel.mockImplementation(async () => {
      fakeSession.emit(event(id, { type: "turn.ended", turnId: 1, reason: "cancelled" }));
    });
    const handler = makeHandler(fakeSession, {}, { replayFence: fence });
    const events: SessionEvent[] = [];
    const token = makeToken();
    const startPromise = handler.start(message("m1", "write then hang"), makeContext(events), token);

    await fakeSession.promptSeen;
    fakeSession.emit(event(id, { type: "turn.started", turnId: 1 }));
    fakeSession.emit(
      event(id, {
        type: "tool.call.started",
        turnId: 1,
        toolCallId: "write-1",
        name: "Write",
        args: { path: "marker.txt", content: "INTERRUPT_UNSAFE_ONCE" },
      }),
    );
    await flushAsyncWork();
    expect(fence.entries).toHaveLength(1);

    await handler.suspend("process_crash_simulation");
    await startPromise;

    // No settlement happened, so nothing may clear the fence and nothing may
    // be ACKed: the delivery stays recovery debt for the restart gate.
    expect(token.completed).toEqual([]);
    expect(token.retried).toContain("kimi_turn_cancelled");
    expect(fence.clear).not.toHaveBeenCalled();
    expect(fence.entries).toHaveLength(1);
  });

  it("blocks the unsafe effect and retains custody when the fence cannot be persisted", async () => {
    const id = "kimi-session-fence-failure";
    const fence = makeFence();
    fence.fence.mockImplementation(() => {
      throw new Error("disk full");
    });
    const fakeSession = new EffectGateFakeSession(id, unsafeWriteTurn(id));
    const handler = makeHandler(fakeSession, {}, { replayFence: fence });
    const events: SessionEvent[] = [];
    const token = makeToken();

    await handler.start(message("m1", "write the marker"), makeContext(events), token);

    // The marked throw aborts the SDK tool dispatch before the effect runs,
    // and the retryable classification retains delivery custody instead of
    // ACKing: redelivery is safe because effect count is provably zero.
    expect(fakeSession.effectCount).toBe(0);
    expect(token.completed).toEqual([]);
    expect(token.retried).toContain("replay_fence_persist_failed");
    expect(events.some((item) => item.kind === "assistant_text")).toBe(false);
    expect(events.filter((item) => item.kind === "turn_end")).toEqual([]);
  });

  it("keeps blocking every later unsafe call after a fence persistence failure", async () => {
    const id = "kimi-session-fence-double";
    const fence = makeFence();
    fence.fence.mockImplementation(() => {
      throw new Error("disk full");
    });
    const fakeSession = new EffectGateFakeSession(id, [
      event(id, { type: "turn.started", turnId: 1 }),
      event(id, {
        type: "tool.call.started",
        turnId: 1,
        toolCallId: "write-1",
        name: "Write",
        args: { path: "one.txt", content: "one" },
      }),
      event(id, { type: "tool.result", turnId: 1, toolCallId: "write-1", isError: true, output: "blocked" }),
      // The model reacts to the blocked result with a second unsafe call:
      // without the fail-closed guard this would take the fast path and run.
      event(id, {
        type: "tool.call.started",
        turnId: 1,
        toolCallId: "write-2",
        name: "Write",
        args: { path: "two.txt", content: "two" },
      }),
      event(id, { type: "tool.result", turnId: 1, toolCallId: "write-2", isError: true, output: "blocked" }),
      event(id, { type: "assistant.delta", turnId: 1, delta: "both blocked" }),
      event(id, { type: "turn.ended", turnId: 1, reason: "completed" }),
    ]);
    const handler = makeHandler(fakeSession, {}, { replayFence: fence });
    const token = makeToken();

    await handler.start(message("m1", "write twice"), makeContext([]), token);

    expect(fakeSession.effectCount).toBe(0);
    // The second call hit the fenceError fast path and never attempted a
    // write again — proof it did not silently become "authorized".
    expect(fence.fence).toHaveBeenCalledTimes(1);
    expect(token.completed).toEqual([]);
    expect(token.retried).toContain("replay_fence_persist_failed");
  });

  it("rolls back a partial fence so a failed multi-message persist authorizes nothing", async () => {
    const id = "kimi-session-fence-partial";
    const fence = makeFence();
    const originalFence = fence.fence.getMockImplementation();
    fence.fence.mockImplementation((entry: ReplayFenceEntry) => {
      if (entry.messageId === "m3") throw new Error("disk full on second message");
      originalFence?.(entry);
    });
    const fakeSession = new GatedFakeSession(id);
    const handler = makeHandler(fakeSession, {}, { replayFence: fence });
    const events: SessionEvent[] = [];
    const token1 = makeToken();
    const token2 = makeToken();
    const token3 = makeToken();
    const startPromise = handler.start(message("m1", "first turn"), makeContext(events), token1);

    await fakeSession.promptSeen;
    // Two more deliveries arrive while the first turn is active; they merge
    // into ONE fused turn whose messages share a single fence batch.
    expect(handler.inject(message("m2", "queued two"), token2)).toEqual({ kind: "owned", mode: "queued" });
    expect(handler.inject(message("m3", "queued three"), token3)).toEqual({ kind: "owned", mode: "queued" });
    fakeSession.emit(event(id, { type: "turn.started", turnId: 1 }));
    fakeSession.emit(event(id, { type: "assistant.delta", turnId: 1, delta: "first done" }));
    fakeSession.emit(event(id, { type: "turn.ended", turnId: 1, reason: "completed" }));
    await startPromise;
    expect(token1.completed).toEqual([{ status: "success" }]);

    // The fused turn's prompt arrives after the drain; drive its events
    // explicitly: an unsafe call whose fence persists for m2 but fails for
    // m3 — the m2 entry must be rolled back, and the following unsafe call
    // must stay blocked.
    await vi.waitFor(() => expect(fakeSession.prompts).toHaveLength(2));
    fakeSession.emit(event(id, { type: "turn.started", turnId: 2 }));
    fakeSession.emit(
      event(id, {
        type: "tool.call.started",
        turnId: 2,
        toolCallId: "write-1",
        name: "Write",
        args: { path: "partial.txt", content: "x" },
      }),
    );
    fakeSession.emit(
      event(id, { type: "tool.result", turnId: 2, toolCallId: "write-1", isError: true, output: "blocked" }),
    );
    fakeSession.emit(
      event(id, {
        type: "tool.call.started",
        turnId: 2,
        toolCallId: "write-2",
        name: "Write",
        args: { path: "partial2.txt", content: "x" },
      }),
    );
    fakeSession.emit(
      event(id, { type: "tool.result", turnId: 2, toolCallId: "write-2", isError: true, output: "blocked" }),
    );
    fakeSession.emit(event(id, { type: "turn.ended", turnId: 2, reason: "completed" }));
    await flushAsyncWork();

    expect(fence.clear).toHaveBeenCalledWith("chat-kimi", "m2");
    expect(fence.entries).toEqual([]);
    expect(token2.completed).toEqual([]);
    expect(token2.retried).toContain("replay_fence_persist_failed");
    expect(token3.completed).toEqual([]);
  });

  it("settles through the durable-notice pipeline when the fence failure is non-retryable", async () => {
    const id = "kimi-session-fence-config";
    const fence = makeFence();
    fence.fence.mockImplementation(() => {
      throw new Error("bad config: replay fence store layout unsupported");
    });
    const fakeSession = new EffectGateFakeSession(id, unsafeWriteTurn(id));
    const handler = makeHandler(fakeSession, {}, { replayFence: fence });
    const events: SessionEvent[] = [];
    const token = makeToken();

    await handler.start(message("m1", "write the marker"), makeContext(events), token);

    expect(fakeSession.effectCount).toBe(0);
    // Terminal settlement goes through the provider-attempt pipeline: the
    // provider.retry event is what SessionRuntime turns into the durable
    // chat-visible runtime notice before the consumed ACK.
    expect(
      events.some(
        (item) =>
          item.kind === "error" &&
          item.payload.source === "runtime" &&
          item.payload.message.startsWith("provider.retry:"),
      ),
    ).toBe(true);
    expect(events.some((item) => item.kind === "assistant_text")).toBe(false);
    expect(events.filter((item) => item.kind === "turn_end")).toEqual([
      { kind: "turn_end", payload: { status: "error" } },
    ]);
    expect(token.completed).toEqual([
      { status: "error", completion: "consumed", reason: "replay_fence_persist_failed" },
    ]);
  });

  it("retains custody when no replay fence store is configured", async () => {
    const id = "kimi-session-fence-missing";
    const fakeSession = new EffectGateFakeSession(id, unsafeWriteTurn(id));
    const handler = makeHandler(fakeSession, {}, { replayFence: undefined });
    const events: SessionEvent[] = [];
    const token = makeToken();

    await handler.start(message("m1", "write the marker"), makeContext(events), token);

    expect(fakeSession.effectCount).toBe(0);
    expect(token.completed).toEqual([]);
    expect(token.retried).toContain("replay_fence_persist_failed");
    expect(events.some((item) => item.kind === "assistant_text")).toBe(false);
  });

  it("keeps the fence when the completion disposition retains server custody", async () => {
    const id = "kimi-session-fence-ack-retry";
    const fence = makeFence();
    const fakeSession = new FakeSession(id, [unsafeWriteTurn(id)]);
    const handler = makeHandler(fakeSession, {}, { replayFence: fence });
    const token = makeToken({ completeResult: "retry" });

    await handler.start(message("m1", "write the marker"), makeContext([]), token);

    // The ACK did not commit (disposition "retry"), so the fence must
    // survive: a later crash-redelivery of this delivery would otherwise
    // replay the write.
    expect(token.completed).toEqual([{ status: "success" }]);
    expect(fence.clear).not.toHaveBeenCalled();
    expect(fence.entries).toHaveLength(1);
  });

  it("does not require the fence store for a read-only turn", async () => {
    const id = "kimi-session-fence-readonly";
    const fakeSession = new FakeSession(id, [successfulTurn(id, "read only ok")]);
    const handler = makeHandler(fakeSession, {}, { replayFence: undefined });
    const token = makeToken();

    await handler.start(message("m1", "read things"), makeContext([]), token);

    expect(token.completed).toEqual([{ status: "success" }]);
  });
});

describe("Kimi homeDir lifecycle", () => {
  it.each([
    "start",
    "resume",
  ] as const)("rejects a Context source change during harness replacement before native %s", async (operation) => {
    const firstSession = new FakeSession("source-first", [successfulTurn("source-first")]);
    const secondSession = new FakeSession("source-second", [successfulTurn("source-second")]);
    let authoritativeRemote = false;
    let factoryCalls = 0;
    let nativeCreateCalls = 0;
    let nativeResumeCalls = 0;
    let markCloseEntered: (() => void) | undefined;
    let releaseClose: (() => void) | undefined;
    const closeEntered = new Promise<void>((resolve) => {
      markCloseEntered = resolve;
    });
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const payload = {
      kind: "kimi-code" as const,
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [{ key: "KIMI_CODE_HOME", value: "/old/kimi" }],
      gitRepos: [],
      resourceSkills: [],
    };
    const handler = createKimiCodeHandler({
      workspaceRoot,
      agentName: "kimi-test-agent",
      runtimeProvider: "kimi-code",
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
      kimiKaosFactory: async () => ({ withCwd: vi.fn().mockReturnThis(), withEnv: vi.fn().mockReturnThis() }),
      kimiHarnessFactory: () => {
        factoryCalls += 1;
        const activeSession = factoryCalls === 1 ? firstSession : secondSession;
        return {
          createSession: async () => {
            nativeCreateCalls += 1;
            return activeSession;
          },
          resumeSession: async () => {
            nativeResumeCalls += 1;
            return activeSession;
          },
          close:
            factoryCalls === 1
              ? async () => {
                  markCloseEntered?.();
                  await closeGate;
                }
              : async () => {},
        };
      },
    });
    const contextOptions = {
      getAgentContextTreeConfig: async () =>
        authoritativeRemote
          ? {
              bindingState: "bound" as const,
              repo: "https://github.com/acme/new-tree.git",
              branch: "main",
              provider: "github" as const,
            }
          : { bindingState: "invalid" as const, repo: null, branch: null, provider: null },
    };

    await handler.start(message("source-initial", "first"), makeContext([], contextOptions), makeToken());
    await handler.suspend("test");
    payload.env = [{ key: "KIMI_CODE_HOME", value: "/new/kimi" }];
    const token = makeToken();
    const transition =
      operation === "start"
        ? handler.start(message("source-next", "next"), makeContext([], contextOptions), token)
        : handler.resume(message("source-next", "next"), "source-first", makeContext([], contextOptions), token);
    await closeEntered;
    authoritativeRemote = true;
    releaseClose?.();

    await expect(transition).rejects.toMatchObject({ name: "ContextSourceTransitionError" });
    expect(nativeCreateCalls).toBe(1);
    expect(nativeResumeCalls).toBe(0);
    expect(token.completed).toEqual([]);
    expect(token.retried).toEqual([]);
    await handler.shutdown();
  });

  it("normalizes trimmed KIMI_CODE_HOME and forwards it as harness homeDir", async () => {
    const harnessOptions: KimiHarnessOptions[] = [];
    const payload = {
      kind: "kimi-code" as const,
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [{ key: "KIMI_CODE_HOME", value: "  /custom/kimi  " }],
      gitRepos: [],
      resourceSkills: [],
    };
    const handler = createKimiCodeHandler({
      workspaceRoot,
      agentName: "kimi-test-agent",
      runtimeProvider: "kimi-code",
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
      kimiKaosFactory: async () => ({ withCwd: vi.fn().mockReturnThis(), withEnv: vi.fn().mockReturnThis() }),
      kimiHarnessFactory: (options: KimiHarnessOptions) => {
        harnessOptions.push(options);
        return {
          createSession: async () => new FakeSession("s1", [successfulTurn("s1")]),
          resumeSession: async () => new FakeSession("s1", [successfulTurn("s1")]),
          close: async () => {},
        };
      },
    });

    await handler.start(message("m1", "hi"), makeContext([]), makeToken());

    expect(harnessOptions).toHaveLength(1);
    expect(harnessOptions.at(0)?.homeDir).toBe("/custom/kimi");
  });

  it.each(["", "   "])("omits homeDir when KIMI_CODE_HOME is %j", async (rawValue) => {
    const harnessOptions: KimiHarnessOptions[] = [];
    const payload = {
      kind: "kimi-code" as const,
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [{ key: "KIMI_CODE_HOME", value: rawValue }],
      gitRepos: [],
      resourceSkills: [],
    };
    const handler = createKimiCodeHandler({
      workspaceRoot,
      agentName: "kimi-test-agent",
      runtimeProvider: "kimi-code",
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
      kimiKaosFactory: async () => ({ withCwd: vi.fn().mockReturnThis(), withEnv: vi.fn().mockReturnThis() }),
      kimiHarnessFactory: (options: KimiHarnessOptions) => {
        harnessOptions.push(options);
        return {
          createSession: async () => new FakeSession("s1", [successfulTurn("s1")]),
          resumeSession: async () => new FakeSession("s1", [successfulTurn("s1")]),
          close: async () => {},
        };
      },
    });

    await handler.start(message("m1", "hi"), makeContext([]), makeToken());

    expect(harnessOptions).toHaveLength(1);
    expect(harnessOptions[0]).not.toHaveProperty("homeDir");
  });

  it("reuses the same harness after suspend when effective home is unchanged", async () => {
    const session = new FakeSession("shared-session", [
      successfulTurn("shared-session"),
      successfulTurn("shared-session"),
    ]);
    let factoryCalls = 0;
    const closeFn = vi.fn().mockResolvedValue(undefined);
    const payload = {
      kind: "kimi-code" as const,
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [{ key: "KIMI_CODE_HOME", value: "/custom/kimi" }],
      gitRepos: [],
      resourceSkills: [],
    };
    const handler = createKimiCodeHandler({
      workspaceRoot,
      agentName: "kimi-test-agent",
      runtimeProvider: "kimi-code",
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
      kimiKaosFactory: async () => ({ withCwd: vi.fn().mockReturnThis(), withEnv: vi.fn().mockReturnThis() }),
      kimiHarnessFactory: () => {
        factoryCalls++;
        return {
          createSession: async () => session,
          resumeSession: async () => session,
          close: closeFn,
        };
      },
    });

    await handler.start(message("m1", "hi"), makeContext([]), makeToken());
    expect(factoryCalls).toBe(1);
    expect(closeFn).not.toHaveBeenCalled();

    await handler.suspend("test");
    expect(closeFn).not.toHaveBeenCalled();

    await handler.resume(message("m2", "resume"), "shared-session", makeContext([]), makeToken());
    expect(factoryCalls).toBe(1);
    expect(closeFn).not.toHaveBeenCalled();
  });

  it("reuses the default harness across resume when KIMI_CODE_HOME is unset", async () => {
    const session = new FakeSession("default-session", [
      successfulTurn("default-session"),
      successfulTurn("default-session"),
    ]);
    let factoryCalls = 0;
    const closeFn = vi.fn().mockResolvedValue(undefined);
    const payload = {
      kind: "kimi-code" as const,
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
    };
    const handler = createKimiCodeHandler({
      workspaceRoot,
      agentName: "kimi-test-agent",
      runtimeProvider: "kimi-code",
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
      kimiKaosFactory: async () => ({ withCwd: vi.fn().mockReturnThis(), withEnv: vi.fn().mockReturnThis() }),
      kimiHarnessFactory: () => {
        factoryCalls++;
        return {
          createSession: async () => session,
          resumeSession: async () => session,
          close: closeFn,
        };
      },
    });

    await handler.start(message("m1", "hi"), makeContext([]), makeToken());
    expect(factoryCalls).toBe(1);

    await handler.suspend("test");
    expect(closeFn).not.toHaveBeenCalled();

    await handler.resume(message("m2", "resume"), "default-session", makeContext([]), makeToken());
    expect(factoryCalls).toBe(1);
    expect(closeFn).not.toHaveBeenCalled();
  });

  it("closes old harness before creating a replacement when home changes across suspend/resume", async () => {
    const firstSession = new FakeSession("s-1", [successfulTurn("s-1")]);
    const secondSession = new FakeSession("s-2", [successfulTurn("s-2")]);
    let factoryCalls = 0;
    const homes: (string | undefined)[] = [];
    let resolveClose: (() => void) | undefined;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    const payload = {
      kind: "kimi-code" as const,
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [{ key: "KIMI_CODE_HOME", value: "/old/kimi" }],
      gitRepos: [],
      resourceSkills: [],
    };
    const handler = createKimiCodeHandler({
      workspaceRoot,
      agentName: "kimi-test-agent",
      runtimeProvider: "kimi-code",
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
      kimiKaosFactory: async () => ({ withCwd: vi.fn().mockReturnThis(), withEnv: vi.fn().mockReturnThis() }),
      kimiHarnessFactory: (options: KimiHarnessOptions) => {
        factoryCalls++;
        homes.push(options.homeDir);
        return {
          createSession: async () => (factoryCalls === 1 ? firstSession : secondSession),
          resumeSession: async () => (factoryCalls === 2 ? secondSession : firstSession),
          close:
            factoryCalls === 1
              ? async () => {
                  await closePromise;
                }
              : async () => {},
        };
      },
    });

    await handler.start(message("m1", "hi"), makeContext([]), makeToken());
    expect(factoryCalls).toBe(1);
    expect(homes).toEqual(["/old/kimi"]);

    // Simulate operator correcting KIMI_CODE_HOME after a credential/config failure.
    payload.env = [{ key: "KIMI_CODE_HOME", value: "/new/kimi" }];

    await handler.suspend("test");

    // Kick off resume; the second harness factory must not fire before
    // the first harness's close promise resolves.
    const resumePromise = handler.resume(message("m2", "resume"), "s-1", makeContext([]), makeToken());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(factoryCalls).toBe(1);
    expect(homes).toEqual(["/old/kimi"]);

    if (resolveClose) resolveClose();
    await resumePromise;

    expect(factoryCalls).toBe(2);
    expect(homes).toEqual(["/old/kimi", "/new/kimi"]);
  });
});

describe("Kimi provider helpers", () => {
  it("only treats reads and proven read-only Bash commands as replay safe", () => {
    expect(kimiToolIsReadOnly("Read", { path: "NODE.md" })).toBe(true);
    expect(kimiToolIsReadOnly("Bash", { command: "cat NODE.md" })).toBe(true);
    expect(kimiToolIsReadOnly("Write", { path: "NODE.md" })).toBe(false);
    expect(kimiToolIsReadOnly("Bash", { command: "touch changed" })).toBe(false);
  });

  it("formats typed auth errors with the official Kimi login recovery", () => {
    const error = new Error("Login required") as Error & { code: string };
    error.code = "auth.login_required";
    expect(formatKimiCodeError(error)).toContain("`kimi` and then `/login`");
  });
});
