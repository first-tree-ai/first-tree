import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { ClientConnection } from "../runtime/client-connection.js";

/**
 * Regression coverage for the May 6 incident captured in client.log:
 *
 *   1. Refresh token expired → `getAccessToken` throws; client previously
 *      thrashed at 1Hz forever, burning CPU and log volume. The fix:
 *      surface `auth:fatal`/`auth:paused` on `AuthRefreshFailedError` and
 *      stop the reconnect loop. The initial-connect path then used to
 *      THROW out of `connect()` — which pushed the CLI into process.exit
 *      and let systemd/launchd restart it into the same dead credentials
 *      every ~10s (the staging auth-failure storm). `connect()` now parks
 *      while paused and only resolves after `clearPaused()` + a successful
 *      registration; these tests pin both halves (park, then prompt abort
 *      on disconnect).
 *
 *   2. The 1Hz cadence itself was caused by `reconnectAttempt = 0` on
 *      `ws.on("open")` — a TCP-level success was treated as application
 *      success, so the exponential backoff collapsed to attempt=1 forever
 *      whenever the auth phase failed between open and register. Fix:
 *      reset only on `client:registered` (application-level success).
 *
 * Both behaviours are tested directly so a future refactor that re-introduces
 * either bug fails CI before it ships.
 */
describe("ClientConnection — auth-fatal + reconnect backoff regressions", () => {
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

  it("parks the initial connect (auth:fatal) instead of throwing when getAccessToken throws AuthRefreshFailedError", async () => {
    // Server accepts the WS but the client never gets that far — its first
    // call to getAccessToken throws synthetically, the same shape the
    // command-layer's bootstrap throws on a real `/auth/refresh` 401.
    let socketCount = 0;
    wss.on("connection", () => {
      socketCount++;
    });

    class AuthRefreshFailedError extends Error {
      constructor() {
        super("Refresh token rejected by server.");
        this.name = "AuthRefreshFailedError";
      }
    }

    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_authfatal",
      getAccessToken: async () => {
        throw new AuthRefreshFailedError();
      },
    });

    const events: string[] = [];
    connection.on("auth:fatal", () => events.push("auth:fatal"));
    connection.on("reconnecting", () => events.push("reconnecting"));
    // ClientConnection re-emits the error on `error` so consumers see it;
    // soak it up here so the unhandled-rejection guard in vitest doesn't
    // fail the run.
    connection.on("error", () => {});

    let settled = false;
    const connectPromise = connection.connect();
    const tracked = connectPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // The connect promise must NOT reject into the consumer anymore — it
    // parks silently while paused. A throw here is what used to push the
    // daemon into process.exit and the supervisor's ~10s restart loop.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    expect(connection.isPaused()).toBe(true);
    expect(events).toContain("auth:fatal");
    expect(events).not.toContain("reconnecting");
    // The pre-fix bug spammed sockets at 1Hz; assert we opened **one** and
    // stopped. Anything > 1 means the close handler still scheduled a
    // reconnect after an unrecoverable auth error.
    expect(socketCount).toBeLessThanOrEqual(1);

    // disconnect() aborts the park promptly; the pending connect rejects
    // with the original auth error.
    await connection.disconnect();
    await expect(connectPromise).rejects.toThrow(/Refresh token/);
    await tracked;
  }, 10_000);

  it("does not collapse exponential backoff to 1Hz when the auth phase fails after ws.open", async () => {
    // Reproduces the May 6 1Hz reconnect storm: TCP/WS handshake succeeds
    // (so `ws.on("open")` fires server-side) but the application-level auth
    // never reaches `client:registered`. The pre-fix code reset
    // `reconnectAttempt = 0` on open, so every retry was `RECONNECT_BASE_MS *
    // 2^0 = 1000ms`. After the fix, the counter only resets on
    // `client:registered`, so the second retry waits at least
    // `RECONNECT_BASE_MS * 2^1 = 2000ms`.
    //
    // Server here: accept the WS, ack auth, but then drop the connection
    // before client:registered. The client treats that as an
    // already-registered-then-disconnected case and reconnects.
    let socketCount = 0;
    const openTimes: number[] = [];
    wss.on("connection", (ws: WebSocket) => {
      socketCount++;
      openTimes.push(Date.now());
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth:ok" }));
          return;
        }
        if (msg.type === "client:register") {
          // Simulate the application-layer failure:  socket completed auth
          // and registered once, then on every subsequent reconnect attempt
          // we drop the socket *after* the auth handshake succeeded so the
          // pre-fix `reconnectAttempt = 0` would have fired.
          if (socketCount === 1) {
            ws.send(JSON.stringify({ type: "client:registered" }));
            // Drop after ~10ms so the client sees a registered → close path.
            setTimeout(() => ws.close(1011, "drop after register"), 10);
          } else {
            // From the second connection on, refuse to register and just close.
            // ws.open will still fire on the client side — that's the danger zone.
            setTimeout(() => ws.close(1011, "no register"), 5);
          }
        }
      });
    });

    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_backoff",
      getAccessToken: async () => "tok",
    });

    connection.on("error", () => {});
    connection.on("reconnecting", () => {});

    await connection.connect();

    // Wait long enough for at least 3 reconnect attempts to have happened.
    // Backoff schedule: 1000 → 2000 → 4000 (capped) → 8000 …
    // If the bug re-appears, attempts will be 1000ms apart and we'd see
    // ≥ 4 sockets in this window. With the fix, gaps grow exponentially
    // and we see ~3.
    await new Promise((resolve) => setTimeout(resolve, 5_500));

    // The first connect counts; subsequent attempts should be increasingly
    // spaced. Assert via *gap* rather than count to keep the test resilient
    // to wall-clock jitter on slow CI.
    expect(openTimes.length).toBeGreaterThanOrEqual(2);
    const t0 = openTimes[0];
    const t1 = openTimes[1];
    const t2 = openTimes[2];
    if (t0 !== undefined && t1 !== undefined && t2 !== undefined) {
      const firstGap = t1 - t0;
      const secondGap = t2 - t1;
      // If backoff is working, the second gap should be meaningfully larger
      // than the first (exponential). A factor of 1.5x is a safe lower bound
      // that still rejects the 1Hz-flat regression.
      expect(secondGap).toBeGreaterThan(firstGap * 1.5);
    }

    await connection.disconnect();
  }, 15_000);
});
