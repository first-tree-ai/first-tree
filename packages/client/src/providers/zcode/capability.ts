import type { CapabilityEntry } from "@first-tree/shared";
import { supportsDefaultProviderProcessSupervision } from "../../runtime/provider-support/index.js";
import { type DetectOutcome, runDetect } from "../capabilities/detect.js";
import { type ResolveZcodeRuntimeBinaryDeps, resolveZcodeRuntimeBinary } from "./binary.js";

export type ZcodeProbeDeps = {
  env?: NodeJS.ProcessEnv;
  resolutionDeps?: Omit<ResolveZcodeRuntimeBinaryDeps, "platform">;
  platform?: NodeJS.Platform;
};

/**
 * Resolve-only capability probe. Authentication is provider-owned and is not
 * inferred by reading credentials; an unsupported process platform is reported
 * as an explicit error even when the binary exists.
 */
export async function probeZcodeCapability(deps: ZcodeProbeDeps = {}): Promise<CapabilityEntry> {
  const env = deps.env ?? process.env;
  if (!supportsDefaultProviderProcessSupervision(deps.platform ?? process.platform)) {
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
  const detected = await runDetect(async (): Promise<DetectOutcome> => {
    const resolution = await resolveZcodeRuntimeBinary(env, {
      ...deps.resolutionDeps,
      platform: deps.platform ?? process.platform,
    });
    if (resolution.ok) return { installed: true, runtimeSource: "path", runtimePath: resolution.runtimePath };
    return { installed: false, error: resolution.error };
  });
  return detected;
}
