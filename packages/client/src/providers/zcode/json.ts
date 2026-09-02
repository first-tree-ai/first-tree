const MAX_MACHINE_JSON_BYTES = 2 * 1024 * 1024;

export type ZcodeUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type ZcodeResult = {
  sessionId: string;
  response: string;
  usage: ZcodeUsage | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function usage(value: unknown): ZcodeUsage | null {
  const row = record(value);
  if (!row) return null;
  const input = nonNegativeInteger(row.inputTokens);
  const cached = nonNegativeInteger(row.cacheReadTokens);
  const output = nonNegativeInteger(row.outputTokens);
  if (input === null && cached === null && output === null) return null;
  return {
    inputTokens: input ?? 0,
    cachedInputTokens: cached ?? 0,
    outputTokens: output ?? 0,
  };
}

/**
 * Parse the complete stdout of `zcode --json`. The pinned CLI emits one
 * top-level object, not a mixed human/log stream: anything before or after it
 * is a protocol failure, even when an object can be recovered from noise.
 */
export function parseZcodeJsonOutput(output: string): ZcodeResult {
  const bytes = Buffer.byteLength(output, "utf8");
  if (bytes > MAX_MACHINE_JSON_BYTES) {
    throw new Error(`ZCode machine output exceeded ${MAX_MACHINE_JSON_BYTES} bytes`);
  }
  if (output.trim().length === 0) throw new Error("ZCode emitted no machine JSON");
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new Error(
      `ZCode machine output was not exactly one JSON object: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const row = record(value);
  if (!row) throw new Error("ZCode machine output was not exactly one JSON object");
  const sessionId = string(row.sessionId)?.trim();
  const response = string(row.response);
  if (!sessionId || !sessionId.startsWith("sess_")) {
    throw new Error("ZCode machine result omitted a sess_... sessionId");
  }
  if (typeof response !== "string") throw new Error("ZCode machine result omitted string response");
  return { sessionId, response, usage: usage(row.usage) };
}
