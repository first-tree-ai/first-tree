import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findPiExecutableOnPath,
  formatPiBinaryMissingMessage,
  isPiBinaryMissingError,
  isSupportedPiVersion,
  parsePiVersionOutput,
  resolvePiRuntimeBinary,
} from "../binary.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Pi binary resolution", () => {
  it("finds the operator-installed binary without launching it", () => {
    const root = mkdtempSync(join(tmpdir(), "ft-pi-bin-"));
    roots.push(root);
    const binary = join(root, "pi");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);

    expect(
      findPiExecutableOnPath(
        { PATH: root },
        { platform: "linux", wellKnownDirs: () => [], loginShellPathDirs: () => [] },
      ),
    ).toBe(binary);
  });

  it("finds ~/.local/bin when the daemon PATH is empty", () => {
    const root = mkdtempSync(join(tmpdir(), "ft-pi-local-"));
    roots.push(root);
    const binary = join(root, ".local", "bin", "pi");
    mkdirSync(join(root, ".local", "bin"), { recursive: true });
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);

    expect(
      findPiExecutableOnPath(
        { HOME: root, PATH: "" },
        {
          platform: "linux",
          wellKnownDirs: () => [join(root, ".local", "bin")],
          loginShellPathDirs: () => [],
        },
      ),
    ).toBe(binary);
  });

  it("resolves without launching; the handler performs its gate through the process supervisor", () => {
    const result = resolvePiRuntimeBinary({}, { findOnPath: () => "/opt/bin/pi" });
    expect(result).toEqual({ ok: true, binary: "/opt/bin/pi" });
  });

  it("resolves npm's native Windows executable instead of the pi.cmd shim", () => {
    const root = mkdtempSync(join(tmpdir(), "ft-pi-win-bin-"));
    roots.push(root);
    const native = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "bin", "pi.exe");
    mkdirSync(join(root, "node_modules", "@earendil-works", "pi-coding-agent", "bin"), { recursive: true });
    writeFileSync(join(root, "pi.cmd"), "@echo off\r\n");
    writeFileSync(native, "native");

    expect(
      findPiExecutableOnPath(
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

  it("surfaces external install and provider-owned auth instructions", () => {
    expect(formatPiBinaryMissingMessage("not found")).toContain(
      "npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
    );
    expect(formatPiBinaryMissingMessage("not found")).toContain("/login");
    expect(formatPiBinaryMissingMessage("not found")).not.toContain("export");
  });

  it("classifies legitimate missing-binary messages without regex backtracking", () => {
    expect(isPiBinaryMissingError("Pi CLI is missing on this machine")).toBe(true);
    expect(isPiBinaryMissingError("pi: command not found")).toBe(true);
    expect(isPiBinaryMissingError("pi is not installed")).toBe(true);
    expect(isPiBinaryMissingError(new Error("ENOENT: pi binary not found"))).toBe(true);
    expect(isPiBinaryMissingError("no pi binary resolved")).toBe(true);
    expect(isPiBinaryMissingError("python: command not found")).toBe(false);
    expect(isPiBinaryMissingError("network timeout")).toBe(false);
    // Generic taxonomy matcher requires a Pi subject — bare absence phrases
    // stay unmatched (Pi-scoped sanitizer uses a broader seam entry instead).
    expect(isPiBinaryMissingError("file not found")).toBe(false);
    expect(isPiBinaryMissingError("package not installed")).toBe(false);
  });

  it("rejects adversarial repeated-pi strings in linear time (no catastrophic backtracking)", () => {
    // Previously `/pi.*not (?:found|installed)/i` could explode on long
    // "pi" prefixes. The classifier must stay linear: complete this case as
    // an ordinary assertion rather than a wall-clock threshold.
    const adversarial = `${"pi".repeat(50_000)}x`;
    expect(isPiBinaryMissingError(adversarial)).toBe(false);
    expect(isPiBinaryMissingError(`${adversarial} not found`)).toBe(true);
    expect(isPiBinaryMissingError(`${adversarial} not installed`)).toBe(true);
  });

  it("parses a stable semver without accepting prerelease or partial versions", () => {
    expect(parsePiVersionOutput("pi 0.80.5")).toBe("0.80.5");
    expect(parsePiVersionOutput("pi 0.80.5-beta.1")).toBeNull();
    expect(parsePiVersionOutput("pi 00.80.4")).toBeNull();
    expect(parsePiVersionOutput("not-a-version")).toBeNull();
  });

  it("accepts the supported range and fails closed outside it", () => {
    expect(isSupportedPiVersion("0.80.5")).toBe(true);
    expect(isSupportedPiVersion("0.81.0")).toBe(true);
    // Pi 1.x shares the stable RPC spawn contract, so it must pass the gate.
    expect(isSupportedPiVersion("1.0.0")).toBe(true);
    expect(isSupportedPiVersion("1.2.0")).toBe(true);
    // Only below the floor, prerelease, and unparseable output fail closed.
    expect(isSupportedPiVersion("0.80.4")).toBe(false);
    expect(isSupportedPiVersion(null)).toBe(false);
  });
});
