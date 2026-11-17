import type { Command } from "commander";
import { success } from "../../../cli/output.js";
import { credentialForOrigin } from "../../../core/access-token.js";
import { resolveServerUrl } from "../../../core/bootstrap.js";
import { getCurrent, patchConfig, resolveAgentRecord } from "./_shared/fetchers.js";

export function registerAgentConfigSetServiceTierCommand(config: Command): void {
  config
    .command("set-service-tier <agent> <tier>")
    .description(
      "Set the Codex provider-native service tier (default = Standard, fast = Fast, or another provider-advertised id)",
    )
    .action(async (agentName: string, serviceTier: string) => {
      const serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
      const credential = await credentialForOrigin(serverUrl);
      const { uuid } = await resolveAgentRecord(serverUrl, credential, agentName);
      const current = await getCurrent(serverUrl, credential, uuid);
      const updated = await patchConfig(serverUrl, credential, uuid, current.version, { serviceTier });
      success({
        agentId: updated.agentId,
        version: updated.version,
        serviceTier: "serviceTier" in updated.payload ? updated.payload.serviceTier : undefined,
      });
    });
}
