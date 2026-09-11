import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ClientConfig } from "@first-tree/shared/config";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cliFetchMock = vi.hoisted(() => vi.fn());
const getClientServiceStatusMock = vi.hoisted(() => vi.fn());
const installClientServiceMock = vi.hoisted(() => vi.fn());
const isServiceSupportedMock = vi.hoisted(() => vi.fn());
const restartClientServiceMock = vi.hoisted(() => vi.fn());
const stopClientServiceMock = vi.hoisted(() => vi.fn());
const clientRuntimeMock = vi.hoisted(() => vi.fn());
const createApiNameResolverMock = vi.hoisted(() => vi.fn());
const createExecuteUpdateMock = vi.hoisted(() => vi.fn());
const ensureFreshAccessTokenMock = vi.hoisted(() => vi.fn());
const handleClientOrgMismatchMock = vi.hoisted(() => vi.fn());
const migrateLocalAgentDirsMock = vi.hoisted(() => vi.fn());
const promptUpdateMock = vi.hoisted(() => vi.fn());
const switchLocalClientForLoginMock = vi.hoisted(() => vi.fn());
const stderrMock = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
  throw new Error("process.exit");
}) as never);

vi.mock("../core/cli-fetch.js", () => ({
  cliFetch: cliFetchMock,
}));

vi.mock("../core/service-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/service-install.js")>()),
  getClientServiceStatus: getClientServiceStatusMock,
  installClientService: installClientServiceMock,
  isServiceSupported: isServiceSupportedMock,
  restartClientService: restartClientServiceMock,
  stopClientService: stopClientServiceMock,
}));

vi.mock("../core/client-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/client-runtime.js")>()),
  ClientRuntime: clientRuntimeMock,
}));

vi.mock("../core/migrate-agent-dirs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/migrate-agent-dirs.js")>()),
  createApiNameResolver: createApiNameResolverMock,
  migrateLocalAgentDirs: migrateLocalAgentDirsMock,
}));

vi.mock("../core/bootstrap.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/bootstrap.js")>()),
  ensureFreshAccessToken: ensureFreshAccessTokenMock,
}));

vi.mock("../core/client-reidentify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/client-reidentify.js")>()),
  handleClientOrgMismatch: handleClientOrgMismatchMock,
}));

vi.mock("../core/client-switch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/client-switch.js")>();
  return {
    ...actual,
    switchLocalClientForLogin: (...args: Parameters<typeof actual.switchLocalClientForLogin>) => {
      if (switchLocalClientForLoginMock.getMockImplementation()) {
        return switchLocalClientForLoginMock(...args);
      }
      return actual.switchLocalClientForLogin(...args);
    },
  };
});

vi.mock("../core/update-glue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/update-glue.js")>()),
  createExecuteUpdate: createExecuteUpdateMock,
  promptUpdate: promptUpdateMock,
}));

const originalFirstTreeHome = process.env.FIRST_TREE_HOME;
const originalServerUrl = process.env.FIRST_TREE_SERVER_URL;
const originalClientId = process.env.FIRST_TREE_CLIENT_ID;

let home: string;
let runtimeInstance: {
  addAgent: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  unwatchAgentsDir: ReturnType<typeof vi.fn>;
  watchAgentsDir: ReturnType<typeof vi.fn>;
};

function jwt(payload: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function runLogin(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  const { registerLoginCommand } = await import("../commands/login.js");
  registerLoginCommand(program);
  await program.parseAsync(args, { from: "user" });
}

async function waitForAsyncWork(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function credentialsPath(): string {
  return join(home, "config", "credentials.json");
}

function moveIfExists(source: string, target: string): void {
  if (!existsSync(source)) return;
  mkdirSync(dirname(target), { recursive: true });
  rmSync(target, { recursive: true, force: true });
  renameSync(source, target);
}

function readClientIdFromYaml(path: string): string {
  const match = readFileSync(path, "utf8").match(/\bid:\s*(client_[a-f0-9]{8})\b/);
  if (!match) throw new Error(`missing client id in ${path}`);
  return match[1];
}

async function simulateSuccessfulLocalClientSwitch(opts: {
  existingCredentials?: { serverUrl: string };
  previousOwnerSub?: string;
  targetTokens: { accessToken: string; refreshToken: string; serverUrl: string };
  targetOwnerSub: string;
}): Promise<ClientConfig> {
  const configDir = join(home, "config");
  const dataDir = join(home, "data");
  const oldClientId = readClientIdFromYaml(join(configDir, "client.yaml"));
  const newClientId = "client_11223344";
  const oldUserId = opts.previousOwnerSub ?? "user-old";
  const oldServerUrl = opts.existingCredentials?.serverUrl ?? "http://first-tree.test";
  const parkedRoot = join(home, "parked-clients", oldClientId);

  moveIfExists(join(configDir, "client.yaml"), join(parkedRoot, "config", "client.yaml"));
  moveIfExists(join(configDir, "agents"), join(parkedRoot, "config", "agents"));
  moveIfExists(join(dataDir, "sessions"), join(parkedRoot, "data", "sessions"));
  moveIfExists(join(dataDir, "workspaces"), join(parkedRoot, "data", "workspaces"));

  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "client.yaml"),
    `server:\n  url: ${opts.targetTokens.serverUrl}\nclient:\n  id: ${newClientId}\n`,
  );
  writeFileSync(credentialsPath(), JSON.stringify(opts.targetTokens));
  mkdirSync(join(home, "parked-clients"), { recursive: true });
  writeFileSync(
    join(home, "parked-clients", "index.json"),
    JSON.stringify({
      version: 1,
      activeClientId: newClientId,
      accountDefaults: {
        [`${oldServerUrl}\n${oldUserId}`]: oldClientId,
        [`${opts.targetTokens.serverUrl}\n${opts.targetOwnerSub}`]: newClientId,
      },
      clients: {
        [oldClientId]: {
          clientId: oldClientId,
          userId: oldUserId,
          serverUrl: oldServerUrl,
          storage: "parked",
          parkedPath: parkedRoot,
          updatedAt: new Date().toISOString(),
        },
        [newClientId]: {
          clientId: newClientId,
          userId: opts.targetOwnerSub,
          serverUrl: opts.targetTokens.serverUrl,
          storage: "active-root",
          updatedAt: new Date().toISOString(),
        },
      },
    }),
  );

  return {
    server: { url: opts.targetTokens.serverUrl },
    client: { id: newClientId },
    update: {
      policy: "prompt",
      restart_quiet_seconds: 30,
      restart_check_interval_seconds: 10,
      prompt_timeout_seconds: 60,
    },
    context_tree: { repository: undefined },
    logLevel: "info",
  };
}

function writeCredentials(memberId: string, serverUrl = "http://old.test", sub = "user-old"): void {
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(
    credentialsPath(),
    JSON.stringify({
      accessToken: jwt({ sub, memberId, exp: Math.floor(Date.now() / 1000) + 3600 }),
      refreshToken: "old-refresh",
      serverUrl,
    }),
  );
}

function writeActiveOwnerMetadata(opts: { clientId?: string; serverUrl?: string; userId?: string } = {}): void {
  const clientId = opts.clientId ?? "client_aabbccdd";
  const serverUrl = opts.serverUrl ?? "http://first-tree.test";
  const userId = opts.userId ?? "user-new";
  mkdirSync(join(home, "parked-clients"), { recursive: true });
  writeFileSync(
    join(home, "parked-clients", "index.json"),
    JSON.stringify({
      version: 1,
      activeClientId: clientId,
      accountDefaults: { [`${serverUrl}\n${userId}`]: clientId },
      clients: {
        [clientId]: {
          clientId,
          userId,
          serverUrl,
          storage: "active-root",
          updatedAt: new Date().toISOString(),
        },
      },
    }),
  );
}

function switchJournalMoves(toClientId?: string): Array<Record<string, unknown>> {
  const oldClientId = "client_aabbccdd";
  const parkedOld = join(home, "parked-clients", oldClientId);
  const moves: Array<Record<string, unknown>> = [
    {
      kind: "park-client-yaml",
      group: "park",
      source: join(home, "config", "client.yaml"),
      target: join(parkedOld, "config", "client.yaml"),
      required: true,
      state: "pending",
    },
    {
      kind: "park-agents",
      group: "park",
      source: join(home, "config", "agents"),
      target: join(parkedOld, "config", "agents"),
      required: false,
      state: "pending",
    },
    {
      kind: "park-sessions",
      group: "park",
      source: join(home, "data", "sessions"),
      target: join(parkedOld, "data", "sessions"),
      required: false,
      state: "pending",
    },
    {
      kind: "park-workspaces",
      group: "park",
      source: join(home, "data", "workspaces"),
      target: join(parkedOld, "data", "workspaces"),
      required: false,
      state: "pending",
    },
  ];
  if (!toClientId) {
    moves.push({
      kind: "restore-client-yaml",
      group: "restore",
      source: join(home, "parked-clients", "__new-client__", "config", "client.yaml"),
      target: join(home, "config", "client.yaml"),
      required: true,
      state: "create",
    });
    return moves;
  }
  const parkedTarget = join(home, "parked-clients", toClientId);
  moves.push(
    {
      kind: "restore-client-yaml",
      group: "restore",
      source: join(parkedTarget, "config", "client.yaml"),
      target: join(home, "config", "client.yaml"),
      required: true,
      state: "pending",
    },
    {
      kind: "restore-agents",
      group: "restore",
      source: join(parkedTarget, "config", "agents"),
      target: join(home, "config", "agents"),
      required: false,
      state: "pending",
    },
    {
      kind: "restore-sessions",
      group: "restore",
      source: join(parkedTarget, "data", "sessions"),
      target: join(home, "data", "sessions"),
      required: false,
      state: "pending",
    },
    {
      kind: "restore-workspaces",
      group: "restore",
      source: join(parkedTarget, "data", "workspaces"),
      target: join(home, "data", "workspaces"),
      required: false,
      state: "pending",
    },
  );
  return moves;
}

function writePendingSwitchJournal(opts: { toClientId?: string } = {}): void {
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "state", "client-switch.lock"), JSON.stringify({ pid: 123, createdAt: "now" }));
  writeFileSync(
    join(home, "state", "client-switch-journal.json"),
    JSON.stringify({
      version: 1,
      id: "switch-test",
      phase: "drain-clean",
      from: { clientId: "client_aabbccdd", userId: "user-old", serverUrl: "http://first-tree.test" },
      to: { clientId: opts.toClientId, userId: "user-new", serverUrl: "http://first-tree.test" },
      moves: switchJournalMoves(opts.toClientId),
      createdAt: "now",
      updatedAt: "now",
    }),
  );
}

beforeEach(() => {
  vi.resetModules();
  home = join(tmpdir(), `ft-login-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(home, "config"), { recursive: true });
  process.env.FIRST_TREE_HOME = home;
  delete process.env.FIRST_TREE_SERVER_URL;
  delete process.env.FIRST_TREE_CLIENT_ID;
  cliFetchMock.mockReset();
  getClientServiceStatusMock.mockReset();
  installClientServiceMock.mockReset();
  isServiceSupportedMock.mockReset();
  restartClientServiceMock.mockReset();
  stopClientServiceMock.mockReset();
  clientRuntimeMock.mockReset();
  createApiNameResolverMock.mockReset();
  createExecuteUpdateMock.mockReset();
  ensureFreshAccessTokenMock.mockReset();
  handleClientOrgMismatchMock.mockReset();
  migrateLocalAgentDirsMock.mockReset();
  promptUpdateMock.mockReset();
  switchLocalClientForLoginMock.mockReset();
  stderrMock.mockClear();
  exitMock.mockClear();
  exitMock.mockImplementation((() => {
    throw new Error("process.exit");
  }) as never);
  process.exitCode = undefined;
  cliFetchMock.mockImplementation(async () =>
    response(200, { accessToken: jwt({ sub: "user-new" }), refreshToken: "r1" }),
  );
  getClientServiceStatusMock.mockReturnValue({
    platform: "launchd",
    state: "not-installed",
    label: "dev.first-tree",
    logDir: join(home, "logs"),
  });
  isServiceSupportedMock.mockReturnValue(false);
  restartClientServiceMock.mockReturnValue({ ok: true });
  stopClientServiceMock.mockReturnValue({ ok: true });
  createApiNameResolverMock.mockReturnValue({ resolveName: vi.fn(async () => "nova") });
  createExecuteUpdateMock.mockReturnValue(async () => undefined);
  ensureFreshAccessTokenMock.mockResolvedValue("access-token");
  migrateLocalAgentDirsMock.mockResolvedValue({ scanned: 0, renamed: 0, skipped: 0, errors: 0 });
  runtimeInstance = {
    addAgent: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    unwatchAgentsDir: vi.fn(),
    watchAgentsDir: vi.fn(() => {
      throw new Error("stop after watch");
    }),
  };
  clientRuntimeMock.mockImplementation(() => runtimeInstance);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalFirstTreeHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalFirstTreeHome;
  if (originalServerUrl === undefined) delete process.env.FIRST_TREE_SERVER_URL;
  else process.env.FIRST_TREE_SERVER_URL = originalServerUrl;
  if (originalClientId === undefined) delete process.env.FIRST_TREE_CLIENT_ID;
  else process.env.FIRST_TREE_CLIENT_ID = originalClientId;
  process.exitCode = undefined;
  // Drop mock call history so the large command-graph suite cannot retain
  // multi-MB argument snapshots across the 29 login cases in one worker.
  vi.clearAllMocks();
});

// `runLogin` dynamic-imports `commands/login.js` on every test run, which
// pulls in the credentials / config / runtime module graph fresh each time.
// On hot caches that resolves in ~500 ms; on cold CI runners under the full
// monorepo test fan-out it can be much slower than Vitest's default
// `testTimeout`. The tests do not drive long-running work themselves, so give
// this import-heavy command suite CI headroom without affecting hot-run latency.
describe("login command", { timeout: 60_000 }, () => {
  it("exchanges a connect token, writes credentials/config, and honors --no-start", async () => {
    await runLogin(["login", jwt({ iss: "http://first-tree.test/" }), "--no-start"]);

    expect(cliFetchMock).toHaveBeenCalledWith(
      "http://first-tree.test/api/v1/auth/connect-token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(readFileSync(credentialsPath(), "utf8"))).toMatchObject({
      refreshToken: "r1",
      serverUrl: "http://first-tree.test",
    });
    expect(readFileSync(join(home, "config", "client.yaml"), "utf8")).toContain("url: http://first-tree.test");
    expect(installClientServiceMock).not.toHaveBeenCalled();
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain("--no-start");
  });

  it("persists an env-provided client id during --no-start login", async () => {
    process.env.FIRST_TREE_CLIENT_ID = "client_c0ffee00";

    await runLogin(["login", jwt({ iss: "http://first-tree.test/" }), "--no-start"]);

    expect(readFileSync(join(home, "config", "client.yaml"), "utf8")).toContain("id: client_c0ffee00");
  });

  it("exchanges a short connect code using the configured server URL", async () => {
    process.env.FIRST_TREE_SERVER_URL = "http://first-tree.test/";
    const token = "short_code-1234567890";
    await runLogin(["login", token, "--no-start"]);

    expect(cliFetchMock).toHaveBeenCalledWith(
      "http://first-tree.test/api/v1/auth/connect-token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token }),
      }),
    );
    expect(JSON.parse(readFileSync(credentialsPath(), "utf8"))).toMatchObject({
      refreshToken: "r1",
      serverUrl: "http://first-tree.test",
    });
  });

  it("tells the coding agent to request a fresh setup prompt for an expired or used code", async () => {
    process.env.FIRST_TREE_SERVER_URL = "http://first-tree.test";
    cliFetchMock.mockResolvedValueOnce(response(401, { error: "Invalid or expired connect token" }));

    await expect(runLogin(["login", "short_code-1234567890", "--no-start"])).rejects.toThrow("process.exit");

    const output = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("expired or has already been used");
    expect(output).toContain("fresh setup prompt from First Tree Settings");
    expect(output).toContain("never reuse this code");
  });

  it("rejects a connect URL instead of accepting it as a short code", async () => {
    const token = "http://first-tree.test/connect/short_code-123";
    await expect(runLogin(["login", token, "--no-start"])).rejects.toThrow("process.exit");

    expect(cliFetchMock).not.toHaveBeenCalled();
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "Connect code must be the short code only",
    );
  });

  it("reports unexpected connect-token URL derivation failures", async () => {
    vi.doMock("../commands/_shared/connect-token.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../commands/_shared/connect-token.js")>();
      return {
        ...actual,
        deriveHubUrlFromToken: vi.fn(() => {
          throw new Error("derive exploded");
        }),
      };
    });

    try {
      await expect(runLogin(["login", jwt({ iss: "http://first-tree.test/" }), "--no-start"])).rejects.toThrow(
        "process.exit",
      );
      expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain("derive exploded");
    } finally {
      vi.doUnmock("../commands/_shared/connect-token.js");
      vi.resetModules();
    }
  });

  it("requires explicit confirmation for cross-account login with a short connect code", async () => {
    process.env.FIRST_TREE_SERVER_URL = "http://first-tree.test";
    const yamlPath = join(home, "config", "client.yaml");
    writeFileSync(yamlPath, "client:\n  id: client_aabbccdd\n");
    writeCredentials("member-old", "http://first-tree.test", "user-old");

    await expect(runLogin(["login", "short_code-1234567890", "--no-start"])).rejects.toThrow("process.exit");

    expect(cliFetchMock).toHaveBeenCalledTimes(1);
    expect(readFileSync(credentialsPath(), "utf8")).toContain("old-refresh");
    expect(readFileSync(yamlPath, "utf8")).toContain("client_aabbccdd");
    expect(installClientServiceMock).not.toHaveBeenCalled();
    const output = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("ACCOUNT_SWITCH_REQUIRES_CONFIRMATION");
    expect(output).toContain("has now been consumed");
    expect(output).toContain("Ask the user to approve switching this computer first");
    expect(output).toContain("fresh setup prompt");
    expect(output).toContain("--force-switch");
  });

  it("parks the old local client when --force-switch confirms a short-code account switch", async () => {
    switchLocalClientForLoginMock.mockImplementation(simulateSuccessfulLocalClientSwitch);
    process.env.FIRST_TREE_SERVER_URL = "http://first-tree.test";
    const yamlPath = join(home, "config", "client.yaml");
    writeFileSync(yamlPath, "server:\n  url: http://first-tree.test\nclient:\n  id: client_aabbccdd\n");
    mkdirSync(join(home, "config", "agents", "nova"), { recursive: true });
    writeFileSync(join(home, "config", "agents", "nova", "agent.yaml"), "agentId: agent-old\nruntime: claude-code\n");
    writeCredentials("member-old", "http://first-tree.test", "user-old");

    await runLogin(["login", "short_code-1234567890", "--no-start", "--force-switch"]);

    const parkedRoot = join(home, "parked-clients", "client_aabbccdd");
    expect(readFileSync(join(parkedRoot, "config", "client.yaml"), "utf8")).toContain("client_aabbccdd");
    expect(readFileSync(join(parkedRoot, "config", "agents", "nova", "agent.yaml"), "utf8")).toContain("agent-old");
    expect(readFileSync(credentialsPath(), "utf8")).toContain("r1");
    expect(readFileSync(credentialsPath(), "utf8")).not.toContain("old-refresh");
    expect(readFileSync(yamlPath, "utf8")).not.toContain("client_aabbccdd");
    expect(readFileSync(yamlPath, "utf8")).toContain("url: http://first-tree.test");
    const output = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Previous local client parked");
  });

  it("requires explicit confirmation for cross-account login before overwriting local credentials", async () => {
    const yamlPath = join(home, "config", "client.yaml");
    writeFileSync(yamlPath, "client:\n  id: client_aabbccdd\n");
    writeCredentials("member-old", "http://first-tree.test", "user-old");

    await expect(runLogin(["login", jwt({ iss: "http://first-tree.test" }), "--no-start"])).rejects.toThrow(
      "process.exit",
    );

    expect(cliFetchMock).toHaveBeenCalledTimes(1);
    expect(readFileSync(credentialsPath(), "utf8")).toContain("old-refresh");
    expect(readFileSync(yamlPath, "utf8")).toContain("client_aabbccdd");
    expect(installClientServiceMock).not.toHaveBeenCalled();
    const output = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("ACCOUNT_SWITCH_REQUIRES_CONFIRMATION");
    expect(output).toContain("--force-switch");
  });

  it("parks the old local client and creates a new active client when --force-switch confirms non-TTY switching", async () => {
    switchLocalClientForLoginMock.mockImplementation(simulateSuccessfulLocalClientSwitch);
    const yamlPath = join(home, "config", "client.yaml");
    writeFileSync(yamlPath, "server:\n  url: http://first-tree.test\nclient:\n  id: client_aabbccdd\n");
    mkdirSync(join(home, "config", "agents", "nova"), { recursive: true });
    writeFileSync(join(home, "config", "agents", "nova", "agent.yaml"), "agentId: agent-old\nruntime: claude-code\n");
    mkdirSync(join(home, "data", "sessions"), { recursive: true });
    writeFileSync(join(home, "data", "sessions", "nova.json"), "{}");
    writeCredentials("member-old", "http://first-tree.test", "user-old");

    await runLogin(["login", jwt({ iss: "http://first-tree.test" }), "--no-start", "--force-switch"]);

    const parkedRoot = join(home, "parked-clients", "client_aabbccdd");
    expect(readFileSync(join(parkedRoot, "config", "client.yaml"), "utf8")).toContain("client_aabbccdd");
    expect(readFileSync(join(parkedRoot, "config", "agents", "nova", "agent.yaml"), "utf8")).toContain("agent-old");
    expect(readFileSync(join(parkedRoot, "data", "sessions", "nova.json"), "utf8")).toBe("{}");
    expect(existsSync(join(parkedRoot, "config", "credentials.json"))).toBe(false);

    expect(readFileSync(credentialsPath(), "utf8")).toContain("r1");
    expect(readFileSync(credentialsPath(), "utf8")).not.toContain("old-refresh");
    expect(readFileSync(yamlPath, "utf8")).not.toContain("client_aabbccdd");
    expect(readFileSync(yamlPath, "utf8")).toContain("url: http://first-tree.test");
    const index = JSON.parse(readFileSync(join(home, "parked-clients", "index.json"), "utf8")) as {
      activeClientId: string;
      clients: Record<string, { storage: string; userId: string }>;
    };
    expect(index.clients.client_aabbccdd).toMatchObject({ storage: "parked", userId: "user-old" });
    expect(index.clients[index.activeClientId]).toMatchObject({ storage: "active-root", userId: "user-new" });
    expect(installClientServiceMock).not.toHaveBeenCalled();
    const output = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Previous local client parked");
  });

  it("clears the switch guard when supervisor stop fails before root state movement", async () => {
    const yamlPath = join(home, "config", "client.yaml");
    writeFileSync(yamlPath, "server:\n  url: http://first-tree.test\nclient:\n  id: client_aabbccdd\n");
    writeCredentials("member-old", "http://first-tree.test", "user-old");
    getClientServiceStatusMock.mockReturnValueOnce({
      platform: "launchd",
      state: "active",
      label: "dev.first-tree",
      logDir: join(home, "logs"),
    });
    stopClientServiceMock.mockReturnValueOnce({ ok: false, reason: "permission denied" });

    await expect(
      runLogin(["login", jwt({ iss: "http://first-tree.test" }), "--no-start", "--force-switch"]),
    ).rejects.toThrow("process.exit");

    expect(readFileSync(credentialsPath(), "utf8")).toContain("old-refresh");
    expect(readFileSync(yamlPath, "utf8")).toContain("client_aabbccdd");
    expect(existsSync(join(home, "state", "client-switch.lock"))).toBe(false);
    expect(existsSync(join(home, "state", "client-switch-journal.json"))).toBe(false);
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain("CLIENT_SWITCH_SUPERVISOR_UNSAFE");
  });

  it("refuses to move root state while a foreground runtime marker is still live", async () => {
    const yamlPath = join(home, "config", "client.yaml");
    writeFileSync(yamlPath, "server:\n  url: http://first-tree.test\nclient:\n  id: client_aabbccdd\n");
    writeCredentials("member-old", "http://first-tree.test", "user-old");
    mkdirSync(join(home, "state", "client-runtimes"), { recursive: true });
    writeFileSync(
      join(home, "state", "client-runtimes", `${process.pid}.json`),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        clientId: "client_aabbccdd",
        home,
        mode: "foreground",
        createdAt: new Date().toISOString(),
      }),
    );

    await expect(
      runLogin(["login", jwt({ iss: "http://first-tree.test" }), "--no-start", "--force-switch"]),
    ).rejects.toThrow("process.exit");

    expect(readFileSync(credentialsPath(), "utf8")).toContain("old-refresh");
    expect(readFileSync(yamlPath, "utf8")).toContain("client_aabbccdd");
    expect(existsSync(join(home, "state", "client-switch.lock"))).toBe(false);
    expect(existsSync(join(home, "state", "client-switch-journal.json"))).toBe(false);
    const output = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("CLIENT_SWITCH_RUNTIME_ACTIVE");
    expect(output).toContain("runtime processes are still running");
  });

  it("allows same-user reauth without rotating the client identity", async () => {
    const yamlPath = join(home, "config", "client.yaml");
    writeFileSync(yamlPath, "client:\n  id: client_aabbccdd\n");
    writeCredentials("member-new", "http://first-tree.test", "user-new");

    await runLogin(["login", jwt({ iss: "http://first-tree.test" }), "--no-start"]);

    expect(readFileSync(yamlPath, "utf8")).toContain("client_aabbccdd");
    expect(existsSync(join(home, "config", "client.yaml.bak"))).toBe(false);
    const output = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Authenticated");
    expect(output).not.toContain("ACCOUNT_SWITCH_REQUIRES_PURGE");
  });

  it("refuses reused local client identity when the server reports it retired", async () => {
    const yamlPath = join(home, "config", "client.yaml");
    writeFileSync(yamlPath, "server:\n  url: http://first-tree.test\nclient:\n  id: client_aabbccdd\n");
    writeCredentials("member-new", "http://first-tree.test", "user-new");
    isServiceSupportedMock.mockReturnValue(true);
    cliFetchMock
      .mockResolvedValueOnce(response(200, { accessToken: jwt({ sub: "user-new" }), refreshToken: "r1" }))
      .mockResolvedValueOnce(response(200, { id: "client_aabbccdd", status: "retired" }));

    await expect(runLogin(["login", jwt({ iss: "http://first-tree.test" })])).rejects.toThrow("process.exit");

    expect(cliFetchMock).toHaveBeenNthCalledWith(
      2,
      "http://first-tree.test/api/v1/clients/client_aabbccdd",
      expect.objectContaining({ method: "GET" }),
    );
    expect(installClientServiceMock).not.toHaveBeenCalled();
    const output = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("CLIENT_RETIRED_REQUIRES_RESET");
    expect(output).toContain("first-tree-dev computer reset");
  });

  it("allows reconnect with preserved client identity and local agent state when credentials are missing", async () => {
    const yamlPath = join(home, "config", "client.yaml");
    writeFileSync(yamlPath, "client:\n  id: client_aabbccdd\n");
    mkdirSync(join(home, "config", "agents", "nova"), { recursive: true });
    writeFileSync(join(home, "config", "agents", "nova", "agent.yaml"), "agentId: agent-1\nruntime: claude-code\n");
    writeActiveOwnerMetadata();

    await runLogin(["login", jwt({ iss: "http://first-tree.test" }), "--no-start"]);

    expect(cliFetchMock).toHaveBeenCalledTimes(2);
    expect(readFileSync(yamlPath, "utf8")).toContain("client_aabbccdd");
    const output = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Authenticated");
    expect(output).not.toContain("ACCOUNT_SWITCH_REQUIRES_PURGE");
  });

  it("switches local clients when credentials are missing but remembered owner differs", async () => {
    switchLocalClientForLoginMock.mockImplementation(simulateSuccessfulLocalClientSwitch);
    const yamlPath = join(home, "config", "client.yaml");
    writeFileSync(yamlPath, "server:\n  url: http://first-tree.test\nclient:\n  id: client_aabbccdd\n");
    mkdirSync(join(home, "config", "agents", "nova"), { recursive: true });
    writeFileSync(join(home, "config", "agents", "nova", "agent.yaml"), "agentId: agent-old\nruntime: claude-code\n");
    writeActiveOwnerMetadata({ userId: "user-old" });

    await runLogin(["login", jwt({ iss: "http://first-tree.test" }), "--no-start", "--force-switch"]);

    const parkedRoot = join(home, "parked-clients", "client_aabbccdd");
    expect(readFileSync(join(parkedRoot, "config", "client.yaml"), "utf8")).toContain("client_aabbccdd");
    expect(readFileSync(join(parkedRoot, "config", "agents", "nova", "agent.yaml"), "utf8")).toContain("agent-old");
    expect(readFileSync(credentialsPath(), "utf8")).toContain("r1");
    expect(readFileSync(yamlPath, "utf8")).not.toContain("client_aabbccdd");
    const index = JSON.parse(readFileSync(join(home, "parked-clients", "index.json"), "utf8")) as {
      activeClientId: string;
      clients: Record<string, { storage: string; userId: string }>;
    };
    expect(index.clients.client_aabbccdd).toMatchObject({ storage: "parked", userId: "user-old" });
    expect(index.clients[index.activeClientId]).toMatchObject({ storage: "active-root", userId: "user-new" });
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain("Previous local client parked");
  });

  it("switches when credentials match the target user but remembered owner still belongs to the old client", async () => {
    switchLocalClientForLoginMock.mockImplementation(simulateSuccessfulLocalClientSwitch);
    const yamlPath = join(home, "config", "client.yaml");
    writeFileSync(yamlPath, "server:\n  url: http://first-tree.test\nclient:\n  id: client_aabbccdd\n");
    writeCredentials("member-new", "http://first-tree.test", "user-new");
    writeActiveOwnerMetadata({ userId: "user-old" });

    await runLogin(["login", jwt({ iss: "http://first-tree.test" }), "--no-start", "--force-switch"]);

    const parkedRoot = join(home, "parked-clients", "client_aabbccdd");
    expect(readFileSync(join(parkedRoot, "config", "client.yaml"), "utf8")).toContain("client_aabbccdd");
    expect(readFileSync(credentialsPath(), "utf8")).toContain("r1");
    expect(readFileSync(credentialsPath(), "utf8")).not.toContain("old-refresh");
    expect(readFileSync(yamlPath, "utf8")).not.toContain("client_aabbccdd");
    const index = JSON.parse(readFileSync(join(home, "parked-clients", "index.json"), "utf8")) as {
      activeClientId: string;
      clients: Record<string, { storage: string; userId: string }>;
    };
    expect(index.clients.client_aabbccdd).toMatchObject({ storage: "parked", userId: "user-old" });
    expect(index.clients[index.activeClientId]).toMatchObject({ storage: "active-root", userId: "user-new" });
  });

  it("rolls forward an interrupted switch after a partial root-state move", async () => {
    writeCredentials("member-old", "http://first-tree.test", "user-old");
    mkdirSync(join(home, "parked-clients", "client_aabbccdd", "config"), { recursive: true });
    writeFileSync(
      join(home, "parked-clients", "client_aabbccdd", "config", "client.yaml"),
      "server:\n  url: http://first-tree.test\nclient:\n  id: client_aabbccdd\n",
    );
    mkdirSync(join(home, "config", "agents", "nova"), { recursive: true });
    writeFileSync(join(home, "config", "agents", "nova", "agent.yaml"), "agentId: agent-old\nruntime: claude-code\n");
    writePendingSwitchJournal();

    await runLogin(["login", jwt({ iss: "http://first-tree.test" }), "--no-start"]);

    const parkedRoot = join(home, "parked-clients", "client_aabbccdd");
    expect(readFileSync(join(parkedRoot, "config", "client.yaml"), "utf8")).toContain("client_aabbccdd");
    expect(readFileSync(join(parkedRoot, "config", "agents", "nova", "agent.yaml"), "utf8")).toContain("agent-old");
    expect(readFileSync(credentialsPath(), "utf8")).toContain("r1");
    expect(readFileSync(join(home, "config", "client.yaml"), "utf8")).not.toContain("client_aabbccdd");
    expect(existsSync(join(home, "state", "client-switch.lock"))).toBe(false);
    expect(existsSync(join(home, "state", "client-switch-journal.json"))).toBe(false);
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "Interrupted local client switch recovered",
    );
  });

  it("keeps the switch guard when journal recovery finds both source and target", async () => {
    const yamlPath = join(home, "config", "client.yaml");
    writeFileSync(yamlPath, "server:\n  url: http://first-tree.test\nclient:\n  id: client_aabbccdd\n");
    writeCredentials("member-old", "http://first-tree.test", "user-old");
    mkdirSync(join(home, "parked-clients", "client_aabbccdd", "config"), { recursive: true });
    writeFileSync(join(home, "parked-clients", "client_aabbccdd", "config", "client.yaml"), "client:\n  id: stale\n");
    writePendingSwitchJournal();

    await expect(runLogin(["login", jwt({ iss: "http://first-tree.test" }), "--no-start"])).rejects.toThrow(
      "process.exit",
    );

    expect(readFileSync(yamlPath, "utf8")).toContain("client_aabbccdd");
    expect(existsSync(join(home, "state", "client-switch.lock"))).toBe(true);
    expect(existsSync(join(home, "state", "client-switch-journal.json"))).toBe(true);
    const output = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("CLIENT_SWITCH_MANUAL_REPAIR_REQUIRED");
    expect(output).toContain("both source and target exist");
  });

  it("fails closed when credentials are missing and active client owner is unknown", async () => {
    const yamlPath = join(home, "config", "client.yaml");
    writeFileSync(yamlPath, "client:\n  id: client_aabbccdd\n");

    await expect(runLogin(["login", jwt({ iss: "http://first-tree.test" }), "--no-start"])).rejects.toThrow(
      "process.exit",
    );

    expect(existsSync(credentialsPath())).toBe(false);
    expect(readFileSync(yamlPath, "utf8")).toContain("client_aabbccdd");
    const output = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("CLIENT_OWNER_UNKNOWN_REQUIRES_RESET_OR_OWNER_LOGIN");
    expect(output).toContain("remembered owner metadata");
  });

  it("maps invalid tokens and token exchange failures to CLI errors", async () => {
    await expect(runLogin(["login", "not-a-jwt"])).rejects.toThrow("process.exit");
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain("INVALID_TOKEN");

    stderrMock.mockClear();
    exitMock.mockClear();
    cliFetchMock.mockResolvedValueOnce(response(403, { error: "expired token" }));
    await expect(runLogin(["login", jwt({ iss: "http://first-tree.test" }), "--no-start"])).rejects.toThrow(
      "process.exit",
    );
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain("expired token");
  });

  it("rejects exchanged access tokens without an owner subject", async () => {
    cliFetchMock.mockResolvedValueOnce(response(200, { accessToken: jwt({}), refreshToken: "r1" }));

    await expect(runLogin(["login", jwt({ iss: "http://first-tree.test" }), "--no-start"])).rejects.toThrow(
      "process.exit",
    );

    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "Server access token is missing the required `sub` claim",
    );
  });

  it("refuses existing credentials whose owner cannot be decoded", async () => {
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      credentialsPath(),
      JSON.stringify({ accessToken: "not-a-jwt", refreshToken: "old-refresh", serverUrl: "http://first-tree.test" }),
    );

    await expect(runLogin(["login", jwt({ iss: "http://first-tree.test" }), "--no-start"])).rejects.toThrow(
      "process.exit",
    );

    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "Existing credentials do not expose an owner user id",
    );
  });

  it("installs the background service when supported", async () => {
    isServiceSupportedMock.mockReturnValue(true);
    installClientServiceMock.mockReturnValue({
      platform: "launchd",
      logDir: join(home, "logs"),
    });

    await runLogin(["login", jwt({ iss: "http://first-tree.test" })]);

    expect(installClientServiceMock).toHaveBeenCalled();
    const output = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Background service installed (launchd)");
    expect(output).toContain(join(home, "logs"));
    expect(clientRuntimeMock).not.toHaveBeenCalled();
  });

  it("restarts an already-active background service after login refreshes it", async () => {
    isServiceSupportedMock.mockReturnValue(true);
    getClientServiceStatusMock.mockReturnValue({
      platform: "task-scheduler",
      state: "active",
      label: "\\FirstTree\\first-tree-dev",
      logDir: join(home, "logs"),
    });
    installClientServiceMock.mockReturnValue({
      platform: "task-scheduler",
      logDir: join(home, "logs"),
    });
    restartClientServiceMock.mockReturnValue({ ok: true });

    await runLogin(["login", jwt({ iss: "http://first-tree.test" })]);

    expect(installClientServiceMock).toHaveBeenCalled();
    expect(restartClientServiceMock).toHaveBeenCalled();
    expect(clientRuntimeMock).not.toHaveBeenCalled();
  });

  it("fails login when an already-active background service cannot restart after refresh", async () => {
    isServiceSupportedMock.mockReturnValue(true);
    getClientServiceStatusMock.mockReturnValue({
      platform: "task-scheduler",
      state: "active",
      label: "\\FirstTree\\first-tree-dev",
      logDir: join(home, "logs"),
    });
    installClientServiceMock.mockReturnValue({
      platform: "task-scheduler",
      logDir: join(home, "logs"),
    });
    restartClientServiceMock.mockReturnValue({ ok: false, reason: "still running" });

    await expect(runLogin(["login", jwt({ iss: "http://first-tree.test" })])).rejects.toThrow("process.exit");

    const output = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Background service refreshed but restart failed: still running");
    expect(output).toContain("first-tree-dev daemon restart");
  });

  it("prints cancellation when inline runtime start is interrupted by the prompt layer", async () => {
    runtimeInstance.start.mockRejectedValueOnce(Object.assign(new Error("cancel"), { name: "ExitPromptError" }));

    await runLogin(["login", jwt({ iss: "http://hub.test" })]);

    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain("Cancelled.");
    expect(exitMock).not.toHaveBeenCalled();
  });

  it("falls back to inline runtime when service install is unsupported", async () => {
    writeCredentials("member-new", "http://hub.test", "user-new");
    mkdirSync(join(home, "config", "agents", "nova"), { recursive: true });
    writeFileSync(join(home, "config", "agents", "nova", "agent.yaml"), "agentId: agent-1\nruntime: claude-code\n");

    await expect(runLogin(["login", jwt({ iss: "http://hub.test" })])).rejects.toThrow("process.exit");

    expect(migrateLocalAgentDirsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentsDir: join(home, "config", "agents"),
        sessionsDir: join(home, "data", "sessions"),
        workspacesDir: join(home, "data", "workspaces"),
      }),
    );
    expect(clientRuntimeMock).toHaveBeenCalledWith(
      "http://hub.test",
      expect.any(String),
      expect.objectContaining({
        update: expect.objectContaining({
          executeUpdate: expect.any(Function),
          prompt: promptUpdateMock,
        }),
      }),
    );
    expect(runtimeInstance.addAgent).toHaveBeenCalledWith("nova", expect.objectContaining({ agentId: "agent-1" }));
    expect(runtimeInstance.start).toHaveBeenCalled();
    expect(runtimeInstance.watchAgentsDir).toHaveBeenCalledWith(join(home, "config", "agents"));
    const text = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(text).toContain("Background service not supported");
    expect(text).toContain("Error: stop after watch");
  });

  it("stops the inline runtime cleanly when the login fallback receives SIGTERM", async () => {
    const signalHandlers = new Map<string, () => void>();
    const onSpy = vi.spyOn(process, "on").mockImplementation((event, listener) => {
      if (event === "SIGINT" || event === "SIGTERM") {
        signalHandlers.set(event, listener as () => void);
      }
      return process;
    });
    exitMock.mockImplementation((() => undefined) as never);
    runtimeInstance.watchAgentsDir.mockImplementation(() => undefined);

    try {
      void runLogin(["login", jwt({ iss: "http://hub.test" })]).catch(() => undefined);
      await waitForAsyncWork(() => signalHandlers.has("SIGTERM"));

      const shutdown = signalHandlers.get("SIGTERM");
      expect(shutdown).toBeTypeOf("function");
      shutdown?.();
      await waitForAsyncWork(() => runtimeInstance.stop.mock.calls.length > 0);

      expect(runtimeInstance.unwatchAgentsDir).toHaveBeenCalled();
      expect(runtimeInstance.stop).toHaveBeenCalledWith(undefined);
      expect(exitMock).toHaveBeenCalledWith(0);
    } finally {
      onSpy.mockRestore();
    }
  });

  it("continues inline fallback when migration fails and handles prompt/org errors", async () => {
    mkdirSync(join(home, "config", "agents"), { recursive: true });
    migrateLocalAgentDirsMock.mockRejectedValueOnce(new Error("offline"));

    await expect(runLogin(["login", jwt({ iss: "http://hub.test" })])).rejects.toThrow("process.exit");
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "agent-dir migration skipped: offline",
    );

    stderrMock.mockClear();
    exitMock.mockClear();
    const client = await import("@first-tree/client");
    runtimeInstance.start.mockRejectedValueOnce(new client.ClientOrgMismatchError("wrong org"));
    await expect(runLogin(["login", jwt({ iss: "http://hub.test" })])).rejects.toThrow("process.exit");
    expect(handleClientOrgMismatchMock).toHaveBeenCalledWith(
      expect.any(client.ClientOrgMismatchError),
      expect.objectContaining({ managed: false, rerunCommand: "first-tree-dev login <code>" }),
    );

    stderrMock.mockClear();
    exitMock.mockClear();
    writeCredentials("member-old");
    await expect(runLogin(["login", jwt({ iss: "http://hub.test" })])).rejects.toThrow("process.exit");
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "ACCOUNT_SWITCH_REQUIRES_CONFIRMATION",
    );
  });
});
