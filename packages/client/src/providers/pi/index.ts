import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  type AgentRuntimeConfig,
  type AgentRuntimeConfigPayload,
  DEFAULT_PI_RUNTIME_CONFIG_PAYLOAD,
  encodeProviderRetryEventMessage,
  isLandingCampaignTrialAgentMetadata,
  runtimeProviderSchema,
  type ToolFileRef,
} from "@first-tree/shared";
import type {
  AgentHandler,
  DeliveryToken,
  HandlerFactory,
  HandlerShutdownOptions,
  SessionContext,
  SessionMessage,
} from "../../runtime/contracts.js";
import {
  isTeamSkillCommandUnavailableError,
  noopDeliveryToken,
  requireDeliveryToken,
} from "../../runtime/contracts.js";
import type {
  AgentConfigCache,
  ContextTreeAttribution,
  ContextTreeGitWriteTracker,
  ProviderAttemptSettlement,
  ProviderProcessSupervisor,
  ReconciledTeamSkill,
} from "../../runtime/provider-support/index.js";
import {
  assertContextSourceCurrent,
  buildBriefingUpdateNotice,
  computeBriefingFingerprint,
  contextSourceFromHandlerConfig,
  createContextTreeGitWriteTracker,
  createDefaultProviderProcessSupervisor,
  isContextSourceTransitionError,
  isExhaustedCapacityPhrasing,
  maxProviderTurnRetryAttempts,
  ProviderAttempt,
  piProviderDetailBinaryMissingReasonCode,
  preparationCoordinatesFromSource,
  prepareManagedSession,
  projectManagedWorkspace,
  readSessionBriefingFingerprint,
  remoteGitAttributionFromSource,
  renderChatContextPrompt,
  renderRuntimeOutputContract,
  resolveContextTreeRelativePath,
  supportsDefaultProviderProcessSupervision,
  toolFileRefsFromShellCommand,
  withContextTreeRepoHeadCommit,
  writeSessionBriefingFingerprint,
} from "../../runtime/provider-support/index.js";
import { formatAuthHint, isPiAuthError } from "../handlers/auth-error-hint.js";
import { PROVIDER_SKILL_ROOTS } from "../skill-roots.js";
import {
  isSupportedPiVersion,
  PI_SUPPORTED_VERSION_RANGE,
  parsePiVersionOutput,
  resolvePiRuntimeBinary,
} from "./binary.js";
import {
  applyPiChildEnvControls,
  buildPiRpcArgs,
  isPiRpcBeforeWriteError,
  PiRpcClient,
  PiRpcProtocolError,
} from "./rpc-client.js";

const RESULT_PREVIEW_LIMIT = 400;
const VERSION_GATE_TIMEOUT_MS = 30_000;
const PI_SESSIONS_DIR = ".first-tree-workspace/pi-sessions";
const PI_SKILLS_DIR = ".agents/skills";
const NORMAL_STOP_REASONS = new Set(["stop", "toolUse", "length"]);
/** Pi 0.83 thinking-level suffixes; anything else after `:` stays in the model id. */
const PI_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Allow-listed Pi diagnostics for logs/chat. Never echo arbitrary provider /
 * prompt / stderr prose — only stable classification tokens.
 */
export function sanitizePiProviderDetail(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (!lower) return "pi_provider_error";
  if (/missing credentials|no api key|\/login|not authenticated|auth required|unauthorized|forbidden/.test(lower)) {
    return "pi_auth_required";
  }
  // One provider-scoped capacity rule with the shared retry classifier
  // (isExhaustedCapacityPhrasing): Pi surfaces HTTP 429 with these phrasings
  // after its own retry budget is exhausted.
  if (/overloaded|rate.?limit|capacity/.test(lower) || isExhaustedCapacityPhrasing("pi", lower)) {
    return "pi_capacity_limited";
  }
  if (/timed out|timeout|etimedout/.test(lower)) return "pi_timeout";
  if (/unsupported version|not a supported pi|requires >=/.test(lower)) return "pi_unsupported_version";
  if (/not supported on windows/.test(lower)) return "pi_platform_unsupported";
  // Single owner: Pi-detail binary-missing mapping lives in provider-support
  // (broader than the generic taxonomy matcher; input is already Pi-scoped).
  const binaryMissing = piProviderDetailBinaryMissingReasonCode(raw);
  if (binaryMissing !== null) return binaryMissing;
  if (/managed mcp|mcp servers are not supported/.test(lower)) return "pi_mcp_unsupported";
  if (/model mismatch|thinkinglevel mismatch|model selector is invalid/.test(lower)) return "pi_model_mismatch";
  if (/session identity mismatch|get_state response missing|pi get_state failed/.test(lower)) {
    return "pi_protocol_error";
  }
  if (/transport|stdin|closed|exited|desync|command mismatch|invalid jsonl|settlement|protocol/.test(lower)) {
    return "pi_transport_error";
  }
  return "pi_provider_error";
}

/**
 * Deterministic Pi session id for a fresh First Tree start.
 *
 * Pre-Reset (no tombstone): derived from `(agentId, chatId, firstMessageId)`
 * so crash-redelivery of the same uncommitted first row keeps one identity.
 *
 * Post-Reset: SessionRegistry rotates a durable per-chat fresh-start nonce
 * that survives mapping deletion and manager restart. Hashing that nonce in
 * makes retirement non-reconstructible from the durable inbox row alone —
 * settled+ACK-failed → Pause/Reset → new SessionRuntime → same-row redelivery
 * cannot reopen the discarded Pi transcript/model state. Without a nonce the
 * pre-Reset deterministic identity is preserved for backward compatibility.
 *
 * Suspend, idle yield, daemon restart, and LRU eviction keep the mapping, and
 * `resume` adopts the persisted id verbatim. First Tree never deletes
 * provider-owned session files; Reset retires by dropping the mapping and
 * rotating the tombstone together before apply-ACK.
 */
export function freshStartPiSessionId(
  agentId: string,
  chatId: string,
  firstMessageId: string,
  freshStartNonce?: string,
): string {
  const material =
    typeof freshStartNonce === "string" && freshStartNonce.length > 0
      ? `first-tree:${agentId}:${chatId}:${firstMessageId}:${freshStartNonce}`
      : `first-tree:${agentId}:${chatId}:${firstMessageId}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

export {
  applyPiChildEnvControls,
  buildPiRpcArgs,
  PI_FORCED_CHILD_ENV,
  PI_V1_NATIVE_TOOLS,
  piV1NativeToolsArg,
} from "./rpc-client.js";

type ActiveTool = {
  name: string;
  args: unknown;
  startedAt: number;
  refs: ToolFileRef[];
};

type CustodyEntry = {
  messages: readonly SessionMessage[];
  token: DeliveryToken;
};

type PiUsage = { inputTokens: number; cachedInputTokens: number; outputTokens: number };

type TurnObservation = {
  assistantText: string;
  settled: boolean;
  /** Provisional assistant error while Pi may still auto-retry. */
  provisionalError: string | null;
  /** Final accepted-turn failure after Pi exhausted auto-retry (or abnormal stop). */
  turnError: string | null;
  thinkingEmitted: boolean;
  unsafeToolEffectStarted: boolean;
  userVisibleEmitted: boolean;
  usage: PiUsage | null;
  usageKeys: Set<string>;
  provider: string | null;
  model: string | null;
  stopReason: string | null;
  autoRetryFailed: string | null;
  /** True once the prompt JSONL line was written to Pi stdin (response may still be pending). */
  promptWriteCommitted: boolean;
  /** True when Pi returned a definitive preflight rejection (success:false) for this write. */
  promptPreflightRejected: boolean;
  promptAccepted: boolean;
  attempt: ProviderAttempt;
};

export type PiModelThinkingCandidate = {
  modelId: string;
  thinkingLevel: string;
};

export type PiModelSelector = {
  provider: string;
  /** Full model id after `provider/` — Pi tries this exact id first. */
  modelId: string;
  /**
   * When the final `:` suffix is a Pi thinking level, the prefix+level pair Pi
   * may resolve if the exact full id is not a registered model.
   */
  thinkingCandidate: PiModelThinkingCandidate | null;
  raw: string;
};

/**
 * Parse `provider/model…` while preserving Pi 0.83 exact-first semantics.
 * The full post-slash id stays in `modelId`; a thinking-level suffix is only
 * exposed as `thinkingCandidate` for the fallback interpretation.
 */
export function parsePiModelSelector(raw: string): PiModelSelector | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  const provider = trimmed.slice(0, slash);
  const rest = trimmed.slice(slash + 1);
  let thinkingCandidate: PiModelThinkingCandidate | null = null;
  const thinkingSplit = rest.lastIndexOf(":");
  if (thinkingSplit > 0) {
    const maybeThinking = rest.slice(thinkingSplit + 1);
    if (PI_THINKING_LEVELS.has(maybeThinking)) {
      thinkingCandidate = {
        modelId: rest.slice(0, thinkingSplit),
        thinkingLevel: maybeThinking,
      };
    }
  }
  return {
    provider,
    modelId: rest,
    thinkingCandidate,
    raw: trimmed,
  };
}

type PreparedSession = {
  payload: AgentRuntimeConfigPayload;
  workspaceCwd: string;
  sessionId: string;
  sessionDir: string;
  skillsDir: string;
  briefing: string;
};

export class PiBinaryVerifyTransientError extends Error {
  constructor(reason: string) {
    super(`pi --version smoke check did not complete (transient host condition); will retry. Detail: ${reason}`);
    this.name = "PiBinaryVerifyTransientError";
  }
}

/** Thrown when prepare/start observes that lifecycle shutdown cancelled this generation. */
export class PiLifecycleCancelledError extends Error {
  constructor(phase: string) {
    super(`pi lifecycle cancelled during ${phase}`);
    this.name = "PiLifecycleCancelledError";
  }
}

/**
 * Narrow test seam: returns the number of live lifecycle-abort waiters for a
 * handler created by `createPiHandler`. Production callers must not use this.
 */
export const piLifecycleAbortWaiterCountForTests = new WeakMap<object, () => number>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function preview(value: unknown): string {
  if (typeof value === "string") return value.slice(0, RESULT_PREVIEW_LIMIT);
  try {
    return JSON.stringify(value).slice(0, RESULT_PREVIEW_LIMIT);
  } catch {
    return String(value).slice(0, RESULT_PREVIEW_LIMIT);
  }
}

function inputPathForTool(_name: string, args: unknown): string | null {
  const record = asRecord(args);
  if (!record) return null;
  const keys = ["path", "file_path", "filePath", "file"];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** Pure tool-arg → file-ref mapping used by the handler and unit tests. */
export function resolvePiNativeToolRefs(input: {
  name: string;
  args: unknown;
  workspaceCwd: string;
  contextTreePath?: string | null;
  contextTreeRepoUrl?: string | null;
  contextTreeBranch?: string | null;
}): ToolFileRef[] {
  const lowered = input.name.toLowerCase();
  const contextTreePath = input.contextTreePath ?? null;
  const contextTreeRepoUrl = input.contextTreeRepoUrl ?? null;
  const contextTreeBranch = input.contextTreeBranch ?? null;
  if (lowered === "bash") {
    const command = asRecord(input.args)?.command;
    if (typeof command !== "string") return [];
    const commandCwd = asRecord(input.args)?.cwd;
    return toolFileRefsFromShellCommand({
      command,
      cwd: typeof commandCwd === "string" ? commandCwd : input.workspaceCwd,
      contextTreePath,
      contextTreeRepoUrl,
      contextTreeBranch,
    });
  }
  const record = asRecord(input.args);
  // Only explicit filesystem path/directory args qualify — never grep/find `pattern`.
  const pathCandidate =
    inputPathForTool(input.name, input.args) ??
    (typeof record?.target_directory === "string"
      ? record.target_directory
      : typeof record?.directory === "string"
        ? record.directory
        : typeof record?.cwd === "string" && (lowered === "ls" || lowered === "find")
          ? record.cwd
          : null);
  if (!pathCandidate) return [];
  if (
    lowered !== "read" &&
    lowered !== "write" &&
    lowered !== "edit" &&
    lowered !== "grep" &&
    lowered !== "find" &&
    lowered !== "ls"
  ) {
    return [];
  }
  const absolutePath = isAbsolute(pathCandidate) ? resolve(pathCandidate) : resolve(input.workspaceCwd, pathCandidate);
  const attribution: ContextTreeAttribution = { contextTreePath, contextTreeRepoUrl };
  const repoRelativePath = resolveContextTreeRelativePath(absolutePath, attribution);
  const write = lowered === "write" || lowered === "edit";
  const pathKind =
    lowered === "grep" || lowered === "find" || lowered === "ls" ? ("directory" as const) : ("file" as const);
  const ref: ToolFileRef = {
    origin: write ? "file_change" : "tool_arg",
    localPath: absolutePath,
    pathKind,
    ...(contextTreeRepoUrl && repoRelativePath
      ? {
          repoUrl: contextTreeRepoUrl,
          ...(contextTreeBranch ? { repoBranch: contextTreeBranch } : {}),
          repoRelativePath,
        }
      : {}),
  };
  // Read-path refs observe the exact Context Tree HEAD; write tools rely on git deltas.
  return [write ? ref : withContextTreeRepoHeadCommit(ref, absolutePath)];
}

function piToolIsReadOnly(name: string): boolean {
  const lowered = name.toLowerCase();
  return lowered === "read" || lowered === "grep" || lowered === "find" || lowered === "ls";
}

function spawnScopedFingerprint(payload: AgentRuntimeConfigPayload, skillsDir: string, skillsDigest: string): string {
  const envEntries = [...payload.env].map((entry) => `${entry.key}=${entry.value}`).sort();
  return JSON.stringify({
    model: payload.model ?? "",
    env: envEntries,
    skillsDir,
    skillsDigest,
    gitRepos: payload.gitRepos ?? [],
  });
}

function skillsContentDigest(teamSkills: readonly ReconciledTeamSkill[], resourceConfigVersion: number): string {
  const parts = teamSkills.map((skill) => `${skill.key}:${skill.revision}:${skill.installedDigest}`).sort();
  return `v${resourceConfigVersion}|${parts.join("|")}`;
}

function sanitizeNonNegInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

function normalizePiUsage(usage: Record<string, unknown> | null): PiUsage | null {
  if (!usage) return null;
  try {
    const input = sanitizeNonNegInt(usage.input) ?? sanitizeNonNegInt(usage.inputTokens);
    const output = sanitizeNonNegInt(usage.output) ?? sanitizeNonNegInt(usage.outputTokens);
    const cacheRead =
      sanitizeNonNegInt(usage.cacheRead) ??
      sanitizeNonNegInt(usage.cachedInputTokens) ??
      sanitizeNonNegInt(usage.cacheReadTokens) ??
      0;
    const cacheWrite = sanitizeNonNegInt(usage.cacheWrite) ?? sanitizeNonNegInt(usage.cacheWriteTokens) ?? 0;
    if (input === null && output === null && cacheRead === 0 && cacheWrite === 0) return null;
    // First Tree uncached input = provider input + cacheWrite (disjoint Pi buckets).
    return {
      inputTokens: (input ?? 0) + cacheWrite,
      cachedInputTokens: cacheRead,
      outputTokens: output ?? 0,
    };
  } catch {
    return null;
  }
}

function readTurnUsage(observation: TurnObservation): PiUsage | null {
  // Break CFA: event callbacks assign usage after the loop resets it to null.
  return observation.usage;
}

function extractAssistantMessageFields(message: Record<string, unknown> | null): {
  usage: PiUsage | null;
  provider: string | null;
  model: string | null;
  stopReason: string | null;
} {
  if (!message || message.role !== "assistant") {
    return { usage: null, provider: null, model: null, stopReason: null };
  }
  return {
    usage: normalizePiUsage(asRecord(message.usage)),
    provider: typeof message.provider === "string" ? message.provider : null,
    model: typeof message.model === "string" ? message.model : null,
    stopReason: typeof message.stopReason === "string" ? message.stopReason : null,
  };
}

export type PiRetrySleep = (delayMs: number, signal: AbortSignal) => Promise<boolean>;

type QueuedDelivery = { message: SessionMessage; token: DeliveryToken };

/** Abortable retry backoff — shared by active pre-provider drain and turn preflight loops. */
export async function defaultPiRetrySleep(delayMs: number, signal: AbortSignal): Promise<boolean> {
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

export const createPiHandler: HandlerFactory = (config) => {
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
  const platform = (config.piPlatform as NodeJS.Platform | undefined) ?? process.platform;
  const resolveBinary =
    (config.piBinaryResolver as typeof resolvePiRuntimeBinary | undefined) ?? resolvePiRuntimeBinary;
  const processSupervisor =
    (config.providerProcessSupervisor as ProviderProcessSupervisor | undefined) ??
    createDefaultProviderProcessSupervisor(platform);
  const maxRetries = maxProviderTurnRetryAttempts();
  const versionGateTimeoutMs =
    typeof config.piVersionGateTimeoutMs === "number" ? config.piVersionGateTimeoutMs : VERSION_GATE_TIMEOUT_MS;
  const settlementTimeoutMs =
    typeof config.piSettlementTimeoutMs === "number" ? config.piSettlementTimeoutMs : undefined;
  const requestTimeoutMs = typeof config.piRequestTimeoutMs === "number" ? config.piRequestTimeoutMs : undefined;
  const retrySleep = (config.piRetrySleep as PiRetrySleep | undefined) ?? defaultPiRetrySleep;

  let cwd: string | null = null;
  let ctx: SessionContext | null = null;
  let rpcClient: PiRpcClient | null = null;
  let binary: string | null = null;
  let sessionId: string | null = null;
  let activePayload: AgentRuntimeConfigPayload | null = null;
  let reconciledTeamSkills: readonly ReconciledTeamSkill[] = [];
  let sessionActive = false;
  let initialTurnPreparing = false;
  let currentTurnPromise: Promise<boolean> | null = null;
  let currentDrainPromise: Promise<void> | null = null;
  let streaming = false;
  let versionReady = false;
  let pendingChatContextPrompt: string | null = null;
  let drainScheduled = false;
  let drainInProgress = false;
  let drainingBatch: QueuedDelivery[] | null = null;
  let drainCancellationReason: string | null = null;
  /**
   * Explicit settlement mode from SessionRuntime — not inferred from reason text.
   * - graceful_drain: full manager/client shutdown
   * - operator_suspend: manual session:suspend resolution boundary
   */
  let settleProviderEnteredMode: "graceful_drain" | "operator_suspend" | null = null;
  let lifecycleGeneration = 0;
  /** Waiters woken when endLifecycle bumps generation so gated host I/O can fail closed. */
  const lifecycleAbortWaiters = new Set<() => void>();
  let currentRetryAbort: AbortController | null = null;
  const queuedMessages: QueuedDelivery[] = [];
  const activeTools = new Map<string, ActiveTool>();
  const pendingSteerWork = new Set<Promise<void>>();
  const gitWriteTracker: ContextTreeGitWriteTracker = createContextTreeGitWriteTracker({
    contextTreePath,
    contextTreeRepoUrl,
    contextTreeBranch,
    log: (message) => ctx?.log(message),
  });
  let turnObservation: TurnObservation | null = null;
  let turnCustody: CustodyEntry[] = [];
  let activeSpawnFingerprint: string | null = null;
  let activeSkillsDigest = "";
  let activeResourceConfigVersion = 0;
  let activeBriefingText: string | null = null;
  let oneShotConsumed = false;

  async function sleepForRetry(delayMs: number): Promise<boolean> {
    const abort = new AbortController();
    currentRetryAbort = abort;
    try {
      return await retrySleep(delayMs, abort.signal);
    } finally {
      if (currentRetryAbort === abort) currentRetryAbort = null;
    }
  }

  function lifecycleOwnsRecovery(): boolean {
    return drainCancellationReason !== null;
  }

  function recoverTurnUnlessLifecycleOwns(reason: string): void {
    if (lifecycleOwnsRecovery()) return;
    retryCustody(reason);
  }

  function hasProviderEntryEvidence(
    observation: TurnObservation | null,
    mode: "graceful_drain" | "operator_suspend",
  ): boolean {
    if (!observation) return false;
    // After-write unknown: write-committed without accept/reject.
    const afterWriteUnknown =
      observation.promptWriteCommitted && !observation.promptAccepted && !observation.promptPreflightRejected;
    const enteredVisible =
      afterWriteUnknown ||
      observation.promptAccepted ||
      observation.unsafeToolEffectStarted ||
      observation.userVisibleEmitted;
    if (enteredVisible) return true;
    // Manual operator suspend resolves any prompt that crossed into Pi stdin
    // (including a proven preflight rejection). Full graceful drain keeps
    // preflight-only work recoverable/unacked.
    return mode === "operator_suspend" && observation.promptWriteCommitted;
  }

  /**
   * When SessionRuntime sets an explicit settle mode, terminally settle the
   * provider-entered prefix exactly once. Provider-entry authority is prompt
   * write/accept/tool/user-visible evidence — not `streaming`. Route-retire /
   * forced preemption leave settle mode unset (recoverable retry).
   */
  async function settleLifecycleCancellation(sessionCtx: SessionContext, reason: string): Promise<void> {
    if (settleProviderEnteredMode && hasProviderEntryEvidence(turnObservation, settleProviderEnteredMode)) {
      await settleAcceptedTurnFailure(
        sessionCtx,
        `pi lifecycle cancelled after provider entry (${drainCancellationReason ?? reason})`,
      );
      return;
    }
    if (lifecycleOwnsRecovery()) {
      retryCustody(drainCancellationReason ?? reason);
      return;
    }
    recoverTurnUnlessLifecycleOwns(reason);
  }

  function consumeOneShotPromptState(): void {
    // Chat-context prompt is session-one-shot; briefing fingerprint advances on
    // every accept/unknown boundary so idle refresh can attach each new version once.
    if (!oneShotConsumed) {
      oneShotConsumed = true;
      pendingChatContextPrompt = null;
    }
    if (cwd && sessionId && activeBriefingText) {
      writeSessionBriefingFingerprint(cwd, sessionId, computeBriefingFingerprint(activeBriefingText));
    }
  }

  async function awaitPendingSteers(): Promise<void> {
    while (pendingSteerWork.size > 0) {
      await Promise.all([...pendingSteerWork]);
    }
  }

  function emitSettlement(sessionCtx: SessionContext, settlement: ProviderAttemptSettlement): void {
    sessionCtx.emitEvent({
      kind: "error",
      payload: { source: "runtime", message: encodeProviderRetryEventMessage(settlement.eventPayload) },
    });
  }

  function updateReplaySafety(observation: TurnObservation): void {
    if (observation.unsafeToolEffectStarted) {
      observation.attempt.setReplaySafety("unsafe");
    } else if (observation.userVisibleEmitted) {
      observation.attempt.markUserVisibleOutput();
    } else if (observation.promptAccepted) {
      // Never downgrade accepted custody back to pre_provider.
      observation.attempt.setReplaySafety("provider_entered");
    } else {
      observation.attempt.setReplaySafety("pre_provider");
    }
  }

  function buildEnv(sessionCtx: SessionContext, payload: AgentRuntimeConfigPayload): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === "string") env[key] = value;
    }
    for (const entry of payload.env) env[entry.key] = entry.value;
    const merged = sessionCtx.buildAgentEnv(env);
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(merged)) {
      if (typeof value === "string") out[key] = value;
    }
    // Forced after host/payload/identity merge so agent env cannot re-enable
    // version checks or install telemetry. Does not inject or clear PI_OFFLINE.
    return applyPiChildEnvControls(out);
  }

  function nativeToolRefs(name: string, args: unknown, workspaceCwd: string): ToolFileRef[] {
    return resolvePiNativeToolRefs({
      name,
      args,
      workspaceCwd,
      contextTreePath,
      contextTreeRepoUrl,
      contextTreeBranch,
    });
  }

  function refsForCompletedTool(input: {
    ok: boolean;
    readOnly: boolean;
    providerRefs: ToolFileRef[];
    toolName: string;
    toolUseId: string;
  }): ToolFileRef[] | undefined {
    if (input.readOnly) return input.providerRefs.length > 0 ? input.providerRefs : undefined;
    if (!input.ok) {
      gitWriteTracker.captureBaseline();
      return undefined;
    }
    const gitStatusRefs = gitWriteTracker.refsForSuccessfulToolCall({
      toolName: input.toolName,
      toolUseId: input.toolUseId,
      existingRefs: input.providerRefs,
    });
    const refs = [...input.providerRefs, ...gitStatusRefs];
    return refs.length > 0 ? refs : undefined;
  }

  function emitToolCall(
    sessionCtx: SessionContext,
    toolCallId: string,
    tool: ActiveTool,
    status: "pending" | "ok" | "error",
    result?: unknown,
  ): void {
    sessionCtx.emitEvent({
      kind: "tool_call",
      payload: {
        toolUseId: toolCallId,
        name: tool.name,
        args: tool.args,
        status,
        ...(status !== "pending" ? { durationMs: Math.max(0, Date.now() - tool.startedAt) } : {}),
        ...(result !== undefined ? { resultPreview: preview(result) } : {}),
        ...(tool.refs.length > 0 ? { toolFileRefs: tool.refs } : {}),
      },
    });
  }

  function rejectMcpConfiguration(payload: AgentRuntimeConfigPayload): void {
    if (payload.mcpServers.length === 0) return;
    throw new Error(
      "Pi runtime provider mismatch: managed MCP servers are not supported for Pi agents. " +
        "Remove MCP server entries from the agent runtime configuration or choose a different runtime provider.",
    );
  }

  async function runVersionGate(
    activeBinary: string,
    env: Record<string, string>,
    workspaceCwd: string,
    _sessionCtx: SessionContext,
  ): Promise<void> {
    if (versionReady) return;
    const outcome = await new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
      spawnError?: Error;
      timedOut: boolean;
    }>((resolveOutcome) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (value: {
        exitCode: number | null;
        signal: NodeJS.Signals | null;
        stdout: string;
        stderr: string;
        spawnError?: Error;
        timedOut: boolean;
      }) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolveOutcome(value);
      };
      try {
        const supervised = processSupervisor.spawn({
          command: activeBinary,
          args: ["--version"],
          label: "pi compatible-version gate",
          timeoutMs: versionGateTimeoutMs,
          options: {
            cwd: workspaceCwd,
            env,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            ...(platform === "win32" ? {} : { detached: true }),
          },
        });
        const child = supervised.child;
        timer = setTimeout(() => {
          timedOut = true;
          try {
            child.kill("SIGTERM");
          } catch {
            // ignore
          }
          // If the child ignores TERM (or the test supervisor never auto-kills),
          // still surface the timeout without waiting forever.
          setTimeout(() => {
            finish({ exitCode: null, signal: "SIGTERM", stdout, stderr, timedOut: true });
          }, 50);
        }, versionGateTimeoutMs);
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.on("error", (error) =>
          finish({ exitCode: null, signal: null, stdout, stderr, spawnError: error, timedOut }),
        );
        child.on("close", (exitCode, signal) => finish({ exitCode, signal: signal ?? null, stdout, stderr, timedOut }));
      } catch (error) {
        finish({
          exitCode: null,
          signal: null,
          stdout,
          stderr,
          spawnError: error instanceof Error ? error : new Error(String(error)),
          timedOut,
        });
      }
    });

    if (outcome.spawnError) {
      const code = (outcome.spawnError as NodeJS.ErrnoException).code;
      if (code === "ETIMEDOUT" || outcome.timedOut) {
        throw new PiBinaryVerifyTransientError("`pi --version` timed out");
      }
      throw outcome.spawnError;
    }
    if (outcome.timedOut) {
      throw new PiBinaryVerifyTransientError("`pi --version` timed out");
    }
    const version = parsePiVersionOutput(`${outcome.stdout}\n${outcome.stderr}`);
    if (outcome.exitCode !== 0 || !isSupportedPiVersion(version)) {
      throw new Error(
        `Pi runtime provider mismatch: unsupported version. First Tree requires ${PI_SUPPORTED_VERSION_RANGE}; ` +
          `observed ${version ?? "no parseable version"}.`,
      );
    }
    versionReady = true;
  }

  function validateGetState(response: Awaited<ReturnType<PiRpcClient["getState"]>>, expectedSessionId: string): void {
    if (!response.success) {
      throw new Error(response.error ?? "pi get_state failed");
    }
    const data = asRecord(response.data);
    if (!data) {
      throw new PiRpcProtocolError("pi get_state response missing data object");
    }
    const reported = data.sessionId;
    if (typeof reported !== "string" || reported.length === 0) {
      throw new PiRpcProtocolError("pi get_state response missing sessionId");
    }
    if (reported !== expectedSessionId) {
      throw new PiRpcProtocolError(
        `Pi session identity mismatch: expected ${expectedSessionId}, get_state reported ${reported}`,
      );
    }
  }

  function assertConfiguredModel(state: Awaited<ReturnType<PiRpcClient["getState"]>>, model: string): void {
    if (!model) return;
    const expected = parsePiModelSelector(model);
    if (!expected) {
      throw new Error(`Pi model selector is invalid: ${model}. Use provider/model or provider/model:<thinking>.`);
    }
    const data = asRecord(state.data);
    const reported = asRecord(data?.model);
    const reportedId = typeof reported?.id === "string" ? reported.id : null;
    const reportedProvider = typeof reported?.provider === "string" ? reported.provider : null;
    const reportedThinking = typeof data?.thinkingLevel === "string" ? data.thinkingLevel : null;
    if (reportedProvider !== expected.provider) {
      throw new Error(
        `Pi model mismatch: configured ${expected.provider}/${expected.modelId}, get_state reported ` +
          `${reportedProvider ?? "?"}/${reportedId ?? "?"}. No silent provider/model fallback.`,
      );
    }
    // Pi 0.83 exact-first: accept the full selector id when that is what resolved.
    if (reportedId === expected.modelId) {
      return;
    }
    const candidate = expected.thinkingCandidate;
    if (candidate && reportedId === candidate.modelId) {
      if (reportedThinking !== candidate.thinkingLevel) {
        throw new Error(
          `Pi thinkingLevel mismatch: configured ${candidate.thinkingLevel}, get_state reported ${reportedThinking ?? "none"}.`,
        );
      }
      return;
    }
    throw new Error(
      `Pi model mismatch: configured ${expected.provider}/${expected.modelId}, get_state reported ` +
        `${reportedProvider ?? "?"}/${reportedId ?? "?"}. No silent provider/model fallback.`,
    );
  }

  async function ensureRpcClient(prepared: PreparedSession, sessionCtx: SessionContext): Promise<PiRpcClient> {
    rejectMcpConfiguration(prepared.payload);
    const nextFingerprint = spawnScopedFingerprint(prepared.payload, prepared.skillsDir, activeSkillsDigest);
    if (rpcClient && !rpcClient.isClosed && activeSpawnFingerprint === nextFingerprint) {
      return rpcClient;
    }
    await assertContextSourceCurrent({
      sessionCtx,
      sourceAuthorityRoot: workspaceRoot,
      contextTree,
    });
    if (rpcClient && !rpcClient.isClosed) {
      sessionCtx.log("pi spawn-scoped config changed; restarting RPC process against the stable session id");
      await closeRpcClient();
    }
    if (!binary) throw new Error("Pi binary is not resolved");
    await mkdir(prepared.sessionDir, { recursive: true });
    const env = buildEnv(sessionCtx, prepared.payload);
    await runVersionGate(binary, env, prepared.workspaceCwd, sessionCtx);
    await assertContextSourceCurrent({
      sessionCtx,
      sourceAuthorityRoot: workspaceRoot,
      contextTree,
    });
    // Empty model: inherit whatever the persisted Pi session already selected.
    // Clearing config does not force a host-default reset on an existing session file.
    const args = buildPiRpcArgs({
      sessionId: prepared.sessionId,
      sessionDir: prepared.sessionDir,
      skillsDir: prepared.skillsDir,
      ...(prepared.payload.model ? { model: prepared.payload.model } : {}),
    });
    rpcClient = await PiRpcClient.start({
      binary,
      args,
      cwd: prepared.workspaceCwd,
      env,
      supervisor: processSupervisor,
      label: "pi rpc session",
      ...(settlementTimeoutMs !== undefined ? { settlementTimeoutMs } : {}),
      ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
      onEvent: (event) => {
        if (ctx) processPiEvent(event, ctx);
      },
      onCommandWritten: (command) => {
        if (command === "prompt" && turnObservation) {
          turnObservation.promptWriteCommitted = true;
          // Written but not yet accepted — treat as after-write unknown for replay.
          if (!turnObservation.promptAccepted) {
            turnObservation.attempt.setReplaySafety("provider_entered");
          }
          // Provider-entry boundary for operator-suspend resolution: the prompt
          // line crossed into Pi stdin. True before-write never reaches here.
          for (const entry of turnCustody) entry.token.processingStarted(entry.messages);
        }
      },
      onLog: (message) => sessionCtx.log(message),
    });
    activeSpawnFingerprint = nextFingerprint;
    try {
      const state = await rpcClient.getState();
      validateGetState(state, prepared.sessionId);
      if (prepared.payload.model) assertConfiguredModel(state, prepared.payload.model);
    } catch (error) {
      await closeRpcClient();
      throw error;
    }
    return rpcClient;
  }

  async function closeRpcClient(): Promise<void> {
    const client = rpcClient;
    rpcClient = null;
    activeSpawnFingerprint = null;
    // Re-verify the host binary on the next spawn (env/binary may have changed).
    versionReady = false;
    if (!client) return;
    try {
      await client.close();
    } catch (error) {
      ctx?.log(`pi rpc close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function adoptAssistantMessage(message: Record<string, unknown> | null): void {
    if (!turnObservation || !message) return;
    try {
      const fields = extractAssistantMessageFields(message);
      if (fields.provider) turnObservation.provider = fields.provider;
      if (fields.model) turnObservation.model = fields.model;
      if (fields.stopReason) turnObservation.stopReason = fields.stopReason;
      if (fields.usage) {
        const key = [
          String(message.timestamp ?? ""),
          fields.provider ?? "",
          fields.model ?? "",
          String(fields.usage.inputTokens),
          String(fields.usage.cachedInputTokens),
          String(fields.usage.outputTokens),
        ].join("|");
        if (!turnObservation.usageKeys.has(key)) {
          turnObservation.usageKeys.add(key);
          if (!turnObservation.usage) {
            turnObservation.usage = { ...fields.usage };
          } else {
            turnObservation.usage.inputTokens += fields.usage.inputTokens;
            turnObservation.usage.cachedInputTokens += fields.usage.cachedInputTokens;
            turnObservation.usage.outputTokens += fields.usage.outputTokens;
          }
        }
      }
    } catch {
      // Malformed telemetry must not throw after settlement.
    }
  }

  function processPiEvent(event: Record<string, unknown>, sessionCtx: SessionContext): void {
    sessionCtx.recordProviderActivity();
    const type = typeof event.type === "string" ? event.type : "";

    if (type === "message_update") {
      const assistantEvent = asRecord(event.assistantMessageEvent);
      const eventType = typeof assistantEvent?.type === "string" ? assistantEvent.type : "";
      if (eventType === "text_delta") {
        streaming = true;
        const delta = typeof assistantEvent?.delta === "string" ? assistantEvent.delta : "";
        if (delta && turnObservation) {
          turnObservation.assistantText += delta;
          turnObservation.userVisibleEmitted = true;
          turnObservation.provisionalError = null;
          if (turnObservation.promptAccepted) updateReplaySafety(turnObservation);
          sessionCtx.emitEvent({ kind: "assistant_text", payload: { text: delta } });
        }
        return;
      }
      if (eventType === "thinking_delta" || eventType === "thinking_start") {
        streaming = true;
        if (turnObservation && !turnObservation.thinkingEmitted) {
          turnObservation.thinkingEmitted = true;
          sessionCtx.emitEvent({ kind: "thinking", payload: {} });
        }
        return;
      }
      if (eventType === "error") {
        streaming = true;
        const errorObj = asRecord(assistantEvent?.error);
        const reason =
          typeof errorObj?.errorMessage === "string"
            ? errorObj.errorMessage
            : typeof assistantEvent?.errorMessage === "string"
              ? assistantEvent.errorMessage
              : typeof assistantEvent?.reason === "string"
                ? assistantEvent.reason
                : "assistant message error";
        if (turnObservation) {
          // Keep provisional until auto_retry_end; do not emit a terminal user error yet.
          turnObservation.provisionalError = reason;
          if (turnObservation.promptAccepted) updateReplaySafety(turnObservation);
        }
        sessionCtx.log(`pi assistant provisional error: ${sanitizePiProviderDetail(reason)}`);
        return;
      }
      return;
    }

    if (type === "message_end" || type === "turn_end") {
      adoptAssistantMessage(asRecord(event.message));
      return;
    }

    if (type === "tool_execution_start") {
      streaming = true;
      const toolCallId = String(event.toolCallId ?? `pi-tool-${activeTools.size + 1}`);
      const name = typeof event.toolName === "string" ? event.toolName : "tool";
      const args = event.args ?? {};
      const tool: ActiveTool = {
        name,
        args,
        startedAt: Date.now(),
        refs: cwd ? nativeToolRefs(name, args, cwd) : [],
      };
      activeTools.set(toolCallId, tool);
      if (turnObservation && !piToolIsReadOnly(name)) {
        turnObservation.unsafeToolEffectStarted = true;
        updateReplaySafety(turnObservation);
      }
      emitToolCall(sessionCtx, toolCallId, tool, "pending");
      return;
    }

    if (type === "tool_execution_update") {
      return;
    }

    if (type === "tool_execution_end") {
      const toolCallId = String(event.toolCallId ?? "");
      const tool = activeTools.get(toolCallId);
      if (!tool) return;
      const isError = event.isError === true;
      const refs =
        refsForCompletedTool({
          ok: !isError,
          readOnly: piToolIsReadOnly(tool.name),
          providerRefs: tool.refs,
          toolName: tool.name,
          toolUseId: toolCallId,
        }) ?? [];
      tool.refs = refs;
      emitToolCall(sessionCtx, toolCallId, tool, isError ? "error" : "ok", event.result);
      activeTools.delete(toolCallId);
      return;
    }

    if (type === "auto_retry_start") {
      const detail =
        typeof event.errorMessage === "string" ? sanitizePiProviderDetail(event.errorMessage) : "pi_provider_error";
      // Diagnostic only — Pi still owns the retry; do not surface as terminal.
      sessionCtx.log(`pi auto_retry_start: ${detail}`);
      return;
    }

    if (type === "auto_retry_end") {
      if (event.success === true) {
        if (turnObservation) {
          turnObservation.provisionalError = null;
          turnObservation.autoRetryFailed = null;
        }
        return;
      }
      const finalError =
        typeof event.finalError === "string"
          ? event.finalError
          : (turnObservation?.provisionalError ?? "pi auto_retry_end failed");
      if (turnObservation) {
        turnObservation.autoRetryFailed = finalError;
        turnObservation.turnError = finalError;
        turnObservation.provisionalError = null;
      }
      return;
    }

    if (type === "agent_settled") {
      streaming = false;
      if (turnObservation) turnObservation.settled = true;
      return;
    }
  }

  function formatPiFailure(message: string): string {
    const detail = sanitizePiProviderDetail(message);
    return detail === "pi_auth_required" || isPiAuthError(message) ? formatAuthHint("pi", detail) : detail;
  }

  async function completeCustody(outcome: Parameters<DeliveryToken["complete"]>[1]): Promise<"settled" | "retry"> {
    let disposition: "settled" | "retry" = "settled";
    const entries = turnCustody.splice(0);
    for (const entry of entries) {
      const result = await entry.token.complete(entry.messages, outcome);
      if (result === "retry") disposition = "retry";
    }
    return disposition;
  }

  function retryCustody(reason: string): void {
    for (const entry of turnCustody.splice(0)) entry.token.retry(entry.messages, reason);
  }

  async function settleAcceptedTurnFailure(sessionCtx: SessionContext, failure: string): Promise<void> {
    if (!turnObservation) {
      retryCustody("pi_turn_missing_observation");
      return;
    }
    // Pi already owned/exhausted its internal retry. Never stack another FT prompt resend.
    // promptWriteCommitted without accept is after-write unknown — still provider_entered.
    turnObservation.attempt.setReplaySafety(
      turnObservation.unsafeToolEffectStarted
        ? "unsafe"
        : turnObservation.userVisibleEmitted
          ? "user_visible"
          : "provider_entered",
    );
    const formatted = formatPiFailure(failure);
    const publicDetail = sanitizePiProviderDetail(failure);
    turnObservation.attempt.recordSignal({
      kind: "provider_error",
      // Classify on the original provider phrasing; only the preview is allow-listed.
      error: failure,
      messagePreview: publicDetail,
    });
    // Pi already owned/exhausted its retry: settle at the shared budget ceiling so
    // capacity/transient map to provider_retry_exhausted (never FT re-prompt).
    const settlement = turnObservation.attempt.settle({ attempt: maxRetries + 1 });
    if (settlement) emitSettlement(sessionCtx, settlement);
    const failedUsage = readTurnUsage(turnObservation);
    if (failedUsage) {
      sessionCtx.emitEvent({
        kind: "token_usage",
        payload: {
          provider: turnObservation.provider ?? "pi",
          model: turnObservation.model ?? (activePayload?.model || "pi-default"),
          inputTokens: failedUsage.inputTokens,
          cachedInputTokens: failedUsage.cachedInputTokens,
          outputTokens: failedUsage.outputTokens,
        },
      });
    }
    sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: formatted.slice(0, 2000) } });
    sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
    await completeCustody({
      status: "error",
      completion: "consumed",
      reason: isPiAuthError(failure)
        ? "credential"
        : settlement?.decision.action === "stop" && settlement.decision.terminalKind === "exhausted"
          ? "provider_retry_exhausted"
          : (settlement?.decision.reasonCode ?? "pi_accepted_turn_failed"),
    });
  }

  async function executeTurn(
    prompt: string,
    sessionCtx: SessionContext,
    custody: CustodyEntry[],
    client: PiRpcClient,
  ): Promise<boolean> {
    turnCustody = custody.map((entry) => ({ messages: entry.messages, token: entry.token }));
    let activeClient = client;
    turnObservation = {
      assistantText: "",
      settled: false,
      provisionalError: null,
      turnError: null,
      thinkingEmitted: false,
      unsafeToolEffectStarted: false,
      userVisibleEmitted: false,
      usage: null,
      usageKeys: new Set(),
      provider: null,
      model: null,
      stopReason: null,
      autoRetryFailed: null,
      promptWriteCommitted: false,
      promptPreflightRejected: false,
      promptAccepted: false,
      attempt: new ProviderAttempt({
        provider: runtimeProvider,
        scope: "provider_turn",
        source: "stream",
      }),
    };
    activeTools.clear();
    streaming = false;

    for (let attemptNumber = 1; attemptNumber <= maxRetries + 1; attemptNumber += 1) {
      if (!sessionActive) {
        await settleLifecycleCancellation(sessionCtx, "pi_turn_cancelled");
        return false;
      }
      if (activeClient.isClosed) {
        // Before-write FT retries need a live client; never reuse a fenced process.
        if (!cwd || !sessionId || !ctx) {
          retryCustody("pi_client_closed");
          return false;
        }
        try {
          const prepared = await refreshPreparedSession(sessionCtx);
          activeClient = await ensureRpcClient(prepared, sessionCtx);
        } catch (sourceError) {
          if (!isContextSourceTransitionError(sourceError)) throw sourceError;
          retryCustody("pi_context_source_changed");
          sessionCtx.failSessionForRecovery?.("pi_context_source_changed", sessionId ?? undefined);
          return false;
        }
      }
      turnObservation.assistantText = "";
      turnObservation.settled = false;
      turnObservation.provisionalError = null;
      turnObservation.turnError = null;
      turnObservation.thinkingEmitted = false;
      turnObservation.unsafeToolEffectStarted = false;
      turnObservation.userVisibleEmitted = false;
      turnObservation.usage = null;
      turnObservation.usageKeys = new Set();
      turnObservation.provider = null;
      turnObservation.model = null;
      turnObservation.stopReason = null;
      turnObservation.autoRetryFailed = null;
      turnObservation.promptWriteCommitted = false;
      turnObservation.promptPreflightRejected = false;
      turnObservation.promptAccepted = false;
      turnObservation.attempt = new ProviderAttempt({
        provider: runtimeProvider,
        scope: "provider_turn",
        source: "stream",
      });
      activeClient.clearSettled();
      activeTools.clear();
      streaming = false;
      gitWriteTracker.captureBaseline();

      let promptResponse: Awaited<ReturnType<PiRpcClient["prompt"]>> | null = null;
      let thrown: Error | null = null;
      try {
        promptResponse = await activeClient.prompt(prompt);
      } catch (error) {
        thrown = error instanceof Error ? error : new Error(String(error));
      }

      if (!sessionActive) {
        // Shutdown during prompt await — settle by write/accept evidence, not blind retry.
        await settleLifecycleCancellation(sessionCtx, "pi_turn_cancelled");
        return false;
      }

      if (thrown) {
        if (isPiRpcBeforeWriteError(thrown)) {
          turnObservation.attempt.setReplaySafety("pre_provider");
          turnObservation.attempt.recordSignal({ kind: "local_error", error: thrown });
          const settlement = turnObservation.attempt.settle({ attempt: attemptNumber });
          if (settlement && settlement.decision.action === "retry") {
            const delayMs = settlement.decision.delayMs;
            emitSettlement(sessionCtx, settlement);
            const completedDelay = await sleepForRetry(delayMs);
            if (!completedDelay || !sessionActive || lifecycleOwnsRecovery()) {
              await settleLifecycleCancellation(sessionCtx, "pi_turn_cancelled");
              return false;
            }
            continue;
          }
          if (settlement) emitSettlement(sessionCtx, settlement);
          const formatted = formatPiFailure(thrown.message);
          sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: formatted.slice(0, 2000) } });
          sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
          await completeCustody({
            status: "error",
            completion: "consumed",
            reason: settlement?.decision.reasonCode ?? "pi_transport_error",
          });
          return false;
        }
        // After-write / unknown: fence and consume — never auto-resend.
        // Lifecycle drain prefers settleLifecycleCancellation (durable notice path).
        if (lifecycleOwnsRecovery()) {
          await settleLifecycleCancellation(sessionCtx, "pi_turn_cancelled");
          return false;
        }
        consumeOneShotPromptState();
        turnObservation.attempt.setReplaySafety("provider_entered");
        turnObservation.attempt.recordSignal({ kind: "transport_close", error: thrown });
        const settlement = turnObservation.attempt.settle({ attempt: attemptNumber });
        if (settlement) emitSettlement(sessionCtx, settlement);
        const formatted = formatPiFailure(thrown.message);
        sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: formatted.slice(0, 2000) } });
        sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
        await closeRpcClient();
        await completeCustody({
          status: "error",
          completion: "consumed",
          reason: settlement?.decision.reasonCode ?? "pi_prompt_response_unknown",
        });
        return false;
      }

      if (!promptResponse?.success) {
        // Preflight rejection: retain one-shot context; proven pre_provider — follow shared retry.
        const failure = promptResponse?.error ?? "pi prompt rejected";
        const formatted = formatPiFailure(failure);
        const publicDetail = sanitizePiProviderDetail(failure);
        turnObservation.promptPreflightRejected = true;
        turnObservation.attempt.setReplaySafety("pre_provider");
        turnObservation.attempt.recordSignal({
          kind: "provider_error",
          error: failure,
          messagePreview: publicDetail,
        });
        const settlement = turnObservation.attempt.settle({ attempt: attemptNumber });
        if (settlement && settlement.decision.action === "retry") {
          const delayMs = settlement.decision.delayMs;
          emitSettlement(sessionCtx, settlement);
          const completedDelay = await sleepForRetry(delayMs);
          if (!completedDelay || !sessionActive || lifecycleOwnsRecovery()) {
            await settleLifecycleCancellation(sessionCtx, "pi_turn_cancelled");
            return false;
          }
          continue;
        }
        if (settlement) emitSettlement(sessionCtx, settlement);
        sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: formatted.slice(0, 2000) } });
        sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
        await completeCustody({
          status: "error",
          completion: "consumed",
          reason: isPiAuthError(failure)
            ? "credential"
            : settlement?.decision.action === "stop" && settlement.decision.terminalKind === "exhausted"
              ? "provider_retry_exhausted"
              : (settlement?.decision.reasonCode ?? "pi_preflight_failed"),
        });
        return false;
      }

      // Accepted: consume one-shot state and mark provider_entered for all later failures.
      turnObservation.promptWriteCommitted = true;
      turnObservation.promptAccepted = true;
      turnObservation.attempt.setReplaySafety("provider_entered");
      consumeOneShotPromptState();
      for (const entry of turnCustody) entry.token.processingStarted(entry.messages);

      try {
        await activeClient.waitForSettled();
      } catch (error) {
        await awaitPendingSteers();
        const transportError = error instanceof Error ? error : new Error(String(error));
        if (!sessionActive) {
          await settleLifecycleCancellation(sessionCtx, "pi_turn_cancelled");
          return false;
        }
        // Never downgrade accepted custody to pre_provider; never resend.
        turnObservation.attempt.setReplaySafety(
          turnObservation.unsafeToolEffectStarted
            ? "unsafe"
            : turnObservation.userVisibleEmitted
              ? "user_visible"
              : "provider_entered",
        );
        turnObservation.attempt.recordSignal({ kind: "transport_close", error: transportError });
        const settlement = turnObservation.attempt.settle({ attempt: attemptNumber });
        if (settlement) emitSettlement(sessionCtx, settlement);
        const formatted = formatPiFailure(transportError.message);
        sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: formatted.slice(0, 2000) } });
        sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
        await closeRpcClient();
        await completeCustody({
          status: "error",
          completion: "consumed",
          reason: settlement?.decision.reasonCode ?? "pi_settlement_failed",
        });
        return false;
      }

      if (!sessionActive) {
        await settleLifecycleCancellation(sessionCtx, "pi_turn_cancelled");
        return false;
      }

      await awaitPendingSteers();

      const acceptedFailure =
        turnObservation.autoRetryFailed ??
        turnObservation.turnError ??
        (turnObservation.provisionalError &&
        turnObservation.stopReason &&
        !NORMAL_STOP_REASONS.has(turnObservation.stopReason)
          ? turnObservation.provisionalError
          : null) ??
        (turnObservation.stopReason && !NORMAL_STOP_REASONS.has(turnObservation.stopReason)
          ? `pi stopReason=${turnObservation.stopReason}`
          : null);
      if (acceptedFailure) {
        await settleAcceptedTurnFailure(sessionCtx, acceptedFailure);
        return false;
      }

      const successUsage = readTurnUsage(turnObservation);
      if (successUsage) {
        sessionCtx.emitEvent({
          kind: "token_usage",
          payload: {
            provider: turnObservation.provider ?? "pi",
            model: turnObservation.model ?? (activePayload?.model || "pi-default"),
            inputTokens: successUsage.inputTokens,
            cachedInputTokens: successUsage.cachedInputTokens,
            outputTokens: successUsage.outputTokens,
          },
        });
      }

      const assistantText = turnObservation.assistantText;
      try {
        await sessionCtx.forwardResult(assistantText);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sessionCtx.emitEvent({ kind: "error", payload: { source: "runtime", message: `forward failed: ${message}` } });
        sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
        await completeCustody({
          status: "error",
          completion: "consumed",
          reason: "forward_failed",
        });
        return false;
      }
      sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "success" } });
      const completion = await completeCustody({ status: "success" });
      if (completion === "retry") return false;
      return true;
    }

    retryCustody("pi_retry_loop_exited");
    return false;
  }

  async function runTurn(
    prompt: string,
    sessionCtx: SessionContext,
    custody: CustodyEntry[],
    client: PiRpcClient,
  ): Promise<boolean> {
    const promise = executeTurn(prompt, sessionCtx, custody, client);
    currentTurnPromise = promise;
    try {
      return await promise;
    } finally {
      if (currentTurnPromise === promise) currentTurnPromise = null;
      turnObservation = null;
      turnCustody = [];
      streaming = false;
      if (sessionActive && !lifecycleOwnsRecovery()) scheduleQueuedMessagesDrain();
    }
  }

  async function refreshPreparedSession(sessionCtx: SessionContext): Promise<PreparedSession> {
    if (!cwd || !sessionId) throw new Error("pi session is not prepared");
    const generation = lifecycleGeneration;
    const existingPayload = activePayload;
    let runtimeConfig: AgentRuntimeConfig | null = null;
    let payload: AgentRuntimeConfigPayload | null = activePayload;
    let payloadResolved = false;
    if (agentConfigCache) {
      runtimeConfig = await refreshConfigOrAbort(generation, sessionCtx, "prepared_refresh");
      payload = runtimeConfig.payload;
      payloadResolved = true;
      assertLifecycleGeneration(generation, "prepared_refresh");
    }
    payload ??= { ...DEFAULT_PI_RUNTIME_CONFIG_PAYLOAD };
    if (payload.kind !== "pi") {
      throw new Error(`runtime provider mismatch: expected pi, got ${payload.kind}`);
    }
    rejectMcpConfiguration(payload);
    const projected = await projectManagedWorkspace({
      sessionCtx,
      workspace: cwd,
      agentName,
      runtimeProvider,
      providerSkillRoots: PROVIDER_SKILL_ROOTS,
      runtimeConfig,
      payload,
      payloadResolved,
      existingPayload: existingPayload ?? undefined,
      contextTree,
      reresolveSource: true,
      markInitComplete: false,
      atProjectionEntry: (): undefined => {
        assertLifecycleGeneration(generation, "prepared_refresh_projection");
        return undefined;
      },
      beforeBriefing: () => {
        assertLifecycleGeneration(generation, "prepared_refresh_skills");
      },
    });
    assertLifecycleGeneration(generation, "prepared_refresh_activate");
    reconciledTeamSkills = projected.teamSkills;
    activeResourceConfigVersion = projected.resourceConfigVersion;
    activeSkillsDigest = skillsContentDigest(reconciledTeamSkills, activeResourceConfigVersion);
    activeBriefingText = projected.briefing;
    activePayload = payload;
    return {
      payload,
      workspaceCwd: cwd,
      sessionId,
      sessionDir: join(cwd, PI_SESSIONS_DIR),
      skillsDir: join(cwd, PI_SKILLS_DIR),
      briefing: projected.briefing,
    };
  }

  function capturedPreparedSession(): PreparedSession {
    if (!cwd || !sessionId || !activePayload || activeBriefingText === null) {
      throw new Error("pi active session has no captured prepared projection");
    }
    return {
      payload: activePayload,
      workspaceCwd: cwd,
      sessionId,
      sessionDir: join(cwd, PI_SESSIONS_DIR),
      skillsDir: join(cwd, PI_SKILLS_DIR),
      briefing: activeBriefingText,
    };
  }

  /**
   * Shared-policy settlement for active pre-provider failures (refresh, format,
   * RPC restart, get_state, version gate). Retains the drained batch and
   * one-shot custody; never unbounded inbox `token.retry`.
   */
  async function settleQueuedPreProviderFailure(
    drained: Array<{ message: SessionMessage; token: DeliveryToken }>,
    sessionCtx: SessionContext,
    error: unknown,
    attemptNumber: number,
  ): Promise<{ action: "retry"; delayMs: number } | { action: "stop" }> {
    const raw = error instanceof Error ? error.message : String(error);
    const publicDetail = sanitizePiProviderDetail(raw);
    const attempt = new ProviderAttempt({
      provider: runtimeProvider,
      scope: "provider_turn",
      source: "session",
    });
    attempt.setReplaySafety("pre_provider");
    attempt.recordSignal({ kind: "provider_error", error, messagePreview: publicDetail });
    const settlement = attempt.settle({ attempt: attemptNumber });
    if (!settlement) {
      sessionCtx.log(`pi queued turn unclassified: ${publicDetail}`);
      for (const entry of drained) {
        await entry.token.complete([entry.message], {
          status: "error",
          completion: "consumed",
          reason: "pi_queued_turn_failed",
        });
      }
      return { action: "stop" };
    }
    emitSettlement(sessionCtx, settlement);
    if (settlement.decision.action === "retry") {
      sessionCtx.log(
        `pi queued pre-provider retry scheduled: ${settlement.decision.reasonCode} attempt=${attemptNumber}`,
      );
      return { action: "retry", delayMs: settlement.decision.delayMs };
    }
    sessionCtx.emitEvent({
      kind: "error",
      payload: { source: "sdk", message: formatPiFailure(raw).slice(0, 2000) },
    });
    sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
    const reason =
      settlement.decision.terminalKind === "exhausted" ? "provider_retry_exhausted" : settlement.decision.reasonCode;
    for (const entry of drained) {
      await entry.token.complete([entry.message], {
        status: "error",
        completion: "consumed",
        reason,
      });
    }
    return { action: "stop" };
  }

  async function mergeAndRun(drained: QueuedDelivery[], sessionCtx: SessionContext): Promise<void> {
    // A healthy live RPC remains on its captured source/config for ordinary
    // injections. Re-authorize and refresh only when a real process spawn is
    // required; otherwise another Chat's newer projection must not be
    // overwritten and this handler must not emit telemetry for that source.
    const prepared =
      rpcClient && !rpcClient.isClosed ? capturedPreparedSession() : await refreshPreparedSession(sessionCtx);
    const prompts: string[] = [];
    for (const entry of drained) {
      prompts.push(await sessionCtx.formatInboundContent(entry.message));
    }
    if (prompts.length === 0) {
      throw new Error("pi queued turn produced no prompt text");
    }
    const client = await ensureRpcClient(prepared, sessionCtx);
    const prompt = await buildTurnPrompt(sessionCtx, prompts.join("\n\n"), prepared);
    await runTurn(
      prompt,
      sessionCtx,
      drained.map((entry) => ({ messages: [entry.message], token: entry.token })),
      client,
    );
  }

  function finishDrainingBatch(batch: QueuedDelivery[]): void {
    if (drainingBatch === batch) drainingBatch = null;
  }

  function retryDrainingBatch(batch: QueuedDelivery[], reason: string): void {
    if (drainingBatch !== batch) return;
    finishDrainingBatch(batch);
    for (const entry of batch) entry.token.retry(entry.message, reason);
  }

  function drainStillOwns(batch: QueuedDelivery[], drainGeneration: number): boolean {
    return (
      sessionActive && !lifecycleOwnsRecovery() && lifecycleGeneration === drainGeneration && drainingBatch === batch
    );
  }

  async function runQueuedDrain(
    drained: QueuedDelivery[],
    sessionCtx: SessionContext,
    drainGeneration: number,
  ): Promise<void> {
    let attemptNumber = 1;
    while (drainStillOwns(drained, drainGeneration)) {
      try {
        await mergeAndRun(drained, sessionCtx);
        finishDrainingBatch(drained);
        return;
      } catch (error) {
        if (!drainStillOwns(drained, drainGeneration)) return;
        if (isContextSourceTransitionError(error)) {
          retryDrainingBatch(drained, "pi_context_source_changed");
          sessionCtx.failSessionForRecovery?.("pi_context_source_changed", sessionId ?? undefined);
          return;
        }
        const outcome = await settleQueuedPreProviderFailure(drained, sessionCtx, error, attemptNumber);
        if (outcome.action !== "retry") {
          finishDrainingBatch(drained);
          return;
        }
        if (!drainStillOwns(drained, drainGeneration)) return;
        const completedDelay = await sleepForRetry(outcome.delayMs);
        // Lifecycle end aborts the sleep and recovers the batch exactly once.
        if (!completedDelay || !drainStillOwns(drained, drainGeneration)) return;
        attemptNumber += 1;
      }
    }
  }

  function scheduleQueuedMessagesDrain(): void {
    if (drainScheduled || drainInProgress || drainingBatch || initialTurnPreparing || lifecycleOwnsRecovery()) {
      return;
    }
    if (!sessionActive || !ctx || !cwd || !sessionId || currentTurnPromise || queuedMessages.length === 0) return;
    drainScheduled = true;
    setImmediate(() => {
      drainScheduled = false;
      if (
        drainInProgress ||
        drainingBatch ||
        lifecycleOwnsRecovery() ||
        !sessionActive ||
        !ctx ||
        !cwd ||
        !sessionId ||
        currentTurnPromise ||
        queuedMessages.length === 0
      ) {
        return;
      }
      const sessionCtx = ctx;
      const drained = queuedMessages.splice(0);
      const drainGeneration = lifecycleGeneration;
      drainingBatch = drained;
      drainInProgress = true;
      const drainPromise = runQueuedDrain(drained, sessionCtx, drainGeneration)
        .catch((error) => {
          if (lifecycleOwnsRecovery()) return;
          sessionCtx.log(`pi queued turn failed: ${sanitizePiProviderDetail(String(error))}`);
          retryDrainingBatch(drained, "pi_queued_turn_failed");
        })
        .finally(() => {
          if (!lifecycleOwnsRecovery() && drainingBatch === drained) finishDrainingBatch(drained);
          drainInProgress = false;
          if (currentDrainPromise === drainPromise) currentDrainPromise = null;
          if (sessionActive && !lifecycleOwnsRecovery()) scheduleQueuedMessagesDrain();
        });
      currentDrainPromise = drainPromise;
    });
  }

  function retryQueuedMessages(reason: string): void {
    for (const entry of queuedMessages.splice(0)) entry.token.retry(entry.message, reason);
  }

  async function endLifecycle(
    recoveryReason: string,
    opts: { settleProviderEntered?: boolean; settleMode?: "graceful_drain" | "operator_suspend" } = {},
  ): Promise<void> {
    sessionActive = false;
    drainCancellationReason = recoveryReason;
    settleProviderEnteredMode = opts.settleMode ?? (opts.settleProviderEntered === true ? "graceful_drain" : null);
    lifecycleGeneration += 1;
    notifyLifecycleAbort();
    currentRetryAbort?.abort();
    // Abort whenever a prompt may have entered Pi — do not wait for first stream event.
    const mayNeedAbort =
      rpcClient !== null &&
      !rpcClient.isClosed &&
      (streaming ||
        turnObservation?.promptWriteCommitted === true ||
        turnObservation?.promptAccepted === true ||
        (settleProviderEnteredMode !== null && currentTurnPromise !== null));
    if (mayNeedAbort) {
      await abortAndWaitForSettlement(settleProviderEnteredMode !== null ? "shutdown" : "suspend");
    }
    // Fence any still-pending prompt response so the turn can join promptly.
    // Abort alone does not resolve a withheld prompt RPC response; without this
    // close, write-committed gaps hang until request timeout even on plain suspend.
    if (
      currentTurnPromise &&
      rpcClient &&
      !rpcClient.isClosed &&
      (settleProviderEnteredMode !== null ||
        turnObservation?.promptWriteCommitted === true ||
        turnObservation?.promptAccepted === true)
    ) {
      await closeRpcClient();
    }
    await Promise.all([
      currentTurnPromise?.then(
        () => undefined,
        () => undefined,
      ),
      currentDrainPromise?.then(
        () => undefined,
        () => undefined,
      ),
    ]);
    if (drainingBatch) retryDrainingBatch(drainingBatch, recoveryReason);
    retryQueuedMessages(recoveryReason);
    retryCustody(recoveryReason);
    await closeRpcClient();
    drainCancellationReason = null;
    settleProviderEnteredMode = null;
    currentRetryAbort = null;
    currentTurnPromise = null;
    currentDrainPromise = null;
    initialTurnPreparing = false;
    ctx = null;
    cwd = null;
    sessionId = null;
    activePayload = null;
    streaming = false;
    activeTools.clear();
  }

  function assertLifecycleGeneration(generation: number, phase: string): void {
    if (generation !== lifecycleGeneration) {
      throw new PiLifecycleCancelledError(phase);
    }
  }

  function notifyLifecycleAbort(): void {
    for (const wake of lifecycleAbortWaiters) wake();
    lifecycleAbortWaiters.clear();
  }

  /**
   * Disposable abort waiter for racing host I/O against lifecycle end.
   * Callers must `dispose()` in `finally` so a winning refresh does not leave
   * the losing closure registered until suspend/shutdown.
   */
  function waitForLifecycleAbort(generation: number, phase: string): { promise: Promise<never>; dispose: () => void } {
    let disposed = false;
    let wake: (() => void) | null = null;
    const promise = new Promise<never>((_, reject) => {
      wake = () => {
        if (disposed) return;
        disposed = true;
        if (wake) lifecycleAbortWaiters.delete(wake);
        reject(new PiLifecycleCancelledError(phase));
      };
      if (generation !== lifecycleGeneration) {
        disposed = true;
        reject(new PiLifecycleCancelledError(phase));
        return;
      }
      lifecycleAbortWaiters.add(wake);
    });
    return {
      promise,
      dispose: () => {
        if (disposed || !wake) return;
        disposed = true;
        lifecycleAbortWaiters.delete(wake);
      },
    };
  }

  async function refreshConfigOrAbort(
    generation: number,
    sessionCtx: SessionContext,
    phase: string,
  ): Promise<AgentRuntimeConfig> {
    if (!agentConfigCache) {
      throw new Error("pi agent config cache is required for refresh");
    }
    const abort = waitForLifecycleAbort(generation, phase);
    try {
      return await Promise.race([agentConfigCache.refresh(sessionCtx.agent.agentId), abort.promise]);
    } finally {
      abort.dispose();
    }
  }

  async function prepareSession(sessionCtx: SessionContext, resolvedSessionId: string): Promise<PreparedSession> {
    const generation = lifecycleGeneration;
    const existingPayload = activePayload;
    if (isLandingCampaignTrialAgentMetadata(sessionCtx.agent.metadata)) {
      throw new Error("landing campaign trial agents require the codex app-server workspace-only runtime");
    }
    if (!supportsDefaultProviderProcessSupervision(platform)) {
      throw new Error(
        "Pi runtime provider is not supported on Windows in V1 (macOS/Linux only); First Tree fails closed on this platform.",
      );
    }
    ctx = sessionCtx;
    // The caller owns identity selection: `start` mints a fresh-start id from
    // the first inbound message; `resume` passes the persisted mapping id.
    sessionId = resolvedSessionId;

    let runtimeConfig: AgentRuntimeConfig | null = null;
    let payload: AgentRuntimeConfigPayload | null = null;
    if (agentConfigCache) {
      runtimeConfig = await refreshConfigOrAbort(generation, sessionCtx, "prepare_refresh");
      payload = runtimeConfig.payload;
    }
    assertLifecycleGeneration(generation, "prepare_refresh");
    const payloadResolved = payload !== null;
    payload ??= { ...DEFAULT_PI_RUNTIME_CONFIG_PAYLOAD };
    if (payload.kind !== "pi") {
      throw new Error(`runtime provider mismatch: expected pi, got ${payload.kind}`);
    }
    rejectMcpConfiguration(payload);

    const resolution = resolveBinary(process.env);
    if (!resolution.ok) {
      throw new Error(resolution.error);
    }
    binary = resolution.binary;
    sessionCtx.log(`Pi binary: ${resolution.binary}`);

    const prepared = await prepareManagedSession({
      sessionCtx,
      workspaceRoot,
      agentName,
      runtimeProvider,
      providerSkillRoots: PROVIDER_SKILL_ROOTS,
      runtimeConfig,
      payload,
      payloadResolved,
      existingPayload: existingPayload ?? undefined,
      contextTree,
      atProjectionEntry: (): undefined => {
        // Sync fence at projection entry (first statement of
        // projectManagedWorkspace, before any await) — closes the microtask
        // window after chat-context fetch where suspend could otherwise advance
        // generation before reconcile. Must stay synchronous (no async/await).
        // Return type is `undefined` (not `void`) so async callbacks are a type error.
        assertLifecycleGeneration(generation, "prepare_before_projection");
        return undefined;
      },
      beforeBriefing: () => {
        // Sync lifecycle fence after Managed Skills and before briefing/bootstrap/
        // init sentinel — must return void (not async) so the helper does not
        // unconditionally await a microtask window. Cancellation here is
        // pre-provider and creates no ACK authority.
        assertLifecycleGeneration(generation, "prepare_skills");
      },
    });
    const workspaceCwd = prepared.workspace;
    cwd = workspaceCwd;
    reconciledTeamSkills = prepared.teamSkills;
    activeResourceConfigVersion = prepared.resourceConfigVersion;
    activeSkillsDigest = skillsContentDigest(reconciledTeamSkills, activeResourceConfigVersion);
    const briefing = prepared.briefing;

    assertLifecycleGeneration(generation, "prepare_chat_context");
    pendingChatContextPrompt = [renderRuntimeOutputContract(), renderChatContextPrompt(prepared.chatContext)]
      .filter(Boolean)
      .join("\n\n");
    oneShotConsumed = false;
    activeBriefingText = briefing;
    activePayload = payload;
    assertLifecycleGeneration(generation, "prepare_activate");
    sessionActive = true;

    return {
      payload,
      workspaceCwd,
      sessionId: resolvedSessionId,
      sessionDir: join(workspaceCwd, PI_SESSIONS_DIR),
      skillsDir: join(workspaceCwd, PI_SKILLS_DIR),
      briefing,
    };
  }

  async function buildTurnPrompt(
    _sessionCtx: SessionContext,
    basePrompt: string,
    prepared: PreparedSession,
  ): Promise<string> {
    const parts: string[] = [];
    if (pendingChatContextPrompt) parts.push(pendingChatContextPrompt);
    const fingerprint = computeBriefingFingerprint(prepared.briefing);
    if (readSessionBriefingFingerprint(prepared.workspaceCwd, prepared.sessionId) !== fingerprint) {
      parts.push(buildBriefingUpdateNotice(join(prepared.workspaceCwd, "AGENTS.md")));
    }
    parts.push(basePrompt);
    return parts.join("\n\n");
  }

  async function cleanupFailedInitialization(): Promise<void> {
    sessionActive = false;
    retryQueuedMessages("pi_initialization_failed");
    retryCustody("pi_initialization_failed");
    await closeRpcClient();
    cwd = null;
    ctx = null;
    sessionId = null;
    activePayload = null;
    initialTurnPreparing = false;
    activeTools.clear();
    streaming = false;
  }

  async function abortAndWaitForSettlement(reason: string): Promise<void> {
    const client = rpcClient;
    if (!client || client.isClosed) return;
    const settledPromise = client.hasSettled ? Promise.resolve() : client.waitForSettled();
    try {
      const abortPromise = client.abort();
      const [abortResult] = await Promise.all([abortPromise, settledPromise]);
      if (!abortResult.success) {
        ctx?.log(`pi abort during ${reason} failed: ${abortResult.error ?? "unknown"}`);
      }
    } catch (error) {
      ctx?.log(`pi ${reason} abort failed: ${error instanceof Error ? error.message : String(error)}`);
      try {
        await settledPromise;
      } catch {
        // settlement already failed with the same transport error
      }
    }
  }

  const handler = {
    async start(message, sessionCtx, token) {
      const deliveryToken = token;
      // Mint the fresh-start identity from the first inbound message plus any
      // durable Reset tombstone (see freshStartPiSessionId). Mapping deletion
      // alone is not enough: same-row redelivery after restart must still mint
      // a different Pi id when a Reset nonce is present.
      const startSessionId = freshStartPiSessionId(
        sessionCtx.agent.agentId,
        sessionCtx.chatId,
        message.id,
        sessionCtx.freshStartNonce?.(),
      );
      let prepared: PreparedSession;
      try {
        prepared = await prepareSession(sessionCtx, startSessionId);
      } catch (error) {
        if (error instanceof PiLifecycleCancelledError) {
          deliveryToken.retry([message], "pi_turn_cancelled");
          return { sessionId: startSessionId, route: { kind: "owned", mode: "processing" } };
        }
        await cleanupFailedInitialization();
        throw error;
      }
      if (!sessionActive) {
        deliveryToken.retry([message], "pi_turn_cancelled");
        return { sessionId: prepared.sessionId, route: { kind: "owned", mode: "processing" } };
      }
      initialTurnPreparing = true;
      try {
        const client = await ensureRpcClient(prepared, sessionCtx);
        if (!sessionActive) {
          deliveryToken.retry([message], "pi_turn_cancelled");
          return { sessionId: prepared.sessionId, route: { kind: "owned", mode: "processing" } };
        }
        const basePrompt = await sessionCtx.formatInboundContent(message);
        if (!sessionActive) {
          deliveryToken.retry([message], "pi_turn_cancelled");
          return { sessionId: prepared.sessionId, route: { kind: "owned", mode: "processing" } };
        }
        const prompt = await buildTurnPrompt(sessionCtx, basePrompt, prepared);
        await runTurn(prompt, sessionCtx, [{ messages: [message], token: deliveryToken }], client);
      } catch (error) {
        if (error instanceof PiBinaryVerifyTransientError) {
          deliveryToken.retry([message], "pi_version_gate_transient");
          throw error;
        }
        if (error instanceof PiLifecycleCancelledError) {
          deliveryToken.retry([message], "pi_turn_cancelled");
          return { sessionId: prepared.sessionId, route: { kind: "owned", mode: "processing" } };
        }
        await cleanupFailedInitialization();
        throw error;
      } finally {
        initialTurnPreparing = false;
        scheduleQueuedMessagesDrain();
      }
      return { sessionId: prepared.sessionId, route: { kind: "owned", mode: "processing" } };
    },

    async resume(message, id, sessionCtx, token) {
      const deliveryToken = message ? requireDeliveryToken(token, "messageful resume") : noopDeliveryToken();
      let prepared: PreparedSession;
      try {
        // Resume adopts the persisted mapping id verbatim: First Tree's
        // registry is the identity authority and Reset is the retirement
        // boundary (see freshStartPiSessionId).
        prepared = await prepareSession(sessionCtx, id);
      } catch (error) {
        if (error instanceof PiLifecycleCancelledError) {
          if (message) deliveryToken.retry([message], "pi_turn_cancelled");
          return { sessionId: id, route: message ? { kind: "owned", mode: "processing" } : null };
        }
        await cleanupFailedInitialization();
        throw error;
      }
      if (message) {
        if (!sessionActive) {
          deliveryToken.retry([message], "pi_turn_cancelled");
          return {
            sessionId: prepared.sessionId,
            route: { kind: "owned", mode: "processing" },
          };
        }
        initialTurnPreparing = true;
        try {
          const client = await ensureRpcClient(prepared, sessionCtx);
          if (!sessionActive) {
            deliveryToken.retry([message], "pi_turn_cancelled");
            return {
              sessionId: prepared.sessionId,
              route: { kind: "owned", mode: "processing" },
            };
          }
          const basePrompt = await sessionCtx.formatInboundContent(message);
          if (!sessionActive) {
            deliveryToken.retry([message], "pi_turn_cancelled");
            return {
              sessionId: prepared.sessionId,
              route: { kind: "owned", mode: "processing" },
            };
          }
          const prompt = await buildTurnPrompt(sessionCtx, basePrompt, prepared);
          await runTurn(prompt, sessionCtx, [{ messages: [message], token: deliveryToken }], client);
        } catch (error) {
          if (error instanceof PiBinaryVerifyTransientError) {
            deliveryToken.retry([message], "pi_version_gate_transient");
            throw error;
          }
          if (error instanceof PiLifecycleCancelledError) {
            deliveryToken.retry([message], "pi_turn_cancelled");
            return {
              sessionId: prepared.sessionId,
              route: { kind: "owned", mode: "processing" },
            };
          }
          await cleanupFailedInitialization();
          throw error;
        } finally {
          initialTurnPreparing = false;
          scheduleQueuedMessagesDrain();
        }
      } else {
        scheduleQueuedMessagesDrain();
      }
      return {
        sessionId: prepared.sessionId,
        route: message ? { kind: "owned", mode: "processing" } : null,
      };
    },

    inject(message, token) {
      if (!ctx || !sessionActive) return { kind: "rejected", reason: "no_active_context", retryable: true };
      const deliveryToken = token;
      // Steer once the active turn has crossed the provider write/accept
      // boundary — do not wait for the first stream event. Once the current
      // observation is settled, close the steer window: post-agent_settled
      // injects must queue as the next prompt so accepted custody cannot be
      // appended after awaitPendingSteers / completeCustody. success:false
      // retains the settle-vs-steer queue fallback below.
      const canAttemptSteer =
        rpcClient !== null &&
        !rpcClient.isClosed &&
        turnObservation !== null &&
        !turnObservation.settled &&
        (streaming || turnObservation.promptAccepted === true || turnObservation.promptWriteCommitted === true);
      if (canAttemptSteer) {
        const steerWork = (async () => {
          // Formatting is provably pre-RPC: ANY failure here is
          // recoverable (the provider never saw the input) and must retry
          // — never close/consume. Only errors from the actual steer RPC
          // fall through to the after-write/unknown branch below.
          let formatted: string | undefined;
          try {
            const preparedPayload = activePayload ?? { ...DEFAULT_PI_RUNTIME_CONFIG_PAYLOAD };
            rejectMcpConfiguration(preparedPayload);
            formatted = await ctx?.formatInboundContent(message);
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            ctx?.log(`pi steer formatting failed: ${messageText}`);
            deliveryToken.retry(
              message,
              isTeamSkillCommandUnavailableError(error) ? "team_skill_command_unavailable" : "pi_steer_format_failed",
            );
            return;
          }
          if (!formatted || !rpcClient) {
            deliveryToken.retry(message, "pi_steer_unavailable");
            return;
          }
          try {
            const response = await rpcClient.steer(formatted);
            if (!response.success) {
              // Common settle-vs-steer race: retain custody and queue as the next prompt.
              const failure = response.error ?? "pi steer rejected";
              ctx?.log(`pi steer rejected (${failure}); queueing inbound message for the next prompt`);
              queuedMessages.push({ message, token: deliveryToken });
              scheduleQueuedMessagesDrain();
              return;
            }
            deliveryToken.processingStarted([message]);
            turnCustody.push({ messages: [message], token: deliveryToken });
          } catch (error) {
            const messageText = error instanceof Error ? error.message : String(error);
            ctx?.log(`pi steer failed: ${messageText}`);
            if (isPiRpcBeforeWriteError(error)) {
              // Proven before-write: safe to retry without duplicating a JSONL steer.
              deliveryToken.retry(message, "pi_steer_failed_before_write");
              return;
            }
            // After-write / unknown: fence and consume — never auto-resend the same steer.
            await closeRpcClient();
            await deliveryToken.complete([message], {
              status: "error",
              completion: "consumed",
              reason: "pi_steer_after_write_unknown",
            });
          }
        })();
        pendingSteerWork.add(steerWork);
        void steerWork.finally(() => pendingSteerWork.delete(steerWork));
        return { kind: "owned", mode: "processing" };
      }
      queuedMessages.push({ message, token: deliveryToken });
      scheduleQueuedMessagesDrain();
      return { kind: "owned", mode: "queued" };
    },

    async suspend(reason, opts?: HandlerShutdownOptions) {
      // Manual operator suspend passes settleProviderEntered explicitly.
      // Idle yield / preemption leave it unset (recoverable / ACK-none).
      await endLifecycle(reason ?? "pi_suspend", {
        ...(opts?.settleProviderEntered === true
          ? { settleProviderEntered: true, settleMode: "operator_suspend" as const }
          : {}),
      });
    },

    async shutdown(reason, opts?: HandlerShutdownOptions) {
      await endLifecycle(reason ?? "pi_shutdown", {
        ...(opts?.settleProviderEntered === true
          ? { settleProviderEntered: true, settleMode: "graceful_drain" as const }
          : {}),
      });
    },
  } satisfies AgentHandler;
  piLifecycleAbortWaiterCountForTests.set(handler, () => lifecycleAbortWaiters.size);
  return handler;
};
