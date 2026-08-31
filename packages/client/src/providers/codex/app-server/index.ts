import { isAbsolute, join, resolve } from "node:path";
import {
  type AgentRuntimeConfig,
  type AgentRuntimeConfigPayload,
  encodeProviderRetryEventMessage,
  isLandingCampaignTrialAgentMetadata,
  runtimeProviderSchema,
  type SessionEvent,
  type ToolFileRef,
} from "@first-tree/shared";
import type {
  AgentHandler,
  DeliveryToken,
  HandlerConfig,
  HandlerFactory,
  SessionContext,
  SessionMessage,
  TurnConsumedErrorReason,
} from "../../../runtime/contracts.js";
import { noopDeliveryToken, requireDeliveryToken } from "../../../runtime/contracts.js";
import type {
  AgentConfigCache,
  ContextTreeAttribution,
  ContextTreeGitWriteTracker,
  ProviderAttemptSettlement,
} from "../../../runtime/provider-support/index.js";
import {
  assertContextSourceCurrent,
  buildBriefingUpdateNotice,
  computeBriefingFingerprint,
  contextSourceFromHandlerConfig,
  createContextTreeGitWriteTracker,
  isContextSourceTransitionError,
  isManagedSkillsUnsafeDiscoveryError,
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
} from "../../../runtime/provider-support/index.js";
import { chunkAssistantText } from "../../handlers/assistant-text.js";
import { formatAuthHint, isCodexAuthError } from "../../handlers/auth-error-hint.js";
import { consumedErrorOutcome, resolveTurnSettlement } from "../../handlers/turn-settlement.js";
import { PROVIDER_SKILL_ROOTS } from "../../skill-roots.js";
import { type CodexBinaryResolution, resolveCodexRuntimeBinary } from "../capability.js";
import {
  buildCodexConfig,
  buildCodexThreadOptions,
  type CodexConfigObject,
  codexServiceTiersEquivalent,
  collectCodexFileChangePaths,
  configuredCodexServiceTier,
  isCodexStreamDiagnosticMessage,
  isTransientCodexErrorMessage,
  isUnsupportedCodexServiceTierWarning,
} from "../sdk.js";
import {
  extractCodexStaleRolloutThreadId,
  isCodexStaleRolloutError,
  staleRolloutRecoveryMessage,
} from "../stale-rollout.js";
import {
  LANDING_TRIAL_TURN_COMPLETION_CONFIRM_FAILED,
  LandingTrialTurnCompletionConfirmError,
  turnCompletionIdForMessages,
} from "../turn-completion.js";
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
  type CodexAppServerNotification,
  CodexAppServerRpcError,
  type CodexAppServerTransportError,
  isCodexAppServerTransientError,
} from "./client.js";
import {
  buildLandingCodexAppServerArgs,
  buildLandingCodexPermissionProfile,
  buildWorkspaceOnlyAppServerEnvironment,
  LANDING_CODEX_PERMISSIONS_PROFILE,
  prepareWorkspaceOnlyOutboxHome,
} from "./workspace-sandbox.js";

type JsonRecord = Record<string, unknown>;

type AppServerClientLike = {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  shutdown(): void | Promise<void>;
  readonly stderr: string;
  readonly isClosed: boolean;
};

type AppServerClientFactory = (options: CodexAppServerClientOptions) => Promise<AppServerClientLike>;

type RuntimeBinaryResolver = (env?: NodeJS.ProcessEnv) => Promise<CodexBinaryResolution>;

type QueueEntry = {
  message: SessionMessage;
  token: DeliveryToken;
};

type TokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

type ThreadTokenUsageSnapshot = {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
};

async function emitTurnEnd(
  sessionCtx: SessionContext,
  event: Extract<SessionEvent, { kind: "turn_end" }>,
): Promise<void> {
  if (event.payload.status === "success" && isLandingCampaignTrialAgentMetadata(sessionCtx.agent.metadata)) {
    if (!sessionCtx.emitEventConfirmed) {
      throw new LandingTrialTurnCompletionConfirmError("confirmed session event channel unavailable");
    }
    try {
      await sessionCtx.emitEventConfirmed(event);
    } catch (err) {
      throw new LandingTrialTurnCompletionConfirmError(err);
    }
    return;
  }
  sessionCtx.emitEvent(event);
}

type TurnErrorInfo = {
  message: string;
  codexErrorInfo: unknown;
  additionalDetails: string | null;
};

type CurrentTurn = {
  turnId: string;
  providerAttemptNumber: number;
  providerRetryChain: boolean;
  status: "inProgress" | "completed" | "failed" | "interrupted";
  primaryToken: DeliveryToken;
  acceptedMessages: SessionMessage[];
  /**
   * Pending-input generation that Codex definitively refused to steer.
   * Matching generations wait for the next turn; a newer input changes the
   * generation and gives the still-ordered pending prefix one fresh attempt.
   */
  appendRejectedInputGeneration: number | null;
  inFlightAppend: Promise<void> | null;
  finalAgentText: string;
  completedItemIds: Set<string>;
  usageBaselineTotal: TokenUsageBreakdown | null;
  usageLatestTotal: TokenUsageBreakdown | null;
  usageLastSum: TokenUsageBreakdown | null;
  failure: TurnErrorInfo | null;
  lastSdkError: TurnErrorInfo | null;
  providerCompleted: boolean;
  stopRequested: boolean;
  sdkErrorEmitted: boolean;
  providerAttempt: ProviderAttempt;
  userVisibleOutput: boolean;
  resolveTerminal: () => void;
};

export class CodexAppServerStartupError extends Error {
  readonly stage: string;

  constructor(stage: string, cause: unknown) {
    super(`codex app-server startup failed at ${stage}: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = "CodexAppServerStartupError";
    this.stage = stage;
  }
}

const RESULT_PREVIEW_LIMIT = 400;
const USAGE_LIMIT_NOTICE =
  "⚠️ My runtime has reached its usage limit, so I couldn't process the message you just sent. " +
  "Please resend it once the limit resets.";
const CODEX_CONTEXT_WINDOW_FAILURE_MESSAGE =
  "Codex ran out of room in the model context while compacting this thread. " +
  "Start a new thread or clear earlier history before retrying.";
const CODEX_COMPACT_FAILURE_MESSAGE =
  "Codex failed to compact this thread before answering. Start a new thread or clear earlier history before retrying.";
export const createCodexAppServerHandler: HandlerFactory = (config: HandlerConfig): AgentHandler => {
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
  const clientFactory = readClientFactory(config.codexAppServerClientFactory) ?? defaultClientFactory;
  const resolveRuntimeBinary =
    readRuntimeBinaryResolver(config.codexRuntimeBinaryResolver) ?? resolveCodexRuntimeBinary;

  let cwd: string | null = null;
  let ctx: SessionContext | null = null;
  let appServer: AppServerClientLike | null = null;
  let activeProviderEnv: NodeJS.ProcessEnv | null = null;
  let threadId: string | null = null;
  let currentModel = "";
  let currentReasoningEffort = "high";
  let activePayload: AgentRuntimeConfigPayload | null = null;
  let serviceTierConfigurationFailure: string | null = null;
  let currentTurn: CurrentTurn | null = null;
  let currentTurnPromise: Promise<void> | null = null;
  let turnSettlementInProgress = false;
  let startupTurnPending = false;
  let turnStartInProgress = false;
  let turnStartAttempt: ProviderAttempt | null = null;
  let cancelProviderRetryBackoff: (() => void) | null = null;
  let providerRetryFence = false;
  let pendingDrainInProgress = false;
  let pendingDrainScheduled = false;
  let pendingInputGeneration = 0;
  let shutdownRequested = false;
  let pendingChatContextPrompt: string | null = null;
  let latestThreadUsageTotal: TokenUsageBreakdown | null = null;
  let latestCurrentSessionUsageTurnId: string | null = null;
  let workspaceOnly = false;
  let workspaceOnlyCodexHome: string | null = null;
  let workspaceOnlyHostHome: string | null = null;

  const pendingInputs: QueueEntry[] = [];
  const pendingNotificationsByTurn = new Map<string, CodexAppServerNotification[]>();

  const gitWriteTracker = createContextTreeGitWriteTracker({
    contextTreePath,
    contextTreeRepoUrl,
    contextTreeBranch,
    log: (message) => ctx?.log(message),
  });

  function createProviderAttempt(): ProviderAttempt {
    return new ProviderAttempt({
      provider: "codex",
      scope: "provider_turn",
      source: "sdk",
    });
  }

  function isExplicitTransientSettlement(settlement: ProviderAttemptSettlement): boolean {
    return (
      settlement.classification.category === "provider_capacity" ||
      settlement.classification.category === "transient_transport"
    );
  }

  async function waitForProviderRetry(delayMs: number): Promise<boolean> {
    if (shutdownRequested) return false;
    await new Promise<void>((resolveDelay) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (cancelProviderRetryBackoff === finish) cancelProviderRetryBackoff = null;
        resolveDelay();
      };
      const timer = setTimeout(finish, delayMs);
      cancelProviderRetryBackoff = finish;
    });
    return !shutdownRequested;
  }

  function emitProviderSettlementEvent(sessionCtx: SessionContext, settlement: ProviderAttemptSettlement): void {
    sessionCtx.emitEvent({
      kind: "error",
      payload: {
        source: "runtime",
        message: encodeProviderRetryEventMessage(settlement.eventPayload),
      },
    });
  }

  function recordAppServerFailureSignal(
    attempt: ProviderAttempt,
    error: TurnErrorInfo,
    turn?: Pick<CurrentTurn, "userVisibleOutput">,
    attemptNumber = 1,
  ): ProviderAttemptSettlement | null {
    const diagnostic = isCodexStreamDiagnosticMessage(error.message);
    const classification = attempt.recordSignal({
      kind: diagnostic ? "diagnostic" : "provider_error",
      error: providerErrorFromTurnErrorInfo(error),
      messagePreview: providerErrorPreview(error),
    });
    if (!classification && diagnostic) return null;
    if (turn) {
      if (turn.userVisibleOutput) {
        attempt.markUserVisibleOutput();
      } else if (classification?.category === "provider_capacity") {
        attempt.setReplaySafety("provider_entered");
      } else {
        attempt.setReplaySafety("pre_visible");
      }
    }
    return attempt.settle({ attempt: attemptNumber });
  }

  type AcceptedTurnStopDisposition =
    | { kind: "terminal_reject"; reason: TurnConsumedErrorReason }
    | { kind: "consume"; reason: TurnConsumedErrorReason };

  function stopReasonForSettlement(
    error: TurnErrorInfo,
    settlement: ProviderAttemptSettlement,
  ): TurnConsumedErrorReason | null {
    if (settlement.decision.action !== "stop") return null;
    if (settlement.decision.terminalKind === "exhausted") return "provider_retry_exhausted";
    if (settlement.classification.category === "deterministic_input") {
      return deterministicTerminalRejectionReason(errorInfoForSettlement(error, settlement));
    }
    return settlement.decision.reasonCode;
  }

  function acceptedTurnStopDisposition(
    error: TurnErrorInfo,
    settlement: ProviderAttemptSettlement,
  ): AcceptedTurnStopDisposition | null {
    const reason = stopReasonForSettlement(error, settlement);
    if (!reason) return null;
    if (settlement.classification.category === "deterministic_input") {
      return { kind: "terminal_reject", reason };
    }
    return { kind: "consume", reason };
  }

  function terminalTurnStartSettlement(
    error: TurnErrorInfo,
    attempt: ProviderAttempt,
  ): ProviderAttemptSettlement | null {
    const settlement = attempt.settle({ attempt: 1 });
    if (!settlement) return null;
    return stopReasonForSettlement(error, settlement) ? settlement : null;
  }

  function buildEnv(sessionCtx: SessionContext): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    const payload = agentConfigCache?.get(sessionCtx.agent.agentId)?.payload;
    if (payload) {
      for (const e of payload.env) env[e.key] = e.value;
    }
    const merged = sessionCtx.buildAgentEnv(env);
    const out: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(merged)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }

  function buildLandingCodexConfig(payload: AgentRuntimeConfigPayload, workspacePath: string): CodexConfigObject {
    const codexHome = workspaceOnlyCodexHome;
    const hostHome = workspaceOnlyHostHome;
    if (!codexHome || !hostHome) {
      throw new CodexAppServerStartupError("workspace-sandbox", "missing workspace-only Codex host paths");
    }
    const cfg = buildCodexConfig(payload);
    cfg.permissions = {
      [LANDING_CODEX_PERMISSIONS_PROFILE]: buildLandingCodexPermissionProfile(workspacePath, codexHome, hostHome),
    };
    return cfg;
  }

  async function resolvePayload(sessionCtx: SessionContext): Promise<{
    payload: AgentRuntimeConfigPayload;
    resolved: boolean;
    runtimeConfig: AgentRuntimeConfig | null;
  }> {
    if (agentConfigCache) {
      const runtimeConfig = await agentConfigCache.refresh(sessionCtx.agent.agentId);
      return { payload: runtimeConfig.payload, resolved: true, runtimeConfig };
    }
    return {
      resolved: false,
      runtimeConfig: null,
      payload: {
        kind: "codex",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
        reasoningEffort: "high",
        serviceTier: "default",
      },
    };
  }

  async function prepareSession(sessionCtx: SessionContext): Promise<{
    payload: AgentRuntimeConfigPayload;
    env: NodeJS.ProcessEnv;
    briefingFingerprint: string;
  }> {
    workspaceOnly = isLandingCampaignTrialAgentMetadata(sessionCtx.agent.metadata);
    const { payload, resolved, runtimeConfig } = await resolvePayload(sessionCtx);

    // Landing-campaign workspace-only env setup sits between skills and
    // briefing so a sandbox failure leaves no sentinel and no provider
    // admission (prepareManagedSession's beforeBriefing hook).
    let env: NodeJS.ProcessEnv = {};
    const prepared = await prepareManagedSession({
      sessionCtx,
      workspaceRoot,
      agentName,
      runtimeProvider,
      providerSkillRoots: PROVIDER_SKILL_ROOTS,
      runtimeConfig,
      payload,
      payloadResolved: resolved,
      contextTree: {
        kind: contextTree.kind,
        path: contextTree.path,
        repoUrl: contextTree.repoUrl,
        branch: contextTree.branch,
      },
      beforeBriefing: async ({ workspace }) => {
        env = buildEnv(sessionCtx);
        if (workspaceOnly) {
          const { accessToken } = await sessionCtx.sdk.createAgentOutboxToken(sessionCtx.chatId);
          const outboxEnv = prepareWorkspaceOnlyOutboxHome({
            parentEnv: env,
            workspaceRoot: workspace,
            agentId: sessionCtx.agent.agentId,
            runtimeProvider: payload.kind,
            accessToken,
            serverUrl: env.FIRST_TREE_SERVER_URL ?? sessionCtx.sdk.serverUrl,
          }).env;
          try {
            const appServerEnv = buildWorkspaceOnlyAppServerEnvironment(outboxEnv, workspace);
            env = appServerEnv.env;
            workspaceOnlyCodexHome = appServerEnv.codexHome;
            workspaceOnlyHostHome = appServerEnv.hostHome;
          } catch (err) {
            throw new CodexAppServerStartupError("workspace-sandbox", err);
          }
        } else {
          workspaceOnlyCodexHome = null;
          workspaceOnlyHostHome = null;
        }
      },
    });
    cwd = prepared.workspace;
    pendingChatContextPrompt = renderChatContextPrompt(prepared.chatContext);
    currentModel = payload.model || "";
    currentReasoningEffort = payload.kind === "codex" ? payload.reasoningEffort : "high";
    return { payload, env, briefingFingerprint: computeBriefingFingerprint(prepared.briefing) };
  }

  async function startAppServer(sessionCtx: SessionContext, env: NodeJS.ProcessEnv): Promise<void> {
    const workspacePath = cwd ?? workspaceRoot;
    let resolution: CodexBinaryResolution;
    try {
      resolution = await resolveRuntimeBinary(env);
    } catch (err) {
      throw new CodexAppServerStartupError("resolve-binary", err);
    }
    if (!resolution.ok) throw new CodexAppServerStartupError("resolve-binary", resolution.cause ?? resolution.error);
    try {
      const appServerArgs =
        workspaceOnly && workspaceOnlyCodexHome && workspaceOnlyHostHome
          ? buildLandingCodexAppServerArgs(workspacePath, workspaceOnlyCodexHome, workspaceOnlyHostHome)
          : undefined;
      appServer = await clientFactory({
        binary: resolution.binary,
        cwd: workspacePath,
        env,
        ...(appServerArgs ? { appServerArgs } : {}),
        onNotification: handleNotification,
        onClose: handleTransportClose,
        onLog: (message) => sessionCtx.log(message),
      });
      activeProviderEnv = env;
    } catch (err) {
      throw new CodexAppServerStartupError("initialize", err);
    }
  }

  function threadParams(payload: AgentRuntimeConfigPayload): JsonRecord {
    const workspacePath = cwd ?? workspaceRoot;
    const opts = buildCodexThreadOptions(payload, workspacePath);
    const params: JsonRecord = {
      cwd: opts.workingDirectory,
      approvalPolicy: opts.approvalPolicy,
      config: workspaceOnly ? buildLandingCodexConfig(payload, workspacePath) : buildCodexConfig(payload),
      ...(opts.model ? { model: opts.model } : {}),
    };
    if (workspaceOnly) {
      params.permissions = LANDING_CODEX_PERMISSIONS_PROFILE;
      params.runtimeWorkspaceRoots = [workspacePath];
    } else {
      params.sandbox = opts.sandboxMode;
    }
    return params;
  }

  function recordServiceTierConfigurationFailure(message: string): void {
    if (serviceTierConfigurationFailure) return;
    serviceTierConfigurationFailure = message;
    ctx?.emitEvent({
      kind: "error",
      payload: {
        source: "runtime",
        message: `Codex service tier configuration failed: ${message}`,
      },
    });
  }

  function validateEffectiveServiceTier(result: unknown, payload: AgentRuntimeConfigPayload): void {
    if (payload.kind !== "codex") return;
    const configuredTier = configuredCodexServiceTier(payload);
    if (configuredTier === "default") return;
    const response = asRecord(result);
    const effectiveTier = readString(response, "serviceTier") ?? readString(response, "service_tier");
    if (effectiveTier && codexServiceTiersEquivalent(configuredTier, effectiveTier)) return;
    recordServiceTierConfigurationFailure(
      `Configured service tier \`${configuredTier}\` was not activated by Codex and will not be used for requests.`,
    );
  }

  async function startThread(payload: AgentRuntimeConfigPayload, sessionCtx: SessionContext): Promise<string> {
    const client = requireAppServer();
    let result: unknown;
    serviceTierConfigurationFailure = null;
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
    try {
      result = await client.request("thread/start", {
        ...threadParams(payload),
        sessionStartSource: "startup",
      });
    } catch (err) {
      throw new CodexAppServerStartupError("thread-start", err);
    }
    validateEffectiveServiceTier(result, payload);
    const id = extractThreadId(result);
    if (!id) throw new CodexAppServerStartupError("thread-start", "missing thread id");
    threadId = id;
    resetThreadUsageTracking(emptyTokenUsage());
    return id;
  }

  async function resumeThread(
    sessionId: string,
    payload: AgentRuntimeConfigPayload,
    sessionCtx: SessionContext,
  ): Promise<void> {
    const client = requireAppServer();
    resetThreadUsageTracking(null);
    serviceTierConfigurationFailure = null;
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
    try {
      const result = await client.request("thread/resume", {
        threadId: sessionId,
        ...threadParams(payload),
      });
      validateEffectiveServiceTier(result, payload);
    } catch (err) {
      throw new CodexAppServerStartupError("thread-resume", err);
    }
    threadId = sessionId;
  }

  async function startFreshThreadAfterStaleRollout(
    payload: AgentRuntimeConfigPayload,
    sessionCtx: SessionContext,
    staleThreadId: string | null,
  ): Promise<string> {
    const recoveryMessage = staleRolloutRecoveryMessage(staleThreadId);
    sessionCtx.emitEvent({ kind: "error", payload: { source: "runtime", message: recoveryMessage } });
    sessionCtx.log(recoveryMessage);
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
      sessionCtx.failSessionForRecovery?.("codex_app_server_context_source_changed", staleThreadId ?? undefined);
      throw sourceError;
    }
    const replacementThreadId = await startThread(payload, sessionCtx);
    sessionCtx.replaceSessionId?.(replacementThreadId, "codex_stale_rollout_recovered");
    sessionCtx.emitEvent({
      kind: "error",
      payload: { source: "runtime", message: staleRolloutRecoveryMessage(staleThreadId, replacementThreadId) },
    });
    return replacementThreadId;
  }

  function emitToolCall(
    sessionCtx: SessionContext,
    payload: {
      toolUseId: string;
      name: string;
      args: unknown;
      status: "ok" | "error" | "pending";
      resultPreview?: string;
      toolFileRefs?: ToolFileRef[];
    },
  ): void {
    const event: SessionEvent = {
      kind: "tool_call",
      payload: {
        toolUseId: payload.toolUseId,
        name: payload.name,
        args: payload.args,
        status: payload.status,
        ...(payload.resultPreview ? { resultPreview: payload.resultPreview.slice(0, RESULT_PREVIEW_LIMIT) } : {}),
        ...(payload.toolFileRefs && payload.toolFileRefs.length > 0 ? { toolFileRefs: payload.toolFileRefs } : {}),
      },
    };
    sessionCtx.emitEvent(event);
  }

  function processItem(item: JsonRecord, sessionCtx: SessionContext, turn: CurrentTurn): void {
    const itemType = item.type;
    const id = typeof item.id === "string" ? item.id : `${turn.turnId}:${turn.completedItemIds.size}`;
    if (turn.completedItemIds.has(id)) return;
    turn.completedItemIds.add(id);

    switch (itemType) {
      case "agentMessage": {
        const text = typeof item.text === "string" ? item.text : "";
        if (!text.trim()) return;
        turn.userVisibleOutput = true;
        turn.providerAttempt.markUserVisibleOutput();
        // Chunk so the FULL assistant text is preserved across one or more
        // events — the durable troubleshooting record now that the per-turn
        // final-text chat mirror is retired.
        for (const chunk of chunkAssistantText(text)) {
          sessionCtx.emitEvent({ kind: "assistant_text", payload: { text: chunk } });
        }
        turn.finalAgentText = text;
        return;
      }
      case "commandExecution": {
        turn.userVisibleOutput = true;
        turn.providerAttempt.markUserVisibleOutput();
        const status = toolStatus(item.status);
        const command = typeof item.command === "string" ? item.command : "";
        const commandCwd = typeof item.cwd === "string" ? item.cwd : (cwd ?? undefined);
        const shellRefs =
          status === "ok" && commandCwd
            ? toolFileRefsFromShellCommand({
                command,
                cwd: commandCwd,
                contextTreePath,
                contextTreeRepoUrl,
                contextTreeBranch,
              })
            : undefined;
        const toolFileRefs = toolFileRefsForTerminalTool({
          status,
          existingRefs: shellRefs,
          gitWriteTracker,
          toolName: "command",
          toolUseId: id,
        });
        emitToolCall(sessionCtx, {
          toolUseId: id,
          name: "command",
          args: { command, ...(commandCwd ? { cwd: commandCwd } : {}) },
          status,
          resultPreview: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined,
          toolFileRefs,
        });
        return;
      }
      case "fileChange": {
        turn.userVisibleOutput = true;
        turn.providerAttempt.markUserVisibleOutput();
        const status = toolStatus(item.status);
        const changes = item.changes;
        const fileChangeRefs =
          status === "ok" && cwd
            ? toolFileRefsFromAppServerFileChange({
                changes,
                workspaceCwd: cwd,
                contextTreePath,
                contextTreeRepoUrl,
                contextTreeBranch,
              })
            : undefined;
        const toolFileRefs = toolFileRefsForTerminalTool({
          status,
          existingRefs: fileChangeRefs,
          gitWriteTracker,
          toolName: "file_change",
          toolUseId: id,
        });
        emitToolCall(sessionCtx, {
          toolUseId: id,
          name: "file_change",
          args: { changes },
          status,
          toolFileRefs,
        });
        return;
      }
      case "mcpToolCall": {
        turn.userVisibleOutput = true;
        turn.providerAttempt.markUserVisibleOutput();
        const status = toolStatus(item.status);
        const error = asRecord(item.error);
        const result = asRecord(item.result);
        const resultPreview = error
          ? `error: ${typeof error.message === "string" ? error.message : JSON.stringify(error)}`
          : result
            ? JSON.stringify(result.structuredContent ?? result.structured_content ?? result.content)
            : undefined;
        emitToolCall(sessionCtx, {
          toolUseId: id,
          name: `mcp:${typeof item.server === "string" ? item.server : "unknown"}/${
            typeof item.tool === "string" ? item.tool : "unknown"
          }`,
          args: item.arguments,
          status,
          resultPreview,
        });
        return;
      }
      case "webSearch": {
        turn.userVisibleOutput = true;
        turn.providerAttempt.markUserVisibleOutput();
        emitToolCall(sessionCtx, {
          toolUseId: id,
          name: "web_search",
          args: { query: typeof item.query === "string" ? item.query : "" },
          status: "ok",
        });
        return;
      }
      case "plan": {
        turn.userVisibleOutput = true;
        turn.providerAttempt.markUserVisibleOutput();
        emitToolCall(sessionCtx, {
          toolUseId: id,
          name: "todo_list",
          args: { text: typeof item.text === "string" ? item.text : "" },
          status: "ok",
        });
        return;
      }
      case "reasoning": {
        sessionCtx.emitEvent({ kind: "thinking", payload: {} });
        return;
      }
      default:
        return;
    }
  }

  function handleNotification(notification: CodexAppServerNotification): void {
    const sessionCtx = ctx;
    if (!sessionCtx) return;
    sessionCtx.recordProviderActivity();
    const params = asRecord(notification.params);
    const notificationThreadId = params ? (readString(params, "threadId") ?? readString(params, "thread_id")) : null;
    const notificationTurnId =
      params && asRecord(params.turn)
        ? readString(asRecord(params.turn), "id")
        : params
          ? (readString(params, "turnId") ?? readString(params, "turn_id"))
          : null;

    if (threadId && notificationThreadId && notificationThreadId !== threadId) return;

    const turn = currentTurn;
    if (
      turnStartAttempt &&
      notification.method === "error" &&
      notificationTurnId &&
      (!turn || turn.turnId !== notificationTurnId)
    ) {
      const error = params ? parseTurnError(params.error) : null;
      if (error) recordAppServerFailureSignal(turnStartAttempt, error);
    }
    if (notificationTurnId && (!turn || turn.turnId !== notificationTurnId)) {
      const historicalTokenUsageRecorded = !turnStartInProgress && recordHistoricalTokenUsage(notification);
      if (!historicalTokenUsageRecorded) bufferNotification(notificationTurnId, notification);
      return;
    }
    applyNotification(notification, sessionCtx, turn);
  }

  function applyNotification(
    notification: CodexAppServerNotification,
    sessionCtx: SessionContext,
    turn: CurrentTurn | null,
  ): void {
    const params = asRecord(notification.params);
    if (!params) return;

    switch (notification.method) {
      case "warning": {
        const message = readString(params, "message");
        if (message && isUnsupportedCodexServiceTierWarning(message)) {
          recordServiceTierConfigurationFailure(message);
        }
        return;
      }
      case "item/completed": {
        const item = asRecord(params.item);
        if (item && turn) processItem(item, sessionCtx, turn);
        return;
      }
      case "thread/tokenUsage/updated": {
        const usage = parseThreadTokenUsage(asRecord(params.tokenUsage));
        if (usage && turn) {
          recordCurrentTurnTokenUsage(turn, usage);
        } else if (usage) {
          recordLatestThreadUsageTotal(usage.total);
        }
        return;
      }
      case "error": {
        const error = parseTurnError(params.error);
        if (error) {
          const diagnostic = isCodexStreamDiagnosticMessage(error.message);
          if (turn) {
            turn.lastSdkError = error;
            turn.sdkErrorEmitted = !diagnostic;
            recordAppServerFailureSignal(turn.providerAttempt, error, turn);
          } else if (turnStartAttempt) {
            recordAppServerFailureSignal(turnStartAttempt, error);
          }
          if (!diagnostic) {
            sessionCtx.emitEvent({
              kind: "error",
              payload: { source: "sdk", message: formatAppServerError(error.message) },
            });
          }
        }
        return;
      }
      case "turn/completed": {
        if (!turn) return;
        const terminal = asRecord(params.turn);
        settleTerminalNotification(terminal, sessionCtx, turn);
        return;
      }
      default:
        return;
    }
  }

  function settleTerminalNotification(
    terminal: JsonRecord | null,
    sessionCtx: SessionContext,
    turn: CurrentTurn,
  ): void {
    if (terminal) {
      const items = Array.isArray(terminal.items) ? terminal.items : [];
      for (const item of items) {
        const record = asRecord(item);
        if (record) processItem(record, sessionCtx, turn);
      }
      const status = readString(terminal, "status");
      if (status === "completed") {
        turn.status = "completed";
        turn.providerCompleted = true;
      } else if (status === "failed") {
        turn.status = "failed";
        turn.failure = parseTurnError(terminal.error) ?? {
          message: "codex app-server turn failed",
          codexErrorInfo: null,
          additionalDetails: null,
        };
      } else if (status === "interrupted") {
        turn.status = "interrupted";
        turn.failure = parseTurnError(terminal.error) ?? {
          message: "codex app-server turn interrupted",
          codexErrorInfo: null,
          additionalDetails: null,
        };
      }
    }
    turn.resolveTerminal();
  }

  function replayBufferedNotifications(turn: CurrentTurn, sessionCtx: SessionContext): void {
    const buffered = pendingNotificationsByTurn.get(turn.turnId);
    if (!buffered) return;
    pendingNotificationsByTurn.delete(turn.turnId);
    for (const notification of buffered) applyNotification(notification, sessionCtx, turn);
  }

  function bufferNotification(turnId: string, notification: CodexAppServerNotification): void {
    const list = pendingNotificationsByTurn.get(turnId) ?? [];
    list.push(notification);
    pendingNotificationsByTurn.set(turnId, list);
  }

  function recordHistoricalTokenUsage(notification: CodexAppServerNotification): boolean {
    if (notification.method !== "thread/tokenUsage/updated") return false;
    const params = asRecord(notification.params);
    const usage = parseThreadTokenUsage(asRecord(params?.tokenUsage));
    if (!usage) return true;

    const turn = currentTurn;
    if (turn?.usageLatestTotal) return true;
    const notificationTurnId = params ? (readString(params, "turnId") ?? readString(params, "turn_id")) : null;

    if (latestCurrentSessionUsageTurnId) {
      if (notificationTurnId === latestCurrentSessionUsageTurnId) acceptHistoricalTokenUsageTotal(usage.total);
      return true;
    }

    acceptHistoricalTokenUsageTotal(usage.total);
    return true;
  }

  function recordBufferedHistoricalTokenUsageExcept(currentTurnId: string): void {
    for (const [turnId, notifications] of pendingNotificationsByTurn) {
      if (turnId === currentTurnId) continue;
      for (const notification of notifications) recordHistoricalTokenUsage(notification);
      pendingNotificationsByTurn.delete(turnId);
    }
  }

  function recordCurrentTurnTokenUsage(turn: CurrentTurn, usage: ThreadTokenUsageSnapshot): void {
    latestCurrentSessionUsageTurnId = turn.turnId;
    turn.usageLatestTotal = cloneTokenUsage(usage.total);
    turn.usageLastSum = addTokenUsage(turn.usageLastSum ?? emptyTokenUsage(), usage.last);
    advanceCurrentThreadUsageTotal(usage.total);
  }

  function acceptHistoricalTokenUsageTotal(usage: TokenUsageBreakdown): void {
    if (latestCurrentSessionUsageTurnId) {
      advanceCurrentThreadUsageTotal(usage);
    } else {
      recordLatestThreadUsageTotal(usage);
    }
    syncCurrentTurnUsageBaseline();
  }

  function syncCurrentTurnUsageBaseline(): void {
    const turn = currentTurn;
    if (turn && !turn.usageLatestTotal) turn.usageBaselineTotal = cloneTokenUsage(latestThreadUsageTotal);
  }

  function resetThreadUsageTracking(baseline: TokenUsageBreakdown | null): void {
    latestThreadUsageTotal = cloneTokenUsage(baseline);
    latestCurrentSessionUsageTurnId = null;
  }

  function recordLatestThreadUsageTotal(usage: TokenUsageBreakdown): void {
    if (!latestThreadUsageTotal || usage.totalTokens >= latestThreadUsageTotal.totalTokens) {
      latestThreadUsageTotal = cloneTokenUsage(usage);
    }
  }

  function advanceCurrentThreadUsageTotal(usage: TokenUsageBreakdown): void {
    latestThreadUsageTotal = cloneTokenUsage(usage);
  }

  function handleTransportClose(error: CodexAppServerTransportError): void {
    const sessionCtx = ctx;
    const turn = currentTurn;
    if (sessionCtx) {
      sessionCtx.log(`codex app-server transport closed: ${error.message}`);
    }
    if (turn && turn.status === "inProgress" && !turn.stopRequested) {
      turn.failure = { message: error.message, codexErrorInfo: null, additionalDetails: null };
      turn.status = "failed";
      turn.resolveTerminal();
    }
  }

  async function closeAppServerAfterUnknownCustody(
    sessionCtx: SessionContext,
    reason: string,
    err: unknown,
  ): Promise<void> {
    shutdownRequested = true;
    turnStartInProgress = false;
    retryQueuedMessages(reason);
    const client = appServer;
    const resumeThreadId = threadId ?? undefined;
    appServer = null;
    activeProviderEnv = null;
    threadId = null;
    resetThreadUsageTracking(null);
    pendingNotificationsByTurn.clear();
    sessionCtx.log(
      `codex app-server session closed after unknown input custody (${reason}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    const shutdown = client?.shutdown();
    sessionCtx.failSessionForRecovery?.(reason, resumeThreadId);
    await shutdown;
  }

  async function closeAppServerAfterTerminalTurnStartFailure(
    sessionCtx: SessionContext,
    reason: string,
  ): Promise<void> {
    shutdownRequested = true;
    turnStartInProgress = false;
    retryQueuedMessages(reason);
    const client = appServer;
    const resumeThreadId = threadId ?? undefined;
    appServer = null;
    activeProviderEnv = null;
    threadId = null;
    resetThreadUsageTracking(null);
    pendingNotificationsByTurn.clear();
    sessionCtx.log(`codex app-server session closed after terminal turn/start failure (${reason})`);
    const shutdown = client?.shutdown();
    sessionCtx.failSessionForRecovery?.(reason, resumeThreadId);
    await shutdown;
  }

  async function closeAppServerAfterUncommittablePrefix(sessionCtx: SessionContext, reason: string): Promise<void> {
    shutdownRequested = true;
    turnStartInProgress = false;
    retryQueuedMessages(reason);
    const client = appServer;
    const resumeThreadId = threadId ?? undefined;
    appServer = null;
    activeProviderEnv = null;
    threadId = null;
    resetThreadUsageTracking(null);
    pendingNotificationsByTurn.clear();
    sessionCtx.log(`codex app-server session closed after uncommittable turn prefix (${reason})`);
    const shutdown = client?.shutdown();
    sessionCtx.failSessionForRecovery?.(reason, resumeThreadId);
    await shutdown;
  }

  /**
   * Returns whether the turn actually reached the provider (turn/start
   * accepted, turn id assigned). The briefing-update notice rides this turn's
   * input (consumed from `pendingChatContextPrompt`), so the caller must only
   * advance the briefing baseline when this is `true`: every early `token.retry`
   * path below bounced the message for redelivery before the model saw the
   * notice, and advancing the baseline there would suppress it on redelivery.
   */
  async function runTurnFromText(
    inputText: string,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
    sessionCtx: SessionContext,
    allowStaleRolloutRecovery = true,
    providerAttemptNumber = 1,
    providerRetryChain = false,
  ): Promise<boolean> {
    const client = appServer;
    if (!client || !threadId) {
      token.retry(messages, "codex_app_server_missing_thread");
      return false;
    }
    if (shutdownRequested) {
      token.retry(messages, "codex_app_server_shutdown_before_turn_start");
      return false;
    }
    if (turnStartInProgress) {
      token.retry(messages, "codex_app_server_turn_start_already_in_progress");
      return false;
    }
    if (serviceTierConfigurationFailure) {
      token.processingStarted(messages);
      const providerAttempt = createProviderAttempt();
      providerAttempt.recordSignal({
        kind: "provider_error",
        error: new Error(`Codex service tier configuration failed: ${serviceTierConfigurationFailure}`),
      });
      const providerSettlement = providerAttempt.settle({ attempt: 1 });
      if (!providerSettlement || providerSettlement.decision.action !== "stop") {
        token.retry(messages, "codex_service_tier_configuration_unclassified");
        return false;
      }
      emitProviderSettlementEvent(sessionCtx, providerSettlement);
      sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
      await token.complete(messages, consumedErrorOutcome(providerSettlement.decision.reasonCode));
      return false;
    }

    const promptSnapshot = pendingChatContextPrompt;
    const providerInputText = consumePendingChatContext(inputText);
    gitWriteTracker.captureBaseline();
    let result: unknown;
    turnStartInProgress = true;
    turnStartAttempt = createProviderAttempt();
    try {
      result = await client.request("turn/start", {
        threadId,
        input: [textInput(providerInputText)],
        ...(cwd ? { cwd } : {}),
        approvalPolicy: "never",
        model: currentModel || null,
        effort: currentReasoningEffort,
      });
    } catch (err) {
      turnStartInProgress = false;
      if (allowStaleRolloutRecovery && isCodexStaleRolloutError(err) && activePayload) {
        turnStartAttempt = null;
        pendingChatContextPrompt = promptSnapshot;
        const staleThreadId = extractCodexStaleRolloutThreadId(err) ?? threadId;
        try {
          await startFreshThreadAfterStaleRollout(activePayload, sessionCtx, staleThreadId);
        } catch (sourceError) {
          if (!isContextSourceTransitionError(sourceError)) throw sourceError;
          token.retry(messages, "codex_app_server_context_source_changed");
          return false;
        }
        return runTurnFromText(
          inputText,
          messages,
          token,
          sessionCtx,
          false,
          providerAttemptNumber,
          providerRetryChain,
        );
      }
      const attempt = turnStartAttempt ?? createProviderAttempt();
      turnStartAttempt = null;
      const syntheticFailure = {
        message: err instanceof Error ? err.message : String(err),
        codexErrorInfo: null,
        additionalDetails: null,
      };
      const classification = attempt.recordSignal({
        kind: "local_error",
        error: err instanceof Error ? err : new Error(syntheticFailure.message),
        messagePreview: syntheticFailure.message,
      });
      attempt.setReplaySafety(classification?.category === "provider_capacity" ? "provider_entered" : "pre_provider");
      const terminalSettlement = terminalTurnStartSettlement(syntheticFailure, attempt);
      if (terminalSettlement) {
        const terminalReason = stopReasonForSettlement(syntheticFailure, terminalSettlement);
        if (terminalReason) {
          emitProviderSettlementEvent(sessionCtx, terminalSettlement);
          token.processingStarted(messages);
          sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
          await token.complete(messages, consumedErrorOutcome(terminalReason));
          await closeAppServerAfterTerminalTurnStartFailure(sessionCtx, terminalReason);
          return false;
        }
      }
      const reason = isCodexAppServerTransientError(err)
        ? "codex_app_server_turn_start_unknown_custody_transient"
        : "codex_app_server_turn_start_unknown_custody_failed";
      token.retry(messages, reason);
      await closeAppServerAfterUnknownCustody(sessionCtx, reason, err);
      return false;
    }

    const turnRecord = asRecord(asRecord(result)?.turn);
    const turnId = turnRecord ? readString(turnRecord, "id") : null;
    if (!turnId) {
      turnStartInProgress = false;
      const attempt = turnStartAttempt ?? createProviderAttempt();
      turnStartAttempt = null;
      const syntheticFailure = {
        message: "missing turn id in turn/start response",
        codexErrorInfo: null,
        additionalDetails: null,
      };
      const terminalSettlement = terminalTurnStartSettlement(syntheticFailure, attempt);
      if (terminalSettlement) {
        const terminalReason = stopReasonForSettlement(syntheticFailure, terminalSettlement);
        if (terminalReason) {
          emitProviderSettlementEvent(sessionCtx, terminalSettlement);
          token.processingStarted(messages);
          sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
          await token.complete(messages, consumedErrorOutcome(terminalReason));
          await closeAppServerAfterTerminalTurnStartFailure(sessionCtx, terminalReason);
          return false;
        }
      }
      const reason = "codex_app_server_turn_start_missing_id_unknown_custody";
      token.retry(messages, reason);
      await closeAppServerAfterUnknownCustody(sessionCtx, reason, "missing turn id in turn/start response");
      return false;
    }

    recordBufferedHistoricalTokenUsageExcept(turnId);
    const turn = await createCurrentTurn(
      turnId,
      messages,
      token,
      sessionCtx,
      providerAttemptNumber,
      providerRetryChain,
    );
    turnStartAttempt = null;
    turnStartInProgress = false;
    schedulePendingDrain();
    if (turnRecord && readString(turnRecord, "status") !== "inProgress") {
      settleTerminalNotification(turnRecord, sessionCtx, turn);
    }
    replayBufferedNotifications(turn, sessionCtx);
    await currentTurnPromise;
    turnSettlementInProgress = true;
    let providerRetrySettlement: ProviderAttemptSettlement | null = null;
    try {
      providerRetrySettlement = await settleTurn(turn, sessionCtx);
    } finally {
      turnSettlementInProgress = false;
      if (providerRetrySettlement) providerRetryFence = true;
      if (currentTurn === turn) currentTurn = null;
      if (!providerRetrySettlement) schedulePendingDrain();
    }
    if (providerRetrySettlement?.decision.action === "retry") {
      const { attempt, delayMs, maxAttempts } = providerRetrySettlement.decision;
      sessionCtx.log(
        `codex app-server turn retry ${attempt}/${(maxAttempts ?? attempt) + 1} after ${delayMs}ms; ` +
          `${providerRetrySettlement.classification.category}: ${providerRetrySettlement.messagePreview}`,
      );
      if (!(await waitForProviderRetry(delayMs))) return false;
      return runTurnFromText(inputText, turn.acceptedMessages, token, sessionCtx, true, attempt + 1, true);
    }
    // Reached the provider (turn/start accepted, turn id assigned), so the
    // notice-bearing input was delivered to the model.
    return true;
  }

  function consumePendingChatContext(inputText: string): string {
    const chatPrompt = pendingChatContextPrompt;
    pendingChatContextPrompt = null;
    // Codex has no persistent system-prompt channel (unlike the Claude path's
    // `systemPrompt.append`), so the same provider-neutral runtime contract
    // rides every turn input — keeping the console/outbox boundary in the
    // immediate context tail where a "discuss only / hold off" instruction also
    // lands. Prepended ahead of any chat-context block.
    const contract = renderRuntimeOutputContract();
    const prefix = chatPrompt ? `${contract}\n\n${chatPrompt}` : contract;
    return `${prefix}\n\n${inputText}`;
  }

  async function createCurrentTurn(
    turnId: string,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
    sessionCtx: SessionContext,
    providerAttemptNumber: number,
    providerRetryChain: boolean,
  ): Promise<CurrentTurn> {
    let resolveTerminal: () => void = () => {};
    const terminalPromise = new Promise<void>((resolve) => {
      resolveTerminal = resolve;
    });
    const providerAttempt = turnStartAttempt ?? createProviderAttempt();
    providerAttempt.setReplaySafety("pre_visible");
    const turn: CurrentTurn = {
      turnId,
      providerAttemptNumber,
      providerRetryChain,
      status: "inProgress",
      primaryToken: token,
      acceptedMessages: [...messages],
      appendRejectedInputGeneration: null,
      inFlightAppend: null,
      finalAgentText: "",
      completedItemIds: new Set(),
      usageBaselineTotal: cloneTokenUsage(latestThreadUsageTotal),
      usageLatestTotal: null,
      usageLastSum: null,
      failure: null,
      lastSdkError: null,
      providerCompleted: false,
      stopRequested: false,
      sdkErrorEmitted: false,
      providerAttempt,
      userVisibleOutput: false,
      resolveTerminal,
    };
    currentTurn = turn;
    if (providerRetryChain) providerRetryFence = false;
    token.processingStarted(messages);
    currentTurnPromise = terminalPromise.finally(() => {
      currentTurnPromise = null;
    });
    sessionCtx.log(`codex app-server turn started turnId=${turnId} accepted=${messages.length}`);
    schedulePendingDrain();
    return turn;
  }

  async function failCurrentTurnAfterUnknownSteer(
    turn: CurrentTurn,
    batch: readonly QueueEntry[],
    reason: string,
    err: unknown,
    sessionCtx: SessionContext,
    additionalDetails = "turn/steer input custody is unknown; app-server session was closed",
  ): Promise<void> {
    turn.stopRequested = true;
    turn.status = "failed";
    turn.failure = {
      message: err instanceof Error ? err.message : String(err),
      codexErrorInfo: null,
      additionalDetails,
    };
    turn.resolveTerminal();
    turn.primaryToken.retry([...turn.acceptedMessages, ...batch.map((entry) => entry.message)], reason);
    await closeAppServerAfterUnknownCustody(sessionCtx, reason, err);
  }

  async function settleTurn(turn: CurrentTurn, sessionCtx: SessionContext): Promise<ProviderAttemptSettlement | null> {
    if (turn.inFlightAppend) await turn.inFlightAppend;

    if (turn.stopRequested || shutdownRequested) {
      schedulePendingDrain();
      return null;
    }

    const completedSuccessfully = turn.providerCompleted && turn.failure === null && turn.status === "completed";
    const finalAgentText = turn.finalAgentText.trim();
    const usage = computeTurnUsageDelta(turn);
    const zeroTokenDelta =
      usage !== null &&
      usage.inputTokens === 0 &&
      usage.cachedInputTokens === 0 &&
      usage.outputTokens === 0 &&
      usage.reasoningOutputTokens === 0;
    const usageLimitEmptyTurn = completedSuccessfully && finalAgentText.length === 0 && zeroTokenDelta;
    const completedEmptyCompactFailure =
      completedSuccessfully && finalAgentText.length === 0
        ? completedEmptyCompactFailureInfo(turn, appServer?.stderr ?? "")
        : null;
    const usageLimitFailure = turn.failure ? isUsageLimitErrorInfo(turn.failure.codexErrorInfo) : false;

    let forwardFailed = false;
    let retryReason: string | null = null;
    let consumedErrorReason: TurnConsumedErrorReason | null = null;
    let terminalRejectionReason: string | null = null;
    let providerRetrySettlement: ProviderAttemptSettlement | null = null;

    if (completedEmptyCompactFailure) {
      terminalRejectionReason = deterministicTerminalRejectionReason(completedEmptyCompactFailure);
      sessionCtx.emitEvent({
        kind: "error",
        payload: { source: "sdk", message: formatDeterministicFailureMessage(completedEmptyCompactFailure) },
      });
      sessionCtx.log(
        `codex app-server turn completed empty after compact failure; terminal rejecting delivery (${terminalRejectionReason}): ${completedEmptyCompactFailure.message}`,
      );
    } else if (usageLimitEmptyTurn || usageLimitFailure) {
      sessionCtx.emitEvent({
        kind: "error",
        payload: {
          source: "runtime",
          message: "codex usage limit reached: turn completed without a usable model response",
        },
      });
      // Slot-log line for external log watchers (e.g. account-failover
      // automation tailing client.log) — the sdk runtime's usage-limit branch
      // already logs; keep the `provider_usage_limit` tag stable.
      sessionCtx.log(
        `codex app-server usage limit reached (provider_usage_limit) chatId=${sessionCtx.chatId}: ${
          usageLimitFailure && turn.failure
            ? `turn failed with usage-limit error: ${turn.failure.message}`
            : "empty turn, model not invoked (zero token delta)"
        }; posting a chat notice instead of silently acking the message`,
      );
      // Post the usage-limit notice as a deliberate, chat-visible runtime
      // message — an EXPLICIT send, not the retired final-text forward
      // (`forwardResult` no longer delivers). It goes through the dedicated
      // runtime-notice endpoint, which owns the recipientless notify=false
      // delivery profile and the server-side `runtimeNotice` marker.
      try {
        await sessionCtx.sdk.postRuntimeNotice(sessionCtx.chatId, USAGE_LIMIT_NOTICE);
        consumedErrorReason = "usage_limit_notice_posted";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sessionCtx.emitEvent({
          kind: "error",
          payload: { source: "runtime", message: `usage-limit notice delivery failed: ${msg}` },
        });
        retryReason = "codex_usage_limit_notice_delivery_failed";
      }
    } else if (completedSuccessfully && finalAgentText) {
      try {
        await sessionCtx.forwardResult(finalAgentText);
      } catch (err) {
        forwardFailed = true;
        const msg = err instanceof Error ? err.message : String(err);
        sessionCtx.emitEvent({
          kind: "error",
          payload: { source: "runtime", message: `forwardResult failed: ${msg}` },
        });
      }
    } else if (turn.failure) {
      const failure = mergeFailureWithDiagnostic(turn.failure, turn.lastSdkError);
      const providerSettlement = recordAppServerFailureSignal(
        turn.providerAttempt,
        failure,
        turn,
        turn.providerAttemptNumber,
      );
      const providerStopDisposition = providerSettlement
        ? acceptedTurnStopDisposition(failure, providerSettlement)
        : null;
      if (providerSettlement?.decision.action === "retry") {
        emitProviderSettlementEvent(sessionCtx, providerSettlement);
        if (
          isExplicitTransientSettlement(providerSettlement) &&
          (providerSettlement.decision.replaySafety === "user_visible" || turn.providerRetryChain)
        ) {
          providerRetrySettlement = providerSettlement;
        } else {
          const kind = classifyAppServerFailure(failure);
          retryReason = `codex_${kind}_failure`;
          sessionCtx.log(`codex app-server turn failed (${kind}): ${turn.failure.message}`);
        }
      } else if (providerSettlement && providerStopDisposition) {
        emitProviderSettlementEvent(sessionCtx, providerSettlement);
        if (!turn.sdkErrorEmitted) {
          sessionCtx.emitEvent({
            kind: "error",
            payload: { source: "sdk", message: formatProviderTerminalFailureMessage(failure, providerSettlement) },
          });
        }
        if (providerStopDisposition.kind === "terminal_reject") {
          terminalRejectionReason = providerStopDisposition.reason;
          sessionCtx.log(
            `codex app-server turn failed terminally; terminal rejecting delivery (${terminalRejectionReason}): ${turn.failure.message}`,
          );
        } else {
          consumedErrorReason = providerStopDisposition.reason;
          sessionCtx.log(
            `codex app-server turn failed terminally; consuming provider stop (${consumedErrorReason}): ${turn.failure.message}`,
          );
        }
      } else {
        const kind = classifyAppServerFailure(failure);
        retryReason = `codex_${kind}_failure`;
        sessionCtx.log(`codex app-server turn failed (${kind}): ${turn.failure.message}`);
      }
    } else if (!turn.providerCompleted) {
      const streamEndError: TurnErrorInfo = {
        message: "codex_app_server_stream_ended_without_completion",
        codexErrorInfo: null,
        additionalDetails: null,
      };
      const streamEndSettlement = recordAppServerFailureSignal(
        turn.providerAttempt,
        streamEndError,
        turn,
        turn.providerAttemptNumber,
      );
      const providerStopDisposition = streamEndSettlement
        ? acceptedTurnStopDisposition(streamEndError, streamEndSettlement)
        : null;
      if (streamEndSettlement?.decision.action === "retry") {
        emitProviderSettlementEvent(sessionCtx, streamEndSettlement);
        if (
          isExplicitTransientSettlement(streamEndSettlement) &&
          (streamEndSettlement.decision.replaySafety === "user_visible" || turn.providerRetryChain)
        ) {
          providerRetrySettlement = streamEndSettlement;
        } else {
          retryReason = "codex_app_server_stream_ended_without_completion";
        }
      } else if (streamEndSettlement && providerStopDisposition) {
        emitProviderSettlementEvent(sessionCtx, streamEndSettlement);
        sessionCtx.emitEvent({
          kind: "error",
          payload: {
            source: "sdk",
            message: formatProviderTerminalFailureMessage(streamEndError, streamEndSettlement),
          },
        });
        if (providerStopDisposition.kind === "terminal_reject") {
          terminalRejectionReason = providerStopDisposition.reason;
          sessionCtx.log(
            `codex app-server stream ended without completion; terminal rejecting delivery (${terminalRejectionReason})`,
          );
        } else {
          consumedErrorReason = providerStopDisposition.reason;
          sessionCtx.log(
            `codex app-server stream ended without completion; consuming provider stop (${consumedErrorReason})`,
          );
        }
      } else {
        retryReason = "codex_app_server_stream_ended_without_completion";
      }
    }

    if (usage) {
      sessionCtx.emitEvent({
        kind: "token_usage",
        payload: {
          provider: "codex",
          model: currentModel || "codex-default",
          inputTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens),
          cachedInputTokens: usage.cachedInputTokens,
          outputTokens: usage.outputTokens,
        },
      });
    }

    if (providerRetrySettlement) return providerRetrySettlement;

    if (terminalRejectionReason) {
      sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
      await turn.primaryToken.terminalRejected(turn.acceptedMessages, terminalRejectionReason, {
        kind: "server_terminal_record",
        recordId: turn.turnId,
      });
    } else {
      const settlement = resolveTurnSettlement({
        retryReason,
        consumedErrorReason,
        forwardFailed,
      });
      if (settlement.action.kind === "complete") {
        const isLandingTrial = isLandingCampaignTrialAgentMetadata(sessionCtx.agent.metadata);
        try {
          await emitTurnEnd(sessionCtx, {
            kind: "turn_end",
            payload: {
              status: settlement.status,
              ...(settlement.status === "success" && isLandingTrial
                ? { turnCompletionId: turnCompletionIdForMessages(turn.acceptedMessages) }
                : {}),
            },
          });
        } catch (err) {
          if (!(err instanceof LandingTrialTurnCompletionConfirmError)) throw err;
          sessionCtx.log(`landing trial turn completion confirmation failed after provider completion: ${err.message}`);
          turn.primaryToken.retry(turn.acceptedMessages, LANDING_TRIAL_TURN_COMPLETION_CONFIRM_FAILED);
          await closeAppServerAfterUncommittablePrefix(sessionCtx, LANDING_TRIAL_TURN_COMPLETION_CONFIRM_FAILED);
          return null;
        }
        await turn.primaryToken.complete(turn.acceptedMessages, settlement.action.outcome);
      } else {
        sessionCtx.emitEvent({ kind: "turn_end", payload: { status: settlement.status } });
        turn.primaryToken.retry(turn.acceptedMessages, settlement.action.reason);
        await closeAppServerAfterUncommittablePrefix(sessionCtx, settlement.action.reason);
        return null;
      }
    }
    schedulePendingDrain();
    return null;
  }

  function schedulePendingDrain(): void {
    if (pendingDrainScheduled || pendingDrainInProgress) return;
    if (providerRetryFence) return;
    if (pendingInputs.length === 0 || shutdownRequested) return;
    if (!appServer || !threadId) return;
    if (turnSettlementInProgress || turnStartInProgress) return;

    const turn = currentTurn;
    if (turn) {
      if (
        turn.status !== "inProgress" ||
        turn.appendRejectedInputGeneration === pendingInputGeneration ||
        turn.inFlightAppend
      ) {
        return;
      }
    } else if (startupTurnPending || currentTurnPromise) {
      return;
    }

    pendingDrainScheduled = true;
    setImmediate(() => {
      pendingDrainScheduled = false;
      void drainPendingInputs();
    });
  }

  async function drainPendingInputs(): Promise<void> {
    if (pendingDrainInProgress || pendingInputs.length === 0 || shutdownRequested) return;
    if (providerRetryFence) return;
    if (!appServer || !threadId) return;
    const sessionCtx = ctx;
    if (!sessionCtx) return;

    pendingDrainInProgress = true;
    try {
      const turn = currentTurn;
      if (turn && turn.status === "inProgress" && turn.appendRejectedInputGeneration !== pendingInputGeneration) {
        await appendPendingInputsToTurn(turn, sessionCtx);
        return;
      }
      if (!turn && !currentTurnPromise && !turnSettlementInProgress && !startupTurnPending && !turnStartInProgress) {
        await startTurnFromPendingInputs(sessionCtx);
      }
    } finally {
      pendingDrainInProgress = false;
      schedulePendingDrain();
    }
  }

  async function appendPendingInputsToTurn(turn: CurrentTurn, sessionCtx: SessionContext): Promise<void> {
    if (turn.inFlightAppend || pendingInputs.length === 0) return;
    const batch = pendingInputs.slice();
    const inputGeneration = pendingInputGeneration;
    const appendPromise = appendBatchToTurn(turn, batch, inputGeneration, sessionCtx);
    const trackedAppend = appendPromise.finally(() => {
      if (turn.inFlightAppend === trackedAppend) turn.inFlightAppend = null;
    });
    turn.inFlightAppend = trackedAppend;
    await trackedAppend;
  }

  async function appendBatchToTurn(
    turn: CurrentTurn,
    batch: readonly QueueEntry[],
    inputGeneration: number,
    sessionCtx: SessionContext,
  ): Promise<void> {
    const client = appServer;
    const activeThreadId = threadId;
    if (!client || !activeThreadId || batch.length === 0 || shutdownRequested) return;

    let text: string;
    try {
      text = await formatBatchInput(batch, sessionCtx, "inject");
    } catch (err) {
      removePendingPrefix(batch);
      await failCurrentTurnAfterUnknownSteer(
        turn,
        batch,
        "codex_queued_turn_format_failed",
        err,
        sessionCtx,
        "pending input could not be formatted; app-server session was closed before later input could pass it",
      );
      return;
    }

    if (currentTurn !== turn || turn.stopRequested || shutdownRequested) return;
    if (turn.status !== "inProgress" || turn.appendRejectedInputGeneration === pendingInputGeneration) {
      return;
    }

    try {
      await client.request("turn/steer", {
        threadId: activeThreadId,
        expectedTurnId: turn.turnId,
        input: [textInput(text)],
      });
      if (currentTurn !== turn || turn.stopRequested || shutdownRequested) {
        const reason = "codex_app_server_steer_unknown_custody_after_session_change";
        removePendingPrefix(batch);
        await failCurrentTurnAfterUnknownSteer(turn, batch, reason, "turn changed after turn/steer", sessionCtx);
        return;
      }
      removePendingPrefix(batch);
      turn.appendRejectedInputGeneration = null;
      for (const entry of batch) entry.token.processingStarted(entry.message);
      turn.acceptedMessages.push(...batch.map((entry) => entry.message));
    } catch (err) {
      if (shouldFallbackSteerToNextTurn(err)) {
        // The provider definitively did not accept this batch. Block only the
        // queue generation that was attempted: a later input (including one
        // that arrived while this request was in flight) re-opens one ordered
        // steer attempt instead of poisoning the rest of a long-running turn.
        turn.appendRejectedInputGeneration = inputGeneration;
        sessionCtx.log(
          `codex app-server turn/steer rejected without custody; pending generation ${inputGeneration} ` +
            `will retry after newer input or the next turn: ${err instanceof Error ? err.message : String(err)}`,
        );
        schedulePendingDrain();
      } else {
        const reason = isCodexAppServerTransientError(err)
          ? "codex_app_server_steer_unknown_custody_transient"
          : "codex_app_server_steer_unknown_custody_failed";
        removePendingPrefix(batch);
        await failCurrentTurnAfterUnknownSteer(turn, batch, reason, err, sessionCtx);
      }
    }
  }

  /**
   * Active-session config hot-switch for the Codex app-server: a thread reads
   * AGENTS.md once at init and never re-reads it, so a mid-session prompt change
   * would otherwise only land after a suspend/resume. Before an injected turn we
   * rebuild the briefing from the latest cached config; if it changed, rewrite
   * AGENTS.md and report so the caller prepends the re-read notice. Synchronous
   * It awaits the managed Skill settlement before rewriting the briefing. The
   * prompt and Skills are the targets; model / MCP hot-switch (which needs a
   * thread restart) stays out of scope.
   */
  async function refreshBriefingForActiveTurn(
    sessionCtx: SessionContext,
  ): Promise<{ fingerprint: string; changed: boolean } | null> {
    if (!agentConfigCache || !cwd || !threadId || !activeProviderEnv) return null;
    // Never throw: `startTurnFromPendingInputs` has already dequeued the batch
    // by the time this runs, so a thrown briefing rewrite would strand the
    // message (no turn/start, no token.retry). On any failure, skip the
    // hot-switch for this turn — the message still delivers under the prior
    // briefing, and the next injected turn retries the refresh.
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
      const briefing = projected.briefing;
      activePayload = payload;
      const fingerprint = computeBriefingFingerprint(briefing);
      if (readSessionBriefingFingerprint(cwd, threadId) === fingerprint) return { fingerprint, changed: false };
      return { fingerprint, changed: true };
    } catch (err) {
      if (isManagedSkillsUnsafeDiscoveryError(err)) throw err;
      sessionCtx.log(
        `active-session briefing refresh failed, delivering under prior briefing: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async function startTurnFromPendingInputs(sessionCtx: SessionContext): Promise<void> {
    if (pendingInputs.length === 0 || turnStartInProgress) return;
    const batch = pendingInputs.slice();
    const token = batch[0]?.token;
    if (!token) return;
    // Active-session hot-switch BEFORE formatting: the Team Skill command
    // registry fence rejects a message stamped with a newer config version,
    // and only this reconcile can publish the registry that lets a retried
    // turn succeed — formatting first would deadlock the turn on its own
    // fence.
    let refreshed: { fingerprint: string; changed: boolean } | null;
    try {
      refreshed = await refreshBriefingForActiveTurn(sessionCtx);
    } catch (error) {
      if (!isManagedSkillsUnsafeDiscoveryError(error)) throw error;
      // Settle the batch exactly once: release it from the pending queue
      // BEFORE handing custody to recovery, so the same input cannot be
      // processed twice.
      removePendingPrefix(batch);
      retryBatch(batch, "codex_managed_skills_unsafe");
      sessionCtx.log(`blocked provider turn: ${error.message}`);
      return;
    }
    if (refreshed?.changed && cwd) {
      const notice = buildBriefingUpdateNotice(join(cwd, "AGENTS.md"));
      pendingChatContextPrompt = pendingChatContextPrompt ? `${notice}\n\n${pendingChatContextPrompt}` : notice;
      sessionCtx.log(`Active session briefing changed — prepending re-read notice (${threadId})`);
    }
    let text: string;
    try {
      text = await formatBatchInput(batch, sessionCtx, "post-turn");
    } catch (err) {
      removePendingPrefix(batch);
      retryBatch(batch, "codex_queued_turn_format_failed");
      await closeAppServerAfterUnknownCustody(sessionCtx, "codex_queued_turn_format_failed", err);
      return;
    }
    removePendingPrefix(batch);
    void runTurnFromText(
      text,
      batch.map((entry) => entry.message),
      token,
      sessionCtx,
    )
      .then((delivered) => {
        if (refreshed?.changed && delivered && cwd && threadId) {
          writeSessionBriefingFingerprint(cwd, threadId, refreshed.fingerprint);
        }
      })
      .catch((err) => {
        sessionCtx.log(`codex app-server pending turn failed: ${err instanceof Error ? err.message : String(err)}`);
        token.retry(
          batch.map((entry) => entry.message),
          "codex_pending_turn_failed",
        );
      });
  }

  async function formatBatchInput(
    batch: readonly QueueEntry[],
    sessionCtx: SessionContext,
    label: "inject" | "post-turn",
  ): Promise<string> {
    const texts: string[] = [];
    for (const entry of batch) {
      try {
        texts.push(await sessionCtx.formatInboundContent(entry.message));
      } catch (err) {
        sessionCtx.log(
          `codex app-server ${label} formatInboundContent failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    }
    if (texts.length === 0) throw new Error("empty pending input batch");
    return texts.join("\n\n");
  }

  function removePendingPrefix(batch: readonly QueueEntry[]): void {
    if (batch.length === 0) return;
    if (batch.every((entry, index) => pendingInputs[index] === entry)) {
      pendingInputs.splice(0, batch.length);
      return;
    }
    for (const entry of batch) {
      const index = pendingInputs.indexOf(entry);
      if (index >= 0) pendingInputs.splice(index, 1);
    }
  }

  function retryBatch(batch: readonly QueueEntry[], reason: string): void {
    for (const entry of batch) entry.token.retry(entry.message, reason);
  }

  function retryQueuedMessages(reason: string): void {
    const queued = pendingInputs.splice(0);
    retryBatch(queued, reason);
  }

  async function interruptCurrentTurn(): Promise<void> {
    const turn = currentTurn;
    const client = appServer;
    if (!turn || !threadId || !client) return;
    turn.stopRequested = true;
    try {
      await client.request("turn/interrupt", { threadId, turnId: turn.turnId }, 2_000);
    } catch (err) {
      ctx?.log(`codex app-server turn interrupt failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      turn.resolveTerminal();
    }
  }

  function requireAppServer(): AppServerClientLike {
    if (!appServer) throw new CodexAppServerStartupError("client", "missing app-server client");
    return appServer;
  }

  return {
    async start(message, sessionCtx, token) {
      const deliveryToken = token;
      shutdownRequested = false;
      providerRetryFence = false;
      startupTurnPending = true;
      ctx = sessionCtx;
      try {
        const { payload, env, briefingFingerprint } = await prepareSession(sessionCtx);
        activePayload = payload;
        await startAppServer(sessionCtx, env);
        const id = await startThread(payload, sessionCtx);
        let input: string;
        try {
          input = await sessionCtx.formatInboundContent(message);
        } catch (err) {
          deliveryToken.retry(message, "codex_app_server_initial_format_failed");
          sessionCtx.log(
            `codex app-server initial formatInboundContent failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          return { sessionId: id, route: { kind: "owned", mode: "queued" } };
        }
        const delivered = await runTurnFromText(input, [message], deliveryToken, sessionCtx);
        // Fresh thread: seed the briefing baseline once the turn actually
        // delivered, so a later resume only nudges on a real briefing change.
        if (cwd && delivered) writeSessionBriefingFingerprint(cwd, id, briefingFingerprint);
        return { sessionId: id, route: { kind: "owned", mode: "processing" } };
      } finally {
        startupTurnPending = false;
        schedulePendingDrain();
      }
    },

    async resume(message, sessionId, sessionCtx, token) {
      const deliveryToken = message ? requireDeliveryToken(token, "messageful resume") : noopDeliveryToken();
      shutdownRequested = false;
      providerRetryFence = false;
      startupTurnPending = message !== undefined;
      ctx = sessionCtx;
      try {
        const { payload, env, briefingFingerprint } = await prepareSession(sessionCtx);
        activePayload = payload;
        // Briefing-staleness notice: a resumed Codex thread read AGENTS.md once
        // at thread init and never re-reads it. If the briefing changed since
        // this session last ran a turn — or there is no baseline (a session
        // predating this mechanism) — prepend a one-time re-read notice ahead of
        // the Current Chat Context that prepareSession just staged. The baseline
        // advances only after the turn runs, so a failed turn keeps it pending.
        const briefingChanged =
          message !== undefined &&
          cwd !== null &&
          readSessionBriefingFingerprint(cwd, sessionId) !== briefingFingerprint;
        if (briefingChanged && cwd) {
          const notice = buildBriefingUpdateNotice(join(cwd, "AGENTS.md"));
          pendingChatContextPrompt = pendingChatContextPrompt ? `${notice}\n\n${pendingChatContextPrompt}` : notice;
          sessionCtx.log(`Resume: briefing changed since last turn — prepending re-read notice (${sessionId})`);
        }
        await startAppServer(sessionCtx, env);
        let effectiveSessionId = sessionId;
        try {
          await resumeThread(sessionId, payload, sessionCtx);
        } catch (err) {
          if (!isCodexStaleRolloutError(err)) throw err;
          const staleThreadId = extractCodexStaleRolloutThreadId(err) ?? sessionId;
          effectiveSessionId = await startFreshThreadAfterStaleRollout(payload, sessionCtx, staleThreadId);
        }
        if (message) {
          let input: string;
          try {
            input = await sessionCtx.formatInboundContent(message);
          } catch (err) {
            deliveryToken.retry(message, "codex_app_server_initial_format_failed");
            sessionCtx.log(
              `codex app-server resume formatInboundContent failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            return { sessionId: effectiveSessionId, route: { kind: "owned", mode: "queued" } };
          }
          const delivered = await runTurnFromText(input, [message], deliveryToken, sessionCtx);
          effectiveSessionId = threadId ?? effectiveSessionId;
          // Advance the baseline ONLY when the notice-bearing turn actually
          // delivered; a retried / pre-provider turn leaves it for redelivery.
          if (cwd && delivered) writeSessionBriefingFingerprint(cwd, effectiveSessionId, briefingFingerprint);
        }
        return { sessionId: effectiveSessionId, route: message ? { kind: "owned", mode: "processing" } : null };
      } finally {
        startupTurnPending = false;
        schedulePendingDrain();
      }
    },

    inject(message, token) {
      if (!ctx || shutdownRequested) return { kind: "rejected", reason: "no_active_context", retryable: true };
      const deliveryToken = token;
      pendingInputs.push({ message, token: deliveryToken });
      pendingInputGeneration++;
      schedulePendingDrain();
      return { kind: "owned", mode: "queued" };
    },

    async suspend() {
      shutdownRequested = true;
      providerRetryFence = false;
      startupTurnPending = false;
      turnStartInProgress = false;
      cancelProviderRetryBackoff?.();
      retryQueuedMessages("codex_suspend_before_terminal");
      await interruptCurrentTurn();
      await appServer?.shutdown();
      appServer = null;
      activeProviderEnv = null;
      activePayload = null;
      pendingChatContextPrompt = null;
      workspaceOnly = false;
      workspaceOnlyCodexHome = null;
      workspaceOnlyHostHome = null;
      resetThreadUsageTracking(null);
    },

    async shutdown(reason?: string) {
      shutdownRequested = true;
      providerRetryFence = false;
      cancelProviderRetryBackoff?.();
      retryQueuedMessages(reason ?? "codex_shutdown_before_terminal");
      await interruptCurrentTurn();
      await appServer?.shutdown();
      appServer = null;
      activeProviderEnv = null;
      activePayload = null;
      currentTurn = null;
      currentTurnPromise = null;
      startupTurnPending = false;
      turnStartInProgress = false;
      pendingNotificationsByTurn.clear();
      cwd = null;
      threadId = null;
      ctx = null;
      pendingChatContextPrompt = null;
      workspaceOnly = false;
      workspaceOnlyCodexHome = null;
      workspaceOnlyHostHome = null;
      resetThreadUsageTracking(null);
    },
  } satisfies AgentHandler;
};

function defaultClientFactory(options: CodexAppServerClientOptions): Promise<AppServerClientLike> {
  return CodexAppServerClient.start(options);
}

function readClientFactory(value: unknown): AppServerClientFactory | null {
  if (typeof value !== "function") return null;
  // HandlerConfig is intentionally extension-shaped; the runtime does not know
  // test seams. Guard the callable shape before using it.
  return value as AppServerClientFactory;
}

function readRuntimeBinaryResolver(value: unknown): RuntimeBinaryResolver | null {
  if (typeof value !== "function") return null;
  // Same HandlerConfig extension seam as readClientFactory.
  return value as RuntimeBinaryResolver;
}

function textInput(text: string): JsonRecord {
  return { type: "text", text, text_elements: [] };
}

function extractThreadId(result: unknown): string | null {
  const root = asRecord(result);
  const thread = asRecord(root?.thread);
  return thread ? readString(thread, "id") : null;
}

function parseThreadTokenUsage(value: JsonRecord | null): ThreadTokenUsageSnapshot | null {
  const last = parseTokenUsageBreakdown(asRecord(value?.last));
  const total = parseTokenUsageBreakdown(asRecord(value?.total));
  if (!last || !total) return null;
  return { last, total };
}

function parseTokenUsageBreakdown(value: JsonRecord | null): TokenUsageBreakdown | null {
  if (!value) return null;
  return {
    totalTokens: readNumber(value, "totalTokens") ?? 0,
    inputTokens: readNumber(value, "inputTokens") ?? 0,
    cachedInputTokens: readNumber(value, "cachedInputTokens") ?? 0,
    outputTokens: readNumber(value, "outputTokens") ?? 0,
    reasoningOutputTokens: readNumber(value, "reasoningOutputTokens") ?? 0,
  };
}

function computeTurnUsageDelta(turn: CurrentTurn): TokenUsageBreakdown | null {
  if (turn.usageLatestTotal && turn.usageBaselineTotal) {
    return subtractTokenUsage(turn.usageLatestTotal, turn.usageBaselineTotal);
  }
  return cloneTokenUsage(turn.usageLastSum);
}

function emptyTokenUsage(): TokenUsageBreakdown {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function cloneTokenUsage(usage: TokenUsageBreakdown | null): TokenUsageBreakdown | null {
  return usage ? { ...usage } : null;
}

function addTokenUsage(left: TokenUsageBreakdown, right: TokenUsageBreakdown): TokenUsageBreakdown {
  return {
    totalTokens: left.totalTokens + right.totalTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
  };
}

function subtractTokenUsage(current: TokenUsageBreakdown, baseline: TokenUsageBreakdown): TokenUsageBreakdown {
  return {
    totalTokens: Math.max(0, current.totalTokens - baseline.totalTokens),
    inputTokens: Math.max(0, current.inputTokens - baseline.inputTokens),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - baseline.cachedInputTokens),
    outputTokens: Math.max(0, current.outputTokens - baseline.outputTokens),
    reasoningOutputTokens: Math.max(0, current.reasoningOutputTokens - baseline.reasoningOutputTokens),
  };
}

function parseTurnError(value: unknown): TurnErrorInfo | null {
  const record = asRecord(value);
  if (!record) return null;
  const message = readString(record, "message");
  if (!message) return null;
  return {
    message,
    codexErrorInfo: record.codexErrorInfo ?? null,
    additionalDetails: readString(record, "additionalDetails"),
  };
}

function mergeFailureWithDiagnostic(failure: TurnErrorInfo, diagnostic: TurnErrorInfo | null): TurnErrorInfo {
  if (!diagnostic) return failure;
  const details = [failure.additionalDetails, diagnostic.message, diagnostic.additionalDetails]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
  return {
    message: failure.message,
    codexErrorInfo: failure.codexErrorInfo ?? diagnostic.codexErrorInfo,
    additionalDetails: details || null,
  };
}

function completedEmptyCompactFailureInfo(turn: CurrentTurn, stderr: string): TurnErrorInfo | null {
  const details = [turn.lastSdkError?.message, turn.lastSdkError?.additionalDetails, stderr]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
  if (!details) return null;

  const diagnostic: TurnErrorInfo = {
    message: "codex app-server completed without output after pre-sampling compact failure",
    codexErrorInfo: turn.lastSdkError?.codexErrorInfo ?? null,
    additionalDetails: details,
  };
  if (isDeterministicCompactFailure(diagnostic)) return diagnostic;
  if (isPreSamplingCompactFailureText(details)) return diagnostic;
  return null;
}

function formatAppServerError(message: string): string {
  if (isCodexAuthError(message)) return formatAuthHint("codex", message);
  return message;
}

function formatProviderTerminalFailureMessage(error: TurnErrorInfo, settlement: ProviderAttemptSettlement): string {
  if (settlement.classification.category === "deterministic_input") {
    return formatDeterministicFailureMessage(errorInfoForSettlement(error, settlement));
  }
  return formatAppServerError(providerErrorPreview(error));
}

function errorInfoForSettlement(error: TurnErrorInfo, settlement: ProviderAttemptSettlement): TurnErrorInfo {
  if (settlement.classification.category !== "deterministic_input" || isContextWindowFailure(error)) return error;
  return {
    message: settlement.messagePreview,
    codexErrorInfo: error.codexErrorInfo,
    additionalDetails: error.additionalDetails,
  };
}

function classifyAppServerFailure(error: TurnErrorInfo): "deterministic" | "transient" | "unknown" {
  if (
    isCodexAuthError(error.message) ||
    isDeterministicErrorInfo(error.codexErrorInfo) ||
    isDeterministicCompactFailure(error)
  ) {
    return "deterministic";
  }
  if (isTransientCodexErrorMessage(error.message) || isTransientErrorInfo(error.codexErrorInfo)) return "transient";
  return "unknown";
}

function deterministicTerminalRejectionReason(error: TurnErrorInfo): string {
  if (isContextWindowFailure(error)) return "codex_context_window_exceeded";
  if (isPreSamplingCompactFailure(error)) return "codex_compact_failure";
  if (isCodexAuthError(error.message) || error.codexErrorInfo === "unauthorized") return "codex_auth_failure";
  if (error.codexErrorInfo === "badRequest") return "codex_bad_request_failure";
  if (error.codexErrorInfo === "sandboxError") return "codex_sandbox_failure";
  if (error.codexErrorInfo === "cyberPolicy") return "codex_cyber_policy_failure";
  return "codex_deterministic_failure";
}

function formatDeterministicFailureMessage(error: TurnErrorInfo): string {
  if (isContextWindowFailure(error)) return CODEX_CONTEXT_WINDOW_FAILURE_MESSAGE;
  if (isPreSamplingCompactFailure(error)) return CODEX_COMPACT_FAILURE_MESSAGE;
  return formatAppServerError(error.message);
}

type ProviderClassifiableError = Error & {
  reason?: string;
  code?: string;
};

function providerErrorFromTurnErrorInfo(error: TurnErrorInfo): Error {
  const out = new Error(providerErrorPreview(error)) as ProviderClassifiableError;
  if (typeof error.codexErrorInfo === "string") {
    out.reason = error.codexErrorInfo;
    out.code = error.codexErrorInfo;
  }
  return out;
}

function providerErrorPreview(error: TurnErrorInfo): string {
  return [error.message, error.additionalDetails].filter((part): part is string => Boolean(part)).join("\n");
}

function isContextWindowFailure(error: TurnErrorInfo): boolean {
  return error.codexErrorInfo === "contextWindowExceeded" || isDeterministicCompactFailure(error);
}

function isDeterministicCompactFailure(error: TurnErrorInfo): boolean {
  const text = `${error.message}\n${error.additionalDetails ?? ""}`.toLowerCase();
  if (text.includes("contextwindowexceeded") || text.includes("context_length_exceeded")) return true;
  if (text.includes("ran out of room") && text.includes("context window")) return true;

  const compactFailure =
    text.includes("failed to run pre-sampling compact") ||
    text.includes("error running remote compact task") ||
    text.includes("remote compact");
  const contextFailure = text.includes("context window") || text.includes("context length");
  return compactFailure && contextFailure;
}

function isPreSamplingCompactFailure(error: TurnErrorInfo): boolean {
  return isPreSamplingCompactFailureText(`${error.message}\n${error.additionalDetails ?? ""}`);
}

function isPreSamplingCompactFailureText(value: string): boolean {
  return value.toLowerCase().includes("failed to run pre-sampling compact");
}

function isUsageLimitErrorInfo(value: unknown): boolean {
  return value === "usageLimitExceeded";
}

function isDeterministicErrorInfo(value: unknown): boolean {
  return (
    value === "contextWindowExceeded" ||
    value === "unauthorized" ||
    value === "badRequest" ||
    value === "sandboxError" ||
    value === "cyberPolicy"
  );
}

function isTransientErrorInfo(value: unknown): boolean {
  if (value === "serverOverloaded" || value === "internalServerError") return true;
  const record = asRecord(value);
  if (!record) return false;
  return (
    "httpConnectionFailed" in record ||
    "responseStreamConnectionFailed" in record ||
    "responseStreamDisconnected" in record
  );
}

function shouldFallbackSteerToNextTurn(err: unknown): boolean {
  const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (
    message.includes("no active turn") ||
    message.includes("expectedturnid") ||
    message.includes("expected turn") ||
    message.includes("turn mismatch") ||
    message.includes("active turn not steerable") ||
    message.includes("activeturnnotsteerable")
  ) {
    return true;
  }
  if (err instanceof CodexAppServerRpcError) {
    return containsActiveTurnNotSteerable(err.data);
  }
  return false;
}

function containsActiveTurnNotSteerable(value: unknown): boolean {
  if (value === "activeTurnNotSteerable") return true;
  if (Array.isArray(value)) return value.some((item) => containsActiveTurnNotSteerable(item));
  const record = asRecord(value);
  if (!record) return false;
  return Object.entries(record).some(
    ([key, nested]) => key === "activeTurnNotSteerable" || containsActiveTurnNotSteerable(nested),
  );
}

function toolStatus(value: unknown): "ok" | "error" | "pending" {
  if (value === "completed") return "ok";
  if (value === "failed" || value === "declined") return "error";
  return "pending";
}

function contextTreeTargetPathOf(
  filePath: string,
  attribution: ContextTreeAttribution,
  workspaceCwd: string,
): string | null {
  const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(workspaceCwd, filePath);
  const rel = resolveContextTreeRelativePath(absolutePath, attribution);
  return rel === null || rel === "/" ? null : rel;
}

function toolFileRefsFromAppServerFileChange(input: {
  changes: unknown;
  workspaceCwd: string;
  contextTreePath: string | null;
  contextTreeRepoUrl: string | null;
  contextTreeBranch?: string | null;
}): ToolFileRef[] {
  const refs: ToolFileRef[] = [];
  const seen = new Set<string>();
  for (const filePath of collectCodexFileChangePaths(input.changes)) {
    const fileKey = isAbsolute(filePath) ? filePath : resolve(input.workspaceCwd, filePath);
    if (seen.has(fileKey)) continue;
    seen.add(fileKey);
    const repoRelativePath = contextTreeTargetPathOf(
      filePath,
      { contextTreePath: input.contextTreePath, contextTreeRepoUrl: input.contextTreeRepoUrl },
      input.workspaceCwd,
    );
    refs.push({
      origin: "file_change",
      localPath: filePath,
      pathKind: "file",
      ...(input.contextTreeRepoUrl && repoRelativePath
        ? {
            repoUrl: input.contextTreeRepoUrl,
            ...(input.contextTreeBranch ? { repoBranch: input.contextTreeBranch } : {}),
            repoRelativePath,
          }
        : {}),
    });
  }
  return refs;
}

function toolFileRefsForTerminalTool(input: {
  status: "ok" | "error" | "pending";
  existingRefs?: readonly ToolFileRef[];
  gitWriteTracker?: ContextTreeGitWriteTracker | null;
  toolName: string;
  toolUseId: string;
}): ToolFileRef[] | undefined {
  if (input.status !== "ok") {
    if (input.status === "error") input.gitWriteTracker?.captureBaseline();
    return undefined;
  }
  const existingRefs = [...(input.existingRefs ?? [])];
  const gitStatusRefs =
    input.gitWriteTracker?.refsForSuccessfulToolCall({
      toolName: input.toolName,
      toolUseId: input.toolUseId,
      existingRefs,
    }) ?? [];
  const refs = [...existingRefs, ...gitStatusRefs];
  return refs.length > 0 ? refs : undefined;
}

function readString(record: JsonRecord | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function readNumber(record: JsonRecord, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): JsonRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  // App-server payloads enter as unknown JSON; all individual fields are
  // narrowed before use.
  return value as JsonRecord;
}
