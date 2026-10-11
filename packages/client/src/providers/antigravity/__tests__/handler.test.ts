import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { type AgentRuntimeConfig, parseProviderRetryEventMessage } from "@first-tree/shared";
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

function message(id: string, content: string, chatId = "chat-1"): SessionMessage {
  return {
    inboxEntryId: Number(id.slice(1)) || 1,
    id,
    chatId,
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

function context(
  events: unknown[],
  forwarded: string[],
  identity: { agentId: string; chatId: string; inboxId: string } = {
    agentId: "agent-1",
    chatId: "chat-1",
    inboxId: "inbox-1",
  },
): SessionContext {
  const { agentId, chatId, inboxId } = identity;
  return {
    agent: {
      agentId,
      inboxId,
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
    noteTurnStart: vi.fn(),
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
          FIRST_TREE_TEST_TURN: String(turn - 1),
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
  outputLinesByTurn: readonly (readonly string[])[] = [],
  closeAfterTurn: readonly boolean[] = [],
  closeExitCode = 0,
  stderrLines: readonly string[] = [],
  stderrLinesByTurn: readonly (readonly string[])[] = [],
): ProviderProcessSupervisor {
  let turn = 0;
  return {
    spawn(spec) {
      specs.push(spec);
      const turnIndex = turn;
      const currentOutputLines = outputLinesByTurn[turnIndex] ?? outputLines;
      const currentStderrLines = stderrLinesByTurn[turnIndex] ?? stderrLines;
      const shouldCloseAfterOutput = closeAfterTurn[turnIndex] ?? false;
      turn += 1;
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
      const complete = (): void => {
        if (closed) return;
        closed = true;
        stdout.end();
        stderr.end();
        queueMicrotask(() => child.emit("close", closeExitCode, null));
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
        for (const line of currentOutputLines) stdout.write(`${line}\n`);
        for (const line of currentStderrLines) stderr.write(`${line}\n`);
        if (shouldCloseAfterOutput) complete();
      });
      return { child, exited: new Promise<void>((resolve) => child.once("close", () => resolve())) };
    },
  };
}

function providerRetryEventNames(events: readonly unknown[]): string[] {
  return events.flatMap((event) => {
    const { kind, payload } = event as { kind?: unknown; payload?: { message?: unknown } };
    if (kind !== "error" || typeof payload?.message !== "string") return [];
    const retryEvent = parseProviderRetryEventMessage(payload.message);
    return retryEvent ? [retryEvent.event] : [];
  });
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
    await vi.waitFor(() => expect(secondToken.complete).toHaveBeenCalledTimes(1), { timeout: 10_000 });

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

  it("keeps a failed fresh attempt as the exact conversation usage baseline for recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-usage-recovery-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const recoveryScript = `
const conversationId = process.env.FIRST_TREE_TEST_CONVERSATION_ID;
const turn = Number(process.env.FIRST_TREE_TEST_TURN ?? "0");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  JSON.parse(input.trim());
  process.stdout.write(JSON.stringify({event:"init",conversation_id:conversationId}) + "\\n");
  if (turn === 0) {
    process.stdout.write(JSON.stringify({event:"result",result:{conversation_id:conversationId,status:"ERROR",response:"",error:"failed",usage:{input_tokens:3,cache_read_tokens:1,output_tokens:2}}}) + "\\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify({event:"result",result:{conversation_id:conversationId,status:"SUCCESS",response:"recovered",usage:{input_tokens:10,cache_read_tokens:4,output_tokens:7}}}) + "\\n");
});
`;
    const handler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createSupervisor(
        specs,
        inputs,
        ["conversation-recovery", "conversation-recovery"],
        recoveryScript,
      ),
      antigravityTurnTimeoutMs: 5_000,
      antigravityRetrySleep: async () => true,
    });

    const firstToken = deliveryToken();
    const first = await handler.start(message("m1", "first prompt"), sessionCtx, firstToken);
    expect(first.sessionId).toBe("conversation-recovery");
    expect(firstToken.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "error", completion: "consumed" }),
    );

    const recoveryToken = deliveryToken();
    await handler.resume(message("m2", "recovery"), "conversation-recovery", sessionCtx, recoveryToken);
    expect(recoveryToken.complete).toHaveBeenCalledWith(expect.anything(), { status: "success" });
    expect(events.filter((event) => (event as { kind?: string }).kind === "token_usage")).toEqual([
      {
        kind: "token_usage",
        payload: {
          provider: "antigravity",
          model: "gemini-3-pro",
          inputTokens: 7,
          cachedInputTokens: 3,
          outputTokens: 5,
        },
      },
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

  it("retains unsafe custody when the required replay notice cannot be ACKed", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-unsafe-notice-retry-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const unsafeOutput = [
      JSON.stringify({ event: "init", conversation_id: "conversation-notice-retry" }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conversation-notice-retry",
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_call_id: "call-notice-retry",
          tool_info: { parameters: { command: "touch side-effect-marker" } },
        },
      }),
    ];
    const originalHandler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createControlledSupervisor(specs, inputs, unsafeOutput),
      antigravityTurnTimeoutMs: 50,
      antigravityRetrySleep: vi.fn(async () => true),
    });
    const token = {
      ...deliveryToken(),
      complete: vi.fn().mockResolvedValueOnce("retry").mockResolvedValueOnce("settled"),
    } satisfies DeliveryToken;

    const started = await originalHandler.start(message("m-notice-retry", "mutate this"), sessionCtx, token);

    expect(started.sessionId).toBe("conversation-notice-retry");
    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "error", completion: "consumed", reason: "unsafe_replay" }),
    );
    expect(sessionCtx.failSessionForRecovery).toHaveBeenCalledWith(
      "antigravity_unsafe_replay_notice_unsettled",
      "conversation-notice-retry",
      {
        kind: "provider_continuation",
        provider: "antigravity",
        sessionId: "conversation-notice-retry",
        messageId: "m-notice-retry",
      },
    );

    await originalHandler.shutdown("replaced after unresolved notice");
    const replacementHandler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createControlledSupervisor(specs, inputs, []),
      antigravityTurnTimeoutMs: 5_000,
    });
    const recoveryToken = deliveryToken();
    const resumed = await replacementHandler.resume(
      message("m-notice-retry", "mutate this"),
      started.sessionId,
      sessionCtx,
      recoveryToken,
      {
        continuation: {
          kind: "provider_continuation",
          provider: "antigravity",
          sessionId: "conversation-notice-retry",
          messageId: "m-notice-retry",
        },
      },
    );

    expect(resumed).toEqual({
      sessionId: "conversation-notice-retry",
      route: null,
    });
    expect(specs).toHaveLength(1);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain("mutate this");
    expect(events.filter((event) => (event as { kind?: string }).kind === "tool_call")).toHaveLength(1);
    expect(recoveryToken.retry).not.toHaveBeenCalled();
    expect(recoveryToken.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "error", completion: "consumed", reason: "unsafe_replay" }),
    );
    await replacementHandler.shutdown();
  });

  it("keeps queued rows separate when a provider-entered turn fails retryably", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-queued-custody-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const queuedProviderScript = `
const conversationId = process.env.FIRST_TREE_TEST_CONVERSATION_ID;
const turn = Number(process.env.FIRST_TREE_TEST_TURN ?? "0");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  JSON.parse(input.trim());
  process.stdout.write(JSON.stringify({event:"init",conversation_id:conversationId}) + "\\n");
  if (turn === 1) process.exit(1);
  const response = turn === 0 ? "hello" : "queued done";
  process.stdout.write(JSON.stringify({event:"result",result:{conversation_id:conversationId,status:"SUCCESS",response}}) + "\\n");
});
`;
    const handler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createSupervisor(
        specs,
        inputs,
        ["conversation-queued", "conversation-queued", "conversation-queued"],
        queuedProviderScript,
      ),
      antigravityTurnTimeoutMs: 5_000,
      antigravityRetrySleep: vi.fn(async () => true),
    });
    const firstToken = deliveryToken();
    const secondToken = deliveryToken();
    await handler.start(message("m-initial", "start the conversation"), sessionCtx, deliveryToken());
    handler.inject(message("m-first", "first queued request"), firstToken);
    handler.inject(message("m-second", "second queued request"), secondToken);

    await vi.waitFor(() => expect(firstToken.complete).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    await vi.waitFor(() => expect(secondToken.complete).toHaveBeenCalledTimes(1), { timeout: 10_000 });

    expect(specs).toHaveLength(3);
    expect(specs[1]?.args).toEqual(expect.arrayContaining(["--conversation", "conversation-queued"]));
    expect(firstToken.retry).not.toHaveBeenCalled();
    expect(firstToken.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "error", completion: "consumed", reason: "unsafe_replay" }),
    );
    expect(secondToken.retry).not.toHaveBeenCalled();
    expect(secondToken.complete).toHaveBeenCalledWith(expect.anything(), { status: "success" });
    expect(JSON.parse(inputs[1] ?? "")).toMatchObject({
      event: "user",
      message: { content: expect.stringContaining("first queued request") },
    });
    expect(inputs[1]).not.toContain("second queued request");
    expect(JSON.parse(inputs[2] ?? "")).toMatchObject({
      event: "user",
      message: { content: expect.stringContaining("second queued request") },
    });
    expect(inputs[2]).not.toContain("first queued request");
    expect(forwarded).toEqual(["hello", "queued done"]);
    await handler.shutdown();
  });

  it.each([
    "suspend",
    "shutdown",
  ] as const)("operator %s with settleProviderEntered consumes a mutating turn without a terminal provider-failure notice", async (lifecycle) => {
    const root = mkdtempSync(join(tmpdir(), `ft-antigravity-lifecycle-settle-${lifecycle}-`));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const lifecycleOutput = [
      JSON.stringify({ event: "init", conversation_id: "conversation-lifecycle" }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conversation-lifecycle",
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_call_id: "call-lifecycle",
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
      providerProcessSupervisor: createControlledSupervisor(specs, inputs, lifecycleOutput),
      antigravityTurnTimeoutMs: 5_000,
    });
    const token = deliveryToken();
    const startPromise = handler.start(message("m-lifecycle", "mutate this"), sessionCtx, token);

    await vi.waitFor(() => expect(specs).toHaveLength(1), { timeout: 3_000 });
    await vi.waitFor(() =>
      expect(events.some((event) => (event as { kind?: string }).kind === "tool_call")).toBe(true),
    );
    if (lifecycle === "suspend") {
      await handler.suspend("operator_suspended", { settleProviderEntered: true });
    } else {
      await handler.shutdown("runtime switched by server", { settleProviderEntered: true });
    }

    const started = await startPromise;
    expect(started.sessionId).toBe("conversation-lifecycle");
    expect(started.continuation).toEqual({
      kind: "provider_continuation",
      provider: "antigravity",
      sessionId: "conversation-lifecycle",
      messageId: "m-lifecycle",
    });
    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "error", completion: "consumed", reason: "unsafe_replay" }),
    );
    expect(providerRetryEventNames(events)).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("Antigravity turn cancelled during a lifecycle transition");

    const recoveryToken = deliveryToken();
    const recoveryMessage = message("m-lifecycle", "mutate this");
    const resumed = await handler.resume(recoveryMessage, started.sessionId, sessionCtx, recoveryToken, {
      continuation: {
        kind: "provider_continuation",
        provider: "antigravity",
        sessionId: "conversation-lifecycle",
        messageId: "m-lifecycle",
      },
    });
    expect(resumed.sessionId).toBe("conversation-lifecycle");
    expect(specs).toHaveLength(1);
    expect(recoveryToken.retry).not.toHaveBeenCalled();
    expect(recoveryToken.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "error", completion: "consumed", reason: "unsafe_replay" }),
    );
    expect(events.filter((event) => (event as { kind?: string }).kind === "tool_call")).toHaveLength(1);
    await handler.shutdown();
  });

  it.each([
    "suspend",
    "shutdown",
  ] as const)("plain %s of a provider-entered mutating turn never re-sends the original prompt", async (lifecycle) => {
    const root = mkdtempSync(join(tmpdir(), `ft-antigravity-lifecycle-noreplay-${lifecycle}-`));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const helloOutput = [
      JSON.stringify({ event: "init", conversation_id: "conversation-lifecycle" }),
      JSON.stringify({
        event: "result",
        result: { conversation_id: "conversation-lifecycle", status: "SUCCESS", response: "hello" },
      }),
    ];
    const mutatingOutput = [
      JSON.stringify({ event: "init", conversation_id: "conversation-lifecycle" }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conversation-lifecycle",
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_call_id: "call-lifecycle",
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
      providerProcessSupervisor: createControlledSupervisor(
        specs,
        inputs,
        helloOutput,
        [helloOutput, mutatingOutput],
        [true, false],
      ),
      antigravityTurnTimeoutMs: 5_000,
    });
    await handler.start(message("m-hello", "start the conversation"), sessionCtx, deliveryToken());
    const mutatingToken = deliveryToken();
    handler.inject(message("m-lifecycle", "mutate this"), mutatingToken);

    await vi.waitFor(() => expect(specs).toHaveLength(2), { timeout: 3_000 });
    await vi.waitFor(() =>
      expect(events.some((event) => (event as { kind?: string }).kind === "tool_call")).toBe(true),
    );
    if (lifecycle === "suspend") await handler.suspend("concurrency_preempted");
    else await handler.shutdown("session_evicted");

    expect(mutatingToken.retry).not.toHaveBeenCalled();
    expect(mutatingToken.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "error", completion: "consumed", reason: "unsafe_replay" }),
    );
    expect(providerRetryEventNames(events)).toEqual([]);
    expect(inputs.filter((input) => input.includes("mutate this"))).toHaveLength(1);

    if (lifecycle === "shutdown") {
      return;
    }

    const recoveryToken = deliveryToken();
    const resumed = await handler.resume(
      message("m-lifecycle", "mutate this"),
      "conversation-lifecycle",
      sessionCtx,
      recoveryToken,
    );
    expect(resumed.sessionId).toBe("conversation-lifecycle");
    expect(specs).toHaveLength(2);
    expect(recoveryToken.retry).not.toHaveBeenCalled();
    expect(recoveryToken.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "error", completion: "consumed", reason: "unsafe_replay" }),
    );
    expect(inputs.filter((input) => input.includes("mutate this"))).toHaveLength(1);
    expect(forwarded).toEqual(["hello"]);
    await handler.shutdown();
  });

  it("ignores stray non-JSON stdout when the documented stream-json result is intact", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-stream-noise-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const output = [
      JSON.stringify({ event: "init", conversation_id: "conversation-noise" }),
      '14:50 0:00 /bin/bash -O extglob -c snap=$(command cat <&3); builtin shopt -s extglob; builtin eval -- "$snap"',
      JSON.stringify({
        event: "result",
        result: { conversation_id: "conversation-noise", status: "SUCCESS", response: "done" },
      }),
    ];
    const handler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createControlledSupervisor(specs, inputs, output, [], [true]),
      antigravityTurnTimeoutMs: 5_000,
    });
    const token = deliveryToken();

    await handler.start(message("m-noise", "please respond"), sessionCtx, token);

    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(expect.anything(), { status: "success" });
    expect(forwarded).toEqual(["done"]);
    expect(providerRetryEventNames(events)).toEqual([]);
    expect(sessionCtx.log).toHaveBeenCalledWith(expect.stringContaining("ignored non-JSON stdout"));
    await handler.shutdown();
  });

  it("classifies an Individual quota ERROR result as capacity, not malformed-stream configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-quota-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const quotaMessage =
      "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h42m27s.";
    const output = [
      JSON.stringify({ event: "init", conversation_id: "conversation-quota" }),
      JSON.stringify({ event: "future_event", note: "noise-1" }),
      JSON.stringify({ event: "future_event", note: "noise-2" }),
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conversation-quota",
          status: "ERROR",
          error: quotaMessage,
        },
      }),
    ];
    const handler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createControlledSupervisor(specs, inputs, output, [], [true]),
      antigravityTurnTimeoutMs: 5_000,
    });
    const token = deliveryToken();

    await handler.start(message("m-quota", "please respond"), sessionCtx, token);

    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "error", completion: "consumed" }),
    );
    const retryEvents = events.flatMap((event) => {
      const { kind, payload } = event as { kind?: unknown; payload?: { message?: unknown } };
      if (kind !== "error" || typeof payload?.message !== "string") return [];
      const parsed = parseProviderRetryEventMessage(payload.message);
      return parsed ? [parsed] : [];
    });
    expect(retryEvents).toEqual([
      expect.objectContaining({
        event: "provider_failure_terminal",
        category: "provider_capacity",
      }),
    ]);
    expect(JSON.stringify(events)).toContain("Individual quota reached");
    expect(JSON.stringify(events)).not.toContain("malformed Antigravity stream");
    await handler.shutdown();
  });

  it("delivers a no-op webhook ERROR report as the turn instead of a configuration failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-noop-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const report = [
      "No-op webhook event on PR #3910:",
      "",
      "Event: issue_comment created by github-bot.",
      "Comment: issuecomment-5718353169 (own thread).",
    ].join("\n");
    const output = [
      JSON.stringify({ event: "init", conversation_id: "conversation-noop" }),
      JSON.stringify({ event: "future_event", note: "noise" }),
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conversation-noop",
          status: "ERROR",
          response: "",
          error: report,
        },
      }),
    ];
    const handler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createControlledSupervisor(specs, inputs, output, [], [true], 1),
      antigravityTurnTimeoutMs: 5_000,
    });
    const token = deliveryToken();

    await handler.start(message("m-noop", "handle the webhook"), sessionCtx, token);

    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(expect.anything(), { status: "success" });
    expect(forwarded).toEqual([report]);
    expect(providerRetryEventNames(events)).toEqual([]);
    expect(JSON.stringify(events)).toContain("No-op webhook event on PR #3910");
    expect(JSON.stringify(events)).not.toContain("runtime configuration needs attention");
    expect(JSON.stringify(events)).not.toContain("malformed Antigravity stream");
    await handler.shutdown();
  });

  it("keeps an unclassified runtime ERROR result in the failure path", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-sqlite-error-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const diagnostic = "database disk image is malformed while loading the conversation state";
    const output = [
      JSON.stringify({ event: "init", conversation_id: "conversation-sqlite" }),
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conversation-sqlite",
          status: "ERROR",
          response: "",
          error: diagnostic,
        },
      }),
    ];
    const handler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createControlledSupervisor(specs, inputs, output, [], [true], 1),
      antigravityTurnTimeoutMs: 5_000,
    });
    const token = deliveryToken();

    await handler.start(message("m-sqlite", "please respond"), sessionCtx, token);

    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "error", completion: "consumed" }),
    );
    expect(forwarded).toEqual([]);
    expect(JSON.stringify(events)).toContain(diagnostic);
    expect(JSON.stringify(events)).not.toContain('"status":"success"');
    await handler.shutdown();
  });

  it("keeps a later runtime ERROR after earlier assistant progress in the failure path", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-sqlite-after-progress-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const diagnostic = "database disk image is malformed while loading the conversation state";
    const output = [
      JSON.stringify({ event: "init", conversation_id: "conversation-sqlite-progress" }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conversation-sqlite-progress",
          step_type: "agent_response",
          text_delta: "I will inspect the saved conversation before continuing.",
        },
      }),
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conversation-sqlite-progress",
          status: "ERROR",
          response: "",
          error: diagnostic,
        },
      }),
    ];
    const handler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createControlledSupervisor(specs, inputs, output, [], [true], 1),
      antigravityTurnTimeoutMs: 5_000,
    });
    const token = deliveryToken();

    await handler.start(message("m-sqlite-progress", "please respond"), sessionCtx, token);

    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "error", completion: "consumed" }),
    );
    expect(forwarded).toEqual([]);
    expect(JSON.stringify(events)).toContain(diagnostic);
    expect(JSON.stringify(events)).not.toContain('"status":"success"');
    await handler.shutdown();
  });

  it("does not treat an ERROR review body that mentions sign-in as a credential failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-review-error-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const report = [
      "Reviewed successor head 03e8f42a4721630f3c15dd28f6754a342460ec27 on PR #3881 across two full sweeps: clean verdict with zero real findings.",
      "",
      "Previous Finding Resolved: Listing bed feature promotion now strictly keeps the sign in CTA.",
    ].join("\n");
    const output = [
      JSON.stringify({ event: "init", conversation_id: "conversation-review" }),
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conversation-review",
          status: "ERROR",
          response: "",
          error: report,
        },
      }),
    ];
    const handler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createControlledSupervisor(specs, inputs, output, [], [true], 1),
      antigravityTurnTimeoutMs: 5_000,
    });
    const token = deliveryToken();

    await handler.start(message("m-review", "review the PR"), sessionCtx, token);

    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "error", completion: "consumed" }),
    );
    expect(forwarded).toEqual([]);
    const retryEvents = events.flatMap((event) => {
      const { kind, payload } = event as { kind?: unknown; payload?: { message?: unknown } };
      if (kind !== "error" || typeof payload?.message !== "string") return [];
      const parsed = parseProviderRetryEventMessage(payload.message);
      return parsed ? [parsed] : [];
    });
    expect(retryEvents.some((event) => event.category === "credential")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("run agy once to sign in");
    await handler.shutdown();
  });

  it("delivers status ERROR with a response body and no diagnostic as the turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-error-response-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const report = "Checking PR #3935 status on GitHub.\nPR #3935 Landed on main.";
    const output = [
      JSON.stringify({ event: "init", conversation_id: "conversation-error-response" }),
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conversation-error-response",
          status: "ERROR",
          response: report,
        },
      }),
    ];
    const handler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createControlledSupervisor(specs, inputs, output, [], [true], 1),
      antigravityTurnTimeoutMs: 5_000,
    });
    const token = deliveryToken();

    await handler.start(message("m-error-response", "check the PRs"), sessionCtx, token);

    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(expect.anything(), { status: "success" });
    expect(forwarded).toEqual([report]);
    expect(providerRetryEventNames(events)).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("run agy once to sign in");
    await handler.shutdown();
  });

  it("delivers a mid-turn ERROR response body as the turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-mid-turn-error-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const report = [
      "Checking PR #3935 status on GitHub.",
      "Checking PR 3926 details.",
      "### PR #3935 Merged & Next Steps",
      "PR #3935 Landed on main.",
    ].join("\n");
    const output = [
      JSON.stringify({ event: "init", conversation_id: "conversation-mid" }),
      JSON.stringify({
        event: "step_update",
        step_update: { conversation_id: "conversation-mid", step_type: "agent_response", text_delta: report },
      }),
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conversation-mid",
          status: "ERROR",
          response: report,
          error: "",
        },
      }),
    ];
    const handler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createControlledSupervisor(specs, inputs, output, [], [true], 1),
      antigravityTurnTimeoutMs: 5_000,
    });
    const token = deliveryToken();

    await handler.start(message("m-mid", "check the PRs"), sessionCtx, token);

    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(expect.anything(), { status: "success" });
    expect(forwarded).toEqual([report]);
    expect(providerRetryEventNames(events)).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("run agy once to sign in");
    expect(JSON.stringify(events)).not.toContain("unknown terminal failure");
    await handler.shutdown();
  });

  it("stops waiting when agy reports no model capacity instead of timing out as a crash", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-no-capacity-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const retrySleep = vi.fn(async () => true);
    const stderr = "UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server";
    const handler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createControlledSupervisor(specs, inputs, [], [], [], 0, [stderr]),
      antigravityTurnTimeoutMs: 5_000,
      antigravityRetrySleep: retrySleep,
    });
    const token = deliveryToken();

    await handler.start(message("m-capacity", "review the PR"), sessionCtx, token);

    expect(JSON.stringify(events)).toContain("No capacity available");
    expect(JSON.stringify(events)).not.toContain("after retrying a transient provider or network failure");
    expect(forwarded).toEqual([]);
    await handler.shutdown();
  });

  it("fails closed on timeout after the prompt was written instead of retrying as transport", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-prompt-timeout-"));
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

    expect(token.retry).not.toHaveBeenCalled();
    expect(retrySleep).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "error", completion: "consumed", reason: "unsafe_replay" }),
    );
    expect(JSON.stringify(events)).not.toContain("after retrying a transient provider or network failure");
    await handler.shutdown();
  });

  it("surfaces timed-out progress without acknowledging a successful turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-timeout-text-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const report = "I will apply the migration, then verify its result.";
    const output = [
      JSON.stringify({ event: "init", conversation_id: "conversation-timeout-text" }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conversation-timeout-text",
          step_type: "agent_response",
          text_delta: report,
        },
      }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conversation-timeout-text",
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_call_id: "call-1",
          tool_info: { parameters: { command: "apply-migration" } },
        },
      }),
    ];
    const handler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createControlledSupervisor(specs, inputs, output),
      antigravityTurnTimeoutMs: 50,
    });
    const token = deliveryToken();

    await handler.start(message("m-timeout-text", "apply the migration"), sessionCtx, token);

    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "error", completion: "consumed", reason: "unsafe_replay" }),
    );
    expect(forwarded).toEqual([]);
    expect(JSON.stringify(events)).toContain(report);
    expect(JSON.stringify(events)).not.toContain("after retrying a transient provider or network failure");
    await handler.shutdown();
  });

  it("keeps the expected conversation when a timed-out resume emits a different id", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-timeout-mismatch-"));
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
      providerProcessSupervisor: createControlledSupervisor(
        specs,
        inputs,
        [],
        [
          [
            JSON.stringify({ event: "init", conversation_id: "conversation-a" }),
            JSON.stringify({
              event: "result",
              result: { conversation_id: "conversation-a", status: "SUCCESS", response: "first" },
            }),
          ],
          [
            JSON.stringify({ event: "init", conversation_id: "conversation-b" }),
            JSON.stringify({
              event: "step_update",
              step_update: {
                conversation_id: "conversation-b",
                step_type: "agent_response",
                text_delta: "from the wrong conversation",
              },
            }),
          ],
        ],
        [true, false],
      ),
      antigravityTurnTimeoutMs: 50,
    });

    const first = await handler.start(message("m1", "first prompt"), sessionCtx, deliveryToken());
    expect(first.sessionId).toBe("conversation-a");
    const secondToken = deliveryToken();
    const second = await handler.resume(message("m2", "follow-up"), "conversation-a", sessionCtx, secondToken);

    expect(second.sessionId).toBe("conversation-a");
    expect(secondToken.retry).not.toHaveBeenCalled();
    expect(secondToken.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "error", completion: "consumed", reason: "unsafe_replay" }),
    );
    expect(forwarded).toEqual(["first"]);
    await handler.shutdown();
  });

  it("rejects a latest SUCCESS result from a different conversation than the resume target", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-result-id-mismatch-"));
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
      providerProcessSupervisor: createControlledSupervisor(
        specs,
        inputs,
        [],
        [
          [
            JSON.stringify({ event: "init", conversation_id: "conversation-a" }),
            JSON.stringify({
              event: "result",
              result: { conversation_id: "conversation-a", status: "SUCCESS", response: "first" },
            }),
          ],
          [
            JSON.stringify({ event: "init", conversation_id: "conversation-a" }),
            JSON.stringify({
              event: "result",
              result: { conversation_id: "conversation-b", status: "SUCCESS", response: "answer-from-B" },
            }),
          ],
        ],
        [true, true],
      ),
      antigravityTurnTimeoutMs: 5_000,
    });

    const first = await handler.start(message("m1", "first prompt"), sessionCtx, deliveryToken());
    expect(first.sessionId).toBe("conversation-a");
    const secondToken = deliveryToken();
    await handler.resume(message("m2", "follow-up"), "conversation-a", sessionCtx, secondToken);

    expect(secondToken.retry).not.toHaveBeenCalled();
    expect(secondToken.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "error", completion: "consumed" }),
    );
    expect(forwarded).toEqual(["first"]);
    expect(JSON.stringify(events)).toContain("resume conversation mismatch");
    await handler.shutdown();
  });

  it("retries a follow-up 503 without --conversation of the established session", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-followup-503-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const retrySleep = vi.fn(async () => true);
    const stderr = "UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high on the server";
    const handler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createControlledSupervisor(
        specs,
        inputs,
        [],
        [
          [
            JSON.stringify({ event: "init", conversation_id: "conversation-a" }),
            JSON.stringify({
              event: "result",
              result: { conversation_id: "conversation-a", status: "SUCCESS", response: "first" },
            }),
          ],
          [],
          [
            JSON.stringify({ event: "init", conversation_id: "conversation-b" }),
            JSON.stringify({
              event: "result",
              result: { conversation_id: "conversation-b", status: "SUCCESS", response: "recovered" },
            }),
          ],
        ],
        [true, false, true],
        0,
        [],
        [[], [stderr], []],
      ),
      antigravityTurnTimeoutMs: 5_000,
      antigravityRetrySleep: retrySleep,
    });

    await handler.start(message("m1", "first prompt"), sessionCtx, deliveryToken());
    const secondToken = deliveryToken();
    handler.inject(message("m2", "follow-up"), secondToken);
    await vi.waitFor(() => expect(secondToken.retry).toHaveBeenCalled(), { timeout: 3_000 });
    const retryToken = deliveryToken();
    handler.inject(message("m2", "follow-up"), retryToken);
    await vi.waitFor(() => expect(specs.length).toBeGreaterThanOrEqual(3), { timeout: 3_000 });

    expect(specs[2]?.args).not.toContain("conversation-a");
    await vi.waitFor(() => expect(retryToken.complete).toHaveBeenCalledWith(expect.anything(), { status: "success" }));
    expect(sessionCtx.replaceSessionId).toHaveBeenCalledWith("conversation-b", "antigravity_conversation_id_confirmed");
    expect(forwarded).toEqual(["first", "recovered"]);
    await handler.shutdown();

    const coldSpecs: ProviderProcessSpec[] = [];
    const coldInputs: string[] = [];
    const coldEvents: unknown[] = [];
    const coldForwarded: string[] = [];
    const coldCtx = context(coldEvents, coldForwarded);
    const cold = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createControlledSupervisor(
        coldSpecs,
        coldInputs,
        [
          JSON.stringify({ event: "init", conversation_id: "conversation-b" }),
          JSON.stringify({
            event: "result",
            result: { conversation_id: "conversation-b", status: "SUCCESS", response: "after-restart" },
          }),
        ],
        [],
        [true],
      ),
      antigravityTurnTimeoutMs: 5_000,
    });
    const coldToken = deliveryToken();
    await cold.resume(message("m3", "after restart"), "conversation-b", coldCtx, coldToken);
    expect(coldSpecs[0]?.args).toContain("conversation-b");
    expect(coldSpecs[0]?.args).not.toContain("conversation-a");
    expect(coldToken.complete).toHaveBeenCalledWith(expect.anything(), { status: "success" });
    expect(coldForwarded).toEqual(["after-restart"]);
    await cold.shutdown();
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

  it("ignores a replayed historical quota ERROR when the latest result succeeded", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-stale-quota-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const leftover = `{"role":null,"message-preview":"gREKhgz+odn0Zc8cCm96i8sp1Xy5gQ","status":"completed"}`;
    const quota =
      "API error (attempt 6): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h53m10s.";
    const output = [
      leftover,
      JSON.stringify({ event: "init", conversation_id: "conversation-stale" }),
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conversation-stale",
          status: "ERROR",
          response: "",
          error: quota,
        },
      }),
      JSON.stringify({ event: "init", conversation_id: "conversation-stale" }),
      JSON.stringify({
        event: "result",
        result: {
          conversation_id: "conversation-stale",
          status: "SUCCESS",
          response: "Reviewed the latest head. No blocking findings.",
        },
      }),
    ];
    const handler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createControlledSupervisor(specs, inputs, output, [], [true]),
      antigravityTurnTimeoutMs: 5_000,
    });
    const token = deliveryToken();

    await handler.start(message("m-stale", "review the PR"), sessionCtx, token);

    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(expect.anything(), { status: "success" });
    expect(forwarded).toEqual(["Reviewed the latest head. No blocking findings."]);
    expect(JSON.stringify(events)).not.toContain("runtime configuration needs attention");
    expect(JSON.stringify(events)).not.toContain("Individual quota reached");
    await handler.shutdown();
  });

  it("does not reopen a fail-closed timeout after an unrelated handler shutdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-attempt-scope-"));
    roots.push(root);
    const failingSpecs: ProviderProcessSpec[] = [];
    const failingInputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const activeHandler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-attempt-a",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createControlledSupervisor(failingSpecs, failingInputs, []),
      antigravityTurnTimeoutMs: 50,
      antigravityRetrySleep: vi.fn(async () => true),
    });
    const activeMessage = message("m1", "first attempt");
    const firstToken = deliveryToken();
    await activeHandler.start(activeMessage, context(events, forwarded), firstToken);
    expect(firstToken.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "error", completion: "consumed", reason: "unsafe_replay" }),
    );

    const unrelatedSpecs: ProviderProcessSpec[] = [];
    const unrelatedInputs: string[] = [];
    const unrelatedRoot = mkdtempSync(join(tmpdir(), "ft-antigravity-attempt-scope-other-"));
    roots.push(unrelatedRoot);
    const unrelatedHandler = createAntigravityHandler({
      workspaceRoot: unrelatedRoot,
      agentName: "antigravity-attempt-b",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createSupervisor(unrelatedSpecs, unrelatedInputs, ["conversation-other"]),
      antigravityTurnTimeoutMs: 5_000,
    });
    await unrelatedHandler.start(
      message("m-other", "other conversation", "chat-2"),
      context([], [], { agentId: "agent-2", chatId: "chat-2", inboxId: "inbox-2" }),
      deliveryToken(),
    );
    await unrelatedHandler.shutdown();

    expect(firstToken.retry).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain("after retrying a transient provider or network failure");
    await activeHandler.shutdown();
  });

  it("omits --print-timeout and process timeout by default to align with other runtimes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-no-timeout-"));
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
    });

    const outcome = await handler.start(message("m1", "run indefinitely"), sessionCtx, deliveryToken());
    expect(outcome.sessionId).toBe("conversation-1");
    expect(specs[0]?.args).not.toContain("--print-timeout");
    expect(specs[0]?.timeoutMs).toBeUndefined();
    expect(forwarded).toEqual(["hello"]);
    await handler.shutdown();
  });

  it("does not classify premature process exit or missing result as a configuration error and sanitizes stdout noise", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-premature-exit-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const output = [
      JSON.stringify({ event: "init", conversation_id: "conversation-crash" }),
      "ask [options] [name] [message] Ask a HUMAN in the caller's current chat",
    ];
    const handler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createControlledSupervisor(specs, inputs, output, [], [true], 1, [
        "sqlite3: database or disk is full",
      ]),
      antigravityTurnTimeoutMs: 5_000,
    });
    const token = deliveryToken();

    await handler.start(message("m-crash", "please review"), sessionCtx, token);

    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "error", completion: "consumed" }),
    );
    expect(JSON.stringify(events)).not.toContain("runtime configuration needs attention");
    expect(JSON.stringify(events)).not.toContain("Ask a HUMAN");
    expect(JSON.stringify(events)).toContain("database or disk is full");
    const retryEvents = events.flatMap((event) => {
      const { kind, payload } = event as { kind?: unknown; payload?: { message?: unknown } };
      if (kind !== "error" || typeof payload?.message !== "string") return [];
      const parsed = parseProviderRetryEventMessage(payload.message);
      return parsed ? [parsed] : [];
    });
    expect(retryEvents).toEqual([
      expect.objectContaining({
        category: "unknown",
        reasonCode: "unsafe_replay",
      }),
    ]);
    await handler.shutdown();
  });

  it("preserves replay custody when stream payload content mentions capacity phrases and terminates without result", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-antigravity-quoted-capacity-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const output = [
      JSON.stringify({ event: "init", conversation_id: "conversation-quoted-cap" }),
      JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: "conversation-quoted-cap",
          step_type: "agent_response",
          text_delta: "The API responded with: resource_exhausted or individual quota reached.",
        },
      }),
    ];
    const handler = createAntigravityHandler({
      workspaceRoot: root,
      agentName: "antigravity-test-agent",
      runtimeProvider: "antigravity",
      agentConfigCache: cache(runtimeConfig()),
      antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
      providerProcessSupervisor: createControlledSupervisor(specs, inputs, output, [], [true], 1),
      antigravityTurnTimeoutMs: 5_000,
    });
    const token = deliveryToken();

    await handler.start(message("m-quoted", "please assist"), sessionCtx, token);

    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "error", completion: "consumed" }),
    );
    const retryEvents = events.flatMap((event) => {
      const { kind, payload } = event as { kind?: unknown; payload?: { message?: unknown } };
      if (kind !== "error" || typeof payload?.message !== "string") return [];
      const parsed = parseProviderRetryEventMessage(payload.message);
      return parsed ? [parsed] : [];
    });
    expect(retryEvents).toEqual([
      expect.objectContaining({
        category: "unknown",
        reasonCode: "unsafe_replay",
      }),
    ]);
    await handler.shutdown();
  });
});
