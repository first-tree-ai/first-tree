import { join } from "node:path";
import { FirstTreeHubSDK } from "@first-tree/client";
import { defaultDataDir } from "@first-tree/shared/config";
import { confirm } from "@inquirer/prompts";
import type { Command } from "commander";
import { fail } from "../../cli/output.js";
import { accessTokenForOrigin } from "../../core/access-token.js";
import {
  CLI_USER_AGENT,
  findStaleAliases,
  formatStaleReason,
  localContextDataLossForAgent,
  removeLocalAgent,
  resolveServerUrl,
} from "../../core/index.js";
import { print } from "../../core/output.js";
import { readClientId } from "../_shared/local-agent.js";

/**
 * `agent prune` — drop local aliases the server no longer
 * pins to me. Counterpart to `daemon doctor`'s "stale aliases" warning.
 * Walks the local `agents/<name>/` dirs and removes any whose `agentId` is
 * not returned by `/api/v1/me/pinned-agents`. Common after an agent was
 * deleted server-side, pinned to another client, or after a typo `agent add`
 * left a junk dir.
 */
export function registerAgentPruneCommand(agent: Command): void {
  agent
    .command("prune")
    .description("Remove local agent aliases that won't bind on this client (unowned, pinned elsewhere, or unreadable)")
    .option("--yes", "Skip the interactive confirmation prompt")
    .option("--dry-run", "Only list what would be removed; don't touch the filesystem")
    .option("--server <url>", "First Tree server URL")
    .action(async (options: { yes?: boolean; dryRun?: boolean; server?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options.server);
        const clientId = readClientId();
        const sdk = new FirstTreeHubSDK({
          serverUrl,
          getAccessToken: (opts) => accessTokenForOrigin(serverUrl, opts),
          userAgent: CLI_USER_AGENT,
        });
        const stale = await findStaleAliases({
          clientId,
          listPinnedAgents: () => sdk.listMyAgents(),
        });

        if (stale.length === 0) {
          print.line("\n  ✓ No stale agent aliases. Local config matches the server.\n\n");
          return;
        }

        print.line(`\n  ${stale.length} stale ${stale.length === 1 ? "alias" : "aliases"}:\n\n`);
        for (const s of stale) {
          const id = s.agentId ?? "—";
          print.line(`    - ${s.name.padEnd(30)} ${id.padEnd(38)} ${formatStaleReason(s.reason)}\n`);
          const localContext = localContextDataLossForAgent(join(defaultDataDir(), "workspaces"), s.name);
          if (localContext) {
            print.line(`      unmigrated Local Context will be permanently deleted: ${localContext.path}\n`);
          }
        }
        print.line("\n");

        if (options.dryRun) {
          print.line("  Dry run — no files removed. Re-run without --dry-run to delete.\n\n");
          return;
        }

        if (!options.yes) {
          const approved = await confirm({
            message: `Remove the ${stale.length} stale ${stale.length === 1 ? "alias" : "aliases"} above (config + workspace + session state)?`,
            default: false,
          }).catch(() => false);
          if (!approved) {
            print.line("  Cancelled.\n\n");
            return;
          }
        }

        // Per-alias try/catch so a single permission/lock error doesn't
        // skip the rest of the cleanup. Failures are reported inline; the
        // user can re-run prune to retry the failed entries.
        let removed = 0;
        let failed = 0;
        for (const s of stale) {
          try {
            removeLocalAgent(s.name);
            print.line(`  ✓ removed ${s.name}\n`);
            removed++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            print.line(`  ✗ ${s.name} (${msg.slice(0, 80)})\n`);
            failed++;
          }
        }
        print.line(`\n  ${removed} pruned${failed > 0 ? `, ${failed} failed (re-run to retry)` : ""}.\n\n`);
        if (failed > 0) process.exitCode = 1;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("PRUNE_ERROR", msg);
      }
    });
}
