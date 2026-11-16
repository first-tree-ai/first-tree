/**
 * Hooks that enrich the HTTP root span emitted by
 * `@autotelic/fastify-opentelemetry` with our domain-specific attributes.
 *
 * `@autotelic/fastify-opentelemetry` decorates every request with
 * `request.openTelemetry()` returning `{ activeSpan, context, tracer, ... }`
 * — `activeSpan` is the single root span for the request, ended on
 * `onResponse`. Reading it here is preferable to `trace.getActiveSpan()`,
 * which inside hooks can return whatever transient async-context span the
 * runtime happens to be inside (a previously-leaked source of bugs where
 * `user.id` etc. landed on a hook wrapper span instead of the route row).
 */

import { FIRST_TREE_ATTR, redactCredentialText } from "@first-tree/shared/observability";
import type { Span } from "@opentelemetry/api";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isSensitiveKey, normalizeAttrs } from "./otel-helpers.js";

type AutotelicAccessor = () => { activeSpan: Span | null; tracer: unknown; context: unknown };

/**
 * Read the HTTP root span off the request via the autotelic plugin's
 * `request.openTelemetry()` decorator. Returns `undefined` if the plugin
 * isn't loaded or the route opted out — in either case downstream hooks
 * become no-ops and never accidentally write to a stray async-context span.
 */
function rootSpanOf(request: FastifyRequest): Span | undefined {
  const r = request as FastifyRequest & { openTelemetry?: AutotelicAccessor };
  if (typeof r.openTelemetry !== "function") return undefined;
  try {
    return r.openTelemetry().activeSpan ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Tag the HTTP root span with the authenticated identity. Reads
 * `request.user` (set by `userAuthHook`) and `request.agent` (set by
 * `agentSelectorHook`); skips fields that aren't populated, so it's safe to
 * register on routes where one or both upstream hooks did not run.
 *
 * Org / member / role attributes flow through `stampOrgScope` from the
 * scope helpers (`requireOrgMembership`, `requireAgentAccess`, …) — the
 * JWT no longer carries them, and stamping on the auth hook would require
 * duplicating the per-request DB lookup the scope helpers already do.
 */
export async function attachRequestContext(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const span = rootSpanOf(request);
  if (!span) return;

  if (request.user) {
    span.setAttribute(FIRST_TREE_ATTR.USER_ID, request.user.userId);
  }

  if (request.agent) {
    span.setAttribute(FIRST_TREE_ATTR.AGENT_ID, request.agent.uuid);
    if (request.agent.clientId) {
      span.setAttribute(FIRST_TREE_ATTR.CLIENT_ID, request.agent.clientId);
    }
    span.setAttribute("agent.inbox_id", request.agent.inboxId);
  }
}

/**
 * Stamp the resolved org membership onto the HTTP root span. Called from
 * every scope helper (`requireOrgMembership`, `requireOrgAdmin`,
 * `requireAgentAccess`, `requireChatAccess`) after the DB lookup succeeds.
 *
 * Centralizing here (vs duplicating `span.setAttribute` calls in each scope
 * helper) keeps the attribute-key namespace consistent and lets us add new
 * tags (e.g. plan tier) in one place.
 */
export function stampOrgScope(
  request: FastifyRequest,
  scope: { organizationId: string; memberId: string; role: string },
): void {
  const span = rootSpanOf(request);
  if (!span) return;
  span.setAttribute(FIRST_TREE_ATTR.ORGANIZATION_ID, scope.organizationId);
  span.setAttribute(FIRST_TREE_ATTR.MEMBER_ID, scope.memberId);
  span.setAttribute(FIRST_TREE_ATTR.USER_ROLE, scope.role);
}

/**
 * Stamp the resolved agent resource onto the HTTP root span. Called from
 * `requireAgentAccess` (Class C `/agents/:uuid/...` routes) so the span has
 * the agent identity even though `request.agent` is only set on Class D
 * runtime-self routes.
 */
export function stampAgentResource(
  request: FastifyRequest,
  agent: { uuid: string; inboxId: string; clientId?: string | null },
): void {
  const span = rootSpanOf(request);
  if (!span) return;
  span.setAttribute(FIRST_TREE_ATTR.AGENT_ID, agent.uuid);
  if (agent.clientId) {
    span.setAttribute(FIRST_TREE_ATTR.CLIENT_ID, agent.clientId);
  }
  span.setAttribute("agent.inbox_id", agent.inboxId);
}

/**
 * Stamp the resolved client resource onto the HTTP root span. Client resource
 * routes carry `:clientId` directly in the URL rather than through the agent
 * selector, so they use this helper instead of `request.agent`.
 */
export function stampClientResource(request: FastifyRequest, clientId: string): void {
  const span = rootSpanOf(request);
  if (!span) return;
  span.setAttribute(FIRST_TREE_ATTR.CLIENT_ID, clientId);
}

/** Record bounded Context activation telemetry without emitting local project identity. */
export function stampContextActivation(
  request: FastifyRequest,
  input: {
    outcome: string;
    contractVersion: number;
    latencyMs: number;
    reasonCode?: string;
  },
): void {
  const span = rootSpanOf(request);
  if (!span) return;
  span.setAttribute("context.activation.outcome", input.outcome);
  span.setAttribute("context.activation.contract_version", input.contractVersion);
  span.setAttribute("context.activation.latency_ms", Math.round(input.latencyMs));
  if (input.reasonCode) span.setAttribute("context.activation.reason_code", input.reasonCode);
}

/**
 * Stamp the resolved chat resource onto the HTTP root span. Called from
 * `requireChatAccess` (Class C `/chats/:chatId/...` routes).
 */
export function stampChatResource(request: FastifyRequest, chat: { id: string; type: string }): void {
  const span = rootSpanOf(request);
  if (!span) return;
  span.setAttribute(FIRST_TREE_ATTR.CHAT_ID, chat.id);
  span.setAttribute(FIRST_TREE_ATTR.CHAT_TYPE, chat.type);
}

/**
 * Configure body capture for a route. Set `config: { otelRecordBody: true }`
 * on a route to enable the body capture onSend hook below for that route.
 */
declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * When true, `bodyCaptureOnSendHook` records the parsed `request.body`
     * and `request.query` onto the active OTel span — but **only** when the
     * response status is >= 400, so the success path stays slim.
     * Sensitive keys (`token`, `password`, etc.) are redacted by
     * `normalizeAttrs` via `TRACING_SENSITIVE_KEY_PATTERNS`.
     */
    otelRecordBody?: boolean;
  }
}

/**
 * Maximum serialized body length attached to a span. 4 KiB is enough to see
 * the structure of any JSON request our APIs accept; longer payloads (like
 * file uploads) are truncated with a `…[truncated N chars]` marker.
 */
const MAX_BODY_ATTR_LEN = 4096;

/**
 * Key names that carry a credential inside a nested object.
 *
 * `isSensitiveKey` matches the tracing vocabulary by substring, which misses
 * hyphenated header names (`x-api-key`); normalising separators out closes that
 * without widening the shared pattern list used for attribute keys.
 */
function isCredentialKeyName(key: string): boolean {
  if (isSensitiveKey(key)) return true;
  const normalized = key.toLowerCase().replace(/[-_.\s]/gu, "");
  return /apikey|authorization|credential|password|secret|token/u.test(normalized);
}

/** Longest string leaf the text scrubber walks; the attribute is cut to 4 KiB anyway. */
const MAX_SCRUBBED_LEAF_LEN = 8 * 1024;

/**
 * Bounds on the recursive walk. The leaf limit caps each string, but not the
 * number of strings: a client controls this body, so a deeply nested or very
 * wide payload could otherwise spend unbounded time (and stack) on a failing
 * request, and the result would then be handed to `JSON.stringify` in full.
 *
 * Three budgets are therefore shared by one walk: nodes visited, characters
 * carried, and depth. All three **stop** the walk instead of only trimming its
 * output, so the structure handed to serialization is bounded by construction
 * rather than by whatever `JSON.stringify` then produces.
 */
const MAX_SCRUB_DEPTH = 8;
const MAX_SCRUB_STEPS = 2_000;
const MAX_SCRUB_CHARS = 64 * 1024;
const SCRUB_OMITTED = "…[omitted]";
/** Reserved key for the single truncation marker inside an object. */
const SCRUB_OMITTED_KEY = "…";

/** Shared redaction budget: nodes visited, and characters of string content. */
export type ScrubBudget = { steps: number; chars: number };

export function createScrubBudget(): ScrubBudget {
  return { steps: MAX_SCRUB_STEPS, chars: MAX_SCRUB_CHARS };
}

/**
 * Redact a request body recursively. Three passes over each object level:
 * a sensitive key name masks its value, a `sensitive: true` sibling marks the
 * neighbouring `value` (the agent-env shape), and every remaining string leaf
 * goes through the shared text scrubber. Applied before `normalizeAttrs` so its
 * `***` placeholders are not themselves rewritten.
 *
 * The walk is bounded by depth, visited nodes **and** carried characters. When a
 * budget is spent the container stops growing and gets one omission marker; keys
 * after that point are never read, so a credential parked behind them is never
 * reached either.
 */
export function scrubCredentialStrings(value: unknown, depth = 0, budget: ScrubBudget = createScrubBudget()): unknown {
  if (budget.steps <= 0 || budget.chars <= 0) return SCRUB_OMITTED;
  budget.steps -= 1;
  if (typeof value === "string") {
    const allowance = Math.min(MAX_SCRUBBED_LEAF_LEN, budget.chars);
    budget.chars -= Math.min(value.length, allowance);
    if (value.length <= allowance) return redactCredentialText(value);
    const head = redactCredentialText(value.slice(0, allowance));
    return `${head}…[scrubbed ${value.length - allowance} chars]`;
  }
  if (!Array.isArray(value) && (!value || typeof value !== "object")) return value;
  if (depth >= MAX_SCRUB_DEPTH) return SCRUB_OMITTED;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    // Indexed loop, not `map`: `map` visits every element, so a 20 000-element
    // array would still be walked after the budget was gone.
    for (let index = 0; index < value.length; index += 1) {
      if (budget.steps <= 0 || budget.chars <= 0) {
        out.push(SCRUB_OMITTED);
        break;
      }
      out.push(scrubCredentialStrings(value[index], depth + 1, budget));
    }
    return out;
  }

  const record = value as Record<string, unknown>;
  const markedSensitive = record.sensitive === true;
  const out: Record<string, unknown> = {};
  // `for…in` walks own keys lazily; `Object.entries` would allocate the whole
  // entry list for a body that is about to be cut short anyway.
  for (const key in record) {
    if (!Object.hasOwn(record, key)) continue;
    if (budget.steps <= 0 || budget.chars <= 0) {
      out[SCRUB_OMITTED_KEY] = SCRUB_OMITTED;
      break;
    }
    if (isCredentialKeyName(key) || (markedSensitive && key === "value")) {
      out[key] = "***";
      continue;
    }
    out[key] = scrubCredentialStrings(record[key], depth + 1, budget);
  }
  return out;
}

/**
 * onSend hook that records redacted request body / query string for
 * routes that opted in via `config.otelRecordBody`. Records on **failures
 * only** (`statusCode >= 400`) so the production path doesn't pay a
 * permanent body-capture tax.
 *
 * Registered globally in `buildApp`; gated per-route by
 * `request.routeOptions.config?.otelRecordBody`.
 *
 * **Redaction is two-layered, and neither layer is schema-aware.**
 * `scrubCredentialStrings` runs the shared text scrubber over every string leaf,
 * which removes shaped credentials wherever they sit (vendor tokens, URL
 * userinfo, `Authorization:` headers, `token=…` pairs). `normalizeAttrs` then
 * masks values whose *key* is sensitive — top-level keys only, because a nested
 * object is serialised whole before it becomes an attribute.
 *
 * The gap that leaves: a nested value whose key is meaningless to the scrubber
 * and whose content carries no recognisable shape — `{ env: [{ key: "X",
 * value: "hunter2" }] }` — still survives. That is why the agent runtime-config
 * routes, whose bodies are exactly that shape, keep `otelRecordBody: false`
 * (SEC-018). Before opting a NEW route in, check whether its body can carry
 * credentials in a nested field; if it can, leave capture off. Logfire's own
 * scrubber (configured in `logfire-init.ts`) is a second-line defence on the
 * export side.
 */
export async function bodyCaptureOnSendHook(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  if (!request.routeOptions?.config?.otelRecordBody) return payload;
  if (reply.statusCode < 400) return payload;

  const span = rootSpanOf(request);
  if (!span) return payload;

  try {
    if (request.body && typeof request.body === "object") {
      // `normalizeAttrs` only knows top-level keys, so a credential nested inside
      // an array or object (agent `env[].value`, an MCP `Authorization` header)
      // survives it. Scrub the string leaves first with the shared text scrubber
      // (SEC-018): routes that carry credentials keep body capture off entirely,
      // and this covers the routes that stay enabled.
      //
      // The walk returns a structure whose string content is already bounded
      // (nodes, characters and depth), so `JSON.stringify` below receives a
      // bounded input instead of a client-sized one. The 4 KiB cut is a second,
      // stricter bound on what reaches the span.
      const redacted = normalizeAttrs(scrubCredentialStrings(request.body) as Record<string, unknown>);
      const serialized = JSON.stringify(redacted);
      span.setAttribute(
        FIRST_TREE_ATTR.HTTP_REQUEST_BODY,
        serialized.length <= MAX_BODY_ATTR_LEN
          ? serialized
          : `${serialized.slice(0, MAX_BODY_ATTR_LEN)}…[truncated ${serialized.length - MAX_BODY_ATTR_LEN} chars]`,
      );
    }

    if (request.query && typeof request.query === "object" && Object.keys(request.query).length > 0) {
      const redacted = normalizeAttrs(request.query as Record<string, unknown>);
      for (const [k, v] of Object.entries(redacted)) {
        span.setAttribute(`http.query.${k}`, v as string | number | boolean);
      }
    }
  } catch {
    // Diagnostic capture must never change the response the client was going to
    // get: this hook runs in the onSend chain, so a throw here would replace a
    // 4xx with a 500 (or drop the body) for a telemetry bug.
    return payload;
  }

  return payload;
}

/**
 * Stamp an exception + attributes onto the HTTP root span via the autotelic
 * decorator. Invariant: only call from inside fastify hook chains
 * (errorHandler / onSend / onError) where `request.openTelemetry()` is
 * decorated and the root span has not yet been ended.
 */
export function reportErrorToRoot(
  request: FastifyRequest,
  message: string,
  err: unknown,
  extra?: Record<string, unknown>,
): void {
  const span = rootSpanOf(request);
  if (!span) return;
  const error = err instanceof Error ? err : err !== undefined ? new Error(String(err)) : new Error(message);
  span.recordException(error);
  // Note: autotelic's onResponse will overwrite OK status iff statusCode<500;
  // we still record the exception+attrs so the failure surfaces in trace
  // backends as an exception event.
  if (extra) span.setAttributes(normalizeAttrs(extra));
}
