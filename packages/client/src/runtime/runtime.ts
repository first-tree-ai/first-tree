import type { ClientPausedReason, UpdateAttempt } from "@first-tree/shared";
import { createLogger, type pino } from "../cloud/observability/logger.js";
import type { AccessTokenProvider } from "../cloud/sdk.js";
import { AgentSlot } from "./agent-slot.js";
import { ClientConnection } from "./client-connection.js";
import type { RuntimeConfig } from "./config.js";
import type { HandlerFactoryMap } from "./handler.js";
import { type UpdateHooks, UpdateManager } from "./update-manager.js";

export type AgentRuntimeOptions = {
  config: RuntimeConfig;
  /**
   * Returns the current member access JWT. Host processes (e.g. the command
   * package) are responsible for keeping this fresh; the runtime calls it on
   * every WS handshake and every SDK request.
   */
  getAccessToken: AccessTokenProvider;
  /**
   * Notify the host when authentication needs new credentials. After updating
   * its token provider, the host calls resumeAfterCredentialsChange().
   */
  onAuthPaused?: (reason: ClientPausedReason, error: Error) => void | Promise<void>;
  /**
   * Instance-level readonly handler factory map. Standalone runtimes must
   * supply this explicitly — there is no process-global handler registry.
   * Unknown agent types throw with the available keys listed.
   */
  handlerFactories: HandlerFactoryMap;
  /** Stable per-machine client identifier. Generated if omitted. */
  clientId?: string;
  shutdownTimeout?: number;
  /**
   * Version of the consumer-facing Command package this runtime was bundled
   * with. Advertised to the server as `sdkVersion` at `client:register`, and
   * compared by the UpdateManager against the server-advertised version.
   * The UpdateManager only engages when both this and `update` are set.
   */
  currentVersion?: string;
  /** Optional `User-Agent` forwarded to every per-agent SDK. */
  userAgent?: string;
  /**
   * Self-update config + command-layer callbacks. Grouped so half-wired
   * configurations (e.g. config without prompt) can't silently disable the
   * manager.
   */
  update?: UpdateHooks;
  /**
   * Optional accessor for the most recent self-update outcome — see
   * `ClientConnectionConfig.getLastUpdateAttempt`. Wired by the command
   * package so the server can surface failed-to-self-update clients in
   * the admin dashboard.
   */
  getLastUpdateAttempt?: () => UpdateAttempt | null;
};

const DEFAULT_SHUTDOWN_TIMEOUT = 30_000;

export class AgentRuntime {
  private readonly slots: AgentSlot[] = [];
  private readonly config: RuntimeConfig;
  private readonly shutdownTimeout: number;
  private readonly clientConnection: ClientConnection;
  private readonly getAccessToken: AccessTokenProvider;
  private readonly currentVersion: string | undefined;
  private readonly updateHooks: UpdateHooks | undefined;
  private updateManager: UpdateManager | null = null;
  private stopping = false;
  private logger: pino.Logger;

  constructor(options: AgentRuntimeOptions) {
    this.config = options.config;
    this.shutdownTimeout = options.shutdownTimeout ?? DEFAULT_SHUTDOWN_TIMEOUT;
    this.getAccessToken = options.getAccessToken;
    this.currentVersion = options.currentVersion;
    this.updateHooks = options.update;
    this.logger = createLogger("runtime");

    this.clientConnection = new ClientConnection({
      serverUrl: this.config.server,
      clientId: options.clientId,
      sdkVersion: options.currentVersion,
      userAgent: options.userAgent,
      getAccessToken: this.getAccessToken,
      getLastUpdateAttempt: options.getLastUpdateAttempt,
    });

    // Surface transport-level errors (TLS resets, DNS hiccups, WS handshake
    // failures) to operators. ClientConnection's own reconnect loop handles
    // recovery; a process-wide crash guard lives in ClientConnection itself.
    this.clientConnection.on("error", (err) => this.logger.error({ err }, "client connection error"));
    this.clientConnection.on("auth:paused", (reason, error) => {
      this.logger.warn({ reason }, "authentication paused — update credentials and call resumeAfterCredentialsChange");
      // Host observers may be asynchronous; neither sync throws nor rejected
      // promises may interrupt the connection's pause/cleanup transition.
      void Promise.resolve()
        .then(() => options.onAuthPaused?.(reason, error))
        .catch((err) => this.logger.error({ err }, "auth pause callback failed"));
    });

    for (const [name, agentConfig] of Object.entries(this.config.agents)) {
      // Own-key only: a plain `{}` map still inherits Object.prototype, so
      // direct indexing of `toString` / `constructor` / `__proto__` would
      // return truthy prototype values and bypass fail-closed unknown-type
      // handling (Map.get returned undefined for those keys).
      const handlerFactory = Object.hasOwn(options.handlerFactories, agentConfig.type)
        ? options.handlerFactories[agentConfig.type]
        : undefined;
      if (!handlerFactory) {
        const available = Object.keys(options.handlerFactories).join(", ") || "(none)";
        throw new Error(`Unknown handler type "${agentConfig.type}". Available: ${available}`);
      }
      this.slots.push(
        new AgentSlot({
          name,
          agentId: agentConfig.agentId,
          serverUrl: this.config.server,
          type: agentConfig.type,
          handlerFactory,
          session: agentConfig.session,
          concurrency: agentConfig.concurrency,
          clientConnection: this.clientConnection,
          runtimeType: agentConfig.type,
        }),
      );
    }
    this.refreshConnectionListenerLimit();
  }

  private refreshConnectionListenerLimit(): void {
    const requiredListenersPerEvent = this.slots.length;
    const currentLimit = this.clientConnection.getMaxListeners();
    if (currentLimit !== 0 && currentLimit < requiredListenersPerEvent) {
      this.clientConnection.setMaxListeners(requiredListenersPerEvent);
    }
  }

  private aggregateQuietGate(): { activeCount: number; lastActivityMs: number } {
    let activeCount = 0;
    let lastActivityMs = 0;
    for (const slot of this.slots) {
      const snap = slot.getQuietGateSnapshot();
      activeCount += snap.activeCount;
      if (snap.lastActivityMs > lastActivityMs) lastActivityMs = snap.lastActivityMs;
    }
    return { activeCount, lastActivityMs };
  }

  getPausedReason(): ClientPausedReason | null {
    return this.clientConnection.getPausedReason();
  }

  /** Explicit host recovery; fresh credentials do not count as registration. Stop stays terminal. */
  resumeAfterCredentialsChange(): void {
    if (!this.stopping) this.clientConnection.clearPaused();
  }

  /** Stays pending during auth pause; the host must supply credentials and resume, or stop. */
  async start(): Promise<void> {
    // Attach before connecting so the first welcome frame on a stale Client
    // is acted on rather than missed until the next reconnect.
    if (this.currentVersion && this.updateHooks) {
      const updateLogger = createLogger("update");
      this.updateManager = UpdateManager.attach(this.clientConnection, {
        currentVersion: this.currentVersion,
        ...this.updateHooks,
        isTTY: Boolean(process.stdout.isTTY),
        log: (level, msg) => updateLogger[level](msg),
        getQuietGateSnapshot: () => this.aggregateQuietGate(),
      });
      this.logger.info(
        { policy: this.updateHooks.updateConfig.policy, version: this.currentVersion },
        "update manager attached",
      );
    }

    this.logger.info({ clientId: this.clientConnection.clientId }, "connecting client");
    await this.clientConnection.connect();
    // Rebind so downstream lines carry clientId automatically.
    this.logger = this.logger.child({ clientId: this.clientConnection.clientId });
    this.logger.info("client connected");

    this.logger.info({ count: this.slots.length }, "starting agents");

    const results = await Promise.allSettled(this.slots.map((slot) => slot.start()));

    let failed = 0;
    const failures: Array<{ agentName: string; agentId: string; reason: string }> = [];
    for (const [i, result] of results.entries()) {
      if (result.status === "rejected") {
        const slot = this.slots[i];
        // `slots` and `results` are 1:1 by construction (Promise.allSettled
        // preserves input order), so this lookup is total.
        const agentName = slot?.name ?? "<unknown>";
        const agentId = slot?.agentId ?? "<unknown>";
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.logger.error({ err: result.reason, agentName, agentId, reason }, "failed to start agent");
        failures.push({ agentName, agentId, reason });
        failed++;
      }
    }

    if (failed > 0) {
      // One aggregate WARN that operators can grep for from `client doctor` /
      // log triage without having to scan for every per-slot ERROR line.
      this.logger.warn(
        { failedCount: failed, totalCount: this.slots.length, failures },
        "some agents failed to start — check that each agentId is still pinned to this client",
      );
    }

    if (failed === this.slots.length) {
      throw new Error("All agents failed to start");
    }

    this.logger.info("ready — press Ctrl+C to stop");

    await new Promise<void>((resolve) => {
      const shutdown = async () => {
        if (this.stopping) return;
        this.stopping = true;
        this.logger.info("shutting down");

        const timer = setTimeout(() => {
          this.logger.warn("shutdown timeout reached, forcing exit");
          process.exit(1);
        }, this.shutdownTimeout);

        await this.stop();
        clearTimeout(timer);
        this.logger.info("stopped");
        resolve();
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
  }

  async stop(reason?: string): Promise<void> {
    this.stopping = true;
    this.updateManager?.dispose();
    this.updateManager = null;
    await Promise.allSettled(this.slots.map((slot) => slot.stop(reason)));
    await this.clientConnection.disconnect();
  }
}
