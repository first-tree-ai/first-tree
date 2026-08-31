import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentRuntimeConfig } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FirstTreeHubSDK } from "../../../cloud/sdk.js";
import type { AgentConfigCache } from "../../../runtime/agent-config-cache.js";
import type { DeliveryToken, SessionContext, SessionMessage } from "../../../runtime/contracts.js";
import type { ProviderProcessSpec, ProviderProcessSupervisor } from "../../../runtime/provider-process-supervisor.js";
import { computeAntigravityUsageDelta, createAntigravityHandler } from "../index.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtimeConfig(): AgentRuntimeConfig {
  return {
    agentId: "agent-1",
    version: 1,
    payload: {
      kind: "antigravity",
      prompt: { append: "managed prompt" },
      model: "gemini-3-pro",
      mcpServers: [],
      env: [{ key: "AGY_TEST_ENV", value: "present", sensitive: true }],
      gitRepos: [],
      resourceSkills: [],
      reasoningEffort: "high",
    },
    updatedAt: new Date(0).toISOString(),
    updatedBy: "test",
  };
}

function cache(config: AgentRuntimeConfig): AgentConfigCache {
  return {
    get: () => config,
    refresh: async () => config,
    refreshIfNewer: async () => config,
    updateSdk: () => {},
    updateUrls: () => {},
    allReferencedUrls: () => new Set(),
    forget: () => {},
  };
}

function message(id: string, content: string): SessionMessage {
  return {
    inboxEntryId: Number(id.slice(1)) || 1,
    id,
    chatId: "chat-1",
    senderId: "human-1",
    format: "text",
    content,
    metadata: null,
  };
}

function deliveryToken() {
  return {
    processingStarted: vi.fn(),
    complete: vi.fn(async () => "settled" as const),
    retry: vi.fn(),
    terminalRejected: vi.fn(async () => {}),
  } satisfies DeliveryToken;
}

function context(events: unknown[], forwarded: string[]): SessionContext {
  const agentId = "agent-1";
  const chatId = "chat-1";
  return {
    agent: {
      agentId,
      inboxId: "inbox-1",
      displayName: "Agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: {
      serverUrl: "https://example.test",
      getChatDetail: async () => ({
        id: chatId,
        title: "Antigravity test",
        topic: "Antigravity",
        description: null,
      }),
      listChatParticipants: async () => [
        {
          agentId: "human-1",
          name: "human",
          displayName: "Human",
          type: "human",
          role: "member",
          mode: "default",
          accessMode: "speaker",
        },
      ],
    } as unknown as FirstTreeHubSDK,
    log: vi.fn(),
    chatId,
    recordProviderActivity: vi.fn(),
    emitEvent: (event) => events.push(event),
    forwardResult: async (text) => {
      forwarded.push(text);
    },
    markMessagesConsumed: vi.fn(),
    finishTurn: vi.fn(async () => "settled" as const),
    retryTurn: vi.fn(),
    failSessionForRecovery: vi.fn(),
    replaceSessionId: vi.fn(),
    buildAgentEnv: (env) => ({
      ...env,
      FIRST_TREE_AGENT_ID: agentId,
      FIRST_TREE_CHAT_ID: chatId,
      FIRST_TREE_PROVIDER: "antigravity",
    }),
    formatInboundContent: async (entry) => `[From: human]\n${String(entry.content)}`,
    resolveSenderLabel: async () => "human",
    formatFromHeader: async () => "[From: human]",
    publishTeamSkillCommands: () => {},
  };
}

const PROVIDER_SCRIPT = `
const conversationId = process.env.FIRST_TREE_TEST_CONVERSATION_ID;
const inputTokens = Number(process.env.FIRST_TREE_TEST_INPUT_TOKENS ?? "3");
const cachedInputTokens = Number(process.env.FIRST_TREE_TEST_CACHED_INPUT_TOKENS ?? "0");
const outputTokens = Number(process.env.FIRST_TREE_TEST_OUTPUT_TOKENS ?? "2");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  JSON.parse(input.trim());
  process.stdout.write(JSON.stringify({event:"init",conversation_id:conversationId}) + "\\n");
  process.stdout.write(JSON.stringify({event:"step_update",step_update:{conversation_id:conversationId,step_type:"agent_response",text_delta:"hello"}}) + "\\n");
  process.stdout.write(JSON.stringify({event:"result",result:{conversation_id:conversationId,status:"SUCCESS",response:"hello",usage:{input_tokens:inputTokens,cache_read_tokens:cachedInputTokens,output_tokens:outputTokens}}}) + "\\n");
});
`;

type TestUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

function createSupervisor(
  specs: ProviderProcessSpec[],
  inputs: string[],
  conversationIds: readonly string[] = ["conversation-1"],
  providerScript = PROVIDER_SCRIPT,
  usages: readonly TestUsage[] = [],
): ProviderProcessSupervisor {
  let turn = 0;
  return {
    spawn(spec) {
      specs.push(spec);
      const conversationId = conversationIds[turn] ?? conversationIds[conversationIds.length - 1] ?? "conversation-1";
      const usage = usages[turn] ?? usages[usages.length - 1];
      turn += 1;
      const child = spawn(process.execPath, ["-e", providerScript], {
        ...spec.options,
        env: {
          ...spec.options.env,
          FIRST_TREE_TEST_CONVERSATION_ID: conversationId,
          ...(usage
            ? {
                FIRST_TREE_TEST_INPUT_TOKENS: String(usage.inputTokens),
                FIRST_TREE_TEST_CACHED_INPUT_TOKENS: String(usage.cachedInputTokens),
                FIRST_TREE_TEST_OUTPUT_TOKENS: String(usage.outputTokens),
              }
            : {}),
        },
        detached: false,
      });
      if (!child.stdin) throw new Error("synthetic provider stdin is unavailable");
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
        inputs.push(String(chunk));
        return Reflect.apply(write, child.stdin, [chunk, ...args]);
      }) as typeof child.stdin.write;
      return { child, exited: new Promise<void>((resolve) => child.once("exit", () => resolve())) };
    },
  };
}

function createControlledSupervisor(
  specs: ProviderProcessSpec[],
  inputs: string[],
  outputLines: readonly string[],
): ProviderProcessSupervisor {
  return {
    spawn(spec) {
      specs.push(spec);
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        stdout.end();
        stderr.end();
        queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      };
      const child = Object.assign(new EventEmitter(), {
        pid: undefined,
        stdin,
        stdout,
        stderr,
        kill: vi.fn(() => {
          close();
          return true;
        }),
      }) as unknown as ChildProcess;
      const write = stdin.write.bind(stdin);
      stdin.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
        inputs.push(String(chunk));
        return Reflect.apply(write, stdin, [chunk, ...args]);
      }) as typeof stdin.write;
      setImmediate(() => {
        for (const line of outputLines) stdout.write(`${line}\n`);
      });
      return { child, exited: new Promise<void>((resolve) => child.once("close", () => resolve())) };
    },
  };
}

describe("Antigravity V1 handler", () => {
  it("computes per-turn deltas from cumulative usage and skips an unknown cold-resume baseline", () => {
    expect(
      computeAntigravityUsageDelta(
        { inputTokens: 10, cachedInputTokens: 4, outputTokens: 7 },
        { inputTokens: 3, cachedInputTokens: 1, outputTokens: 2 },
        false,
      ),
    ).toEqual({ inputTokens: 7, cachedInputTokens: 3, outputTokens: 5 });
    expect(
      computeAntigravityUsageDelta({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 7 }, null, false),
    ).toBeNull();
    expect(computeAntigravityUsageDelta({ inputTokens: 3, cachedInputTokens: 1, outputTokens: 2 }, null, true)).toEqual(
      { inputTokens: 3, cachedInputTokens: 1, outputTokens: 2 },
    );
  });

  it("sends stream-json on stdin and resumes the confirmed conversation id", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-handler-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const handler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createSupervisor(specs, inputs),
      antigravityTurnTimeoutMs: 5_000,
    });

    const firstToken = deliveryToken();
    const first = await handler.start(message("m1", "first prompt"), sessionCtx, firstToken);

    expect(first.sessionId).toBe("conversation-1");
    expect(specs).toHaveLength(1);
    expect(specs[0]?.args).toEqual([
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--print-timeout",
      "1m",
      "--model",
      "gemini-3-pro",
      "--effort",
      "high",
    ]);
    expect(specs[0]?.options.cwd).toBe(root);
    expect(specs[0]?.options.env?.AGY_TEST_ENV).toBe("present");
    expect(specs[0]?.args.join(" ")).not.toContain("first prompt");
    const firstInput = inputs[0];
    expect(firstInput).toBeDefined();
    expect(JSON.parse(firstInput ?? "")).toMatchObject({
      event: "user",
      message: { content: expect.stringContaining("first prompt") },
    });
    expect(forwarded).toEqual(["hello"]);
    expect(firstToken.processingStarted).toHaveBeenCalledTimes(1);
    expect(firstToken.complete).toHaveBeenCalledTimes(1);

    const secondToken = deliveryToken();
    expect(handler.inject(message("m2", "follow-up"), secondToken)).toMatchObject({
      kind: "owned",
      mode: "queued",
    });
    await vi.waitFor(() => expect(secondToken.complete).toHaveBeenCalledTimes(1), { timeout: 3_000 });

    expect(specs).toHaveLength(2);
    expect(specs[1]?.args).toContain("--conversation");
    expect(specs[1]?.args).toContain("conversation-1");
    const secondInput = inputs[1];
    expect(secondInput).toBeDefined();
    expect(JSON.parse(secondInput ?? "")).toMatchObject({
      event: "user",
      message: { content: expect.stringContaining("follow-up") },
    });
    expect(forwarded).toEqual(["hello", "hello"]);
    await handler.shutdown();
  });

  it("emits cumulative usage as per-turn deltas for the exact resumed conversation", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-usage-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const handler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createSupervisor(
        specs,
        inputs,
        ["conversation-usage", "conversation-usage"],
        PROVIDER_SCRIPT,
        [
          { inputTokens: 3, cachedInputTokens: 1, outputTokens: 2 },
          { inputTokens: 10, cachedInputTokens: 4, outputTokens: 7 },
        ],
      ),
      antigravityTurnTimeoutMs: 5_000,
    });

    await handler.start(message("m1", "first prompt"), sessionCtx, deliveryToken());
    const secondToken = deliveryToken();
    handler.inject(message("m2", "follow-up"), secondToken);
    await vi.waitFor(() => expect(secondToken.complete).toHaveBeenCalledTimes(1), { timeout: 3_000 });

    const usageEvents = events.filter(
      (event): event is { kind: "token_usage"; payload: unknown } =>
        typeof event === "object" && event !== null && (event as { kind?: unknown }).kind === "token_usage",
    );
    expect(usageEvents.map((event) => event.payload)).toEqual([
      { provider: "antigravity", model: "gemini-3-pro", inputTokens: 3, cachedInputTokens: 1, outputTokens: 2 },
      { provider: "antigravity", model: "gemini-3-pro", inputTokens: 7, cachedInputTokens: 3, outputTokens: 5 },
    ]);
    await handler.shutdown();
  });

  it("settles a timeout after a mutating tool without replaying the delivery", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-unsafe-timeout-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const unsafeTimeoutOutput = [
      JSON.stringify({ event: "init", conversation_id: "conversation-timeout" }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conversation-timeout",
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_call_id: "call-1",
          tool_info: { parameters: { command: "touch side-effect-marker" } },
        },
      }),
    ];
    const handler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createControlledSupervisor(specs, inputs, unsafeTimeoutOutput),
      antigravityTurnTimeoutMs: 50,
      antigravityRetrySleep: vi.fn(async () => true),
    });
    const token = deliveryToken();

    const started = await handler.start(message("m1", "mutate this"), sessionCtx, token);

    expect(started.sessionId).toBe("conversation-timeout");
    expect(specs).toHaveLength(1);
    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "error", completion: "consumed", reason: "unsafe_replay" }),
    );
    await handler.shutdown();
  });

  it("routes a pre-provider timeout through retry settlement", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-pre-provider-timeout-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const retrySleep = vi.fn(async () => true);
    const handler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createControlledSupervisor(specs, inputs, []),
      antigravityTurnTimeoutMs: 50,
      antigravityRetrySleep: retrySleep,
    });
    const token = deliveryToken();

    await handler.start(message("m1", "please respond"), sessionCtx, token);

    expect(token.retry).toHaveBeenCalledWith(expect.anything(), "operation_timeout");
    expect(token.complete).not.toHaveBeenCalled();
    expect(retrySleep).toHaveBeenCalledWith(500, expect.any(AbortSignal));
    await handler.shutdown();
  });

  it("fails closed when a resumed turn returns a different conversation id", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-resume-mismatch-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const handler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createSupervisor(specs, inputs, ["conversation-1", "conversation-2"]),
      antigravityTurnTimeoutMs: 5_000,
    });

    await handler.start(message("m1", "first prompt"), sessionCtx, deliveryToken());
    const secondToken = deliveryToken();
    handler.inject(message("m2", "follow-up"), secondToken);
    await vi.waitFor(() => expect(secondToken.complete).toHaveBeenCalledTimes(1), { timeout: 3_000 });

    expect(specs[1]?.args).toContain("conversation-1");
    expect(forwarded).toEqual(["hello"]);
    expect(secondToken.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "error", completion: "consumed", reason: "unsafe_replay" }),
    );
    expect(events.some((event) => JSON.stringify(event).includes("unsafe_replay"))).toBe(true);
    await handler.shutdown();
  });
});
