export type OpenCodeUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type OpenCodeStreamEvent =
  | { kind: "session"; sessionId: string }
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      toolUseId: string;
      name: string;
      status: "pending" | "ok" | "error";
      args: unknown;
      resultPreview?: string;
    }
  | { kind: "usage"; usage: OpenCodeUsage }
  | { kind: "terminal"; reason: string }
  | { kind: "error"; message: string }
  | { kind: "reasoning" }
  | { kind: "unknown"; note: string };

const PREVIEW_LIMIT = 400;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

type TextField = { kind: "missing" } | { kind: "invalid" } | { kind: "value"; text: string };

function textField(value: Record<string, unknown> | null): TextField {
  if (!value || !Object.hasOwn(value, "text")) return { kind: "missing" };
  return typeof value.text === "string" ? { kind: "value", text: value.text } : { kind: "invalid" };
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function preview(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.slice(0, PREVIEW_LIMIT);
  if (value === undefined || value === null) return undefined;
  try {
    return JSON.stringify(value).slice(0, PREVIEW_LIMIT);
  } catch {
    return String(value).slice(0, PREVIEW_LIMIT);
  }
}

function usage(value: unknown): OpenCodeUsage | null {
  const row = record(value);
  if (!row) return null;
  const cache = record(row.cache);
  const input = number(row.input) ?? number(row.inputTokens) ?? number(row.input_tokens);
  const cached =
    number(row.cacheRead) ??
    number(row.cache_read) ??
    number(row.cachedInputTokens) ??
    number(row.cached_input_tokens) ??
    number(cache?.read);
  const output = number(row.output) ?? number(row.outputTokens) ?? number(row.output_tokens);
  if (input === null && cached === null && output === null) return null;
  return {
    inputTokens: Math.max(0, input ?? 0),
    cachedInputTokens: Math.max(0, cached ?? 0),
    outputTokens: Math.max(0, output ?? 0),
  };
}

function sessionId(row: Record<string, unknown>, part: Record<string, unknown> | null): string | null {
  return string(row.sessionID) ?? string(row.sessionId) ?? string(part?.sessionID) ?? string(part?.sessionId);
}

/** Parse one OpenCode `run --format json` line without throwing. */
export function parseOpenCodeStreamLine(line: string): OpenCodeStreamEvent[] {
  const raw = line.trim();
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [{ kind: "unknown", note: "unparsable JSONL line" }];
  }
  const row = record(value);
  if (!row) return [{ kind: "unknown", note: "non-object JSONL value" }];
  const part = record(row.part);
  const events: OpenCodeStreamEvent[] = [];
  const id = sessionId(row, part);
  if (id) events.push({ kind: "session", sessionId: id });

  switch (string(row.type)) {
    case "text": {
      // OpenCode stores an empty text part for assistant steps that only call
      // tools, and re-emits stored parts (including empty ones) when a session
      // is resumed. An explicitly empty string is therefore normal, not a
      // protocol violation — skip it instead of failing the turn. Missing or
      // non-string fields remain protocol violations. The row-level text
      // fallback is retained only when the part has no text field.
      const partText = textField(part);
      const text = partText.kind === "missing" ? textField(row) : partText;
      if (text.kind !== "value") events.push({ kind: "unknown", note: "text event missing text" });
      else if (text.text) events.push({ kind: "text", text: text.text });
      break;
    }
    case "tool_use": {
      const state = record(part?.state);
      const toolName = string(part?.tool);
      if (!part || !state || !toolName) {
        events.push({ kind: "unknown", note: "tool_use event missing part, state, or tool name" });
        break;
      }
      const metadata = record(state?.metadata);
      const statusValue = string(state?.status) ?? "pending";
      const status =
        statusValue === "completed" || statusValue === "ok"
          ? (number(metadata?.exit) ?? 0) === 0
            ? "ok"
            : "error"
          : statusValue === "error" || statusValue === "failed"
            ? "error"
            : "pending";
      events.push({
        kind: "tool",
        toolUseId:
          string(part?.id) ??
          string(part?.callID) ??
          string(part?.callId) ??
          `${toolName}:${string(part?.messageID) ?? "unknown"}`,
        name: toolName,
        status,
        args: state?.input ?? part?.input ?? {},
        ...(status === "pending" ? {} : { resultPreview: preview(state?.output ?? state?.error) }),
      });
      break;
    }
    case "step_finish": {
      if (!part) {
        events.push({ kind: "unknown", note: "step_finish event missing part" });
        break;
      }
      const tokenUsage = usage(part?.tokens ?? row.tokens);
      if (tokenUsage) events.push({ kind: "usage", usage: tokenUsage });
      const reason = string(part?.reason);
      if (!reason) events.push({ kind: "unknown", note: "step_finish event missing reason" });
      else if (reason !== "tool-calls") events.push({ kind: "terminal", reason });
      break;
    }
    case "error": {
      const error = record(part?.error ?? row.error);
      events.push({
        kind: "error",
        message:
          string(error?.message) ??
          string(part?.message) ??
          string(row.message) ??
          preview(part?.error ?? row.error) ??
          "OpenCode emitted an error event",
      });
      break;
    }
    case "step_start":
      break;
    case "reasoning":
      events.push({ kind: "reasoning" });
      break;
    default:
      events.push({
        kind: "unknown",
        note: `unknown event type ${String(row.type)}`,
      });
  }
  return events;
}

export class OpenCodeStreamParser {
  private buffer = "";

  push(chunk: string): OpenCodeStreamEvent[] {
    this.buffer += chunk;
    const events: OpenCodeStreamEvent[] = [];
    let start = 0;
    for (;;) {
      const newline = this.buffer.indexOf("\n", start);
      if (newline < 0) break;
      events.push(...parseOpenCodeStreamLine(this.buffer.slice(start, newline)));
      start = newline + 1;
    }
    if (start > 0) this.buffer = this.buffer.slice(start);
    return events;
  }

  flush(): OpenCodeStreamEvent[] {
    const tail = this.buffer;
    this.buffer = "";
    return tail.trim() ? parseOpenCodeStreamLine(tail) : [];
  }
}
