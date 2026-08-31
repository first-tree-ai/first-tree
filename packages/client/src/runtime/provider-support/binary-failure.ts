/**
 * Provider-support binary failure seam.
 *
 * Owns the recognition rules and stable machine reason codes for provider
 * binary missing / verify-transient failures. Generic runtime code (notably
 * error-taxonomy) consumes the normalized signal only — it must not import
 * concrete provider binary modules. Provider binary modules may re-export the
 * `is*BinaryMissingError` helpers so existing call sites keep a single owner
 * for the match rules (no duplicated regex / string tables).
 */

export const PROVIDER_BINARY_FAILURE_REASON_CODES = {
  CODEX_VERIFY_TRANSIENT: "codex_verify_transient",
  CODEX_BINARY_UNUSABLE: "codex_binary_unusable",
  CODEX_BINARY_MISSING: "codex_binary_missing",
  CURSOR_VERIFY_TRANSIENT: "cursor_verify_transient",
  CURSOR_BINARY_MISSING: "cursor_binary_missing",
  GROK_VERIFY_TRANSIENT: "grok_verify_transient",
  GROK_BINARY_MISSING: "grok_binary_missing",
  ANTIGRAVITY_BINARY_MISSING: "antigravity_binary_missing",
  PI_VERIFY_TRANSIENT: "pi_verify_transient",
  PI_BINARY_MISSING: "pi_binary_missing",
} as const;

export type ProviderBinaryFailureReasonCode =
  (typeof PROVIDER_BINARY_FAILURE_REASON_CODES)[keyof typeof PROVIDER_BINARY_FAILURE_REASON_CODES];

export type ProviderBinaryFailureSignal = {
  /** Present-but-flaky, present-but-unusable, or genuinely missing/unresolved. */
  outcome: "verify_transient" | "binary_unusable" | "binary_missing";
  reasonCode: ProviderBinaryFailureReasonCode;
  /** Fallback human summary when the thrown value carries no message. */
  defaultMessage: string;
};

const VERIFY_TRANSIENT_BY_NAME = {
  CodexBinaryVerifyTransientError: {
    reasonCode: PROVIDER_BINARY_FAILURE_REASON_CODES.CODEX_VERIFY_TRANSIENT,
    defaultMessage: "codex --version smoke check did not complete (transient)",
  },
  CursorBinaryVerifyTransientError: {
    reasonCode: PROVIDER_BINARY_FAILURE_REASON_CODES.CURSOR_VERIFY_TRANSIENT,
    defaultMessage: "cursor-agent --version smoke check did not complete (transient)",
  },
  GrokBinaryVerifyTransientError: {
    reasonCode: PROVIDER_BINARY_FAILURE_REASON_CODES.GROK_VERIFY_TRANSIENT,
    defaultMessage: "grok --version smoke check did not complete (transient)",
  },
  PiBinaryVerifyTransientError: {
    reasonCode: PROVIDER_BINARY_FAILURE_REASON_CODES.PI_VERIFY_TRANSIENT,
    defaultMessage: "pi --version smoke check did not complete (transient)",
  },
} as const satisfies Record<string, { reasonCode: ProviderBinaryFailureReasonCode; defaultMessage: string }>;

const CODEX_BINARY_MISSING_PATTERNS: readonly RegExp[] = [
  /codex runtime binary is missing/i,
  /unable to locate codex cli binaries/i,
  /findCodexPath/,
  /missing optional dependency\s+@openai\/codex[-\w]*/i,
];

const CURSOR_BINARY_MISSING_PATTERNS: readonly RegExp[] = [
  /cursor agent cli is missing/i,
  /cursor-agent.*not (?:found|installed)/i,
];

const GROK_BINARY_MISSING_PATTERNS: readonly RegExp[] = [
  /grok build cli is missing/i,
  /grok.*not (?:found|installed)/i,
];

const ANTIGRAVITY_BINARY_MISSING_PATTERNS: readonly RegExp[] = [
  /antigravity cli is missing/i,
  /agy.*not (?:found|installed)/i,
  /no agy binary/i,
];

function errorText(input: unknown): string {
  if (input instanceof Error) return input.message;
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const maybe = input as { message?: unknown };
    if (typeof maybe.message === "string") return maybe.message;
  }
  return String(input);
}

/** Codex: message + stack so stack-only `findCodexPath` frames still match. */
function codexErrorSearchText(input: unknown): string {
  if (input instanceof Error) return [input.message, input.stack].filter(Boolean).join("\n");
  return errorText(input);
}

/** Cursor / Grok: name + message (no stack). */
function namedErrorSearchText(input: unknown): string {
  if (input instanceof Error) return `${input.name} ${input.message}`;
  return errorText(input);
}

/** Pi: name + message, then linear substring scan (no catastrophic regex). */
function piErrorText(input: unknown): string {
  if (input instanceof Error) return `${input.name} ${input.message}`;
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "message" in input) {
    const message = (input as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(input);
}

export function isCodexBinaryMissingError(input: unknown): boolean {
  const text = codexErrorSearchText(input);
  return CODEX_BINARY_MISSING_PATTERNS.some((pattern) => pattern.test(text));
}

export function isCursorBinaryMissingError(input: unknown): boolean {
  const text = namedErrorSearchText(input);
  return CURSOR_BINARY_MISSING_PATTERNS.some((pattern) => pattern.test(text));
}

export function isGrokBinaryMissingError(input: unknown): boolean {
  const text = namedErrorSearchText(input);
  return GROK_BINARY_MISSING_PATTERNS.some((pattern) => pattern.test(text));
}

export function isAntigravityBinaryMissingError(input: unknown): boolean {
  const text = namedErrorSearchText(input);
  return ANTIGRAVITY_BINARY_MISSING_PATTERNS.some((pattern) => pattern.test(text));
}

export function isPiBinaryMissingError(input: unknown): boolean {
  const text = piErrorText(input).toLowerCase();
  if (text.includes("pi cli is missing")) return true;
  // Production resolution errors use this phrase before formatting the
  // user-facing "Pi CLI is missing…" copy (e.g. "no pi binary resolved").
  if (text.includes("no pi binary")) return true;
  // Linear-time classification: any "pi" followed later by "not found" /
  // "not installed". Avoid `pi.*not ...` regex backtracking on adversarial
  // strings that repeat "pi" many times without a terminal phrase.
  const piIdx = text.indexOf("pi");
  if (piIdx < 0) return false;
  const afterPi = text.slice(piIdx + 2);
  return afterPi.includes("not found") || afterPi.includes("not installed");
}

/**
 * Pi-provider-detail context only. Callers must already have scoped `detail`
 * to Pi provider diagnostics (e.g. {@link sanitizePiProviderDetail}).
 *
 * Composes {@link isPiBinaryMissingError} for the shared Pi-specific phrases,
 * then adds only the historical sanitizer extras that are safe once the
 * subject is known to be Pi: bare `not found` / `not installed`. Generic
 * taxonomy must keep using {@link isPiBinaryMissingError} so unscoped text
 * cannot inherit that breadth.
 */
export function piProviderDetailBinaryMissingReasonCode(
  detail: string,
): (typeof PROVIDER_BINARY_FAILURE_REASON_CODES)["PI_BINARY_MISSING"] | null {
  if (isPiBinaryMissingError(detail)) {
    return PROVIDER_BINARY_FAILURE_REASON_CODES.PI_BINARY_MISSING;
  }
  const lower = detail.trim().toLowerCase();
  if (!lower) return null;
  // Pi-scoped sanitizer extras only — do not duplicate the strict matcher phrases.
  if (lower.includes("not found") || lower.includes("not installed")) {
    return PROVIDER_BINARY_FAILURE_REASON_CODES.PI_BINARY_MISSING;
  }
  return null;
}

function readErrorName(err: unknown): string | undefined {
  if (err instanceof Error) return err.name;
  if (err && typeof err === "object") {
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return undefined;
}

function verifyTransientSignal(
  err: unknown,
  errorName: keyof typeof VERIFY_TRANSIENT_BY_NAME,
): ProviderBinaryFailureSignal | null {
  if (readErrorName(err) !== errorName) return null;
  const entry = VERIFY_TRANSIENT_BY_NAME[errorName];
  return {
    outcome: "verify_transient",
    reasonCode: entry.reasonCode,
    defaultMessage: entry.defaultMessage,
  };
}

function codexUnusableSignal(err: unknown): ProviderBinaryFailureSignal | null {
  if (
    readErrorName(err) !== "CodexBinaryUnusableError" &&
    !/codex runtime binary candidates are installed but unusable/i.test(codexErrorSearchText(err))
  ) {
    return null;
  }
  return {
    outcome: "binary_unusable",
    reasonCode: PROVIDER_BINARY_FAILURE_REASON_CODES.CODEX_BINARY_UNUSABLE,
    defaultMessage: "Codex runtime binary candidates are unusable",
  };
}

function missingSignal(
  match: (input: unknown) => boolean,
  reasonCode: ProviderBinaryFailureReasonCode,
  defaultMessage: string,
  err: unknown,
): ProviderBinaryFailureSignal | null {
  if (!match(err)) return null;
  return { outcome: "binary_missing", reasonCode, defaultMessage };
}

/**
 * Normalize a thrown value into a binary-failure signal, or `null` when the
 * error is unrelated.
 *
 * Order keeps the historical `error-taxonomy` classifier, with Codex's narrow
 * unusable outcome inserted after verify-transient and before missing — then
 * walks Cursor → Grok → Pi as verify-transient then missing. "Verify beats
 * missing" is only within the same provider;
 * a later provider's verify name must not preempt an earlier provider's missing
 * match (cross-provider ambiguity keeps the earlier provider's outcome).
 */
function recognizeDirectProviderBinaryFailure(err: unknown): ProviderBinaryFailureSignal | null {
  return (
    verifyTransientSignal(err, "CodexBinaryVerifyTransientError") ??
    codexUnusableSignal(err) ??
    missingSignal(
      isCodexBinaryMissingError,
      PROVIDER_BINARY_FAILURE_REASON_CODES.CODEX_BINARY_MISSING,
      "Codex runtime binary missing",
      err,
    ) ??
    verifyTransientSignal(err, "CursorBinaryVerifyTransientError") ??
    missingSignal(
      isCursorBinaryMissingError,
      PROVIDER_BINARY_FAILURE_REASON_CODES.CURSOR_BINARY_MISSING,
      "Cursor Agent CLI binary missing",
      err,
    ) ??
    verifyTransientSignal(err, "GrokBinaryVerifyTransientError") ??
    missingSignal(
      isGrokBinaryMissingError,
      PROVIDER_BINARY_FAILURE_REASON_CODES.GROK_BINARY_MISSING,
      "Grok Build CLI binary missing",
      err,
    ) ??
    missingSignal(
      isAntigravityBinaryMissingError,
      PROVIDER_BINARY_FAILURE_REASON_CODES.ANTIGRAVITY_BINARY_MISSING,
      "Antigravity CLI binary missing",
      err,
    ) ??
    verifyTransientSignal(err, "PiBinaryVerifyTransientError") ??
    missingSignal(
      isPiBinaryMissingError,
      PROVIDER_BINARY_FAILURE_REASON_CODES.PI_BINARY_MISSING,
      "Pi CLI binary missing",
      err,
    )
  );
}

function readErrorCause(err: unknown): unknown {
  if (!err || typeof err !== "object") return undefined;
  return (err as { cause?: unknown }).cause;
}

export function recognizeProviderBinaryFailure(err: unknown): ProviderBinaryFailureSignal | null {
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; current !== undefined && current !== null && depth < 8; depth += 1) {
    if ((typeof current === "object" || typeof current === "function") && seen.has(current)) return null;
    if (typeof current === "object" || typeof current === "function") seen.add(current);
    const direct = recognizeDirectProviderBinaryFailure(current);
    if (direct) return direct;
    current = readErrorCause(current);
  }
  return null;
}
