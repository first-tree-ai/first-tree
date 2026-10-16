import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { sslOptions } from "./connection.js";

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
 * Advisory-lock key serializing startup migrations across replicas.
 *
 * Verified against `drizzle-orm@0.44.7`:
 *   - `node_modules/drizzle-orm/postgres-js/migrator.js` → delegates to
 *     `node_modules/drizzle-orm/pg-core/dialect.js::migrate()`, which
 *     **does NOT acquire any advisory lock** in this version; it only wraps
 *     `INSERT INTO drizzle.__drizzle_migrations` in a transaction.
 *   - So `runMigrations` acquires this session-level lock itself and holds
 *     it on the same single connection for the *entire* migration (journal
 *     read + DDL/backfills + journal insert). Concurrent replicas wait on
 *     the key; when the owner finishes and the lock is released, the next
 *     replica acquires it, sees the advanced journal, and no-ops.
 *
 * If you bump `drizzle-orm`, re-read `pg-core/dialect.js::migrate()` and
 * confirm it still does not take a conflicting lock of its own. The
 * integration test `bootstrap-migration-lock.test.ts` pins both the
 * contention error path and the held-for-the-whole-migration behavior
 * using the same key.
 */
const MIGRATION_LOCK_KEY_SQL = "hashtext('drizzle_migrations')";
// Sits inside the 20s `runMigrations` stage budget set in
// `bootstrap-server.ts`; up to 15s waiting for the lock + ≥5s for the actual
// drizzle migrate call. If you raise either, raise the other in lockstep
// (and re-evaluate the Dockerfile HEALTHCHECK `--start-period`).
const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 15_000;
const MIGRATION_LOCK_POLL_INTERVAL_MS = 1_000;

export type RunMigrationsOptions = {
  /** Override the advisory-lock acquisition timeout. Default 15s. */
  lockTimeoutMs?: number;
};

/**
 * Acquire the migration advisory lock on `client`'s session, polling until
 * `timeoutMs`. On success the lock is HELD — the caller keeps it for the
 * whole migration and releases it implicitly when the session ends. On
 * timeout, fail with a clear contention message instead of letting a
 * concurrent replica run DDL in parallel. See the key constant above for
 * the full rationale and server-bootstrap-resilience-design.md §3 (T10).
 */
async function acquireMigrationLock(client: postgres.Sql, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const rows = (await client.unsafe(`SELECT pg_try_advisory_lock(${MIGRATION_LOCK_KEY_SQL}) AS acquired`)) as Array<{
      acquired: boolean;
    }>;
    if (rows[0]?.acquired) {
      return;
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
 * Run Drizzle database migrations, serialized across replicas by a
 * session-level advisory lock held on a single dedicated connection for the
 * entire operation (journal read + DDL/backfills + journal insert). Returns
 * the count of public tables after migration, used as a rough indicator
 * that the schema landed.
 */
export async function runMigrations(databaseUrl: string, options: RunMigrationsOptions = {}): Promise<number> {
  const migrationsFolder = resolveMigrationsFolder();

  validateJournalOrder(migrationsFolder);

  const ssl = sslOptions(databaseUrl);

  // One `max: 1` client = one physical session. The advisory lock taken on
  // it below stays held across the drizzle `migrate()` call (session-level
  // locks survive the transactions drizzle opens on this same connection)
  // and is released when the session closes in `finally` — including on
  // error paths, so a failed migration can't strand the lock.
  const client = postgres(databaseUrl, { max: 1, ...ssl });
  try {
    await acquireMigrationLock(client, options.lockTimeoutMs ?? DEFAULT_MIGRATION_LOCK_TIMEOUT_MS);

    const db = drizzle(client);
    await migrate(db, { migrationsFolder });

    const result = await client`
      SELECT count(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    return (result[0] as { count: number }).count;
  } finally {
    // Closing the session releases the advisory lock server-side; no
    // explicit pg_advisory_unlock needed (and none that could mask an
    // in-flight migration error if the connection already died).
    await client.end();
  }
}
