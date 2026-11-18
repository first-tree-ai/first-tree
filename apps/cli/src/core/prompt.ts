import { join } from "node:path";
import type { PromptDef } from "@first-tree/shared/config";
import { collectMissingPrompts, defaultConfigDir, defaultHome, setConfigValue } from "@first-tree/shared/config";
import { input, password, select } from "@inquirer/prompts";
import { credentialForOrigin } from "./access-token.js";
import { loadCredentials, resolveServerUrl } from "./bootstrap.js";
import { channelConfig } from "./channel.js";
import { cliFetch } from "./cli-fetch.js";

/**
 * Check if interactive mode is available.
 * Returns false if --no-interactive flag is set or stdin is not a TTY.
 */
export function isInteractive(noInteractiveFlag?: boolean): boolean {
  if (noInteractiveFlag) return false;
  return process.stdin.isTTY === true;
}

/**
 * Schema-driven interactive setup.
 * Scans the config schema for fields with `prompt` that are missing.
 *
 * In interactive mode: prompts the user and writes results to YAML.
 * In non-interactive mode: fails with a clear error listing missing fields.
 */
export async function promptMissingFields(options: {
  schema: Record<string, unknown>;
  role: string;
  configDir?: string;
  cliArgs?: Record<string, unknown>;
  noInteractive?: boolean;
}): Promise<Record<string, unknown>> {
  const missing = collectMissingPrompts({
    schema: options.schema,
    role: options.role,
    configDir: options.configDir,
    cliArgs: options.cliArgs,
  });
  if (missing.length === 0) return {};

  // Non-interactive: fail with actionable error
  if (!isInteractive(options.noInteractive)) {
    const lines = missing.map((m) => {
      // Find the env var from the field schema
      const envHint = findEnvVar(options.schema, m.dotPath);
      const envStr = envHint ? `  (env: ${envHint})` : "";
      return `  ${m.dotPath}${envStr}`;
    });
    throw new Error(
      `Missing required configuration:\n${lines.join("\n")}\n\n` +
        `Provide values via environment variables, config file (${defaultHome()}/server.yaml),\n` +
        "or run without --no-interactive to use the interactive setup wizard.",
    );
  }

  // Interactive: prompt for each missing field
  const configDir = options.configDir ?? defaultConfigDir();
  const configPath = join(configDir, `${options.role}.yaml`);
  const results: Record<string, unknown> = {};

  for (const { dotPath, prompt } of missing) {
    const value = await askPrompt(dotPath, prompt);
    if (value !== undefined) {
      setConfigValue(configPath, dotPath, value);
      setNestedByDot(results, dotPath, value);
    }
  }

  return results;
}

/**
 * Interactive / scripted "add this agent to the local client".
 *
 * Phase 3 of the agent-naming refactor removed the free-form local
 * alias — the local config dir is keyed by the server-authoritative
 * `agent.name` slug. This helper only asks the user for the agent UUID
 * (or takes it via `opts.agentId`), then fetches the canonical name
 * from the server. A `name` comes back null only if the agent was
 * tombstoned server-side, in which case the caller must refuse the
 * add (there's nothing sensible to key the local dir on).
 */
export async function promptAddAgent(opts: { agentId?: string } = {}): Promise<{ name: string; agentId: string }> {
  // Phase 3 needs a live server to resolve the canonical agent name, which
  // means the caller must have run `login <code>` first. Detect the
  // two common "not connected yet" states up front with a clear error
  // instead of letting `ensureFreshAccessToken` or `resolveServerUrl`
  // throw a cryptic message after the user already typed a UUID.
  if (loadCredentials() === null) {
    throw new Error(`Not connected. Run \`${channelConfig.binName} login <code>\` first.`);
  }
  let serverUrl: string;
  try {
    serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${msg} Run \`${channelConfig.binName} login <code>\` or set FIRST_TREE_SERVER_URL.`);
  }

  const agentId =
    opts.agentId ??
    (await input({
      message: "Agent UUID on the First Tree server:",
      validate: (v) => (v.length > 0 ? true : "Agent UUID is required"),
    }));

  // Bound at the destination this flow just resolved: the token cannot be
  // handed to a different server by a later load or refresh (SEC-023).
  const credential = await credentialForOrigin(serverUrl);
  const res = await cliFetch(`${serverUrl}/api/v1/agents/${encodeURIComponent(agentId)}`, {
    headers: { Authorization: `Bearer ${credential.token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Failed to look up agent ${agentId}: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { name: string | null };
  if (!body.name) {
    throw new Error(
      `Agent ${agentId} has no server-side name (tombstoned or never named). Cannot add a local config without a name.`,
    );
  }
  return { name: body.name, agentId };
}

// ── Internal ─────────────────────────────────────────────────────────

async function askPrompt(dotPath: string, prompt: PromptDef): Promise<unknown> {
  const type = prompt.type ?? "input";

  if (type === "select" && prompt.choices) {
    const value = await select({
      message: prompt.message,
      choices: prompt.choices.map((c) => ({ name: c.name, value: c.value })),
    });

    // Special value "__auto__" means "use auto-generation, don't set a value"
    if (value === "__auto__") return undefined;

    // Special value "__input__" means "follow up with a text input"
    if (value === "__input__") {
      return input({
        message: `${dotPath}:`,
        validate: (v) => (v.length > 0 ? true : "Value is required"),
      });
    }

    return value;
  }

  if (type === "password") {
    return password({ message: prompt.message });
  }

  return input({
    message: prompt.message,
    default: prompt.default,
  });
}

/** Walk schema to find the env var name for a given dot path. */
function findEnvVar(schema: Record<string, unknown>, dotPath: string): string | undefined {
  const parts = dotPath.split(".");
  let current: unknown = schema;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    const obj = current as Record<string, unknown>;
    if (obj._tag === "optional") {
      current = (obj.shape as Record<string, unknown>)[part];
    } else {
      current = obj[part];
    }
  }
  if (typeof current === "object" && current !== null && "_tag" in current) {
    const field = current as { _tag: string; options?: { env?: string } };
    if (field._tag === "field") return field.options?.env;
  }
  return undefined;
}

function setNestedByDot(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (key === undefined) continue;
    if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = parts.at(-1);
  if (lastKey !== undefined) {
    current[lastKey] = value;
  }
}
