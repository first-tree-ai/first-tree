import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ZCODE_MINIMUM_NODE_VERSION,
  ZCODE_OFFICIAL_PLATFORM,
  ZCODE_OFFICIAL_RUNTIME_VERSION,
} from "@first-tree/shared";
import { ensureOfficialZcodeRuntime, type OfficialZcodeRuntimeResolution } from "./official-runtime.js";

export { ZCODE_MINIMUM_NODE_VERSION, ZCODE_OFFICIAL_PLATFORM, ZCODE_OFFICIAL_RUNTIME_VERSION };

const execFileAsync = promisify(execFile);

export type ZcodeRuntimeBinaryResolution = OfficialZcodeRuntimeResolution;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missingRuntimeError(input: unknown): Extract<OfficialZcodeRuntimeResolution, { ok: false }> {
  const original = describeError(input).trim();
  const suffix = original ? ` Original error: ${original}` : "";
  return {
    ok: false,
    transient: false,
    error: `ZCode official runtime is not ready. First Tree extracts and verifies it automatically on ${ZCODE_OFFICIAL_PLATFORM}.${suffix}`,
  };
}

export type ZcodeVersionInspection =
  | { ok: true; runtimeVersion: string }
  | { ok: false; error: string; transient: false };

export function inspectZcodeVersion(output: string): ZcodeVersionInspection {
  const rows = output
    .trim()
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);
  const version = rows[0];
  if (rows.length === 1 && version === ZCODE_OFFICIAL_RUNTIME_VERSION) {
    return { ok: true, runtimeVersion: version };
  }
  return {
    ok: false,
    transient: false,
    error: `incompatible ZCode runtime version: expected exactly ${ZCODE_OFFICIAL_RUNTIME_VERSION}`,
  };
}

export type ResolveZcodeRuntimeBinaryDeps = {
  arch?: string;
  cacheRoot?: string;
  ensureRuntime?: typeof ensureOfficialZcodeRuntime;
  fetchImpl?: typeof fetch;
  nodeVersion?: () => string;
  platform?: NodeJS.Platform;
  readVersion?: (command: string, args: readonly string[]) => Promise<string>;
  runTar?: (args: readonly string[], cwd: string) => Promise<void>;
};

async function readZcodeVersion(command: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, [...args, "--version"], {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    shell: false,
  });
  return stdout;
}

export async function resolveZcodeRuntimeBinary(
  _env: NodeJS.ProcessEnv = process.env,
  deps: ResolveZcodeRuntimeBinaryDeps = {},
): Promise<OfficialZcodeRuntimeResolution> {
  const resolution = await (deps.ensureRuntime ?? ensureOfficialZcodeRuntime)({
    arch: deps.arch,
    cacheRoot: deps.cacheRoot,
    fetchImpl: deps.fetchImpl,
    platform: deps.platform,
    runTar: deps.runTar,
  });
  if (!resolution.ok) return resolution;

  const node = (deps.nodeVersion ?? (() => process.versions.node))();
  if (compareSemanticVersions(node, ZCODE_MINIMUM_NODE_VERSION) < 0) {
    return missingRuntimeError(`Node.js ${ZCODE_MINIMUM_NODE_VERSION}+ is required; this host is running ${node}`);
  }

  try {
    const inspection = inspectZcodeVersion(
      await (deps.readVersion ?? readZcodeVersion)(resolution.command, resolution.args),
    );
    return inspection.ok ? resolution : missingRuntimeError(inspection.error);
  } catch (error) {
    return missingRuntimeError(`the managed runtime did not answer --version: ${describeError(error)}`);
  }
}

function compareSemanticVersions(left: string, right: string): number {
  const parse = (value: string): [number, number, number] => {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
    if (!match) throw new Error(`invalid semantic version: ${value}`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const [leftMajor, leftMinor, leftPatch] = parse(left);
  const [rightMajor, rightMinor, rightPatch] = parse(right);
  return leftMajor - rightMajor || leftMinor - rightMinor || leftPatch - rightPatch;
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
