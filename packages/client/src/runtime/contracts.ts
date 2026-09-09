/**
 * Provider-facing contracts entry for `@first-tree/client/runtime/contracts`.
 *
 * Explicit allowlist of stable symbols that provider production code may
 * depend on through the present single-package runtime seam — not a separate
 * package and not a catch-all Runtime barrel.
 *
 * Values re-export the owner module bindings so identity is preserved
 * (`noopDeliveryToken` / `requireDeliveryToken` stay single-owner).
 * Do not add helpers, stores, managers, registries, or implementation classes.
 */

export type {
  AgentHandler,
  AgentIdentity,
  DeliveryToken,
  HandlerConfig,
  HandlerFactory,
  HandlerResumeOptions,
  HandlerShutdownOptions,
  ProviderContinuation,
  SessionContext,
  SessionMessage,
  TurnConsumedErrorReason,
  TurnOutcome,
} from "./handler.js";
export { noopDeliveryToken, requireDeliveryToken } from "./handler.js";
export type { ReplayFenceEntry, ReplayFenceWriter } from "./replay-fence.js";
export type { LoginOutcome } from "./runtime-login.js";
// Provider↔format-boundary contract: a pre-provider refusal for an
// unproven Team Skill command identity is retry-safe (the provider never
// saw the input), distinct from a mid-turn failure. Providers classify it
// through this typeguard only; the rewrite machinery itself stays
// runtime-internal.
export { isTeamSkillCommandUnavailableError } from "./team-skill-command-rewrite.js";
