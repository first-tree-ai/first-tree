import type { FastifyInstance } from "fastify";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self' ws: wss: https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com https://*.clarity.ms https://c.bing.com https://*.ingest.sentry.io",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "img-src 'self' data: blob: https:",
  "manifest-src 'self'",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "script-src 'self' https://*.googletagmanager.com https://*.clarity.ms",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
].join("; ");

export const BROWSER_SECURITY_HEADERS = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

const BROWSER_SECURITY_HEADER_ENTRIES = Object.entries(BROWSER_SECURITY_HEADERS);

/**
 * Apply the browser security contract before any API or static-file route runs.
 * HSTS is sent on every response because browsers ignore it over plain HTTP;
 * this keeps the policy effective behind a TLS-terminating reverse proxy.
 */
export function registerBrowserSecurityHeaders(app: FastifyInstance): void {
  app.addHook("onRequest", (_request, reply, done) => {
    for (const [name, value] of BROWSER_SECURITY_HEADER_ENTRIES) {
      reply.header(name, value);
    }
    done();
  });
}
