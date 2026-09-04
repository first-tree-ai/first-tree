/**
 * Pure, tolerant normalization of Grok Build ACP wire traffic into internal
 * events. Two inbound channels are covered:
 *
 *   - the standard `session/update` notification (`params.update`), and
 *   - x.ai's extension notifications `_x.ai/session_notification` and
 *     `_x.ai/session/update`, which carry snake_case payloads such as
 *     `turn_completed` usage.
 *
 * Tolerance contract (same as the cursor stream parser): unknown update
 * kinds, missing optional fields, and malformed payloads NEVER throw — they
 * degrade to `{ kind: "ignored" }` carrying a diagnostic note. The handler
 * decides what is a protocol failure; this module only reads.
 *
 * Wire shapes locked against real Grok 0.2.117 traffic.
 */

import type { ProviderModelOption } from "@first-tree/shared";

/** Usage carried by `_x.ai/session_notification` `turn_completed` (one per prompt). */
export type GrokUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
};

export type GrokTurnCompleted = {
  /** Correlates this completion with the prompt response `_meta.promptId`. */
  promptId: string | null;
  stopReason: string | null;
  usage: GrokUsage | null;
  /** Provider cost accounting has no SessionEvent field — log-only. */
  costUsdTicks: number | null;
  modelCalls: number | null;
  apiDurationMs: number | null;
};

/**
 * One tool invocation, normalized from `tool_call` / `tool_call_update`.
 * `readOnly` is tri-state: `true` only when the provider's
 * `_meta["x.ai/tool"].read_only` explicitly says so; anything else (false,
 * absent, malformed) is unproven and must count as a side effect on the
 * replay-safety ladder.
 */
/** Display fallback when one ACP payload has no `_meta["x.ai/tool"].name` and no `title`. */
export const GROK_UNKNOWN_TOOL_NAME = "grok:unknown";

export type GrokToolInfo = {
  toolCallId: string;
  /** `_meta["x.ai/tool"].name` when present, else the raw `title`, else a tagged unknown. */
  name: string;
  kind: string | null;
  /**
   * True for the shell/execute tool (`run_terminal_cmd` or kind "execute"),
   * keyed on name/kind — NOT on the presence of a command. A shell tool whose
   * command is missing must fail CLOSED (unsafe), never inherit read-only.
   */
  isShell: boolean;
  readOnly: boolean | null;
  /** Shell command: `rawInput.command`, else `_meta["x.ai/tool"].input.command`. */
  command: string | null;
  /** Candidate file paths: `_meta["x.ai/tool"].input.path`, locations, diff content. */
  paths: string[];
  argsSummary: Record<string, unknown>;
};

/** Shell detection keys on name/kind — NOT on the presence of a command. */
export function grokToolIsShell(name: string, kind: string | null): boolean {
  return name === "run_terminal_cmd" || kind === "execute";
}

/**
 * ACP `tool_call_update` is a patch: omitted fields leave the previous tool
 * call unchanged. Merge one extracted payload onto the last known info for
 * the same `toolCallId` so a completed/failed update that only carries
 * `status` + `rawOutput` cannot replace a real name with `grok:unknown`.
 *
 * Concrete incoming values replace; `null`/empty extracted fields are treated
 * as omitted (the extractor cannot see JSON `null` vs absent). Keep
 * `grok:unknown` only when this id has never had a name or title.
 */
export function mergeGrokToolInfo(previous: GrokToolInfo | undefined, incoming: GrokToolInfo): GrokToolInfo {
  if (!previous) return incoming;
  const name = incoming.name !== GROK_UNKNOWN_TOOL_NAME ? incoming.name : previous.name;
  const kind = incoming.kind ?? previous.kind;
  const command = incoming.command ?? previous.command;
  const paths = incoming.paths.length > 0 ? incoming.paths : previous.paths;
  const readOnly = incoming.readOnly ?? previous.readOnly;
  const argsSummary = Object.keys(incoming.argsSummary).length > 0 ? incoming.argsSummary : previous.argsSummary;
  return {
    toolCallId: incoming.toolCallId,
    name,
    kind,
    isShell: grokToolIsShell(name, kind),
    readOnly,
    command,
    paths,
    argsSummary,
  };
}

export type GrokNormalizedEvent =
  | { kind: "assistant_chunk"; text: string }
  | { kind: "thought_chunk" }
  | { kind: "user_echo" }
  | { kind: "tool_started"; tool: GrokToolInfo }
  | { kind: "tool_completed"; tool: GrokToolInfo; ok: boolean; resultPreview: string | null }
  | { kind: "plan" }
  | { kind: "turn_completed"; completed: GrokTurnCompleted }
  | { kind: "ignored"; note: string };

const RESULT_PREVIEW_LIMIT = 400;
const XAI_TOOL_META_KEY = "x.ai/tool";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function contentText(content: unknown): string {
  const record = asRecord(content);
  if (record?.type === "text" && typeof record.text === "string") return record.text;
  return "";
}

function xaiToolMeta(update: Record<string, unknown>): Record<string, unknown> | null {
  const meta = asRecord(update._meta);
  return meta ? asRecord(meta[XAI_TOOL_META_KEY]) : null;
}

function pushPath(paths: string[], seen: Set<string>, value: unknown): void {
  if (typeof value !== "string" || value.length === 0 || seen.has(value)) return;
  seen.add(value);
  paths.push(value);
}

function extractToolPaths(update: Record<string, unknown>, meta: Record<string, unknown> | null): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const metaInput = meta ? asRecord(meta.input) : null;
  pushPath(paths, seen, metaInput?.path);
  const locations = update.locations;
  if (Array.isArray(locations)) {
    for (const location of locations) pushPath(paths, seen, asRecord(location)?.path);
  }
  const content = update.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const record = asRecord(block);
      if (record?.type === "diff") pushPath(paths, seen, record.path);
    }
  }
  return paths;
}

function toolArgsSummary(command: string | null, paths: string[]): Record<string, unknown> {
  if (command) return { command };
  const path = paths[0];
  if (path) return { path };
  return {};
}

function extractTool(update: Record<string, unknown>): GrokToolInfo | null {
  const toolCallId = asString(update.toolCallId);
  if (!toolCallId) return null;
  const meta = xaiToolMeta(update);
  const metaInput = meta ? asRecord(meta.input) : null;
  const rawInput = asRecord(update.rawInput);
  const command = asString(rawInput?.command) ?? asString(metaInput?.command);
  const title = asString(update.title);
  const metaName = meta ? asString(meta.name) : null;
  const kind = (meta ? asString(meta.kind) : null) ?? asString(update.kind);
  const name = metaName ?? title ?? GROK_UNKNOWN_TOOL_NAME;
  const readOnly = meta && typeof meta.read_only === "boolean" ? meta.read_only : null;
  const paths = extractToolPaths(update, meta);
  return {
    toolCallId,
    name,
    kind,
    isShell: grokToolIsShell(name, kind),
    readOnly,
    command,
    paths,
    argsSummary: toolArgsSummary(command, paths),
  };
}

function extractUsage(usage: unknown): GrokUsage | null {
  const record = asRecord(usage);
  if (!record) return null;
  const inputTokens = asFiniteNumber(record.inputTokens);
  const outputTokens = asFiniteNumber(record.outputTokens);
  const cachedReadTokens = asFiniteNumber(record.cachedReadTokens);
  if (inputTokens === null && outputTokens === null && cachedReadTokens === null) return null;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cachedReadTokens: cachedReadTokens ?? 0,
  };
}

/** Session id carried on a routed ACP notification, when present. */
export function grokNotificationSessionId(params: unknown): string | null {
  return asString(asRecord(params)?.sessionId);
}

/**
 * Parse the `_x.ai/session_notification` `model_changed` echo Grok emits in
 * response to `session/set_model` (real 0.2.117 wire shape, snake_case):
 * `{sessionId, update: {sessionUpdate: "model_changed", model_id, reasoning_effort?}}`.
 * Returns null for any other payload. `reasoningEffort` is null when the
 * echo omits the field (e.g. the provider ignored the override).
 */
export function parseGrokModelChangedEcho(params: unknown): {
  modelId: string | null;
  reasoningEffort: string | null;
} | null {
  const update = asRecord(asRecord(params)?.update);
  if (asString(update?.sessionUpdate) !== "model_changed") return null;
  return {
    modelId: asString(update?.model_id),
    reasoningEffort: asString(update?.reasoning_effort),
  };
}

/**
 * The exact replay marker (`params._meta.isReplay === true`) Grok stamps on
 * historical traffic. A marked notification is ALWAYS replay, no matter when
 * it arrives — the marker, not arrival timing, is the correctness boundary.
 */
export function grokNotificationIsReplay(params: unknown): boolean {
  return asRecord(asRecord(params)?._meta)?.isReplay === true;
}

/**
 * Normalize one standard `session/update` notification. Returns null when the
 * payload has no recognizable envelope at all.
 */
export function normalizeGrokSessionUpdate(params: unknown): {
  sessionId: string | null;
  event: GrokNormalizedEvent;
} | null {
  const record = asRecord(params);
  const update = asRecord(record?.update);
  if (!record || !update) return null;
  const sessionId = asString(record.sessionId);
  const sessionUpdate = asString(update.sessionUpdate);

  switch (sessionUpdate) {
    case "agent_message_chunk":
      return { sessionId, event: { kind: "assistant_chunk", text: contentText(update.content) } };
    case "agent_thought_chunk":
      return { sessionId, event: { kind: "thought_chunk" } };
    case "user_message_chunk":
      return { sessionId, event: { kind: "user_echo" } };
    case "tool_call": {
      const tool = extractTool(update);
      if (!tool) return { sessionId, event: { kind: "ignored", note: "tool_call without toolCallId" } };
      return { sessionId, event: { kind: "tool_started", tool } };
    }
    case "tool_call_update": {
      const tool = extractTool(update);
      if (!tool) return { sessionId, event: { kind: "ignored", note: "tool_call_update without toolCallId" } };
      const status = asString(update.status);
      if (status !== "completed" && status !== "failed") {
        return { sessionId, event: { kind: "ignored", note: `tool_call_update status ${status ?? "unknown"}` } };
      }
      const rawOutput = asString(update.rawOutput);
      const preview = rawOutput && rawOutput.trim().length > 0 ? rawOutput.slice(0, RESULT_PREVIEW_LIMIT) : null;
      return { sessionId, event: { kind: "tool_completed", tool, ok: status === "completed", resultPreview: preview } };
    }
    case "plan":
      return { sessionId, event: { kind: "plan" } };
    default:
      return { sessionId, event: { kind: "ignored", note: `sessionUpdate kind ${sessionUpdate ?? "unknown"}` } };
  }
}

/**
 * Normalize one x.ai extension notification (`_x.ai/session_notification` or
 * `_x.ai/session/update`). The only payload with event semantics is
 * `turn_completed` — THE per-prompt usage source. `response_completed` is
 * per-model-call with snake_case fields and must never be summed in, so it
 * degrades to ignored like every other extension kind.
 */
export function normalizeGrokXaiNotification(params: unknown): {
  sessionId: string | null;
  event: GrokNormalizedEvent;
} | null {
  const record = asRecord(params);
  const update = asRecord(record?.update);
  if (!record || !update) return null;
  const sessionId = asString(record.sessionId);
  const sessionUpdate = asString(update.sessionUpdate);

  if (sessionUpdate === "turn_completed") {
    return {
      sessionId,
      event: {
        kind: "turn_completed",
        completed: {
          promptId: asString(update.prompt_id),
          stopReason: asString(update.stop_reason),
          usage: extractUsage(update.usage),
          costUsdTicks: asFiniteNumber(update.usage ? asRecord(update.usage)?.costUsdTicks : null),
          modelCalls: asFiniteNumber(update.usage ? asRecord(update.usage)?.modelCalls : null),
          apiDurationMs: asFiniteNumber(update.usage ? asRecord(update.usage)?.apiDurationMs : null),
        },
      },
    };
  }
  return { sessionId, event: { kind: "ignored", note: `x.ai sessionUpdate kind ${sessionUpdate ?? "unknown"}` } };
}

/**
 * Parse the initialize response `_meta.modelState` into a model catalog
 * (shared by model discovery and the handler's default-model bookkeeping).
 * `currentModelId` marks the provider's current/default entry.
 */
export function parseGrokModelState(initializeResponse: unknown): {
  models: ProviderModelOption[];
  defaultModelId: string | null;
} {
  const meta = asRecord(asRecord(initializeResponse)?._meta);
  const modelState = asRecord(meta?.modelState);
  if (!modelState) return { models: [], defaultModelId: null };
  const currentModelId = asString(modelState.currentModelId);
  const available = Array.isArray(modelState.availableModels) ? modelState.availableModels : [];
  const models: ProviderModelOption[] = [];
  for (const entry of available) {
    const record = asRecord(entry);
    const modelId = asString(record?.modelId);
    if (!modelId) continue;
    const name = asString(record?.name);
    const isDefault = currentModelId !== null && modelId === currentModelId;
    models.push({
      id: modelId,
      label: name && name.length > 0 ? name : modelId,
      ...(isDefault ? { isDefault: true, hint: "default" } : {}),
    });
  }
  return { models, defaultModelId: currentModelId };
}
