import type { Command } from "commander";
import { fail } from "../../../cli/output.js";
import { accessTokenForOrigin } from "../../../core/access-token.js";
import { resolveServerUrl } from "../../../core/bootstrap.js";
import { cliFetch } from "../../../core/cli-fetch.js";
import { print } from "../../../core/output.js";
import { resolveAgent } from "../../_shared/resolve-agent.js";

/**
 * `agent session suspend` / `agent session terminate` — the two control verbs
 * share their entire handler shape. Defined together so a future verb only
 * needs to extend the loop, not duplicate the boilerplate.
 */
export function registerAgentSessionControlCommands(sessionCmd: Command): void {
  for (const [cmd, desc] of [
    ["suspend", "Suspend a session"],
    ["resume", "Resume a suspended session"],
    ["terminate", "Terminate a session"],
  ] as const) {
    sessionCmd
      .command(`${cmd} <agent-name> <chat-id>`)
      .description(desc)
      .option("--server <url>", "First Tree server URL")
      .action(async (agentName: string, chatId: string, options: { server?: string }) => {
        try {
          const serverUrl = resolveServerUrl(options.server);
          const adminToken = await accessTokenForOrigin(serverUrl);
          const agentId = (await resolveAgent(serverUrl, adminToken, agentName)).uuid;
          const response = await cliFetch(`${serverUrl}/api/v1/agents/${agentId}/sessions/${chatId}/${cmd}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${adminToken}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) {
            const body = await response.text();
            fail("SESSION_CMD_ERROR", `Server returned ${response.status}: ${body}`, 1);
          }
          print.line(`  Session ${cmd}: ${chatId} → sent\n`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          fail("SESSION_CMD_ERROR", msg);
        }
      });
  }
}
