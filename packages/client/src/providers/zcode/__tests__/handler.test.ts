import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfigCache } from "../../../runtime/agent-config-cache.js";
import type { DeliveryToken, SessionContext, SessionMessage } from "../../../runtime/handler.js";
import type { ProviderProcessSpec, ProviderProcessSupervisor } from "../../../runtime/provider-process-supervisor.js";
import {
  appendZcodeStdoutChunk,
  type BoundedZcodeStdout,
  clearZcodeAttemptCacheForTests,
  createZcodeHandler,
} from "../index.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  clearZcodeAttemptCacheForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtimeConfig(): AgentRuntimeConfig {
  return {
    agentId: "agent-1",
    version: 1,
    payload: {
      kind: "zcode",
      prompt: { append: "managed prompt" },
      model: "",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
      mode: "plan",
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
    inboxEntryId: 1,
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
    complete: vi.fn(async () => {}),
    retry: vi.fn(),
    terminalRejected: vi.fn(async () => {}),
  } satisfies DeliveryToken;
}

function context(events: unknown[], forwarded: string[]): SessionContext {
  return {
    agent: {
      agentId: "agent-1",
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
        id: "chat-1",
        title: "ZCode test",
        topic: null,
        description: null,
      }),
      listChatParticipants: async () => [],
    } as unknown as SessionContext["sdk"],
    log: vi.fn(),
    chatId: "chat-1",
    recordProviderActivity: vi.fn(),
    noteTurnStart: () => {},
    emitEvent: (event) => events.push(event),
    forwardResult: async (text) => {
      forwarded.push(text);
    },
    markMessagesConsumed: vi.fn(),
    finishTurn: vi.fn(async () => {}),
    retryTurn: vi.fn(),
    failSessionForRecovery: vi.fn(),
    buildAgentEnv: (env) => ({ ...env, FIRST_TREE_AGENT_ID: "agent-1" }),
    formatInboundContent: async (entry) => String(entry.content),
    resolveSenderLabel: async () => "human",
    formatFromHeader: async () => "[From: human]",
    publishTeamSkillCommands: () => {},
  };
}

const TURN_SCRIPT = `
const output = Buffer.from(process.env.FIRST_TREE_TEST_PROVIDER_OUTPUT_BASE64 ?? "", "base64");
if (output.toString("utf8").startsWith("Error: ")) process.stderr.write(output);
else process.stdout.write(output);
process.exitCode = output.toString("utf8").startsWith("Error: ") ? 1 : 0;
`;

const TERM_RESISTANT_SCRIPT = `
const { appendFileSync } = require("node:fs");
const marker = process.env.FIRST_TREE_TEST_MARKER;
let terminated = false;
process.on("SIGTERM", () => { terminated = true; });
let writes = 0;
const timer = setInterval(() => {
  appendFileSync(marker, "x");
  if (terminated && ++writes > 2) process.exit();
}, 1);
`;

const DETACHED_PARENT_SCRIPT = `
const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {});
spawn(process.execPath, ["-e", process.env.FIRST_TREE_TEST_CHILD_SCRIPT], {
  env: process.env,
  stdio: "ignore",
});
setInterval(() => {}, 1_000);
`;

function detachedSupervisor(
  specs: ProviderProcessSpec[],
  script: string,
  env: Record<string, string> = {},
  groupPids: number[] = [],
): ProviderProcessSupervisor {
  return {
    spawn(spec) {
      specs.push(spec);
      const child = spawn(process.execPath, ["-e", script], {
        ...spec.options,
        env: {
          ...spec.options.env,
          ...env,
        },
      });
      if (typeof child.pid === "number") groupPids.push(child.pid);
      return { child, exited: new Promise<void>((resolve) => child.once("exit", () => resolve())) };
    },
  };
}

function turnSupervisor(specs: ProviderProcessSpec[], outputs: string[]): ProviderProcessSupervisor {
  let turn = 0;
  return {
    spawn(spec) {
      specs.push(spec);
      const output = outputs[turn++] ?? "";
      const child = spawn(process.execPath, ["-e", TURN_SCRIPT], {
        ...spec.options,
        env: {
          ...spec.options.env,
          FIRST_TREE_TEST_PROVIDER_OUTPUT_BASE64: Buffer.from(output, "utf8").toString("base64"),
        },
        detached: false,
      });
      return { child, exited: new Promise<void>((resolve) => child.once("exit", () => resolve())) };
    },
  };
}

describe("ZCode production turn handler", () => {
  it("caps retained stdout and ignores all bytes after overflow", () => {
    const state: BoundedZcodeStdout = { parts: [], length: 0, overflow: false };
    appendZcodeStdoutChunk(state, Buffer.alloc(7, "a"), 8);
    expect(state).toEqual({
      parts: [Buffer.alloc(7, "a")],
      length: 7,
      overflow: false,
    });

    appendZcodeStdoutChunk(state, Buffer.alloc(5, "b"), 8);
    expect(state).toEqual({
      parts: [Buffer.alloc(7, "a"), Buffer.alloc(1, "b")],
      length: 8,
      overflow: true,
    });

    appendZcodeStdoutChunk(state, Buffer.alloc(16, "c"), 8);
    expect(state.length).toBe(8);
    expect(Buffer.concat(state.parts, state.length)).toEqual(
      Buffer.concat([Buffer.alloc(7, "a"), Buffer.alloc(1, "b")]),
    );
  });

  it("terminates a detached TERM-resistant process tree and waits for group custody", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-zcode-process-tree-"));
    roots.push(root);
    const marker = join(root, "descendant-marker");
    const specs: ProviderProcessSpec[] = [];
    const groupPids: number[] = [];
    const sessionCtx = context([], []);
    const token = deliveryToken();
    const handler = createZcodeHandler({
      workspaceRoot: root,
      agentName: "zcode-test-agent",
      runtimeProvider: "zcode",
      agentConfigCache: cache(runtimeConfig()),
      zcodeBinaryResolver: async () => ({
        ok: true,
        command: "/node",
        args: ["/managed/zcode.cjs"],
        runtimePath: "/managed/zcode.cjs",
      }),
      providerProcessSupervisor: detachedSupervisor(
        specs,
        DETACHED_PARENT_SCRIPT,
        {
          FIRST_TREE_TEST_CHILD_SCRIPT: TERM_RESISTANT_SCRIPT,
          FIRST_TREE_TEST_MARKER: marker,
        },
        groupPids,
      ),
      zcodeTurnTimeoutMs: 5_000,
      zcodeKillGraceMs: 25,
    });

    try {
      await handler.start(message("m-timeout", "stay alive"), sessionCtx, token);
      const spec = specs.at(0);
      const groupPid = groupPids[0];
      if (!spec || !groupPid) throw new Error("expected a detached process");
      expect(spec.options.detached).toBe(true);

      const groupGone = async (): Promise<boolean> => {
        try {
          process.kill(-groupPid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      };
      const deadline = Date.now() + 2_000;
      while (!(await groupGone())) {
        if (Date.now() > deadline) throw new Error("detached ZCode process group survived termination");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await readFileSync(marker, "utf8")).toContain("x");
      expect(token.retry).toHaveBeenCalledWith(
        [expect.objectContaining({ id: "m-timeout" })],
        "provider_transient_transport",
      );
    } finally {
      const pid = groupPids[0];
      if (pid) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // The process group is already gone.
        }
      }
      await handler.shutdown();
    }
  }, 12_000);

  it("refuses stale managed model configuration instead of injecting it into a prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-zcode-stale-model-"));
    roots.push(root);
    const config = runtimeConfig();
    config.payload = { ...config.payload, model: "glm-4.7" } as typeof config.payload;
    const specs: ProviderProcessSpec[] = [];
    const handler = createZcodeHandler({
      workspaceRoot: root,
      agentName: "zcode-test-agent",
      runtimeProvider: "zcode",
      agentConfigCache: cache(config),
      zcodeBinaryResolver: async () => ({
        ok: true,
        command: "/node",
        args: ["/managed/zcode.cjs"],
        runtimePath: "/managed/zcode.cjs",
      }),
      providerProcessSupervisor: turnSupervisor(specs, []),
      zcodeTurnTimeoutMs: 5_000,
    });

    await expect(handler.start(message("m-model", "hello"), context([], []), deliveryToken())).rejects.toThrow(
      /managed model selection is not supported in V1/,
    );
    expect(specs).toEqual([]);
    await handler.shutdown();
  });

  it("runs one supervised canonical turn, adopts sess_ identity, and settles delivery", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-zcode-handler-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const token = deliveryToken();
    const handler = createZcodeHandler({
      workspaceRoot: root,
      agentName: "zcode-test-agent",
      runtimeProvider: "zcode",
      agentConfigCache: cache(runtimeConfig()),
      zcodeBinaryResolver: async () => ({
        ok: true,
        command: "/node",
        args: ["/managed/zcode.cjs"],
        runtimePath: "/managed/zcode.cjs",
      }),
      providerProcessSupervisor: turnSupervisor(specs, [
        JSON.stringify({
          sessionId: "sess_confirmed",
          response: "done",
          usage: { inputTokens: 5, cacheReadTokens: 2, outputTokens: 1 },
        }),
      ]),
      zcodeTurnTimeoutMs: 5_000,
    });

    const started = await handler.start(message("m-1", "please plan"), sessionCtx, token);

    expect(started.sessionId).toBe("sess_confirmed");
    expect(specs).toHaveLength(1);
    const spec = specs.at(0);
    if (!spec) throw new Error("expected one ZCode process");
    expect(spec.command).toBe("/node");
    expect(spec.args.slice(0, 1)).toEqual(["/managed/zcode.cjs"]);
    expect(spec.options.shell).toBe(false);
    expect(spec.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(spec.args.slice(1, 5)).toEqual(["--json", "--no-color", "--mode", "plan"]);
    expect(spec.args).toEqual(expect.arrayContaining(["--cwd", root]));
    const promptIndex = spec.args.indexOf("--prompt");
    const prompt = spec.args[promptIndex + 1];
    expect(prompt).toContain("please plan");
    expect(prompt).not.toContain("/model ");
    expect(spec.args).not.toContain("--resume");
    expect(forwarded).toEqual(["done"]);
    expect(token.complete).toHaveBeenCalledWith([expect.objectContaining({ id: "m-1" })], { status: "success" });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "token_usage",
        payload: expect.objectContaining({
          provider: "zcode",
          model: "zcode-default",
          inputTokens: 5,
          cachedInputTokens: 2,
          outputTokens: 1,
        }),
      }),
    );
    await handler.shutdown();
  });

  it("refuses configured MCP instead of guessing a headless projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-zcode-handler-mcp-"));
    roots.push(root);
    const config = runtimeConfig();
    config.payload = {
      ...config.payload,
      mcpServers: [{ name: "repo", transport: "stdio", command: "mcp-bin" }],
    };
    const specs: ProviderProcessSpec[] = [];
    const sessionCtx = context([], []);
    const token = deliveryToken();
    const handler = createZcodeHandler({
      workspaceRoot: root,
      agentName: "zcode-test-agent",
      runtimeProvider: "zcode",
      agentConfigCache: cache(config),
      zcodeBinaryResolver: async () => ({
        ok: true,
        command: "/node",
        args: ["/managed/zcode.cjs"],
        runtimePath: "/managed/zcode.cjs",
      }),
      providerProcessSupervisor: turnSupervisor(specs, []),
      zcodeTurnTimeoutMs: 5_000,
    });

    await expect(handler.start(message("m-mcp", "use MCP"), sessionCtx, token)).rejects.toThrow(
      /safe non-interactive MCP projection contract/,
    );
    expect(specs).toEqual([]);
    expect(token.processingStarted).not.toHaveBeenCalled();
  });

  it("maps a clean-host ZCode credential failure to provider-owned login recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-zcode-handler-auth-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const token = deliveryToken();
    const handler = createZcodeHandler({
      workspaceRoot: root,
      agentName: "zcode-test-agent",
      runtimeProvider: "zcode",
      agentConfigCache: cache(runtimeConfig()),
      zcodeBinaryResolver: async () => ({
        ok: true,
        command: "/node",
        args: ["/managed/zcode.cjs"],
        runtimePath: "/managed/zcode.cjs",
      }),
      providerProcessSupervisor: turnSupervisor(specs, [
        "Error: Model config is missing. Create the host-owned ZCode config with an explicit model provider.\n",
      ]),
      zcodeTurnTimeoutMs: 5_000,
    });

    await handler.start(message("m-auth", "hello"), sessionCtx, token);

    const providerEvents = events
      .map((event) => (event as { payload?: { message?: string } }).payload?.message)
      .filter((message): message is string => typeof message === "string");
    expect(providerEvents.join("\n")).toContain("provider_failure_terminal");
    expect(providerEvents.join("\n")).toContain('"category":"credential"');
    expect(providerEvents.join("\n")).toContain("`/node /managed/zcode.cjs login`");
    expect(providerEvents.join("\n")).toContain("provider_credential_required");
    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "m-auth" })],
      expect.objectContaining({ status: "error" }),
    );
    await handler.shutdown();
  }, 12_000);
});
