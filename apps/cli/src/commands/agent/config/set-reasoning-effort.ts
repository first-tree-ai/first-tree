import type { Command } from "commander";
import { success } from "../../../cli/output.js";
import { credentialForOrigin } from "../../../core/access-token.js";
import { resolveServerUrl } from "../../../core/bootstrap.js";
import { getCurrent, patchConfig, resolveAgentRecord } from "./_shared/fetchers.js";

export function registerAgentConfigSetReasoningEffortCommand(config: Command): void {
  config
    .command("set-reasoning-effort <agent> <level>")
    .description(
      'Set reasoning effort. claude-code: "" (inherit local) | low | medium | high | max. codex: low | medium | high | xhigh | max | ultra (model-dependent). Grok Build: "" (inherit local) | low | medium | high. Cursor, Kimi Code, and OpenCode have no separate effort field.',
    )
    .action(async (agentName: string, level: string) => {
      const serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
      const credential = await credentialForOrigin(serverUrl);
      const { uuid } = await resolveAgentRecord(serverUrl, credential, agentName);
      const current = await getCurrent(serverUrl, credential, uuid);
      // The value set is provider-specific; the server validates `level`
      // against the agent's runtime provider and rejects out-of-range values
      // with a 400.
      const updated = await patchConfig(serverUrl, credential, uuid, current.version, { reasoningEffort: level });
      success({
        agentId: updated.agentId,
        version: updated.version,
        reasoningEffort: "reasoningEffort" in updated.payload ? updated.payload.reasoningEffort : undefined,
      });
    });
}
