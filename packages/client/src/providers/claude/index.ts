import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionMode, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentRuntimeConfigPayload,
  ReplaySafety,
  RuntimeProvider,
  SessionEvent,
  SupportedImageMime,
} from "@first-tree/shared";
import {
  DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD,
  encodeProviderRetryEventMessage,
  hasTeamSkillInvocationMarker,
  isImageBatchRefContent,
  isImageRefContent,
  runtimeProviderSchema,
  SUPPORTED_IMAGE_MIMES as SHARED_SUPPORTED_IMAGE_MIMES,
  TEAM_SKILL_INVOCATION_METADATA_KEY,
} from "@first-tree/shared";
import type {
  AgentHandler,
  DeliveryToken,
  HandlerFactory,
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
  ChatContext,
  ProviderAttemptSettlement,
  ProviderFailureClassification,
  ProviderRetryDecision,
} from "../../runtime/provider-support/index.js";
import {
  ATTACHMENT_UNAVAILABLE_NOTE,
  assertContextSourceCurrent,
  buildBriefingUpdateNotice,
  buildProviderRetryEvent,
  classifyProviderFailure,
  computeBriefingFingerprint,
  contextSourceFromHandlerConfig,
  createContextTreeGitWriteTracker,
  decideProviderRetry,
  fetchChatContextOrLog,
  findImagePath,
  InputController,
  isContextSourceTransitionError,
  maxProviderTurnRetryAttempts,
  ProviderAttempt,
  preparationCoordinatesFromSource,
  prepareManagedSession,
  projectManagedWorkspace,
  readSessionBriefingFingerprint,
  redactErrorPreview,
  remoteGitAttributionFromSource,
  renderDocumentAttachmentsForLLM,
  writeSessionBriefingFingerprint,
} from "../../runtime/provider-support/index.js";
import { formatAuthHint, isClaudeAuthError } from "../handlers/auth-error-hint.js";
import { consumedErrorOutcome } from "../handlers/turn-settlement.js";
import { PROVIDER_SKILL_ROOTS } from "../skill-roots.js";
import { resolveClaudeCodeExecutable } from "./executable.js";
import { mapMcpServers } from "./mcp-config.js";
import {
  type ClaudeProviderFailure,
  claudeFailureFromAssistantMessage,
  claudeFailureFromSdkResult,
  isEgressForbiddenText,
  mergeClaudeProviderFailures,
} from "./provider-error.js";
import { buildClaudeQueryOptions, type ClaudeQueryConfigOptions, isSameModelFamily } from "./sdk-query-options.js";
import {
  type ContextTreeBinding,
  createToolCallProcessor,
  type ToolCallProcessor,
  treeNodePathOf,
} from "./tool-call-processor.js";

// Re-exported so the colocated family helpers (`./tool-call-processor.js`,
// `./mcp-config.js`, `./sdk-query-options.js`) stay the source of truth while
// package-root and internal consumers can keep importing these names from
// this SDK handler entry point.
export {
  buildClaudeQueryOptions,
  type ClaudeQueryConfigOptions,
  type ContextTreeBinding,
  createToolCallProcessor,
  isSameModelFamily,
  mapMcpServers,
  type ToolCallProcessor,
  treeNodePathOf,
};

type PendingAckMessage = {
  message: SessionMessage;
  token: DeliveryToken;
  providerEntered: boolean;
};

type PendingSdkInput = {
  sdkMessage: SDKUserMessage;
  pendingAck: PendingAckMessage | null;
};

type QueuedInjectedMessage = {
  message: SessionMessage;
  token: DeliveryToken;
  recoveryReason?: string;
  recoveryRetried?: boolean;
};

/**
 * Bug 6: thrown by `consumeOutput` when an SDK "success" result message
 * actually contains an API error string (e.g. "API Error: socket
 * connection was closed unexpectedly"). The catch block treats this like
 * any other transient stream failure and respawns the query.
 */
export class StreamApiTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamApiTransientError";
  }
}

const STREAM_API_ERROR_PREFIXES = ["API Error:", "Claude API error:", "Anthropic API error:"];

const STREAM_API_ERROR_HINTS = [
  "socket connection",
  "fetch failed",
  "ECONNRESET",
  "ETIMEDOUT",
  "timeout",
  "overloaded",
  "rate limit",
  "Unauthorized",
  "Forbidden",
  "401",
  "403",
  "429",
  "5xx",
  "500",
  "502",
  "503",
  "504",
];

/**
 * Bug 6: detect when a Claude SDK `result.success` payload is in fact an
 * internal SDK error string forwarded as the model reply. The heuristic is
 * deliberately conservative — three constraints together — so we don't
 * mistake a user message that happens to discuss "API Error" for a real
 * failure:
 *
 *   1. The text MUST start with one of {@link STREAM_API_ERROR_PREFIXES}.
 *   2. The full payload MUST be under 500 chars (real model replies that
 *      mention "API Error:" as topic content are almost always longer
 *      than a single one-line dump from the SDK).
 *   3. The text MUST include at least one technical hint from
 *      {@link STREAM_API_ERROR_HINTS} (socket / fetch / status code etc.)
 *      so a short tutorial like `"API Error: how to handle them"` doesn't
 *      qualify.
 *
 * Returns the captured one-line message when all three match; `null`
 * otherwise.
 */
export function detectStreamApiError(text: string): { message: string } | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length >= 500) return null;
  const hasPrefix = STREAM_API_ERROR_PREFIXES.some((p) => trimmed.startsWith(p));
  if (!hasPrefix) return null;
  const lower = trimmed.toLowerCase();
  const hasHint = STREAM_API_ERROR_HINTS.some((h) => lower.includes(h.toLowerCase()));
  if (!hasHint) return null;
  // Take only the first line so multi-line error dumps stay readable in logs.
  const firstLine = trimmed.split("\n")[0] ?? trimmed;
  return { message: firstLine };
}

const CLAUDE_SESSION_LIMIT_RESULT_RE =
  /^You(?:'|\u2019)ve hit your session limit\b(?:\s*(?:\u00b7|\u2022|-)\s*resets\s+.+)?\.?$/i;

/**
 * Claude Code can report account/session exhaustion as a `result.success`
 * payload instead of an SDK error. Treat only the exact runtime notice shape as
 * a provider capacity failure; normal assistant answers must still flow through
 * the retired final-text hook.
 */
export function detectClaudeSessionLimitResult(text: string): { message: string } | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length >= 500) return null;
  const firstLine = trimmed.split("\n")[0]?.trim() ?? "";
  if (firstLine.length === 0 || firstLine !== trimmed) return null;
  return CLAUDE_SESSION_LIMIT_RESULT_RE.test(firstLine) ? { message: firstLine } : null;
}

const SUPPORTED_IMAGE_MIMES: ReadonlySet<SupportedImageMime> = new Set<SupportedImageMime>(
  SHARED_SUPPORTED_IMAGE_MIMES,
);

const MIME_TO_EXT: Record<SupportedImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Legacy pre-refactor image content with base64 inlined into the message.
 * Only exercised by messages that pre-date the image-out-of-messages PR —
 * kept so a client upgraded mid-backlog can still read them. */
type LegacyImageFileContent = {
  data: string;
  mimeType: SupportedImageMime;
  filename: string;
  size?: number;
};

function isLegacyImageFileContent(content: unknown): content is LegacyImageFileContent {
  if (!content || typeof content !== "object") return false;
  const c = content as Record<string, unknown>;
  return (
    typeof c.data === "string" &&
    typeof c.mimeType === "string" &&
    typeof c.filename === "string" &&
    SUPPORTED_IMAGE_MIMES.has(c.mimeType as SupportedImageMime)
  );
}

/** chat_id values are DB-generated UUIDs; reject anything else so we never
 * traverse out of the images dir if the field is ever tampered with. */
function sanitizeChatId(chatId: string): string {
  return /^[a-zA-Z0-9-]+$/.test(chatId) ? chatId : "unknown";
}

/**
 * Write a legacy inline-base64 image to a temp file so Claude Code's Read
 * tool can pick it up. Only the legacy path — new messages reference an
 * `attachments` row whose bytes are fetched to the data dir before delivery
 * (see SessionRuntime.ensureImagesLocal).
 */
async function writeLegacyImageToTempFile(content: LegacyImageFileContent, chatId: string): Promise<string> {
  const dir = join(tmpdir(), "first-tree", "images", sanitizeChatId(chatId));
  await mkdir(dir, { recursive: true });
  const ext = MIME_TO_EXT[content.mimeType];
  const path = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`);
  await writeFile(path, Buffer.from(content.data, "base64"));
  return path;
}

function eventMakesReplayUnsafe(event: SessionEvent): boolean {
  return event.kind === "assistant_text" || event.kind === "thinking" || event.kind === "tool_call";
}

type ResultMessage = {
  type: "result";
  subtype: string;
  result?: string;
  errors?: string[];
  duration_ms?: number;
  total_cost_usd?: number;
  num_turns?: number;
  session_id?: string;
  // Per-model cumulative token usage for the current SDK Query. Anthropic's
  // Claude Agent SDK populates this on every ResultMessage (success and error
  // subtypes). A single turn can span multiple models (e.g. fast-mode), so the
  // handler diffs consecutive snapshots and emits one `token_usage` delta per
  // changed model. Keys are model identifiers (e.g. "claude-opus-4-7"). Older
  // SDK versions may omit the field entirely — treat absence as "no usage to
  // emit" rather than an error.
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    }
  >;
};

type ClaudeModelUsageCounters = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

function isResultMessage(message: unknown): message is ResultMessage {
  if (!message || typeof message !== "object") return false;
  const m = message as Record<string, unknown>;
  return m.type === "result" && typeof m.subtype === "string";
}

/**
 * Extract the typed auth-failure signal from any SDK message shape that
 * carries `SDKAssistantMessageError`. Returns the original provider-side
 * message (when the SDK has one to share) so the chat-timeline hint can
 * quote it verbatim.
 *
 * Two sources we watch (per `@anthropic-ai/claude-agent-sdk` `sdk.d.ts`):
 *
 *   - `assistant` messages with `error === "authentication_failed"` — the
 *     turn's terminal auth-failure signal, emitted from the typed union.
 *   - `auth_status` messages with a non-empty `error` string — the dedicated
 *     auth-state surface.
 *
 * `system/api_retry` is deliberately NOT watched here: that message fires
 * BEFORE the SDK's next retry attempt, not as a final verdict on the turn,
 * and would surface a hint before the user knew the turn failed. If a retry
 * does succeed, the hint would have been a false alarm. The eventual
 * `assistant.error` or `result.subtype === "error"` is the authoritative
 * post-failure signal — let those drive the chat-timeline message.
 */
export function detectClaudeAuthFailure(message: unknown): { rawMessage: string } | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (m.type === "assistant" && isClaudeAuthError(m.error as string | undefined)) {
    return { rawMessage: "authentication_failed" };
  }
  if (m.type === "auth_status" && typeof m.error === "string" && m.error.length > 0) {
    return { rawMessage: m.error };
  }
  return null;
}

/**
 * Diff a Query's cumulative `modelUsage` snapshots and emit one `token_usage`
 * event per changed model. The baseline is scoped to the concrete SDK Query:
 * a respawn/resume starts from an empty baseline because the new native process
 * owns a fresh cumulative counter. The SDK lumps cache-creation tokens under
 * their own field, but the wire schema folds their delta into `inputTokens`
 * because they bill as input.
 *
 * Best-effort: a missing/empty `modelUsage` is silently skipped (older SDKs
 * and some error subtypes don't populate it). Per-entry emit failures are
 * swallowed so token accounting never blocks the turn close that follows.
 */
function emitTokenUsageFromResult(
  message: ResultMessage,
  sessionCtx: SessionContext,
  baseline: Map<string, ClaudeModelUsageCounters>,
): void {
  const usage = message.modelUsage;
  if (!usage) return;
  for (const [model, m] of Object.entries(usage)) {
    if (!m) continue;
    const current: ClaudeModelUsageCounters = {
      inputTokens: m.inputTokens ?? 0,
      outputTokens: m.outputTokens ?? 0,
      cacheReadInputTokens: m.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: m.cacheCreationInputTokens ?? 0,
    };
    const previous = baseline.get(model);
    baseline.set(model, current);
    const delta = (key: keyof ClaudeModelUsageCounters): number => {
      const value = current[key];
      const prior = previous?.[key] ?? 0;
      // Defensive reset handling: if a provider counter ever rolls back within
      // one Query, treat the new value as the start of a fresh counter rather
      // than dropping the usage or emitting a negative schema value.
      return value >= prior ? value - prior : value;
    };
    const inputTokens = delta("inputTokens") + delta("cacheCreationInputTokens");
    const cachedRead = delta("cacheReadInputTokens");
    const outputTokens = delta("outputTokens");
    if (inputTokens === 0 && cachedRead === 0 && outputTokens === 0) continue;
    try {
      sessionCtx.emitEvent({
        kind: "token_usage",
        payload: {
          provider: "claude-code",
          model,
          inputTokens,
          cachedInputTokens: cachedRead,
          outputTokens,
        },
      });
    } catch (err) {
      sessionCtx.log(`Failed to emit token_usage: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Claude Code Handler — session-oriented handler using the Agent SDK.
 *
 * Each handler instance owns a single Claude session for one chat.
 * Uses streaming input (InputController) for mid-processing message injection
 * and session resume from disk for idle reclaim recovery.
 */
export const createClaudeCodeHandler: HandlerFactory = (config) => {
  const workspaceRoot = config.workspaceRoot as string;
  const agentName = typeof config.agentName === "string" ? config.agentName : "";
  const runtimeProvider: RuntimeProvider = runtimeProviderSchema.parse(config.runtimeProvider);
  const providerTurnMaxRetries = maxProviderTurnRetryAttempts();
  const agentConfigCache = (config.agentConfigCache as AgentConfigCache | undefined) ?? null;
  // Pre-resolved by the CLI composition root when building the frozen
  // handler factory table (cheap PATH / well-known dirs only). Undefined =
  // defer to the SDK's bundled native binary (see executable.ts for
  // why we can't always rely on it).
  const claudeCodeExecutable =
    (config.claudeCodeExecutable as string | undefined) ?? resolveClaudeCodeExecutable().path;

  let cwd: string | null = null;
  let claudeSessionId: string | null = null;
  let currentQuery: Query | null = null;
  let activeProviderEnv: Record<string, string | undefined> | null = null;
  let inputController: InputController<PendingSdkInput> | null = null;
  let providerRetryBackoffAbort: AbortController | null = null;
  let consumerDone: Promise<void> | null = null;
  /**
   * A terminal credential result retires the current SDK query because Claude
   * caches authentication state in its native process. Keep the logical
   * Session and claudeSessionId, then lazily create one fresh resume query
   * when the next delivered message arrives.
   */
  let credentialResumeRequired = false;
  let retryCount = 0;
  let ctx: SessionContext | null = null;
  /** Snapshot of the runtime config the *current* sub-process was launched with. */
  let appliedConfigVersion = 0;
  let appliedModel = "";
  let appliedPayload: AgentRuntimeConfigPayload | null = null;
  /**
   * Briefing-staleness tracking for the active session (see
   * session-briefing-fingerprint.ts). `current` is the fingerprint of the
   * briefing on disk right now — refreshed wherever the briefing is
   * (re)written: start, resume, fresh-fallback, and the config hot-switch
   * restart. `delivered` is the fingerprint the most recently *delivered* turn
   * ran under (mirrored to the per-session file). A turn-starting user message
   * gets the one-time re-read notice exactly when `current` differs from
   * `delivered` — which covers cold resume, a session predating the mechanism
   * (`delivered` loads as null), AND a mid-session config hot-switch that
   * rewrote the briefing before the next message.
   */
  let currentBriefingFingerprint: string | null = null;
  let deliveredBriefingFingerprint: string | null = null;
  /**
   * Latest chat-context snapshot for the active session. Used to build the
   * session/resume system-prompt block injected via `systemPrompt.append`.
   * Cleared when the session ends or `start()` runs for a fresh session.
   */
  let chatContextForPrompt: ChatContext | undefined;
  const queuedInjectedMessages: QueuedInjectedMessage[] = [];
  const pendingAckMessages: PendingAckMessage[] = [];
  let injectDrainInProgress = false;
  let drainingInjectedMessage: QueuedInjectedMessage | null = null;
  let inputRecoveryReason: string | null = null;
  /**
   * Predeclared source repos the agent config declares at
   * `<agentHome>/source-repos/<localPath>/`. Pure declaration (`declaredSourceRepos`) —
   * the agent itself clones/refreshes them per its briefing protocol.
   * Surfaced in the briefing so the LLM knows the absolute paths and
   * upstream coordinates. NOT to be confused with on-demand worktrees the
   * agent creates under `<agentHome>/worktrees/<name>/` — those are
   * runtime-opaque (created and cleaned up by the agent, not by First Tree).
   */
  /**
   * SDK inputs pushed into the active query that have not reached a terminal
   * turn boundary yet. Transient retry must replay the whole unclosed pushed
   * buffer, including a tail input the old query accepted into its controller
   * but crashed before the provider pulled. ACK eligibility is stricter and is
   * tracked separately by `PendingAckMessage.providerEntered`.
   */
  const unclosedSdkInputs: PendingSdkInput[] = [];

  function cancelProviderRetryBackoff(): void {
    providerRetryBackoffAbort?.abort();
    providerRetryBackoffAbort = null;
  }

  function providerRetryBackoffPending(): boolean {
    return providerRetryBackoffAbort !== null;
  }

  /**
   * Honor the shared provider retry delay while allowing suspend/shutdown to
   * interrupt the foreground retry chain immediately.
   */
  async function waitForProviderRetry(delayMs: number): Promise<boolean> {
    if (delayMs <= 0) return true;

    cancelProviderRetryBackoff();
    const backoffAbort = new AbortController();
    providerRetryBackoffAbort = backoffAbort;

    try {
      await new Promise<void>((resolveDelay) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          backoffAbort.signal.removeEventListener("abort", finish);
          resolveDelay();
        };
        const timer = setTimeout(finish, delayMs);
        backoffAbort.signal.addEventListener("abort", finish, { once: true });
        if (backoffAbort.signal.aborted) finish();
      });
      return !backoffAbort.signal.aborted;
    } finally {
      if (providerRetryBackoffAbort === backoffAbort) providerRetryBackoffAbort = null;
    }
  }

  function emitProviderTurnRetryEvent(
    sessionCtx: SessionContext,
    event: "provider_retry_scheduled" | "provider_retry_exhausted" | "provider_failure_terminal",
    classification: ProviderFailureClassification,
    decision: ProviderRetryDecision,
    messagePreview: string,
  ): void {
    sessionCtx.emitEvent({
      kind: "error",
      payload: {
        source: "runtime",
        message: encodeProviderRetryEventMessage(
          buildProviderRetryEvent({
            event,
            provider: runtimeProvider,
            scope: "provider_turn",
            classification,
            decision,
            messagePreview,
          }),
        ),
      },
    });
  }

  function emitAutoResumeFailedTerminalEvent(input: {
    sessionCtx: SessionContext;
    classification: ProviderFailureClassification;
    replaySafety: ReplaySafety;
    providerMessagePreview: string;
    resumeMsg: string;
  }): void {
    const decision: ProviderRetryDecision = {
      action: "stop",
      reasonCode: "claude_auto_resume_failed",
      terminalKind: "exhausted",
      replaySafety: input.replaySafety,
      userSeverity: "error",
    };
    const messagePreview = `Auto-resume failed: ${input.resumeMsg}\nProvider failure: ${input.providerMessagePreview}`;
    input.sessionCtx.emitEvent({
      kind: "error",
      payload: {
        source: "runtime",
        message: encodeProviderRetryEventMessage(
          buildProviderRetryEvent({
            event: "provider_failure_terminal",
            provider: runtimeProvider,
            scope: "provider_turn",
            classification: input.classification,
            decision,
            messagePreview,
          }),
        ),
      },
    });
  }

  function formatAutoResumeFailedMessage(resumeMsg: string): string {
    return `Auto-resume failed: ${redactErrorPreview(resumeMsg, 800)}`;
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

  function consumedReasonForProviderSettlement(
    settlement: ProviderAttemptSettlement,
  ): Parameters<typeof consumedErrorOutcome>[0] {
    const decision = settlement.decision;
    if (decision.action !== "stop") return settlement.classification.reasonCode;
    if (decision.terminalKind === "exhausted") return "provider_retry_exhausted";
    return decision.reasonCode;
  }

  function settleClaudeProviderFailure(failure: ClaudeProviderFailure): ProviderAttemptSettlement | null {
    const attempt = new ProviderAttempt({
      provider: runtimeProvider,
      scope: "provider_turn",
      source: "sdk",
      ...(failure.signal.replaySafety ? { replaySafety: failure.signal.replaySafety } : {}),
    });
    attempt.recordSignal(failure.signal);
    return attempt.settle({ attempt: retryCount + 1 });
  }

  async function toSDKUserMessage(
    message: SessionMessage,
    sessionCtx: SessionContext,
    sessionId: string,
  ): Promise<SDKUserMessage> {
    if (message.format === "file") {
      // Preserve the specialized current-image prompt while routing it through
      // the shared formatter, which is responsible for the supported generic
      // request images in precedingMessages. Keep ONLY the routed-mention
      // evidence and the server-owned Team Skill invocation marker from the
      // original metadata so the shared command boundary can still gate a
      // mention-prefixed caption slash command and prove Team intent for a
      // captioned command; other metadata stays cleared because batch
      // documents are appended explicitly below.
      const routingMetadata = message.metadata
        ? (() => {
            const preserved = {
              ...(Array.isArray(message.metadata.mentions) ? { mentions: message.metadata.mentions } : {}),
              ...(hasTeamSkillInvocationMarker(message.metadata)
                ? { [TEAM_SKILL_INVOCATION_METADATA_KEY]: message.metadata[TEAM_SKILL_INVOCATION_METADATA_KEY] }
                : {}),
            };
            return Object.keys(preserved).length > 0 ? preserved : null;
          })()
        : null;
      const formatFileText = async (text: string): Promise<string> =>
        sessionCtx.formatInboundContent({
          ...message,
          format: "text",
          content: text,
          // Preserve ONLY the two metadata facts the shared Team Skill
          // boundary needs: routed mentions (authorize `@agent /command`)
          // and the server-owned invocation marker (prove Team intent for a
          // captioned command). Every other key stays cleared because batch
          // documents are appended explicitly below — carrying full metadata
          // would duplicate the attachment notes.
          metadata: routingMetadata,
        });

      if (isImageBatchRefContent(message.content)) {
        const caption = message.content.caption?.trim() ?? "";
        const lines: string[] = [];
        if (caption.length > 0) lines.push(caption);
        lines.push(
          message.content.attachments.length === 1
            ? "An image was shared in this chat. Please use the Read tool to read it, then respond based on what you see."
            : `${message.content.attachments.length} images were shared in this chat. Please use the Read tool to read each one, then respond based on what you see.`,
        );
        for (const att of message.content.attachments) {
          const imagePath = findImagePath(message.chatId, att.imageId, att.mimeType);
          lines.push(
            imagePath
              ? `\nFilename: ${att.filename}\nPath: ${imagePath}`
              : message.unavailableAttachmentIds?.has(att.imageId)
                ? `\n[Image "${att.filename}" expired or unavailable — ${ATTACHMENT_UNAVAILABLE_NOTE}]`
                : `\n[Image "${att.filename}" not available on this device]`,
          );
        }
        const docNote = renderDocumentAttachmentsForLLM(message);
        if (docNote) lines.push(`\n${docNote}`);
        return {
          type: "user",
          message: { role: "user", content: await formatFileText(lines.join("\n")) },
          parent_tool_use_id: null,
          session_id: sessionId,
        };
      }

      if (isImageRefContent(message.content)) {
        const { imageId, mimeType, filename } = message.content;
        const imagePath = findImagePath(message.chatId, imageId, mimeType);
        const text = imagePath
          ? `An image was shared in this chat. Please use the Read tool to read it, then respond based on what you see.\n\nFilename: ${filename}\nPath: ${imagePath}`
          : message.unavailableAttachmentIds?.has(imageId)
            ? `[Image "${filename}" expired or unavailable — ${ATTACHMENT_UNAVAILABLE_NOTE}]`
            : `[Image "${filename}" not available on this device]`;
        return {
          type: "user",
          message: { role: "user", content: await formatFileText(text) },
          parent_tool_use_id: null,
          session_id: sessionId,
        };
      }

      if (isLegacyImageFileContent(message.content)) {
        // Preserve the pre-refactor inline-image path unchanged; historical
        // inline payload behavior is explicitly outside this PR's scope.
        const header = await sessionCtx.formatFromHeader(message);
        const prefix = header ? `${header}\n\n` : "";
        const { filename } = message.content;
        try {
          const imagePath = await writeLegacyImageToTempFile(message.content, message.chatId);
          const text = `${prefix}An image was shared in this chat. Please use the Read tool to read it, then respond based on what you see.\n\nFilename: ${filename}\nPath: ${imagePath}`;
          return {
            type: "user",
            message: { role: "user", content: text },
            parent_tool_use_id: null,
            session_id: sessionId,
          };
        } catch (err) {
          // Avoid leaking raw fs error messages (they contain absolute paths).
          const fallbackText = `[Image attachment "${filename}" failed to materialise]`;
          ctx?.log(`Failed to write image to temp file: ${err instanceof Error ? err.message : String(err)}`);
          return {
            type: "user",
            message: { role: "user", content: `${prefix}${fallbackText}` },
            parent_tool_use_id: null,
            session_id: sessionId,
          };
        }
      }
    }

    // Default text content — sender attribution lives in the runtime so every
    // handler frames `[From: ...]` the same way. See runtime/agent-io.ts.
    return {
      type: "user",
      message: { role: "user", content: await sessionCtx.formatInboundContent(message) },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
  }

  /**
   * Prepend the one-time "your instructions changed — re-read CLAUDE.md" notice
   * to a resumed turn's user message, so the agent reads it before acting on
   * the message. Only the text content shape is handled (every
   * `toSDKUserMessage` branch returns a string `content`); anything else is
   * returned untouched.
   */
  function prependBriefingUpdateNotice(sdkMsg: SDKUserMessage, claudeMdPath: string): SDKUserMessage {
    const { content } = sdkMsg.message;
    if (typeof content !== "string") return sdkMsg;
    return {
      ...sdkMsg,
      message: { ...sdkMsg.message, content: `${buildBriefingUpdateNotice(claudeMdPath)}\n\n${content}` },
    };
  }

  /**
   * The single chokepoint for delivering a turn-starting user message to the
   * SDK input controller. Used by start / resume / fresh-fallback / the inject
   * drain so every path shares one briefing-staleness contract:
   *
   *   - prepend the one-time re-read notice when the on-disk briefing
   *     (`currentBriefingFingerprint`) differs from what the last delivered
   *     turn ran under (`deliveredBriefingFingerprint`);
   *   - advance the baseline ONLY after the input is in the replay buffer, so a
   *     synchronous `buildQuery()` failure before this point leaves the notice
   *     pending for the retry rather than recording it as already shown.
   */
  function deliverUserMessage(
    sdkMsg: SDKUserMessage,
    message: SessionMessage,
    token: DeliveryToken,
    sessionId: string,
    sessionCtx: SessionContext,
  ): void {
    const briefingChanged =
      currentBriefingFingerprint !== null && deliveredBriefingFingerprint !== currentBriefingFingerprint;
    let outgoing = sdkMsg;
    if (briefingChanged && cwd) {
      sessionCtx.log(`Briefing changed since last delivered turn — prepending re-read notice (${sessionId})`);
      outgoing = prependBriefingUpdateNotice(sdkMsg, join(cwd, "CLAUDE.md"));
    }
    pushPendingSdkInput(createPendingSdkInput(outgoing, message, token));
    // The input is now buffered for replay; advancing the baseline here ties it
    // to delivery actually reaching the controller.
    if (briefingChanged) {
      deliveredBriefingFingerprint = currentBriefingFingerprint;
      if (cwd && currentBriefingFingerprint) {
        writeSessionBriefingFingerprint(cwd, sessionId, currentBriefingFingerprint);
      }
    }
  }

  /**
   * Build env for the child Claude Code process.
   *
   * When the client runtime runs inside a Claude Code session (nested env),
   * process.env contains internal markers (CLAUDECODE, CLAUDE_CODE_ENTRYPOINT,
   * CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, npm_lifecycle_script) that cause the
   * child to enable Agent Teams infrastructure and use wrong init paths,
   * resulting in ~90s cold start vs ~17s standalone. Strip these here (Claude
   * Code specific) then let the runtime layer add the First Tree envelope via
   * `ctx.buildAgentEnv` so all handlers expose the same vars uniformly.
   */
  function buildEnv(sessionCtx: SessionContext): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };

    // Parent session markers — not needed by the child
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    delete env.npm_lifecycle_script;

    // Step 6: layer in user-configured env (sensitive already decrypted at
    // service level; see config-service.getDecrypted()). User vars come
    // BEFORE First Tree-internal vars so the latter wins on collision.
    const payload = agentConfigCache?.get(sessionCtx.agent.agentId)?.payload;
    if (payload) {
      for (const e of payload.env) env[e.key] = e.value;
    }

    // Child processes receive the member access JWT as FIRST_TREE_ACCESS_TOKEN
    // and pair it with X-Agent-Id (sent by the SDK automatically) to act as
    // the current agent. Obtaining the token at buildEnv-time means the child
    // sees the JWT valid at its spawn moment; long-lived runtimes should
    // re-spawn after refresh, or re-read the env on their own cadence.
    return sessionCtx.buildAgentEnv(env);
  }

  /** Create query and input controller, then start consumer loop. */
  function spawnQuery(
    sessionId: string,
    sessionCtx: SessionContext,
    resume?: string,
    providerEnv?: Record<string, string | undefined>,
  ): void {
    // The latest chat-context and source-repo snapshot live in module-scoped
    // caches (`chatContextForPrompt`, `sourceReposForPrompt`) which the
    // handler refreshes in start/resume BEFORE this call. `maybeSwitchConfig`
    // additionally rewrites the briefing before invoking `buildQuery` so a
    // mid-session config swap surfaces in the freshly read CLAUDE.md.
    buildQuery(sessionId, sessionCtx, resume, providerEnv);
    recordAppliedPayload(sessionCtx);
    consumerDone = consumeOutput(sessionCtx);
  }

  /**
   * Message conversion can await attachment materialization after workspace
   * preparation. Re-authorize immediately before the synchronous query spawn;
   * keeping the spawn itself synchronous also preserves the atomic
   * spawn-then-input-buffer ordering expected by the SDK consumer.
   */
  async function assertQuerySpawnCurrent(sessionCtx: SessionContext): Promise<void> {
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
  }

  /**
   * Single helper for "turn closed → finish the provider-entered inbox
   * prefix AND drop settled inputs from the replay buffer". The two
   * operations are paired everywhere a turn finishes (success /
   * sniff-permanent / forward-error / no-result / non-success subtype /
   * MAX_RETRIES / respawn-fail) — folding them into one call keeps the
   * invariant "input replay lives only as long as the turn still might need a
   * replay" enforced in one place. Use the raw
   * `finishTurn(message, ...)` directly for per-message terminal
   * failures (e.g. inject's `toSDKUserMessage` catch) where the semantics is
   * "commit this single inbox message, NOT close the active SDK turn".
   */
  function pendingProviderEnteredPrefix(): PendingAckMessage[] {
    const prefix: PendingAckMessage[] = [];
    for (const pending of pendingAckMessages) {
      if (!pending.providerEntered) break;
      prefix.push(pending);
    }
    return prefix;
  }

  function isCurrentPendingPrefix(batch: readonly PendingAckMessage[]): boolean {
    return batch.every((pending, index) => pendingAckMessages[index] === pending);
  }

  async function ackTurnClose(
    status: "success" | "error",
    reason: Parameters<typeof consumedErrorOutcome>[0] = "provider_clean_error",
    providerEnteredPrefix: readonly PendingAckMessage[] = pendingProviderEnteredPrefix(),
  ): Promise<void> {
    const fallbackErrorPending =
      status === "error" && providerEnteredPrefix.length === 0 ? pendingAckMessages[0] : undefined;
    const batch =
      providerEnteredPrefix.length > 0
        ? [...providerEnteredPrefix]
        : fallbackErrorPending
          ? [fallbackErrorPending]
          : [];
    let settledBatch: PendingAckMessage[] = [];
    if (batch.length > 0 && isCurrentPendingPrefix(batch)) {
      pendingAckMessages.splice(0, batch.length);
      const messages = batch.map((pending) => pending.message);
      const tail = batch[batch.length - 1];
      const outcome = status === "success" ? { status, terminal: true } : consumedErrorOutcome(reason);
      await tail?.token.complete(messages, outcome);
      settledBatch = batch;
    }
    if (settledBatch.length > 0) {
      const settled = new Set(settledBatch);
      for (let index = unclosedSdkInputs.length - 1; index >= 0; index--) {
        const input = unclosedSdkInputs[index];
        if (input?.pendingAck && settled.has(input.pendingAck)) unclosedSdkInputs.splice(index, 1);
      }
    }
  }

  function createPendingSdkInput(
    sdkMessage: SDKUserMessage,
    message: SessionMessage,
    token: DeliveryToken,
  ): PendingSdkInput {
    return {
      sdkMessage,
      pendingAck: { message, token, providerEntered: false },
    };
  }

  function pushPendingSdkInput(input: PendingSdkInput): void {
    if (input.pendingAck) pendingAckMessages.push(input.pendingAck);
    unclosedSdkInputs.push(input);
    inputController?.push(input);
  }

  function markProviderEntered(input: PendingSdkInput): void {
    const pending = input.pendingAck;
    if (!pending || pending.providerEntered) return;
    pending.providerEntered = true;
    pending.token.processingStarted(pending.message);
  }

  async function* providerPromptInputs(inputs: AsyncIterable<PendingSdkInput>): AsyncIterable<SDKUserMessage> {
    for await (const input of inputs) {
      markProviderEntered(input);
      yield input.sdkMessage;
    }
  }

  function retryInjectedItem(item: QueuedInjectedMessage, reason: string): void {
    item.recoveryReason = reason;
    if (item.recoveryRetried) return;
    item.recoveryRetried = true;
    item.token.retry(item.message, reason);
  }

  function recoverIfInputClosed(item: QueuedInjectedMessage): boolean {
    const reason = item.recoveryReason ?? inputRecoveryReason;
    if (!reason) return false;
    retryInjectedItem(item, reason);
    return true;
  }

  async function pushInjectedMessage(
    item: QueuedInjectedMessage,
    sessionCtx: SessionContext,
    sessionId: string,
  ): Promise<void> {
    const { message, token } = item;
    if (recoverIfInputClosed(item)) return;
    try {
      await maybeSwitchConfig(sessionCtx);
    } catch (err) {
      sessionCtx.log(`maybeSwitchConfig errored: ${err instanceof Error ? err.message : String(err)}`);
      // Path B may already have retired the provider-retry consumer before a
      // fallible config-restart step fails. Do not continue into an orphaned
      // input controller. Retire the provider transport before returning the
      // provider-entered prefix and unentered tail to runtime recovery so a
      // fresh handler cannot overlap the abandoned native process.
      retireProviderTransport();
      retryBufferedMessages("claude_config_restart_failed_recovery");
      failFatalSessionForRecovery(sessionCtx, "claude_config_restart_failed");
      return;
    }
    if (recoverIfInputClosed(item)) return;

    try {
      const sdkMsg = await toSDKUserMessage(message, sessionCtx, sessionId);
      if (recoverIfInputClosed(item)) return;
      // Same chokepoint as start/resume: if a config hot-switch (or anything
      // else) rewrote the briefing since the last delivered turn, this is where
      // the re-read notice is attached before the message enters the buffer.
      deliverUserMessage(sdkMsg, message, token, sessionId, sessionCtx);
    } catch (err) {
      if (recoverIfInputClosed(item)) return;
      sessionCtx.log(`toSDKUserMessage errored: ${err instanceof Error ? err.message : String(err)}`);
      // The SDK has not seen this input yet, so there is no durable terminal
      // evidence. Keep it recoverable instead of ACKing through `complete`.
      // A Team Skill command refusal is a pre-provider fail-closed by
      // definition — retry with its dedicated reason so the turn can
      // succeed once a verified target lands.
      token.retry(
        message,
        isTeamSkillCommandUnavailableError(err) ? "team_skill_command_unavailable" : "claude_inject_format_failed",
      );
    }
  }

  function scheduleInjectedMessagesDrain(sessionCtx: SessionContext, sessionId: string): void {
    if (injectDrainInProgress || (!inputController && !credentialResumeRequired)) return;
    void (async () => {
      injectDrainInProgress = true;
      try {
        if (!inputController && credentialResumeRequired) {
          try {
            await assertQuerySpawnCurrent(sessionCtx);
            if (ctx !== sessionCtx || claudeSessionId !== sessionId || !credentialResumeRequired || inputController) {
              return;
            }
            sessionCtx.log(`Credential recovery: resuming session in a fresh Claude query (${sessionId})`);
            spawnQuery(sessionId, sessionCtx, sessionId, buildEnv(sessionCtx));
          } catch (err) {
            sessionCtx.log(`Credential recovery resume failed: ${err instanceof Error ? err.message : String(err)}`);
            credentialResumeRequired = false;
            retryBufferedMessages("claude_credential_resume_failed_recovery");
            failFatalSessionForRecovery(sessionCtx, "claude_credential_resume_failed");
            return;
          }
        }
        while (
          queuedInjectedMessages.length > 0 &&
          inputController &&
          ctx === sessionCtx &&
          claudeSessionId === sessionId
        ) {
          const queued = queuedInjectedMessages.shift();
          if (!queued) continue;
          drainingInjectedMessage = queued;
          try {
            await pushInjectedMessage(queued, sessionCtx, sessionId);
          } catch (err) {
            sessionCtx.log(`inject drain failed: ${err instanceof Error ? err.message : String(err)}`);
            retryInjectedItem(queued, "claude_inject_drain_failed");
          } finally {
            if (drainingInjectedMessage === queued) drainingInjectedMessage = null;
          }
        }
      } finally {
        injectDrainInProgress = false;
        if (
          queuedInjectedMessages.length > 0 &&
          (inputController || credentialResumeRequired) &&
          ctx &&
          claudeSessionId
        ) {
          scheduleInjectedMessagesDrain(ctx, claudeSessionId);
        }
      }
    })();
  }

  function retryBufferedMessages(reason: string, preserveFifo = false): void {
    inputRecoveryReason = reason;
    unclosedSdkInputs.length = 0;
    const pending = pendingAckMessages.splice(0);
    const drainingIsPending =
      drainingInjectedMessage !== null &&
      pending.some(
        (pendingItem) =>
          pendingItem.message === drainingInjectedMessage?.message &&
          pendingItem.token === drainingInjectedMessage.token,
      );
    const queued = queuedInjectedMessages.splice(0);
    if (preserveFifo) {
      // pending inputs reached the controller before the currently formatting
      // item, which in turn precedes the untouched handler queue. Credential
      // settlement must return that exact unentered tail order to runtime
      // recovery after removing the consumed prefix.
      for (const item of pending) {
        item.token.retry(item.message, reason);
      }
      if (drainingInjectedMessage && !drainingIsPending) retryInjectedItem(drainingInjectedMessage, reason);
      for (const item of queued) {
        retryInjectedItem(item, reason);
      }
      return;
    }
    if (drainingInjectedMessage && !drainingIsPending) retryInjectedItem(drainingInjectedMessage, reason);
    for (const item of queued) {
      retryInjectedItem(item, reason);
    }
    for (const item of pending) {
      item.token.retry(item.message, reason);
    }
  }

  function failFatalSessionForRecovery(sessionCtx: SessionContext, reason: string): void {
    sessionCtx.failSessionForRecovery?.(reason, claudeSessionId ?? undefined);
  }

  function retireProviderTransport(): void {
    cancelProviderRetryBackoff();

    const controller = inputController;
    inputController = null;
    try {
      controller?.end();
    } catch {
      // best-effort transport cleanup
    }

    const query = currentQuery;
    currentQuery = null;
    try {
      query?.close();
    } catch {
      // best-effort transport cleanup
    }

    activeProviderEnv = null;
  }

  /**
   * Rebuild the SDK query in resume mode AND re-push every input already handed
   * to the previous query's controller for the still-unclosed turn, preserving
   * coalesced-input order. The
   * caller (the outer consumer loop's catch block) keeps owning the
   * for-await, so we deliberately do NOT start a new consumer here —
   * spawning one would create two parallel loops both consuming the
   * same `currentQuery` reference and both racing their own
   * `retryCount` counter (under persistent failure, that fans out into
   * unbounded recursion). Configuration (`applied*`) is preserved
   * across the retry — only the SDK query is recycled.
   *
   * Stays synchronous — the converted SDK payloads are already held in
   * `unclosedSdkInputs`, so the retry path doesn't need to re-run
   * `toSDKUserMessage` (which is async and would shift the consumer-loop
   * timing). An empty replay buffer is possible for an admin-triggered resume
   * with no user input; in that case the rebuilt query waits for the next
   * input normally.
   */
  async function respawnQuery(sessionId: string, sessionCtx: SessionContext): Promise<void> {
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
    buildQuery(sessionId, sessionCtx, sessionId, activeProviderEnv ?? buildEnv(sessionCtx));
    const replay = unclosedSdkInputs.slice();
    for (const input of replay) {
      inputController?.push(input);
    }
  }

  /**
   * Snapshot the runtime config the current sub-process was launched with.
   * Callers invoke this after `buildQuery` succeeds so a failed build never
   * records a payload as "applied".
   */
  function recordAppliedPayload(sessionCtx: SessionContext): void {
    const cached = agentConfigCache?.get(sessionCtx.agent.agentId);
    appliedConfigVersion = cached?.version ?? 0;
    appliedModel = cached?.payload?.model ?? "";
    appliedPayload = cached?.payload ?? null;
  }

  function buildQuery(
    sessionId: string,
    sessionCtx: SessionContext,
    resume?: string,
    providerEnv?: Record<string, string | undefined>,
  ): void {
    // Construct the replacement locally so a synchronous SDK constructor
    // failure cannot leave the handler pointing at an orphan controller while
    // the previous query still owns the unsettled turn.
    const nextInputController = new InputController<PendingSdkInput>();
    const nextAbortController = new AbortController();

    // Step 6: M1 hard-codes bypassPermissions per PRD §5.1.6 (permission mode
    // is intentionally not exposed to admins).
    const permissionMode: PermissionMode = "bypassPermissions";

    const payload = agentConfigCache?.get(sessionCtx.agent.agentId)?.payload;

    const childEnv = providerEnv ?? buildEnv(sessionCtx);

    const nextQuery = claudeQuery({
      prompt: providerPromptInputs(nextInputController.iterable),
      options: {
        sessionId: resume ? undefined : sessionId,
        resume,
        cwd: cwd ?? undefined,
        persistSession: true,
        abortController: nextAbortController,
        permissionMode,
        allowDangerouslySkipPermissions: true,
        // SDK 0.2.84 defaults to isolation mode — no filesystem settings are
        // read. We opt into both `user` and `project`:
        //   - `project` loads the workspace CLAUDE.md (symlinked to AGENTS.md
        //     written by `writeAgentBriefing`). That shared briefing carries
        //     stable agent-level content: identity, prompt.append,
        //     working-dir convention, source-repo list, operating
        //     instructions, domain map, and the First Tree Agent Runtime block.
        //     Per-chat Current Chat Context is appended below through the SDK
        //     `systemPrompt` channel so sibling chats do not race on one file.
        //   - `user` inherits the operator's local `~/.claude/settings.json`
        //     so their Claude Code customizations (thinking mode, effortLevel,
        //     outputStyle, statusLine, plugins, skills, hooks, MCP servers)
        //     carry over to agent sessions on their machine. Server-managed
        //     fields (model, env, permissionMode, and the First Tree
        //     `mcpServers` list) still win because they are passed as
        //     explicit SDK options below, which layer on top of settings.
        settingSources: ["user", "project"],
        env: childEnv,
        // AskUserQuestion is not supported in First Tree — agents resolve
        // ask-a-human inline. Disable the tool at the SDK level so it never
        // surfaces in a session.
        disallowedTools: ["AskUserQuestion"],
        ...(claudeCodeExecutable ? { pathToClaudeCodeExecutable: claudeCodeExecutable } : {}),
        // model / mcpServers / effort — the config-derived slice. `effort: ""`
        // (inherit) is omitted so the SDK uses the local effortLevel.
        ...buildClaudeQueryOptions(payload, chatContextForPrompt),
      },
    });

    inputRecoveryReason = null;
    inputController = nextInputController;
    currentQuery = nextQuery;
    activeProviderEnv = childEnv;
    credentialResumeRequired = false;
  }

  /**
   * Step 6 hot-switch (Path A vs Path B). Returns true if a restart was
   * required and performed; false if it was an in-flight mutator (or no-op).
   */
  async function maybeSwitchConfig(sessionCtx: SessionContext): Promise<boolean> {
    if (!agentConfigCache || !claudeSessionId || !currentQuery) return false;
    const cached = agentConfigCache.get(sessionCtx.agent.agentId);
    if (!cached || cached.version === appliedConfigVersion) return false;
    if (cached.version < appliedConfigVersion) {
      sessionCtx.log(
        `[configHotSwitch] preserving active version=${appliedConfigVersion}; ignored stale cached version=${cached.version}`,
      );
      return false;
    }

    const newPayload = cached.payload;
    const onlyModelChanged =
      appliedPayload !== null &&
      JSON.stringify({ ...appliedPayload, model: "" }) === JSON.stringify({ ...newPayload, model: "" }) &&
      appliedPayload.model !== newPayload.model;

    // Path A: same-family model swap → in-flight setModel.
    if (onlyModelChanged && isSameModelFamily(appliedModel, newPayload.model) && !providerRetryBackoffPending()) {
      try {
        await currentQuery.setModel(newPayload.model);
        sessionCtx.log(
          `[configHotSwitch] path=in-flight from=${appliedModel} to=${newPayload.model} version=${cached.version}`,
        );
        appliedModel = newPayload.model;
        appliedConfigVersion = cached.version;
        appliedPayload = newPayload;
        return false;
      } catch (err) {
        sessionCtx.log(`setModel failed, falling back to restart: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Path B: restart with resume — pick up new options and replay context.
    // Rebuild the query AND start a fresh consumer loop: the existing loop is
    // still iterating the OLD query and will exit once `oldQuery.close()`
    // drains it, so the new query would otherwise have no reader.
    sessionCtx.log(`[configHotSwitch] path=restart fromVersion=${appliedConfigVersion} toVersion=${cached.version}`);
    // Path B takes ownership of the unsettled turn. Retire an old consumer
    // that may be waiting in provider retry backoff before any async restart
    // preparation can yield; otherwise its timer could later respawn another
    // query alongside the config-switch consumer.
    cancelProviderRetryBackoff();
    // Rewrite AGENTS.md (CLAUDE.md symlink) with the new payload so the
    // restarted SDK Query — which reads CLAUDE.md via `settingSources:
    // ["project"]` on construction — picks up the new prompt.append. The
    // briefing is now the single channel; without this rewrite the swap
    // would update model/mcp/effort but silently leave the per-agent prompt
    // at the old version until the next session restart.
    const providerEnv = buildEnv(sessionCtx);
    if (cwd) {
      const legacyProjection = cwd !== workspaceRoot;
      const projected = await projectManagedWorkspace({
        sessionCtx,
        workspace: cwd,
        sourceAuthorityRoot: legacyProjection ? workspaceRoot : cwd,
        agentName,
        runtimeProvider,
        providerSkillRoots: PROVIDER_SKILL_ROOTS,
        runtimeConfig: cached,
        payload: newPayload,
        payloadResolved: true,
        existingPayload: appliedPayload ?? undefined,
        contextTree: {
          kind: contextTree.kind,
          path: contextTree.path,
          repoUrl: contextTree.repoUrl,
          branch: contextTree.branch,
        },
        reresolveSource: true,
        markInitComplete: false,
        writeIdentityAndManifest: !legacyProjection,
        suppressSourceRepos: legacyProjection,
      });
      const switchedBriefing = projected.briefing;
      // Refresh the on-disk briefing fingerprint so the NEXT delivered message
      // (drained right after this restart in pushInjectedMessage) sees the
      // change and carries the re-read notice. `delivered` is intentionally
      // left untouched — the transcript still reflects the pre-switch briefing.
      currentBriefingFingerprint = computeBriefingFingerprint(switchedBriefing);
    }
    const sid = claudeSessionId;
    const oldQuery = currentQuery;
    buildQuery(sid, sessionCtx, sid, providerEnv);
    recordAppliedPayload(sessionCtx);
    consumerDone = consumeOutput(sessionCtx);
    try {
      oldQuery.close();
    } catch {
      // ignore close errors — best-effort cleanup
    }
    return true;
  }

  async function consumeOutput(sessionCtx: SessionContext): Promise<void> {
    let turnHadUserVisibleOutput = false;
    const toolCallProcessor = createToolCallProcessor(
      (event) => {
        if (eventMakesReplayUnsafe(event)) turnHadUserVisibleOutput = true;
        sessionCtx.emitEvent(event);
      },
      {
        path: contextTreePath,
        repoUrl: contextTreeRepoUrl,
        branch: contextTreeBranch,
      },
      {
        cwd,
        gitWriteTracker: createContextTreeGitWriteTracker({
          contextTreePath,
          contextTreeRepoUrl,
          contextTreeBranch,
          log: (message) => sessionCtx.log(message),
        }),
      },
    );
    // Auth-failure hint emission flag. Set when we detect a typed
    // `authentication_failed` on assistant / auth_status messages. Consulted
    // in the result-error branch so we don't double-emit (once as a hint,
    // once as the raw SDK error). Two scopes share this:
    //   1. Within a single turn: per-turn reset on `result` boundary so the
    //      next turn within the SAME query (bg-agent multi-turn mode) starts
    //      fresh.
    //   2. Across retries (outer catch path that hands off to
    //      `handler.resume()`): NOT reset. An auth failure won't self-heal,
    //      so the resumed session typically hits the same error — without
    //      persistence the user would see two identical hint lines in the
    //      timeline.
    // Hoisted out of the try block so the outer catch's reentry preserves it
    // across the resume boundary.
    let authHintEmitted = false;
    // A typed auth signal whose hint is deferred until the result reveals
    // whether it is a genuine credential failure or a network-egress 403
    // ("Request not allowed") that only looks like auth. Held across the
    // result boundary; flushed (emitted) for genuine auth, dropped for egress.
    let pendingAuthHint: string | null = null;
    let pendingAssistantProviderFailure: ClaudeProviderFailure | null = null;
    const currentTurnReplaySafety = (): ReplaySafety => (turnHadUserVisibleOutput ? "user_visible" : "pre_visible");
    const resetTurnReplaySafety = (): void => {
      turnHadUserVisibleOutput = false;
    };
    try {
      queryLoop: while (true) {
        if (!currentQuery) return;

        try {
          // `modelUsage` is cumulative only within one concrete Query/native
          // process. Capture both together so a config hot-switch can start a
          // new consumer without sharing or clearing the old consumer's
          // accounting baseline while it drains.
          const query = currentQuery;
          const modelUsageBaseline = new Map<string, ClaudeModelUsageCounters>();
          for await (const message of query) {
            // Every message refreshes lastActivity to prevent idle timeout
            sessionCtx.recordProviderActivity();

            toolCallProcessor.onMessage(message);

            // Capture a typed auth failure, but DEFER the hint. A typed
            // `authentication_failed` can be the visible face of a network-egress
            // 403 ("Request not allowed") whose detail only arrives in the later
            // result; emitting "run claude auth login" now would mislead before
            // the result can reveal the true cause. Decide at result settlement
            // (or stream end). If the raw signal already shows egress (the
            // auth_status path carries the message text), suppress it outright.
            // The SDK's auth state lives in claude's own credential store — we
            // only translate the surface error, we don't manage tokens.
            const authFailure = detectClaudeAuthFailure(message);
            if (authFailure && !authHintEmitted && pendingAuthHint === null) {
              if (!isEgressForbiddenText(authFailure.rawMessage)) {
                pendingAuthHint = authFailure.rawMessage;
              }
            }
            const assistantProviderFailure = claudeFailureFromAssistantMessage(message);
            if (assistantProviderFailure) pendingAssistantProviderFailure = assistantProviderFailure;

            if (isResultMessage(message)) {
              const providerEnteredPrefix = pendingProviderEnteredPrefix();
              emitTokenUsageFromResult(message, sessionCtx, modelUsageBaseline);
              const providerFailure = mergeClaudeProviderFailures({
                resultFailure: claudeFailureFromSdkResult(message),
                assistantFailure: pendingAssistantProviderFailure,
                ...(turnHadUserVisibleOutput ? { replaySafety: "user_visible" as const } : {}),
              });
              pendingAssistantProviderFailure = null;
              if (providerFailure) {
                const settlement = settleClaudeProviderFailure(providerFailure);
                if (settlement) {
                  sessionCtx.log(
                    `Claude SDK provider failure (${settlement.classification.category}/${settlement.classification.reasonCode}): ${settlement.messagePreview}`,
                  );
                  if (settlement.decision.action === "retry") {
                    if (!claudeSessionId) {
                      throw new StreamApiTransientError(settlement.messagePreview);
                    }
                    retryCount = settlement.decision.attempt;
                    emitProviderTurnSettlementEvent(sessionCtx, settlement);
                    sessionCtx.log(`Attempting auto-resume (retry ${retryCount}/${providerTurnMaxRetries})`);
                    toolCallProcessor.flush();
                    if (!(await waitForProviderRetry(settlement.decision.delayMs))) {
                      sessionCtx.log("Auto-resume cancelled during provider retry backoff");
                      return;
                    }
                    try {
                      await respawnQuery(claudeSessionId, sessionCtx);
                    } catch (resumeErr) {
                      if (isContextSourceTransitionError(resumeErr)) {
                        retryBufferedMessages("claude_context_source_changed");
                        failFatalSessionForRecovery(sessionCtx, "claude_context_source_changed");
                        return;
                      }
                      const resumeMsg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
                      sessionCtx.log(`Auto-resume failed after Claude SDK provider failure: ${resumeMsg}`);
                      emitAutoResumeFailedTerminalEvent({
                        sessionCtx,
                        classification: settlement.classification,
                        replaySafety: settlement.decision.replaySafety,
                        providerMessagePreview: settlement.messagePreview,
                        resumeMsg,
                      });
                      sessionCtx.emitEvent({
                        kind: "error",
                        payload: { source: "runtime", message: formatAutoResumeFailedMessage(resumeMsg) },
                      });
                      sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
                      await ackTurnClose("error", "auto_resume_failed_notice_posted", providerEnteredPrefix);
                      retryBufferedMessages("claude_auto_resume_failed_tail_recovery");
                      failFatalSessionForRecovery(sessionCtx, "claude_auto_resume_failed");
                      return;
                    }
                    continue queryLoop;
                  }

                  emitProviderTurnSettlementEvent(sessionCtx, settlement);
                  // The result now reveals whether a deferred auth signal is a
                  // genuine credential failure or a network-egress 403 that only
                  // looks like auth. Flush the auth hint for the former; for
                  // egress, suppress it — the runtime notice posted at
                  // settlement carries the correct proxy-first guidance.
                  const settledEgressForbidden = isEgressForbiddenText(settlement.messagePreview);
                  if (pendingAuthHint !== null) {
                    if (!settledEgressForbidden && settlement.classification.category === "credential") {
                      authHintEmitted = true;
                      sessionCtx.emitEvent({
                        kind: "error",
                        payload: { source: "sdk", message: formatAuthHint("claude-code", pendingAuthHint) },
                      });
                    }
                    pendingAuthHint = null;
                  }
                  if (
                    !(
                      (authHintEmitted || settledEgressForbidden) &&
                      settlement.classification.category === "credential"
                    )
                  ) {
                    sessionCtx.emitEvent({
                      kind: "error",
                      payload: {
                        source: "sdk",
                        message: `Claude SDK provider failure (${settlement.classification.reasonCode}): ${settlement.messagePreview}`,
                      },
                    });
                  }
                  sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
                  retryCount = 0;
                  const retireCredentialGeneration =
                    settlement.classification.category === "credential" &&
                    settlement.decision.action === "stop" &&
                    settlement.decision.terminalKind === "needs_operator";
                  if (retireCredentialGeneration) {
                    // Prevent messages delivered while the durable runtime
                    // notice / exact-prefix ACK is in flight from reaching
                    // the stale native process. The logical Session and
                    // claudeSessionId remain intact for lazy exact resume.
                    retireProviderTransport();
                  }
                  await ackTurnClose("error", consumedReasonForProviderSettlement(settlement), providerEnteredPrefix);
                  resetTurnReplaySafety();
                  if (retireCredentialGeneration) {
                    // The consumed prefix is now settled and removed from the
                    // replay buffer. Return only the unentered tail to the
                    // existing ordered recovery path, then wait for a newly
                    // delivered message before creating a fresh query.
                    retryBufferedMessages("claude_credential_terminal_tail_recovery", true);
                    credentialResumeRequired = true;
                    if (queuedInjectedMessages.length > 0 && claudeSessionId) {
                      scheduleInjectedMessagesDrain(sessionCtx, claudeSessionId);
                    }
                    return;
                  }
                  continue;
                }
              }

              if (message.subtype === "success") {
                // Close out the turn. The result text is already captured as
                // `assistant_text` events; `forwardResult` no longer delivers
                // it to chat (final-text mirror retired) — it is the
                // turn-completion hook. We AWAIT it (rather than
                // fire-and-forget) so the turn_end emit is guaranteed to hit
                // the WebSocket before the for-await pulls the next turn's
                // first event. Otherwise a slow round-trip could let the
                // server assign a smaller seq to turn N+1's thinking/tool_call
                // than to turn N's turn_end — which would cause the frontend's
                // "latest turn_end" filter to retroactively hide turn N+1's
                // live events.
                if (message.result && sessionCtx.chatId) {
                  const resultText = message.result;
                  // Genuine success — reset retry budget for the next turn.
                  retryCount = 0;
                  try {
                    // Turn-completion hook. The agent's text is already
                    // captured as `assistant_text` events above; `forwardResult`
                    // no longer delivers it to chat (the per-turn final-text
                    // mirror is retired — see runtime/result-sink.ts), it just
                    // closes out the turn trigger.
                    await sessionCtx.forwardResult(resultText);
                    sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "success" } });
                    // Turn closed cleanly — drain in-flight inbox entries.
                    await ackTurnClose("success", "provider_clean_error", providerEnteredPrefix);
                    resetTurnReplaySafety();
                  } catch (err) {
                    const reason = err instanceof Error ? err.message : String(err);
                    sessionCtx.log(`Failed to forward result: ${reason}`);
                    const preview = resultText.slice(0, 1500);
                    const forwardErrMessage = `Result forward failed: ${reason}\n---\n${preview}`.slice(0, 2000);
                    sessionCtx.emitEvent({
                      kind: "error",
                      payload: { source: "runtime", message: forwardErrMessage },
                    });
                    sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
                    // A failure in the completion hook is treated as terminal
                    // for this turn — ack so we don't loop on redelivery. The
                    // hook only closes the turn trigger now (the final-text
                    // mirror is retired, so there is no chat-delivery step to
                    // fail); a throw here is unexpected, but we still degrade
                    // gracefully. If recovery is needed the user can retry by
                    // sending a new message.
                    //
                    // Reset retryCount along with the success branch above:
                    // the SDK actually returned a clean `result` here (any
                    // failure is in our own turn-completion plumbing, not the
                    // model), so the next turn should not inherit the prior
                    // turn's transient-retry counter when an unrelated future
                    // stream error fires.
                    retryCount = 0;
                    await ackTurnClose("error", "forward_failed", providerEnteredPrefix);
                    resetTurnReplaySafety();
                  }
                } else {
                  // No result text to forward (edge case) — still close the turn.
                  // Same reset rationale as the forward-success branch above.
                  retryCount = 0;
                  sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "success" } });
                  await ackTurnClose("success", "provider_clean_error", providerEnteredPrefix);
                  resetTurnReplaySafety();
                }
              }
              // Reset the auth-hint flag only on a SUCCESSFUL result. This
              // gives a clean slate for the next turn once auth is clearly
              // working, while suppressing a duplicate hint when the next
              // turn (or a retry — see flag declaration above) hits the same
              // unhealing auth failure. The user has already been told what
              // to do; repeating it adds noise without new information.
              if (message.subtype === "success") {
                authHintEmitted = false;
                // Drop any deferred auth signal too: a transient auth_status
                // warning followed by a successful turn must not leak a stale
                // auth-login hint at the next stream-end / turn boundary.
                pendingAuthHint = null;
              }
            }
          }
          // Stream ended cleanly without a result to settle a deferred auth
          // signal — emit the hint now (no result means no egress detail to
          // suppress it).
          if (pendingAuthHint !== null) {
            authHintEmitted = true;
            sessionCtx.emitEvent({
              kind: "error",
              payload: { source: "sdk", message: formatAuthHint("claude-code", pendingAuthHint) },
            });
            pendingAuthHint = null;
          }
          return;
        } catch (err) {
          // A deferred auth signal that never reached a result still deserves to
          // surface — the stream-error path below reports the crash, not the
          // auth cause.
          if (pendingAuthHint !== null) {
            authHintEmitted = true;
            sessionCtx.emitEvent({
              kind: "error",
              payload: { source: "sdk", message: formatAuthHint("claude-code", pendingAuthHint) },
            });
            pendingAuthHint = null;
          }
          // Process crash, OOM, or unexpected termination
          const errMsg = err instanceof Error ? err.message : String(err);
          sessionCtx.log(`Query error: ${errMsg}`);

          // Log additional diagnostic details when available
          if (err instanceof Error) {
            if (err.cause)
              sessionCtx.log(`  cause: ${err.cause instanceof Error ? err.cause.message : String(err.cause)}`);
            if ("exitCode" in err) sessionCtx.log(`  exitCode: ${(err as Record<string, unknown>).exitCode}`);
            if ("stderr" in err) sessionCtx.log(`  stderr: ${(err as Record<string, unknown>).stderr}`);
            if ("code" in err) sessionCtx.log(`  code: ${(err as Record<string, unknown>).code}`);
            if (err.stack) sessionCtx.log(`  stack: ${err.stack.split("\n").slice(1, 4).join(" | ")}`);
          }

          const classification = classifyProviderFailure(err, {
            provider: runtimeProvider,
            scope: "provider_turn",
            source: "stream",
          });
          const decision = decideProviderRetry({
            classification,
            scope: "provider_turn",
            attempt: retryCount + 1,
            replaySafety: currentTurnReplaySafety(),
          });

          if (decision.action !== "retry" || !claudeSessionId) {
            sessionCtx.log("Exhausted retries, session will be suspended");
            // Surface to the chat timeline so the user sees the failure and
            // doesn't think the agent silently stalled. The retry-exhausted
            // case in particular drops the turn entirely — no result will
            // be forwarded — so without an explicit error event the chat
            // would just go quiet.
            //
            // Wrap the emits so a broken `onSessionEvent` callback can't
            // short-circuit turn cleanup below.
            try {
              const preview = errMsg.slice(0, 800);
              const reason = claudeSessionId
                ? `Query failed after ${providerTurnMaxRetries} retries: ${preview}`
                : `Query failed and no resume id available: ${preview}`;
              emitProviderTurnRetryEvent(
                sessionCtx,
                decision.action === "stop" && decision.terminalKind === "exhausted"
                  ? "provider_retry_exhausted"
                  : "provider_failure_terminal",
                classification,
                decision.action === "stop"
                  ? decision
                  : {
                      action: "stop",
                      reasonCode: "claude_missing_resume_id",
                      terminalKind: "unsafe_replay",
                      replaySafety: "unknown",
                      userSeverity: "error",
                    },
                preview,
              );
              sessionCtx.emitEvent({ kind: "error", payload: { source: "runtime", message: reason } });
              sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
            } catch (emitErr) {
              sessionCtx.log(
                `Failed to emit retry-exhaustion error event: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`,
              );
            }
            // Ack the in-flight entry for this turn. Without this the row
            // stays `delivered` server-side forever: the in-process
            // Deduplicator collapses every bind-reset replay so the entry
            // never re-dispatches and never gets acked. Per design §4
            // "permanent → ack".
            await ackTurnClose("error", "retry_exhausted_notice_posted");
            retryBufferedMessages("claude_retry_exhausted_tail_recovery");
            failFatalSessionForRecovery(sessionCtx, "claude_retry_exhausted");
            return;
          }

          // Automatic retry — rebuild the SDK query in resume mode AND re-push
          // the unclosed inputs into the freshly built InputController.
          // The old `respawnQuery()` only did the rebuild; the new controller
          // was empty so the SDK subprocess just hung idle waiting for a
          // prompt that never came (it had the resumed conversation history
          // but nothing to drive the next turn). Replaying the unclosed input
          // buffer is the missing half — the SDK sees the same user messages
          // it was processing, including any pushed tail it had not pulled yet.
          //
          // We stay inside THIS consumer loop on purpose: spawning a fresh
          // consumer (via `handler.resume` or `spawnQuery`) would create two
          // parallel for-await loops over `currentQuery`, both stamping
          // their own retryCount counter — under a persistent failure mode
          // (e.g. SDK always throws) that fans out into unbounded recursion.
          //
          // Flush any tool_use blocks that were in-flight when the session
          // crashed so the admin event stream sees them as status:"pending"
          // rather than getting paired against a replayed tool_use_id
          // after resume.
          toolCallProcessor.flush();

          retryCount = decision.attempt;
          emitProviderTurnRetryEvent(sessionCtx, "provider_retry_scheduled", classification, decision, errMsg);
          sessionCtx.log(`Attempting auto-resume (retry ${retryCount}/${providerTurnMaxRetries})`);

          if (!(await waitForProviderRetry(decision.delayMs))) {
            sessionCtx.log("Auto-resume cancelled during provider retry backoff");
            return;
          }

          try {
            await respawnQuery(claudeSessionId, sessionCtx);
          } catch (resumeErr) {
            if (isContextSourceTransitionError(resumeErr)) {
              retryBufferedMessages("claude_context_source_changed");
              failFatalSessionForRecovery(sessionCtx, "claude_context_source_changed");
              return;
            }
            const resumeMsg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
            sessionCtx.log(`Auto-resume failed: ${resumeMsg}`);
            // Mirror the MAX_RETRIES branch above and close the turn
            // deterministically so the slot can be reclaimed.
            try {
              emitAutoResumeFailedTerminalEvent({
                sessionCtx,
                classification,
                replaySafety: decision.replaySafety,
                providerMessagePreview: errMsg,
                resumeMsg,
              });
              sessionCtx.emitEvent({
                kind: "error",
                payload: { source: "runtime", message: formatAutoResumeFailedMessage(resumeMsg) },
              });
              sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
            } catch (emitErr) {
              sessionCtx.log(
                `Failed to emit auto-resume error event: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`,
              );
            }
            // Same reasoning as the MAX_RETRIES branch above — without this
            // ack the row would loop in `delivered` forever, deduped on every
            // bind-reset replay. Per design §4 "permanent → ack".
            await ackTurnClose("error", "auto_resume_failed_notice_posted");
            retryBufferedMessages("claude_auto_resume_failed_tail_recovery");
            failFatalSessionForRecovery(sessionCtx, "claude_auto_resume_failed");
            return;
          }
        }
      }
    } finally {
      // Normal completion (for-await ended) or fatal return — flush any
      // tool_use blocks that never received a tool_result as status:"pending".
      toolCallProcessor.flush();
    }
  }

  const contextSource = contextSourceFromHandlerConfig(config);
  const contextTree = preparationCoordinatesFromSource(contextSource);
  const gitAttribution = remoteGitAttributionFromSource(contextSource);
  const contextTreePath = gitAttribution.contextTreePath;
  const contextTreeRepoUrl = gitAttribution.contextTreeRepoUrl;
  const contextTreeBranch = contextTree.kind === "remote" ? contextTree.branch : null;

  /**
   * Probe whether the Claude Code SDK can resume the given session at the
   * current cwd. The SDK stores per-project transcripts at
   * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, where
   * `encoded-cwd` is the absolute cwd with every non-alphanumeric char
   * replaced by `-`. If the file is missing, `query({ resume })` throws
   * `No conversation found with session ID: <id>` asynchronously inside
   * the consume loop, surfacing as an SDK error in the chat timeline.
   *
   * This shows up after the agent-session-cwd-redesign upgrade: per-chat
   * cwd transcripts live under a chatId-suffixed encoded path that no
   * longer matches the new per-agent-home encoding, so legacy sessionIds
   * can't be resumed in place. See proposal §⓪.3 R2.
   *
   * 🔍 Encoding rule sourcing: the `[^a-zA-Z0-9-]` → `-` substitution
   * matches Claude Agent SDK 0.2.x's on-disk behavior, verified empirically
   * by listing `~/.claude/projects/` against known cwds — an absolute path
   * like `/Users/alice/project` becomes the directory `-Users-alice-project`,
   * and `/foo/.bar` becomes `-foo--bar` (the `.` is non-alphanumeric).
   * The SDK does not export a public helper for the encoding, so an
   * upstream change here would silently invalidate this probe → fallback
   * either fails to trigger (loud SDK error returns) or triggers
   * unnecessarily (cold-start an existing session). When bumping
   * `@anthropic-ai/claude-agent-sdk`, re-verify the encoding rule.
   *
   * Returning `false` lets the caller pick either:
   *   - run the resume against a different cwd that DOES have the
   *     transcript (legacy chat dir, see `resume()` body); or
   *   - mint a fresh sessionId and fall through to start() semantics.
   */
  function claudeSessionFileExists(workspaceCwd: string, sessionId: string): boolean {
    const encoded = workspaceCwd.replace(/[^a-zA-Z0-9-]/g, "-");
    return existsSync(join(homedir(), ".claude", "projects", encoded, `${sessionId}.jsonl`));
  }

  const handler: AgentHandler = {
    async start(message, sessionCtx, token) {
      const deliveryToken = token;
      ctx = sessionCtx;
      claudeSessionId = randomUUID();

      // Resolve chat-context and source repos before spawning the SDK:
      // source repos are rendered into the shared briefing, while chat-context
      // is appended through the SDK system prompt channel in buildQuery().
      const runtimeConfig = agentConfigCache?.get(sessionCtx.agent.agentId) ?? null;
      let payload = runtimeConfig?.payload ?? null;
      const payloadResolved = payload !== null;
      payload ??= { ...DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD };

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
      // Per agent-session-cwd-redesign: cwd is per-agent, shared by every
      // chat session. prepareManagedSession acquires the home (and writes the
      // boundary marker on first call; afterwards acquire is a no-op).
      cwd = prepared.workspace;
      chatContextForPrompt = prepared.chatContext;
      const briefing = prepared.briefing;

      const providerEnv = buildEnv(sessionCtx);

      // Seed the briefing baseline: a fresh session starts in sync with the
      // briefing it was built under, so its first turn carries no notice. The
      // baseline is also persisted so a resume before this session ever ran a
      // turn has a real baseline rather than reading null (a false "changed").
      currentBriefingFingerprint = computeBriefingFingerprint(briefing);
      deliveredBriefingFingerprint = currentBriefingFingerprint;
      writeSessionBriefingFingerprint(cwd, claudeSessionId, currentBriefingFingerprint);

      sessionCtx.log(
        `Starting session (${claudeSessionId}), cwd=${cwd}, permissionMode=${config.permissionMode ?? "bypassPermissions"}`,
      );
      // Convert before spawning the consumer loop, then stash/push
      // synchronously after the query exists. This preserves the retry
      // replay payload while still attaching ACK metadata before the SDK can
      // pull the prompt.
      const sdkMsg = await toSDKUserMessage(message, sessionCtx, claudeSessionId);
      await assertQuerySpawnCurrent(sessionCtx);
      spawnQuery(claudeSessionId, sessionCtx, undefined, providerEnv);
      deliverUserMessage(sdkMsg, message, deliveryToken, claudeSessionId, sessionCtx);
      scheduleInjectedMessagesDrain(sessionCtx, claudeSessionId);

      sessionCtx.log(`Session started (${claudeSessionId})`);
      return { sessionId: claudeSessionId, route: { kind: "owned", mode: "processing" } };
    },

    async resume(message, sessionId, sessionCtx, token) {
      const deliveryToken = message ? requireDeliveryToken(token, "messageful resume") : noopDeliveryToken();
      ctx = sessionCtx;
      claudeSessionId = sessionId;
      retryCount = 0;

      // R2 backward-compat: a session created BEFORE this PR ran with cwd =
      // `<workspaceRoot>/<chatId>/`, so its Claude SDK transcript is keyed
      // off that path's encoding under `~/.claude/projects/`. The new
      // per-agent-home cwd would NOT find it and would error with `No
      // conversation found ...`. To preserve the agent's SDK turn history
      // across upgrade, probe the legacy chat dir first — if the transcript
      // is there, run the resume against the legacy cwd verbatim and skip
      // every piece of agent-home setup (the legacy dir already has its own
      // legacy `.agent/`, CLAUDE.md, and gitRepos checkout at top-level).
      const legacyCwd = join(workspaceRoot, sessionCtx.chatId);
      const isLegacy = existsSync(legacyCwd) && claudeSessionFileExists(legacyCwd, sessionId);

      if (isLegacy) {
        cwd = legacyCwd;
        sessionCtx.log(
          `Resume: detected pre-redesign SDK transcript at legacy cwd ${legacyCwd}; ` +
            "running this session under the legacy per-chat layout to preserve agent memory",
        );
        const runtimeConfig = agentConfigCache?.get(sessionCtx.agent.agentId) ?? null;
        let payload = runtimeConfig?.payload ?? null;
        const payloadResolved = payload !== null;
        payload ??= { ...DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD };
        const chatContext = await fetchChatContextOrLog(sessionCtx);
        chatContextForPrompt = chatContext;
        // Intentionally NOT calling ensureAgentBootstrap / declareSourceRepos /
        // markWorkspaceInitComplete here — those write the new
        // `.first-tree-workspace/` agent-home layout, which would pollute the
        // legacy chat dir's v1.x `.agent/` and `<localPath>/` source repos.
        //
        // We DO refresh the briefing and reconcile Skills in this legacy cwd.
        // The reconciler owns a narrowly scoped `.first-tree-workspace/`
        // state/lock/journal there; it does not run the broader workspace
        // bootstrap, source-repo declaration, or init-complete flow. Current
        // Chat Context remains separate in `systemPrompt.append`.
        // `sourceReposForPrompt` stays `[]` here on purpose: the declared
        // paths are derived against the agent home, not the legacy cwd, so
        // the briefing's Source Repositories section is omitted for legacy
        // resumes. The agent still finds the v1.x checkouts at their
        // original `<localPath>/` — just without a top-level enumeration in
        // the prompt.
        //
        // Project Core and Team Skills to the legacy cwd as well. `cwd` is
        // `legacyCwd` here (set above), NOT the agent home, so provider-native
        // discovery and its managed transaction state are session-local.
        // Briefing is written inside the source-publication lock; do not
        // rewrite AGENTS.md after the projector returns.
        const projected = await projectManagedWorkspace({
          sessionCtx,
          workspace: cwd,
          sourceAuthorityRoot: workspaceRoot,
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
          reresolveSource: true,
          markInitComplete: false,
          writeIdentityAndManifest: false,
          suppressSourceRepos: true,
          allowLegacyTargetUpgrade: true,
        });
        const briefing = projected.briefing;
        const providerEnv = buildEnv(sessionCtx);
        currentBriefingFingerprint = computeBriefingFingerprint(briefing);
        deliveredBriefingFingerprint = readSessionBriefingFingerprint(cwd, sessionId);
        // Same convert-stash-then-spawn ordering as `start()` so a stream
        // error fired on the first turn of the resumed session can replay
        // through `respawnQuery`.
        let sdkMsg: SDKUserMessage | null = null;
        if (message) {
          sdkMsg = await toSDKUserMessage(message, sessionCtx, sessionId);
        }
        await assertQuerySpawnCurrent(sessionCtx);
        spawnQuery(sessionId, sessionCtx, sessionId, providerEnv);
        if (sdkMsg) {
          if (message) pushPendingSdkInput(createPendingSdkInput(sdkMsg, message, deliveryToken));
        }
        scheduleInjectedMessagesDrain(sessionCtx, sessionId);
        sessionCtx.log(`Session resumed at legacy cwd (${sessionId})`);
        return { sessionId, route: message ? { kind: "owned", mode: "processing" } : null };
      }

      // Normal new-design resume path: cwd is the agent home.
      // Identical control flow to start(): prepareManagedSession is idempotent
      // and the sentinel gates the heavier stable workspace bootstrap. The cheap
      // identity hash check still runs so agent rename / inboxId changes
      // propagate after initialization.
      const runtimeConfig = agentConfigCache?.get(sessionCtx.agent.agentId) ?? null;
      let payload = runtimeConfig?.payload ?? null;
      const payloadResolved = payload !== null;
      payload ??= { ...DEFAULT_AGENT_RUNTIME_CONFIG_PAYLOAD };

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
      chatContextForPrompt = prepared.chatContext;
      const briefing = prepared.briefing;

      const providerEnv = buildEnv(sessionCtx);

      // Defensive fallback: sessionId isn't recognised at EITHER cwd (likely
      // a stale registry entry from machine swap / fs cleanup / tampering).
      // Mint a fresh id and start cold — First Tree message history survives.
      if (!claudeSessionFileExists(cwd, sessionId)) {
        const freshSessionId = randomUUID();
        sessionCtx.log(
          `Resume: SDK transcript for ${sessionId} not found at legacy (${legacyCwd}) ` +
            `or agent home (${cwd}); starting fresh session ${freshSessionId} — ` +
            "First Tree message history is preserved.",
        );
        claudeSessionId = freshSessionId;
        // Cold start under a fresh id: seed the baseline in sync, so the first
        // turn carries no notice — there is no prior transcript built under a
        // stale briefing to warn about.
        currentBriefingFingerprint = computeBriefingFingerprint(briefing);
        deliveredBriefingFingerprint = currentBriefingFingerprint;
        writeSessionBriefingFingerprint(cwd, freshSessionId, currentBriefingFingerprint);
        let freshSdkMsg: SDKUserMessage | null = null;
        if (message) {
          freshSdkMsg = await toSDKUserMessage(message, sessionCtx, freshSessionId);
        }
        await assertQuerySpawnCurrent(sessionCtx);
        spawnQuery(freshSessionId, sessionCtx, undefined, providerEnv);
        if (freshSdkMsg && message) {
          deliverUserMessage(freshSdkMsg, message, deliveryToken, freshSessionId, sessionCtx);
        }
        scheduleInjectedMessagesDrain(sessionCtx, freshSessionId);
        sessionCtx.log(`Session started (${freshSessionId}, replacing ${sessionId})`);
        return { sessionId: freshSessionId, route: message ? { kind: "owned", mode: "processing" } : null };
      }

      sessionCtx.log(`Resuming session (${sessionId}), cwd=${cwd}`);

      // Briefing-staleness baseline for this resumed session. `current` is the
      // briefing just rewritten above; `delivered` loads the fingerprint the
      // session last ran a turn under — null means a session predating this
      // mechanism, treated as changed so it gets one re-read nudge. The compare
      // + notice + baseline advance happen in deliverUserMessage, after the
      // input is buffered (a no-message reclaim advances nothing, so the next
      // real turn still surfaces the change).
      currentBriefingFingerprint = computeBriefingFingerprint(briefing);
      deliveredBriefingFingerprint = readSessionBriefingFingerprint(cwd, sessionId);

      let resumeSdkMsg: SDKUserMessage | null = null;
      if (message) {
        resumeSdkMsg = await toSDKUserMessage(message, sessionCtx, sessionId);
      }
      await assertQuerySpawnCurrent(sessionCtx);
      spawnQuery(sessionId, sessionCtx, sessionId, providerEnv);
      if (resumeSdkMsg && message) {
        deliverUserMessage(resumeSdkMsg, message, deliveryToken, sessionId, sessionCtx);
      }
      scheduleInjectedMessagesDrain(sessionCtx, sessionId);

      sessionCtx.log(`Session resumed (${sessionId})`);
      return { sessionId, route: message ? { kind: "owned", mode: "processing" } : null };
    },

    inject(message, token) {
      if (!claudeSessionId || !ctx) {
        ctx?.log("inject() called but no active session — dropping message");
        return { kind: "rejected", reason: "no_active_session", retryable: true };
      }
      const sessionCtx = ctx;
      const deliveryToken = token;
      const sid = claudeSessionId;
      queuedInjectedMessages.push({ message, token: deliveryToken });
      scheduleInjectedMessagesDrain(sessionCtx, sid);
      return { kind: "owned", mode: "queued" };
    },

    async suspend(reason?: string) {
      ctx?.log("Suspending session");
      credentialResumeRequired = false;
      retireProviderTransport();

      // Wait for consumer loop to finish
      if (consumerDone) {
        await consumerDone.catch(() => {});
        consumerDone = null;
      }

      // The session is no longer active — any pending replay inputs would be
      // moot. Resume goes through `handler.resume(message, sessionId)`, which
      // builds a fresh replay buffer from its own pushed inputs.
      retryBufferedMessages(reason ?? "claude_suspend_before_terminal");
      injectDrainInProgress = false;
    },

    async shutdown(reason?: string) {
      await handler.suspend(reason);
      // Per agent-session-cwd-redesign: cwd is the per-agent home — shared
      // by every chat. shutdown() of ONE chat must NOT remove it (would
      // wipe persistent state and worktrees other chats are using).
      //
      // Source repos and the Context Tree clone are agent-managed state
      // (the agent clones / refreshes them per its briefing protocol), and
      // on-demand worktrees under `<cwd>/worktrees/<name>/` live until the
      // agent itself removes them when the task closes (e.g. on PR merge) —
      // the runtime touches none of them on shutdown.
      cwd = null;
    },
  };

  return handler;
};
