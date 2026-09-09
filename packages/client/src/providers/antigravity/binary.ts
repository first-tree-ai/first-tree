import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import {
  ANTIGRAVITY_INSTALL_COMMAND,
  runtimeProviderInteractiveLoginCue,
  runtimeProviderLoginCommand,
} from "@first-tree/shared";
import {
  automaticCandidateAllowed,
  getLoginShellPathDirs,
  wellKnownBinDirs,
} from "../../runtime/provider-support/index.js";

export { isAntigravityBinaryMissingError } from "../../runtime/provider-support/index.js";
/** Official install / login copy is owned by the shared provider catalog. */
export { ANTIGRAVITY_INSTALL_COMMAND };
export const ANTIGRAVITY_LOGIN_COMMAND = runtimeProviderLoginCommand("antigravity");

/**
 * Build the documented programmatic headless invocation. Prompt text is sent
 * as a JSON `user` event on stdin rather than argv, which keeps managed
 * briefing/history prompts below the host's exec-argument limit.
 */
export function buildAntigravityTurnArgs(input: {
  model: string;
  reasoningEffort: string;
  resumeSessionId: string | null;
  turnTimeoutMs: number;
}): string[] {
  const timeoutMinutes = Math.max(1, Math.ceil(input.turnTimeoutMs / 60_000));
  const args = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--print-timeout",
    `${timeoutMinutes}m`,
  ];
  if (input.model) args.push("--model", input.model);
  if (input.reasoningEffort) args.push("--effort", input.reasoningEffort);
  if (input.resumeSessionId) args.push("--conversation", input.resumeSessionId);
  return args;
}

export function formatAntigravityBinaryMissingMessage(input: unknown): string {
  const original = errorText(input).trim();
  const suffix = original ? ` Original error: ${original}` : "";
  return (
    "Antigravity CLI is missing on this machine. " +
    "First Tree does not bundle or install the Google Antigravity runtime and never reads its credential store. " +
    `Install it with the official installer (\`${ANTIGRAVITY_INSTALL_COMMAND}\`), then ${runtimeProviderInteractiveLoginCue("antigravity")} and retry.` +
    suffix
  );
}

export type FindAntigravityExecutableDeps = {
  loginShellPathDirs?: () => string[];
  wellKnownDirs?: () => string[];
  platform?: NodeJS.Platform;
  pathDelimiter?: string;
};

/**
 * Existence-only resolver shared by capability detection and the handler.
 * The installer places Unix binaries in `~/.local/bin` and Windows binaries
 * in the per-user `agy/bin` directory; PATH and login-shell PATH remain first
 * class so daemon launches observe the operator's installation.
 */
export function findAntigravityExecutableOnPath(
  env: Record<string, string | undefined> = process.env,
  deps: FindAntigravityExecutableDeps = {},
): string | null {
  const platform = deps.platform ?? process.platform;
  const pathDelimiter = deps.pathDelimiter ?? (platform === "win32" ? ";" : delimiter);
  const loginShellPathDirs = deps.loginShellPathDirs ?? getLoginShellPathDirs;
  const configuredHome = env.HOME || env.USERPROFILE;
  const home = configuredHome && configuredHome.length > 0 ? configuredHome : homedir();
  const knownDirs = deps.wellKnownDirs ?? (() => wellKnownBinDirs(home));
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const pathDirs = pathValue ? pathValue.split(pathDelimiter) : [];
  const installDirs = [
    join(home, ".local", "bin"),
    join(home, ".gemini", "antigravity-cli", "bin"),
    ...(platform === "win32"
      ? [
          ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, "agy", "bin")] : []),
          join(home, "AppData", "Local", "agy", "bin"),
        ]
      : []),
  ];
  const names = platform === "win32" ? ["agy.exe", "agy"] : ["agy"];
  const seen = new Set<string>();

  const search = (dirs: readonly string[]): string | null => {
    for (const dir of dirs) {
      if (!dir) continue;
      const base = isAbsolute(dir) ? dir : resolve(dir);
      for (const name of names) {
        const candidate = join(base, name);
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        if (isExecutableFile(candidate, platform)) return candidate;
      }
    }
    return null;
  };

  return search(pathDirs) ?? search(installDirs) ?? search(knownDirs()) ?? search(loginShellPathDirs());
}

export type AntigravityRuntimeBinaryResolution =
  | { ok: true; binary: string }
  | { ok: false; error: string; transient: false };

export type AntigravityRuntimeResolveDeps = {
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
};

/** Resolve only; the provider process supervisor owns every actual spawn. */
export function resolveAntigravityRuntimeBinary(
  env: NodeJS.ProcessEnv = process.env,
  deps: AntigravityRuntimeResolveDeps = {},
): AntigravityRuntimeBinaryResolution {
  const findOnPath = deps.findOnPath ?? findAntigravityExecutableOnPath;
  const binary = findOnPath(env);
  if (!binary) {
    return {
      ok: false,
      error: formatAntigravityBinaryMissingMessage("no agy binary resolved on this host"),
      transient: false,
    };
  }
  return { ok: true, binary };
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
