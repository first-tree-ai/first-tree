import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { healthzRoutes } from "../api/healthz.js";
import { createTestApp } from "./helpers.js";

type UnknownFn = (...args: unknown[]) => unknown;
type CapturedRoute = {
  method: string;
  path: string;
  options: unknown;
  handler: UnknownFn;
};

function createApp(overrides: Record<string, unknown> = {}): { app: Record<string, unknown>; routes: CapturedRoute[] } {
  const routes: CapturedRoute[] = [];
  const registerRoute = (method: string) => (path: string, optionsOrHandler?: unknown, maybeHandler?: unknown) => {
    const handler = typeof optionsOrHandler === "function" ? optionsOrHandler : maybeHandler;
    const options = typeof optionsOrHandler === "function" ? undefined : optionsOrHandler;
    if (typeof handler !== "function") throw new Error(`Missing handler for ${method} ${path}`);
    routes.push({ method, path, options, handler: handler as UnknownFn });
    return app;
  };
  const app = {
    db: { execute: vi.fn(async () => [{ one: 1 }]) },
    get: registerRoute("GET"),
    ...overrides,
  };
  return { app, routes };
}

function replyDouble(): { status: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> } {
  const reply = {
    status: vi.fn(() => reply),
    send: vi.fn((body: unknown) => body),
  };
  return reply;
}

async function registerHealthz(execute: ReturnType<typeof vi.fn>): Promise<CapturedRoute> {
  const { app, routes } = createApp({ db: { execute } });
  await healthzRoutes(app as never);
  const route = routes[0];
  if (!route) throw new Error("Route was not captured");
  return route;
}

describe("/healthz database probe cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves a second request within the TTL from cache without probing again", async () => {
    const execute = vi.fn(async () => [{ one: 1 }]);
    const route = await registerHealthz(execute);

    const first = replyDouble();
    await route.handler({}, first);
    const second = replyDouble();
    await route.handler({}, second);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(first.status).toHaveBeenCalledWith(200);
    expect(second.status).toHaveBeenCalledWith(200);
  });

  it("re-probes after the TTL expires", async () => {
    const execute = vi.fn(async () => [{ one: 1 }]);
    const route = await registerHealthz(execute);

    await route.handler({}, replyDouble());
    vi.advanceTimersByTime(1_001);
    await route.handler({}, replyDouble());

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("caches a failed probe for the TTL instead of hammering a down database", async () => {
    const execute = vi.fn(async (): Promise<unknown> => {
      throw new Error("connection refused");
    });
    const route = await registerHealthz(execute);

    const first = replyDouble();
    await route.handler({}, first);
    const second = replyDouble();
    await route.handler({}, second);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(first.status).toHaveBeenCalledWith(503);
    expect(second.status).toHaveBeenCalledWith(503);

    // Recovery is visible once the cached failure expires.
    execute.mockResolvedValue([{ one: 1 }]);
    vi.advanceTimersByTime(1_001);
    const third = replyDouble();
    await route.handler({}, third);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(third.status).toHaveBeenCalledWith(200);
  });

  it("shares one in-flight probe between concurrent requests (single-flight)", async () => {
    let release: (value: unknown) => void = () => {};
    const execute = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const route = await registerHealthz(execute);

    const firstReply = replyDouble();
    const secondReply = replyDouble();
    const first = route.handler({}, firstReply);
    const second = route.handler({}, secondReply);
    release([{ one: 1 }]);
    await Promise.all([first, second]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(firstReply.status).toHaveBeenCalledWith(200);
    expect(secondReply.status).toHaveBeenCalledWith(200);
  });
});

describe("/healthz rate limit", () => {
  it("allows 120 requests per minute per IP and rejects the 121st", async () => {
    const app = await createTestApp();
    try {
      const probe = () => app.inject({ method: "GET", url: "/healthz" });

      for (let i = 1; i <= 120; i++) {
        const res = await probe();
        expect(res.statusCode).toBe(200);
      }
      const limited = await probe();
      expect(limited.statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});
