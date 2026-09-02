import { randomUUID } from "node:crypto";
import {
  type AgentRuntimeConfig,
  type AgentRuntimeConfigPayload,
  encodeProviderRetryEventMessage,
  isLandingCampaignTrialAgentMetadata,
  runtimeProviderSchema,
} from "@first-tree/shared";
import type {
  AgentHandler,
  DeliveryToken,
  HandlerFactory,
  SessionContext,
  SessionMessage,
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
  renderChatContextPrompt,
  renderRuntimeOutputContract,
  writeSessionBriefingFingerprint,
} from "../../runtime/provider-support/index.js";
import { chunkAssistantText } from "../handlers/assistant-text.js";
import { formatAuthHint } from "../handlers/auth-error-hint.js";
import { consumedErrorOutcome } from "../handlers/turn-settlement.js";
import { PROVIDER_SKILL_ROOTS } from "../skill-roots.js";
import { buildZcodeTurnArgs, resolveZcodeRuntimeBinary, type ZcodeRuntimeBinaryResolution } from "./binary.js";
import { parseZcodeJsonOutput } from "./json.js";
import { officialRuntimeLabel, officialRuntimeLoginCommand } from "./official-runtime.js";

export const ZCODE_PENDING_SESSION_PREFIX = "zcode-pending-";
const DEFAULT_TURN_TIMEOUT_MS = 20 * 60_000;
const STDERR_TAIL_LIMIT = 8_000;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const KILL_GRACE_MS = 5_000;
const FINAL_CLOSE_WAIT_MS = 2_000;
const TERMINATION_POLL_MS = 25;
const PROVIDER_ATTEMPT_WINDOW_TTL_MS = 30 * 60_000;
const MAX_PROVIDER_ATTEMPT_WINDOWS = 512;

export function isZcodePendingSessionId(sessionId: string): boolean {
  return sessionId.startsWith(ZCODE_PENDING_SESSION_PREFIX);
}

type QueuedDelivery = { message: SessionMessage; token: DeliveryToken };
type ProviderTurnFailureWindow = {
  attempt: number;
  touchedAt: number;
  hasPendingDelivery: () => boolean;
};

const providerTurnFailureAttempts = new Map<string, ProviderTurnFailureWindow>();

export function clearZcodeAttemptCacheForTests(): void {
  providerTurnFailureAttempts.clear();
}

type ProcessOutcome = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderrTail: string;
  spawnError?: Error;
};

type ZcodeRetrySleep = (delayMs: number, signal: AbortSignal) => Promise<boolean | undefined>;

async function defaultZcodeRetrySleep(delayMs: number, signal: AbortSignal): Promise<boolean> {
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

function isAuthError(text: string): boolean {
  return /authentication required|not (?:authenticated|logged in)|unauthorized|invalid api key|login required|provider_not_configured|model provider is missing an api key|missing an api key|model config is missing|explicit model provider/i.test(
    text,
  );
}

export type BoundedZcodeStdout = {
  parts: Buffer[];
  length: number;
  overflow: boolean;
};

export function appendZcodeStdoutChunk(
  state: BoundedZcodeStdout,
  chunk: string | Buffer,
  maximumBytes: number = MAX_STDOUT_BYTES,
): void {
  if (state.overflow) return;
  const value = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
  const remaining = maximumBytes - state.length;
  if (remaining <= 0) {
    state.overflow = true;
    return;
  }
  const boundedChunk = value.length > remaining ? value.subarray(0, remaining) : value;
  state.parts.push(boundedChunk);
  state.length += boundedChunk.length;
  state.overflow = value.length > boundedChunk.length;
}

export const createZcodeHandler: HandlerFactory = (config) => {
  const workspaceRoot = config.workspaceRoot as string;
  const agentName = typeof config.agentName === "string" ? config.agentName : "";
  const runtimeProvider = runtimeProviderSchema.parse(config.runtimeProvider);
  const agentConfigCache = (config.agentConfigCache as AgentConfigCache | undefined) ?? null;
  const contextSource = contextSourceFromHandlerConfig(config);
  const contextTree = preparationCoordinatesFromSource(contextSource);
  const resolveBinary =
    (config.zcodeBinaryResolver as ((env?: NodeJS.ProcessEnv) => Promise<ZcodeRuntimeBinaryResolution>) | undefined) ??
    resolveZcodeRuntimeBinary;
  const processSupervisor =
    (config.providerProcessSupervisor as ProviderProcessSupervisor | undefined) ??
    createDefaultProviderProcessSupervisor();
  const turnTimeoutMs =
    typeof config.zcodeTurnTimeoutMs === "number" && config.zcodeTurnTimeoutMs > 0
      ? config.zcodeTurnTimeoutMs
      : DEFAULT_TURN_TIMEOUT_MS;
  const killGraceMs =
    typeof config.zcodeKillGraceMs === "number" && config.zcodeKillGraceMs > 0
      ? config.zcodeKillGraceMs
      : KILL_GRACE_MS;
  const retrySleep = (config.zcodeRetrySleep as ZcodeRetrySleep | undefined) ?? defaultZcodeRetrySleep;
  let cwd: string | null = null;
  let ctx: SessionContext | null = null;
  let activeConfig: AgentRuntimeConfig | null = null;
  let binary: ZcodeRuntimeBinaryResolution | null = null;
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
  let drainCancellationReason: string | null = null;
  let pendingRuntimePrompt: string | null = null;
  const queue: QueuedDelivery[] = [];

  function deliveryAttemptKey(sessionCtx: SessionContext, messages: readonly SessionMessage[]): string {
    const head = messages[0];
    if (!head) throw new Error("ZCode provider attempt requires a delivery head");
    return `${sessionCtx.agent.agentId}\0${sessionCtx.chatId}\0${head.inboxEntryId}\0${head.id}`;
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
    if (!existing && providerTurnFailureAttempts.size >= MAX_PROVIDER_ATTEMPT_WINDOWS) {
      throw new Error("ZCode provider attempt ledger is full of pending deliveries");
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
    return env;
  }

  async function refreshProjection(sessionCtx: SessionContext): Promise<{
    payload: Extract<AgentRuntimeConfigPayload, { kind: "zcode" }>;
    briefing: string;
  }> {
    if (!cwd) throw new Error("ZCode workspace is not prepared");
    let runtimeConfig = activeConfig;
    const existingPayload = activeConfig?.payload;
    if (agentConfigCache) runtimeConfig = await agentConfigCache.refresh(sessionCtx.agent.agentId);
    const payload =
      runtimeConfig?.payload ??
      ({
        kind: "zcode",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
        mode: "build",
      } satisfies AgentRuntimeConfigPayload as Extract<AgentRuntimeConfigPayload, { kind: "zcode" }>);
    if (payload.kind !== "zcode") {
      throw new Error(`ZCode handler received ${payload.kind} runtime config`);
    }
    const zcodePayload = payload as Extract<AgentRuntimeConfigPayload, { kind: "zcode" }>;
    if (zcodePayload.mcpServers.length > 0) {
      throw new Error(
        "ZCode headless turn transport does not expose a safe non-interactive MCP projection contract; " +
          "configure MCP servers in provider-owned ZCode config instead",
      );
    }
    if (zcodePayload.model.trim().length > 0) {
      throw new Error(
        "ZCode managed model selection is not supported in V1; " +
          "configure the model in provider-owned ZCode configuration instead",
      );
    }
    const projected = await projectManagedWorkspace({
      sessionCtx,
      workspace: cwd,
      agentName,
      runtimeProvider,
      providerSkillRoots: PROVIDER_SKILL_ROOTS,
      runtimeConfig,
      payload: zcodePayload,
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
    return { payload: zcodePayload, briefing: projected.briefing };
  }

  function runProcess(input: {
    args: string[];
    env: Record<string, string>;
    workspaceCwd: string;
    sessionCtx: SessionContext;
    abortSignal: AbortSignal;
    timeoutMs: number;
    label: string;
  }): Promise<ProcessOutcome> {
    return new Promise((resolveOutcome) => {
      let supervised: ReturnType<ProviderProcessSupervisor["spawn"]>;
      try {
        const resolvedBinary = binary;
        if (!resolvedBinary?.ok) throw new Error("ZCode official runtime is not initialized");
        supervised = processSupervisor.spawn({
          command: resolvedBinary.command,
          args: [...resolvedBinary.args, ...input.args],
          label: input.label,
          timeoutMs: input.timeoutMs,
          options: {
            cwd: input.workspaceCwd,
            env: input.env,
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            ...(process.platform === "win32" ? {} : { detached: true }),
          },
        });
      } catch (error) {
        resolveOutcome({
          exitCode: null,
          signal: null,
          stdout: "",
          stderrTail: "",
          spawnError: error instanceof Error ? error : new Error(String(error)),
        });
        return;
      }

      const child = supervised.child;
      const stdoutState: BoundedZcodeStdout = { parts: [], length: 0, overflow: false };
      let stderrTail = "";
      let closed: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null;
      let stdoutEnded = false;
      let settled = false;
      let spawnError: Error | undefined;
      let terminationStarted = false;
      let hardKillTimer: NodeJS.Timeout | undefined;
      let finalCloseTimer: NodeJS.Timeout | undefined;
      let processGroupPoll: NodeJS.Timeout | undefined;

      const clearTerminationTimers = (): void => {
        clearTimeout(hardKillTimer);
        clearTimeout(finalCloseTimer);
        clearInterval(processGroupPoll);
      };

      const finish = () => {
        if (settled || !closed || !stdoutEnded) return;
        settled = true;
        clearTerminationTimers();
        resolveOutcome({
          ...closed,
          stdout: Buffer.concat(stdoutState.parts, stdoutState.length).toString("utf8"),
          stderrTail,
          spawnError,
        });
      };

      const signalProcessTree = (signal: NodeJS.Signals): void => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          // The wrapper or its process group may already be gone.
        }
      };

      const isProcessGroupGone = (): boolean => {
        if (process.platform === "win32" || !child.pid) {
          return child.exitCode !== null || child.signalCode !== null;
        }
        try {
          process.kill(-child.pid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      };

      const settleAfterTermination = (): void => {
        closed ??= { exitCode: null, signal: "SIGKILL" };
        stdoutEnded = true;
        finish();
      };

      const terminateProcessGroup = (): void => {
        if (terminationStarted) return;
        terminationStarted = true;
        signalProcessTree("SIGTERM");
        hardKillTimer = setTimeout(() => signalProcessTree("SIGKILL"), killGraceMs);
        hardKillTimer.unref?.();
        if (child.pid && process.platform !== "win32") {
          processGroupPoll = setInterval(() => {
            if (!isProcessGroupGone()) return;
            clearInterval(processGroupPoll);
            processGroupPoll = undefined;
            settleAfterTermination();
          }, TERMINATION_POLL_MS);
          processGroupPoll.unref?.();
        }
        finalCloseTimer = setTimeout(() => {
          signalProcessTree("SIGKILL");
          settleAfterTermination();
        }, killGraceMs + FINAL_CLOSE_WAIT_MS);
        finalCloseTimer.unref?.();
      };

      child.on("error", (error) => {
        spawnError = error instanceof Error ? error : new Error(String(error));
        if (!terminationStarted) {
          closed ??= { exitCode: null, signal: null };
          stdoutEnded = true;
          finish();
        }
      });
      child.stdout?.on("data", (chunk: string | Buffer) => {
        appendZcodeStdoutChunk(stdoutState, chunk);
        if (stdoutState.overflow) {
          input.sessionCtx.recordProviderActivity();
          terminateProcessGroup();
          return;
        }
        input.sessionCtx.recordProviderActivity();
      });
      child.stdout?.on("end", () => {
        stdoutEnded = true;
        finish();
      });
      child.stderr?.on("data", (chunk: string | Buffer) => {
        const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        stderrTail = `${stderrTail}${value}`.slice(-STDERR_TAIL_LIMIT);
        input.sessionCtx.recordProviderActivity();
      });
      child.once("close", (exitCode, signal) => {
        closed = { exitCode, signal };
        if (!terminationStarted) {
          stdoutEnded = true;
          finish();
        }
      });

      input.abortSignal.addEventListener("abort", terminateProcessGroup, { once: true });
      supervised.exited.finally(() => {
        input.abortSignal.removeEventListener("abort", terminateProcessGroup);
        if (!terminationStarted && !closed) {
          closed = { exitCode: null, signal: null };
        }
        setTimeout(() => {
          stdoutEnded = true;
          finish();
        }, FINAL_CLOSE_WAIT_MS).unref?.();
      });
    });
  }

  function adoptSessionId(sessionCtx: SessionContext, id: string): void {
    if (providerSessionId === id) return;
    const synthetic = pendingSyntheticId;
    providerSessionId = id;
    if (synthetic) {
      pendingSyntheticId = null;
      sessionCtx.replaceSessionId?.(id, "zcode_session_id_confirmed");
      if (cwd) {
        const baseline = readSessionBriefingFingerprint(cwd, synthetic);
        if (baseline) writeSessionBriefingFingerprint(cwd, id, baseline);
      }
    }
  }

  function emitProviderTurnSettlementEvent(sessionCtx: SessionContext, settlement: ProviderAttemptSettlement): void {
    sessionCtx.emitEvent({
      kind: "error",
      payload: { source: "runtime", message: encodeProviderRetryEventMessage(settlement.eventPayload) },
    });
  }

  function consumedReasonForProviderSettlement(settlement: ProviderAttemptSettlement): string {
    return settlement.decision.action === "stop" && settlement.decision.terminalKind === "exhausted"
      ? "provider_retry_exhausted"
      : settlement.decision.reasonCode;
  }

  async function settleFailure(input: {
    failure: string;
    spawnError?: Error;
    sawProviderActivity: boolean;
    sessionCtx: SessionContext;
    messages: readonly SessionMessage[];
    token: DeliveryToken;
    turnGeneration: number;
  }): Promise<boolean> {
    const attemptKey = deliveryAttemptKey(input.sessionCtx, input.messages);
    const replaySafety = input.sawProviderActivity ? "pre_visible" : "pre_provider";
    const zcodeLoginCommand = binary?.ok ? officialRuntimeLoginCommand(binary) : undefined;
    const displayMessage = isAuthError(input.failure)
      ? formatAuthHint("zcode", input.failure, { loginCommand: zcodeLoginCommand })
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
      input.token.retry(input.messages, "zcode_unclassified_failure");
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
      if (input.sawProviderActivity) {
        input.sessionCtx.failSessionForRecovery?.("zcode_turn_retryable_failure", providerSessionId ?? undefined);
      }
      return false;
    }
    const completion = await input.token.complete(
      input.messages,
      consumedErrorOutcome(consumedReasonForProviderSettlement(settlement)),
    );
    if (completion === "retry") return false;
    providerTurnFailureAttempts.delete(attemptKey);
    pendingRuntimePrompt = null;
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
      token.retry(messages, sessionActive ? "zcode_not_prepared" : "zcode_session_inactive");
      return false;
    }
    const turnGeneration = ++generation;
    const abort = new AbortController();
    currentAbort = abort;
    let sawProviderActivity = false;
    const promise = (async () => {
      const { payload } = await refreshProjection(sessionCtx);
      const env = buildEnv(sessionCtx, payload);
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

      const runtimePrompt = pendingRuntimePrompt;
      const providerPromptParts = [runtimePrompt, prompt].filter(Boolean);
      const providerPrompt = providerPromptParts.join("\n\n");
      const expectedSessionId = providerSessionId;
      token.processingStarted(messages);
      const timeout = setTimeout(() => abort.abort(), turnTimeoutMs);
      timeout.unref?.();
      let outcome: ProcessOutcome;
      try {
        outcome = await runProcess({
          args: buildZcodeTurnArgs({
            workspace: workspaceCwd,
            prompt: providerPrompt,
            mode: payload.mode,
            resumeSessionId: expectedSessionId,
          }),
          env,
          workspaceCwd,
          sessionCtx,
          abortSignal: abort.signal,
          timeoutMs: turnTimeoutMs,
          label: `zcode turn ${sessionCtx.chatId}`,
        });
      } finally {
        clearTimeout(timeout);
      }
      sawProviderActivity = outcome.stdout.length > 0 || outcome.stderrTail.length > 0;
      if (abort.signal.aborted || generation !== turnGeneration || !sessionActive) {
        return settleFailure({
          failure: "ZCode turn aborted or timed out before a safe terminal result",
          spawnError: new Error("ZCode turn aborted or timed out"),
          sawProviderActivity,
          sessionCtx,
          messages,
          token,
          turnGeneration,
        });
      }

      const protocolErrors: string[] = [];
      if (outcome.spawnError) protocolErrors.push(outcome.spawnError.message);
      if (outcome.exitCode !== 0) {
        protocolErrors.push(
          outcome.exitCode === null ? `signal ${outcome.signal ?? "unknown"}` : `exit ${outcome.exitCode}`,
        );
      }
      try {
        const result = parseZcodeJsonOutput(outcome.stdout);
        if (expectedSessionId && result.sessionId !== expectedSessionId) {
          protocolErrors.push(`resume session mismatch: expected ${expectedSessionId}, observed ${result.sessionId}`);
        }
        if (protocolErrors.length === 0) {
          adoptSessionId(sessionCtx, result.sessionId);
          for (const chunk of chunkAssistantText(result.response)) {
            sessionCtx.emitEvent({ kind: "assistant_text", payload: { text: chunk } });
          }
          if (result.usage) {
            sessionCtx.emitEvent({
              kind: "token_usage",
              payload: {
                provider: "zcode",
                model: "zcode-default",
                inputTokens: result.usage.inputTokens,
                cachedInputTokens: result.usage.cachedInputTokens,
                outputTokens: result.usage.outputTokens,
              },
            });
          }
          try {
            await sessionCtx.forwardResult(result.response);
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
            pendingRuntimePrompt = null;
            return true;
          }
          sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "success" } });
          const completion = await token.complete(messages, { status: "success" });
          if (completion === "retry") return false;
          providerTurnFailureAttempts.delete(deliveryAttemptKey(sessionCtx, messages));
          if (pendingRuntimePrompt === runtimePrompt) pendingRuntimePrompt = null;
          return true;
        }
      } catch (error) {
        protocolErrors.push(error instanceof Error ? error.message : String(error));
      }
      const rawFailure = [...protocolErrors, outcome.stderrTail].filter(Boolean).join("\n").slice(0, 2000);
      return settleFailure({
        failure: redactErrorPreview(rawFailure, 2000),
        ...(outcome.spawnError ? { spawnError: outcome.spawnError } : {}),
        sawProviderActivity,
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
        token.retry(messages, "zcode_context_source_changed");
        sessionCtx.failSessionForRecovery?.("zcode_context_source_changed", providerSessionId ?? undefined);
        return false;
      }
      if (isManagedSkillsUnsafeDiscoveryError(error)) {
        token.retry(messages, "zcode_managed_skills_unsafe");
        sessionCtx.log(`blocked ZCode provider turn: ${error.message}`);
        return false;
      }
      return settleFailure({
        failure: redactErrorPreview(error instanceof Error ? error.message : String(error), 2000),
        spawnError: error instanceof Error ? error : new Error(String(error)),
        sawProviderActivity,
        sessionCtx,
        messages,
        token,
        turnGeneration,
      });
    } finally {
      if (generation === turnGeneration) {
        currentAbort = null;
        currentTurnPromise = null;
      }
    }
  }

  async function prepareSession(sessionCtx: SessionContext): Promise<{ briefing: string; workspaceCwd: string }> {
    if (isLandingCampaignTrialAgentMetadata(sessionCtx.agent.metadata)) {
      throw new Error("landing campaign trial agents require the codex app-server runtime");
    }
    ctx = sessionCtx;
    const resolution = await resolveBinary(process.env);
    if (!resolution.ok) throw new Error(resolution.error);
    binary = resolution;
    sessionCtx.log(`ZCode official runtime: ${officialRuntimeLabel(resolution.runtimePath)}`);
    let runtimeConfig = activeConfig;
    if (agentConfigCache) runtimeConfig = await agentConfigCache.refresh(sessionCtx.agent.agentId);
    const payload =
      runtimeConfig?.payload ??
      ({
        kind: "zcode",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
        mode: "build",
      } satisfies AgentRuntimeConfigPayload as Extract<AgentRuntimeConfigPayload, { kind: "zcode" }>);
    if (payload.kind !== "zcode") throw new Error(`ZCode handler received ${payload.kind} runtime config`);
    if (payload.model.length > 0) {
      throw new Error(
        "ZCode managed model selection is not supported in V1; " +
          "configure the model in provider-owned ZCode configuration instead",
      );
    }
    if (payload.mcpServers.length > 0) {
      throw new Error(
        "ZCode headless turn transport does not expose a safe non-interactive MCP projection contract; " +
          "configure MCP servers in provider-owned ZCode config instead",
      );
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
    pendingRuntimePrompt = [renderRuntimeOutputContract(), renderChatContextPrompt(prepared.chatContext)]
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

  async function runQueued(drained: QueuedDelivery[], sessionCtx: SessionContext): Promise<void> {
    const token = drained[0]?.token;
    if (!token) return;
    const messages = drained.map((entry) => entry.message);
    const parts: string[] = [];
    try {
      for (const message of messages) parts.push(await sessionCtx.formatInboundContent(message));
    } catch {
      retryDrainingBatch(drained, "zcode_queued_format_failed");
      return;
    }
    while (sessionActive && drainingBatch === drained) {
      let fingerprint: string | null = null;
      try {
        const turnParts = [...parts];
        const sessionKey = providerSessionId ?? pendingSyntheticId;
        if (cwd) {
          const projection = await refreshProjection(sessionCtx);
          fingerprint = computeBriefingFingerprint(projection.briefing);
          if (sessionKey && readSessionBriefingFingerprint(cwd, sessionKey) !== fingerprint) {
            turnParts.unshift(buildBriefingUpdateNotice(`${cwd}/AGENTS.md`));
          }
        }
        const delivered = await runTurn(turnParts.join("\n\n"), sessionCtx, messages, token);
        if (delivered && fingerprint && cwd && sessionKey) {
          writeSessionBriefingFingerprint(cwd, sessionKey, fingerprint);
        }
        finishDrainingBatch(drained);
        return;
      } catch (error) {
        if (isContextSourceTransitionError(error)) {
          retryDrainingBatch(drained, "zcode_context_source_changed");
          sessionCtx.failSessionForRecovery?.("zcode_context_source_changed", providerSessionId ?? undefined);
          return;
        }
        if (isManagedSkillsUnsafeDiscoveryError(error)) throw error;
        throw error;
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
          sessionCtx.log(`ZCode queued turn failed: ${error instanceof Error ? error.message : String(error)}`);
          retryDrainingBatch(drained, "zcode_queued_turn_failed");
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
      initialTurnPreparing = true;
      let completed = false;
      let delivered = false;
      let briefing: string;
      let workspaceCwd: string;
      try {
        ({ briefing, workspaceCwd } = await prepareSession(sessionCtx));
        const prompt = await sessionCtx.formatInboundContent(message);
        delivered = await runTurn(prompt, sessionCtx, [message], token);
        completed = delivered;
      } finally {
        initialTurnPreparing = false;
        if (completed) scheduleDrain();
      }
      if (!providerSessionId) pendingSyntheticId = `${ZCODE_PENDING_SESSION_PREFIX}${randomUUID()}`;
      const sessionId = providerSessionId ?? pendingSyntheticId;
      if (!sessionId) throw new Error("ZCode session id unresolved");
      if (delivered) writeSessionBriefingFingerprint(workspaceCwd, sessionId, computeBriefingFingerprint(briefing));
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
      if (isZcodePendingSessionId(sessionId)) {
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
          prompt = `${buildBriefingUpdateNotice(`${workspaceCwd}/AGENTS.md`)}\n\n${prompt}`;
        }
        try {
          const delivered = await runTurn(prompt, sessionCtx, [message], deliveryToken);
          if (delivered) writeSessionBriefingFingerprint(workspaceCwd, providerSessionId ?? sessionId, fingerprint);
        } finally {
          initialTurnPreparing = false;
          scheduleDrain();
        }
      } else {
        initialTurnPreparing = false;
        scheduleDrain();
      }
      return {
        sessionId: providerSessionId ?? pendingSyntheticId ?? sessionId,
        route: message ? { kind: "owned", mode: "processing" } : null,
      };
    },

    inject(message, token) {
      if (!ctx) return { kind: "rejected", reason: "no_active_context", retryable: true };
      queue.push({ message, token });
      scheduleDrain();
      return { kind: "owned", mode: "queued" };
    },

    async suspend(reason) {
      const recoveryReason = reason ?? "zcode_suspend_before_terminal";
      sessionActive = false;
      drainCancellationReason = recoveryReason;
      generation++;
      currentAbort?.abort();
      await Promise.all([currentTurnPromise, currentDrainPromise]);
      if (drainingBatch) retryDrainingBatch(drainingBatch, recoveryReason);
      retryQueue(recoveryReason);
      drainCancellationReason = null;
      drainScheduled = false;
      drainInProgress = false;
      drainingBatch = null;
      currentTurnPromise = null;
      currentDrainPromise = null;
    },

    async shutdown(reason, opts) {
      const recoveryReason = reason ?? "zcode_shutdown_before_terminal";
      sessionActive = false;
      drainCancellationReason = recoveryReason;
      generation++;
      currentAbort?.abort();
      await Promise.all([currentTurnPromise, currentDrainPromise]);
      if (drainingBatch) retryDrainingBatch(drainingBatch, recoveryReason);
      retryQueue(recoveryReason);
      drainCancellationReason = null;
      drainScheduled = false;
      drainInProgress = false;
      drainingBatch = null;
      currentTurnPromise = null;
      currentDrainPromise = null;
      void opts;
    },
  } satisfies AgentHandler;
};
