import type { RuntimeProvider } from "@first-tree/shared";
import { useMemo } from "react";
import { Select, type SelectOption } from "../../components/ui/select.js";
import { ConfigRow } from "./flat-section.js";

/**
 * Reasoning effort — an inline dropdown mirroring the Model row. Options and
 * help copy are provider-specific (no abstraction over the providers):
 *   - claude-code maps to the SDK `effort` (low/medium/high/max), plus an
 *     "" inherit option that defers to the operator's local effortLevel.
 *   - codex maps to its provider-native effort (low/medium/high/xhigh/max/ultra).
 *     The higher values are model-dependent; "minimal" is excluded because it
 *     breaks the default tool set.
 *   - grok maps to the Grok Build CLI `--effort` flag (low/medium/high), plus
 *     an "" inherit option that omits the flag so Grok uses its local default.
 */

const CLAUDE_EFFORT_OPTIONS: SelectOption[] = [
  { value: "", label: "(unset — inherits local)" },
  { value: "low", label: "low", hint: "fastest" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high", hint: "default" },
  { value: "max", label: "max", hint: "Opus only" },
];

export const CODEX_EFFORT_OPTIONS: SelectOption[] = [
  { value: "low", label: "low", hint: "fastest" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high", hint: "default" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max", hint: "model-dependent" },
  { value: "ultra", label: "ultra", hint: "deepest; model-dependent" },
];

// Grok's effort channel mirrors claude's minus "max": an "" inherit option
// (the `--effort` flag is omitted and Grok uses its local default) plus
// low/medium/high.
const GROK_EFFORT_OPTIONS: SelectOption[] = [
  { value: "", label: "(unset — inherits local)" },
  { value: "low", label: "low", hint: "fastest" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high", hint: "default" },
];

const ANTIGRAVITY_EFFORT_OPTIONS: SelectOption[] = [
  { value: "", label: "(unset — inherits local)" },
  { value: "low", label: "low", hint: "fastest" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high", hint: "default" },
];

const EFFORT_OPTIONS_BY_PROVIDER: Record<RuntimeProvider, SelectOption[]> = {
  amp: [],
  "deepseek-harness": [],
  "claude-code": CLAUDE_EFFORT_OPTIONS,
  // claude-code-tui drives the same `claude` CLI as claude-code, so it shares
  // the identical effort options + inherit sentinel.
  "claude-code-tui": CLAUDE_EFFORT_OPTIONS,
  codex: CODEX_EFFORT_OPTIONS,
  // Cursor has no separate effort channel — effort/fast variants are encoded
  // in the model id itself, so RuntimeTab hides this section entirely for
  // cursor agents. The empty entry keeps the Record exhaustive.
  cursor: [],
  grok: GROK_EFFORT_OPTIONS,
  antigravity: ANTIGRAVITY_EFFORT_OPTIONS,
  "kimi-code": [],
  opencode: [],
  pi: [],
};

export const EFFORT_HELP_BY_PROVIDER: Record<RuntimeProvider, string> = {
  amp: "Amp reasoning is inherited from the local Amp configuration; there is no separate First Tree effort control.",
  "deepseek-harness":
    "DeepSeek reasoning is provider-native; there is no separate First Tree effort control for the Harness runtime.",
  "claude-code": "Applies to new sessions. Unset inherits the local ~/.claude effortLevel; setting it overrides.",
  "claude-code-tui": "Applies to new sessions. Unset inherits the local ~/.claude effortLevel; setting it overrides.",
  codex: "Applies to new sessions. Higher means more reasoning per turn; max and ultra require a compatible model.",
  cursor: "Cursor encodes effort in the model id; there is no separate control.",
  grok: "Applies from the next turn, on new and existing sessions (re-applied AND confirmed via session/set_model after every session open — the turn does not run if the provider does not confirm the effective effort). Unset removes only the effort override — an explicit model is still re-applied; with model also unset, the next turn resets to Grok's default model.",
  antigravity:
    "Applies on the next turn. Unset inherits the local Antigravity default; low, medium, and high are passed to `agy` unchanged.",
  "kimi-code": "Kimi thinking configuration is inherited from the local Kimi configuration.",
  opencode: "OpenCode model variants are provider-native; there is no separate First Tree effort control.",
  pi: "Pi thinking level is inherited from the local Pi configuration; there is no separate First Tree effort control.",
};

export type ReasoningEffortSectionProps = {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  /** Runtime this agent runs on — drives the option list and help copy. */
  provider?: RuntimeProvider;
};

export function ReasoningEffortSection({
  value,
  onChange,
  disabled,
  provider = "claude-code",
}: ReasoningEffortSectionProps) {
  const presetOptions = EFFORT_OPTIONS_BY_PROVIDER[provider];

  const items = useMemo<SelectOption[]>(() => {
    // Surface an unrecognized stored value (e.g. a provider-specific effort) so
    // the dropdown still shows the current selection instead of silently
    // snapping to the first option.
    if (value !== "" && !presetOptions.some((o) => o.value === value)) {
      return [...presetOptions, { value, label: value, hint: "custom" }];
    }
    return presetOptions;
  }, [presetOptions, value]);

  return (
    <ConfigRow label="Reasoning effort" helpText={EFFORT_HELP_BY_PROVIDER[provider]}>
      <Select
        options={items}
        value={value}
        onChange={onChange}
        disabled={disabled}
        placeholder="(unset)"
        aria-label="Reasoning effort"
      />
    </ConfigRow>
  );
}
