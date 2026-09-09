import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isImageBatchRefContent, parseProviderRetryEventMessage, type SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCtxPlumbing } from "../../../__tests__/test-helpers.js";
import type { ChatContext } from "../../../runtime/chat-context.js";
import type { SessionContext, SessionMessage } from "../../../runtime/handler.js";
import {
  buildTeamSkillCommandRegistry,
  rewriteSessionMessageCommand,
} from "../../../runtime/team-skill-command-rewrite.js";

const state = vi.hoisted(() => ({
  chatContextPromise: null as Promise<ChatContext> | null,
  resolveChatContext: null as ((value: ChatContext) => void) | null,
  runInputs: [] as unknown[],
  itemsByTurn: new Map<number, unknown[]>(),
  agentMessagesByTurn: new Map<number, string[]>(),
  failureByTurn: new Map<number, string>(),
  streamErrorByTurn: new Map<number, string>(),
  diagnosticAfterFirstMessageByTurn: new Map<number, string>(),
}));

vi.mock("@openai/codex-sdk", () => {
  const usage = {
    input_tokens: 1,
    cached_input_tokens: 0,
    output_tokens: 1,
    reasoning_output_tokens: 0,
  };

  const thread = {
    id: "thread-test",
    async runStreamed(input: unknown) {
      state.runInputs.push(input);
      const turn = state.runInputs.length;
      return {
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread-test" };
          const items = state.itemsByTurn.get(turn);
          if (items) {
            for (const item of items) {
              yield { type: "item.completed", item };
            }
          } else {
            const messages = state.agentMessagesByTurn.get(turn) ?? [`reply ${turn}`];
            const diagnosticAfterFirstMessage = state.diagnosticAfterFirstMessageByTurn.get(turn);
            for (const [index, text] of messages.entries()) {
              yield { type: "item.completed", item: { type: "agent_message", text } };
              if (index === 0 && diagnosticAfterFirstMessage) {
                yield { type: "error", message: diagnosticAfterFirstMessage };
              }
            }
          }
          const failure = state.failureByTurn.get(turn);
          if (failure) {
            yield { type: "turn.failed", error: { message: failure } };
            return;
          }
          const streamError = state.streamErrorByTurn.get(turn);
          if (streamError) {
            yield { type: "error", message: streamError };
            return;
          }
          yield { type: "turn.completed", usage };
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
  IDENTITY_JSON_REL: join(".first-tree-workspace", "identity.json"),
  bootstrapWorkspace: vi.fn(
    (options: {
      workspacePath: string;
      identity: SessionContext["agent"];
      agentName: string;
      contextTreePath: string | null;
      contextSourceKind?: "remote" | "local" | "none";
      serverUrl: string;
    }) => {
      const runtimeDir = join(options.workspacePath, ".first-tree-workspace");
      mkdirSync(runtimeDir, { recursive: true });
      writeFileSync(
        join(runtimeDir, "identity.json"),
        JSON.stringify({
          agentId: options.identity.agentId,
          agentName: options.agentName,
          displayName: options.identity.displayName,
          type: options.identity.type,
          visibility: options.identity.visibility,
          delegateMention: options.identity.delegateMention,
          metadata: options.identity.metadata,
          serverUrl: options.serverUrl,
          contextTreePath: options.contextTreePath,
          contextSourceKind: options.contextSourceKind ?? "none",
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
  writeAgentBriefing: vi.fn((workspacePath: string, content: string) => {
    writeFileSync(join(workspacePath, "AGENTS.md"), content);
    const claudePath = join(workspacePath, "CLAUDE.md");
    rmSync(claudePath, { force: true });
    if (process.platform === "win32") writeFileSync(claudePath, content);
    else symlinkSync("AGENTS.md", claudePath);
  }),
  writeBundledCliVersion: vi.fn(),
  writeContextTreeHead: vi.fn(),
}));

vi.mock("../../../runtime/chat-context.js", () => ({
  fetchChatContext: vi.fn(async () => {
    if (!state.chatContextPromise) throw new Error("chat context gate was not initialised");
    return state.chatContextPromise;
  }),
}));

import { deliveryTokenFromSessionContext } from "../../../runtime/handler.js";
import { createCodexHandler } from "../index.js";

const AGENT_ID = "019e71c9-88d2-70be-be67-fdb033b2ef0b";

let workspaceRoot: string;

type FakeAppServerRequest = {
  method: string;
  params: unknown;
};

class StartupFakeAppServerClient {
  readonly requests: FakeAppServerRequest[] = [];
  stderr = "";
  isClosed = false;
  shutdownCalls = 0;
  failThreadStart = false;
  failTurnStart = false;

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      if (this.failThreadStart) throw new Error("thread/start rejected");
      return { thread: { id: "thread-app-server" } };
    }
    if (method === "thread/resume") {
      return { thread: { id: "thread-app-server" } };
    }
    if (method === "turn/start") {
      if (this.failTurnStart) throw new Error("turn/start rejected after request");
      return { turn: { id: "turn-app-server", status: "inProgress", items: [], error: null } };
    }
    if (method === "turn/interrupt") {
      return {};
    }
    return {};
  }

  notify(): void {}

  shutdown(): void {
    this.shutdownCalls += 1;
    this.isClosed = true;
  }
}

function makeMessage(id: string, content: string): SessionMessage {
  return {
    id,
    chatId: "chat-startup-race",
    senderId: "sender-1",
    format: "text",
    content,
    metadata: {},
  };
}

type SendMessageMock = ReturnType<typeof vi.fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>>;

function makeContext(
  onFinishTurn: (count?: number) => void,
  opts: {
    sendMessage?: SendMessageMock;
    emitEvent?: SessionContext["emitEvent"];
    formatInboundContent?: SessionContext["formatInboundContent"];
    retryTurn?: SessionContext["retryTurn"];
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
      metadata: {},
    },
    sdk: { serverUrl: "http://test", sendMessage } as unknown as SessionContext["sdk"],
    chatId: "chat-startup-race",
    log: () => {},
    recordProviderActivity: () => {},
    noteTurnStart: () => {},
    emitEvent: opts.emitEvent ?? (() => {}),
    ...mockCtxPlumbing({ sendMessage }, "chat-startup-race"),
    ...(opts.formatInboundContent ? { formatInboundContent: opts.formatInboundContent } : {}),
    ...(opts.retryTurn ? { retryTurn: opts.retryTurn } : {}),
    finishTurn: async (messages) => {
      onFinishTurn(Array.isArray(messages) ? messages.length : 1);
    },
  };
}

function makeAutoHandler(fake: StartupFakeAppServerClient) {
  return createCodexHandler({
    runtimeProvider: "codex",
    workspaceRoot,
    agentName: "codex-race-test-agent",
    codexHandlerEngine: "auto",
    codexRuntimeBinaryResolver: async () => ({
      ok: true,
      binary: "/tmp/fake-codex",
      runtimeSource: "path",
      runtimePath: "/tmp/fake-codex",
      version: "0.0.0-test",
    }),
    codexAppServerClientFactory: async () => fake,
  });
}

function messageIds(messages: SessionMessage | readonly SessionMessage[]): string[] {
  return (Array.isArray(messages) ? messages : [messages]).map((message) => message.id);
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!assertion()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for assertion");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ft-codex-startup-race-"));
  state.runInputs.length = 0;
  state.itemsByTurn.clear();
  state.agentMessagesByTurn.clear();
  state.failureByTurn.clear();
  state.streamErrorByTurn.clear();
  state.diagnosticAfterFirstMessageByTurn.clear();
  state.chatContextPromise = new Promise((resolve) => {
    state.resolveChatContext = resolve;
  });
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  state.chatContextPromise = null;
  state.resolveChatContext = null;
});

describe("codex handler startup inject queue", () => {
  it("emits runtime events for every Codex SDK terminal item shape", async () => {
    const events: SessionEvent[] = [];
    const completedCounts: Array<number | undefined> = [];
    state.itemsByTurn.set(1, [
      { type: "agent_message", text: "   " },
      { type: "agent_message", text: "visible answer" },
      {
        type: "command_execution",
        id: "cmd-ok",
        status: "completed",
        command: "echo ok",
        aggregated_output: "x".repeat(450),
      },
      {
        type: "command_execution",
        id: "cmd-error",
        status: "failed",
        command: "exit 1",
        aggregated_output: "failed",
      },
      {
        type: "command_execution",
        id: "cmd-pending",
        status: "running",
        command: "sleep 1",
      },
      {
        type: "file_change",
        id: "file-ok",
        status: "completed",
        changes: [{ path: "src/created.ts" }],
      },
      {
        type: "file_change",
        id: "file-error",
        status: "failed",
        changes: [{ path: "src/rejected.ts" }],
      },
      {
        type: "mcp_tool_call",
        id: "mcp-error",
        status: "failed",
        server: "docs",
        tool: "lookup",
        arguments: { query: "missing" },
        error: { message: "not found" },
      },
      {
        type: "mcp_tool_call",
        id: "mcp-ok",
        status: "completed",
        server: "docs",
        tool: "lookup",
        arguments: { query: "present" },
        result: { structured_content: { answer: 42 } },
      },
      {
        type: "mcp_tool_call",
        id: "mcp-pending",
        status: "running",
        server: "docs",
        tool: "lookup",
        arguments: {},
        result: { content: ["raw"] },
      },
      { type: "web_search", id: "web-1", query: "first tree" },
      { type: "todo_list", id: "todo-1", items: [{ text: "ship tests", completed: false }] },
      { type: "reasoning" },
      {
        type: "error",
        message:
          "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
      },
      { type: "unknown_future_item" },
    ]);
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "codex-race-test-agent",
    });
    const ctx = makeContext(
      (count) => {
        completedCounts.push(count);
      },
      { emitEvent: (event) => events.push(event) },
    );

    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));

    const toolEvents = events.filter(
      (event): event is Extract<SessionEvent, { kind: "tool_call" }> => event.kind === "tool_call",
    );
    expect(events).toEqual(
      expect.arrayContaining([
        { kind: "assistant_text", payload: { text: "visible answer" } },
        { kind: "thinking", payload: {} },
        expect.objectContaining({
          kind: "error",
          payload: expect.objectContaining({ source: "tool", message: expect.stringContaining("codex auth") }),
        }),
      ]),
    );
    expect(toolEvents.map((event) => `${event.payload.toolUseId}:${event.payload.status}`)).toEqual([
      "cmd-ok:ok",
      "cmd-error:error",
      "cmd-pending:pending",
      "file-ok:ok",
      "file-error:error",
      "mcp-error:error",
      "mcp-ok:ok",
      "mcp-pending:pending",
      "web-1:ok",
      "todo-1:ok",
    ]);
    expect(toolEvents.find((event) => event.payload.toolUseId === "cmd-ok")?.payload.resultPreview).toHaveLength(400);
    expect(toolEvents.find((event) => event.payload.toolUseId === "mcp-error")?.payload.resultPreview).toBe(
      "error: not found",
    );
    expect(toolEvents.find((event) => event.payload.toolUseId === "mcp-ok")?.payload.resultPreview).toBe(
      JSON.stringify({ answer: 42 }),
    );
    expect(completedCounts).toEqual([1]);

    await handler.shutdown();
  });

  it("fails an unsupported service tier instead of accepting the SDK's downgraded turn", async () => {
    const events: SessionEvent[] = [];
    const completedCounts: Array<number | undefined> = [];
    const warning =
      "Configured service tier `fast` is not advertised as supported for model `gpt-test` and will be omitted from requests.";
    state.itemsByTurn.set(1, [
      { type: "error", message: warning },
      { type: "agent_message", text: "silently downgraded answer" },
    ]);
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "codex-race-test-agent",
    });
    const ctx = makeContext(
      (count) => {
        completedCounts.push(count);
      },
      { emitEvent: (event) => events.push(event) },
    );
    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));

    expect(events).toContainEqual({
      kind: "error",
      payload: {
        source: "sdk",
        message: `Codex service tier configuration failed: ${warning}`,
      },
    });
    const providerFailure = events
      .filter((event): event is Extract<SessionEvent, { kind: "error" }> => event.kind === "error")
      .map((event) => parseProviderRetryEventMessage(event.payload.message))
      .find((payload) => payload?.event === "provider_failure_terminal");
    expect(providerFailure).toMatchObject({
      provider: "codex",
      scope: "provider_turn",
      category: "configuration",
      reasonCode: "codex_service_tier_unsupported",
    });
    expect(events).toContainEqual({ kind: "turn_end", payload: { status: "error" } });
    expect(events.some((event) => event.kind === "assistant_text")).toBe(false);
    expect(completedCounts).toEqual([1]);

    await handler.shutdown();
  });

  it("queues injects received before the Codex thread exists so their inbox entries stay aligned with acks", async () => {
    const completedCounts: Array<number | undefined> = [];
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "codex-race-test-agent",
    });
    const ctx = makeContext((count) => {
      completedCounts.push(count);
    });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await Promise.resolve();

    // The handler is active, but startup is still waiting on chat context;
    // `thread` and `currentTurnPromise` do not exist yet.
    handler.inject(makeMessage("m2", "second"), deliveryTokenFromSessionContext(ctx));

    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await startPromise;
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(state.runInputs).toHaveLength(2);
    expect(String(state.runInputs[0])).toContain("<first-tree-current-chat-context");
    expect(String(state.runInputs[0])).toContain('"chatId": "chat-startup-race"');
    expect(String(state.runInputs[0])).toContain("first");
    expect(String(state.runInputs[1])).not.toContain("<first-tree-current-chat-context");
    expect(String(state.runInputs[1])).toContain("second");
    expect(completedCounts).toEqual([1, 1]);

    await handler.shutdown();
  });

  it("does not let queued injects consume startup chat context while the first input is still formatting", async () => {
    const completedCounts: Array<number | undefined> = [];
    let releaseFirstFormat = (_value: string): void => {
      throw new Error("first format promise was not captured");
    };
    let firstFormatStarted = (): void => {};
    const firstFormatStartedPromise = new Promise<void>((resolve) => {
      firstFormatStarted = resolve;
    });
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "codex-race-test-agent",
    });
    const ctx = makeContext(
      (count) => {
        completedCounts.push(count);
      },
      {
        formatInboundContent: vi.fn<SessionContext["formatInboundContent"]>((message) => {
          if (message.id === "m1") {
            firstFormatStarted();
            return new Promise<string>((resolve) => {
              releaseFirstFormat = resolve;
            });
          }
          return Promise.resolve(
            typeof message.content === "string" ? message.content : JSON.stringify(message.content),
          );
        }),
      },
    );

    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await firstFormatStartedPromise;

    handler.inject(makeMessage("m2", "second"), deliveryTokenFromSessionContext(ctx));
    await new Promise((resolve) => setImmediate(resolve));

    expect(state.runInputs).toHaveLength(0);

    releaseFirstFormat("first");
    await startPromise;
    await waitFor(() => state.runInputs.length === 2);

    expect(String(state.runInputs[0])).toContain("<first-tree-current-chat-context");
    expect(String(state.runInputs[0])).toContain('"chatId": "chat-startup-race"');
    expect(String(state.runInputs[0])).toContain("first");
    expect(String(state.runInputs[0])).not.toContain("second");
    expect(String(state.runInputs[1])).not.toContain("<first-tree-current-chat-context");
    expect(String(state.runInputs[1])).toContain("second");
    expect(completedCounts).toEqual([1, 1]);

    await handler.shutdown();
  });

  it("retries queued app-server startup injects before falling back to the SDK handler", async () => {
    const fake = new StartupFakeAppServerClient();
    fake.failThreadStart = true;
    const completedCounts: Array<number | undefined> = [];
    const retried: Array<{ ids: string[]; reason: string }> = [];
    const handler = makeAutoHandler(fake);
    const ctx = makeContext(
      (count) => {
        completedCounts.push(count);
      },
      {
        retryTurn: (messages, reason) => {
          retried.push({ ids: messageIds(messages), reason });
        },
      },
    );

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await Promise.resolve();

    expect(handler.inject(makeMessage("m2", "second"), deliveryTokenFromSessionContext(ctx))).toMatchObject({
      kind: "owned",
      mode: "queued",
    });

    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await startPromise;

    expect(fake.shutdownCalls).toBe(1);
    expect(retried).toEqual([{ ids: ["m2"], reason: "codex_shutdown_before_terminal" }]);
    expect(state.runInputs).toHaveLength(1);
    expect(String(state.runInputs[0])).toContain("first");
    expect(String(state.runInputs[0])).not.toContain("second");
    expect(completedCounts).toEqual([1]);

    await handler.shutdown();
  });

  it("does not auto-fallback to SDK after turn/start has been requested", async () => {
    const fake = new StartupFakeAppServerClient();
    fake.failTurnStart = true;
    const retried: Array<{ ids: string[]; reason: string }> = [];
    const handler = makeAutoHandler(fake);
    const ctx = makeContext(() => {}, {
      retryTurn: (messages, reason) => {
        retried.push({ ids: messageIds(messages), reason });
      },
    });

    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));

    expect(fake.requests.some((request) => request.method === "turn/start")).toBe(true);
    expect(retried).toEqual([{ ids: ["m1"], reason: "codex_app_server_turn_start_unknown_custody_failed" }]);
    expect(state.runInputs).toHaveLength(0);
    expect(fake.shutdownCalls).toBe(1);

    await handler.shutdown();
  });

  it("serializes ready-state injects through one drainer instead of starting parallel turns", async () => {
    const completedCounts: Array<number | undefined> = [];
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "codex-race-test-agent",
    });
    const ctx = makeContext((count) => {
      completedCounts.push(count);
    });

    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));

    handler.inject(makeMessage("m2", "second"), deliveryTokenFromSessionContext(ctx));
    handler.inject(makeMessage("m3", "third"), deliveryTokenFromSessionContext(ctx));

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(state.runInputs).toHaveLength(2);
    expect(String(state.runInputs[0])).toContain("<first-tree-current-chat-context");
    expect(String(state.runInputs[0])).toContain('"chatId": "chat-startup-race"');
    expect(String(state.runInputs[1])).not.toContain("<first-tree-current-chat-context");
    expect(String(state.runInputs[1])).toContain("second");
    expect(String(state.runInputs[1])).toContain("third");
    expect(completedCounts).toEqual([1, 2]);

    await handler.shutdown();
  });

  it("applies resume chat context to the next injected turn only when resume has no message", async () => {
    const completedCounts: Array<number | undefined> = [];
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "codex-race-test-agent",
    });
    const ctx = makeContext((count) => {
      completedCounts.push(count);
    });

    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.resume(undefined, "thread-test", ctx, deliveryTokenFromSessionContext(ctx));

    handler.inject(makeMessage("m1", "first after resume"), deliveryTokenFromSessionContext(ctx));
    await waitFor(() => state.runInputs.length === 1);

    expect(String(state.runInputs[0])).toContain("<first-tree-current-chat-context");
    expect(String(state.runInputs[0])).toContain('"chatId": "chat-startup-race"');
    expect(String(state.runInputs[0])).toContain("first after resume");

    handler.inject(makeMessage("m2", "second after resume"), deliveryTokenFromSessionContext(ctx));
    await waitFor(() => state.runInputs.length === 2);

    expect(String(state.runInputs[1])).not.toContain("<first-tree-current-chat-context");
    expect(String(state.runInputs[1])).toContain("second after resume");
    expect(completedCounts).toEqual([1, 1]);

    await handler.shutdown();
  });

  it("forwards only the latest Codex agent_message as the final response", async () => {
    const sendMessage = vi
      .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "codex-race-test-agent",
    });
    const ctx = makeContext(() => {}, { sendMessage, emitEvent });

    state.agentMessagesByTurn.set(1, ["working note", "final answer"]);
    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));

    // Final-text mirror retired: the result is captured as assistant_text
    // events, NOT delivered as a chat message.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      emitEvent.mock.calls
        .map(([event]) => (event.kind === "assistant_text" ? event.payload.text : null))
        .filter((text): text is string => typeof text === "string"),
    ).toEqual(["working note", "final answer"]);

    await handler.shutdown();
  });

  it("treats a reconnect diagnostic followed by final and turn.completed as success", async () => {
    const sendMessage = vi
      .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const completedCounts: Array<number | undefined> = [];
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "codex-race-test-agent",
    });
    const ctx = makeContext((count) => completedCounts.push(count), { sendMessage, emitEvent });

    state.agentMessagesByTurn.set(1, ["working note", "final answer"]);
    state.diagnosticAfterFirstMessageByTurn.set(1, "Reconnecting... 2/5 (request timed out)");
    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));

    const events = emitEvent.mock.calls.map(([event]) => event);
    // Final-text mirror retired: result captured as assistant_text, not sent.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      events
        .map((event) => (event.kind === "assistant_text" ? event.payload.text : null))
        .filter((text): text is string => typeof text === "string"),
    ).toContain("final answer");
    expect(
      events.some(
        (event) =>
          event.kind === "error" &&
          event.payload.source === "sdk" &&
          event.payload.message.includes("Reconnecting... 2/5"),
      ),
    ).toBe(false);
    expect(events.some((event) => event.kind === "turn_end" && event.payload.status === "success")).toBe(true);
    expect(completedCounts).toEqual([1]);

    await handler.shutdown();
  });

  it("does not classify normal final text that mentions provider error keywords", async () => {
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const completedCounts: Array<number | undefined> = [];
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "codex-race-test-agent",
    });
    const ctx = makeContext((count) => completedCounts.push(count), { emitEvent, retryTurn });

    state.agentMessagesByTurn.set(1, [
      "The log says 401 Unauthorized and context window, but this is just the answer text.",
    ]);
    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));

    const events = emitEvent.mock.calls.map(([event]) => event);
    expect(
      events.some((event) => {
        if (event.kind !== "error") return false;
        return parseProviderRetryEventMessage(event.payload.message) !== null;
      }),
    ).toBe(false);
    expect(events.some((event) => event.kind === "turn_end" && event.payload.status === "success")).toBe(true);
    expect(completedCounts).toEqual([1]);
    expect(retryTurn).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it("does not retry user-visible output when a reconnect diagnostic ends without turn.completed", async () => {
    const sendMessage = vi
      .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const completedCounts: Array<number | undefined> = [];
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "codex-race-test-agent",
    });
    const ctx = makeContext((count) => completedCounts.push(count), { sendMessage, emitEvent, retryTurn });

    state.agentMessagesByTurn.set(1, ["working note"]);
    state.streamErrorByTurn.set(1, "Reconnecting... 2/5 (request timed out)");
    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));

    const events = emitEvent.mock.calls.map(([event]) => event);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      events.some(
        (event) =>
          event.kind === "error" &&
          event.payload.source === "sdk" &&
          event.payload.message.includes("Reconnecting... 2/5"),
      ),
    ).toBe(true);
    expect(
      events.some((event) => {
        if (event.kind !== "error") return false;
        const retryPayload = parseProviderRetryEventMessage(event.payload.message);
        return (
          retryPayload?.event === "provider_failure_terminal" &&
          retryPayload.reasonCode === "unsafe_replay" &&
          retryPayload.scope === "provider_turn"
        );
      }),
    ).toBe(true);
    expect(events.some((event) => event.kind === "turn_end" && event.payload.status === "error")).toBe(true);
    expect(completedCounts).toEqual([1]);
    expect(retryTurn).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it("does not retry 401 stream errors", async () => {
    const sendMessage = vi
      .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const completedCounts: Array<number | undefined> = [];
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "codex-race-test-agent",
    });
    const ctx = makeContext((count) => completedCounts.push(count), { sendMessage, emitEvent, retryTurn });

    state.agentMessagesByTurn.set(1, []);
    state.streamErrorByTurn.set(
      1,
      "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
    );
    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));

    const events = emitEvent.mock.calls.map(([event]) => event);
    expect(state.runInputs).toHaveLength(1);
    expect(
      events.some((event) => {
        if (event.kind !== "error") return false;
        const retryPayload = parseProviderRetryEventMessage(event.payload.message);
        return (
          retryPayload?.event === "provider_failure_terminal" &&
          retryPayload.reasonCode === "provider_credential_required" &&
          retryPayload.scope === "provider_turn"
        );
      }),
    ).toBe(true);
    expect(events.some((event) => event.kind === "turn_end" && event.payload.status === "error")).toBe(true);
    expect(completedCounts).toEqual([1]);
    expect(retryTurn).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it("does not retry partial Codex text when the turn later fails", async () => {
    const sendMessage = vi
      .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const completedCounts: Array<number | undefined> = [];
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "codex-race-test-agent",
    });
    const ctx = makeContext((count) => completedCounts.push(count), { sendMessage, emitEvent, retryTurn });

    state.agentMessagesByTurn.set(1, ["working note"]);
    state.failureByTurn.set(1, "codex failed");
    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));

    const events = emitEvent.mock.calls.map(([event]) => event);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      events.some(
        (event) => event.kind === "error" && event.payload.source === "sdk" && event.payload.message === "codex failed",
      ),
    ).toBe(true);
    expect(events.some((event) => event.kind === "turn_end" && event.payload.status === "error")).toBe(true);
    expect(
      events.some((event) => {
        if (event.kind !== "error") return false;
        const retryPayload = parseProviderRetryEventMessage(event.payload.message);
        return (
          retryPayload?.event === "provider_failure_terminal" &&
          retryPayload.reasonCode === "unsafe_replay" &&
          retryPayload.scope === "provider_turn"
        );
      }),
    ).toBe(true);
    expect(completedCounts).toEqual([1]);
    expect(retryTurn).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it("does not retry partial Codex text when the stream emits a fatal error", async () => {
    const sendMessage = vi
      .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const completedCounts: Array<number | undefined> = [];
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "codex-race-test-agent",
    });
    const ctx = makeContext((count) => completedCounts.push(count), { sendMessage, emitEvent, retryTurn });

    state.agentMessagesByTurn.set(1, ["working note"]);
    state.streamErrorByTurn.set(1, "codex stream error");
    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));

    const events = emitEvent.mock.calls.map(([event]) => event);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(
      events.some(
        (event) =>
          event.kind === "error" && event.payload.source === "sdk" && event.payload.message === "codex stream error",
      ),
    ).toBe(true);
    expect(events.some((event) => event.kind === "turn_end" && event.payload.status === "error")).toBe(true);
    expect(
      events.some((event) => {
        if (event.kind !== "error") return false;
        const retryPayload = parseProviderRetryEventMessage(event.payload.message);
        return (
          retryPayload?.event === "provider_failure_terminal" &&
          retryPayload.reasonCode === "unsafe_replay" &&
          retryPayload.scope === "provider_turn"
        );
      }),
    ).toBe(true);
    expect(completedCounts).toEqual([1]);
    expect(retryTurn).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it("rewrites image-batch captions through the shared command rewrite for non-Claude structured payloads", async () => {
    const registry = buildTeamSkillCommandRegistry([
      { requestedSlug: "review", resourceId: "res-review-1", effectiveName: "review-first-tree" },
    ]);
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "codex-race-test-agent",
      codexHandlerEngine: "sdk",
      codexRuntimeBinaryResolver: async () => ({
        ok: true as const,
        binary: "/tmp/fake-codex",
        runtimeSource: "path" as const,
        runtimePath: "/tmp/fake-codex",
        version: "0.0.0-test",
      }),
    });
    const ctx = makeContext(() => {}, {
      formatInboundContent: async (message) => {
        const rewritten = rewriteSessionMessageCommand(message, registry);
        const content = rewritten.content;
        if (typeof content === "string") return content;
        if (isImageBatchRefContent(content)) return content.caption ?? "";
        return JSON.stringify(content);
      },
    });

    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });
    await handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => state.runInputs.length === 1);

    const imageMessage: SessionMessage = {
      id: "m2",
      chatId: "chat-startup-race",
      senderId: "sender-1",
      format: "file",
      content: {
        caption: "/review src/",
        attachments: [{ imageId: "11111111-1111-4111-8111-111111111111", mimeType: "image/png", filename: "shot.png" }],
      },
      metadata: {},
    };
    handler.inject(imageMessage, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => state.runInputs.length === 2);
    expect(String(state.runInputs[1])).toContain("/review-first-tree src/");

    await handler.shutdown();
  });

  it("refreshes the managed projection before formatting injected input, so a fenced retry can heal", async () => {
    const order: string[] = [];
    const runtimeConfig = {
      agentId: AGENT_ID,
      version: 2,
      payload: {
        kind: "codex" as const,
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      },
      updatedAt: "",
      updatedBy: "test",
    };
    const fake = new StartupFakeAppServerClient();
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "codex-race-test-agent",
      codexHandlerEngine: "sdk",
      codexRuntimeBinaryResolver: async () => ({
        ok: true as const,
        binary: "/tmp/fake-codex",
        runtimeSource: "path" as const,
        runtimePath: "/tmp/fake-codex",
        version: "0.0.0-test",
      }),
      codexAppServerClientFactory: async () => fake,
      agentConfigCache: {
        get: () => {
          order.push("refresh");
          return runtimeConfig;
        },
        refreshIfNewer: async () => runtimeConfig,
        refresh: async () => runtimeConfig,
        updateUrls: () => {},
        allReferencedUrls: () => new Set<string>(),
        forget: () => {},
      } as never,
    });
    const ctx = makeContext(() => {}, {
      formatInboundContent: async (message) => {
        order.push(`format:${message.id}`);
        return String(message.content);
      },
    });

    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });
    await handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => state.runInputs.length === 1);

    order.length = 0;
    handler.inject(makeMessage("m2", "second"), deliveryTokenFromSessionContext(ctx));
    await waitFor(() => order.includes("format:m2"));

    // The refresh/reconcile path (config cache read) must run BEFORE the
    // injected turn's formatting: only then can a version-fenced registry
    // republish heal the retry instead of deadlocking on its own fence.
    expect(order[0]).toBe("refresh");
    expect(order.indexOf("refresh")).toBeLessThan(order.indexOf("format:m2"));

    await handler.shutdown();
  });

  it("retries queued injects when all inbound formatting fails before provider custody", async () => {
    const completedCounts: Array<number | undefined> = [];
    const retryTurn = vi.fn();
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "codex-race-test-agent",
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
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    handler.inject(makeMessage("m2", "bad"), deliveryTokenFromSessionContext(ctx));

    await waitFor(() => retryTurn.mock.calls.length === 1);

    expect(state.runInputs).toHaveLength(1);
    expect(completedCounts).toEqual([1]);
    expect(retryTurn).toHaveBeenCalledWith(makeMessage("m2", "bad"), "codex_queued_turn_format_failed");

    await handler.shutdown();
  });

  it.each([
    {
      name: "first failed and second succeeded",
      failingIds: new Set(["m2"]),
      messages: [makeMessage("m2", "bad"), makeMessage("m3", "good")],
    },
    {
      name: "first succeeded and second failed",
      failingIds: new Set(["m3"]),
      messages: [makeMessage("m2", "good"), makeMessage("m3", "bad")],
    },
  ])("retries the whole queued batch when mixed formatting occurs: $name", async ({ failingIds, messages }) => {
    const completedCounts: Array<number | undefined> = [];
    const retryTurn = vi.fn();
    const handler = createCodexHandler({
      runtimeProvider: "codex",
      workspaceRoot,
      agentName: "codex-race-test-agent",
    });
    const ctx = makeContext(
      (count) => {
        completedCounts.push(count);
      },
      {
        formatInboundContent: async (message) => {
          if (failingIds.has(message.id)) throw new Error(`format failed for ${message.id}`);
          const raw = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
          return `[From: ${message.senderId}]\n\n${raw}`;
        },
      },
    );
    ctx.retryTurn = retryTurn;

    state.resolveChatContext?.({
      chatId: "chat-startup-race",
      title: "startup race",
      topic: null,
      description: null,
      participants: [],
    });

    await handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    for (const message of messages) handler.inject(message, deliveryTokenFromSessionContext(ctx));

    await waitFor(() => retryTurn.mock.calls.length === messages.length);

    expect(state.runInputs).toHaveLength(1);
    expect(completedCounts).toEqual([1]);
    for (const message of messages) {
      expect(retryTurn).toHaveBeenCalledWith(message, "codex_queued_turn_format_failed");
    }

    await handler.shutdown();
  });
});
