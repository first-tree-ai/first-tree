import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * The official DeepSeek Harness desktop app stores its provider API keys in
 * its harness home under `.credentials.yaml` at `refs.<ENV_NAME>`. The home
 * follows the DSH home resolution — `$DSH_HOME` when set (tilde-expanded,
 * blank treated as unset), else `~/.dsh`. First Tree's embedded harness runs
 * without a credentials-service plugin, so `llm-deepseek` only resolves
 * `DEEPSEEK_API_KEY` from the launch environment — an operator whose DSH
 * desktop install already holds the key still had to re-enter it on the web
 * Models page. This fallback reuses that host-local credential file when the
 * launch environment does not carry the key.
 *
 * Host-authorization boundary: the file belongs to the operator's desktop
 * install, so reuse is gated behind an explicit host-side opt-in
 * (`FIRST_TREE_DEEPSEEK_ALLOW_DESKTOP_CREDENTIALS`, agent-scoped) resolved
 * from the trusted daemon environment — never from the agent-managed config
 * environment. The home path for the lookup is likewise taken from the
 * trusted layer only, and a reused key is pinned to the authorized origin
 * (the official API) by stripping a configurable `DEEPSEEK_BASE_URL` that
 * the trusted layer did not set.
 */
export const DSH_HOME_ENV = "DSH_HOME";
export const DSH_HOME_DIR_NAME = ".dsh";
export const DSH_CREDENTIALS_FILE = ".credentials.yaml";
export const DESKTOP_CREDENTIAL_OPT_IN_ENV = "FIRST_TREE_DEEPSEEK_ALLOW_DESKTOP_CREDENTIALS";
export const DEEPSEEK_BASE_URL_ENV = "DEEPSEEK_BASE_URL";

/**
 * Decide whether this agent may reuse the desktop credentials file. The
 * opt-in value is a comma-separated allowlist of agent UUIDs, or `all` /
 * `*` to grant every managed agent. Anything unset, blank, or unmatching
 * fails closed.
 */
export function desktopCredentialOptIn(env: NodeJS.ProcessEnv, agentId: string): boolean {
  const raw = env[DESKTOP_CREDENTIAL_OPT_IN_ENV]?.trim();
  if (!raw) return false;
  if (raw === "all" || raw === "*") return true;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .includes(agentId);
}

export type DeepseekCredentialFallbackDeps = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  readFileSyncImpl?: typeof readFileSync;
  /** Pre-checked opt-in; when absent the check runs against `env` + `agentId`. */
  optIn?: boolean;
  agentId?: string;
};

function resolveDshHomeDir(env: NodeJS.ProcessEnv, home: string): string {
  const override = env[DSH_HOME_ENV]?.trim();
  if (override) {
    if (override === "~") return home;
    if (override.startsWith("~/")) return join(home, override.slice(2));
    return override;
  }
  return join(home, DSH_HOME_DIR_NAME);
}

/**
 * Resolve `DEEPSEEK_API_KEY` for the harness launch environment, falling back
 * to the DSH desktop credentials file only when the agent-scoped host opt-in
 * grants it. `deps.env` must be the TRUSTED daemon environment (`process.env`
 * at the handler boundary, before any agent-managed entry is merged in) — the
 * `DSH_HOME` path override and the opt-in flag are honored from that layer
 * alone, so an agent-managed env entry can never redirect the lookup.
 * Returns `null` when the opt-in does not grant this agent or neither source
 * has a non-empty key; a malformed or unreadable credentials file is treated
 * the same (fail closed to the normal missing-credential error, never to a
 * partial launch).
 */
export function resolveDeepseekApiKeyForLaunch(deps: DeepseekCredentialFallbackDeps = {}): string | null {
  const env = deps.env ?? process.env;
  const ambient = env.DEEPSEEK_API_KEY;
  if (typeof ambient === "string" && ambient.length > 0) return ambient;

  const granted = deps.optIn ?? desktopCredentialOptIn(env, deps.agentId ?? "");
  if (!granted) return null;

  const read = deps.readFileSyncImpl ?? readFileSync;
  const home = deps.home ?? env.HOME ?? homedir();
  const credentialsPath = join(resolveDshHomeDir(env, home), DSH_CREDENTIALS_FILE);
  if (!existsSync(credentialsPath)) return null;
  try {
    const parsed: unknown = parseYaml(read(credentialsPath, "utf8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const refs = (parsed as { refs?: unknown }).refs;
    if (refs === null || typeof refs !== "object") return null;
    const value = (refs as Record<string, unknown>).DEEPSEEK_API_KEY;
    if (typeof value === "string" && value.length > 0) return value;
    return null;
  } catch {
    return null;
  }
}

/**
 * Origin binding for a reused desktop key: the endpoint stays the official
 * API unless the trusted daemon environment explicitly set
 * `DEEPSEEK_BASE_URL` itself. An agent-managed env entry must not be able to
 * point a desktop credential at a different origin, so callers strip the
 * untrusted value when this returns `false`.
 */
export function trustedDeepseekBaseUrlOverride(env: NodeJS.ProcessEnv): string | null {
  const value = env[DEEPSEEK_BASE_URL_ENV]?.trim();
  return value ? value : null;
}
