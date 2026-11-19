import type {
  AgentResourcesOutput,
  AgentRuntimeConfig,
  AgentRuntimeConfigPatch,
  UpdateAgentResources,
} from "@first-tree/shared";
import { fail } from "../../../../cli/output.js";
import { cliFetch } from "../../../../core/cli-fetch.js";
import { assertBoundCredentialOrigin, type BoundCredential } from "../../../../core/credential-origin.js";
import { type ResolvedAgent, resolveAgent } from "../../../_shared/resolve-agent.js";

/**
 * Shared helpers for the `agent config ...` subcommands. Every command is a
 * thin wrapper over the resource-scoped HTTP API:
 *
 *     GET    /api/v1/agents/:id/config
 *     PATCH  /api/v1/agents/:id/config
 *     POST   /api/v1/agents/:id/config/dry-run
 *
 * Sensitive env values are returned masked from the server (***).
 */

export type { ResolvedAgent };

export async function resolveAgentRecord(
  serverUrl: string,
  credential: BoundCredential,
  agentName: string,
): Promise<ResolvedAgent> {
  // The pair is checked against the destination this helper actually calls, so
  // the guarantee does not fall back to "is this token in the file right now".
  assertBoundCredentialOrigin(serverUrl, credential);
  return resolveAgent(serverUrl, credential.token, agentName);
}

export async function adminFetch<T>(url: string, init: RequestInit & { credential: BoundCredential }): Promise<T> {
  const { credential, headers, ...rest } = init;
  // Bound at the URL being called (SEC-023): the origin travels with the token,
  // so a credential obtained once for one server cannot be spent on another.
  assertBoundCredentialOrigin(url, credential);
  const res = await cliFetch(url, {
    ...rest,
    headers: {
      Authorization: `Bearer ${credential.token}`,
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
      ...(headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text();
    fail(`HTTP_${res.status}`, text || res.statusText, res.status === 401 ? 3 : 1);
  }
  return (await res.json()) as T;
}

export async function getCurrent(
  serverUrl: string,
  credential: BoundCredential,
  agentId: string,
): Promise<AgentRuntimeConfig> {
  return adminFetch<AgentRuntimeConfig>(`${serverUrl}/api/v1/agents/${agentId}/config`, {
    method: "GET",
    credential,
  });
}

export async function patchConfig(
  serverUrl: string,
  credential: BoundCredential,
  agentId: string,
  expectedVersion: number,
  patch: AgentRuntimeConfigPatch,
): Promise<AgentRuntimeConfig> {
  return adminFetch<AgentRuntimeConfig>(`${serverUrl}/api/v1/agents/${agentId}/config`, {
    method: "PATCH",
    credential,
    body: JSON.stringify({ expectedVersion, payload: patch }),
  });
}

export async function getAgentResources(
  serverUrl: string,
  credential: BoundCredential,
  agentId: string,
): Promise<AgentResourcesOutput> {
  return adminFetch<AgentResourcesOutput>(`${serverUrl}/api/v1/agents/${agentId}/resources`, {
    method: "GET",
    credential,
  });
}

export async function patchAgentResources(
  serverUrl: string,
  credential: BoundCredential,
  agentId: string,
  body: UpdateAgentResources,
): Promise<AgentResourcesOutput> {
  return adminFetch<AgentResourcesOutput>(`${serverUrl}/api/v1/agents/${agentId}/resources`, {
    method: "PATCH",
    credential,
    body: JSON.stringify(body),
  });
}

export function printConfig(cfg: AgentRuntimeConfig): void {
  process.stdout.write(`Agent: ${cfg.agentId}\n`);
  process.stdout.write(`Version: ${cfg.version} (updated ${cfg.updatedAt} by ${cfg.updatedBy})\n`);
  process.stdout.write(`\nModel:    ${cfg.payload.model || "(unset)"}\n`);
  // Cursor payloads have no effort channel — the row would only mislead.
  if ("reasoningEffort" in cfg.payload) {
    process.stdout.write(
      `Reasoning effort: ${cfg.payload.reasoningEffort || "(unset — inherits local effortLevel)"}\n`,
    );
  }
  if ("serviceTier" in cfg.payload) {
    process.stdout.write(`Service tier: ${cfg.payload.serviceTier}\n`);
  }
  const promptSections = cfg.payload.prompt.sections ?? [];
  if (promptSections.length > 0) {
    process.stdout.write(`Effective prompt stack (${promptSections.length} section(s); resolved team + agent):\n`);
    for (const section of promptSections) {
      // Agent scope splits on `editable`: only the standalone fragment is the
      // thing `prompt set` owns; the rest are resource-binding overrides.
      const label =
        section.scope === "agent"
          ? section.editable === true
            ? "per-agent fragment"
            : `${section.name || "agent prompt override"} (override; managed via resource bindings)`
          : section.name || "team prompt";
      process.stdout.write(`  - [${section.scope}] ${label} (${section.body.length} chars)\n`);
    }
    process.stdout.write(
      "  (read/write the per-agent fragment with `agent config prompt show --raw` / `prompt set`)\n",
    );
  } else {
    process.stdout.write(`Prompt append: ${cfg.payload.prompt.append ? "(set)" : "(empty)"}\n`);
    if (cfg.payload.prompt.append) process.stdout.write(`  > ${cfg.payload.prompt.append.replace(/\n/g, "\n  > ")}\n`);
  }
  process.stdout.write(`\nMCP servers (${cfg.payload.mcpServers.length}):\n`);
  for (const s of cfg.payload.mcpServers) {
    process.stdout.write(`  - ${s.name} [${s.transport}]\n`);
  }
  process.stdout.write(`\nEnv (${cfg.payload.env.length}):\n`);
  for (const e of cfg.payload.env) {
    process.stdout.write(`  - ${e.key}=${e.value} ${e.sensitive ? "(sensitive)" : ""}\n`);
  }
  process.stdout.write(`\nGit repos (${cfg.payload.gitRepos.length}):\n`);
  for (const r of cfg.payload.gitRepos) {
    const ref = r.ref ? `@${r.ref}` : "";
    const path = r.localPath ? ` → ${r.localPath}` : "";
    process.stdout.write(`  - ${r.url}${ref}${path}\n`);
  }
}
