import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  applyClientLoggerConfig: vi.fn(),
  captureClientException: vi.fn(),
  configureClientLoggerForService: vi.fn(),
  createLogger: vi.fn(),
  discoverClaudeCodeSkills: vi.fn(),
  flushClientSentry: vi.fn(),
  initClientSentry: vi.fn(),
  onCodexVerifiedAutomaticCandidateChange: vi.fn(),
  probeCapabilities: vi.fn(),
  probeCodexCapability: vi.fn(),
  reprobeOnReconnect: vi.fn(),
}));

const coreMocks = vi.hoisted(() => ({
  acquireDaemonRuntimeOwnership: vi.fn(),
  CapabilityRefresher: vi.fn(),
  ClientRuntime: vi.fn(),
  createApiNameResolver: vi.fn(),
  createExecuteUpdate: vi.fn(),
  createLoggerRuntimeOutput: vi.fn(),
  daemonRuntimeHomesEqual: vi.fn(),
  declineUpdate: vi.fn(),
  ensureActiveRootClientIdPersisted: vi.fn(),
  ensureFreshAccessToken: vi.fn(),
  getClientSwitchStartupBlock: vi.fn(),
  getClientServiceStatus: vi.fn(),
  handleClientOrgMismatch: vi.fn(),
  isDaemonRuntimeOwnershipError: vi.fn(),
  isServiceSupported: vi.fn(),
  listPinnedAgents: vi.fn(),
  loadCredentials: vi.fn(),
  loadDaemonEnv: vi.fn<() => string[]>(() => []),
  migrateLocalAgentDirs: vi.fn(),
  promptMissingFields: vi.fn(),
  promptUpdate: vi.fn(),
  registerClientRuntimeMarker: vi.fn(),
  reconcileLocalRuntimeProviders: vi.fn(),
  refreshServerUpdateTarget: vi.fn(),
  resolveClientRuntimeStopReason: vi.fn(),
  runRuntimeAuthLogin: vi.fn(),
  startClientService: vi.fn(),
  uploadAgentSkills: vi.fn(),
  uploadClientCapabilities: vi.fn(),
}));

const failMock = vi.hoisted(() =>
  vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
);

vi.mock("@first-tree/client", () => ({
  ...clientMocks,
  ClientOrgMismatchError: class ClientOrgMismatchError extends Error {},
  ClientRetiredError: class ClientRetiredError extends Error {},
  ClientUserMismatchError: class ClientUserMismatchError extends Error {},
}));

vi.mock("../core/index.js", () => ({
  ...coreMocks,
  COMMAND_VERSION: "0.0.0-test",
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn((path: Parameters<typeof actual.readFileSync>[0], ...args: unknown[]) => {
      if (path === "/proc/version") {
        return "Linux version 5.15.90.1-microsoft-standard-WSL2";
      }
      return (actual.readFileSync as (...readArgs: unknown[]) => unknown)(path, ...args);
    }),
  };
});

vi.mock("../cli/output.js", () => ({
  fail: failMock,
}));

const originalHome = process.env.FIRST_TREE_HOME;
const originalServerUrl = process.env.FIRST_TREE_SERVER_URL;
const originalServiceMode = process.env.FIRST_TREE_SERVICE_MODE;
const originalClientId = process.env.FIRST_TREE_CLIENT_ID;
const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
const exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
  throw Object.assign(new Error(`process.exit ${code}`), { exitCode: code });
});

let home: string;
let runtimeOwnershipRelease: ReturnType<typeof vi.fn>;
let codexCandidateChangeListener: (() => void) | null;
let unregisterCodexCandidateChange: ReturnType<typeof vi.fn>;
let runtimeInstance: {
  addAgent: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  unwatchAgentsDir: ReturnType<typeof vi.fn>;
  watchAgentsDir: ReturnType<typeof vi.fn>;
  onReconnect: ReturnType<typeof vi.fn>;
  onAuthPaused: ReturnType<typeof vi.fn>;
  onRuntimeAuthStart: ReturnType<typeof vi.fn>;
  onProviderModelsList: ReturnType<typeof vi.fn>;
  sendProviderModelsResult: ReturnType<typeof vi.fn>;
  emitConnectionResilienceEvent: ReturnType<typeof vi.fn>;
  isPaused: ReturnType<typeof vi.fn>;
};
let refresherInstance: {
  start: ReturnType<typeof vi.fn>;
  onReconnect: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  isInteractive: ReturnType<typeof vi.fn>;
  beginInteractive: ReturnType<typeof vi.fn>;
  endInteractive: ReturnType<typeof vi.fn>;
  currentEntry: ReturnType<typeof vi.fn>;
  setProviderEntry: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ft-daemon-start-"));
  mkdirSync(join(home, "config", "agents", "nova"), { recursive: true });
  writeFileSync(
    join(home, "config", "client.yaml"),
    "server:\n  url: https://first-tree.example\nclient:\n  id: client_1234abcd\n",
  );
  writeFileSync(join(home, "config", "agents", "nova", "agent.yaml"), "agentId: agent-1\nruntime: claude-code\n");
  process.env.FIRST_TREE_HOME = home;
  delete process.env.FIRST_TREE_SERVER_URL;
  delete process.env.FIRST_TREE_SERVICE_MODE;
  // Host agent / portable installs inject FIRST_TREE_CLIENT_ID; it must not
  // override the fixture client.yaml id used by these assertions.
  delete process.env.FIRST_TREE_CLIENT_ID;

  for (const mock of Object.values(clientMocks)) mock.mockReset();
  for (const mock of Object.values(coreMocks)) mock.mockReset();
  failMock.mockClear();
  stderrSpy.mockClear();
  exitSpy.mockClear();
  exitSpy.mockImplementation((code?: string | number | null | undefined) => {
    throw Object.assign(new Error(`process.exit ${code}`), { exitCode: code });
  });

  clientMocks.probeCapabilities.mockResolvedValue({ "claude-code": { state: "ok" } });
  clientMocks.probeCodexCapability.mockResolvedValue({
    state: "ok",
    available: true,
    runtimeSource: "path",
    runtimePath: "/Applications/ChatGPT.app/Contents/Resources/codex",
    detectedAt: "2026-08-20T00:00:00.000Z",
  });
  codexCandidateChangeListener = null;
  unregisterCodexCandidateChange = vi.fn();
  clientMocks.onCodexVerifiedAutomaticCandidateChange.mockImplementation((listener: () => void) => {
    codexCandidateChangeListener = listener;
    return unregisterCodexCandidateChange;
  });
  clientMocks.createLogger.mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });
  clientMocks.reprobeOnReconnect.mockResolvedValue({
    capabilities: { "claude-code": { state: "ok" } },
    mode: "revalidate",
  });
  clientMocks.discoverClaudeCodeSkills.mockResolvedValue([{ name: "review", description: "Review code." }]);
  coreMocks.loadCredentials.mockReturnValue({ refreshToken: "refresh" });
  coreMocks.loadDaemonEnv.mockReturnValue([]);
  coreMocks.getClientSwitchStartupBlock.mockReturnValue(null);
  runtimeOwnershipRelease = vi.fn();
  coreMocks.acquireDaemonRuntimeOwnership.mockReturnValue({
    lockPath: join(home, "state", "daemon-runtime.lock"),
    owner: { instanceId: "owner-test" },
    release: runtimeOwnershipRelease,
  });
  coreMocks.isDaemonRuntimeOwnershipError.mockImplementation(
    (error: unknown) => typeof error === "object" && error !== null && "daemonOwnership" in error,
  );
  coreMocks.daemonRuntimeHomesEqual.mockImplementation((left: string, right: string) => left === right);
  coreMocks.resolveClientRuntimeStopReason.mockReturnValue(undefined);
  coreMocks.isServiceSupported.mockReturnValue(false);
  coreMocks.getClientServiceStatus.mockReturnValue({
    platform: "launchd",
    state: "not-installed",
    label: "dev.first-tree",
    logDir: join(home, "logs"),
  });
  coreMocks.startClientService.mockReturnValue({ ok: true });
  coreMocks.ensureFreshAccessToken.mockResolvedValue("access-token");
  coreMocks.listPinnedAgents.mockResolvedValue([
    { agentId: "agent-1", clientId: "client_1234abcd", runtimeProvider: "claude-code", status: "active" },
  ]);
  coreMocks.promptMissingFields.mockResolvedValue(undefined);
  coreMocks.registerClientRuntimeMarker.mockReturnValue(vi.fn());
  coreMocks.createApiNameResolver.mockReturnValue(async () => "nova");
  coreMocks.createExecuteUpdate.mockReturnValue(async () => undefined);
  coreMocks.createLoggerRuntimeOutput.mockImplementation(
    (logger: {
      error: (message: string) => void;
      info: (message: string) => void;
      warn: (message: string) => void;
    }) => ({
      blank: vi.fn(),
      check: vi.fn((pass: boolean, label: string, detail?: string) => {
        logger[pass ? "info" : "warn"](detail ? `${label}: ${detail}` : label);
      }),
      line: vi.fn((text: string) => {
        const message = text.trim();
        if (message) logger.info(message);
      }),
      status: vi.fn((symbol: string, msg: string) => {
        const level = symbol === "⚠️" ? "warn" : symbol === "✗" ? "error" : "info";
        logger[level](symbol ? `${symbol} ${msg}` : msg);
      }),
    }),
  );
  coreMocks.migrateLocalAgentDirs.mockResolvedValue(undefined);
  coreMocks.reconcileLocalRuntimeProviders.mockResolvedValue(undefined);
  coreMocks.runRuntimeAuthLogin.mockResolvedValue(undefined);
  coreMocks.uploadClientCapabilities.mockResolvedValue(undefined);
  coreMocks.uploadAgentSkills.mockResolvedValue(undefined);

  runtimeInstance = {
    addAgent: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    unwatchAgentsDir: vi.fn(),
    watchAgentsDir: vi.fn(() => {
      throw new Error("stop after watch");
    }),
    onReconnect: vi.fn(),
    onAuthPaused: vi.fn(),
    onRuntimeAuthStart: vi.fn(),
    onProviderModelsList: vi.fn(),
    sendProviderModelsResult: vi.fn(),
    emitConnectionResilienceEvent: vi.fn(),
    isPaused: vi.fn(() => false),
  };
  coreMocks.ClientRuntime.mockImplementation(() => runtimeInstance);

  refresherInstance = {
    start: vi.fn(async () => undefined),
    onReconnect: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    isInteractive: vi.fn(() => false),
    beginInteractive: vi.fn(),
    endInteractive: vi.fn(),
    currentEntry: vi.fn(() => undefined),
    setProviderEntry: vi.fn(),
  };
  coreMocks.CapabilityRefresher.mockImplementation(() => refresherInstance);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalHome;
  if (originalServerUrl === undefined) delete process.env.FIRST_TREE_SERVER_URL;
  else process.env.FIRST_TREE_SERVER_URL = originalServerUrl;
  if (originalServiceMode === undefined) delete process.env.FIRST_TREE_SERVICE_MODE;
  else process.env.FIRST_TREE_SERVICE_MODE = originalServiceMode;
  if (originalClientId === undefined) delete process.env.FIRST_TREE_CLIENT_ID;
  else process.env.FIRST_TREE_CLIENT_ID = originalClientId;
});

async function runStart(args: string[] = []): Promise<unknown> {
  const { resetConfig, resetConfigMeta } = await import("@first-tree/shared/config");
  resetConfig();
  resetConfigMeta();
  const { registerDaemonStartCommand } = await import("../commands/daemon/start.js");
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  const daemon = program.command("daemon");
  registerDaemonStartCommand(daemon);
  return program.parseAsync(["node", "test", "daemon", "start", ...args]);
}

function output(): string {
  return stderrSpy.mock.calls.map((call) => String(call[0])).join("");
}

async function waitForAsyncWork(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("daemon start command", () => {
  it("fails closed when credentials are missing", async () => {
    coreMocks.loadCredentials.mockReturnValueOnce(null);

    await expect(runStart()).rejects.toMatchObject({ code: "NO_CREDENTIALS", exitCode: 1 });
    expect(failMock).toHaveBeenCalledWith("NO_CREDENTIALS", expect.stringContaining("no credentials"), 1);
  });

  it("parks daemon startup before reading credentials while a client switch is in progress", async () => {
    coreMocks.getClientSwitchStartupBlock.mockReturnValueOnce({
      lockPath: join(home, "state", "client-switch.lock"),
      journalPath: join(home, "state", "client-switch-journal.json"),
    });

    await expect(runStart()).resolves.toBeTruthy();

    expect(coreMocks.loadCredentials).not.toHaveBeenCalled();
    expect(coreMocks.ClientRuntime).not.toHaveBeenCalled();
    expect(output()).toContain("client switch is in progress");
  });

  it("lets supervisor children exit 0 before root state reads during a client switch", async () => {
    process.env.FIRST_TREE_SERVICE_MODE = "1";
    coreMocks.getClientSwitchStartupBlock.mockReturnValueOnce({
      lockPath: join(home, "state", "client-switch.lock"),
      journalPath: join(home, "state", "client-switch-journal.json"),
    });

    await expect(runStart(["--no-interactive"])).rejects.toMatchObject({ exitCode: 0 });

    expect(coreMocks.loadCredentials).not.toHaveBeenCalled();
    expect(coreMocks.ClientRuntime).not.toHaveBeenCalled();
  });

  it("refuses when the background service is already active", async () => {
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.getClientServiceStatus.mockReturnValueOnce({
      platform: "systemd",
      state: "active",
      label: "first-tree.service",
      detail: "pid 123",
      logDir: "/logs",
    });

    await expect(runStart()).resolves.toBeTruthy();
    expect(output()).toContain("Service is already running");
    expect(output()).toContain("stop it before running `first-tree-dev daemon start --foreground`");
    expect(coreMocks.acquireDaemonRuntimeOwnership).not.toHaveBeenCalled();
    expect(coreMocks.ClientRuntime).not.toHaveBeenCalled();

    stderrSpy.mockClear();
    coreMocks.getClientServiceStatus.mockReturnValueOnce({
      platform: "systemd",
      state: "active",
      label: "first-tree.service",
      logDir: "/logs",
    });

    await expect(runStart()).resolves.toBeTruthy();
    expect(output()).toContain("Service is already running (systemd).");
  });

  it("preflights an active service before an explicit foreground start", async () => {
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.getClientServiceStatus.mockReturnValue({
      platform: "launchd",
      state: "active",
      label: "first-tree-dev",
      detail: "pid 123",
      logDir: "/logs",
      configuredHome: home,
    });

    await expect(runStart(["--foreground"])).rejects.toMatchObject({ exitCode: 1 });

    expect(output()).toContain("Cannot start a foreground daemon while the launchd service is active (pid 123)");
    expect(output()).toContain("`first-tree-dev daemon stop`");
    expect(coreMocks.acquireDaemonRuntimeOwnership).not.toHaveBeenCalled();
    expect(coreMocks.promptMissingFields).not.toHaveBeenCalled();
    expect(coreMocks.ClientRuntime).not.toHaveBeenCalled();
  });

  it("lets an explicit foreground home run beside an active service for a different home", async () => {
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.getClientServiceStatus.mockReturnValue({
      platform: "launchd",
      state: "active",
      label: "first-tree-dev",
      detail: "pid 123",
      logDir: "/logs",
      configuredHome: join(home, "service-home"),
    });

    await expect(runStart(["--foreground"])).rejects.toMatchObject({ exitCode: 1 });

    expect(output()).not.toContain("Cannot start a foreground daemon while the launchd service is active");
    expect(coreMocks.acquireDaemonRuntimeOwnership).toHaveBeenCalledWith({
      channel: "dev",
      home,
      mode: "foreground",
      version: "0.0.0-test",
    });
    expect(coreMocks.promptMissingFields).toHaveBeenCalled();
    expect(coreMocks.ClientRuntime).toHaveBeenCalled();
  });

  it("starts an inactive service and prints log hints", async () => {
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.getClientServiceStatus
      .mockReturnValueOnce({ platform: "systemd", state: "inactive", label: "first-tree.service", logDir: "/logs" })
      .mockReturnValueOnce({
        platform: "systemd",
        state: "active",
        label: "first-tree.service",
        detail: "pid 123",
        logDir: "/logs",
      });

    await expect(runStart()).resolves.toBeTruthy();
    expect(coreMocks.startClientService).toHaveBeenCalled();
    expect(output()).toContain("Started systemd service");
    expect(output()).toContain("Logs:  /logs/client.log");
    expect(output()).toContain("Supervisor fallback: `journalctl --user -u first-tree`");
  });

  it("prints system journal hints for root systemd services", async () => {
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.getClientServiceStatus
      .mockReturnValueOnce({
        platform: "systemd",
        state: "inactive",
        label: "first-tree.service",
        logDir: "/logs",
        managerScope: "system",
      })
      .mockReturnValueOnce({
        platform: "systemd",
        state: "active",
        label: "first-tree.service",
        detail: "pid 123",
        logDir: "/logs",
        managerScope: "system",
      });

    await expect(runStart()).resolves.toBeTruthy();
    expect(coreMocks.startClientService).toHaveBeenCalled();
    expect(output()).toContain("Supervisor fallback: `journalctl -u first-tree`");
    expect(output()).not.toContain("journalctl --user -u first-tree");
  });

  it("starts an inactive launchd service and prints stdout/stderr fallback logs", async () => {
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.getClientServiceStatus
      .mockReturnValueOnce({ platform: "launchd", state: "inactive", label: "first-tree", logDir: "/logs" })
      .mockReturnValueOnce({
        platform: "launchd",
        state: "active",
        label: "first-tree",
        logDir: "/logs",
      });

    await expect(runStart()).resolves.toBeTruthy();

    expect(output()).toContain("Started launchd service.");
    expect(output()).toContain("/logs/client.stdout.log / /logs/client.stderr.log");
  });

  it("starts an inactive Windows Task Scheduler service and prints supervisor fallback log", async () => {
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.getClientServiceStatus
      .mockReturnValueOnce({
        platform: "task-scheduler",
        state: "inactive",
        label: "\\FirstTree\\first-tree",
        logDir: "/logs",
      })
      .mockReturnValueOnce({
        platform: "task-scheduler",
        state: "active",
        label: "\\FirstTree\\first-tree",
        detail: "pid 123",
        logDir: "/logs",
      });

    await expect(runStart()).resolves.toBeTruthy();

    expect(output()).toContain("Started task-scheduler service (pid 123).");
    expect(output()).toContain("Logs:  /logs/client.log");
    expect(output()).toContain("Supervisor log: /logs/supervisor.log");
    expect(output()).toContain("Wrapper fallback: /logs/supervisor-wrapper.log");
  });

  it("prints WSL repair guidance when service startup fails", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.getClientServiceStatus.mockReturnValueOnce({
      platform: "systemd",
      state: "inactive",
      label: "first-tree.service",
      logDir: "/logs",
    });
    coreMocks.startClientService.mockReturnValueOnce({
      ok: false,
      reason: "Failed to connect to bus: No such file or directory",
    });

    await expect(runStart()).rejects.toMatchObject({ exitCode: 1 });
    expect(output()).toContain("Failed to start service");
    expect(output()).toContain("WSL2 detected");
    expect(output()).toContain("sudo umount -l /run/user/$(id -u)");
    expect(output()).toContain("Try `--foreground` to run inline instead.");
  });

  it("refuses unknown service state", async () => {
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.getClientServiceStatus.mockReturnValueOnce({
      platform: "launchd",
      state: "unknown",
      label: "dev.first-tree",
      detail: "confused",
      logDir: "/logs",
    });

    await expect(runStart()).rejects.toMatchObject({ exitCode: 1 });
    expect(output()).toContain("Service state could not be determined");

    stderrSpy.mockClear();
    coreMocks.getClientServiceStatus.mockReturnValueOnce({
      platform: "launchd",
      state: "unknown",
      label: "dev.first-tree",
      logDir: "/logs",
    });

    await expect(runStart()).rejects.toMatchObject({ exitCode: 1 });
    expect(output()).toContain("Service state could not be determined (launchd).");

    stderrSpy.mockClear();
    coreMocks.getClientServiceStatus.mockReturnValueOnce({
      platform: "systemd",
      state: "unknown",
      label: "first-tree.service",
      detail:
        "legacy root systemd user unit requires out-of-service migration: /root/.config/systemd/user/first-tree.service",
      logDir: "/logs",
      managerScope: "user",
      migrationRequired: "root-systemd-user-to-system",
    });

    await expect(runStart()).rejects.toMatchObject({ exitCode: 1 });
    expect(output()).toContain("legacy root systemd user unit requires out-of-service migration");
    expect(output()).toContain("Complete the root systemd migration out-of-service with `first-tree-dev login <code>`");
    expect(output()).not.toContain("--foreground");
    expect(coreMocks.startClientService).not.toHaveBeenCalled();
    expect(coreMocks.ClientRuntime).not.toHaveBeenCalled();

    stderrSpy.mockClear();
    coreMocks.getClientServiceStatus.mockReturnValueOnce({
      platform: "systemd",
      state: "unknown",
      label: "first-tree.service",
      detail:
        "legacy root systemd user unit requires out-of-service migration: /root/.config/systemd/user/first-tree.service",
      logDir: "/logs",
      managerScope: "user",
      migrationRequired: "root-systemd-user-to-system",
    });

    await expect(runStart(["--foreground"])).rejects.toMatchObject({ exitCode: 1 });
    expect(output()).toContain("Service migration is required before foreground start");
    expect(output()).toContain("Complete the root systemd migration out-of-service with `first-tree-dev login <code>`");
    expect(coreMocks.ClientRuntime).not.toHaveBeenCalled();
  });

  it("runs inline, reconciles local state, uploads capabilities and skills", async () => {
    await expect(runStart(["--foreground"])).rejects.toMatchObject({ exitCode: 1 });

    expect(coreMocks.acquireDaemonRuntimeOwnership).toHaveBeenCalledWith({
      channel: "dev",
      home,
      mode: "foreground",
      version: "0.0.0-test",
    });
    expect(coreMocks.acquireDaemonRuntimeOwnership.mock.invocationCallOrder[0]).toBeLessThan(
      coreMocks.promptMissingFields.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(coreMocks.promptMissingFields).toHaveBeenCalledWith(expect.objectContaining({ noInteractive: false }));
    expect(clientMocks.applyClientLoggerConfig).toHaveBeenCalledWith({ level: "info" });
    expect(coreMocks.migrateLocalAgentDirs).toHaveBeenCalled();
    expect(clientMocks.probeCapabilities).not.toHaveBeenCalled();
    expect(coreMocks.reconcileLocalRuntimeProviders).toHaveBeenCalled();
    expect(coreMocks.ClientRuntime).toHaveBeenCalledWith(
      "https://first-tree.example",
      "client_1234abcd",
      expect.objectContaining({ currentVersion: "0.0.0-test" }),
    );
    expect(coreMocks.ensureActiveRootClientIdPersisted).toHaveBeenCalledWith("client_1234abcd");
    expect(coreMocks.registerClientRuntimeMarker).toHaveBeenCalledWith({
      clientId: "client_1234abcd",
      mode: "foreground",
    });
    expect(runtimeInstance.addAgent).toHaveBeenCalledWith("nova", expect.objectContaining({ agentId: "agent-1" }));
    expect(runtimeInstance.start).toHaveBeenCalled();
    // Capability refresh is owned by the refresher: daemon start no longer runs
    // a blocking provider smoke before Connecting; the refresher starts the
    // post-registration background full probe.
    expect(coreMocks.CapabilityRefresher).toHaveBeenCalledWith(
      expect.objectContaining({ upload: expect.any(Function), log: expect.any(Function) }),
    );
    expect(coreMocks.CapabilityRefresher.mock.calls[0]?.[0]).not.toHaveProperty("initial");
    expect(runtimeInstance.onReconnect).toHaveBeenCalledWith(expect.any(Function));
    expect(runtimeInstance.onProviderModelsList).toHaveBeenCalledWith(expect.any(Function));
    expect(refresherInstance.start).toHaveBeenCalled();
    expect(coreMocks.listPinnedAgents).toHaveBeenCalledWith({
      serverUrl: "https://first-tree.example",
      accessToken: "access-token",
    });
    expect(coreMocks.uploadAgentSkills).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1", skills: [{ name: "review", description: "Review code." }] }),
    );
    expect(runtimeInstance.watchAgentsDir).toHaveBeenCalledWith(join(home, "config", "agents"));

    const reconcileOptions = coreMocks.reconcileLocalRuntimeProviders.mock.calls[0]?.[0] as
      | { log?: (level: "info" | "warn", message: string) => void }
      | undefined;
    reconcileOptions?.log?.("warn", "runtime changed");
    reconcileOptions?.log?.("info", "runtime checked");

    const refresherOptions = coreMocks.CapabilityRefresher.mock.calls[0]?.[0] as
      | { log?: (symbol: string, message: string) => void }
      | undefined;
    refresherOptions?.log?.("•", "capability refreshed");

    const skillScanOptions = clientMocks.discoverClaudeCodeSkills.mock.calls[0]?.[0] as
      | { warn?: (message: string) => void }
      | undefined;
    skillScanOptions?.warn?.("slow scan");

    expect(output()).toContain("Error: stop after watch");
    expect(output()).toContain("runtime changed");
    expect(output()).toContain("runtime checked");
    expect(output()).toContain("capability refreshed");
    expect(output()).toContain("skill scan: slow scan");
  });

  it("stops the inline daemon runtime cleanly when SIGINT is received", async () => {
    const signalHandlers = new Map<string, () => void>();
    const onSpy = vi.spyOn(process, "on").mockImplementation((event, listener) => {
      if (event === "SIGINT" || event === "SIGTERM") {
        signalHandlers.set(event, listener as () => void);
      }
      return process;
    });
    exitSpy.mockImplementation((() => undefined) as never);
    runtimeInstance.watchAgentsDir.mockImplementation(() => undefined);

    try {
      void runStart(["--foreground"]).catch(() => undefined);
      await waitForAsyncWork(() => signalHandlers.has("SIGINT"));

      const shutdown = signalHandlers.get("SIGINT");
      expect(shutdown).toBeTypeOf("function");
      shutdown?.();
      await waitForAsyncWork(() => exitSpy.mock.calls.length > 0);

      expect(output()).toContain("Shutting down");
      expect(refresherInstance.stop).toHaveBeenCalled();
      expect(runtimeInstance.unwatchAgentsDir).toHaveBeenCalled();
      expect(runtimeInstance.stop).toHaveBeenCalledWith(undefined);
      expect(coreMocks.registerClientRuntimeMarker.mock.results[0]?.value).toHaveBeenCalled();
      expect(runtimeOwnershipRelease).toHaveBeenCalled();
      expect(clientMocks.flushClientSentry).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      onSpy.mockRestore();
    }
  });

  it("reports loaded daemon.env variables before inline startup", async () => {
    coreMocks.loadDaemonEnv.mockReturnValueOnce(["HTTPS_PROXY", "NO_PROXY"]);

    await expect(runStart(["--foreground"])).rejects.toMatchObject({ exitCode: 1 });

    expect(output()).toContain("loaded 2 var(s) from daemon.env (HTTPS_PROXY, NO_PROXY)");
  });

  it("wires update failure and capability upload callbacks", async () => {
    await expect(runStart(["--foreground"])).rejects.toMatchObject({ exitCode: 1 });

    const executeUpdateOptions = coreMocks.createExecuteUpdate.mock.calls[0]?.[0] as
      | { onUpdateFailed?: (payload: unknown) => void }
      | undefined;
    executeUpdateOptions?.onUpdateFailed?.({ reasonCode: "npm_timeout" });
    expect(runtimeInstance.emitConnectionResilienceEvent).toHaveBeenCalledWith("resilience.update.failed", {
      reasonCode: "npm_timeout",
    });

    const refresherOptions = coreMocks.CapabilityRefresher.mock.calls[0]?.[0] as
      | { upload?: (capabilities: unknown) => Promise<void>; log?: (symbol: string, message: string) => void }
      | undefined;
    await refresherOptions?.upload?.({ "claude-code": { state: "ok" } });

    expect(coreMocks.uploadClientCapabilities).toHaveBeenCalledWith({
      serverUrl: "https://first-tree.example",
      accessToken: "access-token",
      clientId: "client_1234abcd",
      capabilities: { "claude-code": { state: "ok" } },
    });

    refresherOptions?.log?.("✓", "manual log check");
    expect(output()).toContain("manual log check");
  });

  it("routes the runtime's reconnect callback into the capability refresher", async () => {
    await expect(runStart(["--foreground"])).rejects.toMatchObject({ exitCode: 1 });

    // start.ts no longer re-probes inline; it hands the runtime's reconnect
    // signal to the refresher (whose probe/upload/dedup behavior is covered by
    // capability-refresh.test.ts).
    const reconnect = runtimeInstance.onReconnect.mock.calls[0]?.[0];
    if (typeof reconnect !== "function") throw new Error("Reconnect callback was not registered");

    expect(refresherInstance.onReconnect).not.toHaveBeenCalled();
    reconnect();
    expect(refresherInstance.onReconnect).toHaveBeenCalledTimes(1);
  });

  it("serializes runtime-auth login requests per provider", async () => {
    await expect(runStart(["--foreground"])).rejects.toMatchObject({ exitCode: 1 });

    const runtimeAuthStart = runtimeInstance.onRuntimeAuthStart.mock.calls[0]?.[0] as
      | ((command: { provider: string; ref: string }) => void)
      | undefined;
    if (typeof runtimeAuthStart !== "function") throw new Error("runtime-auth callback was not registered");

    refresherInstance.isInteractive.mockReturnValueOnce(true);
    runtimeAuthStart({ provider: "codex", ref: "dup" });
    expect(output()).toContain("runtime-auth: codex login already in progress");
    expect(coreMocks.runRuntimeAuthLogin).not.toHaveBeenCalled();

    refresherInstance.isInteractive.mockReturnValueOnce(false);
    runtimeAuthStart({ provider: "codex", ref: "fresh" });
    await Promise.resolve();
    await Promise.resolve();

    expect(refresherInstance.beginInteractive).toHaveBeenCalledWith("codex");
    expect(coreMocks.runRuntimeAuthLogin).toHaveBeenCalledWith(
      { provider: "codex", ref: "fresh" },
      expect.objectContaining({
        currentEntry: expect.any(Function),
        setProviderEntry: expect.any(Function),
        log: expect.any(Function),
      }),
    );
    const deps = coreMocks.runRuntimeAuthLogin.mock.calls[0]?.[1] as
      | {
          currentEntry: (provider: string) => unknown;
          setProviderEntry: (provider: string, entry: unknown) => Promise<void>;
          log: (symbol: string, message: string) => void;
        }
      | undefined;
    deps?.currentEntry("codex");
    await deps?.setProviderEntry("codex", { state: "ok" });
    deps?.log("•", "runtime auth progress");
    expect(refresherInstance.endInteractive).toHaveBeenCalledWith("codex");
    expect(refresherInstance.currentEntry).toHaveBeenCalledWith("codex");
    expect(refresherInstance.setProviderEntry).toHaveBeenCalledWith("codex", { state: "ok" });
    expect(output()).toContain("runtime auth progress");
  });

  it("publishes a runtime-verified Codex selection through the live capability refresher", async () => {
    runtimeInstance.start.mockImplementationOnce(async () => {
      codexCandidateChangeListener?.();
    });

    await expect(runStart(["--foreground"])).rejects.toMatchObject({ exitCode: 1 });
    await waitForAsyncWork(() => refresherInstance.setProviderEntry.mock.calls.length > 0);

    expect(clientMocks.onCodexVerifiedAutomaticCandidateChange).toHaveBeenCalledTimes(1);
    expect(clientMocks.probeCodexCapability).toHaveBeenCalledTimes(1);
    expect(refresherInstance.start).toHaveBeenCalledTimes(1);
    expect(refresherInstance.setProviderEntry).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({
        state: "ok",
        runtimePath: "/Applications/ChatGPT.app/Contents/Resources/codex",
      }),
    );
    expect(unregisterCodexCandidateChange).toHaveBeenCalledTimes(1);
  });

  it("defers in-flight Codex provenance and preserves a terminal auth failure", async () => {
    const verifiedEntry = {
      state: "ok" as const,
      available: true,
      runtimeSource: "path" as const,
      runtimePath: "/Applications/ChatGPT.app/Contents/Resources/codex",
      detectedAt: "2026-08-20T00:00:00.000Z",
    };
    let resolveProbe!: (entry: typeof verifiedEntry) => void;
    const delayedProbe = new Promise<typeof verifiedEntry>((resolve) => {
      resolveProbe = resolve;
    });
    clientMocks.probeCodexCapability.mockReturnValueOnce(delayedProbe);

    let finishLogin!: () => void;
    const loginPending = new Promise<void>((resolve) => {
      finishLogin = resolve;
    });
    const pendingEntry = {
      state: "ok" as const,
      pendingAuth: {
        method: "browser" as const,
        expiresAt: "2026-08-20T00:05:00.000Z",
      },
    };
    const failedEntry = {
      ...verifiedEntry,
      lastAuthError: {
        reason: "exit-nonzero" as const,
        message: "account not authorized",
        at: "2026-08-20T00:01:00.000Z",
      },
    };
    coreMocks.runRuntimeAuthLogin.mockImplementationOnce(
      async (
        _command: { provider: string; ref: string },
        deps: { setProviderEntry: (provider: string, entry: unknown) => Promise<void> },
      ) => {
        await deps.setProviderEntry("codex", pendingEntry);
        await loginPending;
        await deps.setProviderEntry("codex", failedEntry);
      },
    );

    let codexInteractive = false;
    refresherInstance.isInteractive.mockImplementation((provider: string) => provider === "codex" && codexInteractive);
    refresherInstance.beginInteractive.mockImplementation((provider: string) => {
      if (provider === "codex") codexInteractive = true;
    });
    refresherInstance.endInteractive.mockImplementation((provider: string) => {
      if (provider === "codex") codexInteractive = false;
    });
    let currentCodexEntry: unknown;
    refresherInstance.currentEntry.mockImplementation((provider: string) =>
      provider === "codex" ? currentCodexEntry : undefined,
    );
    refresherInstance.setProviderEntry.mockImplementation(async (provider: string, entry: unknown) => {
      if (provider === "codex") currentCodexEntry = entry;
    });

    let finishSkillUpload!: () => void;
    const skillUploadPending = new Promise<void>((resolve) => {
      finishSkillUpload = resolve;
    });
    coreMocks.uploadAgentSkills.mockImplementationOnce(async () => {
      codexCandidateChangeListener?.();
      await skillUploadPending;
    });

    const start = runStart(["--foreground"]);
    await waitForAsyncWork(() => clientMocks.probeCodexCapability.mock.calls.length === 1);

    const runtimeAuthStart = runtimeInstance.onRuntimeAuthStart.mock.calls[0]?.[0] as
      | ((command: { provider: string; ref: string }) => void)
      | undefined;
    if (typeof runtimeAuthStart !== "function") throw new Error("runtime-auth callback was not registered");
    runtimeAuthStart({ provider: "codex", ref: "pending-provenance" });
    await waitForAsyncWork(() =>
      refresherInstance.setProviderEntry.mock.calls.some(
        ([provider, entry]) => provider === "codex" && entry === pendingEntry,
      ),
    );

    // The launch-free provenance probe finishes after pendingAuth is visible.
    // Its plain entry must not replace the interactive row.
    resolveProbe(verifiedEntry);
    await Promise.resolve();
    await Promise.resolve();
    expect(refresherInstance.setProviderEntry).not.toHaveBeenCalledWith("codex", verifiedEntry);

    finishLogin();
    await waitForAsyncWork(() => refresherInstance.setProviderEntry.mock.calls.length === 3);
    expect(refresherInstance.endInteractive).toHaveBeenCalledWith("codex");
    expect(refresherInstance.setProviderEntry.mock.calls.slice(0, 2)).toEqual([
      ["codex", pendingEntry],
      ["codex", failedEntry],
    ]);
    const publishedAfterFailure = refresherInstance.setProviderEntry.mock.calls[2]?.[1];
    expect(publishedAfterFailure).toMatchObject({
      runtimePath: verifiedEntry.runtimePath,
      lastAuthError: failedEntry.lastAuthError,
    });
    expect(publishedAfterFailure).not.toHaveProperty("pendingAuth");

    finishSkillUpload();
    await expect(start).rejects.toMatchObject({ exitCode: 1 });
  });

  it("skips skill upload for stale local aliases that are not pinned to this client", async () => {
    mkdirSync(join(home, "config", "agents", "developer"), { recursive: true });
    writeFileSync(
      join(home, "config", "agents", "developer", "agent.yaml"),
      "agentId: stale-agent\nruntime: claude-code\n",
    );

    await expect(runStart(["--foreground"])).rejects.toMatchObject({ exitCode: 1 });

    expect(runtimeInstance.addAgent).toHaveBeenCalledWith(
      "developer",
      expect.objectContaining({ agentId: "stale-agent" }),
    );
    expect(coreMocks.uploadAgentSkills).toHaveBeenCalledTimes(1);
    expect(coreMocks.uploadAgentSkills).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent-1" }));
    expect(output()).toContain("skills upload for developer skipped");
    expect(output()).toContain("agent prune --dry-run");
  });

  it("skips skill upload for agents pinned to another client", async () => {
    coreMocks.listPinnedAgents.mockResolvedValueOnce([
      { agentId: "agent-1", clientId: "client_other123", runtimeProvider: "claude-code", status: "active" },
    ]);

    await expect(runStart(["--foreground"])).rejects.toMatchObject({ exitCode: 1 });

    expect(coreMocks.uploadAgentSkills).not.toHaveBeenCalled();
    expect(output()).toContain("pinned to another client (client_other123)");
  });

  it("keeps best-effort skill upload when pinned-agent filtering is unavailable", async () => {
    coreMocks.listPinnedAgents.mockRejectedValueOnce(new Error("pin check failed"));

    await expect(runStart(["--foreground"])).rejects.toMatchObject({ exitCode: 1 });

    expect(coreMocks.uploadAgentSkills).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent-1" }));
    expect(output()).toContain("skills upload pin check skipped: pin check failed");
  });

  it("uses service-mode logging and non-interactive prompts for supervisor children", async () => {
    process.env.FIRST_TREE_SERVICE_MODE = "1";
    await expect(runStart(["--no-interactive"])).rejects.toMatchObject({ exitCode: 1 });

    expect(coreMocks.promptMissingFields).toHaveBeenCalledWith(expect.objectContaining({ noInteractive: true }));
    expect(coreMocks.createExecuteUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ log: expect.any(Function), managed: true }),
    );
    const updateOptions = coreMocks.createExecuteUpdate.mock.calls[0]?.[0] as
      | { log?: (level: "info" | "warn" | "error" | "debug", message: string) => void }
      | undefined;
    updateOptions?.log?.("warn", "managed warning");
    expect(clientMocks.createLogger.mock.results.at(-1)?.value.warn).toHaveBeenCalledWith("managed warning");
    expect(clientMocks.configureClientLoggerForService).toHaveBeenCalledWith(join(home, "logs"));
    expect(clientMocks.applyClientLoggerConfig).toHaveBeenCalledWith({ level: "info" });
    expect(coreMocks.createLoggerRuntimeOutput).toHaveBeenCalledWith(expect.any(Object));
    expect(coreMocks.acquireDaemonRuntimeOwnership).toHaveBeenCalledWith({
      channel: "dev",
      home,
      mode: "service",
      version: "0.0.0-test",
    });
    expect(coreMocks.ClientRuntime).toHaveBeenCalledWith(
      "https://first-tree.example",
      "client_1234abcd",
      expect.objectContaining({
        output: expect.any(Object),
        update: expect.objectContaining({ prompt: coreMocks.declineUpdate }),
      }),
    );
    expect(output()).toBe("");
  });

  it("settles a supervisor ownership collision without a restart-triggering failure", async () => {
    const daemonLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    clientMocks.createLogger.mockReturnValue(daemonLogger);
    process.env.FIRST_TREE_SERVICE_MODE = "1";
    coreMocks.acquireDaemonRuntimeOwnership.mockImplementationOnce(() => {
      throw Object.assign(new Error("home is already held by pid 321 (foreground)"), { daemonOwnership: true });
    });

    await expect(runStart(["--no-interactive"])).resolves.toBeTruthy();

    expect(daemonLogger.error).toHaveBeenCalledWith(
      "✗ home is already held by pid 321 (foreground); supervisor child is stopping without restart.",
    );
    expect(exitSpy).not.toHaveBeenCalled();
    expect(coreMocks.promptMissingFields).not.toHaveBeenCalled();
    expect(coreMocks.ClientRuntime).not.toHaveBeenCalled();
  });

  it("fails a manual inline start with the live owner details", async () => {
    coreMocks.acquireDaemonRuntimeOwnership.mockImplementationOnce(() => {
      throw Object.assign(new Error("home is already held by pid 654 (service)"), {
        code: "DAEMON_RUNTIME_ALREADY_RUNNING",
        daemonOwnership: true,
      });
    });

    await expect(runStart(["--foreground"])).rejects.toMatchObject({ exitCode: 1 });

    expect(failMock).toHaveBeenCalledWith(
      "DAEMON_RUNTIME_ALREADY_RUNNING",
      "home is already held by pid 654 (service)",
      1,
    );
    expect(clientMocks.captureClientException).not.toHaveBeenCalled();
    expect(coreMocks.promptMissingFields).not.toHaveBeenCalled();
    expect(coreMocks.ClientRuntime).not.toHaveBeenCalled();
  });

  it("treats explicit foreground as foreground even when service-mode env is inherited", async () => {
    process.env.FIRST_TREE_SERVICE_MODE = "1";

    await expect(runStart(["--foreground", "--no-interactive"])).rejects.toMatchObject({ exitCode: 1 });

    expect(coreMocks.registerClientRuntimeMarker).toHaveBeenCalledWith({
      clientId: "client_1234abcd",
      mode: "foreground",
    });
    expect(clientMocks.configureClientLoggerForService).not.toHaveBeenCalled();
    expect(coreMocks.createLoggerRuntimeOutput).not.toHaveBeenCalled();
  });

  it("logs early service-mode startup failures before config logLevel is applied", async () => {
    const daemonLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    clientMocks.createLogger.mockReturnValue(daemonLogger);
    process.env.FIRST_TREE_SERVICE_MODE = "1";
    coreMocks.promptMissingFields.mockRejectedValueOnce(new Error("client.yaml is malformed"));

    await expect(runStart(["--no-interactive"])).rejects.toMatchObject({ exitCode: 1 });

    expect(clientMocks.configureClientLoggerForService).toHaveBeenCalledWith(join(home, "logs"));
    expect(clientMocks.applyClientLoggerConfig).toHaveBeenCalledWith({ level: "info" });
    expect(daemonLogger.error).toHaveBeenCalledWith("✗ Error: client.yaml is malformed");
    expect(coreMocks.ClientRuntime).not.toHaveBeenCalled();
    expect(output()).toBe("");
  });

  it("logs missing credentials through the service logger instead of CLI stderr", async () => {
    const daemonLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    clientMocks.createLogger.mockReturnValue(daemonLogger);
    process.env.FIRST_TREE_SERVICE_MODE = "1";
    coreMocks.loadCredentials.mockReturnValueOnce(null);

    await expect(runStart(["--no-interactive"])).rejects.toMatchObject({ exitCode: 1 });

    expect(failMock).not.toHaveBeenCalled();
    expect(daemonLogger.error).toHaveBeenCalledWith(
      "✗ no credentials — run `first-tree-dev login <code>` to sign in before starting the daemon.",
    );
    expect(output()).toBe("");
  });

  it("logs service-mode user mismatch through error-level logger after config logLevel is applied", async () => {
    const daemonLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    clientMocks.createLogger.mockReturnValue(daemonLogger);
    writeFileSync(
      join(home, "config", "client.yaml"),
      "logLevel: error\nserver:\n  url: https://first-tree.example\nclient:\n  id: client_1234abcd\n",
    );
    process.env.FIRST_TREE_SERVICE_MODE = "1";
    const client = await import("@first-tree/client");
    runtimeInstance.start.mockRejectedValueOnce(new client.ClientUserMismatchError("wrong user"));

    await expect(runStart(["--no-interactive"])).rejects.toMatchObject({ exitCode: 1 });

    expect(clientMocks.applyClientLoggerConfig).toHaveBeenCalledWith({ level: "error" });
    expect(daemonLogger.error).toHaveBeenCalledWith(expect.stringContaining("client.yaml is not accepted"));
    expect(daemonLogger.error).toHaveBeenCalledWith(expect.stringContaining("first-tree-dev login <code>"));
    expect(daemonLogger.error).toHaveBeenCalledWith(expect.stringContaining("first-tree-dev computer reset"));
    expect(output()).toBe("");
  });

  it("logs service-mode retired client through error-level logger with reset recovery", async () => {
    const daemonLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    clientMocks.createLogger.mockReturnValue(daemonLogger);
    writeFileSync(
      join(home, "config", "client.yaml"),
      "logLevel: error\nserver:\n  url: https://first-tree.example\nclient:\n  id: client_1234abcd\n",
    );
    process.env.FIRST_TREE_SERVICE_MODE = "1";
    const client = await import("@first-tree/client");
    runtimeInstance.start.mockRejectedValueOnce(new client.ClientRetiredError("client retired"));

    await expect(runStart(["--no-interactive"])).rejects.toMatchObject({ exitCode: 1 });

    expect(clientMocks.applyClientLoggerConfig).toHaveBeenCalledWith({ level: "error" });
    expect(daemonLogger.error).toHaveBeenCalledWith(expect.stringContaining("client identity has been retired"));
    expect(daemonLogger.error).toHaveBeenCalledWith(expect.stringContaining("first-tree-dev login <code>"));
    expect(daemonLogger.error).toHaveBeenCalledWith(expect.stringContaining("first-tree-dev computer reset"));
    expect(output()).toBe("");
  });

  it("logs service-mode org mismatch through error-level logger after config logLevel is applied", async () => {
    const daemonLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    clientMocks.createLogger.mockReturnValue(daemonLogger);
    writeFileSync(
      join(home, "config", "client.yaml"),
      "logLevel: warn\nserver:\n  url: https://first-tree.example\nclient:\n  id: client_1234abcd\n",
    );
    process.env.FIRST_TREE_SERVICE_MODE = "1";
    const client = await import("@first-tree/client");
    const actual = await vi.importActual<typeof import("../core/client-reidentify.js")>("../core/client-reidentify.js");
    coreMocks.handleClientOrgMismatch.mockImplementation(actual.handleClientOrgMismatch);
    runtimeInstance.start.mockRejectedValueOnce(new client.ClientOrgMismatchError("wrong org"));

    await expect(runStart(["--no-interactive"])).rejects.toMatchObject({ exitCode: 1 });

    expect(clientMocks.applyClientLoggerConfig).toHaveBeenCalledWith({ level: "warn" });
    expect(daemonLogger.error).toHaveBeenCalledWith(expect.stringContaining("wrong org"));
    expect(daemonLogger.error).toHaveBeenCalledWith(expect.stringContaining("first-tree-dev login <code>"));
    expect(daemonLogger.error).toHaveBeenCalledWith(expect.stringContaining("first-tree-dev computer reset"));
    expect(output()).toBe("");
  });

  it("does not treat non-supervisor --no-interactive inline runs as managed updates", async () => {
    await expect(runStart(["--no-interactive", "--foreground"])).rejects.toMatchObject({ exitCode: 1 });

    expect(coreMocks.promptMissingFields).toHaveBeenCalledWith(expect.objectContaining({ noInteractive: true }));
    expect(coreMocks.createExecuteUpdate).toHaveBeenCalledWith(expect.objectContaining({ managed: false }));
    expect(clientMocks.configureClientLoggerForService).not.toHaveBeenCalled();
    expect(coreMocks.ClientRuntime).toHaveBeenCalledWith(
      "https://first-tree.example",
      "client_1234abcd",
      expect.objectContaining({
        output: undefined,
        update: expect.objectContaining({ prompt: coreMocks.declineUpdate }),
      }),
    );
  });

  it("continues when best-effort reconciliation and uploads fail", async () => {
    coreMocks.migrateLocalAgentDirs.mockRejectedValueOnce("rename failed as string");
    coreMocks.reconcileLocalRuntimeProviders.mockRejectedValueOnce("runtime probe failed as string");
    clientMocks.discoverClaudeCodeSkills.mockRejectedValueOnce("skill scan failed as string");

    await expect(runStart(["--foreground"])).rejects.toMatchObject({ exitCode: 1 });

    const text = output();
    expect(text).toContain("agent-dir migration skipped: rename failed as string");
    expect(text).toContain("runtime-provider reconcile skipped: runtime probe failed as string");
    expect(text).toContain("skills upload skipped: skill scan failed as string");
  });

  it("handles user and org mismatch errors from inline runtime startup", async () => {
    const client = await import("@first-tree/client");
    runtimeInstance.start.mockRejectedValueOnce(new client.ClientUserMismatchError("wrong user"));
    await expect(runStart(["--foreground"])).rejects.toMatchObject({ exitCode: 1 });
    const mismatchText = output();
    expect(mismatchText).toContain("client.yaml is not accepted");
    expect(mismatchText).toContain("valid server-side owner pair");
    expect(mismatchText).toContain("login <code>");
    expect(mismatchText).toContain("computer reset");
    // Purge-first account switching must NOT resurrect the removed server-side
    // transfer/unpin language.
    expect(mismatchText).not.toContain("transfer ownership");
    expect(mismatchText).not.toContain("unpinned");

    stderrSpy.mockClear();
    coreMocks.ClientRuntime.mockClear();
    runtimeInstance.start.mockRejectedValueOnce(new client.ClientOrgMismatchError("wrong org"));
    await expect(runStart(["--foreground"])).rejects.toMatchObject({ exitCode: 1 });
    expect(coreMocks.handleClientOrgMismatch).toHaveBeenCalledWith(
      expect.any(client.ClientOrgMismatchError),
      expect.objectContaining({ managed: false, rerunCommand: "first-tree-dev daemon start" }),
    );
  });

  it("continues when per-agent skill upload fails", async () => {
    coreMocks.listPinnedAgents.mockRejectedValueOnce("pin check failed as string");
    coreMocks.uploadAgentSkills.mockRejectedValueOnce("agent skill upload failed as string");

    await expect(runStart(["--foreground"])).rejects.toMatchObject({ exitCode: 1 });

    expect(output()).toContain("skills upload pin check skipped: pin check failed as string");
    expect(output()).toContain("skills upload for nova skipped: agent skill upload failed as string");
  });

  it("gates capability refresh on auth pause, ungating only after a successful registration", async () => {
    await expect(runStart(["--foreground"])).rejects.toMatchObject({ exitCode: 1 });

    // The pause wiring must be attached before `runtime.start()` — an auth
    // pause during the initial connect (dead refresh token at boot) fires
    // before start resolves, and a late-registered listener would miss it.
    expect(runtimeInstance.onAuthPaused).toHaveBeenCalledWith(expect.any(Function));
    expect(runtimeInstance.onAuthPaused.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeInstance.start.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    // NOTE: the mock has no `onAuthResumed` — if start.ts wired it, every
    // test here would throw. Fresh credentials alone must not ungate.

    const onAuthPaused = runtimeInstance.onAuthPaused.mock.calls[0]?.[0] as () => void;
    onAuthPaused();
    expect(refresherInstance.pause).toHaveBeenCalledTimes(1);

    // The gate opens only AFTER runtime.start() resolved (the initial
    // registration): resume first, then start() — while gated, start() is a
    // no-op by design.
    expect(refresherInstance.resume).toHaveBeenCalledTimes(1);
    expect(refresherInstance.start).toHaveBeenCalledTimes(1);
    expect(refresherInstance.resume.mock.invocationCallOrder[0]).toBeGreaterThan(
      runtimeInstance.start.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
    );
    expect(refresherInstance.resume.mock.invocationCallOrder[0]).toBeLessThan(
      refresherInstance.start.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    // Re-registration path: the onReconnect callback ungates THEN refreshes,
    // in that order (an onReconnect on a still-gated refresher would no-op).
    const onReconnect = runtimeInstance.onReconnect.mock.calls[0]?.[0] as () => void;
    refresherInstance.resume.mockClear();
    onReconnect();
    expect(refresherInstance.resume).toHaveBeenCalledTimes(1);
    expect(refresherInstance.onReconnect).toHaveBeenCalledTimes(1);
    expect(refresherInstance.resume.mock.invocationCallOrder[0]).toBeLessThan(
      refresherInstance.onReconnect.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("runs graceful shutdown when SIGTERM arrives during the pending auth-paused initial start", async () => {
    const signalHandlers = new Map<string, () => void>();
    const onSpy = vi.spyOn(process, "on").mockImplementation((event, listener) => {
      if (event === "SIGINT" || event === "SIGTERM") {
        signalHandlers.set(event, listener as () => void);
      }
      return process;
    });
    // runtime.start() stays pending — the connection is parked on auth pause.
    let rejectStart!: (err: Error) => void;
    runtimeInstance.start.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectStart = reject;
        }),
    );
    // In production stop() → disconnect() aborts the parked connect, which
    // rejects start() with the auth error. Mirror that causal link here.
    runtimeInstance.stop.mockImplementationOnce(async () => {
      rejectStart(new Error("Refresh token rejected by server."));
    });
    exitSpy.mockImplementation((() => undefined) as never);

    try {
      const start = runStart(["--foreground"]);
      // Handlers are installed BEFORE the initial start() wait, so they
      // exist even though startup is still parked.
      await waitForAsyncWork(() => signalHandlers.has("SIGTERM"));

      signalHandlers.get("SIGTERM")?.();
      // The startup wait settles cleanly — no exit-1 startup failure.
      await start;

      expect(runtimeInstance.stop).toHaveBeenCalledTimes(1);
      expect(refresherInstance.stop).toHaveBeenCalledTimes(1);
      // Exactly one ownership release (the finally's is null-guarded).
      expect(runtimeOwnershipRelease).toHaveBeenCalledTimes(1);
      expect(coreMocks.registerClientRuntimeMarker.mock.results[0]?.value).toHaveBeenCalled();
      // No Sentry startup error and no supervisor-triggering exit(1).
      expect(clientMocks.captureClientException).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(exitSpy).not.toHaveBeenCalledWith(1);
      expect(output()).not.toContain("Error: Refresh token rejected");
    } finally {
      onSpy.mockRestore();
    }
  });

  it("keeps a paused start() rejection a failure when no shutdown was requested", async () => {
    // Paused state alone is NOT shutdown evidence: without a signal, the
    // rejection is a real startup failure and must keep failing loudly.
    runtimeInstance.start.mockRejectedValueOnce(new Error("Refresh token rejected by server."));
    runtimeInstance.isPaused.mockReturnValueOnce(true);

    await expect(runStart(["--foreground"])).rejects.toMatchObject({ exitCode: 1 });

    expect(output()).toContain("Error: Refresh token rejected by server.");
  });

  it("stringifies non-Error inline startup failures", async () => {
    runtimeInstance.watchAgentsDir.mockImplementationOnce(() => {
      throw "watch failed as string";
    });

    await expect(runStart(["--foreground"])).rejects.toMatchObject({ exitCode: 1 });

    expect(output()).toContain("Error: watch failed as string");
  });
});
