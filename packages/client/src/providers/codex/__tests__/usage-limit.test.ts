import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_NOTICE_METADATA_KEY, type SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCtxPlumbing } from "../../../__tests__/test-helpers.js";
import type { ChatContext } from "../../../runtime/chat-context.js";
import type { SessionContext, SessionMessage } from "../../../runtime/handler.js";

/**
 * Issue #971 — codex usage-limit silent failure.
 *
 * When the codex account usage limit is exhausted the SDK emits
 * `turn.completed` almost instantly with NO agent_message and ZERO token
 * consumption (the model is never invoked). Before the fix that looked
 * identical to the legitimate "silent turn" protocol, so the runtime acked
 * the message as a phantom success: no chat reply, no error, no log.
 *
 * The handler now discriminates on the per-turn token delta:
 *   - zero delta + empty reply + turn.completed  => usage-limit empty turn
 *     => emit an `error` event, log a warn line, and post a chat notice.
 *   - non-zero delta + empty reply               => a chosen silence (the
 *     model ran), left untouched (no false positive).
 *
 * These drive the real `runTurn` state machine through a mock Codex SDK whose
 * per-turn event script is set by each test.
 */

type MockState = {
  runInputs: unknown[];
  turns: unknown[][];
};

const state = vi.hoisted<MockState>(() => ({
  runInputs: [],
  turns: [],
}));

vi.mock("@openai/codex-sdk", () => {
  const thread = {
    id: "thread-usage-limit",
    async runStreamed(input: unknown) {
      state.runInputs.push(input);
      const idx = state.runInputs.length - 1;
      const events = state.turns[idx] ?? [];
      if (events[0] instanceof Error) throw events[0];
      return {
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread-usage-limit" };
          for (const event of events) yield event;
        })(),
      };
    },
  };

  return {
    Codex: class {
      startThread() {
        return thread;
      }
      resumeThread() {
        return thread;
      }
    },
  };
});

vi.mock("../../../runtime/bootstrap.js", () => ({
  FIRST_TREE_RUNTIME_DIR: ".first-tree-workspace",
  FIRST_TREE_WORKSPACE_MARKER: ".first-tree-workspace",
  bootstrapWorkspace: vi.fn(
    (args: {
      workspacePath: string;
      agentName: string;
      contextTreePath: string | null;
      contextSourceKind: string;
      identity: { agentId: string };
      serverUrl: string;
    }) => {
      const runtimeDir = join(args.workspacePath, ".first-tree-workspace");
      mkdirSync(runtimeDir, { recursive: true });
      writeFileSync(
        join(runtimeDir, "identity.json"),
        JSON.stringify({
          agentId: args.identity.agentId,
          agentName: args.agentName,
          serverUrl: args.serverUrl,
          contextSourceKind: args.contextSourceKind,
          contextTreePath: args.contextTreePath,
        }),
      );
    },
  ),
  deepEqualIdentity: vi.fn(() => true),
  ensureWorkspaceRuntimeDir: vi.fn((workspacePath: string) => {
    const dir = join(workspacePath, ".first-tree-workspace");
    mkdirSync(dir, { recursive: true });
    return dir;
  }),
  installCoreSkills: vi.fn(),
  installFirstTreeIntegration: vi.fn(() => true),
  isHubWorktreeMarker: vi.fn(() => false),
  readCachedBundledCliVersion: vi.fn(() => null),
  readCachedContextTreeHead: vi.fn(() => null),
  readContextTreeHead: vi.fn(() => null),
  resolveBundledCliVersion: vi.fn(() => "0.0.0-test"),
  writeAgentBriefing: vi.fn((workspacePath: string, briefing: string) => {
    writeFileSync(join(workspacePath, "AGENTS.md"), briefing);
    symlinkSync("AGENTS.md", join(workspacePath, "CLAUDE.md"));
  }),
  writeBundledCliVersion: vi.fn(),
  writeContextTreeHead: vi.fn(),
}));

vi.mock("../../../runtime/chat-context.js", () => ({
  fetchChatContext: vi.fn(async (): Promise<ChatContext> => {
    return {
      chatId: "chat-usage-limit",
      title: "usage limit",
      topic: null,
      description: null,
      participants: [],
    };
  }),
}));

import { deliveryTokenFromSessionContext } from "../../../runtime/handler.js";
import { createCodexHandler, createCodexSdkHandler } from "../index.js";
import { LANDING_TRIAL_TURN_COMPLETION_CONFIRM_FAILED } from "../turn-completion.js";

const AGENT_ID = "019e71c9-88d2-70be-be67-fdb033b2ef0b";

let workspaceRoot: string;

const trialAgentMetadata = {
  landingCampaignTrial: true,
  campaign: "production-scan",
  skillSetId: "production-scan",
  skillSetVersion: "2026.07.02.1",
  repo: {
    url: "https://github.com/acme/backend",
    canonicalKey: "github.com/acme/backend",
  },
};

type SendMessageMock = ReturnType<typeof vi.fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>>;

function makeMessage(id: string, content: string, inboxEntryId?: number): SessionMessage {
  return {
    ...(inboxEntryId !== undefined ? { inboxEntryId } : {}),
    id,
    chatId: "chat-usage-limit",
    senderId: "sender-1",
    format: "text",
    content,
    metadata: {},
  };
}

function makeContext(
  onFinishTurn: (count?: number, outcome?: { status: "success" | "error"; reason?: string }) => void,
  opts: {
    sendMessage?: SendMessageMock;
    emitEvent?: SessionContext["emitEvent"];
    noteTurnStart?: SessionContext["noteTurnStart"];
    emitEventConfirmed?: SessionContext["emitEventConfirmed"];
    failSessionForRecovery?: SessionContext["failSessionForRecovery"];
    log?: SessionContext["log"];
    retryTurn?: SessionContext["retryTurn"];
    agentMetadata?: Record<string, unknown>;
  } = {},
): SessionContext {
  const sendMessage =
    opts.sendMessage ??
    vi.fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>().mockResolvedValue(undefined);
  return {
    agent: {
      agentId: AGENT_ID,
      inboxId: `inbox_${AGENT_ID}`,
      displayName: "codex-assistant",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: opts.agentMetadata ?? {},
    },
    sdk: { serverUrl: "http://test", sendMessage } as unknown as SessionContext["sdk"],
    chatId: "chat-usage-limit",
    log: opts.log ?? (() => {}),
    recordProviderActivity: () => {},
    noteTurnStart: opts.noteTurnStart ?? (() => {}),
    emitEvent: opts.emitEvent ?? (() => {}),
    ...(opts.emitEventConfirmed ? { emitEventConfirmed: opts.emitEventConfirmed } : {}),
    ...(opts.failSessionForRecovery ? { failSessionForRecovery: opts.failSessionForRecovery } : {}),
    ...mockCtxPlumbing({ sendMessage }, "chat-usage-limit"),
    // Production-faithful: the final-text forward is retired, so it delivers
    // nothing. (mockCtxPlumbing's stub would proxy to sendMessage and mask
    // that — the usage-limit notice is delivered by an EXPLICIT sdk.sendMessage
    // in the handler, NOT through this path.)
    forwardResult: async () => {},
    retryTurn: opts.retryTurn ?? (() => {}),
    finishTurn: async (messages, outcome) => {
      onFinishTurn(Array.isArray(messages) ? messages.length : 1, outcome);
    },
  };
}

const zeroUsage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ft-codex-usage-limit-"));
  state.runInputs.length = 0;
  state.turns = [];
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("codex turn liveness at the provider boundary", () => {
  it("marks the turn started at turn.started, before any displayable event", async () => {
    // The chat must read Working from the turn boundary, not from the first
    // thing the model happens to say. `turn.started` is followed here by a
    // completion with no item events at all — the extreme case of the head of
    // a turn being pure latency — and the boundary signal still has to fire.
    // Anything weaker leaves a provider-owned turn (no inbox custody to fall
    // back on) reading Idle for as long as the model takes to produce output.
    state.turns = [[{ type: "turn.started" }, { type: "turn.completed", usage: zeroUsage }]];

    const order: string[] = [];
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "test-agent",
    });
    const ctx = makeContext(() => {}, {
      noteTurnStart: () => order.push("turn_start"),
      emitEvent: (event) => order.push(`event:${event.kind}`),
      sendMessage: vi
        .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
        .mockResolvedValue(undefined),
    });
    await handler.start(makeMessage("msg-boundary", "hello"), ctx, deliveryTokenFromSessionContext(ctx));
    await vi.waitFor(() => expect(order).toContain("event:turn_end"));

    // Started first, ended last, and nothing displayable in between.
    expect(order[0]).toBe("turn_start");
    expect(order[order.length - 1]).toBe("event:turn_end");
    expect(order.filter((e) => e === "event:assistant_text" || e === "event:tool_call")).toEqual([]);
  });
});

describe("codex usage-limit empty-turn (issue #971)", () => {
  it("surfaces a chat notice + error event when the turn completes with no reply and zero token delta", async () => {
    // turn.completed with zero usage and NO agent_message — the model was
    // never invoked (account usage limit exhausted).
    state.turns = [[{ type: "turn.completed", usage: zeroUsage }]];

    const completedCounts: Array<number | undefined> = [];
    const logs: string[] = [];
    const sendMessage = vi
      .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "test-agent",
    });
    const ctx = makeContext((count) => completedCounts.push(count), {
      sendMessage,
      emitEvent,
      log: (message) => logs.push(message),
    });

    await handler.start(makeMessage("m1", "hello"), ctx, deliveryTokenFromSessionContext(ctx));

    const events = emitEvent.mock.calls.map(([event]) => event);

    // Layer 1-A: a chat-visible notice is posted by an EXPLICIT sdk.sendMessage
    // (NOT the retired final-text forward), carrying the agent-final-text
    // delivery profile so it lands recipientless without waking anyone.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(String(sendMessage.mock.calls[0]?.[1].content)).toContain("usage limit");
    expect(sendMessage.mock.calls[0]?.[1].purpose).toBe("agent-final-text");
    expect(sendMessage.mock.calls[0]?.[1].metadata).toMatchObject({ [RUNTIME_NOTICE_METADATA_KEY]: true });

    // Layer 2: an `error` event is emitted (daemon log + admin stream), and a
    // warn-style log line is recorded — not a phantom success.
    const errorEvents = events.filter((event) => event.kind === "error");
    expect(
      errorEvents.some(
        (event) => event.kind === "error" && event.payload.message.includes("codex usage limit reached"),
      ),
    ).toBe(true);
    expect(logs.some((line) => line.includes("codex usage limit reached"))).toBe(true);

    // turn_end is reported as an error, never as success.
    expect(events.some((event) => event.kind === "turn_end" && event.payload.status === "error")).toBe(true);
    expect(events.some((event) => event.kind === "turn_end" && event.payload.status === "success")).toBe(false);

    // MVP scope: the message is still acked (no auto-redelivery). The user
    // resends manually once the limit resets.
    expect(completedCounts).toEqual([1]);

    await handler.shutdown();
  });

  it("does NOT flag a legitimate silent turn (model ran, burned tokens, chose to stay silent)", async () => {
    // turn.completed with NON-zero usage and NO agent_message — the model ran
    // and the agent deliberately produced no reply (silent-turn protocol).
    state.turns = [
      [
        {
          type: "turn.completed",
          usage: { input_tokens: 120, cached_input_tokens: 10, output_tokens: 0, reasoning_output_tokens: 4 },
        },
      ],
    ];

    const completedCounts: Array<number | undefined> = [];
    const logs: string[] = [];
    const sendMessage = vi
      .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "test-agent",
    });
    const ctx = makeContext((count) => completedCounts.push(count), {
      sendMessage,
      emitEvent,
      log: (message) => logs.push(message),
    });

    await handler.start(makeMessage("m1", "hello"), ctx, deliveryTokenFromSessionContext(ctx));

    const events = emitEvent.mock.calls.map(([event]) => event);

    // No notice, no usage-limit error/log — a chosen silence is left alone.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      events.some((event) => event.kind === "error" && event.payload.message.includes("codex usage limit reached")),
    ).toBe(false);
    expect(logs.some((line) => line.includes("codex usage limit reached"))).toBe(false);

    // A silent turn is a success (the agent's explicit signal of "nothing to add").
    expect(events.some((event) => event.kind === "turn_end" && event.payload.status === "success")).toBe(true);
    expect(completedCounts).toEqual([1]);

    await handler.shutdown();
  });

  it("a normal reply reports success and is NOT delivered to chat (final-text mirror retired)", async () => {
    state.turns = [
      [
        { type: "item.completed", item: { type: "agent_message", text: "here is your answer" } },
        {
          type: "turn.completed",
          usage: { input_tokens: 200, cached_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 0 },
        },
      ],
    ];

    const completedCounts: Array<number | undefined> = [];
    const sendMessage = vi
      .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "test-agent",
    });
    const ctx = makeContext((count) => completedCounts.push(count), { sendMessage, emitEvent });

    await handler.start(makeMessage("m1", "hello"), ctx, deliveryTokenFromSessionContext(ctx));

    const events = emitEvent.mock.calls.map(([event]) => event);
    // The final text is the agent's output stream, not a chat message — it is
    // NOT forwarded. The turn still completes successfully.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      events.some((event) => event.kind === "error" && event.payload.message.includes("codex usage limit reached")),
    ).toBe(false);
    expect(events.some((event) => event.kind === "turn_end" && event.payload.status === "success")).toBe(true);
    expect(completedCounts).toEqual([1]);

    await handler.shutdown();
  });

  it("does not block ordinary SDK delivery on confirmed event rejection", async () => {
    state.turns = [
      [
        { type: "item.completed", item: { type: "agent_message", text: "here is your answer" } },
        {
          type: "turn.completed",
          usage: { input_tokens: 200, cached_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 0 },
        },
      ],
    ];

    const completedCounts: Array<number | undefined> = [];
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const emitEventConfirmed = vi
      .fn<NonNullable<SessionContext["emitEventConfirmed"]>>()
      .mockRejectedValue(new Error("session event persist failed"));
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "test-agent",
    });
    const ctx = makeContext((count) => completedCounts.push(count), { emitEvent, emitEventConfirmed });

    await handler.start(makeMessage("m1", "hello"), ctx, deliveryTokenFromSessionContext(ctx));

    expect(emitEventConfirmed).not.toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledWith({
      kind: "turn_end",
      payload: { status: "success" },
    });
    expect(completedCounts).toEqual([1]);

    await handler.shutdown();
  });

  it("leaves landing trial SDK delivery recoverable when confirmed success turn_end is rejected", async () => {
    state.turns = [
      [
        { type: "item.completed", item: { type: "agent_message", text: "here is your answer" } },
        {
          type: "turn.completed",
          usage: { input_tokens: 200, cached_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 0 },
        },
      ],
    ];

    const completedCounts: Array<number | undefined> = [];
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const failSessionForRecovery = vi.fn<NonNullable<SessionContext["failSessionForRecovery"]>>();
    const emitEventConfirmed = vi
      .fn<NonNullable<SessionContext["emitEventConfirmed"]>>()
      .mockRejectedValue(new Error("session event persist failed"));
    const handler = createCodexSdkHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "test-agent",
    });
    const message = makeMessage("m1", "hello", 101);
    const ctx = makeContext((count) => completedCounts.push(count), {
      emitEventConfirmed,
      failSessionForRecovery,
      retryTurn,
      agentMetadata: trialAgentMetadata,
    });

    await handler.start(message, ctx, deliveryTokenFromSessionContext(ctx));

    expect(emitEventConfirmed).toHaveBeenCalledWith({
      kind: "turn_end",
      payload: { status: "success", turnCompletionId: "inbox:101" },
    });
    expect(completedCounts).toEqual([]);
    expect(retryTurn).toHaveBeenCalledWith([message], LANDING_TRIAL_TURN_COMPLETION_CONFIRM_FAILED);
    expect(failSessionForRecovery).toHaveBeenCalledWith(
      LANDING_TRIAL_TURN_COMPLETION_CONFIRM_FAILED,
      "thread-usage-limit",
    );

    await handler.shutdown();
  });

  it("settles provider-entered rate limits as consumed errors instead of retrying the inbox entry", async () => {
    state.turns = [[{ type: "turn.failed", error: { message: "rate limit exceeded; retry later" } }]];

    const completed: Array<{ count?: number; reason?: string }> = [];
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "test-agent",
    });
    const ctx = makeContext((count, outcome) => completed.push({ count, reason: outcome?.reason }), {
      emitEvent,
      retryTurn,
    });

    await handler.start(makeMessage("m1", "hello"), ctx, deliveryTokenFromSessionContext(ctx));

    expect(retryTurn).not.toHaveBeenCalled();
    expect(completed).toEqual([{ count: 1, reason: "capacity_wait_required" }]);
    expect(
      emitEvent.mock.calls.some(
        ([event]) => event.kind === "error" && event.payload.message.includes("provider.retry:"),
      ),
    ).toBe(true);
    expect(emitEvent.mock.calls.some(([event]) => event.kind === "turn_end" && event.payload.status === "error")).toBe(
      true,
    );

    await handler.shutdown();
  });

  it("keeps pre-provider exhausted network failures retryable instead of consuming the inbox entry", async () => {
    state.turns = [[new Error("fetch failed")], [new Error("fetch failed")], [new Error("fetch failed")]];

    const completedCounts: Array<number | undefined> = [];
    const retryReasons: string[] = [];
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "test-agent",
    });
    const ctx = makeContext((count) => completedCounts.push(count), {
      emitEvent,
      retryTurn: (_messages, reason) => retryReasons.push(reason),
    });

    await handler.start(makeMessage("m-pre-provider", "hello"), ctx, deliveryTokenFromSessionContext(ctx));

    expect(state.runInputs).toHaveLength(3);
    expect(completedCounts).toEqual([]);
    expect(retryReasons).toEqual(["provider_transient_transport_exhausted"]);
    const events = emitEvent.mock.calls.map(([event]) => event);
    expect(events.some((event) => event.kind === "turn_end" && event.payload.status === "error")).toBe(true);

    await handler.shutdown();
  });
});
