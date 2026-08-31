import type { RuntimeProvider, RuntimeState, SessionState } from "@first-tree/shared";
import { encodeProviderRetryEventMessage } from "@first-tree/shared";
import type { pino } from "../cloud/observability/logger.js";
import type { ContextSourceAdmissionSnapshot } from "./context-source.js";
import type {
  AgentHandler,
  DeliveryToken,
  HandlerRouteReceipt,
  ProviderContinuation,
  ResumeResult,
  SessionContext,
  SessionMessage,
  StartResult,
} from "./handler.js";
import { continuationResumeOptions } from "./handler.js";
import type { DeliveryRouteOwnership } from "./inbox-delivery-coordinator.js";
import {
  buildProviderRetryEvent,
  classifyProviderFailure,
  MANAGED_SKILLS_UNSAFE_DISCOVERY_REASON_CODE,
  type ProviderFailureClassification,
} from "./provider-retry-policy.js";
import { isContextSourceTransitionError } from "./provider-support/preparation.js";
import type { RouteTeardownAuthority } from "./route-teardown-authority.js";

export type SlotDeliveryKind = "fresh" | "recovery" | "control";

export type PendingMessage = {
  message: SessionMessage | null;
  chatId: string;
  deliveryKind: SlotDeliveryKind;
};

export type EvictedResumeMapping = {
  readonly claudeSessionId: string;
  readonly lastActivity: number;
  readonly continuation?: ProviderContinuation;
};

/**
 * Host-owned session identity the scheduler keys private slot state against.
 * Migrated retry/slot fields live only in {@link SlotSchedulerAuthority}'s
 * WeakMap — the host must not construct or mutate them.
 */
export type SlotSchedulerSessionEntry = {
  chatId: string;
  claudeSessionId: string;
  handler: AgentHandler;
  status: SessionState;
  lastActivity: number;
  suspending: Promise<void> | null;
  handlerStoppedBySuspend: AgentHandler | null;
};

type SlotState = {
  activeSlotHeld: boolean;
  retryAttempt: number;
  retryNextAt: number | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  lastRetryReason: string | null;
  lastRetryCategory: ProviderFailureClassification["category"] | null;
  lastRetryScope: "session_start" | "session_resume" | null;
  lastRetryRawError: string | null;
  retryHeadMessage: SessionMessage | null;
  deferredMessages: SessionMessage[];
  retryFromEvicted: EvictedResumeMapping | null;
};

function emptySlotState(resumeFromEvicted: EvictedResumeMapping | null): SlotState {
  return {
    activeSlotHeld: false,
    retryAttempt: 0,
    retryNextAt: null,
    retryTimer: null,
    lastRetryReason: null,
    lastRetryCategory: null,
    lastRetryScope: null,
    lastRetryRawError: null,
    retryHeadMessage: null,
    deferredMessages: [],
    retryFromEvicted: resumeFromEvicted
      ? {
          claudeSessionId: resumeFromEvicted.claudeSessionId,
          lastActivity: resumeFromEvicted.lastActivity,
          ...(resumeFromEvicted.continuation ? { continuation: { ...resumeFromEvicted.continuation } } : {}),
        }
      : null,
  };
}

export type SlotSchedulerInboxHost = {
  hasRecoveryDebt(chatId: string): boolean;
  hasProcessingOwnedWork(chatId: string): boolean;
  hasEntry(work: { chatId: string; messageId: string; entryId: number }): boolean;
  recoverIfNeeded(chatId: string, reason: string): void | Promise<void>;
  prepareEvict(chatId: string, reason: string): unknown;
};

export type SessionFailureHandling =
  | { kind: "retry" }
  | { kind: "terminal"; reasonCode: string; terminalEventPersisted: boolean };

export type SlotSchedulerAuthorityDeps = {
  log: pino.Logger;
  isShuttingDown: () => boolean;
  concurrency: () => number;
  maxSessions: () => number;
  idleTimeoutSec: () => number;
  workingGraceSec: () => number;
  hasLiveSubprocessProbe: (chatId: string) => boolean;
  isProviderRouteAdmissionFenced: (chatId: string) => boolean;
  getSession: (chatId: string) => SlotSchedulerSessionEntry | undefined;
  sessionsValues: () => IterableIterator<SlotSchedulerSessionEntry>;
  sessionsEntries: () => IterableIterator<[string, SlotSchedulerSessionEntry]>;
  sessionCount: () => number;
  dropLiveSession: (chatId: string) => void;
  inbox: SlotSchedulerInboxHost;
  routeTeardown: RouteTeardownAuthority;
  onSessionEvent?: (
    chatId: string,
    event: { kind: "error"; payload: { source: "runtime" | "sdk" | "tool"; message: string } },
  ) => void;
  suspendSession: (
    entry: SlotSchedulerSessionEntry,
    opts?: {
      reason: string;
      ackConsumedPrefix: boolean;
      drainQueue?: boolean;
      operatorResolution?: boolean;
    },
  ) => void;
  emitResilienceEvent: (chatId: string, eventName: string, payload: Record<string, unknown>) => void;
  routeMessage: (chatId: string, message: SessionMessage, deliveryKind: SlotDeliveryKind) => Promise<void>;
  resumeSession: (
    entry: SlotSchedulerSessionEntry,
    message: SessionMessage | undefined,
    deliveryKind: SlotDeliveryKind,
  ) => Promise<void>;
  retryDeliveryTurn: (chatId: string, messages: SessionMessage | readonly SessionMessage[], reason: string) => void;
  authorizeContextSource: () => Promise<ContextSourceAdmissionSnapshot>;
  createHandler: (admission: ContextSourceAdmissionSnapshot) => AgentHandler;
  recordHandlerSource: (entry: SlotSchedulerSessionEntry, sourceKey: string) => void;
  buildSessionContext: (
    chatId: string,
    lease: { mutationValid: () => boolean; settlementValid: () => boolean },
  ) => SessionContext;
  createDeliveryToken: (
    chatId: string,
    lease: { mutationValid: () => boolean; settlementValid: () => boolean },
  ) => DeliveryToken;
  setCurrentTrigger: (chatId: string, message: SessionMessage) => void;
  notifySessionState: (chatId: string, state: SessionState) => void;
  projectSessionRuntime: (chatId: string, opts?: { drainPendingOnIdle?: boolean }) => void;
  adoptResumeReceipt: (
    entry: SlotSchedulerSessionEntry,
    message: SessionMessage | null | undefined,
    receipt: { sessionId: string; route: Extract<HandlerRouteReceipt, { kind: "owned" }> | null },
    lostReason: string,
  ) => boolean;
  markRouteOwned: (chatId: string, message: SessionMessage, route: HandlerRouteReceipt) => DeliveryRouteOwnership;
  abortUnownedRoute: (entry: SlotSchedulerSessionEntry, reason: string) => void;
  handleSessionFailure: (args: {
    entry: SlotSchedulerSessionEntry;
    err: unknown;
    phase: "start" | "resume";
    classification: ProviderFailureClassification;
    attemptedMessage: SessionMessage | null;
  }) => Promise<SessionFailureHandling>;
  teardownTerminalSessionFailure: (
    entry: SlotSchedulerSessionEntry,
    message: SessionMessage | null,
    handling: Extract<SessionFailureHandling, { kind: "terminal" }>,
  ) => Promise<void>;
  drainDeferredMessages: (entry: SlotSchedulerSessionEntry) => void;
  persistRegistry: () => void;
  ensureImagesLocal: (message: SessionMessage) => Promise<void>;
  failSessionForRecovery: (
    chatId: string,
    reason: string,
    sessionId?: string,
    continuation?: ProviderContinuation,
  ) => void;
  runtimeProvider: () => RuntimeProvider;
  normalizeResumeReceipt: (result: ResumeResult) => {
    sessionId: string;
    route: Extract<HandlerRouteReceipt, { kind: "owned" }> | null;
    continuation?: ProviderContinuation;
  };
  normalizeStartReceipt: (result: StartResult) => {
    sessionId: string;
    route: Extract<HandlerRouteReceipt, { kind: "owned" }>;
    continuation?: ProviderContinuation;
  };
  recordEvictionResume: (chatId: string, mapping: EvictedResumeMapping | null) => void;
  getSessionRuntimeState: (chatId: string) => RuntimeState | undefined;
  recomputeRuntimeState: () => void;
};

function resumableProviderSessionId(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return null;
}

/**
 * Unique owner of retry single-flight, delivery-admission generations, pending
 * slot queue, active-slot accounting, and idle eviction timer. SessionRuntime
 * composes this; it must not keep parallel copies of these ledgers.
 */
export class SlotSchedulerAuthority {
  /**
   * Per-chat single-flight registry for `runRetry` executions. An overlapping
   * trigger (timer fire + immediate delivery trigger) joins the in-flight
   * execution instead of running a second one.
   */
  private readonly retryFlights = new Map<string, Promise<void>>();
  /** Monotonic fence for delivery work still inside the async admission pipeline. */
  private readonly admissionGenerations = new Map<string, number>();
  /** Messages waiting for an available concurrency / session slot. */
  private readonly pendingQueue: PendingMessage[] = [];
  /** Number of sessions currently holding an active slot. */
  private activeCount = 0;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  /** Authority-private per-session slot/retry state. Never escapes. */
  private readonly slotBySession = new WeakMap<SlotSchedulerSessionEntry, SlotState>();

  constructor(private readonly deps: SlotSchedulerAuthorityDeps) {}

  /**
   * A provider may expose a non-interruptible window after its input crossed
   * the provider boundary. Treat an observation failure as protected: force
   * retirement is a safety fallback, never a reason to risk duplicate effects.
   */
  private isProviderTurnActive(entry: SlotSchedulerSessionEntry): boolean {
    try {
      return entry.handler.isProviderTurnActive?.() === true;
    } catch (error) {
      this.deps.log.warn({ chatId: entry.chatId, error }, "provider turn liveness probe failed; protecting session");
      return true;
    }
  }

  /**
   * A canceled provider start/resume can materialize after its route fence.
   * Preserve an explicitly provider-safe continuation before the stale
   * handler is retired; generic receipts intentionally do not create a
   * resume mapping and retain the historical fresh-start behaviour.
   */
  private preserveStaleProviderContinuation(
    entry: SlotSchedulerSessionEntry,
    message: SessionMessage | null | undefined,
    receipt: { sessionId: string; continuation?: ProviderContinuation },
  ): void {
    const options = continuationResumeOptions(
      receipt.continuation,
      message,
      receipt.sessionId,
      this.deps.runtimeProvider(),
    );
    if (!options?.continuation) return;
    entry.claudeSessionId = receipt.sessionId;
    this.deps.recordEvictionResume(entry.chatId, {
      claudeSessionId: receipt.sessionId,
      lastActivity: entry.lastActivity,
      continuation: options.continuation,
    });
    this.deps.persistRegistry();
  }

  /**
   * Create (or replace) private slot/retry state for a live session. The host
   * never constructs these fields; resume-from-eviction is initialized here.
   */
  attachLiveSession(
    entry: SlotSchedulerSessionEntry,
    opts: { resumeFromEvicted?: EvictedResumeMapping | null } = {},
  ): void {
    const prior = this.slotBySession.get(entry);
    if (prior?.retryTimer) clearTimeout(prior.retryTimer);
    this.slotBySession.set(entry, emptySlotState(opts.resumeFromEvicted ?? null));
  }

  private slot(entry: SlotSchedulerSessionEntry): SlotState {
    const state = this.slotBySession.get(entry);
    if (!state) {
      throw new Error(`slot scheduler state missing for chat ${entry.chatId}`);
    }
    return state;
  }

  private peekSlot(entry: SlotSchedulerSessionEntry): SlotState | undefined {
    return this.slotBySession.get(entry);
  }

  isActiveSlotHeld(entry: SlotSchedulerSessionEntry): boolean {
    return this.peekSlot(entry)?.activeSlotHeld === true;
  }

  currentRetryAttempt(entry: SlotSchedulerSessionEntry): number {
    return this.peekSlot(entry)?.retryAttempt ?? 0;
  }

  resumeFallbackSessionId(entry: SlotSchedulerSessionEntry): string | null {
    return resumableProviderSessionId(this.peekSlot(entry)?.retryFromEvicted?.claudeSessionId);
  }

  hasResumableProviderSession(entry: SlotSchedulerSessionEntry): boolean {
    return resumableProviderSessionId(entry.claudeSessionId, this.resumeFallbackSessionId(entry)) !== null;
  }

  retryClassificationForEntry(entry: SlotSchedulerSessionEntry): ProviderFailureClassification {
    const state = this.slot(entry);
    return {
      category: state.lastRetryCategory ?? "unknown",
      reasonCode: state.lastRetryReason ?? "unknown",
      message: state.lastRetryRawError ?? state.lastRetryReason ?? "unknown",
      sourceKind: "transient",
    };
  }

  deferredMessageSnapshot(entry: SlotSchedulerSessionEntry): readonly SessionMessage[] {
    const state = this.peekSlot(entry);
    return state ? [...state.deferredMessages] : [];
  }

  hasArmedRetryTimer(entry: SlotSchedulerSessionEntry): boolean {
    return this.peekSlot(entry)?.retryTimer != null;
  }

  private isRetryEligible(entry: SlotSchedulerSessionEntry): boolean {
    const state = this.peekSlot(entry);
    if (!state) return false;
    return (
      entry.status === "suspended" &&
      !state.activeSlotHeld &&
      !this.deps.routeTeardown.hasInFlightTransition(entry) &&
      state.retryAttempt !== 0
    );
  }

  /**
   * Full retry-eligibility CAS used after every await on the retry install
   * path (teardown-debt settle, attachment rematerialization, replacement
   * stop). A terminate/reset/shutdown that wins during an await must cause
   * the stale retry to abandon: no new teardown debt, no second old-handler
   * shutdown, no fresh route.
   */
  private isRetryAdmissionOpen(
    chatId: string,
    entry: SlotSchedulerSessionEntry,
    expectedAdmissionGeneration?: number,
  ): boolean {
    return (
      !this.deps.isShuttingDown() &&
      !this.deps.isProviderRouteAdmissionFenced(chatId) &&
      (expectedAdmissionGeneration === undefined ||
        this.currentAdmissionGeneration(chatId) === expectedAdmissionGeneration) &&
      this.deps.getSession(chatId) === entry &&
      this.isRetryEligible(entry)
    );
  }

  getActiveCount(): number {
    return this.activeCount;
  }

  currentAdmissionGeneration(chatId: string): number {
    return this.admissionGenerations.get(chatId) ?? 0;
  }

  hasPendingTransientRetry(entry: SlotSchedulerSessionEntry): boolean {
    return (this.peekSlot(entry)?.retryAttempt ?? 0) > 0;
  }

  deferMessage(entry: SlotSchedulerSessionEntry, message: SessionMessage): void {
    this.slot(entry).deferredMessages.push(message);
  }

  takeDeferredMessages(entry: SlotSchedulerSessionEntry): SessionMessage[] {
    return this.slot(entry).deferredMessages.splice(0);
  }

  clearDeferredMessages(entry: SlotSchedulerSessionEntry): void {
    const state = this.peekSlot(entry);
    if (state) state.deferredMessages = [];
  }

  hasDeferredMessages(entry: SlotSchedulerSessionEntry): boolean {
    return (this.peekSlot(entry)?.deferredMessages.length ?? 0) > 0;
  }

  cancelRetryTimer(entry: SlotSchedulerSessionEntry): void {
    const state = this.peekSlot(entry);
    if (!state) return;
    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }

  cancelAllRetryTimers(): void {
    for (const session of this.deps.sessionsValues()) {
      this.cancelRetryTimer(session);
    }
  }

  /**
   * Arm transient-retry custody on the entry: persist the failed head, attempt
   * metadata, backoff deadline, and the retry timer. Host still sequences
   * slot release, status, projection, and event emit around this call.
   */
  scheduleTransientRetry(
    entry: SlotSchedulerSessionEntry,
    args: {
      attemptedMessage: SessionMessage | null;
      attempt: number;
      reasonCode: string;
      category: ProviderFailureClassification["category"];
      scope: "session_start" | "session_resume";
      rawError: string | null;
      delayMs: number;
    },
  ): void {
    const state = this.slot(entry);
    state.retryHeadMessage = args.attemptedMessage;
    state.retryAttempt = args.attempt;
    state.lastRetryReason = args.reasonCode;
    state.lastRetryCategory = args.category;
    state.lastRetryScope = args.scope;
    state.lastRetryRawError = args.rawError;
    state.retryNextAt = Date.now() + args.delayMs;
    if (state.retryTimer) clearTimeout(state.retryTimer);
    const chatId = entry.chatId;
    state.retryTimer = setTimeout(() => {
      const current = this.peekSlot(entry);
      if (current) current.retryTimer = null;
      this.runRetry(chatId).catch((retryErr) => {
        this.deps.log.warn({ chatId, retryErr }, "session retry failed");
      });
    }, args.delayMs);
  }

  /** Arm the idle-eviction interval (SessionRuntime starts this after construction). */
  startIdleEviction(intervalMs = 10_000): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => this.evictIdle(), intervalMs);
  }

  stopIdleEviction(): void {
    if (!this.idleTimer) return;
    clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  resetActiveCount(): void {
    this.activeCount = 0;
  }

  clearPendingQueueForChat(chatId: string): void {
    for (let i = this.pendingQueue.length - 1; i >= 0; i--) {
      if (this.pendingQueue[i]?.chatId === chatId) this.pendingQueue.splice(i, 1);
    }
  }

  hasQueuedChat(chatId: string): boolean {
    return this.pendingQueue.some((queued) => queued.chatId === chatId);
  }

  clearRetryAttemptState(entry: SlotSchedulerSessionEntry): void {
    const state = this.peekSlot(entry);
    if (!state) return;
    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.retryAttempt = 0;
    state.retryNextAt = null;
    state.retryTimer = null;
    state.lastRetryReason = null;
    state.lastRetryCategory = null;
    state.lastRetryScope = null;
    state.lastRetryRawError = null;
    state.retryHeadMessage = null;
  }

  clearRetryState(entry: SlotSchedulerSessionEntry): void {
    this.clearRetryAttemptState(entry);
    const state = this.peekSlot(entry);
    if (state) state.deferredMessages = [];
  }

  claimActiveSlot(entry: SlotSchedulerSessionEntry): void {
    const state = this.slot(entry);
    if (state.activeSlotHeld) return;
    state.activeSlotHeld = true;
    this.activeCount++;
  }

  releaseActiveSlot(entry: SlotSchedulerSessionEntry): boolean {
    const state = this.peekSlot(entry);
    if (!state?.activeSlotHeld) return false;
    state.activeSlotHeld = false;
    this.activeCount = Math.max(0, this.activeCount - 1);
    return true;
  }

  invalidateDeliveryAdmission(chatId: string): void {
    this.admissionGenerations.set(chatId, (this.admissionGenerations.get(chatId) ?? 0) + 1);
  }

  rearmRetryTimer(chatId: string, entry: SlotSchedulerSessionEntry, delayMs = 5_000): void {
    if (this.deps.isShuttingDown()) return;
    if (this.deps.isProviderRouteAdmissionFenced(chatId)) return;
    if (this.deps.getSession(chatId) !== entry) return;
    if (!this.isRetryEligible(entry)) return;
    const state = this.slot(entry);
    // Defensive: never overwrite a live handle with a duplicate timer.
    if (state.retryTimer !== null) return;
    state.retryNextAt = Date.now() + delayMs;
    state.retryTimer = setTimeout(() => {
      const current = this.peekSlot(entry);
      if (current) current.retryTimer = null;
      this.runRetry(chatId).catch((err) => {
        this.deps.log.warn({ chatId, err }, "session retry rearm failed");
      });
    }, delayMs);
  }

  runRetry(chatId: string): Promise<void> {
    // Single-flight per chat: the whole execution — including a failing
    // replacement shutdown and the re-arm timer it creates — must have
    // exactly one concurrent owner. Without this, two overlapping callers
    // (retry timer + immediate trigger) would both run the failure path
    // and each arm its own re-arm timer, the second handle overwriting the
    // first in `entry.retryTimer` and leaving an untracked timer that
    // manager shutdown cannot clear.
    const inFlight = this.retryFlights.get(chatId);
    if (inFlight) return inFlight;
    const flight = this.executeRetry(chatId);
    this.retryFlights.set(chatId, flight);
    void flight.then(
      () => {
        if (this.retryFlights.get(chatId) === flight) this.retryFlights.delete(chatId);
      },
      () => {
        if (this.retryFlights.get(chatId) === flight) this.retryFlights.delete(chatId);
      },
    );
    return flight;
  }

  async executeRetry(chatId: string): Promise<void> {
    const admissionGeneration = this.currentAdmissionGeneration(chatId);
    const entry = this.deps.getSession(chatId);
    if (!entry || !this.isRetryAdmissionOpen(chatId, entry, admissionGeneration)) return;
    if (this.deps.inbox.hasRecoveryDebt(chatId)) {
      this.clearRetryState(entry);
      await this.deps.inbox.recoverIfNeeded(chatId, "session_retry:recovery_debt");
      this.deps.projectSessionRuntime(chatId);
      return;
    }

    const slot = this.slot(entry);
    const retryHeadMessage = slot.retryHeadMessage;
    const previousSessionId = entry.claudeSessionId || slot.retryFromEvicted?.claudeSessionId || "";
    const retryRoute = previousSessionId
      ? { kind: "resume" as const, message: retryHeadMessage, previousSessionId }
      : retryHeadMessage
        ? { kind: "start" as const, message: retryHeadMessage }
        : null;
    if (
      retryHeadMessage?.inboxEntryId !== undefined &&
      !this.deps.inbox.hasEntry({
        chatId,
        messageId: retryHeadMessage.id,
        entryId: retryHeadMessage.inboxEntryId,
      })
    ) {
      this.deps.log.warn(
        {
          chatId,
          messageId: retryHeadMessage.id,
          entryId: retryHeadMessage.inboxEntryId,
        },
        "session retry head lost inbox custody; requesting recovery",
      );
      this.deps.failSessionForRecovery(chatId, "session_retry_head_custody_missing", previousSessionId);
      await this.deps.inbox.recoverIfNeeded(chatId, "session_retry_head_custody_missing");
      return;
    }
    if (!retryRoute) {
      this.deps.log.error({ chatId }, "session start retry has no input; requesting recovery");
      this.deps.failSessionForRecovery(chatId, "session_retry_head_missing");
      await this.deps.inbox.recoverIfNeeded(chatId, "session_retry_head_missing");
      return;
    }

    this.deps.log.info(
      {
        chatId,
        attempt: slot.retryAttempt,
        reasonCode: slot.lastRetryReason,
        category: slot.lastRetryCategory,
        resilienceEvent: "provider_retry_started",
      },
      "session transient retry — starting attempt",
    );
    // Design §6.1: emit via SessionContext.emitEvent (post-slot-acquire we
    // build the real ctx; here we use a lightweight onSessionEvent path).
    try {
      const scope =
        slot.lastRetryScope ?? (this.hasResumableProviderSession(entry) ? "session_resume" : "session_start");
      const classification = this.retryClassificationForEntry(entry);
      this.deps.onSessionEvent?.(chatId, {
        kind: "error",
        payload: {
          source: "runtime",
          message: encodeProviderRetryEventMessage(
            buildProviderRetryEvent({
              event: "provider_retry_started",
              provider: this.deps.runtimeProvider(),
              scope,
              classification,
              messagePreview: slot.lastRetryRawError,
            }),
          ),
        },
      });
    } catch (emitErr) {
      this.deps.log.warn({ chatId, emitErr }, "resilience retry_started emit failed");
    }

    // Route admission fence: settle this chat's teardown debt before the
    // retry builds a fresh handler. On failure keep retry custody — re-arm
    // with the same short-delay pass as slot contention below.
    if (!(await this.deps.routeTeardown.settleTeardownDebtBeforeRoute(chatId))) {
      this.rearmRetryTimer(chatId, entry);
      return;
    }

    // The settle awaited: re-validate before installing anything. A
    // terminate may have started while this retry waited on the debt — it
    // snapshots and drains the SAME debt and its producer quiesce has
    // already passed, so installing now would ack over a live fresh route.
    // Same for a manager shutdown. Abandon the install per the entry-guard
    // semantics at the top of this function: no new handler is installed,
    // and the retry choreography is left to whoever now owns the chat
    // (terminate clears the entry; shutdown clears the timers).
    if (!this.isRetryAdmissionOpen(chatId, entry, admissionGeneration)) return;

    // Re-materialize the retried head message's attachments: local cache hits
    // skip the network, still-missing bytes re-fetch, and the transient 404
    // availability set is rebuilt from this attempt instead of reusing the
    // failed delivery's verdicts. Control retries carry no head message.
    if (retryHeadMessage) await this.deps.ensureImagesLocal(retryHeadMessage);

    // The attachment fetch awaited: a concurrent Reset/terminate/shutdown
    // may have already cleared this session and finished draining. Re-run
    // the same fence/session-entry/status CAS before registering teardown
    // debt so a stale retry cannot add debt or shut down the old handler
    // after termination has acknowledged.
    if (!this.isRetryAdmissionOpen(chatId, entry, admissionGeneration)) return;

    // Fresh handler — the old one may have closed its SDK transport. But the
    // replaced handler must be CONFIRMED stopped before the fresh one is
    // installed, or the chat runs two live handlers. The debt is registered
    // BEFORE the stop starts: while the stop is in flight the entry is
    // slot-free, so an untracked stop would let a terminate ack (or a
    // manager shutdown return) over a handler whose stop has not settled.
    // The raw face clears the debt on a confirmed stop; a failure keeps it
    // (joinable for terminate/reconcile) and the retry keeps its custody
    // via the same re-arm as slot contention, instead of silently
    // continuing.
    this.deps.routeTeardown.registerPendingTeardown(chatId, entry.handler);
    try {
      await this.deps.routeTeardown.shutdownHandler(entry.handler, "session_retry_replace", { observeFailure: true });
      this.deps.routeTeardown.dropPendingTeardown(chatId, entry.handler);
    } catch (err) {
      this.deps.log.warn({ chatId, err }, "session retry replace-stop failed; keeping retry custody");
      this.rearmRetryTimer(chatId, entry);
      return;
    }
    // The stop awaited: re-run the FULL retry-eligibility CAS — a terminate
    // or manager shutdown may have started meanwhile, the entry may have
    // been replaced, and an overlapping runRetry (timer + immediate) may
    // already have installed the replacement route. Abandon the install
    // instead of opening a second provider route for the same retry head;
    // the winner's route owns the head's custody.
    if (!this.isRetryAdmissionOpen(chatId, entry, admissionGeneration)) return;

    // A retry is a fresh provider admission. Authorize after the old handler
    // is confirmed stopped, then repeat the generation/session CAS before a
    // replacement can claim capacity or publish a handler.
    let admission: ContextSourceAdmissionSnapshot;
    try {
      admission = await this.deps.authorizeContextSource();
    } catch (err) {
      this.deps.log.warn({ chatId, err }, "session retry Context source authorization failed");
      this.rearmRetryTimer(chatId, entry);
      return;
    }
    if (!this.isRetryAdmissionOpen(chatId, entry, admissionGeneration)) return;

    // Capacity decision LAST, immediately before the synchronous install.
    // Acquiring earlier would be a check-then-act race across chats: two
    // retries could both pass the check while each awaits its own
    // replacement stop (or while another route consumes the freed slot),
    // then both claim — exceeding the configured concurrency. With the
    // acquire directly adjacent to the claim (no await in between), the
    // invariant `activeCount <= concurrency` holds under any interleaving.
    // On failure the entry stays in transient-retry state and a future
    // retry / message will try again.
    if (!this.acquireActiveSlot(chatId, retryRoute.message, "recovery", { queueOnFailure: false })) {
      this.rearmRetryTimer(chatId, entry);
      return;
    }

    const newHandler = this.deps.createHandler(admission);
    entry.handler = newHandler;
    this.deps.recordHandlerSource(entry, admission.sourceKey);
    entry.status = "active";
    this.claimActiveSlot(entry);
    entry.lastActivity = Date.now();
    const transition = this.deps.routeTeardown.beginRouteTransition(entry, newHandler, retryRoute.kind);
    const mutationValid = () => this.deps.routeTeardown.isRouteAdoptionValid(entry, transition);
    const settlementValid = () => this.deps.routeTeardown.isDeliverySettlementLeaseValid(entry, transition);
    const routeLeases = { mutationValid, settlementValid };
    const ctx = this.deps.buildSessionContext(chatId, routeLeases);

    this.deps.notifySessionState(chatId, "active");
    this.deps.projectSessionRuntime(chatId, { drainPendingOnIdle: false });
    // Settle callback for the route producer, assigned as the FIRST
    // statement inside the try below: a throw before registration leaves no
    // producer behind, and everything after registration is covered by the
    // finally — so no throw can leave a producer that never settles.
    let settleRouteProducer: () => void = () => {};
    try {
      // Track the route producer: a canceled retry route can still
      // materialize late, and terminate / manager shutdown join this before
      // ack/return.
      settleRouteProducer = this.deps.routeTeardown.registerRouteProducer(chatId);
      if (retryHeadMessage) this.deps.setCurrentTrigger(chatId, retryHeadMessage);
      const token = retryHeadMessage ? this.deps.createDeliveryToken(chatId, routeLeases) : undefined;
      if (retryRoute.kind === "resume") {
        const continuationOptions = continuationResumeOptions(
          slot.retryFromEvicted?.continuation,
          retryHeadMessage,
          retryRoute.previousSessionId,
          this.deps.runtimeProvider(),
        );
        if (slot.retryFromEvicted?.continuation && !continuationOptions) {
          const mapping = {
            claudeSessionId: slot.retryFromEvicted.claudeSessionId,
            lastActivity: slot.retryFromEvicted.lastActivity,
            continuation: slot.retryFromEvicted.continuation,
          };
          this.deps.failSessionForRecovery(
            chatId,
            "session_retry_provider_continuation_mismatch",
            mapping.claudeSessionId,
          );
          this.deps.recordEvictionResume(chatId, mapping);
          this.deps.persistRegistry();
          return;
        }
        const resumeResult = token
          ? continuationOptions
            ? await newHandler.resume(
                retryHeadMessage ?? undefined,
                retryRoute.previousSessionId,
                ctx,
                token,
                continuationOptions,
              )
            : await newHandler.resume(retryHeadMessage ?? undefined, retryRoute.previousSessionId, ctx, token)
          : await newHandler.resume(undefined, retryRoute.previousSessionId, ctx);
        const receipt = this.deps.normalizeResumeReceipt(resumeResult);
        if (!this.deps.routeTeardown.isCurrentRouteTransition(entry, transition)) {
          this.preserveStaleProviderContinuation(entry, retryHeadMessage, receipt);
          this.deps.routeTeardown.discardStaleRouteTransition(
            entry.chatId,
            transition,
            "session_retry_resume_stale_completion",
          );
          return;
        }
        if (!this.deps.adoptResumeReceipt(entry, retryHeadMessage, receipt, "session_retry_resume_unowned_delivery")) {
          return;
        }
      } else {
        const receipt = this.deps.normalizeStartReceipt(
          await newHandler.start(retryRoute.message, ctx, this.deps.createDeliveryToken(chatId, routeLeases)),
        );
        if (!this.deps.routeTeardown.isCurrentRouteTransition(entry, transition)) {
          this.preserveStaleProviderContinuation(entry, retryRoute.message, receipt);
          this.deps.routeTeardown.discardStaleRouteTransition(
            entry.chatId,
            transition,
            "session_retry_start_stale_completion",
          );
          return;
        }
        entry.claudeSessionId = receipt.sessionId;
        if (this.deps.markRouteOwned(chatId, retryRoute.message, receipt.route) === "lost") {
          this.deps.abortUnownedRoute(entry, "session_retry_start_unowned_delivery");
          return;
        }
      }
      const totalAttempts = slot.retryAttempt;
      const succeededScope =
        slot.lastRetryScope ?? (this.hasResumableProviderSession(entry) ? "session_resume" : "session_start");
      const succeededClassification = this.retryClassificationForEntry(entry);
      if (!this.deps.routeTeardown.completeRouteTransition(entry, transition)) {
        this.deps.routeTeardown.discardStaleRouteTransition(entry.chatId, transition, "session_retry_stale_adoption");
        return;
      }
      this.clearRetryAttemptState(entry);
      this.deps.log.info(
        {
          chatId,
          sessionId: entry.claudeSessionId,
          resilienceEvent: "provider_retry_succeeded",
        },
        "session transient retry succeeded",
      );
      try {
        ctx.emitEvent({
          kind: "error",
          payload: {
            source: "runtime",
            message: encodeProviderRetryEventMessage(
              buildProviderRetryEvent({
                event: "provider_retry_succeeded",
                provider: this.deps.runtimeProvider(),
                scope: succeededScope,
                classification: succeededClassification,
                messagePreview: `retry succeeded after ${totalAttempts} attempt(s)`,
              }),
            ),
          },
        });
      } catch (emitErr) {
        this.deps.log.warn({ chatId, emitErr }, "resilience retry_succeeded emit failed");
      }
      this.deps.drainDeferredMessages(entry);
      this.deps.persistRegistry();
    } catch (err) {
      if (!this.deps.routeTeardown.isCurrentRouteTransition(entry, transition)) {
        this.deps.routeTeardown.discardStaleRouteTransition(entry.chatId, transition, "session_retry_stale_failure");
        return;
      }
      this.deps.routeTeardown.invalidateRouteTransition(entry, "session_retry_failed");
      if (isContextSourceTransitionError(err)) {
        this.deps.failSessionForRecovery(chatId, "session_context_source_changed", entry.claudeSessionId);
        return;
      }
      const phase = retryRoute.kind;
      const classification = classifyProviderFailure(err, {
        provider: this.deps.runtimeProvider(),
        scope: phase === "start" ? "session_start" : "session_resume",
        source: "session",
      });
      const handling = await this.deps.handleSessionFailure({
        entry,
        err,
        phase,
        classification,
        attemptedMessage: retryHeadMessage,
      });
      if (this.deps.getSession(chatId) !== entry) return;
      if (handling.kind === "terminal")
        await this.deps.teardownTerminalSessionFailure(entry, retryHeadMessage, handling);
    } finally {
      settleRouteProducer();
    }
  }

  /**
   * Cancel any pending retry timer and re-run the retry now. Used when a new
   * user message arrives for a chat in transient-retry mode — the message is
   * a strong signal that the user is waiting, so don't make them sit through
   * the rest of the backoff window.
   */
  triggerImmediateRetry(chatId: string): void {
    const entry = this.deps.getSession(chatId);
    if (!entry || !this.hasPendingTransientRetry(entry)) return;
    // Do not clear the sole re-arm timer while another retry flight still
    // owns the failure path that will install it.
    if (this.retryFlights.has(chatId)) return;
    const state = this.slot(entry);
    // Managed-Skill discovery safety is a local provider-preflight gate, not
    // an availability hint that newer input can bypass. Keep the original
    // head and FIFO tail behind the bounded timer so repeated deliveries or
    // resume commands cannot turn the safety wait into a hot retry loop.
    if (state.lastRetryReason === MANAGED_SKILLS_UNSAFE_DISCOVERY_REASON_CODE) return;
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    void this.runRetry(chatId);
  }

  acquireActiveSlot(
    chatId: string,
    message: SessionMessage | null,
    deliveryKind: SlotDeliveryKind = "fresh",
    opts: { queueOnFailure?: boolean } = {},
  ): boolean {
    if (this.activeCount < this.deps.concurrency()) return true;

    // Pick a victim, preferring (a) idle over working, and (b) within each
    // tier, sessions with no live background subprocess. A `run_in_background`
    // watcher cannot be recovered once its session is torn down, so a session
    // that has one is the worst thing to sacrifice — but it is still a valid
    // last-resort victim (the evictIdle hard cap bounds how long it could hold
    // the slot anyway), so we fall back to allowing it rather than starve the
    // requester. `protectSubprocess=false` is that fallback pass.
    const choose = (
      protectSubprocess: boolean,
    ): { victim: SlotSchedulerSessionEntry; kind: "idle" | "working" } | null => {
      const idle = this.findOldestActiveSession(
        (session) =>
          session.chatId !== chatId &&
          !this.isProviderTurnActive(session) &&
          !this.deps.inbox.hasProcessingOwnedWork(session.chatId) &&
          (!protectSubprocess || !this.hasLiveSubprocess(session.chatId)),
      );
      if (idle) return { victim: idle, kind: "idle" };
      if (deliveryKind === "fresh") {
        const working = this.findOldestActiveSession(
          (session) =>
            session.chatId !== chatId &&
            !this.isProviderTurnActive(session) &&
            (!protectSubprocess || !this.hasLiveSubprocess(session.chatId)),
        );
        if (working) return { victim: working, kind: "working" };
      }
      return null;
    };

    const chosen = choose(true) ?? choose(false);

    if (chosen?.kind === "idle") {
      this.deps.log.info(
        { chatId: chosen.victim.chatId, requesterChatId: chatId },
        "idle session yielded for concurrency",
      );
      this.deps.suspendSession(chosen.victim, {
        reason: "concurrency_idle_yield",
        ackConsumedPrefix: true,
        drainQueue: false,
      });
      return true;
    }

    if (chosen?.kind === "working") {
      this.deps.log.info(
        { chatId: chosen.victim.chatId, requesterChatId: chatId },
        "working session preempted for fresh input",
      );
      this.deps.emitResilienceEvent(chosen.victim.chatId, "resilience.session.preempted", {
        reason: "concurrency_preempted",
        requesterChatId: chatId,
      });
      this.deps.suspendSession(chosen.victim, {
        reason: "concurrency_preempted",
        ackConsumedPrefix: false,
        drainQueue: false,
      });
      return true;
    }

    if (opts.queueOnFailure !== false) {
      this.queueForSlot(chatId, message, deliveryKind, "concurrency_limit");
    }
    return false;
  }

  /**
   * Whether the session's provider currently has a live background subprocess,
   * per the optional {@link SubprocessProbe}. Absent probe => always false, so
   * suspend/eviction behave exactly as before the probe was introduced.
   */
  hasLiveSubprocess(chatId: string): boolean {
    return this.deps.hasLiveSubprocessProbe(chatId);
  }

  findOldestActiveSession(eligible: (session: SlotSchedulerSessionEntry) => boolean): SlotSchedulerSessionEntry | null {
    let oldest: SlotSchedulerSessionEntry | null = null;
    for (const session of this.deps.sessionsValues()) {
      if (session.status !== "active") continue;
      if (!eligible(session)) continue;
      if (!oldest || session.lastActivity < oldest.lastActivity) oldest = session;
    }
    return oldest;
  }

  queueForSlot(
    chatId: string,
    message: SessionMessage | null,
    deliveryKind: SlotDeliveryKind,
    reason: "concurrency_limit" | "max_sessions_all_working" | "terminal_teardown_pending",
  ): void {
    this.deps.log.info({ chatId, deliveryKind, reason }, "session slot unavailable, queuing");
    this.deps.emitResilienceEvent(chatId, "resilience.session.queued", { reason, deliveryKind });
    this.pendingQueue.push({ message, chatId, deliveryKind });
  }

  queuedMessageStillOwned(queued: PendingMessage): boolean {
    const { message, chatId } = queued;
    if (!message || message.inboxEntryId === undefined) return true;
    return this.deps.inbox.hasEntry({ chatId, messageId: message.id, entryId: message.inboxEntryId });
  }

  drainPendingQueue(): void {
    if (this.pendingQueue.length === 0) return;
    for (let index = this.pendingQueue.length - 1; index >= 0; index--) {
      const queued = this.pendingQueue[index];
      if (!queued || this.queuedMessageStillOwned(queued)) continue;
      this.deps.log.info(
        { chatId: queued.chatId, messageId: queued.message?.id, entryId: queued.message?.inboxEntryId },
        "dropping stale queued inbox delivery after recovery cleared local custody",
      );
      this.pendingQueue.splice(index, 1);
    }
    const nextIndex = this.pendingQueue.findIndex(
      (queued) => this.queuedMessageStillOwned(queued) && !this.deps.inbox.hasRecoveryDebt(queued.chatId),
    );
    if (nextIndex < 0) return;
    const next = this.pendingQueue[nextIndex];
    if (!next) return;
    const existing = this.deps.getSession(next.chatId);
    if (existing?.status === "active") {
      this.pendingQueue.splice(nextIndex, 1);
      if (!next.message) {
        this.drainPendingQueue();
        return;
      }
      this.deps.routeMessage(next.chatId, next.message, next.deliveryKind).catch((err) => {
        const hasInboxEntryId = next.message?.inboxEntryId !== undefined;
        this.deps.log.warn({ chatId: next.chatId, hasInboxEntryId, err }, "pending drain error");
        if (next.message && hasInboxEntryId) {
          this.deps.retryDeliveryTurn(next.chatId, next.message, "pending_drain_failed");
        } else {
          this.pendingQueue.unshift(next);
        }
      });
      return;
    }
    if (
      this.activeCount >= this.deps.concurrency() &&
      !this.findOldestActiveSession(
        (session) => session.chatId !== next.chatId && !this.deps.inbox.hasProcessingOwnedWork(session.chatId),
      )
    ) {
      return;
    }

    this.pendingQueue.splice(nextIndex, 1);
    if (!next.message) {
      const session = this.deps.getSession(next.chatId);
      if (session && session.status !== "active") {
        this.deps.resumeSession(session, undefined, next.deliveryKind).catch((err) => {
          this.deps.log.warn({ chatId: next.chatId, err }, "pending resume drain error");
          this.pendingQueue.unshift(next);
        });
      }
      return;
    }
    // Route asynchronously — the delivery work is already tracked by the
    // coordinator from the original `dispatch`.
    const message = next.message;
    this.deps.routeMessage(next.chatId, message, next.deliveryKind).catch((err) => {
      const hasInboxEntryId = message.inboxEntryId !== undefined;
      this.deps.log.warn({ chatId: next.chatId, hasInboxEntryId, err }, "pending drain error");
      if (hasInboxEntryId) {
        this.deps.retryDeliveryTurn(next.chatId, message, "pending_drain_failed");
      } else {
        this.pendingQueue.unshift(next);
      }
    });
  }

  evictIfNeeded(chatId?: string, message?: SessionMessage, deliveryKind: SlotDeliveryKind = "fresh"): boolean {
    const max_sessions = this.deps.maxSessions();
    if (this.deps.sessionCount() < max_sessions) return true;

    // Prefer non-active sessions, then idle active sessions. Working active
    // sessions are not memory-management victims: dropping them silently loses
    // replies/tool side effects unless their work is explicitly recovered.
    // Within idle active sessions, deprioritize ones with a live background
    // subprocess (their watcher's completion wake-up cannot be recovered after
    // a shutdown) — they are evicted only as a last resort.
    let nonActiveCandidate: { key: string; session: SlotSchedulerSessionEntry } | null = null;
    let idleActiveCandidate: { key: string; session: SlotSchedulerSessionEntry } | null = null;
    let idleActiveSubprocessCandidate: { key: string; session: SlotSchedulerSessionEntry } | null = null;
    for (const [key, session] of this.deps.sessionsEntries()) {
      // A chat with unresolved teardown debt is not a burden-free victim:
      // its detached handlers are still being confirmed stopped, so keep it
      // out of the candidate set (force-keep).
      if (this.deps.routeTeardown.hasPendingTeardown(key)) continue;
      // A lifecycle transition can mark an entry non-active before its
      // provider turn has crossed the terminal boundary. Keep that handler
      // protected regardless of the host session status.
      if (this.isProviderTurnActive(session)) continue;
      if (session.status !== "active") {
        if (!nonActiveCandidate || session.lastActivity < nonActiveCandidate.session.lastActivity) {
          nonActiveCandidate = { key, session };
        }
        continue;
      }
      if (!this.deps.inbox.hasProcessingOwnedWork(key)) {
        if (this.hasLiveSubprocess(key)) {
          if (
            !idleActiveSubprocessCandidate ||
            session.lastActivity < idleActiveSubprocessCandidate.session.lastActivity
          ) {
            idleActiveSubprocessCandidate = { key, session };
          }
        } else if (!idleActiveCandidate || session.lastActivity < idleActiveCandidate.session.lastActivity) {
          idleActiveCandidate = { key, session };
        }
      }
    }

    const candidate = nonActiveCandidate ?? idleActiveCandidate ?? idleActiveSubprocessCandidate;
    if (!candidate) {
      if (chatId && message) {
        this.queueForSlot(chatId, message, deliveryKind, "max_sessions_all_working");
      } else {
        this.deps.log.info({ maxSessions: max_sessions }, "max_sessions reached with no idle eviction candidate");
      }
      return false;
    }

    if (candidate) {
      this.deps.routeTeardown.invalidateRouteTransition(candidate.session, "session_evicted");
      // Preserve only an adopted, provider-neutral resume handle. Transition
      // phase is not sufficient: a fresh-start retry/terminal window has no
      // active start transition but still has no resumable provider session.
      const resumableSessionId = resumableProviderSessionId(
        candidate.session.claudeSessionId,
        this.resumeFallbackSessionId(candidate.session),
      );
      if (resumableSessionId) {
        this.deps.recordEvictionResume(candidate.key, {
          claudeSessionId: resumableSessionId,
          lastActivity: candidate.session.lastActivity,
        });
      } else {
        this.deps.recordEvictionResume(candidate.key, null);
      }

      this.deps.log.info({ chatId: candidate.key }, "session evicted (max_sessions reached)");
      const activeSlotHeld = this.isActiveSlotHeld(candidate.session);
      this.releaseActiveSlot(candidate.session);
      if (activeSlotHeld) {
        this.deps.routeTeardown.detachHandlerWithPendingTeardown(
          candidate.key,
          candidate.session.handler,
          "session_evicted",
        );
      } else {
        // A non-active handler is not shut down on eviction (existing
        // semantics), but its stop is unconfirmed — record the debt.
        this.deps.routeTeardown.registerPendingTeardown(candidate.key, candidate.session.handler);
      }
      // LRU eviction is local memory-management, not terminal operator intent,
      // so the wire state is `suspended` rather than `evicted`. Report it now:
      // waiting for a future bind leaves both lifecycle and runtime projections
      // stale when the socket stays healthy and this chat remains quiet.
      this.deps.dropLiveSession(candidate.key);
      this.deps.notifySessionState(candidate.key, "suspended");
      this.deps.inbox.prepareEvict(candidate.key, "session_evicted");
      this.deps.recomputeRuntimeState();
      this.deps.persistRegistry();
    }
    return true;
  }

  evictIdle(): void {
    const timeoutMs = this.deps.idleTimeoutSec() * 1000;
    const workingGraceMs = this.deps.workingGraceSec() * 1000;
    const now = Date.now();

    for (const [, session] of this.deps.sessionsEntries()) {
      if (session.status !== "active") continue;
      const inactiveMs = now - session.lastActivity;
      if (inactiveMs <= timeoutMs) continue;

      const currentState = this.deps.getSessionRuntimeState(session.chatId);
      const hasProcessingWork = this.deps.inbox.hasProcessingOwnedWork(session.chatId);
      const providerTurnActive = this.isProviderTurnActive(session);
      // A live background subprocess (e.g. a `run_in_background` watcher) is
      // real in-flight work even though no turn is processing: suspending would
      // close the provider stream and lose its completion wake-up.
      const hasLiveSubprocess = this.hasLiveSubprocess(session.chatId);

      // Hard cap: for sessions without an active provider turn, regardless of
      // other unsettled work, once we are past `idle_timeout +
      // working_grace_seconds` the slot MUST be reclaimed. A provider-entered
      // turn is the explicit exception: it stays alive until its terminal
      // provider boundary so a replacement cannot duplicate external effects.
      const pastHardCap = inactiveMs >= timeoutMs + workingGraceMs;

      if (providerTurnActive) {
        this.deps.log.info(
          { chatId: session.chatId, runtimeState: currentState, reason: "provider_turn_active" },
          "session idle threshold reached but provider turn is non-interruptible — skipping suspend",
        );
        continue;
      }

      if ((hasProcessingWork || hasLiveSubprocess) && !pastHardCap) {
        this.deps.log.info(
          {
            chatId: session.chatId,
            runtimeState: currentState,
            inactiveSec: Math.round(inactiveMs / 1000),
            graceSec: this.deps.workingGraceSec(),
            reason: hasProcessingWork ? "processing_work" : "live_subprocess",
          },
          "session idle threshold reached but work is still in flight — skipping suspend",
        );
        continue;
      }

      this.deps.log.info(
        {
          chatId: session.chatId,
          idleTimeoutSec: this.deps.idleTimeoutSec(),
          runtimeState: currentState ?? "idle",
          pastHardCap,
        },
        "session idle, suspending",
      );
      this.deps.suspendSession(session);
    }
  }
}
