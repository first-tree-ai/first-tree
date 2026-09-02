import {
  type CapabilityEntry,
  isRuntimeProviderEnabled,
  RUNTIME_PROVIDER_IDS,
  type RuntimeProvider,
} from "@first-tree/shared";
import { probeAmpCapability } from "./amp/capability.js";
import { probeAntigravityCapability } from "./antigravity/capability.js";
import { probeClaudeCodeCapability } from "./claude/capability.js";
import { probeClaudeCodeTuiCapability } from "./claude/capability-tui.js";
import { probeCodexCapability } from "./codex/capability.js";
import { probeCursorCapability } from "./cursor/capability.js";
import { probeDeepseekCapability } from "./deepseek-harness/capability.js";
import { probeGrokCapability } from "./grok/capability.js";
import { probeKimiCodeCapability } from "./kimi-code/capability.js";
import { probeOpenCodeCapability } from "./opencode/capability.js";
import { probePiCapability } from "./pi/capability.js";

export type CapabilityProbe = () => Promise<CapabilityEntry>;

export type BuiltinProviderProbeTable = Readonly<Record<RuntimeProvider, CapabilityProbe>>;

function executableNames(name: string, platform: NodeJS.Platform, pathExt: string | undefined): string[] {
  if (platform !== "win32") return [name];
  const extensions = (pathExt ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return [name, ...extensions.map((extension) => `${name}${extension}`)];
}

/** Resolve an optional external tool without launching it or reading credentials. */
export function probeExternalTool(
  name: string,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; now?: () => Date } = {},
): CapabilityEntry {
  const startedAt = Date.now();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  try {
    for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
      for (const candidateName of executableNames(name, platform, env.PATHEXT)) {
        const candidate = join(directory, candidateName);
        try {
          accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
          return {
            state: "ok",
            available: true,
            runtimeSource: "path",
            runtimePath: candidate,
            detectedAt: (options.now?.() ?? new Date()).toISOString(),
            latencyMs: Date.now() - startedAt,
          };
        } catch {
          // Continue searching PATH.
        }
      }
    }
    return {
      state: "missing",
      available: false,
      error: `${name} was not found on PATH`,
      detectedAt: (options.now?.() ?? new Date()).toISOString(),
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "error",
      available: false,
      error: error instanceof Error ? error.message : String(error),
      detectedAt: (options.now?.() ?? new Date()).toISOString(),
      latencyMs: Date.now() - startedAt,
    };
  }
}

/**
 * Frozen install-probe table for built-in providers.
 *
 * Composition-owned projection of the exhaustive provider set. Capability
 * aggregation reads this table directly (or an explicit `{ probes }` inject)
 * so the probe path does not pull handler/SDK imports.
 */
export const BUILTIN_PROVIDER_PROBES: BuiltinProviderProbeTable = Object.freeze({
  amp: probeAmpCapability,
  "deepseek-harness": probeDeepseekCapability,
  "claude-code": probeClaudeCodeCapability,
  "claude-code-tui": probeClaudeCodeTuiCapability,
  codex: probeCodexCapability,
  cursor: probeCursorCapability,
  grok: probeGrokCapability,
  antigravity: probeAntigravityCapability,
  "kimi-code": probeKimiCodeCapability,
  opencode: probeOpenCodeCapability,
  pi: probePiCapability,
} satisfies Record<RuntimeProvider, CapabilityProbe>);

/** Enabled providers that have a built-in probe (drives daemon re-probe loops). */
export function probedRuntimeProviders(): RuntimeProvider[] {
  return RUNTIME_PROVIDER_IDS.filter((id) => isRuntimeProviderEnabled(id));
}

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
