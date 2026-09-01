import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  AgentRuntimeConfigPayload,
  GitRepo,
  InboxEntryWithMessage,
  ProviderRetryEventPayload,
  RuntimeProvider,
  RuntimeState,
  SessionEvent,
  SessionState,
} from "@first-tree/shared";
import {
  attachmentRefsFromMetadata,
  deriveRepoLocalPath,
  encodeProviderRetryEventMessage,
  hasTeamSkillInvocationMarker,
  imageAttachmentRefsFromMetadata,
  isImageBatchRefContent,
  isImageRefContent,
  MAX_MESSAGE_ATTACHMENT_REFS,
  parseProviderRetryEventMessage,
  readFeishuMessageMetadata,
  runtimeProviderSchema,
  SOURCE_REPOS_DIRNAME,
  teamSkillInvocationFromMetadata,
} from "@first-tree/shared";
import type { pino } from "../cloud/observability/logger.js";
import type { FirstTreeHubSDK } from "../cloud/sdk.js";
import type { AgentConfigCache } from "./agent-config-cache.js";
import {
  buildAgentEnv,
  buildFromHeader,
  createParticipantCache,
  formatInboundContent,
  resolveSenderLabel,
} from "./agent-io.js";
import { findAttachmentFile, writeAttachmentFile } from "./attachment-store.js";
import type { ContextTreeBinding } from "./bootstrap.js";
import type { SessionConfig } from "./config.js";
import {
  applyContextSourceToHandlerConfig,
  type ContextSource,
  type ContextSourceAdmissionSnapshot,
  captureContextSourceAdmission,
  contextSourceFromHandlerConfig,
} from "./context-source.js";
import type { SelfFence } from "./doc-snapshots.js";
import { clampRetryAttempt } from "./error-taxonomy.js";
import type {
  AgentHandler,
  AgentIdentity,
  DeliveryCompletionDisposition,
  DeliveryToken,
  HandlerConfig,
  HandlerFactory,
  HandlerRouteReceipt,
  ResumeResult,
  SessionContext,
  SessionMessage,
  StartResult,
  TurnOutcome,
} from "./handler.js";
import { findImagePath, writeImage } from "./image-store.js";
import { type DeliveryRouteOwnership, InboxDeliveryCoordinator } from "./inbox-delivery-coordinator.js";
import { ManagedSkillsUnsafeDiscoveryError } from "./managed-skills.js";
import type { SubprocessProbe } from "./process-tree-probe.js";
import {
  buildProviderRetryEvent,
  classifyProviderFailure,
  decideProviderRetry,
  type ProviderFailureClassification,
} from "./provider-retry-policy.js";
import { isAttachmentGoneError } from "./provider-support/attachment-availability.js";
import { isContextSourceTransitionError } from "./provider-support/preparation.js";
import { redactErrorPreview } from "./redact-error-preview.js";
import { type ResetFenceReleaseVerdict, ResetReplayAuthority } from "./reset-replay-authority.js";
import { createResultSink } from "./result-sink.js";
import {
  HandlerSuspendTimeoutError,
  RouteTeardownAuthority,
  waitForHandlerSuspend,
} from "./route-teardown-authority.js";
import {
  isRuntimeSessionProofFailure,
  postProviderFailureRuntimeNotice,
  shouldPostProviderFailureRuntimeNotice,
} from "./runtime-notice.js";
import { type RuntimeSyncActiveSet, SessionProjectionAuthority } from "./session-projection-authority.js";
import { type SlotDeliveryKind, SlotSchedulerAuthority } from "./slot-scheduler-authority.js";
import {
  buildTeamSkillCommandRegistry,
  isTeamSkillCommandUnavailableError,
  rewriteSessionMessageCommand,
  rewriteSessionMessageCommandForInvocation,
  rewriteSessionMessageCommandToNotice,
  TEAM_SKILL_COMMAND_AMBIGUOUS_RECIPIENT_NOTICE,
  TEAM_SKILL_COMMAND_STALE_VERSION_NOTICE,
  TEAM_SKILL_COMMAND_UNRESOLVED_NOTICE,
  type TeamSkillCommandRegistry,
} from "./team-skill-command-rewrite.js";

type SessionEntry = {
  chatId: string;
  claudeSessionId: string;
  handler: AgentHandler;
  /** Context source captured by the handler factory that owns this entry. */
  handlerSourceKey: string;
  status: SessionState;
  lastActivity: number;
  /** In-flight suspend promise; awaited before resume to avoid race conditions. */
  suspending: Promise<void> | null;
  /**
   * Failure of the last in-flight suspend, recorded because `suspending`
   * swallows rejections by contract. A terminate joining that suspend reads
   * this to fail the Reset apply instead of acking over a handler that was
   * never confirmed suspended. Boxed (`{ error }`) because a Promise can
   * reject with a falsey value — truthiness of the raw error is not a
   * failure signal. Cleared when a new suspend begins.
   */
  suspendError: { error: unknown } | null;
  /**
   * The handler the suspend boundary already shut down successfully
   * (canceled-transition / retired-handler path), bound to the handler
   * IDENTITY rather than a boolean: later flows (e.g.
   * `handlerForRouteTransition`) may replace `entry.handler`, and a stale
   * boolean would then suppress teardown of the live replacement. Only
   * `handlerStoppedBySuspend === entry.handler` means the CURRENT handler is
   * confirmed stopped (`suspendError` records the failure case).
   */
  handlerStoppedBySuspend: AgentHandler | null;
  /**
   * Failure of the last terminate-driven strict teardown (boxed like
   * `suspendError`). Recorded because the slot is already released by then,
   * so without it a retry terminate would skip every teardown branch and
   * ack over a possibly-live handler.
   */
  teardownError: { error: unknown } | null;
  /**
   * Latest terminal, user-actionable provider failure observed on the session
   * event channel. Posting the durable chat notice at the delivery-settlement
   * boundary keeps the policy centralized: handlers classify and emit
   * `provider.retry`, while SessionRuntime decides whether ACK may consume the
   * user's inbox entry. Non-consuming delivery paths clear this cache so a
   * provider failure from one delivery cannot be posted as evidence for a later
   * delivery on the same session.
   */
  pendingRuntimeFailureNotice: ProviderRetryEventPayload | null;
};

type SessionFailureHandling =
  | { kind: "retry" }
  | { kind: "terminal"; reasonCode: string; terminalEventPersisted: boolean };

type RuntimeFailureNoticePostResult =
  | { kind: "posted" }
  | { kind: "failed" }
  | { kind: "runtime_session_proof"; reasonCode: string };

export type SessionRuntimeShutdownOptions = {
  /**
   * Runtime switches are destructive: server-side switch-runtime has already
   * archived/evicted chat sessions, so the retiring local slot must not write
   * old handler resume mappings back to disk.
   */
  clearPersistedRegistry?: boolean;
  /** Ordinary daemon shutdown reports live sessions as suspended; runtime switches skip that. */
  reportSuspendedSessions?: boolean;
};

type SessionCommandType = "session:suspend" | "session:resume" | "session:terminate";

/** Re-exported for agent-slot / wire callers; owned by ResetReplayAuthority. */
export type { ResetFenceReleaseVerdict } from "./reset-replay-authority.js";

/**
 * Resolve the directory the runtime reads markdown doc snapshots against —
 * the same dir the handler actually hands the agent as cwd for this chat.
 *
 * Two layouts coexist after the per-agent-home redesign (#506) and its
 * legacy-resume hotfix (#530):
 *  - NEW chats run cwd = the per-agent home (`<workspaceRoot>` itself, see
 *    `acquireAgentHome`), with predeclared source repos materialised under the
 *    `source-repos/` dir (`<workspaceRoot>/source-repos/<localPath>`). No
 *    `<workspaceRoot>/<chatId>/` dir is ever created.
 *  - LEGACY chats (created before #506) keep their original per-chat cwd
 *    `<workspaceRoot>/<chatId>/`, with their own v1.x layout (source repos at
 *    `<workspaceRoot>/<chatId>/<localPath>`); #530 resumes them in place.
 *
 * The doc base MUST agree with whichever cwd the handler chose, or the
 * snapshot scanner realpaths a non-existent root and embeds ZERO snapshots —
 * so every `.md` mention stays plain text instead of rendering a clickable
 * preview (the symptom this fixes for new chats). We discriminate by the same
 * cheap signal #530's claude-code `resume()` uses first: does the legacy
 * per-chat dir physically exist? Present ⇒ legacy layout; absent ⇒ per-agent
 * home.
 *
 * Pure read-only `existsSync` — no `acquireWorkspace`/`acquireAgentHome`,
 * whose mkdir side effects must not run on every outbound message.
 *
 * IMPORTANT — `existsSync(legacyDir)` is a *proxy* for "the handler chose the
 * legacy cwd". It is exact for new chats (no legacy dir ⇒ agent home, for both
 * handlers) but `SessionRuntime` is handler-agnostic (it only knows
 * `workspaceRoot`, never the handler kind), so two legacy-chat cases diverge —
 * the resolver returns the legacy dir while the handler actually ran at the
 * agent home:
 *   1. CODEX legacy chats. The codex handler has NO legacy-cwd branch:
 *      `start()` and `resume()` both use `acquireAgentHome` (see
 *      `providers/codex/`; #530 left codex alone because its transcripts are
 *      not cwd-keyed). Pre-#506 codex still created `<workspaceRoot>/<chatId>/`,
 *      and those dirs persist (`cleanWorkspaces` is a no-op), so every legacy
 *      codex chat hits this divergence.
 *   2. A claude-code legacy chat whose SDK transcript was lost resumes COLD at
 *      the agent home (#530 case 3) while its `<chatId>/` dir still exists.
 * In both, a freshly-written doc at the agent home may snapshot a STALE copy
 * from the legacy dir, or stay plain text if it exists only at the home.
 *
 * This is NOT a regression: the prior code used `join(workspaceRoot, chatId)`
 * unconditionally, so legacy chats already resolved to the legacy dir — this
 * fix changes only the new-chat (no-legacy-dir) path. The divergence is
 * graceful (older revision, never an empty/wrong file), bounded to legacy chats
 * (which shrink over time), and the clean fix is to thread the handler's
 * resolved cwd through to the sink instead of re-probing here.
 */
export function resolveSessionDocRoot(workspaceRoot: string, chatId: string): string {
  const legacyPerChatRoot = join(workspaceRoot, chatId);
  return existsSync(legacyPerChatRoot) ? legacyPerChatRoot : workspaceRoot;
}

/**
 * Resolve the base path the runtime reads markdown doc snapshots against,
 * given the session doc root from {@link resolveSessionDocRoot}.
 *
 * NEVER returns null — every chat has a workspace, and the snapshot scanner
 * existence-checks each candidate inside the returned root, so a bare mention
 * that doesn't physically exist simply stays plain text rather than
 * mis-resolving. Previously this returned null for zero/multi-repo
 * workspaces, which left those messages with no `documentContext` at all, so
 * a doc the agent wrote in the workspace could never be previewed.
 *
 * Resolution:
 *  - exactly one repo → that source repo's clone, the unambiguous markdown-link
 *    root, as an ABSOLUTE path. Returning a bare relative `localPath` (the old
 *    behaviour) made the runtime resolve it against its own `process.cwd()` —
 *    the launch dir, not the session workspace — so cloud preview was dead.
 *    The `source-repos/` layer applies ONLY to the new agent-home layout
 *    (`sessionRoot === workspaceRoot`): the clone is at
 *    `<workspaceRoot>/source-repos/<localPath>`. A legacy pre-#506 per-chat
 *    session (`sessionRoot` is `<workspaceRoot>/<chatId>`, NOT the agent home)
 *    keeps its prior flat base `<sessionRoot>/<localPath>` — that layout never
 *    had a `source-repos/` layer, so prepending one would point preview at a
 *    directory that does not exist.
 *  - zero or multiple repos → the session doc root.
 */
export function documentBasePathFromRuntimeConfig(
  payload: AgentRuntimeConfigPayload,
  sessionRoot: string,
  workspaceRoot: string,
): string {
  const localPath = singleRepoLocalPathFromPayload(payload);
  if (!localPath) return sessionRoot;
  // New agent-home layout only: source clones live under `source-repos/`.
  return sessionRoot === workspaceRoot
    ? join(sessionRoot, SOURCE_REPOS_DIRNAME, localPath)
    : join(sessionRoot, localPath);
}

/**
 * Extract the lone declared source-repo `localPath` for snapshot self-fence
 * promotion. Returns null when the agent has zero or multiple repos, or when
 * the single repo's localPath is blank — both cases bypass promotion so a
 * relative `docs/foo.md` resolves against the agent home directly.
 *
 * Centralised here (rather than reimplemented in {@link documentBasePathFromRuntimeConfig})
 * so the env-path / sessionRoot / SelfFence all derive from one source.
 */
export function singleRepoLocalPathFromPayload(payload: AgentRuntimeConfigPayload): string | null {
  if (payload.gitRepos.length !== 1) return null;
  const repo = payload.gitRepos[0];
  if (!repo) return null;
  const localPath = repoLocalPath(repo).trim();
  return localPath.length > 0 ? localPath : null;
}

/**
 * Build the {@link SelfFence} the snapshot pipeline gates absolute paths on.
 * `agentHome` is whatever `resolveSessionDocRoot` picked (per-agent home for
 * new chats, legacy per-chat dir for pre-#506 chats); the optional
 * `singleRepoLocalPath` enables relative-path promotion so the abs and rel
 * forms of a source-repo doc share a single snapshot key.
 *
 * Mirrors {@link documentBasePathFromRuntimeConfig} but exposes the agent home
 * itself, not the narrower source-repo top — so on-demand `worktrees/<task>/`
 * checkouts (PR #498's idiom) also resolve.
 */
export function selfFenceFromRuntimeConfig(
  payload: AgentRuntimeConfigPayload | null,
  sessionRoot: string,
  workspaceRoot: string,
): SelfFence {
  if (!payload) return { agentHome: sessionRoot };
  const name = singleRepoLocalPathFromPayload(payload);
  if (!name) return { agentHome: sessionRoot };
  // `singleRepoLocalPath` is the source repo's path RELATIVE to `agentHome`
  // (the snapshot pipeline resolves it as `resolve(agentHome, …)`). The
  // `source-repos/` layer applies ONLY to the new agent-home layout
  // (`sessionRoot === workspaceRoot`); a legacy pre-#506 per-chat session keeps
  // its prior flat relative path `<name>`, matching `documentBasePathFromRuntimeConfig`.
  const singleRepoLocalPath = sessionRoot === workspaceRoot ? `${SOURCE_REPOS_DIRNAME}/${name}` : name;
  return { agentHome: sessionRoot, singleRepoLocalPath };
}

function repoLocalPath(repo: GitRepo): string {
  return repo.localPath ?? deriveRepoLocalPath(repo.url);
}

type SessionRuntimeConfig = {
  session: SessionConfig;
  concurrency: number;
  /**
   * Optional process-tree probe. When present, an idle session whose provider
   * still has a live descendant (e.g. a `run_in_background` watcher) is not
   * idle-suspended and is deprioritized as a concurrency-eviction victim, up to
   * the `idle_timeout + working_grace_seconds` hard cap. Absent => behaviour is
   * exactly as before (no deferral). Wired by `agent-slot` per the
   * `session.defer_suspend_on_subprocess` config flag.
   */
  subprocessProbe?: SubprocessProbe;
  handlerFactory: HandlerFactory;
  handlerConfig: HandlerConfig;
  agentIdentity: AgentIdentity;
  sdk: FirstTreeHubSDK;
  log: pino.Logger;
  registryPath?: string;
  /**
   * Durable replay-fence store path. When set, the manager loads safety
   * facts about provider-entered deliveries that already produced unsafe
   * tool effects, refuses to start/resume a provider turn for a fenced
   * (chatId, messageId) redelivery (leaving it as unacknowledged recovery
   * debt), and hands the store to handlers via `handlerConfig.replayFence`.
   * A store that fails to load fails closed: every dispatch is withheld.
   */
  replayFencePath?: string;
  /** Step 4: optional config cache for refresh-before-dispatch on configVersion bump. */
  agentConfigCache?: AgentConfigCache;
  /** Stable file path updated on every runtime-session rebind for long-lived child CLI calls. */
  runtimeSessionTokenFile?: string;
  /**
   * Ack channel used by `dispatch` when an entry transitions out of `delivered`.
   * Wired to `clientConnection.sendInboxAck` so the entry is acked over the
   * same socket that delivered it.
   */
  ackEntry: (entryId: number) => Promise<void>;
  /**
   * Same-socket chat recovery: reset delivered-but-unacked entries for the
   * chat back to pending and redeliver them on this connection. A resolved
   * `{ unackedOutstanding: 0 }` proves the chat has no pending+delivered
   * notify rows left; omit the field on older servers (unknown, not zero).
   */
  recoverChat?: (chatId: string) => Promise<unknown>;
  /**
   * Read-only settlement probe for concrete fenced deliveries: resolves
   * with the probed message ids the server proves settled (no unsettled
   * notify row), computed inside the server's serialized recovery
   * boundary. Without it the reconciliation keeps every fence.
   */
  probeFencedSettlement?: (chatId: string, messageIds: readonly string[]) => Promise<readonly string[]>;
  /**
   * Re-bind the owning agent after a bind-scoped HTTP proof failure. The
   * callback is agent-wide and must coalesce concurrent chat failures.
   */
  recoverRuntimeSessionProof?: (reasonCode: string) => Promise<void>;
  /** Resolve and authorize the agent's current remote/local/none Context source. */
  resolveContextSource?: () => Promise<ContextSource>;
  /**
   * Resolver for the agent's Context Tree binding, used to lazily upgrade a
   * tree-LESS slot to tree-bound at session start (new-tree onboarding sets the
   * org `context_tree` only after the slot starts). Defaults to a live
   * `resolveAgentContextTreeBinding(sdk, workspaceRoot)` — pure config
   * resolution, no git; injected as a stub in tests to avoid the HTTP probe.
   */
  resolveContextTreeBinding?: () => Promise<ContextTreeBinding | null>;
  /** Callback when a session state changes (per-session granularity). */
  onStateChange?: (chatId: string, state: SessionState) => void;
  /** Callback when aggregated runtime state changes. */
  onRuntimeStateChange?: (state: RuntimeState) => void;
  /** Callback when a session emits a structured event (tool_call / error). */
  onSessionEvent?: (chatId: string, event: SessionEvent) => void;
  /** Confirmed session event channel; resolves only after the server persists the event. */
  confirmSessionEvent?: (chatId: string, event: SessionEvent) => Promise<void>;
  /**
   * Callback when a session's per-(agent,chat) runtime state changes (the
   * D-axis: idle / working / blocked / error). Distinct from
   * `onRuntimeStateChange`, which reports the lossy agent-global aggregate;
   * this carries the chatId so the server can persist the D-axis at
   * per-chat granularity. Also fired on the periodic re-affirm for
   * working / blocked / error sessions so a long turn keeps the
   * server-side freshness stamp current.
   */
  onSessionRuntimeChange?: (chatId: string, state: RuntimeState) => void;
};

/**
 * Manages per-chat session entries with session-oriented handler lifecycle.
 *
 * Key design:
 * - Delayed ACK: messages are ACKed when handler starts processing
 * - Three session states: active / suspended / evicted
 * - Streaming input injection for active sessions
 * - Concurrency limit on simultaneously active sessions
 * - Registry persistence for crash recovery
 */
const MAX_EAGER_IMAGE_FETCHES_PER_DELIVERY = MAX_MESSAGE_ATTACHMENT_REFS;

/**
 * Whether the message's routed metadata explicitly mentions `agentId`.
 * `metadata.mentions` is the server's routing truth — a typed-but-unrouted
 * `@name` look-alike carries no entry and must not unlock the
 * mention-prefixed slash rewrite.
 */
function messageMentionsAgent(message: SessionMessage, agentId: string): boolean {
  const mentions = message.metadata?.mentions;
  return Array.isArray(mentions) && mentions.includes(agentId);
}

/** Structured terminal provider-failure events that feed the durable runtime notice. */
function isTerminalProviderFailureSessionEvent(event: SessionEvent): boolean {
  if (event.kind !== "error") return false;
  const payload = parseProviderRetryEventMessage(event.payload.message);
  if (!payload) return false;
  return shouldPostProviderFailureRuntimeNotice(payload) || isRuntimeSessionProofFailure(payload);
}

function resumableProviderSessionId(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return null;
}

/**
 * Normalize a recorded suspend/teardown failure for the terminate reject
 * boundary. Recorded errors can be falsey (a Promise may reject(null)), and
 * throwing a falsey value would make the rejection uninspectable downstream.
 */
function asTerminateError(kind: "suspend" | "teardown", error: unknown): Error {
  return error instanceof Error ? error : new Error(`session ${kind} failed: ${String(error)}`);
}

function normalizeStartReceipt(result: StartResult): {
  sessionId: string;
  route: Extract<HandlerRouteReceipt, { kind: "owned" }>;
} {
  return result;
}

function normalizeResumeReceipt(result: ResumeResult): {
  sessionId: string;
  route: Extract<HandlerRouteReceipt, { kind: "owned" }> | null;
} {
  return result;
}

function normalizeRouteReceipt(receipt: HandlerRouteReceipt | undefined): HandlerRouteReceipt {
  return receipt ?? { kind: "rejected", reason: "missing_route_receipt", retryable: true };
}

/**
 * Encode a resilience event into the closed `error` event payload by
 * prefixing the message with the event name. Future server-side consumers
 * detect the prefix and re-route; today's web UI just renders the JSON
 * payload as text — see client-resilience design §6.1 for the "kind: 'error'
 * + tagged message" bridge. Server-side `sessionEventSchema` stays untouched.
 */
export function encodeResilienceMessage(eventName: string, payload: Record<string, unknown>): string {
  return `${eventName}: ${JSON.stringify(payload)}`;
}

export class SessionRuntime {
  private readonly config: SessionRuntimeConfig;
  private readonly inboxDelivery: InboxDeliveryCoordinator;
  /**
   * Unique owner of session-map membership, evicted resume mappings, current
   * trigger, SessionRegistry persistence timing, and runtime/state projection.
   */
  private readonly projection: SessionProjectionAuthority<SessionEntry>;
  /**
   * Unique owner of route-transition fencing, teardown debt, route producers,
   * handler retire/shutdown coalescing, and operator-suspend quarantine.
   */
  private readonly routeTeardown: RouteTeardownAuthority;
  /**
   * Unique owner of Reset-generation fencing, terminate-admission ledgers,
   * and replay-fence reconciliation / post-fence recovery.
   */
  private readonly resetReplay: ResetReplayAuthority;
  /**
   * Unique owner of retry single-flight, admission generations, pending slot
   * queue, active-slot accounting, and idle eviction.
   */
  private readonly slotScheduler: SlotSchedulerAuthority;
  /** One-way lifecycle fence: no provider route may be adopted after manager shutdown begins. */
  private shuttingDown = false;

  /**
   * Per-chat Team Skill command registry state, shared across handler
   * restarts for the lifetime of this runtime. `consecutiveNullPublications`
   * is what lets the version fence distinguish a recoverable mismatch from
   * an unresolvable registry (two null publications in a row = provably no
   * progress, bounded terminal notice instead of an infinite recovery loop).
   */
  /**
   * Runtime-level recovery-attempt markers for the config-version fence:
   * the ONLY state shared across handler restarts, scoped per
   * (chatId, messageId) — never a whole registry. A marker is written when
   * a fenced message is retried into a fresh handler, and reclaimed when
   * that exact message later formats successfully, settles (finishTurn),
   * or hits the bounded terminal boundary. Two unrelated messages never
   * consume each other's single recovery chance.
   */
  private readonly fenceRecoveryAttempts = new Map<string, Set<string>>();

  /**
   * Messages whose format failed with a RECOVERABLE fence error (unknown
   * registry or handler-behind version mismatch) and that still have
   * pending inbox custody. Written by the format boundary, consumed
   * exactly once — by whichever real retry fires first (a provider's
   * DeliveryToken.retry via retryDeliveryTurn, or the start/resume
   * failure path) — and cleared on format success or ACK commit. This is
   * what keeps a format throw from being mistaken for a consumed
   * recovery before any retry actually happened.
   */
  private readonly pendingFenceFormatFailures = new Map<string, Set<string>>();

  private recordPendingFenceFormatFailure(chatId: string, message: SessionMessage): void {
    if (message.inboxEntryId === undefined) return;
    if (!this.inboxDelivery.hasEntry({ chatId, entryId: message.inboxEntryId, messageId: message.id })) return;
    let pending = this.pendingFenceFormatFailures.get(chatId);
    if (!pending) {
      pending = new Set();
      this.pendingFenceFormatFailures.set(chatId, pending);
    }
    pending.add(message.id);
  }

  private clearPendingFenceFormatFailure(chatId: string, messageId: string): void {
    const pending = this.pendingFenceFormatFailures.get(chatId);
    if (!pending) return;
    pending.delete(messageId);
    if (pending.size === 0) this.pendingFenceFormatFailures.delete(chatId);
  }

  /**
   * The single consumption point for fence format failures, shared by
   * every real retry boundary (DeliveryToken.retry, SessionContext
   * retryTurn, and the start/resume failure path). Only an actual retry
   * consumes: the message's ONE fresh-handler recovery is recorded and
   * the session is failed for recovery. Idempotent per message — the
   * pending entry is deleted on consume, so a handler retry and a runtime
   * catch can never double-process the same failure.
   */
  private consumeFenceFormatFailures(chatId: string, messages: readonly SessionMessage[]): boolean {
    const pending = this.pendingFenceFormatFailures.get(chatId);
    if (!pending) return false;
    let consumed = false;
    for (const message of messages) {
      if (!pending.delete(message.id)) continue;
      if (
        message.inboxEntryId !== undefined &&
        this.inboxDelivery.hasEntry({ chatId, entryId: message.inboxEntryId, messageId: message.id })
      ) {
        this.recordFenceRecoveryAttempt(chatId, message.id);
        consumed = true;
      }
    }
    if (pending.size === 0) this.pendingFenceFormatFailures.delete(chatId);
    if (consumed) {
      this.failSessionForRecovery(chatId, "team_skill_registry_version_mismatch");
    }
    return consumed;
  }

  private hasFenceRecoveryAttempt(chatId: string, messageId: string): boolean {
    return this.fenceRecoveryAttempts.get(chatId)?.has(messageId) ?? false;
  }

  private recordFenceRecoveryAttempt(chatId: string, messageId: string): void {
    let markers = this.fenceRecoveryAttempts.get(chatId);
    if (!markers) {
      markers = new Set();
      this.fenceRecoveryAttempts.set(chatId, markers);
    }
    markers.add(messageId);
  }

  private clearFenceRecoveryAttempt(chatId: string, messageId: string): void {
    const markers = this.fenceRecoveryAttempts.get(chatId);
    if (!markers) return;
    markers.delete(messageId);
    if (markers.size === 0) this.fenceRecoveryAttempts.delete(chatId);
  }

  constructor(config: SessionRuntimeConfig) {
    this.config = config;
    this.projection = new SessionProjectionAuthority<SessionEntry>(
      {
        log: config.log,
        onStateChange: () => this.config.onStateChange,
        onSessionRuntimeChange: () => this.config.onSessionRuntimeChange,
        onRuntimeStateChange: () => this.config.onRuntimeStateChange,
        hasProcessingOwnedWork: (chatId) => this.inboxDelivery.hasProcessingOwnedWork(chatId),
        drainPendingOnIdle: () => {
          this.slotScheduler.drainPendingQueue();
        },
        hasRuntimeSyncForceKeepExtra: (chatId) => this.hasRuntimeSyncForceKeepExtra(chatId),
        completeBindRecovery: (chatId) => this.inboxDelivery.completeBindRecovery(chatId),
        resumeFallbackSessionId: (session) => this.slotScheduler.resumeFallbackSessionId(session as SessionEntry),
        hasPendingTransientRetry: (session) => this.slotScheduler.hasPendingTransientRetry(session as SessionEntry),
      },
      { registryPath: config.registryPath },
    );
    this.routeTeardown = new RouteTeardownAuthority({
      log: config.log,
      isShuttingDown: () => this.shuttingDown,
      getSession: (chatId) => this.projection.getSession(chatId),
      isActiveSlotHeld: (entry) => this.slotScheduler.isActiveSlotHeld(entry as SessionEntry),
      createHandler: () =>
        this.createHandler(captureContextSourceAdmission(contextSourceFromHandlerConfig(this.config.handlerConfig))),
      invalidateDeliveryAdmission: (chatId) => this.slotScheduler.invalidateDeliveryAdmission(chatId),
      runtimeProvider: () => this.runtimeProvider(),
      emitResilienceEvent: (chatId, eventName, payload) => this.emitResilienceEvent(chatId, eventName, payload),
    });
    this.resetReplay = new ResetReplayAuthority(
      {
        log: config.log,
        isShuttingDown: () => this.shuttingDown,
        isQuarantineRestartRequired: (chatId) => this.routeTeardown.isProviderAdmissionRestartRequired(chatId),
        inbox: () => this.inboxDelivery,
        recoverChat: () => this.config.recoverChat,
        probeFencedSettlement: () => this.config.probeFencedSettlement,
        onSessionRuntimeChange: () => this.config.onSessionRuntimeChange,
        projectSessionRuntime: (chatId) => this.projection.projectSessionRuntime(chatId),
        rotateFreshStartNonce: (chatId) => {
          this.projection.rotateFreshStartNonce(chatId);
        },
        persistRegistryThrowing: () => {
          this.projection.persistRegistry({ throwOnFailure: true });
        },
        markResetNonceDurable: (chatId) => {
          this.projection.markResetNonceDurable(chatId);
        },
      },
      { replayFencePath: config.replayFencePath },
    );
    this.inboxDelivery = new InboxDeliveryCoordinator({
      ackEntry: config.ackEntry,
      recoverChat: config.recoverChat,
      postRuntimeFailureNotice: async (chatId, payload) => {
        await postProviderFailureRuntimeNotice(this.config.sdk, chatId, payload);
      },
      onWorkChanged: (chatId) => this.projection.projectSessionRuntime(chatId),
      onDeliveriesCommitted: (chatId, messageIds) => {
        this.resetReplay.reconcileReplayFences(chatId, messageIds);
        // Fence recovery-attempt markers are reclaimed only once inbox
        // custody is proven settled by ACK commit — never earlier, so an
        // ACK failure / redelivery cannot mint a second recovery chance.
        for (const messageId of messageIds) {
          this.clearFenceRecoveryAttempt(chatId, messageId);
          this.clearPendingFenceFormatFailure(chatId, messageId);
        }
      },
      log: config.log,
    });
    this.slotScheduler = new SlotSchedulerAuthority({
      log: config.log,
      isShuttingDown: () => this.shuttingDown,
      concurrency: () => this.config.concurrency,
      maxSessions: () => this.config.session.max_sessions,
      idleTimeoutSec: () => this.config.session.idle_timeout,
      workingGraceSec: () => this.config.session.working_grace_seconds,
      hasLiveSubprocessProbe: (chatId) => this.config.subprocessProbe?.hasLiveSubprocess(chatId) === true,
      isProviderRouteAdmissionFenced: (chatId) => this.resetReplay.isProviderRouteAdmissionFenced(chatId),
      getSession: (chatId) => this.projection.getSession(chatId),
      sessionsValues: () => this.projection.sessionsValues(),
      sessionsEntries: () => this.projection.sessionsEntries(),
      sessionCount: () => this.projection.sessionCount(),
      dropLiveSession: (chatId) => {
        this.projection.dropLiveSession(chatId);
      },
      inbox: this.inboxDelivery,
      routeTeardown: this.routeTeardown,
      onSessionEvent: config.onSessionEvent
        ? (chatId, event) => {
            config.onSessionEvent?.(chatId, event);
          }
        : undefined,
      suspendSession: (entry, opts) => this.suspendSession(entry as SessionEntry, opts),
      emitResilienceEvent: (chatId, eventName, payload) => this.emitResilienceEvent(chatId, eventName, payload),
      routeMessage: (chatId, message, deliveryKind) => this.routeMessage(chatId, message, deliveryKind),
      resumeSession: (entry, message, deliveryKind) => this.resumeSession(entry as SessionEntry, message, deliveryKind),
      retryDeliveryTurn: (chatId, messages, reason) => this.retryDeliveryTurn(chatId, messages, reason),
      authorizeContextSource: () => this.ensureContextTreeBinding(),
      createHandler: (admission) => this.createHandler(admission),
      recordHandlerSource: (entry, sourceKey) => this.projection.recordHandlerSource(entry as SessionEntry, sourceKey),
      buildSessionContext: (chatId, lease) => this.buildSessionContext(chatId, lease),
      createDeliveryToken: (chatId, lease) => this.createDeliveryToken(chatId, lease),
      setCurrentTrigger: (chatId, message) => this.projection.setCurrentTrigger(chatId, message),
      notifySessionState: (chatId, state) => this.projection.notifySessionState(chatId, state),
      projectSessionRuntime: (chatId, opts) => this.projection.projectSessionRuntime(chatId, opts),
      adoptResumeReceipt: (entry, message, receipt, lostReason) =>
        this.adoptResumeReceipt(entry as SessionEntry, message, receipt, lostReason),
      markRouteOwned: (chatId, message, route) => this.markRouteOwned(chatId, message, route),
      abortUnownedRoute: (entry, reason) => this.abortUnownedRoute(entry as SessionEntry, reason),
      handleSessionFailure: (args) =>
        this.handleSessionFailure({
          ...args,
          entry: args.entry as SessionEntry,
        }),
      teardownTerminalSessionFailure: (entry, message, handling) =>
        this.teardownTerminalSessionFailure(entry as SessionEntry, message, handling),
      drainDeferredMessages: (entry) => this.drainDeferredMessages(entry as SessionEntry),
      persistRegistry: () => this.projection.persistRegistry(),
      ensureImagesLocal: (message) => this.ensureImagesLocal(message),
      failSessionForRecovery: (chatId, reason, sessionId) => this.failSessionForRecovery(chatId, reason, sessionId),
      runtimeProvider: () => this.runtimeProvider(),
      normalizeResumeReceipt,
      normalizeStartReceipt,
      recordEvictionResume: (chatId, mapping) => this.projection.recordEvictionResume(chatId, mapping),
      getSessionRuntimeState: (chatId) => this.projection.getSessionRuntimeState(chatId),
      recomputeRuntimeState: () => this.projection.recomputeRuntimeState(),
    });
    this.slotScheduler.startIdleEviction();
    // Independent of `evictIdle` (which early-continues on freshly-active
    // sessions): re-affirm working / error sessions so the
    // server-side `runtime_state_at` stays inside the freshness window.
    // Jittered setTimeout (rearmed each tick) instead of setInterval so
    // many clients don't align on the same instant.
    this.projection.startRuntimeReaffirm();

    // Load persisted sessions (all start as suspended)
    this.projection.loadPersistedSessions();
  }

  updateTransport(sdk: FirstTreeHubSDK, agentConfigCache?: AgentConfigCache): void {
    this.config.sdk = sdk;
    if (agentConfigCache) {
      this.config.agentConfigCache = agentConfigCache;
    }
  }

  /**
   * Dispatch an inbox entry. ACK is deferred until the handler reports a
   * completed turn via `ctx.finishTurn(...)`.
   *
   * Delayed ACK semantics (post inflight-message-recovery): the entry stays
   * `delivered` server-side until the handler completes the turn via
   * `ctx.finishTurn(...)` (or surfaces a permanent error). If this client
   * crashes mid-turn, the next
   * `agent:bind` resets the entry back to `pending` so a fresh client
   * resumes the work — see docs/inflight-message-recovery-design.md.
   *
   * No routing guards run client-side any more: the cross-chat
   * reply-routing mechanism (`replyToChat` / `shouldSuppressEcho`) has been
   * removed (see first-tree-context PR #281), and the mention filter moved
   * server-side to fan-out (`services/chat/message.ts sendMessage`). Anything
   * reaching dispatch is, by construction, meant for this agent.
   */
  async dispatch(entry: InboxEntryWithMessage): Promise<void> {
    const chatId = entry.chatId ?? entry.message.chatId;
    const messageId = entry.message.id;
    const admissionGeneration = this.slotScheduler.currentAdmissionGeneration(chatId);
    const admissionValid = () =>
      !this.shuttingDown &&
      this.slotScheduler.currentAdmissionGeneration(chatId) === admissionGeneration &&
      !this.resetReplay.isProviderRouteAdmissionFenced(chatId);
    const suspending = this.projection.getSession(chatId)?.suspending;
    if (suspending) await suspending;
    const isRecoveryRedelivery = this.inboxDelivery.takeRecoveryActivationReady(chatId);

    if (
      !isRecoveryRedelivery &&
      // Never open same-socket recovery while Reset admission is fenced:
      // recoverChat would redeliver the same unacked rows into the fence and
      // trip the server's no-progress circuit.
      !this.resetReplay.isProviderRouteAdmissionFenced(chatId) &&
      this.inboxDelivery.shouldRecoverBeforeDispatch(
        chatId,
        this.hasHealthyLiveHandler(chatId) || this.hasPendingTransientRetry(chatId),
        this.hasLocalRecoveryRisk(chatId),
      )
    ) {
      await this.inboxDelivery.recoverIfNeeded(chatId, `before_dispatch:${entry.id}:${messageId}`);
      return;
    }

    const decision = this.inboxDelivery.receive(entry);
    if (decision.kind !== "deliver") return;
    const { work } = decision;
    const message = this.extractMessage(entry);

    let routePromise: Promise<void> | undefined;
    try {
      await this.inboxDelivery.runAdmission(work, async () => {
        if (!this.inboxDelivery.hasEntry(work)) return;

        // 2. Step 4: refresh runtime config if the message brought a newer
        // version. This is the *only* trigger for active-session re-config —
        // matches PRD §7.2. Failures are logged but do not block delivery on
        // M1: handler integration in Step 6 will decide whether to use the
        // stale config or hold the message until the server recovers.
        if (this.config.agentConfigCache) {
          try {
            await this.config.agentConfigCache.refreshIfNewer(
              this.config.agentIdentity.agentId,
              entry.message.configVersion,
            );
          } catch (err) {
            const proofReason = this.runtimeSessionProofReasonForError(err);
            if (proofReason && (await this.holdDeliveryForRuntimeSessionProofRecovery(chatId, message, proofReason))) {
              return;
            }
            this.config.log.warn(
              {
                chatId,
                agentId: this.config.agentIdentity.agentId,
                incomingVersion: entry.message.configVersion,
                err,
              },
              "config version mismatch — skipping refresh",
            );
          }
        }

        if (!this.inboxDelivery.hasEntry(work)) return;

        // Note: the "mention_only" filter now lives on the server (see
        // services/chat/message.ts sendMessage fan-out). If an entry reaches dispatch
        // we assume server already decided we should handle it — this avoids a
        // double-guard that drifted between server / client in early M1.

        // 4b. Preserve current-message image materialization, then pull only
        // generic request images from silent preceding context. The added
        // history work is best-effort and bounded; anything not fetched still
        // renders with a filename and an unavailable placeholder.
        await this.ensureImagesLocal(message);
        const feishuReferenceContextLoad = this.ensureFeishuReferenceContext(message);
        if (feishuReferenceContextLoad) await feishuReferenceContextLoad;

        if (!admissionValid()) {
          if (this.inboxDelivery.hasEntry(work)) {
            if (this.resetReplay.isProviderRouteAdmissionFenced(chatId)) {
              await this.resetReplay.parkDeliveryBehindResetAdmissionFence(chatId, message);
            } else {
              this.retryDeliveryTurn(chatId, message, "delivery_admission_invalidated");
            }
          }
          return;
        }
        if (!this.inboxDelivery.hasEntry(work)) return;

        // 5. Route by session state. ACK no longer happens inside route — the
        // entry sits in the coordinator ledger until the handler completes the
        // concrete message/batch it actually consumed. Do not await inside the
        // admission barrier: for Codex/TUI, route promises can span the whole
        // turn, but same-chat later messages must still be able to append once
        // this entry has reached handler membership.
        const deliveryKind: SlotDeliveryKind = isRecoveryRedelivery ? "recovery" : "fresh";
        routePromise = this.routeMessage(chatId, message, deliveryKind).catch(async (err) => {
          if (this.inboxDelivery.hasEntry(work)) {
            const proofReason = this.runtimeSessionProofReasonForError(err);
            if (proofReason && (await this.holdDeliveryForRuntimeSessionProofRecovery(chatId, message, proofReason))) {
              return;
            }
            this.retryDeliveryTurn(chatId, message, "route_message_failed");
          }
          throw err;
        });
      });
    } catch (err) {
      if (this.inboxDelivery.hasEntry(work)) {
        const proofReason = this.runtimeSessionProofReasonForError(err);
        if (proofReason && (await this.holdDeliveryForRuntimeSessionProofRecovery(chatId, message, proofReason))) {
          return;
        }
        this.retryDeliveryTurn(chatId, message, "admission_failed");
      }
      throw err;
    }

    if (routePromise) await routePromise;
  }

  /**
   * Resolve current-message image refs exactly as before, then materialize only
   * the generic request-image refs from silent preceding context. Historical
   * refs are considered newest-first under a separate 10-fetch budget;
   * duplicates and cached refs consume no budget.
   */
  private async ensureImagesLocal(message: SessionMessage): Promise<void> {
    // Drop any 404 verdicts from a previous delivery attempt of this same
    // message instance (retry path): the set is rebuilt from this pass only.
    delete message.unavailableAttachmentIds;
    // Attachment ids whose fetch answered 404 this delivery — attached to the
    // message below so renderers can say "expired or unavailable".
    const goneIds = new Set<string>();
    const legacyImageRefs =
      message.format === "file" && isImageBatchRefContent(message.content)
        ? message.content.attachments
        : message.format === "file" && isImageRefContent(message.content)
          ? [message.content]
          : [];
    const genericImageRefs = imageAttachmentRefsFromMetadata(message.metadata ?? undefined).map((ref) => ({
      imageId: ref.attachmentId,
      mimeType: ref.mimeType,
      filename: ref.filename,
      size: ref.size,
    }));
    const imageRefs = [...legacyImageRefs, ...genericImageRefs];
    const seenImageIds = new Set(imageRefs.map((ref) => ref.imageId));
    let precedingFetches = 0;
    for (const source of (message.precedingMessages ?? []).slice().reverse()) {
      if (source.format !== "request") continue;
      for (const ref of imageAttachmentRefsFromMetadata(source.metadata ?? undefined)) {
        if (seenImageIds.has(ref.attachmentId)) continue;
        seenImageIds.add(ref.attachmentId);
        if (findImagePath(message.chatId, ref.attachmentId, ref.mimeType)) continue;
        if (precedingFetches === MAX_EAGER_IMAGE_FETCHES_PER_DELIVERY) break;
        imageRefs.push({
          imageId: ref.attachmentId,
          mimeType: ref.mimeType,
          filename: ref.filename,
          size: ref.size,
        });
        precedingFetches += 1;
      }
      if (precedingFetches === MAX_EAGER_IMAGE_FETCHES_PER_DELIVERY) break;
    }
    await Promise.all(
      imageRefs.map(async (ref) => {
        if (findImagePath(message.chatId, ref.imageId, ref.mimeType)) return;
        try {
          const { bytes } = await this.config.sdk.fetchAttachment({ id: ref.imageId });
          await writeImage({
            chatId: message.chatId,
            imageId: ref.imageId,
            mimeType: ref.mimeType,
            base64: bytes.toString("base64"),
          });
        } catch (err) {
          if (isAttachmentGoneError(err)) goneIds.add(ref.imageId);
          this.config.log.warn(
            { chatId: message.chatId, imageId: ref.imageId, err },
            "eager image fetch failed — message will render a placeholder",
          );
        }
      }),
    );

    // Documents/files: generic refs in `metadata.attachments`, any format.
    // Written under the files dir keyed by their real filename so the handler
    // can hand the model an on-disk path to Read. A no-op for messages without
    // document attachments (the common case).
    const docRefs = attachmentRefsFromMetadata(message.metadata ?? undefined).filter((ref) => ref.kind !== "image");
    await Promise.all(
      docRefs.map(async (ref) => {
        if (findAttachmentFile(message.chatId, ref.attachmentId, ref.filename)) return;
        try {
          const { bytes } = await this.config.sdk.fetchAttachment({ id: ref.attachmentId });
          await writeAttachmentFile({
            chatId: message.chatId,
            attachmentId: ref.attachmentId,
            filename: ref.filename,
            base64: bytes.toString("base64"),
          });
        } catch (err) {
          if (isAttachmentGoneError(err)) goneIds.add(ref.attachmentId);
          this.config.log.warn(
            { chatId: message.chatId, attachmentId: ref.attachmentId, err },
            "eager attachment fetch failed — agent will not see this file",
          );
        }
      }),
    );
    if (goneIds.size > 0) message.unavailableAttachmentIds = goneIds;
  }

  private ensureFeishuReferenceContext(message: SessionMessage): Promise<void> | null {
    if (message.feishuReferenceContext !== undefined) return null;
    const feishu = readFeishuMessageMetadata(message.metadata);
    if (
      message.senderKind !== "integration" ||
      message.senderProvider !== "feishu" ||
      message.source !== "feishu" ||
      !feishu ||
      feishu.direction !== "inbound"
    ) {
      return null;
    }

    const scope = feishu.reference.threadId ? "thread" : "chat";
    return this.loadFeishuReferenceContext(message, scope);
  }

  private async loadFeishuReferenceContext(message: SessionMessage, scope: "thread" | "chat"): Promise<void> {
    try {
      const context = await this.config.sdk.getFeishuReferenceContext(message.id);
      if (context.state !== "available") {
        message.feishuReferenceContext = context;
        return;
      }
      const canonicalExternalIds = new Set(
        (message.precedingMessages ?? []).flatMap((preceding) => {
          const metadata = readFeishuMessageMetadata(preceding.metadata);
          return metadata?.direction === "inbound" ? [metadata.reference.messageId] : [];
        }),
      );
      message.feishuReferenceContext = {
        ...context,
        messages: context.messages.filter((item) => !canonicalExternalIds.has(item.externalMessageId)),
      };
    } catch (err) {
      this.config.log.warn(
        { chatId: message.chatId, messageId: message.id, err },
        "Feishu reference context unavailable",
      );
      message.feishuReferenceContext = {
        state: "unavailable",
        scope,
        messages: [],
        truncated: false,
        reason: "provider_unavailable",
      };
    }
  }

  /**
   * Handle a server-issued session command. Terminate drops all local state
   * without reporting back. `resetRef` is the ref'd Reset generation this
   * terminate belongs to — it arms the parked-fence release so only that
   * generation's exact receipted terminal disposition (`session:command:finalized`
   * or `session:command:aborted`) can lift the fence.
   */
  async handleCommand(chatId: string, command: SessionCommandType, options?: { resetRef?: string }): Promise<void> {
    if (command === "session:terminate" && this.routeTeardown.hasQuarantinedChat(chatId)) {
      throw this.routeTeardown.quarantineRestartRequiredError(chatId, "Reset");
    }
    const inFlightTermination = this.resetReplay.joinInFlightTermination(chatId);
    if (inFlightTermination) {
      // A duplicate terminate joins the in-flight cleanup instead of
      // returning early: a ref'd caller (Reset apply-ack) must only resolve
      // after the shared work settles, and must reject if it rejects.
      // Suspend/resume keep the early-return admission fence.
      if (command === "session:terminate") {
        // A joining ref'd Reset shares this one termination, so it becomes an
        // ALIAS of the generation that termination arms rather than
        // superseding it: both Resets have the same local outcome, so either
        // one's exact receipted terminal disposition is an honest release, and
        // neither may invalidate the other's.
        if (options?.resetRef !== undefined) {
          const joiningRef = options.resetRef;
          return inFlightTermination.then(() => {
            this.armParkedResetFenceRelease(chatId, joiningRef, { join: true });
          });
        }
        return inFlightTermination;
      }
      return;
    }

    if (command === "session:suspend") {
      const session = this.projection.getSession(chatId);
      this.slotScheduler.invalidateDeliveryAdmission(chatId);
      if (session) this.slotScheduler.clearRetryState(session);
      if (session && this.slotScheduler.isActiveSlotHeld(session)) {
        this.config.log.info({ chatId }, "suspend command received");
        this.suspendSession(session, {
          reason: "operator_suspended",
          ackConsumedPrefix: true,
          operatorResolution: true,
        });
      } else {
        await this.inboxDelivery.prepareOperatorSuspend(chatId);
      }
      this.projection.projectSessionRuntime(chatId);
      return;
    }

    if (command === "session:resume") {
      const session = this.projection.getSession(chatId);
      if (session?.suspending) await session.suspending;
      if (this.routeTeardown.isProviderAdmissionRestartRequired(chatId)) {
        throw this.routeTeardown.quarantineRestartRequiredError(chatId, "provider admission");
      }
      if (await this.recoverDebtBeforeResume(chatId, "session_resume:recovery_debt")) {
        this.slotScheduler.drainPendingQueue();
        return;
      }
      const current = this.projection.getSession(chatId);
      if (
        current &&
        this.slotScheduler.hasPendingTransientRetry(current) &&
        current.status === "suspended" &&
        !this.slotScheduler.isActiveSlotHeld(current)
      ) {
        this.slotScheduler.triggerImmediateRetry(chatId);
      } else if (
        current &&
        (current.status === "suspended" || current.status === "evicted") &&
        !this.slotScheduler.isActiveSlotHeld(current)
      ) {
        this.config.log.info({ chatId }, "resume command received");
        await this.resumeSession(current, undefined, "fresh");
      }
      this.projection.projectSessionRuntime(chatId);
      this.slotScheduler.drainPendingQueue();
      return;
    }

    if (command === "session:terminate") {
      const session = this.projection.getSession(chatId);
      // NOTE: there is deliberately NO no-work early return. Empty memory
      // (no session, mapping, queue, custody, failure marker, debt, or
      // producer) proves nothing about the DISK registry — a mapping
      // persisted earlier (e.g. at suspend time) may still be on disk and
      // would be reloaded as an evicted mapping after a crash, reviving the
      // old provider thread. Every apply-acked terminate therefore runs the
      // full body below, whose final step durably flushes the authoritative
      // registry snapshot (see flushTerminateRegistry).
      this.slotScheduler.invalidateDeliveryAdmission(chatId);
      this.config.log.info({ chatId }, "terminate command received");
      await this.resetReplay.runOrJoinTermination(chatId, async () => {
        if (session) this.slotScheduler.cancelRetryTimer(session);
        if (session) this.routeTeardown.invalidateRouteTransition(session, "session_terminated");
        // Join an in-flight suspend before any state deletion: handler.suspend()
        // may still be running, and the slot was already released so the
        // activeSlotHeld teardown below would never fire. `suspending` never
        // rejects (legacy resolve-always contract for dispatch/resume), so the
        // outcome recorded on the entry is what lets a failed suspend fail the
        // apply instead of acking over a possibly-live handler.
        const joinedSuspend = session?.suspending != null;
        if (session?.suspending) await session.suspending;
        if (this.routeTeardown.hasQuarantinedChat(chatId)) {
          throw this.routeTeardown.quarantineRestartRequiredError(chatId, "Reset");
        }
        if (joinedSuspend && session?.suspendError) throw asTerminateError("suspend", session.suspendError.error);
        const activeSlotHeld = session ? this.slotScheduler.isActiveSlotHeld(session) : false;
        if (session) this.slotScheduler.releaseActiveSlot(session);
        // The teardown boundary — strict in every case, because a
        // handler.shutdown rejection must fail the apply (applied:false),
        // never resolve into an ack over a possibly-live handler. Beyond the
        // slot-held ordinary case, teardown is also required when a joined
        // suspend left the handler live, or when a recorded
        // suspendError/teardownError says the old run was never confirmed
        // stopped (retry path: `suspending` is null again and the slot is
        // already released, so without the recorded errors no teardown branch
        // would fire). `handlerStoppedBySuspend` marks the case where the
        // suspend boundary already completed the shutdown of the CURRENT
        // handler — tearing down again would double-shutdown. It is bound to
        // the handler identity, so a replacement handler (installed e.g. by
        // `handlerForRouteTransition` after the old one was retired) never
        // inherits the exemption and is always torn down. A teardown failure
        // is recorded on the
        // entry (boxed: rejections can be falsey) so a genuine retry
        // re-attempts it instead of turning into a false success; on success
        // the entry is deleted below, retiring the recorded errors with it.
        const needsTeardown =
          session != null &&
          session.handlerStoppedBySuspend !== session.handler &&
          (activeSlotHeld || joinedSuspend || session.suspendError != null || session.teardownError != null);
        if (session && needsTeardown) {
          try {
            await this.routeTeardown.shutdownHandler(session.handler, "session_terminated", { observeFailure: true });
          } catch (err) {
            session.teardownError = { error: err };
            throw asTerminateError("teardown", err);
          }
        }

        // Join the chat's in-flight route producers BEFORE draining debt: a
        // canceled start/resume can still materialize late, and only its
        // settle funnels that materialization into
        // `discardStaleRouteTransition` → fresh teardown debt. The drain
        // below must see that complete debt, so this quiesce runs first.
        await this.routeTeardown.quiesceRouteProducers(chatId);

        // Settle every pending teardown debt for this chat: handlers detached
        // from their entry (eviction / recovery / abort / terminal cleanup /
        // canceled fresh-start / replacement) without a confirmed stop must
        // be confirmed stopped before the apply may ack. A failure keeps the
        // debt registered and rejects — the retry re-attempts it (coalescing
        // joins any still in-flight shutdown's raw face), so the loop
        // converges instead of acking over a live old run.
        // Drain to a STABLE empty: awaiting one shutdown can let another
        // lifecycle path register fresh debt for this chat mid-drain (e.g. a
        // concurrent max-session eviction of the still-present session), so
        // loop until a full scan finds nothing left.
        for (;;) {
          const pendingTeardown = this.routeTeardown.pendingTeardownHandlers(chatId);
          if (pendingTeardown.length === 0) break;
          for (const pendingHandler of pendingTeardown) {
            try {
              await this.routeTeardown.shutdownHandler(pendingHandler, "session_terminated", { observeFailure: true });
              this.routeTeardown.dropPendingTeardown(chatId, pendingHandler);
            } catch (err) {
              throw asTerminateError("teardown", err);
            }
          }
        }

        this.projection.forgetChat(chatId);

        this.slotScheduler.clearPendingQueueForChat(chatId);

        // Terminate is operator intent: accepted delivery work can be drained,
        // but coordinator keeps any uncommitted tail as recovery debt. Defer
        // same-socket recoverChat until the admission fence clears so fenced
        // redelivery cannot open the server's no-progress circuit.
        await this.inboxDelivery.drainForTerminate(chatId, { requestNow: false });

        this.projection.recomputeRuntimeState();
        this.flushTerminateRegistry(chatId);
        this.slotScheduler.drainPendingQueue();
      });
      // Local terminate succeeded (flush included). A ref'd Reset arms a
      // fresh generation and keeps provider admission fenced until that
      // generation's exact receipted terminal disposition (`finalized` or
      // `aborted`), whether or not anything is parked yet — do NOT recover
      // here (that races session:command:applied / the disposition).
      this.armParkedResetFenceRelease(chatId, options?.resetRef);
    }
  }

  /** @see ResetReplayAuthority.flushTerminateRegistry */
  private flushTerminateRegistry(chatId: string): void {
    this.resetReplay.flushTerminateRegistry(chatId);
  }

  /** Chat IDs this client still holds locally and should report to runtime sync. */
  getHeldChatIds(activeChatIds: RuntimeSyncActiveSet = null): string[] {
    const extraHeldIds: string[] = [];
    // Unresolved teardown debt keeps the chat held: the handler is not
    // confirmed stopped, so the server must keep this chat in the sync set —
    // dropping it would lose the reconcile retry channel for the debt.
    extraHeldIds.push(
      ...this.routeTeardown.pendingTeardownChatIds(),
      ...this.routeTeardown.routeProducerChatIds(),
      ...this.routeTeardown.quarantinedChatIds(),
      ...this.resetReplay.terminatingChatIds(),
      ...this.resetReplay.terminatePersistFailureIds(),
      ...this.resetReplay.awaitingResetFenceReleaseIds(),
      ...this.resetReplay.armedResetGenerationChatIds(),
    );
    return this.projection.getHeldChatIds(activeChatIds, extraHeldIds);
  }

  /**
   * Apply a server-declared stale list from `session:reconcile:result` — treat
   * each chatId as if a `session:terminate` command had arrived.
   */
  applyStaleChatIds(staleChatIds: string[]): void {
    for (const id of staleChatIds) {
      // Terminate is strict now (teardown/persist failures reject): observe
      // the rejection so a failed stale cleanup is logged instead of crashing
      // the client as an unhandled rejection. The strict boundary keeps the
      // entry/mapping intact on failure, so the next reconcile still finds
      // the chat locally held, declares it stale again, and retries.
      // Server already declared these chats stale, so release parked Reset-fence
      // debt after a successful local apply (no apply-ack finalize wait).
      // A reconcile result is a SNAPSHOT of older server state: it carries no
      // Reset generation, so the unref'd release refuses while a generation is
      // armed rather than lifting a newer Reset's fence behind its back. That
      // Reset's own receipted terminal disposition remains the only thing that
      // releases it.
      void this.handleCommand(id, "session:terminate")
        .then(() => {
          const verdict = this.releaseParkedResetFenceRecovery(id);
          if (verdict === "stale") {
            this.config.log.info(
              { chatId: id },
              "stale-reconcile terminate did not release the Reset fence; a newer Reset generation is armed",
            );
          }
        })
        .catch((err) => {
          this.config.log.warn({ chatId: id, err }, "stale session terminate failed; will retry on next reconcile");
        });
    }
  }

  /** Shut down all sessions gracefully. */
  async shutdown(reason?: string, opts: SessionRuntimeShutdownOptions = {}): Promise<void> {
    this.shuttingDown = true;
    this.config.subprocessProbe?.stop();
    this.slotScheduler.stopIdleEviction();
    this.projection.stopRuntimeReaffirm();

    this.slotScheduler.cancelAllRetryTimers();
    this.resetReplay.clearTimersOnShutdown();

    const attemptedHandlers = new Set<AgentHandler>();
    const shutdowns = [...this.projection.sessionsValues()].map((session) => {
      // Fence new delivery admissions, but do NOT bump routeTransitionGeneration
      // or retire the handler yet: already-issued DeliveryTokens need a stable
      // settlement lease through settleProviderEntered notice-before-ACK.
      // `shuttingDown` already fails closed for adoption/mutation leases.
      this.slotScheduler.invalidateDeliveryAdmission(session.chatId);
      // Stop every session handler whose stop is unconfirmed:
      // - active-slot (may need settleProviderEntered notice-before-ACK);
      // - suspend boundary still in flight (join coalesced teardown);
      // - completed failed suspend/teardown markers (`suspendError` /
      //   `teardownError`) where the boundary left the handler live and
      //   `suspending` is already null — otherwise clearing `sessions`
      //   orphans the last owner with no shutdown attempt.
      // A successfully suspended, resource-closed handler
      // (`handlerStoppedBySuspend === handler`, no error markers) is kept
      // for resume and is not redundantly shut down here.
      const stopUnconfirmedAfterFailedBoundary =
        session.handlerStoppedBySuspend !== session.handler &&
        (session.suspendError != null || session.teardownError != null);
      if (
        !this.slotScheduler.isActiveSlotHeld(session) &&
        session.suspending === null &&
        !stopUnconfirmedAfterFailedBoundary
      ) {
        return Promise.resolve();
      }
      if (this.routeTeardown.isCurrentHandlerQuarantined(session)) return Promise.resolve();
      attemptedHandlers.add(session.handler);
      return this.routeTeardown.shutdownHandler(session.handler, reason ?? "manager_shutdown", {
        ...(this.slotScheduler.isActiveSlotHeld(session) ? { settleProviderEntered: true } : {}),
        // Failed-boundary / in-flight-suspend stops are best-effort on the
        // manager face — do not reject the whole client shutdown.
        ...(!this.slotScheduler.isActiveSlotHeld(session) ? { observeFailure: true } : {}),
      });
    });
    // Detached handlers recorded as teardown debt have no entry left to reach
    // them — manager shutdown is their last owner. Best-effort stop for each
    // unique one (deduped across chats and against session handlers;
    // coalescing joins any still in-flight shutdown), with the same
    // allSettled semantics as the session loop above. The raw face clears
    // the debt under EVERY chat that registered the handler on a confirmed
    // stop, so the bounded pass below only ever sees handlers whose stop is
    // genuinely unconfirmed.
    const debtChatsByHandler = new Map<AgentHandler, string[]>();
    for (const [chatId, handlers] of this.routeTeardown.pendingTeardownChatBatches()) {
      for (const pendingHandler of handlers) {
        const chatIds = debtChatsByHandler.get(pendingHandler) ?? [];
        chatIds.push(chatId);
        debtChatsByHandler.set(pendingHandler, chatIds);
      }
    }
    for (const [pendingHandler, chatIds] of debtChatsByHandler) {
      if (chatIds.some((chatId) => this.routeTeardown.quarantinedHandler(chatId) === pendingHandler)) continue;
      if (attemptedHandlers.has(pendingHandler)) continue;
      attemptedHandlers.add(pendingHandler);
      shutdowns.push(
        this.routeTeardown.shutdownHandler(pendingHandler, reason ?? "manager_shutdown", { observeFailure: true }).then(
          () => {
            for (const chatId of chatIds) this.routeTeardown.dropPendingTeardown(chatId, pendingHandler);
          },
          () => {},
        ),
      );
    }
    await Promise.allSettled(shutdowns);

    // Settlement leases are closed. Invalidate in-flight start/resume adoption
    // now (Pi HEAD order: settle first, then invalidate) so a producer stuck on
    // pre-provider work (e.g. config refresh) can finish and the wait below
    // cannot hang manager shutdown.
    const shutdownReason = reason ?? "manager_shutdown";
    for (const session of this.projection.sessionsValues()) {
      this.routeTeardown.invalidateRouteTransition(session, shutdownReason);
    }

    // Suspend boundaries AND route producers settling DURING the sweep can
    // register fresh teardown debt (a canceled fresh-start whose stop just
    // failed; a late-materializing canceled route whose discard fires now).
    // Wait for any still in flight — awaiting `suspending` / a producer
    // covers the finally/discard where the debt lands — then give every
    // handler still in debt one bounded best-effort (re)try: remaining debt
    // after the quiesce means the stop is unconfirmed (failed sweep attempt,
    // failed detach, or a late afterPrior stop that just failed), and
    // manager shutdown is the last owner able to retry. Exactly one pass,
    // observed face: shutdown stays best-effort and never blocks on a
    // handler that will not die.
    await Promise.allSettled([
      ...[...this.projection.sessionsValues()]
        .map((session) => session.suspending)
        .filter((pending): pending is Promise<void> => pending !== null),
      ...this.routeTeardown.allRouteProducerPromises(),
    ]);
    const retriedHandlers = new Set<AgentHandler>();
    for (const handlers of this.routeTeardown.pendingTeardownBatches()) {
      for (const pendingHandler of handlers) {
        if (this.routeTeardown.isHandlerInAnyQuarantine(pendingHandler)) continue;
        if (retriedHandlers.has(pendingHandler)) continue;
        retriedHandlers.add(pendingHandler);
        // Each attempt joins a still in-flight shutdown when one exists; a
        // failure earns exactly ONE fresh retry — bounded, so manager
        // shutdown never blocks on a handler that will not die.
        const stopOnce = (): Promise<boolean> =>
          this.routeTeardown
            .shutdownHandler(pendingHandler, reason ?? "manager_shutdown", { observeFailure: true })
            .then(
              () => true,
              () => false,
            );
        if (!(await stopOnce()) && !(await stopOnce())) continue;
        this.routeTeardown.dropPendingTeardownEverywhere(pendingHandler);
      }
    }

    const reportSuspendedSessions = opts.reportSuspendedSessions ?? true;
    if (reportSuspendedSessions) {
      // Withdraw runtime before lifecycle so the server's active-gated idle
      // write lands in-order; the lifecycle write is the server-side fallback
      // if the connection drops between the two frames.
      for (const [chatId, session] of this.projection.sessionsEntries()) {
        if (session.status === "active") {
          this.projection.clearActiveRuntimeProjection(chatId);
          this.projection.notifySessionState(chatId, "suspended");
        }
      }
    }

    if (opts.clearPersistedRegistry) {
      this.projection.clearLiveMapsOnShutdown();
    }

    // Persist final state — flush synchronously so the last batch reaches
    // disk before dispose() tears the timer down. For destructive runtime
    // switches, the cleared maps make this an authoritative empty registry.
    this.projection.persistRegistry({ immediate: true });
    this.projection.disposeRegistry();

    this.projection.clearLiveMapsOnShutdown();
    this.resetReplay.clearResetLedgersOnShutdown();
    this.projection.clearProjectionLedgers();
    this.slotScheduler.resetActiveCount();
  }

  get activeCount(): number {
    return this.slotScheduler.getActiveCount();
  }

  get totalCount(): number {
    return this.projection.sessionCount();
  }

  /**
   * Snapshot used by the UpdateManager's quiet gate to decide whether it is
   * safe to exit the process for a self-update. `activeCount` is the number of
   * sessions currently handling a message; `lastActivityMs` is the most recent
   * activity timestamp across all tracked sessions (0 when there are none).
   */
  getQuietGateSnapshot(): { activeCount: number; lastActivityMs: number } {
    let lastActivityMs = 0;
    for (const entry of this.projection.sessionsValues()) {
      if (entry.lastActivity > lastActivityMs) lastActivityMs = entry.lastActivity;
    }
    return { activeCount: this.slotScheduler.getActiveCount(), lastActivityMs };
  }

  /** Return the current aggregate runtime state, or null if no sessions have reported. */
  getAggregateRuntimeState(): RuntimeState | null {
    return this.projection.getAggregateRuntimeState();
  }

  /** Return all current session states for full state sync after reconnect. */
  getSessionStates(activeChatIds: RuntimeSyncActiveSet = null): Array<{ chatId: string; state: SessionState }> {
    return this.projection.getSessionStates(activeChatIds);
  }

  /**
   * ChatIds the client still holds in `evictedMappings` — i.e. either
   * hydrated from disk on startup or dropped from `sessions` by LRU. Used
   * by the agent-slot full-state-sync to advertise these as "suspended" on
   * the wire, so the server's `agent_chat_sessions.state` doesn't get
   * stuck on a pre-restart "active" snapshot when the in-memory handler is
   * actually gone.
   */
  getEvictedChatIds(activeChatIds: RuntimeSyncActiveSet = null): string[] {
    return this.projection.getEvictedChatIds(activeChatIds);
  }

  /**
   * Release only chats fenced by a runtime-proof fault. The server completes
   * its delivered→pending reset before sending `agent:bound`, so clearing the
   * local ledgers here cannot lose custody and lets the post-bound drain
   * establish fresh ownership.
   */
  noteBindRecoveryComplete(): void {
    this.projection.noteBindRecoveryComplete();
  }

  /**
   * Retry ACK-confirm settlement only for chats that failed inbox:ack
   * confirmation. Independent of runtime-proof and Reset-fence recovery.
   */
  async reconcileAckSettlementAfterBind(): Promise<void> {
    await this.inboxDelivery.reconcileAckSettlementAfterBind();
  }

  // ---- Internal -----------------------------------------------------------

  private hasHealthyLiveHandler(chatId: string): boolean {
    const entry = this.projection.getSession(chatId);
    return entry?.status === "active" && entry.suspending === null;
  }

  private hasPendingTransientRetry(chatId: string): boolean {
    const entry = this.projection.getSession(chatId);
    return Boolean(entry && this.slotScheduler.hasPendingTransientRetry(entry));
  }

  private hasLocalRecoveryRisk(chatId: string): boolean {
    return this.projection.hasEvictedMapping(chatId) || this.projection.getSession(chatId)?.status === "evicted";
  }

  /** Force-keep ledgers owned outside SessionProjectionAuthority. */
  private hasRuntimeSyncForceKeepExtra(chatId: string): boolean {
    if (this.routeTeardown.hasQuarantinedChat(chatId)) return true;
    // Unresolved teardown debt force-keeps the chat: its handler is not
    // confirmed stopped, so dropping the chat from the held report would
    // lose the reconcile retry channel for the debt.
    if (this.routeTeardown.hasPendingTeardown(chatId)) return true;
    // An in-flight route producer force-keeps the chat too: the canceled
    // start/resume can still materialize late, and the reconcile channel is
    // what retries its teardown if the stop fails.
    if (this.routeTeardown.hasRouteProducers(chatId)) return true;
    // In-flight Reset drain or failed durable Reset flush: keep reconcile
    // authority until the successful terminate retry clears the fence.
    if (this.resetReplay.isProviderRouteAdmissionFenced(chatId)) return true;
    if (this.slotScheduler.hasQueuedChat(chatId)) return true;
    return this.inboxDelivery.hasUnsettledWork(chatId);
  }

  /** @see ResetReplayAuthority.armParkedResetFenceRelease */
  armParkedResetFenceRelease(chatId: string, ref?: string, options?: { join?: boolean }): void {
    this.resetReplay.armParkedResetFenceRelease(chatId, ref, options);
  }

  /** @see ResetReplayAuthority.releaseParkedResetFenceRecovery */
  releaseParkedResetFenceRecovery(chatId: string, ref?: string): ResetFenceReleaseVerdict {
    return this.resetReplay.releaseParkedResetFenceRecovery(chatId, ref);
  }

  /** @see ResetReplayAuthority.supersedeResetGeneration */
  supersedeResetGeneration(chatId: string, reason: string): ResetFenceReleaseVerdict {
    return this.resetReplay.supersedeResetGeneration(chatId, reason);
  }

  /** @see ResetReplayAuthority.reconcileReplayFencesWithServer */
  async reconcileReplayFencesWithServer(): Promise<void> {
    await this.resetReplay.reconcileReplayFencesWithServer();
  }

  private createHandler(admission: ContextSourceAdmissionSnapshot): AgentHandler {
    const replayFence = this.resetReplay.createHandlerReplayFenceWriter();
    const handlerCfg = {
      ...this.config.handlerConfig,
      ...(this.config.agentConfigCache ? { agentConfigCache: this.config.agentConfigCache } : {}),
      ...(replayFence ? { replayFence } : {}),
    };
    applyContextSourceToHandlerConfig(handlerCfg, admission.source);
    return this.config.handlerFactory(handlerCfg);
  }

  private runtimeProvider(): RuntimeProvider {
    const parsed = runtimeProviderSchema.safeParse(this.config.handlerConfig.runtimeProvider);
    if (!parsed.success) {
      throw new Error(
        `handlerConfig.runtimeProvider is required and must be a known RuntimeProvider (got ${JSON.stringify(this.config.handlerConfig.runtimeProvider)})`,
      );
    }
    return parsed.data;
  }

  /**
   * Turn liveness for the D-axis, derived from the session events a provider
   * emits *inside* a turn.
   *
   * Raw provider activity is deliberately NOT the signal. `recordProviderActivity`
   * is broader than turn liveness by design — the Codex app-server samples it
   * above its own thread/turn filter, so a late `thread/tokenUsage/updated` for
   * an already-closed turn reaches it and is then recorded as historical usage
   * or buffered, without ever producing a `turn_end`. Treating that sample as a
   * turn start would strand `working` on an idle chat, kept fresh by the
   * re-affirm loop until an unrelated turn ends or the session is suspended.
   *
   * Assistant text, thinking, and tool calls are only emitted from a provider's
   * in-turn path, so they are self-proving evidence that a turn is open; the
   * out-of-turn traffic that caused the problem (`token_usage`,
   * `context_tree_usage`, runtime `error`) is excluded.
   */
  private noteTurnLivenessFromEvent(chatId: string, event: SessionEvent): void {
    if (event.kind === "turn_end") {
      this.projection.noteProviderTurnEnd(chatId);
      return;
    }
    if (event.kind === "assistant_text" || event.kind === "thinking" || event.kind === "tool_call") {
      this.projection.noteProviderTurnStart(chatId);
    }
  }

  private captureRuntimeFailureNotice(
    chatId: string,
    event: SessionEvent,
    mutationLeaseValid: (() => boolean) | null = null,
    expectedEntry: SessionEntry | null = null,
  ): boolean {
    if (mutationLeaseValid && !mutationLeaseValid()) return false;
    if (event.kind !== "error") return false;
    const payload = parseProviderRetryEventMessage(event.payload.message);
    if (!payload || (!shouldPostProviderFailureRuntimeNotice(payload) && !isRuntimeSessionProofFailure(payload))) {
      return false;
    }

    const entry = this.projection.getSession(chatId);
    if (!entry) return false;
    if (expectedEntry && entry !== expectedEntry) return false;
    if (mutationLeaseValid && !mutationLeaseValid()) return false;
    entry.pendingRuntimeFailureNotice = payload;
    return true;
  }

  private emitSessionEvent(chatId: string, event: SessionEvent, expectedEntry: SessionEntry | null = null): void {
    this.config.onSessionEvent?.(chatId, event);
    const mutationLeaseValid = expectedEntry ? () => this.projection.isSameSession(chatId, expectedEntry) : null;
    this.captureRuntimeFailureNotice(chatId, event, mutationLeaseValid, expectedEntry);
  }

  private clearPendingRuntimeFailureNotice(chatId: string): void {
    const entry = this.projection.getSession(chatId);
    if (entry) entry.pendingRuntimeFailureNotice = null;
  }

  private retryDeliveryTurn(
    chatId: string,
    messages: SessionMessage | readonly SessionMessage[],
    reason: string,
  ): void {
    // Unified consumption point for fence format failures — every real
    // retry boundary (provider DeliveryToken.retry, SessionContext
    // retryTurn, admission/route retries) funnels here. Only messages
    // with a pending fence failure AND live custody consume a recovery.
    this.consumeFenceFormatFailures(chatId, Array.isArray(messages) ? messages : [messages]);
    // Preserve the captured terminal notice on the inbox ledger before clearing
    // session-scoped pending state. Recovery/redelivery must retry that notice
    // before any ACK — never treat a notice-failure marker as ACK-eligible.
    if (reason === "runtime_failure_notice_delivery_failed") {
      const pending = this.projection.getSession(chatId)?.pendingRuntimeFailureNotice;
      if (pending && shouldPostProviderFailureRuntimeNotice(pending)) {
        this.inboxDelivery.markNoticeRequired(chatId, messages, pending);
      }
    }
    this.clearPendingRuntimeFailureNotice(chatId);
    this.inboxDelivery.retryTurn(chatId, messages, reason);
  }

  private pendingRuntimeSessionProofFailure(chatId: string): ProviderRetryEventPayload | null {
    const payload = this.projection.getSession(chatId)?.pendingRuntimeFailureNotice;
    return payload && isRuntimeSessionProofFailure(payload) ? payload : null;
  }

  private runtimeSessionProofReasonForError(err: unknown): string | null {
    const classification = classifyProviderFailure(err, {
      provider: this.runtimeProvider(),
      scope: "provider_turn",
      source: "sdk",
    });
    return classification.category === "runtime_transport" ? classification.reasonCode : null;
  }

  private async holdDeliveryForRuntimeSessionProofRecovery(
    chatId: string,
    messages: SessionMessage | readonly SessionMessage[],
    reasonCode?: string,
    mutationLeaseValid: (() => boolean) | null = null,
  ): Promise<boolean> {
    const entry = this.projection.getSession(chatId);
    const payload = entry?.pendingRuntimeFailureNotice;
    const proofReason = reasonCode ?? (payload && isRuntimeSessionProofFailure(payload) ? payload.reasonCode : null);
    if (!proofReason) return false;
    if (mutationLeaseValid && !mutationLeaseValid()) return false;

    const held = await this.inboxDelivery.parkTurnForDeferredRecovery(
      chatId,
      messages,
      `runtime_session_proof:${proofReason}`,
    );
    if (!held) return false;

    if (
      entry &&
      payload &&
      this.projection.isSameSession(chatId, entry) &&
      entry.pendingRuntimeFailureNotice === payload
    ) {
      entry.pendingRuntimeFailureNotice = null;
    }
    this.projection.markRuntimeProofRecoveryChat(chatId);
    if (entry) this.fenceSessionForRuntimeSessionProofRecovery(chatId, proofReason);
    this.projection.projectSessionRuntime(chatId);

    const recover = this.config.recoverRuntimeSessionProof;
    if (!recover) {
      this.config.log.error(
        { chatId, reasonCode: proofReason },
        "runtime-session proof recovery is required but no rebind callback is configured",
      );
      return true;
    }
    void recover(proofReason).catch((err) => {
      this.config.log.warn(
        { chatId, reasonCode: proofReason, err },
        "runtime-session proof rebind failed; inbox debt remains held",
      );
    });
    return true;
  }

  private fenceSessionForRuntimeSessionProofRecovery(chatId: string, reasonCode: string): void {
    const entry = this.projection.getSession(chatId);
    if (!entry) return;
    const reason = `runtime_session_proof:${reasonCode}`;
    this.routeTeardown.invalidateRouteTransition(entry, reason);
    this.slotScheduler.clearRetryState(entry);
    const resumeSessionId = resumableProviderSessionId(
      entry.claudeSessionId,
      this.slotScheduler.resumeFallbackSessionId(entry),
    );
    if (resumeSessionId) {
      this.projection.recordEvictionResume(chatId, {
        claudeSessionId: resumeSessionId,
        lastActivity: entry.lastActivity,
      });
    }
    this.slotScheduler.releaseActiveSlot(entry);
    void this.routeTeardown.shutdownHandler(entry.handler, reason);
    this.projection.dropLiveSession(chatId);
    this.projection.notifySessionState(chatId, "errored");
    this.config.log.warn(
      { chatId, reasonCode },
      "session fenced until a fresh runtime-session bind restores HTTP proof",
    );
    this.projection.recomputeRuntimeState();
    this.projection.persistRegistry();
    this.slotScheduler.drainPendingQueue();
  }

  private emitRuntimeFailureNoticeDeliveryFailure(chatId: string, err: unknown): void {
    try {
      this.config.onSessionEvent?.(chatId, {
        kind: "error",
        payload: {
          source: "runtime",
          message: `runtime failure notice delivery failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
    } catch (emitErr) {
      this.config.log.warn({ chatId, emitErr }, "runtime failure notice delivery error event emit failed");
    }
  }

  private async postPendingRuntimeFailureNotice(
    chatId: string,
    mutationLeaseValid: (() => boolean) | null = null,
  ): Promise<RuntimeFailureNoticePostResult> {
    const entry = this.projection.getSession(chatId);
    const payload = entry?.pendingRuntimeFailureNotice;
    if (!entry || !payload) return { kind: "posted" };

    try {
      await postProviderFailureRuntimeNotice(this.config.sdk, chatId, payload);
      if (mutationLeaseValid && !mutationLeaseValid()) return { kind: "posted" };
      if (this.projection.isSameSession(chatId, entry) && entry.pendingRuntimeFailureNotice === payload) {
        entry.pendingRuntimeFailureNotice = null;
      }
      return { kind: "posted" };
    } catch (err) {
      if (mutationLeaseValid && !mutationLeaseValid()) return { kind: "failed" };
      if (!this.projection.isSameSession(chatId, entry) || entry.pendingRuntimeFailureNotice !== payload) {
        return { kind: "failed" };
      }
      const noticeFailure = classifyProviderFailure(err, {
        provider: payload.provider,
        scope: payload.scope,
        source: "sdk",
      });
      if (noticeFailure.category === "runtime_transport") {
        this.config.log.warn(
          { chatId, err, reasonCode: noticeFailure.reasonCode },
          "runtime failure notice hit stale runtime-session proof; deferring to rebind",
        );
        return { kind: "runtime_session_proof", reasonCode: noticeFailure.reasonCode };
      }
      this.config.log.warn({ chatId, err, reasonCode: payload.reasonCode }, "runtime failure notice delivery failed");
      this.emitRuntimeFailureNoticeDeliveryFailure(chatId, err);
      return { kind: "failed" };
    }
  }

  private async recoverDebtBeforeResume(chatId: string, reason: string): Promise<boolean> {
    if (!this.inboxDelivery.hasRecoveryDebt(chatId)) return false;
    this.config.log.info({ chatId, reason }, "resume deferred because chat has recovery debt");
    await this.inboxDelivery.recoverIfNeeded(chatId, reason);
    this.projection.projectSessionRuntime(chatId);
    return true;
  }

  private failSessionForRecovery(chatId: string, reason: string, sessionId?: string): void {
    const entry = this.projection.getSession(chatId);
    if (!entry) return;

    this.routeTeardown.invalidateRouteTransition(entry, reason);
    this.slotScheduler.clearRetryState(entry);
    const resumeSessionId = resumableProviderSessionId(
      sessionId,
      entry.claudeSessionId,
      this.slotScheduler.resumeFallbackSessionId(entry),
    );
    if (resumeSessionId) {
      this.projection.recordEvictionResume(chatId, {
        claudeSessionId: resumeSessionId,
        lastActivity: entry.lastActivity,
      });
    }
    this.slotScheduler.releaseActiveSlot(entry);
    this.routeTeardown.detachHandlerWithPendingTeardown(chatId, entry.handler, reason);

    this.inboxDelivery.prepareEvict(chatId, reason);
    this.projection.dropLiveSession(chatId);
    this.projection.notifySessionState(chatId, "errored");
    this.config.log.warn({ chatId, reason }, "session failed locally; recovery will use a fresh handler");
    this.projection.recomputeRuntimeState();
    this.projection.persistRegistry();
    this.slotScheduler.drainPendingQueue();
  }

  private abortUnownedRoute(entry: SessionEntry, reason: string): void {
    const { chatId } = entry;
    if (!this.projection.isSameSession(chatId, entry)) return;
    this.config.log.warn({ chatId, reason }, "handler route completed after inbox custody was cleared");
    this.routeTeardown.invalidateRouteTransition(entry, reason);
    this.slotScheduler.releaseActiveSlot(entry);
    this.routeTeardown.detachHandlerWithPendingTeardown(chatId, entry.handler, reason);
    this.projection.dropLiveSession(chatId);
    this.projection.recomputeRuntimeState();
    this.projection.persistRegistry();
    this.slotScheduler.drainPendingQueue();
  }

  private errorCompletionRetryReason(outcome: TurnOutcome): string | null {
    if (outcome.status === "success") return null;
    if (outcome.completion === "consumed") return null;
    if (outcome.errorKind === "deterministic") return "complete_requires_terminal_rejected";
    if (outcome.errorKind === "transient") return "complete_transient_error_requires_retry";
    if (outcome.errorKind === "unknown") return "complete_unknown_error_requires_retry";
    return "complete_error_missing_classification";
  }

  private warnRejectedErrorCompletion(chatId: string, outcome: TurnOutcome, reason: string): void {
    if (outcome.status !== "error") return;
    this.config.log.warn(
      {
        chatId,
        errorKind: outcome.errorKind,
        completion: outcome.completion,
        reason,
      },
      "delivery error completion is not ACK-eligible; retrying instead",
    );
  }

  private async completeDeliveryTurn(
    chatId: string,
    messages: SessionMessage | readonly SessionMessage[],
    outcome: TurnOutcome,
    deliveryLeaseValid: (() => boolean) | null = null,
  ): Promise<DeliveryCompletionDisposition> {
    if (deliveryLeaseValid && !deliveryLeaseValid()) return "retry";
    if (
      outcome.status === "error" &&
      this.pendingRuntimeSessionProofFailure(chatId) &&
      (await this.holdDeliveryForRuntimeSessionProofRecovery(chatId, messages, undefined, deliveryLeaseValid))
    ) {
      // Held for bind recovery: server custody is deliberately retained
      // (unacked, no same-socket recovery), so report "retry" rather than
      // "settled" to the handler's completion bookkeeping.
      return "retry";
    }
    const retryReason = this.errorCompletionRetryReason(outcome);
    if (retryReason) {
      this.warnRejectedErrorCompletion(chatId, outcome, retryReason);
      this.retryDeliveryTurn(chatId, messages, retryReason);
      this.projection.projectSessionRuntime(chatId);
      return "retry";
    }
    if (outcome.status === "success") {
      this.clearPendingRuntimeFailureNotice(chatId);
    } else if (outcome.completion === "consumed") {
      const noticeResult = await this.postPendingRuntimeFailureNotice(chatId, deliveryLeaseValid);
      if (deliveryLeaseValid && !deliveryLeaseValid()) return "retry";
      if (noticeResult.kind === "runtime_session_proof") {
        const held = await this.holdDeliveryForRuntimeSessionProofRecovery(
          chatId,
          messages,
          noticeResult.reasonCode,
          deliveryLeaseValid,
        );
        if (held) return "retry";
        this.retryDeliveryTurn(chatId, messages, "runtime_session_proof_hold_failed");
        this.projection.projectSessionRuntime(chatId);
        return "retry";
      }
      if (noticeResult.kind === "failed") {
        this.retryDeliveryTurn(chatId, messages, "runtime_failure_notice_delivery_failed");
        this.projection.projectSessionRuntime(chatId);
        return "retry";
      }
    }
    if (deliveryLeaseValid && !deliveryLeaseValid()) return "retry";
    // The coordinator reports "settled" only once the concrete entries left
    // the ledger through a confirmed ACK; recovery debt, prefix gaps, and
    // ACK rejections keep custody and surface as "retry".
    const disposition = await this.inboxDelivery.finishTurn(chatId, messages, outcome);
    this.projection.projectSessionRuntime(chatId);
    return disposition;
  }

  private createDeliveryToken(
    chatId: string,
    lease:
      | (() => boolean)
      | {
          mutationValid: () => boolean;
          settlementValid: () => boolean;
        }
      | null = null,
  ): DeliveryToken {
    let terminalReported = false;
    const mutationValid = () => (typeof lease === "function" ? lease() : (lease?.mutationValid() ?? true));
    const settlementValid = () => (typeof lease === "function" ? lease() : (lease?.settlementValid() ?? true));
    const claimTerminal = (action: string): boolean => {
      if (!settlementValid()) {
        this.config.log.debug({ chatId, action }, "delivery token outcome ignored after route invalidation");
        return false;
      }
      if (!terminalReported) {
        terminalReported = true;
        return true;
      }
      this.config.log.warn({ chatId, action }, "delivery token terminal outcome ignored after prior outcome");
      return false;
    };
    return {
      processingStarted: (messages) => {
        // Processing-start is a route mutation — fenced by shuttingDown.
        if (terminalReported || !mutationValid()) return;
        this.inboxDelivery.markProcessingStarted(chatId, messages);
        this.projection.projectSessionRuntime(chatId);
        // Head membership proof: open live inject for same-chat tails that
        // arrived while start/resume still owns routeTransition (e.g. Pi
        // awaiting agent_settled). Pre-proof FIFO stays deferred until here.
        this.markRouteInjectReady(chatId);
      },
      complete: async (messages, outcome) => {
        if (!claimTerminal("complete")) return "retry";
        return await this.completeDeliveryTurn(chatId, messages, outcome, settlementValid);
      },
      retry: (messages, reason) => {
        if (!claimTerminal("retry")) return;
        this.retryDeliveryTurn(chatId, messages, reason);
        this.projection.projectSessionRuntime(chatId);
      },
      terminalRejected: async (messages, reason, evidence) => {
        if (!claimTerminal("terminalRejected")) return;
        if (
          this.pendingRuntimeSessionProofFailure(chatId) &&
          (await this.holdDeliveryForRuntimeSessionProofRecovery(chatId, messages, undefined, settlementValid))
        ) {
          return;
        }
        const noticeResult = await this.postPendingRuntimeFailureNotice(chatId, settlementValid);
        if (!settlementValid()) return;
        if (noticeResult.kind === "runtime_session_proof") {
          const held = await this.holdDeliveryForRuntimeSessionProofRecovery(
            chatId,
            messages,
            noticeResult.reasonCode,
            settlementValid,
          );
          if (held) return;
          this.retryDeliveryTurn(chatId, messages, "runtime_session_proof_hold_failed");
          this.projection.projectSessionRuntime(chatId);
          return;
        }
        if (noticeResult.kind === "failed") {
          this.retryDeliveryTurn(chatId, messages, "runtime_failure_notice_delivery_failed");
          this.projection.projectSessionRuntime(chatId);
          return;
        }
        await this.inboxDelivery.terminalRejected(chatId, messages, reason, evidence);
        this.projection.projectSessionRuntime(chatId);
      },
    };
  }

  private createDeliveryAttempt(
    chatId: string,
    leases: {
      mutationValid: () => boolean;
      settlementValid: () => boolean;
    },
  ): {
    token: DeliveryToken;
    cancel(): void;
  } {
    let active = true;
    // Attempt cancellation revokes both leases. Mutation stays adoption-gated;
    // settlement keeps the narrow operator-suspend / full-drain window so an
    // already-issued inject token can still post notice+ACK after the active
    // slot is released.
    return {
      token: this.createDeliveryToken(chatId, {
        mutationValid: () => active && leases.mutationValid(),
        settlementValid: () => active && leases.settlementValid(),
      }),
      cancel: () => {
        active = false;
      },
    };
  }

  private markRouteOwned(
    chatId: string,
    message: SessionMessage,
    receipt: HandlerRouteReceipt,
  ): DeliveryRouteOwnership {
    if (receipt.kind === "rejected") {
      this.config.log.warn(
        { chatId, messageId: message.id, entryId: message.inboxEntryId, reason: receipt.reason },
        "handler rejected inbox delivery before custody",
      );
      this.retryDeliveryTurn(chatId, message, `handler_rejected:${receipt.reason}`);
      return "lost";
    }
    if (message.inboxEntryId === undefined) return "owned";
    const ownership = this.inboxDelivery.markOwned({ chatId, messageId: message.id, entryId: message.inboxEntryId });
    if (ownership === "owned" && receipt.mode === "processing") {
      this.inboxDelivery.markProcessingStarted(chatId, message);
    }
    this.projection.projectSessionRuntime(chatId);
    return ownership;
  }

  private adoptResumeReceipt(
    entry: SessionEntry,
    message: SessionMessage | null | undefined,
    receipt: ReturnType<typeof normalizeResumeReceipt>,
    abortReason: string,
  ): boolean {
    if (message) {
      const ownership = this.markRouteOwned(entry.chatId, message, normalizeRouteReceipt(receipt.route ?? undefined));
      if (ownership === "lost") {
        this.abortUnownedRoute(entry, abortReason);
        return false;
      }
    }
    entry.claudeSessionId = receipt.sessionId;
    return true;
  }

  private async routeMessage(
    chatId: string,
    message: SessionMessage,
    deliveryKind: SlotDeliveryKind = "fresh",
  ): Promise<void> {
    if (this.shuttingDown) {
      this.retryDeliveryTurn(chatId, message, "manager_shutdown");
      return;
    }
    if (this.resetReplay.isProviderRouteAdmissionFenced(chatId)) {
      // Race path: admission was valid earlier in dispatch but the fence
      // landed before route. Park without same-socket recovery — same policy
      // as the admissionValid fence branch above.
      await this.resetReplay.parkDeliveryBehindResetAdmissionFence(chatId, message);
      return;
    }
    if (this.resetReplay.isChatReplayFenced(chatId)) {
      // A previous provider turn in this chat produced a non-read-only tool
      // effect before an interruption and never settled. Re-entering the
      // provider for the fenced head would replay that effect, and inbox ACK
      // is prefix-based, so the chat's entire FIFO tail must hold behind it:
      // every delivery stays unacknowledged recovery debt until an operator
      // resolves the fenced head. The ledger entry is marked fence-withheld
      // (no custody taken) so a later post-clear server redelivery is
      // re-admitted instead of deduplicated.
      this.config.log.error(
        { chatId, messageId: message.id },
        "withholding provider re-entry for replay-fenced chat; unsafe tool effect fenced before interruption",
      );
      this.config.onSessionRuntimeChange?.(chatId, "error");
      this.inboxDelivery.markReplayFenceWithheld(chatId, [message.id]);
      this.resetReplay.ensureReplayFenceReconcileLoop(chatId);
      return;
    }
    if (this.resetReplay.hasPostFenceRecoveryDebt(chatId)) {
      // A post-fence-clear recovery is in flight or being retried: hold
      // EVERY admission until one recovery is durably accepted. A
      // re-admitted duplicate only proves local withholding, never recovery
      // success, so it must not bypass the debt either — it is simply
      // re-marked and redelivered by the eventual accepted recovery.
      this.config.log.info(
        { chatId, messageId: message.id },
        "holding delivery while post-fence-clear recovery is pending",
      );
      this.inboxDelivery.markReplayFenceWithheld(chatId, [message.id]);
      return;
    }
    const existing = this.projection.getSession(chatId);

    // A terminal decision closes route admission before its durable event is
    // confirmed. New delivery waits for teardown instead of reviving the same
    // SessionEntry while its original transition still owns the active slot.
    if (existing?.status === "errored") {
      this.slotScheduler.queueForSlot(chatId, message, deliveryKind, "terminal_teardown_pending");
      return;
    }

    // Transient start/resume retries:
    // - Waiting/backoff (no live transition): keep the original head first and
    //   nudge the retry timer; do not open inject.
    // - Provider-entered retry transition (routeInjectReady): live-inject the
    //   same way as a first-attempt start/resume that still awaits settlement.
    //   retryAttempt stays nonzero until start/resume returns, so readiness
    //   must not be gated solely on that flag.
    if (
      existing &&
      this.slotScheduler.hasPendingTransientRetry(existing) &&
      !this.routeTeardown.hasInFlightTransition(existing)
    ) {
      this.slotScheduler.deferMessage(existing, message);
      this.slotScheduler.triggerImmediateRetry(chatId);
      return;
    }

    // An in-flight start/resume (including a winning retry attempt) keeps
    // routeTransition until the producer returns. Before the head proves
    // provider membership (processingStarted), same-chat tails stay
    // FIFO-deferred. After membership is proven, live inject is allowed even
    // while the producer still awaits settlement — required for providers
    // such as Pi whose start/resume await agent_settled.
    if (existing && this.routeTeardown.hasInFlightTransition(existing)) {
      if (this.routeTeardown.isRouteInjectReady(existing) && existing.status === "active") {
        this.injectIntoActiveRoute(existing, message);
        return;
      }
      this.slotScheduler.deferMessage(existing, message);
      return;
    }

    if (existing) {
      switch (existing.status) {
        case "active": {
          this.injectIntoActiveRoute(existing, message);
          return;
        }

        case "suspended":
        case "evicted":
          await this.resumeSession(existing, message, deliveryKind);
          return;
      }
    }

    // No existing session — create new
    await this.startNewSession(chatId, message, deliveryKind);
  }

  /** Resolve current source authority before every new/resumed provider route. */
  private async ensureContextTreeBinding(): Promise<ContextSourceAdmissionSnapshot> {
    const cfg = this.config.handlerConfig;
    const current = contextSourceFromHandlerConfig(cfg);

    if (this.config.resolveContextSource) {
      const source = await this.config.resolveContextSource();
      if (source.kind === "none" && current.kind !== "none") {
        throw new ManagedSkillsUnsafeDiscoveryError(
          "Current Context authority is unavailable; preserving the existing non-none projection and refusing provider admission",
        );
      }
      applyContextSourceToHandlerConfig(cfg, source);
      this.config.log.info(
        { kind: source.kind, path: source.kind === "none" ? null : source.path },
        "context source resolved lazily",
      );
      return captureContextSourceAdmission(source);
    }

    const resolve = this.config.resolveContextTreeBinding;
    if (!resolve) {
      if (current.kind === "none") return captureContextSourceAdmission(current);
      throw new ManagedSkillsUnsafeDiscoveryError(
        "No Context source resolver is available for this non-none provider admission",
      );
    }
    const binding = await resolve();
    if (!binding) {
      if (current.kind !== "none") {
        throw new ManagedSkillsUnsafeDiscoveryError(
          "Current Context binding could not be authorized; preserving the existing non-none projection",
        );
      }
      return captureContextSourceAdmission(current);
    }
    const source = captureContextSourceAdmission({
      kind: "remote",
      path: binding.path,
      repoUrl: binding.repoUrl,
      branch: binding.branch,
    });
    applyContextSourceToHandlerConfig(cfg, source.source);
    this.config.log.info(
      { path: binding.path, repoUrl: binding.repoUrl },
      "context tree binding resolved lazily (agent was unbound at slot start)",
    );
    return source;
  }

  private async startNewSession(
    chatId: string,
    message: SessionMessage,
    deliveryKind: SlotDeliveryKind,
  ): Promise<void> {
    const admissionGeneration = this.slotScheduler.currentAdmissionGeneration(chatId);
    const admissionStillValid = () => this.slotScheduler.currentAdmissionGeneration(chatId) === admissionGeneration;
    if (this.shuttingDown) {
      this.retryDeliveryTurn(chatId, message, "manager_shutdown");
      return;
    }
    // Route admission fence: settle this chat's teardown authority before a
    // new provider route may be created — otherwise the chat could run "old
    // handler never confirmed stopped + new route started". On failure the
    // throw routes into the caller's existing retryDeliveryTurn path, so the
    // delivery keeps its recovery custody.
    if (!(await this.routeTeardown.settleTeardownDebtBeforeRoute(chatId))) {
      throw new Error("route admission: teardown debt settle failed");
    }
    // The settle awaited: re-validate the fences — a terminate or manager
    // shutdown may have started meanwhile. A terminate owns the chat's
    // delivery state now (hold silently); a shutdown keeps the delivery in
    // retry custody.
    if (this.shuttingDown) {
      this.retryDeliveryTurn(chatId, message, "manager_shutdown");
      return;
    }
    // The settle awaited: a terminate may have started meanwhile — or a prior
    // Reset flush may have failed — either owns the chat's delivery state now,
    // so hold instead of installing a route.
    if (!admissionStillValid() || this.resetReplay.isProviderRouteAdmissionFenced(chatId)) return;
    // The settle also made the route selection stale: another path may have
    // created the session meanwhile. Re-dispatch through routeMessage's
    // selection instead of creating a duplicate entry (or overwriting one).
    if (this.projection.hasSession(chatId)) {
      await this.routeMessage(chatId, message, deliveryKind);
      return;
    }
    // Provider admission starts only after source authority is re-resolved.
    // Repeat the route CAS because the resolver may perform network I/O.
    const admission = await this.ensureContextTreeBinding();
    if (this.shuttingDown) {
      this.retryDeliveryTurn(chatId, message, "manager_shutdown_after_context_source");
      return;
    }
    if (!admissionStillValid() || this.resetReplay.isProviderRouteAdmissionFenced(chatId)) return;
    if (this.projection.hasSession(chatId)) {
      await this.routeMessage(chatId, message, deliveryKind);
      return;
    }
    // Enforce max_sessions before active-slot preemption so a full pool of
    // working sessions queues instead of first suspending a working victim.
    if (!this.slotScheduler.evictIfNeeded(chatId, message, deliveryKind)) return;

    // Enforce concurrency limit
    if (!this.slotScheduler.acquireActiveSlot(chatId, message, deliveryKind)) return;

    const handler = this.createHandler(admission);

    const entry: SessionEntry = {
      chatId,
      claudeSessionId: "",
      handler,
      handlerSourceKey: admission.sourceKey,
      status: "active",
      lastActivity: Date.now(),
      suspending: null,
      suspendError: null,
      handlerStoppedBySuspend: null,
      teardownError: null,
      pendingRuntimeFailureNotice: null,
    };

    const evicted = this.projection.activateLiveSession(entry);
    if (evicted) entry.claudeSessionId = evicted.claudeSessionId;
    this.slotScheduler.attachLiveSession(entry, { resumeFromEvicted: evicted });
    this.routeTeardown.attachLiveSession(entry);
    this.slotScheduler.claimActiveSlot(entry);
    const transition = this.routeTeardown.beginRouteTransition(entry, handler, evicted ? "resume" : "start");
    const mutationValid = () => this.routeTeardown.isRouteAdoptionValid(entry, transition);
    const settlementValid = () => this.routeTeardown.isDeliverySettlementLeaseValid(entry, transition);
    const routeLeases = { mutationValid, settlementValid };
    const ctx = this.buildSessionContext(chatId, routeLeases);

    // Report `active` before runtime projection. `session:runtime` frames are
    // active-gated on the server, so the state row must exist before a fresh
    // delivery projects this chat to working.
    this.projection.notifySessionState(chatId, "active");
    this.projection.projectSessionRuntime(chatId, { drainPendingOnIdle: false });
    // Settle callback for the route producer, assigned as the FIRST
    // statement inside the try below: a throw before registration leaves no
    // producer behind, and everything after registration is covered by the
    // finally — so no throw can leave a producer that never settles.
    let settleRouteProducer: () => void = () => {};
    try {
      // Track the route producer from here until it settles: a canceled
      // start can still materialize late, and terminate / manager shutdown
      // join this before they may ack/return (see routeProducers).
      settleRouteProducer = this.routeTeardown.registerRouteProducer(chatId);
      this.projection.setCurrentTrigger(chatId, message);
      const token = this.createDeliveryToken(chatId, routeLeases);
      if (evicted) {
        const receipt = normalizeResumeReceipt(await handler.resume(message, evicted.claudeSessionId, ctx, token));
        if (!this.routeTeardown.isCurrentRouteTransition(entry, transition)) {
          this.routeTeardown.discardStaleRouteTransition(
            entry.chatId,
            transition,
            "session_eviction_resume_stale_completion",
          );
          return;
        }
        if (!this.adoptResumeReceipt(entry, message, receipt, "session_eviction_resume_unowned_delivery")) return;
        this.config.log.info({ chatId, sessionId: entry.claudeSessionId }, "session resumed from eviction");
      } else {
        const receipt = normalizeStartReceipt(await handler.start(message, ctx, token));
        if (!this.routeTeardown.isCurrentRouteTransition(entry, transition)) {
          this.routeTeardown.discardStaleRouteTransition(entry.chatId, transition, "session_start_stale_completion");
          return;
        }
        entry.claudeSessionId = receipt.sessionId;
        if (this.markRouteOwned(chatId, message, receipt.route) === "lost") {
          this.abortUnownedRoute(entry, "session_start_unowned_delivery");
          return;
        }
        this.config.log.info({ chatId, sessionId: entry.claudeSessionId }, "session created");
      }
      if (!this.routeTeardown.completeRouteTransition(entry, transition)) {
        this.routeTeardown.discardStaleRouteTransition(entry.chatId, transition, "session_start_stale_adoption");
        return;
      }
      this.drainDeferredMessages(entry);
      this.projection.persistRegistry();
    } catch (err) {
      if (!this.routeTeardown.isCurrentRouteTransition(entry, transition)) {
        this.routeTeardown.discardStaleRouteTransition(entry.chatId, transition, "session_start_stale_failure");
        return;
      }
      this.routeTeardown.invalidateRouteTransition(entry, "session_start_failed");
      if (isContextSourceTransitionError(err)) {
        this.failSessionForRecovery(chatId, "session_context_source_changed", evicted?.claudeSessionId);
        return;
      }
      // A fenced strict slash command that failed the registry version
      // fence on the very first turn: consume its pending failure through
      // the SAME bounded fresh-handler recovery as an inject retry —
      // never the generic managed-skills indefinite backoff.
      if (isTeamSkillCommandUnavailableError(err) && message && this.consumeFenceFormatFailures(chatId, [message])) {
        return;
      }
      const phase: "start" | "resume" = evicted ? "resume" : "start";
      const classification = classifyProviderFailure(err, {
        provider: this.runtimeProvider(),
        scope: phase === "start" ? "session_start" : "session_resume",
        source: "session",
      });
      const handling = await this.handleSessionFailure({
        entry,
        err,
        phase,
        classification,
        attemptedMessage: message,
      });
      if (!this.projection.isSameSession(chatId, entry)) return;
      if (handling.kind === "terminal") await this.teardownTerminalSessionFailure(entry, message, handling);
    } finally {
      settleRouteProducer();
    }
  }

  private async resumeSession(
    entry: SessionEntry,
    message: SessionMessage | null | undefined,
    deliveryKind: SlotDeliveryKind = "fresh",
  ): Promise<void> {
    const admissionGeneration = this.slotScheduler.currentAdmissionGeneration(entry.chatId);
    const admissionStillValid = () =>
      this.slotScheduler.currentAdmissionGeneration(entry.chatId) === admissionGeneration;
    const stopForManagerShutdown = (reason: string): boolean => {
      if (!this.shuttingDown) return false;
      if (message) this.retryDeliveryTurn(entry.chatId, message, reason);
      return true;
    };
    if (stopForManagerShutdown("session_resume:manager_shutdown")) return;
    // Wait for in-flight suspension to complete before resuming
    if (entry.suspending) {
      await entry.suspending;
    }
    if (stopForManagerShutdown("session_resume:manager_shutdown_after_suspend")) return;
    if (!admissionStillValid() || !this.projection.isSameSession(entry.chatId, entry)) return;
    if (this.routeTeardown.isProviderAdmissionRestartRequired(entry.chatId)) {
      throw this.routeTeardown.quarantineRestartRequiredError(entry.chatId, "provider admission");
    }
    if (await this.recoverDebtBeforeResume(entry.chatId, "session_resume:recovery_debt")) return;
    if (stopForManagerShutdown("session_resume:manager_shutdown_after_recovery")) return;
    if (
      !admissionStillValid() ||
      !this.projection.isSameSession(entry.chatId, entry) ||
      (entry.status !== "suspended" && entry.status !== "evicted") ||
      this.slotScheduler.isActiveSlotHeld(entry) ||
      this.routeTeardown.hasInFlightTransition(entry)
    ) {
      return;
    }

    // Ordinary suspend failure still requires a confirmed strict stop before
    // replacement. A quarantined timeout has deliberately lost that join:
    // its exact handler/generation stays fenced by quarantinedSessions and the
    // route below installs a fresh handler without registering ordinary debt.
    if (entry.suspendError) {
      if (entry.handlerStoppedBySuspend !== entry.handler && !this.routeTeardown.isCurrentHandlerQuarantined(entry)) {
        await this.routeTeardown.shutdownHandler(entry.handler, "session_resume_after_failed_suspend", {
          observeFailure: true,
        });
        entry.handlerStoppedBySuspend = entry.handler;
        this.routeTeardown.retireHandler(entry.handler);
      }
      entry.suspendError = null;
    }

    // Route admission fence: settle this chat's teardown authority before
    // installing or reusing a handler — on failure the throw routes into the
    // caller's existing retryDeliveryTurn path, keeping recovery custody.
    if (!(await this.routeTeardown.settleTeardownDebtBeforeRoute(entry.chatId))) {
      throw new Error("route admission: teardown debt settle failed");
    }
    // The settle awaited: re-validate the entry, then the terminate fence —
    // a terminate in flight for this chat may share the very shutdown this
    // resume just joined, and installing a fresh handler now would let that
    // terminate drain the OLD debt and ack while the NEW handler is still
    // running. Abort instead; the route callers treat the failure with
    // resume's existing error semantics (the terminate clears admission and
    // pending delivery state on its own).
    if (!admissionStillValid() || !this.projection.isSameSession(entry.chatId, entry)) {
      // The entry was replaced while this resume waited — the new owner
      // routes the chat; keep the delivery in recovery custody.
      if (message) this.retryDeliveryTurn(entry.chatId, message, "resume_entry_replaced");
      return;
    }
    if (this.resetReplay.isProviderRouteAdmissionFenced(entry.chatId)) {
      throw new Error("session resume fenced: Reset retirement pending for chat");
    }
    // Full route-selection re-validation, acting as the CAS against
    // concurrent waiters: another dispatch may have won the route while
    // this resume awaited the settle. Its in-flight transition owns the
    // chat now — defer onto it (the winner drains deferredMessages) instead
    // of calling handler.resume twice. The checks below and the
    // beginRouteTransition install are synchronous, so exactly one waiter
    // can win.
    if (this.routeTeardown.hasInFlightTransition(entry)) {
      if (message) this.slotScheduler.deferMessage(entry, message);
      return;
    }
    if (this.slotScheduler.isActiveSlotHeld(entry) || (entry.status !== "suspended" && entry.status !== "evicted")) {
      if (message) this.retryDeliveryTurn(entry.chatId, message, "resume_selection_stale");
      return;
    }

    let admission = await this.ensureContextTreeBinding();
    if (!admissionStillValid() || !this.projection.isSameSession(entry.chatId, entry)) {
      if (message) this.retryDeliveryTurn(entry.chatId, message, "resume_context_source_cas_lost");
      return;
    }
    if (this.routeTeardown.hasInFlightTransition(entry)) {
      if (message) this.slotScheduler.deferMessage(entry, message);
      return;
    }
    if (this.slotScheduler.isActiveSlotHeld(entry) || (entry.status !== "suspended" && entry.status !== "evicted")) {
      if (message && (entry.status as SessionState) === "active" && this.slotScheduler.isActiveSlotHeld(entry)) {
        this.injectIntoActiveRoute(entry, message);
      } else if (message) {
        this.retryDeliveryTurn(entry.chatId, message, "resume_context_source_cas_lost");
      }
      return;
    }

    if (admission.sourceKey !== this.projection.handlerSourceKey(entry)) {
      try {
        await this.routeTeardown.retireHandlerForContextSourceChange(entry);
      } catch (error) {
        throw new ManagedSkillsUnsafeDiscoveryError(
          `Context source changed but the previous provider handler could not be retired: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      // Authority may have changed again while strict retirement awaited.
      admission = await this.ensureContextTreeBinding();
      if (!admissionStillValid() || !this.projection.isSameSession(entry.chatId, entry)) {
        if (message) this.retryDeliveryTurn(entry.chatId, message, "resume_source_retire_cas_lost");
        return;
      }
      if (this.routeTeardown.hasInFlightTransition(entry)) {
        if (message) this.slotScheduler.deferMessage(entry, message);
        return;
      }
      if (this.slotScheduler.isActiveSlotHeld(entry) || (entry.status !== "suspended" && entry.status !== "evicted")) {
        if (message && (entry.status as SessionState) === "active" && this.slotScheduler.isActiveSlotHeld(entry)) {
          this.injectIntoActiveRoute(entry, message);
        } else if (message) {
          this.retryDeliveryTurn(entry.chatId, message, "resume_source_retire_cas_lost");
        }
        return;
      }
    }

    // Admin-triggered resume has no provider input. It may use idle capacity,
    // but it must not preempt unrelated working turns.
    const slotKind: SlotDeliveryKind = message ? deliveryKind : "control";
    if (!this.slotScheduler.acquireActiveSlot(entry.chatId, message ?? null, slotKind)) return;
    if (stopForManagerShutdown("session_resume:manager_shutdown_after_slot")) return;

    const routeHandler = this.routeTeardown.handlerForRouteTransition(entry, () => this.createHandler(admission));
    this.projection.recordHandlerSource(entry, admission.sourceKey);
    entry.status = "active";
    this.slotScheduler.claimActiveSlot(entry);
    const transition = this.routeTeardown.beginRouteTransition(entry, routeHandler, "resume");
    const mutationValid = () => this.routeTeardown.isRouteAdoptionValid(entry, transition);
    const settlementValid = () => this.routeTeardown.isDeliverySettlementLeaseValid(entry, transition);
    const routeLeases = { mutationValid, settlementValid };
    const ctx = this.buildSessionContext(entry.chatId, routeLeases);
    entry.lastActivity = Date.now();

    this.projection.notifySessionState(entry.chatId, "active");
    this.projection.projectSessionRuntime(entry.chatId, { drainPendingOnIdle: false });
    // Settle callback for the route producer, assigned as the FIRST
    // statement inside the try below: a throw before registration leaves no
    // producer behind, and everything after registration is covered by the
    // finally — so no throw can leave a producer that never settles.
    let settleRouteProducer: () => void = () => {};
    try {
      // Track the route producer: a canceled resume can still materialize
      // late, and terminate / manager shutdown join this before ack/return.
      settleRouteProducer = this.routeTeardown.registerRouteProducer(entry.chatId);
      if (message) this.projection.setCurrentTrigger(entry.chatId, message);
      // Mirror the pattern in `startNewSession` (line 449): the handler may
      // return a DIFFERENT sessionId than the one passed in — e.g. when the
      // claude-code handler detects a stale SDK transcript and falls
      // through to fresh-start semantics — and `entry.claudeSessionId` has
      // to track the handler's truth or future resume cycles will keep
      // calling the stale id. PR #530 nit baixiaohang flagged: without the
      // assignment back, a fresh-start fallback would persist the OLD id,
      // and the next suspend→resume cycle would re-trigger the same
      // missing-transcript fallback ad infinitum.
      const token = message ? this.createDeliveryToken(entry.chatId, routeLeases) : undefined;
      const resumeResult = token
        ? await routeHandler.resume(message ?? undefined, entry.claudeSessionId, ctx, token)
        : await routeHandler.resume(message ?? undefined, entry.claudeSessionId, ctx);
      if (!this.routeTeardown.isCurrentRouteTransition(entry, transition)) {
        this.routeTeardown.discardStaleRouteTransition(entry.chatId, transition, "session_resume_stale_completion");
        return;
      }
      const receipt = normalizeResumeReceipt(resumeResult);
      if (!this.adoptResumeReceipt(entry, message, receipt, "session_resume_unowned_delivery")) return;
      if (!this.routeTeardown.completeRouteTransition(entry, transition)) {
        this.routeTeardown.discardStaleRouteTransition(entry.chatId, transition, "session_resume_stale_adoption");
        return;
      }
      this.drainDeferredMessages(entry);
      this.config.log.info({ chatId: entry.chatId, sessionId: entry.claudeSessionId }, "session resumed");
      this.projection.persistRegistry();
    } catch (err) {
      if (!this.routeTeardown.isCurrentRouteTransition(entry, transition)) {
        this.routeTeardown.discardStaleRouteTransition(entry.chatId, transition, "session_resume_stale_failure");
        return;
      }
      this.routeTeardown.invalidateRouteTransition(entry, "session_resume_failed");
      if (isContextSourceTransitionError(err)) {
        this.failSessionForRecovery(entry.chatId, "session_context_source_changed", entry.claudeSessionId);
        return;
      }
      // Same bounded fresh-handler recovery as the start path: a fenced
      // strict slash failing the resume's first format consumes its
      // pending failure here, never the generic indefinite backoff.
      if (
        isTeamSkillCommandUnavailableError(err) &&
        message &&
        this.consumeFenceFormatFailures(entry.chatId, [message])
      ) {
        return;
      }
      const classification = classifyProviderFailure(err, {
        provider: this.runtimeProvider(),
        scope: "session_resume",
        source: "session",
      });
      const handling = await this.handleSessionFailure({
        entry,
        err,
        phase: "resume",
        classification,
        attemptedMessage: message ?? null,
      });
      if (!this.projection.isSameSession(entry.chatId, entry)) return;
      if (handling.kind === "terminal") await this.teardownTerminalSessionFailure(entry, message ?? null, handling);
    } finally {
      settleRouteProducer();
    }
  }

  /**
   * Decide what to do when handler.start / handler.resume rejects. Returns
   * a retry disposition when the entry was kept with a timer armed, or a
   * terminal disposition when the caller should run permanent-failure
   * teardown. The terminal disposition also records whether the chat-visible
   * error event was emitted successfully; only that case is ACK-eligible.
   *
   * Bug 1 fix (client-resilience-design §5.1): transient errors keep the
   * entry around with an exponential-backoff retry. Permanent / degraded
   * errors fall through to the legacy F2 teardown path.
   */
  private async handleSessionFailure(args: {
    entry: SessionEntry;
    err: unknown;
    phase: "start" | "resume";
    classification: ProviderFailureClassification;
    attemptedMessage: SessionMessage | null;
  }): Promise<SessionFailureHandling> {
    const { entry, err, phase, classification, attemptedMessage } = args;
    const errMsg = err instanceof Error ? err.message : String(err);
    const chatId = entry.chatId;
    const provider = this.runtimeProvider();
    const scope = phase === "start" ? "session_start" : "session_resume";
    const nextAttempt = clampRetryAttempt(this.slotScheduler.currentRetryAttempt(entry) + 1);
    const decision = decideProviderRetry({
      classification,
      scope,
      attempt: nextAttempt,
      replaySafety: "pre_provider",
    });

    this.config.log.error(
      { chatId, err, phase, category: classification.category, reasonCode: classification.reasonCode },
      "session start/resume failed",
    );

    if (decision.action === "retry") {
      const delayMs = decision.delayMs;
      // Drop the active slot now so other chats can use it during the
      // backoff window — the retry will re-acquire when it runs.
      //
      // Note: we flip `entry.status` to "suspended" locally but DELIBERATELY
      // skip `notifySessionState(chatId, "suspended")` here. `runRetry` will
      // re-report `active` within `delayMs` (capped at 5min), and bouncing
      // the server-side state through `active → suspended → active` on every
      // transient blip would only generate UI churn (chat presence chip
      // flickering, server-side state-change events firing twice per retry)
      // without giving operators new information. The `resilience.session.
      // retry_scheduled` event emitted just below is the canonical signal
      // for "we're in the backoff window". Server-side `agent_chat_sessions.
      // state` therefore stays `active` for the entire retry window.
      this.slotScheduler.releaseActiveSlot(entry);
      entry.status = "suspended";
      this.projection.projectSessionRuntime(chatId);

      this.config.log.info(
        {
          chatId,
          attempt: decision.attempt,
          nextDelayMs: delayMs,
          reasonCode: decision.reasonCode,
          category: classification.category,
          phase,
          resilienceEvent: "provider_retry_scheduled",
        },
        "session transient failure — scheduling retry",
      );
      // Design §6.1: also emit through the SessionContext.emitEvent channel
      // so future server-side consumers see the signal. The closed kind-union
      // (sessionEventSchema) can't hold "resilience.session.retry_scheduled"
      // directly, so we encode it as a structured `error` event with the
      // resilience tag in the message prefix — see ResiliencePayload helper.
      try {
        const payload = buildProviderRetryEvent({
          event: "provider_retry_scheduled",
          provider,
          scope,
          classification,
          decision,
          messagePreview: errMsg,
        });
        this.emitSessionEvent(
          chatId,
          {
            kind: "error",
            payload: {
              source: "runtime",
              message: encodeProviderRetryEventMessage(payload),
            },
          },
          entry,
        );
      } catch (emitErr) {
        this.config.log.warn({ chatId, emitErr }, "resilience retry_scheduled emit failed");
      }

      this.slotScheduler.scheduleTransientRetry(entry, {
        attemptedMessage,
        attempt: decision.attempt,
        reasonCode: decision.reasonCode,
        category: classification.category,
        scope,
        // Truncate after redaction: err.message may echo credentials, and this
        // payload leaves the `safe in logs but NOT chat` boundary.
        rawError: errMsg ? redactErrorPreview(errMsg, 256) : null,
        delayMs,
      });
      return { kind: "retry" };
    }

    // Stop decision — legacy F2 teardown still owns ACK/recovery, but the
    // visible signal is now the standard provider retry payload.
    // Close retry admission before awaiting durable event confirmation. The
    // attempted message is already owned by the caller and deferred custody
    // remains on the entry for terminal teardown.
    this.slotScheduler.clearRetryAttemptState(entry);
    entry.status = "errored";
    this.projection.notifySessionState(chatId, "errored");
    this.projection.projectSessionRuntime(chatId);
    // Same `safe in logs but NOT chat` boundary as the transient `rawError`
    // path above: the error message can legitimately echo back a git remote
    // URL with embedded credentials or a token-bearing SDK request, and this
    // event is rendered into chat-visible UI. Redact before slicing — slicing
    // first risks leaving a partial-token tail across the truncation point.
    const preview = redactErrorPreview(errMsg, 800);
    const payload = buildProviderRetryEvent({
      event: decision.terminalKind === "exhausted" ? "provider_retry_exhausted" : "provider_failure_terminal",
      provider,
      scope,
      classification,
      decision,
      messagePreview: preview,
    });
    const terminalMutationGeneration = this.routeTeardown.captureGeneration(entry);
    const terminalMutationLeaseValid = () =>
      !this.shuttingDown &&
      this.projection.isSameSession(chatId, entry) &&
      this.routeTeardown.isGenerationCurrent(entry, terminalMutationGeneration) &&
      entry.status === "errored";
    const terminalEventPersisted = await this.emitConfirmedSessionEvent(
      chatId,
      {
        kind: "error",
        payload: {
          source: "runtime",
          message: encodeProviderRetryEventMessage(payload),
        },
      },
      entry,
      terminalMutationLeaseValid,
    );
    return { kind: "terminal", reasonCode: decision.reasonCode, terminalEventPersisted };
  }

  private async emitConfirmedSessionEvent(
    chatId: string,
    event: SessionEvent,
    expectedEntry: SessionEntry | null = null,
    mutationLeaseValid: (() => boolean) | null = null,
  ): Promise<boolean> {
    const captureLeaseValid = () =>
      (!expectedEntry || this.projection.isSameSession(chatId, expectedEntry)) &&
      (!mutationLeaseValid || mutationLeaseValid());
    if (this.config.confirmSessionEvent) {
      try {
        await this.config.confirmSessionEvent(chatId, event);
        if (!captureLeaseValid()) return false;
        return this.captureRuntimeFailureNotice(chatId, event, captureLeaseValid, expectedEntry);
      } catch (emitErr) {
        this.config.log.warn({ chatId, emitErr }, "confirmed session event emit failed");
        return false;
      }
    }
    try {
      this.config.onSessionEvent?.(chatId, event);
      this.captureRuntimeFailureNotice(chatId, event, captureLeaseValid, expectedEntry);
    } catch (emitErr) {
      this.config.log.warn({ chatId, emitErr }, "session error event emit failed");
    }
    return false;
  }

  private async teardownTerminalSessionFailure(
    entry: SessionEntry,
    message: SessionMessage | null | undefined,
    handling: Extract<SessionFailureHandling, { kind: "terminal" }>,
  ): Promise<void> {
    const chatId = entry.chatId;
    if (!this.projection.isSameSession(chatId, entry)) return;
    this.routeTeardown.invalidateRouteTransition(entry, "session_terminal_failure");
    const hasDeferredTail = this.slotScheduler.hasDeferredMessages(entry);
    const hasRecoveryDebt = this.inboxDelivery.hasRecoveryDebt(chatId);
    this.slotScheduler.clearRetryState(entry);
    if (handling.terminalEventPersisted && message && !hasRecoveryDebt) {
      await this.completeDeliveryTurn(chatId, message, {
        status: "error",
        terminal: true,
        completion: "consumed",
        reason: `session_failure_terminal:${handling.reasonCode}`,
      });
      if (!this.projection.isSameSession(chatId, entry)) return;
      if (hasDeferredTail || this.inboxDelivery.hasRecoveryDebt(chatId)) {
        await this.inboxDelivery.drainForTerminate(chatId);
      }
    } else {
      await this.inboxDelivery.drainForTerminate(chatId);
    }

    if (!this.projection.isSameSession(chatId, entry)) return;
    // Terminal cleanup previously left the handler's stop unconfirmed
    // (register-only debt that lingered until a terminate). Register-then-
    // shutdown instead: the debt mirrors the real shutdown timeline — a
    // confirmed stop drops it immediately, a failure keeps it retryable.
    this.routeTeardown.detachHandlerWithPendingTeardown(chatId, entry.handler, "session_terminal_failure");
    this.projection.dropLiveSession(chatId);
    this.projection.recomputeRuntimeState();
    this.slotScheduler.releaseActiveSlot(entry);
    // Converge the registry like every other sessions.delete path: the
    // resumable mapping for this chat must not linger on disk. This
    // debounced write is hygiene only — a Reset terminate still carries its
    // own synchronous crash boundary (flushTerminateRegistry).
    this.projection.persistRegistry();
    this.slotScheduler.drainPendingQueue();
  }

  /**
   * Open live inject for an in-flight start/resume once the head delivery
   * token reports processingStarted. Drain any FIFO tail that arrived before
   * this proof while the route producer may still be awaiting settlement.
   */
  private markRouteInjectReady(chatId: string): void {
    const entry = this.projection.getSession(chatId);
    if (!entry) return;
    if (!this.routeTeardown.markRouteInjectReady(entry)) return;
    this.drainDeferredMessages(entry);
  }

  private injectIntoActiveRoute(entry: SessionEntry, message: SessionMessage): void {
    const chatId = entry.chatId;
    const routeLease = this.routeTeardown.currentRouteLease(entry);
    const mutationValid = () => this.routeTeardown.isRouteAdoptionValid(entry, routeLease);
    const settlementValid = () => this.routeTeardown.isDeliverySettlementLeaseValid(entry, routeLease);
    if (!mutationValid()) {
      this.retryDeliveryTurn(chatId, message, "active_inject_route_invalidated");
      return;
    }
    this.projection.setCurrentTrigger(chatId, message);
    const attempt = this.createDeliveryAttempt(chatId, { mutationValid, settlementValid });
    let receipt: HandlerRouteReceipt;
    try {
      receipt = normalizeRouteReceipt(routeLease.handler.inject(message, attempt.token));
    } catch (err) {
      attempt.cancel();
      throw err;
    }
    if (!mutationValid()) {
      attempt.cancel();
      this.retryDeliveryTurn(chatId, message, "active_inject_route_invalidated");
      return;
    }
    if (receipt.kind === "rejected") attempt.cancel();
    const ownership = this.markRouteOwned(chatId, message, receipt);
    if (ownership !== "owned") attempt.cancel();
    if (ownership === "lost") {
      return;
    }
    entry.lastActivity = Date.now();
    this.projection.projectSessionRuntime(chatId);
    this.config.log.debug({ chatId }, "message injected");
  }

  private drainDeferredMessages(entry: SessionEntry): void {
    const queued = this.slotScheduler.takeDeferredMessages(entry);
    if (queued.length === 0) return;

    const routeLease = this.routeTeardown.currentRouteLease(entry);
    const mutationValid = () => this.routeTeardown.isRouteAdoptionValid(entry, routeLease);
    const settlementValid = () => this.routeTeardown.isDeliverySettlementLeaseValid(entry, routeLease);
    for (let index = 0; index < queued.length; index++) {
      const message = queued[index];
      if (!message) continue;
      if (!mutationValid() || this.inboxDelivery.hasRecoveryDebt(entry.chatId)) {
        this.retryDeliveryTurn(entry.chatId, queued.slice(index), "deferred_inject_recovery_pending");
        break;
      }
      this.projection.setCurrentTrigger(entry.chatId, message);
      const attempt = this.createDeliveryAttempt(entry.chatId, { mutationValid, settlementValid });
      try {
        const receipt = normalizeRouteReceipt(routeLease.handler.inject(message, attempt.token));
        if (!mutationValid()) {
          attempt.cancel();
          this.retryDeliveryTurn(entry.chatId, queued.slice(index), "deferred_inject_route_invalidated");
          break;
        }
        if (receipt.kind === "rejected") attempt.cancel();
        const ownership = this.markRouteOwned(entry.chatId, message, receipt);
        if (ownership !== "owned") attempt.cancel();
        if (ownership === "lost") {
          this.retryDeliveryTurn(entry.chatId, queued.slice(index), "deferred_inject_custody_lost");
          break;
        }
        entry.lastActivity = Date.now();
      } catch (err) {
        attempt.cancel();
        this.config.log.warn({ chatId: entry.chatId, messageId: message.id, err }, "retry queued inject failed");
        this.retryDeliveryTurn(entry.chatId, queued.slice(index), "retry_queued_inject_failed");
        break;
      }
    }
    this.projection.projectSessionRuntime(entry.chatId);
  }

  /**
   * Try to acquire an active slot. If at concurrency limit:
   * 1. Suspend the least-recently-active idle session to free a slot.
   * 2. For fresh external input only, preempt the least-recently-active
   *    working session as a last resort and force recovery for its work.
   * 3. Queue recovery/internal traffic instead of displacing working sessions.
   *
   * Returns true if a slot is acquired and false if it remains unavailable.
   * Callers normally enqueue on failure; retry-scoped callers can opt out so
   * their timer/head state remains the single waiting source. The in-flight entryId
   * is tracked separately in `InboxDeliveryCoordinator` (populated at dispatch),
   * so the queue doesn't carry inbox metadata.
   */
  private emitResilienceEvent(chatId: string, eventName: string, payload: Record<string, unknown>): void {
    try {
      this.config.onSessionEvent?.(chatId, {
        kind: "error",
        payload: {
          source: "runtime",
          message: encodeResilienceMessage(eventName, payload),
        },
      });
    } catch (err) {
      this.config.log.warn({ chatId, eventName, err }, "resilience event emit failed");
    }
  }

  private suspendSession(
    entry: SessionEntry,
    opts: { reason: string; ackConsumedPrefix: boolean; drainQueue?: boolean; operatorResolution?: boolean } = {
      reason: "session_suspended",
      ackConsumedPrefix: true,
      drainQueue: true,
    },
  ): void {
    // A new suspend supersedes any earlier suspend outcome.
    entry.suspendError = null;
    entry.handlerStoppedBySuspend = null;

    if (opts.operatorResolution) {
      // Manual operator suspend is a resolution boundary for the contiguous
      // provider-entered prefix. Fence in-flight start/resume *adoption*
      // immediately by clearing the route pointer, but keep
      // routeTransitionGeneration stable through settle so already-issued
      // DeliveryTokens can still post notice+ACK. Bump + retire only after.
      // Do not re-bump delivery admission here — handleCommand already did.
      const capture = this.routeTeardown.beginOperatorSuspendTransition(entry);
      if (capture.unestablishedStart) {
        this.slotScheduler.clearRetryState(entry);
      } else if (capture.inFlightTransition) {
        this.slotScheduler.clearDeferredMessages(entry);
      }
      const inFlightTransition = capture.inFlightTransition;
      const unestablishedStart = capture.unestablishedStart;
      entry.status = "suspended";
      this.slotScheduler.releaseActiveSlot(entry);
      this.projection.clearActiveRuntimeProjection(entry.chatId);
      entry.suspending = (async () => {
        let settled = false;
        let timedOut = false;
        try {
          // settleProviderEntered keeps already-issued DeliveryTokens on the
          // settlement lease (including active/deferred inject) so they can
          // post durable notice+ACK before prepareOperatorSuspend runs.
          await waitForHandlerSuspend(entry.chatId, () =>
            entry.handler.suspend(opts.reason, { settleProviderEntered: true }),
          );
          settled = true;
        } catch (err) {
          entry.suspendError = { error: err };
          timedOut = err instanceof HandlerSuspendTimeoutError;
          if (timedOut) this.routeTeardown.quarantineTimedOutSuspend(entry, inFlightTransition);
          try {
            this.config.log.warn({ chatId: entry.chatId, err }, "operator suspend settlement error");
          } catch (logErr) {
            this.config.log.warn({ chatId: entry.chatId, err: logErr }, "operator suspend settlement error");
          }
        }

        // Suspend may emit a terminal provider-failure event and then either
        // settle or lose its completion callback. Transfer that durable-notice
        // obligation before invalidating the generation and before
        // prepareOperatorSuspend can promote the provider-entered prefix to
        // ACK-eligible terminal work.
        if ((settled || timedOut) && entry.pendingRuntimeFailureNotice) {
          this.inboxDelivery.markNoticeRequiredForProcessingPrefix(entry.chatId, entry.pendingRuntimeFailureNotice);
        }

        // Bump adoption generation only after settle. Kick observeFailure
        // teardown before awaiting prepare so a gated prepare still leaves an
        // in-flight shutdown that strict terminate can join (main #2125).
        this.routeTeardown.completeOperatorSuspendAdoptionFence(entry);
        const target = inFlightTransition?.handler ?? entry.handler;
        if (inFlightTransition) {
          this.routeTeardown.retireHandler(inFlightTransition.handler);
        }

        if (!settled && !timedOut) {
          entry.suspending = null;
          if (unestablishedStart) {
            if (entry.handlerStoppedBySuspend !== entry.handler) {
              this.routeTeardown.registerPendingTeardown(entry.chatId, entry.handler);
            }
            this.projection.dropLiveSessionIfCurrent(entry.chatId, entry);
          }
          return;
        }

        const stopPromise =
          settled && (inFlightTransition || !this.routeTeardown.isHandlerRetired(entry.handler))
            ? this.routeTeardown.shutdownHandler(target, opts.reason, { observeFailure: true })
            : Promise.resolve();

        try {
          // Yield once so an already-scheduled teardown can enter (and, for
          // instantaneous mocks, finish) before prepare publishes recovery
          // debt. Late route materialization then afterPrior-chains a second
          // stop instead of racing the first (main invalidate-at-entry timing).
          await Promise.resolve();
          await this.inboxDelivery.prepareOperatorSuspend(entry.chatId);
          await stopPromise;
          if (settled && target === entry.handler) {
            entry.handlerStoppedBySuspend = entry.handler;
          }
        } catch (err) {
          entry.suspendError = { error: err };
          try {
            this.config.log.warn({ chatId: entry.chatId, err }, "operator suspend teardown error");
          } catch (logErr) {
            this.config.log.warn({ chatId: entry.chatId, err: logErr }, "operator suspend teardown error");
          }
        }

        entry.suspending = null;
        if (unestablishedStart) {
          if (entry.handlerStoppedBySuspend !== entry.handler) {
            this.routeTeardown.registerPendingTeardown(entry.chatId, entry.handler);
          }
          this.projection.dropLiveSessionIfCurrent(entry.chatId, entry);
        }
      })();
      this.projection.persistRegistry();
      this.projection.notifySessionState(entry.chatId, "suspended");
      if (opts.drainQueue !== false) this.slotScheduler.drainPendingQueue();
      return;
    }

    const canceledTransition = this.routeTeardown.invalidateRouteTransition(entry, opts.reason);
    // A canceled fresh start has never established a provider-neutral resume
    // handle. Keeping that entry as "suspended" would make redelivery call
    // resume(undefined/empty-id) instead of starting a replacement route.
    // Drop only the local SessionEntry; coordinator recovery retains the head.
    const canceledUnestablishedStart = canceledTransition?.phase === "start";
    if (canceledUnestablishedStart) this.slotScheduler.clearRetryState(entry);
    else if (canceledTransition) this.slotScheduler.clearDeferredMessages(entry);
    const prepare = opts.ackConsumedPrefix
      ? this.inboxDelivery.prepareSuspend(entry.chatId, opts.reason)
      : Promise.resolve(this.inboxDelivery.prepareEvict(entry.chatId, opts.reason));
    entry.status = "suspended";
    this.slotScheduler.releaseActiveSlot(entry);
    this.projection.clearActiveRuntimeProjection(entry.chatId);
    entry.suspending = prepare
      .then(async () => {
        if (canceledTransition || this.routeTeardown.isHandlerRetired(entry.handler)) {
          // The suspend boundary must cover this teardown end-to-end:
          // returning (not void-ing) the shutdown keeps `entry.suspending`
          // in flight until the handler is confirmed stopped, and the
          // observeFailure face routes a shutdown rejection into the catch
          // below (recorded as suspendError) where a Reset terminate can see
          // it. Only a CONFIRMED stop arms the no-double-teardown marker,
          // bound to the handler identity so a later handler replacement
          // cannot inherit it.
          const target = canceledTransition?.handler ?? entry.handler;
          await this.routeTeardown.shutdownHandler(target, opts.reason, { observeFailure: true });
          if (target === entry.handler) entry.handlerStoppedBySuspend = entry.handler;
          return;
        }
        return entry.handler.suspend(opts.reason);
      })
      .catch((err) => {
        // `suspending` keeps its legacy resolve-always contract for
        // dispatch/resume awaiters, but a terminate joining this suspend
        // must still observe the failure — record it (boxed: rejections can
        // be falsey) on the entry so the Reset apply can reject instead of
        // acking over a handler that was never confirmed suspended/stopped.
        entry.suspendError = { error: err };
        try {
          this.config.log.warn({ chatId: entry.chatId, err }, "suspend preparation error");
        } catch (logErr) {
          // Second-stage warn must not reject the suspending promise if the
          // logger transport itself throws.
          this.config.log.warn({ chatId: entry.chatId, err: logErr }, "suspend error");
        }
      })
      .then(() => undefined)
      .catch((err) => {
        try {
          this.config.log.warn({ chatId: entry.chatId, err }, "suspend error");
        } catch (logErr) {
          this.config.log.warn({ chatId: entry.chatId, err: logErr }, "suspend error");
        }
      })
      .finally(() => {
        entry.suspending = null;
        // Keep the unestablished entry addressable until preparation settles:
        // dispatch() uses its suspending promise as the same-chat admission
        // fence while operator ACK/recovery decisions are still in flight.
        if (canceledUnestablishedStart) {
          // Debt registration must NOT depend on the entry still being
          // installed: even if another path already removed it (its own
          // detach registers too — Set semantics make a duplicate a no-op),
          // an unconfirmed-stop handler must stay joinable.
          if (entry.handlerStoppedBySuspend !== entry.handler) {
            this.routeTeardown.registerPendingTeardown(entry.chatId, entry.handler);
          }
          this.projection.dropLiveSessionIfCurrent(entry.chatId, entry);
        }
      });
    this.projection.persistRegistry();
    this.projection.notifySessionState(entry.chatId, "suspended");

    if (opts.drainQueue !== false) this.slotScheduler.drainPendingQueue();
  }

  private buildSessionContext(
    chatId: string,
    lease:
      | (() => boolean)
      | {
          /** Fenced by shuttingDown — route/session/registry mutations. */
          mutationValid: () => boolean;
          /** Ignores shuttingDown — terminal notice capture + finish/retry only. */
          settlementValid: () => boolean;
        }
      | null = null,
  ): SessionContext {
    const mutationValid = typeof lease === "function" ? lease : (lease?.mutationValid ?? null);
    const settlementValid =
      typeof lease === "function" ? lease : (lease?.settlementValid ?? lease?.mutationValid ?? null);
    const sessionLog = this.config.log.child({ chatId });
    const currentSdk = () => this.config.sdk;
    // Runtime-facing string log (handler + result-sink expect a simple
    // `(msg: string) => void` signature). The child pino logger still goes
    // to other places that want structured fields.
    const log = (msg: string) => sessionLog.info(msg);

    // One participant cache per session — consumed by formatInboundContent
    // (for resolving `[From: <name>]`). First use triggers a fetch; subsequent
    // calls hit memory. v1 §四 改造 4 removed result-sink's dependency on
    // this cache (the trigger-sender mention branch is gone), so the cache
    // now flows only into the inbound-formatter path.
    const participants = createParticipantCache(currentSdk, chatId, log);

    // Cross-agent doc preview: `workspaceRoot` is `<workspaces>/<agentSlug>`
    // (see agent-slot.ts), so the shared common root is its parent and this
    // agent's slug is its basename — derived from existing config, no new
    // config surface (decision: config-ascent).
    const workspacesRoot = dirname(this.config.handlerConfig.workspaceRoot);
    const selfSlug = basename(this.config.handlerConfig.workspaceRoot);
    // Resolve the self-fence SYNCHRONOUSLY from the already-populated config
    // cache so it can ride the agent's env (`buildAgentEnv` is sync). This
    // lets a `<binName> chat send` sub-process snapshot referenced docs. (The
    // result-sink's own doc-capture was retired with the final-text mirror, so
    // this snapshot path now serves the CLI `chat send` sub-process only.) The
    // legacy `base` env var (`FIRST_TREE_DOC_BASE`) is
    // kept emitting the OLD source-repo-top semantics so a stale pre-fix
    // `chat send` binary inherited from this process still snapshots like it
    // used to — see `agent-io.ts` for the wire-compat plumbing.
    const workspaceRoot = this.config.handlerConfig.workspaceRoot;
    const sessionRoot = resolveSessionDocRoot(workspaceRoot, chatId);
    const cachedPayload = this.config.agentConfigCache?.get(this.config.agentIdentity.agentId)?.payload ?? null;
    const selfFence = selfFenceFromRuntimeConfig(cachedPayload, sessionRoot, workspaceRoot);
    const docBase = cachedPayload
      ? documentBasePathFromRuntimeConfig(cachedPayload, sessionRoot, workspaceRoot)
      : sessionRoot;

    // Team Skill slash-command registry (base slug → ready/unavailable
    // target) plus the resource-config version the registry proves. This
    // pair is an ATOMIC PER-HANDLER SNAPSHOT: a publication replaces it on
    // this context only, and a fresh handler can never mutate the registry
    // an old (possibly still draining) handler resolves commands against.
    // `registry: null` means UNPUBLISHED/UNKNOWN (distinct from a
    // verified-empty registry): the rewrite boundary blocks strict slash
    // commands until preparation publishes. Applying it here — inside the
    // SessionContext's formatInboundContent — covers every provider's
    // start/resume/inject path at one shared boundary, because all of them
    // render user text through this method.
    let teamSkillCommands: { registry: TeamSkillCommandRegistry | null; version: number | null } = {
      registry: null,
      version: null,
    };

    const forwardResult = createResultSink({
      clearTrigger: () => {
        this.projection.clearCurrentTrigger(chatId);
      },
      log,
    });

    const envCtx = {
      sdk: {
        get serverUrl() {
          return currentSdk().serverUrl;
        },
        get runtimeSessionToken() {
          return currentSdk().runtimeSessionToken;
        },
      },
      agent: this.config.agentIdentity,
      chatId,
      clientId: typeof this.config.handlerConfig.clientId === "string" ? this.config.handlerConfig.clientId : undefined,
      runtimeSessionTokenFile: this.config.runtimeSessionTokenFile,
      provider:
        typeof this.config.handlerConfig.runtimeProvider === "string"
          ? this.config.handlerConfig.runtimeProvider
          : undefined,
      log,
      docContext: {
        base: docBase,
        agentHome: selfFence.agentHome,
        singleRepoLocalPath: selfFence.singleRepoLocalPath,
        workspacesRoot,
        selfSlug,
      },
    };

    return {
      agent: this.config.agentIdentity,
      get sdk() {
        return currentSdk();
      },
      log,
      chatId,
      freshStartNonce: () => this.projection.getFreshStartNonce(chatId),
      recordProviderActivity: () => {
        if (mutationValid && !mutationValid()) return;
        const entry = this.projection.getSession(chatId);
        if (entry && entry.status === "active") {
          entry.lastActivity = Date.now();
        }
      },
      emitEvent: (event) => {
        // During graceful drain, only structured terminal provider-failure events
        // may cross the settlement lease (durable notice capture). All other
        // session-context events stay behind the shuttingDown adoption fence.
        if (isTerminalProviderFailureSessionEvent(event)) {
          if (settlementValid && !settlementValid()) return;
          this.config.onSessionEvent?.(chatId, event);
          if (settlementValid && !settlementValid()) return;
          this.captureRuntimeFailureNotice(chatId, event, settlementValid);
          return;
        }
        if (mutationValid && !mutationValid()) return;
        this.noteTurnLivenessFromEvent(chatId, event);
        this.config.onSessionEvent?.(chatId, event);
        if (mutationValid && !mutationValid()) return;
        this.captureRuntimeFailureNotice(chatId, event, mutationValid);
      },
      emitEventConfirmed: (event) => {
        if (mutationValid && !mutationValid()) {
          return Promise.reject(new Error("route transition invalidated"));
        }
        // `turn_end` also reaches the server through this confirmed channel
        // (the Codex landing trial awaits it), so turn liveness must clear
        // here too or that turn would stay `working` until the session is
        // suspended.
        this.noteTurnLivenessFromEvent(chatId, event);
        return this.confirmSessionEventOrThrow(chatId, event, mutationValid);
      },
      forwardResult: (text) => {
        if (mutationValid && !mutationValid()) return Promise.resolve();
        return forwardResult(text);
      },
      markMessagesConsumed: (messages) => {
        if (mutationValid && !mutationValid()) return;
        this.inboxDelivery.markProcessingStarted(chatId, messages);
      },
      finishTurn: (messages, outcome) => {
        // SessionContext finish/retry stay behind the adoption fence. Already-issued
        // DeliveryTokens carry the settlement lease for drain notice+ACK.
        if (mutationValid && !mutationValid()) return Promise.resolve();
        // Markers are reclaimed only at ACK commit (onDeliveriesCommitted),
        // never here — an ACK failure must not mint a second recovery.
        return this.completeDeliveryTurn(chatId, messages, outcome, mutationValid);
      },
      retryTurn: (messages, reason) => {
        if (mutationValid && !mutationValid()) return;
        this.retryDeliveryTurn(chatId, messages, reason);
        this.projection.projectSessionRuntime(chatId);
      },
      hasPendingDelivery: (messages) => {
        const batch = Array.isArray(messages) ? messages : [messages];
        return batch.some(
          (message) =>
            message.inboxEntryId !== undefined &&
            this.inboxDelivery.hasEntry({
              chatId,
              entryId: message.inboxEntryId,
              messageId: message.id,
            }),
        );
      },
      failSessionForRecovery: (reason, sessionId) => {
        if (mutationValid && !mutationValid()) return;
        this.failSessionForRecovery(chatId, reason, sessionId);
      },
      replaceSessionId: (sessionId, reason) => {
        if (mutationValid && !mutationValid()) return;
        const entry = this.projection.getSession(chatId);
        if (!entry) return;
        const previousSessionId = entry.claudeSessionId;
        entry.claudeSessionId = sessionId;
        entry.lastActivity = Date.now();
        this.config.log.info({ chatId, previousSessionId, sessionId, reason }, "session id replaced by handler");
        this.projection.persistRegistry();
      },
      buildAgentEnv: (parentEnv) => buildAgentEnv(parentEnv, envCtx),
      publishTeamSkillCommands: (commands, provenVersion) => {
        // `null` commands = unknown/unpublished: strict slash commands fail
        // closed until a proven registry lands. A list replaces the
        // registry atomically as a whole, stamped with the config version
        // the publication proves — ON THIS HANDLER'S SNAPSHOT ONLY. A null
        // registry can never prove a version, so a caller passing one is
        // coerced (and told): registry null + matching version would skip
        // the mismatch park path and silently throw.
        if (commands === null && provenVersion !== null) {
          log(
            "publishTeamSkillCommands called with null commands but a non-null version — forcing version to null (an empty registry proves nothing)",
          );
        }
        teamSkillCommands = {
          registry: commands === null ? null : buildTeamSkillCommandRegistry(commands, log),
          version: commands === null ? null : provenVersion,
        };
      },
      formatInboundContent: async (message) => {
        // Team Skill marker scoping: ONLY a message whose metadata carries
        // the server-owned invocation marker KEY may touch the Team
        // registry, fences, notices, or recovery machinery at all. A truly
        // unmarked message — hand-typed local/runtime slash included, even
        // one whose literal matches a Team row — keeps its original
        // local/runtime semantics byte-for-byte and never triggers a Team
        // retry or recovery.
        if (!hasTeamSkillInvocationMarker(message.metadata)) {
          this.clearFenceRecoveryAttempt(chatId, message.id);
          this.clearPendingFenceFormatFailure(chatId, message.id);
          return formatInboundContent(message, participants);
        }
        const { registry, version } = teamSkillCommands;
        const stamp = message.configVersion;
        // Version fence, direction-aware. A strict slash command is only
        // as trustworthy as the registry's proven config version;
        // synthetic messages without a stamp skip the fence entirely.
        const versionMismatched = stamp !== undefined && version !== stamp;
        const fencedRegistry = versionMismatched ? null : registry;
        const mentionGate = { allowMentionPrefix: messageMentionsAgent(message, this.config.agentIdentity.agentId) };
        // Multi-recipient ambiguity: a slash addressed to several routed
        // agents would be resolved per-recipient — and an unknown base
        // would fall through to each agent's local Skill. No agent may
        // execute it; bare and mention-prefixed forms, text and image
        // captions alike. Ordinary text passes through untouched.
        const routedMentions = message.metadata?.mentions;
        if (Array.isArray(routedMentions) && new Set(routedMentions).size > 1) {
          const ambiguous = rewriteSessionMessageCommandToNotice(
            message,
            TEAM_SKILL_COMMAND_AMBIGUOUS_RECIPIENT_NOTICE,
            mentionGate,
          );
          if (ambiguous !== message) {
            return formatInboundContent(ambiguous, participants);
          }
        }
        if (stamp !== undefined && version !== null && stamp < version) {
          // STALE message: the config it was sent against has been
          // superseded. Recovery can never republish a historical
          // registry, so restart would loop forever — settle with an inert
          // notice immediately, no recovery at all.
          return formatInboundContent(
            rewriteSessionMessageCommandToNotice(message, TEAM_SKILL_COMMAND_STALE_VERSION_NOTICE, mentionGate),
            participants,
          );
        }
        // Bounded terminal boundary: this exact message already consumed
        // its one fresh-handler recovery (a runtime-level, per-message
        // attempt marker survives the restart), and the fresh preparation
        // — which always runs before this format in production — still did
        // not make the message resolvable. Settle with an inert notice
        // instead of looping recovery forever.
        if (versionMismatched && this.hasFenceRecoveryAttempt(chatId, message.id)) {
          // The marker stays until the ACK commit proves settlement — an
          // ACK failure or redelivery must not mint a second recovery.
          return formatInboundContent(
            rewriteSessionMessageCommandToNotice(message, TEAM_SKILL_COMMAND_UNRESOLVED_NOTICE, mentionGate),
            participants,
          );
        }
        // Unstamped (synthetic/legacy) strict slash command with NO
        // registry: without a config stamp there is no provable recovery
        // axis — a retry would fail the same way on this handler forever.
        // Emit the inert notice directly; zero throw, zero retry.
        if (stamp === undefined && registry === null) {
          return formatInboundContent(
            rewriteSessionMessageCommandToNotice(message, TEAM_SKILL_COMMAND_UNRESOLVED_NOTICE, mentionGate),
            participants,
          );
        }
        // Stamped but unresolvable right now (unknown registry or version
        // mismatch) with NO pending inbox custody: a fresh-handler
        // recovery has no delivery axis either, so settle with the inert
        // notice instead of a recoverable error the provider would retry
        // into the same failure.
        if (
          (registry === null || versionMismatched) &&
          (message.inboxEntryId === undefined ||
            !this.inboxDelivery.hasEntry({ chatId, entryId: message.inboxEntryId, messageId: message.id }))
        ) {
          return formatInboundContent(
            rewriteSessionMessageCommandToNotice(message, TEAM_SKILL_COMMAND_UNRESOLVED_NOTICE, mentionGate),
            participants,
          );
        }
        // Server-owned Team Skill invocation marker (its KEY is guaranteed
        // present here — the unmarked short-circuit above returns first):
        // the command must resolve fail-closed against the registry and
        // the exact validated identity (recipient, config version, slug AND
        // resourceId), NEVER fall through to a same-named local Skill. A
        // present-but-malformed marker, any identity mismatch, a superseded
        // config version, or a strict command literal that no longer equals
        // the marked slug all become inert notices. Non-strict prose falls
        // through to ordinary formatting. The fenced-out cases (unpublished
        // / mismatched registry) are already settled by the guards above.
        if (fencedRegistry !== null) {
          const invocation = teamSkillInvocationFromMetadata(message.metadata);
          const marked = rewriteSessionMessageCommandForInvocation(message, fencedRegistry, invocation, {
            ...mentionGate,
            currentAgentId: this.config.agentIdentity.agentId,
            registryVersion: version as number,
          });
          if (marked !== null) {
            const formatted = await formatInboundContent(marked, participants);
            this.clearFenceRecoveryAttempt(chatId, message.id);
            this.clearPendingFenceFormatFailure(chatId, message.id);
            return formatted;
          }
          // No strict command position (prose / hand-edited-away command):
          // the marker guards nothing, format plainly.
          return formatInboundContent(message, participants);
        }
        try {
          const formatted = await formatInboundContent(
            rewriteSessionMessageCommand(message, fencedRegistry, mentionGate),
            participants,
          );
          // A successful format reclaims any attempt marker and any
          // pending failure for this message (e.g. a fresh registry that
          // finally covers it).
          this.clearFenceRecoveryAttempt(chatId, message.id);
          this.clearPendingFenceFormatFailure(chatId, message.id);
          return formatted;
        } catch (error) {
          if (versionMismatched && isTeamSkillCommandUnavailableError(error)) {
            // Recoverable fence failure: park it for the REAL retry
            // boundary to consume (DeliveryToken.retry, retryTurn, or the
            // start/resume failure path) — never consume a recovery here.
            this.recordPendingFenceFormatFailure(chatId, message);
          }
          throw error;
        }
      },
      resolveSenderLabel: async (senderId) => resolveSenderLabel(senderId, await participants.get()),
      formatFromHeader: (message) => buildFromHeader(message, participants),
    };
  }

  private async confirmSessionEventOrThrow(
    chatId: string,
    event: SessionEvent,
    mutationLeaseValid: (() => boolean) | null = null,
  ): Promise<void> {
    if (mutationLeaseValid && !mutationLeaseValid()) {
      throw new Error("route transition invalidated");
    }
    if (!this.config.confirmSessionEvent) {
      this.config.onSessionEvent?.(chatId, event);
      throw new Error("confirmed session event channel unavailable");
    }
    await this.config.confirmSessionEvent(chatId, event);
    if (mutationLeaseValid && !mutationLeaseValid()) {
      throw new Error("route transition invalidated");
    }
    this.captureRuntimeFailureNotice(chatId, event, mutationLeaseValid);
  }

  /**
   * Per-chat runtime snapshot for `fullStateSync` after reconnect. Lets
   * the agent-slot re-report the *real* per-chat runtime on a network
   * reconnect — a session mid-turn reports `working` rather than blanket-
   * idling. Only `status === 'active'` sessions are returned; a session
   * with no recorded runtime defaults to `idle`.
   */
  getSessionRuntimeStates(
    activeChatIds: RuntimeSyncActiveSet = null,
  ): Array<{ chatId: string; runtimeState: RuntimeState }> {
    return this.projection.getSessionRuntimeStates(activeChatIds);
  }

  private extractMessage(entry: InboxEntryWithMessage): SessionMessage {
    const msg = entry.message;
    return {
      inboxEntryId: entry.id,
      id: msg.id,
      chatId: entry.chatId ?? msg.chatId,
      senderId: msg.senderId,
      senderKind: msg.senderKind,
      senderProvider: msg.senderProvider,
      format: msg.format,
      content: msg.content as string | Record<string, unknown>,
      metadata: msg.metadata,
      source: msg.source,
      createdAt: msg.createdAt,
      configVersion: msg.configVersion,
      precedingMessages: msg.precedingMessages ?? [],
    };
  }
}
