import { existsSync, rmSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { defaultConfigDir, defaultDataDir, defaultHome } from "@first-tree/shared/config";
import type { Command } from "commander";
import { fail } from "../cli/output.js";
import { channelConfig } from "../core/channel.js";
import {
  accessTokenForOrigin,
  cliFetch,
  getClientServiceStatus,
  isServiceSupported,
  listLiveClientRuntimeMarkers,
  listLocalContextDataLoss,
  loadCredentials,
  readActiveClientIdFromIndex,
  readActiveRootClientId,
  recordActiveClientOwner,
  stopClientRuntimeProcess,
  stopClientService,
} from "../core/index.js";
import { print } from "../core/output.js";
import { decodeJwtPayload } from "./_shared/connect-token.js";

function readOwnerSub(token: string | undefined): string | null {
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  return typeof payload?.sub === "string" ? payload.sub : null;
}

/**
 * `logout` — symmetric counterpart to `login`. Stops the
 * background daemon and removes persisted credentials. `client.yaml` and local
 * agent runtime state are kept by default; `--purge` retires the current
 * server client before destructive local cleanup.
 */
export function registerLogoutCommand(program: Command): void {
  program
    .command("logout")
    .description("Disconnect from First Tree — stop daemon and clear credentials (symmetric to `login`)")
    .option("--purge", "Retire the current server client and remove active and parked local client state")
    .action((options: { purge?: boolean }) => {
      return runLogout({
        purge: options.purge === true,
        retryCommand: `${channelConfig.binName} logout --purge`,
        retireServerClient: options.purge === true,
      });
    });
}

type StoredCredentials = {
  accessToken: string;
  refreshToken: string;
  serverUrl: string;
};

const trustedForegroundDaemonCommandNames = new Set([
  channelConfig.binName,
  "first-tree",
  "first-tree-dev",
  "first-tree-staging",
  "ft",
  "ftd",
]);

async function readErrorBody(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return "";
  try {
    const parsed = JSON.parse(text) as { error?: string; message?: string };
    return parsed.error ?? parsed.message ?? text;
  } catch {
    return text;
  }
}

async function retireServerClientBeforePurge(opts: {
  credentials: StoredCredentials | null;
  clientId: string | null;
  retryCommand: string;
}): Promise<void> {
  if (!opts.credentials || !opts.clientId) {
    print.line("  Refusing to purge because this local client cannot be retired on the server.\n");
    print.line(
      `  Run \`${channelConfig.binName} login <code>\` as the current owner, then retry \`${opts.retryCommand}\`.\n`,
    );
    print.line(`  For local-only damaged state recovery, run \`${channelConfig.binName} computer reset\`.\n\n`);
    fail(
      "PURGE_CLIENT_RETIRE_UNAVAILABLE",
      "Cannot retire server client before purge because credentials or client id are missing.",
      1,
    );
  }

  let accessToken: string;
  try {
    accessToken = await accessTokenForOrigin(opts.credentials.serverUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    print.line(`  Refusing to purge because credentials could not be refreshed: ${msg}\n\n`);
    fail("PURGE_CLIENT_RETIRE_FAILED", `Failed to retire client "${opts.clientId}" before purge.`, 1);
  }
  const res = await cliFetch(`${opts.credentials.serverUrl}/api/v1/clients/${encodeURIComponent(opts.clientId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const body = await readErrorBody(res);
    print.line(`  Refusing to purge because server-side client retire failed (HTTP ${res.status}).\n`);
    if (body) print.line(`  ${body}\n`);
    print.line(`  Resolve the server-side issue, then retry \`${opts.retryCommand}\`.\n\n`);
    fail("PURGE_CLIENT_RETIRE_FAILED", `Failed to retire client "${opts.clientId}" before purge.`, 1);
  }
  print.line(`  ✓ Retired server client ${opts.clientId}\n`);
}

function isTrustedForegroundDaemonCommand(command: string): boolean {
  if (command.includes("daemon start") && command.includes("--foreground")) return true;
  const argv0 = command.split(/\s+/)[0];
  return !!argv0 && trustedForegroundDaemonCommandNames.has(basename(argv0));
}

async function stopForegroundClientRuntimesBeforeLogout(opts: {
  home: string;
  clientId: string | null;
  purge: boolean;
  retryCommand: string;
}): Promise<void> {
  if (!opts.clientId) return;

  let foreground: ReturnType<typeof listLiveClientRuntimeMarkers>;
  try {
    foreground = listLiveClientRuntimeMarkers(opts.home, opts.clientId).filter(
      (runtime) => runtime.mode === "foreground",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.purge) {
      print.line(`  Could not inspect foreground daemon runtime markers: ${msg}\n\n`);
      print.line("  Refusing to purge First Tree local client state while a foreground daemon may still be running.\n");
      print.line(`  Stop any foreground daemon terminals, then retry \`${opts.retryCommand}\`.\n\n`);
      fail("PURGE_FOREGROUND_DAEMON_STOP_FAILED", "Failed to inspect foreground daemon runtime markers.", 1);
    }
    print.line(`  Warning: could not inspect foreground daemon runtime markers: ${msg}\n`);
    return;
  }

  for (const runtime of foreground) {
    const command = runtime.command?.trim() ?? "";
    if (!isTrustedForegroundDaemonCommand(command)) {
      const reason = command
        ? `pid ${runtime.pid} command no longer looks like a First Tree foreground daemon: ${command}`
        : `could not read command for pid ${runtime.pid}`;
      if (opts.purge) {
        print.line(`  Could not safely stop foreground daemon marker for pid ${runtime.pid}: ${reason}\n\n`);
        print.line(
          "  Refusing to purge First Tree local client state while a foreground daemon may still be running.\n",
        );
        print.line(`  Inspect pid ${runtime.pid}, then retry \`${opts.retryCommand}\`.\n\n`);
        fail("PURGE_FOREGROUND_DAEMON_STOP_FAILED", `Failed to safely stop foreground daemon pid ${runtime.pid}.`, 1);
      }
      print.line(`  Warning: could not safely stop foreground daemon marker for pid ${runtime.pid}: ${reason}\n`);
      continue;
    }
    const res = await stopClientRuntimeProcess(runtime.pid, { timeoutMs: 5_000 });
    if (!res.ok) {
      if (opts.purge) {
        print.line(`  Could not stop foreground daemon pid ${runtime.pid}: ${res.reason}\n\n`);
        print.line("  Refusing to purge First Tree local client state while the daemon may still be running.\n");
        print.line(
          `  Stop the foreground daemon terminal with Ctrl+C or kill pid ${runtime.pid}, then retry \`${opts.retryCommand}\`.\n\n`,
        );
        fail("PURGE_FOREGROUND_DAEMON_STOP_FAILED", `Failed to stop foreground daemon pid ${runtime.pid}.`, 1);
      }
      print.line(`  Warning: could not stop foreground daemon pid ${runtime.pid}: ${res.reason}\n`);
      continue;
    }
    print.line(`  ✓ Stopped foreground daemon pid ${runtime.pid}${res.alreadyStopped ? " (already stopped)" : ""}\n`);
  }
}

export async function runLogout(opts: {
  purge: boolean;
  retryCommand?: string;
  retireServerClient?: boolean;
}): Promise<void> {
  const home = defaultHome();
  const configDir = defaultConfigDir();
  const dataDir = defaultDataDir();
  const retryCommand = opts.retryCommand ?? `${channelConfig.binName} logout --purge`;
  const clientId = readActiveRootClientId(configDir) ?? readActiveClientIdFromIndex(home);
  if (opts.purge) {
    const localContexts = listLocalContextDataLoss({ dataDir, home });
    if (localContexts.length > 0) {
      print.line(
        `  Warning: this operation permanently deletes ${localContexts.length} unmigrated Local Context ${localContexts.length === 1 ? "directory" : "directories"}:\n`,
      );
      for (const local of localContexts) {
        print.line(`    - ${local.agentName} (${local.storage}): ${local.path}\n`);
      }
      print.line("\n");
    }
  }
  // 1. Stop daemon (best-effort).
  if (isServiceSupported()) {
    const svc = getClientServiceStatus();
    if (svc.migrationRequired === "root-systemd-user-to-system") {
      const detail = svc.detail ? `: ${svc.detail}` : "";
      print.line(`  Background service requires migration before logout${detail}.\n\n`);
      print.line("  Refusing to remove credentials while the legacy root daemon may still be running.\n");
      print.line(`  Complete the migration with \`${channelConfig.binName} login <code>\`, then retry logout.\n\n`);
      fail(
        "DAEMON_MIGRATION_REQUIRED",
        `Cannot safely logout while background service migration is required: ${svc.platform}${detail}`,
        1,
      );
    }
    if (svc.state === "unknown" && opts.purge) {
      const detail = svc.detail ? `: ${svc.detail}` : "";
      print.line(`  Could not determine ${svc.platform} service state${detail}.\n\n`);
      print.line("  Refusing to purge First Tree local client state while the daemon state is unknown.\n");
      print.line(
        `  Run \`${channelConfig.binName} daemon status\`, stop the service manually, then retry \`${retryCommand}\`.\n\n`,
      );
      fail(
        "PURGE_DAEMON_STATE_UNKNOWN",
        `Cannot safely determine whether the background service is stopped: ${svc.platform}${detail}`,
        1,
      );
    }
    if (svc.state === "active") {
      const res = stopClientService();
      if (!res.ok && opts.purge) {
        print.line(`  Could not stop ${svc.platform} service: ${res.reason}\n\n`);
        print.line("  Refusing to purge First Tree local client state while the daemon may still be running.\n");
        print.line(
          `  Run \`${channelConfig.binName} daemon stop\` or stop the service manually, then retry \`${retryCommand}\`.\n\n`,
        );
        fail("PURGE_DAEMON_STOP_FAILED", `Failed to stop active background service: ${res.reason}`, 1);
      }
      print.line(`  ✓ Stopped ${svc.platform} service${res.ok ? "" : ` (warning: ${res.reason})`}\n`);
    }
  }
  await stopForegroundClientRuntimesBeforeLogout({ home, clientId, purge: opts.purge, retryCommand });
  const credentials = loadCredentials();
  if (opts.purge && opts.retireServerClient === true) {
    await retireServerClientBeforePurge({ credentials, clientId, retryCommand });
  }
  // 2. Remove credentials.
  if (!opts.purge) {
    const ownerSub = readOwnerSub(credentials?.accessToken);
    if (credentials && ownerSub && clientId) {
      recordActiveClientOwner({
        clientId,
        userId: ownerSub,
        serverUrl: credentials.serverUrl,
      });
    }
  }
  const credsPath = join(configDir, "credentials.json");
  if (existsSync(credsPath)) {
    unlinkSync(credsPath);
    print.line(`  ✓ Removed credentials\n`);
  }
  // 3. purge: remove local machine identity and agent runtime state.
  if (opts.purge) {
    for (const entry of [
      { path: join(configDir, "client.yaml"), label: "client.yaml" },
      { path: join(configDir, "context.yaml"), label: "Context grants" },
      { path: join(configDir, "context.yaml.v1.bak"), label: "legacy Context grant backup" },
      { path: join(configDir, "agents"), label: "local agent configs" },
      { path: join(dataDir, "sessions"), label: "agent session state" },
      { path: join(dataDir, "workspaces"), label: "agent workspaces" },
      { path: join(dataDir, "byo"), label: "BYO Context Tree repositories" },
      { path: join(home, "state", "context", "byo"), label: "BYO Context recovery state" },
      { path: join(home, "state", "context", "route-receipts"), label: "Context route receipts" },
      { path: join(home, "parked-clients"), label: "parked local clients" },
      { path: join(home, "state", "client-switch.lock"), label: "client switch lock" },
      { path: join(home, "state", "client-switch-journal.json"), label: "client switch journal" },
    ]) {
      if (!existsSync(entry.path)) continue;
      rmSync(entry.path, { recursive: true, force: true });
      print.line(`  ✓ Removed ${entry.label}\n`);
    }
    for (const provider of ["claude-code", "codex"] as const) {
      for (const state of ["adapter-sync", "compatible-sessions", "reload-pending", "reload-consumed"]) {
        rmSync(join(home, "state", "context", "providers", provider, state), { recursive: true, force: true });
      }
      rmSync(join(home, "state", "context", "providers", provider, "reload-required.json"), { force: true });
      rmSync(join(home, "state", "context", "providers", provider, "next-session-required.json"), { force: true });
    }
  }
  print.line(`\n  Logged out. Run \`${channelConfig.binName} login <code>\` to reconnect.\n\n`);
}
