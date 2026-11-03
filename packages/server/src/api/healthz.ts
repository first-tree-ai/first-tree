import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

/**
 * Root-level health check endpoint for container orchestration.
 * Returns 200 when healthy, 503 when degraded.
 * Used by Docker HEALTHCHECK, Railway, Fly.io, Kubernetes liveness/readiness probes.
 *
 * The endpoint is public, so the database probe is cached for
 * `DB_PROBE_CACHE_TTL_MS` and the route carries its own rate limit: public
 * traffic or aggressive probes must not create unbounded PostgreSQL round
 * trips (issue #1716).
 */

/**
 * How long a database probe result stays valid. Bounds round trips to at most
 * one probe per second per process regardless of request rate — including
 * when the database is down, since failures are cached too. The staleness is
 * negligible next to the 10s–30s cadence of typical probes (the Dockerfile
 * HEALTHCHECK polls every 30s).
 */
const DB_PROBE_CACHE_TTL_MS = 1_000;

type ProbeCache = {
  /** Last settled probe plus its expiry, or null before the first probe. */
  result: { healthy: boolean; expiresAt: number } | null;
  /** In-flight probe shared by concurrent requests (single-flight). */
  pending: Promise<boolean> | null;
};

export async function healthzRoutes(app: FastifyInstance): Promise<void> {
  // The cache lives in the registration closure, not at module scope: the app
  // registers this plugin once per process, and tests that register the route
  // repeatedly each get a fresh cache.
  const cache: ProbeCache = { result: null, pending: null };

  const probeDatabase = (): Promise<boolean> => {
    if (cache.result !== null && Date.now() < cache.result.expiresAt) {
      return Promise.resolve(cache.result.healthy);
    }
    if (cache.pending !== null) {
      return cache.pending;
    }
    const pending = app.db
      .execute(sql`SELECT 1`)
      .then(() => true)
      .catch(() => false)
      .then((healthy) => {
        cache.result = { healthy, expiresAt: Date.now() + DB_PROBE_CACHE_TTL_MS };
        cache.pending = null;
        return healthy;
      });
    cache.pending = pending;
    return pending;
  };

  app.get(
    "/healthz",
    // Independent cheap limit for this public endpoint: 120 req/min per key
    // (anonymous traffic keys on client IP) is ~2x the fastest reasonable
    // probe cadence (1s) while capping request volume far below the global
    // default of 3000/min.
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (_request, reply) => {
      if (await probeDatabase()) {
        return reply.status(200).send({ status: "ok" });
      }
      return reply.status(503).send({ status: "error", message: "database unreachable" });
    },
  );
}
