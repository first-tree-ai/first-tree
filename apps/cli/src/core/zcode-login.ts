import { spawn } from "node:child_process";
import { ensureOfficialZcodeRuntime } from "@first-tree/client";
import { fail } from "../cli/output.js";

/**
 * First Tree-owned recovery driver for ZCode host-local login.
 *
 * The Computers/setup and chat-timeline recovery surfaces cannot know the
 * absolute Node executable or cache root First Tree resolved for a given
 * host ahead of time (env-var cache overrides, portable vs. system Node) —
 * only the running Client does. This command re-resolves the managed
 * runtime the same way a provider turn does (extracting it first on a clean
 * host) and then hands the terminal to it via the exact `process.execPath`
 * First Tree launches turns with, so the advertised recovery step is always
 * the one that actually admitted.
 */
export async function runZcodeLogin(extraArgs: readonly string[] = []): Promise<void> {
  const resolution = await ensureOfficialZcodeRuntime();
  if (!resolution.ok) {
    fail("ZCODE_RUNTIME_UNAVAILABLE", resolution.error, 1);
  }

  const child = spawn(resolution.command, [...resolution.args, "login", ...extraArgs], {
    stdio: "inherit",
  });
  await new Promise<void>((resolvePromise) => {
    child.on("error", (err) => {
      fail("ZCODE_LOGIN_SPAWN_FAILED", err instanceof Error ? err.message : String(err), 1);
    });
    child.on("close", (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
      resolvePromise();
    });
  });
}
