/**
 * Provider-support failure-policy group.
 *
 * Runtime owns attempt settlement, retry classification, terminal notice copy,
 * error redaction, and the binary-failure recognition seam. Concrete provider
 * binary modules remain transitional provider-owned code and are not re-exported
 * here — only the normalized binary-failure seam is.
 */

export type {
  ProviderAttemptOptions,
  ProviderAttemptSettlement,
  ProviderAttemptSignal,
} from "../provider-attempt.js";
export { isHardFailureCategory, ProviderAttempt } from "../provider-attempt.js";

export type {
  ProviderFailureClassification,
  ProviderFailureSource,
  ProviderRetryDecision,
} from "../provider-retry-policy.js";
export {
  buildProviderRetryEvent,
  classifyProviderFailure,
  decideProviderRetry,
  isExhaustedCapacityPhrasing,
  maxProviderTurnRetryAttempts,
} from "../provider-retry-policy.js";

export { redactErrorPreview } from "../redact-error-preview.js";

export { formatProviderFailureRuntimeNotice, isEgressForbiddenText } from "../runtime-notice.js";
export type { ProviderBinaryFailureReasonCode, ProviderBinaryFailureSignal } from "./binary-failure.js";
export {
  isAntigravityBinaryMissingError,
  isCodexBinaryMissingError,
  isCursorBinaryMissingError,
  isGrokBinaryMissingError,
  isPiBinaryMissingError,
  PROVIDER_BINARY_FAILURE_REASON_CODES,
  piProviderDetailBinaryMissingReasonCode,
  recognizeProviderBinaryFailure,
} from "./binary-failure.js";
