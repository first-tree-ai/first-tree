import type { Command } from "commander";
import { fail } from "../../../cli/output.js";
import { accessTokenForOrigin } from "../../../core/access-token.js";
import { resolveServerUrl } from "../../../core/bootstrap.js";
import { cliFetch } from "../../../core/cli-fetch.js";
import { print } from "../../../core/output.js";
import { resolveAgent } from "../../_shared/resolve-agent.js";

export function registerAgentSessionListCommand(sessionCmd: Command): void {
  sessionCmd
    .command("list <agent-name>")
    .description("List sessions for an agent")
    .option("--server <url>", "First Tree server URL")
    .option("--state <state>", "Filter by session state (active/suspended/evicted)")
    .action(async (agentName: string, options: { server?: string; state?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options.server);
        const adminToken = await accessTokenForOrigin(serverUrl);
        const agentId = (await resolveAgent(serverUrl, adminToken, agentName)).uuid;
        const qs = options.state ? `?state=${options.state}` : "";
        const response = await cliFetch(`${serverUrl}/api/v1/agents/${agentId}/sessions${qs}`, {
          headers: { Authorization: `Bearer ${adminToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          fail("FETCH_ERROR", `Server returned ${response.status}`, 1);
        }
        const sessions = (await response.json()) as Array<{
          chatId: string;
          state: string;
          runtimeState: string | null;
          lastActivityAt: string;
        }>;
        if (sessions.length === 0) {
          print.line(`\n  No sessions for "${agentName}".\n\n`);
          return;
        }
        print.line(`\n  Sessions for "${agentName}":\n\n`);
        const header = `  ${"CHAT".padEnd(40)} ${"STATE".padEnd(12)} ${"RUNTIME".padEnd(10)} LAST ACTIVITY`;
        print.line(`${header}\n`);
        print.line(`  ${"─".repeat(header.length - 2)}\n`);
        for (const s of sessions) {
          const chatShort = s.chatId.length > 38 ? `${s.chatId.slice(0, 35)}...` : s.chatId;
          print.line(
            `  ${chatShort.padEnd(40)} ${s.state.padEnd(12)} ${(s.runtimeState ?? "—").padEnd(10)} ${s.lastActivityAt}\n`,
          );
        }
        print.line("\n");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("SESSIONS_ERROR", msg);
      }
    });
}
