import { join } from "node:path";
import type {
  AgentRuntimeConfig,
  InboxDeliverFrame,
  InboxEntryWithMessage,
  RuntimeState,
  SessionCommandAbortReason,
  SessionEvent,
  SessionRuntimeReport,
  SessionState,
} from "@first-tree/shared";
import { runtimeProviderSchema } from "@first-tree/shared";
import { defaultDataDir } from "@first-tree/shared/config";
import { createLogger, type pino } from "../cloud/observability/logger.js";
import type { FirstTreeHubSDK, RegisterResult } from "../cloud/sdk.js";
import { type AgentConfigCache, createAgentConfigCache } from "./agent-config-cache.js";
import type { BoundAgent, ClientConnection, SessionReconcileResult } from "./client-connection.js";
import type { SessionConfig } from "./config.js";
import { applyContextSourceToHandlerConfig, resolveAgentContextSource } from "./context-source.js";
import { clampRetryAttempt, classify, ERROR_KINDS, nextRetryDelayMs } from "./error-taxonomy.js";
import type { HandlerFactory } from "./handler.js";
import { PsSubprocessProbe } from "./process-tree-probe.js";
import { RuntimeSessionTokenFile } from "./runtime-session-token-file.js";
import { SessionRuntime, type SessionRuntimeShutdownOptions } from "./session-runtime.js";
import { acquireAgentHome } from "./workspace.js";

/**
 * Max attempts to fetch the agent's runtime config during bring-up before a
 * sustained transient failure aborts the bind. With the taxonomy's transient
 * backoff (1s base, exponential) this spans ~2 minutes of patient retry —
 * far beyond the SDK transport layer's ~1.5s budget, so a brief server blip
 * self-heals without a daemon restart, while a genuinely-down server still
 * gives up in bounded time instead of blocking bring-up forever.
 */
const MAX_CONFIG_FETCH_ATTEMPTS = 8;
const ACTIVE_RUNTIME_CHAT_IDS_REFRESH_MS = 60 * 60 * 1000;
const ACTIVE_RUNTIME_CHAT_IDS_REFRESH_JITTER_RATIO = 0.1;
const SESSION_RECONCILE_BATCH_SIZE = 500;
const RUNTIME_SWITCH_UNBOUND_REASON = "agent_runtime_switch";
const RUNTIME_SWITCH_STOP_OPTIONS = {
  sessionShutdown: {
    clearPersistedRegistry: true,
    reportSuspendedSessions: false,
  },
} satisfies AgentSlotStopOptions;

/**
 * Sleep `ms`, resolving early if `signal` aborts. Lets a stop()/unbind during
 * the bring-up retry window interrupt the backoff immediately instead of
 * waiting out the full delay. Resolves (never rejects); callers re-check
 * `signal.aborted` after awaiting.
 */
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function jitteredActiveRuntimeChatIdsRefreshDelay(): number {
  const offset =
    (Math.random() * 2 - 1) * ACTIVE_RUNTIME_CHAT_IDS_REFRESH_MS * ACTIVE_RUNTIME_CHAT_IDS_REFRESH_JITTER_RATIO;
  return ACTIVE_RUNTIME_CHAT_IDS_REFRESH_MS + offset;
}

export type AgentSlotConfig = {
  name: string;
  /** Agent UUID (from agent.yaml) — sent as X-Agent-Id on every HTTP call. */
  agentId: string;
  serverUrl: string;
  type: string;
  handlerFactory: HandlerFactory;
  session: SessionConfig;
  concurrency: number;
  /** Shared client connection (always present in unified-user-token milestone). */
  clientConnection: ClientConnection;
  runtimeType?: string;
  runtimeVersion?: string;
};

export type AgentSlotStopOptions = {
  sessionShutdown?: SessionRuntimeShutdownOptions;
};

type ConnectionListener =
  | { event: "inbox:deliver"; fn: (inboxId: string, frame: InboxDeliverFrame) => void }
  | { event: "agent:bound"; fn: (agent: BoundAgent) => void }
  | { event: "agent:unbound"; fn: (agentId: string, reason?: string) => void }
  | {
      event: "session:command";
      fn: (cmd: {
        agentId: string;
        chatId: string;
        type: "session:suspend" | "session:resume" | "session:terminate";
        ref?: string;
      }) => void;
    }
  | {
      event: "session:command:finalized";
      fn: (frame: {
        ref: string;
        ackRef: string;
        agentId: string;
        chatId: string;
        command: "session:terminate";
        state: "evicted";
      }) => void;
    }
  | {
      event: "session:command:aborted";
      fn: (frame: {
        ref: string;
        ackRef: string;
        agentId: string;
        chatId: string;
        command: "session:terminate";
        reason: SessionCommandAbortReason;
      }) => void;
    }
  | { event: "session:reconcile:result"; fn: (result: SessionReconcileResult) => void };

export class AgentSlot {
  private sessionRuntime: SessionRuntime | null = null;
  private readonly config: AgentSlotConfig;
  private readonly runtimeSessionTokenFile: string;
  private readonly runtimeSessionTokenStore: RuntimeSessionTokenFile;
  private runtimeSessionTokenDigest: string | null = null;
  private runtimeSessionTokenMutationError: unknown = null;
  /** ClientConnection emits and resolves the same BoundAgent object for the initial bind. */
  private readonly persistedBoundAgents = new WeakSet<BoundAgent>();
  private started = false;
  private logger: pino.Logger;
  private agentConfigCache: AgentConfigCache | null = null;
  private sdk: FirstTreeHubSDK | null = null;
  /** Managing human's visible/active chat set, used only for lifecycle reconcile. */
  private activeRuntimeChatIds: Set<string> | null = null;
  /** Server-active session rows, used to revoke disappeared per-chat runtime. */
  private activeSessionChatIds: Set<string> | null = null;
  private activeRuntimeChatIdsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private activeRuntimeChatIdsRefreshInFlight: Promise<void> | null = null;
  private activeRuntimeChatIdsRefreshGeneration = 0;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private postBindReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners: ConnectionListener[] = [];
  private stopping: Promise<void> | null = null;
  /** One agent-wide rebind serves every chat that observes the same stale proof. */
  private runtimeSessionProofRecoveryInFlight: Promise<void> | null = null;
  private readonly runtimeSessionTokenProvider = (): string | undefined => this.runtimeSessionTokenStore.read();
  /**
   * Aborts an in-flight bring-up config-fetch retry (see
   * {@link loadAgentConfigWithRetry}) so a stop()/unbind during the backoff
   * window doesn't have to wait out the current delay. Created in `start()`.
   */
  private bringupAbort: AbortController | null = null;
  /**
   * The inbox this slot's agent owns — used to filter `inbox:deliver`
   * frames addressed to other agents on the same client. Captured at
   * `start()` from `sdk.register()`.
   */
  private inboxId: string | null = null;

  constructor(config: AgentSlotConfig) {
    this.config = config;
    this.runtimeSessionTokenFile = join(defaultDataDir(), "runtime-session-tokens", `${config.agentId}.token`);
    this.runtimeSessionTokenStore = new RuntimeSessionTokenFile(this.runtimeSessionTokenFile);
    this.logger = createLogger("slot").child({ agentName: config.name, agentId: config.agentId });
  }

  get name(): string {
    return this.config.name;
  }

  get agentId(): string {
    return this.config.agentId;
  }

  private get clientConnection(): ClientConnection {
    return this.config.clientConnection;
  }

  /**
   * Snapshot of this slot's busy/idle state used by the UpdateManager's
   * quiet gate. Returns zeros before `start()` has built the session manager,
   * which is the same semantics: idle.
   */
  getQuietGateSnapshot(): { activeCount: number; lastActivityMs: number } {
    return this.sessionRuntime?.getQuietGateSnapshot() ?? { activeCount: 0, lastActivityMs: 0 };
  }

  async start(): Promise<RegisterResult> {
    this.started = false;
    this.runtimeSessionTokenMutationError = null;
    this.bringupAbort = new AbortController();
    this.clientConnection.setRuntimeSessionTokenProvider(this.config.agentId, this.runtimeSessionTokenProvider);
    // Attach listeners BEFORE `bindAgent` so the server's bind-time
    // reset+drain push (which fires within ~1ms of the `agent:bound`
    // response on the server side) never lands on a listener-less
    // emitter. Pre-PR the listeners were attached AFTER `bindAgent` +
    // `sdk.register` + `agentConfigCache.refresh` + binding resolution
    // (a 50ms+ window depending on server latency), and any
    // `inbox:deliver` frame arriving in that window was silently
    // dropped by Node's EventEmitter — the entry then stayed
    // `delivered` server-side and the in-process Deduplicator collapsed
    // every subsequent bind-reset replay (see
    // docs/inflight-message-recovery-design.md §4). The
    // `expectedInboxId` follows the agent-inbox naming convention from
    // `server/services/agents/identity.ts` (`inbox_${uuid}`); the live
    // `this.inboxId` from `sdk.register()` overrides once available.
    const expectedInboxId = `inbox_${this.config.agentId}`;
    const earlyDeliverBuffer: InboxDeliverFrame[] = [];

    const onInboxDeliver = (inboxId: string, frame: InboxDeliverFrame) => {
      // Pre-`sdk.register` we don't yet have the authoritative inboxId,
      // so fall back to the convention. Once `this.inboxId` is set, the
      // strict check resumes.
      const ownInboxId = this.inboxId ?? expectedInboxId;
      if (inboxId !== ownInboxId) return;
      if (!this.sessionRuntime) {
        // SessionRuntime isn't built yet — buffer the frame; we'll
        // flush below once the manager is alive.
        earlyDeliverBuffer.push(frame);
        return;
      }
      this.dispatchPushedFrame(frame).catch((err) => {
        this.logger.warn({ err, entryId: frame.entryId }, "inbox:deliver dispatch error");
      });
    };
    const onBound = (boundAgent: BoundAgent) => {
      if (boundAgent.agentId === this.config.agentId) {
        let runtimeSessionProofRefreshed = false;
        if (boundAgent.runtimeSessionToken) {
          if (!this.persistBoundRuntimeSessionToken(boundAgent)) {
            if (this.started) {
              void this.stop("runtime session token persistence failed").catch((err) => {
                this.logger.error({ err }, "failed to stop slot after runtime session token persistence failure");
              });
            }
            return;
          }
          if (boundAgent.sdk) this.adoptRuntimeTransport(boundAgent.sdk);
          runtimeSessionProofRefreshed = true;
        }
        if (runtimeSessionProofRefreshed && typeof this.sessionRuntime?.noteBindRecoveryComplete === "function") {
          this.sessionRuntime.noteBindRecoveryComplete();
        }
        // The first `agent:bound` can arrive while startup is still inside
        // sdk.register / config load / Context Tree sync, before
        // SessionRuntime exists. In that case the explicit startup
        // fullStateSync below owns both the state report and the delayed
        // reconcile. Reconnects with an existing SessionRuntime are handled
        // here.
        if (!this.sessionRuntime) return;
        void this.sessionRuntime.reconcileAckSettlementAfterBind?.().catch((err) => {
          this.logger.warn({ err }, "inbox ACK settlement rebind reconciliation failed; will retry on next bind");
        });
        // Replay-fence reconciliation on every (re)bind: an ACK committed
        // while this client was offline can leave a stale fence the startup
        // pass never revisits. Outstanding truth counts pending+delivered,
        // so running it before the bind drain is safe.
        void this.sessionRuntime.reconcileReplayFencesWithServer?.().catch((err) => {
          this.logger.warn({ err }, "replay fence rebind reconciliation failed; keeping fences (fail-closed)");
        });
        void this.refreshActiveRuntimeChatIds("bind").finally(() => {
          this.fullStateSync();
          this.scheduleActiveRuntimeChatIdsRefresh();
          // One-shot post-bind reconcile catches operator-terminates that
          // landed while this client was offline. It is deliberately scheduled
          // after fullStateSync, so just-hydrated registry mappings are first
          // advertised as suspended before the server is asked for stale rows.
          this.schedulePostBindReconcile();
        });
      }
    };
    const onReconcileResult = (result: SessionReconcileResult) => {
      if (result.agentId === this.config.agentId && this.sessionRuntime) {
        this.sessionRuntime.applyStaleChatIds(result.staleChatIds);
      }
    };
    const onUnbound = (agentId: string, reason?: string) => {
      if (agentId !== this.config.agentId || !reason) return;
      const stopOptions = reason === RUNTIME_SWITCH_UNBOUND_REASON ? RUNTIME_SWITCH_STOP_OPTIONS : undefined;
      this.stop(reason, stopOptions).catch((err) => {
        this.logger.error({ err, reason }, "forced agent stop failed");
      });
    };
    this.clientConnection.on("inbox:deliver", onInboxDeliver);
    this.clientConnection.on("agent:bound", onBound);
    this.clientConnection.on("agent:unbound", onUnbound);
    this.clientConnection.on("session:reconcile:result", onReconcileResult);
    this.listeners.push(
      { event: "inbox:deliver", fn: onInboxDeliver },
      { event: "agent:bound", fn: onBound },
      { event: "agent:unbound", fn: onUnbound },
      { event: "session:reconcile:result", fn: onReconcileResult },
    );

    let bindSucceeded = false;
    try {
      const runtimeType = this.config.runtimeType ?? this.config.type;
      const bound = await this.clientConnection.bindAgent(this.config.agentId, runtimeType, this.config.runtimeVersion);
      bindSucceeded = true;
      this.throwIfRuntimeSessionTokenMutationFailed();
      const sdk = bound.sdk;
      if (bound.runtimeSessionToken && !this.persistedBoundAgents.has(bound)) {
        this.persistBoundRuntimeSessionToken(bound);
        this.throwIfRuntimeSessionTokenMutationFailed();
      }
      this.adoptRuntimeTransport(sdk);
      const agent = await sdk.register();

      this.logger.info({ displayName: agent.displayName }, "agent bound");

      if (agent.type === "human") {
        this.logger.info("server reports type=human — message processing disabled");
        this.throwIfRuntimeSessionTokenMutationFailed();
        this.started = true;
        return agent;
      }

      this.agentConfigCache = createAgentConfigCache({ sdk, log: this.logger });
      this.adoptRuntimeTransport(sdk);
      const cfg = await this.loadAgentConfigWithRetry(agent.agentId);
      this.logger.info({ version: cfg.version }, "runtime config loaded");

      this.inboxId = agent.inboxId;
      // Per-agent home — also the parent of the agent-managed Context Tree
      // clone (`<workspaceRoot>/context-tree`) and source-repo clones.
      const workspaceRoot = join(defaultDataDir(), "workspaces", this.config.name);
      // Heal the trusted legacy runtime marker before Context resolution takes
      // the source-publication lock. Symlink/non-directory homes still fail
      // closed inside acquireAgentHome.
      acquireAgentHome(workspaceRoot);
      // Pure config resolution — no git. The agent itself materialises and
      // refreshes a remote clone per the protocol injected into its briefing.
      const contextSource = await resolveAgentContextSource(sdk, workspaceRoot, (msg) => this.logger.info(msg));
      if (contextSource.kind === "none") {
        this.logger.info(
          { reason: contextSource.reason },
          "context source unresolved — agent will start without organizational context",
        );
      }
      this.throwIfRuntimeSessionTokenMutationFailed();

      const registryPath = join(defaultDataDir(), "sessions", `${this.config.name}.json`);
      const replayFencePath = join(defaultDataDir(), "sessions", `${this.config.name}.replay-fence.json`);

      const ackEntry = (entryId: number) => this.clientConnection.sendInboxAck(entryId, agent.agentId);
      const recoverChat = async (chatId: string) => {
        return this.clientConnection.sendInboxRecover(agent.agentId, chatId);
      };
      const runtimeProvider = runtimeProviderSchema.safeParse(runtimeType);
      if (!runtimeProvider.success) {
        throw new Error(
          `Unsupported agent runtime type "${runtimeType}" — refusing to start SessionRuntime without a known RuntimeProvider`,
        );
      }

      // Defer idle-suspend while a provider has a live background subprocess
      // (default on; opt out via `session.defer_suspend_on_subprocess: false`).
      const subprocessProbe =
        this.config.session.defer_suspend_on_subprocess !== false
          ? new PsSubprocessProbe({ log: this.logger })
          : undefined;

      this.sessionRuntime = new SessionRuntime({
        session: this.config.session,
        concurrency: this.config.concurrency,
        subprocessProbe,
        handlerFactory: this.config.handlerFactory,
        handlerConfig: applyContextSourceToHandlerConfig(
          {
            workspaceRoot,
            agentName: this.config.name,
            runtimeProvider: runtimeProvider.data,
            // Identifies the owning client process. The claude-code-tui handler
            // uses it to scope tmux session ownership (orphan sweep / names) so
            // it never touches another live client's sessions. Other handlers
            // ignore it.
            clientId: this.clientConnection.clientId,
          },
          contextSource,
        ),
        resolveContextSource: () => resolveAgentContextSource(sdk, workspaceRoot, (msg) => this.logger.info(msg)),
        agentIdentity: {
          agentId: agent.agentId,
          inboxId: agent.inboxId,
          displayName: agent.displayName,
          type: agent.type,
          visibility: agent.visibility,
          delegateMention: agent.delegateMention,
          metadata: agent.metadata,
        },
        sdk,
        log: this.logger,
        registryPath,
        replayFencePath,
        agentConfigCache: this.agentConfigCache,
        runtimeSessionTokenFile: this.runtimeSessionTokenFile,
        ackEntry,
        recoverChat,
        probeFencedSettlement: async (chatId, messageIds) => {
          const result = await this.clientConnection.sendInboxFenceProbe(agent.agentId, chatId, [...messageIds]);
          return result.settledMessageIds;
        },
        recoverRuntimeSessionProof: (reasonCode) => this.recoverRuntimeSessionProof(reasonCode),
        onStateChange: (chatId, state) => this.reportSessionState(chatId, state),
        onRuntimeStateChange: (state) => this.reportRuntimeState(state),
        onSessionEvent: (chatId, event) => this.reportSessionEvent(chatId, event),
        confirmSessionEvent: (chatId, event) => this.confirmSessionEvent(chatId, event),
        onSessionRuntimeChange: (chatId, report) => this.reportSessionRuntime(chatId, report),
      });

      const onCommand = (cmd: {
        agentId: string;
        chatId: string;
        type: "session:suspend" | "session:resume" | "session:terminate";
        ref?: string;
      }) => {
        if (cmd.agentId !== this.config.agentId || !this.sessionRuntime) return;
        if (cmd.type === "session:terminate" && cmd.ref) {
          // Apply-ack path (chat-session Reset): the server holds the HTTP
          // request open until this ack lands, so the ack must only fire
          // after handleCommand has fully resolved — handler stopped,
          // provider-session mapping dropped. A failed apply reports
          // applied:false so the operator can retry; never ack early.
          // Parked Reset-fence recovery must wait for an exact receipted
          // post-apply terminal disposition (`session:command:finalized` or
          // `session:command:aborted`), not local success or the applied send alone.
          const ref = cmd.ref;
          if (!this.clientConnection.supportsSessionResetV1) {
            // Old server, new client: nothing would ever send a terminal
            // disposition frame, so applying here would destroy the session and
            // leave any intervening delivery parked behind a fence forever.
            // Refuse BEFORE the destructive apply and let the Reset fail closed.
            this.logger.warn(
              { chatId: cmd.chatId, ref },
              "refusing ref'd Reset: this connection did not negotiate the v1 Reset protocol",
            );
            this.clientConnection.reportSessionCommandApplied({
              ref,
              agentId: cmd.agentId,
              chatId: cmd.chatId,
              command: "session:terminate",
              applied: false,
            });
            return;
          }
          this.sessionRuntime
            .handleCommand(cmd.chatId, cmd.type, { resetRef: ref })
            .then(() => {
              this.clientConnection.reportSessionCommandApplied({
                ref,
                agentId: cmd.agentId,
                chatId: cmd.chatId,
                command: "session:terminate",
                applied: true,
              });
            })
            .catch((err) => {
              this.logger.error({ err, chatId: cmd.chatId, type: cmd.type }, "session command error");
              this.clientConnection.reportSessionCommandApplied({
                ref,
                agentId: cmd.agentId,
                chatId: cmd.chatId,
                command: "session:terminate",
                applied: false,
              });
            });
          return;
        }
        if (cmd.type === "session:terminate") {
          // Legacy unref'd terminate: the server archived and finalized this
          // session before sending the command, so it carries its own
          // authority to retire whatever Reset generation is armed. That is
          // an explicit supersede, not the incidental unref'd release — a
          // finalized frame for the superseded generation is then ignored.
          this.sessionRuntime
            .handleCommand(cmd.chatId, cmd.type)
            .then(() => {
              this.sessionRuntime?.supersedeResetGeneration(cmd.chatId, "unrefd_server_terminate");
            })
            .catch((err) => {
              this.logger.error({ err, chatId: cmd.chatId, type: cmd.type }, "session command error");
            });
          return;
        }
        this.sessionRuntime.handleCommand(cmd.chatId, cmd.type).catch((err) => {
          this.logger.error({ err, chatId: cmd.chatId, type: cmd.type }, "session command error");
        });
      };
      this.clientConnection.on("session:command", onCommand);
      this.listeners.push({ event: "session:command", fn: onCommand });

      /**
       * Apply one post-apply Reset disposition — `finalized` (the eviction
       * committed) or `aborted` (the server could not finalize) — and answer it.
       *
       * Both dispositions do the SAME thing locally, because the local truth is
       * the same in both: this client already destroyed its provider session
       * when it acked `applied: true`, so all that is left is to lift the exact
       * generation that fenced provider admission afterwards. Abort therefore
       * restores nothing; it just lets the parked durable row recover once into
       * a fresh nonce-derived session.
       *
       * The SessionRuntime is the single Reset-generation authority: it knows
       * which refs are aliases of the current generation, which one superseded
       * which, and whether the fence actually came down. The slot asks and
       * reports that verdict verbatim — keeping a second map here is what let
       * the receipt disagree with the fence. `idempotent` is still a released
       * fence (duplicate disposition), `stale` is not. The server needs SOME
       * receipt either way, or its request would hang until timeout.
       */
      const settleResetDisposition = (
        kind: "finalized" | "aborted",
        frame: { ref: string; ackRef: string; agentId: string; chatId: string },
      ): void => {
        if (frame.agentId !== this.config.agentId || !this.sessionRuntime) return;
        const verdict = this.sessionRuntime.releaseParkedResetFenceRecovery(frame.chatId, frame.ref);
        const released = verdict === "accepted" || verdict === "idempotent";
        if (!released) {
          this.logger.warn(
            { chatId: frame.chatId, ref: frame.ref, verdict, disposition: kind },
            "Reset disposition did not release this client's fence",
          );
        }
        const receipt = {
          ref: frame.ref,
          ackRef: frame.ackRef,
          agentId: frame.agentId,
          chatId: frame.chatId,
          command: "session:terminate" as const,
          released,
        };
        if (kind === "aborted") this.clientConnection.reportSessionCommandAbortedAck(receipt);
        else this.clientConnection.reportSessionCommandFinalizedAck(receipt);
      };

      const onCommandFinalized = (frame: {
        ref: string;
        ackRef: string;
        agentId: string;
        chatId: string;
        command: "session:terminate";
        state: "evicted";
      }) => settleResetDisposition("finalized", frame);
      this.clientConnection.on("session:command:finalized", onCommandFinalized);
      this.listeners.push({ event: "session:command:finalized", fn: onCommandFinalized });

      const onCommandAborted = (frame: {
        ref: string;
        ackRef: string;
        agentId: string;
        chatId: string;
        command: "session:terminate";
        reason: SessionCommandAbortReason;
      }) => {
        if (frame.agentId === this.config.agentId) {
          this.logger.info(
            { chatId: frame.chatId, ref: frame.ref, reason: frame.reason },
            "server aborted an applied Reset; releasing that generation without an eviction",
          );
        }
        settleResetDisposition("aborted", frame);
      };
      this.clientConnection.on("session:command:aborted", onCommandAborted);
      this.listeners.push({ event: "session:command:aborted", fn: onCommandAborted });

      // Flush any `inbox:deliver` frames the early listener captured
      // during init. With the bind-time reset+drain path (see design §4)
      // the server pushes pending entries the instant it processes the
      // `agent:bind` frame, but the surrounding `sdk.register` +
      // `agentConfigCache.refresh` + `resolveAgentContextTreeBinding` chain
      // above can take from ~100ms up to multiple seconds on a slow
      // server round-trip. Without this flush every restart with
      // an un-acked in-flight message lost the recovery push and the
      // server row stayed `delivered` indefinitely — the in-process
      // Deduplicator absorbed every subsequent bind-reset replay so the
      // entry never re-dispatched and never acked.
      if (earlyDeliverBuffer.length > 0) {
        this.logger.info(
          { buffered: earlyDeliverBuffer.length },
          "flushing early inbox:deliver buffer — frames received during init window",
        );
        for (const frame of earlyDeliverBuffer.splice(0)) {
          this.dispatchPushedFrame(frame).catch((err) => {
            this.logger.warn({ err, entryId: frame.entryId }, "buffered inbox:deliver dispatch error");
          });
        }
      }

      // Crash-safe replay-fence reconciliation: a fence whose delivery was
      // ACKed just before a crash would otherwise stall its chat forever.
      // Server ACK truth (inbox recovery reset count) decides; failures keep
      // fences fail-closed. Optional-call: slot tests stub a partial manager.
      await this.sessionRuntime.reconcileReplayFencesWithServer?.().catch((err) => {
        this.logger.warn({ err }, "replay fence startup reconciliation failed; keeping fences (fail-closed)");
      });

      await this.refreshActiveRuntimeChatIds("startup");
      // Initial-startup fullStateSync. The `on("agent:bound", onBound)`
      // listener above also fires here now that it's attached pre-bind,
      // but `sessionRuntime` was null inside its callback — so its
      // `fullStateSync()` call was a no-op. Run it explicitly now that
      // the manager exists.
      this.fullStateSync();
      this.schedulePostBindReconcile();

      this.scheduleActiveRuntimeChatIdsRefresh();
      this.startReconcileLoop();

      this.throwIfRuntimeSessionTokenMutationFailed();
      this.started = true;
      return agent;
    } catch (err) {
      await this.cleanupFailedStart({ unbind: bindSucceeded });
      throw err;
    }
  }

  /**
   * Fetch the agent's runtime config during bring-up, retrying transient
   * failures with capped exponential backoff instead of killing the slot on
   * the first error. This fetch runs only after the WebSocket has connected
   * and the agent has bound, so a failure here is almost always a brief server
   * blip (5xx, a slow PG query, a network stutter) — the same class of failure
   * {@link ClientConnection.connect} already rides out with an in-process retry
   * loop. Pre-fix, one blip threw, aborted the bind, and left the agent offline
   * until a daemon restart — a root cause of onboarding's "unanswered first
   * chat".
   *
   * Transient failures retry up to {@link MAX_CONFIG_FETCH_ATTEMPTS}; permanent
   * or degraded failures (4xx auth / not-found, classified by the shared error
   * taxonomy) abort immediately with a clear reason rather than retrying a
   * request that cannot succeed.
   */
  private async loadAgentConfigWithRetry(agentId: string): Promise<AgentRuntimeConfig> {
    const cache = this.agentConfigCache;
    if (!cache) throw new Error("agent config cache not initialised");
    const signal = this.bringupAbort?.signal;
    let attempt = 0;
    while (true) {
      try {
        const cfg = await cache.refresh(agentId);
        // A stop()/unbind may have fired while the fetch was in flight (the
        // retry window is up to ~2 min); don't build a live session for a slot
        // that is already tearing down.
        if (signal?.aborted) throw new Error("agent config fetch aborted — slot stopping");
        return cfg;
      } catch (err) {
        if (signal?.aborted) throw new Error("agent config fetch aborted — slot stopping");
        attempt++;
        const classification = classify(err, { source: "config" });
        if (classification.kind !== ERROR_KINDS.TRANSIENT) {
          this.logger.error(
            { err, reasonCode: classification.reasonCode },
            "agent config fetch rejected — bind aborted",
          );
          throw new Error(
            `First Tree server rejected agent config (${classification.reasonCode}): ${classification.message}`,
          );
        }
        if (attempt >= MAX_CONFIG_FETCH_ATTEMPTS) {
          this.logger.error(
            { err, attempts: attempt, reasonCode: classification.reasonCode },
            "agent config fetch exhausted retries — bind aborted",
          );
          throw new Error(
            `First Tree server unreachable while loading agent config after ${attempt} attempts: ${classification.message}`,
          );
        }
        const delayMs = nextRetryDelayMs(classification.strategy, clampRetryAttempt(attempt));
        this.logger.warn(
          { err, attempt, delayMs, reasonCode: classification.reasonCode },
          "agent config fetch failed — retrying with backoff",
        );
        await sleepWithAbort(delayMs, signal);
        if (signal?.aborted) throw new Error("agent config fetch aborted — slot stopping");
      }
    }
  }

  private adoptRuntimeTransport(sdk: FirstTreeHubSDK): void {
    this.sdk = sdk;
    this.activeRuntimeChatIdsRefreshGeneration++;
    this.activeRuntimeChatIdsRefreshInFlight = null;
    if (this.activeRuntimeChatIdsRefreshTimer) {
      clearTimeout(this.activeRuntimeChatIdsRefreshTimer);
      this.activeRuntimeChatIdsRefreshTimer = null;
    }
    this.agentConfigCache?.updateSdk(sdk);
    this.sessionRuntime?.updateTransport(sdk, this.agentConfigCache ?? undefined);
  }

  private recoverRuntimeSessionProof(reasonCode: string): Promise<void> {
    const existing = this.runtimeSessionProofRecoveryInFlight;
    if (existing) return existing;
    if (this.stopping || this.bringupAbort?.signal.aborted) {
      return Promise.reject(new Error("runtime-session proof recovery skipped because the agent slot is stopping"));
    }

    const runtimeType = this.config.runtimeType ?? this.config.type;
    this.logger.warn({ reasonCode }, "runtime-session proof rejected; requesting a fresh agent bind");
    let recovery: Promise<void>;
    recovery = this.clientConnection
      .bindAgent(this.config.agentId, runtimeType, this.config.runtimeVersion)
      .then(() => {
        this.logger.info({ reasonCode }, "runtime-session proof recovered through agent rebind");
      })
      .finally(() => {
        if (this.runtimeSessionProofRecoveryInFlight === recovery) {
          this.runtimeSessionProofRecoveryInFlight = null;
        }
      });
    this.runtimeSessionProofRecoveryInFlight = recovery;
    return recovery;
  }

  private persistBoundRuntimeSessionToken(boundAgent: BoundAgent): boolean {
    if (!boundAgent.runtimeSessionToken || this.persistedBoundAgents.has(boundAgent)) return true;
    try {
      const digest = this.runtimeSessionTokenStore.persist(boundAgent.runtimeSessionToken);
      this.runtimeSessionTokenDigest = digest;
      this.persistedBoundAgents.add(boundAgent);
      return true;
    } catch (err) {
      this.runtimeSessionTokenMutationError = err;
      this.logger.error({ err }, "failed to persist runtime session token — slot unavailable");
      return false;
    }
  }

  private throwIfRuntimeSessionTokenMutationFailed(): void {
    if (!this.runtimeSessionTokenMutationError) return;
    throw new Error("Runtime session token persistence failed; the agent slot cannot become healthy.", {
      cause: this.runtimeSessionTokenMutationError,
    });
  }

  private cleanupOwnedRuntimeSessionToken(): void {
    const digest = this.runtimeSessionTokenDigest;
    this.runtimeSessionTokenDigest = null;
    if (!digest) return;
    try {
      this.runtimeSessionTokenStore.removeIfOwned(digest);
    } catch (err) {
      this.logger.warn({ err }, "runtime session token cleanup failed; leaving any remaining file untouched");
    }
  }

  async stop(reason?: string, opts: AgentSlotStopOptions = {}): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopOnce(reason, opts);
    try {
      await this.stopping;
    } finally {
      this.stopping = null;
    }
  }

  private async stopOnce(reason?: string, opts: AgentSlotStopOptions = {}): Promise<void> {
    this.started = false;
    this.bringupAbort?.abort();
    this.activeRuntimeChatIdsRefreshGeneration++;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.activeRuntimeChatIdsRefreshTimer) {
      clearTimeout(this.activeRuntimeChatIdsRefreshTimer);
      this.activeRuntimeChatIdsRefreshTimer = null;
    }
    if (this.postBindReconcileTimer) {
      clearTimeout(this.postBindReconcileTimer);
      this.postBindReconcileTimer = null;
    }
    for (const entry of this.listeners) {
      this.clientConnection.off(entry.event, entry.fn);
    }
    this.listeners = [];
    // The armed Reset generations die with the SessionRuntime below, so a
    // finalized/aborted frame arriving after a restart belongs to a manager
    // that no longer exists and cannot release anything the new one parked.
    let firstError: unknown = null;
    // Settle provider-entered custody (durable notice + ACK) while the agent is
    // still bound *and* the dynamic runtime-session proof provider is still
    // registered. Clearing the provider first falls the bound SDK back to a
    // possibly-stale bind-time token, so notice HTTP can fail closed and leave
    // the entered turn unacked for reconnect replay.
    try {
      try {
        await this.sessionRuntime?.shutdown(reason, opts.sessionShutdown);
      } catch (err) {
        firstError = err;
        this.logger.warn({ err }, "failed to shut down sessions while stopping");
      }
      try {
        await this.clientConnection.unbindAgent(this.config.agentId);
      } catch (err) {
        firstError ??= err;
        this.logger.warn({ err }, "failed to unbind agent while stopping");
      }
    } finally {
      // Cleanup runs exactly once even when drain/unbind fails — but never before
      // SessionRuntime.shutdown has joined (success or failure).
      this.clientConnection.clearRuntimeSessionTokenProvider(this.config.agentId, this.runtimeSessionTokenProvider);
      this.cleanupOwnedRuntimeSessionToken();
      this.sessionRuntime = null;
      this.agentConfigCache = null;
      this.sdk = null;
      this.activeRuntimeChatIds = null;
      this.activeSessionChatIds = null;
      this.activeRuntimeChatIdsRefreshInFlight = null;
      this.inboxId = null;
    }
    this.logger.info("stopped");
    if (firstError) throw firstError;
  }

  private async cleanupFailedStart(opts: { unbind: boolean }): Promise<void> {
    this.started = false;
    this.bringupAbort?.abort();
    this.activeRuntimeChatIdsRefreshGeneration++;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.activeRuntimeChatIdsRefreshTimer) {
      clearTimeout(this.activeRuntimeChatIdsRefreshTimer);
      this.activeRuntimeChatIdsRefreshTimer = null;
    }
    if (this.postBindReconcileTimer) {
      clearTimeout(this.postBindReconcileTimer);
      this.postBindReconcileTimer = null;
    }
    for (const entry of this.listeners) {
      this.clientConnection.off(entry.event, entry.fn);
    }
    this.listeners = [];
    try {
      try {
        await this.sessionRuntime?.shutdown();
      } catch (err) {
        this.logger.warn({ err }, "failed to shut down sessions after aborted agent start");
      }
      if (opts.unbind) {
        try {
          await this.clientConnection.unbindAgent(this.config.agentId);
        } catch (err) {
          this.logger.warn({ err }, "failed to unbind after aborted agent start");
        }
      }
    } finally {
      this.clientConnection.clearRuntimeSessionTokenProvider(this.config.agentId, this.runtimeSessionTokenProvider);
      this.cleanupOwnedRuntimeSessionToken();
      this.sessionRuntime = null;
      this.agentConfigCache = null;
      this.sdk = null;
      this.activeRuntimeChatIds = null;
      this.activeSessionChatIds = null;
      this.activeRuntimeChatIdsRefreshInFlight = null;
      this.inboxId = null;
      this.runtimeSessionTokenMutationError = null;
    }
  }

  private reportSessionState(chatId: string, state: SessionState): void {
    this.clientConnection.reportSessionState(this.config.agentId, chatId, state);
  }

  private reportRuntimeState(state: RuntimeState): void {
    this.clientConnection.reportRuntimeState(this.config.agentId, state);
  }

  private reportSessionEvent(chatId: string, event: SessionEvent): void {
    this.clientConnection.reportSessionEvent(this.config.agentId, chatId, event);
  }

  private confirmSessionEvent(chatId: string, event: SessionEvent): Promise<void> {
    return this.clientConnection.reportSessionEventConfirmed(this.config.agentId, chatId, event);
  }

  private reportSessionRuntime(chatId: string, report: SessionRuntimeReport): void {
    this.clientConnection.reportSessionRuntime(this.config.agentId, chatId, report);
  }

  private fullStateSync(): void {
    if (!this.sessionRuntime) return;
    const activeChatIds = this.activeRuntimeChatIds;
    const activeSessionChatIds = this.activeSessionChatIds;
    // ORDERING IS LOAD-BEARING: `session:state` frames flush before any
    // `session:runtime` frame so the server's `setSessionRuntime` (gated
    // on `state='active'`) can't fail-close because the state write
    // hadn't landed yet. TCP/WS preserves the order across this single
    // send loop, and the server-side `chainSessionOp` per-(agent,chat)
    // queue preserves it through the processing pipeline as well.
    for (const { chatId, state } of this.sessionRuntime.getSessionStates(activeChatIds)) {
      this.clientConnection.reportSessionState(this.config.agentId, chatId, state);
    }
    // After a process restart `sessions` is empty but SessionRegistry just
    // hydrated every persisted (chatId → claudeSessionId) row into
    // `evictedMappings`. Without this loop, the server's
    // `agent_chat_sessions.state` would stay on the pre-restart snapshot
    // (commonly `active`) forever — the next inbound message would only
    // refresh that one row, leaving the rest stale. "suspended" is the
    // closest in-schema state for "handler is gone but resumable".
    for (const chatId of this.sessionRuntime.getEvictedChatIds(activeChatIds)) {
      this.clientConnection.reportSessionState(this.config.agentId, chatId, "suspended");
    }
    // Re-assert the *real* per-chat runtime of every still-live local session,
    // not only the active chat set. This is the reconnect repair path for a
    // lost `working -> idle` transition: the local process may have already
    // closed the turn while the WS was half-open, so the one idle frame can be
    // dropped before the disconnect is observed. A later bind must therefore
    // re-send every held runtime projection and let the server's active-row
    // gate ignore irrelevant/stale chats.
    //
    // This intentionally differs from the lifecycle sync above: lifecycle rows
    // stay filtered to the user's active working set, while runtime rows are
    // cheap idempotent repairs for any chat the local SessionRuntime still
    // holds.
    const runtimeStates = this.sessionRuntime.getSessionRuntimeStates(null);
    const reportedRuntimeChatIds = new Set<string>();
    for (const { chatId, runtimeState, backgroundWork } of runtimeStates) {
      reportedRuntimeChatIds.add(chatId);
      // Normalize at the boundary: the snapshot is the reconnect repair path,
      // and a missing marker must go on the wire as an explicit `false` rather
      // than as `undefined`.
      this.clientConnection.reportSessionRuntime(this.config.agentId, chatId, {
        runtimeState,
        backgroundWork: backgroundWork === true,
      });
    }
    // The server's complete active-session set is the reconnect catch-up scope.
    // It is deliberately separate from `activeChatIds`, which is filtered by
    // the managing human's workspace visibility and remains lifecycle-only.
    // An active server row omitted from the local runtime snapshot means the
    // old local projection disappeared (for example after process restart or
    // registry loss), so revoke it explicitly instead of waiting for stale
    // recovery.
    // The server's active-row gate makes idle reports for chats without a
    // current session harmless and idempotent.
    if (activeSessionChatIds) {
      for (const chatId of activeSessionChatIds) {
        if (!reportedRuntimeChatIds.has(chatId)) {
          // Revocation: no local session, therefore nothing parked either.
          this.clientConnection.reportSessionRuntime(this.config.agentId, chatId, {
            runtimeState: "idle",
            backgroundWork: false,
          });
        }
      }
    }
    // Explicit "idle" clears any stale `working`/`blocked` on the server:
    // any in-flight work owned by the previous process died with its SDK
    // transport. The first inbound message will flip it back to `working`
    // through the normal session-runtime-state path.
    const runtimeState = this.sessionRuntime.getAggregateRuntimeState();
    this.clientConnection.reportRuntimeState(this.config.agentId, runtimeState ?? "idle");
  }

  /**
   * Translate an `inbox:deliver` push frame into the {@link InboxEntryWithMessage}
   * shape `SessionRuntime.dispatch` expects, then dispatch.
   *
   * Ack happens INSIDE the SessionRuntime via the `ackEntry` callback we
   * pinned at construction time — `clientConnection.sendInboxAck`. Post
   * inflight-message-recovery the ack is deferred until the handler closes
   * the turn via `ctx.finishTurn(...)`. Sending an additional ack here
   * would double-ack: a WS frame the server cannot match against any
   * `delivered` row, which leaks the server's per-agent in-flight counter
   * and stalls push after `inboxMaxInFlightPerAgent` messages.
   *
   * Dispatch errors propagate up; the entry stays `delivered` server-side
   * and the next `agent:bind` resets it back to `pending` for redelivery
   * (see inflight-message-recovery-design.md §4).
   */
  private async dispatchPushedFrame(frame: InboxDeliverFrame): Promise<void> {
    if (!this.sessionRuntime) return;
    const chatId = frame.chatId ?? frame.message.chatId;
    this.noteActiveRuntimeChat(chatId);
    const entry: InboxEntryWithMessage = {
      id: frame.entryId,
      inboxId: frame.inboxId,
      messageId: frame.message.id,
      chatId: frame.chatId,
      // The DB columns we don't carry on the wire — set to the values the
      // claim path would have produced. Only `chatId`, `id`, and `message`
      // are read by SessionRuntime.dispatch, but keeping the shape correct
      // lets test fixtures and downstream consumers depend on the schema.
      status: "delivered",
      retryCount: 0,
      createdAt: frame.message.createdAt,
      deliveredAt: new Date().toISOString(),
      ackedAt: null,
      message: frame.message,
    };
    await this.sessionRuntime.dispatch(entry);
  }

  private startReconcileLoop(): void {
    const intervalSec = this.config.session.reconcile_interval_seconds ?? 300;
    this.reconcileTimer = setInterval(() => this.reconcileNow(), intervalSec * 1000);
  }

  private scheduleActiveRuntimeChatIdsRefresh(): void {
    if (!this.sdk) return;
    const generation = this.activeRuntimeChatIdsRefreshGeneration;
    if (this.activeRuntimeChatIdsRefreshTimer) clearTimeout(this.activeRuntimeChatIdsRefreshTimer);
    this.activeRuntimeChatIdsRefreshTimer = setTimeout(() => {
      if (!this.isActiveRuntimeChatIdsRefreshLive(generation)) return;
      this.activeRuntimeChatIdsRefreshTimer = null;
      void this.refreshActiveRuntimeChatIds("periodic").finally(() => {
        if (this.isActiveRuntimeChatIdsRefreshLive(generation)) {
          this.scheduleActiveRuntimeChatIdsRefresh();
        }
      });
    }, jitteredActiveRuntimeChatIdsRefreshDelay());
  }

  private async refreshActiveRuntimeChatIds(reason: "startup" | "bind" | "periodic"): Promise<void> {
    const sdk = this.sdk;
    if (!sdk) return;
    const generation = this.activeRuntimeChatIdsRefreshGeneration;
    if (this.activeRuntimeChatIdsRefreshInFlight) return this.activeRuntimeChatIdsRefreshInFlight;

    const refresh = sdk
      .listActiveRuntimeChatIds()
      .then(({ chatIds, activeSessionChatIds }) => {
        if (this.sdk !== sdk || !this.isActiveRuntimeChatIdsRefreshLive(generation)) return;
        this.activeRuntimeChatIds = new Set(chatIds);
        // Older servers return only `chatIds`; keep their visible-set repair
        // behavior during a rolling deployment, then widen automatically once
        // the complete active-session field is available.
        const revocationChatIds = activeSessionChatIds ?? chatIds;
        this.activeSessionChatIds = new Set(revocationChatIds);
        this.logger.info(
          { count: chatIds.length, activeSessionCount: revocationChatIds.length, reason },
          "active runtime chat ids refreshed",
        );
      })
      .catch((err) => {
        if (this.sdk !== sdk || !this.isActiveRuntimeChatIdsRefreshLive(generation)) return;
        this.logger.warn({ err, reason }, "active runtime chat ids refresh failed; keeping previous snapshot");
      })
      .finally(() => {
        if (this.activeRuntimeChatIdsRefreshInFlight === refresh) {
          this.activeRuntimeChatIdsRefreshInFlight = null;
        }
      });
    this.activeRuntimeChatIdsRefreshInFlight = refresh;
    await refresh;
  }

  private isActiveRuntimeChatIdsRefreshLive(generation: number): boolean {
    return this.sdk !== null && this.activeRuntimeChatIdsRefreshGeneration === generation;
  }

  private schedulePostBindReconcile(): void {
    if (this.postBindReconcileTimer) clearTimeout(this.postBindReconcileTimer);
    this.postBindReconcileTimer = setTimeout(() => {
      this.postBindReconcileTimer = null;
      this.reconcileNow();
    }, 5000);
  }

  private reconcileNow(): void {
    if (!this.sessionRuntime) return;
    const chatIds = this.sessionRuntime.getHeldChatIds(this.activeRuntimeChatIds);
    if (chatIds.length === 0) return;
    for (let index = 0; index < chatIds.length; index += SESSION_RECONCILE_BATCH_SIZE) {
      this.clientConnection.sendSessionReconcile(
        this.config.agentId,
        chatIds.slice(index, index + SESSION_RECONCILE_BATCH_SIZE),
      );
    }
  }

  private noteActiveRuntimeChat(chatId: string): void {
    this.activeRuntimeChatIds?.add(chatId);
    this.activeSessionChatIds?.add(chatId);
  }
}

export type { InboxEntryWithMessage };
