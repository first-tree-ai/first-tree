import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, resolve } from "node:path";
import fastifyOpenTelemetry from "@autotelic/fastify-opentelemetry";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { getChannelConfig } from "@first-tree/shared/channel";
import { FIRST_TREE_ATTR, redactUrl } from "@first-tree/shared/observability";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyPluginAsync } from "fastify";
import postgres from "postgres";
import { ZodError } from "zod";
import { agentChatRoutes } from "./api/agent/chats.js";
import { agentConfigRoutes as agentRuntimeConfigRoutes } from "./api/agent/config.js";
import { agentContextReviewRunRoutes } from "./api/agent/context-review-runs.js";
import { agentContextTreeInfoRoutes } from "./api/agent/context-tree-info.js";
import { agentContextTreeIoRoutes } from "./api/agent/context-tree-io.js";
import { agentCronJobRoutes } from "./api/agent/cron-jobs.js";
import { agentDocumentRoutes } from "./api/agent/documents.js";
import { agentFeishuRoutes } from "./api/agent/feishu.js";
import { agentGithubTaskRunRoutes } from "./api/agent/github-task-runs.js";
import { agentInboxRoutes } from "./api/agent/inbox.js";
import { agentMeRoutes } from "./api/agent/me.js";
import { agentMessageRoutes } from "./api/agent/messages.js";
import { clientWsRoutes } from "./api/agent/ws-client.js";
import { agentActivityRoutes } from "./api/agent-activity.js";
import { publicAgentTemplateRoutes } from "./api/agent-templates.js";
import { agentUsageRoutes } from "./api/agent-usage.js";
import { agentRoutes, publicAgentAvatarRoutes } from "./api/agents.js";
import { agentConfigRoutes } from "./api/agents-config.js";
import { agentFeishuBindingRoutes } from "./api/agents-feishu.js";
import { agentResourcesRoutes } from "./api/agents-resources.js";
import { attachmentRoutes } from "./api/attachments.js";
import { githubOauthRoutes } from "./api/auth/github.js";
import { googleOauthRoutes } from "./api/auth/google.js";
import { oidcRoutes } from "./api/auth/oidc.js";
import { authRoutes } from "./api/auth.js";
import { bootstrapConfigRoutes } from "./api/bootstrap/config.js";
import { chatRoutes } from "./api/chats.js";
import { clientRoutes } from "./api/clients.js";
import { contextTreeInfoRoutes } from "./api/context-tree-info.js";
import { contextTreeSnapshotRoutes } from "./api/context-tree-snapshot.js";
import { chatCronJobRoutes, cronJobRoutes } from "./api/cron-jobs.js";
import { documentCommentRoutes, documentRoutes } from "./api/documents.js";
import { gitlabConnectionRoutes } from "./api/gitlab-connections.js";
import { gitlabIdentityLinkRoutes } from "./api/gitlab-identity-links.js";
import { healthRoutes } from "./api/health.js";
import { healthzRoutes } from "./api/healthz.js";
import { internalAgentTemplateRoutes } from "./api/internal/agent-templates.js";
import { scanCampaignExportRoutes } from "./api/internal/scan-campaign-exports.js";
import { publicInvitationRoutes } from "./api/invitations.js";
import { landingCampaignRoutes } from "./api/landing-campaigns.js";
import { meRoutes } from "./api/me.js";
import { meAuthProviderRoutes } from "./api/me-auth-providers.js";
import { meDocsRoutes } from "./api/me-docs.js";
import { orgActivityRoutes } from "./api/orgs/activity.js";
import { orgAgentRoutes } from "./api/orgs/agents.js";
import { orgAttachmentRoutes } from "./api/orgs/attachments.js";
import { orgChatRoutes } from "./api/orgs/chats.js";
import { orgClientRoutes } from "./api/orgs/clients.js";
import { orgContextActivationRoutes } from "./api/orgs/context-activation.js";
import { orgContextEnablementRoutes } from "./api/orgs/context-enablement.js";
import { orgContextReviewerRoutes } from "./api/orgs/context-reviewer.js";
import { orgContextTreeRoutes } from "./api/orgs/context-tree.js";
import { orgContextTreeSnapshotRoutes } from "./api/orgs/context-tree-snapshot.js";
import { orgDocumentRoutes } from "./api/orgs/documents.js";
import { orgGithubAppRoutes } from "./api/orgs/github-app.js";
import { orgGitlabConnectionRoutes } from "./api/orgs/gitlab-connections.js";
import { orgGitlabIdentityLinkRoutes } from "./api/orgs/gitlab-identity-links.js";
import { orgIdentityRoutes } from "./api/orgs/identity.js";
import { orgInvitationRoutes } from "./api/orgs/invitations.js";
import { orgMemberRoutes } from "./api/orgs/members.js";
import { orgOverviewRoutes } from "./api/orgs/overview.js";
import { orgResourceRoutes } from "./api/orgs/resources.js";
import { orgSessionRoutes } from "./api/orgs/sessions.js";
import { orgSettingsRoutes } from "./api/orgs/settings.js";
import { orgSetupCapabilitiesRoutes } from "./api/orgs/setup-capabilities.js";
import { orgTeamAgentRoutes } from "./api/orgs/team-agent.js";
import { orgUsageRoutes } from "./api/orgs/usage.js";
import { orgWsRoutes } from "./api/orgs/ws.js";
import { readyzRoutes } from "./api/readyz.js";
import { resourceRoutes } from "./api/resources.js";
import { sessionRoutes } from "./api/sessions.js";
// Public agent discovery removed — visibility is now handled via agent.visibility field
import { githubAppWebhookRoutes } from "./api/webhooks/github-app.js";
import { gitlabWebhookRoutes } from "./api/webhooks/gitlab.js";
import { assertBootConfigValid } from "./boot-guards.js";
import type { Config } from "./config.js";
import { connectDatabase, sslOptions } from "./db/connection.js";
import { AppError } from "./errors.js";
import { agentSelectorHook } from "./middleware/agent-selector.js";
import { userAuthHook } from "./middleware/user-auth.js";
import {
  applyLoggerConfig,
  attachRequestContext,
  bodyCaptureOnSendHook,
  buildRateLimitError,
  createLogger,
  currentTraceId,
  observabilityPlugin,
  reportErrorToRoot,
  rootLogger,
} from "./observability/index.js";
import { securityHeadersHook } from "./security-headers.js";
import { broadcastToAdmins } from "./services/admin-broadcast.js";
import { createConfigService } from "./services/agents/config.js";
import { createResourcesService } from "./services/agents/resources/catalog.js";
import { backfillResourcesPhase1 } from "./services/agents/resources/migration.js";
import { backfillExternalAttachmentsToPostgres } from "./services/attachment.js";
import {
  type AttachmentBlobStore,
  createS3AttachmentBlobStore,
  createUnavailableAttachmentBlobStore,
} from "./services/attachment-blob-store.js";
import { expiryToSeconds } from "./services/auth/tokens.js";
import {
  type BackgroundTaskOptions,
  type BackgroundTasks,
  createBackgroundTasks,
} from "./services/background-tasks.js";
import {
  invalidateChatAudienceLocal,
  registerChatAudienceDispatcher,
} from "./services/chat/membership/audience-cache.js";
import { registerChatMessageDispatcher } from "./services/chat/workspace/projection.js";
import { createFeishuIntegrationManager, type FeishuSdkDependencies } from "./services/integrations/feishu/manager.js";
import { createNotifier, type Notifier } from "./services/notifier.js";
import { createCommandVersionPoller } from "./services/runtime/daemon/command-version-poller.js";
import { createPulseAggregator } from "./services/runtime/pulse-aggregator.js";
import { backfillGitlabAttentionPairs } from "./services/scm/gitlab/attention-backfill.js";
import { backfillSkillResourceBundles } from "./services/skill-bundle.js";
import { repairMembershipHumanMirrors } from "./services/team/membership.js";
import { ensureDefaultOrganization } from "./services/team/organization.js";

// Fastify type augmentation
import "./types.js";

export type AppContext = {
  notifier: Notifier;
  backgroundTasks: BackgroundTasks;
};

/**
 * Resolve the bootstrap Command-package version advertised before the first
 * successful npm-registry poll lands. Priority order:
 *
 *  1. `config.update.commandVersion` — explicit injection. Set by the
 *     Dockerfile at build time (via `COMMAND_VERSION` build-arg, which CI
 *     reads from `apps/cli/package.json.version`), so a fresh image
 *     boots with a sane version even when the npm registry is unreachable
 *     at startup.
 *  2. Server workspace's own `package.json` — kept only for `pnpm --filter
 *     … dev` runs where no build-arg path exists. Server's package.json
 *     never bumps (it's `private: true`), so this is intentionally a weak
 *     fallback — at runtime the poller will overwrite it within minutes.
 *  3. `"0.0.0"` — last-resort sentinel that keeps the welcome frame
 *     well-formed. SemVer-valid; clients drop into the "ahead" branch and
 *     skip update, which is the right failure mode (better than crashing
 *     clients with an invalid version string).
 */
function resolveBootstrapCommandVersion(injected: string | undefined): string {
  if (injected && injected.trim().length > 0) return injected;
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("../package.json") as { version?: string };
    if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
  } catch {
    // fall through
  }
  return "0.0.0";
}

/**
 * Stamp `fn.name` so fastify's `getPluginName()` and `@fastify/otel` use the
 * label we want — keeps hook spans rendering as `handler - adminAgentScope`
 * instead of `handler - async (app) => { -- const jwtSecre…` (the
 * `getFuncPreview()` fallback fastify uses for anonymous plugin functions).
 */
function namePlugin<T extends FastifyPluginAsync>(name: string, fn: T): T {
  Object.defineProperty(fn, "name", { value: name, configurable: true });
  return fn;
}

export type BuildAppOptions = {
  attachmentBlobStore?: AttachmentBlobStore;
  backgroundTasks?: BackgroundTaskOptions;
  /** Test-only/provider-boundary injection; production uses the official SDK directly. */
  feishuSdk?: FeishuSdkDependencies;
};

export async function buildApp(config: Config, options: BuildAppOptions = {}) {
  // Validate token-lifetime config eagerly so a typo in
  // `FIRST_TREE_AUTH_*_EXPIRY` fails the boot, not the first
  // /connect-tokens call hours later.
  try {
    expiryToSeconds(config.auth.accessTokenExpiry);
    expiryToSeconds(config.auth.refreshTokenExpiry);
    expiryToSeconds(config.auth.connectTokenExpiry);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${msg} — check FIRST_TREE_AUTH_*_EXPIRY env vars (got access=${config.auth.accessTokenExpiry}, refresh=${config.auth.refreshTokenExpiry}, connect=${config.auth.connectTokenExpiry}).`,
    );
  }

  // GitHub App config sanity (PEM header / blank-secret / half-config).
  // Runs here so a misconfigured App env block fails the boot, not the
  // first App JWT call hours later. Cheap; only fires when the App
  // block is present.
  assertBootConfigValid(config);

  applyLoggerConfig({
    level: config.observability.logging.level,
    format: config.observability.logging.format,
    bridgeToSpanLevel: config.observability.logging.bridgeToSpanLevel,
  });

  // Cast widens pino.Logger<never, boolean> → FastifyBaseLogger so the
  // returned FastifyInstance has the default generic and remains assignable
  // in tests / callers that reference FastifyInstance without type args.
  const app = Fastify({
    loggerInstance: rootLogger as unknown as FastifyBaseLogger,
    // When deployed behind Cloudflare / reverse proxy, `req.ip` must reflect
    // the real client IP rather than the proxy. The global limiter prefers
    // agent/user identity, but public unauthenticated traffic still falls back
    // to IP. Operators set FIRST_TREE_TRUST_PROXY=true when they control the
    // upstream proxy chain.
    trustProxy: config.trustProxy,
  });

  // Loud security reminder: trustProxy=true makes Fastify trust ANY upstream's
  // x-forwarded-for header. Safe iff the First Tree container only receives traffic
  // through a vetted proxy (Cloudflare → CapRover). If the container is ever
  // exposed to the public internet directly, attackers can spoof XFF and
  // bypass every IP-keyed rate limit / audit log. Surface this on every boot
  // so a misconfiguration is loud rather than silent.
  if (config.trustProxy) {
    app.log.warn(
      "trustProxy=true — Fastify trusts ANY upstream's x-forwarded-for. " +
        "Ensure Cloudflare / CapRover is the only ingress; do NOT expose this " +
        "container's port to the public internet directly.",
    );
  }

  // HTTP tracing — `@autotelic/fastify-opentelemetry` opens one span on
  // `onRequest`, ends it on `onResponse`. No per-hook child spans (so we
  // never see `handler - async (app) => …` noise), and the span is exposed
  // via `request.openTelemetry().activeSpan` so any later hook / handler
  // can decorate it without `trace.getActiveSpan()` foot-guns.
  //
  // Logfire's bundled `@opentelemetry/instrumentation-fastify` is disabled
  // in `logfire-init.ts` to avoid duplicate root spans.
  //
  // `formatSpanAttributes` overrides autotelic's defaults to:
  //   - align attribute names with OTel HTTP semantic conventions
  //     (`http.method`, `http.url`, `http.response.status_code`,
  //     `exception.type`, `exception.message`, `exception.stacktrace`)
  //     so dashboards / saved queries port between trace backends
  //   - capture `user-agent`, `referer`, `request.id` unconditionally
  //     (no PII, high day-to-day debug value)
  //   - capture `client.ip` only when `captureClientIp` is enabled — the
  //     opt-in honours the GDPR-friendly default discussed in the
  //     observability overhaul. See server-config.ts for the env switch.
  const captureClientIp = config.observability.tracing?.captureClientIp ?? false;
  await app.register(fastifyOpenTelemetry, {
    wrapRoutes: true,
    formatSpanName: formatHttpSpanName,
    formatSpanAttributes: {
      request: (request) => {
        const route = request.routeOptions?.url;
        const target = redactUrl(request.url.split("?")[0] ?? request.url);
        // `http.url` retains the query string for debugability but is run
        // through `redactUrl` so JWTs in `?token=…` (admin WS upgrade) never
        // reach the trace exporter — same vocabulary as the fastify logger's
        // `req` serializer, see `observability/logger.ts`.
        const attrs: Record<string, string | number | boolean> = {
          "http.method": request.method,
          "http.url": redactUrl(request.url),
          "http.target": target,
          "http.scheme": request.protocol,
          "http.host": String(request.headers.host ?? ""),
          "request.id": request.id,
        };
        if (route) attrs["http.route"] = route;
        const ua = request.headers["user-agent"];
        if (typeof ua === "string" && ua.length > 0) {
          attrs["http.user_agent"] = ua.slice(0, 200);
        }
        const referer = request.headers.referer ?? request.headers.referrer;
        if (typeof referer === "string" && referer.length > 0) {
          attrs["http.referer"] = referer.slice(0, 200);
        }
        if (captureClientIp) {
          attrs["client.ip"] = request.ip;
        }
        return attrs;
      },
      reply: (reply) => ({
        "http.status_code": reply.statusCode,
        "http.response.status_code": reply.statusCode,
      }),
      error: (error) => ({
        "exception.type": error.name,
        "exception.message": error.message,
        "exception.stacktrace": error.stack ?? "",
      }),
    },
    // Skip tracing for:
    //   - static SPA assets, fonts, healthchecks → volume without value
    //   - WebSocket upgrade routes → fastify hijacks the reply, so an HTTP
    //     root span here would never see `onResponse` and would leak.
    //     We emit a dedicated long-running `ws.connection` span from
    //     `ws-tracing.ts` instead.
    ignoreRoutes: (path: string) => {
      if (path === "/" || path === "/healthz") return true;
      if (path.startsWith("/assets/") || path.startsWith("/fonts/")) return true;
      if (path === "/api/v1/agent/ws/client") return true;
      // Org WS upgrade: `/api/v1/orgs/:orgId/ws/`. Use a startsWith check so
      // every org's socket-upgrade path is excluded.
      if (path.startsWith("/api/v1/orgs/") && path.endsWith("/ws/")) return true;
      return false;
    },
  });

  // Request-scoped logger + x-trace-id + error correlation
  await app.register(observabilityPlugin);

  // Decorate with config and db
  const db = connectDatabase(config.database.url);
  app.decorate("db", db);
  app.decorate("config", config);
  const attachmentBlobStore =
    options.attachmentBlobStore ??
    (config.objectStorage ? createS3AttachmentBlobStore(config.objectStorage) : createUnavailableAttachmentBlobStore());
  app.decorate("attachmentBlobStore", attachmentBlobStore);

  // Advisory Command-package version broadcast to every Client via the
  // `server:welcome` WS frame. The poller refreshes the advertised value
  // from the npm registry on `config.update.pollIntervalMinutes`, so the
  // server's deploy cadence no longer gates client auto-update. Bootstrap
  // value is the build-arg-injected version; the poller takes over on
  // `onReady`.
  //
  // Multi-env: the package name to poll is derived from this server's
  // channel (`config.channel`). dev servers (channel=dev) get
  // `packageName=null`, putting the poller into no-op mode — there is no
  // published package to poll when the operator is running a symlinked
  // source build.
  const channelIdentity = getChannelConfig(config.channel);
  const bootstrapCommandVersion = resolveBootstrapCommandVersion(config.update.commandVersion);
  const commandVersionPoller = createCommandVersionPoller({
    logger: app.log,
    registryUrl: config.update.registryUrl,
    packageName: channelIdentity.packageName,
    intervalMs: config.update.pollIntervalMinutes * 60_000,
    initialVersion: bootstrapCommandVersion,
  });
  app.decorate("commandVersion", () => commandVersionPoller.get());
  app.log.info(
    {
      bootstrapCommandVersion,
      channel: config.channel,
      packageName: channelIdentity.packageName,
      binName: channelIdentity.binName,
      pollIntervalMinutes: config.update.pollIntervalMinutes,
    },
    "First Tree server advertising command version (poller bootstrap)",
  );

  // Notifier: dedicated PG connection for LISTEN/NOTIFY
  const listenClient = postgres(config.database.url, { max: 1, ...sslOptions(config.database.url) });
  const notifier = createNotifier(listenClient);
  const feishuIntegration = createFeishuIntegrationManager({
    db,
    notifier,
    encryptionKey: config.secrets.encryptionKey,
    instanceId: config.instanceId,
    attachmentObjectQuota: { maxOrganizationAttachments: config.attachments.organizationObjectQuota },
    ...(options.feishuSdk ? { sdk: options.feishuSdk } : {}),
  });
  app.decorate("feishuIntegration", feishuIntegration);

  // Per-agent runtime config service and Resources resolver.
  const configService = createConfigService({
    db,
    notifier,
    encryptionKey: config.secrets.encryptionKey,
  });
  app.decorate("configService", configService);
  const resourcesService = createResourcesService({
    db,
    notifier,
    attachmentBlobStore,
    agentTemplatePublisherOrgId: config.agentTemplates?.publisherOrgId,
  });
  app.decorate("resourcesService", resourcesService);

  // WebSocket plugin. `maxPayload` caps a single inbound frame so a hostile
  // or buggy client cannot OOM the server with one giant message. Frames in
  // this codebase are JSON envelopes; image content travels via HTTP.
  await app.register(websocket, {
    options: { maxPayload: config.ws?.maxPayload ?? 65_536 },
  });

  // Body parser for `application/octet-stream` — needed by the attachment
  // upload route. Fastify's built-in parsers cover json / text only; without
  // this registration `request.body` would be undefined on an octet-stream
  // POST and the route would 415. Registered globally because Fastify only
  // supports global content-type parsers; the route still owns its own
  // `bodyLimit` so the byte cap is route-local.
  app.addContentTypeParser("application/octet-stream", (_req, body, done) => {
    done(null, body);
  });

  // CORS — explicit origins if configured; allow all in dev; same-origin in production
  const corsOrigin = config.cors?.origin;
  const isDev = process.env.NODE_ENV !== "production";
  await app.register(cors, {
    origin: corsOrigin ? corsOrigin.split(",").map((s) => s.trim()) : isDev,
    credentials: true,
  });

  // App-wide browser security headers (CSP / HSTS / nosniff / frame / referrer
  // / permissions) on every response — SPA, static assets, API JSON, errors.
  // The hook only fills headers a route has not set itself, so route-local
  // policies keep winning. See security-headers.ts (issue #1541).
  app.addHook("onSend", securityHeadersHook);

  // Rate limiting — single actor-aware global safety cap.
  // `hook: "preHandler"` runs the limiter after route-level onRequest hooks
  // (memberAuth, agentSelector) so the key generator can read
  // `req.user` / `req.agent` populated by those hooks.
  //
  // `errorResponseBuilder` runs during the rate-limit throw path, before
  // setErrorHandler enriches with traceId. The body of the builder lives
  // in observability/rate-limit-error-builder.ts so the span-stamping
  // side effect can be unit-tested without booting an app.
  await app.register(rateLimit, {
    max: config.rateLimit?.max ?? 3000,
    timeWindow: "1 minute",
    hook: "preHandler",
    keyGenerator: (req) => {
      if (req.agent?.uuid) return `agent:${req.agent.uuid}`;
      if (req.user?.userId) return `user:${req.user.userId}`;
      return `ip:${req.ip}`;
    },
    errorResponseBuilder: buildRateLimitError,
  });

  // Body-capture onSend hook — opt-in per route via `config: { otelRecordBody: true }`
  // and only fires on `statusCode >= 400`. Registered globally so any route
  // that flips the flag participates without extra wiring.
  app.addHook("onSend", bodyCaptureOnSendHook);

  // Auth hooks
  const userAuth = userAuthHook(db, config.secrets.jwtSecret);
  const agentSelector = agentSelectorHook(db);

  // Helper: build a user-authenticated plugin scope. Each scope mounts:
  //   1. userAuth (validate JWT, populate request.user = { userId })
  //   2. attachRequestContext (stamp user.id onto root span)
  //   3. The caller-provided routes
  //
  // Per-org and per-resource gating is handled INSIDE handlers via the
  // `scope/require-*` helpers (`requireOrgMembership`, `requireAgentAccess`,
  // …) — NOT at the plugin scope level. This is what kills the JWT-ambient-
  // scope bug class: the URL carries the scope explicitly and the helpers
  // probe membership in real time.
  function userScope(name: string, register: (scope: FastifyInstance) => Promise<void>): FastifyPluginAsync {
    return namePlugin(name, async (scope) => {
      scope.addHook("onRequest", userAuth);
      scope.addHook("onRequest", attachRequestContext);
      await register(scope);
    });
  }

  function agentScope(name: string, register: (scope: FastifyInstance) => Promise<void>): FastifyPluginAsync {
    return namePlugin(name, async (scope) => {
      scope.addHook("onRequest", userAuth);
      scope.addHook("onRequest", agentSelector);
      scope.addHook("onRequest", attachRequestContext);
      await register(scope);
    });
  }

  // Error handler — enriches error body with traceId so operators can search
  // the trace backend by `x-trace-id` or body.traceId, AND stamps the active
  // span with structured failure attributes via reportError. The latter
  // matters for 4xx responses too: @fastify/otel marks any response with
  // status < 500 as `SpanStatusCode.OK` in its onSend hook, so we record
  // the exception explicitly here to keep the failure visible in trace
  // backends without needing to query SpanStatus.
  app.setErrorHandler((error, request, reply) => {
    const traceId = currentTraceId();
    const traceField = traceId ? { traceId } : {};

    if (error instanceof AppError) {
      // Caller-supplied attrs spread FIRST so the canonical `error.type` /
      // `http.status_code` always win — `AppError.attrs` is a public field
      // and we don't want a future caller to accidentally clobber the
      // structural fields by passing them with the same key.
      reportErrorToRoot(request, error.message, error, {
        ...(error.attrs ?? {}),
        [FIRST_TREE_ATTR.ERROR_TYPE]: error.name,
        "http.status_code": error.statusCode,
      });
      return reply.status(error.statusCode).send({
        error: error.message,
        ...(typeof error.attrs?.code === "string" ? { code: error.attrs.code } : {}),
        ...traceField,
      });
    }

    if (error instanceof ZodError) {
      reportErrorToRoot(request, "Validation error", error, {
        [FIRST_TREE_ATTR.ERROR_TYPE]: "ZodError",
        "validation.issue_count": error.issues.length,
      });
      return reply.status(400).send({ error: "Validation error", details: error.issues, ...traceField });
    }

    // Fastify plugins (e.g. @fastify/rate-limit's 429, @fastify/jwt's 401)
    // throw errors with `statusCode` in the 4xx range. Surface them with
    // their intended status + message rather than collapsing to 500. 5xx
    // statuses still fall through to the generic handler below to avoid
    // leaking server-internal messages.
    if (
      error instanceof Error &&
      "statusCode" in error &&
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      reportErrorToRoot(request, error.message, error, {
        [FIRST_TREE_ATTR.ERROR_TYPE]: error.name,
        "http.status_code": error.statusCode,
      });
      return reply.status(error.statusCode).send({ error: error.message, ...traceField });
    }

    request.log.error({ err: error }, "unhandled request error");
    reportErrorToRoot(request, "Internal server error", error, {
      [FIRST_TREE_ATTR.ERROR_TYPE]: error instanceof Error ? error.name : "UnknownError",
      "http.status_code": 500,
    });
    return reply.status(500).send({ error: "Internal server error", ...traceField });
  });

  // Root-level health checks for container orchestration (outside /api/v1).
  // `/healthz` checks process + DB reachability (used by Docker HEALTHCHECK).
  // `/readyz` checks full readiness — all bootstrap stages done.
  // See docs/server-bootstrap-resilience-design.md §3 (T6).
  await app.register(healthzRoutes);
  await app.register(readyzRoutes);

  // All API routes under /api/v1 prefix
  await app.register(
    namePlugin("apiV1Scope", async (api) => {
      // ── Public routes ────────────────────────────────────────────────────
      await api.register(healthRoutes);
      await api.register(githubAppWebhookRoutes, { prefix: "/webhooks" });
      await api.register(gitlabWebhookRoutes, { prefix: "/webhooks" });
      await api.register(authRoutes, { prefix: "/auth" });
      await api.register(githubOauthRoutes, { prefix: "/auth/github" });
      await api.register(googleOauthRoutes, { prefix: "/auth/google" });
      await api.register(oidcRoutes, { prefix: "/auth/oidc" });
      await api.register(publicInvitationRoutes, { prefix: "/invitations" });
      await api.register(bootstrapConfigRoutes, { prefix: "/bootstrap" });
      // Public read for manager-uploaded agent avatars — `<img src>` cannot
      // attach the member-JWT, so the read path lives outside the auth scope.
      // Writes (PUT/DELETE) stay inside `agentRoutes` and are JWT-gated.
      await api.register(publicAgentAvatarRoutes, { prefix: "/agents" });
      // Public, unauthenticated official Agent Template catalog (safe read
      // model only). Writes live behind the publisher guard under /internal.
      await api.register(publicAgentTemplateRoutes, { prefix: "/agent-templates" });

      // ── Class A — `/me`, `/auth` (user-scoped) ──────────────────────────
      await api.register(
        userScope("contextTreeScope", async (scope) => {
          await scope.register(contextTreeInfoRoutes);
          await scope.register(contextTreeSnapshotRoutes);
        }),
        { prefix: "/context-tree" },
      );

      await api.register(
        userScope("meRoutesScope", async (scope) => {
          await scope.register(meRoutes);
          await scope.register(meAuthProviderRoutes);
          await scope.register(landingCampaignRoutes, { prefix: "/me/landing-campaigns" });
          await scope.register(meDocsRoutes, { workspacesRoot: config.workspace.root });
        }),
        { prefix: "" },
      );

      // Object-storage primitive — download surface (user-JWT). Generic
      // binary blob download; not bound to any business surface. Auth is a
      // capability model: valid JWT + knowledge of the unguessable id. Upload
      // lives under the org scope below. See api/attachments.ts.
      await api.register(
        userScope("attachmentRoutesScope", async (scope) => {
          await scope.register(attachmentRoutes);
        }),
        { prefix: "/attachments" },
      );

      await api.register(
        userScope("internalAnalyticsScope", async (scope) => {
          await scope.register(scanCampaignExportRoutes, { prefix: "/analytics/scan-campaign-exports" });
        }),
        { prefix: "/internal" },
      );

      // Official Agent Template catalog maintenance. `/internal` is a
      // namespace only — every handler re-proves current publisher-Team
      // admin membership per request.
      await api.register(
        userScope("internalAgentTemplatesScope", async (scope) => {
          await scope.register(internalAgentTemplateRoutes, { prefix: "/agent-templates" });
        }),
        { prefix: "/internal" },
      );

      // ── Class B — `/orgs/:orgId/...` (org-scoped) ───────────────────────
      await api.register(
        userScope("orgsScope", async (scope) => {
          await scope.register(orgIdentityRoutes);
          await scope.register(orgAgentRoutes, { prefix: "/agents" });
          await scope.register(orgChatRoutes, { prefix: "/chats" });
          await scope.register(orgOverviewRoutes, { prefix: "/overview" });
          await scope.register(orgActivityRoutes, { prefix: "/activity" });
          await scope.register(orgUsageRoutes, { prefix: "/usage" });
          await scope.register(orgSessionRoutes, { prefix: "/sessions" });
          await scope.register(orgClientRoutes, { prefix: "/clients" });
          await scope.register(orgContextActivationRoutes, { prefix: "/context-activation" });
          await scope.register(orgContextEnablementRoutes, { prefix: "/context-enablement" });
          await scope.register(orgInvitationRoutes, { prefix: "/invitations" });
          await scope.register(orgMemberRoutes, { prefix: "/members" });
          await scope.register(orgSettingsRoutes, { prefix: "/settings" });
          await scope.register(orgResourceRoutes, { prefix: "/resources" });
          await scope.register(orgGithubAppRoutes, { prefix: "/github-app-installation" });
          await scope.register(orgGitlabConnectionRoutes, { prefix: "/gitlab-connections" });
          await scope.register(orgGitlabIdentityLinkRoutes, { prefix: "/gitlab-identity-links" });
          await scope.register(orgContextReviewerRoutes, { prefix: "/context-reviewer" });
          await scope.register(orgTeamAgentRoutes, { prefix: "/team-agent" });
          await scope.register(orgContextTreeRoutes, { prefix: "/context-tree" });
          await scope.register(orgContextTreeSnapshotRoutes, { prefix: "/context-tree" });
          await scope.register(orgSetupCapabilitiesRoutes, { prefix: "/setup-capabilities" });
          await scope.register(orgAttachmentRoutes, { prefix: "/attachments" });
          if (config.docs.enabled) {
            await scope.register(orgDocumentRoutes, { prefix: "/documents" });
          }
        }),
        { prefix: "/orgs/:orgId" },
      );

      // ── Class B — Admin WS (mounted separately because of the websocket plugin scope) ─
      await api.register(orgWsRoutes(notifier, config.secrets.jwtSecret), { prefix: "/orgs/:orgId/ws" });

      // ── Class C — resource-scoped (`/agents/:uuid`, `/chats/:chatId`, …) ─
      await api.register(
        userScope("resourcesScope", async (scope) => {
          await scope.register(agentRoutes, { prefix: "/agents" });
          await scope.register(agentConfigRoutes, { prefix: "/agents" });
          await scope.register(agentResourcesRoutes, { prefix: "/agents" });
          await scope.register(agentFeishuBindingRoutes, { prefix: "/agents" });
          await scope.register(agentActivityRoutes, { prefix: "/agents" });
          await scope.register(agentUsageRoutes, { prefix: "/agents" });
          await scope.register(sessionRoutes, { prefix: "/agents" });
          await scope.register(chatRoutes, { prefix: "/chats" });
          await scope.register(chatCronJobRoutes, { prefix: "/chats" });
          await scope.register(cronJobRoutes, { prefix: "/cron-jobs" });
          await scope.register(clientRoutes, { prefix: "/clients" });
          await scope.register(resourceRoutes, { prefix: "/resources" });
          await scope.register(gitlabConnectionRoutes, { prefix: "/gitlab-connections" });
          await scope.register(gitlabIdentityLinkRoutes, { prefix: "/gitlab-identity-links" });
          if (config.docs.enabled) {
            await scope.register(documentRoutes, { prefix: "/documents" });
            await scope.register(documentCommentRoutes, { prefix: "/document-comments" });
          }
        }),
        { prefix: "" },
      );

      // ── Class D — agent runtime self ────────────────────────────────────
      await api.register(
        agentScope("agentRuntimeScope", async (scope) => {
          await scope.register(agentMeRoutes);
          await scope.register(agentChatRoutes, { prefix: "/chats" });
          await scope.register(agentContextReviewRunRoutes, { prefix: "/chats" });
          await scope.register(agentGithubTaskRunRoutes, { prefix: "/chats" });
          await scope.register(agentMessageRoutes, { prefix: "/chats" });
          await scope.register(agentCronJobRoutes, { prefix: "/chats" });
          await scope.register(agentInboxRoutes, { prefix: "/inbox" });
          await scope.register(agentRuntimeConfigRoutes);
          await scope.register(agentFeishuRoutes);
          await scope.register(agentContextTreeInfoRoutes);
          await scope.register(agentContextTreeIoRoutes);
          if (config.docs.enabled) {
            await scope.register(agentDocumentRoutes);
          }
        }),
        { prefix: "/agent" },
      );

      // Client WebSocket (Class D) — JWT first-frame `auth`, then
      // client:register + per-agent bind. Inbox notifications fan out here.
      await api.register(clientWsRoutes(notifier, config.instanceId), { prefix: "/agent/ws" });
    }),
    { prefix: "/api/v1" },
  );

  // Serve Web static files
  const webDistPath = config.webDistPath;
  if (webDistPath) {
    const webRoot = resolve(webDistPath);
    if (existsSync(webRoot)) {
      await app.register(fastifyStatic, { root: webRoot });
      app.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith("/api/")) {
          return reply.status(404).send({ error: "Not found" });
        }
        const requestPath = request.url.split("?")[0] ?? request.url;
        if (requestPath.startsWith("/assets/") || extname(requestPath).length > 0) {
          return reply.status(404).send({ error: "Not found" });
        }
        // SPA fallback: serve index.html for non-API routes
        return reply.sendFile("index.html");
      });
    }
  }

  // Decorate notifier so routes can trigger PG NOTIFY
  app.decorate("notifier", notifier);

  // Background tasks
  const backgroundTasks = createBackgroundTasks(app, config.instanceId, options.backgroundTasks);

  // NC1 pulse aggregator — 32-bucket rolling window over runtime state
  // transitions. Broadcasts a per-org `pulse:tick` frame every 5s to admin
  // sockets. Lifecycle aligned with backgroundTasks via the onReady/onClose
  // hooks below.
  const pulseAggregator = createPulseAggregator({ notifier, broadcast: broadcastToAdmins });

  // Chat-first workspace cross-process kick. The message hot path calls
  // `fireChatMessageKick(chatId, messageId)` after each tx commits; we
  // forward that to the live notifier so it ends up on the
  // `chat_message_events` channel.
  registerChatMessageDispatcher((chatId, messageId) => {
    notifier
      .notifyChatMessage(chatId, messageId)
      .catch((err) => createLogger("chat-message-kick").warn({ err, chatId, messageId }, "chat:message kick failed"));
  });
  // Cross-replica chat-audience invalidation. Membership-mutation paths call
  // `invalidateChatAudience`, which fans out through this dispatcher; every
  // replica's listener (below) drops its local audience cache so none keeps
  // serving a stale audience that would drop `chat:message` pushes to a
  // just-added member for up to the cache TTL.
  registerChatAudienceDispatcher((chatId) => {
    notifier
      .notifyChatAudience(chatId)
      .catch((err) => createLogger("chat-audience-kick").warn({ err, chatId }, "chat:audience kick failed"));
  });
  notifier.onChatAudience(({ chatId }) => invalidateChatAudienceLocal(chatId));
  // Start notifier and background tasks on server start.
  app.addHook("onReady", async () => {
    // Ensure the default organization exists (idempotent)
    await ensureDefaultOrganization(db);
    const mirrorRepair = await repairMembershipHumanMirrors(db);
    const repaired = mirrorRepair.activeMirrorsRepaired + mirrorRepair.inactiveMirrorsRepaired;
    if (repaired > 0) {
      app.log.info({ ...mirrorRepair }, "membership human mirrors repaired");
    }
    await backfillResourcesPhase1(db).catch((err) => {
      app.log.warn({ err }, "resources phase1 backfill failed");
    });
    await backfillExternalAttachmentsToPostgres(db, attachmentBlobStore).catch((err) => {
      app.log.warn({ err }, "legacy S3 attachment reverse backfill failed");
    });
    await backfillSkillResourceBundles(db, attachmentBlobStore, {
      maxOrganizationAttachments: config.attachments.organizationObjectQuota,
    }).catch((err) => {
      app.log.warn({ err }, "legacy Skill bundle backfill failed");
    });
    const gitlabAttentionBackfill = await backfillGitlabAttentionPairs(db);
    if (gitlabAttentionBackfill.paired > 0 || gitlabAttentionBackfill.legacyRouteOnly > 0) {
      app.log.info(gitlabAttentionBackfill, "gitlab attention pair backfill complete");
    }
    await notifier.start();
    backgroundTasks.start();
    pulseAggregator.start();
    commandVersionPoller.start();
    feishuIntegration.start();
  });

  // Cleanup on close
  app.addHook("onClose", async () => {
    commandVersionPoller.stop();
    await feishuIntegration.stop();
    pulseAggregator.stop();
    await backgroundTasks.stop();
    await notifier.stop();
    await listenClient.end();
    await db.end();
  });

  return app;
}

export function formatHttpSpanName(request: { method?: string; url: string; routeOptions?: { url?: string } }): string {
  const route = request.routeOptions?.url;
  const method = request.method ?? "GET";
  if (route) return `${method} ${route}`;
  const pathOnly = request.url.split("?")[0] ?? request.url;
  return `${method} ${redactUrl(pathOnly)}`;
}
