import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { runtimeProviderLoginCommand, ZCODE_INSTALL_COMMAND } from "@first-tree/shared";
import {
  automaticCandidateAllowed,
  getLoginShellPathDirs,
  wellKnownBinDirs,
} from "../../runtime/provider-support/index.js";

export { ZCODE_INSTALL_COMMAND };
export const ZCODE_LOGIN_COMMAND = runtimeProviderLoginCommand("zcode");

export function formatZcodeBinaryMissingMessage(input: unknown): string {
  const original = errorText(input).trim();
  const suffix = original ? ` Original error: ${original}` : "";
  return (
    "ZCode CLI is missing on this machine. " +
    "First Tree does not bundle or install ZCode and never reads its credential store. " +
    `Install it with \`${ZCODE_INSTALL_COMMAND}\`, then complete provider-owned setup with ` +
    `\`${ZCODE_LOGIN_COMMAND}\` and retry.` +
    suffix
  );
}

export function isZcodeBinaryMissingError(input: unknown): boolean {
  const text = errorText(input);
  return /zcode cli is missing|zcode.*not (?:found|installed)|no zcode binary/i.test(text);
}

export type FindZcodeExecutableDeps = {
  loginShellPathDirs?: () => string[];
  wellKnownDirs?: () => string[];
  platform?: NodeJS.Platform;
  pathDelimiter?: string;
};

/** Existence-only resolver shared by capability detection and the handler. */
export function findZcodeExecutableOnPath(
  env: Record<string, string | undefined> = process.env,
  deps: FindZcodeExecutableDeps = {},
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
      for (const candidate of zcodeExecutableCandidates(base, platform)) {
        if (isExecutableFile(candidate, platform)) return candidate;
      }
    }
    return null;
  };

  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const pathDirs = pathValue ? pathValue.split(pathDelimiter) : [];
  const providerInstallDirs = [
    join(home, ".local", "bin"),
    join(home, ".zcode", "bin"),
    join(home, ".zcode", "runtime", "current", "bin"),
    ...(platform === "win32"
      ? [
          ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, "zcode", "bin")] : []),
          join(home, "AppData", "Local", "zcode", "bin"),
        ]
      : []),
  ];
  return search(pathDirs) ?? search(providerInstallDirs) ?? search(wellKnownDirs()) ?? search(loginShellPathDirs());
}

export type ZcodeRuntimeBinaryResolution =
  | { ok: true; binary: string }
  | { ok: false; error: string; transient: false };

export type ZcodeRuntimeResolveDeps = {
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
};

/**
 * Resolve only. Every ZCode invocation is launched later through the provider
 * process supervisor so Windows never executes an unadmitted runtime process.
 */
export function resolveZcodeRuntimeBinary(
  env: NodeJS.ProcessEnv = process.env,
  deps: ZcodeRuntimeResolveDeps = {},
): ZcodeRuntimeBinaryResolution {
  const findOnPath = deps.findOnPath ?? findZcodeExecutableOnPath;
  const binary = findOnPath(env);
  if (!binary) {
    return {
      ok: false,
      error: formatZcodeBinaryMissingMessage("no zcode binary resolved on this host"),
      transient: false,
    };
  }
  return { ok: true, binary };
}

function zcodeExecutableCandidates(base: string, platform: NodeJS.Platform): string[] {
  return platform === "win32" ? [join(base, "zcode.exe"), join(base, "zcode")] : [join(base, "zcode")];
}

function isExecutableFile(filePath: string, platform: NodeJS.Platform): boolean {
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

export type ZcodeTurnArgsInput = {
  workspace: string;
  prompt: string;
  mode: "build" | "edit" | "plan";
  resumeSessionId: string | null;
};

/**
 * Canonical machine turn. Prompt text rides as one argv value through
 * `spawn(..., { shell: false })`; never through a shell or config file.
 */
export function buildZcodeTurnArgs(input: ZcodeTurnArgsInput): string[] {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("ZCode turn prompt is empty");
  const args = ["--json", "--no-color", "--mode", input.mode, "--cwd", input.workspace, "--prompt", prompt];
  if (input.resumeSessionId) args.push("--resume", input.resumeSessionId);
  return args;
}
