import { canonicalizeResourceRepoUrl } from "@first-tree/shared";
import type { Command } from "commander";
import { success } from "../../../cli/output.js";
import { credentialForOrigin } from "../../../core/access-token.js";
import { resolveServerUrl } from "../../../core/bootstrap.js";
import { getAgentResources, patchAgentResources, resolveAgentRecord } from "./_shared/fetchers.js";

export function registerAgentConfigAddRepoCommand(config: Command): void {
  config
    .command("add-repo <agent> <url>")
    .description("Add a Git repo to the agent's worktree set")
    .option("--ref <ref>", "branch / tag / commit (defaults to repo HEAD)")
    .option("--path <path>", "local path relative to session cwd")
    .action(async (agentName: string, url: string, opts: { ref?: string; path?: string }) => {
      const serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
      const credential = await credentialForOrigin(serverUrl);
      const { uuid } = await resolveAgentRecord(serverUrl, credential, agentName);
      const current = await getAgentResources(serverUrl, credential, uuid);
      const targetCanonical = safeCanonicalRepoUrl(url);
      const matchingResourceIds = new Set<string>();
      let matchingTeamResourceId: string | null = null;
      if (targetCanonical) {
        for (const resource of current.availableTeamResources) {
          const payload = resource.payload as { url?: unknown };
          if (typeof payload.url === "string" && safeCanonicalRepoUrl(payload.url) === targetCanonical) {
            matchingResourceIds.add(resource.id);
            matchingTeamResourceId ??= resource.id;
          }
        }
        for (const row of current.effective.repos) {
          const repoUrl = row.repo?.url ?? ((row.payload as { url?: unknown } | null)?.url as string | undefined);
          if (row.resourceId && typeof repoUrl === "string" && safeCanonicalRepoUrl(repoUrl) === targetCanonical) {
            matchingResourceIds.add(row.resourceId);
            if (row.scope === "team") matchingTeamResourceId ??= row.resourceId;
          }
        }
      }
      const removedOrders: number[] = [];
      const remaining = current.bindings.filter((binding) => {
        if (binding.type !== "repo") return true;
        const agentRepoUrl = binding.agentExtraRepo?.url;
        const matchesAgentRepo =
          targetCanonical && typeof agentRepoUrl === "string" && safeCanonicalRepoUrl(agentRepoUrl) === targetCanonical;
        const matchesResource = !!binding.resourceId && matchingResourceIds.has(binding.resourceId);
        if ((matchesAgentRepo || matchesResource) && binding.order !== undefined) removedOrders.push(binding.order);
        return !matchesAgentRepo && !matchesResource;
      });
      const updated = await patchAgentResources(serverUrl, credential, uuid, {
        expectedVersion: current.version,
        bindings: [
          ...remaining,
          matchingTeamResourceId
            ? {
                type: "repo",
                mode: "include",
                resourceId: matchingTeamResourceId,
                repoRef: opts.ref,
                repoLocalPath: opts.path,
                order: removedOrders.length > 0 ? Math.min(...removedOrders) : remaining.length + 1,
              }
            : {
                type: "repo",
                mode: "include",
                agentExtraRepo: { url },
                repoRef: opts.ref,
                repoLocalPath: opts.path,
                order: removedOrders.length > 0 ? Math.min(...removedOrders) : remaining.length + 1,
              },
        ],
      });
      success({ agentId: uuid, version: updated.version, repo: url });
    });
}

function safeCanonicalRepoUrl(url: string): string | null {
  try {
    return canonicalizeResourceRepoUrl(url);
  } catch {
    return null;
  }
}
