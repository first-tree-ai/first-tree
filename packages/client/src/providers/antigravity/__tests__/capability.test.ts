import { describe, expect, it, vi } from "vitest";
import { ANTIGRAVITY_INSTALL_COMMAND } from "../binary.js";
import { probeAntigravityCapability } from "../capability.js";

describe("probeAntigravityCapability — install-only detection", () => {
  it("reports a resolved binary without launching or authenticating", async () => {
    const findOnPath = vi.fn(() => "/home/operator/.local/bin/agy");
    const entry = await probeAntigravityCapability({ findOnPath });
    expect(entry).toMatchObject({
      state: "ok",
      available: true,
      runtimeSource: "path",
      runtimePath: "/home/operator/.local/bin/agy",
    });
    expect(findOnPath).toHaveBeenCalledTimes(1);
  });

  it("reports a missing CLI with the official installer", async () => {
    const entry = await probeAntigravityCapability({ findOnPath: () => null });
    expect(entry).toMatchObject({ state: "missing", available: false });
    expect(entry.error).toContain(ANTIGRAVITY_INSTALL_COMMAND);
  });

  it("fails closed on Windows before consulting PATH", async () => {
    const findOnPath = vi.fn(() => "/fake/agy.exe");
    const entry = await probeAntigravityCapability({ platform: "win32", findOnPath });
    expect(entry).toMatchObject({ state: "error", available: false });
    expect(entry.error).toContain("not supported on Windows in v1");
    expect(findOnPath).not.toHaveBeenCalled();
  });

  it("contains resolver failures as error capability entries", async () => {
    const entry = await probeAntigravityCapability({
      findOnPath: () => {
        throw new Error("resolver exploded");
      },
    });
    expect(entry).toMatchObject({ state: "error", available: false, error: "resolver exploded" });
  });
});
