import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import {
  type AgentRuntimeConfigPayload,
  type SessionEvent as FtSessionEvent,
  parseProviderRetryEventMessage,
} from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCtxPlumbing } from "../../../__tests__/test-helpers.js";
import type { DeliveryToken, SessionContext, SessionMessage, TurnOutcome } from "../../../runtime/handler.js";
import { formatProviderFailureRuntimeNotice } from "../../../runtime/runtime-notice.js";
import { createDeepseekHandler, DEEPSEEK_PENDING_SESSION_PREFIX, isDeepseekPendingSessionId } from "../index.js";

type FakeRunResult = {
  sessionId: string;
  finalResponse: string;
  events: SessionEvent[];
};

class FakeHarnessSession {
  constructor(
    readonly id: string,
    private readonly script: () => FakeRunResult | Promise<FakeRunResult>,
  ) {}

  async run(_prompt: string): Promise<FakeRunResult> {
    return this.script();
  }
}

class FakeHarness {
  readonly sessionCalls: Array<string | undefined> = [];
  start = vi.fn(async () => {});
  close = vi.fn(async () => {});
  session(sessionId?: string): FakeHarnessSession {
    this.sessionCalls.push(sessionId);
    return new FakeHarnessSession(sessionId ?? "sess-new", () => runScript());
  }
}

function makePayload(
  over: Partial<Omit<Extract<AgentRuntimeConfigPayload, { kind: "deepseek-harness" }>, "kind">> = {},
): Extract<AgentRuntimeConfigPayload, { kind: "deepseek-harness" }> {
  return {
    kind: "deepseek-harness",
    prompt: { append: "" },
    model: "",
    mcpServers: [],
    env: [],
    gitRepos: [],
    resourceSkills: [],
    ...over,
  };
}

function makeToken(): DeliveryToken & { completed: TurnOutcome[]; retried: string[] } {
  const completed: TurnOutcome[] = [];
  const retried: string[] = [];
  return {
    completed,
    retried,
    processingStarted: () => {},
    complete: async (_messages, outcome) => {
      completed.push(outcome);
    },
    retry: (_messages, reason) => {
      retried.push(reason);
    },
    terminalRejected: async () => {},
  };
}

function makeMessage(id: string, content: string): SessionMessage {
  return {
    inboxEntryId: 1,
    id,
    chatId: "chat-deepseek",
    senderId: "human-1",
    format: "text",
    content,
    metadata: {},
  };
}

let workspaceRoot: string;
let harness: FakeHarness;
let runScript: () => FakeRunResult | Promise<FakeRunResult>;
let runtimeConfig: {
  agentId: string;
  version: number;
  payload: AgentRuntimeConfigPayload;
  updatedAt: string;
  updatedBy: string;
};

function makeContext(opts: {
  events: FtSessionEvent[];
  forwardResult?: (text: string) => Promise<void>;
  replaceSessionId?: (sessionId: string, reason: string) => void;
}): SessionContext {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const plumbing = mockCtxPlumbing({ sendMessage }, "chat-deepseek");
  return {
    agent: {
      agentId: "agent-deepseek-1",
      inboxId: "inbox_agent-deepseek-1",
      displayName: "deepseek-assistant",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: {
      serverUrl: "https://first-tree.test",
      sendMessage,
      getAgentContextTreeConfig: async () => ({
        bindingState: "invalid",
        repo: null,
        branch: null,
        provider: null,
      }),
    } as unknown as SessionContext["sdk"],
    chatId: "chat-deepseek",
    log: () => {},
    ...plumbing,
    // Prefer the test's forwardResult when provided; plumbing defaults otherwise.
    ...(opts.forwardResult ? { forwardResult: opts.forwardResult } : {}),
    emitEvent: (event) => {
      opts.events.push(event);
    },
    recordProviderActivity: () => {},
    noteTurnStart: () => {},
    ...(opts.replaceSessionId ? { replaceSessionId: opts.replaceSessionId } : {}),
  };
}

function makeHandler(extraConfig: Record<string, unknown> = {}) {
  return createDeepseekHandler({
    workspaceRoot,
    agentName: "deepseek-test-agent",
    runtimeProvider: "deepseek-harness",
    deepseekTurnTimeoutMs: 5_000,
    deepseekRuntimeResolver: () => ({
      ok: true,
      binary: "/bin/dsh-jsonrpc-agent",
      cordisPath: join(workspaceRoot, "cordis.yml"),
      moduleBaseUrl: "file:///bin/dsh-jsonrpc-agent",
    }),
    deepseekHarnessFactory: () => {
      harness = new FakeHarness();
      return harness;
    },
    agentConfigCache: {
      refresh: async () => runtimeConfig,
      get: () => runtimeConfig,
    },
    ...extraConfig,
  });
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "ft-deepseek-handler-"));
  harness = new FakeHarness();
  runtimeConfig = {
    agentId: "agent-deepseek-1",
    version: 1,
    payload: makePayload(),
    updatedAt: new Date(0).toISOString(),
    updatedBy: "test",
  };
  runScript = () => ({
    sessionId: "sess-new",
    finalResponse: "done",
    events: [
      {
        type: "assistant/chunk",
        seq: 1,
        time: 0,
        data: {
          turn: 1,
          step: 1,
          chunk: { type: "text-delta", index: 0, text: "done" },
        },
      } as SessionEvent,
    ],
  });
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("DeepSeek handler", () => {
  it("tracks pending session ids", () => {
    expect(isDeepseekPendingSessionId(`${DEEPSEEK_PENDING_SESSION_PREFIX}abc`)).toBe(true);
    expect(isDeepseekPendingSessionId("sess-123")).toBe(false);
  });

  it("completes a turn through the SDK harness and streams assistant text", async () => {
    const events: FtSessionEvent[] = [];
    const ctx = makeContext({ events });
    const token = makeToken();
    const handler = makeHandler();

    const result = await handler.start(makeMessage("m1", "hello"), ctx, token);
    expect(result.sessionId).toBe("sess-new");
    expect(result.route).toEqual({ kind: "owned", mode: "processing" });
    expect(token.completed).toEqual([{ status: "success" }]);
    expect(events.some((event) => event.kind === "assistant_text")).toBe(true);
    expect(harness.start).toHaveBeenCalledTimes(1);
    expect(harness.sessionCalls).toEqual([undefined]);
  });

  it("does not pass pending synthetic ids to the SDK session()", async () => {
    const events: FtSessionEvent[] = [];
    const replaceSessionId = vi.fn();
    const ctx = makeContext({ events, replaceSessionId });
    const token = makeToken();
    const handler = makeHandler();

    runScript = () => ({
      sessionId: "sess-new",
      finalResponse: "ok",
      events: [],
    });

    const pendingId = `${DEEPSEEK_PENDING_SESSION_PREFIX}abc`;
    const result = await handler.resume(makeMessage("m1", "hello"), pendingId, ctx, token);
    expect(harness.sessionCalls).toEqual([undefined]);
    expect(result.sessionId).toBe("sess-new");
    expect(replaceSessionId).toHaveBeenCalledWith("sess-new", "deepseek_session_id_confirmed");
  });

  it("closes the harness on timeout so a hung run can settle", async () => {
    let releaseRun: (() => void) | null = null;
    runScript = () =>
      new Promise<FakeRunResult>((resolve) => {
        releaseRun = () =>
          resolve({
            sessionId: "sess-hung",
            finalResponse: "",
            events: [],
          });
      });

    const events: FtSessionEvent[] = [];
    const ctx = makeContext({ events });
    const token = makeToken();
    const handler = makeHandler({
      deepseekTurnTimeoutMs: 40,
      deepseekHarnessFactory: () => {
        harness = new FakeHarness();
        harness.close = vi.fn(async () => {
          releaseRun?.();
        });
        return harness;
      },
    });

    const startedAt = Date.now();
    const result = await handler.start(makeMessage("m1", "hello"), ctx, token);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(harness.close).toHaveBeenCalled();
    expect(token.completed[0]?.status === "error" || token.retried.length > 0).toBe(true);
    // Session id must already be the SDK-allocated id, not a pending placeholder.
    expect(result.sessionId).toBe("sess-new");
    expect(isDeepseekPendingSessionId(result.sessionId)).toBe(false);
  });

  it("adopts sessionHandle.id before run so a failed turn still resumes the same provider session", async () => {
    const events: FtSessionEvent[] = [];
    const ctx = makeContext({ events });
    const token = makeToken();
    const handler = makeHandler({
      deepseekRetrySleep: async () => true,
      deepseekHarnessFactory: () => {
        harness = new FakeHarness();
        return harness;
      },
    });

    runScript = () => {
      throw new Error("transport lost after session allocation");
    };
    const failed = await handler.start(makeMessage("m1", "hello"), ctx, token);
    expect(failed.sessionId).toBe("sess-new");
    expect(harness.sessionCalls).toEqual([undefined]);

    runScript = () => ({
      sessionId: "sess-new",
      finalResponse: "recovered",
      events: [],
    });
    await handler.resume(makeMessage("m2", "retry"), failed.sessionId, ctx, makeToken());
    expect(harness.sessionCalls).toEqual([undefined, "sess-new"]);
  });

  it("restarts the harness when launch-affecting model config changes", async () => {
    const events: FtSessionEvent[] = [];
    const ctx = makeContext({ events });
    const token = makeToken();
    const started: FakeHarness[] = [];
    const handler = makeHandler({
      deepseekHarnessFactory: () => {
        const next = new FakeHarness();
        started.push(next);
        harness = next;
        return next;
      },
    });

    await handler.start(makeMessage("m1", "hello"), ctx, token);
    expect(started).toHaveLength(1);

    runtimeConfig = {
      ...runtimeConfig,
      version: 2,
      payload: makePayload({ model: "deepseek-v4-pro" }),
      updatedAt: new Date(1).toISOString(),
    };

    await handler.resume(makeMessage("m2", "again"), "sess-new", ctx, makeToken());
    expect(started).toHaveLength(2);
    expect(started[0]?.close).toHaveBeenCalled();
    expect(started[1]?.sessionCalls[0]).toBe("sess-new");
  });

  it("fails closed on managed MCP configuration", async () => {
    const events: FtSessionEvent[] = [];
    const ctx = makeContext({ events });
    const token = makeToken();
    runtimeConfig = {
      ...runtimeConfig,
      payload: makePayload({
        mcpServers: [{ name: "demo", transport: "stdio", command: "echo", args: [] }],
      }),
    };
    const handler = makeHandler();

    await handler.start(makeMessage("m1", "hello"), ctx, token);
    expect(token.completed[0]?.status).toBe("error");
    const retryEvent = events
      .map((event) => (event.kind === "error" ? parseProviderRetryEventMessage(event.payload.message) : null))
      .find(Boolean);
    expect(retryEvent?.category).toBe("configuration");
    expect(retryEvent).toBeTruthy();
    if (!retryEvent) throw new Error("expected provider retry event");
    expect(formatProviderFailureRuntimeNotice(retryEvent)).toContain("configuration needs attention");
    expect(harness.start).not.toHaveBeenCalled();
  });

  it("surfaces credential failures without retaining API key material", async () => {
    runScript = () => ({
      sessionId: "sess-auth",
      finalResponse: "",
      events: [
        {
          type: "turn/end",
          seq: 1,
          time: 0,
          data: {
            turn: 1,
            reason: {
              kind: "error",
              error: {
                code: "MISSING_CREDENTIAL",
                message: "DEEPSEEK_API_KEY=qa-secret set DEEPSEEK_API_KEY",
              },
            },
          },
        } as SessionEvent,
      ],
    });
    const events: FtSessionEvent[] = [];
    const ctx = makeContext({ events });
    const token = makeToken();
    const handler = makeHandler();

    await handler.start(makeMessage("m1", "hello"), ctx, token);
    expect(token.completed[0]?.status).toBe("error");
    const sdkError = events.find((event) => event.kind === "error" && event.payload.source === "sdk");
    expect(JSON.stringify(sdkError)).not.toContain("qa-secret");
  });
});
