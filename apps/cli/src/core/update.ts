import { type ChildProcess, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, ERROR_KINDS, getChildProcessRegistry } from "@first-tree/client";
import {
  type PortableAsset,
  type PortableInstallMetadata,
  type PortableLatest,
  type PortableManifest,
  type PortablePlatform,
  portableInstallMetadataSchema,
  portableLatestSchema,
  portableManifestSchema,
  portablePlatformSchema,
} from "@first-tree/shared";
import { inferChannelFromVersion } from "@first-tree/shared/channel";
import * as semver from "semver";
import { resolveServerUrl, ServerUrlNotConfiguredError } from "./bootstrap.js";
import { channelConfig } from "./channel.js";
import { cliFetch } from "./cli-fetch.js";
import { resolveNpmInvocation } from "./npm-invocation.js";
import { print } from "./output.js";
import {
  hasPortableInstallSignal,
  type PortableInstallContext,
  portableShimContents,
  resolvePortableInstallContext,
} from "./portable-install-context.js";

/** Hard ceiling on a single `npm install -g` invocation (5 min). */
const NPM_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
/** Short metadata probe used only to catch guaranteed npm-mode engine mismatch. */
const NPM_METADATA_TIMEOUT_MS = 10 * 1000;
const SYSTEMD_UPDATE_RUNNER = "systemd-run";

export type InstallMode = "global" | "npx" | "source" | "portable";
export type VersionLookupFailureCode = "server_url_not_configured";
export type VersionLookupResult =
  | { ok: true; version: string }
  | { ok: false; reason: string; reasonCode?: VersionLookupFailureCode };

type PortableMetadataIdentity = {
  channel: string;
  version: string;
  packageName: string;
  binName: string;
  aliasName: string;
};

/**
 * npm package name this binary self-updates against. Derived from the
 * channel (`first-tree`, `first-tree-staging`, or `null` for dev — dev
 * binaries are not published and refuse self-update entirely).
 */
export const PACKAGE_NAME = channelConfig.packageName;

/**
 * Detect how the CLI was launched. Used by the update path to decide whether
 * `npm install -g <pkg>@latest` makes sense.
 *
 *  - `"global"`: launched from an `npm install -g` install. The self-update
 *    can reinstall the same package at a caller-selected spec.
 *  - `"source"`: launched from inside a git checkout (dev / monorepo). Update
 *    is a no-op; operator should `git pull`.
 *  - `"npx"` (fallback): any other path (e.g. one-shot `npx`, pnpm dlx). Auto
 *    update is not safe; log a hint and skip.
 */
export function detectInstallMode(
  argv1: string = process.argv[1] ?? "",
  packageName: string | null = PACKAGE_NAME,
): InstallMode {
  if (hasPortableInstallSignal()) return "portable";
  // dev channel is not published to npm — there is no `node_modules/<pkg>`
  // tree to detect a "global" install against. Treat dev binaries as
  // running from source so the update path declines self-update with the
  // "use git pull" hint.
  if (packageName === null) return "source";
  if (!argv1) return "npx";
  // Resolve symlinks first. Standard `npm i -g` lays the binary out as
  // `<prefix>/bin/<name> -> ../lib/node_modules/<pkg>/dist/cli/index.mjs`,
  // and `process.argv[1]` keeps the symlink path. Walking from the link
  // dir (`<prefix>/bin/`) never hits an ancestor `package.json` matching
  // our name, so the function falls through to "npx" and `update` refuses
  // to run on a perfectly valid global install. realpathSync moves the
  // walk start into the package tree where detection actually works.
  // Wrapped in try/catch because argv1 may be a path that no longer
  // exists on disk (overridden process.argv[1], odd test fixtures).
  let resolvedArgv1: string;
  try {
    resolvedArgv1 = realpathSync(argv1);
  } catch {
    resolvedArgv1 = argv1;
  }
  // Cap at 10 levels to avoid runaway walks on exotic symlink layouts.
  const start = dirname(resolve(resolvedArgv1));

  // A globally-installed (or npx-cached) package always lives under a
  // `node_modules/` directory, never directly inside a source checkout.
  // Skip the ancestor-`.git` scan in that case — otherwise we mis-classify
  // legitimate installs as "source" whenever the install prefix happens to
  // sit inside a git-tracked directory. Real-world triggers: a Homebrew
  // prefix that was `git init`-ed by the operator, a `$HOME` managed by
  // dotfiles tools (yadm / chezmoi / homeshick) combined with
  // `npm config set prefix ~/.local`, or a CI image that tracks the whole
  // root with git. Symptom: `update` silently prints
  // "Running from source checkout — self-update skipped" forever and the
  // client never picks up new versions.
  const inNodeModules = /(?:^|[\\/])node_modules[\\/]/.test(resolvedArgv1);

  // Pass 1: any ancestor with a `.git` dir means we're inside a checkout.
  // This MUST happen before the package.json scan — when a built dist lives
  // at `apps/cli/dist/index.mjs` inside the monorepo, the scan
  // would otherwise hit `apps/cli/package.json` (name matches)
  // before reaching the repo root's `.git`, mis-classifying a dev build
  // as `global` and letting `update` run `npm i -g` against the operator's
  // real install. The two-pass split keeps source-checkout detection
  // strictly higher priority than "package on disk with our name".
  if (!inNodeModules) {
    let dir = start;
    for (let i = 0; i < 10; i++) {
      if (existsSync(resolve(dir, ".git"))) return "source";
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // Pass 2: find an ancestor `package.json` whose `name` matches ours.
  let dir = start;
  for (let i = 0; i < 10; i++) {
    const pkgPath = resolve(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
        if (pkg.name === packageName) {
          // Installed package — treat as global. `npx` also lays the tree out
          // this way, but npx caches under a path whose basename starts with
          // an underscore and lives under `_npx`. Probe for that.
          if (/\/(?:_npx|\.npm\/_npx)\//.test(dir)) return "npx";
          return "global";
        }
      } catch {
        // malformed package.json — keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "npx";
}

export type ExecuteUpdateResult =
  | { ok: true; mode: InstallMode; installedVersion: string | null }
  | {
      ok: false;
      mode: InstallMode;
      reason: string;
      /**
       * Bug 4: should the UpdateManager attempt this version again on the
       * next welcome tick? `true` for transient failures (network blips,
       * registry 5xx, killed-by-our-timeout), `false` for permanent
       * (EBADENGINE, permission, version not found).
       */
      retryable?: boolean;
      /** Stable code from the error taxonomy for log / telemetry routing. */
      reasonCode?: string;
    };

export type InstallGlobalSpecOptions = {
  output?: (chunk: string) => void;
  /** Run the install outside the supervisor cgroup when the daemon is managed. */
  managed?: boolean;
};

function writeInstallOutput(options: InstallGlobalSpecOptions | undefined, chunk: string): void {
  (options?.output ?? print.line)(chunk);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function systemdManagerArgs(): string[] {
  return process.getuid?.() === 0 ? [] : ["--user"];
}

function systemdUpdateUnitName(): string {
  const serviceUnit = channelConfig.serviceUnitFile.replace(/\.service$/u, "");
  return `${serviceUnit}-update.service`;
}

/**
 * Keep the npm tree quiescent while npm reifies it. The service stop is part
 * of the transient unit rather than the daemon process, so systemd can kill
 * the daemon's `systemd-run` client without killing this worker. The old
 * package and bin links are moved aside first; a failed or interrupted npm
 * run is rolled back before the service is started again.
 */
function systemdUpdateScript(): string {
  const systemctl = ["systemctl", ...systemdManagerArgs()].map(shellQuote).join(" ");
  const packageName = shellQuote(PACKAGE_NAME ?? "");
  const binName = shellQuote(channelConfig.binName);
  const aliasName = shellQuote(channelConfig.aliasName);
  const serviceUnit = shellQuote(channelConfig.serviceUnitFile);

  return [
    "set -u",
    "service_stopped=0",
    "install_succeeded=0",
    "rollback_safe=1",
    "had_package=0",
    "had_bin=0",
    "had_alias=0",
    "package_backup=",
    "bin_backup=",
    "alias_backup=",
    "package_root=",
    "prefix=",
    "package_dir=",
    "bin_dir=",
    "bin_path=",
    "alias_path=",
    'path_exists() { [ -e "$1" ] || [ -L "$1" ]; }',
    'remove_path() { if path_exists "$1"; then rm -rf -- "$1" || return 1; fi; }',
    "restore_path() {",
    '  original="$1"',
    '  backup="$2"',
    '  had="$3"',
    '  remove_path "$original" || return 1',
    '  if [ "$had" -eq 1 ]; then',
    '    mv -- "$backup" "$original" || return 1',
    "  fi",
    "}",
    "rollback() {",
    "  rollback_status=0",
    '  if [ -n "$package_dir" ]; then restore_path "$package_dir" "$package_backup" "$had_package" || rollback_status=1; fi',
    '  if [ -n "$bin_path" ]; then restore_path "$bin_path" "$bin_backup" "$had_bin" || rollback_status=1; fi',
    '  if [ -n "$alias_path" ]; then restore_path "$alias_path" "$alias_backup" "$had_alias" || rollback_status=1; fi',
    '  return "$rollback_status"',
    "}",
    "finish() {",
    "  status=$?",
    '  if [ "$install_succeeded" -ne 1 ]; then',
    "    rollback || rollback_safe=0",
    "  else",
    '    remove_path "$package_backup" || true',
    '    remove_path "$bin_backup" || true',
    '    remove_path "$alias_backup" || true',
    "  fi",
    '  if [ "$service_stopped" -eq 1 ] && { [ "$install_succeeded" -eq 1 ] || [ "$rollback_safe" -eq 1 ]; }; then',
    `    ${systemctl} start ${serviceUnit} >/dev/null 2>&1 || start_status=$?`,
    "    start_status=$" + "{start_status:-0}",
    '    if [ "$status" -eq 0 ] && [ "$start_status" -ne 0 ]; then status=$start_status; fi',
    "  fi",
    '  exit "$status"',
    "}",
    "trap finish EXIT",
    "trap 'exit 143' HUP INT TERM",
    `npm_command="$1"; shift; package_name=${packageName}; bin_name=${binName}; alias_name=${aliasName}`,
    `${systemctl} stop ${serviceUnit}`,
    "stop_status=$?",
    'if [ "$stop_status" -ne 0 ]; then exit "$stop_status"; fi',
    "service_stopped=1",
    'package_root=$("$npm_command" root --global 2>/dev/null) || exit 1',
    'prefix=$("$npm_command" prefix --global 2>/dev/null) || exit 1',
    'case "$package_root" in /*) ;; *) exit 1 ;; esac',
    'case "$prefix" in /*) ;; *) exit 1 ;; esac',
    'package_dir="$package_root/$package_name"',
    'bin_dir="$prefix/bin"',
    'bin_path="$bin_dir/$bin_name"',
    'alias_path="$bin_dir/$alias_name"',
    'package_backup="$package_dir.first-tree-update-backup.$$"',
    'bin_backup="$bin_path.first-tree-update-backup.$$"',
    'alias_backup="$alias_path.first-tree-update-backup.$$"',
    'if path_exists "$package_backup" || path_exists "$bin_backup" || path_exists "$alias_backup"; then package_dir=; bin_path=; alias_path=; exit 1; fi',
    'if path_exists "$package_dir"; then if mv -- "$package_dir" "$package_backup"; then had_package=1; else package_dir=; bin_path=; alias_path=; exit 1; fi; fi',
    'if path_exists "$bin_path"; then if mv -- "$bin_path" "$bin_backup"; then had_bin=1; else bin_path=; alias_path=; exit 1; fi; fi',
    'if path_exists "$alias_path"; then if mv -- "$alias_path" "$alias_backup"; then had_alias=1; else alias_path=; exit 1; fi; fi',
    '"$npm_command" "$@"',
    "install_status=$?",
    'if [ "$install_status" -ne 0 ]; then exit "$install_status"; fi',
    "install_succeeded=1",
    "exit 0",
  ].join("\n");
}

function systemdUpdateArgs(npm: ReturnType<typeof resolveNpmInvocation>): string[] {
  const environment = [
    "PATH",
    "HOME",
    "FIRST_TREE_HOME",
    "NPM_CONFIG_PREFIX",
    "NPM_CONFIG_USERCONFIG",
    "NPM_CONFIG_REGISTRY",
    "NPM_CONFIG_CACHE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "NODE_OPTIONS",
  ]
    .map((name) => {
      const value = process.env[name];
      return value === undefined ? null : `--setenv=${name}=${value}`;
    })
    .filter((value): value is string => value !== null);

  return [
    ...systemdManagerArgs(),
    "--unit",
    systemdUpdateUnitName(),
    "--collect",
    "--wait",
    "--pipe",
    "--quiet",
    "--service-type=oneshot",
    `--property=TimeoutStartSec=${NPM_INSTALL_TIMEOUT_MS / 1000}s`,
    ...environment,
    "--",
    "/bin/sh",
    "-c",
    systemdUpdateScript(),
    "first-tree-npm-update",
    npm.command,
    ...npm.args,
  ];
}

function isMissingCommandError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

/**
 * Validate an npm install spec (the part after `@` in `<pkg>@<spec>`). We
 * accept either a known dist-tag string (`latest`, `alpha`, …) or an exact
 * SemVer version (`0.14.7`, `0.14.8-alpha.286.1`). The intent is purely
 * defensive: the spec is concatenated into the npm CLI args, and we never
 * want to forward an attacker-controlled shell metacharacter from a
 * (compromised) server welcome frame straight into `spawn`. spawn() already
 * argv-escapes, but a `--registry=...` style spec would still be
 * interpreted as an npm flag — refusing leading dashes and whitespace
 * collapses the surface unambiguously.
 */
function isSafeInstallSpec(spec: string): boolean {
  if (typeof spec !== "string" || spec.length === 0 || spec.length > 128) return false;
  // Allow letters, digits, dot, plus, hyphen — covers every legal SemVer +
  // dist-tag. Crucially excludes whitespace, `@`, `/`, `=`, shell quotes.
  // Hyphens inside the body are fine (`0.14.8-staging.286.1`), but a
  // leading hyphen would let the spec smuggle in as an npm flag.
  if (spec.startsWith("-")) return false;
  return /^[A-Za-z0-9.+-]+$/.test(spec);
}

/** Does this spec look like a concrete SemVer (vs a dist-tag like "latest")? */
function looksLikeVersion(spec: string): boolean {
  return /^\d+\.\d+\.\d+(?:-|$)/.test(spec);
}

function parseNpmViewEngineRange(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || trimmed === "null" || trimmed === "undefined") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed === "string" && parsed.trim().length > 0) return parsed.trim();
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record["engines.node"] === "string" && record["engines.node"].trim().length > 0) {
    return record["engines.node"].trim();
  }
  const engines = record.engines;
  if (engines !== null && typeof engines === "object" && !Array.isArray(engines)) {
    const node = (engines as Record<string, unknown>).node;
    if (typeof node === "string" && node.trim().length > 0) return node.trim();
  }
  return null;
}

function lookupNpmTargetNodeEngineRange(spec: string): string | null {
  if (PACKAGE_NAME === null) return null;
  const npm = resolveNpmInvocation(["view", `${PACKAGE_NAME}@${spec}`, "engines.node", "--json"]);
  const res = spawnSync(npm.command, npm.args, {
    encoding: "utf-8",
    shell: npm.shell,
    timeout: NPM_METADATA_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) return null;
  return parseNpmViewEngineRange(res.stdout ?? "");
}

function portableMigrationHint(): string {
  const baseUrl = channelConfig.portable.downloadBaseUrl?.replace(/\/+$/, "");
  const installerPath = channelConfig.portable.publicInstallerPath;
  if (baseUrl && installerPath) {
    return `or migrate to the portable install path from the web console (installer: ${baseUrl}/${installerPath})`;
  }
  return "or migrate to the portable install path from the web console";
}

function checkNpmTargetNodeEngine(spec: string): Extract<ExecuteUpdateResult, { ok: false }> | null {
  const range = lookupNpmTargetNodeEngineRange(spec);
  if (range === null) return null;
  const normalizedRange = semver.validRange(range);
  if (normalizedRange === null) return null;
  if (semver.satisfies(process.version, normalizedRange, { includePrerelease: true })) return null;
  const packageSpec = PACKAGE_NAME === null ? channelConfig.binName : `${PACKAGE_NAME}@${spec}`;
  return {
    ok: false,
    mode: "global",
    reason:
      `Cannot install ${packageSpec}: this npm-mode install is running on Node ${process.version}, ` +
      `but the target package requires Node ${range}. npm-mode updates cannot replace the system Node runtime; ` +
      `upgrade system Node and rerun \`${channelConfig.binName} upgrade\`, ${portableMigrationHint()}.`,
    retryable: false,
    reasonCode: "npm_ebadengine",
  };
}

function npmPrefixFailure(reason: string, reasonCode: string): Extract<ExecuteUpdateResult, { ok: false }> {
  return {
    ok: false,
    mode: "global",
    reason,
    retryable: false,
    reasonCode,
  };
}

function portableNodeVersionDir(prefix: string): string | null {
  let cursor = resolve(prefix);
  for (let depth = 0; depth < 8; depth++) {
    const versionDir = dirname(cursor);
    if (basename(cursor) === "node" && basename(dirname(versionDir)) === "versions") return versionDir;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

/** Refuse npm-global writes when this npm resolves inside a portable version tree. */
function guardNpmGlobalPrefix(): Extract<ExecuteUpdateResult, { ok: false }> | null {
  const npm = resolveNpmInvocation(["prefix", "--global"]);
  const probe = spawnSync(npm.command, npm.args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: NPM_METADATA_TIMEOUT_MS,
    shell: npm.shell,
  });
  if (probe.error || probe.status !== 0) {
    const detail = probe.error?.message ?? probe.stderr?.trim() ?? `exit ${probe.status ?? "unknown"}`;
    return npmPrefixFailure(
      `Refusing npm-global update because the npm global prefix could not be verified (${detail}).`,
      "npm_prefix_probe_failed",
    );
  }

  const prefix = probe.stdout?.trim();
  if (!prefix || !isAbsolute(prefix)) {
    return npmPrefixFailure(
      `Refusing npm-global update because npm returned an invalid global prefix: ${JSON.stringify(prefix ?? "")}.`,
      "npm_prefix_probe_failed",
    );
  }

  let canonicalPrefix: string;
  try {
    canonicalPrefix = realpathSync(prefix);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return npmPrefixFailure(
      `Refusing npm-global update because npm prefix ${prefix} could not be resolved (${detail}).`,
      "npm_prefix_probe_failed",
    );
  }

  const versionDir = portableNodeVersionDir(canonicalPrefix);
  if (versionDir === null) return null;

  let parsed: ReturnType<typeof portableInstallMetadataSchema.safeParse>;
  try {
    parsed = portableInstallMetadataSchema.safeParse(
      JSON.parse(readFileSync(join(versionDir, "INSTALL.json"), "utf8")),
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return npmPrefixFailure(
      `Refusing npm-global update because ${canonicalPrefix} is inside a portable-shaped versions tree whose provenance cannot be verified (${detail}).`,
      "npm_prefix_provenance_unknown",
    );
  }
  if (!parsed.success) {
    return npmPrefixFailure(
      `Refusing npm-global update because ${canonicalPrefix} is inside a portable-shaped versions tree with invalid INSTALL.json metadata.`,
      "npm_prefix_provenance_unknown",
    );
  }

  const mismatch = validatePortableMetadata(parsed.data);
  if (parsed.data.installMode !== "portable" || mismatch) {
    return npmPrefixFailure(
      `Refusing npm-global update because ${canonicalPrefix} is inside a portable-shaped versions tree with conflicting installation metadata${mismatch ? ` (${mismatch})` : ""}.`,
      "npm_prefix_provenance_unknown",
    );
  }

  return npmPrefixFailure(
    `Refusing npm-global update because npm prefix ${canonicalPrefix} is inside the immutable portable version ${parsed.data.version}. ` +
      `Rerun the current channel portable installer and then invoke its absolute channel shim to repair the service; ${portableMigrationHint()}.`,
    "npm_prefix_inside_portable_install",
  );
}

function failPortable(reason: string, retryable = false, reasonCode?: string): ExecuteUpdateResult {
  const base = { ok: false as const, mode: "portable" as const, reason, retryable };
  return reasonCode ? { ...base, reasonCode } : base;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function portableDownloadBaseUrl(): string | null {
  const override = process.env.FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL;
  if (override && override.trim().length > 0) return normalizeBaseUrl(override.trim());
  const configured = channelConfig.portable.downloadBaseUrl;
  return configured ? normalizeBaseUrl(configured) : null;
}

function detectPortablePlatform(): PortablePlatform | null {
  const os = process.platform === "darwin" || process.platform === "linux" ? process.platform : null;
  if (os === null) return null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (arch === null) return null;
  const parsed = portablePlatformSchema.safeParse(`${os}-${arch}`);
  return parsed.success ? parsed.data : null;
}

function portableMetadataUrl(spec: string): string | { reason: string } {
  const channelPrefix = channelConfig.portable.channelPrefix;
  if (channelPrefix === null) {
    return { reason: "self-update disabled: this binary's channel does not publish portable artifacts." };
  }
  const baseUrl = portableDownloadBaseUrl();
  if (baseUrl === null) {
    return { reason: "self-update disabled: portable download base URL is not configured for this channel." };
  }
  if (spec === "latest") return `${baseUrl}/${channelPrefix}/latest.json`;
  const normalized = semver.valid(spec);
  if (!normalized) return { reason: `Refusing to install: invalid portable version ${JSON.stringify(spec)}` };
  return `${baseUrl}/${channelPrefix}/${normalized}/manifest.json`;
}

async function fetchPortableJson(url: string): Promise<unknown> {
  const text = await readPortableText(url);
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`invalid JSON from ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function readPortableText(url: string): Promise<string> {
  if (url.startsWith("file://")) {
    return readFile(fileURLToPath(url), "utf8");
  }
  const res = await cliFetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`download failed for ${url}: HTTP ${res.status}`);
  return res.text();
}

async function downloadPortableFile(url: string, dest: string): Promise<void> {
  if (url.startsWith("file://")) {
    const body = await readFile(fileURLToPath(url));
    await writeFile(dest, body);
    return;
  }
  const res = await cliFetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`download failed for ${url}: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, body);
}

function validatePortableMetadata(meta: PortableMetadataIdentity): string | null {
  if (meta.channel !== channelConfig.channel) {
    return `portable metadata channel "${meta.channel}" does not match my channel "${channelConfig.channel}"`;
  }
  if (meta.packageName !== channelConfig.packageName) {
    return `portable metadata package "${meta.packageName}" does not match my package "${channelConfig.packageName ?? "(none)"}"`;
  }
  if (meta.binName !== channelConfig.binName) {
    return `portable metadata bin "${meta.binName}" does not match my bin "${channelConfig.binName}"`;
  }
  if (meta.aliasName !== channelConfig.aliasName) {
    return `portable metadata alias "${meta.aliasName}" does not match my alias "${channelConfig.aliasName}"`;
  }
  const targetChannel = inferChannelFromVersion(meta.version);
  if (targetChannel !== channelConfig.channel) {
    return (
      `portable metadata version ${meta.version} belongs to channel "${targetChannel}", ` +
      `not my channel "${channelConfig.channel}"`
    );
  }
  return null;
}

function selectPortableAsset(
  meta: PortableManifest | PortableLatest,
  platform: PortablePlatform,
): PortableAsset | null {
  return meta.assets.find((asset) => asset.platform === platform) ?? null;
}

function validatePortableAsset(asset: PortableAsset): string | null {
  if (basename(asset.fileName) !== asset.fileName || asset.fileName.includes("\\") || asset.fileName.startsWith(".")) {
    return `portable asset fileName is not a safe basename: ${JSON.stringify(asset.fileName)}`;
  }
  return null;
}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

async function extractPortableTarball(tarball: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const res = spawnSync("tar", ["-xzf", tarball, "-C", dest], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) throw new Error(`tar failed to start: ${res.error.message}`);
  if (res.status !== 0) {
    const detail = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`tar exited with code ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`);
  }
}

async function parseExtractedInstallMetadata(dir: string): Promise<PortableInstallMetadata> {
  const path = join(dir, "INSTALL.json");
  let body: unknown;
  try {
    body = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (err) {
    throw new Error(
      `extracted artifact missing or invalid INSTALL.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return portableInstallMetadataSchema.parse(body);
}

function validateExtractedInstallMetadata(
  install: PortableInstallMetadata,
  meta: PortableManifest | PortableLatest,
  platform: PortablePlatform,
): string | null {
  const metadataMismatch = validatePortableMetadata(install);
  if (metadataMismatch) return `extracted INSTALL.json mismatch: ${metadataMismatch}`;
  if (install.version !== meta.version) {
    return `extracted INSTALL.json version "${install.version}" does not match metadata version "${meta.version}"`;
  }
  if (install.platform !== platform) {
    return `extracted INSTALL.json platform "${install.platform}" does not match current platform "${platform}"`;
  }
  if (install.installMode !== "portable") return "extracted INSTALL.json does not describe a portable install";
  if (install.appEntry !== "app/cli/index.mjs") {
    return `extracted INSTALL.json appEntry "${install.appEntry}" is not supported`;
  }
  return null;
}

async function switchPortableCurrent(prefix: string, versionDir: string): Promise<void> {
  const currentLink = join(prefix, "current");
  const newLink = join(prefix, `.current.${process.pid}.${Date.now()}`);
  try {
    const stat = await lstat(currentLink);
    if (!stat.isSymbolicLink()) {
      throw new Error(`${currentLink} exists and is not a symlink`);
    }
  } catch (err) {
    if (!(err instanceof Error) || !("code" in err) || err.code !== "ENOENT") throw err;
  }
  await rm(newLink, { force: true });
  await symlink(versionDir, newLink);
  try {
    await rename(newLink, currentLink);
  } catch (err) {
    await rm(newLink, { force: true });
    throw err;
  }
}

async function writePortableShim(path: string, root: string, binDir: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, portableShimContents(root, binDir), { mode: 0o755 });
  await chmod(tmp, 0o755);
  await rename(tmp, path);
}

async function rewritePortableShims(context: PortableInstallContext): Promise<void> {
  const binNames = [channelConfig.binName, channelConfig.aliasName];
  await Promise.all(
    binNames.map((name) => writePortableShim(join(context.binDir, name), context.root, context.binDir)),
  );
}

function portableInstallFailure(err: unknown, reasonCode = "portable_update_failed"): ExecuteUpdateResult {
  const message = err instanceof Error ? err.message : String(err);
  const classification = classify(new Error(message), { source: "update" });
  return failPortable(message, classification.kind === ERROR_KINDS.TRANSIENT, classification.reasonCode ?? reasonCode);
}

async function installPortableMeta(
  meta: PortableManifest | PortableLatest,
  platform: PortablePlatform,
): Promise<ExecuteUpdateResult> {
  const metadataMismatch = validatePortableMetadata(meta);
  if (metadataMismatch) return failPortable(`Refusing to install portable update: ${metadataMismatch}`);

  const asset = selectPortableAsset(meta, platform);
  if (!asset) return failPortable(`No portable asset for ${platform} in metadata for ${meta.version}`);
  const assetMismatch = validatePortableAsset(asset);
  if (assetMismatch) return failPortable(`Refusing to install portable update: ${assetMismatch}`);

  const installContext = resolvePortableInstallContext();
  if (installContext === null) {
    return failPortable("Portable self-update requires an explicit portable installation identity.");
  }
  const { prefix } = installContext;

  await mkdir(join(prefix, ".tmp"), { recursive: true });
  const tempRoot = await mkdtemp(join(prefix, ".tmp", "update-"));
  const extractDir = join(tempRoot, "extract");
  const tarball = join(tempRoot, asset.fileName);
  const finalVersionDir = join(prefix, "versions", meta.version);

  try {
    await mkdir(join(prefix, "versions"), { recursive: true });
    await downloadPortableFile(asset.url, tarball);
    const actual = sha256File(tarball);
    if (actual !== asset.sha256) {
      return failPortable(`checksum mismatch for portable payload: expected ${asset.sha256}, got ${actual}`);
    }

    if (!existsSync(finalVersionDir)) {
      await extractPortableTarball(tarball, extractDir);
    }

    const validationDir = existsSync(finalVersionDir) ? finalVersionDir : extractDir;
    const installMeta = await parseExtractedInstallMetadata(validationDir);
    const extractedMismatch = validateExtractedInstallMetadata(installMeta, meta, platform);
    if (extractedMismatch) return failPortable(`Refusing to install portable update: ${extractedMismatch}`);
    if (!existsSync(finalVersionDir)) {
      await rename(extractDir, finalVersionDir);
    }

    // Prepare both stable shims while `current` still points at the old,
    // known-good version. A shim-write failure therefore cannot partially
    // commit the new runtime. Switching `current` is the final commit point.
    await rewritePortableShims(installContext);
    await switchPortableCurrent(prefix, finalVersionDir);
    return { ok: true, mode: "portable", installedVersion: meta.version };
  } catch (err) {
    return portableInstallFailure(err);
  } finally {
    // `current` is the commit point. Cleanup must never turn an already
    // committed update into a reported failure, because callers would then
    // retry against a runtime that has in fact changed underneath them.
    try {
      await rm(tempRoot, { recursive: true, force: true });
    } catch {
      // best-effort; the next update uses a distinct mkdtemp directory
    }
  }
}

/**
 * Install a portable artifact selected by exact SemVer or `latest`.
 *
 * This intentionally mirrors `scripts/portable/install.sh`: metadata comes
 * from the channel prefix, the current platform asset is checksum-verified,
 * the payload is extracted into `versions/<version>`, and `current` is
 * replaced only after all validation succeeds.
 */
export async function installPortableSpec(spec: string): Promise<ExecuteUpdateResult> {
  if (spec !== "latest" && !semver.valid(spec)) {
    return failPortable(`Refusing to install: invalid portable version ${JSON.stringify(spec)}`);
  }

  const platform = detectPortablePlatform();
  if (platform === null) {
    return failPortable(`portable self-update is not supported on ${process.platform}-${process.arch}`);
  }

  const metadataUrl = portableMetadataUrl(spec);
  if (typeof metadataUrl !== "string") return failPortable(metadataUrl.reason);

  try {
    const raw = await fetchPortableJson(metadataUrl);
    const parsed = spec === "latest" ? portableLatestSchema.parse(raw) : portableManifestSchema.parse(raw);
    return await installPortableMeta(parsed, platform);
  } catch (err) {
    return portableInstallFailure(err);
  }
}

/** Look up the latest portable artifact version for this binary's channel. */
export async function fetchPortableLatestVersion(): Promise<VersionLookupResult> {
  const metadataUrl = portableMetadataUrl("latest");
  if (typeof metadataUrl !== "string") return { ok: false, reason: metadataUrl.reason };

  try {
    const parsed = portableLatestSchema.parse(await fetchPortableJson(metadataUrl));
    const metadataMismatch = validatePortableMetadata(parsed);
    if (metadataMismatch) return { ok: false, reason: `Refusing portable latest metadata: ${metadataMismatch}` };
    const normalized = semver.valid(parsed.version);
    if (!normalized)
      return { ok: false, reason: `portable latest metadata returned non-semver version: ${parsed.version}` };
    return { ok: true, version: normalized };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Install `<pkg>@<spec>` globally. `spec` is either a dist-tag (e.g. `latest`)
 * or an exact version (e.g. `0.14.7-alpha.286.1`). Returns after the child
 * exits. Does not exit the parent process — callers are expected to handle
 * that (so the UpdateManager can attempt the restart itself while this
 * function remains side-effect-scoped).
 *
 * Why both shapes exist: managed update paths usually receive an exact target
 * version from the server and MUST install that exact version. The dist-tag
 * form remains for default `upgrade` fallback before server URL configuration
 * and for hidden compatibility with older operator scripts.
 */
export async function installGlobalSpec(
  spec: string,
  options?: InstallGlobalSpecOptions,
): Promise<ExecuteUpdateResult> {
  if (!isSafeInstallSpec(spec)) {
    return {
      ok: false,
      mode: "global",
      reason: `Refusing to install: invalid npm spec ${JSON.stringify(spec)}`,
    };
  }
  // dev channel is not published — `npm install -g <null>` makes no sense.
  // Bail out before spawning npm.
  if (PACKAGE_NAME === null) {
    return {
      ok: false,
      mode: "global",
      reason: "self-update disabled: this binary's channel does not publish to npm (dev channel).",
    };
  }
  // Channel-mismatch guard: if the spec is a concrete version (not a
  // dist-tag like "latest"), refuse to install when its inferred channel
  // does not match this binary's channel. The common trigger is a server
  // server with the wrong `FIRST_TREE_CHANNEL` env — without this guard,
  // a prod CLI would auto-install a `…-staging.X.Y` build and brick its
  // service unit. Fail-closed on "unknown" predicates (`-beta.N`,
  // `-rc.N`, legacy `-alpha.N`) — extending support requires explicitly
  // teaching `inferChannelFromVersion`.
  if (looksLikeVersion(spec)) {
    const targetChannel = inferChannelFromVersion(spec);
    if (targetChannel !== channelConfig.channel) {
      const reason =
        `Refusing to install ${spec}: target channel "${targetChannel}" does not match my channel ` +
        `"${channelConfig.channel}". This usually means the First Tree server is misconfigured ` +
        `(check FIRST_TREE_CHANNEL on the server).`;
      writeInstallOutput(options, `  [update] ${reason}\n`);
      return { ok: false, mode: "global", reason };
    }
  }
  const engineMismatch = checkNpmTargetNodeEngine(spec);
  if (engineMismatch) {
    writeInstallOutput(options, `  [update] ${engineMismatch.reason}\n`);
    return engineMismatch;
  }
  const prefixFailure = guardNpmGlobalPrefix();
  if (prefixFailure) {
    writeInstallOutput(options, `  [update] ${prefixFailure.reason}\n`);
    return prefixFailure;
  }
  const useSystemdRunner = options?.managed === true && process.platform === "linux";
  return new Promise((resolvePromise) => {
    const npm = resolveNpmInvocation(["install", "-g", `${PACKAGE_NAME}@${spec}`]);
    const command = useSystemdRunner ? SYSTEMD_UPDATE_RUNNER : npm.command;
    const args = useSystemdRunner ? systemdUpdateArgs(npm) : npm.args;
    // Route the wrapper through ChildProcessRegistry so it is tracked and
    // reaped by the lifecycle shutdown hook, AND give it a 5-minute hard
    // timeout. In managed Linux mode the wrapper creates a transient unit;
    // that unit stops the daemon, performs the install, rolls back on
    // failure, and starts the daemon only after the package tree is complete.
    // The transient worker therefore survives the supervisor killing this
    // daemon's wrapper during the stop phase.
    let child: ChildProcess;
    try {
      ({ child } = getChildProcessRegistry().spawn(command, args, {
        category: "npm-install",
        label: useSystemdRunner
          ? `systemd-run npm install -g ${PACKAGE_NAME}@${spec}`
          : `npm install -g ${PACKAGE_NAME}@${spec}`,
        timeoutMs: NPM_INSTALL_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
        shell: npm.shell,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const classification = classify(err, { source: "update" });
      const runnerUnavailable = useSystemdRunner && isMissingCommandError(err);
      resolvePromise({
        ok: false,
        mode: "global",
        reason: runnerUnavailable
          ? "Cannot run a managed npm update safely because systemd-run is unavailable; install the portable CLI or update manually."
          : message,
        retryable: runnerUnavailable ? false : classification.kind === ERROR_KINDS.TRANSIENT,
        reasonCode: runnerUnavailable ? "systemd_update_runner_unavailable" : classification.reasonCode,
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      writeInstallOutput(options, chunk.toString("utf8"));
    });

    child.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      const classification = classify(err, { source: "update" });
      const runnerUnavailable = useSystemdRunner && isMissingCommandError(err);
      resolvePromise({
        ok: false,
        mode: "global",
        reason: runnerUnavailable
          ? "Cannot run a managed npm update safely because systemd-run is unavailable; install the portable CLI or update manually."
          : message,
        retryable: runnerUnavailable ? false : classification.kind === ERROR_KINDS.TRANSIENT,
        reasonCode: runnerUnavailable ? "systemd_update_runner_unavailable" : classification.reasonCode,
      });
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        resolvePromise({ ok: true, mode: "global", installedVersion: parseInstalledVersion(stdout) });
        return;
      }
      // Signal-terminated AND no exit code → almost certainly our 5-min
      // timeout escalation. Treat as transient so the next tick retries.
      if (code === null && signal) {
        timedOut = true;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      const reason = `npm install -g ${timedOut ? `killed by signal ${signal} (timeout)` : `exited with code ${code}`}${
        stderr ? `: ${stderr.split("\n").slice(-3).join(" | ")}` : ""
      }`;
      // Classify against the stderr + code so EBADENGINE, EACCES, 404,
      // ENOTFOUND etc. each route to the right retry policy. Fall back to
      // signal-based transient when we killed it for timeout.
      const classification = timedOut
        ? { kind: ERROR_KINDS.TRANSIENT, reasonCode: "npm_timeout" as const }
        : classify(new Error(reason), { source: "update" });
      resolvePromise({
        ok: false,
        mode: "global",
        reason,
        retryable: classification.kind === ERROR_KINDS.TRANSIENT,
        reasonCode: classification.reasonCode,
      });
    });
  });
}

/**
 * Back-compat shim: install `<pkg>@latest`. Used by default `upgrade` fallback
 * before server URL configuration and by the hidden `upgrade --latest`
 * compatibility path; managed update paths prefer `installGlobalSpec` with the
 * server-advertised target version.
 */
export async function installGlobalLatest(options?: InstallGlobalSpecOptions): Promise<ExecuteUpdateResult> {
  return installGlobalSpec("latest", options);
}

/**
 * Look up the server-recommended CLI version from the public bootstrap
 * config endpoint. This is the default manual-upgrade source so operators
 * follow the same rollout target as connected clients.
 */
export async function fetchServerCommandVersion(timeoutMs = 10_000): Promise<VersionLookupResult> {
  let serverUrl: string;
  try {
    serverUrl = resolveServerUrl();
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
      ...(err instanceof ServerUrlNotConfiguredError ? { reasonCode: "server_url_not_configured" as const } : {}),
    };
  }

  let res: Response;
  try {
    res = await cliFetch(`${serverUrl.replace(/\/+$/, "")}/api/v1/bootstrap/config`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  if (!res.ok) {
    return { ok: false, reason: `server returned HTTP ${res.status}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    return { ok: false, reason: `server returned invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (body === null || typeof body !== "object") {
    return { ok: false, reason: "server returned invalid bootstrap config" };
  }

  const version = Reflect.get(body, "serverCommandVersion");
  if (typeof version !== "string" || version.length === 0) {
    return { ok: false, reason: "server did not provide serverCommandVersion" };
  }
  const normalized = semver.valid(version);
  if (!normalized) {
    return { ok: false, reason: `server returned non-semver version: ${version.slice(0, 80)}` };
  }
  return { ok: true, version: normalized };
}

/**
 * Best-effort extraction of the version npm reported as installed. npm's
 * stdout lines look like `+ first-tree@0.9.2`.
 * Returns null if nothing matches — callers treat null as "install succeeded
 * but version unknown".
 */
function parseInstalledVersion(stdout: string): string | null {
  // PACKAGE_NAME === null is unreachable here (installGlobalSpec bails
  // before spawning npm), but defend anyway so this function stays safe
  // to call standalone.
  if (PACKAGE_NAME === null) return null;
  const match = new RegExp(`${escapeForRegex(PACKAGE_NAME)}@(\\S+)`).exec(stdout);
  if (!match?.[1]) return null;
  const cleaned = match[1].replace(/[,\s)]+$/, "");
  return semver.valid(cleaned) ?? cleaned;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Look up the latest published version of the CLI package.
 *
 * Uses `npm view <pkg> version` (rather than fetch'ing registry.npmjs.org
 * directly) so the user's `.npmrc` registry, proxy, and auth settings are
 * honored — important for corporate users routed through Verdaccio /
 * Artifactory mirrors.
 */
export function fetchLatestVersion(timeoutMs = 10_000): VersionLookupResult {
  if (PACKAGE_NAME === null) {
    return { ok: false, reason: "this binary's channel does not publish to npm (dev channel)." };
  }
  const npm = resolveNpmInvocation(["view", PACKAGE_NAME, "version"]);
  const res = spawnSync(npm.command, npm.args, {
    encoding: "utf-8",
    shell: npm.shell,
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.status !== 0) {
    const stderr = (res.stderr ?? "").trim();
    return { ok: false, reason: stderr || `npm view exited with code ${res.status}` };
  }
  const version = (res.stdout ?? "").trim();
  if (!semver.valid(version)) {
    return { ok: false, reason: `npm view returned non-semver value: ${version.slice(0, 80)}` };
  }
  return { ok: true, version };
}
