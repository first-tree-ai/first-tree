import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { attachClientWsConnection } from "../api/agent/ws-client/connection.js";

/**
 * Real-wire containment tests for the client-WS auth gate (staging incident
 * 2026-09): a real local WebSocket server drives `attachClientWsConnection`
 * end to end, while the database is replaced by a controllable deferred user
 * lookup. No external services are involved — the lookup stands in for the
 * users table so slow/late completions can be scripted deterministically.
 */

const TEST_SECRET = "ws-auth-single-attempt-wire-secret";
const jwtSecretBytes = new TextEncoder().encode(TEST_SECRET);
const TEST_USER_ID = "01960000-0000-7000-8000-0000000000bb";

type SentFrame = { type?: string; code?: string; [key: string]: unknown };

type DeferredLookup = {
  queries: number;
  promise: Promise<Array<{ id: string; status: string }>>;
  resolve(rows: Array<{ id: string; status: string }>): void;
  reject(err: unknown): void;
};

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

type ServerSocketProbe = {
  sentFrames: SentFrame[];
  /** Raw close() calls, including the ws library's internal close-handshake
   * bookkeeping (`Receiver.receiverOnConclude`, which passes a Buffer reason
   * echoed from the peer's close frame — or no reason at all). */
  closeCalls: Array<{ code?: number; reason?: unknown }>;
  closed: boolean;
};

/** Close calls initiated by our code — the gate always passes a string reason. */
function gateCloseCalls(probe: ServerSocketProbe | undefined): Array<{ code?: number; reason?: unknown }> {
  return (probe?.closeCalls ?? []).filter((call) => typeof call.reason === "string");
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for server-side condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("client WS auth single-attempt containment — real wire, mocked DB", () => {
  let wss: WebSocketServer;
  let wsUrl: string;
  let lookup: DeferredLookup;
  let appLog: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  let lastProbe: ServerSocketProbe | undefined;

  beforeAll(async () => {
    wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss.on("connection", (socket, req) => {
      const probe: ServerSocketProbe = { sentFrames: [], closeCalls: [], closed: false };
      lastProbe = probe;
      const originalSend = socket.send.bind(socket);
      socket.send = ((data: Parameters<WebSocket["send"]>[0]) => {
        try {
          probe.sentFrames.push(JSON.parse(String(data)) as SentFrame);
        } catch {
          // non-JSON frame; ignore
        }
        originalSend(data);
      }) as WebSocket["send"];
      const originalClose = socket.close.bind(socket);
      socket.close = ((code?: number, reason?: string) => {
        probe.closeCalls.push({ code, reason });
        originalClose(code, reason);
      }) as WebSocket["close"];
      socket.on("close", () => {
        probe.closed = true;
      });

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
        log: { ...appLog, debug: vi.fn() },
        commandVersion: () => "single-attempt-wire-test",
        config: { secrets: { jwtSecret: TEST_SECRET } },
      };
      // Casts are unavoidable: the connection is exercised against a scripted
      // in-memory app rather than a full Fastify + database boot.
      attachClientWsConnection(
        app as unknown as FastifyInstance,
        socket,
        { headers: req.headers, ip: "127.0.0.1" } as never,
        { subscribe: vi.fn(), unsubscribe: vi.fn(), notify: vi.fn() } as never,
        "test-instance",
      );
    });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const addr = wss.address();
    if (!addr || typeof addr === "string") throw new Error("test WS server has no address");
    wsUrl = `ws://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      wss.close((err) => (err ? reject(err) : resolve()));
    });
  });

  function freshHarness(): void {
    lookup = createDeferredLookup();
    appLog = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    lastProbe = undefined;
  }

  async function signAccessToken(expSecondsFromNow = 3600): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ sub: TEST_USER_ID, type: "access", organizationId: "org-wire-test" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime(now + expSecondsFromNow)
      .sign(jwtSecretBytes);
  }

  async function openClient(): Promise<{ ws: WebSocket; frames: SentFrame[] }> {
    const frames: SentFrame[] = [];
    const ws = new WebSocket(wsUrl);
    ws.on("message", (raw) => {
      try {
        frames.push(JSON.parse(raw.toString()) as SentFrame);
      } catch {
        // ignore non-JSON
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return { ws, frames };
  }

  function waitForClientClose(ws: WebSocket, timeoutMs = 5000): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for client close")), timeoutMs);
      ws.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  it("rejects duplicate in-flight auth frames deterministically with one query and no welcome", async () => {
    freshHarness();
    const token = await signAccessToken();
    const { ws, frames } = await openClient();

    // The first frame starts validation and reaches the deferred user
    // lookup; the duplicate arrives while that attempt is in flight and must
    // be rejected without starting another verification/DB pipeline.
    ws.send(JSON.stringify({ type: "auth", token }));
    await waitFor(() => lookup.queries === 1);
    ws.send(JSON.stringify({ type: "auth", token }));

    const closeCode = await waitForClientClose(ws);
    expect(closeCode).toBe(4401);

    const rejected = frames.filter((frame) => frame.type === "auth:rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.code).toBe("invalid_auth_frame");
    expect(frames.filter((frame) => frame.type === "server:welcome")).toHaveLength(0);
    expect(frames.filter((frame) => frame.type === "auth:ok")).toHaveLength(0);
    expect(lookup.queries).toBe(1);

    // The in-flight lookup completes late, on an already-terminal gate.
    lookup.resolve([{ id: TEST_USER_ID, status: "active" }]);
    await sleep(150);
    expect(appLog.warn).not.toHaveBeenCalled();
    const probe = lastProbe;
    expect(probe).toBeDefined();
    expect(probe?.sentFrames.filter((frame) => frame.type === "server:welcome")).toHaveLength(0);
    expect(gateCloseCalls(probe)).toHaveLength(1);
  });

  it("ignores a late lookup success when the client closes mid-validation", async () => {
    freshHarness();
    const token = await signAccessToken();
    const { ws } = await openClient();

    ws.send(JSON.stringify({ type: "auth", token }));
    await waitFor(() => lookup.queries === 1);
    const probe = lastProbe;
    expect(probe).toBeDefined();

    ws.close();
    await waitFor(() => probe?.closed === true);
    const sendsBeforeLateCompletion = probe?.sentFrames.length ?? 0;

    lookup.resolve([{ id: TEST_USER_ID, status: "active" }]);
    await sleep(150);

    expect(appLog.warn).not.toHaveBeenCalled();
    expect(probe?.sentFrames).toHaveLength(sendsBeforeLateCompletion);
    // The server never initiates its own close on the dead socket.
    expect(gateCloseCalls(probe)).toHaveLength(0);
  });

  it("completes the normal handshake and fires exactly one auth:expired at token exp", async () => {
    freshHarness();
    const token = await signAccessToken(2);
    const { ws, frames } = await openClient();

    ws.send(JSON.stringify({ type: "auth", token }));
    await waitFor(() => lookup.queries === 1);
    lookup.resolve([{ id: TEST_USER_ID, status: "active" }]);

    await waitFor(() => frames.some((frame) => frame.type === "auth:ok"));
    expect(frames.filter((frame) => frame.type === "server:welcome")).toHaveLength(1);
    expect(frames.filter((frame) => frame.type === "auth:ok")).toHaveLength(1);

    const closeCode = await waitForClientClose(ws, 8000);
    expect(closeCode).toBe(4401);
    // Exactly one expiry timer may exist: a duplicated timer would emit a
    // second auth:expired frame (and a second close attempt).
    expect(frames.filter((frame) => frame.type === "auth:expired")).toHaveLength(1);
    expect(gateCloseCalls(lastProbe)).toHaveLength(1);
  });
});
