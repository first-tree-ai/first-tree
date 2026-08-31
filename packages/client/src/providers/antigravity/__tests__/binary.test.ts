import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANTIGRAVITY_INSTALL_COMMAND,
  ANTIGRAVITY_LOGIN_COMMAND,
  buildAntigravityTurnArgs,
  findAntigravityExecutableOnPath,
  formatAntigravityBinaryMissingMessage,
  isAntigravityBinaryMissingError,
  resolveAntigravityRuntimeBinary,
} from "../binary.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function makeExecutable(path: string): void {
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
}

describe("Antigravity binary helpers", () => {
  it("builds stream-json args and carries only a confirmed resume id", () => {
    expect(
      buildAntigravityTurnArgs({
        model: "gemini-3-pro",
        reasoningEffort: "high",
        resumeSessionId: "conversation-1",
        turnTimeoutMs: 90_001,
      }),
    ).toEqual([
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--print-timeout",
      "2m",
      "--model",
      "gemini-3-pro",
      "--effort",
      "high",
      "--conversation",
      "conversation-1",
    ]);
    expect(
      buildAntigravityTurnArgs({ model: "", reasoningEffort: "", resumeSessionId: null, turnTimeoutMs: 1 }),
    ).toEqual([
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--print-timeout",
      "1m",
    ]);
  });

  it("resolves agy from PATH before the official user install directory", () => {
    const root = tempRoot("antigravity-binary-");
    const pathBin = join(root, "path-bin");
    const localBin = join(root, ".local", "bin");
    mkdirSync(pathBin, { recursive: true });
    mkdirSync(localBin, { recursive: true });
    makeExecutable(join(pathBin, "agy"));
    makeExecutable(join(localBin, "agy"));

    expect(
      findAntigravityExecutableOnPath(
        { HOME: root, PATH: pathBin },
        { wellKnownDirs: () => [], loginShellPathDirs: () => [] },
      ),
    ).toBe(join(pathBin, "agy"));
  });

  it("finds the official ~/.local/bin install when the daemon PATH misses", () => {
    const root = tempRoot("antigravity-official-");
    const localBin = join(root, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    makeExecutable(join(localBin, "agy"));

    expect(
      findAntigravityExecutableOnPath(
        { HOME: root, PATH: join(root, "missing") },
        { wellKnownDirs: () => [], loginShellPathDirs: () => [] },
      ),
    ).toBe(join(localBin, "agy"));
  });

  it("formats a missing-runtime hint without conflating auth with capability detection", () => {
    const message = formatAntigravityBinaryMissingMessage("no agy binary resolved");
    expect(message).toContain(ANTIGRAVITY_INSTALL_COMMAND);
    expect(message).toContain(ANTIGRAVITY_LOGIN_COMMAND);
    expect(isAntigravityBinaryMissingError(message)).toBe(true);
    expect(isAntigravityBinaryMissingError("authentication required")).toBe(false);
  });

  it("returns a deterministic missing resolution without spawning", () => {
    const resolution = resolveAntigravityRuntimeBinary(
      { HOME: tempRoot("antigravity-missing-"), PATH: "" },
      { findOnPath: vi.fn(() => null) },
    );
    expect(resolution).toMatchObject({ ok: false, transient: false });
    if (resolution.ok) throw new Error("unreachable");
    expect(resolution.error).toContain(ANTIGRAVITY_INSTALL_COMMAND);
  });
});
