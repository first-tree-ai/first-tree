import { describe, expect, it } from "vitest";
import { probeZcodeCapability } from "../capability.js";

function managedResolution(runtimePath = "/managed/zcode.cjs", _version = "0.16.5") {
  return {
    ok: true as const,
    command: "/node",
    args: [runtimePath],
    runtimePath,
  };
}

function probeDeps(runtimePath = "/managed/zcode.cjs", _version = "0.16.5") {
  return {
    resolutionDeps: {
      ensureRuntime: async () => managedResolution(runtimePath),
      readVersion: async () => _version,
      nodeVersion: () => "22.19.0",
    },
  };
}

describe("probeZcodeCapability", () => {
  it("reports the exact managed runtime it will launch without inspecting credentials", async () => {
    await expect(probeZcodeCapability(probeDeps())).resolves.toMatchObject({
      state: "ok",
      available: true,
      runtimeSource: "path",
      runtimePath: "/managed/zcode.cjs",
    });
  });

  it("fails closed when the managed runtime version is not the exact official pin", async () => {
    const result = await probeZcodeCapability(probeDeps("/managed/zcode.cjs", "0.16.4"));
    expect(result.available).toBe(false);
    expect(result.state).toBe("missing");
    expect(result.error).toContain("official runtime is not ready");
  });

  it("fails closed below the supported Node floor", async () => {
    const result = await probeZcodeCapability({
      resolutionDeps: {
        ensureRuntime: async () => managedResolution(),
        readVersion: async () => "0.16.5",
        nodeVersion: () => "22.13.0",
      },
    });
    expect(result.available).toBe(false);
    expect(result.state).toBe("missing");
    expect(result.error).toContain("Node.js 22.19.0+");
  });

  it("reports extraction failure as a permanent setup error", async () => {
    const result = await probeZcodeCapability({
      resolutionDeps: {
        ensureRuntime: async () => ({
          ok: false as const,
          transient: false as const,
          error: "artifact SHA-256 mismatch",
        }),
        readVersion: async () => "0.16.5",
        nodeVersion: () => "22.19.0",
      },
    });
    expect(result.available).toBe(false);
    expect(result.state).toBe("missing");
    expect(result.error).toContain("artifact SHA-256 mismatch");
  });

  it("fails closed on Windows before any artifact admission or spawn", async () => {
    let resolverCalls = 0;
    const result = await probeZcodeCapability({
      platform: "win32",
      resolutionDeps: {
        ensureRuntime: async () => {
          resolverCalls += 1;
          return managedResolution();
        },
        readVersion: async () => "0.16.5",
        nodeVersion: () => "22.19.0",
      },
    });
    expect(result.available).toBe(false);
    expect(result.state).toBe("error");
    expect(result.error).toContain("Job Object");
    expect(resolverCalls).toBe(0);
  });

  it("fails closed on an unsupported managed artifact platform", async () => {
    const result = await probeZcodeCapability({
      platform: "darwin",
      resolutionDeps: {
        ensureRuntime: async () => ({
          ok: false as const,
          transient: false as const,
          error: "First Tree's managed ZCode runtime is pinned to linux-x64; this host is darwin-arm64",
        }),
        readVersion: async () => "0.16.5",
        nodeVersion: () => "22.19.0",
      },
    });
    expect(result.available).toBe(false);
    expect(result.state).toBe("missing");
    expect(result.error).toContain("linux-x64");
  });
});
