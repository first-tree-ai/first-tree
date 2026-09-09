import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProviderRetryEventMessage, type SessionEvent } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCtxPlumbing } from "../../../__tests__/test-helpers.js";
import type { DeliveryToken, SessionContext, SessionMessage, TurnOutcome } from "../../../runtime/handler.js";
import type { ProviderProcessSpec, ProviderProcessSupervisor } from "../../../runtime/provider-process-supervisor.js";
import { buildGrokTurnArgs, createGrokHandler, GROK_PENDING_SESSION_PREFIX } from "../index.js";

/**
 * Handler-integration coverage for the per-turn Grok ACP transport, on a fake
 * provider seam — a real `node -e` child speaking NDJSON JSON-RPC (ACP v1)
 * over piped stdio, spawned through the injected ProviderProcessSupervisor.
 * Locks the canonical spawn contract (argv / cwd / prompt-on-stdin), the
 * session/new → session/load lifecycle, the replay fence, usage mapping, and
 * the settlement barrier.
 */

/**
 * Fake Grok ACP agent. Answers initialize / session/new / session/load /
 * session/prompt and streams canned session/update + _x.ai/* notifications.
 * Behavior is driven by env vars (see GROK_FAKE_* below). Every request is
 * appended as one JSON line to GROK_FAKE_REQUEST_LOG.
 */
const FAKE_ACP_AGENT_SCRIPT = `
const fs = require("fs");
const scenario = process.env.GROK_FAKE_SCENARIO || "success";
const sessionId = process.env.GROK_FAKE_SESSION_ID || "grok-sess-1";
const logFile = process.env.GROK_FAKE_REQUEST_LOG || "";
const releaseFile = process.env.GROK_FAKE_RELEASE_FILE || "";
const replyText = process.env.GROK_FAKE_TEXT || "Hello world";
const toolName = process.env.GROK_FAKE_TOOL || "";
const toolPath = process.env.GROK_FAKE_TOOL_PATH || "notes.md";
const stopReason = process.env.GROK_FAKE_STOP_REASON || "end_turn";
const rejectSetModel = process.env.GROK_FAKE_REJECT_SET_MODEL === "1";
const setModelResponse = process.env.GROK_FAKE_SET_MODEL_RESPONSE || "ok";
const echoMode = process.env.GROK_FAKE_ECHO_MODE || "after";
const replayMarked = process.env.GROK_FAKE_REPLAY_MARKED === "1";
const mcpHttp = process.env.GROK_FAKE_MCP_HTTP !== "0";
const mcpSse = process.env.GROK_FAKE_MCP_SSE !== "0";
let buffer = "";

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\\n"); }
function notify(method, params) { send({ jsonrpc: "2.0", method: method, params: params }); }
function respond(id, result) { send({ jsonrpc: "2.0", id: id, result: result }); }
function respondError(id, message, data, code) { send({ jsonrpc: "2.0", id: id, error: { code: code === undefined ? -32000 : code, message: message, ...(data === undefined ? {} : { data: data }) } }); }
function clientPromptId(req) {
  const meta = req.params && req.params._meta;
  return meta && typeof meta.promptId === "string" ? meta.promptId : "prompt-1";
}
function logRequest(req) {
  if (!logFile) return;
  try { fs.appendFileSync(logFile, JSON.stringify({ method: req.method, params: req.params }) + "\\n"); } catch {}
}
function emitToolUpdates(sid) {
  if (!toolName) return;
  const meta = { version: 1, name: toolName, kind: toolName === "read_file" ? "read" : toolName === "run_terminal_cmd" ? "execute" : "edit", namespace: "grok_build", label: toolName, read_only: toolName !== "search_replace" };
  const rawInput = toolName === "run_terminal_cmd" ? { command: "cat " + toolPath } : { path: toolPath };
  meta.input = rawInput;
  notify("session/update", { sessionId: sid, update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: toolName, rawInput: rawInput, _meta: { "x.ai/tool": meta } } });
  notify("session/update", { sessionId: sid, update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", title: toolName, status: "completed", content: toolName === "search_replace" ? [{ type: "diff", path: toolPath, oldText: "a", newText: "b" }] : [], locations: [{ path: toolPath }], rawInput: rawInput, rawOutput: toolName + " done", _meta: { "x.ai/tool": meta } } });
}
function emitPromptNotifications(sid, pid) {
  notify("session/update", { sessionId: sid, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } } });
  emitToolUpdates(sid);
  const half = Math.ceil(replyText.length / 2);
  notify("session/update", { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: replyText.slice(0, half) } } });
  notify("session/update", { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: replyText.slice(half) } } });
  notify("_x.ai/session_notification", { sessionId: sid, update: { sessionUpdate: "turn_completed", prompt_id: pid, stop_reason: "end_turn", usage: { inputTokens: 42, outputTokens: 7, totalTokens: 49, cachedReadTokens: 10, cacheCreationTokens: 0, reasoningTokens: 0, modelCalls: 1, apiDurationMs: 1200, costUsdTicks: 55 } } });
  notify("_x.ai/session_notification", { sessionId: sid, update: { sessionUpdate: "response_completed", usage: { input_tokens: 999, output_tokens: 999 } } });
}
function finishPrompt(req) {
  const sid = req.params.sessionId;
  const pid = clientPromptId(req);
  emitPromptNotifications(sid, pid);
  if (replayMarked) {
    // Replay-marked traffic arriving INSIDE the prompt window (e.g. after the
    // quiet-window cap) must still be dropped via _meta.isReplay.
    notify("session/update", { sessionId: sid, _meta: { isReplay: true }, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAY MARKED TEXT" } } });
    notify("_x.ai/session_notification", { sessionId: sid, _meta: { isReplay: true }, update: { sessionUpdate: "turn_completed", prompt_id: "old-prompt", stop_reason: "end_turn", usage: { inputTokens: 999, outputTokens: 999, totalTokens: 1998, cachedReadTokens: 0 } } });
  }
  respond(req.id, { stopReason: scenario === "cancelled" ? "cancelled" : stopReason, _meta: { sessionId: sid, promptId: pid, totalTokens: 49, inputTokens: 42, outputTokens: 7, cachedReadTokens: 10, modelId: "grok-4" } });
}
function finishPromptLateEvents(req) {
  // Prompt response FIRST; the tool/usage notifications land next tick, and
  // the process only exits on stdin EOF. The settle barrier must not lose
  // them (exit code comes from the shared end handler below).
  const sid = req.params.sessionId;
  const pid = clientPromptId(req);
  respond(req.id, { stopReason: "end_turn", _meta: { sessionId: sid, promptId: pid, totalTokens: 49, modelId: "grok-4" } });
  setImmediate(() => {
    emitToolUpdates(sid);
    notify("_x.ai/session_notification", { sessionId: sid, update: { sessionUpdate: "turn_completed", prompt_id: pid, stop_reason: "end_turn", usage: { inputTokens: 42, outputTokens: 7, totalTokens: 49, cachedReadTokens: 10 } } });
  });
}
function handle(req) {
  logRequest(req);
  if (req.id === undefined || req.id === null) return; // notification (e.g. session/cancel)
  if (req.method === "initialize") {
    respond(req.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, mcpCapabilities: { http: mcpHttp, sse: mcpSse } },
      authMethods: [{ id: "cached_token", name: "Cached token" }, { id: "grok.com", name: "grok.com" }],
      _meta: {
        defaultAuthMethodId: "cached_token",
        agentVersion: "0.2.117",
        modelState: { currentModelId: "grok-4", availableModels: [{ modelId: "grok-4", name: "Grok 4", description: "", _meta: { supportsReasoningEffort: true, reasoningEffort: "medium", reasoningEfforts: ["low", "medium", "high"] } }] },
      },
    });
    return;
  }
  if (req.method === "session/new") {
    if (scenario === "prompt_error_auth") { respondError(req.id, "Error: not logged in. Run grok login to authenticate."); return; }
    respond(req.id, { sessionId: sessionId, models: { currentModelId: "grok-4", availableModels: [{ modelId: "grok-4", name: "Grok 4" }] } });
    return;
  }
  if (req.method === "session/set_model") {
    if (rejectSetModel) { respondError(req.id, "Invalid params", "unknown model id", -32602); return; }
    if (setModelResponse === "missing_key") { respond(req.id, { _meta: {} }); return; }
    if (setModelResponse === "wrong_value") { respond(req.id, { _meta: { model: { Ok: "some-other-model" } } }); return; }
    const requestedEffort = req.params._meta && typeof req.params._meta.reasoningEffort === "string" ? req.params._meta.reasoningEffort : null;
    const echo = (modelId, effort, extra) => {
      notify("_x.ai/session_notification", { sessionId: req.params.sessionId, ...(extra || {}), update: { sessionUpdate: "model_changed", model_id: modelId, ...(effort === null ? {} : { reasoning_effort: effort }) } });
    };
    const correctEcho = () => {
      if (echoMode === "none") return;
      if (echoMode === "omit_effort") { echo(req.params.modelId, null); return; }
      if (echoMode === "wrong_effort") { echo(req.params.modelId, "ultra"); return; }
      echo(req.params.modelId, requestedEffort === null ? "high" : requestedEffort);
    };
    if (echoMode === "missing_session") {
      // Valid shape + effort, but NO sessionId — must never confirm.
      notify("_x.ai/session_notification", { update: { sessionUpdate: "model_changed", model_id: req.params.modelId, reasoning_effort: requestedEffort || "high" } });
      respond(req.id, { _meta: { model: { Ok: req.params.modelId } } });
      return;
    }
    if (echoMode === "foreign_session") {
      notify("_x.ai/session_notification", { sessionId: "other-session", update: { sessionUpdate: "model_changed", model_id: req.params.modelId, reasoning_effort: requestedEffort || "high" } });
      respond(req.id, { _meta: { model: { Ok: req.params.modelId } } });
      return;
    }
    if (echoMode === "wrong_channel") {
      // Identically-shaped payload on the _x.ai/session/update extension
      // channel (accepted by the passthrough, enters routing) — must never
      // confirm. The standard session/update schema would reject it at the
      // SDK parser, which does not count as this implementation's test.
      notify("_x.ai/session/update", { sessionId: req.params.sessionId, update: { sessionUpdate: "model_changed", model_id: req.params.modelId, reasoning_effort: requestedEffort || "high" } });
      respond(req.id, { _meta: { model: { Ok: req.params.modelId } } });
      return;
    }
    if (echoMode === "before") correctEcho();
    respond(req.id, { _meta: { model: { Ok: req.params.modelId } } });
    if (echoMode === "stale_first") {
      echo(req.params.modelId, requestedEffort || "high", { _meta: { isReplay: true } });
      notify("_x.ai/session_notification", { sessionId: "other-session", update: { sessionUpdate: "model_changed", model_id: req.params.modelId, reasoning_effort: requestedEffort || "high" } });
      echo("stale-old-model", requestedEffort || "high");
      correctEcho();
      return;
    }
    if (echoMode !== "before") correctEcho();
    return;
  }
  if (req.method === "session/load") {
    if (scenario === "load_fail") { respondError(req.id, "session not found"); return; }
    respond(req.id, { models: { currentModelId: "grok-4", availableModels: [{ modelId: "grok-4", name: "Grok 4" }] } });
    if (process.env.GROK_FAKE_LEGACY_ECHO === "1") {
      // UNMARKED same-session legacy model_changed from the persisted history —
      // receipt-time fencing must stop it satisfying THIS turn's confirmation.
      notify("_x.ai/session_notification", { sessionId: sessionId, update: { sessionUpdate: "model_changed", model_id: "grok-4", reasoning_effort: process.env.GROK_FAKE_LEGACY_ECHO_EFFORT || "low" } });
    }
    if (process.env.GROK_FAKE_LEGACY_STREAM === "1") {
      // Continuous unmarked same-value legacy traffic: keeps the replay drain
      // from ever going quiet (cap counter-example) and keeps arriving after it.
      const effort = process.env.GROK_FAKE_LEGACY_ECHO_EFFORT || "low";
      const timer = setInterval(() => {
        notify("_x.ai/session_notification", { sessionId: sessionId, update: { sessionUpdate: "model_changed", model_id: "grok-4", reasoning_effort: effort } });
      }, 10);
      setTimeout(() => clearInterval(timer), 600);
    }
    // Historical replay from prior turns — arrives BEFORE the current prompt
    // and must be dropped by the replay fence.
    notify("_x.ai/session_notification", { sessionId: sessionId, update: { sessionUpdate: "turn_completed", prompt_id: "old-prompt", stop_reason: "end_turn", usage: { inputTokens: 999, outputTokens: 999, totalTokens: 1998, cachedReadTokens: 0 } } });
    notify("session/update", { sessionId: sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD REPLAYED TEXT" } } });
    return;
  }
  if (req.method === "session/prompt") {
    if (scenario === "prompt_error_rate_limit") { respondError(req.id, "429 Too Many Requests: the provider is overloaded, retry later"); return; }
    if (scenario === "tool_prompt_error_rate_limit") { emitToolUpdates(req.params.sessionId); respondError(req.id, "429 Too Many Requests: the provider is overloaded, retry later"); return; }
    if (scenario === "text_prompt_error_rate_limit") { emitPromptNotifications(req.params.sessionId); respondError(req.id, "429 Too Many Requests: the provider is overloaded, retry later"); return; }
    if (scenario === "tool_unknown_death") { emitToolUpdates(req.params.sessionId); process.stderr.write("weird unclassified crash\\n"); process.exit(1); }
    if (scenario === "stderr_death") { process.stderr.write("fatal: backend unreachable\\n"); process.exit(1); }
    if (scenario === "unknown_death") { process.stderr.write("weird unclassified crash\\n"); process.exit(1); }
    if (scenario === "hold") {
      const timer = setInterval(() => {
        if (releaseFile && fs.existsSync(releaseFile)) { clearInterval(timer); finishPrompt(req); }
      }, 25);
      return;
    }
    if (scenario === "hold_after_prompt") {
      // Answer the prompt, then never exit (ignores stdin EOF) — the bounded
      // close barrier must reclaim this process.
      finishPrompt(req);
      setInterval(() => {}, 1000);
      return;
    }
    if (scenario === "prompt_id_mismatch") {
      // Respond with a DIFFERENT promptId than the client supplied — the
      // transport must fail closed.
      respond(req.id, { stopReason: "end_turn", _meta: { sessionId: req.params.sessionId, promptId: "not-the-client-prompt-id", modelId: "grok-4" } });
      return;
    }
    if (scenario === "prompt_id_missing") {
      // Respond with NO promptId at all — equally fail closed.
      respond(req.id, { stopReason: "end_turn", _meta: { sessionId: req.params.sessionId, modelId: "grok-4" } });
      return;
    }
    if (scenario === "prompt_error_then_tool") {
      // Retryable prompt error FIRST; the write-tool effect lands next tick
      // and must still be observed before settlement (no truncation).
      respondError(req.id, "429 Too Many Requests: the provider is overloaded, retry later");
      setImmediate(() => emitToolUpdates(req.params.sessionId));
      return;
    }
    if (scenario === "late_events_success" || scenario === "late_events_dirty_exit") {
      finishPromptLateEvents(req);
      return;
    }
    finishPrompt(req);
    return;
  }
  respondError(req.id, "unknown method " + req.method);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf("\\n");
  while (idx >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.trim()) {
      let req = null;
      try { req = JSON.parse(line); } catch {}
      if (req && req.method) handle(req);
    }
    idx = buffer.indexOf("\\n");
  }
});
process.stdin.on("end", () => {
  if (scenario === "hold_after_prompt") return; // deliberately ignores EOF
  process.exit(scenario === "nonzero_exit" || scenario === "late_events_dirty_exit" ? 3 : 0);
});
`;

type SpawnedChild = ReturnType<typeof spawn>;

function createFakeAcpSupervisor(
  specs: ProviderProcessSpec[],
  fakeEnv: Record<string, string> | Record<string, string>[],
  children: SpawnedChild[] = [],
): ProviderProcessSupervisor {
  return {
    spawn(spec) {
      specs.push(spec);
      const env = Array.isArray(fakeEnv) ? (fakeEnv[specs.length - 1] ?? fakeEnv.at(-1) ?? {}) : fakeEnv;
      const child = spawn(process.execPath, ["-e", FAKE_ACP_AGENT_SCRIPT], {
        ...spec.options,
        env: { ...spec.options.env, ...env },
      });
      children.push(child);
      return { child, exited: new Promise<void>((resolve) => child.once("exit", () => resolve())) };
    },
  };
}

type LoggedRequest = { method: string; params: Record<string, unknown> };

function readRequestLog(logFile: string): LoggedRequest[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LoggedRequest);
}

function makeToken(): DeliveryToken & { completed: TurnOutcome[]; retried: string[] } {
  const completed: TurnOutcome[] = [];
  const retried: string[] = [];
  return {
    completed,
    retried,
    processingStarted: () => {},
    complete: async (_messages, outcome) => {
      completed.push(outcome);
    },
    retry: (_messages, reason) => {
      retried.push(reason);
    },
    terminalRejected: async () => {},
  };
}

function makeMessage(id: string, content: string): SessionMessage {
  return { id, chatId: "chat-grok", senderId: "human-1", format: "text", content, metadata: {} };
}

let workspaceRoot: string;

function makeContext(opts: {
  events: SessionEvent[];
  contextTreeRepoUrl?: string;
  getAgentContextTreeConfig?: () => Promise<
    | { bindingState: "bound"; repo: string; branch: string; provider: "github" }
    | { bindingState: "invalid"; repo: null; branch: null; provider: null }
  >;
  logs?: string[];
  forwardResult?: (text: string) => Promise<void>;
  replaceSessionId?: (sessionId: string, reason: string) => void;
}): SessionContext {
  const sendMessage = async () => ({});
  const plumbing = mockCtxPlumbing({ sendMessage }, "chat-grok");
  return {
    agent: {
      agentId: "agent-grok-1",
      inboxId: "inbox_agent-grok-1",
      displayName: "grok-assistant",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    },
    // fetchChatContext failures are logged and tolerated — a throwing fake sdk
    // exercises that path without network.
    sdk: {
      serverUrl: "https://first-tree.test",
      sendMessage,
      getAgentContextTreeConfig:
        opts.getAgentContextTreeConfig ??
        (async () =>
          opts.contextTreeRepoUrl
            ? { bindingState: "bound", repo: opts.contextTreeRepoUrl, branch: "main", provider: "github" as const }
            : { bindingState: "invalid", repo: null, branch: null, provider: null }),
    } as unknown as SessionContext["sdk"],
    chatId: "chat-grok",
    log: (msg) => {
      opts.logs?.push(msg);
    },
    recordProviderActivity: () => {},
    noteTurnStart: () => {},
    emitEvent: (event) => {
      opts.events.push(event);
    },
    ...plumbing,
    ...(opts.forwardResult ? { forwardResult: opts.forwardResult } : {}),
    ...(opts.replaceSessionId ? { replaceSessionId: opts.replaceSessionId } : {}),
  };
}

function grokPayload(over: Record<string, unknown> = {}) {
  return {
    kind: "grok" as const,
    prompt: { append: "" },
    model: "",
    mcpServers: [],
    env: [],
    gitRepos: [],
    resourceSkills: [],
    reasoningEffort: "" as const,
    ...over,
  };
}

function makeHandler(supervisor: ProviderProcessSupervisor, extraConfig: Record<string, unknown> = {}) {
  return createGrokHandler({
    workspaceRoot,
    agentName: "grok-test-agent",
    runtimeProvider: "grok",
    providerProcessSupervisor: supervisor,
    grokBinaryResolver: () => ({ ok: true, binary: "/fake/bin/grok", version: "0.2.117" }),
    grokRetrySleep: async () => {},
    ...extraConfig,
  });
}

function fakeEnvFor(testName: string, over: Record<string, string> = {}): Record<string, string> {
  return { GROK_FAKE_REQUEST_LOG: join(workspaceRoot, `requests-${testName}.jsonl`), ...over };
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "grok-handler-test-"));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("buildGrokTurnArgs — canonical spawn contract", () => {
  it("omits --model/--effort when unconfigured and appends them verbatim when set", () => {
    expect(buildGrokTurnArgs({ model: "", reasoningEffort: "" })).toEqual([
      "--no-auto-update",
      "agent",
      "--no-leader",
      "--always-approve",
      "stdio",
    ]);
    expect(buildGrokTurnArgs({ model: "grok-4-fast", reasoningEffort: "high" })).toEqual([
      "--no-auto-update",
      "agent",
      "--no-leader",
      "--always-approve",
      "--model",
      "grok-4-fast",
      "--effort",
      "high",
      "stdio",
    ]);
  });
});

describe("grok handler — per-turn ACP transport", () => {
  it("start: canonical argv, session/new id capture, single assistant_text, usage, turn_end", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("start");
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv));
    const token = makeToken();
    const forwarded: string[] = [];

    const result = await handler.start(
      makeMessage("m1", "do the thing"),
      makeContext({ events, forwardResult: async (text) => void forwarded.push(text) }),
      token,
    );

    expect(specs).toHaveLength(1);
    const spec = specs[0];
    if (!spec) throw new Error("unreachable");
    expect(spec.command).toBe("/fake/bin/grok");
    expect(spec.args).toEqual(["--no-auto-update", "agent", "--no-leader", "--always-approve", "stdio"]);
    expect(spec.options).toMatchObject({ cwd: workspaceRoot, shell: false });
    // The prompt never rides argv.
    expect(spec.args.join(" ")).not.toContain("do the thing");

    const requests = readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "");
    const methods = requests.map((r) => r.method);
    expect(methods).toEqual(["initialize", "session/new", "session/set_model", "session/prompt"]);
    const init = requests[0];
    expect(init?.params).toMatchObject({ protocolVersion: 1, clientCapabilities: {} });
    const newSession = requests[1];
    expect(newSession?.params).toMatchObject({ cwd: workspaceRoot, _meta: { yoloMode: true } });
    // Empty config re-asserts the INITIALIZE-advertised current model and
    // OMITS `_meta` entirely (a null effort meta is not the same as absent).
    const setModel = requests[2];
    expect(setModel?.params).toEqual({ sessionId: "grok-sess-1", modelId: "grok-4" });
    expect(setModel?.params).not.toHaveProperty("_meta");
    const prompt = requests[3];
    expect(prompt?.params).toMatchObject({ sessionId: "grok-sess-1" });
    // The prompt carries a client-generated correlation promptId.
    const promptMeta = prompt?.params._meta;
    expect(typeof (promptMeta as Record<string, unknown> | undefined)?.promptId).toBe("string");
    const promptBlocks = prompt?.params.prompt;
    expect(Array.isArray(promptBlocks)).toBe(true);
    const promptText = Array.isArray(promptBlocks)
      ? (promptBlocks as Array<{ text?: string }>).map((b) => b.text ?? "").join("")
      : "";
    expect(promptText).toContain("do the thing");
    // Provider-neutral runtime output contract precedes the inbound message.
    expect(promptText.indexOf("do the thing")).toBeGreaterThan(0);

    expect(result).toMatchObject({ sessionId: "grok-sess-1", route: { kind: "owned", mode: "processing" } });
    expect(token.completed).toMatchObject([{ status: "success", terminal: true }]);
    expect(forwarded).toEqual(["Hello world"]);

    // Chunks concatenate into ONE assistant_text (no per-chunk emission).
    const assistantTexts = events.filter((e) => e.kind === "assistant_text");
    expect(assistantTexts).toHaveLength(1);
    expect(assistantTexts[0]?.payload.text).toBe("Hello world");
    expect(events.some((e) => e.kind === "thinking")).toBe(true);
    const usage = events.find((e) => e.kind === "token_usage");
    expect(usage).toMatchObject({
      kind: "token_usage",
      payload: { provider: "grok", model: "grok-4", inputTokens: 42, cachedInputTokens: 10, outputTokens: 7 },
    });
    // response_completed (per-model-call) must not double the usage events.
    expect(events.filter((e) => e.kind === "token_usage")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: "turn_end", payload: { status: "success" } });
  });

  it("resume with a confirmed id runs session/load and the replay fence drops historical updates", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("resume");
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv));

    await handler.resume(makeMessage("m2", "continue"), "grok-sess-1", makeContext({ events }), makeToken());

    const requests = readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "");
    const methods = requests.map((r) => r.method);
    expect(methods).toEqual(["initialize", "session/load", "session/set_model", "session/prompt"]);
    expect(methods).not.toContain("session/new");
    const load = requests[1];
    expect(load?.params).toMatchObject({
      sessionId: "grok-sess-1",
      cwd: workspaceRoot,
      _meta: { yoloMode: true, noReplay: true },
    });

    // The replayed OLD chunk and OLD turn_completed (999 tokens) never land.
    const assistantTexts = events.filter((e) => e.kind === "assistant_text");
    expect(assistantTexts).toHaveLength(1);
    expect(assistantTexts[0]?.payload.text).toBe("Hello world");
    expect(JSON.stringify(events)).not.toContain("OLD REPLAYED TEXT");
    const usage = events.find((e) => e.kind === "token_usage");
    expect(usage).toMatchObject({ kind: "token_usage", payload: { inputTokens: 42 } });
  });

  it("session/load failure never falls back to session/new and settles through bounded retry", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("loadfail", { GROK_FAKE_SCENARIO: "load_fail" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv));
    const token = makeToken();

    await handler.resume(makeMessage("m2", "continue"), "grok-sess-1", makeContext({ events }), token);

    // 1 initial + 2 retries, every attempt is session/load — never session/new.
    expect(specs).toHaveLength(3);
    const requests = readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "");
    expect(requests.map((r) => r.method)).not.toContain("session/new");
    expect(requests.filter((r) => r.method === "session/load")).toHaveLength(3);

    // The load failure settles consumed-terminal through ProviderAttempt after
    // the bounded retries exhaust (initialize completed, so the replay ladder
    // is past pre_provider and the delivery is NOT redelivered).
    expect(token.retried).toEqual([]);
    expect(token.completed).toMatchObject([
      { status: "error", completion: "consumed", reason: "provider_retry_exhausted" },
    ]);
    const providerEvents = events
      .filter((e) => e.kind === "error")
      .map((e) => parseProviderRetryEventMessage(e.payload.message))
      .filter((e) => e !== null);
    expect(providerEvents.map((e) => e.event)).toEqual([
      "provider_retry_scheduled",
      "provider_retry_scheduled",
      "provider_retry_exhausted",
    ]);
  });

  it("does not spawn a retry after the authoritative Context source changes during backoff", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("source-flip", { GROK_FAKE_SCENARIO: "load_fail" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv));
    const token = makeToken();
    const failSessionForRecovery = vi.fn();
    const ctx = makeContext({
      events,
      getAgentContextTreeConfig: async () => {
        return specs.length === 0
          ? { bindingState: "invalid", repo: null, branch: null, provider: null }
          : {
              bindingState: "bound",
              repo: "https://github.com/acme/new-tree.git",
              branch: "main",
              provider: "github",
            };
      },
    });
    ctx.failSessionForRecovery = failSessionForRecovery;

    await handler.resume(makeMessage("m-source-flip", "continue"), "grok-sess-1", ctx, token);

    expect(specs).toHaveLength(1);
    expect(token.retried).toContain("grok_context_source_changed");
    expect(failSessionForRecovery).toHaveBeenCalledWith("grok_context_source_changed", "grok-sess-1");
  });

  it("retries the first active injected turn without spawning after its captured remote source flips", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("active-source-flip");
    const failSessionForRecovery = vi.fn();
    const repoA = "https://github.com/acme/tree-a.git";
    const repoB = "https://github.com/acme/tree-b.git";
    let authoritativeRepo = repoA;
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv), {
      contextSourceKind: "remote",
      contextTreePath: join(workspaceRoot, "context-tree"),
      contextTreeRepoUrl: repoA,
      contextTreeBranch: "main",
    });
    const ctx = makeContext({
      events,
      getAgentContextTreeConfig: async () => ({
        bindingState: "bound",
        repo: authoritativeRepo,
        branch: "main",
        provider: "github",
      }),
    });
    ctx.failSessionForRecovery = failSessionForRecovery;

    await handler.start(makeMessage("m-source-a", "start"), ctx, makeToken());
    expect(specs).toHaveLength(1);

    authoritativeRepo = repoB;
    const injectedToken = makeToken();
    expect(handler.inject(makeMessage("m-source-b", "continue"), injectedToken)).toMatchObject({
      kind: "owned",
      mode: "queued",
    });
    await vi.waitFor(() => {
      expect(injectedToken.retried).toContain("grok_context_source_changed");
    });

    expect(specs).toHaveLength(1);
    expect(injectedToken.completed).toEqual([]);
    expect(failSessionForRecovery).toHaveBeenCalledWith("grok_context_source_changed", "grok-sess-1");
  });

  it("first-turn auth failure settles consumed-terminal, returns a synthetic id, and upgrades on the next turn", async () => {
    const events: SessionEvent[] = [];
    const replaceCalls: Array<{ id: string; reason: string }> = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("auth");
    // First spawn fails session/new with an auth error (no provider id ever
    // exists); the second spawn (the recovery turn) succeeds.
    const handler = makeHandler(
      createFakeAcpSupervisor(specs, [
        { ...fakeEnv, GROK_FAKE_SCENARIO: "prompt_error_auth" },
        { ...fakeEnv, GROK_FAKE_SCENARIO: "success" },
      ]),
    );
    const token = makeToken();
    const ctx = makeContext({ events, replaceSessionId: (id, reason) => void replaceCalls.push({ id, reason }) });

    const started = await handler.start(makeMessage("m1", "hi"), ctx, token);
    if (typeof started === "string") throw new Error("expected a start receipt");
    expect(token.completed).toMatchObject([{ status: "error", completion: "consumed" }]);
    expect(started.sessionId.startsWith(GROK_PENDING_SESSION_PREFIX)).toBe(true);
    const providerEvents = events
      .filter((e) => e.kind === "error")
      .map((e) => parseProviderRetryEventMessage(e.payload.message))
      .filter((e) => e !== null);
    expect(providerEvents[0]).toMatchObject({ event: "provider_failure_terminal", category: "credential" });
    // The user-facing error is reframed with the grok login hint.
    expect(
      events.some((e) => e.kind === "error" && e.payload.source === "sdk" && /grok login/.test(e.payload.message)),
    ).toBe(true);

    // Resuming with the synthetic id must NOT session/load it; the fresh
    // session/new id upgrades the mapping via replaceSessionId.
    const token2 = makeToken();
    await handler.resume(makeMessage("m2", "again"), started.sessionId, ctx, token2);
    const requests = readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "");
    const loadParams = requests.filter((r) => r.method === "session/load").map((r) => r.params.sessionId);
    expect(loadParams).not.toContain(started.sessionId);
    expect(replaceCalls).toMatchObject([{ id: "grok-sess-1", reason: "grok_session_id_confirmed" }]);
    expect(token2.completed).toMatchObject([{ status: "success" }]);
  });

  it("429-style prompt failure classifies capacity, retries with visible bounds, then exhausts", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("ratelimit", { GROK_FAKE_SCENARIO: "prompt_error_rate_limit" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv));
    const token = makeToken();

    await handler.start(makeMessage("m1", "hi"), makeContext({ events }), token);

    expect(specs).toHaveLength(3);
    const providerEvents = events
      .filter((e) => e.kind === "error")
      .map((e) => parseProviderRetryEventMessage(e.payload.message))
      .filter((e) => e !== null);
    expect(providerEvents.map((e) => e.event)).toEqual([
      "provider_retry_scheduled",
      "provider_retry_scheduled",
      "provider_retry_exhausted",
    ]);
    expect(providerEvents.every((e) => e.category === "provider_capacity")).toBe(true);
    expect(token.completed).toMatchObject([
      { status: "error", completion: "consumed", reason: "provider_retry_exhausted" },
    ]);
  });

  it("non-zero exit without a completed prompt classifies from the stderr tail", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("stderrdeath", { GROK_FAKE_SCENARIO: "stderr_death" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv));
    const token = makeToken();

    await handler.start(makeMessage("m1", "hi"), makeContext({ events }), token);

    expect(specs.length).toBeGreaterThan(0);
    const sdkError = events.find((e) => e.kind === "error" && e.payload.source === "sdk");
    if (sdkError?.kind !== "error") throw new Error("expected an sdk error event");
    expect(sdkError.payload.message).toContain("backend unreachable");
    expect(token.completed.length + token.retried.length).toBeGreaterThan(0);
  });

  it.each([
    "end_turn",
    "max_tokens",
    "max_turn_requests",
    "refusal",
  ])("stopReason %s with a clean exit settles the turn with the accumulated output", async (stopReason) => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor(`stop-${stopReason}`, { GROK_FAKE_STOP_REASON: stopReason });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv));
    const token = makeToken();
    const forwarded: string[] = [];

    await handler.start(
      makeMessage("m1", "hi"),
      makeContext({ events, forwardResult: async (text) => void forwarded.push(text) }),
      token,
    );

    expect(specs).toHaveLength(1);
    expect(token.completed).toMatchObject([{ status: "success", terminal: true }]);
    expect(forwarded).toEqual(["Hello world"]);
    const assistantTexts = events.filter((e) => e.kind === "assistant_text");
    expect(assistantTexts).toHaveLength(1);
    expect(assistantTexts[0]?.payload.text).toBe("Hello world");
    expect(events.some((e) => e.kind === "token_usage")).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "turn_end", payload: { status: "success" } });
  });

  it("non-zero exit AFTER a completed prompt is a failure input, never a silent success", async () => {
    const events: SessionEvent[] = [];
    const logs: string[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("nonzero", { GROK_FAKE_SCENARIO: "nonzero_exit" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv));
    const token = makeToken();

    await handler.start(makeMessage("m1", "hi"), makeContext({ events, logs }), token);

    // The full drain must exit 0: exit 3 after end_turn routes through
    // ProviderAttempt — assistant text was already visible, so an unknown
    // failure is an unsafe replay and settles consumed-terminal (no ACK of
    // a success, no auto-retry of a dirty turn).
    expect(token.completed).toMatchObject([{ status: "error", completion: "consumed", reason: "unsafe_replay" }]);
    expect(events.at(-1)).toMatchObject({ kind: "turn_end", payload: { status: "error" } });
    const providerEvents = events
      .filter((e) => e.kind === "error")
      .map((e) => parseProviderRetryEventMessage(e.payload.message))
      .filter((e) => e !== null);
    expect(providerEvents[0]).toMatchObject({ event: "provider_failure_terminal", reasonCode: "unsafe_replay" });
    expect(logs.some((line) => line.includes("completed turn stands"))).toBe(false);
    // Billed usage from the completed prompt is still accounted.
    expect(events.some((e) => e.kind === "token_usage")).toBe(true);
  });

  it("a process that answers the prompt but never exits is reclaimed and settled as a failure", async () => {
    const events: SessionEvent[] = [];
    const logs: string[] = [];
    const specs: ProviderProcessSpec[] = [];
    const children: SpawnedChild[] = [];
    const fakeEnv = fakeEnvFor("eofignore", { GROK_FAKE_SCENARIO: "hold_after_prompt" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv, children), { grokEofCloseWaitMs: 200 });
    const token = makeToken();

    await handler.start(makeMessage("m1", "hi"), makeContext({ events, logs }), token);

    expect(logs.some((line) => line.includes("did not exit after stdin EOF"))).toBe(true);
    const child = children[0];
    if (!child) throw new Error("unreachable");
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    expect(child.signalCode).toBe("SIGTERM");
    expect(token.completed).toMatchObject([{ status: "error", completion: "consumed" }]);
    expect(events.at(-1)).toMatchObject({ kind: "turn_end", payload: { status: "error" } });
  });

  it("attempt 1 write tool + retryable capacity failure: the side effect is remembered and nothing auto-replays", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("unsafe-attempt1");
    // Attempt 1: write tool starts (replay-unsafe) then a known retryable
    // capacity failure. The retry policy's unsafe guard
    // (provider-retry-policy decideProviderRetry) stops BEFORE granting a
    // retry — a side-effecting attempt is never replayed, so no second
    // attempt ever runs. The scripted second spawn must stay unused.
    const handler = makeHandler(
      createFakeAcpSupervisor(specs, [
        { ...fakeEnv, GROK_FAKE_SCENARIO: "tool_prompt_error_rate_limit", GROK_FAKE_TOOL: "search_replace" },
        { ...fakeEnv, GROK_FAKE_SCENARIO: "unknown_death" },
      ]),
    );
    const token = makeToken();

    await handler.start(makeMessage("m1", "hi"), makeContext({ events }), token);

    expect(specs).toHaveLength(1);
    const providerEvents = events
      .filter((e) => e.kind === "error")
      .map((e) => parseProviderRetryEventMessage(e.payload.message))
      .filter((e) => e !== null);
    expect(providerEvents.map((e) => e.event)).toEqual(["provider_failure_terminal"]);
    expect(providerEvents[0]).toMatchObject({ reasonCode: "unsafe_replay", replaySafety: "unsafe" });
    expect(token.retried).toEqual([]);
    expect(token.completed).toMatchObject([{ status: "error", completion: "consumed", reason: "unsafe_replay" }]);
  });

  it("a write tool in a retried attempt forbids a further auto-replay of its unknown failure", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("unsafeacross");
    // Attempt 1: assistant text (user-visible) + retryable capacity failure →
    // the policy grants one retry. Attempt 2: runs the write tool
    // (search_replace) then dies with an unknown error — the unsafe state
    // (seeded per attempt and carried across attempts via anyToolEffect)
    // must forbid any further auto-replay.
    const handler = makeHandler(
      createFakeAcpSupervisor(specs, [
        { ...fakeEnv, GROK_FAKE_SCENARIO: "text_prompt_error_rate_limit" },
        { ...fakeEnv, GROK_FAKE_SCENARIO: "tool_unknown_death", GROK_FAKE_TOOL: "search_replace" },
      ]),
    );
    const token = makeToken();

    await handler.start(makeMessage("m1", "hi"), makeContext({ events }), token);

    // Exactly 2 attempts: attempt 2's unknown failure must NOT auto-replay.
    expect(specs).toHaveLength(2);
    const providerEvents = events
      .filter((e) => e.kind === "error")
      .map((e) => parseProviderRetryEventMessage(e.payload.message))
      .filter((e) => e !== null);
    expect(providerEvents.map((e) => e.event)).toEqual(["provider_retry_scheduled", "provider_failure_terminal"]);
    expect(providerEvents[1]).toMatchObject({ reasonCode: "unsafe_replay", replaySafety: "unsafe" });
    expect(token.completed).toMatchObject([{ status: "error", completion: "consumed", reason: "unsafe_replay" }]);
  });

  it("applies the configured model+effort via session/set_model after session/new, before prompt", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("setmodel-new");
    const payload = grokPayload({ model: "grok-4-fast", reasoningEffort: "high" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv), {
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
    });

    await handler.start(makeMessage("m1", "hi"), makeContext({ events }), makeToken());

    const requests = readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "");
    expect(requests.map((r) => r.method)).toEqual(["initialize", "session/new", "session/set_model", "session/prompt"]);
    const setModel = requests[2];
    expect(setModel?.params).toEqual({
      sessionId: "grok-sess-1",
      modelId: "grok-4-fast",
      _meta: { reasoningEffort: "high" },
    });
  });

  it("applies a changed model+effort via session/set_model after session/load on an existing session", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("setmodel-load");
    const payload = grokPayload({ model: "grok-4-fast", reasoningEffort: "low" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv), {
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
    });

    await handler.resume(makeMessage("m2", "continue"), "grok-sess-1", makeContext({ events }), makeToken());

    const requests = readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "");
    expect(requests.map((r) => r.method)).toEqual([
      "initialize",
      "session/load",
      "session/set_model",
      "session/prompt",
    ]);
    expect(requests[1]?.params).toMatchObject({ _meta: { yoloMode: true, noReplay: true } });
    expect(requests[2]?.params).toEqual({
      sessionId: "grok-sess-1",
      modelId: "grok-4-fast",
      _meta: { reasoningEffort: "low" },
    });
  });

  it("effort-only config sends session/set_model with the session's reported current model", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("setmodel-effortonly");
    const payload = grokPayload({ model: "", reasoningEffort: "low" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv), {
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
    });

    await handler.start(makeMessage("m1", "hi"), makeContext({ events }), makeToken());

    const requests = readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "");
    const setModel = requests.find((r) => r.method === "session/set_model");
    expect(setModel?.params).toEqual({
      sessionId: "grok-sess-1",
      modelId: "grok-4",
      _meta: { reasoningEffort: "low" },
    });
  });

  it("a session/set_model rejection classifies configuration, preserves the error data, and never reaches the prompt", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("setmodel-reject", { GROK_FAKE_REJECT_SET_MODEL: "1" });
    const payload = grokPayload({ model: "not-a-real-model" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv), {
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
    });
    const token = makeToken();

    await handler.start(makeMessage("m1", "hi"), makeContext({ events }), token);

    const requests = readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "");
    expect(requests.map((r) => r.method)).not.toContain("session/prompt");
    const providerEvents = events
      .filter((e) => e.kind === "error")
      .map((e) => parseProviderRetryEventMessage(e.payload.message))
      .filter((e) => e !== null);
    expect(providerEvents[0]).toMatchObject({
      event: "provider_failure_terminal",
      category: "configuration",
      reasonCode: "provider_configuration_error",
    });
    // The ACP RequestError's `data` ("unknown model id" under -32602 Invalid
    // params) is preserved on the user-facing classification surface.
    const sdkError = events.find((e) => e.kind === "error" && e.payload.source === "sdk");
    if (sdkError?.kind !== "error") throw new Error("expected an sdk error event");
    expect(sdkError.payload.message).toContain("unknown model id");
    // No silent fallback: exactly one attempt, no retry, no success ACK.
    expect(specs).toHaveLength(1);
    expect(token.retried).toEqual([]);
    expect(token.completed).toMatchObject([
      { status: "error", completion: "consumed", reason: "provider_configuration_error" },
    ]);
  });

  it("empty config on an existing session still sends set_model with the initialize default and no effort meta", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("setmodel-empty-override");
    // Existing session previously ran model A / effort high; the operator
    // cleared both (""/""). The resumed turn must re-assert the provider
    // default via set_model — the persisted selection is never silently kept.
    const payload = grokPayload({ model: "", reasoningEffort: "" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv), {
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
    });

    await handler.resume(makeMessage("m2", "continue"), "grok-sess-1", makeContext({ events }), makeToken());

    const requests = readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "");
    expect(requests.map((r) => r.method)).toEqual([
      "initialize",
      "session/load",
      "session/set_model",
      "session/prompt",
    ]);
    expect(requests[2]?.params).toEqual({ sessionId: "grok-sess-1", modelId: "grok-4" });
    expect(requests[2]?.params).not.toHaveProperty("_meta");
  });

  it("a legacy unmarked model_changed from session/load never satisfies this turn's confirmation (timeout → terminal configuration)", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("legacy-echo-only", {
      GROK_FAKE_LEGACY_ECHO: "1",
      GROK_FAKE_LEGACY_ECHO_EFFORT: "low",
      GROK_FAKE_ECHO_MODE: "none",
    });
    const payload = grokPayload({ reasoningEffort: "low" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv), {
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
      grokSetModelEchoWaitMs: 100,
    });
    const token = makeToken();

    await handler.resume(makeMessage("m2", "continue"), "grok-sess-1", makeContext({ events }), token);

    const requests = readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "");
    expect(requests.map((r) => r.method)).not.toContain("session/prompt");
    expect(specs).toHaveLength(1);
    expect(token.completed).toMatchObject([
      { status: "error", completion: "consumed", reason: "provider_configuration_error" },
    ]);
    // Timeout diagnostics must NOT claim the pre-arm legacy echo was
    // observed: only post-arm candidates are reported.
    const sdkError = events.find((e) => e.kind === "error" && e.payload.source === "sdk");
    if (sdkError?.kind !== "error") throw new Error("expected an sdk error event");
    expect(sdkError.payload.message).toContain("no current model_changed echo received");
  });

  it("a legacy echo followed by this turn's correct echo confirms and runs the prompt", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("legacy-echo-then-correct", {
      GROK_FAKE_LEGACY_ECHO: "1",
      GROK_FAKE_LEGACY_ECHO_EFFORT: "low",
    });
    const payload = grokPayload({ reasoningEffort: "low" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv), {
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
    });
    const token = makeToken();

    await handler.resume(makeMessage("m2", "continue"), "grok-sess-1", makeContext({ events }), token);

    expect(token.completed).toMatchObject([{ status: "success" }]);
    const requests = readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "");
    expect(requests.map((r) => r.method)).toEqual([
      "initialize",
      "session/load",
      "session/set_model",
      "session/prompt",
    ]);
  });

  it.each([
    { label: "missing sessionId", echoMode: "missing_session" },
    { label: "foreign sessionId", echoMode: "foreign_session" },
    { label: "wrong channel (_x.ai/session/update)", echoMode: "wrong_channel" },
  ])("a $label echo alone never confirms — terminal configuration, no prompt", async ({ echoMode }) => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor(`echo-invalid-${echoMode}`, { GROK_FAKE_ECHO_MODE: echoMode });
    const payload = grokPayload({ reasoningEffort: "low" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv), {
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
      grokSetModelEchoWaitMs: 100,
    });
    const token = makeToken();

    await handler.start(makeMessage("m1", "hi"), makeContext({ events }), token);

    const requests = readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "");
    expect(requests.map((r) => r.method)).not.toContain("session/prompt");
    expect(specs).toHaveLength(1);
    expect(token.completed).toMatchObject([
      { status: "error", completion: "consumed", reason: "provider_configuration_error" },
    ]);
  });

  it("a replay drain that hits its cap fails closed for an explicit effort — no set_model, no prompt", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("drain-cap", {
      GROK_FAKE_LEGACY_STREAM: "1",
      GROK_FAKE_LEGACY_ECHO_EFFORT: "low",
    });
    const payload = grokPayload({ reasoningEffort: "low" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv), {
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
      grokReplayDrainCapMs: 150,
    });
    const token = makeToken();

    await handler.resume(makeMessage("m2", "continue"), "grok-sess-1", makeContext({ events }), token);

    // The unquiet drain is a provider/configuration mismatch terminal —
    // never armed, never sent.
    const requests = readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "");
    expect(requests.map((r) => r.method)).not.toContain("session/set_model");
    expect(requests.map((r) => r.method)).not.toContain("session/prompt");
    expect(specs).toHaveLength(1);
    expect(token.retried).toEqual([]);
    expect(token.completed).toMatchObject([
      { status: "error", completion: "consumed", reason: "provider_configuration_error" },
    ]);
  });

  it("abort during the effort-echo wait returns well before the wait bound with no config settlement", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("abort-echo-wait", { GROK_FAKE_ECHO_MODE: "none" });
    const payload = grokPayload({ reasoningEffort: "low" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv), {
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
      grokSetModelEchoWaitMs: 5_000,
    });
    const token = makeToken();
    const ctx = makeContext({ events });

    const startedAt = Date.now();
    const startPromise = handler.start(makeMessage("m1", "hi"), ctx, token);
    // Wait for the set_model response to have succeeded (the echo wait is
    // now blocking), then abort mid-wait.
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "").some((r) => r.method === "session/set_model")) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
      setTimeout(() => reject(new Error("set_model never sent")), 5_000);
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    await handler.suspend();
    await startPromise;

    // Settled long before the 5s echo-wait bound.
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    // No configuration terminal, no completion, no retry — an aborted turn.
    expect(token.completed).toEqual([]);
    expect(token.retried).toEqual([]);
    expect(
      events.some(
        (e) =>
          e.kind === "error" &&
          (parseProviderRetryEventMessage(e.payload.message)?.category === "configuration" ||
            e.payload.message.includes("was not confirmed")),
      ),
    ).toBe(false);
  });

  it("effort echo arriving BEFORE the set_model JSON-RPC response still satisfies the confirmation", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("echo-before", { GROK_FAKE_ECHO_MODE: "before" });
    const payload = grokPayload({ reasoningEffort: "high" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv), {
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
    });
    const token = makeToken();

    await handler.start(makeMessage("m1", "hi"), makeContext({ events }), token);

    const requests = readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "");
    expect(requests.map((r) => r.method)).toEqual(["initialize", "session/new", "session/set_model", "session/prompt"]);
    expect(token.completed).toMatchObject([{ status: "success" }]);
  });

  it("empty effort accepts the provider default (echo carries the default effort) without failure", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("echo-default-effort");
    const payload = grokPayload({ model: "", reasoningEffort: "" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv), {
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
    });
    const token = makeToken();

    await handler.start(makeMessage("m1", "hi"), makeContext({ events }), token);

    expect(token.completed).toMatchObject([{ status: "success" }]);
    const requests = readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "");
    expect(requests.map((r) => r.method)).toContain("session/prompt");
  });

  it("stale/foreign/replay-marked echos do not satisfy the confirmation — only the correct echo does", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("echo-stale-first", { GROK_FAKE_ECHO_MODE: "stale_first" });
    const payload = grokPayload({ reasoningEffort: "low" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv), {
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
    });
    const token = makeToken();

    await handler.resume(makeMessage("m2", "continue"), "grok-sess-1", makeContext({ events }), token);

    expect(token.completed).toMatchObject([{ status: "success" }]);
    const requests = readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "");
    expect(requests.map((r) => r.method)).toEqual([
      "initialize",
      "session/load",
      "session/set_model",
      "session/prompt",
    ]);
  });

  it.each([
    {
      label: "omits reasoning_effort",
      echoMode: "omit_effort",
      expectedDetail: "effort (none)",
    },
    {
      label: "carries the wrong effort value",
      echoMode: "wrong_effort",
      expectedDetail: "ultra",
    },
    {
      label: "never arrives (bounded timeout)",
      echoMode: "none",
      expectedDetail: "no current model_changed echo received",
    },
  ])("a set_model echo that $label — terminal notice trigger before turn_end/token.complete; no prompt, no retry, no success", async ({
    echoMode,
    expectedDetail,
  }) => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor(`echo-fail-${echoMode}`, { GROK_FAKE_ECHO_MODE: echoMode });
    const payload = grokPayload({ reasoningEffort: "low" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv), {
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
      grokSetModelEchoWaitMs: 100,
    });
    const token = makeToken();

    await handler.start(makeMessage("m1", "hi"), makeContext({ events }), token);

    const requests = readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "");
    expect(requests.map((r) => r.method)).not.toContain("session/prompt");
    expect(specs).toHaveLength(1);
    expect(token.retried).toEqual([]);
    expect(token.completed).toMatchObject([
      { status: "error", completion: "consumed", reason: "provider_configuration_error" },
    ]);
    const providerEvents = events
      .filter((e) => e.kind === "error")
      .map((e) => parseProviderRetryEventMessage(e.payload.message))
      .filter((e) => e !== null);
    expect(providerEvents[0]).toMatchObject({ event: "provider_failure_terminal", category: "configuration" });
    // Notice-TRIGGER ordering at the handler boundary: the provider.retry
    // notice-trigger SessionEvent (a live trace / notice trigger, NOT the
    // durable chat notice) is emitted strictly BEFORE the turn_end that
    // gates token.complete. The durable chat notice write itself lives in
    // SessionRuntime/token.complete and is covered by the generic
    // SessionRuntime failure-post tests — this test makes no claim about it.
    const noticeIndex = events.findIndex(
      (e) => e.kind === "error" && parseProviderRetryEventMessage(e.payload.message) !== null,
    );
    const turnEndIndex = events.findIndex((e) => e.kind === "turn_end");
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    expect(turnEndIndex).toBeGreaterThan(noticeIndex);
    const sdkError = events.find((e) => e.kind === "error" && e.payload.source === "sdk");
    if (sdkError?.kind !== "error") throw new Error("expected an sdk error event");
    expect(sdkError.payload.message).toContain('"low"');
    expect(sdkError.payload.message).toContain(expectedDetail);
    expect(sdkError.payload.message).not.toContain("ignored the effort override");
    // The config confirmation must never surface as a user-facing session event.
    expect(events.some((e) => e.kind === "tool_call")).toBe(false);
  });

  it("a prompt response with a mismatched promptId fails closed", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("promptid-mismatch", { GROK_FAKE_SCENARIO: "prompt_id_mismatch" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv));
    const token = makeToken();

    await handler.start(makeMessage("m1", "hi"), makeContext({ events }), token);

    expect(token.completed).not.toMatchObject([{ status: "success" }]);
    const sdkError = events.find((e) => e.kind === "error" && e.payload.source === "sdk");
    if (sdkError?.kind !== "error") throw new Error("expected an sdk error event");
    expect(sdkError.payload.message).toContain("promptId");
  });

  it("settle barrier: notifications arriving AFTER the prompt response are not lost (clean exit)", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("late-success", {
      GROK_FAKE_SCENARIO: "late_events_success",
      GROK_FAKE_TOOL: "read_file",
    });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv));
    const token = makeToken();

    await handler.start(makeMessage("m1", "hi"), makeContext({ events }), token);

    expect(token.completed).toMatchObject([{ status: "success" }]);
    // The late tool + usage notifications landed before settlement was read.
    expect(events.some((e) => e.kind === "tool_call" && e.payload.status === "ok")).toBe(true);
    expect(events.some((e) => e.kind === "token_usage")).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: "turn_end", payload: { status: "success" } });
  });

  it("settle barrier: late write-tool notifications turn a dirty exit into an unsafe settlement (no retry)", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("late-dirty", {
      GROK_FAKE_SCENARIO: "late_events_dirty_exit",
      GROK_FAKE_TOOL: "search_replace",
    });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv));
    const token = makeToken();

    await handler.start(makeMessage("m1", "hi"), makeContext({ events }), token);

    // The write tool's side effect was seen before settlement — the dirty
    // exit after a completed prompt settles consumed-terminal unsafe_replay,
    // never a retry and never a silent success.
    expect(token.retried).toEqual([]);
    expect(token.completed).toMatchObject([{ status: "error", completion: "consumed", reason: "unsafe_replay" }]);
    expect(events.some((e) => e.kind === "tool_call" && e.payload.name === "search_replace")).toBe(true);
    const providerEvents = events
      .filter((e) => e.kind === "error")
      .map((e) => parseProviderRetryEventMessage(e.payload.message))
      .filter((e) => e !== null);
    expect(providerEvents[0]).toMatchObject({ reasonCode: "unsafe_replay", replaySafety: "unsafe" });
  });

  it.each([
    { label: "missing _meta.model key", setModelResponse: "missing_key" },
    { label: "wrong _meta.model.Ok value", setModelResponse: "wrong_value" },
  ])("a set_model response with $label fails closed as configuration and never prompts", async ({
    setModelResponse,
  }) => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor(`setmodel-shape-${setModelResponse}`, {
      GROK_FAKE_SET_MODEL_RESPONSE: setModelResponse,
    });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv));
    const token = makeToken();

    await handler.start(makeMessage("m1", "hi"), makeContext({ events }), token);

    const requests = readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "");
    expect(requests.map((r) => r.method)).not.toContain("session/prompt");
    const providerEvents = events
      .filter((e) => e.kind === "error")
      .map((e) => parseProviderRetryEventMessage(e.payload.message))
      .filter((e) => e !== null);
    expect(providerEvents[0]).toMatchObject({
      event: "provider_failure_terminal",
      category: "configuration",
    });
    expect(token.completed).toMatchObject([
      { status: "error", completion: "consumed", reason: "provider_configuration_error" },
    ]);
  });

  it("a prompt response with NO promptId fails closed", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("promptid-missing", { GROK_FAKE_SCENARIO: "prompt_id_missing" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv));
    const token = makeToken();

    await handler.start(makeMessage("m1", "hi"), makeContext({ events }), token);

    expect(token.completed).not.toMatchObject([{ status: "success" }]);
    const sdkError = events.find((e) => e.kind === "error" && e.payload.source === "sdk");
    if (sdkError?.kind !== "error") throw new Error("expected an sdk error event");
    expect(sdkError.payload.message).toContain("promptId");
  });

  it("a write-tool effect arriving the tick AFTER a retryable prompt error is observed and settles unsafe (no retry)", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("error-then-tool", {
      GROK_FAKE_SCENARIO: "prompt_error_then_tool",
      GROK_FAKE_TOOL: "search_replace",
    });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv));
    const token = makeToken();

    await handler.start(makeMessage("m1", "hi"), makeContext({ events }), token);

    // The failure path must not truncate the late notification: the side
    // effect is seen, so the retryable capacity error still settles unsafe
    // with NO retry and no silent success.
    expect(specs).toHaveLength(1);
    expect(token.retried).toEqual([]);
    expect(token.completed).toMatchObject([{ status: "error", completion: "consumed", reason: "unsafe_replay" }]);
    expect(events.some((e) => e.kind === "tool_call" && e.payload.name === "search_replace")).toBe(true);
    const providerEvents = events
      .filter((e) => e.kind === "error")
      .map((e) => parseProviderRetryEventMessage(e.payload.message))
      .filter((e) => e !== null);
    expect(providerEvents.map((e) => e.event)).toEqual(["provider_failure_terminal"]);
    expect(providerEvents[0]).toMatchObject({ reasonCode: "unsafe_replay", replaySafety: "unsafe" });
  });

  it("replay-marked notifications inside the prompt window are always dropped", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("replay-marked", { GROK_FAKE_REPLAY_MARKED: "1" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv));

    await handler.resume(makeMessage("m2", "continue"), "grok-sess-1", makeContext({ events }), makeToken());

    const assistantTexts = events.filter((e) => e.kind === "assistant_text");
    expect(assistantTexts).toHaveLength(1);
    expect(assistantTexts[0]?.payload.text).toBe("Hello world");
    expect(JSON.stringify(events)).not.toContain("REPLAY MARKED TEXT");
    const usage = events.find((e) => e.kind === "token_usage");
    expect(usage).toMatchObject({ kind: "token_usage", payload: { inputTokens: 42 } });
  });

  it("a cancelled stopReason routes through ProviderAttempt/replay-safety like any abnormal end", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("cancelled", { GROK_FAKE_SCENARIO: "cancelled" });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv));
    const token = makeToken();

    await handler.start(makeMessage("m1", "hi"), makeContext({ events }), token);

    // Assistant text was already user-visible, so the unknown classification
    // of a provider-side cancel stops as unsafe_replay — consumed terminal,
    // never an unconditional success/redelivery.
    expect(token.retried).toEqual([]);
    expect(token.completed).toMatchObject([{ status: "error", completion: "consumed", reason: "unsafe_replay" }]);
    expect(events.at(-1)).toMatchObject({ kind: "turn_end", payload: { status: "error" } });
  });

  it("a cancelled stopReason after a write tool settles consumed terminal (unsafe)", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("cancelled-tool", {
      GROK_FAKE_SCENARIO: "cancelled",
      GROK_FAKE_TOOL: "search_replace",
    });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv));
    const token = makeToken();

    await handler.start(makeMessage("m1", "hi"), makeContext({ events }), token);

    expect(token.retried).toEqual([]);
    expect(token.completed).toMatchObject([{ status: "error", completion: "consumed", reason: "unsafe_replay" }]);
    const providerEvents = events
      .filter((e) => e.kind === "error")
      .map((e) => parseProviderRetryEventMessage(e.payload.message))
      .filter((e) => e !== null);
    expect(providerEvents[0]).toMatchObject({ event: "provider_failure_terminal", reasonCode: "unsafe_replay" });
  });

  it("passes the operator model + effort verbatim and delivers mapped MCP servers in session/new", async () => {
    const events: SessionEvent[] = [];
    const logs: string[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("mcp", { GROK_FAKE_MCP_SSE: "0" });
    const payload = grokPayload({
      model: "grok-4-fast",
      reasoningEffort: "high",
      mcpServers: [
        { name: "docs", transport: "stdio", command: "docs-server", args: ["--stdio"] },
        { name: "remote", transport: "http", url: "https://mcp.example.test/rpc", headers: { "X-Test": "1" } },
        { name: "events", transport: "sse", url: "https://mcp.example.test/events" },
      ],
    });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv), {
      agentConfigCache: { refresh: async () => ({ payload }), get: () => ({ payload }) },
    });

    await handler.start(makeMessage("m1", "hi"), makeContext({ events, logs }), makeToken());

    const spec = specs[0];
    expect(spec?.args).toEqual([
      "--no-auto-update",
      "agent",
      "--no-leader",
      "--always-approve",
      "--model",
      "grok-4-fast",
      "--effort",
      "high",
      "stdio",
    ]);
    const requests = readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "");
    const newSession = requests.find((r) => r.method === "session/new");
    // The sse server is dropped (agent advertised mcpCapabilities.sse=false);
    // stdio and http map to the ACP schema.
    expect(newSession?.params.mcpServers).toEqual([
      { name: "docs", command: "docs-server", args: ["--stdio"], env: [] },
      { name: "remote", type: "http", url: "https://mcp.example.test/rpc", headers: [{ name: "X-Test", value: "1" }] },
    ]);
    expect(logs.some((line) => line.includes('dropping MCP server "events"'))).toBe(true);
  });

  it("inject while a turn is active queues and drains as an ordered session/load batch afterwards", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const releaseFile = join(workspaceRoot, "release-first");
    const fakeEnv = fakeEnvFor("queued", { GROK_FAKE_SCENARIO: "hold", GROK_FAKE_RELEASE_FILE: releaseFile });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv));
    const token1 = makeToken();
    const ctx = makeContext({ events });

    const startPromise = handler.start(makeMessage("m1", "long turn"), ctx, token1);
    // Wait for the first prompt to be in flight, then inject mid-turn.
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "").some((r) => r.method === "session/prompt")) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });
    const token2 = makeToken();
    const receipt = handler.inject(makeMessage("m2", "queued message"), token2);
    expect(receipt).toMatchObject({ kind: "owned", mode: "queued" });

    writeFileSync(releaseFile, "go");
    await startPromise;
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (token2.completed.length > 0) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
      setTimeout(() => reject(new Error("queued turn never settled")), 5000);
    });

    expect(specs).toHaveLength(2);
    expect(token1.completed).toMatchObject([{ status: "success" }]);
    expect(token2.completed).toMatchObject([{ status: "success" }]);
    // The queued turn resumed the now-confirmed session id via session/load.
    const requests = readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "");
    expect(requests.map((r) => r.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_model",
      "session/prompt",
      "initialize",
      "session/load",
      "session/set_model",
      "session/prompt",
    ]);
  });

  it("suspend mid-turn aborts the child, retries the queued batch, and never completes the in-flight token", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const children: SpawnedChild[] = [];
    const fakeEnv = fakeEnvFor("suspend", {
      GROK_FAKE_SCENARIO: "hold",
      GROK_FAKE_RELEASE_FILE: join(workspaceRoot, "never-released"),
    });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv, children));
    const token1 = makeToken();
    const ctx = makeContext({ events });

    const startPromise = handler.start(makeMessage("m1", "long turn"), ctx, token1);
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "").some((r) => r.method === "session/prompt")) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });
    const token2 = makeToken();
    handler.inject(makeMessage("m2", "queued message"), token2);

    await handler.suspend();
    await startPromise;

    expect(token1.completed).toEqual([]);
    expect(token2.retried).toEqual(["grok_suspend_before_terminal"]);
    // The abort path SIGTERMs the process group; the held child must be dead.
    const child = children[0];
    if (!child) throw new Error("unreachable");
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    expect(child.signalCode).toBe("SIGTERM");
  });

  it("admin resume (no message) clears the bring-up guard so later injects still drain", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const fakeEnv = fakeEnvFor("adminresume");
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv));

    const receipt = await handler.resume(undefined, "grok-sess-1", makeContext({ events }), makeToken());
    if (typeof receipt === "string") throw new Error("expected a resume receipt");
    expect(receipt.route).toBeNull();

    const token = makeToken();
    const injectReceipt = handler.inject(makeMessage("m-post-admin", "hello"), token);
    expect(injectReceipt).toMatchObject({ kind: "owned", mode: "queued" });
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (token.completed.length > 0) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
      setTimeout(() => reject(new Error("queued turn never settled")), 5000);
    });
    expect(specs).toHaveLength(1);
    const requests = readRequestLog(fakeEnv.GROK_FAKE_REQUEST_LOG ?? "");
    expect(requests.map((r) => r.method)).toEqual([
      "initialize",
      "session/load",
      "session/set_model",
      "session/prompt",
    ]);
    expect(token.completed).toMatchObject([{ status: "success" }]);
  });

  it("tool completion emits tool_call events with repo-qualified Context Tree refs", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const contextTreePath = join(workspaceRoot, "context-tree");
    const toolPath = join(contextTreePath, "system", "NODE.md");
    const fakeEnv = fakeEnvFor("toolturn", { GROK_FAKE_TOOL: "search_replace", GROK_FAKE_TOOL_PATH: toolPath });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv), {
      contextTreePath,
      contextTreeRepoUrl: "https://github.com/acme/tree.git",
      contextTreeBranch: "main",
    });

    await handler.start(
      makeMessage("m1", "edit the node"),
      makeContext({ events, contextTreeRepoUrl: "https://github.com/acme/tree.git" }),
      makeToken(),
    );

    const pending = events.find((e) => e.kind === "tool_call" && e.payload.status === "pending");
    expect(pending).toMatchObject({
      kind: "tool_call",
      payload: { toolUseId: "tc-1", name: "search_replace", status: "pending" },
    });
    const completed = events.find((e) => e.kind === "tool_call" && e.payload.status === "ok");
    if (completed?.kind !== "tool_call") throw new Error("expected an ok tool_call event");
    expect(completed.payload.name).toBe("search_replace");
    expect(completed.payload.resultPreview).toBe("search_replace done");
    expect(completed.payload.toolFileRefs).toMatchObject([
      {
        origin: "file_change",
        repoUrl: "https://github.com/acme/tree.git",
        repoBranch: "main",
        repoRelativePath: "system/NODE.md",
      },
    ]);
  });

  it("a proven read-only shell tool emits a tool_arg ref and keeps the turn replay-safe", async () => {
    const events: SessionEvent[] = [];
    const specs: ProviderProcessSpec[] = [];
    const contextTreePath = join(workspaceRoot, "context-tree");
    const fakeEnv = fakeEnvFor("shellturn", {
      GROK_FAKE_TOOL: "run_terminal_cmd",
      GROK_FAKE_TOOL_PATH: join(contextTreePath, "NODE.md"),
    });
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnv), {
      contextTreePath,
      contextTreeRepoUrl: "https://github.com/acme/tree.git",
      contextTreeBranch: "main",
    });

    await handler.start(
      makeMessage("m1", "read the node"),
      makeContext({ events, contextTreeRepoUrl: "https://github.com/acme/tree.git" }),
      makeToken(),
    );

    const completed = events.find((e) => e.kind === "tool_call" && e.payload.status === "ok");
    if (completed?.kind !== "tool_call") throw new Error("expected an ok tool_call event");
    expect(completed.payload.name).toBe("run_terminal_cmd");
    expect(completed.payload.toolFileRefs).toMatchObject([
      { origin: "tool_arg", repoUrl: "https://github.com/acme/tree.git", repoRelativePath: "NODE.md" },
    ]);
  });

  it("fails closed on win32 before any spawn", async () => {
    const specs: ProviderProcessSpec[] = [];
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnvFor("win32")), { grokPlatform: "win32" });
    await expect(handler.start(makeMessage("m1", "hi"), makeContext({ events: [] }), makeToken())).rejects.toThrow(
      /not supported on Windows in V1/,
    );
    expect(specs).toHaveLength(0);
  });

  it("fails closed for landing campaign trial agents (app-server-only contract)", async () => {
    const specs: ProviderProcessSpec[] = [];
    const handler = makeHandler(createFakeAcpSupervisor(specs, fakeEnvFor("trial")));
    const ctx = makeContext({ events: [] });
    ctx.agent.metadata = {
      landingCampaignTrial: true,
      campaign: "production-scan",
      skillSetId: "production-scan",
      skillSetVersion: "2026.07.02.1",
      repo: { url: "https://github.com/acme/backend", canonicalKey: "github.com/acme/backend" },
    };
    await expect(handler.start(makeMessage("m1", "hi"), ctx, makeToken())).rejects.toThrow(
      /landing campaign trial agents require the codex app-server/,
    );
    expect(specs).toHaveLength(0);
  });
});
