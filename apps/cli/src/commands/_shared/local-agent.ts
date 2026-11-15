import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FirstTreeHubSDK, SdkError } from "@first-tree/client";
import {
  agentConfigSchema,
  clientConfigSchema,
  defaultConfigDir,
  defaultDataDir,
  loadAgents,
  resolveConfigReadonly,
} from "@first-tree/shared/config";
import { fail } from "../../cli/output.js";
import { accessTokenForOrigin } from "../../core/access-token.js";
import { resolveSenderName } from "../../core/agent-messaging.js";
import { resolveServerUrl } from "../../core/bootstrap.js";
import { channelConfig } from "../../core/channel.js";
import { CLI_USER_AGENT } from "../../core/version.js";

/**
 * Shared helpers for agent-scoped CLI commands (`agent ...` and `chat ...`).
 *
 * These previously duplicated across `commands/agent.ts` and `commands/chat.ts`
 * — moved to `_shared/` so both namespaces import from one place.
 */

export type ResolvedAgentConfig = {
  serverUrl: string;
  agentId: string;
  agentName: string;
  workspaceRoot: string;
};

export type ResolvedRuntimeAgentConfig = ResolvedAgentConfig & {
  runtimeSessionToken: string;
};

/**
 * Resolve the agent this CLI invocation should act on. Reads the local
 * `agents/<name>/agent.yaml` to find the agentId, then pairs it with the
 * user's current member JWT (refreshed on demand) at call time.
 *
 * `extraHint` tweaks the error message for ambiguity / env-mismatch cases so
 * each command can point the user at its own option flag (e.g. `chat send`'s
 * recipient is the next positional, not `--agent`).
 */
export function resolveLocalAgent(
  agentName?: string,
  extraHint?: { ambiguous?: string; envMismatch?: string },
): ResolvedAgentConfig {
  const agentsDir = join(defaultConfigDir(), "agents");
  const agents = loadAgents({ schema: agentConfigSchema, agentsDir });

  const resolution = resolveSenderName({
    override: agentName,
    envAgentId: process.env.FIRST_TREE_AGENT_ID,
    agents,
  });

  let resolvedName: string;
  if (resolution.kind === "ok") {
    resolvedName = resolution.name;
  } else if (resolution.kind === "none") {
    fail("MISSING_AGENT", `No agent configured. Run \`${channelConfig.binName} agent add\` first.`, 2);
  } else if (resolution.kind === "envMismatch") {
    const hint = extraHint?.envMismatch ?? "Pick one explicitly with `--agent <senderName>`.";
    fail(
      "ENV_AGENT_NOT_LOCAL",
      `FIRST_TREE_AGENT_ID="${resolution.envAgentId}" is not configured on this machine. ` +
        `Available local agents: ${resolution.available.join(", ")}. ${hint}`,
      2,
    );
  } else {
    const hint = extraHint?.ambiguous ?? "Specify it explicitly with `--agent <senderName>`.";
    fail(
      "AMBIGUOUS_AGENT",
      `Multiple agents are configured on this machine (${resolution.available.join(", ")}) and ` +
        `FIRST_TREE_AGENT_ID is not set, so the CLI can't tell which one is the sender. ${hint}`,
      2,
    );
  }
  const cfg = agents.get(resolvedName);
  if (!cfg) {
    fail("UNKNOWN_AGENT", `Agent "${resolvedName}" not found in ${agentsDir}`, 2);
  }

  let serverUrl: string;
  try {
    serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    fail("MISSING_SERVER_URL", msg, 2);
  }

  return {
    serverUrl,
    agentId: cfg.agentId,
    agentName: resolvedName,
    workspaceRoot: join(defaultDataDir(), "workspaces", resolvedName),
  };
}

/**
 * Resolve the currently running Agent, not an operator-selected alias.
 *
 * Local Context is Agent-private runtime state. Requiring the injected Agent
 * UUID prevents a shell launched outside a provider session from selecting a
 * different local alias merely because it is the only configured Agent.
 */
export function resolveRuntimeLocalAgent(): ResolvedRuntimeAgentConfig {
  const runtimeAgentId = process.env.FIRST_TREE_AGENT_ID?.trim();
  if (!runtimeAgentId) {
    fail(
      "LOCAL_CONTEXT_RUNTIME_REQUIRED",
      "Local Context can only be resolved from an active First Tree Agent runtime session.",
      2,
    );
  }

  const resolved = resolveLocalAgent();
  if (resolved.agentId !== runtimeAgentId) {
    fail(
      "LOCAL_CONTEXT_IDENTITY_MISMATCH",
      "The active runtime Agent does not match the resolved local Agent configuration.",
      2,
    );
  }

  const runtimeSessionToken = resolveRuntimeSessionToken(resolved.agentId);
  if (!runtimeSessionToken) {
    fail("LOCAL_CONTEXT_RUNTIME_PROOF_MISSING", "The active Agent runtime session proof is missing or unreadable.", 3);
  }

  return { ...resolved, runtimeSessionToken };
}

/** Build an SDK from one immutable runtime Agent resolution snapshot. */
export function createSdkFromResolvedRuntimeAgent(agent: ResolvedRuntimeAgentConfig): FirstTreeHubSDK {
  return new FirstTreeHubSDK({
    serverUrl: agent.serverUrl,
    getAccessToken: (opts) => accessTokenForOrigin(agent.serverUrl, opts),
    agentId: agent.agentId,
    runtimeSessionToken: () => agent.runtimeSessionToken,
    userAgent: CLI_USER_AGENT,
  });
}

/** Build an SDK client scoped to the resolved local agent. */
export function createSdk(agentName?: string): FirstTreeHubSDK {
  const { serverUrl, agentId } = resolveLocalAgent(agentName);
  return new FirstTreeHubSDK({
    serverUrl,
    getAccessToken: (opts) => accessTokenForOrigin(serverUrl, opts),
    agentId,
    runtimeSessionToken: () => resolveRuntimeSessionToken(agentId),
    userAgent: CLI_USER_AGENT,
  });
}

function resolveRuntimeSessionToken(agentId: string): string | undefined {
  const injectedTokenFile = process.env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE?.trim();
  const runtimeAgentId = process.env.FIRST_TREE_AGENT_ID?.trim();
  const tokenFile =
    injectedTokenFile && (!runtimeAgentId || runtimeAgentId === agentId)
      ? injectedTokenFile
      : join(defaultDataDir(), "runtime-session-tokens", `${agentId}.token`);
  try {
    return readFileSync(tokenFile, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Map an SdkError / connection error to the right CLI `fail()`. */
export function handleSdkError(error: unknown): never {
  if (error instanceof SdkError) {
    const exitCode = error.statusCode === 401 ? 3 : 1;
    fail(error.code ?? `HTTP_${error.statusCode}`, error.message, exitCode);
  }
  if (error instanceof TypeError && "cause" in error) {
    fail("CONNECTION_ERROR", `Cannot connect to server: ${error.message}`, 6);
  }
  const msg = error instanceof Error ? error.message : String(error);
  fail("UNKNOWN_ERROR", msg, 1);
}

/**
 * Read the persisted `client.id` from `client.yaml`. Required by `agent prune`
 * to filter `listMyAgents` down to "what binds on THIS machine". `fail()`
 * instead of throwing so the "no client.yaml — run login <code> first" path
 * renders as a clean CLI error rather than a stack trace.
 */
export function readClientId(): string {
  const cfg = resolveConfigReadonly({ schema: clientConfigSchema, role: "client" }) as {
    client?: { id?: unknown };
  };
  const id = cfg.client?.id;
  if (typeof id !== "string" || id.length === 0) {
    fail(
      "MISSING_CLIENT_ID",
      `No client.id found in client.yaml. Run \`${channelConfig.binName} login <code>\` first.`,
      2,
    );
  }
  return id;
}
