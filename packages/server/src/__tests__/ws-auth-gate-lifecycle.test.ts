import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClientWsAuthGate } from "../api/agent/ws-client/auth.js";
import { attachClientWsConnection } from "../api/agent/ws-client/connection.js";

/**
 * Focused auth-lifecycle containment tests (staging incident 2026-09):
 * the client-WS auth gate must be single-attempt per connection and reach a
 * terminal state after timeout / rejection / close / handshake failure, so a
 * flood of duplicate auth frames — or late completions landing after the
 * socket is gone — cannot multiply DB queries, authentication side effects,
 * expiry timers, warnings, or close attempts.
 *
 * These tests are self-contained: a fake socket/context/app with a
 * controllable (deferred) user lookup stands in for the database; no live
 * services are touched.
 */

const TEST_SECRET = "ws-auth-gate-lifecycle-unit-secret";
const jwtSecretBytes = new TextEncoder().encode(TEST_SECRET);
const TEST_USER_ID = "01960000-0000-7000-8000-0000000000aa";

// Captured before fake timers install so tests can yield to the real event
// loop (WebCrypto JWT verification resolves off-thread; microtask-only
// flushing never delivers it while timer APIs are faked).
const realSetImmediate = global.setImmediate;

async function flushRealEventLoop(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise<void>((resolve) => realSetImmediate(resolve));
  }
}

type SentFrame = { type?: string; code?: string; [key: string]: unknown };

function createFakeSocket() {
  const emitter = new EventEmitter();
  const sent: SentFrame[] = [];
  const closeCalls: Array<{ code?: number; reason?: string }> = [];
  let failSends = false;
  const socket = Object.assign(emitter, {
    OPEN: 1,
    CLOSED: 3,
    readyState: 1,
    send(data: unknown) {
      if (failSends) throw new Error("WebSocket is not open");
      sent.push(JSON.parse(String(data)) as SentFrame);
    },
    close(code?: number, reason?: string) {
      closeCalls.push({ code, reason });
      if (socket.readyState !== socket.CLOSED) {
        socket.readyState = socket.CLOSED;
        emitter.emit("close", code);
      }
    },
    /** Test hook: make subsequent send() calls throw (socket mid-failure). */
    setFailSends(next: boolean) {
      failSends = next;
    },
    /** Test hook: simulate the peer disappearing (no local close() call). */
    peerClose(code = 1006) {
      socket.readyState = socket.CLOSED;
      emitter.emit("close", code);
    },
    sent,
    closeCalls,
  });
  return socket;
}

type FakeSocket = ReturnType<typeof createFakeSocket>;

type DeferredLookup = {
  queries: number;
  promise: Promise<Array<{ id: string; status: string }>>;
  resolve(rows: Array<{ id: string; status: string }>): void;
  reject(err: unknown): void;
};

function createFakeContext() {
  let session: { userId: string } | null = null;
  let authTimeout: ReturnType<typeof setTimeout> | null = null;
  let authExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  const state = {
    authentications: 0,
    expiryTimersArmed: 0,
    authTimeoutsArmed: 0,
  };
  const context = {
    getSession: () => session,
    authenticate(next: { userId: string }, _defaultOrgId: string | null) {
      state.authentications++;
      session = next;
    },
    setAuthTimeout(timer: ReturnType<typeof setTimeout>) {
      if (authTimeout) clearTimeout(authTimeout);
      authTimeout = timer;
      state.authTimeoutsArmed++;
    },
    clearAuthTimeout() {
      if (!authTimeout) return;
      clearTimeout(authTimeout);
      authTimeout = null;
    },
    setAuthExpiryTimer(timer: ReturnType<typeof setTimeout> | null) {
      if (authExpiryTimer) clearTimeout(authExpiryTimer);
      authExpiryTimer = timer;
      if (timer) state.expiryTimersArmed++;
    },
  };
  return {
    context,
    state,
    authTimeoutActive: () => authTimeout !== null,
    expiryTimerActive: () => authExpiryTimer !== null,
  };
}

type FakeContext = ReturnType<typeof createFakeContext>;

function createFakeApp(lookup: DeferredLookup) {
  const app = {
    db: {
      select: () => {
        const query = {
          from: () => query,
          where: () => query,
          limit: () => {
            lookup.queries++;
            return lookup.promise;
          },
        };
        return query;
      },
    },
    log: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    commandVersion: () => "gate-lifecycle-test",
  };
  return app;
}

type FakeApp = ReturnType<typeof createFakeApp>;

function createDeferredLookup(): DeferredLookup {
  let resolvePromise: (rows: Array<{ id: string; status: string }>) => void = () => {};
  let rejectPromise: (err: unknown) => void = () => {};
  const promise = new Promise<Array<{ id: string; status: string }>>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    queries: 0,
    promise,
    resolve(rows) {
      resolvePromise(rows);
    },
    reject(err) {
      rejectPromise(err);
    },
  };
}

async function signAccessToken(expSecondsFromNow = 3600): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: TEST_USER_ID, type: "access", organizationId: "org-gate-test" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + expSecondsFromNow)
    .sign(jwtSecretBytes);
}

function createGate(socket: FakeSocket, app: FakeApp, fakeContext: FakeContext) {
  // Casts are unavoidable: the gate is exercised against a minimal scripted
  // harness instead of booting Fastify + a database.
  return createClientWsAuthGate(
    app as unknown as FastifyInstance,
    socket as never,
    jwtSecretBytes,
    fakeContext.context as never,
  );
}

describe("client WS auth gate — single attempt and terminal state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("verifies only once when duplicate auth frames arrive during a slow lookup", async () => {
    const socket = createFakeSocket();
    const lookup = createDeferredLookup();
    const app = createFakeApp(lookup);
    const fakeContext = createFakeContext();
    const gate = createGate(socket, app, fakeContext);
    gate.start();

    const token = await signAccessToken();
    const first = gate.handle({ type: "auth", token }, "auth");
    await flushRealEventLoop();
    expect(lookup.queries).toBe(1);

    // A flood of duplicates while the first attempt's lookup is in flight:
    // the first duplicate rejects the connection deterministically, the rest
    // are no-ops — none may start another verification/DB pipeline.
    const duplicates = Array.from({ length: 19 }, () => gate.handle({ type: "auth", token }, "auth"));
    await flushRealEventLoop();
    expect(lookup.queries).toBe(1);
    // Duplicates are rejected deterministically, exactly once, without
    // queueing more work: one auth:rejected frame + one close.
    const rejected = socket.sent.filter((frame) => frame.type === "auth:rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.code).toBe("invalid_auth_frame");
    expect(socket.closeCalls).toHaveLength(1);
    expect(socket.closeCalls[0]?.code).toBe(4401);

    // The in-flight attempt's late completion lands on a terminal gate: it
    // must not authenticate, arm an expiry timer, or send a welcome.
    lookup.resolve([{ id: TEST_USER_ID, status: "active" }]);
    await Promise.all([first, ...duplicates]);
    expect(fakeContext.state.authentications).toBe(0);
    expect(fakeContext.state.expiryTimersArmed).toBe(0);
    expect(socket.sent.filter((frame) => frame.type === "server:welcome")).toHaveLength(0);
    expect(socket.sent.filter((frame) => frame.type === "auth:ok")).toHaveLength(0);
    expect(socket.closeCalls).toHaveLength(1);
    expect(app.log.warn).not.toHaveBeenCalled();
  });

  it("ignores a late successful lookup when the socket closed mid-validation", async () => {
    const socket = createFakeSocket();
    const lookup = createDeferredLookup();
    const app = createFakeApp(lookup);
    const fakeContext = createFakeContext();
    const gate = createGate(socket, app, fakeContext);
    gate.start();

    const token = await signAccessToken();
    const pending = gate.handle({ type: "auth", token }, "auth");
    await flushRealEventLoop();
    expect(lookup.queries).toBe(1);

    socket.peerClose();
    lookup.resolve([{ id: TEST_USER_ID, status: "active" }]);
    await pending;

    expect(fakeContext.state.authentications).toBe(0);
    expect(fakeContext.state.expiryTimersArmed).toBe(0);
    expect(socket.sent).toHaveLength(0);
    // The peer closed the socket — the gate must not retry-close.
    expect(socket.closeCalls).toHaveLength(0);
    expect(app.log.warn).not.toHaveBeenCalled();
  });

  it("ignores a late lookup success when the auth timeout fires mid-validation", async () => {
    const socket = createFakeSocket();
    const lookup = createDeferredLookup();
    const app = createFakeApp(lookup);
    const fakeContext = createFakeContext();
    const gate = createGate(socket, app, fakeContext);
    gate.start();

    const token = await signAccessToken();
    const pending = gate.handle({ type: "auth", token }, "auth");
    await flushRealEventLoop();
    expect(lookup.queries).toBe(1);

    // The existing 5s deadline still applies while validation is stuck.
    await vi.advanceTimersByTimeAsync(5_100);
    const retryable = socket.sent.filter((frame) => frame.type === "auth:retryable");
    expect(retryable).toHaveLength(1);
    expect(retryable[0]?.code).toBe("auth_timeout");
    expect(socket.closeCalls).toHaveLength(1);
    expect(socket.closeCalls[0]?.code).toBe(1013);

    lookup.resolve([{ id: TEST_USER_ID, status: "active" }]);
    await pending;
    expect(fakeContext.state.authentications).toBe(0);
    expect(fakeContext.state.expiryTimersArmed).toBe(0);
    expect(socket.sent.filter((frame) => frame.type === "server:welcome")).toHaveLength(0);
    expect(socket.closeCalls).toHaveLength(1);
    expect(app.log.warn).not.toHaveBeenCalled();
  });

  it("does not warn or retry-close when the lookup fails after the socket closed", async () => {
    const socket = createFakeSocket();
    const lookup = createDeferredLookup();
    const app = createFakeApp(lookup);
    const fakeContext = createFakeContext();
    const gate = createGate(socket, app, fakeContext);
    gate.start();

    const token = await signAccessToken();
    const pending = gate.handle({ type: "auth", token }, "auth");
    await flushRealEventLoop();
    expect(lookup.queries).toBe(1);

    socket.peerClose();
    lookup.reject(new Error("synthetic db failure"));
    await pending;

    expect(fakeContext.state.authentications).toBe(0);
    expect(app.log.warn).not.toHaveBeenCalled();
    expect(socket.closeCalls).toHaveLength(0);
    expect(socket.sent).toHaveLength(0);
  });

  it("does not warn or close twice when the lookup fails after an auth-timeout close", async () => {
    const socket = createFakeSocket();
    const lookup = createDeferredLookup();
    const app = createFakeApp(lookup);
    const fakeContext = createFakeContext();
    const gate = createGate(socket, app, fakeContext);
    gate.start();

    const token = await signAccessToken();
    const pending = gate.handle({ type: "auth", token }, "auth");
    await flushRealEventLoop();
    await vi.advanceTimersByTimeAsync(5_100);
    expect(socket.closeCalls).toHaveLength(1);

    lookup.reject(new Error("synthetic db failure"));
    await pending;
    expect(app.log.warn).not.toHaveBeenCalled();
    expect(socket.closeCalls).toHaveLength(1);
    expect(socket.sent.filter((frame) => frame.type === "auth:retryable")).toHaveLength(1);
  });

  it("treats a rejected auth frame as terminal — a later valid frame does no work", async () => {
    const socket = createFakeSocket();
    const lookup = createDeferredLookup();
    const app = createFakeApp(lookup);
    const fakeContext = createFakeContext();
    const gate = createGate(socket, app, fakeContext);
    gate.start();

    await gate.handle({ type: "auth", token: "not-a-jwt" }, "auth");
    const rejected = socket.sent.filter((frame) => frame.type === "auth:rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.code).toBe("invalid_token");
    expect(socket.closeCalls).toHaveLength(1);
    expect(socket.closeCalls[0]?.code).toBe(4401);

    const token = await signAccessToken();
    await gate.handle({ type: "auth", token }, "auth");
    await flushRealEventLoop();
    expect(lookup.queries).toBe(0);
    expect(fakeContext.state.authentications).toBe(0);
    expect(socket.closeCalls).toHaveLength(1);
  });

  it("treats an invalid first frame as terminal via rejectInvalidFrame", async () => {
    const socket = createFakeSocket();
    const lookup = createDeferredLookup();
    const app = createFakeApp(lookup);
    const fakeContext = createFakeContext();
    const gate = createGate(socket, app, fakeContext);
    gate.start();

    gate.rejectInvalidFrame("invalid JSON auth frame");
    expect(socket.closeCalls).toHaveLength(1);
    expect(socket.closeCalls[0]?.code).toBe(4401);

    const token = await signAccessToken();
    await gate.handle({ type: "auth", token }, "auth");
    await flushRealEventLoop();
    expect(lookup.queries).toBe(0);
    expect(socket.closeCalls).toHaveLength(1);
  });

  it("ignores a valid auth frame arriving after the no-frame timeout", async () => {
    const socket = createFakeSocket();
    const lookup = createDeferredLookup();
    const app = createFakeApp(lookup);
    const fakeContext = createFakeContext();
    const gate = createGate(socket, app, fakeContext);
    gate.start();

    await vi.advanceTimersByTimeAsync(5_100);
    expect(socket.closeCalls).toHaveLength(1);
    expect(socket.closeCalls[0]?.code).toBe(1013);

    const token = await signAccessToken();
    await gate.handle({ type: "auth", token }, "auth");
    await flushRealEventLoop();
    expect(lookup.queries).toBe(0);
    expect(fakeContext.state.authentications).toBe(0);
    expect(socket.closeCalls).toHaveLength(1);
  });

  it("authenticates exactly once and arms exactly one expiry timer on the normal path", async () => {
    const socket = createFakeSocket();
    const lookup = createDeferredLookup();
    const app = createFakeApp(lookup);
    const fakeContext = createFakeContext();
    const gate = createGate(socket, app, fakeContext);
    gate.start();

    const token = await signAccessToken(30);
    const pending = gate.handle({ type: "auth", token }, "auth");
    await flushRealEventLoop();
    lookup.resolve([{ id: TEST_USER_ID, status: "active" }]);
    await pending;

    expect(fakeContext.state.authentications).toBe(1);
    expect(fakeContext.state.expiryTimersArmed).toBe(1);
    expect(socket.sent.map((frame) => frame.type)).toEqual(["server:welcome", "auth:ok"]);
    expect(socket.closeCalls).toHaveLength(0);

    // Post-auth session expiry still closes 4401 with exactly one frame.
    await vi.advanceTimersByTimeAsync(31_000);
    expect(socket.sent.filter((frame) => frame.type === "auth:expired")).toHaveLength(1);
    expect(socket.closeCalls).toHaveLength(1);
    expect(socket.closeCalls[0]?.code).toBe(4401);
  });

  it("does not fire the post-auth expiry close after the socket is gone", async () => {
    const socket = createFakeSocket();
    const lookup = createDeferredLookup();
    const app = createFakeApp(lookup);
    const fakeContext = createFakeContext();
    const gate = createGate(socket, app, fakeContext);
    gate.start();

    const token = await signAccessToken(30);
    const pending = gate.handle({ type: "auth", token }, "auth");
    await flushRealEventLoop();
    lookup.resolve([{ id: TEST_USER_ID, status: "active" }]);
    await pending;
    expect(fakeContext.state.authentications).toBe(1);

    const sentBefore = socket.sent.length;
    socket.peerClose();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(socket.sent).toHaveLength(sentBefore);
    expect(socket.closeCalls).toHaveLength(0);
  });

  it("closes 1011 handshake_internal_error when the welcome send fails on an open socket", async () => {
    const socket = createFakeSocket();
    const lookup = createDeferredLookup();
    const app = createFakeApp(lookup);
    const fakeContext = createFakeContext();
    const gate = createGate(socket, app, fakeContext);
    gate.start();

    const token = await signAccessToken();
    const pending = gate.handle({ type: "auth", token }, "auth");
    await flushRealEventLoop();
    lookup.resolve([{ id: TEST_USER_ID, status: "active" }]);
    socket.setFailSends(true);
    await pending;

    expect(fakeContext.state.authentications).toBe(1);
    expect(app.log.warn).toHaveBeenCalledTimes(1);
    expect(socket.closeCalls).toHaveLength(1);
    expect(socket.closeCalls[0]?.code).toBe(1011);
    const queriesAfterFailure = lookup.queries;

    // Internal handshake failure is terminal: later frames do no work.
    socket.setFailSends(false);
    const token2 = await signAccessToken();
    await gate.handle({ type: "auth", token: token2 }, "auth");
    await flushRealEventLoop();
    expect(lookup.queries).toBe(queriesAfterFailure);
    expect(socket.closeCalls).toHaveLength(1);
  });

  it("handleClose clears both the auth timeout and the expiry timer immediately", async () => {
    const socket = createFakeSocket();
    const lookup = createDeferredLookup();
    const app = createFakeApp(lookup);
    const fakeContext = createFakeContext();
    const gate = createGate(socket, app, fakeContext);
    gate.start();
    expect(fakeContext.authTimeoutActive()).toBe(true);

    const token = await signAccessToken(30);
    const pending = gate.handle({ type: "auth", token }, "auth");
    await flushRealEventLoop();
    lookup.resolve([{ id: TEST_USER_ID, status: "active" }]);
    await pending;
    expect(fakeContext.expiryTimerActive()).toBe(true);

    gate.handleClose();
    expect(fakeContext.authTimeoutActive()).toBe(false);
    expect(fakeContext.expiryTimerActive()).toBe(false);

    // No timer may fire after the close: advancing past both deadlines
    // produces no frames and no close attempts.
    const sentBefore = socket.sent.length;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(socket.sent).toHaveLength(sentBefore);
    expect(socket.closeCalls).toHaveLength(0);
  });

  it("a post-auth handshake failure clears the armed expiry timer immediately", async () => {
    const socket = createFakeSocket();
    const lookup = createDeferredLookup();
    const app = createFakeApp(lookup);
    const fakeContext = createFakeContext();
    const gate = createGate(socket, app, fakeContext);
    gate.start();

    const token = await signAccessToken(30);
    const pending = gate.handle({ type: "auth", token }, "auth");
    await flushRealEventLoop();
    lookup.resolve([{ id: TEST_USER_ID, status: "active" }]);
    socket.setFailSends(true);
    await pending;
    expect(socket.closeCalls).toHaveLength(1);
    expect(socket.closeCalls[0]?.code).toBe(1011);
    expect(fakeContext.expiryTimerActive()).toBe(false);

    await vi.advanceTimersByTimeAsync(31_000);
    expect(socket.closeCalls).toHaveLength(1);
  });

  it("handleClose before auth clears the pending auth timeout", async () => {
    const socket = createFakeSocket();
    const lookup = createDeferredLookup();
    const app = createFakeApp(lookup);
    const fakeContext = createFakeContext();
    const gate = createGate(socket, app, fakeContext);
    gate.start();
    expect(fakeContext.authTimeoutActive()).toBe(true);

    gate.handleClose();
    expect(fakeContext.authTimeoutActive()).toBe(false);

    await vi.advanceTimersByTimeAsync(5_100);
    expect(socket.sent).toHaveLength(0);
    expect(socket.closeCalls).toHaveLength(0);
  });

  it("start does not arm a new timeout after the gate is terminal or the socket is closed", async () => {
    const socket = createFakeSocket();
    const lookup = createDeferredLookup();
    const app = createFakeApp(lookup);
    const fakeContext = createFakeContext();
    const gate = createGate(socket, app, fakeContext);
    gate.start();
    expect(fakeContext.state.authTimeoutsArmed).toBe(1);

    // Terminal gate: start() is a no-op.
    gate.rejectInvalidFrame("invalid JSON auth frame");
    gate.start();
    expect(fakeContext.state.authTimeoutsArmed).toBe(1);

    // Fresh gate on an already-closed socket: no timer is ever armed.
    const closedSocket = createFakeSocket();
    const closedContext = createFakeContext();
    const closedGate = createGate(closedSocket, app, closedContext);
    closedSocket.peerClose();
    closedGate.start();
    expect(closedContext.state.authTimeoutsArmed).toBe(0);
  });

  it("returns false for frames after a successful auth (post-auth dispatch owns them)", async () => {
    const socket = createFakeSocket();
    const lookup = createDeferredLookup();
    const app = createFakeApp(lookup);
    const fakeContext = createFakeContext();
    const gate = createGate(socket, app, fakeContext);
    gate.start();

    const token = await signAccessToken();
    const pending = gate.handle({ type: "auth", token }, "auth");
    await flushRealEventLoop();
    lookup.resolve([{ id: TEST_USER_ID, status: "active" }]);
    await pending;

    expect(await gate.handle({ type: "heartbeat" }, "heartbeat")).toBe(false);
    expect(lookup.queries).toBe(1);
    expect(fakeContext.state.authentications).toBe(1);
  });
});

describe("client WS connection dispatch — closed socket containment", () => {
  function createHarness(lookup: DeferredLookup) {
    const socket = createFakeSocket();
    const app = createFakeApp(lookup);
    const fakeAppWithConfig = {
      ...app,
      config: { secrets: { jwtSecret: TEST_SECRET } },
    };
    const notifier = {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      notify: vi.fn(),
    };
    const request = { headers: {}, ip: "127.0.0.1" };
    // Casts are unavoidable: the connection is driven through a scripted
    // socket/app harness rather than a live Fastify + database boot.
    attachClientWsConnection(
      fakeAppWithConfig as unknown as FastifyInstance,
      socket as never,
      request as never,
      notifier as never,
      "test-instance",
    );
    return { socket, app, notifier };
  }

  it("skips message dispatch entirely after the socket closed", async () => {
    const lookup = createDeferredLookup();
    const { socket, app } = createHarness(lookup);

    const token = await signAccessToken();
    socket.emit("message", JSON.stringify({ type: "auth", token }));
    await vi.waitFor(() => {
      expect(lookup.queries).toBe(1);
    });
    lookup.resolve([{ id: TEST_USER_ID, status: "active" }]);
    await vi.waitFor(() => {
      expect(socket.sent.some((frame) => frame.type === "auth:ok")).toBe(true);
    });

    const sentBefore = socket.sent.length;
    socket.close(1000, "client going away");
    socket.emit("message", "definitely not json");
    socket.emit("message", JSON.stringify({ type: "heartbeat" }));
    await flushRealEventLoop();

    expect(socket.sent).toHaveLength(sentBefore);
    expect(app.log.warn).not.toHaveBeenCalled();
  });

  it("runs no auth verification for frames arriving after close", async () => {
    const lookup = createDeferredLookup();
    const { socket } = createHarness(lookup);

    socket.close(1000, "client going away");
    const token = await signAccessToken();
    socket.emit("message", JSON.stringify({ type: "auth", token }));
    socket.emit("message", "definitely not json");
    await flushRealEventLoop();

    expect(lookup.queries).toBe(0);
    expect(socket.sent).toHaveLength(0);
    // The socket was already closed by the peer: no retry-close, no warnings.
    expect(socket.closeCalls).toHaveLength(1);
  });

  it("completes the normal handshake through the connection (guard)", async () => {
    const lookup = createDeferredLookup();
    const { socket } = createHarness(lookup);

    const token = await signAccessToken();
    socket.emit("message", JSON.stringify({ type: "auth", token }));
    await vi.waitFor(() => {
      expect(lookup.queries).toBe(1);
    });
    lookup.resolve([{ id: TEST_USER_ID, status: "active" }]);
    await vi.waitFor(() => {
      expect(socket.sent.some((frame) => frame.type === "auth:ok")).toBe(true);
    });

    expect(socket.sent.map((frame) => frame.type)).toEqual(["server:welcome", "auth:ok"]);
    socket.close(1000, "done");
    await flushRealEventLoop();
    expect(socket.closeCalls).toHaveLength(1);
  });
});
