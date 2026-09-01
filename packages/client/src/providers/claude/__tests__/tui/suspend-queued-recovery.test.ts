import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCtxPlumbing } from "../../../../__tests__/test-helpers.js";
import type { ChatContext } from "../../../../runtime/chat-context.js";
import type { SessionContext, SessionMessage } from "../../../../runtime/handler.js";

const state = vi.hoisted(() => ({
  workspaceRoot: "",
  pasteTexts: [] as string[],
  lastPasteOrdinal: 0,
  emittedOrdinals: new Set<number>(),
  chatContext: {
    chatId: "chat-tui-suspend-queued-recovery",
    title: "queued recovery",
    topic: null,
    description: null,
    participants: [],
  } satisfies ChatContext,
}));

vi.mock("../../../../runtime/agent-bootstrap.js", () => ({
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

vi.mock("../../../../runtime/agent-briefing.js", () => ({
  buildAgentBriefing: vi.fn(
    () => "<!-- first-tree:generated -->\nThis briefing was generated without a safe Context source.\n",
  ),
}));

vi.mock("../../../../runtime/chat-context.js", () => ({
  fetchChatContext: vi.fn(async () => state.chatContext),
}));

vi.mock("../../../../runtime/context-tree-git-status.js", () => ({
  createContextTreeGitWriteTracker: vi.fn(() => ({})),
}));

vi.mock("../../../../runtime/source-repos.js", () => ({
  currentSourceRepoNamesFromPayload: vi.fn(() => null),
  declaredSourceRepos: vi.fn(() => []),
}));

vi.mock("../../../../runtime/workspace.js", () => ({
  acquireAgentHome: vi.fn(() => state.workspaceRoot),
  markWorkspaceInitComplete: vi.fn((workspace: string) => {
    const runtimeDir = join(workspace, ".first-tree-workspace");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "init-complete"), JSON.stringify({ schemaVersion: 1, completedAt: "now" }));
  }),
}));

vi.mock("../../tool-call-processor.js", () => ({
  createToolCallProcessor: vi.fn(() => ({
    flush: vi.fn(),
    onMessage: vi.fn(),
  })),
}));

vi.mock("../../mcp-config.js", () => ({
  mapMcpServers: vi.fn(() => []),
}));

vi.mock("../../executable.js", () => ({
  resolveClaudeCodeExecutable: vi.fn(() => ({ path: "/bin/claude-fake" })),
}));

vi.mock("../../tui/tmux-session.js", () => ({
  capturePane: vi.fn(async () => (state.lastPasteOrdinal === 1 ? "esc to interrupt" : "")),
  deriveSessionName: vi.fn(() => "ftth-test-session"),
  killSession: vi.fn(async () => undefined),
  listOwnedSessions: vi.fn(async () => []),
  newSession: vi.fn(async () => undefined),
  ownedSessionPrefix: vi.fn(() => "ftth-test-"),
  pasteText: vi.fn(async (_sessionName: string, text: string) => {
    state.pasteTexts.push(text);
    state.lastPasteOrdinal = state.pasteTexts.length;
  }),
  sendKey: vi.fn(async () => undefined),
  sessionExists: vi.fn(async () => false),
  waitForReady: vi.fn(async () => undefined),
}));

vi.mock("../../tui/transcript-tail.js", () => ({
  transcriptPathFor: vi.fn(() => "/tmp/fake-transcript.jsonl"),
  TranscriptTailer: class {
    drainEntries() {
      const ordinal = state.lastPasteOrdinal;
      if (ordinal < 2 || state.emittedOrdinals.has(ordinal)) return [];
      state.emittedOrdinals.add(ordinal);
      return [
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: `reply ${ordinal}` }],
          },
        },
      ];
    }
  },
}));

import { deliveryTokenFromSessionContext } from "../../../../runtime/handler.js";
import { createClaudeCodeTuiHandler } from "../../tui/index.js";
import { newSession, sessionExists } from "../../tui/tmux-session.js";

const AGENT_ID = "019eca71-0000-7000-8000-000000000001";
const CHAT_ID = "chat-tui-suspend-queued-recovery";

function makeMessage(id: string, content: string): SessionMessage {
  return {
    id,
    chatId: CHAT_ID,
    senderId: "sender-1",
    format: "text",
    content,
    metadata: {},
    inboxEntryId: Number(id.replace(/\D/g, "")),
  };
}

function makeContext(
  opts: {
    formatInboundContent?: SessionContext["formatInboundContent"];
    getAgentContextTreeConfig?: () => Promise<unknown>;
  } = {},
): SessionContext {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const plumbing = mockCtxPlumbing({ sendMessage }, CHAT_ID);
  return {
    agent: {
      agentId: AGENT_ID,
      inboxId: `inbox_${AGENT_ID}`,
      displayName: "tui-agent",
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
    chatId: CHAT_ID,
    log: () => {},
    recordProviderActivity: () => {},
    noteTurnStart: () => {},
    emitEvent: () => {},
    ...plumbing,
    ...(opts.formatInboundContent ? { formatInboundContent: opts.formatInboundContent } : {}),
    finishTurn: vi.fn(plumbing.finishTurn),
    retryTurn: vi.fn(plumbing.retryTurn),
  };
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!assertion()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for assertion");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  state.workspaceRoot = mkdtempSync(join(tmpdir(), "ft-tui-suspend-queue-"));
  state.pasteTexts.length = 0;
  state.lastPasteOrdinal = 0;
  state.emittedOrdinals.clear();
});

afterEach(() => {
  rmSync(state.workspaceRoot, { recursive: true, force: true });
});

describe("claude-code-tui suspend queued recovery", () => {
  it("rechecks Context authority after a paused tmux existence check before creating a session", async () => {
    const repoA = "https://github.com/acme/tree-a.git";
    const repoB = "https://github.com/acme/tree-b.git";
    let authoritativeRepo = repoA;
    let releaseExists: () => void = () => {};
    const existsMayFinish = new Promise<void>((resolvePromise) => {
      releaseExists = resolvePromise;
    });
    let markExistsStarted: () => void = () => {};
    const existsStarted = new Promise<void>((resolvePromise) => {
      markExistsStarted = resolvePromise;
    });
    vi.mocked(sessionExists).mockImplementationOnce(async () => {
      markExistsStarted();
      await existsMayFinish;
      return false;
    });
    const handler = createClaudeCodeTuiHandler({
      runtimeProvider: "claude-code-tui",
      workspaceRoot: state.workspaceRoot,
      agentName: "test-agent",
      clientId: "client-test",
      contextSourceKind: "remote",
      contextTreePath: join(state.workspaceRoot, "context-tree"),
      contextTreeRepoUrl: repoA,
      contextTreeBranch: "main",
    });
    const ctx = makeContext({
      getAgentContextTreeConfig: async () => ({
        bindingState: "bound",
        repo: authoritativeRepo,
        branch: "main",
        provider: "github",
      }),
    });

    const startPromise = handler.start(makeMessage("m-source-a", "start"), ctx, deliveryTokenFromSessionContext(ctx));
    await existsStarted;
    authoritativeRepo = repoB;
    releaseExists();

    await expect(startPromise).rejects.toMatchObject({ name: "ContextSourceTransitionError" });
    expect(newSession).not.toHaveBeenCalled();
    await handler.shutdown();
  });

  it("starts claude with the runtime output contract and Current Chat Context", async () => {
    const handler = createClaudeCodeTuiHandler({
      runtimeProvider: "claude-code-tui",
      workspaceRoot: state.workspaceRoot,
      agentName: "test-agent",
      clientId: "client-test",
    });
    const ctx = makeContext();
    const first = makeMessage("m1", "active turn");

    const start = handler.start(first, ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => vi.mocked(newSession).mock.calls.length > 0);

    const command = vi.mocked(newSession).mock.calls[0]?.[0].command ?? "";
    expect(command).toContain("--append-system-prompt-file");
    const match = command.match(/--append-system-prompt-file\s+(\S+)/);
    expect(match).not.toBeNull();
    const promptPath = match?.[1];
    expect(promptPath).toBeTruthy();
    if (!promptPath) throw new Error("missing append-system-prompt-file path");
    const prompt = readFileSync(promptPath, "utf-8");
    expect(prompt).toContain("<first-tree-runtime-contract>");
    expect(prompt).toContain("never archive by default");
    expect(prompt).toContain('<first-tree-current-chat-context format="json">');
    expect(prompt).toContain('"chatId": "chat-tui-suspend-queued-recovery"');
    expect(prompt.indexOf("<first-tree-runtime-contract>")).toBeLessThan(
      prompt.indexOf('<first-tree-current-chat-context format="json">'),
    );

    await handler.suspend();
    await start;
    await handler.shutdown();
  });

  it("drops handler-local queued injects on suspend so recovered messages are not pasted twice", async () => {
    const handler = createClaudeCodeTuiHandler({
      runtimeProvider: "claude-code-tui",
      workspaceRoot: state.workspaceRoot,
      agentName: "test-agent",
      clientId: "client-test",
    });
    const ctx = makeContext();
    const first = makeMessage("m1", "active turn");
    const recovered = makeMessage("m2", "queued recovered turn");

    const start = handler.start(first, ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => state.pasteTexts.some((text) => text.includes("active turn")));

    handler.inject(recovered, deliveryTokenFromSessionContext(ctx));
    await handler.suspend();
    const startResult = await start;
    const sessionId = typeof startResult === "string" ? startResult : startResult.sessionId;

    await handler.resume(recovered, sessionId, ctx, deliveryTokenFromSessionContext(ctx));
    await new Promise((resolve) => setImmediate(resolve));

    const recoveredPastes = state.pasteTexts.filter((text) => text.includes("queued recovered turn"));
    expect(recoveredPastes).toHaveLength(1);

    const finishTurn = vi.mocked(ctx.finishTurn);
    const recoveredFinishes = finishTurn.mock.calls.filter((call) => {
      const messages = Array.isArray(call[0]) ? call[0] : [call[0]];
      return messages.some((message) => message.id === recovered.id);
    });
    expect(recoveredFinishes).toHaveLength(1);

    await handler.shutdown();
  });

  it("does not paste a drained queued batch when suspend arrives during formatting", async () => {
    const handler = createClaudeCodeTuiHandler({
      runtimeProvider: "claude-code-tui",
      workspaceRoot: state.workspaceRoot,
      agentName: "test-agent",
      clientId: "client-test",
    });
    const queued = makeMessage("m2", "format-held queued turn");
    let formattingStarted = false;
    let releaseFormat!: () => void;
    const formatGate = new Promise<void>((resolve) => {
      releaseFormat = resolve;
    });
    const ctx = makeContext({
      formatInboundContent: async (message) => {
        if (message.id === queued.id) {
          formattingStarted = true;
          await formatGate;
        }
        const raw = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
        return `[From: ${message.senderId}]\n\n${raw}`;
      },
    });

    await handler.resume(undefined, "existing-session", ctx, deliveryTokenFromSessionContext(ctx));

    handler.inject(queued, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => formattingStarted);

    const suspend = handler.suspend();
    await Promise.resolve();
    releaseFormat();
    await suspend;
    await new Promise((resolve) => setImmediate(resolve));

    expect(state.pasteTexts.some((text) => text.includes("format-held queued turn"))).toBe(false);
    expect(ctx.finishTurn).not.toHaveBeenCalled();
    expect(ctx.retryTurn).toHaveBeenCalledWith(queued, "queued_turn_stopped_before_paste");

    await handler.shutdown();
  });

  it("retries a queued batch when all inbound formatting fails before paste", async () => {
    const handler = createClaudeCodeTuiHandler({
      runtimeProvider: "claude-code-tui",
      workspaceRoot: state.workspaceRoot,
      agentName: "test-agent",
      clientId: "client-test",
    });
    const queued = makeMessage("m3", "format-fail queued turn");
    const ctx = makeContext({
      formatInboundContent: async (message) => {
        if (message.id === queued.id) throw new Error("format failed");
        const raw = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
        return `[From: ${message.senderId}]\n\n${raw}`;
      },
    });

    await handler.resume(undefined, "existing-session", ctx, deliveryTokenFromSessionContext(ctx));
    handler.inject(queued, deliveryTokenFromSessionContext(ctx));

    await waitFor(() => vi.mocked(ctx.retryTurn).mock.calls.length > 0);

    expect(state.pasteTexts.some((text) => text.includes("format-fail queued turn"))).toBe(false);
    expect(ctx.finishTurn).not.toHaveBeenCalled();
    expect(ctx.retryTurn).toHaveBeenCalledWith(queued, "tui_queued_turn_format_failed");

    await handler.shutdown();
  });

  it.each([
    {
      name: "first failed and second succeeded",
      failingIds: new Set(["m4"]),
      messages: [makeMessage("m4", "bad first"), makeMessage("m5", "good second")],
    },
    {
      name: "first succeeded and second failed",
      failingIds: new Set(["m5"]),
      messages: [makeMessage("m4", "good first"), makeMessage("m5", "bad second")],
    },
  ])("retries the whole queued batch when mixed formatting occurs: $name", async ({ failingIds, messages }) => {
    const handler = createClaudeCodeTuiHandler({
      runtimeProvider: "claude-code-tui",
      workspaceRoot: state.workspaceRoot,
      agentName: "test-agent",
      clientId: "client-test",
    });
    const ctx = makeContext({
      formatInboundContent: async (message) => {
        if (failingIds.has(message.id)) throw new Error(`format failed for ${message.id}`);
        const raw = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
        return `[From: ${message.senderId}]\n\n${raw}`;
      },
    });

    await handler.resume(undefined, "existing-session", ctx, deliveryTokenFromSessionContext(ctx));
    for (const message of messages) handler.inject(message, deliveryTokenFromSessionContext(ctx));

    await waitFor(() => vi.mocked(ctx.retryTurn).mock.calls.length >= messages.length);

    expect(state.pasteTexts.some((text) => text.includes("bad first") || text.includes("good first"))).toBe(false);
    expect(state.pasteTexts.some((text) => text.includes("bad second") || text.includes("good second"))).toBe(false);
    expect(ctx.finishTurn).not.toHaveBeenCalled();
    for (const message of messages) {
      expect(ctx.retryTurn).toHaveBeenCalledWith(message, "tui_queued_turn_format_failed");
    }

    await handler.shutdown();
  });
});
