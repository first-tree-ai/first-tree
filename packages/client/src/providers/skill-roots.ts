import type { RuntimeProvider } from "@first-tree/shared";

/**
 * Frozen native managed-skill projection roots per runtime provider.
 *
 * Composition-owned projection of the exhaustive provider set. Providers pass
 * this into Runtime Managed Skills / `prepareManagedSession`; Runtime never
 * imports Providers to obtain it.
 */
export const PROVIDER_SKILL_ROOTS: Readonly<Record<RuntimeProvider, string>> = Object.freeze({
  amp: ".agents/skills",
  "deepseek-harness": ".agents/skills",
  "claude-code": ".claude/skills",
  "claude-code-tui": ".claude/skills",
  codex: ".agents/skills",
  cursor: ".cursor/skills",
  grok: ".grok/skills",
  antigravity: ".agents/skills",
  "kimi-code": ".kimi-code/skills",
  opencode: ".opencode/skills",
  pi: ".agents/skills",
  zcode: ".zcode/skills",
} satisfies Record<RuntimeProvider, string>);
