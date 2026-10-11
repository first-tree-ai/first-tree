import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANTIGRAVITY_MODELS_BUDGET_MS,
  discoverAntigravityModels,
  parseAntigravityModelsOutput,
} from "../discover-models.js";

/** Mirrors `DEFAULT_CLIENT_REPLY_TIMEOUT_MS` on the model-catalog waiter. */
const SERVER_CATALOG_DEADLINE_MS = 25_000;

afterEach(() => {
  vi.useRealTimers();
});

describe("parseAntigravityModelsOutput", () => {
  it("parses documented slug/label rows", () => {
    const parsed = parseAntigravityModelsOutput(`gemini-3.8-flash-high     Gemini 3.8 Flash (High)
gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)
claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)
`);
    expect(parsed.defaultModelId).toBeNull();
    expect(parsed.models).toEqual([
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
    ]);
  });

  it("parses JSON catalogs and marks the default", () => {
    const parsed = parseAntigravityModelsOutput(
      JSON.stringify({
        defaultModelId: "gemini-3.8-flash-medium",
        models: [
          { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
          { slug: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium)", default: true },
        ],
      }),
    );
    expect(parsed.defaultModelId).toBe("gemini-3.8-flash-medium");
    expect(parsed.models).toEqual([
      { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
      {
        id: "gemini-3.8-flash-medium",
        label: "Gemini 3.8 Flash (Medium)",
        isDefault: true,
        hint: "default",
      },
    ]);
  });
});

describe("discoverAntigravityModels", () => {
  it("returns the provider-cli catalog from agy models", async () => {
    const catalog = await discoverAntigravityModels({
      now: () => new Date("2026-09-18T00:00:00Z"),
      resolveAntigravityBinary: () => ({ ok: true, binary: "/fake/bin/agy" }),
      runAntigravityModels: async () => ({
        ok: true,
        stdout: "gemini-3.8-flash-high     Gemini 3.8 Flash (High)\n",
        stderr: "",
      }),
    });
    expect(catalog).toEqual({
      provider: "antigravity",
      models: [{ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" }],
      defaultModelId: null,
      fetchedAt: "2026-09-18T00:00:00.000Z",
      source: "provider-cli",
      error: null,
    });
  });

  it("degrades to unavailable when the binary is missing", async () => {
    const catalog = await discoverAntigravityModels({
      resolveAntigravityBinary: () => ({ ok: false, error: "no agy binary resolved on this host" }),
    });
    expect(catalog.source).toBe("unavailable");
    expect(catalog.models).toEqual([]);
    expect(catalog.error).toContain("no agy binary");
  });

  it("degrades to unavailable when agy models returns no rows", async () => {
    const catalog = await discoverAntigravityModels({
      resolveAntigravityBinary: () => ({ ok: true, binary: "/fake/bin/agy" }),
      runAntigravityModels: async () => ({ ok: true, stdout: "Available models\n", stderr: "" }),
    });
    expect(catalog.source).toBe("unavailable");
    expect(catalog.error).toContain("no parseable model rows");
  });

  it("does not start a text fallback after JSON spends the shared budget", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const calls: string[][] = [];
    const catalogPromise = discoverAntigravityModels({
      resolveAntigravityBinary: () => ({ ok: true, binary: "/fake/bin/agy" }),
      runAntigravityModelsCommand: async (_bin, args, opts) => {
        calls.push([...args]);
        expect(opts.timeoutMs).toBe(ANTIGRAVITY_MODELS_BUDGET_MS);
        await vi.advanceTimersByTimeAsync(ANTIGRAVITY_MODELS_BUDGET_MS);
        return {
          ok: false,
          stdout: "",
          stderr: "json timed out",
          timedOut: true,
          durationMs: ANTIGRAVITY_MODELS_BUDGET_MS,
        };
      },
    });
    const catalog = await catalogPromise;
    expect(calls).toEqual([["models", "--output-format", "json"]]);
    expect(catalog.source).toBe("unavailable");
    expect(catalog.models).toEqual([]);
    expect(Date.now() - started).toBeLessThan(SERVER_CATALOG_DEADLINE_MS);
  });

  it("keeps an immediate JSON rejection plus text lookup inside the server catalog deadline", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const catalogPromise = discoverAntigravityModels({
      resolveAntigravityBinary: () => ({ ok: true, binary: "/fake/bin/agy" }),
      runAntigravityModelsCommand: async (_bin, args, opts) => {
        if (args.includes("--output-format")) {
          expect(opts.timeoutMs).toBe(ANTIGRAVITY_MODELS_BUDGET_MS);
          return { ok: false, stdout: "", stderr: "unknown flag", timedOut: false, durationMs: 0 };
        }
        expect(opts.timeoutMs).toBe(ANTIGRAVITY_MODELS_BUDGET_MS);
        await vi.advanceTimersByTimeAsync(6_000);
        return {
          ok: true,
          stdout: "gemini-3.8-flash-high     Gemini 3.8 Flash (High)\n",
          stderr: "",
          timedOut: false,
          durationMs: 6_000,
        };
      },
    });
    const catalog = await catalogPromise;
    expect(Date.now() - started).toBe(6_000);
    expect(Date.now() - started).toBeLessThan(SERVER_CATALOG_DEADLINE_MS);
    expect(catalog.source).toBe("provider-cli");
    expect(catalog.models).toEqual([{ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" }]);
  });

  it("gives the text fallback only the remaining shared budget", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const timeouts: number[] = [];
    const catalogPromise = discoverAntigravityModels({
      resolveAntigravityBinary: () => ({ ok: true, binary: "/fake/bin/agy" }),
      runAntigravityModelsCommand: async (_bin, args, opts) => {
        timeouts.push(opts.timeoutMs);
        if (args.includes("--output-format")) {
          await vi.advanceTimersByTimeAsync(5_000);
          return { ok: false, stdout: "{}", stderr: "", timedOut: false, durationMs: 5_000 };
        }
        await vi.advanceTimersByTimeAsync(6_000);
        return {
          ok: true,
          stdout: "gemini-3.8-flash-high     Gemini 3.8 Flash (High)\n",
          stderr: "",
          timedOut: false,
          durationMs: 6_000,
        };
      },
    });
    const catalog = await catalogPromise;
    expect(timeouts).toEqual([ANTIGRAVITY_MODELS_BUDGET_MS, ANTIGRAVITY_MODELS_BUDGET_MS - 5_000]);
    expect(Date.now() - started).toBe(11_000);
    expect(Date.now() - started).toBeLessThan(SERVER_CATALOG_DEADLINE_MS);
    expect(catalog.source).toBe("provider-cli");
  });
});
