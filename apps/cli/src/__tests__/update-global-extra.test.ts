import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const registrySpawnMock = vi.hoisted(() => vi.fn());
const cliFetchMock = vi.hoisted(() => vi.fn());
const resolveServerUrlMock = vi.hoisted(() => vi.fn());
const classifyMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn((_path?: unknown) => false));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: spawnSyncMock };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: existsSyncMock };
});

vi.mock("@first-tree/client", () => ({
  ERROR_KINDS: { TRANSIENT: "transient", PERMANENT: "permanent" },
  classify: classifyMock,
  getChildProcessRegistry: () => ({ spawn: registrySpawnMock }),
}));

vi.mock("../core/bootstrap.js", () => {
  class ServerUrlNotConfiguredError extends Error {
    constructor() {
      super("Server URL not configured.");
      this.name = "ServerUrlNotConfiguredError";
    }
  }
  return {
    resolveServerUrl: resolveServerUrlMock,
    ServerUrlNotConfiguredError,
  };
});

vi.mock("../core/cli-fetch.js", () => ({
  cliFetch: cliFetchMock,
}));

vi.mock("../core/channel.js", () => ({
  channelConfig: {
    channel: "prod",
    binName: "first-tree",
    aliasName: "ft",
    packageName: "first-tree",
    defaultHome: "/tmp/home",
    defaultServerUrl: "https://cloud.first-tree.ai",
    serviceUnitFile: "first-tree.service",
    launchdLabel: "first-tree",
    launchdPlistFile: "first-tree.plist",
    displayName: "First Tree",
    portable: {
      channelPrefix: "prod",
      publicInstallerPath: "prod/install.sh",
      downloadBaseUrl: "https://download.first-tree.ai/releases/",
    },
  },
}));

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn(async () => body),
    text: vi.fn(async () => (typeof body === "string" ? body : JSON.stringify(body))),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  spawnSyncMock.mockImplementation((_command: string, args: string[]) =>
    args.includes("prefix")
      ? { status: 0, stdout: "/usr/local\n", stderr: "" }
      : { status: 0, stdout: "null", stderr: "" },
  );
  existsSyncMock.mockReturnValue(false);
  classifyMock.mockReturnValue({ kind: "permanent", reasonCode: "classified" });
  resolveServerUrlMock.mockReturnValue("https://hub.example///");
});

describe("global update helpers", () => {
  it("refuses npm-global writes inside a validated portable version tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-npm-portable-prefix-"));
    try {
      const versionDir = join(root, "versions", "1.2.3");
      const nodePrefix = join(versionDir, "node");
      mkdirSync(nodePrefix, { recursive: true });
      writeFileSync(
        join(versionDir, "INSTALL.json"),
        JSON.stringify({
          schemaVersion: 1,
          channel: "prod",
          version: "1.2.3",
          gitSha: "abc123",
          nodeVersion: "v24.0.0",
          packageName: "first-tree",
          binName: "first-tree",
          aliasName: "ft",
          generatedAt: new Date().toISOString(),
          platform: process.platform === "darwin" ? "darwin-x64" : "linux-x64",
          installMode: "portable",
          appEntry: "app/cli/index.mjs",
        }),
      );
      spawnSyncMock.mockImplementation((_command: string, args: string[]) =>
        args.includes("prefix")
          ? { status: 0, stdout: `${nodePrefix}\n`, stderr: "" }
          : { status: 0, stdout: "null", stderr: "" },
      );
      const output = vi.fn();
      const { installGlobalSpec } = await import("../core/update.js");

      await expect(installGlobalSpec("latest", { output })).resolves.toMatchObject({
        ok: false,
        mode: "global",
        retryable: false,
        reasonCode: "npm_prefix_inside_portable_install",
        reason: expect.stringContaining("immutable portable version 1.2.3"),
      });
      expect(registrySpawnMock).not.toHaveBeenCalled();
      expect(output).toHaveBeenCalledWith(expect.stringContaining("absolute channel shim"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the npm global prefix cannot be verified", async () => {
    spawnSyncMock.mockImplementation((_command: string, args: string[]) =>
      args.includes("prefix")
        ? { status: 1, stdout: "", stderr: "prefix denied" }
        : { status: 0, stdout: "null", stderr: "" },
    );
    const { installGlobalSpec } = await import("../core/update.js");

    await expect(installGlobalSpec("latest")).resolves.toMatchObject({
      ok: false,
      retryable: false,
      reasonCode: "npm_prefix_probe_failed",
      reason: expect.stringContaining("prefix denied"),
    });
    expect(registrySpawnMock).not.toHaveBeenCalled();
  });

  it("rejects npm targets whose engine metadata excludes the current Node", async () => {
    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({ "engines.node": ">=999.0.0" }),
      stderr: "",
    });
    const { installGlobalSpec } = await import("../core/update.js");

    const result = await installGlobalSpec("1.2.3");

    expect(result).toMatchObject({
      ok: false,
      mode: "global",
      retryable: false,
      reasonCode: "npm_ebadengine",
    });
    if (!result.ok) {
      expect(result.reason).toContain("requires Node >=999.0.0");
      expect(result.reason).toContain("prod/install.sh");
    }

    spawnSyncMock.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({ engines: { node: ">=999.0.0" } }),
      stderr: "",
    });
    const nested = await installGlobalSpec("1.2.4");

    expect(nested).toMatchObject({
      ok: false,
      mode: "global",
      retryable: false,
      reasonCode: "npm_ebadengine",
    });
  });

  it("runs npm install through the child registry and parses installed versions", async () => {
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "null", stderr: "" });
    const child = new FakeChild();
    registrySpawnMock.mockReturnValueOnce({ child });
    const output = vi.fn();
    const { installGlobalSpec } = await import("../core/update.js");

    const installing = installGlobalSpec("latest", { output });
    child.stdout.emit("data", Buffer.from("+ first-tree@1.2.3\n"));
    child.stderr.emit("data", Buffer.from("progress\n"));
    child.emit("exit", 0, null);

    await expect(installing).resolves.toEqual({ ok: true, mode: "global", installedVersion: "1.2.3" });
    expect(output).toHaveBeenCalledWith("progress\n");
    expect(registrySpawnMock).toHaveBeenCalledWith(
      expect.stringMatching(/npm/),
      ["install", "-g", "first-tree@latest"],
      expect.objectContaining({ category: "npm-install", timeoutMs: 300_000 }),
    );
  });

  it("runs managed Linux installs in a transient unit with rollback boundaries", async () => {
    if (process.platform !== "linux") return;
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "null", stderr: "" });
    const child = new FakeChild();
    registrySpawnMock.mockReturnValueOnce({ child });
    const { installGlobalSpec } = await import("../core/update.js");

    const installing = installGlobalSpec("latest", { managed: true });
    const [command, args] = registrySpawnMock.mock.calls[0] as [string, string[]];
    expect(command).toBe("systemd-run");
    expect(args).toEqual(expect.arrayContaining(["--wait", "--collect", "--pipe", "--unit"]));
    expect(args).toContain("first-tree-update.service");
    const script = args[args.indexOf("-c") + 1];
    expect(script).toContain("systemctl");
    expect(script).toContain("stop 'first-tree.service'");
    expect(script).toContain("start 'first-tree.service'");
    expect(script).toContain("first-tree-update-backup");
    expect(() => execFileSync("/bin/sh", ["-n", "-c", script], { encoding: "utf8" })).not.toThrow();

    child.stdout.emit("data", Buffer.from("+ first-tree@1.2.3\n"));
    child.emit("exit", 0, null);
    await expect(installing).resolves.toEqual({ ok: true, mode: "global", installedVersion: "1.2.3" });
  });

  it("rolls back the moved npm tree before restarting after a failed managed install", async () => {
    if (process.platform !== "linux") return;
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "null", stderr: "" });
    const child = new FakeChild();
    registrySpawnMock.mockReturnValueOnce({ child });
    const { installGlobalSpec } = await import("../core/update.js");
    const installing = installGlobalSpec("latest", { managed: true });
    const [, args] = registrySpawnMock.mock.calls[0] as [string, string[]];
    const script = args[args.indexOf("-c") + 1];

    const root = mkdtempSync(join(tmpdir(), "ft-managed-update-rollback-"));
    try {
      const prefix = join(root, "prefix");
      const packageRoot = join(prefix, "lib", "node_modules");
      const packageDir = join(packageRoot, "first-tree");
      const binDir = join(prefix, "bin");
      const fakeBin = join(root, "fake-bin");
      const logPath = join(root, "systemctl.log");
      const fakeNpm = join(fakeBin, "npm");
      mkdirSync(packageDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(join(packageDir, "sentinel"), "old-package");
      writeFileSync(join(binDir, "first-tree"), "old-bin");
      writeFileSync(join(binDir, "ft"), "old-alias");
      writeFileSync(join(fakeBin, "systemctl"), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$SYSTEMCTL_LOG"\nexit 0\n', {
        mode: 0o755,
      });
      writeFileSync(
        fakeNpm,
        [
          "#!/bin/sh",
          `root=${JSON.stringify(packageRoot)}`,
          `prefix=${JSON.stringify(prefix)}`,
          'if [ "$1" = "root" ]; then printf \'%s\\n\' "$root"; exit 0; fi',
          'if [ "$1" = "prefix" ]; then printf \'%s\\n\' "$prefix"; exit 0; fi',
          'mkdir -p "$root/first-tree"',
          "printf 'partial\\n' > \"$root/first-tree/partial\"",
          "exit 42",
        ].join("\n"),
        { mode: 0o755 },
      );

      const env = {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        SYSTEMCTL_LOG: logPath,
      };
      expect(() =>
        execFileSync(
          "/bin/sh",
          ["-c", script, "first-tree-npm-update", fakeNpm, "install", "-g", "first-tree@latest"],
          { env },
        ),
      ).toThrow();
      expect(readFileSync(join(packageDir, "sentinel"), "utf8")).toBe("old-package");
      expect(() => readFileSync(join(packageDir, "partial"))).toThrow();
      expect(readFileSync(join(binDir, "first-tree"), "utf8")).toBe("old-bin");
      expect(readFileSync(join(binDir, "ft"), "utf8")).toBe("old-alias");
      expect(readFileSync(logPath, "utf8")).toMatch(/stop first-tree\.service/);
      expect(readFileSync(logPath, "utf8")).toMatch(/start first-tree\.service/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    child.emit("exit", 0, null);
    await expect(installing).resolves.toEqual({ ok: true, mode: "global", installedVersion: null });
  });

  it("refuses a managed install when systemd-run cannot be started", async () => {
    if (process.platform !== "linux") return;
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "null", stderr: "" });
    const spawnError = Object.assign(new Error("systemd-run not found"), { code: "ENOENT" });
    registrySpawnMock.mockImplementationOnce(() => {
      throw spawnError;
    });
    const { installGlobalSpec } = await import("../core/update.js");

    await expect(installGlobalSpec("latest", { managed: true })).resolves.toMatchObject({
      ok: false,
      retryable: false,
      reasonCode: "systemd_update_runner_unavailable",
      reason: expect.stringContaining("systemd-run is unavailable"),
    });
  });

  it("prefers sibling npm, tolerates empty engine stdout, and keeps non-semver installed labels", async () => {
    existsSyncMock.mockImplementation(
      (path: unknown) => String(path).endsWith("/npm") || String(path).endsWith("\\npm.cmd"),
    );
    spawnSyncMock.mockReturnValueOnce({ status: 0, stderr: "" });
    const child = new FakeChild();
    registrySpawnMock.mockReturnValueOnce({ child });
    const { installGlobalSpec } = await import("../core/update.js");

    const installing = installGlobalSpec("latest");
    child.stdout.emit("data", Buffer.from("+ first-tree@latest)\n"));
    child.emit("exit", 0, null);

    await expect(installing).resolves.toEqual({ ok: true, mode: "global", installedVersion: "latest" });
    expect(registrySpawnMock.mock.calls[0]?.[0]).toMatch(/npm(?:\.cmd)?$/);

    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: JSON.stringify({ engines: {} }), stderr: "" });
    const secondChild = new FakeChild();
    registrySpawnMock.mockReturnValueOnce({ child: secondChild });
    const second = installGlobalSpec("latest");
    secondChild.stdout.emit("data", Buffer.from("+ first-tree@1.2.5\n"));
    secondChild.emit("exit", 0, null);
    await expect(second).resolves.toEqual({ ok: true, mode: "global", installedVersion: "1.2.5" });
  });

  it("classifies npm child errors and timeout exits", async () => {
    spawnSyncMock.mockImplementation((_command: string, args: string[]) =>
      args.includes("prefix")
        ? { status: 0, stdout: "/usr/local\n", stderr: "" }
        : { status: 0, stdout: "null", stderr: "" },
    );
    classifyMock.mockReturnValueOnce({ kind: "transient", reasonCode: "spawn_failed" });
    const errored = new FakeChild();
    registrySpawnMock.mockReturnValueOnce({ child: errored });
    const { installGlobalSpec } = await import("../core/update.js");

    const first = installGlobalSpec("latest");
    errored.emit("error", new Error("spawn failed"));
    await expect(first).resolves.toMatchObject({
      ok: false,
      retryable: true,
      reasonCode: "spawn_failed",
    });

    const timedOut = new FakeChild();
    registrySpawnMock.mockReturnValueOnce({ child: timedOut });
    const second = installGlobalSpec("latest");
    timedOut.stderr.emit("data", Buffer.from("still downloading\n"));
    timedOut.emit("exit", null, "SIGTERM");
    await expect(second).resolves.toMatchObject({
      ok: false,
      retryable: true,
      reasonCode: "npm_timeout",
    });
  });

  it("stringifies non-Error npm child failures", async () => {
    spawnSyncMock.mockImplementation((_command: string, args: string[]) =>
      args.includes("prefix")
        ? { status: 0, stdout: "/usr/local\n", stderr: "" }
        : { status: 0, stdout: "null", stderr: "" },
    );
    classifyMock.mockReturnValueOnce({ kind: "transient", reasonCode: "string_failure" });
    const child = new FakeChild();
    registrySpawnMock.mockReturnValueOnce({ child });
    const { installGlobalSpec } = await import("../core/update.js");

    const installing = installGlobalSpec("latest");
    child.emit("error", "spawn failed as string");

    await expect(installing).resolves.toMatchObject({
      ok: false,
      reason: "spawn failed as string",
      retryable: true,
      reasonCode: "string_failure",
    });
  });

  it("returns shaped latest-version and server-version failures", async () => {
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: "not-semver", stderr: "" });
    const { fetchLatestVersion, fetchServerCommandVersion } = await import("../core/update.js");

    expect(fetchLatestVersion()).toEqual({
      ok: false,
      reason: "npm view returned non-semver value: not-semver",
    });

    spawnSyncMock.mockReturnValueOnce({ status: 7, stdout: "", stderr: "   " });
    expect(fetchLatestVersion()).toEqual({
      ok: false,
      reason: "npm view exited with code 7",
    });

    resolveServerUrlMock.mockImplementationOnce(() => {
      throw new Error("missing server");
    });
    await expect(fetchServerCommandVersion()).resolves.toEqual({ ok: false, reason: "missing server" });

    resolveServerUrlMock.mockImplementationOnce(() => {
      throw "missing server string";
    });
    await expect(fetchServerCommandVersion()).resolves.toEqual({ ok: false, reason: "missing server string" });

    cliFetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(fetchServerCommandVersion()).resolves.toEqual({ ok: false, reason: "network down" });

    cliFetchMock.mockRejectedValueOnce("network string");
    await expect(fetchServerCommandVersion()).resolves.toEqual({ ok: false, reason: "network string" });

    cliFetchMock.mockResolvedValueOnce(jsonResponse("nope", false, 503));
    await expect(fetchServerCommandVersion()).resolves.toEqual({ ok: false, reason: "server returned HTTP 503" });

    cliFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn(async () => {
        throw new Error("bad json");
      }),
    } as unknown as Response);
    await expect(fetchServerCommandVersion()).resolves.toEqual({
      ok: false,
      reason: "server returned invalid JSON: bad json",
    });

    cliFetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn(async () => {
        throw "bad json string";
      }),
    } as unknown as Response);
    await expect(fetchServerCommandVersion()).resolves.toEqual({
      ok: false,
      reason: "server returned invalid JSON: bad json string",
    });

    cliFetchMock.mockResolvedValueOnce(jsonResponse(null));
    await expect(fetchServerCommandVersion()).resolves.toEqual({
      ok: false,
      reason: "server returned invalid bootstrap config",
    });

    cliFetchMock.mockResolvedValueOnce(jsonResponse({}));
    await expect(fetchServerCommandVersion()).resolves.toEqual({
      ok: false,
      reason: "server did not provide serverCommandVersion",
    });

    cliFetchMock.mockResolvedValueOnce(jsonResponse({ serverCommandVersion: "not-semver" }));
    await expect(fetchServerCommandVersion()).resolves.toEqual({
      ok: false,
      reason: "server returned non-semver version: not-semver",
    });

    cliFetchMock.mockResolvedValueOnce(jsonResponse({ serverCommandVersion: "1.2.3" }));
    await expect(fetchServerCommandVersion()).resolves.toEqual({ ok: true, version: "1.2.3" });
  });
});
