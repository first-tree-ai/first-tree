import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

/**
 * Default TTL for the cached database probe result. Bounds `/healthz` database
 * round trips to at most one `SELECT 1` per window regardless of request
 * volume, while staying far finer-grained than orchestrator probe cadence
 * (the image `HEALTHCHECK` polls every 30s).
 */
export const DEFAULT_PROBE_CACHE_TTL_MS = 5_000;

export type HealthzOptions = {
  /**
   * TTL in milliseconds for the cached database probe result.
   * `0` disables caching and probes the database on every request.
   */
  probeCacheTtlMs?: number;
};

/**
 * Root-level health check endpoint for container orchestration.
 * Returns 200 when healthy, 503 when degraded.
 * Used by Docker HEALTHCHECK, Railway, Fly.io, Kubernetes liveness/readiness probes.
 *
 * The endpoint is public and deliberately keeps `rateLimit: false` so
 * orchestrator probes can never be rejected with 429. Database pressure is
 * bounded instead: the `SELECT 1` probe result (healthy or not) is cached for
 * a short TTL and concurrent requests share a single in-flight probe, so
 * public traffic or aggressive probing cannot translate into unlimited
 * database round trips — including while the database is already unhealthy.
 */
export async function healthzRoutes(app: FastifyInstance, opts: HealthzOptions = {}): Promise<void> {
  const probeCacheTtlMs = opts.probeCacheTtlMs ?? DEFAULT_PROBE_CACHE_TTL_MS;

  let cached: { healthy: boolean; expiresAt: number } | null = null;
  let inflight: Promise<boolean> | null = null;

  const probeDatabase = (): Promise<boolean> => {
    if (inflight === null) {
      inflight = app.db
        .execute(sql`SELECT 1`)
        .then(
          () => true,
          () => false,
        )
        .then((healthy) => {
          cached = { healthy, expiresAt: Date.now() + probeCacheTtlMs };
          inflight = null;
          return healthy;
        });
    }
    return inflight;
  };

  app.get("/healthz", { config: { rateLimit: false } }, async (_request, reply) => {
    const healthy = cached !== null && Date.now() < cached.expiresAt ? cached.healthy : await probeDatabase();
    if (healthy) return reply.status(200).send({ status: "ok" });
    return reply.status(503).send({ status: "error", message: "database unreachable" });
  });
}
