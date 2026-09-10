import { watch as importedWatch, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ClientPausedReason } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Context Tree sync is agent-scoped: `AgentSlot.start()` binds the agent,
 * then fetches `/api/v1/agent/context-tree/info` through that agent's SDK.
 * The CLI-level `ClientRuntime` must not resolve one shared user-primary-org
 * binding and pass it into every slot.
 */

const slotInstances: Array<{
  agentId: string;
  name: string;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getQuietGateSnapshot: ReturnType<typeof vi.fn>;
}> = [];
const connectionListeners = new Map<string, (...args: unknown[]) => void>();
const fsWatchMocks = vi.hoisted(() => {
  function missingCallback(_eventType: string, _filename: string | Buffer | null): void {
    throw new Error("credentials watcher callback missing");
  }

  type Listener = (...args: unknown[]) => void;
  const state = {
    callback: missingCallback,
    registered: false,
  };
  const on = vi.fn((_event: string, _listener: Listener) => watcher);
  const close = vi.fn();
  const watcher = { close, on };
  const watch = vi.fn((...args: unknown[]) => {
    const listener = args.find((arg): arg is (eventType: string, filename: string | Buffer | null) => void => {
      return typeof arg === "function";
    });
    if (listener) {
      state.callback = listener;
      state.registered = true;
    }
    return watcher;
  });
  const reset = () => {
    state.callback = missingCallback;
    state.registered = false;
    close.mockClear();
    on.mockClear();
    watch.mockClear();
  };

  return { close, on, reset, state, watch };
});
const watchMockProbe = importedWatch;
const RUNTIME_TEST_TIMEOUT_MS = 15_000;
const disposeMock = vi.fn();
const killAllMock = vi.fn(async () => undefined);
const cliFetchMock = vi.hoisted(() => vi.fn());
const connectionCtorOptions: unknown[] = [];
let connectionMaxListeners = 10;
const connectionMock = {
  clientId: "client-test",
  on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
    connectionListeners.set(event, fn);
  }),
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  emit: vi.fn(),
  isPaused: vi.fn(() => false),
  getPausedReason: vi.fn<() => ClientPausedReason | null>(() => null),
  clearPaused: vi.fn(),
  getMaxListeners: vi.fn(() => connectionMaxListeners),
  setMaxListeners: vi.fn((n: number) => {
    connectionMaxListeners = n;
  }),
};
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: actual,
    watch: fsWatchMocks.watch,
  };
});
vi.mock("@first-tree/client", () => {
  class FakeAgentSlot {
    public readonly agentId: string;
    public readonly name: string;
    public start = vi.fn(async () => ({ displayName: this.name, agentId: this.name }));
    public stop = vi.fn(async () => undefined);
    public getQuietGateSnapshot = vi.fn(() => ({ activeCount: 0, lastActivityMs: 0 }));
    constructor(opts: { agentId: string; name: string }) {
      this.agentId = opts.agentId;
      this.name = opts.name;
      slotInstances.push(this);
    }
  }
  const stubFactory = vi.fn(() => ({
    start: vi.fn(),
    resume: vi.fn(),
    inject: vi.fn(),
    suspend: vi.fn(),
    shutdown: vi.fn(),
  }));
  // Narrow table so unsupported-runtime characterization still exercises the
  // fail-closed path for providers this "build" does not ship (e.g. TUI).
  const builtinTable = Object.freeze({
    "claude-code": stubFactory,
    codex: stubFactory,
  });
  return {
    AgentSlot: FakeAgentSlot,
    ClientConnection: class {
      clientId = connectionMock.clientId;
      on = connectionMock.on;
      connect = connectionMock.connect;
      disconnect = connectionMock.disconnect;
      emit = connectionMock.emit;
      isPaused = connectionMock.isPaused;
      getPausedReason = connectionMock.getPausedReason;
      clearPaused = connectionMock.clearPaused;
      getMaxListeners = connectionMock.getMaxListeners;
      setMaxListeners = connectionMock.setMaxListeners;
      constructor(options: unknown) {
        connectionCtorOptions.push(options);
      }
    },
    UpdateManager: { attach: vi.fn(() => ({ dispose: disposeMock })) },
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn().mockReturnThis(),
    })),
    getChildProcessRegistry: vi.fn(() => ({ killAll: killAllMock })),
    createBuiltinHandlerRegistry: vi.fn(() => builtinTable),
    resolveAndLogClaudeExecutable: vi.fn(() => ({ path: undefined, source: "default" })),
  };
});

vi.mock("../core/bootstrap.js", () => ({
  ensureFreshAccessToken: vi.fn(async () => "tok-test"),
}));

vi.mock("../core/cli-fetch.js", () => ({
  cliFetch: cliFetchMock,
}));

vi.mock("../core/output.js", () => ({
  print: {
    status: vi.fn(),
    check: vi.fn(),
    blank: vi.fn(),
    line: vi.fn(),
    result: vi.fn(),
    fail: vi.fn(),
  },
  setJsonMode: vi.fn(),
  isJsonMode: vi.fn(() => false),
}));

vi.mock("../core/version.js", () => ({
  CLI_USER_AGENT: "first-tree-test/0.0.0",
}));

describe("ClientRuntime context-tree wiring", () => {
  const originalHome = process.env.FIRST_TREE_HOME;
  let home: string;

  beforeEach(() => {
    vi.resetModules();
    home = mkdtempSync(join(tmpdir(), "ft-client-runtime-"));
    process.env.FIRST_TREE_HOME = home;
    slotInstances.length = 0;
    connectionListeners.clear();
    connectionCtorOptions.length = 0;
    connectionMock.on.mockClear();
    connectionMock.connect.mockClear();
    connectionMock.disconnect.mockClear();
    connectionMock.emit.mockClear();
    connectionMock.isPaused.mockReset();
    connectionMock.isPaused.mockReturnValue(false);
    connectionMock.getPausedReason.mockReset();
    connectionMock.getPausedReason.mockReturnValue(null);
    connectionMock.clearPaused.mockClear();
    connectionMaxListeners = 10;
    connectionMock.getMaxListeners.mockClear();
    connectionMock.setMaxListeners.mockClear();
    fsWatchMocks.reset();
    disposeMock.mockClear();
    killAllMock.mockClear();
    cliFetchMock.mockReset();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
    else process.env.FIRST_TREE_HOME = originalHome;
    // Release per-case runtime fixtures so this 1.3k-line suite does not keep
    // slot/connection graphs alive until the next beforeEach in the same fork.
    slotInstances.length = 0;
    connectionListeners.clear();
    connectionCtorOptions.length = 0;
    vi.clearAllMocks();
  });

  it("adapts runtime output to logger methods with trimmed status levels", async () => {
    const { createLoggerRuntimeOutput } = await import("../core/client-runtime.js");
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const output = createLoggerRuntimeOutput(logger);

    output.blank();
    output.check(true, "connected", "agent alpha");
    output.check(false, "degraded");
    output.line("  hello logger  \n");
    output.line("   ");
    output.status("✗", "hard failure");
    output.status("⚠️", "soft warning");
    output.status("", "plain status");

    expect(logger.info).toHaveBeenCalledWith("connected: agent alpha");
    expect(logger.info).toHaveBeenCalledWith("hello logger");
    expect(logger.info).toHaveBeenCalledWith("plain status");
    expect(logger.warn).toHaveBeenCalledWith("degraded");
    expect(logger.warn).toHaveBeenCalledWith("⚠️ soft warning");
    expect(logger.error).toHaveBeenCalledWith("✗ hard failure");
  });

  it("wires default output and connection auth/update callbacks", async () => {
    const { print } = await import("../core/output.js");
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(
      join(home, "state", "update-state.json"),
      JSON.stringify({
        last: {
          result: "ok",
          target: "0.6.0",
          currentBefore: "0.5.0",
          installedVersion: "0.6.0",
          reason: null,
          at: "2026-05-20T00:00:00.000Z",
        },
      }),
    );
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://first-tree.test", "client-test") as unknown as {
      output: { line: (text: string) => void };
    };

    rt.output.line("default output line");

    const connectionOptions = connectionCtorOptions.at(-1) as
      | {
          getAccessToken?: (opts?: unknown) => Promise<string>;
          getLastUpdateAttempt?: () => unknown;
        }
      | undefined;
    await expect(connectionOptions?.getAccessToken?.({ force: true })).resolves.toBe("tok-test");
    expect(connectionOptions?.getLastUpdateAttempt?.()).toMatchObject({ target: "0.6.0", result: "ok" });
    expect(print.line).toHaveBeenCalledWith("default output line");
  });

  it(
    "starts eager slots without a shared Context Tree binding",
    async () => {
      const { ClientRuntime } = await import("../core/client-runtime.js");
      const rt = new ClientRuntime("https://first-tree.test", "client-test");
      rt.addAgent("alpha", {
        agentId: "agent-alpha",
        runtime: "claude-code",
        session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
        concurrency: 1,
      } as unknown as Parameters<typeof rt.addAgent>[1]);

      await rt.start();

      expect(slotInstances).toHaveLength(1);
      const slot = slotInstances[0];
      if (!slot) throw new Error("slot not constructed");
      expect(slot.start).toHaveBeenCalledTimes(1);
      expect(slot.start.mock.calls[0]).toEqual([]);
      await rt.stop();
    },
    RUNTIME_TEST_TIMEOUT_MS,
  );

  it("raises the shared connection listener limit as agent slots are added", async () => {
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://first-tree.test", "client-test");
    for (let i = 0; i < 11; i++) {
      rt.addAgent(`agent-${i}`, {
        agentId: `agent-id-${i}`,
        runtime: "claude-code",
        session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
        concurrency: 1,
      } as unknown as Parameters<typeof rt.addAgent>[1]);
    }

    expect(connectionMock.setMaxListeners).toHaveBeenLastCalledWith(12);
  });

  it(
    "reports suspended local aliases as skipped instead of connection failures",
    async () => {
      const { print } = await import("../core/output.js");
      const { ClientRuntime } = await import("../core/client-runtime.js");
      const rt = new ClientRuntime("https://first-tree.test", "client-test");
      rt.addAgent("active", {
        agentId: "agent-active",
        runtime: "claude-code",
        session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
        concurrency: 1,
      } as unknown as Parameters<typeof rt.addAgent>[1]);
      rt.addAgent("paused", {
        agentId: "agent-paused",
        runtime: "claude-code",
        session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
        concurrency: 1,
      } as unknown as Parameters<typeof rt.addAgent>[1]);
      slotInstances[1]?.start.mockRejectedValueOnce(new Error("agent:bind rejected (agent_suspended)"));

      await rt.start();

      expect(print.status).toHaveBeenCalledWith("•", "paused: skipped (suspended)");
      expect(print.status).toHaveBeenCalledWith("", "1 agent(s) running, 1 skipped. Press Ctrl+C to stop.");
      expect(print.check).not.toHaveBeenCalledWith(
        false,
        "paused: connection failed",
        expect.stringContaining("agent_suspended"),
      );

      const pinned = connectionListeners.get("agent:pinned");
      if (!pinned) throw new Error("agent:pinned listener missing");
      pinned({
        agentId: "agent-paused",
        name: "paused",
        runtimeProvider: "claude-code",
      });

      await vi.waitFor(() => expect(slotInstances[1]?.start).toHaveBeenCalledTimes(2));
      expect(print.status).toHaveBeenCalledWith("", "agent runtime confirmed: paused");
      expect(print.check).toHaveBeenCalledWith(true, "paused: connected", "agent: paused");
      await rt.stop();
    },
    RUNTIME_TEST_TIMEOUT_MS,
  );

  it("handles connection events, update hooks, and graceful stop", async () => {
    const client = await import("@first-tree/client");
    const { print } = await import("../core/output.js");
    slotInstances.length = 0;

    const update = {
      updateConfig: { policy: "prompt" },
      prompt: vi.fn(),
      executeUpdate: vi.fn(),
    } as unknown as NonNullable<
      ConstructorParameters<typeof import("../core/client-runtime.js").ClientRuntime>[2]
    >["update"];
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://first-tree.test", "client-test", { currentVersion: "0.0.1", update });
    rt.addAgent("alpha", {
      agentId: "agent-alpha",
      runtime: "claude-code",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof rt.addAgent>[1]);

    await rt.start();
    expect(client.UpdateManager.attach).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ currentVersion: "0.0.1", updateConfig: { policy: "prompt" } }),
    );
    slotInstances[0]?.getQuietGateSnapshot.mockReturnValue({ activeCount: 2, lastActivityMs: 400 });
    const updateOptions = vi.mocked(client.UpdateManager.attach).mock.calls[0]?.[1] as {
      getQuietGateSnapshot: () => { activeCount: number; lastActivityMs: number };
      log: (level: "info" | "warn" | "error" | "debug", message: string) => void;
    };
    expect(updateOptions.getQuietGateSnapshot()).toEqual({ activeCount: 2, lastActivityMs: 400 });
    updateOptions.log("warn", "update warning");

    connectionMock.isPaused.mockReturnValue(true);
    connectionMock.getPausedReason.mockReturnValue("auth_refresh_failed");
    expect(rt.isPaused()).toBe(true);
    expect(rt.pausedReason()).toBe("auth_refresh_failed");
    rt.emitConnectionResilienceEvent("resilience.update.failed", {
      targetVersion: "0.0.2",
      retryable: true,
      reasonCode: "INSTALL_FAILED",
    });
    expect(connectionMock.emit).toHaveBeenCalledWith("resilience.update.failed", {
      targetVersion: "0.0.2",
      retryable: true,
      reasonCode: "INSTALL_FAILED",
    });

    const reconnectOk = vi.fn();
    const reconnectBroken = vi.fn(() => {
      throw new Error("probe failed");
    });
    const reconnectStringBroken = vi.fn(() => {
      throw "probe string failed";
    });
    rt.onReconnect(reconnectOk);
    rt.onReconnect(reconnectBroken);
    rt.onReconnect(reconnectStringBroken);
    const welcome = connectionListeners.get("server:welcome");
    if (!welcome) throw new Error("server:welcome listener missing");
    const connected = connectionListeners.get("connected");
    if (!connected) throw new Error("connected listener missing");
    welcome({ isReconnect: false });
    connected();
    expect(reconnectOk).not.toHaveBeenCalled();
    // A reconnect welcome only ARMS publication — the listeners fire on the
    // registration boundary (`connected`), never on the welcome frame alone.
    welcome({ isReconnect: true });
    expect(reconnectOk).not.toHaveBeenCalled();
    connected();
    expect(reconnectOk).toHaveBeenCalled();
    expect(print.status).toHaveBeenCalledWith("⚠️", "reconnect handler error: probe failed");
    expect(print.status).toHaveBeenCalledWith("⚠️", "reconnect handler error: probe string failed");

    const runtimeAuth = vi.fn();
    rt.onRuntimeAuthStart(runtimeAuth);
    const runtimeAuthStart = connectionListeners.get("runtime-auth:start");
    if (!runtimeAuthStart) throw new Error("runtime-auth:start listener missing");
    runtimeAuthStart({ provider: "codex", ref: "cmd-1" });
    expect(runtimeAuth).toHaveBeenCalledWith({ provider: "codex", ref: "cmd-1" });

    const unbound = connectionListeners.get("agent:unbound");
    if (!unbound) throw new Error("agent:unbound listener missing");
    unbound("agent-alpha", undefined);
    unbound("agent-alpha", "agent_suspended");
    unbound("agent-alpha", "unpinned");

    killAllMock.mockRejectedValueOnce(new Error("kill failed"));
    await rt.stop();
    expect(disposeMock).toHaveBeenCalled();
    expect(slotInstances[0]?.stop).toHaveBeenCalled();
    expect(connectionMock.disconnect).toHaveBeenCalled();
    expect(killAllMock).toHaveBeenCalledWith("client-runtime-stop");
  });

  it("reports empty runtimes", async () => {
    const { print } = await import("../core/output.js");
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://hub.test", "client-test");

    await rt.start();

    expect(print.status).toHaveBeenCalledWith("", "no agents configured yet.");
    expect(print.status).toHaveBeenCalledWith(
      "",
      "add one with: first-tree-dev agent create <name> --type claude-code --client-id <id>",
    );
    await rt.stop();
  });

  it("routes runtime status through an injected output sink", async () => {
    const { print } = await import("../core/output.js");
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const output = {
      blank: vi.fn(),
      check: vi.fn(),
      line: vi.fn(),
      status: vi.fn(),
    };
    const rt = new ClientRuntime("https://hub.test", "client-test", { output });
    rt.addAgent("alpha", {
      agentId: "agent-alpha",
      runtime: "claude-code",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof rt.addAgent>[1]);

    await rt.start();

    expect(output.check).toHaveBeenCalledWith(true, "client registered", "client-test");
    expect(output.check).toHaveBeenCalledWith(true, "alpha: connected", "agent: alpha");
    expect(output.status).toHaveBeenCalledWith("", "1 agent(s) running. Press Ctrl+C to stop.");
    expect(print.check).not.toHaveBeenCalledWith(true, "client registered", "client-test");
    await rt.stop();
  });

  it("reports generic agent start failures and ignores already-starting entries", async () => {
    const { print } = await import("../core/output.js");
    const { ClientRuntime, isAgentSuspendedBindError } = await import("../core/client-runtime.js");
    expect(isAgentSuspendedBindError("agent_suspended by server")).toBe(true);
    expect(isAgentSuspendedBindError("plain bind failure")).toBe(false);
    const rt = new ClientRuntime("https://hub.test", "client-test");
    rt.addAgent("broken", {
      agentId: "agent-broken",
      runtime: "claude-code",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof rt.addAgent>[1]);
    slotInstances[0]?.start.mockRejectedValueOnce(new Error("bind failed"));

    await rt.start();

    expect(print.check).toHaveBeenCalledWith(false, "broken: connection failed", "bind failed");
    const pinned = connectionListeners.get("agent:pinned");
    if (!pinned) throw new Error("agent:pinned listener missing");
    pinned({
      agentId: "agent-broken",
      name: "broken",
      runtimeProvider: "claude-code",
    });

    await vi.waitFor(() => expect(slotInstances[0]?.start).toHaveBeenCalledTimes(2));
    expect(print.status).toHaveBeenCalledWith("", "agent runtime confirmed: broken");
    expect(print.check).toHaveBeenCalledWith(true, "broken: connected", "agent: broken");
    const runtimeProbe = rt as unknown as {
      agents: Array<{
        state: "idle" | "starting" | "running" | "suspended-skipped" | "failed" | "unsupported-runtime";
      }>;
      startAgentEntry(entry: unknown): Promise<"connected" | "skipped" | "failed">;
      startAgent(name: string): void;
    };
    const entry = runtimeProbe.agents[0];
    if (!entry) throw new Error("missing agent entry");
    entry.state = "running";
    await expect(runtimeProbe.startAgentEntry(entry)).resolves.toBe("connected");
    entry.state = "starting";
    await expect(runtimeProbe.startAgentEntry(entry)).resolves.toBe("skipped");
    entry.state = "unsupported-runtime";
    await expect(runtimeProbe.startAgentEntry(entry)).resolves.toBe("skipped");
    runtimeProbe.startAgent("missing");
    slotInstances[0]?.start.mockRejectedValueOnce("string start failure");
    entry.state = "idle";
    await expect(runtimeProbe.startAgentEntry(entry)).resolves.toBe("failed");
    expect(print.check).toHaveBeenCalledWith(false, "broken: connection failed", "string start failure");
    slotInstances[0]?.start.mockResolvedValueOnce({ agentId: "agent-broken" });
    entry.state = "idle";
    await expect(runtimeProbe.startAgentEntry(entry)).resolves.toBe("connected");
    expect(print.check).toHaveBeenCalledWith(true, "broken: connected", "agent: agent-broken");
    await rt.stop();
  });

  it("handles duplicate local agents and watcher guard paths", async () => {
    const fs = await import("node:fs");
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://hub.test", "client-test");
    const config = {
      agentId: "agent-alpha",
      runtime: "claude-code",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof rt.addAgent>[1];
    rt.addAgent("alpha", config);
    rt.addAgent("alpha", { ...config, agentId: "agent-alpha-duplicate-name" });
    expect(slotInstances).toHaveLength(1);

    const missingDir = join(home, "missing-agents");
    rt.watchAgentsDir(missingDir);
    expect(vi.mocked(fs.watch)).not.toHaveBeenCalledWith(missingDir, expect.anything(), expect.anything());

    const agentsDir = join(home, "config", "agents");
    mkdirSync(join(agentsDir, "duplicate-id"), { recursive: true });
    writeFileSync(join(agentsDir, "duplicate-id", "agent.yaml"), "agentId: agent-alpha\nruntime: claude-code\n");
    rt.watchAgentsDir(agentsDir);
    rt.watchAgentsDir(agentsDir);
    expect(fsWatchMocks.watch).toHaveBeenCalledTimes(1);

    const runtimeProbe = rt as unknown as { scanForNewAgents(agentsDir: string): void };
    runtimeProbe.scanForNewAgents(agentsDir);
    expect(slotInstances).toHaveLength(1);
    await rt.stop();
  });

  it("auto-adds server-pinned agents and skips duplicates", async () => {
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://first-tree.test", "client-test");
    const agentsDir = join(home, "config", "agents");
    mkdirSync(agentsDir, { recursive: true });
    rt.watchAgentsDir(agentsDir);

    const pinned = connectionListeners.get("agent:pinned");
    if (!pinned) throw new Error("agent:pinned listener missing");
    pinned({
      agentId: "019e70b3-0000-7000-8000-000000000001",
      name: "nova",
      runtimeProvider: "claude-code",
    });

    const text = readFileSync(join(agentsDir, "nova", "agent.yaml"), "utf8");
    expect(text).toContain("019e70b3-0000-7000-8000-000000000001");
    expect(text).toContain("claude-code");
    expect(slotInstances.map((slot) => slot.name)).toEqual(["nova"]);
    expect(slotInstances[0]?.start).toHaveBeenCalled();

    pinned({
      agentId: "019e70b3-0000-7000-8000-000000000001",
      name: "nova",
      runtimeProvider: "claude-code",
    });
    expect(slotInstances).toHaveLength(1);

    pinned({
      agentId: "019e70b3-0000-7000-8000-000000000002",
      name: "nova",
      runtimeProvider: "codex",
    });
    expect(readFileSync(join(agentsDir, "agent-019e70b300007000", "agent.yaml"), "utf8")).toContain("codex");
    expect(slotInstances.map((slot) => slot.name)).toEqual(["nova", "agent-019e70b300007000"]);
    await rt.stop();
  });

  it("preserves local agent yaml fields when reconfiguring a pinned runtime", async () => {
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://first-tree.test", "client-test");
    const agentsDir = join(home, "config", "agents");
    const alphaDir = join(agentsDir, "alpha");
    mkdirSync(alphaDir, { recursive: true });
    writeFileSync(
      join(alphaDir, "agent.yaml"),
      "agentId: agent-alpha\nruntime: codex\nqaLocalNote: preserve-me\nqaNested:\n  keep: true\n",
    );
    rt.watchAgentsDir(agentsDir);
    rt.addAgent("alpha", {
      agentId: "agent-alpha",
      runtime: "codex",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof rt.addAgent>[1]);

    const pinned = connectionListeners.get("agent:pinned");
    if (!pinned) throw new Error("agent:pinned listener missing");
    pinned({
      agentId: "agent-alpha",
      name: "alpha",
      runtimeProvider: "claude-code",
    });

    await vi.waitFor(() => expect(slotInstances).toHaveLength(2));
    await vi.waitFor(() => expect(slotInstances[1]?.start).toHaveBeenCalled());
    expect(slotInstances[0]?.stop).toHaveBeenCalledWith("runtime switched by server", {
      sessionShutdown: {
        clearPersistedRegistry: true,
        reportSuspendedSessions: false,
      },
    });
    const text = readFileSync(join(alphaDir, "agent.yaml"), "utf8");
    expect(text).toContain("runtime: claude-code");
    expect(text).toContain("qaLocalNote: preserve-me");
    expect(text).toContain("qaNested:");
    expect(text).toContain("keep: true");
    await rt.stop();
  });

  it("continues supported runtime switches when the previous slot stop fails", async () => {
    const { print } = await import("../core/output.js");
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://first-tree.test", "client-test");
    const agentsDir = join(home, "config", "agents");
    const alphaDir = join(agentsDir, "alpha");
    mkdirSync(alphaDir, { recursive: true });
    writeFileSync(join(alphaDir, "agent.yaml"), "agentId: agent-alpha\nruntime: codex\n");
    rt.watchAgentsDir(agentsDir);
    rt.addAgent("alpha", {
      agentId: "agent-alpha",
      runtime: "codex",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof rt.addAgent>[1]);
    slotInstances[0]?.stop.mockRejectedValueOnce(new Error("stop failed"));

    const pinned = connectionListeners.get("agent:pinned");
    if (!pinned) throw new Error("agent:pinned listener missing");
    pinned({
      agentId: "agent-alpha",
      name: "alpha",
      runtimeProvider: "claude-code",
    });

    await vi.waitFor(() => expect(slotInstances).toHaveLength(2));
    expect(print.status).toHaveBeenCalledWith("⚠️", "failed to stop previous runtime for alpha: stop failed");
    expect(slotInstances[1]?.start).toHaveBeenCalled();
    await rt.stop();
  });

  it("stringifies non-Error runtime switch stop and write failures", async () => {
    const { print } = await import("../core/output.js");
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const agentsDir = join(home, "config", "agents");

    const supported = new ClientRuntime("https://first-tree.test", "client-test");
    mkdirSync(join(agentsDir, "supported"), { recursive: true });
    writeFileSync(join(agentsDir, "supported", "agent.yaml"), "agentId: agent-supported\nruntime: codex\n");
    supported.watchAgentsDir(agentsDir);
    supported.addAgent("supported", {
      agentId: "agent-supported",
      runtime: "codex",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof supported.addAgent>[1]);
    slotInstances.at(-1)?.stop.mockRejectedValueOnce("string stop failure");
    connectionListeners.get("agent:pinned")?.({
      agentId: "agent-supported",
      name: "supported",
      runtimeProvider: "claude-code",
    });
    await vi.waitFor(() =>
      expect(print.status).toHaveBeenCalledWith(
        "⚠️",
        "failed to stop previous runtime for supported: string stop failure",
      ),
    );

    const unsupported = new ClientRuntime("https://first-tree.test", "client-test");
    unsupported.watchAgentsDir(agentsDir);
    unsupported.addAgent("unsupported", {
      agentId: "agent-unsupported",
      runtime: "claude-code",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof unsupported.addAgent>[1]);
    slotInstances.at(-1)?.stop.mockRejectedValueOnce("unsupported stop failure");
    connectionListeners.get("agent:pinned")?.({
      agentId: "agent-unsupported",
      name: "unsupported",
      runtimeProvider: "claude-code-tui",
    });
    await vi.waitFor(() =>
      expect(print.status).toHaveBeenCalledWith(
        "⚠️",
        "failed to stop previous runtime for unsupported: unsupported stop failure",
      ),
    );

    const writeFailure = new ClientRuntime("https://first-tree.test", "client-test");
    writeFailure.watchAgentsDir(agentsDir);
    writeFailure.addAgent("write-failure", {
      agentId: "agent-write-failure",
      runtime: "codex",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof writeFailure.addAgent>[1]);
    const writeFailureProbe = writeFailure as unknown as { writeAgentYaml: () => never };
    writeFailureProbe.writeAgentYaml = () => {
      throw "string write failure";
    };
    connectionListeners.get("agent:pinned")?.({
      agentId: "agent-write-failure",
      name: "write-failure",
      runtimeProvider: "claude-code",
    });
    await vi.waitFor(() =>
      expect(print.check).toHaveBeenCalledWith(
        false,
        'failed to update agent "write-failure" runtime',
        "string write failure",
      ),
    );

    await supported.stop();
    await unsupported.stop();
    await writeFailure.stop();
  });

  it("marks runtime switches to unsupported providers and reports stop/write failures", async () => {
    const { print } = await import("../core/output.js");
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://first-tree.test", "client-test");
    const agentsDir = join(home, "config", "agents");
    const alphaDir = join(agentsDir, "alpha");
    mkdirSync(alphaDir, { recursive: true });
    writeFileSync(join(alphaDir, "agent.yaml"), "agentId: agent-alpha\nruntime: claude-code\n");
    rt.watchAgentsDir(agentsDir);
    rt.addAgent("alpha", {
      agentId: "agent-alpha",
      runtime: "claude-code",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof rt.addAgent>[1]);
    slotInstances[0]?.stop.mockRejectedValueOnce(new Error("stop failed"));

    const pinned = connectionListeners.get("agent:pinned");
    if (!pinned) throw new Error("agent:pinned listener missing");
    pinned({
      agentId: "agent-alpha",
      name: "alpha",
      runtimeProvider: "claude-code-tui",
    });

    await vi.waitFor(() =>
      expect(print.status).toHaveBeenCalledWith(
        "⚠️",
        expect.stringContaining('agent "alpha" switched to runtime "claude-code-tui"'),
      ),
    );
    expect(print.status).toHaveBeenCalledWith("⚠️", "failed to stop previous runtime for alpha: stop failed");
    expect(readFileSync(join(alphaDir, "agent.yaml"), "utf8")).toContain("runtime: claude-code-tui");

    const rtWithoutDir = new ClientRuntime("https://first-tree.test", "client-test");
    rtWithoutDir.addAgent("beta", {
      agentId: "agent-beta",
      runtime: "claude-code",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof rtWithoutDir.addAgent>[1]);
    const pinnedWithoutDir = connectionListeners.get("agent:pinned");
    if (!pinnedWithoutDir) throw new Error("agent:pinned listener missing");
    pinnedWithoutDir({
      agentId: "agent-beta",
      name: "beta",
      runtimeProvider: "codex",
    });
    await vi.waitFor(() =>
      expect(print.check).toHaveBeenCalledWith(false, 'failed to update agent "beta" runtime', "agents dir is not set"),
    );
    await rt.stop();
    await rtWithoutDir.stop();
  });

  it("stops the previous slot cleanly when switching to an unsupported provider", async () => {
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://first-tree.test", "client-test");
    const agentsDir = join(home, "config", "agents");
    const alphaDir = join(agentsDir, "alpha");
    mkdirSync(alphaDir, { recursive: true });
    writeFileSync(join(alphaDir, "agent.yaml"), "agentId: agent-alpha\nruntime: claude-code\n");
    rt.watchAgentsDir(agentsDir);
    rt.addAgent("alpha", {
      agentId: "agent-alpha",
      runtime: "claude-code",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof rt.addAgent>[1]);

    connectionListeners.get("agent:pinned")?.({
      agentId: "agent-alpha",
      name: "alpha",
      runtimeProvider: "claude-code-tui",
    });

    await vi.waitFor(() =>
      expect(slotInstances[0]?.stop).toHaveBeenCalledWith("runtime switched to unsupported provider by server", {
        sessionShutdown: {
          clearPersistedRegistry: true,
          reportSuspendedSessions: false,
        },
      }),
    );
    expect(readFileSync(join(alphaDir, "agent.yaml"), "utf8")).toContain("runtime: claude-code-tui");
    await rt.stop();
  });

  it("debounces agents-dir watcher rescans for newly written agent configs", async () => {
    vi.useFakeTimers();
    try {
      const { ClientRuntime } = await import("../core/client-runtime.js");
      const rt = new ClientRuntime("https://first-tree.test", "client-test");
      const agentsDir = join(home, "config", "agents");
      mkdirSync(join(agentsDir, "debounced"), { recursive: true });
      writeFileSync(join(agentsDir, "debounced", "agent.yaml"), "agentId: agent-debounced\nruntime: claude-code\n");
      rt.watchAgentsDir(agentsDir);

      fsWatchMocks.state.callback("rename", "debounced/agent.yaml");
      fsWatchMocks.state.callback("change", "debounced/agent.yaml");
      await vi.advanceTimersByTimeAsync(500);

      expect(slotInstances.map((slot) => slot.name)).toContain("debounced");
      expect(slotInstances.at(-1)?.start).toHaveBeenCalled();
      const runtimeProbe = rt as unknown as { debounceTimer: ReturnType<typeof setTimeout> | null };
      runtimeProbe.debounceTimer = setTimeout(() => undefined, 10_000);
      rt.unwatchAgentsDir();
      await rt.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("repairs runtime-provider bind mismatches once without looping", async () => {
    const { print } = await import("../core/output.js");
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://first-tree.test", "client-test");
    const agentsDir = join(home, "config", "agents");
    mkdirSync(agentsDir, { recursive: true });
    rt.watchAgentsDir(agentsDir);
    rt.addAgent("alpha", {
      agentId: "agent-alpha",
      runtime: "claude-code",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof rt.addAgent>[1]);
    await rt.start();
    cliFetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        uuid: "agent-alpha",
        name: "alpha",
        displayName: "Alpha",
        type: "agent",
        runtimeProvider: "codex",
      }),
    });

    const rejected = connectionListeners.get("agent:bind:rejected");
    if (!rejected) throw new Error("agent:bind:rejected listener missing");
    rejected("runtime_provider_mismatch", "agent-alpha");
    rejected("runtime_provider_mismatch", "agent-alpha");

    await vi.waitFor(() => expect(cliFetchMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(slotInstances).toHaveLength(2));
    expect(slotInstances[0]?.stop).toHaveBeenCalledWith("runtime switched by server", {
      sessionShutdown: {
        clearPersistedRegistry: true,
        reportSuspendedSessions: false,
      },
    });
    expect(slotInstances[1]?.start).toHaveBeenCalled();
    expect(print.status).toHaveBeenCalledWith(
      "⚠️",
      "alpha: runtime repair already attempted; not retrying bind mismatch.",
    );
    await rt.stop();
  });

  it("uses runtime-provider repair fallbacks for loose server agent shapes", async () => {
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://first-tree.test", "client-test");
    const agentsDir = join(home, "config", "agents");
    mkdirSync(agentsDir, { recursive: true });
    rt.watchAgentsDir(agentsDir);
    rt.addAgent("alpha", {
      agentId: "agent-alpha",
      runtime: "claude-code",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof rt.addAgent>[1]);
    await rt.start();
    cliFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        name: 123,
        displayName: 456,
        type: "human",
        runtimeProvider: "codex",
      }),
    });

    const rejected = connectionListeners.get("agent:bind:rejected");
    if (!rejected) throw new Error("agent:bind:rejected listener missing");
    rejected("agent_suspended", "agent-alpha");
    expect(cliFetchMock).not.toHaveBeenCalled();
    rejected("runtime_provider_mismatch", "missing-agent");
    expect(cliFetchMock).not.toHaveBeenCalled();
    rejected("runtime_provider_mismatch", "agent-alpha");

    await vi.waitFor(() => expect(slotInstances).toHaveLength(2));
    expect(readFileSync(join(agentsDir, "alpha", "agent.yaml"), "utf8")).toContain("runtime: codex");
    await rt.stop();
  });

  it("reports runtime-provider repair HTTP, schema, and fetch failures", async () => {
    const { print } = await import("../core/output.js");
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rejected = () => {
      const listener = connectionListeners.get("agent:bind:rejected");
      if (!listener) throw new Error("agent:bind:rejected listener missing");
      listener("runtime_provider_mismatch", "agent-alpha");
    };

    const rtHttp = new ClientRuntime("https://first-tree.test", "client-test");
    rtHttp.addAgent("alpha", {
      agentId: "agent-alpha",
      runtime: "claude-code",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof rtHttp.addAgent>[1]);
    await rtHttp.start();
    cliFetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    rejected();
    await vi.waitFor(() => expect(print.status).toHaveBeenCalledWith("⚠️", "alpha: runtime repair failed (HTTP 503)"));
    await rtHttp.stop();

    vi.clearAllMocks();
    const rtSchema = new ClientRuntime("https://first-tree.test", "client-test");
    rtSchema.addAgent("alpha", {
      agentId: "agent-alpha",
      runtime: "claude-code",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof rtSchema.addAgent>[1]);
    await rtSchema.start();
    cliFetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ runtimeProvider: "future" }) });
    rejected();
    await vi.waitFor(() =>
      expect(print.status).toHaveBeenCalledWith("⚠️", "alpha: runtime repair failed (server returned unknown runtime)"),
    );
    await rtSchema.stop();

    vi.clearAllMocks();
    const rtFetch = new ClientRuntime("https://first-tree.test", "client-test");
    rtFetch.addAgent("alpha", {
      agentId: "agent-alpha",
      runtime: "claude-code",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof rtFetch.addAgent>[1]);
    await rtFetch.start();
    cliFetchMock.mockRejectedValueOnce(new Error("network down"));
    rejected();
    await vi.waitFor(() =>
      expect(print.status).toHaveBeenCalledWith("⚠️", "alpha: runtime repair failed: network down"),
    );
    await rtFetch.stop();

    vi.clearAllMocks();
    const rtNonErrorFetch = new ClientRuntime("https://first-tree.test", "client-test");
    rtNonErrorFetch.addAgent("alpha", {
      agentId: "agent-alpha",
      runtime: "claude-code",
      session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
      concurrency: 1,
    } as unknown as Parameters<typeof rtNonErrorFetch.addAgent>[1]);
    await rtNonErrorFetch.start();
    cliFetchMock.mockRejectedValueOnce("offline");
    rejected();
    await vi.waitFor(() => expect(print.status).toHaveBeenCalledWith("⚠️", "alpha: runtime repair failed: offline"));
    await rtNonErrorFetch.stop();
  });

  it("chooses suffixed pinned-agent names and reports auto-add write failures", async () => {
    const { print } = await import("../core/output.js");
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://hub.test", "client-test");
    const runtimeProbe = rt as unknown as {
      agentNames: Set<string>;
      agentsDir: string | null;
      pickLocalName(message: { agentId: string; name?: string | null; runtimeProvider: string }): string;
    };
    runtimeProbe.agentNames.add("agent-abcdefabcdefabcd");
    expect(
      runtimeProbe.pickLocalName({
        agentId: "abcdefab-cdef-abcd-0000-000000000000",
        runtimeProvider: "claude-code",
      }),
    ).toBe("agent-abcdefabcdefabcd-2");
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      runtimeProbe.agentNames.add(`agent-abcdefabcdefabcd-${suffix}`);
    }
    expect(
      runtimeProbe.pickLocalName({
        agentId: "abcdefab-cdef-abcd-0000-000000000000",
        runtimeProvider: "claude-code",
      }),
    ).toBe("agent-abcdefabcdefabcd0000000000000000");

    const agentsDirFile = join(home, "config", "agents-file");
    mkdirSync(dirname(agentsDirFile), { recursive: true });
    writeFileSync(agentsDirFile, "not a directory\n");
    runtimeProbe.agentsDir = agentsDirFile;
    const pinned = connectionListeners.get("agent:pinned");
    if (!pinned) throw new Error("agent:pinned listener missing");
    pinned({
      agentId: "agent-write-fail",
      name: "write-fail",
      runtimeProvider: "claude-code",
    });
    expect(print.check).toHaveBeenCalledWith(
      false,
      'failed to auto-add agent "write-fail"',
      expect.stringContaining("ENOTDIR"),
    );
    await rt.stop();
  });

  it("reports pinned agents when no agent directory is set and ignores duplicate watched agents", async () => {
    const { print } = await import("../core/output.js");
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://first-tree.test", "client-test");

    const pinned = connectionListeners.get("agent:pinned");
    if (!pinned) throw new Error("agent:pinned listener missing");
    pinned({
      agentId: "agent-missing-dir",
      name: "missing",
      runtimeProvider: "claude-code",
    });
    expect(print.status).toHaveBeenCalledWith(
      "⚠️",
      "agent pinned (agent-missing-dir) but no agents dir set — cannot auto-register.",
    );

    const agentsDir = join(home, "config", "agents");
    mkdirSync(join(agentsDir, "newcomer"), { recursive: true });
    writeFileSync(join(agentsDir, "newcomer", "agent.yaml"), "agentId: agent-new\nruntime: claude-code\n");
    rt.watchAgentsDir(agentsDir);
    pinned({
      agentId: "agent-new",
      name: "newcomer",
      runtimeProvider: "claude-code",
    });
    expect(slotInstances.map((slot) => slot.name)).toContain("newcomer");
    pinned({
      agentId: "agent-new",
      name: "newcomer",
      runtimeProvider: "claude-code",
    });
    expect(slotInstances.filter((slot) => slot.name === "newcomer")).toHaveLength(1);
    await rt.stop();
  });

  it("registers paused-mode recovery and reports auth lifecycle events", async () => {
    const { print } = await import("../core/output.js");
    const { ClientRuntime } = await import("../core/client-runtime.js");
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "credentials.json"), JSON.stringify({ refreshToken: "old" }));
    const rt = new ClientRuntime("https://first-tree.test", "client-test");
    connectionMock.isPaused.mockReturnValue(true);

    const paused = connectionListeners.get("auth:paused");
    if (!paused) throw new Error("auth:paused listener missing");
    paused("auth_refresh_failed", new Error("refresh rejected"));
    expect(print.status).toHaveBeenCalledWith("✗", "auth rejected — pausing agents until fresh credentials arrive.");
    expect(print.status).toHaveBeenCalledWith("", "refresh rejected");
    paused(
      "auth_refresh_failed",
      (() => {
        const err = new Error("missing auth message");
        Object.defineProperty(err, "authCode", { value: "invalid_token" });
        return err;
      })(),
    );
    expect(print.status).toHaveBeenCalledWith("", "Auth rejection code: invalid_token");
    const credentialsError = fsWatchMocks.on.mock.calls.find((call) => call[0] === "error")?.[1] as
      | ((err: Error) => void)
      | undefined;
    credentialsError?.(new Error("watch failed"));
    expect(print.status).toHaveBeenCalledWith("⚠️", "credentials watcher error: watch failed");
    const structured = new Error("Server rejected access token");
    Object.defineProperty(structured, "authCode", { value: "invalid_token" });
    Object.defineProperty(structured, "authMessage", { value: "signature mismatch" });
    paused("auth_rejected", structured);
    expect(print.status).toHaveBeenCalledWith("", "Auth rejection code: invalid_token — signature mismatch");
    expect(rt.isPaused()).toBe(true);

    const resumed = connectionListeners.get("auth:resumed");
    if (!resumed) throw new Error("auth:resumed listener missing");
    resumed("auth_refresh_failed");
    expect(print.status).toHaveBeenCalledWith(
      "✓",
      "credentials refreshed — resuming agents (was paused: auth_refresh_failed)",
    );

    const expired = connectionListeners.get("auth:expired");
    if (!expired) throw new Error("auth:expired listener missing");
    expired();
    expect(print.status).toHaveBeenCalledWith("⚠️", "access token expired — reconnecting after refresh...");

    const error = connectionListeners.get("error");
    if (!error) throw new Error("error listener missing");
    error(new Error("socket reset"));
    expect(print.status).toHaveBeenCalledWith("⚠️", "client connection error: socket reset");
    await rt.stop();
  });

  it("reports credentials watcher setup failures", async () => {
    const fs = await import("node:fs");
    const { print } = await import("../core/output.js");
    const { ClientRuntime } = await import("../core/client-runtime.js");
    mkdirSync(join(home, "config"), { recursive: true });
    vi.mocked(fs.watch).mockImplementationOnce(() => {
      throw new Error("watch denied");
    });
    const rt = new ClientRuntime("https://first-tree.test", "client-test");

    const paused = connectionListeners.get("auth:paused");
    if (!paused) throw new Error("auth:paused listener missing");
    paused("auth_refresh_failed", new Error("refresh rejected"));

    expect(print.status).toHaveBeenCalledWith("⚠️", "credentials watcher failed: watch denied");
    await rt.stop();
  });

  it("skips credentials watcher setup when the config directory is absent", async () => {
    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://first-tree.test", "client-test");

    const paused = connectionListeners.get("auth:paused");
    if (!paused) throw new Error("auth:paused listener missing");
    paused("auth_refresh_failed", new Error("refresh rejected"));

    expect(fsWatchMocks.watch).not.toHaveBeenCalled();
    await rt.stop();
  });

  it("reports non-Error credentials watcher setup failures", async () => {
    const fs = await import("node:fs");
    const { print } = await import("../core/output.js");
    const { ClientRuntime } = await import("../core/client-runtime.js");
    mkdirSync(join(home, "config"), { recursive: true });
    vi.mocked(fs.watch).mockImplementationOnce(() => {
      throw "watch denied as string";
    });
    const rt = new ClientRuntime("https://first-tree.test", "client-test");

    const paused = connectionListeners.get("auth:paused");
    if (!paused) throw new Error("auth:paused listener missing");
    paused("auth_refresh_failed", new Error("refresh rejected"));

    expect(print.status).toHaveBeenCalledWith("⚠️", "credentials watcher failed: watch denied as string");
    await rt.stop();
  });

  it("clears paused mode after credentials.json content changes", async () => {
    const { print } = await import("../core/output.js");
    expect(watchMockProbe).toBe(fsWatchMocks.watch);
    const { ClientRuntime } = await import("../core/client-runtime.js");
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "credentials.json"), JSON.stringify({ refreshToken: "old" }));
    const rt = new ClientRuntime("https://hub.test", "client-test");
    connectionMock.isPaused.mockReturnValue(true);

    const paused = connectionListeners.get("auth:paused");
    if (!paused) throw new Error("auth:paused listener missing");
    paused("auth_refresh_failed", new Error("refresh rejected"));
    paused("auth_refresh_failed", new Error("refresh rejected again"));
    fsWatchMocks.state.callback("rename", "ignored.txt");
    writeFileSync(join(home, "config", "credentials.json"), JSON.stringify({ refreshToken: "new" }));
    if (!fsWatchMocks.state.registered) throw new Error("credentials watcher callback missing");
    fsWatchMocks.state.callback("change", "credentials.json");
    fsWatchMocks.state.callback("change", null);

    await vi.waitFor(() => expect(connectionMock.clearPaused).toHaveBeenCalled(), { timeout: 2000 });
    expect(print.status).toHaveBeenCalledWith("", "credentials.json updated — clearing paused mode");

    const runtimeProbe = rt as unknown as {
      credentialsDebounce: ReturnType<typeof setTimeout> | null;
      readCredentialsSnapshot(path: string): string | null;
      readAgentYamlRecord(name: string): Record<string, unknown>;
      scanForNewAgents(agentsDir: string): void;
    };
    runtimeProbe.credentialsDebounce = setTimeout(() => undefined, 10_000);
    expect(runtimeProbe.readCredentialsSnapshot(join(home, "config", "missing.json"))).toBeNull();
    expect(runtimeProbe.readAgentYamlRecord("missing")).toEqual({});
    mkdirSync(join(home, "config", "agents", "array-yaml"), { recursive: true });
    writeFileSync(join(home, "config", "agents", "array-yaml", "agent.yaml"), "[]\n");
    expect(runtimeProbe.readAgentYamlRecord("array-yaml")).toEqual({});
    mkdirSync(join(home, "config", "agents", "null-yaml"), { recursive: true });
    writeFileSync(join(home, "config", "agents", "null-yaml", "agent.yaml"), "null\n");
    expect(runtimeProbe.readAgentYamlRecord("null-yaml")).toEqual({});
    mkdirSync(join(home, "config", "agents"), { recursive: true });
    writeFileSync(join(home, "config", "agents", "bad-agent.yaml"), "not a directory");
    runtimeProbe.scanForNewAgents(join(home, "config", "agents", "bad-agent.yaml"));
    await rt.stop();
    expect(fsWatchMocks.close).toHaveBeenCalled();
  });

  it(
    "skips an agent whose runtime has no handler on this build, without crashing startup",
    async () => {
      const { print } = await import("../core/output.js");
      const { ClientRuntime } = await import("../core/client-runtime.js");
      const rt = new ClientRuntime("https://first-tree.test", "client-test");

      // A valid enum provider this client build ships no handler for yet
      // (e.g. claude-code-tui before the TUI handler lands). Added FIRST so the
      // test also proves it does not abort registration of the agent after it.
      rt.addAgent("tui-agent", {
        agentId: "agent-tui",
        runtime: "claude-code-tui",
        session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
        concurrency: 1,
      } as unknown as Parameters<typeof rt.addAgent>[1]);
      rt.addAgent("alpha", {
        agentId: "agent-alpha",
        runtime: "claude-code",
        session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
        concurrency: 1,
      } as unknown as Parameters<typeof rt.addAgent>[1]);

      // Must not throw despite the unsupported agent in the load set.
      await rt.start();

      // Only the supported agent built a slot; the unsupported one was skipped.
      expect(slotInstances).toHaveLength(1);
      expect(slotInstances[0]?.name).toBe("alpha");
      // Operator got a clear warning naming the agent and its runtime.
      expect(print.status).toHaveBeenCalledWith(
        "⚠️",
        expect.stringContaining('agent "tui-agent" uses runtime "claude-code-tui"'),
      );

      await rt.stop();
    },
    RUNTIME_TEST_TIMEOUT_MS,
  );

  it("tears down the agents-dir watcher when it emits a runtime error", async () => {
    const fs = await import("node:fs");
    const { print } = await import("../core/output.js");
    type Listener = (...args: unknown[]) => void;
    const errorListeners: Listener[] = [];
    const close = vi.fn();
    const fakeWatcher = {
      on(event: string, listener: Listener) {
        if (event === "error") errorListeners.push(listener);
        return this;
      },
      close,
    };
    vi.mocked(fs.watch).mockReturnValueOnce(fakeWatcher as unknown as ReturnType<typeof fs.watch>);

    const { ClientRuntime } = await import("../core/client-runtime.js");
    const rt = new ClientRuntime("https://first-tree.test", "client-test");
    const agentsDir = join(home, "config", "agents");
    mkdirSync(agentsDir, { recursive: true });
    rt.watchAgentsDir(agentsDir);

    expect(errorListeners).toHaveLength(1);
    errorListeners[0]?.(new Error("inotify exhausted"));

    expect(print.status).toHaveBeenCalledWith("⚠️", expect.stringContaining("inotify exhausted"));
    expect(close).toHaveBeenCalled();
    await rt.stop();
  });

  for (const prototypeKey of ["toString", "constructor", "__proto__"] as const) {
    it(`resolveHandlerFactory rejects Object.prototype key ${prototypeKey} without constructing AgentSlot`, async () => {
      const { ClientRuntime } = await import("../core/client-runtime.js");
      const rt = new ClientRuntime("https://first-tree.test", "client-test");
      const before = slotInstances.length;

      expect(() =>
        (
          rt as unknown as {
            resolveHandlerFactory: (type: string) => unknown;
          }
        ).resolveHandlerFactory(prototypeKey),
      ).toThrow(new RegExp(`Unknown handler type "${prototypeKey}".*Available:`));
      expect(slotInstances.length).toBe(before);

      expect(() =>
        (
          rt as unknown as {
            createAgentSlot: (
              name: string,
              config: { runtime: string; agentId: string; session: object; concurrency: number },
            ) => unknown;
          }
        ).createAgentSlot("poisoned", {
          agentId: "agent-poisoned",
          runtime: prototypeKey,
          session: { idle_timeout: 300, max_sessions: 4, working_grace_seconds: 3600 },
          concurrency: 1,
        }),
      ).toThrow(new RegExp(`Unknown handler type "${prototypeKey}"`));
      expect(slotInstances.length).toBe(before);

      await rt.stop();
    });
  }
});
