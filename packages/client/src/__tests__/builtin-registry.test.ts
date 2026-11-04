import { RUNTIME_PROVIDER_IDS } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { BUILTIN_PROVIDER_PROBES } from "../providers/builtin-probes.js";
import { createBuiltinHandlerRegistry } from "../providers/builtin-registry.js";
import { probeCapabilities } from "../providers/capabilities/index.js";
import { PROVIDER_SKILL_ROOTS } from "../providers/skill-roots.js";
import type { HandlerConfig } from "../runtime/handler.js";
import { providerSkillRoot } from "../runtime/managed-skills.js";

vi.mock("../providers/zcode/capability.js", () => ({
  probeZcodeCapability: vi.fn(async () => ({
    state: "missing",
    available: false,
    error: "mocked official-runtime probe",
    detectedAt: new Date().toISOString(),
    latencyMs: 0,
  })),
}));

const HANDLER_METHODS = ["start", "resume", "inject", "suspend", "shutdown"] as const;

describe("builtin handler registry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("freezes exhaustive composition tables and shares skill-root keys", () => {
    const registry = createBuiltinHandlerRegistry({
      resolveExecutable: () => ({ path: undefined, source: "default" }),
    });

    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(BUILTIN_PROVIDER_PROBES)).toBe(true);
    expect(Object.isFrozen(PROVIDER_SKILL_ROOTS)).toBe(true);

    expect(Object.keys(registry).sort()).toEqual([...RUNTIME_PROVIDER_IDS].sort());
    expect(Object.keys(BUILTIN_PROVIDER_PROBES).sort()).toEqual([...RUNTIME_PROVIDER_IDS].sort());
    expect(Object.keys(PROVIDER_SKILL_ROOTS).sort()).toEqual([...RUNTIME_PROVIDER_IDS].sort());
    for (const id of RUNTIME_PROVIDER_IDS) {
      expect(typeof registry[id]).toBe("function");
      expect(providerSkillRoot(id, PROVIDER_SKILL_ROOTS)).toBe(PROVIDER_SKILL_ROOTS[id]);
      expect(typeof BUILTIN_PROVIDER_PROBES[id]).toBe("function");
    }
  });

  it("returns factories with the full session lifecycle shape", () => {
    const registry = createBuiltinHandlerRegistry({
      resolveExecutable: () => ({ path: undefined, source: "default" }),
    });

    for (const id of RUNTIME_PROVIDER_IDS) {
      const handler = registry[id]({ workspaceRoot: "/tmp/registry-test", runtimeProvider: id });
      for (const method of HANDLER_METHODS) {
        expect(typeof handler[method]).toBe("function");
      }
    }
  });

  it("binds independent registry instances to distinct Claude closures", () => {
    const a = createBuiltinHandlerRegistry({
      resolveExecutable: () => ({ path: "/tmp/claude-a", source: "env" }),
    });
    const b = createBuiltinHandlerRegistry({
      resolveExecutable: () => ({ path: "/tmp/claude-b", source: "env" }),
    });

    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(b)).toBe(true);
    expect(a["claude-code"]).not.toBe(b["claude-code"]);
  });

  it("probeCapabilities accepts an explicit probe table without a handler registry", async () => {
    const customProbe = vi.fn().mockResolvedValue({
      state: "ok",
      available: true,
      sdkVersion: null,
      detectedAt: new Date().toISOString(),
      latencyMs: 1,
    });
    const probes = { ...BUILTIN_PROVIDER_PROBES, codex: customProbe };

    await probeCapabilities({ probes });
    expect(customProbe).toHaveBeenCalled();
    expect(BUILTIN_PROVIDER_PROBES.codex).not.toBe(customProbe);
    expect(Object.isFrozen(BUILTIN_PROVIDER_PROBES)).toBe(true);
  });

  it("composition root is createBuiltinHandlerRegistry only — no process-global install path", async () => {
    const registry = await import("../providers/builtin-registry.js");
    expect(typeof registry.createBuiltinHandlerRegistry).toBe("function");
    expect(typeof registry.resolveAndLogClaudeExecutable).toBe("function");
    expect(registry).not.toHaveProperty("registerBuiltinHandlers");
    expect(registry).not.toHaveProperty("createBuiltinProviderRegistry");

    const handlerSource = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../runtime/handler.ts", import.meta.url), "utf8"),
    );
    expect(handlerSource).not.toMatch(/\bHANDLER_REGISTRY\b/);
    expect(handlerSource).not.toMatch(/\bregisterHandler\b/);
    expect(handlerSource).not.toMatch(/\bgetHandlerFactory\b/);
    expect(handlerSource).not.toMatch(/\bhasHandler\b/);

    const runtimeSource = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../runtime/runtime.ts", import.meta.url), "utf8"),
    );
    expect(runtimeSource).toContain("handlerFactories");
    expect(runtimeSource).not.toContain("installHandlers");
  });
});

describe("builtin handler factories fail closed on runtimeProvider", () => {
  function factories() {
    return createBuiltinHandlerRegistry({
      resolveExecutable: () => ({ path: undefined, source: "default" }),
    });
  }

  function config(overrides: Record<string, unknown>): HandlerConfig {
    return { workspaceRoot: "/tmp/registry-fail-closed", ...overrides } as HandlerConfig;
  }

  for (const id of RUNTIME_PROVIDER_IDS) {
    it(`${id} rejects a missing runtimeProvider at construction`, () => {
      expect(() => factories()[id](config({}))).toThrow(ZodError);
    });

    it(`${id} rejects an invalid runtimeProvider at construction`, () => {
      expect(() => factories()[id](config({ runtimeProvider: "not-a-provider" }))).toThrow(ZodError);
    });
  }

  // Codex selects between app-server and SDK implementations; every engine must
  // reject the same bad config so validation is not path-dependent.
  for (const codexHandlerEngine of ["app-server", "sdk", "auto"] as const) {
    it(`codex ${codexHandlerEngine} engine rejects an invalid runtimeProvider`, () => {
      expect(() => factories().codex(config({ runtimeProvider: "not-a-provider", codexHandlerEngine }))).toThrow(
        ZodError,
      );
    });

    it(`codex ${codexHandlerEngine} engine rejects a missing runtimeProvider`, () => {
      expect(() => factories().codex(config({ codexHandlerEngine }))).toThrow(ZodError);
    });
  }
});
