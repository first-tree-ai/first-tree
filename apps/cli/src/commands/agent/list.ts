import { join } from "node:path";
import { agentConfigSchema, defaultConfigDir, loadAgents } from "@first-tree/shared/config";
import type { Command } from "commander";
import { fail } from "../../cli/output.js";
import { accessTokenForOrigin } from "../../core/access-token.js";
import { resolveServerUrl } from "../../core/bootstrap.js";
import { cliFetch } from "../../core/cli-fetch.js";
import { print } from "../../core/output.js";

export function registerAgentListCommand(agent: Command): void {
  agent
    .command("list")
    .description("List agents — locally-configured by default, or every agent you manage with --remote")
    // --remote / --org pull from `GET /me/managed-agents` (cross-org by
    // design — decouple-client-from-identity §4.5.1 case (b)). --org filters
    // the same response client-side; the server endpoint is unfiltered so
    // the cache works across views without an extra round-trip.
    .option("--remote", "List every agent you manage on the First Tree server (cross-org)")
    .option("--org <id>", "When listing remote, restrict to a single organization id")
    .option("--server <url>", "First Tree server URL")
    .action(async (options: { remote?: boolean; org?: string; server?: string }) => {
      const wantRemote = options.remote === true || typeof options.org === "string";
      if (!wantRemote) {
        const agentsDir = join(defaultConfigDir(), "agents");
        try {
          const agents = loadAgents({ schema: agentConfigSchema, agentsDir });
          if (agents.size === 0) {
            print.line("  No agents configured.\n");
            return;
          }
          for (const [name, config] of agents) {
            // Label the UUID column as `uuid` — NOT `agentId` — to discourage
            // agents from copy-pasting the uuid into `chat send <target>`,
            // which expects the agent name. See the First Tree agent runtime section of
            // the bootstrap-generated CLAUDE.md.
            print.line(`  ${name.padEnd(20)} runtime: ${config.runtime.padEnd(14)} uuid: ${config.agentId}\n`);
          }
        } catch {
          print.line("  No agents configured.\n");
        }
        return;
      }

      try {
        const serverUrl = resolveServerUrl(options.server);
        // Bound at resolution: the origin this token was minted for travels with
        // it, so `--server` cannot borrow another origin's credential (SEC-023).
        const token = await accessTokenForOrigin(serverUrl);
        const res = await cliFetch(`${serverUrl}/api/v1/me/managed-agents`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          fail("LIST_ERROR", `Server returned ${res.status}`, 1);
        }
        const agents = (await res.json()) as Array<{
          uuid: string;
          name: string | null;
          displayName: string;
          type: string;
          organizationId: string;
          runtimeProvider: string;
          clientId: string | null;
        }>;
        const filtered = options.org ? agents.filter((a) => a.organizationId === options.org) : agents;
        if (filtered.length === 0) {
          print.line("  No agents found.\n");
          return;
        }
        const header = `  ${"NAME".padEnd(24)} ${"TYPE".padEnd(20)} ${"RUNTIME".padEnd(14)} ${"ORG".padEnd(40)} CLIENT`;
        print.line(`${header}\n`);
        print.line(`  ${"─".repeat(header.length - 2)}\n`);
        for (const a of filtered) {
          print.line(
            `  ${(a.name ?? a.uuid).padEnd(24)} ${a.type.padEnd(20)} ${a.runtimeProvider.padEnd(14)} ${a.organizationId.padEnd(40)} ${a.clientId ?? "—"}\n`,
          );
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("LIST_ERROR", msg);
      }
    });
}
