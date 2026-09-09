export {
  applyClientLoggerConfig,
  captureClientException,
  configureClientLoggerForService,
  createLogger,
  flushClientSentry,
  initClientSentry,
  rootLogger,
} from "./cloud/observability/index.js";
export type {
  AccessTokenProvider,
  AgentContextTreeConfig,
  ContextReviewRuntimeConfig,
  ContextTreeConfig,
  MemberProfile,
  PaginatedResult,
  RegisterResult,
  SdkConfig,
} from "./cloud/sdk.js";
export { FirstTreeHubSDK, FirstTreeHubSDK as FirstTreeSDK, SdkError } from "./cloud/sdk.js";
export {
  ANTIGRAVITY_LOGIN_COMMAND,
  buildAntigravityTurnArgs,
  findAntigravityExecutableOnPath,
  formatAntigravityBinaryMissingMessage,
  isAntigravityBinaryMissingError,
  resolveAntigravityRuntimeBinary,
} from "./providers/antigravity/binary.js";
export { probeAntigravityCapability } from "./providers/antigravity/capability.js";
export {
  ANTIGRAVITY_PENDING_SESSION_PREFIX,
  clearAntigravityAttemptCacheForTests,
  createAntigravityHandler,
  isAntigravityPendingSessionId,
} from "./providers/antigravity/index.js";
export {
  buildAntigravityMcpConfigContent,
  mapAntigravityMcpServers,
  mergeAntigravityMcpConfig,
  projectAntigravityMcpConfig,
} from "./providers/antigravity/mcp-config.js";
export {
  AntigravityStreamParser,
  parseAntigravityStreamLine,
} from "./providers/antigravity/parser.js";
export type {
  RuntimeAuthDriver,
  RuntimeAuthLoginResolution,
  RuntimeAuthLoginStart,
  RuntimeAuthProbeResult,
} from "./providers/auth-driver.js";
export type { RuntimeAuthDriverTable } from "./providers/auth-drivers.js";
export { RUNTIME_AUTH_DRIVERS } from "./providers/auth-drivers.js";
export type { BuiltinProviderProbeTable, CapabilityProbe } from "./providers/builtin-probes.js";
export { BUILTIN_PROVIDER_PROBES, probedRuntimeProviders } from "./providers/builtin-probes.js";
export type {
  BuiltinHandlerRegistry,
  BuiltinHandlerRegistryDeps,
  BuiltinRegistryLog,
} from "./providers/builtin-registry.js";
export {
  createBuiltinHandlerRegistry,
  resolveAndLogClaudeExecutable,
} from "./providers/builtin-registry.js";
export {
  CAPABILITY_REFRESH_BASE_MS,
  CAPABILITY_REFRESH_MAX_MS,
  hasNonOkProvider,
  LARK_CLI_CAPABILITY_KEY,
  nextCapabilityRefreshDelayMs,
  PROBED_RUNTIME_PROVIDERS,
  probeCapabilities,
  REPROBE_MAX_AGE_MS,
  reprobeOnReconnect,
  revalidateCapabilities,
  shouldFullReprobe,
} from "./providers/capabilities/index.js";
// Capabilities
export { probeClaudeCodeCapability } from "./providers/claude/capability.js";
export { probeClaudeCodeTuiCapability } from "./providers/claude/capability-tui.js";
// Handlers
export { detectStreamApiError, StreamApiTransientError } from "./providers/claude/index.js";
export {
  type ClaudeAuthDriverDeps,
  type ClaudeBrowserLoginOptions,
  type ClaudeLoginInvocation,
  createClaudeAuthDriver,
  resolveClaudeLoginInvocation,
  runClaudeBrowserLogin,
} from "./providers/claude/login.js";
export { onCodexVerifiedAutomaticCandidateChange } from "./providers/codex/binary.js";
export {
  type CodexBinaryResolution,
  probeCodexCapability,
  resolveCodexRuntimeBinary,
} from "./providers/codex/capability.js";
export {
  type CodexAuthDriverDeps,
  type CodexBrowserLoginOptions,
  createCodexAuthDriver,
  runCodexBrowserLogin,
} from "./providers/codex/login.js";
export {
  CURSOR_INSTALL_COMMAND,
  type CursorRuntimeBinaryResolution,
  findCursorExecutableOnPath,
  formatCursorBinaryMissingMessage,
  resolveCursorRuntimeBinary,
} from "./providers/cursor/binary.js";
export { probeCursorCapability } from "./providers/cursor/capability.js";
export {
  type CursorAuthDriverDeps,
  type CursorBrowserLoginOptions,
  createCursorAuthDriver,
  runCursorBrowserLogin,
} from "./providers/cursor/login.js";
export {
  type DiscoverModelsDeps,
  discoverProviderModels,
  parseCursorModelsOutput,
  parseKimiConfigModels,
} from "./providers/discover-models.js";
export {
  findGrokExecutableOnPath,
  formatGrokBinaryMissingMessage,
  GROK_INSTALL_COMMAND,
  type GrokRuntimeBinaryResolution,
  resolveGrokRuntimeBinary,
} from "./providers/grok/binary.js";
export { probeGrokCapability } from "./providers/grok/capability.js";
export {
  createGrokAuthDriver,
  type GrokAuthDriverDeps,
  type GrokBrowserLoginOptions,
  runGrokBrowserLogin,
} from "./providers/grok/login.js";
export { createKimiCodeHandler, formatKimiCodeError, kimiToolIsReadOnly } from "./providers/kimi-code/index.js";
export {
  findOpenCodeExecutableOnPath,
  formatOpenCodeBinaryMissingMessage,
  isSupportedOpenCodeVersion,
  OPENCODE_INSTALL_COMMAND,
  OPENCODE_LOGIN_COMMAND,
  OPENCODE_MINIMUM_VERSION,
  OPENCODE_SUPPORTED_VERSION_RANGE,
  parseOpenCodeVersionOutput,
  resolveOpenCodeRuntimeBinary,
} from "./providers/opencode/binary.js";
export { probeOpenCodeCapability } from "./providers/opencode/capability.js";
export {
  buildOpenCodeConfigContent,
  buildOpenCodeTurnArgs,
  createOpenCodeHandler,
  mapOpenCodeMcpServers,
} from "./providers/opencode/index.js";
export {
  findPiExecutableOnPath,
  formatPiBinaryMissingMessage,
  isSupportedPiVersion,
  PI_INSTALL_COMMAND,
  PI_LOGIN_COMMAND,
  PI_MINIMUM_VERSION,
  PI_SUPPORTED_VERSION_RANGE,
  parsePiVersionOutput,
  resolvePiRuntimeBinary,
} from "./providers/pi/binary.js";
export { probePiCapability } from "./providers/pi/capability.js";
// Runtime-auth (browser OAuth)
export {
  AUTH_URL_TOKEN_MAX,
  type AuthUrlScanner,
  BROWSER_LOGIN_TIMEOUT_MS,
  createAuthUrlScanner,
  extractAuthUrl,
  LOGIN_STDERR_TAIL_MAX,
  type LoginOutcome,
  stripAnsi,
} from "./providers/runtime-login.js";
export { PROVIDER_SKILL_ROOTS } from "./providers/skill-roots.js";
export { readCanonicalContextTreeWriteRouting } from "./runtime/agent-briefing.js";
// Runtime
export type { AgentSlotConfig } from "./runtime/agent-slot.js";
export { AgentSlot } from "./runtime/agent-slot.js";
export type { ContextTreeBinding } from "./runtime/bootstrap.js";
export {
  ensureWorkspaceRuntimeDir,
  migrateLegacyRuntimeLayout,
  resolveAgentContextTreeBinding,
} from "./runtime/bootstrap.js";
export type {
  AdoptOptions,
  ChildCategory,
  ChildProcessRegistry,
  CleanupPolicy,
  RegisteredChild,
  RegistrySpawnOptions,
} from "./runtime/child-process-registry.js";
export { CHILD_CATEGORIES, getChildProcessRegistry } from "./runtime/child-process-registry.js";
export type { CliBinding } from "./runtime/cli-binding.js";
export { getCliBinding, setCliBinding } from "./runtime/cli-binding.js";
export type {
  BoundAgent,
  ClientConnectionConfig,
  ProviderModelsListCommand,
  RuntimeAuthCommand,
  ServerWelcome,
  SessionCommand,
} from "./runtime/client-connection.js";
export {
  ClientConnection,
  ClientOrgMismatchError,
  ClientRetiredError,
  ClientUserMismatchError,
} from "./runtime/client-connection.js";
export type { AgentSlotYamlConfig, RuntimeConfig, SessionConfig } from "./runtime/config.js";
export { loadRuntimeConfig } from "./runtime/config.js";
export { recordRemoteBindingObservation } from "./runtime/context-source.js";
export { Deduplicator } from "./runtime/deduplicator.js";
export type { AttachmentUploader, SelfFence, WorkspaceFence } from "./runtime/doc-snapshots.js";
export { buildMessageDocumentSnapshots } from "./runtime/doc-snapshots.js";
export type { Classification, ErrorKind, ErrorSource, RetryStrategy } from "./runtime/error-taxonomy.js";
export { clampRetryAttempt, classify, ERROR_KINDS, nextRetryDelayMs } from "./runtime/error-taxonomy.js";
export type {
  AgentHandler,
  HandlerConfig,
  HandlerContext,
  HandlerFactory,
  HandlerFactoryMap,
  SessionContext,
  SessionMessage,
} from "./runtime/handler.js";
export type { BuildImageAttachmentsOptions, BuildMessageImageSnapshotsResult } from "./runtime/image-snapshots.js";
export { buildMessageImageSnapshots } from "./runtime/image-snapshots.js";
export { InputController } from "./runtime/input-controller.js";
export {
  createDefaultProviderProcessSupervisor,
  type ProviderProcessSpec,
  ProviderProcessSupervisionUnsupportedError,
  type ProviderProcessSupervisor,
  type SupervisedProviderProcess,
} from "./runtime/provider-process-supervisor.js";
export { redactErrorPreview } from "./runtime/redact-error-preview.js";
export type { AgentRuntimeOptions } from "./runtime/runtime.js";
export { AgentRuntime } from "./runtime/runtime.js";
// Skills (slash-command discovery)
export { discoverClaudeCodeSkills } from "./runtime/skills/index.js";
export type {
  ExecuteUpdateFn,
  ExecuteUpdateResult,
  QuietGateSnapshot,
  RefreshUpdateTargetFn,
  RefreshUpdateTargetResult,
  UpdateHooks,
  UpdateLogger,
  UpdateLogLevel,
  UpdateManagerOptions,
  UpdatePromptFn,
} from "./runtime/update-manager.js";
export { UpdateManager } from "./runtime/update-manager.js";
export {
  acquireAgentHome,
  acquireWorkspace,
  cleanWorkspaces,
  clearWorkspaceInitComplete,
  DEFAULT_WORKSPACE_TTL_MS,
  INIT_COMPLETE_SENTINEL_REL,
  markWorkspaceInitComplete,
} from "./runtime/workspace.js";
export type {
  CleanAgentWorkspacesOptions,
  CleanAgentWorkspacesResult,
  CleanedWorkspaceEntry,
} from "./runtime/workspace-maintenance.js";
export { cleanAgentWorkspaces } from "./runtime/workspace-maintenance.js";
