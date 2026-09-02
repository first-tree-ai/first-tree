import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildChildrenIndex,
  defaultProcessSnapshot,
  extractChatId,
  findProviderPids,
  hasDescendant,
  PsSubprocessProbe,
  parseElapsedSeconds,
  parseProcessRows,
} from "../runtime/process-tree-probe.js";
import { silentLogger } from "./_logger-helpers.js";

describe("process-tree-probe pure helpers", () => {
  it("parses ps pid/ppid/etime/comm rows and skips unparseable lines", () => {
    const out = [
      "  100   55 01:02:03 /opt/homebrew/bin/claude",
      " 101  100    04:05 /bin/zsh",
      "garbage",
      "",
      "102 101 2-03:04:05 sleep",
      "103 101 not-a-time sleep",
    ].join("\n");
    expect(parseProcessRows(out)).toEqual([
      { pid: 100, ppid: 55, elapsedSec: 3723, comm: "/opt/homebrew/bin/claude" },
      { pid: 101, ppid: 100, elapsedSec: 245, comm: "/bin/zsh" },
      { pid: 102, ppid: 101, elapsedSec: 183_845, comm: "sleep" },
    ]);
  });

  it("rejects an elapsed field that is not an elapsed time", () => {
    expect(parseElapsedSeconds("04:05")).toBe(245);
    expect(parseElapsedSeconds("2-03:04:05")).toBe(183_845);
    expect(parseElapsedSeconds("/bin/zsh")).toBeNull();
    expect(parseElapsedSeconds("")).toBeNull();
  });

  it("finds claude providers that are direct children of the daemon (macOS path + linux basename)", () => {
    const rows = [
      { pid: 100, ppid: 55, elapsedSec: 10, comm: "/opt/homebrew/bin/claude" },
      { pid: 200, ppid: 55, elapsedSec: 10, comm: "claude" },
      { pid: 300, ppid: 55, elapsedSec: 10, comm: "/usr/bin/codex" },
      { pid: 400, ppid: 99, elapsedSec: 10, comm: "claude" }, // not a direct child of the daemon
    ];
    expect(findProviderPids(rows, 55).sort((a, b) => a - b)).toEqual([100, 200]);
  });

  it("detects a live descendant via a direct child, and its absence", () => {
    const idx = buildChildrenIndex([
      { pid: 101, ppid: 100, elapsedSec: 5, comm: "/bin/zsh" },
      { pid: 102, ppid: 101, elapsedSec: 5, comm: "sleep" },
    ]);
    expect(hasDescendant(100, idx)).toBe(true);
    expect(hasDescendant(999, idx)).toBe(false);
  });

  it("extracts FIRST_TREE_CHAT_ID from a Darwin `ps -E` (space-separated) line", () => {
    const line = "FIRST_TREE_HOME=/x FIRST_TREE_CHAT_ID=f93566d9-00c8 FIRST_TREE_AGENT_ID=019e /bin/claude";
    expect(extractChatId(line)).toBe("f93566d9-00c8");
    expect(extractChatId("no marker here")).toBeNull();
  });

  it("extracts FIRST_TREE_CHAT_ID from Linux `/proc/<pid>/environ` (NUL-separated), stopping at the NUL", () => {
    const environ = ["FIRST_TREE_HOME=/x", "FIRST_TREE_CHAT_ID=f93566d9-00c8", "FIRST_TREE_AGENT_ID=019e", ""].join(
      "\0",
    );
    // The value must not bleed into the next NUL-separated entry.
    expect(extractChatId(environ)).toBe("f93566d9-00c8");
  });
});

describe("the real ps adapter", () => {
  it("produces rows this parser accepts, including our own process", async () => {
    // Every other test here injects a fixture, so none of them can see the
    // adapter and the parser disagreeing about columns. That mismatch is
    // silent and total: no row parses, both result sets publish empty, and the
    // idle-suspend protection that predates this feature dies with it. This
    // runs the actual command instead.
    const rows = parseProcessRows(await defaultProcessSnapshot());
    expect(rows.length).toBeGreaterThan(0);
    const self = rows.find((row) => row.pid === process.pid);
    expect(self, "this process should appear in its own ps output").toBeTruthy();
    expect(self?.ppid).toBe(process.ppid);
    expect(self?.elapsedSec).toBeGreaterThanOrEqual(0);
    expect(self?.comm.length).toBeGreaterThan(0);
  });
});

describe("PsSubprocessProbe", () => {
  const daemonPid = 55;
  const T0 = new Date("2026-09-02T00:00:00Z").getTime();

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A `pid ppid etime comm` row. `ageSec` is the process's age at the moment of
   * the scan — the datum the probe classifies on, so every case here states it
   * explicitly rather than letting wall-clock timing decide.
   */
  const proc = (pid: number, ppid: number, ageSec: number, comm: string): string =>
    `${pid} ${ppid} ${Math.floor(ageSec / 60)}:${String(ageSec % 60).padStart(2, "0")} ${comm}`;

  function probeOver(rows: () => string[], chatId: string): PsSubprocessProbe {
    return new PsSubprocessProbe({
      log: silentLogger(),
      daemonPid,
      intervalMs: 1_000_000,
      runProcessSnapshot: async () => rows().join("\n"),
      runEnvForPid: async () => `FIRST_TREE_CHAT_ID=${chatId} /bin/claude`,
    });
  }

  it("marks only providers that currently have a live descendant", async () => {
    const rows = [
      proc(100, daemonPid, 60, "/opt/homebrew/bin/claude"),
      proc(101, 100, 50, "/bin/zsh"),
      proc(200, daemonPid, 60, "/opt/homebrew/bin/claude"),
    ];
    const probe = new PsSubprocessProbe({
      log: silentLogger(),
      daemonPid,
      intervalMs: 1_000_000,
      runProcessSnapshot: async () => rows.join("\n"),
      runEnvForPid: async (pid) =>
        pid === 100 ? "FIRST_TREE_CHAT_ID=chat-A /bin/claude" : "FIRST_TREE_CHAT_ID=chat-B /bin/claude",
    });
    await probe.refresh();
    expect(probe.hasLiveSubprocess("chat-A")).toBe(true);
    expect(probe.hasLiveSubprocess("chat-B")).toBe(false);
    expect(probe.hasLiveSubprocess("chat-unknown")).toBe(false);
    probe.stop();
  });

  it("does not call a long-lived stdio MCP server session-spawned work", async () => {
    // Every provider on an MCP-configured host has a permanent `npm exec … mcp`
    // child. Reading that as "background task" would put the qualifier on every
    // idle chat on the machine — the opposite of what it is for.
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const chatId = "chat-mcp";
    let rows = [proc(300, daemonPid, 120, "/opt/homebrew/bin/claude"), proc(301, 300, 119, "npm exec momentic mcp")];
    const probe = probeOver(() => rows, chatId);

    await probe.refresh();
    expect(probe.hasLiveSubprocess(chatId)).toBe(true);
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(false);

    probe.noteTurnBoundary(chatId); // a turn begins at T0
    vi.setSystemTime(T0 + 30_000); // the next scan is 30s later
    rows = [
      proc(300, daemonPid, 150, "/opt/homebrew/bin/claude"),
      proc(301, 300, 149, "npm exec momentic mcp"),
      proc(302, 300, 20, "/bin/zsh"), // the watcher the turn launched
      proc(303, 302, 20, "sleep"),
    ];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(true);

    // The watcher exits; the permanent MCP child must not keep the claim alive.
    vi.setSystemTime(T0 + 60_000);
    rows = [proc(300, daemonPid, 180, "/opt/homebrew/bin/claude"), proc(301, 300, 179, "npm exec momentic mcp")];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(false);
    probe.stop();
  });

  it("classifies by process age, not by when the scan happens to run", async () => {
    // The interleaving that defeats every observation-order rule: a scan lands
    // while the provider is still alone, its MCP child starts afterwards, and
    // only then does the first turn begin. Ages settle it whatever the scans did.
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const chatId = "chat-late-mcp";
    let rows = [proc(900, daemonPid, 2, "/opt/homebrew/bin/claude")];
    const probe = probeOver(() => rows, chatId);

    await probe.refresh(); // provider observed alone — an incomplete picture
    vi.setSystemTime(T0 + 5_000);
    rows = [proc(900, daemonPid, 7, "/opt/homebrew/bin/claude"), proc(901, 900, 4, "npm exec momentic mcp")];
    probe.noteTurnBoundary(chatId); // MCP is up by the time the turn begins
    vi.setSystemTime(T0 + 40_000);
    rows = [proc(900, daemonPid, 42, "/opt/homebrew/bin/claude"), proc(901, 900, 39, "npm exec momentic mcp")];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(false);
    probe.stop();
  });

  it("reports a watcher even when the scan proving it runs long afterwards", async () => {
    // Nothing about the boundary is captured asynchronously, so a scan that
    // completes well after the work began still classifies it correctly — the
    // false negative a fire-and-forget snapshot had.
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const chatId = "chat-late-scan";
    let rows = [proc(950, daemonPid, 120, "/opt/homebrew/bin/claude"), proc(951, 950, 119, "npm exec momentic mcp")];
    const probe = probeOver(() => rows, chatId);
    await probe.refresh();
    probe.noteTurnBoundary(chatId);

    vi.setSystemTime(T0 + 120_000); // two minutes of no scans at all
    rows = [
      proc(950, daemonPid, 240, "/opt/homebrew/bin/claude"),
      proc(951, 950, 239, "npm exec momentic mcp"),
      proc(952, 950, 118, "/bin/zsh"), // started right after the boundary
    ];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(true);
    probe.stop();
  });

  it("keeps reporting a background task that survives into a later turn", async () => {
    // The provider keeps its first boundary, so a task that outlived turn 1 is
    // not reclassified as infrastructure when turn 2 opens.
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const chatId = "chat-survives";
    let rows = [proc(700, daemonPid, 120, "/opt/homebrew/bin/claude"), proc(701, 700, 119, "npm exec momentic mcp")];
    const probe = probeOver(() => rows, chatId);
    await probe.refresh();
    probe.noteTurnBoundary(chatId);

    vi.setSystemTime(T0 + 30_000);
    rows = [
      proc(700, daemonPid, 150, "/opt/homebrew/bin/claude"),
      proc(701, 700, 149, "npm exec momentic mcp"),
      proc(702, 700, 20, "/bin/zsh"),
    ];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(true);

    vi.setSystemTime(T0 + 90_000);
    probe.noteTurnBoundary(chatId); // turn 2, with the watcher still running
    rows = [
      proc(700, daemonPid, 210, "/opt/homebrew/bin/claude"),
      proc(701, 700, 209, "npm exec momentic mcp"),
      proc(702, 700, 80, "/bin/zsh"),
    ];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(true);
    probe.stop();
  });

  it("keeps the first in-turn event's boundary when the same turn emits more", async () => {
    // Every assistant/thinking/tool event reaches noteTurnBoundary, so a later
    // event in the SAME turn must not move the boundary past a watcher an
    // earlier one already launched.
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const chatId = "chat-repeat-events";
    let rows = [proc(1200, daemonPid, 120, "/opt/homebrew/bin/claude"), proc(1201, 1200, 119, "npm exec momentic mcp")];
    const probe = probeOver(() => rows, chatId);
    await probe.refresh();

    probe.noteTurnBoundary(chatId); // first tool call of the turn, at T0
    vi.setSystemTime(T0 + 10_000);
    rows = [...rows, proc(1202, 1200, 0, "/bin/zsh")]; // …which launches a watcher
    vi.setSystemTime(T0 + 20_000);
    probe.noteTurnBoundary(chatId); // a second event in the same turn

    vi.setSystemTime(T0 + 60_000);
    rows = [
      proc(1200, daemonPid, 180, "/opt/homebrew/bin/claude"),
      proc(1201, 1200, 179, "npm exec momentic mcp"),
      proc(1202, 1200, 50, "/bin/zsh"),
    ];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(true);
    probe.stop();
  });

  it("classifies against the window ps was actually sampled in, not the scan's start", async () => {
    // `ps` can take seconds to return. Deriving both start bounds from one
    // timestamp taken BEFORE the command runs shifts them backwards by that
    // delay — enough for a replacement to accept a boundary that predates it
    // and then report its own permanent MCP child as work.
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const chatId = "chat-slow-ps";
    let rows: string[] = [];
    let holdNext: { promise: Promise<string>; resolve: () => void } | null = null;
    const probe = new PsSubprocessProbe({
      log: silentLogger(),
      daemonPid,
      intervalMs: 1_000_000,
      runProcessSnapshot: async () => {
        if (!holdNext) return rows.join("\n");
        const held = holdNext;
        holdNext = null;
        return held.promise;
      },
      runEnvForPid: async () => `FIRST_TREE_CHAT_ID=${chatId} /bin/claude`,
    });

    rows = [proc(1500, daemonPid, 300, "/opt/homebrew/bin/claude"), proc(1501, 1500, 299, "npm exec momentic mcp")];
    await probe.refresh();
    probe.noteTurnBoundary(chatId); // predecessor boundary at T0

    // A scan starts at T0+6s; its `ps` does not return until T0+16s, by which
    // point the replacement provider (started at T0+5s) is 11s old.
    vi.setSystemTime(T0 + 6_000);
    let resolveHeld!: (value: string) => void;
    const heldPromise = new Promise<string>((resolve) => {
      resolveHeld = resolve;
    });
    holdNext = { promise: heldPromise, resolve: () => resolveHeld("") };
    const pending = probe.refresh();
    vi.setSystemTime(T0 + 16_000);
    resolveHeld(
      [proc(1600, daemonPid, 11, "/opt/homebrew/bin/claude"), proc(1601, 1600, 10, "npm exec momentic mcp")].join("\n"),
    );
    await pending;

    // Measured from the scan's start the provider looks born at T0-5s and the
    // predecessor's boundary looks valid for it; measured from when `ps`
    // actually sampled, it does not. The damage shows on the NEXT ordinary
    // scan, where a wrongly adopted boundary turns the replacement's permanent
    // MCP child into "work" — so the assertion has to look one scan further.
    vi.setSystemTime(T0 + 20_000);
    rows = [proc(1600, daemonPid, 15, "/opt/homebrew/bin/claude"), proc(1601, 1600, 14, "npm exec momentic mcp")];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(false);
    probe.stop();
  });

  it("lets a replacement recover with its own turn after rejecting a stale boundary", async () => {
    // A pending timestamp a provider rejects as older than itself must not
    // linger: it would block every later turn from being recorded, and the
    // replacement's work would stay hidden for its whole life.
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const chatId = "chat-recover";
    let rows = [proc(1700, daemonPid, 300, "/opt/homebrew/bin/claude"), proc(1701, 1700, 299, "npm exec momentic mcp")];
    const probe = probeOver(() => rows, chatId);
    await probe.refresh();
    probe.noteTurnBoundary(chatId); // predecessor boundary at T0

    // Replaced; the scan rejects the stale boundary for the new provider.
    vi.setSystemTime(T0 + 5_000);
    rows = [proc(1800, daemonPid, 2, "/opt/homebrew/bin/claude"), proc(1801, 1800, 1, "npm exec momentic mcp")];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(false);

    // Its own first turn, then a watcher it launches: both must register.
    vi.setSystemTime(T0 + 20_000);
    probe.noteTurnBoundary(chatId);
    vi.setSystemTime(T0 + 60_000);
    rows = [
      proc(1800, daemonPid, 57, "/opt/homebrew/bin/claude"),
      proc(1801, 1800, 56, "npm exec momentic mcp"),
      proc(1802, 1800, 30, "/bin/zsh"),
    ];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(true);
    probe.stop();
  });

  it("does not let a same-second replacement adopt its predecessor's boundary", async () => {
    // One-second resolution means a provider born in the same second as the
    // previous boundary cannot prove the boundary came after it started. Fail
    // closed: wait for a boundary that definitely does.
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const chatId = "chat-same-second";
    let rows = [proc(1300, daemonPid, 300, "/opt/homebrew/bin/claude"), proc(1301, 1300, 299, "npm exec momentic mcp")];
    const probe = probeOver(() => rows, chatId);
    await probe.refresh();
    probe.noteTurnBoundary(chatId); // predecessor boundary at T0

    // Replacement starts ~0.5s later, its MCP child ~0.6s later; first scan at
    // T0+1.5s reports ages of 1s and 0s.
    vi.setSystemTime(T0 + 1_500);
    rows = [proc(1400, daemonPid, 1, "/opt/homebrew/bin/claude"), proc(1401, 1400, 0, "npm exec momentic mcp")];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(false);
    probe.stop();
  });

  it("claims nothing for a provider that has not reached a turn boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const chatId = "chat-no-boundary-yet";
    const probe = probeOver(
      () => [
        proc(800, daemonPid, 60, "/opt/homebrew/bin/claude"),
        proc(801, 800, 59, "npm exec momentic mcp"),
        proc(802, 800, 5, "/bin/zsh"),
      ],
      chatId,
    );
    await probe.refresh();
    expect(probe.hasLiveSubprocess(chatId)).toBe(true);
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(false);
    probe.stop();
  });

  it("gives a replacement provider its own boundary, with no scan in between", async () => {
    // The chat keeps a live provider across the swap, so a chat-level seal
    // would never re-arm. A boundary older than the process cannot belong to
    // it, so the replacement waits for its own turn.
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const chatId = "chat-replace";
    let rows = [proc(1000, daemonPid, 300, "/opt/homebrew/bin/claude"), proc(1001, 1000, 299, "npm exec momentic mcp")];
    const probe = probeOver(() => rows, chatId);
    await probe.refresh();
    probe.noteTurnBoundary(chatId);
    vi.setSystemTime(T0 + 30_000);
    rows = [proc(1000, daemonPid, 330, "/opt/homebrew/bin/claude"), proc(1001, 1000, 329, "npm exec momentic mcp")];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(false);

    // Replaced with no scan in between: the new pid is younger than the old
    // boundary, so it does not adopt it and claims nothing yet.
    vi.setSystemTime(T0 + 60_000);
    rows = [proc(1100, daemonPid, 2, "/opt/homebrew/bin/claude"), proc(1101, 1100, 1, "npm exec momentic mcp")];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(false);

    // Its own first turn, then a watcher it launches.
    probe.noteTurnBoundary(chatId);
    vi.setSystemTime(T0 + 120_000);
    rows = [
      proc(1100, daemonPid, 62, "/opt/homebrew/bin/claude"),
      proc(1101, 1100, 61, "npm exec momentic mcp"),
      proc(1102, 1100, 30, "/bin/zsh"),
    ];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(true);
    probe.stop();
  });

  it("attributes providers from NUL-separated env (Linux /proc form)", async () => {
    const probe = new PsSubprocessProbe({
      log: silentLogger(),
      daemonPid,
      intervalMs: 1_000_000,
      runProcessSnapshot: async () =>
        [proc(100, daemonPid, 60, "/opt/homebrew/bin/claude"), proc(101, 100, 50, "/bin/zsh")].join("\n"),
      runEnvForPid: async () => ["FIRST_TREE_HOME=/x", "FIRST_TREE_CHAT_ID=chat-A", ""].join("\0"),
    });
    await probe.refresh();
    expect(probe.hasLiveSubprocess("chat-A")).toBe(true);
    probe.stop();
  });

  it("falls back to no-live-work when the process scan fails", async () => {
    const probe = new PsSubprocessProbe({
      log: silentLogger(),
      daemonPid,
      intervalMs: 1_000_000,
      runProcessSnapshot: async () => {
        throw new Error("ps unavailable");
      },
      runEnvForPid: async () => "FIRST_TREE_CHAT_ID=chat-A /bin/claude",
    });
    await probe.refresh();
    expect(probe.hasLiveSubprocess("chat-A")).toBe(false);
    expect(probe.hasSessionSpawnedSubprocess("chat-A")).toBe(false);
    probe.stop();
  });
});
