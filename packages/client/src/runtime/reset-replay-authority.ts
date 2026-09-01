import { INBOX_FENCE_PROBE_MAX_IDS, type SessionRuntimeReport } from "@first-tree/shared";
import type { pino } from "../cloud/observability/logger.js";
import type { SessionMessage } from "./handler.js";
import { type ReplayFenceEntry, ReplayFenceStore, type ReplayFenceWriter } from "./replay-fence.js";

/**
 * Minimum spacing between gate-triggered replay-fence reconciliations for
 * one chat. Withheld dispatches retry the server-truth readback so a
 * transient readback/clear failure converges without a process restart,
 * without turning every redelivery burst into an inbox-recovery storm.
 */
export const REPLAY_FENCE_RECONCILE_INTERVAL_MS = 30_000;

/**
 * This client's authoritative answer to "did the Reset fence for that
 * generation come down here?". The wire receipt is derived from it and never
 * from a caller's own bookkeeping: `accepted` / `idempotent` mean the fence
 * is lifted, `stale` means it is not.
 */
export type ResetFenceReleaseVerdict = "accepted" | "idempotent" | "stale";

/** Narrow inbox surface ResetReplayAuthority needs — avoids circular imports. */
export type ResetReplayInboxHost = {
  parkTurnForDeferredRecovery(
    chatId: string,
    messages: SessionMessage | readonly SessionMessage[],
    reason: string,
  ): Promise<void> | Promise<boolean>;
  hasRecoveryDebt(chatId: string): boolean;
  hasUnsettledWork(chatId: string): boolean;
  recoverIfNeeded(chatId: string, reason: string): void | Promise<void>;
  settleReplayFencedEntries(chatId: string, messageIds: readonly string[]): void;
  markFenceSettled(chatId: string, messageIds: readonly string[]): void;
};

export type ResetReplayAuthorityDeps = {
  log: pino.Logger;
  isShuttingDown: () => boolean;
  /** Quarantine restart fence still owned by RouteTeardownAuthority. */
  isQuarantineRestartRequired: (chatId: string) => boolean;
  /** Lazy so SessionRuntime can construct inboxDelivery after this authority. */
  inbox: () => ResetReplayInboxHost;
  recoverChat: () => ((chatId: string) => Promise<unknown>) | undefined;
  probeFencedSettlement: () =>
    | ((chatId: string, messageIds: readonly string[]) => Promise<readonly string[]>)
    | undefined;
  onSessionRuntimeChange: () => ((chatId: string, report: SessionRuntimeReport) => void) | undefined;
  projectSessionRuntime: (chatId: string) => void;
  /**
   * SessionRegistry custody lives on SessionProjectionAuthority; these
   * callbacks preserve byte-compatible terminate flush / tombstone behavior.
   */
  rotateFreshStartNonce: (chatId: string) => void;
  persistRegistryThrowing: () => void;
  markResetNonceDurable: (chatId: string) => void;
};

export type ResetReplayAuthorityOptions = {
  replayFencePath?: string;
};

/**
 * Unique owner of Reset-generation fencing, terminate-admission ledgers, and
 * replay-fence reconciliation / post-fence recovery. SessionRuntime composes
 * this; it must not keep parallel copies of these maps or the ReplayFenceStore.
 */
export class ResetReplayAuthority {
  /** Chats whose terminate command has closed admission but is still draining cleanup. */
  private readonly terminatingChats = new Map<string, Promise<void>>();
  /**
   * Chats whose terminate cleanup finished in memory but whose final
   * synchronous registry flush failed.
   */
  private readonly terminatePersistFailures = new Set<string>();
  /**
   * Chats with Reset-fence parked debt that must not admit a provider route
   * or same-socket recoverChat until {@link releaseParkedResetFenceRecovery}
   * runs after an exact receipted post-apply terminal disposition.
   */
  private readonly awaitingResetFenceRelease = new Set<string>();
  /**
   * THE Reset-generation authority for this client: `chatId → generation`.
   */
  private readonly resetGenerations = new Map<string, { refs: Set<string>; released: boolean }>();
  /**
   * Coalesce one post-disposition recovery per chat so duplicate or
   * concurrent release calls cannot open repeated same-socket recoverChat
   * calls.
   */
  private readonly postResetFenceRecoveryScheduled = new Set<string>();
  /**
   * Durable replay-fence store instance (unique owner). Disk format / write /
   * flush / tombstone behavior is unchanged — only custody moved.
   */
  private readonly replayFence: ReplayFenceStore | null;
  /**
   * Set when the replay-fence store could not be loaded. Fail-closed: every
   * dispatch is withheld as recovery debt until an operator repairs the store.
   */
  private replayFenceUnavailable: string | null = null;
  /**
   * Fence keys the server has authoritatively proven settled. Once a key
   * lands here its settlement fact cannot be revoked by later tail traffic.
   */
  private readonly provenSettledFences = new Map<string, Set<string>>();
  /** Per-chat retry timers for the reconciliation/clear loop. */
  private readonly replayFenceRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Chats whose post-fence-clear recovery has not yet succeeded. */
  private readonly postFenceRecoveryDebt = new Set<string>();
  private readonly postFenceRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly postFenceRecoveryInFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: ResetReplayAuthorityDeps,
    options: ResetReplayAuthorityOptions = {},
  ) {
    if (options.replayFencePath) {
      this.replayFence = new ReplayFenceStore(options.replayFencePath);
      try {
        this.replayFence.load();
      } catch (err) {
        this.replayFenceUnavailable = err instanceof Error ? err.message : String(err);
        this.deps.log.error(
          { err, path: options.replayFencePath },
          "replay fence store failed to load; withholding all provider dispatch fail-closed",
        );
      }
    } else {
      this.replayFence = null;
    }
  }

  joinInFlightTermination(chatId: string): Promise<void> | undefined {
    return this.terminatingChats.get(chatId);
  }

  /**
   * Single-flight terminate: start `work` or join the in-flight run. Owns
   * map set / await / finally-delete so the host cannot assemble that
   * transition from generic setters.
   */
  runOrJoinTermination(chatId: string, work: () => Promise<void>): Promise<void> {
    const existing = this.terminatingChats.get(chatId);
    if (existing) return existing;
    const workPromise = work();
    const flight = workPromise.finally(() => {
      if (this.terminatingChats.get(chatId) === flight) {
        this.terminatingChats.delete(chatId);
      }
    });
    this.terminatingChats.set(chatId, flight);
    return flight;
  }

  hasTerminatingChat(chatId: string): boolean {
    return this.terminatingChats.has(chatId);
  }

  terminatingChatIds(): string[] {
    return [...this.terminatingChats.keys()];
  }

  terminatePersistFailureIds(): string[] {
    return [...this.terminatePersistFailures];
  }

  awaitingResetFenceReleaseIds(): string[] {
    return [...this.awaitingResetFenceRelease];
  }

  armedResetGenerationChatIds(): string[] {
    const ids: string[] = [];
    for (const id of this.resetGenerations.keys()) {
      if (this.hasArmedResetGeneration(id)) ids.push(id);
    }
    return ids;
  }

  hasPostFenceRecoveryDebt(chatId: string): boolean {
    return this.postFenceRecoveryDebt.has(chatId);
  }

  /**
   * Frozen handler-facing writer. Fence/clear execute inside this authority;
   * the ReplayFenceStore instance never escapes.
   */
  createHandlerReplayFenceWriter(): ReplayFenceWriter | null {
    if (!this.replayFence) return null;
    const store = this.replayFence;
    return Object.freeze({
      fence: (entry: ReplayFenceEntry) => {
        store.fence(entry);
      },
      clear: (chatId: string, messageId: string) => {
        store.clear(chatId, messageId);
      },
    });
  }

  /**
   * Combined provider-route admission fence for Reset: an in-flight
   * `session:terminate` drain (`terminatingChats`), a prior Reset whose
   * durable registry flush failed (`terminatePersistFailures`), or parked
   * Reset-fence debt still awaiting an exact receipted terminal disposition
   * (`awaitingResetFenceRelease`), or an armed Reset generation whose exact
   * `finalized`/`aborted` has not been accepted yet (`resetGenerations`) —
   * plus the quarantine restart fence owned by RouteTeardownAuthority.
   */
  isProviderRouteAdmissionFenced(chatId: string): boolean {
    return (
      this.terminatingChats.has(chatId) ||
      this.terminatePersistFailures.has(chatId) ||
      this.awaitingResetFenceRelease.has(chatId) ||
      this.hasArmedResetGeneration(chatId) ||
      this.deps.isQuarantineRestartRequired(chatId)
    );
  }

  /**
   * Retain coordinator custody for a delivery that hit the Reset admission
   * fence without requesting same-socket recoverChat.
   */
  async parkDeliveryBehindResetAdmissionFence(
    chatId: string,
    messages: SessionMessage | readonly SessionMessage[],
  ): Promise<void> {
    const messageIds = (Array.isArray(messages) ? messages : [messages]).map((message) => message.id);
    this.deps.log.info(
      { chatId, messageIds },
      "parking delivery behind Reset admission fence without same-socket recovery",
    );
    this.awaitingResetFenceRelease.add(chatId);
    await this.deps.inbox().parkTurnForDeferredRecovery(chatId, messages, "reset_admission_fence");
  }

  /** Is a Reset generation armed (created and not yet released) for this chat? */
  hasArmedResetGeneration(chatId: string): boolean {
    const generation = this.resetGenerations.get(chatId);
    return generation !== undefined && !generation.released;
  }

  /**
   * After a successful local terminate, arm the chat's Reset fence for the
   * generation identified by `ref`.
   */
  armParkedResetFenceRelease(chatId: string, ref?: string, options?: { join?: boolean }): void {
    if (ref !== undefined) {
      const current = this.resetGenerations.get(chatId);
      if (options?.join === true && current !== undefined && !current.released) {
        current.refs.add(ref);
      } else {
        this.resetGenerations.set(chatId, { refs: new Set([ref]), released: false });
      }
      this.awaitingResetFenceRelease.add(chatId);
      return;
    }
    if (this.hasArmedResetGeneration(chatId)) return;
    if (this.terminatePersistFailures.has(chatId)) return;
    const inbox = this.deps.inbox();
    if (!inbox.hasRecoveryDebt(chatId) && !inbox.hasUnsettledWork(chatId)) {
      this.awaitingResetFenceRelease.delete(chatId);
      return;
    }
    this.awaitingResetFenceRelease.add(chatId);
  }

  /**
   * Release parked Reset-fence debt after an exact receipted post-apply
   * terminal disposition.
   */
  releaseParkedResetFenceRecovery(chatId: string, ref?: string): ResetFenceReleaseVerdict {
    const generation = this.resetGenerations.get(chatId);
    if (ref === undefined) {
      if (generation !== undefined && !generation.released) {
        this.deps.log.debug(
          { chatId, armedRefs: [...generation.refs] },
          "refusing unref'd Reset fence release while a Reset generation is armed",
        );
        return "stale";
      }
      return this.runParkedResetFenceRecovery(chatId) ? "accepted" : "stale";
    }
    if (generation === undefined || !generation.refs.has(ref)) {
      this.deps.log.debug(
        { chatId, ref, armedRefs: generation ? [...generation.refs] : null },
        "ignoring Reset finalization for a ref that is not the armed generation",
      );
      return "stale";
    }
    if (generation.released) return "idempotent";
    if (!this.runParkedResetFenceRecovery(chatId)) return "stale";
    generation.released = true;
    return "accepted";
  }

  /**
   * Retire whatever Reset generation this chat holds and release its parked
   * debt. Reserved for callers with independent authority that the server
   * already finalized.
   */
  supersedeResetGeneration(chatId: string, reason: string): ResetFenceReleaseVerdict {
    const generation = this.resetGenerations.get(chatId);
    if (generation !== undefined && !generation.released) {
      this.deps.log.info({ chatId, reason, armedRefs: [...generation.refs] }, "superseding armed Reset generation");
    }
    this.resetGenerations.delete(chatId);
    return this.runParkedResetFenceRecovery(chatId) ? "accepted" : "stale";
  }

  /**
   * Lift the chat's admission fence and, if any debt is parked behind it,
   * open exactly one same-socket recovery.
   */
  runParkedResetFenceRecovery(chatId: string): boolean {
    if (this.terminatingChats.has(chatId) || this.terminatePersistFailures.has(chatId)) return false;
    if (this.postResetFenceRecoveryScheduled.has(chatId)) return true;
    this.postResetFenceRecoveryScheduled.add(chatId);
    this.awaitingResetFenceRelease.delete(chatId);
    try {
      const inbox = this.deps.inbox();
      if (inbox.hasRecoveryDebt(chatId) || inbox.hasUnsettledWork(chatId)) {
        void inbox.recoverIfNeeded(chatId, "reset_admission_fence_cleared");
      }
      return true;
    } finally {
      this.postResetFenceRecoveryScheduled.delete(chatId);
    }
  }

  /**
   * Durably flush the authoritative registry snapshot for a Reset terminate.
   * Registry disk format remains byte-compatible; only the persist-failure
   * ledger is owned here.
   */
  flushTerminateRegistry(chatId: string): void {
    try {
      this.deps.rotateFreshStartNonce(chatId);
      this.deps.persistRegistryThrowing();
      this.deps.markResetNonceDurable(chatId);
      this.terminatePersistFailures.delete(chatId);
    } catch (err) {
      this.terminatePersistFailures.add(chatId);
      throw err;
    }
  }

  /**
   * Crash-safe fence reconciliation driven by per-delivery server
   * settlement truth.
   */
  async reconcileReplayFencesWithServer(): Promise<void> {
    if (!this.replayFence || this.replayFenceUnavailable) return;
    const chatIds = [...new Set(this.replayFence.snapshot().map((entry) => entry.chatId))];
    for (const chatId of chatIds) {
      await this.reconcileReplayFenceForChat(chatId);
      this.ensureReplayFenceReconcileLoop(chatId, { immediate: false });
    }
  }

  async reconcileReplayFenceForChat(chatId: string): Promise<void> {
    if (!this.replayFence || this.replayFenceUnavailable || !this.deps.probeFencedSettlement()) return;
    const probe = this.deps.probeFencedSettlement();
    if (!probe) return;
    const fencedMessageIds = [
      ...new Set(
        this.replayFence
          .snapshot()
          .filter((entry) => entry.chatId === chatId)
          .map((entry) => entry.messageId),
      ),
    ];
    if (fencedMessageIds.length === 0) return;
    const settled = new Set<string>();
    for (let offset = 0; offset < fencedMessageIds.length; offset += INBOX_FENCE_PROBE_MAX_IDS) {
      const chunk = fencedMessageIds.slice(offset, offset + INBOX_FENCE_PROBE_MAX_IDS);
      let settledIds: readonly string[];
      try {
        settledIds = await probe(chatId, chunk);
      } catch (err) {
        this.deps.log.warn(
          { err, chatId, chunkOffset: offset },
          "replay fence settlement probe failed; discarding this round and keeping every fence (fail-closed)",
        );
        return;
      }
      const requested = new Set(chunk);
      for (const id of settledIds) {
        if (requested.has(id)) settled.add(id);
        else {
          this.deps.log.warn({ chatId, id }, "fence probe returned an id outside the request chunk; ignoring it");
        }
      }
    }
    const proven = this.provenSettledFences.get(chatId) ?? new Set<string>();
    for (const messageId of fencedMessageIds) {
      if (settled.has(messageId)) proven.add(messageId);
    }
    if (proven.size > 0) {
      this.provenSettledFences.set(chatId, proven);
      await this.clearProvenSettledFences(chatId);
    }
  }

  async clearProvenSettledFences(chatId: string): Promise<void> {
    if (!this.replayFence) return;
    const proven = this.provenSettledFences.get(chatId);
    if (!proven) return;
    const clearedMessageIds: string[] = [];
    for (const messageId of [...proven]) {
      try {
        this.replayFence.clear(chatId, messageId);
        proven.delete(messageId);
        clearedMessageIds.push(messageId);
        this.deps.log.info({ chatId, messageId }, "cleared stale replay fence: delivery confirmed settled server-side");
      } catch (err) {
        this.deps.log.error(
          { err, chatId, messageId },
          "stale replay fence could not be cleared; the retry loop will redo the local clear",
        );
        this.deps.onSessionRuntimeChange()?.(chatId, { runtimeState: "error", backgroundWork: false });
      }
    }
    if (proven.size === 0) this.provenSettledFences.delete(chatId);
    if (clearedMessageIds.length > 0) this.deps.inbox().settleReplayFencedEntries(chatId, clearedMessageIds);
    if (this.replayFence.hasFenceForChat(chatId)) return;
    await this.onChatFencesCleared(chatId);
  }

  async onChatFencesCleared(chatId: string): Promise<void> {
    this.stopReplayFenceReconcileLoop(chatId);
    if (this.deps.recoverChat() && this.deps.inbox().hasUnsettledWork(chatId)) {
      this.beginPostFenceRecovery(chatId);
      return;
    }
    this.deps.projectSessionRuntime(chatId);
  }

  beginPostFenceRecovery(chatId: string): void {
    if (this.deps.isShuttingDown() || !this.deps.recoverChat()) return;
    if (this.postFenceRecoveryInFlight.has(chatId) || this.postFenceRecoveryTimers.has(chatId)) return;
    this.postFenceRecoveryDebt.add(chatId);
    const recoverChat = this.deps.recoverChat();
    if (!recoverChat) return;
    const inFlight = (async () => {
      try {
        await recoverChat(chatId);
        this.postFenceRecoveryDebt.delete(chatId);
        this.deps.log.info({ chatId }, "post-fence-clear recovery accepted; redelivery may proceed");
      } catch (err) {
        this.deps.log.warn({ err, chatId }, "post-fence-clear recovery failed; retrying on a timer");
        this.armPostFenceRecoveryTimer(chatId);
      } finally {
        this.postFenceRecoveryInFlight.delete(chatId);
        this.deps.projectSessionRuntime(chatId);
      }
    })();
    this.postFenceRecoveryInFlight.set(chatId, inFlight);
    void inFlight.catch(() => {});
  }

  armPostFenceRecoveryTimer(chatId: string): void {
    if (this.deps.isShuttingDown()) return;
    const timer = setTimeout(() => {
      this.postFenceRecoveryTimers.delete(chatId);
      this.beginPostFenceRecovery(chatId);
    }, REPLAY_FENCE_RECONCILE_INTERVAL_MS);
    this.postFenceRecoveryTimers.set(chatId, timer);
  }

  ensureReplayFenceReconcileLoop(chatId: string, opts: { immediate?: boolean } = {}): void {
    if (this.deps.isShuttingDown()) return;
    if (this.replayFenceRetryTimers.has(chatId)) return;
    if (opts.immediate !== false) {
      void this.reconcileReplayFenceForChat(chatId).catch((err) => {
        this.deps.log.warn({ err, chatId }, "replay fence reconciliation attempt failed");
      });
    }
    this.armReplayFenceRetryTimer(chatId);
  }

  armReplayFenceRetryTimer(chatId: string): void {
    const timer = setTimeout(() => {
      this.replayFenceRetryTimers.delete(chatId);
      void this.runReplayFenceReconcileLoop(chatId);
    }, REPLAY_FENCE_RECONCILE_INTERVAL_MS);
    this.replayFenceRetryTimers.set(chatId, timer);
  }

  async runReplayFenceReconcileLoop(chatId: string): Promise<void> {
    if (this.deps.isShuttingDown() || !this.replayFence) return;
    try {
      if ((this.provenSettledFences.get(chatId)?.size ?? 0) > 0) {
        await this.clearProvenSettledFences(chatId);
      } else {
        await this.reconcileReplayFenceForChat(chatId);
      }
    } catch (err) {
      this.deps.log.warn({ err, chatId }, "replay fence reconciliation loop iteration failed");
    }
    if (!this.deps.isShuttingDown() && this.replayFence.hasFenceForChat(chatId)) {
      this.armReplayFenceRetryTimer(chatId);
    }
  }

  stopReplayFenceReconcileLoop(chatId: string): void {
    const timer = this.replayFenceRetryTimers.get(chatId);
    if (timer) clearTimeout(timer);
    this.replayFenceRetryTimers.delete(chatId);
    this.provenSettledFences.delete(chatId);
  }

  isChatReplayFenced(chatId: string): boolean {
    if (this.replayFenceUnavailable) return true;
    if (!this.replayFence) return false;
    return this.replayFence.hasFenceForChat(chatId);
  }

  /**
   * Clear replay fences for deliveries whose ACK committed — including the
   * recovery/redelivery retry path.
   */
  reconcileReplayFences(chatId: string, messageIds: readonly string[]): void {
    if (!this.replayFence) return;
    const replayFence = this.replayFence;
    let transitioned = false;
    const fencedMessageIds = messageIds.filter((messageId) => replayFence.isFenced(chatId, messageId));
    if (fencedMessageIds.length > 0) {
      this.deps.inbox().markFenceSettled(chatId, fencedMessageIds);
    }
    for (const messageId of messageIds) {
      if (!this.replayFence.isFenced(chatId, messageId)) continue;
      transitioned = true;
      try {
        this.replayFence.clear(chatId, messageId);
      } catch (err) {
        const proven = this.provenSettledFences.get(chatId) ?? new Set<string>();
        proven.add(messageId);
        this.provenSettledFences.set(chatId, proven);
        this.ensureReplayFenceReconcileLoop(chatId, { immediate: false });
        this.deps.log.error(
          { err, chatId, messageId },
          "replay fence could not be cleared after confirmed ACK; the retry loop will redo the local clear",
        );
        this.deps.onSessionRuntimeChange()?.(chatId, { runtimeState: "error", backgroundWork: false });
      }
    }
    if (transitioned && !this.replayFence.hasFenceForChat(chatId)) {
      void this.onChatFencesCleared(chatId).catch((err) => {
        this.deps.log.warn({ err, chatId }, "post-fence-clear convergence failed");
      });
    }
  }

  /** Cancel reconcile/post-fence timers on manager shutdown (ledgers cleared separately). */
  clearTimersOnShutdown(): void {
    for (const timer of this.replayFenceRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.replayFenceRetryTimers.clear();
    for (const timer of this.postFenceRecoveryTimers.values()) {
      clearTimeout(timer);
    }
    this.postFenceRecoveryTimers.clear();
  }

  /** Clear Reset-generation ledgers at the end of manager shutdown. */
  clearResetLedgersOnShutdown(): void {
    this.awaitingResetFenceRelease.clear();
    this.resetGenerations.clear();
    this.postResetFenceRecoveryScheduled.clear();
  }

  /** Cancel timers and clear Reset-generation ledgers on manager shutdown. */
  clearOnShutdown(): void {
    this.clearTimersOnShutdown();
    this.clearResetLedgersOnShutdown();
  }
}
