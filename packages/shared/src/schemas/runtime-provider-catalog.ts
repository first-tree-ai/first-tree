import type { RuntimeAuthProvider } from "./runtime-auth.js";
import {
  asRuntimeProvider,
  DEFAULT_RUNTIME_PROVIDER,
  isRuntimeProviderEnabled,
  RUNTIME_PROVIDER_IDS,
  type RuntimeProvider,
  recordByRuntimeProvider,
} from "./runtime-provider.js";

/** Official installer scripts (also re-exported for client binary remediation). */
export const AMP_INSTALL_COMMAND = "curl -fsSL https://ampcode.com/install.sh | bash";
export const CURSOR_INSTALL_COMMAND = "curl https://cursor.com/install -fsS | bash";
export const GROK_INSTALL_COMMAND = "curl -fsSL https://x.ai/cli/install.sh | bash";
export const ANTIGRAVITY_INSTALL_COMMAND = "curl -fsSL https://antigravity.google/cli/install.sh | bash";

/**
 * OpenCode CLI minimum supported version. Catalog npm package and client
 * capability gates share this constant — do not parse it back out of the
 * package string.
 */
export const OPENCODE_MINIMUM_VERSION = "1.18.7";
export const OPENCODE_NPM_PACKAGE = `opencode-ai@^${OPENCODE_MINIMUM_VERSION}`;

export const PI_NPM_PACKAGE = "@earendil-works/pi-coding-agent";
export const KIMI_NPM_PACKAGE = "@moonshot-ai/kimi-code";
/**
 * Remediation package list when a Client/CLI install is missing the bundled
 * DeepSeek Harness closure. The portable First Tree CLI is expected to ship
 * these already via `bundleDependencies`; this string is for broken/local installs.
 */
export const DEEPSEEK_INSTALL_NPM_PACKAGE = [
  "@deepseek-ai/dsh-sdk-jsonrpc-demo@0.0.1-rc.5",
  "@deepseek-ai/dsh-sdk-jsonrpc-server@0.0.1-rc.5",
  "@deepseek-ai/dsh-sdk-client@0.0.1-rc.1",
  "@deepseek-ai/dsh-sdk-protocol@0.0.1-rc.5",
  "@deepseek-ai/dsh-agent-spine-demo@0.0.1-rc.5",
  "@deepseek-ai/dsh-session-persistence-jsonl@0.0.1-rc.5",
  "@deepseek-ai/dsh-llm-deepseek@0.0.1-rc.5",
  "@deepseek-ai/dsh-bash-local@0.0.1-rc.5",
  "@deepseek-ai/dsh-fs-local@0.0.1-rc.5",
  "@deepseek-ai/dsh-session@0.0.1-rc.5",
].join(" ");

/** Provider-owned install metadata — npm package or official installer script. */
export type RuntimeProviderInstall =
  | { kind: "npm"; package: string; args: readonly string[] }
  | { kind: "script"; command: string };

/**
 * Ordered login steps for chat auth-recovery / host-local surfaces.
 * Shell providers have exactly one step; interactive providers (Kimi / Pi)
 * have exactly two (`program`, slash-command).
 *
 * Each step MUST be an executable terminal fragment (or a slash-command for
 * the interactive pair). Natural-language UI guidance does not belong here —
 * use {@link RuntimeProviderPreferredCredential} for preferred First Tree
 * placement prose.
 */
export type RuntimeProviderLoginSteps = readonly [string] | readonly [string, string];

/**
 * Preferred First Tree credential placement when host-local auth is an API
 * key (or similar) rather than only a CLI login. Absent → terminal
 * {@link RuntimeProviderLoginSteps} only.
 */
export type RuntimeProviderPreferredCredential = {
  kind: "agent-runtime-env";
  /** Env var name stored on the agent's Runtime → Environment variables. */
  envKey: string;
  /** Prefer Web "Mark as sensitive" when saving on the agent. */
  markSensitive: boolean;
};

/**
 * Where operators recover credentials.
 * - `{ kind: "in-product", target }`: browser-OAuth / Connect from a failing
 *   chat, with a server-accepted target. Computer and setup-incomplete cards
 *   stay **install-only** (no terminal login copy).
 * - `{ kind: "host" }`: provider-owned CLI / interactive login on the machine;
 *   computer and setup surfaces may include those host-local login steps.
 */
export type RuntimeProviderAuthRecovery = { kind: "in-product"; target: RuntimeAuthProvider } | { kind: "host" };

/**
 * Cross-package pure-data catalog for runtime providers.
 *
 * Owns labels, display/selection order, install/login metadata, and auth-owner
 * copy shared by web/CLI/client notice surfaces. Must not contain executable
 * client code (handler factories, probes, binary resolvers, or SDKs).
 */
export type RuntimeProviderCatalogEntry = {
  id: RuntimeProvider;
  label: string;
  /** Ascending order for setup-card / matrix display. */
  displayOrder: number;
  /**
   * Ascending priority for the explicit agent-creation preference prefix.
   * `null` preserves the selected Client's reported order after that prefix.
   */
  selectionPriority: number | null;
  install: RuntimeProviderInstall;
  loginSteps: RuntimeProviderLoginSteps;
  authRecovery: RuntimeProviderAuthRecovery;
  /** Credential owner named in chat auth-failure hints. */
  authOwnerLabel: string;
  /**
   * Optional preferred First Tree placement for the credential. When set,
   * computers / chat prose may name agent Runtime env; {@link loginSteps}
   * stay the executable host-shell fallback.
   */
  preferredCredential?: RuntimeProviderPreferredCredential;
};

/**
 * Exhaustive catalog keyed by every {@link RuntimeProvider}.
 */
export const RUNTIME_PROVIDER_CATALOG = {
  amp: {
    id: "amp",
    label: "Amp",
    // After Pi in setup-card order. Agent creation keeps Codex/Claude prefix.
    displayOrder: 90,
    selectionPriority: null,
    install: { kind: "script", command: AMP_INSTALL_COMMAND },
    loginSteps: ["amp login"],
    authRecovery: { kind: "host" },
    authOwnerLabel: "Amp",
  },
  "deepseek-harness": {
    id: "deepseek-harness",
    label: "DeepSeek Harness",
    displayOrder: 100,
    selectionPriority: null,
    install: { kind: "npm", package: DEEPSEEK_INSTALL_NPM_PACKAGE, args: [] },
    loginSteps: ["export DEEPSEEK_API_KEY=<your DeepSeek API key>"],
    authRecovery: { kind: "host" },
    authOwnerLabel: "DeepSeek",
    preferredCredential: {
      kind: "agent-runtime-env",
      envKey: "DEEPSEEK_API_KEY",
      markSensitive: true,
    },
  },
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    displayOrder: 10,
    selectionPriority: 20,
    install: { kind: "npm", package: "@anthropic-ai/claude-code", args: [] },
    loginSteps: ["claude auth login"],
    authRecovery: { kind: "in-product", target: "claude-code" },
    authOwnerLabel: "Anthropic",
  },
  "claude-code-tui": {
    id: "claude-code-tui",
    label: "Claude Code CLI",
    displayOrder: 20,
    selectionPriority: null,
    install: { kind: "npm", package: "@anthropic-ai/claude-code", args: [] },
    loginSteps: ["claude auth login"],
    // Shares Claude Code keychain; Connect targets `claude-code`, not a TUI CLI login.
    authRecovery: { kind: "in-product", target: "claude-code" },
    authOwnerLabel: "Anthropic",
  },
  codex: {
    id: "codex",
    label: "Codex",
    displayOrder: 30,
    selectionPriority: 10,
    install: { kind: "npm", package: "@openai/codex", args: [] },
    loginSteps: ["codex login"],
    authRecovery: { kind: "in-product", target: "codex" },
    authOwnerLabel: "OpenAI",
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    displayOrder: 40,
    selectionPriority: null,
    install: { kind: "script", command: CURSOR_INSTALL_COMMAND },
    loginSteps: ["cursor-agent login"],
    authRecovery: { kind: "in-product", target: "cursor" },
    authOwnerLabel: "Cursor",
  },
  grok: {
    id: "grok",
    label: "Grok Build",
    displayOrder: 50,
    selectionPriority: null,
    install: { kind: "script", command: GROK_INSTALL_COMMAND },
    loginSteps: ["grok login"],
    authRecovery: { kind: "in-product", target: "grok" },
    authOwnerLabel: "Grok Build",
  },
  antigravity: {
    id: "antigravity",
    label: "Antigravity",
    displayOrder: 55,
    selectionPriority: null,
    install: { kind: "script", command: ANTIGRAVITY_INSTALL_COMMAND },
    loginSteps: ["agy"],
    authRecovery: { kind: "host" },
    authOwnerLabel: "Google Antigravity",
  },
  "kimi-code": {
    id: "kimi-code",
    label: "Kimi Code",
    // Display sits with other npm CLIs after Grok. Agent creation preserves the
    // Client-reported order for providers outside the Codex/Claude prefix.
    displayOrder: 60,
    selectionPriority: null,
    install: { kind: "npm", package: KIMI_NPM_PACKAGE, args: [] },
    loginSteps: ["kimi", "/login"],
    authRecovery: { kind: "host" },
    authOwnerLabel: "Kimi",
  },
  opencode: {
    id: "opencode",
    label: "OpenCode",
    displayOrder: 70,
    selectionPriority: null,
    install: { kind: "npm", package: OPENCODE_NPM_PACKAGE, args: [] },
    loginSteps: ["opencode auth login"],
    authRecovery: { kind: "host" },
    authOwnerLabel: "OpenCode's selected provider",
  },
  pi: {
    id: "pi",
    label: "Pi",
    displayOrder: 80,
    selectionPriority: null,
    install: { kind: "npm", package: PI_NPM_PACKAGE, args: ["--ignore-scripts"] },
    loginSteps: ["pi", "/login"],
    authRecovery: { kind: "host" },
    authOwnerLabel: "Pi",
  },
} as const satisfies Record<RuntimeProvider, RuntimeProviderCatalogEntry>;

/** All known providers sorted by catalog display order (includes disabled). */
export const RUNTIME_PROVIDER_DISPLAY_ORDER: readonly RuntimeProvider[] = [...RUNTIME_PROVIDER_IDS].sort(
  (a, b) => RUNTIME_PROVIDER_CATALOG[a].displayOrder - RUNTIME_PROVIDER_CATALOG[b].displayOrder,
);

/** Explicit agent-creation preference prefix; remaining providers keep input order. */
export const RUNTIME_PROVIDER_PREFERRED_ORDER: readonly RuntimeProvider[] = RUNTIME_PROVIDER_IDS.filter(
  (provider) => RUNTIME_PROVIDER_CATALOG[provider].selectionPriority !== null,
).sort(
  (a, b) =>
    // Filter above narrows the runtime values, not indexed entry fields.
    (RUNTIME_PROVIDER_CATALOG[a].selectionPriority ?? Number.POSITIVE_INFINITY) -
    (RUNTIME_PROVIDER_CATALOG[b].selectionPriority ?? Number.POSITIVE_INFINITY),
);

/** First enabled explicit preference for pre-capability UI state. */
export const PREFERRED_RUNTIME_PROVIDER: RuntimeProvider =
  RUNTIME_PROVIDER_PREFERRED_ORDER.find((provider) => isRuntimeProviderEnabled(provider)) ??
  enabledRuntimeProviders()[0] ??
  DEFAULT_RUNTIME_PROVIDER;

/** Move explicit preferences first while preserving every remaining provider's input order. */
export function orderRuntimeProvidersByPreference(providers: readonly RuntimeProvider[]): RuntimeProvider[] {
  const uniqueProviders = [...new Set(providers)];
  const included = new Set(uniqueProviders);
  const preferred = RUNTIME_PROVIDER_PREFERRED_ORDER.filter((provider) => included.has(provider));
  const preferredSet = new Set(preferred);
  return [...preferred, ...uniqueProviders.filter((provider) => !preferredSet.has(provider))];
}

/** Enabled providers only, in display order — drives setup / matrix UIs. */
export function enabledRuntimeProviders(): RuntimeProvider[] {
  return RUNTIME_PROVIDER_DISPLAY_ORDER.filter((p) => isRuntimeProviderEnabled(p));
}

/** Label map derived from the catalog. */
export const RUNTIME_PROVIDER_LABELS: Readonly<Record<RuntimeProvider, string>> = recordByRuntimeProvider(
  RUNTIME_PROVIDER_IDS.map((id) => [id, RUNTIME_PROVIDER_CATALOG[id].label] as const),
);

/** Friendly runtime label, falling back to the raw id when unknown. */
export function runtimeProviderLabel(provider: string): string {
  const known = asRuntimeProvider(provider);
  return known ? RUNTIME_PROVIDER_CATALOG[known].label : provider;
}

/** Structured login steps from the catalog. */
export function runtimeProviderLoginSteps(provider: RuntimeProvider): RuntimeProviderLoginSteps {
  return RUNTIME_PROVIDER_CATALOG[provider].loginSteps;
}

/**
 * Single install command line for a provider: `npm install -g …` or the
 * official installer script.
 */
export function runtimeProviderInstallCommand(provider: RuntimeProvider): string {
  const install = RUNTIME_PROVIDER_CATALOG[provider].install;
  if (install.kind === "npm") {
    const args = install.args.length > 0 ? `${install.args.join(" ")} ` : "";
    return `npm install -g ${args}${install.package}`;
  }
  return install.command;
}

/**
 * Shell / comment-form login line for host-local recovery.
 * One-step → command; two-step → `program # then run /login`.
 */
export function runtimeProviderLoginCommand(provider: RuntimeProvider): string {
  const steps = runtimeProviderLoginSteps(provider);
  if (steps.length === 1) return steps[0];
  const [program, slashCommand] = steps;
  return `${program} # then run ${slashCommand}`;
}

/** Catalog auth-recovery path (`in-product` vs host-local). */
export function runtimeProviderAuthRecovery(provider: RuntimeProvider): RuntimeProviderAuthRecovery {
  return RUNTIME_PROVIDER_CATALOG[provider].authRecovery;
}

/** Typed in-product login target, or null for provider-owned host recovery. */
export function runtimeProviderInProductAuthTarget(provider: RuntimeProvider): RuntimeAuthProvider | null {
  const recovery = runtimeProviderAuthRecovery(provider);
  return recovery.kind === "in-product" ? recovery.target : null;
}

/**
 * True when computer / setup-incomplete surfaces may show host-local login
 * steps. In-product OAuth providers stay install-only on those surfaces.
 */
export function runtimeProviderShowsHostLoginOnSetup(provider: RuntimeProvider): boolean {
  return runtimeProviderAuthRecovery(provider).kind === "host";
}

/**
 * Chat-timeline auth recovery phrase (includes markdown backticks).
 * Derived from {@link runtimeProviderLoginSteps} — no parallel phrase strings.
 */
export function runtimeProviderChatAuthLoginPhrase(provider: RuntimeProvider): string {
  const steps = runtimeProviderLoginSteps(provider);
  if (steps.length === 1) return `\`${steps[0]}\``;
  const [program, slashCommand] = steps;
  return `\`${program}\` and then \`${slashCommand}\``;
}

/**
 * Natural-language login cue for missing-binary / install hints
 * (`run \`kimi\` and enter \`/login\``).
 */
export function runtimeProviderInteractiveLoginCue(provider: RuntimeProvider): string {
  const steps = runtimeProviderLoginSteps(provider);
  if (steps.length === 1) return `run \`${steps[0]}\``;
  const [program, slashCommand] = steps;
  return `run \`${program}\` and enter \`${slashCommand}\``;
}

/** Credential-owner label used in chat auth-failure hints. */
export function runtimeProviderAuthOwnerLabel(provider: RuntimeProvider): string {
  return RUNTIME_PROVIDER_CATALOG[provider].authOwnerLabel;
}

/** Preferred First Tree credential placement, when the catalog declares one. */
export function runtimeProviderPreferredCredential(
  provider: RuntimeProvider,
): RuntimeProviderPreferredCredential | null {
  // `as const satisfies` keeps per-entry exact types; widen to the catalog
  // entry contract so optional `preferredCredential` is readable for every id.
  const entry: RuntimeProviderCatalogEntry = RUNTIME_PROVIDER_CATALOG[provider];
  return entry.preferredCredential ?? null;
}

/**
 * Operator-facing prose for {@link RuntimeProviderPreferredCredential}.
 * Returns null when the provider has no preferred First Tree placement
 * beyond host-local {@link runtimeProviderLoginSteps}.
 */
export function runtimeProviderPreferredCredentialProse(provider: RuntimeProvider): string | null {
  const preferred = runtimeProviderPreferredCredential(provider);
  if (preferred?.kind !== "agent-runtime-env") return null;
  const sensitive = preferred.markSensitive ? " and Mark as sensitive" : "";
  return `set \`${preferred.envKey}\` on the agent's Runtime → Environment variables${sensitive}`;
}

/**
 * Setup-surface command block: always includes install; appends host-local
 * login only when {@link runtimeProviderShowsHostLoginOnSetup} is true.
 * Optional `extraLines` lets a presentation layer append host-specific
 * requirements (e.g. tmux).
 */
export function runtimeProviderComputerSetupCommand(
  provider: RuntimeProvider,
  extraLines: readonly string[] = [],
): string {
  const lines = [runtimeProviderInstallCommand(provider)];
  if (runtimeProviderShowsHostLoginOnSetup(provider)) {
    lines.push(runtimeProviderLoginCommand(provider));
  }
  lines.push(...extraLines);
  return lines.join("\n");
}

/**
 * First enabled provider whose capability entry is `ok`, following the
 * explicit preference prefix and then the selected Client's reported order.
 */
export function pickPreferredRuntimeProvider(
  caps: Readonly<Partial<Record<string, { state?: string } | null | undefined>>>,
): RuntimeProvider | null {
  return enabledOkRuntimeProviders(caps)[0] ?? null;
}

/**
 * Enabled providers whose capability state is `ok`: explicit catalog
 * preferences first, then the selected Client's reported order.
 *
 * The shared helper is the only layer that interprets capability-map order;
 * Web consumers must not rebuild this rule locally.
 */
export function enabledOkRuntimeProviders(
  caps: Readonly<Partial<Record<string, { state?: string } | null | undefined>>>,
): RuntimeProvider[] {
  const reportedReady: RuntimeProvider[] = [];
  for (const [provider, entry] of Object.entries(caps)) {
    const known = asRuntimeProvider(provider);
    if (known && isRuntimeProviderEnabled(known) && entry?.state === "ok") reportedReady.push(known);
  }
  return orderRuntimeProvidersByPreference(reportedReady);
}
