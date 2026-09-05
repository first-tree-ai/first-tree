import { existsSync, readFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as runDrizzleMigrations } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createLogger } from "../observability/logger.js";
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
 * Advisory-lock key held for the complete Drizzle migration lifecycle.
 *
 * Verified against `drizzle-orm@0.44.7`:
 *   - `node_modules/drizzle-orm/postgres-js/migrator.js` → delegates to
 *     `node_modules/drizzle-orm/pg-core/dialect.js::migrate()`, which
 *     **does NOT acquire any advisory lock** in this version; it runs all
 *     pending migration statements and journal inserts in one transaction.
 *   - `migrate()` resolves only after that transaction commits. Keeping this
 *     session-level lock until then serializes journal reads, DDL/backfills,
 *     the final journal insert, and commit across Server replicas.
 *
 * If you bump `drizzle-orm`, re-read `pg-core/dialect.js::migrate()` and
 * update this key (and `MIGRATION_LOCK_TIMEOUT_MS`) accordingly. The
 * integration test `bootstrap-migration-lock.test.ts` pins the contention
 * behavior using the same key.
 */
const MIGRATION_LOCK_KEY_SQL = "hashtext('drizzle_migrations')";
// The lock-acquisition watchdog actively terminates its postgres-js client,
// so a contending replica fails before the non-cancelling 20s bootstrap-stage
// timeout. Migration execution remains subject to that existing outer timeout,
// which reports failure but does not cancel the underlying migration promise.
const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 15_000;
const MIGRATION_LOCK_POLL_INTERVAL_MS = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type RunMigrationsOptions = {
  /** Override the advisory-lock acquisition timeout. Default 15s. */
  lockTimeoutMs?: number;
};

type MigrationSession = {
  tryAcquireLock(): Promise<boolean>;
  migrate(): Promise<void>;
  countTables(): Promise<number>;
  unlock(): Promise<boolean>;
  end(options: { timeout: 0 }): Promise<void>;
};

type MigrationLogger = Pick<ReturnType<typeof createLogger>, "info" | "warn">;

export type RunMigrationsDependencies = {
  openSession(input: {
    databaseUrl: string;
    migrationsFolder: string;
    connectTimeoutSeconds: number;
    onLockAcquired(): void;
    onClose(connectionId: number): void;
  }): MigrationSession;
  logger: MigrationLogger;
  now(): number;
  sleep(ms: number, terminalSignal: Promise<void>): Promise<void>;
  armWatchdog(fire: () => void, timeoutMs: number): () => void;
};

type SettledOperation<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "error"; readonly error: unknown };

type PostgresSocketOptions = {
  host: string[];
  port: number[];
  path?: string | false;
};

type TrackedPostgresSocket = Socket & {
  host?: string;
  port?: number;
};

/**
 * postgres-js 3.4.8 does not cancel a reconnect timer queued while a query is
 * in its initial connection state. `end({ timeout: 0 })` can therefore resolve
 * before that timer creates a replacement socket. This session-private socket
 * gate preserves normal pre-shutdown retries, but makes socket creation
 * impossible synchronously once cleanup starts. It destroys sockets that are
 * still connecting while postgres-js closes established sockets itself.
 */
function createMigrationSocketGate(): {
  connect(options: PostgresSocketOptions): Socket;
  stop(): void;
} {
  let acceptingSockets = true;
  let nextHostIndex = 0;
  const rawSockets = new Set<Socket>();
  const shutdownError = new Error("migration database session is shutting down");

  return {
    connect(options) {
      if (!acceptingSockets) throw shutdownError;

      const hosts = options.host;
      const ports = options.port;
      const hostIndex = nextHostIndex % Math.max(hosts.length, 1);
      nextHostIndex += 1;
      const host = hosts[hostIndex] ?? "localhost";
      const port = ports[hostIndex % Math.max(ports.length, 1)] ?? 5432;
      const socket = (
        options.path ? createConnection(options.path) : createConnection({ host, port })
      ) as TrackedPostgresSocket;
      // postgres-js reads these properties when it upgrades a custom socket
      // to TLS. Its public custom-socket API is documented but missing from
      // the 3.4.8 Options declaration.
      socket.host = host;
      socket.port = port;
      rawSockets.add(socket);
      socket.once("close", () => rawSockets.delete(socket));

      if (!acceptingSockets) {
        socket.destroy();
        throw shutdownError;
      }
      return socket;
    },
    stop() {
      acceptingSockets = false;
      // postgres-js may have wrapped a connected raw socket in a TLSSocket.
      // Let client.end() close sockets it already owns; destroying the raw
      // socket first races the driver's Terminate write. Only sockets still
      // connecting are outside that reliable shutdown path. Use the Socket's
      // state instead of a listener-maintained set: direct TLS negotiation
      // removes the raw socket's listeners before its TCP connect completes.
      for (const socket of rawSockets) {
        if (socket.connecting) socket.destroy();
      }
      rawSockets.clear();
    },
  };
}

function createDefaultDependencies(): RunMigrationsDependencies {
  return {
    openSession({ databaseUrl, migrationsFolder, connectTimeoutSeconds, onLockAcquired, onClose }) {
      let connectionClosed = false;
      const socketGate = createMigrationSocketGate();
      const clientOptions = {
        ...sslOptions(databaseUrl),
        max: 1,
        // postgres-js 3.4.8 treats an explicit 0 as disabled. Keep the own
        // property so URL/PGIDLE_TIMEOUT cannot rotate the sole connection.
        idle_timeout: 0,
        max_lifetime: null,
        connect_timeout: connectTimeoutSeconds,
        socket: socketGate.connect,
        onclose(connectionId) {
          connectionClosed = true;
          onClose(connectionId);
        },
      } as NonNullable<Parameters<typeof postgres>[1]> & {
        socket(options: PostgresSocketOptions): Socket;
      };
      const client = postgres(databaseUrl, clientOptions);

      type TransactionCallback = (transactionClient: typeof client) => unknown;
      const migrationClient = new Proxy(client, {
        get(target, property, receiver) {
          if (property !== "begin") return Reflect.get(target, property, receiver);

          return async (optionsOrCallback: string | TransactionCallback, maybeCallback?: TransactionCallback) => {
            const options = typeof optionsOrCallback === "string" ? optionsOrCallback : "";
            const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
            if (callback === undefined) throw new Error("migration transaction callback is required");

            let began = false;
            try {
              const transactionOptions = options.replace(/[^a-z ]/gi, "");
              await client.unsafe(`BEGIN ${transactionOptions}`);
              began = true;
              const result = await callback(client);
              if (connectionClosed) throw new Error("migration database session closed before commit");
              await client.unsafe("COMMIT");
              return result;
            } catch (error) {
              if (began && !connectionClosed) {
                try {
                  await client.unsafe("ROLLBACK");
                } catch (rollbackError) {
                  log.warn({ err: rollbackError }, "migration rollback failed after transaction error");
                }
              }
              throw error;
            }
          };
        },
      });

      return {
        async tryAcquireLock() {
          const rows = await client.unsafe<Array<{ acquired: boolean }>>(
            `SELECT pg_try_advisory_lock(${MIGRATION_LOCK_KEY_SQL}) AS acquired`,
          );
          // A completed query identifies the currently live backend session;
          // reconnects before lock acquisition are safe because no lock or
          // migration work existed on the previous session.
          connectionClosed = false;
          const acquired = rows[0]?.acquired === true;
          if (acquired) onLockAcquired();
          return acquired;
        },
        async migrate() {
          // Drizzle 0.44.7 only needs begin(callback) here. Its default
          // postgres-js begin() races transaction rollback against onclose;
          // the proxy keeps identical BEGIN/COMMIT semantics but skips any
          // post-disconnect ROLLBACK that could run on a replacement session.
          await runDrizzleMigrations(drizzle(migrationClient), { migrationsFolder });
        },
        async countTables() {
          const rows = await client.unsafe<Array<{ count: number }>>(`
            SELECT count(*)::int AS count
            FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          `);
          const count = rows[0]?.count;
          if (typeof count !== "number") {
            throw new Error("migration table-count query returned no count");
          }
          return count;
        },
        async unlock() {
          const rows = await client.unsafe<Array<{ unlocked: boolean }>>(
            `SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY_SQL}) AS unlocked`,
          );
          return rows[0]?.unlocked === true;
        },
        end(options) {
          // Close the socket-creation gate before asking postgres-js to end.
          // Any already-queued reconnect callback can still run, but it can no
          // longer create a socket or backend after this point.
          socketGate.stop();
          return client.end(options);
        },
      };
    },
    logger: log,
    now: () => performance.now(),
    async sleep(ms, terminalSignal) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const delay = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      });
      await Promise.race([delay, terminalSignal]);
      if (timer !== undefined) clearTimeout(timer);
    },
    armWatchdog(fire, timeoutMs) {
      const timer = setTimeout(fire, timeoutMs);
      return () => clearTimeout(timer);
    },
  };
}

const defaultDependencies = createDefaultDependencies();

/**
 * Run Drizzle database migrations. Returns the count of public tables after
 * migration, used as a rough indicator that the schema landed.
 */
export async function runMigrations(databaseUrl: string, options: RunMigrationsOptions = {}): Promise<number> {
  const migrationsFolder = resolveMigrationsFolder();

  validateJournalOrder(migrationsFolder);

  return runMigrationsWithDependencies(databaseUrl, migrationsFolder, options, defaultDependencies);
}

/**
 * Dependency seam for deterministic lifecycle tests. Production callers use
 * `runMigrations()` above; every operation exposed by the default adapter is
 * closed over the same one-connection postgres-js client.
 *
 * @internal
 */
export async function runMigrationsWithDependencies(
  databaseUrl: string,
  migrationsFolder: string,
  options: RunMigrationsOptions,
  dependencies: RunMigrationsDependencies,
): Promise<number> {
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_MIGRATION_LOCK_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`migration lock timeout must be a finite positive value no greater than ${MAX_TIMER_DELAY_MS}ms`);
  }

  const startedAt = dependencies.now();
  const deadline = startedAt + timeoutMs;
  let expectedClose = false;
  let lockAcquired = false;
  let unlockConfirmed = false;
  let sawLockMiss = false;
  let terminalError: Error | undefined;
  let connectionLostError: Error | undefined;
  let forcedEndError: unknown;
  let forcedEndFailed = false;
  let forcedEndPromise: Promise<void> | undefined;
  let resolveTerminalSignal: () => void = () => undefined;
  let terminalSignalled = false;
  const terminalSignal = new Promise<void>((resolve) => {
    resolveTerminalSignal = resolve;
  });

  let session: MigrationSession;

  const startForcedEnd = (afterCloseCallback = false): Promise<void> => {
    if (forcedEndPromise !== undefined) return forcedEndPromise;

    let resolveForcedEnd: () => void = () => undefined;
    // Publish the sticky promise before invoking end(); a test adapter (or a
    // future driver) may synchronously call onClose from inside end().
    forcedEndPromise = new Promise<void>((resolve) => {
      resolveForcedEnd = resolve;
    });
    const end = () => {
      try {
        void Promise.resolve(session.end({ timeout: 0 })).then(
          () => resolveForcedEnd(),
          (error: unknown) => {
            forcedEndFailed = true;
            forcedEndError = error;
            resolveForcedEnd();
          },
        );
      } catch (error) {
        forcedEndFailed = true;
        forcedEndError = error;
        resolveForcedEnd();
      }
    };
    if (afterCloseCallback) {
      // postgres-js invokes onclose from inside its connection-close
      // bookkeeping, before processing any queued work that could reconnect.
      // Calling end() re-entrantly from that hook can race the remainder of
      // the close path. Publish poison/end state now, then terminate in the
      // next microtask.
      queueMicrotask(end);
    } else {
      end();
    }
    return forcedEndPromise;
  };

  const poison = (error: Error, afterCloseCallback = false): void => {
    if (terminalError === undefined) terminalError = error;
    if (!terminalSignalled) {
      terminalSignalled = true;
      resolveTerminalSignal();
    }
    void startForcedEnd(afterCloseCallback);
  };

  session = dependencies.openSession({
    databaseUrl,
    migrationsFolder,
    connectTimeoutSeconds: Math.max(1, Math.min(Math.ceil(timeoutMs / 1_000), Math.floor(MAX_TIMER_DELAY_MS / 1_000))),
    onLockAcquired() {
      // Set synchronously inside the session adapter, before its query promise
      // resolves to this lifecycle. A socket close in that microtask gap must
      // still poison the lock-owning session.
      lockAcquired = true;
    },
    onClose(connectionId) {
      if (!expectedClose && lockAcquired && !unlockConfirmed) {
        connectionLostError ??= new Error(
          `migration postgres-js connection ${connectionId} closed before advisory lock release was confirmed`,
        );
        poison(connectionLostError, true);
      }
    },
  });

  const whileSessionAlive = async <T>(operation: PromiseLike<T>): Promise<T> => {
    const settled = Promise.resolve(operation).then<SettledOperation<T>, SettledOperation<T>>(
      (value) => ({ kind: "value", value }),
      (error: unknown) => ({ kind: "error", error }),
    );
    const outcome = await Promise.race([settled, terminalSignal.then(() => ({ kind: "terminal" as const }))]);

    if (outcome.kind === "terminal") {
      await forcedEndPromise;
      await settled;
      throw terminalError ?? new Error("migration database session terminated");
    }
    if (outcome.kind === "error") throw outcome.error;
    if (terminalError !== undefined) {
      await forcedEndPromise;
      throw terminalError;
    }
    return outcome.value;
  };

  let acquireWatchdogActive = true;
  const acquireTimeoutError = (): Error =>
    sawLockMiss
      ? new Error(
          `migration lock contention — another process holds drizzle migration lock (${MIGRATION_LOCK_KEY_SQL}) ` +
            `after ${timeoutMs}ms`,
        )
      : new Error(`migration lock acquisition timed out after ${timeoutMs}ms`);
  const cancelWatchdog = dependencies.armWatchdog(() => {
    if (acquireWatchdogActive) poison(acquireTimeoutError());
  }, timeoutMs);
  const stopWatchdog = (): void => {
    if (!acquireWatchdogActive) return;
    acquireWatchdogActive = false;
    cancelWatchdog();
  };

  let tableCount: number | undefined;
  let hasPrimaryError = false;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];

  try {
    while (true) {
      const remainingMs = deadline - dependencies.now();
      if (remainingMs <= 0) {
        poison(acquireTimeoutError());
        throw terminalError;
      }

      const acquired = await whileSessionAlive(session.tryAcquireLock());
      if (!acquired && !sawLockMiss) {
        sawLockMiss = true;
        dependencies.logger.info(
          { lockKey: MIGRATION_LOCK_KEY_SQL, timeoutMs },
          "waiting for migration lock held by another session",
        );
      }
      // A query can become ready after the monotonic deadline while its timer
      // callback is still queued behind I/O. Re-check before cancelling the
      // watchdog so a late lock acquisition cannot enter migration work. A
      // false result is recorded first so it retains contention diagnostics.
      if (dependencies.now() >= deadline) {
        poison(acquireTimeoutError());
        throw terminalError;
      }
      if (acquired) {
        lockAcquired = true;
        stopWatchdog();
        if (sawLockMiss) {
          dependencies.logger.info(
            {
              lockKey: MIGRATION_LOCK_KEY_SQL,
              waitMs: Math.round(dependencies.now() - startedAt),
              timeoutMs,
            },
            "acquired migration lock after waiting",
          );
        }
        break;
      }

      const sleepMs = Math.min(MIGRATION_LOCK_POLL_INTERVAL_MS, deadline - dependencies.now());
      if (sleepMs <= 0) {
        poison(acquireTimeoutError());
        throw terminalError;
      }
      await dependencies.sleep(sleepMs, terminalSignal);
      if (terminalError !== undefined) {
        await forcedEndPromise;
        throw terminalError;
      }
    }

    await whileSessionAlive(session.migrate());
    tableCount = await whileSessionAlive(session.countTables());
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  } finally {
    stopWatchdog();

    if (lockAcquired && !unlockConfirmed && terminalError === undefined) {
      try {
        const unlocked = await whileSessionAlive(session.unlock());
        if (!unlocked) {
          cleanupErrors.push(new Error("migration advisory unlock was not confirmed on the lock-owning session"));
        } else {
          unlockConfirmed = true;
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (forcedEndPromise !== undefined) {
      await forcedEndPromise;
    } else {
      // From this point onward no SQL can be issued. Mark the close expected
      // immediately before the one bounded, deliberate client shutdown.
      expectedClose = true;
      try {
        await session.end({ timeout: 0 });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }

  const secondaryErrors: unknown[] = [];
  const addSecondaryError = (error: unknown): void => {
    if (hasPrimaryError && error === primaryError) return;
    if (!secondaryErrors.some((existing) => Object.is(existing, error))) secondaryErrors.push(error);
  };
  if (terminalError !== undefined) addSecondaryError(terminalError);
  if (forcedEndFailed) addSecondaryError(forcedEndError);
  for (const error of cleanupErrors) {
    addSecondaryError(error);
  }

  if (hasPrimaryError) {
    for (const error of secondaryErrors) {
      dependencies.logger.warn({ err: error }, "migration cleanup failed after primary error");
    }
    throw primaryError;
  }

  if (terminalError !== undefined) {
    for (const error of secondaryErrors) {
      if (error !== terminalError) dependencies.logger.warn({ err: error }, "migration cleanup also failed");
    }
    throw terminalError;
  }

  if (secondaryErrors.length > 0) {
    const [error, ...additionalErrors] = secondaryErrors;
    for (const additionalError of additionalErrors) {
      dependencies.logger.warn({ err: additionalError }, "additional migration cleanup failure");
    }
    throw error;
  }

  if (tableCount === undefined) throw new Error("migration completed without a table count");
  return tableCount;
}
