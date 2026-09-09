import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CapabilityEntry,
  enabledOkRuntimeProviders,
  isRuntimeProviderEnabled,
  RUNTIME_PROVIDER_IDS,
  type RuntimeProvider,
  recordByRuntimeProvider,
} from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_ERROR_LENGTH, truncateError } from "../providers/capabilities/detect.js";
import { commandFailureDigest, runCommand, verifyLaunchable } from "../providers/capabilities/launch-probe.js";
import {
  type BundledClaudeBinary,
  formatClaudeBinaryMissingMessage,
  probeClaudeCodeCapability,
  resolveBundledClaudeBinary,
} from "../providers/claude/capability.js";
import { probeClaudeCodeTuiCapability } from "../providers/claude/capability-tui.js";
import type { ClaudeExecutableResolution } from "../providers/claude/executable.js";
import {
  type CodexExecutableVerification,
  createCodexAutomaticResolutionFailureTracker,
  createCodexVerifiedAutomaticCandidateTracker,
} from "../providers/codex/binary.js";
import {
  probeCodexCapability,
  resolveBundledBinaryInPackageRoot,
  resolveBundledCodexBinary,
  resolveCodexRuntimeBinary,
} from "../providers/codex/capability.js";

const originalPlatform = process.platform;
const originalArch = process.arch;

function setProcessTarget(platform: NodeJS.Platform, arch: NodeJS.Architecture): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  Object.defineProperty(process, "arch", { configurable: true, value: arch });
}

afterEach(() => {
  setProcessTarget(originalPlatform, originalArch);
});

/**
 * Install-only capability probes — the contract under test:
 *
 *   - `ok` means the binary the runtime would spawn EXISTS on disk; no launch,
 *     no auth check, no smoke.
 *   - `missing` means no spawnable artifact was found (the error lists what was
 *     checked).
 *   - `error` means detection itself threw (reported verbatim, truncated to
 *     MAX_ERROR_LENGTH).
 *   - every entry carries `detectedAt` + `latencyMs`. Removed: `authenticated`,
 *     `authMethod`, `degraded`, `probeKind`, and the `unauthenticated` state.
 *
 * Provider-probe tests inject the existence/resolve seams
 * (`exists` / `resolveBundled` / `findOnPath` / `hasTmux`) so nothing here
 * spawns a real provider or touches the real PATH. The few real-spawn tests use
 * `node` itself (always present in the test environment) to cover the low-level
 * runCommand/verifyLaunchable helpers the codex runtime resolver still relies
 * on.
 */

describe("truncateError / commandFailureDigest", () => {
  it("truncateError trims whitespace and keeps short text intact", () => {
    expect(truncateError("  hello \n")).toBe("hello");
  });

  it("truncateError caps long text at MAX_ERROR_LENGTH with an ellipsis", () => {
    const out = truncateError("x".repeat(2000));
    expect(out).toHaveLength(MAX_ERROR_LENGTH + 1); // 500 chars + ellipsis
    expect(out.endsWith("…")).toBe(true);
  });

  it("digest prefers spawnError, then timeout, then stderr|stdout, then exit code", () => {
    const base = { ok: false, exitCode: 1, stdout: "", stderr: "", timedOut: false, durationMs: 5 };
    expect(commandFailureDigest("x", { ...base, spawnError: "ENOENT" })).toBe("x: ENOENT");
    expect(commandFailureDigest("x", { ...base, timedOut: true })).toBe("x: timed out after 5ms");
    expect(commandFailureDigest("x", { ...base, stderr: "err", stdout: "out" })).toBe("x: err | out");
    // claude prints auth errors on STDOUT — the digest must read both streams.
    expect(commandFailureDigest("x", { ...base, stdout: "Invalid API key · Please run /login" })).toBe(
      "x: Invalid API key · Please run /login",
    );
    expect(commandFailureDigest("x", base)).toBe("x: exited with code 1");
  });
});

describe("runCommand / verifyLaunchable (real node spawns)", () => {
  it("captures stdout and exit code from a real process", async () => {
    const res = await runCommand(process.execPath, ["-e", "console.log('hi')"], { timeoutMs: 15_000 });
    expect(res.ok).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("hi");
  });

  it("reports a spawn error for a nonexistent binary instead of throwing", async () => {
    const res = await runCommand("/definitely/not/a/binary", [], { timeoutMs: 5000 });
    expect(res.ok).toBe(false);
    expect(res.spawnError).toMatch(/ENOENT/);
  });

  it("kills and flags a process that exceeds the timeout", async () => {
    const res = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 200 });
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
  });

  it("verifyLaunchable extracts a version from a real `--version` run", async () => {
    const res = await verifyLaunchable("node", process.execPath);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.version).toMatch(/^\d+\.\d+(\.\d+)?$/);
  });

  it("verifyLaunchable fails with a labelled digest when the binary cannot run", async () => {
    const res = await verifyLaunchable("claude", "/definitely/not/claude");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("claude --version");
  });
});

describe("probeClaudeCodeCapability (install-only)", () => {
  const onPath = (): ClaudeExecutableResolution => ({ path: "/usr/local/bin/claude", source: "path" });
  const bundledOnly = (): ClaudeExecutableResolution => ({ path: undefined, source: "default" });
  const nativeBundle = (): BundledClaudeBinary => ({ kind: "native", path: "/sdk/native/claude" });

  it("`ok` (runtimeSource path) when a real on-disk `claude` resolves and exists", async () => {
    const resolveBundled = vi.fn(nativeBundle);
    const entry = await probeClaudeCodeCapability({
      resolveExecutable: onPath,
      resolveBundled,
      exists: (p) => p === "/usr/local/bin/claude",
    });
    expect(entry).toMatchObject({
      state: "ok",
      available: true,
      runtimeSource: "path",
      runtimePath: "/usr/local/bin/claude",
    });
    expect(typeof entry.latencyMs).toBe("number");
    expect(typeof entry.detectedAt).toBe("string");
    expect(entry).not.toHaveProperty("authenticated");
    expect(entry).not.toHaveProperty("authMethod");
    // No on-disk binary resolved means we never consult the bundle.
    expect(resolveBundled).not.toHaveBeenCalled();
  });

  it("`ok` (runtimeSource bundled) when no on-disk binary but the bundled binary exists", async () => {
    const entry = await probeClaudeCodeCapability({
      resolveExecutable: bundledOnly,
      resolveBundled: nativeBundle,
      exists: (p) => p === "/sdk/native/claude",
    });
    expect(entry).toMatchObject({
      state: "ok",
      available: true,
      runtimeSource: "bundled",
      runtimePath: null,
    });
  });

  it("a resolved binary whose path does NOT exist falls back to the bundle", async () => {
    const entry = await probeClaudeCodeCapability({
      resolveExecutable: onPath, // resolves a path…
      resolveBundled: nativeBundle,
      exists: (p) => p === "/sdk/native/claude", // …but the resolved path is absent
    });
    expect(entry).toMatchObject({ state: "ok", runtimeSource: "bundled" });
  });

  it("`missing` when neither a resolved binary nor the bundled binary exists on disk", async () => {
    const entry = await probeClaudeCodeCapability({
      resolveExecutable: bundledOnly,
      resolveBundled: nativeBundle,
      exists: () => false,
    });
    expect(entry.state).toBe("missing");
    expect(entry.available).toBe(false);
    expect(entry.error).toContain("/sdk/native/claude");
    expect(entry.error).toContain("does not exist");
  });

  it("`missing` when there is no on-disk binary and the bundle cannot be resolved", async () => {
    const entry = await probeClaudeCodeCapability({
      resolveExecutable: bundledOnly,
      resolveBundled: () => {
        throw new Error("@anthropic-ai/claude-agent-sdk not found in any parent node_modules");
      },
      exists: () => false,
    });
    expect(entry.state).toBe("missing");
    expect(entry.available).toBe(false);
    // The externalized-engine missing message points at the one-click install
    // (`formatClaudeBinaryMissingMessage`) and wraps the original resolver error.
    expect(entry.error).toContain("Claude runtime binary is missing");
    expect(entry.error).toContain("daemon install-claude");
    expect(entry.error).toContain("not found in any parent node_modules");
  });

  it("prefixes a bad CLAUDE_CODE_EXECUTABLE override when no fallback binary resolves", async () => {
    const entry = await probeClaudeCodeCapability({
      resolveExecutable: () => ({
        path: undefined,
        source: "default",
        overrideError: "CLAUDE_CODE_EXECUTABLE points at a non-executable file",
      }),
      resolveBundled: () => {
        throw new Error("SDK bundle missing");
      },
      exists: () => false,
    });
    expect(entry.state).toBe("missing");
    expect(entry.error).toContain("CLAUDE_CODE_EXECUTABLE points at a non-executable file");
    expect(entry.error).toContain("SDK bundle missing");
  });

  it("a thrown resolveExecutable becomes state=error (never throws)", async () => {
    const entry = await probeClaudeCodeCapability({
      resolveExecutable: () => {
        throw new Error("resolve blew up");
      },
    });
    expect(entry.state).toBe("error");
    expect(entry.available).toBe(false);
    expect(entry.error).toBe("resolve blew up");
  });
});

describe("formatClaudeBinaryMissingMessage", () => {
  it("names the repo-canonical `claude auth login`, not `claude /login`, and points at the one-click install", () => {
    const msg = formatClaudeBinaryMissingMessage("Native CLI binary for darwin-arm64 not found");
    // Guard against the login-command drift codex-assistant caught: the
    // remediation must match the command the runtime-auth orchestrator runs.
    expect(msg).toContain("claude auth login");
    expect(msg).toContain("npm install -g @anthropic-ai/claude-code");
    expect(msg).not.toContain("claude /login");
    expect(msg).toContain("daemon install-claude");
    expect(msg).toContain("Native CLI binary for darwin-arm64 not found");
  });
});

describe("resolveBundledClaudeBinary (hermetic — covers the SDK layout change)", () => {
  // Pins the native-package branch the SDK 0.2.x+ layout change introduced: a
  // no-`cli.js` SDK dir + a per-platform package whose root holds the `claude`
  // binary.
  const binaryName = process.platform === "win32" ? "claude.exe" : "claude";

  it("resolves the per-platform native binary when the SDK ships no cli.js", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-bundle-"));
    try {
      const sdkDir = join(root, "sdk"); // deliberately no cli.js inside
      const nativeDir = join(root, "native");
      mkdirSync(sdkDir);
      mkdirSync(nativeDir);
      const binaryPath = join(nativeDir, binaryName);
      writeFileSync(binaryPath, "#!/bin/sh\necho fake-claude\n");
      const res = resolveBundledClaudeBinary({
        locateSdkDir: () => sdkDir,
        resolvePlatformPackageRoot: () => nativeDir,
      });
      expect(res).toEqual({ kind: "native", path: realpathSync(binaryPath) });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers the legacy cli.js when present and never consults platform packages", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-bundle-"));
    try {
      const sdkDir = join(root, "sdk");
      mkdirSync(sdkDir);
      const cliJs = join(sdkDir, "cli.js");
      writeFileSync(cliJs, "// fake bundled cli.js");
      const res = resolveBundledClaudeBinary({
        locateSdkDir: () => sdkDir,
        resolvePlatformPackageRoot: () => {
          throw new Error("platform resolver must not be consulted when cli.js exists");
        },
      });
      expect(res).toEqual({ kind: "cli-js", path: realpathSync(cliJs) });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when neither cli.js nor an installed native package is present", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-bundle-"));
    try {
      const sdkDir = join(root, "sdk");
      mkdirSync(sdkDir);
      expect(() =>
        resolveBundledClaudeBinary({ locateSdkDir: () => sdkDir, resolvePlatformPackageRoot: () => null }),
      ).toThrow(/no installed Claude native binary|no bundled Claude binary/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws when a native package resolves but does not contain the expected binary", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-bundle-"));
    try {
      const sdkDir = join(root, "sdk");
      const nativeDir = join(root, "native-without-binary");
      mkdirSync(sdkDir);
      mkdirSync(nativeDir);
      expect(() =>
        resolveBundledClaudeBinary({ locateSdkDir: () => sdkDir, resolvePlatformPackageRoot: () => nativeDir }),
      ).toThrow(/no installed Claude native binary/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("default resolver either reports the host SDK bundle or a descriptive missing-bundle error", () => {
    try {
      const res = resolveBundledClaudeBinary();
      expect(["cli-js", "native"]).toContain(res.kind);
      expect(res.path).toBeTruthy();
    } catch (err) {
      expect(err instanceof Error ? err.message : String(err)).toMatch(
        /Claude native binary|Claude binary|claude-agent-sdk|no bundled Claude binary/,
      );
    }
  });
});

describe("probeClaudeCodeTuiCapability (install-only)", () => {
  const onPath = (): ClaudeExecutableResolution => ({ path: "/usr/local/bin/claude", source: "path" });
  const notOnPath = (): ClaudeExecutableResolution => ({ path: undefined, source: "default" });

  it("`ok` when a real on-disk `claude` exists AND tmux is present", async () => {
    const entry = await probeClaudeCodeTuiCapability({
      resolveExecutable: onPath,
      hasTmux: () => true,
      exists: (p) => p === "/usr/local/bin/claude",
    });
    expect(entry).toMatchObject({
      state: "ok",
      available: true,
      runtimeSource: "path",
      runtimePath: "/usr/local/bin/claude",
    });
  });

  it("`missing` when claude resolves only to the SDK bundle (source=default)", async () => {
    const entry = await probeClaudeCodeTuiCapability({
      resolveExecutable: notOnPath,
      hasTmux: () => true,
      exists: () => true,
    });
    expect(entry.state).toBe("missing");
    expect(entry.available).toBe(false);
    expect(entry.error).toContain("`claude` not found");
  });

  it("`missing` when the resolved claude path does not exist on disk", async () => {
    const entry = await probeClaudeCodeTuiCapability({
      resolveExecutable: onPath,
      hasTmux: () => true,
      exists: () => false,
    });
    expect(entry.state).toBe("missing");
    expect(entry.error).toContain("`claude` not found");
  });

  it("`missing` when tmux is absent", async () => {
    const entry = await probeClaudeCodeTuiCapability({
      resolveExecutable: onPath,
      hasTmux: () => false,
      exists: () => true,
    });
    expect(entry.state).toBe("missing");
    expect(entry.error).toContain("tmux not found");
  });

  it("reports BOTH missing reasons when claude and tmux are absent", async () => {
    const entry = await probeClaudeCodeTuiCapability({
      resolveExecutable: notOnPath,
      hasTmux: () => false,
      exists: () => false,
    });
    expect(entry.state).toBe("missing");
    expect(entry.error).toContain("`claude` not found");
    expect(entry.error).toContain("tmux not found");
  });

  it("surfaces a thrown dependency as state=error", async () => {
    const entry = await probeClaudeCodeTuiCapability({
      resolveExecutable: () => {
        throw new Error("resolve blew up");
      },
    });
    expect(entry.state).toBe("error");
    expect(entry.available).toBe(false);
    expect(entry.error).toBe("resolve blew up");
  });
});

describe("probeCodexCapability (install-only)", () => {
  const bundledOk = async (): Promise<{ ok: true; binary: string }> => ({ ok: true, binary: "/vendor/bin/codex" });
  const bundledMissing = async (): Promise<{ ok: false; error: string }> => ({
    ok: false,
    error: "codex binary not found under /vendor/x86_64-apple-darwin",
  });

  it("`ok` (runtimeSource bundled) when the bundled vendor binary resolves", async () => {
    const findOnPath = vi.fn(() => "/usr/local/bin/codex");
    const entry = await probeCodexCapability({
      resolveBundled: bundledOk,
      findOnPath,
      env: {},
    });
    expect(entry).toMatchObject({
      state: "ok",
      available: true,
      runtimeSource: "bundled",
      runtimePath: null,
    });
    // Bundle resolves → PATH is never consulted.
    expect(findOnPath).not.toHaveBeenCalled();
  });

  it("`ok` (runtimeSource path) when the bundle is missing but a system codex is on PATH", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-codex-install-only-"));
    try {
      const candidate = join(root, "codex");
      const launchMarker = `${candidate}.launched`;
      writeFileSync(candidate, '#!/bin/sh\ntouch "$0.launched"\n');
      chmodSync(candidate, 0o755);

      const entry = await probeCodexCapability({
        resolveBundled: bundledMissing,
        findOnPath: () => candidate,
        env: {},
      });
      expect(entry).toMatchObject({
        state: "ok",
        available: true,
        runtimeSource: "path",
      });
      expect(entry).not.toHaveProperty("runtimePath");
      expect(existsSync(launchMarker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never launch-verifies during probing and later reports the runtime-verified Desktop candidate", async () => {
    const staleGlobal = "/Users/test/.npm-global/bin/codex";
    const desktop = "/Applications/ChatGPT.app/Contents/Resources/codex";
    const candidates = () => [staleGlobal, desktop];
    const verifiedCandidateTracker = createCodexVerifiedAutomaticCandidateTracker();
    const verifyPath = vi.fn(
      (path: string): CodexExecutableVerification =>
        path === staleGlobal
          ? { ok: false, transient: false, reason: "`codex --version` killed by SIGILL" }
          : { ok: true, output: "codex 0.146.0" },
    );

    const beforeRuntime = await probeCodexCapability({
      resolveBundled: bundledMissing,
      findCandidates: candidates,
      verifiedCandidateTracker,
      env: {},
    });
    expect(beforeRuntime).toMatchObject({ state: "ok", available: true, runtimeSource: "path" });
    expect(beforeRuntime).not.toHaveProperty("runtimePath");
    expect(verifyPath).not.toHaveBeenCalled();

    const runtime = await resolveCodexRuntimeBinary(
      {},
      {
        resolveBundled: bundledMissing,
        findCandidates: candidates,
        verifyPath,
        verifiedCandidateTracker,
      },
    );
    const afterRuntime = await probeCodexCapability({
      resolveBundled: bundledMissing,
      findCandidates: candidates,
      verifiedCandidateTracker,
      env: {},
    });

    expect(afterRuntime).toMatchObject({
      state: "ok",
      available: true,
      runtimeSource: "path",
      runtimePath: desktop,
    });
    expect(runtime).toMatchObject({ ok: true, binary: desktop, runtimePath: desktop });
    expect(verifyPath.mock.calls.map(([path]) => path)).toEqual([staleGlobal, desktop]);
  });

  it("`missing` when neither the bundle nor a PATH codex resolves, with the binary-missing message", async () => {
    const entry = await probeCodexCapability({
      resolveBundled: bundledMissing,
      findOnPath: () => null,
      env: {},
    });
    expect(entry.state).toBe("missing");
    expect(entry.available).toBe(false);
    expect(entry.error).toContain("Codex runtime binary is missing");
  });

  it("a thrown resolveBundled becomes state=error", async () => {
    const entry = await probeCodexCapability({
      resolveBundled: async () => {
        throw new Error("vendor resolution blew up");
      },
      findOnPath: () => null,
      env: {},
    });
    expect(entry.state).toBe("error");
    expect(entry.available).toBe(false);
    expect(entry.error).toBe("vendor resolution blew up");
  });
});

describe("resolveBundledCodexBinary / resolveCodexRuntimeBinary (real node_modules)", () => {
  it("replays the SDK's resolution chain to an existing vendor binary", async () => {
    // The repo depends on @openai/codex-sdk with optional platform packages,
    // so on any supported dev/CI machine the chain should land on a real file.
    const res = await resolveBundledCodexBinary();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.binary).toMatch(/[/\\]codex(\.exe)?$/);
  });

  it("resolves a launchable runtime binary and reports its source (bundled-first)", async () => {
    // End-to-end guard for the integrated resolver: on dev/CI the bundled
    // vendor binary exists and launch-verifies, so the source is "bundled".
    const res = await resolveCodexRuntimeBinary();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.runtimeSource).toBe("bundled");
      expect(res.binary).toMatch(/[/\\]codex(\.exe)?$/);
      expect(res.runtimePath).toBeNull();
    }
  });

  it("reports unsupported codex targets before attempting SDK resolution", async () => {
    setProcessTarget("linux", "ia32");

    const res = await resolveBundledCodexBinary();

    expect(res).toEqual({ ok: false, error: "unsupported platform for codex: linux (ia32)" });
  });

  it.each([
    ["darwin", "arm64", "@openai/codex-darwin-arm64"],
    ["win32", "x64", "@openai/codex-win32-x64"],
  ] as const)("maps %s/%s to the matching optional package", async (platform, arch, expectedPackage) => {
    setProcessTarget(platform, arch);
    vi.resetModules();
    vi.doMock("node:module", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:module")>();
      return {
        ...actual,
        createRequire: (anchor: string | URL) => ({
          resolve: (specifier: string) => {
            if (specifier === "@openai/codex/package.json") {
              return "/virtual/node_modules/@openai/codex/package.json";
            }
            throw new Error(`missing ${specifier} from ${String(anchor)}`);
          },
        }),
      };
    });
    const mod = await import("../providers/codex/capability.js");

    const res = await mod.resolveBundledCodexBinary();

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain(expectedPackage);
      expect(res.error).toContain("unable to locate codex CLI binaries");
    }

    vi.doUnmock("node:module");
    vi.resetModules();
  });

  it("reports a missing bundled binary after the optional vendor package resolves", async () => {
    const root = mkdtempSync(join(tmpdir(), "ft-codex-empty-vendor-"));
    try {
      setProcessTarget("linux", "x64");
      vi.resetModules();
      vi.doMock("node:module", async (importOriginal) => {
        const actual = await importOriginal<typeof import("node:module")>();
        return {
          ...actual,
          createRequire: (anchor: string | URL) => ({
            resolve: (specifier: string) => {
              if (specifier === "@openai/codex/package.json") {
                return join(root, "node_modules", "@openai", "codex", "package.json");
              }
              if (specifier === "@openai/codex-linux-x64/package.json") {
                return join(root, "node_modules", "@openai", "codex-linux-x64", "package.json");
              }
              throw new Error(`unexpected ${specifier} from ${String(anchor)}`);
            },
          }),
        };
      });
      const vendorRoot = join(root, "node_modules", "@openai", "codex-linux-x64", "vendor");
      mkdirSync(join(vendorRoot, "x86_64-unknown-linux-musl"), { recursive: true });
      const mod = await import("../providers/codex/capability.js");

      const res = await mod.resolveBundledCodexBinary();

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain("codex binary not found under");
        expect(res.error).toContain("x86_64-unknown-linux-musl");
      }
    } finally {
      vi.doUnmock("node:module");
      vi.resetModules();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The probe's binary resolution must match the codex-sdk's own
 * `resolveNativePackage` so the probe and the runtime never disagree on which
 * binary backs codex.
 */
describe("resolveBundledBinaryInPackageRoot (SDK resolveNativePackage parity)", () => {
  let root: string;
  const codexName = process.platform === "win32" ? "codex.exe" : "codex";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ft-codex-vendor-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const writeExecutable = (path: string): void => {
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  };

  it("modern layout: returns bin/codex only when the codex-package.json marker is also present", () => {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeExecutable(join(root, "bin", codexName));
    writeFileSync(join(root, "codex-package.json"), "{}");
    expect(resolveBundledBinaryInPackageRoot(root)).toBe(join(root, "bin", codexName));
  });

  it("modern binary present but marker MISSING → not bundled (the SDK would not spawn it)", () => {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeExecutable(join(root, "bin", codexName));
    // No codex-package.json marker, no legacy layout.
    expect(resolveBundledBinaryInPackageRoot(root)).toBeNull();
  });

  it("falls back to the legacy codex/<codex> layout when the modern marker is absent", () => {
    mkdirSync(join(root, "bin"), { recursive: true });
    writeExecutable(join(root, "bin", codexName)); // present but no marker
    mkdirSync(join(root, "codex"), { recursive: true });
    writeExecutable(join(root, "codex", codexName));
    expect(resolveBundledBinaryInPackageRoot(root)).toBe(join(root, "codex", codexName));
  });

  it("returns null when neither layout resolves", () => {
    expect(resolveBundledBinaryInPackageRoot(root)).toBeNull();
  });

  it("uses the Windows executable name when resolving bundled layouts", () => {
    setProcessTarget("win32", "x64");
    mkdirSync(join(root, "bin"), { recursive: true });
    writeExecutable(join(root, "bin", "codex.exe"));
    writeFileSync(join(root, "codex-package.json"), "{}");

    expect(resolveBundledBinaryInPackageRoot(root)).toBe(join(root, "bin", "codex.exe"));
  });
});

describe("resolveCodexRuntimeBinary (handler-contract parity)", () => {
  const found = async (): Promise<{ ok: true; binary: string }> => ({ ok: true, binary: "/vendor/bin/codex" });
  const notFound = async (): Promise<{ ok: false; error: string }> => ({ ok: false, error: "codex binary not found" });
  const verifyOk = async (): Promise<{ ok: true; version: string | null }> => ({ ok: true, version: "0.134.0" });

  it("bundled present but NONLAUNCHABLE → resolve failure (not available) — no PATH fallback", async () => {
    // The runtime resolves to this same bundled binary and would fail spawning
    // it. The resolver must report failure HERE, NOT fall back to PATH — the
    // handler never does once the bundle resolves.
    const findOnPath = vi.fn(() => "/usr/local/bin/codex");
    const res = await resolveCodexRuntimeBinary(
      {},
      {
        resolveBundled: found,
        verifyBundled: async () => ({ ok: false, error: "codex --version: spawn EACCES" }),
        findOnPath,
      },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("could not be launched");
      expect(res.error).toContain("spawn EACCES");
    }
    expect(findOnPath).not.toHaveBeenCalled();
  });

  it("bundle NOT found → validated system PATH codex (`path` source)", async () => {
    const verifyPath = (): CodexExecutableVerification => ({ ok: true, output: "codex-cli 0.140.0" });
    const res = await resolveCodexRuntimeBinary(
      {},
      { resolveBundled: notFound, findOnPath: () => "/usr/local/bin/codex", verifyPath },
    );
    expect(res).toMatchObject({
      ok: true,
      runtimeSource: "path",
      binary: "/usr/local/bin/codex",
      runtimePath: "/usr/local/bin/codex",
      version: "0.140.0",
    });
  });

  it("bundle NOT found → skips a broken PATH candidate and resolves the healthy Desktop path for login", async () => {
    const pathBinary = "/Users/test/.npm-global/bin/codex";
    const desktopBinary = "/Applications/ChatGPT.app/Contents/Resources/codex";
    const verifyPath = vi.fn(
      (path: string): CodexExecutableVerification =>
        path === pathBinary
          ? { ok: false, transient: false, reason: "`codex --version` exited 1: revoked" }
          : { ok: true, output: "codex 0.146.0-alpha.3" },
    );
    const res = await resolveCodexRuntimeBinary(
      {},
      { resolveBundled: notFound, findCandidates: () => [pathBinary, desktopBinary], verifyPath },
    );

    expect(res).toMatchObject({
      ok: true,
      runtimeSource: "path",
      binary: desktopBinary,
      runtimePath: desktopBinary,
      version: "0.146.0",
    });
    expect(verifyPath.mock.calls.map(([path]) => path)).toEqual([pathBinary, desktopBinary]);
  });

  it("bundle NOT found → a transient first-candidate flake still falls through to a healthy later path", async () => {
    const first = "/daemon/bin/codex";
    const desktop = "/Applications/ChatGPT.app/Contents/Resources/codex";
    const res = await resolveCodexRuntimeBinary(
      {},
      {
        resolveBundled: notFound,
        findCandidates: () => [first, desktop],
        verifyPath: (path) =>
          path === first
            ? { ok: false, transient: true, reason: "`codex --version` timed out" }
            : { ok: true, output: "codex 0.146.0" },
      },
    );
    expect(res).toMatchObject({ ok: true, binary: desktop, runtimePath: desktop });
  });

  it("keeps a validated PATH codex available when its version output has no semantic version", async () => {
    const verifyPath = (): CodexExecutableVerification => ({ ok: true, output: "codex dev build" });
    const res = await resolveCodexRuntimeBinary(
      {},
      { resolveBundled: notFound, findOnPath: () => "/usr/local/bin/codex", verifyPath },
    );
    expect(res).toMatchObject({
      ok: true,
      runtimeSource: "path",
      binary: "/usr/local/bin/codex",
      runtimePath: "/usr/local/bin/codex",
      version: null,
    });
  });

  it("bundle NOT found + PATH codex non-transient validation failure → path-bearing unusable error", async () => {
    const verifyPath = (): CodexExecutableVerification => ({
      ok: false,
      transient: false,
      reason: "`codex --version` exited 1: broken shim",
    });
    const res = await resolveCodexRuntimeBinary(
      {},
      { resolveBundled: notFound, findOnPath: () => "/usr/local/bin/codex", verifyPath },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("binary candidates are installed but unusable");
      expect(res.error).toContain("/usr/local/bin/codex");
      expect(res.error).toContain("Upgrade or replace");
      expect(res.error).not.toContain("binary is missing");
    }
  });

  it("bundle NOT found + PATH codex TRANSIENT validation flake → NOT binary-missing", async () => {
    const verifyPath = (): CodexExecutableVerification => ({
      ok: false,
      transient: true,
      reason: "`codex --version` timed out",
    });
    const res = await resolveCodexRuntimeBinary(
      {},
      { resolveBundled: notFound, findOnPath: () => "/usr/local/bin/codex", verifyPath },
    );
    expect(res.ok).toBe(false);
    // A flaky smoke check on a present binary must not tell the operator to
    // reinstall codex.
    if (!res.ok) {
      expect(res.error).not.toContain("Codex runtime binary is missing");
      expect(res.error).toContain("transient host condition");
      expect(res.cause).toBeInstanceOf(Error);
      expect(res.cause?.name).toBe("CodexBinaryVerifyTransientError");
    }
  });

  it("clears a rejected verified path even when a later candidate keeps the aggregate result transient", async () => {
    const staleGlobal = "/Users/test/.npm-global/bin/codex";
    const desktop = "/Applications/ChatGPT.app/Contents/Resources/codex";
    const verifiedCandidateTracker = createCodexVerifiedAutomaticCandidateTracker();
    verifiedCandidateTracker.record(staleGlobal);
    const candidates = () => [staleGlobal, desktop];

    const resolution = await resolveCodexRuntimeBinary(
      { FIRST_TREE_CHAT_ID: "chat-runtime-mixed-rejection" },
      {
        resolveBundled: notFound,
        findCandidates: candidates,
        verifyPath: (path) =>
          path === staleGlobal
            ? { ok: false, transient: false, reason: "revoked binary" }
            : { ok: false, transient: true, reason: "Desktop cold-start timeout" },
        verifiedCandidateTracker,
      },
    );
    const capability = await probeCodexCapability({
      resolveBundled: notFound,
      findCandidates: candidates,
      verifiedCandidateTracker,
      env: {},
    });

    expect(resolution).toMatchObject({ ok: false, cause: { name: "CodexBinaryVerifyTransientError" } });
    expect(verifiedCandidateTracker.get()).toBeNull();
    expect(capability).toMatchObject({ state: "ok", available: true, runtimeSource: "path" });
    expect(capability).not.toHaveProperty("runtimePath");
  });

  it("bounds repeated identical runtime-resolver failures for forced app-server startup", async () => {
    const tracker = createCodexAutomaticResolutionFailureTracker();
    const pathBinary = "/Users/test/.npm-global/bin/codex";
    const deps = {
      resolveBundled: notFound,
      findCandidates: () => [pathBinary],
      verifyPath: (): CodexExecutableVerification => ({
        ok: false,
        transient: true,
        reason: "`codex --version` killed by SIGKILL",
      }),
      failureTracker: tracker,
    };

    const first = await resolveCodexRuntimeBinary({ FIRST_TREE_CHAT_ID: "chat-app-server-bounded" }, deps);
    const second = await resolveCodexRuntimeBinary({ FIRST_TREE_CHAT_ID: "chat-app-server-bounded" }, deps);
    const third = await resolveCodexRuntimeBinary({ FIRST_TREE_CHAT_ID: "chat-app-server-bounded" }, deps);
    expect(first).toMatchObject({ ok: false, error: expect.stringContaining("transient host condition") });
    expect(second).toMatchObject({ ok: false, error: expect.stringContaining("transient host condition") });
    expect(third).toMatchObject({
      ok: false,
      error: expect.stringContaining("same automatic-candidate launch result repeated 3 times"),
    });
    if (!third.ok) {
      expect(third.error).toContain(pathBinary);
      expect(third.error).toContain("Upgrade or replace");
      expect(third.cause?.name).toBe("CodexBinaryUnusableError");
    }
  });

  it("bundle NOT found + no PATH codex → binary-missing", async () => {
    const res = await resolveCodexRuntimeBinary({}, { resolveBundled: notFound, findOnPath: () => null });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("Codex runtime binary is missing");
  });

  it("bundled present + launchable → `bundled` with version", async () => {
    const res = await resolveCodexRuntimeBinary({}, { resolveBundled: found, verifyBundled: verifyOk });
    expect(res).toMatchObject({ ok: true, runtimeSource: "bundled", version: "0.134.0" });
  });
});

describe("probeCapabilities (aggregator)", () => {
  const fakeEntry = (state: "ok" | "missing"): CapabilityEntry => ({
    state,
    available: state === "ok",
    sdkVersion: null,
    detectedAt: new Date().toISOString(),
    latencyMs: 1,
  });

  it("probes only the enabled providers (disabled providers are never invoked)", async () => {
    const tuiProbe = vi.fn().mockResolvedValue(fakeEntry("missing"));
    const antigravityProbe = vi.fn().mockResolvedValue(fakeEntry("missing"));
    const okProbe = vi.fn().mockResolvedValue(fakeEntry("ok"));
    const probes = {
      amp: okProbe,
      "deepseek-harness": okProbe,
      "claude-code": okProbe,
      "claude-code-tui": tuiProbe,
      codex: okProbe,
      cursor: okProbe,
      grok: okProbe,
      antigravity: antigravityProbe,
      "kimi-code": okProbe,
      opencode: okProbe,
      pi: okProbe,
    } as const;

    const { probeCapabilities } = await import("../providers/capabilities/index.js");
    const caps = await probeCapabilities({ probes });

    // Disabled providers are skipped, so they get no capability entry AND
    // their probes are never called (no binary spawn).
    expect(Object.keys(caps).sort()).toEqual([
      "amp",
      "claude-code",
      "codex",
      "cursor",
      "deepseek-harness",
      "grok",
      "kimi-code",
      "opencode",
      "pi",
    ]);
    expect(caps["claude-code"]?.state).toBe("ok");
    expect(caps["claude-code-tui"]).toBeUndefined();
    expect(caps.antigravity).toBeUndefined();
    expect(tuiProbe).not.toHaveBeenCalled();
    expect(antigravityProbe).not.toHaveBeenCalled();
    expect(okProbe).toHaveBeenCalledTimes(9);
  }, 15_000);

  it("publishes the machine-level lark-cli capability alongside runtime providers", async () => {
    const okProbe = vi.fn().mockResolvedValue(fakeEntry("ok"));
    const externalToolProbe = vi.fn().mockReturnValue({ ...fakeEntry("ok"), runtimeSource: "path" });
    const probes = recordByRuntimeProvider(RUNTIME_PROVIDER_IDS.map((provider) => [provider, okProbe] as const));

    const { probeCapabilities } = await import("../providers/capabilities/index.js");
    const caps = await probeCapabilities({ probes, externalToolProbe });

    expect(externalToolProbe).toHaveBeenCalledWith("lark-cli");
    expect(caps["lark-cli"]).toMatchObject({ state: "ok", available: true, runtimeSource: "path" });
  });

  it("converts enabled-provider probe rejections into error capability entries", async () => {
    const probes = {
      amp: vi.fn().mockRejectedValue("amp probe failed"),
      "deepseek-harness": vi.fn().mockRejectedValue("deepseek probe failed"),
      "claude-code": vi.fn().mockRejectedValue(new Error("claude probe failed")),
      "claude-code-tui": vi.fn().mockRejectedValue("tui probe failed"),
      codex: vi.fn().mockRejectedValue("codex probe failed"),
      cursor: vi.fn().mockRejectedValue("cursor probe failed"),
      grok: vi.fn().mockRejectedValue("grok probe failed"),
      antigravity: vi.fn().mockRejectedValue("antigravity probe failed"),
      "kimi-code": vi.fn().mockRejectedValue("kimi probe failed"),
      opencode: vi.fn().mockRejectedValue("opencode probe failed"),
      pi: vi.fn().mockRejectedValue("pi probe failed"),
    } as const;

    const { probeCapabilities } = await import("../providers/capabilities/index.js");
    const caps = await probeCapabilities({ probes });

    expect(caps.amp).toMatchObject({ state: "error", error: "amp probe failed" });
    expect(caps["deepseek-harness"]).toMatchObject({ state: "error", error: "deepseek probe failed" });
    expect(caps["claude-code"]).toMatchObject({
      state: "error",
      available: false,
      error: "claude probe failed",
    });
    expect(caps.codex).toMatchObject({ state: "error", error: "codex probe failed" });
    expect(caps.cursor).toMatchObject({ state: "error", error: "cursor probe failed" });
    expect(caps.grok).toMatchObject({ state: "error", error: "grok probe failed" });
    expect(caps["kimi-code"]).toMatchObject({ state: "error", error: "kimi probe failed" });
    expect(caps.opencode).toMatchObject({ state: "error", error: "opencode probe failed" });
    expect(caps.pi).toMatchObject({ state: "error", error: "pi probe failed" });
    // Disabled providers are never probed, so no entry (not even an error one).
    expect(caps["claude-code-tui"]).toBeUndefined();
    expect(caps.antigravity).toBeUndefined();
    expect(probes["claude-code-tui"]).not.toHaveBeenCalled();
    expect(probes.antigravity).not.toHaveBeenCalled();
  });

  it("publishes stable provider order when probes settle in reverse", async () => {
    const resolvers = new Map<RuntimeProvider, (entry: CapabilityEntry) => void>();
    const probes = recordByRuntimeProvider(
      RUNTIME_PROVIDER_IDS.map(
        (provider) =>
          [
            provider,
            vi.fn(
              () =>
                new Promise<CapabilityEntry>((resolve) => {
                  resolvers.set(provider, resolve);
                }),
            ),
          ] as const,
      ),
    );

    const { probeCapabilities } = await import("../providers/capabilities/index.js");
    const pending = probeCapabilities({ probes });
    const enabledProviders = RUNTIME_PROVIDER_IDS.filter((provider) => isRuntimeProviderEnabled(provider));

    expect([...resolvers.keys()]).toEqual(enabledProviders);
    for (const provider of [...enabledProviders].reverse()) {
      const resolve = resolvers.get(provider);
      if (!resolve) throw new Error(`Missing deferred probe resolver for ${provider}`);
      resolve(fakeEntry("ok"));
    }

    const caps = await pending;
    expect(Object.keys(caps)).toEqual(enabledProviders);
    expect(enabledOkRuntimeProviders(caps)).toEqual([
      "codex",
      "claude-code",
      "amp",
      "deepseek-harness",
      "cursor",
      "grok",
      "kimi-code",
      "opencode",
      "pi",
    ]);
  });

  it("isolates a single probe rejection to that provider entry", async () => {
    const ok = vi.fn().mockResolvedValue(fakeEntry("ok"));
    const probes = {
      amp: ok,
      "deepseek-harness": ok,
      "claude-code": ok,
      "claude-code-tui": ok,
      codex: vi.fn().mockRejectedValue(new Error("only codex")),
      cursor: ok,
      grok: ok,
      antigravity: ok,
      "kimi-code": ok,
      opencode: ok,
      pi: ok,
    } as const;

    const { probeCapabilities } = await import("../providers/capabilities/index.js");
    const caps = await probeCapabilities({ probes });

    expect(caps.codex).toMatchObject({ state: "error", error: "only codex" });
    expect(caps["claude-code"]?.state).toBe("ok");
    expect(caps.cursor?.state).toBe("ok");
    expect(caps.pi?.state).toBe("ok");
  });
});
