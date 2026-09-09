import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_KIMI_CODE_RUNTIME_CONFIG_PAYLOAD } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCtxPlumbing } from "../../../__tests__/test-helpers.js";
import type { DeliveryToken, SessionContext, SessionMessage, TurnOutcome } from "../../../runtime/handler.js";
import { ReplayFenceStore } from "../../../runtime/replay-fence.js";
import { createKimiCodeHandler } from "../index.js";

/**
 * End-to-end regression through the REAL patched `@botiverse/kimi-code-sdk`
 * bundle: a live harness + core session + the actual RPC/event bridge, driven
 * by a local mock OpenAI-compatible provider (no external network, no
 * credentials). It proves the replay-fence host hook is invoked at the SDK's
 * awaited authorize boundary and that a hook failure blocks the unsafe tool
 * BEFORE its effect executes — the guarantee the (async, error-swallowing)
 * live-event listener path cannot provide.
 */

type ToolCallSpec = { id: string; name: string; arguments: string };

class MockOpenAIProvider {
  private server: Server | null = null;
  port = 0;
  requests: Array<{ stream: boolean; toolNames: string[] }> = [];
  private step = 0;

  /** Tool calls to emit, one per LLM request; later requests get plain text. */
  constructor(private readonly toolCalls: ToolCallSpec[]) {}

  async start(): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolvePromise) => {
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("mock provider has no address");
    this.port = address.port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" || !req.url?.includes("chat/completions")) {
      res.writeHead(404).end("{}");
      return;
    }
    const body = await this.readBody(req);
    const parsed = JSON.parse(body) as { stream?: boolean; tools?: Array<{ function?: { name?: string } }> };
    this.requests.push({
      stream: parsed.stream === true,
      toolNames: (parsed.tools ?? []).map((tool) => tool.function?.name ?? ""),
    });
    this.step += 1;
    const toolCall = this.toolCalls[this.step - 1];
    if (parsed.stream === true) {
      this.respondSse(res, toolCall);
    } else {
      this.respondJson(res, toolCall);
    }
  }

  private respondJson(res: ServerResponse, toolCall: ToolCallSpec | undefined): void {
    const message = toolCall
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: toolCall.id,
              type: "function",
              function: { name: toolCall.name, arguments: toolCall.arguments },
            },
          ],
        }
      : { role: "assistant", content: "turn done" };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: 0,
        model: "mock-model",
        choices: [{ index: 0, message, finish_reason: toolCall ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  }

  private respondSse(res: ServerResponse, toolCall: ToolCallSpec | undefined): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (delta: Record<string, unknown>, finish: string | null) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        created: 0,
        model: "mock-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    if (toolCall) {
      res.write(chunk({ role: "assistant", content: "" }, null));
      res.write(
        chunk(
          {
            tool_calls: [
              {
                index: 0,
                id: toolCall.id,
                type: "function",
                function: { name: toolCall.name, arguments: "" },
              },
            ],
          },
          null,
        ),
      );
      res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: toolCall.arguments } }] }, null));
      res.write(chunk({}, "tool_calls"));
    } else {
      res.write(chunk({ role: "assistant", content: "turn done" }, null));
      res.write(chunk({}, "stop"));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => resolvePromise(body));
      req.on("error", rejectPromise);
    });
  }
}

type SdkHarness = {
  createSession(options: Record<string, unknown>): Promise<{
    id: string;
    prompt(input: string): Promise<void>;
    onEvent(listener: (event: { type: string }) => void): () => void;
    close(): Promise<void>;
  }>;
  close(): Promise<void>;
};

type SdkTestSession = Awaited<ReturnType<SdkHarness["createSession"]>>;

async function runTurnToEnd(session: SdkTestSession, events: string[], prompt: string): Promise<void> {
  let resolveEnded: () => void = () => {};
  const ended = new Promise<void>((resolvePromise) => {
    resolveEnded = resolvePromise;
  });
  const unsubscribe = session.onEvent((event) => {
    events.push(event.type);
    if (event.type === "turn.ended") resolveEnded();
  });
  try {
    await session.prompt(prompt);
    await Promise.race([
      ended,
      new Promise((_, reject) => setTimeout(() => reject(new Error("turn never ended")), 30_000)),
    ]);
  } finally {
    unsubscribe();
  }
}

let homeDir: string;
let workDir: string;
let provider: MockOpenAIProvider;
let harness: SdkHarness | null = null;

const MARKER_NAME = "authorize-hook-effect-marker.txt";

beforeEach(async () => {
  homeDir = mkdtempSync(join(tmpdir(), "kimi-sdk-hook-home-"));
  workDir = mkdtempSync(join(tmpdir(), "kimi-sdk-hook-work-"));
  provider = new MockOpenAIProvider([
    {
      id: "call_bash_marker",
      name: "Bash",
      arguments: JSON.stringify({ command: `touch ${MARKER_NAME}` }),
    },
  ]);
  await provider.start();
  writeFileSync(
    join(homeDir, "config.toml"),
    [
      'default_provider = "mock"',
      'default_model = "mock-model"',
      "telemetry = false",
      "",
      "[providers.mock]",
      'type = "openai"',
      `base_url = "http://127.0.0.1:${provider.port}/v1"`,
      'api_key = "mock-key"',
      "",
      '[models."mock-model"]',
      'provider = "mock"',
      'model = "mock-model"',
      "max_context_size = 131072",
      'capabilities = ["tool_use"]',
      "",
    ].join("\n"),
    "utf-8",
  );
});

afterEach(async () => {
  delete (globalThis as { __firstTreeBeforeToolCall?: unknown }).__firstTreeBeforeToolCall;
  if (harness) {
    await harness.close().catch(() => {});
    harness = null;
  }
  await provider.stop();
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

async function createHarness(): Promise<SdkHarness> {
  const require = createRequire(import.meta.url);
  const sdk = (await import(
    require.resolve("@botiverse/kimi-code-sdk", {
      paths: [join(process.cwd(), "src", "__tests__")],
    })
  )) as { createKimiHarness(options: Record<string, unknown>): SdkHarness };
  return sdk.createKimiHarness({
    identity: { userAgentProduct: "first-tree-test", version: "0.0.0" },
    uiMode: "first-tree",
    homeDir,
  });
}

/** Repoint the mock provider at a new tool-call script (config.toml rewrite). */
async function reconfigureProvider(toolCalls: ToolCallSpec[]): Promise<void> {
  await provider.stop();
  provider = new MockOpenAIProvider(toolCalls);
  await provider.start();
  writeFileSync(
    join(homeDir, "config.toml"),
    [
      'default_provider = "mock"',
      'default_model = "mock-model"',
      "telemetry = false",
      "",
      "[providers.mock]",
      'type = "openai"',
      `base_url = "http://127.0.0.1:${provider.port}/v1"`,
      'api_key = "mock-key"',
      "",
      '[models."mock-model"]',
      'provider = "mock"',
      'model = "mock-model"',
      "max_context_size = 131072",
      'capabilities = ["tool_use"]',
      "",
    ].join("\n"),
    "utf-8",
  );
}

function handlerMessage(id: string, content: string): SessionMessage {
  return { id, chatId: "chat-e2e", senderId: "human-1", format: "text", content, metadata: {} };
}

function handlerToken(): DeliveryToken & { completed: TurnOutcome[]; retried: string[] } {
  const completed: TurnOutcome[] = [];
  const retried: string[] = [];
  return {
    completed,
    retried,
    processingStarted: () => {},
    complete: async (_messages, outcome) => {
      completed.push(outcome);
    },
    retry: (_messages, reason) => void retried.push(reason),
    terminalRejected: async () => {},
  };
}

function handlerContext(): SessionContext {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  return {
    agent: {
      agentId: "agent-e2e",
      inboxId: "inbox-e2e",
      displayName: "e2e-agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: { serverUrl: "https://first-tree.test", sendMessage } as unknown as SessionContext["sdk"],
    chatId: "chat-e2e",
    log: () => {},
    recordProviderActivity: () => {},
    noteTurnStart: () => {},
    emitEvent: () => {},
    ...mockCtxPlumbing({ sendMessage }, "chat-e2e"),
  };
}

describe("patched SDK authorize boundary (real bundle + mock provider)", () => {
  it("invokes the host hook with session/agent identity and blocks the unsafe effect when it throws", async () => {
    const hookCalls: Array<{ sessionId?: string; agentId?: string; toolName: string }> = [];
    (globalThis as { __firstTreeBeforeToolCall?: unknown }).__firstTreeBeforeToolCall = (info: {
      sessionId?: string;
      agentId?: string;
      toolName: string;
    }) => {
      hookCalls.push(info);
      if (info.toolName === "Bash") throw new Error("durable fence failed");
    };

    harness = await createHarness();
    const session = await harness.createSession({ workDir, permission: "yolo" });
    const events: string[] = [];
    await runTurnToEnd(session, events, "run the bash tool, then finish");
    await session.close();

    expect(hookCalls.length).toBeGreaterThan(0);
    expect(hookCalls[0]).toMatchObject({ sessionId: session.id, agentId: "main", toolName: "Bash" });
    // The decisive assertion: the hook failure blocked the call at the
    // authorize boundary, so the Bash effect never executed.
    expect(existsSync(join(workDir, MARKER_NAME))).toBe(false);
    // The turn continued past the blocked tool and ended on the main agent.
    expect(events).toContain("tool.call.started");
    expect(events).toContain("turn.ended");
  }, 60_000);

  it("lets the effect run when the host hook allows the call", async () => {
    (globalThis as { __firstTreeBeforeToolCall?: unknown }).__firstTreeBeforeToolCall = () => {};

    harness = await createHarness();
    const session = await harness.createSession({ workDir, permission: "yolo" });
    await runTurnToEnd(session, [], "run the bash tool, then finish");
    await session.close();

    expect(existsSync(join(workDir, MARKER_NAME))).toBe(true);
  }, 60_000);

  it("blocks BOTH unsafe calls across a real handler turn when the fence store keeps failing", async () => {
    await reconfigureProvider([
      { id: "call_bash_one", name: "Bash", arguments: JSON.stringify({ command: "touch marker-one.txt" }) },
      { id: "call_bash_two", name: "Bash", arguments: JSON.stringify({ command: "touch marker-two.txt" }) },
    ]);
    // Real fence store in an unwritable directory: every persist fails.
    const fenceDir = mkdtempSync(join(tmpdir(), "kimi-sdk-fence-blocked-"));
    chmodSync(fenceDir, 0o500);
    const fenceStore = new ReplayFenceStore(join(fenceDir, "fence.json"));
    fenceStore.load();
    const require = createRequire(import.meta.url);
    const sdk = (await import(
      require.resolve("@botiverse/kimi-code-sdk", { paths: [join(process.cwd(), "src", "__tests__")] })
    )) as {
      createKimiHarness(options: Record<string, unknown>): SdkHarness;
    };

    const handler = createKimiCodeHandler({
      workspaceRoot: workDir,
      agentName: "test-agent",
      runtimeProvider: "kimi-code",
      agentConfigCache: {
        refresh: async () => ({ payload: DEFAULT_KIMI_CODE_RUNTIME_CONFIG_PAYLOAD }),
        get: () => ({ payload: DEFAULT_KIMI_CODE_RUNTIME_CONFIG_PAYLOAD }),
      },
      kimiHarnessFactory: () =>
        sdk.createKimiHarness({
          identity: { userAgentProduct: "first-tree-test", version: "0.0.0" },
          uiMode: "first-tree",
          homeDir,
        }),
      replayFence: fenceStore,
    });
    const token = handlerToken();

    await handler.start(handlerMessage("m1", "run two bash writes"), handlerContext(), token);
    await handler.shutdown("test-done");
    chmodSync(fenceDir, 0o700);
    rmSync(fenceDir, { recursive: true, force: true });

    // The first call was blocked at the authorize boundary, and the second
    // hit the fail-closed fenceError path: neither marker may exist, and the
    // delivery keeps custody instead of a false terminal ACK.
    expect(existsSync(join(workDir, "marker-one.txt"))).toBe(false);
    expect(existsSync(join(workDir, "marker-two.txt"))).toBe(false);
    expect(token.completed).toEqual([]);
    expect(token.retried).toContain("replay_fence_persist_failed");
    expect(fenceStore.snapshot()).toEqual([]);
  }, 60_000);
});
