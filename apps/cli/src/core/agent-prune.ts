import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { AGENT_NAME_REGEX } from "@first-tree/shared";
import { defaultConfigDir, defaultDataDir } from "@first-tree/shared/config";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Why a local alias is no longer usable from this client. Surfaced to
 * operators in `client doctor` and `agent prune` — knowing *why* a dir is
 * stale changes the next action (delete vs. go run it on the other machine).
 *
 * - `unreadable`        — agent.yaml missing, malformed, or has no agentId.
 * - `unowned`           — server doesn't return this agentId at all under
 *                         the current user (deleted, or never owned).
 * - `pinned-elsewhere`  — agentId belongs to the user but is pinned to a
 *                         *different* client. R-RUN would reject `bind`
 *                         on this machine; the agent is alive on the other.
 *
 * Suspended agents pinned to this client are not stale. The server still
 * returns them from `/me/pinned-agents` with `status: "suspended"` so prune
 * keeps their local config/workspace/session state for future reactivation.
 */
export type StaleAliasReason =
  | { kind: "unreadable"; error: string }
  | { kind: "unowned" }
  | { kind: "pinned-elsewhere"; clientId: string };

export type StaleAlias = {
  name: string;
  /** Null when the YAML couldn't be parsed enough to extract an agentId. */
  agentId: string | null;
  reason: StaleAliasReason;
};

export type PinnedAgent = { agentId: string; clientId: string; status?: string };

const minimalAgentYamlSchema = z
  .object({
    agentId: z.string().min(1),
  })
  .passthrough();

/**
 * Cross-reference local `agents/<name>/agent.yaml` files against the
 * server's pinned-agent set, returning every alias that won't bind on
 * THIS client.
 *
 * Why we don't use `loadAgents`:
 * `shared/config/loader.loadAgents` is fail-fast — one malformed
 * agent.yaml throws and the whole scan dies. The dominant prune target
 * IS the malformed dir (typo `agent add d`, half-written yaml, missing
 * agentId), so we walk dirs ourselves and degrade per-entry instead.
 *
 * Why we filter by clientId, not just userId:
 * `listPinnedAgents` (`/api/v1/me/pinned-agents`) returns every agent
 * pinned to ANY client this user owns (cross-machine). For prune the
 * relevant question is "will R-RUN accept it on THIS machine", which
 * needs `agents.client_id === current client.id`. Anything pinned on
 * another client is reported with `pinned-elsewhere` so the operator
 * can either re-pin or delete the local alias deliberately.
 */
export async function findStaleAliases(opts: {
  clientId: string;
  listPinnedAgents: () => Promise<PinnedAgent[]>;
  /** Override for tests; defaults to `$FIRST_TREE_HOME/config/agents`. */
  agentsDir?: string;
}): Promise<StaleAlias[]> {
  const agentsDir = opts.agentsDir ?? join(defaultConfigDir(), "agents");
  if (!existsSync(agentsDir)) return [];

  const remote = await opts.listPinnedAgents();
  const pinnedHere = new Set<string>();
  const pinnedElsewhere = new Map<string, string>();
  for (const r of remote) {
    if (r.clientId === opts.clientId) pinnedHere.add(r.agentId);
    else pinnedElsewhere.set(r.agentId, r.clientId);
  }

  const stale: StaleAlias[] = [];
  for (const entry of readdirSync(agentsDir)) {
    const agentDir = join(agentsDir, entry);
    let isDir = false;
    try {
      isDir = statSync(agentDir).isDirectory();
    } catch {
      // Vanished between readdir and stat; ignore.
      continue;
    }
    if (!isDir) continue;

    const yamlPath = join(agentDir, "agent.yaml");
    if (!existsSync(yamlPath)) {
      stale.push({ name: entry, agentId: null, reason: { kind: "unreadable", error: "missing agent.yaml" } });
      continue;
    }

    let agentId: string;
    try {
      const raw = parseYaml(readFileSync(yamlPath, "utf-8")) as unknown;
      const parsed = minimalAgentYamlSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0]?.message ?? "schema error";
        stale.push({ name: entry, agentId: null, reason: { kind: "unreadable", error: issue } });
        continue;
      }
      agentId = parsed.data.agentId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stale.push({ name: entry, agentId: null, reason: { kind: "unreadable", error: msg } });
      continue;
    }

    if (pinnedHere.has(agentId)) continue;

    const otherClient = pinnedElsewhere.get(agentId);
    if (otherClient !== undefined) {
      stale.push({ name: entry, agentId, reason: { kind: "pinned-elsewhere", clientId: otherClient } });
    } else {
      stale.push({ name: entry, agentId, reason: { kind: "unowned" } });
    }
  }

  return stale;
}

/** Human-readable suffix for the per-alias listing. */
export function formatStaleReason(reason: StaleAliasReason): string {
  switch (reason.kind) {
    case "unreadable":
      return `unreadable: ${reason.error}`;
    case "unowned":
      return "no longer owned by you (deleted or transferred)";
    case "pinned-elsewhere":
      return `pinned to another client: ${reason.clientId}`;
  }
}

/**
 * Remove an agent's local footprint: the YAML alias dir, the workspace
 * tree under `data/workspaces/<name>`, and the session-mapping file under
 * `data/sessions/<name>.json`. Mirrors what `agent remove` does, exposed
 * separately so prune and the post-rotation override cleanup can share it.
 *
 * SEC-030: the name ends up in three recursive deletions, so it is validated
 * against the canonical schema and each resolved target must still sit inside
 * its state root. Without both checks a traversal name (`../../x`) deletes
 * writable files outside First Tree state.
 */
export function removeLocalAgent(name: string): void {
  if (!AGENT_NAME_REGEX.test(name)) {
    throw new Error(`Refusing to remove local agent "${name}": not a canonical agent name.`);
  }
  removeWithinStateRoot(defaultConfigDir(), join("agents", name));
  removeWithinStateRoot(defaultDataDir(), join("workspaces", name));
  removeWithinStateRoot(defaultDataDir(), join("sessions", `${name}.json`));
}

/** Delete `relative` under `root`, refusing anything that resolves outside it. */
function removeWithinStateRoot(root: string, relative: string): void {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, relative);
  if (target === resolvedRoot || !target.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`Refusing to delete ${target}: it is outside ${resolvedRoot}.`);
  }
  rmSync(target, { recursive: true, force: true });
}
