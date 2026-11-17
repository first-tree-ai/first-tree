import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adapterMocks = vi.hoisted(() => ({
  channel: "staging",
  userInfo: vi.fn(),
  spawnSync: vi.fn((_command: string, ..._args: unknown[]): unknown => {
    throw new Error("production spawn must not run in this test");
  }),
}));

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, userInfo: adapterMocks.userInfo };
});

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawnSync: adapterMocks.spawnSync };
});

vi.mock("../core/channel.js", () => ({
  channelConfig: {
    get channel() {
      return adapterMocks.channel;
    },
  },
}));

describe("legacy github-scan launchd production adapter", () => {
  const effectiveHome = mkdtempSync(join(tmpdir(), "first-tree-legacy-adapter-"));
  const originalPlatform = process.platform;
  const effectiveUid = 501;

  function candidateLabel(login: string): string {
    return `com.first-tree.github-scan.runner.${login}.default`;
  }

  function writeCandidate(login: string, embeddedLabel = candidateLabel(login)): string {
    const launchd = join(effectiveHome, ".first-tree", "github-scan", "runner", "launchd");
    mkdirSync(launchd, { recursive: true });
    const candidate = join(launchd, `${candidateLabel(login)}.plist`);
    writeFileSync(
      candidate,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${embeddedLabel}</string>
  <key>KeepAlive</key><true/>
</dict></plist>
`,
    );
    return candidate;
  }

  function useEligibleAccount(): void {
    Object.defineProperty(process, "platform", {
      configurable: true,
      enumerable: true,
      value: "darwin",
    });
    adapterMocks.userInfo.mockReturnValue({
      uid: effectiveUid,
      gid: 20,
      username: "qa",
      homedir: effectiveHome,
      shell: "/bin/zsh",
    });
  }

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    adapterMocks.channel = "staging";
    rmSync(join(effectiveHome, ".first-tree"), { recursive: true, force: true });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      enumerable: true,
      value: originalPlatform,
    });
  });

  afterAll(() => {
    rmSync(effectiveHome, { recursive: true, force: true });
  });

  it.each([
    { platform: "linux", channel: "staging" },
    { platform: "win32", channel: "prod" },
    { platform: "darwin", channel: "dev" },
  ] as const)("memoizes $platform/$channel as not-applicable before user lookup", async ({ platform, channel }) => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      enumerable: true,
      value: platform,
    });
    adapterMocks.channel = channel;
    adapterMocks.userInfo.mockImplementation(() => {
      throw new Error("uv_os_get_passwd returned ENOENT");
    });

    const { runLegacyGithubScanLaunchdRetirementOnce } = await import(
      "../core/legacy-github-scan-launchd-retirement.js"
    );
    const first = runLegacyGithubScanLaunchdRetirementOnce();
    const second = runLegacyGithubScanLaunchdRetirementOnce();

    expect(first.status).toBe("not-applicable");
    expect(first.diagnostics).toEqual([]);
    expect(second).toBe(first);
    expect(adapterMocks.userInfo).not.toHaveBeenCalled();
    expect(adapterMocks.spawnSync).not.toHaveBeenCalled();
  });

  it("uses the effective-account home and memoizes without touching live launchctl", async () => {
    useEligibleAccount();

    const { runLegacyGithubScanLaunchdRetirementOnce } = await import(
      "../core/legacy-github-scan-launchd-retirement.js"
    );
    const first = runLegacyGithubScanLaunchdRetirementOnce();
    const second = runLegacyGithubScanLaunchdRetirementOnce();

    expect(first.status).toBe("absent");
    expect(second).toBe(first);
    expect(adapterMocks.userInfo).toHaveBeenCalledTimes(1);
    expect(adapterMocks.spawnSync).not.toHaveBeenCalled();
  });

  it("uses fixed system executables for an exact production candidate", async () => {
    useEligibleAccount();
    const exactLabel = candidateLabel("adapter");
    const candidate = writeCandidate("adapter");
    adapterMocks.spawnSync.mockImplementation((command: string, argsValue?: unknown) => {
      const args = argsValue as readonly string[] | undefined;
      if (command === "/usr/bin/plutil") {
        return { status: 0, signal: null, stdout: `${exactLabel}\n`, stderr: "" };
      }
      if (command !== "/bin/launchctl" || !args) throw new Error(`unexpected executable: ${command}`);
      if (args[0] === "bootout") return { status: 0, signal: null, stdout: "", stderr: "" };
      if (args[0] === "print") {
        return {
          status: 113,
          signal: null,
          stdout: "",
          stderr: `Bad request.\nCould not find service "${exactLabel}" in domain for user gui: ${effectiveUid}`,
        };
      }
      throw new Error(`unexpected launchctl args: ${args.join(" ")}`);
    });

    const { runLegacyGithubScanLaunchdRetirementOnce } = await import(
      "../core/legacy-github-scan-launchd-retirement.js"
    );
    const result = runLegacyGithubScanLaunchdRetirementOnce();

    expect(result).toEqual({ status: "complete", retired: 1, diagnostics: [] });
    expect(existsSync(candidate)).toBe(false);
    expect(adapterMocks.spawnSync.mock.calls.map(([command]) => command)).toEqual([
      "/usr/bin/plutil",
      "/bin/launchctl",
      "/bin/launchctl",
    ]);
    expect(adapterMocks.spawnSync).toHaveBeenNthCalledWith(
      2,
      "/bin/launchctl",
      ["bootout", `gui/${effectiveUid}/${exactLabel}`],
      expect.any(Object),
    );
    expect(adapterMocks.spawnSync).toHaveBeenNthCalledWith(
      3,
      "/bin/launchctl",
      ["print", `gui/${effectiveUid}/${exactLabel}`],
      expect.any(Object),
    );
  });

  it.each([
    {
      name: "surrounding spaces",
      embeddedSuffix: "  ",
      embeddedPrefix: "  ",
      rawPrefix: "  ",
      rawSuffix: "  \n",
    },
    {
      name: "trailing carriage return",
      embeddedSuffix: "&#13;",
      embeddedPrefix: "",
      rawPrefix: "",
      rawSuffix: "\r\n",
    },
  ])("preserves $name in a production-parsed Label and performs no launchctl mutation", async ({
    embeddedPrefix,
    embeddedSuffix,
    rawPrefix,
    rawSuffix,
  }) => {
    useEligibleAccount();
    const exactLabel = candidateLabel("padded");
    const candidate = writeCandidate("padded", `${embeddedPrefix}${exactLabel}${embeddedSuffix}`);
    adapterMocks.spawnSync.mockImplementation((command: string) => {
      if (command === "/usr/bin/plutil") {
        return { status: 0, signal: null, stdout: `${rawPrefix}${exactLabel}${rawSuffix}`, stderr: "" };
      }
      throw new Error(`launchctl must not run for a mismatched Label: ${command}`);
    });

    const { runLegacyGithubScanLaunchdRetirementOnce } = await import(
      "../core/legacy-github-scan-launchd-retirement.js"
    );
    const result = runLegacyGithubScanLaunchdRetirementOnce();

    expect(result.status).toBe("partial");
    expect(result.retired).toBe(0);
    expect(result.diagnostics).toContainEqual({
      stage: "candidate-read",
      reason: "invalid-plist-label",
      label: exactLabel,
    });
    expect(existsSync(candidate)).toBe(true);
    expect(adapterMocks.spawnSync.mock.calls.map(([command]) => command)).toEqual(["/usr/bin/plutil"]);
  });
});
