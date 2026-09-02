/**
 * Provider-facing Runtime support entry for
 * `@first-tree/client/runtime/provider-support`.
 *
 * Provider production code may depend on Runtime-owned capabilities only
 * through this present single-package seam (or
 * `@first-tree/client/runtime/contracts`). It is an explicit allowlist
 * organized by ownership group — not a mechanical barrel of every Runtime
 * helper, and not a separate package.
 *
 * Groups:
 * - preparation — managed start/resume admission + lower-level projection refresh
 * - process-supervision — default provider process lifecycle supervision
 * - failure-policy — attempt/retry/terminal notice/redaction + binary-failure seam
 * - turn-prompt — chat-context prompt rendering + briefing fingerprint helpers
 * - turn-input — streaming input controller + attachment/image prompt helpers
 * - attachment-availability — inbound attachment 404 classification + retention copy
 * - tree-tracking — Context Tree path/git attribution
 * - host-runtime — briefing rewrite, CLI binding, discovery roots, workspace lock
 *
 * Do not `export *` owner modules. Do not re-export session/runtime owners,
 * stores, registries, or concrete provider binary/login/capability
 * implementations.
 */

// attachment-availability
export { ATTACHMENT_UNAVAILABLE_NOTE, isAttachmentGoneError } from "./attachment-availability.js";
export type {
  ProviderAttemptOptions,
  ProviderAttemptSettlement,
  ProviderAttemptSignal,
  ProviderBinaryFailureReasonCode,
  ProviderBinaryFailureSignal,
  ProviderFailureClassification,
  ProviderFailureSource,
  ProviderRetryDecision,
} from "./failure-policy.js";
// failure-policy
export {
  buildProviderRetryEvent,
  classifyProviderFailure,
  decideProviderRetry,
  formatProviderFailureRuntimeNotice,
  isAntigravityBinaryMissingError,
  isCodexBinaryMissingError,
  isCursorBinaryMissingError,
  isEgressForbiddenText,
  isExhaustedCapacityPhrasing,
  isGrokBinaryMissingError,
  isHardFailureCategory,
  isPiBinaryMissingError,
  maxProviderTurnRetryAttempts,
  PROVIDER_BINARY_FAILURE_REASON_CODES,
  ProviderAttempt,
  piProviderDetailBinaryMissingReasonCode,
  recognizeProviderBinaryFailure,
  redactErrorPreview,
} from "./failure-policy.js";
export type {
  AcquireWorkspaceFileLockOptions,
  ActiveVersionManager,
  AgentConfigCache,
  PredeclaredSourceRepo,
  ReadDirNames,
  ReadLink,
  RunShell,
  VersionManagerDirDeps,
  WorkspaceFileLock,
} from "./host-runtime.js";
// host-runtime
export {
  acquireWorkspaceFileLock,
  automaticCandidateAllowed,
  buildProbeScript,
  codexDesktopAppBinDirs,
  FIRST_TREE_WORKSPACE_MARKER,
  getCliBinding,
  getLoginShellPathDirs,
  protectedRootsOnThisHost,
  resetLoginShellPathDirsCache,
  resolveGitRepoTargetPath,
  resolveOutsideProtectedRoots,
  resolveOutsideProtectedRootsOnThisHost,
  versionManagerBinDirs,
  WorkspaceFileLockTimeoutError,
  wellKnownBinDirs,
  writeAgentBriefing,
} from "./host-runtime.js";
export type {
  AgentBootstrapParams,
  BuildAgentBriefingOptions,
  ChatContext,
  ContextTreeCoordinates,
  PreparedManagedSession,
  PrepareManagedSessionParams,
  ProjectedManagedWorkspace,
  ProjectManagedWorkspaceParams,
  ReconciledTeamSkill,
  ReconcileManagedSkillsResult,
} from "./preparation.js";
// preparation
export {
  acquireAgentHome,
  assertContextSourceCurrent,
  buildAgentBriefing,
  ContextSourceTransitionError,
  currentSourceRepoNamesFromPayload,
  declaredSourceRepos,
  ensureAgentBootstrap,
  fetchChatContext,
  fetchChatContextOrLog,
  isContextSourceTransitionError,
  isManagedSkillsUnsafeDiscoveryError,
  markWorkspaceInitComplete,
  prepareManagedSession,
  projectManagedWorkspace,
  reconcileManagedSkills,
  reconcileManagedSkillsForConfig,
  teamSkillBundleResolverFromSdk,
} from "./preparation.js";
export type {
  ProviderProcessSpec,
  ProviderProcessSupervisor,
  SupervisedProviderProcess,
} from "./process-supervision.js";
// process-supervision
export {
  createDefaultProviderProcessSupervisor,
  ProviderProcessSupervisionUnsupportedError,
  supportsDefaultProviderProcessSupervision,
} from "./process-supervision.js";
export type { ContextTreeAttribution, ContextTreeGitWriteTracker, ShellCommandFileRefsInput } from "./tree-tracking.js";
// tree-tracking
export {
  canonicalizeFsPath,
  contextSourceFromHandlerConfig,
  contextTreeRelativePathOf,
  createContextTreeGitWriteTracker,
  preparationCoordinatesFromSource,
  remoteGitAttributionFromSource,
  resolveContextTreeRelativePath,
  toolFileRefsFromShellCommand,
  withContextTreeRepoHeadCommit,
} from "./tree-tracking.js";
// turn-input
export {
  findImagePath,
  InputController,
  imagePath,
  renderDocumentAttachmentsForLLM,
  renderImageAttachmentsForLLM,
  writeImage,
} from "./turn-input.js";
// turn-prompt
export {
  buildBriefingUpdateNotice,
  computeBriefingFingerprint,
  readSessionBriefingFingerprint,
  renderChatContextPrompt,
  renderChatContextSection,
  renderRuntimeOutputContract,
  writeSessionBriefingFingerprint,
} from "./turn-prompt.js";
