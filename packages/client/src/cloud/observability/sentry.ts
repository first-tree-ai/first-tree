import * as os from "node:os";
import { defaultDataDir, defaultHome } from "@first-tree/shared/config";
import { LOG_REDACT_CENSOR, redactCredentialText } from "@first-tree/shared/observability";
import * as Sentry from "@sentry/node";
import { createLogger } from "./logger.js";

const DEFAULT_SAMPLE_RATE = 0.05;
const FALSE_VALUES = new Set(["0", "false", "off", "no"]);
const SENSITIVE_KEY_RE =
  /token|secret|password|credential|authorization|cookie|jwt|api[_-]?key|access[_-]?token|refresh[_-]?token/i;
const RUNTIME_CONTENT_KEY_RE = /prompt|model[_-]?output|tool[_-]?output|stdout|stderr|\binput\b|\boutput\b/i;
const USER_PATH_REPLACEMENT = "[LOCAL_PATH]";
const LOG = createLogger("Sentry");

type ClientSentryConfig = {
  enabled: boolean;
  dsn?: string;
  environment: string;
  release: string;
  gitSha: string;
  sampleRate: number;
};

export function resolveClientSentryConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { defaultDsn?: string; gitSha?: string } = {},
): ClientSentryConfig {
  const dsn =
    env.FIRST_TREE_CLIENT_SENTRY_DSN?.trim() || env.SENTRY_DSN?.trim() || options.defaultDsn?.trim() || undefined;
  const rawEnabled = env.FIRST_TREE_CLIENT_SENTRY_ENABLED?.trim().toLowerCase();
  const gitSha =
    env.FIRST_TREE_GIT_SHA?.trim() ||
    env.FIRST_TREE_CLIENT_GIT_SHA?.trim() ||
    options.gitSha?.trim() ||
    env.GITHUB_SHA?.trim() ||
    "unknown";
  return {
    enabled: rawEnabled ? !FALSE_VALUES.has(rawEnabled) : Boolean(dsn),
    dsn,
    environment:
      env.FIRST_TREE_CLIENT_SENTRY_ENVIRONMENT?.trim() ||
      env.FIRST_TREE_SENTRY_ENVIRONMENT?.trim() ||
      env.NODE_ENV?.trim() ||
      "development",
    release:
      env.FIRST_TREE_CLIENT_SENTRY_RELEASE?.trim() ||
      env.SENTRY_RELEASE?.trim() ||
      (gitSha === "unknown" ? "first-tree-client@unknown" : `first-tree-client@${gitSha}`),
    gitSha,
    sampleRate: parseSampleRate(env.FIRST_TREE_CLIENT_SENTRY_TRACES_SAMPLE_RATE, DEFAULT_SAMPLE_RATE),
  };
}

export function initClientSentry(options: { defaultDsn?: string; version?: string; gitSha?: string } = {}): void {
  const config = resolveClientSentryConfig(process.env, { defaultDsn: options.defaultDsn, gitSha: options.gitSha });
  if (!config.enabled || !config.dsn) {
    if (process.env.FIRST_TREE_CLIENT_SENTRY_ENABLED) {
      LOG.info({ enabled: config.enabled, hasDsn: Boolean(config.dsn) }, "client sentry skipped by configuration");
    }
    return;
  }

  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    tracesSampleRate: config.sampleRate,
    sendDefaultPii: false,
    maxBreadcrumbs: 0,
    beforeSend(event) {
      return sanitizeClientSentryEvent(event, config);
    },
    beforeSendTransaction(event) {
      return sanitizeClientSentryEvent(event, config);
    },
  });

  Sentry.setTag("first_tree.surface", "client");
  Sentry.setTag("first_tree.git_sha", config.gitSha);
  if (options.version) Sentry.setTag("first_tree.cli_version", options.version);
  LOG.info({ environment: config.environment, release: config.release }, "client sentry initialized");
}

export function captureClientException(error: unknown, context?: Record<string, unknown>): string | undefined {
  if (!Sentry.isEnabled()) return undefined;
  return Sentry.withScope((scope) => {
    if (context) {
      scope.setContext("first_tree", sanitizeObject(context) as Record<string, unknown>);
    }
    return Sentry.captureException(error);
  });
}

export async function flushClientSentry(timeoutMs = 2_000): Promise<boolean> {
  if (!Sentry.isEnabled()) return true;
  return Sentry.flush(timeoutMs);
}

export function sanitizeClientSentryEvent<T extends Sentry.Event>(event: T, config: ClientSentryConfig): T {
  event.tags = {
    ...event.tags,
    "first_tree.surface": "client",
    "first_tree.git_sha": config.gitSha,
  };
  event.user = undefined;
  event.request = sanitizeRequest(event.request);
  event.contexts = scrubValue(event.contexts) as T["contexts"];
  event.extra = scrubValue(event.extra) as T["extra"];
  event.breadcrumbs = undefined;
  event.exception = scrubValue(event.exception) as T["exception"];
  if (event.transaction) event.transaction = sanitizeString(event.transaction);
  return event;
}

function sanitizeRequest(request: Sentry.Event["request"]): Sentry.Event["request"] {
  if (!request) return request;
  return {
    ...request,
    url: sanitizeUrl(request.url),
    headers: sanitizeHeaders(request.headers),
    cookies: undefined,
    query_string: undefined,
    data: undefined,
  };
}

type SentryRequest = NonNullable<Sentry.Event["request"]>;

function sanitizeHeaders(headers: SentryRequest["headers"]): SentryRequest["headers"] {
  if (!headers || typeof headers !== "object") return headers;
  const sanitized = sanitizeObject(headers);
  return typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)
    ? Object.fromEntries(Object.entries(sanitized).map(([key, value]) => [key, String(value)]))
    : headers;
}

function sanitizeObject(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY_RE.test(key) || RUNTIME_CONTENT_KEY_RE.test(key) ? LOG_REDACT_CENSOR : scrubValue(item);
  }
  return out;
}

function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item));
  return sanitizeObject(value);
}

function sanitizeUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    // `user:password@host` is a credential in its own right — PAT-bearing git
    // remotes and database connection strings both put one there, and dropping
    // only the query string left it intact (SEC-033).
    parsed.username = "";
    parsed.password = "";
    parsed.pathname = sanitizeString(parsed.pathname);
    return parsed.toString();
  } catch {
    return sanitizeString(stripUrlSuffix(url));
  }
}

function stripUrlSuffix(url: string): string {
  const queryIndex = url.indexOf("?");
  const hashIndex = url.indexOf("#");
  const cutIndex = queryIndex === -1 ? hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
  return cutIndex === -1 ? url : url.slice(0, cutIndex);
}

function sanitizeString(value: string): string {
  let sanitized = value;
  for (const path of localPathRedactionRoots()) {
    sanitized = redactUserPath(sanitized, path);
  }
  // One shared credential pass. The previous local regexes only knew Bearer and
  // a few `key=value` names, so vendor tokens (GitHub/AWS/OpenAI/Anthropic/
  // Slack) and URL userinfo reached Sentry untouched (SEC-033). `shared` owns
  // that pattern set; `cloud` may not import `runtime` (directory boundary
  // guard), and duplicating the patterns there is how the two drifted apart.
  return redactCredentialText(sanitized).replace(
    /((?:prompt|model output|tool output|stdout|stderr)\s*[:=]\s*)([^\n\r]+)/gi,
    `$1${LOG_REDACT_CENSOR}`,
  );
}

function localPathRedactionRoots(): string[] {
  const paths = [os.homedir(), process.cwd(), process.env.FIRST_TREE_HOME, safeDefaultHome(), safeDefaultDataDir()];
  return Array.from(new Set(paths.filter((path): path is string => Boolean(path))));
}

function safeDefaultHome(): string | undefined {
  try {
    return defaultHome();
  } catch {
    return undefined;
  }
}

function safeDefaultDataDir(): string | undefined {
  try {
    return defaultDataDir();
  } catch {
    return undefined;
  }
}

function redactUserPath(value: string, path: string): string {
  if (!path || path === "/" || path.length < 3) return value;
  return value.split(path).join(USER_PATH_REPLACEMENT);
}

function parseSampleRate(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return fallback;
  return parsed;
}
