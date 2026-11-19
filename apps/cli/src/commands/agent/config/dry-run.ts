import { readFileSync } from "node:fs";
import type { AgentRuntimeConfig, AgentRuntimeConfigPayload } from "@first-tree/shared";
import type { Command } from "commander";
import { credentialForOrigin } from "../../../core/access-token.js";
import { resolveServerUrl } from "../../../core/bootstrap.js";
import { adminFetch, resolveAgentRecord } from "./_shared/fetchers.js";

export function registerAgentConfigDryRunCommand(config: Command): void {
  config
    .command("dry-run <agent>")
    .description("Validate a JSON patch and print the diff without persisting")
    .requiredOption("-f, --file <path>", "JSON file with the partial payload to apply")
    .action(async (agentName: string, opts: { file: string }) => {
      const serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
      const credential = await credentialForOrigin(serverUrl);
      const { uuid } = await resolveAgentRecord(serverUrl, credential, agentName);
      const patch = JSON.parse(readFileSync(opts.file, "utf-8")) as Partial<AgentRuntimeConfigPayload>;
      const result = await adminFetch<{
        current: AgentRuntimeConfig;
        next: AgentRuntimeConfigPayload;
        diff: Array<{ path: string; op: string; before?: unknown; after?: unknown }>;
      }>(`${serverUrl}/api/v1/agents/${uuid}/config/dry-run`, {
        method: "POST",
        credential,
        body: JSON.stringify({ payload: patch }),
      });
      process.stdout.write(`Diff (${result.diff.length} change${result.diff.length === 1 ? "" : "s"}):\n`);
      for (const d of result.diff) {
        process.stdout.write(`  ${d.op} ${d.path}\n`);
      }
    });
}
