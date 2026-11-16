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

/** Path segments that mark an OAuth callback route (`/api/v1/auth/…`, `/oauth/…`). */
const OAUTH_CALLBACK_SEGMENTS: ReadonlySet<string> = new Set(["auth", "oauth"]);

const REDACTED = "***";

/**
 * Decode one URL component the way the HTTP layer does before routing.
 *
 * Fastify hands handlers the *decoded* path and parameter names, so `%61uth` is
 * `auth` to the route and `?%74oken=…` is `token`. Redaction has to classify the
 * same values, otherwise a client can keep a credential out of the log line
 * while the server still acts on it. Malformed escapes return `null` and the
 * caller falls back to the raw text, which is the previous behaviour.
 */
function decodeComponent(component: string): string | null {
  try {
    return decodeURIComponent(component);
  } catch {
    return null;
  }
}

/** Same, for query keys: `+` is a space in form-encoded queries. */
function decodeQueryKey(key: string): string | null {
  return decodeComponent(key.replace(/\+/gu, " "));
}

/**
 * Routes whose **next** path segment is itself a capability token.
 *
 * `/api/v1/webhooks/gitlab/:bearer` authenticates the caller by the URL alone,
 * and `/api/v1/invitations/:token/preview` is the public join link: in both the
 * segment is the capability, not an id, so a log line that keeps it keeps a
 * working credential (SEC-019).
 *
 * Expressed as segment runs rather than a regex over the raw path so the match
 * uses the router's decoded identity: `/api/v1/%69nvitations/<token>` reaches
 * the same handler and must redact the same way.
 */
const CAPABILITY_ROUTES: ReadonlyArray<readonly string[]> = [
  ["api", "v1", "webhooks", "gitlab"],
  ["api", "v1", "invitations"],
];

/**
 * Replace sensitive URL parts with `***`, preserving the route and every safe
 * parameter so a log line still identifies the request.
 *
 * Two shapes are masked: capability tokens that live in a path segment (see
 * `CAPABILITY_ROUTES`), and query values whose key is in `REDACT_QUERY_KEYS`.
 *
 * Classification uses decoded components, because that is what the router
 * matches; **emission uses the original bytes**, so a percent-encoded path or an
 * unusual key spelling still appears exactly as it arrived. The query is walked
 * by `&` then by the **first** `=`; the value is never inspected, so
 * `?organizationId=019dfb...` is preserved regardless of how the value happens
 * to look.
 */
export function redactUrl(url: string): string {
  const queryIndex = url.indexOf("?");
  const rawPath = queryIndex === -1 ? url : url.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? null : url.slice(queryIndex + 1);

  const maskedPath = maskCapabilitySegments(rawPath);
  if (rawQuery === null) return maskedPath;
  // Preserve a bare trailing `?`: it is structure, not a credential.
  if (rawQuery.length === 0) return `${maskedPath}?`;

  const oauthCallback = isOAuthCallbackPath(rawPath);
  const redacted = rawQuery
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
  return `${maskedPath}?${redacted}`;
}

/** Decoded path segments, falling back to the raw text per segment. */
function decodedPathSegments(rawPath: string): string[] {
  return rawPath.split("/").map((segment) => decodeComponent(segment) ?? segment);
}

/**
 * Mask the token segment of every capability route.
 *
 * Works on the split segments so only the token is replaced: every other byte of
 * the path keeps its original spelling.
 */
function maskCapabilitySegments(rawPath: string): string {
  const segments = rawPath.split("/");
  const decoded = segments.map((segment) => decodeComponent(segment) ?? segment);

  for (const route of CAPABILITY_ROUTES) {
    for (let start = 0; start + route.length < decoded.length; start += 1) {
      if (!route.every((name, offset) => decoded[start + offset] === name)) continue;
      const tokenIndex = start + route.length;
      // `/api/v1/invitations` and `/api/v1/invitations/` name no token.
      if ((decoded[tokenIndex] ?? "") === "") continue;
      segments[tokenIndex] = REDACTED;
    }
  }
  return segments.join("/");
}

/** True when any decoded segment names the auth/oauth surface. */
function isOAuthCallbackPath(rawPath: string): boolean {
  return decodedPathSegments(rawPath).some((segment) => OAUTH_CALLBACK_SEGMENTS.has(segment));
}
