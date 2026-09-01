import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@first-tree/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Regression test for the `claude_socket_closed` transient retry path.
 *
 * Reported bug: a Claude SDK stream-API error (subtype=`success`,
 * `is_error: true`, payload whose `result` text is `"API Error: The socket
 * connection was closed unexpectedly..."`) was correctly classified `transient/
 * claude_socket_closed` and triggered the auto-resume branch — but the
 * old `respawnQuery()` only rebuilt the SDK query and left the new
 * `InputController` empty. With no user prompt in the iterable the SDK
 * subprocess just hung idle (resume mode loads conversation history but
 * still needs a fresh user message to drive the next turn), so the agent
 * appeared to stall mid-conversation with no further log output and no
 * recovery.
 *
 * Contract this test pins:
 *   1. On the first transient stream-error, the handler enters the
 *      retry path (logs `Attempting auto-resume`).
 *   2. The rebuilt query receives the SAME user message that was pushed
 *      against the failing query — verified by capturing every SDK
 *      input message across all `query()` calls and asserting the
 *      original prompt shows up at least twice (once per attempt).
 *   3. After the second attempt also fails transient + retries exhaust,
 *      the handler surfaces the error + acks (per PR #612 § "permanent
 *      → ack").
 */

const ORIGINAL_PROMPT = "please reply";
const SECOND_PROMPT = "and include context";
const FAKE_API_ERROR_TEXT =
  "API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";

// Capture every user prompt pushed into the SDK input controller across
// retries. Each `query()` call enqueues its own slice; we concatenate
// them in observation order so the test can assert the same prompt was
// replayed on the second attempt.
const observedInputMessages: Array<{ attempt: number; content: string }> = [];
const requiredInputsBeforeResultByAttempt = new Map<number, number>();
const resultReleaseGates = new Map<number, Promise<void>>();

function resetSdkMockState(): void {
  attemptIdx = 0;
  observedInputMessages.length = 0;
  requiredInputsBeforeResultByAttempt.clear();
  resultReleaseGates.clear();
}

function requiredInputsForAttempt(attempt: number): number {
  return requiredInputsBeforeResultByAttempt.get(attempt) ?? 1;
}

async function waitForObservedInputs(attempt: number, count: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (observedInputMessages.filter((message) => message.attempt === attempt).length < count) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for attempt ${attempt} inputs`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitForCondition(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function makeWrappedStreamErrorQuery(
  promptIterable: AsyncIterable<{ message: { content: unknown } }>,
  attempt: number,
) {
  let yielded = false;
  // Eagerly drain the input iterable in the background so the
  // handler-side `inputController.push(...)` reaches us — without this,
  // the test never sees what got pushed. Stop after the attempt-specific
  // count so a test can leave a pushed tail buffered but not provider-entered.
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
        next: async (): Promise<IteratorResult<unknown>> => {
          if (yielded) return { value: undefined, done: true };
          await waitForObservedInputs(attempt, requiredInputsForAttempt(attempt));
          await resultReleaseGates.get(attempt);
          yielded = true;
          // Yield latest-SDK structured "success but error" result. The
          // handler classifies it from `is_error` / provider fields, not from
          // final-text regex sniffing.
          return {
            value: {
              type: "result",
              subtype: "success",
              is_error: true,
              result: FAKE_API_ERROR_TEXT,
            },
            done: false,
          };
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
      return makeWrappedStreamErrorQuery(args.prompt, attemptIdx);
    },
  };
});

import { mockCtxPlumbing } from "../../../__tests__/test-helpers.js";
import { createAgentConfigCache } from "../../../runtime/agent-config-cache.js";
import type { SessionContext } from "../../../runtime/handler.js";
import { deliveryTokenFromSessionContext } from "../../../runtime/handler.js";
import { createClaudeCodeHandler } from "../index.js";

const AGENT_ID = "019dd905-1234-7777-8888-bef95070f001";

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ftt-stream-retry-replay-"));
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

describe("claude-code handler — transient stream-error retry replays user message", () => {
  it("re-pushes the original prompt into the rebuilt InputController so the SDK isn't left idle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    resetSdkMockState();

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const emitted: SessionEvent[] = [];
    const logs: string[] = [];
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
      chatId: "chat-stream-retry",
      log: (m) => logs.push(m),
      recordProviderActivity: () => {},
      noteTurnStart: () => {},
      emitEvent: (e) => emitted.push(e),
      ...mockCtxPlumbing({ sendMessage }, "chat-stream-retry"),
      finishTurn: async () => {
        finishTurnCalled();
      },
    };

    try {
      await handler.start(
        {
          id: "m1",
          chatId: "chat-stream-retry",
          senderId: "user-1",
          format: "text",
          content: ORIGINAL_PROMPT,
          metadata: null,
        },
        ctx,
        deliveryTokenFromSessionContext(ctx),
      );
      await waitForCondition(
        () => logs.filter((line) => line.includes("Attempting auto-resume")).length === 1,
        "first scheduled stream retry",
      );

      expect(attemptIdx).toBe(1);
      await vi.advanceTimersByTimeAsync(499);
      expect(attemptIdx).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await waitForObservedInputs(2, 1);

      await waitForCondition(
        () => logs.filter((line) => line.includes("Attempting auto-resume")).length === 2,
        "second scheduled stream retry",
      );
      expect(attemptIdx).toBe(2);
      await vi.advanceTimersByTimeAsync(1499);
      expect(attemptIdx).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      await waitForObservedInputs(3, 1);
      await waitForCondition(() => finishTurnCalled.mock.calls.length === 1, "stream retry exhaustion settlement");

      // suspend awaits `consumerDone` after the retry-exhausted settlement.
      await handler.suspend();
      await new Promise((r) => setImmediate(r));

      // First retry must have been attempted — proves the catch path fired
      // on the wrapped stream error.
      expect(logs.some((l) => l.includes("Attempting auto-resume (retry 1/"))).toBe(true);

      // The smoking gun: the rebuilt query (attempt 2) must have received
      // a user message containing the original prompt. Pre-fix this was
      // empty and the SDK subprocess hung idle.
      const attempt2Inputs = observedInputMessages.filter((m) => m.attempt === 2);
      expect(attempt2Inputs.length).toBeGreaterThan(0);
      expect(attempt2Inputs.some((m) => m.content.includes(ORIGINAL_PROMPT))).toBe(true);

      // And the first attempt also saw the prompt (sanity check that the
      // mock plumbing works at all).
      const attempt1Inputs = observedInputMessages.filter((m) => m.attempt === 1);
      expect(attempt1Inputs.some((m) => m.content.includes(ORIGINAL_PROMPT))).toBe(true);

      // After both retries fail transient (same wrapped API error every
      // time), the handler must end in the retry-exhausted / permanent
      // branch and ack — per PR #612 § "permanent → ack".
      expect(finishTurnCalled).toHaveBeenCalledTimes(1);

      // A user-visible error must be surfaced on retry-exhaustion (so the
      // chat timeline shows what happened), AND the turn must be closed
      // with status:"error" so the frontend turn-grouping filter doesn't
      // wait forever for the success boundary.
      const errors = emitted.filter((e) => e.kind === "error");
      expect(errors.some((e) => e.kind === "error" && e.payload.source === "sdk")).toBe(true);
      const turnEnds = emitted.filter((e) => e.kind === "turn_end");
      expect(turnEnds.length).toBeGreaterThan(0);
      const lastTurnEnd = turnEnds[turnEnds.length - 1];
      if (!lastTurnEnd || lastTurnEnd.kind !== "turn_end") throw new Error("expected turn_end event");
      expect(lastTurnEnd.payload.status).toBe("error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not respawn the Claude query when Context authority changes during auto-resume backoff", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    resetSdkMockState();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const logs: string[] = [];
    const failSessionForRecovery = vi.fn();
    let bindingReads = 0;
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
      sdk: {
        serverUrl: "http://test",
        sendMessage,
        getAgentContextTreeConfig: async () => {
          bindingReads += 1;
          return bindingReads <= 2
            ? { bindingState: "invalid" as const, repo: null, branch: null, provider: null }
            : {
                bindingState: "bound" as const,
                repo: "https://github.com/acme/new-tree.git",
                branch: "main",
                provider: "github" as const,
              };
        },
      } as unknown as SessionContext["sdk"],
      chatId: "chat-stream-source-flip",
      log: (message) => logs.push(message),
      recordProviderActivity: () => {},
      noteTurnStart: () => {},
      emitEvent: () => {},
      ...mockCtxPlumbing({ sendMessage }, "chat-stream-source-flip"),
      failSessionForRecovery,
    };

    try {
      await handler.start(
        {
          id: "m-source-flip",
          chatId: ctx.chatId,
          senderId: "user-1",
          format: "text",
          content: ORIGINAL_PROMPT,
          metadata: null,
        },
        ctx,
        deliveryTokenFromSessionContext(ctx),
      );
      await waitForCondition(
        () => logs.some((line) => line.includes("Attempting auto-resume")),
        "scheduled source-flip retry",
      );
      expect(attemptIdx).toBe(1);
      await vi.advanceTimersByTimeAsync(500);
      await waitForCondition(() => failSessionForRecovery.mock.calls.length === 1, "source transition recovery");

      expect(attemptIdx).toBe(1);
      expect(failSessionForRecovery).toHaveBeenCalledWith("claude_context_source_changed", expect.any(String));
    } finally {
      await handler.suspend();
      vi.useRealTimers();
    }
  });

  it("replays every provider-entered input in a coalesced transient retry", async () => {
    resetSdkMockState();
    requiredInputsBeforeResultByAttempt.set(1, 2);
    requiredInputsBeforeResultByAttempt.set(2, 2);
    requiredInputsBeforeResultByAttempt.set(3, 2);

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const emitted: SessionEvent[] = [];
    const logs: string[] = [];
    const finishedBatches: string[][] = [];

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
      chatId: "chat-stream-retry",
      log: (m) => logs.push(m),
      recordProviderActivity: () => {},
      noteTurnStart: () => {},
      emitEvent: (e) => emitted.push(e),
      ...mockCtxPlumbing({ sendMessage }, "chat-stream-retry"),
      finishTurn: async (messages) => {
        const batch = Array.isArray(messages) ? messages : [messages];
        finishedBatches.push(batch.map((message) => message.id));
      },
    };

    await handler.start(
      {
        id: "m1",
        chatId: "chat-stream-retry",
        senderId: "user-1",
        format: "text",
        content: ORIGINAL_PROMPT,
        metadata: null,
      },
      ctx,
      deliveryTokenFromSessionContext(ctx),
    );
    handler.inject(
      {
        id: "m2",
        chatId: "chat-stream-retry",
        senderId: "user-1",
        format: "text",
        content: SECOND_PROMPT,
        metadata: null,
      },
      deliveryTokenFromSessionContext(ctx),
    );

    await waitForObservedInputs(2, 2);
    await waitForObservedInputs(3, 2);
    await handler.suspend();
    await new Promise((r) => setImmediate(r));

    expect(logs.some((l) => l.includes("Attempting auto-resume (retry 1/"))).toBe(true);

    const attempt2Inputs = observedInputMessages.filter((message) => message.attempt === 2);
    expect(attempt2Inputs.map((message) => message.content)).toEqual([
      expect.stringContaining(ORIGINAL_PROMPT),
      expect.stringContaining(SECOND_PROMPT),
    ]);

    const attempt3Inputs = observedInputMessages.filter((message) => message.attempt === 3);
    expect(attempt3Inputs.map((message) => message.content)).toEqual([
      expect.stringContaining(ORIGINAL_PROMPT),
      expect.stringContaining(SECOND_PROMPT),
    ]);

    expect(finishedBatches).toEqual([["m1", "m2"]]);
    const lastTurnEnd = emitted.filter((event) => event.kind === "turn_end").at(-1);
    if (!lastTurnEnd || lastTurnEnd.kind !== "turn_end") throw new Error("expected turn_end event");
    expect(lastTurnEnd.payload.status).toBe("error");
  });

  it("replays a pushed tail input that had not entered the provider before a transient retry", async () => {
    resetSdkMockState();
    requiredInputsBeforeResultByAttempt.set(1, 1);
    requiredInputsBeforeResultByAttempt.set(2, 2);
    requiredInputsBeforeResultByAttempt.set(3, 2);
    let releaseAttempt1!: () => void;
    resultReleaseGates.set(
      1,
      new Promise((resolve) => {
        releaseAttempt1 = resolve;
      }),
    );

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const emitted: SessionEvent[] = [];
    const logs: string[] = [];
    const finishedBatches: string[][] = [];
    let resolveM2Pushed!: () => void;
    const m2Pushed = new Promise<void>((resolve) => {
      resolveM2Pushed = resolve;
    });

    const cache = buildCache();
    await cache.refresh(AGENT_ID);

    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
      agentConfigCache: cache,
    });
    const plumbing = mockCtxPlumbing({ sendMessage }, "chat-stream-retry");
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
      chatId: "chat-stream-retry",
      log: (m) => logs.push(m),
      recordProviderActivity: () => {},
      noteTurnStart: () => {},
      emitEvent: (e) => emitted.push(e),
      ...plumbing,
      formatInboundContent: async (message) => {
        const formatted = await plumbing.formatInboundContent(message);
        if (message.id === "m2") setImmediate(resolveM2Pushed);
        return formatted;
      },
      finishTurn: async (messages) => {
        const batch = Array.isArray(messages) ? messages : [messages];
        finishedBatches.push(batch.map((message) => message.id));
      },
    };

    await handler.start(
      {
        id: "m1",
        chatId: "chat-stream-retry",
        senderId: "user-1",
        format: "text",
        content: ORIGINAL_PROMPT,
        metadata: null,
      },
      ctx,
      deliveryTokenFromSessionContext(ctx),
    );
    await waitForObservedInputs(1, 1);
    handler.inject(
      {
        id: "m2",
        chatId: "chat-stream-retry",
        senderId: "user-1",
        format: "text",
        content: SECOND_PROMPT,
        metadata: null,
      },
      deliveryTokenFromSessionContext(ctx),
    );
    await m2Pushed;
    releaseAttempt1();

    await waitForObservedInputs(2, 2);
    await waitForObservedInputs(3, 2);
    await handler.suspend();
    await new Promise((r) => setImmediate(r));

    expect(logs.some((l) => l.includes("Attempting auto-resume (retry 1/"))).toBe(true);

    const attempt1Inputs = observedInputMessages.filter((message) => message.attempt === 1);
    expect(attempt1Inputs.map((message) => message.content)).toEqual([expect.stringContaining(ORIGINAL_PROMPT)]);

    const attempt2Inputs = observedInputMessages.filter((message) => message.attempt === 2);
    expect(attempt2Inputs.map((message) => message.content)).toEqual([
      expect.stringContaining(ORIGINAL_PROMPT),
      expect.stringContaining(SECOND_PROMPT),
    ]);

    const attempt3Inputs = observedInputMessages.filter((message) => message.attempt === 3);
    expect(attempt3Inputs.map((message) => message.content)).toEqual([
      expect.stringContaining(ORIGINAL_PROMPT),
      expect.stringContaining(SECOND_PROMPT),
    ]);

    expect(finishedBatches).toEqual([["m1", "m2"]]);
    const lastTurnEnd = emitted.filter((event) => event.kind === "turn_end").at(-1);
    if (!lastTurnEnd || lastTurnEnd.kind !== "turn_end") throw new Error("expected turn_end event");
    expect(lastTurnEnd.payload.status).toBe("error");
  });
});
