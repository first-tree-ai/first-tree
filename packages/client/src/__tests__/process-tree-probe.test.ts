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

/** `sealBaseline` captures its snapshot fire-and-forget; drain that microtask. */
async function flushBoundaryCapture(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

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
    let rows = [...mcpOnly];
    const probe = new PsSubprocessProbe({
      log: silentLogger(),
      daemonPid,
      intervalMs: 1_000_000,
      runProcessSnapshot: async () => rows.join("\n"),
      runEnvForPid: async () => "FIRST_TREE_CHAT_ID=chat-mcp /bin/claude",
    });

    await probe.refresh();
    // Broad predicate still true — the eviction deferral it feeds is meant to
    // be conservative — but nothing this session started is running.
    expect(probe.hasLiveSubprocess("chat-mcp")).toBe(true);
    expect(probe.hasSessionSpawnedSubprocess("chat-mcp")).toBe(false);

    // A turn begins: the boundary snapshot records the MCP child as infrastructure.
    probe.sealBaseline("chat-mcp");
    await flushBoundaryCapture();

    // That turn launches a background watcher.
    rows = [...mcpOnly, "302  300 /bin/zsh", "303  302 sleep"];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess("chat-mcp")).toBe(true);

    // It finishes; the permanent MCP child alone must not keep the claim alive.
    rows = [...mcpOnly];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess("chat-mcp")).toBe(false);
    probe.stop();
  });

  it("takes the baseline at the turn boundary, whenever the MCP child happened to start", async () => {
    // The interleaving that defeats any scan-order rule: a scan lands while the
    // provider is still alone, THEN its MCP server starts, and only then does a
    // turn begin. "Observed before the turn" is true of that first scan and
    // tells you nothing, because what it observed was incomplete.
    const chatId = "chat-mcp-after-scan";
    let rows = [`900  ${daemonPid} /opt/homebrew/bin/claude`];
    const probe = new PsSubprocessProbe({
      log: silentLogger(),
      daemonPid,
      intervalMs: 1_000_000,
      runProcessSnapshot: async () => rows.join("\n"),
      runEnvForPid: async () => `FIRST_TREE_CHAT_ID=${chatId} /bin/claude`,
    });

    await probe.refresh(); // provider seen alone
    rows = [`900  ${daemonPid} /opt/homebrew/bin/claude`, "901  900 npm exec momentic mcp"]; // MCP starts after
    probe.sealBaseline(chatId); // …and only now does the first turn begin
    await flushBoundaryCapture();

    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(false);

    // The boundary still lets real work through afterwards.
    rows = [...rows, "902  900 /bin/zsh"];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(true);
    probe.stop();
  });

  it("keeps reporting a background task that survives into a later turn", async () => {
    // The boundary is taken once per provider. Re-taking it at every turn would
    // absorb a task that outlived the previous turn and silence it — the exact
    // case this feature exists to report.
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
    await flushBoundaryCapture();

    // Turn 1 launches a watcher that outlives it.
    rows = [...rows, "702  700 /bin/zsh"];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(true);

    // Turn 2 starts with that watcher still running: it must stay reported.
    probe.sealBaseline(chatId);
    await flushBoundaryCapture();
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(true);
    probe.stop();
  });

  it("claims nothing for a provider that has not reached a turn boundary", async () => {
    // A replacement provider between turns has no boundary yet. Silence until
    // its next turn, rather than guessing which of its children are its own.
    const chatId = "chat-no-boundary-yet";
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
    await probe.refresh();
    expect(probe.hasLiveSubprocess(chatId)).toBe(true);
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(false);
    probe.stop();
  });

  it("gives a seamless replacement provider its own boundary at the next turn", async () => {
    // The chat never loses a live provider across a restart, so a chat-level
    // seal would never re-arm. Baselines are per pid and taken at a boundary,
    // so the replacement gets its own — including when it is seen before its
    // MCP child exists.
    const chatId = "chat-seamless-replace";
    let rows = [`1000 ${daemonPid} /opt/homebrew/bin/claude`, "1001 1000 npm exec momentic mcp"];
    const probe = new PsSubprocessProbe({
      log: silentLogger(),
      daemonPid,
      intervalMs: 1_000_000,
      runProcessSnapshot: async () => rows.join("\n"),
      runEnvForPid: async () => `FIRST_TREE_CHAT_ID=${chatId} /bin/claude`,
    });
    await probe.refresh();
    probe.sealBaseline(chatId);
    await flushBoundaryCapture();
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(false);

    // Replaced between scans, observed before its MCP child.
    rows = [`1100 ${daemonPid} /opt/homebrew/bin/claude`];
    await probe.refresh();
    rows = [`1100 ${daemonPid} /opt/homebrew/bin/claude`, "1101 1100 npm exec momentic mcp"];
    probe.sealBaseline(chatId); // the next turn on the new provider
    await flushBoundaryCapture();

    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(false);

    rows = [...rows, "1102 1100 /bin/zsh"];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess(chatId)).toBe(true);
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
