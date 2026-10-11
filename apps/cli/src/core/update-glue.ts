import { spawnSync } from "node:child_process";
import type { ExecuteUpdateFn, RefreshUpdateTargetFn, UpdateLogger, UpdatePromptFn } from "@first-tree/client";
import { confirm } from "@inquirer/prompts";
import * as semver from "semver";
import { channelConfig } from "./channel.js";
import { getChannelInstallCommand } from "./install-guidance.js";
import { print } from "./output.js";
import { resolveCliInvocation } from "./supervisor/index.js";
import {
  detectInstallMode,
  fetchServerCommandVersion,
  installGlobalSpec,
  installPortableSpec,
  PACKAGE_NAME,
} from "./update.js";
import { isLoopGuarded, recordUpdateAttempt } from "./update-state.js";

/** Reserved exit code that means "clean self-restart, service manager please bring me back". */
export const SELF_RESTART_EXIT_CODE = 75;

/** Interactive update prompt. Defaults to N on timeout. */
export const promptUpdate: UpdatePromptFn = async ({ currentVersion, targetVersion, timeoutSeconds }) => {
  // Phrasing matches the post-poller install path: we install the exact
  // version the server advertised, not whatever `@latest` happens to point
  // at. "Server recommends" (rather than "bundled with") because the version
  // now comes from the server's npm-registry poll for the configured
  // channel, not from the server image build.
  const message = `A newer First Tree client is available.\n  You: ${currentVersion}\n  Server recommends: ${targetVersion}\n  Will install: ${targetVersion}\n  Updating will restart the client and briefly interrupt any active sessions.\n  Update now?`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    try {
      return await confirm({ message, default: false }, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // AbortError on timeout, or stdin-not-a-TTY
    return false;
  }
};

/**
 * Update prompt that always declines. Wired in when the operator passes
 * `--no-interactive` — the UpdateManager will log the drift and move on
 * instead of blocking on a TTY confirm.
 */
export const declineUpdate: UpdatePromptFn = async () => false;

export const refreshServerUpdateTarget: RefreshUpdateTargetFn = async () => {
  const result = await fetchServerCommandVersion();
  return result.ok ? { ok: true, targetVersion: result.version } : result;
};

export type UpdateFailedPayload = {
  targetVersion: string;
  retryable: boolean;
  reasonCode: string;
};

function formatUpdateLine(message: string): string {
  return `  [update] ${message.replace(/\n$/, "")}\n`;
}

function defaultUpdateLog(_level: "info" | "warn", message: string): void {
  print.line(formatUpdateLine(message));
}

function createInstallOutputLog(log: UpdateLogger | undefined): ((chunk: string) => void) | undefined {
  if (!log) return undefined;
  return (chunk) => {
    const message = chunk.trimEnd();
    if (message) log("info", message);
  };
}

/**
 * Build the command-layer `executeUpdate` callback.
 *
 * `managed=true` means a process supervisor (launchd / systemd / Docker
 * `restart`) owns the daemon lifecycle. Portable updates and non-Linux
 * managed paths install the new bits and exit with `SELF_RESTART_EXIT_CODE`;
 * managed Linux npm updates hand off to a transient systemd unit that stops
 * and starts the service around the install.
 *
 * `managed=false` means the process is running standalone (e.g. manual
 * `client start`, `login <code> --no-start`, CI without a supervisor).
 * Exiting in that mode would leave the client offline until an operator
 * noticed — so the callback instead prints a restart hint, returns
 * `{ installed: true }`, and the UpdateManager stops retrying until the
 * operator restarts manually.
 *
 * `onUpdateFailed` (optional) — Task 6 / design §6.1: when npm install
 * fails, the callback fires with `{ targetVersion, retryable, reasonCode }`
 * so the ClientRuntime can `connection.emit("resilience.update.failed", …)`.
 * Wired by `apps/cli/src/commands/daemon/start.ts` after ClientRuntime is
 * built — see the deferred-reference pattern there.
 */
export function createExecuteUpdate({
  managed,
  log,
  onUpdateFailed,
}: {
  managed: boolean;
  log?: UpdateLogger;
  onUpdateFailed?: (payload: UpdateFailedPayload) => void;
}): ExecuteUpdateFn {
  const emit = log ?? defaultUpdateLog;
  const installOutput = createInstallOutputLog(log);
  return async ({ currentVersion, targetVersion }) => {
    const mode = detectInstallMode();
    if (mode === "source") {
      emit("info", "Running from source checkout — self-update skipped. Use `git pull` instead.");
      return { installed: false };
    }
    if (mode === "npx") {
      emit(
        "warn",
        `Cannot self-update — not launched from an installed CLI.\n  Run \`${getChannelInstallCommand()}\` manually.`,
      );
      return { installed: false };
    }

    // Cross-restart loop guard: if a previous attempt installed this exact
    // target version but the on-disk binary never advanced (npm latest
    // resolved to the same version we already had, dist-tag silently
    // re-pointed, etc.), running it again would re-trigger the same
    // exit(75) → restart → drift → install loop until systemd's
    // StartLimit kills the service. Refuse instead, and surface the
    // reason so the operator knows what to do (run `login <code>`
    // again, or `npm i -g …@latest` manually). Returning
    // `{ installed: true }` is the right shape here — it puts the
    // UpdateManager into `pendingRestart=true`, blocking further attempts
    // until the operator restarts the process.
    //
    // Note: we deliberately do NOT call `recordUpdateAttempt` on this
    // branch. The on-disk `blocked` record written by the previous
    // process is exactly the state we want to surface to admins; writing
    // a fresh record here would just push the timestamp forward without
    // adding information. "Freeze, don't refresh" is the intended
    // semantics — if you change it, also reconsider how the admin
    // dashboard interprets `at` (currently: "when did this client first
    // get stuck on $target").
    if (isLoopGuarded(targetVersion)) {
      const installHint = PACKAGE_NAME ?? channelConfig.binName;
      const likelyCause =
        mode === "portable"
          ? "           The most likely cause is a stale portable metadata target or a shim/path mismatch.\n"
          : "           The most likely cause is npm's `latest`\n" +
            "           dist-tag resolving to the same version this client is already running.\n";
      const operatorAction =
        mode === "portable"
          ? `           Operator action: manually run \`${channelConfig.binName} upgrade\`, then restart the service.\n`
          : `           Operator action: manually run \`npm install -g ${installHint}@latest\`,\n` +
            "           then restart the service.\n";
      emit(
        "warn",
        `Refusing to retry ${targetVersion} — a previous attempt completed without\n` +
          "           advancing the on-disk version.\n" +
          likelyCause +
          operatorAction,
      );
      return { installed: true };
    }

    // Auto-update installs the *exact* version the server advertised in
    // `server:welcome.serverCommandVersion`. Using `@latest` here would
    // race to a different version than the one drift-check approved.
    // The server is the authoritative source of "what should this client
    // run"; channelConfig.packageName guarantees we install against this
    // binary's own package (prod / staging), never crossing channels.
    const pkgSpec = PACKAGE_NAME ?? channelConfig.binName;
    const isPortable = mode === "portable";
    emit(
      "info",
      isPortable
        ? `Switching portable ${channelConfig.binName} to ${targetVersion}...`
        : `Running \`npm install -g ${pkgSpec}@${targetVersion}\`...`,
    );
    const installOptions = {
      managed,
      ...(installOutput ? { output: installOutput } : {}),
    };
    const result = isPortable
      ? await installPortableSpec(targetVersion)
      : await installGlobalSpec(targetVersion, installOptions);
    if (!result.ok) {
      emit("warn", `Install failed: ${result.reason}`);
      recordUpdateAttempt({
        result: "failed",
        target: targetVersion,
        currentBefore: currentVersion,
        installedVersion: null,
        reason: result.reason,
        at: new Date().toISOString(),
      });
      // Design §6.1: emit through the ClientConnection EventEmitter so future
      // admin / web consumers can surface "update is failing" without having
      // to scrape on-disk update-state.json. `result.retryable` and
      // `result.reasonCode` are populated by the taxonomy in update.ts.
      try {
        onUpdateFailed?.({
          targetVersion,
          retryable: result.retryable ?? false,
          reasonCode: result.reasonCode ?? "unknown",
        });
      } catch {
        // best-effort
      }
      return { installed: false };
    }

    // Loop detection: npm reported success, but did it actually install
    // the target? Comparing `installed` against `targetVersion` (rather
    // than `currentVersion`) is deliberate — the failure we're guarding
    // against is "npm resolved our spec to something other than what we
    // asked for" (stale dist-tag, channel misconfig, registry mirror
    // lag). If `installed < targetVersion`, exit(75) restarts into a
    // binary still older than what the server is advertising and the
    // drift check on the next welcome triggers another install: that's
    // the loop. Using `lt(installed, target)` (not
    // `lte(installed, current)`) also means an intentional server-driven
    // downgrade — should we ever support one — wouldn't be misflagged
    // as a no-advance loop, because there'd be no drift left to trigger
    // a second attempt. semver.valid guards protect against
    // `result.installedVersion === null` (npm stdout didn't parse
    // cleanly); in that case we proceed normally because we can't
    // disprove a successful install.
    const installed = result.installedVersion;
    if (installed && semver.valid(installed) && semver.valid(targetVersion) && semver.lt(installed, targetVersion)) {
      const reason = `${result.mode} reported install of ${installed}, but the server-advertised target was ${targetVersion} (running ${currentVersion})`;
      emit("warn", `WARNING: ${reason}`);
      emit("warn", "Skipping restart to avoid an exit-75 → reboot loop. Loop guard armed.");
      recordUpdateAttempt({
        result: "blocked",
        target: targetVersion,
        currentBefore: currentVersion,
        installedVersion: installed,
        reason,
        at: new Date().toISOString(),
      });
      // Treat as `installed: true` so the UpdateManager sets
      // pendingRestart and stops retrying this welcome session. No
      // exit(75) — the supervisor MUST NOT relaunch us into the same
      // broken state.
      return { installed: true };
    }

    const installedLabel = installed ?? targetVersion;
    recordUpdateAttempt({
      result: "ok",
      target: targetVersion,
      currentBefore: currentVersion,
      installedVersion: installed,
      reason: null,
      at: new Date().toISOString(),
    });
    if (managed) {
      // Refresh the launchd plist / systemd unit using the NEW binary's
      // templates BEFORE we exit 75. We're still running the OLD binary in
      // memory, so calling `installClientService()` here writes the unit
      // with the old templates — which is the bug that traps users in an
      // "unknown command" restart loop when the CLI surface changes (e.g.
      // `client start` → `daemon start`). Spawning the new binary in a
      // one-shot hidden mode (`daemon refresh-unit`) lets the new code
      // rewrite the unit before the supervisor restart picks it up.
      //
      // Best-effort: failure logs and falls through to exit-75 anyway
      // (matches `commands/upgrade.ts`'s "warn and continue" stance — the
      // operator can recover with logout + login if the
      // unit ends up stale).
      refreshServiceUnit(emit);
      emit("info", `Installed ${installedLabel}. Restarting (exit ${SELF_RESTART_EXIT_CODE}).`);
      process.exit(SELF_RESTART_EXIT_CODE);
    }
    emit(
      "info",
      `Installed ${installedLabel}. Restart the client manually (Ctrl+C then \`${channelConfig.binName} daemon start\`) to pick up the new version.`,
    );
    return { installed: true };
  };
}

/**
 * Resolve and spawn the newly-installed CLI through its installed identity to
 * rewrite the service unit using its OWN templates. Portable installs use the
 * explicit stable outer shim; npm installs retain their installed-bin lookup.
 *
 * Why a subprocess: this whole function runs inside the OLD daemon process,
 * which has the OLD `installClientService()` code loaded in memory.
 * Calling `installClientService()` directly here would write the OLD unit
 * shape, defeating the entire point of the refresh.
 *
 * Why best-effort: the worst outcome on failure is "supervisor restart
 * crashes on stale unit", which the operator-facing `logout && login`
 * recovery sequence handles. We never want a transient spawn failure to
 * *block* the binary install — the new binary on disk is the load-bearing
 * fix.
 *
 * Timeout is generous (45s) because `installClientService()` on systemd
 * runs `daemon-reload` + `enable --now` and on launchd runs `bootout` +
 * `bootstrap`, both of which routinely take 10-30s under load.
 */
function refreshServiceUnit(log: (level: "info" | "warn", message: string) => void): void {
  try {
    const invocation = resolveCliInvocation();
    const args = [...(invocation.kind === "node" ? invocation.args : []), "daemon", "refresh-unit"];
    const invocationLabel = [invocation.program, ...(invocation.kind === "node" ? invocation.args : [])].join(" ");
    const recovery = `\`${invocationLabel} daemon ensure-service\``;
    const res = spawnSync(invocation.program, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 45_000,
      // Sanitize FIRST_TREE_SERVICE_MODE so the child doesn't think it's
      // being invoked by the supervisor and recursively delegate to
      // systemctl. Everything else (PATH, HOME, FIRST_TREE_HOME) passes
      // through so the child resolves the same home / config as we do.
      env: { ...process.env, FIRST_TREE_SERVICE_MODE: "" },
    });
    if (res.status !== 0) {
      const output = [res.stderr?.trim(), res.stdout?.trim()].filter(Boolean).join(" | ");
      const outputSuffix = output ? ` Output: ${output}` : "";
      log(
        "warn",
        `warning: '${invocationLabel} daemon refresh-unit' exited with status ${res.status ?? "unknown"} ` +
          `(signal=${res.signal ?? "none"}). If the supervisor restart fails after exit ${SELF_RESTART_EXIT_CODE}, ` +
          `recover with ${recovery}.${outputSuffix}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(
      "warn",
      `warning: could not resolve or spawn the installed CLI for 'daemon refresh-unit': ${msg}. ` +
        `If the supervisor restart fails, rerun the ${channelConfig.channel} portable installer or invoke the installed channel shim by absolute path.`,
    );
  }
}
