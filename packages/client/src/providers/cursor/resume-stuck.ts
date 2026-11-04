/**
 * Cursor CLI can exhaust its own in-turn resume loop and then report
 * "repeated resume attempts made no progress". First Tree must not retry that
 * same provider session with `--resume`; the conversation is stuck.
 *
 * Keep the matcher in sync with the cursor-gated branch in
 * `runtime/provider-retry-policy.ts`.
 */
const RESUME_STUCK_RE = /repeated resume attempts made no progress/i;

export function isCursorResumeStuckError(err: unknown): boolean {
  return RESUME_STUCK_RE.test(errorText(err));
}

export function cursorResumeStuckRecoveryMessage(
  staleSessionId: string | null,
  replacementSessionId?: string | null,
): string {
  const stale = staleSessionId ? ` for session ${staleSessionId}` : "";
  const replacement = replacementSessionId ? `; replacement session ${replacementSessionId}` : "";
  return `cursor resume made no progress${stale}; starting a fresh Cursor session${replacement}`;
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const record = err as unknown as Record<string, unknown>;
    const parts = [err.name, err.message];
    if (record.code !== undefined) parts.push(String(record.code));
    if (record.reason !== undefined) parts.push(String(record.reason));
    if (record.cause !== undefined) parts.push(errorText(record.cause));
    return parts.filter(Boolean).join("\n");
  }
  if (typeof err === "string") return err;
  if (!err || typeof err !== "object") return String(err);
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
