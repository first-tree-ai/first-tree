import { randomUUID } from "node:crypto";
import {
  createServerConfigSchema,
  initConfig,
  resolveConfigReadonly,
  type ServerConfig,
  serverConfigSchema,
} from "@first-tree/shared/config";
import { buildApp } from "./app.js";
import { assertBootConfigValid } from "./boot-guards.js";
import { markReady } from "./bootstrap-state.js";
import { runStage } from "./bootstrap-utils.js";
import type { Config } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { applyLoggerConfig, createLogger, initTelemetry, shutdownTelemetry } from "./observability/index.js";
import { withDefaultGitlabOrigin } from "./services/scm/gitlab/egress-policy.js";

const log = createLogger("Bootstrap");

export type ServerBootstrapDeps = {
  initServerConfig?: () => Promise<ServerConfig>;
  randomUUID?: () => string;
  webDistPath?: string | undefined;
  initTelemetry?: typeof initTelemetry;
  runMigrations?: typeof runMigrations;
  buildApp?: typeof buildApp;
  markReady?: typeof markReady;
  shutdownTelemetry?: typeof shutdownTelemetry;
};

export function shouldAutoGenerateServerSecrets(configDir?: string): boolean {
  const resolved = resolveConfigReadonly({ schema: serverConfigSchema, role: "server", configDir });
  return resolved.channel === "dev" && process.env.NODE_ENV !== "production";
}

async function loadServerConfig(): Promise<ServerConfig> {
  return initConfig({
    schema: createServerConfigSchema({ autoGenerateSecrets: shouldAutoGenerateServerSecrets() }),
    role: "server",
  });
}

export function buildRuntimeConfig(
  serverConfig: ServerConfig,
  instanceId: string,
  webDistPath: string | undefined,
): Config {
  const configuredAllowlist = serverConfig.gitlab?.egressAllowlist;
  const egressAllowlist = withDefaultGitlabOrigin(configuredAllowlist ?? []);
  return {
    ...serverConfig,
    gitlab: { egressAllowlist },
    instanceId: `srv_${instanceId.slice(0, 8)}`,
    webDistPath: webDistPath && webDistPath.length > 0 ? webDistPath : undefined,
  };
}

export async function startServer(deps: ServerBootstrapDeps = {}): Promise<void> {
  const serverConfig = await (deps.initServerConfig ?? loadServerConfig)();

  // Apply logger config first so bootstrap logs use the right level / format.
  applyLoggerConfig({
    level: serverConfig.observability.logging.level,
    format: serverConfig.observability.logging.format,
    bridgeToSpanLevel: serverConfig.observability.logging.bridgeToSpanLevel,
  });

  const webDistPath = deps.webDistPath ?? process.env.FIRST_TREE_WEB_DIST_PATH;
  const config = buildRuntimeConfig(serverConfig, (deps.randomUUID ?? randomUUID)(), webDistPath);

  // Fail closed before telemetry or database side effects. buildApp keeps the
  // same guard as a second line of defense for test helpers and future callers.
  assertBootConfigValid(config);

  // Initialize telemetry before anything else — spans emitted during app
  // bootstrap (e.g. notifier.start) will then be captured. instanceId is
  // carried as service.instance.id so replicas are distinguishable in the
  // trace backend.
  await runStage(
    "initTelemetry",
    () => (deps.initTelemetry ?? initTelemetry)(serverConfig.observability.tracing, config.instanceId),
    10_000,
  );

  // Bootstrap stages run at the ROOT OTel context — no enclosing span. An
  // earlier version wrapped this block in `withSpan("server.bootstrap", …)`
  // so Logfire would show a single bootstrap flamegraph, but AsyncLocalStorage
  // propagates that span as the active context into every timer / event
  // listener registered during `appListen` (notifier LISTEN handlers,
  // `setInterval` background tasks, the net.Server's `connection` event
  // chain). The result: every HTTP root span, ws.connection span, and
  // background-task span across the process lifetime parents under that one
  // ended span, collapsing the trace UI into a single bootstrap branch.
  // Per-stage signals live in the structured `bootstrap.stage.{start,done,
  // failed}` logs emitted by `runStage`, which are sufficient for boot
  // analysis without dragging a context onto every downstream span.

  // Run Drizzle migrations before the app comes up. Serialized across
  // replicas by a session-level advisory lock held for the whole migrate
  // (see db/migrate.ts): non-owner replicas wait, and once they acquire the
  // lock the journal has advanced, so their migrate is a no-op. The 20s
  // budget matches the Dockerfile HEALTHCHECK start-period so a migration
  // (including the lock wait) that truly exceeds it fails the boot fast
  // rather than letting docker judge unhealthy mid-migration. If a future
  // migration is known to run longer, raise both this and the HEALTHCHECK
  // start-period together.
  const tableCount = await runStage(
    "runMigrations",
    () => (deps.runMigrations ?? runMigrations)(serverConfig.database.url),
    20_000,
  );
  log.info({ tableCount }, "migrations applied");

  const app = await runStage("buildApp", () => (deps.buildApp ?? buildApp)(config), 30_000);
  await runStage("appListen", () => app.listen({ host: config.server.host, port: config.server.port }), 10_000);
  (deps.markReady ?? markReady)();
  log.info(`server listening on http://${config.server.host}:${config.server.port}`);

  const shutdown = async (signal: string) => {
    log.info(`received ${signal}, shutting down`);
    try {
      await app.close();
    } finally {
      await (deps.shutdownTelemetry ?? shutdownTelemetry)();
      process.exit(0);
    }
  };
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}
