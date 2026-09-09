import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProviderRetryEventMessage, type SessionEvent } from "@first-tree/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * When the SDK query loop throws (process crash, transport reset, etc.) and
 * the handler exhausts its MAX_RETRIES budget, it must surface the failure
 * the same way as the other error branches:
 *   - emit `kind:"error"` with `source:"runtime"`, carrying the underlying
 *     error message, so the chat timeline's ErrorRow renders the failure
 *   - emit `kind:"turn_end"` with `status:"error"` so the turn-grouping
 *     filter on the frontend closes out the failed turn
 *
 * Pre-fix this path was silent — it only flipped runtimeState to "error"
 * (so the SessionRuntime could reclaim the slot) and returned, leaving the
 * chat with no visible signal that the agent had crashed.
 */

// Every query() call returns an iterator that throws after consuming a
// configurable prompt prefix. The handler should retry up to MAX_RETRIES
// (= 2) times, hitting three failures total, then bail through the
// retry-exhausted branch.
const SECOND_PROMPT = "tail prompt";
const observedInputMessages: Array<{ attempt: number; content: string }> = [];
const requiredInputsBeforeThrowByAttempt = new Map<number, number>();
const throwReleaseGates = new Map<number, Promise<void>>();

function resetSdkMockState(): void {
  attemptIdx = 0;
  observedInputMessages.length = 0;
  requiredInputsBeforeThrowByAttempt.clear();
  throwReleaseGates.clear();
}

function requiredInputsForAttempt(attempt: number): number {
  return requiredInputsBeforeThrowByAttempt.get(attempt) ?? 1;
}

async function waitForObservedInputs(attempt: number, count: number): Promise<void> {
  const deadline = Date.now() + 1000;
  while (observedInputMessages.filter((message) => message.attempt === attempt).length < count) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for attempt ${attempt} inputs`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitForCondition(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function scheduledRetryCount(emitted: readonly SessionEvent[]): number {
  return emitted.filter(
    (event) =>
      event.kind === "error" &&
      parseProviderRetryEventMessage(event.payload.message)?.event === "provider_retry_scheduled",
  ).length;
}

function makeFailingQuery(promptIterable: AsyncIterable<{ message: { content: unknown } }>, attempt: number) {
  void (async () => {
    const maxInputsToDrain = requiredInputsForAttempt(attempt);
    let drained = 0;
    for await (const sdkMsg of promptIterable) {
      const content = sdkMsg.message?.content;
      const flat = typeof content === "string" ? content : JSON.stringify(content);
      observedInputMessages.push({ attempt, content: flat });
      drained++;
      if (drained >= maxInputsToDrain) break;
    }
  })();
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          await waitForObservedInputs(attempt, requiredInputsForAttempt(attempt));
          await throwReleaseGates.get(attempt);
          throw new Error("sdk transport crashed");
        },
      };
    },
    close: () => {},
    setModel: async () => {},
  };
}

let attemptIdx = 0;

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: (args: { prompt: AsyncIterable<{ message: { content: unknown } }> }) => {
      attemptIdx += 1;
      return makeFailingQuery(args.prompt, attemptIdx);
    },
  };
});

import { mockCtxPlumbing } from "../../../__tests__/test-helpers.js";
import { createAgentConfigCache } from "../../../runtime/agent-config-cache.js";
import type { DeliveryToken, SessionContext } from "../../../runtime/handler.js";
import { deliveryTokenFromSessionContext } from "../../../runtime/handler.js";
import { createClaudeCodeHandler } from "../index.js";

const AGENT_ID = "019d9a97-90b0-716b-8317-a8c0be8430da";

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ftt-retry-exhausted-"));
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function buildCache() {
  const stubSdk = {
    fetchAgentConfig: async () => ({
      agentId: AGENT_ID,
      version: 1,
      payload: { prompt: { append: "" }, model: "", mcpServers: [], env: [], gitRepos: [] },
      updatedAt: new Date().toISOString(),
      updatedBy: "test",
    }),
  } as unknown as Parameters<typeof createAgentConfigCache>[0]["sdk"];
  return createAgentConfigCache({ sdk: stubSdk });
}

describe("claude-code handler — retry-exhausted surfacing", () => {
  it("emits error + turn_end:error and finishes the in-flight entry after MAX_RETRIES", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    resetSdkMockState();

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const emitted: SessionEvent[] = [];
    const finishTurnCalled = vi.fn();

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
      chatId: "chat-retry",
      log: () => {},
      recordProviderActivity: () => {},
      noteTurnStart: () => {},
      emitEvent: (e) => emitted.push(e),
      ...mockCtxPlumbing({ sendMessage }, "chat-retry"),
      finishTurn: async () => {
        finishTurnCalled();
      },
    };

    try {
      await handler.start(
        { id: "m1", chatId: "chat-retry", senderId: "u", format: "text", content: "hi", metadata: null },
        ctx,
        deliveryTokenFromSessionContext(ctx),
      );
      await waitForCondition("first scheduled retry", () => scheduledRetryCount(emitted) === 1);
      await vi.advanceTimersByTimeAsync(5000);
      await waitForCondition("second scheduled retry", () => scheduledRetryCount(emitted) === 2);
      await vi.advanceTimersByTimeAsync(15_000);
      await waitForCondition("retry exhaustion settlement", () => finishTurnCalled.mock.calls.length === 1);
      await handler.suspend();
      await new Promise((r) => setImmediate(r));
    } finally {
      vi.useRealTimers();
    }

    // Every iteration threw, so the turn never reached its completion hook;
    // the hook delivers nothing anyway (final-text mirror retired).
    expect(sendMessage).not.toHaveBeenCalled();

    // Reviewer Blocking 2 regression: the retry-exhausted return MUST ack
    // the entry. Without this the row sits `delivered` forever and the
    // in-process Deduplicator collapses every bind-reset replay.
    expect(finishTurnCalled).toHaveBeenCalledTimes(1);

    const errors = emitted.filter(
      (e) => e.kind === "error" && parseProviderRetryEventMessage(e.payload.message) === null,
    );
    expect(errors).toHaveLength(1);
    const err = errors[0];
    if (!err || err.kind !== "error") throw new Error("expected error event");
    expect(err.payload.source).toBe("runtime");
    expect(err.payload.message).toContain("Query failed after 2 retries");
    expect(err.payload.message).toContain("sdk transport crashed");

    const turnEnds = emitted.filter((e) => e.kind === "turn_end");
    expect(turnEnds).toHaveLength(1);
    const te = turnEnds[0];
    if (!te || te.kind !== "turn_end") throw new Error("expected turn_end event");
    expect(te.payload.status).toBe("error");

    // Emit order: error first, then turn_end:error — same contract as the
    // SDK-subtype-error and result-forward-failure branches so the chat UI's
    // turn-grouping filter behaves identically across error paths.
    const errIdx = emitted.findIndex((e) => e.kind === "error");
    const turnEndIdx = emitted.findIndex((e) => e.kind === "turn_end");
    expect(errIdx).toBeLessThan(turnEndIdx);
  });

  it("retries an unentered tail after retry exhaustion settles the provider-entered prefix", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    resetSdkMockState();
    requiredInputsBeforeThrowByAttempt.set(1, 1);
    requiredInputsBeforeThrowByAttempt.set(2, 1);
    requiredInputsBeforeThrowByAttempt.set(3, 1);
    let releaseAttempt1!: () => void;
    throwReleaseGates.set(
      1,
      new Promise((resolve) => {
        releaseAttempt1 = resolve;
      }),
    );

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const emitted: SessionEvent[] = [];
    const logs: string[] = [];
    const finishedBatches: string[][] = [];
    const m2Retries: Array<{ ids: string[]; reason: string }> = [];
    const failSessionForRecovery = vi.fn();
    let resolveM2FormatStarted!: () => void;
    const m2FormatStarted = new Promise<void>((resolve) => {
      resolveM2FormatStarted = resolve;
    });
    let releaseM2Format!: () => void;
    const m2FormatRelease = new Promise<void>((resolve) => {
      releaseM2Format = resolve;
    });
    const m2Token: DeliveryToken = {
      processingStarted: vi.fn(),
      complete: vi.fn(async () => {}),
      retry: (messages, reason) => {
        const batch = Array.isArray(messages) ? messages : [messages];
        m2Retries.push({ ids: batch.map((message) => message.id), reason });
      },
      terminalRejected: vi.fn(async () => {}),
    };

    const cache = buildCache();
    await cache.refresh(AGENT_ID);

    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
      agentConfigCache: cache,
    });
    const plumbing = mockCtxPlumbing({ sendMessage }, "chat-retry");
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
      chatId: "chat-retry",
      log: (m) => logs.push(m),
      recordProviderActivity: () => {},
      noteTurnStart: () => {},
      emitEvent: (e) => emitted.push(e),
      ...plumbing,
      formatInboundContent: async (message) => {
        const formatted = await plumbing.formatInboundContent(message);
        if (message.id === "m2") {
          resolveM2FormatStarted();
          await m2FormatRelease;
        }
        return formatted;
      },
      finishTurn: async (messages) => {
        const batch = Array.isArray(messages) ? messages : [messages];
        finishedBatches.push(batch.map((message) => message.id));
      },
      failSessionForRecovery,
    };

    try {
      await handler.start(
        { id: "m1", chatId: "chat-retry", senderId: "u", format: "text", content: "hi", metadata: null },
        ctx,
        deliveryTokenFromSessionContext(ctx),
      );
      await waitForObservedInputs(1, 1);
      handler.inject(
        {
          id: "m2",
          chatId: "chat-retry",
          senderId: "u",
          format: "text",
          content: SECOND_PROMPT,
          metadata: null,
        },
        m2Token,
      );
      await m2FormatStarted;
      releaseAttempt1();

      await waitForCondition("first scheduled retry", () => scheduledRetryCount(emitted) === 1);
      await vi.advanceTimersByTimeAsync(5000);
      await waitForCondition("second scheduled retry", () => scheduledRetryCount(emitted) === 2);
      await vi.advanceTimersByTimeAsync(15_000);
      await waitForObservedInputs(3, 1);
      await waitForCondition("retry-exhausted tail recovery", () => m2Retries.length > 0);
      releaseM2Format();
      await handler.suspend();
      await new Promise((r) => setImmediate(r));
    } finally {
      vi.useRealTimers();
    }

    expect(logs.some((l) => l.includes("Attempting auto-resume (retry 1/"))).toBe(true);

    const attempt1Inputs = observedInputMessages.filter((message) => message.attempt === 1);
    expect(attempt1Inputs.map((message) => message.content)).toEqual([expect.stringContaining("hi")]);

    const attempt2Inputs = observedInputMessages.filter((message) => message.attempt === 2);
    expect(attempt2Inputs.map((message) => message.content)).toEqual([expect.stringContaining("hi")]);

    const attempt3Inputs = observedInputMessages.filter((message) => message.attempt === 3);
    expect(attempt3Inputs.map((message) => message.content)).toEqual([expect.stringContaining("hi")]);

    expect(finishedBatches).toEqual([["m1"]]);
    expect(m2Retries).toEqual([{ ids: ["m2"], reason: "claude_retry_exhausted_tail_recovery" }]);
    expect(failSessionForRecovery).toHaveBeenCalledWith("claude_retry_exhausted", expect.any(String));
    const lastTurnEnd = emitted.filter((event) => event.kind === "turn_end").at(-1);
    if (!lastTurnEnd || lastTurnEnd.kind !== "turn_end") throw new Error("expected turn_end event");
    expect(lastTurnEnd.payload.status).toBe("error");
  });

  it("still returns when emitEvent throws", async () => {
    resetSdkMockState();

    const sendMessage = vi.fn().mockResolvedValue(undefined);

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
      chatId: "chat-retry-emit-throw",
      log: () => {},
      recordProviderActivity: () => {},
      noteTurnStart: () => {},
      emitEvent: () => {
        throw new Error("event sink down");
      },
      ...mockCtxPlumbing({ sendMessage }, "chat-retry-emit-throw"),
    };

    await handler.start(
      { id: "m1", chatId: "chat-retry-emit-throw", senderId: "u", format: "text", content: "hi", metadata: null },
      ctx,
      deliveryTokenFromSessionContext(ctx),
    );
    await handler.suspend();
    await new Promise((r) => setImmediate(r));
  });
});
