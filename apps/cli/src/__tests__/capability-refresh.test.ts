import type { CapabilityEntry, ClientCapabilities } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CapabilityRefresher,
  type CapabilityRefresherDeps,
  stableCapabilitiesJson,
  stableCapabilitySyncJson,
} from "../core/capability-refresh.js";

/**
 * The refresher unifies the daemon's two capability-refresh triggers — the WS
 * reconnect re-probe and a bounded, backoff-scheduled background poll that runs
 * while the daemon stays connected (the gap fixed for the "no runtime ready
 * after install" issue). These tests cover the poll lifecycle, the upload
 * dedupe, the backoff, the shared in-flight guard, and the reconnect path with
 * the probe helpers injected (no real provider launches).
 */

const ok = (over: Partial<CapabilityEntry> = {}): CapabilityEntry => ({
  state: "ok",
  available: true,
  sdkVersion: "1.0.0",
  detectedAt: "2026-06-17T00:00:00.000Z",
  ...over,
});

const missing = (over: Partial<CapabilityEntry> = {}): CapabilityEntry => ({
  state: "missing",
  available: false,
  detectedAt: "2026-06-17T00:00:00.000Z",
  ...over,
});

const allOk = (): ClientCapabilities => ({
  amp: ok(),
  "claude-code": ok(),
  "claude-code-tui": ok(),
  codex: ok(),
  cursor: ok(),
  "deepseek-harness": ok(),
  grok: ok(),
  antigravity: ok(),
  "kimi-code": ok(),
  "lark-cli": ok(),
  opencode: ok(),
  pi: ok(),
});

const codexMissing = (): ClientCapabilities => ({
  amp: ok(),
  "claude-code": ok(),
  "claude-code-tui": ok(),
  codex: missing(),
  cursor: ok(),
  "deepseek-harness": ok(),
  grok: ok(),
  antigravity: ok(),
  "kimi-code": ok(),
  "lark-cli": ok(),
  opencode: ok(),
  pi: ok(),
});

// Detection is install-only, so a provider mid-login is one whose binary is not
// yet resolvable (`missing`) — that non-`ok` state keeps the background poll
// running while the interactive login drives its `pendingAuth` marker.
const codexUnauth = (over: Partial<CapabilityEntry> = {}): CapabilityEntry => ({
  state: "missing",
  available: false,
  detectedAt: "2026-06-17T00:00:00.000Z",
  ...over,
});

const codexPending = (): CapabilityEntry =>
  codexUnauth({
    pendingAuth: {
      method: "browser",
      authUrl: "https://auth.openai.com/auth?x=1",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  });

/** Snapshot with codex mid-browser-auth (not-yet-installed + a pending login). */
const codexPendingSnapshot = (): ClientCapabilities => ({
  amp: ok(),
  "claude-code": ok(),
  "claude-code-tui": ok(),
  codex: codexPending(),
  cursor: ok(),
  "deepseek-harness": ok(),
  grok: ok(),
  antigravity: ok(),
  "kimi-code": ok(),
  "lark-cli": ok(),
  opencode: ok(),
  pi: ok(),
});

/** What a re-probe sees while the login is still in flight: still not installed. */
const codexUnauthSnapshot = (): ClientCapabilities => ({
  amp: ok(),
  "claude-code": ok(),
  "claude-code-tui": ok(),
  codex: codexUnauth(),
  cursor: ok(),
  "deepseek-harness": ok(),
  grok: ok(),
  antigravity: ok(),
  "kimi-code": ok(),
  "lark-cli": ok(),
  opencode: ok(),
  pi: ok(),
});

const BASE = 100;
const MAX = 400;

describe("stableCapabilitySyncJson", () => {
  it("sorts object keys while preserving array order in stable JSON", () => {
    expect(stableCapabilitiesJson({ z: [{ b: 2, a: 1 }], a: true })).toBe('{"a":true,"z":[{"a":1,"b":2}]}');
    expect(stableCapabilitiesJson(undefined)).toBe("null");
  });

  it("ignores volatile probe metadata", () => {
    expect(
      stableCapabilitySyncJson({
        codex: missing({ detectedAt: "2026-06-17T00:00:15.000Z", latencyMs: 15 }),
      }),
    ).toBe(
      stableCapabilitySyncJson({
        codex: missing({ detectedAt: "2026-06-17T00:05:15.000Z", latencyMs: 925 }),
      }),
    );
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeRefresher(overrides: Partial<CapabilityRefresherDeps> = {}): {
  refresher: CapabilityRefresher;
  upload: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  reprobe: ReturnType<typeof vi.fn>;
  revalidate: ReturnType<typeof vi.fn>;
} {
  const upload = vi.fn(async () => undefined);
  const log = vi.fn();
  const reprobe = vi.fn(async () => ({ capabilities: allOk(), mode: "full" as const }));
  const revalidate = vi.fn(async () => allOk());
  const refresher = new CapabilityRefresher({
    upload,
    log,
    reprobe,
    revalidate,
    baseMs: BASE,
    maxMs: MAX,
    ...overrides,
  });
  return { refresher, upload, log, reprobe, revalidate };
}

describe("CapabilityRefresher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uploads the startup snapshot once and does not poll when all providers are ok", async () => {
    const { refresher, upload, revalidate } = makeRefresher({ initial: allOk() });
    await refresher.start();

    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith(allOk());

    await vi.advanceTimersByTimeAsync(MAX * 4);
    expect(revalidate).not.toHaveBeenCalled();
    refresher.stop();
  });

  // Regression (real-QA): the background poll must NOT clobber a provider's
  // pending browser-auth marker while an interactive runtime-auth login is in
  // flight — otherwise the web Connect panel vanishes ~30s in, before auth finishes.
  it("preserves an interactive provider's pending browser-auth across a background poll", async () => {
    const { refresher, upload, revalidate } = makeRefresher({ initial: codexPendingSnapshot() });
    revalidate.mockResolvedValue(codexUnauthSnapshot()); // a fresh probe drops the pending marker

    refresher.beginInteractive("codex");
    await refresher.start();
    expect(upload).toHaveBeenCalledTimes(1); // initial snapshot WITH pending

    // A poll fires: revalidate runs, but the interactive provider is preserved.
    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(1);
    // Snapshot still carries the pending browser-auth marker…
    expect(refresher.currentEntry("codex")?.pendingAuth).toBeDefined();
    // …and the unchanged snapshot is NOT re-uploaded (no panel flicker).
    expect(upload).toHaveBeenCalledTimes(1);
    refresher.stop();
  });

  it("logs setProviderEntry upload failures and keeps polling", async () => {
    const { refresher, upload, log, revalidate } = makeRefresher({ initial: codexMissing() });
    upload.mockRejectedValueOnce(new Error("PATCH failed"));

    await refresher.setProviderEntry("codex", codexPending());

    expect(log).toHaveBeenCalledWith("⚠️", expect.stringContaining("capabilities upload skipped"));
    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(1);
    refresher.stop();
  });

  it("lets a re-probe overwrite the entry once the interactive flag is cleared", async () => {
    const { refresher, upload, revalidate } = makeRefresher({ initial: codexPendingSnapshot() });
    revalidate.mockResolvedValue(codexUnauthSnapshot());

    refresher.beginInteractive("codex");
    await refresher.start();
    refresher.endInteractive("codex");

    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(1);
    // Now the fresh (no-pending) entry wins and is uploaded.
    expect(refresher.currentEntry("codex")?.pendingAuth).toBeUndefined();
    expect(upload).toHaveBeenCalledTimes(2);
    refresher.stop();
  });

  it("isInteractive reflects begin/end and serializes duplicate starts", () => {
    const { refresher } = makeRefresher({ initial: codexUnauthSnapshot() });
    expect(refresher.isInteractive("codex")).toBe(false);
    refresher.beginInteractive("codex");
    expect(refresher.isInteractive("codex")).toBe(true);
    refresher.endInteractive("codex");
    expect(refresher.isInteractive("codex")).toBe(false);
    refresher.stop();
  });

  it("polls a degraded snapshot, uploads the recovery, then stops once everything is ok", async () => {
    const recovered = allOk();
    const { refresher, upload, revalidate } = makeRefresher({ initial: codexMissing() });
    revalidate.mockResolvedValueOnce(recovered);

    await refresher.start();
    expect(upload).toHaveBeenCalledTimes(1); // initial degraded snapshot

    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(revalidate).toHaveBeenCalledWith(codexMissing());
    expect(upload).toHaveBeenCalledTimes(2); // recovery uploaded
    expect(upload).toHaveBeenLastCalledWith(recovered);

    // Now healthy → the poll is disarmed.
    await vi.advanceTimersByTimeAsync(MAX * 4);
    expect(revalidate).toHaveBeenCalledTimes(1);
    refresher.stop();
  });

  it("skips the upload when a poll produces an unchanged snapshot, and backs off", async () => {
    const { refresher, upload, log, revalidate } = makeRefresher({ initial: codexMissing() });
    revalidate.mockResolvedValue(codexMissing()); // never changes

    await refresher.start();
    expect(upload).toHaveBeenCalledTimes(1);

    // First poll at BASE: unchanged → no upload, backoff grows to 2×BASE.
    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();

    // Nothing fires before the backed-off interval elapses.
    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(1);

    // Second poll at 2×BASE.
    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledTimes(1);
    refresher.stop();
  });

  it("backs off without uploading when only volatile probe metadata changes", async () => {
    const { refresher, upload, log, revalidate } = makeRefresher({ initial: codexMissing() });
    revalidate.mockResolvedValue({
      ...codexMissing(),
      codex: missing({ detectedAt: "2026-06-17T00:00:15.000Z", latencyMs: 15 }),
    });

    await refresher.start();
    expect(upload).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledTimes(1);
    refresher.stop();
  });

  it("resets the backoff when a poll observes a state change", async () => {
    const { refresher, revalidate } = makeRefresher({ initial: codexMissing() });
    // Each poll yields a different (still-degraded) snapshot → always "changed".
    revalidate
      .mockResolvedValueOnce({ ...codexMissing(), codex: missing({ error: "v1" }) })
      .mockResolvedValueOnce({ ...codexMissing(), codex: missing({ error: "v2" }) });

    await refresher.start();

    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(1);

    // Changed → backoff stays at BASE (not 2×BASE), so the next poll fires after BASE again.
    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(2);
    refresher.stop();
  });

  it("defers a reconnect that lands mid-poll and drains it afterward (reconnect re-probe never dropped)", async () => {
    const gate = deferred<ClientCapabilities>();
    const { refresher, reprobe, revalidate } = makeRefresher({ initial: codexMissing() });
    revalidate.mockReturnValueOnce(gate.promise); // poll #1 hangs in flight

    await refresher.start();
    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(1);

    // A reconnect arriving mid-poll must NOT run concurrently with it...
    refresher.onReconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(reprobe).not.toHaveBeenCalled();

    // ...but once the poll resolves, the held reconnect is drained in reconnect
    // mode so its TTL/full re-probe still runs (the codex-assistant finding).
    gate.resolve(codexMissing());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(reprobe).toHaveBeenCalledTimes(1);
    expect(reprobe).toHaveBeenLastCalledWith(codexMissing());
    refresher.stop();
  });

  it("keeps polling when a recovery is probed but its upload fails, then stops once the server is in sync", async () => {
    const { refresher, upload, revalidate } = makeRefresher({ initial: codexMissing() });
    // Default revalidate already returns all-ok, so poll #1 recovers locally.
    upload.mockReset();
    upload.mockResolvedValue(undefined);
    upload.mockResolvedValueOnce(undefined); // start: degraded snapshot uploads ok
    upload.mockRejectedValueOnce(new Error("PATCH 503")); // poll #1 recovery upload FAILS

    await refresher.start();
    expect(upload).toHaveBeenCalledTimes(1);

    // Poll #1 recovers to all-ok locally, but the upload fails: the poll must
    // NOT stop — the server is still on the stale degraded snapshot (yuezengwu).
    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(2);

    // The failed upload resets the backoff, so the retry fires at BASE again and
    // succeeds → server now in sync → poll stops.
    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(upload).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(MAX * 4);
    expect(revalidate).toHaveBeenCalledTimes(2); // healthy + synced → no more polls
    refresher.stop();
  });

  it("logs transient probe failures and retries the background poll", async () => {
    const { refresher, log, revalidate } = makeRefresher({ initial: codexMissing() });
    revalidate.mockRejectedValueOnce(new Error("provider crashed")).mockResolvedValueOnce(codexMissing());

    await refresher.start();
    await vi.advanceTimersByTimeAsync(BASE);

    expect(log).toHaveBeenCalledWith("⚠️", expect.stringContaining("poll capability re-probe skipped"));
    await vi.advanceTimersByTimeAsync(BASE * 2);
    expect(revalidate).toHaveBeenCalledTimes(2);
    refresher.stop();
  });

  it("re-probes via reprobeOnReconnect on a reconnect and re-arms based on the result", async () => {
    const { refresher, upload, reprobe } = makeRefresher({ initial: codexMissing() });
    reprobe.mockResolvedValueOnce({ capabilities: allOk(), mode: "revalidate" as const });

    refresher.onReconnect();
    await vi.advanceTimersByTimeAsync(0);

    expect(reprobe).toHaveBeenCalledTimes(1);
    expect(reprobe).toHaveBeenCalledWith(codexMissing());
    expect(upload).toHaveBeenCalledWith(allOk());
    refresher.stop();
  });

  it("arms the poll even when the startup upload fails (a later poll retries)", async () => {
    const { refresher, upload, log, revalidate } = makeRefresher({ initial: codexMissing() });
    upload.mockRejectedValueOnce(new Error("clients row not ready"));

    await refresher.start();
    expect(log).toHaveBeenCalledWith("⚠️", expect.stringContaining("capabilities upload skipped"));

    await vi.advanceTimersByTimeAsync(BASE);
    expect(revalidate).toHaveBeenCalledTimes(1);
    refresher.stop();
  });

  it("stop() cancels a pending poll", async () => {
    const { refresher, revalidate } = makeRefresher({ initial: codexMissing() });
    await refresher.start();
    refresher.stop();

    await vi.advanceTimersByTimeAsync(MAX * 4);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("ignores reconnects and later provider updates after stop", async () => {
    const { refresher, revalidate, reprobe } = makeRefresher({ initial: codexMissing() });
    await refresher.start();
    refresher.stop();

    refresher.onReconnect();
    await refresher.setProviderEntry("codex", missing({ error: "still missing" }));
    await vi.advanceTimersByTimeAsync(MAX * 4);

    expect(reprobe).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("starts an immediate background full probe when no startup snapshot exists", async () => {
    const gate = deferred<{ capabilities: ClientCapabilities; mode: "full" | "revalidate" }>();
    const { refresher, upload, log, reprobe, revalidate } = makeRefresher({ initial: null });
    reprobe.mockReturnValueOnce(gate.promise);

    await refresher.start();
    expect(reprobe).toHaveBeenCalledTimes(1);
    expect(reprobe).toHaveBeenCalledWith({});
    expect(revalidate).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled(); // start() did not wait for the full probe

    gate.resolve({ capabilities: allOk(), mode: "full" });
    await vi.advanceTimersByTimeAsync(0);
    expect(upload).toHaveBeenCalledWith(allOk());
    expect(log).toHaveBeenCalledWith("•", expect.stringContaining("runtime capabilities re-probed (startup, full)"));
    refresher.stop();
  });

  it("keeps polling after a startup probe fails before any snapshot exists", async () => {
    const { refresher, log, reprobe, revalidate } = makeRefresher({ initial: null });
    reprobe.mockRejectedValueOnce("provider crashed");
    revalidate.mockResolvedValueOnce(allOk());

    await refresher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toHaveBeenCalledWith("⚠️", expect.stringContaining("startup capability re-probe skipped after"));
    expect(log.mock.calls.map((call) => String(call[1])).join("\n")).toContain("provider crashed");

    await vi.advanceTimersByTimeAsync(BASE * 2);
    expect(revalidate).toHaveBeenCalledTimes(1);
    refresher.stop();
  });

  it("preserves pendingAuth published while a startup full probe is in flight", async () => {
    const gate = deferred<{ capabilities: ClientCapabilities; mode: "full" | "revalidate" }>();
    const { refresher, upload, reprobe } = makeRefresher({ initial: null });
    reprobe.mockReturnValueOnce(gate.promise);

    await refresher.start();
    expect(reprobe).toHaveBeenCalledWith({});

    refresher.beginInteractive("codex");
    await refresher.setProviderEntry("codex", codexPending());
    expect(refresher.currentEntry("codex")?.pendingAuth).toBeDefined();
    expect(upload).toHaveBeenCalledTimes(1);

    gate.resolve({ capabilities: codexUnauthSnapshot(), mode: "full" });
    await vi.advanceTimersByTimeAsync(0);

    expect(refresher.currentEntry("codex")?.pendingAuth).toBeDefined();
    expect(upload).toHaveBeenCalledTimes(2);
    for (const [snapshot] of upload.mock.calls) {
      expect((snapshot as ClientCapabilities).codex?.pendingAuth).toBeDefined();
    }
    refresher.stop();
  });

  it("preserves provider state published after interactive login completes while startup probe is in flight", async () => {
    const gate = deferred<{ capabilities: ClientCapabilities; mode: "full" | "revalidate" }>();
    const { refresher, upload, reprobe } = makeRefresher({ initial: null });
    reprobe.mockReturnValueOnce(gate.promise);

    await refresher.start();
    expect(reprobe).toHaveBeenCalledWith({});

    refresher.beginInteractive("codex");
    await refresher.setProviderEntry("codex", codexPending());
    refresher.endInteractive("codex");
    await refresher.setProviderEntry("codex", ok({ detectedAt: "2026-06-17T00:01:00.000Z" }));

    gate.resolve({ capabilities: codexUnauthSnapshot(), mode: "full" });
    await vi.advanceTimersByTimeAsync(0);

    expect(refresher.currentEntry("codex")).toMatchObject({ state: "ok" });
    const uploadedSnapshots = upload.mock.calls.map(([snapshot]) => snapshot as ClientCapabilities);
    expect(uploadedSnapshots).toHaveLength(3);
    // The stale aggregate probe (codex still not installed, no pending marker)
    // must never overwrite the completed install entry.
    expect(uploadedSnapshots.some(({ codex }) => codex?.state === "missing" && !codex.pendingAuth)).toBe(false);
    expect(uploadedSnapshots[uploadedSnapshots.length - 1]?.codex).toMatchObject({
      state: "ok",
    });
    refresher.stop();
  });
});
