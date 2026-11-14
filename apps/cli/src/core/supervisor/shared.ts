import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { defaultHome } from "@first-tree/shared/config";
import { channelConfig } from "../channel.js";
import { daemonEnvPath } from "../daemon-env.js";
import { print } from "../output.js";
import { type PortableInstallContext, resolvePortableInstallContext } from "../portable-install-context.js";
import type { ResolvedBinary } from "./types.js";

export type ShellResult = { ok: true } | { ok: false; stderr: string; code: number | null };
export type ShellOutResult = { ok: true; stdout: string } | { ok: false; stderr: string; code: number | null };

/**
 * Run a subprocess capturing stderr so failures surface a meaningful error
 * instead of Node's opaque "Command failed". Used for launchctl/systemctl —
 * anywhere the stderr message is diagnostically crucial.
 */
export function runCapture(program: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): ShellResult {
  const res = spawnSync(program, args, {
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
    ...(env ? { env } : {}),
  });
  if (res.status === 0) return { ok: true };
  // spawnSync returns status === null + signal === 'SIGTERM' on timeout.
  // Without this branch every timed-out launchctl/systemctl call surfaces
  // as "exit unknown", which is the most likely failure mode under load
  // (heavy WS connection counts make stop/restart take 30-45s).
  if (res.signal) {
    return { ok: false, stderr: `${program} timed out after ${timeoutMs}ms (signal=${res.signal})`, code: null };
  }
  return {
    ok: false,
    stderr: (res.stderr ?? "").trim(),
    code: res.status,
  };
}

/** Same as runCapture but also returns stdout — for queries (loginctl show-user, etc.). */
export function runCaptureOut(program: string, args: string[], timeoutMs: number): ShellOutResult {
  const res = spawnSync(program, args, {
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status === 0) return { ok: true, stdout: (res.stdout ?? "").trim() };
  if (res.signal) {
    return { ok: false, stderr: `${program} timed out after ${timeoutMs}ms (signal=${res.signal})`, code: null };
  }
  return { ok: false, stderr: (res.stderr ?? "").trim(), code: res.status };
}

export function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

const SYSTEMD_BASE_PATH = ["/usr/local/bin", "/usr/bin", "/bin"];
const LAUNCHD_BASE_PATH = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"];

// Function rather than const: see `channel-env.ts` history note. A
// top-level `const = join(defaultHome(), ...)` would lock at module
// load, re-introducing the bundle eval-order foot-gun that motivated
// the resolver's function-based redesign.
export function logDir(): string {
  return join(defaultHome(), "logs");
}

function servicePathEnv(basePaths: readonly string[], portable?: PortableInstallContext | null): string {
  const seen = new Set<string>();
  const identity = portable === undefined ? resolvePortableInstallContext() : portable;
  const installPaths = identity ? [identity.binDir, identity.nodeBinDir] : [dirname(process.execPath)];
  const paths = [...installPaths, ...basePaths].filter((value) => {
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
  return paths.join(":");
}

export function systemdPathEnv(portable?: PortableInstallContext | null): string {
  return servicePathEnv(SYSTEMD_BASE_PATH, portable);
}

export function launchdPathEnv(portable?: PortableInstallContext | null): string {
  return servicePathEnv(LAUNCHD_BASE_PATH, portable);
}

// Proxy env keys scanned during the one-time upgrade migration below. Both
// lower- and upper-case forms exist because libcurl, git, OpenSSL, and various
// tools each prefer a different case. The service unit no longer bakes these in
// (see `migrateBakedProxyEnv`); the daemon reads the user-owned `daemon.env`
// instead — compatibility, not management.
const PROXY_ENV_KEYS = [
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
] as const;

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/** Read the home pinned into a generated launchd plist. */
export function extractFirstTreeHomeFromPlist(xml: string): string | undefined {
  const match = xml.match(/<key>FIRST_TREE_HOME<\/key>\s*<string>([^<]*)<\/string>/u);
  return match?.[1] ? unescapeXml(match[1]) : undefined;
}

/** Lift proxy env vars baked into a previous launchd plist (pre-compat units). */
export function extractProxyFromPlist(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    const match = xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
    if (match && match[1].length > 0) out[key] = unescapeXml(match[1]);
  }
  return out;
}

function unquoteSystemdEnvironmentValue(raw: string): string {
  let value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return value;
}

/** Read the home pinned into a generated systemd unit. */
export function extractFirstTreeHomeFromSystemd(text: string): string | undefined {
  const match = text.match(/^Environment=FIRST_TREE_HOME=(.*)$/mu);
  return match ? unquoteSystemdEnvironmentValue(match[1]) : undefined;
}

/** Lift proxy env vars baked into a previous systemd unit (pre-compat units). */
export function extractProxyFromSystemd(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PROXY_ENV_KEYS) {
    const match = text.match(new RegExp(`^Environment=${key}=(.*)$`, "m"));
    if (!match) continue;
    const value = unquoteSystemdEnvironmentValue(match[1]);
    if (value.length > 0) out[key] = value;
  }
  return out;
}

/**
 * One-time upgrade buffer. Service units built before the "compatible, not
 * managing" redesign baked the user's proxy env directly into the plist /
 * systemd unit, which then went stale and self-froze on auto-update. Now the
 * daemon reads proxy from the user-owned `daemon.env` instead, so a straight
 * re-render would silently drop a proxy the user is relying on.
 *
 * So when re-rendering: if `daemon.env` does not exist yet AND the previous
 * on-disk unit carried proxy vars, copy them across ONCE. After that the file
 * is the user's to edit or delete and First Tree never rewrites it. No previous
 * unit, no baked proxy, or an existing `daemon.env` → no-op. Best-effort: a
 * write failure must never block service install.
 */
export function migrateBakedProxyEnv(proxy: Record<string, string>): void {
  if (Object.keys(proxy).length === 0) return;
  const envPath = daemonEnvPath();
  if (existsSync(envPath)) return; // the user already owns this file
  try {
    mkdirSync(dirname(envPath), { recursive: true, mode: 0o700 });
    const body = Object.entries(proxy)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    writeFileSync(
      envPath,
      "# Migrated once by First Tree from the previous service unit's baked proxy env.\n" +
        "# This file is yours: edit or delete it freely. First Tree reads it on daemon\n" +
        "# start but never rewrites it.\n" +
        `${body}\n`,
      { mode: 0o600 },
    );
    print.line(`    migrated proxy env into ${envPath} (yours to edit henceforth)\n`);
  } catch {
    // Best-effort migration — surfacing nothing is better than aborting install.
  }
}

function whichBin(name: string): string | null {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [name], {
      encoding: "utf-8",
      timeout: 3000,
    })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    return out[0] ?? null;
  } catch {
    return null;
  }
}

function normalizeWindowsCliBin(bin: string): string {
  if (process.platform !== "win32") return bin;
  if (/\.(?:cmd|bat|exe)$/iu.test(bin)) return bin;

  const cmdShim = `${bin}.cmd`;
  return existsSync(cmdShim) ? cmdShim : bin;
}

/**
 * Resolve how the service should launch the CLI.
 *
 * Multi-env world: every channel has its own bin name (`first-tree` /
 * `first-tree-staging` / `first-tree-dev`), so a PATH lookup against
 * `channelConfig.binName` cannot collide with another channel's install.
 *
 *   ① bin found on PATH — use the installed shim. For npm-installed
 *      packages (prod, staging) the shim is usually under /usr/local/bin
 *      or ~/.npm-global/bin; for dev it's typically a symlink under
 *      ~/.local/bin pointing at the in-tree dist. Either way, using the
 *      shim means a re-install / re-link atomically swaps the binary
 *      without rewriting the unit file.
 *
 *   ② bin NOT on PATH — pin to the running interpreter + script. Common
 *      for dev when `~/.local/bin` is not in the install-time shell's
 *      PATH. `process.argv[1]` is the .mjs file the user just ran (via
 *      symlink or absolute path), so this guarantees the service launches
 *      the same binary the operator invoked.
 */
export type ResolvedCliInstall = {
  invocation: ResolvedBinary;
  portable: PortableInstallContext | null;
};

export function resolveCliInstall(): ResolvedCliInstall {
  const portable = resolvePortableInstallContext();
  if (portable) {
    return { invocation: { kind: "bin", program: portable.cliPath }, portable };
  }

  const bin = whichBin(channelConfig.binName);
  if (bin && isAbsolute(bin)) {
    const serviceBin = normalizeWindowsCliBin(bin);
    try {
      // Resolve symlinks so launchd records a stable path.
      return { invocation: { kind: "bin", program: realpathSync(serviceBin) }, portable: null };
    } catch {
      return { invocation: { kind: "bin", program: serviceBin }, portable: null };
    }
  }

  const script = process.argv[1];
  if (!script) {
    throw new Error("Cannot resolve CLI entry point (process.argv[1] is empty).");
  }
  const scriptAbs = isAbsolute(script) ? script : join(process.cwd(), script);
  return { invocation: { kind: "node", program: process.execPath, args: [scriptAbs] }, portable: null };
}

export function resolveCliInvocation(): ResolvedBinary {
  return resolveCliInstall().invocation;
}

export function ensureLogDir(): void {
  mkdirSync(logDir(), { recursive: true, mode: 0o700 });
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_\-./:=]+$/.test(value)) return value;
  // POSIX single quotes: nothing inside is expanded, and an embedded quote is
  // closed + re-opened. Double quotes are not enough here — `$` and backticks
  // stay live inside them, so a path like `/tmp/$(id)` would execute when the
  // generated launcher runs (SEC-028).
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function readFileOrFlagDrift(path: string, expected: string): boolean {
  if (!existsSync(path)) return true;
  try {
    const actual = readFileSync(path, "utf-8");
    return actual !== expected;
  } catch {
    // Treat unreadable as drift — better to install than silently skip.
    return true;
  }
}
