import type { RuntimeProvider } from "@first-tree/shared";
import type { HandlerFactory } from "../runtime/contracts.js";
import { createAmpHandler } from "./amp/index.js";
import { createAntigravityHandler } from "./antigravity/index.js";
import { type ClaudeExecutableResolution, resolveClaudeCodeExecutable } from "./claude/executable.js";
import { createClaudeCodeHandler } from "./claude/index.js";
import { createClaudeCodeTuiHandler } from "./claude/tui/index.js";
import { createCodexHandler } from "./codex/index.js";
import { createCursorHandler } from "./cursor/index.js";
import { createDeepseekHandler } from "./deepseek-harness/index.js";
import { createGrokHandler } from "./grok/index.js";
import { createKimiCodeHandler } from "./kimi-code/index.js";
import { createOpenCodeHandler } from "./opencode/index.js";
import { createPiHandler } from "./pi/index.js";

/** Narrow log seam — composition supplies cloud createLogger; providers never import it. */
export type BuiltinRegistryLog = {
  info: (message: string) => void;
};

/** Injectable seam for Claude executable resolution in tests. */
export type BuiltinHandlerRegistryDeps = {
  resolveExecutable?: () => ClaudeExecutableResolution;
};

/**
 * Built-in handler factory map — composition-owned, runtime-frozen, exhaustive.
 *
 * Probe and skill-root projections live in sibling modules
 * (`BUILTIN_PROVIDER_PROBES`, `PROVIDER_SKILL_ROOTS`); this registry only owns
 * handler factories so generic probe/skills paths do not import heavy SDKs.
 */
export type BuiltinHandlerRegistry = Readonly<Record<RuntimeProvider, HandlerFactory>>;

/**
 * Build a frozen, exhaustive built-in handler factory table.
 *
 * The CLI composition root (`ClientRuntime`) creates this once and holds it as
 * an instance value. Standalone runtimes receive an explicit map — never
 * installed into process-global state.
 */
export function createBuiltinHandlerRegistry(deps: BuiltinHandlerRegistryDeps = {}): BuiltinHandlerRegistry {
  const resolution = (deps.resolveExecutable ?? (() => resolveClaudeCodeExecutable({ includeLoginShell: false })))();

  return Object.freeze({
    amp: (config) => createAmpHandler(config),
    "deepseek-harness": (config) => createDeepseekHandler(config),
    "claude-code": (config) => createClaudeCodeHandler({ ...config, claudeCodeExecutable: resolution.path }),
    "claude-code-tui": (config) => createClaudeCodeTuiHandler({ ...config, claudeCodeExecutable: resolution.path }),
    codex: (config) => createCodexHandler(config),
    cursor: (config) => createCursorHandler(config),
    grok: (config) => createGrokHandler(config),
    antigravity: (config) => createAntigravityHandler(config),
    "kimi-code": (config) => createKimiCodeHandler(config),
    opencode: (config) => createOpenCodeHandler(config),
    pi: (config) => createPiHandler(config),
  } satisfies Record<RuntimeProvider, HandlerFactory>);
}

/** Log Claude executable resolution (cheap PATH / well-known dirs only). */
export function logClaudeExecutableResolution(resolution: ClaudeExecutableResolution, log: BuiltinRegistryLog): void {
  if (resolution.path) {
    log.info(`Claude Code executable: ${resolution.path} (source=${resolution.source})`);
  } else {
    log.info(
      "Claude Code executable: using SDK bundled native binary (set CLAUDE_CODE_EXECUTABLE or install `claude` on PATH to override)",
    );
  }
}

/** Resolve + log Claude executable using the same deps seam as registry creation. */
export function resolveAndLogClaudeExecutable(
  deps: BuiltinHandlerRegistryDeps & { log: BuiltinRegistryLog },
): ClaudeExecutableResolution {
  const resolution = (deps.resolveExecutable ?? (() => resolveClaudeCodeExecutable({ includeLoginShell: false })))();
  logClaudeExecutableResolution(resolution, deps.log);
  return resolution;
}
