import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createLogger } from "../observability/index.js";
import { sslOptions } from "./connection.js";

const log = createLogger("Migrations");

/**
 * Resolve the drizzle migrations directory.
 *
 * Two layouts to support:
 *   - Built (Docker): `packages/server/dist/index.mjs` + `packages/server/drizzle/`
 *     → `../drizzle` from the bundled file.
 *   - Dev (tsx):      `packages/server/src/db/migrate.ts` + `packages/server/drizzle/`
 *     → `../../drizzle` from the source file.
 */
function resolveMigrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "..", "drizzle"), join(here, "..", "..", "drizzle")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot locate drizzle migrations folder relative to ${here}`);
}

/**
 * Validate that migration journal timestamps are strictly increasing.
 * Drizzle silently skips migrations whose `when` is <= the last applied
 * timestamp, which causes missing columns/tables with no error.
 */
function validateJournalOrder(migrationsFolder: string): void {
  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  if (!existsSync(journalPath)) return;

  const journal = JSON.parse(readFileSync(journalPath, "utf-8")) as {
    entries: Array<{ idx: number; when: number; tag: string }>;
  };

  let prevWhen = 0;
  let prevTag = "";
  for (const entry of journal.entries) {
    if (entry.when <= prevWhen) {
      throw new Error(
        `Migration journal timestamps are not monotonically increasing:\n` +
          `  "${prevTag}" (when: ${prevWhen}) >= "${entry.tag}" (when: ${entry.when})\n` +
          `  Drizzle will silently skip "${entry.tag}". Fix the 'when' values in:\n` +
          `  ${journalPath}`,
      );
    }
    prevWhen = entry.when;
    prevTag = entry.tag;
  }
}

/**
 * Advisory-lock key serializing startup migrations across replicas (T10).
 *
 * Verified against `drizzle-orm@0.44.7`:
 *   - `node_modules/drizzle-orm/postgres-js/migrator.js` → delegates to
 *     `node_modules/drizzle-orm/pg-core/dialect.js::migrate()`, which
 *     **does NOT acquire any advisory lock** in this version; it only wraps
 *     `INSERT INTO drizzle.__drizzle_migrations` in a transaction.
 *   - The journal table makes migrations idempotent but NOT serialized:
 *     without this lock, two replicas starting together both execute
 *     DDL/backfills concurrently (duplicate-object errors, duplicated data
 *     work, failed rollout replicas — PERF-027).
 *
 * The lock is acquired on the same dedicated connection that then runs
 * `migrate()`, and is held from acquisition through the final statement so
 * the lock window covers the full operation. Non-owner replicas poll until
 * the owner releases; once they acquire it, the journal has already
 * advanced and their `migrate()` is a no-op.
 *
 * If you bump `drizzle-orm`, re-read `pg-core/dialect.js::migrate()` and
 * update this key (and `MIGRATION_LOCK_TIMEOUT_MS`) accordingly. The
 * integration test `bootstrap-migration-lock.test.ts` pins the contention
 * behavior using the same key.
 */
const MIGRATION_LOCK_KEY_SQL = "hashtext('drizzle_migrations')";
// Sits inside the 20s `runMigrations` stage budget set in `bootstrap-server.ts`;
// 15s lock wait + ≥5s for the actual drizzle migrate call. A waiting replica
// can block for the holder's whole migrate, so if a future migration is known
// to run longer, raise this budget, the stage budget, and the Dockerfile
// HEALTHCHECK `--start-period` in lockstep.
const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 15_000;
const MIGRATION_LOCK_POLL_INTERVAL_MS = 1_000;

export type RunMigrationsOptions = {
  /** Override the advisory-lock wait timeout. Default 15s. */
  lockTimeoutMs?: number;
};

/**
 * Acquire the migration advisory lock on `client`, polling once per second
 * until `timeoutMs` elapses. Throws a clear contention error on timeout; on
 * success the caller owns the lock and MUST release it (see `runMigrations`).
 * The lock is session-scoped, so it is also released automatically if the
 * connection drops — a crashed replica never leaves an orphan lock behind.
 */
async function acquireMigrationLock(client: postgres.Sql, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let loggedWait = false;
  while (true) {
    const rows = (await client.unsafe(`SELECT pg_try_advisory_lock(${MIGRATION_LOCK_KEY_SQL}) AS acquired`)) as Array<{
      acquired: boolean;
    }>;
    if (rows[0]?.acquired) {
      return;
    }
    if (!loggedWait) {
      // A replica blocked here would otherwise sit silent until the timeout
      // crash — log once so operators can see who it is waiting on.
      log.info({ lockKey: MIGRATION_LOCK_KEY_SQL }, "waiting for migration lock held by another session");
      loggedWait = true;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `migration lock contention — another process holds drizzle migration lock (${MIGRATION_LOCK_KEY_SQL}) ` +
          `after ${timeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, MIGRATION_LOCK_POLL_INTERVAL_MS));
  }
}

/**
 * Run Drizzle database migrations. Returns the count of public tables after
 * migration, used as a rough indicator that the schema landed.
 */
export async function runMigrations(databaseUrl: string, options: RunMigrationsOptions = {}): Promise<number> {
  // Validation must stay before any postgres client is created — the edge
  // tests assert no connection is opened for validation failures.
  const migrationsFolder = resolveMigrationsFolder();

  validateJournalOrder(migrationsFolder);

  const ssl = sslOptions(databaseUrl);
  // max: 1 keeps the advisory lock and migrate() on one session, so the lock
  // covers the full migration (see the MIGRATION_LOCK_KEY_SQL comment above).
  const client = postgres(databaseUrl, { max: 1, ...ssl });
  let lockAcquired = false;
  try {
    await acquireMigrationLock(client, options.lockTimeoutMs ?? DEFAULT_MIGRATION_LOCK_TIMEOUT_MS);
    lockAcquired = true;

    const db = drizzle(client);
    await migrate(db, { migrationsFolder });

    const result = await client`
      SELECT count(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    return (result[0] as { count: number }).count;
  } finally {
    if (lockAcquired) {
      try {
        await client.unsafe(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY_SQL})`);
      } catch (unlockError) {
        // Best-effort release: if the connection died mid-migration the
        // server has already dropped the session lock. Never mask the
        // original migrate error with an unlock failure.
        log.warn({ err: unlockError }, "failed to release migration advisory lock explicitly");
      }
    }
    await client.end();
  }
}
