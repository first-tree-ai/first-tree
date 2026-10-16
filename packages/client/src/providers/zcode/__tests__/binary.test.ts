import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildZcodeTurnArgs,
  findZcodeExecutableOnPath,
  formatZcodeBinaryMissingMessage,
  isZcodeBinaryMissingError,
  resolveZcodeRuntimeBinary,
  ZCODE_INSTALL_COMMAND,
  ZCODE_LOGIN_COMMAND,
} from "../binary.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("findZcodeExecutableOnPath", () => {
  it("finds the operator-installed binary on PATH without launching it", () => {
    const root = mkdtempSync(join(tmpdir(), "ft-zcode-bin-"));
    roots.push(root);
    const binary = join(root, "zcode");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);

    expect(
      findZcodeExecutableOnPath(
        { PATH: root },
        { platform: "linux", wellKnownDirs: () => [], loginShellPathDirs: () => [] },
      ),
    ).toBe(binary);
  });

  it("finds ~/.local/bin and ~/.zcode/bin when PATH is empty", () => {
    const root = mkdtempSync(join(tmpdir(), "ft-zcode-home-"));
    roots.push(root);
    const binary = join(root, ".zcode", "bin", "zcode");
    mkdirSync(join(root, ".zcode", "bin"), { recursive: true });
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);

    expect(
      findZcodeExecutableOnPath(
        { HOME: root, PATH: "" },
        { platform: "linux", wellKnownDirs: () => [], loginShellPathDirs: () => [] },
      ),
    ).toBe(binary);
  });
});

describe("resolveZcodeRuntimeBinary", () => {
  it("resolves without launching", () => {
    expect(resolveZcodeRuntimeBinary({}, { findOnPath: () => "/opt/bin/zcode" })).toEqual({
      ok: true,
      binary: "/opt/bin/zcode",
    });
  });

  it("reports a missing binary with the official installer and host login", () => {
    const result = resolveZcodeRuntimeBinary({}, { findOnPath: () => null });
    expect(result).toMatchObject({ ok: false, transient: false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain(ZCODE_INSTALL_COMMAND);
    expect(result.error).toContain(ZCODE_LOGIN_COMMAND);
    expect(formatZcodeBinaryMissingMessage("no zcode binary")).toContain("First Tree does not bundle or install ZCode");
  });
});

describe("isZcodeBinaryMissingError", () => {
  it("identifies missing binary error phrases", () => {
    expect(isZcodeBinaryMissingError("zcode cli is missing on this machine")).toBe(true);
    expect(isZcodeBinaryMissingError("no zcode binary resolved")).toBe(true);
    expect(isZcodeBinaryMissingError("zcode: command not found")).toBe(true);
    expect(isZcodeBinaryMissingError("something unrelated")).toBe(false);
  });
});

describe("buildZcodeTurnArgs", () => {
  it("builds one canonical no-shell turn invocation", () => {
    expect(
      buildZcodeTurnArgs({
        workspace: "/tmp/agent-workspace",
        prompt: 'first\n\nsay "ok" $(not-expanded)',
        mode: "plan",
        resumeSessionId: null,
      }),
    ).toEqual([
      "--json",
      "--no-color",
      "--mode",
      "plan",
      "--cwd",
      "/tmp/agent-workspace",
      "--prompt",
      'first\n\nsay "ok" $(not-expanded)',
    ]);
  });

  it("resumes only with the confirmed provider-owned session identity", () => {
    const args = buildZcodeTurnArgs({
      workspace: "/tmp/agent-workspace",
      prompt: "continue",
      mode: "edit",
      resumeSessionId: "sess_confirmed",
    });
    expect(args.slice(-2)).toEqual(["--resume", "sess_confirmed"]);
  });

  it("rejects an empty provider prompt", () => {
    expect(() =>
      buildZcodeTurnArgs({
        workspace: "/tmp/agent-workspace",
        prompt: "   \n\t ",
        mode: "build",
        resumeSessionId: null,
      }),
    ).toThrow(/empty/i);
  });
});
