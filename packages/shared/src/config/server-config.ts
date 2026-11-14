import { join } from "node:path";
import { z } from "zod";
import { logFormatSchema, logLevelSchema } from "../observability/logger-core.js";
import { CRON_POLLING_INTERVAL_MAX_SECONDS, CRON_POLLING_INTERVAL_MIN_SECONDS } from "../schemas/cron-job.js";
import { runtimeProviderSchema } from "../schemas/runtime-provider.js";
import { trustedInstallerUrlSchema } from "../url-policy.js";
import { defaultDataDir } from "./resolver.js";
import { defineConfig, field, optional } from "./schema.js";
import { getConfig } from "./singleton.js";
import type { InferConfig } from "./types.js";

const optionalTrimmedStringSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().min(1).optional());

const optionalUrlSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().url().optional());

const landingCampaignRuntimeProviderSchema = runtimeProviderSchema
  .refine((provider) => provider === "codex" || provider === "claude-code", {
    message: "Landing campaign runtime provider must be codex or claude-code",
  })
  .default("codex");

const gitlabExactOriginSchema = z.string().transform((raw, ctx) => {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      ctx.addIssue({
        code: "custom",
        message: "GitLab egress origin must be an exact credential-free HTTPS origin",
      });
      return z.NEVER;
    }
    return url.origin.toLowerCase();
  } catch {
    ctx.addIssue({ code: "custom", message: "GitLab egress origin must be a valid HTTPS origin" });
    return z.NEVER;
  }
});

function jsonEnvironmentArray<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }, schema);
}

const gitlabAllowedOriginsSchema = jsonEnvironmentArray(
  z.array(
    z.union([
      gitlabExactOriginSchema.transform((origin) => ({
        origin,
        addressPolicy: { kind: "public" as const },
      })),
      z
        .object({
          origin: gitlabExactOriginSchema,
          cidrs: z.array(z.string().trim().min(1)).min(1),
        })
        .strict()
        .transform(({ origin, cidrs }) => ({
          origin,
          addressPolicy: { kind: "cidrs" as const, cidrs },
        })),
    ]),
  ),
);

const googleOauthConfig = optional({
  clientId: field(z.string().min(1), { env: "FIRST_TREE_GOOGLE_CLIENT_ID" }),
  clientSecret: field(z.string().min(1), {
    env: "FIRST_TREE_GOOGLE_CLIENT_SECRET",
    secret: true,
  }),
});

function serverSecretOptions(env: string, auto: string, autoGenerateSecrets: boolean) {
  return autoGenerateSecrets ? { env, auto, secret: true } : { env, secret: true };
}

function serverSecretFields(autoGenerateSecrets: boolean) {
  return {
    jwtSecret: field(
      z.string().min(1),
      serverSecretOptions("FIRST_TREE_JWT_SECRET", "random:base64url:32", autoGenerateSecrets),
    ),
    encryptionKey: field(
      z.string().min(1),
      serverSecretOptions("FIRST_TREE_ENCRYPTION_KEY", "random:hex:32", autoGenerateSecrets),
    ),
  };
}

const authModeSchema = z.enum(["standard", "oidc-required"]).default("standard");

const oidcIssuerSchema = z
  .string()
  .min(1)
  .transform((raw, ctx) => {
    try {
      const url = new URL(raw);
      if (url.username || url.password || url.search || url.hash) {
        ctx.addIssue({ code: "custom", message: "OIDC issuer must have no userinfo, query, or fragment" });
        return z.NEVER;
      }
      // Return the exact configured issuer string unchanged (required by #2188).
      // Keycloak/Azure/GitLab IdPs use paths (e.g., https://idp.example.com/realms/foo).
      // This exact string must match discovery issuer and be stored in (issuer, sub).
      return raw;
    } catch {
      ctx.addIssue({ code: "custom", message: "OIDC issuer must be a valid URL" });
      return z.NEVER;
    }
  });

export const serverConfigSchema = defineConfig({
  /**
   * Which release channel this server speaks to. Single switch that drives
   * every CLI-facing identifier emitted by the server:
   *   - `prod`    → installs the portable `first-tree` binary
   *   - `staging` → installs the portable `first-tree-staging` binary
   *   - `dev`     → source-only `first-tree-dev` login command
   *
   * Set via `FIRST_TREE_CHANNEL` in the deployment env. Default `dev` makes
   * `pnpm --filter @first-tree/server dev` Just Work on a developer machine.
   *
   * See `packages/shared/src/channel/` for the full identity table.
   */
  channel: field(z.enum(["dev", "staging", "prod"]).default("dev"), {
    env: "FIRST_TREE_CHANNEL",
  }),
  growth: {
    /**
     * Enables the Cloud side of public growth funnels handed off from website
     * landing pages via `/quickstart?campaign=...`. This is a product feature
     * flag, not a release-channel property: dev/staging/prod all default to off
     * until an operator explicitly enables the funnel.
     */
    landingPagesEnabled: field(z.boolean().default(false), {
      env: "FIRST_TREE_GROWTH_LANDING_PAGES_ENABLED",
    }),
    /**
     * Maximum number of visible agent response turns allowed in a landing
     * campaign trial chat. Default 6 covers the full external production-scan
     * skill flow (calibration, scan report, fix offer, bounded follow-ups);
     * deployments can override in either direction.
     */
    landingCampaignMaxAgentTurns: field(z.number().int().min(1).max(20).default(6), {
      env: "FIRST_TREE_LANDING_CAMPAIGN_MAX_AGENT_TURNS",
    }),
    /**
     * Approximate token budget for each landing campaign trial chat. Successful
     * agent turns advance both the turn count and this metadata-backed estimate.
     */
    landingCampaignMaxEstimatedTokens: field(z.number().int().min(1).default(120_000), {
      env: "FIRST_TREE_LANDING_CAMPAIGN_MAX_ESTIMATED_TOKENS",
    }),
    /**
     * Maximum number of new landing campaign trial chats a user can create
     * across all organizations in a rolling 24-hour window. Idempotent starts
     * for an existing campaign/repo chat do not consume this quota.
     */
    landingCampaignMaxTrialsPerUserPer24Hours: field(z.number().int().min(1).default(5), {
      env: "FIRST_TREE_LANDING_CAMPAIGN_MAX_TRIALS_PER_USER_PER_24_HOURS",
    }),
    landingCampaigns: optional({
      /**
       * First Tree official service user that manages landing campaign trial
       * agents inside customer orgs. Optional at boot so the feature flag can
       * remain off by default; the start API checks the official service user,
       * service org, and client ids before creating anything.
       */
      serviceUserId: field(optionalTrimmedStringSchema, {
        env: "FIRST_TREE_LANDING_CAMPAIGN_SERVICE_USER_ID",
      }),
      /**
       * Organization where the official service user is a normal team member.
       * In every other org, that same user is treated as the campaign-managed
       * service membership created only to host landing trial agents.
       */
      serviceOrgId: field(optionalTrimmedStringSchema, {
        env: "FIRST_TREE_LANDING_CAMPAIGN_SERVICE_ORG_ID",
      }),
      /**
       * Official client row owned by `serviceUserId`. Trial agents are pinned
       * to this real client so chat/runtime/status use the native path.
       */
      clientId: field(optionalTrimmedStringSchema, {
        env: "FIRST_TREE_LANDING_CAMPAIGN_CLIENT_ID",
      }),
      /**
       * Runtime provider assigned to newly provisioned landing campaign trial
       * agents. The official client can advertise multiple providers; this
       * switch only selects which provider the server pins on the agent row.
       * Claude Code is accepted by config parsing but the start API remains
       * fail-closed until its workspace-only runtime path exists.
       */
      runtimeProvider: field(landingCampaignRuntimeProviderSchema, {
        env: "FIRST_TREE_LANDING_CAMPAIGN_RUNTIME_PROVIDER",
      }),
    }),
  },
  docs: {
    /**
     * Enables the document review (docloop) surface: the org document
     * library API, the `doc` CLI namespace endpoints, and (later) the web
     * Docs section. Product feature flag with a staging-first rollout —
     * off by default until an operator enables it.
     */
    enabled: field(z.boolean().default(false), {
      env: "FIRST_TREE_DOCS_ENABLED",
    }),
  },
  database: {
    url: field(z.string(), {
      env: "FIRST_TREE_DATABASE_URL",
      auto: "docker-pg",
      prompt: {
        message: "PostgreSQL:",
        type: "select",
        choices: [
          { name: "Auto-provision via Docker", value: "__auto__" },
          { name: "Provide connection URL", value: "__input__" },
        ],
      },
    }),
    provider: field(z.enum(["docker", "external"]).default("docker")),
  },
  /**
   * Attachment quotas. The per-file 10 MiB cap (`MAX_ATTACHMENT_BYTES`) and
   * the per-organization 2 GiB byte ceiling stay hard-coded; only the object
   * count is deployment-tunable.
   */
  attachments: {
    /**
     * Maximum number of attachment objects (rows in `uploading`, `ready`, or
     * `deleting` state) one organization may hold. The count covers every
     * creation path — chat uploads, Feishu inbound resources, Team Skill
     * bundle backfills, and Agent Template adoption copies all share the same
     * pool. Default 10,000; the 2 GiB byte quota remains the storage
     * backstop regardless of this value.
     */
    organizationObjectQuota: field(z.number().int().min(1).default(10_000), {
      env: "FIRST_TREE_ATTACHMENT_ORG_QUOTA_COUNT",
    }),
    /**
     * 14-day retention sweep for message-class attachments (chat images /
     * documents, Feishu inbound resources). Attachments held by a Team Skill
     * Resource or an Agent Template bundle never expire. The sweep runs once
     * at Server startup and then every 24 hours, and is a dry-run unless
     * deletion is explicitly enabled: dry-run only counts and logs eligible
     * rows, so operators can size the impact before flipping the switch.
     * Rollback means disabling deletion again — already-deleted bytes can
     * only be restored from a database backup.
     */
    retention: optional({
      /**
       * Master switch for real deletion. Unset / false = dry-run (count and
       * log only); true = actually delete expired rows and reclaim quota.
       */
      deleteEnabled: field(z.boolean().default(false), {
        env: "FIRST_TREE_ATTACHMENT_RETENTION_DELETE_ENABLED",
      }),
    }),
  },
  /**
   * Transitional read/delete compatibility for attachment payloads written
   * to S3 by #2062. New uploads are PostgreSQL-backed. This block can be
   * removed in the contract release after the reverse backfill completes and
   * every pre-transition Server replica has drained.
   */
  objectStorage: optional({
    bucket: field(z.string().trim().min(1), { env: "FIRST_TREE_OBJECT_STORAGE_BUCKET" }),
    region: field(z.string().trim().min(1).default("us-east-1"), {
      env: "FIRST_TREE_OBJECT_STORAGE_REGION",
    }),
    endpoint: field(optionalUrlSchema, { env: "FIRST_TREE_OBJECT_STORAGE_ENDPOINT" }),
    forcePathStyle: field(z.boolean().default(false), {
      env: "FIRST_TREE_OBJECT_STORAGE_FORCE_PATH_STYLE",
    }),
    accessKeyId: field(optionalTrimmedStringSchema, {
      env: "FIRST_TREE_OBJECT_STORAGE_ACCESS_KEY_ID",
      secret: true,
    }),
    secretAccessKey: field(optionalTrimmedStringSchema, {
      env: "FIRST_TREE_OBJECT_STORAGE_SECRET_ACCESS_KEY",
      secret: true,
    }),
    sessionToken: field(optionalTrimmedStringSchema, {
      env: "FIRST_TREE_OBJECT_STORAGE_SESSION_TOKEN",
      secret: true,
    }),
  }),
  server: {
    port: field(z.number().default(8000), { env: "FIRST_TREE_PORT" }),
    host: field(z.string().default("127.0.0.1"), { env: "FIRST_TREE_HOST" }),
    /**
     * Public-facing URL of this First Tree server. Required in production — used to:
     *   1. Stamp the issuer on short connect codes so exchange can reject codes
     *      presented to the wrong deployment.
     *   2. Build invite-link URLs surfaced to admins.
     *   3. Construct the OAuth callback URL the GitHub app redirects back to.
     * Dev environments may omit it — we fall back to the request's host header
     * for local quickstart, and the boot check below only fires when
     * `NODE_ENV === 'production'`.
     */
    publicUrl: field(z.string().optional(), { env: "FIRST_TREE_PUBLIC_URL" }),
  },
  workspace: {
    // Lazy default (function form): zod's `.default(value)` evaluates
    // `value` at schema-definition time, which would module-load-bake
    // `defaultDataDir()` against whatever `FIRST_TREE_HOME` happened to
    // be set when this file first loaded. `.default(() => ...)`
    // evaluates per parse instead, so the env is read at config-init
    // time — see `__tests__/no-toplevel-default-home-const.test.ts`
    // for the corresponding regression guard.
    root: field(
      z.string().default(() => join(defaultDataDir(), "workspaces")),
      { env: "FIRST_TREE_WORKSPACES_ROOT" },
    ),
  },
  secrets: serverSecretFields(true),
  /**
   * JWT lifetimes. All accept the `ms`-style format ("30m", "30d", "12h", …)
   * understood by `jose`'s `setExpirationTime`.
   *
   * Refresh tokens slide: every successful `/auth/refresh` issues a fresh
   * pair, so an active client never hits the absolute expiry. The default
   * 30d window is the safety net for clients that go offline for a while —
   * tighten it for high-security deployments, loosen for kiosk/lab boxes.
   */
  auth: {
    accessTokenExpiry: field(z.string().default("30m"), { env: "FIRST_TREE_AUTH_ACCESS_TOKEN_EXPIRY" }),
    refreshTokenExpiry: field(z.string().default("30d"), { env: "FIRST_TREE_AUTH_REFRESH_TOKEN_EXPIRY" }),
    connectTokenExpiry: field(z.string().default("10m"), { env: "FIRST_TREE_AUTH_CONNECT_TOKEN_EXPIRY" }),
  },
  access: optional({
    /**
     * Invite-only entry gate for hosted environments that should accept new
     * users only through one organization. Empty / whitespace disables it.
     */
    allowedOrganizationId: field(optionalTrimmedStringSchema, {
      env: "FIRST_TREE_ALLOWED_ORGANIZATION_ID",
    }),
  }),
  agentTemplates: optional({
    /**
     * Organization whose current active admins act as the official Agent
     * Template publisher. Only members of this Team may maintain the global
     * catalog, and official Skill bundles must be attachments owned by this
     * Team. Unset disables the publisher API (fail closed); the public
     * read-only catalog stays available.
     */
    publisherOrgId: field(optionalTrimmedStringSchema, {
      env: "FIRST_TREE_AGENT_TEMPLATE_PUBLISHER_ORG_ID",
    }),
  }),
  // Context Tree (repo / branch / localPath) and GitHub integration
  // (webhook secret / allowed org) used to live here as global config.
  // They are now per-org settings in the `organization_settings` table —
  // admins configure them through Team Settings. See issue #255.
  // The server-managed Context Tree mirror mints a per-org GitHub App
  // installation token at request time (see `services/github-app-token.ts`);
  // no global token belongs here.
  gitlab: optional({
    /**
     * Additional deployment-authorized GitLab origins. Public origins use a
     * string; private destinations attach explicit IPv4/IPv6 CIDRs.
     */
    egressAllowlist: field(gitlabAllowedOriginsSchema.optional(), {
      env: "FIRST_TREE_GITLAB_ALLOWED_ORIGINS",
    }),
  }),
  oauth: optional({
    ...({ google: googleOauthConfig } as { google?: typeof googleOauthConfig }),
    /**
     * GitHub App credentials. A single App installation simultaneously
     * unlocks user-OAuth, the webhook stream, and installation-token
     * minting. All five required fields must be set together; partial
     * configuration is rejected at boot for the same reason as the legacy
     * block — a half-wired App is worse than no App.
     *
     * Staging and prod each have a separate App with its own set of values;
     * the env file selects which to load.
     *
     * `privateKeyPem` is the raw PKCS#8 PEM (multi-line, starts with
     * `-----BEGIN PRIVATE KEY-----`). Self-hosters typically inline it via
     * a `.env` file with `\n` escapes; SaaS operators should source it
     * from their secret manager (a team-wide pattern is still TBD).
     */
    // `.min(1)` on every field: blank env values (empty string env
    // sets that resolve to `""` after substitution) must NOT make the
    // block resolve to a truthy object. The HMAC-empty-key forgery
    // path codex flagged (P1-8) trips exactly when `webhookSecret`
    // sneaks through as `""` — `createHmac("sha256", "")` is a valid
    // hash any attacker can reproduce. Same defense applies to all
    // five fields: empty appId would make App JWTs unverifiable
    // upstream, empty clientId would let GitHub round-trip an
    // anonymous OAuth, etc. Fail loud at Zod parse time.
    githubApp: optional({
      appId: field(z.string().min(1), { env: "FIRST_TREE_GITHUB_APP_ID" }),
      clientId: field(z.string().min(1), { env: "FIRST_TREE_GITHUB_APP_CLIENT_ID" }),
      clientSecret: field(z.string().min(1), {
        env: "FIRST_TREE_GITHUB_APP_CLIENT_SECRET",
        secret: true,
      }),
      privateKeyPem: field(z.string().min(1), {
        env: "FIRST_TREE_GITHUB_APP_PRIVATE_KEY",
        secret: true,
      }),
      webhookSecret: field(z.string().min(1), {
        env: "FIRST_TREE_GITHUB_APP_WEBHOOK_SECRET",
        secret: true,
      }),
      /**
       * The App's URL slug — the last path segment of
       * `https://github.com/apps/<slug>`. Used to build the
       * `installations/new` URL that surfaces GitHub's install dialog
       * (the OAuth `authorize` URL only triggers consent, never the
       * install picker, for users who haven't installed the App yet —
       * codex P1-1).
       *
       * Optional *within* the App block (unlike the five fields above):
       * the rest of the App surface — sign-in, webhook verification,
       * installation-token minting — works without it. Only the
       * "Install on GitHub" CTA in Settings needs the slug, and that
       * endpoint returns 503 when it's unset rather than blocking boot.
       */
      slug: field(z.string().min(1).optional(), { env: "FIRST_TREE_GITHUB_APP_SLUG" }),
    }),
  }),
  authMode: field(authModeSchema, { env: "FIRST_TREE_AUTH_MODE" }),
  oidc: optional({
    issuer: field(oidcIssuerSchema, { env: "FIRST_TREE_OIDC_ISSUER" }),
    clientId: field(z.string().min(1), { env: "FIRST_TREE_OIDC_CLIENT_ID" }),
    clientSecret: field(z.string().min(1), { env: "FIRST_TREE_OIDC_CLIENT_SECRET", secret: true }),
  }),
  cors: optional({
    origin: field(z.string(), { env: "FIRST_TREE_CORS_ORIGIN" }),
  }),
  /**
   * Trust upstream proxy headers (e.g. `x-forwarded-for`) for `req.ip`. Required
   * in production where First Tree sits behind Cloudflare / a reverse proxy — otherwise
   * unauthenticated rate-limit fallback keys resolve to the proxy. Default false;
   * safe for local development.
   */
  trustProxy: field(z.boolean().default(false), { env: "FIRST_TREE_TRUST_PROXY" }),
  connectBootstrap: {
    /**
     * Base URL for prod/staging portable installers and artifacts. Mirrors
     * may override it; dev remains source-only.
     */
    portableDownloadBaseUrl: field(trustedInstallerUrlSchema.default("https://download.first-tree.ai/releases"), {
      env: "FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL",
    }),
  },
  rateLimit: optional({
    /** Actor-aware global safety cap. High enough to avoid normal-use 429s. */
    max: field(z.number().default(3000), { env: "FIRST_TREE_RATE_LIMIT_MAX" }),
  }),
  ws: optional({
    /**
     * Maximum payload size (bytes) for a single WebSocket frame on the
     * client/admin sockets. Protects the server against single-frame OOM via a
     * malicious or buggy client. Default 256 KiB — large enough to fit
     * legitimate `session:event` frames whose `tool_call.payload.args` may
     * carry full file contents (Claude Code's Write/Edit `new_string`, Bash
     * heredoc payloads, MCP tools forwarding diffs/AST), while still bounding
     * worst-case memory per frame. Image content travels via HTTP, not WS.
     * Real OOM attackers send MB+, not KiB — this is a guardrail, not a DoS
     * shield. Tighten or loosen via `FIRST_TREE_WS_MAX_PAYLOAD` once we
     * have production P99 frame-size data.
     */
    maxPayload: field(z.number().int().min(1024).default(262_144), { env: "FIRST_TREE_WS_MAX_PAYLOAD" }),
  }),
  inbox: optional({
    /**
     * High-water fuse on per-agent in-flight (un-acked) `inbox:deliver`
     * frames. Normal fairness is enforced per `(agent, chat)` below; this
     * agent-wide value exists only to bound pathological recovery storms or a
     * badly stalled client. Once reached the server stops pushing for that
     * agent until an ack arrives — leftover entries stay `pending` in the DB
     * and get replayed via later backlog scans.
     *
     * The WS data plane is the only delivery path on this server build.
     */
    maxInFlightPerAgent: field(z.number().int().min(1).max(65_536).default(8192), {
      env: "FIRST_TREE_INBOX_MAX_IN_FLIGHT_PER_AGENT",
    }),
    /**
     * Fairness window for one agent in one chat. A stuck or very long turn may
     * fill this chat-local window, but it must not consume delivery capacity
     * for the same agent's other chats.
     */
    maxInFlightPerAgentChat: field(z.number().int().min(1).max(1024).default(8), {
      env: "FIRST_TREE_INBOX_MAX_IN_FLIGHT_PER_AGENT_CHAT",
    }),
  }),
  observability: {
    logging: {
      level: field(logLevelSchema.default("info"), {
        env: "FIRST_TREE_LOG_LEVEL",
      }),
      /**
       * Output format. Defaults to `json` in production and `pretty` elsewhere —
       * pretty is for humans, json is for log collectors (Loki, CloudWatch, Vector).
       */
      format: field(logFormatSchema.default(process.env.NODE_ENV === "production" ? "json" : "pretty")),
      /** Minimum pino level whose records are bridged onto the currently-active span. */
      bridgeToSpanLevel: field(z.enum(["error", "warn", "off"]).default("error")),
    },
    tracing: optional({
      /**
       * OTLP endpoint. Non-empty value enables tracing; empty string disables it.
       * There is deliberately no separate `enabled` flag — endpoint presence is the switch.
       */
      endpoint: field(z.string(), { env: "FIRST_TREE_OTEL_ENDPOINT" }),
      /**
       * Exporter headers, serialized as `key1=value1,key2=value2` (one string — avoids
       * env-var record coercion issues). Secret because it typically holds the write token.
       */
      headers: field(z.string().default(""), { env: "FIRST_TREE_OTEL_HEADERS", secret: true }),
      exporter: field(z.enum(["otlp-http", "otlp-grpc"]).default("otlp-http")),
      serviceName: field(z.string().default("first-tree")),
      /**
       * Deployment environment label. Emitted as the OTel resource attribute
       * `deployment.environment.name` — trace backends (Logfire, Honeycomb, …)
       * use this to let one project span many environments while still
       * letting you filter by env in the UI.
       */
      environment: field(z.string().default("development"), {
        env: "FIRST_TREE_OTEL_ENVIRONMENT",
      }),
      sampleRate: field(z.number().min(0).max(1).default(1)),
      /**
       * Whether to attach `client.ip` to HTTP root spans. **Off by default**
       * because First Tree is open-source and IP addresses are personal data under
       * GDPR — defaulting to capture would force every self-hosted operator
       * to think about deletion / retention. Operators who need IP-level
       * audit (rate-limit forensics, login brute-force investigation, etc.)
       * can opt in via the env var.
       *
       * `user-agent`, `referer`, `request.id`, `user.id` etc. are still
       * captured unconditionally — those are not PII identifiers on their
       * own and have high day-to-day debug value.
       */
      captureClientIp: field(z.boolean().default(false), {
        env: "FIRST_TREE_OTEL_CAPTURE_CLIENT_IP",
      }),
    }),
  },
  /**
   * Command-package version advertisement. The server broadcasts a version
   * string to every Client via `server:welcome` so clients can detect drift
   * and self-update. We resolve the value at runtime by polling the npm
   * registry for the configured channel's `latest` dist-tag — decoupling
   * "what version clients should run" from the server's own build/deploy
   * cadence (otherwise prod auto-update silently stalls whenever the
   * server image lags behind a fresh CLI publish).
   *
   * Multi-env: each channel (prod / staging) ships as its own npm package
   * with its own `latest` dist-tag, so the per-channel selection happens
   * via the top-level `channel` field above — there is no separate
   * `update.channel` knob anymore. dev servers (channel=dev) skip the
   * poll entirely (no published package to poll).
   *
   * - `commandVersion`: bootstrap fallback used until the first successful
   *   poll, and the cache value when the registry is unreachable.
   *   Docker images inject `apps/cli/package.json.version` at build
   *   time via the `COMMAND_VERSION` build-arg.
   * - `pollIntervalMinutes`: refresh cadence. 60 minutes is the safe default
   *   for both prod (slow stable cadence) and staging (frequent publishes
   *   still get picked up within an hour). Tune lower on staging for
   *   tighter rollout.
   * - `registryUrl`: lets corp deployments point at a Verdaccio/Artifactory
   *   mirror with the same dist-tags.
   */
  update: {
    commandVersion: field(z.string().optional(), {
      env: "FIRST_TREE_COMMAND_VERSION",
    }),
    pollIntervalMinutes: field(z.coerce.number().int().min(1).max(1440).default(60), {
      env: "FIRST_TREE_UPDATE_POLL_INTERVAL_MINUTES",
    }),
    registryUrl: field(z.string().url().default("https://registry.npmjs.org"), {
      env: "FIRST_TREE_UPDATE_REGISTRY_URL",
    }),
  },
  /**
   * Runtime tunables. Replaced the deleted `/admin/system/config` HTTP
   * surface (proposal hub-strip-jwt-ambient-scope §3.5) — these knobs are
   * deployment-level, not customer-tunable, and get baked in via the
   * deploy manifest (systemd / docker-compose / Fly.toml / Render env).
   */
  runtime: {
    /**
     * Local/test-only runtime-switch fault injection. When enabled, the
     * switch-runtime route accepts an explicit fault header so QA can
     * deterministically exercise claim abort and forward-recovery paths. The
     * default is off and production should leave it off.
     */
    runtimeSwitchFaultInjection: field(z.boolean().default(false), {
      env: "FIRST_TREE_RUNTIME_SWITCH_FAULT_INJECTION",
    }),
    pollingIntervalSeconds: field(
      z.coerce.number().int().min(CRON_POLLING_INTERVAL_MIN_SECONDS).max(CRON_POLLING_INTERVAL_MAX_SECONDS).default(5),
      {
        env: "FIRST_TREE_POLLING_INTERVAL_SECONDS",
      },
    ),
    presenceCleanupSeconds: field(z.coerce.number().int().positive().default(60), {
      env: "FIRST_TREE_PRESENCE_CLEANUP_SECONDS",
    }),
    /**
     * Chat auto-archive sweeper cadence. Set to 0 to disable the sweeper
     * (useful in tests and one-off CLI runs). Default 300s (5 min) sits
     * comfortably below the smallest idle threshold (1h) so worst-case
     * archive latency is bounded by the threshold plus one tick.
     */
    archiveSweepIntervalSeconds: field(z.coerce.number().int().nonnegative().default(300), {
      env: "FIRST_TREE_ARCHIVE_SWEEP_INTERVAL_SECONDS",
    }),
    /**
     * Idle threshold for SCM-originated chats. Mapped chats require all GitHub
     * mappings and active GitLab mappings to be closed/merged; no-mapping SCM
     * chats use this same threshold as an orphan/no-binding cleanup.
     */
    archiveMappedIdleSeconds: field(
      z.coerce
        .number()
        .int()
        .positive()
        .default(60 * 60),
      {
        env: "FIRST_TREE_ARCHIVE_MAPPED_IDLE_SECONDS",
      },
    ),
    /**
     * Optional outbound webhook URL — if set, every notification is
     * fire-and-forget POSTed here in JSON. Replaces the prior DB-backed
     * `notification_webhook_url` config row.
     */
    notificationWebhookUrl: field(z.string().url().optional(), {
      env: "FIRST_TREE_NOTIFICATION_WEBHOOK_URL",
    }),
  },
});

export type CreateServerConfigSchemaOptions = {
  /**
   * Local development can generate server secrets into server.yaml. Production
   * must receive stable operator-managed secrets so restarts and replicas keep
   * decrypting existing data.
   */
  autoGenerateSecrets?: boolean;
};

export function createServerConfigSchema(options: CreateServerConfigSchemaOptions = {}): typeof serverConfigSchema {
  const autoGenerateSecrets = options.autoGenerateSecrets ?? true;
  if (autoGenerateSecrets) return serverConfigSchema;
  return defineConfig({
    ...serverConfigSchema,
    secrets: serverSecretFields(false),
  });
}

export type ServerConfig = InferConfig<typeof serverConfigSchema>;

/** Typed accessor for server configuration singleton. */
export function getServerConfig(): ServerConfig {
  return getConfig<ServerConfig>();
}
