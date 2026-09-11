import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("ensureFreshAccessToken — safety margin", () => {
  let testHome: string;
  let originalHome: string | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    testHome = join(tmpdir(), `ft-first-tree-fresh-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testHome, "config"), { recursive: true });

    originalHome = process.env.FIRST_TREE_HOME;
    process.env.FIRST_TREE_HOME = testHome;

    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.resetModules();
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
    else process.env.FIRST_TREE_HOME = originalHome;
    rmSync(testHome, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  async function writeCredentials(accessToken: string): Promise<void> {
    writeFileSync(
      join(testHome, "config", "credentials.json"),
      JSON.stringify({ accessToken, refreshToken: "refresh-xyz", serverUrl: "http://first-tree.test" }),
    );
  }

  it("returns the existing token when exp is comfortably in the future", async () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(token);

    const { ensureFreshAccessToken } = await import("../core/bootstrap.js");
    const result = await ensureFreshAccessToken();

    expect(result).toBe(token);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves access tokens, masks tokens, and ignores malformed credential files", async () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(token);

    const { loadCredentials, maskToken, resolveAccessToken } = await import("../core/bootstrap.js");

    expect(resolveAccessToken()).toBe(token);
    expect(maskToken("1234567890")).toBe("123456***90");
    expect(maskToken("short")).toBe("***");

    writeFileSync(join(testHome, "config", "credentials.json"), JSON.stringify({ accessToken: token }));
    expect(loadCredentials()).toBeNull();

    writeFileSync(join(testHome, "config", "credentials.json"), "{not-json");
    expect(loadCredentials()).toBeNull();
    expect(() => resolveAccessToken()).toThrow(/No credentials found/u);
  });

  it("throws a login hint when freshness is requested without credentials", async () => {
    const { ensureFreshAccessToken } = await import("../core/bootstrap.js");

    await expect(ensureFreshAccessToken()).rejects.toThrow(/No credentials found/u);
  });

  it("refreshes when exp is less than 30s away", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) + 10 });
    const refreshed = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale);

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ accessToken: refreshed })));

    const { ensureFreshAccessToken } = await import("../core/bootstrap.js");
    const result = await ensureFreshAccessToken();

    expect(result).toBe(refreshed);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://first-tree.test/api/v1/auth/refresh",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("refreshes when exp already passed", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 5 });
    const refreshed = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale);

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ accessToken: refreshed })));

    const { ensureFreshAccessToken } = await import("../core/bootstrap.js");
    const result = await ensureFreshAccessToken();

    expect(result).toBe(refreshed);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats malformed access tokens as stale and refreshes them", async () => {
    const refreshed = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials("not-a-valid-jwt");

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ accessToken: refreshed })));

    const { ensureFreshAccessToken } = await import("../core/bootstrap.js");
    await expect(ensureFreshAccessToken()).resolves.toBe(refreshed);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws AuthRefreshFailedError on 401 so the WS layer can fail-stop", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    await writeCredentials(stale);

    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    const { ensureFreshAccessToken, AuthRefreshFailedError } = await import("../core/bootstrap.js");
    await expect(ensureFreshAccessToken()).rejects.toThrow(AuthRefreshFailedError);
    // Message is operator-facing; spot-check the recovery hint instead of the
    // word "failed" so future copy edits don't break the test.
    await expect(ensureFreshAccessToken()).rejects.toThrow(/Re-run `first-tree-dev login/);
  });

  it("preserves the refresh HTTP status on non-401 failures so callers can classify transient 5xx", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    await writeCredentials(stale);

    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    const { ensureFreshAccessToken, AuthRefreshFailedError } = await import("../core/bootstrap.js");
    const error = await ensureFreshAccessToken().catch((caught) => caught);
    expect(error).not.toBeInstanceOf(AuthRefreshFailedError);
    expect(error).toMatchObject({ name: "AuthRefreshHttpError", statusCode: 503 });
  });

  it("propagates a caller deadline into refresh fetch and aborts the underlying request", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    await writeCredentials(stale);
    let refreshSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          refreshSignal = init?.signal ?? undefined;
          const rejectForAbort = () => {
            reject(refreshSignal?.reason ?? new DOMException("This operation was aborted", "AbortError"));
          };
          if (refreshSignal?.aborted) rejectForAbort();
          else refreshSignal?.addEventListener("abort", rejectForAbort, { once: true });
        }),
    );

    const { ensureFreshAccessToken } = await import("../core/bootstrap.js");
    const caller = new AbortController();
    const result = ensureFreshAccessToken({ signal: caller.signal });
    await vi.waitFor(() => {
      expect(refreshSignal).toBeDefined();
    });

    caller.abort(new DOMException("The operation timed out", "TimeoutError"));
    await expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.waitFor(() => {
      expect(refreshSignal?.aborted).toBe(true);
    });
  });

  it("keeps a shared refresh alive while another deadline-bound caller still waits", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    const refreshed = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale);
    let refreshSignal: AbortSignal | undefined;
    let finishRefresh: (response: Response) => void = () => {};
    fetchMock.mockImplementation(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          refreshSignal = init?.signal ?? undefined;
          finishRefresh = resolve;
          refreshSignal?.addEventListener(
            "abort",
            () => reject(refreshSignal?.reason ?? new DOMException("This operation was aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    const { ensureFreshAccessToken } = await import("../core/bootstrap.js");
    const firstCaller = new AbortController();
    const secondCaller = new AbortController();
    const first = ensureFreshAccessToken({ signal: firstCaller.signal });
    const second = ensureFreshAccessToken({ signal: secondCaller.signal });
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    firstCaller.abort(new DOMException("The operation timed out", "TimeoutError"));
    await expect(first).rejects.toMatchObject({ name: "TimeoutError" });
    expect(refreshSignal?.aborted).toBe(false);

    finishRefresh(new Response(JSON.stringify({ accessToken: refreshed })));
    await expect(second).resolves.toBe(refreshed);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws AuthRefreshRateLimitedError carrying server's Retry-After on 429", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 5 });
    await writeCredentials(stale);

    fetchMock.mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "45" } }));

    const { ensureFreshAccessToken, AuthRefreshRateLimitedError } = await import("../core/bootstrap.js");
    const err = await ensureFreshAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(AuthRefreshRateLimitedError);
    expect((err as { retryAfterMs: number }).retryAfterMs).toBe(45_000);
  });

  it("defaults Retry-After to 30s when the 429 header is malformed", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 5 });
    await writeCredentials(stale);

    fetchMock.mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "not-a-date" } }));

    const { ensureFreshAccessToken, AuthRefreshRateLimitedError } = await import("../core/bootstrap.js");
    const err = await ensureFreshAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(AuthRefreshRateLimitedError);
    expect((err as { retryAfterMs: number }).retryAfterMs).toBe(30_000);
  });

  it("defaults Retry-After to 30s when the 429 response omits the header", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 5 });
    await writeCredentials(stale);

    fetchMock.mockResolvedValue(new Response(null, { status: 429 }));

    const { ensureFreshAccessToken, AuthRefreshRateLimitedError } = await import("../core/bootstrap.js");
    const err = await ensureFreshAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(AuthRefreshRateLimitedError);
    expect((err as { retryAfterMs: number }).retryAfterMs).toBe(30_000);
  });

  it("parses HTTP-date form of Retry-After (RFC 7231 alternate form)", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 5 });
    await writeCredentials(stale);

    const future = new Date(Date.now() + 60_000).toUTCString();
    fetchMock.mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": future } }));

    const { ensureFreshAccessToken, AuthRefreshRateLimitedError } = await import("../core/bootstrap.js");
    const err = await ensureFreshAccessToken().catch((e) => e);
    expect(err).toBeInstanceOf(AuthRefreshRateLimitedError);
    // Date precision is whole seconds, so allow a small slop.
    expect((err as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(55_000);
    expect((err as { retryAfterMs: number }).retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  // Regression for the original incident: server now sliding-windows refresh
  // tokens (rotates on every /auth/refresh), so the client MUST persist the
  // rotated token. Without this the cap never moves and the client still
  // hits the absolute refresh expiry — exactly the failure mode that
  // motivated this whole PR.
  it("persists the rotated refreshToken to credentials.json on a sliding-window refresh", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 5 });
    const refreshed = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale);

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ accessToken: refreshed, refreshToken: "rotated-refresh-abc" })),
    );

    const { ensureFreshAccessToken, loadCredentials } = await import("../core/bootstrap.js");
    await ensureFreshAccessToken();

    const persisted = loadCredentials();
    expect(persisted?.refreshToken).toBe("rotated-refresh-abc");
    expect(persisted?.accessToken).toBe(refreshed);
  });

  // Cross-version safety: if the client is upgraded ahead of the server
  // (rolling deploy), the legacy server still returns just `{accessToken}`.
  // We must not blow away the existing refresh token in that case — that
  // would force the user to re-claim immediately even though their old
  // refresh token is still valid.
  it("keeps the existing refreshToken when the server returns only accessToken (legacy server)", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 5 });
    const refreshed = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale);

    // Legacy /auth/refresh shape — no refreshToken field.
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ accessToken: refreshed })));

    const { ensureFreshAccessToken, loadCredentials } = await import("../core/bootstrap.js");
    await ensureFreshAccessToken();

    const persisted = loadCredentials();
    expect(persisted?.refreshToken).toBe("refresh-xyz"); // unchanged from the seed
    expect(persisted?.accessToken).toBe(refreshed);
  });

  it("deduplicates concurrent refresh calls into a single HTTP round-trip", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 5 });
    const refreshed = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale);

    // Delay the response so all concurrent callers pile onto the same inflight
    // promise before the first fetch resolves.
    let releaseFetch: (res: Response) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        releaseFetch = resolve;
      }),
    );

    const { ensureFreshAccessToken } = await import("../core/bootstrap.js");
    const calls = Promise.all([
      ensureFreshAccessToken(),
      ensureFreshAccessToken(),
      ensureFreshAccessToken(),
      ensureFreshAccessToken(),
      ensureFreshAccessToken(),
    ]);

    releaseFetch(new Response(JSON.stringify({ accessToken: refreshed })));
    const results = await calls;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const r of results) expect(r).toBe(refreshed);
  });

  it("respects opts.minValidityMs — refreshes a token that the default would consider fresh", async () => {
    // Regression: WS proactive refresh fires at exp-60s; before this fix it
    // re-called ensureFreshAccessToken() with the default 30s lead, saw
    // ~60s of life remaining, returned the *same* token, and the server
    // pushed auth:expired ~55s later. Asking for 65s validity must drive a
    // real /auth/refresh round-trip.
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) + 60 });
    const refreshed = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale);

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ accessToken: refreshed })));

    const { ensureFreshAccessToken } = await import("../core/bootstrap.js");

    // Default threshold (30s): the 60s-lived token is still considered fresh.
    expect(await ensureFreshAccessToken()).toBe(stale);
    expect(fetchMock).not.toHaveBeenCalled();

    // WS-style call asking for 65s of validity: must refresh.
    expect(await ensureFreshAccessToken({ minValidityMs: 65_000 })).toBe(refreshed);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("releases the inflight slot so subsequent expirations can refresh again", async () => {
    const stale1 = makeJwt({ exp: Math.floor(Date.now() / 1000) - 5 });
    const refreshed1 = makeJwt({ exp: Math.floor(Date.now() / 1000) + 10 }); // still within 30s lead
    const refreshed2 = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale1);

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: refreshed1 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: refreshed2 })));

    const { ensureFreshAccessToken } = await import("../core/bootstrap.js");
    const first = await ensureFreshAccessToken();
    const second = await ensureFreshAccessToken();

    expect(first).toBe(refreshed1);
    expect(second).toBe(refreshed2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("latches a terminal 401: repeated same-credential calls fail fast without new HTTP requests", async () => {
    // Staging incident containment: with a dead refresh token, every
    // sequential caller (WS reconnect loop, SDK requests, proactive refresh)
    // used to fire its own /auth/refresh round-trip. After the first 401 the
    // credential authority is known-terminal, so further calls must raise the
    // same AuthRefreshFailedError immediately, without touching the network.
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    await writeCredentials(stale);

    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    const { ensureFreshAccessToken, AuthRefreshFailedError } = await import("../core/bootstrap.js");
    for (let i = 0; i < 5; i++) {
      await expect(ensureFreshAccessToken()).rejects.toThrow(AuthRefreshFailedError);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The latched error must not leak credential material.
    const err = await ensureFreshAccessToken().catch((caught) => caught);
    expect(err).toBeInstanceOf(AuthRefreshFailedError);
    expect((err as Error).message).not.toContain("refresh-xyz");
    expect((err as Error).message).toMatch(/Re-run `first-tree-dev login/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shares one 401 round-trip across concurrent callers and latches afterwards", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    await writeCredentials(stale);

    let releaseFetch: (res: Response) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        releaseFetch = resolve;
      }),
    );

    const { ensureFreshAccessToken, AuthRefreshFailedError } = await import("../core/bootstrap.js");
    const calls = [
      ensureFreshAccessToken(),
      ensureFreshAccessToken(),
      ensureFreshAccessToken(),
      ensureFreshAccessToken(),
      ensureFreshAccessToken(),
    ];
    releaseFetch(new Response(null, { status: 401 }));
    for (const call of calls) {
      await expect(call).rejects.toThrow(AuthRefreshFailedError);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // After the shared attempt settles, the latch must reject new callers
    // without any additional HTTP request.
    await expect(ensureFreshAccessToken()).rejects.toThrow(AuthRefreshFailedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recovers when the persisted refresh token changes after a latched 401", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    const refreshed = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));

    const { ensureFreshAccessToken, AuthRefreshFailedError, saveCredentials } = await import("../core/bootstrap.js");
    await expect(ensureFreshAccessToken()).rejects.toThrow(AuthRefreshFailedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Operator re-logs-in: new credential authority must not inherit the old
    // latch, even though the access token inside is equally stale.
    saveCredentials({ accessToken: stale, refreshToken: "refresh-new", serverUrl: "http://first-tree.test" });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: refreshed })));

    await expect(ensureFreshAccessToken()).resolves.toBe(refreshed);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers when the server URL changes after a latched 401", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    const refreshed = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));

    const { ensureFreshAccessToken, AuthRefreshFailedError, saveCredentials } = await import("../core/bootstrap.js");
    await expect(ensureFreshAccessToken()).rejects.toThrow(AuthRefreshFailedError);

    saveCredentials({ accessToken: stale, refreshToken: "refresh-xyz", serverUrl: "http://other-server.test" });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: refreshed })));

    await expect(ensureFreshAccessToken()).resolves.toBe(refreshed);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://other-server.test/api/v1/auth/refresh",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not let an obsolete in-flight 401 suppress recovery with new credentials", async () => {
    // A refresh for authority A is in flight; the operator re-logs-in
    // (authority B) before A's 401 lands. A's terminal failure must not latch
    // authority B — and must not reach the caller as a terminal
    // AuthRefreshFailedError either, because the WS layer pauses on that
    // error AFTER B's file-change event, hanging recovery. The superseded
    // request fails non-terminally; the next call with B reaches the network.
    const stale = makeJwt({ sub: "user-a", exp: Math.floor(Date.now() / 1000) - 60 });
    const staleB = makeJwt({ sub: "user-b", exp: Math.floor(Date.now() / 1000) - 60 });
    const refreshed = makeJwt({ sub: "user-b", exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale);

    let releaseFirst: (res: Response) => void = () => {};
    fetchMock
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          releaseFirst = resolve;
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: refreshed })));

    const {
      ensureFreshAccessToken,
      AuthRefreshFailedError,
      AuthRefreshSupersededError,
      loadCredentials,
      saveCredentials,
    } = await import("../core/bootstrap.js");
    const obsolete = ensureFreshAccessToken();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // Re-login replaces the credential authority mid-flight.
    saveCredentials({ accessToken: staleB, refreshToken: "refresh-new", serverUrl: "http://first-tree.test" });

    // A's 401 arrives after the replacement: non-terminal, and B's file is
    // not touched.
    releaseFirst(new Response(null, { status: 401 }));
    const err = await obsolete.catch((caught) => caught);
    expect(err).toBeInstanceOf(AuthRefreshSupersededError);
    expect(err).not.toBeInstanceOf(AuthRefreshFailedError);
    expect(loadCredentials()).toMatchObject({ accessToken: staleB, refreshToken: "refresh-new" });

    // The new authority recovers immediately, with exactly one more call.
    await expect(ensureFreshAccessToken()).resolves.toBe(refreshed);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not let an obsolete in-flight success overwrite freshly persisted credentials", async () => {
    const stale = makeJwt({ sub: "user-a", exp: Math.floor(Date.now() / 1000) - 60 });
    const obsoleteAccess = makeJwt({ sub: "user-a", exp: Math.floor(Date.now() / 1000) + 1800 });
    const freshAccess = makeJwt({ sub: "user-b", exp: Math.floor(Date.now() / 1000) + 2400 });
    await writeCredentials(stale);

    let releaseFirst: (res: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        releaseFirst = resolve;
      }),
    );

    const { ensureFreshAccessToken, AuthRefreshSupersededError, loadCredentials, saveCredentials } = await import(
      "../core/bootstrap.js"
    );
    const obsolete = ensureFreshAccessToken();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // Re-login persists a completely new authority while A's refresh hangs.
    saveCredentials({ accessToken: freshAccess, refreshToken: "refresh-new", serverUrl: "http://first-tree.test" });

    // A's success arrives late: it must not clobber the fresh authority,
    // and the old caller must not receive either authority's credentials —
    // the replacement may be a different user.
    releaseFirst(new Response(JSON.stringify({ accessToken: obsoleteAccess, refreshToken: "rotated-old" })));
    await expect(obsolete).rejects.toThrow(AuthRefreshSupersededError);

    const persisted = loadCredentials();
    expect(persisted?.refreshToken).toBe("refresh-new");
    expect(persisted?.accessToken).toBe(freshAccess);
    // No follow-up refresh may be needed — the fresh token is returned as-is.
    await expect(ensureFreshAccessToken()).resolves.toBe(freshAccess);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not latch transient HTTP failures — the next call retries the network", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    const refreshed = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale);

    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: refreshed })));

    const { ensureFreshAccessToken } = await import("../core/bootstrap.js");
    const first = await ensureFreshAccessToken().catch((caught) => caught);
    expect(first).toMatchObject({ name: "AuthRefreshHttpError", statusCode: 503 });

    await expect(ensureFreshAccessToken()).resolves.toBe(refreshed);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not latch caller cancellation — the next call retries the network", async () => {
    const stale = makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 });
    const refreshed = makeJwt({ exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale);

    let refreshSignal: AbortSignal | undefined;
    fetchMock
      .mockImplementationOnce(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            refreshSignal = init?.signal ?? undefined;
            refreshSignal?.addEventListener(
              "abort",
              () => reject(refreshSignal?.reason ?? new DOMException("This operation was aborted", "AbortError")),
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: refreshed })));

    const { ensureFreshAccessToken } = await import("../core/bootstrap.js");
    const caller = new AbortController();
    const cancelled = ensureFreshAccessToken({ signal: caller.signal });
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    caller.abort(new DOMException("The operation timed out", "TimeoutError"));
    await expect(cancelled).rejects.toMatchObject({ name: "TimeoutError" });

    await expect(ensureFreshAccessToken()).resolves.toBe(refreshed);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  for (const status of [401, 200] as const) {
    it(`an obsolete late ${status} fails non-terminally and never pauses the new login`, async () => {
      // Mirrors the parent's independent login-fence probe: with a fresh
      // login already persisted, an obsolete in-flight response must fail
      // NON-terminally (never AuthRefreshFailedError, which pauses the WS
      // layer) and never hand the new authority's credentials to the old
      // caller — the replacement may be a different user. The new
      // credentials file stays untouched and the next call recovers.
      const stale = makeJwt({ sub: "old-user", exp: 1 });
      const oldFresh = makeJwt({ sub: "old-user", exp: Math.floor(Date.now() / 1000) + 3600 });
      const newFresh = makeJwt({ sub: "new-user", exp: Math.floor(Date.now() / 1000) + 3600 });
      await writeCredentials(stale); // RT "refresh-xyz", authority A

      let release: (res: Response) => void = () => {};
      fetchMock.mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
      );

      const {
        ensureFreshAccessToken,
        AuthRefreshFailedError,
        AuthRefreshSupersededError,
        loadCredentials,
        saveCredentials,
      } = await import("../core/bootstrap.js");
      const pending = ensureFreshAccessToken();
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      // New login lands while A's request is in flight.
      saveCredentials({ accessToken: newFresh, refreshToken: "synthetic-new", serverUrl: "http://first-tree.test" });
      release(
        new Response(
          status === 200 ? JSON.stringify({ accessToken: oldFresh, refreshToken: "synthetic-old-rotated" }) : null,
          { status },
        ),
      );

      const err = await pending.catch((caught) => caught);
      expect(err).toBeInstanceOf(AuthRefreshSupersededError);
      expect(err).not.toBeInstanceOf(AuthRefreshFailedError);
      expect(loadCredentials()).toMatchObject({ accessToken: newFresh, refreshToken: "synthetic-new" });
      await expect(ensureFreshAccessToken()).resolves.toBe(newFresh);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }

  for (const status of [401, 200] as const) {
    it(`an obsolete late ${status} never hands a different home/server's token to the old caller`, async () => {
      // Cross-authority replacement: the credentials file now points at a
      // DIFFERENT server. Even though the persisted token is fresh, it must
      // not leak to the caller that asked about the old server — the safest
      // result is the non-terminal superseded error; recovery proceeds
      // normally afterwards.
      const stale = makeJwt({ sub: "old-user", exp: 1 });
      const oldFresh = makeJwt({ sub: "old-user", exp: Math.floor(Date.now() / 1000) + 3600 });
      const newFresh = makeJwt({ sub: "new-user", exp: Math.floor(Date.now() / 1000) + 3600 });
      writeFileSync(
        join(testHome, "config", "credentials.json"),
        JSON.stringify({ accessToken: stale, refreshToken: "synthetic-old", serverUrl: "http://old.first-tree.test" }),
      );

      let release: (res: Response) => void = () => {};
      fetchMock.mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
      );

      const { ensureFreshAccessToken, AuthRefreshFailedError, AuthRefreshSupersededError, loadCredentials } =
        await import("../core/bootstrap.js");
      const pending = ensureFreshAccessToken();
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      writeFileSync(
        join(testHome, "config", "credentials.json"),
        JSON.stringify({
          accessToken: newFresh,
          refreshToken: "synthetic-new",
          serverUrl: "http://new.first-tree.test",
        }),
      );
      release(
        new Response(
          status === 200 ? JSON.stringify({ accessToken: oldFresh, refreshToken: "synthetic-old-rotated" }) : null,
          { status },
        ),
      );

      const err = await pending.catch((caught) => caught);
      expect(err).toBeInstanceOf(AuthRefreshSupersededError);
      expect(err).not.toBeInstanceOf(AuthRefreshFailedError);
      expect(loadCredentials()).toMatchObject({ serverUrl: "http://new.first-tree.test", accessToken: newFresh });
      await expect(ensureFreshAccessToken()).resolves.toBe(newFresh);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  }

  it("gives a same-RT login with a stale access token its own flight, and the old completion cannot clear or poison it", async () => {
    // Join-predicate regression: the flight join checks the access-token
    // snapshot, not just home/server/refreshToken. A new login that keeps
    // the same RT but installs a (stale) access token must NOT join the
    // superseded flight — it gets its own HTTP call immediately, and the
    // old flight's settle can neither clear the slot nor latch the shared RT.
    const staleA = makeJwt({ sub: "user-a", exp: Math.floor(Date.now() / 1000) - 60 });
    const staleB = makeJwt({ sub: "user-b", exp: Math.floor(Date.now() / 1000) - 60 });
    const refreshedB = makeJwt({ sub: "user-b", exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(staleA); // RT "refresh-xyz"

    const releases: Array<(res: Response) => void> = [];
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );

    const { ensureFreshAccessToken, AuthRefreshSupersededError, saveCredentials } = await import(
      "../core/bootstrap.js"
    );
    const callA = ensureFreshAccessToken();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // New login: SAME server URL, SAME refresh token, different (stale)
    // access token. It must start its own flight immediately.
    saveCredentials({ accessToken: staleB, refreshToken: "refresh-xyz", serverUrl: "http://first-tree.test" });
    const callB = ensureFreshAccessToken();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    // A's late 401 settles superseded (the snapshot changed) — crucially it
    // must NOT latch the shared RT, and its settle must not clear B's slot.
    releases[0]?.(new Response(null, { status: 401 }));
    await expect(callA).rejects.toThrow(AuthRefreshSupersededError);

    // B's flight is still the joinable one: C joins without another request.
    const callC = ensureFreshAccessToken();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    releases[1]?.(new Response(JSON.stringify({ accessToken: refreshedB })));
    await expect(callB).resolves.toBe(refreshedB);
    await expect(callC).resolves.toBe(refreshedB);
  });

  for (const status of [401, 200] as const) {
    it(`an obsolete late ${status} after a home switch fails non-terminally and leaves the new home untouched`, async () => {
      // Cross-home replacement: FIRST_TREE_HOME moves while A's request is in
      // flight. The old caller must not receive the new home's credentials
      // (different authority, possibly a different user), and the old
      // completion must not persist or latch anything into the new home.
      const stale = makeJwt({ sub: "old-user", exp: 1 });
      const oldFresh = makeJwt({ sub: "old-user", exp: Math.floor(Date.now() / 1000) + 3600 });
      const newFresh = makeJwt({ sub: "new-user", exp: Math.floor(Date.now() / 1000) + 3600 });
      await writeCredentials(stale); // home 1, RT "synthetic-old"-equivalent

      let release: (res: Response) => void = () => {};
      fetchMock.mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
      );

      const { ensureFreshAccessToken, AuthRefreshFailedError, AuthRefreshSupersededError, loadCredentials } =
        await import("../core/bootstrap.js");
      const pending = ensureFreshAccessToken();
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      const otherHome = join(
        tmpdir(),
        `ft-first-tree-fresh-switch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(join(otherHome, "config"), { recursive: true });
      writeFileSync(
        join(otherHome, "config", "credentials.json"),
        JSON.stringify({ accessToken: newFresh, refreshToken: "synthetic-new", serverUrl: "http://first-tree.test" }),
      );
      const previousHome = process.env.FIRST_TREE_HOME;
      process.env.FIRST_TREE_HOME = otherHome;
      try {
        release(
          new Response(
            status === 200 ? JSON.stringify({ accessToken: oldFresh, refreshToken: "synthetic-old-rotated" }) : null,
            { status },
          ),
        );

        const err = await pending.catch((caught) => caught);
        expect(err).toBeInstanceOf(AuthRefreshSupersededError);
        expect(err).not.toBeInstanceOf(AuthRefreshFailedError);
        expect(loadCredentials()).toMatchObject({ accessToken: newFresh, refreshToken: "synthetic-new" });
        await expect(ensureFreshAccessToken()).resolves.toBe(newFresh);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        process.env.FIRST_TREE_HOME = previousHome;
        rmSync(otherHome, { recursive: true, force: true });
      }
    });
  }

  it("starts a fresh flight immediately for new credentials instead of joining the old authority's pending refresh", async () => {
    const staleA = makeJwt({ sub: "user-a", exp: Math.floor(Date.now() / 1000) - 60 });
    const staleB = makeJwt({ sub: "user-b", exp: Math.floor(Date.now() / 1000) - 60 });
    const refreshedB = makeJwt({ sub: "user-b", exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(staleA); // authority A, RT "refresh-xyz"

    const releases: Array<(res: Response) => void> = [];
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(resolve);
        }),
    );

    const { ensureFreshAccessToken, AuthRefreshSupersededError, saveCredentials } = await import(
      "../core/bootstrap.js"
    );
    const callA = ensureFreshAccessToken();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // Login installs authority B while A is still pending: B must get its own
    // HTTP call immediately, not join (or wait for) A's flight.
    saveCredentials({ accessToken: staleB, refreshToken: "refresh-b", serverUrl: "http://first-tree.test" });
    const callB = ensureFreshAccessToken();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    // A settles superseded; its settle must not clear B's active flight.
    releases[0]?.(new Response(null, { status: 401 }));
    await expect(callA).rejects.toThrow(AuthRefreshSupersededError);

    // B's flight is still the active one: another caller joins it without an
    // additional HTTP request.
    const callC = ensureFreshAccessToken();
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    releases[1]?.(new Response(JSON.stringify({ accessToken: refreshedB })));
    await expect(callB).resolves.toBe(refreshedB);
    await expect(callC).resolves.toBe(refreshedB);
  });

  it("never recreates or returns credentials when a logout lands during a pending refresh", async () => {
    const stale = makeJwt({ sub: "old-user", exp: Math.floor(Date.now() / 1000) - 60 });
    const minted = makeJwt({ sub: "old-user", exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale);

    let release: (res: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );

    const { ensureFreshAccessToken, AuthRefreshSupersededError } = await import("../core/bootstrap.js");
    const call = ensureFreshAccessToken();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // Logout removes the credentials file while the refresh is in flight. The
    // late success must neither recreate the file nor hand the caller a token.
    rmSync(join(testHome, "config", "credentials.json"));
    release(new Response(JSON.stringify({ accessToken: minted, refreshToken: "rotated-old" })));

    await expect(call).rejects.toThrow(AuthRefreshSupersededError);
    expect(existsSync(join(testHome, "config", "credentials.json"))).toBe(false);
    await expect(ensureFreshAccessToken()).rejects.toThrow(/No credentials found/u);
  });

  it("does not latch a 401 that lands after the caller cancelled (transport ignores the abort)", async () => {
    const stale = makeJwt({ sub: "user-a", exp: Math.floor(Date.now() / 1000) - 60 });
    await writeCredentials(stale);

    let release: (res: Response) => void = () => {};
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    const { ensureFreshAccessToken, AuthRefreshFailedError } = await import("../core/bootstrap.js");
    const caller = new AbortController();
    const cancelled = ensureFreshAccessToken({ signal: caller.signal });
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    caller.abort(new DOMException("The operation timed out", "TimeoutError"));

    // The 401 arrives after cancellation: the attempt rejects as the
    // cancellation and must never latch.
    release(new Response(null, { status: 401 }));
    await expect(cancelled).rejects.toMatchObject({ name: "TimeoutError" });

    // A later call still reaches the network (proving nothing latched) and
    // only then fails terminally.
    await expect(ensureFreshAccessToken()).rejects.toThrow(AuthRefreshFailedError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not save a 200 that lands after the caller cancelled (transport ignores the abort)", async () => {
    const stale = makeJwt({ sub: "user-a", exp: Math.floor(Date.now() / 1000) - 60 });
    const minted = makeJwt({ sub: "user-a", exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale);

    let release: (res: Response) => void = () => {};
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: minted })));

    const { ensureFreshAccessToken, loadCredentials } = await import("../core/bootstrap.js");
    const caller = new AbortController();
    const cancelled = ensureFreshAccessToken({ signal: caller.signal });
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    caller.abort(new DOMException("The operation timed out", "TimeoutError"));

    release(new Response(JSON.stringify({ accessToken: minted, refreshToken: "rotated-late" })));
    await expect(cancelled).rejects.toMatchObject({ name: "TimeoutError" });

    // The cancelled success must not persist: file still holds the stale
    // token and the original refresh token.
    const persisted = loadCredentials();
    expect(persisted?.accessToken).toBe(stale);
    expect(persisted?.refreshToken).toBe("refresh-xyz");

    await expect(ensureFreshAccessToken()).resolves.toBe(minted);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a cancelled old-authority flight that 401s late cannot pause a newer login", async () => {
    const staleA = makeJwt({ sub: "user-a", exp: Math.floor(Date.now() / 1000) - 60 });
    const freshB = makeJwt({ sub: "user-b", exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(staleA);

    let release: (res: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );

    const { ensureFreshAccessToken, saveCredentials } = await import("../core/bootstrap.js");
    const caller = new AbortController();
    const cancelled = ensureFreshAccessToken({ signal: caller.signal });
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    caller.abort(new DOMException("The operation timed out", "TimeoutError"));

    // New login lands, then the doomed old response arrives.
    saveCredentials({ accessToken: freshB, refreshToken: "refresh-b", serverUrl: "http://first-tree.test" });
    release(new Response(null, { status: 401 }));
    await expect(cancelled).rejects.toMatchObject({ name: "TimeoutError" });

    // The new authority is unaffected: fresh token returned, zero extra calls.
    await expect(ensureFreshAccessToken()).resolves.toBe(freshB);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("scopes the terminal 401 latch to the credential home", async () => {
    const stale = makeJwt({ sub: "shared-user", exp: Math.floor(Date.now() / 1000) - 60 });
    const refreshed = makeJwt({ sub: "shared-user", exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale); // home 1, RT "refresh-xyz"
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));

    const { ensureFreshAccessToken, AuthRefreshFailedError } = await import("../core/bootstrap.js");
    await expect(ensureFreshAccessToken()).rejects.toThrow(AuthRefreshFailedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A different home holding byte-identical credentials is a different
    // authority: it must still reach the network.
    const otherHome = join(tmpdir(), `ft-first-tree-fresh-other-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(otherHome, "config"), { recursive: true });
    writeFileSync(
      join(otherHome, "config", "credentials.json"),
      JSON.stringify({ accessToken: stale, refreshToken: "refresh-xyz", serverUrl: "http://first-tree.test" }),
    );
    const previousHome = process.env.FIRST_TREE_HOME;
    process.env.FIRST_TREE_HOME = otherHome;
    try {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ accessToken: refreshed })));
      await expect(ensureFreshAccessToken()).resolves.toBe(refreshed);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      process.env.FIRST_TREE_HOME = previousHome;
      rmSync(otherHome, { recursive: true, force: true });
    }
  });

  it("fences a late success when a new login rewrote the access token under the same refresh authority", async () => {
    const stale = makeJwt({ sub: "user-a", exp: Math.floor(Date.now() / 1000) - 60 });
    const reloginFresh = makeJwt({ sub: "user-b", exp: Math.floor(Date.now() / 1000) + 1800 });
    const mintedOld = makeJwt({ sub: "user-a", exp: Math.floor(Date.now() / 1000) + 1800 });
    await writeCredentials(stale); // RT "refresh-xyz"

    let release: (res: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );

    const { ensureFreshAccessToken, AuthRefreshSupersededError, loadCredentials, saveCredentials } = await import(
      "../core/bootstrap.js"
    );
    const call = ensureFreshAccessToken();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    // New login for the same account: SAME refresh authority, new access
    // token on disk. The in-flight result must not overwrite it — and the
    // superseded caller fails non-terminally instead of receiving either
    // authority's credentials.
    saveCredentials({ accessToken: reloginFresh, refreshToken: "refresh-xyz", serverUrl: "http://first-tree.test" });
    release(new Response(JSON.stringify({ accessToken: mintedOld })));

    await expect(call).rejects.toThrow(AuthRefreshSupersededError);
    const persisted = loadCredentials();
    expect(persisted?.accessToken).toBe(reloginFresh);
    expect(persisted?.refreshToken).toBe("refresh-xyz");
    await expect(ensureFreshAccessToken()).resolves.toBe(reloginFresh);
  });

  it("removes the temporary credentials file when an atomic save fails", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        renameSync: () => {
          throw new Error("rename denied");
        },
      };
    });

    const { saveCredentials } = await import("../core/bootstrap.js");

    expect(() =>
      saveCredentials({ accessToken: "access", refreshToken: "refresh", serverUrl: "https://hub.example" }),
    ).toThrow("rename denied");
    expect(existsSync(join(testHome, "config", `credentials.json.tmp.${process.pid}`))).toBe(false);
    expect(() => readFileSync(join(testHome, "config", "credentials.json"), "utf8")).toThrow();
    vi.doUnmock("node:fs");
  });
});
