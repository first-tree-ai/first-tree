import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProviderRetryEventPayload, parseProviderRetryEventMessage, type SessionEvent } from "@first-tree/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * When the SDK query loop crashes and the handler attempts auto-resume but
 * `respawnQuery` itself throws (e.g. the underlying SDK rejects a `query()`
 * call synchronously), the handler must surface that failure the same way as
 * MAX_RETRIES exhaustion:
 *   - emit `kind:"error"` with `source:"runtime"` describing the auto-resume
 *     failure so the chat timeline shows an ErrorRow
 *   - emit `kind:"turn_end"` with `status:"error"` so the turn-grouping filter
 *     closes out the dropped turn
 *   - flip `runtimeState` to `"error"` so the SessionRuntime reclaims the slot
 *
 * Pre-fix this branch was silent like MAX_RETRIES — it only flipped the
 * runtime state and returned with no chat-visible signal.
 */

// First query() call returns a failing iterator (drives the consumer loop
// into its retry-catch). respawnQuery's next query() call throws
// SYNCHRONOUSLY, triggering the auto-resume-failed branch.
const SECOND_PROMPT = "tail prompt";
const DEFAULT_INITIAL_CRASH_MESSAGE = "initial sdk transport crash";
const DEFAULT_RESPAWN_FAILURE_MESSAGE = "respawn build failed: sdk module unavailable";
const RAW_TOKEN = "sk-ant-abcdefghijklmnopqrstuvwxyz1234567890";
let queryCallCount = 0;
let initialCrashMessage = DEFAULT_INITIAL_CRASH_MESSAGE;
let respawnFailureMessage = DEFAULT_RESPAWN_FAILURE_MESSAGE;
const observedInputMessages: Array<{ attempt: number; content: string }> = [];
const requiredInputsBeforeThrowByAttempt = new Map<number, number>();
const throwReleaseGates = new Map<number, Promise<void>>();

function resetSdkMockState(): void {
  queryCallCount = 0;
  initialCrashMessage = DEFAULT_INITIAL_CRASH_MESSAGE;
  respawnFailureMessage = DEFAULT_RESPAWN_FAILURE_MESSAGE;
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
          throw new Error(initialCrashMessage);
        },
      };
    },
    close: () => {},
    setModel: async () => {},
  };
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  return {
    query: (args: { prompt: AsyncIterable<{ message: { content: unknown } }> }) => {
      queryCallCount += 1;
      if (queryCallCount >= 2) {
        // Synchronous throw — buildQuery has no try/catch around the `query()`
        // call, so this surfaces as a throw out of respawnQuery and lands in
        // the auto-resume-failed catch.
        throw new Error(respawnFailureMessage);
      }
      return makeFailingQuery(args.prompt, queryCallCount);
    },
  };
});

import { mockCtxPlumbing } from "../../../__tests__/test-helpers.js";
import { createAgentConfigCache } from "../../../runtime/agent-config-cache.js";
import type { SessionContext } from "../../../runtime/handler.js";
import { deliveryTokenFromSessionContext } from "../../../runtime/handler.js";
import { createClaudeCodeHandler } from "../index.js";

const AGENT_ID = "019d9a97-90b0-716b-8317-a8c0be8430db";

let workspaceRoot: string;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ftt-auto-resume-fail-"));
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

function providerRetryPayloads(emitted: readonly SessionEvent[]): ProviderRetryEventPayload[] {
  return emitted
    .filter((event) => event.kind === "error")
    .map((event) => parseProviderRetryEventMessage(event.payload.message))
    .filter((payload): payload is ProviderRetryEventPayload => payload !== null);
}

describe("claude-code handler — auto-resume failure surfacing", () => {
  it("emits error + turn_end:error and finishes the in-flight entry when respawnQuery throws", async () => {
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
      chatId: "chat-resume-fail",
      log: () => {},
      recordProviderActivity: () => {},
      noteTurnStart: () => {},
      emitEvent: (e) => emitted.push(e),
      ...mockCtxPlumbing({ sendMessage }, "chat-resume-fail"),
      finishTurn: async () => {
        finishTurnCalled();
      },
    };

    try {
      await handler.start(
        { id: "m1", chatId: "chat-resume-fail", senderId: "u", format: "text", content: "hi", metadata: null },
        ctx,
        deliveryTokenFromSessionContext(ctx),
      );
      await waitForCondition("scheduled retry", () => providerRetryPayloads(emitted).length === 1);
      await vi.advanceTimersByTimeAsync(5000);
      await waitForCondition("auto-resume failure settlement", () => providerRetryPayloads(emitted).length === 2);
      await handler.suspend();
      await new Promise((r) => setImmediate(r));
    } finally {
      vi.useRealTimers();
    }

    const errors = emitted.filter(
      (e) => e.kind === "error" && parseProviderRetryEventMessage(e.payload.message) === null,
    );
    expect(errors).toHaveLength(1);
    const err = errors[0];
    if (!err || err.kind !== "error") throw new Error("expected error event");
    expect(err.payload.source).toBe("runtime");
    expect(err.payload.message).toContain("Auto-resume failed");
    expect(err.payload.message).toContain("respawn build failed");

    const providerPayloads = providerRetryPayloads(emitted);
    expect(providerPayloads.map((payload) => payload.event)).toEqual([
      "provider_retry_scheduled",
      "provider_failure_terminal",
    ]);
    expect(providerPayloads[1]).toMatchObject({
      event: "provider_failure_terminal",
      provider: "claude-code",
      scope: "provider_turn",
      reasonCode: "claude_auto_resume_failed",
      userSeverity: "error",
    });
    expect(providerPayloads[1]?.messagePreview).toContain("initial sdk transport crash");
    expect(providerPayloads[1]?.messagePreview).toContain("respawn build failed");

    const turnEnds = emitted.filter((e) => e.kind === "turn_end");
    expect(turnEnds).toHaveLength(1);
    const te = turnEnds[0];
    if (!te || te.kind !== "turn_end") throw new Error("expected turn_end event");
    expect(te.payload.status).toBe("error");

    // Same emit-order contract as the other error branches: error first,
    // turn_end:error after.
    const errIdx = emitted.findIndex((e) => e.kind === "error");
    const turnEndIdx = emitted.findIndex((e) => e.kind === "turn_end");
    expect(errIdx).toBeLessThan(turnEndIdx);

    // Reviewer Blocking 2 regression: the auto-resume-failure return MUST
    // ack the entry. Without this the row stays `delivered` server-side
    // and the in-process Deduplicator collapses every bind-reset replay
    // (entry → server → push → dispatch dedup skip → never re-acked).
    expect(finishTurnCalled).toHaveBeenCalledTimes(1);
  });

  it("redacts and truncates auto-resume terminal provider previews", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    resetSdkMockState();
    initialCrashMessage = `initial sdk transport crash Authorization: Bearer ${RAW_TOKEN} ${"x".repeat(1200)}`;
    respawnFailureMessage = `respawn build failed: sdk module unavailable api_key=${RAW_TOKEN} ${"y".repeat(1200)}`;

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const emitted: SessionEvent[] = [];

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
      chatId: "chat-resume-fail",
      log: () => {},
      recordProviderActivity: () => {},
      noteTurnStart: () => {},
      emitEvent: (e) => emitted.push(e),
      ...mockCtxPlumbing({ sendMessage }, "chat-resume-fail"),
      finishTurn: async () => {},
    };

    try {
      await handler.start(
        { id: "m1", chatId: "chat-resume-fail", senderId: "u", format: "text", content: "hi", metadata: null },
        ctx,
        deliveryTokenFromSessionContext(ctx),
      );
      await waitForCondition("scheduled retry", () => providerRetryPayloads(emitted).length === 1);
      await vi.advanceTimersByTimeAsync(5000);
      await waitForCondition("auto-resume failure settlement", () => providerRetryPayloads(emitted).length === 2);
      await handler.suspend();
      await new Promise((r) => setImmediate(r));
    } finally {
      vi.useRealTimers();
    }

    const errorMessages = emitted.filter((event) => event.kind === "error").map((event) => event.payload.message);
    expect(errorMessages.every((message) => !message.includes(RAW_TOKEN))).toBe(true);
    expect(errorMessages.some((message) => message.includes("[REDACTED"))).toBe(true);

    const terminalPayload = providerRetryPayloads(emitted).find(
      (payload) => payload.event === "provider_failure_terminal",
    );
    expect(terminalPayload).toMatchObject({
      event: "provider_failure_terminal",
      reasonCode: "claude_auto_resume_failed",
      userSeverity: "error",
    });
    const preview = terminalPayload?.messagePreview;
    if (!preview) throw new Error("expected terminal provider message preview");
    // `buildProviderRetryEvent` truncates to the 256-char preview budget, then
    // appends an ellipsis marker. The schema budget is 800, so this must parse.
    expect(preview.length).toBeLessThanOrEqual(257);
    expect(preview).toContain("respawn build failed");
    expect(preview).toContain("[REDACTED");
    expect(preview).not.toContain(RAW_TOKEN);
  });

  it("retries an unentered tail after auto-resume failure settles the provider-entered prefix", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    resetSdkMockState();
    requiredInputsBeforeThrowByAttempt.set(1, 1);
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
    const retriedBatches: Array<{ ids: string[]; reason: string }> = [];
    const failSessionForRecovery = vi.fn();
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
    const plumbing = mockCtxPlumbing({ sendMessage }, "chat-resume-fail");
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
      chatId: "chat-resume-fail",
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
      retryTurn: (messages, reason) => {
        const batch = Array.isArray(messages) ? messages : [messages];
        retriedBatches.push({ ids: batch.map((message) => message.id), reason });
      },
      failSessionForRecovery,
    };

    try {
      await handler.start(
        { id: "m1", chatId: "chat-resume-fail", senderId: "u", format: "text", content: "hi", metadata: null },
        ctx,
        deliveryTokenFromSessionContext(ctx),
      );
      await waitForObservedInputs(1, 1);
      handler.inject(
        {
          id: "m2",
          chatId: "chat-resume-fail",
          senderId: "u",
          format: "text",
          content: SECOND_PROMPT,
          metadata: null,
        },
        deliveryTokenFromSessionContext(ctx),
      );
      await m2Pushed;
      releaseAttempt1();

      await waitForCondition("scheduled retry", () => providerRetryPayloads(emitted).length === 1);
      await vi.advanceTimersByTimeAsync(5000);
      await waitForCondition("auto-resume failed tail recovery", () => retriedBatches.length > 0);
      await handler.suspend();
      await new Promise((r) => setImmediate(r));
    } finally {
      vi.useRealTimers();
    }

    expect(logs.some((l) => l.includes("Auto-resume failed: respawn build failed"))).toBe(true);
    const providerPayloads = providerRetryPayloads(emitted);
    expect(providerPayloads.at(-1)).toMatchObject({
      event: "provider_failure_terminal",
      reasonCode: "claude_auto_resume_failed",
    });

    const attempt1Inputs = observedInputMessages.filter((message) => message.attempt === 1);
    expect(attempt1Inputs.map((message) => message.content)).toEqual([expect.stringContaining("hi")]);

    expect(finishedBatches).toEqual([["m1"]]);
    expect(retriedBatches).toEqual([{ ids: ["m2"], reason: "claude_auto_resume_failed_tail_recovery" }]);
    expect(failSessionForRecovery).toHaveBeenCalledWith("claude_auto_resume_failed", expect.any(String));
    const lastTurnEnd = emitted.filter((event) => event.kind === "turn_end").at(-1);
    if (!lastTurnEnd || lastTurnEnd.kind !== "turn_end") throw new Error("expected turn_end event");
    expect(lastTurnEnd.payload.status).toBe("error");
  });
});
