import type {
  ProviderFailureCategory,
  ProviderRetryEventName,
  ProviderRetryEventPayload,
  ProviderRetryScope,
  ReplaySafety,
  RuntimeProvider,
} from "@first-tree/shared";
import { AGENT_RUNTIME_SESSION_ERROR_CODES } from "@first-tree/shared";
import { type Classification, classify, ERROR_KINDS } from "./error-taxonomy.js";
import { isManagedSkillsUnsafeDiscoveryError } from "./managed-skills.js";
import { redactErrorPreview } from "./redact-error-preview.js";

export type ProviderFailureClassification = {
  category: ProviderFailureCategory;
  reasonCode: string;
  message: string;
  retryAfterMs?: number;
  sourceKind: Classification["kind"];
};

export type ProviderRetryDecision =
  | {
      action: "retry";
      delayMs: number;
      reasonCode: string;
      attempt: number;
      maxAttempts?: number;
      retryMode: "foreground" | "background";
      replaySafety: ReplaySafety;
      userSeverity: "info" | "warning";
    }
  | {
      action: "stop";
      reasonCode: string;
      terminalKind:
        | "deterministic"
        | "exhausted"
        | "unsafe_replay"
        | "needs_operator"
        | "capacity_wait_required"
        | "runtime_rebind_required";
      replaySafety: ReplaySafety;
      userSeverity: "warning" | "error";
    };

export type ProviderFailureSource = "session" | "stream" | "sdk" | "auth" | "bind";

const PROVIDER_TURN_MAX_RETRIES = 2;
const PROVIDER_TURN_DELAYS_MS = [500, 1500] as const;
const PROVIDER_TURN_CAPACITY_SHORT_WAIT_MS = 30_000;
const UNKNOWN_MAX_RETRIES = 2;
const UNKNOWN_DELAYS_MS = [5_000, 15_000] as const;
const SESSION_FOREGROUND_RETRIES = 3;
const SESSION_TRANSIENT_CAP_MS = 60_000;
const SESSION_CAPACITY_CAP_MS = 5 * 60_000;
const AUTH_HTTP_CODE_RE = /\b(401|403)\b/;
const TRANSIENT_HTTP_CODE_RE = /\b(500|502|503|504)\b/;

export const MANAGED_SKILLS_UNSAFE_DISCOVERY_REASON_CODE = "managed_skills_unsafe_discovery";

export const PROVIDER_UNSAFE_REPLAY_NOTICE_UNSETTLED = "provider_unsafe_replay_notice_unsettled";

/**
 * Only providers that classify an interrupted turn with provider-entered
 * activity as unrecoverably ambiguous may hold its row for terminal-notice
 * custody. Other providers keep the generic notice-failure recovery behavior.
 */
export function requiresUnsafeReplayNoticeCustody(provider: RuntimeProvider): boolean {
  return provider === "antigravity";
}

export function classifyProviderFailure(
  err: unknown,
  context: {
    provider: RuntimeProvider;
    scope: ProviderRetryScope;
    source?: ProviderFailureSource;
  },
): ProviderFailureClassification {
  const source = context.source === "sdk" ? undefined : context.source;
  const base = classify(err, source ? { source } : undefined);
  const shape = readErrorShape(err);
  const text = `${shape.name ?? ""} ${shape.message ?? ""} ${shape.code ?? ""} ${shape.reason ?? ""}`.toLowerCase();
  const retryAfterMs = readRetryAfterMs(shape);
  const status = shape.status ?? shape.statusCode;

  const runtimeSessionReason = runtimeSessionProofReason(shape, text);
  if (runtimeSessionReason) {
    return {
      category: "runtime_transport",
      reasonCode: runtimeSessionReason,
      message: base.message,
      sourceKind: base.kind,
    };
  }
  if (isManagedSkillsUnsafeDiscoveryError(err)) {
    return {
      category: "transient_transport",
      reasonCode: MANAGED_SKILLS_UNSAFE_DISCOVERY_REASON_CODE,
      message: base.message,
      sourceKind: base.kind,
    };
  }
  if (isBillingLimit(text)) {
    return {
      category: "provider_capacity",
      reasonCode: "provider_billing_limit",
      message: base.message,
      retryAfterMs,
      sourceKind: base.kind,
    };
  }
  // A resolved binary failure is a capability problem even when the
  // provider's own error text names the provider (for example, "Antigravity
  // CLI is missing"). Keep it ahead of provider-gated auth heuristics so an
  // installation issue cannot surface as a misleading re-login prompt.
  if (isCapability(text, base)) {
    return {
      category: "capability",
      reasonCode: base.reasonCode,
      message: base.message,
      retryAfterMs,
      sourceKind: base.kind,
    };
  }
  if (isCredential(text, base, status, context.provider)) {
    return {
      category: "credential",
      reasonCode: credentialReason(base),
      message: base.message,
      retryAfterMs,
      sourceKind: base.kind,
    };
  }
  // Grok deterministic capability gates, produced by the win32 fail-closed
  // path (handler bring-up / resolveGrokRuntimeBinary refusal) and the
  // resolved-but-unsupported binary verdict (out-of-range / failed
  // verification). Both must stop deterministically — never the unknown
  // retry path, never the binary_missing reason code (that one is reserved
  // for "no binary resolved").
  if (context.provider === "amp" && /not supported on windows in v1/.test(text)) {
    return {
      category: "capability",
      reasonCode: "amp_platform_unsupported",
      message: base.message,
      retryAfterMs,
      sourceKind: base.kind,
    };
  }
  if (context.provider === "deepseek-harness" && /not supported on windows in v1/.test(text)) {
    return {
      category: "capability",
      reasonCode: "deepseek_platform_unsupported",
      message: base.message,
      retryAfterMs,
      sourceKind: base.kind,
    };
  }
  if (context.provider === "grok" && /not supported on windows in v1/.test(text)) {
    return {
      category: "capability",
      reasonCode: "grok_platform_unsupported",
      message: base.message,
      retryAfterMs,
      sourceKind: base.kind,
    };
  }
  if (context.provider === "antigravity" && /not supported on windows in v1/.test(text)) {
    return {
      category: "capability",
      reasonCode: "antigravity_platform_unsupported",
      message: base.message,
      retryAfterMs,
      sourceKind: base.kind,
    };
  }
  if (context.provider === "grok" && /is not a supported grok build version/.test(text)) {
    return {
      category: "capability",
      reasonCode: "grok_binary_unsupported",
      message: base.message,
      retryAfterMs,
      sourceKind: base.kind,
    };
  }
  if (context.provider === "pi" && /not supported on windows in v1/.test(text)) {
    return {
      category: "capability",
      reasonCode: "pi_platform_unsupported",
      message: base.message,
      retryAfterMs,
      sourceKind: base.kind,
    };
  }
  if (
    context.provider === "pi" &&
    (/unsupported version/.test(text) || /is not a supported pi/.test(text) || /requires >=/.test(text))
  ) {
    return {
      category: "capability",
      reasonCode: "pi_binary_unsupported",
      message: base.message,
      retryAfterMs,
      sourceKind: base.kind,
    };
  }
  // Malformed/incompatible get_state and stable-session identity drift are
  // protocol failures — terminal capability, never unknown-retry forever.
  if (context.provider === "pi" && isPiProtocolError(shape.name, text)) {
    return {
      category: "capability",
      reasonCode: "pi_protocol_error",
      message: base.message,
      retryAfterMs,
      sourceKind: base.kind,
    };
  }
  if (isConfiguration(text, base, context.provider)) {
    return {
      category: "configuration",
      reasonCode: configurationReason(text, base, context.provider),
      message: base.message,
      retryAfterMs,
      sourceKind: base.kind,
    };
  }
  if (isDeterministicInput(text, base)) {
    return {
      category: "deterministic_input",
      reasonCode: deterministicReason(base),
      message: base.message,
      retryAfterMs,
      sourceKind: base.kind,
    };
  }
  if (isCapacity(text, base, retryAfterMs, context.provider)) {
    return {
      category: "provider_capacity",
      reasonCode: capacityReason(text, base),
      message: base.message,
      retryAfterMs,
      sourceKind: base.kind,
    };
  }
  if ((base.kind === ERROR_KINDS.TRANSIENT && base.reasonCode !== "unknown") || isTransportText(text)) {
    return {
      category: "transient_transport",
      reasonCode: transientReason(base, context.provider),
      message: base.message,
      retryAfterMs,
      sourceKind: base.kind,
    };
  }
  if (base.reasonCode === "unknown") {
    return { category: "unknown", reasonCode: "unknown", message: base.message, retryAfterMs, sourceKind: base.kind };
  }
  return {
    category: "unknown",
    reasonCode: base.reasonCode || "unknown",
    message: base.message,
    retryAfterMs,
    sourceKind: base.kind,
  };
}

export function decideProviderRetry(input: {
  classification: ProviderFailureClassification;
  scope: ProviderRetryScope;
  attempt: number;
  firstFailedAt?: number;
  retryAfterMs?: number;
  replaySafety: ReplaySafety;
}): ProviderRetryDecision {
  const attempt = Math.max(1, Math.floor(input.attempt));
  const retryAfterMs = input.retryAfterMs ?? input.classification.retryAfterMs;

  if (input.classification.category === "runtime_transport") {
    return stop(input.classification.reasonCode, "runtime_rebind_required", input.replaySafety, "warning");
  }

  if (
    input.scope === "provider_turn" &&
    isUnsafeReplay(input.replaySafety) &&
    (input.classification.reasonCode === MANAGED_SKILLS_UNSAFE_DISCOVERY_REASON_CODE ||
      !isRetryableUserVisibleFailure(input.classification.category, input.replaySafety))
  ) {
    return stop("unsafe_replay", "unsafe_replay", input.replaySafety, "warning");
  }

  switch (input.classification.category) {
    case "credential":
      return stop(input.classification.reasonCode, "needs_operator", input.replaySafety, "error");
    case "capability":
    case "configuration":
      return stop(input.classification.reasonCode, "needs_operator", input.replaySafety, "error");
    case "deterministic_input":
      return stop(input.classification.reasonCode, "deterministic", input.replaySafety, "error");
    case "unknown":
      return decideUnknown(input.scope, attempt, input.replaySafety);
    case "transient_transport":
      return input.scope === "provider_turn"
        ? decideProviderTurnTransient(input.classification.reasonCode, attempt, input.replaySafety)
        : decideSessionTransient(input.classification.reasonCode, attempt, input.replaySafety);
    case "provider_capacity":
      return input.scope === "provider_turn"
        ? decideProviderTurnCapacity(input.classification.reasonCode, attempt, retryAfterMs, input.replaySafety)
        : decideSessionCapacity(input.classification.reasonCode, attempt, retryAfterMs, input.replaySafety);
  }
}

export function buildProviderRetryEvent(input: {
  event: ProviderRetryEventName;
  provider: RuntimeProvider;
  scope: ProviderRetryScope;
  classification: ProviderFailureClassification;
  decision?: ProviderRetryDecision;
  messagePreview?: string | null;
  now?: number;
}): ProviderRetryEventPayload {
  const retryDecision = input.decision?.action === "retry" ? input.decision : null;
  const severity =
    input.decision?.userSeverity ??
    (input.event === "provider_retry_exhausted" || input.event === "provider_failure_terminal" ? "error" : "info");
  return {
    event: input.event,
    provider: input.provider,
    scope: input.scope,
    category: input.classification.category,
    reasonCode: input.decision?.reasonCode ?? input.classification.reasonCode,
    ...(retryDecision ? { attempt: retryDecision.attempt } : {}),
    ...(retryDecision?.maxAttempts ? { maxAttempts: retryDecision.maxAttempts } : {}),
    ...(retryDecision ? { retryMode: retryDecision.retryMode } : {}),
    ...(retryDecision ? { delayMs: retryDecision.delayMs } : {}),
    ...(retryDecision
      ? { nextRetryAt: new Date((input.now ?? Date.now()) + retryDecision.delayMs).toISOString() }
      : {}),
    ...(input.decision?.replaySafety ? { replaySafety: input.decision.replaySafety } : {}),
    userSeverity: severity,
    ...(input.messagePreview ? { messagePreview: redactErrorPreview(input.messagePreview, 256) } : {}),
  };
}

export function maxProviderTurnRetryAttempts(): number {
  return PROVIDER_TURN_MAX_RETRIES;
}

function decideProviderTurnTransient(
  reasonCode: string,
  attempt: number,
  replaySafety: ReplaySafety,
): ProviderRetryDecision {
  if (attempt <= PROVIDER_TURN_MAX_RETRIES) {
    return retry(
      reasonCode,
      attempt,
      PROVIDER_TURN_MAX_RETRIES,
      PROVIDER_TURN_DELAYS_MS[attempt - 1] ?? 1500,
      "foreground",
      replaySafety,
      "info",
    );
  }
  return stop(`${reasonCode}_exhausted`, "exhausted", replaySafety, "error");
}

function decideProviderTurnCapacity(
  reasonCode: string,
  attempt: number,
  retryAfterMs: number | undefined,
  replaySafety: ReplaySafety,
): ProviderRetryDecision {
  if (reasonCode === "provider_billing_limit") {
    return stop(reasonCode, "capacity_wait_required", replaySafety, "error");
  }
  if (replaySafety === "pre_provider") {
    return decideProviderTurnTransient(reasonCode, attempt, replaySafety);
  }
  if (reasonCode === "provider_overloaded" && retryAfterMs === undefined) {
    if (attempt <= PROVIDER_TURN_MAX_RETRIES) {
      return retry(
        reasonCode,
        attempt,
        PROVIDER_TURN_MAX_RETRIES,
        PROVIDER_TURN_DELAYS_MS[attempt - 1] ?? 1500,
        "foreground",
        replaySafety,
        "warning",
      );
    }
    return stop(`${reasonCode}_exhausted`, "exhausted", replaySafety, "error");
  }
  if (retryAfterMs !== undefined && retryAfterMs <= PROVIDER_TURN_CAPACITY_SHORT_WAIT_MS) {
    if (attempt <= PROVIDER_TURN_MAX_RETRIES) {
      return retry(reasonCode, attempt, PROVIDER_TURN_MAX_RETRIES, retryAfterMs, "foreground", replaySafety, "warning");
    }
    return stop(`${reasonCode}_exhausted`, "exhausted", replaySafety, "error");
  }
  return stop("capacity_wait_required", "capacity_wait_required", replaySafety, "warning");
}

function decideSessionTransient(
  reasonCode: string,
  attempt: number,
  replaySafety: ReplaySafety,
): ProviderRetryDecision {
  const delayMs = Math.min(1000 * 2 ** (attempt - 1), SESSION_TRANSIENT_CAP_MS);
  return retry(
    reasonCode,
    attempt,
    undefined,
    delayMs,
    attempt <= SESSION_FOREGROUND_RETRIES ? "foreground" : "background",
    replaySafety,
    attempt <= SESSION_FOREGROUND_RETRIES ? "info" : "warning",
  );
}

function decideSessionCapacity(
  reasonCode: string,
  attempt: number,
  retryAfterMs: number | undefined,
  replaySafety: ReplaySafety,
): ProviderRetryDecision {
  const backoffMs = Math.min(1000 * 2 ** (attempt - 1), SESSION_CAPACITY_CAP_MS);
  return retry(reasonCode, attempt, undefined, retryAfterMs ?? backoffMs, "background", replaySafety, "warning");
}

function decideUnknown(scope: ProviderRetryScope, attempt: number, replaySafety: ReplaySafety): ProviderRetryDecision {
  if (attempt <= UNKNOWN_MAX_RETRIES) {
    return retry(
      "unknown",
      attempt,
      UNKNOWN_MAX_RETRIES,
      UNKNOWN_DELAYS_MS[attempt - 1] ?? 15_000,
      scope === "provider_turn" ? "foreground" : "foreground",
      replaySafety,
      "warning",
    );
  }
  return stop("unknown_exhausted", "exhausted", replaySafety, "error");
}

function retry(
  reasonCode: string,
  attempt: number,
  maxAttempts: number | undefined,
  delayMs: number,
  retryMode: "foreground" | "background",
  replaySafety: ReplaySafety,
  userSeverity: "info" | "warning",
): ProviderRetryDecision {
  return {
    action: "retry",
    delayMs,
    reasonCode,
    attempt,
    ...(maxAttempts ? { maxAttempts } : {}),
    retryMode,
    replaySafety,
    userSeverity,
  };
}

function stop(
  reasonCode: string,
  terminalKind: Extract<ProviderRetryDecision, { action: "stop" }>["terminalKind"],
  replaySafety: ReplaySafety,
  userSeverity: "warning" | "error",
): ProviderRetryDecision {
  return { action: "stop", reasonCode, terminalKind, replaySafety, userSeverity };
}

function isUnsafeReplay(replaySafety: ReplaySafety): boolean {
  return replaySafety === "user_visible" || replaySafety === "unsafe" || replaySafety === "unknown";
}

function isRetryableUserVisibleFailure(category: ProviderFailureCategory, replaySafety: ReplaySafety): boolean {
  return replaySafety === "user_visible" && (category === "provider_capacity" || category === "transient_transport");
}

type ErrorShape = {
  name?: string;
  message?: string;
  code?: string | number;
  status?: number;
  statusCode?: number;
  reason?: string;
  retryAfterMs?: number;
  retryAfter?: string | number;
};

function readErrorShape(err: unknown): ErrorShape {
  if (err instanceof Error) {
    const record = err as unknown as Record<string, unknown>;
    return {
      name: err.name,
      message: err.message,
      code: typeof record.code === "string" || typeof record.code === "number" ? record.code : undefined,
      status: typeof record.status === "number" ? record.status : undefined,
      statusCode: typeof record.statusCode === "number" ? record.statusCode : undefined,
      reason: typeof record.reason === "string" ? record.reason : undefined,
      retryAfterMs: typeof record.retryAfterMs === "number" ? record.retryAfterMs : undefined,
      retryAfter:
        typeof record.retryAfter === "string" || typeof record.retryAfter === "number" ? record.retryAfter : undefined,
    };
  }
  if (typeof err === "string") return { message: err };
  if (!err || typeof err !== "object") return { message: String(err) };
  const record = err as Record<string, unknown>;
  return {
    name: typeof record.name === "string" ? record.name : undefined,
    message: typeof record.message === "string" ? record.message : JSON.stringify(err),
    code: typeof record.code === "string" || typeof record.code === "number" ? record.code : undefined,
    status: typeof record.status === "number" ? record.status : undefined,
    statusCode: typeof record.statusCode === "number" ? record.statusCode : undefined,
    reason: typeof record.reason === "string" ? record.reason : undefined,
    retryAfterMs: typeof record.retryAfterMs === "number" ? record.retryAfterMs : undefined,
    retryAfter:
      typeof record.retryAfter === "string" || typeof record.retryAfter === "number" ? record.retryAfter : undefined,
  };
}

function readRetryAfterMs(shape: ErrorShape): number | undefined {
  if (typeof shape.retryAfterMs === "number" && Number.isFinite(shape.retryAfterMs) && shape.retryAfterMs >= 0) {
    return Math.floor(shape.retryAfterMs);
  }
  if (typeof shape.retryAfter === "number" && Number.isFinite(shape.retryAfter) && shape.retryAfter >= 0) {
    return Math.floor(shape.retryAfter * 1000);
  }
  if (typeof shape.retryAfter === "string") {
    const numeric = Number(shape.retryAfter);
    if (Number.isFinite(numeric) && numeric >= 0) return Math.floor(numeric * 1000);
    const dateMs = Date.parse(shape.retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

function runtimeSessionProofReason(shape: ErrorShape, text: string): string | null {
  if (
    shape.code === AGENT_RUNTIME_SESSION_ERROR_CODES.MISSING ||
    text.includes(AGENT_RUNTIME_SESSION_ERROR_CODES.MISSING.toLowerCase()) ||
    /missing x-agent-runtime-session header/.test(text)
  ) {
    return "runtime_session_missing";
  }
  if (
    shape.code === AGENT_RUNTIME_SESSION_ERROR_CODES.INVALID ||
    text.includes(AGENT_RUNTIME_SESSION_ERROR_CODES.INVALID.toLowerCase()) ||
    /invalid agent runtime session/.test(text)
  ) {
    return "runtime_session_invalid";
  }
  return null;
}

function isCredential(
  text: string,
  base: Classification,
  status: number | undefined,
  provider: RuntimeProvider,
): boolean {
  if (
    status === 401 ||
    status === 403 ||
    base.reasonCode.includes("auth") ||
    base.reasonCode.includes("unauthorized") ||
    AUTH_HTTP_CODE_RE.test(text) ||
    /unauthorized|forbidden|invalid api key|invalid_api_key|authentication|login required|not authenticated|oauth_org_not_allowed|auth\.(?:login_required|provisioning_required|token_missing|token_unauthorized|model_not_resolved)|provider\.auth_error/.test(
      text,
    )
  ) {
    return true;
  }
  // Amp CLI logged-out / missing-key phrasings (kept in sync with isAmpAuthError
  // in handlers/auth-error-hint.ts). Provider-gated: the official absent-key
  // path prints "No API key found. Starting login flow..." and never mentions
  // `amp login` / `AMP_API_KEY`, so those substrings must still classify
  // credential without leaking them into other providers' traffic.
  if (provider === "amp" && /not logged in|amp login|amp_api_key|no api key found|starting login flow/.test(text)) {
    return true;
  }
  if (
    provider === "deepseek-harness" &&
    /missing_credential|deepseek_api_key|missing api key|not authenticated|invalid api key|invalid_credential/.test(
      text,
    )
  ) {
    return true;
  }
  // Cursor CLI logged-out phrasings (kept in sync with isCursorAuthError in
  // handlers/auth-error-hint.ts). Provider-gated: the in-chat "Log in to
  // Cursor" CTA renders only for category=credential, so a wording variant
  // that drops the word "authentication" must still classify credential —
  // without leaking these generic phrases into other providers' traffic.
  if (provider === "cursor" && /not logged in|agent login|cursor_api_key/.test(text)) return true;
  // Grok Build CLI logged-out phrasings (kept in sync with isGrokAuthError in
  // handlers/auth-error-hint.ts). Same provider-gating rationale as cursor:
  // "not logged in" / "grok login" / "auth.json" carry no generic auth token
  // the shared classifier already covers, so they need a grok-only branch.
  if (provider === "grok" && /not logged in|grok login|auth\.json/.test(text)) return true;
  // Antigravity headless auth failures are provider-owned and may mention a
  // credential without using the generic "authentication required" wording.
  if (
    provider === "antigravity" &&
    /gemini_api_key|credential|sign in|token (?:is )?(?:missing|expired)|invalid token/.test(text)
  ) {
    return true;
  }
  // Pi CLI logged-out / missing-key phrasings (kept in sync with isPiAuthError).
  return (
    provider === "pi" &&
    /missing credentials|no api key|\/login|auth[_ ]required|not authenticated|pi_auth_required/.test(text)
  );
}

function credentialReason(base: Classification): string {
  return base.reasonCode === "unknown" ? "provider_credential_required" : base.reasonCode;
}

function isCapability(text: string, base: Classification): boolean {
  return (
    base.reasonCode.includes("binary_missing") ||
    base.reasonCode.includes("binary_unusable") ||
    /binary missing|binary candidates are installed but unusable|executable missing|unable to locate/.test(text)
  );
}

function isPiProtocolError(name: string | undefined, text: string): boolean {
  const named = (name ?? "").toLowerCase();
  return (
    named.includes("pirpcprotocolerror") ||
    /session identity mismatch|pi_session_mismatch|pi_protocol_error/.test(text) ||
    /get_state response missing|pi get_state failed|get_state failed/.test(text)
  );
}

function isPiModelConfiguration(text: string): boolean {
  return /model selector is invalid|model mismatch|thinkinglevel mismatch|pi_model_mismatch|pi_model_configuration/.test(
    text,
  );
}

function isPiMcpConfiguration(text: string): boolean {
  return /managed mcp servers are not supported|mcp servers are not supported|pi_mcp_unsupported/.test(text);
}

function isConfiguration(text: string, base: Classification, provider: RuntimeProvider): boolean {
  if (
    base.reasonCode.includes("mismatch") ||
    /provider mismatch|runtime_provider_mismatch|bad config|sandbox|approval|model_not_found|model not found/.test(text)
  ) {
    return true;
  }
  if (provider === "codex" && isCodexServiceTierConfiguration(text)) return true;
  if (provider === "kimi-code" && /model\.not_configured|model\.config_invalid/.test(text)) return true;
  // Pi model/MCP configuration gates — keep provider-gated so shared English
  // phrases cannot terminalize another provider's retryable failures.
  if (provider === "amp" && /amp_mode_invalid|amp mode must be one of/.test(text)) return true;
  if (provider === "deepseek-harness" && /deepseek_mcp_unsupported|managed mcp servers are not supported/.test(text)) {
    return true;
  }
  if (provider === "pi" && (isPiModelConfiguration(text) || isPiMcpConfiguration(text))) return true;
  if (
    provider === "antigravity" &&
    /expected one conversation id|resume conversation mismatch|terminal result event|malformed antigravity stream|antigravity returned an error result/.test(
      text,
    )
  ) {
    return true;
  }
  // Cursor CLI literal invalid-model / explicit-deny / trust-wall phrasings
  // (captured in Phase 0). Gated to the cursor provider: this classifier is
  // shared and configuration wins over capacity in the classify chain, so an
  // ungated generic English phrase like "cannot use this model" could turn
  // another provider's retryable capacity message into a terminal stop.
  return (
    provider === "cursor" && /cannot use this model|blocked by permissions configuration|workspace trust/.test(text)
  );
}

function configurationReason(text: string, base: Classification, provider: RuntimeProvider): string {
  if (provider === "codex" && isCodexServiceTierConfiguration(text)) return "codex_service_tier_unsupported";
  if (provider === "pi" && isPiModelConfiguration(text)) return "pi_model_configuration_error";
  if (provider === "pi" && isPiMcpConfiguration(text)) return "pi_mcp_unsupported";
  if (
    provider === "antigravity" &&
    /expected one conversation id|resume conversation mismatch|terminal result event|malformed antigravity stream|antigravity returned an error result/.test(
      text,
    )
  ) {
    return "antigravity_protocol_error";
  }
  return base.reasonCode === "unknown" ? "provider_configuration_error" : base.reasonCode;
}

function isCodexServiceTierConfiguration(text: string): boolean {
  return (
    /configured service tier .* is not advertised as supported .* will be omitted from requests/.test(text) ||
    /configured service tier .* was not activated by codex .* will not be used for requests/.test(text)
  );
}

function isDeterministicInput(text: string, base: Classification): boolean {
  return (
    base.reasonCode.includes("context") ||
    /context length|context_length|context window|invalid request|invalid_request|bad request|max_output_tokens|error_max_turns|exceeded max turns|error_max_budget_usd|error_max_structured_output_retries/.test(
      text,
    ) ||
    (text.includes("ran out of room") && text.includes("context"))
  );
}

function deterministicReason(base: Classification): string {
  return base.reasonCode === "unknown" ? "provider_deterministic_input" : base.reasonCode;
}

/**
 * Providers whose raw error stream surfaces HTTP-429 phrasings such as "too
 * many requests" / "resource has been exhausted" after internal retries are
 * exhausted. This single provider-scoped predicate drives both the shared
 * capacity classifier and provider-side error sanitizers (e.g. Pi's
 * sanitizePiProviderDetail) so one rule selects the same capacity
 * classification everywhere. Keep provider-gated: the words alone are not
 * reserved capacity-speak for unrelated providers.
 */
export function isExhaustedCapacityPhrasing(provider: RuntimeProvider, text: string): boolean {
  return (provider === "grok" || provider === "pi") && /too many requests|resource has been exhausted/.test(text);
}

function isCapacity(
  text: string,
  base: Classification,
  retryAfterMs: number | undefined,
  provider: RuntimeProvider,
): boolean {
  return (
    retryAfterMs !== undefined ||
    base.reasonCode.includes("rate_limit") ||
    /rate.?limit|usage limit|session limit|quota|insufficient_quota|overloaded|capacity/.test(text) ||
    isExhaustedCapacityPhrasing(provider, text)
  );
}

function isTransportText(text: string): boolean {
  return (
    TRANSIENT_HTTP_CODE_RE.test(text) ||
    /server error|server_error|unavailable|timed out|timeout|fetch failed|network|unable to connect|provider\.connection_error|connection refused|connectionrefused|econnreset|econnrefused|etimedout|epipe/.test(
      text,
    )
  );
}

function capacityReason(text: string, base: Classification): string {
  if (/usage limit|session limit|quota|insufficient_quota/.test(text)) return "provider_usage_limit";
  if (/overloaded|capacity/.test(text)) return "provider_overloaded";
  if (
    /rate.?limit|too many requests|resource has been exhausted/.test(text) ||
    base.reasonCode.includes("rate_limit")
  ) {
    return "provider_rate_limited";
  }
  return base.reasonCode === "unknown" ? "provider_capacity" : base.reasonCode;
}

function isBillingLimit(text: string): boolean {
  return (
    /billing_error|insufficient account balance|credit balance is too low|credits_required|out_of_credits/.test(text) ||
    (text.includes("billing") && text.includes("credit"))
  );
}

function transientReason(base: Classification, provider: RuntimeProvider): string {
  if (provider === "codex" && base.reasonCode.startsWith("claude_")) return "provider_transient_transport";
  return base.reasonCode === "unknown" ? "provider_transient_transport" : base.reasonCode;
}
