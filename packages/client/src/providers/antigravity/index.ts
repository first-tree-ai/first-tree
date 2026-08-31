import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import {
  type AgentRuntimeConfig,
  type AgentRuntimeConfigPayload,
  type AntigravityRuntimeConfigPayload,
  DEFAULT_ANTIGRAVITY_RUNTIME_CONFIG_PAYLOAD,
  encodeProviderRetryEventMessage,
  isLandingCampaignTrialAgentMetadata,
  runtimeProviderSchema,
  type ToolFileRef,
} from "@first-tree/shared";
import type {
  AgentHandler,
  DeliveryToken,
  HandlerFactory,
  HandlerResumeOptions,
  HandlerShutdownOptions,
  ProviderContinuation,
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
  supportsDefaultProviderProcessSupervision,
  toolFileRefsFromShellCommand,
  writeSessionBriefingFingerprint,
} from "../../runtime/provider-support/index.js";
import { chunkAssistantText } from "../handlers/assistant-text.js";
import { formatAuthHint, isAntigravityAuthError } from "../handlers/auth-error-hint.js";
import { consumedErrorOutcome } from "../handlers/turn-settlement.js";
import { PROVIDER_SKILL_ROOTS } from "../skill-roots.js";
import { buildAntigravityTurnArgs, resolveAntigravityRuntimeBinary } from "./binary.js";
import { type AntigravityMcpConfig, projectAntigravityMcpConfig } from "./mcp-config.js";
import { type AntigravityStreamEvent, AntigravityStreamParser, type AntigravityUsage } from "./parser.js";

export const ANTIGRAVITY_PENDING_SESSION_PREFIX = "antigravity-pending-";

export function isAntigravityPendingSessionId(sessionId: string): boolean {
  return sessionId.startsWith(ANTIGRAVITY_PENDING_SESSION_PREFIX);
}

const STDERR_TAIL_LIMIT = 8_000;
const DEFAULT_TURN_TIMEOUT_MS = 20 * 60_000;
const KILL_GRACE_MS = 5_000;
const FINAL_CLOSE_WAIT_MS = 2_000;
const PROVIDER_ATTEMPT_WINDOW_TTL_MS = 30 * 60_000;
const MAX_PROVIDER_ATTEMPT_WINDOWS = 512;

/**
 * Antigravity has no documented headless "resume the interrupted turn without
 * a new user event" operation. Its safe recovery boundary is therefore an
 * exact conversation resume with a provider-owned continuation instruction;
 * the original First Tree delivery is custody identity only and is never
 * serialized again.
 */
export const ANTIGRAVITY_CONTINUATION_PROMPT =
  "Continue the interrupted turn from this existing Antigravity conversation. The original First Tree delivery was already submitted and may have produced tool effects. Do not repeat the original user prompt or any tool call already present in conversation history; inspect the existing state and finish the turn.";

type ProcessOutcome = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
  spawnError?: Error;
};

type TurnState = {
  parser: AntigravityStreamParser;
  sessionIds: Set<string>;
  results: Array<{ isError: boolean; text: string }>;
  errors: string[];
  text: string[];
  usage: AntigravityUsage | null;
  sawProviderActivity: boolean;
  sawUnsafeTool: boolean;
  protocolDiagnostics: string[];
  toolsByCallId: Map<string, { name: string; args: unknown }>;
};

type ProviderTurnFailureWindow = {
  attempt: number;
  touchedAt: number;
  hasPendingDelivery: () => boolean;
};

const providerTurnFailureAttempts = new Map<string, ProviderTurnFailureWindow>();

export function clearAntigravityAttemptCacheForTests(): void {
  providerTurnFailureAttempts.clear();
}

/**
 * Antigravity's terminal usage object is cumulative for a conversation. First
 * Tree's token_usage event is a per-turn delta, so diff the counters only
 * against a baseline belonging to this exact conversation. A handler that
 * cold-resumes an existing conversation has no trustworthy baseline; skip its
 * first snapshot rather than charging the whole conversation to one turn.
 */
export function computeAntigravityUsageDelta(
  cumulative: AntigravityUsage,
  baseline: AntigravityUsage | null,
  conversationIsFresh: boolean,
): AntigravityUsage | null {
  if (!baseline) return conversationIsFresh ? { ...cumulative } : null;
  const delta = (current: number, previous: number): number => (current >= previous ? current - previous : current);
  return {
    inputTokens: delta(cumulative.inputTokens, baseline.inputTokens),
    cachedInputTokens: delta(cumulative.cachedInputTokens, baseline.cachedInputTokens),
    outputTokens: delta(cumulative.outputTokens, baseline.outputTokens),
  };
}

type AntigravityRetrySleep = (delayMs: number, signal: AbortSignal) => Promise<boolean | undefined>;
type QueuedDelivery = { message: SessionMessage; token: DeliveryToken };

async function defaultAntigravityRetrySleep(delayMs: number, signal: AbortSignal): Promise<boolean> {
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function providerAttemptKey(sessionCtx: SessionContext, messages: readonly SessionMessage[]): string {
  const first = messages[0];
  if (!first) throw new Error("Antigravity provider attempt requires a delivery head");
  return `${sessionCtx.agent.agentId}\0${sessionCtx.chatId}\0${first.inboxEntryId}\0${first.id}`;
}

function nextProviderAttempt(key: string, hasPendingDelivery: ProviderTurnFailureWindow["hasPendingDelivery"]): number {
  const now = Date.now();
  for (const [entryKey, entry] of providerTurnFailureAttempts) {
    let pending = true;
    try {
      pending = entry.hasPendingDelivery();
    } catch {
      // An observer failure is not authority to forget an unacked delivery.
    }
    if (!pending && now - entry.touchedAt >= PROVIDER_ATTEMPT_WINDOW_TTL_MS) {
      providerTurnFailureAttempts.delete(entryKey);
    }
  }
  const existing = providerTurnFailureAttempts.get(key);
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
    if (!abandoned) throw new Error("Antigravity provider attempt ledger is full of pending deliveries");
    providerTurnFailureAttempts.delete(abandoned[0]);
  }
  providerTurnFailureAttempts.delete(key);
  providerTurnFailureAttempts.set(key, { attempt, touchedAt: now, hasPendingDelivery });
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
  return env;
}

export const createAntigravityHandler: HandlerFactory = (config) => {
  const workspaceRoot = config.workspaceRoot as string;
  const agentName = typeof config.agentName === "string" ? config.agentName : "";
  const runtimeProvider = runtimeProviderSchema.parse(config.runtimeProvider);
  if (runtimeProvider !== "antigravity") {
    throw new Error(`Antigravity handler received ${runtimeProvider} runtime provider`);
  }
  const agentConfigCache = (config.agentConfigCache as AgentConfigCache | undefined) ?? null;
  const contextSource = contextSourceFromHandlerConfig(config);
  const contextTree = preparationCoordinatesFromSource(contextSource);
  const gitAttribution = remoteGitAttributionFromSource(contextSource);
  const contextTreePath = gitAttribution.contextTreePath;
  const contextTreeRepoUrl = gitAttribution.contextTreeRepoUrl;
  const contextTreeBranch = contextTree.kind === "remote" ? contextTree.branch : null;
  const resolveBinary =
    (config.antigravityBinaryResolver as typeof resolveAntigravityRuntimeBinary | undefined) ??
    resolveAntigravityRuntimeBinary;
  const processSupervisor =
    (config.providerProcessSupervisor as ProviderProcessSupervisor | undefined) ??
    createDefaultProviderProcessSupervisor();
  const turnTimeoutMs =
    typeof config.antigravityTurnTimeoutMs === "number" && config.antigravityTurnTimeoutMs > 0
      ? config.antigravityTurnTimeoutMs
      : DEFAULT_TURN_TIMEOUT_MS;
  const retrySleep =
    (config.antigravityRetrySleep as AntigravityRetrySleep | undefined) ?? defaultAntigravityRetrySleep;

  let cwd: string | null = null;
  let ctx: SessionContext | null = null;
  let activeConfig: AgentRuntimeConfig | null = null;
  let binary: string | null = null;
  let providerSessionId: string | null = null;
  let pendingSyntheticId: string | null = null;
  // A lifecycle fence can finish an in-flight first turn after shutdown has
  // cleared the live handler state. Keep an exact provider ID just long
  // enough for start()/resume() to return it to SessionRuntime.
  let pendingLifecycleSessionId: string | null = null;
  let pendingLifecycleContinuation: ProviderContinuation | null = null;
  let sessionActive = false;
  let settleProviderEntered = false;
  let initialTurnPreparing = false;
  let currentAbort: AbortController | null = null;
  let currentTurnPromise: Promise<void> | null = null;
  let generation = 0;
  let drainScheduled = false;
  let drainInProgress = false;
  let currentDrainPromise: Promise<void> | null = null;
  let drainingBatch: QueuedDelivery[] | null = null;
  let drainCancellationReason: string | null = null;
  let pendingChatContextPrompt: string | null = null;
  const cumulativeUsageByConversation = new Map<string, AntigravityUsage>();
  const freshConversations = new Set<string>();
  const queue: QueuedDelivery[] = [];

  async function refreshProjection(sessionCtx: SessionContext): Promise<{
    payload: AntigravityRuntimeConfigPayload;
    briefing: string;
  }> {
    if (!cwd) throw new Error("Antigravity workspace is not prepared");
    let runtimeConfig = activeConfig;
    const existingPayload = activeConfig?.payload;
    if (agentConfigCache) runtimeConfig = await agentConfigCache.refresh(sessionCtx.agent.agentId);
    const payload: AgentRuntimeConfigPayload = runtimeConfig?.payload ?? {
      ...DEFAULT_ANTIGRAVITY_RUNTIME_CONFIG_PAYLOAD,
    };
    if (payload.kind !== "antigravity") {
      throw new Error(`Antigravity handler received ${payload.kind} runtime config`);
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
    return { payload, briefing: projected.briefing } as {
      payload: AntigravityRuntimeConfigPayload;
      briefing: string;
    };
  }

  function runProcess(input: {
    command: string;
    args: string[];
    prompt: string;
    env: Record<string, string>;
    workspaceCwd: string;
    state: TurnState;
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
      let stdoutEnded = child.stdout === null;
      let settled = false;
      let spawnError: Error | undefined;

      const finish = (): void => {
        if (settled || !closed || !stdoutEnded) return;
        settled = true;
        resolveOutcome({ exitCode: closed.exitCode, signal: closed.signal, stdoutTail, stderrTail, spawnError });
      };
      const handleEvents = (events: AntigravityStreamEvent[]): void => {
        for (const event of events) {
          try {
            handleEvent(event, input.state, input.sessionCtx);
          } catch (error) {
            input.sessionCtx.log(
              `Antigravity event handling failed (${event.kind}): ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      };
      const terminate = (): void => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
          else child.kill("SIGTERM");
        } catch {
          // The provider may already have exited.
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
        if (!input.abortSignal.aborted && generation === input.turnGeneration) {
          handleEvents(input.state.parser.push(chunk));
        }
      });
      child.stdout?.on("end", () => {
        if (!input.abortSignal.aborted && generation === input.turnGeneration) {
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

      try {
        child.stdin?.write(`${JSON.stringify({ event: "user", message: { content: input.prompt } })}\n`);
        child.stdin?.end();
      } catch (error) {
        spawnError = error instanceof Error ? error : new Error(String(error));
        try {
          child.stdin?.destroy();
        } catch {
          // The child close path remains authoritative.
        }
      }
    });
  }

  function handleEvent(event: AntigravityStreamEvent, state: TurnState, sessionCtx: SessionContext): void {
    sessionCtx.recordProviderActivity();
    state.sawProviderActivity = true;
    switch (event.kind) {
      case "init":
        if (event.sessionId) state.sessionIds.add(event.sessionId);
        break;
      case "assistant_delta":
        state.text.push(event.text);
        break;
      case "tool": {
        if (!isReadOnlyTool(event.name)) state.sawUnsafeTool = true;
        state.toolsByCallId.set(event.toolUseId, { name: event.name, args: event.args });
        const toolFileRefs = fileRefsForTool(event.name, event.args);
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
        break;
      }
      case "usage":
        state.usage = event.usage;
        break;
      case "result":
        state.results.push({ isError: event.isError, text: event.text });
        if (event.sessionId) state.sessionIds.add(event.sessionId);
        if (event.usage) state.usage = event.usage;
        if (event.isError && event.text) state.errors.push(event.text);
        break;
      case "error":
        state.errors.push(event.message);
        break;
      case "unknown":
        if (state.protocolDiagnostics.length < 5) {
          sessionCtx.log(`Antigravity protocol diagnostic: ${event.note}`);
        }
        state.protocolDiagnostics.push(event.note);
        break;
    }
  }

  function fileRefsForTool(name: string, args: unknown): ToolFileRef[] | undefined {
    if (!cwd) return undefined;
    const values = asRecord(args);
    const lowered = name.toLowerCase();
    if (lowered === "run_command" || lowered === "shell" || lowered === "execute_command") {
      const command =
        (typeof values?.CommandLine === "string" && values.CommandLine) ||
        (typeof values?.command === "string" && values.command) ||
        (typeof values?.command_line === "string" && values.command_line);
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
      (typeof values?.path === "string" && values.path) ||
      (typeof values?.file_path === "string" && values.file_path) ||
      (typeof values?.filePath === "string" && values.filePath) ||
      (typeof values?.target_file === "string" && values.target_file) ||
      (typeof values?.Directory === "string" && values.Directory);
    if (!rawPath) return undefined;
    const absolutePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
    const repoRelativePath = resolveContextTreeRelativePath(absolutePath, {
      contextTreePath,
      contextTreeRepoUrl,
    });
    const write = /(?:write|edit|create|delete|move|rename|patch)/i.test(lowered);
    return [
      {
        origin: write ? "file_change" : "tool_arg",
        localPath: rawPath,
        pathKind: lowered.includes("list") || lowered.includes("search") ? "directory" : "file",
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
      sessionCtx.replaceSessionId?.(id, "antigravity_conversation_id_confirmed");
      if (cwd) {
        const baseline = readSessionBriefingFingerprint(cwd, synthetic);
        if (baseline) writeSessionBriefingFingerprint(cwd, id, baseline);
      }
    }
  }

  function adoptObservedSessionId(
    sessionCtx: SessionContext,
    observedIds: ReadonlySet<string>,
    expectedSessionId: string | null,
    observedUsage: AntigravityUsage | null = null,
  ): string | null {
    const ids = [...observedIds];
    const id = ids.length === 1 ? ids[0] : undefined;
    if (!id || (expectedSessionId && id !== expectedSessionId)) return null;
    adoptSessionId(sessionCtx, id);
    if (observedUsage) {
      cumulativeUsageByConversation.set(id, { ...observedUsage });
      freshConversations.delete(id);
    }
    return id;
  }

  function emitAntigravityUsage(
    sessionCtx: SessionContext,
    payload: AntigravityRuntimeConfigPayload,
    conversationId: string,
    cumulative: AntigravityUsage,
  ): void {
    const delta = computeAntigravityUsageDelta(
      cumulative,
      cumulativeUsageByConversation.get(conversationId) ?? null,
      freshConversations.has(conversationId),
    );
    cumulativeUsageByConversation.set(conversationId, { ...cumulative });
    freshConversations.delete(conversationId);
    if (!delta || delta.inputTokens + delta.cachedInputTokens + delta.outputTokens === 0) return;
    sessionCtx.emitEvent({
      kind: "token_usage",
      payload: {
        provider: "antigravity",
        model: payload.model || "antigravity-default",
        inputTokens: delta.inputTokens,
        cachedInputTokens: delta.cachedInputTokens,
        outputTokens: delta.outputTokens,
      },
    });
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

  async function settleFailure(input: {
    failure: string;
    spawnError?: Error;
    state: Pick<TurnState, "sawProviderActivity" | "sawUnsafeTool" | "text">;
    sessionCtx: SessionContext;
    messages: readonly SessionMessage[];
    token: DeliveryToken;
    turnGeneration: number;
  }): Promise<boolean> {
    const key = providerAttemptKey(input.sessionCtx, input.messages);
    const replaySafety = input.state.sawUnsafeTool
      ? "unsafe"
      : input.state.text.length > 0
        ? "user_visible"
        : input.state.sawProviderActivity
          ? "pre_visible"
          : "pre_provider";
    const displayMessage = isAntigravityAuthError(input.failure)
      ? formatAuthHint("antigravity", input.failure)
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
    const attemptNumber = nextProviderAttempt(key, () => input.sessionCtx.hasPendingDelivery?.(input.messages) ?? true);
    const settlement = attempt.settle({ attempt: attemptNumber });
    if (!settlement) {
      input.token.retry(input.messages, "antigravity_unclassified_failure");
      return false;
    }

    emitProviderTurnSettlementEvent(input.sessionCtx, settlement);
    input.sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: displayMessage } });
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
        input.sessionCtx.failSessionForRecovery?.("antigravity_turn_retryable_failure", providerSessionId ?? undefined);
      }
      return false;
    }
    const completion = await input.token.complete(
      input.messages,
      consumedErrorOutcome(settlement.decision.reasonCode as TurnConsumedErrorReason),
    );
    if (completion === "retry") return false;
    providerTurnFailureAttempts.delete(key);
    pendingChatContextPrompt = null;
    return true;
  }

  async function runTurn(
    prompt: string,
    sessionCtx: SessionContext,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
  ): Promise<boolean> {
    const workspaceCwd = cwd;
    const activeBinary = binary;
    if (!workspaceCwd || !activeBinary || !sessionActive) {
      token.retry(messages, sessionActive ? "antigravity_not_prepared" : "antigravity_session_inactive");
      return false;
    }
    const turnGeneration = ++generation;
    const abort = new AbortController();
    currentAbort = abort;
    const state: TurnState = {
      parser: new AntigravityStreamParser(),
      sessionIds: new Set(),
      results: [],
      errors: [],
      text: [],
      usage: null,
      sawProviderActivity: false,
      sawUnsafeTool: false,
      protocolDiagnostics: [],
      toolsByCallId: new Map(),
    };
    let processingStarted = false;
    const promise = (async () => {
      try {
        const { payload, briefing } = await refreshProjection(sessionCtx);
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
        if (abort.signal.aborted || generation !== turnGeneration || !sessionActive) {
          token.retry(messages, "antigravity_turn_cancelled_before_provider");
          return false;
        }
        await projectAntigravityMcpConfig(workspaceCwd, payload);
        const oneShotPrompt = pendingChatContextPrompt;
        const providerPrompt = oneShotPrompt ? `${oneShotPrompt}\n\n${prompt}` : prompt;
        const expectedSessionId = providerSessionId;
        token.processingStarted(messages);
        processingStarted = true;
        const timeout = setTimeout(() => abort.abort(), turnTimeoutMs);
        timeout.unref?.();
        let outcome: ProcessOutcome;
        try {
          outcome = await runProcess({
            command: activeBinary,
            args: buildAntigravityTurnArgs({
              model: payload.model,
              reasoningEffort: payload.reasoningEffort,
              resumeSessionId: expectedSessionId,
              turnTimeoutMs,
            }),
            prompt: `${providerPrompt}\n`,
            env: buildEnv(sessionCtx, payload),
            workspaceCwd,
            state,
            sessionCtx,
            abortSignal: abort.signal,
            timeoutMs: turnTimeoutMs,
            turnGeneration,
            label: `antigravity turn ${sessionCtx.chatId}`,
          });
        } finally {
          clearTimeout(timeout);
        }

        if (generation !== turnGeneration || !sessionActive) {
          const lifecycleObservedId = adoptObservedSessionId(
            sessionCtx,
            state.sessionIds,
            expectedSessionId,
            state.usage,
          );
          if (lifecycleObservedId) pendingLifecycleSessionId = lifecycleObservedId;
          if (lifecycleObservedId && !settleProviderEntered && messages.length === 1) {
            const message = messages[0];
            if (message) {
              pendingLifecycleContinuation = {
                kind: "provider_continuation",
                provider: runtimeProvider,
                sessionId: lifecycleObservedId,
                messageId: message.id,
              };
            }
          }
          if (drainingBatch?.some((entry) => entry.token === token)) drainingBatch = null;
          if (state.sawUnsafeTool && settleProviderEntered) {
            const lifecycleError = new Error(
              "Antigravity turn cancelled during a lifecycle transition after a mutating tool",
            );
            lifecycleError.name = "AbortError";
            return settleFailure({
              failure: lifecycleError.message,
              spawnError: lifecycleError,
              state,
              sessionCtx,
              messages,
              token,
              turnGeneration,
            });
          }
          const lifecycleRecoveryReason = drainCancellationReason ?? "antigravity_turn_aborted_or_timed_out";
          token.retry(messages, lifecycleRecoveryReason);
          return false;
        }
        if (abort.signal.aborted) {
          // A timeout/provider abort is a provider attempt, not an implicit
          // safe redelivery. If the stream already observed a mutating tool,
          // settleFailure must terminate as unsafe_replay. Preserve a single
          // exact conversation id first so a later explicit resume cannot
          // accidentally create a second Antigravity conversation.
          adoptObservedSessionId(sessionCtx, state.sessionIds, expectedSessionId, state.usage);
          const abortError = new Error("Antigravity turn aborted or timed out before a safe terminal event");
          abortError.name = "TimeoutError";
          return settleFailure({
            failure: abortError.message,
            spawnError: abortError,
            state,
            sessionCtx,
            messages,
            token,
            turnGeneration,
          });
        }

        const ids = [...state.sessionIds];
        const protocolErrors: string[] = [];
        if (ids.length !== 1) protocolErrors.push(`expected one conversation ID, observed ${ids.length}`);
        if (expectedSessionId && ids[0] !== expectedSessionId) {
          protocolErrors.push(
            `resume conversation mismatch: expected ${expectedSessionId}, observed ${ids[0] ?? "none"}`,
          );
        }
        if (state.results.length !== 1) {
          protocolErrors.push(`expected one terminal result event, observed ${state.results.length}`);
        }
        if (state.errors.length > 0) protocolErrors.push(...state.errors);
        if (state.protocolDiagnostics.length > 0) {
          protocolErrors.push(
            `unsupported or malformed Antigravity stream (${state.protocolDiagnostics.length} line${
              state.protocolDiagnostics.length === 1 ? "" : "s"
            })`,
          );
        }
        if (state.results[0]?.isError) protocolErrors.push("Antigravity returned an ERROR result");

        const success = !outcome.spawnError && outcome.exitCode === 0 && protocolErrors.length === 0;
        if (success) {
          const id = ids[0];
          if (!id) throw new Error("Antigravity success without conversation ID");
          adoptSessionId(sessionCtx, id);
          if (!expectedSessionId) freshConversations.add(id);
          const finalText = state.results[0]?.text || state.text.join("");
          for (const chunk of chunkAssistantText(finalText)) {
            sessionCtx.emitEvent({ kind: "assistant_text", payload: { text: chunk } });
          }
          if (state.usage) {
            if (!expectedSessionId) freshConversations.add(id);
            emitAntigravityUsage(sessionCtx, payload, id, state.usage);
          }
          try {
            await sessionCtx.forwardResult(finalText);
          } catch (error) {
            sessionCtx.emitEvent({
              kind: "error",
              payload: {
                source: "runtime",
                message: `forwardResult failed: ${error instanceof Error ? error.message : String(error)}`.slice(
                  0,
                  2000,
                ),
              },
            });
            sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
            const completion = await token.complete(messages, {
              status: "error",
              completion: "consumed",
              reason: "forward_failed",
            });
            if (completion === "retry") return false;
            providerTurnFailureAttempts.delete(providerAttemptKey(sessionCtx, messages));
            pendingChatContextPrompt = null;
            return true;
          }
          sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "success" } });
          const completion = await token.complete(messages, { status: "success" });
          if (completion === "retry") return false;
          providerTurnFailureAttempts.delete(providerAttemptKey(sessionCtx, messages));
          if (pendingChatContextPrompt === oneShotPrompt) pendingChatContextPrompt = null;
          writeSessionBriefingFingerprint(workspaceCwd, id, computeBriefingFingerprint(briefing));
          return true;
        }

        const rawFailure = [
          ...protocolErrors,
          outcome.spawnError?.message,
          outcome.stderrTail,
          outcome.stdoutTail,
          outcome.exitCode === null ? `signal ${outcome.signal ?? "unknown"}` : `exit ${outcome.exitCode}`,
        ]
          .filter((value): value is string => Boolean(value?.trim()))
          .join("\n");
        adoptObservedSessionId(sessionCtx, state.sessionIds, expectedSessionId, state.usage);
        return settleFailure({
          failure: redactErrorPreview(rawFailure || "Antigravity produced no terminal result", 2000),
          ...(outcome.spawnError ? { spawnError: outcome.spawnError } : {}),
          state,
          sessionCtx,
          messages,
          token,
          turnGeneration,
        });
      } catch (error) {
        if (!processingStarted) {
          if (isManagedSkillsUnsafeDiscoveryError(error)) {
            token.retry(messages, "antigravity_managed_skills_unsafe");
          } else if (isContextSourceTransitionError(error)) {
            token.retry(messages, "antigravity_context_source_changed");
          } else {
            token.retry(messages, "antigravity_preflight_failed");
          }
          return false;
        }
        if (isContextSourceTransitionError(error)) {
          token.retry(messages, "antigravity_context_source_changed");
          sessionCtx.failSessionForRecovery?.("antigravity_context_source_changed", providerSessionId ?? undefined);
          return false;
        }
        const failure = redactErrorPreview(error instanceof Error ? error.message : String(error), 2000);
        return settleFailure({
          failure,
          spawnError: error instanceof Error ? error : new Error(String(error)),
          state,
          sessionCtx,
          messages,
          token,
          turnGeneration,
        });
      }
    })();
    currentTurnPromise = promise.then(
      () => {},
      () => {},
    );
    try {
      return await promise;
    } finally {
      if (currentTurnPromise && generation === turnGeneration) {
        currentTurnPromise = null;
      }
      scheduleDrain();
    }
  }

  async function prepareSession(sessionCtx: SessionContext): Promise<{ briefing: string; workspaceCwd: string }> {
    if (isLandingCampaignTrialAgentMetadata(sessionCtx.agent.metadata)) {
      throw new Error("landing campaign trial agents require the codex app-server runtime");
    }
    if (!supportsDefaultProviderProcessSupervision()) {
      throw new Error(
        "Antigravity is not supported on Windows in v1 until the client-wide pre-admission Job Object supervisor is available.",
      );
    }
    ctx = sessionCtx;
    const resolution = resolveBinary(process.env);
    if (!resolution.ok) throw new Error(resolution.error);
    binary = resolution.binary;
    sessionCtx.log(`Antigravity binary: ${resolution.binary}`);

    let runtimeConfig = activeConfig;
    if (agentConfigCache) runtimeConfig = await agentConfigCache.refresh(sessionCtx.agent.agentId);
    const payload: AgentRuntimeConfigPayload = runtimeConfig?.payload ?? {
      ...DEFAULT_ANTIGRAVITY_RUNTIME_CONFIG_PAYLOAD,
    };
    if (payload.kind !== "antigravity") {
      throw new Error(`Antigravity handler received ${payload.kind} runtime config`);
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
    sessionActive = true;
    return { briefing: prepared.briefing, workspaceCwd: cwd };
  }

  function finishDrainingBatch(batch: QueuedDelivery[]): void {
    if (drainingBatch === batch) drainingBatch = null;
  }

  function retryDrainingBatch(batch: QueuedDelivery[], reason: string): void {
    if (drainingBatch !== batch) return;
    finishDrainingBatch(batch);
    for (const entry of batch) entry.token.retry(entry.message, reason);
  }

  async function runQueued(batch: QueuedDelivery[], sessionCtx: SessionContext): Promise<void> {
    const token = batch[0]?.token;
    if (!token) return;
    const messages = batch.map((entry) => entry.message);
    let prompt: string;
    try {
      prompt = (await Promise.all(messages.map((message) => sessionCtx.formatInboundContent(message)))).join("\n\n");
    } catch (error) {
      sessionCtx.log(`Antigravity queued formatting failed: ${error instanceof Error ? error.message : String(error)}`);
      retryDrainingBatch(batch, "antigravity_queued_format_failed");
      return;
    }
    try {
      await runTurn(prompt, sessionCtx, messages, token);
    } catch (error) {
      if (drainCancellationReason) {
        retryDrainingBatch(batch, drainCancellationReason);
        return;
      }
      sessionCtx.log(`Antigravity queued turn failed: ${error instanceof Error ? error.message : String(error)}`);
      retryDrainingBatch(batch, "antigravity_queued_turn_failed");
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
      const batch = queue.splice(0);
      const sessionCtx = ctx;
      drainingBatch = batch;
      drainInProgress = true;
      const drainPromise = runQueued(batch, sessionCtx)
        .catch((error) => {
          const cancellationReason = drainCancellationReason;
          if (cancellationReason) {
            retryDrainingBatch(batch, cancellationReason);
            return;
          }
          sessionCtx.log(`Antigravity queued turn failed: ${error instanceof Error ? error.message : String(error)}`);
          retryDrainingBatch(batch, "antigravity_queued_turn_failed");
        })
        .finally(() => {
          if (!drainCancellationReason && drainingBatch === batch) finishDrainingBatch(batch);
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
      pendingLifecycleSessionId = null;
      pendingLifecycleContinuation = null;
      initialTurnPreparing = true;
      let delivered = false;
      let briefing: string;
      let workspaceCwd: string;
      try {
        ({ briefing, workspaceCwd } = await prepareSession(sessionCtx));
        delivered = await runTurn(await sessionCtx.formatInboundContent(message), sessionCtx, [message], token);
      } finally {
        initialTurnPreparing = false;
        if (delivered) scheduleDrain();
      }
      if (!providerSessionId && !pendingLifecycleSessionId) {
        pendingSyntheticId = `${ANTIGRAVITY_PENDING_SESSION_PREFIX}${randomUUID()}`;
      }
      const sessionId = providerSessionId ?? pendingLifecycleSessionId ?? pendingSyntheticId;
      if (!sessionId) throw new Error("Antigravity conversation ID unresolved");
      const continuation = pendingLifecycleContinuation;
      pendingLifecycleSessionId = null;
      pendingLifecycleContinuation = null;
      if (delivered) writeSessionBriefingFingerprint(workspaceCwd, sessionId, computeBriefingFingerprint(briefing));
      return {
        sessionId,
        route: { kind: "owned", mode: "processing" },
        ...(continuation ? { continuation } : {}),
      };
    },

    async resume(message, sessionId, sessionCtx, token, opts?: HandlerResumeOptions) {
      pendingLifecycleSessionId = null;
      pendingLifecycleContinuation = null;
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
      if (isAntigravityPendingSessionId(sessionId)) {
        pendingSyntheticId = sessionId;
        providerSessionId = null;
      } else {
        providerSessionId = sessionId;
        pendingSyntheticId = null;
      }
      if (message) {
        try {
          let prompt: string;
          if (opts?.continuation) {
            if (
              opts.continuation.provider !== runtimeProvider ||
              opts.continuation.sessionId !== sessionId ||
              opts.continuation.messageId !== message.id
            ) {
              throw new Error("Antigravity provider continuation identity mismatch");
            }
            prompt = ANTIGRAVITY_CONTINUATION_PROMPT;
          } else {
            prompt = await sessionCtx.formatInboundContent(message);
            const fingerprint = computeBriefingFingerprint(briefing);
            if (readSessionBriefingFingerprint(workspaceCwd, sessionId) !== fingerprint) {
              prompt = `${buildBriefingUpdateNotice(join(workspaceCwd, "AGENTS.md"))}\n\n${prompt}`;
            }
          }
          await runTurn(prompt, sessionCtx, [message], deliveryToken);
        } finally {
          initialTurnPreparing = false;
          scheduleDrain();
        }
      } else {
        initialTurnPreparing = false;
        scheduleDrain();
      }
      const continuation = pendingLifecycleContinuation;
      pendingLifecycleContinuation = null;
      return {
        sessionId: providerSessionId ?? pendingSyntheticId ?? sessionId,
        route: message ? { kind: "owned", mode: "processing" } : null,
        ...(continuation ? { continuation } : {}),
      };
    },

    inject(message, token) {
      if (!ctx || !sessionActive) return { kind: "rejected", reason: "no_active_context", retryable: true };
      queue.push({ message, token });
      scheduleDrain();
      return { kind: "owned", mode: "queued" };
    },

    async suspend(reason, opts?: HandlerShutdownOptions) {
      const recoveryReason = reason ?? "antigravity_suspend_before_terminal";
      sessionActive = false;
      drainCancellationReason = recoveryReason;
      settleProviderEntered = opts?.settleProviderEntered === true;
      generation++;
      currentAbort?.abort();
      await Promise.all([currentTurnPromise, currentDrainPromise]);
      if (drainingBatch) retryDrainingBatch(drainingBatch, recoveryReason);
      retryQueue(recoveryReason);
      drainCancellationReason = null;
      settleProviderEntered = false;
      currentAbort = null;
      currentTurnPromise = null;
      initialTurnPreparing = false;
    },

    async shutdown(reason, opts?: HandlerShutdownOptions) {
      const recoveryReason = reason ?? "antigravity_shutdown_before_terminal";
      sessionActive = false;
      drainCancellationReason = recoveryReason;
      settleProviderEntered = opts?.settleProviderEntered === true;
      generation++;
      currentAbort?.abort();
      await Promise.all([currentTurnPromise, currentDrainPromise]);
      if (drainingBatch) retryDrainingBatch(drainingBatch, recoveryReason);
      retryQueue(recoveryReason);
      drainCancellationReason = null;
      settleProviderEntered = false;
      currentAbort = null;
      currentTurnPromise = null;
      cwd = null;
      ctx = null;
      activeConfig = null;
      binary = null;
      providerSessionId = null;
      pendingSyntheticId = null;
      pendingChatContextPrompt = null;
      cumulativeUsageByConversation.clear();
      freshConversations.clear();
      providerTurnFailureAttempts.clear();
      queue.length = 0;
      initialTurnPreparing = false;
    },
  } satisfies AgentHandler;
};

function isReadOnlyTool(name: string): boolean {
  return /^(read|read_file|list|list_files|grep|search|search_files|find|find_files|stat|webfetch|websearch)$/i.test(
    name,
  );
}

export type { AntigravityMcpConfig };
