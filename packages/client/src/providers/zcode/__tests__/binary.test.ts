import { describe, expect, it } from "vitest";
import { buildZcodeTurnArgs, inspectZcodeVersion, resolveZcodeRuntimeBinary } from "../binary.js";

const managedRuntime = {
  ok: true as const,
  command: "/node",
  args: ["/managed/zcode.cjs"],
  runtimePath: "/managed/zcode.cjs",
};

const ensureRuntime = async () => managedRuntime;

describe("inspectZcodeVersion", () => {
  it("accepts only the official runtime's exact single-line pin", () => {
    expect(inspectZcodeVersion("0.16.5\n")).toEqual({ ok: true, runtimeVersion: "0.16.5" });
  });

  it("rejects wrapper-style, malformed, and incompatible version output", () => {
    for (const output of ["", "0.16.5\nextra", "zcode 0.16.4"]) {
      const result = inspectZcodeVersion(output);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("expected exactly 0.16.5");
    }
  });
});

describe("resolveZcodeRuntimeBinary", () => {
  it("returns the exact managed command and runtime argv after Node admission", async () => {
    await expect(
      resolveZcodeRuntimeBinary(process.env, {
        ensureRuntime,
        readVersion: async (command, args) => {
          expect([command, ...args, "--version"]).toEqual(["/node", "/managed/zcode.cjs", "--version"]);
          return "0.16.5";
        },
        nodeVersion: () => "22.19.0",
      }),
    ).resolves.toEqual(managedRuntime);
  });

  it("fails closed below the supported Node floor before invoking the runtime", async () => {
    let readCalls = 0;
    const result = await resolveZcodeRuntimeBinary(process.env, {
      ensureRuntime,
      readVersion: async () => {
        readCalls += 1;
        return "0.16.5";
      },
      nodeVersion: () => "22.18.9",
    });
    expect(result).toMatchObject({
      ok: false,
      transient: false,
      error: expect.stringContaining("Node.js 22.19.0+"),
    });
    expect(readCalls).toBe(0);
  });

  it("fails closed when the official runtime answers with the wrong version", async () => {
    const result = await resolveZcodeRuntimeBinary(process.env, {
      ensureRuntime,
      readVersion: async () => "0.16.4",
      nodeVersion: () => "22.19.0",
    });
    expect(result).toMatchObject({ ok: false, transient: false });
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
        prompt: " ",
        mode: "build",
        resumeSessionId: null,
      }),
    ).toThrow("ZCode turn prompt is empty");
  });
});
