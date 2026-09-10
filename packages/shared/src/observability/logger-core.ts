/**
 * Logger core — format / level primitives shared between server and client.
 *
 * This module intentionally has no dependency on `pino` so it can live in
 * `@first-tree/shared`. Consumers construct their
 * own pino instance and pass the output stream built here.
 */

import { Writable } from "node:stream";
import { z } from "zod";

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_FORMATS = ["pretty", "json"] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

export const logLevelSchema = z.enum(LOG_LEVELS);
export const logFormatSchema = z.enum(LOG_FORMATS);

/**
 * Parse an env-var / config string into a LogLevel. Unknown values fall back
 * to `info` so the process never fails to boot on a typo — the caller is
 * responsible for emitting a warning when `fellBack` is true.
 */
export function parseLogLevel(raw: string | undefined | null): { level: LogLevel; fellBack: boolean } {
  if (!raw) return { level: "info", fellBack: false };
  const parsed = logLevelSchema.safeParse(raw);
  if (parsed.success) return { level: parsed.data, fellBack: false };
  return { level: "info", fellBack: true };
}

// ─── Pretty formatter ─────────────────────────────────────────────────

export const LEVEL_LABELS: Record<number, string> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO",
  40: "WARN",
  50: "ERROR",
  60: "FATAL",
};

export const LEVEL_COLORS: Record<number, string> = {
  10: "\x1b[90m",
  20: "\x1b[36m",
  30: "\x1b[32m",
  40: "\x1b[33m",
  50: "\x1b[31m",
  60: "\x1b[35m",
};

export const RESET = "\x1b[0m";
export const DIM = "\x1b[2m";

export const SKIP_KEYS = new Set(["level", "time", "msg", "module", "pid", "hostname", "v"]);

/**
 * Pino `redact.paths` entries applied to every root logger in First Tree. Keeps the
 * list short on purpose — pino's redact walks each path on every log call, so
 * we target obvious sensitive field names plus a narrow set of nested forms
 * (`*.foo` matches a single nesting level in pino v9).
 *
 * Values matching these paths are replaced with the censor string `[REDACTED]`.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  "password",
  "*.password",
  "token",
  "*.token",
  "accessToken",
  "*.accessToken",
  "refreshToken",
  "*.refreshToken",
  "jwt",
  "*.jwt",
  "secret",
  "*.secret",
  "apiKey",
  "*.apiKey",
  "api_key",
  "*.api_key",
  "credentials",
  "*.credentials",
  "authorization",
  "*.authorization",
  "*.headers.cookie",
  "*.headers.authorization",
];

export const LOG_REDACT_CENSOR = "[REDACTED]";

export function formatPrettyEntry(json: string): string {
  const obj = JSON.parse(json) as Record<string, unknown>;
  const level = obj.level as number;
  const label = LEVEL_LABELS[level] ?? "???";
  const color = LEVEL_COLORS[level] ?? "";
  const time = (obj.time as string) ?? new Date().toISOString();
  const module = obj.module ? `[${String(obj.module)}] ` : "";
  const msg = (obj.msg as string) ?? "";

  const extras: string[] = [];
  let errStack = "";
  for (const [k, v] of Object.entries(obj)) {
    if (SKIP_KEYS.has(k)) continue;
    if (k === "err" && v && typeof v === "object") {
      const e = v as Record<string, unknown>;
      if (e.message) extras.push(`err.message=${String(e.message)}`);
      if (typeof e.stack === "string") errStack = `\n${DIM}${e.stack}${RESET}`;
    } else {
      extras.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
    }
  }

  const extraStr = extras.length > 0 ? `  ${DIM}${extras.join(" ")}${RESET}` : "";
  return `${DIM}${time}${RESET} ${color}${label.padEnd(5)}${RESET} ${module}${msg}${extraStr}${errStack}\n`;
}

export function formatLocalTime(): string {
  const d = new Date();
  const date = d.toLocaleDateString("sv-SE");
  const time = d.toLocaleTimeString("en-GB", { hour12: false });
  return `${date} ${time}`;
}

// ─── Output stream factory ────────────────────────────────────────────

/**
 * Maximum size, in UTF-8 bytes, of any payload this stream admits to a
 * destination. Incoming chunks larger than this are replaced by a small
 * structured summary without being decoded, parsed, or pretty-rendered —
 * each of those steps would allocate a second huge copy in this layer. A
 * record whose rendered output exceeds the cap is replaced the same way, so
 * the bound holds for what actually reaches the destination. Internal
 * notices and summaries are always far below it.
 */
export const LOG_OUTPUT_MAX_RECORD_BYTES = 64 * 1024;

/**
 * Hard upper bound on the destination's queued bytes
 * (`destination.writableLength`). Every payload — record, summary, or
 * notice — is admitted only when the live `writableLength` plus that
 * payload's own byte size stays within this bound, checked independently at
 * the moment of each write.
 */
export const LOG_OUTPUT_MAX_QUEUED_BYTES = 256 * 1024;

type CreateStreamOptions = {
  /** Getter so the format can change via applyConfig without rebuilding the stream. */
  getFormat: () => LogFormat;
  /**
   * Getter for the output sink. Called on every log line so the caller can swap
   * destinations at runtime (e.g. client swaps to a rotating file when running
   * as a background service). Defaults to `process.stderr` — logs belong on
   * stderr so stdout stays clean for CLI JSON output.
   */
  getDestination?: () => Writable;
  /**
   * Optional hook invoked once per NDJSON record written by pino. Server uses
   * this to bridge error/fatal logs onto the active OTel span; client leaves
   * it undefined. Only invoked for records that were actually accepted —
   * oversized or pressure-dropped records are never parsed or bridged.
   */
  onJsonEntry?: (obj: Record<string, unknown>) => void;
};

/**
 * Build the pino destination stream shared by server and client loggers.
 *
 * Bounded best-effort loss policy (intentional): logging must never crash or
 * unboundedly grow the process, so guaranteed delivery is traded for hard
 * memory bounds.
 *
 * - **Record cap** — payloads over `LOG_OUTPUT_MAX_RECORD_BYTES` (input
 *   bytes before parsing, or rendered bytes after pretty formatting) are
 *   replaced by a small structured summary; oversized originals are never
 *   decoded, parsed, rendered, or trace-bridged.
 * - **Strict queue bound** — each payload is admitted only when the
 *   destination's live `writableLength` plus the payload's own bytes stays
 *   within `LOG_OUTPUT_MAX_QUEUED_BYTES`; otherwise the record is dropped
 *   and counted. Every notice and record is checked independently against
 *   the current queue, so a notice and the record that follows it can never
 *   share one pre-checked budget. The Writable callback is always
 *   acknowledged immediately: pino does not guarantee producer-side
 *   backpressure handling, so holding the callback would only move the
 *   unbounded queue from the destination into this wrapper.
 * - **Unavailable destinations** — destroyed, ended, or errored
 *   destinations (the public `Writable.errored`, plus sinks the guard saw
 *   emit 'error', covering `autoDestroy: false` sinks that would otherwise
 *   keep accepting writes that never complete) are rejected early, before
 *   the record is decoded, formatted, or parsed — as are destinations too
 *   full to accept one more byte. Write failures never propagate:
 *   synchronous throws are caught, and asynchronous 'error' events are
 *   swallowed by a single bounded listener attached once per destination
 *   object (tracked in WeakSets, so runtime destination switching adds no
 *   listeners and retains no historical destinations). Nothing is ever
 *   requeued from a catch fallback. `onJsonEntry` runs only for records
 *   actually admitted.
 * - **Fixed-size accounting** — drops live in one counter, never as retained
 *   records. On the next write a healthy destination admits, one bounded
 *   structured warning reports the count; the counter is cleared only when
 *   that notice is itself admitted. No timers, no `drain` listeners, no
 *   recursive logging through pino.
 *
 * Limitations: counts are exact for refusals and discards, but an
 * asynchronous destination failure is counted once per 'error' event, so
 * queued writes lost in the same failure are undercounted. The caps apply
 * only after pino hands this stream a chunk — they cannot undo pino's
 * upstream serialization allocations — and a healthy draining destination is
 * not rate-limited, so disk I/O volume under normal operation is unchanged.
 */
export function createLoggerOutputStream(options: CreateStreamOptions): Writable {
  const getDest = options.getDestination ?? (() => process.stderr);
  // Fixed-size loss accounting only — dropped records are never retained.
  let pendingDrops = 0;
  // Destinations that already have an error guard. Weak, so runtime
  // destination switching retains no historical destinations; each
  // destination object gets at most one listener, ever.
  const guardedDests = new WeakSet<Writable>();
  // Destinations whose 'error' event our guard observed. The public
  // `Writable.errored` property catches sinks that failed before we ever saw
  // them; this WeakSet catches custom 'error' emits that leave the stream's
  // own state untouched.
  const erroredDests = new WeakSet<Writable>();

  /** Render a bounded internal notice through the active format. */
  const renderNotice = (fields: Record<string, unknown>): string => {
    const json = `${JSON.stringify({ level: 40, time: new Date().toISOString(), ...fields })}\n`;
    if (options.getFormat() === "pretty") {
      try {
        return formatPrettyEntry(json);
      } catch {
        return json;
      }
    }
    return json;
  };

  /** A destination that cannot accept writes: gone, ended, or errored. */
  const unavailable = (dest: Writable): boolean =>
    dest.destroyed || dest.writableEnded || dest.errored !== null || erroredDests.has(dest);

  /**
   * Admit one payload to the destination under its live queued-byte budget.
   * Checked independently for every payload, so the destination queue never
   * exceeds `LOG_OUTPUT_MAX_QUEUED_BYTES`. Never throws and never requeues:
   * a synchronous write failure simply counts as not admitted.
   */
  const admit = (dest: Writable, text: string): boolean => {
    try {
      if (unavailable(dest)) return false;
      if (dest.writableLength + Buffer.byteLength(text) > LOG_OUTPUT_MAX_QUEUED_BYTES) return false;
      dest.write(text);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Asynchronous destination failures surface as 'error' events, which crash
   * the process while unhandled. Attach exactly one bounded handler per
   * destination object before its first use — it marks the destination
   * errored and accounts the loss, and never logs recursively.
   */
  const guard = (dest: Writable): void => {
    if (guardedDests.has(dest)) return;
    guardedDests.add(dest);
    dest.on("error", () => {
      erroredDests.add(dest);
      pendingDrops += 1;
    });
  };

  return new Writable({
    write(chunk, _, callback) {
      try {
        const dest = getDest();
        guard(dest);

        // Early cheap rejection: a destination that is known unavailable or
        // too full to accept even one more byte will refuse this record, so
        // count it without decoding, formatting, or parsing the original.
        if (unavailable(dest) || dest.writableLength >= LOG_OUTPUT_MAX_QUEUED_BYTES) {
          pendingDrops += 1;
          callback();
          return;
        }

        // Input-byte pre-check: an oversized chunk is never decoded, parsed,
        // or rendered in this layer.
        const inputBytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));

        // Surface deferred drop accounting first. The counter is cleared only
        // when the notice itself wins admission; a failed notice keeps the
        // earlier drops accounted.
        if (pendingDrops > 0) {
          const reported = admit(
            dest,
            renderNotice({
              msg: `log output dropped ${pendingDrops} record(s) while the destination was stalled, over capacity, or failing`,
              droppedRecords: pendingDrops,
            }),
          );
          if (reported) pendingDrops = 0;
        }

        if (inputBytes > LOG_OUTPUT_MAX_RECORD_BYTES) {
          // Oversized original: replaced by a bounded summary admitted on its
          // own budget; if even the summary cannot go out, the record counts
          // as dropped.
          const summarized = admit(
            dest,
            renderNotice({
              msg: `log record of ${inputBytes} bytes exceeded the ${LOG_OUTPUT_MAX_RECORD_BYTES}-byte cap and was replaced`,
              recordBytes: inputBytes,
            }),
          );
          if (!summarized) pendingDrops += 1;
        } else {
          const text = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
          let rendered: string;
          if (options.getFormat() === "pretty") {
            try {
              rendered = formatPrettyEntry(text);
            } catch {
              // Non-JSON line (or formatter bug): fall back to the raw,
              // already size-capped text.
              rendered = text;
            }
          } else {
            rendered = text;
          }
          // Post-format bound: pretty rendering may differ from the input
          // size, so the cap is enforced again on what would actually be
          // written.
          const renderedBytes = Buffer.byteLength(rendered);
          if (renderedBytes > LOG_OUTPUT_MAX_RECORD_BYTES) {
            const summarized = admit(
              dest,
              renderNotice({
                msg: `formatted log record of ${renderedBytes} bytes exceeded the ${LOG_OUTPUT_MAX_RECORD_BYTES}-byte cap and was replaced`,
                recordBytes: renderedBytes,
              }),
            );
            if (!summarized) pendingDrops += 1;
          } else if (admit(dest, rendered)) {
            // Only admitted records are parsed and bridged.
            if (options.onJsonEntry) {
              try {
                const obj = JSON.parse(text) as Record<string, unknown>;
                options.onJsonEntry(obj);
              } catch {
                // non-JSON line, ignore
              }
            }
          } else {
            pendingDrops += 1;
          }
        }
      } catch {
        // A getter or formatter failure discards the record without touching
        // a destination — account it honestly; the callback below still
        // acknowledges the chunk.
        pendingDrops += 1;
      }
      callback();
    },
  });
}
