import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { defaultHome } from "@first-tree/shared/config";
import { channelConfig } from "../channel.js";
import { print } from "../output.js";
import {
  ensureLogDir,
  extractFirstTreeHomeFromSystemd,
  extractProxyFromSystemd,
  logDir,
  migrateBakedProxyEnv,
  readFileOrFlagDrift,
  resolveCliInstall,
  runCapture,
  runCaptureOut,
  shellQuote,
  systemdPathEnv,
} from "./shared.js";
import type { ResolvedBinary, ServiceInfo, ServiceOpResult, ServiceState, SupervisorBackend } from "./types.js";

// Service identifiers derived from the binary's channel — see
// `packages/shared/src/channel/`. Every channel (dev / staging / prod)
// owns its own unit name / launchd label, so multiple daemons coexist
// without colliding on the same service identifier.
const SYSTEMD_UNIT = channelConfig.serviceUnitFile;
// `SyslogIdentifier` is the bare service name without `.service`. The
// launchd label uses the same identifier convention (bare name), so we
// reuse it for both.
const SYSLOG_IDENT = channelConfig.launchdLabel;
type SystemdScope = "user" | "system";

function systemdScope(): SystemdScope {
  return userInfo().uid === 0 ? "system" : "user";
}

function systemctlArgs(scope: SystemdScope, args: string[]): string[] {
  return scope === "user" ? ["--user", ...args] : args;
}

function systemdUserUnitPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "systemd", "user", SYSTEMD_UNIT);
}

function rootSystemdUserUnitPath(): string {
  const info = userInfo();
  const rootHome = info.uid === 0 && info.homedir ? info.homedir : "/root";
  return join(rootHome, ".config", "systemd", "user", SYSTEMD_UNIT);
}

function systemdUnitPath(scope: SystemdScope = systemdScope()): string {
  if (scope === "system") {
    return join(process.env.FIRST_TREE_SYSTEMD_SYSTEM_DIR ?? "/etc/systemd/system", SYSTEMD_UNIT);
  }
  return systemdUserUnitPath();
}

function rootUserSystemctlEnv(): NodeJS.ProcessEnv {
  const runtimeDir = "/run/user/0";
  return {
    ...process.env,
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus`,
  };
}

function isUserBusUnavailable(reason: string): boolean {
  return /failed to connect to bus|dbus_session_bus_address|xdg_runtime_dir|no medium found|no such file or directory/i.test(
    reason,
  );
}

function legacyRootUserMigrationDetail(unitPath: string): string {
  return `legacy root systemd user unit requires out-of-service migration: ${unitPath}`;
}

function blockingLegacyRootUserUnitPath(scope: SystemdScope = systemdScope()): string | null {
  if (scope !== "system") return null;
  if (existsSync(systemdUnitPath("system"))) return null;
  const legacyUnitPath = rootSystemdUserUnitPath();
  return existsSync(legacyUnitPath) ? legacyUnitPath : null;
}

export function renderSystemdUnit(
  invocation: ResolvedBinary,
  scope: SystemdScope = "user",
  servicePath: string = systemdPathEnv(),
): string {
  const execStart: string =
    invocation.kind === "bin"
      ? `${shellQuote(invocation.program)} daemon start --no-interactive`
      : `${shellQuote(invocation.program)} ${invocation.args.map(shellQuote).join(" ")} daemon start --no-interactive`;

  // Always pin FIRST_TREE_HOME into the unit. Without this line, systemd's
  // launched process inherits only the user manager's env — FIRST_TREE_HOME
  // is unset and the process falls back to the channel default. Usually
  // identical to what the operator wants, but ANY env override (one-off
  // `FIRST_TREE_HOME=/tmp/foo` test) silently disappears when the unit
  // gets installed. Embedding the resolved home eliminates that drift.
  const homeEnv = `Environment=FIRST_TREE_HOME=${shellQuote(defaultHome())}\n`;
  // `systemd --user` does not inherit the operator's interactive shell PATH.
  // Put this CLI's Node directory first so npm/nvm-installed shebangs and
  // self-update use the same Node toolchain when supervised.
  const pathEnv = `Environment=PATH=${shellQuote(servicePath)}\n`;
  const wantedBy = scope === "system" ? "multi-user.target" : "default.target";

  // Restart policy split:
  //   - on-failure  → operator-issued `systemctl stop` (clean exit 0) really stops.
  //   - SuccessExitStatus=0 makes that explicit.
  //   - RestartForceExitStatus=75 remains the fallback self-update path for
  //     portable installs and environments that do not use the managed Linux
  //     npm handoff. Managed Linux npm updates run in a transient unit that
  //     stops this service before touching its global package tree.
  // StartLimit* caps a crash storm (10 failures in 5 min → systemd holds back).
  // Normal client diagnostics go through the rotating NDJSON `client.log` when
  // FIRST_TREE_SERVICE_MODE=1; journald is only the supervisor fallback for
  // bare stdout/stderr (crashes, third-party spam).
  return `[Unit]
Description=First Tree Client
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=10
SuccessExitStatus=0
RestartForceExitStatus=75
KillSignal=SIGTERM
KillMode=mixed
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SYSLOG_IDENT}
${pathEnv}Environment=FIRST_TREE_SERVICE_MODE=1
${homeEnv}[Install]
WantedBy=${wantedBy}
`;
}

function systemdState(): {
  state: ServiceState;
  pid?: number;
  detail?: string;
  managerScope?: SystemdScope;
  migrationRequired?: ServiceInfo["migrationRequired"];
  unitPath?: string;
} {
  const scope = systemdScope();
  const unitPath = systemdUnitPath(scope);
  if (!existsSync(unitPath)) {
    const legacyUnitPath = blockingLegacyRootUserUnitPath(scope);
    if (legacyUnitPath) {
      return {
        state: "unknown",
        detail: legacyRootUserMigrationDetail(legacyUnitPath),
        managerScope: "user",
        migrationRequired: "root-systemd-user-to-system",
        unitPath: legacyUnitPath,
      };
    }
    return { state: "not-installed" };
  }
  // Mirror the launchctl fix: keep stderr piped so systemctl's error text
  // ("Failed to connect to bus..." etc.) doesn't leak to the user's terminal.
  const res = spawnSync("systemctl", systemctlArgs(scope, ["is-active", SYSTEMD_UNIT]), {
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = (res.stdout ?? "").trim();
  if (res.status === 0 && out === "active") {
    const pid = readSystemdMainPid(scope);
    return { state: "active", pid, detail: pid ? `pid ${pid}` : "running" };
  }
  return { state: "inactive", detail: out || "unit present but not active" };
}

function readSystemdMainPid(scope: SystemdScope): number | undefined {
  const res = runCaptureOut(
    "systemctl",
    systemctlArgs(scope, ["show", SYSTEMD_UNIT, "-p", "MainPID", "--value"]),
    5000,
  );
  if (!res.ok) return undefined;
  const n = Number(res.stdout);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Best-effort `loginctl enable-linger` for the current user.
 *
 * Why this matters: a `--user` systemd service is tied to the user's session.
 * Without linger, when the user logs out (closes their last SSH session,
 * graphical session ends, etc.) the user's systemd manager exits and stops
 * every service it owns — including ours. The next login restarts everything,
 * which is silently wrong: agents go offline for hours and the operator has
 * no obvious cause.
 *
 * `enable-linger <self>` is allowed without sudo on systemd ≥ 240 thanks to
 * polkit's `org.freedesktop.login1.set-self-linger` rule. On older distros
 * or hardened setups it requires polkit auth — we don't try to escalate;
 * the warning printed by the caller is the operator's signal to run it
 * manually.
 */
function tryEnableLinger(): { ok: true; alreadyOn: boolean } | { ok: false; reason: string } {
  const username = userInfo().username;
  if (!username) return { ok: false, reason: "could not determine username" };

  // Idempotency check: skip the call if linger is already on.
  const showRes = runCaptureOut("loginctl", ["show-user", username, "-p", "Linger", "--value"], 5_000);
  if (showRes.ok && showRes.stdout === "yes") {
    return { ok: true, alreadyOn: true };
  }

  const res = runCapture("loginctl", ["enable-linger", username], 5_000);
  if (res.ok) return { ok: true, alreadyOn: false };
  return { ok: false, reason: res.stderr || `exit ${res.code ?? "unknown"}` };
}

function migrateLegacyRootUserUnitToSystemScope(): void {
  const legacyUnitPath = rootSystemdUserUnitPath();
  if (!existsSync(legacyUnitPath)) return;

  migrateBakedProxyEnv(extractProxyFromSystemd(readFileSync(legacyUnitPath, "utf-8")));

  const env = rootUserSystemctlEnv();
  const disableRes = runCapture("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], 10_000, env);
  if (!disableRes.ok) {
    const reason = disableRes.stderr || `exit ${disableRes.code ?? "unknown"}`;
    if (isUserBusUnavailable(reason)) {
      throw new Error(`legacy root systemd user service state is ambiguous: ${reason}`);
    }
    if (!/not found|no such|not loaded/i.test(reason)) {
      throw new Error(`legacy root systemd user service migration failed: ${reason}`);
    }
  }

  rmSync(legacyUnitPath);

  const reloadRes = runCapture("systemctl", ["--user", "daemon-reload"], 5_000, env);
  if (!reloadRes.ok) {
    const reason = reloadRes.stderr || `exit ${reloadRes.code ?? "unknown"}`;
    if (isUserBusUnavailable(reason)) {
      throw new Error(`legacy root systemd user daemon-reload state is ambiguous: ${reason}`);
    }
    if (!/not found|no such|not loaded/i.test(reason)) {
      throw new Error(`legacy root systemd user daemon-reload failed: ${reason}`);
    }
  }
}

function assertNoLegacyRootUserUnitDuringRefresh(): void {
  const legacyUnitPath = rootSystemdUserUnitPath();
  if (!existsSync(legacyUnitPath)) return;
  throw new Error(
    `legacy root systemd user unit requires an out-of-service migration before refresh: ${legacyUnitPath}`,
  );
}

function writeAndEnableSystemd(scope: SystemdScope): ServiceInfo {
  const install = resolveCliInstall();
  ensureLogDir();
  const unitPath = systemdUnitPath(scope);
  // Upgrade buffer: lift any proxy env a prior version baked into the unit into
  // the user-owned daemon.env before we re-render a proxy-free unit (no-op when
  // there is no prior unit, no baked proxy, or a daemon.env already exists).
  if (existsSync(unitPath)) {
    migrateBakedProxyEnv(extractProxyFromSystemd(readFileSync(unitPath, "utf-8")));
  }
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, renderSystemdUnit(install.invocation, scope, systemdPathEnv(install.portable)), {
    mode: 0o644,
  });

  const reloadRes = runCapture("systemctl", systemctlArgs(scope, ["daemon-reload"]), 5_000);
  if (!reloadRes.ok) {
    throw new Error(
      `systemctl ${scope === "user" ? "--user " : ""}daemon-reload failed: ${reloadRes.stderr || `exit ${reloadRes.code ?? "unknown"}`}`,
    );
  }

  // Enable linger BEFORE enable --now so the unit can survive logout from
  // the very first session. Best-effort: if polkit denies it, surface a
  // warning with the manual recovery command rather than failing install.
  if (scope === "user") {
    const lingerRes = tryEnableLinger();
    if (!lingerRes.ok) {
      print.line(
        `    warning: loginctl enable-linger failed: ${lingerRes.reason}\n` +
          `    The service will stop when you log out. Run manually: sudo loginctl enable-linger ${userInfo().username}\n`,
      );
    }
  }

  const enableRes = runCapture("systemctl", systemctlArgs(scope, ["enable", "--now", SYSTEMD_UNIT]), 10_000);
  if (!enableRes.ok) {
    const systemctlPrefix = scope === "user" ? "systemctl --user" : "systemctl";
    throw new Error(
      `${systemctlPrefix} enable --now ${SYSTEMD_UNIT} failed: ${enableRes.stderr || `exit ${enableRes.code ?? "unknown"}`}\n` +
        `    Recovery: \`${systemctlPrefix} stop ${SYSTEMD_UNIT}\` then \`${channelConfig.binName} login <code>\`.`,
    );
  }

  const { state, pid, detail } = systemdState();
  return systemdInfo(unitPath, scope, state, pid, detail);
}

function refreshSystemdForUpdate(): ServiceInfo {
  const scope = systemdScope();
  if (scope === "system") assertNoLegacyRootUserUnitDuringRefresh();
  return writeAndEnableSystemd(scope);
}

function installSystemd(): ServiceInfo {
  const scope = systemdScope();
  if (scope === "system") migrateLegacyRootUserUnitToSystemScope();
  // Cross-channel legacy cleanup is deliberately not done here — same reason
  // as `installLaunchd` above. A blanket `disable --now` + `rm` of a retired
  // or sibling channel service unit would silently wipe a peer staging/prod
  // install that the operator hasn't migrated yet. Root's same-channel user
  // unit is the one exception, handled above before the replacement system
  // unit is enabled.
  return writeAndEnableSystemd(scope);
}

function uninstallSystemd(): ServiceInfo {
  const scope = systemdScope();
  const blockedLegacyUnitPath = blockingLegacyRootUserUnitPath(scope);
  if (blockedLegacyUnitPath) {
    return systemdInfo(
      blockedLegacyUnitPath,
      "user",
      "unknown",
      undefined,
      legacyRootUserMigrationDetail(blockedLegacyUnitPath),
      "root-systemd-user-to-system",
    );
  }
  const unitPath = systemdUnitPath(scope);
  const disableRes = runCapture("systemctl", systemctlArgs(scope, ["disable", "--now", SYSTEMD_UNIT]), 10_000);
  if (!disableRes.ok && !/not found|no such|not loaded/i.test(disableRes.stderr)) {
    print.line(
      `    warning: systemctl disable during uninstall: ${disableRes.stderr || `exit ${disableRes.code ?? "unknown"}`}\n`,
    );
  }
  if (existsSync(unitPath)) rmSync(unitPath);
  const reloadRes = runCapture("systemctl", systemctlArgs(scope, ["daemon-reload"]), 5_000);
  if (!reloadRes.ok) {
    print.line(
      `    warning: systemctl daemon-reload during uninstall: ${reloadRes.stderr || `exit ${reloadRes.code ?? "unknown"}`}\n`,
    );
  }
  return {
    platform: "systemd",
    label: SYSTEMD_UNIT,
    unitPath,
    logDir: logDir(),
    state: "not-installed",
    managerScope: scope,
  };
}

function systemdUnitDriftDetected(): boolean {
  const scope = systemdScope();
  if (blockingLegacyRootUserUnitPath(scope)) return true;
  const install = resolveCliInstall();
  const expected = renderSystemdUnit(install.invocation, scope, systemdPathEnv(install.portable));
  return readFileOrFlagDrift(systemdUnitPath(scope), expected);
}

function getSystemdServiceStatus(): ServiceInfo {
  const scope = systemdScope();
  const { state, pid, detail, managerScope, migrationRequired, unitPath } = systemdState();
  return systemdInfo(unitPath ?? systemdUnitPath(scope), managerScope ?? scope, state, pid, detail, migrationRequired);
}

function systemdInfo(
  unitPath: string,
  managerScope: SystemdScope,
  state: ServiceState,
  pid?: number,
  detail?: string,
  migrationRequired?: ServiceInfo["migrationRequired"],
): ServiceInfo {
  let configuredHome: string | undefined;
  if (existsSync(unitPath)) {
    try {
      configuredHome = extractFirstTreeHomeFromSystemd(readFileSync(unitPath, "utf8")) ?? channelConfig.defaultHome;
    } catch {
      // An unreadable definition cannot prove which home the service owns.
      configuredHome = undefined;
    }
  }
  return {
    platform: "systemd",
    label: SYSTEMD_UNIT,
    unitPath,
    logDir: logDir(),
    state,
    configuredHome,
    managerScope,
    migrationRequired,
    pid,
    detail,
  };
}

/** Start the service. No-op + ok if already running. */
function startSystemdService(): ServiceOpResult {
  const scope = systemdScope();
  const legacyUnitPath = blockingLegacyRootUserUnitPath(scope);
  if (legacyUnitPath) return { ok: false, reason: legacyRootUserMigrationDetail(legacyUnitPath) };
  const res = runCapture("systemctl", systemctlArgs(scope, ["start", SYSTEMD_UNIT]), 15_000);
  if (!res.ok) return { ok: false, reason: res.stderr || `exit ${res.code ?? "unknown"}` };
  return { ok: true };
}

/**
 * Stop the service without disabling auto-start on next boot/login.
 *
 * systemd: `systemctl --user stop` — unit stays enabled, so a reboot or
 * `daemon start` brings it back. Combined with `Restart=on-failure +
 * SuccessExitStatus=0` in the unit, the SIGTERM path actually terminates
 * (the bug `Restart=always` had: stop would be immediately undone).
 */
function stopSystemdService(): ServiceOpResult {
  const scope = systemdScope();
  const legacyUnitPath = blockingLegacyRootUserUnitPath(scope);
  if (legacyUnitPath) return { ok: false, reason: legacyRootUserMigrationDetail(legacyUnitPath) };
  const res = runCapture("systemctl", systemctlArgs(scope, ["stop", SYSTEMD_UNIT]), 35_000);
  if (!res.ok) {
    // Mirror the launchd "stop on missing unit = ok" semantics below: a
    // concurrent `daemon stop` or a manual `systemctl --user disable` can
    // leave us racing systemd to a unit that's already gone. Without this
    // tolerance, the second caller sees a spurious failure.
    if (/not loaded|no such|unknown unit|not found/i.test(res.stderr)) return { ok: true, detail: "not running" };
    return { ok: false, reason: res.stderr || `exit ${res.code ?? "unknown"}` };
  }
  return { ok: true };
}

/** Restart the service. Equivalent to stop + start, but uses the manager's atomic primitive. */
function restartSystemdService(): ServiceOpResult {
  const scope = systemdScope();
  const legacyUnitPath = blockingLegacyRootUserUnitPath(scope);
  if (legacyUnitPath) return { ok: false, reason: legacyRootUserMigrationDetail(legacyUnitPath) };
  const res = runCapture("systemctl", systemctlArgs(scope, ["restart", SYSTEMD_UNIT]), 45_000);
  if (!res.ok) return { ok: false, reason: res.stderr || `exit ${res.code ?? "unknown"}` };
  return { ok: true };
}

export const systemdBackend: SupervisorBackend = {
  platform: "systemd",
  isSupported: () => true,
  install: installSystemd,
  refreshForUpdate: refreshSystemdForUpdate,
  isUnitDriftDetected: systemdUnitDriftDetected,
  status: getSystemdServiceStatus,
  start: startSystemdService,
  stop: stopSystemdService,
  restart: restartSystemdService,
  uninstall: uninstallSystemd,
};
