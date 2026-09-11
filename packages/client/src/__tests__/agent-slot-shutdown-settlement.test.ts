import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_RUNTIME_SESSION_HEADER, encodeProviderRetryEventMessage } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstTreeHubSDK } from "../cloud/sdk.js";
import type { AgentHandler } from "../runtime/handler.js";
import { SessionRuntime } from "../runtime/session-runtime.js";
import { silentLogger } from "./_logger-helpers.js";
import { mockEntry } from "./test-helpers.js";

/**
 * Product-faithful drain settlement: prove that clearing the dynamic
 * runtime-session proof provider *before* SessionRuntime.shutdown() makes
 * notice HTTP authenticate with a stale bind-time token (QA FAIL mode), while
 * keeping the provider registered through drain authenticates with the current
 * proof and ACKs once (required repair).
 */

type NoticeRequest = {
  runtimeSessionToken: string | undefined;
  path: string;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<{
  server: Server;
  baseUrl: string;
}> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((err) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected tcp address");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function makeBoundSdk(opts: {
  serverUrl: string;
  agentId: string;
  providers: Map<string, () => string | undefined>;
  /** Bind-time capture — what the SDK falls back to after provider clear. */
  bindTimeToken: string;
}): FirstTreeHubSDK {
  // Mirrors ClientConnection agent:bound SDK construction.
  return new FirstTreeHubSDK({
    serverUrl: opts.serverUrl,
    getAccessToken: async () => "access-token",
    agentId: opts.agentId,
    runtimeSessionToken: () =>
      opts.providers.has(opts.agentId) ? opts.providers.get(opts.agentId)?.() : opts.bindTimeToken,
  });
}

function makeDeferredSettleHandler(opts: {
  onReleased: () => void;
  gate: Promise<void>;
  inFlight: { current: Promise<void> | null };
}): AgentHandler {
  return {
    start: async (message, ctx, token) => {
      let resolveInFlight: (() => void) | undefined;
      opts.inFlight.current = new Promise<void>((resolve) => {
        resolveInFlight = resolve;
      });
      try {
        token?.processingStarted([message]);
        opts.onReleased();
        await opts.gate;
        // Ordinary mutations must stay fenced during graceful drain.
        ctx.emitEvent({ kind: "assistant_text", payload: { text: "must-not-cross-drain" } });
        ctx.emitEvent({
          kind: "error",
          payload: {
            source: "runtime",
            message: encodeProviderRetryEventMessage({
              event: "provider_failure_terminal",
              provider: "pi",
              scope: "provider_turn",
              category: "unknown",
              reasonCode: "unsafe_replay",
              replaySafety: "unsafe",
              userSeverity: "error",
              messagePreview: "drain settle after provider entry",
            }),
          },
        });
        if (!token) throw new Error("expected delivery token");
        await token.complete([message], {
          status: "error",
          completion: "consumed",
          reason: "unsafe_replay",
        });
        return { sessionId: "sess-entered", route: { kind: "owned", mode: "processing" } };
      } finally {
        resolveInFlight?.();
      }
    },
    resume: async () => ({ sessionId: "unused", route: null }),
    inject: () => ({ kind: "rejected", reason: "no_active_context", retryable: true }),
    suspend: async () => {},
    shutdown: async () => {
      // Caller releases the gate; join the in-flight settle (notice+ACK).
      await opts.inFlight.current;
    },
  };
}

describe("AgentSlot/SessionRuntime shutdown settlement authority", () => {
  const roots: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("keeps dynamic runtime proof through drain so notice authenticates and ACK precedes provider clear", async () => {
    const STALE = "runtime-token-stale-bind";
    const CURRENT = "runtime-token-current-file";
    const notices: NoticeRequest[] = [];
    const rejected: NoticeRequest[] = [];

    const { server, baseUrl } = await listen(async (req, res) => {
      const runtimeSessionToken = req.headers[AGENT_RUNTIME_SESSION_HEADER.toLowerCase()] as string | undefined;
      // Runtime notices have their own route; the server authors the delivery
      // profile and the stored marker, so only the text is posted here.
      if (req.method === "POST" && req.url?.includes("/runtime-notices")) {
        await readBody(req);
        const record = { runtimeSessionToken, path: req.url ?? "" };
        if (runtimeSessionToken !== CURRENT) {
          rejected.push(record);
          res.statusCode = 401;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: { code: "RUNTIME_SESSION_INVALID", message: "stale runtime proof" } }));
          return;
        }
        notices.push(record);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id: "notice-1", chatId: "chat-drain-proof", content: "ok" }));
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    servers.push(server);

    const providers = new Map<string, () => string | undefined>();
    providers.set("agent-1", () => CURRENT);
    const sdk = makeBoundSdk({
      serverUrl: baseUrl,
      agentId: "agent-1",
      providers,
      bindTimeToken: STALE,
    });

    const workspaceRoot = mkdtempSync(join(tmpdir(), "slot-drain-proof-"));
    roots.push(workspaceRoot);
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    const clearProviderCalls: number[] = [];
    const unbindCalls: number[] = [];
    let releaseStart: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const inFlight = { current: null as Promise<void> | null };
    const sessionEvents: Array<{ kind: string }> = [];

    const sm = new SessionRuntime({
      session: {
        idle_timeout: 300,
        max_sessions: 10,
        working_grace_seconds: 3600,
        reconcile_interval_seconds: 300,
      },
      concurrency: 5,
      handlerFactory: () =>
        makeDeferredSettleHandler({
          onReleased: () => signalStarted?.(),
          gate,
          inFlight,
        }),
      handlerConfig: { workspaceRoot, runtimeProvider: "pi" },
      resolveContextTreeBinding: async () => null,
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
      ackEntry,
      registryPath: join(workspaceRoot, "sessions.json"),
      onSessionEvent: (_chatId, event) => void sessionEvents.push(event),
    });

    const dispatchPromise = sm.dispatch(
      mockEntry({
        id: 501,
        chatId: "chat-drain-proof",
        messageId: "msg-drain-proof",
        content: "run bash then sleep",
      }),
    );
    await started;

    // Production AgentSlot.stopOnce order after this repair:
    // 1) release/join handler settle via SM.shutdown (provider still registered)
    // 2) unbind
    // 3) clear provider + token file
    const shutdownPromise = (async () => {
      releaseStart?.();
      await sm.shutdown("agent_runtime_switch");
      unbindCalls.push(Date.now());
      providers.delete("agent-1");
      clearProviderCalls.push(Date.now());
    })();
    await Promise.all([shutdownPromise, dispatchPromise]);

    expect(rejected).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.runtimeSessionToken).toBe(CURRENT);
    expect(ackEntry).toHaveBeenCalledWith(501);
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(clearProviderCalls).toHaveLength(1);
    expect(unbindCalls).toHaveLength(1);
    expect(unbindCalls[0] as number).toBeLessThanOrEqual(clearProviderCalls[0] as number);
    expect(sessionEvents.some((event) => event.kind === "assistant_text")).toBe(false);
    expect(
      sessionEvents.some(
        (event) => event.kind === "error" && JSON.stringify(event).includes("provider_failure_terminal"),
      ),
    ).toBe(true);

    // Re-dispatch after ACK must not create a second settlement/ACK for the same entry.
    await sm.dispatch(
      mockEntry({
        id: 501,
        chatId: "chat-drain-proof",
        messageId: "msg-drain-proof",
        content: "run bash then sleep",
      }),
    );
    expect(ackEntry).toHaveBeenCalledTimes(1);
    expect(notices).toHaveLength(1);
  });

  it("control: clearing proof before drain authenticates with stale bind token and retains debt (no ACK)", async () => {
    const STALE = "runtime-token-stale-bind";
    const CURRENT = "runtime-token-current-file";
    const notices: NoticeRequest[] = [];
    const rejected: NoticeRequest[] = [];

    const { server, baseUrl } = await listen(async (req, res) => {
      const runtimeSessionToken = req.headers[AGENT_RUNTIME_SESSION_HEADER.toLowerCase()] as string | undefined;
      // Runtime notices have their own route; the server authors the delivery
      // profile and the stored marker, so only the text is posted here.
      if (req.method === "POST" && req.url?.includes("/runtime-notices")) {
        await readBody(req);
        const record = { runtimeSessionToken, path: req.url ?? "" };
        if (runtimeSessionToken !== CURRENT) {
          rejected.push(record);
          res.statusCode = 401;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: { code: "RUNTIME_SESSION_INVALID", message: "stale runtime proof" } }));
          return;
        }
        notices.push(record);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id: "notice-1", chatId: "chat-drain-stale", content: "ok" }));
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    });
    servers.push(server);

    const providers = new Map<string, () => string | undefined>();
    providers.set("agent-1", () => CURRENT);
    const sdk = makeBoundSdk({
      serverUrl: baseUrl,
      agentId: "agent-1",
      providers,
      bindTimeToken: STALE,
    });

    const workspaceRoot = mkdtempSync(join(tmpdir(), "slot-drain-stale-"));
    roots.push(workspaceRoot);
    const ackEntry = vi.fn<(entryId: number) => Promise<void>>().mockResolvedValue(undefined);
    let releaseStart: (() => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const inFlight = { current: null as Promise<void> | null };

    const sm = new SessionRuntime({
      session: {
        idle_timeout: 300,
        max_sessions: 10,
        working_grace_seconds: 3600,
        reconcile_interval_seconds: 300,
      },
      concurrency: 5,
      handlerFactory: () =>
        makeDeferredSettleHandler({
          onReleased: () => signalStarted?.(),
          gate,
          inFlight,
        }),
      handlerConfig: { workspaceRoot, runtimeProvider: "pi" },
      resolveContextTreeBinding: async () => null,
      agentIdentity: {
        agentId: "agent-1",
        inboxId: "inbox-agent-1",
        displayName: "Agent",
        type: "agent",
        visibility: "organization",
        delegateMention: null,
        metadata: {},
      },
      sdk,
      log: silentLogger(),
      ackEntry,
      registryPath: join(workspaceRoot, "sessions-stale.json"),
    });

    const dispatchPromise = sm.dispatch(
      mockEntry({
        id: 502,
        chatId: "chat-drain-stale",
        messageId: "msg-drain-stale",
        content: "run bash then sleep",
      }),
    );
    await started;

    // Pre-repair AgentSlot.stopOnce order — clears proof before SM.shutdown.
    providers.delete("agent-1");
    expect(sdk.runtimeSessionToken).toBe(STALE);

    releaseStart?.();
    await sm.shutdown("agent_runtime_switch");
    await dispatchPromise;

    expect(notices).toEqual([]);
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.every((entry) => entry.runtimeSessionToken === STALE)).toBe(true);
    // Fail-closed: notice persistence failure must not ACK the entered turn.
    expect(ackEntry).not.toHaveBeenCalled();
    expect(sm.totalCount).toBe(0);
  });
});
