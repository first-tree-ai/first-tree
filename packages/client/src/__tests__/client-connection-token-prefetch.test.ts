import { EventEmitter } from "node:events";
import { WS_AUTH_FRAME_TIMEOUT_MS } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

type ClientConnectionModule = typeof import("../runtime/client-connection.js");
type ClientConnectionInstance = InstanceType<ClientConnectionModule["ClientConnection"]>;
type ClientConnectionConfig = ConstructorParameters<ClientConnectionModule["ClientConnection"]>[0];

type ClientConnectionPrivate = {
  ws: FakeWebSocket | null;
  closing: boolean;
  registered: boolean;
  openWebSocket(): Promise<void>;
  clearTimers(): void;
};

type FakeWebSocketOptions = {
  headers?: Record<string, string>;
};

class FakeWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly options?: FakeWebSocketOptions;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  terminate = vi.fn(() => {
    this.readyState = FakeWebSocket.CLOSED;
  });
  ping = vi.fn();

  constructor(url: string, options?: FakeWebSocketOptions) {
    super();
    this.url = url;
    this.options = options;
    FakeWebSocket.instances.push(this);
  }

  send(raw: string): void {
    this.sent.push(raw);
  }

  close(code?: number, reason?: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.closeCalls.push({ code, reason });
    this.emit("close", code ?? 1000);
  }

  emitOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  emitMessage(frame: string | Record<string, unknown>): void {
    this.emit("message", typeof frame === "string" ? frame : JSON.stringify(frame));
  }
}

class AuthRefreshFailedError extends Error {
  constructor() {
    super("Refresh token rejected by server.");
    this.name = "AuthRefreshFailedError";
  }
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function priv(connection: ClientConnectionInstance): ClientConnectionPrivate {
  return connection as unknown as ClientConnectionPrivate;
}

async function loadClientConnection(): Promise<ClientConnectionModule> {
  vi.resetModules();
  FakeWebSocket.instances = [];
  vi.doMock("ws", () => ({ default: FakeWebSocket }));
  return import("../runtime/client-connection.js");
}

async function makeConnection(overrides: Partial<ClientConnectionConfig> = {}): Promise<ClientConnectionInstance> {
  const { ClientConnection } = await loadClientConnection();
  return new ClientConnection({
    serverUrl: "http://ws.test",
    clientId: "client_token_prefetch",
    getAccessToken: async () => makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    ...overrides,
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForLatestSocket(previousLength = 0): Promise<FakeWebSocket> {
  for (let i = 0; i < 30; i++) {
    if (FakeWebSocket.instances.length > previousLength) {
      const socket = FakeWebSocket.instances.at(-1);
      if (socket) return socket;
    }
    await Promise.resolve();
  }
  throw new Error("missing fake socket");
}

function completeHandshake(socket: FakeWebSocket): void {
  socket.emitOpen();
  socket.emitMessage({ type: "auth:ok" });
  socket.emitMessage({ type: "client:registered" });
}

function parseSent(socket: FakeWebSocket, index: number): Record<string, unknown> {
  return JSON.parse(socket.sent[index] ?? "{}") as Record<string, unknown>;
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
  started: Promise<void>;
  notifyStarted: () => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  let notifyStarted!: () => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const started = new Promise<void>((res) => {
    notifyStarted = res;
  });
  return { promise, resolve, reject, started, notifyStarted };
}

describe("ClientConnection — prefetch access token before WebSocket", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("ws");
    vi.resetModules();
  });

  it("does not open a socket while token acquisition exceeds the auth-frame deadline, then authenticates", async () => {
    vi.useFakeTimers();
    const token = deferred<string>();
    const minValidityMs: number[] = [];
    const connection = await makeConnection({
      getAccessToken: async (opts) => {
        minValidityMs.push(opts?.minValidityMs ?? -1);
        token.notifyStarted();
        return token.promise;
      },
    });
    connection.on("error", () => {});

    const connectPromise = connection.connect();
    await token.started;
    expect(FakeWebSocket.instances).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(WS_AUTH_FRAME_TIMEOUT_MS + 1_000);
    await flushMicrotasks();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(minValidityMs).toEqual([65_000]);

    token.resolve(makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }));
    const socket = await waitForLatestSocket();
    completeHandshake(socket);
    await connectPromise;

    expect(connection.isConnected).toBe(true);
    expect(parseSent(socket, 0)).toMatchObject({ type: "auth" });
    expect(socket.sent.map((raw) => JSON.parse(raw) as { type?: string }).map((frame) => frame.type)).toEqual([
      "auth",
      "client:register",
    ]);

    await connection.disconnect();
    priv(connection).clearTimers();
  });

  it("disconnect during acquisition settles without a later socket even if the provider ignores abort", async () => {
    vi.useFakeTimers();
    const token = deferred<string>();
    const connection = await makeConnection({
      getAccessToken: async () => {
        token.notifyStarted();
        return token.promise;
      },
    });
    connection.on("error", () => {});

    const connectPromise = connection.connect();
    await token.started;
    expect(FakeWebSocket.instances).toHaveLength(0);

    const disconnectPromise = connection.disconnect();
    await expect(connectPromise).rejects.toBeDefined();
    await disconnectPromise;
    expect(FakeWebSocket.instances).toHaveLength(0);

    token.resolve(makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(WS_AUTH_FRAME_TIMEOUT_MS);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(connection.isConnected).toBe(false);
    expect(connection.isPaused()).toBe(false);

    priv(connection).clearTimers();
  });

  it("an obsolete token success cannot create a socket for a successor connection", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let calls = 0;
    const connection = await makeConnection({
      getAccessToken: async () => {
        calls += 1;
        if (calls === 1) {
          first.notifyStarted();
          return first.promise;
        }
        second.notifyStarted();
        return second.promise;
      },
    });
    connection.on("error", () => {});
    const internal = priv(connection);

    const firstAttempt = internal.openWebSocket();
    await first.started;
    expect(FakeWebSocket.instances).toHaveLength(0);

    const secondAttempt = internal.openWebSocket();
    await expect(firstAttempt).rejects.toBeDefined();
    await second.started;
    expect(FakeWebSocket.instances).toHaveLength(0);

    first.resolve(makeJwt({ sub: "stale", exp: Math.floor(Date.now() / 1000) + 3600 }));
    await flushMicrotasks();
    expect(FakeWebSocket.instances).toHaveLength(0);

    const liveToken = makeJwt({ sub: "live", exp: Math.floor(Date.now() / 1000) + 3600 });
    second.resolve(liveToken);
    const socket = await waitForLatestSocket();
    completeHandshake(socket);
    await secondAttempt;

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(parseSent(socket, 0)).toMatchObject({ type: "auth", token: liveToken });
    expect(connection.isPaused()).toBe(false);

    await connection.disconnect();
    internal.clearTimers();
  });

  it("an obsolete token rejection cannot pause a successor connection", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let calls = 0;
    const connection = await makeConnection({
      getAccessToken: async () => {
        calls += 1;
        if (calls === 1) {
          first.notifyStarted();
          return first.promise;
        }
        second.notifyStarted();
        return second.promise;
      },
    });
    const paused: string[] = [];
    connection.on("auth:paused", (reason) => paused.push(reason));
    connection.on("error", () => {});
    const internal = priv(connection);

    const firstAttempt = internal.openWebSocket();
    await first.started;
    const secondAttempt = internal.openWebSocket();
    await expect(firstAttempt).rejects.toBeDefined();
    await second.started;

    second.resolve(makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }));
    const socket = await waitForLatestSocket();
    completeHandshake(socket);
    await secondAttempt;
    expect(connection.isConnected).toBe(true);

    first.reject(new AuthRefreshFailedError());
    await flushMicrotasks();
    expect(paused).toEqual([]);
    expect(connection.isPaused()).toBe(false);
    expect(connection.isConnected).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(1);

    await connection.disconnect();
    internal.clearTimers();
  });

  it("established reconnect still authenticates after prefetching a token", async () => {
    vi.useFakeTimers();
    const connection = await makeConnection();
    connection.on("error", () => {});

    const connectPromise = connection.connect();
    const first = await waitForLatestSocket();
    completeHandshake(first);
    await connectPromise;
    expect(connection.isConnected).toBe(true);

    first.close(1006, "drop");
    await vi.advanceTimersByTimeAsync(1_000);
    const second = await waitForLatestSocket(1);
    completeHandshake(second);
    await waitForConnected(connection);

    expect(connection.isConnected).toBe(true);
    expect(parseSent(second, 0)).toMatchObject({ type: "auth" });
    expect(FakeWebSocket.instances).toHaveLength(2);

    await connection.disconnect();
    priv(connection).clearTimers();
  });

  it("stop during reconnect acquisition does not create a later socket", async () => {
    vi.useFakeTimers();
    const reconnectToken = deferred<string>();
    let calls = 0;
    const connection = await makeConnection({
      getAccessToken: async () => {
        calls += 1;
        if (calls === 1) return makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
        reconnectToken.notifyStarted();
        return reconnectToken.promise;
      },
    });
    connection.on("error", () => {});

    const connectPromise = connection.connect();
    const first = await waitForLatestSocket();
    completeHandshake(first);
    await connectPromise;

    first.close(1006, "drop");
    await vi.advanceTimersByTimeAsync(1_000);
    await reconnectToken.started;
    expect(FakeWebSocket.instances).toHaveLength(1);

    await connection.disconnect();
    reconnectToken.resolve(makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(WS_AUTH_FRAME_TIMEOUT_MS);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(connection.isConnected).toBe(false);
    expect(connection.isPaused()).toBe(false);

    priv(connection).clearTimers();
  });

  it.each([
    "success",
    "rejection",
  ])("a stopped initial connect cannot interfere with an immediate restart after late %s", async (outcome) => {
    vi.useFakeTimers();
    const first = deferred<string>();
    const second = deferred<string>();
    let calls = 0;
    const errors: Error[] = [];
    const connection = await makeConnection({
      getAccessToken: () => {
        calls++;
        const token = calls === 1 ? first : second;
        token.notifyStarted();
        return token.promise;
      },
    });
    connection.on("error", (error) => errors.push(error));
    const firstConnect = connection.connect();
    let firstOutcome = "pending";
    const firstSettled = firstConnect.then(
      () => {
        firstOutcome = "connected";
      },
      () => {
        firstOutcome = "stopped";
      },
    );
    await first.started;
    // Restart before the aborted connect loop has had a microtask to unwind.
    const stopped = connection.disconnect();
    const secondConnect = connection.connect();
    const secondSettled = secondConnect.catch(() => {});
    try {
      await stopped;
      await second.started;
      await vi.advanceTimersByTimeAsync(0);
      expect(firstOutcome).toBe("stopped");
      second.resolve(makeJwt({ sub: "live", exp: Math.floor(Date.now() / 1000) + 3600 }));
      const socket = await waitForLatestSocket();
      completeHandshake(socket);
      await secondConnect;

      if (outcome === "success") {
        // A wrongly installed timer would refresh this token one second later.
        first.resolve(makeJwt({ sub: "retired", exp: Math.floor(Date.now() / 1000) + 61 }));
      } else {
        first.reject(new AuthRefreshFailedError());
      }
      await vi.advanceTimersByTimeAsync(2_000);
      expect(calls).toBe(2);
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(connection.isConnected).toBe(true);
      expect(connection.isPaused()).toBe(false);
      expect(socket.closeCalls).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await connection.disconnect();
      void firstSettled;
      void secondSettled;
    }
  });

  it.each(["connecting", "open"])("disconnect settles a socket that is %s before registration", async (phase) => {
    vi.useFakeTimers();
    const connection = await makeConnection();
    const errors: Error[] = [];
    connection.on("error", (error) => errors.push(error));
    let outcome = "pending";
    const connecting = connection.connect();
    const settled = connecting.then(
      () => {
        outcome = "connected";
      },
      () => {
        outcome = "stopped";
      },
    );
    const socket = await waitForLatestSocket();
    if (phase === "open") socket.emitOpen();
    try {
      await connection.disconnect();
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBe("stopped");
      expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
      // ws emits an asynchronous error when an upgrade is terminated.
      expect(() => socket.emit("error", new Error("upgrade aborted"))).not.toThrow();
      expect(errors).toEqual([]);
      expect(connection.isConnected).toBe(false);
    } finally {
      await connection.disconnect();
      // A failed pre-fix assertion must not leave the local promise unhandled.
      void settled;
    }
  });

  it("retired socket callbacks cannot replace a successor or clear its connect timeout", async () => {
    vi.useFakeTimers();
    const connection = await makeConnection();
    const errors: Error[] = [];
    connection.on("error", (error) => errors.push(error));
    const internal = priv(connection);
    let firstOutcome = "pending";
    const firstAttempt = internal.openWebSocket();
    const firstSettled = firstAttempt.then(
      () => {
        firstOutcome = "connected";
      },
      () => {
        firstOutcome = "retired";
      },
    );
    const first = await waitForLatestSocket();
    const secondAttempt = internal.openWebSocket();
    const secondOutcome = secondAttempt.then(
      () => null,
      (error: unknown) => error,
    );
    const second = await waitForLatestSocket(1);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(firstOutcome).toBe("retired");
      first.emitOpen();
      first.emitMessage({ type: "auth:rejected", code: "invalid_token" });
      first.emit("close", 1006);
      first.emit("error", new Error("retired upgrade error"));
      expect(internal.ws).toBe(second);
      expect(first.sent).toEqual([]);
      expect(connection.isPaused()).toBe(false);
      expect(errors).toEqual([]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await secondOutcome).toEqual(new Error("WebSocket connect timeout"));
      expect(second.terminate).toHaveBeenCalledOnce();
    } finally {
      await connection.disconnect();
      void firstSettled;
    }
  });

  it("a cancelled reconnect prefetch cannot schedule another attempt after an immediate restart", async () => {
    vi.useFakeTimers();
    const oldReconnect = deferred<string>();
    let calls = 0;
    const errors: Error[] = [];
    const connection = await makeConnection({
      getAccessToken: () => {
        calls++;
        if (calls === 2) {
          oldReconnect.notifyStarted();
          return oldReconnect.promise;
        }
        return Promise.resolve(makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }));
      },
    });
    connection.on("error", (error) => errors.push(error));
    const initial = connection.connect();
    const first = await waitForLatestSocket();
    completeHandshake(first);
    await initial;
    first.close(1006, "drop");
    await vi.advanceTimersByTimeAsync(1_000);
    await oldReconnect.started;
    const stopped = connection.disconnect();
    const restarted = connection.connect();
    const handled = restarted.catch(() => {});
    try {
      await stopped;
      const second = await waitForLatestSocket(1);
      completeHandshake(second);
      await restarted;
      oldReconnect.reject(new AuthRefreshFailedError());
      await vi.advanceTimersByTimeAsync(3_000);
      expect(calls).toBe(3);
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(connection.isConnected).toBe(true);
      expect(connection.isPaused()).toBe(false);
      expect(second.closeCalls).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await connection.disconnect();
      await handled;
    }
  });

  it.each([
    "success",
    "rejection",
    "rate limit",
  ])("ignores an old proactive refresh %s after its socket is replaced", async (outcome) => {
    vi.useFakeTimers();
    const oldRefresh = deferred<string>();
    let calls = 0;
    const connection = await makeConnection({
      getAccessToken: () => {
        calls++;
        if (calls === 2) {
          oldRefresh.notifyStarted();
          return oldRefresh.promise;
        }
        const validitySeconds = calls === 1 ? 61 : 3600;
        return Promise.resolve(makeJwt({ exp: Math.floor(Date.now() / 1000) + validitySeconds }));
      },
    });
    connection.on("error", () => {});
    const initial = connection.connect();
    const first = await waitForLatestSocket();
    completeHandshake(first);
    await initial;
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      await oldRefresh.started;
      first.close(1006, "drop during refresh");
      await vi.advanceTimersByTimeAsync(1_000);
      const second = await waitForLatestSocket(1);
      completeHandshake(second);
      if (outcome === "success") {
        oldRefresh.resolve(makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }));
      } else if (outcome === "rejection") {
        oldRefresh.reject(new AuthRefreshFailedError());
      } else {
        oldRefresh.reject(
          Object.assign(new Error("rate limited"), {
            name: "AuthRefreshRateLimitedError",
            retryAfterMs: 30_000,
          }),
        );
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(connection.isConnected).toBe(true);
      expect(connection.isPaused()).toBe(false);
      expect(second.closeCalls).toEqual([]);
      expect(calls).toBe(3);
      // A stale rate-limit result must not defer the new lifecycle's next retry.
      second.close(1006, "next drop");
      await vi.advanceTimersByTimeAsync(1_000);
      const third = await waitForLatestSocket(2);
      completeHandshake(third);
      expect(calls).toBe(4);
    } finally {
      await connection.disconnect();
    }
  });

  it("synchronous credential recovery during reconnect schedules only one successor", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const connection = await makeConnection({
      getAccessToken: async () => {
        calls++;
        if (calls === 2) throw new AuthRefreshFailedError();
        return makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
      },
    });
    connection.on("error", () => {});
    connection.on("auth:paused", () => connection.clearPaused());
    const initial = connection.connect();
    const first = await waitForLatestSocket();
    completeHandshake(first);
    await initial;
    try {
      first.close(1006, "drop");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toBe(2);
      expect(connection.isPaused()).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      const second = await waitForLatestSocket(1);
      completeHandshake(second);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toBe(3);
      expect(FakeWebSocket.instances).toHaveLength(2);
      expect(connection.isConnected).toBe(true);
    } finally {
      await connection.disconnect();
    }
  });

  it("a synchronous token-provider AuthRefreshFailedError parks without opening a socket", async () => {
    const connection = await makeConnection({
      getAccessToken: () => {
        throw new AuthRefreshFailedError();
      },
    });
    connection.on("error", () => {});

    const connectPromise = connection.connect();
    await waitForPaused(connection);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(connection.getPausedReason()).toBe("auth_refresh_failed");

    await connection.disconnect();
    await expect(connectPromise).rejects.toThrow(/Refresh token/);
  });

  it("a synchronous token-provider error rejects the handshake without opening a socket", async () => {
    const connection = await makeConnection({
      getAccessToken: () => {
        throw new Error("disk gone");
      },
    });
    await expect(priv(connection).openWebSocket()).rejects.toThrow("disk gone");
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(connection.isPaused()).toBe(false);
  });
});

async function waitForConnected(connection: ClientConnectionInstance): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (connection.isConnected) return;
    await Promise.resolve();
  }
  throw new Error("connection did not become connected");
}

async function waitForPaused(connection: ClientConnectionInstance): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (connection.isPaused()) return;
    await Promise.resolve();
  }
  throw new Error("connection did not pause");
}
