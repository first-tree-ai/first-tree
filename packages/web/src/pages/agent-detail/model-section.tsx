import type { ProviderModelCatalog, RuntimeProvider } from "@first-tree/shared";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { getProviderModels } from "../../api/provider-models.js";
import { Input } from "../../components/ui/input.js";
import { Select, type SelectOption } from "../../components/ui/select.js";
import { ConfigRow } from "./flat-section.js";

/**
 * Model — an inline dropdown. Selecting a value saves it immediately (onChange),
 * consistent with every other control on the page; there is no draft / Save Bar.
 *
 * The option list comes from the agent's bound computer: the daemon discovers
 * the real provider's models on demand (see `getProviderModels`) and the picker
 * renders that catalog. Two fallbacks are always available:
 *   1. `(unset — inherits local)` — save no model and inherit the provider's
 *      local default configuration.
 *   2. A custom exact model id — via "Custom model id…" in the list.
 * Loading / unavailable discovery must keep both of those controls usable for
 * Cursor/Kimi; Claude/Codex keep their curated Select on the same path.
 */

export type ModelOption = SelectOption;

export const CLAUDE_MODEL_OPTIONS: ModelOption[] = [
  // Full id rather than the `fable` alias: older Claude Code builds don't know
  // the alias, but pass unknown full ids through to the API, where
  // `claude-fable-5` resolves natively.
  { value: "claude-fable-5", label: "fable", hint: "most powerful" },
  { value: "opus", label: "opus", hint: "most capable" },
  { value: "sonnet", label: "sonnet", hint: "balanced" },
  { value: "haiku", label: "haiku", hint: "fastest" },
];

/**
 * Curated Codex model ids exposed by the picker. Keep this as an enum-style
 * `as const` object (rather than a TypeScript enum) so option values stay
 * literal-typed and easy to reuse in Zod-compatible code. Runtime config still
 * accepts arbitrary strings: account access differs and newer model ids must
 * remain usable before this picker is refreshed.
 *
 * Fallback only: when the bound computer's daemon reports a Codex catalog the
 * picker renders that instead of this static list.
 */
export const CODEX_MODEL_IDS = {
  GPT_5_6_SOL: "gpt-5.6-sol",
  GPT_5_6_TERRA: "gpt-5.6-terra",
  GPT_5_6_LUNA: "gpt-5.6-luna",
  GPT_5_5: "gpt-5.5",
  GPT_5_4: "gpt-5.4",
  GPT_5_4_MINI: "gpt-5.4-mini",
  GPT_5_3_CODEX: "gpt-5.3-codex",
  GPT_5_2: "gpt-5.2",
} as const;

export type CodexModelId = (typeof CODEX_MODEL_IDS)[keyof typeof CODEX_MODEL_IDS];

export const CODEX_MODEL_OPTIONS: Array<ModelOption & { value: CodexModelId }> = [
  { value: CODEX_MODEL_IDS.GPT_5_6_SOL, label: CODEX_MODEL_IDS.GPT_5_6_SOL, hint: "flagship" },
  { value: CODEX_MODEL_IDS.GPT_5_6_TERRA, label: CODEX_MODEL_IDS.GPT_5_6_TERRA, hint: "balanced" },
  { value: CODEX_MODEL_IDS.GPT_5_6_LUNA, label: CODEX_MODEL_IDS.GPT_5_6_LUNA, hint: "fastest" },
  { value: CODEX_MODEL_IDS.GPT_5_5, label: CODEX_MODEL_IDS.GPT_5_5 },
  { value: CODEX_MODEL_IDS.GPT_5_4, label: CODEX_MODEL_IDS.GPT_5_4 },
  { value: CODEX_MODEL_IDS.GPT_5_4_MINI, label: CODEX_MODEL_IDS.GPT_5_4_MINI },
  {
    value: CODEX_MODEL_IDS.GPT_5_3_CODEX,
    label: CODEX_MODEL_IDS.GPT_5_3_CODEX,
    hint: "coding-specialized",
  },
  { value: CODEX_MODEL_IDS.GPT_5_2, label: CODEX_MODEL_IDS.GPT_5_2 },
];

/** Amp CLI/SDK modes — capability presets, not model ids. */
export const AMP_MODE_OPTIONS: ModelOption[] = [
  { value: "low", label: "low", hint: "fastest" },
  { value: "medium", label: "medium", hint: "Amp default" },
  { value: "high", label: "high" },
  { value: "ultra", label: "ultra", hint: "most capable" },
];

/**
 * Cursor Router ("Auto") optimization modes, always offered on the Cursor
 * path — with or without a discovered catalog. The Cursor CLI accepts a
 * parameterized model id (`model[param=value]`), and the handler passes the
 * saved value verbatim as the next `--model` argument, so these exact ids
 * carry the mode. Router model id and parameter values per
 * https://cursor.com/docs/cursor-router. Order matches Cursor's own picker:
 * Intelligence, Balance, Cost.
 */
export const CURSOR_AUTO_MODEL_OPTIONS: ModelOption[] = [
  {
    value: "auto-smart[optimize_for=intelligence]",
    label: "Auto · Intelligence",
    hint: "Router · billed per routed model",
  },
  {
    value: "auto-smart[optimize_for=balanced]",
    label: "Auto · Balance",
    hint: "Router · billed per routed model",
  },
  {
    value: "auto-smart[optimize_for=cost]",
    label: "Auto · Cost",
    hint: "Router · bundled Auto pricing",
  },
];

/**
 * Curated per-provider fallback, rendered when no computer is bound or the
 * daemon's catalog is unavailable. Cursor/Kimi have no curated list on
 * purpose (the account-dependent SKU catalog is large and shifting), so
 * their fallback is the free-form exact-id input.
 */
export const MODEL_OPTIONS_BY_PROVIDER: Record<RuntimeProvider, ModelOption[]> = {
  amp: AMP_MODE_OPTIONS,
  "deepseek-harness": [],
  "claude-code": CLAUDE_MODEL_OPTIONS,
  "claude-code-tui": CLAUDE_MODEL_OPTIONS,
  codex: CODEX_MODEL_OPTIONS,
  cursor: [],
  grok: [],
  antigravity: [],
  "kimi-code": [],
  opencode: [],
  pi: [],
};

export const MODEL_HELP_BY_PROVIDER: Record<RuntimeProvider, string> = {
  amp: "Select an Amp mode (capability preset). Unset omits --mode so Amp uses its local default (medium). Amp does not accept a model id.",
  "deepseek-harness":
    "Enter an exact DeepSeek model id. It is passed through verbatim on the next turn; unset uses deepseek-v4-flash at harness initialize.",
  "claude-code": "Applies to new sessions immediately. Unset falls back to the CLI default.",
  "claude-code-tui": "Applies to new sessions immediately. Model swap restarts the tmux session (~2–4s).",
  codex: "Applies to new sessions immediately. Unset lets the CLI pick by auth mode.",
  cursor:
    "Options come from this computer's Cursor CLI when reachable. The Auto · * picks route through the Cursor Router (Cursor Teams/Enterprise only). The id is passed through verbatim on the next turn — one your account or team can't use fails visibly, no silent fallback. Auto · Balance/Intelligence bill per routed model; Auto · Cost uses bundled Auto pricing. Unset uses the Cursor default (auto).",
  grok: "Options come from this computer's Grok Build CLI when reachable. The id is passed through verbatim on the next turn — one your account can't use fails visibly, no silent fallback. Unset uses the Grok default (auto).",
  antigravity:
    "Enter an exact provider-native Antigravity model slug. It is passed through verbatim on the next turn; unset uses the local Antigravity default.",
  "kimi-code":
    "Options come from this computer's ~/.kimi-code config when reachable. Passed to new sessions. Unset uses the model configured in ~/.kimi-code.",
  opencode:
    "Enter an exact OpenCode provider/model id. It is passed through verbatim on the next turn; unset inherits the host-local OpenCode configuration.",
  pi: "Enter an exact Pi provider/model or provider/model:<thinking> id. It is passed through verbatim on the next turn. Leave empty to keep an existing Pi session's persisted model; a brand-new session uses Pi's local default.",
};

/** Extra note when discovery is unsupported / offline / timed out (`null` from the API helper). */
const CATALOG_UNAVAILABLE_HELP = "Couldn't read this computer's model list — enter the exact id.";

/** Visible row note when the catalog request rejects outside the silent-degrade set. */
const CATALOG_LOAD_ERROR_PREFIX = "Failed to load this computer's model list.";

export const UNSET_OPTION: ModelOption = { value: "", label: "(unset — inherits local)" };

/** Sentinel list entry that opens the free-form input instead of saving a value. */
export const CUSTOM_MODEL_OPTION_VALUE = "__custom__";

export type ModelSectionProps = {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  /** Runtime this agent runs on — drives the option list and help copy. */
  provider?: RuntimeProvider;
  /**
   * The agent's bound computer. When set, the picker asks that computer's
   * daemon for the provider's real model catalog and renders it; without it
   * (or when discovery is unavailable) the control degrades to the
   * per-provider fallback (curated list or free-form exact-id input).
   */
  clientId?: string | null;
};

export function ModelSection({ provider = "claude-code", clientId, ...rest }: ModelSectionProps) {
  if (clientId) {
    // Keyed so a computer/runtime switch resets the custom-entry mode.
    return <CatalogModelSection key={`${clientId}:${provider}`} provider={provider} clientId={clientId} {...rest} />;
  }
  return <FallbackModelControl provider={provider} {...rest} />;
}

/**
 * Catalog-driven picker: asks the bound computer's daemon for the provider's
 * model list and renders a unified Select — `(unset — inherits local)` +
 * discovered models + a custom-id entry. Degrades to the per-provider
 * fallback while the catalog is unreachable.
 */
function CatalogModelSection({
  value,
  onChange,
  disabled,
  provider,
  clientId,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  provider: RuntimeProvider;
  clientId: string;
}) {
  const catalogQuery = useQuery({
    queryKey: ["provider-models", clientId, provider],
    queryFn: () => getProviderModels(clientId, provider),
    staleTime: 5 * 60 * 1000,
    // Mapped degrade statuses return null (no throw). Real failures should
    // surface immediately so the user can Retry — do not auto-retry into a
    // silent unavailable lookalike.
    retry: false,
  });

  // While discovery is in flight, DEFAULT + Custom must stay usable for
  // Cursor/Kimi — never strand configuration behind a disabled control.
  // Curated Claude/Codex lists stay on their pre-catalog Select so picks
  // remain available without waiting on the network.
  if (catalogQuery.isPending) {
    if (MODEL_OPTIONS_BY_PROVIDER[provider].length === 0) {
      return (
        <CatalogModelPicker
          value={value}
          onChange={onChange}
          disabled={disabled}
          provider={provider}
          catalog={emptyUnavailableCatalog(provider)}
          helpSuffix="Loading this computer's model list…"
        />
      );
    }
    return <FallbackModelControl value={value} onChange={onChange} disabled={disabled} provider={provider} />;
  }

  // Rejected queries (401/403/500/503, …) must not reuse the silent
  // unavailable fallback — only getProviderModels' mapped null statuses do.
  if (catalogQuery.isError) {
    const description = (
      <span role="alert" style={{ color: "var(--state-error)" }}>
        {CATALOG_LOAD_ERROR_PREFIX}{" "}
        <button
          type="button"
          onClick={() => void catalogQuery.refetch()}
          className="cursor-pointer underline"
          style={{ color: "inherit" }}
        >
          Retry
        </button>
      </span>
    );
    if (MODEL_OPTIONS_BY_PROVIDER[provider].length === 0) {
      return (
        <CatalogModelPicker
          value={value}
          onChange={onChange}
          disabled={disabled}
          provider={provider}
          catalog={emptyUnavailableCatalog(provider)}
          description={description}
        />
      );
    }
    return (
      <FallbackModelControl
        value={value}
        onChange={onChange}
        disabled={disabled}
        provider={provider}
        description={description}
      />
    );
  }

  const catalog = catalogQuery.data ?? null;
  const models = catalog && catalog.source !== "unavailable" ? catalog.models : [];
  if (!catalog || models.length === 0) {
    // Mapped null / empty / source:unavailable — silent degrade; keep
    // DEFAULT + Custom for Cursor/Kimi; curated lists for Claude/Codex.
    if (MODEL_OPTIONS_BY_PROVIDER[provider].length === 0) {
      return (
        <CatalogModelPicker
          value={value}
          onChange={onChange}
          disabled={disabled}
          provider={provider}
          catalog={{
            models: [],
            defaultModelId: catalog?.defaultModelId ?? null,
          }}
          helpSuffix={CATALOG_UNAVAILABLE_HELP}
        />
      );
    }
    return (
      <FallbackModelControl value={value} onChange={onChange} disabled={disabled} provider={provider} catalogMissed />
    );
  }

  return (
    <CatalogModelPicker
      value={value}
      onChange={onChange}
      disabled={disabled}
      provider={provider}
      catalog={{ ...catalog, models }}
    />
  );
}

function emptyUnavailableCatalog(provider: RuntimeProvider): ProviderModelCatalog {
  return {
    provider,
    models: [],
    defaultModelId: null,
    fetchedAt: new Date(0).toISOString(),
    source: "unavailable",
    error: null,
  };
}

/** The loaded catalog as a Select list: unset (+ local default hint) → provider presets → models → current custom value → custom entry. */
export function buildCatalogModelOptions(
  catalog: Pick<ProviderModelCatalog, "models" | "defaultModelId">,
  value: string,
  provider?: RuntimeProvider,
): ModelOption[] {
  // Cursor's Router modes are First Tree presets, not daemon-discovered ids —
  // they must survive loading/unavailable/empty catalogs, and must not repeat
  // when the provider catalog already lists the same exact parameterized id.
  const presetOptions = provider === "cursor" ? CURSOR_AUTO_MODEL_OPTIONS : [];
  const presetValues = new Set(presetOptions.map((o) => o.value));
  const models = catalog.models.filter((m) => !presetValues.has(m.id));
  const items: ModelOption[] = [
    { ...UNSET_OPTION, hint: catalog.defaultModelId ? `default: ${catalog.defaultModelId}` : undefined },
    ...presetOptions,
    ...models.map((m) => ({
      value: m.id,
      label: m.label ?? m.id,
      hint: [m.hint, m.isDefault ? "default" : null].filter(Boolean).join(" · ") || undefined,
    })),
  ];
  if (value !== "" && !presetValues.has(value) && !models.some((m) => m.id === value)) {
    items.push({ value, label: value, hint: "custom" });
  }
  items.push({ value: CUSTOM_MODEL_OPTION_VALUE, label: "Custom model id…" });
  return items;
}

function CatalogModelPicker({
  value,
  onChange,
  disabled,
  provider,
  catalog,
  helpSuffix,
  description,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  provider: RuntimeProvider;
  catalog: Pick<ProviderModelCatalog, "models" | "defaultModelId">;
  helpSuffix?: string;
  description?: ReactNode;
}) {
  const [customMode, setCustomMode] = useState(false);
  const items = useMemo(() => buildCatalogModelOptions(catalog, value, provider), [catalog, value, provider]);
  const helpText = helpSuffix ? `${MODEL_HELP_BY_PROVIDER[provider]} ${helpSuffix}` : MODEL_HELP_BY_PROVIDER[provider];

  if (customMode) {
    return (
      <ConfigRow label="Model" helpText={helpText} description={description}>
        <div className="flex items-center gap-2">
          <FreeFormModelInput
            value={value}
            onChange={(v) => {
              onChange(v);
              setCustomMode(false);
            }}
            disabled={disabled}
            provider={provider}
          />
          <button
            type="button"
            onClick={() => setCustomMode(false)}
            className="shrink-0 cursor-pointer text-body underline"
            style={{ color: "var(--fg-3)" }}
          >
            Choose from list
          </button>
        </div>
      </ConfigRow>
    );
  }

  return (
    <ConfigRow label="Model" helpText={helpText} description={description}>
      <Select
        options={items}
        value={value}
        onChange={(v) => {
          // The custom entry is a mode switch, never a saved value.
          if (v === CUSTOM_MODEL_OPTION_VALUE) setCustomMode(true);
          else onChange(v);
        }}
        disabled={disabled}
        searchable
        mono
        aria-label="Model"
      />
    </ConfigRow>
  );
}

/**
 * The pre-catalog control: curated Select for Claude/Codex. Cursor/Kimi with
 * an empty preset list reuse CatalogModelPicker (DEFAULT + Custom) so the
 * unset safety control stays visible. `catalogMissed` adds a help note when
 * a catalog was expected but couldn't be read.
 */
function FallbackModelControl({
  value,
  onChange,
  disabled,
  provider,
  catalogMissed = false,
  description,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  provider: RuntimeProvider;
  catalogMissed?: boolean;
  description?: ReactNode;
}) {
  const presetOptions = MODEL_OPTIONS_BY_PROVIDER[provider];

  const items = useMemo<ModelOption[]>(() => {
    const list: ModelOption[] = [UNSET_OPTION, ...presetOptions];
    if (value !== "" && !presetOptions.some((o) => o.value === value)) {
      list.push({ value, label: value, hint: "custom" });
    }
    return list;
  }, [presetOptions, value]);

  if (presetOptions.length === 0) {
    // Cursor/Kimi unbound / pre-catalog path: always expose DEFAULT + Custom,
    // never a bare free-form field that hides the unset safety control.
    return (
      <CatalogModelPicker
        value={value}
        onChange={onChange}
        disabled={disabled}
        provider={provider}
        catalog={emptyUnavailableCatalog(provider)}
        helpSuffix={catalogMissed ? CATALOG_UNAVAILABLE_HELP : undefined}
        description={description}
      />
    );
  }

  return (
    <ConfigRow label="Model" helpText={MODEL_HELP_BY_PROVIDER[provider]} description={description}>
      <Select options={items} value={value} onChange={onChange} disabled={disabled} mono aria-label="Model" />
    </ConfigRow>
  );
}

/**
 * Free-form exact-model input. Commits on blur / Enter rather than
 * per keystroke — every other control on this page saves on change, but a
 * text field saving each character would spam config writes.
 */
function FreeFormModelInput({
  value,
  onChange,
  disabled,
  provider,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  provider: RuntimeProvider;
}) {
  const [draft, setDraft] = useState(value);
  // Latch scoped to ONE Enter→blur sequence: Enter followed by the immediate
  // blur must not fire a second identical save while the first round-trip is
  // still in flight (the `value` prop only advances after the save lands, and
  // a duplicate write would carry a stale expectedVersion → spurious
  // conflict). The latch expires on refocus (and on a value round-trip), so a
  // FAILED save stays retryable with the same intended model — the user
  // clicks back in and presses Enter again.
  const lastSentRef = useRef<string | null>(null);
  useEffect(() => {
    setDraft(value);
    lastSentRef.current = null;
  }, [value]);
  const commit = () => {
    const next = draft.trim();
    if (next !== value && next !== lastSentRef.current) {
      lastSentRef.current = next;
      onChange(next);
    }
  };
  return (
    <Input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => {
        lastSentRef.current = null;
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
      disabled={disabled}
      placeholder={
        provider === "kimi-code"
          ? "local Kimi default"
          : provider === "grok"
            ? "auto (Grok default)"
            : provider === "opencode"
              ? "local OpenCode default"
              : provider === "pi"
                ? "local Pi default"
                : provider === "cursor"
                  ? "auto (Cursor default)"
                  : "provider default"
      }
      className="font-mono"
      aria-label="Model"
    />
  );
}
