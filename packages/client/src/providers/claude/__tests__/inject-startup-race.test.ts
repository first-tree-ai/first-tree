import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCtxPlumbing } from "../../../__tests__/test-helpers.js";
import { formatInboundContent } from "../../../runtime/agent-io.js";
import type { ChatContext } from "../../../runtime/chat-context.js";
import type { SessionContext, SessionMessage } from "../../../runtime/handler.js";
import {
  buildTeamSkillCommandRegistry,
  rewriteSessionMessageCommand,
} from "../../../runtime/team-skill-command-rewrite.js";

const state = vi.hoisted(() => ({
  chatContextPromise: null as Promise<ChatContext> | null,
  resolveChatContext: null as ((value: ChatContext) => void) | null,
  observedInputs: [] as string[],
  pendingResults: [] as unknown[],
  waiters: [] as Array<() => void>,
  coalesceFirstResultAfterInputs: null as number | null,
  resultMessagesForInput: null as ((turn: number) => unknown[]) | null,
  closeAfterInput: false,
  queryCalls: 0,
}));

function wakeQuery(): void {
  const waiters = state.waiters.splice(0);
  for (const waiter of waiters) waiter();
}

function flattenContent(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: AsyncIterable<{ message: { content: unknown } }> }) => {
    state.queryCalls += 1;
    let closed = false;

    void (async () => {
      for await (const sdkMsg of args.prompt) {
        state.observedInputs.push(flattenContent(sdkMsg.message.content));
        const turn = state.observedInputs.length;
        if (state.coalesceFirstResultAfterInputs !== null) {
          if (turn < state.coalesceFirstResultAfterInputs) continue;
          state.coalesceFirstResultAfterInputs = null;
        }
        const messages = state.resultMessagesForInput?.(turn) ?? [
          {
            type: "result",
            subtype: "success",
            result: `reply ${turn}`,
          },
        ];
        state.pendingResults.push(...messages);
        wakeQuery();
        if (state.closeAfterInput) {
          closed = true;
          wakeQuery();
          return;
        }
      }
      closed = true;
      wakeQuery();
    })();

    return {
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<unknown>> => {
            while (state.pendingResults.length === 0 && !closed) {
              await new Promise<void>((resolve) => state.waiters.push(resolve));
            }
            const value = state.pendingResults.shift();
            if (value) return { value, done: false };
            return { value: undefined, done: true };
          },
        };
      },
      close: () => {
        closed = true;
        wakeQuery();
      },
      setModel: async () => {},
    };
  },
}));

vi.mock("../../../runtime/agent-bootstrap.js", () => ({
  ensureAgentBootstrap: vi.fn(
    (args: {
      workspace: string;
      agentName: string;
      contextTreePath: string | null;
      contextSourceKind: string;
      briefing: string;
      sessionCtx: { agent: SessionContext["agent"]; sdk: { serverUrl: string } };
    }) => {
      const runtimeDir = join(args.workspace, ".first-tree-workspace");
      mkdirSync(runtimeDir, { recursive: true });
      writeFileSync(
        join(runtimeDir, "identity.json"),
        JSON.stringify({
          agentId: args.sessionCtx.agent.agentId,
          agentName: args.agentName,
          displayName: args.sessionCtx.agent.displayName,
          type: args.sessionCtx.agent.type,
          visibility: args.sessionCtx.agent.visibility,
          delegateMention: args.sessionCtx.agent.delegateMention,
          metadata: args.sessionCtx.agent.metadata,
          serverUrl: args.sessionCtx.sdk.serverUrl,
          contextSourceKind: args.contextSourceKind,
          contextTreePath: args.contextTreePath,
        }),
      );
      writeFileSync(join(args.workspace, "AGENTS.md"), args.briefing);
      const claudePath = join(args.workspace, "CLAUDE.md");
      rmSync(claudePath, { force: true });
      if (process.platform === "win32") writeFileSync(claudePath, args.briefing);
      else symlinkSync("AGENTS.md", claudePath);
    },
  ),
}));

vi.mock("../../../runtime/bootstrap.js", () => ({
  FIRST_TREE_RUNTIME_DIR: ".first-tree-workspace",
  FIRST_TREE_WORKSPACE_MARKER: ".first-tree-workspace",
  ensureWorkspaceRuntimeDir: vi.fn((workspacePath: string) => {
    const dir = join(workspacePath, ".first-tree-workspace");
    mkdirSync(dir, { recursive: true });
    return dir;
  }),
  writeAgentBriefing: vi.fn(),
}));

vi.mock("../../../runtime/agent-briefing.js", () => ({
  buildAgentBriefing: vi.fn(
    () => "<!-- first-tree:generated -->\nThis briefing was generated without a safe Context source.\n",
  ),
}));

vi.mock("../../../runtime/chat-context.js", () => ({
  fetchChatContext: vi.fn(async () => {
    if (!state.chatContextPromise) throw new Error("chat context gate was not initialised");
    return state.chatContextPromise;
  }),
}));

vi.mock("../../../runtime/source-repos.js", () => ({
  declaredSourceRepos: vi.fn(() => []),
  currentSourceRepoNamesFromPayload: vi.fn(() => null),
}));

import { deliveryTokenFromSessionContext } from "../../../runtime/handler.js";
import { createClaudeCodeHandler } from "../index.js";

const AGENT_ID = "019e71d2-c9ec-7f11-86bf-5dfc9e873338";

let workspaceRoot: string;

function makeMessage(id: string, content: string): SessionMessage {
  return {
    id,
    chatId: "chat-claude-startup-race",
    senderId: "sender-1",
    format: "text",
    content,
    metadata: {},
  };
}

function makeFileMessage(
  id: string,
  content: Record<string, unknown>,
  chatId = "chat-claude-startup-race",
): SessionMessage {
  return {
    id,
    chatId,
    senderId: "sender-1",
    format: "file",
    content,
    metadata: {},
  };
}

function makeContext(
  onFinishTurn: (count?: number) => void,
  opts: {
    formatInboundContent?: SessionContext["formatInboundContent"];
    getAgentContextTreeConfig?: () => Promise<unknown>;
  } = {},
): SessionContext {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  return {
    agent: {
      agentId: AGENT_ID,
      inboxId: `inbox_${AGENT_ID}`,
      displayName: "codex-developer",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: {
      serverUrl: "http://test",
      sendMessage,
      ...(opts.getAgentContextTreeConfig ? { getAgentContextTreeConfig: opts.getAgentContextTreeConfig } : {}),
    } as unknown as SessionContext["sdk"],
    chatId: "chat-claude-startup-race",
    log: () => {},
    recordProviderActivity: () => {},
    noteTurnStart: () => {},
    emitEvent: () => {},
    ...mockCtxPlumbing({ sendMessage }, "chat-claude-startup-race"),
    ...(opts.formatInboundContent ? { formatInboundContent: opts.formatInboundContent } : {}),
    finishTurn: async () => {
      onFinishTurn();
    },
  };
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!assertion()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for assertion");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ft-claude-startup-race-"));
  state.observedInputs.length = 0;
  state.pendingResults.length = 0;
  state.waiters.length = 0;
  state.coalesceFirstResultAfterInputs = null;
  state.resultMessagesForInput = null;
  state.closeAfterInput = false;
  state.queryCalls = 0;
  state.chatContextPromise = new Promise((resolve) => {
    state.resolveChatContext = resolve;
  });
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  state.chatContextPromise = null;
  state.resolveChatContext = null;
  state.pendingResults.length = 0;
  state.coalesceFirstResultAfterInputs = null;
  state.resultMessagesForInput = null;
  state.closeAfterInput = false;
  state.queryCalls = 0;
  wakeQuery();
});

describe("claude-code handler startup inject queue", () => {
  it.each([
    "start",
    "resume",
  ] as const)("rejects a Context source change during %s message conversion before spawning a query", async (operation) => {
    const repoA = "https://github.com/acme/tree-a.git";
    let authoritativeRepo = repoA;
    let releaseFormat: (() => void) | undefined;
    let markFormatEntered: (() => void) | undefined;
    const formatEntered = new Promise<void>((resolve) => {
      markFormatEntered = resolve;
    });
    const formatGate = new Promise<void>((resolve) => {
      releaseFormat = resolve;
    });
    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
      contextSourceKind: "remote",
      contextTreePath: join(workspaceRoot, "context-tree"),
      contextTreeRepoUrl: repoA,
      contextTreeBranch: "main",
    });
    const ctx = makeContext(() => {}, {
      getAgentContextTreeConfig: async () => ({
        bindingState: "bound",
        repo: authoritativeRepo,
        branch: "main",
        provider: "github",
      }),
      formatInboundContent: async (message) => {
        markFormatEntered?.();
        await formatGate;
        const raw = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
        return `[From: ${message.senderId}]\n\n${raw}`;
      },
    });
    state.resolveChatContext?.({
      chatId: "chat-claude-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    const message = makeMessage(`source-${operation}`, "first");
    const resultPromise =
      operation === "start"
        ? handler.start(message, ctx, deliveryTokenFromSessionContext(ctx))
        : handler.resume(message, "missing-native-session", ctx, deliveryTokenFromSessionContext(ctx));
    await formatEntered;
    authoritativeRepo = "https://github.com/acme/tree-b.git";
    releaseFormat?.();

    await expect(resultPromise).rejects.toMatchObject({ name: "ContextSourceTransitionError" });
    expect(state.queryCalls).toBe(0);
    await handler.shutdown();
  });

  it("materializes legacy inline images and describes unavailable image batches", async () => {
    const completedCounts: Array<number | undefined> = [];
    const registry = buildTeamSkillCommandRegistry([
      { requestedSlug: "review", resourceId: "res-review-1", effectiveName: "review-first-tree" },
    ]);
    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
    });
    const ctx = makeContext(
      (count) => {
        completedCounts.push(count);
      },
      {
        formatInboundContent: async (message) =>
          formatInboundContent(
            rewriteSessionMessageCommand(message, registry, {
              allowMentionPrefix:
                Array.isArray(message.metadata?.mentions) && message.metadata.mentions.includes(AGENT_ID),
            }),
            { get: async () => [] },
          ),
      },
    );
    state.resolveChatContext?.({
      chatId: "chat-claude-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(
      makeFileMessage(
        "legacy-image",
        {
          data: Buffer.from("fake image bytes").toString("base64"),
          mimeType: "image/png",
          filename: "legacy.png",
        },
        "../unsafe/chat",
      ),
      ctx,
      deliveryTokenFromSessionContext(ctx),
    );

    const batchMessage = makeFileMessage("batch-images", {
      caption: "@nova /review Compare these screenshots",
      attachments: [
        {
          imageId: "00000000-0000-4000-8000-000000000001",
          mimeType: "image/png",
          filename: "one.png",
          size: 12,
        },
        {
          imageId: "00000000-0000-4000-8000-000000000002",
          mimeType: "image/jpeg",
          filename: "two.jpg",
          size: 34,
        },
      ],
    });
    batchMessage.metadata = { mentions: [AGENT_ID] };
    batchMessage.precedingMessages = [
      {
        id: "earlier-request",
        senderId: "agent-2",
        format: "request",
        content: "Which earlier layout should ship?",
        metadata: {
          request: {},
          attachments: [
            {
              attachmentId: "00000000-0000-4000-8000-000000000003",
              kind: "image",
              mimeType: "image/png",
              filename: "decision.png",
              size: 56,
            },
          ],
        },
        createdAt: "2026-07-24T00:00:00.000Z",
      },
    ];
    handler.inject(batchMessage, deliveryTokenFromSessionContext(ctx));

    await waitFor(() => state.observedInputs.length === 2);
    expect(state.observedInputs[0]).toContain("Filename: legacy.png");
    expect(state.observedInputs[0]).toContain(join("first-tree", "images", "unknown"));
    expect(state.observedInputs[0]).toContain(".png");
    expect(state.observedInputs[1]).toContain("@nova /review-first-tree Compare these screenshots");
    expect(state.observedInputs[1]).toContain("[Earlier in chat — context you missed]");
    expect(state.observedInputs[1]).toContain("Which earlier layout should ship?");
    expect(state.observedInputs[1]).toContain('[Image "decision.png" not available on this device]');
    expect(state.observedInputs[1]).toContain("2 images were shared in this chat");
    expect(state.observedInputs[1]).toContain('[Image "one.png" not available on this device]');
    expect(state.observedInputs[1]).toContain('[Image "two.jpg" not available on this device]');
    expect(completedCounts).toEqual([undefined, undefined]);

    await handler.shutdown();
  });

  it("queues injects received before the InputController exists so their inbox entries stay aligned with acks", async () => {
    const completedCounts: Array<number | undefined> = [];
    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
    });
    const ctx = makeContext((count) => {
      completedCounts.push(count);
    });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await Promise.resolve();

    // The handler has a session id, but startup is still waiting on chat
    // context; `spawnQuery` has not created the InputController yet.
    handler.inject(makeMessage("m2", "second"), deliveryTokenFromSessionContext(ctx));

    state.resolveChatContext?.({
      chatId: "chat-claude-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await startPromise;
    await waitFor(() => state.observedInputs.length === 2);
    await waitFor(() => completedCounts.length === 1);

    expect(state.observedInputs[0]).toContain("first");
    expect(state.observedInputs[1]).toContain("second");
    expect(completedCounts).toEqual([undefined]);

    await handler.shutdown();
  });

  it("keeps startup-queued injects ahead of ready-state injects after start returns", async () => {
    const completedCounts: Array<number | undefined> = [];
    const releaseSecond: { current: (() => void) | null } = { current: null };
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond.current = resolve;
    });
    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
    });
    const ctx = makeContext(
      (count) => {
        completedCounts.push(count);
      },
      {
        formatInboundContent: async (message) => {
          if (message.id === "m2") await secondGate;
          const raw = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
          return `[From: ${message.senderId}]\n\n${raw}`;
        },
      },
    );

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await Promise.resolve();
    handler.inject(makeMessage("m2", "second"), deliveryTokenFromSessionContext(ctx));

    state.resolveChatContext?.({
      chatId: "chat-claude-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await startPromise;
    handler.inject(makeMessage("m3", "third"), deliveryTokenFromSessionContext(ctx));
    await new Promise((resolve) => setImmediate(resolve));
    releaseSecond.current?.();

    await waitFor(() => state.observedInputs.length === 3);
    await waitFor(() => completedCounts.length === 3);

    expect(state.observedInputs[0]).toContain("first");
    expect(state.observedInputs[1]).toContain("second");
    expect(state.observedInputs[2]).toContain("third");
    expect(completedCounts).toEqual([undefined, undefined, undefined]);

    await handler.shutdown();
  });

  it("settles coalesced SDK inputs as one provider turn", async () => {
    state.coalesceFirstResultAfterInputs = 2;
    const finishedBatches: string[][] = [];
    const processingStarted: string[] = [];
    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
    });
    const ctx = makeContext(() => {});
    ctx.markMessagesConsumed = (messages) => {
      const batch = Array.isArray(messages) ? messages : [messages];
      processingStarted.push(...batch.map((message) => message.id));
    };
    ctx.finishTurn = async (messages) => {
      const batch = Array.isArray(messages) ? messages : [messages];
      finishedBatches.push(batch.map((message) => message.id));
    };

    state.resolveChatContext?.({
      chatId: "chat-claude-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    handler.inject(makeMessage("m2", "second"), deliveryTokenFromSessionContext(ctx));

    await waitFor(() => state.observedInputs.length === 2);
    await waitFor(() => finishedBatches.length === 1);

    expect(state.observedInputs[0]).toContain("first");
    expect(state.observedInputs[1]).toContain("second");
    expect(processingStarted).toEqual(["m1", "m2"]);
    expect(finishedBatches).toEqual([["m1", "m2"]]);

    await handler.shutdown();
  });

  it("retries active injects whose SDK message conversion fails before provider custody", async () => {
    const completedCounts: Array<number | undefined> = [];
    const retryTurn = vi.fn();
    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
    });
    const ctx = makeContext(
      (count) => {
        completedCounts.push(count);
      },
      {
        formatInboundContent: async (message) => {
          if (message.id === "m2") throw new Error("format failed");
          const raw = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
          return `[From: ${message.senderId}]\n\n${raw}`;
        },
      },
    );
    ctx.retryTurn = retryTurn;

    state.resolveChatContext?.({
      chatId: "chat-claude-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    handler.inject(makeMessage("m2", "bad"), deliveryTokenFromSessionContext(ctx));

    await waitFor(() => retryTurn.mock.calls.length === 1);

    expect(state.observedInputs).toHaveLength(1);
    expect(completedCounts).toEqual([undefined]);
    expect(retryTurn).toHaveBeenCalledWith(makeMessage("m2", "bad"), "claude_inject_format_failed");

    await handler.shutdown();
  });

  it("logs token usage emit failures without blocking successful turn close", async () => {
    const events: Array<Parameters<SessionContext["emitEvent"]>[0]> = [];
    const logs: string[] = [];
    const outcomes: unknown[] = [];
    state.resultMessagesForInput = () => [
      {
        type: "result",
        subtype: "success",
        result: "reply with usage",
        modelUsage: {
          "claude-sonnet-4-5": {
            inputTokens: 3,
            cacheCreationInputTokens: 2,
            cacheReadInputTokens: 5,
            outputTokens: 7,
          },
          "empty-model": {
            inputTokens: 0,
            cacheReadInputTokens: 0,
            outputTokens: 0,
          },
          missing: null,
        },
      },
    ];
    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
    });
    const ctx = makeContext(() => {});
    ctx.log = (message) => {
      logs.push(message);
    };
    ctx.emitEvent = (event) => {
      events.push(event);
      if (event.kind === "token_usage") throw new Error("event store down");
    };
    ctx.finishTurn = async (_messages, outcome) => {
      outcomes.push(outcome);
    };
    state.resolveChatContext?.({
      chatId: "chat-claude-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "usage"), ctx, deliveryTokenFromSessionContext(ctx));

    await waitFor(() => events.some((event) => event.kind === "turn_end"));
    expect(events.find((event) => event.kind === "token_usage")).toMatchObject({
      kind: "token_usage",
      payload: {
        provider: "claude-code",
        model: "claude-sonnet-4-5",
        inputTokens: 5,
        cachedInputTokens: 5,
        outputTokens: 7,
      },
    });
    expect(logs).toContain("Failed to emit token_usage: event store down");
    expect(events.filter((event) => event.kind === "turn_end")).toEqual([
      { kind: "turn_end", payload: { status: "success" } },
    ]);
    expect(outcomes).toEqual([{ status: "success", terminal: true }]);

    await handler.shutdown();
  });

  it("emits per-turn token deltas from cumulative model usage snapshots", async () => {
    const events: Array<Parameters<SessionContext["emitEvent"]>[0]> = [];
    state.resultMessagesForInput = (turn) => [
      {
        type: "result",
        subtype: "success",
        result: `reply ${turn}`,
        modelUsage:
          turn === 1
            ? {
                "claude-sonnet-4-5": {
                  inputTokens: 10,
                  cacheCreationInputTokens: 4,
                  cacheReadInputTokens: 100,
                  outputTokens: 2,
                },
                "claude-haiku-4-5": {
                  inputTokens: 3,
                  cacheCreationInputTokens: 0,
                  cacheReadInputTokens: 20,
                  outputTokens: 1,
                },
              }
            : {
                "claude-sonnet-4-5": {
                  inputTokens: 15,
                  cacheCreationInputTokens: 7,
                  cacheReadInputTokens: 160,
                  outputTokens: 5,
                },
                // Unchanged models remain in Claude's cumulative snapshot but
                // must not produce another usage event for this turn.
                "claude-haiku-4-5": {
                  inputTokens: 3,
                  cacheCreationInputTokens: 0,
                  cacheReadInputTokens: 20,
                  outputTokens: 1,
                },
              },
      },
    ];
    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
    });
    const ctx = makeContext(() => {});
    ctx.emitEvent = (event) => {
      events.push(event);
    };
    state.resolveChatContext?.({
      chatId: "chat-claude-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first usage turn"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => events.filter((event) => event.kind === "turn_end").length === 1);
    handler.inject(makeMessage("m2", "second usage turn"), deliveryTokenFromSessionContext(ctx));
    await waitFor(() => events.filter((event) => event.kind === "turn_end").length === 2);

    expect(events.filter((event) => event.kind === "token_usage")).toEqual([
      {
        kind: "token_usage",
        payload: {
          provider: "claude-code",
          model: "claude-sonnet-4-5",
          inputTokens: 14,
          cachedInputTokens: 100,
          outputTokens: 2,
        },
      },
      {
        kind: "token_usage",
        payload: {
          provider: "claude-code",
          model: "claude-haiku-4-5",
          inputTokens: 3,
          cachedInputTokens: 20,
          outputTokens: 1,
        },
      },
      {
        kind: "token_usage",
        payload: {
          provider: "claude-code",
          model: "claude-sonnet-4-5",
          inputTokens: 8,
          cachedInputTokens: 60,
          outputTokens: 3,
        },
      },
    ]);

    await handler.shutdown();
  });

  it("treats a cumulative counter rollback within one Query as a fresh counter", async () => {
    const events: Array<Parameters<SessionContext["emitEvent"]>[0]> = [];
    state.resultMessagesForInput = (turn) => [
      {
        type: "result",
        subtype: "success",
        result: `reply ${turn}`,
        modelUsage: {
          "claude-sonnet-4-5": {
            inputTokens: turn === 1 ? 10 : 4,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            outputTokens: 0,
          },
        },
      },
    ];
    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
    });
    const ctx = makeContext(() => {});
    ctx.emitEvent = (event) => {
      events.push(event);
    };
    state.resolveChatContext?.({
      chatId: "chat-claude-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "before counter rollback"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => events.filter((event) => event.kind === "turn_end").length === 1);
    handler.inject(makeMessage("m2", "after counter rollback"), deliveryTokenFromSessionContext(ctx));
    await waitFor(() => events.filter((event) => event.kind === "turn_end").length === 2);

    expect(
      events
        .filter((event) => event.kind === "token_usage")
        .map((event) => (event.kind === "token_usage" ? event.payload.inputTokens : null)),
    ).toEqual([10, 4]);

    await handler.shutdown();
  });

  it("starts a fresh cumulative usage baseline for a replacement Query", async () => {
    const events: Array<Parameters<SessionContext["emitEvent"]>[0]> = [];
    state.resultMessagesForInput = (turn) => [
      {
        type: "result",
        subtype: "success",
        result: `reply ${turn}`,
        modelUsage: {
          "claude-sonnet-4-5": {
            inputTokens: turn === 1 ? 10 : 14,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            outputTokens: 0,
          },
        },
      },
    ];
    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
    });
    const ctx = makeContext(() => {});
    ctx.emitEvent = (event) => {
      events.push(event);
    };
    state.resolveChatContext?.({
      chatId: "chat-claude-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    const started = await handler.start(makeMessage("m1", "first Query"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => events.filter((event) => event.kind === "turn_end").length === 1);
    await handler.suspend();
    const sessionId = typeof started === "string" ? started : started.sessionId;
    await handler.resume(makeMessage("m2", "replacement Query"), sessionId, ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => events.filter((event) => event.kind === "turn_end").length === 2);

    expect(
      events
        .filter((event) => event.kind === "token_usage")
        .map((event) => (event.kind === "token_usage" ? event.payload.inputTokens : null)),
    ).toEqual([10, 14]);

    await handler.shutdown();
  });

  it("reports forwardResult failures as terminal runtime turn errors", async () => {
    const events: Array<Parameters<SessionContext["emitEvent"]>[0]> = [];
    const logs: string[] = [];
    const outcomes: unknown[] = [];
    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
    });
    const ctx = makeContext(() => {});
    ctx.forwardResult = vi.fn(async () => {
      throw new Error("completion sink down");
    });
    ctx.log = (message) => {
      logs.push(message);
    };
    ctx.emitEvent = (event) => {
      events.push(event);
    };
    ctx.finishTurn = async (_messages, outcome) => {
      outcomes.push(outcome);
    };
    state.resolveChatContext?.({
      chatId: "chat-claude-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "forward"), ctx, deliveryTokenFromSessionContext(ctx));

    await waitFor(() => events.some((event) => event.kind === "turn_end"));
    expect(ctx.forwardResult).toHaveBeenCalledWith("reply 1");
    expect(logs).toContain("Failed to forward result: completion sink down");
    expect(events).toContainEqual({
      kind: "error",
      payload: {
        source: "runtime",
        message: "Result forward failed: completion sink down\n---\nreply 1",
      },
    });
    expect(events).toContainEqual({ kind: "turn_end", payload: { status: "error" } });
    expect(outcomes).toEqual([
      {
        status: "error",
        terminal: true,
        completion: "consumed",
        reason: "forward_failed",
      },
    ]);

    await handler.shutdown();
  });

  it("closes successful turns when the SDK result has no result text", async () => {
    const events: Array<Parameters<SessionContext["emitEvent"]>[0]> = [];
    const outcomes: unknown[] = [];
    state.resultMessagesForInput = () => [{ type: "result", subtype: "success" }];
    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
    });
    const ctx = makeContext(() => {});
    ctx.forwardResult = vi.fn(async () => {});
    ctx.emitEvent = (event) => {
      events.push(event);
    };
    ctx.finishTurn = async (_messages, outcome) => {
      outcomes.push(outcome);
    };
    state.resolveChatContext?.({
      chatId: "chat-claude-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "empty result"), ctx, deliveryTokenFromSessionContext(ctx));

    await waitFor(() => events.some((event) => event.kind === "turn_end"));
    expect(ctx.forwardResult).not.toHaveBeenCalled();
    expect(events).toContainEqual({ kind: "turn_end", payload: { status: "success" } });
    expect(outcomes).toEqual([{ status: "success", terminal: true }]);

    await handler.shutdown();
  });

  it("flushes deferred auth hints when the stream closes before a result", async () => {
    const events: Array<Parameters<SessionContext["emitEvent"]>[0]> = [];
    state.resultMessagesForInput = () => [{ type: "auth_status", error: "authentication_failed" }];
    state.closeAfterInput = true;
    const handler = createClaudeCodeHandler({
      runtimeProvider: "claude-code",
      workspaceRoot,
      agentName: "test-agent",
    });
    const ctx = makeContext(() => {});
    ctx.emitEvent = (event) => {
      events.push(event);
    };
    state.resolveChatContext?.({
      chatId: "chat-claude-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "auth"), ctx, deliveryTokenFromSessionContext(ctx));

    await waitFor(() => events.some((event) => event.kind === "error"));
    const errorEvent = events.find((event) => event.kind === "error");
    if (errorEvent?.kind !== "error") throw new Error("expected sdk error event");
    expect(errorEvent.payload.source).toBe("sdk");
    expect(errorEvent.payload.message).toContain("`claude auth login`");
    expect(errorEvent.payload.message).toContain("Original SDK error: authentication_failed");

    await handler.shutdown();
  });
});
