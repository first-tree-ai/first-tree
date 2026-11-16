import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * The official DeepSeek Harness desktop app stores its provider API keys in
 * `~/.dsh/.credentials.yaml` under `refs.<ENV_NAME>`. First Tree's embedded
 * harness runs without a credentials-service plugin, so `llm-deepseek` only
 * resolves `DEEPSEEK_API_KEY` from the launch environment — an operator whose
 * DSH desktop install already holds the key still had to re-enter it on the
 * web Models page. This fallback reuses that host-local credential file when
 * the launch environment does not carry the key.
 */
export const DSH_CREDENTIALS_FILE = ".dsh/.credentials.yaml";

export type DeepseekCredentialFallbackDeps = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  readFileSyncImpl?: typeof readFileSync;
};

/**
 * Resolve `DEEPSEEK_API_KEY` for the harness launch environment, falling back
 * to the DSH desktop credentials file when the environment does not carry it.
 * Returns `null` when neither source has a non-empty key; a malformed or
 * unreadable credentials file is treated the same (fail closed to the normal
 * missing-credential error, never to a partial launch).
 */
export function resolveDeepseekApiKeyForLaunch(deps: DeepseekCredentialFallbackDeps = {}): string | null {
  const env = deps.env ?? process.env;
  const ambient = env.DEEPSEEK_API_KEY;
  if (typeof ambient === "string" && ambient.length > 0) return ambient;

  const read = deps.readFileSyncImpl ?? readFileSync;
  const home = deps.home ?? env.HOME ?? homedir();
  const credentialsPath = join(home, DSH_CREDENTIALS_FILE);
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
