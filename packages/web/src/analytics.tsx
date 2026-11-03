import { useEffect } from "react";
import { useLocation } from "react-router";

/**
 * GA4 analytics for the cloud SPA. The gtag bootstrap + config live in
 * public/browser-bootstrap.js (property G-BHG918MZ02, cross-domain linker,
 * send_page_view off). This module reports SPA navigations and exposes a typed
 * event helper.
 *
 * Why manual page_view: gtag fires page_view once on initial load. A
 * react-router app changes the URL without a full load, so without this every
 * post-login screen would be invisible. send_page_view is disabled in the
 * config so the first screen is reported here exactly once, not twice.
 *
 * Two hard rules enforced here (see the PR 1201 review):
 *  1. Production only. dev (127.0.0.1) and staging (dev.cloud.first-tree.ai)
 *     must NOT write into the shared production property, or they pollute the
 *     very attribution dataset this exists to make trustworthy.
 *  2. Never leak bearer-style URLs to GA. The SPA has routes whose hash or path
 *     carries credentials — /auth/github/complete#access=...&refresh=... and
 *     /invite/:token. We strip the hash and search, and template sensitive
 *     paths, before anything is sent.
 */

export const PROD_HOST = "cloud.first-tree.ai";

/** Only the production cloud host reports to the shared GA property. */
export function analyticsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.hostname === PROD_HOST;
}

/**
 * Map a raw pathname to a safe, credential-free path for analytics.
 * Sensitive routes are templated so no token/code reaches GA; everything else
 * passes through (the search string is dropped by the caller, not kept here).
 */
export function sanitizePath(pathname: string): string {
  // /invite/<token> -> /invite/[token]  (path-borne invite code)
  if (pathname.startsWith("/invite/")) return "/invite/[token]";
  // /auth/github/complete carries the OAuth token in the hash; report the
  // fixed path only. (Defense in depth — we also drop the hash below.)
  if (pathname.startsWith("/auth/github/complete")) {
    return "/auth/github/complete";
  }
  return pathname;
}

type GtagArgs =
  | [command: "config", targetId: string, config?: Record<string, unknown>]
  | [command: "event", eventName: string, params?: Record<string, unknown>]
  | [command: "set", params: Record<string, unknown>];

function gtag(...args: GtagArgs): void {
  if (!analyticsEnabled()) return;
  const w = window as unknown as { gtag?: (...a: GtagArgs) => void };
  // gtag is defined by browser-bootstrap.js; guard in case the script is absent
  // (e.g. an ad-blocker removed it) so analytics never breaks the app.
  w.gtag?.(...args);
}

/** Report a custom event. Use for conversions like sign_up. No PII in params. */
export function trackEvent(name: string, params?: Record<string, unknown>): void {
  gtag("event", name, params);
}

/**
 * Mount once inside <BrowserRouter>. Reports a page_view on every route
 * change, including the first render. Never sends the hash or query string,
 * and templates credential-bearing paths.
 */
export function RouteTracker(): null {
  const location = useLocation();
  useEffect(() => {
    const safePath = sanitizePath(location.pathname);
    gtag("event", "page_view", {
      page_path: safePath,
      // Reconstruct a clean location: origin + safe path only. Never the raw
      // href — that would carry the OAuth hash / invite token to GA.
      page_location: window.location.origin + safePath,
      page_title: document.title,
    });
  }, [location.pathname]);
  return null;
}
