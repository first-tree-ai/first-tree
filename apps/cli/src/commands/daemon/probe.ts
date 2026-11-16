import { probeCapabilities } from "@first-tree/client";
import { clientConfigSchema, initConfig, resetConfig, resetConfigMeta } from "@first-tree/shared/config";
import type { Command } from "commander";
import { fail } from "../../cli/output.js";
import { channelConfig } from "../../core/channel.js";
import {
  ensureFreshBoundAccessToken,
  loadCredentials,
  printResults,
  runtimeProviderChecks,
  uploadClientCapabilities,
} from "../../core/index.js";
import { isJsonMode, print } from "../../core/output.js";

/**
 * `daemon probe` — re-detect runtime-provider capabilities on demand.
 *
 * The daemon refreshes capabilities automatically (at startup, on every WS
 * reconnect, and via a bounded background poll while any provider is non-`ok`),
 * so installing a provider is normally noticed without operator action. This
 * command is the immediate, on-demand path — it forces a full re-detection +
 * upload right now (instead of waiting for the next backed-off poll) and
 * surfaces the real, verbatim detection result locally. Detection is
 * resolve-only: it locates each provider's executable and checks platform
 * support without launching the provider, checking authentication, or making
 * model calls, so it is cheap and token-free. Provider credentials are
 * validated later, on the first real provider turn.
 *
 * Detection is purely local and needs no First Tree credentials; only the
 * (default) upload step requires a logged-in client. So `--no-upload` runs as
 * a credentials-free local diagnostic. `--json` (or the global `--json`) emits
 * the capability snapshot as the machine-readable `{ ok, data }` envelope on
 * stdout; the human report otherwise goes to stderr.
 */
export function registerDaemonProbeCommand(daemon: Command): void {
  daemon
    .command("probe")
    .description("Re-detect local runtime provider capabilities and upload the result to the server")
    .option("--no-upload", "Run capability detection and print results without uploading to the server")
    .option("--json", "Emit the capability snapshot as a machine-readable JSON envelope on stdout")
    .action(async (options: { upload?: boolean; json?: boolean }) => {
      const binName = channelConfig.binName;
      const wantJson = options.json === true || isJsonMode();

      // Detection is purely local — it needs no First Tree credentials or
      // client config, so the local-only (`--no-upload`) path works on a
      // machine that has never logged in.
      if (!wantJson)
        print.line("\n  Detecting runtime provider capabilities (resolve-only; no provider is launched)...\n\n");
      const capabilities = await probeCapabilities();

      // The human report renders immediately; the JSON success envelope is
      // deferred until the command's outcome (including upload) is known, so
      // `--json` never writes a premature `{ ok: true }` to stdout that a
      // missing-credentials / failed upload would then contradict on stderr.
      if (!wantJson) printResults(runtimeProviderChecks(capabilities));

      if (options.upload === false) {
        if (wantJson) print.result(capabilities);
        else print.line("  Skipped upload (--no-upload).\n\n");
        return;
      }

      // Upload requires a logged-in client + its config.
      if (!loadCredentials()) {
        fail("NO_CREDENTIALS", `no credentials — run \`${binName} login <code>\` first, or use --no-upload.`, 1);
      }
      try {
        const config = await initConfig({ schema: clientConfigSchema, role: "client" });
        const credential = await ensureFreshBoundAccessToken();
        await uploadClientCapabilities({
          serverUrl: config.server.url,
          credential,
          clientId: config.client.id,
          capabilities,
        });
        if (wantJson) print.result(capabilities);
        else print.line("  Uploaded to the server.\n\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // In JSON mode the envelope must reflect the real outcome: a failed
        // upload is `{ ok: false }`, not a success with the snapshot. (A caller
        // who only wants the local snapshot uses `--no-upload`.) In human mode
        // the report is already printed, so the upload failure is a soft
        // warning — the clients row only exists after a `client:register`
        // handshake, so a probe before the daemon ever connected can 404 here.
        if (wantJson) fail("UPLOAD_FAILED", msg, 1);
        print.status("⚠️", `capabilities upload skipped: ${msg}`);
      } finally {
        resetConfig();
        resetConfigMeta();
      }
    });
}
