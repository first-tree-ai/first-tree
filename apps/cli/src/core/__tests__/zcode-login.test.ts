import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureOfficialZcodeRuntimeMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("@first-tree/client", () => ({ ensureOfficialZcodeRuntime: ensureOfficialZcodeRuntimeMock }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const originalExit = process.exit;
const originalExitCode = process.exitCode;

beforeEach(() => {
  ensureOfficialZcodeRuntimeMock.mockReset();
  spawnMock.mockReset();
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exit = originalExit;
  process.exitCode = originalExitCode;
});

/** A bare EventEmitter provides `.on`/`.emit`, enough for the `close`/`error` events runZcodeLogin listens for. */
function fakeChild(): EventEmitter {
  return new EventEmitter();
}

/** Resolves once `spawn` has been called and the implementation has had a chance to attach its listeners. */
async function waitForSpawn(): Promise<void> {
  await vi.waitFor(() => {
    if (spawnMock.mock.calls.length === 0) throw new Error("spawn not called yet");
  });
}

describe("runZcodeLogin", () => {
  it("resolves the managed runtime and execs it with the resolved Node executable, args, and login", async () => {
    ensureOfficialZcodeRuntimeMock.mockResolvedValue({
      ok: true,
      command: "/portable/root/node/bin/node",
      args: ["/home/user/.cache/first-tree/zcode/official/3.10.2-6414/zcode.cjs"],
      runtimePath: "/home/user/.cache/first-tree/zcode/official/3.10.2-6414/zcode.cjs",
    });
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const { runZcodeLogin } = await import("../zcode-login.js");
    const runPromise = runZcodeLogin(["--no-browser"]);
    await waitForSpawn();
    child.emit("close", 0, null);
    await runPromise;

    expect(spawnMock).toHaveBeenCalledWith(
      "/portable/root/node/bin/node",
      ["/home/user/.cache/first-tree/zcode/official/3.10.2-6414/zcode.cjs", "login", "--no-browser"],
      { stdio: "inherit" },
    );
    expect(process.exitCode).toBe(0);
  });

  it("propagates a nonzero exit code from the login process", async () => {
    ensureOfficialZcodeRuntimeMock.mockResolvedValue({
      ok: true,
      command: "/node",
      args: ["/managed/zcode.cjs"],
      runtimePath: "/managed/zcode.cjs",
    });
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const { runZcodeLogin } = await import("../zcode-login.js");
    const runPromise = runZcodeLogin();
    await waitForSpawn();
    child.emit("close", 3, null);
    await runPromise;

    expect(process.exitCode).toBe(3);
  });

  it("treats a signal-terminated login process as a failure when no exit code is reported", async () => {
    ensureOfficialZcodeRuntimeMock.mockResolvedValue({
      ok: true,
      command: "/node",
      args: ["/managed/zcode.cjs"],
      runtimePath: "/managed/zcode.cjs",
    });
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const { runZcodeLogin } = await import("../zcode-login.js");
    const runPromise = runZcodeLogin();
    await waitForSpawn();
    child.emit("close", null, "SIGTERM");
    await runPromise;

    expect(process.exitCode).toBe(1);
  });

  it("fails closed without spawning when the managed runtime cannot be resolved", async () => {
    ensureOfficialZcodeRuntimeMock.mockResolvedValue({
      ok: false,
      transient: false,
      error: "First Tree's managed ZCode runtime is pinned to linux-x64; this host is darwin-arm64",
    });
    process.exit = vi.fn(((code?: number) => {
      throw Object.assign(new Error("process.exit"), { code });
    }) as never);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { runZcodeLogin } = await import("../zcode-login.js");
    await expect(runZcodeLogin()).rejects.toThrow("process.exit");

    expect(spawnMock).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain("darwin-arm64");
  });

  it("fails closed when the child process cannot be spawned", async () => {
    ensureOfficialZcodeRuntimeMock.mockResolvedValue({
      ok: true,
      command: "/node",
      args: ["/managed/zcode.cjs"],
      runtimePath: "/managed/zcode.cjs",
    });
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    process.exit = vi.fn(((code?: number) => {
      throw Object.assign(new Error("process.exit"), { code });
    }) as never);

    const { runZcodeLogin } = await import("../zcode-login.js");
    void runZcodeLogin().catch(() => {});
    await waitForSpawn();

    // `fail()` calls the (mocked) `process.exit`, which throws synchronously
    // out of the "error" listener and therefore out of `emit` itself here —
    // it never reaches `runZcodeLogin`'s own promise chain.
    expect(() => child.emit("error", new Error("ENOENT"))).toThrow("process.exit");
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
