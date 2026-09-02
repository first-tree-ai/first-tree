import { z } from "zod";
import { logLevelSchema } from "../observability/logger-core.js";
import { UPDATE_POLICIES, UPDATE_POLICY_DEFAULT } from "./phase.js";
import { resolveConfigReadonly } from "./resolver.js";
import { defineConfig, field } from "./schema.js";
import { getConfig } from "./singleton.js";
import type { InferConfig } from "./types.js";

export const updatePolicySchema = z.enum(UPDATE_POLICIES);

/**
 * A GitHub OWNER/REPO this machine may delegate its Context Tree to.
 *
 * The owner segment follows GitHub's own rule — alphanumeric and hyphens, no
 * leading or trailing hyphen, at most 39 characters — and the repository segment
 * rejects `.` and `..`. It deliberately matches what the external
 * `@first-tree-ai/context-tree` CLI accepts: setting this key alone switches the
 * runtime into external mode and stands down First Tree's own Tree Skills, so a
 * value the external CLI can never connect to would disable working Skills in
 * exchange for nothing.
 */
export const CONTEXT_TREE_REPOSITORY_PATTERN =
  /^[A-Za-z\d](?:[A-Za-z\d-]{0,37}[A-Za-z\d])?\/(?!\.{1,2}$)[A-Za-z\d._-]{1,100}$/;

export const clientConfigSchema = defineConfig({
  server: {
    url: field(z.string(), {
      env: "FIRST_TREE_SERVER_URL",
      prompt: { message: "Server URL:", default: "http://localhost:8000" },
    }),
  },
  client: {
    // Stable per-machine client identifier. Auto-generated on first start and
    // written back to client.yaml so the SDK keeps the same id across
    // restarts — agents pin to `clients.id` on the server, so a fresh random
    // id every run would orphan every pinned agent (Rule R-RUN WRONG_CLIENT).
    id: field(z.string().regex(/^client_[a-f0-9]{8}$/), {
      auto: "client-id",
      env: "FIRST_TREE_CLIENT_ID",
    }),
  },
  update: {
    policy: field(updatePolicySchema.default(UPDATE_POLICY_DEFAULT), {
      env: "FIRST_TREE_UPDATE_POLICY",
    }),
    restart_quiet_seconds: field(z.number().int().min(1).max(3600).default(30), {
      env: "FIRST_TREE_UPDATE_RESTART_QUIET_SECONDS",
    }),
    restart_check_interval_seconds: field(z.number().int().min(5).max(300).default(10), {
      env: "FIRST_TREE_UPDATE_RESTART_CHECK_INTERVAL_SECONDS",
    }),
    prompt_timeout_seconds: field(z.number().int().min(10).max(600).default(60), {
      env: "FIRST_TREE_UPDATE_PROMPT_TIMEOUT_SECONDS",
    }),
  },
  context_tree: {
    // GitHub OWNER/REPO of the Context Tree this machine should use through the
    // external `@first-tree-ai/context-tree` CLI. Setting it is the single switch
    // into external mode: the CLI installs the `context-tree-*` Skills and the
    // Client stands down the overlapping `first-tree-{read,write,seed}`
    // projection, so the Agent is never offered two ways to do the same job.
    // Unset means this machine keeps First Tree's own Context Tree Skills.
    repository: field(
      z
        .string()
        .regex(CONTEXT_TREE_REPOSITORY_PATTERN, "Context Tree repository must be GitHub OWNER/REPO.")
        .optional(),
      { env: "FIRST_TREE_CONTEXT_TREE_REPOSITORY" },
    ),
  },
  logLevel: field(logLevelSchema.default("info"), { env: "FIRST_TREE_LOG_LEVEL" }),
});

export type ClientConfig = InferConfig<typeof clientConfigSchema>;

/** Typed accessor for client configuration singleton. */
export function getClientConfig(): ClientConfig {
  return getConfig<ClientConfig>();
}

/**
 * The GitHub OWNER/REPO configured for external Context Tree mode, or `null`.
 *
 * Read straight off `client.yaml` rather than through {@link getClientConfig},
 * because the callers that need it — the CLI's `login` path and the standalone
 * `AgentRuntime` boot path — do not always initialize the config singleton.
 *
 * Never throws: an unreadable or malformed config means "external mode off",
 * which is a healthy state, so resolution falls through to the server-bound
 * behaviour rather than failing a login or a session start.
 *
 * The pattern is re-checked here rather than left to the field schema because
 * `resolveConfigReadonly` returns file values unvalidated. Without this check a
 * repository the external CLI rejects would still switch the machine into
 * external mode and stand down the Skills it was meant to replace.
 */
export function readContextTreeRepository(): string | null {
  let resolved: Record<string, unknown>;
  try {
    resolved = resolveConfigReadonly({ schema: clientConfigSchema, role: "client" });
  } catch {
    return null;
  }
  const group = resolved.context_tree;
  if (typeof group !== "object" || group === null) return null;
  const repository = (group as Record<string, unknown>).repository;
  if (typeof repository !== "string" || !CONTEXT_TREE_REPOSITORY_PATTERN.test(repository)) return null;
  return repository;
}
