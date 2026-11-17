import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

type SpawnRecord = {
  command: string;
  args: string[];
  options: unknown;
  child: FakeChild;
};

type SpawnBehavior = (record: SpawnRecord) => void;

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

function installSpawnMock(behavior: SpawnBehavior): {
  records: SpawnRecord[];
  spawn: ReturnType<typeof vi.fn>;
} {
  const records: SpawnRecord[] = [];
  const spawn = vi.fn((command: string, args: string[], options: unknown) => {
    const child = new FakeChild();
    const record = { args, child, command, options };
    records.push(record);
    behavior(record);
    return child;
  });
  vi.doMock("node:child_process", () => ({ spawn }));
  return { records, spawn };
}

function closeSoon(
  record: SpawnRecord,
  options: { code?: number | null; stdout?: string; stderr?: string } = {},
): void {
  queueMicrotask(() => {
    if (options.stdout) record.child.stdout.emit("data", Buffer.from(options.stdout));
    if (options.stderr) record.child.stderr.emit("data", Buffer.from(options.stderr));
    record.child.emit("close", options.code ?? 0);
  });
}

describe("tmux command helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("starts a detached session with defaults, env, cwd, and command", async () => {
    const { records } = installSpawnMock((record) => closeSoon(record));
    const { newSession } = await import("../../tui/tmux-session.js");

    await newSession({
      name: "ftth-test",
      cwd: "/repo",
      command: "claude --dangerously-skip-permissions",
      env: { FIRST_TREE_AGENT_ID: "agent-1", HOME: "/tmp/home" },
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      command: "tmux",
      options: { stdio: ["ignore", "pipe", "pipe"] },
    });
    expect(records[0]?.args).toEqual([
      "new-session",
      "-d",
      "-s",
      "ftth-test",
      "-x",
      "220",
      "-y",
      "60",
      "-c",
      "/repo",
      "-e",
      "FIRST_TREE_AGENT_ID=agent-1",
      "-e",
      "HOME=/tmp/home",
      "claude --dangerously-skip-permissions",
    ]);
  });

  it("respects explicit session dimensions", async () => {
    const { records } = installSpawnMock((record) => closeSoon(record));
    const { newSession } = await import("../../tui/tmux-session.js");

    await newSession({ name: "ftth-size", cwd: "/repo", command: "claude", width: 120, height: 40 });

    expect(records[0]?.args.slice(0, 10)).toEqual([
      "new-session",
      "-d",
      "-s",
      "ftth-size",
      "-x",
      "120",
      "-y",
      "40",
      "-c",
      "/repo",
    ]);
  });

  it("pastes text through a temporary buffer, sends Enter, and deletes the buffer", async () => {
    const { records } = installSpawnMock((record) => {
      if (record.args[0] === "load-buffer") {
        const file = record.args.at(-1);
        expect(typeof file).toBe("string");
        expect(readFileSync(file as string, "utf8")).toBe("hello\n`$world");
      }
      closeSoon(record);
    });
    const { pasteText } = await import("../../tui/tmux-session.js");

    await pasteText("ftth-paste", "hello\n`$world");

    expect(records.map((record) => record.args.slice(0, 4))).toEqual([
      ["load-buffer", "-b", "ftth-paste-msg", expect.stringContaining("msg.txt")],
      ["paste-buffer", "-b", "ftth-paste-msg", "-t"],
      ["send-keys", "-t", "ftth-paste", "Enter"],
      ["delete-buffer", "-b", "ftth-paste-msg"],
    ]);
    expect(records[1]?.args).toEqual(["paste-buffer", "-b", "ftth-paste-msg", "-t", "ftth-paste", "-p", "-d"]);
  });

  it("still deletes the tmux buffer when paste fails", async () => {
    const { records } = installSpawnMock((record) => {
      if (record.args[0] === "paste-buffer") {
        closeSoon(record, { code: 1, stderr: "paste failed" });
        return;
      }
      closeSoon(record);
    });
    const { pasteText } = await import("../../tui/tmux-session.js");

    await expect(pasteText("ftth-fail", "secret")).rejects.toThrow(
      "tmux paste-buffer -b ftth-fail-msg -t ftth-fail -p -d failed",
    );

    expect(records.map((record) => record.args[0])).toEqual(["load-buffer", "paste-buffer", "delete-buffer"]);
  });

  it("wraps tmux stderr, stdout, exit code, and spawn errors for command helpers", async () => {
    installSpawnMock((record) => {
      if (record.args[0] === "send-keys" && record.args.at(-1) === "Escape") {
        closeSoon(record, { code: 2, stderr: "bad key" });
        return;
      }
      queueMicrotask(() => record.child.emit("error", new Error("spawn ENOENT")));
    });
    const { capturePane, sendKey } = await import("../../tui/tmux-session.js");

    await expect(sendKey("ftth-error", "Escape")).rejects.toThrow(
      "tmux send-keys -t ftth-error Escape failed (code=2): bad key",
    );
    await expect(capturePane("ftth-error")).rejects.toThrow(
      "tmux capture-pane -t ftth-error -p failed (code=n/a): spawn ENOENT",
    );
  });

  it("masks -e values in a failed new-session diagnostic", async () => {
    // SEC-032: `-e KEY=value` carries the agent's decrypted provider env, and
    // this message reaches the client log.
    installSpawnMock((record) => closeSoon(record, { code: 1, stderr: "server exited" }));
    const { newSession } = await import("../../tui/tmux-session.js");

    await expect(
      newSession({
        name: "ftth-secret",
        cwd: "/repo",
        command: "claude",
        env: { OPENAI_API_KEY: "sk-live-do-not-log", PATH: "/usr/bin" },
      }),
    ).rejects.toThrow(
      "tmux new-session -d -s ftth-secret -x 220 -y 60 -c /repo -e OPENAI_API_KEY=*** -e PATH=*** claude failed (code=1): stderr withheld: this launch carries -e environment values",
    );

    await expect(
      newSession({
        name: "ftth-secret-2",
        cwd: "/repo",
        command: "claude",
        env: { OPENAI_API_KEY: "sk-live-do-not-log" },
      }),
    ).rejects.not.toThrow("sk-live-do-not-log");
  });

  it("withholds free-form stderr when tmux quotes a credential value back", async () => {
    // SEC-032: tmux quotes the offending assignment back, e.g.
    // "invalid environment variable: OPENAI_API_KEY=sk-live-…". Substituting the
    // values we know cannot cover re-quoted/truncated forms, so the whole stream
    // is withheld and only the exit code is forwarded.
    installSpawnMock((record) =>
      closeSoon(record, { code: 1, stderr: "server exited: OPENAI_API_KEY=sk-live-do-not-log (invalid)" }),
    );
    const { newSession } = await import("../../tui/tmux-session.js");

    const error = await newSession({
      name: "ftth-echo",
      cwd: "/repo",
      command: "claude",
      env: { OPENAI_API_KEY: "sk-live-do-not-log" },
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).not.toContain("sk-live-do-not-log");
    expect(message).toContain("OPENAI_API_KEY=***");
    expect(message).toContain("stderr withheld: this launch carries -e environment values");
    expect(message).not.toContain("invalid");
  });

  it("keeps stderr verbatim when the launch carries no environment", async () => {
    installSpawnMock((record) => closeSoon(record, { code: 2, stderr: "no server running" }));
    const { newSession } = await import("../../tui/tmux-session.js");

    await expect(newSession({ name: "ftth-noenv", cwd: "/repo", command: "claude" })).rejects.toThrow(
      "failed (code=2): no server running",
    );
  });

  it("keeps non-env arguments verbatim in diagnostics", async () => {
    installSpawnMock((record) => closeSoon(record, { code: 2, stderr: "bad" }));
    const { newSession } = await import("../../tui/tmux-session.js");

    await expect(newSession({ name: "ftth-plain", cwd: "/repo", command: "claude --flag" })).rejects.toThrow(
      "tmux new-session -d -s ftth-plain -x 220 -y 60 -c /repo claude --flag failed (code=2): bad",
    );
  });

  it("captures normal and full-scrollback panes", async () => {
    const { records } = installSpawnMock((record) => closeSoon(record, { stdout: "pane text" }));
    const { capturePane } = await import("../../tui/tmux-session.js");

    await expect(capturePane("ftth-pane")).resolves.toBe("pane text");
    await expect(capturePane("ftth-pane", true)).resolves.toBe("pane text");

    expect(records[0]?.args).toEqual(["capture-pane", "-t", "ftth-pane", "-p"]);
    expect(records[1]?.args).toEqual(["capture-pane", "-t", "ftth-pane", "-p", "-S", "-"]);
  });

  it("reports session existence, kills best-effort, and filters owned sessions", async () => {
    const { records } = installSpawnMock((record) => {
      if (record.args[0] === "has-session") {
        closeSoon(record, { code: record.args.at(-1) === "alive" ? 0 : 1 });
        return;
      }
      if (record.args[0] === "kill-session") {
        closeSoon(record, { code: 1, stderr: "no such session" });
        return;
      }
      closeSoon(record, { stdout: "ftth-abcd-one\n other \nftth-abcd-two\n\n" });
    });
    const { killSession, listOwnedSessions, listSessions, sessionExists } = await import("../../tui/tmux-session.js");

    await expect(sessionExists("alive")).resolves.toBe(true);
    await expect(sessionExists("missing")).resolves.toBe(false);
    await expect(killSession("missing")).resolves.toBeUndefined();
    await expect(listSessions()).resolves.toEqual(["ftth-abcd-one", "other", "ftth-abcd-two"]);
    await expect(listOwnedSessions("ftth-abcd-")).resolves.toEqual(["ftth-abcd-one", "ftth-abcd-two"]);

    expect(records.map((record) => record.args[0])).toEqual([
      "has-session",
      "has-session",
      "kill-session",
      "list-sessions",
      "list-sessions",
    ]);
  });

  it("returns an empty session list when list-sessions fails", async () => {
    installSpawnMock((record) => closeSoon(record, { code: 1, stderr: "no server running" }));
    const { listSessions } = await import("../../tui/tmux-session.js");

    await expect(listSessions()).resolves.toEqual([]);
  });

  it("times out a tmux command and kills the child", async () => {
    vi.useFakeTimers();
    const { records } = installSpawnMock(() => {
      // Intentionally never emits close/error; the helper must time out.
    });
    const { sendKey } = await import("../../tui/tmux-session.js");

    const assertion = expect(sendKey("ftth-timeout", "Enter")).rejects.toThrow(
      "tmux send-keys -t ftth-timeout Enter failed (code=n/a): [timeout]",
    );
    await vi.advanceTimersByTimeAsync(5000);

    await assertion;
    expect(records[0]?.child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
