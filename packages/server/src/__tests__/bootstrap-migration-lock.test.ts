import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { sslOptions } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";

/**
 * Pins the `hashtext('drizzle_migrations')` key used by
 * `acquireMigrationLock`. If a future drizzle bump changes the lock key,
 * this test stays green only as long as the constant matches the one we
 * hold here — meaning the replica lock and the holder both speak to the
 * same advisory-lock slot.
 *
 * Since PERF-027 the lock is held across the whole `migrate()` call, so
 * these cases cover both the contention timeout and the wait-then-proceed
 * serialization path. See `packages/server/src/db/migrate.ts`
 * `MIGRATION_LOCK_KEY_SQL` comment for the verification path through
 * drizzle-orm.
 */
describe("migration advisory lock (T10)", () => {
  const databaseUrl = process.env.DATABASE_URL;

  it("throws migration lock contention when another session holds hashtext('drizzle_migrations')", async () => {
    expect(databaseUrl, "DATABASE_URL must be set by global setup").toBeTruthy();
    const url = databaseUrl ?? "";

    // Hold the advisory lock from a separate session for the duration of
    // the test. `pg_advisory_lock` blocks if contested, but we're the only
    // contender so it returns immediately.
    const holder = postgres(url, { max: 1, ...sslOptions(url) });
    try {
      await holder`SELECT pg_advisory_lock(hashtext('drizzle_migrations'))`;

      // Use a tight 2s lock-wait timeout so the contention path completes
      // fast. The 15s production default is the right answer for boot, not
      // for a unit test that just needs to assert the error path.
      await expect(runMigrations(url, { lockTimeoutMs: 2_000 })).rejects.toThrow(/migration lock contention/);
    } finally {
      // Release the lock so subsequent test runs (and other test files in
      // the same worker process) aren't blocked.
      await holder`SELECT pg_advisory_unlock(hashtext('drizzle_migrations'))`;
      await holder.end();
    }
  });

  it("waits for a held lock and migrates after the holder releases (replica serialization)", async () => {
    expect(databaseUrl, "DATABASE_URL must be set by global setup").toBeTruthy();
    const url = databaseUrl ?? "";

    // Simulate the rollout race: another replica (holder) owns the lock
    // while this replica boots. runMigrations must wait — not error, not
    // proceed lock-free — and once the holder releases, the journal has
    // advanced so its own migrate is a cheap no-op.
    const holder = postgres(url, { max: 1, ...sslOptions(url) });
    try {
      await holder`SELECT pg_advisory_lock(hashtext('drizzle_migrations'))`;

      let settled = false;
      const pending = runMigrations(url, { lockTimeoutMs: 10_000 }).then(
        (tableCount) => {
          settled = true;
          return tableCount;
        },
        (error: unknown) => {
          settled = true;
          throw error;
        },
      );

      // 2s >> the 1s poll interval, so a working wait path cannot have
      // settled yet; a broken (lock-free) path settles within milliseconds.
      await new Promise((r) => setTimeout(r, 2_000));
      expect(settled, "runMigrations must keep waiting while another session holds the lock").toBe(false);

      await holder`SELECT pg_advisory_unlock(hashtext('drizzle_migrations'))`;

      const tableCount = await pending;
      expect(tableCount).toBeGreaterThan(0);
    } finally {
      // No-op if the test already unlocked (pg_advisory_unlock just returns
      // false); keeps the worker unblocked on assertion failures.
      await holder`SELECT pg_advisory_unlock(hashtext('drizzle_migrations'))`;
      await holder.end();
    }
  });

  it("succeeds when the advisory lock is free", async () => {
    expect(databaseUrl, "DATABASE_URL must be set by global setup").toBeTruthy();
    // Sanity case: with no holder, the lock is acquired fast and migrate runs.
    const tableCount = await runMigrations(databaseUrl ?? "");
    expect(tableCount).toBeGreaterThan(0);
  });
});
