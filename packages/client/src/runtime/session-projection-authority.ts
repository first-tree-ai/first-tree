import type { RuntimeState, SessionState } from "@first-tree/shared";
import type { pino } from "../cloud/observability/logger.js";
import type { ProviderRecoveryMarker, SessionMessage } from "./handler.js";
import type { Trigger } from "./result-sink.js";
import { SessionRegistry } from "./session-registry.js";

/** Maximum number of evicted session mappings to retain for resume recovery. */
export const MAX_EVICTED_MAPPINGS = 500;

/**
 * Base interval for re-affirming per-(agent,chat) runtime so the server-side
 * `runtime_state_at` stays inside its freshness window during a long turn.
 * Kept at 1/3 of the server's `RUNTIME_STALE_MS` (60 s) so a single dropped
 * frame doesn't let a live turn flap to idle — matches the approved spec
 * (proposals/hub-agent-status-working-freshness.20260525.md §6.1 §10). The
 * actual fire time is jittered ±20 % around this base to prevent
 * thundering-herd alignment across hundreds of clients restarting at once.
 */
const RUNTIME_REAFFIRM_BASE_MS = 20_000;
const RUNTIME_REAFFIRM_JITTER_RATIO = 0.2;

function jitteredReaffirmDelay(): number {
  const offset = (Math.random() * 2 - 1) * RUNTIME_REAFFIRM_BASE_MS * RUNTIME_REAFFIRM_JITTER_RATIO;
  return RUNTIME_REAFFIRM_BASE_MS + offset;
}

function resumableProviderSessionId(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return null;
}

export type RuntimeSyncActiveSet = ReadonlySet<string> | null;

/**
 * Session-entry fields SessionProjectionAuthority reads for persistence and
 * runtime projection. Host SessionEntry is structurally compatible; the
 * authority owns map membership but not route/handler mutation policy.
 */
export type SessionProjectionSessionFields = {
  chatId: string;
  claudeSessionId: string;
  /** Context source captured by the handler factory that owns this entry. */
  handlerSourceKey: string;
  status: SessionState;
  lastActivity: number;
  providerRecovery: ProviderRecoveryMarker | null;
};

export type EvictedMappingSnapshot = {
  readonly claudeSessionId: string;
  readonly lastActivity: number;
  readonly providerRecoveryMessageId: string | null;
  readonly providerRecoveryContinuation: "unsafe_turn" | null;
};

type EvictedMappingRecord = {
  readonly claudeSessionId: string;
  readonly lastActivity: number;
  readonly providerRecovery: ProviderRecoveryMarker | null;
};

export type SessionProjectionAuthorityDeps = {
  log: pino.Logger;
  onStateChange: () => ((chatId: string, state: SessionState) => void) | undefined;
  onSessionRuntimeChange: () => ((chatId: string, state: RuntimeState) => void) | undefined;
  onRuntimeStateChange: () => ((state: RuntimeState) => void) | undefined;
  /** Inbox processing ownership still lives on InboxDeliveryCoordinator. */
  hasProcessingOwnedWork: (chatId: string) => boolean;
  /**
   * Called when projection transitions a chat to idle and the host may have
   * pending slot work (SlotSchedulerAuthority drain).
   */
  drainPendingOnIdle: () => void;
  /**
   * Force-keep chats for runtime sync that are owned by other authorities
   * (route teardown, Reset/replay, slot queue, inbox unsettled work).
   */
  hasRuntimeSyncForceKeepExtra: (chatId: string) => boolean;
  /** Bind-recovery completion still settles inbox ledgers on the host. */
  completeBindRecovery: (chatId: string) => void;
  /** Readonly resume fallback owned by SlotSchedulerAuthority. */
  resumeFallbackSessionId: (session: SessionProjectionSessionFields) => string | null;
  /** Transient-retry window owned by SlotSchedulerAuthority. */
  hasPendingTransientRetry: (session: SessionProjectionSessionFields) => boolean;
};

export type SessionProjectionAuthorityOptions = {
  registryPath?: string;
};

/**
 * Unique owner of session-map membership, evicted resume mappings, current
 * trigger, SessionRegistry persistence timing, and runtime/state projection
 * ledgers. SessionRuntime composes this; it must not keep parallel copies of
 * these maps or the registry instance.
 */
export class SessionProjectionAuthority<
  TSession extends SessionProjectionSessionFields = SessionProjectionSessionFields,
> {
  private readonly sessions = new Map<string, TSession>();
  private readonly evictedMappings = new Map<string, EvictedMappingSnapshot>();
  /**
   * Current trigger (messageId + senderId) per chat — the message that kicked
   * off the current or most-recent turn. The result-sink clears it at turn end.
   */
  private readonly currentTrigger = new Map<string, Trigger>();
  private readonly registry: SessionRegistry | null;
  private readonly lastReportedStates = new Map<string, SessionState>();
  private readonly sessionRuntimeStates = new Map<string, RuntimeState>();
  /** Chats held specifically for a fresh bind, never same-socket recovery. */
  private readonly runtimeProofRecoveryChats = new Set<string>();
  private lastReportedRuntimeState: RuntimeState | null = null;
  /**
   * Last lazy Context-Tree re-resolution attempt (epoch ms). Owned here so
   * SessionRuntime orchestration can rate-limit without a parallel field.
   */
  private lastTreeResolveAttemptAt = 0;
  private runtimeReaffirmTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deps: SessionProjectionAuthorityDeps,
    options: SessionProjectionAuthorityOptions = {},
  ) {
    this.registry = options.registryPath ? new SessionRegistry(options.registryPath) : null;
  }

  getSession(chatId: string): TSession | undefined {
    return this.sessions.get(chatId);
  }

  hasSession(chatId: string): boolean {
    return this.sessions.has(chatId);
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  sessionsValues(): IterableIterator<TSession> {
    return this.sessions.values();
  }

  sessionsEntries(): IterableIterator<[string, TSession]> {
    return this.sessions.entries();
  }

  isSameSession(chatId: string, entry: TSession): boolean {
    return this.sessions.get(chatId) === entry;
  }

  /**
   * Record the Context-source key captured by the handler factory that owns
   * this session. Written at provider-admission boundaries (start / resume /
   * retry) when the route installs or confirms its handler.
   */
  recordHandlerSource(entry: TSession, sourceKey: string): void {
    entry.handlerSourceKey = sourceKey;
  }

  /** Read the source identity the entry's current handler was built from. */
  handlerSourceKey(entry: TSession): string {
    return entry.handlerSourceKey;
  }

  /**
   * Activate a live session: install the host entry and consume any evicted
   * mapping for this chat as one transition. Returns a frozen resume snapshot
   * when a valid mapping existed.
   */
  activateLiveSession(entry: TSession): EvictedMappingSnapshot | null {
    const stored = this.evictedMappings.get(entry.chatId);
    this.evictedMappings.delete(entry.chatId);
    this.sessions.set(entry.chatId, entry);
    if (!stored) return null;
    const sessionId = resumableProviderSessionId(stored.claudeSessionId);
    if (!sessionId) return null;
    return Object.freeze({
      claudeSessionId: sessionId,
      lastActivity: stored.lastActivity,
      providerRecoveryMessageId: stored.providerRecoveryMessageId,
      providerRecoveryContinuation: stored.providerRecoveryContinuation,
    });
  }

  /**
   * Terminate-style drop: live session, evicted mapping, runtime/state
   * projection, last-reported state, and current trigger.
   */
  forgetChat(chatId: string): void {
    this.sessions.delete(chatId);
    this.evictedMappings.delete(chatId);
    this.withdrawSessionRuntime(chatId);
    this.lastReportedStates.delete(chatId);
    this.currentTrigger.delete(chatId);
  }

  /**
   * Fail/abort path: drop the live session, runtime projection, and trigger.
   * Leaves an evicted mapping in place if one was already recorded.
   */
  dropLiveSession(chatId: string): void {
    this.sessions.delete(chatId);
    this.withdrawSessionRuntime(chatId);
    this.currentTrigger.delete(chatId);
  }

  /**
   * Identity-guarded live-session drop used when an unestablished start is
   * suspended: remove the entry and its trigger only if this exact record is
   * still installed.
   */
  dropLiveSessionIfCurrent(chatId: string, entry: TSession): boolean {
    if (this.sessions.get(chatId) !== entry) return false;
    this.sessions.delete(chatId);
    this.withdrawSessionRuntime(chatId);
    this.currentTrigger.delete(chatId);
    return true;
  }

  /** Session is no longer active for runtime projection (suspend / retry window). */
  clearActiveRuntimeProjection(chatId: string): void {
    this.withdrawSessionRuntime(chatId);
  }

  getSessionRuntimeState(chatId: string): RuntimeState | undefined {
    return this.sessionRuntimeStates.get(chatId);
  }

  hasEvictedMapping(chatId: string): boolean {
    return this.evictedMappings.has(chatId);
  }

  /**
   * Eviction resume mapping transition: record a frozen copy, or drop the
   * mapping when the victim has no resumable provider session.
   */
  recordEvictionResume(chatId: string, mapping: EvictedMappingRecord | null): void {
    if (mapping) this.addEvictedMapping(chatId, mapping);
    else this.evictedMappings.delete(chatId);
  }

  getLastTreeResolveAttemptAt(): number {
    return this.lastTreeResolveAttemptAt;
  }

  noteTreeResolveAttempt(at: number = Date.now()): void {
    this.lastTreeResolveAttemptAt = at;
  }

  /** Clear live session + evicted maps (shutdown / destructive registry flush). */
  clearLiveMapsOnShutdown(): void {
    for (const chatId of [...this.sessionRuntimeStates.keys()]) {
      this.withdrawSessionRuntime(chatId);
    }
    this.sessions.clear();
    this.evictedMappings.clear();
  }

  /** Start jittered reaffirm loop when the host registers onSessionRuntimeChange. */
  startRuntimeReaffirm(): void {
    if (!this.deps.onSessionRuntimeChange()) return;
    const armReaffirm = () => {
      this.runtimeReaffirmTimer = setTimeout(() => {
        this.reaffirmRuntimeStates();
        armReaffirm();
      }, jitteredReaffirmDelay());
    };
    armReaffirm();
  }

  stopRuntimeReaffirm(): void {
    if (this.runtimeReaffirmTimer) {
      clearTimeout(this.runtimeReaffirmTimer);
      this.runtimeReaffirmTimer = null;
    }
  }

  loadPersistedSessions(): void {
    if (!this.registry) return;

    const { entries } = this.registry.loadSnapshot();
    let loadedCount = 0;
    for (const [chatId, data] of entries) {
      // All persisted sessions become evicted mappings on load.
      // Handlers are allocated lazily when a message arrives (startNewSession
      // checks evictedMappings and calls handler.resume instead of start).
      const resumableSessionId = resumableProviderSessionId(data.claudeSessionId);
      if (!resumableSessionId) {
        this.deps.log.warn({ chatId }, "ignoring persisted session mapping without a resumable provider session id");
        continue;
      }
      this.addEvictedMapping(chatId, {
        claudeSessionId: resumableSessionId,
        lastActivity: data.lastActivity,
        providerRecovery: data.providerRecovery ? { ...data.providerRecovery } : null,
      });
      loadedCount++;
    }

    if (loadedCount > 0) {
      this.deps.log.info({ count: loadedCount }, "loaded persisted session mappings");
    }
  }

  persistRegistry(opts: { immediate?: boolean; throwOnFailure?: boolean } = {}): void {
    if (!this.registry) return;

    const entries = new Map<
      string,
      {
        claudeSessionId: string;
        lastActivity: number;
        status: string;
        providerRecovery?: ProviderRecoveryMarker;
      }
    >();
    for (const [chatId, session] of this.sessions) {
      const resumableSessionId = resumableProviderSessionId(
        session.claudeSessionId,
        this.deps.resumeFallbackSessionId(session),
      );
      if (!resumableSessionId) continue;
      entries.set(chatId, {
        claudeSessionId: resumableSessionId,
        lastActivity: session.lastActivity,
        status: session.status,
        ...(session.providerRecovery ? { providerRecovery: { ...session.providerRecovery } } : {}),
      });
    }
    // Include evicted mappings for crash recovery
    for (const [chatId, mapping] of this.evictedMappings) {
      const resumableSessionId = resumableProviderSessionId(mapping.claudeSessionId);
      if (!resumableSessionId) continue;
      entries.set(chatId, {
        claudeSessionId: resumableSessionId,
        lastActivity: mapping.lastActivity,
        status: "evicted",
        ...(mapping.providerRecoveryMessageId && mapping.providerRecoveryContinuation === "unsafe_turn"
          ? {
              providerRecovery: {
                messageId: mapping.providerRecoveryMessageId,
                continuation: mapping.providerRecoveryContinuation,
              },
            }
          : {}),
      });
    }
    // On shutdown we MUST write synchronously: the alternative is
    // `save()` (debounced 1s) followed by `dispose()`, which races the
    // process exit and silently drops the last mapping batch.
    // `throwOnFailure` (Reset terminate) additionally surfaces write failure
    // to the caller instead of swallowing it.
    if (opts.throwOnFailure) this.registry.flushOrThrow(entries);
    else if (opts.immediate) this.registry.flush(entries);
    else this.registry.save(entries);
  }

  rotateFreshStartNonce(chatId: string): void {
    this.registry?.rotateFreshStartNonce(chatId);
  }

  markResetNonceDurable(chatId: string): void {
    this.registry?.markResetNonceDurable(chatId);
  }

  getFreshStartNonce(chatId: string): string | undefined {
    return this.registry?.getFreshStartNonce(chatId);
  }

  disposeRegistry(): void {
    this.registry?.dispose();
  }

  /** Add an evicted mapping, pruning the oldest if over capacity. */
  private addEvictedMapping(chatId: string, mapping: EvictedMappingRecord): void {
    const resumableSessionId = resumableProviderSessionId(mapping.claudeSessionId);
    if (!resumableSessionId) {
      this.evictedMappings.delete(chatId);
      return;
    }
    this.evictedMappings.set(chatId, {
      ...mapping,
      claudeSessionId: resumableSessionId,
      providerRecoveryMessageId: mapping.providerRecovery?.messageId ?? null,
      providerRecoveryContinuation: mapping.providerRecovery?.continuation ?? null,
    });
    if (this.evictedMappings.size > MAX_EVICTED_MAPPINGS) {
      // Map iteration order is insertion order — first key is the oldest
      const oldest = this.evictedMappings.keys().next().value;
      if (oldest !== undefined) this.evictedMappings.delete(oldest);
    }
  }

  /** Notify per-session state change to the server via callback. Deduplicates redundant reports. */
  notifySessionState(chatId: string, state: SessionState): void {
    const onStateChange = this.deps.onStateChange();
    if (!onStateChange) return;
    if (this.lastReportedStates.get(chatId) === state) return;
    this.lastReportedStates.set(chatId, state);
    onStateChange(chatId, state);
  }

  projectSessionRuntime(chatId: string, opts: { drainPendingOnIdle?: boolean } = {}): void {
    const session = this.sessions.get(chatId);
    const state = this.projectedRuntimeState(chatId, session ?? null);
    if (!state) {
      this.withdrawSessionRuntime(chatId);
      return;
    }
    const previous = this.sessionRuntimeStates.get(chatId);
    if (previous === state) return;
    this.sessionRuntimeStates.set(chatId, state);
    this.deps.onSessionRuntimeChange()?.(chatId, state);
    this.recomputeRuntimeState();
    if (state === "idle" && opts.drainPendingOnIdle !== false) {
      this.deps.drainPendingOnIdle();
    }
  }

  projectedRuntimeState(chatId: string, session: SessionProjectionSessionFields | null): RuntimeState | null {
    if (!session) return null;
    if (session.status === "errored") return "error";
    if (session.status !== "active") return null;
    return this.deps.hasProcessingOwnedWork(chatId) ? "working" : "idle";
  }

  /**
   * Removal is a projection transition, not a silent bookkeeping detail.
   * Emit an explicit idle before forgetting the local value so a working
   * edge cannot remain authoritative on the server until freshness expiry.
   * Repeated removals are idempotent because an absent map entry emits
   * nothing; removing a recorded idle still emits once so deletion itself is
   * observable even without an ordinary value change.
   */
  private withdrawSessionRuntime(chatId: string): void {
    if (!this.sessionRuntimeStates.delete(chatId)) return;
    this.deps.onSessionRuntimeChange()?.(chatId, "idle");
    this.recomputeRuntimeState();
  }

  /**
   * Re-affirm working / blocked / error sessions so the server-side
   * freshness stamp doesn't lapse mid-turn. Reports only — does NOT
   * touch `lastActivity` (that governs idle eviction and must not be
   * reset by a liveness ping). `idle` is deliberately omitted: the
   * server treats it as the fail-closed default after the stale window
   * expires, so re-affirming idle is pure wire noise.
   */
  reaffirmRuntimeStates(): void {
    if (!this.deps.onSessionRuntimeChange()) return;
    for (const [chatId, session] of this.sessions) {
      if (session.status !== "active" && session.status !== "errored") continue;
      const state = this.sessionRuntimeStates.get(chatId);
      if (state === "working" || state === "error") {
        this.deps.onSessionRuntimeChange()?.(chatId, state);
      }
    }
  }

  /** Aggregate per-session runtime states: error > blocked > working > idle. */
  recomputeRuntimeState(): void {
    if (!this.deps.onRuntimeStateChange()) return;

    let aggregate: RuntimeState = "idle";
    for (const state of this.sessionRuntimeStates.values()) {
      if (state === "error") {
        aggregate = "error";
        break;
      }
      if (state === "blocked") {
        aggregate = "blocked";
      } else if (state === "working" && aggregate !== "blocked") {
        aggregate = "working";
      }
    }

    if (aggregate !== this.lastReportedRuntimeState) {
      this.lastReportedRuntimeState = aggregate;
      this.deps.onRuntimeStateChange()?.(aggregate);
    }
  }

  setCurrentTrigger(chatId: string, message: SessionMessage): void {
    if (!message.id) return;
    this.currentTrigger.set(chatId, { messageId: message.id, senderId: message.senderId });
  }

  clearCurrentTrigger(chatId: string): void {
    this.currentTrigger.delete(chatId);
  }

  noteBindRecoveryComplete(): void {
    for (const chatId of this.runtimeProofRecoveryChats) {
      this.deps.completeBindRecovery(chatId);
      this.projectSessionRuntime(chatId);
    }
    this.runtimeProofRecoveryChats.clear();
  }

  markRuntimeProofRecoveryChat(chatId: string): void {
    this.runtimeProofRecoveryChats.add(chatId);
  }

  getAggregateRuntimeState(): RuntimeState | null {
    return this.lastReportedRuntimeState;
  }

  getSessionStates(activeChatIds: RuntimeSyncActiveSet = null): Array<{ chatId: string; state: SessionState }> {
    return [...this.sessions.entries()]
      .filter(([chatId]) => this.shouldIncludeInRuntimeSync(chatId, activeChatIds))
      .map(([chatId, session]) => ({
        chatId,
        state: session.status,
      }));
  }

  /**
   * ChatIds the client still holds in `evictedMappings` — i.e. either
   * hydrated from disk on startup or dropped from `sessions` by LRU.
   */
  getEvictedChatIds(activeChatIds: RuntimeSyncActiveSet = null): string[] {
    return [...this.evictedMappings.keys()].filter((chatId) => this.shouldIncludeInRuntimeSync(chatId, activeChatIds));
  }

  /**
   * Per-chat runtime snapshot for `fullStateSync` after reconnect. Only
   * `status === 'active'` sessions are returned; a session with no recorded
   * runtime defaults to `idle` via projectedRuntimeState.
   */
  getSessionRuntimeStates(
    activeChatIds: RuntimeSyncActiveSet = null,
  ): Array<{ chatId: string; runtimeState: RuntimeState }> {
    const out: Array<{ chatId: string; runtimeState: RuntimeState }> = [];
    for (const [chatId, session] of this.sessions) {
      if (!this.shouldIncludeInRuntimeSync(chatId, activeChatIds)) continue;
      const runtimeState = this.projectedRuntimeState(chatId, session);
      if (!runtimeState) continue;
      out.push({ chatId, runtimeState });
    }
    return out;
  }

  /**
   * Chat IDs this client still holds locally and should report to runtime sync.
   * `extraHeldIds` supplies ledgers owned by other authorities (route teardown,
   * Reset/replay) so projection stays the unique owner of sessions/evicted
   * membership while preserving held-set ordering/semantics.
   */
  getHeldChatIds(activeChatIds: RuntimeSyncActiveSet = null, extraHeldIds: Iterable<string> = []): string[] {
    const ids = new Set<string>();
    for (const id of this.sessions.keys()) {
      if (this.shouldIncludeInRuntimeSync(id, activeChatIds)) ids.add(id);
    }
    for (const id of this.evictedMappings.keys()) {
      if (this.shouldIncludeInRuntimeSync(id, activeChatIds)) ids.add(id);
    }
    for (const id of extraHeldIds) {
      if (this.shouldIncludeInRuntimeSync(id, activeChatIds)) ids.add(id);
    }
    return [...ids];
  }

  shouldIncludeInRuntimeSync(chatId: string, activeChatIds: RuntimeSyncActiveSet): boolean {
    if (activeChatIds === null) return true;
    if (activeChatIds.has(chatId)) return true;
    return this.hasRuntimeSyncForceKeep(chatId);
  }

  private hasRuntimeSyncForceKeep(chatId: string): boolean {
    if (this.hasPendingTransientRetry(chatId)) return true;
    return this.deps.hasRuntimeSyncForceKeepExtra(chatId);
  }

  private hasPendingTransientRetry(chatId: string): boolean {
    const entry = this.sessions.get(chatId);
    return Boolean(entry && this.deps.hasPendingTransientRetry(entry));
  }

  /** Clear projection ledgers that shutdown tears down with the session maps. */
  clearProjectionLedgers(): void {
    this.runtimeProofRecoveryChats.clear();
    this.lastReportedStates.clear();
    this.sessionRuntimeStates.clear();
    this.lastReportedRuntimeState = null;
  }
}
