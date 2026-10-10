import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
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
import type { AgentConfigCache, ProviderAttemptSettlement } from "../../runtime/provider-support/index.js";
import {
  assertContextSourceCurrent,
  buildBriefingUpdateNotice,
  classifyProviderFailure,
  computeBriefingFingerprint,
  contextSourceFromHandlerConfig,
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
import { formatAuthHint, isDeepseekAuthError } from "../handlers/auth-error-hint.js";
import { consumedErrorOutcome } from "../handlers/turn-settlement.js";
import { PROVIDER_SKILL_ROOTS } from "../skill-roots.js";
import { publicDeepseekAuthFailure, sanitizeDeepseekAuthFailureText } from "./auth-failure.js";
import {
  deepseekLaunchFingerprint,
  deepseekSessionRoot,
  resolveDeepseekModel,
  resolveDeepseekRuntimeBinary,
} from "./binary.js";
import { classifyDeepseekRunFailure, mapDeepseekSessionEvent, sessionEventFromNotification } from "./events.js";

export const DEEPSEEK_PENDING_SESSION_PREFIX = "deepseek-harness-pending-";

export function isDeepseekPendingSessionId(sessionId: string): boolean {
  return sessionId.startsWith(DEEPSEEK_PENDING_SESSION_PREFIX);
}

const DEFAULT_TURN_TIMEOUT_MS = 20 * 60_000;
const PROVIDER_ATTEMPT_WINDOW_TTL_MS = 30 * 60_000;
const MAX_PROVIDER_ATTEMPT_WINDOWS = 512;
const QUEUED_UNSAFE_DISCOVERY_RETRY_BASE_MS = 1_000;
const QUEUED_UNSAFE_DISCOVERY_RETRY_MAX_MS = 30_000;

type DeepseekHarnessLike = Pick<DeepSeekHarness, "start" | "session" | "close">;
type DeepseekHarnessFactory = (options: ConstructorParameters<typeof DeepSeekHarness>[0]) => DeepseekHarnessLike;

type ProviderTurnFailureWindow = {
  attempt: number;
  touchedAt: number;
  hasPendingDelivery: () => boolean;
};

const providerTurnFailureAttempts = new Map<string, ProviderTurnFailureWindow>();

export function clearDeepseekAttemptCacheForTests(): void {
  providerTurnFailureAttempts.clear();
}

type DeepseekRetrySleep = (delayMs: number, signal: AbortSignal) => Promise<boolean | undefined>;
type QueuedDelivery = { message: SessionMessage; token: DeliveryToken };

type TurnObservation = {
  assistantText: string;
  sawProviderActivity: boolean;
  sawUnsafeTool: boolean;
  events: SessionEvent[];
};

async function defaultDeepseekRetrySleep(delayMs: number, signal: AbortSignal): Promise<boolean> {
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

function isReadOnlyTool(name: string): boolean {
  return /^(read|grep|glob|list|search)$/i.test(name);
}

export const createDeepseekHandler: HandlerFactory = (config) => {
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
  const resolveRuntime =
    (config.deepseekRuntimeResolver as typeof resolveDeepseekRuntimeBinary | undefined) ?? resolveDeepseekRuntimeBinary;
  const createHarness =
    (config.deepseekHarnessFactory as DeepseekHarnessFactory | undefined) ??
    ((options) => new DeepSeekHarness(options));
  const turnTimeoutMs =
    typeof config.deepseekTurnTimeoutMs === "number" && config.deepseekTurnTimeoutMs > 0
      ? config.deepseekTurnTimeoutMs
      : DEFAULT_TURN_TIMEOUT_MS;
  const retrySleep = (config.deepseekRetrySleep as DeepseekRetrySleep | undefined) ?? defaultDeepseekRetrySleep;
  const unsafeDiscoverySleep =
    (config.deepseekUnsafeDiscoverySleep as DeepseekRetrySleep | undefined) ?? defaultDeepseekRetrySleep;

  let cwd: string | null = null;
  let ctx: SessionContext | null = null;
  let activeConfig: AgentRuntimeConfig | null = null;
  let runtimeBinary: string | null = null;
  let cordisPath: string | null = null;
  let harness: DeepseekHarnessLike | null = null;
  let harnessLaunchFingerprint: string | null = null;
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
    if (!deliveryHead) throw new Error("DeepSeek provider attempt requires a delivery head");
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
      if (!abandoned) throw new Error("DeepSeek provider attempt ledger is full of pending deliveries");
      providerTurnFailureAttempts.delete(abandoned[0]);
    }
    providerTurnFailureAttempts.delete(attemptKey);
    providerTurnFailureAttempts.set(attemptKey, { attempt, touchedAt: now, hasPendingDelivery });
    return attempt;
  }

  function buildEnv(
    sessionCtx: SessionContext,
    payload: AgentRuntimeConfigPayload,
    workspaceCwd: string,
  ): Record<string, string> {
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
    env.DSH_SESSION_ROOT = deepseekSessionRoot(workspaceCwd);
    env.DSH_SKILLS_ROOT = PROVIDER_SKILL_ROOTS["deepseek-harness"];
    env.DSH_MODEL = resolveDeepseekModel(payload.model);
    return env;
  }

  async function refreshProjection(sessionCtx: SessionContext): Promise<{
    payload: AgentRuntimeConfigPayload;
    briefing: string;
  }> {
    if (!cwd) throw new Error("DeepSeek workspace is not prepared");
    let runtimeConfig = activeConfig;
    const existingPayload = activeConfig?.payload;
    if (agentConfigCache) {
      runtimeConfig = await agentConfigCache.refresh(sessionCtx.agent.agentId);
    }
    const payload: AgentRuntimeConfigPayload =
      runtimeConfig?.payload ??
      ({
        kind: "deepseek-harness",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      } satisfies AgentRuntimeConfigPayload);
    if (payload.kind !== "deepseek-harness") {
      throw new Error(`DeepSeek handler received ${payload.kind} runtime config`);
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

  async function closeHarness(): Promise<void> {
    const activeHarness = harness;
    harness = null;
    harnessLaunchFingerprint = null;
    if (!activeHarness) return;
    try {
      await activeHarness.close();
    } catch {
      // Best-effort teardown; a stuck child is reaped on process exit.
    }
  }

  async function ensureHarness(
    sessionCtx: SessionContext,
    payload: AgentRuntimeConfigPayload,
    workspaceCwd: string,
  ): Promise<DeepseekHarnessLike> {
    if (!runtimeBinary || !cordisPath) throw new Error("DeepSeek runtime is not resolved");
    const fingerprint = deepseekLaunchFingerprint(payload);
    if (harness && harnessLaunchFingerprint === fingerprint) return harness;
    if (harness) await closeHarness();

    mkdirSync(deepseekSessionRoot(workspaceCwd), { recursive: true, mode: 0o700 });
    const env = buildEnv(sessionCtx, payload, workspaceCwd);
    const launch =
      runtimeBinary.endsWith(".js") || runtimeBinary.endsWith(".mjs")
        ? { command: process.execPath, args: [runtimeBinary, cordisPath] }
        : { command: runtimeBinary, args: [cordisPath] };
    const created = createHarness({
      launch: {
        ...launch,
        // Agent workspace is the initialize cwd; plugin packages resolve via
        // packaged-bin's bareModuleBaseUrl (the installed CLI/client closure).
        cwd: workspaceCwd,
        env,
        requestTimeoutMs: turnTimeoutMs,
      },
      cwd: workspaceCwd,
      provider: "deepseek-official",
      model: resolveDeepseekModel(payload.model),
    });
    // Publish before awaiting start so an abort/timeout can close/reap a hung boot.
    harness = created;
    harnessLaunchFingerprint = fingerprint;
    try {
      await created.start();
    } catch (error) {
      await closeHarness();
      throw error;
    }
    return created;
  }

  function adoptSessionId(sessionCtx: SessionContext, id: string): void {
    if (providerSessionId === id) return;
    const synthetic = pendingSyntheticId;
    providerSessionId = id;
    if (synthetic) {
      pendingSyntheticId = null;
      sessionCtx.replaceSessionId?.(id, "deepseek_session_id_confirmed");
      if (cwd) {
        const baseline = readSessionBriefingFingerprint(cwd, synthetic);
        if (baseline) writeSessionBriefingFingerprint(cwd, id, baseline);
      }
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
    const write = /^(edit|write|create_file|edit_file|write_file)$/i.test(name);
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

  function handleSessionEvent(event: SessionEvent, state: TurnObservation, sessionCtx: SessionContext): void {
    state.events.push(event);
    sessionCtx.recordProviderActivity();
    state.sawProviderActivity = true;
    const mapped = mapDeepseekSessionEvent(event);
    switch (mapped.kind) {
      case "text_delta":
        if (mapped.text) {
          state.assistantText += mapped.text;
          for (const chunk of chunkAssistantText(mapped.text)) {
            sessionCtx.emitEvent({ kind: "assistant_text", payload: { text: chunk } });
          }
        }
        break;
      case "reasoning_delta":
        sessionCtx.emitEvent({ kind: "thinking", payload: {} });
        break;
      case "assistant_message":
        if (mapped.text && mapped.text.length > state.assistantText.length) {
          const delta = mapped.text.slice(state.assistantText.length);
          state.assistantText = mapped.text;
          for (const chunk of chunkAssistantText(delta)) {
            sessionCtx.emitEvent({ kind: "assistant_text", payload: { text: chunk } });
          }
        }
        break;
      case "tool_call":
        if (mapped.toolName && !isReadOnlyTool(mapped.toolName)) state.sawUnsafeTool = true;
        if (mapped.toolCallId && mapped.toolName) {
          const toolFileRefs = fileRefsForTool(mapped.toolName, mapped.toolArgs);
          sessionCtx.emitEvent({
            kind: "tool_call",
            payload: {
              toolUseId: mapped.toolCallId,
              name: mapped.toolName,
              args: mapped.toolArgs ?? {},
              status: "pending",
              ...(toolFileRefs ? { toolFileRefs } : {}),
            },
          });
        }
        break;
      case "tool_result":
        if (mapped.toolCallId) {
          sessionCtx.emitEvent({
            kind: "tool_call",
            payload: {
              toolUseId: mapped.toolCallId,
              name: "deepseek-tool",
              args: {},
              status: mapped.toolFailed ? "error" : "ok",
              ...(mapped.toolPreview ? { resultPreview: mapped.toolPreview } : {}),
            },
          });
        }
        break;
      case "turn_end":
      case "unknown":
        break;
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
    state: Pick<TurnObservation, "sawProviderActivity" | "sawUnsafeTool" | "assistantText">;
    sessionCtx: SessionContext;
    messages: readonly SessionMessage[];
    token: DeliveryToken;
    turnGeneration: number;
    spawnError?: Error;
  }): Promise<boolean> {
    const attemptKey = deliveryAttemptKey(input.sessionCtx, input.messages);
    const replaySafety = input.state.sawUnsafeTool
      ? "unsafe"
      : input.state.assistantText.length > 0
        ? "user_visible"
        : input.state.sawProviderActivity
          ? "pre_visible"
          : "pre_provider";
    const authFailure = isDeepseekAuthError(input.failure);
    const displayMessage = authFailure
      ? formatAuthHint("deepseek-harness", sanitizeDeepseekAuthFailureText(input.failure))
      : input.failure;
    const attempt = new ProviderAttempt({
      provider: runtimeProvider,
      scope: "provider_turn",
      source: input.spawnError ? "sdk" : authFailure ? "auth" : "stream",
      replaySafety,
    });
    attempt.recordSignal({
      // Auth failures stay `provider_error`; classification comes from source/message
      // (ProviderAttemptSignalKind has no `auth_error` variant).
      kind: input.spawnError ? "local_error" : "provider_error",
      error: input.spawnError ?? input.failure,
      messagePreview: authFailure ? publicDeepseekAuthFailure(input.failure) : displayMessage,
    });
    const attemptNumber = nextProviderAttempt(
      attemptKey,
      () => input.sessionCtx.hasPendingDelivery?.(input.messages) ?? true,
    );
    const settlement = attempt.settle({ attempt: attemptNumber });
    if (!settlement) {
      input.token.retry(input.messages, "deepseek_unclassified_failure");
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
        input.sessionCtx.failSessionForRecovery?.("deepseek_turn_retryable_failure", providerSessionId ?? undefined);
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
    if (!workspaceCwd || !sessionActive) {
      token.retry(messages, sessionActive ? "deepseek_not_prepared" : "deepseek_session_inactive");
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
          token.retry(messages, "deepseek_unsafe_skill_discovery");
          return false;
        }
        throw error;
      }
      if (payload.mcpServers.length > 0) {
        return settleFailure({
          failure:
            "deepseek_mcp_unsupported: Managed MCP servers are not supported for the DeepSeek Harness provider in V1.",
          state: { assistantText: "", sawProviderActivity: false, sawUnsafeTool: false },
          sessionCtx,
          messages,
          token,
          turnGeneration,
        });
      }
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
      const state: TurnObservation = {
        assistantText: "",
        sawProviderActivity: false,
        sawUnsafeTool: false,
        events: [],
      };
      token.processingStarted(messages);
      const timeout = setTimeout(() => abort.abort(), turnTimeoutMs);
      timeout.unref?.();
      const onAbortClose = () => {
        void closeHarness();
      };
      abort.signal.addEventListener("abort", onAbortClose, { once: true });

      try {
        const activeHarness = await ensureHarness(sessionCtx, payload, workspaceCwd);
        if (abort.signal.aborted || generation !== turnGeneration || !sessionActive) {
          await closeHarness();
          return settleFailure({
            failure: "DeepSeek turn aborted or timed out before a safe terminal event",
            spawnError: new Error("DeepSeek turn aborted or timed out"),
            state,
            sessionCtx,
            messages,
            token,
            turnGeneration,
          });
        }
        // Amp posture: only a confirmed provider session id may be supplied.
        // Pending local ids stay local until the SDK returns a real id.
        const sessionHandle = activeHarness.session(expectedSessionId ?? undefined);
        // Persist the SDK-allocated id before run() so a transport/timeout
        // failure still resumes the same provider-native session.
        adoptSessionId(sessionCtx, sessionHandle.id);
        const result = await sessionHandle.run(providerPrompt, {
          onNotification: (notification) => {
            if (abort.signal.aborted || generation !== turnGeneration) return;
            const event = sessionEventFromNotification(notification);
            if (event) handleSessionEvent(event, state, sessionCtx);
          },
        });

        if (abort.signal.aborted || generation !== turnGeneration || !sessionActive) {
          return settleFailure({
            failure: "DeepSeek turn aborted or timed out before a safe terminal event",
            spawnError: new Error("DeepSeek turn aborted or timed out"),
            state,
            sessionCtx,
            messages,
            token,
            turnGeneration,
          });
        }

        for (const event of result.events) {
          if (!state.events.includes(event)) handleSessionEvent(event, state, sessionCtx);
        }

        const failure = classifyDeepseekRunFailure({
          finalResponse: result.finalResponse,
          events: result.events,
          aborted: false,
        });
        const finalText = result.finalResponse.trim().length > 0 ? result.finalResponse : state.assistantText;
        if (!failure) {
          adoptSessionId(sessionCtx, result.sessionId);
          if (finalText.length > 0 && state.assistantText.length === 0) {
            for (const chunk of chunkAssistantText(finalText)) {
              sessionCtx.emitEvent({ kind: "assistant_text", payload: { text: chunk } });
            }
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

        const sanitizedFailure = redactErrorPreview(
          isDeepseekAuthError(failure) ? publicDeepseekAuthFailure(failure) : failure,
          800,
        );
        return settleFailure({
          failure: sanitizedFailure,
          state,
          sessionCtx,
          messages,
          token,
          turnGeneration,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return settleFailure({
          failure: message,
          spawnError: error instanceof Error ? error : new Error(message),
          state,
          sessionCtx,
          messages,
          token,
          turnGeneration,
        });
      } finally {
        abort.signal.removeEventListener("abort", onAbortClose);
        clearTimeout(timeout);
      }
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
        "DeepSeek Harness is not supported on Windows in v1 until the client-wide pre-admission Job Object supervisor is available.",
      );
    }
    ctx = sessionCtx;
    const resolution = resolveRuntime(process.env);
    if (!resolution.ok) throw new Error(resolution.error);
    runtimeBinary = resolution.binary;
    cordisPath = resolution.cordisPath;
    sessionCtx.log(`DeepSeek Harness binary: ${resolution.binary}`);

    let runtimeConfig = activeConfig;
    if (agentConfigCache) {
      runtimeConfig = await agentConfigCache.refresh(sessionCtx.agent.agentId);
    }
    const payload: AgentRuntimeConfigPayload =
      runtimeConfig?.payload ??
      ({
        kind: "deepseek-harness",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      } satisfies AgentRuntimeConfigPayload);
    if (payload.kind !== "deepseek-harness") {
      throw new Error(`DeepSeek handler received ${payload.kind} runtime config`);
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
          `DeepSeek queued turn blocked by unsafe managed-skill discovery; retrying in ${delayMs}ms: ${classification.message}`,
        );
        const waitAbort = new AbortController();
        unsafeDiscoveryWaitAbort = waitAbort;
        const completedDelay = await unsafeDiscoverySleep(delayMs, waitAbort.signal);
        if (unsafeDiscoveryWaitAbort === waitAbort) unsafeDiscoveryWaitAbort = null;
        if (!completedDelay) {
          if (!drainCancellationReason && sessionActive && drainingBatch === drained) {
            throw new Error("DeepSeek queued unsafe-discovery wait ended without lifecycle cancellation");
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
          sessionCtx.log(`DeepSeek queued turn failed: ${error instanceof Error ? error.message : String(error)}`);
          retryDrainingBatch(drained, "deepseek_queued_turn_failed");
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
      if (!providerSessionId) pendingSyntheticId = `${DEEPSEEK_PENDING_SESSION_PREFIX}${randomUUID()}`;
      const sessionId = providerSessionId ?? pendingSyntheticId;
      if (!sessionId) throw new Error("DeepSeek session id unresolved");
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
      if (isDeepseekPendingSessionId(sessionId)) {
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
      const recoveryReason = reason ?? "deepseek_suspend_before_terminal";
      sessionActive = false;
      drainCancellationReason = recoveryReason;
      generation++;
      currentAbort?.abort();
      unsafeDiscoveryWaitAbort?.abort();
      // Close/reap before joining the turn so a hung HarnessSession.run cannot
      // strand suspend/client drain indefinitely.
      await closeHarness();
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
      const recoveryReason = reason ?? "deepseek_shutdown_before_terminal";
      sessionActive = false;
      drainCancellationReason = recoveryReason;
      generation++;
      currentAbort?.abort();
      unsafeDiscoveryWaitAbort?.abort();
      await closeHarness();
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
      runtimeBinary = null;
      cordisPath = null;
      providerSessionId = null;
      pendingSyntheticId = null;
      initialTurnPreparing = false;
      pendingChatContextPrompt = null;
      queue.length = 0;
      providerTurnFailureAttempts.clear();
    },
  } satisfies AgentHandler;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
