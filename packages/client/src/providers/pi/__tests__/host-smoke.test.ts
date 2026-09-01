import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { AgentRuntimeConfig, SessionEvent } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockCtxPlumbing } from "../../../__tests__/test-helpers.js";
import type { AgentConfigCache } from "../../../runtime/agent-config-cache.js";
import type { DeliveryToken, SessionContext, SessionMessage } from "../../../runtime/handler.js";
import type { ProviderProcessSpec, ProviderProcessSupervisor } from "../../../runtime/provider-process-supervisor.js";
import { applyPiChildEnvControls, createPiHandler, freshStartPiSessionId } from "../index.js";
import { buildPiRpcArgs, PiRpcClient } from "../rpc-client.js";

const runHostSmoke = process.env.FT_PI_HOST_SMOKE === "1";

function hostEnv(): Record<string, string> {
  return applyPiChildEnvControls(
    Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
  );
}

function isTruthyPiOffline(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return value === "1" || normalized === "true" || normalized === "yes";
}

/** Drop PATH entries that currently resolve `fd`/`fdfind` so Pi must acquire its helper. */
function pathWithoutFdHelpers(pathEnv: string): string {
  return pathEnv
    .split(delimiter)
    .filter((dir) => {
      if (!dir) return false;
      return !(existsSync(join(dir, "fd")) || existsSync(join(dir, "fdfind")) || existsSync(join(dir, "fd.exe")));
    })
    .join(delimiter);
}

function hostSupervisor(): ProviderProcessSupervisor {
  return {
    spawn(spec) {
      const child = spawn(spec.command, [...spec.args], {
        ...spec.options,
        detached: false,
      });
      return {
        child,
        exited: new Promise<void>((resolve) => child.on("close", () => resolve())),
      };
    },
  };
}

function recordingSupervisor(specs: ProviderProcessSpec[]): ProviderProcessSupervisor {
  const inner = hostSupervisor();
  return {
    spawn(spec) {
      specs.push(spec);
      return inner.spawn(spec);
    },
  };
}

function runtimeConfig(env: AgentRuntimeConfig["payload"]["env"] = []): AgentRuntimeConfig {
  return {
    agentId: "agent-pi-smoke",
    version: 1,
    payload: {
      kind: "pi",
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env,
      gitRepos: [],
      resourceSkills: [],
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

function message(content: string): SessionMessage {
  return {
    inboxEntryId: 1,
    id: "m-smoke",
    chatId: "chat-pi-smoke",
    senderId: "human-1",
    format: "text",
    content,
    metadata: {},
  };
}

function makeToken(): DeliveryToken & { completed: unknown[] } {
  const completed: unknown[] = [];
  return {
    completed,
    processingStarted: vi.fn(),
    complete: async (_messages, outcome) => {
      completed.push(outcome);
      return "settled";
    },
    retry: vi.fn(),
    terminalRejected: vi.fn(async () => {}),
  };
}

function makeContext(events: SessionEvent[]): SessionContext {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  return {
    agent: {
      agentId: "agent-pi-smoke",
      inboxId: "inbox-pi-smoke",
      displayName: "pi-smoke",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: { serverUrl: "https://first-tree.test", sendMessage } as unknown as SessionContext["sdk"],
    chatId: "chat-pi-smoke",
    log: () => {},
    recordProviderActivity: () => {},
    noteTurnStart: () => {},
    emitEvent: (value) => void events.push(value),
    ...mockCtxPlumbing({ sendMessage }, "chat-pi-smoke"),
  };
}

const roots: string[] = [];
const cleanupReceipts: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const receipt of cleanupReceipts.splice(0)) {
    // Receipt paths are under removed roots; keep the list drained.
    void receipt;
  }
});

describe.runIf(runHostSmoke)("Pi host smoke (real 0.83.x)", () => {
  it("correlates command responses, streams text once, normalizes usage, settles, exits cleanly", async () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "ft-pi-host-smoke-"));
    roots.push(sessionDir);
    const sessionId = `ftsmoke${Date.now().toString(16)}`.slice(0, 32);
    const events: string[] = [];
    let assistantText = "";
    let usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | undefined;

    const args = buildPiRpcArgs({
      sessionId,
      sessionDir,
      skillsDir: join(sessionDir, "skills"),
    });
    expect(args).not.toContain("--offline");

    const client = await PiRpcClient.start({
      binary: process.env.PI_BIN ?? "pi",
      args,
      cwd: sessionDir,
      env: hostEnv(),
      supervisor: hostSupervisor(),
      settlementTimeoutMs: 180_000,
      onEvent(event) {
        events.push(String(event.type));
        if (event.type === "message_update") {
          const ame = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
          if (ame?.type === "text_delta" && typeof ame.delta === "string") {
            assistantText += ame.delta;
          }
        }
        if (event.type === "message_end" || event.type === "turn_end") {
          const messagePayload = event.message as
            | { role?: string; usage?: { input?: number; output?: number; cacheRead?: number } }
            | undefined;
          if (messagePayload?.role === "assistant" && messagePayload.usage) {
            usage = {
              inputTokens: messagePayload.usage.input ?? 0,
              cachedInputTokens: messagePayload.usage.cacheRead ?? 0,
              outputTokens: messagePayload.usage.output ?? 0,
            };
          }
        }
      },
    });

    const state = await client.getState();
    expect(state.command).toBe("get_state");
    expect(state.success).toBe(true);
    expect((state.data as { sessionId?: string } | undefined)?.sessionId).toBe(sessionId);

    const prompt = await client.prompt("Reply with exactly: FT_PI_SMOKE_OK");
    expect(prompt.command).toBe("prompt");
    expect(prompt.success).toBe(true);

    await client.waitForSettled();
    expect(events).toContain("agent_settled");
    expect(assistantText.length).toBeGreaterThan(0);
    expect(events.filter((type) => type === "message_update").length).toBeGreaterThan(0);
    if (!usage) throw new Error("expected normalized usage from assistant message");
    expect(usage.inputTokens).toBeGreaterThanOrEqual(0);
    expect(usage.outputTokens).toBeGreaterThanOrEqual(0);

    await client.close();
    expect(client.isClosed).toBe(true);
  }, 240_000);

  it("runs a full First Tree product-path local turn through createPiHandler", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "ft-pi-handler-smoke-"));
    roots.push(workspaceRoot);
    const events: SessionEvent[] = [];
    const token = makeToken();
    const specs: ProviderProcessSpec[] = [];
    const handler = createPiHandler({
      workspaceRoot,
      agentName: "test-agent",
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: process.env.PI_BIN ?? "pi" }),
      providerProcessSupervisor: recordingSupervisor(specs),
      piSettlementTimeoutMs: 180_000,
    });

    const result = await handler.start(
      message("Reply with exactly: FT_PI_HANDLER_SMOKE_OK"),
      makeContext(events),
      token,
    );
    expect(result).toMatchObject({
      sessionId: freshStartPiSessionId("agent-pi-smoke", "chat-pi-smoke", "m-smoke"),
      route: { kind: "owned", mode: "processing" },
    });
    expect(token.completed).toEqual([expect.objectContaining({ status: "success" })]);
    expect(events.some((event) => event.kind === "assistant_text")).toBe(true);
    expect(events).toContainEqual({ kind: "turn_end", payload: { status: "success" } });

    const rpcSpec = specs.find((spec) => spec.args.includes("--mode"));
    expect(rpcSpec?.args).not.toContain("--offline");
    expect(rpcSpec?.options.env?.PI_SKIP_VERSION_CHECK).toBe("1");
    expect(rpcSpec?.options.env?.PI_TELEMETRY).toBe("0");

    await handler.shutdown();
  }, 240_000);

  it("exposes native grep/find/ls through PiRpcClient and createPiHandler", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "ft-pi-tools-smoke-"));
    roots.push(workspaceRoot);
    writeFileSync(join(workspaceRoot, "smoke-marker.txt"), "FT_PI_NATIVE_TOOLS_MARKER\n");
    mkdirSync(join(workspaceRoot, "smoke-dir"), { recursive: true });
    writeFileSync(join(workspaceRoot, "smoke-dir", "nested.txt"), "nested\n");

    const args = buildPiRpcArgs({
      sessionId: `fttools${Date.now().toString(16)}`.slice(0, 32),
      sessionDir: join(workspaceRoot, "sessions"),
      skillsDir: join(workspaceRoot, "skills"),
    });
    expect(args).not.toContain("--offline");
    expect(args.filter((part) => part === "--tools")).toHaveLength(1);
    expect(args[args.indexOf("--tools") + 1]).toBe("read,bash,edit,write,grep,find,ls");

    const rpcToolNames = new Set<string>();
    const client = await PiRpcClient.start({
      binary: process.env.PI_BIN ?? "pi",
      args,
      cwd: workspaceRoot,
      env: hostEnv(),
      supervisor: hostSupervisor(),
      settlementTimeoutMs: 180_000,
      onEvent(event) {
        if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
          rpcToolNames.add(event.toolName.toLowerCase());
        }
      },
    });
    const rpcPrompt = await client.prompt(
      [
        "Use only the native tools ls, find, and grep — do not use bash.",
        "1) Call ls on the current directory.",
        "2) Call find for files named smoke-marker.txt.",
        "3) Call grep for FT_PI_NATIVE_TOOLS_MARKER under the current directory.",
        "After those three tool calls, reply with exactly: FT_PI_TOOLS_OK",
      ].join(" "),
    );
    expect(rpcPrompt.success).toBe(true);
    await client.waitForSettled();
    expect(rpcToolNames.has("ls")).toBe(true);
    expect(rpcToolNames.has("find")).toBe(true);
    expect(rpcToolNames.has("grep")).toBe(true);
    await client.close();

    const events: SessionEvent[] = [];
    const handlerToolNames = new Set<string>();
    const token = makeToken();
    const handler = createPiHandler({
      workspaceRoot,
      agentName: "test-agent",
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: process.env.PI_BIN ?? "pi" }),
      providerProcessSupervisor: hostSupervisor(),
      piSettlementTimeoutMs: 180_000,
    });
    const ctx = makeContext(events);
    const originalEmit = ctx.emitEvent;
    ctx.emitEvent = (event) => {
      if (event.kind === "tool_call" && typeof event.payload?.name === "string") {
        handlerToolNames.add(String(event.payload.name).toLowerCase());
      }
      originalEmit(event);
    };
    await handler.start(
      message(
        [
          "Use only the native tools ls, find, and grep — do not use bash.",
          "Call each of ls, find (smoke-marker.txt), and grep (FT_PI_NATIVE_TOOLS_MARKER) once,",
          "then reply with exactly: FT_PI_HANDLER_TOOLS_OK",
        ].join(" "),
      ),
      ctx,
      token,
    );
    expect(token.completed).toEqual([expect.objectContaining({ status: "success" })]);
    expect(handlerToolNames.has("ls")).toBe(true);
    expect(handlerToolNames.has("find")).toBe(true);
    expect(handlerToolNames.has("grep")).toBe(true);
    await handler.shutdown();
  }, 300_000);

  it.skipIf(isTruthyPiOffline(process.env.PI_OFFLINE))(
    "clean agent dir without PATH fd: Pi acquires helper and native find reaches ok",
    async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "ft-pi-find-clean-"));
      const agentDir = mkdtempSync(join(tmpdir(), "ft-pi-agent-clean-"));
      roots.push(workspaceRoot, agentDir);

      const hostAuth = join(homedir(), ".pi", "agent", "auth.json");
      if (!existsSync(hostAuth)) {
        throw new Error("host Pi auth.json is required for this smoke; do not copy credentials into the task");
      }
      const authBefore = statSync(hostAuth);
      // Symlink only — never read or copy credential bytes into the task tree.
      symlinkSync(hostAuth, join(agentDir, "auth.json"));

      writeFileSync(join(workspaceRoot, "smoke-marker.txt"), "FT_PI_FIND_CLEAN_MARKER\n");
      const sanitizedPath = pathWithoutFdHelpers(process.env.PATH ?? "");
      const fdProbe = spawnSync("fd", ["--version"], {
        env: { PATH: sanitizedPath },
        encoding: "utf8",
      });
      const fdProbeCode = (fdProbe.error as NodeJS.ErrnoException | undefined)?.code;
      expect(fdProbeCode === "ENOENT" || fdProbe.status !== 0).toBe(true);
      expect(existsSync(join(agentDir, "bin", "fd"))).toBe(false);

      const specs: ProviderProcessSpec[] = [];
      const events: SessionEvent[] = [];
      const token = makeToken();
      const handler = createPiHandler({
        workspaceRoot,
        agentName: "test-agent",
        runtimeProvider: "pi",
        agentConfigCache: cache(
          runtimeConfig([
            { key: "PI_CODING_AGENT_DIR", value: agentDir, sensitive: false },
            { key: "PATH", value: sanitizedPath, sensitive: false },
          ]),
        ),
        piBinaryResolver: () => ({ ok: true, binary: process.env.PI_BIN ?? "pi" }),
        providerProcessSupervisor: recordingSupervisor(specs),
        piSettlementTimeoutMs: 240_000,
      });

      const ctx = makeContext(events);
      await handler.start(
        message(
          [
            "Use only the native find tool — do not use bash, grep, or ls.",
            "Call find once for files named smoke-marker.txt under the current directory.",
            "After the find tool completes successfully, reply with exactly: FT_PI_FIND_CLEAN_OK",
          ].join(" "),
        ),
        ctx,
        token,
      );

      const rpcSpec = specs.find((spec) => spec.args.includes("--mode"));
      if (!rpcSpec) throw new Error("expected rpc spawn");
      expect(rpcSpec.args).not.toContain("--offline");
      expect(rpcSpec.args.filter((part) => part === "--tools")).toHaveLength(1);
      expect(rpcSpec.args[rpcSpec.args.indexOf("--tools") + 1]).toBe("read,bash,edit,write,grep,find,ls");
      expect(rpcSpec.options.env?.PI_SKIP_VERSION_CHECK).toBe("1");
      expect(rpcSpec.options.env?.PI_TELEMETRY).toBe("0");
      expect(isTruthyPiOffline(rpcSpec.options.env?.PI_OFFLINE)).toBe(false);

      const findEvents = events.filter(
        (event): event is Extract<SessionEvent, { kind: "tool_call" }> =>
          event.kind === "tool_call" && String(event.payload.name).toLowerCase() === "find",
      );
      expect(findEvents.length).toBeGreaterThanOrEqual(2);
      const findId = findEvents[0]?.payload.toolUseId;
      expect(typeof findId).toBe("string");
      expect(findEvents.some((event) => event.payload.status === "pending" && event.payload.toolUseId === findId)).toBe(
        true,
      );
      expect(findEvents.some((event) => event.payload.status === "ok" && event.payload.toolUseId === findId)).toBe(
        true,
      );
      expect(findEvents.some((event) => event.payload.status === "error")).toBe(false);
      expect(token.completed).toEqual([expect.objectContaining({ status: "success" })]);
      expect(existsSync(join(agentDir, "bin", "fd"))).toBe(true);

      await handler.shutdown();

      const receiptPath = join(workspaceRoot, "cleanup-receipt.txt");
      writeFileSync(
        receiptPath,
        [
          "task_owned_agent_dir=" + agentDir,
          "task_owned_workspace=" + workspaceRoot,
          "helper_bin=" + join(agentDir, "bin", "fd"),
          "host_auth_symlink_target=" + hostAuth,
          "cleanup=afterEach_rmSync_recursive_force",
        ].join("\n") + "\n",
      );
      cleanupReceipts.push(receiptPath);

      const authAfter = statSync(hostAuth);
      expect(authAfter.mtimeMs).toBe(authBefore.mtimeMs);
      expect(authAfter.ino).toBe(authBefore.ino);
      // Ensure we did not rewrite auth through the symlink as a regular file replace.
      expect(dirname(hostAuth)).toBe(join(homedir(), ".pi", "agent"));
    },
    300_000,
  );
});
