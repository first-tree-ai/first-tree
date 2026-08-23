import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProviderRetryEventPayload, parseProviderRetryEventMessage, type SessionEvent } from "@first-tree/shared";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const BILLING_RESULT = "Failed to authenticate. API Error: 403 Insufficient account balance.";
const TRANSIENT_RESULT =
  "API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
const mockState = vi.hoisted(() => ({
  nextMessages: [] as unknown[],
  messagesByAttempt: [] as unknown[][],
  queryCalls: 0,
  observedInputMessages: [] as Array<{ attempt: number; content: string }>,
  observedQueryOptions: [] as Array<{ attempt: number; sessionId?: string; resume?: string }>,
  inputDrainLimitByAttempt: [] as number[],
  resultGateByAttempt: [] as Array<Promise<void> | undefined>,
  configVersion: 1,
  promptAppend: "",
  configModel: "",
  setModelCalls: 0,
  throwQueryOnCall: 0,
  closeCalls: [] as number[],
  lifecycleEvents: [] as string[],
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  const drainPrompt = async (
    prompt: AsyncIterable<{ message?: { content?: unknown } }>,
    attempt: number,
    limit: number,
  ) => {
    let drained = 0;
    for await (const sdkMsg of prompt) {
      const content = sdkMsg.message?.content;
      mockState.observedInputMessages.push({
        attempt,
        content: typeof content === "string" ? content : JSON.stringify(content),
      });
      drained += 1;
      if (drained >= limit) break;
    }
  };
  return {
    query: (args: {
      prompt: AsyncIterable<{ message?: { content?: unknown } }>;
      options?: { sessionId?: string; resume?: string };
    }) => {
      mockState.queryCalls += 1;
      const attempt = mockState.queryCalls;
      if (attempt === mockState.throwQueryOnCall) {
        throw new Error("config restart query construction failed");
      }
      const messages = (mockState.messagesByAttempt[attempt - 1] ?? mockState.nextMessages).slice();
      const sessionId = args.options?.sessionId;
      const resume = args.options?.resume;
      mockState.observedQueryOptions.push({
        attempt,
        ...(typeof sessionId === "string" ? { sessionId } : {}),
        ...(typeof resume === "string" ? { resume } : {}),
      });
      void drainPrompt(args.prompt, attempt, mockState.inputDrainLimitByAttempt[attempt - 1] ?? 1);
      return {
        [Symbol.asyncIterator]() {
          let idx = 0;
          return {
            next: async () => {
              if (idx === 0) await mockState.resultGateByAttempt[attempt - 1];
              if (idx < messages.length) {
                const value = messages[idx];
                idx += 1;
                return { done: false, value };
              }
              return { done: true, value: undefined };
            },
          };
        },
        close: () => {
          mockState.closeCalls.push(attempt);
          mockState.lifecycleEvents.push(`close:${attempt}`);
        },
        setModel: async () => {
          mockState.setModelCalls += 1;
        },
      };
    },
  };
});

import { mockCtxPlumbing } from "../../../__tests__/test-helpers.js";
import { createAgentConfigCache } from "../../../runtime/agent-config-cache.js";
import type { SessionContext, TurnOutcome } from "../../../runtime/handler.js";
import { deliveryTokenFromSessionContext } from "../../../runtime/handler.js";
import { formatProviderFailureRuntimeNotice } from "../../../runtime/runtime-notice.js";
import { createClaudeCodeHandler } from "../index.js";

const AGENT_ID = "019ef431-0000-7000-9000-000000000002";

let workspaceRoot: string;

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
});

beforeEach(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  workspaceRoot = mkdtempSync(join(realpathSync(tmpdir()), "ftt-claude-provider-error-"));
  mockState.messagesByAttempt.length = 0;
  mockState.observedQueryOptions.length = 0;
  mockState.inputDrainLimitByAttempt.length = 0;
  mockState.resultGateByAttempt.length = 0;
  mockState.configVersion = 1;
  mockState.promptAppend = "";
  mockState.configModel = "";
  mockState.setModelCalls = 0;
  mockState.throwQueryOnCall = 0;
  mockState.closeCalls.length = 0;
  mockState.lifecycleEvents.length = 0;
});

function buildCache() {
  const stubSdk = {
    fetchAgentConfig: async () => ({
      agentId: AGENT_ID,
      version: mockState.configVersion,
      payload: {
        prompt: { append: mockState.promptAppend },
        model: mockState.configModel,
        mcpServers: [],
        env: [],
        gitRepos: [],
      },
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    }),
  } as unknown as Parameters<typeof createAgentConfigCache>[0]["sdk"];
  return createAgentConfigCache({ sdk: stubSdk });
}

function providerRetryPayloads(emitted: readonly SessionEvent[]): ProviderRetryEventPayload[] {
  return emitted
    .filter((event) => event.kind === "error")
    .map((event) => parseProviderRetryEventMessage(event.payload.message))
    .filter((payload): payload is ProviderRetryEventPayload => payload !== null);
}

function firstProviderPayload(payloads: readonly ProviderRetryEventPayload[]): ProviderRetryEventPayload {
  const payload = payloads[0];
  if (!payload) throw new Error("expected provider retry event");
  return payload;
}

async function waitForCondition(predicate: () => boolean, description: string): Promise<void> {
  // Wall-clock bound: under CI load the retry's post-timer Promise work can
  // take more than a fixed handful of setImmediate ticks. Fake timers still
  // own setTimeout; Date.now stays real because this file only fakes
  // setTimeout/clearTimeout.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function startSingleResultTurn() {
  mockState.queryCalls = 0;
  mockState.observedInputMessages.length = 0;
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const forwardResult = vi.fn<SessionContext["forwardResult"]>().mockResolvedValue(undefined);
  const emitted: SessionEvent[] = [];
  const completed: Array<{ count: number; outcome: TurnOutcome }> = [];
  const settlementOrder: string[] = [];
  const logs: string[] = [];
  const retryTurn = vi.fn<SessionContext["retryTurn"]>(() => {
    mockState.lifecycleEvents.push("retry:entered");
  });
  const failSessionForRecovery = vi.fn<NonNullable<SessionContext["failSessionForRecovery"]>>(() => {
    mockState.lifecycleEvents.push("fatal");
  });

  const cache = buildCache();
  await cache.refresh(AGENT_ID);

  const handler = createClaudeCodeHandler({
    runtimeProvider: "claude-code",
    workspaceRoot,
    agentName: "test-agent",
    agentConfigCache: cache,
  });
  const ctx: SessionContext = {
    agent: {
      agentId: AGENT_ID,
      inboxId: "inbox-test",
      displayName: "test",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: { serverUrl: "http://test", sendMessage } as unknown as SessionContext["sdk"],
    chatId: "chat-claude-provider-error",
    log: (m) => logs.push(m),
    recordProviderActivity: () => {},
    emitEvent: (e) => {
      const retryEvent = e.kind === "error" ? parseProviderRetryEventMessage(e.payload.message) : null;
      if (retryEvent?.event === "provider_failure_terminal") settlementOrder.push("terminal-notice");
      emitted.push(e);
    },
    ...mockCtxPlumbing({ sendMessage }, "chat-claude-provider-error"),
    forwardResult,
    retryTurn,
    failSessionForRecovery,
    finishTurn: async (messages, outcome) => {
      settlementOrder.push("complete");
      completed.push({ count: Array.isArray(messages) ? messages.length : 1, outcome });
    },
  };

  const started = await handler.start(
    {
      id: "m1",
      chatId: "chat-claude-provider-error",
      senderId: "user-1",
      format: "text",
      content: "hello",
      metadata: null,
    },
    ctx,
    deliveryTokenFromSessionContext(ctx),
  );

  return {
    handler,
    sessionId: started.sessionId,
    cache,
    ctx,
    sendMessage,
    forwardResult,
    emitted,
    completed,
    settlementOrder,
    logs,
    retryTurn,
    failSessionForRecovery,
  };
}

async function runSingleResultTurn() {
  const result = await startSingleResultTurn();
  await result.handler.suspend();
  await new Promise((r) => setImmediate(r));

  return result;
}

describe("claude-code handler — structured provider error result", () => {
  it("emits a provider failure and consumes a billing failure instead of forwarding final text", async () => {
    mockState.nextMessages = [
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 403,
        result: BILLING_RESULT,
      },
    ];
    const { sendMessage, forwardResult, emitted, completed, logs } = await runSingleResultTurn();

    expect(forwardResult).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes("Claude SDK provider failure"))).toBe(true);

    const providerPayloads = providerRetryPayloads(emitted);
    expect(providerPayloads).toHaveLength(1);
    expect(providerPayloads[0]).toMatchObject({
      event: "provider_failure_terminal",
      provider: "claude-code",
      scope: "provider_turn",
      category: "provider_capacity",
      reasonCode: "provider_billing_limit",
      userSeverity: "error",
    });
    expect(formatProviderFailureRuntimeNotice(firstProviderPayload(providerPayloads))).toContain(
      "insufficient account balance",
    );

    expect(
      emitted.some(
        (event) =>
          event.kind === "error" &&
          event.payload.source === "sdk" &&
          event.payload.message.includes("provider_billing_limit"),
      ),
    ).toBe(true);
    expect(emitted.some((event) => event.kind === "turn_end" && event.payload.status === "error")).toBe(true);
    expect(completed).toEqual([
      {
        count: 1,
        outcome: {
          status: "error",
          terminal: true,
          completion: "consumed",
          reason: "provider_billing_limit",
        },
      },
    ]);
  });

  it("keeps structured auth failures as credential failures with a relogin notice", async () => {
    mockState.nextMessages = [
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 401,
        result: "authentication_failed",
      },
    ];
    const { sendMessage, forwardResult, emitted, completed } = await runSingleResultTurn();

    expect(forwardResult).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    const providerPayloads = providerRetryPayloads(emitted);
    expect(providerPayloads[0]).toMatchObject({
      event: "provider_failure_terminal",
      provider: "claude-code",
      scope: "provider_turn",
      category: "credential",
      reasonCode: "provider_credential_required",
      userSeverity: "error",
    });
    expect(formatProviderFailureRuntimeNotice(firstProviderPayload(providerPayloads))).toContain("`claude auth login`");
    expect(completed[0]?.outcome).toMatchObject({
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "provider_credential_required",
    });
  });

  it("retires a credential-failed query and lazily resumes only recovered new input", async () => {
    const failedTurnGate = deferred();
    const recoveredTurnGate = deferred();
    mockState.messagesByAttempt = [
      [
        {
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 401,
          result: "authentication_failed",
        },
      ],
      [
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Recovered after login",
        },
      ],
    ];
    mockState.inputDrainLimitByAttempt = [1, 2];
    mockState.resultGateByAttempt = [failedTurnGate.promise, recoveredTurnGate.promise];

    const result = await startSingleResultTurn();
    await waitForCondition(
      () => mockState.observedInputMessages.filter((input) => input.attempt === 1).length === 1,
      "failed query input",
    );

    const tailRecoveryOrder: string[] = [];
    const makeTailToken = (id: string) => ({
      processingStarted: vi.fn(),
      complete: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn(() => tailRecoveryOrder.push(id)),
      terminalRejected: vi.fn().mockResolvedValue(undefined),
    });
    const tail2 = makeTailToken("m2");
    const tail3 = makeTailToken("m3");
    const message2 = {
      id: "m2",
      chatId: "chat-claude-provider-error",
      senderId: "user-1",
      format: "text" as const,
      content: "second message",
      metadata: null,
    };
    const message3 = {
      id: "m3",
      chatId: "chat-claude-provider-error",
      senderId: "user-1",
      format: "text" as const,
      content: "third message",
      metadata: null,
    };
    result.handler.inject(message2, tail2);
    result.handler.inject(message3, tail3);

    failedTurnGate.resolve();
    await waitForCondition(() => result.completed.length === 1, "credential settlement");
    await waitForCondition(() => tailRecoveryOrder.length === 2, "unentered tail recovery");

    expect(mockState.queryCalls).toBe(1);
    expect(mockState.closeCalls).toEqual([1]);
    expect(result.settlementOrder).toEqual(["terminal-notice", "complete"]);
    expect(result.completed[0]).toMatchObject({
      count: 1,
      outcome: {
        status: "error",
        terminal: true,
        completion: "consumed",
        reason: "provider_credential_required",
      },
    });
    expect(tailRecoveryOrder).toEqual(["m2", "m3"]);
    expect(tail2.processingStarted).not.toHaveBeenCalled();
    expect(tail3.processingStarted).not.toHaveBeenCalled();
    expect(tail2.complete).not.toHaveBeenCalled();
    expect(tail3.complete).not.toHaveBeenCalled();

    const redelivered2 = deliveryTokenFromSessionContext(result.ctx);
    const redelivered3 = deliveryTokenFromSessionContext(result.ctx);
    result.handler.inject(message2, redelivered2);
    result.handler.inject(message3, redelivered3);

    await waitForCondition(() => mockState.queryCalls === 2, "fresh credential-recovery query");
    await waitForCondition(
      () => mockState.observedInputMessages.filter((input) => input.attempt === 2).length === 2,
      "fresh query inputs",
    );

    expect(mockState.queryCalls).toBe(2);
    expect(mockState.observedQueryOptions[0]).toEqual({ attempt: 1, sessionId: result.sessionId });
    expect(mockState.observedQueryOptions[1]).toEqual({ attempt: 2, resume: result.sessionId });
    const recoveredInput = mockState.observedInputMessages
      .filter((input) => input.attempt === 2)
      .map((input) => input.content);
    expect(recoveredInput).toHaveLength(2);
    expect(recoveredInput[0]).toContain("second message");
    expect(recoveredInput[1]).toContain("third message");
    expect(
      mockState.observedInputMessages
        .filter((input) => input.attempt === 2)
        .some((input) => input.content.includes("hello")),
    ).toBe(false);

    recoveredTurnGate.resolve();
    await waitForCondition(() => result.completed.length === 2, "recovered turn settlement");
    expect(result.forwardResult).toHaveBeenCalledWith("Recovered after login");
    expect(result.failSessionForRecovery).not.toHaveBeenCalled();

    await result.handler.suspend();
    expect(mockState.closeCalls).toEqual([1, 2]);
  });

  it("retries a transient structured failure after assistant text was emitted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockState.nextMessages = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "I started working on this." }],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 503,
        result: TRANSIENT_RESULT,
      },
    ];
    try {
      const result = await startSingleResultTurn();
      await waitForCondition(() => providerRetryPayloads(result.emitted).length === 1, "first scheduled retry");
      await waitForCondition(() => vi.getTimerCount() > 0, "retry backoff timer");

      expect(mockState.queryCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(499);
      expect(mockState.queryCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await waitForCondition(() => mockState.queryCalls === 2, "second provider attempt");

      await waitForCondition(() => providerRetryPayloads(result.emitted).length === 2, "second scheduled retry");
      await vi.advanceTimersByTimeAsync(1499);
      expect(mockState.queryCalls).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      await waitForCondition(() => mockState.queryCalls === 3, "third provider attempt");
      await waitForCondition(() => result.completed.length === 1, "retry exhaustion settlement");

      await result.handler.suspend();
      const { sendMessage, forwardResult, emitted, completed } = result;

      expect(mockState.queryCalls).toBe(3);
      expect(forwardResult).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(emitted.some((event) => event.kind === "assistant_text")).toBe(true);

      const providerPayloads = providerRetryPayloads(emitted);
      expect(providerPayloads).toHaveLength(3);
      expect(providerPayloads[0]).toMatchObject({
        event: "provider_retry_scheduled",
        provider: "claude-code",
        scope: "provider_turn",
        category: "transient_transport",
        attempt: 1,
        replaySafety: "user_visible",
      });
      expect(providerPayloads[1]).toMatchObject({
        event: "provider_retry_scheduled",
        category: "transient_transport",
        attempt: 2,
        replaySafety: "user_visible",
      });
      expect(providerPayloads[2]).toMatchObject({
        event: "provider_retry_exhausted",
        category: "transient_transport",
        replaySafety: "user_visible",
      });
      expect(formatProviderFailureRuntimeNotice(firstProviderPayload(providerPayloads))).toContain(
        "provider API connection failed after retry handling",
      );
      expect(completed[0]?.outcome).toMatchObject({
        status: "error",
        terminal: true,
        completion: "consumed",
        reason: "provider_retry_exhausted",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending provider retry backoff when the session is suspended", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockState.nextMessages = [
      {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "I started working on this." }],
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 503,
        result: TRANSIENT_RESULT,
      },
    ];

    try {
      const result = await startSingleResultTurn();
      await waitForCondition(() => providerRetryPayloads(result.emitted).length === 1, "scheduled retry");

      await result.handler.suspend();
      await vi.advanceTimersByTimeAsync(500);

      expect(mockState.queryCalls).toBe(1);
      expect(result.logs).toContain("Auto-resume cancelled during provider retry backoff");
      expect(result.completed).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires a pending retry consumer before a config restart takes ownership", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockState.messagesByAttempt = [
      [
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "I started working on this." }],
          },
        },
        {
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 503,
          result: TRANSIENT_RESULT,
        },
      ],
      [],
    ];

    try {
      const result = await startSingleResultTurn();
      await waitForCondition(() => providerRetryPayloads(result.emitted).length === 1, "scheduled retry");

      mockState.configVersion = 2;
      mockState.promptAppend = "updated prompt";
      await result.cache.refresh(AGENT_ID);
      result.handler.inject(
        {
          id: "m2",
          chatId: "chat-claude-provider-error",
          senderId: "user-1",
          format: "text",
          content: "continue with the updated config",
          metadata: null,
        },
        deliveryTokenFromSessionContext(result.ctx),
      );

      await waitForCondition(() => mockState.queryCalls === 2, "config restart query");
      await waitForCondition(
        () => result.logs.includes("Auto-resume cancelled during provider retry backoff"),
        "stale retry consumer cancellation",
      );
      await vi.advanceTimersByTimeAsync(500);

      expect(mockState.queryCalls).toBe(2);
      expect(result.completed).toHaveLength(0);
      expect(result.logs.some((line) => line.includes("[configHotSwitch] path=restart"))).toBe(true);

      await result.handler.suspend();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips an in-flight same-family model switch while retry backoff owns the turn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockState.configModel = "claude-opus-4-5";
    mockState.messagesByAttempt = [
      [
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "I started working on this." }],
          },
        },
        {
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 503,
          result: TRANSIENT_RESULT,
        },
      ],
      [],
    ];

    try {
      const result = await startSingleResultTurn();
      await waitForCondition(() => providerRetryPayloads(result.emitted).length === 1, "scheduled retry");

      mockState.configVersion = 2;
      mockState.configModel = "claude-opus-4-6";
      await result.cache.refresh(AGENT_ID);
      result.handler.inject(
        {
          id: "m2",
          chatId: "chat-claude-provider-error",
          senderId: "user-1",
          format: "text",
          content: "continue with the new model",
          metadata: null,
        },
        deliveryTokenFromSessionContext(result.ctx),
      );

      await waitForCondition(() => mockState.queryCalls === 2, "config restart query");
      await vi.advanceTimersByTimeAsync(500);

      expect(mockState.setModelCalls).toBe(0);
      expect(mockState.queryCalls).toBe(2);
      expect(result.completed).toHaveLength(0);
      expect(result.logs.some((line) => line.includes("[configHotSwitch] path=restart"))).toBe(true);

      await result.handler.suspend();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns custody to session recovery when a config restart fails after cancelling backoff", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mockState.messagesByAttempt = [
      [
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "I started working on this." }],
          },
        },
        {
          type: "result",
          subtype: "success",
          is_error: true,
          api_error_status: 503,
          result: TRANSIENT_RESULT,
        },
      ],
    ];
    mockState.throwQueryOnCall = 2;

    try {
      const result = await startSingleResultTurn();
      await waitForCondition(() => providerRetryPayloads(result.emitted).length === 1, "scheduled retry");

      mockState.configVersion = 2;
      mockState.promptAppend = "updated prompt";
      await result.cache.refresh(AGENT_ID);

      const processingStarted = vi.fn();
      const retry = vi.fn(() => {
        mockState.lifecycleEvents.push("retry:tail");
      });
      result.handler.inject(
        {
          id: "m2",
          chatId: "chat-claude-provider-error",
          senderId: "user-1",
          format: "text",
          content: "continue with the updated config",
          metadata: null,
        },
        {
          processingStarted,
          complete: vi.fn().mockResolvedValue(undefined),
          retry,
          terminalRejected: vi.fn().mockResolvedValue(undefined),
        },
      );

      await waitForCondition(() => retry.mock.calls.length === 1, "tail recovery");
      await vi.advanceTimersByTimeAsync(500);

      expect(mockState.queryCalls).toBe(2);
      expect(mockState.closeCalls).toEqual([1]);
      expect(processingStarted).not.toHaveBeenCalled();
      expect(retry).toHaveBeenCalledOnce();
      expect(retry).toHaveBeenCalledWith(
        expect.objectContaining({ id: "m2" }),
        "claude_config_restart_failed_recovery",
      );
      expect(result.retryTurn).toHaveBeenCalledOnce();
      expect(result.retryTurn).toHaveBeenCalledWith(
        expect.objectContaining({ id: "m1" }),
        "claude_config_restart_failed_recovery",
      );
      expect(result.completed).toHaveLength(0);
      expect(result.failSessionForRecovery).toHaveBeenCalledOnce();
      expect(result.failSessionForRecovery).toHaveBeenCalledWith("claude_config_restart_failed", expect.any(String));
      expect(result.logs).toContain("Auto-resume cancelled during provider retry backoff");
      expect(result.logs).toContain("maybeSwitchConfig errored: config restart query construction failed");
      expect(mockState.lifecycleEvents).toEqual(["close:1", "retry:tail", "retry:entered", "fatal"]);

      await result.handler.suspend();
      expect(mockState.closeCalls).toEqual([1]);
      expect(retry).toHaveBeenCalledOnce();
      expect(result.retryTurn).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps assistant billing_error as the primary classification for a generic 403 result", async () => {
    mockState.nextMessages = [
      {
        type: "assistant",
        error: "billing_error",
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 403,
        result: "Failed to authenticate.",
      },
    ];
    const { sendMessage, forwardResult, emitted, completed } = await runSingleResultTurn();

    expect(forwardResult).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    const providerPayloads = providerRetryPayloads(emitted);
    const notice = formatProviderFailureRuntimeNotice(firstProviderPayload(providerPayloads));
    expect(notice).toContain("insufficient account balance");
    expect(notice).not.toContain("`claude auth login`");
    expect(providerPayloads[0]).toMatchObject({
      event: "provider_failure_terminal",
      provider: "claude-code",
      scope: "provider_turn",
      category: "provider_capacity",
      reasonCode: "provider_billing_limit",
      userSeverity: "error",
    });
    expect(completed[0]?.outcome).toMatchObject({
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "provider_billing_limit",
    });
  });

  it("treats a 403 Request not allowed as egress even with a typed authentication_failed signal", async () => {
    // The exact mixed shape that misdiagnosed the China-network 403: a typed
    // auth signal arrives first, the 403 "Request not allowed" detail only in
    // the result. The user-visible output must lead with egress/proxy guidance
    // and must NOT pre-empt it with the auth-login hint.
    mockState.nextMessages = [
      { type: "assistant", error: "authentication_failed" },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 403,
        result: "Failed to authenticate. API Error: 403 Request not allowed",
      },
    ];
    const { sendMessage, emitted } = await runSingleResultTurn();

    expect(sendMessage).not.toHaveBeenCalled();
    const providerPayloads = providerRetryPayloads(emitted);
    const notice = formatProviderFailureRuntimeNotice(firstProviderPayload(providerPayloads));
    expect(notice).toContain("before authentication");
    expect(notice).toContain("daemon.env");
    expect(notice).not.toContain("rejected the local Claude authentication");
    // The deferred auth hint must be suppressed for an egress 403.
    expect(
      emitted.some(
        (event) =>
          event.kind === "error" &&
          typeof event.payload.message === "string" &&
          event.payload.message.includes("auth on this machine looks broken"),
      ),
    ).toBe(false);
  });

  it("keeps the 403 Request not allowed detail for a non-success result subtype", async () => {
    // Bypass guard: a non-success subtype where `errors` carries only the
    // opaque code must still surface the API detail so egress detection fires.
    mockState.nextMessages = [
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        api_error_status: 403,
        errors: ["authentication_failed"],
        result: "Failed to authenticate. API Error: 403 Request not allowed",
      },
    ];
    const { sendMessage, emitted } = await runSingleResultTurn();

    expect(sendMessage).not.toHaveBeenCalled();
    const providerPayloads = providerRetryPayloads(emitted);
    const notice = formatProviderFailureRuntimeNotice(firstProviderPayload(providerPayloads));
    expect(notice).toContain("before authentication");
    expect(notice).not.toContain("rejected the local Claude authentication");
  });

  it("does not leak a deferred auth hint when an auth_status warning is followed by success", async () => {
    mockState.nextMessages = [
      { type: "auth_status", error: "token will expire soon" },
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "done" }] },
      },
      { type: "result", subtype: "success", is_error: false, result: "all good" },
    ];
    const { emitted, forwardResult } = await runSingleResultTurn();

    expect(forwardResult).toHaveBeenCalledWith("all good");
    expect(
      emitted.some(
        (event) =>
          event.kind === "error" &&
          typeof event.payload.message === "string" &&
          event.payload.message.includes("auth on this machine looks broken"),
      ),
    ).toBe(false);
  });

  it("does not sniff ordinary success result text as a provider error", async () => {
    const resultText = "API Error: 401 Unauthorized is an example the user asked about.";
    mockState.nextMessages = [
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: resultText,
      },
    ];
    const { sendMessage, forwardResult, emitted } = await runSingleResultTurn();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(forwardResult).toHaveBeenCalledWith(resultText);
    expect(
      emitted
        .filter((event) => event.kind === "error")
        .some((event) => parseProviderRetryEventMessage(event.payload.message) !== null),
    ).toBe(false);
    expect(emitted.some((event) => event.kind === "turn_end" && event.payload.status === "success")).toBe(true);
  });
});
