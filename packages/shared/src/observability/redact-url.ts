/**
 * Query-parameter keys whose VALUES are replaced with `***` whenever a URL is
 * logged or stamped onto a span attribute.
 *
 * Mostly aligned with `LOG_REDACT_PATHS` so structured-log redaction (object
 * fields) and URL-string redaction (query parameters) share one vocabulary. The
 * deliberate exceptions are `code` and `state`: an OAuth callback can carry a
 * replayable pair, but the same names are extremely common as ordinary object
 * fields (`{ code: "ENOENT" }`), so they are redacted in URLs only.
 *
 * Comparison is case-sensitive. Every JWT-bearing URL in this codebase uses
 * the lowercase `?token=…` form (browser WebSocket can't set Authorization
 * headers, hence the query-param fallback in admin WS), so we trade the
 * safety of case-insensitive matching for a tighter implementation.
 */
export const REDACT_QUERY_KEYS: ReadonlySet<string> = new Set([
  "token",
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "jwt",
  "password",
  "secret",
  "api_key",
  "apiKey",
  "credentials",
  "authorization",
]);

/**
 * OAuth callback parameters: a `code` is exchangeable for an access token and
 * `state` is the anti-CSRF half of the pair, so both are credentials while the
 * callback is in flight (SEC-019).
 *
 * Scoped to auth routes rather than added to `REDACT_QUERY_KEYS`, because `state`
 * is also an ordinary session filter (`/agents/:uuid/sessions?state=active`) and
 * `code` is a common error field; masking them everywhere would trade a leak for
 * a diagnostic blackout.
 */
const OAUTH_CALLBACK_QUERY_KEYS: ReadonlySet<string> = new Set(["code", "state"]);

/** `/api/v1/auth/…`, `/oauth/…` — the only routes whose `code`/`state` are credentials. */
const OAUTH_CALLBACK_PATH_RE = /(?:\/auth\/|\/oauth\/)/u;

const REDACTED = "***";

/**
 * Decode a query key the way the HTTP layer does before routing.
 *
 * Fastify hands handlers the *decoded* parameter names, so `?%74oken=…` is
 * `token` to the route and must be redacted here too — otherwise a client can
 * keep a credential out of the log line while the server still reads it.
 * `+` is a space in form-encoded queries. Malformed escapes return `null` and
 * the caller falls back to matching the raw key, which is the previous
 * behaviour.
 */
function decodeQueryKey(key: string): string | null {
  try {
    return decodeURIComponent(key.replace(/\+/gu, " "));
  } catch {
    return null;
  }
}

/** Routes whose path segment is itself a capability token. */
const SECRET_PATH_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(\/api\/v1\/webhooks\/gitlab\/)[^/?#]+/g, `$1${REDACTED}`],
  // `/api/v1/invitations/:token/preview` is the public join link: the token is
  // the capability, not an id, so an access log line that keeps it keeps a
  // working invitation (SEC-019).
  [/(\/api\/v1\/invitations\/)[^/?#]+/g, `$1${REDACTED}`],
];

/**
 * Replace sensitive URL parts with `***`, preserving the route and every safe
 * parameter so a log line still identifies the request.
 *
 * Two shapes are masked: capability tokens that live in a path segment (see
 * `SECRET_PATH_PATTERNS`), and query values whose key is in `REDACT_QUERY_KEYS`.
 * The query is walked by `&` then by the **first** `=`; the key is decoded
 * (percent escapes and `+`, as the router does) and matched against the sets,
 * while the value is never inspected, so `?organizationId=019dfb...` is
 * preserved regardless of how the value happens to look — and so is the key's
 * original spelling.
 */
export function redactUrl(url: string): string {
  let pathRedacted = url;
  for (const [pattern, replacement] of SECRET_PATH_PATTERNS) {
    pathRedacted = pathRedacted.replace(pattern, replacement);
  }
  const qIdx = pathRedacted.indexOf("?");
  if (qIdx === -1) return pathRedacted;
  const path = pathRedacted.slice(0, qIdx);
  const query = pathRedacted.slice(qIdx + 1);
  const oauthCallback = OAUTH_CALLBACK_PATH_RE.test(path);
  if (query.length === 0) return pathRedacted;
  const redacted = query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      const key = pair.slice(0, eq);
      // Only the key is decoded: a sensitive pair is re-emitted with its value
      // replaced and every other byte of the URL left as it arrived.
      const keyName = decodeQueryKey(key) ?? key;
      const sensitive = REDACT_QUERY_KEYS.has(keyName) || (oauthCallback && OAUTH_CALLBACK_QUERY_KEYS.has(keyName));
      return sensitive ? `${key}=${REDACTED}` : pair;
    })
    .join("&");
  return `${path}?${redacted}`;
}
