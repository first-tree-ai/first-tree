import { describe, expect, it } from "vitest";
import {
  buildChildrenIndex,
  extractChatId,
  findProviderPids,
  hasDescendant,
  PsSubprocessProbe,
  parseProcessRows,
} from "../runtime/process-tree-probe.js";
import { silentLogger } from "./_logger-helpers.js";

describe("process-tree-probe pure helpers", () => {
  it("parses ps pid/ppid/comm rows and skips unparseable lines", () => {
    const out = ["  100   55 /opt/homebrew/bin/claude", " 101  100 /bin/zsh", "garbage", "", "102 101 sleep"].join(
      "\n",
    );
    expect(parseProcessRows(out)).toEqual([
      { pid: 100, ppid: 55, comm: "/opt/homebrew/bin/claude" },
      { pid: 101, ppid: 100, comm: "/bin/zsh" },
      { pid: 102, ppid: 101, comm: "sleep" },
    ]);
  });

  it("finds claude providers that are direct children of the daemon (macOS path + linux basename)", () => {
    const rows = [
      { pid: 100, ppid: 55, comm: "/opt/homebrew/bin/claude" },
      { pid: 200, ppid: 55, comm: "claude" },
      { pid: 300, ppid: 55, comm: "/usr/bin/codex" },
      { pid: 400, ppid: 99, comm: "claude" }, // not a direct child of the daemon
    ];
    expect(findProviderPids(rows, 55).sort((a, b) => a - b)).toEqual([100, 200]);
  });

  it("detects a live descendant via a direct child, and its absence", () => {
    const idx = buildChildrenIndex([
      { pid: 101, ppid: 100, comm: "/bin/zsh" },
      { pid: 102, ppid: 101, comm: "sleep" },
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

describe("PsSubprocessProbe", () => {
  const daemonPid = 55;
  // chat-A provider (100) has a live watcher; chat-B provider (200) has none.
  const snapshot = [
    `100  ${daemonPid} /opt/homebrew/bin/claude`,
    "101  100 /bin/zsh",
    "102  101 sleep",
    `200  ${daemonPid} /opt/homebrew/bin/claude`,
  ].join("\n");
  const envForPid = async (pid: number): Promise<string> =>
    pid === 100 ? "FIRST_TREE_CHAT_ID=chat-A /bin/claude" : "FIRST_TREE_CHAT_ID=chat-B /bin/claude";

  it("marks only providers that currently have a live descendant", async () => {
    const probe = new PsSubprocessProbe({
      log: silentLogger(),
      daemonPid,
      intervalMs: 1_000_000,
      runProcessSnapshot: async () => snapshot,
      runEnvForPid: envForPid,
    });
    await probe.refresh();
    expect(probe.hasLiveSubprocess("chat-A")).toBe(true);
    expect(probe.hasLiveSubprocess("chat-B")).toBe(false);
    expect(probe.hasLiveSubprocess("chat-unknown")).toBe(false);
    probe.stop();
  });

  it("attributes providers from NUL-separated env (Linux /proc form)", async () => {
    const probe = new PsSubprocessProbe({
      log: silentLogger(),
      daemonPid,
      intervalMs: 1_000_000,
      runProcessSnapshot: async () => snapshot,
      runEnvForPid: async (pid) =>
        ["FIRST_TREE_HOME=/x", `FIRST_TREE_CHAT_ID=${pid === 100 ? "chat-A" : "chat-B"}`, ""].join("\0"),
    });
    await probe.refresh();
    expect(probe.hasLiveSubprocess("chat-A")).toBe(true);
    expect(probe.hasLiveSubprocess("chat-B")).toBe(false);
    probe.stop();
  });

  it("does not call a long-lived stdio MCP server session-spawned work", async () => {
    // The shape that made this distinction necessary: on a host running
    // MCP-configured agents, EVERY provider has a permanent `npm exec … mcp`
    // child. Reading that as "background task" would put the qualifier on
    // every idle chat on the machine — the opposite of what it is for.
    const mcpOnly = [`300  ${daemonPid} /opt/homebrew/bin/claude`, "301  300 npm exec momentic mcp --config /x.yaml"];
    const env = async (): Promise<string> => "FIRST_TREE_CHAT_ID=chat-mcp /bin/claude";
    let rows = [...mcpOnly];
    const probe = new PsSubprocessProbe({
      log: silentLogger(),
      daemonPid,
      intervalMs: 1_000_000,
      runProcessSnapshot: async () => rows.join("\n"),
      runEnvForPid: env,
    });

    await probe.refresh();
    // Broad predicate still true — the eviction deferral it feeds is meant to
    // be conservative — but nothing this session started is running.
    expect(probe.hasLiveSubprocess("chat-mcp")).toBe(true);
    expect(probe.hasSessionSpawnedSubprocess("chat-mcp")).toBe(false);

    // A turn launches a background watcher: a child the baseline never saw.
    probe.sealBaseline("chat-mcp");
    rows = [...mcpOnly, "302  300 /bin/zsh", "303  302 sleep"];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess("chat-mcp")).toBe(true);

    // It finishes; the permanent MCP child alone must not keep the claim alive.
    rows = [...mcpOnly];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess("chat-mcp")).toBe(false);
    probe.stop();
  });

  it("absorbs a startup MCP child that appears after the provider is first seen", async () => {
    // The poll starts before any provider exists, so a scan can catch the
    // `claude` process in the gap before its stdio MCP server spawns. Freezing
    // the baseline on first sight would store nothing, and the MCP child
    // arriving one scan later would read as background work for the rest of
    // that provider's life — the very claim the baseline exists to prevent.
    const chatId = "chat-startup-race";
    let rows = [`600  ${daemonPid} /opt/homebrew/bin/claude`];
    const probe = new PsSubprocessProbe({
      log: silentLogger(),
      daemonPid,
      intervalMs: 1_000_000,
      runProcessSnapshot: async () => rows.join("\n"),
      runEnvForPid: async () => `FIRST_TREE_CHAT_ID=${chatId} /bin/claude`,
    });

    // Scan 1: provider only, still starting up.
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(false);

    // Scan 2: the permanent MCP child has arrived, still before any turn.
    rows = [`600  ${daemonPid} /opt/homebrew/bin/claude`, "601  600 npm exec momentic mcp"];
    await probe.refresh();
    expect(probe.hasLiveSubprocess(chatId)).toBe(true);
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(false);

    // The first turn closes the baseline: everything alive now is infrastructure.
    probe.sealBaseline(chatId);
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(false);

    // A task the turn launches is outside it.
    rows = [`600  ${daemonPid} /opt/homebrew/bin/claude`, "601  600 npm exec momentic mcp", "602  600 /bin/zsh"];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(true);
    probe.stop();
  });

  it("keeps reporting a background task that survives into a later turn", async () => {
    // The baseline seals ONCE, at the first turn. Re-taking it at every turn
    // start would absorb a task that outlived the previous turn and silence it
    // — which is the exact case this feature exists to report.
    const chatId = "chat-survives";
    let rows = [`700  ${daemonPid} /opt/homebrew/bin/claude`, "701  700 npm exec momentic mcp"];
    const probe = new PsSubprocessProbe({
      log: silentLogger(),
      daemonPid,
      intervalMs: 1_000_000,
      runProcessSnapshot: async () => rows.join("\n"),
      runEnvForPid: async () => `FIRST_TREE_CHAT_ID=${chatId} /bin/claude`,
    });
    await probe.refresh();
    probe.sealBaseline(chatId);
    await probe.refresh();

    // Turn 1 launches a watcher that outlives it.
    rows = [...rows, "702  700 /bin/zsh"];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(true);

    // Turn 2 starts with that watcher still running: it must stay reported.
    probe.sealBaseline(chatId);
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(true);
    probe.stop();
  });

  it("stays silent for a provider first observed after its session is already running", async () => {
    // A provider whose first scan lands mid-turn cannot be told apart from one
    // that always had those children, so its whole tree becomes the baseline.
    // That under-reports until they exit — silence, not a false claim.
    const chatId = "chat-late-first-scan";
    const probe = new PsSubprocessProbe({
      log: silentLogger(),
      daemonPid,
      intervalMs: 1_000_000,
      runProcessSnapshot: async () =>
        [`800  ${daemonPid} /opt/homebrew/bin/claude`, "801  800 npm exec momentic mcp", "802  800 /bin/zsh"].join(
          "\n",
        ),
      runEnvForPid: async () => `FIRST_TREE_CHAT_ID=${chatId} /bin/claude`,
    });
    probe.sealBaseline(chatId);
    await probe.refresh();
    expect(probe.hasLiveSubprocess(chatId)).toBe(true);
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(false);
    probe.stop();
  });

  it("re-baselines when the provider process is replaced", async () => {
    // Baselines are keyed by provider pid, so a restarted provider must not
    // inherit the old one's children as its session infrastructure.
    let rows = [`400  ${daemonPid} /opt/homebrew/bin/claude`, "401  400 npm exec momentic mcp"];
    const probe = new PsSubprocessProbe({
      log: silentLogger(),
      daemonPid,
      intervalMs: 1_000_000,
      runProcessSnapshot: async () => rows.join("\n"),
      runEnvForPid: async () => "FIRST_TREE_CHAT_ID=chat-restart /bin/claude",
    });
    await probe.refresh();
    probe.sealBaseline("chat-restart");
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess("chat-restart")).toBe(false);

    // New provider process for the same chat: its own startup window, so the
    // replacement's MCP child must not be read as work the session launched.
    rows = [`500  ${daemonPid} /opt/homebrew/bin/claude`, "501  500 npm exec momentic mcp"];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess("chat-restart")).toBe(false);
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
      runEnvForPid: envForPid,
    });
    await probe.refresh();
    expect(probe.hasLiveSubprocess("chat-A")).toBe(false);
    expect(probe.hasSessionSpawnedSubprocess("chat-A")).toBe(false);
    probe.stop();
  });
});
