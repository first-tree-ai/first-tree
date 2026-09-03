import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENSURE_SERVICE_DEFERRED_EXIT_CODE } from "../commands/daemon/ensure-service.js";

const sharedConfigMocks = vi.hoisted(() => ({
  clientConfigSchema: {
    server: { url: { _tag: "field" }, token: { _tag: "field", options: { secret: true } } },
    update: { policy: { _tag: "field" } },
  },
  defaultConfigDir: vi.fn(),
  defaultDataDir: vi.fn(),
  defaultHome: vi.fn(),
  getConfigValue: vi.fn(),
  normalizeContextTreeRepository: vi.fn((value: string) =>
    value === "https://github.com/acme/context" ? "acme/context" : null,
  ),
  readConfigFile: vi.fn(),
  setConfigValue: vi.fn(),
}));

const bootstrapMocks = vi.hoisted(() => ({
  ensureFreshAccessToken: vi.fn(),
  resolveServerUrl: vi.fn(),
}));

const cliFetchMock = vi.hoisted(() => vi.fn());

const resolveAgentMock = vi.hoisted(() => vi.fn());
const doctorChecksMock = vi.hoisted(() => vi.fn());

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
  success: vi.fn(),
}));

const printLineMock = vi.hoisted(() => vi.fn());

const coreMocks = vi.hoisted(() => ({
  getClientServiceStatus: vi.fn(),
  installClientService: vi.fn(),
  isServiceSupported: vi.fn(),
  isServiceUnitDriftDetected: vi.fn(),
  loadCredentials: vi.fn(),
  localContextDataLossForAgent: vi.fn(() => null),
  printResults: vi.fn(),
  refreshClientServiceUnitForUpdate: vi.fn(),
  removeLocalAgent: vi.fn(),
  restartClientService: vi.fn(),
  stopClientService: vi.fn(),
}));

const clientMocks = vi.hoisted(() => ({
  cleanAgentWorkspaces: vi.fn(),
}));

const localAgentMocks = vi.hoisted(() => ({
  createSdk: vi.fn(),
  handleSdkError: vi.fn((error: unknown) => {
    throw error;
  }),
}));

vi.mock("@first-tree/shared/config", () => sharedConfigMocks);
vi.mock("../core/bootstrap.js", () => bootstrapMocks);
vi.mock("../core/cli-fetch.js", () => ({ cliFetch: cliFetchMock }));
vi.mock("../commands/_shared/resolve-agent.js", () => ({ resolveAgent: resolveAgentMock }));
vi.mock("../commands/_shared/doctor-checks.js", () => ({ runDaemonChecks: doctorChecksMock }));
vi.mock("../cli/output.js", () => outputMocks);
vi.mock("../core/output.js", () => ({
  print: { line: printLineMock, result: outputMocks.success, fail: outputMocks.fail },
}));
vi.mock("../core/index.js", () => coreMocks);
vi.mock("@first-tree/client", () => clientMocks);
vi.mock("../commands/_shared/local-agent.js", () => localAgentMocks);

let tempDir = "";
const originalExit = process.exit;
const originalStdoutWrite = process.stdout.write;
const originalPlatform = process.platform;

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn(async () => body),
    text: vi.fn(async () => (typeof body === "string" ? body : JSON.stringify(body))),
  } as unknown as Response;
}

async function runRegistered(register: (command: Command) => void, args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  register(program);
  await program.parseAsync(["node", "test", ...args]);
}

async function runAgent(args: string[]): Promise<void> {
  const { registerAgentCommands } = await import("../commands/agent/index.js");
  await runRegistered(registerAgentCommands, ["agent", ...args]);
}

async function runDaemon(args: string[]): Promise<void> {
  const { registerDaemonCommands } = await import("../commands/daemon/index.js");
  await runRegistered(registerDaemonCommands, ["daemon", ...args]);
}

async function runConfig(args: string[]): Promise<void> {
  const { registerConfigCommands } = await import("../commands/config/index.js");
  await runRegistered(registerConfigCommands, ["config", ...args]);
}

async function runChat(args: string[]): Promise<void> {
  const { registerChatCommands } = await import("../commands/chat/index.js");
  await runRegistered(registerChatCommands, ["chat", ...args]);
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ft-cli-matrix-"));
  vi.clearAllMocks();
  sharedConfigMocks.defaultConfigDir.mockReturnValue(join(tempDir, "config"));
  sharedConfigMocks.defaultDataDir.mockReturnValue(join(tempDir, "data"));
  sharedConfigMocks.defaultHome.mockReturnValue(tempDir);
  sharedConfigMocks.readConfigFile.mockReturnValue({});
  sharedConfigMocks.getConfigValue.mockReturnValue(undefined);
  bootstrapMocks.ensureFreshAccessToken.mockResolvedValue("access-token");
  bootstrapMocks.resolveServerUrl.mockReturnValue("https://hub.example");
  resolveAgentMock.mockResolvedValue({ uuid: "agent-1", name: "nova" });
  doctorChecksMock.mockResolvedValue([{ label: "daemon", ok: true, detail: "ready" }]);
  coreMocks.isServiceSupported.mockReturnValue(true);
  coreMocks.getClientServiceStatus.mockReturnValue({ state: "active", platform: "launchd", detail: "pid 123" });
  coreMocks.loadCredentials.mockReturnValue({ refreshToken: "refresh" });
  coreMocks.stopClientService.mockReturnValue({ ok: true });
  coreMocks.restartClientService.mockReturnValue({ ok: true });
  coreMocks.isServiceUnitDriftDetected.mockReturnValue(true);
  coreMocks.installClientService.mockReturnValue({ platform: "launchd", unitPath: "/tmp/unit.plist", state: "active" });
  coreMocks.refreshClientServiceUnitForUpdate.mockReturnValue({
    platform: "launchd",
    unitPath: "/tmp/unit.plist",
    state: "active",
  });
  clientMocks.cleanAgentWorkspaces.mockReturnValue({ kind: "cleaned", removed: [] });
  localAgentMocks.createSdk.mockReturnValue({
    addChatParticipant: vi.fn(async () => [{ agentId: "agent-2" }]),
    listChats: vi.fn(async () => ({ items: [], nextCursor: null })),
    listMessages: vi.fn(async () => ({ items: [], nextCursor: null })),
  });
  process.exit = vi.fn(((code?: number) => {
    throw Object.assign(new Error("process.exit"), { code });
  }) as never);
});

afterEach(() => {
  rmSync(tempDir, { force: true, recursive: true });
  process.exit = originalExit;
  process.stdout.write = originalStdoutWrite;
  setPlatform(originalPlatform);
  delete process.env.FIRST_TREE_CHAT_ID;
});

describe("config commands", () => {
  it("shows full config, single keys, missing keys, secret masking, and parsed set values", async () => {
    sharedConfigMocks.readConfigFile.mockReturnValueOnce({
      server: { url: "https://hub.example", token: "secret" },
      update: { policy: "manual" },
    });
    await runConfig(["show"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("server.url");
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).not.toContain("secret");

    sharedConfigMocks.getConfigValue.mockReturnValueOnce("secret");
    await runConfig(["show", "server.token"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("server.token: ***");

    sharedConfigMocks.getConfigValue.mockReturnValueOnce("secret");
    await runConfig(["get", "server.token", "--show-secrets"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("server.token: secret");

    sharedConfigMocks.getConfigValue.mockReturnValueOnce(undefined);
    await runConfig(["get", "server.missing"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("server.missing: (not set)");

    sharedConfigMocks.getConfigValue.mockReturnValueOnce(undefined);
    await runConfig(["show", "server.missing"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("server.missing: (not set)");

    await runConfig(["set", "update.restart_check_interval_seconds", "15"]);
    expect(sharedConfigMocks.setConfigValue).toHaveBeenLastCalledWith(
      join(tempDir, "config", "client.yaml"),
      "update.restart_check_interval_seconds",
      15,
    );
    await runConfig(["set", "feature.enabled", "true"]);
    expect(sharedConfigMocks.setConfigValue).toHaveBeenLastCalledWith(
      join(tempDir, "config", "client.yaml"),
      "feature.enabled",
      true,
    );
    await runConfig(["set", "context_tree.repository", "https://github.com/acme/context"]);
    expect(sharedConfigMocks.setConfigValue).toHaveBeenLastCalledWith(
      join(tempDir, "config", "client.yaml"),
      "context_tree.repository",
      "acme/context",
    );
    await expect(runConfig(["set", "context_tree.repository", "owner/.hidden"])).rejects.toMatchObject({
      code: "INVALID_CONTEXT_TREE_REPOSITORY",
      exitCode: 2,
    });

    sharedConfigMocks.readConfigFile.mockReturnValueOnce({});
    await runConfig(["show"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("No config found");
  });
});

describe("daemon utility commands", () => {
  it("covers stop, restart, refresh-unit, status, doctor, and home-info paths", async () => {
    coreMocks.isServiceSupported.mockReturnValueOnce(false);
    await runDaemon(["stop"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("not supported");

    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.getClientServiceStatus.mockReturnValueOnce({ state: "not-installed", platform: "launchd" });
    await runDaemon(["stop"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("nothing to stop");

    coreMocks.getClientServiceStatus.mockReturnValueOnce({ state: "inactive", platform: "launchd" });
    await runDaemon(["stop"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("already stopped");

    coreMocks.getClientServiceStatus.mockReturnValueOnce({ state: "active", platform: "launchd" });
    coreMocks.stopClientService.mockReturnValueOnce({ ok: false, reason: "denied" });
    await expect(runDaemon(["stop"])).rejects.toMatchObject({ code: 1 });

    coreMocks.stopClientService.mockReturnValue({ ok: true });
    coreMocks.getClientServiceStatus.mockReturnValueOnce({ state: "active", platform: "launchd" });
    await runDaemon(["stop"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("Stopped launchd service");

    setPlatform("win32");
    coreMocks.isServiceSupported.mockReturnValueOnce(false);
    await runDaemon(["stop"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("Stop the PowerShell");
    setPlatform(originalPlatform);

    coreMocks.isServiceSupported.mockReturnValueOnce(false);
    await runDaemon(["restart"]);
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.getClientServiceStatus.mockReturnValueOnce({ state: "not-installed", platform: "systemd" });
    await expect(runDaemon(["restart"])).rejects.toMatchObject({ code: 1 });
    coreMocks.getClientServiceStatus.mockReturnValueOnce({ state: "active", platform: "systemd" });
    coreMocks.restartClientService.mockReturnValueOnce({ ok: false, reason: "restart failed" });
    await expect(runDaemon(["restart"])).rejects.toMatchObject({ code: 1 });
    coreMocks.getClientServiceStatus
      .mockReturnValueOnce({ state: "active", platform: "systemd" })
      .mockReturnValueOnce({ state: "active", platform: "systemd", detail: "pid 42" });
    coreMocks.restartClientService.mockReturnValueOnce({ ok: true });
    await runDaemon(["restart"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("Restarted systemd service");

    await runDaemon(["doctor"]);
    expect(coreMocks.printResults).toHaveBeenCalledWith([{ label: "daemon", ok: true, detail: "ready" }]);

    coreMocks.isServiceSupported.mockReturnValueOnce(false);
    await runDaemon(["refresh-unit"]);
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.isServiceUnitDriftDetected.mockReturnValueOnce(false);
    await runDaemon(["refresh-unit"]);
    coreMocks.isServiceUnitDriftDetected.mockReturnValueOnce(true);
    coreMocks.refreshClientServiceUnitForUpdate.mockImplementationOnce(() => {
      throw new Error("write failed");
    });
    await expect(runDaemon(["refresh-unit"])).rejects.toMatchObject({ code: 1 });
    coreMocks.refreshClientServiceUnitForUpdate.mockReturnValueOnce({
      platform: "systemd",
      unitPath: "/tmp/unit.service",
      state: "active",
    });
    await runDaemon(["refresh-unit"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "supervisor definition rewritten",
    );

    // Both branches deliberately do nothing, which the portable installer has to
    // tell apart from a real repair; they exit deferred rather than zero.
    coreMocks.isServiceSupported.mockReturnValueOnce(false);
    await expect(runDaemon(["ensure-service"])).rejects.toMatchObject({
      code: ENSURE_SERVICE_DEFERRED_EXIT_CODE,
    });
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("not supported");

    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.loadCredentials.mockReturnValueOnce(null);
    await expect(runDaemon(["ensure-service"])).rejects.toMatchObject({
      code: ENSURE_SERVICE_DEFERRED_EXIT_CODE,
    });
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("no credentials");

    coreMocks.installClientService.mockClear();
    coreMocks.getClientServiceStatus.mockReturnValueOnce({ state: "active", platform: "launchd", detail: "pid 123" });
    coreMocks.isServiceUnitDriftDetected.mockReturnValueOnce(false);
    await runDaemon(["ensure-service"]);
    expect(coreMocks.installClientService).not.toHaveBeenCalled();

    coreMocks.getClientServiceStatus.mockReturnValueOnce({ state: "inactive", platform: "systemd" });
    coreMocks.isServiceUnitDriftDetected.mockReturnValueOnce(false);
    coreMocks.installClientService.mockReturnValueOnce({
      platform: "systemd",
      unitPath: "/tmp/unit.service",
      state: "active",
    });
    await runDaemon(["ensure-service"]);
    expect(coreMocks.installClientService).toHaveBeenCalledTimes(1);

    coreMocks.getClientServiceStatus.mockReturnValueOnce({ state: "inactive", platform: "systemd" });
    coreMocks.isServiceUnitDriftDetected.mockReturnValueOnce(false);
    coreMocks.installClientService.mockImplementationOnce(() => {
      throw new Error("service denied");
    });
    await expect(runDaemon(["ensure-service"])).rejects.toMatchObject({ code: 1 });

    const stdout = vi.fn((_chunk: string | Uint8Array) => true);
    process.stdout.write = stdout as unknown as typeof process.stdout.write;
    await runDaemon(["home-info"]);
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
      channel: "dev",
      home: tempDir,
      configDir: join(tempDir, "config"),
      dataDir: join(tempDir, "data"),
    });
  });

  it("gives actionable Windows inline-daemon guidance when restart service control is unsupported", async () => {
    setPlatform("win32");
    coreMocks.isServiceSupported.mockReturnValue(false);

    await runDaemon(["restart"]);

    const output = printLineMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Service control is not supported on Windows");
    expect(output).toContain("First Tree runs inline");
    expect(output).toContain("daemon probe");
    expect(output).toContain("PowerShell");
    expect(output).toContain("Ctrl+C");
    expect(output).toContain("daemon start");
  });

  it("restarts an active systemd service when ensure-service refreshes a drifted unit", async () => {
    setPlatform("linux");
    coreMocks.installClientService.mockClear();
    coreMocks.restartClientService.mockClear();
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.loadCredentials.mockReturnValue({ refreshToken: "refresh" });
    coreMocks.getClientServiceStatus
      .mockReturnValueOnce({ state: "active", platform: "systemd", detail: "pid 123" })
      .mockReturnValueOnce({ state: "active", platform: "systemd", detail: "pid 456" });
    coreMocks.isServiceUnitDriftDetected.mockReturnValueOnce(true);
    coreMocks.installClientService.mockReturnValueOnce({
      platform: "systemd",
      unitPath: "/tmp/first-tree.service",
      state: "active",
    });
    coreMocks.restartClientService.mockReturnValueOnce({ ok: true });

    await runDaemon(["ensure-service"]);

    expect(coreMocks.installClientService).toHaveBeenCalledTimes(1);
    expect(coreMocks.restartClientService).toHaveBeenCalledTimes(1);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "systemd service refreshed and restarted",
    );
  });

  it("surfaces ensure-service restart and inactive install failures", async () => {
    coreMocks.isServiceSupported.mockReturnValue(true);
    coreMocks.loadCredentials.mockReturnValue({ refreshToken: "refresh" });

    coreMocks.getClientServiceStatus.mockReturnValueOnce({ state: "active", platform: "systemd", detail: "pid 1" });
    coreMocks.isServiceUnitDriftDetected.mockReturnValueOnce(true);
    coreMocks.installClientService.mockReturnValueOnce({
      platform: "systemd",
      unitPath: "/tmp/first-tree.service",
      state: "active",
    });
    coreMocks.restartClientService.mockReturnValueOnce({ ok: false, reason: "restart denied" });
    await expect(runDaemon(["ensure-service"])).rejects.toMatchObject({ code: 1 });
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("restart failed");

    coreMocks.getClientServiceStatus
      .mockReturnValueOnce({ state: "active", platform: "launchd", detail: "pid 2" })
      .mockReturnValueOnce({ state: "inactive", platform: "launchd", detail: "stopped" });
    coreMocks.isServiceUnitDriftDetected.mockReturnValueOnce(true);
    coreMocks.installClientService.mockReturnValueOnce({
      platform: "launchd",
      unitPath: "/tmp/first-tree.plist",
      state: "active",
    });
    coreMocks.restartClientService.mockReturnValueOnce({ ok: true });
    await expect(runDaemon(["ensure-service"])).rejects.toMatchObject({ code: 1 });
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "service restarted but is not running",
    );

    coreMocks.getClientServiceStatus.mockReturnValueOnce({ state: "inactive", platform: "systemd" });
    coreMocks.isServiceUnitDriftDetected.mockReturnValueOnce(false);
    coreMocks.installClientService.mockReturnValueOnce({
      platform: "systemd",
      unitPath: "/tmp/first-tree.service",
      state: "inactive",
      detail: "not loaded",
    });
    await expect(runDaemon(["ensure-service"])).rejects.toMatchObject({ code: 1 });
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "service installed but not running",
    );
  });
});

describe("agent admin and local commands", () => {
  it("binds, resets, removes, debugs, and controls sessions", async () => {
    cliFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await runAgent(["bind", "client", "nova", "--client-id", "client-1"]);
    expect(outputMocks.success).toHaveBeenCalledWith({ agentId: "agent-1", clientId: "client-1" });

    cliFetchMock.mockResolvedValueOnce(jsonResponse({ error: "already bound" }, false, 409));
    await expect(runAgent(["bind", "client", "nova", "--client-id", "client-1"])).rejects.toMatchObject({
      code: "BIND_CLIENT_ERROR",
      exitCode: 1,
    });

    cliFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await runAgent(["reset", "agent-1"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain('Agent "agent-1" reset');

    cliFetchMock.mockResolvedValueOnce(jsonResponse("nope", false, 503));
    await expect(runAgent(["reset", "agent-1"])).rejects.toMatchObject({ code: "RESET_ERROR", exitCode: 1 });

    const agentDir = join(tempDir, "config", "agents", "nova");
    mkdirSync(agentDir, { recursive: true });
    await runAgent(["remove", "nova"]);
    expect(coreMocks.removeLocalAgent).toHaveBeenCalledWith("nova");
    await expect(runAgent(["remove", "missing"])).rejects.toMatchObject({ code: 1 });

    localAgentMocks.createSdk.mockReturnValueOnce({ register: vi.fn(async () => ({ agentId: "agent-1" })) });
    await runAgent(["debug", "register", "--agent", "nova"]);
    expect(outputMocks.success).toHaveBeenCalledWith({ agentId: "agent-1" });

    cliFetchMock.mockResolvedValueOnce(
      jsonResponse([
        { chatId: "chat-short", state: "active", runtimeState: null, lastActivityAt: "2026-06-01T00:00:00Z" },
        {
          chatId: "chat-with-a-very-long-identifier-that-needs-truncation",
          state: "suspended",
          runtimeState: "paused",
          lastActivityAt: "2026-06-01T01:00:00Z",
        },
      ]),
    );
    await runAgent(["session", "list", "nova", "--state", "active"]);
    expect(cliFetchMock).toHaveBeenLastCalledWith(
      "https://hub.example/api/v1/agents/agent-1/sessions?state=active",
      expect.any(Object),
    );
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "chat-with-a-very-long-identifier",
    );

    cliFetchMock.mockResolvedValueOnce(jsonResponse([], true));
    await runAgent(["session", "list", "nova"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("No sessions");

    cliFetchMock.mockResolvedValueOnce(jsonResponse("bad", false, 503));
    await expect(runAgent(["session", "list", "nova"])).rejects.toMatchObject({ code: "SESSIONS_ERROR" });

    cliFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await runAgent(["session", "suspend", "nova", "chat-1"]);
    expect(cliFetchMock).toHaveBeenLastCalledWith(
      "https://hub.example/api/v1/agents/agent-1/sessions/chat-1/suspend",
      expect.objectContaining({ method: "POST" }),
    );
    cliFetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await runAgent(["session", "resume", "nova", "chat-1"]);
    expect(cliFetchMock).toHaveBeenLastCalledWith(
      "https://hub.example/api/v1/agents/agent-1/sessions/chat-1/resume",
      expect.objectContaining({ method: "POST" }),
    );
    cliFetchMock.mockResolvedValueOnce(jsonResponse("denied", false, 403));
    await expect(runAgent(["session", "terminate", "nova", "chat-1"])).rejects.toMatchObject({
      code: "SESSION_CMD_ERROR",
    });
  });

  it("cleans workspaces across all agents or one agent", async () => {
    clientMocks.cleanAgentWorkspaces.mockReturnValueOnce({
      kind: "cleaned",
      removed: [{ agentName: "nova", chatId: "chat-old" }],
    });

    await runAgent(["workspace", "clean", "--ttl", "3"]);
    expect(clientMocks.cleanAgentWorkspaces).toHaveBeenCalledTimes(1);
    expect(clientMocks.cleanAgentWorkspaces).toHaveBeenCalledWith({
      agentName: undefined,
      ttlMs: 3 * 24 * 60 * 60 * 1000,
    });
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("Removed: nova/chat-old");
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("1 workspace(s) cleaned");

    clientMocks.cleanAgentWorkspaces.mockReturnValueOnce({ kind: "cleaned", removed: [] });
    await runAgent(["workspace", "clean", "missing"]);
    expect(clientMocks.cleanAgentWorkspaces).toHaveBeenLastCalledWith({
      agentName: "missing",
      ttlMs: 7 * 24 * 60 * 60 * 1000,
    });
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("0 workspace(s) cleaned");

    clientMocks.cleanAgentWorkspaces.mockReturnValueOnce({ kind: "missing-root" });
    await runAgent(["workspace", "clean"]);
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("No workspaces found");
  });
});

describe("chat lightweight commands", () => {
  it("lists chats, reads history, invites participants, and handles missing chat context", async () => {
    const sdk = localAgentMocks.createSdk();

    await runChat(["list", "--limit", "5", "--cursor", "next", "--agent", "nova"]);
    expect(sdk.listChats).toHaveBeenCalledWith({ limit: 5, cursor: "next" });

    await runChat(["history", "chat-1", "--limit", "10", "--cursor", "older"]);
    expect(sdk.listMessages).toHaveBeenCalledWith("chat-1", { limit: 10, cursor: "older" });

    process.env.FIRST_TREE_CHAT_ID = "chat-1";
    await runChat(["invite", "mira", "--agent", "nova"]);
    expect(sdk.addChatParticipant).toHaveBeenCalledWith("chat-1", { agentName: "mira" });

    delete process.env.FIRST_TREE_CHAT_ID;
    await expect(runChat(["invite", "mira"])).rejects.toMatchObject({ code: "NO_CHAT_CONTEXT", exitCode: 2 });

    await expect(runChat(["list", "--limit", "0"])).rejects.toThrow("Limit must be between 1 and 100.");
  });
});
