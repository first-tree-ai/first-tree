import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelConfig } from "../core/channel.js";
import { portableShimContents } from "../core/portable-install-context.js";
import {
  getClientServiceStatus,
  installClientService,
  isServiceSupported,
  isServiceUnitDriftDetected,
  refreshClientServiceUnitForUpdate,
  renderLaunchdWrapper,
  renderPlist,
  renderSystemdUnit,
  renderWindowsSupervisorCmd,
  renderWindowsSupervisorLauncherVbs,
  renderWindowsTaskXml,
  resolveCliInvocation,
  restartClientService,
  startClientService,
  stopClientService,
  uninstallClientService,
  windowsSupervisorLauncherPath,
  windowsSupervisorLogPath,
  windowsSupervisorWrapperLogPath,
  windowsSupervisorWrapperPath,
  windowsTaskName,
  windowsTaskXmlPath,
} from "../core/service-install.js";
import { windowsSupervisorStopIntentPath } from "../core/supervisor/windows-supervisor.js";

const printMocks = vi.hoisted(() => ({
  line: vi.fn(),
}));

const spawnSyncMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());
const userInfoMock = vi.hoisted(() => vi.fn(() => ({ uid: 501, username: "gandy" })));
const homedirMock = vi.hoisted(() => vi.fn(() => "/Users/gandy"));

function readWindowsTaskXmlFixture(path: string): { raw: Buffer; xml: string } {
  const raw = readFileSync(path);
  const body = raw.toString("utf16le");
  return { raw, xml: body.startsWith("\uFEFF") ? body.slice(1) : body };
}

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
  execFileSync: execFileSyncMock,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: homedirMock,
    userInfo: userInfoMock,
  };
});

vi.mock("../core/output.js", () => ({
  print: printMocks,
}));

const originalPlatform = process.platform;
const originalArgv = [...process.argv];
const originalExecPath = process.execPath;
const originalCwd = process.cwd;
const originalFirstTreeHome = process.env.FIRST_TREE_HOME;
const originalSystemdSystemDir = process.env.FIRST_TREE_SYSTEMD_SYSTEM_DIR;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const originalXdgRuntimeDir = process.env.XDG_RUNTIME_DIR;
const originalDbusSessionBusAddress = process.env.DBUS_SESSION_BUS_ADDRESS;
const originalPath = process.env.PATH;
const originalInstallMode = process.env.FIRST_TREE_INSTALL_MODE;
const originalPortableRoot = process.env.FIRST_TREE_PORTABLE_ROOT;
const originalPortableBinDir = process.env.FIRST_TREE_PORTABLE_BIN_DIR;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function setExecPath(value: string): void {
  Object.defineProperty(process, "execPath", { configurable: true, value });
}

function tempHome(): string {
  return join(tmpdir(), `ft-service-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function rootHome(): string {
  return join(home, "root");
}

function rootUserInfo(): { uid: 0; username: string; homedir: string } {
  return { uid: 0, username: "root", homedir: rootHome() };
}

function rootLegacySystemdUserUnitPath(): string {
  return join(rootHome(), ".config", "systemd", "user", channelConfig.serviceUnitFile);
}

function windowsProcessIdentityJson(
  pid: number,
  opts: { commandLine?: string; creationTimeUtc?: string; executablePath?: string } = {},
): string {
  return JSON.stringify({
    ProcessId: pid,
    ParentProcessId: 1234,
    CommandLine: opts.commandLine ?? '"node.exe" "C:\\First Tree\\index.mjs" "daemon" "start" "--no-interactive"',
    ExecutablePath: opts.executablePath ?? "C:\\Program Files\\nodejs\\node.exe",
    CreationTimeUtc: opts.creationTimeUtc ?? "2026-01-01T23:59:59.0000000Z",
  });
}

function windowsProcessListJson(
  processes: Array<{
    pid: number;
    commandLine?: string;
    creationTimeUtc?: string;
    executablePath?: string;
    name?: string;
  }>,
): string {
  return JSON.stringify(
    processes.map((process) => ({
      ProcessId: process.pid,
      ParentProcessId: 1234,
      Name: process.name ?? "node.exe",
      CommandLine:
        process.commandLine ??
        '"node.exe" "C:\\Users\\gandy\\AppData\\Roaming\\npm\\node_modules\\first-tree-dev\\dist\\cli\\index.mjs" "daemon" "supervise"',
      ExecutablePath: process.executablePath ?? "C:\\Program Files\\nodejs\\node.exe",
      CreationTimeUtc: process.creationTimeUtc ?? "2026-01-02T00:00:00.0000000Z",
    })),
  );
}

let home: string;

beforeEach(() => {
  home = tempHome();
  mkdirSync(home, { recursive: true });
  process.env.FIRST_TREE_HOME = join(home, "ft-home");
  process.env.FIRST_TREE_SYSTEMD_SYSTEM_DIR = join(home, "systemd-system");
  process.env.XDG_CONFIG_HOME = join(home, "xdg");
  delete process.env.FIRST_TREE_INSTALL_MODE;
  delete process.env.FIRST_TREE_PORTABLE_ROOT;
  delete process.env.FIRST_TREE_PORTABLE_BIN_DIR;
  process.argv = ["node", "/repo/dist/cli/index.mjs"];
  setExecPath("/opt/node/bin/node");
  process.cwd = () => "/repo";
  execFileSyncMock.mockReset();
  spawnSyncMock.mockReset();
  homedirMock.mockReturnValue(home);
  userInfoMock.mockReturnValue({ uid: 501, username: "gandy" });
  printMocks.line.mockClear();
  setPlatform(originalPlatform);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalFirstTreeHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalFirstTreeHome;
  if (originalSystemdSystemDir === undefined) delete process.env.FIRST_TREE_SYSTEMD_SYSTEM_DIR;
  else process.env.FIRST_TREE_SYSTEMD_SYSTEM_DIR = originalSystemdSystemDir;
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  if (originalXdgRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = originalXdgRuntimeDir;
  if (originalDbusSessionBusAddress === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
  else process.env.DBUS_SESSION_BUS_ADDRESS = originalDbusSessionBusAddress;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalInstallMode === undefined) delete process.env.FIRST_TREE_INSTALL_MODE;
  else process.env.FIRST_TREE_INSTALL_MODE = originalInstallMode;
  if (originalPortableRoot === undefined) delete process.env.FIRST_TREE_PORTABLE_ROOT;
  else process.env.FIRST_TREE_PORTABLE_ROOT = originalPortableRoot;
  if (originalPortableBinDir === undefined) delete process.env.FIRST_TREE_PORTABLE_BIN_DIR;
  else process.env.FIRST_TREE_PORTABLE_BIN_DIR = originalPortableBinDir;
  process.argv = [...originalArgv];
  setExecPath(originalExecPath);
  process.cwd = originalCwd;
  setPlatform(originalPlatform);
});

describe("service install helpers", () => {
  it("resolves the channel bin when it is on PATH and falls back to node plus script", () => {
    execFileSyncMock.mockReturnValueOnce(`/tmp/bin/${channelConfig.binName}\n`);
    expect(resolveCliInvocation()).toEqual({ kind: "bin", program: `/tmp/bin/${channelConfig.binName}` });

    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error("not found");
    });
    process.argv = ["node", "dist/cli/index.mjs"];
    expect(resolveCliInvocation()).toEqual({
      kind: "node",
      program: "/opt/node/bin/node",
      args: ["/repo/dist/cli/index.mjs"],
    });

    process.argv = ["node"];
    expect(() => resolveCliInvocation()).toThrow("Cannot resolve CLI entry point");
  });

  it("uses the Windows cmd shim when where returns npm's extensionless shell shim first", () => {
    setPlatform("win32");
    const npmBinDir = join(home, "npm");
    const extensionlessShim = join(npmBinDir, channelConfig.binName);
    const cmdShim = `${extensionlessShim}.cmd`;
    mkdirSync(npmBinDir, { recursive: true });
    writeFileSync(extensionlessShim, '#!/bin/sh\nexec node cli.mjs "$@"\n');
    writeFileSync(cmdShim, "@ECHO off\r\nnode cli.mjs %*\r\n");

    execFileSyncMock.mockReturnValueOnce(`${extensionlessShim}\r\n${cmdShim}\r\n`);

    expect(resolveCliInvocation()).toEqual({ kind: "bin", program: realpathSync(cmdShim) });
  });

  it("keeps portable service identity stable when a legacy global binary is first on PATH", () => {
    setPlatform("linux");
    const prefix = join(home, "portable");
    const root = join(prefix, "current");
    const binDir = join(home, "custom-bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, channelConfig.binName), portableShimContents(root, binDir), { mode: 0o755 });
    process.env.FIRST_TREE_INSTALL_MODE = "portable";
    process.env.FIRST_TREE_PORTABLE_ROOT = root;
    process.env.FIRST_TREE_PORTABLE_BIN_DIR = binDir;
    process.env.PATH = `/usr/local/bin:${binDir}`;
    execFileSyncMock.mockReturnValue(`/usr/local/bin/${channelConfig.binName}\n`);

    const invocation = resolveCliInvocation();
    expect(invocation).toEqual({ kind: "bin", program: join(binDir, channelConfig.binName) });
    expect(execFileSyncMock).not.toHaveBeenCalled();

    const unit = renderSystemdUnit(invocation);
    expect(unit).toContain(`ExecStart=${join(binDir, channelConfig.binName)} daemon start --no-interactive`);
    expect(unit).toContain(`Environment=PATH=${binDir}:${root}/node/bin:/usr/local/bin:/usr/bin:/bin`);
    expect(unit).not.toContain("/versions/");

    const plist = renderPlist("/tmp/First Tree");
    expect(plist).toContain(`${binDir}:${root}/node/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`);
    expect(plist).not.toContain("/versions/");
  });

  it("renders service templates with escaped values and quoted shell arguments", () => {
    const plist = renderPlist("/tmp/First & Tree");
    expect(plist).toContain("<string>/tmp/First &amp; Tree</string>");
    expect(plist).toContain("<key>FIRST_TREE_HOME</key>");
    expect(plist).toContain(process.env.FIRST_TREE_HOME);
    // The service unit no longer bakes proxy env in — the daemon reads the
    // user-owned daemon.env instead (compatibility, not management).
    expect(plist).not.toContain("HTTP_PROXY");

    const wrapper = renderLaunchdWrapper({
      kind: "node",
      program: "/opt/My Node/node",
      args: ["/tmp/cli path/index.mjs"],
    });
    expect(wrapper).toContain(`'/opt/My Node/node' '/tmp/cli path/index.mjs' daemon start --no-interactive`);

    const unit = renderSystemdUnit({ kind: "bin", program: "/usr/local/bin/first tree" });
    expect(unit).toContain(`ExecStart='/usr/local/bin/first tree' daemon start --no-interactive`);
    expect(unit).toContain(`Environment=FIRST_TREE_HOME=${process.env.FIRST_TREE_HOME}`);
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).not.toContain("HTTPS_PROXY");

    const systemUnit = renderSystemdUnit({ kind: "bin", program: "/usr/local/bin/first tree" }, "system");
    expect(systemUnit).toContain("WantedBy=multi-user.target");

    const windowsWrapper = renderWindowsSupervisorCmd({
      kind: "node",
      program: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\First Tree\\index.mjs"],
    });
    expect(windowsWrapper).toContain(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\First Tree\\index.mjs" "daemon" "supervise"',
    );
    expect(windowsWrapper).toContain(`>>"${windowsSupervisorWrapperLogPath()}" 2>&1`);
    expect(windowsWrapper).not.toContain(`>>"${windowsSupervisorLogPath()}"`);
    expect(windowsWrapper).toContain(" 2>&1");
    const windowsLauncher = renderWindowsSupervisorLauncherVbs("C:\\First Tree\\supervisor.cmd");
    expect(windowsLauncher).toContain('shell.Run("""C:\\First Tree\\supervisor.cmd""", 0, True)');
    const taskXml = renderWindowsTaskXml("C:\\First Tree\\supervisor.vbs", "ACME\\gandy & team");
    expect(taskXml).toMatch(/^<\?xml version="1\.0" encoding="UTF-16"\?>/u);
    expect(taskXml).toContain("wscript.exe");
    expect(taskXml).toContain("&quot;C:\\First Tree\\supervisor.vbs&quot;");
    expect(taskXml).toContain("<LogonTrigger>");
    expect(taskXml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(taskXml).toContain("ACME\\gandy &amp; team");
    expect(taskXml).not.toContain("RestartOnFailure");
  });

  it("lifts a proxy baked into a prior launchd plist into the user-owned daemon.env (upgrade buffer)", () => {
    setPlatform("darwin");
    const plistPath = join(home, "Library", "LaunchAgents", `${channelConfig.launchdLabel}.plist`);
    mkdirSync(dirname(plistPath), { recursive: true });
    // A pre-redesign plist that baked the user's proxy straight into the unit.
    writeFileSync(
      plistPath,
      "<plist><dict>" +
        "<key>HTTP_PROXY</key><string>http://127.0.0.1:7897</string>" +
        "<key>NO_PROXY</key><string>localhost,127.0.0.1</string>" +
        "</dict></plist>",
    );
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "not loaded" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "Could not find service" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "state = running\npid = 1\n", stderr: "" });

    installClientService();

    const envPath = join(process.env.FIRST_TREE_HOME ?? "", "daemon.env");
    const env = readFileSync(envPath, "utf-8");
    expect(env).toContain("HTTP_PROXY=http://127.0.0.1:7897");
    expect(env).toContain("NO_PROXY=localhost,127.0.0.1");
    // The freshly written plist no longer carries the proxy.
    expect(readFileSync(plistPath, "utf-8")).not.toContain("HTTP_PROXY");
  });

  it("never overwrites an existing user-owned daemon.env during migration", () => {
    setPlatform("darwin");
    const plistPath = join(home, "Library", "LaunchAgents", `${channelConfig.launchdLabel}.plist`);
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, "<plist><dict><key>HTTP_PROXY</key><string>http://baked:1</string></dict></plist>");
    const envPath = join(process.env.FIRST_TREE_HOME ?? "", "daemon.env");
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(envPath, "HTTPS_PROXY=http://user-set:2\n");

    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "not loaded" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "Could not find service" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "state = running\npid = 1\n", stderr: "" });

    installClientService();

    expect(readFileSync(envPath, "utf-8")).toBe("HTTPS_PROXY=http://user-set:2\n");
  });

  it("reports support by platform", () => {
    setPlatform("darwin");
    expect(isServiceSupported()).toBe(true);
    setPlatform("linux");
    expect(isServiceSupported()).toBe(true);
    setPlatform("win32");
    expect(isServiceSupported()).toBe(true);
    setPlatform("freebsd");
    expect(isServiceSupported()).toBe(false);
  });

  it("reports launchd states without leaking launchctl stderr", () => {
    setPlatform("darwin");
    const plistPath = join(home, "Library", "LaunchAgents", `${channelConfig.launchdLabel}.plist`);
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, renderPlist(join(home, "service-wrapper")));

    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: "state = running\npid = 123\n",
      stderr: "",
    });
    expect(getClientServiceStatus()).toMatchObject({
      platform: "launchd",
      state: "active",
      pid: 123,
      detail: "pid 123",
      configuredHome: process.env.FIRST_TREE_HOME,
    });

    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: "state = not running\nlast exit code = 75: EX_TEMPFAIL\n",
      stderr: "",
    });
    expect(getClientServiceStatus()).toMatchObject({
      platform: "launchd",
      state: "inactive",
      detail: "state = not running",
    });

    spawnSyncMock.mockReturnValueOnce({ status: 3, stdout: "", stderr: "Could not find service" });
    expect(getClientServiceStatus()).toMatchObject({
      platform: "launchd",
      state: "inactive",
      detail: "plist present but not loaded",
    });
  });

  it("reports systemd states and main pid", () => {
    setPlatform("linux");
    const unitPath = join(process.env.XDG_CONFIG_HOME ?? "", "systemd", "user", channelConfig.serviceUnitFile);
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, renderSystemdUnit({ kind: "bin", program: "/opt/first-tree" }));
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "active\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "456\n", stderr: "" });

    expect(getClientServiceStatus()).toMatchObject({
      platform: "systemd",
      state: "active",
      pid: 456,
      detail: "pid 456",
      configuredHome: process.env.FIRST_TREE_HOME,
    });

    spawnSyncMock.mockReturnValueOnce({ status: 3, stdout: "inactive\n", stderr: "" });
    expect(getClientServiceStatus()).toMatchObject({
      platform: "systemd",
      state: "inactive",
      detail: "inactive",
    });
  });

  it("detects service unit drift from missing and changed files", () => {
    setPlatform("linux");
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });
    const unitPath = join(process.env.XDG_CONFIG_HOME ?? "", "systemd", "user", channelConfig.serviceUnitFile);
    expect(isServiceUnitDriftDetected()).toBe(true);

    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, "stale");
    expect(isServiceUnitDriftDetected()).toBe(true);

    writeFileSync(
      unitPath,
      renderSystemdUnit({ kind: "node", program: process.execPath, args: [process.argv[1] ?? ""] }),
    );
    expect(isServiceUnitDriftDetected()).toBe(false);
  });

  it("starts, stops, and restarts services through the platform manager", () => {
    setPlatform("linux");
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    expect(startClientService()).toEqual({ ok: true });
    expect(stopClientService()).toEqual({ ok: true });
    expect(restartClientService()).toEqual({ ok: true });

    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "Unit not found" });
    expect(stopClientService()).toEqual({ ok: true, detail: "not running" });

    setPlatform("win32");
    spawnSyncMock.mockReset();
    spawnSyncMock.mockImplementation((program: string, args: string[]) => {
      const command = args.join(" ");
      if (program === "powershell.exe" && command.includes("Get-ScheduledTask")) {
        return { status: 0, stdout: "Ready", stderr: "" };
      }
      if (program === "powershell.exe" && command.includes("Get-CimInstance Win32_Process")) {
        return { status: 0, stdout: "[]", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    expect(startClientService()).toEqual({ ok: true });
    expect(stopClientService()).toEqual({ ok: true });
    expect(restartClientService()).toEqual({ ok: true });
  });

  it("uses launchctl bootstrap and kickstart paths for launchd control", () => {
    setPlatform("darwin");
    const plistPath = join(home, "Library", "LaunchAgents", `${channelConfig.launchdLabel}.plist`);
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, "plist");

    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "not loaded" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    expect(startClientService()).toEqual({ ok: true });

    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "loaded", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    expect(startClientService()).toEqual({ ok: true });

    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "not loaded" });
    expect(stopClientService()).toEqual({ ok: true, detail: "not running" });

    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "not loaded" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    expect(restartClientService()).toEqual({ ok: true });
  });

  it("installs a systemd user service, enables linger, and reports the running process", () => {
    setPlatform("linux");
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "no\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "active\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "789\n", stderr: "" });

    const info = installClientService();
    const unitPath = join(process.env.XDG_CONFIG_HOME ?? "", "systemd", "user", channelConfig.serviceUnitFile);
    const unit = readFileSync(unitPath, "utf-8");

    expect(info).toMatchObject({
      platform: "systemd",
      label: channelConfig.serviceUnitFile,
      state: "active",
      pid: 789,
      detail: "pid 789",
      unitPath,
    });
    expect(existsSync(join(process.env.FIRST_TREE_HOME ?? "", "logs"))).toBe(true);
    expect(unit).toContain(`${process.execPath} ${process.argv[1]} daemon start --no-interactive`);
    expect(unit).toContain(`Environment=FIRST_TREE_HOME=${process.env.FIRST_TREE_HOME}`);
    expect(spawnSyncMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["systemctl", ["--user", "daemon-reload"]],
      ["loginctl", ["show-user", "gandy", "-p", "Linger", "--value"]],
      ["loginctl", ["enable-linger", "gandy"]],
      ["systemctl", ["--user", "enable", "--now", channelConfig.serviceUnitFile]],
      ["systemctl", ["--user", "is-active", channelConfig.serviceUnitFile]],
      ["systemctl", ["--user", "show", channelConfig.serviceUnitFile, "-p", "MainPID", "--value"]],
    ]);
  });

  it("installs a root systemd system service without a user bus", () => {
    setPlatform("linux");
    userInfoMock.mockReturnValue(rootUserInfo());
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "active\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "987\n", stderr: "" });

    const info = installClientService();
    const unitPath = join(process.env.FIRST_TREE_SYSTEMD_SYSTEM_DIR ?? "", channelConfig.serviceUnitFile);
    const unit = readFileSync(unitPath, "utf-8");

    expect(info).toMatchObject({
      platform: "systemd",
      label: channelConfig.serviceUnitFile,
      state: "active",
      pid: 987,
      unitPath,
      managerScope: "system",
    });
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(unit).toContain(`Environment=FIRST_TREE_HOME=${process.env.FIRST_TREE_HOME}`);
    expect(spawnSyncMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["systemctl", ["daemon-reload"]],
      ["systemctl", ["enable", "--now", channelConfig.serviceUnitFile]],
      ["systemctl", ["is-active", channelConfig.serviceUnitFile]],
      ["systemctl", ["show", channelConfig.serviceUnitFile, "-p", "MainPID", "--value"]],
    ]);

    spawnSyncMock.mockClear();
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
    expect(startClientService()).toEqual({ ok: true });
    expect(stopClientService()).toEqual({ ok: true });
    expect(restartClientService()).toEqual({ ok: true });
    expect(spawnSyncMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["systemctl", ["start", channelConfig.serviceUnitFile]],
      ["systemctl", ["stop", channelConfig.serviceUnitFile]],
      ["systemctl", ["restart", channelConfig.serviceUnitFile]],
    ]);
  });

  it("migrates a legacy root systemd user unit before enabling the system unit", () => {
    setPlatform("linux");
    userInfoMock.mockReturnValue(rootUserInfo());
    process.env.XDG_CONFIG_HOME = join(home, "sudo-user-xdg");
    process.env.XDG_RUNTIME_DIR = "/run/user/501";
    process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/501/bus";
    const legacyUnitPath = rootLegacySystemdUserUnitPath();
    mkdirSync(dirname(legacyUnitPath), { recursive: true });
    writeFileSync(legacyUnitPath, 'Environment=HTTP_PROXY="http://legacy-proxy:8080"\n');
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "inactive\n", stderr: "" });

    expect(installClientService()).toMatchObject({ platform: "systemd", state: "inactive", managerScope: "system" });
    expect(existsSync(legacyUnitPath)).toBe(false);
    expect(readFileSync(join(process.env.FIRST_TREE_HOME ?? "", "daemon.env"), "utf-8")).toContain(
      "HTTP_PROXY=http://legacy-proxy:8080",
    );
    expect(spawnSyncMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["systemctl", ["--user", "disable", "--now", channelConfig.serviceUnitFile]],
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["daemon-reload"]],
      ["systemctl", ["enable", "--now", channelConfig.serviceUnitFile]],
      ["systemctl", ["is-active", channelConfig.serviceUnitFile]],
    ]);
    expect(spawnSyncMock.mock.calls[0][2].env).toMatchObject({
      XDG_RUNTIME_DIR: "/run/user/0",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus",
    });
  });

  it("fails root systemd migration when the legacy user bus is unavailable", () => {
    setPlatform("linux");
    userInfoMock.mockReturnValue(rootUserInfo());
    const legacyUnitPath = rootLegacySystemdUserUnitPath();
    mkdirSync(dirname(legacyUnitPath), { recursive: true });
    writeFileSync(legacyUnitPath, "unit");
    spawnSyncMock.mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: "Failed to connect to bus: No such file or directory",
    });

    expect(() => installClientService()).toThrow(
      "legacy root systemd user service state is ambiguous: Failed to connect to bus: No such file or directory",
    );
    expect(existsSync(legacyUnitPath)).toBe(true);
    expect(existsSync(join(process.env.FIRST_TREE_SYSTEMD_SYSTEM_DIR ?? "", channelConfig.serviceUnitFile))).toBe(
      false,
    );
  });

  it("fails root systemd migration when the legacy user unit cannot be stopped", () => {
    setPlatform("linux");
    userInfoMock.mockReturnValue(rootUserInfo());
    const legacyUnitPath = rootLegacySystemdUserUnitPath();
    mkdirSync(dirname(legacyUnitPath), { recursive: true });
    writeFileSync(legacyUnitPath, "unit");
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "access denied" });

    expect(() => installClientService()).toThrow("legacy root systemd user service migration failed: access denied");
    expect(existsSync(join(process.env.FIRST_TREE_SYSTEMD_SYSTEM_DIR ?? "", channelConfig.serviceUnitFile))).toBe(
      false,
    );
  });

  it("refuses lifecycle operations during deferred root user-to-system systemd migration", () => {
    setPlatform("linux");
    userInfoMock.mockReturnValue(rootUserInfo());
    const legacyUnitPath = rootLegacySystemdUserUnitPath();
    const reason = `legacy root systemd user unit requires out-of-service migration: ${legacyUnitPath}`;
    mkdirSync(dirname(legacyUnitPath), { recursive: true });
    writeFileSync(legacyUnitPath, "unit");

    expect(getClientServiceStatus()).toMatchObject({
      platform: "systemd",
      state: "unknown",
      unitPath: legacyUnitPath,
      managerScope: "user",
      migrationRequired: "root-systemd-user-to-system",
      detail: reason,
    });
    expect(isServiceUnitDriftDetected()).toBe(true);
    expect(startClientService()).toEqual({ ok: false, reason });
    expect(stopClientService()).toEqual({ ok: false, reason });
    expect(restartClientService()).toEqual({ ok: false, reason });
    expect(uninstallClientService()).toMatchObject({
      platform: "systemd",
      state: "unknown",
      unitPath: legacyUnitPath,
      managerScope: "user",
      migrationRequired: "root-systemd-user-to-system",
      detail: reason,
    });
    expect(() => refreshClientServiceUnitForUpdate()).toThrow(
      `legacy root systemd user unit requires an out-of-service migration before refresh: ${legacyUnitPath}`,
    );
    expect(existsSync(legacyUnitPath)).toBe(true);
    expect(existsSync(join(process.env.FIRST_TREE_SYSTEMD_SYSTEM_DIR ?? "", channelConfig.serviceUnitFile))).toBe(
      false,
    );
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("surfaces systemd install and uninstall warnings", () => {
    setPlatform("linux");
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "reload failed" });
    expect(() => installClientService()).toThrow("systemctl --user daemon-reload failed: reload failed");

    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "no\n", stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "linger denied" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "enable failed" });
    expect(() => installClientService()).toThrow("systemctl --user enable --now");
    expect(printMocks.line).toHaveBeenCalledWith(
      expect.stringContaining("loginctl enable-linger failed: linger denied"),
    );

    const unitPath = join(process.env.XDG_CONFIG_HOME ?? "", "systemd", "user", channelConfig.serviceUnitFile);
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, "unit");
    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "disable failed" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "reload failed" });
    expect(uninstallClientService()).toMatchObject({ state: "not-installed" });
    expect(printMocks.line).toHaveBeenCalledWith(expect.stringContaining("systemctl disable during uninstall"));
    expect(printMocks.line).toHaveBeenCalledWith(expect.stringContaining("systemctl daemon-reload during uninstall"));
  });

  it("migrates quoted systemd proxy env and ignores migration write failures", () => {
    setPlatform("linux");
    const unitPath = join(process.env.XDG_CONFIG_HOME ?? "", "systemd", "user", channelConfig.serviceUnitFile);
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(
      unitPath,
      'Environment=HTTP_PROXY="http://proxy.example:8080"\nEnvironment=NO_PROXY="localhost,127.0.0.1"\n',
    );
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "yes\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "inactive\n", stderr: "" });

    installClientService();

    const envPath = join(process.env.FIRST_TREE_HOME ?? "", "daemon.env");
    expect(readFileSync(envPath, "utf-8")).toContain("HTTP_PROXY=http://proxy.example:8080");
    expect(readFileSync(envPath, "utf-8")).toContain("NO_PROXY=localhost,127.0.0.1");
  });

  it("handles systemd linger already enabled and unreadable drift checks", () => {
    setPlatform("linux");
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "yes\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "inactive\n", stderr: "" });

    expect(installClientService()).toMatchObject({ platform: "systemd", state: "inactive" });
    expect(spawnSyncMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["systemctl", ["--user", "daemon-reload"]],
      ["loginctl", ["show-user", "gandy", "-p", "Linger", "--value"]],
      ["systemctl", ["--user", "enable", "--now", channelConfig.serviceUnitFile]],
      ["systemctl", ["--user", "is-active", channelConfig.serviceUnitFile]],
    ]);

    const unitPath = join(process.env.XDG_CONFIG_HOME ?? "", "systemd", "user", channelConfig.serviceUnitFile);
    rmSync(unitPath, { force: true });
    mkdirSync(unitPath, { recursive: true });
    expect(isServiceUnitDriftDetected()).toBe(true);
  });

  it("reports systemd command timeouts from captured status and control calls", () => {
    setPlatform("linux");
    const unitPath = join(process.env.XDG_CONFIG_HOME ?? "", "systemd", "user", channelConfig.serviceUnitFile);
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, "unit");
    spawnSyncMock.mockReturnValueOnce({ status: null, signal: "SIGTERM", stdout: "", stderr: "" });
    expect(getClientServiceStatus()).toMatchObject({
      platform: "systemd",
      state: "inactive",
      detail: "unit present but not active",
    });

    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: null, signal: "SIGTERM", stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: null, signal: "SIGTERM", stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "inactive\n", stderr: "" });
    expect(installClientService()).toMatchObject({ platform: "systemd", state: "inactive" });
    expect(printMocks.line).toHaveBeenCalledWith(expect.stringContaining("loginctl enable-linger failed"));

    spawnSyncMock.mockReturnValueOnce({ status: null, signal: "SIGTERM", stdout: "", stderr: "" });
    expect(startClientService()).toEqual({
      ok: false,
      reason: expect.stringContaining("systemctl timed out"),
    });
  });

  it("uninstalls a systemd service and reloads the user manager", () => {
    setPlatform("linux");
    const unitPath = join(process.env.XDG_CONFIG_HOME ?? "", "systemd", "user", channelConfig.serviceUnitFile);
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, "stale");
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "Unit not found" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });

    expect(uninstallClientService()).toMatchObject({
      platform: "systemd",
      label: channelConfig.serviceUnitFile,
      state: "not-installed",
      unitPath,
    });
    expect(existsSync(unitPath)).toBe(false);
    expect(spawnSyncMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["systemctl", ["--user", "disable", "--now", channelConfig.serviceUnitFile]],
      ["systemctl", ["--user", "daemon-reload"]],
    ]);
  });

  it("installs launchd service files and tolerates an initially unloaded label", () => {
    setPlatform("darwin");
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "service not loaded" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "Could not find service" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "state = running\npid = 321\n", stderr: "" });

    const info = installClientService();
    const plistPath = join(home, "Library", "LaunchAgents", `${channelConfig.launchdLabel}.plist`);
    const wrapperPath = join(process.env.FIRST_TREE_HOME ?? "", "service", channelConfig.displayName);

    expect(info).toMatchObject({
      platform: "launchd",
      label: channelConfig.launchdLabel,
      state: "active",
      pid: 321,
      detail: "pid 321",
      unitPath: plistPath,
    });
    expect(readFileSync(wrapperPath, "utf-8")).toContain(
      `${process.execPath} ${process.argv[1]} daemon start --no-interactive`,
    );
    expect(readFileSync(wrapperPath, "utf-8")).toContain('if [ "$status" -ne 75 ]');
    expect(readFileSync(plistPath, "utf-8")).toContain(`<string>${wrapperPath}</string>`);
    expect(spawnSyncMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["launchctl", ["bootout", `gui/501/${channelConfig.launchdLabel}`]],
      ["launchctl", ["print", `gui/501/${channelConfig.launchdLabel}`]],
      ["launchctl", ["bootstrap", "gui/501", plistPath]],
      ["launchctl", ["enable", `gui/501/${channelConfig.launchdLabel}`]],
      ["launchctl", ["print", `gui/501/${channelConfig.launchdLabel}`]],
    ]);
  });

  it("refreshes launchd unit files for auto-update without unloading the current label", () => {
    setPlatform("darwin");
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "state = running\npid = 654\n", stderr: "" });

    const info = refreshClientServiceUnitForUpdate();
    const plistPath = join(home, "Library", "LaunchAgents", `${channelConfig.launchdLabel}.plist`);
    const wrapperPath = join(process.env.FIRST_TREE_HOME ?? "", "service", channelConfig.displayName);

    expect(info).toMatchObject({
      platform: "launchd",
      label: channelConfig.launchdLabel,
      state: "active",
      pid: 654,
      unitPath: plistPath,
    });
    expect(readFileSync(wrapperPath, "utf-8")).toContain(
      `${process.execPath} ${process.argv[1]} daemon start --no-interactive`,
    );
    expect(readFileSync(wrapperPath, "utf-8")).toContain('if [ "$status" -ne 75 ]');
    expect(readFileSync(plistPath, "utf-8")).toContain(`<string>${wrapperPath}</string>`);
    expect(spawnSyncMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["launchctl", ["print", `gui/501/${channelConfig.launchdLabel}`]],
    ]);
  });

  it("detects launchd unit drift and reports unsupported refresh/drift platforms", () => {
    setPlatform("darwin");
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });
    expect(isServiceUnitDriftDetected()).toBe(true);

    const wrapperPath = join(process.env.FIRST_TREE_HOME ?? "", "service", channelConfig.displayName);
    const plistPath = join(home, "Library", "LaunchAgents", `${channelConfig.launchdLabel}.plist`);
    mkdirSync(dirname(wrapperPath), { recursive: true });
    mkdirSync(dirname(plistPath), { recursive: true });
    const invocation = { kind: "node" as const, program: process.execPath, args: [process.argv[1] ?? ""] };
    writeFileSync(wrapperPath, renderLaunchdWrapper(invocation));
    writeFileSync(plistPath, renderPlist(wrapperPath));
    expect(isServiceUnitDriftDetected()).toBe(false);

    setPlatform("win32");
    spawnSyncMock.mockReturnValueOnce({ status: 3, stdout: "", stderr: "" });
    expect(isServiceUnitDriftDetected()).toBe(true);
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "Ready", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "[]", stderr: "" });
    expect(refreshClientServiceUnitForUpdate()).toMatchObject({ platform: "task-scheduler" });
  });

  it("surfaces launchd bootstrap retry failures and warnings", () => {
    setPlatform("darwin");
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(10_001);
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "bootout failed" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "bootstrap failed once" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "bootstrap failed twice" });

    expect(() => installClientService()).toThrow("launchctl bootstrap failed: bootstrap failed twice");
    expect(printMocks.line).toHaveBeenCalledWith(expect.stringContaining("warning: launchctl bootout"));
    expect(printMocks.line).toHaveBeenCalledWith(expect.stringContaining("bootout still settling"));
    dateNowSpy.mockRestore();

    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "not loaded" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "not loaded" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "bootstrap failed once" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "enable failed" })
      .mockReturnValueOnce({ status: 0, stdout: "state = stopped\n", stderr: "" });
    expect(installClientService()).toMatchObject({ platform: "launchd", state: "inactive" });
    expect(printMocks.line).toHaveBeenCalledWith(expect.stringContaining("warning: launchctl enable: enable failed"));
  });

  it("reports launchd uninstall and stop warnings", () => {
    setPlatform("darwin");
    const plistPath = join(home, "Library", "LaunchAgents", `${channelConfig.launchdLabel}.plist`);
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, "plist");

    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "bootout exploded" });
    expect(uninstallClientService()).toMatchObject({ state: "not-installed" });
    expect(printMocks.line).toHaveBeenCalledWith(expect.stringContaining("warning: bootout during uninstall"));

    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "stop failed" });
    expect(stopClientService()).toEqual({ ok: false, reason: "stop failed" });

    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "kick failed" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "bootstrap failed" });
    writeFileSync(plistPath, "plist");
    expect(restartClientService()).toEqual({ ok: false, reason: "bootstrap failed" });
  });

  it("stops launchd services successfully", () => {
    setPlatform("darwin");
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });

    expect(stopClientService()).toEqual({ ok: true });
  });

  it("uninstalls launchd files even when bootout reports the label is absent", () => {
    setPlatform("darwin");
    const plistPath = join(home, "Library", "LaunchAgents", `${channelConfig.launchdLabel}.plist`);
    const wrapperPath = join(process.env.FIRST_TREE_HOME ?? "", "service", channelConfig.displayName);
    mkdirSync(dirname(plistPath), { recursive: true });
    mkdirSync(dirname(wrapperPath), { recursive: true });
    writeFileSync(plistPath, "plist");
    writeFileSync(wrapperPath, "wrapper");
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "Could not find service" });

    expect(uninstallClientService()).toMatchObject({
      platform: "launchd",
      label: channelConfig.launchdLabel,
      state: "not-installed",
      unitPath: plistPath,
    });
    expect(existsSync(plistPath)).toBe(false);
    expect(existsSync(wrapperPath)).toBe(false);
  });

  it("installs and refreshes a Windows Task Scheduler supervisor task", () => {
    setPlatform("win32");
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });

    const info = installClientService();
    const wrapper = readFileSync(windowsSupervisorWrapperPath(), "utf-8");
    const launcher = readFileSync(windowsSupervisorLauncherPath(), "utf-8");
    const { raw: xmlRaw, xml } = readWindowsTaskXmlFixture(windowsTaskXmlPath());

    expect(info).toMatchObject({
      platform: "task-scheduler",
      label: windowsTaskName(),
      state: "active",
      detail: "task run requested",
    });
    expect(wrapper).toContain(`set "FIRST_TREE_HOME=${process.env.FIRST_TREE_HOME}"`);
    expect(wrapper).toContain('"daemon" "supervise"');
    expect(wrapper).toContain(":supervisor_loop");
    expect(wrapper).toContain('if "%FT_EXIT%"=="75" goto supervisor_loop');
    expect(launcher).toContain(`shell.Run("""${windowsSupervisorWrapperPath()}""", 0, True)`);
    expect([...xmlRaw.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-16"\?>/u);
    expect(xml).toContain("wscript.exe");
    expect(xml).toContain(`${channelConfig.launchdLabel}-supervisor.vbs`);
    expect(xml).not.toContain(`${channelConfig.launchdLabel}-supervisor.cmd</Command>`);
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).not.toContain("RestartOnFailure");
    expect(spawnSyncMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ["schtasks.exe", ["/Create", "/TN", windowsTaskName(), "/XML", windowsTaskXmlPath(), "/F"]],
      ["schtasks.exe", ["/Run", "/TN", windowsTaskName()]],
    ]);
  });

  it("does not report Windows Task Scheduler XML drift after UTF-16LE writes", () => {
    setPlatform("win32");
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });

    installClientService();

    spawnSyncMock.mockClear();
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "Ready", stderr: "" });
    expect(isServiceUnitDriftDetected()).toBe(false);
  });

  it("does not surface mojibake from localized Windows native command stderr", () => {
    setPlatform("win32");
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "\uFFFD\uFFFD\uFFFD\uFFFD: XML" });

    expect(() => installClientService()).toThrow(
      "schtasks /Create failed: exit 1; Windows returned localized stderr that could not be decoded as UTF-8",
    );
  });

  it("reports Windows Task Scheduler status from the task state plus service runtime marker", () => {
    setPlatform("win32");
    const markerDir = join(process.env.FIRST_TREE_HOME ?? "", "state", "client-runtimes");
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(
      join(markerDir, `${process.pid}.json`),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        clientId: "client_aabbccdd",
        home: process.env.FIRST_TREE_HOME,
        mode: "service",
        createdAt: new Date().toISOString(),
      }),
    );
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "Running", stderr: "" });

    expect(getClientServiceStatus()).toMatchObject({
      platform: "task-scheduler",
      state: "active",
      pid: process.pid,
      detail: `pid ${process.pid}`,
    });

    rmSync(markerDir, { recursive: true, force: true });
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "Running", stderr: "" });
    expect(getClientServiceStatus()).toMatchObject({
      platform: "task-scheduler",
      state: "unknown",
      detail: "task running but no live service runtime marker",
    });
  });

  it("refuses to start a Windows task when an orphan service marker is still live", () => {
    setPlatform("win32");
    const markerDir = join(process.env.FIRST_TREE_HOME ?? "", "state", "client-runtimes");
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(
      join(markerDir, `${process.pid}.json`),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        clientId: "client_aabbccdd",
        home: process.env.FIRST_TREE_HOME,
        mode: "service",
        createdAt: new Date().toISOString(),
      }),
    );
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "Ready", stderr: "" });

    expect(startClientService()).toEqual({
      ok: false,
      reason: "service runtime marker is live without a running task; run daemon stop before starting again",
    });
  });

  it("stops Windows by writing stop intent, killing the service child, then ending the task", () => {
    setPlatform("win32");
    const markerDir = join(process.env.FIRST_TREE_HOME ?? "", "state", "client-runtimes");
    const markerCreatedAt = "2026-01-02T00:00:00.000Z";
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(
      join(markerDir, "4321.json"),
      JSON.stringify({
        version: 1,
        pid: 4321,
        clientId: "client_aabbccdd",
        home: process.env.FIRST_TREE_HOME,
        mode: "service",
        createdAt: markerCreatedAt,
      }),
    );
    let pidChecks = 0;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | string) => {
      if (pid === 4321 && signal === 0) {
        pidChecks += 1;
        if (pidChecks <= 3) return true;
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      return true;
    }) as typeof process.kill);
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "Running", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: windowsProcessIdentityJson(4321), stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: windowsProcessIdentityJson(4321), stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "Ready", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "[]", stderr: "" });

    try {
      expect(stopClientService()).toEqual({ ok: true });
      expect(spawnSyncMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
        [
          "powershell.exe",
          expect.arrayContaining([
            expect.stringContaining("Get-ScheduledTask -TaskPath '\\FirstTree\\' -TaskName 'first-tree-dev'"),
          ]),
        ],
        [
          "powershell.exe",
          expect.arrayContaining([expect.stringContaining('Get-CimInstance Win32_Process -Filter "ProcessId = 4321"')]),
        ],
        [
          "powershell.exe",
          expect.arrayContaining([expect.stringContaining('Get-CimInstance Win32_Process -Filter "ProcessId = 4321"')]),
        ],
        ["taskkill.exe", ["/PID", "4321", "/T"]],
        ["schtasks.exe", ["/End", "/TN", windowsTaskName()]],
        [
          "powershell.exe",
          expect.arrayContaining([
            expect.stringContaining("Get-ScheduledTask -TaskPath '\\FirstTree\\' -TaskName 'first-tree-dev'"),
          ]),
        ],
        ["powershell.exe", expect.arrayContaining([expect.stringContaining("Get-CimInstance Win32_Process")])],
      ]);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("treats localized taskkill failure as success when the Windows service pid has already exited", () => {
    setPlatform("win32");
    const markerDir = join(process.env.FIRST_TREE_HOME ?? "", "state", "client-runtimes");
    const markerCreatedAt = "2026-01-02T00:00:00.000Z";
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(
      join(markerDir, "5432.json"),
      JSON.stringify({
        version: 1,
        pid: 5432,
        clientId: "client_aabbccdd",
        home: process.env.FIRST_TREE_HOME,
        mode: "service",
        createdAt: markerCreatedAt,
      }),
    );
    let pidChecks = 0;
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | string) => {
      if (pid === 5432 && signal === 0) {
        pidChecks += 1;
        if (pidChecks <= 3) return true;
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      return true;
    }) as typeof process.kill);
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "Running", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: windowsProcessIdentityJson(5432), stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: windowsProcessIdentityJson(5432), stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "FEHLER: Prozess wurde nicht gefunden" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "Ready", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "[]", stderr: "" });

    try {
      expect(stopClientService()).toEqual({ ok: true });
      expect(spawnSyncMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
        [
          "powershell.exe",
          expect.arrayContaining([
            expect.stringContaining("Get-ScheduledTask -TaskPath '\\FirstTree\\' -TaskName 'first-tree-dev'"),
          ]),
        ],
        [
          "powershell.exe",
          expect.arrayContaining([expect.stringContaining('Get-CimInstance Win32_Process -Filter "ProcessId = 5432"')]),
        ],
        [
          "powershell.exe",
          expect.arrayContaining([expect.stringContaining('Get-CimInstance Win32_Process -Filter "ProcessId = 5432"')]),
        ],
        ["taskkill.exe", ["/PID", "5432", "/T"]],
        ["schtasks.exe", ["/End", "/TN", windowsTaskName()]],
        [
          "powershell.exe",
          expect.arrayContaining([
            expect.stringContaining("Get-ScheduledTask -TaskPath '\\FirstTree\\' -TaskName 'first-tree-dev'"),
          ]),
        ],
        ["powershell.exe", expect.arrayContaining([expect.stringContaining("Get-CimInstance Win32_Process")])],
      ]);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("refuses to taskkill a Windows runtime marker when the pid identity does not match the marker", () => {
    setPlatform("win32");
    const markerDir = join(process.env.FIRST_TREE_HOME ?? "", "state", "client-runtimes");
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(
      join(markerDir, "6543.json"),
      JSON.stringify({
        version: 1,
        pid: 6543,
        clientId: "client_aabbccdd",
        home: process.env.FIRST_TREE_HOME,
        mode: "service",
        createdAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | string) => {
      if (pid === 6543 && signal === 0) return true;
      return true;
    }) as typeof process.kill);
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "Running", stderr: "" }).mockReturnValueOnce({
      status: 0,
      stdout: windowsProcessIdentityJson(6543, { creationTimeUtc: "2026-01-02T00:00:30.0000000Z" }),
      stderr: "",
    });

    try {
      expect(stopClientService()).toEqual({
        ok: false,
        reason: expect.stringContaining("refusing to taskkill untrusted service runtime marker pid 6543"),
      });
      expect(spawnSyncMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
        [
          "powershell.exe",
          expect.arrayContaining([
            expect.stringContaining("Get-ScheduledTask -TaskPath '\\FirstTree\\' -TaskName 'first-tree-dev'"),
          ]),
        ],
        [
          "powershell.exe",
          expect.arrayContaining([expect.stringContaining('Get-CimInstance Win32_Process -Filter "ProcessId = 6543"')]),
        ],
      ]);
      expect(spawnSyncMock.mock.calls.some((call) => call[0] === "taskkill.exe")).toBe(false);
      expect(existsSync(windowsSupervisorStopIntentPath())).toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("prevalidates all Windows runtime markers before writing stop intent or killing any pid", () => {
    setPlatform("win32");
    const markerDir = join(process.env.FIRST_TREE_HOME ?? "", "state", "client-runtimes");
    mkdirSync(markerDir, { recursive: true });
    for (const pid of [1111, 2222]) {
      writeFileSync(
        join(markerDir, `${pid}.json`),
        JSON.stringify({
          version: 1,
          pid,
          clientId: "client_aabbccdd",
          home: process.env.FIRST_TREE_HOME,
          mode: "service",
          createdAt: "2026-01-02T00:00:00.000Z",
        }),
      );
    }
    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | string) => {
      if ((pid === 1111 || pid === 2222) && signal === 0) return true;
      return true;
    }) as typeof process.kill);
    spawnSyncMock.mockImplementation((program: string, args: string[]) => {
      const command = args.join(" ");
      if (program === "powershell.exe" && command.includes("Get-ScheduledTask")) {
        return { status: 0, stdout: "Running", stderr: "" };
      }
      if (program === "powershell.exe" && command.includes('ProcessId = 1111"')) {
        return { status: 0, stdout: windowsProcessIdentityJson(1111), stderr: "" };
      }
      if (program === "powershell.exe" && command.includes('ProcessId = 2222"')) {
        return {
          status: 0,
          stdout: windowsProcessIdentityJson(2222, { creationTimeUtc: "2026-01-02T00:00:30.0000000Z" }),
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    try {
      expect(stopClientService()).toEqual({
        ok: false,
        reason: expect.stringContaining("refusing to taskkill untrusted service runtime marker pid 2222"),
      });
      const commands = spawnSyncMock.mock.calls
        .map((call) => `${call[0]} ${(call[1] as string[]).join(" ")}`)
        .join("\n");
      expect(commands).toContain('Get-CimInstance Win32_Process -Filter "ProcessId = 1111"');
      expect(commands).toContain('Get-CimInstance Win32_Process -Filter "ProcessId = 2222"');
      expect(spawnSyncMock.mock.calls.some((call) => call[0] === "taskkill.exe")).toBe(false);
      expect(existsSync(windowsSupervisorStopIntentPath())).toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });

  it("keeps Windows stop intent when a no-marker stop leaves a supervisor process behind", () => {
    setPlatform("win32");
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(70001);
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "Running", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "Ready", stderr: "" })
      .mockReturnValueOnce({
        status: 0,
        stdout: windowsProcessListJson([{ pid: 7777 }]),
        stderr: "",
      });

    try {
      expect(stopClientService()).toEqual({
        ok: false,
        reason: expect.stringContaining("supervisor process still running after task end"),
      });
      expect(existsSync(windowsSupervisorStopIntentPath())).toBe(true);
      expect(spawnSyncMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
        [
          "powershell.exe",
          expect.arrayContaining([
            expect.stringContaining("Get-ScheduledTask -TaskPath '\\FirstTree\\' -TaskName 'first-tree-dev'"),
          ]),
        ],
        ["schtasks.exe", ["/End", "/TN", windowsTaskName()]],
        [
          "powershell.exe",
          expect.arrayContaining([
            expect.stringContaining("Get-ScheduledTask -TaskPath '\\FirstTree\\' -TaskName 'first-tree-dev'"),
          ]),
        ],
        ["powershell.exe", expect.arrayContaining([expect.stringContaining("Get-CimInstance Win32_Process")])],
      ]);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("keeps Windows stop intent when the task is missing but a supervisor process remains", () => {
    setPlatform("win32");
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(70001);
    spawnSyncMock
      .mockReturnValueOnce({ status: 3, stdout: "", stderr: "" })
      .mockReturnValueOnce({
        status: 0,
        stdout: windowsProcessListJson([{ pid: 8888 }]),
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: windowsProcessListJson([{ pid: 8888 }]),
        stderr: "",
      });

    try {
      expect(stopClientService()).toEqual({
        ok: false,
        reason: expect.stringContaining("supervisor process still running after task end"),
      });
      expect(existsSync(windowsSupervisorStopIntentPath())).toBe(true);
      expect(spawnSyncMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
        [
          "powershell.exe",
          expect.arrayContaining([
            expect.stringContaining("Get-ScheduledTask -TaskPath '\\FirstTree\\' -TaskName 'first-tree-dev'"),
          ]),
        ],
        ["powershell.exe", expect.arrayContaining([expect.stringContaining("Get-CimInstance Win32_Process")])],
        ["powershell.exe", expect.arrayContaining([expect.stringContaining("Get-CimInstance Win32_Process")])],
      ]);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("returns unsupported status for uninstall and throws install errors on unsupported platforms", () => {
    setPlatform("freebsd");
    expect(() => installClientService()).toThrow("Background service install is not supported on freebsd");
    expect(uninstallClientService()).toMatchObject({
      platform: "unsupported",
      label: "",
      state: "not-installed",
      detail: "platform freebsd not supported",
    });
  });

  it("covers service fallback details when platform tools omit stdout or stderr", () => {
    setPlatform("win32");
    execFileSyncMock.mockReturnValueOnce("\n");
    expect(resolveCliInvocation()).toEqual({
      kind: "node",
      program: "/opt/node/bin/node",
      args: ["/repo/dist/cli/index.mjs"],
    });
    expect(execFileSyncMock).toHaveBeenCalledWith("where", [channelConfig.binName], expect.any(Object));

    setPlatform("linux");
    const unitPath = join(process.env.XDG_CONFIG_HOME ?? "", "systemd", "user", channelConfig.serviceUnitFile);
    expect(getClientServiceStatus()).toMatchObject({ platform: "systemd", state: "not-installed" });

    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, "unit");
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "active\n", stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" });
    expect(getClientServiceStatus()).toMatchObject({ platform: "systemd", state: "active", detail: "running" });

    spawnSyncMock.mockReturnValueOnce({ status: 3, stdout: undefined, stderr: "" });
    expect(getClientServiceStatus()).toMatchObject({
      platform: "systemd",
      state: "inactive",
      detail: "unit present but not active",
    });

    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: undefined });
    expect(startClientService()).toEqual({ ok: false, reason: "exit 1" });

    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "" });
    expect(stopClientService()).toEqual({ ok: false, reason: "exit 1" });

    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "" });
    expect(restartClientService()).toEqual({ ok: false, reason: "exit 1" });
  });

  it("covers launchd fallback states and control failures", () => {
    setPlatform("darwin");
    const plistPath = join(home, "Library", "LaunchAgents", `${channelConfig.launchdLabel}.plist`);
    expect(getClientServiceStatus()).toMatchObject({ platform: "launchd", state: "not-installed" });

    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, "plist");
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "state = running\n", stderr: "" });
    expect(getClientServiceStatus()).toMatchObject({ platform: "launchd", state: "active", detail: "running" });

    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: undefined, stderr: "" });
    expect(getClientServiceStatus()).toMatchObject({ platform: "launchd", state: "inactive", detail: "loaded" });

    rmSync(plistPath, { force: true });
    expect(startClientService()).toEqual({ ok: false, reason: "service not installed" });
    expect(restartClientService()).toEqual({ ok: false, reason: "service not installed" });

    writeFileSync(plistPath, "plist");
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "loaded", stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" });
    expect(startClientService()).toEqual({ ok: false, reason: "exit 1" });

    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" });
    expect(startClientService()).toEqual({ ok: false, reason: "exit 1" });

    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "" });
    expect(stopClientService()).toEqual({ ok: false, reason: "exit 1" });

    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "", stderr: "" });
    expect(restartClientService()).toEqual({ ok: true });

    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "kick failed" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" });
    expect(restartClientService()).toEqual({ ok: false, reason: "exit 1" });
  });

  it("covers systemd install refresh and uninstall fallback messages", () => {
    setPlatform("linux");
    userInfoMock.mockReturnValue({ uid: 501, username: "" });
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "inactive\n", stderr: "" });
    expect(installClientService()).toMatchObject({ platform: "systemd", state: "inactive" });
    expect(printMocks.line).toHaveBeenCalledWith(expect.stringContaining("could not determine username"));
    userInfoMock.mockReturnValue({ uid: 501, username: "gandy" });

    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "" });
    expect(() => installClientService()).toThrow("systemctl --user daemon-reload failed: exit 1");

    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "inactive\n", stderr: "" });
    expect(refreshClientServiceUnitForUpdate()).toMatchObject({ platform: "systemd", state: "inactive" });
    expect(printMocks.line).toHaveBeenCalledWith(expect.stringContaining("loginctl enable-linger failed: exit 1"));

    const unitPath = join(process.env.XDG_CONFIG_HOME ?? "", "systemd", "user", channelConfig.serviceUnitFile);
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, "unit");
    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" });
    expect(uninstallClientService()).toMatchObject({ platform: "systemd", state: "not-installed" });
    expect(printMocks.line).toHaveBeenCalledWith(expect.stringContaining("systemctl disable during uninstall: exit 1"));
    expect(printMocks.line).toHaveBeenCalledWith(
      expect.stringContaining("systemctl daemon-reload during uninstall: exit 1"),
    );
  });

  it("covers launchd install retry fallbacks without stderr", () => {
    setPlatform("darwin");
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValueOnce(10_001);
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" });

    expect(() => installClientService()).toThrow("launchctl bootstrap failed: exit 1");
    expect(printMocks.line).toHaveBeenCalledWith(expect.stringContaining("warning: launchctl bootout: exit 1"));
    expect(printMocks.line).toHaveBeenCalledWith(expect.stringContaining("bootout still settling"));
    dateNowSpy.mockRestore();

    const plistPath = join(home, "Library", "LaunchAgents", `${channelConfig.launchdLabel}.plist`);
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, "plist");
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValueOnce({ status: 1, stdout: "", stderr: "" });
    expect(uninstallClientService()).toMatchObject({ platform: "launchd", state: "not-installed" });
    expect(printMocks.line).toHaveBeenCalledWith(expect.stringContaining("warning: bootout during uninstall: exit 1"));
  });

  it("covers unknown-exit service-manager fallbacks", () => {
    setPlatform("linux");
    const unitPath = join(process.env.XDG_CONFIG_HOME ?? "", "systemd", "user", channelConfig.serviceUnitFile);
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, "unit");

    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "active\n", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: undefined, stderr: "" });
    expect(getClientServiceStatus()).toMatchObject({ state: "active", detail: "running" });

    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValueOnce({ status: null, signal: undefined, stdout: "", stderr: "" });
    expect(() => installClientService()).toThrow("systemctl --user daemon-reload failed: exit unknown");

    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "yes\n", stderr: "" })
      .mockReturnValueOnce({ status: null, signal: undefined, stdout: "", stderr: "" });
    expect(() => installClientService()).toThrow(
      `systemctl --user enable --now ${channelConfig.serviceUnitFile} failed: exit unknown`,
    );

    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: null, signal: undefined, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "inactive\n", stderr: "" });
    expect(refreshClientServiceUnitForUpdate()).toMatchObject({ state: "inactive" });
    expect(printMocks.line).toHaveBeenCalledWith(
      expect.stringContaining("loginctl enable-linger failed: exit unknown"),
    );

    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce({ status: null, signal: undefined, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: null, signal: undefined, stdout: "", stderr: "" });
    expect(uninstallClientService()).toMatchObject({ state: "not-installed" });
    expect(printMocks.line).toHaveBeenCalledWith(
      expect.stringContaining("systemctl disable during uninstall: exit unknown"),
    );
    expect(printMocks.line).toHaveBeenCalledWith(
      expect.stringContaining("systemctl daemon-reload during uninstall: exit unknown"),
    );

    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValueOnce({ status: null, signal: undefined, stdout: "", stderr: "" });
    expect(startClientService()).toEqual({ ok: false, reason: "exit unknown" });

    spawnSyncMock.mockReturnValueOnce({ status: null, signal: undefined, stdout: "", stderr: "" });
    expect(stopClientService()).toEqual({ ok: false, reason: "exit unknown" });

    spawnSyncMock.mockReturnValueOnce({ status: null, signal: undefined, stdout: "", stderr: "" });
    expect(restartClientService()).toEqual({ ok: false, reason: "exit unknown" });

    setPlatform("darwin");
    const plistPath = join(home, "Library", "LaunchAgents", `${channelConfig.launchdLabel}.plist`);
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, "plist");

    spawnSyncMock.mockReset();
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(10_001);
    spawnSyncMock
      .mockReturnValueOnce({ status: null, signal: undefined, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: null, signal: undefined, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: null, signal: undefined, stdout: "", stderr: "" });
    expect(() => installClientService()).toThrow("launchctl bootstrap failed: exit unknown");
    expect(printMocks.line).toHaveBeenCalledWith(expect.stringContaining("warning: launchctl bootout: exit unknown"));
    dateNowSpy.mockRestore();

    spawnSyncMock.mockReset();
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "not loaded" })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: null, signal: undefined, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: 0, stdout: "state = stopped\n", stderr: "" });
    expect(installClientService()).toMatchObject({ platform: "launchd", state: "inactive" });
    expect(printMocks.line).toHaveBeenCalledWith(expect.stringContaining("warning: launchctl enable: exit unknown"));

    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValueOnce({ status: null, signal: undefined, stdout: "", stderr: "" });
    expect(uninstallClientService()).toMatchObject({ state: "not-installed" });
    expect(printMocks.line).toHaveBeenCalledWith(
      expect.stringContaining("warning: bootout during uninstall: exit unknown"),
    );

    writeFileSync(plistPath, "plist");
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: undefined })
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" });
    expect(startClientService()).toEqual({ ok: false, reason: "exit 1" });

    spawnSyncMock.mockReturnValueOnce({ status: null, signal: undefined, stdout: "", stderr: "" });
    expect(stopClientService()).toEqual({ ok: false, reason: "exit unknown" });

    writeFileSync(plistPath, "plist");
    spawnSyncMock
      .mockReturnValueOnce({ status: null, signal: undefined, stdout: "", stderr: "" })
      .mockReturnValueOnce({ status: null, signal: undefined, stdout: "", stderr: "" });
    expect(restartClientService()).toEqual({ ok: false, reason: "exit unknown" });
  });
});
