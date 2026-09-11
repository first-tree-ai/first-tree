import { createServer, type Server as HttpServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { ClientConnection } from "../runtime/client-connection.js";

// Regression: auth:expired must schedule a reconnect, not silently drop the socket.
describe("ClientConnection — auth:expired reconnect", () => {
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

  it("reconnects and refreshes the access token after server pushes auth:expired", async () => {
    let socketCount = 0;

    wss.on("connection", (ws: WebSocket) => {
      const n = ++socketCount;
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth:ok" }));
          return;
        }
        if (msg.type === "client:register") {
          ws.send(JSON.stringify({ type: "client:registered" }));
          if (n === 1) {
            setTimeout(() => {
              ws.send(JSON.stringify({ type: "auth:expired" }));
              ws.close(4401, "auth expired");
            }, 20);
          }
        }
      });
    });

    let tokenCalls = 0;
    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_test",
      getAccessToken: async () => {
        tokenCalls++;
        return `tok-${tokenCalls}`;
      },
    });

    const events: string[] = [];
    connection.on("auth:expired", () => events.push("auth:expired"));
    connection.on("reconnecting", () => events.push("reconnecting"));
    connection.on("connected", () => events.push("connected"));
    connection.on("disconnected", () => events.push("disconnected"));

    await connection.connect();
    expect(connection.isConnected).toBe(true);

    // The initial `connected` fired before the listener above was attached,
    // so `once` here resolves only on the reconnect's `connected`.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("did not reconnect within 5s")), 5000);
      connection.once("connected", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    expect(events).toContain("auth:expired");
    expect(events).toContain("reconnecting");
    expect(socketCount).toBe(2);
    expect(tokenCalls).toBeGreaterThanOrEqual(2);
    expect(connection.isConnected).toBe(true);

    await connection.disconnect();
  }, 10_000);

  it("emits auth:fatal and stops reconnecting on mid-session auth:rejected", async () => {
    // After registration, server suddenly rejects the token. Without auth:fatal
    // emit, the process would stay up with no operator-visible signal — the
    // close handler bypasses scheduleReconnect (closing=true) and emits nothing
    // else, so the agent silently stops responding to inbox pushes.
    let socketCount = 0;
    wss.on("connection", (ws: WebSocket) => {
      const n = ++socketCount;
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth:ok" }));
          return;
        }
        if (msg.type === "client:register") {
          ws.send(JSON.stringify({ type: "client:registered" }));
          if (n === 1) {
            setTimeout(() => {
              ws.send(JSON.stringify({ type: "auth:rejected", reason: "revoked" }));
              ws.close(4401, "rejected");
            }, 20);
          }
        }
      });
    });

    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_runtime_rejected",
      getAccessToken: async () => "tok",
    });

    const events: string[] = [];
    const fatals: Error[] = [];
    connection.on("reconnecting", () => events.push("reconnecting"));
    connection.on("connected", () => events.push("connected"));
    connection.on("auth:fatal", (err) => {
      events.push("auth:fatal");
      fatals.push(err);
    });
    connection.on("error", () => {});

    await connection.connect();
    expect(connection.isConnected).toBe(true);

    // Wait long enough for the server's 20ms-delayed auth:rejected push +
    // close + any (incorrectly scheduled) reconnect attempts to settle.
    await new Promise<void>((r) => setTimeout(r, 1500));

    expect(events).toContain("auth:fatal");
    expect(events).not.toContain("reconnecting");
    expect(socketCount).toBe(1);
    expect(connection.isConnected).toBe(false);
    expect(fatals[0]?.message).toMatch(/auth:rejected/i);

    await connection.disconnect();
  }, 10_000);

  it("does not loop-reconnect when auth:rejected fires during initial handshake", async () => {
    let socketCount = 0;
    wss.on("connection", (ws: WebSocket) => {
      socketCount++;
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth:rejected", reason: "invalid" }));
          ws.close(4401, "rejected");
        }
      });
    });

    const connection = new ClientConnection({
      serverUrl,
      clientId: "client_rejected",
      getAccessToken: async () => "bad-token",
    });

    const events: string[] = [];
    connection.on("reconnecting", () => events.push("reconnecting"));
    connection.on("error", () => {});

    // D1: the initial connect PARKS on auth pause instead of rejecting —
    // rejecting used to push the daemon into process.exit and the
    // supervisor's ~10s restart loop (staging auth-failure storm).
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

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    expect(connection.isPaused()).toBe(true);
    // Deterministic assertion: initial-handshake rejection must never schedule
    // a reconnect (wasRegistered is false at close). No need to wait on wall time.
    expect(events).not.toContain("reconnecting");
    expect(socketCount).toBe(1);
    expect(connection.isConnected).toBe(false);

    await connection.disconnect();
    await expect(connectPromise).rejects.toThrow();
    await tracked;
  }, 10_000);
});
