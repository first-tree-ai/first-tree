import type { ProviderModelCatalog, RuntimeProvider } from "@first-tree/shared";
import {
  type CursorDiscoverModelsDeps,
  discoverCursorModels,
  parseCursorModelsOutput,
} from "./cursor/discover-models.js";
import { discoverGrokModels, type GrokDiscoverModelsDeps } from "./grok/discover-models.js";
import {
  discoverKimiModels,
  type KimiDiscoverModelsDeps,
  parseKimiConfigModels,
  resolveKimiConfigPath,
} from "./kimi-code/discover-models.js";

/**
 * Composition-owned model discovery deps. Cursor/Kimi/Grok discovery live in
 * their provider families. This module is the only place that wires concrete
 * provider discovery into a single dispatcher — Runtime must not reverse-import
 * those families.
 */
export type HostDiscoverModelsDeps = CursorDiscoverModelsDeps & KimiDiscoverModelsDeps;
export type DiscoverModelsDeps = HostDiscoverModelsDeps & GrokDiscoverModelsDeps;

export type { CursorDiscoverModelsDeps, GrokDiscoverModelsDeps, KimiDiscoverModelsDeps };
export { parseCursorModelsOutput, parseKimiConfigModels, resolveKimiConfigPath };

function fetchedAt(deps: { now?: () => Date }): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}

export function unavailableCatalog(
  provider: RuntimeProvider,
  error: string,
  deps: { now?: () => Date },
): ProviderModelCatalog {
  return {
    provider,
    models: [],
    defaultModelId: null,
    fetchedAt: fetchedAt(deps),
    source: "unavailable",
    error,
  };
}

/**
 * Discover the model catalog for a runtime provider from the host-local
 * provider. Phase 1 implements Cursor + Kimi + Grok; other providers return
 * `source: "unavailable"` so the web can keep its curated/fallback UI.
 */
export async function discoverProviderModels(
  provider: RuntimeProvider,
  deps: DiscoverModelsDeps = {},
): Promise<ProviderModelCatalog> {
  switch (provider) {
    case "cursor":
      return discoverCursorModels(deps);
    case "grok":
      return discoverGrokModels(deps);
    case "antigravity":
      return unavailableCatalog(
        provider,
        "Antigravity model discovery is not enabled in V1; enter the provider-native model slug",
        deps,
      );
    case "kimi-code":
      return discoverKimiModels(deps);
    case "amp":
      return unavailableCatalog(
        provider,
        "Amp exposes modes, not a host-local model catalog; pick a mode in agent config",
        deps,
      );
    case "deepseek-harness":
      return unavailableCatalog(
        provider,
        "DeepSeek model discovery is not enabled in V1; enter the provider-native model id",
        deps,
      );
    case "opencode":
      return unavailableCatalog(
        provider,
        "OpenCode model discovery is not enabled in V1; enter the provider-native provider/model id",
        deps,
      );
    case "pi":
      return unavailableCatalog(
        provider,
        "Pi model discovery is not enabled in V1; enter the provider-native provider/model id",
        deps,
      );
    case "claude-code":
    case "claude-code-tui":
    case "codex":
      return unavailableCatalog(provider, `Host-local model discovery for ${provider} lands in a later phase`, deps);
    default: {
      const _exhaustive: never = provider;
      return unavailableCatalog(_exhaustive, `Unknown provider: ${String(provider)}`, deps);
    }
  }
}
