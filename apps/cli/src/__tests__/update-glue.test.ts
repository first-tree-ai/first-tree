import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMocks = vi.hoisted(() => ({
  detectInstallMode: vi.fn(),
  fetchServerCommandVersion: vi.fn(),
  installGlobalSpec: vi.fn(),
  installPortableSpec: vi.fn(),
  PACKAGE_NAME: "first-tree",
}));

const updateStateMocks = vi.hoisted(() => ({
  isLoopGuarded: vi.fn(),
  recordUpdateAttempt: vi.fn(),
}));

const spawnSyncMock = vi.hoisted(() => vi.fn());
const resolveCliInvocationMock = vi.hoisted(() =>
  vi.fn(() => ({ kind: "bin" as const, program: "/opt/first-tree/bin/first-tree-dev" })),
);
const printLineMock = vi.hoisted(() => vi.fn());
const exitMock = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
  throw Object.assign(new Error(`process.exit ${code}`), { exitCode: code });
});

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

vi.mock("../core/update.js", () => updateMocks);
vi.mock("../core/update-state.js", () => updateStateMocks);
vi.mock("../core/supervisor/index.js", () => ({ resolveCliInvocation: resolveCliInvocationMock }));
vi.mock("../core/output.js", () => ({
  print: { line: printLineMock },
}));

function output(): string {
  return printLineMock.mock.calls.map((call) => String(call[0])).join("");
}

describe("update glue", () => {
  beforeEach(() => {
    updateMocks.detectInstallMode.mockReset();
    updateMocks.fetchServerCommandVersion.mockReset();
    updateMocks.installGlobalSpec.mockReset();
    updateMocks.installPortableSpec.mockReset();
    updateStateMocks.isLoopGuarded.mockReset();
    updateStateMocks.recordUpdateAttempt.mockReset();
    spawnSyncMock.mockReset();
    resolveCliInvocationMock.mockReset();
    resolveCliInvocationMock.mockReturnValue({ kind: "bin", program: "/opt/first-tree/bin/first-tree-dev" });
    printLineMock.mockClear();
    exitMock.mockClear();

    updateMocks.detectInstallMode.mockReturnValue("global");
    updateMocks.fetchServerCommandVersion.mockResolvedValue({ ok: true, version: "0.6.0" });
    updateMocks.installGlobalSpec.mockResolvedValue({
      ok: true,
      mode: "global",
      installedVersion: "0.6.0",
    });
    updateMocks.installPortableSpec.mockResolvedValue({
      ok: true,
      mode: "portable",
      installedVersion: "0.6.0",
    });
    updateStateMocks.isLoopGuarded.mockReturnValue(false);
    spawnSyncMock.mockReturnValue({ status: 0, signal: null });
  });

  it("declines prompts and skips unsupported install modes", async () => {
    const { createExecuteUpdate, declineUpdate, promptUpdate, refreshServerUpdateTarget } = await import(
      "../core/update-glue.js"
    );

    await expect(declineUpdate({ currentVersion: "0.5.0", targetVersion: "0.6.0", timeoutSeconds: 1 })).resolves.toBe(
      false,
    );
    await expect(promptUpdate({ currentVersion: "0.5.0", targetVersion: "0.6.0", timeoutSeconds: 0 })).resolves.toBe(
      false,
    );
    await expect(refreshServerUpdateTarget()).resolves.toEqual({ ok: true, targetVersion: "0.6.0" });
    updateMocks.fetchServerCommandVersion.mockResolvedValueOnce({ ok: false, reason: "server down" });
    await expect(refreshServerUpdateTarget()).resolves.toEqual({ ok: false, reason: "server down" });

    updateMocks.detectInstallMode.mockReturnValueOnce("source");
    await expect(
      createExecuteUpdate({ managed: false })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).resolves.toEqual({ installed: false });
    expect(output()).toContain("Running from source checkout");

    printLineMock.mockClear();
    updateMocks.detectInstallMode.mockReturnValueOnce("npx");
    await expect(
      createExecuteUpdate({ managed: false })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).resolves.toEqual({ installed: false });
    expect(output()).toContain("Cannot self-update");
    expect(output()).toContain("./scripts/dev-install.sh");
    expect(output()).not.toContain("npm i -g");
  });

  it("refuses loop-guarded targets and records install failures", async () => {
    const { createExecuteUpdate } = await import("../core/update-glue.js");
    updateStateMocks.isLoopGuarded.mockReturnValueOnce(true);

    await expect(
      createExecuteUpdate({ managed: false })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).resolves.toEqual({ installed: true });
    expect(updateMocks.installGlobalSpec).not.toHaveBeenCalled();
    expect(output()).toContain("Refusing to retry 0.6.0");

    const onUpdateFailed = vi.fn();
    updateMocks.installGlobalSpec.mockResolvedValueOnce({
      ok: false,
      mode: "global",
      reason: "network down",
      retryable: true,
      reasonCode: "network",
    });

    await expect(
      createExecuteUpdate({ managed: false, onUpdateFailed })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).resolves.toEqual({ installed: false });
    expect(updateStateMocks.recordUpdateAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ result: "failed", reason: "network down", target: "0.6.0" }),
    );
    expect(onUpdateFailed).toHaveBeenCalledWith({
      targetVersion: "0.6.0",
      retryable: true,
      reasonCode: "network",
    });

    updateMocks.installGlobalSpec.mockResolvedValueOnce({
      ok: false,
      mode: "global",
      reason: "bad mirror",
    });
    await expect(
      createExecuteUpdate({
        managed: false,
        onUpdateFailed: () => {
          throw new Error("listener down");
        },
      })({ currentVersion: "0.5.0", targetVersion: "0.6.1" }),
    ).resolves.toEqual({ installed: false });
  });

  it("uses the portable installer in portable mode and records failures through the same path", async () => {
    const { createExecuteUpdate } = await import("../core/update-glue.js");
    updateMocks.detectInstallMode.mockReturnValue("portable");

    updateStateMocks.isLoopGuarded.mockReturnValueOnce(true);
    await expect(
      createExecuteUpdate({ managed: false })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).resolves.toEqual({ installed: true });
    expect(output()).toContain("stale portable metadata target or a shim/path mismatch");
    expect(output()).toContain("manually run `first-tree-dev upgrade`");
    printLineMock.mockClear();
    updateStateMocks.isLoopGuarded.mockReturnValue(false);

    await expect(
      createExecuteUpdate({ managed: false })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).resolves.toEqual({ installed: true });
    expect(updateMocks.installPortableSpec).toHaveBeenCalledWith("0.6.0");
    expect(updateMocks.installGlobalSpec).not.toHaveBeenCalled();
    expect(output()).toContain("Switching portable");

    printLineMock.mockClear();
    updateMocks.installPortableSpec.mockResolvedValueOnce({
      ok: false,
      mode: "portable",
      reason: "checksum mismatch",
      retryable: false,
      reasonCode: "checksum",
    });
    const onUpdateFailed = vi.fn();
    await expect(
      createExecuteUpdate({ managed: false, onUpdateFailed })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).resolves.toEqual({ installed: false });
    expect(updateStateMocks.recordUpdateAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ result: "failed", reason: "checksum mismatch", target: "0.6.0" }),
    );
    expect(onUpdateFailed).toHaveBeenCalledWith({
      targetVersion: "0.6.0",
      retryable: false,
      reasonCode: "checksum",
    });
  });

  it("blocks stale installs and returns manual restart hints for foreground clients", async () => {
    const { createExecuteUpdate } = await import("../core/update-glue.js");
    updateMocks.installGlobalSpec.mockResolvedValueOnce({
      ok: true,
      mode: "global",
      installedVersion: "0.5.5",
    });

    await expect(
      createExecuteUpdate({ managed: false })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).resolves.toEqual({ installed: true });
    expect(updateStateMocks.recordUpdateAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ result: "blocked", installedVersion: "0.5.5" }),
    );
    expect(output()).toContain("Skipping restart to avoid");

    printLineMock.mockClear();
    updateMocks.installGlobalSpec.mockResolvedValueOnce({
      ok: true,
      mode: "global",
      installedVersion: null,
    });
    await expect(
      createExecuteUpdate({ managed: false })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).resolves.toEqual({ installed: true });
    expect(updateStateMocks.recordUpdateAttempt).toHaveBeenLastCalledWith(
      expect.objectContaining({ result: "ok", installedVersion: null }),
    );
    expect(output()).toContain("Restart the client manually");
  });

  it("refreshes the service unit and exits with the self-restart code for managed clients", async () => {
    const { SELF_RESTART_EXIT_CODE, createExecuteUpdate } = await import("../core/update-glue.js");

    await expect(
      createExecuteUpdate({ managed: true })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).rejects.toMatchObject({ exitCode: SELF_RESTART_EXIT_CODE });
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "/opt/first-tree/bin/first-tree-dev",
      ["daemon", "refresh-unit"],
      expect.objectContaining({ timeout: 45_000 }),
    );
    expect(exitMock).toHaveBeenCalledWith(SELF_RESTART_EXIT_CODE);

    printLineMock.mockClear();
    spawnSyncMock.mockReturnValueOnce({ status: 7, signal: "SIGTERM" });
    await expect(
      createExecuteUpdate({ managed: true })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).rejects.toMatchObject({ exitCode: SELF_RESTART_EXIT_CODE });
    expect(output()).toContain(
      "warning: '/opt/first-tree/bin/first-tree-dev daemon refresh-unit' exited with status 7",
    );

    printLineMock.mockClear();
    spawnSyncMock.mockReturnValueOnce({ status: undefined, signal: undefined });
    await expect(
      createExecuteUpdate({ managed: true })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).rejects.toMatchObject({ exitCode: SELF_RESTART_EXIT_CODE });
    expect(output()).toContain("status unknown (signal=none)");

    printLineMock.mockClear();
    spawnSyncMock.mockImplementationOnce(() => {
      throw new Error("spawn denied");
    });
    await expect(
      createExecuteUpdate({ managed: true })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).rejects.toMatchObject({ exitCode: SELF_RESTART_EXIT_CODE });
    expect(output()).toContain("warning: could not resolve or spawn the installed CLI");
    expect(output()).toContain("spawn denied");

    printLineMock.mockClear();
    spawnSyncMock.mockImplementationOnce(() => {
      throw "spawn string denied";
    });
    await expect(
      createExecuteUpdate({ managed: true })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).rejects.toMatchObject({ exitCode: SELF_RESTART_EXIT_CODE });
    expect(output()).toContain("spawn string denied");
  });

  it("keeps healthy status-zero refresh output silent while preserving exit 75", async () => {
    const { SELF_RESTART_EXIT_CODE, createExecuteUpdate } = await import("../core/update-glue.js");
    const logs: Array<[level: string, message: string]> = [];
    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      signal: null,
      stderr: "service unit already current\n",
      stdout: "refresh complete\n",
    });

    await expect(
      createExecuteUpdate({
        managed: true,
        log: (level, message) => logs.push([level, message]),
      })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).rejects.toMatchObject({ exitCode: SELF_RESTART_EXIT_CODE });

    expect(exitMock).toHaveBeenCalledWith(SELF_RESTART_EXIT_CODE);
    expect(logs.filter(([level]) => level === "warn")).toEqual([]);
    expect(logs.map(([, message]) => message).join("\n")).not.toContain("service unit already current");
    expect(logs.map(([, message]) => message).join("\n")).not.toContain("refresh complete");
  });

  it("routes managed update output through the injected logger and captures refresh-unit output", async () => {
    const { SELF_RESTART_EXIT_CODE, createExecuteUpdate } = await import("../core/update-glue.js");
    const logs: Array<[level: string, message: string]> = [];
    updateMocks.installGlobalSpec.mockImplementationOnce(
      async (_target: string, options?: { output?: (chunk: string) => void }) => {
        options?.output?.("npm stderr line\n");
        return { ok: true, mode: "global" as const, installedVersion: "0.6.0" };
      },
    );
    spawnSyncMock.mockReturnValueOnce({
      status: 7,
      signal: "SIGTERM",
      stderr: "stderr line\n",
      stdout: "stdout line\n",
    });

    await expect(
      createExecuteUpdate({
        managed: true,
        log: (level, message) => logs.push([level, message]),
      })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).rejects.toMatchObject({ exitCode: SELF_RESTART_EXIT_CODE });

    expect(printLineMock).not.toHaveBeenCalled();
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "/opt/first-tree/bin/first-tree-dev",
      ["daemon", "refresh-unit"],
      expect.objectContaining({ encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(logs).toEqual(
      expect.arrayContaining([
        ["info", "npm stderr line"],
        [
          "warn",
          expect.stringContaining(
            "warning: '/opt/first-tree/bin/first-tree-dev daemon refresh-unit' exited with status 7",
          ),
        ],
        ["warn", expect.stringContaining("Output: stderr line | stdout line")],
      ]),
    );
  });
});
