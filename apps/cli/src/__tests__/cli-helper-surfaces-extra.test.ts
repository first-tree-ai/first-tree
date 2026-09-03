import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";

const doctorCoreMocks = vi.hoisted(() => ({
  checkAgentConfigs: vi.fn(),
  checkBackgroundService: vi.fn(),
  checkClientConfig: vi.fn(),
  checkDaemonRuntimeOwnership: vi.fn(),
  checkNodeVersion: vi.fn(),
  checkServerReachable: vi.fn(),
  checkWebSocket: vi.fn(),
  ensureFreshAccessToken: vi.fn(),
  inspectLocalContextTree: vi.fn(),
  listLocalContextDataLoss: vi.fn(),
  reconcileAgentConfigs: vi.fn(),
  resolveContextTreeCli: vi.fn(),
  resolveServerUrl: vi.fn(),
  runContextTreeCommand: vi.fn(),
  runtimeProviderChecks: vi.fn(),
}));

const clientMocks = vi.hoisted(() => ({
  FirstTreeHubSDK: vi.fn(),
  ClientOrgMismatchError: class ClientOrgMismatchError extends Error {},
  probeCapabilities: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
  clientConfigSchema: {},
  defaultDataDir: vi.fn(),
  defaultHome: vi.fn(),
  initConfig: vi.fn(),
  readContextTreeRepositorySetting: vi.fn(),
  resetConfig: vi.fn(),
  resetConfigMeta: vi.fn(),
}));

const cliFetchMock = vi.hoisted(() => vi.fn());

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
}));

const doctorVerifyMocks = vi.hoisted(() => ({
  verifyTreeRoot: vi.fn(),
}));

const printMocks = vi.hoisted(() => ({
  blank: vi.fn(),
  line: vi.fn(),
}));

vi.mock("../core/index.js", () => ({
  CLI_USER_AGENT: "first-tree-test",
  ...doctorCoreMocks,
}));
vi.mock("@first-tree/client", () => clientMocks);
vi.mock("@first-tree/shared/config", () => configMocks);
vi.mock("../core/cli-fetch.js", () => ({ cliFetch: cliFetchMock }));
vi.mock("../cli/output.js", () => outputMocks);
vi.mock("../core/output.js", () => ({ print: printMocks }));
vi.mock("../commands/tree/verify.js", () => doctorVerifyMocks);

let tempDir = "";
const originalExit = process.exit;

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn(async () => body),
    text: vi.fn(async () => (typeof body === "string" ? body : JSON.stringify(body))),
  } as unknown as Response;
}

function setRawArgs(command: Command, rawArgs: string[]): void {
  Object.defineProperty(command, "rawArgs", { configurable: true, value: rawArgs, writable: true });
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ft-cli-helper-extra-"));
  vi.clearAllMocks();
  doctorCoreMocks.checkAgentConfigs.mockReturnValue({ label: "Agents", ok: true, detail: "local" });
  doctorCoreMocks.checkBackgroundService.mockReturnValue({ label: "Service", ok: true, detail: "running" });
  doctorCoreMocks.checkClientConfig.mockReturnValue({ label: "Config", ok: true, detail: "ok" });
  doctorCoreMocks.checkDaemonRuntimeOwnership.mockReturnValue({ label: "Owner", ok: true, detail: "pid 123" });
  doctorCoreMocks.checkNodeVersion.mockReturnValue({ label: "Node", ok: true, detail: "v24" });
  doctorCoreMocks.checkServerReachable.mockResolvedValue({ label: "Server", ok: true, detail: "ok" });
  doctorCoreMocks.checkWebSocket.mockResolvedValue({ label: "WebSocket", ok: true, detail: "ok" });
  doctorCoreMocks.ensureFreshAccessToken.mockResolvedValue("token");
  doctorCoreMocks.listLocalContextDataLoss.mockReturnValue([]);
  // External Context Tree mode off — the default for a machine that has not set
  // `context_tree.repository`. The check reports that as healthy.
  configMocks.readContextTreeRepositorySetting.mockReturnValue({ raw: null, repository: null });
  doctorCoreMocks.reconcileAgentConfigs.mockResolvedValue({ label: "Agents", ok: true, detail: "reconciled" });
  doctorCoreMocks.resolveServerUrl.mockReturnValue("https://hub.example");
  doctorCoreMocks.runtimeProviderChecks.mockReturnValue([{ label: "codex", ok: true, detail: "ok — bundled" }]);
  doctorVerifyMocks.verifyTreeRoot.mockReturnValue({ ok: true });
  clientMocks.probeCapabilities.mockResolvedValue({});
  configMocks.initConfig.mockResolvedValue({ client: { id: "client-1" } });
  configMocks.defaultDataDir.mockReturnValue(join(tempDir, "data"));
  configMocks.defaultHome.mockReturnValue(tempDir);
  clientMocks.FirstTreeHubSDK.mockImplementation(() => ({ listMyAgents: vi.fn(async () => []) }));
  process.exit = vi.fn(((code?: number) => {
    throw Object.assign(new Error("process.exit"), { code });
  }) as never);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  process.exit = originalExit;
  process.exitCode = undefined;
});

describe("command context and command groups", () => {
  it("resolves debug and quiet precedence from raw argv and invokes wrapped actions", async () => {
    const { createCommandContext, withCommandContext } = await import("../commands/command-context.js");
    const program = new Command();
    program.name("first-tree").option("--json").option("--debug", undefined, false).option("--quiet", undefined, false);
    const child = program.command("probe");
    setRawArgs(program, ["node", "first-tree", "--quiet", "-d", "probe"]);
    program.setOptionValue("json", true);

    expect(createCommandContext(child).options).toEqual({ json: true, debug: true, quiet: false });

    setRawArgs(program, ["node", "first-tree", "-dq", "probe"]);
    expect(createCommandContext(child).options).toEqual({ json: true, debug: false, quiet: true });

    setRawArgs(program, ["probe", "--debug", "--", "--quiet"]);
    expect(createCommandContext(child).options).toEqual({ json: true, debug: true, quiet: false });

    const action = vi.fn();
    withCommandContext(action).call(child);
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ command: child }));
  });

  it("registers command groups with help for bare invocation and unknown-command handling", async () => {
    const { registerCommandGroup } = await import("../commands/groups.js");
    const program = new Command();
    const action = vi.fn();
    registerCommandGroup(program, "tree", "Tree commands", [
      { name: "status", alias: "st", summary: "Show", description: "Show status", action },
    ]);

    const tree = program.commands.find((entry) => entry.name() === "tree");
    if (!tree) throw new Error("missing tree command");
    const help = vi.spyOn(tree, "outputHelp").mockImplementation(() => undefined);
    tree.args = [];
    await program.parseAsync(["tree"], { from: "user" });
    expect(help).toHaveBeenCalled();

    const unknown = vi
      .spyOn(tree as Command & { unknownCommand(): void }, "unknownCommand")
      .mockImplementation(() => undefined);
    tree.args = ["typo"];
    await program.parseAsync(["tree", "typo"], { from: "user" });
    expect(unknown).toHaveBeenCalled();
  });
});

describe("doctor checks and agent resolver", () => {
  function validLocalIdentity(workspace: string): Record<string, unknown> {
    return {
      agentId: "agent-uuid",
      agentName: "agent-local",
      contextSourceKind: "local",
      contextTreePath: join(workspace, "local-context"),
      serverUrl: "https://hub.example",
    };
  }

  it("runs server-aware daemon checks and falls back to local agent checks", async () => {
    const { runDaemonChecks } = await import("../commands/_shared/doctor-checks.js");

    await expect(runDaemonChecks()).resolves.toEqual([
      { label: "Node", ok: true, detail: "v24" },
      { label: "Config", ok: true, detail: "ok" },
      { label: "Server", ok: true, detail: "ok" },
      { label: "Agents", ok: true, detail: "reconciled" },
      { label: "WebSocket", ok: true, detail: "ok" },
      { label: "Service", ok: true, detail: "running" },
      { label: "Owner", ok: true, detail: "pid 123" },
      { label: "Local Context", ok: true, detail: "no Agent Local Context directories" },
      { label: "Context Tree CLI", ok: true, detail: "external mode off (context_tree.repository unset)" },
      { label: "codex", ok: true, detail: "ok — bundled" },
    ]);
    expect(configMocks.resetConfig).toHaveBeenCalled();
    expect(configMocks.resetConfigMeta).toHaveBeenCalled();

    configMocks.initConfig.mockRejectedValueOnce(new Error("no config"));
    const fallback = await runDaemonChecks();
    expect(fallback[3]).toEqual({ label: "Agents", ok: true, detail: "local" });
  });

  it("fails the Context Tree check when external mode is configured but the CLI is unresolvable", async () => {
    const { runDaemonChecks } = await import("../commands/_shared/doctor-checks.js");
    configMocks.readContextTreeRepositorySetting.mockReturnValue({ raw: "acme/context", repository: "acme/context" });
    doctorCoreMocks.resolveContextTreeCli.mockReturnValue(null);

    const checks = await runDaemonChecks();
    const contextTree = checks.find((check) => check.label === "Context Tree CLI");
    expect(contextTree?.ok).toBe(false);
    expect(contextTree?.detail).toContain("acme/context");
    expect(contextTree?.detail).toContain("not installed");
    // Nothing was probed: an unresolvable bin short-circuits before spawning.
    expect(doctorCoreMocks.runContextTreeCommand).not.toHaveBeenCalled();
  });

  it("reports external mode on when the CLI answers a probe", async () => {
    const { runDaemonChecks } = await import("../commands/_shared/doctor-checks.js");
    configMocks.readContextTreeRepositorySetting.mockReturnValue({ raw: "acme/context", repository: "acme/context" });
    doctorCoreMocks.resolveContextTreeCli.mockReturnValue({ command: "node", args: ["/cli.mjs"] });
    doctorCoreMocks.runContextTreeCommand.mockResolvedValue({ ok: true, payload: { trees: [] } });

    const checks = await runDaemonChecks();
    expect(checks.find((check) => check.label === "Context Tree CLI")).toEqual({
      label: "Context Tree CLI",
      ok: true,
      detail: "external mode on (acme/context)",
    });
    // `list` is the probe: no connection, no network, tolerates an absent root.
    expect(doctorCoreMocks.runContextTreeCommand).toHaveBeenCalledWith(["list", "--json"]);
  });

  it("reports a set-but-unusable Context Tree repository", async () => {
    const { runDaemonChecks } = await import("../commands/_shared/doctor-checks.js");
    configMocks.readContextTreeRepositorySetting.mockReturnValue({ raw: "owner/.hidden", repository: null });

    const checks = await runDaemonChecks();

    expect(checks.find((check) => check.label === "Context Tree CLI")).toEqual({
      label: "Context Tree CLI",
      ok: false,
      detail: 'context_tree.repository value "owner/.hidden" is unusable; external mode is off',
    });
    expect(doctorCoreMocks.resolveContextTreeCli).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "dangling symlink",
      setup: (path: string) => symlinkSync(`${path}.missing`, path),
    },
    {
      label: "directory",
      setup: (path: string) => mkdirSync(path),
    },
  ])("reports a source-state.json $label as unhealthy instead of active", async ({ setup }) => {
    const workspace = join(tempDir, "workspaces", "agent-local");
    const localContext = join(workspace, "local-context");
    const runtimeState = join(workspace, ".first-tree-workspace");
    mkdirSync(localContext, { recursive: true });
    mkdirSync(runtimeState, { recursive: true });
    writeFileSync(join(runtimeState, "identity.json"), JSON.stringify(validLocalIdentity(workspace)));
    setup(join(runtimeState, "source-state.json"));
    doctorCoreMocks.listLocalContextDataLoss.mockReturnValue([
      { agentName: "agent-local", path: localContext, storage: "active" },
    ]);
    const { checkLocalContexts } = await import("../commands/_shared/doctor-checks.js");

    expect(checkLocalContexts()).toMatchObject({
      ok: false,
      detail: expect.stringContaining("source-state.json is not a trusted regular file"),
    });
  });

  it.each([
    {
      label: "dangling",
      setup: (identityPath: string) => symlinkSync(`${identityPath}.missing`, identityPath),
    },
    {
      label: "externally valid",
      setup: (identityPath: string) => {
        const externalIdentity = join(tempDir, "external-identity.json");
        writeFileSync(externalIdentity, JSON.stringify(validLocalIdentity(join(tempDir, "workspaces", "agent-local"))));
        symlinkSync(externalIdentity, identityPath);
      },
    },
  ])("reports an $label identity symlink as unhealthy even when its target is readable", async ({ setup }) => {
    const workspace = join(tempDir, "workspaces", "agent-local");
    const localContext = join(workspace, "local-context");
    const runtimeState = join(workspace, ".first-tree-workspace");
    mkdirSync(localContext, { recursive: true });
    mkdirSync(runtimeState, { recursive: true });
    setup(join(runtimeState, "identity.json"));
    doctorCoreMocks.listLocalContextDataLoss.mockReturnValue([
      { agentName: "agent-local", path: localContext, storage: "active" },
    ]);
    const { checkLocalContexts } = await import("../commands/_shared/doctor-checks.js");

    expect(checkLocalContexts()).toMatchObject({
      ok: false,
      detail: expect.stringContaining("identity.json is not a trusted regular file"),
    });
  });

  it("reports an incomplete identity instead of counting Local Context as active", async () => {
    const workspace = join(tempDir, "workspaces", "agent-local");
    const localContext = join(workspace, "local-context");
    const runtimeState = join(workspace, ".first-tree-workspace");
    mkdirSync(localContext, { recursive: true });
    mkdirSync(runtimeState, { recursive: true });
    writeFileSync(
      join(runtimeState, "identity.json"),
      JSON.stringify({ agentName: "agent-local", contextSourceKind: "local" }),
    );
    doctorCoreMocks.listLocalContextDataLoss.mockReturnValue([
      { agentName: "agent-local", path: localContext, storage: "active" },
    ]);
    const { checkLocalContexts } = await import("../commands/_shared/doctor-checks.js");

    expect(checkLocalContexts()).toMatchObject({
      ok: false,
      detail: expect.stringContaining("identity.json is malformed or incomplete"),
    });
  });

  it("reports an active Local identity whose contextTreePath does not name that workspace tree", async () => {
    const workspace = join(tempDir, "workspaces", "agent-local");
    const localContext = join(workspace, "local-context");
    const runtimeState = join(workspace, ".first-tree-workspace");
    mkdirSync(localContext, { recursive: true });
    mkdirSync(runtimeState, { recursive: true });
    writeFileSync(
      join(runtimeState, "identity.json"),
      JSON.stringify({ ...validLocalIdentity(workspace), contextTreePath: join(workspace, "other-context") }),
    );
    doctorCoreMocks.listLocalContextDataLoss.mockReturnValue([
      { agentName: "agent-local", path: localContext, storage: "active" },
    ]);
    const { checkLocalContexts } = await import("../commands/_shared/doctor-checks.js");

    expect(checkLocalContexts()).toMatchObject({
      ok: false,
      detail: expect.stringContaining("Local identity contextTreePath mismatch"),
    });
  });

  it("reports an incomplete V1 latch instead of counting Local Context as frozen", async () => {
    const workspace = join(tempDir, "workspaces", "agent-local");
    const localContext = join(workspace, "local-context");
    const runtimeState = join(workspace, ".first-tree-workspace");
    mkdirSync(localContext, { recursive: true });
    mkdirSync(runtimeState, { recursive: true });
    writeFileSync(join(runtimeState, "identity.json"), JSON.stringify(validLocalIdentity(workspace)));
    writeFileSync(join(runtimeState, "source-state.json"), JSON.stringify({ schemaVersion: 1, remoteObserved: true }));
    doctorCoreMocks.listLocalContextDataLoss.mockReturnValue([
      { agentName: "agent-local", path: localContext, storage: "active" },
    ]);
    const { checkLocalContexts } = await import("../commands/_shared/doctor-checks.js");

    expect(checkLocalContexts()).toMatchObject({
      ok: false,
      detail: expect.stringContaining("corrupt or unsupported source-state.json"),
    });
  });

  it("resolves managed agents by name or uuid and maps fetch/not-found failures", async () => {
    const { resolveAgent } = await import("../commands/_shared/resolve-agent.js");
    cliFetchMock.mockResolvedValueOnce(
      jsonResponse([
        { uuid: "agent-1", name: "nova", displayName: "Nova" },
        { uuid: "agent-2", name: null, displayName: null },
      ]),
    );
    await expect(resolveAgent("https://hub.example", "token", "nova")).resolves.toMatchObject({ uuid: "agent-1" });

    cliFetchMock.mockResolvedValueOnce(jsonResponse([{ uuid: "agent-2", name: null, displayName: null }]));
    await expect(resolveAgent("https://hub.example", "token", "agent-2")).resolves.toMatchObject({ uuid: "agent-2" });

    cliFetchMock.mockResolvedValueOnce(jsonResponse("bad", false, 503));
    await expect(resolveAgent("https://hub.example", "token", "missing")).rejects.toMatchObject({
      code: "FETCH_ERROR",
      exitCode: 1,
    });

    cliFetchMock.mockResolvedValueOnce(jsonResponse([]));
    await expect(resolveAgent("https://hub.example", "token", "missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
      exitCode: 1,
    });
  });
});

describe("client org mismatch handler", () => {
  it("fails closed with reset-first recovery and leaves client.yaml unchanged", async () => {
    const yamlPath = join(tempDir, "client.yaml");
    const before = stringifyYaml({ client: { id: "client_11111111" } });
    writeFileSync(yamlPath, before);
    const { handleClientOrgMismatch } = await import("../core/client-reidentify.js");

    await expect(
      handleClientOrgMismatch(new Error("wrong org") as never, {
        managed: false,
        configDir: tempDir,
        rerunCommand: "first-tree-dev login token",
      }),
    ).rejects.toMatchObject({ code: 1 });

    expect(readFileSync(yamlPath, "utf8")).toBe(before);
    const output = printMocks.line.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("wrong org");
    expect(output).toContain("first-tree-dev login <code>");
    expect(output).toContain("first-tree-dev computer reset");
    expect(output).toContain("valid server-side owner pair");
    expect(output).not.toContain("Rotate");
    expect(output).not.toContain("Rotated");
    expect(output).not.toContain("client.yaml.bak");
  });

  it("uses the same reset-first recovery in managed mode", async () => {
    const { handleClientOrgMismatch } = await import("../core/client-reidentify.js");

    await expect(
      handleClientOrgMismatch(new Error("wrong org") as never, {
        managed: true,
        configDir: tempDir,
        rerunCommand: "ignored",
      }),
    ).rejects.toMatchObject({ code: 1 });

    const output = printMocks.line.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("first-tree-dev login <code>");
    expect(output).toContain("first-tree-dev computer reset");
  });

  it("routes managed recovery text through an injected output sink", async () => {
    const { handleClientOrgMismatch } = await import("../core/client-reidentify.js");
    const output = {
      blank: vi.fn(),
      line: vi.fn(),
    };

    await expect(
      handleClientOrgMismatch(new Error("wrong org") as never, {
        managed: true,
        configDir: tempDir,
        rerunCommand: "ignored",
        output,
      }),
    ).rejects.toMatchObject({ code: 1 });

    expect(output.blank).toHaveBeenCalled();
    expect(output.line).toHaveBeenCalledWith(expect.stringContaining("wrong org"));
    expect(printMocks.blank).not.toHaveBeenCalled();
    expect(printMocks.line).not.toHaveBeenCalled();
  });

  it("routes managed logger output through an error-level status summary", async () => {
    const { handleClientOrgMismatch } = await import("../core/client-reidentify.js");
    const output = {
      blank: vi.fn(),
      line: vi.fn(),
      status: vi.fn(),
    };

    await expect(
      handleClientOrgMismatch(new Error("wrong org") as never, {
        managed: true,
        configDir: tempDir,
        rerunCommand: "ignored",
        output,
      }),
    ).rejects.toMatchObject({ code: 1 });

    expect(output.status).toHaveBeenCalledWith("✗", expect.stringContaining("wrong org"));
    expect(output.status).toHaveBeenCalledWith("✗", expect.stringContaining("first-tree-dev login <code>"));
    expect(output.status).toHaveBeenCalledWith("✗", expect.stringContaining("first-tree-dev computer reset"));
    expect(output.blank).not.toHaveBeenCalled();
    expect(output.line).not.toHaveBeenCalled();
    expect(printMocks.blank).not.toHaveBeenCalled();
    expect(printMocks.line).not.toHaveBeenCalled();
  });
});
