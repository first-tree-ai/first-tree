import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import type { Config } from "../config.js";
import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS, securityHeadersHook } from "../security-headers.js";

/**
 * Issue #1541 / audit SEC-041: the repo must carry an app-wide browser
 * security header layer that is visible in code and testable — SPA shell,
 * static assets, and API JSON all included.
 */

const baseConfig: Config = {
  channel: "dev",
  growth: {
    landingPagesEnabled: false,
    landingCampaignMaxAgentTurns: 1,
    landingCampaignMaxEstimatedTokens: 120_000,
    landingCampaignMaxTrialsPerUserPer24Hours: 5,
  },
  docs: { enabled: false },
  database: { url: process.env.DATABASE_URL ?? "", provider: "external" },
  server: { port: 0, host: "127.0.0.1", publicUrl: undefined },
  workspace: { root: "/tmp/first-tree-test-workspaces" },
  secrets: {
    jwtSecret: "test-jwt-secret-key-for-vitest",
    encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  },
  auth: { accessTokenExpiry: "30m", refreshTokenExpiry: "30d", connectTokenExpiry: "10m" },
  trustProxy: false,
  connectBootstrap: {
    portableDownloadBaseUrl: "https://download.first-tree.ai/releases",
  },
  observability: { logging: { level: "error", format: "json", bridgeToSpanLevel: "off" } },
  runtime: {
    agentHttpTokenEnforcement: false,
    runtimeSwitchFaultInjection: false,
    pollingIntervalSeconds: 5,
    presenceCleanupSeconds: 60,
    archiveSweepIntervalSeconds: 0,
    archiveMappedIdleSeconds: 60 * 60,
    notificationWebhookUrl: undefined,
  },
  update: {
    commandVersion: "test.version",
    pollIntervalMinutes: 1440,
    registryUrl: "https://localhost.invalid",
  },
  instanceId: "test-instance",
};

async function safeClose(app: FastifyInstance | undefined) {
  if (app) await app.close();
}

function expectSecurityHeaders(headers: Record<string, unknown>) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    expect(headers[name], `missing ${name}`).toBe(value);
  }
}

describe("security header policy", () => {
  it("covers every header the audit listed as the minimum", () => {
    expect(Object.keys(SECURITY_HEADERS).sort()).toEqual(
      [
        "content-security-policy",
        "strict-transport-security",
        "x-content-type-options",
        "referrer-policy",
        "x-frame-options",
        "permissions-policy",
      ].sort(),
    );
    expect(SECURITY_HEADERS["x-content-type-options"]).toBe("nosniff");
    expect(SECURITY_HEADERS["strict-transport-security"]).toContain("max-age=");
    expect(SECURITY_HEADERS["x-frame-options"]).toBe("DENY");
  });

  it("builds a CSP that disallows framing but keeps the SPA functional", () => {
    const directives = Object.fromEntries(
      CONTENT_SECURITY_POLICY.split("; ").map((d) => {
        const [name, ...rest] = d.split(" ");
        return [name, rest.join(" ")];
      }),
    );
    // The audit's core asks: no framing, no plugins/objects, locked base/URL form targets.
    expect(directives["default-src"]).toBe("'self'");
    expect(directives["frame-ancestors"]).toBe("'none'");
    expect(directives["object-src"]).toBe("'none'");
    expect(directives["base-uri"]).toBe("'self'");
    expect(directives["form-action"]).toBe("'self'");
    // The SPA's reality: inline bootstrap scripts in index.html plus the
    // GA4 / Clarity tags they inject must keep working (nonce hardening is
    // future work — see security-headers.ts).
    expect(directives["script-src"]).toContain("'unsafe-inline'");
    expect(directives["script-src"]).toContain("https://www.googletagmanager.com");
    expect(directives["script-src"]).toContain("https://www.clarity.ms");
    // Same-origin API + WebSocket, analytics collect, optional Sentry.
    expect(directives["connect-src"]).toContain("'self'");
    expect(directives["connect-src"]).toContain("wss:");
    expect(directives["connect-src"]).toContain("https://*.google-analytics.com");
    expect(directives["connect-src"]).toContain("https://*.clarity.ms");
    expect(directives["connect-src"]).toContain("https://*.ingest.sentry.io");
  });
});

describe("securityHeadersHook", () => {
  it("does not override a header a route set itself", async () => {
    const app = Fastify();
    try {
      app.addHook("onSend", securityHeadersHook);
      app.get("/custom", (_req, reply) => {
        void reply.header("x-frame-options", "SAMEORIGIN");
        return { ok: true };
      });
      const res = await app.inject({ method: "GET", url: "/custom" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
      // …while the rest of the set is still filled in around it.
      expect(res.headers["content-security-policy"]).toBe(SECURITY_HEADERS["content-security-policy"]);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    } finally {
      await app.close();
    }
  });
});

describe("buildApp — app-wide security headers", () => {
  it("stamps the full set on the SPA shell, static misses, and API responses", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "first-tree-web-"));
    await writeFile(join(webRoot, "index.html"), "<!doctype html><html><body>App shell</body></html>", "utf8");

    let app: FastifyInstance | undefined;
    try {
      app = await buildApp({ ...baseConfig, webDistPath: webRoot });

      const spa = await app.inject({ method: "GET", url: "/workspace/deep-link" });
      expect(spa.statusCode).toBe(200);
      expectSecurityHeaders(spa.headers);

      const apiMiss = await app.inject({ method: "GET", url: "/api/missing" });
      expect(apiMiss.statusCode).toBe(404);
      expectSecurityHeaders(apiMiss.headers);

      const healthz = await app.inject({ method: "GET", url: "/healthz" });
      expect(healthz.statusCode).toBe(200);
      expectSecurityHeaders(healthz.headers);
    } finally {
      await safeClose(app);
      await rm(webRoot, { recursive: true, force: true });
    }
  });
});
