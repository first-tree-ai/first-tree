import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sslOptions } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";

const LOCK_KEY_SQL = "hashtext('drizzle_migrations')";

/**
 * Pins the `hashtext('drizzle_migrations')` advisory lock that
 * `runMigrations` acquires and HOLDS for the entire migration (see
 * `packages/server/src/db/migrate.ts` `MIGRATION_LOCK_KEY_SQL`):
 *
 *   1. contention: an external holder makes `runMigrations` fail with a
 *      clear error after the timeout instead of running DDL in parallel;
 *   2. waiting: once the holder releases, a waiting replica acquires the
 *      lock and completes normally (journal no-op on an up-to-date DB);
 *   3. full-span locking: while drizzle `migrate()` is executing, no other
 *      session can grab the key — the startup-migration serialization that
 *      PERF-027 requires across replicas.
 */
describe("runMigrations advisory lock (T10 / PERF-027)", () => {
  const databaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    // No shared state between cases — each opens / closes its own postgres
    // client, and the lock is session-scoped so it goes away on .end().
  });

  it("throws migration lock contention when another session holds hashtext('drizzle_migrations')", async () => {
    expect(databaseUrl, "DATABASE_URL must be set by global setup").toBeTruthy();
    const url = databaseUrl ?? "";

    // Hold the advisory lock from a separate session for the duration of
    // the test. `pg_advisory_lock` blocks if contested, but we're the only
    // contender so it returns immediately.
    const holder = postgres(url, { max: 1, ...sslOptions(url) });
    try {
      await holder.unsafe(`SELECT pg_advisory_lock(${LOCK_KEY_SQL})`);

      // Use a tight 2s lock timeout so the contention path completes fast.
      // The 15s production default is the right answer for boot, not for a
      // unit test that just needs to assert the error path.
      await expect(runMigrations(url, { lockTimeoutMs: 2_000 })).rejects.toThrow(/migration lock contention/);
    } finally {
      // Release the lock so subsequent test runs (and other test files in
      // the same worker process) aren't blocked.
      await holder.unsafe(`SELECT pg_advisory_unlock(${LOCK_KEY_SQL})`);
      await holder.end();
    }
  });

  it("waits for a holder to release, then completes the migration", async () => {
    expect(databaseUrl, "DATABASE_URL must be set by global setup").toBeTruthy();
    const url = databaseUrl ?? "";

    // Simulate the multi-replica rollout: another "replica" owns the lock
    // when we start. runMigrations must poll (1s interval) rather than
    // fail immediately, and proceed once the owner releases.
    const holder = postgres(url, { max: 1, ...sslOptions(url) });
    let released = false;
    try {
      await holder.unsafe(`SELECT pg_advisory_lock(${LOCK_KEY_SQL})`);

      const waiter = runMigrations(url, { lockTimeoutMs: 10_000 });

      // Keep the lock across at least one poll cycle, then release. 1.5s
      // straddles the first retry so the waiter observes real contention.
      await new Promise((r) => setTimeout(r, 1_500));
      await holder.unsafe(`SELECT pg_advisory_unlock(${LOCK_KEY_SQL})`);
      released = true;

      // The DB is already migrated (template clone), so the waiter's
      // migrate() is a journal no-op — success here proves the waiting
      // path, not re-application.
      await expect(waiter).resolves.toBeGreaterThan(0);
    } finally {
      if (!released) {
        await holder.unsafe(`SELECT pg_advisory_unlock(${LOCK_KEY_SQL})`);
      }
      await holder.end();
    }
  });

  it("holds the advisory lock while drizzle migrate() is executing", async () => {
    expect(databaseUrl, "DATABASE_URL must be set by global setup").toBeTruthy();
    const url = databaseUrl ?? "";

    // Swap drizzle's migrate() for a probe that checks — from a SECOND
    // session — whether the lock is grabbable mid-migration. If the lock
    // were released before migrate() (the old preflight-then-unlock bug),
    // the probe would acquire it and this test would fail.
    let lockGrabbableDuringMigrate: boolean | undefined;
    vi.resetModules();
    vi.doMock("drizzle-orm/postgres-js/migrator", () => ({
      migrate: vi.fn(async () => {
        const probe = postgres(url, { max: 1, ...sslOptions(url) });
        try {
          const rows = (await probe.unsafe(`SELECT pg_try_advisory_lock(${LOCK_KEY_SQL}) AS acquired`)) as Array<{
            acquired: boolean;
          }>;
          lockGrabbableDuringMigrate = rows[0]?.acquired;
          if (lockGrabbableDuringMigrate) {
            // Never expected — but don't strand the lock if the invariant
            // breaks, or later cases in this worker would time out.
            await probe.unsafe(`SELECT pg_advisory_unlock(${LOCK_KEY_SQL})`);
          }
        } finally {
          await probe.end();
        }
      }),
    }));

    try {
      const { runMigrations: runMigrationsWithMockedMigrator } = await import("../db/migrate.js");
      const tableCount = await runMigrationsWithMockedMigrator(url);

      expect(lockGrabbableDuringMigrate).toBe(false);
      expect(tableCount).toBeGreaterThan(0);

      // And the lock must be released again once runMigrations returns
      // (session closed), so the next replica can proceed.
      const after = postgres(url, { max: 1, ...sslOptions(url) });
      try {
        const rows = (await after.unsafe(`SELECT pg_try_advisory_lock(${LOCK_KEY_SQL}) AS acquired`)) as Array<{
          acquired: boolean;
        }>;
        expect(rows[0]?.acquired).toBe(true);
        await after.unsafe(`SELECT pg_advisory_unlock(${LOCK_KEY_SQL})`);
      } finally {
        await after.end();
      }
    } finally {
      vi.doUnmock("drizzle-orm/postgres-js/migrator");
      vi.resetModules();
    }
  });

  it("succeeds when the advisory lock is free", async () => {
    expect(databaseUrl, "DATABASE_URL must be set by global setup").toBeTruthy();
    // Sanity case: with no holder, the lock is acquired fast and migrate runs.
    const tableCount = await runMigrations(databaseUrl ?? "");
    expect(tableCount).toBeGreaterThan(0);
  });
});
