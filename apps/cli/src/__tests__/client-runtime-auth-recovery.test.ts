import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { saveCredentials } from "../core/bootstrap.js";
import { ClientRuntime } from "../core/client-runtime.js";

/**
 * Paused-mode credential recovery, end-to-end at the ClientRuntime level with
 * a real local WebSocket server and a real temp-home fs watcher.
 *
 * Regression: a login that landed BETWEEN the rejected auth frame and the
 * server reply used to be lost — the credentials watcher was installed on
 * auth:paused and baselined the ALREADY-new file, so with the parked initial
 * connect nothing ever retried until a second credential write. Recovery is
 * now anchored to the credential the rejected attempt actually used, checked
 * immediately on pause and on every later file event.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const token = (id: string) =>
  `synthetic.${Buffer.from(
    JSON.stringify({ sub: "synthetic-owner", jti: id, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString("base64url")}.signature`;

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("bounded condition timeout");
    await sleep(10);
  }
}

const silentOutput = {
  blank() {},
  status() {},
  check() {},
  line() {},
};

type Harness = {
  serverUrl: string;
  close: () => Promise<void>;
};

/** Start a loopback HTTP+WS server; `onFrame` answers auth/register frames. */
async function serve(
  onFrame: (frame: { type: string; token?: string }, ws: WebSocket) => void,
  onSocket?: () => void,
  onRequest?: (body: string, respond: (status: number, payload?: string) => void) => void,
): Promise<Harness> {
  const server = createServer((req, res) => {
    if (!onRequest || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () =>
      onRequest(Buffer.concat(chunks).toString(), (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(payload);
      }),
    );
  });
  const wss = new WebSocketServer({ server, path: "/api/v1/agent/ws/client" });
  wss.on("connection", (ws) => {
    onSocket?.();
    ws.on("message", (raw) => onFrame(JSON.parse(String(raw)) as { type: string; token?: string }, ws));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing local address");
  return {
    serverUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function acceptAuth(ws: WebSocket): void {
  ws.send(
    JSON.stringify({
      type: "server:welcome",
      serverCommandVersion: "0.0.0",
      serverTimeMs: Date.now(),
      capabilities: {},
    }),
  );
  ws.send(JSON.stringify({ type: "auth:ok" }));
}

function rejectAuth(ws: WebSocket): void {
  ws.send(JSON.stringify({ type: "auth:rejected", code: "invalid_token", message: "token rejected" }));
  ws.close(4401, "authentication failed");
}

describe("ClientRuntime — paused-mode credential recovery", () => {
  let home: string;

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  function stubHome(prefix: string): void {
    home = mkdtempSync(join(tmpdir(), prefix));
    vi.stubEnv("FIRST_TREE_HOME", home);
    vi.stubEnv("FIRST_TREE_LOG_LEVEL", "error");
  }

  it("a login saved before the old handshake rejection still recovers without a second file change", async () => {
    stubHome("ft-early-login-");
    let authFrames = 0;
    let registered = 0;
    let serverUrl = "";
    const harness = await serve((frame, ws) => {
      if (frame.type === "auth" && ++authFrames === 1) {
        // Operator login wins before the old server reply reaches the runtime.
        saveCredentials({ serverUrl, accessToken: token("new"), refreshToken: "synthetic-new" });
        setTimeout(() => rejectAuth(ws), 50);
      } else if (frame.type === "auth") {
        acceptAuth(ws);
      } else if (frame.type === "client:register") {
        registered++;
        ws.send(JSON.stringify({ type: "client:registered" }));
      }
    });
    serverUrl = harness.serverUrl;
    saveCredentials({ serverUrl, accessToken: token("old"), refreshToken: "synthetic-old" });

    const runtime = new ClientRuntime(serverUrl, "synthetic-early-login", { output: silentOutput });
    const registrations = vi.fn();
    runtime.onRegistered(registrations);
    let pauses = 0;
    runtime.onAuthPaused(() => pauses++);
    const starting = runtime.start().then(
      () => "registered",
      () => "rejected",
    );
    try {
      const outcome = await Promise.race([starting, sleep(3_000).then(() => "still-pending")]);
      expect(outcome).toBe("registered");
      expect(registered).toBe(1);
      expect(authFrames).toBe(2);
      expect(pauses).toBe(1);
      expect(registrations).toHaveBeenCalledExactlyOnceWith(false);
    } finally {
      await runtime.stop("synthetic race complete");
      await starting;
      await harness.close();
    }
  }, 15_000);

  it("a login saved after the pause recovers through the real credentials watcher", async () => {
    stubHome("ft-late-login-");
    const oldToken = token("old");
    const newToken = token("new");
    let sockets = 0;
    let authFrames = 0;
    let registered = 0;
    const harness = await serve(
      (frame, ws) => {
        if (frame.type === "auth") {
          authFrames++;
          if (frame.token === newToken) {
            acceptAuth(ws);
          } else {
            rejectAuth(ws);
          }
        } else if (frame.type === "client:register") {
          registered++;
          ws.send(JSON.stringify({ type: "client:registered" }));
        }
      },
      () => sockets++,
    );
    const serverUrl = harness.serverUrl;
    saveCredentials({ serverUrl, accessToken: oldToken, refreshToken: "synthetic-old" });

    const runtime = new ClientRuntime(serverUrl, "synthetic-late-login", { output: silentOutput });
    let pauses = 0;
    runtime.onAuthPaused(() => pauses++);
    const starting = runtime.start().then(
      () => "registered",
      () => "rejected",
    );
    try {
      await waitFor(() => pauses === 1);
      // The immediate post-pause reconciliation saw unchanged credentials:
      // parked, with zero repeat socket/auth work.
      await sleep(700);
      expect(runtime.isPaused()).toBe(true);
      expect(sockets).toBe(1);
      expect(authFrames).toBe(1);

      saveCredentials({ serverUrl, accessToken: newToken, refreshToken: "synthetic-new" });
      const outcome = await Promise.race([starting, sleep(5_000).then(() => "still-pending")]);
      expect(outcome).toBe("registered");
      expect(registered).toBe(1);
      expect(authFrames).toBe(2);
      expect(pauses).toBe(1);
    } finally {
      await runtime.stop("synthetic test complete");
      await starting;
      await harness.close();
    }
  }, 15_000);

  it("unchanged credentials stay parked across rejections until a real login arrives", async () => {
    stubHome("ft-unchanged-parked-");
    const goodToken = token("good");
    let sockets = 0;
    let authFrames = 0;
    let registered = 0;
    const harness = await serve(
      (frame, ws) => {
        if (frame.type === "auth") {
          authFrames++;
          if (frame.token === goodToken) {
            acceptAuth(ws);
          } else {
            rejectAuth(ws);
          }
        } else if (frame.type === "client:register") {
          registered++;
          ws.send(JSON.stringify({ type: "client:registered" }));
        }
      },
      () => sockets++,
    );
    const serverUrl = harness.serverUrl;
    const v1Creds = { serverUrl, accessToken: token("v1"), refreshToken: "synthetic-v1" };
    const v2Creds = { serverUrl, accessToken: token("v2"), refreshToken: "synthetic-v2" };
    saveCredentials(v1Creds);

    const runtime = new ClientRuntime(serverUrl, "synthetic-unchanged-parked", { output: silentOutput });
    let pauses = 0;
    runtime.onAuthPaused(() => pauses++);
    const starting = runtime.start().then(
      () => "registered",
      () => "rejected",
    );
    try {
      await waitFor(() => pauses === 1);
      await sleep(700);
      expect(runtime.isPaused()).toBe(true);
      expect(sockets).toBe(1);
      expect(authFrames).toBe(1);

      // Rewriting the identical file is not a credential change: still parked.
      saveCredentials(v1Creds);
      await sleep(700);
      expect(sockets).toBe(1);
      expect(authFrames).toBe(1);
      expect(pauses).toBe(1);

      // A login the server also rejects resumes exactly once, then parks again.
      saveCredentials(v2Creds);
      await waitFor(() => pauses === 2);
      await sleep(700);
      expect(runtime.isPaused()).toBe(true);
      expect(sockets).toBe(2);
      expect(authFrames).toBe(2);

      // A file event matching the current failed authority cannot unpause it.
      saveCredentials(v2Creds);
      await sleep(700);
      expect(sockets).toBe(2);
      expect(authFrames).toBe(2);
      expect(pauses).toBe(2);

      // A genuine credential change recovers.
      saveCredentials({ serverUrl, accessToken: goodToken, refreshToken: "synthetic-good" });
      const outcome = await Promise.race([starting, sleep(5_000).then(() => "still-pending")]);
      expect(outcome).toBe("registered");
      expect(registered).toBe(1);
      expect(sockets).toBe(3);
      expect(authFrames).toBe(3);
      expect(pauses).toBe(2);
    } finally {
      await runtime.stop("synthetic test complete");
      await starting;
      await harness.close();
    }
  }, 15_000);

  it("a refresh-token failure parks and a later login recovers with the rotated token", async () => {
    stubHome("ft-refresh-failed-");
    const staleToken = `synthetic.${Buffer.from(
      JSON.stringify({ sub: "synthetic-owner", jti: "stale", exp: 1 }),
    ).toString("base64url")}.signature`;
    const counts = { refresh401: 0, refresh200: 0, sockets: 0, registrations: 0 };
    const harness = await serve(
      (frame, ws) => {
        if (frame.type === "auth") {
          acceptAuth(ws);
        } else if (frame.type === "client:register") {
          counts.registrations++;
          ws.send(JSON.stringify({ type: "client:registered" }));
        }
      },
      () => counts.sockets++,
      (body, respond) => {
        const refreshToken = (JSON.parse(body) as { refreshToken?: string }).refreshToken;
        if (refreshToken === "synthetic-recovered") {
          counts.refresh200++;
          respond(200, JSON.stringify({ accessToken: token("rotated"), refreshToken: "synthetic-rotated" }));
        } else {
          counts.refresh401++;
          respond(401);
        }
      },
    );
    const serverUrl = harness.serverUrl;
    saveCredentials({ serverUrl, accessToken: staleToken, refreshToken: "synthetic-dead" });

    const runtime = new ClientRuntime(serverUrl, "synthetic-refresh-failed", { output: silentOutput });
    let pauses = 0;
    runtime.onAuthPaused(() => pauses++);
    const starting = runtime.start().then(
      () => "registered",
      () => "rejected",
    );
    try {
      await waitFor(() => pauses === 1);
      expect(runtime.pausedReason()).toBe("auth_refresh_failed");
      // Unchanged credentials: parked, and the 401 latch keeps the failed
      // authority from re-hitting the network.
      await sleep(700);
      expect(runtime.isPaused()).toBe(true);
      expect(counts).toEqual({ refresh401: 1, refresh200: 0, sockets: 1, registrations: 0 });

      // Formatting, field order, and unrelated metadata do not change auth identity.
      writeFileSync(
        join(home, "config", "credentials.json"),
        JSON.stringify({ note: "edited", refreshToken: "synthetic-dead", accessToken: staleToken, serverUrl }, null, 2),
      );
      await sleep(700);
      expect(runtime.isPaused()).toBe(true);
      expect(counts).toEqual({ refresh401: 1, refresh200: 0, sockets: 1, registrations: 0 });

      saveCredentials({ serverUrl, accessToken: staleToken, refreshToken: "synthetic-recovered" });
      const outcome = await Promise.race([starting, sleep(5_000).then(() => "still-pending")]);
      expect(outcome).toBe("registered");
      // The handshake used the token produced by the successful refresh —
      // the refresh itself rotated and persisted the credentials first.
      expect(counts.refresh200).toBe(1);
      expect(counts.registrations).toBe(1);
      expect(counts.sockets).toBe(2);
      expect(pauses).toBe(1);
    } finally {
      await runtime.stop("synthetic test complete");
      await starting;
      await harness.close();
    }
  }, 15_000);
});
