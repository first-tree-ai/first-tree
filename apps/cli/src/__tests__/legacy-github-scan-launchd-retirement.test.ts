import {
  chmodSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type LegacyGithubScanLaunchdRetirementOptions,
  runLegacyGithubScanLaunchdRetirement,
} from "../core/legacy-github-scan-launchd-retirement.js";

const UID = 501;
const PREFIX = "com.first-tree.github-scan.runner.";
const MARKER_NAME = ".legacy-launchd-retirement-v1.json";

type LaunchctlResult = ReturnType<LegacyGithubScanLaunchdRetirementOptions["spawnLaunchctl"]>;

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function label(login: string): string {
  return `${PREFIX}${login}.default`;
}

function plist(labelValue: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${labelValue}</string>
  <key>KeepAlive</key><true/>
</dict></plist>
`;
}

function paths(home: string) {
  const runner = join(home, ".first-tree", "github-scan", "runner");
  const launchd = join(runner, "launchd");
  return { runner, launchd, marker: join(runner, MARKER_NAME) };
}

function createLaunchd(home: string): string {
  const launchd = paths(home).launchd;
  mkdirSync(launchd, { recursive: true });
  return launchd;
}

function writeCandidate(home: string, login: string, embedded = label(login)): string {
  const launchd = createLaunchd(home);
  const path = join(launchd, `${label(login)}.plist`);
  writeFileSync(path, plist(embedded));
  return path;
}

function absentPrint(target: string): LaunchctlResult {
  const parsed = /^gui\/(\d+)\/(.+)$/.exec(target);
  if (!parsed) throw new Error(`bad target: ${target}`);
  return {
    status: 113,
    signal: null,
    stderr: `Bad request.\nCould not find service "${parsed[2]}" in domain for user gui: ${parsed[1]}`,
  };
}

function defaultSpawn(args: readonly string[]): LaunchctlResult {
  if (args[0] === "bootout") return { status: 0, signal: null, stderr: "" };
  if (args[0] === "print" && args[1]) return absentPrint(args[1]);
  throw new Error(`unexpected launchctl args: ${args.join(" ")}`);
}

function parseTestPlistLabel(value: string): string | null {
  if (value.includes("<![CDATA[")) return null;
  const labels = [...value.matchAll(/<key>\s*Label\s*<\/key>\s*<string>([^<]*)<\/string>/g)].map((match) => match[1]);
  return labels.length === 1 ? labels[0] : null;
}

function run(home: string, overrides: Partial<LegacyGithubScanLaunchdRetirementOptions> = {}) {
  return runLegacyGithubScanLaunchdRetirement({
    platform: "darwin",
    channel: "staging",
    effectiveHome: home,
    effectiveUid: UID,
    spawnLaunchctl: defaultSpawn,
    parsePlistLabel: parseTestPlistLabel,
    randomToken: () => "0123456789abcdef",
    ...overrides,
  });
}

function writeMarker(home: string, value: unknown, mode = 0o600): string {
  const { runner, marker } = paths(home);
  mkdirSync(runner, { recursive: true });
  writeFileSync(marker, `${JSON.stringify(value)}\n`, { mode });
  chmodSync(marker, mode);
  return marker;
}

function markerValue(retryAt: number, resumeAfter?: string) {
  return {
    version: 1,
    retryAt,
    ...(resumeAfter ? { resumeAfter } : {}),
    diagnostics: [{ stage: "bootout", reason: "exit-nonzero", label: label("alice"), status: 1 }],
  };
}

describe("legacy github-scan launchd retirement", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "first-tree-legacy-launchd-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it.each([
    { platform: "linux" as const, channel: "prod" as const },
    { platform: "darwin" as const, channel: "dev" as const },
  ])("is not applicable for $platform/$channel without touching launchctl", ({ platform, channel }) => {
    let calls = 0;
    let fileSystemCalls = 0;
    const res = run(home, {
      platform,
      channel,
      spawnLaunchctl: () => {
        calls += 1;
        return { status: 0, signal: null };
      },
      fileSystem: {
        lstat(path) {
          fileSystemCalls += 1;
          return lstatSync(path);
        },
      },
    });
    expect(res).toEqual({ status: "not-applicable", retired: 0, diagnostics: [] });
    expect(calls).toBe(0);
    expect(fileSystemCalls).toBe(0);
  });

  it("rejects an untrusted effective-home value", () => {
    const res = run("relative/home");
    expect(res.status).toBe("partial");
    expect(res.diagnostics).toEqual([{ stage: "eligibility", reason: "invalid-home" }]);
  });

  it("is idempotently absent when the fixed namespace or launchd directory is missing", () => {
    expect(run(home).status).toBe("absent");
    mkdirSync(paths(home).runner, { recursive: true });
    expect(run(home).status).toBe("absent");
    createLaunchd(home);
    expect(run(home).status).toBe("absent");
  });

  it("retires a loaded exact label, verifies eviction, then unlinks", () => {
    const candidate = writeCandidate(home, "alice");
    const events: string[] = [];
    const calls: Array<{ args: readonly string[]; timeout: number }> = [];
    const res = run(home, {
      spawnLaunchctl: (args, timeout) => {
        calls.push({ args: [...args], timeout });
        events.push(args[0]);
        return defaultSpawn(args);
      },
      fileSystem: {
        unlink(path) {
          events.push(`unlink:${path}`);
          unlinkSync(path);
        },
      },
    });

    expect(res).toEqual({ status: "complete", retired: 1, diagnostics: [] });
    expect(calls).toEqual([
      { args: ["bootout", `gui/${UID}/${label("alice")}`], timeout: 15_000 },
      { args: ["print", `gui/${UID}/${label("alice")}`], timeout: 2_000 },
    ]);
    expect(events).toEqual(["bootout", "print", `unlink:${candidate}`]);
    expect(existsSync(candidate)).toBe(false);
    expect(run(home).status).toBe("absent");
  });

  it.runIf(process.platform === "darwin")("uses the native plist parser for the historical document shape", () => {
    const candidate = writeCandidate(home, "native-parser");
    const res = runLegacyGithubScanLaunchdRetirement({
      platform: "darwin",
      channel: "staging",
      effectiveHome: home,
      effectiveUid: UID,
      spawnLaunchctl: defaultSpawn,
      randomToken: () => "0123456789abcdef",
    });

    expect(res).toEqual({ status: "complete", retired: 1, diagnostics: [] });
    expect(existsSync(candidate)).toBe(false);
  });

  it.runIf(process.platform === "darwin")("does not normalize semantic whitespace from native plist Labels", () => {
    const paddedLabel = label("native-padded");
    const carriageReturnLabel = label("native-cr");
    const paddedCandidate = writeCandidate(home, "native-padded", `  ${paddedLabel}  `);
    const carriageReturnCandidate = writeCandidate(home, "native-cr", `${carriageReturnLabel}&#13;`);
    let launchctlCalls = 0;

    const res = runLegacyGithubScanLaunchdRetirement({
      platform: "darwin",
      channel: "staging",
      effectiveHome: home,
      effectiveUid: UID,
      spawnLaunchctl: () => {
        launchctlCalls += 1;
        return { status: 0, signal: null };
      },
      randomToken: () => "0123456789abcdef",
    });

    expect(res.status).toBe("partial");
    expect(res.retired).toBe(0);
    expect(res.diagnostics).toEqual(
      expect.arrayContaining([
        { stage: "candidate-read", reason: "invalid-plist-label", label: paddedLabel },
        { stage: "candidate-read", reason: "invalid-plist-label", label: carriageReturnLabel },
      ]),
    );
    expect(launchctlCalls).toBe(0);
    expect(existsSync(paddedCandidate)).toBe(true);
    expect(existsSync(carriageReturnCandidate)).toBe(true);
  });

  it("also runs for the published prod channel", () => {
    const candidate = writeCandidate(home, "prod-user");
    const res = run(home, { channel: "prod" });
    expect(res).toEqual({ status: "complete", retired: 1, diagnostics: [] });
    expect(existsSync(candidate)).toBe(false);
  });

  it("cleans a plist-only service only after exact ESRCH and print absence", () => {
    const candidate = writeCandidate(home, "plist-only");
    const res = run(home, {
      spawnLaunchctl(args) {
        if (args[0] === "bootout") {
          return { status: 3, signal: null, stderr: "Boot-out failed: 3: No such process" };
        }
        return absentPrint(args[1]);
      },
    });
    expect(res.status).toBe("complete");
    expect(existsSync(candidate)).toBe(false);
  });

  it.each([
    "first-tree.plist",
    "first-tree-staging.plist",
    "first-tree-dev.plist",
    `${PREFIX}alice.custom.plist`,
    `${PREFIX}alice.default.plist.bak`,
    `x${PREFIX}alice.default.plist`,
  ])("never targets current-channel or near-miss entry %s", (filename) => {
    const launchd = createLaunchd(home);
    const path = join(launchd, filename);
    writeFileSync(path, plist("first-tree"));
    let calls = 0;
    const res = run(home, {
      spawnLaunchctl: () => {
        calls += 1;
        return { status: 0, signal: null };
      },
    });
    expect(res.status).toBe("absent");
    expect(calls).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  it.each([
    { name: "missing", contents: "<plist><dict></dict></plist>" },
    { name: "mismatch", contents: plist(label("someone-else")) },
    { name: "duplicate", contents: `${plist(label("alice"))}<key>Label</key><string>${label("alice")}</string>` },
    { name: "comment-only", contents: `<!-- <key>Label</key><string>${label("alice")}</string> -->` },
    { name: "plain label snippet", contents: `<key>Label</key><string>${label("alice")}</string>` },
    {
      name: "CDATA label snippet",
      contents: plist(label("alice")).replace(
        `<key>Label</key><string>${label("alice")}</string>`,
        `<![CDATA[<key>Label</key><string>${label("alice")}</string>]]>`,
      ),
    },
    { name: "trailing garbage", contents: `${plist(label("alice"))}garbage` },
  ])("retains an exact filename with $name Label semantics", ({ contents }) => {
    const candidate = writeCandidate(home, "alice");
    writeFileSync(candidate, contents);
    let calls = 0;
    const res = run(home, {
      spawnLaunchctl: () => {
        calls += 1;
        return { status: 0, signal: null };
      },
    });
    expect(res.status).toBe("partial");
    expect(res.retired).toBe(0);
    expect(res.diagnostics).toContainEqual({
      stage: "candidate-read",
      reason: "invalid-plist-label",
      label: label("alice"),
    });
    expect(calls).toBe(0);
    expect(existsSync(candidate)).toBe(true);
    expect(res.retryAt).toBeTypeOf("number");
    expect(statSync(paths(home).marker).mode & 0o7777).toBe(0o600);
  });

  it("reports a semantic plist parser failure without invoking launchctl", () => {
    const candidate = writeCandidate(home, "alice");
    let calls = 0;
    const res = run(home, {
      parsePlistLabel() {
        throw codedError("ETIMEDOUT");
      },
      spawnLaunchctl() {
        calls += 1;
        return { status: 0, signal: null };
      },
    });
    expect(res.status).toBe("partial");
    expect(res.diagnostics).toContainEqual({
      stage: "candidate-read",
      reason: "candidate-unreadable",
      label: label("alice"),
      code: "ETIMEDOUT",
    });
    expect(calls).toBe(0);
    expect(existsSync(candidate)).toBe(true);
  });

  it.each([
    ".first-tree",
    "github-scan",
    "runner",
    "launchd",
  ])("fails closed when fixed component %s is a symlink", (component) => {
    const target = mkdtempSync(join(tmpdir(), "first-tree-symlink-target-"));
    try {
      const firstTree = join(home, ".first-tree");
      const githubScan = join(firstTree, "github-scan");
      const runner = join(githubScan, "runner");
      const launchd = join(runner, "launchd");
      const selected = { ".first-tree": firstTree, "github-scan": githubScan, runner, launchd }[component];
      if (!selected) throw new Error(`unexpected component: ${component}`);
      mkdirSync(join(selected, ".."), { recursive: true });
      symlinkSync(target, selected);
      let calls = 0;
      const res = run(home, {
        spawnLaunchctl: () => {
          calls += 1;
          return { status: 0, signal: null };
        },
      });
      expect(res.status).toBe("partial");
      expect(res.diagnostics[0]?.reason).toBe("unsafe-ancestor");
      expect(calls).toBe(0);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("treats an exact entry symlink and non-regular entry as unresolved without launchctl", () => {
    const launchd = createLaunchd(home);
    const outside = join(home, "outside.plist");
    writeFileSync(outside, plist(label("link")));
    symlinkSync(outside, join(launchd, `${label("link")}.plist`));
    mkdirSync(join(launchd, `${label("directory")}.plist`));
    let calls = 0;
    const res = run(home, {
      spawnLaunchctl: () => {
        calls += 1;
        return { status: 0, signal: null };
      },
    });
    expect(res.status).toBe("partial");
    expect(res.diagnostics.filter((item) => item.reason === "unsafe-candidate")).toHaveLength(2);
    expect(calls).toBe(0);
  });

  it("retains an oversize candidate and reports the bounded reason", () => {
    const candidate = writeCandidate(home, "large");
    writeFileSync(candidate, Buffer.alloc(64 * 1024 + 1, 0x61));
    const res = run(home);
    expect(res.status).toBe("partial");
    expect(res.diagnostics).toContainEqual({
      stage: "candidate-read",
      reason: "candidate-oversize",
      label: label("large"),
    });
    expect(existsSync(candidate)).toBe(true);
  });

  it("fails closed when O_NOFOLLOW is unavailable", () => {
    writeCandidate(home, "alice");
    const res = run(home, { noFollowFlag: 0 });
    expect(res.status).toBe("partial");
    expect(res.diagnostics[0]?.reason).toBe("no-follow-unavailable");
  });

  it.each([
    {
      name: "spawn ENOENT",
      value: { error: codedError("ENOENT"), status: null, signal: null },
      reason: "spawn-error",
      code: "ENOENT",
    },
    {
      name: "spawn ETIMEDOUT",
      value: { error: codedError("ETIMEDOUT"), status: null, signal: "SIGTERM" },
      reason: "spawn-error",
      code: "ETIMEDOUT",
    },
    {
      name: "signal",
      value: { status: null, signal: "SIGTERM" },
      reason: "spawn-signal",
      signal: "SIGTERM",
    },
    {
      name: "blank nonzero",
      value: { status: 1, signal: null, stderr: "" },
      reason: "empty-nonzero",
    },
    {
      name: "permission",
      value: { status: 1, signal: null, stderr: "Operation not permitted" },
      reason: "exit-nonzero",
    },
  ])("retains the plist for bootout $name", ({ value, reason, ...expected }) => {
    const candidate = writeCandidate(home, "alice");
    const res = run(home, { spawnLaunchctl: () => value });
    expect(res.status).toBe("partial");
    expect(res.diagnostics).toContainEqual(
      expect.objectContaining({
        stage: "bootout",
        reason,
        label: label("alice"),
        ...(expected.code ? { code: expected.code } : {}),
        ...(expected.signal ? { signal: expected.signal } : {}),
      }),
    );
    expect(existsSync(candidate)).toBe(true);
  });

  it("does not mistake a broad no-such-service message for exact ESRCH", () => {
    const candidate = writeCandidate(home, "alice");
    const res = run(home, {
      spawnLaunchctl: () => ({ status: 3, signal: null, stderr: "No such service" }),
    });
    expect(res.status).toBe("partial");
    expect(existsSync(candidate)).toBe(true);
  });

  it("requires the known bootout ESRCH status as well as its exact message", () => {
    const candidate = writeCandidate(home, "alice");
    const res = run(home, {
      spawnLaunchctl: () => ({ status: 7, signal: null, stderr: "Boot-out failed: 3: No such process" }),
    });
    expect(res.status).toBe("partial");
    expect(res.diagnostics[0]).toEqual(
      expect.objectContaining({ stage: "bootout", reason: "exit-nonzero", status: 7 }),
    );
    expect(existsSync(candidate)).toBe(true);
  });

  it("requires print absence to bind the exact label and gui domain", () => {
    const candidate = writeCandidate(home, "alice");
    const res = run(home, {
      spawnLaunchctl(args) {
        if (args[0] === "bootout") return { status: 0, signal: null };
        return {
          status: 113,
          signal: null,
          stderr: `Could not find service "${label("bob")}" in domain for user gui: ${UID}`,
        };
      },
    });
    expect(res.status).toBe("partial");
    expect(res.diagnostics[0]).toEqual(expect.objectContaining({ stage: "verify", reason: "exit-nonzero" }));
    expect(existsSync(candidate)).toBe(true);
  });

  it.each([
    {
      name: "spawn error",
      value: { error: codedError("ETIMEDOUT"), status: null, signal: null },
      reason: "spawn-error",
    },
    { name: "signal", value: { status: null, signal: "SIGTERM" }, reason: "spawn-signal" },
    { name: "blank nonzero", value: { status: 1, signal: null, stderr: "" }, reason: "empty-nonzero" },
  ])("retains the plist for verification $name", ({ value, reason }) => {
    const candidate = writeCandidate(home, "alice");
    const res = run(home, {
      spawnLaunchctl(args) {
        return args[0] === "bootout" ? { status: 0, signal: null } : value;
      },
    });
    expect(res.status).toBe("partial");
    expect(res.diagnostics).toContainEqual(expect.objectContaining({ stage: "verify", reason, label: label("alice") }));
    expect(existsSync(candidate)).toBe(true);
  });

  it("times out while the exact label remains registered", () => {
    const candidate = writeCandidate(home, "alice");
    let now = 1_000;
    let prints = 0;
    const res = run(home, {
      now: () => now,
      sleep: (ms) => {
        now += ms;
      },
      spawnLaunchctl(args) {
        if (args[0] === "bootout") return { status: 0, signal: null };
        prints += 1;
        return { status: 0, signal: null, stdout: "state = running" };
      },
    });
    expect(res.status).toBe("partial");
    expect(res.diagnostics).toContainEqual({
      stage: "verify",
      reason: "verification-timeout",
      label: label("alice"),
    });
    expect(prints).toBeGreaterThan(1);
    expect(existsSync(candidate)).toBe(true);
  });

  it("rounds fractional monotonic deadlines before passing timeouts to spawnSync", () => {
    writeCandidate(home, "fractional");
    let monotonic = 0.25;
    const printTimeouts: number[] = [];
    const res = run(home, {
      monotonicNow: () => monotonic,
      sleep: (ms) => {
        monotonic += ms + 0.5;
      },
      spawnLaunchctl(args, timeout) {
        if (args[0] === "bootout") return { status: 0, signal: null };
        printTimeouts.push(timeout);
        return { status: 0, signal: null, stdout: "state = running" };
      },
    });

    expect(res.status).toBe("partial");
    expect(printTimeouts.length).toBeGreaterThan(1);
    expect(printTimeouts.every((timeout) => Number.isInteger(timeout) && timeout >= 1)).toBe(true);
    expect(printTimeouts.some((timeout) => timeout < 2_000)).toBe(true);
  });

  it("gives a later candidate its own budget after an earlier verification timeout", () => {
    const first = writeCandidate(home, "a");
    const second = writeCandidate(home, "b");
    let now = 1_000;
    const bootouts: string[] = [];
    const res = run(home, {
      now: () => now,
      sleep: (ms) => {
        now += ms;
      },
      spawnLaunchctl(args) {
        const target = args[1];
        if (!target) throw new Error("missing launchctl target");
        if (args[0] === "bootout") {
          bootouts.push(target);
          return { status: 0, signal: null };
        }
        if (target.endsWith(`/${label("a")}`)) {
          return { status: 0, signal: null, stdout: "state = running" };
        }
        return absentPrint(target);
      },
    });

    expect(res.status).toBe("partial");
    expect(res.retired).toBe(1);
    expect(bootouts).toEqual([`gui/${UID}/${label("a")}`, `gui/${UID}/${label("b")}`]);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(false);
  });

  it("reports an unlink failure after verified eviction and retains the plist", () => {
    const candidate = writeCandidate(home, "alice");
    const res = run(home, {
      fileSystem: {
        unlink(path) {
          if (path === candidate) throw codedError("EACCES");
          unlinkSync(path);
        },
      },
    });
    expect(res.status).toBe("partial");
    expect(res.retired).toBe(0);
    expect(res.diagnostics).toContainEqual({
      stage: "unlink",
      reason: "unlink-failed",
      label: label("alice"),
      code: "EACCES",
    });
    expect(existsSync(candidate)).toBe(true);
  });

  it("fails closed on a real candidate read error", () => {
    const candidate = writeCandidate(home, "unreadable");
    let calls = 0;
    const res = run(home, {
      fileSystem: {
        open(path, flags, mode) {
          if (path === candidate) throw codedError("EACCES");
          return openSync(path, flags, mode);
        },
      },
      spawnLaunchctl: () => {
        calls += 1;
        return { status: 0, signal: null };
      },
    });
    expect(res.status).toBe("partial");
    expect(res.diagnostics).toContainEqual({
      stage: "candidate-read",
      reason: "candidate-unreadable",
      label: label("unreadable"),
      code: "EACCES",
    });
    expect(calls).toBe(0);
    expect(existsSync(candidate)).toBe(true);
  });

  it("reports a candidate removed between inventory and inspection as unresolved", () => {
    const candidate = writeCandidate(home, "removed-before-open");
    let calls = 0;
    const res = run(home, {
      fileSystem: {
        lstat(path) {
          if (path === candidate) {
            unlinkSync(candidate);
            throw codedError("ENOENT");
          }
          return lstatSync(path);
        },
      },
      spawnLaunchctl() {
        calls += 1;
        return { status: 0, signal: null };
      },
    });

    expect(res.status).toBe("partial");
    expect(res.retired).toBe(0);
    expect(res.retryAt).toBeUndefined();
    expect(res.diagnostics).toContainEqual({
      stage: "candidate-read",
      reason: "candidate-changed",
      label: label("removed-before-open"),
      code: "ENOENT",
    });
    expect(calls).toBe(0);
    expect(existsSync(paths(home).marker)).toBe(false);
  });

  it("treats concurrent unlink ENOENT after verified eviction as success", () => {
    const candidate = writeCandidate(home, "alice");
    const res = run(home, {
      fileSystem: {
        unlink(path) {
          if (path === candidate) {
            unlinkSync(path);
            throw codedError("ENOENT");
          }
          unlinkSync(path);
        },
      },
    });
    expect(res).toEqual({ status: "complete", retired: 1, diagnostics: [] });
  });

  it("does not treat launchd-ancestor disappearance before unlink as candidate success", () => {
    const candidate = writeCandidate(home, "alice");
    const movedLaunchd = `${paths(home).launchd}.moved`;
    const res = run(home, {
      spawnLaunchctl(args) {
        if (args[0] === "bootout") return { status: 0, signal: null };
        renameSync(paths(home).launchd, movedLaunchd);
        return absentPrint(args[1]);
      },
    });

    expect(res.status).toBe("partial");
    expect(res.retired).toBe(0);
    expect(res.diagnostics).toContainEqual({
      stage: "unlink",
      reason: "ancestor-changed",
      label: label("alice"),
      code: "ENOENT",
    });
    expect(existsSync(join(movedLaunchd, `${label("alice")}.plist`))).toBe(true);
    expect(existsSync(candidate)).toBe(false);
  });

  it("rechecks ancestors when unlink itself reports ENOENT", () => {
    const candidate = writeCandidate(home, "alice");
    const movedLaunchd = `${paths(home).launchd}.moved`;
    const res = run(home, {
      fileSystem: {
        unlink(path) {
          if (path === candidate) {
            renameSync(paths(home).launchd, movedLaunchd);
            throw codedError("ENOENT");
          }
          unlinkSync(path);
        },
      },
    });

    expect(res.status).toBe("partial");
    expect(res.retired).toBe(0);
    expect(res.diagnostics).toContainEqual({
      stage: "unlink",
      reason: "ancestor-changed",
      label: label("alice"),
      code: "ENOENT",
    });
    expect(existsSync(join(movedLaunchd, `${label("alice")}.plist`))).toBe(true);
  });

  it("persists a bounded 0600 marker and defers only a complete pending inventory", () => {
    const candidate = writeCandidate(home, "alice", label("wrong"));
    const now = 10_000;
    const first = run(home, { now: () => now });
    expect(first.status).toBe("partial");
    expect(first.retryAt).toBe(now + 5 * 60 * 1000);
    expect(statSync(paths(home).marker).mode & 0o7777).toBe(0o600);
    const stored = JSON.parse(readFileSync(paths(home).marker, "utf8"));
    expect(stored).toEqual(
      expect.objectContaining({ version: 1, retryAt: first.retryAt, resumeAfter: label("alice") }),
    );

    let calls = 0;
    const deferred = run(home, {
      now: () => now + 1,
      spawnLaunchctl: () => {
        calls += 1;
        return { status: 0, signal: null };
      },
    });
    expect(deferred.status).toBe("deferred");
    expect(deferred.retryAt).toBe(first.retryAt);
    expect(calls).toBe(0);
    expect(existsSync(candidate)).toBe(true);
  });

  it("removes a stale marker when no exact candidate remains", () => {
    const marker = writeMarker(home, markerValue(100_000));

    const res = run(home, { now: () => 50_000 });

    expect(res).toEqual({ status: "absent", retired: 0, diagnostics: [] });
    expect(existsSync(marker)).toBe(false);
  });

  it("treats concurrent marker unlink ENOENT as benign only after revalidation", () => {
    const marker = writeMarker(home, markerValue(0));
    const res = run(home, {
      fileSystem: {
        unlink(path) {
          if (path === marker) {
            unlinkSync(path);
            throw codedError("ENOENT");
          }
          unlinkSync(path);
        },
      },
    });

    expect(res).toEqual({ status: "absent", retired: 0, diagnostics: [] });
    expect(existsSync(marker)).toBe(false);
  });

  it("fails closed on a real marker read error", () => {
    writeCandidate(home, "alice");
    const marker = writeMarker(home, markerValue(100_000));
    let calls = 0;
    const res = run(home, {
      now: () => 50_000,
      fileSystem: {
        open(path, flags, mode) {
          if (path === marker) throw codedError("EACCES");
          return openSync(path, flags, mode);
        },
      },
      spawnLaunchctl() {
        calls += 1;
        return { status: 0, signal: null };
      },
    });

    expect(res.status).toBe("partial");
    expect(res.diagnostics).toContainEqual({
      stage: "marker-read",
      reason: "marker-unreadable",
      code: "EACCES",
    });
    expect(calls).toBe(0);
  });

  it("fails closed when the opened marker identity differs from its path", () => {
    writeCandidate(home, "alice");
    writeMarker(home, markerValue(100_000));
    const decoy = join(home, "marker-decoy");
    writeFileSync(decoy, "decoy", { mode: 0o600 });
    let fstats = 0;
    const res = run(home, {
      now: () => 50_000,
      fileSystem: {
        fstat(fd) {
          fstats += 1;
          return fstats === 1 ? statSync(decoy) : fstatSync(fd);
        },
      },
    });

    expect(res.status).toBe("partial");
    expect(res.diagnostics[0]).toEqual({ stage: "marker-read", reason: "marker-race" });
  });

  it("rejects a marker retry timestamp beyond the bounded future window", () => {
    const candidate = writeCandidate(home, "alice");
    const now = 50_000;
    const marker = writeMarker(home, markerValue(now + 10 * 60 * 1000 + 1));

    const res = run(home, { now: () => now });

    expect(res.status).toBe("complete");
    expect(existsSync(candidate)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    { name: "corrupt", body: "{not-json", mode: 0o600 },
    { name: "wrong mode", body: JSON.stringify(markerValue(0)), mode: 0o644 },
    { name: "oversize", body: "x".repeat(16 * 1024 + 1), mode: 0o600 },
  ])("removes a recoverable $name marker and continues", ({ body, mode }) => {
    const candidate = writeCandidate(home, "alice");
    const marker = paths(home).marker;
    writeFileSync(marker, body, { mode });
    chmodSync(marker, mode);
    const res = run(home);
    expect(res.status).toBe("complete");
    expect(res.retired).toBe(1);
    expect(existsSync(candidate)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects marker diagnostics with extra or unsanitized fields instead of replaying them", () => {
    const candidate = writeCandidate(home, "alice");
    writeMarker(home, {
      ...markerValue(100_000),
      diagnostics: [
        {
          stage: "bootout",
          reason: "exit-nonzero",
          label: label("alice"),
          detail: "unsafe\ntext",
          arbitrary: "/private/unbounded",
        },
      ],
    });

    const res = run(home, { now: () => 50_000 });

    expect(res.status).toBe("complete");
    expect(existsSync(candidate)).toBe(false);
    expect(existsSync(paths(home).marker)).toBe(false);
    expect(JSON.stringify(res)).not.toContain("unbounded");
  });

  it.each([
    { name: "unknown top-level field", extra: { arbitrary: true } },
    { name: "oversized cursor", extra: { resumeAfter: label("x".repeat(300)) } },
  ])("rejects a marker with $name", ({ extra }) => {
    const candidate = writeCandidate(home, "alice");
    writeMarker(home, { ...markerValue(100_000), ...extra });

    const res = run(home, { now: () => 50_000 });

    expect(res.status).toBe("complete");
    expect(existsSync(candidate)).toBe(false);
    expect(existsSync(paths(home).marker)).toBe(false);
  });

  it("fails closed on a marker symlink", () => {
    writeCandidate(home, "alice");
    const outside = join(home, "outside-marker");
    writeFileSync(outside, "{}");
    symlinkSync(outside, paths(home).marker);
    let calls = 0;
    const res = run(home, {
      spawnLaunchctl: () => {
        calls += 1;
        return { status: 0, signal: null };
      },
    });
    expect(res.status).toBe("partial");
    expect(res.diagnostics[0]?.reason).toBe("unsafe-marker");
    expect(calls).toBe(0);
    expect(lstatSync(paths(home).marker).isSymbolicLink()).toBe(true);
  });

  it("reports stale-marker removal failure instead of claiming absence", () => {
    createLaunchd(home);
    const marker = writeMarker(home, markerValue(0));
    const res = run(home, {
      fileSystem: {
        unlink(path) {
          if (path === marker) throw codedError("EACCES");
          unlinkSync(path);
        },
      },
    });
    expect(res.status).toBe("partial");
    expect(res.retryAt).toBeUndefined();
    expect(res.diagnostics[0]).toEqual({
      stage: "marker-remove",
      reason: "marker-remove-failed",
      code: "EACCES",
    });
  });

  it("does not expose retryAt when marker persistence fails", () => {
    writeCandidate(home, "alice", label("wrong"));
    const res = run(home, {
      fileSystem: {
        rename() {
          throw codedError("EACCES");
        },
      },
    });
    expect(res.status).toBe("partial");
    expect(res.retryAt).toBeUndefined();
    expect(res.diagnostics).toContainEqual(
      expect.objectContaining({
        stage: "marker-write",
        reason: "marker-write-failed",
        code: "EACCES",
      }),
    );
    expect(existsSync(paths(home).marker)).toBe(false);
  });

  it("removes its exact temporary marker when durability fails", () => {
    writeCandidate(home, "alice", label("wrong"));
    const res = run(home, {
      fileSystem: {
        fsync(fd) {
          fsyncSync(fd);
          throw codedError("EIO");
        },
      },
    });
    expect(res.status).toBe("partial");
    expect(res.retryAt).toBeUndefined();
    expect(existsSync(paths(home).marker)).toBe(false);
    expect(readdirSync(paths(home).runner).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not persist a cooldown after the last candidate disappears during inspection", () => {
    const candidate = writeCandidate(home, "alice");
    const first = run(home, {
      parsePlistLabel() {
        unlinkSync(candidate);
        return null;
      },
    });
    expect(first.status).toBe("partial");
    expect(first.retryAt).toBeUndefined();
    expect(first.diagnostics).toContainEqual({
      stage: "candidate-read",
      reason: "invalid-plist-label",
      label: label("alice"),
    });
    expect(existsSync(paths(home).marker)).toBe(false);
    expect(run(home).status).toBe("absent");
  });

  it("advances past four permanent failures so a fifth valid service is retired", () => {
    for (const name of ["a", "b", "c", "d", "e"]) writeCandidate(home, name);
    let now = 1_000;
    const attempted: string[] = [];
    const spawn = (args: readonly string[]): LaunchctlResult => {
      if (args[0] === "bootout") {
        const targetLabel = args[1].split("/").at(-1);
        if (!targetLabel) throw new Error("missing launchctl label");
        attempted.push(targetLabel);
        if (targetLabel !== label("e")) return { status: 1, signal: null, stderr: "Operation not permitted" };
        return { status: 0, signal: null };
      }
      return absentPrint(args[1]);
    };

    const first = run(home, { now: () => now, spawnLaunchctl: spawn });
    expect(first.status).toBe("partial");
    expect(first.retired).toBe(0);
    expect(attempted).toEqual([label("a"), label("b"), label("c"), label("d")]);
    expect(first.diagnostics).toContainEqual({ stage: "inventory", reason: "candidate-cap" });

    now = (first.retryAt ?? 0) + 1;
    attempted.length = 0;
    const second = run(home, { now: () => now, spawnLaunchctl: spawn });
    expect(second.status).toBe("partial");
    expect(second.retired).toBe(1);
    expect(attempted[0]).toBe(label("e"));
    expect(existsSync(join(paths(home).launchd, `${label("e")}.plist`))).toBe(false);

    now = (second.retryAt ?? 0) + 1;
    attempted.length = 0;
    run(home, { now: () => now, spawnLaunchctl: spawn });
    expect(attempted[0]).toBe(label("d"));
    expect(attempted).toContain(label("a"));
  });

  it("advances past malformed exact entries and reaches a later valid candidate", () => {
    for (const name of ["a", "b", "c", "d"]) writeCandidate(home, name, label("wrong"));
    const fifth = writeCandidate(home, "e");
    let now = 50_000;
    const first = run(home, { now: () => now });
    expect(first.status).toBe("partial");
    expect(first.retired).toBe(0);
    now = (first.retryAt ?? 0) + 1;
    const second = run(home, { now: () => now });
    expect(second.retired).toBe(1);
    expect(existsSync(fifth)).toBe(false);
  });

  it("treats exactly four successfully retired candidates as complete, not cap exhaustion", () => {
    for (const name of ["a", "b", "c", "d"]) writeCandidate(home, name);
    const res = run(home);
    expect(res).toEqual({ status: "complete", retired: 4, diagnostics: [] });
    expect(existsSync(paths(home).marker)).toBe(false);
  });

  it("makes entry-budget overflow mutation-free and never defers from a fresh marker", () => {
    const candidate = writeCandidate(home, "z");
    const now = 100_000;
    const marker = writeMarker(home, markerValue(now + 60_000, label("a")));
    const markerBefore = readFileSync(marker);
    for (let index = 0; index < 256; index += 1) {
      writeFileSync(join(paths(home).launchd, `unrelated-${String(index).padStart(3, "0")}`), "x");
    }
    let calls = 0;
    const res = run(home, {
      now: () => now,
      spawnLaunchctl: () => {
        calls += 1;
        return { status: 0, signal: null };
      },
    });
    expect(res).toEqual({
      status: "partial",
      retired: 0,
      diagnostics: [{ stage: "inventory", reason: "inventory-overflow" }],
    });
    expect(calls).toBe(0);
    expect(existsSync(candidate)).toBe(true);
    expect(readFileSync(marker)).toEqual(markerBefore);
  });

  it("sanitizes and caps launchctl text in diagnostics and marker data", () => {
    writeCandidate(home, "alice");
    const raw = `denied\n\u0000\u0085\u009b${"x".repeat(500)}`;
    const res = run(home, {
      spawnLaunchctl: () => ({ status: 1, signal: null, stderr: raw }),
    });
    const diagnostic = res.diagnostics.find((item) => item.stage === "bootout");
    expect(diagnostic?.detail?.length).toBeLessThanOrEqual(160);
    expect(
      [...(diagnostic?.detail ?? "")].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 0x1f && !(codePoint >= 0x7f && codePoint <= 0x9f);
      }),
    ).toBe(true);
    expect(readFileSync(paths(home).marker, "utf8")).not.toContain("\u0000");
  });

  it("revalidates the candidate identity before bootout", () => {
    const candidate = writeCandidate(home, "alice");
    let candidateStats = 0;
    let calls = 0;
    const res = run(home, {
      fileSystem: {
        lstat(path) {
          if (path === candidate) {
            candidateStats += 1;
            if (candidateStats === 2) writeFileSync(candidate, `${plist(label("alice"))}\n`);
          }
          return lstatSync(path);
        },
      },
      spawnLaunchctl: () => {
        calls += 1;
        return { status: 0, signal: null };
      },
    });
    expect(res.status).toBe("partial");
    expect(res.diagnostics).toContainEqual(expect.objectContaining({ reason: "candidate-changed" }));
    expect(calls).toBe(0);
    expect(existsSync(candidate)).toBe(true);
  });

  it("retains a replacement candidate swapped after verified eviction", () => {
    const candidate = writeCandidate(home, "alice");
    const original = `${candidate}.original`;
    let candidateStats = 0;
    const res = run(home, {
      fileSystem: {
        lstat(path) {
          if (path === candidate) {
            candidateStats += 1;
            if (candidateStats === 3) {
              renameSync(candidate, original);
              writeFileSync(candidate, plist(label("alice")));
            }
          }
          return lstatSync(path);
        },
      },
    });

    expect(res.status).toBe("partial");
    expect(res.retired).toBe(0);
    expect(res.diagnostics).toContainEqual({
      stage: "unlink",
      reason: "candidate-changed",
      label: label("alice"),
    });
    expect(existsSync(candidate)).toBe(true);
    expect(existsSync(original)).toBe(true);
  });

  it("uses O_NOFOLLOW for candidate and marker file opens", () => {
    writeCandidate(home, "alice", label("wrong"));
    const flags: number[] = [];
    const res = run(home, {
      fileSystem: {
        open(path, openFlags, mode) {
          flags.push(openFlags);
          return openSync(path, openFlags, mode);
        },
      },
    });
    expect(res.status).toBe("partial");
    expect(flags.length).toBeGreaterThanOrEqual(2);
    expect(flags.every((value) => (value & constants.O_NOFOLLOW) === constants.O_NOFOLLOW)).toBe(true);
  });
});
