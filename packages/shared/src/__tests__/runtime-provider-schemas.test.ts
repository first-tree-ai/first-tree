import { describe, expect, it } from "vitest";
import {
  CAPABILITY_STATES,
  capabilityEntrySchema,
  clientCapabilitiesSchema,
  DEFAULT_RUNTIME_PROVIDER,
  isRuntimeProviderEnabled,
  RUNTIME_PROVIDER_IDS,
  RUNTIME_PROVIDERS,
  runtimeProviderSchema,
  updateClientCapabilitiesSchema,
} from "../index.js";

/**
 * Lock the public surface of the two new schemas added in 0026:
 *   - `runtimeProviderSchema` is the discriminator everything else keys off
 *     (agent rows, payload kind, capability map). A typo in the enum here
 *     would let invalid runtime ids drift into the DB.
 *   - `capabilityEntrySchema` and `clientCapabilitiesSchema` define the
 *     wire format of the `PATCH /clients/:id/capabilities` upload — pinned
 *     here so a server change can't silently relax validation.
 */
describe("runtimeProviderSchema", () => {
  it("accepts all built-in providers from RUNTIME_PROVIDER_IDS", () => {
    for (const id of RUNTIME_PROVIDER_IDS) {
      expect(runtimeProviderSchema.parse(id)).toBe(id);
    }
  });

  it("rejects unknown providers", () => {
    expect(() => runtimeProviderSchema.parse("gemini")).toThrow();
    expect(() => runtimeProviderSchema.parse("")).toThrow();
  });

  it("RUNTIME_PROVIDERS is generated from schema options (frozen, no parallel list)", () => {
    expect(Object.isFrozen(RUNTIME_PROVIDERS)).toBe(true);
    expect(Object.values(RUNTIME_PROVIDERS).sort()).toEqual([...RUNTIME_PROVIDER_IDS].sort());
    for (const id of RUNTIME_PROVIDER_IDS) {
      const key = id.replace(/-/g, "_").toUpperCase() as keyof typeof RUNTIME_PROVIDERS;
      expect(RUNTIME_PROVIDERS[key]).toBe(id);
      expect(runtimeProviderSchema.parse(RUNTIME_PROVIDERS[key])).toBe(id);
    }
    // Published shape still resolves named constants for call sites.
    expect(RUNTIME_PROVIDERS.CLAUDE_CODE).toBe("claude-code");
    expect(RUNTIME_PROVIDERS.CODEX).toBe("codex");
  });

  it("DEFAULT_RUNTIME_PROVIDER is claude-code (existing rows pre-0026 have no kind)", () => {
    expect(DEFAULT_RUNTIME_PROVIDER).toBe("claude-code");
  });

  it("marks temporarily disabled providers as unavailable for selection", () => {
    expect(isRuntimeProviderEnabled("claude-code")).toBe(true);
    expect(isRuntimeProviderEnabled("codex")).toBe(true);
    expect(isRuntimeProviderEnabled("cursor")).toBe(true);
    expect(isRuntimeProviderEnabled("grok")).toBe(true);
    // Pending isolated provider-owned live QA and human acceptance.
    expect(isRuntimeProviderEnabled("antigravity")).toBe(false);
    expect(isRuntimeProviderEnabled("kimi-code")).toBe(true);
    expect(isRuntimeProviderEnabled("opencode")).toBe(true);
    expect(isRuntimeProviderEnabled("pi")).toBe(true);
    expect(isRuntimeProviderEnabled("claude-code-tui")).toBe(false);
    expect(isRuntimeProviderEnabled("future-provider")).toBe(true);
  });
});

describe("capabilityEntrySchema", () => {
  it("CAPABILITY_STATES enumerates the three documented states", () => {
    expect(Object.values(CAPABILITY_STATES).sort()).toEqual(["error", "missing", "ok"].sort());
  });

  it("accepts a fully-formed `ok` entry", () => {
    const parsed = capabilityEntrySchema.parse({
      state: "ok",
      available: true,
      sdkVersion: "0.2.84",
      runtimeSource: "path",
      runtimePath: "/usr/local/bin/codex",
      detectedAt: new Date().toISOString(),
    });
    expect(parsed.state).toBe("ok");
    expect(parsed.sdkVersion).toBe("0.2.84");
    expect(parsed.runtimeSource).toBe("path");
    expect(parsed.runtimePath).toBe("/usr/local/bin/codex");
  });

  it("accepts `missing` with null sdkVersion", () => {
    const parsed = capabilityEntrySchema.parse({
      state: "missing",
      available: false,
      sdkVersion: null,
      detectedAt: new Date().toISOString(),
    });
    expect(parsed.state).toBe("missing");
    expect(parsed.sdkVersion).toBeNull();
  });

  it("rejects an invalid state value", () => {
    expect(() =>
      capabilityEntrySchema.parse({
        state: "pending",
        available: true,
        detectedAt: new Date().toISOString(),
      }),
    ).toThrow();
  });
  // Dropped "rejects an invalid authMethod value": authMethod was removed from
  // the capability schema (detection is install-only, no auth probe).
});

describe("capabilityEntrySchema — canonical wire shape", () => {
  it("rejects the retired `unauthenticated` state", () => {
    expect(() =>
      capabilityEntrySchema.parse({
        state: "unauthenticated",
        available: true,
        detectedAt: new Date().toISOString(),
      }),
    ).toThrow();
  });

  it("ignores obsolete extra auth fields", () => {
    const parsed = capabilityEntrySchema.parse({
      state: "ok",
      available: true,
      authenticated: true,
      authMethod: "oauth",
      detectedAt: new Date().toISOString(),
    });
    expect(parsed).not.toHaveProperty("authenticated");
    expect(parsed).not.toHaveProperty("authMethod");
  });

  it("round-trips the canonical state shape", () => {
    const parsed = capabilityEntrySchema.parse({
      state: "ok",
      available: true,
      detectedAt: new Date().toISOString(),
    });
    expect(parsed).toMatchObject({ state: "ok", available: true });
  });
});

describe("clientCapabilitiesSchema + updateClientCapabilitiesSchema", () => {
  it("accepts a record keyed by arbitrary provider strings (forwards-compat)", () => {
    // Schema-level: the record key is `z.string()` so future providers don't
    // require a server schema bump; the *server* layer separately constrains
    // capability lookups to known RuntimeProvider keys.
    const parsed = clientCapabilitiesSchema.parse({
      "claude-code": {
        state: "ok",
        available: true,
        sdkVersion: "0.2.84",
        detectedAt: new Date().toISOString(),
      },
      "future-provider": {
        state: "missing",
        available: false,
        sdkVersion: null,
        detectedAt: new Date().toISOString(),
      },
    });
    expect(Object.keys(parsed)).toContain("future-provider");
  });

  it("updateClientCapabilitiesSchema requires top-level `capabilities` field", () => {
    expect(() => updateClientCapabilitiesSchema.parse({})).toThrow();
    expect(() => updateClientCapabilitiesSchema.parse({ capabilities: {} })).not.toThrow();
  });

  it("rejects malformed entries inside the capabilities map", () => {
    expect(() =>
      updateClientCapabilitiesSchema.parse({
        capabilities: {
          "claude-code": { state: "broken" }, // <- missing required fields, invalid state
        },
      }),
    ).toThrow();
  });
});
