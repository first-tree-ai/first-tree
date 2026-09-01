import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProviderRetryEventMessage, type SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCtxPlumbing } from "../../../__tests__/test-helpers.js";
import type { ChatContext } from "../../../runtime/chat-context.js";
import type { SessionContext, SessionMessage } from "../../../runtime/handler.js";

type MockState = {
  runInputs: unknown[];
  signals: AbortSignal[];
  streamClosedByAttempt: boolean[];
  lateAbortAfterClose: boolean;
};

const state = vi.hoisted<MockState>(() => ({
  runInputs: [],
  signals: [],
  streamClosedByAttempt: [],
  lateAbortAfterClose: false,
}));

vi.mock("@openai/codex-sdk", () => {
  const usage = {
    input_tokens: 1,
    cached_input_tokens: 0,
    output_tokens: 1,
    reasoning_output_tokens: 0,
  };

  const thread = {
    id: "thread-retry-abort",
    async runStreamed(input: unknown, opts: { signal?: AbortSignal } = {}) {
      state.runInputs.push(input);
      const attempt = state.runInputs.length;
      const attemptIndex = attempt - 1;
      const signal = opts.signal;
      if (signal) {
        state.signals.push(signal);
        signal.addEventListener("abort", () => {
          if (state.streamClosedByAttempt[attemptIndex]) state.lateAbortAfterClose = true;
        });
      }

      return {
        events: (async function* () {
          try {
            yield { type: "thread.started", thread_id: "thread-retry-abort" };
            if (attempt === 1) {
              yield { type: "error", message: "stream disconnected before completion: fetch failed" };
              return;
            }
            yield {
              type: "item.completed",
              item: { type: "agent_message", text: "retry succeeded" },
            };
            yield { type: "turn.completed", usage };
          } finally {
            state.streamClosedByAttempt[attemptIndex] = true;
          }
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
      identity: SessionContext["agent"];
      serverUrl: string;
    }) => {
      const runtimeDir = join(args.workspacePath, ".first-tree-workspace");
      mkdirSync(runtimeDir, { recursive: true });
      writeFileSync(
        join(runtimeDir, "identity.json"),
        JSON.stringify({
          agentId: args.identity.agentId,
          agentName: args.agentName,
          displayName: args.identity.displayName,
          type: args.identity.type,
          visibility: args.identity.visibility,
          delegateMention: args.identity.delegateMention,
          metadata: args.identity.metadata,
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
    const claudePath = join(workspacePath, "CLAUDE.md");
    rmSync(claudePath, { force: true });
    if (process.platform === "win32") writeFileSync(claudePath, briefing);
    else symlinkSync("AGENTS.md", claudePath);
  }),
  writeBundledCliVersion: vi.fn(),
  writeContextTreeHead: vi.fn(),
}));

vi.mock("../../../runtime/chat-context.js", () => ({
  fetchChatContext: vi.fn(async (): Promise<ChatContext> => {
    return {
      chatId: "chat-retry-abort",
      title: "retry abort",
      topic: null,
      description: null,
      participants: [],
    };
  }),
}));

import { deliveryTokenFromSessionContext } from "../../../runtime/handler.js";
import { createCodexHandler } from "../index.js";

const AGENT_ID = "019e71c9-88d2-70be-be67-fdb033b2ef0b";

let workspaceRoot: string;

type SendMessageMock = ReturnType<typeof vi.fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>>;

function makeMessage(id: string, content: string): SessionMessage {
  return {
    id,
    chatId: "chat-retry-abort",
    senderId: "sender-1",
    format: "text",
    content,
    metadata: {},
  };
}

function makeContext(
  onFinishTurn: (count?: number) => void,
  opts: {
    sendMessage?: SendMessageMock;
    emitEvent?: SessionContext["emitEvent"];
    log?: SessionContext["log"];
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
    chatId: "chat-retry-abort",
    log: opts.log ?? (() => {}),
    recordProviderActivity: () => {},
    noteTurnStart: () => {},
    emitEvent: opts.emitEvent ?? (() => {}),
    ...mockCtxPlumbing({ sendMessage }, "chat-retry-abort"),
    finishTurn: async (messages) => {
      onFinishTurn(Array.isArray(messages) ? messages.length : 1);
    },
  };
}

async function waitForPredicate(predicate: () => boolean, label: string): Promise<void> {
  // Real timers: fake timers interact badly with the native workspace file lock
  // used by prepareManagedSession (context-source.lock), which caused CI flakes
  // (ENOENT on lstat / stuck before retry). The assertion under test is abort
  // hygiene across retry, not timer precision.
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ft-codex-retry-abort-"));
  state.runInputs.length = 0;
  state.signals.length = 0;
  state.streamClosedByAttempt.length = 0;
  state.lateAbortAfterClose = false;
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("codex handler retry abort cleanup", () => {
  it("retries a transient stream failure without aborting the per-attempt signal after iterator close", async () => {
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

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));

    await waitForPredicate(
      () => state.streamClosedByAttempt[0] === true && logs.some((message) => message.includes("codex turn retry")),
      "first attempt retry backoff",
    );

    expect(state.runInputs).toHaveLength(1);
    expect(String(state.runInputs[0])).toContain("<first-tree-current-chat-context");
    expect(String(state.runInputs[0])).toContain('"chatId": "chat-retry-abort"');
    expect(String(state.runInputs[0])).toContain("first");
    expect(state.lateAbortAfterClose).toBe(false);

    await startPromise;

    const events = emitEvent.mock.calls.map(([event]) => event);
    const assistantTexts: string[] = [];
    for (const event of events) {
      if (event.kind === "assistant_text") assistantTexts.push(event.payload.text);
    }

    expect(state.runInputs).toHaveLength(2);
    expect(String(state.runInputs[1])).toContain('"chatId": "chat-retry-abort"');
    expect(String(state.runInputs[1])).toContain("first");
    expect(state.signals).toHaveLength(2);
    // Final-text mirror retired: the result is captured as an assistant_text
    // event, NOT delivered as a chat message.
    expect(sendMessage).not.toHaveBeenCalled();
    expect(assistantTexts).toEqual(["retry succeeded"]);
    const errorEvents = events.filter(
      (event): event is Extract<SessionEvent, { kind: "error" }> => event.kind === "error",
    );
    const retryEvents = errorEvents
      .map((event) => parseProviderRetryEventMessage(event.payload.message))
      .filter((event) => event !== null);
    expect(retryEvents).toHaveLength(1);
    expect(retryEvents[0]?.event).toBe("provider_retry_scheduled");
    expect(retryEvents[0]?.userSeverity).toBe("info");
    expect(errorEvents.filter((event) => parseProviderRetryEventMessage(event.payload.message) === null)).toEqual([]);
    expect(events.some((event) => event.kind === "turn_end" && event.payload.status === "success")).toBe(true);
    expect(completedCounts).toEqual([1]);
    expect(state.lateAbortAfterClose).toBe(false);

    await handler.shutdown();
  });
});
