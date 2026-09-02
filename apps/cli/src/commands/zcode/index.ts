import type { Command } from "commander";
import { runZcodeLogin } from "../../core/zcode-login.js";

export function registerZcodeCommands(program: Command): void {
  const zcode = program.command("zcode").description("Manage the managed ZCode runtime");

  zcode
    .command("login")
    .description("Sign in to ZCode using the exact runtime and Node executable First Tree admitted on this host")
    .allowUnknownOption()
    .argument("[args...]", "extra arguments forwarded to the ZCode login command (e.g. --no-browser)")
    .action(async (args: string[]) => {
      await runZcodeLogin(args);
    });
}
