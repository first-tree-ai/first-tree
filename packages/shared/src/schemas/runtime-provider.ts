import { z } from "zod";

/**
 * Zod is the source of truth for known runtime-provider wire IDs.
 * Catalog keys, client composition tables, and named constants all derive from
 * this schema so a new provider cannot drift across packages.
 *
 * Wire compatibility: unknown provider *strings* may still appear on rolling
 * capability maps (`Record<string, …>`); execution paths must narrow with
 * {@link asRuntimeProvider} / {@link runtimeProviderSchema} before dispatch.
 */
export const runtimeProviderSchema = z.enum([
  "amp",
  "deepseek-harness",
  "claude-code",
  "claude-code-tui",
  "codex",
  "cursor",
  "grok",
  "antigravity",
  "kimi-code",
  "opencode",
  "pi",
  "zcode",
]);

export type RuntimeProvider = z.infer<typeof runtimeProviderSchema>;

/** Exhaustive ID list derived from the Zod enum (same order as schema options). */
export const RUNTIME_PROVIDER_IDS: readonly RuntimeProvider[] = runtimeProviderSchema.options;

/** `claude-code` → `CLAUDE_CODE` (kebab wire id → UPPER_SNAKE named constant key). */
type KebabToConstKey<S extends string> = S extends `${infer Head}-${infer Tail}`
  ? `${Uppercase<Head>}_${KebabToConstKey<Tail>}`
  : Uppercase<S>;

/**
 * Named-constant map shape derived from {@link RuntimeProvider}.
 * Call sites keep `RUNTIME_PROVIDERS.CLAUDE_CODE` / `.CODEX` — keys are not handwritten.
 */
export type RuntimeProvidersMap = {
  readonly [K in RuntimeProvider as KebabToConstKey<K>]: K;
};

/**
 * Build {@link RUNTIME_PROVIDERS} from {@link runtimeProviderSchema.options}.
 * Fail closed on illegal keys or collisions so a new schema id cannot silently
 * overwrite another constant.
 */
function buildRuntimeProviders(): RuntimeProvidersMap {
  const entries: Array<[string, RuntimeProvider]> = [];
  const seenKeys = new Set<string>();
  for (const id of RUNTIME_PROVIDER_IDS) {
    const key = id.replace(/-/g, "_").toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new Error(`runtime provider id "${id}" does not map to a valid RUNTIME_PROVIDERS key`);
    }
    if (seenKeys.has(key)) {
      throw new Error(`RUNTIME_PROVIDERS key collision for "${key}" (from "${id}")`);
    }
    seenKeys.add(key);
    entries.push([key, id]);
  }
  // Object.fromEntries widens keys to `string`; freeze + cast once at this bridge.
  return Object.freeze(Object.fromEntries(entries)) as RuntimeProvidersMap;
}

/**
 * Named constants for call sites that prefer `RUNTIME_PROVIDERS.CODEX` over
 * string literals. Values / keys are generated from {@link runtimeProviderSchema}
 * — never a second handwritten wire-id list.
 */
export const RUNTIME_PROVIDERS: RuntimeProvidersMap = buildRuntimeProviders();

export const DEFAULT_RUNTIME_PROVIDER: RuntimeProvider = "claude-code";

/**
 * Runtime providers temporarily disabled platform-wide. A disabled provider is
 * filtered out of UI runtime selection (creating agents, onboarding, the client
 * setup/ready cards) and skipped by the client capability probe, so it is
 * neither offered to users nor advertised / re-probed by the daemon. The
 * provider stays a valid `RuntimeProvider` so already-bound agents keep their
 * label and continue to run — this only hides it from new selection + detection.
 *
 * Empty = nothing disabled. To re-enable a provider, remove it from this list
 * (single-line revert).
 */
export const DISABLED_RUNTIME_PROVIDERS: readonly RuntimeProvider[] = [
  "claude-code-tui",
  // Antigravity is implemented and deterministic-testable, but remains gated
  // behind isolated provider-owned live QA and human security/supply-chain
  // acceptance. Hide new selection and daemon advertising until that gate
  // passes; a QA branch can remove this one entry without changing schemas.
  "antigravity",
];

/** True when `provider` is not temporarily disabled (see {@link DISABLED_RUNTIME_PROVIDERS}). */
export function isRuntimeProviderEnabled(provider: string): boolean {
  return !DISABLED_RUNTIME_PROVIDERS.some((p) => p === provider);
}

/** Narrow a wire string to a known {@link RuntimeProvider}, or `null`. */
export function asRuntimeProvider(provider: string): RuntimeProvider | null {
  const parsed = runtimeProviderSchema.safeParse(provider);
  return parsed.success ? parsed.data : null;
}

/**
 * Build a complete `Record<RuntimeProvider, V>` from an exhaustive entry list.
 *
 * `Object.fromEntries` widens keys to `string` in TypeScript's standard library
 * even when every {@link RuntimeProvider} key is present at runtime. Callers
 * must pass exactly one entry per {@link RUNTIME_PROVIDER_IDS} member; we check
 * that length and then assert the record type once here so shared/web surfaces
 * do not each carry their own cast.
 */
export function recordByRuntimeProvider<V>(
  entries: ReadonlyArray<readonly [RuntimeProvider, V]>,
): Readonly<Record<RuntimeProvider, V>> {
  if (entries.length !== RUNTIME_PROVIDER_IDS.length) {
    throw new Error(`recordByRuntimeProvider: expected ${RUNTIME_PROVIDER_IDS.length} entries, got ${entries.length}`);
  }
  const keys = new Set(entries.map(([id]) => id));
  for (const id of RUNTIME_PROVIDER_IDS) {
    if (!keys.has(id)) {
      throw new Error(`recordByRuntimeProvider: missing provider "${id}"`);
    }
  }
  return Object.fromEntries(entries) as Record<RuntimeProvider, V>;
}
