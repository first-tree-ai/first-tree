import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { AgentRuntime } from "../runtime/runtime.js";

// Keep connection/authentication real; agent execution is outside this entry-point contract.
const slots = vi.hoisted(() => ({ start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) }));
vi.mock("../runtime/agent-slot.js", () => ({
  AgentSlot: class {
    start = slots.start;
    stop = slots.stop;
  },
}));

function refreshRejected(): Error {
  const error = new Error("Refresh token rejected");
  error.name = "AuthRefreshFailedError";
  return error;
}

async function serve() {
  const http = createServer();
  const ws = new WebSocketServer({ server: http, path: "/api/v1/agent/ws/client" });
  const counts = { connections: 0, registrations: 0 };
  ws.on("connection", (socket) => {
    counts.connections++;
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "auth") {
        if (frame.token !== "fresh-token") {
          socket.send(JSON.stringify({ type: "auth:rejected", code: "invalid_token" }));
          socket.close(4401, "auth rejected");
        } else {
          socket.send(JSON.stringify({ type: "auth:ok" }));
        }
      } else if (frame.type === "client:register") {
        counts.registrations++;
        socket.send(JSON.stringify({ type: "client:registered" }));
      }
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  return {
    counts,
    config: {
      server: `http://127.0.0.1:${address.port}`,
      agents: {
        test: {
          agentId: "test-agent",
          type: "test",
          concurrency: 1,
          session: { idle_timeout: 300, max_sessions: 1, working_grace_seconds: 60, reconcile_interval_seconds: 300 },
        },
      },
    },
    close: async () => {
      for (const socket of ws.clients) socket.terminate();
      await new Promise<void>((resolve) => ws.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

const handlerFactories = {
  test: () => {
    throw new Error("Agent handler should not be used by this connection test");
  },
};

describe("AgentRuntime authentication recovery through its public API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it.each([
    "handshake",
    "refresh",
  ] as const)("recovers from initial %s rejection after an explicit host update", async (failure) => {
    const harness = await serve();
    let token = "rejected-token";
    const provider = vi.fn(async () => {
      if (failure === "refresh" && token !== "fresh-token") throw refreshRejected();
      return token;
    });
    const paused = vi.fn();
    let shutdown: (() => Promise<void>) | undefined;
    const originalOn = process.on.bind(process);
    vi.spyOn(process, "on").mockImplementation((event, listener) => {
      if (event === "SIGTERM")
        shutdown = async () => {
          await listener();
        };
      else if (event !== "SIGINT") originalOn(event, listener);
      return process;
    });
    const runtime = new AgentRuntime({
      config: harness.config,
      handlerFactories,
      getAccessToken: provider,
      onAuthPaused: paused,
    });
    expect(runtime.getPausedReason()).toBeNull();
    const starting = runtime.start().then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await vi.waitFor(() => expect(paused).toHaveBeenCalledOnce(), { timeout: 3_000 });
      expect(runtime.getPausedReason()).toBe(failure === "refresh" ? "auth_refresh_failed" : "auth_rejected");
      expect(slots.start).not.toHaveBeenCalled();
      token = "fresh-token";
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(provider).toHaveBeenCalledOnce();
      expect(harness.counts.registrations).toBe(0);

      runtime.resumeAfterCredentialsChange();
      await vi.waitFor(() => expect(shutdown).toBeDefined(), { timeout: 3_000 });
      expect(runtime.getPausedReason()).toBeNull();
      expect(harness.counts).toEqual({ connections: 2, registrations: 1 });
      expect(provider).toHaveBeenCalledTimes(2);
      expect(slots.start).toHaveBeenCalledOnce();
      await shutdown?.();
      expect(await starting).toBeNull();
      runtime.resumeAfterCredentialsChange();
      expect(provider).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.stop();
      await harness.close();
    }
  });

  it.each([
    "sync",
    "async",
  ] as const)("stops an initially paused runtime despite a %s observer failure and cannot revive it", async (failure) => {
    const harness = await serve();
    const provider = vi.fn(async () => {
      throw refreshRejected();
    });
    const runtime = new AgentRuntime({
      config: harness.config,
      handlerFactories,
      getAccessToken: provider,
      onAuthPaused: () => {
        if (failure === "async") return Promise.reject(new Error("Host observer failed asynchronously"));
        throw new Error("Host observer failed");
      },
    });
    const starting = runtime.start().then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await vi.waitFor(() => expect(runtime.getPausedReason()).toBe("auth_refresh_failed"), { timeout: 3_000 });
      await runtime.stop();
      expect(await starting).toMatchObject({ name: "AuthRefreshFailedError" });
      runtime.resumeAfterCredentialsChange();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(provider).toHaveBeenCalledOnce();
      expect(harness.counts).toEqual({ connections: 1, registrations: 0 });
      expect(slots.start).not.toHaveBeenCalled();
    } finally {
      await runtime.stop();
      await harness.close();
    }
  });
});
