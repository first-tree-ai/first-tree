import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProviderRetryEventMessage, type SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCtxPlumbing } from "../../../../__tests__/test-helpers.js";
import { writeAgentBriefing } from "../../../../runtime/bootstrap.js";
import { setCliBinding } from "../../../../runtime/cli-binding.js";
import type { DeliveryToken, SessionContext, SessionMessage } from "../../../../runtime/handler.js";
import { deliveryTokenFromSessionContext } from "../../../../runtime/handler.js";
import { CodexAppServerRpcError, CodexAppServerTransportError } from "../../app-server/client.js";
import { createCodexAppServerHandler } from "../../app-server/index.js";
import { LANDING_TRIAL_TURN_COMPLETION_CONFIRM_FAILED } from "../../turn-completion.js";

vi.mock("../../../../runtime/agent-briefing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../runtime/agent-briefing.js")>();
  return {
    ...actual,
    buildAgentBriefing: vi.fn((options: Parameters<typeof actual.buildAgentBriefing>[0]) =>
      actual.buildAgentBriefing(options),
    ),
  };
});

vi.mock("../../../../runtime/bootstrap.js", () => ({
  FIRST_TREE_RUNTIME_DIR: ".first-tree-workspace",
  FIRST_TREE_WORKSPACE_MARKER: ".first-tree-workspace",
  IDENTITY_JSON_REL: join(".first-tree-workspace", "identity.json"),
  bootstrapWorkspace: vi.fn(
    (options: {
      workspacePath: string;
      identity: SessionContext["agent"];
      agentName: string;
      contextTreePath: string | null;
      contextSourceKind?: "remote" | "local" | "none";
      serverUrl: string;
    }) => {
      const runtimeDir = join(options.workspacePath, ".first-tree-workspace");
      mkdirSync(runtimeDir, { recursive: true });
      writeFileSync(
        join(runtimeDir, "identity.json"),
        JSON.stringify({
          agentId: options.identity.agentId,
          agentName: options.agentName,
          displayName: options.identity.displayName,
          type: options.identity.type,
          visibility: options.identity.visibility,
          delegateMention: options.identity.delegateMention,
          metadata: options.identity.metadata,
          serverUrl: options.serverUrl,
          contextTreePath: options.contextTreePath,
          contextSourceKind: options.contextSourceKind ?? "none",
        }),
      );
      for (const name of ["first-tree-read", "first-tree-write"]) {
        const skillDir = join(options.workspacePath, ".agents", "skills", name);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(skillDir, "SKILL.md"), `# ${name}\n`);
        writeFileSync(join(skillDir, ".first-tree-managed.json"), JSON.stringify({ revision: "test-public:1" }));
      }
    },
  ),
  deepEqualIdentity: vi.fn(() => true),
  ensureWorkspaceRuntimeDir: vi.fn((workspacePath: string) => {
    const dir = join(workspacePath, ".first-tree-workspace");
    mkdirSync(dir, { recursive: true });
    return dir;
  }),
  installCoreSkills: vi.fn(),
  installFirstTreeIntegration: vi.fn(() => true),
  isHubWorktreeMarker: vi.fn(() => false),
  readCachedBundledCliVersion: vi.fn(() => null),
  readCachedContextTreeHead: vi.fn(() => null),
  readContextTreeHead: vi.fn(() => null),
  resolveBundledCliVersion: vi.fn(() => "0.0.0-test"),
  writeAgentBriefing: vi.fn((workspacePath: string, content: string) => {
    writeFileSync(join(workspacePath, "AGENTS.md"), content);
    const claudePath = join(workspacePath, "CLAUDE.md");
    rmSync(claudePath, { force: true });
    if (process.platform === "win32") writeFileSync(claudePath, content);
    else symlinkSync("AGENTS.md", claudePath);
  }),
  writeBundledCliVersion: vi.fn(),
  writeContextTreeHead: vi.fn(),
}));

vi.mock("../../../../runtime/chat-context.js", () => ({
  fetchChatContext: vi.fn(async () => ({
    chatId: "chat-app-server",
    title: "app server",
    topic: null,
    description: null,
    participants: [],
  })),
}));

const AGENT_ID = "019e71c9-88d2-70be-be67-fdb033b2ef0b";

type FakeRequest = {
  method: string;
  params: unknown;
};

type TestTokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

type NotificationHandler = (notification: { method: string; params?: unknown }) => void;
type CloseHandler = (error: CodexAppServerTransportError) => void;

class FakeAppServerClient {
  readonly requests: FakeRequest[] = [];
  stderr = "";
  isClosed = false;
  onNotification: NotificationHandler | null = null;
  onClose: CloseHandler | null = null;
  steerError: Error | null = null;
  threadResumeError: Error | null = null;
  turnStartError: Error | null = null;
  beforeTurnStartError: (() => void) | null = null;
  beforeTurnStartReturn: (() => void) | null = null;
  beforeThreadResumeReturn: (() => void) | null = null;
  threadStartDeferred: { promise: Promise<unknown>; resolve: (value: unknown) => void } | null = null;
  steerDeferred: {
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  } | null = null;
  turnCounter = 0;
  tokenUsageTotal = emptyTestTokenUsage();

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "thread/start") {
      if (this.threadStartDeferred) return this.threadStartDeferred.promise;
      const config = (params as { config?: { service_tier?: unknown } } | undefined)?.config;
      const requestedServiceTier = config?.service_tier;
      return {
        thread: { id: "thread-app-server" },
        ...(typeof requestedServiceTier === "string"
          ? { serviceTier: requestedServiceTier === "fast" ? "priority" : requestedServiceTier }
          : {}),
      };
    }
    if (method === "thread/resume") {
      this.beforeThreadResumeReturn?.();
      if (this.threadResumeError) throw this.threadResumeError;
      const config = (params as { config?: { service_tier?: unknown } } | undefined)?.config;
      const requestedServiceTier = config?.service_tier;
      return {
        thread: { id: "thread-app-server" },
        ...(typeof requestedServiceTier === "string"
          ? { serviceTier: requestedServiceTier === "fast" ? "priority" : requestedServiceTier }
          : {}),
      };
    }
    if (method === "turn/start") {
      if (this.turnStartError) {
        this.beforeTurnStartError?.();
        throw this.turnStartError;
      }
      this.beforeTurnStartReturn?.();
      this.turnCounter += 1;
      return {
        turn: {
          id: `turn-${this.turnCounter}`,
          status: "inProgress",
          items: [],
          error: null,
        },
      };
    }
    if (method === "turn/steer") {
      if (this.steerDeferred) return this.steerDeferred.promise;
      if (this.steerError) throw this.steerError;
      return { turnId: "turn-1" };
    }
    if (method === "turn/interrupt") {
      return {};
    }
    return {};
  }

  notify(): void {}

  shutdown(): void {
    this.isClosed = true;
  }

  deferThreadStart(): void {
    let resolve: (value: unknown) => void = () => {};
    const promise = new Promise<unknown>((r) => {
      resolve = r;
    });
    this.threadStartDeferred = { promise, resolve };
  }

  resolveThreadStart(): void {
    this.threadStartDeferred?.resolve({ thread: { id: "thread-app-server" } });
    this.threadStartDeferred = null;
  }

  deferNextSteer(): void {
    let resolve: (value: unknown) => void = () => {};
    let reject: (error: Error) => void = () => {};
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.steerDeferred = { promise, resolve, reject };
  }

  resolveSteer(value: unknown = { turnId: "turn-1" }): void {
    this.steerDeferred?.resolve(value);
    this.steerDeferred = null;
  }

  rejectSteer(error: Error): void {
    this.steerDeferred?.reject(error);
    this.steerDeferred = null;
  }

  emit(method: string, params?: unknown): void {
    this.onNotification?.({ method, params });
  }

  close(message = "app-server died"): void {
    this.onClose?.(new CodexAppServerTransportError(message));
  }
}

let workspaceRoot: string;

const trialAgentMetadata = {
  landingCampaignTrial: true,
  campaign: "production-scan",
  skillSetId: "production-scan",
  skillSetVersion: "2026.07.02.1",
  repo: {
    url: "https://github.com/acme/backend",
    canonicalKey: "github.com/acme/backend",
  },
};

function makeMessage(id: string, content: string, inboxEntryId?: number): SessionMessage {
  return {
    ...(inboxEntryId !== undefined ? { inboxEntryId } : {}),
    id,
    chatId: "chat-app-server",
    senderId: "sender-1",
    format: "text",
    content,
    metadata: {},
  };
}

function messageIds(messages: SessionMessage | readonly SessionMessage[]): string[] {
  return (Array.isArray(messages) ? messages : [messages]).map((message) => message.id);
}

function makeContext(
  opts: {
    finishTurn?: SessionContext["finishTurn"];
    retryTurn?: SessionContext["retryTurn"];
    failSessionForRecovery?: SessionContext["failSessionForRecovery"];
    replaceSessionId?: SessionContext["replaceSessionId"];
    emitEvent?: SessionContext["emitEvent"];
    emitEventConfirmed?: SessionContext["emitEventConfirmed"];
    formatInboundContent?: SessionContext["formatInboundContent"];
    sendMessage?: ReturnType<typeof vi.fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>>;
    createAgentOutboxToken?: ReturnType<
      typeof vi.fn<(chatId: string) => Promise<{ accessToken: string; expiresIn: number }>>
    >;
    agentMetadata?: Record<string, unknown>;
    getAgentContextTreeConfig?: () => Promise<unknown>;
  } = {},
): SessionContext {
  const sendMessage =
    opts.sendMessage ??
    vi.fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>().mockResolvedValue(undefined);
  const createAgentOutboxToken =
    opts.createAgentOutboxToken ??
    vi.fn<(chatId: string) => Promise<{ accessToken: string; expiresIn: number }>>().mockResolvedValue({
      accessToken: "scoped-outbox-token",
      expiresIn: 900,
    });
  return {
    agent: {
      agentId: AGENT_ID,
      inboxId: `inbox_${AGENT_ID}`,
      displayName: "codex-assistant",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: opts.agentMetadata ?? {},
    },
    sdk: {
      serverUrl: "http://test",
      sendMessage,
      createAgentOutboxToken,
      ...(opts.getAgentContextTreeConfig ? { getAgentContextTreeConfig: opts.getAgentContextTreeConfig } : {}),
    } as unknown as SessionContext["sdk"],
    chatId: "chat-app-server",
    log: () => {},
    recordProviderActivity: () => {},
    noteTurnStart: () => {},
    emitEvent: opts.emitEvent ?? (() => {}),
    ...(opts.emitEventConfirmed ? { emitEventConfirmed: opts.emitEventConfirmed } : {}),
    ...mockCtxPlumbing({ sendMessage }, "chat-app-server"),
    ...(opts.finishTurn ? { finishTurn: opts.finishTurn } : {}),
    ...(opts.retryTurn ? { retryTurn: opts.retryTurn } : {}),
    ...(opts.failSessionForRecovery ? { failSessionForRecovery: opts.failSessionForRecovery } : {}),
    ...(opts.replaceSessionId ? { replaceSessionId: opts.replaceSessionId } : {}),
    ...(opts.formatInboundContent ? { formatInboundContent: opts.formatInboundContent } : {}),
  };
}

function makeHandler(fake: FakeAppServerClient, extraConfig: Record<string, unknown> = {}) {
  return createCodexAppServerHandler({
    runtimeProvider: "codex",
    workspaceRoot,
    agentName: "codex-test-agent",
    codexRuntimeBinaryResolver: async () => ({
      ok: true,
      binary: "/tmp/fake-codex",
      runtimeSource: "path",
      runtimePath: "/tmp/fake-codex",
      version: "0.0.0-test",
    }),
    codexAppServerClientFactory: async (options: { onNotification?: NotificationHandler; onClose?: CloseHandler }) => {
      fake.onNotification = options.onNotification ?? null;
      fake.onClose = options.onClose ?? null;
      return fake;
    },
    ...extraConfig,
  });
}

/**
 * Minimal mutable agent-config cache: `.get()` / `.refresh()` return a codex
 * payload whose prompt body the test can flip mid-session to simulate an admin
 * prompt change. Only the methods the handler actually calls are real.
 */
function makeMutableConfigCache(initialAppend: string, serviceTier = "default") {
  const state = { append: initialAppend, serviceTier, version: 1 };
  const config = () => ({
    agentId: AGENT_ID,
    version: state.version,
    payload: {
      kind: "codex" as const,
      prompt: { append: state.append },
      model: "",
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
      reasoningEffort: "high" as const,
      serviceTier: state.serviceTier,
    },
    updatedAt: "",
    updatedBy: "",
  });
  return {
    cache: {
      get: () => config(),
      refresh: async () => config(),
      maybeRefresh: async () => config(),
      updateUrls: () => {},
      forget: () => {},
    } as unknown as Record<string, unknown>,
    setAppend: (value: string) => {
      state.append = value;
      state.version += 1;
    },
  };
}

function makeDeliveryToken(): DeliveryToken {
  return {
    processingStarted: vi.fn<DeliveryToken["processingStarted"]>(),
    complete: vi.fn<DeliveryToken["complete"]>().mockResolvedValue(undefined),
    retry: vi.fn<DeliveryToken["retry"]>(),
    terminalRejected: vi.fn<DeliveryToken["terminalRejected"]>().mockResolvedValue(undefined),
  };
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (!assertion()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for assertion");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function emptyTestTokenUsage(): TestTokenUsageBreakdown {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function addTestTokenUsage(left: TestTokenUsageBreakdown, right: TestTokenUsageBreakdown): TestTokenUsageBreakdown {
  return {
    totalTokens: left.totalTokens + right.totalTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
  };
}

function emitTokenUsage(
  fake: FakeAppServerClient,
  turnId: string,
  last: TestTokenUsageBreakdown,
  total: TestTokenUsageBreakdown = addTestTokenUsage(fake.tokenUsageTotal, last),
): void {
  fake.tokenUsageTotal = { ...total };
  fake.emit("thread/tokenUsage/updated", {
    threadId: "thread-app-server",
    turnId,
    tokenUsage: {
      last,
      total,
      modelContextWindow: null,
    },
  });
}

function findTokenUsageEvent(
  emitEvent: ReturnType<typeof vi.fn<(event: SessionEvent) => void>>,
): Extract<SessionEvent, { kind: "token_usage" }> | undefined {
  return tokenUsageEvents(emitEvent)[0];
}

function tokenUsageEvents(
  emitEvent: ReturnType<typeof vi.fn<(event: SessionEvent) => void>>,
): Extract<SessionEvent, { kind: "token_usage" }>[] {
  return emitEvent.mock.calls
    .map(([event]) => event)
    .filter((event): event is Extract<SessionEvent, { kind: "token_usage" }> => event.kind === "token_usage");
}

function completeTurn(fake: FakeAppServerClient, turnId: string, text: string): void {
  emitTokenUsage(fake, turnId, {
    totalTokens: 3,
    inputTokens: 2,
    cachedInputTokens: 0,
    outputTokens: 1,
    reasoningOutputTokens: 0,
  });
  fake.emit("item/completed", {
    threadId: "thread-app-server",
    turnId,
    item: { type: "agentMessage", id: `item-${turnId}`, text, phase: null, memoryCitation: null },
  });
  fake.emit("turn/completed", {
    threadId: "thread-app-server",
    turn: {
      id: turnId,
      status: "completed",
      items: [],
      error: null,
    },
  });
}

function completeEmptyTurn(fake: FakeAppServerClient, turnId: string): void {
  fake.emit("turn/completed", {
    threadId: "thread-app-server",
    turn: {
      id: turnId,
      status: "completed",
      items: [],
      error: null,
    },
  });
}

function failTurn(
  fake: FakeAppServerClient,
  turnId: string,
  error: { message: string; codexErrorInfo?: unknown; additionalDetails?: string | null },
): void {
  fake.emit("turn/completed", {
    threadId: "thread-app-server",
    turn: {
      id: turnId,
      status: "failed",
      items: [],
      error: {
        message: error.message,
        codexErrorInfo: error.codexErrorInfo ?? null,
        additionalDetails: error.additionalDetails ?? null,
      },
    },
  });
}

function activeTurnNotSteerableError(): CodexAppServerRpcError {
  return new CodexAppServerRpcError("turn/steer", {
    code: -32602,
    message: "activeTurnNotSteerable",
    data: { activeTurnNotSteerable: { turnKind: "compact" } },
  });
}

function stubLandingTrialHostEnv(suffix: string): void {
  const hostHome = join(workspaceRoot, "..", `host-home-${suffix}`);
  const codexHome = join(hostHome, ".codex");
  const cliBinDir = join(workspaceRoot, `first-tree-cli-bin-${suffix}`);
  mkdirSync(cliBinDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(cliBinDir, "first-tree-test"), "#!/bin/sh\n", { mode: 0o755 });
  vi.stubEnv("HOME", hostHome);
  vi.stubEnv("FIRST_TREE_CLI_BIN_DIR", cliBinDir);
}

beforeEach(() => {
  workspaceRoot = realpathSync(mkdtempSync(join(tmpdir(), "ft-codex-app-server-")));
  setCliBinding({ binName: "first-tree-test", packageName: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("codex app-server handler", () => {
  it("starts landing campaign trial app-server with host Codex auth and managed workspace-only permissions", async () => {
    const hostHome = join(workspaceRoot, "..", "host-home");
    const codexHome = join(hostHome, ".codex");
    const ghConfigDir = join(hostHome, ".config", "gh");
    const sshKeyPath = join(hostHome, ".ssh", "id_ed25519");
    const firstTreeHome = join(workspaceRoot, "first-tree-home");
    const cliBinDir = join(workspaceRoot, "first-tree-cli-bin");
    mkdirSync(cliBinDir, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(ghConfigDir, { recursive: true });
    mkdirSync(join(hostHome, ".ssh"), { recursive: true });
    writeFileSync(sshKeyPath, "ssh-secret\n", { mode: 0o600 });
    writeFileSync(join(cliBinDir, "first-tree-test"), "#!/bin/sh\n", { mode: 0o755 });
    vi.stubEnv("HOME", hostHome);
    vi.stubEnv("FIRST_TREE_HOME", firstTreeHome);
    vi.stubEnv("FIRST_TREE_CLI_BIN_DIR", cliBinDir);
    vi.stubEnv("OPENAI_API_KEY", "secret-openai");
    vi.stubEnv("CODEX_API_KEY", "secret-codex");
    vi.stubEnv("GITHUB_TOKEN", "secret-github");
    vi.stubEnv("FIRST_TREE_RUNTIME_SESSION_TOKEN", "runtime-session-token");

    const fake = new FakeAppServerClient();
    let capturedSpawnProcess: unknown;
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    let capturedAppServerArgs: readonly string[] | undefined;
    const createAgentOutboxToken = vi
      .fn<(chatId: string) => Promise<{ accessToken: string; expiresIn: number }>>()
      .mockResolvedValue({ accessToken: "trial-outbox-token", expiresIn: 900 });
    const emitEventConfirmed = vi.fn<NonNullable<SessionContext["emitEventConfirmed"]>>().mockResolvedValue();
    const handler = makeHandler(fake, {
      codexAppServerClientFactory: async (options: {
        env?: NodeJS.ProcessEnv;
        spawnProcess?: unknown;
        appServerArgs?: readonly string[];
        onNotification?: NotificationHandler;
        onClose?: CloseHandler;
      }) => {
        capturedSpawnProcess = options.spawnProcess;
        capturedEnv = options.env;
        capturedAppServerArgs = options.appServerArgs;
        fake.onNotification = options.onNotification ?? null;
        fake.onClose = options.onClose ?? null;
        return fake;
      },
    });
    const ctx = makeContext({
      createAgentOutboxToken,
      emitEventConfirmed,
      agentMetadata: trialAgentMetadata,
    });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    expect(capturedSpawnProcess).toBeUndefined();
    expect(capturedAppServerArgs).toHaveLength(4);
    expect(capturedAppServerArgs?.[0]).toBe("-c");
    expect(capturedAppServerArgs?.[1]).toContain("permissions=");
    expect(capturedAppServerArgs?.[1]).toContain("first-tree-landing-trial");
    expect(capturedAppServerArgs?.[1]).toContain(codexHome);
    expect(capturedAppServerArgs?.[1]).toContain(workspaceRoot);
    expect(capturedAppServerArgs?.[2]).toBe("-c");
    expect(capturedAppServerArgs?.[3]).toBe('default_permissions="first-tree-landing-trial"');
    expect(createAgentOutboxToken).toHaveBeenCalledWith("chat-app-server");
    expect(capturedEnv?.FIRST_TREE_HOME).toBe(join(workspaceRoot, ".first-tree-workspace", "outbox-home"));
    expect(capturedEnv?.HOME).toBe(workspaceRoot);
    expect(capturedEnv?.CODEX_HOME).toBe(codexHome);
    expect(capturedEnv?.GH_CONFIG_DIR).toBe(ghConfigDir);
    expect(capturedEnv?.GIT_SSH_COMMAND).toContain("-F /dev/null");
    expect(capturedEnv?.GIT_SSH_COMMAND).toContain(sshKeyPath);
    expect(capturedEnv?.GIT_SSH_COMMAND).toContain(
      join(workspaceRoot, ".first-tree-workspace", "outbox-home", "ssh", "known_hosts"),
    );
    expect(capturedEnv?.PATH?.split(":")[0]).toBe(cliBinDir);
    expect(capturedEnv?.OPENAI_API_KEY).toBeUndefined();
    expect(capturedEnv?.CODEX_API_KEY).toBeUndefined();
    expect(capturedEnv?.GITHUB_TOKEN).toBeUndefined();
    expect(capturedEnv?.FIRST_TREE_RUNTIME_SESSION_TOKEN).toBeUndefined();
    const threadStart = fake.requests.find((request) => request.method === "thread/start");
    const threadStartParams = threadStart?.params as Record<string, unknown> | undefined;
    expect(threadStartParams).toMatchObject({
      permissions: "first-tree-landing-trial",
      runtimeWorkspaceRoots: [workspaceRoot],
    });
    expect(threadStartParams?.sandbox).toBeUndefined();
    expect(threadStartParams?.config).toMatchObject({
      permissions: {
        "first-tree-landing-trial": {
          workspace_roots: {
            [workspaceRoot]: true,
          },
          filesystem: {
            ":root": "read",
            [workspaceRoot]: "write",
            [codexHome]: "deny",
            [join(hostHome, ".first-tree-staging")]: "deny",
          },
          network: {
            enabled: true,
          },
        },
      },
    });

    completeTurn(fake, "turn-1", "final answer");
    await startPromise;
    expect(emitEventConfirmed).toHaveBeenCalledWith({
      kind: "turn_end",
      payload: { status: "success", turnCompletionId: "message:m1" },
    });
    await handler.shutdown();
  });

  it("leaves ordinary app-server startup unsandboxed", async () => {
    const fake = new FakeAppServerClient();
    let capturedSpawnProcess: unknown = "unset";
    let capturedAppServerArgs: readonly string[] | undefined;
    const handler = makeHandler(fake, {
      codexAppServerClientFactory: async (options: {
        spawnProcess?: unknown;
        appServerArgs?: readonly string[];
        onNotification?: NotificationHandler;
        onClose?: CloseHandler;
      }) => {
        capturedSpawnProcess = options.spawnProcess;
        capturedAppServerArgs = options.appServerArgs;
        fake.onNotification = options.onNotification ?? null;
        fake.onClose = options.onClose ?? null;
        return fake;
      },
    });
    const ctx = makeContext();

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    expect(capturedSpawnProcess).toBeUndefined();
    expect(capturedAppServerArgs).toBeUndefined();
    const threadStart = fake.requests.find((request) => request.method === "thread/start");
    expect(threadStart?.params).toMatchObject({ sandbox: "danger-full-access" });
    expect((threadStart?.params as Record<string, unknown> | undefined)?.permissions).toBeUndefined();

    completeTurn(fake, "turn-1", "final answer");
    await startPromise;
    await handler.shutdown();
  });

  it("accepts Codex's canonical priority response for the shipped Fast alias", async () => {
    const fake = new FakeAppServerClient();
    const mutable = makeMutableConfigCache("", "fast");
    const handler = makeHandler(fake, { agentConfigCache: mutable.cache });
    const ctx = makeContext();

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    const threadStart = fake.requests.find((request) => request.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      config: {
        features: { fast_mode: true },
        service_tier: "fast",
      },
    });
    expect(fake.requests.some((request) => request.method === "turn/start")).toBe(true);

    completeTurn(fake, "turn-1", "final answer");
    await startPromise;
    await handler.shutdown();
  });

  it("treats a legacy missing serviceTier as Standard in app-server", async () => {
    const fake = new FakeAppServerClient();
    const mutable = makeMutableConfigCache("", "default");
    const legacyConfig = await (
      mutable.cache as unknown as { refresh: () => Promise<{ payload: Record<string, unknown> }> }
    ).refresh();
    delete legacyConfig.payload.serviceTier;
    const cache = {
      ...(mutable.cache as Record<string, unknown>),
      get: () => legacyConfig,
      refresh: async () => legacyConfig,
    };
    const handler = makeHandler(fake, { agentConfigCache: cache });
    const ctx = makeContext();

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    const threadStart = fake.requests.find((request) => request.method === "thread/start");
    const config = (threadStart?.params as { config?: Record<string, unknown> } | undefined)?.config;
    expect(config?.service_tier).toBe("default");
    expect(config).not.toHaveProperty("features");

    completeTurn(fake, "turn-1", "final answer");
    await startPromise;
    await handler.shutdown();
  });

  it("keeps Standard compatible with provider-managed Fast-mode policy", async () => {
    const fake = new FakeAppServerClient();
    const mutable = makeMutableConfigCache("", "default");
    const handler = makeHandler(fake, { agentConfigCache: mutable.cache });
    const ctx = makeContext();

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    const threadStart = fake.requests.find((request) => request.method === "thread/start");
    const config = (threadStart?.params as { config?: Record<string, unknown> } | undefined)?.config;
    expect(config?.service_tier).toBe("default");
    expect(config).not.toHaveProperty("features");

    completeTurn(fake, "turn-1", "final answer");
    await startPromise;
    await handler.shutdown();
  });

  it("fails an unsupported service tier before app-server starts a turn", async () => {
    const fake = new FakeAppServerClient();
    fake.deferThreadStart();
    const mutable = makeMutableConfigCache("", "fast");
    const handler = makeHandler(fake, { agentConfigCache: mutable.cache });
    const token = makeDeliveryToken();
    const emitEvent = vi.fn<SessionContext["emitEvent"]>();
    const ctx = makeContext({ emitEvent });
    const message = makeMessage("m1", "first");
    const warning =
      "Configured service tier `fast` is not advertised as supported for model `gpt-test` and will be omitted from requests.";

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "thread/start"));
    fake.emit("warning", { threadId: "thread-app-server", message: warning });
    fake.resolveThreadStart();

    await expect(startPromise).resolves.toMatchObject({
      sessionId: "thread-app-server",
      route: { kind: "owned", mode: "processing" },
    });
    expect(fake.requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(token.processingStarted).toHaveBeenCalledWith([message]);
    expect(token.complete).toHaveBeenCalledWith([message], {
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "codex_service_tier_unsupported",
    });
    expect(emitEvent).toHaveBeenCalledWith({
      kind: "error",
      payload: {
        source: "runtime",
        message: `Codex service tier configuration failed: ${warning}`,
      },
    });
    const providerFailure = emitEvent.mock.calls
      .map(([event]) => (event.kind === "error" ? parseProviderRetryEventMessage(event.payload.message) : null))
      .find((payload) => payload?.event === "provider_failure_terminal");
    expect(providerFailure).toMatchObject({
      provider: "codex",
      scope: "provider_turn",
      category: "configuration",
      reasonCode: "codex_service_tier_unsupported",
    });
    expect(emitEvent).toHaveBeenCalledWith({ kind: "turn_end", payload: { status: "error" } });

    await handler.shutdown();
  });

  it("steers active-turn injects and acks the injected message with the current turn", async () => {
    const fake = new FakeAppServerClient();
    const finished: SessionMessage[][] = [];
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const handler = makeHandler(fake);
    const ctx = makeContext({
      emitEvent,
      finishTurn: async (messages) => {
        finished.push(Array.isArray(messages) ? [...messages] : [messages]);
      },
    });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    handler.inject(makeMessage("m2", "second"), deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/steer"));

    const steer = fake.requests.find((request) => request.method === "turn/steer");
    expect(steer?.params).toMatchObject({ threadId: "thread-app-server", expectedTurnId: "turn-1" });

    completeTurn(fake, "turn-1", "final answer");
    await startPromise;

    expect(finished.map((messages) => messages.map((message) => message.id))).toEqual([["m1", "m2"]]);
    expect(emitEvent.mock.calls.some(([event]) => event.kind === "token_usage")).toBe(true);

    await handler.shutdown();
  });

  it("leaves landing trial delivery recoverable when confirmed success turn_end is rejected", async () => {
    stubLandingTrialHostEnv("confirm-reject");

    const fake = new FakeAppServerClient();
    const token = makeDeliveryToken();
    const failSessionForRecovery = vi.fn<NonNullable<SessionContext["failSessionForRecovery"]>>();
    const emitEventConfirmed = vi
      .fn<NonNullable<SessionContext["emitEventConfirmed"]>>()
      .mockRejectedValue(new Error("session event persist failed"));
    const handler = makeHandler(fake);
    const ctx = makeContext({
      emitEventConfirmed,
      failSessionForRecovery,
      agentMetadata: trialAgentMetadata,
    });
    const message = makeMessage("m1", "first", 101);

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    completeTurn(fake, "turn-1", "final answer");
    await expect(startPromise).resolves.toMatchObject({
      sessionId: "thread-app-server",
      route: { kind: "owned", mode: "processing" },
    });

    expect(emitEventConfirmed).toHaveBeenCalledWith({
      kind: "turn_end",
      payload: { status: "success", turnCompletionId: "inbox:101" },
    });
    expect(token.complete).not.toHaveBeenCalled();
    expect(token.retry).toHaveBeenCalledWith([message], LANDING_TRIAL_TURN_COMPLETION_CONFIRM_FAILED);
    expect(failSessionForRecovery).toHaveBeenCalledWith(
      LANDING_TRIAL_TURN_COMPLETION_CONFIRM_FAILED,
      "thread-app-server",
    );

    await handler.shutdown();
  });

  it("leaves landing trial delivery recoverable when confirmed success events are unsupported", async () => {
    stubLandingTrialHostEnv("confirm-missing");

    const fake = new FakeAppServerClient();
    const token = makeDeliveryToken();
    const failSessionForRecovery = vi.fn<NonNullable<SessionContext["failSessionForRecovery"]>>();
    const handler = makeHandler(fake);
    const ctx = makeContext({
      failSessionForRecovery,
      agentMetadata: trialAgentMetadata,
    });
    const message = makeMessage("m1", "first", 102);

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    completeTurn(fake, "turn-1", "final answer");
    await startPromise;

    expect(token.complete).not.toHaveBeenCalled();
    expect(token.retry).toHaveBeenCalledWith([message], LANDING_TRIAL_TURN_COMPLETION_CONFIRM_FAILED);
    expect(failSessionForRecovery).toHaveBeenCalledWith(
      LANDING_TRIAL_TURN_COMPLETION_CONFIRM_FAILED,
      "thread-app-server",
    );

    await handler.shutdown();
  });

  it("does not block ordinary Codex delivery on confirmed event rejection", async () => {
    const fake = new FakeAppServerClient();
    const token = makeDeliveryToken();
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const emitEventConfirmed = vi
      .fn<NonNullable<SessionContext["emitEventConfirmed"]>>()
      .mockRejectedValue(new Error("session event persist failed"));
    const handler = makeHandler(fake);
    const ctx = makeContext({ emitEvent, emitEventConfirmed });
    const message = makeMessage("m1", "first");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    completeTurn(fake, "turn-1", "final answer");
    await expect(startPromise).resolves.toMatchObject({
      sessionId: "thread-app-server",
      route: { kind: "owned", mode: "processing" },
    });

    expect(emitEventConfirmed).not.toHaveBeenCalled();
    expect(emitEvent).toHaveBeenCalledWith({
      kind: "turn_end",
      payload: { status: "success" },
    });
    expect(token.complete).toHaveBeenCalledWith([message], expect.objectContaining({ status: "success" }));
    expect(token.retry).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it("emits one token usage event from the cumulative total delta across app-server updates", async () => {
    const fake = new FakeAppServerClient();
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const handler = makeHandler(fake);
    const ctx = makeContext({ emitEvent });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    emitTokenUsage(fake, "turn-1", {
      totalTokens: 125,
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 5,
      reasoningOutputTokens: 0,
    });
    emitTokenUsage(fake, "turn-1", {
      totalTokens: 77,
      inputTokens: 60,
      cachedInputTokens: 10,
      outputTokens: 7,
      reasoningOutputTokens: 0,
    });
    fake.emit("item/completed", {
      threadId: "thread-app-server",
      turnId: "turn-1",
      item: { type: "agentMessage", id: "item-turn-1", text: "final answer", phase: null, memoryCitation: null },
    });
    fake.emit("turn/completed", {
      threadId: "thread-app-server",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [],
        error: null,
      },
    });
    await startPromise;

    expect(findTokenUsageEvent(emitEvent)?.payload).toMatchObject({
      provider: "codex",
      model: "codex-default",
      inputTokens: 130,
      cachedInputTokens: 30,
      outputTokens: 12,
    });

    await handler.shutdown();
  });

  it("uses replayed cumulative usage as the resumed thread baseline", async () => {
    const fake = new FakeAppServerClient();
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const handler = makeHandler(fake);
    const ctx = makeContext({ emitEvent });

    fake.beforeThreadResumeReturn = () => {
      emitTokenUsage(fake, "turn-old", {
        totalTokens: 1050,
        inputTokens: 1000,
        cachedInputTokens: 200,
        outputTokens: 50,
        reasoningOutputTokens: 0,
      });
    };

    const resumePromise = handler.resume(
      makeMessage("m1", "first"),
      "thread-app-server",
      ctx,
      deliveryTokenFromSessionContext(ctx),
    );
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    emitTokenUsage(
      fake,
      "turn-1",
      {
        totalTokens: 25,
        inputTokens: 20,
        cachedInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0,
      },
      {
        totalTokens: 1155,
        inputTokens: 1100,
        cachedInputTokens: 220,
        outputTokens: 55,
        reasoningOutputTokens: 0,
      },
    );
    fake.emit("item/completed", {
      threadId: "thread-app-server",
      turnId: "turn-1",
      item: { type: "agentMessage", id: "item-turn-1", text: "resumed answer", phase: null, memoryCitation: null },
    });
    fake.emit("turn/completed", {
      threadId: "thread-app-server",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [],
        error: null,
      },
    });
    await resumePromise;

    expect(findTokenUsageEvent(emitEvent)?.payload).toMatchObject({
      provider: "codex",
      model: "codex-default",
      inputTokens: 80,
      cachedInputTokens: 20,
      outputTokens: 5,
    });

    await handler.shutdown();
  });

  it("uses buffered cumulative usage replayed while turn/start is in flight", async () => {
    const fake = new FakeAppServerClient();
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const handler = makeHandler(fake);
    const ctx = makeContext({ emitEvent });

    fake.beforeTurnStartReturn = () => {
      emitTokenUsage(fake, "turn-old", {
        totalTokens: 1050,
        inputTokens: 1000,
        cachedInputTokens: 200,
        outputTokens: 50,
        reasoningOutputTokens: 0,
      });
    };

    const resumePromise = handler.resume(
      makeMessage("m1", "first"),
      "thread-app-server",
      ctx,
      deliveryTokenFromSessionContext(ctx),
    );
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    emitTokenUsage(
      fake,
      "turn-1",
      {
        totalTokens: 25,
        inputTokens: 20,
        cachedInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0,
      },
      {
        totalTokens: 1155,
        inputTokens: 1100,
        cachedInputTokens: 220,
        outputTokens: 55,
        reasoningOutputTokens: 0,
      },
    );
    fake.emit("item/completed", {
      threadId: "thread-app-server",
      turnId: "turn-1",
      item: {
        type: "agentMessage",
        id: "item-turn-1",
        text: "resumed answer",
        phase: null,
        memoryCitation: null,
      },
    });
    fake.emit("turn/completed", {
      threadId: "thread-app-server",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [],
        error: null,
      },
    });
    await resumePromise;

    expect(findTokenUsageEvent(emitEvent)?.payload).toMatchObject({
      provider: "codex",
      model: "codex-default",
      inputTokens: 80,
      cachedInputTokens: 20,
      outputTokens: 5,
    });

    await handler.shutdown();
  });

  it("fresh-starts and rebinds when thread/resume reports a missing rollout", async () => {
    const fake = new FakeAppServerClient();
    fake.threadResumeError = new Error(
      "thread/resume: thread/resume failed: no rollout found for thread id thread-stale (code -32600)",
    );
    const replaceSessionId = vi.fn<NonNullable<SessionContext["replaceSessionId"]>>();
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const failSessionForRecovery = vi.fn<NonNullable<SessionContext["failSessionForRecovery"]>>();
    const handler = makeHandler(fake);
    const ctx = makeContext({ replaceSessionId, retryTurn, failSessionForRecovery });
    const token = makeDeliveryToken();

    const resumePromise = handler.resume(makeMessage("m1", "first"), "thread-stale", ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));
    completeTurn(fake, "turn-1", "fresh answer");
    const result = await resumePromise;

    expect(fake.requests.map((request) => request.method)).toEqual(["thread/resume", "thread/start", "turn/start"]);
    expect(result).toEqual({ sessionId: "thread-app-server", route: { kind: "owned", mode: "processing" } });
    expect(replaceSessionId).toHaveBeenCalledWith("thread-app-server", "codex_stale_rollout_recovered");
    expect(token.retry).not.toHaveBeenCalled();
    expect(retryTurn).not.toHaveBeenCalled();
    expect(failSessionForRecovery).not.toHaveBeenCalled();
  });

  it("rejects a Context source change while app-server starts before creating a thread", async () => {
    const fake = new FakeAppServerClient();
    const repoA = "https://github.com/acme/tree-a.git";
    let authoritativeRepo = repoA;
    let markResolverEntered: (() => void) | undefined;
    let releaseResolver: (() => void) | undefined;
    const resolverEntered = new Promise<void>((resolve) => {
      markResolverEntered = resolve;
    });
    const resolverGate = new Promise<void>((resolve) => {
      releaseResolver = resolve;
    });
    const handler = makeHandler(fake, {
      contextSourceKind: "remote",
      contextTreePath: join(workspaceRoot, "context-tree"),
      contextTreeRepoUrl: repoA,
      contextTreeBranch: "main",
      codexRuntimeBinaryResolver: async () => {
        markResolverEntered?.();
        await resolverGate;
        return {
          ok: true,
          binary: "/tmp/fake-codex",
          runtimeSource: "path",
          runtimePath: "/tmp/fake-codex",
          version: "0.0.0-test",
        };
      },
    });
    const ctx = makeContext({
      getAgentContextTreeConfig: async () => ({
        bindingState: "bound",
        repo: authoritativeRepo,
        branch: "main",
        provider: "github",
      }),
    });
    const token = makeDeliveryToken();

    const startPromise = handler.start(makeMessage("m-source-start", "first"), ctx, token);
    await resolverEntered;
    authoritativeRepo = "https://github.com/acme/tree-b.git";
    releaseResolver?.();

    await expect(startPromise).rejects.toMatchObject({ name: "ContextSourceTransitionError" });
    expect(fake.requests.filter((request) => request.method === "thread/start")).toHaveLength(0);
    expect(fake.requests.filter((request) => request.method === "thread/resume")).toHaveLength(0);
    expect(token.complete).not.toHaveBeenCalled();
    await handler.shutdown();
    expect(fake.isClosed).toBe(true);
  });

  it("retries an active stale-rollout turn without starting a thread after Context source changes", async () => {
    const fake = new FakeAppServerClient();
    const repoA = "https://github.com/acme/tree-a.git";
    const repoB = "https://github.com/acme/tree-b.git";
    let authoritativeRepo = repoA;
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const failSessionForRecovery = vi.fn<NonNullable<SessionContext["failSessionForRecovery"]>>();
    const handler = makeHandler(fake, {
      contextSourceKind: "remote",
      contextTreePath: join(workspaceRoot, "context-tree"),
      contextTreeRepoUrl: repoA,
      contextTreeBranch: "main",
    });
    const ctx = makeContext({
      retryTurn,
      failSessionForRecovery,
      getAgentContextTreeConfig: async () => ({
        bindingState: "bound",
        repo: authoritativeRepo,
        branch: "main",
        provider: "github",
      }),
    });

    const initialToken = makeDeliveryToken();
    const resumePromise = handler.resume(makeMessage("m-source-a", "first"), "thread-app-server", ctx, initialToken);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));
    completeTurn(fake, "turn-1", "ready");
    await resumePromise;

    fake.turnStartError = new Error(
      "thread/resume failed: no rollout found for thread id thread-app-server (code -32600)",
    );
    authoritativeRepo = repoB;
    const injectedToken = makeDeliveryToken();
    expect(handler.inject(makeMessage("m-source-b", "continue"), injectedToken)).toMatchObject({
      kind: "owned",
      mode: "queued",
    });
    await waitFor(() => vi.mocked(injectedToken.retry).mock.calls.length > 0);

    expect(fake.requests.filter((request) => request.method === "thread/start")).toHaveLength(0);
    expect(injectedToken.retry).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "m-source-b" })],
      "codex_app_server_context_source_changed",
    );
    expect(injectedToken.complete).not.toHaveBeenCalled();
    expect(retryTurn).not.toHaveBeenCalled();
    expect(failSessionForRecovery).toHaveBeenCalledWith("codex_app_server_context_source_changed", "thread-app-server");
    await handler.shutdown();
  });

  it("uses late replayed cumulative usage as the current resumed turn baseline", async () => {
    const fake = new FakeAppServerClient();
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const handler = makeHandler(fake);
    const ctx = makeContext({ emitEvent });

    const resumePromise = handler.resume(
      makeMessage("m1", "first"),
      "thread-app-server",
      ctx,
      deliveryTokenFromSessionContext(ctx),
    );
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));
    await flushAsync();

    emitTokenUsage(
      fake,
      "turn-old",
      {
        totalTokens: 1050,
        inputTokens: 1000,
        cachedInputTokens: 200,
        outputTokens: 50,
        reasoningOutputTokens: 0,
      },
      {
        totalTokens: 1050,
        inputTokens: 1000,
        cachedInputTokens: 200,
        outputTokens: 50,
        reasoningOutputTokens: 0,
      },
    );
    emitTokenUsage(
      fake,
      "turn-1",
      {
        totalTokens: 25,
        inputTokens: 20,
        cachedInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0,
      },
      {
        totalTokens: 1155,
        inputTokens: 1100,
        cachedInputTokens: 220,
        outputTokens: 55,
        reasoningOutputTokens: 0,
      },
    );
    fake.emit("item/completed", {
      threadId: "thread-app-server",
      turnId: "turn-1",
      item: {
        type: "agentMessage",
        id: "item-turn-1",
        text: "resumed answer",
        phase: null,
        memoryCitation: null,
      },
    });
    fake.emit("turn/completed", {
      threadId: "thread-app-server",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [],
        error: null,
      },
    });
    await resumePromise;

    expect(findTokenUsageEvent(emitEvent)?.payload).toMatchObject({
      provider: "codex",
      model: "codex-default",
      inputTokens: 80,
      cachedInputTokens: 20,
      outputTokens: 5,
    });

    await handler.shutdown();
  });

  it("advances the next baseline when compaction lowers the current turn cumulative total", async () => {
    const fake = new FakeAppServerClient();
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const handler = makeHandler(fake);
    const ctx = makeContext({ emitEvent });

    fake.beforeThreadResumeReturn = () => {
      emitTokenUsage(fake, "turn-old", {
        totalTokens: 10_000,
        inputTokens: 9_000,
        cachedInputTokens: 0,
        outputTokens: 1_000,
        reasoningOutputTokens: 0,
      });
    };

    const resumePromise = handler.resume(
      makeMessage("m1", "first"),
      "thread-app-server",
      ctx,
      deliveryTokenFromSessionContext(ctx),
    );
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    emitTokenUsage(
      fake,
      "turn-1",
      {
        totalTokens: 100,
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      {
        totalTokens: 2_000,
        inputTokens: 1_800,
        cachedInputTokens: 0,
        outputTokens: 200,
        reasoningOutputTokens: 0,
      },
    );
    fake.emit("item/completed", {
      threadId: "thread-app-server",
      turnId: "turn-1",
      item: { type: "agentMessage", id: "item-turn-1", text: "first answer", phase: null, memoryCitation: null },
    });
    fake.emit("turn/completed", {
      threadId: "thread-app-server",
      turn: {
        id: "turn-1",
        status: "completed",
        items: [],
        error: null,
      },
    });
    await resumePromise;

    emitTokenUsage(
      fake,
      "turn-old-stale",
      {
        totalTokens: 10_000,
        inputTokens: 9_000,
        cachedInputTokens: 0,
        outputTokens: 1_000,
        reasoningOutputTokens: 0,
      },
      {
        totalTokens: 10_000,
        inputTokens: 9_000,
        cachedInputTokens: 0,
        outputTokens: 1_000,
        reasoningOutputTokens: 0,
      },
    );

    handler.inject(makeMessage("m2", "second"), deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.filter((request) => request.method === "turn/start").length === 2);

    emitTokenUsage(
      fake,
      "turn-2",
      {
        totalTokens: 500,
        inputTokens: 500,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      {
        totalTokens: 2_500,
        inputTokens: 2_300,
        cachedInputTokens: 0,
        outputTokens: 200,
        reasoningOutputTokens: 0,
      },
    );
    fake.emit("item/completed", {
      threadId: "thread-app-server",
      turnId: "turn-2",
      item: { type: "agentMessage", id: "item-turn-2", text: "second answer", phase: null, memoryCitation: null },
    });
    fake.emit("turn/completed", {
      threadId: "thread-app-server",
      turn: {
        id: "turn-2",
        status: "completed",
        items: [],
        error: null,
      },
    });
    await waitFor(() => tokenUsageEvents(emitEvent).length === 2);

    expect(tokenUsageEvents(emitEvent).map((event) => event.payload)).toMatchObject([
      {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
      {
        inputTokens: 500,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
    ]);

    await handler.shutdown();
  });

  it("syncs a waiting turn baseline from late usage on the previous own turn", async () => {
    const fake = new FakeAppServerClient();
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const handler = makeHandler(fake);
    const ctx = makeContext({ emitEvent });

    fake.beforeThreadResumeReturn = () => {
      emitTokenUsage(fake, "turn-old", {
        totalTokens: 10_000,
        inputTokens: 9_000,
        cachedInputTokens: 0,
        outputTokens: 1_000,
        reasoningOutputTokens: 0,
      });
    };

    const resumePromise = handler.resume(
      makeMessage("m1", "first"),
      "thread-app-server",
      ctx,
      deliveryTokenFromSessionContext(ctx),
    );
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    emitTokenUsage(
      fake,
      "turn-1",
      {
        totalTokens: 100,
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      {
        totalTokens: 2_000,
        inputTokens: 1_800,
        cachedInputTokens: 0,
        outputTokens: 200,
        reasoningOutputTokens: 0,
      },
    );
    fake.emit("item/completed", {
      threadId: "thread-app-server",
      turnId: "turn-1",
      item: { type: "agentMessage", id: "item-turn-1", text: "first answer", phase: null, memoryCitation: null },
    });
    fake.emit("turn/completed", {
      threadId: "thread-app-server",
      turn: { id: "turn-1", status: "completed", items: [], error: null },
    });
    await resumePromise;

    handler.inject(makeMessage("m2", "second"), deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.filter((request) => request.method === "turn/start").length === 2);
    await flushAsync();

    emitTokenUsage(
      fake,
      "turn-1",
      {
        totalTokens: 100,
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      {
        totalTokens: 2_100,
        inputTokens: 1_900,
        cachedInputTokens: 0,
        outputTokens: 200,
        reasoningOutputTokens: 0,
      },
    );
    emitTokenUsage(
      fake,
      "turn-2",
      {
        totalTokens: 500,
        inputTokens: 500,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      {
        totalTokens: 2_600,
        inputTokens: 2_400,
        cachedInputTokens: 0,
        outputTokens: 200,
        reasoningOutputTokens: 0,
      },
    );
    fake.emit("item/completed", {
      threadId: "thread-app-server",
      turnId: "turn-2",
      item: { type: "agentMessage", id: "item-turn-2", text: "second answer", phase: null, memoryCitation: null },
    });
    fake.emit("turn/completed", {
      threadId: "thread-app-server",
      turn: { id: "turn-2", status: "completed", items: [], error: null },
    });
    await waitFor(() => tokenUsageEvents(emitEvent).length === 2);

    emitTokenUsage(
      fake,
      "turn-1",
      {
        totalTokens: 10_000,
        inputTokens: 9_000,
        cachedInputTokens: 0,
        outputTokens: 1_000,
        reasoningOutputTokens: 0,
      },
      {
        totalTokens: 10_000,
        inputTokens: 9_000,
        cachedInputTokens: 0,
        outputTokens: 1_000,
        reasoningOutputTokens: 0,
      },
    );

    handler.inject(makeMessage("m3", "third"), deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.filter((request) => request.method === "turn/start").length === 3);

    emitTokenUsage(
      fake,
      "turn-3",
      {
        totalTokens: 500,
        inputTokens: 500,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      {
        totalTokens: 3_100,
        inputTokens: 2_900,
        cachedInputTokens: 0,
        outputTokens: 200,
        reasoningOutputTokens: 0,
      },
    );
    fake.emit("item/completed", {
      threadId: "thread-app-server",
      turnId: "turn-3",
      item: { type: "agentMessage", id: "item-turn-3", text: "third answer", phase: null, memoryCitation: null },
    });
    fake.emit("turn/completed", {
      threadId: "thread-app-server",
      turn: { id: "turn-3", status: "completed", items: [], error: null },
    });
    await waitFor(() => tokenUsageEvents(emitEvent).length === 3);

    expect(tokenUsageEvents(emitEvent).map((event) => event.payload)).toMatchObject([
      {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
      {
        inputTokens: 500,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
      {
        inputTokens: 500,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
    ]);

    await handler.shutdown();
  });

  it("keeps startup injects queued until the first turn can steer them", async () => {
    const fake = new FakeAppServerClient();
    fake.deferThreadStart();
    const finished: SessionMessage[][] = [];
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const handler = makeHandler(fake);
    const ctx = makeContext({
      retryTurn,
      finishTurn: async (messages) => {
        finished.push(Array.isArray(messages) ? [...messages] : [messages]);
      },
    });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "thread/start"));

    handler.inject(makeMessage("m2", "second"), deliveryTokenFromSessionContext(ctx));
    await flushAsync();

    expect(retryTurn).not.toHaveBeenCalled();
    expect(fake.requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(fake.requests.some((request) => request.method === "turn/steer")).toBe(false);

    fake.resolveThreadStart();
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/steer"));

    completeTurn(fake, "turn-1", "final answer");
    await startPromise;

    expect(retryTurn).not.toHaveBeenCalled();
    expect(finished.map((messages) => messages.map((message) => message.id))).toEqual([["m1", "m2"]]);

    await handler.shutdown();
  });

  it("falls stale/non-steerable injects back to the next turn", async () => {
    const fake = new FakeAppServerClient();
    fake.steerError = activeTurnNotSteerableError();
    const finished: SessionMessage[][] = [];
    const handler = makeHandler(fake);
    const ctx = makeContext({
      finishTurn: async (messages) => {
        finished.push(Array.isArray(messages) ? [...messages] : [messages]);
      },
    });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));
    handler.inject(makeMessage("m2", "second"), deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/steer"));
    await flushAsync();

    expect(fake.requests.filter((request) => request.method === "turn/steer")).toHaveLength(1);

    completeTurn(fake, "turn-1", "first done");
    await waitFor(() => fake.requests.filter((request) => request.method === "turn/start").length === 2);
    completeTurn(fake, "turn-2", "second done");
    await startPromise;
    await waitFor(() => finished.length === 2);

    expect(finished.map((messages) => messages.map((message) => message.id))).toEqual([["m1"], ["m2"]]);

    await handler.shutdown();
  });

  it("retries the ordered pending batch when input arrives during a no-custody steer", async () => {
    const fake = new FakeAppServerClient();
    fake.deferNextSteer();
    const finished: SessionMessage[][] = [];
    const handler = makeHandler(fake);
    const ctx = makeContext({
      finishTurn: async (messages) => {
        finished.push(Array.isArray(messages) ? [...messages] : [messages]);
      },
    });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    handler.inject(makeMessage("m2", "second"), deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/steer"));

    handler.inject(makeMessage("m3", "third"), deliveryTokenFromSessionContext(ctx));
    await flushAsync();

    expect(fake.requests.filter((request) => request.method === "turn/steer")).toHaveLength(1);

    fake.rejectSteer(activeTurnNotSteerableError());
    await waitFor(() => fake.requests.filter((request) => request.method === "turn/steer").length === 2);

    const retriedSteer = fake.requests.filter((request) => request.method === "turn/steer")[1];
    expect(JSON.stringify(retriedSteer?.params)).toContain("second");
    expect(JSON.stringify(retriedSteer?.params)).toContain("third");

    completeTurn(fake, "turn-1", "all done");
    await startPromise;
    await waitFor(() => finished.length === 1);

    expect(fake.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
    expect(finished.map((messages) => messages.map((message) => message.id))).toEqual([["m1", "m2", "m3"]]);

    await handler.shutdown();
  });

  it("retries a rejected pending prefix when a later input arrives", async () => {
    const fake = new FakeAppServerClient();
    fake.steerError = activeTurnNotSteerableError();
    const finished: SessionMessage[][] = [];
    const handler = makeHandler(fake);
    const ctx = makeContext({
      finishTurn: async (messages) => {
        finished.push(Array.isArray(messages) ? [...messages] : [messages]);
      },
    });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    handler.inject(makeMessage("m2", "second"), deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.filter((request) => request.method === "turn/steer").length === 1);
    await flushAsync();

    fake.steerError = null;
    handler.inject(makeMessage("m3", "third"), deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.filter((request) => request.method === "turn/steer").length === 2);

    const retriedSteer = fake.requests.filter((request) => request.method === "turn/steer")[1];
    expect(JSON.stringify(retriedSteer?.params)).toContain("second");
    expect(JSON.stringify(retriedSteer?.params)).toContain("third");

    completeTurn(fake, "turn-1", "all done");
    await startPromise;

    expect(finished.map((messages) => messages.map((message) => message.id))).toEqual([["m1", "m2", "m3"]]);

    await handler.shutdown();
  });

  it("batches repeatedly rejected pending inputs into the next turn", async () => {
    const fake = new FakeAppServerClient();
    fake.steerError = activeTurnNotSteerableError();
    const finished: SessionMessage[][] = [];
    const handler = makeHandler(fake);
    const ctx = makeContext({
      finishTurn: async (messages) => {
        finished.push(Array.isArray(messages) ? [...messages] : [messages]);
      },
    });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    handler.inject(makeMessage("m2", "second"), deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.filter((request) => request.method === "turn/steer").length === 1);
    handler.inject(makeMessage("m3", "third"), deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.filter((request) => request.method === "turn/steer").length === 2);

    completeTurn(fake, "turn-1", "first done");
    await startPromise;
    await waitFor(() => fake.requests.filter((request) => request.method === "turn/start").length === 2);

    const secondStart = fake.requests.filter((request) => request.method === "turn/start")[1];
    expect(JSON.stringify(secondStart?.params)).toContain("second");
    expect(JSON.stringify(secondStart?.params)).toContain("third");

    completeTurn(fake, "turn-2", "second batch done");
    await waitFor(() => finished.length === 2);

    expect(finished.map((messages) => messages.map((message) => message.id))).toEqual([["m1"], ["m2", "m3"]]);

    await handler.shutdown();
  });

  it("waits for an in-flight steer success before settling a completed turn", async () => {
    const fake = new FakeAppServerClient();
    fake.deferNextSteer();
    const finished: SessionMessage[][] = [];
    const handler = makeHandler(fake);
    const ctx = makeContext({
      finishTurn: async (messages) => {
        finished.push(Array.isArray(messages) ? [...messages] : [messages]);
      },
    });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));
    handler.inject(makeMessage("m2", "second"), deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/steer"));

    completeTurn(fake, "turn-1", "final answer");
    await flushAsync();

    expect(finished).toHaveLength(0);

    fake.resolveSteer();
    await startPromise;

    expect(finished.map((messages) => messages.map((message) => message.id))).toEqual([["m1", "m2"]]);

    await handler.shutdown();
  });

  it("keeps in-flight steer no-custody input pending when completion wins the race", async () => {
    const fake = new FakeAppServerClient();
    fake.deferNextSteer();
    const finished: SessionMessage[][] = [];
    const handler = makeHandler(fake);
    const ctx = makeContext({
      finishTurn: async (messages) => {
        finished.push(Array.isArray(messages) ? [...messages] : [messages]);
      },
    });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));
    handler.inject(makeMessage("m2", "second"), deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/steer"));

    completeTurn(fake, "turn-1", "first done");
    await flushAsync();

    expect(finished).toHaveLength(0);

    fake.rejectSteer(activeTurnNotSteerableError());
    await startPromise;

    expect(finished.map((messages) => messages.map((message) => message.id))).toEqual([["m1"]]);
    await waitFor(() => fake.requests.filter((request) => request.method === "turn/start").length === 2);

    completeTurn(fake, "turn-2", "second done");
    await waitFor(() => finished.length === 2);

    expect(finished.map((messages) => messages.map((message) => message.id))).toEqual([["m1"], ["m2"]]);

    await handler.shutdown();
  });

  it("fences pending tail when the accepted turn prefix must retry", async () => {
    const fake = new FakeAppServerClient();
    fake.steerError = activeTurnNotSteerableError();
    const retried: Array<{ ids: string[]; reason: string }> = [];
    const failSessionForRecovery = vi.fn<(reason: string, sessionId?: string) => void>();
    const finishTurn = vi.fn<SessionContext["finishTurn"]>();
    const handler = makeHandler(fake);
    const ctx = makeContext({
      finishTurn,
      retryTurn: (messages, reason) => {
        retried.push({ ids: messageIds(messages), reason });
      },
      failSessionForRecovery,
    });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));
    handler.inject(makeMessage("m2", "second"), deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/steer"));

    failTurn(fake, "turn-1", { message: "provider failed" });
    await startPromise;
    await flushAsync();

    expect(fake.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
    expect(finishTurn).not.toHaveBeenCalled();
    expect(retried).toEqual([
      { ids: ["m1"], reason: "codex_unknown_failure" },
      { ids: ["m2"], reason: "codex_unknown_failure" },
    ]);
    expect(failSessionForRecovery).toHaveBeenCalledWith("codex_unknown_failure", "thread-app-server");
    expect(fake.isClosed).toBe(true);

    await handler.shutdown();
  });

  it("settles a pending batch exactly once when the pre-format refresh fails closed", async () => {
    const fake = new FakeAppServerClient();
    const mutable = makeMutableConfigCache("append-v1");
    const handler = makeHandler(fake, { agentConfigCache: mutable.cache });
    const ctx = makeContext({});
    const m2Token = makeDeliveryToken();
    const m3Token = makeDeliveryToken();

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));
    completeTurn(fake, "turn-1", "first done");
    await startPromise;

    // The pre-format refresh reconciles managed skills; make it fail closed.
    // Break the verified projection first so the refresh actually reconciles
    // instead of taking the consistent-none early return.
    rmSync(join(workspaceRoot, ".agents", "skills", "first-tree-read"), { recursive: true, force: true });
    const { reconcileManagedSkillsForConfig, ManagedSkillsUnsafeDiscoveryError } = await import(
      "../../../../runtime/managed-skills.js"
    );
    vi.mocked(reconcileManagedSkillsForConfig).mockRejectedValueOnce(
      new ManagedSkillsUnsafeDiscoveryError("unsafe discovery"),
    );

    handler.inject(makeMessage("m2", "second"), m2Token);
    await waitFor(() => vi.mocked(m2Token.retry).mock.calls.length > 0);

    // Custody moved to recovery exactly once...
    expect(vi.mocked(m2Token.retry).mock.calls).toEqual([
      [expect.objectContaining({ id: "m2" }), "codex_managed_skills_unsafe"],
    ]);
    // ...and the batch left the pending queue: a later message starts a turn
    // that carries ONLY itself, never a duplicated m2.
    handler.inject(makeMessage("m3", "third"), m3Token);
    await waitFor(() => fake.requests.filter((request) => request.method === "turn/start").length === 2);
    const secondStart = fake.requests.filter((request) => request.method === "turn/start")[1];
    const input = JSON.stringify(secondStart?.params ?? {});
    expect(input).toContain("third");
    expect(input).not.toContain("second");
    expect(vi.mocked(m2Token.retry).mock.calls).toHaveLength(1);

    completeTurn(fake, "turn-2", "third done");
    await handler.shutdown();
  });

  it("terminal-rejects deterministic context-window turn failures instead of retrying delivery", async () => {
    const fake = new FakeAppServerClient();
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const finishTurn = vi.fn<SessionContext["finishTurn"]>();
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const token = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext({ retryTurn, finishTurn, emitEvent });
    const message = makeMessage("m1", "first");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    failTurn(fake, "turn-1", {
      message:
        "Error running remote compact task: Codex ran out of room in the model's context window. Start a new thread.",
      codexErrorInfo: "contextWindowExceeded",
    });
    await startPromise;

    expect(token.terminalRejected).toHaveBeenCalledWith([message], "codex_context_window_exceeded", {
      kind: "server_terminal_record",
      recordId: "turn-1",
    });
    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).not.toHaveBeenCalled();
    expect(retryTurn).not.toHaveBeenCalled();
    expect(finishTurn).not.toHaveBeenCalled();
    expect(
      emitEvent.mock.calls.some(
        ([event]) =>
          event.kind === "error" &&
          event.payload.source === "sdk" &&
          event.payload.message.includes("Codex ran out of room"),
      ),
    ).toBe(true);
    expect(emitEvent).toHaveBeenCalledWith({ kind: "turn_end", payload: { status: "error" } });

    await handler.shutdown();
  });

  it.each([
    ["bad request", "badRequest", "bad request rejected the request", "codex_bad_request_failure"],
    ["cyber policy", "cyberPolicy", "bad request rejected by cyber policy", "codex_cyber_policy_failure"],
  ])("terminal-rejects deterministic %s turn failures", async (_label, codexErrorInfo, messageText, reason) => {
    const fake = new FakeAppServerClient();
    const token = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext();
    const message = makeMessage("m1", "first");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    failTurn(fake, "turn-1", {
      message: messageText,
      codexErrorInfo,
    });
    await startPromise;

    expect(token.terminalRejected).toHaveBeenCalledWith([message], reason, {
      kind: "server_terminal_record",
      recordId: "turn-1",
    });
    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it("consumes sandbox configuration turn failures instead of retrying delivery", async () => {
    const fake = new FakeAppServerClient();
    const token = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext();
    const message = makeMessage("m1", "first");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    failTurn(fake, "turn-1", {
      message: "sandbox rejected the request",
      codexErrorInfo: "sandboxError",
    });
    await startPromise;

    expect(token.complete).toHaveBeenCalledWith([message], {
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "provider_configuration_error",
    });
    expect(token.retry).not.toHaveBeenCalled();
    expect(token.terminalRejected).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it("terminal-rejects stderr-only remote compact context-window failures", async () => {
    const fake = new FakeAppServerClient();
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const token = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext({ retryTurn });
    const message = makeMessage("m1", "first");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    fake.close(
      "codex app-server exited signal SIGTERM. stderr: Failed to run pre-sampling compact\n" +
        "Error running remote compact task: Codex ran out of room in the model's context window.",
    );
    await startPromise;

    expect(token.terminalRejected).toHaveBeenCalledWith([message], "codex_context_window_exceeded", {
      kind: "server_terminal_record",
      recordId: "turn-1",
    });
    expect(token.retry).not.toHaveBeenCalled();
    expect(retryTurn).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it("uses prior sdk compact errors to classify a later compact transport close", async () => {
    const fake = new FakeAppServerClient();
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const token = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext({ retryTurn });
    const message = makeMessage("m1", "first");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    fake.emit("error", {
      threadId: "thread-app-server",
      turnId: "turn-1",
      error: {
        message:
          "Error running remote compact task: Codex ran out of room in the model's context window. Start a new thread.",
        codexErrorInfo: null,
        additionalDetails: null,
      },
    });
    fake.close("codex app-server exited signal SIGTERM. stderr: Failed to run pre-sampling compact");
    await startPromise;

    expect(token.terminalRejected).toHaveBeenCalledWith([message], "codex_context_window_exceeded", {
      kind: "server_terminal_record",
      recordId: "turn-1",
    });
    expect(token.retry).not.toHaveBeenCalled();
    expect(retryTurn).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it("terminal-rejects completed empty turns when stderr reports pre-sampling compact failure", async () => {
    const fake = new FakeAppServerClient();
    fake.stderr = "2026-06-22T03:02:58Z ERROR codex_core::session::turn: Failed to run pre-sampling compact";
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const finishTurn = vi.fn<SessionContext["finishTurn"]>();
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const token = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext({ retryTurn, finishTurn, emitEvent });
    const message = makeMessage("m1", "first");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    completeEmptyTurn(fake, "turn-1");
    await startPromise;

    expect(token.terminalRejected).toHaveBeenCalledWith([message], "codex_compact_failure", {
      kind: "server_terminal_record",
      recordId: "turn-1",
    });
    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).not.toHaveBeenCalled();
    expect(retryTurn).not.toHaveBeenCalled();
    expect(finishTurn).not.toHaveBeenCalled();
    expect(
      emitEvent.mock.calls.some(
        ([event]) =>
          event.kind === "error" &&
          event.payload.source === "sdk" &&
          event.payload.message.includes("failed to compact this thread"),
      ),
    ).toBe(true);

    await handler.shutdown();
  });

  it("keeps completed empty turns without compact diagnostics as successful silence", async () => {
    const fake = new FakeAppServerClient();
    fake.stderr = "ordinary app-server diagnostic without compact failure";
    const token = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext();
    const message = makeMessage("m1", "first");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    completeEmptyTurn(fake, "turn-1");
    await startPromise;

    expect(token.complete).toHaveBeenCalledWith([message], { status: "success", terminal: true });
    expect(token.terminalRejected).not.toHaveBeenCalled();
    expect(token.retry).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it("does not classify normal app-server assistant text that mentions provider error keywords", async () => {
    const fake = new FakeAppServerClient();
    const token = makeDeliveryToken();
    const emitEvent = vi.fn<(event: SessionEvent) => void>();
    const handler = makeHandler(fake);
    const ctx = makeContext({ emitEvent });
    const message = makeMessage("m1", "first");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    completeTurn(fake, "turn-1", "Normal answer mentioning 401 Unauthorized and context window.");
    await startPromise;

    expect(token.complete).toHaveBeenCalledWith([message], { status: "success", terminal: true });
    expect(token.retry).not.toHaveBeenCalled();
    expect(token.terminalRejected).not.toHaveBeenCalled();
    expect(emitEvent.mock.calls.some(([event]) => event.kind === "error" && event.payload.source === "runtime")).toBe(
      false,
    );

    await handler.shutdown();
  });

  it("keeps transient app-server turn failures retryable", async () => {
    const fake = new FakeAppServerClient();
    const token = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext();
    const message = makeMessage("m1", "first");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    failTurn(fake, "turn-1", {
      message: "server overloaded",
      codexErrorInfo: "serverOverloaded",
    });
    await startPromise;

    expect(token.retry).toHaveBeenCalledWith([message], "codex_transient_failure");
    expect(token.terminalRejected).not.toHaveBeenCalled();
    expect(token.complete).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it.each([
    "httpConnectionFailed",
    "responseStreamConnectionFailed",
    "responseStreamDisconnected",
  ])("keeps structured transient %s turn failures retryable", async (key) => {
    const fake = new FakeAppServerClient();
    const token = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext();
    const message = makeMessage("m1", "first");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    failTurn(fake, "turn-1", {
      message: `${key} while streaming`,
      codexErrorInfo: { [key]: true },
    });
    await startPromise;

    expect(token.retry).toHaveBeenCalledWith([message], "codex_transient_failure");
    expect(token.terminalRejected).not.toHaveBeenCalled();
    expect(token.complete).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it("consumes accepted-turn capacity wait stops instead of terminal-rejecting them", async () => {
    const fake = new FakeAppServerClient();
    const token = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext();
    const message = makeMessage("m1", "first");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    failTurn(fake, "turn-1", { message: "rate limit exceeded; retry later" });
    await startPromise;

    expect(token.complete).toHaveBeenCalledWith([message], {
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "capacity_wait_required",
    });
    expect(token.terminalRejected).not.toHaveBeenCalled();
    expect(token.retry).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it("retries visible provider capacity failures twice, then exhausts and consumes once", async () => {
    const fake = new FakeAppServerClient();
    const token = makeDeliveryToken();
    const handler = makeHandler(fake);
    const settlementOrder: string[] = [];
    const emitEvent = vi.fn<(event: SessionEvent) => void>((event) => {
      if (event.kind !== "error") return;
      const payload = parseProviderRetryEventMessage(event.payload.message);
      if (payload) settlementOrder.push(payload.event);
    });
    token.complete = vi.fn<DeliveryToken["complete"]>(async () => {
      settlementOrder.push("complete");
    });
    const ctx = makeContext({ emitEvent });
    const message = makeMessage("m1", "first");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));
    vi.useFakeTimers();

    const failCapacityAttempt = (turnId: string, visible: boolean): void => {
      if (visible) {
        fake.emit("item/completed", {
          threadId: "thread-app-server",
          turnId,
          item: {
            type: "fileChange",
            id: `file-${turnId}`,
            status: "completed",
            changes: [{ path: "src/changed.ts" }],
          },
        });
      }
      failTurn(fake, turnId, { message: "Selected model is at capacity. Please try a different model." });
    };

    failCapacityAttempt("turn-1", true);
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.turnCounter).toBe(2);

    failCapacityAttempt("turn-2", false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(fake.turnCounter).toBe(3);

    failCapacityAttempt("turn-3", false);
    await startPromise;

    expect(settlementOrder).toEqual([
      "provider_retry_scheduled",
      "provider_retry_scheduled",
      "provider_retry_exhausted",
      "complete",
    ]);
    expect(token.complete).toHaveBeenCalledTimes(1);
    expect(token.complete).toHaveBeenCalledWith([message], {
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "provider_retry_exhausted",
    });
    expect(token.terminalRejected).not.toHaveBeenCalled();
    expect(token.retry).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it("fences an injected tail during provider retry backoff until the retry turn starts", async () => {
    const fake = new FakeAppServerClient();
    const token = makeDeliveryToken();
    const tailToken = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext();
    const message = makeMessage("m1", "first");
    const tail = makeMessage("m2", "second");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.turnCounter === 1);
    vi.useFakeTimers();

    fake.emit("item/completed", {
      threadId: "thread-app-server",
      turnId: "turn-1",
      item: {
        type: "fileChange",
        id: "file-turn-1",
        status: "completed",
        changes: [{ path: "src/changed.ts" }],
      },
    });
    failTurn(fake, "turn-1", { message: "Selected model is at capacity. Please try a different model." });
    fake.deferNextSteer();
    expect(handler.inject(tail, tailToken)).toEqual({ kind: "owned", mode: "queued" });

    await vi.advanceTimersByTimeAsync(499);
    expect(fake.turnCounter).toBe(1);
    expect(fake.requests.filter((request) => request.method === "turn/steer")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(fake.turnCounter).toBe(2);
    await vi.runOnlyPendingTimersAsync();
    expect(fake.requests.filter((request) => request.method === "turn/steer")).toHaveLength(1);

    fake.resolveSteer({ turnId: "turn-2" });
    await vi.advanceTimersByTimeAsync(0);
    completeTurn(fake, "turn-2", "done");
    await startPromise;

    expect(token.complete).toHaveBeenCalledWith([message, tail], { status: "success", terminal: true });
    expect(token.retry).not.toHaveBeenCalled();
    expect(tailToken.retry).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it.each([
    "success",
    "exhausted",
  ] as const)("carries a successfully steered tail into the provider retry %s settlement", async (outcome) => {
    const fake = new FakeAppServerClient();
    const token = makeDeliveryToken();
    const tailToken = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext();
    const message = makeMessage("m1", "first");
    const tail = makeMessage("m2", "second");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.turnCounter === 1);

    expect(handler.inject(tail, tailToken)).toEqual({ kind: "owned", mode: "queued" });
    await waitFor(() => fake.requests.some((request) => request.method === "turn/steer"));
    await flushAsync();
    vi.useFakeTimers();

    fake.emit("item/completed", {
      threadId: "thread-app-server",
      turnId: "turn-1",
      item: {
        type: "fileChange",
        id: "file-turn-1",
        status: "completed",
        changes: [{ path: "src/changed.ts" }],
      },
    });
    failTurn(fake, "turn-1", { message: "Selected model is at capacity. Please try a different model." });

    await vi.advanceTimersByTimeAsync(500);
    expect(fake.turnCounter).toBe(2);
    if (outcome === "success") {
      completeTurn(fake, "turn-2", "done");
    } else {
      failTurn(fake, "turn-2", { message: "Selected model is at capacity. Please try a different model." });
      await vi.advanceTimersByTimeAsync(1500);
      expect(fake.turnCounter).toBe(3);
      failTurn(fake, "turn-3", { message: "Selected model is at capacity. Please try a different model." });
    }
    await startPromise;

    expect(token.complete).toHaveBeenCalledWith(
      [message, tail],
      outcome === "success"
        ? { status: "success", terminal: true }
        : {
            status: "error",
            terminal: true,
            completion: "consumed",
            reason: "provider_retry_exhausted",
          },
    );
    expect(token.retry).not.toHaveBeenCalled();
    expect(tailToken.retry).not.toHaveBeenCalled();
    expect(tailToken.complete).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it("does not classify ordinary transport close text as deterministic", async () => {
    const fake = new FakeAppServerClient();
    const token = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext();
    const message = makeMessage("m1", "first");

    const startPromise = handler.start(message, ctx, token);
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    fake.close("transport is closed");
    await startPromise;

    expect(token.retry).toHaveBeenCalledWith([message], "codex_unknown_failure");
    expect(token.terminalRejected).not.toHaveBeenCalled();
    expect(token.complete).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it("consumes pre-turn 401 credential failures instead of retrying turn/start", async () => {
    const fake = new FakeAppServerClient();
    fake.turnStartError = new Error(
      "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
    );
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const failSessionForRecovery = vi.fn<(reason: string, sessionId?: string) => void>();
    const token = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext({ retryTurn, failSessionForRecovery });
    const message = makeMessage("m1", "first");

    await handler.start(message, ctx, token);

    expect(token.complete).toHaveBeenCalledWith([message], {
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "provider_credential_required",
    });
    expect(token.retry).not.toHaveBeenCalled();
    expect(token.terminalRejected).not.toHaveBeenCalled();
    expect(retryTurn).not.toHaveBeenCalled();
    expect(failSessionForRecovery).toHaveBeenCalledWith("provider_credential_required", "thread-app-server");
    expect(fake.isClosed).toBe(true);

    await handler.shutdown();
  });

  it("consumes pre-turn compact context-window failures instead of retrying turn/start", async () => {
    const fake = new FakeAppServerClient();
    fake.turnStartError = new Error(
      "Error running remote compact task: Codex ran out of room in the model's context window. Start a new thread.",
    );
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const failSessionForRecovery = vi.fn<(reason: string, sessionId?: string) => void>();
    const token = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext({ retryTurn, failSessionForRecovery });
    const message = makeMessage("m1", "first");

    await handler.start(message, ctx, token);

    expect(token.complete).toHaveBeenCalledWith([message], {
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "codex_context_window_exceeded",
    });
    expect(token.retry).not.toHaveBeenCalled();
    expect(token.terminalRejected).not.toHaveBeenCalled();
    expect(retryTurn).not.toHaveBeenCalled();
    expect(failSessionForRecovery).toHaveBeenCalledWith("codex_context_window_exceeded", "thread-app-server");
    expect(fake.isClosed).toBe(true);

    await handler.shutdown();
  });

  it("uses pre-currentTurn turnId error notifications when later turn/start rejects", async () => {
    const fake = new FakeAppServerClient();
    fake.turnStartError = new CodexAppServerTransportError("codex app-server request timed out: turn/start");
    fake.beforeTurnStartError = () => {
      fake.emit("error", {
        threadId: "thread-app-server",
        turnId: "turn-before-rpc",
        error: {
          message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
          codexErrorInfo: null,
          additionalDetails: null,
        },
      });
    };
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const failSessionForRecovery = vi.fn<(reason: string, sessionId?: string) => void>();
    const token = makeDeliveryToken();
    const handler = makeHandler(fake);
    const ctx = makeContext({ retryTurn, failSessionForRecovery });
    const message = makeMessage("m1", "first");

    await handler.start(message, ctx, token);

    expect(token.complete).toHaveBeenCalledWith([message], {
      status: "error",
      terminal: true,
      completion: "consumed",
      reason: "provider_credential_required",
    });
    expect(token.retry).not.toHaveBeenCalled();
    expect(retryTurn).not.toHaveBeenCalled();
    expect(failSessionForRecovery).toHaveBeenCalledWith("provider_credential_required", "thread-app-server");

    await handler.shutdown();
  });

  it("retries accepted messages when app-server crashes before turn terminal", async () => {
    const fake = new FakeAppServerClient();
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const finishTurn = vi.fn<SessionContext["finishTurn"]>();
    const handler = makeHandler(fake);
    const ctx = makeContext({ retryTurn, finishTurn });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));
    handler.inject(makeMessage("m2", "second"), deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/steer"));

    fake.close();
    await startPromise;

    expect(finishTurn).not.toHaveBeenCalled();
    expect(retryTurn).toHaveBeenCalledWith(
      [makeMessage("m1", "first"), makeMessage("m2", "second")],
      "codex_unknown_failure",
    );

    await handler.shutdown();
  });

  it("closes app-server and retries the batch when turn/start times out after sending input", async () => {
    const fake = new FakeAppServerClient();
    fake.turnStartError = new CodexAppServerTransportError("codex app-server request timed out: turn/start");
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const failSessionForRecovery = vi.fn<(reason: string, sessionId?: string) => void>();
    const finishTurn = vi.fn<SessionContext["finishTurn"]>();
    const sendMessage = vi
      .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const handler = makeHandler(fake);
    const ctx = makeContext({ retryTurn, finishTurn, failSessionForRecovery, sendMessage });

    await handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));

    expect(fake.isClosed).toBe(true);
    expect(retryTurn).toHaveBeenCalledWith(
      [makeMessage("m1", "first")],
      "codex_app_server_turn_start_unknown_custody_transient",
    );
    expect(failSessionForRecovery).toHaveBeenCalledWith(
      "codex_app_server_turn_start_unknown_custody_transient",
      "thread-app-server",
    );
    expect(finishTurn).not.toHaveBeenCalled();

    completeTurn(fake, "turn-1", "late final");
    await flushAsync();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(finishTurn).not.toHaveBeenCalled();

    await handler.shutdown();
  });

  it("closes app-server and retries accepted plus injected messages when turn/steer times out", async () => {
    const fake = new FakeAppServerClient();
    fake.steerError = new CodexAppServerTransportError("codex app-server request timed out: turn/steer");
    const retryTurn = vi.fn<SessionContext["retryTurn"]>();
    const failSessionForRecovery = vi.fn<(reason: string, sessionId?: string) => void>();
    const finishTurn = vi.fn<SessionContext["finishTurn"]>();
    const sendMessage = vi
      .fn<(chatId: string, body: Record<string, unknown>) => Promise<unknown>>()
      .mockResolvedValue(undefined);
    const handler = makeHandler(fake);
    const ctx = makeContext({ retryTurn, finishTurn, failSessionForRecovery, sendMessage });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));
    handler.inject(makeMessage("m2", "second"), deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/steer"));
    await startPromise;

    expect(fake.isClosed).toBe(true);
    expect(retryTurn).toHaveBeenCalledWith(
      [makeMessage("m1", "first"), makeMessage("m2", "second")],
      "codex_app_server_steer_unknown_custody_transient",
    );
    expect(failSessionForRecovery).toHaveBeenCalledWith(
      "codex_app_server_steer_unknown_custody_transient",
      "thread-app-server",
    );
    expect(finishTurn).not.toHaveBeenCalled();

    completeTurn(fake, "turn-1", "late final");
    await flushAsync();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(finishTurn).not.toHaveBeenCalled();

    await handler.shutdown();
  });
});

describe("codex app-server briefing-update notice", () => {
  it("prepends a re-read notice on resume when the session has no recorded briefing baseline", async () => {
    const fake = new FakeAppServerClient();
    const handler = makeHandler(fake);
    const ctx = makeContext({ finishTurn: async () => {} });

    const resumePromise = handler.resume(
      makeMessage("m1", "hello"),
      "thread-app-server",
      ctx,
      deliveryTokenFromSessionContext(ctx),
    );
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    const start = fake.requests.find((request) => request.method === "turn/start");
    const input = JSON.stringify(start?.params ?? {});
    expect(input).toContain("<system-reminder>");
    expect(input).toContain("re-read");

    completeTurn(fake, "turn-1", "ok");
    await resumePromise;
    await handler.shutdown();
  });

  it("prepends the same provider-neutral runtime contract onto every turn input (immediate-tail salience)", async () => {
    // Codex has no persistent system-prompt channel (unlike the Claude path's
    // `systemPrompt.append`), so the same runtime contract both providers get
    // must ride every Codex turn input — keeping the console/outbox boundary
    // next to where a "discuss only / hold off" instruction lands. Without this
    // the rule lives only in the thread-init AGENTS read and loses salience.
    const fake = new FakeAppServerClient();
    const handler = makeHandler(fake);
    const ctx = makeContext({ finishTurn: async () => {} });

    const startPromise = handler.start(
      makeMessage("m1", "先讨论下，不动手"),
      ctx,
      deliveryTokenFromSessionContext(ctx),
    );
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));

    const start = fake.requests.find((request) => request.method === "turn/start");
    const input = JSON.stringify(start?.params ?? {});
    expect(input).toContain("first-tree-runtime-contract");
    expect(input).toContain("running the chat CLI as a command-line tool");

    completeTurn(fake, "turn-1", "ok");
    await startPromise;
    await handler.shutdown();
  });

  it("adds no notice when the briefing is unchanged since the session last ran a turn", async () => {
    // First session start seeds the briefing baseline for this thread id at the
    // shared agent home (keyed off `workspaceRoot`).
    const startFake = new FakeAppServerClient();
    const startHandler = makeHandler(startFake);
    const startCtx = makeContext({ finishTurn: async () => {} });
    const startPromise = startHandler.start(
      makeMessage("m1", "first"),
      startCtx,
      deliveryTokenFromSessionContext(startCtx),
    );
    await waitFor(() => startFake.requests.some((request) => request.method === "turn/start"));
    completeTurn(startFake, "turn-1", "first answer");
    await startPromise;
    await startHandler.shutdown();

    // A later resume of the same thread, same config (briefing unchanged) →
    // baseline matches → no re-read notice.
    const resumeFake = new FakeAppServerClient();
    const resumeHandler = makeHandler(resumeFake);
    const resumeCtx = makeContext({ finishTurn: async () => {} });
    const resumePromise = resumeHandler.resume(
      makeMessage("m2", "again"),
      "thread-app-server",
      resumeCtx,
      deliveryTokenFromSessionContext(resumeCtx),
    );
    await waitFor(() => resumeFake.requests.some((request) => request.method === "turn/start"));

    const start = resumeFake.requests.find((request) => request.method === "turn/start");
    expect(JSON.stringify(start?.params ?? {})).not.toContain("<system-reminder>");

    completeTurn(resumeFake, "turn-1", "second answer");
    await resumePromise;
    await resumeHandler.shutdown();
  });

  it("keeps the notice for the next resume when the turn fails before reaching the provider", async () => {
    // First resume hits a pre-provider turn/start failure: the notice was
    // consumed for that attempt but the model never saw it, so the baseline
    // must NOT advance.
    const failFake = new FakeAppServerClient();
    failFake.turnStartError = new CodexAppServerTransportError("codex app-server request timed out: turn/start");
    const failHandler = makeHandler(failFake);
    const failCtx = makeContext({ failSessionForRecovery: vi.fn(), finishTurn: async () => {} });
    await failHandler.resume(
      makeMessage("m1", "hello"),
      "thread-app-server",
      failCtx,
      deliveryTokenFromSessionContext(failCtx),
    );
    expect(failFake.requests.some((request) => request.method === "turn/start")).toBe(true);
    await failHandler.shutdown();

    // Second resume of the same thread: baseline was never recorded, so the
    // briefing still reads as changed and the re-read notice reappears.
    const okFake = new FakeAppServerClient();
    const okHandler = makeHandler(okFake);
    const okCtx = makeContext({ finishTurn: async () => {} });
    const resumePromise = okHandler.resume(
      makeMessage("m2", "again"),
      "thread-app-server",
      okCtx,
      deliveryTokenFromSessionContext(okCtx),
    );
    await waitFor(() => okFake.requests.some((request) => request.method === "turn/start"));
    const start = okFake.requests.find((request) => request.method === "turn/start");
    expect(JSON.stringify(start?.params ?? {})).toContain("<system-reminder>");

    completeTurn(okFake, "turn-1", "ok");
    await resumePromise;
    await okHandler.shutdown();
  });

  it("prepends the notice on an injected turn when the prompt changed mid active session (no resume)", async () => {
    const { cache, setAppend } = makeMutableConfigCache("BEFORE_MARKER");
    const fake = new FakeAppServerClient();
    const handler = makeHandler(fake, { agentConfigCache: cache });
    const ctx = makeContext({ finishTurn: async () => {} });

    // Start the session and finish its first turn (seeds the briefing baseline
    // for the BEFORE prompt). Session is now idle/active.
    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));
    completeTurn(fake, "turn-1", "first answer");
    await startPromise;
    const startTurns = fake.requests.filter((request) => request.method === "turn/start").length;

    // Admin changes the prompt mid-session, then a message arrives — no
    // suspend/resume. The injected turn must pick up the new briefing and carry
    // the re-read notice.
    setAppend("AFTER_MARKER");
    handler.inject(makeMessage("m2", "again"), deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.filter((request) => request.method === "turn/start").length === startTurns + 1);

    const injectedStart = fake.requests.filter((request) => request.method === "turn/start")[startTurns];
    expect(JSON.stringify(injectedStart?.params ?? {})).toContain("<system-reminder>");

    completeTurn(fake, "turn-2", "second answer");
    await handler.shutdown();
  });

  it("still delivers the injected message when the active-session briefing rewrite throws", async () => {
    const { cache, setAppend } = makeMutableConfigCache("BEFORE_MARKER");
    const fake = new FakeAppServerClient();
    const handler = makeHandler(fake, { agentConfigCache: cache });
    const ctx = makeContext({ finishTurn: async () => {} });

    const startPromise = handler.start(makeMessage("m1", "first"), ctx, deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.some((request) => request.method === "turn/start"));
    completeTurn(fake, "turn-1", "first answer");
    await startPromise;
    const startTurns = fake.requests.filter((request) => request.method === "turn/start").length;

    // Prompt changes; the active-turn briefing rewrite throws (e.g. disk error).
    // The batch was already dequeued, so the message must still reach turn/start
    // rather than being stranded.
    setAppend("AFTER_MARKER");
    vi.mocked(writeAgentBriefing).mockImplementationOnce(() => {
      throw new Error("simulated disk failure");
    });
    handler.inject(makeMessage("m2", "again"), deliveryTokenFromSessionContext(ctx));
    await waitFor(() => fake.requests.filter((request) => request.method === "turn/start").length === startTurns + 1);

    completeTurn(fake, "turn-2", "second answer");
    await handler.shutdown();
  });
});
