import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeConfig } from "@first-tree/shared";
import { parseProviderRetryEventMessage } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../../__tests__/_logger-helpers.js";
import { mockEntry } from "../../../__tests__/test-helpers.js";
import type { FirstTreeHubSDK } from "../../../cloud/sdk.js";
import type { AgentConfigCache } from "../../../runtime/agent-config-cache.js";
import type { DeliveryToken, SessionContext, SessionMessage } from "../../../runtime/handler.js";
import { ManagedSkillsUnsafeDiscoveryError, reconcileManagedSkillsForConfig } from "../../../runtime/managed-skills.js";
import type { ProviderProcessSpec, ProviderProcessSupervisor } from "../../../runtime/provider-process-supervisor.js";
import { readSessionBriefingFingerprint } from "../../../runtime/session-briefing-fingerprint.js";
import { SessionRuntime } from "../../../runtime/session-runtime.js";
import {
  buildOpenCodeConfigContent,
  buildOpenCodeTurnArgs,
  clearOpenCodeDbGateCacheForTests,
  createOpenCodeHandler,
  mapOpenCodeMcpServers,
  openCodeProviderAttemptWindowSizeForTests,
  projectOpenCodeConfig,
  stableOpenCodeScope,
} from "../index.js";
import { acquireOpenCodePrivateConfigLease } from "../private-config.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  resetManagedSkillsReconcileMock();
  clearOpenCodeDbGateCacheForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runtimeConfig(): AgentRuntimeConfig {
  return {
    agentId: "agent-1",
    version: 1,
    payload: {
      kind: "opencode",
      prompt: { append: "managed prompt" },
      model: "openai/gpt-test",
      mcpServers: [{ name: "repo", transport: "stdio", command: "mcp-bin", args: ["--stdio"] }],
      env: [{ key: "PROVIDER_ENV", value: "local", sensitive: true }],
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

function message(id: string, content: string): SessionMessage {
  return {
    inboxEntryId: 1,
    id,
    chatId: "chat-1",
    senderId: "human-1",
    format: "text",
    content,
    metadata: null,
  };
}

function successfulTurn(sessionId = "ses_new", text = "ok"): string {
  return [
    JSON.stringify({ type: "step_start", sessionID: sessionId, part: { sessionID: sessionId } }),
    JSON.stringify({ type: "text", sessionID: sessionId, part: { text } }),
    JSON.stringify({ type: "step_finish", sessionID: sessionId, part: { reason: "stop" } }),
  ].join("\n");
}

function deliveryToken() {
  return {
    processingStarted: vi.fn(),
    complete: vi.fn(async () => {}),
    retry: vi.fn(),
    terminalRejected: vi.fn(async () => {}),
  } satisfies DeliveryToken;
}

function reconciledSkillsResult(resourceConfigVersion = 1) {
  return {
    ok: true,
    resourceConfigVersion,
    installed: [],
    skipped: [],
    removed: [],
    teamSkills: [],
    teamSkillCommands: [],
    failures: [],
    staleTeamSnapshot: false,
  };
}

function resetManagedSkillsReconcileMock() {
  const reconcile = vi.mocked(reconcileManagedSkillsForConfig);
  reconcile.mockReset();
  reconcile.mockImplementation(async (_workspace, _provider, _roots, config) =>
    reconciledSkillsResult(config?.version ?? 0),
  );
  return reconcile;
}

function controlledOpenCodeSleep() {
  const waits: Array<{
    delayMs: number;
    signal: AbortSignal;
    complete: () => void;
  }> = [];
  const sleep = vi.fn(
    (delayMs: number, signal: AbortSignal) =>
      new Promise<boolean>((resolveDelay) => {
        let settled = false;
        const finish = (completed: boolean) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolveDelay(completed);
        };
        const onAbort = () => finish(false);
        signal.addEventListener("abort", onAbort, { once: true });
        waits.push({ delayMs, signal, complete: () => finish(true) });
      }),
  );
  return { sleep, waits };
}

const SYNTHETIC_PROVIDER_SCRIPT = `
const kind = process.env.FIRST_TREE_TEST_PROVIDER_KIND;
if (kind === "version") {
  process.stdout.write(process.env.FIRST_TREE_TEST_PROVIDER_VERSION ?? "");
} else if (kind === "db") {
  process.stdout.write('[{"ready":1}]\\n');
} else {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
  });
  process.stdin.on("end", () => {
    setTimeout(() => {
      const sid = process.env.FIRST_TREE_TEST_PROVIDER_SESSION_ID ?? "ses_new";
      process.stdout.write(JSON.stringify({type:"step_start",sessionID:sid,part:{sessionID:sid}}) + "\\n");
      process.stdout.write(JSON.stringify({type:"text",sessionID:sid,part:{text:input.trim()}}) + "\\n");
      process.stdout.write(JSON.stringify({type:"step_finish",sessionID:sid,part:{reason:"stop",tokens:{input:3,output:2}}}) + "\\n");
    }, Number(process.env.FIRST_TREE_TEST_PROVIDER_DELAY_MS ?? "0"));
  });
}
`;

const PROTOCOL_PROVIDER_SCRIPT = `
process.stdin.resume();
process.stdin.on("end", () => {
  const encoded = process.env.FIRST_TREE_TEST_PROVIDER_OUTPUT_BASE64 ?? "";
  process.stdout.write(Buffer.from(encoded, "base64").toString("utf8"));
  if (process.env.FIRST_TREE_TEST_PROVIDER_TRAP_SIGTERM === "1") {
    process.on("SIGTERM", () => {});
  }
  if (process.env.FIRST_TREE_TEST_PROVIDER_HOLD_OPEN === "1") {
    const holdMs = Number(process.env.FIRST_TREE_TEST_PROVIDER_HOLD_MS ?? "0");
    if (holdMs > 0) {
      setTimeout(() => process.exit(0), holdMs);
    } else {
      setInterval(() => {}, 1000);
    }
  }
});
`;

function createSyntheticSupervisor(
  specs: ProviderProcessSpec[],
  options: { version?: string; turnDelayMs?: number; capturedInputs?: string[] } = {},
): ProviderProcessSupervisor {
  return {
    spawn(spec) {
      specs.push(spec);
      const isDb = spec.args[0] === "db";
      const isVersion = spec.args[0] === "--version";
      const resumed = spec.args.includes("--session") ? spec.args[spec.args.indexOf("--session") + 1] : "ses_new";
      const child = spawn(process.execPath, ["-e", SYNTHETIC_PROVIDER_SCRIPT], {
        ...spec.options,
        env: {
          ...spec.options.env,
          FIRST_TREE_TEST_PROVIDER_KIND: isVersion ? "version" : isDb ? "db" : "turn",
          FIRST_TREE_TEST_PROVIDER_VERSION: `${options.version ?? "1.18.7"}\n`,
          FIRST_TREE_TEST_PROVIDER_SESSION_ID: resumed,
          FIRST_TREE_TEST_PROVIDER_DELAY_MS: String(options.turnDelayMs ?? 0),
        },
        detached: false,
      });
      if (!isDb && !isVersion && child.stdin && options.capturedInputs) {
        const stdin = child.stdin;
        const write = stdin.write.bind(stdin);
        stdin.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
          options.capturedInputs?.push(String(chunk));
          return Reflect.apply(write, stdin, [chunk, ...args]);
        }) as typeof stdin.write;
      }
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      return { child, exited };
    },
  };
}

type ProtocolTurnSpec = {
  output: string;
  holdOpen?: boolean;
  holdMs?: number;
  trapSigterm?: boolean;
};

function createProtocolSupervisor(
  specs: ProviderProcessSpec[],
  turnOutputs: string[],
  capturedInputs: string[] = [],
  holdOpen = false,
): ProviderProcessSupervisor {
  return createProtocolTurnSupervisor(
    specs,
    turnOutputs.map((output) => ({ output, holdOpen })),
    capturedInputs,
  );
}

function createProtocolTurnSupervisor(
  specs: ProviderProcessSpec[],
  turns: ProtocolTurnSpec[],
  capturedInputs: string[] = [],
): ProviderProcessSupervisor {
  let turn = 0;
  return {
    spawn(spec) {
      specs.push(spec);
      if (spec.args[0] === "--version") {
        const child = spawn(process.execPath, ["-e", PROTOCOL_PROVIDER_SCRIPT], {
          ...spec.options,
          env: {
            ...spec.options.env,
            FIRST_TREE_TEST_PROVIDER_OUTPUT_BASE64: Buffer.from("1.18.9\n", "utf8").toString("base64"),
            FIRST_TREE_TEST_PROVIDER_HOLD_OPEN: "0",
          },
        });
        return { child, exited: new Promise<void>((resolve) => child.once("exit", () => resolve())) };
      }
      if (spec.args[0] === "db") {
        const child = spawn(process.execPath, ["-e", PROTOCOL_PROVIDER_SCRIPT], {
          ...spec.options,
          env: {
            ...spec.options.env,
            FIRST_TREE_TEST_PROVIDER_OUTPUT_BASE64: Buffer.from('[{"ready":1}]\n', "utf8").toString("base64"),
            FIRST_TREE_TEST_PROVIDER_HOLD_OPEN: "0",
          },
        });
        return { child, exited: new Promise<void>((resolve) => child.once("exit", () => resolve())) };
      }
      const turnSpec = turns[turn++] ?? { output: "" };
      const holdOpen = Boolean(turnSpec.holdOpen);
      const child = spawn(process.execPath, ["-e", PROTOCOL_PROVIDER_SCRIPT], {
        ...spec.options,
        env: {
          ...spec.options.env,
          FIRST_TREE_TEST_PROVIDER_OUTPUT_BASE64: Buffer.from(turnSpec.output, "utf8").toString("base64"),
          FIRST_TREE_TEST_PROVIDER_HOLD_OPEN: holdOpen ? "1" : "0",
          FIRST_TREE_TEST_PROVIDER_TRAP_SIGTERM: turnSpec.trapSigterm ? "1" : "0",
          FIRST_TREE_TEST_PROVIDER_HOLD_MS: String(turnSpec.holdMs ?? 0),
        },
        detached: holdOpen,
      });
      if (child.stdin) {
        const write = child.stdin.write.bind(child.stdin);
        child.stdin.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
          capturedInputs.push(String(chunk));
          return Reflect.apply(write, child.stdin, [chunk, ...args]);
        }) as typeof child.stdin.write;
      }
      return { child, exited: new Promise<void>((resolve) => child.once("exit", () => resolve())) };
    },
  };
}

function createSupersedeProtocolSupervisor(
  specs: ProviderProcessSpec[],
  partialOutput: string,
  successOutput: string,
  options: { trapPartialSigterm?: boolean; partialHoldMs?: number } = {},
): ProviderProcessSupervisor {
  return createProtocolTurnSupervisor(specs, [
    { output: successOutput },
    {
      output: partialOutput,
      holdOpen: true,
      trapSigterm: options.trapPartialSigterm,
      holdMs: options.partialHoldMs,
    },
    { output: successOutput },
  ]);
}

function context(
  events: unknown[],
  forwarded: string[],
  identity: { agentId?: string; chatId?: string } = {},
): SessionContext {
  const agentId = identity.agentId ?? "agent-1";
  const chatId = identity.chatId ?? "chat-1";
  return {
    agent: {
      agentId,
      inboxId: "inbox-1",
      displayName: "Agent",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    sdk: {
      serverUrl: "https://example.test",
      getChatDetail: async () => ({
        id: "chat-1",
        title: "OpenCode test",
        topic: "OpenCode",
        description: null,
      }),
      listChatParticipants: async () => [
        {
          agentId: "human-1",
          name: "human",
          displayName: "Human",
          type: "human",
          role: "member",
          mode: "default",
          accessMode: "speaker",
        },
      ],
    } as unknown as SessionContext["sdk"],
    log: vi.fn(),
    chatId,
    recordProviderActivity: vi.fn(),
    noteTurnStart: vi.fn(),
    emitEvent: (event) => events.push(event),
    forwardResult: async (text) => {
      forwarded.push(text);
    },
    markMessagesConsumed: vi.fn(),
    finishTurn: vi.fn(async () => {}),
    retryTurn: vi.fn(),
    failSessionForRecovery: vi.fn(),
    buildAgentEnv: (env) => ({
      ...env,
      FIRST_TREE_AGENT_ID: agentId,
      FIRST_TREE_CHAT_ID: chatId,
      FIRST_TREE_PROVIDER: "opencode",
      FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE: "/private/token",
    }),
    formatInboundContent: async (entry) => `[From: human]\n${String(entry.content)}`,
    resolveSenderLabel: async () => "human",
    formatFromHeader: async () => "[From: human]",
    publishTeamSkillCommands: () => {},
  };
}

describe("OpenCode V1 handler", () => {
  it("passes an SDK-backed Team Skill bundle resolver to every projection refresh", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-team-skill-resolver-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const bytes = Buffer.from("bundle bytes");
    const fetchAttachment = vi.fn(async () => ({
      bytes,
      mimeType: "application/zip",
      filename: "review.zip",
      size: bytes.byteLength,
    }));
    const sessionCtx = context([], []);
    sessionCtx.sdk.fetchAttachment = fetchAttachment;
    const reconcile = vi.mocked(reconcileManagedSkillsForConfig);
    reconcile.mockClear();
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
      opencodeTurnTimeoutMs: 5_000,
    });

    await handler.start(message("m-team-skill", "use the complete skill"), sessionCtx, deliveryToken());

    expect(reconcile).toHaveBeenCalledTimes(2);
    const resolver = reconcile.mock.calls[0]?.[5];
    expect(resolver).toBeTypeOf("function");
    await expect(
      resolver?.({
        attachmentId: "11111111-1111-4111-8111-111111111111",
        format: "zip",
        sizeBytes: bytes.byteLength,
      }),
    ).resolves.toEqual(bytes);
    expect(fetchAttachment).toHaveBeenCalledWith({ id: "11111111-1111-4111-8111-111111111111" });
    await handler.shutdown();
  });

  it("retries unsafe managed-skill discovery before starting the provider turn", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-managed-skills-unsafe-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const sessionCtx = context([], []);
    const token = deliveryToken();
    const reconcile = vi.mocked(reconcileManagedSkillsForConfig);
    reconcile.mockClear();
    reconcile
      .mockResolvedValueOnce(reconciledSkillsResult())
      .mockRejectedValueOnce(new ManagedSkillsUnsafeDiscoveryError("unsafe discovery"));
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
      opencodeTurnTimeoutMs: 5_000,
    });

    await handler.start(message("m-unsafe-skill", "must not reach OpenCode"), sessionCtx, token);

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(specs).toEqual([]);
    expect(token.processingStarted).not.toHaveBeenCalled();
    expect(token.complete).not.toHaveBeenCalled();
    expect(token.retry).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "m-unsafe-skill" })],
      "opencode_managed_skills_unsafe",
    );
    expect(vi.mocked(sessionCtx.log).mock.calls.flat().join("\n")).toContain("blocked provider turn: unsafe discovery");
    await handler.shutdown();
  });

  it("rechecks Context authority after a paused DB gate before starting a provider turn", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-source-gate-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const baseSupervisor = createSyntheticSupervisor(specs);
    const releaseDbFile = join(root, "release-db-gate");
    let markDbStarted: () => void = () => {};
    const dbStarted = new Promise<void>((resolvePromise) => {
      markDbStarted = resolvePromise;
    });
    const supervisor: ProviderProcessSupervisor = {
      spawn(spec) {
        if (spec.args[0] !== "db") return baseSupervisor.spawn(spec);
        specs.push(spec);
        const child = spawn(
          process.execPath,
          [
            "-e",
            `const fs=require("node:fs");const releasePath=process.argv[1];const timer=setInterval(()=>{if(fs.existsSync(releasePath)){clearInterval(timer);process.stdout.write('[{"ready":1}]\\n');}},5);`,
            releaseDbFile,
          ],
          { ...spec.options, detached: false },
        );
        markDbStarted();
        return { child, exited: new Promise<void>((resolve) => child.once("exit", () => resolve())) };
      },
    };
    const repoA = "https://github.com/acme/tree-a.git";
    const repoB = "https://github.com/acme/tree-b.git";
    let authoritativeRepo = repoA;
    const sessionCtx = context([], []);
    sessionCtx.sdk.getAgentContextTreeConfig = async () => ({
      bindingState: "bound",
      repo: authoritativeRepo,
      branch: "main",
      provider: "github",
    });
    const token = deliveryToken();
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      contextSourceKind: "remote",
      contextTreePath: join(root, "context-tree"),
      contextTreeRepoUrl: repoA,
      contextTreeBranch: "main",
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: supervisor,
      opencodeTurnTimeoutMs: 5_000,
    });

    const startPromise = handler.start(message("m-source-gate", "must not reach OpenCode"), sessionCtx, token);
    await dbStarted;
    authoritativeRepo = repoB;
    writeFileSync(releaseDbFile, "release");
    await startPromise;

    expect(specs.filter((spec) => spec.args[0] === "run")).toHaveLength(0);
    expect(token.processingStarted).not.toHaveBeenCalled();
    expect(token.complete).not.toHaveBeenCalled();
    expect(token.retry).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "m-source-gate" })],
      "opencode_context_source_changed",
    );
    expect(sessionCtx.failSessionForRecovery).toHaveBeenCalledWith("opencode_context_source_changed", undefined);
    await handler.shutdown();
  });

  it.each([
    ["queued preflight", 2],
    ["turn preflight", 4],
  ] as const)("parks persistent unsafe discovery at the %s and resumes the ordered batch once", async (failurePoint, expectedUnsafeRefreshes) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-managed-skills-parked-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: Array<{ kind?: string; payload?: { message?: string } }> = [];
    const sessionCtx = context(events, []);
    const reconcile = resetManagedSkillsReconcileMock();
    const { sleep, waits } = controlledOpenCodeSleep();
    let queuedPhase = false;
    let unsafe = true;
    let queuedRefreshes = 0;
    reconcile.mockImplementation(async () => {
      if (!queuedPhase) return reconciledSkillsResult();
      queuedRefreshes += 1;
      const shouldFail = unsafe && (failurePoint === "queued preflight" || queuedRefreshes % 2 === 0);
      if (shouldFail) throw new ManagedSkillsUnsafeDiscoveryError(`${failurePoint} unsafe`);
      return reconciledSkillsResult();
    });
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs, { capturedInputs: inputs }),
      opencodeUnsafeDiscoverySleep: sleep,
      opencodeTurnTimeoutMs: 5_000,
    });
    await handler.start(message("m-seed", "seed"), sessionCtx, deliveryToken());
    queuedPhase = true;
    const heldToken = deliveryToken();
    const tailToken = deliveryToken();

    expect(handler.inject(message("m-held", "held delivery"), heldToken)).toEqual({
      kind: "owned",
      mode: "queued",
    });
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));
    expect(handler.inject(message("m-tail", "later delivery"), tailToken)).toEqual({
      kind: "owned",
      mode: "queued",
    });
    waits[0]?.complete();
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(2));

    expect(sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual([1_000, 2_000]);
    expect(queuedRefreshes).toBe(expectedUnsafeRefreshes);
    const blockedEvents = events
      .map((event) => (event.payload?.message ? parseProviderRetryEventMessage(event.payload.message) : null))
      .filter((payload) => payload?.reasonCode === "managed_skills_unsafe_discovery");
    expect(blockedEvents).toEqual([
      expect.objectContaining({
        event: "provider_retry_scheduled",
        provider: "opencode",
        scope: "provider_turn",
        attempt: 1,
        retryMode: "background",
        delayMs: 1_000,
        userSeverity: "warning",
        messagePreview: expect.stringContaining("remains unacknowledged"),
      }),
      expect.objectContaining({
        event: "provider_retry_scheduled",
        provider: "opencode",
        scope: "provider_turn",
        attempt: 2,
        retryMode: "background",
        delayMs: 2_000,
        userSeverity: "warning",
        messagePreview: expect.stringContaining("remains unacknowledged"),
      }),
    ]);
    expect(specs.filter((spec) => spec.args[0] === "run")).toHaveLength(1);
    expect(heldToken.processingStarted).not.toHaveBeenCalled();
    expect(heldToken.complete).not.toHaveBeenCalled();
    expect(heldToken.retry).not.toHaveBeenCalled();
    expect(tailToken.processingStarted).not.toHaveBeenCalled();
    expect(tailToken.complete).not.toHaveBeenCalled();
    expect(tailToken.retry).not.toHaveBeenCalled();
    const blockedLogs = vi
      .mocked(sessionCtx.log)
      .mock.calls.flat()
      .filter((line) => String(line).includes("queued turn blocked by unsafe managed-skill discovery"));
    expect(blockedLogs).toHaveLength(2);
    expect(vi.mocked(sessionCtx.log).mock.calls.flat().join("\n")).not.toContain("OpenCode queued turn failed");

    unsafe = false;
    waits[1]?.complete();
    await vi.waitFor(() => expect(heldToken.complete).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(tailToken.complete).toHaveBeenCalledTimes(1));

    expect(heldToken.processingStarted).toHaveBeenCalledTimes(1);
    expect(heldToken.retry).not.toHaveBeenCalled();
    expect(tailToken.processingStarted).toHaveBeenCalledTimes(1);
    expect(tailToken.retry).not.toHaveBeenCalled();
    expect(specs.filter((spec) => spec.args[0] === "run")).toHaveLength(3);
    expect(inputs).toHaveLength(3);
    expect(inputs[1]).toContain("held delivery");
    expect(inputs[1]).not.toContain("later delivery");
    expect(inputs[2]).toContain("later delivery");
    for (const spec of specs.filter((entry) => entry.args[0] === "run").slice(1)) {
      expect(spec.args).toEqual(expect.arrayContaining(["--session", "ses_new"]));
    }
    await handler.shutdown();
  });

  it.each(["suspend", "shutdown"] as const)("releases a parked unsafe batch exactly once on %s", async (lifecycle) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), `ft-opencode-managed-skills-${lifecycle}-`));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const sessionCtx = context([], []);
    const reconcile = resetManagedSkillsReconcileMock();
    const { sleep, waits } = controlledOpenCodeSleep();
    let queuedPhase = false;
    reconcile.mockImplementation(async () => {
      if (!queuedPhase) return reconciledSkillsResult();
      throw new ManagedSkillsUnsafeDiscoveryError("persistent unsafe discovery");
    });
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
      opencodeUnsafeDiscoverySleep: sleep,
      opencodeTurnTimeoutMs: 5_000,
    });
    await handler.start(message("m-seed", "seed"), sessionCtx, deliveryToken());
    queuedPhase = true;
    const heldToken = deliveryToken();
    const tailToken = deliveryToken();
    expect(handler.inject(message("m-held", "held"), heldToken)).toEqual({
      kind: "owned",
      mode: "queued",
    });
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));
    expect(handler.inject(message("m-tail", "tail"), tailToken)).toEqual({
      kind: "owned",
      mode: "queued",
    });
    const reason = `test parked ${lifecycle}`;

    if (lifecycle === "suspend") await handler.suspend(reason);
    else await handler.shutdown(reason);

    expect(waits[0]?.signal.aborted).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(heldToken.retry).toHaveBeenCalledTimes(1);
    expect(heldToken.retry).toHaveBeenCalledWith(expect.objectContaining({ id: "m-held" }), reason);
    expect(tailToken.retry).toHaveBeenCalledTimes(1);
    expect(tailToken.retry).toHaveBeenCalledWith(expect.objectContaining({ id: "m-tail" }), reason);
    expect(heldToken.processingStarted).not.toHaveBeenCalled();
    expect(heldToken.complete).not.toHaveBeenCalled();
    expect(tailToken.processingStarted).not.toHaveBeenCalled();
    expect(tailToken.complete).not.toHaveBeenCalled();
    expect(specs.filter((spec) => spec.args[0] === "run")).toHaveLength(1);
    expect(vi.mocked(sessionCtx.log).mock.calls.flat().join("\n")).not.toContain("OpenCode queued turn failed");
    if (lifecycle === "suspend") await handler.shutdown();
  });

  it("keeps ordinary queued projection failures on the generic recovery path", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-queued-generic-failure-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const sessionCtx = context([], []);
    const reconcile = resetManagedSkillsReconcileMock();
    let queuedPhase = false;
    reconcile.mockImplementation(async () => {
      if (!queuedPhase) return reconciledSkillsResult();
      throw new Error("ordinary queued projection failure");
    });
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
      opencodeTurnTimeoutMs: 5_000,
    });
    await handler.start(message("m-seed", "seed"), sessionCtx, deliveryToken());
    queuedPhase = true;
    const token = deliveryToken();

    expect(handler.inject(message("m-generic", "generic failure"), token)).toEqual({
      kind: "owned",
      mode: "queued",
    });
    await vi.waitFor(() => expect(token.retry).toHaveBeenCalledTimes(1));

    expect(token.retry).toHaveBeenCalledWith(
      expect.objectContaining({ id: "m-generic" }),
      "opencode_queued_turn_failed",
    );
    expect(token.processingStarted).not.toHaveBeenCalled();
    expect(token.complete).not.toHaveBeenCalled();
    expect(specs.filter((spec) => spec.args[0] === "run")).toHaveLength(1);
    expect(vi.mocked(sessionCtx.log).mock.calls.flat().join("\n")).toContain(
      "OpenCode queued turn failed: ordinary queued projection failure",
    );
    await handler.shutdown();
  });

  it("builds private MCP/agent config and provider-native argv", () => {
    const config = runtimeConfig().payload;
    expect(mapOpenCodeMcpServers(config, "scope-a")).toEqual({
      servers: {
        "first-tree-scope-a-mcp-1": { type: "local", command: ["mcp-bin", "--stdio"], enabled: true },
      },
      aliases: [{ configuredName: "repo", managedName: "first-tree-scope-a-mcp-1" }],
    });
    const projected = JSON.parse(
      buildOpenCodeConfigContent({
        payload: config,
        managedAgentName: "first-tree-scope-a",
        scope: "scope-a",
      }),
    );
    expect(projected.agent["first-tree-scope-a"]).toMatchObject({
      mode: "primary",
      model: "openai/gpt-test",
    });
    expect(projected.agent["first-tree-scope-a"].prompt).not.toContain("Current Chat Context");
    expect(projected).not.toHaveProperty("permission");
    expect(projected.mcp).toHaveProperty("first-tree-scope-a-mcp-1");
    expect(
      buildOpenCodeTurnArgs({
        cwd: "/work",
        model: "openai/gpt-test",
        resumeSessionId: "ses_1",
        managedAgentName: "first-tree-scope-a",
      }),
    ).toEqual(
      expect.arrayContaining([
        "run",
        "--format",
        "json",
        "--auto",
        "--agent",
        "first-tree-scope-a",
        "--model",
        "openai/gpt-test",
        "--session",
        "ses_1",
      ]),
    );
  });

  it("moves oversized private config out of the Windows-sensitive environment block and cleans it", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-config-"));
    roots.push(root);
    const lease = await acquireOpenCodePrivateConfigLease({
      workspace: root,
      callerScope: "a".repeat(64),
      handlerId: "1".repeat(32),
    });
    const projection = projectOpenCodeConfig({ BASE: "1", OPENCODE_CONFIG_CONTENT: "stale" }, '{"secret":"value"}', {
      maxEnvBytes: 1,
      fileStore: lease,
    });
    expect(projection.transport).toBe("file");
    expect(JSON.parse(String(projection.env.OPENCODE_CONFIG_CONTENT))).toEqual({
      autoupdate: false,
      share: "disabled",
      snapshot: false,
    });
    expect(String(projection.env.OPENCODE_CONFIG_CONTENT)).not.toContain("secret");
    const configPath = String(projection.env.OPENCODE_CONFIG);
    expect(configPath).toContain(join(".first-tree-workspace", "opencode-config"));
    expect(readFileSync(configPath, "utf8")).toBe('{"secret":"value"}');
    projection.cleanup();
    expect(existsSync(configPath)).toBe(false);
    await lease.close();
  });

  it("preserves host custom config for inline projection and fails closed rather than replacing it on overflow", () => {
    const hostConfig = "/operator/custom-opencode.json";
    const inline = projectOpenCodeConfig(
      { OPENCODE_CONFIG: hostConfig, OPENCODE_CONFIG_CONTENT: "stale" },
      '{"agent":{}}',
    );
    expect(inline.transport).toBe("env");
    expect(inline.env.OPENCODE_CONFIG).toBe(hostConfig);
    expect(inline.env.OPENCODE_CONFIG_CONTENT).toBe('{"agent":{}}');
    expect(() =>
      projectOpenCodeConfig({ OPENCODE_CONFIG: hostConfig }, '{"agent":{}}', {
        maxEnvBytes: 1,
      }),
    ).toThrow(/cannot replace the host OPENCODE_CONFIG/i);
  });

  it("derives a stable high-entropy caller scope without cross-caller collisions", () => {
    const first = stableOpenCodeScope("agent-1");
    expect(first).toHaveLength(64);
    expect(stableOpenCodeScope("agent-1")).toBe(first);
    expect(stableOpenCodeScope("agent-2")).not.toBe(first);
  });

  it("keeps the managed agent identity stable across fresh handlers and distinct across agents", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-stable-agent-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const supervisor = createSyntheticSupervisor(specs);
    const run = async (agentId: string) => {
      const handler = createOpenCodeHandler({
        workspaceRoot: join(root, agentId),
        agentName: agentId,
        runtimeProvider: "opencode",
        agentConfigCache: cache(runtimeConfig()),
        opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
        providerProcessSupervisor: supervisor,
      });
      await handler.start(
        message(`m-${agentId}-${specs.length}`, "turn"),
        context([], [], { agentId }),
        deliveryToken(),
      );
      await handler.shutdown();
    };
    await run("agent-1");
    await run("agent-1");
    await run("agent-2");
    const managedNames = specs
      .filter((spec) => spec.args[0] === "run")
      .map((spec) => spec.args[spec.args.indexOf("--agent") + 1]);
    expect(managedNames[0]).toBe(managedNames[1]);
    expect(managedNames[2]).not.toBe(managedNames[0]);
  });

  it("uses a handler-owned private config generation and removes that generation on shutdown", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-private-config-recovery-"));
    roots.push(root);
    const scopeRoot = join(root, ".first-tree-workspace", "opencode-config", stableOpenCodeScope("agent-1\0chat-1"));
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createSyntheticSupervisor([]),
    });

    await handler.start(message("m-private", "turn"), context([], []), deliveryToken());
    expect(existsSync(scopeRoot)).toBe(true);
    expect(readFileSync(join(scopeRoot, "handler-generations.json"), "utf8")).toContain('"handlerId"');
    await handler.shutdown();
    expect(existsSync(scopeRoot)).toBe(true);
    expect(readFileSync(join(scopeRoot, "handler-generations.json"), "utf8")).toContain('"entries": []');
  });

  it("keeps a replacement handler usable after the older generation shuts down late", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-private-config-replacement-"));
    roots.push(root);
    const scopeRoot = join(root, ".first-tree-workspace", "opencode-config", stableOpenCodeScope("agent-1\0chat-1"));
    const supervisor = createSyntheticSupervisor([]);
    const makeHandler = () =>
      createOpenCodeHandler({
        workspaceRoot: root,
        agentName: "opencode-test-agent",
        runtimeProvider: "opencode",
        agentConfigCache: cache(runtimeConfig()),
        opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
        providerProcessSupervisor: supervisor,
      });
    const older = makeHandler();
    const replacement = makeHandler();

    await older.start(message("m-private-old", "old"), context([], []), deliveryToken());
    await replacement.start(message("m-private-new", "new"), context([], []), deliveryToken());
    const generationNames = () => readdirSync(scopeRoot).filter((name) => /^handler-[a-f0-9]{32}$/.test(name));
    expect(generationNames()).toHaveLength(2);

    await older.shutdown();
    expect(generationNames()).toHaveLength(1);
    const replacementToken = deliveryToken();
    replacement.inject(message("m-private-replacement", "still alive"), replacementToken);
    await vi.waitFor(() => expect(replacementToken.complete).toHaveBeenCalled());

    await replacement.shutdown();
    expect(generationNames()).toEqual([]);
  });

  it("fails closed before a file-backed write when a live generation leaf becomes a symlink", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-private-config-swap-"));
    const external = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-private-config-outside-"));
    roots.push(root, external);
    const cfg = runtimeConfig();
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(cfg),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createSyntheticSupervisor([]),
      opencodeRetrySleep: async () => {},
    });
    await handler.start(message("m-private-swap-first", "small config"), context([], []), deliveryToken());
    const scopeRoot = join(root, ".first-tree-workspace", "opencode-config", stableOpenCodeScope("agent-1\0chat-1"));
    const generationName = readdirSync(scopeRoot).find((name) => /^handler-[a-f0-9]{32}$/.test(name));
    expect(generationName).toBeTruthy();
    const generationPath = join(scopeRoot, String(generationName));
    rmSync(generationPath, { recursive: true, force: true });
    writeFileSync(join(external, "sentinel.txt"), "outside");
    symlinkSync(external, generationPath, "dir");
    cfg.payload.mcpServers[0] = {
      name: "large",
      transport: "stdio",
      command: "mcp-bin",
      args: ["x".repeat(20_000)],
    };

    const token = deliveryToken();
    handler.inject(message("m-private-swap-second", "force file projection"), token);
    await vi.waitFor(() => expect(token.retry).toHaveBeenCalled());

    expect(readdirSync(external)).toEqual(["sentinel.txt"]);
    expect(readFileSync(join(external, "sentinel.txt"), "utf8")).toBe("outside");
    await expect(handler.shutdown()).rejects.toThrow(/symlink|identity/i);
  });

  it("fails closed when even the file-backed projection cannot fit a Windows environment block", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-config-overflow-"));
    roots.push(root);
    const lease = await acquireOpenCodePrivateConfigLease({
      workspace: root,
      callerScope: "b".repeat(64),
      handlerId: "2".repeat(32),
    });
    expect(() =>
      projectOpenCodeConfig({ HUGE: "x".repeat(1_000) }, '{"agent":{}}', {
        platform: "win32",
        maxWindowsEnvChars: 100,
        fileStore: lease,
      }),
    ).toThrow(/exceeds the safe Windows block limit/i);
    await lease.close();
  });

  it("serializes DB readiness, sends prompt only on stdin, and resumes the confirmed session", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-handler-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const events: unknown[] = [];
    const forwarded: string[] = [];
    const sessionCtx = context(events, forwarded);
    const cfg = runtimeConfig();
    cfg.payload.env.push({ key: "OPENCODE_CONFIG", value: "/operator/custom-opencode.json", sensitive: false });
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(cfg),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs),
      opencodeTurnTimeoutMs: 5_000,
    });

    const firstToken = deliveryToken();
    const started = await handler.start(message("m1", "first prompt"), sessionCtx, firstToken);
    expect(started).toMatchObject({ sessionId: "ses_new", route: { kind: "owned", mode: "processing" } });
    expect(specs.map((spec) => spec.args[0])).toEqual(["--version", "db", "run"]);
    const firstRun = specs[2];
    expect(firstRun?.args).not.toContain("first prompt");
    expect(firstRun?.options.env).toMatchObject({
      FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE: "/private/token",
      PROVIDER_ENV: "local",
      OPENCODE_CONFIG: "/operator/custom-opencode.json",
    });
    expect(String(firstRun?.options.env?.OPENCODE_CONFIG_CONTENT)).toContain('"first-tree-');
    expect(String(firstRun?.options.env?.OPENCODE_CONFIG_CONTENT)).not.toContain("Current Chat Context");
    expect(forwarded.some((text) => text.includes("[From: human]\nfirst prompt"))).toBe(true);
    expect(forwarded[0]).toContain("<first-tree-current-chat-context");
    expect(firstToken.complete).toHaveBeenCalledWith([expect.objectContaining({ id: "m1" })], {
      status: "success",
    });

    await handler.suspend();
    const secondToken = deliveryToken();
    await handler.resume(message("m2", "second prompt"), "ses_new", sessionCtx, secondToken);
    const secondRun = specs.at(-1);
    expect(secondRun?.args).toEqual(expect.arrayContaining(["--session", "ses_new"]));
    expect(specs.filter((spec) => spec.args[0] === "db")).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ kind: "token_usage" }));
    expect(events).toContainEqual({ kind: "turn_end", payload: { status: "success" } });
    await handler.shutdown();
  });

  it("queues active injects instead of steering the current process", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-queue-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs, { turnDelayMs: 100, capturedInputs: inputs }),
    });
    const sessionCtx = context([], []);
    const startPromise = handler.start(message("m1", "first"), sessionCtx, deliveryToken());
    await vi.waitFor(() => {
      expect(specs.filter((spec) => spec.args[0] === "run")).toHaveLength(1);
    });
    const receipt = handler.inject(message("m2", "queued"), deliveryToken());
    expect(receipt).toEqual({ kind: "owned", mode: "queued" });
    expect(specs.filter((spec) => spec.args[0] === "run")).toHaveLength(1);
    await startPromise;
    await vi.waitFor(() => {
      expect(specs.filter((spec) => spec.args[0] === "run")).toHaveLength(2);
    });
    await vi.waitFor(() => expect(inputs).toHaveLength(2));
    expect(inputs[0]).toContain("<first-tree-current-chat-context");
    expect(inputs[1]).not.toContain("<first-tree-current-chat-context");
    await handler.shutdown();
  }, 15_000);

  it("fails closed on unknown JSONL even when it carries a valid session id, then preserves one-shot context", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-protocol-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const inputs: string[] = [];
    const events: Array<{ kind?: string; payload?: { message?: string } }> = [];
    const sessionCtx = context(events, []);
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createProtocolSupervisor(
        specs,
        [`${JSON.stringify({ type: "future", sessionID: "ses_new" })}\n`, `${successfulTurn()}\n`],
        inputs,
      ),
      opencodeRetrySleep: async () => {},
    });
    const firstToken = deliveryToken();
    await handler.start(message("m1", "first"), sessionCtx, firstToken);
    expect(firstToken.retry).toHaveBeenCalled();
    expect(firstToken.complete).not.toHaveBeenCalled();
    expect(
      events.some((event) => event.payload?.message && parseProviderRetryEventMessage(event.payload.message)),
    ).toBe(true);
    expect(vi.mocked(sessionCtx.log).mock.calls.flat().join("\n")).not.toContain('"type":"future"');

    const secondToken = deliveryToken();
    expect(handler.inject(message("m2", "second"), secondToken)).toEqual({ kind: "owned", mode: "queued" });
    await vi.waitFor(() => expect(secondToken.complete).toHaveBeenCalled());
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toContain("<first-tree-current-chat-context");
    expect(inputs[1]).toContain("<first-tree-current-chat-context");
    await handler.shutdown();
  });

  it("bounds stream-started retries across fresh handlers and observes the retry-policy delays", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-retry-window-"));
    roots.push(root);
    const sleep = vi.fn<(delayMs: number) => Promise<void>>(async () => {});
    const sessionCtx = context([], []);
    const tokens = [deliveryToken(), deliveryToken(), deliveryToken()];
    for (const token of tokens) {
      const handler = createOpenCodeHandler({
        workspaceRoot: root,
        agentName: "opencode-test-agent",
        runtimeProvider: "opencode",
        agentConfigCache: cache(runtimeConfig()),
        opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
        providerProcessSupervisor: createProtocolSupervisor([], ["not-json\n"]),
        opencodeRetrySleep: sleep,
      });
      await handler.start(message("m-retry", "same delivery"), sessionCtx, token);
      await handler.shutdown();
    }

    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([5_000, 15_000]);
    expect(tokens[0]?.retry).toHaveBeenCalled();
    expect(tokens[1]?.retry).toHaveBeenCalled();
    expect(tokens[2]?.retry).not.toHaveBeenCalled();
    expect(tokens[2]?.complete).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "m-retry" })],
      expect.objectContaining({ status: "error", completion: "consumed" }),
    );
    expect(sessionCtx.failSessionForRecovery).toHaveBeenCalledTimes(2);
  });

  it("keeps bounded retry custody across real SessionRuntime handler replacement", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-session-manager-retry-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const sleep = vi.fn<(delayMs: number) => Promise<void>>(async () => {});
    const inputs: string[] = [];
    const supervisor = createProtocolSupervisor(
      specs,
      [`${successfulTurn()}\n`, "not-json\n", "not-json\n", "not-json\n"],
      inputs,
    );
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>(async () => {});
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>(async () => {});
    const sendMessage = vi.fn(async () => ({ id: "runtime-notice" }));
    const sdk = {
      serverUrl: "https://first-tree.test",
      sendMessage,
      getChatDetail: vi.fn(async () => ({
        id: "chat-sm-retry",
        title: "Retry chat",
        topic: null,
        description: null,
      })),
      listChatParticipants: vi.fn(async () => []),
    } as unknown as FirstTreeHubSDK;
    const manager = new SessionRuntime({
      session: {
        idle_timeout: 300,
        max_sessions: 10,
        working_grace_seconds: 3600,
        reconcile_interval_seconds: 300,
      },
      concurrency: 1,
      handlerFactory: (handlerConfig) =>
        createOpenCodeHandler({
          ...handlerConfig,
          opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
          providerProcessSupervisor: supervisor,
          opencodeRetrySleep: sleep,
        }),
      handlerConfig: { workspaceRoot: root, agentName: "opencode-test-agent", runtimeProvider: "opencode" },
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
      registryPath: join(root, "sessions.json"),
      ackEntry,
      recoverChat,
      agentConfigCache: cache(runtimeConfig()),
    });
    const seed = mockEntry({
      id: 801,
      chatId: "chat-sm-retry",
      messageId: "msg-sm-seed",
      content: "seed the provider session",
    });
    const deliveryHead = mockEntry({
      id: 802,
      chatId: "chat-sm-retry",
      messageId: "msg-sm-head",
      content: "retry delivery head",
    });
    const fusedTail = mockEntry({
      id: 803,
      chatId: "chat-sm-retry",
      messageId: "msg-sm-tail",
      content: "fused delivery tail",
    });

    await manager.dispatch(seed);
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledWith(801));
    await Promise.all([manager.dispatch(deliveryHead), manager.dispatch(fusedTail)]);
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledTimes(1));
    expect(inputs[1]).toContain("retry delivery head");
    expect(inputs[1]).toContain("fused delivery tail");
    for (const expectedRuns of [3, 4]) {
      await manager.dispatch(deliveryHead);
      await vi.waitFor(() => expect(specs.filter((spec) => spec.args[0] === "run")).toHaveLength(expectedRuns));
    }

    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([5_000, 15_000]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(ackEntry).toHaveBeenCalledWith(802);
    await manager.shutdown();
  });

  it("abandons no custody mutation when suspend interrupts a provider retry delay", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-retry-suspend-"));
    roots.push(root);
    let sleepStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      sleepStarted = resolveStarted;
    });
    const sleep = vi.fn(
      async (_delayMs: number, signal: AbortSignal) =>
        new Promise<boolean>((resolveDelay) => {
          sleepStarted();
          signal.addEventListener("abort", () => resolveDelay(false), { once: true });
        }),
    );
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createProtocolSupervisor([], ["not-json\n"]),
      opencodeRetrySleep: sleep,
    });
    const token = deliveryToken();
    const startPromise = handler.start(message("m-delay", "first"), context([], []), token);
    await started;

    await handler.suspend("test suspend during provider delay");
    await startPromise;

    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).not.toHaveBeenCalled();
    expect(openCodeProviderAttemptWindowSizeForTests()).toBe(1);
    await handler.shutdown();
  });

  it("continues the same retry window after SessionRuntime preempts an unacked delivery delay", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-retry-preempt-"));
    roots.push(root);
    let firstDelayStarted!: () => void;
    const delayStarted = new Promise<void>((resolveStarted) => {
      firstDelayStarted = resolveStarted;
    });
    let delayCall = 0;
    const sleep = vi.fn(async (_delayMs: number, signal: AbortSignal) => {
      delayCall += 1;
      if (delayCall > 1) return true;
      firstDelayStarted();
      return new Promise<boolean>((resolveDelay) => {
        signal.addEventListener("abort", () => resolveDelay(false), { once: true });
      });
    });
    const specs: ProviderProcessSpec[] = [];
    const supervisor = createProtocolSupervisor(specs, [
      "not-json\n",
      `${successfulTurn("ses_other")}\n`,
      "not-json\n",
      "not-json\n",
    ]);
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>(async () => {});
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>(async () => {});
    const sendMessage = vi.fn(async () => ({ id: "runtime-notice" }));
    const sdk = {
      serverUrl: "https://first-tree.test",
      sendMessage,
      getChatDetail: vi.fn(async (chatId: string) => ({
        id: chatId,
        title: "Retry preemption chat",
        topic: null,
        description: null,
      })),
      listChatParticipants: vi.fn(async () => []),
    } as unknown as FirstTreeHubSDK;
    const manager = new SessionRuntime({
      session: {
        idle_timeout: 300,
        max_sessions: 10,
        working_grace_seconds: 3600,
        reconcile_interval_seconds: 300,
      },
      concurrency: 1,
      handlerFactory: (handlerConfig) =>
        createOpenCodeHandler({
          ...handlerConfig,
          opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
          providerProcessSupervisor: supervisor,
          opencodeRetrySleep: sleep,
        }),
      handlerConfig: { workspaceRoot: root, agentName: "opencode-test-agent", runtimeProvider: "opencode" },
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
      registryPath: join(root, "sessions.json"),
      ackEntry,
      recoverChat,
      agentConfigCache: cache(runtimeConfig()),
    });
    const delivery = mockEntry({
      id: 811,
      chatId: "chat-retry-preempt",
      messageId: "msg-retry-preempt",
      content: "same delivery after preemption",
    });
    const competing = mockEntry({
      id: 812,
      chatId: "chat-competing",
      messageId: "msg-competing",
      content: "take the only runtime slot",
    });

    const firstDispatch = manager.dispatch(delivery);
    await delayStarted;
    await manager.dispatch(competing);
    await firstDispatch;
    expect(ackEntry).not.toHaveBeenCalledWith(811);
    expect(ackEntry).toHaveBeenCalledWith(812);

    await manager.dispatch(delivery);
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith("chat-retry-preempt"));
    await manager.dispatch(delivery);
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledWith(811));

    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([5_000, 15_000]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await manager.shutdown();
  });

  it("expires abandoned provider-attempt windows before admitting a new delivery head", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-retry-expiry-"));
    roots.push(root);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    let oldDeliveryPending = true;
    const runFailure = async (id: string, hasPendingDelivery: () => boolean) => {
      const handler = createOpenCodeHandler({
        workspaceRoot: root,
        agentName: "opencode-test-agent",
        runtimeProvider: "opencode",
        agentConfigCache: cache(runtimeConfig()),
        opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
        providerProcessSupervisor: createProtocolSupervisor([], ["not-json\n"]),
        opencodeRetrySleep: async () => {},
      });
      const sessionCtx = context([], []);
      sessionCtx.hasPendingDelivery = hasPendingDelivery;
      await handler.start(message(id, "delivery"), sessionCtx, deliveryToken());
      await handler.shutdown();
    };

    await runFailure("m-old-window", () => oldDeliveryPending);
    expect(openCodeProviderAttemptWindowSizeForTests()).toBe(1);
    clock.mockReturnValue(now + 31 * 60_000);
    await runFailure("m-old-window", () => oldDeliveryPending);
    expect(openCodeProviderAttemptWindowSizeForTests()).toBe(1);
    oldDeliveryPending = false;
    clock.mockReturnValue(now + 62 * 60_000);
    await runFailure("m-new-window", () => true);
    expect(openCodeProviderAttemptWindowSizeForTests()).toBe(1);
  });

  it("retries durable failure notice through SessionRuntime recovery without re-entering the provider", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-session-manager-notice-"));
    roots.push(root);
    const inputs: string[] = [];
    const credentialOutput = [
      JSON.stringify({ type: "step_start", sessionID: "ses_new", part: { sessionID: "ses_new" } }),
      JSON.stringify({
        type: "error",
        sessionID: "ses_new",
        error: { message: "401 Unauthorized: invalid API key" },
      }),
    ].join("\n");
    const supervisor = createProtocolSupervisor([], [`${credentialOutput}\n`, `${successfulTurn()}\n`], inputs);
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>(async () => {});
    const recoverChat = vi.fn<(chatId: string) => Promise<void>>(async () => {});
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("runtime notice write failed"))
      .mockResolvedValue({ id: "runtime-notice" });
    const sdk = {
      serverUrl: "https://first-tree.test",
      sendMessage,
      getChatDetail: vi.fn(async () => ({
        id: "chat-sm-notice",
        title: "Notice chat",
        topic: null,
        description: null,
      })),
      listChatParticipants: vi.fn(async () => []),
    } as unknown as FirstTreeHubSDK;
    const manager = new SessionRuntime({
      session: {
        idle_timeout: 300,
        max_sessions: 10,
        working_grace_seconds: 3600,
        reconcile_interval_seconds: 300,
      },
      concurrency: 1,
      handlerFactory: (handlerConfig) =>
        createOpenCodeHandler({
          ...handlerConfig,
          opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
          providerProcessSupervisor: supervisor,
        }),
      handlerConfig: { workspaceRoot: root, agentName: "opencode-test-agent", runtimeProvider: "opencode" },
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
      registryPath: join(root, "sessions.json"),
      ackEntry,
      recoverChat,
      agentConfigCache: cache(runtimeConfig()),
    });
    const entry = mockEntry({
      id: 802,
      chatId: "chat-sm-notice",
      messageId: "msg-sm-notice",
      content: "same terminal delivery",
    });

    await manager.dispatch(entry);
    expect(ackEntry).not.toHaveBeenCalled();
    expect(existsSync(join(root, ".first-tree-workspace", "session-briefings"))).toBe(false);
    await vi.waitFor(() => expect(recoverChat).toHaveBeenCalledWith("chat-sm-notice"));
    // Recovery/redelivery must retry the durable notice and ACK without
    // re-entering the provider (no second prompt / one-shot context write).
    await manager.dispatch(entry);
    await vi.waitFor(() => expect(ackEntry).toHaveBeenCalledWith(802));

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.invocationCallOrder[1] as number).toBeLessThan(
      ackEntry.mock.invocationCallOrder[0] as number,
    );
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain("<first-tree-current-chat-context");
    // Credential failure never advanced briefing custody; notice-only recovery
    // must not invent a successful provider turn to do so.
    expect(readSessionBriefingFingerprint(root, "ses_new")).toBeNull();
    await manager.shutdown();
  });

  it("emits a standard terminal provider failure before consuming a credential failure", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-auth-"));
    roots.push(root);
    const events: Array<{ kind?: string; payload?: { message?: string } }> = [];
    const output = [
      JSON.stringify({ type: "step_start", sessionID: "ses_new", part: { sessionID: "ses_new" } }),
      JSON.stringify({
        type: "error",
        sessionID: "ses_new",
        error: { message: "401 Unauthorized: invalid API key" },
      }),
    ].join("\n");
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createProtocolSupervisor([], [`${output}\n`]),
    });
    const token = deliveryToken();
    await handler.start(message("m1", "first"), context(events, []), token);
    const retryPayloads = events
      .map((event) => (event.payload?.message ? parseProviderRetryEventMessage(event.payload.message) : null))
      .filter((value) => value !== null);
    expect(retryPayloads).toContainEqual(
      expect.objectContaining({ event: "provider_failure_terminal", provider: "opencode", category: "credential" }),
    );
    expect(token.complete).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "m1" })],
      expect.objectContaining({ status: "error", completion: "consumed" }),
    );
    await handler.shutdown();
  });

  it("retains one-shot context and briefing custody when terminal completion is returned for redelivery", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-notice-redelivery-"));
    roots.push(root);
    const inputs: string[] = [];
    const credentialOutput = [
      JSON.stringify({ type: "step_start", sessionID: "ses_new", part: { sessionID: "ses_new" } }),
      JSON.stringify({
        type: "error",
        sessionID: "ses_new",
        error: { message: "401 Unauthorized: invalid API key" },
      }),
    ].join("\n");
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createProtocolSupervisor(
        [],
        [`${credentialOutput}\n`, `${successfulTurn()}\n`],
        inputs,
      ),
    });
    const firstToken = {
      ...deliveryToken(),
      complete: vi.fn(async () => "retry" as const),
    } satisfies DeliveryToken;
    const started = await handler.start(message("m-notice", "first"), context([], []), firstToken);
    const startedSessionId = typeof started === "string" ? started : started.sessionId;
    expect(readSessionBriefingFingerprint(root, startedSessionId)).toBeNull();

    const secondToken = deliveryToken();
    expect(handler.inject(message("m-redelivered", "first"), secondToken)).toEqual({ kind: "owned", mode: "queued" });
    await vi.waitFor(() => expect(secondToken.complete).toHaveBeenCalled());
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toContain("<first-tree-current-chat-context");
    expect(inputs[1]).toContain("<first-tree-current-chat-context");
    await handler.shutdown();
  });

  it("fails closed when OpenCode warns that the managed agent fell back", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-agent-fallback-"));
    roots.push(root);
    const forwarded: string[] = [];
    const output = `agent "first-tree-missing" not found. Falling back to default agent\n${successfulTurn()}\n`;
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createProtocolSupervisor([], [output]),
    });
    const token = deliveryToken();
    await handler.start(message("m1", "first"), context([], forwarded), token);
    expect(forwarded).toEqual([]);
    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "m1" })],
      expect.objectContaining({ status: "error", completion: "consumed" }),
    );
    await handler.shutdown();
  });

  it("treats a completed non-read-only tool event as an unsafe replay fence", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-effect-"));
    roots.push(root);
    const output = [
      JSON.stringify({ type: "step_start", sessionID: "ses_new", part: { sessionID: "ses_new" } }),
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_new",
        part: {
          id: "tool-1",
          tool: "bash",
          state: { status: "completed", input: { command: "touch effect" }, output: "done" },
        },
      }),
      "not-json",
    ].join("\n");
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createProtocolSupervisor([], [`${output}\n`]),
    });
    const token = deliveryToken();
    await handler.start(message("m1", "first"), context([], []), token);
    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "m1" })],
      expect.objectContaining({ status: "error", completion: "consumed", reason: "unsafe_replay" }),
    );
    await handler.shutdown();
  });

  it.each([
    "completed",
    "failed",
  ] as const)("settles a %s write-tool timeout as unsafe instead of replaying it", async (status) => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), `ft-opencode-timeout-${status}-`));
    roots.push(root);
    const output = [
      JSON.stringify({ type: "step_start", sessionID: "ses_new", part: { sessionID: "ses_new" } }),
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_new",
        part: {
          id: "tool-1",
          tool: "bash",
          state: { status, input: { command: "touch effect" }, output: status === "failed" ? "failed" : "done" },
        },
      }),
    ].join("\n");
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createProtocolSupervisor([], [`${output}\n`], [], true),
      opencodeTurnTimeoutMs: 250,
    });
    const token = deliveryToken();
    await handler.start(message("m-timeout", "first"), context([], []), token);
    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "m-timeout" })],
      expect.objectContaining({ status: "error", completion: "consumed", reason: "unsafe_replay" }),
    );
    await handler.shutdown();
  });

  it("settles an explicit abort after a write tool as unsafe instead of replaying it", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-abort-effect-"));
    roots.push(root);
    const events: Array<{ kind?: string }> = [];
    const output = [
      JSON.stringify({ type: "step_start", sessionID: "ses_new", part: { sessionID: "ses_new" } }),
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_new",
        part: {
          id: "tool-1",
          tool: "bash",
          state: { status: "completed", input: { command: "touch effect" }, output: "done" },
        },
      }),
    ].join("\n");
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createProtocolSupervisor([], [`${output}\n`], [], true),
      opencodeTurnTimeoutMs: 5_000,
    });
    const token = deliveryToken();
    const started = handler.start(message("m-abort", "first"), context(events, []), token);
    await vi.waitFor(() => expect(events.some((event) => event.kind === "tool_call")).toBe(true), {
      timeout: 10_000,
    });
    await handler.suspend("test explicit abort");
    await started;
    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "m-abort" })],
      expect.objectContaining({ status: "error", completion: "consumed", reason: "unsafe_replay" }),
    );
    await handler.shutdown();
  }, 15_000);

  it("does not settle a superseded turn on the old token when a newer start arrives", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-supersede-token-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const partialOutput = [
      JSON.stringify({ type: "step_start", sessionID: "ses_new", part: { sessionID: "ses_new" } }),
      JSON.stringify({ type: "text", sessionID: "ses_new", part: { text: "partial" } }),
    ].join("\n");
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createSupersedeProtocolSupervisor(
        specs,
        `${partialOutput}\n`,
        `${successfulTurn("ses_new", "done")}\n`,
      ),
      opencodeTurnTimeoutMs: 5_000,
    });
    const sessionCtx = context([], []);
    const bootstrapToken = deliveryToken();
    const { sessionId } = await handler.start(message("m-bootstrap", "bootstrap"), sessionCtx, bootstrapToken);
    expect(bootstrapToken.complete).toHaveBeenCalled();

    const supersededToken = deliveryToken();
    const ownerToken = deliveryToken();
    const superseded = handler.resume(message("m-superseded", "first"), sessionId, sessionCtx, supersededToken);
    await vi.waitFor(() => expect(supersededToken.processingStarted).toHaveBeenCalled(), {
      timeout: 10_000,
    });
    const owner = handler.resume(message("m-owner", "second"), sessionId, sessionCtx, ownerToken);
    await Promise.all([superseded, owner]);
    expect(supersededToken.complete).not.toHaveBeenCalled();
    expect(supersededToken.retry).not.toHaveBeenCalled();
    expect(ownerToken.complete).toHaveBeenCalled();
    expect(specs.filter((spec) => spec.args[0] === "run")).toHaveLength(3);
    await handler.shutdown();
  }, 30_000);

  it("preserves a superseded abort cause when the turn timeout fires after supersession", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-supersede-timeout-race-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const partialOutput = [
      JSON.stringify({ type: "step_start", sessionID: "ses_new", part: { sessionID: "ses_new" } }),
      JSON.stringify({ type: "text", sessionID: "ses_new", part: { text: "partial" } }),
    ].join("\n");
    const turnTimeoutMs = 2_500;
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createSupersedeProtocolSupervisor(
        specs,
        `${partialOutput}\n`,
        `${successfulTurn("ses_new", "done")}\n`,
        // Trap SIGTERM and stay alive past the turn deadline so the timer callback
        // really attempts to overwrite the first-writer-wins superseded record.
        { trapPartialSigterm: true, partialHoldMs: turnTimeoutMs + 800 },
      ),
      opencodeTurnTimeoutMs: turnTimeoutMs,
    });
    const sessionCtx = context([], []);
    const bootstrapToken = deliveryToken();
    const { sessionId } = await handler.start(message("m-bootstrap", "bootstrap"), sessionCtx, bootstrapToken);

    const firstToken = deliveryToken();
    const secondToken = deliveryToken();
    const first = handler.resume(message("m-race", "first"), sessionId, sessionCtx, firstToken);
    await vi.waitFor(() => expect(firstToken.processingStarted).toHaveBeenCalled(), {
      timeout: 10_000,
    });
    const second = handler.resume(message("m-race-owner", "second"), sessionId, sessionCtx, secondToken);
    await vi.waitFor(() => expect(secondToken.processingStarted).toHaveBeenCalled(), {
      timeout: 10_000,
    });
    // Owner must finish well before the shared deadline; the stale child holds past it.
    await vi.waitFor(() => expect(secondToken.complete).toHaveBeenCalled(), { timeout: turnTimeoutMs });
    await Promise.all([first, second]);
    expect(firstToken.complete).not.toHaveBeenCalled();
    expect(firstToken.retry).not.toHaveBeenCalled();
    expect(secondToken.retry).not.toHaveBeenCalled();
    await handler.shutdown();
  }, 30_000);

  it("scopes abort records per handler so concurrent sessions cannot steal settlement", async () => {
    const rootA = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-abort-scope-a-"));
    const rootB = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-abort-scope-b-"));
    roots.push(rootA, rootB);
    const specsA: ProviderProcessSpec[] = [];
    const partialOutput = [
      JSON.stringify({ type: "step_start", sessionID: "ses_new", part: { sessionID: "ses_new" } }),
      JSON.stringify({ type: "text", sessionID: "ses_new", part: { text: "partial" } }),
    ].join("\n");
    const handlerA = createOpenCodeHandler({
      workspaceRoot: rootA,
      agentName: "opencode-test-agent-a",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createSupersedeProtocolSupervisor(
        specsA,
        `${partialOutput}\n`,
        `${successfulTurn("ses_new", "done")}\n`,
        // Keep the superseded generation draining while handler B aborts the same
        // numeric generation — the process-global ledger race only appears then.
        { trapPartialSigterm: true, partialHoldMs: 2_000 },
      ),
    });
    const ctxA = context([], [], { agentId: "agent-a", chatId: "chat-a" });
    const bootstrapToken = deliveryToken();
    const { sessionId: sessionIdA } = await handlerA.start(message("boot-a", "bootstrap"), ctxA, bootstrapToken);

    const staleToken = deliveryToken();
    const ownerToken = deliveryToken();
    const staleTurn = handlerA.resume(message("stale-a", "first"), sessionIdA, ctxA, staleToken);
    await vi.waitFor(() => expect(staleToken.processingStarted).toHaveBeenCalled(), {
      timeout: 10_000,
    });
    const ownerTurn = handlerA.resume(message("owner-a", "second"), sessionIdA, ctxA, ownerToken);
    await vi.waitFor(() => expect(ownerToken.processingStarted).toHaveBeenCalled(), {
      timeout: 10_000,
    });

    const writeOutput = [
      JSON.stringify({ type: "step_start", sessionID: "ses_new", part: { sessionID: "ses_new" } }),
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_new",
        part: {
          id: "tool-1",
          tool: "bash",
          state: { status: "completed", input: { command: "touch effect" }, output: "done" },
        },
      }),
    ].join("\n");
    const specsB: ProviderProcessSpec[] = [];
    const handlerB = createOpenCodeHandler({
      workspaceRoot: rootB,
      agentName: "opencode-test-agent-b",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      // Bootstrap consumes generation 1; the unsafe turn reaches generation 2 —
      // the same numeric key A's superseded record still occupies while draining.
      providerProcessSupervisor: createProtocolTurnSupervisor(specsB, [
        { output: `${successfulTurn("ses_new", "boot-b")}\n` },
        { output: `${writeOutput}\n`, holdOpen: true },
      ]),
      opencodeTurnTimeoutMs: 5_000,
    });
    const eventsB: Array<{ kind?: string }> = [];
    const ctxB = context(eventsB, [], { agentId: "agent-b", chatId: "chat-b" });
    const bootBToken = deliveryToken();
    const { sessionId: sessionIdB } = await handlerB.start(message("boot-b", "bootstrap"), ctxB, bootBToken);
    expect(bootBToken.complete).toHaveBeenCalled();

    const unsafeToken = deliveryToken();
    const unsafeTurn = handlerB.resume(message("unsafe-b", "first"), sessionIdB, ctxB, unsafeToken);
    await vi.waitFor(() => expect(eventsB.some((event) => event.kind === "tool_call")).toBe(true), {
      timeout: 10_000,
    });
    await handlerB.suspend("cross-handler isolation");
    await unsafeTurn;
    expect(unsafeToken.retry).not.toHaveBeenCalled();
    expect(unsafeToken.complete).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "unsafe-b" })],
      expect.objectContaining({ status: "error", completion: "consumed", reason: "unsafe_replay" }),
    );

    await Promise.all([staleTurn, ownerTurn]);
    expect(staleToken.complete).not.toHaveBeenCalled();
    expect(staleToken.retry).not.toHaveBeenCalled();
    expect(ownerToken.complete).toHaveBeenCalled();

    await handlerA.shutdown();
    await handlerB.shutdown();
  }, 30_000);

  it("does not admit a stale OpenCode prompt when aborted before the runProcess abort listener", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-admit-race-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const prompts: string[] = [];
    let staleChildPid: number | undefined;
    let handler: ReturnType<typeof createOpenCodeHandler>;
    let abortedDuringSpawn = false;

    const supervisor: ProviderProcessSupervisor = {
      spawn(spec) {
        specs.push(spec);
        if (spec.args[0] === "--version") {
          const child = spawn(process.execPath, ["-e", PROTOCOL_PROVIDER_SCRIPT], {
            ...spec.options,
            env: {
              ...spec.options.env,
              FIRST_TREE_TEST_PROVIDER_OUTPUT_BASE64: Buffer.from("1.18.9\n", "utf8").toString("base64"),
              FIRST_TREE_TEST_PROVIDER_HOLD_OPEN: "0",
            },
          });
          return { child, exited: new Promise<void>((resolve) => child.once("exit", () => resolve())) };
        }
        if (spec.args[0] === "db") {
          const child = spawn(process.execPath, ["-e", PROTOCOL_PROVIDER_SCRIPT], {
            ...spec.options,
            env: {
              ...spec.options.env,
              FIRST_TREE_TEST_PROVIDER_OUTPUT_BASE64: Buffer.from('[{"ready":1}]\n', "utf8").toString("base64"),
              FIRST_TREE_TEST_PROVIDER_HOLD_OPEN: "0",
            },
          });
          return { child, exited: new Promise<void>((resolve) => child.once("exit", () => resolve())) };
        }

        const runIndex = specs.filter((entry) => entry.args[0] === "run").length - 1;
        if (runIndex === 0) {
          const child = spawn(process.execPath, ["-e", PROTOCOL_PROVIDER_SCRIPT], {
            ...spec.options,
            env: {
              ...spec.options.env,
              FIRST_TREE_TEST_PROVIDER_OUTPUT_BASE64: Buffer.from(`${successfulTurn()}\n`, "utf8").toString("base64"),
              FIRST_TREE_TEST_PROVIDER_HOLD_OPEN: "0",
            },
          });
          return { child, exited: new Promise<void>((resolve) => child.once("exit", () => resolve())) };
        }

        const partialOutput = [
          JSON.stringify({ type: "step_start", sessionID: "ses_new", part: { sessionID: "ses_new" } }),
          JSON.stringify({ type: "text", sessionID: "ses_new", part: { text: "partial" } }),
        ].join("\n");
        const child = spawn(process.execPath, ["-e", PROTOCOL_PROVIDER_SCRIPT], {
          ...spec.options,
          env: {
            ...spec.options.env,
            FIRST_TREE_TEST_PROVIDER_OUTPUT_BASE64: Buffer.from(`${partialOutput}\n`, "utf8").toString("base64"),
            FIRST_TREE_TEST_PROVIDER_HOLD_OPEN: "1",
          },
          detached: true,
        });
        staleChildPid = child.pid;
        if (child.stdin) {
          const write = child.stdin.write.bind(child.stdin);
          child.stdin.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
            prompts.push(String(chunk));
            return Reflect.apply(write, child.stdin, [chunk, ...args]);
          }) as typeof child.stdin.write;
        }
        // Abort while still inside spawn — before runProcess registers its abort listener.
        // AbortSignal does not replay, so without the post-listener re-check the stale prompt
        // would still be written and the child would keep running.
        abortedDuringSpawn = true;
        void handler.suspend("abort-before-listener");
        return { child, exited: new Promise<void>((resolve) => child.once("exit", () => resolve())) };
      },
    };

    handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: supervisor,
      opencodeTurnTimeoutMs: 5_000,
    });
    const sessionCtx = context([], []);
    const bootstrapToken = deliveryToken();
    const { sessionId } = await handler.start(message("m-boot", "bootstrap"), sessionCtx, bootstrapToken);

    const staleToken = deliveryToken();
    await handler.resume(message("m-stale", "first"), sessionId, sessionCtx, staleToken);
    expect(abortedDuringSpawn).toBe(true);
    expect(prompts).toEqual([]);
    expect(staleToken.complete).not.toHaveBeenCalled();
    if (staleChildPid !== undefined) {
      const pid = staleChildPid;
      await vi.waitFor(() => {
        try {
          process.kill(pid, 0);
          throw new Error("stale child still alive");
        } catch (error) {
          expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
        }
      });
    }
    await handler.shutdown();
  }, 30_000);

  it("preserves the unsafe-effect fence when private-config cleanup fails after provider exit", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-cleanup-effect-"));
    roots.push(root);
    const output = [
      JSON.stringify({ type: "step_start", sessionID: "ses_new", part: { sessionID: "ses_new" } }),
      JSON.stringify({
        type: "tool_use",
        sessionID: "ses_new",
        part: {
          id: "tool-1",
          tool: "bash",
          state: { status: "completed", input: { command: "touch effect" }, output: "done" },
        },
      }),
      JSON.stringify({ type: "step_finish", sessionID: "ses_new", part: { reason: "stop" } }),
    ].join("\n");
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createProtocolSupervisor([], [`${output}\n`]),
      opencodeConfigProjector: (env: Record<string, string>) => ({
        env,
        transport: "env" as const,
        cleanup: () => {
          throw new Error("private config cleanup failed");
        },
      }),
    });
    const token = deliveryToken();
    await handler.start(message("m-cleanup", "first"), context([], []), token);
    expect(token.retry).not.toHaveBeenCalled();
    expect(token.complete).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "m-cleanup" })],
      expect.objectContaining({ status: "error", completion: "consumed", reason: "unsafe_replay" }),
    );
    await handler.shutdown();
  });

  it("serializes one shared data-home DB gate across handler instances", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-db-shared-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const supervisor = createSyntheticSupervisor(specs, { turnDelayMs: 25 });
    const create = () =>
      createOpenCodeHandler({
        workspaceRoot: root,
        agentName: "opencode-test-agent",
        runtimeProvider: "opencode",
        agentConfigCache: cache(runtimeConfig()),
        opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
        providerProcessSupervisor: supervisor,
      });
    const left = create();
    const right = create();
    await Promise.all([
      left.start(message("m1", "left"), context([], []), deliveryToken()),
      right.start(message("m2", "right"), context([], []), deliveryToken()),
    ]);
    expect(specs.filter((spec) => spec.args[0] === "db")).toHaveLength(1);
    const agentNames = specs
      .filter((spec) => spec.args[0] === "run")
      .map((spec) => spec.args[spec.args.indexOf("--agent") + 1]);
    expect(new Set(agentNames).size).toBe(1);
    await left.shutdown();
    await right.shutdown();
  });

  it("accepts later compatible 1.x releases", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-version-ok-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs, { version: "1.18.9" }),
    });

    await expect(handler.start(message("m1", "submitted"), context([], []), deliveryToken())).resolves.toMatchObject({
      sessionId: "ses_new",
    });
    expect(specs.map((spec) => spec.args[0])).toEqual(["--version", "db", "run"]);
    await handler.shutdown();
  });

  it("fails closed through the supervisor before DB or turn launch outside the supported range", async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ft-opencode-version-"));
    roots.push(root);
    const specs: ProviderProcessSpec[] = [];
    const handler = createOpenCodeHandler({
      workspaceRoot: root,
      agentName: "opencode-test-agent",
      runtimeProvider: "opencode",
      agentConfigCache: cache(runtimeConfig()),
      opencodeBinaryResolver: () => ({ ok: true, binary: "/host/opencode" }),
      providerProcessSupervisor: createSyntheticSupervisor(specs, { version: "2.0.0" }),
    });

    const token = deliveryToken();
    await handler.start(message("m1", "never submitted"), context([], []), token);
    expect(token.complete).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "m1" })],
      expect.objectContaining({ status: "error", completion: "consumed" }),
    );
    expect(specs.map((spec) => spec.args)).toEqual([["--version"]]);
    await handler.shutdown();
  });
});
