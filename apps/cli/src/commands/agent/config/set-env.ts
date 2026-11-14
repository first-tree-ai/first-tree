import type { Command } from "commander";
import { fail, success } from "../../../cli/output.js";
import { ensureFreshAdminToken, resolveServerUrl } from "../../../core/bootstrap.js";
import { print } from "../../../core/output.js";
import { readStdin } from "../../_shared/stdin.js";
import { getCurrent, patchConfig, resolveAgentRecord } from "./_shared/fetchers.js";

export function registerAgentConfigSetEnvCommand(config: Command): void {
  config
    .command("set-env <agent> [kv]")
    .description(
      "Set an env variable: KEY=VALUE, or KEY with --value-stdin. Use --sensitive for secrets; prefer --value-stdin so the secret stays out of shell history.",
    )
    .option("--sensitive", "Mark this value as sensitive (encrypted at rest, masked in echo)")
    .option(
      "--value-stdin",
      "Read the value from stdin and take <kv> as the key only (keeps the secret out of shell history, process listings, and terminal recordings)",
    )
    .action(async (agentName: string, kv: string | undefined, opts: { sensitive?: boolean; valueStdin?: boolean }) => {
      const serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
      const adminToken = await ensureFreshAdminToken();
      const { uuid } = await resolveAgentRecord(serverUrl, adminToken, agentName);
      const { key, value } = await resolveKeyValue(kv, opts);
      const current = await getCurrent(serverUrl, adminToken, uuid);
      const remaining = current.payload.env.filter((e) => e.key !== key);
      const updated = await patchConfig(serverUrl, adminToken, uuid, current.version, {
        env: [...remaining, { key, value, sensitive: opts.sensitive ?? false }],
      });
      success({ agentId: updated.agentId, version: updated.version, env: key });
    });
}

/**
 * Resolve the `KEY=VALUE` argument, or read the value from stdin.
 *
 * SEC-052: a positional value lands in shell history, process listings, and
 * terminal recordings, and `--sensitive` only changed server-side storage. The
 * stdin form closes that; the positional form still works but is nudged toward
 * the pipe whenever the value is declared sensitive.
 */
async function resolveKeyValue(
  kv: string | undefined,
  opts: { sensitive?: boolean; valueStdin?: boolean },
): Promise<{ key: string; value: string }> {
  if (opts.valueStdin) {
    if (kv === undefined || kv.length === 0) {
      fail(
        "BAD_KV",
        'Expected KEY when --value-stdin is used, e.g. `printf %s "$SECRET" | ... set-env <agent> KEY --value-stdin`.',
        2,
      );
    }
    if (kv.includes("=")) {
      fail(
        "BAD_KV",
        "With --value-stdin pass the key only: the value comes from stdin, so a KEY=VALUE argument is ambiguous.",
        2,
      );
    }
    const stdin = await readStdin().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      return fail("STDIN_READ_FAILED", `Could not read the value from stdin: ${detail}`, 2);
    });
    if (stdin === null) {
      fail(
        "NO_STDIN",
        '--value-stdin needs the value on stdin. Pipe it, e.g. `printf %s "$SECRET" | first-tree agent config set-env <agent> KEY --value-stdin`.',
        2,
      );
    }
    // A trailing newline is an artifact of the shell/here-doc, never part of a
    // credential; everything else is preserved byte-for-byte.
    return { key: kv, value: stdin.replace(/\r?\n$/u, "") };
  }

  if (kv === undefined) fail("BAD_KV", "Expected KEY=VALUE (or KEY with --value-stdin).", 2);
  const eqIdx = kv.indexOf("=");
  if (eqIdx <= 0) fail("BAD_KV", "Expected KEY=VALUE", 2);
  const key = kv.slice(0, eqIdx);
  const value = kv.slice(eqIdx + 1);
  if (opts.sensitive === true) {
    print.line(
      "  warning: --sensitive keeps the value out of the server response, not out of shell history or process " +
        "listings. Use --value-stdin to keep the secret out of the shell:\n\n" +
        `  printf %s "$SECRET" | first-tree agent config set-env ${"<agent>"} ${key} --sensitive --value-stdin\n\n`,
    );
  }
  return { key, value };
}
