import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentRuntimeConfigPayload,
  DEFAULT_CLAUDE_CODE_TUI_RUNTIME_CONFIG_PAYLOAD,
  runtimeProviderSchema,
} from "@first-tree/shared";
import type {
  AgentHandler,
  DeliveryToken,
  HandlerFactory,
  SessionContext,
  SessionMessage,
} from "../../../runtime/contracts.js";
import { noopDeliveryToken, requireDeliveryToken } from "../../../runtime/contracts.js";
import type { AgentConfigCache, ChatContext } from "../../../runtime/provider-support/index.js";
import {
  assertContextSourceCurrent,
  contextSourceFromHandlerConfig,
  createContextTreeGitWriteTracker,
  preparationCoordinatesFromSource,
  prepareManagedSession,
  remoteGitAttributionFromSource,
  renderChatContextPrompt,
  renderRuntimeOutputContract,
} from "../../../runtime/provider-support/index.js";
import { PROVIDER_SKILL_ROOTS } from "../../skill-roots.js";
import { resolveClaudeCodeExecutable } from "../executable.js";
import { mapMcpServers } from "../mcp-config.js";
import { createToolCallProcessor } from "../tool-call-processor.js";
import {
  capturePane,
  deriveSessionName,
  killSession,
  listOwnedSessions,
  newSession,
  ownedSessionPrefix,
  pasteText,
  sendKey,
  sessionExists,
  waitForReady,
} from "./tmux-session.js";
import { type RawTranscriptEntry, TranscriptTailer, transcriptPathFor } from "./transcript-tail.js";
import { WORKING_MARKER } from "./tui-markers.js";
import { resolveTurnDisposition } from "./turn-disposition.js";

const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const TURN_POLL_MS = 250;
const TURN_GRACE_MS = 1500;
const READY_TIMEOUT_MS = 30_000;

/**
 * Claude Code 2.1.170 rejects `--session-id <id> --resume <id>` unless
 * `--fork-session` is also present. Resume should continue the existing
 * conversation, so only new sessions get an explicit `--session-id`.
 *
 * Exported for tests because this flag contract is enforced by the external
 * Claude CLI rather than TypeScript types.
 */
export function buildClaudeSessionFlags(input: { sessionId: string; resumeSessionId: string | null }): string[] {
  if (input.resumeSessionId) {
    return ["--resume", shellQuote(input.resumeSessionId)];
  }
  return ["--session-id", shellQuote(input.sessionId)];
}

function shellQuote(value: string): string {
  if (!value) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export class TuiLifecycleFence {
  private activePromise: Promise<unknown> | null = null;
  private requestedStop = false;

  get active(): Promise<unknown> | null {
    return this.activePromise;
  }

  get stopRequested(): boolean {
    return this.requestedStop;
  }

  requestStop(): void {
    this.requestedStop = true;
  }

  run<T>(body: () => Promise<T>): Promise<T> {
    this.requestedStop = false;
    const promise = (async () => body())();
    const tracked = promise.finally(() => {
      if (this.activePromise === tracked) this.activePromise = null;
    });
    this.activePromise = tracked;
    return tracked;
  }
}

/**
 * Module-level lazy sweep: on first handler instantiation in this process, kill
 * tmux sessions left over from a prior crashed run of THIS client.
 *
 * Scoped by the client-owner prefix (`ftth-<clientTag>-`), never the bare
 * `ftth-` prefix: multiple client processes (prod / staging / dev) and parallel
 * QA slots share one tmux server, so a blanket sweep would kill sessions a
 * concurrent live process is actively driving. The client tag is stable across
 * restarts of the same client, so we still reclaim our own orphans.
 */
let orphanSweepDone = false;
async function orphanSweep(clientId: string): Promise<void> {
  if (orphanSweepDone) return;
  orphanSweepDone = true;
  try {
    const owned = await listOwnedSessions(ownedSessionPrefix(clientId));
    for (const name of owned) {
      try {
        await killSession(name);
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Claude Code TUI Handler — drives `claude` (interactive TUI) through tmux.
 *
 * Replaces the SDK-based `claude-code` handler with a tmux-driven equivalent
 * for the post-SDK-sunset world. Input is injected via `paste-buffer`;
 * events stream from `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
 * (claude's per-session transcript).
 *
 * Durable design constraints live in the Context Tree:
 * https://github.com/agent-team-foundation/first-tree-context/blob/main/system/cloud/runtime/client-runtime.md#claude-code-tui-handler
 */
export const createClaudeCodeTuiHandler: HandlerFactory = (config) => {
  const workspaceRoot = config.workspaceRoot as string;
  const agentName = typeof config.agentName === "string" ? config.agentName : "";
  const runtimeProvider = runtimeProviderSchema.parse(config.runtimeProvider);
  const agentConfigCache = (config.agentConfigCache as AgentConfigCache | undefined) ?? null;
  const contextSource = contextSourceFromHandlerConfig(config);
  const contextTree = preparationCoordinatesFromSource(contextSource);
  const gitAttribution = remoteGitAttributionFromSource(contextSource);
  const contextTreePath = gitAttribution.contextTreePath;
  const contextTreeRepoUrl = gitAttribution.contextTreeRepoUrl;
  const contextTreeBranch = contextTree.kind === "remote" ? contextTree.branch : null;
  // Identifies this client process; scopes tmux session ownership so the orphan
  // sweep and session names never collide with another live client / QA slot
  // on the shared tmux server. Empty string is tolerated (falls back to a
  // placeholder tag) but the daemon always supplies a real client id.
  const clientId = (config.clientId as string | undefined) ?? "";
  const claudeCodeExecutable =
    (config.claudeCodeExecutable as string | undefined) ?? resolveClaudeCodeExecutable().path ?? "claude";

  let cwd: string | null = null;
  let tmuxSessionName: string | null = null;
  let transcriptTailer: TranscriptTailer | null = null;
  let currentTurnPromise: Promise<void> | null = null;
  const lifecycleFence = new TuiLifecycleFence();
  let turnAborted = false;
  // True for the whole span a turn is being prepared/run — start/resume
  // bootstrap through turn completion, or a queued-message turn. This is the
  // single synchronous gate that serialises turn execution: `pump()` starts a
  // queued turn only when this is false, so concurrent injects can never run
  // two turns against one tmux pane.
  let turnRunning = false;
  let ctx: SessionContext | null = null;
  let configTempDir: string | null = null;
  const queuedMessages: Array<{ message: SessionMessage; token: DeliveryToken }> = [];
  // Per-chat state captured at session start — combined with the shared runtime
  // output contract and fed to claude via `--append-system-prompt-file`. The TUI
  // handler can't update system prompt mid-thread (claude is a persistent
  // process), so we snapshot once per startClaude().
  let chatContextForPrompt: ChatContext | undefined;

  function buildEnv(sessionCtx: SessionContext, payload: AgentRuntimeConfigPayload): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    for (const e of payload.env) env[e.key] = e.value;
    const merged = sessionCtx.buildAgentEnv(env);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(merged)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }

  function ensureConfigTempDir(workspaceCwd: string, sessionId: string): string {
    const dir = join(workspaceCwd, ".claude-code-tui", sessionId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Build claude CLI args. Returns the joined command string ready for tmux
   * (tmux runs through the user's $SHELL, which handles quoting reasonably).
   * Inputs that contain spaces are shell-quoted defensively.
   */
  function buildClaudeCommand(input: {
    sessionId: string;
    resumeSessionId: string | null;
    payload: AgentRuntimeConfigPayload;
    workspaceCwd: string;
    claudeBin: string;
  }): string {
    const { sessionId, resumeSessionId, payload, workspaceCwd, claudeBin } = input;
    const args: string[] = [
      shellQuote(claudeBin),
      "--dangerously-skip-permissions",
      // AskUserQuestion is not supported in First Tree. `--dangerously-skip-permissions`
      // bypasses the permission layer, so disabling it via permissions is impossible here;
      // `--disallowed-tools` removes the tool from the model's context entirely instead.
      "--disallowed-tools",
      "AskUserQuestion",
      ...buildClaudeSessionFlags({ sessionId, resumeSessionId }),
    ];
    if (payload.model) {
      args.push("--model", shellQuote(payload.model));
    }

    const tempDir = ensureConfigTempDir(workspaceCwd, sessionId);
    configTempDir = tempDir;

    if (payload.mcpServers.length > 0) {
      const mcpConfigPath = join(tempDir, "mcp-config.json");
      writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: mapMcpServers(payload) }, null, 2), "utf-8");
      args.push("--mcp-config", shellQuote(mcpConfigPath));
      args.push("--strict-mcp-config");
    }

    const appendedSystemPrompt = [renderRuntimeOutputContract(), renderChatContextPrompt(chatContextForPrompt)]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
    const systemPromptPath = join(tempDir, "runtime-context.md");
    writeFileSync(systemPromptPath, appendedSystemPrompt, "utf-8");
    args.push("--append-system-prompt-file", shellQuote(systemPromptPath));

    // The shared briefing is delivered via `<cwd>/CLAUDE.md` (symlink to
    // AGENTS.md) which `--setting-sources user,project` instructs claude to
    // load at startup. The runtime contract and per-chat context are delivered
    // separately above.
    args.push("--setting-sources", "user,project");

    return args.join(" ");
  }

  async function loadPayload(sessionCtx: SessionContext): Promise<AgentRuntimeConfigPayload | null> {
    if (!agentConfigCache) return null;
    const cached = agentConfigCache.get(sessionCtx.agent.agentId);
    if (cached) return cached.payload;
    const refreshed = await agentConfigCache.refresh(sessionCtx.agent.agentId);
    return refreshed.payload;
  }

  async function startClaude(input: {
    sessionCtx: SessionContext;
    resumeSessionId: string | null;
    payload: AgentRuntimeConfigPayload;
    providerEnv: Record<string, string>;
  }): Promise<string> {
    const { sessionCtx, resumeSessionId, payload, providerEnv } = input;
    if (!cwd) throw new Error("startClaude called before cwd was acquired");

    const sessionId = resumeSessionId ?? randomUUID();
    const sessionName = deriveSessionName(clientId, sessionCtx.agent.agentId, sessionCtx.chatId);
    if (await sessionExists(sessionName)) {
      await killSession(sessionName);
    }

    const command = buildClaudeCommand({
      sessionId,
      resumeSessionId,
      payload,
      workspaceCwd: cwd,
      claudeBin: claudeCodeExecutable,
    });

    await assertContextSourceCurrent({
      sessionCtx,
      sourceAuthorityRoot: workspaceRoot,
      contextTree,
    });

    await newSession({
      name: sessionName,
      cwd,
      command,
      env: providerEnv,
    });
    // Track the session name immediately so a waitForReady failure still has a
    // teardown path — otherwise the detached tmux session (and its claude
    // process) leaks until the next process restart's orphan sweep.
    tmuxSessionName = sessionName;
    try {
      await waitForReady({ name: sessionName, timeoutMs: READY_TIMEOUT_MS });
    } catch (err) {
      await killSession(sessionName).catch(() => {});
      tmuxSessionName = null;
      throw err;
    }

    transcriptTailer = new TranscriptTailer(transcriptPathFor(cwd, sessionId));
    return sessionId;
  }

  function defaultPayload(): AgentRuntimeConfigPayload {
    // Reuse the shared default so this stays in sync with the schema (e.g. the
    // `reasoningEffort` field) instead of hand-maintaining the literal here.
    return { ...DEFAULT_CLAUDE_CODE_TUI_RUNTIME_CONFIG_PAYLOAD };
  }

  /**
   * Process raw transcript entries: feed them to the shared tool-call
   * processor (which emits assistant_text / thinking / tool_call events),
   * and pull out the assistant text → accumulated for `forwardResult`.
   */
  type TurnState = {
    finalTexts: string[];
  };

  function consumeEntry(entry: RawTranscriptEntry, sessionCtx: SessionContext, state: TurnState): void {
    // Feed the shared processor — it emits all the session events we'd
    // otherwise have to reimplement (assistant_text / thinking / tool_call
    // pending / tool_call final, including tool file refs when available).
    processor(sessionCtx).onMessage(entry);

    if (entry?.type !== "assistant") return;
    const content = entry.message?.content;
    if (!Array.isArray(content)) return;
    for (const blk of content as Array<Record<string, unknown>>) {
      if (blk.type === "text" && typeof blk.text === "string") {
        const text = blk.text.trim();
        if (text.length > 0) state.finalTexts.push(blk.text);
      }
    }
  }

  // Single processor instance per turn (constructed lazily because we need
  // the session ctx). Reset between turns to free its `pending` map.
  let turnProcessor: ReturnType<typeof createToolCallProcessor> | null = null;
  function processor(sessionCtx: SessionContext): ReturnType<typeof createToolCallProcessor> {
    if (!turnProcessor) {
      turnProcessor = createToolCallProcessor(
        (event) => sessionCtx.emitEvent(event),
        contextTreePath ? { path: contextTreePath, repoUrl: contextTreeRepoUrl, branch: contextTreeBranch } : undefined,
        {
          cwd,
          gitWriteTracker: createContextTreeGitWriteTracker({
            contextTreePath,
            contextTreeRepoUrl,
            contextTreeBranch,
            log: (message) => sessionCtx.log(message),
          }),
        },
      );
    }
    return turnProcessor;
  }
  function resetProcessor(): void {
    turnProcessor?.flush();
    turnProcessor = null;
  }

  async function drainAndConsume(sessionCtx: SessionContext, state: TurnState): Promise<void> {
    if (!transcriptTailer) return;
    for (const entry of transcriptTailer.drainEntries()) {
      consumeEntry(entry, sessionCtx, state);
    }
  }

  async function runTurn(
    text: string,
    sessionCtx: SessionContext,
    messages: readonly SessionMessage[],
    token: DeliveryToken,
  ): Promise<void> {
    if (!tmuxSessionName || !transcriptTailer) {
      throw new Error("runTurn called before session was prepared");
    }
    token.processingStarted(messages);
    turnAborted = false;

    const state: TurnState = { finalTexts: [] };
    let turnFailed = false;
    let timedOut = false;
    let everSawWorking = false;
    let brokeOnIdle = false;

    try {
      // Pre-flush whatever's already in the transcript (the prior turn's
      // tail end) so it doesn't pollute this turn's text accumulation.
      transcriptTailer.drainEntries();

      await pasteText(tmuxSessionName, text);
      sessionCtx.recordProviderActivity();

      const startTs = Date.now();
      while (Date.now() - startTs < TURN_TIMEOUT_MS) {
        if (turnAborted) break;
        sessionCtx.recordProviderActivity();

        await drainAndConsume(sessionCtx, state);

        const pane = await capturePane(tmuxSessionName);
        const working = pane.includes(WORKING_MARKER);
        if (working) everSawWorking = true;
        // A turn that finishes between two polls may never paint the working
        // marker; treat any produced output as evidence the turn ran so a fast
        // reply doesn't block until TURN_TIMEOUT.
        const producedOutput = state.finalTexts.length > 0;
        const sawActivity = everSawWorking || producedOutput;

        if (sawActivity && !working) {
          // Final flush grace period — claude writes the closing
          // assistant_text block to the transcript after the working
          // marker disappears.
          const graceUntil = Date.now() + TURN_GRACE_MS;
          while (Date.now() < graceUntil) {
            await drainAndConsume(sessionCtx, state);
            await sleep(150);
          }
          brokeOnIdle = true;
          break;
        }

        await sleep(TURN_POLL_MS);
      }

      // One last pass in case the timeout-or-break left entries behind.
      await drainAndConsume(sessionCtx, state);

      // Loop hit the TURN_TIMEOUT ceiling (not a clean idle break, not an
      // explicit abort): claude may still be working. Interrupt it so its
      // output doesn't bleed into the next turn's pane/transcript, and flag the
      // turn as timed out — it is NOT a success. A timed-out turn reports
      // `turn_end: error`, stays un-acked (so the inbox entries are redelivered
      // for a real retry instead of being silently consumed), and settles the
      // runtime into `error` (see resolveTurnDisposition).
      if (!brokeOnIdle && !turnAborted) {
        timedOut = true;
        sessionCtx.log(`tui turn exceeded ${TURN_TIMEOUT_MS}ms without completing; interrupting claude`);
        try {
          await sendKey(tmuxSessionName, "Escape");
        } catch {
          /* best-effort */
        }
        sessionCtx.emitEvent({
          kind: "error",
          payload: {
            source: "runtime",
            message: `Turn timed out after ${Math.round(TURN_TIMEOUT_MS / 1000)}s; claude was interrupted before finishing`,
          },
        });
      }
    } catch (err) {
      turnFailed = true;
      sessionCtx.emitEvent({
        kind: "error",
        payload: { source: "runtime", message: err instanceof Error ? err.message : String(err) },
      });
    }

    // Compose the final user-facing text from the accumulated assistant text.
    const finalText = state.finalTexts.join("\n\n").trim();

    // Decide delivery + ack/state from how the turn ended. The `forward` /
    // `ack` flags are independent of forwardResult's own success, so compute
    // them first and use `forward` to gate delivery: on a timeout or a
    // suspend-abort the inbox entry stays un-acked and the message re-runs on
    // reconnect/resume, so forwarding partial output here would double-post
    // (and risk inconsistent output) once the replay produces the real answer.
    let forwardFailed = false;
    const willForward = resolveTurnDisposition({ aborted: turnAborted, timedOut, turnFailed, forwardFailed: false });
    if (willForward.forward && finalText.trim()) {
      try {
        await sessionCtx.forwardResult(finalText);
      } catch (err) {
        forwardFailed = true;
        sessionCtx.emitEvent({
          kind: "error",
          payload: {
            source: "runtime",
            message: `forwardResult failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      }
    }

    // Re-resolve with the real forwardFailed folded in (it only affects
    // `status`). The runtime never auto-acks on turn_end (see SessionContext in
    // handler.ts): when `ack` is false the triggering inbox entries stay
    // in-flight and the server redelivers them on reconnect / restart. A clean
    // close acks even on a forward-only failure (mirrors the SDK handler's
    // ackTurnClose, avoiding redelivery storms); an abort or a timeout
    // withholds the ack so the message gets a real retry.
    const disposition = resolveTurnDisposition({ aborted: turnAborted, timedOut, turnFailed, forwardFailed });
    sessionCtx.emitEvent({ kind: "turn_end", payload: { status: disposition.status } });
    if (disposition.action.kind === "complete") {
      await token.complete(messages, disposition.action.outcome);
    } else {
      token.retry(messages, disposition.action.reason);
    }
    resetProcessor();
  }

  /**
   * Start a turn for any queued messages, if the session is live and no turn is
   * already running. The single serialisation point for turn execution:
   * `inject()` only ever enqueues + calls `pump()`, and `turnRunning` (a plain
   * synchronous boolean) guarantees at most one turn runs against the tmux pane
   * at a time. `currentTurnPromise` is assigned synchronously before any await
   * so a concurrent `suspend()` awaits the turn instead of tearing it down.
   */
  function pump(): void {
    if (turnRunning || lifecycleFence.stopRequested || queuedMessages.length === 0) return;
    const sessionCtx = ctx;
    if (!sessionCtx || !tmuxSessionName) {
      retryQueuedMessages("tui_pump_not_ready");
      return;
    }
    const drained = queuedMessages.splice(0);
    const messages = drained.map((entry) => entry.message);
    const token = drained[0]?.token;
    if (!token) return;
    turnRunning = true;
    const promise = (async () => {
      const inputs: string[] = [];
      let hadFormatFailure = false;
      for (const m of messages) {
        try {
          inputs.push(await sessionCtx.formatInboundContent(m));
        } catch (err) {
          hadFormatFailure = true;
          sessionCtx.log(`tui inject formatInboundContent failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (lifecycleFence.stopRequested) {
          retryDrainedMessagesForRecovery(sessionCtx, drained, "queued_turn_stopped_before_paste");
          return;
        }
      }
      if (lifecycleFence.stopRequested) {
        retryDrainedMessagesForRecovery(sessionCtx, drained, "queued_turn_stopped_before_paste");
        return;
      }
      if (hadFormatFailure || inputs.length === 0) {
        retryDrainedMessagesForRecovery(sessionCtx, drained, "tui_queued_turn_format_failed");
        return;
      }
      await runTurn(inputs.join("\n\n"), sessionCtx, messages, token);
    })();
    currentTurnPromise = promise;
    void promise
      .catch((err) => {
        sessionCtx.log(`tui queued turn failed: ${err instanceof Error ? err.message : String(err)}`);
        retryDrainedMessagesForRecovery(sessionCtx, drained, "tui_queued_turn_failed");
      })
      .finally(() => {
        turnRunning = false;
        currentTurnPromise = null;
        // Drain anything injected while this turn ran. setImmediate keeps the
        // recursion off the stack and lets the just-cleared flags settle.
        setImmediate(pump);
      });
  }

  function retryDrainedMessagesForRecovery(
    sessionCtx: SessionContext | null,
    messages: readonly { message: SessionMessage; token: DeliveryToken }[],
    reason: string,
  ): void {
    if (messages.length === 0) return;
    sessionCtx?.log(`tui ${reason}: retrying ${messages.length} queued message(s) through inbox recovery`);
    for (const queued of messages) {
      queued.token.retry(queued.message, reason);
    }
  }

  function retryQueuedMessages(reason: string): void {
    const drained = queuedMessages.splice(0);
    retryDrainedMessagesForRecovery(ctx, drained, reason);
  }

  function dropQueuedMessagesForRecovery(reason: string): void {
    if (queuedMessages.length > 0) {
      const drained = queuedMessages.splice(0);
      retryDrainedMessagesForRecovery(ctx, drained, reason);
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function teardownTmux(): Promise<void> {
    if (tmuxSessionName) {
      try {
        await killSession(tmuxSessionName);
      } catch {
        /* best-effort */
      }
    }
    tmuxSessionName = null;
    transcriptTailer = null;
    if (configTempDir && existsSync(configTempDir)) {
      try {
        rmSync(configTempDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    configTempDir = null;
  }

  async function waitForStopFence(): Promise<void> {
    const activeLifecycle = lifecycleFence.active;
    const activeTurn = currentTurnPromise;
    if ((activeTurn || !activeLifecycle) && tmuxSessionName) {
      try {
        await sendKey(tmuxSessionName, "Escape");
      } catch {
        /* best-effort */
      }
    }
    try {
      await (activeLifecycle ?? activeTurn);
    } catch {
      /* swallow */
    }
    currentTurnPromise = null;
  }

  return {
    async start(message, sessionCtx, token) {
      return lifecycleFence.run(async () => {
        const deliveryToken = token;
        // Hold turnRunning across the whole bootstrap so an inject arriving while
        // the session is still being prepared queues instead of racing pump()
        // into a second turn the instant startClaude sets tmuxSessionName.
        turnRunning = true;
        try {
          await orphanSweep(clientId);
          ctx = sessionCtx;

          const resolvedPayload = await loadPayload(sessionCtx);
          const payload = resolvedPayload ?? defaultPayload();
          const runtimeConfig = agentConfigCache?.get(sessionCtx.agent.agentId) ?? null;

          // Resolve chat-context and source repos before spawning claude:
          // source repos are rendered into the shared briefing, while
          // chat-context is written to the per-session append-system-prompt
          // file consumed by startClaude().
          const prepared = await prepareManagedSession({
            sessionCtx,
            workspaceRoot,
            agentName,
            runtimeProvider,
            providerSkillRoots: PROVIDER_SKILL_ROOTS,
            runtimeConfig,
            payload,
            // `false` when we fell back to `defaultPayload()` — the empty
            // `gitRepos: []` is then NOT authoritative, and the workspace
            // manifest write is deferred for this session.
            payloadResolved: resolvedPayload !== null && resolvedPayload !== undefined,
            contextTree,
          });
          cwd = prepared.workspace;
          chatContextForPrompt = prepared.chatContext;
          const providerEnv = buildEnv(sessionCtx, payload);

          const sessionId = await startClaude({ sessionCtx, resumeSessionId: null, payload, providerEnv });
          if (lifecycleFence.stopRequested) {
            deliveryToken.retry(message, "tui_start_stopped_before_turn");
            return { sessionId, route: { kind: "owned", mode: "queued" } };
          }

          const inputText = await sessionCtx.formatInboundContent(message);
          if (lifecycleFence.stopRequested) {
            deliveryToken.retry(message, "tui_start_stopped_before_turn");
            return { sessionId, route: { kind: "owned", mode: "queued" } };
          }
          currentTurnPromise = runTurn(inputText, sessionCtx, [message], deliveryToken);
          try {
            await currentTurnPromise;
          } finally {
            currentTurnPromise = null;
          }
          return { sessionId, route: { kind: "owned", mode: "processing" } };
        } finally {
          turnRunning = false;
          // Drain any messages injected during bootstrap / the first turn.
          setImmediate(pump);
        }
      });
    },

    async resume(message, sessionId, sessionCtx, token) {
      return lifecycleFence.run(async () => {
        const deliveryToken = message ? requireDeliveryToken(token, "messageful resume") : noopDeliveryToken();
        turnRunning = true;
        try {
          await orphanSweep(clientId);
          ctx = sessionCtx;

          const resumePayloadResolved = await loadPayload(sessionCtx);
          const payload = resumePayloadResolved ?? defaultPayload();
          const runtimeConfig = agentConfigCache?.get(sessionCtx.agent.agentId) ?? null;

          // Same shared preparation as start(): prepareManagedSession handles
          // the stable workspace sentinel internally, so a stale or failed
          // integration is re-run on resume instead of being skipped.
          const prepared = await prepareManagedSession({
            sessionCtx,
            workspaceRoot,
            agentName,
            runtimeProvider,
            providerSkillRoots: PROVIDER_SKILL_ROOTS,
            runtimeConfig,
            payload,
            // See PR #869 baixiaohang round-3 P0 — same gate as start().
            payloadResolved: resumePayloadResolved !== null && resumePayloadResolved !== undefined,
            contextTree,
          });
          cwd = prepared.workspace;
          chatContextForPrompt = prepared.chatContext;
          const providerEnv = buildEnv(sessionCtx, payload);

          const restartedId = await startClaude({ sessionCtx, resumeSessionId: sessionId, payload, providerEnv });

          if (message) {
            if (lifecycleFence.stopRequested) {
              deliveryToken.retry(message, "tui_resume_stopped_before_turn");
              return { sessionId: restartedId, route: { kind: "owned", mode: "queued" } };
            }
            const inputText = await sessionCtx.formatInboundContent(message);
            if (lifecycleFence.stopRequested) {
              deliveryToken.retry(message, "tui_resume_stopped_before_turn");
              return { sessionId: restartedId, route: { kind: "owned", mode: "queued" } };
            }
            currentTurnPromise = runTurn(inputText, sessionCtx, [message], deliveryToken);
            try {
              await currentTurnPromise;
            } finally {
              currentTurnPromise = null;
            }
          }
          return { sessionId: restartedId, route: message ? { kind: "owned", mode: "processing" } : null };
        } finally {
          turnRunning = false;
          setImmediate(pump);
        }
      });
    },

    inject(message, token) {
      // Always enqueue, then let the single serialised pump() decide when to
      // run. This removes the prior races where an inject arriving in the
      // narrow window around turn completion / startup could either start a
      // second concurrent turn or be stranded with no drain scheduled.
      if (!ctx) return { kind: "rejected", reason: "tui_not_ready", retryable: true };
      const deliveryToken = token;
      queuedMessages.push({ message, token: deliveryToken });
      setImmediate(pump);
      return { kind: "owned", mode: "queued" };
    },

    async suspend() {
      lifecycleFence.requestStop();
      turnAborted = true;
      dropQueuedMessagesForRecovery("suspend");
      await waitForStopFence();
      dropQueuedMessagesForRecovery("suspend");
      await teardownTmux();
    },

    async shutdown(reason?: string) {
      lifecycleFence.requestStop();
      turnAborted = true;
      dropQueuedMessagesForRecovery(reason ?? "shutdown");
      await waitForStopFence();
      dropQueuedMessagesForRecovery(reason ?? "shutdown");
      await teardownTmux();

      // Per agent-session-cwd-redesign: cwd is the per-agent home — shared
      // by every chat. shutdown() must NOT remove it; that would wipe
      // persistent state other chats may resume against. Source repos, the
      // Context Tree clone, and on-demand worktrees under
      // `<cwd>/worktrees/<name>/` are agent-managed state — the agent
      // creates, refreshes, and removes them per its briefing protocol.
      cwd = null;
      ctx = null;
      queuedMessages.length = 0;
    },
  } satisfies AgentHandler;
};
