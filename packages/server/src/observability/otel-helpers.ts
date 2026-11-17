/**
 * Thin helpers that wrap the public OpenTelemetry API for service-layer use.
 *
 * Why not just use the OTel API directly: business code wants three idioms
 * over and over —
 *   1. wrap an async fn in a span and auto-record exceptions (`withSpan`),
 *   2. start a span that must be ended manually (`startTrackedSpan` + `endSpan`),
 *   3. attach an error to the currently-active span (`reportError`).
 * Encoding these here gives a small, stable surface, normalises attribute
 * scrubbing on the way in, and means the rest of the codebase never imports
 * `@opentelemetry/api` directly.
 *
 * The Logfire SDK (configured in `logfire-init.ts`) registers a global
 * `TracerProvider`; everything below resolves through `trace.getTracer(...)`
 * so the wiring is automatic. When tracing is disabled (no token / endpoint),
 * the global provider is a no-op tracer and every helper degrades to running
 * `fn()` unwrapped — business code pays no cost.
 */

import { TRACING_SENSITIVE_KEY_PATTERNS } from "@first-tree/shared/observability";
import {
  type Attributes,
  type Context,
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { setErrorSink } from "./logger.js";

const TRACER_NAME = "@first-tree/server";
const TRACER_VERSION = "0.1.0";

/**
 * Resolve the shared `@first-tree/server` tracer with a stable
 * `instrumentation_scope.version` attached. Exported so other modules in
 * this package (e.g. `ws-tracing.ts`) emit spans under the same
 * `(name, version)` cache slot — otherwise trace backends see two distinct
 * instrumentation scopes for the same logical scope.
 */
export function getServerTracer() {
  return trace.getTracer(TRACER_NAME, TRACER_VERSION);
}

function tracer() {
  return getServerTracer();
}

// ─── Attribute normalisation + redaction ──────────────────────────────

export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return TRACING_SENSITIVE_KEY_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Project arbitrary `Record<string, unknown>` payloads (log context, request
 * body, etc.) onto OTel `Attributes`. Sensitive keys are replaced with
 * `***`; objects are JSON-stringified; nullish entries are dropped. Logfire
 * runs its own scrubber on top of this — we do it here too because some
 * call sites attach attributes to spans we create, not via Logfire's
 * exporter, so the scrubber wouldn't see them.
 */
export function normalizeAttrs(attrs?: Record<string, unknown>): Attributes {
  if (!attrs) return {};
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (isSensitiveKey(k)) {
      out[k] = "***";
      continue;
    }
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      out[k] = v;
    } else {
      try {
        out[k] = JSON.stringify(v);
      } catch {
        out[k] = String(v);
      }
    }
  }
  return out;
}

// ─── Span facade ──────────────────────────────────────────────────────

/** Wrap an async function as a span. Records exceptions automatically. */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, unknown> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes: normalizeAttrs(attrs) }, async (span) => {
    try {
      const result = await fn();
      span.end();
      return result;
    } catch (err) {
      if (err instanceof Error) {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      }
      span.end();
      throw err;
    }
  });
}

/**
 * Start a span that must be ended manually. Useful for connection-lifecycle
 * or hook-pair patterns where the end point is not a lexical callback.
 *
 * If the caller does not intend to make the span the active context for
 * nested work, omit `makeActive`. When `makeActive=true`, pass the returned
 * `context` to `context.with(...)` for nested spans to auto-parent.
 */
export function startTrackedSpan(
  name: string,
  attrs?: Record<string, unknown>,
  options?: { kind?: SpanKind; parentContext?: Context },
): Span {
  const parent = options?.parentContext ?? context.active();
  return tracer().startSpan(name, { kind: options?.kind, attributes: normalizeAttrs(attrs) }, parent);
}

export function endSpan(span: Span | null | undefined, extraAttrs?: Record<string, unknown>, error?: Error): void {
  if (!span) return;
  if (extraAttrs) span.setAttributes(normalizeAttrs(extraAttrs));
  if (error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  }
  span.end();
}

export function addSpanEvent(span: Span | null | undefined, name: string, attrs?: Record<string, unknown>): void {
  if (!span) return;
  span.addEvent(name, normalizeAttrs(attrs));
}

/**
 * Record an error onto the currently-active span. Safe inside service-layer
 * `withSpan` callbacks (where the active span is the one we just opened).
 *
 * Inside Fastify HTTP handlers / hooks, prefer
 * `request.openTelemetry().activeSpan` — that always points at the HTTP
 * root span emitted by `@autotelic/fastify-opentelemetry` rather than
 * whatever transient span the current async chain happens to be running in.
 */
export function reportError(message: string, err: unknown, extra?: Record<string, unknown>): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  const error = err instanceof Error ? err : err !== undefined ? new Error(String(err)) : new Error(message);
  span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  if (extra) span.setAttributes(normalizeAttrs(extra));
}

/** Current trace id, if any — used for `x-trace-id` response header. */
export function currentTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  const ctx = span?.spanContext();
  if (!ctx || !ctx.traceId || ctx.traceId === "00000000000000000000000000000000") return undefined;
  return ctx.traceId;
}

/** Current span id, if any — used for log correlation. */
export function currentSpanId(): string | undefined {
  const span = trace.getActiveSpan();
  const ctx = span?.spanContext();
  if (!ctx || !ctx.spanId || ctx.spanId === "0000000000000000") return undefined;
  return ctx.spanId;
}

/**
 * Wire pino's `error` / `fatal` log records onto the currently-active span
 * as exception events. Mirrors the bridge previously installed inside
 * `initTelemetry`; called once from `logfire-init.ts` after the SDK is up.
 */
export function installPinoErrorBridge(): void {
  setErrorSink((message, err, ctx) => {
    const span = trace.getActiveSpan();
    if (!span) return;
    const error = err instanceof Error ? err : err !== undefined ? new Error(String(err)) : new Error(message);
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    const attrs = normalizeAttrs(ctx);
    if (Object.keys(attrs).length > 0) span.setAttributes(attrs);
  });
}

export function uninstallPinoErrorBridge(): void {
  setErrorSink(null);
}

/** Re-export for consumers that want to drive `context.with(...)` themselves. */
export { context, propagation, SpanKind, SpanStatusCode, trace };
