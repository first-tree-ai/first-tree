import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import {
  runtimeProviderInstallCommand,
  runtimeProviderInteractiveLoginCue,
  runtimeProviderLoginCommand,
} from "@first-tree/shared";
import { prerelease, satisfies, valid } from "semver";
import {
  automaticCandidateAllowed,
  getLoginShellPathDirs,
  wellKnownBinDirs,
} from "../../runtime/provider-support/index.js";

/** Lowest published compatible CLI validated by the runtime contract. */
export const PI_MINIMUM_VERSION = "0.80.5";
/**
 * Compatible CLI range. There is no upper bound: the RPC spawn contract
 * (`--mode rpc` and the V1 native tool set) is stable across Pi's 0.x and 1.x
 * lines, so any stable release at or above {@link PI_MINIMUM_VERSION} is
 * accepted. Prerelease and unparseable `--version` output still fail closed
 * via {@link isSupportedPiVersion}.
 */
export const PI_SUPPORTED_VERSION_RANGE = ">=0.80.5";
/** Official install / login — shared catalog (compatible re-exports). */
export const PI_INSTALL_COMMAND = runtimeProviderInstallCommand("pi");
export const PI_LOGIN_COMMAND = runtimeProviderLoginCommand("pi");

export function formatPiBinaryMissingMessage(input: unknown): string {
  const original = errorText(input).trim();
  const suffix = original ? ` Original error: ${original}` : "";
  return (
    "Pi CLI is missing on this machine. " +
    "First Tree does not bundle or install Pi and never reads its provider authentication state. " +
    `Install it with \`${PI_INSTALL_COMMAND}\`, then complete provider-owned setup — ` +
    `${runtimeProviderInteractiveLoginCue("pi")}, then retry.` +
    suffix
  );
}

/** Single-owner match rules live in provider-support; re-export for call sites. */
export { isPiBinaryMissingError } from "../../runtime/provider-support/index.js";

export type FindPiExecutableDeps = {
  loginShellPathDirs?: () => string[];
  wellKnownDirs?: () => string[];
  platform?: NodeJS.Platform;
  pathDelimiter?: string;
};

/** Existence-only resolver shared by capability detection and the handler. */
export function findPiExecutableOnPath(
  env: Record<string, string | undefined> = process.env,
  deps: FindPiExecutableDeps = {},
): string | null {
  const platform = deps.platform ?? process.platform;
  const pathDelimiter = deps.pathDelimiter ?? (platform === "win32" ? ";" : delimiter);
  const loginShellPathDirs = deps.loginShellPathDirs ?? getLoginShellPathDirs;
  const configuredHome = env.HOME || env.USERPROFILE;
  const home = configuredHome && configuredHome.length > 0 ? configuredHome : homedir();
  const wellKnownDirs =
    deps.wellKnownDirs ?? (() => [...piProviderInstallDirs(home, platform, env), ...wellKnownBinDirs(home)]);
  const seen = new Set<string>();

  const search = (dirs: readonly string[]): string | null => {
    for (const dir of dirs) {
      if (!dir) continue;
      const base = isAbsolute(dir) ? dir : resolve(dir);
      if (seen.has(base)) continue;
      seen.add(base);
      for (const candidate of piExecutableCandidates(base, platform)) {
        if (isExecutableFile(candidate, platform)) return candidate;
      }
    }
    return null;
  };

  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const pathDirs = pathValue ? pathValue.split(pathDelimiter) : [];
  return search(pathDirs) ?? search(wellKnownDirs()) ?? search(loginShellPathDirs());
}

export type PiRuntimeBinaryResolution = { ok: true; binary: string } | { ok: false; error: string; transient: false };

export type PiRuntimeResolveDeps = {
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
};

/**
 * Resolve only. Every Pi invocation, including the compatible-version gate,
 * is launched later through the provider process supervisor so Windows never
 * executes an unadmitted runtime process.
 */
export function resolvePiRuntimeBinary(
  env: NodeJS.ProcessEnv = process.env,
  deps: PiRuntimeResolveDeps = {},
): PiRuntimeBinaryResolution {
  const findOnPath = deps.findOnPath ?? findPiExecutableOnPath;
  const binary = findOnPath(env);
  if (!binary) {
    return {
      ok: false,
      error: formatPiBinaryMissingMessage("no pi binary resolved"),
      transient: false,
    };
  }
  return { ok: true, binary };
}

function piProviderInstallDirs(
  home: string,
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string[] {
  const dirs = [join(home, ".local", "bin")];
  if (platform === "win32") {
    const appData = env.APPDATA;
    if (appData) dirs.push(join(appData, "npm"));
    dirs.push(join(home, "AppData", "Roaming", "npm"));
  }
  return dirs;
}

/**
 * npm exposes global Windows CLIs through `.cmd` shims, which cannot be
 * launched with `shell: false`. Resolve the package's native executable beside
 * the shim instead.
 */
function piExecutableCandidates(base: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [join(base, "pi")];
  const candidates = [
    join(base, "pi.exe"),
    join(base, "node_modules", "@earendil-works", "pi-coding-agent", "bin", "pi.exe"),
  ];
  if (basename(base).toLowerCase() === ".bin") {
    candidates.push(join(dirname(base), "@earendil-works", "pi-coding-agent", "bin", "pi.exe"));
  }
  return candidates;
}

export function parsePiVersionOutput(output: string): string | null {
  for (const token of whitespaceTokens(output)) {
    if (token.length > 64) continue;
    const normalized = valid(token);
    if (!normalized || normalized !== token || prerelease(normalized) !== null) continue;
    return normalized;
  }
  return null;
}

export function isSupportedPiVersion(version: string | null): boolean {
  if (!version || valid(version) !== version || prerelease(version) !== null) return false;
  return satisfies(version, PI_SUPPORTED_VERSION_RANGE, { includePrerelease: false });
}

function whitespaceTokens(value: string): string[] {
  const tokens: string[] = [];
  let start = -1;
  for (let index = 0; index <= value.length; index++) {
    const code = index < value.length ? value.charCodeAt(index) : 32;
    const whitespace = code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32;
    if (!whitespace && start < 0) {
      start = index;
    } else if (whitespace && start >= 0) {
      tokens.push(value.slice(start, index));
      start = -1;
    }
  }
  return tokens;
}

function isExecutableFile(filePath: string, platform: NodeJS.Platform): boolean {
  // Every automatic source funnels through here, so this is the one place a
  // candidate can be vetted before `stat` / `access` follows it into a
  // TCC-protected folder. See `automaticCandidateAllowed`.
  if (!automaticCandidateAllowed(filePath)) return false;
  try {
    if (!statSync(filePath).isFile()) return false;
    accessSync(filePath, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function errorText(input: unknown): string {
  if (input instanceof Error) return `${input.name} ${input.message}`;
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && "message" in input) {
    const message = (input as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(input);
}
