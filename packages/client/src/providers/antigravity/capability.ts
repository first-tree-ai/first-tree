import type { CapabilityEntry } from "@first-tree/shared";
import { supportsDefaultProviderProcessSupervision } from "../../runtime/provider-support/index.js";
import { type DetectOutcome, runDetect } from "../capabilities/detect.js";
import { findAntigravityExecutableOnPath, formatAntigravityBinaryMissingMessage } from "./binary.js";

export type AntigravityProbeDeps = {
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

/**
 * Install-only probe. It never launches `agy`, opens browser auth, or reads
 * the Antigravity keyring. Windows remains fail-closed until a Job Object
 * process supervisor is available to the client runtime.
 */
export async function probeAntigravityCapability(deps: AntigravityProbeDeps = {}): Promise<CapabilityEntry> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const findOnPath = deps.findOnPath ?? findAntigravityExecutableOnPath;

  return runDetect(async (): Promise<DetectOutcome> => {
    if (!supportsDefaultProviderProcessSupervision(platform)) {
      throw new Error(
        "Antigravity is not supported on Windows in v1 until the client-wide pre-admission " +
          "Job Object supervisor is available. First Tree fails closed on this platform " +
          "and will not spawn `agy` here.",
      );
    }
    const runtimePath = findOnPath(env);
    if (runtimePath) return { installed: true, runtimeSource: "path", runtimePath };
    return {
      installed: false,
      error: formatAntigravityBinaryMissingMessage("no agy binary resolved on this host"),
    };
  });
}
