import { afterEach, describe, expect, it, vi } from "vitest";
import type { HealthzOptions } from "../api/healthz.js";
import { DEFAULT_PROBE_CACHE_TTL_MS, healthzRoutes } from "../api/healthz.js";

type UnknownFn = (...args: unknown[]) => unknown;
type CapturedRoute = {
  path: string;
  options: unknown;
  handler: UnknownFn;
};

type ReplyDouble = {
  status: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};

function replyDouble(): ReplyDouble {
  const reply = {
    status: vi.fn(() => reply),
    send: vi.fn((body: unknown) => body),
  };
  return reply;
}

async function registerHealthz(
  execute: UnknownFn,
  opts?: HealthzOptions,
): Promise<{ handler: UnknownFn; options: unknown }> {
  const routes: CapturedRoute[] = [];
  const app = {
    db: { execute },
    get: (path: string, options: unknown, handler: UnknownFn) => {
      routes.push({ path, options, handler });
      return app;
    },
  };
  await healthzRoutes(app as never, opts);
  expect(routes).toHaveLength(1);
  const route = routes[0];
  if (!route) throw new Error("Route was not captured");
  expect(route.path).toBe("/healthz");
  return { handler: route.handler, options: route.options };
}

describe("/healthz database probe cache", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("keeps rate limiting disabled so orchestrator probes are never rejected", async () => {
    const { options } = await registerHealthz(vi.fn(async () => [{ one: 1 }]));
    expect(options).toEqual({ config: { rateLimit: false } });
  });

  it("serves repeated requests within the TTL from one database probe", async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => [{ one: 1 }]);
    const { handler } = await registerHealthz(execute);

    for (let i = 0; i < 5; i++) {
      const reply = replyDouble();
      await handler({}, reply);
      expect(reply.status).toHaveBeenCalledWith(200);
      expect(reply.send).toHaveBeenCalledWith({ status: "ok" });
    }
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("probes the database again after the TTL expires", async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => [{ one: 1 }]);
    const { handler } = await registerHealthz(execute);

    await handler({}, replyDouble());
    expect(execute).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(DEFAULT_PROBE_CACHE_TTL_MS - 1);
    await handler({}, replyDouble());
    expect(execute).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await handler({}, replyDouble());
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("caches an unhealthy probe so a down database is not hammered", async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => {
      throw new Error("connection refused");
    });
    const { handler } = await registerHealthz(execute);

    for (let i = 0; i < 5; i++) {
      const reply = replyDouble();
      await handler({}, reply);
      expect(reply.status).toHaveBeenCalledWith(503);
      expect(reply.send).toHaveBeenCalledWith({ status: "error", message: "database unreachable" });
    }
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("reports recovery on the first probe after the TTL expires", async () => {
    vi.useFakeTimers();
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValue([{ one: 1 }]);
    const { handler } = await registerHealthz(execute);

    const downReply = replyDouble();
    await handler({}, downReply);
    expect(downReply.status).toHaveBeenCalledWith(503);

    vi.advanceTimersByTime(DEFAULT_PROBE_CACHE_TTL_MS);
    const upReply = replyDouble();
    await handler({}, upReply);
    expect(upReply.status).toHaveBeenCalledWith(200);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight probe across concurrent requests", async () => {
    let resolveProbe: (() => void) | undefined;
    const execute = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const { handler } = await registerHealthz(execute);

    const first = replyDouble();
    const second = replyDouble();
    const pending = Promise.all([handler({}, first), handler({}, second)]);
    expect(execute).toHaveBeenCalledTimes(1);

    resolveProbe?.();
    await pending;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(first.status).toHaveBeenCalledWith(200);
    expect(second.status).toHaveBeenCalledWith(200);
  });

  it("probes on every request when probeCacheTtlMs is 0", async () => {
    const execute = vi.fn(async () => [{ one: 1 }]);
    const { handler } = await registerHealthz(execute, { probeCacheTtlMs: 0 });

    await handler({}, replyDouble());
    await handler({}, replyDouble());
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
