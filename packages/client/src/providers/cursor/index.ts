import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  type AgentRuntimeConfig,
  type AgentRuntimeConfigPayload,
  classifyShellCommandIo,
  encodeProviderRetryEventMessage,
  isLandingCampaignTrialAgentMetadata,
  runtimeProviderSchema,
  type ToolFileRef,
} from "@first-tree/shared";
import type {
  AgentHandler,
  DeliveryToken,
  HandlerFactory,
  SessionContext,
  SessionMessage,
  TurnConsumedErrorReason,
} from "../../runtime/contracts.js";
import { noopDeliveryToken, requireDeliveryToken } from "../../runtime/contracts.js";
import type {
  AgentConfigCache,
  ContextTreeAttribution,
  ContextTreeGitWriteTracker,
  ProviderAttemptSettlement,
} from "../../runtime/provider-support/index.js";
import {
  assertContextSourceCurrent,
  buildBriefingUpdateNotice,
  computeBriefingFingerprint,
  contextSourceFromHandlerConfig,
  createContextTreeGitWriteTracker,
  isContextSourceTransitionError,
  isManagedSkillsUnsafeDiscoveryError,
  maxProviderTurnRetryAttempts,
  ProviderAttempt,
  preparationCoordinatesFromSource,
  prepareManagedSession,
  projectManagedWorkspace,
  readSessionBriefingFingerprint,
  remoteGitAttributionFromSource,
  renderChatContextPrompt,
  renderRuntimeOutputContract,
  resolveContextTreeRelativePath,
  toolFileRefsFromShellCommand,
  withContextTreeRepoHeadCommit,
  writeSessionBriefingFingerprint,
} from "../../runtime/provider-support/index.js";
import { chunkAssistantText } from "../handlers/assistant-text.js";
import { formatAuthHint, isCursorAuthError } from "../handlers/auth-error-hint.js";
import { consumedErrorOutcome, resolveTurnSettlement } from "../handlers/turn-settlement.js";
import { PROVIDER_SKILL_ROOTS } from "../skill-roots.js";
import {
  CursorBinaryVerifyTransientError,
  formatCursorBinaryMissingMessage,
  resolveCursorRuntimeBinary,
} from "./binary.js";
import { type CursorStreamEvent, CursorStreamParser, type CursorToolCall, type CursorUsage } from "./parser.js";

/**
 * Cursor handler — drives the EXTERNAL Cursor Agent CLI, one process per
 * provider turn (run-to-completion transport):
 *
 *   inbox delivery → prepareTurn → spawn cursor process (prompt on stdin)
 *     → stream-json events → process close + stdio drain → settle
 *     DeliveryToken → next queued batch
 *
 * Canonical spawn contract (human-confirmed safety posture):
 *   <binary> -p --output-format stream-json --sandbox disabled --force
 *            [--model <exact-operator-value>] [--resume <confirmed-session-id>]
 *   Before each turn, First Tree atomically projects only its managed servers
 *   into `.cursor/mcp.json` and runs `<binary> mcp enable <managed-name>` for
 *   each projected entry.
 *
 * Hard constraints enforced here, not by prompt:
 *   - process cwd = agent home; prompt rides stdin only (never argv);
 *   - args go to `spawn` as an array with `shell: false`;
 *   - no `--trust` / `--workspace` / `--stream-partial-output`, no
 *     `CURSOR_CONFIG_DIR`, no generated `.cursor/cli.json` — the operator's
 *     own Cursor login and permission config (including explicit denies) apply.
 *     The broad `--approve-mcps` flag is never used: provider-native
 *     per-server approval keeps unrelated operator MCP approval unchanged;
 *   - `--resume` only ever carries a stream-confirmed provider session id;
 *     synthetic pending ids stay runtime-local;
 *   - settlement waits for child close + stdout/stderr drain (auth, invalid
 *     model, and quota failures often produce NO `result` event — non-zero
 *     exit + stderr is a first-class failure input, not an afterthought).
 */

/** Prefix for runtime-local pending session ids (never sent to `--resume`). */
export const CURSOR_PENDING_SESSION_PREFIX = "cursor-pending-";

export function isCursorPendingSessionId(sessionId: string): boolean {
  return sessionId.startsWith(CURSOR_PENDING_SESSION_PREFIX);
}

type CursorMcpServerConfig =
  | { command: string; args?: string[] }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

export function mapCursorMcpServers(payload: AgentRuntimeConfigPayload): Record<string, CursorMcpServerConfig> {
  const servers: Record<string, CursorMcpServerConfig> = {};
  for (const server of payload.mcpServers) {
    if (server.transport === "stdio") {
      servers[server.name] = {
        command: server.command,
        ...(server.args === undefined ? {} : { args: server.args }),
      };
    } else {
      servers[server.name] = {
        type: server.transport,
        url: server.url,
        ...(server.headers === undefined ? {} : { headers: server.headers }),
      };
    }
  }
  return servers;
}

/**
 * Cursor stores project MCP approvals beneath a non-blank CURSOR_DATA_DIR, or
 * beneath the child process home otherwise. Keep the exact selector from the
 * final child env in the coordination identity so approval in one store can
 * never authorize a matching projection lease that reads another store.
 */
function cursorMcpApprovalStoreIdentity(env: Readonly<Record<string, string>>): {
  source: "cursor_data_dir" | "process_home";
  value: string | null;
} {
  const dataDir = env.CURSOR_DATA_DIR;
  if (dataDir !== undefined && dataDir.trim().length > 0) {
    return { source: "cursor_data_dir", value: dataDir };
  }
  const homeKey = process.platform === "win32" ? "USERPROFILE" : "HOME";
  return { source: "process_home", value: env[homeKey] ?? null };
}

/**
 * Hash the shared project-state portion of one turn snapshot. Header values
 * and approval-store paths may contain secrets, so the coordinator retains
 * only the digest.
 */
function cursorMcpProjectionFingerprint(
  payload: AgentRuntimeConfigPayload,
  env: Readonly<Record<string, string>>,
): string {
  const canonicalServers = Object.entries(mapCursorMcpServers(payload))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, config]) => {
      if ("command" in config) {
        return [name, { command: config.command, ...(config.args === undefined ? {} : { args: config.args }) }];
      }
      const headers =
        config.headers === undefined
          ? undefined
          : Object.fromEntries(Object.entries(config.headers).sort(([left], [right]) => left.localeCompare(right)));
      return [
        name,
        {
          type: config.type,
          url: config.url,
          ...(headers === undefined ? {} : { headers }),
        },
      ];
    });
  return createHash("sha256")
    .update(
      JSON.stringify({
        // An empty projection performs no approval, so approval-root changes
        // must not serialize otherwise-identical empty turns.
        approvalStore: canonicalServers.length > 0 ? cursorMcpApprovalStoreIdentity(env) : null,
        servers: canonicalServers,
      }),
    )
    .digest("hex");
}

function materializeCursorMcpConfig(workspaceCwd: string, payload: AgentRuntimeConfigPayload): void {
  const configDir = join(workspaceCwd, ".cursor");
  const configPath = join(configDir, "mcp.json");
  const temporaryPath = join(configDir, `.mcp.json.${process.pid}.${randomUUID()}.tmp`);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporaryPath, `${JSON.stringify({ mcpServers: mapCursorMcpServers(payload) }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporaryPath, configPath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The write may have failed before the temporary file was created.
    }
    throw error;
  }
}

/** Cursor's provider-native, single-server approval command. */
export function buildCursorMcpEnableArgs(serverName: string): string[] {
  return ["mcp", "enable", serverName];
}

/** Build the canonical argv (exported so tests can lock the spawn contract). */
export function buildCursorTurnArgs(input: { model: string; resumeSessionId: string | null }): string[] {
  const args = ["-p", "--output-format", "stream-json", "--sandbox", "disabled", "--force"];
  if (input.model) args.push("--model", input.model);
  if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
  return args;
}

/** Bounded stderr tail kept for failure classification (never persisted raw). */
const STDERR_TAIL_LIMIT = 8_192;
/** Grace between SIGTERM and SIGKILL on abort, and the final close wait. */
const KILL_GRACE_MS = 5_000;
const FINAL_CLOSE_WAIT_MS = 10_000;
/** `mcp enable` is a local config operation and must not stall a delivery. */
const CURSOR_MCP_ENABLE_TIMEOUT_MS = 10_000;
const CURSOR_MCP_ENABLE_MAX_BUFFER = 64 * 1024;

type SpawnFn = typeof spawn;
type CursorMcpEnableFn = (input: {
  binary: string;
  serverName: string;
  workspaceCwd: string;
  env: Record<string, string>;
  abortSignal: AbortSignal;
}) => Promise<void>;

const execFileAsync = promisify(execFile);

type CursorMcpSetupPhase = "projection" | "approval";

class CursorMcpSetupError extends Error {
  constructor(
    message: string,
    readonly code?: string | number,
  ) {
    super(message);
    this.name = "CursorMcpSetupError";
  }
}

class CursorMcpProjectionSettlementError extends Error {
  constructor(readonly settlement: ProviderAttemptSettlement) {
    super(`Cursor managed MCP setup stopped: ${settlement.decision.reasonCode}`);
    this.name = "CursorMcpProjectionSettlementError";
  }
}

function cursorMcpSetupErrorCode(err: unknown): string | number | undefined {
  if (!err || typeof err !== "object" || !("code" in err)) return undefined;
  const code = err.code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}

function cursorMcpSetupErrorIsTransient(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const record = err as Record<string, unknown>;
  const code = cursorMcpSetupErrorCode(err);
  const name = err instanceof Error ? err.name : typeof record.name === "string" ? record.name : "";
  const message = err instanceof Error ? err.message : typeof record.message === "string" ? record.message : "";
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    record.killed === true ||
    (typeof code === "string" &&
      /^(?:EAGAIN|EBUSY|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|EAI_AGAIN|EMFILE|ENETUNREACH|ENFILE|ENOTFOUND|EPIPE|ETIMEDOUT)$/.test(
        code,
      )) ||
    /timed out|timeout|network|connection (?:refused|reset)|socket hang up/i.test(message)
  );
}

/**
 * Convert provider/FS output into a secret-safe error that the shared failure
 * taxonomy can route without retaining raw stderr or projected headers.
 */
function sanitizeCursorMcpSetupError(
  err: unknown,
  phase: CursorMcpSetupPhase,
  serverName?: string,
): CursorMcpSetupError {
  if (err instanceof CursorMcpSetupError) return err;
  const code = cursorMcpSetupErrorCode(err);
  if (phase === "approval" && code === "ENOENT") {
    return new CursorMcpSetupError(
      formatCursorBinaryMissingMessage("the bound cursor binary disappeared during managed MCP approval"),
      code,
    );
  }
  if (cursorMcpSetupErrorIsTransient(err)) {
    const error = new CursorMcpSetupError(
      "Cursor managed MCP setup timed out or hit a transient transport failure",
      code,
    );
    error.name = "TimeoutError";
    return error;
  }
  return new CursorMcpSetupError(
    phase === "approval"
      ? `Cursor managed MCP approval configuration failed${serverName ? ` for server "${serverName}"` : ""}`
      : "Cursor managed MCP projection failed because the project configuration is invalid or unavailable (bad config)",
    code,
  );
}

async function enableCursorMcpServer(input: Parameters<CursorMcpEnableFn>[0]): Promise<void> {
  try {
    await execFileAsync(input.binary, buildCursorMcpEnableArgs(input.serverName), {
      cwd: input.workspaceCwd,
      env: input.env,
      shell: false,
      signal: input.abortSignal,
      timeout: CURSOR_MCP_ENABLE_TIMEOUT_MS,
      maxBuffer: CURSOR_MCP_ENABLE_MAX_BUFFER,
      windowsHide: true,
    });
  } catch (err) {
    if (input.abortSignal.aborted) throw err;
    // The CLI may include parsed config in stderr. Preserve only a safe
    // category/code; raw output can contain remote MCP headers.
    throw sanitizeCursorMcpSetupError(err, "approval", input.serverName);
  }
}

/**
 * Cursor processes share project MCP state through the agent workspace.
 * Matching fingerprints take shared leases and keep the configured agent
 * concurrency intact. A different fingerprint waits for the old projection's
 * live turns to release, then performs one exclusive materialize/approval
 * transition before its cohort starts.
 */
type CursorWorkspaceProjectionLease = { release(): void };
type CursorWorkspaceProjectionWaiter = {
  fingerprint: string;
  setup: () => Promise<void>;
  abortSignal: AbortSignal;
  resolve: (lease: CursorWorkspaceProjectionLease) => void;
  reject: (err: unknown) => void;
  onAbort: () => void;
  phase: "queued" | "transitioning" | "settled";
};
type CursorWorkspaceProjectionState = {
  fingerprint: string | null;
  activeLeases: number;
  transitioning: boolean;
  queue: CursorWorkspaceProjectionWaiter[];
};

const cursorWorkspaceProjectionStates = new Map<string, CursorWorkspaceProjectionState>();

function cursorAbortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function settleCursorProjectionWaiterWithError(waiter: CursorWorkspaceProjectionWaiter, err: unknown): void {
  if (waiter.phase === "settled") return;
  waiter.phase = "settled";
  waiter.abortSignal.removeEventListener("abort", waiter.onAbort);
  waiter.reject(err);
}

function grantCursorProjectionLease(
  state: CursorWorkspaceProjectionState,
  waiter: CursorWorkspaceProjectionWaiter,
): void {
  if (waiter.phase === "settled") return;
  waiter.phase = "settled";
  waiter.abortSignal.removeEventListener("abort", waiter.onAbort);
  state.activeLeases++;
  let released = false;
  waiter.resolve({
    release: () => {
      if (released) return;
      released = true;
      state.activeLeases = Math.max(0, state.activeLeases - 1);
      drainCursorProjectionQueue(state);
    },
  });
}

function drainCursorProjectionQueue(state: CursorWorkspaceProjectionState): void {
  if (state.transitioning) return;

  while (state.queue[0]?.abortSignal.aborted) {
    const aborted = state.queue.shift();
    if (aborted) settleCursorProjectionWaiterWithError(aborted, cursorAbortError());
  }
  const first = state.queue[0];
  if (!first) return;

  if (state.activeLeases > 0) {
    // Preserve FIFO transition fairness: matching turns may share the current
    // projection only until a different fingerprint reaches the queue head.
    while (state.queue[0]?.fingerprint === state.fingerprint) {
      const matching = state.queue.shift();
      if (matching) grantCursorProjectionLease(state, matching);
    }
    return;
  }

  if (state.fingerprint === first.fingerprint) {
    while (state.queue[0]?.fingerprint === state.fingerprint) {
      const matching = state.queue.shift();
      if (matching) grantCursorProjectionLease(state, matching);
    }
    return;
  }

  const transition = state.queue.shift();
  if (!transition) return;
  transition.phase = "transitioning";
  state.transitioning = true;
  void transition.setup().then(
    () => {
      state.transitioning = false;
      if (transition.abortSignal.aborted) {
        // Setup may already have replaced the shared file before observing
        // abort. Treat the live projection as unknown until the next owner
        // materializes it again.
        state.fingerprint = null;
        settleCursorProjectionWaiterWithError(transition, cursorAbortError());
      } else {
        state.fingerprint = transition.fingerprint;
        grantCursorProjectionLease(state, transition);
      }
      drainCursorProjectionQueue(state);
    },
    (err: unknown) => {
      state.transitioning = false;
      // A failed approval can follow a successful atomic file replacement.
      // Never let the previous fingerprint lease that potentially-new file.
      state.fingerprint = null;
      settleCursorProjectionWaiterWithError(transition, err);
      drainCursorProjectionQueue(state);
    },
  );
}

function acquireCursorWorkspaceProjectionLease(input: {
  workspaceCwd: string;
  fingerprint: string;
  abortSignal: AbortSignal;
  setup: () => Promise<void>;
}): Promise<CursorWorkspaceProjectionLease> {
  if (input.abortSignal.aborted) return Promise.reject(cursorAbortError());
  const key = resolve(input.workspaceCwd);
  let state = cursorWorkspaceProjectionStates.get(key);
  if (!state) {
    state = { fingerprint: null, activeLeases: 0, transitioning: false, queue: [] };
    cursorWorkspaceProjectionStates.set(key, state);
  }
  const projectionState = state;
  return new Promise<CursorWorkspaceProjectionLease>((resolveLease, reject) => {
    const waiter: CursorWorkspaceProjectionWaiter = {
      fingerprint: input.fingerprint,
      setup: input.setup,
      abortSignal: input.abortSignal,
      resolve: resolveLease,
      reject,
      onAbort: () => {
        if (waiter.phase !== "queued") return;
        const index = projectionState.queue.indexOf(waiter);
        if (index >= 0) projectionState.queue.splice(index, 1);
        settleCursorProjectionWaiterWithError(waiter, cursorAbortError());
        drainCursorProjectionQueue(projectionState);
      },
      phase: "queued",
    };
    input.abortSignal.addEventListener("abort", waiter.onAbort, { once: true });
    projectionState.queue.push(waiter);
    drainCursorProjectionQueue(projectionState);
  });
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** True when a shell command is PROVEN read-only (replay-safe under §9). */
export function cursorShellCommandIsReadOnly(command: string | null): boolean {
  if (!command) return false;
  const classification = classifyShellCommandIo(command);
  return classification.supported && classification.action === "read";
}

/**
 * True when a tool invocation is PROVEN read-only. Read tools and provably
 * read-only shell commands keep a turn replay-safe (`pre_visible` — the
 * design's "provider_active: thinking/read-only activity may retry" rung);
 * everything else, including unknown tool unions, counts as an unproven side
 * effect and ends automatic replay.
 */
function cursorToolIsReadOnly(tool: CursorToolCall): boolean {
  return tool.name === "read" || (tool.name === "shell" && cursorShellCommandIsReadOnly(tool.command));
}

function cursorToolEventName(tool: CursorToolCall): string {
  return tool.name === "unknown" ? `cursor:${tool.unionKey ?? "unknown"}` : tool.name;
}

export const createCursorHandler: HandlerFactory = (config) => {
  const workspaceRoot = config.workspaceRoot as string;
  const agentName = typeof config.agentName === "string" ? config.agentName : "";
  const runtimeProvider = runtimeProviderSchema.parse(config.runtimeProvider);
  const providerTurnMaxRetries = maxProviderTurnRetryAttempts();
  const agentConfigCache = (config.agentConfigCache as AgentConfigCache | undefined) ?? null;
  const contextSource = contextSourceFromHandlerConfig(config);
  const contextTree = preparationCoordinatesFromSource(contextSource);
  const gitAttribution = remoteGitAttributionFromSource(contextSource);
  const contextTreePath = gitAttribution.contextTreePath;
  const contextTreeRepoUrl = gitAttribution.contextTreeRepoUrl;
  const contextTreeBranch = contextTree.kind === "remote" ? contextTree.branch : null;
  const spawnFn = (config.cursorSpawnFn as SpawnFn | undefined) ?? spawn;
  const enableMcpServer = (config.cursorMcpEnableFn as CursorMcpEnableFn | undefined) ?? enableCursorMcpServer;
  const resolveBinary =
    (config.cursorBinaryResolver as typeof resolveCursorRuntimeBinary | undefined) ?? resolveCursorRuntimeBinary;

  let cwd: string | null = null;
  let ctx: SessionContext | null = null;
  let activePayload: AgentRuntimeConfigPayload | null = null;
  let binary: string | null = null;
  /** Stream-confirmed provider session id — the ONLY value `--resume` may carry. */
  let providerSessionId: string | null = null;
  /** Runtime-local placeholder returned when the first turn settled before init. */
  let pendingSyntheticId: string | null = null;
  /**
   * Session-liveness fence for the run-to-completion transport. True from the
   * end of prepareSession until suspend()/shutdown(). Queued drains and
   * runTurn refuse to spawn while false, so a drain that raced past its gates
   * before suspend cannot start a provider process on a suspended session,
   * and an inject landing during prepareSession's awaits cannot run ahead of
   * the session's own first turn.
   */
  let sessionActive = false;
  let currentAbort: AbortController | null = null;
  let currentTurnPromise: Promise<void> | null = null;
  /**
   * Turn/identity fence: emit, settlement, the child slot, and finally-cleanup
   * all capture the generation they belong to; a stale continuation (late
   * timeout, delayed close) must never touch a newer turn's state.
   */
  let turnGeneration = 0;
  let drainScheduled = false;
  let drainInProgress = false;
  let initialTurnPreparing = false;
  const queuedMessages: Array<{ message: SessionMessage; token: DeliveryToken }> = [];
  /**
   * One-shot provider context. Cursor has no accessible system-prompt channel
   * (the hidden `--system-prompt` flag is vendor-internal), so the runtime
   * output contract + escaped Current Chat Context + any briefing re-read
   * notice ride the next messageful provider turn's stdin input, then clear.
   * Queued injects must not consume it before a turn actually enters the
   * provider.
   */
  let pendingChatContextPrompt: string | null = null;
  const gitWriteTracker: ContextTreeGitWriteTracker = createContextTreeGitWriteTracker({
    contextTreePath,
    contextTreeRepoUrl,
    contextTreeBranch,
    log: (message) => ctx?.log(message),
  });

  function emitProviderTurnSettlementEvent(sessionCtx: SessionContext, settlement: ProviderAttemptSettlement): void {
    sessionCtx.emitEvent({
      kind: "error",
      payload: {
        source: "runtime",
        message: encodeProviderRetryEventMessage(settlement.eventPayload),
      },
    });
  }

  function consumedReasonForProviderSettlement(settlement: ProviderAttemptSettlement): TurnConsumedErrorReason {
    return settlement.decision.action === "stop" && settlement.decision.terminalKind === "capacity_wait_required"
      ? "capacity_wait_required"
      : settlement.decision.action === "stop" && settlement.decision.terminalKind === "exhausted"
        ? "provider_retry_exhausted"
        : settlement.decision.reasonCode;
  }

  async function prepareCursorMcpProjection(input: {
    workspaceCwd: string;
    activeBinary: string;
    turnPayload: AgentRuntimeConfigPayload;
    env: Record<string, string>;
    sessionCtx: SessionContext;
    generation: number;
    abortSignal: AbortSignal;
  }): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      let setupError: CursorMcpSetupError | null = null;
      try {
        materializeCursorMcpConfig(input.workspaceCwd, input.turnPayload);
      } catch (err) {
        setupError = sanitizeCursorMcpSetupError(err, "projection");
      }

      if (!setupError) {
        for (const server of input.turnPayload.mcpServers) {
          try {
            await enableMcpServer({
              binary: input.activeBinary,
              serverName: server.name,
              workspaceCwd: input.workspaceCwd,
              env: input.env,
              abortSignal: input.abortSignal,
            });
          } catch (err) {
            if (input.abortSignal.aborted || turnGeneration !== input.generation) throw cursorAbortError();
            setupError = sanitizeCursorMcpSetupError(err, "approval", server.name);
            break;
          }
        }
      }

      if (!setupError) {
        if (input.abortSignal.aborted || turnGeneration !== input.generation) throw cursorAbortError();
        return;
      }
      if (input.abortSignal.aborted || turnGeneration !== input.generation) throw cursorAbortError();

      const providerAttempt = new ProviderAttempt({
        provider: runtimeProvider,
        scope: "provider_turn",
        source: "stream",
        replaySafety: "pre_provider",
      });
      providerAttempt.recordSignal({ kind: "local_error", error: setupError });
      const settlement = providerAttempt.settle({ attempt });
      if (!settlement) throw setupError;
      emitProviderTurnSettlementEvent(input.sessionCtx, settlement);

      if (settlement.decision.action === "retry") {
        input.sessionCtx.log(
          `cursor managed MCP setup retry ${attempt}/${providerTurnMaxRetries + 1} ` +
            `after ${settlement.decision.delayMs}ms; ${settlement.classification.category}/` +
            settlement.decision.reasonCode,
        );
        await sleepWithAbort(settlement.decision.delayMs, input.abortSignal);
        continue;
      }

      input.sessionCtx.log(
        `cursor managed MCP setup stopped before provider start: ${settlement.classification.category}/` +
          settlement.decision.reasonCode,
      );
      input.sessionCtx.emitEvent({
        kind: "error",
        payload: {
          source: "sdk",
          message:
            `Cursor managed MCP setup failed (${settlement.classification.category}/` +
            `${settlement.decision.reasonCode}).`,
        },
      });
      throw new CursorMcpProjectionSettlementError(settlement);
    }
  }

  function buildEnv(sessionCtx: SessionContext, payload: AgentRuntimeConfigPayload): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    for (const e of payload.env) env[e.key] = e.value;
    // The First Tree envelope injects the runtime-session token FILE PATH and
    // identity ids — never a token value.
    const merged = sessionCtx.buildAgentEnv(env);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(merged)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }

  function formatCursorError(message: string): string {
    if (isCursorAuthError(message)) return formatAuthHint("cursor", message);
    return message;
  }

  function consumePendingChatContext(input: string): string {
    const chatPrompt = pendingChatContextPrompt;
    pendingChatContextPrompt = null;
    // Same provider-neutral runtime output contract as the codex path — Cursor
    // gets no persistent system-prompt channel, so the contract rides every
    // turn's stdin input ahead of any chat-context block. Chat-context field
    // values are labelled data and escaped upstream; they cannot re-address the
    // turn or forge prompt sections.
    const contract = renderRuntimeOutputContract();
    const prefix = chatPrompt ? `${contract}\n\n${chatPrompt}` : contract;
    return `${prefix}\n\n${input}`;
  }

  function cursorNativePathRefs(filePath: string | null, origin: "tool_arg" | "file_change"): ToolFileRef[] {
    if (!filePath || !cwd) return [];
    const attribution: ContextTreeAttribution = { contextTreePath, contextTreeRepoUrl };
    const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(cwd, filePath);
    const repoRelativePath = resolveContextTreeRelativePath(absolutePath, attribution);
    const ref: ToolFileRef = {
      origin,
      localPath: filePath,
      pathKind: "file",
      ...(contextTreeRepoUrl && repoRelativePath && repoRelativePath !== "/"
        ? {
            repoUrl: contextTreeRepoUrl,
            ...(contextTreeBranch ? { repoBranch: contextTreeBranch } : {}),
            repoRelativePath,
          }
        : {}),
    };
    return [origin === "tool_arg" ? withContextTreeRepoHeadCommit(ref, absolutePath) : ref];
  }

  /** Terminal-tool ref assembly: provider-derived refs + git-status-delta refs. */
  function refsForCompletedTool(input: {
    ok: boolean;
    readOnly: boolean;
    providerRefs: ToolFileRef[];
    toolName: string;
    toolUseId: string;
  }): ToolFileRef[] | undefined {
    // A PROVEN read-only tool cannot have moved the tree's git status — skip
    // the per-tool `git status` spawn entirely (tool-heavy read turns would
    // otherwise stall the event loop once per read). Any accumulated dirty
    // paths stay attributed to the next non-read-only tool.
    if (input.readOnly) {
      return input.providerRefs.length > 0 ? input.providerRefs : undefined;
    }
    if (!input.ok) {
      // A failed tool still moves the baseline so the NEXT successful tool
      // does not swallow this one's dirty paths.
      gitWriteTracker.captureBaseline();
      return undefined;
    }
    const gitStatusRefs = gitWriteTracker.refsForSuccessfulToolCall({
      toolName: input.toolName,
      toolUseId: input.toolUseId,
      existingRefs: input.providerRefs,
    });
    const refs = [...input.providerRefs, ...gitStatusRefs];
    return refs.length > 0 ? refs : undefined;
  }

  /**
   * The directory a shell tool actually executed in: Cursor's own
   * `workingDirectory` when it reports one, else the agent home. Relative
   * paths in the command MUST resolve against the provider-reported cwd — a
   * `cat NODE.md` run with workingDirectory=<home>/context-tree read the
   * tree's NODE.md, not <home>/NODE.md.
   */
  function shellEffectiveCwd(tool: Extract<CursorToolCall, { name: "shell" }>): string | null {
    return tool.workingDirectory && tool.workingDirectory.length > 0 ? tool.workingDirectory : cwd;
  }

  function providerRefsForTool(tool: CursorToolCall): ToolFileRef[] {
    switch (tool.name) {
      case "read":
        return cursorNativePathRefs(tool.path, "tool_arg");
      case "edit":
      case "write":
        return cursorNativePathRefs(tool.path, "file_change");
      case "shell": {
        const effectiveCwd = shellEffectiveCwd(tool);
        return effectiveCwd && tool.command
          ? toolFileRefsFromShellCommand({
              command: tool.command,
              cwd: effectiveCwd,
              contextTreePath,
              contextTreeRepoUrl,
              contextTreeBranch,
            })
          : [];
      }
      case "unknown":
        return [];
    }
  }

  function toolArgsForEvent(tool: CursorToolCall): unknown {
    switch (tool.name) {
      case "shell": {
        const effectiveCwd = shellEffectiveCwd(tool);
        return { command: tool.command, ...(effectiveCwd ? { cwd: effectiveCwd } : {}) };
      }
      case "read":
      case "edit":
      case "write":
        return { path: tool.path };
      case "unknown":
        return { unionKey: tool.unionKey };
    }
  }

  type TurnStreamState = {
    parser: CursorStreamParser;
    attempt: ProviderAttempt;
    sawInit: boolean;
    sawResult: boolean;
    resultIsError: boolean;
    resultText: string;
    usage: CursorUsage | null;
    userVisibleEmitted: boolean;
    toolEffectStarted: boolean;
    unknownEventCount: number;
  };

  function updateReplaySafety(state: TurnStreamState): void {
    // §9 replay-safety ladder: user-visible assistant output and any
    // non-read-only tool effect both end automatic replay; pure thinking /
    // read-only activity stays retryable; nothing from the provider yet is
    // pre_provider.
    if (state.toolEffectStarted) {
      state.attempt.setReplaySafety("unsafe");
    } else if (state.userVisibleEmitted) {
      state.attempt.markUserVisibleOutput();
    } else if (state.sawInit) {
      state.attempt.setReplaySafety("pre_visible");
    } else {
      state.attempt.setReplaySafety("pre_provider");
    }
  }

  function adoptProviderSessionId(sessionCtx: SessionContext, streamSessionId: string | null): void {
    if (!streamSessionId || isCursorPendingSessionId(streamSessionId)) return;
    if (providerSessionId === streamSessionId) return;
    const hadSynthetic = pendingSyntheticId !== null && providerSessionId === null;
    const syntheticId = pendingSyntheticId;
    providerSessionId = streamSessionId;
    if (hadSynthetic && syntheticId) {
      // Atomically upgrade the runtime-local placeholder to the real provider
      // id without dropping inbox custody.
      sessionCtx.replaceSessionId?.(streamSessionId, "cursor_session_id_confirmed");
      pendingSyntheticId = null;
      // Migrate the briefing-fingerprint baseline to the real id — future
      // turns key the baseline by the confirmed id, and a stranded
      // synthetic-key baseline would read as "briefing changed" forever,
      // prepending a bogus re-read notice on every later turn.
      if (cwd) {
        try {
          const baseline = readSessionBriefingFingerprint(cwd, syntheticId);
          if (baseline) writeSessionBriefingFingerprint(cwd, streamSessionId, baseline);
        } catch (err) {
          sessionCtx.log(
            `briefing fingerprint migration failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  function handleStreamEvent(event: CursorStreamEvent, state: TurnStreamState, sessionCtx: SessionContext): void {
    sessionCtx.recordProviderActivity();
    switch (event.kind) {
      case "init": {
        state.sawInit = true;
        // Stream open = turn boundary; `thinking_delta` and `user_echo` below
        // are deliberately not emitted as events, so without this the chat
        // would stay Idle until the first completed block.
        sessionCtx.noteTurnStart();
        adoptProviderSessionId(sessionCtx, event.sessionId);
        break;
      }
      case "user_echo":
        break;
      case "thinking_delta":
        // Presence-only marker at block completion; per-delta emission would
        // flood the event stream (activity is already recorded above).
        break;
      case "thinking_completed":
        sessionCtx.emitEvent({ kind: "thinking", payload: {} });
        break;
      case "assistant_message": {
        // Cursor `assistant` events may be full fragments or deltas depending
        // on flags/version, so they are NOT the canonical final text (the
        // successful `result.result` is). They still count as user-visible
        // activity for replay safety. Emitted as assistant_text only via the
        // final result to avoid double-recording fragment+total.
        if (event.text.trim()) state.userVisibleEmitted = true;
        break;
      }
      case "tool_started": {
        // §9 replay ladder: only a PROVEN read-only tool keeps the turn
        // retryable; anything else is an unproven side effect. Read-only tool
        // activity does not flip `user_visible` — the design deliberately
        // accepts re-emitting read-only tool events on a replay-safe retry.
        if (!cursorToolIsReadOnly(event.tool)) state.toolEffectStarted = true;
        sessionCtx.emitEvent({
          kind: "tool_call",
          payload: {
            toolUseId: event.callId,
            name: cursorToolEventName(event.tool),
            args: toolArgsForEvent(event.tool),
            status: "pending",
          },
        });
        break;
      }
      case "tool_completed": {
        const ok = !event.result.failed;
        const readOnly = cursorToolIsReadOnly(event.tool);
        if (!readOnly) state.toolEffectStarted = true;
        const providerRefs = ok ? providerRefsForTool(event.tool) : [];
        const toolFileRefs = refsForCompletedTool({
          ok,
          readOnly,
          providerRefs,
          toolName: cursorToolEventName(event.tool),
          toolUseId: event.callId,
        });
        sessionCtx.emitEvent({
          kind: "tool_call",
          payload: {
            toolUseId: event.callId,
            name: cursorToolEventName(event.tool),
            args: toolArgsForEvent(event.tool),
            status: ok ? "ok" : "error",
            // Preview is already bounded by the parser; no re-truncation here.
            ...(event.result.preview ? { resultPreview: event.result.preview } : {}),
            ...(toolFileRefs ? { toolFileRefs } : {}),
          },
        });
        break;
      }
      case "result": {
        state.sawResult = true;
        state.resultIsError = event.isError;
        state.resultText = event.text;
        state.usage = event.usage;
        adoptProviderSessionId(sessionCtx, event.sessionId);
        if (event.text.trim()) state.userVisibleEmitted = true;
        break;
      }
      case "unknown": {
        // Tolerant-reader contract: log a bounded diagnostic immediately
        // (deferred logging would be lost when an abort fences the turn —
        // exactly the runs where a misbehaving beta CLI needs explaining).
        // Unknown TOOL unions surface through tool_started / tool_completed
        // with name `cursor:<unionKey>` instead.
        if (state.unknownEventCount < 5) {
          sessionCtx.log(`cursor stream tolerant-parse diagnostic: ${event.note}: ${event.raw}`);
        }
        state.unknownEventCount++;
        break;
      }
    }
  }

  /**
   * Spawn one Cursor CLI attempt and wait for the FULL settlement barrier:
   * child `close` (exit + stdio drained) and stdout line-reader end. Returns
   * the attempt's terminal observation; classification happens in the caller.
   */
  function runCursorProcess(input: {
    binary: string;
    prompt: string;
    args: string[];
    env: Record<string, string>;
    workspaceCwd: string;
    state: TurnStreamState;
    sessionCtx: SessionContext;
    generation: number;
    abortSignal: AbortSignal;
  }): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stderrTail: string; spawnError?: Error }> {
    return new Promise((resolvePromise) => {
      let child: ReturnType<SpawnFn>;
      try {
        child = spawnFn(input.binary, input.args, {
          cwd: input.workspaceCwd,
          env: input.env,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        resolvePromise({
          exitCode: null,
          signal: null,
          stderrTail: "",
          spawnError: err instanceof Error ? err : new Error(String(err)),
        });
        return;
      }

      let stderrTail = "";
      let spawnError: Error | undefined;
      let settled = false;
      let stdoutEnded = false;
      let closed: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null;

      const finishIfDrained = (): void => {
        // Settlement barrier: BOTH the close event (exit status + stdio
        // drained per Node contract) and our stdout reader's `end` must have
        // fired before the attempt settles, so stderr classification never
        // races the exit status.
        if (settled || !closed || !stdoutEnded) return;
        settled = true;
        resolvePromise({ exitCode: closed.exitCode, signal: closed.signal, stderrTail, spawnError });
      };

      const onAbort = (): void => {
        // Turn-local teardown: polite stop first, hard kill after grace. The
        // final-wait deadline below guarantees the promise resolves even if
        // the child never closes.
        try {
          child.kill("SIGTERM");
        } catch {
          /* child may already be gone */
        }
        const hardKill = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, KILL_GRACE_MS);
        hardKill.unref?.();
        const finalDeadline = setTimeout(() => {
          stdoutEnded = true;
          closed = closed ?? { exitCode: null, signal: "SIGKILL" };
          finishIfDrained();
        }, KILL_GRACE_MS + FINAL_CLOSE_WAIT_MS);
        finalDeadline.unref?.();
      };
      input.abortSignal.addEventListener("abort", onAbort, { once: true });

      child.on("error", (err) => {
        spawnError = err instanceof Error ? err : new Error(String(err));
        closed = closed ?? { exitCode: null, signal: null };
        stdoutEnded = true;
        finishIfDrained();
      });

      // A throw escaping a stream 'data'/'end' listener would be an uncaught
      // exception (crashing the daemon with the DeliveryToken unsettled), so
      // event handling is hard-guarded: emitEvent / git-status probing may
      // throw, and the turn must still reach the settlement barrier.
      const handleEventsGuarded = (events: CursorStreamEvent[]): void => {
        for (const event of events) {
          try {
            handleStreamEvent(event, input.state, input.sessionCtx);
          } catch (err) {
            input.sessionCtx.log(
              `cursor stream event handling failed (${event.kind}): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      };
      child.stdout?.setEncoding("utf-8");
      child.stdout?.on("data", (chunk: string) => {
        if (input.abortSignal.aborted || turnGeneration !== input.generation) return;
        handleEventsGuarded(input.state.parser.push(chunk));
      });
      child.stdout?.on("end", () => {
        if (turnGeneration === input.generation && !input.abortSignal.aborted) {
          handleEventsGuarded(input.state.parser.flush());
        }
        stdoutEnded = true;
        finishIfDrained();
      });
      child.stdout?.on("error", () => {
        stdoutEnded = true;
        finishIfDrained();
      });

      child.stderr?.setEncoding("utf-8");
      child.stderr?.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      });
      child.stderr?.on("error", () => {
        /* tail stays best-effort */
      });

      child.on("close", (exitCode, signal) => {
        input.abortSignal.removeEventListener("abort", onAbort);
        closed = { exitCode, signal };
        finishIfDrained();
      });

      // Prompt rides stdin ONLY — argv must never carry prompt text (visible
      // in the host process list).
      child.stdin?.on("error", () => {
        /* EPIPE when the child dies pre-read; close handling classifies it */
      });
      child.stdin?.write(input.prompt);
      child.stdin?.end();
    });
  }

  /**
   * Run one provider turn (possibly several attempts). Returns whether the
   * turn was delivered (settled complete) — the briefing-fingerprint baseline
   * and queued-drain scheduling key off this.
   */
  async function runTurn(
    input: string,
    sessionCtx: SessionContext,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
  ): Promise<boolean> {
    const workspaceCwd = cwd;
    const fallbackPayload = activePayload;
    if (!workspaceCwd || !binary || !fallbackPayload || !sessionActive) {
      // `sessionActive` closes the drain-vs-lifecycle race: a queued turn
      // whose drain passed its gates before suspend()/shutdown() ran must not
      // spawn a provider process on a suspended session.
      token.retry(messages, sessionActive ? "cursor_missing_workspace_or_binary" : "cursor_session_inactive");
      return false;
    }

    const activeBinary = binary;
    await assertContextSourceCurrent({
      sessionCtx,
      sourceAuthorityRoot: workspaceRoot,
      contextTree: {
        kind: contextTree.kind,
        path: contextTree.path,
        repoUrl: contextTree.repoUrl,
        branch: contextTree.branch,
      },
    });
    if (cwd !== workspaceCwd || binary !== activeBinary || !sessionActive) {
      token.retry(messages, "cursor_session_inactive");
      return false;
    }
    // One immutable per-turn snapshot drives MCP projection, targeted
    // approval, model, and env. SessionRuntime refreshes the cache before
    // dispatch, so an active chat converges on its very next turn even when a
    // projection transition must wait for older live turns to drain.
    const turnPayload = agentConfigCache?.get(sessionCtx.agent.agentId)?.payload ?? fallbackPayload;
    const model = turnPayload.model;
    const env = buildEnv(sessionCtx, turnPayload);
    const projectionFingerprint = cursorMcpProjectionFingerprint(turnPayload, env);
    const generation = ++turnGeneration;
    const abort = new AbortController();
    currentAbort = abort;
    const turnPromise = (async () => {
      let projectionLease: CursorWorkspaceProjectionLease;
      try {
        projectionLease = await acquireCursorWorkspaceProjectionLease({
          workspaceCwd,
          fingerprint: projectionFingerprint,
          abortSignal: abort.signal,
          setup: () =>
            prepareCursorMcpProjection({
              workspaceCwd,
              activeBinary,
              turnPayload,
              env,
              sessionCtx,
              generation,
              abortSignal: abort.signal,
            }),
        });
      } catch (err) {
        if (abort.signal.aborted || turnGeneration !== generation) return false;
        if (err instanceof CursorMcpProjectionSettlementError) {
          sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
          await token.complete(messages, consumedErrorOutcome(consumedReasonForProviderSettlement(err.settlement)));
          return true;
        }
        throw err;
      }

      try {
        if (
          abort.signal.aborted ||
          turnGeneration !== generation ||
          cwd !== workspaceCwd ||
          binary !== activeBinary ||
          !sessionActive
        ) {
          return false;
        }
        await assertContextSourceCurrent({
          sessionCtx,
          sourceAuthorityRoot: workspaceRoot,
          contextTree: {
            kind: contextTree.kind,
            path: contextTree.path,
            repoUrl: contextTree.repoUrl,
            branch: contextTree.branch,
          },
        });
        if (
          abort.signal.aborted ||
          turnGeneration !== generation ||
          cwd !== workspaceCwd ||
          binary !== activeBinary ||
          !sessionActive
        ) {
          return false;
        }
        return await runTurnWithProjection(
          input,
          sessionCtx,
          messages,
          token,
          workspaceCwd,
          activeBinary,
          model,
          env,
          generation,
          abort,
        );
      } finally {
        projectionLease.release();
      }
    })().catch((err: unknown) => {
      if (abort.signal.aborted || turnGeneration !== generation) return false;
      throw err;
    });
    currentTurnPromise = turnPromise.then(
      () => {},
      () => {},
    );
    try {
      return await turnPromise;
    } finally {
      if (turnGeneration === generation) {
        currentAbort = null;
        currentTurnPromise = null;
        scheduleQueuedMessagesDrain();
      }
    }
  }

  async function runTurnWithProjection(
    input: string,
    sessionCtx: SessionContext,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
    workspaceCwd: string,
    activeBinary: string,
    model: string,
    env: Record<string, string>,
    generation: number,
    abort: AbortController,
  ): Promise<boolean> {
    if (
      abort.signal.aborted ||
      turnGeneration !== generation ||
      cwd !== workspaceCwd ||
      binary !== activeBinary ||
      !sessionActive
    ) {
      return false;
    }

    // One-shot payload snapshot: a non-delivered exit (abort, retry-path
    // settlement) must put the chat-context/notice back so the redelivery
    // still carries it — otherwise the design's "spawn/transport failure must
    // not consume the notice" rule is violated for the rest of the session.
    const promptSnapshot = pendingChatContextPrompt;
    const providerInput = consumePendingChatContext(input);
    const restorePendingChatContext = (): void => {
      if (pendingChatContextPrompt === null) pendingChatContextPrompt = promptSnapshot;
    };

    token.processingStarted(messages);
    gitWriteTracker.captureBaseline();

    const turnStartedAt = Date.now();

    let finalText = "";
    // Box so TS control-flow analysis survives the assignment living inside
    // the async IIFE below (microsoft/TypeScript#9998).
    const usageBox: { value: CursorUsage | null } = { value: null };
    let consumedErrorReason: TurnConsumedErrorReason | null = null;
    let retryReason: string | null = null;
    let providerCompleted = false;
    let anyUserVisible = false;

    const promise = (async () => {
      for (let attempt = 0; ; attempt++) {
        const state: TurnStreamState = {
          // Fresh parser per attempt — retries must not inherit partial-line state.
          parser: new CursorStreamParser(),
          attempt: new ProviderAttempt({ provider: runtimeProvider, scope: "provider_turn", source: "stream" }),
          sawInit: false,
          sawResult: false,
          resultIsError: false,
          resultText: "",
          usage: null,
          userVisibleEmitted: anyUserVisible,
          toolEffectStarted: false,
          unknownEventCount: 0,
        };
        consumedErrorReason = null;
        retryReason = null;
        let retryRequested = false;
        let retryDelay = 0;

        const args = buildCursorTurnArgs({
          model,
          // Only a stream-confirmed id ever reaches --resume; the first turn
          // (and any turn after a synthetic placeholder) starts fresh.
          resumeSessionId: providerSessionId,
        });

        const outcome = await runCursorProcess({
          binary: activeBinary,
          prompt: providerInput,
          args,
          env,
          workspaceCwd,
          state,
          sessionCtx,
          generation,
          abortSignal: abort.signal,
        });
        if (abort.signal.aborted || turnGeneration !== generation) return;

        anyUserVisible = anyUserVisible || state.userVisibleEmitted;
        // Billed tokens are billed regardless of how the turn settles — keep
        // the latest usage the stream reported so failed/consumed turns still
        // emit token_usage (spend accounting must not under-count the
        // expensive failures).
        if (state.usage) usageBox.value = state.usage;

        const applySettlement = (settlement: ProviderAttemptSettlement, reasonPrefix: string): void => {
          if (settlement.decision.action === "retry") {
            retryRequested = true;
            retryDelay = settlement.decision.delayMs;
            retryReason = `${reasonPrefix} (${settlement.classification.category}): ${settlement.messagePreview}`;
            emitProviderTurnSettlementEvent(sessionCtx, settlement);
            return;
          }
          emitProviderTurnSettlementEvent(sessionCtx, settlement);
          if (settlement.decision.replaySafety === "pre_provider" && settlement.decision.terminalKind === "exhausted") {
            retryReason = settlement.decision.reasonCode;
          } else {
            consumedErrorReason =
              settlement.decision.terminalKind === "capacity_wait_required"
                ? "capacity_wait_required"
                : settlement.decision.terminalKind === "exhausted"
                  ? "provider_retry_exhausted"
                  : settlement.decision.reasonCode;
          }
          sessionCtx.emitEvent({
            kind: "error",
            payload: { source: "sdk", message: formatCursorError(settlement.messagePreview) },
          });
        };

        if (state.sawResult && !state.resultIsError && outcome.exitCode === 0 && !outcome.spawnError) {
          finalText = state.resultText;
          providerCompleted = true;
          return;
        }

        // Failure path. Auth / invalid model / quota commonly produce NO
        // result event — classify from stderr tail + exit status. A logical
        // `result.is_error` carries the REAL cause in its text, so it leads;
        // stderr is appended (never preferred) so benign beta-CLI stderr
        // noise cannot mask a quota/config message behind a warning line.
        updateReplaySafety(state);
        const stderrText = outcome.stderrTail.trim();
        const resultErrorText = state.sawResult && state.resultIsError ? state.resultText.trim() : "";
        const failureText =
          outcome.spawnError?.message ??
          (resultErrorText
            ? stderrText
              ? `${resultErrorText}\nstderr: ${stderrText}`
              : resultErrorText || "cursor result reported is_error"
            : stderrText ||
              `cursor-agent exited ${outcome.exitCode ?? `signal ${outcome.signal ?? "unknown"}`} without a result event`);
        const failureError =
          outcome.spawnError && (outcome.spawnError as NodeJS.ErrnoException).code === "ENOENT"
            ? new Error(formatCursorBinaryMissingMessage(`the bound cursor binary disappeared: ${activeBinary}`))
            : new Error(failureText);
        state.attempt.recordSignal({
          kind: outcome.spawnError ? "local_error" : "provider_error",
          error: failureError,
        });
        const settlement = state.attempt.settle({ attempt: attempt + 1 });
        if (settlement) applySettlement(settlement, outcome.spawnError ? "spawn failed" : "provider failed");

        if (!retryRequested) return;
        sessionCtx.log(
          `cursor turn retry ${attempt + 1}/${providerTurnMaxRetries + 1} after ${retryDelay}ms; ${retryReason}`,
        );
        try {
          await sleepWithAbort(retryDelay, abort.signal);
        } catch {
          return; // suspend/shutdown raced ahead
        }
        try {
          await assertContextSourceCurrent({
            sessionCtx,
            sourceAuthorityRoot: workspaceRoot,
            contextTree: {
              kind: contextTree.kind,
              path: contextTree.path,
              repoUrl: contextTree.repoUrl,
              branch: contextTree.branch,
            },
          });
        } catch (sourceError) {
          if (!isContextSourceTransitionError(sourceError)) throw sourceError;
          token.retry(messages, "cursor_context_source_changed");
          sessionCtx.failSessionForRecovery?.("cursor_context_source_changed", providerSessionId ?? undefined);
          return;
        }
      }
    })();

    await promise;

    if (abort.signal.aborted || turnGeneration !== generation) {
      // Suspend/shutdown/preemption raced ahead — not a delivered turn; the
      // chat-context/notice payload must survive for the redelivery.
      restorePendingChatContext();
      return false;
    }

    let forwardFailed = false;
    if (providerCompleted && consumedErrorReason === null && retryReason === null) {
      // §8.2 ordering: the canonical final text lands as chunked
      // assistant_text FIRST, then the completion hook runs. The hook fires
      // on every success — including silent / tool-only turns with empty
      // result text — so per-chat trigger ownership is released (historic
      // prototype bug #8).
      if (finalText.trim()) {
        for (const chunk of chunkAssistantText(finalText)) {
          sessionCtx.emitEvent({ kind: "assistant_text", payload: { text: chunk } });
        }
      }
      try {
        await sessionCtx.forwardResult(finalText);
      } catch (err) {
        forwardFailed = true;
        const msg = err instanceof Error ? err.message : String(err);
        sessionCtx.emitEvent({
          kind: "error",
          payload: { source: "runtime", message: `forwardResult failed: ${msg}` },
        });
      }
    }

    const capturedUsage = usageBox.value;
    if (capturedUsage) {
      try {
        sessionCtx.emitEvent({
          kind: "token_usage",
          payload: {
            provider: "cursor",
            model: model || "cursor-default",
            inputTokens: capturedUsage.inputTokens,
            cachedInputTokens: capturedUsage.cacheReadTokens,
            outputTokens: capturedUsage.outputTokens,
          },
        });
      } catch (err) {
        sessionCtx.log(`Failed to emit token_usage: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const settlement = resolveTurnSettlement({ retryReason, consumedErrorReason, forwardFailed });
    if (settlement.action.kind === "complete") {
      sessionCtx.emitEvent({ kind: "turn_end", payload: { status: settlement.status } });
      await token.complete(messages, settlement.action.outcome);
    } else {
      sessionCtx.emitEvent({ kind: "turn_end", payload: { status: settlement.status } });
      // Retry-path settlement: the delivery goes back for redelivery, so the
      // one-shot chat-context/notice must be available to it again.
      restorePendingChatContext();
      token.retry(messages, settlement.action.reason);
    }

    if (capturedUsage) {
      sessionCtx.log(
        `cursor usage chatId=${sessionCtx.chatId} duration_ms=${Date.now() - turnStartedAt} ` +
          `input_tokens=${capturedUsage.inputTokens} cache_read_tokens=${capturedUsage.cacheReadTokens} ` +
          `cache_write_tokens=${capturedUsage.cacheWriteTokens} output_tokens=${capturedUsage.outputTokens} ` +
          `status=${settlement.status}`,
      );
    }

    return settlement.action.kind === "complete";
  }

  function scheduleQueuedMessagesDrain(): void {
    if (drainScheduled || drainInProgress) return;
    if (queuedMessages.length === 0 || !ctx || !cwd || !sessionActive || currentTurnPromise || initialTurnPreparing) {
      return;
    }

    drainScheduled = true;
    setImmediate(() => {
      drainScheduled = false;
      if (
        drainInProgress ||
        queuedMessages.length === 0 ||
        !ctx ||
        !cwd ||
        !sessionActive ||
        currentTurnPromise ||
        initialTurnPreparing
      ) {
        scheduleQueuedMessagesDrain();
        return;
      }
      const drained = queuedMessages.splice(0);
      const sessionCtx = ctx;
      drainInProgress = true;
      void mergeAndRun(drained, sessionCtx)
        .catch((err) => {
          sessionCtx.log(`cursor queued turn failed: ${err instanceof Error ? err.message : String(err)}`);
          for (const queued of drained) queued.token.retry(queued.message, "cursor_queued_turn_failed");
        })
        .finally(() => {
          drainInProgress = false;
          scheduleQueuedMessagesDrain();
        });
    });
  }

  /**
   * Active-session briefing hot-switch before an injected turn (same contract
   * as the codex handler): rebuild from the latest cached config; when changed,
   * rewrite AGENTS.md and report so the caller prepends the one-time re-read
   * notice. Source transitions and unsafe managed projections remain
   * fail-closed so the drain owner can return custody to SessionManager.
   */
  async function refreshBriefingForActiveTurn(
    sessionCtx: SessionContext,
  ): Promise<{ fingerprint: string; changed: boolean } | null> {
    const sessionKey = providerSessionId ?? pendingSyntheticId;
    if (!agentConfigCache || !cwd || !sessionKey) return null;
    try {
      const runtimeConfig = agentConfigCache.get(sessionCtx.agent.agentId);
      if (!runtimeConfig) return null;
      const payload = runtimeConfig.payload;
      const projected = await projectManagedWorkspace({
        sessionCtx,
        workspace: cwd,
        agentName,
        runtimeProvider,
        providerSkillRoots: PROVIDER_SKILL_ROOTS,
        runtimeConfig,
        payload,
        existingPayload: activePayload ?? undefined,
        payloadResolved: true,
        contextTree: {
          kind: contextTree.kind,
          path: contextTree.path,
          repoUrl: contextTree.repoUrl,
          branch: contextTree.branch,
        },
        reresolveSource: true,
        markInitComplete: false,
      });
      activePayload = payload;
      const briefing = projected.briefing;
      const fingerprint = computeBriefingFingerprint(briefing);
      if (readSessionBriefingFingerprint(cwd, sessionKey) === fingerprint) return { fingerprint, changed: false };
      return { fingerprint, changed: true };
    } catch (err) {
      if (isContextSourceTransitionError(err)) throw err;
      if (isManagedSkillsUnsafeDiscoveryError(err)) throw err;
      sessionCtx.log(
        `active-session briefing refresh failed, delivering under prior briefing: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  async function mergeAndRun(
    drained: Array<{ message: SessionMessage; token: DeliveryToken }>,
    sessionCtx: SessionContext,
  ): Promise<void> {
    const inputs: string[] = [];
    const messages = drained.map((entry) => entry.message);
    const token = drained[0]?.token;
    if (!token) return;
    let hadFormatFailure = false;
    for (const m of messages) {
      try {
        inputs.push(await sessionCtx.formatInboundContent(m));
      } catch (err) {
        hadFormatFailure = true;
        sessionCtx.log(
          `cursor inject formatInboundContent failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (hadFormatFailure || inputs.length === 0) {
      for (const queued of drained) queued.token.retry(queued.message, "cursor_queued_turn_format_failed");
      return;
    }
    try {
      const refreshed = await refreshBriefingForActiveTurn(sessionCtx);
      if (refreshed?.changed && cwd) {
        const notice = buildBriefingUpdateNotice(join(cwd, "AGENTS.md"));
        pendingChatContextPrompt = pendingChatContextPrompt ? `${notice}\n\n${pendingChatContextPrompt}` : notice;
        sessionCtx.log(`Active session briefing changed — prepending re-read notice (${providerSessionId})`);
      }
      const delivered = await runTurn(inputs.join("\n\n"), sessionCtx, messages, token);
      const sessionKey = providerSessionId ?? pendingSyntheticId;
      if (refreshed?.changed && delivered && cwd && sessionKey) {
        writeSessionBriefingFingerprint(cwd, sessionKey, refreshed.fingerprint);
      }
    } catch (err) {
      if (!isContextSourceTransitionError(err)) throw err;
      for (const queued of drained) queued.token.retry(queued.message, "cursor_context_source_changed");
      sessionCtx.failSessionForRecovery?.("cursor_context_source_changed", providerSessionId ?? undefined);
    }
  }

  function retryQueuedMessages(reason: string): void {
    const drained = queuedMessages.splice(0);
    for (const queued of drained) {
      queued.token.retry(queued.message, reason);
    }
  }

  /**
   * Session bring-up shared by start/resume: payload refresh, chat context,
   * skills, briefing, workspace bootstrap, binary resolution + bounded
   * `--version` smoke check (the capability probe deliberately never launches;
   * this is the first REAL use of the binary).
   */
  async function prepareSession(sessionCtx: SessionContext): Promise<{
    payload: AgentRuntimeConfigPayload;
    briefing: string;
    workspaceCwd: string;
  }> {
    // Landing campaign trials require the codex app-server workspace-only
    // runtime (managed sandbox + confirmed turn-completion records). The
    // cursor handler implements neither — fail closed, same as the codex SDK
    // engine does, instead of running a trial without its guarantees.
    if (isLandingCampaignTrialAgentMetadata(sessionCtx.agent.metadata)) {
      throw new Error(
        "landing campaign trial agents require the codex app-server workspace-only runtime; the cursor provider does not support trials",
      );
    }
    ctx = sessionCtx;

    let runtimeConfig: AgentRuntimeConfig | null = null;
    let payload: AgentRuntimeConfigPayload | null = null;
    if (agentConfigCache) {
      runtimeConfig = await agentConfigCache.refresh(sessionCtx.agent.agentId);
      payload = runtimeConfig.payload;
    }
    const payloadResolved = payload !== null;
    if (!payload) {
      payload = {
        kind: "cursor",
        prompt: { append: "" },
        model: "",
        mcpServers: [],
        env: [],
        gitRepos: [],
        resourceSkills: [],
      };
    }

    const prepared = await prepareManagedSession({
      sessionCtx,
      workspaceRoot,
      agentName,
      runtimeProvider,
      providerSkillRoots: PROVIDER_SKILL_ROOTS,
      runtimeConfig,
      payload,
      payloadResolved,
      contextTree: {
        kind: contextTree.kind,
        path: contextTree.path,
        repoUrl: contextTree.repoUrl,
        branch: contextTree.branch,
      },
    });
    const workspaceCwd = prepared.workspace;
    cwd = workspaceCwd;
    pendingChatContextPrompt = renderChatContextPrompt(prepared.chatContext);
    const briefing = prepared.briefing;

    const resolution = resolveBinary(process.env);
    if (!resolution.ok) {
      // Transient (smoke-check flake under host pressure) reschedules the
      // bring-up; a genuinely absent/broken binary is a permanent capability
      // failure. Both classifications live in the error taxonomy.
      if (resolution.transient) throw new CursorBinaryVerifyTransientError(resolution.error);
      throw new Error(resolution.error);
    }
    binary = resolution.binary;
    sessionCtx.log(
      `cursor binary: ${resolution.binary}${resolution.version ? ` (version ${resolution.version})` : ""}`,
    );

    activePayload = payload;
    sessionActive = true;
    return { payload, briefing, workspaceCwd };
  }

  return {
    async start(message, sessionCtx, token) {
      const deliveryToken = token;

      // Guard the whole bring-up: an inject landing while prepareSession is
      // awaiting must queue, not race ahead of the session's first turn.
      initialTurnPreparing = true;
      let initialTurnCompleted = false;
      let briefing: string;
      let workspaceCwd: string;
      try {
        ({ briefing, workspaceCwd } = await prepareSession(sessionCtx));
        const input = await sessionCtx.formatInboundContent(message);
        await runTurn(input, sessionCtx, [message], deliveryToken);
        initialTurnCompleted = true;
      } finally {
        initialTurnPreparing = false;
        if (initialTurnCompleted) scheduleQueuedMessagesDrain();
      }

      if (!providerSessionId) {
        // First turn settled (e.g. auth/quota terminal consumed) before the
        // stream ever confirmed a provider id. Return a runtime-local
        // placeholder so SessionRuntime does not re-process the already
        // settled delivery; the next confirmed id upgrades it atomically via
        // replaceSessionId.
        pendingSyntheticId = `${CURSOR_PENDING_SESSION_PREFIX}${randomUUID()}`;
      }
      const sessionId = providerSessionId ?? pendingSyntheticId;
      if (!sessionId) throw new Error("cursor session id unresolved after first turn");
      writeSessionBriefingFingerprint(workspaceCwd, sessionId, computeBriefingFingerprint(briefing));
      return { sessionId, route: { kind: "owned", mode: "processing" } };
    },

    async resume(message, sessionId, sessionCtx, token) {
      const deliveryToken = message ? requireDeliveryToken(token, "messageful resume") : noopDeliveryToken();

      // Guard the whole bring-up (see start()): a warm handler keeps
      // ctx/cwd/binary across suspend, so without this an inject arriving
      // during prepareSession's awaits would drain and spawn ahead of the
      // resume turn, stealing the just-rendered chat-context payload.
      initialTurnPreparing = true;
      let briefing: string;
      let workspaceCwd: string;
      try {
        ({ briefing, workspaceCwd } = await prepareSession(sessionCtx));
      } catch (err) {
        initialTurnPreparing = false;
        throw err;
      }

      // A synthetic pending id is runtime-local bookkeeping: it must NEVER be
      // sent to `--resume`. The turn below runs start-shaped; the confirmed id
      // it captures upgrades the mapping via replaceSessionId.
      if (isCursorPendingSessionId(sessionId)) {
        pendingSyntheticId = sessionId;
        providerSessionId = null;
      } else {
        providerSessionId = sessionId;
        pendingSyntheticId = null;
      }

      // Briefing-staleness notice — same contract as codex: a resumed Cursor
      // session read AGENTS.md at its original init and does not reliably
      // re-read it, so a changed briefing gets a one-time re-read notice on the
      // next messageful turn; the baseline advances only after that turn is
      // actually delivered.
      const briefingFingerprint = computeBriefingFingerprint(briefing);
      const briefingChanged =
        Boolean(message) && readSessionBriefingFingerprint(workspaceCwd, sessionId) !== briefingFingerprint;
      if (briefingChanged) {
        const notice = buildBriefingUpdateNotice(join(workspaceCwd, "AGENTS.md"));
        pendingChatContextPrompt = pendingChatContextPrompt ? `${notice}\n\n${pendingChatContextPrompt}` : notice;
        sessionCtx.log(`Resume: briefing changed since last turn — prepending re-read notice (${sessionId})`);
      }

      if (message) {
        let initialTurnCompleted = false;
        let turnDelivered = false;
        try {
          const input = await sessionCtx.formatInboundContent(message);
          turnDelivered = await runTurn(input, sessionCtx, [message], deliveryToken);
          initialTurnCompleted = true;
        } finally {
          initialTurnPreparing = false;
          if (initialTurnCompleted) scheduleQueuedMessagesDrain();
        }
        const sessionKey = providerSessionId ?? pendingSyntheticId ?? sessionId;
        if (turnDelivered) writeSessionBriefingFingerprint(workspaceCwd, sessionKey, briefingFingerprint);
      } else {
        // Admin-triggered resume carries no message (handler contract). The
        // bring-up guard must still clear, or every later inject would queue
        // forever behind a drain gate that never reopens — owned deliveries
        // that never enter the provider or settle.
        initialTurnPreparing = false;
        scheduleQueuedMessagesDrain();
      }

      const effectiveId = providerSessionId ?? pendingSyntheticId ?? sessionId;
      return { sessionId: effectiveId, route: message ? { kind: "owned", mode: "processing" } : null };
    },

    inject(message, token) {
      // Cursor turns are run-to-completion; there is no mid-turn stdin
      // follow-up in v1. Every inject queues and drains as an ordered fused
      // batch after the active turn settles.
      if (!ctx) return { kind: "rejected", reason: "no_active_context", retryable: true };
      const deliveryToken = token;
      queuedMessages.push({ message, token: deliveryToken });
      scheduleQueuedMessagesDrain();
      return { kind: "owned", mode: "queued" };
    },

    async suspend() {
      // Flip the liveness fence FIRST: a drain already past its gates (or a
      // mergeAndRun awaiting formatInboundContent) re-checks sessionActive at
      // runTurn entry and retries its batch instead of spawning post-suspend.
      sessionActive = false;
      retryQueuedMessages("cursor_suspend_before_terminal");
      turnGeneration++;
      currentAbort?.abort();
      try {
        await currentTurnPromise;
      } catch {
        /* abort path */
      }
      currentAbort = null;
      currentTurnPromise = null;
      activePayload = null;
      initialTurnPreparing = false;
      pendingChatContextPrompt = null;
    },

    async shutdown(reason?: string) {
      sessionActive = false;
      retryQueuedMessages(reason ?? "cursor_shutdown_before_terminal");
      turnGeneration++;
      currentAbort?.abort();
      try {
        await currentTurnPromise;
      } catch {
        /* ignore */
      }
      currentAbort = null;
      currentTurnPromise = null;
      activePayload = null;
      // cwd is the persistent agent home — never removed by the runtime.
      cwd = null;
      binary = null;
      providerSessionId = null;
      pendingSyntheticId = null;
      ctx = null;
      initialTurnPreparing = false;
      pendingChatContextPrompt = null;
      queuedMessages.length = 0;
    },
  } satisfies AgentHandler;
};
