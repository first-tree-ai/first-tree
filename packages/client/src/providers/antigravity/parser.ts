/**
 * Tolerant parser for the documented Antigravity CLI `stream-json` protocol.
 * Protocol-required identity and terminal-result checks are intentionally left
 * to the handler so a CLI update fails closed instead of being mistaken for a
 * successful turn.
 */

export type AntigravityUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type AntigravityStreamEvent =
  | { kind: "init"; sessionId: string | null }
  | { kind: "assistant_delta"; text: string }
  | {
      kind: "tool";
      toolUseId: string;
      name: string;
      status: "pending" | "ok" | "error";
      args: unknown;
      resultPreview?: string;
    }
  | { kind: "usage"; usage: AntigravityUsage }
  | {
      kind: "result";
      isError: boolean;
      text: string;
      sessionId: string | null;
      usage: AntigravityUsage | null;
    }
  | { kind: "error"; message: string }
  | { kind: "unknown"; note: string; raw: string };

const PREVIEW_LIMIT = 400;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
}

function preview(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.slice(0, PREVIEW_LIMIT);
  if (value === undefined || value === null) return undefined;
  try {
    const text = JSON.stringify(value);
    return text ? text.slice(0, PREVIEW_LIMIT) : undefined;
  } catch {
    return String(value).slice(0, PREVIEW_LIMIT);
  }
}

function usage(value: unknown): AntigravityUsage | null {
  const row = record(value);
  if (!row) return null;
  const input = number(row.input_tokens) ?? number(row.inputTokens);
  const cached =
    number(row.cache_read) ??
    number(row.cache_read_tokens) ??
    number(row.cacheReadTokens) ??
    number(row.cached_input_tokens);
  const output = number(row.output_tokens) ?? number(row.outputTokens);
  if (input === null && cached === null && output === null) return null;
  return {
    inputTokens: input ?? 0,
    cachedInputTokens: cached ?? 0,
    outputTokens: output ?? 0,
  };
}

function unknown(note: string, raw: string): AntigravityStreamEvent {
  return { kind: "unknown", note, raw: raw.slice(0, PREVIEW_LIMIT) };
}

/** Parse one NDJSON line without throwing. */
export function parseAntigravityStreamLine(line: string): AntigravityStreamEvent[] {
  const raw = line.trim();
  if (!raw) return [];

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [unknown("unparsable stream line", raw)];
  }
  const row = record(value);
  if (!row) return [unknown("non-object stream line", raw)];

  const eventName = string(row.event);
  if (eventName === "init") {
    return [{ kind: "init", sessionId: string(row.conversation_id) }];
  }

  if (eventName === "step_update") {
    const step = record(row.step_update);
    if (!step) return [unknown("step_update event missing step_update payload", raw)];
    const events: AntigravityStreamEvent[] = [];
    const sessionId = string(step.conversation_id);
    if (sessionId) events.push({ kind: "init", sessionId });
    const stepUsage = usage(step.usage);
    if (stepUsage) events.push({ kind: "usage", usage: stepUsage });

    const stepType = string(step.step_type);
    if (stepType === "agent_response") {
      const text = typeof step.text_delta === "string" ? step.text_delta : "";
      if (text) events.push({ kind: "assistant_delta", text });
      return events;
    }
    if (stepType === "tool") {
      const toolName = string(step.tool_name);
      if (!toolName) return [...events, unknown("tool step missing tool_name", raw)];
      const toolInfo = record(step.tool_info);
      const args = toolInfo?.parameters ?? toolInfo?.args ?? toolInfo?.arguments ?? {};
      const failed = toolInfo?.error !== undefined && toolInfo?.error !== null;
      const state = string(step.state);
      const status = state === "ACTIVE" ? "pending" : state === "DONE" ? (failed ? "error" : "ok") : "pending";
      const toolUseId =
        string(step.tool_call_id) ??
        string(step.call_id) ??
        string(toolInfo?.id) ??
        (typeof step.step_index === "number" ? `step-${step.step_index}` : `tool-${events.length}`);
      events.push({
        kind: "tool",
        toolUseId,
        name: toolName,
        status,
        args,
        ...(status !== "pending" ? { resultPreview: preview(toolInfo?.error ?? toolInfo?.output) } : {}),
      });
      return events;
    }
    if (stepType === "user_input" || stepType === "checkpoint") return events;
    return [...events, unknown(`unknown step type ${String(step.step_type)}`, raw)];
  }

  if (eventName === "result") {
    const result = record(row.result);
    if (!result) return [unknown("result event missing result payload", raw)];
    const status = string(result.status);
    const isError = status !== "SUCCESS";
    const text = string(result.response) ?? "";
    const error = string(result.error);
    const events: AntigravityStreamEvent[] = [
      {
        kind: "result",
        isError,
        text,
        sessionId: string(result.conversation_id),
        usage: usage(result.usage),
      },
    ];
    if (isError) events.push({ kind: "error", message: error ?? `Antigravity returned status ${status ?? "unknown"}` });
    return events;
  }

  return [unknown(`unknown event ${String(row.event)}`, raw)];
}

export class AntigravityStreamParser {
  private buffer = "";

  push(chunk: string): AntigravityStreamEvent[] {
    this.buffer += chunk;
    const events: AntigravityStreamEvent[] = [];
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      events.push(...parseAntigravityStreamLine(this.buffer.slice(0, newline)));
      this.buffer = this.buffer.slice(newline + 1);
    }
    return events;
  }

  flush(): AntigravityStreamEvent[] {
    const tail = this.buffer;
    this.buffer = "";
    return tail.trim() ? parseAntigravityStreamLine(tail) : [];
  }
}
