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
    rows = [...mcpOnly, "302  300 /bin/zsh", "303  302 sleep"];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess("chat-mcp")).toBe(true);

    // It finishes; the permanent MCP child alone must not keep the claim alive.
    rows = [...mcpOnly];
    await probe.refresh();
    expect(probe.hasSessionSpawnedSubprocess("chat-mcp")).toBe(false);
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
    expect(probe.hasSessionSpawnedSubprocess("chat-restart")).toBe(false);

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
