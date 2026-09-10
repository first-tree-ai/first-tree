import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { ClientConnection } from "../runtime/client-connection.js";

/**
 * Task 4 (Bug 2): `auth:rejected` / `AuthRefreshFailedError` no longer flips
 * the connection into a permanent `closing=true` state — instead the
 * connection enters paused mode (events `auth:paused` + `auth:fatal`) and
 * stops attempting reconnects. The consumer (CLI) is expected to drive
 * `clearPaused()` when fresh credentials arrive.
 *
 * Staging auth-failure storm fix (D1): on the INITIAL connect path, paused
 * mode used to make `connect()` throw. No consumer ever re-invoked
 * `connect()`, so the CLI daemon exited and systemd/launchd restarted it
 * every ~10s — each boot re-fired doomed `/auth/refresh` POSTs plus a wasted
 * WS handshake. `connect()` now PARKS while paused: the promise stays
 * pending (no error events, no sockets, no token calls) until
 * `clearPaused()` → `auth:resumed` wakes the loop, which retries with the
 * fresh credentials and resolves on the first successful `client:registered`.
 * `disconnect()` still aborts the park promptly.
 *
 * The earlier revision of this file asserted `connect()` REJECTS on the
 * initial pause — that contract encoded the restart-storm bug and has been
 * replaced with pending / recover / shutdown tests.
 */

class AuthRefreshFailedError extends Error {
  constructor() {
    super("Refresh token rejected by server.");
    this.name = "AuthRefreshFailedError";
  }
}

type Tracked = {
  promise: Promise<void>;
  settled: () => boolean;
  error: () => unknown;
};

/** Track a connect() promise's settlement without leaving it unhandled. */
function track(connectPromise: Promise<void>): Tracked {
  let settled = false;
  let error: unknown = null;
  const promise = connectPromise.then(
    () => {
      settled = true;
    },
    (err: unknown) => {
      settled = true;
      error = err;
    },
  );
  return { promise, settled: () => settled, error: () => error };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition was not reached in time");
    await sleep(10);
  }
}

describe("ClientConnection — auth paused mode (Bug 2, D1)", () => {
  let httpServer: HttpServer;
  let wss: WebSocketServer;
  let serverUrl: string;

  beforeEach(async () => {
    httpServer = createServer();
    wss = new WebSocketServer({ server: httpServer, path: "/api/v1/agent/ws/client" });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("no server address");
    serverUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  /** Server that completes auth only for `goodToken` and counts registrations. */
  function serveGoodToken(goodToken: string, counters: { sockets: number; registrations: number }): void {
    wss.on("connection", (ws: WebSocket) => {
      counters.sockets++;
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string; token?: string };
        if (msg.type === "auth") {
          if (msg.token === goodToken) {
            ws.send(JSON.stringify({ type: "auth:ok" }));
          } else {
            ws.send(JSON.stringify({ type: "auth:rejected", code: "invalid_token" }));
          }
          return;
        }
        if (msg.type === "client:register") {
          counters.registrations++;
          ws.send(JSON.stringify({ type: "client:registered" }));
        }
      });
    });
  }

  it("AuthRefreshFailedError parks the initial connect; clearPaused with fresh credentials completes it", async () => {
    const counters = { sockets: 0, registrations: 0 };
    serveGoodToken("good-token", counters);

    let tokenCalls = 0;
    let allowToken = false;
    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_paused_refresh",
      getAccessToken: async () => {
        tokenCalls++;
        if (!allowToken) throw new AuthRefreshFailedError();
        return "good-token";
      },
    });

    const events: string[] = [];
    const pausedReasons: string[] = [];
    const resumes: string[] = [];
    connection.on("auth:paused", (reason) => {
      events.push("auth:paused");
      pausedReasons.push(reason);
    });
    connection.on("auth:fatal", () => events.push("auth:fatal"));
    connection.on("auth:resumed", (prev) => resumes.push(prev));
    connection.on("reconnecting", () => events.push("reconnecting"));
    connection.on("error", () => events.push("error"));

    const tracked = track(connection.connect());

    // The paused initial connect must stay PENDING — silently: no error
    // events, no reconnect attempts, no extra sockets or token calls.
    await waitFor(() => connection.isPaused());
    await sleep(300);
    expect(tracked.settled()).toBe(false);
    expect(connection.getPausedReason()).toBe("auth_refresh_failed");
    expect(events).toContain("auth:paused");
    expect(events).toContain("auth:fatal");
    expect(events).not.toContain("reconnecting");
    expect(events).not.toContain("error");
    expect(pausedReasons).toEqual(["auth_refresh_failed"]);
    expect(tokenCalls).toBe(1);
    expect(counters.sockets).toBe(1);

    // Operator recovery: fresh credentials + clearPaused → exactly one
    // successful registration, then connect() resolves.
    allowToken = true;
    connection.clearPaused();
    await tracked.promise;
    expect(resumes).toEqual(["auth_refresh_failed"]);
    expect(connection.isPaused()).toBe(false);
    expect(connection.isConnected).toBe(true);
    expect(counters.registrations).toBe(1);
    expect(tokenCalls).toBe(2);
    expect(counters.sockets).toBe(2);

    // No duplicate owner: clearPaused must not have armed its own reconnect
    // timer while the connect loop is alive (a second socket would show up
    // within one base backoff interval).
    await sleep(1_500);
    expect(counters.sockets).toBe(2);
    expect(counters.registrations).toBe(1);

    await connection.disconnect();
  }, 10_000);

  it("server-side auth:rejected parks the initial connect and recovers on clearPaused", async () => {
    let attempts = 0;
    let registrations = 0;
    wss.on("connection", (ws: WebSocket) => {
      attempts++;
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string; token?: string };
        if (msg.type === "auth") {
          if (msg.token === "good") {
            ws.send(JSON.stringify({ type: "auth:ok" }));
          } else {
            ws.send(JSON.stringify({ type: "auth:rejected" }));
          }
          return;
        }
        if (msg.type === "client:register") {
          registrations++;
          ws.send(JSON.stringify({ type: "client:registered" }));
        }
      });
    });

    let token = "bad";
    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_paused_rejected",
      getAccessToken: async () => token,
    });

    const events: string[] = [];
    connection.on("auth:paused", (reason) => events.push(`paused:${reason}`));
    connection.on("auth:fatal", () => events.push("fatal"));
    connection.on("reconnecting", () => events.push("reconnecting"));
    connection.on("error", () => {});

    const tracked = track(connection.connect());
    await waitFor(() => connection.isPaused());
    await sleep(300);
    expect(tracked.settled()).toBe(false);
    expect(connection.getPausedReason()).toBe("auth_rejected");
    expect(attempts).toBe(1);
    expect(events).toContain("paused:auth_rejected");
    expect(events).not.toContain("reconnecting");

    token = "good";
    connection.clearPaused();
    await tracked.promise;
    expect(registrations).toBe(1);
    expect(attempts).toBe(2);

    await connection.disconnect();
  }, 10_000);

  it("structured auth:rejected includes the rejection code in paused error", async () => {
    wss.on("connection", (ws: WebSocket) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth:rejected", code: "invalid_token", message: "signature mismatch" }));
        }
      });
    });

    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_paused_rejected_structured",
      getAccessToken: async () => "tok",
    });

    const pausedErrors: Error[] = [];
    connection.on("auth:paused", (_reason, err) => pausedErrors.push(err));
    connection.on("error", () => {});

    const tracked = track(connection.connect());
    await waitFor(() => connection.isPaused());
    expect(tracked.settled()).toBe(false);
    expect(connection.getPausedReason()).toBe("auth_rejected");
    expect(pausedErrors[0]?.message).toContain("invalid_token");
    expect(pausedErrors[0]?.message).toContain("signature mismatch");

    await connection.disconnect();
    await tracked.promise;
  }, 10_000);

  it("disconnect() while parked rejects connect promptly and leaves no listeners or timers behind", async () => {
    let socketCount = 0;
    wss.on("connection", () => {
      socketCount++;
    });

    let tokenCalls = 0;
    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_paused_disconnect",
      getAccessToken: async () => {
        tokenCalls++;
        throw new AuthRefreshFailedError();
      },
    });
    connection.on("error", () => {});

    const connectPromise = connection.connect();
    const tracked = track(connectPromise);
    await waitFor(() => connection.isPaused());
    // Exactly the parked wait's once-listener is attached.
    expect(connection.listenerCount("auth:resumed")).toBe(1);

    const t0 = Date.now();
    const disconnectPromise = connection.disconnect();
    await expect(connectPromise).rejects.toThrow(/Refresh token/);
    await disconnectPromise;
    // Prompt abort — nowhere near any backoff or supervisor interval.
    expect(Date.now() - t0).toBeLessThan(700);

    expect(tracked.settled()).toBe(true);
    expect(connection.listenerCount("auth:resumed")).toBe(0);
    expect(connection.isConnected).toBe(false);

    // No reconnect timer survived the abort: nothing else happens.
    await sleep(1_500);
    expect(socketCount).toBe(1);
    expect(tokenCalls).toBe(1);
  }, 10_000);

  it("an immediate synchronous clearPaused inside auth:paused still converges to exactly one registration", async () => {
    const counters = { sockets: 0, registrations: 0 };
    serveGoodToken("good-token", counters);

    let tokenCalls = 0;
    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_paused_sync_resume",
      getAccessToken: async () => {
        tokenCalls++;
        if (tokenCalls === 1) throw new AuthRefreshFailedError();
        return "good-token";
      },
    });
    connection.on("error", () => {});
    // Synchronous resume: no missed wakeup, and no duplicate reconnect owner —
    // the still-running connect loop owns the retry.
    connection.once("auth:paused", () => connection.clearPaused());

    await connection.connect();

    expect(connection.isConnected).toBe(true);
    expect(counters.registrations).toBe(1);
    expect(tokenCalls).toBe(2);
    expect(counters.sockets).toBe(2);

    await sleep(1_500);
    expect(counters.sockets).toBe(2);
    expect(counters.registrations).toBe(1);

    await connection.disconnect();
  }, 10_000);

  it("repeated pause/resume cycles stay bounded in sockets, token calls and listeners", async () => {
    const counters = { sockets: 0, registrations: 0 };
    serveGoodToken("good-token", counters);

    let tokenCalls = 0;
    let allowToken = false;
    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_paused_cycles",
      getAccessToken: async () => {
        tokenCalls++;
        if (!allowToken) throw new AuthRefreshFailedError();
        return "good-token";
      },
    });
    connection.on("error", () => {});
    connection.on("reconnecting", () => {
      throw new Error("parked connect must never emit reconnecting");
    });

    const tracked = track(connection.connect());
    const nextPaused = () => new Promise<void>((resolve) => connection.once("auth:paused", () => resolve()));

    for (let cycle = 1; cycle <= 3; cycle++) {
      await nextPaused();
      // The parked waiter attaches a few microtasks after the auth:paused
      // emit (the openWebSocket rejection has to unwind first) — wait for it,
      // and assert exactly one: listeners never accumulate across cycles.
      await waitFor(() => connection.listenerCount("auth:resumed") === 1);
      expect(tokenCalls).toBe(cycle);
      expect(counters.sockets).toBe(cycle);
      connection.clearPaused();
      // clearPaused consumed the waiter; the next cycle parks exactly one.
      await waitFor(() => connection.listenerCount("auth:resumed") <= 1);
    }

    allowToken = true;
    connection.clearPaused();
    await tracked.promise;
    expect(counters.registrations).toBe(1);
    expect(tokenCalls).toBe(4);
    expect(counters.sockets).toBe(4);

    await connection.disconnect();
  }, 10_000);

  it("a parked connect outlasts the supervisor restart interval with zero additional network activity", async () => {
    const counters = { sockets: 0, registrations: 0 };
    serveGoodToken("good-token", counters);

    let tokenCalls = 0;
    let allowToken = false;
    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_paused_supervisor_interval",
      getAccessToken: async () => {
        tokenCalls++;
        if (!allowToken) throw new AuthRefreshFailedError();
        return "good-token";
      },
    });
    connection.on("error", () => {});

    const tracked = track(connection.connect());
    await waitFor(() => connection.isPaused());

    // systemd RestartSec=10 / launchd ThrottleInterval=10 used to guarantee
    // another failing boot by now. The parked connect must produce NOTHING
    // across that whole interval: no sockets, no /auth/refresh, no settle.
    const deadline = Date.now() + 10_500;
    while (Date.now() < deadline) {
      expect(tracked.settled()).toBe(false);
      expect(tokenCalls).toBe(1);
      expect(counters.sockets).toBe(1);
      await sleep(250);
    }

    allowToken = true;
    connection.clearPaused();
    await tracked.promise;
    expect(counters.registrations).toBe(1);

    await connection.disconnect();
  }, 20_000);

  it("a late token rejection from a settled attempt cannot pause its registered successor", async () => {
    // Mirrors the independent reproduction (repair-1711
    // client-retired-token-after.test.ts): attempt A's token is deferred,
    // the server retires A's socket mid-acquisition, successor B registers —
    // then A's token rejects AuthRefreshFailedError. Pre-fix, A's open
    // handler catch ran enterPausedMode on B's healthy connection.
    let firstSocket: WebSocket | null = null;
    let sockets = 0;
    let registrations = 0;
    wss.on("connection", (ws: WebSocket) => {
      if (++sockets === 1) firstSocket = ws;
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth:ok" }));
          return;
        }
        if (msg.type === "client:register") {
          registrations++;
          ws.send(JSON.stringify({ type: "client:registered" }));
        }
      });
    });

    let rejectOld: (err: Error) => void = () => {};
    let tokenCalls = 0;
    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_retired_token_reject",
      getAccessToken: async () => {
        tokenCalls++;
        if (tokenCalls === 1) {
          return new Promise<string>((_resolve, reject) => {
            rejectOld = reject;
          });
        }
        return "good-token";
      },
    });
    connection.on("error", () => {});
    const events: string[] = [];
    connection.on("auth:paused", () => events.push("auth:paused"));

    const tracked = track(connection.connect());
    await waitFor(() => tokenCalls === 1 && firstSocket !== null);
    // Server retires attempt A mid-token-acquisition — a transient failure,
    // so the connect loop retries and B registers.
    (firstSocket as WebSocket | null)?.close(1000, "synthetic retirement");
    await tracked.promise;
    expect(connection.isConnected).toBe(true);
    expect(registrations).toBe(1);
    expect(tokenCalls).toBe(2);

    // NOW A's token rejects terminally — a dead attempt's failure must not
    // reach the live connection.
    rejectOld(new AuthRefreshFailedError());
    await sleep(300);
    expect(connection.isPaused()).toBe(false);
    expect(connection.isConnected).toBe(true);
    expect(events).not.toContain("auth:paused");
    expect(tokenCalls).toBe(2);
    expect(registrations).toBe(1);
    expect(sockets).toBe(2);

    await connection.disconnect();
  }, 10_000);

  it("a late token resolution on a settled attempt sends nothing and arms no proactive timer", async () => {
    let firstSocket: WebSocket | null = null;
    let sockets = 0;
    let registrations = 0;
    let framesOnFirstSocket = 0;
    wss.on("connection", (ws: WebSocket) => {
      const isFirst = ++sockets === 1;
      if (isFirst) firstSocket = ws;
      ws.on("message", (raw) => {
        if (isFirst) framesOnFirstSocket++;
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth:ok" }));
          return;
        }
        if (msg.type === "client:register") {
          registrations++;
          ws.send(JSON.stringify({ type: "client:registered" }));
        }
      });
    });

    let resolveOld: (token: string) => void = () => {};
    let tokenCalls = 0;
    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_retired_token_resolve",
      getAccessToken: async () => {
        tokenCalls++;
        if (tokenCalls === 1) {
          return new Promise<string>((resolve) => {
            resolveOld = resolve;
          });
        }
        return "good-token";
      },
    });
    connection.on("error", () => {});
    connection.on("auth:paused", () => {
      throw new Error("late token resolution must not pause");
    });

    const tracked = track(connection.connect());
    await waitFor(() => tokenCalls === 1 && firstSocket !== null);
    (firstSocket as WebSocket | null)?.close(1000, "synthetic retirement");
    await tracked.promise;
    expect(connection.isConnected).toBe(true);
    expect(registrations).toBe(1);

    // A's token finally arrives — it must not be sent on the retired socket
    // (no frame, no crash) and must not disturb B.
    resolveOld("stale-token");
    await sleep(300);
    expect(framesOnFirstSocket).toBe(0);
    expect(connection.isPaused()).toBe(false);
    expect(connection.isConnected).toBe(true);
    expect(registrations).toBe(1);
    expect(sockets).toBe(2);

    await connection.disconnect();
  }, 10_000);

  it("disconnect() during token acquisition settles connect promptly and ignores the late token", async () => {
    let firstSocket: WebSocket | null = null;
    wss.on("connection", (ws: WebSocket) => {
      if (!firstSocket) firstSocket = ws;
    });

    let rejectOld: (err: Error) => void = () => {};
    let tokenCalls = 0;
    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_disconnect_during_token",
      getAccessToken: async () => {
        tokenCalls++;
        if (tokenCalls === 1) {
          return new Promise<string>((_resolve, reject) => {
            rejectOld = reject;
          });
        }
        return "good-token";
      },
    });
    connection.on("error", () => {});

    const connectPromise = connection.connect();
    const tracked = track(connectPromise);
    await waitFor(() => tokenCalls === 1 && firstSocket !== null);

    // The abort ownership (connectAbort) settles the token wait — connect
    // must reject promptly even though the provider never answers.
    const t0 = Date.now();
    const disconnectPromise = connection.disconnect();
    await expect(connectPromise).rejects.toBeDefined();
    await disconnectPromise;
    expect(Date.now() - t0).toBeLessThan(700);
    expect(tracked.settled()).toBe(true);

    // The late terminal token failure is consumed silently: no pause, no
    // unhandled rejection, no further activity.
    rejectOld(new AuthRefreshFailedError());
    await sleep(200);
    expect(connection.isPaused()).toBe(false);
    expect(connection.isConnected).toBe(false);
  }, 10_000);

  it("anchors a terminal refresh failure to the pre-provider credentials snapshot", async () => {
    const counters = { sockets: 0, registrations: 0 };
    serveGoodToken("good-token", counters);

    let snapshot = "cred-v1";
    let allowToken = false;
    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_attempt_identity_refresh",
      getAccessToken: async () => {
        if (!allowToken) throw new AuthRefreshFailedError();
        return "good-token";
      },
      getCredentialsSnapshot: () => snapshot,
    });
    connection.on("error", () => {});

    const tracked = track(connection.connect());
    await waitFor(() => connection.isPaused());
    // No token was ever sent — the failed attempt's identity is the
    // credential-store snapshot taken before the provider ran.
    expect(connection.getAuthAttemptCredential()).toBe("cred-v1");

    // Operator re-login rotates the snapshot; the next attempt's identity
    // becomes the token actually sent in the handshake.
    snapshot = "cred-v2";
    allowToken = true;
    connection.clearPaused();
    await tracked.promise;
    expect(connection.getAuthAttemptCredential()).toBe("good-token");
    expect(counters.registrations).toBe(1);

    await connection.disconnect();
  }, 10_000);

  it("tolerates a throwing credentials snapshot hook", async () => {
    wss.on("connection", () => {});
    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_snapshot_hook_throw",
      getAccessToken: async () => {
        throw new AuthRefreshFailedError();
      },
      getCredentialsSnapshot: () => {
        throw new Error("disk gone");
      },
    });
    connection.on("error", () => {});

    const tracked = track(connection.connect());
    await waitFor(() => connection.isPaused());
    expect(connection.getAuthAttemptCredential()).toBeNull();

    await connection.disconnect();
    await tracked.promise;
  }, 10_000);
});
