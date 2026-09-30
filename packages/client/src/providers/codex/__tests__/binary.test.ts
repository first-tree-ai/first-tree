import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexDesktopAppBinDirs } from "../../../runtime/install-locations.js";
import {
  CodexBinaryUnusableError,
  CodexBinaryVerifyTransientError,
  createCodexAutomaticResolutionFailureTracker,
  createCodexClientWithBinaryFallback,
  createCodexVerifiedAutomaticCandidateTracker,
  type FindCodexExecutableDeps,
  findCodexExecutableCandidates,
  findCodexExecutableOnPath,
  formatCodexBinaryMissingMessage,
  isCodexBinaryMissingError,
  verifyCodexExecutable,
} from "../binary.js";

describe("codex binary resolution", () => {
  let tmp: string | null = null;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it("recognises SDK and CLI wrapper binary-missing errors", () => {
    expect(isCodexBinaryMissingError("Unable to locate Codex CLI binaries for x86_64-apple-darwin")).toBe(true);
    expect(
      isCodexBinaryMissingError(
        "Missing optional dependency @openai/codex-darwin-x64. Reinstall Codex: npm install -g @openai/codex@latest",
      ),
    ).toBe(true);
    const stackOnly = new Error("codex startup failed");
    stackOnly.stack = "Error: codex startup failed\n    at findCodexPath (index.js:445:11)";
    expect(isCodexBinaryMissingError(stackOnly)).toBe(true);
    expect(isCodexBinaryMissingError("Your access token expired")).toBe(false);
  });

  it("falls back to a PATH codex executable when bundled resolution fails", () => {
    const calls: unknown[] = [];
    const log = vi.fn();
    const verifyPath = vi.fn(() => ({ ok: true as const, output: "codex 0.139.0" }));
    const result = createCodexClientWithBinaryFallback(
      { env: { PATH: "/usr/local/bin" } },
      (options) => {
        calls.push(options);
        if (!("codexPathOverride" in options)) {
          throw new Error("Unable to locate Codex CLI binaries for x86_64-apple-darwin");
        }
        return { ok: true, options };
      },
      {
        resolvePath: () => "/usr/local/bin/codex",
        verifyPath,
        log,
      },
    );

    expect(result).toMatchObject({
      client: { ok: true },
      runtimeSource: "path",
      codexPathOverride: "/usr/local/bin/codex",
    });
    expect(calls).toHaveLength(2);
    expect(verifyPath).toHaveBeenCalledWith("/usr/local/bin/codex", { PATH: "/usr/local/bin" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("falling back to codex"));
  });

  it("reports a deterministically broken automatic candidate as unusable", () => {
    let thrown: unknown;
    try {
      createCodexClientWithBinaryFallback(
        { env: { PATH: "/usr/local/bin" } },
        () => {
          throw new Error("Unable to locate Codex CLI binaries for x86_64-apple-darwin");
        },
        {
          resolvePath: () => "/usr/local/bin/codex",
          verifyPath: () => ({ ok: false, transient: false, reason: "`codex --version` exited 1: broken shim" }),
        },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CodexBinaryUnusableError);
    expect((thrown as Error).message).toContain("/usr/local/bin/codex");
    expect((thrown as Error).message).toContain("broken shim");
    expect((thrown as Error).message).toContain("npm install -g @openai/codex");
  });

  it("launch-verifies automatic candidates in priority order and reaches ChatGPT Desktop", () => {
    tmp = mkdtempSync(join(tmpdir(), "ft-codex-ordered-fallback-"));
    const daemonDir = join(tmp, "daemon-bin");
    const wellKnownDir = join(tmp, "well-known-bin");
    const loginDir = join(tmp, "login-bin");
    const desktopDir = join(tmp, "ChatGPT.app", "Contents", "Resources");
    for (const dir of [daemonDir, wellKnownDir, loginDir, desktopDir]) mkdirSync(dir, { recursive: true });
    const candidates = [daemonDir, wellKnownDir, loginDir, desktopDir].map((dir) => join(dir, "codex"));
    for (const candidate of candidates) {
      writeFileSync(candidate, "#!/bin/sh\nexit 0\n");
      chmodSync(candidate, 0o755);
    }
    const loginShellPathDirs = vi.fn(() => [loginDir]);
    const desktopAppDirs = vi.fn(() => [desktopDir]);
    const verifyPath = vi.fn((path: string) =>
      path === candidates[3]
        ? ({ ok: true as const, output: "codex 0.146.0-alpha.3" } as const)
        : ({ ok: false as const, transient: false, reason: "candidate cannot launch" } as const),
    );
    const verifiedCandidateTracker = createCodexVerifiedAutomaticCandidateTracker();

    const result = createCodexClientWithBinaryFallback(
      { env: { PATH: daemonDir, HOME: tmp, FIRST_TREE_CHAT_ID: "chat-desktop-fallback" } },
      (options) => {
        if (!("codexPathOverride" in options) || typeof options.codexPathOverride !== "string") {
          throw new Error("Unable to locate Codex CLI binaries for x86_64-apple-darwin");
        }
        return options;
      },
      {
        resolveCandidates: (env) =>
          findCodexExecutableCandidates(env, {
            platform: "linux",
            pathDelimiter: delimiter,
            wellKnownDirs: () => [wellKnownDir],
            loginShellPathDirs,
            desktopAppDirs,
          }),
        verifyPath,
        verifiedCandidateTracker,
      },
    );

    expect(result.codexPathOverride).toBe(candidates[3]);
    expect(verifiedCandidateTracker.get()).toBe(candidates[3]);
    expect(verifyPath.mock.calls.map(([path]) => path)).toEqual(candidates);
    expect(loginShellPathDirs).toHaveBeenCalledTimes(1);
    expect(desktopAppDirs).toHaveBeenCalledTimes(1);
  });

  it("falls through a transient first-candidate smoke flake when a later Desktop candidate is healthy", () => {
    const first = "/daemon/path/codex";
    const desktop = "/Applications/ChatGPT.app/Contents/Resources/codex";
    const verifyPath = vi.fn((path: string) =>
      path === first
        ? ({ ok: false as const, transient: true, reason: "`codex --version` killed by SIGKILL" } as const)
        : ({ ok: true as const, output: "codex 0.146.0-alpha.3" } as const),
    );
    const result = createCodexClientWithBinaryFallback(
      { env: { FIRST_TREE_CHAT_ID: "chat-transient-fallback" } },
      (options) => {
        if (!("codexPathOverride" in options) || typeof options.codexPathOverride !== "string") {
          throw new Error("Unable to locate Codex CLI binaries");
        }
        return options;
      },
      { resolveCandidates: () => [first, desktop], verifyPath },
    );

    expect(result.codexPathOverride).toBe(desktop);
    expect(verifyPath.mock.calls.map(([path]) => path)).toEqual([first, desktop]);
  });

  it("forgets a previously verified SDK fallback path when that path is deterministically rejected", () => {
    const staleGlobal = "/Users/test/.npm-global/bin/codex";
    const desktop = "/Applications/ChatGPT.app/Contents/Resources/codex";
    const verifiedCandidateTracker = createCodexVerifiedAutomaticCandidateTracker();
    verifiedCandidateTracker.record(staleGlobal);

    expect(() =>
      createCodexClientWithBinaryFallback(
        { env: { FIRST_TREE_CHAT_ID: "chat-mixed-rejection" } },
        () => {
          throw new Error("Unable to locate Codex CLI binaries");
        },
        {
          resolveCandidates: () => [staleGlobal, desktop],
          verifyPath: (path) =>
            path === staleGlobal
              ? { ok: false, transient: false, reason: "revoked binary" }
              : { ok: false, transient: true, reason: "Desktop cold-start timeout" },
          verifiedCandidateTracker,
        },
      ),
    ).toThrow(CodexBinaryVerifyTransientError);
    expect(verifiedCandidateTracker.get()).toBeNull();
  });

  it("bounds repeated identical all-candidate transient failures with an actionable terminal error", () => {
    const tracker = createCodexAutomaticResolutionFailureTracker();
    const first = "/Users/test/.npm-global/bin/codex";
    const desktop = "/Applications/ChatGPT.app/Contents/Resources/codex";
    const attempt = () =>
      createCodexClientWithBinaryFallback(
        { env: { FIRST_TREE_CHAT_ID: "chat-bounded" } },
        () => {
          throw new Error("Unable to locate Codex CLI binaries");
        },
        {
          resolveCandidates: () => [first, desktop],
          verifyPath: (path) => ({
            ok: false,
            transient: true,
            reason: path === first ? "`codex --version` killed by SIGKILL" : "`codex --version` timed out",
          }),
          failureTracker: tracker,
        },
      );

    expect(attempt).toThrow(CodexBinaryVerifyTransientError);
    expect(attempt).toThrow(CodexBinaryVerifyTransientError);
    let terminal: unknown;
    try {
      attempt();
    } catch (err) {
      terminal = err;
    }
    expect(terminal).toBeInstanceOf(CodexBinaryUnusableError);
    expect((terminal as Error).message).toContain("repeated 3 times");
    expect((terminal as Error).message).toContain(first);
    expect((terminal as Error).message).toContain(desktop);
    expect((terminal as Error).message).toContain("Upgrade or replace");

    // The terminal settlement closes that sequence. A later user-initiated
    // retry for the same chat gets a fresh initial attempt plus two retries.
    expect(attempt).toThrow(CodexBinaryVerifyTransientError);
    expect(attempt).toThrow(CodexBinaryVerifyTransientError);
    expect(attempt).toThrow(CodexBinaryUnusableError);
  });

  it("treats a transient PATH-codex verify flake as retryable, NOT a missing binary", () => {
    let thrown: unknown;
    try {
      createCodexClientWithBinaryFallback(
        { env: { PATH: "/usr/local/bin" } },
        () => {
          throw new Error("Unable to locate Codex CLI binaries for x86_64-apple-darwin");
        },
        {
          resolvePath: () => "/usr/local/bin/codex",
          verifyPath: () => ({ ok: false, transient: true, reason: "`codex --version` timed out" }),
        },
      );
    } catch (err) {
      thrown = err;
    }
    // A present-but-flaky binary must surface as the transient error the
    // taxonomy retries; never as a permanent "binary missing".
    expect(thrown).toBeInstanceOf(CodexBinaryVerifyTransientError);
    expect((thrown as Error).message).not.toMatch(/binary is missing/i);
    expect(isCodexBinaryMissingError(thrown)).toBe(false);
  });

  it("throws an actionable error when neither bundled nor PATH codex exists", () => {
    expect(() =>
      createCodexClientWithBinaryFallback(
        {},
        () => {
          throw new Error(
            "Unable to locate Codex CLI binaries. Ensure @openai/codex is installed with optional dependencies.",
          );
        },
        { resolvePath: () => null },
      ),
    ).toThrow(/npm install -g @openai\/codex/);
  });

  it("does not swallow non-binary constructor errors", () => {
    expect(() =>
      createCodexClientWithBinaryFallback(
        {},
        () => {
          throw new Error("config exploded");
        },
        { resolvePath: () => "/usr/local/bin/codex" },
      ),
    ).toThrow("config exploded");
  });

  it("never replaces an explicit codexPathOverride with an automatic candidate", () => {
    const resolveCandidates = vi.fn(() => ["/automatic/codex"]);
    expect(() =>
      createCodexClientWithBinaryFallback(
        { codexPathOverride: "/configured/codex" },
        () => {
          throw new Error("Unable to locate Codex CLI binaries at configured override");
        },
        { resolveCandidates },
      ),
    ).toThrow("configured override");
    expect(resolveCandidates).not.toHaveBeenCalled();
  });

  it("finds an executable codex on PATH", () => {
    tmp = mkdtempSync(join(tmpdir(), "ft-codex-path-"));
    const executable = join(tmp, "codex");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);

    expect(
      findCodexExecutableOnPath(
        { PATH: `${tmp}${delimiter}/bin` },
        { platform: "linux", pathDelimiter: delimiter, loginShellPathDirs: () => [] },
      ),
    ).toBe(executable);
  });

  it("on Windows resolves an npm codex shim to the native codex.exe it wraps", () => {
    tmp = mkdtempSync(join(tmpdir(), "ft-codex-win-shim-"));
    const shim = join(tmp, "codex.cmd");
    const codexPackageRoot = join(tmp, "node_modules", "@openai", "codex");
    const platformPackageRoot = join(codexPackageRoot, "node_modules", "@openai", "codex-win32-x64");
    const native = join(platformPackageRoot, "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
    mkdirSync(join(platformPackageRoot, "vendor", "x86_64-pc-windows-msvc", "bin"), { recursive: true });
    writeFileSync(join(codexPackageRoot, "package.json"), JSON.stringify({ name: "@openai/codex" }));
    writeFileSync(join(platformPackageRoot, "package.json"), JSON.stringify({ name: "@openai/codex-win32-x64" }));
    writeFileSync(shim, "@ECHO off\nnode node_modules\\@openai\\codex\\bin\\codex.js %*\n");
    writeFileSync(native, "fake native exe");
    chmodSync(shim, 0o755);
    chmodSync(native, 0o755);

    const found = findCodexExecutableOnPath(
      { Path: tmp, PATHEXT: ".EXE;.CMD;.BAT;.COM" },
      {
        platform: "win32",
        arch: "x64",
        pathDelimiter: ";",
        loginShellPathDirs: () => [],
        wellKnownDirs: () => [],
      },
    );

    expect(found).not.toBeNull();
    if (found === null) throw new Error("expected the native Windows codex executable");
    expect(realpathSync(found)).toBe(realpathSync(native));
  });

  it("on Windows does not return an npm cmd shim when the native codex.exe is absent", () => {
    tmp = mkdtempSync(join(tmpdir(), "ft-codex-win-no-native-"));
    const shim = join(tmp, "codex.cmd");
    writeFileSync(shim, "@ECHO off\nnode node_modules\\@openai\\codex\\bin\\codex.js %*\n");
    chmodSync(shim, 0o755);

    const found = findCodexExecutableOnPath(
      { PATH: tmp, PATHEXT: ".CMD" },
      {
        platform: "win32",
        arch: "x64",
        pathDelimiter: ";",
        loginShellPathDirs: () => [],
        wellKnownDirs: () => [],
      },
    );

    expect(found).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "verifyCodexExecutable: a deterministic crash signal is NOT transient (broken binary surfaces, no infinite retry)",
    () => {
      tmp = mkdtempSync(join(tmpdir(), "ft-codex-crash-"));
      const executable = join(tmp, "codex");
      // Self-terminate with SIGSEGV: a binary that always faults on `--version`.
      writeFileSync(executable, "#!/bin/sh\nkill -SEGV $$\n");
      chmodSync(executable, 0o755);

      const v = verifyCodexExecutable(executable, { PATH: "" });
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.transient).toBe(false);
        expect(v.reason).toMatch(/SEGV/);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "verifyCodexExecutable: a termination kill (timeout-equivalent) IS transient",
    () => {
      tmp = mkdtempSync(join(tmpdir(), "ft-codex-term-"));
      const executable = join(tmp, "codex");
      // SIGTERM is how a spawnSync timeout enforces its deadline - a host
      // condition, not a broken binary.
      writeFileSync(executable, "#!/bin/sh\nkill -TERM $$\n");
      chmodSync(executable, 0o755);

      const v = verifyCodexExecutable(executable, { PATH: "" });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.transient).toBe(true);
    },
  );

  it("finds an executable codex via a login-shell-only PATH dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "ft-codex-login-"));
    tmp = dir;
    const executable = join(dir, "codex");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);

    const found = findCodexExecutableOnPath(
      { PATH: "", HOME: mkdtempSync(join(tmpdir(), "ft-codex-home-")) },
      // Isolate from both real host installs and the installed macOS app bundle.
      {
        platform: "linux",
        pathDelimiter: delimiter,
        loginShellPathDirs: () => [dir],
        wellKnownDirs: () => [],
        desktopAppDirs: () => [],
      },
    );
    expect(found).toBe(executable);
  });

  it("finds an executable codex via a Part-A well-known dir (~/.bun/bin)", () => {
    const home = mkdtempSync(join(tmpdir(), "ft-codex-bun-"));
    tmp = home;
    const bunBin = join(home, ".bun", "bin");
    mkdirSync(bunBin, { recursive: true });
    const executable = join(bunBin, "codex");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);

    expect(
      findCodexExecutableOnPath(
        { PATH: "", HOME: home },
        { platform: "linux", pathDelimiter: delimiter, loginShellPathDirs: () => [] },
      ),
    ).toBe(executable);
  });

  it("prefers the ChatGPT app CLI and falls back to the legacy Codex app CLI", () => {
    tmp = mkdtempSync(join(tmpdir(), "ft-codex-apps-"));
    const chatGptResources = join(tmp, "ChatGPT.app", "Contents", "Resources");
    const legacyResources = join(tmp, "Codex.app", "Contents", "Resources");
    mkdirSync(chatGptResources, { recursive: true });
    mkdirSync(legacyResources, { recursive: true });
    const chatGptCodex = join(chatGptResources, "codex");
    const legacyCodex = join(legacyResources, "codex");
    writeFileSync(chatGptCodex, "#!/bin/sh\nexit 0\n");
    writeFileSync(legacyCodex, "#!/bin/sh\nexit 0\n");
    chmodSync(chatGptCodex, 0o755);
    chmodSync(legacyCodex, 0o755);

    const deps: FindCodexExecutableDeps = {
      platform: "linux",
      pathDelimiter: delimiter,
      loginShellPathDirs: () => [],
      wellKnownDirs: () => [],
      desktopAppDirs: () => [chatGptResources, legacyResources],
    };
    expect(findCodexExecutableOnPath({ PATH: "" }, deps)).toBe(chatGptCodex);

    rmSync(chatGptCodex);
    expect(findCodexExecutableOnPath({ PATH: "" }, deps)).toBe(legacyCodex);
  });

  it.each(["system", "user"])("discovers the nested ChatGPT Codex CLI in a %s installation", (installation) => {
    tmp = mkdtempSync(join(tmpdir(), "ft-codex-nested-app-"));
    const home = join(tmp, "home");
    const systemRoot = join(tmp, "system");
    const appRoot = installation === "system" ? systemRoot : home;
    const binDir = join(
      appRoot,
      "Applications",
      "ChatGPT.app",
      "Contents",
      "Resources",
      "codex-cli",
      "CodexCLI.app",
      "Contents",
      "MacOS",
    );
    mkdirSync(binDir, { recursive: true });
    const executable = join(binDir, "codex");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);

    const desktopDirs = codexDesktopAppBinDirs(home, "darwin").map((dir) =>
      dir.startsWith("/Applications/") ? join(systemRoot, dir) : dir,
    );
    expect(
      findCodexExecutableOnPath(
        { PATH: "", HOME: home },
        {
          platform: "linux",
          loginShellPathDirs: () => [],
          wellKnownDirs: () => [],
          desktopAppDirs: () => desktopDirs,
        },
      ),
    ).toBe(executable);
  });

  it("prefers a login-shell PATH codex over the desktop app CLI", () => {
    tmp = mkdtempSync(join(tmpdir(), "ft-codex-login-vs-app-"));
    const loginDir = join(tmp, "login-bin");
    const appResources = join(tmp, "ChatGPT.app", "Contents", "Resources");
    mkdirSync(loginDir, { recursive: true });
    mkdirSync(appResources, { recursive: true });
    const loginCodex = join(loginDir, "codex");
    const appCodex = join(appResources, "codex");
    writeFileSync(loginCodex, "#!/bin/sh\nexit 0\n");
    writeFileSync(appCodex, "#!/bin/sh\nexit 0\n");
    chmodSync(loginCodex, 0o755);
    chmodSync(appCodex, 0o755);

    expect(
      findCodexExecutableOnPath(
        { PATH: "" },
        {
          platform: "linux",
          pathDelimiter: delimiter,
          wellKnownDirs: () => [],
          loginShellPathDirs: () => [loginDir],
          desktopAppDirs: () => [appResources],
        },
      ),
    ).toBe(loginCodex);
  });

  it("does not throw when the login-shell probe yields nothing (graceful fallback)", () => {
    const home = mkdtempSync(join(tmpdir(), "ft-codex-none-"));
    tmp = home;
    // Empty PATH + login-shell []; resolution then falls through to the curated
    // well-known dirs without throwing (the dev machine may or may not have a
    // codex in an absolute well-known dir, so only assert no-throw here).
    expect(() =>
      findCodexExecutableOnPath({ PATH: "", HOME: home }, { loginShellPathDirs: () => [], desktopAppDirs: () => [] }),
    ).not.toThrow();
  });

  it("does not consult the login-shell probe when the daemon PATH already resolves codex", () => {
    tmp = mkdtempSync(join(tmpdir(), "ft-codex-daemon-"));
    const executable = join(tmp, "codex");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    const loginShellPathDirs = vi.fn(() => []);
    const desktopAppDirs = vi.fn(() => []);

    expect(
      findCodexExecutableOnPath(
        { PATH: tmp },
        { platform: "linux", pathDelimiter: delimiter, loginShellPathDirs, desktopAppDirs },
      ),
    ).toBe(executable);
    expect(loginShellPathDirs).not.toHaveBeenCalled();
    expect(desktopAppDirs).not.toHaveBeenCalled();
  });

  it("verifies a candidate codex executable by launching --version", () => {
    const verification = verifyCodexExecutable(process.execPath);
    expect(verification.ok).toBe(true);
    if (verification.ok) expect(verification.output).toContain(process.version);
  });

  it("formats binary-missing messages with the original cause", () => {
    const message = formatCodexBinaryMissingMessage("Unable to locate Codex CLI binaries");
    expect(message).toContain("Codex runtime binary is missing");
    expect(message).toContain("ChatGPT/Codex desktop app on macOS");
    expect(message).toContain("npm install -g @openai/codex");
    expect(message).toContain("codex login");
    expect(message).toContain("daemon install-codex");
    expect(message).toContain("Original error: Unable to locate Codex CLI binaries");
  });
});
