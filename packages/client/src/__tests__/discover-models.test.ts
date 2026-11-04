import { describe, expect, it } from "vitest";
import { discoverProviderModels } from "../providers/discover-models.js";

describe("discoverProviderModels — grok", () => {
  const modelStateMeta = {
    defaultAuthMethodId: "cached_token",
    agentVersion: "0.2.117",
    modelState: {
      currentModelId: "grok-4",
      availableModels: [
        { modelId: "grok-4", name: "Grok 4", description: "" },
        { modelId: "grok-3-mini", name: "Grok 3 Mini", description: "" },
      ],
    },
  };

  const resolvedOk = { ok: true as const, binary: "/fake/bin/grok", version: "0.2.117" };

  it("returns the provider-cli catalog parsed from the initialize _meta.modelState", async () => {
    const catalog = await discoverProviderModels("grok", {
      now: () => new Date("2026-07-31T00:00:00Z"),
      resolveGrokBinary: () => resolvedOk,
      fetchGrokModelMeta: async () => ({ ok: true as const, meta: modelStateMeta }),
    });
    expect(catalog).toEqual({
      provider: "grok",
      models: [
        { id: "grok-4", label: "Grok 4", isDefault: true, hint: "default" },
        { id: "grok-3-mini", label: "Grok 3 Mini" },
      ],
      defaultModelId: "grok-4",
      fetchedAt: "2026-07-31T00:00:00.000Z",
      source: "provider-cli",
      error: null,
    });
  });

  it("degrades to unavailable when the binary is missing", async () => {
    const catalog = await discoverProviderModels("grok", {
      resolveGrokBinary: () => ({ ok: false as const, error: "grok binary not found on this host", transient: false }),
    });
    expect(catalog.source).toBe("unavailable");
    expect(catalog.models).toEqual([]);
    expect(catalog.error).toContain("not found");
  });

  it("degrades to unavailable when the launch-verified version gate rejects the binary", async () => {
    let spawned = false;
    const catalog = await discoverProviderModels("grok", {
      resolveGrokBinary: () => ({
        ok: false as const,
        error: "resolved grok failed validation: grok 0.1.0 is outside the supported range >=0.2.117 <2.0.0",
        transient: false,
      }),
      fetchGrokModelMeta: async () => {
        spawned = true;
        return { ok: true as const, meta: modelStateMeta };
      },
    });
    expect(catalog.source).toBe("unavailable");
    expect(catalog.error).toContain("supported range");
    // The gated binary must never be spawned for discovery.
    expect(spawned).toBe(false);
  });

  it("degrades to unavailable when the initialize handshake fails", async () => {
    const catalog = await discoverProviderModels("grok", {
      resolveGrokBinary: () => resolvedOk,
      fetchGrokModelMeta: async () => ({ ok: false as const, error: "grok ACP model discovery timed out" }),
    });
    expect(catalog.source).toBe("unavailable");
    expect(catalog.error).toContain("timed out");
  });

  it("degrades to unavailable when the response carries no model state", async () => {
    const catalog = await discoverProviderModels("grok", {
      resolveGrokBinary: () => resolvedOk,
      fetchGrokModelMeta: async () => ({ ok: true as const, meta: null }),
    });
    expect(catalog.source).toBe("unavailable");
    expect(catalog.error).toContain("no model state");
  });
});

describe("discoverProviderModels — antigravity", () => {
  it("returns the provider-cli catalog from agy models", async () => {
    const catalog = await discoverProviderModels("antigravity", {
      now: () => new Date("2026-09-18T00:00:00Z"),
      resolveAntigravityBinary: () => ({ ok: true, binary: "/fake/bin/agy" }),
      runAntigravityModels: async () => ({
        ok: true,
        stdout: "gemini-3.8-flash-high     Gemini 3.8 Flash (High)\n",
        stderr: "",
      }),
    });
    expect(catalog.source).toBe("provider-cli");
    expect(catalog.models).toEqual([{ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" }]);
  });

  it("degrades to unavailable when the binary is missing", async () => {
    const catalog = await discoverProviderModels("antigravity", {
      resolveAntigravityBinary: () => ({ ok: false, error: "no agy binary resolved on this host" }),
    });
    expect(catalog.source).toBe("unavailable");
    expect(catalog.models).toEqual([]);
  });
});
