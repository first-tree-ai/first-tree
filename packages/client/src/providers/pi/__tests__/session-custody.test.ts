import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig, SessionEvent } from "@first-tree/shared";
import { encodeProviderRetryEventMessage } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../../__tests__/_logger-helpers.js";
import { mockEntry } from "../../../__tests__/test-helpers.js";
import type { FirstTreeHubSDK } from "../../../cloud/sdk.js";
import type { AgentConfigCache } from "../../../runtime/agent-config-cache.js";
import type { AgentHandler } from "../../../runtime/handler.js";
import type { ProviderProcessSpec, ProviderProcessSupervisor } from "../../../runtime/provider-process-supervisor.js";
import { SessionRegistry } from "../../../runtime/session-registry.js";
import { SessionRuntime } from "../../../runtime/session-runtime.js";
import { createPiHandler, freshStartPiSessionId, type PiRetrySleep } from "../index.js";

function mockAckEntry() {
  return vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
}

const RPC_CHILD_SCRIPT = `
const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const expectedSessionId = process.env.FT_PI_EXPECTED_SESSION_ID ?? "";
const promptCountFile = process.env.FT_PI_PROMPT_COUNT_FILE ?? "";
const steerCountFile = process.env.FT_PI_STEER_COUNT_FILE ?? "";
const bashStartFile = process.env.FT_PI_BASH_START_FILE ?? "";
const bashStartCountFile = process.env.FT_PI_BASH_START_COUNT_FILE ?? "";
const promptGateFile = process.env.FT_PI_PROMPT_GATE_FILE ?? "";
const getStateFailRemainFile = process.env.FT_PI_GET_STATE_FAIL_REMAINING_FILE ?? "";
const modeFile = process.env.FT_PI_TEST_MODE_FILE ?? "";

function currentMode() {
  if (modeFile) {
    try {
      const fromFile = fs.readFileSync(modeFile, "utf8").trim();
      if (fromFile) return fromFile;
    } catch {}
  }
  return process.env.FT_PI_TEST_MODE ?? "happy";
}
function bump(file) {
  if (!file) return;
  let n = 0;
  try { n = Number(fs.readFileSync(file, "utf8")) || 0; } catch {}
  fs.writeFileSync(file, String(n + 1));
}
function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
function gateOpen() {
  if (!promptGateFile) return true;
  try { return fs.readFileSync(promptGateFile, "utf8").trim() === "1"; } catch { return false; }
}
function consumeGetStateFail() {
  if (!getStateFailRemainFile) return false;
  let remain = 0;
  try { remain = Number(fs.readFileSync(getStateFailRemainFile, "utf8")) || 0; } catch {}
  if (remain <= 0) return false;
  fs.writeFileSync(getStateFailRemainFile, String(remain - 1));
  return true;
}
function holdBashAfterAccept(id) {
  write({ type: "response", id, command: "prompt", success: true });
  write({
    type: "tool_execution_start",
    toolCallId: "bash-hold-1",
    toolName: "bash",
    args: { command: "sleep 60" },
  });
  bump(bashStartCountFile);
  if (bashStartFile) {
    try { fs.writeFileSync(bashStartFile, "1"); } catch {}
  }
}

rl.on("line", (line) => {
  const req = JSON.parse(line);
  const id = req.id;
  const command = req.type;
  const mode = currentMode();
  if (command === "get_state") {
    if (mode === "get_state_fail") {
      write({
        type: "response",
        id,
        command: "get_state",
        success: false,
        error: "missing credentials — run /login",
      });
      return;
    }
    if (
      (mode === "transient_get_state_once_then_bash_hold" ||
        mode === "transient_get_state_once_then_hold_gate") &&
      consumeGetStateFail()
    ) {
      // Capacity-classified session failure (not pi_protocol_error): retryable.
      write({
        type: "response",
        id,
        command: "get_state",
        success: false,
        error: "provider overloaded",
      });
      return;
    }
    const respondOk = () =>
      write({
        type: "response",
        id,
        command: "get_state",
        success: true,
        data: { sessionId: expectedSessionId, isStreaming: false, messageCount: 0 },
      });
    if (mode === "hold_get_state_until_gate" || mode === "transient_get_state_once_then_hold_gate") {
      const tick = () => {
        if (!gateOpen()) {
          setTimeout(tick, 15);
          return;
        }
        respondOk();
      };
      tick();
      return;
    }
    respondOk();
    return;
  }
  if (command === "prompt") {
    bump(promptCountFile);
    if (mode === "preflight_capacity") {
      write({ type: "response", id, command: "prompt", success: false, error: "provider overloaded" });
      return;
    }
    if (mode === "preflight_credential") {
      write({
        type: "response",
        id,
        command: "prompt",
        success: false,
        error: "missing credentials — run /login",
      });
      return;
    }
    if (mode === "exhausted_retry") {
      write({ type: "response", id, command: "prompt", success: true });
      write({
        type: "message_update",
        message: { role: "assistant", content: [] },
        assistantMessageEvent: {
          type: "error",
          error: { role: "assistant", errorMessage: "temporary provider blip", stopReason: "error" },
        },
      });
      write({ type: "auto_retry_end", success: false, attempt: 1, finalError: "provider overloaded" });
      write({ type: "agent_settled" });
      return;
    }
    if (
      mode === "bash_hold_until_abort" ||
      mode === "hold_get_state_until_gate" ||
      mode === "transient_get_state_once_then_bash_hold" ||
      mode === "transient_get_state_once_then_hold_gate"
    ) {
      holdBashAfterAccept(id);
      return;
    }
    // Prompt line written; response withheld; unsafe tool may still start.
    if (mode === "prompt_write_tool_no_response") {
      write({
        type: "tool_execution_start",
        toolCallId: "bash-hold-1",
        toolName: "bash",
        args: { command: "sleep 60" },
      });
      bump(bashStartCountFile);
      if (bashStartFile) {
        try { fs.writeFileSync(bashStartFile, "1"); } catch {}
      }
      return;
    }
    // Prompt accepted; no first stream event / settlement.
    if (mode === "prompt_accepted_no_events") {
      write({ type: "response", id, command: "prompt", success: true });
      if (bashStartFile) {
        try { fs.writeFileSync(bashStartFile, "1"); } catch {}
      }
      return;
    }
    write({ type: "response", id, command: "prompt", success: true });
    write({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ok" },
    });
    write({ type: "agent_settled" });
    return;
  }
  if (command === "steer") {
    bump(steerCountFile);
    if (mode === "steer_reject") {
      write({ type: "response", id, command: "steer", success: false, error: "not streaming" });
      return;
    }
    write({ type: "response", id, command: "steer", success: true });
    return;
  }
  if (command === "abort") {
    if (
      mode === "bash_hold_until_abort" ||
      mode === "prompt_write_tool_no_response" ||
      mode === "hold_get_state_until_gate" ||
      mode === "transient_get_state_once_then_bash_hold" ||
      mode === "transient_get_state_once_then_hold_gate"
    ) {
      write({ type: "tool_execution_end", toolCallId: "bash-hold-1", isError: true, result: "aborted" });
      write({ type: "agent_settled" });
      write({ type: "response", id, command: "abort", success: true });
      return;
    }
    if (mode === "prompt_accepted_no_events") {
      write({ type: "agent_settled" });
      write({ type: "response", id, command: "abort", success: true });
      return;
    }
    write({ type: "response", id, command: "abort", success: true });
    write({ type: "agent_settled" });
    return;
  }
  write({ type: "response", id, command: command ?? "unknown", success: false, error: "unknown" });
});
`;

const VERSION_SCRIPT = `process.stdout.write("pi 0.80.5\\n");`;

const roots: string[] = [];
let workspaceRoot = "";
let promptCountFile = "";
let steerCountFile = "";
let bashStartFile = "";
let bashStartCountFile = "";
let promptGateFile = "";
let getStateFailRemainFile = "";
let testModeFile = "";

function setPiTestMode(mode: string): void {
  process.env.FT_PI_TEST_MODE = mode;
  if (testModeFile) writeFileSync(testModeFile, mode);
}

function readCount(file: string): number {
  try {
    return Number(readFileSync(file, "utf8")) || 0;
  } catch {
    return 0;
  }
}

/** `--session-id` argv of each spawned RPC process (version-gate spawns excluded). */
function rpcSessionIds(specs: ProviderProcessSpec[]): string[] {
  return specs
    .filter((spec) => spec.args.includes("--mode"))
    .map((spec) => {
      const index = spec.args.indexOf("--session-id");
      return index >= 0 ? String(spec.args[index + 1] ?? "") : "";
    });
}

function runtimeConfig(): AgentRuntimeConfig {
  return {
    agentId: "agent-1",
    version: 1,
    payload: {
      kind: "pi",
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [],
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

function createSyntheticSupervisor(specs: ProviderProcessSpec[]): ProviderProcessSupervisor {
  return {
    spawn(spec) {
      specs.push(spec);
      const isVersion = spec.args[0] === "--version";
      const sessionIdArgIndex = spec.args.indexOf("--session-id");
      const expectedSessionId = sessionIdArgIndex >= 0 ? String(spec.args[sessionIdArgIndex + 1] ?? "") : "";
      const child = spawn(process.execPath, ["-e", isVersion ? VERSION_SCRIPT : RPC_CHILD_SCRIPT], {
        ...spec.options,
        env: {
          ...spec.options.env,
          FT_PI_TEST_MODE: process.env.FT_PI_TEST_MODE ?? "happy",
          FT_PI_TEST_MODE_FILE: testModeFile,
          FT_PI_EXPECTED_SESSION_ID: expectedSessionId,
          FT_PI_PROMPT_COUNT_FILE: promptCountFile,
          FT_PI_STEER_COUNT_FILE: steerCountFile,
          FT_PI_BASH_START_FILE: bashStartFile,
          FT_PI_BASH_START_COUNT_FILE: bashStartCountFile,
          FT_PI_PROMPT_GATE_FILE: promptGateFile,
          FT_PI_GET_STATE_FAIL_REMAINING_FILE: getStateFailRemainFile,
        },
        detached: false,
      });
      return {
        child,
        exited: new Promise<void>((resolve) => child.on("close", () => resolve())),
      };
    },
  };
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "pi-session-custody-"));
  roots.push(workspaceRoot);
  promptCountFile = join(workspaceRoot, "prompt-count.txt");
  steerCountFile = join(workspaceRoot, "steer-count.txt");
  bashStartFile = join(workspaceRoot, "bash-start.txt");
  bashStartCountFile = join(workspaceRoot, "bash-start-count.txt");
  promptGateFile = join(workspaceRoot, "prompt-gate.txt");
  getStateFailRemainFile = join(workspaceRoot, "get-state-fail-remain.txt");
  testModeFile = join(workspaceRoot, "pi-test-mode.txt");
  writeFileSync(promptCountFile, "0");
  writeFileSync(steerCountFile, "0");
  writeFileSync(bashStartFile, "0");
  writeFileSync(bashStartCountFile, "0");
  writeFileSync(promptGateFile, "0");
  writeFileSync(getStateFailRemainFile, "0");
  writeFileSync(testModeFile, "happy");
  delete process.env.FT_PI_TEST_MODE;
});

afterEach(() => {
  delete process.env.FT_PI_TEST_MODE;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Pi handler → SessionRuntime custody", () => {
  it("posts durable exhausted-retry notice before ACK with a single prompt write", async () => {
    setPiTestMode("exhausted_retry");
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice-pi" });
    const sdk = {
      serverUrl: "https://first-tree.test",
      register: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue({ id: "msg-reply" }),
      postRuntimeNotice,
      sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
      getChatContext: vi.fn().mockResolvedValue(null),
    } as unknown as FirstTreeHubSDK;

    const handler = createPiHandler({
      workspaceRoot,
      agentName: "pi-custody-test-agent",
      runtimeProvider: "pi",
      agentConfigCache: cache(runtimeConfig()),
      piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
    });

    const sm = new SessionRuntime({
      session: {
        idle_timeout: 300,
        max_sessions: 10,
        working_grace_seconds: 3600,
        reconcile_interval_seconds: 300,
      },
      concurrency: 5,
      handlerFactory: () => handler,
      handlerConfig: { workspaceRoot, agentName: "pi-custody-test-agent", runtimeProvider: "pi" },
      resolveContextTreeBinding: async () => null,
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
      ackEntry,
      agentConfigCache: cache(runtimeConfig()),
    });

    await sm.dispatch(mockEntry({ id: 77, chatId: "chat-pi-exhausted", messageId: "msg-pi-exhausted", content: "go" }));

    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);
    expect(postRuntimeNotice).toHaveBeenCalledTimes(1);
    // The dedicated runtime-notice endpoint carries only the chat id and the
    // text; the server authors the delivery profile and the stored marker.
    expect(postRuntimeNotice).toHaveBeenCalledWith("chat-pi-exhausted", expect.any(String));
    const notice = String(postRuntimeNotice.mock.calls[0]?.[1]);
    expect(notice).toContain("Pi could not run this turn");
    expect(notice).not.toContain("provider overloaded");
    expect(notice).not.toContain("temporary provider blip");
    expect(ackEntry).toHaveBeenCalledWith(77);
    const noticeOrder = postRuntimeNotice.mock.invocationCallOrder[0];
    const ackOrder = ackEntry.mock.invocationCallOrder[0];
    expect(noticeOrder).toBeTypeOf("number");
    expect(ackOrder).toBeTypeOf("number");
    expect(noticeOrder as number).toBeLessThan(ackOrder as number);

    await sm.shutdown();
  });

  function makePiSessionRuntime(input: {
    specs: ProviderProcessSpec[];
    ackEntry: ReturnType<typeof mockAckEntry>;
    postRuntimeNotice: ReturnType<typeof vi.fn>;
    onHandler?: (handler: ReturnType<typeof createPiHandler>) => void;
    recoverChat?: (chatId: string) => Promise<void>;
    registryPath?: string;
  }): SessionRuntime {
    const sdk = {
      serverUrl: "https://first-tree.test",
      register: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue({ id: "msg-reply" }),
      postRuntimeNotice: input.postRuntimeNotice,
      sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
      getChatContext: vi.fn().mockResolvedValue(null),
    } as unknown as FirstTreeHubSDK;
    return new SessionRuntime({
      session: {
        idle_timeout: 300,
        max_sessions: 10,
        working_grace_seconds: 3600,
        reconcile_interval_seconds: 300,
      },
      concurrency: 5,
      handlerFactory: () => {
        const handler = createPiHandler({
          workspaceRoot,
          agentName: "pi-custody-test-agent",
          runtimeProvider: "pi",
          agentConfigCache: cache(runtimeConfig()),
          piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
          providerProcessSupervisor: createSyntheticSupervisor(input.specs),
        });
        input.onHandler?.(handler);
        return handler;
      },
      handlerConfig: { workspaceRoot, agentName: "pi-custody-test-agent", runtimeProvider: "pi" },
      resolveContextTreeBinding: async () => null,
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
      ackEntry: input.ackEntry,
      ...(input.recoverChat ? { recoverChat: input.recoverChat } : {}),
      ...(input.registryPath ? { registryPath: input.registryPath } : {}),
      agentConfigCache: cache(runtimeConfig()),
    });
  }

  it.each([
    ["agent_runtime_switch"],
    ["runtime switched by server"],
    ["operator stop"],
  ] as const)("graceful manager shutdown reason %s settles accepted bash once without start adoption", async (shutdownReason) => {
    setPiTestMode("bash_hold_until_abort");
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice-pi-shutdown" });
    const shutdownCalls: Array<{ reason?: string; opts?: { settleProviderEntered?: boolean } }> = [];

    const sm = makePiSessionRuntime({
      specs,
      ackEntry,
      postRuntimeNotice,
      onHandler: (handler) => {
        const original = handler.shutdown.bind(handler);
        handler.shutdown = async (reason, opts) => {
          shutdownCalls.push({ reason, opts });
          return original(reason, opts);
        };
      },
    });

    const entry = mockEntry({
      id: 88,
      chatId: "chat-pi-shutdown-replay",
      messageId: "msg-pi-shutdown-replay",
      content: "run sleep 60",
    });
    const dispatchPromise = sm.dispatch(entry);
    await vi.waitFor(() => expect(Number(readFileSync(bashStartFile, "utf8")) || 0).toBe(1));
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);

    await sm.shutdown(shutdownReason);
    await dispatchPromise;

    // Full manager drain settles explicitly; a later stale-start discard may
    // retire the same handler without settleProviderEntered (ACK-none path).
    expect(shutdownCalls[0]).toEqual({
      reason: shutdownReason,
      opts: { settleProviderEntered: true },
    });
    expect(shutdownCalls.filter((call) => call.opts?.settleProviderEntered === true)).toHaveLength(1);
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);
    expect(Number(readFileSync(bashStartCountFile, "utf8")) || 0).toBe(1);
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(88);
    expect(postRuntimeNotice).toHaveBeenCalledTimes(1);
    const noticeOrder = postRuntimeNotice.mock.invocationCallOrder[0];
    const ackOrder = ackEntry.mock.invocationCallOrder[0];
    expect(noticeOrder as number).toBeLessThan(ackOrder as number);
    // Deferred start receipt must not adopt/resurrect after manager drain.
    expect(sm.totalCount).toBe(0);
    expect(sm.activeCount).toBe(0);
  });

  it("deferred resume race: manager shutdown settles accepted token without resume adoption", async () => {
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice-pi-resume" });
    const sm = makePiSessionRuntime({ specs, ackEntry, postRuntimeNotice });

    await sm.dispatch(mockEntry({ id: 70, chatId: "chat-pi-resume-race", messageId: "msg-first", content: "first" }));
    expect(ackEntry).toHaveBeenCalledWith(70);
    await sm.handleCommand("chat-pi-resume-race", "session:suspend");

    setPiTestMode("bash_hold_until_abort");
    writeFileSync(bashStartFile, "0");
    writeFileSync(bashStartCountFile, "0");
    const promptsBeforeResume = Number(readFileSync(promptCountFile, "utf8")) || 0;

    const resumePromise = sm.dispatch(
      mockEntry({ id: 71, chatId: "chat-pi-resume-race", messageId: "msg-resume", content: "run sleep" }),
    );
    await vi.waitFor(() => expect(Number(readFileSync(bashStartFile, "utf8")) || 0).toBe(1));
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(promptsBeforeResume + 1);

    await sm.shutdown("client_switch_interrupted");
    await resumePromise;

    expect(ackEntry).toHaveBeenCalledWith(71);
    expect(ackEntry.mock.calls.filter((call) => call[0] === 71)).toHaveLength(1);
    expect(postRuntimeNotice).toHaveBeenCalledTimes(1);
    const noticeOrder = postRuntimeNotice.mock.invocationCallOrder[0];
    const ack71Index = ackEntry.mock.calls.findIndex((call) => call[0] === 71);
    const ack71Order = ackEntry.mock.invocationCallOrder[ack71Index];
    expect(noticeOrder as number).toBeLessThan(ack71Order as number);
    expect(Number(readFileSync(bashStartCountFile, "utf8")) || 0).toBe(1);
    expect(sm.totalCount).toBe(0);
    expect(sm.activeCount).toBe(0);
  });

  it("graceful manager shutdown during pre-provider prompt rejection leaves zero ACK and no prompt write", async () => {
    setPiTestMode("preflight_capacity");
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice-unused" });
    const sdk = {
      serverUrl: "https://first-tree.test",
      register: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue({ id: "msg-reply" }),
      postRuntimeNotice,
      sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
      getChatContext: vi.fn().mockResolvedValue(null),
    } as unknown as FirstTreeHubSDK;

    let pendingSleep: { resolve: (value: boolean) => void } | null = null;
    const gatedSleep: PiRetrySleep = async (_delayMs, signal) => {
      if (signal.aborted) return false;
      return await new Promise<boolean>((resolve) => {
        const onAbort = () => {
          pendingSleep = null;
          resolve(false);
        };
        pendingSleep = { resolve };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    };
    const sm = new SessionRuntime({
      session: {
        idle_timeout: 300,
        max_sessions: 10,
        working_grace_seconds: 3600,
        reconcile_interval_seconds: 300,
      },
      concurrency: 5,
      handlerFactory: () =>
        createPiHandler({
          workspaceRoot,
          agentName: "pi-custody-test-agent",
          runtimeProvider: "pi",
          agentConfigCache: cache(runtimeConfig()),
          piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
          providerProcessSupervisor: createSyntheticSupervisor(specs),
          piRetrySleep: gatedSleep,
        }),
      handlerConfig: { workspaceRoot, agentName: "pi-custody-test-agent", runtimeProvider: "pi" },
      resolveContextTreeBinding: async () => null,
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
      ackEntry,
      agentConfigCache: cache(runtimeConfig()),
    });

    const entry = mockEntry({
      id: 91,
      chatId: "chat-pi-preprovider",
      messageId: "msg-pi-preprovider",
      content: "blocked",
    });
    const dispatchPromise = sm.dispatch(entry);
    await vi.waitFor(() => expect(pendingSleep).not.toBeNull());
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);
    expect(ackEntry).not.toHaveBeenCalled();

    await sm.shutdown();
    await dispatchPromise;

    expect(ackEntry).not.toHaveBeenCalled();
    // Prompt was attempted once before preflight rejection; shutdown must not
    // invent a second provider write while leaving custody recoverable.
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);
    expect(pendingSleep).toBeNull();
  });

  it("deferred start after shutdown rejects non-terminal ctx mutations while notice-before-ACK settles", async () => {
    let releaseStart: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    let inFlightStart: Promise<void> | null = null;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const sessionEvents: SessionEvent[] = [];
    const registryPath = join(workspaceRoot, "sessions-deferred.json");
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice-deferred" });
    const forwardCalls: string[] = [];
    const mutationCalls: string[] = [];

    const deferredHandler: AgentHandler = {
      start: async (message, ctx, token) => {
        let resolveInFlight: (() => void) | undefined;
        inFlightStart = new Promise<void>((resolve) => {
          resolveInFlight = resolve;
        });
        try {
          signalStarted?.();
          await gate;
          // Shutdown fence is up — these mutations must be rejected / no-ops.
          ctx.replaceSessionId?.("should-not-persist", "deferred_probe");
          mutationCalls.push("replaceSessionId");
          ctx.failSessionForRecovery?.("deferred_probe", "should-not-persist");
          mutationCalls.push("failSessionForRecovery");
          ctx.retryTurn(message, "deferred_probe_retry");
          mutationCalls.push("retryTurn");
          ctx.markMessagesConsumed(message);
          mutationCalls.push("markMessagesConsumed");
          ctx.recordProviderActivity();
          mutationCalls.push("recordProviderActivity");
          await ctx.forwardResult("deferred probe forward");
          forwardCalls.push("forwardResult");
          ctx.emitEvent({ kind: "assistant_text", payload: { text: "deferred probe" } });
          mutationCalls.push("assistant_text");
          ctx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
          mutationCalls.push("turn_end");

          // Narrow drain path: terminal provider-failure event + token settle.
          ctx.emitEvent({
            kind: "error",
            payload: {
              source: "runtime",
              message: encodeProviderRetryEventMessage({
                event: "provider_failure_terminal",
                provider: "pi",
                scope: "provider_turn",
                category: "unknown",
                reasonCode: "unsafe_replay",
                replaySafety: "unsafe",
                userSeverity: "error",
                messagePreview: "deferred drain settle",
              }),
            },
          });
          if (!token) throw new Error("expected delivery token");
          await token.complete([message], {
            status: "error",
            completion: "consumed",
            reason: "unsafe_replay",
          });
          return { sessionId: "should-not-adopt", route: { kind: "owned", mode: "processing" } };
        } finally {
          resolveInFlight?.();
        }
      },
      resume: async () => ({ sessionId: "unused", route: null }),
      inject: () => ({ kind: "rejected", reason: "no_active_context", retryable: true }),
      suspend: async () => {},
      // Mirror Pi: release the deferred start and wait for notice+ACK before
      // SessionRuntime invalidates the settlement lease.
      shutdown: async () => {
        releaseStart?.();
        await inFlightStart;
      },
    };

    const sm = new SessionRuntime({
      session: {
        idle_timeout: 300,
        max_sessions: 10,
        working_grace_seconds: 3600,
        reconcile_interval_seconds: 300,
      },
      concurrency: 5,
      handlerFactory: () => deferredHandler,
      handlerConfig: { workspaceRoot, agentName: "pi-custody-test-agent", runtimeProvider: "pi" },
      resolveContextTreeBinding: async () => null,
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk: {
        serverUrl: "https://first-tree.test",
        register: vi.fn(),
        sendMessage: vi.fn().mockResolvedValue({ id: "msg-reply" }),
        postRuntimeNotice,
        sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
        getChatContext: vi.fn().mockResolvedValue(null),
      } as unknown as FirstTreeHubSDK,
      log: silentLogger(),
      ackEntry,
      registryPath,
      onSessionEvent: (_chatId, event) => void sessionEvents.push(event),
      agentConfigCache: cache(runtimeConfig()),
    });

    const dispatchPromise = sm.dispatch(
      mockEntry({ id: 92, chatId: "chat-deferred-mutate", messageId: "msg-deferred", content: "go" }),
    );
    await started;
    await sm.shutdown("client_switch_interrupted");
    await dispatchPromise;

    expect(ackEntry).toHaveBeenCalledWith(92);
    expect(postRuntimeNotice).toHaveBeenCalledTimes(1);
    const noticeOrder = postRuntimeNotice.mock.invocationCallOrder[0];
    const ackOrder = ackEntry.mock.invocationCallOrder[0];
    expect(noticeOrder as number).toBeLessThan(ackOrder as number);
    // Non-terminal session events must not cross the drain fence.
    expect(sessionEvents.some((event) => event.kind === "assistant_text")).toBe(false);
    expect(sessionEvents.some((event) => event.kind === "turn_end")).toBe(false);
    expect(
      sessionEvents.some(
        (event) => event.kind === "error" && JSON.stringify(event.payload).includes("provider_failure_terminal"),
      ),
    ).toBe(true);
    // Unadopted provider session id must not land in the registry mid-drain.
    if (existsSync(registryPath)) {
      const raw = JSON.parse(readFileSync(registryPath, "utf8")) as {
        entries?: Record<string, { claudeSessionId?: string }>;
      };
      const ids = Object.values(raw.entries ?? {}).map((entry) => entry.claudeSessionId);
      expect(ids).not.toContain("should-not-persist");
      expect(ids).not.toContain("should-not-adopt");
    }
    expect(forwardCalls).toEqual(["forwardResult"]);
    expect(mutationCalls.length).toBeGreaterThan(0);
    expect(sm.totalCount).toBe(0);
    expect(sm.activeCount).toBe(0);
  });

  it("prompt write withheld + unsafe tool start: manager shutdown settles once without late mutation", async () => {
    setPiTestMode("prompt_write_tool_no_response");
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice-write-gap" });
    const sm = makePiSessionRuntime({ specs, ackEntry, postRuntimeNotice });

    const dispatchPromise = sm.dispatch(
      mockEntry({
        id: 93,
        chatId: "chat-pi-write-gap",
        messageId: "msg-pi-write-gap",
        content: "run sleep",
      }),
    );
    await vi.waitFor(() => expect(Number(readFileSync(bashStartFile, "utf8")) || 0).toBe(1));
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);

    await sm.shutdown("agent_runtime_switch");
    await dispatchPromise;

    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);
    expect(Number(readFileSync(bashStartCountFile, "utf8")) || 0).toBe(1);
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(93);
    expect(postRuntimeNotice).toHaveBeenCalledTimes(1);
    expect(postRuntimeNotice.mock.invocationCallOrder[0] as number).toBeLessThan(
      ackEntry.mock.invocationCallOrder[0] as number,
    );
    expect(sm.totalCount).toBe(0);
    expect(sm.activeCount).toBe(0);
  });

  it("prompt accepted with no first event: manager shutdown aborts and settles without replay", async () => {
    setPiTestMode("prompt_accepted_no_events");
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice-no-events" });
    const sm = makePiSessionRuntime({ specs, ackEntry, postRuntimeNotice });

    const dispatchPromise = sm.dispatch(
      mockEntry({
        id: 94,
        chatId: "chat-pi-no-events",
        messageId: "msg-pi-no-events",
        content: "hello",
      }),
    );
    await vi.waitFor(() => expect(Number(readFileSync(bashStartFile, "utf8")) || 0).toBe(1));
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);

    await sm.shutdown("runtime switched by server");
    await dispatchPromise;

    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);
    expect(ackEntry).toHaveBeenCalledWith(94);
    expect(postRuntimeNotice).toHaveBeenCalledTimes(1);
    expect(postRuntimeNotice.mock.invocationCallOrder[0] as number).toBeLessThan(
      ackEntry.mock.invocationCallOrder[0] as number,
    );
    expect(sm.totalCount).toBe(0);
    expect(sm.activeCount).toBe(0);
  });

  it("deferred start during operator suspend rejects non-terminal ctx mutations while notice-before-ACK settles", async () => {
    let releaseStart: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    let inFlightStart: Promise<void> | null = null;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const sessionEvents: SessionEvent[] = [];
    const registryPath = join(workspaceRoot, "sessions-operator-suspend-deferred.json");
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice-operator-deferred" });
    const forwardCalls: string[] = [];
    const mutationCalls: string[] = [];

    const deferredHandler: AgentHandler = {
      start: async (message, ctx, token) => {
        let resolveInFlight: (() => void) | undefined;
        inFlightStart = new Promise<void>((resolve) => {
          resolveInFlight = resolve;
        });
        try {
          // Mark provider-entered so prepareOperatorSuspend can resolve the prefix
          // even if token.complete races the settlement lease edge.
          token?.processingStarted([message]);
          signalStarted?.();
          await gate;
          // Operator-suspend settlement lease is open; ordinary mutations must not.
          ctx.replaceSessionId?.("should-not-persist-suspend", "operator_suspend_probe");
          mutationCalls.push("replaceSessionId");
          ctx.failSessionForRecovery?.("operator_suspend_probe", "should-not-persist-suspend");
          mutationCalls.push("failSessionForRecovery");
          ctx.retryTurn(message, "operator_suspend_probe_retry");
          mutationCalls.push("retryTurn");
          ctx.markMessagesConsumed(message);
          mutationCalls.push("markMessagesConsumed");
          ctx.recordProviderActivity();
          mutationCalls.push("recordProviderActivity");
          await ctx.forwardResult("operator suspend probe forward");
          forwardCalls.push("forwardResult");
          ctx.emitEvent({ kind: "assistant_text", payload: { text: "operator suspend probe" } });
          mutationCalls.push("assistant_text");
          ctx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
          mutationCalls.push("turn_end");

          ctx.emitEvent({
            kind: "error",
            payload: {
              source: "runtime",
              message: encodeProviderRetryEventMessage({
                event: "provider_failure_terminal",
                provider: "pi",
                scope: "provider_turn",
                category: "unknown",
                reasonCode: "unsafe_replay",
                replaySafety: "unsafe",
                userSeverity: "error",
                messagePreview: "operator suspend drain settle",
              }),
            },
          });
          if (!token) throw new Error("expected delivery token");
          await token.complete([message], {
            status: "error",
            completion: "consumed",
            reason: "unsafe_replay",
          });
          return { sessionId: "should-not-adopt-suspend", route: { kind: "owned", mode: "processing" } };
        } finally {
          resolveInFlight?.();
        }
      },
      resume: async () => ({ sessionId: "unused", route: null }),
      inject: () => ({ kind: "rejected", reason: "no_active_context", retryable: true }),
      // Mirror Pi operator-suspend settle: release the deferred start and join
      // notice+ACK before SessionRuntime invalidates the settlement lease.
      suspend: async (_reason, opts) => {
        if (opts?.settleProviderEntered === true) {
          releaseStart?.();
          await inFlightStart;
        }
      },
      shutdown: async () => {},
    };

    const sm = new SessionRuntime({
      session: {
        idle_timeout: 300,
        max_sessions: 10,
        working_grace_seconds: 3600,
        reconcile_interval_seconds: 300,
      },
      concurrency: 5,
      handlerFactory: () => deferredHandler,
      handlerConfig: { workspaceRoot, agentName: "pi-custody-test-agent", runtimeProvider: "pi" },
      resolveContextTreeBinding: async () => null,
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk: {
        serverUrl: "https://first-tree.test",
        register: vi.fn(),
        sendMessage: vi.fn().mockResolvedValue({ id: "msg-reply" }),
        postRuntimeNotice,
        sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
        getChatContext: vi.fn().mockResolvedValue(null),
      } as unknown as FirstTreeHubSDK,
      log: silentLogger(),
      ackEntry,
      registryPath,
      onSessionEvent: (_chatId, event) => void sessionEvents.push(event),
      agentConfigCache: cache(runtimeConfig()),
    });

    const chatId = "chat-operator-suspend-deferred-mutate";
    const dispatchPromise = sm.dispatch(
      mockEntry({ id: 97, chatId, messageId: "msg-operator-suspend-deferred", content: "go" }),
    );
    await started;
    await sm.handleCommand(chatId, "session:suspend");
    const suspending = (
      sm as unknown as { projection: { sessions: Map<string, { suspending: Promise<void> | null }> } }
    ).projection.sessions.get(chatId)?.suspending;
    await Promise.all([suspending ?? Promise.resolve(), dispatchPromise]);

    expect(ackEntry).toHaveBeenCalledWith(97);
    expect(ackEntry.mock.calls.filter((call) => call[0] === 97)).toHaveLength(1);
    expect(postRuntimeNotice).toHaveBeenCalledTimes(1);
    expect(postRuntimeNotice.mock.invocationCallOrder[0] as number).toBeLessThan(
      ackEntry.mock.invocationCallOrder[0] as number,
    );
    expect(sessionEvents.some((event) => event.kind === "assistant_text")).toBe(false);
    expect(sessionEvents.some((event) => event.kind === "turn_end")).toBe(false);
    expect(
      sessionEvents.some(
        (event) => event.kind === "error" && JSON.stringify(event.payload).includes("provider_failure_terminal"),
      ),
    ).toBe(true);
    if (existsSync(registryPath)) {
      const raw = JSON.parse(readFileSync(registryPath, "utf8")) as {
        entries?: Record<string, { claudeSessionId?: string }>;
      };
      const ids = Object.values(raw.entries ?? {}).map((entry) => entry.claudeSessionId);
      expect(ids).not.toContain("should-not-persist-suspend");
      expect(ids).not.toContain("should-not-adopt-suspend");
    }
    expect(forwardCalls).toEqual(["forwardResult"]);
    expect(mutationCalls.length).toBeGreaterThan(0);
    expect(sm.activeCount).toBe(0);

    await sm.shutdown();
  });

  it("operator suspend after prompt write + unsafe tool settles once; resume cannot replay", async () => {
    setPiTestMode("prompt_write_tool_no_response");
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice-operator-suspend" });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const suspendCalls: Array<{ reason?: string; opts?: { settleProviderEntered?: boolean } }> = [];
    const sm = makePiSessionRuntime({
      specs,
      ackEntry,
      postRuntimeNotice,
      recoverChat,
      onHandler: (handler) => {
        const original = handler.suspend.bind(handler);
        handler.suspend = async (reason, opts) => {
          suspendCalls.push({ reason, opts });
          return original(reason, opts);
        };
      },
    });

    const chatId = "chat-pi-operator-suspend-write";
    const dispatchPromise = sm.dispatch(
      mockEntry({
        id: 96,
        chatId,
        messageId: "msg-pi-operator-suspend-write",
        content: "run sleep",
      }),
    );
    await vi.waitFor(() => expect(Number(readFileSync(bashStartFile, "utf8")) || 0).toBe(1));
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);
    expect(Number(readFileSync(bashStartCountFile, "utf8")) || 0).toBe(1);

    await sm.handleCommand(chatId, "session:suspend");
    const suspending = (
      sm as unknown as { projection: { sessions: Map<string, { suspending: Promise<void> | null }> } }
    ).projection.sessions.get(chatId)?.suspending;
    await Promise.all([suspending ?? Promise.resolve(), dispatchPromise]);

    expect(suspendCalls.some((call) => call.opts?.settleProviderEntered === true)).toBe(true);
    expect(ackEntry).toHaveBeenCalledWith(96);
    expect(ackEntry.mock.calls.filter((call) => call[0] === 96)).toHaveLength(1);
    expect(postRuntimeNotice).toHaveBeenCalledTimes(1);
    expect(postRuntimeNotice.mock.invocationCallOrder[0] as number).toBeLessThan(
      ackEntry.mock.invocationCallOrder[0] as number,
    );
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);
    expect(Number(readFileSync(bashStartCountFile, "utf8")) || 0).toBe(1);
    // Settled prefix leaves no recovery debt for the server to redeliver/replay.
    expect(recoverChat).not.toHaveBeenCalled();

    // Control resume (no inbox input) must not create prompt/tool #2.
    await sm.handleCommand(chatId, "session:resume");
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);
    expect(Number(readFileSync(bashStartCountFile, "utf8")) || 0).toBe(1);
    expect(ackEntry.mock.calls.filter((call) => call[0] === 96)).toHaveLength(1);
    expect(recoverChat).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("operator suspend before prompt write: zero prompt writes and no ACK", async () => {
    let releaseRefresh: (() => void) | undefined;
    let signalRefresh: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      signalRefresh = resolve;
    });
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const config = runtimeConfig();
    const gatedCache: AgentConfigCache = {
      get: () => config,
      refresh: async () => {
        signalRefresh?.();
        await refreshGate;
        return config;
      },
      refreshIfNewer: async () => config,
      updateSdk: () => {},
      updateUrls: () => {},
      allReferencedUrls: () => new Set(),
      forget: () => {},
    };
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "unused" });
    const sm = new SessionRuntime({
      session: {
        idle_timeout: 300,
        max_sessions: 10,
        working_grace_seconds: 3600,
        reconcile_interval_seconds: 300,
      },
      concurrency: 5,
      handlerFactory: () =>
        createPiHandler({
          workspaceRoot,
          agentName: "pi-custody-test-agent",
          runtimeProvider: "pi",
          agentConfigCache: gatedCache,
          piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
          providerProcessSupervisor: createSyntheticSupervisor(specs),
        }),
      handlerConfig: { workspaceRoot, agentName: "pi-custody-test-agent", runtimeProvider: "pi" },
      resolveContextTreeBinding: async () => null,
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk: {
        serverUrl: "https://first-tree.test",
        register: vi.fn(),
        sendMessage: vi.fn().mockResolvedValue({ id: "msg-reply" }),
        postRuntimeNotice,
        sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
        getChatContext: vi.fn().mockResolvedValue(null),
      } as unknown as FirstTreeHubSDK,
      log: silentLogger(),
      ackEntry,
      agentConfigCache: gatedCache,
    });

    const chatId = "chat-pi-operator-suspend-before-write";
    const dispatchPromise = sm.dispatch(
      mockEntry({
        id: 98,
        chatId,
        messageId: "msg-pi-operator-suspend-before-write",
        content: "blocked early",
      }),
    );
    await refreshStarted;
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(0);

    await sm.handleCommand(chatId, "session:suspend");
    releaseRefresh?.();
    await dispatchPromise;

    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(0);
    expect(ackEntry).not.toHaveBeenCalled();
    expect(postRuntimeNotice).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("active inject + operator suspend: notice before ACK; resume cannot replay", async () => {
    // QA BUG-pi-active-inject-suspend-acks-without-durable-notice: later inject
    // must settle through DeliveryToken (settlement lease), not prepareOperatorSuspend
    // force-ACK without a chat-visible runtime notice.
    setPiTestMode("happy");
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice-active-inject" });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = makePiSessionRuntime({ specs, ackEntry, postRuntimeNotice, recoverChat });
    const chatId = "chat-pi-active-inject-suspend";

    await sm.dispatch(
      mockEntry({
        id: 110,
        chatId,
        messageId: "msg-pi-active-inject-establish",
        content: "establish",
      }),
    );
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(1);
    expect(ackEntry).toHaveBeenCalledWith(110);

    setPiTestMode("prompt_write_tool_no_response");
    writeFileSync(bashStartFile, "0");
    writeFileSync(bashStartCountFile, "0");
    const promptsBeforeInject = Number(readFileSync(promptCountFile, "utf8")) || 0;

    const injectPromise = sm.dispatch(
      mockEntry({
        id: 111,
        chatId,
        messageId: "msg-pi-active-inject-unsafe",
        content: "run sleep",
      }),
    );
    await vi.waitFor(() => expect(Number(readFileSync(bashStartFile, "utf8")) || 0).toBe(1));
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(promptsBeforeInject + 1);
    expect(Number(readFileSync(bashStartCountFile, "utf8")) || 0).toBe(1);

    await sm.handleCommand(chatId, "session:suspend");
    const suspending = (
      sm as unknown as { projection: { sessions: Map<string, { suspending: Promise<void> | null }> } }
    ).projection.sessions.get(chatId)?.suspending;
    await Promise.all([suspending ?? Promise.resolve(), injectPromise]);

    expect(postRuntimeNotice).toHaveBeenCalledTimes(1);
    expect(ackEntry.mock.calls.filter((call) => call[0] === 111)).toHaveLength(1);
    const injectAckIndex = ackEntry.mock.calls.findIndex((call) => call[0] === 111);
    expect(postRuntimeNotice.mock.invocationCallOrder[0] as number).toBeLessThan(
      ackEntry.mock.invocationCallOrder[injectAckIndex] as number,
    );
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(promptsBeforeInject + 1);
    expect(Number(readFileSync(bashStartCountFile, "utf8")) || 0).toBe(1);
    expect(recoverChat).not.toHaveBeenCalled();

    await sm.handleCommand(chatId, "session:resume");
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(promptsBeforeInject + 1);
    expect(Number(readFileSync(bashStartCountFile, "utf8")) || 0).toBe(1);
    expect(ackEntry.mock.calls.filter((call) => call[0] === 111)).toHaveLength(1);
    expect(recoverChat).not.toHaveBeenCalled();

    await sm.shutdown();
  });

  it("active inject + operator suspend: notice failure then recovery posts notice before only ACK", async () => {
    setPiTestMode("happy");
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    let releaseRecover: (() => void) | undefined;
    const recoverGate = new Promise<void>((resolve) => {
      releaseRecover = resolve;
    });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockImplementation(async () => {
      await recoverGate;
    });
    const postRuntimeNotice = vi
      .fn()
      .mockRejectedValueOnce(new Error("runtime notice store offline"))
      .mockResolvedValue({ id: "runtime-notice-after-recovery" });
    const sm = makePiSessionRuntime({ specs, ackEntry, postRuntimeNotice, recoverChat });
    const chatId = "chat-pi-active-inject-notice-recover";
    const injectEntry = mockEntry({
      id: 113,
      chatId,
      messageId: "msg-pi-active-inject-notice-fail",
      content: "run sleep",
    });

    await sm.dispatch(
      mockEntry({
        id: 112,
        chatId,
        messageId: "msg-pi-active-inject-notice-establish",
        content: "establish",
      }),
    );
    expect(ackEntry).toHaveBeenCalledWith(112);

    setPiTestMode("prompt_write_tool_no_response");
    writeFileSync(bashStartFile, "0");
    writeFileSync(bashStartCountFile, "0");
    const promptsBeforeInject = Number(readFileSync(promptCountFile, "utf8")) || 0;
    const injectPromise = sm.dispatch(injectEntry);
    await vi.waitFor(() => expect(Number(readFileSync(bashStartFile, "utf8")) || 0).toBe(1));

    await sm.handleCommand(chatId, "session:suspend");
    const suspending = (
      sm as unknown as { projection: { sessions: Map<string, { suspending: Promise<void> | null }> } }
    ).projection.sessions.get(chatId)?.suspending;
    await Promise.all([suspending ?? Promise.resolve(), injectPromise]);

    expect(postRuntimeNotice).toHaveBeenCalledTimes(1);
    expect(ackEntry.mock.calls.filter((call) => call[0] === 113)).toHaveLength(0);
    expect(recoverChat).toHaveBeenCalledWith(chatId);
    expect(
      (sm as unknown as { inboxDelivery: { hasRecoveryDebt(chatId: string): boolean } }).inboxDelivery.hasRecoveryDebt(
        chatId,
      ),
    ).toBe(true);

    releaseRecover?.();
    await vi.waitFor(() =>
      expect(
        (
          sm as unknown as { inboxDelivery: { hasRecoveryDebt(chatId: string): boolean } }
        ).inboxDelivery.hasRecoveryDebt(chatId),
      ).toBe(false),
    );

    // Server-faithful redelivery of the same entry — must retry notice, not Pi.
    await sm.dispatch(injectEntry);
    await vi.waitFor(() => expect(ackEntry.mock.calls.filter((call) => call[0] === 113)).toHaveLength(1));

    expect(postRuntimeNotice).toHaveBeenCalledTimes(2);
    expect(postRuntimeNotice.mock.invocationCallOrder[1] as number).toBeLessThan(
      ackEntry.mock.invocationCallOrder[ackEntry.mock.calls.findIndex((call) => call[0] === 113)] as number,
    );
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(promptsBeforeInject + 1);
    expect(Number(readFileSync(bashStartCountFile, "utf8")) || 0).toBe(1);

    await sm.shutdown();
  });

  it("active inject + operator suspend: repeated notice failure requests recovery #2 then ACKs only after notice #3", async () => {
    setPiTestMode("happy");
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    let releaseRecover: (() => void) | undefined;
    let recoverGate = new Promise<void>((resolve) => {
      releaseRecover = resolve;
    });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockImplementation(async () => {
      await recoverGate;
    });
    // Notice #1 (suspend) fails; #2 (after recovery #1) fails; #3 (after recovery #2) succeeds.
    const postRuntimeNotice = vi
      .fn()
      .mockRejectedValueOnce(new Error("runtime notice store offline"))
      .mockRejectedValueOnce(new Error("runtime notice store still offline"))
      .mockResolvedValue({ id: "runtime-notice-after-recovery-2" });
    const sm = makePiSessionRuntime({ specs, ackEntry, postRuntimeNotice, recoverChat });
    const chatId = "chat-pi-active-inject-notice-recover-twice";
    const injectEntry = mockEntry({
      id: 119,
      chatId,
      messageId: "msg-pi-active-inject-notice-recover-twice",
      content: "run sleep",
    });
    const hasDebt = () =>
      (sm as unknown as { inboxDelivery: { hasRecoveryDebt(chatId: string): boolean } }).inboxDelivery.hasRecoveryDebt(
        chatId,
      );

    await sm.dispatch(
      mockEntry({
        id: 118,
        chatId,
        messageId: "msg-pi-active-inject-notice-recover-twice-establish",
        content: "establish",
      }),
    );

    setPiTestMode("prompt_write_tool_no_response");
    writeFileSync(bashStartFile, "0");
    writeFileSync(bashStartCountFile, "0");
    const promptsBeforeInject = Number(readFileSync(promptCountFile, "utf8")) || 0;
    const injectPromise = sm.dispatch(injectEntry);
    await vi.waitFor(() => expect(Number(readFileSync(bashStartFile, "utf8")) || 0).toBe(1));

    await sm.handleCommand(chatId, "session:suspend");
    const suspending = (
      sm as unknown as { projection: { sessions: Map<string, { suspending: Promise<void> | null }> } }
    ).projection.sessions.get(chatId)?.suspending;
    await Promise.all([suspending ?? Promise.resolve(), injectPromise]);

    expect(postRuntimeNotice).toHaveBeenCalledTimes(1);
    expect(ackEntry.mock.calls.filter((call) => call[0] === 119)).toHaveLength(0);
    expect(recoverChat).toHaveBeenCalledTimes(1);
    expect(hasDebt()).toBe(true);

    releaseRecover?.();
    await vi.waitFor(() => expect(hasDebt()).toBe(false));

    // Redelivery after recovery #1 — notice #2 fails; must not ACK or re-enter Pi.
    await sm.dispatch(injectEntry);
    await vi.waitFor(() => expect(postRuntimeNotice).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    await Promise.resolve();
    expect(ackEntry.mock.calls.filter((call) => call[0] === 119)).toHaveLength(0);
    expect(hasDebt()).toBe(true);
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(promptsBeforeInject + 1);
    expect(Number(readFileSync(bashStartCountFile, "utf8")) || 0).toBe(1);

    // Next dispatch must request recovery #2 (window retired after new debt).
    recoverGate = new Promise<void>((resolve) => {
      releaseRecover = resolve;
    });
    const recovery2Dispatch = sm.dispatch(injectEntry);
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledTimes(2));
    expect(ackEntry.mock.calls.filter((call) => call[0] === 119)).toHaveLength(0);

    releaseRecover?.();
    await recovery2Dispatch;
    await vi.waitFor(() => expect(hasDebt()).toBe(false));

    // Redelivery after recovery #2 — notice #3 succeeds; sole ACK after notice.
    await sm.dispatch(injectEntry);
    await vi.waitFor(() => expect(ackEntry.mock.calls.filter((call) => call[0] === 119)).toHaveLength(1));
    expect(postRuntimeNotice).toHaveBeenCalledTimes(3);
    expect(postRuntimeNotice.mock.invocationCallOrder[2] as number).toBeLessThan(
      ackEntry.mock.invocationCallOrder[ackEntry.mock.calls.findIndex((call) => call[0] === 119)] as number,
    );
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(promptsBeforeInject + 1);
    expect(Number(readFileSync(bashStartCountFile, "utf8")) || 0).toBe(1);
    expect(recoverChat).toHaveBeenCalledTimes(2);

    await sm.shutdown();
  });

  it("active inject + operator suspend: persistent notice failure keeps every recovery requestable", async () => {
    setPiTestMode("happy");
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    let releaseRecover: (() => void) | undefined;
    let recoverGate = new Promise<void>((resolve) => {
      releaseRecover = resolve;
    });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockImplementation(async () => {
      await recoverGate;
    });
    const postRuntimeNotice = vi.fn().mockRejectedValue(new Error("runtime notice store offline"));
    const sm = makePiSessionRuntime({ specs, ackEntry, postRuntimeNotice, recoverChat });
    const chatId = "chat-pi-active-inject-notice-fail-persist";
    const injectEntry = mockEntry({
      id: 121,
      chatId,
      messageId: "msg-pi-active-inject-notice-fail-persist",
      content: "run sleep",
    });
    const hasDebt = () =>
      (sm as unknown as { inboxDelivery: { hasRecoveryDebt(chatId: string): boolean } }).inboxDelivery.hasRecoveryDebt(
        chatId,
      );

    await sm.dispatch(
      mockEntry({
        id: 120,
        chatId,
        messageId: "msg-pi-active-inject-notice-fail-persist-establish",
        content: "establish",
      }),
    );

    setPiTestMode("prompt_write_tool_no_response");
    writeFileSync(bashStartFile, "0");
    writeFileSync(bashStartCountFile, "0");
    const promptsBeforeInject = Number(readFileSync(promptCountFile, "utf8")) || 0;
    const injectPromise = sm.dispatch(injectEntry);
    await vi.waitFor(() => expect(Number(readFileSync(bashStartFile, "utf8")) || 0).toBe(1));

    await sm.handleCommand(chatId, "session:suspend");
    const suspending = (
      sm as unknown as { projection: { sessions: Map<string, { suspending: Promise<void> | null }> } }
    ).projection.sessions.get(chatId)?.suspending;
    await Promise.all([suspending ?? Promise.resolve(), injectPromise]);

    expect(ackEntry.mock.calls.filter((call) => call[0] === 121)).toHaveLength(0);
    expect(recoverChat).toHaveBeenCalledTimes(1);
    releaseRecover?.();
    await vi.waitFor(() => expect(hasDebt()).toBe(false));

    // After recovery #1, redelivery notice fails again → debt, no ACK, no Pi replay.
    await sm.dispatch(injectEntry);
    await vi.waitFor(() => expect(postRuntimeNotice.mock.calls.length).toBeGreaterThanOrEqual(2));
    await Promise.resolve();
    await Promise.resolve();
    expect(ackEntry.mock.calls.filter((call) => call[0] === 121)).toHaveLength(0);
    expect(hasDebt()).toBe(true);
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(promptsBeforeInject + 1);
    expect(Number(readFileSync(bashStartCountFile, "utf8")) || 0).toBe(1);

    // Completed recovery #1 must not swallow recovery #2 on the next dispatch.
    recoverGate = new Promise<void>((resolve) => {
      releaseRecover = resolve;
    });
    const recovery2Dispatch = sm.dispatch(injectEntry);
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledTimes(2));
    expect(ackEntry.mock.calls.filter((call) => call[0] === 121)).toHaveLength(0);

    releaseRecover?.();
    await recovery2Dispatch;
    await vi.waitFor(() => expect(hasDebt()).toBe(false));

    // Recovery #2 completes; next redelivery notice still fails → still requestable.
    await sm.dispatch(injectEntry);
    await vi.waitFor(() => expect(postRuntimeNotice.mock.calls.length).toBeGreaterThanOrEqual(3));
    await Promise.resolve();
    await Promise.resolve();
    expect(ackEntry.mock.calls.filter((call) => call[0] === 121)).toHaveLength(0);
    expect(hasDebt()).toBe(true);

    recoverGate = new Promise<void>((resolve) => {
      releaseRecover = resolve;
    });
    const recovery3Dispatch = sm.dispatch(injectEntry);
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledTimes(3));
    expect(ackEntry.mock.calls.filter((call) => call[0] === 121)).toHaveLength(0);
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(promptsBeforeInject + 1);
    expect(Number(readFileSync(bashStartCountFile, "utf8")) || 0).toBe(1);

    releaseRecover?.();
    await recovery3Dispatch;

    await sm.shutdown();
  });

  it("active inject on a healthy RPC bypasses config refresh and remains routable", async () => {
    setPiTestMode("happy");
    let refreshCount = 0;
    const config = runtimeConfig();
    const gatedCache: AgentConfigCache = {
      get: () => config,
      refresh: async () => {
        refreshCount++;
        return config;
      },
      refreshIfNewer: async () => config,
      updateSdk: () => {},
      updateUrls: () => {},
      allReferencedUrls: () => new Set(),
      forget: () => {},
    };
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "unused" });
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockResolvedValue(undefined);
    const sm = new SessionRuntime({
      session: {
        idle_timeout: 300,
        max_sessions: 10,
        working_grace_seconds: 3600,
        reconcile_interval_seconds: 300,
      },
      concurrency: 5,
      handlerFactory: () =>
        createPiHandler({
          workspaceRoot,
          agentName: "pi-custody-test-agent",
          runtimeProvider: "pi",
          agentConfigCache: gatedCache,
          piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
          providerProcessSupervisor: createSyntheticSupervisor(specs),
        }),
      handlerConfig: { workspaceRoot, agentName: "pi-custody-test-agent", runtimeProvider: "pi" },
      resolveContextTreeBinding: async () => null,
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk: {
        serverUrl: "https://first-tree.test",
        register: vi.fn(),
        sendMessage: vi.fn().mockResolvedValue({ id: "msg-reply" }),
        postRuntimeNotice,
        sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
        getChatContext: vi.fn().mockResolvedValue(null),
      } as unknown as FirstTreeHubSDK,
      log: silentLogger(),
      ackEntry,
      recoverChat,
      agentConfigCache: gatedCache,
    });
    const chatId = "chat-pi-active-inject-before-write";

    await sm.dispatch(
      mockEntry({
        id: 114,
        chatId,
        messageId: "msg-pi-active-inject-before-establish",
        content: "establish",
      }),
    );
    expect(ackEntry).toHaveBeenCalledWith(114);
    const promptsAfterEstablish = Number(readFileSync(promptCountFile, "utf8")) || 0;

    const injectPromise = sm.dispatch(
      mockEntry({
        id: 115,
        chatId,
        messageId: "msg-pi-active-inject-before-write",
        content: "blocked before write",
      }),
    );
    await injectPromise;
    await vi.waitFor(() => expect(ackEntry.mock.calls.filter((call) => call[0] === 115)).toHaveLength(1));

    expect(refreshCount).toBe(1);
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(promptsAfterEstablish + 1);
    // `main` rewrote this case; the "no operator-facing write happened" leg now
    // watches the dedicated runtime-notice endpoint, which is where a notice
    // goes on this branch.
    expect(postRuntimeNotice).not.toHaveBeenCalled();
    expect(recoverChat).not.toHaveBeenCalled();

    await sm.handleCommand(chatId, "session:suspend");
    await sm.shutdown();
  });

  it("true before-write shutdown control: zero prompt writes, recoverable (no ACK)", async () => {
    let releaseRefresh: (() => void) | undefined;
    let signalRefresh: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => {
      signalRefresh = resolve;
    });
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const config = runtimeConfig();
    const gatedCache: AgentConfigCache = {
      get: () => config,
      refresh: async () => {
        signalRefresh?.();
        await refreshGate;
        return config;
      },
      refreshIfNewer: async () => config,
      updateSdk: () => {},
      updateUrls: () => {},
      allReferencedUrls: () => new Set(),
      forget: () => {},
    };
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "unused" });
    const sm = new SessionRuntime({
      session: {
        idle_timeout: 300,
        max_sessions: 10,
        working_grace_seconds: 3600,
        reconcile_interval_seconds: 300,
      },
      concurrency: 5,
      handlerFactory: () =>
        createPiHandler({
          workspaceRoot,
          agentName: "pi-custody-test-agent",
          runtimeProvider: "pi",
          agentConfigCache: gatedCache,
          piBinaryResolver: () => ({ ok: true, binary: "/host/pi" }),
          providerProcessSupervisor: createSyntheticSupervisor(specs),
        }),
      handlerConfig: { workspaceRoot, agentName: "pi-custody-test-agent", runtimeProvider: "pi" },
      resolveContextTreeBinding: async () => null,
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk: {
        serverUrl: "https://first-tree.test",
        register: vi.fn(),
        sendMessage: vi.fn().mockResolvedValue({ id: "msg-reply" }),
        postRuntimeNotice,
        sendToAgent: vi.fn().mockResolvedValue({ id: "msg-dm" }),
        getChatContext: vi.fn().mockResolvedValue(null),
      } as unknown as FirstTreeHubSDK,
      log: silentLogger(),
      ackEntry,
      agentConfigCache: gatedCache,
    });

    const dispatchPromise = sm.dispatch(
      mockEntry({
        id: 95,
        chatId: "chat-pi-before-write",
        messageId: "msg-pi-before-write",
        content: "blocked early",
      }),
    );
    await refreshStarted;
    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(0);

    await sm.shutdown("operator stop");
    releaseRefresh?.();
    await dispatchPromise;

    expect(Number(readFileSync(promptCountFile, "utf8")) || 0).toBe(0);
    expect(ackEntry).not.toHaveBeenCalled();
    expect(postRuntimeNotice).not.toHaveBeenCalled();
    expect(sm.totalCount).toBe(0);
    expect(sm.activeCount).toBe(0);
  });

  it("live SessionRuntime inject steers while start still awaits agent_settled", async () => {
    setPiTestMode("bash_hold_until_abort");
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice-pi-steer" });
    const sm = makePiSessionRuntime({ specs, ackEntry, postRuntimeNotice });

    const headPromise = sm.dispatch(
      mockEntry({
        id: 201,
        chatId: "chat-pi-live-steer",
        messageId: "msg-head",
        content: "run sleep 60",
      }),
    );
    await vi.waitFor(() => expect(readCount(bashStartFile)).toBe(1));
    expect(readCount(promptCountFile)).toBe(1);
    expect(readCount(steerCountFile)).toBe(0);

    const tailPromise = sm.dispatch(
      mockEntry({
        id: 202,
        chatId: "chat-pi-live-steer",
        messageId: "msg-tail",
        content: "steer correction",
      }),
    );
    await vi.waitFor(() => expect(readCount(steerCountFile)).toBe(1));
    expect(readCount(promptCountFile)).toBe(1);
    expect(ackEntry).not.toHaveBeenCalled();

    await sm.handleCommand("chat-pi-live-steer", "session:suspend");
    await Promise.all([headPromise, tailPromise]);

    expect(readCount(promptCountFile)).toBe(1);
    expect(readCount(steerCountFile)).toBe(1);
    expect(ackEntry).toHaveBeenCalledWith(201);
    expect(ackEntry).toHaveBeenCalledWith(202);
    expect(ackEntry).toHaveBeenCalledTimes(2);
    const ack201 = ackEntry.mock.invocationCallOrder[ackEntry.mock.calls.findIndex((call) => call[0] === 201)];
    const ack202 = ackEntry.mock.invocationCallOrder[ackEntry.mock.calls.findIndex((call) => call[0] === 202)];
    expect(ack201 as number).toBeLessThan(ack202 as number);
    await sm.shutdown();
  });

  it("FIFO defers tails before processingStarted then drains into live steer", async () => {
    // Hold before get_state returns so the head has not written a prompt yet —
    // processingStarted (membership proof) has not fired.
    setPiTestMode("hold_get_state_until_gate");
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice-pi-fifo" });
    const sm = makePiSessionRuntime({ specs, ackEntry, postRuntimeNotice });

    const headPromise = sm.dispatch(
      mockEntry({
        id: 211,
        chatId: "chat-pi-fifo-steer",
        messageId: "msg-head-fifo",
        content: "run sleep 60",
      }),
    );
    await vi.waitFor(() => expect(specs.some((spec) => spec.args.includes("--mode"))).toBe(true));
    expect(readCount(promptCountFile)).toBe(0);

    const tailPromise = sm.dispatch(
      mockEntry({
        id: 212,
        chatId: "chat-pi-fifo-steer",
        messageId: "msg-tail-fifo",
        content: "early correction",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(readCount(steerCountFile)).toBe(0);
    expect(readCount(promptCountFile)).toBe(0);

    writeFileSync(promptGateFile, "1");
    await vi.waitFor(() => expect(readCount(bashStartFile)).toBe(1));
    await vi.waitFor(() => expect(readCount(steerCountFile)).toBe(1));
    expect(readCount(promptCountFile)).toBe(1);
    expect(ackEntry).not.toHaveBeenCalled();

    await sm.handleCommand("chat-pi-fifo-steer", "session:suspend");
    await Promise.all([headPromise, tailPromise]);
    expect(ackEntry).toHaveBeenCalledWith(211);
    expect(ackEntry).toHaveBeenCalledWith(212);
    expect(readCount(promptCountFile)).toBe(1);
    expect(readCount(steerCountFile)).toBe(1);
    await sm.shutdown();
  });

  it("start failure before readiness keeps the deferred tail out of the provider", async () => {
    setPiTestMode("get_state_fail");
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice-pi-prereadiness" });
    const sm = makePiSessionRuntime({ specs, ackEntry, postRuntimeNotice });

    const headPromise = sm.dispatch(
      mockEntry({
        id: 221,
        chatId: "chat-pi-prereadiness-fail",
        messageId: "msg-head-fail",
        content: "start me",
      }),
    );
    // Arrive while start is still failing before any prompt write / membership proof.
    await vi.waitFor(() => expect(specs.some((spec) => spec.args.includes("--mode"))).toBe(true));
    const tailPromise = sm.dispatch(
      mockEntry({
        id: 222,
        chatId: "chat-pi-prereadiness-fail",
        messageId: "msg-tail-fail",
        content: "should stay deferred",
      }),
    );
    await Promise.allSettled([headPromise, tailPromise]);
    // Session start may enter transient retry without a durable notice yet —
    // the invariant under test is that the tail never crosses the provider.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(readCount(promptCountFile)).toBe(0);
    expect(readCount(steerCountFile)).toBe(0);
    expect(ackEntry.mock.calls.filter((call) => call[0] === 222)).toHaveLength(0);

    await sm.shutdown();
    expect(readCount(promptCountFile)).toBe(0);
    expect(readCount(steerCountFile)).toBe(0);
    expect(ackEntry.mock.calls.filter((call) => call[0] === 222)).toHaveLength(0);
  });

  it("suspend before readiness clears deferred inject and never steers", async () => {
    setPiTestMode("hold_get_state_until_gate");
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice-pi-suspend-defer" });
    const sm = makePiSessionRuntime({ specs, ackEntry, postRuntimeNotice });

    const headPromise = sm.dispatch(
      mockEntry({
        id: 231,
        chatId: "chat-pi-suspend-defer",
        messageId: "msg-head-suspend",
        content: "blocked by gate",
      }),
    );
    await vi.waitFor(() => expect(specs.some((spec) => spec.args.includes("--mode"))).toBe(true));
    const tailPromise = sm.dispatch(
      mockEntry({
        id: 232,
        chatId: "chat-pi-suspend-defer",
        messageId: "msg-tail-suspend",
        content: "deferred then canceled",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(readCount(promptCountFile)).toBe(0);
    expect(readCount(steerCountFile)).toBe(0);

    await sm.handleCommand("chat-pi-suspend-defer", "session:suspend");
    writeFileSync(promptGateFile, "1");
    await Promise.allSettled([headPromise, tailPromise]);

    expect(readCount(steerCountFile)).toBe(0);
    // Gate opened after suspend invalidation — must not create a late prompt/steer.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readCount(steerCountFile)).toBe(0);
    await sm.shutdown();
  });

  it("provider-entered session retry live-injects steer before settlement", async () => {
    setPiTestMode("transient_get_state_once_then_bash_hold");
    writeFileSync(getStateFailRemainFile, "1");
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice-pi-retry-steer" });
    const sm = makePiSessionRuntime({ specs, ackEntry, postRuntimeNotice });

    // First dispatch returns after the transient failure schedules retry — it
    // does not await the winning retry turn. Observe custody via wire counts/ACK.
    void sm.dispatch(
      mockEntry({
        id: 241,
        chatId: "chat-pi-retry-steer",
        messageId: "msg-head-retry",
        content: "run sleep 60",
      }),
    );
    await vi.waitFor(() => expect(readCount(getStateFailRemainFile)).toBe(0), { timeout: 5000 });
    void sm.dispatch(
      mockEntry({
        id: 242,
        chatId: "chat-pi-retry-steer",
        messageId: "msg-tail-retry",
        content: "steer during retry turn",
      }),
    );
    await vi.waitFor(() => expect(readCount(bashStartFile)).toBe(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(readCount(steerCountFile)).toBe(1), { timeout: 5000 });
    expect(readCount(promptCountFile)).toBe(1);
    expect(ackEntry).not.toHaveBeenCalled();

    await sm.handleCommand("chat-pi-retry-steer", "session:suspend");
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledWith(241));
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledWith(242));

    expect(readCount(promptCountFile)).toBe(1);
    expect(readCount(steerCountFile)).toBe(1);
    expect(ackEntry).toHaveBeenCalledTimes(2);
    const ack241 = ackEntry.mock.invocationCallOrder[ackEntry.mock.calls.findIndex((call) => call[0] === 241)];
    const ack242 = ackEntry.mock.invocationCallOrder[ackEntry.mock.calls.findIndex((call) => call[0] === 242)];
    expect(ack241 as number).toBeLessThan(ack242 as number);
    await sm.shutdown();
  });

  it("retry transition defers tails before processingStarted then drains into live steer", async () => {
    setPiTestMode("transient_get_state_once_then_hold_gate");
    writeFileSync(getStateFailRemainFile, "1");
    writeFileSync(promptGateFile, "0");
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice-pi-retry-fifo" });
    const sm = makePiSessionRuntime({ specs, ackEntry, postRuntimeNotice });

    void sm.dispatch(
      mockEntry({
        id: 251,
        chatId: "chat-pi-retry-fifo",
        messageId: "msg-head-retry-fifo",
        content: "run sleep 60",
      }),
    );
    await vi.waitFor(() => expect(readCount(getStateFailRemainFile)).toBe(0), { timeout: 5000 });
    // Winning retry is held before get_state returns — membership not proven yet.
    void sm.dispatch(
      mockEntry({
        id: 252,
        chatId: "chat-pi-retry-fifo",
        messageId: "msg-tail-retry-fifo",
        content: "early during retry",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(readCount(promptCountFile)).toBe(0);
    expect(readCount(steerCountFile)).toBe(0);

    writeFileSync(promptGateFile, "1");
    await vi.waitFor(() => expect(readCount(bashStartFile)).toBe(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(readCount(steerCountFile)).toBe(1), { timeout: 5000 });
    expect(readCount(promptCountFile)).toBe(1);
    expect(ackEntry).not.toHaveBeenCalled();

    await sm.handleCommand("chat-pi-retry-fifo", "session:suspend");
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledWith(251));
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledWith(252));
    expect(readCount(promptCountFile)).toBe(1);
    expect(readCount(steerCountFile)).toBe(1);
    await sm.shutdown();
  });

  it("suspend/resume keeps the persisted Pi session identity across spawns", async () => {
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice-unused" });
    const sm = makePiSessionRuntime({ specs, ackEntry, postRuntimeNotice });

    await sm.dispatch(mockEntry({ id: 301, chatId: "chat-pi-continuity", messageId: "msg-cont-1", content: "first" }));
    expect(ackEntry).toHaveBeenCalledWith(301);
    const firstIds = rpcSessionIds(specs);
    expect(firstIds).toEqual([freshStartPiSessionId("agent-1", "chat-pi-continuity", "msg-cont-1")]);

    await sm.handleCommand("chat-pi-continuity", "session:suspend");
    await sm.dispatch(mockEntry({ id: 302, chatId: "chat-pi-continuity", messageId: "msg-cont-2", content: "second" }));
    expect(ackEntry).toHaveBeenCalledWith(302);
    const allIds = rpcSessionIds(specs);
    expect(allIds).toHaveLength(2);
    // Resume reopens the persisted identity — never a message-2-derived id.
    expect(allIds[1]).toBe(allIds[0]);
    await sm.shutdown();
  });

  it("Reset retires the Pi session: post-Reset delivery mints a fresh provider identity", async () => {
    const registryPath = join(workspaceRoot, "sessions-reset.json");
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice-unused" });
    const sm = makePiSessionRuntime({ specs, ackEntry, postRuntimeNotice, registryPath });

    await sm.dispatch(
      mockEntry({ id: 311, chatId: "chat-pi-reset", messageId: "msg-reset-1", content: "before reset" }),
    );
    expect(ackEntry).toHaveBeenCalledWith(311);
    const oldId = freshStartPiSessionId("agent-1", "chat-pi-reset", "msg-reset-1");
    expect(rpcSessionIds(specs)).toEqual([oldId]);

    // Reset apply resolves only after mapping deletion + Reset tombstone flush.
    await sm.handleCommand("chat-pi-reset", "session:terminate");
    const persisted = JSON.parse(readFileSync(registryPath, "utf8")) as {
      entries: Record<string, unknown>;
      freshStartNonces: Record<string, string>;
    };
    expect(persisted.entries).toEqual({});
    const resetNonce = persisted.freshStartNonces["chat-pi-reset"] ?? "";
    expect(resetNonce.length).toBeGreaterThan(0);

    await sm.dispatch(
      mockEntry({ id: 312, chatId: "chat-pi-reset", messageId: "msg-reset-2", content: "after reset" }),
    );
    expect(ackEntry).toHaveBeenCalledWith(312);
    const allIds = rpcSessionIds(specs);
    expect(allIds).toHaveLength(2);
    // Pi keys its on-disk JSONL transcript by session id: a NEW id means the
    // discarded transcript/model state can never be silently reopened.
    expect(allIds[1]).toBe(freshStartPiSessionId("agent-1", "chat-pi-reset", "msg-reset-2", resetNonce));
    expect(allIds[1]).not.toBe(oldId);
    expect(allIds[1]).not.toBe(freshStartPiSessionId("agent-1", "chat-pi-reset", "msg-reset-2"));
    await sm.shutdown();
  });

  it("redelivery of the same first message keeps one fresh-start identity across transient start retry", async () => {
    setPiTestMode("transient_get_state_once_then_bash_hold");
    writeFileSync(getStateFailRemainFile, "1");
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice-pi-reidentity" });
    const sm = makePiSessionRuntime({ specs, ackEntry, postRuntimeNotice });

    const dispatchPromise = sm.dispatch(
      mockEntry({ id: 321, chatId: "chat-pi-reidentity", messageId: "msg-reidentity", content: "run sleep 60" }),
    );
    await vi.waitFor(() => expect(readCount(bashStartFile)).toBe(1), { timeout: 10_000 });
    // Initial attempt + transient retry each spawned an RPC process, but the
    // SAME uncommitted first row must select the SAME provider session —
    // never a second identity.
    const ids = rpcSessionIds(specs);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(freshStartPiSessionId("agent-1", "chat-pi-reidentity", "msg-reidentity"));
    expect(ids[1]).toBe(ids[0]);

    await sm.handleCommand("chat-pi-reidentity", "session:suspend");
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledWith(321));
    await dispatchPromise;
    await sm.shutdown();
  });

  it("Reset apply rejects on registry-flush failure and retry converges to retirement", async () => {
    const registryPath = join(workspaceRoot, "sessions-reset-flush.json");
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice-unused" });
    const sm = makePiSessionRuntime({ specs, ackEntry, postRuntimeNotice, registryPath });

    await sm.dispatch(
      mockEntry({ id: 331, chatId: "chat-pi-reset-flush", messageId: "msg-flush-1", content: "before reset" }),
    );
    expect(ackEntry).toHaveBeenCalledWith(331);
    const oldId = freshStartPiSessionId("agent-1", "chat-pi-reset-flush", "msg-flush-1");

    const rotateSpy = vi.spyOn(SessionRegistry.prototype, "rotateFreshStartNonce");
    const boom = new Error("disk full");
    vi.spyOn(SessionRegistry.prototype, "flushOrThrow").mockImplementationOnce(() => {
      throw boom;
    });
    // The apply must reject instead of acking over a live mapping; the entry
    // stays retryable (terminatePersistFailures) instead of a false applied.
    await expect(sm.handleCommand("chat-pi-reset-flush", "session:terminate")).rejects.toBe(boom);
    expect(rotateSpy).toHaveBeenCalledWith("chat-pi-reset-flush");
    const pendingNonce = rotateSpy.mock.results[0]?.value as string;
    expect(typeof pendingNonce).toBe("string");

    // Retry converges with the SAME pending nonce: mapping removed + tombstone durable.
    await sm.handleCommand("chat-pi-reset-flush", "session:terminate");
    const persisted = JSON.parse(readFileSync(registryPath, "utf8")) as {
      entries: Record<string, unknown>;
      freshStartNonces: Record<string, string>;
    };
    expect(persisted.entries).toEqual({});
    expect(persisted.freshStartNonces["chat-pi-reset-flush"]).toBe(pendingNonce);
    // Only one unique nonce was minted across the failed attempt + retry.
    expect(new Set(rotateSpy.mock.results.map((r) => r.value))).toEqual(new Set([pendingNonce]));

    await sm.dispatch(
      mockEntry({ id: 332, chatId: "chat-pi-reset-flush", messageId: "msg-flush-2", content: "after reset" }),
    );
    expect(ackEntry).toHaveBeenCalledWith(332);
    const allIds = rpcSessionIds(specs);
    expect(allIds).toHaveLength(2);
    expect(allIds[1]).toBe(freshStartPiSessionId("agent-1", "chat-pi-reset-flush", "msg-flush-2", pendingNonce));
    expect(allIds[1]).not.toBe(oldId);
    await sm.shutdown();
  });

  it("settled + ACK failure + Pause/Reset + new SessionRuntime + same-row redelivery cannot reopen retired Pi history", async () => {
    const registryPath = join(workspaceRoot, "sessions-reset-redelivery.json");
    const specs: ProviderProcessSpec[] = [];
    // Persistent ACK failure leaves the settled first row as recovery debt.
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockRejectedValue(new Error("ack offline"));
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice-unused" });
    const sm1 = makePiSessionRuntime({ specs, ackEntry, postRuntimeNotice, registryPath });

    const chatId = "chat-pi-reset-redelivery";
    const messageId = "msg-reset-redelivery";
    const entryId = 341;
    const entry = mockEntry({ id: entryId, chatId, messageId, content: "settled but unacked" });

    const firstDispatch = sm1.dispatch(entry);
    await vi.waitFor(() => expect(rpcSessionIds(specs)).toHaveLength(1), { timeout: 10_000 });
    const oldId = rpcSessionIds(specs)[0]!;
    expect(oldId).toBe(freshStartPiSessionId("agent-1", chatId, messageId));
    // Turn settled under ACK failure — coordinator keeps the uncommitted row.
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledWith(entryId), { timeout: 10_000 });
    // Await adoption/settlement completion so Pause/Reset cannot race an
    // unfinished startNewSession; reject if the harness surfaces an error.
    await expect(firstDispatch).resolves.toBeUndefined();
    // Premise: the old provider mapping is durable while ACK is still failing.
    await vi.waitFor(
      () => {
        expect(existsSync(registryPath)).toBe(true);
        const beforeReset = JSON.parse(readFileSync(registryPath, "utf8")) as {
          entries: Record<string, { claudeSessionId?: string }>;
        };
        expect(beforeReset.entries[chatId]?.claudeSessionId).toBe(oldId);
      },
      { timeout: 5000 },
    );
    expect(ackEntry).toHaveBeenCalledWith(entryId);

    await sm1.handleCommand(chatId, "session:suspend");
    await sm1.handleCommand(chatId, "session:terminate");
    const persisted = JSON.parse(readFileSync(registryPath, "utf8")) as {
      entries: Record<string, unknown>;
      freshStartNonces: Record<string, string>;
    };
    expect(persisted.entries).toEqual({});
    const resetNonce = persisted.freshStartNonces[chatId] ?? "";
    expect(resetNonce.length).toBeGreaterThan(0);

    await sm1.shutdown();

    // New SessionRuntime (client restart): in-memory terminal ledger is gone.
    // Same durable inbox row is redelivered; ACK is available this time.
    const ackEntry2 = mockAckEntry();
    const sm2 = makePiSessionRuntime({ specs, ackEntry: ackEntry2, postRuntimeNotice, registryPath });
    await sm2.dispatch(mockEntry({ id: entryId, chatId, messageId, content: "settled but unacked" }));
    expect(ackEntry2).toHaveBeenCalledWith(entryId);

    const allIds = rpcSessionIds(specs);
    expect(allIds).toHaveLength(2);
    const expectedFresh = freshStartPiSessionId("agent-1", chatId, messageId, resetNonce);
    expect(allIds[1]).toBe(expectedFresh);
    expect(allIds[1]).not.toBe(oldId);
    // Reconstructible message-id-only identity must NOT be selected after Reset.
    expect(allIds[1]).not.toBe(freshStartPiSessionId("agent-1", chatId, messageId));
    await sm2.shutdown();
  });

  it("failed Reset flush fences intervening start until retry; same-row redelivery uses durable nonce only", async () => {
    const registryPath = join(workspaceRoot, "sessions-reset-fence.json");
    const specs: ProviderProcessSpec[] = [];
    const ackEntry = mockAckEntry();
    const postRuntimeNotice = vi.fn().mockResolvedValue({ id: "runtime-notice-unused" });
    let consecutiveNoProgressResets = 0;
    let lastResetSignature: string | null = null;
    let noProgressCircuitOpen = false;
    const NO_PROGRESS_LIMIT = 2;
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>().mockImplementation(async () => {
      const resetSignature = "352";
      consecutiveNoProgressResets = lastResetSignature === resetSignature ? consecutiveNoProgressResets + 1 : 1;
      lastResetSignature = resetSignature;
      if (consecutiveNoProgressResets > NO_PROGRESS_LIMIT) {
        noProgressCircuitOpen = true;
        throw new Error("recover_failed: no-progress circuit open");
      }
    });
    const sm1 = makePiSessionRuntime({ specs, ackEntry, postRuntimeNotice, registryPath, recoverChat });
    const chatId = "chat-pi-reset-fence";

    await sm1.dispatch(mockEntry({ id: 351, chatId, messageId: "msg-fence-old", content: "establish identity" }));
    expect(ackEntry).toHaveBeenCalledWith(351);
    const oldId = freshStartPiSessionId("agent-1", chatId, "msg-fence-old");
    expect(rpcSessionIds(specs)).toEqual([oldId]);
    expect(readCount(promptCountFile)).toBe(1);

    const rotateSpy = vi.spyOn(SessionRegistry.prototype, "rotateFreshStartNonce");
    const boom = new Error("disk full");
    vi.spyOn(SessionRegistry.prototype, "flushOrThrow").mockImplementationOnce(() => {
      throw boom;
    });
    await expect(sm1.handleCommand(chatId, "session:terminate")).rejects.toBe(boom);
    const pendingNonce = rotateSpy.mock.results[0]?.value as string;
    expect(typeof pendingNonce).toBe("string");
    expect(pendingNonce.length).toBeGreaterThan(0);
    const sm1Internals = sm1 as unknown as {
      resetReplay: {
        terminatePersistFailures: Set<string>;
        terminatingChats: Map<string, Promise<void>>;
      };
      inboxDelivery: { hasRecoveryDebt(chatId: string): boolean };
    };
    expect(sm1Internals.resetReplay.terminatePersistFailures.has(chatId)).toBe(true);
    expect(sm1Internals.resetReplay.terminatingChats.has(chatId)).toBe(false);
    // Unresolved Reset flush must stay in held-chat force-keep reporting.
    expect(sm1.getHeldChatIds(new Set())).toContain(chatId);

    const interveningEntryId = 352;
    const interveningMessageId = "msg-fence-intervening";
    const interveningAckCallsBefore = ackEntry.mock.calls.filter((call) => call[0] === interveningEntryId).length;
    const promptsBefore = readCount(promptCountFile);
    const spawnsBefore = rpcSessionIds(specs).length;
    const interveningEntry = mockEntry({
      id: interveningEntryId,
      chatId,
      messageId: interveningMessageId,
      content: "must not consume pending nonce",
    });

    // Intervening durable row while Reset is failed: must not enter Pi or ACK,
    // and must not open a same-socket recoverChat storm / no-progress circuit.
    await sm1.dispatch(interveningEntry);
    await sm1.dispatch(interveningEntry);
    await sm1.dispatch(interveningEntry);
    expect(rpcSessionIds(specs)).toHaveLength(spawnsBefore);
    expect(readCount(promptCountFile)).toBe(promptsBefore);
    expect(readCount(steerCountFile)).toBe(0);
    expect(ackEntry.mock.calls.filter((call) => call[0] === interveningEntryId)).toHaveLength(
      interveningAckCallsBefore,
    );
    expect(recoverChat).not.toHaveBeenCalled();
    expect(noProgressCircuitOpen).toBe(false);
    expect(sm1Internals.inboxDelivery.hasRecoveryDebt(chatId)).toBe(true);
    // Pending nonce must not have been consumed by an intervening start identity.
    expect(rpcSessionIds(specs)).not.toContain(
      freshStartPiSessionId("agent-1", chatId, interveningMessageId, pendingNonce),
    );

    await sm1.handleCommand(chatId, "session:suspend");
    await sm1.handleCommand(chatId, "session:terminate");
    expect(sm1Internals.resetReplay.terminatePersistFailures.has(chatId)).toBe(false);
    const persisted = JSON.parse(readFileSync(registryPath, "utf8")) as {
      entries: Record<string, unknown>;
      freshStartNonces: Record<string, string>;
    };
    expect(persisted.entries).toEqual({});
    expect(persisted.freshStartNonces[chatId]).toBe(pendingNonce);
    expect(new Set(rotateSpy.mock.results.map((r) => r.value))).toEqual(new Set([pendingNonce]));
    // Successful retry arms parked work; release after simulated server finalize.
    expect(recoverChat).not.toHaveBeenCalled();
    sm1.releaseParkedResetFenceRecovery(chatId);
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledTimes(1));
    expect(recoverChat).toHaveBeenCalledWith(chatId);
    expect(noProgressCircuitOpen).toBe(false);

    // Same-socket redelivery of the exact intervening row after fence clear.
    await sm1.dispatch(interveningEntry);
    await vi.waitFor(() =>
      expect(ackEntry.mock.calls.filter((call) => call[0] === interveningEntryId).length).toBeGreaterThan(
        interveningAckCallsBefore,
      ),
    );
    const allIds = rpcSessionIds(specs);
    expect(allIds).toHaveLength(2);
    const expectedFresh = freshStartPiSessionId("agent-1", chatId, interveningMessageId, pendingNonce);
    expect(allIds[1]).toBe(expectedFresh);
    expect(allIds[1]).not.toBe(oldId);
    expect(allIds[1]).not.toBe(freshStartPiSessionId("agent-1", chatId, interveningMessageId));
    expect(recoverChat).toHaveBeenCalledTimes(1);
    expect(noProgressCircuitOpen).toBe(false);

    await sm1.shutdown();
  });
});
