import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const coreMocks = vi.hoisted(() => ({
  getClientServiceStatus: vi.fn(),
  getClientSwitchStartupBlock: vi.fn(() => ({ phase: "qa" })),
  installClientService: vi.fn(),
  isServiceSupported: vi.fn(() => false),
  isServiceUnitDriftDetected: vi.fn(() => false),
  loadCredentials: vi.fn(),
  loadDaemonEnv: vi.fn(() => []),
  refreshClientServiceUnitForUpdate: vi.fn(),
  restartClientService: vi.fn(),
}));

const outputMocks = vi.hoisted(() => ({
  line: vi.fn(),
  setJsonMode: vi.fn(),
}));

const statusMocks = vi.hoisted(() => ({
  renderAgentsBlock: vi.fn(),
  renderAuthBlock: vi.fn(),
  renderCliVersionBlock: vi.fn(),
  renderHubBlock: vi.fn(),
  renderServiceBlock: vi.fn(),
}));

vi.mock("../core/index.js", () => coreMocks);
vi.mock("../core/output.js", () => ({
  print: { line: outputMocks.line },
  setJsonMode: outputMocks.setJsonMode,
}));
vi.mock("../commands/_shared/status-blocks.js", () => statusMocks);

import { type CliRuntimeDependencies, configureCliRuntime } from "../cli/runtime.js";
import { registerDaemonEnsureServiceCommand } from "../commands/daemon/ensure-service.js";
import { registerDaemonRefreshUnitCommand } from "../commands/daemon/refresh-unit.js";
import { registerDaemonStartCommand } from "../commands/daemon/start.js";
import { registerStatusCommand } from "../commands/status.js";
import type {
  LegacyGithubScanLaunchdRetirementDiagnostic,
  LegacyGithubScanLaunchdRetirementResult,
} from "../core/legacy-github-scan-launchd-retirement.js";

type RuntimeHarness = {
  dependencies: CliRuntimeDependencies;
  events: string[];
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  runRetirement: ReturnType<typeof vi.fn>;
};

function result(
  status: LegacyGithubScanLaunchdRetirementResult["status"] = "absent",
): LegacyGithubScanLaunchdRetirementResult {
  return { status, retired: 0, diagnostics: [] };
}

function runtimeHarness(outcome: LegacyGithubScanLaunchdRetirementResult = result()): RuntimeHarness {
  const events: string[] = [];
  const info = vi.fn();
  const error = vi.fn();
  const runRetirement = vi.fn(() => {
    events.push("migration");
    return outcome;
  });
  return {
    events,
    info,
    error,
    runRetirement,
    dependencies: {
      env: {},
      setJsonMode: (enabled) => events.push(`json:${enabled}`),
      applyClientLoggerConfig: (options) => events.push(`logger-config:${options?.level ?? "env"}`),
      createLogger: () => {
        events.push("migration-logger");
        return { info, error };
      },
      runLegacyGithubScanLaunchdRetirementOnce: runRetirement,
    },
  };
}

function programFor(harness: RuntimeHarness): Command {
  const program = new Command();
  program
    .name("first-tree-staging")
    .version("0.0.0-test")
    .exitOverride()
    .configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  configureCliRuntime(program, harness.dependencies);
  return program;
}

function registerMaintenanceCommands(program: Command): void {
  const daemon = program.command("daemon");
  registerDaemonStartCommand(daemon);
  registerDaemonEnsureServiceCommand(daemon);
  registerDaemonRefreshUnitCommand(daemon);
}

function parse(program: Command, args: string[]): void {
  program.parse(["node", "first-tree-staging", ...args]);
}

describe("CLI runtime migration hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    coreMocks.isServiceSupported.mockReturnValue(false);
  });

  it("runs synchronously after output normalization and before an ordinary real command action", () => {
    const harness = runtimeHarness();
    statusMocks.renderCliVersionBlock.mockImplementationOnce(() => harness.events.push("action:status"));
    const program = programFor(harness);
    registerStatusCommand(program);

    parse(program, ["status"]);

    expect(harness.events).toEqual([
      "json:false",
      "logger-config:warn",
      "migration-logger",
      "migration",
      "action:status",
    ]);
    expect(harness.runRetirement).toHaveBeenCalledTimes(1);
  });

  it("runs for portable ensure-service before its real registered action", () => {
    const harness = runtimeHarness();
    outputMocks.line.mockImplementationOnce(() => harness.events.push("action:ensure-service"));
    const program = programFor(harness);
    registerMaintenanceCommands(program);

    parse(program, ["daemon", "ensure-service"]);

    expect(harness.events).toEqual([
      "json:false",
      "logger-config:warn",
      "migration-logger",
      "migration",
      "action:ensure-service",
    ]);
  });

  it("skips only the old-X refresh child, then a fresh supervisor daemon start migrates", () => {
    const refreshHarness = runtimeHarness();
    outputMocks.line.mockImplementationOnce(() => refreshHarness.events.push("action:refresh-unit"));
    const refreshProgram = programFor(refreshHarness);
    registerMaintenanceCommands(refreshProgram);

    parse(refreshProgram, ["daemon", "refresh-unit"]);

    expect(refreshHarness.events).toEqual(["json:false", "logger-config:warn", "action:refresh-unit"]);
    expect(refreshHarness.runRetirement).not.toHaveBeenCalled();

    const restartHarness = runtimeHarness();
    const restartProgram = programFor(restartHarness);
    outputMocks.line.mockImplementationOnce(() => restartHarness.events.push("action:daemon-start"));
    registerMaintenanceCommands(restartProgram);

    parse(restartProgram, ["daemon", "start"]);

    expect(restartHarness.events).toEqual([
      "json:false",
      "logger-config:warn",
      "migration-logger",
      "migration",
      "action:daemon-start",
    ]);
  });

  it("does not migrate for root, nested, positional help, version, or no-action parsing", () => {
    const cases = [["--help"], ["daemon", "--help"], ["help", "daemon"], ["--version"], []] as const;

    for (const args of cases) {
      const harness = runtimeHarness();
      const program = programFor(harness);
      registerMaintenanceCommands(program);
      registerStatusCommand(program);

      try {
        parse(program, [...args]);
      } catch {
        // `exitOverride()` represents Commander's normal help/version exit.
      }

      expect(harness.runRetirement, args.join(" ") || "no action").not.toHaveBeenCalled();
      expect(harness.events, args.join(" ") || "no action").toEqual([]);
    }
  });

  it("keeps partial failures visible at JSON's error level without blocking the action", () => {
    const diagnostic: LegacyGithubScanLaunchdRetirementDiagnostic = {
      stage: "verify",
      reason: "verification-timeout",
      label: "com.first-tree.github-scan.runner.qa.default",
    };
    const harness = runtimeHarness({
      status: "partial",
      retired: 0,
      diagnostics: [diagnostic],
      retryAt: 123_456,
    });
    harness.dependencies.env.FIRST_TREE_JSON = "1";
    statusMocks.renderCliVersionBlock.mockImplementationOnce(() => harness.events.push("action:status"));
    const program = programFor(harness);
    registerStatusCommand(program);

    parse(program, ["status"]);

    expect(harness.events).toEqual([
      "json:true",
      "logger-config:error",
      "migration-logger",
      "migration",
      "action:status",
    ]);
    expect(harness.error).toHaveBeenCalledWith(
      { retired: 0, retryAt: 123_456, diagnostics: [diagnostic] },
      expect.stringContaining("incomplete"),
    );
  });

  it("keeps deferred diagnostics visible in JSON mode while continuing the action", () => {
    const diagnostic: LegacyGithubScanLaunchdRetirementDiagnostic = {
      stage: "bootout",
      reason: "exit-nonzero",
      label: "com.first-tree.github-scan.runner.qa.default",
      status: 1,
    };
    const harness = runtimeHarness({
      status: "deferred",
      retired: 0,
      diagnostics: [diagnostic],
      retryAt: 654_321,
    });
    harness.dependencies.env.FIRST_TREE_JSON = "1";
    statusMocks.renderCliVersionBlock.mockImplementationOnce(() => harness.events.push("action:status"));
    const program = programFor(harness);
    registerStatusCommand(program);

    parse(program, ["status"]);

    expect(harness.events.at(-1)).toBe("action:status");
    expect(harness.error).toHaveBeenCalledWith(
      { retired: 0, retryAt: 654_321, diagnostics: [diagnostic] },
      expect.stringContaining("deferred"),
    );
    expect(harness.info).not.toHaveBeenCalled();
  });

  it("normalizes unexpected exceptions and continues the selected action", () => {
    const harness = runtimeHarness();
    harness.runRetirement.mockImplementationOnce(() => {
      harness.events.push("migration");
      throw new Error("do not expose /Users/example/private-path");
    });
    statusMocks.renderCliVersionBlock.mockImplementationOnce(() => harness.events.push("action:status"));
    const program = programFor(harness);
    registerStatusCommand(program);

    parse(program, ["status"]);

    expect(harness.events.at(-1)).toBe("action:status");
    expect(harness.error).toHaveBeenCalledWith({ errorType: "Error" }, expect.stringContaining("continuing command"));
    expect(JSON.stringify(harness.error.mock.calls)).not.toContain("private-path");
  });
});
