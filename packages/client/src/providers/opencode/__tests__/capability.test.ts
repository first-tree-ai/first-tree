import { describe, expect, it, vi } from "vitest";
import { probeOpenCodeCapability } from "../capability.js";

describe("OpenCode install-only capability", () => {
  it("reports the exact path without launching or inspecting auth", async () => {
    const findOnPath = vi.fn(() => "/usr/local/bin/opencode");
    await expect(probeOpenCodeCapability({ findOnPath, env: { PATH: "/usr/local/bin" } })).resolves.toMatchObject({
      state: "ok",
      available: true,
      runtimeSource: "path",
      runtimePath: "/usr/local/bin/opencode",
    });
    expect(findOnPath).toHaveBeenCalledTimes(1);
  });

  it("reports a missing external runtime with actionable setup copy", async () => {
    const result = await probeOpenCodeCapability({ findOnPath: () => null, env: {} });
    expect(result).toMatchObject({ state: "missing", available: false });
    expect(result.error).toContain("npm install -g @opencode/cli@^2");
    expect(result.error).toContain("opencode auth login");
  });

  it("does not advertise a resolved Windows binary that the default supervisor rejects", async () => {
    const findOnPath = vi.fn(() => "C:\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe");
    const result = await probeOpenCodeCapability({
      findOnPath,
      env: { PATH: "C:\\npm" },
      platform: "win32",
    });

    expect(result).toMatchObject({
      state: "error",
      available: false,
      runtimeSource: "path",
      runtimePath: "C:\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe",
    });
    expect(result.error).toContain("cannot run it on Windows");
    expect(findOnPath).toHaveBeenCalledTimes(1);
  });
});
