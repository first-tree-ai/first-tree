import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import {
  type AgentRuntimeConfig,
  type AgentRuntimeConfigPayload,
  classifyShellCommandIo,
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
  ContextTreeAttribution,
  ContextTreeGitWriteTracker,
  ProviderAttemptSettlement,
  ProviderProcessSupervisor,
} from "../../runtime/provider-support/index.js";
import {
  assertContextSourceCurrent,
  buildBriefingUpdateNotice,
  computeBriefingFingerprint,
  contextSourceFromHandlerConfig,
  createContextTreeGitWriteTracker,
  createDefaultProviderProcessSupervisor,
  isContextSourceTransitionError,
  isManagedSkillsUnsafeDiscoveryError,
  maxProviderTurnRetryAttempts,
  ProviderAttempt,
  preparationCoordinatesFromSource,
  prepareManagedSession,
  projectManagedWorkspace,
  readSessionBriefingFingerprint,
  remoteGitAttributionFromSource,
  renderChatContextPrompt,
  renderRuntimeOutputContract,
  resolveContextTreeRelativePath,
  toolFileRefsFromShellCommand,
  writeSessionBriefingFingerprint,
} from "../../runtime/provider-support/index.js";
import { chunkAssistantText } from "../handlers/assistant-text.js";
import { formatAuthHint, isGrokAuthError } from "../handlers/auth-error-hint.js";
import { resolveTurnSettlement } from "../handlers/turn-settlement.js";
import { PROVIDER_SKILL_ROOTS } from "../skill-roots.js";
import { buildGrokTurnArgs, runGrokAcpAttempt } from "./acp-session.js";
import { formatGrokBinaryMissingMessage, GrokBinaryVerifyTransientError, resolveGrokRuntimeBinary } from "./binary.js";
import {
  type GrokNormalizedEvent,
  type GrokToolInfo,
  type GrokTurnCompleted,
  mergeGrokToolInfo,
  normalizeGrokSessionUpdate,
  normalizeGrokXaiNotification,
} from "./events.js";

export { buildGrokTurnArgs } from "./acp-session.js";

/**
 * Grok Build handler — drives the EXTERNAL Grok Build CLI over ACP (Agent
 * Client Protocol) v1, one short-lived process per provider turn:
 *
 *   inbox delivery → prepareTurn → spawn grok process → initialize →
 *     session/new | session/load → session/prompt (prompt on ACP stdin only)
 *     → session/update + _x.ai/* notification stream → prompt response →
 *     notification drain → stdin EOF → exit 0 → settle DeliveryToken →
 *     next queued batch
 *
 * Canonical spawn contract (mirrors the cursor/opencode safety posture):
 *   grok --no-auto-update agent --no-leader --always-approve
 *        [--model <exact-operator-value>] [--effort <low|medium|high>] stdio
 *
 * Hard constraints enforced here, not by prompt:
 *   - process cwd = agent home; prompt rides ACP stdin only (never argv);
 *   - args go to the supervisor as an array with `shell: false`;
 *   - MCP servers are delivered via session/new|load params (filtered by the
 *     advertised mcpCapabilities) — there is NO file-projection layer;
 *   - `session/load` only ever carries a stream-confirmed provider session
 *     id, and a load failure NEVER falls back to session/new (replay
 *     safety); synthetic pending ids stay runtime-local;
 *   - settlement waits for the prompt response, the notification-handler
 *     drain, and process close (non-zero exit without a completed prompt is
 *     a first-class failure input, classified from the stderr tail);
 *   - Windows fails closed in prepareSession (the capability probe already
 *     hides the provider; this is belt-and-braces).
 */

/** Prefix for runtime-local pending session ids (never sent to session/load). */
export const GROK_PENDING_SESSION_PREFIX = "grok-pending-";

export function isGrokPendingSessionId(sessionId: string): boolean {
  return sessionId.startsWith(GROK_PENDING_SESSION_PREFIX);
}

/**
 * No shared build-version constant is wired into the client package yet, so
 * the ACP clientInfo advertises "0" (the value is informational only).
 */
const GROK_CLIENT_VERSION = "0";

/**
 * ACP v1 stop reasons that are prompt COMPLETIONS: the provider finished the
 * turn and the accumulated output is the turn's result. Only `cancelled`
 * takes the abort/redelivery path; any OTHER unknown value stays a provider
 * error (conservative against future wire additions).
 */
const GROK_COMPLETION_STOP_REASONS: ReadonlySet<string> = new Set([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
]);

type GrokRetrySleep = (delayMs: number, signal: AbortSignal) => Promise<void>;

function defaultGrokRetrySleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** True when a shell command is PROVEN read-only (replay-safe). */
export function grokShellCommandIsReadOnly(command: string | null): boolean {
  if (!command) return false;
  const classification = classifyShellCommandIo(command);
  return classification.supported && classification.action === "read";
}

/**
 * True when a tool invocation is PROVEN read-only. The provider's
 * `_meta["x.ai/tool"].read_only === true` is required; a shell tool
 * (`run_terminal_cmd` / kind "execute", keyed on name/kind) must
 * additionally carry a command that classifies as a supported read — a
 * missing command fails CLOSED (unsafe). Anything else — read_only false,
 * absent, or unknown — is an unproven side effect and ends automatic replay.
 */
export function grokToolIsReadOnly(tool: GrokToolInfo): boolean {
  if (tool.readOnly !== true) return false;
  if (tool.isShell) return grokShellCommandIsReadOnly(tool.command);
  return true;
}

type TurnAcpState = {
  attempt: ProviderAttempt;
  sawInit: boolean;
  userVisibleEmitted: boolean;
  toolEffectStarted: boolean;
  thinkingEmitted: boolean;
  /** Accumulated agent_message_chunk text — the canonical final turn text. */
  assistantText: string;
  turnCompleted: GrokTurnCompleted | null;
  ignoredCount: number;
  /** Last known tool info per ACP `toolCallId` — `tool_call_update` is a patch. */
  tools: Map<string, GrokToolInfo>;
};

export const createGrokHandler: HandlerFactory = (config) => {
  const workspaceRoot = config.workspaceRoot as string;
  const agentName = typeof config.agentName === "string" ? config.agentName : "";
  const runtimeProvider = runtimeProviderSchema.parse(config.runtimeProvider);
  const providerTurnMaxRetries = maxProviderTurnRetryAttempts();
  const agentConfigCache = (config.agentConfigCache as AgentConfigCache | undefined) ?? null;
  const contextSource = contextSourceFromHandlerConfig(config);
  const contextTree = preparationCoordinatesFromSource(contextSource);
  const gitAttribution = remoteGitAttributionFromSource(contextSource);
  const contextTreePath = gitAttribution.contextTreePath;
  const contextTreeRepoUrl = gitAttribution.contextTreeRepoUrl;
  const contextTreeBranch = contextTree.kind === "remote" ? contextTree.branch : null;
  const platform = (config.grokPlatform as NodeJS.Platform | undefined) ?? process.platform;
  const processSupervisor =
    (config.providerProcessSupervisor as ProviderProcessSupervisor | undefined) ??
    createDefaultProviderProcessSupervisor(platform);
  const resolveBinary =
    (config.grokBinaryResolver as typeof resolveGrokRuntimeBinary | undefined) ?? resolveGrokRuntimeBinary;
  const retrySleep = (config.grokRetrySleep as GrokRetrySleep | undefined) ?? defaultGrokRetrySleep;
  const eofCloseWaitMs =
    typeof config.grokEofCloseWaitMs === "number" && config.grokEofCloseWaitMs > 0
      ? config.grokEofCloseWaitMs
      : undefined;
  const setModelEchoWaitMs =
    typeof config.grokSetModelEchoWaitMs === "number" && config.grokSetModelEchoWaitMs > 0
      ? config.grokSetModelEchoWaitMs
      : undefined;
  const replayDrainCapMs =
    typeof config.grokReplayDrainCapMs === "number" && config.grokReplayDrainCapMs > 0
      ? config.grokReplayDrainCapMs
      : undefined;

  let cwd: string | null = null;
  let ctx: SessionContext | null = null;
  let activePayload: AgentRuntimeConfigPayload | null = null;
  let binary: string | null = null;
  /** Provider-confirmed session id — the ONLY value session/load may carry. */
  let providerSessionId: string | null = null;
  /** Runtime-local placeholder returned when the first turn settled before session/new. */
  let pendingSyntheticId: string | null = null;
  /**
   * Session-liveness fence for the run-to-completion transport. True from the
   * end of prepareSession until suspend()/shutdown(). Queued drains and
   * runTurn refuse to spawn while false, so a drain that raced past its gates
   * before suspend cannot start a provider process on a suspended session,
   * and an inject landing during prepareSession's awaits cannot run ahead of
   * the session's own first turn.
   */
  let sessionActive = false;
  let currentAbort: AbortController | null = null;
  let currentTurnPromise: Promise<void> | null = null;
  /**
   * Turn/identity fence: emit, settlement, the child slot, and finally-cleanup
   * all capture the generation they belong to; a stale continuation (late
   * timeout, delayed close) must never touch a newer turn's state.
   */
  let turnGeneration = 0;
  let drainScheduled = false;
  let drainInProgress = false;
  let initialTurnPreparing = false;
  const queuedMessages: Array<{ message: SessionMessage; token: DeliveryToken }> = [];
  /**
   * One-shot provider context. Grok has no system-prompt channel in the ACP
   * session contract we use, so the runtime output contract + escaped Current
   * Chat Context + any briefing re-read notice ride the next messageful
   * provider turn's prompt text, then clear. Queued injects must not consume
   * it before a turn actually enters the provider.
   */
  let pendingChatContextPrompt: string | null = null;
  const gitWriteTracker: ContextTreeGitWriteTracker = createContextTreeGitWriteTracker({
    contextTreePath,
    contextTreeRepoUrl,
    contextTreeBranch,
    log: (message) => ctx?.log(message),
  });

  function emitProviderTurnSettlementEvent(sessionCtx: SessionContext, settlement: ProviderAttemptSettlement): void {
    sessionCtx.emitEvent({
      kind: "error",
      payload: {
        source: "runtime",
        message: encodeProviderRetryEventMessage(settlement.eventPayload),
      },
    });
  }

  function buildEnv(sessionCtx: SessionContext, payload: AgentRuntimeConfigPayload): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    for (const e of payload.env) env[e.key] = e.value;
    // The First Tree envelope injects the runtime-session token FILE PATH and
    // identity ids — never a token value.
    const merged = sessionCtx.buildAgentEnv(env);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(merged)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }

  function formatGrokError(message: string): string {
    if (isGrokAuthError(message)) return formatAuthHint("grok", message);
    return message;
  }

  function consumePendingChatContext(input: string): string {
    const chatPrompt = pendingChatContextPrompt;
    pendingChatContextPrompt = null;
    // Same provider-neutral runtime output contract as the other run-to-
    // completion providers — Grok gets no persistent system-prompt channel,
    // so the contract rides every turn's prompt ahead of any chat-context
    // block. Chat-context field values are labelled data and escaped
    // upstream; they cannot re-address the turn or forge prompt sections.
    const contract = renderRuntimeOutputContract();
    const prefix = chatPrompt ? `${contract}\n\n${chatPrompt}` : contract;
    return `${prefix}\n\n${input}`;
  }

  function grokNativePathRefs(filePath: string, origin: "tool_arg" | "file_change"): ToolFileRef[] {
    if (!cwd) return [];
    const attribution: ContextTreeAttribution = { contextTreePath, contextTreeRepoUrl };
    const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
    const repoRelativePath = resolveContextTreeRelativePath(absolutePath, attribution);
    return [
      {
        origin,
        localPath: filePath,
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

  /** Terminal-tool ref assembly: provider-derived refs + git-status-delta refs. */
  function refsForCompletedTool(input: {
    ok: boolean;
    readOnly: boolean;
    providerRefs: ToolFileRef[];
    toolName: string;
    toolUseId: string;
  }): ToolFileRef[] | undefined {
    // A PROVEN read-only tool cannot have moved the tree's git status — skip
    // the per-tool `git status` spawn entirely (tool-heavy read turns would
    // otherwise stall the event loop once per read). Any accumulated dirty
    // paths stay attributed to the next non-read-only tool.
    if (input.readOnly) {
      return input.providerRefs.length > 0 ? input.providerRefs : undefined;
    }
    if (!input.ok) {
      // A failed tool still moves the baseline so the NEXT successful tool
      // does not swallow this one's dirty paths.
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

  function providerRefsForTool(tool: GrokToolInfo): ToolFileRef[] {
    if (tool.isShell) {
      return tool.command && cwd
        ? toolFileRefsFromShellCommand({
            command: tool.command,
            cwd,
            contextTreePath,
            contextTreeRepoUrl,
            contextTreeBranch,
          })
        : [];
    }
    const origin = tool.readOnly === true ? "tool_arg" : "file_change";
    return tool.paths.flatMap((filePath) => grokNativePathRefs(filePath, origin));
  }

  /**
   * Replay-safety ladder: user-visible assistant output and any non-read-only
   * tool effect both end automatic replay; pure thinking / read-only activity
   * stays retryable; nothing from the provider yet (pre-initialize) is
   * pre_provider.
   */
  function updateReplaySafety(state: TurnAcpState): void {
    if (state.toolEffectStarted) {
      state.attempt.setReplaySafety("unsafe");
    } else if (state.userVisibleEmitted) {
      state.attempt.markUserVisibleOutput();
    } else if (state.sawInit) {
      state.attempt.setReplaySafety("pre_visible");
    } else {
      state.attempt.setReplaySafety("pre_provider");
    }
  }

  function adoptProviderSessionId(sessionCtx: SessionContext, confirmedSessionId: string): void {
    if (providerSessionId === confirmedSessionId) return;
    const hadSynthetic = pendingSyntheticId !== null && providerSessionId === null;
    const syntheticId = pendingSyntheticId;
    providerSessionId = confirmedSessionId;
    if (hadSynthetic && syntheticId) {
      // Atomically upgrade the runtime-local placeholder to the real provider
      // id without dropping inbox custody.
      sessionCtx.replaceSessionId?.(confirmedSessionId, "grok_session_id_confirmed");
      pendingSyntheticId = null;
      // Migrate the briefing-fingerprint baseline to the real id (see cursor).
      if (cwd) {
        try {
          const baseline = readSessionBriefingFingerprint(cwd, syntheticId);
          if (baseline) writeSessionBriefingFingerprint(cwd, confirmedSessionId, baseline);
        } catch (err) {
          sessionCtx.log(
            `briefing fingerprint migration failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  function handleNormalizedEvent(event: GrokNormalizedEvent, state: TurnAcpState, sessionCtx: SessionContext): void {
    sessionCtx.recordProviderActivity();
    switch (event.kind) {
      case "assistant_chunk":
        // There is no separate result message: the concatenation of
        // agent_message_chunk text IS the canonical final text, emitted ONCE
        // as assistant_text at successful turn end (never per chunk).
        state.assistantText += event.text;
        if (event.text.trim()) state.userVisibleEmitted = true;
        break;
      case "thought_chunk":
        // Presence-only marker, at most one per turn (per-chunk emission
        // would flood the event stream).
        if (!state.thinkingEmitted) {
          state.thinkingEmitted = true;
          sessionCtx.emitEvent({ kind: "thinking", payload: {} });
        }
        break;
      case "user_echo":
        break;
      case "tool_started": {
        const tool = mergeGrokToolInfo(state.tools.get(event.tool.toolCallId), event.tool);
        state.tools.set(tool.toolCallId, tool);
        if (!grokToolIsReadOnly(tool)) state.toolEffectStarted = true;
        sessionCtx.emitEvent({
          kind: "tool_call",
          payload: {
            toolUseId: tool.toolCallId,
            name: tool.name,
            args: tool.argsSummary,
            status: "pending",
          },
        });
        break;
      }
      case "tool_completed": {
        const tool = mergeGrokToolInfo(state.tools.get(event.tool.toolCallId), event.tool);
        state.tools.set(tool.toolCallId, tool);
        const ok = event.ok;
        const readOnly = grokToolIsReadOnly(tool);
        if (!readOnly) state.toolEffectStarted = true;
        const providerRefs = ok ? providerRefsForTool(tool) : [];
        const toolFileRefs = refsForCompletedTool({
          ok,
          readOnly,
          providerRefs,
          toolName: tool.name,
          toolUseId: tool.toolCallId,
        });
        sessionCtx.emitEvent({
          kind: "tool_call",
          payload: {
            toolUseId: tool.toolCallId,
            name: tool.name,
            args: tool.argsSummary,
            status: ok ? "ok" : "error",
            ...(event.resultPreview ? { resultPreview: event.resultPreview } : {}),
            ...(toolFileRefs ? { toolFileRefs } : {}),
          },
        });
        break;
      }
      case "plan":
        // The SessionEvent schema has no plan kind — log-only.
        sessionCtx.log("grok ACP: plan update received (no plan event kind; not emitted)");
        break;
      case "turn_completed":
        // THE per-prompt usage source. Kept for turn-end emission; the
        // prompt-id correlation check runs once the prompt response meta is
        // known. `response_completed` (per-model-call) never reaches here —
        // events.ts degrades it to ignored so usage is never double-counted.
        state.turnCompleted = event.completed;
        break;
      case "ignored":
        if (state.ignoredCount < 5) {
          sessionCtx.log(`grok ACP tolerant-parse diagnostic: ${event.note}`);
        }
        state.ignoredCount++;
        break;
    }
  }

  /**
   * Run one provider turn (possibly several attempts). Returns whether the
   * turn was delivered (settled complete) — the briefing-fingerprint baseline
   * and queued-drain scheduling key off this.
   */
  async function runTurn(
    input: string,
    sessionCtx: SessionContext,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
  ): Promise<boolean> {
    const workspaceCwd = cwd;
    const fallbackPayload = activePayload;
    if (!workspaceCwd || !binary || !fallbackPayload || !sessionActive) {
      // `sessionActive` closes the drain-vs-lifecycle race (see cursor).
      token.retry(messages, sessionActive ? "grok_missing_workspace_or_binary" : "grok_session_inactive");
      return false;
    }

    const activeBinary = binary;
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
    if (cwd !== workspaceCwd || binary !== activeBinary || !sessionActive) {
      token.retry(messages, "grok_session_inactive");
      return false;
    }
    // One immutable per-turn snapshot drives model, effort, MCP delivery, and
    // env. SessionRuntime refreshes the cache before dispatch, so an active
    // chat converges on its very next turn.
    const turnPayload = agentConfigCache?.get(sessionCtx.agent.agentId)?.payload ?? fallbackPayload;
    const model = turnPayload.model;
    const reasoningEffort = turnPayload.kind === "grok" ? turnPayload.reasoningEffort : "";
    const env = buildEnv(sessionCtx, turnPayload);
    const generation = ++turnGeneration;
    const abort = new AbortController();
    currentAbort = abort;
    const turnPromise = runTurnAttempts(
      input,
      sessionCtx,
      messages,
      token,
      workspaceCwd,
      activeBinary,
      turnPayload,
      model,
      reasoningEffort,
      env,
      generation,
      abort,
    ).catch((err: unknown) => {
      if (abort.signal.aborted || turnGeneration !== generation) return false;
      throw err;
    });
    currentTurnPromise = turnPromise.then(
      () => {},
      () => {},
    );
    try {
      return await turnPromise;
    } finally {
      if (turnGeneration === generation) {
        currentAbort = null;
        currentTurnPromise = null;
        scheduleQueuedMessagesDrain();
      }
    }
  }

  async function runTurnAttempts(
    input: string,
    sessionCtx: SessionContext,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
    workspaceCwd: string,
    activeBinary: string,
    turnPayload: AgentRuntimeConfigPayload,
    model: string,
    reasoningEffort: string,
    env: Record<string, string>,
    generation: number,
    abort: AbortController,
  ): Promise<boolean> {
    if (
      abort.signal.aborted ||
      turnGeneration !== generation ||
      cwd !== workspaceCwd ||
      binary !== activeBinary ||
      !sessionActive
    ) {
      return false;
    }

    // One-shot payload snapshot: a non-delivered exit (abort, retry-path
    // settlement) must put the chat-context/notice back so the redelivery
    // still carries it.
    const promptSnapshot = pendingChatContextPrompt;
    const providerInput = consumePendingChatContext(input);
    const restorePendingChatContext = (): void => {
      if (pendingChatContextPrompt === null) pendingChatContextPrompt = promptSnapshot;
    };

    token.processingStarted(messages);
    gitWriteTracker.captureBaseline();

    const turnStartedAt = Date.now();

    let finalText = "";
    // Box so TS control-flow analysis survives the assignment living inside
    // the async IIFE below (microsoft/TypeScript#9998).
    const usageBox: { value: GrokTurnCompleted | null } = { value: null };
    let usedModel = model;
    let consumedErrorReason: TurnConsumedErrorReason | null = null;
    let retryReason: string | null = null;
    let retryStatus: "success" | "error" = "error";
    let providerCompleted = false;
    let anyUserVisible = false;
    /**
     * Carried across attempts exactly like anyUserVisible: a side effect from
     * an earlier attempt must keep EVERY later attempt's replay-safety at
     * unsafe — resetting it per attempt could auto-replay after a write.
     */
    let anyToolEffect = false;

    const promise = (async () => {
      for (let attempt = 0; ; attempt++) {
        const state: TurnAcpState = {
          attempt: new ProviderAttempt({ provider: runtimeProvider, scope: "provider_turn", source: "stream" }),
          sawInit: false,
          userVisibleEmitted: anyUserVisible,
          toolEffectStarted: anyToolEffect,
          thinkingEmitted: false,
          assistantText: "",
          turnCompleted: null,
          ignoredCount: 0,
          tools: new Map(),
        };
        consumedErrorReason = null;
        retryReason = null;
        retryStatus = "error";
        let retryRequested = false;
        let retryDelay = 0;

        const args = buildGrokTurnArgs({ model, reasoningEffort });

        const outcome = await runGrokAcpAttempt({
          supervisor: processSupervisor,
          binary: activeBinary,
          args,
          env,
          cwd: workspaceCwd,
          abortSignal: abort.signal,
          label: `grok turn ${sessionCtx.chatId}`,
          clientVersion: GROK_CLIENT_VERSION,
          // Only a provider-confirmed id ever reaches session/load; the first
          // turn (and any turn after a synthetic placeholder) runs session/new.
          resumeSessionId: providerSessionId,
          mcpServers: turnPayload.mcpServers,
          model,
          reasoningEffort,
          promptText: providerInput,
          ...(eofCloseWaitMs ? { eofCloseWaitMs } : {}),
          ...(setModelEchoWaitMs ? { setModelEchoWaitMs } : {}),
          ...(replayDrainCapMs ? { replayDrainCapMs } : {}),
          onInitialized: () => {
            if (turnGeneration === generation && !abort.signal.aborted) state.sawInit = true;
          },
          onSessionId: (sessionId) => {
            if (turnGeneration === generation && !abort.signal.aborted) {
              adoptProviderSessionId(sessionCtx, sessionId);
            }
          },
          onSessionUpdate: (params) => {
            const normalized = normalizeGrokSessionUpdate(params);
            if (normalized) handleNormalizedEvent(normalized.event, state, sessionCtx);
          },
          onXaiNotification: (params) => {
            const normalized = normalizeGrokXaiNotification(params);
            if (normalized) handleNormalizedEvent(normalized.event, state, sessionCtx);
          },
          log: (message) => sessionCtx.log(message),
        });
        if (abort.signal.aborted || turnGeneration !== generation) return;

        anyUserVisible = anyUserVisible || state.userVisibleEmitted;
        anyToolEffect = anyToolEffect || state.toolEffectStarted;
        // Billed tokens are billed regardless of how the turn settles — keep
        // the latest usage the provider reported so failed/consumed turns
        // still emit token_usage.
        if (state.turnCompleted?.usage) usageBox.value = state.turnCompleted;

        const applySettlement = (settlement: ProviderAttemptSettlement, reasonPrefix: string): void => {
          if (settlement.decision.action === "retry") {
            retryRequested = true;
            retryDelay = settlement.decision.delayMs;
            retryReason = `${reasonPrefix} (${settlement.classification.category}): ${settlement.messagePreview}`;
            emitProviderTurnSettlementEvent(sessionCtx, settlement);
            return;
          }
          emitProviderTurnSettlementEvent(sessionCtx, settlement);
          if (settlement.decision.replaySafety === "pre_provider" && settlement.decision.terminalKind === "exhausted") {
            retryReason = settlement.decision.reasonCode;
          } else {
            consumedErrorReason =
              settlement.decision.terminalKind === "capacity_wait_required"
                ? "capacity_wait_required"
                : settlement.decision.terminalKind === "exhausted"
                  ? "provider_retry_exhausted"
                  : settlement.decision.reasonCode;
          }
          sessionCtx.emitEvent({
            kind: "error",
            payload: { source: "sdk", message: formatGrokError(settlement.messagePreview) },
          });
        };

        const prompt = outcome.prompt;
        const isCompletionStop = prompt !== null && GROK_COMPLETION_STOP_REASONS.has(prompt.stopReason);
        if (prompt && isCompletionStop && !outcome.spawnError && !outcome.failure && outcome.cleanExit) {
          // Every ACP v1 completion stop reason (end_turn / max_tokens /
          // max_turn_requests / refusal) settles the turn with the
          // accumulated output — the full drain MUST have exited 0.
          if (prompt.stopReason !== "end_turn") {
            sessionCtx.log(
              `grok turn completed with stopReason "${prompt.stopReason}"; settling the accumulated output`,
            );
          }
          // Prompt-id correlation: discard replayed usage that belongs to a
          // different prompt than the one this response settles.
          const responsePromptId = typeof prompt.meta?.promptId === "string" ? prompt.meta.promptId : null;
          const captured = usageBox.value;
          if (responsePromptId && captured?.promptId && captured.promptId !== responsePromptId) {
            sessionCtx.log(
              `grok ACP: discarded turn_completed usage for foreign prompt_id ${captured.promptId} ` +
                `(current prompt ${responsePromptId})`,
            );
            usageBox.value = null;
          }
          const metaModelId = typeof prompt.meta?.modelId === "string" ? prompt.meta.modelId : "";
          if (metaModelId) usedModel = metaModelId;
          finalText = state.assistantText;
          providerCompleted = true;
          return;
        }
        // Failure path. Auth / capacity / protocol failures commonly produce
        // NO prompt response — classify from the failure phase error, the
        // stopReason (including a provider-side `cancelled`, which is an
        // abnormal end, NOT an unconditional redelivery), or the stderr
        // tail + exit status (mirror cursor's failureText assembly). A
        // COMPLETED prompt whose process did not exit 0 is a failure input
        // too: the "full drain exits 0" boundary never silently ACKs a dirty
        // exit as success.
        updateReplaySafety(state);
        const stderrText = outcome.stderrTail.trim();
        const phaseErrorText = outcome.failure ? outcome.failure.error.message.trim() : "";
        const dirtyExitText =
          prompt && isCompletionStop
            ? `grok process exited ${outcome.exitCode ?? `signal ${outcome.signal ?? "unknown"}`} ` +
              "after a completed prompt (exit 0 required)"
            : "";
        const stopReasonText =
          prompt && !isCompletionStop ? `grok turn stopped with stopReason "${prompt.stopReason}"` : "";
        const failureText =
          outcome.spawnError?.message ??
          (phaseErrorText
            ? stderrText
              ? `${phaseErrorText}\nstderr: ${stderrText}`
              : phaseErrorText
            : dirtyExitText
              ? stderrText
                ? `${dirtyExitText}\nstderr: ${stderrText}`
                : dirtyExitText
              : stopReasonText
                ? stderrText
                  ? `${stopReasonText}\nstderr: ${stderrText}`
                  : stopReasonText
                : stderrText ||
                  `grok exited ${outcome.exitCode ?? `signal ${outcome.signal ?? "unknown"}`} without completing the prompt`);
        const failureError =
          outcome.spawnError && (outcome.spawnError as NodeJS.ErrnoException).code === "ENOENT"
            ? new Error(formatGrokBinaryMissingMessage(`the bound grok binary disappeared: ${activeBinary}`))
            : new Error(failureText);
        state.attempt.recordSignal({
          kind: outcome.spawnError ? "local_error" : "provider_error",
          error: failureError,
        });
        const settlement = state.attempt.settle({ attempt: attempt + 1 });
        if (settlement) applySettlement(settlement, outcome.spawnError ? "spawn failed" : "provider failed");

        if (!retryRequested) return;
        sessionCtx.log(
          `grok turn retry ${attempt + 1}/${providerTurnMaxRetries + 1} after ${retryDelay}ms; ${retryReason}`,
        );
        try {
          await retrySleep(retryDelay, abort.signal);
        } catch {
          return; // suspend/shutdown raced ahead
        }
        try {
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
        } catch (sourceError) {
          if (!isContextSourceTransitionError(sourceError)) throw sourceError;
          token.retry(messages, "grok_context_source_changed");
          sessionCtx.failSessionForRecovery?.("grok_context_source_changed", providerSessionId ?? undefined);
          return;
        }
      }
    })();

    await promise;

    if (abort.signal.aborted || turnGeneration !== generation) {
      // Suspend/shutdown/preemption raced ahead — not a delivered turn; the
      // chat-context/notice payload must survive for the redelivery.
      restorePendingChatContext();
      return false;
    }

    let forwardFailed = false;
    if (providerCompleted && consumedErrorReason === null && retryReason === null) {
      // The canonical final text lands as chunked assistant_text FIRST, then
      // the completion hook runs (fires on every success — including silent /
      // tool-only turns with empty text).
      if (finalText.trim()) {
        for (const chunk of chunkAssistantText(finalText)) {
          sessionCtx.emitEvent({ kind: "assistant_text", payload: { text: chunk } });
        }
      }
      try {
        await sessionCtx.forwardResult(finalText);
      } catch (err) {
        forwardFailed = true;
        const msg = err instanceof Error ? err.message : String(err);
        sessionCtx.emitEvent({
          kind: "error",
          payload: { source: "runtime", message: `forwardResult failed: ${msg}` },
        });
      }
    }

    const capturedUsage = usageBox.value;
    if (capturedUsage?.usage) {
      try {
        sessionCtx.emitEvent({
          kind: "token_usage",
          payload: {
            provider: "grok",
            model: usedModel || "grok-default",
            inputTokens: capturedUsage.usage.inputTokens,
            cachedInputTokens: capturedUsage.usage.cachedReadTokens,
            outputTokens: capturedUsage.usage.outputTokens,
          },
        });
      } catch (err) {
        sessionCtx.log(`Failed to emit token_usage: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const settlement = resolveTurnSettlement({ retryReason, retryStatus, consumedErrorReason, forwardFailed });
    if (settlement.action.kind === "complete") {
      sessionCtx.emitEvent({ kind: "turn_end", payload: { status: settlement.status } });
      const completion = await token.complete(messages, settlement.action.outcome);
      if (completion === "retry") {
        // Completion deliberately retained server custody (a durable notice
        // could not be posted): the one-shot payload must ride the redelivery.
        restorePendingChatContext();
        return false;
      }
    } else {
      sessionCtx.emitEvent({ kind: "turn_end", payload: { status: settlement.status } });
      // Retry-path settlement: the delivery goes back for redelivery, so the
      // one-shot chat-context/notice must be available to it again.
      restorePendingChatContext();
      token.retry(messages, settlement.action.reason);
    }

    if (capturedUsage?.usage) {
      sessionCtx.log(
        `grok usage chatId=${sessionCtx.chatId} duration_ms=${Date.now() - turnStartedAt} ` +
          `input_tokens=${capturedUsage.usage.inputTokens} cache_read_tokens=${capturedUsage.usage.cachedReadTokens} ` +
          `output_tokens=${capturedUsage.usage.outputTokens} ` +
          (capturedUsage.costUsdTicks !== null ? `cost_usd_ticks=${capturedUsage.costUsdTicks} ` : "") +
          `status=${settlement.status}`,
      );
    }

    return settlement.action.kind === "complete";
  }

  function scheduleQueuedMessagesDrain(): void {
    if (drainScheduled || drainInProgress) return;
    if (queuedMessages.length === 0 || !ctx || !cwd || !sessionActive || currentTurnPromise || initialTurnPreparing) {
      return;
    }

    drainScheduled = true;
    setImmediate(() => {
      drainScheduled = false;
      if (
        drainInProgress ||
        queuedMessages.length === 0 ||
        !ctx ||
        !cwd ||
        !sessionActive ||
        currentTurnPromise ||
        initialTurnPreparing
      ) {
        scheduleQueuedMessagesDrain();
        return;
      }
      const drained = queuedMessages.splice(0);
      const sessionCtx = ctx;
      drainInProgress = true;
      void mergeAndRun(drained, sessionCtx)
        .catch((err) => {
          sessionCtx.log(`grok queued turn failed: ${err instanceof Error ? err.message : String(err)}`);
          for (const queued of drained) queued.token.retry(queued.message, "grok_queued_turn_failed");
        })
        .finally(() => {
          drainInProgress = false;
          scheduleQueuedMessagesDrain();
        });
    });
  }

  /**
   * Active-session briefing hot-switch before an injected turn (same contract
   * as the cursor handler): rebuild from the latest cached config; when
   * changed, rewrite AGENTS.md and report so the caller prepends the one-time
   * re-read notice. Source transitions and unsafe managed projections remain
   * fail-closed so the drain owner can return custody to SessionManager.
   */
  async function refreshBriefingForActiveTurn(
    sessionCtx: SessionContext,
  ): Promise<{ fingerprint: string; changed: boolean } | null> {
    const sessionKey = providerSessionId ?? pendingSyntheticId;
    if (!agentConfigCache || !cwd || !sessionKey) return null;
    try {
      const runtimeConfig = agentConfigCache.get(sessionCtx.agent.agentId);
      if (!runtimeConfig) return null;
      const payload = runtimeConfig.payload;
      const projected = await projectManagedWorkspace({
        sessionCtx,
        workspace: cwd,
        agentName,
        runtimeProvider,
        providerSkillRoots: PROVIDER_SKILL_ROOTS,
        runtimeConfig,
        payload,
        existingPayload: activePayload ?? undefined,
        payloadResolved: true,
        contextTree: {
          kind: contextTree.kind,
          path: contextTree.path,
          repoUrl: contextTree.repoUrl,
          branch: contextTree.branch,
        },
        reresolveSource: true,
        markInitComplete: false,
      });
      activePayload = payload;
      const briefing = projected.briefing;
      const fingerprint = computeBriefingFingerprint(briefing);
      if (readSessionBriefingFingerprint(cwd, sessionKey) === fingerprint) return { fingerprint, changed: false };
      return { fingerprint, changed: true };
    } catch (err) {
      if (isContextSourceTransitionError(err)) throw err;
      if (isManagedSkillsUnsafeDiscoveryError(err)) throw err;
      sessionCtx.log(
        `active-session briefing refresh failed, delivering under prior briefing: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async function mergeAndRun(
    drained: Array<{ message: SessionMessage; token: DeliveryToken }>,
    sessionCtx: SessionContext,
  ): Promise<void> {
    const inputs: string[] = [];
    const messages = drained.map((entry) => entry.message);
    const token = drained[0]?.token;
    if (!token) return;
    let hadFormatFailure = false;
    for (const m of messages) {
      try {
        inputs.push(await sessionCtx.formatInboundContent(m));
      } catch (err) {
        hadFormatFailure = true;
        sessionCtx.log(`grok inject formatInboundContent failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (hadFormatFailure || inputs.length === 0) {
      for (const queued of drained) queued.token.retry(queued.message, "grok_queued_turn_format_failed");
      return;
    }
    try {
      const refreshed = await refreshBriefingForActiveTurn(sessionCtx);
      if (refreshed?.changed && cwd) {
        const notice = buildBriefingUpdateNotice(join(cwd, "AGENTS.md"));
        pendingChatContextPrompt = pendingChatContextPrompt ? `${notice}\n\n${pendingChatContextPrompt}` : notice;
        sessionCtx.log(`Active session briefing changed — prepending re-read notice (${providerSessionId})`);
      }
      const delivered = await runTurn(inputs.join("\n\n"), sessionCtx, messages, token);
      const sessionKey = providerSessionId ?? pendingSyntheticId;
      if (refreshed?.changed && delivered && cwd && sessionKey) {
        writeSessionBriefingFingerprint(cwd, sessionKey, refreshed.fingerprint);
      }
    } catch (err) {
      if (!isContextSourceTransitionError(err)) throw err;
      for (const queued of drained) queued.token.retry(queued.message, "grok_context_source_changed");
      sessionCtx.failSessionForRecovery?.("grok_context_source_changed", providerSessionId ?? undefined);
    }
  }

  function retryQueuedMessages(reason: string): void {
    const drained = queuedMessages.splice(0);
    for (const queued of drained) {
      queued.token.retry(queued.message, reason);
    }
  }

  /**
   * Session bring-up shared by start/resume: platform + trial gates, payload
   * refresh, chat context, skills, briefing, workspace bootstrap, binary
   * resolution (transient smoke-check flakes reschedule; a genuinely absent
   * binary is a permanent capability failure).
   */
  async function prepareSession(sessionCtx: SessionContext): Promise<{
    payload: AgentRuntimeConfigPayload;
    briefing: string;
    workspaceCwd: string;
  }> {
    // Platform gate: the Grok ACP transport is supervised POSIX-only (the
    // capability probe already hides the provider on win32; this refuses the
    // spawn deterministically if a stale config ever routes here).
    if (platform === "win32") {
      throw new Error(
        "the grok provider is not supported on Windows in V1 (macOS/Linux only); " +
          "the Grok Build ACP runtime is supervised macOS/Linux-only",
      );
    }
    // Landing campaign trials require the codex app-server workspace-only
    // runtime (managed sandbox + confirmed turn-completion records). The grok
    // handler implements neither — fail closed instead of running a trial
    // without its guarantees.
    if (isLandingCampaignTrialAgentMetadata(sessionCtx.agent.metadata)) {
      throw new Error(
        "landing campaign trial agents require the codex app-server workspace-only runtime; the grok provider does not support trials",
      );
    }
    ctx = sessionCtx;

    let runtimeConfig: AgentRuntimeConfig | null = null;
    let payload: AgentRuntimeConfigPayload | null = null;
    if (agentConfigCache) {
      runtimeConfig = await agentConfigCache.refresh(sessionCtx.agent.agentId);
      payload = runtimeConfig.payload;
    }
    const payloadResolved = payload !== null;
    if (!payload) {
      payload = {
        kind: "grok",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
        reasoningEffort: "",
      };
    }

    const prepared = await prepareManagedSession({
      sessionCtx,
      workspaceRoot,
      agentName,
      runtimeProvider,
      providerSkillRoots: PROVIDER_SKILL_ROOTS,
      runtimeConfig,
      payload,
      payloadResolved,
      contextTree: {
        kind: contextTree.kind,
        path: contextTree.path,
        repoUrl: contextTree.repoUrl,
        branch: contextTree.branch,
      },
    });
    const workspaceCwd = prepared.workspace;
    cwd = workspaceCwd;
    pendingChatContextPrompt = renderChatContextPrompt(prepared.chatContext);
    const briefing = prepared.briefing;

    const resolution = resolveBinary(process.env);
    if (!resolution.ok) {
      if (resolution.transient) throw new GrokBinaryVerifyTransientError(resolution.error);
      throw new Error(resolution.error);
    }
    binary = resolution.binary;
    sessionCtx.log(`grok binary: ${resolution.binary}${resolution.version ? ` (version ${resolution.version})` : ""}`);

    activePayload = payload;
    sessionActive = true;
    return { payload, briefing, workspaceCwd };
  }

  return {
    async start(message, sessionCtx, token) {
      const deliveryToken = token;

      // Guard the whole bring-up: an inject landing while prepareSession is
      // awaiting must queue, not race ahead of the session's first turn.
      initialTurnPreparing = true;
      let initialTurnCompleted = false;
      let briefing: string;
      let workspaceCwd: string;
      try {
        ({ briefing, workspaceCwd } = await prepareSession(sessionCtx));
        const input = await sessionCtx.formatInboundContent(message);
        await runTurn(input, sessionCtx, [message], deliveryToken);
        initialTurnCompleted = true;
      } finally {
        initialTurnPreparing = false;
        if (initialTurnCompleted) scheduleQueuedMessagesDrain();
      }

      if (!providerSessionId) {
        // First turn settled (e.g. auth/quota terminal consumed) before
        // session/new ever confirmed a provider id. Return a runtime-local
        // placeholder so SessionRuntime does not re-process the already
        // settled delivery; the next confirmed id upgrades it atomically via
        // replaceSessionId.
        pendingSyntheticId = `${GROK_PENDING_SESSION_PREFIX}${randomUUID()}`;
      }
      const sessionId = providerSessionId ?? pendingSyntheticId;
      if (!sessionId) throw new Error("grok session id unresolved after first turn");
      writeSessionBriefingFingerprint(workspaceCwd, sessionId, computeBriefingFingerprint(briefing));
      return { sessionId, route: { kind: "owned", mode: "processing" } };
    },

    async resume(message, sessionId, sessionCtx, token) {
      const deliveryToken = message ? requireDeliveryToken(token, "messageful resume") : noopDeliveryToken();

      // Guard the whole bring-up (see start()).
      initialTurnPreparing = true;
      let briefing: string;
      let workspaceCwd: string;
      try {
        ({ briefing, workspaceCwd } = await prepareSession(sessionCtx));
      } catch (err) {
        initialTurnPreparing = false;
        throw err;
      }

      // A synthetic pending id is runtime-local bookkeeping: it must NEVER be
      // sent to session/load. The turn below runs start-shaped (session/new);
      // the confirmed id it captures upgrades the mapping via replaceSessionId.
      if (isGrokPendingSessionId(sessionId)) {
        pendingSyntheticId = sessionId;
        providerSessionId = null;
      } else {
        providerSessionId = sessionId;
        pendingSyntheticId = null;
      }

      // Briefing-staleness notice — same contract as cursor: a resumed Grok
      // session read AGENTS.md at its original init and does not reliably
      // re-read it, so a changed briefing gets a one-time re-read notice on
      // the next messageful turn; the baseline advances only after that turn
      // is actually delivered.
      const briefingFingerprint = computeBriefingFingerprint(briefing);
      const briefingChanged =
        Boolean(message) && readSessionBriefingFingerprint(workspaceCwd, sessionId) !== briefingFingerprint;
      if (briefingChanged) {
        const notice = buildBriefingUpdateNotice(join(workspaceCwd, "AGENTS.md"));
        pendingChatContextPrompt = pendingChatContextPrompt ? `${notice}\n\n${pendingChatContextPrompt}` : notice;
        sessionCtx.log(`Resume: briefing changed since last turn — prepending re-read notice (${sessionId})`);
      }

      if (message) {
        let initialTurnCompleted = false;
        let turnDelivered = false;
        try {
          const input = await sessionCtx.formatInboundContent(message);
          turnDelivered = await runTurn(input, sessionCtx, [message], deliveryToken);
          initialTurnCompleted = true;
        } finally {
          initialTurnPreparing = false;
          if (initialTurnCompleted) scheduleQueuedMessagesDrain();
        }
        const sessionKey = providerSessionId ?? pendingSyntheticId ?? sessionId;
        if (turnDelivered) writeSessionBriefingFingerprint(workspaceCwd, sessionKey, briefingFingerprint);
      } else {
        // Admin-triggered resume carries no message (handler contract). The
        // bring-up guard must still clear, or every later inject would queue
        // forever behind a drain gate that never reopens.
        initialTurnPreparing = false;
        scheduleQueuedMessagesDrain();
      }

      const effectiveId = providerSessionId ?? pendingSyntheticId ?? sessionId;
      return { sessionId: effectiveId, route: message ? { kind: "owned", mode: "processing" } : null };
    },

    inject(message, token) {
      // Grok turns are run-to-completion; there is no mid-turn interject in
      // v1. Every inject queues and drains as an ordered fused batch after
      // the active turn settles.
      if (!ctx) return { kind: "rejected", reason: "no_active_context", retryable: true };
      const deliveryToken = token;
      queuedMessages.push({ message, token: deliveryToken });
      scheduleQueuedMessagesDrain();
      return { kind: "owned", mode: "queued" };
    },

    async suspend() {
      // Flip the liveness fence FIRST: a drain already past its gates (or a
      // mergeAndRun awaiting formatInboundContent) re-checks sessionActive at
      // runTurn entry and retries its batch instead of spawning post-suspend.
      sessionActive = false;
      retryQueuedMessages("grok_suspend_before_terminal");
      turnGeneration++;
      currentAbort?.abort();
      try {
        await currentTurnPromise;
      } catch {
        /* abort path */
      }
      currentAbort = null;
      currentTurnPromise = null;
      activePayload = null;
      initialTurnPreparing = false;
      pendingChatContextPrompt = null;
    },

    async shutdown(reason?: string) {
      sessionActive = false;
      retryQueuedMessages(reason ?? "grok_shutdown_before_terminal");
      turnGeneration++;
      currentAbort?.abort();
      try {
        await currentTurnPromise;
      } catch {
        /* ignore */
      }
      currentAbort = null;
      currentTurnPromise = null;
      activePayload = null;
      // cwd is the persistent agent home — never removed by the runtime.
      cwd = null;
      binary = null;
      providerSessionId = null;
      pendingSyntheticId = null;
      ctx = null;
      initialTurnPreparing = false;
      pendingChatContextPrompt = null;
      queuedMessages.length = 0;
    },
  } satisfies AgentHandler;
};
