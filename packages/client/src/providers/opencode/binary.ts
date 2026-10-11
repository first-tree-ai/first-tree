import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import {
  OPENCODE_MINIMUM_VERSION,
  runtimeProviderInstallCommand,
  runtimeProviderLoginCommand,
} from "@first-tree/shared";
import { prerelease, satisfies, valid } from "semver";
import {
  automaticCandidateAllowed,
  getLoginShellPathDirs,
  wellKnownBinDirs,
} from "../../runtime/provider-support/index.js";

/** Lowest compatible CLI — shared with catalog npm package metadata. */
export { OPENCODE_MINIMUM_VERSION };
/** Supported range spans 1.18.7 through the entire 2.x line (excludes 3.0.0+). */
export const OPENCODE_SUPPORTED_VERSION_RANGE = `>=${OPENCODE_MINIMUM_VERSION} <3.0.0`;
/** Host-local OpenCode installation surfaced in setup and error copy. */
export const OPENCODE_INSTALL_COMMAND = runtimeProviderInstallCommand("opencode");
export const OPENCODE_LOGIN_COMMAND = runtimeProviderLoginCommand("opencode");

export function formatOpenCodeBinaryMissingMessage(input: unknown): string {
  const original = errorText(input).trim();
  const suffix = original ? ` Original error: ${original}` : "";
  return (
    "OpenCode CLI is missing on this machine. " +
    "First Tree does not bundle or install OpenCode and never reads its provider credentials. " +
    `Install it with \`${OPENCODE_INSTALL_COMMAND}\`, then complete provider-owned setup with ` +
    `\`${OPENCODE_LOGIN_COMMAND}\` and retry.` +
    suffix
  );
}

export function isOpenCodeBinaryMissingError(input: unknown): boolean {
  const text = errorText(input);
  return /opencode cli is missing|opencode.*not (?:found|installed)/i.test(text);
}

export type FindOpenCodeExecutableDeps = {
  loginShellPathDirs?: () => string[];
  wellKnownDirs?: () => string[];
  platform?: NodeJS.Platform;
  pathDelimiter?: string;
};

/** Existence-only resolver shared by capability detection and the handler. */
export function findOpenCodeExecutableOnPath(
  env: Record<string, string | undefined> = process.env,
  deps: FindOpenCodeExecutableDeps = {},
): string | null {
  const platform = deps.platform ?? process.platform;
  const pathDelimiter = deps.pathDelimiter ?? (platform === "win32" ? ";" : delimiter);
  const loginShellPathDirs = deps.loginShellPathDirs ?? getLoginShellPathDirs;
  const configuredHome = env.HOME || env.USERPROFILE;
  const home = configuredHome && configuredHome.length > 0 ? configuredHome : homedir();
  const wellKnownDirs = deps.wellKnownDirs ?? (() => wellKnownBinDirs(home));
  const seen = new Set<string>();

  const search = (dirs: readonly string[]): string | null => {
    for (const dir of dirs) {
      if (!dir) continue;
      const base = isAbsolute(dir) ? dir : resolve(dir);
      if (seen.has(base)) continue;
      seen.add(base);
      for (const candidate of openCodeExecutableCandidates(base, platform)) {
        if (isExecutableFile(candidate, platform)) return candidate;
      }
    }
    return null;
  };

  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const pathDirs = pathValue ? pathValue.split(pathDelimiter) : [];
  const providerInstallDirs = [
    join(home, ".opencode", "bin"),
    ...(platform === "win32"
      ? [...(env.APPDATA ? [join(env.APPDATA, "npm")] : []), join(home, "AppData", "Roaming", "npm")]
      : []),
  ];
  return search(pathDirs) ?? search(providerInstallDirs) ?? search(wellKnownDirs()) ?? search(loginShellPathDirs());
}

export type OpenCodeRuntimeBinaryResolution =
  | { ok: true; binary: string }
  | { ok: false; error: string; transient: false };

export type OpenCodeRuntimeResolveDeps = {
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
};

/**
 * Resolve only. Every OpenCode invocation, including the compatible-version gate,
 * is launched later through the provider process supervisor so Windows never
 * executes an unadmitted runtime process.
 */
export function resolveOpenCodeRuntimeBinary(
  env: NodeJS.ProcessEnv = process.env,
  deps: OpenCodeRuntimeResolveDeps = {},
): OpenCodeRuntimeBinaryResolution {
  const findOnPath = deps.findOnPath ?? findOpenCodeExecutableOnPath;
  const binary = findOnPath(env);
  if (!binary) {
    return {
      ok: false,
      error: formatOpenCodeBinaryMissingMessage("no opencode binary resolved"),
      transient: false,
    };
  }
  return { ok: true, binary };
}

/**
 * npm exposes global Windows CLIs through `.cmd` shims, which cannot be
 * launched with `shell: false` and cannot be pre-admitted as the OpenCode root
 * process. Resolve the package's native executable beside the shim instead.
 */
function openCodeExecutableCandidates(base: string, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [join(base, "opencode")];
  const candidates = [join(base, "opencode.exe"), join(base, "node_modules", "opencode-ai", "bin", "opencode.exe")];
  if (basename(base).toLowerCase() === ".bin") {
    candidates.push(join(dirname(base), "opencode-ai", "bin", "opencode.exe"));
  }
  return candidates;
}

export function parseOpenCodeVersionOutput(output: string): string | null {
  for (const token of whitespaceTokens(output)) {
    if (token.length > 64) continue;
    // OpenCode prints `v2.0.26` (leading `v`); semver's `valid` rejects that,
    // so strip a single leading `v` before validation.
    const candidate = token.startsWith("v") && token.length > 1 ? token.slice(1) : token;
    const normalized = valid(candidate);
    if (!normalized || normalized !== candidate || prerelease(normalized) !== null) continue;
    return normalized;
  }
  return null;
}

export function isSupportedOpenCodeVersion(version: string | null): boolean {
  if (!version || valid(version) !== version || prerelease(version) !== null) return false;
  return satisfies(version, OPENCODE_SUPPORTED_VERSION_RANGE, { includePrerelease: false });
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
