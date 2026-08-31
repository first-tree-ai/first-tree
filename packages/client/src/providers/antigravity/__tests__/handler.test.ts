import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FirstTreeHubSDK } from "../../../cloud/sdk.js";
import type { AgentConfigCache } from "../../../runtime/agent-config-cache.js";
import type { DeliveryToken, SessionContext, SessionMessage } from "../../../runtime/contracts.js";
import type { ProviderProcessSpec, ProviderProcessSupervisor } from "../../../runtime/provider-process-supervisor.js";
import { createAntigravityHandler } from "../index.js";

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
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  JSON.parse(input.trim());
  process.stdout.write(JSON.stringify({event:"init",conversation_id:conversationId}) + "\\n");
  process.stdout.write(JSON.stringify({event:"step_update",step_update:{conversation_id:conversationId,step_type:"agent_response",text_delta:"hello"}}) + "\\n");
  process.stdout.write(JSON.stringify({event:"result",result:{conversation_id:conversationId,status:"SUCCESS",response:"hello",usage:{input_tokens:3,output_tokens:2}}}) + "\\n");
});
`;

function createSupervisor(
  specs: ProviderProcessSpec[],
  inputs: string[],
  conversationIds: readonly string[] = ["conversation-1"],
): ProviderProcessSupervisor {
  let turn = 0;
  return {
    spawn(spec) {
      specs.push(spec);
      const conversationId = conversationIds[turn] ?? conversationIds[conversationIds.length - 1] ?? "conversation-1";
      turn += 1;
      const child = spawn(process.execPath, ["-e", PROVIDER_SCRIPT], {
        ...spec.options,
        env: {
          ...spec.options.env,
          FIRST_TREE_TEST_CONVERSATION_ID: conversationId,
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

describe("Antigravity V1 handler", () => {
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
