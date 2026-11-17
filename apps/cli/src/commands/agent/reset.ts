import type { Command } from "commander";
import { fail } from "../../cli/output.js";
import { accessTokenForOrigin } from "../../core/access-token.js";
import { resolveServerUrl } from "../../core/bootstrap.js";
import { cliFetch } from "../../core/cli-fetch.js";
import { print } from "../../core/output.js";

export function registerAgentResetCommand(agent: Command): void {
  agent
    .command("reset <name>")
    .description("Reset agent error state to idle")
    .option("--server <url>", "First Tree server URL")
    .action(async (name: string, options: { server?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options.server);
        const response = await cliFetch(`${serverUrl}/api/v1/agents/${name}/reset-activity`, {
          method: "POST",
          headers: { Authorization: `Bearer ${await accessTokenForOrigin(serverUrl)}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          fail("RESET_ERROR", `Server returned ${response.status}`, 1);
        }
        print.line(`  Agent "${name}" reset to idle.\n`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("RESET_ERROR", msg);
      }
    });
}
