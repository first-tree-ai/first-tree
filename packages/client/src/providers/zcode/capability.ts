import type { CapabilityEntry } from "@first-tree/shared";
import { supportsDefaultProviderProcessSupervision } from "../../runtime/provider-support/index.js";
import { type DetectOutcome, runDetect } from "../capabilities/detect.js";
import { findZcodeExecutableOnPath, formatZcodeBinaryMissingMessage } from "./binary.js";

export type ZcodeProbeDeps = {
  findOnPath?: (env?: Record<string, string | undefined>) => string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

/**
 * Resolve-only capability probe. Authentication is provider-owned and is not
 * inferred by reading credentials; an unsupported process platform is reported
 * as an explicit error even when the binary exists.
 */
export async function probeZcodeCapability(deps: ZcodeProbeDeps = {}): Promise<CapabilityEntry> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const findOnPath = deps.findOnPath ?? findZcodeExecutableOnPath;

  if (!supportsDefaultProviderProcessSupervision(platform)) {
    return {
      state: "error",
      available: false,
      runtimeSource: "path",
      latencyMs: 0,
      detectedAt: new Date().toISOString(),
      error:
        "First Tree cannot supervise ZCode on Windows until the client-wide pre-admission " +
        "Job Object supervisor is available.",
    };
  }
  return runDetect(async (): Promise<DetectOutcome> => {
    const runtimePath = findOnPath(env);
    if (runtimePath) return { installed: true, runtimeSource: "path", runtimePath };
    return {
      installed: false,
      error: formatZcodeBinaryMissingMessage("no zcode binary resolved on this host"),
    };
  });
}
