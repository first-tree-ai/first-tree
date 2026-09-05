import { applyClientLoggerConfig, createLogger } from "@first-tree/client";
import type { Command } from "commander";
import {
  type LegacyGithubScanLaunchdRetirementResult,
  runLegacyGithubScanLaunchdRetirementOnce,
} from "../core/legacy-github-scan-launchd-retirement.js";
import { setJsonMode } from "../core/output.js";

type CliRuntimeLogger = {
  info: (context: Record<string, unknown>, message: string) => void;
  error: (context: Record<string, unknown>, message: string) => void;
};

export type CliRuntimeDependencies = {
  env: NodeJS.ProcessEnv;
  setJsonMode: typeof setJsonMode;
  applyClientLoggerConfig: typeof applyClientLoggerConfig;
  createLogger: (module: string) => CliRuntimeLogger;
  runLegacyGithubScanLaunchdRetirementOnce: () => LegacyGithubScanLaunchdRetirementResult;
};

const productionDependencies: CliRuntimeDependencies = {
  env: process.env,
  setJsonMode,
  applyClientLoggerConfig,
  createLogger,
  runLegacyGithubScanLaunchdRetirementOnce,
};

/**
 * Configure process-wide CLI output and one-time machine migrations.
 *
 * Keep this hook synchronous: the shipped entrypoint calls `program.parse()`,
 * and the launchd retirement must finish (or return a bounded partial result)
 * before the selected action starts.
 */
export function configureCliRuntime(
  program: Command,
  dependencies: CliRuntimeDependencies = productionDependencies,
): void {
  program
    .option("--json", "emit only machine-readable JSON on stdout; silence human status lines on stderr")
    .option("--verbose", "raise log level to debug (overrides FIRST_TREE_LOG_LEVEL)")
    .hook("preAction", (thisCommand, actionCommand) => {
      const opts = thisCommand.optsWithGlobals<{ json?: boolean; verbose?: boolean }>();
      const json = opts.json === true || dependencies.env.FIRST_TREE_JSON === "1";
      dependencies.setJsonMode(json);

      // Log-level precedence: --verbose > FIRST_TREE_LOG_LEVEL > mode default.
      // One-shot commands are noisy by default, so human mode defaults to
      // `warn`, while JSON mode keeps stderr for real failures only.
      if (opts.verbose) {
        dependencies.applyClientLoggerConfig({ level: "debug", explicit: true });
      } else if (dependencies.env.FIRST_TREE_LOG_LEVEL) {
        // The env var was applied at logger init. Re-pin it so later
        // config-driven applies cannot override the operator's choice.
        dependencies.applyClientLoggerConfig({ explicit: true });
      } else if (json) {
        dependencies.applyClientLoggerConfig({ level: "error", explicit: true });
      } else {
        dependencies.applyClientLoggerConfig({ level: "warn" });
      }

      // The first old-X -> new-Y update handoff already has a 45-second child
      // timeout loaded in X. Do not spend the retirement budget inside the
      // hidden refresh child. X refreshes the unit and exits 75; the
      // supervisor-restarted Y performs this migration from `daemon start`.
      if (isDaemonRefreshUnitAction(program, actionCommand)) return;

      // Construct the logger only after JSON and log-level normalization.
      const logger = dependencies.createLogger("legacy-github-scan-retirement");
      try {
        const result = dependencies.runLegacyGithubScanLaunchdRetirementOnce();
        logRetirementResult(logger, result);
      } catch (error) {
        // This boundary is deliberately non-throwing: retirement must never
        // turn an ordinary command or supervisor start into a crash-loop.
        const errorType = error instanceof Error ? error.name : typeof error;
        logger.error(
          { errorType: boundedToken(errorType) },
          "legacy github-scan launchd retirement failed unexpectedly; continuing command",
        );
      }
    });
}

function isDaemonRefreshUnitAction(program: Command, actionCommand?: Command): boolean {
  if (!actionCommand) return false;
  const daemon = actionCommand.parent;
  return actionCommand.name() === "refresh-unit" && daemon?.name() === "daemon" && daemon.parent === program;
}

function logRetirementResult(logger: CliRuntimeLogger, result: LegacyGithubScanLaunchdRetirementResult): void {
  const context = {
    retired: result.retired,
    ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt }),
    ...(result.diagnostics.length === 0 ? {} : { diagnostics: result.diagnostics }),
  };

  switch (result.status) {
    case "complete":
      logger.info(context, "retired legacy github-scan launchd service");
      return;
    case "partial":
      logger.error(context, "legacy github-scan launchd retirement is incomplete; continuing command");
      return;
    case "deferred":
      logger.error(context, "legacy github-scan launchd retirement is deferred with exact candidates pending");
      return;
    case "not-applicable":
    case "absent":
      return;
  }
}

function boundedToken(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.-]/g, "_");
  return cleaned.slice(0, 64) || "unknown";
}
