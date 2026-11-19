import type { Command } from "commander";
import { credentialForOrigin } from "../../../core/access-token.js";
import { resolveServerUrl } from "../../../core/bootstrap.js";
import { getCurrent, printConfig, resolveAgentRecord } from "./_shared/fetchers.js";

export function registerAgentConfigShowCommand(config: Command): void {
  config
    .command("show <agent>")
    .description("Show the current runtime config for an agent")
    .action(async (agentName: string) => {
      const serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
      const credential = await credentialForOrigin(serverUrl);
      const { uuid } = await resolveAgentRecord(serverUrl, credential, agentName);
      const cfg = await getCurrent(serverUrl, credential, uuid);
      printConfig(cfg);
    });
}
