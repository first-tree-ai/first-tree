import type { Command } from "commander";
import { fail, success } from "../../../cli/output.js";
import { accessTokenForOrigin } from "../../../core/access-token.js";
import { resolveServerUrl } from "../../../core/bootstrap.js";
import { channelConfig } from "../../../core/channel.js";
import { cliFetch } from "../../../core/cli-fetch.js";
import { print } from "../../../core/output.js";
import { resolveAgent } from "../../_shared/resolve-agent.js";

export function registerAgentBindClientCommand(bind: Command): void {
  bind
    .command("client <agentName>")
    .description("Bind an unbound agent to a client machine (first-time bind only; use runtime switch to move later)")
    .requiredOption(
      "--client-id <id>",
      `Client (machine) ID — must be owned by you. Run \`${channelConfig.binName} login <code>\` on that machine first.`,
    )
    .option("--server <url>", "First Tree server URL")
    .action(async (agentName: string, options: { clientId: string; server?: string }) => {
      try {
        const serverUrl = resolveServerUrl(options.server);
        const accessToken = await accessTokenForOrigin(serverUrl);
        const target = await resolveAgent(serverUrl, accessToken, agentName);

        const patchRes = await cliFetch(`${serverUrl}/api/v1/agents/${target.uuid}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ clientId: options.clientId }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!patchRes.ok) {
          const body = (await patchRes.json().catch(() => ({}))) as { error?: string };
          fail("BIND_CLIENT_ERROR", body.error ?? `Bind failed (HTTP ${patchRes.status})`, 1);
        }
        print.line(`  ✓ Bound "${target.name ?? target.uuid}" to client ${options.clientId}.\n`);
        success({ agentId: target.uuid, clientId: options.clientId });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        fail("BIND_CLIENT_ERROR", msg);
      }
    });
}
