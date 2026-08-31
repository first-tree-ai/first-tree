import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentRuntimeConfig, SessionEvent } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../../__tests__/_logger-helpers.js";
import { mockEntry } from "../../../__tests__/test-helpers.js";
import type { FirstTreeHubSDK } from "../../../cloud/sdk.js";
import type { AgentConfigCache } from "../../../runtime/agent-config-cache.js";
import { PROVIDER_UNSAFE_TURN_CONTINUATION } from "../../../runtime/handler.js";
import type { ProviderProcessSpec, ProviderProcessSupervisor } from "../../../runtime/provider-process-supervisor.js";
import { SessionRuntime } from "../../../runtime/session-runtime.js";
import { createAntigravityHandler } from "../index.js";

const roots: string[] = [];
const runtimes: SessionRuntime[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) await runtime.shutdown();
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
      env: [],
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

function mutatingInitOutput(conversationId: string): string[] {
  return [
    JSON.stringify({ event: "init", conversation_id: conversationId }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: conversationId,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_call_id: "call-mutating",
        tool_info: { parameters: { command: "touch side-effect-marker" } },
      },
    }),
  ];
}

function successOutput(conversationId: string, response: string): string[] {
  return [
    JSON.stringify({ event: "init", conversation_id: conversationId }),
    JSON.stringify({
      event: "result",
      result: { conversation_id: conversationId, status: "SUCCESS", response },
    }),
  ];
}

function createControlledSupervisor(
  specs: ProviderProcessSpec[],
  inputs: string[],
  outputLinesByTurn: readonly (readonly string[])[],
  closeAfterTurn: readonly boolean[],
): ProviderProcessSupervisor {
  let turn = 0;
  return {
    spawn(spec) {
      specs.push(spec);
      const currentOutputLines = outputLinesByTurn[turn] ?? [];
      const shouldCloseAfterOutput = closeAfterTurn[turn] ?? false;
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
        queueMicrotask(() => child.emit("close", 0, null));
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
        if (shouldCloseAfterOutput) complete();
      });
      return { child, exited: new Promise<void>((resolve) => child.once("close", () => resolve())) };
    },
  };
}

type RuntimeInternals = {
  projection: {
    getSession(chatId: string): { chatId: string } | undefined;
    dropLiveSession(chatId: string): void;
    persistRegistry(): void;
    evictedMappings: Map<string, { claudeSessionId: string; lastActivity: number }>;
  };
  routeTeardown: {
    invalidateRouteTransition(entry: object, reason: string): unknown;
  };
  slotScheduler: {
    releaseActiveSlot(entry: object): boolean;
  };
  inboxDelivery: {
    prepareEvict(chatId: string, reason: string): void;
  };
};

describe("Antigravity SessionRuntime recovery after first-turn mutation", () => {
  it.each([
    ["working concurrency preemption", "preempt"],
    ["forced route retirement", "retire"],
  ] as const)("preserves exact conversation and continuation on %s", async (_label, kind) => {
    const root = mkdtempSync(join(tmpdir(), `ft-antigravity-runtime-${kind}-`));
    roots.push(root);
    const conversationId = `conversation-${kind}`;
    const originalPrompt = "mutate this now";
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: Array<{ chatId: string; event: SessionEvent }> = [];
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const mutating = mutatingInitOutput(conversationId);
    const recovered = successOutput(conversationId, "continued");
    const competing = successOutput("conversation-competing", "ok");
    const supervisor = createControlledSupervisor(
      specs,
      inputs,
      kind === "preempt" ? [mutating, competing, recovered] : [mutating, recovered],
      kind === "preempt" ? [false, true, true] : [false, true],
    );
    const sdk = {
      serverUrl: "https://first-tree.test",
      sendMessage: vi.fn(async () => ({ id: "runtime-notice" })),
      getChatDetail: vi.fn(async (chatId: string) => ({
        id: chatId,
        title: "Antigravity recovery",
        topic: null,
        description: null,
      })),
      listChatParticipants: vi.fn(async () => [
        {
          agentId: "sender-1",
          name: "human",
          displayName: "Human",
          type: "human",
          role: "member",
          mode: "default",
          accessMode: "speaker",
        },
      ]),
    } as unknown as FirstTreeHubSDK;
    const registryPath = join(root, "sessions.json");
    const makeRuntime = (): SessionRuntime =>
      new SessionRuntime({
        session: {
          idle_timeout: 300,
          max_sessions: 10,
          working_grace_seconds: 3600,
          reconcile_interval_seconds: 300,
        },
        concurrency: 1,
        handlerFactory: (handlerConfig) =>
          createAntigravityHandler({
            ...handlerConfig,
            antigravityBinaryResolver: () => ({ ok: true, binary: process.execPath }),
            providerProcessSupervisor: supervisor,
            antigravityTurnTimeoutMs: 5_000,
          }),
        handlerConfig: { workspaceRoot: root, agentName: "antigravity-test-agent", runtimeProvider: "antigravity" },
        resolveContextTreeBinding: async () => null,
        agentIdentity: {
          agentId: "agent-1",
          inboxId: "inbox-1",
          displayName: "Agent",
          type: "agent",
          visibility: "organization",
          delegateMention: null,
          metadata: {},
        },
        sdk,
        log: silentLogger(),
        registryPath,
        ackEntry,
        recoverChat,
        agentConfigCache: cache(runtimeConfig()),
        onSessionEvent: (chatId, event) => events.push({ chatId, event }),
      });
    const runtime = makeRuntime();
    runtimes.push(runtime);

    const chatId = `chat-${kind}`;
    const delivery = mockEntry({
      id: 901,
      chatId,
      messageId: `msg-${kind}-head`,
      content: originalPrompt,
    });
    const firstDispatch = runtime.dispatch(delivery);
    await vi.waitFor(() => expect(specs).toHaveLength(1), { timeout: 10_000 });
    await vi.waitFor(
      () => expect(events.some(({ chatId: id, event }) => id === chatId && event.kind === "tool_call")).toBe(true),
      { timeout: 10_000 },
    );

    if (kind === "preempt") {
      await runtime.dispatch(
        mockEntry({
          id: 902,
          chatId: "chat-competing",
          messageId: "msg-competing",
          content: "take the only runtime slot",
        }),
      );
    } else {
      const internals = runtime as unknown as RuntimeInternals;
      const entry = internals.projection.getSession(chatId);
      if (!entry) throw new Error("expected in-flight Antigravity session");
      internals.routeTeardown.invalidateRouteTransition(entry, "session_evicted");
      internals.slotScheduler.releaseActiveSlot(entry);
      internals.inboxDelivery.prepareEvict(chatId, "session_evicted");
      internals.projection.dropLiveSession(chatId);
      internals.projection.persistRegistry();
    }

    await firstDispatch;
    expect(ackEntry).not.toHaveBeenCalledWith(901);
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith(chatId), { timeout: 10_000 });
    const internalsAfter = runtime as unknown as RuntimeInternals;
    expect(internalsAfter.projection.evictedMappings.get(chatId)?.claudeSessionId).toBe(conversationId);

    await runtime.shutdown();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    const persisted = JSON.parse(readFileSync(registryPath, "utf8")) as {
      entries: Record<
        string,
        { claudeSessionId?: string; providerRecovery?: { messageId?: string; continuation?: string } }
      >;
    };
    expect(persisted.entries[chatId]).toMatchObject({
      claudeSessionId: conversationId,
      providerRecovery: { messageId: delivery.message.id, continuation: "unsafe_turn" },
    });

    const recoveredRuntime = makeRuntime();
    runtimes.push(recoveredRuntime);
    const recoveryCallsBeforeRestartDispatch = recoverChat.mock.calls.length;
    await recoveredRuntime.dispatch(delivery);
    expect(recoverChat).toHaveBeenCalledTimes(recoveryCallsBeforeRestartDispatch + 1);
    expect(ackEntry).not.toHaveBeenCalledWith(901);

    // inbox:recover only opens the server recovery window. The provider may
    // resume once that same delivered row is redelivered into the window.
    await recoveredRuntime.dispatch(delivery);
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledWith(901), { timeout: 10_000 });

    const recoverySpec = specs.find((spec) => spec.args.includes("--conversation"));
    expect(recoverySpec?.args).toEqual(expect.arrayContaining(["--conversation", conversationId]));
    expect(inputs.filter((chunk) => chunk.includes(originalPrompt))).toHaveLength(1);
    expect(inputs.some((chunk) => chunk.includes(PROVIDER_UNSAFE_TURN_CONTINUATION))).toBe(true);
    expect(events.filter(({ chatId: id, event }) => id === chatId && event.kind === "tool_call")).toHaveLength(1);
  });
});
