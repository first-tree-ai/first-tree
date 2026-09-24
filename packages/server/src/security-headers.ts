import type { onSendHookHandler } from "fastify";

/**
 * App-wide browser security headers (issue #1541 / audit SEC-041).
 *
 * The server serves both the JSON API and the SPA from one Fastify instance,
 * but before this module the only security header anywhere was an
 * attachment-specific `X-Content-Type-Options` (api/attachments.ts). Anything
 * the edge (Cloudflare / CapRover) adds on top was invisible and untestable
 * from the repo. This hook makes the baseline contract code: every response —
 * SPA shell, static asset, API JSON, error page — carries the set below.
 *
 * The hook only fills headers the route has not set itself, so a route with a
 * deliberately different policy (none today) keeps its own value.
 */

/**
 * Content-Security-Policy for the SPA, built as an array so each directive
 * can carry its own rationale. Audit findings this answers:
 *
 *  - `default-src 'self'` — anything not listed below comes from our origin.
 *  - `script-src … 'unsafe-inline'` — packages/web/index.html ships three
 *    inline bootstrap scripts (GA4 loader, Clarity loader, theme init) and
 *    dynamically injects gtag.js / the Clarity tag from those two hosts.
 *    `'unsafe-inline'` keeps them working; moving to nonces means rewriting
 *    index.html per response and is deliberately out of scope here.
 *  - `style-src … 'unsafe-inline'` — React renders dynamic `style` attributes
 *    (style-src-attr falls back to style-src).
 *  - `img-src … https:` — chat markdown renders user-pasted external images;
 *    https-only blocks mixed content without breaking that content.
 *  - `font-src 'self'` — Inter / JetBrains Mono are self-hosted (see the
 *    <link rel="preload"> tags in index.html).
 *  - `connect-src` — same-origin REST + WebSocket (`ws:`/`wss:` for browsers
 *    that don't fold websockets into 'self'), GA4 collect, Clarity collect,
 *    and the optional Sentry browser SDK (VITE_SENTRY_DSN).
 *  - `frame-ancestors 'none'` — nothing legitimately frames the app (the
 *    first-tree.ai link on the login page is a plain anchor), so the
 *    authenticated dashboard must not be embeddable. Paired with
 *    `X-Frame-Options: DENY` for pre-CSP2 browsers.
 *  - `object-src 'none'` / `base-uri 'self'` / `form-action 'self'` — classic
 *    XSS escalation lids; the app uses none of these surfaces.
 */
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://www.clarity.ms",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self'",
  "connect-src 'self' ws: wss: https://*.google-analytics.com https://www.googletagmanager.com https://*.clarity.ms https://*.ingest.sentry.io https://*.ingest.us.sentry.io",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];

export const CONTENT_SECURITY_POLICY = CSP_DIRECTIVES.join("; ");

export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  // 2 years, subdomains included. No `preload`: list submission is a
  // separate, deliberate step. Harmless over plain HTTP (browsers ignore it).
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "x-content-type-options": "nosniff",
  // Matches the modern browser default, but pinned so it cannot drift with
  // client defaults: cross-origin requests leak origin only, never full URL.
  "referrer-policy": "strict-origin-when-cross-origin",
  // Redundant with CSP frame-ancestors for modern browsers; kept for legacy.
  "x-frame-options": "DENY",
  // The dashboard uses no sensor APIs; deny the noisy ones outright.
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/**
 * onSend hook — runs for every response the instance emits, including error
 * and not-found responses, which is exactly the "app-wide" coverage the
 * audit asked for. Registered on the root instance in buildApp.
 */
export const securityHeadersHook: onSendHookHandler = (_request, reply, _payload, done) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!reply.hasHeader(name)) reply.header(name, value);
  }
  done();
};
