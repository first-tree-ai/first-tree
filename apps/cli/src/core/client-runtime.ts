import type { FSWatcher } from "node:fs";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AgentSlot,
  type AuthAttemptCredential,
  type BuiltinHandlerRegistry,
  ClientConnection,
  createBuiltinHandlerRegistry,
  createLogger,
  getChildProcessRegistry,
  type HandlerFactory,
  type ProviderModelsListCommand,
  type RuntimeAuthCommand,
  resolveAndLogClaudeExecutable,
  type UpdateHooks,
  UpdateManager,
} from "@first-tree/client";
import {
  AGENT_BIND_REJECT_REASONS,
  type AgentPinnedMessage,
  type ClientPausedReason,
  type ProviderModelCatalog,
  type RuntimeProvider,
  runtimeProviderSchema,
} from "@first-tree/shared";
import type { AgentConfig } from "@first-tree/shared/config";
import { agentConfigSchema, defaultConfigDir, loadAgents } from "@first-tree/shared/config";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ensureFreshAccessToken, loadCredentials } from "./bootstrap.js";
import { channelConfig } from "./channel.js";
import { cliFetch } from "./cli-fetch.js";
import { print } from "./output.js";
import { readUpdateState } from "./update-state.js";
import { CLI_USER_AGENT } from "./version.js";

type AgentEntry = {
  name: string;
  slot: AgentSlot;
  config: AgentConfig;
  state: AgentStartState;
};

type AgentStartState = "idle" | "starting" | "running" | "suspended-skipped" | "unsupported-runtime" | "failed";

const CLIENT_RUNTIME_AGENT_UNBOUND_LISTENER_COUNT = 1;

export type ClientRuntimeOutput = {
  blank: () => void;
  check: (pass: boolean, label: string, detail?: string) => void;
  line: (text: string) => void;
  status: (label: string, message: string) => void;
};

type RuntimeOutputLogLevel = "info" | "warn" | "error";

type RuntimeOutputLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

const printRuntimeOutput: ClientRuntimeOutput = {
  blank: () => print.blank(),
  check: (pass, label, detail) => print.check(pass, label, detail),
  line: (text) => print.line(text),
  status: (label, message) => print.status(label, message),
};

function logTrimmed(logger: RuntimeOutputLogger, level: RuntimeOutputLogLevel, text: string): void {
  const message = text.trim();
  if (message) logger[level](message);
}

function levelForStatus(label: string): RuntimeOutputLogLevel {
  if (label.includes("✗")) return "error";
  if (label.includes("⚠")) return "warn";
  return "info";
}

export function createLoggerRuntimeOutput(logger: RuntimeOutputLogger): ClientRuntimeOutput {
  return {
    blank: () => undefined,
    check: (pass, label, detail) => {
      const message = detail ? `${label}: ${detail}` : label;
      logger[pass ? "info" : "warn"](message);
    },
    line: (text) => logTrimmed(logger, "info", text),
    status: (label, message) => {
      logger[levelForStatus(label)](label ? `${label} ${message}` : message);
    },
  };
}

export function isAgentSuspendedBindError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return msg.includes("agent_suspended");
}

function authPausedDetail(error: Error): string {
  const authCode = "authCode" in error && typeof error.authCode === "string" ? error.authCode : null;
  const authMessage = "authMessage" in error && typeof error.authMessage === "string" ? error.authMessage : null;
  if (!authCode) return error.message;
  return `Auth rejection code: ${authCode}${authMessage ? ` — ${authMessage}` : ""}`;
}

function credentialsFilePath(): string {
  return join(defaultConfigDir(), "credentials.json");
}

/** Stable auth identity: formatting and unrelated file fields do not trigger recovery. */
function credentialSnapshot(creds: NonNullable<ReturnType<typeof loadCredentials>>): string {
  return JSON.stringify([credentialsFilePath(), creds.serverUrl, creds.accessToken, creds.refreshToken]);
}

export type ClientRuntimeOptions = {
  /**
   * Version of the Command package this process was launched from. Passed to
   * the server as `sdkVersion` on `client:register` and compared against the
   * version the server advertises in `server:welcome`. Required to engage
   * self-update.
   */
  currentVersion?: string;
  /**
   * Self-update config + command-layer callbacks. All-or-nothing: the
   * UpdateManager attaches only when this and `currentVersion` are both set.
   */
  update?: UpdateHooks;
  /**
   * Human/status output sink. Defaults to the CLI Print layer for foreground
   * runs; daemon service children inject a logger-backed sink so runtime
   * diagnostics go through `client.log` instead of supervisor stderr.
   */
  output?: ClientRuntimeOutput;
};

/**
 * Client runtime — one shared ClientConnection, multiple agents multiplexed.
 *
 * Unified-user-token milestone:
 *   - Auth comes from the user's JWT in `credentials.json`; there is no
 *     per-agent token. `ensureFreshAccessToken` is called on every handshake
 *     + every SDK request, so long-lived connections refresh transparently.
 *   - Agent identity on the WS comes from `agents/<name>/agent.yaml::agentId`.
 *     The server's Rule R-RUN refuses binds for agents not pinned to this
 *     client — the operator has to run `agent create --client-id <thisId>`
 *     first.
 */
export class ClientRuntime {
  private readonly serverUrl: string;
  private readonly connection: ClientConnection;
  private readonly agents: AgentEntry[] = [];
  private readonly agentNames = new Set<string>();
  private readonly agentIds = new Set<string>();
  private readonly options: ClientRuntimeOptions;
  private readonly output: ClientRuntimeOutput;
  /**
   * Frozen built-in handler factory table. Created once in the constructor
   * (with a single cheap Claude executable resolution + log) and held as an
   * instance value — never process-global.
   */
  private readonly handlerFactories: BuiltinHandlerRegistry;
  private updateManager: UpdateManager | null = null;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Directory we write auto-registered agent configs into (same path that
   * `agent add` uses). Set by `watchAgentsDir` so the
   * `agent:pinned` handler knows where to materialise new configs.
   */
  private agentsDir: string | null = null;
  /**
   * Watcher on credentials.json (Bug 2 paused-mode recovery). Pure trigger:
   * file events (and the auth:paused handler itself) schedule a debounced
   * reconciliation, which resumes only when the current credentials differ
   * from the credential the paused attempt actually used.
   */
  private credentialsWatcher: FSWatcher | null = null;
  private credentialsDebounce: ReturnType<typeof setTimeout> | null = null;

  private readonly registeredListeners: Array<(isReconnect: boolean) => void> = [];
  /** Failed handshakes do not count as registrations. */
  private hasRegisteredOnce = false;
  private readonly runtimeProviderRepairAttempts = new Map<string, number>();

  constructor(serverUrl: string, clientId: string, options: ClientRuntimeOptions = {}) {
    this.serverUrl = serverUrl;
    this.options = options;
    this.output = options.output ?? printRuntimeOutput;
    this.connection = new ClientConnection({
      serverUrl,
      clientId,
      sdkVersion: options.currentVersion,
      userAgent: CLI_USER_AGENT,
      getAccessToken: (opts) => ensureFreshAccessToken(opts),
      // Lets the connection anchor a failed token-provider attempt to the
      // exact credentials it used (see getAuthAttemptCredential).
      getCredentialsSnapshot: () => this.readCredentialsSnapshot(),
      // Forward the last self-update outcome on every `client:register`
      // so the server can persist it into `clients.metadata.lastUpdateAttempt`
      // and the admin dashboard can flag clients that are failing to
      // self-update. Read is synchronous (small JSON file) and tolerant —
      // missing / corrupt state file simply omits the field.
      getLastUpdateAttempt: () => readUpdateState()?.last ?? null,
    });
    // Composition runs synchronously BEFORE the WS connects — so it must not
    // block. Resolve cheap-only (`includeLoginShell: false`): daemon PATH +
    // well-known dirs, never a login-shell `spawnSync`. A `claude` that lives
    // only on the user's interactive shell PATH resolves to `undefined` here
    // and is picked up lazily by the handler at session start (which
    // re-resolves with the login-shell probe) and by the capability probe
    // (post-construction) — neither of which is on the pre-connect path.
    // Log once per ClientRuntime construction.
    const handlersLog = createLogger("handlers");
    const resolution = resolveAndLogClaudeExecutable({ log: handlersLog });
    this.handlerFactories = createBuiltinHandlerRegistry({
      resolveExecutable: () => resolution,
    });

    this.connection.on("auth:expired", () => {
      this.output.status("⚠️", "access token expired — reconnecting after refresh...");
    });

    // Refresh token rejected by the server. Bug 2 fix: instead of
    // `process.exit(75)` (which made systemd restart us into the same
    // failing state, leaking claude / playwright subprocesses every cycle),
    // enter paused mode. The connection holds, agent slots stop processing
    // inbox messages, and a credentials.json watcher waits for the operator
    // to run the channel-aware login command. On change we call
    // `connection.clearPaused()` to resume.
    this.connection.on("auth:paused", (reason, err) => {
      this.output.blank();
      this.output.status("✗", "auth rejected — pausing agents until fresh credentials arrive.");
      this.output.status("", authPausedDetail(err));
      this.output.status("", "Recovery: get a new connect code from the First Tree web console");
      this.output.status(
        "",
        `          (Computers → + New Connection), then re-run \`${channelConfig.binName} login <code>\`.`,
      );
      this.output.status("", `Paused reason: ${reason}. Process is staying alive — no restart needed after login.`);
      this.ensureCredentialsWatcher();
      // A login that landed BEFORE this pause (or before the watcher
      // existed) produces no future fs event — reconcile now, not only on
      // file changes.
      this.scheduleCredentialsReconcile();
    });

    this.connection.on("auth:resumed", (previousReason) => {
      this.output.status("✓", `credentials refreshed — resuming agents (was paused: ${previousReason})`);
    });

    // Back-compat: legacy auth:fatal listeners on older consumers used to
    // exit the process. We keep the event but no longer act on it —
    // auth:paused is the actionable channel now.
    this.connection.on("auth:fatal", () => {
      // intentional no-op: handled by auth:paused above.
    });

    // Surface transport-level errors (TLS resets, DNS hiccups, WS handshake
    // failures) to the operator. ClientConnection's own reconnect loop handles
    // recovery; the process-wide crash guard lives in ClientConnection itself.
    this.connection.on("error", (err) => {
      this.output.status("⚠️", `client connection error: ${err.message}`);
    });

    // Server tells us an agent has just been pinned to this client — mirror
    // what `agent add` does (write local config) and let the
    // scanForNewAgents helper start the slot. The fs watcher, when active,
    // is also a fallback path for the same flow.
    this.connection.on("agent:pinned", (message) => {
      void this.handleAgentPinned(message);
    });

    this.connection.on("agent:unbound", (agentId, reason) => {
      const entry = this.agents.find((agent) => agent.slot.agentId === agentId);
      if (!entry || !reason) return;
      entry.state = reason === "agent_suspended" ? "suspended-skipped" : "idle";
    });

    this.connection.on("agent:bind:rejected", (reason, agentId) => {
      if (reason !== AGENT_BIND_REJECT_REASONS.RUNTIME_PROVIDER_MISMATCH) return;
      void this.repairRuntimeProviderMismatch(agentId);
    });

    // Registration is the readiness boundary for both startup and recovery.
    this.connection.on("connected", () => {
      const wasReconnect = this.hasRegisteredOnce;
      this.hasRegisteredOnce = true;
      for (const cb of this.registeredListeners) {
        try {
          cb(wasReconnect);
        } catch (err) {
          this.output.status("⚠️", `reconnect handler error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
  }

  /**
   * Register a callback fired after each WS RE-registration (reconnect after a
   * drop), not the first register. The daemon uses this to refresh
   * runtime-provider capabilities without a restart.
   */
  onReconnect(callback: () => void): void {
    this.onRegistered((isReconnect) => {
      if (isReconnect) callback();
    });
  }

  /** Fired only after client:registered, including the first successful registration. */
  onRegistered(callback: (isReconnect: boolean) => void): void {
    this.registeredListeners.push(callback);
  }

  /**
   * Register a callback fired when the connection enters auth paused mode
   * (refresh token rejected / server-side auth rejection). Used by the
   * daemon to gate auth-dependent background work (capability refresh)
   * while credentials are dead — its uploads would otherwise keep firing
   * doomed `/auth/refresh` 401s.
   */
  onAuthPaused(callback: () => void): void {
    this.connection.on("auth:paused", callback);
  }

  /**
   * Register a handler for the server→client `runtime-auth:start` command (the
   * in-product "connect a provider's credentials" action). The daemon drives
   * the provider's official login and reflects progress through the
   * capabilities snapshot. Fired once per command.
   */
  onRuntimeAuthStart(callback: (command: RuntimeAuthCommand) => void): void {
    this.connection.on("runtime-auth:start", callback);
  }

  /**
   * Register a handler for the server→client `provider-models:list` command.
   * The daemon discovers models from the host-local provider and replies with
   * `provider-models:result` on the same connection.
   */
  onProviderModelsList(callback: (command: ProviderModelsListCommand) => void): void {
    this.connection.on("provider-models:list", callback);
  }

  /** Reply to a correlated `provider-models:list` with the discovered catalog. */
  sendProviderModelsResult(ref: string, catalog: ProviderModelCatalog): void {
    this.connection.sendProviderModelsResult(ref, catalog);
  }

  addAgent(name: string, config: AgentConfig): void {
    if (this.agentNames.has(name)) return;
    // The runtime provider may be a valid wire value, but this client build may
    // not ship a factory for it yet (e.g. a newer provider pinned to an older
    // client). Skip with a clear warning rather than throwing and crashing
    // daemon startup — which would also stop every other agent in the same
    // load loop. Record the name/id so rescans and reconnects don't re-warn; a
    // client upgrade + restart picks the agent up once its factory is present.
    // Keep this fail-closed check even though the built-in table is TS-exhaustive:
    // runtime/config can still carry a value this build does not support.
    if (!this.hasHandlerFactory(config.runtime)) {
      this.output.status(
        "⚠️",
        `agent "${name}" uses runtime "${config.runtime}" which this client build does not support yet — skipping. Update the client to run it.`,
      );
      this.agentNames.add(name);
      this.agentIds.add(config.agentId);
      return;
    }
    const slot = this.createAgentSlot(name, config);
    this.agents.push({ name, slot, config, state: "idle" });
    this.agentNames.add(name);
    this.agentIds.add(config.agentId);
    this.refreshConnectionListenerLimit();
  }

  private hasHandlerFactory(type: string): boolean {
    return Object.hasOwn(this.handlerFactories, type);
  }

  private resolveHandlerFactory(type: string): HandlerFactory {
    // Own-key guard lives in the resolver itself so future callers cannot
    // index Object.prototype (`toString` / `constructor` / `__proto__`) and
    // treat inherited values as factories.
    if (!Object.hasOwn(this.handlerFactories, type)) {
      const available = Object.keys(this.handlerFactories).join(", ") || "(none)";
      throw new Error(`Unknown handler type "${type}". Available: ${available}`);
    }
    const factory = (this.handlerFactories as Readonly<Record<string, HandlerFactory>>)[type];
    if (!factory) {
      const available = Object.keys(this.handlerFactories).join(", ") || "(none)";
      throw new Error(`Unknown handler type "${type}". Available: ${available}`);
    }
    return factory;
  }

  private createAgentSlot(name: string, config: AgentConfig): AgentSlot {
    const handlerFactory = this.resolveHandlerFactory(config.runtime);
    return new AgentSlot({
      name,
      agentId: config.agentId,
      serverUrl: this.serverUrl,
      type: config.runtime,
      handlerFactory,
      session: {
        idle_timeout: config.session.idle_timeout,
        max_sessions: config.session.max_sessions,
        working_grace_seconds: config.session.working_grace_seconds,
        // Admin-managed runtime config doesn't carry this field yet; local
        // `agent.yaml` users can override via the client YAML schema.
        reconcile_interval_seconds: 300,
      },
      concurrency: config.concurrency,
      clientConnection: this.connection,
    });
  }

  private refreshConnectionListenerLimit(): void {
    const requiredListenersPerEvent = this.agents.length + CLIENT_RUNTIME_AGENT_UNBOUND_LISTENER_COUNT;
    const currentLimit = this.connection.getMaxListeners();
    if (currentLimit !== 0 && currentLimit < requiredListenersPerEvent) {
      this.connection.setMaxListeners(requiredListenersPerEvent);
    }
  }

  async start(): Promise<void> {
    // Attach before connecting so the first welcome frame on a stale client
    // is acted on rather than missed until the next reconnect.
    if (this.options.currentVersion && this.options.update) {
      const updateLogger = createLogger("update");
      this.updateManager = UpdateManager.attach(this.connection, {
        currentVersion: this.options.currentVersion,
        ...this.options.update,
        isTTY: Boolean(process.stdout.isTTY),
        log: (level, msg) => updateLogger[level](msg),
        getQuietGateSnapshot: () => this.aggregateQuietGate(),
      });
    }

    await this.connection.connect();
    this.output.check(true, "client registered", this.connection.clientId);

    if (this.agents.length === 0) {
      this.output.blank();
      this.output.status("", "no agents configured yet.");
      this.output.status(
        "",
        `add one with: ${channelConfig.binName} agent create <name> --type claude-code --client-id <id>`,
      );
      this.output.blank();
      return;
    }

    const startupResults = await Promise.all(this.agents.map((agent) => this.startAgentEntry(agent)));

    const connected = startupResults.filter((r) => r === "connected").length;
    const skipped = startupResults.filter((r) => r === "skipped").length;
    this.output.blank();
    const skippedSuffix = skipped > 0 ? `, ${skipped} skipped` : "";
    this.output.status("", `${connected} agent(s) running${skippedSuffix}. Press Ctrl+C to stop.`);
  }

  watchAgentsDir(agentsDir: string): void {
    // Record the directory even if the watcher bails (e.g. dir missing) so
    // the `agent:pinned` handler knows where to materialise configs.
    this.agentsDir = agentsDir;
    if (this.watcher) return;
    if (!existsSync(agentsDir)) return;

    this.watcher = watch(agentsDir, { recursive: true }, () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.scanForNewAgents(agentsDir);
      }, 500);
    });
    // A recursive FSWatcher can emit 'error' at runtime (watched dir removed,
    // or inotify exhaustion on Linux). An unhandled 'error' throws and would
    // take down the daemon — tear the watcher down so it degrades gracefully.
    this.watcher.on("error", (err: Error) => {
      this.output.status("⚠️", `agents dir watcher error: ${err.message}`);
      this.unwatchAgentsDir();
    });
  }

  unwatchAgentsDir(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  async stop(reason?: string): Promise<void> {
    this.unwatchAgentsDir();
    this.stopCredentialsWatcher();
    this.updateManager?.dispose();
    this.updateManager = null;
    await Promise.allSettled(this.agents.map((a) => a.slot.stop(reason)));
    await this.connection.disconnect();
    // Bug 3: sweep any subprocess we still track (git, npm install) so they
    // do not stay in our cgroup after the parent exits. AgentSlot.stop has
    // already drained sessionManager.shutdown which closes Claude SDK
    // queries, but git / npm spawned out-of-band needs an explicit reap.
    try {
      await getChildProcessRegistry().killAll("client-runtime-stop");
    } catch {
      // best-effort
    }
  }

  /**
   * Bug 2 paused-mode recovery: watch credentials.json for changes. Every
   * file event schedules a debounced reconciliation against the paused
   * attempt's credential identity; on a real change the connection is told
   * to clear paused state and its connect loop picks up the new JWT via
   * `ensureFreshAccessToken`.
   */
  private ensureCredentialsWatcher(): void {
    if (this.credentialsWatcher) return;
    const credentialsFile = credentialsFilePath();
    const watchDir = dirname(credentialsFile);
    if (!existsSync(watchDir)) return;
    try {
      this.credentialsWatcher = watch(watchDir, (_evt, filename) => {
        if (filename && filename !== "credentials.json") return;
        this.scheduleCredentialsReconcile();
      });
      // Synchronous setup is wrapped in try/catch above, but the FSWatcher can
      // still emit 'error' later; without a listener that would crash the
      // daemon. Tear it down so paused-mode recovery degrades gracefully.
      this.credentialsWatcher.on("error", (err: Error) => {
        this.output.status("⚠️", `credentials watcher error: ${err.message}`);
        this.stopCredentialsWatcher();
      });
    } catch (err) {
      this.output.status("⚠️", `credentials watcher failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private stopCredentialsWatcher(): void {
    if (this.credentialsDebounce) {
      clearTimeout(this.credentialsDebounce);
      this.credentialsDebounce = null;
    }
    if (this.credentialsWatcher) {
      this.credentialsWatcher.close();
      this.credentialsWatcher = null;
    }
  }

  private scheduleCredentialsReconcile(): void {
    if (this.credentialsDebounce) clearTimeout(this.credentialsDebounce);
    this.credentialsDebounce = setTimeout(() => {
      this.credentialsDebounce = null;
      this.reconcilePausedCredentials();
    }, 250);
  }

  /**
   * Resume paused mode only when the current credentials differ from the
   * credential the paused attempt actually used. The attempt identity is
   * read live from the connection, so a stale trigger can never act on an
   * older attempt's identity or unpause a newer failure. Unchanged
   * credentials stay parked: the server already rejected exactly this
   * credential, so retrying it would only re-fail.
   */
  private reconcilePausedCredentials(): void {
    if (!this.connection.isPaused()) return;
    const attemptCredential = this.connection.getAuthAttemptCredential();
    if (attemptCredential === null) return;
    const current = this.currentCredentialForComparison(attemptCredential);
    if (current === null || current === attemptCredential.value) return;
    this.output.status("", "credentials.json updated — clearing paused mode");
    this.connection.clearPaused();
  }

  /**
   * Compare in the identity domain recorded by the attempt, independently
   * of how the auth error was classified.
   */
  private currentCredentialForComparison(attempt: AuthAttemptCredential): string | null {
    const creds = loadCredentials();
    if (!creds) return null;
    switch (attempt.kind) {
      case "access_token":
        return creds.accessToken;
      case "credential_snapshot":
        return credentialSnapshot(creds);
    }
  }

  private readCredentialsSnapshot(): string | null {
    const creds = loadCredentials();
    return creds ? credentialSnapshot(creds) : null;
  }

  /** Test helper / external probe — true once paused mode is active. */
  isPaused(): boolean {
    return this.connection.isPaused();
  }

  /** Test helper / external probe — last paused reason (or null). */
  pausedReason(): ClientPausedReason | null {
    return this.connection.getPausedReason();
  }

  /**
   * Forward a typed resilience event into the ClientConnection EventEmitter.
   * Exposed for command-layer plumbing that fires outside the slot lifecycle
   * (notably the update path, see {@link createExecuteUpdate}'s
   * `onUpdateFailed` callback in `update-glue.ts`).
   */
  emitConnectionResilienceEvent(
    event: "resilience.update.failed",
    payload: { targetVersion: string; retryable: boolean; reasonCode: string },
  ): void {
    this.connection.emit(event, payload);
  }

  private aggregateQuietGate(): { activeCount: number; lastActivityMs: number } {
    let activeCount = 0;
    let lastActivityMs = 0;
    for (const entry of this.agents) {
      const snap = entry.slot.getQuietGateSnapshot();
      activeCount += snap.activeCount;
      if (snap.lastActivityMs > lastActivityMs) lastActivityMs = snap.lastActivityMs;
    }
    return { activeCount, lastActivityMs };
  }

  private scanForNewAgents(agentsDir: string): void {
    try {
      const all = loadAgents({ schema: agentConfigSchema, agentsDir });
      for (const [name, config] of all) {
        if (this.agentNames.has(name)) continue;
        if (this.agentIds.has(config.agentId)) continue;

        this.output.blank();
        this.output.status("", `new agent detected: ${name}`);
        this.addAgent(name, config);
        this.startAgent(name);
      }
    } catch {
      // Ignore transient read errors during file writes
    }
  }

  /**
   * React to an `agent:pinned` server push by writing the local config file
   * (same shape `agent add` produces) and scheduling the new
   * slot — so the operator doesn't have to run `agent add` manually after
   * creating an agent from the admin UI or API.
   */
  private async handleAgentPinned(message: AgentPinnedMessage): Promise<void> {
    const existing = this.agents.find((agent) => agent.slot.agentId === message.agentId);
    if (existing) {
      if (existing.config.runtime !== message.runtimeProvider) {
        await this.reconfigurePinnedAgent(existing, message.runtimeProvider);
        return;
      }
      if (existing.state === "suspended-skipped" || existing.state === "failed" || existing.state === "idle") {
        this.output.status("", `agent runtime confirmed: ${existing.name}`);
        this.startAgent(existing.name);
      }
      return;
    }

    if (!this.agentsDir) {
      this.output.status("⚠️", `agent pinned (${message.agentId}) but no agents dir set — cannot auto-register.`);
      return;
    }

    const localName = this.pickLocalName(message);
    const agentDir = join(this.agentsDir, localName);
    try {
      mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      const yaml = stringifyYaml({ agentId: message.agentId, runtime: message.runtimeProvider });
      writeFileSync(join(agentDir, "agent.yaml"), yaml, { mode: 0o600 });
      this.output.check(true, `auto-added agent "${localName}"`, `${message.agentId} (from server push)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.check(false, `failed to auto-add agent "${localName}"`, msg);
      return;
    }

    // The fs watcher would eventually pick this up with a 500 ms debounce,
    // but call the scan directly so the new slot starts promptly — especially
    // important when the watcher is not active (e.g. tests, Docker builds).
    this.scanForNewAgents(this.agentsDir);
  }

  private async reconfigurePinnedAgent(existing: AgentEntry, runtimeProvider: RuntimeProvider): Promise<void> {
    const runtimeSwitchStopOptions = {
      sessionShutdown: {
        clearPersistedRegistry: true,
        reportSuspendedSessions: false,
      },
    };
    if (!this.hasHandlerFactory(runtimeProvider)) {
      this.output.status(
        "⚠️",
        `agent "${existing.name}" switched to runtime "${runtimeProvider}" which this client build does not support yet — update the client to run it.`,
      );
      try {
        await existing.slot.stop("runtime switched to unsupported provider by server", runtimeSwitchStopOptions);
      } catch (err) {
        this.output.status(
          "⚠️",
          `failed to stop previous runtime for ${existing.name}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      existing.config = { ...existing.config, runtime: runtimeProvider };
      this.writeAgentYaml(existing.name, existing.config);
      existing.state = "unsupported-runtime";
      return;
    }

    this.output.status("", `agent runtime switched: ${existing.name} → ${runtimeProvider}`);
    try {
      await existing.slot.stop("runtime switched by server", runtimeSwitchStopOptions);
    } catch (err) {
      this.output.status(
        "⚠️",
        `failed to stop previous runtime for ${existing.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const nextConfig = { ...existing.config, runtime: runtimeProvider };
    try {
      this.writeAgentYaml(existing.name, nextConfig);
    } catch (err) {
      existing.state = "failed";
      this.output.check(
        false,
        `failed to update agent "${existing.name}" runtime`,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    existing.config = nextConfig;
    existing.slot = this.createAgentSlot(existing.name, nextConfig);
    existing.state = "idle";
    this.refreshConnectionListenerLimit();
    this.startAgent(existing.name);
  }

  private async repairRuntimeProviderMismatch(agentId: string): Promise<void> {
    const existing = this.agents.find((agent) => agent.slot.agentId === agentId);
    if (!existing) return;
    const attempts = this.runtimeProviderRepairAttempts.get(agentId) ?? 0;
    if (attempts >= 1) {
      this.output.status("⚠️", `${existing.name}: runtime repair already attempted; not retrying bind mismatch.`);
      return;
    }
    this.runtimeProviderRepairAttempts.set(agentId, attempts + 1);
    try {
      const token = await ensureFreshAccessToken();
      const res = await cliFetch(`${this.serverUrl}/api/v1/agents/${encodeURIComponent(agentId)}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        this.output.status("⚠️", `${existing.name}: runtime repair failed (HTTP ${res.status})`);
        return;
      }
      const agent = (await res.json()) as {
        agentType?: unknown;
        displayName?: unknown;
        name?: unknown;
        runtimeProvider?: unknown;
        type?: unknown;
      };
      const runtime = runtimeProviderSchema.safeParse(agent.runtimeProvider);
      if (!runtime.success) {
        this.output.status("⚠️", `${existing.name}: runtime repair failed (server returned unknown runtime)`);
        return;
      }
      await this.handleAgentPinned({
        type: "agent:pinned",
        agentId,
        name: typeof agent.name === "string" ? agent.name : null,
        displayName: typeof agent.displayName === "string" ? agent.displayName : existing.name,
        agentType: agent.type === "human" ? "human" : "agent",
        runtimeProvider: runtime.data,
      });
    } catch (err) {
      this.output.status(
        "⚠️",
        `${existing.name}: runtime repair failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private readAgentYamlRecord(name: string): Record<string, unknown> {
    if (!this.agentsDir) return {};
    const yamlPath = join(this.agentsDir, name, "agent.yaml");
    if (!existsSync(yamlPath)) return {};
    const parsed = parseYaml(readFileSync(yamlPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  }

  private writeAgentYaml(name: string, config: Pick<AgentConfig, "agentId" | "runtime"> & Partial<AgentConfig>): void {
    if (!this.agentsDir) {
      throw new Error("agents dir is not set");
    }
    const agentDir = join(this.agentsDir, name);
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    const rawConfig = this.readAgentYamlRecord(name);
    const yaml = stringifyYaml({
      ...config,
      ...rawConfig,
      agentId: config.agentId,
      runtime: config.runtime,
    });
    writeFileSync(join(agentDir, "agent.yaml"), yaml, { mode: 0o600 });
  }

  /**
   * Choose the directory name under `agents/<name>/agent.yaml` for an agent
   * pushed by the server. Prefer the server-side `name` when set and not
   * already claimed; otherwise fall back to a UUID-derived name with a numeric
   * suffix on collision.
   *
   * UUID v7 packs the unix-ms timestamp in the high bits, so two agents
   * created in the same millisecond share the first 8 hex chars. Take 16 chars
   * (the full ms-timestamp segment plus the random tail) to make accidental
   * collisions astronomically unlikely, and re-check `agentNames` so even an
   * adversarial collision falls through to a `-2`, `-3`, … suffix.
   */
  private pickLocalName(message: AgentPinnedMessage): string {
    const preferred = message.name;
    if (preferred && !this.agentNames.has(preferred)) return preferred;
    const shortId = message.agentId
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 16)
      .toLowerCase();
    const base = `agent-${shortId}`;
    if (!this.agentNames.has(base)) return base;
    for (let suffix = 2; suffix < 1000; suffix++) {
      const candidate = `${base}-${suffix}`;
      if (!this.agentNames.has(candidate)) return candidate;
    }
    // Pathological fallback — UUID-derived names colliding 1000 times means
    // something is structurally wrong upstream. Use the full agentId so we at
    // least don't return a duplicate name and overwrite an existing config.
    return `agent-${message.agentId.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  }

  private startAgent(name: string): void {
    const entry = this.agents.find((a) => a.name === name);
    if (!entry) return;
    void this.startAgentEntry(entry);
  }

  private async startAgentEntry(entry: AgentEntry): Promise<"connected" | "skipped" | "failed"> {
    if (entry.state === "unsupported-runtime") {
      return "skipped";
    }
    if (entry.state === "starting" || entry.state === "running") {
      return entry.state === "running" ? "connected" : "skipped";
    }

    entry.state = "starting";
    try {
      const identity = await entry.slot.start();
      entry.state = "running";
      this.runtimeProviderRepairAttempts.delete(entry.slot.agentId);
      this.output.check(true, `${entry.name}: connected`, `agent: ${identity.displayName ?? identity.agentId}`);
      return "connected";
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (isAgentSuspendedBindError(error)) {
        entry.state = "suspended-skipped";
        this.output.status("•", `${entry.name}: skipped (suspended)`);
        return "skipped";
      }
      entry.state = "failed";
      this.output.check(false, `${entry.name}: connection failed`, msg);
      return "failed";
    }
  }
}
