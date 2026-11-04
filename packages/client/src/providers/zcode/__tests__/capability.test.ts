import { describe, expect, it, vi } from "vitest";
import { probeZcodeCapability } from "../capability.js";

describe("ZCode install-only capability", () => {
  it("reports the exact path without launching or inspecting auth", async () => {
    const findOnPath = vi.fn(() => "/usr/local/bin/zcode");
    await expect(
      probeZcodeCapability({ findOnPath, env: { PATH: "/usr/local/bin" }, platform: "linux" }),
    ).resolves.toMatchObject({
      state: "ok",
      available: true,
      runtimeSource: "path",
      runtimePath: "/usr/local/bin/zcode",
    });
    expect(findOnPath).toHaveBeenCalledTimes(1);
  });

  it("reports a missing external runtime with actionable setup copy", async () => {
    const result = await probeZcodeCapability({ findOnPath: () => null, env: {}, platform: "linux" });
    expect(result).toMatchObject({ state: "missing", available: false });
    expect(result.error).toContain("zcode.z.ai/install.sh");
    expect(result.error).toContain("zcode login");
  });

  it("fails closed on Windows before any spawn attempt", async () => {
    const findOnPath = vi.fn(() => "C:\\Users\\me\\AppData\\Local\\zcode\\bin\\zcode.exe");
    const result = await probeZcodeCapability({
      findOnPath,
      env: { PATH: "C:\\Users\\me\\AppData\\Local\\zcode\\bin" },
      platform: "win32",
    });

    expect(result).toMatchObject({
      state: "error",
      available: false,
    });
    expect(result.error).toContain("Job Object");
    expect(findOnPath).not.toHaveBeenCalled();
  });

  it("win32 missing binary also fails closed without the installer invite", async () => {
    const findOnPath = vi.fn(() => null);
    const result = await probeZcodeCapability({ findOnPath, env: {}, platform: "win32" });
    expect(result).toMatchObject({ state: "error", available: false });
    expect(result.error).toContain("Job Object");
    expect(result.error).not.toContain("install.sh");
    expect(findOnPath).not.toHaveBeenCalled();
  });
});
