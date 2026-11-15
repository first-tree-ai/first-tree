/**
 * Span behaviour tests with an in-memory exporter.
 *
 * Why a separate file from `otel-init.test.ts`: this suite installs a real
 * `BasicTracerProvider` + `InMemorySpanExporter` as the global tracer
 * provider. The `otel-init.test.ts` lifecycle tests deliberately stay in the
 * "no global provider" world so they exercise the noop fallback. Mixing the
 * two in one file would either leave a dirty global between tests or force
 * fragile ordering.
 *
 * Goal: regression-protect the contracts our error-path observability
 * relies on, without booting the real Logfire SDK (whose 30s flush timeout
 * makes lifecycle tests slow + flaky in CI).
 */

import { FIRST_TREE_ATTR } from "@first-tree/shared/observability";
import { context as otelContext, type Span, trace } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { FastifyReply, FastifyRequest } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { applyLoggerConfig, createLogger } from "../logger.js";
import {
  addSpanEvent,
  currentSpanId,
  currentTraceId,
  endSpan,
  installPinoErrorBridge,
  reportError,
  SpanKind,
  startTrackedSpan,
  uninstallPinoErrorBridge,
  withSpan,
} from "../otel-helpers.js";
import {
  attachRequestContext,
  bodyCaptureOnSendHook,
  stampAgentResource,
  stampClientResource,
} from "../request-context.js";
import { endWsConnectionSpan, startWsConnectionSpan, withWsMessageSpan } from "../ws-tracing.js";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
// `BasicTracerProvider` registers a TracerProvider but not a ContextManager.
// Without one the OTel API's `context.active()` always returns ROOT_CONTEXT,
// so `tracer.startActiveSpan(...)` cannot make its span the active span in
// the callback — `currentTraceId()` would always be undefined. The full Node
// SDK installs `AsyncHooksContextManager` for us; here we install it
// manually so the API contract under test matches production.
const contextManager = new AsyncHooksContextManager();

beforeAll(() => {
  contextManager.enable();
  otelContext.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  otelContext.disable();
  contextManager.disable();
});

beforeEach(() => {
  exporter.reset();
});

function makeRequestWithRootSpan(span: Span, fields: Record<string, unknown> = {}): FastifyRequest {
  return {
    ...fields,
    openTelemetry: () => ({ activeSpan: span, tracer: null, context: otelContext.active() }),
  } as unknown as FastifyRequest;
}

function findFinishedSpan(traceId: string): ReadableSpan {
  const finished = exporter.getFinishedSpans().find((s) => s.spanContext().traceId === traceId);
  if (!finished) throw new Error("expected matching finished span, got none");
  return finished;
}

describe("currentTraceId / currentSpanId", () => {
  it("return undefined when no span is active", () => {
    // Outside any `tracer.startActiveSpan` callback the OTel context has no
    // span, so both helpers must report `undefined` (not "" / not the
    // sentinel "00000000…00") — `app.ts` and `request-context.ts` rely on
    // that to skip stamping `x-trace-id` headers / response bodies when
    // there is no real trace to point at.
    expect(currentTraceId()).toBeUndefined();
    expect(currentSpanId()).toBeUndefined();
  });

  it("return the active trace + span ids inside a `withSpan` callback", async () => {
    let captured: { traceId?: string; spanId?: string } | undefined;
    await withSpan("test-current-ids", undefined, async () => {
      captured = { traceId: currentTraceId(), spanId: currentSpanId() };
    });
    expect(captured?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(captured?.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("withSpan exception recording", () => {
  it("records the thrown error as an exception event and re-throws", async () => {
    const boom = new Error("kaboom");
    await expect(
      withSpan("test-throw", undefined, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    if (!span) throw new Error("unreachable: length asserted above");
    expect(span.name).toBe("test-throw");
    // OTel's `recordException` emits a single span event named "exception"
    // carrying `exception.type` / `exception.message` attributes. Asserting
    // the event presence + payload is what guarantees the trace backend
    // (Logfire / Honeycomb / Tempo) can render the failure as an error
    // even though autotelic resets 4xx span status to OK on the way out.
    const exceptionEvents = span.events.filter((e) => e.name === "exception");
    expect(exceptionEvents).toHaveLength(1);
    expect(exceptionEvents[0]?.attributes?.["exception.type"]).toBe("Error");
    expect(exceptionEvents[0]?.attributes?.["exception.message"]).toBe("kaboom");
    expect(span.status.code).toBe(2 /* SpanStatusCode.ERROR */);
  });
});

describe("manual span helpers", () => {
  it("records events, attributes, and errors on manually tracked spans", () => {
    const span = startTrackedSpan("manual-span", { password: "secret", count: 1 }, { kind: SpanKind.INTERNAL });
    const traceId = span.spanContext().traceId;

    addSpanEvent(span, "checkpoint", { token: "abc", labels: ["a", "b"], payload: { ok: true } });
    endSpan(span, { apiKey: "key", done: true }, new Error("manual failure"));
    expect(() => addSpanEvent(null, "ignored")).not.toThrow();
    expect(() => endSpan(undefined)).not.toThrow();

    const finished = findFinishedSpan(traceId);
    expect(finished.name).toBe("manual-span");
    expect(finished.kind).toBe(SpanKind.INTERNAL);
    expect(finished.attributes.password).toBe("***");
    expect(finished.attributes.count).toBe(1);
    expect(finished.attributes.apiKey).toBe("***");
    expect(finished.attributes.done).toBe(true);
    expect(finished.events.some((event) => event.name === "checkpoint")).toBe(true);
    expect(finished.events.some((event) => event.name === "exception")).toBe(true);
    expect(finished.status.message).toBe("manual failure");
  });

  it("reports non-Error values onto the active span", async () => {
    expect(() => reportError("outside", undefined)).not.toThrow();

    let traceId = "";
    await withSpan("report-error", undefined, async () => {
      const active = trace.getActiveSpan();
      if (!active) throw new Error("expected active span");
      traceId = active.spanContext().traceId;
      reportError("fallback message", "string failure", { refreshToken: "secret", operation: "test" });
    });

    const finished = findFinishedSpan(traceId);
    expect(finished.status.message).toBe("string failure");
    expect(finished.attributes.refreshToken).toBe("***");
    expect(finished.attributes.operation).toBe("test");
    expect(finished.events.some((event) => event.attributes?.["exception.message"] === "string failure")).toBe(true);
  });

  it("bridges pino error logs onto the active span", async () => {
    const logger = createLogger("OtelBridgeTest");
    let traceId = "";
    applyLoggerConfig({ level: "trace", format: "json", bridgeToSpanLevel: "error" });
    installPinoErrorBridge();
    try {
      logger.error({ requestId: "outside" }, "outside active span");
      await withSpan("pino-error-bridge", undefined, async () => {
        const active = trace.getActiveSpan();
        if (!active) throw new Error("expected active span");
        traceId = active.spanContext().traceId;
        logger.error({ err: "logged failure", password: "secret", requestId: "req-1" }, "bridge failure");
        await new Promise((resolve) => setImmediate(resolve));
      });
    } finally {
      uninstallPinoErrorBridge();
    }

    const finished = findFinishedSpan(traceId);
    expect(finished.status.message).toBe("logged failure");
    expect(finished.attributes.password).toBe("***");
    expect(finished.attributes.requestId).toBe("req-1");
    expect(finished.attributes.module).toBe("OtelBridgeTest");
    expect(finished.events.some((event) => event.attributes?.["exception.message"] === "logged failure")).toBe(true);
  });
});

describe("request context span attributes", () => {
  it("no-ops when the autotelic accessor throws", async () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("http-autotelic-throws");
    const traceId = span.spanContext().traceId;
    const request = {
      user: { userId: "user-throw" },
      openTelemetry: () => {
        throw new Error("decorator failed");
      },
    } as unknown as FastifyRequest;

    await attachRequestContext(request, {} as FastifyReply);
    span.end();

    expect(findFinishedSpan(traceId).attributes[FIRST_TREE_ATTR.USER_ID]).toBeUndefined();
  });

  it("stamps client id from the selected agent identity", async () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("http-agent");
    const traceId = span.spanContext().traceId;

    const request = makeRequestWithRootSpan(span, {
      user: { userId: "user-1" },
      agent: {
        uuid: "agent-1",
        name: "developer",
        organizationId: "org-1",
        inboxId: "inbox-1",
        clientId: "client-1",
      },
    });

    await attachRequestContext(request, {} as FastifyReply);
    span.end();

    const finished = findFinishedSpan(traceId);
    expect(finished.attributes[FIRST_TREE_ATTR.USER_ID]).toBe("user-1");
    expect(finished.attributes[FIRST_TREE_ATTR.AGENT_ID]).toBe("agent-1");
    expect(finished.attributes[FIRST_TREE_ATTR.CLIENT_ID]).toBe("client-1");
    expect(finished.attributes["agent.inbox_id"]).toBe("inbox-1");
  });

  it("stamps client id from agent and client resource helpers", () => {
    const tracer = trace.getTracer("test");

    const agentSpan = tracer.startSpan("http-agent-resource");
    const agentTraceId = agentSpan.spanContext().traceId;
    stampAgentResource(makeRequestWithRootSpan(agentSpan), {
      uuid: "agent-2",
      inboxId: "inbox-2",
      clientId: "client-2",
    });
    agentSpan.end();

    const clientSpan = tracer.startSpan("http-client-resource");
    const clientTraceId = clientSpan.spanContext().traceId;
    stampClientResource(makeRequestWithRootSpan(clientSpan), "client-3");
    clientSpan.end();

    const agentFinished = findFinishedSpan(agentTraceId);
    expect(agentFinished.attributes[FIRST_TREE_ATTR.AGENT_ID]).toBe("agent-2");
    expect(agentFinished.attributes[FIRST_TREE_ATTR.CLIENT_ID]).toBe("client-2");

    const clientFinished = findFinishedSpan(clientTraceId);
    expect(clientFinished.attributes[FIRST_TREE_ATTR.CLIENT_ID]).toBe("client-3");
  });
});

describe("bodyCaptureOnSendHook", () => {
  // Build a minimal FastifyRequest stand-in with `openTelemetry()` returning
  // `activeSpan: <span>`. autotelic's full decorator surface isn't needed —
  // the hook only reads `activeSpan`.
  function makeRequestWith(
    span: Span,
    routeConfig: Record<string, unknown> | undefined,
    body: unknown,
    query?: Record<string, unknown>,
  ): FastifyRequest {
    return {
      routeOptions: { config: routeConfig },
      body,
      query,
      openTelemetry: () => ({ activeSpan: span, tracer: null, context: otelContext.active() }),
    } as unknown as FastifyRequest;
  }

  function makeReply(statusCode: number): FastifyReply {
    return { statusCode } as unknown as FastifyReply;
  }

  function findFinished(traceId: string): ReadableSpan {
    const finished = exporter.getFinishedSpans().find((s) => s.spanContext().traceId === traceId);
    if (!finished) throw new Error("expected matching finished span, got none");
    return finished;
  }

  it("redacts sensitive top-level keys before stamping http.request.body", async () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("t");
    const traceId = span.spanContext().traceId;

    const req = makeRequestWith(
      span,
      { otelRecordBody: true },
      { username: "alice", password: "hunter2", refreshToken: "eyJabc.def.ghi", remember: true },
    );
    await bodyCaptureOnSendHook(req, makeReply(401), null);
    span.end();

    const attrs = findFinished(traceId).attributes;
    const raw = attrs[FIRST_TREE_ATTR.HTTP_REQUEST_BODY];
    expect(typeof raw).toBe("string");
    const decoded = JSON.parse(raw as string) as Record<string, unknown>;
    expect(decoded.username).toBe("alice");
    expect(decoded.remember).toBe(true);
    expect(decoded.password).toBe("***");
    expect(decoded.refreshToken).toBe("***");
  });

  it("scrubs credentials nested inside arrays and objects", async () => {
    // SEC-018: a top-level-only key match cannot see `env[].value` or an MCP
    // header buried in an array element, so the serialized body is passed
    // through the shared credential scrubber as well.
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("t");
    const traceId = span.spanContext().traceId;

    const req = makeRequestWith(
      span,
      { otelRecordBody: true },
      {
        env: [
          { key: "OPENAI_API_KEY", value: `sk-proj-${"z".repeat(30)}`, sensitive: true },
          { key: "PLAIN", value: "visible" },
          // Shapeless secret: only the `sensitive: true` sibling identifies it.
          { key: "DB_PASSWORD", value: "hunter2", sensitive: true },
        ],
        mcpServers: [
          { name: "tools", headers: { authorization: "Bearer abcdefgh12345678" } },
          { name: "other", headers: { "x-api-key": "plain-looking-secret" } },
        ],
      },
    );
    await bodyCaptureOnSendHook(req, makeReply(400), null);
    span.end();

    const raw = findFinished(traceId).attributes[FIRST_TREE_ATTR.HTTP_REQUEST_BODY] as string;
    expect(raw).not.toContain("sk-proj-");
    expect(raw).not.toContain("abcdefgh12345678");
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("plain-looking-secret");
    // Structure survives: the operator can still see which variable failed.
    const decoded = JSON.parse(raw) as { env: string; mcpServers: string };
    const env = JSON.parse(decoded.env) as Array<{ key: string; value: string }>;
    expect(env[0]?.key).toBe("OPENAI_API_KEY");
    expect(env[2]?.key).toBe("DB_PASSWORD");
    expect(env[2]?.value).toBe("***");
    // A non-sensitive value stays readable.
    expect(env[1]?.value).toBe("visible");
  });

  it("does not stamp the body when statusCode < 400 (success path)", async () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("t");
    const traceId = span.spanContext().traceId;

    const req = makeRequestWith(span, { otelRecordBody: true }, { password: "hunter2" });
    await bodyCaptureOnSendHook(req, makeReply(200), null);
    span.end();

    expect(findFinished(traceId).attributes[FIRST_TREE_ATTR.HTTP_REQUEST_BODY]).toBeUndefined();
  });

  it("does not stamp the body when the route did not opt in", async () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("t");
    const traceId = span.spanContext().traceId;

    const req = makeRequestWith(span, undefined, { password: "hunter2" });
    await bodyCaptureOnSendHook(req, makeReply(401), null);
    span.end();

    expect(findFinished(traceId).attributes[FIRST_TREE_ATTR.HTTP_REQUEST_BODY]).toBeUndefined();
  });

  it("truncates the body attribute to ~4 KiB with a clear marker", async () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("t");
    const traceId = span.spanContext().traceId;

    // 6 KiB of harmless filler — exceeds MAX_BODY_ATTR_LEN (4 KiB).
    const padding = "a".repeat(6 * 1024);
    const req = makeRequestWith(span, { otelRecordBody: true }, { note: padding });
    await bodyCaptureOnSendHook(req, makeReply(500), null);
    span.end();

    const raw = findFinished(traceId).attributes[FIRST_TREE_ATTR.HTTP_REQUEST_BODY] as string;
    expect(typeof raw).toBe("string");
    expect(raw.length).toBeGreaterThan(4096);
    expect(raw.length).toBeLessThan(4096 + 64); // 4 KiB + a small "[truncated …]" marker
    expect(raw).toMatch(/\[truncated \d+ chars\]$/);
  });

  it("stamps redacted query attributes on opted-in failures", async () => {
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("t");
    const traceId = span.spanContext().traceId;

    const req = makeRequestWith(span, { otelRecordBody: true }, null, {
      token: "secret",
      page: 2,
      active: true,
    });
    await bodyCaptureOnSendHook(req, makeReply(400), "payload");
    span.end();

    const attrs = findFinished(traceId).attributes;
    expect(attrs["http.query.token"]).toBe("***");
    expect(attrs["http.query.page"]).toBe(2);
    expect(attrs["http.query.active"]).toBe(true);
  });
});

describe("ws-tracing with spans enabled", () => {
  it("records handler errors on the message span and rethrows", async () => {
    const socket = {} as WebSocket;

    startWsConnectionSpan(socket, { clientId: "client-1", organizationId: "org-1" });
    await expect(
      withWsMessageSpan(socket, "session:event", { chatId: "chat-1" }, async () => {
        throw new Error("ws handler failed");
      }),
    ).rejects.toThrow("ws handler failed");
    endWsConnectionSpan(socket, 1000);

    const spans = exporter.getFinishedSpans();
    const messageSpan = spans.find((span) => span.name === "ws.message session:event");
    expect(messageSpan?.status.message).toBe("ws handler failed");
    expect(messageSpan?.events.some((event) => event.name === "exception")).toBe(true);
    expect(spans.find((span) => span.name === "ws.connection")?.attributes[FIRST_TREE_ATTR.WS_CLOSE_CODE]).toBe(1000);
  });
});
