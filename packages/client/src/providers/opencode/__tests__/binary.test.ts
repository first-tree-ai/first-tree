import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findOpenCodeExecutableOnPath,
  formatOpenCodeBinaryMissingMessage,
  isSupportedOpenCodeVersion,
  parseOpenCodeVersionOutput,
  resolveOpenCodeRuntimeBinary,
} from "../binary.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("OpenCode binary resolution", () => {
  it("finds the operator-installed binary without launching it", () => {
    const root = mkdtempSync(join(tmpdir(), "ft-opencode-bin-"));
    roots.push(root);
    const binary = join(root, "opencode");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);

    expect(
      findOpenCodeExecutableOnPath(
        { PATH: root },
        { platform: "linux", wellKnownDirs: () => [], loginShellPathDirs: () => [] },
      ),
    ).toBe(binary);
  });

  it("finds the official OpenCode home even when the daemon PATH is empty", () => {
    const root = mkdtempSync(join(tmpdir(), "ft-opencode-home-"));
    roots.push(root);
    const binary = join(root, ".opencode", "bin", "opencode");
    mkdirSync(join(root, ".opencode", "bin"), { recursive: true });
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);

    expect(
      findOpenCodeExecutableOnPath(
        { HOME: root, PATH: "" },
        { platform: "linux", wellKnownDirs: () => [], loginShellPathDirs: () => [] },
      ),
    ).toBe(binary);
  });

  it("resolves without launching; the handler performs its gate through the process supervisor", () => {
    const result = resolveOpenCodeRuntimeBinary({}, { findOnPath: () => "/opt/bin/opencode" });
    expect(result).toEqual({ ok: true, binary: "/opt/bin/opencode" });
  });

  it("resolves npm's native Windows executable instead of the opencode.cmd shim", () => {
    const root = mkdtempSync(join(tmpdir(), "ft-opencode-win-bin-"));
    roots.push(root);
    const native = join(root, "node_modules", "opencode-ai", "bin", "opencode.exe");
    mkdirSync(join(root, "node_modules", "opencode-ai", "bin"), { recursive: true });
    writeFileSync(join(root, "opencode.cmd"), "@echo off\r\n");
    writeFileSync(native, "native");

    expect(
      findOpenCodeExecutableOnPath(
        { PATH: root },
        {
          platform: "win32",
          pathDelimiter: ";",
          wellKnownDirs: () => [],
          loginShellPathDirs: () => [],
        },
      ),
    ).toBe(native);
  });

  it("resolves a global Windows npm prefix when the daemon PATH is empty", () => {
    const root = mkdtempSync(join(tmpdir(), "ft-opencode-win-prefix-"));
    roots.push(root);
    const native = join(root, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
    mkdirSync(join(root, "npm", "node_modules", "opencode-ai", "bin"), { recursive: true });
    writeFileSync(native, "native");

    expect(
      findOpenCodeExecutableOnPath(
        { USERPROFILE: join(root, "profile"), APPDATA: root, PATH: "" },
        {
          platform: "win32",
          pathDelimiter: ";",
          loginShellPathDirs: () => [],
        },
      ),
    ).toBe(native);
  });

  it("resolves the official Windows home without a daemon PATH or cmd shim", () => {
    const root = mkdtempSync(join(tmpdir(), "ft-opencode-win-home-"));
    roots.push(root);
    const native = join(root, ".opencode", "bin", "opencode.exe");
    mkdirSync(join(root, ".opencode", "bin"), { recursive: true });
    writeFileSync(native, "native");

    expect(
      findOpenCodeExecutableOnPath(
        { USERPROFILE: root, PATH: "" },
        {
          platform: "win32",
          pathDelimiter: ";",
          wellKnownDirs: () => [],
          loginShellPathDirs: () => [],
        },
      ),
    ).toBe(native);
  });

  it("surfaces external install and provider-owned auth instructions", () => {
    expect(formatOpenCodeBinaryMissingMessage("not found")).toContain("npm install -g opencode-ai@^2");
    expect(formatOpenCodeBinaryMissingMessage("not found")).toContain("opencode auth login");
  });

  it("parses a stable semver without accepting prerelease or partial versions", () => {
    expect(parseOpenCodeVersionOutput("opencode 1.18.7")).toBe("1.18.7");
    expect(parseOpenCodeVersionOutput("opencode v2.0.26")).toBe("2.0.26");
    expect(parseOpenCodeVersionOutput("opencode 1.18.9-beta.1")).toBeNull();
    expect(parseOpenCodeVersionOutput("opencode v1.18.9-beta.1")).toBeNull();
    expect(parseOpenCodeVersionOutput("opencode 01.18.7")).toBeNull();
    expect(parseOpenCodeVersionOutput("opencode 1.18.7_suffix")).toBeNull();
    expect(parseOpenCodeVersionOutput("opencode 1.18")).toBeNull();
    expect(parseOpenCodeVersionOutput("not-a-version")).toBeNull();
    expect(parseOpenCodeVersionOutput(`${"0".repeat(100_000)}.x opencode 1.18.7`)).toBe("1.18.7");
    expect(parseOpenCodeVersionOutput(`${"0".repeat(100_000)}.x opencode v2.0.26`)).toBe("2.0.26");
  });

  it("accepts the supported 1.x and 2.x range and fails closed outside it", () => {
    expect(isSupportedOpenCodeVersion("1.18.7")).toBe(true);
    expect(isSupportedOpenCodeVersion("1.18.9")).toBe(true);
    expect(isSupportedOpenCodeVersion("1.19.0")).toBe(true);
    expect(isSupportedOpenCodeVersion("2.0.0")).toBe(true);
    expect(isSupportedOpenCodeVersion("2.0.26")).toBe(true);
    expect(isSupportedOpenCodeVersion("2.99.99")).toBe(true);
    expect(isSupportedOpenCodeVersion("1.18.6")).toBe(false);
    expect(isSupportedOpenCodeVersion("3.0.0")).toBe(false);
    expect(isSupportedOpenCodeVersion("1.18.9-beta.1")).toBe(false);
    expect(isSupportedOpenCodeVersion("01.18.7")).toBe(false);
    expect(isSupportedOpenCodeVersion("1.18.7_suffix")).toBe(false);
    expect(isSupportedOpenCodeVersion(null)).toBe(false);
  });
});
