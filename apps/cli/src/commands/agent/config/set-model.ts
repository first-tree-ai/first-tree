import type { Command } from "commander";
import { success } from "../../../cli/output.js";
import { credentialForOrigin } from "../../../core/access-token.js";
import { resolveServerUrl } from "../../../core/bootstrap.js";
import { getCurrent, patchConfig, resolveAgentRecord } from "./_shared/fetchers.js";

export function registerAgentConfigSetModelCommand(config: Command): void {
  config
    .command("set-model <agent> <model>")
    .description("Replace the model field (alias: opus, sonnet, haiku — or a full id like claude-opus-4-7)")
    .action(async (agentName: string, model: string) => {
      const serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
      const credential = await credentialForOrigin(serverUrl);
      const { uuid } = await resolveAgentRecord(serverUrl, credential, agentName);
      const current = await getCurrent(serverUrl, credential, uuid);
      const updated = await patchConfig(serverUrl, credential, uuid, current.version, { model });
      success({ agentId: updated.agentId, version: updated.version, model: updated.payload.model });
    });
}
