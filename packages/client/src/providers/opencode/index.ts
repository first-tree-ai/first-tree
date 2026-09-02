import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import {
  type AgentRuntimeConfig,
  type AgentRuntimeConfigPayload,
  encodeProviderRetryEventMessage,
  isLandingCampaignTrialAgentMetadata,
  runtimeProviderSchema,
  type ToolFileRef,
} from "@first-tree/shared";
import type {
  AgentHandler,
  DeliveryToken,
  HandlerFactory,
  SessionContext,
  SessionMessage,
  TurnConsumedErrorReason,
} from "../../runtime/contracts.js";
import { noopDeliveryToken, requireDeliveryToken } from "../../runtime/contracts.js";
import type {
  AgentConfigCache,
  ProviderAttemptSettlement,
  ProviderProcessSupervisor,
} from "../../runtime/provider-support/index.js";
import {
  assertContextSourceCurrent,
  buildBriefingUpdateNotice,
  buildProviderRetryEvent,
  classifyProviderFailure,
  computeBriefingFingerprint,
  contextSourceFromHandlerConfig,
  createDefaultProviderProcessSupervisor,
  isContextSourceTransitionError,
  isManagedSkillsUnsafeDiscoveryError,
  ProviderAttempt,
  preparationCoordinatesFromSource,
  prepareManagedSession,
  projectManagedWorkspace,
  readSessionBriefingFingerprint,
  redactErrorPreview,
  remoteGitAttributionFromSource,
  renderChatContextPrompt,
  renderRuntimeOutputContract,
  resolveContextTreeRelativePath,
  toolFileRefsFromShellCommand,
  writeSessionBriefingFingerprint,
} from "../../runtime/provider-support/index.js";
import { chunkAssistantText } from "../handlers/assistant-text.js";
import { formatAuthHint, isOpenCodeAuthError } from "../handlers/auth-error-hint.js";
import { consumedErrorOutcome } from "../handlers/turn-settlement.js";
import { PROVIDER_SKILL_ROOTS } from "../skill-roots.js";
import {
  isSupportedOpenCodeVersion,
  OPENCODE_SUPPORTED_VERSION_RANGE,
  parseOpenCodeVersionOutput,
  resolveOpenCodeRuntimeBinary,
} from "./binary.js";
import { type OpenCodeStreamEvent, OpenCodeStreamParser, type OpenCodeUsage } from "./parser.js";
import { acquireOpenCodePrivateConfigLease, type OpenCodePrivateConfigLease } from "./private-config.js";
import {
  describeOpenCodeTurnAbortFailure,
  inferOpenCodeTurnAbortRecord,
  type OpenCodeTurnAbortRecord,
  settlementPolicyForOpenCodeTurnAbort,
} from "./turn-abort.js";

export const OPENCODE_PENDING_SESSION_PREFIX = "opencode-pending-";

const STDERR_TAIL_LIMIT = 8_000;
const DEFAULT_TURN_TIMEOUT_MS = 20 * 60_000;
const KILL_GRACE_MS = 5_000;
const FINAL_CLOSE_WAIT_MS = 2_000;
const DB_GATE_TIMEOUT_MS = 30_000;
const CONFIG_CONTENT_ENV_MAX_BYTES = 16 * 1024;
const WINDOWS_ENV_BLOCK_MAX_CHARS = 30_000;
const PROVIDER_ATTEMPT_WINDOW_TTL_MS = 30 * 60_000;
const MAX_PROVIDER_ATTEMPT_WINDOWS = 512;
const QUEUED_UNSAFE_DISCOVERY_RETRY_BASE_MS = 1_000;
const QUEUED_UNSAFE_DISCOVERY_RETRY_MAX_MS = 30_000;

export function isOpenCodePendingSessionId(sessionId: string): boolean {
  return sessionId.startsWith(OPENCODE_PENDING_SESSION_PREFIX);
}

type OpenCodeMcpConfig =
  | { type: "local"; command: string[]; enabled: true }
  | { type: "remote"; url: string; headers?: Record<string, string>; enabled: true };

export type OpenCodeMcpProjection = {
  servers: Record<string, OpenCodeMcpConfig>;
  aliases: Array<{ configuredName: string; managedName: string }>;
};

export function mapOpenCodeMcpServers(payload: AgentRuntimeConfigPayload, scope: string): OpenCodeMcpProjection {
  const out: Record<string, OpenCodeMcpConfig> = {};
  const aliases: OpenCodeMcpProjection["aliases"] = [];
  for (const [index, server] of payload.mcpServers.entries()) {
    const managedName = `first-tree-${scope}-mcp-${index + 1}`;
    aliases.push({ configuredName: server.name, managedName });
    if (server.transport === "stdio") {
      out[managedName] = {
        type: "local",
        command: [server.command, ...(server.args ?? [])],
        enabled: true,
      };
    } else {
      out[managedName] = {
        type: "remote",
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
        enabled: true,
      };
    }
  }
  return { servers: out, aliases };
}

export function buildOpenCodeConfigContent(input: {
  payload: AgentRuntimeConfigPayload;
  managedAgentName: string;
  scope: string;
}): string {
  const mcp = mapOpenCodeMcpServers(input.payload, input.scope);
  const aliasNotice =
    mcp.aliases.length === 0
      ? ""
      : `\nManaged MCP aliases:\n${mcp.aliases
          .map(({ configuredName, managedName }) => `- ${configuredName}: ${managedName}`)
          .join("\n")}`;
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    agent: {
      [input.managedAgentName]: {
        description: "First Tree managed agent",
        mode: "primary",
        prompt:
          "You are running as a First Tree managed OpenCode agent. Read and follow the workspace AGENTS.md. " +
          "Use the First Tree runtime CLI for teammate communication when instructed." +
          aliasNotice,
        ...(input.payload.model ? { model: input.payload.model } : {}),
        permission: {
          edit: "allow",
          bash: "allow",
          webfetch: "allow",
          websearch: "allow",
          task: "allow",
        },
      },
    },
    mcp: mcp.servers,
  });
}

export function buildOpenCodeTurnArgs(input: {
  cwd: string;
  model: string;
  resumeSessionId: string | null;
  managedAgentName: string;
}): string[] {
  const args = [
    "run",
    "--format",
    "json",
    "--auto",
    "--agent",
    input.managedAgentName,
    "--title",
    "First Tree managed turn",
    "--dir",
    input.cwd,
    "--print-logs",
    "--log-level",
    "ERROR",
  ];
  if (input.model) args.push("--model", input.model);
  if (input.resumeSessionId) args.push("--session", input.resumeSessionId);
  return args;
}

export type OpenCodeConfigProjection = {
  env: Record<string, string>;
  cleanup: () => void;
  transport: "env" | "file";
};

export function projectOpenCodeConfig(
  env: Record<string, string>,
  configContent: string,
  deps: {
    fileStore?: Pick<OpenCodePrivateConfigLease, "materialize">;
    maxEnvBytes?: number;
    maxWindowsEnvChars?: number;
    platform?: NodeJS.Platform;
  } = {},
): OpenCodeConfigProjection {
  const maxEnvBytes = deps.maxEnvBytes ?? CONFIG_CONTENT_ENV_MAX_BYTES;
  const platform = deps.platform ?? process.platform;
  const maxWindowsEnvChars = deps.maxWindowsEnvChars ?? WINDOWS_ENV_BLOCK_MAX_CHARS;
  const privateEnv = { ...env };
  delete privateEnv.OPENCODE_CONFIG_CONTENT;
  const contentEnv = { ...privateEnv, OPENCODE_CONFIG_CONTENT: configContent };
  if (
    Buffer.byteLength(configContent, "utf8") <= maxEnvBytes &&
    (platform !== "win32" || windowsEnvBlockChars(contentEnv) <= maxWindowsEnvChars)
  ) {
    return {
      env: contentEnv,
      cleanup: () => {},
      transport: "env",
    };
  }

  if (privateEnv.OPENCODE_CONFIG) {
    throw new Error(
      "OpenCode private projection is too large for the child environment and cannot replace the host OPENCODE_CONFIG",
    );
  }
  if (!deps.fileStore) {
    throw new Error("OpenCode file-backed projection requires a runtime-owned workspace lease");
  }
  const materialization = deps.fileStore.materialize(configContent);
  const fileEnv = {
    ...privateEnv,
    OPENCODE_CONFIG: materialization.configPath,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ autoupdate: false, share: "disabled", snapshot: false }),
  };
  if (platform === "win32" && windowsEnvBlockChars(fileEnv) > maxWindowsEnvChars) {
    materialization.cleanup();
    throw new Error("OpenCode runtime provider mismatch: child environment exceeds the safe Windows block limit");
  }
  return {
    env: fileEnv,
    cleanup: materialization.cleanup,
    transport: "file",
  };
}

function windowsEnvBlockChars(env: Readonly<Record<string, string>>): number {
  let total = 1;
  for (const [key, value] of Object.entries(env)) total += key.length + 1 + value.length + 1;
  return total;
}

type ProcessOutcome = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
  spawnError?: Error;
};

type TurnState = {
  parser: OpenCodeStreamParser;
  sessionIds: Set<string>;
  terminalReasons: string[];
  errors: string[];
  text: string[];
  usage: OpenCodeUsage | null;
  sawProviderActivity: boolean;
  sawUnsafeTool: boolean;
  protocolDiagnostics: string[];
};

const dbGatePromises = new Map<string, Promise<void>>();
type ProviderTurnFailureWindow = {
  attempt: number;
  touchedAt: number;
  hasPendingDelivery: () => boolean;
};

const providerTurnFailureAttempts = new Map<string, ProviderTurnFailureWindow>();

export function clearOpenCodeDbGateCacheForTests(): void {
  dbGatePromises.clear();
  providerTurnFailureAttempts.clear();
}

export function openCodeProviderAttemptWindowSizeForTests(): number {
  return providerTurnFailureAttempts.size;
}

type OpenCodeRetrySleep = (delayMs: number, signal: AbortSignal) => Promise<boolean | undefined>;
type QueuedDelivery = { message: SessionMessage; token: DeliveryToken };

async function defaultOpenCodeRetrySleep(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise<boolean>((resolveDelay) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolveDelay(completed);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function queuedUnsafeDiscoveryRetryDelayMs(attempt: number): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 30);
  return Math.min(QUEUED_UNSAFE_DISCOVERY_RETRY_BASE_MS * 2 ** exponent, QUEUED_UNSAFE_DISCOVERY_RETRY_MAX_MS);
}

export const createOpenCodeHandler: HandlerFactory = (config) => {
  const workspaceRoot = config.workspaceRoot as string;
  const agentName = typeof config.agentName === "string" ? config.agentName : "";
  const runtimeProvider = runtimeProviderSchema.parse(config.runtimeProvider);
  const agentConfigCache = (config.agentConfigCache as AgentConfigCache | undefined) ?? null;
  const contextSource = contextSourceFromHandlerConfig(config);
  const contextTree = preparationCoordinatesFromSource(contextSource);
  const gitAttribution = remoteGitAttributionFromSource(contextSource);
  const contextTreePath = gitAttribution.contextTreePath;
  const contextTreeRepoUrl = gitAttribution.contextTreeRepoUrl;
  const contextTreeBranch = contextTree.kind === "remote" ? contextTree.branch : null;
  const resolveBinary =
    (config.opencodeBinaryResolver as typeof resolveOpenCodeRuntimeBinary | undefined) ?? resolveOpenCodeRuntimeBinary;
  const processSupervisor =
    (config.providerProcessSupervisor as ProviderProcessSupervisor | undefined) ??
    createDefaultProviderProcessSupervisor();
  const turnTimeoutMs =
    typeof config.opencodeTurnTimeoutMs === "number" && config.opencodeTurnTimeoutMs > 0
      ? config.opencodeTurnTimeoutMs
      : DEFAULT_TURN_TIMEOUT_MS;
  const retrySleep = (config.opencodeRetrySleep as OpenCodeRetrySleep | undefined) ?? defaultOpenCodeRetrySleep;
  const unsafeDiscoverySleep =
    (config.opencodeUnsafeDiscoverySleep as OpenCodeRetrySleep | undefined) ?? defaultOpenCodeRetrySleep;
  const configProjector =
    (config.opencodeConfigProjector as typeof projectOpenCodeConfig | undefined) ?? projectOpenCodeConfig;
  let cwd: string | null = null;
  let ctx: SessionContext | null = null;
  let activeConfig: AgentRuntimeConfig | null = null;
  let binary: string | null = null;
  let providerSessionId: string | null = null;
  let pendingSyntheticId: string | null = null;
  let sessionActive = false;
  let initialTurnPreparing = false;
  let currentAbort: AbortController | null = null;
  let currentTurnPromise: Promise<void> | null = null;
  let versionReady = false;
  let generation = 0;
  let drainScheduled = false;
  let drainInProgress = false;
  let currentDrainPromise: Promise<void> | null = null;
  let drainingBatch: QueuedDelivery[] | null = null;
  let unsafeDiscoveryParkedBatch: QueuedDelivery[] | null = null;
  let unsafeDiscoveryWaitAbort: AbortController | null = null;
  let drainCancellationReason: string | null = null;
  let pendingChatContextPrompt: string | null = null;
  let projectionScope: string | null = null;
  let managedAgentName: string | null = null;
  const handlerGenerationId = randomUUID().replaceAll("-", "");
  let privateConfigLease: OpenCodePrivateConfigLease | null = null;
  const queue: QueuedDelivery[] = [];
  const turnAbortRecords = new Map<number, OpenCodeTurnAbortRecord>();

  function markTurnAborted(turnGeneration: number, record: OpenCodeTurnAbortRecord): void {
    if (!turnAbortRecords.has(turnGeneration)) {
      turnAbortRecords.set(turnGeneration, record);
    }
  }

  function takeTurnAbortRecord(turnGeneration: number): OpenCodeTurnAbortRecord | null {
    const record = turnAbortRecords.get(turnGeneration) ?? null;
    turnAbortRecords.delete(turnGeneration);
    return record;
  }

  function deliveryAttemptKey(sessionCtx: SessionContext, messages: readonly SessionMessage[]): string {
    const deliveryHead = messages[0];
    if (!deliveryHead) {
      throw new Error("OpenCode provider attempt requires a delivery head");
    }
    return `${sessionCtx.agent.agentId}\0${sessionCtx.chatId}\0${deliveryHead.inboxEntryId}\0${deliveryHead.id}`;
  }

  function nextProviderAttempt(
    attemptKey: string,
    hasPendingDelivery: ProviderTurnFailureWindow["hasPendingDelivery"],
  ): number {
    const now = Date.now();
    for (const [key, entry] of providerTurnFailureAttempts) {
      let pending = true;
      try {
        pending = entry.hasPendingDelivery();
      } catch {
        // Observer failure is not authority to forget an unacked delivery.
      }
      if (!pending && now - entry.touchedAt >= PROVIDER_ATTEMPT_WINDOW_TTL_MS) {
        providerTurnFailureAttempts.delete(key);
      }
    }
    const existing = providerTurnFailureAttempts.get(attemptKey);
    const attempt = (existing?.attempt ?? 0) + 1;
    while (!existing && providerTurnFailureAttempts.size >= MAX_PROVIDER_ATTEMPT_WINDOWS) {
      const abandoned = [...providerTurnFailureAttempts]
        .sort((left, right) => left[1].touchedAt - right[1].touchedAt)
        .find(([, entry]) => {
          try {
            return !entry.hasPendingDelivery();
          } catch {
            return false;
          }
        });
      if (!abandoned) {
        throw new Error("OpenCode provider attempt ledger is full of pending deliveries");
      }
      providerTurnFailureAttempts.delete(abandoned[0]);
    }
    providerTurnFailureAttempts.delete(attemptKey);
    providerTurnFailureAttempts.set(attemptKey, { attempt, touchedAt: now, hasPendingDelivery });
    return attempt;
  }

  function buildEnv(sessionCtx: SessionContext, payload: AgentRuntimeConfigPayload): Record<string, string> {
    const base: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") base[key] = value;
    }
    for (const entry of payload.env) base[entry.key] = entry.value;
    const merged = sessionCtx.buildAgentEnv(base);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(merged)) {
      if (typeof value === "string") env[key] = value;
    }
    delete env.OPENCODE_CONFIG_CONTENT;
    return env;
  }

  async function refreshProjection(sessionCtx: SessionContext): Promise<{
    payload: AgentRuntimeConfigPayload;
    briefing: string;
  }> {
    if (!cwd) throw new Error("OpenCode workspace is not prepared");
    let runtimeConfig = activeConfig;
    const existingPayload = activeConfig?.payload;
    if (agentConfigCache) {
      runtimeConfig = await agentConfigCache.refresh(sessionCtx.agent.agentId);
    }
    const payload: AgentRuntimeConfigPayload =
      runtimeConfig?.payload ??
      ({
        kind: "opencode",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      } satisfies AgentRuntimeConfigPayload);
    if (payload.kind !== "opencode") {
      throw new Error(`OpenCode handler received ${payload.kind} runtime config`);
    }
    const projected = await projectManagedWorkspace({
      sessionCtx,
      workspace: cwd,
      agentName,
      runtimeProvider,
      providerSkillRoots: PROVIDER_SKILL_ROOTS,
      runtimeConfig,
      payload,
      payloadResolved: runtimeConfig !== null,
      existingPayload,
      contextTree: {
        kind: contextTree.kind,
        path: contextTree.path,
        repoUrl: contextTree.repoUrl,
        branch: contextTree.branch,
      },
      reresolveSource: true,
      markInitComplete: true,
    });
    activeConfig = runtimeConfig;
    return { payload, briefing: projected.briefing };
  }

  function runProcess(input: {
    command: string;
    args: string[];
    prompt?: string;
    env: Record<string, string>;
    workspaceCwd: string;
    state?: TurnState;
    sessionCtx: SessionContext;
    abortSignal: AbortSignal;
    timeoutMs: number;
    turnGeneration: number;
    label: string;
  }): Promise<ProcessOutcome> {
    return new Promise((resolveOutcome) => {
      const abortedBeforeSpawn = input.abortSignal.aborted || generation !== input.turnGeneration || !sessionActive;
      if (abortedBeforeSpawn) {
        resolveOutcome({
          exitCode: null,
          signal: "SIGTERM",
          stdoutTail: "",
          stderrTail: "",
        });
        return;
      }

      let supervised: ReturnType<ProviderProcessSupervisor["spawn"]>;
      try {
        supervised = processSupervisor.spawn({
          command: input.command,
          args: input.args,
          label: input.label,
          timeoutMs: input.timeoutMs,
          options: {
            cwd: input.workspaceCwd,
            env: input.env,
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            ...(process.platform === "win32" ? {} : { detached: true }),
          },
        });
      } catch (error) {
        resolveOutcome({
          exitCode: null,
          signal: null,
          stdoutTail: "",
          stderrTail: "",
          spawnError: error instanceof Error ? error : new Error(String(error)),
        });
        return;
      }
      const child = supervised.child;
      let stdoutTail = "";
      let stderrTail = "";
      let closed: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null;
      let stdoutEnded = false;
      let settled = false;
      let spawnError: Error | undefined;

      const finish = (): void => {
        if (settled || !closed || !stdoutEnded) return;
        settled = true;
        resolveOutcome({ ...closed, stdoutTail, stderrTail, spawnError });
      };
      const handleEvents = (events: OpenCodeStreamEvent[]): void => {
        if (!input.state) return;
        for (const event of events) {
          try {
            handleEvent(event, input.state, input.sessionCtx);
          } catch (error) {
            input.sessionCtx.log(
              `OpenCode event handling failed (${event.kind}): ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      };
      const terminate = (): void => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
          else child.kill("SIGTERM");
        } catch {
          // The process may already be gone.
        }
        const hardKill = setTimeout(() => {
          try {
            if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            // Ignore a completed process.
          }
        }, KILL_GRACE_MS);
        hardKill.unref?.();
        const finalWait = setTimeout(() => {
          stdoutEnded = true;
          closed ??= { exitCode: null, signal: "SIGKILL" };
          finish();
        }, KILL_GRACE_MS + FINAL_CLOSE_WAIT_MS);
        finalWait.unref?.();
      };
      input.abortSignal.addEventListener("abort", terminate, { once: true });

      child.on("error", (error) => {
        spawnError = error;
        closed ??= { exitCode: null, signal: null };
        stdoutEnded = true;
        finish();
      });
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdoutTail = (stdoutTail + chunk).slice(-STDERR_TAIL_LIMIT);
        if (input.state && !input.abortSignal.aborted && generation === input.turnGeneration) {
          handleEvents(input.state.parser.push(chunk));
        }
      });
      child.stdout?.on("end", () => {
        if (input.state && !input.abortSignal.aborted && generation === input.turnGeneration) {
          handleEvents(input.state.parser.flush());
        }
        stdoutEnded = true;
        finish();
      });
      child.stdout?.on("error", () => {
        stdoutEnded = true;
        finish();
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      });
      child.on("close", (exitCode, signal) => {
        input.abortSignal.removeEventListener("abort", terminate);
        closed = { exitCode, signal };
        finish();
      });
      child.stdin?.on("error", () => {
        // EPIPE is classified from close + stderr.
      });
      // Abort that won during spawn (before this listener) does not replay — close that race.
      if (input.abortSignal.aborted || generation !== input.turnGeneration || !sessionActive) {
        terminate();
        try {
          child.stdin?.end();
        } catch {
          // stdin may already be closed.
        }
        return;
      }
      if (input.prompt !== undefined) child.stdin?.write(input.prompt);
      child.stdin?.end();
    });
  }

  function handleEvent(event: OpenCodeStreamEvent, state: TurnState, sessionCtx: SessionContext): void {
    sessionCtx.recordProviderActivity();
    state.sawProviderActivity = true;
    switch (event.kind) {
      case "session":
        state.sessionIds.add(event.sessionId);
        break;
      case "text":
        state.text.push(event.text);
        break;
      case "tool":
        if (!isReadOnlyTool(event.name)) state.sawUnsafeTool = true;
        {
          const toolFileRefs = event.status === "pending" ? undefined : fileRefsForTool(event.name, event.args);
          sessionCtx.emitEvent({
            kind: "tool_call",
            payload: {
              toolUseId: event.toolUseId,
              name: event.name,
              args: event.args,
              status: event.status,
              ...(event.resultPreview ? { resultPreview: event.resultPreview } : {}),
              ...(toolFileRefs && toolFileRefs.length > 0 ? { toolFileRefs } : {}),
            },
          });
        }
        break;
      case "usage":
        state.usage = event.usage;
        break;
      case "terminal":
        state.terminalReasons.push(event.reason);
        break;
      case "error":
        state.errors.push(event.message);
        break;
      case "reasoning":
        break;
      case "unknown":
        if (state.protocolDiagnostics.length < 5) {
          sessionCtx.log(`OpenCode protocol diagnostic: ${event.note}`);
        }
        state.protocolDiagnostics.push(event.note);
        break;
    }
  }

  function fileRefsForTool(name: string, args: unknown): ToolFileRef[] | undefined {
    if (!cwd) return undefined;
    const values = asRecord(args);
    if (name.toLowerCase() === "bash") {
      const command = typeof values?.command === "string" ? values.command : null;
      if (!command) return undefined;
      return toolFileRefsFromShellCommand({
        command,
        cwd,
        contextTreePath,
        contextTreeRepoUrl,
        contextTreeBranch,
      });
    }
    const rawPath =
      typeof values?.path === "string"
        ? values.path
        : typeof values?.filePath === "string"
          ? values.filePath
          : typeof values?.file_path === "string"
            ? values.file_path
            : null;
    if (!rawPath) return undefined;
    const absolutePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
    const repoRelativePath = resolveContextTreeRelativePath(absolutePath, {
      contextTreePath,
      contextTreeRepoUrl,
    });
    const write = /^(edit|write|patch)$/i.test(name);
    return [
      {
        origin: write ? "file_change" : "tool_arg",
        localPath: rawPath,
        pathKind: "file",
        ...(contextTreeRepoUrl && repoRelativePath && repoRelativePath !== "/"
          ? {
              repoUrl: contextTreeRepoUrl,
              ...(contextTreeBranch ? { repoBranch: contextTreeBranch } : {}),
              repoRelativePath,
            }
          : {}),
      },
    ];
  }

  async function ensureDbReady(input: {
    activeBinary: string;
    env: Record<string, string>;
    workspaceCwd: string;
    sessionCtx: SessionContext;
    abortSignal: AbortSignal;
    turnGeneration: number;
  }): Promise<void> {
    const dataHome = input.env.XDG_DATA_HOME ?? input.env.APPDATA ?? input.env.HOME ?? "";
    const key = `${input.activeBinary}\0${dataHome}`;
    let gate = dbGatePromises.get(key);
    if (!gate) {
      gate = (async () => {
        const outcome = await runProcess({
          command: input.activeBinary,
          args: ["db", "SELECT 1 AS ready", "--format", "json"],
          env: input.env,
          workspaceCwd: input.workspaceCwd,
          sessionCtx: input.sessionCtx,
          abortSignal: input.abortSignal,
          timeoutMs: DB_GATE_TIMEOUT_MS,
          turnGeneration: input.turnGeneration,
          label: "opencode database readiness",
        });
        if (outcome.spawnError || outcome.exitCode !== 0) {
          throw (
            outcome.spawnError ??
            new Error(`OpenCode database readiness failed (${outcome.exitCode}): ${outcome.stderrTail}`)
          );
        }
      })().catch((error) => {
        dbGatePromises.delete(key);
        throw error;
      });
      dbGatePromises.set(key, gate);
    }
    await gate;
  }

  async function ensureSupportedVersion(input: {
    activeBinary: string;
    env: Record<string, string>;
    workspaceCwd: string;
    sessionCtx: SessionContext;
    abortSignal: AbortSignal;
    turnGeneration: number;
  }): Promise<void> {
    if (versionReady) return;
    const outcome = await runProcess({
      command: input.activeBinary,
      args: ["--version"],
      env: input.env,
      workspaceCwd: input.workspaceCwd,
      sessionCtx: input.sessionCtx,
      abortSignal: input.abortSignal,
      timeoutMs: DB_GATE_TIMEOUT_MS,
      turnGeneration: input.turnGeneration,
      label: "opencode compatible-version gate",
    });
    const version = parseOpenCodeVersionOutput(`${outcome.stdoutTail}\n${outcome.stderrTail}`);
    if (outcome.spawnError || outcome.exitCode !== 0 || !isSupportedOpenCodeVersion(version)) {
      const detail = redactErrorPreview(
        outcome.spawnError?.message || outcome.stderrTail || outcome.stdoutTail || `exit ${outcome.exitCode}`,
        800,
      );
      throw new Error(
        `OpenCode runtime provider mismatch: unsupported version. First Tree requires ${OPENCODE_SUPPORTED_VERSION_RANGE}; ` +
          `observed ${version ?? "no parseable version"}. ${detail}`,
      );
    }
    versionReady = true;
  }

  function adoptSessionId(sessionCtx: SessionContext, id: string): void {
    if (providerSessionId === id) return;
    const synthetic = pendingSyntheticId;
    providerSessionId = id;
    if (synthetic) {
      pendingSyntheticId = null;
      sessionCtx.replaceSessionId?.(id, "opencode_session_id_confirmed");
      if (cwd) {
        const baseline = readSessionBriefingFingerprint(cwd, synthetic);
        if (baseline) writeSessionBriefingFingerprint(cwd, id, baseline);
      }
    }
  }

  function emitProviderTurnSettlementEvent(sessionCtx: SessionContext, settlement: ProviderAttemptSettlement): void {
    sessionCtx.emitEvent({
      kind: "error",
      payload: {
        source: "runtime",
        message: encodeProviderRetryEventMessage(settlement.eventPayload),
      },
    });
  }

  function emitQueuedUnsafeDiscoveryBlocked(
    sessionCtx: SessionContext,
    error: Error,
    attempt: number,
    delayMs: number,
  ): void {
    const classification = classifyProviderFailure(error, {
      provider: runtimeProvider,
      scope: "provider_turn",
      source: "bind",
    });
    const payload = buildProviderRetryEvent({
      event: "provider_retry_scheduled",
      provider: runtimeProvider,
      scope: "provider_turn",
      classification,
      decision: {
        action: "retry",
        delayMs,
        reasonCode: classification.reasonCode,
        attempt,
        retryMode: "background",
        replaySafety: "pre_provider",
        userSeverity: "warning",
      },
      messagePreview:
        "Queued delivery remains unacknowledged because First Tree cannot safely reconcile managed OpenCode Skills. " +
        `${error.message}`,
    });
    sessionCtx.emitEvent({
      kind: "error",
      payload: {
        source: "runtime",
        message: encodeProviderRetryEventMessage(payload),
      },
    });
  }

  function consumedReasonForProviderSettlement(settlement: ProviderAttemptSettlement): TurnConsumedErrorReason {
    return settlement.decision.action === "stop" && settlement.decision.terminalKind === "capacity_wait_required"
      ? "capacity_wait_required"
      : settlement.decision.action === "stop" && settlement.decision.terminalKind === "exhausted"
        ? "provider_retry_exhausted"
        : settlement.decision.reasonCode;
  }

  async function settleFailure(input: {
    failure: string;
    classificationError?: string;
    spawnError?: Error;
    state: Pick<TurnState, "sawProviderActivity" | "sawUnsafeTool" | "text">;
    sessionCtx: SessionContext;
    messages: readonly SessionMessage[];
    token: DeliveryToken;
    turnGeneration: number;
  }): Promise<boolean> {
    const attemptKey = deliveryAttemptKey(input.sessionCtx, input.messages);
    const replaySafety = input.state.sawUnsafeTool
      ? "unsafe"
      : input.state.text.length > 0
        ? "user_visible"
        : input.state.sawProviderActivity
          ? "pre_visible"
          : "pre_provider";
    const classificationError = input.classificationError ?? input.failure;
    const displayMessage = isOpenCodeAuthError(input.failure)
      ? formatAuthHint("opencode", input.failure)
      : input.failure;
    const attempt = new ProviderAttempt({
      provider: runtimeProvider,
      scope: "provider_turn",
      source: input.spawnError ? "sdk" : "stream",
      replaySafety,
    });
    attempt.recordSignal({
      kind: input.spawnError ? "local_error" : "provider_error",
      error: input.spawnError ?? new Error(classificationError),
      messagePreview: classificationError,
    });
    if (displayMessage !== classificationError) {
      attempt.recordSignal({
        kind: "diagnostic",
        error: new Error(displayMessage),
        messagePreview: displayMessage,
      });
    }
    const attemptNumber = nextProviderAttempt(
      attemptKey,
      () => input.sessionCtx.hasPendingDelivery?.(input.messages) ?? true,
    );
    const settlement = attempt.settle({ attempt: attemptNumber });
    if (!settlement) {
      input.token.retry(input.messages, "opencode_unclassified_failure");
      return false;
    }

    emitProviderTurnSettlementEvent(input.sessionCtx, settlement);
    input.sessionCtx.emitEvent({
      kind: "error",
      payload: { source: "sdk", message: displayMessage },
    });
    input.sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
    if (settlement.decision.action === "retry") {
      const delayAbort = new AbortController();
      if (generation === input.turnGeneration && sessionActive) {
        currentAbort = delayAbort;
      }
      const completedDelay = await retrySleep(settlement.decision.delayMs, delayAbort.signal);
      if (
        completedDelay === false ||
        delayAbort.signal.aborted ||
        generation !== input.turnGeneration ||
        !sessionActive
      ) {
        return false;
      }
      input.token.retry(input.messages, settlement.decision.reasonCode);
      if (input.state.sawProviderActivity) {
        input.sessionCtx.failSessionForRecovery?.("opencode_turn_retryable_failure", providerSessionId ?? undefined);
      }
      return false;
    }
    const completion = await input.token.complete(
      input.messages,
      consumedErrorOutcome(consumedReasonForProviderSettlement(settlement)),
    );
    if (completion === "retry") return false;
    providerTurnFailureAttempts.delete(attemptKey);
    pendingChatContextPrompt = null;
    return true;
  }

  async function runTurn(
    prompt: string,
    sessionCtx: SessionContext,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
    unsafeDiscoveryAction: "retry" | "throw" = "retry",
  ): Promise<boolean> {
    const workspaceCwd = cwd;
    const activeBinary = binary;
    const activeProjectionScope = projectionScope;
    const activeManagedAgentName = managedAgentName;
    const activePrivateConfigLease = privateConfigLease;
    if (
      !workspaceCwd ||
      !activeBinary ||
      !activeProjectionScope ||
      !activeManagedAgentName ||
      !activePrivateConfigLease ||
      !sessionActive
    ) {
      token.retry(messages, sessionActive ? "opencode_not_prepared" : "opencode_session_inactive");
      return false;
    }
    const turnGeneration = ++generation;
    const previousAbort = currentAbort;
    if (previousAbort) {
      markTurnAborted(generation - 1, { cause: "superseded", disposition: "silent" });
      previousAbort.abort();
    }
    const abort = new AbortController();
    currentAbort = abort;
    let observedState: TurnState | null = null;
    const promise = (async () => {
      const { payload } = await refreshProjection(sessionCtx);
      const env = buildEnv(sessionCtx, payload);
      await ensureSupportedVersion({
        activeBinary,
        env,
        workspaceCwd,
        sessionCtx,
        abortSignal: abort.signal,
        turnGeneration,
      });
      await ensureDbReady({
        activeBinary,
        env,
        workspaceCwd,
        sessionCtx,
        abortSignal: abort.signal,
        turnGeneration,
      });
      if (abort.signal.aborted || generation !== turnGeneration || !sessionActive) return false;
      await assertContextSourceCurrent({
        sessionCtx,
        sourceAuthorityRoot: workspaceRoot,
        contextTree: {
          kind: contextTree.kind,
          path: contextTree.path,
          repoUrl: contextTree.repoUrl,
          branch: contextTree.branch,
        },
      });
      if (abort.signal.aborted || generation !== turnGeneration || !sessionActive) return false;

      const oneShotPrompt = pendingChatContextPrompt;
      const providerPrompt = oneShotPrompt ? `${oneShotPrompt}\n\n${prompt}` : prompt;
      const expectedSessionId = providerSessionId;
      const state: TurnState = {
        parser: new OpenCodeStreamParser(),
        sessionIds: new Set(),
        terminalReasons: [],
        errors: [],
        text: [],
        usage: null,
        sawProviderActivity: false,
        sawUnsafeTool: false,
        protocolDiagnostics: [],
      };
      observedState = state;
      token.processingStarted(messages);
      const timeout = setTimeout(() => {
        markTurnAborted(turnGeneration, { cause: "timeout", disposition: "settle" });
        abort.abort();
      }, turnTimeoutMs);
      timeout.unref?.();
      let outcome: ProcessOutcome;
      try {
        const configProjection = configProjector(
          env,
          buildOpenCodeConfigContent({
            payload,
            managedAgentName: activeManagedAgentName,
            scope: activeProjectionScope,
          }),
          { fileStore: activePrivateConfigLease },
        );
        try {
          outcome = await runProcess({
            command: activeBinary,
            args: buildOpenCodeTurnArgs({
              cwd: workspaceCwd,
              model: payload.model,
              resumeSessionId: expectedSessionId,
              managedAgentName: activeManagedAgentName,
            }),
            prompt: `${providerPrompt}\n`,
            env: configProjection.env,
            workspaceCwd,
            state,
            sessionCtx,
            abortSignal: abort.signal,
            timeoutMs: turnTimeoutMs,
            turnGeneration,
            label: `opencode turn ${sessionCtx.chatId}`,
          });
        } finally {
          configProjection.cleanup();
        }
      } finally {
        clearTimeout(timeout);
      }

      if (abort.signal.aborted || generation !== turnGeneration || !sessionActive) {
        const record =
          takeTurnAbortRecord(turnGeneration) ??
          inferOpenCodeTurnAbortRecord({
            turnGeneration,
            currentGeneration: generation,
            sessionActive,
            timedOut: false,
            abortSignal: abort.signal,
          });
        if (record.disposition === "silent") {
          return false;
        }
        const failure = describeOpenCodeTurnAbortFailure({
          cause: record.cause,
          turnTimeoutMs,
          state,
        });
        const { classificationError } = settlementPolicyForOpenCodeTurnAbort(record.cause);
        return settleFailure({
          failure,
          classificationError,
          spawnError: new Error(classificationError),
          state,
          sessionCtx,
          messages,
          token,
          turnGeneration,
        });
      }

      const ids = [...state.sessionIds];
      const protocolErrors: string[] = [];
      if (ids.length !== 1) protocolErrors.push(`expected one session ID, observed ${ids.length}`);
      if (expectedSessionId && ids[0] !== expectedSessionId) {
        protocolErrors.push(`resume session mismatch: expected ${expectedSessionId}, observed ${ids[0] ?? "none"}`);
      }
      if (state.terminalReasons.length !== 1) {
        protocolErrors.push(`expected one terminal step_finish event, observed ${state.terminalReasons.length}`);
      }
      if (state.errors.length > 0) protocolErrors.push(...state.errors);
      if (state.protocolDiagnostics.length > 0) {
        protocolErrors.push(
          `unsupported or malformed OpenCode JSONL (${state.protocolDiagnostics.length} line${
            state.protocolDiagnostics.length === 1 ? "" : "s"
          })`,
        );
      }
      if (/agent\s+["'][^"']+["']\s+not found.*falling back to default agent/i.test(outcome.stderrTail)) {
        protocolErrors.push("managed agent was not selected");
      }

      const success = !outcome.spawnError && outcome.exitCode === 0 && protocolErrors.length === 0;
      if (success) {
        const id = ids[0];
        if (!id) throw new Error("OpenCode success without session ID");
        adoptSessionId(sessionCtx, id);
        const finalText = state.text.join("");
        for (const chunk of chunkAssistantText(finalText)) {
          sessionCtx.emitEvent({ kind: "assistant_text", payload: { text: chunk } });
        }
        if (state.usage) {
          sessionCtx.emitEvent({
            kind: "token_usage",
            payload: {
              provider: "opencode",
              model: payload.model || "opencode-default",
              inputTokens: state.usage.inputTokens,
              cachedInputTokens: state.usage.cachedInputTokens,
              outputTokens: state.usage.outputTokens,
            },
          });
        }
        try {
          await sessionCtx.forwardResult(finalText);
        } catch (error) {
          sessionCtx.emitEvent({
            kind: "error",
            payload: {
              source: "runtime",
              message: `forwardResult failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2000),
            },
          });
          sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
          const completion = await token.complete(messages, {
            status: "error",
            completion: "consumed",
            reason: "forward_failed",
          });
          if (completion === "retry") return false;
          providerTurnFailureAttempts.delete(deliveryAttemptKey(sessionCtx, messages));
          pendingChatContextPrompt = null;
          return true;
        }
        sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "success" } });
        const completion = await token.complete(messages, { status: "success" });
        if (completion === "retry") return false;
        providerTurnFailureAttempts.delete(deliveryAttemptKey(sessionCtx, messages));
        if (pendingChatContextPrompt === oneShotPrompt) pendingChatContextPrompt = null;
        return true;
      }

      const rawFailure = [
        ...protocolErrors,
        outcome.spawnError?.message,
        outcome.stderrTail,
        outcome.exitCode === null ? `signal ${outcome.signal ?? "unknown"}` : `exit ${outcome.exitCode}`,
      ]
        .filter((value): value is string => Boolean(value?.trim()))
        .join("\n")
        .slice(0, 2000);
      const failure = redactErrorPreview(rawFailure, 2000);
      return settleFailure({
        failure,
        ...(outcome.spawnError ? { spawnError: outcome.spawnError } : {}),
        state,
        sessionCtx,
        messages,
        token,
        turnGeneration,
      });
    })();
    currentTurnPromise = promise.then(
      () => {},
      () => {},
    );
    try {
      return await promise;
    } catch (error) {
      if (isContextSourceTransitionError(error)) {
        token.retry(messages, "opencode_context_source_changed");
        sessionCtx.failSessionForRecovery?.("opencode_context_source_changed", providerSessionId ?? undefined);
        return false;
      }
      if (isManagedSkillsUnsafeDiscoveryError(error)) {
        if (unsafeDiscoveryAction === "throw") throw error;
        token.retry(messages, "opencode_managed_skills_unsafe");
        sessionCtx.log(`blocked provider turn: ${error.message}`);
        return false;
      }
      const failure = redactErrorPreview(error instanceof Error ? error.message : String(error), 2000);
      return await settleFailure({
        failure,
        spawnError: error instanceof Error ? error : new Error(String(error)),
        state: observedState ?? { sawProviderActivity: false, sawUnsafeTool: false, text: [] },
        sessionCtx,
        messages,
        token,
        turnGeneration,
      });
    } finally {
      turnAbortRecords.delete(turnGeneration);
      if (generation === turnGeneration) {
        currentAbort = null;
        currentTurnPromise = null;
        scheduleDrain();
      }
    }
  }

  async function prepareSession(sessionCtx: SessionContext): Promise<{
    briefing: string;
    workspaceCwd: string;
  }> {
    if (isLandingCampaignTrialAgentMetadata(sessionCtx.agent.metadata)) {
      throw new Error("landing campaign trial agents require the codex app-server runtime");
    }
    ctx = sessionCtx;
    projectionScope = stableOpenCodeScope(sessionCtx.agent.agentId);
    managedAgentName = `first-tree-${projectionScope}`;
    const resolution = resolveBinary(process.env);
    if (!resolution.ok) {
      throw new Error(resolution.error);
    }
    binary = resolution.binary;
    sessionCtx.log(`OpenCode binary: ${resolution.binary}`);

    let runtimeConfig = activeConfig;
    if (agentConfigCache) {
      runtimeConfig = await agentConfigCache.refresh(sessionCtx.agent.agentId);
    }
    const payload: AgentRuntimeConfigPayload =
      runtimeConfig?.payload ??
      ({
        kind: "opencode",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      } satisfies AgentRuntimeConfigPayload);
    if (payload.kind !== "opencode") {
      throw new Error(`OpenCode handler received ${payload.kind} runtime config`);
    }

    const prepared = await prepareManagedSession({
      sessionCtx,
      workspaceRoot,
      agentName,
      runtimeProvider,
      providerSkillRoots: PROVIDER_SKILL_ROOTS,
      runtimeConfig,
      payload,
      payloadResolved: runtimeConfig !== null,
      contextTree: {
        kind: contextTree.kind,
        path: contextTree.path,
        repoUrl: contextTree.repoUrl,
        branch: contextTree.branch,
      },
    });
    cwd = prepared.workspace;
    activeConfig = runtimeConfig;
    pendingChatContextPrompt = [renderRuntimeOutputContract(), renderChatContextPrompt(prepared.chatContext)]
      .filter(Boolean)
      .join("\n\n");
    privateConfigLease ??= await acquireOpenCodePrivateConfigLease({
      workspace: cwd,
      callerScope: stableOpenCodeScope(`${sessionCtx.agent.agentId}\0${sessionCtx.chatId}`),
      handlerId: handlerGenerationId,
    });
    sessionActive = true;
    return { briefing: prepared.briefing, workspaceCwd: cwd };
  }

  function finishDrainingBatch(batch: QueuedDelivery[]): void {
    if (unsafeDiscoveryParkedBatch === batch) unsafeDiscoveryParkedBatch = null;
    if (drainingBatch === batch) drainingBatch = null;
  }

  function retryDrainingBatch(batch: QueuedDelivery[], reason: string): void {
    if (drainingBatch !== batch && unsafeDiscoveryParkedBatch !== batch) return;
    finishDrainingBatch(batch);
    for (const entry of batch) entry.token.retry(entry.message, reason);
  }

  async function runQueued(drained: QueuedDelivery[], sessionCtx: SessionContext): Promise<void> {
    const token = drained[0]?.token;
    if (!token) return;
    const messages = drained.map((entry) => entry.message);
    const parts: string[] = [];
    try {
      for (const message of messages) parts.push(await sessionCtx.formatInboundContent(message));
    } catch (error) {
      sessionCtx.log(`OpenCode queued formatting failed: ${error instanceof Error ? error.message : String(error)}`);
      retryDrainingBatch(drained, "opencode_queued_format_failed");
      return;
    }

    let unsafeAttempt = 0;
    while (sessionActive && drainingBatch === drained) {
      const sessionKey = providerSessionId ?? pendingSyntheticId;
      let fingerprint: string | null = null;
      try {
        const turnParts = [...parts];
        if (cwd && sessionKey) {
          const projection = await refreshProjection(sessionCtx);
          fingerprint = computeBriefingFingerprint(projection.briefing);
          if (readSessionBriefingFingerprint(cwd, sessionKey) !== fingerprint) {
            turnParts.unshift(buildBriefingUpdateNotice(join(cwd, "AGENTS.md")));
          }
        }
        const delivered = await runTurn(turnParts.join("\n\n"), sessionCtx, messages, token, "throw");
        if (delivered && fingerprint && cwd && sessionKey) {
          writeSessionBriefingFingerprint(cwd, providerSessionId ?? sessionKey, fingerprint);
        }
        finishDrainingBatch(drained);
        return;
      } catch (error) {
        if (isContextSourceTransitionError(error)) {
          retryDrainingBatch(drained, "opencode_context_source_changed");
          sessionCtx.failSessionForRecovery?.("opencode_context_source_changed", providerSessionId ?? undefined);
          return;
        }
        if (!isManagedSkillsUnsafeDiscoveryError(error)) throw error;
        if (!sessionActive || drainingBatch !== drained) return;

        unsafeDiscoveryParkedBatch = drained;
        unsafeAttempt += 1;
        const delayMs = queuedUnsafeDiscoveryRetryDelayMs(unsafeAttempt);
        emitQueuedUnsafeDiscoveryBlocked(sessionCtx, error, unsafeAttempt, delayMs);
        sessionCtx.log(
          `OpenCode queued turn blocked by unsafe managed-skill discovery; retrying in ${delayMs}ms: ${error.message}`,
        );
        const waitAbort = new AbortController();
        unsafeDiscoveryWaitAbort = waitAbort;
        const completedDelay = await unsafeDiscoverySleep(delayMs, waitAbort.signal);
        if (unsafeDiscoveryWaitAbort === waitAbort) unsafeDiscoveryWaitAbort = null;
        if (!completedDelay) {
          if (!drainCancellationReason && sessionActive && drainingBatch === drained) {
            throw new Error("OpenCode queued unsafe-discovery wait ended without lifecycle cancellation");
          }
          return;
        }
      }
    }
  }

  function scheduleDrain(): void {
    if (
      drainScheduled ||
      drainInProgress ||
      drainingBatch ||
      queue.length === 0 ||
      !ctx ||
      !sessionActive ||
      currentTurnPromise ||
      initialTurnPreparing
    ) {
      return;
    }
    drainScheduled = true;
    setImmediate(() => {
      drainScheduled = false;
      if (
        drainInProgress ||
        drainingBatch ||
        queue.length === 0 ||
        !ctx ||
        !sessionActive ||
        currentTurnPromise ||
        initialTurnPreparing
      ) {
        scheduleDrain();
        return;
      }
      const drained = queue.splice(0);
      const sessionCtx = ctx;
      drainingBatch = drained;
      drainInProgress = true;
      const drainPromise = runQueued(drained, sessionCtx)
        .catch((error) => {
          const cancellationReason = drainCancellationReason;
          if (cancellationReason) {
            retryDrainingBatch(drained, cancellationReason);
            return;
          }
          sessionCtx.log(`OpenCode queued turn failed: ${error instanceof Error ? error.message : String(error)}`);
          retryDrainingBatch(drained, "opencode_queued_turn_failed");
        })
        .finally(() => {
          if (!drainCancellationReason && drainingBatch === drained) finishDrainingBatch(drained);
          drainInProgress = false;
          if (currentDrainPromise === drainPromise) currentDrainPromise = null;
          scheduleDrain();
        });
      currentDrainPromise = drainPromise;
      void drainPromise;
    });
  }

  function retryQueue(reason: string): void {
    for (const entry of queue.splice(0)) entry.token.retry(entry.message, reason);
  }

  return {
    async start(message, sessionCtx, token) {
      const deliveryToken = token;
      initialTurnPreparing = true;
      let completed = false;
      let delivered = false;
      let briefing: string;
      let workspaceCwd: string;
      try {
        ({ briefing, workspaceCwd } = await prepareSession(sessionCtx));
        const prompt = await sessionCtx.formatInboundContent(message);
        delivered = await runTurn(prompt, sessionCtx, [message], deliveryToken);
        completed = delivered;
      } finally {
        initialTurnPreparing = false;
        if (completed) scheduleDrain();
      }
      if (!providerSessionId) pendingSyntheticId = `${OPENCODE_PENDING_SESSION_PREFIX}${randomUUID()}`;
      const sessionId = providerSessionId ?? pendingSyntheticId;
      if (!sessionId) throw new Error("OpenCode session id unresolved");
      if (delivered) {
        writeSessionBriefingFingerprint(workspaceCwd, sessionId, computeBriefingFingerprint(briefing));
      }
      return { sessionId, route: { kind: "owned", mode: "processing" } };
    },

    async resume(message, sessionId, sessionCtx, token) {
      const deliveryToken = message ? requireDeliveryToken(token, "messageful resume") : noopDeliveryToken();
      initialTurnPreparing = true;
      let briefing: string;
      let workspaceCwd: string;
      try {
        ({ briefing, workspaceCwd } = await prepareSession(sessionCtx));
      } catch (error) {
        initialTurnPreparing = false;
        throw error;
      }
      if (isOpenCodePendingSessionId(sessionId)) {
        pendingSyntheticId = sessionId;
        providerSessionId = null;
      } else {
        providerSessionId = sessionId;
        pendingSyntheticId = null;
      }
      const fingerprint = computeBriefingFingerprint(briefing);
      if (message) {
        let prompt = await sessionCtx.formatInboundContent(message);
        if (readSessionBriefingFingerprint(workspaceCwd, sessionId) !== fingerprint) {
          prompt = `${buildBriefingUpdateNotice(join(workspaceCwd, "AGENTS.md"))}\n\n${prompt}`;
        }
        try {
          const delivered = await runTurn(prompt, sessionCtx, [message], deliveryToken);
          if (delivered) {
            writeSessionBriefingFingerprint(workspaceCwd, providerSessionId ?? sessionId, fingerprint);
          }
        } finally {
          initialTurnPreparing = false;
          scheduleDrain();
        }
      } else {
        initialTurnPreparing = false;
        scheduleDrain();
      }
      const effectiveId = providerSessionId ?? pendingSyntheticId ?? sessionId;
      return { sessionId: effectiveId, route: message ? { kind: "owned", mode: "processing" } : null };
    },

    inject(message, token) {
      if (!ctx) return { kind: "rejected", reason: "no_active_context", retryable: true };
      queue.push({ message, token });
      scheduleDrain();
      return { kind: "owned", mode: "queued" };
    },

    async suspend(reason) {
      const recoveryReason = reason ?? "opencode_suspend_before_terminal";
      sessionActive = false;
      drainCancellationReason = recoveryReason;
      if (currentAbort) {
        markTurnAborted(generation, { cause: "lifecycle", disposition: "settle" });
      }
      generation++;
      currentAbort?.abort();
      unsafeDiscoveryWaitAbort?.abort();
      await Promise.all([currentTurnPromise, currentDrainPromise]);
      if (drainingBatch) retryDrainingBatch(drainingBatch, recoveryReason);
      retryQueue(recoveryReason);
      drainCancellationReason = null;
      unsafeDiscoveryWaitAbort = null;
      currentAbort = null;
      currentTurnPromise = null;
      initialTurnPreparing = false;
    },

    async shutdown(reason) {
      const recoveryReason = reason ?? "opencode_shutdown_before_terminal";
      sessionActive = false;
      drainCancellationReason = recoveryReason;
      if (currentAbort) {
        markTurnAborted(generation, { cause: "lifecycle", disposition: "settle" });
      }
      generation++;
      currentAbort?.abort();
      unsafeDiscoveryWaitAbort?.abort();
      await Promise.all([currentTurnPromise, currentDrainPromise]);
      if (drainingBatch) retryDrainingBatch(drainingBatch, recoveryReason);
      retryQueue(recoveryReason);
      drainCancellationReason = null;
      unsafeDiscoveryWaitAbort = null;
      currentAbort = null;
      currentTurnPromise = null;
      cwd = null;
      ctx = null;
      activeConfig = null;
      binary = null;
      providerSessionId = null;
      pendingSyntheticId = null;
      versionReady = false;
      await privateConfigLease?.close();
      projectionScope = null;
      managedAgentName = null;
      privateConfigLease = null;
      initialTurnPreparing = false;
      pendingChatContextPrompt = null;
      queue.length = 0;
    },
  } satisfies AgentHandler;
};

function isReadOnlyTool(name: string): boolean {
  return /^(read|glob|grep|list|ls|webfetch|websearch)$/i.test(name);
}

export function stableOpenCodeScope(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
