import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  type AgentRuntimeConfig,
  type AgentRuntimeConfigPayload,
  AMP_RUNTIME_MODES,
  encodeProviderRetryEventMessage,
  isAmpRuntimeMode,
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
  classifyProviderFailure,
  computeBriefingFingerprint,
  contextSourceFromHandlerConfig,
  createDefaultProviderProcessSupervisor,
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
  supportsDefaultProviderProcessSupervision,
  toolFileRefsFromShellCommand,
  writeSessionBriefingFingerprint,
} from "../../runtime/provider-support/index.js";
import { chunkAssistantText } from "../handlers/assistant-text.js";
import { formatAuthHint, isAmpAuthError } from "../handlers/auth-error-hint.js";
import { consumedErrorOutcome } from "../handlers/turn-settlement.js";
import { PROVIDER_SKILL_ROOTS } from "../skill-roots.js";
import {
  discardAmpLoginAuthorizationMaterial,
  publicAmpAuthFailure,
  sanitizeAmpAuthFailureText,
} from "./auth-failure.js";
import { resolveAmpRuntimeBinary } from "./binary.js";
import { type AmpStreamEvent, AmpStreamParser, type AmpUsage, addAmpUsage } from "./parser.js";

export const AMP_PENDING_SESSION_PREFIX = "amp-pending-";

export function isAmpPendingSessionId(sessionId: string): boolean {
  return sessionId.startsWith(AMP_PENDING_SESSION_PREFIX);
}

type AmpMcpServerConfig = { command: string; args?: string[] } | { url: string; headers?: Record<string, string> };

export function mapAmpMcpServers(payload: AgentRuntimeConfigPayload): Record<string, AmpMcpServerConfig> {
  const out: Record<string, AmpMcpServerConfig> = {};
  for (const [index, server] of payload.mcpServers.entries()) {
    const name = `first-tree-mcp-${index + 1}`;
    if (server.transport === "stdio") {
      out[name] = {
        command: server.command,
        ...(server.args === undefined ? {} : { args: server.args }),
      };
    } else {
      out[name] = {
        url: server.url,
        ...(server.headers === undefined ? {} : { headers: server.headers }),
      };
    }
  }
  return out;
}

export function buildAmpTurnArgs(input: {
  mode: string;
  resumeSessionId: string | null;
  settingsFile: string;
}): string[] {
  const args: string[] = [];
  if (input.resumeSessionId) args.push("threads", "continue", input.resumeSessionId);
  // Force private new threads (Amp's execute default is workspace-shared) and
  // disable remote web-terminal control every turn (host AMP_REMOTE_CONTROL_TERMINAL
  // must not open a second control plane outside First Tree's session boundary).
  // Amp archives --execute threads by default; `threads continue` then fails with
  // "This thread is archived and cannot be continued." Keep the thread live so
  // First Tree resume can reuse the stream-confirmed T-uuid.
  args.push(
    "--execute",
    "--stream-json",
    "--stream-json-thinking",
    "--no-remote-control-terminal",
    "--no-archive-after-execute",
    "--settings-file",
    input.settingsFile,
  );
  if (!input.resumeSessionId) args.push("--visibility", "private");
  if (input.mode) args.push("--mode", input.mode);
  return args;
}

/**
 * Runtime-owned Amp settings (SDK "custom settings file"): user-settings class,
 * so projected MCP does not need `amp mcp approve`. Mode 0600. MCP headers stay
 * in this file rather than `--mcp-config` argv, matching the prompt-off-argv
 * secret handling.
 *
 * Each call returns a unique immutable path under the shared agent home so a
 * concurrent turn (or a mid-flight config transition) cannot replace another
 * turn's MCP credentials/permission snapshot after spawn has already bound
 * `--settings-file` to a pathname. Callers must remove the file only after the
 * child process has closed (see `removeAmpRuntimeSettings`).
 */
export function writeAmpRuntimeSettings(
  workspaceCwd: string,
  mcpServers?: Record<string, AmpMcpServerConfig> | null,
): string {
  const dir = join(workspaceCwd, ".first-tree");
  const path = join(dir, `amp-runtime-settings.${randomUUID()}.json`);
  const temporaryPath = join(dir, `.amp-runtime-settings.${process.pid}.${randomUUID()}.tmp`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const settings: Record<string, unknown> = { "amp.dangerouslyAllowAll": true };
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    settings["amp.mcpServers"] = mcpServers;
  }
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The write may have failed before the temporary file was created.
    }
    throw error;
  }
  return path;
}

/** Best-effort unlink of a per-turn Amp settings file after the child closes. */
export function removeAmpRuntimeSettings(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Cleanup must not fail the turn; orphaned files are mode 0600 under agent home.
  }
}

const STDERR_TAIL_LIMIT = 8_000;
const DEFAULT_TURN_TIMEOUT_MS = 20 * 60_000;
const KILL_GRACE_MS = 5_000;
const FINAL_CLOSE_WAIT_MS = 2_000;
const PROVIDER_ATTEMPT_WINDOW_TTL_MS = 30 * 60_000;
const MAX_PROVIDER_ATTEMPT_WINDOWS = 512;
const QUEUED_UNSAFE_DISCOVERY_RETRY_BASE_MS = 1_000;
const QUEUED_UNSAFE_DISCOVERY_RETRY_MAX_MS = 30_000;

type ProcessOutcome = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
  spawnError?: Error;
};

type TurnState = {
  parser: AmpStreamParser;
  sessionIds: Set<string>;
  results: Array<{ isError: boolean; text: string }>;
  errors: string[];
  text: string[];
  usage: AmpUsage | null;
  sawProviderActivity: boolean;
  parsedProviderOutput: boolean;
  sawUnsafeTool: boolean;
  protocolDiagnostics: string[];
  toolsByCallId: Map<string, string>;
};

type ProviderTurnFailureWindow = {
  attempt: number;
  touchedAt: number;
  hasPendingDelivery: () => boolean;
};

const providerTurnFailureAttempts = new Map<string, ProviderTurnFailureWindow>();

export function clearAmpAttemptCacheForTests(): void {
  providerTurnFailureAttempts.clear();
}

type AmpRetrySleep = (delayMs: number, signal: AbortSignal) => Promise<boolean | undefined>;
type QueuedDelivery = { message: SessionMessage; token: DeliveryToken };

async function defaultAmpRetrySleep(delayMs: number, signal: AbortSignal): Promise<boolean> {
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

export const createAmpHandler: HandlerFactory = (config) => {
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
    (config.ampBinaryResolver as typeof resolveAmpRuntimeBinary | undefined) ?? resolveAmpRuntimeBinary;
  const processSupervisor =
    (config.providerProcessSupervisor as ProviderProcessSupervisor | undefined) ??
    createDefaultProviderProcessSupervisor();
  const turnTimeoutMs =
    typeof config.ampTurnTimeoutMs === "number" && config.ampTurnTimeoutMs > 0
      ? config.ampTurnTimeoutMs
      : DEFAULT_TURN_TIMEOUT_MS;
  const retrySleep = (config.ampRetrySleep as AmpRetrySleep | undefined) ?? defaultAmpRetrySleep;
  const unsafeDiscoverySleep = (config.ampUnsafeDiscoverySleep as AmpRetrySleep | undefined) ?? defaultAmpRetrySleep;
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
  let generation = 0;
  let drainScheduled = false;
  let drainInProgress = false;
  let currentDrainPromise: Promise<void> | null = null;
  let drainingBatch: QueuedDelivery[] | null = null;
  let unsafeDiscoveryParkedBatch: QueuedDelivery[] | null = null;
  let unsafeDiscoveryWaitAbort: AbortController | null = null;
  let drainCancellationReason: string | null = null;
  let pendingChatContextPrompt: string | null = null;
  const queue: QueuedDelivery[] = [];

  function deliveryAttemptKey(sessionCtx: SessionContext, messages: readonly SessionMessage[]): string {
    const deliveryHead = messages[0];
    if (!deliveryHead) throw new Error("Amp provider attempt requires a delivery head");
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
      if (!abandoned) throw new Error("Amp provider attempt ledger is full of pending deliveries");
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
    // Neutralize a host-inherited Amp remote-control enablement; argv also
    // passes `--no-remote-control-terminal` (CLI flag wins over this env).
    env.AMP_REMOTE_CONTROL_TERMINAL = "0";
    return env;
  }

  async function refreshProjection(sessionCtx: SessionContext): Promise<{
    payload: AgentRuntimeConfigPayload;
    briefing: string;
  }> {
    if (!cwd) throw new Error("Amp workspace is not prepared");
    let runtimeConfig = activeConfig;
    const existingPayload = activeConfig?.payload;
    if (agentConfigCache) {
      runtimeConfig = await agentConfigCache.refresh(sessionCtx.agent.agentId);
    }
    const payload: AgentRuntimeConfigPayload =
      runtimeConfig?.payload ??
      ({
        kind: "amp",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      } satisfies AgentRuntimeConfigPayload);
    if (payload.kind !== "amp") {
      throw new Error(`Amp handler received ${payload.kind} runtime config`);
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
      contextTree,
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
        resolveOutcome({
          exitCode: closed.exitCode,
          signal: closed.signal,
          stdoutTail,
          stderrTail,
          spawnError,
        });
      };
      const handleEvents = (events: AmpStreamEvent[]): void => {
        if (!input.state) return;
        for (const event of events) {
          try {
            handleEvent(event, input.state, input.sessionCtx);
          } catch (error) {
            input.sessionCtx.log(
              `Amp event handling failed (${event.kind}): ${error instanceof Error ? error.message : String(error)}`,
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
      if (input.prompt !== undefined) child.stdin?.write(input.prompt);
      child.stdin?.end();
    });
  }

  function handleEvent(event: AmpStreamEvent, state: TurnState, sessionCtx: SessionContext): void {
    sessionCtx.recordProviderActivity();
    state.sawProviderActivity = true;
    if (event.kind !== "unknown" && event.kind !== "user_echo") {
      state.parsedProviderOutput = true;
    }
    switch (event.kind) {
      case "init":
        if (event.sessionId) state.sessionIds.add(event.sessionId);
        break;
      case "user_echo":
        break;
      case "thinking_delta":
        sessionCtx.emitEvent({ kind: "thinking", payload: {} });
        break;
      case "assistant_message":
        state.text.push(event.text);
        break;
      case "tool_started":
        if (!isReadOnlyTool(event.tool.name)) state.sawUnsafeTool = true;
        state.toolsByCallId.set(event.callId, event.tool.name);
        {
          const toolFileRefs = fileRefsForTool(event.tool.name, event.tool.args);
          sessionCtx.emitEvent({
            kind: "tool_call",
            payload: {
              toolUseId: event.callId,
              name: event.tool.name,
              args: event.tool.args,
              status: "pending",
              ...(toolFileRefs ? { toolFileRefs } : {}),
            },
          });
        }
        break;
      case "tool_completed":
        sessionCtx.emitEvent({
          kind: "tool_call",
          payload: {
            toolUseId: event.callId,
            name: state.toolsByCallId.get(event.callId) ?? "amp-tool",
            args: {},
            status: event.failed ? "error" : "ok",
            ...(event.preview ? { resultPreview: event.preview } : {}),
          },
        });
        break;
      case "usage":
        state.usage = addAmpUsage(state.usage, event.usage);
        break;
      case "result":
        state.results.push({ isError: event.isError, text: event.text });
        if (event.sessionId) state.sessionIds.add(event.sessionId);
        // Terminal result usage wins when present; otherwise keep assistant-message totals.
        if (event.usage) state.usage = event.usage;
        if (event.isError) state.errors.push(event.text);
        break;
      case "unknown":
        if (state.protocolDiagnostics.length < 5) {
          sessionCtx.log(`Amp protocol diagnostic: ${event.note}`);
        }
        state.protocolDiagnostics.push(event.note);
        break;
    }
  }

  function fileRefsForTool(name: string, args: unknown): ToolFileRef[] | undefined {
    if (!cwd) return undefined;
    const values = asRecord(args);
    if (/^(bash|shell)$/i.test(name)) {
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
    const write = /^(edit|write|create_file|edit_file)$/i.test(name);
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

  function adoptSessionId(sessionCtx: SessionContext, id: string): void {
    if (providerSessionId === id) return;
    const synthetic = pendingSyntheticId;
    providerSessionId = id;
    if (synthetic) {
      pendingSyntheticId = null;
      sessionCtx.replaceSessionId?.(id, "amp_session_id_confirmed");
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

  function consumedReasonForProviderSettlement(settlement: ProviderAttemptSettlement): TurnConsumedErrorReason {
    return settlement.decision.action === "stop" && settlement.decision.terminalKind === "capacity_wait_required"
      ? "capacity_wait_required"
      : settlement.decision.action === "stop" && settlement.decision.terminalKind === "exhausted"
        ? "provider_retry_exhausted"
        : settlement.decision.reasonCode;
  }

  async function settleFailure(input: {
    failure: string;
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
    const displayMessage = isAmpAuthError(input.failure)
      ? formatAuthHint("amp", sanitizeAmpAuthFailureText(input.failure))
      : input.failure;
    const attempt = new ProviderAttempt({
      provider: runtimeProvider,
      scope: "provider_turn",
      source: input.spawnError ? "sdk" : "stream",
      replaySafety,
    });
    attempt.recordSignal({
      kind: input.spawnError ? "local_error" : "provider_error",
      error: input.spawnError ?? input.failure,
      messagePreview: displayMessage,
    });
    const attemptNumber = nextProviderAttempt(
      attemptKey,
      () => input.sessionCtx.hasPendingDelivery?.(input.messages) ?? true,
    );
    const settlement = attempt.settle({ attempt: attemptNumber });
    if (!settlement) {
      input.token.retry(input.messages, "amp_unclassified_failure");
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
      if (generation === input.turnGeneration && sessionActive) currentAbort = delayAbort;
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
        input.sessionCtx.failSessionForRecovery?.("amp_turn_retryable_failure", providerSessionId ?? undefined);
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
    if (!workspaceCwd || !activeBinary || !sessionActive) {
      token.retry(messages, sessionActive ? "amp_not_prepared" : "amp_session_inactive");
      return false;
    }
    const turnGeneration = ++generation;
    const abort = new AbortController();
    currentAbort = abort;
    const promise = (async () => {
      let payload: AgentRuntimeConfigPayload;
      try {
        ({ payload } = await refreshProjection(sessionCtx));
      } catch (error) {
        if (isManagedSkillsUnsafeDiscoveryError(error)) {
          if (unsafeDiscoveryAction === "throw") throw error;
          token.retry(messages, "amp_unsafe_skill_discovery");
          return false;
        }
        throw error;
      }
      const env = buildEnv(sessionCtx, payload);
      if (abort.signal.aborted || generation !== turnGeneration || !sessionActive) return false;
      await assertContextSourceCurrent({
        sessionCtx,
        sourceAuthorityRoot: workspaceRoot,
        contextTree,
      });
      if (abort.signal.aborted || generation !== turnGeneration || !sessionActive) return false;

      const oneShotPrompt = pendingChatContextPrompt;
      const providerPrompt = oneShotPrompt ? `${oneShotPrompt}\n\n${prompt}` : prompt;
      const expectedSessionId = providerSessionId;
      const state: TurnState = {
        parser: new AmpStreamParser(),
        sessionIds: new Set(),
        results: [],
        errors: [],
        text: [],
        usage: null,
        sawProviderActivity: false,
        parsedProviderOutput: false,
        sawUnsafeTool: false,
        protocolDiagnostics: [],
        toolsByCallId: new Map(),
      };
      token.processingStarted(messages);
      const timeout = setTimeout(() => abort.abort(), turnTimeoutMs);
      timeout.unref?.();

      const configuredMode = payload.model.trim();
      if (configuredMode.length > 0 && !isAmpRuntimeMode(configuredMode)) {
        clearTimeout(timeout);
        return settleFailure({
          failure: `amp_mode_invalid: Amp --mode must be one of ${AMP_RUNTIME_MODES.join(", ")}; received ${JSON.stringify(configuredMode)}`,
          state,
          sessionCtx,
          messages,
          token,
          turnGeneration,
        });
      }

      let outcome: ProcessOutcome;
      let settingsFile: string | null = null;
      try {
        const mcpServers = payload.mcpServers.length > 0 ? mapAmpMcpServers(payload) : null;
        settingsFile = writeAmpRuntimeSettings(workspaceCwd, mcpServers);
        outcome = await runProcess({
          command: activeBinary,
          args: buildAmpTurnArgs({
            mode: configuredMode,
            resumeSessionId: expectedSessionId,
            settingsFile,
          }),
          prompt: `${providerPrompt}\n`,
          env,
          workspaceCwd,
          state,
          sessionCtx,
          abortSignal: abort.signal,
          timeoutMs: turnTimeoutMs,
          turnGeneration,
          label: `amp turn ${sessionCtx.chatId}`,
        });
      } finally {
        clearTimeout(timeout);
        // Unlink only after the child closes so Amp cannot re-read a replaced
        // shared pathname mid-turn; each turn owns its own immutable file.
        if (settingsFile) removeAmpRuntimeSettings(settingsFile);
      }

      const authFailure = classifyAmpAuthFailure({
        exitCode: outcome.exitCode,
        stderrTail: outcome.stderrTail,
        stdoutTail: outcome.stdoutTail,
        structuredErrors: state.errors,
        parsedProviderOutput: state.parsedProviderOutput,
      });

      if (abort.signal.aborted || generation !== turnGeneration || !sessionActive) {
        // Raw pre-session login-flow stdout (no parsed init/assistant JSON) can
        // hang until timeout; that is still a credential failure. Once a normal
        // provider stream has been parsed, abort/timeout/suspend must not treat
        // assistant text that merely mentions those phrases as auth recovery.
        if (authFailure && !state.parsedProviderOutput) {
          return settleFailure({
            failure: authFailure,
            state,
            sessionCtx,
            messages,
            token,
            turnGeneration,
          });
        }
        return settleFailure({
          failure: "Amp turn aborted or timed out before a safe terminal event",
          spawnError: new Error("Amp turn aborted or timed out"),
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
      if (state.results.length !== 1) {
        protocolErrors.push(`expected one terminal result event, observed ${state.results.length}`);
      }
      if (state.errors.length > 0) protocolErrors.push(...state.errors);

      const success =
        !outcome.spawnError &&
        outcome.exitCode === 0 &&
        protocolErrors.length === 0 &&
        authFailure === null &&
        state.results[0]?.isError !== true;
      if (success) {
        const id = ids[0];
        if (!id) throw new Error("Amp success without session ID");
        adoptSessionId(sessionCtx, id);
        const finalText = state.results[0]?.text || state.text.join("");
        for (const chunk of chunkAssistantText(finalText)) {
          sessionCtx.emitEvent({ kind: "assistant_text", payload: { text: chunk } });
        }
        if (state.usage) {
          sessionCtx.emitEvent({
            kind: "token_usage",
            payload: {
              provider: "amp",
              model: payload.model || "amp-default",
              inputTokens: state.usage.inputTokens,
              cachedInputTokens: state.usage.cacheReadTokens,
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

      const failure =
        outcome.spawnError?.message ||
        authFailure ||
        state.errors[0] ||
        protocolErrors[0] ||
        redactErrorPreview(
          discardAmpLoginAuthorizationMaterial(
            outcome.stderrTail || outcome.stdoutTail || `amp exited ${outcome.exitCode}`,
          ),
          800,
        );
      return settleFailure({
        failure,
        spawnError: outcome.spawnError,
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
    } finally {
      if (currentTurnPromise && generation === turnGeneration) currentTurnPromise = null;
    }
  }

  async function prepareSession(sessionCtx: SessionContext): Promise<{
    briefing: string;
    workspaceCwd: string;
  }> {
    if (isLandingCampaignTrialAgentMetadata(sessionCtx.agent.metadata)) {
      throw new Error("landing campaign trial agents require the codex app-server runtime");
    }
    if (!supportsDefaultProviderProcessSupervision()) {
      throw new Error(
        "Amp is not supported on Windows in v1 until the client-wide pre-admission Job Object supervisor is available.",
      );
    }
    ctx = sessionCtx;
    const resolution = resolveBinary(process.env);
    if (!resolution.ok) throw new Error(resolution.error);
    binary = resolution.binary;
    sessionCtx.log(`Amp binary: ${resolution.binary}`);

    let runtimeConfig = activeConfig;
    if (agentConfigCache) {
      runtimeConfig = await agentConfigCache.refresh(sessionCtx.agent.agentId);
    }
    const payload: AgentRuntimeConfigPayload =
      runtimeConfig?.payload ??
      ({
        kind: "amp",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      } satisfies AgentRuntimeConfigPayload);
    if (payload.kind !== "amp") {
      throw new Error(`Amp handler received ${payload.kind} runtime config`);
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
      contextTree,
    });
    cwd = prepared.workspace;
    activeConfig = runtimeConfig;
    pendingChatContextPrompt = [renderRuntimeOutputContract(), renderChatContextPrompt(prepared.chatContext)]
      .filter(Boolean)
      .join("\n\n");
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
    const prompt = (await Promise.all(messages.map((message) => sessionCtx.formatInboundContent(message)))).join(
      "\n\n",
    );
    let unsafeAttempt = 0;
    for (;;) {
      try {
        await runTurn(prompt, sessionCtx, messages, token, "throw");
        return;
      } catch (error) {
        if (!isManagedSkillsUnsafeDiscoveryError(error) || !sessionActive || drainingBatch !== drained) throw error;
        unsafeDiscoveryParkedBatch = drained;
        unsafeAttempt += 1;
        const delayMs = queuedUnsafeDiscoveryRetryDelayMs(unsafeAttempt);
        const classification = classifyProviderFailure(error, {
          provider: runtimeProvider,
          scope: "provider_turn",
          source: "bind",
        });
        sessionCtx.log(
          `Amp queued turn blocked by unsafe managed-skill discovery; retrying in ${delayMs}ms: ${classification.message}`,
        );
        const waitAbort = new AbortController();
        unsafeDiscoveryWaitAbort = waitAbort;
        const completedDelay = await unsafeDiscoverySleep(delayMs, waitAbort.signal);
        if (unsafeDiscoveryWaitAbort === waitAbort) unsafeDiscoveryWaitAbort = null;
        if (!completedDelay) {
          if (!drainCancellationReason && sessionActive && drainingBatch === drained) {
            throw new Error("Amp queued unsafe-discovery wait ended without lifecycle cancellation");
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
          sessionCtx.log(`Amp queued turn failed: ${error instanceof Error ? error.message : String(error)}`);
          retryDrainingBatch(drained, "amp_queued_turn_failed");
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
      if (!providerSessionId) pendingSyntheticId = `${AMP_PENDING_SESSION_PREFIX}${randomUUID()}`;
      const sessionId = providerSessionId ?? pendingSyntheticId;
      if (!sessionId) throw new Error("Amp session id unresolved");
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
      if (isAmpPendingSessionId(sessionId)) {
        pendingSyntheticId = sessionId;
        providerSessionId = null;
      } else {
        providerSessionId = sessionId;
        pendingSyntheticId = null;
      }
      const fingerprint = computeBriefingFingerprint(briefing);
      if (message) {
        let completed = false;
        try {
          // formatInboundContent + briefing notice must stay inside this cleanup
          // try/finally: a throw before runTurn used to leave initialTurnPreparing
          // latched, so inject() kept queueing without scheduling drain.
          let prompt = await sessionCtx.formatInboundContent(message);
          if (readSessionBriefingFingerprint(workspaceCwd, sessionId) !== fingerprint) {
            prompt = `${buildBriefingUpdateNotice(join(workspaceCwd, "AGENTS.md"))}\n\n${prompt}`;
          }
          const delivered = await runTurn(prompt, sessionCtx, [message], deliveryToken);
          if (delivered) {
            writeSessionBriefingFingerprint(workspaceCwd, providerSessionId ?? sessionId, fingerprint);
          }
          completed = delivered;
        } finally {
          initialTurnPreparing = false;
          if (completed) scheduleDrain();
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
      const recoveryReason = reason ?? "amp_suspend_before_terminal";
      sessionActive = false;
      drainCancellationReason = recoveryReason;
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
      const recoveryReason = reason ?? "amp_shutdown_before_terminal";
      sessionActive = false;
      drainCancellationReason = recoveryReason;
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
      initialTurnPreparing = false;
      pendingChatContextPrompt = null;
      queue.length = 0;
    },
  } satisfies AgentHandler;
};

function classifyAmpAuthFailure(input: {
  exitCode: number | null;
  stderrTail: string;
  stdoutTail: string;
  structuredErrors: readonly string[];
  parsedProviderOutput: boolean;
}): string | null {
  if (isAmpAuthError(input.stderrTail)) {
    return publicAmpAuthFailure(input.stderrTail);
  }
  const structured = input.structuredErrors.find((error) => isAmpAuthError(error));
  if (structured) return publicAmpAuthFailure(structured);
  // Stdout is an auth source only for the official pre-session login-flow
  // (plain text, no parsed init/assistant JSON). `exitCode !== 0` is also true
  // for a signal-killed child (`exitCode: null`), so JSON assistant text that
  // happens to mention the same phrases must not be classified from stdoutTail.
  if (!input.parsedProviderOutput && input.exitCode !== 0 && isAmpAuthError(input.stdoutTail)) {
    return publicAmpAuthFailure(input.stdoutTail);
  }
  return null;
}

function isReadOnlyTool(name: string): boolean {
  return /^(read|glob|grep|finder|todo_read|read_web_page|read_mcp_resource|oracle|list|ls)$/i.test(name);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
