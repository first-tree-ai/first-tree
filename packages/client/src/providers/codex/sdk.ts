import { isAbsolute, join, resolve } from "node:path";
import {
  type AgentRuntimeConfig,
  type AgentRuntimeConfigPayload,
  deriveRepoLocalPath,
  encodeProviderRetryEventMessage,
  isLandingCampaignTrialAgentMetadata,
  runtimeProviderSchema,
  type SessionEvent,
  type ToolFileRef,
} from "@first-tree/shared";
import {
  Codex,
  type CodexOptions,
  type Input,
  type Thread,
  type ThreadItem,
  type ThreadOptions,
  type Usage,
} from "@openai/codex-sdk";
import type {
  AgentHandler,
  AgentIdentity,
  DeliveryToken,
  HandlerFactory,
  SessionContext,
  SessionMessage,
  TurnConsumedErrorReason,
} from "../../runtime/contracts.js";
import { noopDeliveryToken, requireDeliveryToken } from "../../runtime/contracts.js";
import type {
  AgentConfigCache,
  ChatContext,
  ContextTreeAttribution,
  ContextTreeGitWriteTracker,
  PredeclaredSourceRepo,
  ProviderAttemptSettlement,
} from "../../runtime/provider-support/index.js";
import {
  assertContextSourceCurrent,
  buildAgentBriefing,
  buildBriefingUpdateNotice,
  classifyProviderFailure,
  computeBriefingFingerprint,
  contextSourceFromHandlerConfig,
  createContextTreeGitWriteTracker,
  FIRST_TREE_WORKSPACE_MARKER,
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
  resolveGitRepoTargetPath,
  toolFileRefsFromShellCommand,
  writeSessionBriefingFingerprint,
} from "../../runtime/provider-support/index.js";
import { chunkAssistantText } from "../handlers/assistant-text.js";
import { formatAuthHint, isCodexAuthError } from "../handlers/auth-error-hint.js";
import { resolveTurnSettlement } from "../handlers/turn-settlement.js";
import { PROVIDER_SKILL_ROOTS } from "../skill-roots.js";
import {
  createCodexClientWithBinaryFallback,
  formatCodexBinaryMissingMessage,
  isCodexBinaryMissingError,
} from "./binary.js";
import {
  CodexStaleRolloutError,
  extractCodexStaleRolloutThreadId,
  isCodexStaleRolloutError,
  staleRolloutRecoveryMessage,
} from "./stale-rollout.js";
import {
  LANDING_TRIAL_TURN_COMPLETION_CONFIRM_FAILED,
  LandingTrialTurnCompletionConfirmError,
  turnCompletionIdForMessages,
} from "./turn-completion.js";

/**
 * Codex SDK does not export its `CodexConfigObject` type, so reproduce the
 * minimal shape we need (`mcp_servers.<name>.{...}`, `project_root_markers`).
 * Mirrors the recursive structure from the SDK's `dist/index.d.ts`.
 */
export type CodexConfigValue = string | number | boolean | CodexConfigValue[] | CodexConfigObject;
export type CodexConfigObject = { [key: string]: CodexConfigValue };

const RESULT_PREVIEW_LIMIT = 400;

/**
 * Build the provider-native Codex config shared by both handler engines.
 *
 * `service_tier` selects Standard (`default`), Fast (`fast`), or another
 * provider-advertised tier. Non-default tiers explicitly enable the stable
 * Fast-mode capability; Standard leaves the feature unset so provider-managed
 * policy remains authoritative. First Tree forwards the configured tier
 * unchanged and treats Codex's unsupported-tier warning as a configuration
 * failure instead of accepting a silently downgraded turn.
 */
export function buildCodexConfig(payload: AgentRuntimeConfigPayload): CodexConfigObject {
  const cfg: CodexConfigObject = {
    // Gap-2: anchor codex's project-root walk-up at the workspace marker
    // we wrote in bootstrap, so `AGENTS.md` is read from this workspace
    // instead of leaking up to the operator's repo or HOME.
    project_root_markers: [FIRST_TREE_WORKSPACE_MARKER],
  };
  if (payload.kind === "codex") {
    const serviceTier = configuredCodexServiceTier(payload);
    cfg.service_tier = serviceTier;
    if (serviceTier !== "default") {
      cfg.features = { fast_mode: true };
    }
  }
  if (payload.mcpServers.length === 0) return cfg;

  const mcpServers: CodexConfigObject = {};
  for (const m of payload.mcpServers) {
    if (m.transport === "stdio") {
      mcpServers[m.name] = { command: m.command, args: m.args ?? [] };
    } else {
      // http / sse — codex's TOML schema accepts url + optional headers.
      const entry: CodexConfigObject = { url: m.url };
      if (m.headers) entry.headers = m.headers;
      mcpServers[m.name] = entry;
    }
  }
  cfg.mcp_servers = mcpServers;
  return cfg;
}

/**
 * A newer Client can briefly talk to a Server that predates `serviceTier`
 * during a rolling upgrade. Treat that missing wire field like every legacy
 * Codex config row: explicit Standard mode.
 */
export function configuredCodexServiceTier(payload: AgentRuntimeConfigPayload): string {
  if (payload.kind !== "codex") return "default";
  const serviceTier: unknown = payload.serviceTier;
  return typeof serviceTier === "string" && serviceTier.length > 0 ? serviceTier : "default";
}

function canonicalCodexServiceTier(serviceTier: string): string {
  // Codex accepts `fast` as the product-facing request alias, then reports the
  // provider-canonical `priority` id in app-server ThreadStart/ResumeResponse.
  // This is response validation only: First Tree still forwards the configured
  // value unchanged and does not maintain model/account compatibility data.
  return serviceTier === "fast" ? "priority" : serviceTier;
}

export function codexServiceTiersEquivalent(configured: string, effective: string): boolean {
  return canonicalCodexServiceTier(configured) === canonicalCodexServiceTier(effective);
}

const UNSUPPORTED_CODEX_SERVICE_TIER_WARNING =
  /^Configured service tier `[^`]+` is not advertised as supported for model `[^`]+` and will be omitted from requests\.$/;

/**
 * Codex 0.144.1 reports an unsupported provider-native service tier as a
 * warning and then proceeds without that tier. Both handler engines use this
 * predicate to turn that otherwise-silent downgrade into a terminal
 * configuration error.
 */
export function isUnsupportedCodexServiceTierWarning(message: string): boolean {
  return UNSUPPORTED_CODEX_SERVICE_TIER_WARNING.test(message.trim());
}

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

/**
 * Chat-visible notice posted when a turn is detected as a usage-limit empty
 * turn (issue #971 — codex account usage limit exhausted: the SDK reports
 * `turn.completed` with no reply and zero token consumption, i.e. the model
 * was never invoked). Delivered by an EXPLICIT `sdk.sendMessage(...,
 * purpose: "agent-final-text")` (a deliberate recipientless runtime notice —
 * NOT the retired final-text forward), authored as the agent itself, hence
 * first person. We deliberately do NOT include an ETA: codex-sdk@0.134 does
 * not expose `rate_limits.resets_at`, so there is no reliable recovery time to
 * quote.
 */
const USAGE_LIMIT_NOTICE =
  "⚠️ My runtime has reached its usage limit, so I couldn't process the message you just sent. " +
  "Please resend it once the limit resets.";

/**
 * Transient-error heuristic for `turn.failed` / SDK throws.
 *
 * The codex SDK surfaces `ThreadError = { message: string }` only — no
 * structured status code or `Retry-After`. We classify by keyword: HTTP 5xx,
 * common network-error mnemonics, and the explicit "overloaded" / "rate
 * limit" phrases the upstream model API uses. Auth, sandbox, and
 * configuration failures are deliberately NOT in this set — retrying them
 * just wastes attempts.
 *
 * Exported for tests so the classifier table is locked behavioural API.
 */
export function isTransientCodexErrorMessage(message: string): boolean {
  const classification = classifyProviderFailure(new Error(message), {
    provider: "codex",
    scope: "provider_turn",
    source: "sdk",
  });
  return classification.category === "transient_transport" || classification.category === "provider_capacity";
}

export function isCodexStreamDiagnosticMessage(message: string): boolean {
  return /\breconnecting\b.*\b\d+\s*\/\s*\d+\b/i.test(message);
}

/**
 * Tracks whether re-running this turn would double-emit a chat-visible item.
 * `reasoning` and the bare `error` item are presence-only / diagnostic and
 * safe to re-emit; everything else is rendered in the chat timeline.
 */
function isUserVisibleItem(item: ThreadItem): boolean {
  switch (item.type) {
    case "agent_message":
    case "command_execution":
    case "file_change":
    case "mcp_tool_call":
    case "web_search":
    case "todo_list":
      return true;
    case "reasoning":
    case "error":
      return false;
  }
}

/**
 * Codex's `turn.completed.usage` reports the **cumulative** token usage for
 * the whole thread, not the per-turn delta: on `codex exec resume` the CLI
 * seeds `total_token_usage` from the last `TokenCount` persisted in the
 * rollout (`session/mod.rs::last_token_info_from_rollout`) and keeps adding
 * to it, and the exec JSON layer emits `usage.total` (not `usage.last`). Each
 * First Tree turn is its own `codex exec resume` child, so the value we see
 * grows turn-over-turn (T1, T1+T2, T1+T2+T3, …). Emitting that verbatim makes
 * any consumer that sums `token_usage` events over-count triangularly.
 *
 * This converts the cumulative reading into the per-turn delta the
 * `token_usage` schema expects:
 *   - With a `baseline` (the previous turn's cumulative in this handler
 *     instance): subtract field-by-field, clamped at 0 so a compaction reset
 *     (`fill_to_context_window` lowers the total) under-counts one turn
 *     rather than emitting a negative.
 *   - No baseline + a brand-new thread (`start`): the cumulative IS this
 *     turn, so return it unchanged.
 *   - No baseline + a resumed thread (cold resume after a daemon restart):
 *     the cumulative already folds in prior turns we never observed, so there
 *     is nothing to subtract. Returning `null` skips the emit for exactly one
 *     turn — far better than reporting the whole thread-to-date as one turn.
 *
 * Pure + exported so the delta arithmetic is unit-testable without the full
 * handler bootstrap chain.
 */
export function computePerTurnUsageDelta(
  cumulative: Usage,
  baseline: Usage | null,
  threadIsFresh: boolean,
): Usage | null {
  if (!baseline) {
    return threadIsFresh ? { ...cumulative } : null;
  }
  return {
    input_tokens: Math.max(0, cumulative.input_tokens - baseline.input_tokens),
    cached_input_tokens: Math.max(0, cumulative.cached_input_tokens - baseline.cached_input_tokens),
    output_tokens: Math.max(0, cumulative.output_tokens - baseline.output_tokens),
    reasoning_output_tokens: Math.max(0, cumulative.reasoning_output_tokens - baseline.reasoning_output_tokens),
  };
}

/**
 * Abort-aware sleep. Resolves on either the timer firing or the abort
 * signal; on abort, rejects with `AbortError` so the caller can fall back
 * to the abort-aware code path in `runTurn` instead of running another
 * attempt against a cancelled turn.
 */
function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Build the per-turn `ThreadOptions` Codex consumes. Exported so unit tests
 * can lock the auth-mode-friendly defaults (notably `model` only set when
 * the operator chose one).
 */
export function buildCodexThreadOptions(payload: AgentRuntimeConfigPayload, workspaceCwd: string): ThreadOptions {
  const additionalDirectories: string[] = [];
  for (const repo of payload.gitRepos) {
    const localPath = repo.localPath ?? deriveRepoLocalPath(repo.url);
    if (!localPath) continue;
    // Predeclared source repos live under the agent home's `source-repos/`
    // directory (`<cwd>/source-repos/<localPath>`, via resolveGitRepoTargetPath)
    // — no `worktrees/` prefix. Codex's sandbox `workingDirectory` already
    // covers `<cwd>` and everything under it (including `source-repos/` and
    // agent-on-demand `worktrees/<name>/`), so this entry is technically
    // redundant; we keep it for parity + to make the allowlist explicit for ops.
    additionalDirectories.push(resolveGitRepoTargetPath(workspaceCwd, localPath));
  }
  // Only pin a model when the operator explicitly set one in the agent
  // config — leaving it unset lets the Codex CLI choose a default that
  // matches the user's auth mode (e.g. ChatGPT-account auth rejects the
  // `gpt-5-codex` family, while API-key auth accepts it). Hard-coding a
  // default here would force one auth mode and silently fail on the other.
  // Sandbox: ordinary codex agents remain `danger-full-access` because codex is
  // their primary local-execution surface. Landing campaign trials are forced
  // through the app-server handler, which supplies a custom managed permissions
  // profile instead of this SDK-only legacy sandbox field.
  const reasoningEffort = payload.kind === "codex" ? payload.reasoningEffort : "high";
  const opts: ThreadOptions = {
    workingDirectory: workspaceCwd,
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    // Operator-configured reasoning effort. Defaults to "high" (the value this
    // previously hard-coded). Codex CLI/app-server 0.144.1 accepts the newer
    // provider-native "max" and "ultra" values, but the SDK's TypeScript union
    // still stops at "xhigh" even though its runtime serializer forwards the
    // literal as `model_reasoning_effort`. Keep this assertion isolated at the
    // third-party boundary until the upstream declaration catches up.
    modelReasoningEffort: reasoningEffort as ThreadOptions["modelReasoningEffort"],
    webSearchEnabled: false,
    additionalDirectories,
  };
  if (payload.model) opts.model = payload.model;
  return opts;
}

/**
 * Thin wrapper over the unified {@link buildAgentBriefing} kept for the
 * codex-bootstrap test suite. Production start/resume/hot-switch paths go
 * through {@link projectManagedWorkspace} / {@link prepareManagedSession}.
 */
export function buildCodexAgentBriefing(
  identity: AgentIdentity,
  payload: AgentRuntimeConfigPayload,
  _chatContext: ChatContext | undefined,
  workspaceCwd: string,
  sourceRepos: ReadonlyArray<PredeclaredSourceRepo>,
  contextTreePath: string | null = null,
): string {
  return buildAgentBriefing({
    identity,
    payload,
    workspacePath: workspaceCwd,
    sourceRepos,
    contextTreePath,
  });
}

function contextTreeTargetPathOf(
  filePath: string,
  attribution: ContextTreeAttribution,
  workspaceCwd: string,
): string | null {
  const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(workspaceCwd, filePath);
  // Containment (canonical, symlink-safe) or repo identity (tree PR
  // worktrees — any checkout whose origin remote IS the Context Tree repo).
  const rel = resolveContextTreeRelativePath(absolutePath, attribution);
  return rel === null || rel === "/" ? null : rel;
}

export function collectCodexFileChangePaths(changes: unknown): string[] {
  const paths: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      paths.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const key of ["path", "file_path", "filePath", "filename"]) {
      const candidate = record[key];
      if (typeof candidate === "string") paths.push(candidate);
    }
    for (const key of Object.keys(record)) {
      if (key.includes("/") || key.includes("\\")) paths.push(key);
    }
  };
  visit(changes);
  return paths;
}

export function toolFileRefsFromCodexFileChange(input: {
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

export function appendGitStatusDeltaRefs(input: {
  existingRefs?: readonly ToolFileRef[];
  gitWriteTracker?: ContextTreeGitWriteTracker | null;
  toolName: string;
  toolUseId: string;
}): ToolFileRef[] | undefined {
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

export function toolFileRefsForTerminalCodexTool(input: {
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
  return appendGitStatusDeltaRefs(input);
}

/**
 * Codex Handler — session-oriented handler using `@openai/codex-sdk`.
 *
 * Each instance owns one Thread for one chat. Each turn is a fresh
 * `runStreamed()` call (Codex CLI is run-to-completion per turn). Inject
 * during an active turn buffers messages and runs them as a follow-up turn
 * the moment the current one completes.
 *
 * Key footguns observed end-to-end (private plan §10.7):
 *   - F1: providing `env` to Codex SDK does NOT inherit `process.env`; we
 *         explicitly merge.
 *   - F2: `resumeThread(id)` does NOT inherit `ThreadOptions`; we re-pass
 *         them every time.
 *   - F3: `modelReasoningEffort: "minimal"` is incompatible with default
 *         tools; we default to `"high"` with `webSearchEnabled: false`.
 *   - F6: `Thread` has no close/dispose — shutdown is exclusively
 *         `AbortController.abort()`.
 */
export const createCodexSdkHandler: HandlerFactory = (config) => {
  const workspaceRoot = config.workspaceRoot as string;
  const agentName = typeof config.agentName === "string" ? config.agentName : "";
  const runtimeProvider = runtimeProviderSchema.parse(config.runtimeProvider);
  const providerTurnMaxRetries = maxProviderTurnRetryAttempts();
  let activePayload: AgentRuntimeConfigPayload | null = null;
  const agentConfigCache = (config.agentConfigCache as AgentConfigCache | undefined) ?? null;
  const contextSource = contextSourceFromHandlerConfig(config);
  const contextTree = preparationCoordinatesFromSource(contextSource);
  const gitAttribution = remoteGitAttributionFromSource(contextSource);
  const contextTreePath = gitAttribution.contextTreePath;
  const contextTreeRepoUrl = gitAttribution.contextTreeRepoUrl;
  const contextTreeBranch = contextTree.kind === "remote" ? contextTree.branch : null;

  let cwd: string | null = null;
  let codex: Codex | null = null;
  let thread: Thread | null = null;
  let threadId: string | null = null;
  let activeProviderEnv: Record<string, string> | null = null;
  // Best-effort label for the current Codex thread's model — recorded from the
  // last `buildCodexThreadOptions` call so `token_usage` events can carry a
  // model name. The SDK does not echo back the actual model used (the CLI may
  // pick a default when `payload.model` is empty), so this is whatever the
  // operator configured; absence is surfaced as the placeholder below.
  let currentModel = "";
  // Codex reports CUMULATIVE thread usage on every `turn.completed` (see
  // `computePerTurnUsageDelta`). Track the previous turn's cumulative so we
  // can emit the per-turn delta, and whether THIS handler instance opened a
  // brand-new thread (`start`) — only then is the first reading a true
  // single-turn value with a zero baseline. A cold `resume` leaves both unset
  // so the first post-resume turn is skipped rather than over-counted.
  let prevCumulativeUsage: Usage | null = null;
  let threadIsFresh = false;
  let currentAbort: AbortController | null = null;
  let currentTurnPromise: Promise<void> | null = null;
  let ctx: SessionContext | null = null;
  const gitWriteTracker = createContextTreeGitWriteTracker({
    contextTreePath,
    contextTreeRepoUrl,
    contextTreeBranch,
    log: (message) => ctx?.log(message),
  });
  let drainScheduled = false;
  let drainInProgress = false;
  let initialTurnPreparing = false;
  const queuedMessages: Array<{ message: SessionMessage; token: DeliveryToken }> = [];
  /**
   * One-shot provider context for Codex. Codex SDK exposes no system-prompt
   * channel, so the session/resume chat context is prepended to the next
   * provider turn input and then cleared. Retries of that same turn reuse the
   * already-wrapped input; later queued/injected user turns do not receive a
   * repeated context block.
   */
  let pendingChatContextPrompt: string | null = null;

  function emitProviderTurnSettlementEvent(sessionCtx: SessionContext, settlement: ProviderAttemptSettlement): void {
    sessionCtx.emitEvent({
      kind: "error",
      payload: {
        source: "runtime",
        message: encodeProviderRetryEventMessage(settlement.eventPayload),
      },
    });
  }

  function buildEnv(sessionCtx: SessionContext): Record<string, string> {
    // Footgun F1: when `CodexOptions.env` is provided the SDK does NOT
    // inherit `process.env`, so HOME/PATH/etc. would be missing. Start by
    // explicitly cloning every defined parent var.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    const payload = agentConfigCache?.get(sessionCtx.agent.agentId)?.payload;
    if (payload) {
      for (const e of payload.env) env[e.key] = e.value;
    }
    const merged = sessionCtx.buildAgentEnv(env);
    // The First Tree envelope returns `Record<string, string | undefined>`; trim out
    // undefined values so the SDK doesn't see them.
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(merged)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }

  function createCodexClient(options: CodexOptions, sessionCtx: SessionContext): Codex {
    const resolved = createCodexClientWithBinaryFallback<CodexOptions, Codex>(
      options,
      (nextOptions) => new Codex(nextOptions),
      { log: (message) => sessionCtx.log(message) },
    );
    return resolved.client;
  }

  function formatCodexSdkError(message: string): string {
    if (isCodexAuthError(message)) return formatAuthHint("codex", message);
    if (isCodexBinaryMissingError(message)) return formatCodexBinaryMissingMessage(message);
    return message;
  }

  function toCodexInput(message: SessionMessage, sessionCtx: SessionContext): Promise<Input> {
    return sessionCtx.formatInboundContent(message).then((text) => text);
  }

  function consumePendingChatContext(input: Input): Input {
    const chatPrompt = pendingChatContextPrompt;
    pendingChatContextPrompt = null;
    // Codex has no persistent system-prompt channel (unlike the Claude path's
    // `systemPrompt.append`), so the same provider-neutral runtime contract
    // rides every turn input — keeping the console/outbox boundary in the
    // immediate context tail where a "discuss only / hold off" instruction also
    // lands. Prepended ahead of any chat-context block.
    const contract = renderRuntimeOutputContract();
    const prefix = chatPrompt ? `${contract}\n\n${chatPrompt}` : contract;
    if (typeof input === "string") return `${prefix}\n\n${input}`;
    return [{ type: "text", text: prefix }, ...input];
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

  /**
   * Translate one terminal `item.completed` payload into the runtime's event
   * stream and, when the item is assistant text, return the raw text so
   * `runTurn` can track the SDK-style final response.
   */
  function processItem(item: ThreadItem, sessionCtx: SessionContext): string {
    switch (item.type) {
      case "agent_message": {
        // Skip whitespace-only assistant messages — they'd otherwise clutter
        // the events stream with empty `assistant_text` rows. Mirrors the
        // claude-code handler's `text.trim()` guard.
        if (!item.text.trim()) return "";
        // Chunk so the FULL assistant text is preserved across one or more
        // events — the durable troubleshooting record now that the per-turn
        // final-text chat mirror is retired.
        for (const chunk of chunkAssistantText(item.text)) {
          sessionCtx.emitEvent({ kind: "assistant_text", payload: { text: chunk } });
        }
        return item.text;
      }
      case "command_execution": {
        const status =
          item.status === "completed"
            ? ("ok" as const)
            : item.status === "failed"
              ? ("error" as const)
              : ("pending" as const);
        const shellRefs =
          status === "ok" && cwd
            ? toolFileRefsFromShellCommand({
                command: item.command,
                cwd,
                contextTreePath,
                contextTreeRepoUrl,
                contextTreeBranch,
              })
            : undefined;
        const toolFileRefs = toolFileRefsForTerminalCodexTool({
          status,
          existingRefs: shellRefs,
          gitWriteTracker,
          toolName: "command",
          toolUseId: item.id,
        });
        emitToolCall(sessionCtx, {
          toolUseId: item.id,
          name: "command",
          args: { command: item.command, ...(cwd ? { cwd } : {}) },
          status,
          resultPreview: item.aggregated_output,
          toolFileRefs,
        });
        return "";
      }
      case "file_change": {
        const status = item.status === "completed" ? ("ok" as const) : ("error" as const);
        const fileChangeRefs =
          status === "ok" && cwd
            ? toolFileRefsFromCodexFileChange({
                changes: item.changes,
                workspaceCwd: cwd,
                contextTreePath,
                contextTreeRepoUrl,
                contextTreeBranch,
              })
            : undefined;
        const toolFileRefs = toolFileRefsForTerminalCodexTool({
          status,
          existingRefs: fileChangeRefs,
          gitWriteTracker,
          toolName: "file_change",
          toolUseId: item.id,
        });
        emitToolCall(sessionCtx, {
          toolUseId: item.id,
          name: "file_change",
          args: { changes: item.changes },
          status,
          toolFileRefs,
        });
        return "";
      }
      case "mcp_tool_call": {
        const status =
          item.status === "completed"
            ? ("ok" as const)
            : item.status === "failed"
              ? ("error" as const)
              : ("pending" as const);
        const resultPreview = item.error
          ? `error: ${item.error.message}`
          : item.result
            ? JSON.stringify(item.result.structured_content ?? item.result.content)
            : undefined;
        emitToolCall(sessionCtx, {
          toolUseId: item.id,
          name: `mcp:${item.server}/${item.tool}`,
          args: item.arguments,
          status,
          resultPreview,
        });
        return "";
      }
      case "web_search": {
        emitToolCall(sessionCtx, {
          toolUseId: item.id,
          name: "web_search",
          args: { query: item.query },
          status: "ok",
        });
        return "";
      }
      case "todo_list": {
        // Codex's running plan / scratchpad — render as a tool_call so the UI
        // surfaces it without needing a dedicated event kind.
        emitToolCall(sessionCtx, {
          toolUseId: item.id,
          name: "todo_list",
          args: { items: item.items },
          status: "ok",
        });
        return "";
      }
      case "reasoning": {
        // Hide reasoning content for parity with how claude-code suppresses
        // thinking blocks; surface a presence-only marker instead.
        sessionCtx.emitEvent({ kind: "thinking", payload: {} });
        return "";
      }
      case "error": {
        // Codex's `~/.codex/auth.json` refresh failures surface here when the
        // SDK bubbles them as item-level errors rather than turn.failed. The
        // raw wording is shaped like "Your access token could not be refreshed
        // because your refresh token was revoked. Please log out and sign in
        // again." — opaque to a First Tree user. Reframe at the boundary so
        // the next step (run `codex login` in their own terminal) is obvious.
        const message = formatCodexSdkError(item.message);
        sessionCtx.emitEvent({
          kind: "error",
          payload: { source: "tool", message },
        });
        return "";
      }
      default:
        return "";
    }
  }

  /**
   * Run one Codex turn.
   *
   * `messages` is the concrete inbox batch this turn consumed — always one
   * message for start / resume / single-inject paths, and N when mergeAndRun
   * fuses queued messages into one input. Completion acks through the last
   * consumed message id instead of shifting a count from SessionRuntime state.
   */
  /**
   * Returns whether the turn was actually delivered to the provider and
   * settled as complete. The briefing-update notice rides this turn's input
   * (consumed from `pendingChatContextPrompt`), so the caller must only advance
   * the briefing baseline when this is `true` — a pre-provider / aborted /
   * retried turn never showed the notice to the model, and a redelivery must
   * still surface it.
   */
  async function runTurn(
    input: Input,
    sessionCtx: SessionContext,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
  ): Promise<boolean> {
    const activeThread = thread;
    if (!activeThread) {
      token.retry(messages, "codex_missing_thread");
      return false;
    }
    const providerInput = consumePendingChatContext(input);

    token.processingStarted(messages);
    const abort = new AbortController();
    currentAbort = abort;
    gitWriteTracker.captureBaseline();

    let finalResponse = "";
    const providerCompletedBox: { value: boolean } = { value: false };
    const diagnosticErrorEmittedBox: { value: boolean } = { value: false };
    const consumedErrorReasonBox: { value: TurnConsumedErrorReason | null } = { value: null };
    let userVisibleEmitted = false;
    // Wrapper object so TS doesn't narrow `lastUsage` to `null` based on the
    // synchronous initializer (assignments live inside the IIFE below, which
    // TS' control-flow analysis can't reach — microsoft/TypeScript#9998).
    const usageBox: { value: Usage | null } = { value: null };
    const turnStartedAt = Date.now();
    const retryAfterHelperStopBox: { value: string | null } = { value: null };
    let lastProviderAttempt: ProviderAttempt | null = null;
    let lastProviderAttemptNumber = 1;

    const updateAttemptReplaySafety = (
      attemptState: ProviderAttempt,
      providerEntered: boolean,
      providerCapacity: boolean,
    ): void => {
      if (userVisibleEmitted) {
        attemptState.markUserVisibleOutput();
      } else if (!providerEntered) {
        attemptState.setReplaySafety("pre_provider");
      } else if (providerCapacity) {
        attemptState.setReplaySafety("provider_entered");
      } else {
        attemptState.setReplaySafety("pre_visible");
      }
    };
    const stopCodexFailure = (settlement: ProviderAttemptSettlement): void => {
      emitProviderTurnSettlementEvent(sessionCtx, settlement);
      const decision = settlement.decision;
      if (decision.action !== "stop") return;
      if (decision.replaySafety === "pre_provider" && decision.terminalKind === "exhausted") {
        retryAfterHelperStopBox.value = decision.reasonCode;
      } else {
        consumedErrorReasonBox.value =
          decision.terminalKind === "capacity_wait_required"
            ? "capacity_wait_required"
            : decision.terminalKind === "exhausted"
              ? "provider_retry_exhausted"
              : decision.reasonCode;
      }
      const formatted = formatCodexSdkError(settlement.messagePreview);
      sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: formatted } });
    };
    const promise = (async () => {
      for (let attempt = 0; ; attempt++) {
        // Reset per-attempt; finalResponse intentionally persists across
        // attempts only because we abort retries the moment any user-visible
        // item is emitted, so it is empty whenever a retry runs.
        providerCompletedBox.value = false;
        diagnosticErrorEmittedBox.value = false;
        consumedErrorReasonBox.value = null;
        let retryRequested = false;
        let retryDelay = 0;
        let retryReason = "";
        const providerAttempt = new ProviderAttempt({
          provider: runtimeProvider,
          scope: "provider_turn",
          source: "sdk",
        });
        lastProviderAttempt = providerAttempt;
        lastProviderAttemptNumber = attempt + 1;

        const applySettlement = (settlement: ProviderAttemptSettlement, reasonPrefix: string): void => {
          if (settlement.decision.action === "retry") {
            retryRequested = true;
            retryDelay = settlement.decision.delayMs;
            retryReason = `${reasonPrefix} (${settlement.classification.category}): ${settlement.messagePreview}`;
            emitProviderTurnSettlementEvent(sessionCtx, settlement);
            return;
          }
          stopCodexFailure(settlement);
        };

        // Per-attempt child AbortController (PR #600 review nit #4): keep
        // parent suspend/shutdown cancellation scoped to the active
        // runStreamed() call without reusing the parent signal across retry
        // attempts. Retry teardown itself is handled by closing the async
        // iterator; aborting this signal after the SDK stream has closed can
        // surface a late ChildProcess AbortError after SDK listeners are gone.
        const attemptAbort = new AbortController();
        const onParentAbort = (): void => attemptAbort.abort();
        abort.signal.addEventListener("abort", onParentAbort, { once: true });

        try {
          try {
            const streamed = await activeThread.runStreamed(providerInput, { signal: attemptAbort.signal });
            for await (const event of streamed.events) {
              if (attemptAbort.signal.aborted) break;
              sessionCtx.recordProviderActivity();
              if (event.type === "thread.started") {
                threadId = event.thread_id;
              } else if (event.type === "turn.started") {
                // No-op — runtime state already "working".
              } else if (event.type === "item.completed") {
                if (event.item.type === "error" && isUnsupportedCodexServiceTierWarning(event.item.message)) {
                  providerAttempt.recordSignal({
                    kind: "provider_error",
                    error: new Error(`Codex service tier configuration failed: ${event.item.message}`),
                  });
                  const settlement = providerAttempt.settle({ attempt: attempt + 1 });
                  if (settlement) stopCodexFailure(settlement);
                  break;
                }
                const text = processItem(event.item, sessionCtx);
                if (text) finalResponse = text;
                if (isUserVisibleItem(event.item)) {
                  userVisibleEmitted = true;
                  providerAttempt.markUserVisibleOutput();
                }
              } else if (event.type === "item.started" || event.type === "item.updated") {
                // Stream-only intermediate states — claude-code likewise emits
                // events on terminal items only; codex's run-to-completion model
                // means the terminal item carries the full payload.
              } else if (event.type === "turn.completed") {
                // Capture usage for the post-turn metrics log; `turn_end` is
                // still emitted after forwardResult below.
                usageBox.value = event.usage;
                providerCompletedBox.value = true;
              } else if (event.type === "turn.failed") {
                const classification = providerAttempt.recordSignal({
                  kind: "provider_error",
                  error: new Error(event.error.message),
                });
                updateAttemptReplaySafety(providerAttempt, true, classification?.category === "provider_capacity");
                const settlement = providerAttempt.settle({ attempt: attempt + 1 });
                if (settlement) applySettlement(settlement, "turn.failed");
                break;
              } else if (event.type === "error") {
                // Codex SDK bare `error` stream events are diagnostic: they
                // can be followed by more items and a successful
                // `turn.completed` (for example reconnect progress). Only
                // treat explicit progress messages as diagnostic; ordinary
                // stream failures still go through the shared retry policy.
                if (isCodexStreamDiagnosticMessage(event.message)) {
                  diagnosticErrorEmittedBox.value = true;
                  const classification = providerAttempt.recordSignal({
                    kind: "diagnostic",
                    error: new Error(event.message),
                  });
                  if (classification) {
                    updateAttemptReplaySafety(providerAttempt, true, classification.category === "provider_capacity");
                    const settlement = providerAttempt.settle({ attempt: attempt + 1 });
                    if (settlement) applySettlement(settlement, "stream diagnostic");
                    break;
                  }
                  continue;
                }
                const classification = providerAttempt.recordSignal({
                  kind: "provider_error",
                  error: new Error(event.message),
                });
                updateAttemptReplaySafety(providerAttempt, true, classification?.category === "provider_capacity");
                const settlement = providerAttempt.settle({ attempt: attempt + 1 });
                if (settlement) applySettlement(settlement, "stream error");
                break;
              }
            }
          } catch (err) {
            if (abort.signal.aborted) return;
            if (isCodexStaleRolloutError(err)) {
              throw new CodexStaleRolloutError(err, threadId);
            }
            const msg = err instanceof Error ? err.message : String(err);
            const classification = providerAttempt.recordSignal({
              kind: "local_error",
              error: err instanceof Error ? err : new Error(msg),
            });
            updateAttemptReplaySafety(providerAttempt, false, classification?.category === "provider_capacity");
            const settlement = providerAttempt.settle({ attempt: attempt + 1 });
            if (settlement) applySettlement(settlement, "runStreamed threw");
          }
        } finally {
          // Detach the parent listener whether we retry or break. Even
          // with `{ once: true }` the listener may never fire (no
          // parent-abort during this attempt) — without removal we'd
          // leak one per attempt for the lifetime of the parent
          // controller (i.e. of this turn).
          abort.signal.removeEventListener("abort", onParentAbort);
        }

        if (!retryRequested) break;
        // Breaking out of the for-await has already closed the SDK event
        // iterator for this attempt. Do not abort the per-attempt spawn
        // signal here: in @openai/codex-sdk cleanup may already have removed
        // child listeners, and a late abort can become an unhandled
        // ChildProcess AbortError that crashes the client. The backoff still
        // listens to the parent signal below, so suspend/shutdown can cut it
        // short without starting another attempt.
        sessionCtx.log(
          `codex turn retry ${attempt + 1}/${providerTurnMaxRetries + 1} after ${retryDelay}ms; ${retryReason}`,
        );
        try {
          // Sleep on PARENT signal: only suspend/shutdown should cut
          // short the backoff window. The per-attempt signal belongs to the
          // already-closed SDK iterator and is intentionally left untouched.
          await sleepWithAbort(retryDelay, abort.signal);
        } catch {
          // AbortError — suspend/shutdown raced ahead; let the abort path
          // handle teardown.
          return;
        }
      }
    })();

    currentTurnPromise = promise;
    try {
      await promise;
    } finally {
      currentAbort = null;
      currentTurnPromise = null;
    }

    if (abort.signal.aborted) {
      // Suspend/shutdown raced ahead — let the abort handler set state. Not a
      // delivered turn: the notice (if any) must survive for the redelivery.
      return false;
    }

    // Match @openai/codex-sdk's Thread.run() success semantics: when a turn
    // emits several non-empty agent_message items, finalResponse is the latest
    // one. Every agent_message is already captured as `assistant_text` events
    // regardless; `accumulated` only feeds the turn-completion hook + success
    // gating below. If the provider never completes successfully, we don't
    // treat partial text as the turn's result.
    const accumulated = finalResponse;

    // Codex reports CUMULATIVE thread usage on `turn.completed`; convert it to
    // the per-turn delta the `token_usage` schema documents. Computed here
    // (before the forward decision) because the usage-limit empty-turn check
    // below reads the delta. `usageBox.value` is null when the turn never
    // reached `turn.completed` (abort / unrecoverable failure) — no totals to
    // diff, so leave the baseline untouched and skip both the emit and the log
    // below.
    const cumulativeUsage = usageBox.value;
    const perTurnUsage = cumulativeUsage
      ? computePerTurnUsageDelta(cumulativeUsage, prevCumulativeUsage, threadIsFresh)
      : null;
    if (cumulativeUsage) {
      // Advance the baseline even when `perTurnUsage` is null (the cold-resume
      // first turn): the NEXT turn must diff against this cumulative, not the
      // stale pre-resume value. Clearing `threadIsFresh` makes every later
      // turn take the subtract path.
      prevCumulativeUsage = cumulativeUsage;
      threadIsFresh = false;
    }

    // Issue #971 — usage-limit empty-turn detection. When the codex account
    // usage limit is exhausted, the SDK emits `turn.completed` almost instantly
    // with NO agent_message item and ZERO token consumption: the model was
    // never invoked. On the surface that is identical to the legitimate
    // "silent turn" protocol (the agent chose to stay silent — see
    // result-sink.ts forwardResult), with ONE discriminator: a chosen silence
    // still ran the model and so burned input tokens, whereas a usage-limit
    // turn burns zero. So `empty finalResponse + turn.completed fired + zero
    // per-turn delta` means the model never ran (quota / credits exhausted),
    // and we surface it rather than ack it away as a phantom success.
    //
    // `perTurnUsage === null` is the cold-resume first turn (no baseline to
    // diff) — we cannot decide there, so we do NOT flag it (avoids false
    // positives) and let it fall through to the normal path.
    const zeroTokenDelta =
      perTurnUsage !== null &&
      perTurnUsage.input_tokens === 0 &&
      perTurnUsage.cached_input_tokens === 0 &&
      perTurnUsage.output_tokens === 0 &&
      perTurnUsage.reasoning_output_tokens === 0;
    const helperConsumedErrorReason = consumedErrorReasonBox.value;
    const providerCompleted = providerCompletedBox.value;
    const completedSuccessfully = providerCompleted && helperConsumedErrorReason === null;
    const usageLimitEmptyTurn = completedSuccessfully && accumulated.trim().length === 0 && zeroTokenDelta;

    let forwardFailed = false;
    let retryReason: string | null = retryAfterHelperStopBox.value;
    let consumedErrorReason: TurnConsumedErrorReason | null = helperConsumedErrorReason;
    if (usageLimitEmptyTurn) {
      // Layer 2 (observability): emit an error event + warn-level log so the
      // daemon log and admin event stream record a real failure instead of a
      // phantom `turn_end: success`. Runtime state still goes idle after the
      // visible notice is delivered; auto-redelivery is tracked separately
      // (see #971 discussion) because it needs a reset-aware trigger + loop
      // guard that the SDK's missing `rate_limits` can't supply.
      sessionCtx.emitEvent({
        kind: "error",
        payload: {
          source: "runtime",
          message:
            "codex usage limit reached: turn completed with no model invocation (empty reply, zero token delta); message not processed",
        },
      });
      sessionCtx.log(
        `codex usage limit reached chatId=${sessionCtx.chatId}: empty turn, model not invoked (zero token delta); ` +
          "posting a chat notice instead of silently acking the message",
      );
      // Layer 1-A (visibility): post a chat-visible notice so a human observer
      // sees WHY their message got no reply, rather than digging through codex
      // rollout files. This is a deliberate, EXPLICIT send — NOT the retired
      // final-text forward (`forwardResult` no longer delivers anything). It
      // goes through the dedicated runtime-notice endpoint, which owns the
      // recipientless notify=false delivery profile and the server-side
      // `runtimeNotice` marker.
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
    } else if (completedSuccessfully && accumulated.trim()) {
      try {
        // Turn-completion hook. The agent text is already captured as
        // `assistant_text` events; `forwardResult` no longer delivers it to
        // chat (final-text mirror retired) — it just closes the turn trigger.
        await sessionCtx.forwardResult(accumulated);
      } catch (err) {
        forwardFailed = true;
        const msg = err instanceof Error ? err.message : String(err);
        sessionCtx.emitEvent({
          kind: "error",
          payload: { source: "runtime", message: `forwardResult failed: ${msg}` },
        });
      }
    } else if (consumedErrorReason) {
      sessionCtx.log(`codex turn stopped with consumed provider error: ${consumedErrorReason}`);
    } else if (!retryReason && !providerCompleted) {
      const streamEndReason = diagnosticErrorEmittedBox.value
        ? "codex_stream_ended_after_diagnostic_error"
        : "codex_stream_ended_without_completion";
      const message = userVisibleEmitted
        ? `${streamEndReason}: stream ended without turn.completed after user-visible output`
        : `${streamEndReason}: stream ended without turn.completed`;
      const attemptState =
        lastProviderAttempt ??
        new ProviderAttempt({
          provider: runtimeProvider,
          scope: "provider_turn",
          source: "sdk",
        });
      if (userVisibleEmitted) {
        attemptState.markUserVisibleOutput();
      } else {
        attemptState.setReplaySafety("pre_provider");
      }
      const streamEndSettlement = attemptState.settle({
        attempt: lastProviderAttemptNumber,
        fallback: {
          kind: "transport_close",
          error: new Error(message),
        },
      });
      if (streamEndSettlement?.decision.action === "stop") {
        emitProviderTurnSettlementEvent(sessionCtx, streamEndSettlement);
        if (
          streamEndSettlement.decision.replaySafety === "pre_provider" &&
          streamEndSettlement.decision.terminalKind === "exhausted"
        ) {
          retryReason = streamEndSettlement.decision.reasonCode;
          sessionCtx.log(`codex stream ended without turn.completed; scheduling recovery (${retryReason})`);
        } else {
          consumedErrorReason =
            streamEndSettlement.decision.terminalKind === "capacity_wait_required"
              ? "capacity_wait_required"
              : streamEndSettlement.decision.terminalKind === "exhausted"
                ? "provider_retry_exhausted"
                : streamEndSettlement.decision.reasonCode;
          sessionCtx.emitEvent({
            kind: "error",
            payload: { source: "sdk", message: formatCodexSdkError(streamEndSettlement.messagePreview) },
          });
          sessionCtx.log(
            `codex stream ended without turn.completed; stopping replay (${streamEndSettlement.decision.reasonCode})`,
          );
        }
      } else if (streamEndSettlement?.decision.action === "retry") {
        emitProviderTurnSettlementEvent(sessionCtx, streamEndSettlement);
        retryReason = streamEndSettlement.decision.reasonCode;
        sessionCtx.log(`codex stream ended without turn.completed; scheduling recovery (${retryReason})`);
      } else {
        retryReason = streamEndReason;
        sessionCtx.log(`codex stream ended without turn.completed; scheduling recovery (${retryReason})`);
      }
    }

    const settlement = resolveTurnSettlement({
      retryReason,
      consumedErrorReason,
      forwardFailed,
    });

    // Emit `token_usage` just before `turn_end` so the wire-order matches the
    // claude-code handler (consumers can group all usage events for a turn
    // between the previous and current `turn_end`).
    if (perTurnUsage) {
      try {
        sessionCtx.emitEvent({
          kind: "token_usage",
          payload: {
            provider: "codex",
            model: currentModel || "codex-default",
            // Codex's `input_tokens` is the TOTAL prompt incl. its cached
            // subset (`codex-rs` derives non_cached = input - cached). The
            // schema's `inputTokens` is the NON-cached portion, disjoint from
            // `cachedInputTokens` — subtract to match the claude-code
            // handler's contract instead of double-counting the cache.
            inputTokens: Math.max(0, perTurnUsage.input_tokens - perTurnUsage.cached_input_tokens),
            cachedInputTokens: perTurnUsage.cached_input_tokens,
            outputTokens: perTurnUsage.output_tokens,
          },
        });
      } catch (err) {
        sessionCtx.log(`Failed to emit token_usage: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const turnDelivered = settlement.action.kind === "complete";
    if (settlement.action.kind === "complete") {
      const isLandingTrial = isLandingCampaignTrialAgentMetadata(sessionCtx.agent.metadata);
      try {
        await emitTurnEnd(sessionCtx, {
          kind: "turn_end",
          payload: {
            status: settlement.status,
            ...(settlement.status === "success" && isLandingTrial
              ? { turnCompletionId: turnCompletionIdForMessages(messages) }
              : {}),
          },
        });
      } catch (err) {
        if (!(err instanceof LandingTrialTurnCompletionConfirmError)) throw err;
        sessionCtx.log(`landing trial turn completion confirmation failed after provider completion: ${err.message}`);
        token.retry(messages, LANDING_TRIAL_TURN_COMPLETION_CONFIRM_FAILED);
        await closeSdkSessionAfterUncommittablePrefix(sessionCtx, LANDING_TRIAL_TURN_COMPLETION_CONFIRM_FAILED);
        return false;
      }
      await token.complete(messages, settlement.action.outcome);
    } else {
      sessionCtx.emitEvent({
        kind: "turn_end",
        payload: { status: settlement.status },
      });
      token.retry(messages, settlement.action.reason);
    }

    // Structured usage / timing log — emitted via `sessionCtx.log` rather
    // than a new SessionEvent kind so we stay inside the codex handler
    // (shared schema unchanged). Codex's `high` reasoning + larger context
    // makes per-turn cost 3-5× claude-code at the same input length; without
    // this line operators cannot account for spend per chat. Logs the SAME
    // per-turn delta as the event (non-cached input split out) so the log and
    // the wire agree; `null` for an abort / cold-resume first turn we skip.
    if (perTurnUsage) {
      sessionCtx.log(
        `codex usage chatId=${sessionCtx.chatId} duration_ms=${Date.now() - turnStartedAt} ` +
          `input_tokens=${Math.max(0, perTurnUsage.input_tokens - perTurnUsage.cached_input_tokens)} ` +
          `cached_input_tokens=${perTurnUsage.cached_input_tokens} ` +
          `output_tokens=${perTurnUsage.output_tokens} reasoning_output_tokens=${perTurnUsage.reasoning_output_tokens} ` +
          `status=${settlement.status}`,
      );
    }

    scheduleQueuedMessagesDrain();
    return turnDelivered;
  }

  async function runTurnWithStaleRolloutRecovery(
    input: Input,
    sessionCtx: SessionContext,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
    payload: AgentRuntimeConfigPayload,
  ): Promise<boolean> {
    const promptSnapshot = pendingChatContextPrompt;
    const staleThreadIdBeforeTurn = threadId;
    try {
      return await runTurn(input, sessionCtx, messages, token);
    } catch (err) {
      if (!isCodexStaleRolloutError(err)) throw err;
      const staleThreadId = extractCodexStaleRolloutThreadId(err) ?? staleThreadIdBeforeTurn ?? threadId ?? null;
      if (!codex || !cwd) throw err;

      pendingChatContextPrompt = promptSnapshot;
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
        token.retry(messages, "codex_context_source_changed");
        sessionCtx.failSessionForRecovery?.("codex_context_source_changed", threadId ?? undefined);
        return false;
      }

      thread = codex.startThread(buildCodexThreadOptions(payload, cwd));
      threadId = null;
      prevCumulativeUsage = null;
      threadIsFresh = true;

      const delivered = await runTurn(input, sessionCtx, messages, token);
      if (!threadId) threadId = thread?.id ?? null;
      if (threadId) {
        sessionCtx.replaceSessionId?.(threadId, "codex_stale_rollout_recovered");
        sessionCtx.emitEvent({
          kind: "error",
          payload: { source: "runtime", message: staleRolloutRecoveryMessage(staleThreadId, threadId) },
        });
      }
      return delivered;
    }
  }

  function scheduleQueuedMessagesDrain(): void {
    if (drainScheduled || drainInProgress) return;
    if (queuedMessages.length === 0 || !ctx || !thread || currentTurnPromise || initialTurnPreparing) return;

    drainScheduled = true;
    setImmediate(() => {
      drainScheduled = false;
      if (
        drainInProgress ||
        queuedMessages.length === 0 ||
        !ctx ||
        !thread ||
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
          sessionCtx.log(`codex queued turn failed: ${err instanceof Error ? err.message : String(err)}`);
          for (const queued of drained) queued.token.retry(queued.message, "codex_queued_turn_failed");
        })
        .finally(() => {
          drainInProgress = false;
          scheduleQueuedMessagesDrain();
        });
    });
  }

  /**
   * Active-session config hot-switch for Codex. A Codex thread reads AGENTS.md
   * once at thread init and never re-reads it, and — unlike the Claude SDK
   * handler — there is no query restart on the inject path. So when an admin
   * changes the agent prompt mid-session, an injected message would otherwise
   * run a fresh turn still under the OLD briefing until the next suspend/resume.
   *
   * Before an injected turn we rebuild the briefing from the latest cached
   * config (kept fresh by config-update pushes, same source the Claude
   * hot-switch reads). If it changed, rewrite AGENTS.md on disk and report the
   * change so the caller prepends the one-time re-read notice — the agent then
   * re-reads the now-current AGENTS.md before acting. Synchronous + `.get()` so
   * It awaits the managed Skill settlement before rewriting the briefing.
   * Model / MCP hot-switch (which would need a thread restart) stays out of
   * scope; this targets Skills plus the prompt.
   */
  async function refreshBriefingForActiveTurn(
    sessionCtx: SessionContext,
  ): Promise<{ fingerprint: string; changed: boolean } | null> {
    if (!agentConfigCache || !cwd || !threadId || !activeProviderEnv) return null;
    // Never throw: this runs on the inject drain path AFTER the batch has been
    // dequeued, so a thrown briefing rewrite would strand the message (no
    // turn/start, no token.retry). On any failure, skip the hot-switch for this
    // turn — the message still delivers under the prior briefing, and the next
    // injected turn retries the refresh.
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

  async function mergeAndRun(
    drained: Array<{ message: SessionMessage; token: DeliveryToken }>,
    sessionCtx: SessionContext,
  ): Promise<void> {
    const inputs: string[] = [];
    const messages = drained.map((entry) => entry.message);
    const token = drained[0]?.token;
    if (!token) return;
    // Active-session hot-switch BEFORE formatting: the Team Skill command
    // registry fence rejects a message stamped with a newer config version,
    // and only this reconcile can publish the registry that lets the retry
    // succeed — formatting first would deadlock the turn on its own fence.
    const refreshed = await refreshBriefingForActiveTurn(sessionCtx);
    if (refreshed?.changed && cwd) {
      const notice = buildBriefingUpdateNotice(join(cwd, "AGENTS.md"));
      pendingChatContextPrompt = pendingChatContextPrompt ? `${notice}\n\n${pendingChatContextPrompt}` : notice;
      sessionCtx.log(`Active session briefing changed — prepending re-read notice (${threadId})`);
    }
    let hadFormatFailure = false;
    for (const m of messages) {
      try {
        inputs.push(await sessionCtx.formatInboundContent(m));
      } catch (err) {
        hadFormatFailure = true;
        sessionCtx.log(`codex inject formatInboundContent failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (hadFormatFailure || inputs.length === 0) {
      // The provider has not seen this exact batch, so there is no durable
      // terminal evidence for any failed entry. Keep the whole batch recoverable
      // rather than ACKing a gap or delivering a partial fused prompt.
      for (const queued of drained) queued.token.retry(queued.message, "codex_queued_turn_format_failed");
      return;
    }
    const payload = activePayload;
    const delivered = payload
      ? await runTurnWithStaleRolloutRecovery(inputs.join("\n\n"), sessionCtx, messages, token, payload)
      : await runTurn(inputs.join("\n\n"), sessionCtx, messages, token);
    if (refreshed?.changed && delivered && cwd && threadId) {
      writeSessionBriefingFingerprint(cwd, threadId, refreshed.fingerprint);
    }
  }

  function retryQueuedMessages(reason: string): void {
    const drained = queuedMessages.splice(0);
    for (const queued of drained) {
      queued.token.retry(queued.message, reason);
    }
  }

  async function closeSdkSessionAfterUncommittablePrefix(sessionCtx: SessionContext, reason: string): Promise<void> {
    retryQueuedMessages(reason);
    currentAbort?.abort();
    currentAbort = null;
    currentTurnPromise = null;
    const resumeThreadId = threadId ?? undefined;
    thread = null;
    codex = null;
    activeProviderEnv = null;
    initialTurnPreparing = false;
    pendingChatContextPrompt = null;
    sessionCtx.failSessionForRecovery?.(reason, resumeThreadId);
  }

  return {
    async start(message, sessionCtx, token) {
      const deliveryToken = token;
      ctx = sessionCtx;

      let runtimeConfig: AgentRuntimeConfig | null = null;
      let payload: AgentRuntimeConfigPayload | null = null;
      if (agentConfigCache) {
        runtimeConfig = await agentConfigCache.refresh(sessionCtx.agent.agentId);
        payload = runtimeConfig.payload;
      }
      // Track whether the payload reflects a real config — used by the source-
      // repo state reconcile to distinguish "config has zero repos" from "we
      // couldn't reach the cache". A `false` here suppresses cleanup of
      // previously-managed clones; see PR #869 P0-2.
      const payloadResolved = payload !== null;
      if (!payload) {
        payload = {
          kind: "codex",
          prompt: { append: "" },
          model: "",
          mcpServers: [],
          env: [],
          gitRepos: [],
          resourceSkills: [],
          reasoningEffort: "high",
          serviceTier: "default",
        };
      }

      // Per agent-session-cwd-redesign: cwd is the per-agent home, shared
      // by every chat session for this agent. prepareManagedSession acquires
      // it and runs chat-context → skills → briefing → bootstrap → sentinel.
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
      cwd = prepared.workspace;
      pendingChatContextPrompt = renderChatContextPrompt(prepared.chatContext);
      const briefing = prepared.briefing;

      const providerEnv = buildEnv(sessionCtx);

      codex = createCodexClient({ env: providerEnv, config: buildCodexConfig(payload) }, sessionCtx);
      activeProviderEnv = providerEnv;
      activePayload = payload;
      thread = codex.startThread(buildCodexThreadOptions(payload, cwd));
      currentModel = payload.model || "";
      // Brand-new thread: the first `turn.completed` cumulative IS turn 1, so
      // the per-turn delta can use a zero baseline. (A cold `resume` leaves
      // these unset, so its first reading — a thread-wide cumulative — is
      // skipped rather than emitted as one giant turn.)
      prevCumulativeUsage = null;
      threadIsFresh = true;

      initialTurnPreparing = true;
      let initialTurnCompleted = false;
      try {
        const input = await toCodexInput(message, sessionCtx);
        await runTurn(input, sessionCtx, [message], deliveryToken);
        initialTurnCompleted = true;
      } finally {
        initialTurnPreparing = false;
        if (initialTurnCompleted) scheduleQueuedMessagesDrain();
      }

      // Codex assigns thread_id via `thread.started` during the first turn;
      // fall back to whatever `Thread` exposes if the event was missed.
      if (!threadId) {
        threadId = thread.id ?? null;
      }
      if (!threadId) {
        throw new Error("codex did not assign a thread id during the first turn");
      }
      // Seed the briefing baseline now that Codex has assigned the thread id
      // (only known after the first turn). A fresh thread starts in sync, so a
      // later resume only nudges on a real change.
      if (cwd) writeSessionBriefingFingerprint(cwd, threadId, computeBriefingFingerprint(briefing));
      return { sessionId: threadId, route: { kind: "owned", mode: "processing" } };
    },

    async resume(message, sessionId, sessionCtx, token) {
      const deliveryToken = message ? requireDeliveryToken(token, "messageful resume") : noopDeliveryToken();
      ctx = sessionCtx;

      let runtimeConfig: AgentRuntimeConfig | null = null;
      let payload: AgentRuntimeConfigPayload | null = null;
      if (agentConfigCache) {
        runtimeConfig = await agentConfigCache.refresh(sessionCtx.agent.agentId);
        payload = runtimeConfig.payload;
      }
      const resumePayloadResolved = payload !== null;
      if (!payload) {
        payload = {
          kind: "codex",
          prompt: { append: "" },
          model: "",
          mcpServers: [],
          env: [],
          gitRepos: [],
          resourceSkills: [],
          reasoningEffort: "high",
          serviceTier: "default",
        };
      }

      // Re-fetch chat-context every resume so newly-joined participants
      // surface at the next session/resume provider turn.
      const prepared = await prepareManagedSession({
        sessionCtx,
        workspaceRoot,
        agentName,
        runtimeProvider,
        providerSkillRoots: PROVIDER_SKILL_ROOTS,
        runtimeConfig,
        payload,
        payloadResolved: resumePayloadResolved,
        contextTree: {
          kind: contextTree.kind,
          path: contextTree.path,
          repoUrl: contextTree.repoUrl,
          branch: contextTree.branch,
        },
      });
      cwd = prepared.workspace;
      pendingChatContextPrompt = renderChatContextPrompt(prepared.chatContext);
      const briefing = prepared.briefing;

      const providerEnv = buildEnv(sessionCtx);

      // Briefing-staleness notice: a resumed Codex thread read AGENTS.md once at
      // thread init and never re-reads it, so a briefing rewritten by a runtime
      // upgrade (changed operating contract / skill set) would otherwise never
      // reach the resumed thread. If the current briefing differs from what this
      // session last ran a turn under — or there is no baseline, i.e. a session
      // predating this mechanism — prepend a one-time re-read notice ahead of the
      // Current Chat Context in the next provider turn. The baseline is advanced
      // only after the turn actually runs, so a failed turn keeps the notice
      // pending for the retry.
      const briefingFingerprint = computeBriefingFingerprint(briefing);
      const briefingChanged =
        Boolean(message) && readSessionBriefingFingerprint(cwd, sessionId) !== briefingFingerprint;
      if (briefingChanged) {
        const notice = buildBriefingUpdateNotice(join(cwd, "AGENTS.md"));
        pendingChatContextPrompt = pendingChatContextPrompt ? `${notice}\n\n${pendingChatContextPrompt}` : notice;
        sessionCtx.log(`Resume: briefing changed since last turn — prepending re-read notice (${sessionId})`);
      }

      codex = createCodexClient({ env: providerEnv, config: buildCodexConfig(payload) }, sessionCtx);
      activeProviderEnv = providerEnv;
      activePayload = payload;
      // Footgun F2: resumeThread does NOT inherit first-call ThreadOptions —
      // re-pass them every time.
      thread = codex.resumeThread(sessionId, buildCodexThreadOptions(payload, cwd));
      threadId = sessionId;
      currentModel = payload.model || "";

      if (message) {
        initialTurnPreparing = true;
        let initialTurnCompleted = false;
        let turnDelivered = false;
        try {
          const input = await toCodexInput(message, sessionCtx);
          turnDelivered = await runTurnWithStaleRolloutRecovery(input, sessionCtx, [message], deliveryToken, payload);
          initialTurnCompleted = true;
        } finally {
          initialTurnPreparing = false;
          if (initialTurnCompleted) scheduleQueuedMessagesDrain();
        }
        // Advance the baseline ONLY when the notice-bearing turn was actually
        // delivered (settled complete). A pre-provider / retried turn consumed
        // the notice without the model seeing it, so leaving the baseline
        // unchanged lets the redelivery's resume re-surface it.
        if (turnDelivered && threadId) writeSessionBriefingFingerprint(cwd, threadId, briefingFingerprint);
      }
      return { sessionId: threadId ?? sessionId, route: message ? { kind: "owned", mode: "processing" } : null };
    },

    inject(message, token) {
      // Fire-and-forget — Codex turns are run-to-completion, so the message
      // is buffered and drained on the next available turn. Queue every
      // inject instead of only mid-turn injects so the async gap before
      // `runTurn()` sets `currentTurnPromise` cannot start parallel turns
      // and desynchronise completion from the messages actually consumed.
      if (!ctx) return { kind: "rejected", reason: "no_active_context", retryable: true };
      const deliveryToken = token;
      queuedMessages.push({ message, token: deliveryToken });
      scheduleQueuedMessagesDrain();
      return { kind: "owned", mode: "queued" };
    },

    async suspend() {
      retryQueuedMessages("codex_suspend_before_terminal");
      currentAbort?.abort();
      try {
        await currentTurnPromise;
      } catch {
        // swallowed — abort raises AbortError on the streaming iterator
      }
      currentAbort = null;
      currentTurnPromise = null;
      thread = null;
      codex = null;
      activePayload = null;
      activeProviderEnv = null;
      initialTurnPreparing = false;
      pendingChatContextPrompt = null;
    },

    async shutdown(reason?: string) {
      retryQueuedMessages(reason ?? "codex_shutdown_before_terminal");
      // suspend() releases the active turn. Per agent-session-cwd-redesign
      // we no longer rm the cwd or auto-remove predeclared worktrees — both
      // are agent-scoped persistent resources shared across chats.
      currentAbort?.abort();
      try {
        await currentTurnPromise;
      } catch {
        /*ignore*/
      }
      currentAbort = null;
      currentTurnPromise = null;
      thread = null;
      codex = null;
      activePayload = null;
      activeProviderEnv = null;

      // Source repos, the Context Tree clone, and on-demand worktrees under
      // `<cwd>/worktrees/<name>/` are all agent-managed state — the agent
      // creates, refreshes, and removes them per its briefing protocol; the
      // runtime touches none of them on shutdown.
      //
      // cwd points at the persistent agent home — NO rmSync. The legacy
      // behaviour that wiped per-chat workspaces went away with the cwd
      // model change.
      cwd = null;
      threadId = null;
      ctx = null;
      initialTurnPreparing = false;
      pendingChatContextPrompt = null;
      queuedMessages.length = 0;
    },
  } satisfies AgentHandler;
};
