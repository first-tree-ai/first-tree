import { join } from "node:path";
import { defaultConfigDir, normalizeContextTreeRepository, setConfigValue } from "@first-tree/shared/config";
import type { Command } from "commander";
import { fail } from "../../cli/output.js";
import { print } from "../../core/output.js";

export function registerConfigSetCommand(config: Command): void {
  config
    .command("set <key> <value>")
    .description("Set a value in client.yaml (dot-notation)")
    .action((key: string, value: string) => {
      let parsed: unknown = value;
      if (key === "context_tree.repository") {
        const repository = normalizeContextTreeRepository(value);
        if (repository === null) {
          fail(
            "INVALID_CONTEXT_TREE_REPOSITORY",
            `Invalid Context Tree repository ${JSON.stringify(value)}. Expected a GitHub identity such as acme/context.`,
            2,
          );
        }
        parsed = repository;
      } else if (value === "true") parsed = true;
      else if (value === "false") parsed = false;
      else if (/^\d+$/.test(value)) parsed = Number(value);
      const path = join(defaultConfigDir(), "client.yaml");
      setConfigValue(path, key, parsed);
      print.line(`  Set ${key} in ${path}\n`);
    });
}
