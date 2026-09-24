import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type ApprovalHandler,
  type ApprovalRequest,
  type ApprovalResponse,
  type CreateSessionOptions,
  createKimiHarness,
  type Event as KimiEvent,
  type KimiHarness,
  type KimiHarnessOptions,
  LocalKaos,
  type ResumeSessionInput,
  type Session,
  type SessionUsage,
  type TokenUsage,
} from "@botiverse/kimi-code-sdk";
import {
  type AgentRuntimeConfig,
  type AgentRuntimeConfigPayload,
  classifyShellCommandIo,
  DEFAULT_KIMI_CODE_RUNTIME_CONFIG_PAYLOAD,
  encodeProviderRetryEventMessage,
  isLandingCampaignTrialAgentMetadata,
  runtimeProviderSchema,
  type ToolFileRef,
} from "@first-tree/shared";
import type {
  AgentHandler,
  DeliveryToken,
  HandlerFactory,
  ReplayFenceWriter,
  SessionContext,
  SessionMessage,
} from "../../runtime/contracts.js";
import { noopDeliveryToken, requireDeliveryToken } from "../../runtime/contracts.js";
import type {
  AgentConfigCache,
  ContextTreeAttribution,
  ContextTreeGitWriteTracker,
  ProviderAttemptSettlement,
} from "../../runtime/provider-support/index.js";
import {
  assertContextSourceCurrent,
  contextSourceFromHandlerConfig,
  createContextTreeGitWriteTracker,
  maxProviderTurnRetryAttempts,
  ProviderAttempt,
  preparationCoordinatesFromSource,
  prepareManagedSession,
  remoteGitAttributionFromSource,
  renderChatContextPrompt,
  renderRuntimeOutputContract,
  resolveContextTreeRelativePath,
  toolFileRefsFromShellCommand,
  withContextTreeRepoHeadCommit,
} from "../../runtime/provider-support/index.js";
import { chunkAssistantText } from "../handlers/assistant-text.js";
import { formatAuthHint, isKimiCodeAuthError } from "../handlers/auth-error-hint.js";
import { PROVIDER_SKILL_ROOTS } from "../skill-roots.js";

const RESULT_PREVIEW_LIMIT = 400;
const KIMI_IDENTITY_VERSION = "0.1.2";

type KimiHarnessLike = Pick<KimiHarness, "createSession" | "resumeSession" | "close">;
type KimiHarnessFactory = (options: KimiHarnessOptions) => KimiHarnessLike;
type KimiKaosFactory = () => Promise<LocalKaos>;

type KimiManagedMcpServer =
  | { transport: "stdio"; command: string; args?: string[] }
  | { transport: "http" | "sse"; url: string; headers?: Record<string, string> };

type KimiManagedMcpSessionOptions = {
  readonly mcpServers?: Readonly<Record<string, KimiManagedMcpServer>>;
};

// The pinned SDK applies `drainAgentTasksOnStop` on the create path only; a
// pnpm patch (`patches/@botiverse__kimi-code-sdk@*.patch`) threads the same
// flag through resume. Its declaration file predates the additive resume
// field, so First Tree expresses it through a local intersection type.
type KimiDrainSessionOption = { drainAgentTasksOnStop?: boolean };
type KimiCreateSessionOptions = CreateSessionOptions & KimiManagedMcpSessionOptions & KimiDrainSessionOption;
type KimiResumeSessionInput = ResumeSessionInput & KimiManagedMcpSessionOptions & KimiDrainSessionOption;

// Hold the provider turn open until background subagents (`kind === "agent"`)
// settle and the main agent has consumed their completions, so First Tree only
// ACKs a delivery after the whole background workload is done.
const KIMI_DRAIN_AGENT_TASKS_ON_STOP = true;

// Only the main agent drives the logical parent turn: its text is chat output
// and only its `turn.ended` may settle a delivery. Subagent events share the
// same event stream while the drain flag keeps the turn open.
const KIMI_MAIN_AGENT_ID = "main";

export function mapKimiMcpServers(payload: AgentRuntimeConfigPayload): Record<string, KimiManagedMcpServer> {
  const servers: Record<string, KimiManagedMcpServer> = {};
  for (const server of payload.mcpServers) {
    if (server.transport === "stdio") {
      servers[server.name] = {
        transport: "stdio",
        command: server.command,
        ...(server.args === undefined ? {} : { args: server.args }),
      };
    } else {
      servers[server.name] = {
        transport: server.transport,
        url: server.url,
        ...(server.headers === undefined ? {} : { headers: server.headers }),
      };
    }
  }
  return servers;
}

type ActiveTool = {
  name: string;
  args: unknown;
  startedAt: number;
  refs: ToolFileRef[];
};

type TurnObservation = {
  assistantText: string;
  ended: Extract<KimiEvent, { type: "turn.ended" }> | null;
  error: Error | null;
  /**
   * Set when the first unsafe tool effect could not be fenced durably. The
   * turn must then settle as a terminal consumed error: continuing without a
   * persisted fence would leave a crash-window where redelivery replays the
   * effect.
   */
  fenceError: Error | null;
  thinkingEmitted: boolean;
  unsafeToolEffectStarted: boolean;
  unsafeFenced: boolean;
};

type PreparedSession = {
  payload: AgentRuntimeConfigPayload;
  workspaceCwd: string;
  roleAdditional: string;
  additionalDirs: string[];
  kaos: LocalKaos;
};

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

function kimiEventError(event: { code: string; message: string; retryable?: boolean }): Error {
  const error = new Error(event.message) as Error & { code?: string; reason?: string; retryable?: boolean };
  error.name = "KimiCodeError";
  error.code = event.code;
  error.reason = event.code;
  error.retryable = event.retryable;
  return error;
}

/**
 * Host pre-effect hook the patched SDK invokes at its awaited
 * `authorizeToolExecution` boundary — before any runnable tool task is
 * created. Registered globally because the SDK bundle and this handler share
 * one process, while the SDK's public RPC bridge cannot carry function
 * values. The SDK converts a hook throw into a blocked tool call, so a
 * failed replay-fence write provably stops the unsafe effect (the SDK's
 * live-event path cannot deliver this guarantee: listener errors are
 * swallowed and the event bridge is async).
 */
type HostBeforeToolCallInfo = {
  sessionId?: string;
  agentId?: string;
  toolName: string;
  toolCallId: string;
  args: unknown;
};

const beforeToolCallHooks = new Map<string, (info: HostBeforeToolCallInfo) => void>();

function ensureGlobalBeforeToolCallHook(): void {
  const globalScope = globalThis as {
    __firstTreeBeforeToolCall?: (info: HostBeforeToolCallInfo) => Promise<void> | void;
  };
  if (globalScope.__firstTreeBeforeToolCall) return;
  globalScope.__firstTreeBeforeToolCall = (info) => {
    const hook = typeof info.sessionId === "string" ? beforeToolCallHooks.get(info.sessionId) : undefined;
    hook?.(info);
  };
}

export function formatKimiCodeError(error: Error): string {
  const record = error as Error & { code?: string };
  const combined = `${record.code ?? ""} ${error.message}`.trim();
  return isKimiCodeAuthError(combined) ? formatAuthHint("kimi-code", combined) : combined;
}

export function kimiToolIsReadOnly(name: string, args: unknown): boolean {
  if (name === "Read" || name === "Grep" || name === "Glob") return true;
  if (name !== "Bash") return false;
  const command = asRecord(args)?.command;
  if (typeof command !== "string") return false;
  const classification = classifyShellCommandIo(command);
  return classification.supported && classification.action === "read";
}

function inputPathForTool(name: string, args: unknown): string | null {
  const record = asRecord(args);
  if (!record) return null;
  const keys = name === "Grep" || name === "Glob" ? ["path", "cwd", "directory"] : ["path", "file_path", "filePath"];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function additionalDirectories(workspaceCwd: string, contextTreePath: string | null): string[] {
  if (!contextTreePath) return [];

  // Declared source repos and the managed Context Tree are descendants of the
  // agent workspace, so Kimi's workDir already grants access to them. They may
  // legitimately be absent until the agent follows the briefing and clones
  // them; passing those paths as additionalDirs would make the SDK reject the
  // session before the agent has a chance to materialize them.
  const workspace = resolve(workspaceCwd);
  const candidate = resolve(contextTreePath);
  const fromWorkspace = relative(workspace, candidate);
  const insideWorkspace =
    fromWorkspace === "" ||
    (fromWorkspace !== ".." && !fromWorkspace.startsWith(`..${sep}`) && !isAbsolute(fromWorkspace));
  if (insideWorkspace) return [];

  // Keep compatibility with an explicitly configured external tree, but only
  // grant a root the SDK can validate at session construction time.
  try {
    return statSync(candidate).isDirectory() ? [candidate] : [];
  } catch {
    return [];
  }
}

/**
 * Hosted sessions have no interactive approval surface, so no human can
 * answer an approval prompt. The SDK's ExitPlanMode review policy escalates
 * plan exits to an approval request in every permission mode except "auto" —
 * including "yolo" — and the headless RPC bridge cancels any request that has
 * no registered handler. Without this handler a session that enters plan mode
 * deadlocks: every ExitPlanMode is auto-dismissed and plan mode keeps denying
 * all writes. Approve plan exits to restore the intended yolo posture; cancel
 * every other request, matching the previous handler-less behavior.
 */
const hostedSessionApprovalHandler: ApprovalHandler = (request: ApprovalRequest): ApprovalResponse => {
  if (request.toolName === "ExitPlanMode" || request.display?.kind === "plan_review") {
    return { decision: "approved" };
  }
  return { decision: "cancelled", feedback: "No interactive approval surface in hosted sessions." };
};

/** Kimi Code handler backed by the direct Botiverse/Moonshot Node SDK. */
export const createKimiCodeHandler: HandlerFactory = (config) => {
  const workspaceRoot = config.workspaceRoot;
  const agentName = typeof config.agentName === "string" ? config.agentName : "";
  const runtimeProvider = runtimeProviderSchema.parse(config.runtimeProvider);
  const agentConfigCache = (config.agentConfigCache as AgentConfigCache | undefined) ?? null;
  const contextSource = contextSourceFromHandlerConfig(config);
  const contextTree = preparationCoordinatesFromSource(contextSource);
  const gitAttribution = remoteGitAttributionFromSource(contextSource);
  const contextTreePath = gitAttribution.contextTreePath;
  const contextTreeRepoUrl = gitAttribution.contextTreeRepoUrl;
  const contextTreeBranch = contextTree.kind === "remote" ? contextTree.branch : null;
  const harnessFactory = (config.kimiHarnessFactory as KimiHarnessFactory | undefined) ?? createKimiHarness;
  const kaosFactory = (config.kimiKaosFactory as KimiKaosFactory | undefined) ?? (() => LocalKaos.create());
  const maxRetries = maxProviderTurnRetryAttempts();
  const replayFence = (config.replayFence as ReplayFenceWriter | undefined) ?? null;

  /**
   * Durably fence every message of the current delivery the moment the first
   * non-read-only tool call starts, so a crash after this point can never
   * re-enter the provider for the same delivery. Returns the failure when the
   * safety fact could not be persisted (or no store was wired) — callers must
   * fail closed, never continue unfenced.
   */
  function fenceUnsafeDelivery(
    chatId: string,
    messages: readonly SessionMessage[],
    toolName: string,
    toolUseId: string,
  ): Error | null {
    if (!replayFence) return new Error("replay fence store is not configured");
    const fencedMessageIds: string[] = [];
    for (const msg of messages) {
      try {
        replayFence.fence({
          chatId,
          messageId: msg.id,
          provider: runtimeProvider,
          toolName,
          toolUseId,
          fencedAt: new Date().toISOString(),
        });
        fencedMessageIds.push(msg.id);
      } catch (error) {
        // Roll back the entries written by THIS call: the tool call is
        // blocked, so no effect exists to protect, and a partial fence would
        // wrongly mark the delivery as authorized (or strand the chat in
        // permanent recovery debt once custody is retained).
        for (const messageId of fencedMessageIds) {
          try {
            replayFence.clear(chatId, messageId);
          } catch {
            // A fence that cannot even be removed stays — conservative.
          }
        }
        return error instanceof Error ? error : new Error(String(error));
      }
    }
    return null;
  }

  /** Clear fences once their delivery's terminal settlement is confirmed. */
  function clearFencedDelivery(
    sessionCtx: SessionContext,
    messages: readonly SessionMessage[],
    completion: unknown,
  ): void {
    if (!replayFence || completion === "retry") return;
    for (const msg of messages) {
      try {
        replayFence.clear(sessionCtx.chatId, msg.id);
      } catch (error) {
        // The delivery is ACKed, so no redelivery can re-enter it; a stale
        // fence is benign but must be visible.
        sessionCtx.log(
          `kimi replay fence clear failed for ${msg.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  let cwd: string | null = null;
  let ctx: SessionContext | null = null;
  let harness: KimiHarnessLike | null = null;
  let harnessEffectiveHome: string | null = null;
  let session: Session | null = null;
  let sessionId: string | null = null;
  let activePayload: AgentRuntimeConfigPayload | null = null;
  let sessionActive = false;
  let initialTurnPreparing = false;
  let currentTurnPromise: Promise<boolean> | null = null;
  let drainScheduled = false;
  let drainInProgress = false;
  const queuedMessages: Array<{ message: SessionMessage; token: DeliveryToken }> = [];
  const activeTools = new Map<string, ActiveTool>();
  const gitWriteTracker: ContextTreeGitWriteTracker = createContextTreeGitWriteTracker({
    contextTreePath,
    contextTreeRepoUrl,
    contextTreeBranch,
    log: (message) => ctx?.log(message),
  });

  function emitSettlement(sessionCtx: SessionContext, settlement: ProviderAttemptSettlement): void {
    sessionCtx.emitEvent({
      kind: "error",
      payload: { source: "runtime", message: encodeProviderRetryEventMessage(settlement.eventPayload) },
    });
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
    return out;
  }

  function nativeToolRefs(name: string, args: unknown, workspaceCwd: string): ToolFileRef[] {
    if (name === "Bash") {
      const command = asRecord(args)?.command;
      if (typeof command !== "string") return [];
      const commandCwd = asRecord(args)?.cwd;
      return toolFileRefsFromShellCommand({
        command,
        cwd: typeof commandCwd === "string" ? commandCwd : workspaceCwd,
        contextTreePath,
        contextTreeRepoUrl,
        contextTreeBranch,
      });
    }

    const filePath = inputPathForTool(name, args);
    if (!filePath) return [];
    const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(workspaceCwd, filePath);
    const attribution: ContextTreeAttribution = { contextTreePath, contextTreeRepoUrl };
    const repoRelativePath = resolveContextTreeRelativePath(absolutePath, attribution);
    const pathKind = name === "Grep" || name === "Glob" ? ("directory" as const) : ("file" as const);
    const ref: ToolFileRef = {
      origin: "tool_arg",
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
    return [kimiToolIsReadOnly(name, args) ? withContextTreeRepoHeadCommit(ref, absolutePath) : ref];
  }

  function emitToolCall(
    sessionCtx: SessionContext,
    toolUseId: string,
    tool: ActiveTool,
    status: "pending" | "ok" | "error",
    result?: unknown,
  ): void {
    const refs = status === "ok" ? [...tool.refs] : [];
    if (status === "ok") {
      refs.push(
        ...gitWriteTracker.refsForSuccessfulToolCall({
          toolName: tool.name,
          toolUseId,
          existingRefs: refs,
        }),
      );
    } else if (status === "error") {
      gitWriteTracker.captureBaseline();
    }
    sessionCtx.emitEvent({
      kind: "tool_call",
      payload: {
        toolUseId,
        name: tool.name,
        args: tool.args,
        status,
        ...(status !== "pending" ? { durationMs: Math.max(0, Date.now() - tool.startedAt) } : {}),
        ...(result !== undefined ? { resultPreview: preview(result) } : {}),
        ...(refs.length > 0 ? { toolFileRefs: refs } : {}),
      },
    });
  }

  function processKimiEvent(
    event: KimiEvent,
    sessionCtx: SessionContext,
    attempt: ProviderAttempt,
    observation: TurnObservation,
    resolveEnded: () => void,
  ): void {
    sessionCtx.recordProviderActivity();
    const isMainAgent = event.agentId === KIMI_MAIN_AGENT_ID;
    switch (event.type) {
      case "turn.started":
        if (isMainAgent && !observation.unsafeToolEffectStarted) attempt.setReplaySafety("pre_visible");
        break;
      case "assistant.delta":
        if (isMainAgent) observation.assistantText += event.delta;
        break;
      case "thinking.delta":
        if (isMainAgent && !observation.thinkingEmitted) {
          observation.thinkingEmitted = true;
          sessionCtx.emitEvent({ kind: "thinking", payload: {} });
        }
        break;
      case "tool.call.started": {
        // Tool effects are real side effects regardless of which agent ran
        // them, so keep every agent's calls observable. Namespace subagent ids
        // so parallel child calls cannot collide with each other or the main
        // agent's raw ids.
        const toolUseId = isMainAgent ? event.toolCallId : `${event.agentId}:${event.toolCallId}`;
        const tool: ActiveTool = {
          name: event.name,
          args: event.args,
          startedAt: Date.now(),
          refs: cwd ? nativeToolRefs(event.name, event.args, cwd) : [],
        };
        activeTools.set(toolUseId, tool);
        // The durable fence itself is written earlier, at the SDK's awaited
        // authorize boundary (see the hook registered in observeOneAttempt),
        // which also marks replay safety for calls it allows through. A call
        // the hook just blocked (fenceError set) produced no effect, so it
        // must not mark the turn unsafe.
        if (!kimiToolIsReadOnly(event.name, event.args) && !observation.fenceError) {
          observation.unsafeToolEffectStarted = true;
        }
        attempt.setReplaySafety(observation.unsafeToolEffectStarted ? "unsafe" : "pre_visible");
        emitToolCall(sessionCtx, toolUseId, tool, "pending");
        break;
      }
      case "tool.result": {
        const toolUseId = isMainAgent ? event.toolCallId : `${event.agentId}:${event.toolCallId}`;
        const tool = activeTools.get(toolUseId);
        if (!tool) break;
        emitToolCall(sessionCtx, toolUseId, tool, event.isError ? "error" : "ok", event.output);
        activeTools.delete(toolUseId);
        break;
      }
      case "error":
        if (isMainAgent) {
          observation.error = kimiEventError(event);
        } else {
          sessionCtx.log(`kimi subagent ${event.agentId} error: ${event.message}`);
        }
        break;
      case "turn.ended":
        if (!isMainAgent) break;
        observation.ended = event;
        if (event.error) observation.error = kimiEventError(event.error);
        resolveEnded();
        break;
      default:
        break;
    }
  }

  async function observeOneAttempt(
    activeSession: Session,
    prompt: string,
    sessionCtx: SessionContext,
    attempt: ProviderAttempt,
    messages: readonly SessionMessage[],
  ): Promise<TurnObservation> {
    const observation: TurnObservation = {
      assistantText: "",
      ended: null,
      error: null,
      fenceError: null,
      thinkingEmitted: false,
      unsafeToolEffectStarted: false,
      unsafeFenced: false,
    };
    let resolveEnded = (): void => {};
    const endedPromise = new Promise<void>((resolvePromise) => {
      resolveEnded = resolvePromise;
    });
    const unsubscribe = activeSession.onEvent((event) => {
      try {
        processKimiEvent(event, sessionCtx, attempt, observation, resolveEnded);
      } catch (error) {
        sessionCtx.log(`kimi event translation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    // Durably fence the delivery at the SDK's awaited authorize boundary —
    // the only point where a persistence failure can still prevent the
    // unsafe effect. The patched SDK converts a hook throw into a blocked
    // tool call before the runnable task exists.
    ensureGlobalBeforeToolCallHook();
    beforeToolCallHooks.set(activeSession.id, beforeToolCallHook);
    function beforeToolCallHook(info: HostBeforeToolCallInfo): void {
      if (kimiToolIsReadOnly(info.toolName, info.args)) return;
      if (observation.fenceError) {
        // Fail-closed: a previous fence write failed in this attempt, so no
        // later unsafe call may execute either — the SDK turns each throw
        // into a blocked result and continues, and without this guard the
        // next call would run unfenced.
        throw new Error(`replay fence persistence failed: ${observation.fenceError.message}`);
      }
      if (observation.unsafeFenced) {
        // A previous unsafe call was already fenced and allowed through.
        observation.unsafeToolEffectStarted = true;
        attempt.setReplaySafety("unsafe");
        return;
      }
      const agentId = typeof info.agentId === "string" && info.agentId.length > 0 ? info.agentId : KIMI_MAIN_AGENT_ID;
      const toolUseId = agentId === KIMI_MAIN_AGENT_ID ? info.toolCallId : `${agentId}:${info.toolCallId}`;
      const fenceFailure = fenceUnsafeDelivery(sessionCtx.chatId, messages, info.toolName, toolUseId);
      if (fenceFailure) {
        // The throw makes the SDK block this call, so no unsafe effect has
        // happened: deliberately do NOT mark replay safety unsafe here —
        // settlement may safely retain custody for redelivery.
        observation.fenceError = fenceFailure;
        throw new Error(`replay fence persistence failed: ${fenceFailure.message}`);
      }
      // Only now is the delivery durably authorized: every message of the
      // delivery is fenced, so this effect may execute and later unsafe
      // calls in the attempt may take the fenced fast path.
      observation.unsafeFenced = true;
      observation.unsafeToolEffectStarted = true;
      attempt.setReplaySafety("unsafe");
    }
    try {
      await activeSession.prompt(prompt);
      if (!observation.ended) await endedPromise;
      return observation;
    } finally {
      if (beforeToolCallHooks.get(activeSession.id) === beforeToolCallHook)
        beforeToolCallHooks.delete(activeSession.id);
      unsubscribe();
    }
  }

  async function readUsage(activeSession: Session, sessionCtx: SessionContext): Promise<SessionUsage | null> {
    let usage: SessionUsage;
    try {
      usage = await activeSession.getUsage();
    } catch (error) {
      sessionCtx.log(`kimi usage read failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    return usage;
  }

  function usageDelta(current: TokenUsage, baseline: TokenUsage | undefined): TokenUsage {
    return {
      inputOther: Math.max(0, current.inputOther - (baseline?.inputOther ?? 0)),
      inputCacheCreation: Math.max(0, current.inputCacheCreation - (baseline?.inputCacheCreation ?? 0)),
      inputCacheRead: Math.max(0, current.inputCacheRead - (baseline?.inputCacheRead ?? 0)),
      output: Math.max(0, current.output - (baseline?.output ?? 0)),
    };
  }

  async function emitUsage(
    sessionCtx: SessionContext,
    activeSession: Session,
    baseline: SessionUsage | null,
  ): Promise<void> {
    const usage = await readUsage(activeSession, sessionCtx);
    if (!usage) return;
    // `currentTurn` is optional and is absent in some managed:kimi-code
    // sessions. In that case `total` is cumulative, so subtract the reading
    // captured immediately before this First Tree turn.
    const turn = usage.currentTurn ?? (usage.total ? usageDelta(usage.total, baseline?.total) : undefined);
    if (!turn) return;
    sessionCtx.emitEvent({
      kind: "token_usage",
      payload: {
        provider: "kimi-code",
        model: activePayload?.model || "kimi-default",
        inputTokens: turn.inputOther + turn.inputCacheCreation,
        cachedInputTokens: turn.inputCacheRead,
        outputTokens: turn.output,
      },
    });
  }

  async function executeTurn(
    prompt: string,
    sessionCtx: SessionContext,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
  ): Promise<boolean> {
    const activeSession = session;
    if (!activeSession || !sessionActive) {
      token.retry(messages, "kimi_session_inactive");
      return false;
    }
    token.processingStarted(messages);
    gitWriteTracker.captureBaseline();
    const usageBaseline = await readUsage(activeSession, sessionCtx);

    for (let attemptNumber = 1; attemptNumber <= maxRetries + 1; attemptNumber += 1) {
      if (!sessionActive) {
        token.retry(messages, "kimi_turn_cancelled");
        return false;
      }
      const attempt = new ProviderAttempt({
        provider: runtimeProvider,
        scope: "provider_turn",
        source: "sdk",
      });
      let observation: TurnObservation | null = null;
      let thrown: Error | null = null;
      try {
        observation = await observeOneAttempt(activeSession, prompt, sessionCtx, attempt, messages);
      } catch (error) {
        thrown = error instanceof Error ? error : new Error(String(error));
      }

      if (!sessionActive) {
        token.retry(messages, "kimi_turn_cancelled");
        return false;
      }

      const fenceFailure = observation?.fenceError ?? null;
      if (fenceFailure) {
        // Fail closed: the unsafe tool call was blocked at the SDK's awaited
        // authorize boundary before its effect executed, so custody here is
        // purely about durability. Route the failure through the
        // provider-attempt pipeline so a terminal settlement emits the
        // durable provider-failure notice boundary
        // before any consumed ACK.
        attempt.recordSignal({ kind: "local_error", error: fenceFailure });
        const fenceSettlement = attempt.settle({ attempt: attemptNumber });
        if (fenceSettlement && fenceSettlement.decision.action !== "retry") {
          emitSettlement(sessionCtx, fenceSettlement);
          const formatted = formatKimiCodeError(fenceFailure);
          await emitUsage(sessionCtx, activeSession, usageBaseline);
          sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: formatted.slice(0, 2000) } });
          sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
          const completion = await token.complete(messages, {
            status: "error",
            completion: "consumed",
            reason: "replay_fence_persist_failed",
          });
          clearFencedDelivery(sessionCtx, messages, completion);
          return false;
        }
        // Retryable/unclassified: retain custody. No effect was executed,
        // so redelivery is safe once the fence store is healthy again.
        token.retry(messages, "replay_fence_persist_failed");
        return false;
      }

      const endedSuccessfully = observation?.ended?.reason === "completed";
      if (endedSuccessfully) {
        const assistantText = observation?.assistantText ?? "";
        for (const chunk of chunkAssistantText(assistantText)) {
          if (chunk.trim()) sessionCtx.emitEvent({ kind: "assistant_text", payload: { text: chunk } });
        }
        await emitUsage(sessionCtx, activeSession, usageBaseline);
        try {
          await sessionCtx.forwardResult(assistantText);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sessionCtx.emitEvent({
            kind: "error",
            payload: { source: "runtime", message: `forward failed: ${message}` },
          });
          sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
          const forwardCompletion = await token.complete(messages, {
            status: "error",
            completion: "consumed",
            reason: "forward_failed",
          });
          clearFencedDelivery(sessionCtx, messages, forwardCompletion);
          return false;
        }
        sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "success" } });
        const completion = await token.complete(messages, { status: "success" });
        clearFencedDelivery(sessionCtx, messages, completion);
        return true;
      }

      const failure =
        thrown ?? observation?.error ?? new Error(`Kimi turn ended: ${observation?.ended?.reason ?? "unknown"}`);
      const classification = attempt.recordSignal({
        kind: thrown ? "local_error" : "provider_error",
        error: failure,
      });
      const retryable = (failure as Error & { retryable?: boolean }).retryable;
      if (
        classification?.reasonCode === "provider_rate_limited" &&
        retryable === true &&
        !observation?.unsafeToolEffectStarted
      ) {
        // Kimi marks provider.rate_limit as a retryable refusal. With no tool
        // side effect the provider did not take replay custody, so use the
        // shared pre-provider capacity budget instead of terminal waiting.
        attempt.setReplaySafety("pre_provider");
      }
      const settlement = attempt.settle({ attempt: attemptNumber });
      if (!settlement) {
        token.retry(messages, "kimi_unclassified_failure");
        return false;
      }
      emitSettlement(sessionCtx, settlement);
      if (settlement.decision.action === "retry") {
        const delayMs = settlement.decision.delayMs;
        sessionCtx.log(
          `kimi turn retry ${attemptNumber}/${maxRetries + 1} after ${delayMs}ms; ${settlement.messagePreview}`,
        );
        await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
        continue;
      }

      const formatted = formatKimiCodeError(failure);
      await emitUsage(sessionCtx, activeSession, usageBaseline);
      sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: formatted.slice(0, 2000) } });
      sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
      const failureCompletion = await token.complete(messages, {
        status: "error",
        completion: "consumed",
        reason: settlement.decision.reasonCode,
      });
      clearFencedDelivery(sessionCtx, messages, failureCompletion);
      return false;
    }

    token.retry(messages, "kimi_retry_loop_exited");
    return false;
  }

  async function runTurn(
    prompt: string,
    sessionCtx: SessionContext,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
  ): Promise<boolean> {
    const promise = executeTurn(prompt, sessionCtx, messages, token);
    currentTurnPromise = promise;
    try {
      return await promise;
    } finally {
      if (currentTurnPromise === promise) currentTurnPromise = null;
      scheduleQueuedMessagesDrain();
    }
  }

  async function mergeAndRun(
    drained: Array<{ message: SessionMessage; token: DeliveryToken }>,
    sessionCtx: SessionContext,
  ): Promise<void> {
    const prompts: string[] = [];
    let failed = false;
    for (const entry of drained) {
      try {
        prompts.push(await sessionCtx.formatInboundContent(entry.message));
      } catch (error) {
        failed = true;
        sessionCtx.log(
          `kimi queued message formatting failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (failed || prompts.length === 0) {
      for (const entry of drained) entry.token.retry(entry.message, "kimi_queued_turn_format_failed");
      return;
    }
    const token = drained[0]?.token;
    if (!token) return;
    await runTurn(
      prompts.join("\n\n"),
      sessionCtx,
      drained.map((entry) => entry.message),
      token,
    );
  }

  function scheduleQueuedMessagesDrain(): void {
    if (drainScheduled || drainInProgress || initialTurnPreparing) return;
    if (!sessionActive || !ctx || !session || currentTurnPromise || queuedMessages.length === 0) return;
    drainScheduled = true;
    setImmediate(() => {
      drainScheduled = false;
      if (!sessionActive || !ctx || !session || currentTurnPromise || queuedMessages.length === 0) return;
      const drained = queuedMessages.splice(0);
      const sessionCtx = ctx;
      drainInProgress = true;
      void mergeAndRun(drained, sessionCtx)
        .catch((error) => {
          sessionCtx.log(`kimi queued turn failed: ${error instanceof Error ? error.message : String(error)}`);
          for (const entry of drained) entry.token.retry(entry.message, "kimi_queued_turn_failed");
        })
        .finally(() => {
          drainInProgress = false;
          scheduleQueuedMessagesDrain();
        });
    });
  }

  function retryQueuedMessages(reason: string): void {
    for (const entry of queuedMessages.splice(0)) entry.token.retry(entry.message, reason);
  }

  async function prepareSession(sessionCtx: SessionContext): Promise<PreparedSession> {
    if (isLandingCampaignTrialAgentMetadata(sessionCtx.agent.metadata)) {
      throw new Error(
        "landing campaign trial agents require the codex app-server workspace-only runtime; kimi-code does not support trials",
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
    payload ??= { ...DEFAULT_KIMI_CODE_RUNTIME_CONFIG_PAYLOAD };
    if (payload.kind !== "kimi-code") {
      throw new Error(`runtime provider mismatch: expected kimi-code, got ${payload.kind}`);
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

    const chatContext = renderChatContextPrompt(prepared.chatContext);
    const roleAdditional = [renderRuntimeOutputContract(), chatContext].filter(Boolean).join("\n\n");
    const providerEnv = buildEnv(sessionCtx, payload);
    const localKaos = await kaosFactory();
    const kaos = localKaos.withCwd(workspaceCwd).withEnv(providerEnv);
    activePayload = payload;
    return {
      payload,
      workspaceCwd,
      roleAdditional,
      additionalDirs: additionalDirectories(workspaceCwd, contextTree.path),
      kaos,
    };
  }

  async function ensureHarness(homeDir?: string): Promise<KimiHarnessLike> {
    const effectiveHome = homeDir ?? null;
    if (harness && harnessEffectiveHome !== effectiveHome) {
      await closeHarness();
    }
    if (!harness) {
      const options: KimiHarnessOptions = {
        identity: { userAgentProduct: "first-tree", version: KIMI_IDENTITY_VERSION },
        uiMode: "first-tree",
        ...(homeDir !== undefined ? { homeDir } : {}),
      };
      harness = harnessFactory(options);
    }
    harnessEffectiveHome = effectiveHome;
    return harness;
  }

  async function closeActiveSession(): Promise<void> {
    const activeSession = session;
    session = null;
    if (!activeSession) return;
    try {
      await activeSession.close();
    } catch (error) {
      ctx?.log(`kimi session close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function closeHarness(): Promise<void> {
    const activeHarness = harness;
    harness = null;
    if (!activeHarness) return;
    try {
      await activeHarness.close();
    } catch (error) {
      ctx?.log(`kimi harness close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function cleanupFailedInitialization(): Promise<void> {
    sessionActive = false;
    retryQueuedMessages("kimi_initialization_failed");
    await closeActiveSession();
    await closeHarness();
    cwd = null;
    ctx = null;
    sessionId = null;
    activePayload = null;
    initialTurnPreparing = false;
    activeTools.clear();
  }

  return {
    async start(message, sessionCtx, token) {
      const deliveryToken = token;
      const prepared = await prepareSession(sessionCtx);
      const mcpServers = mapKimiMcpServers(prepared.payload);
      // The pinned SDK runtime accepts caller-scoped MCP servers here even
      // though its exported CreateSessionOptions interface omits the field.
      const options: KimiCreateSessionOptions = {
        workDir: prepared.workspaceCwd,
        permission: "yolo",
        kaos: prepared.kaos,
        additionalDirs: prepared.additionalDirs,
        roleAdditional: prepared.roleAdditional,
        drainAgentTasksOnStop: KIMI_DRAIN_AGENT_TASKS_ON_STOP,
        ...(prepared.payload.model ? { model: prepared.payload.model } : {}),
        ...(prepared.payload.mcpServers.length > 0 ? { mcpServers } : {}),
      };
      const kimiHome = prepared.payload.env.find((entry) => entry.key === "KIMI_CODE_HOME")?.value.trim() ?? null;
      const effectiveHomeDir = kimiHome !== null && kimiHome.length === 0 ? null : kimiHome;
      try {
        const activeHarness = await ensureHarness(effectiveHomeDir ?? undefined);
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
        session = await activeHarness.createSession(options);
        session.setApprovalHandler(hostedSessionApprovalHandler);
        sessionId = session.id;
        sessionActive = true;
        initialTurnPreparing = true;
        const prompt = await sessionCtx.formatInboundContent(message);
        await runTurn(prompt, sessionCtx, [message], deliveryToken);
      } catch (error) {
        await cleanupFailedInitialization();
        throw error;
      } finally {
        initialTurnPreparing = false;
        scheduleQueuedMessagesDrain();
      }
      return { sessionId, route: { kind: "owned", mode: "processing" } };
    },

    async resume(message, id, sessionCtx, token) {
      const deliveryToken = message ? requireDeliveryToken(token, "messageful resume") : noopDeliveryToken();
      const prepared = await prepareSession(sessionCtx);
      const mcpServers = mapKimiMcpServers(prepared.payload);
      // ResumeSessionInput has the same declaration gap as create options.
      const input: KimiResumeSessionInput = {
        id,
        kaos: prepared.kaos,
        additionalDirs: prepared.additionalDirs,
        roleAdditional: prepared.roleAdditional,
        drainAgentTasksOnStop: KIMI_DRAIN_AGENT_TASKS_ON_STOP,
        ...(prepared.payload.mcpServers.length > 0 ? { mcpServers } : {}),
      };
      const kimiHome = prepared.payload.env.find((entry) => entry.key === "KIMI_CODE_HOME")?.value.trim() ?? null;
      const effectiveHomeDir = kimiHome !== null && kimiHome.length === 0 ? null : kimiHome;
      try {
        const activeHarness = await ensureHarness(effectiveHomeDir ?? undefined);
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
        session = await activeHarness.resumeSession(input);
        sessionId = session.id;
        session.setApprovalHandler(hostedSessionApprovalHandler);
        await session.setPermission("yolo");
        if (prepared.payload.model) await session.setModel(prepared.payload.model);
        sessionActive = true;
        if (message) {
          initialTurnPreparing = true;
          const prompt = await sessionCtx.formatInboundContent(message);
          await runTurn(prompt, sessionCtx, [message], deliveryToken);
        }
      } catch (error) {
        await cleanupFailedInitialization();
        throw error;
      } finally {
        initialTurnPreparing = false;
        scheduleQueuedMessagesDrain();
      }
      return { sessionId, route: message ? { kind: "owned", mode: "processing" } : null };
    },

    inject(message, token) {
      if (!ctx || !sessionActive) return { kind: "rejected", reason: "no_active_context", retryable: true };
      queuedMessages.push({ message, token });
      scheduleQueuedMessagesDrain();
      return { kind: "owned", mode: "queued" };
    },

    async suspend(reason) {
      sessionActive = false;
      retryQueuedMessages(reason ?? "kimi_suspend_before_terminal");
      try {
        await session?.cancel();
      } catch {
        // The session may already have completed between the liveness fence and cancel.
      }
      try {
        await currentTurnPromise;
      } catch {
        // The turn path already translated or rescheduled its failure.
      }
      currentTurnPromise = null;
      await closeActiveSession();
      initialTurnPreparing = false;
      activeTools.clear();
    },

    async shutdown(reason) {
      sessionActive = false;
      retryQueuedMessages(reason ?? "kimi_shutdown_before_terminal");
      try {
        await session?.cancel();
      } catch {
        // best-effort cancellation
      }
      try {
        await currentTurnPromise;
      } catch {
        // translated by runTurn
      }
      currentTurnPromise = null;
      await closeActiveSession();
      await closeHarness();
      cwd = null;
      ctx = null;
      sessionId = null;
      activePayload = null;
      initialTurnPreparing = false;
      activeTools.clear();
    },
  } satisfies AgentHandler;
};
