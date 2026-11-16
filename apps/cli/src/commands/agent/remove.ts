import { existsSync } from "node:fs";
import { join } from "node:path";
import { AGENT_NAME_REGEX } from "@first-tree/shared";
import { defaultConfigDir, defaultDataDir } from "@first-tree/shared/config";
import type { Command } from "commander";
import { fail } from "../../cli/output.js";
import { localContextDataLossForAgent, removeLocalAgent } from "../../core/index.js";
import { print } from "../../core/output.js";

export function registerAgentRemoveCommand(agent: Command): void {
  agent
    .command("remove <name>")
    .description(
      "Remove an agent from this client and delete its local runtime data (config dir, workspace, session state)",
    )
    .action((name: string) => {
      // SEC-030: the name is joined into three recursive deletions. Reject
      // non-canonical names here so the operator gets one sentence instead of a
      // stack trace from the shared core helper.
      if (!AGENT_NAME_REGEX.test(name)) {
        fail(
          "INVALID_AGENT_NAME",
          `"${name}" is not a valid agent name. Agent names use lowercase letters, digits, "-" and "_", and start with a letter or digit.`,
          2,
        );
      }
      const agentDir = join(defaultConfigDir(), "agents", name);
      if (!existsSync(agentDir)) {
        print.line(`  Agent "${name}" not found.\n`);
        process.exit(1);
      }
      const localContext = localContextDataLossForAgent(join(defaultDataDir(), "workspaces"), name);
      if (localContext) {
        print.line(
          `  Warning: removing Agent "${name}" permanently deletes its unmigrated Local Context at ${localContext.path}.\n`,
        );
      }
      removeLocalAgent(name);
      print.line(`  Agent "${name}" removed.\n`);
    });
}
