import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { type AddressInfo, createConnection, createServer, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { sslOptions } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";

const REPLICA_A = "ft_migration_replica_a";
const REPLICA_B = "ft_migration_replica_b";
const QA_LOCK_CLASS = 1690;
const FINAL_INSERT_GATE = 1;
const REPLICA_B_DDL_GATE = 2;
const SCRATCH_CASE_TIMEOUT_MS = 60_000;
const SCRATCH_BODY_TIMEOUT_MS = 35_000;
const SCRATCH_DRAIN_TIMEOUT_MS = 5_000;
const RECONNECT_BACKOFF_MS = 7_000;
const RECONNECT_LOCK_TIMEOUT_MS = 5_000;
const RECONNECT_OBSERVATION_MS = RECONNECT_BACKOFF_MS + 500;
const RECONNECT_SECOND_POLL_WAIT_MS = 1_250;
const RECONNECT_RETURN_GRACE_MS = 1_000;
const RECONNECT_DRAIN_TIMEOUT_MS = 5_000;
const RECONNECT_CASE_TIMEOUT_MS = 45_000;

const journal = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../drizzle/meta/_journal.json", import.meta.url)), "utf8"),
) as { entries: Array<{ when: number }> };
const expectedJournalWhens = journal.entries.map((entry) => entry.when);
const maybeFinalJournalWhen = expectedJournalWhens.at(-1);
if (maybeFinalJournalWhen === undefined) throw new Error("migration journal must contain at least one entry");
const finalJournalWhen: number = maybeFinalJournalWhen;

type Outcome<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown };

type BackendState = {
  pid: number;
  state: string;
  query: string;
  wait_event_type: string | null;
  wait_event: string | null;
  holds_migration_lock: boolean;
  waits_migration_lock: boolean;
  waits_final_insert_gate: boolean;
  waits_replica_b_ddl_gate: boolean;
};

function track<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

function databaseUrlWithApplicationName(url: string, applicationName: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("application_name", applicationName);
  return parsed.toString();
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type TcpForwardingGate = {
  port: number;
  acceptedConnections(): number;
  downstreamCloses(): number;
  waitForDownstreamCloseAfter(count: number, timeoutMs: number): Promise<{ count: number; closedAt: number }>;
  setForwarding(enabled: boolean): void;
  close(): Promise<void>;
};

async function createTcpForwardingGate(targetUrl: string): Promise<TcpForwardingGate> {
  const target = new URL(targetUrl);
  const targetPort = Number(target.port || "5432");
  let forwarding = true;
  let acceptedConnections = 0;
  let downstreamCloses = 0;
  let lastDownstreamClose: { count: number; closedAt: number } | undefined;
  const downstreamCloseListeners = new Set<(observation: { count: number; closedAt: number }) => void>();
  const sockets = new Set<Socket>();
  const server = createServer((downstream) => {
    acceptedConnections += 1;
    sockets.add(downstream);
    downstream.on("error", () => undefined);
    downstream.once("close", () => {
      sockets.delete(downstream);
      downstreamCloses += 1;
      lastDownstreamClose = { count: downstreamCloses, closedAt: performance.now() };
      for (const listener of downstreamCloseListeners) listener(lastDownstreamClose);
    });

    if (!forwarding) {
      downstream.destroy();
      return;
    }

    const upstream = createConnection({ host: target.hostname, port: targetPort });
    sockets.add(upstream);
    upstream.on("error", () => undefined);
    upstream.once("close", () => {
      sockets.delete(upstream);
      downstream.destroy();
    });
    downstream.once("close", () => upstream.destroy());
    downstream.pipe(upstream).pipe(downstream);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(`TCP forwarding gate did not bind an IP port: ${String(address)}`);
  }

  return {
    port: (address as AddressInfo).port,
    acceptedConnections: () => acceptedConnections,
    downstreamCloses: () => downstreamCloses,
    waitForDownstreamCloseAfter(count, timeoutMs) {
      if (lastDownstreamClose !== undefined && lastDownstreamClose.count > count) {
        return Promise.resolve(lastDownstreamClose);
      }

      return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = (): void => {
          downstreamCloseListeners.delete(onClose);
          if (timer !== undefined) clearTimeout(timer);
        };
        const onClose = (observation: { count: number; closedAt: number }): void => {
          if (observation.count <= count) return;
          cleanup();
          resolve(observation);
        };

        downstreamCloseListeners.add(onClose);
        // Close can race listener registration between the fast-path check
        // above and this insertion.
        if (lastDownstreamClose !== undefined && lastDownstreamClose.count > count) {
          onClose(lastDownstreamClose);
          return;
        }
        timer = setTimeout(() => {
          cleanup();
          reject(new Error(`timed out waiting for a downstream close after count ${count}`));
        }, timeoutMs);
      });
    },
    setForwarding(enabled) {
      forwarding = enabled;
      if (enabled) return;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
    async close() {
      forwarding = false;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function readBackendStates(
  observer: ReturnType<typeof postgres>,
  applicationName: string,
): Promise<BackendState[]> {
  return observer.unsafe<BackendState[]>(
    `
      SELECT
        a.pid,
        a.state,
        a.query,
        a.wait_event_type,
        a.wait_event,
        COALESCE(bool_or(
          l.locktype = 'advisory'
          AND l.objsubid = 1
          AND ((l.classid::bigint << 32) | l.objid::bigint)
              = hashtext('drizzle_migrations')::bigint
          AND l.granted
        ), false) AS holds_migration_lock,
        COALESCE(bool_or(
          l.locktype = 'advisory'
          AND l.objsubid = 1
          AND ((l.classid::bigint << 32) | l.objid::bigint)
              = hashtext('drizzle_migrations')::bigint
          AND NOT l.granted
        ), false) AS waits_migration_lock,
        COALESCE(bool_or(
          l.locktype = 'advisory'
          AND l.classid::bigint = ${QA_LOCK_CLASS}
          AND l.objid::bigint = ${FINAL_INSERT_GATE}
          AND l.objsubid = 2
          AND NOT l.granted
        ), false) AS waits_final_insert_gate,
        COALESCE(bool_or(
          l.locktype = 'advisory'
          AND l.classid::bigint = ${QA_LOCK_CLASS}
          AND l.objid::bigint = ${REPLICA_B_DDL_GATE}
          AND l.objsubid = 2
          AND NOT l.granted
        ), false) AS waits_replica_b_ddl_gate
      FROM pg_stat_activity a
      LEFT JOIN pg_locks l ON l.pid = a.pid
      WHERE a.datname = current_database()
        AND a.application_name = $1
      GROUP BY a.pid, a.state, a.query, a.wait_event_type, a.wait_event
    `,
    [applicationName],
  );
}

async function waitForBackendState(
  observer: ReturnType<typeof postgres>,
  applicationName: string,
  predicate: (state: BackendState) => boolean,
  description: string,
): Promise<BackendState> {
  const deadline = performance.now() + 20_000;
  let lastStates: BackendState[] = [];
  while (performance.now() < deadline) {
    lastStates = await readBackendStates(observer, applicationName);
    const match = lastStates.find(predicate);
    if (match) return match;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${description}; last state: ${JSON.stringify(lastStates)}`);
}

async function waitForNoBackend(observer: ReturnType<typeof postgres>, applicationName: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  let lastStates: BackendState[] = [];
  while (performance.now() < deadline) {
    lastStates = await readBackendStates(observer, applicationName);
    if (lastStates.length === 0) return;
    await delay(20);
  }
  throw new Error(`backend ${applicationName} remained after termination: ${JSON.stringify(lastStates)}`);
}

async function readJournalWhens(observer: ReturnType<typeof postgres>): Promise<number[]> {
  const rows = await observer<Array<{ created_at: string }>>`
    SELECT created_at::text AS created_at
    FROM drizzle.__drizzle_migrations
    ORDER BY created_at
  `;
  return rows.map((row) => Number(row.created_at));
}

async function releaseGate(
  controller: ReturnType<typeof postgres>,
  gate: typeof FINAL_INSERT_GATE | typeof REPLICA_B_DDL_GATE,
): Promise<void> {
  const rows = await controller<Array<{ unlocked: boolean }>>`
    SELECT pg_advisory_unlock(${QA_LOCK_CLASS}, ${gate}) AS unlocked
  `;
  expect(rows[0]?.unlocked, `controller must hold QA gate ${gate}`).toBe(true);
}

async function settlesWithin(promises: readonly Promise<unknown>[], timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = Promise.allSettled(promises).then(() => true as const);
  const result = await Promise.race([settled, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

async function valueWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ readonly kind: "settled"; readonly value: T } | { readonly kind: "timed-out" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ readonly kind: "timed-out" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timed-out" }), timeoutMs);
  });
  const settled = promise.then((value) => ({ kind: "settled" as const, value }));
  const result = await Promise.race([settled, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

type ScratchDatabase = {
  name: string;
  url: string;
  admin: ReturnType<typeof postgres>;
  observer: ReturnType<typeof postgres>;
  controller: ReturnType<typeof postgres>;
  tracked: Promise<unknown>[];
};

async function createScratchDatabase(): Promise<ScratchDatabase> {
  const baseUrl = process.env.DATABASE_URL;
  expect(baseUrl, "DATABASE_URL must be set by global setup").toBeTruthy();

  const name = `migration_lock_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe scratch database name: ${name}`);

  const adminUrl = new URL(baseUrl ?? "");
  adminUrl.pathname = "/postgres";
  adminUrl.searchParams.delete("application_name");
  const admin = postgres(adminUrl.toString(), {
    max: 1,
    ...sslOptions(adminUrl.toString()),
    onnotice: () => undefined,
  });
  let observer: ReturnType<typeof postgres> | undefined;
  let controller: ReturnType<typeof postgres> | undefined;

  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const scratchUrl = new URL(baseUrl ?? "");
    scratchUrl.pathname = `/${name}`;
    scratchUrl.searchParams.delete("application_name");
    const url = scratchUrl.toString();
    observer = postgres(url, { max: 1, ...sslOptions(url), onnotice: () => undefined });
    controller = postgres(url, { max: 1, ...sslOptions(url), onnotice: () => undefined });

    const roles = await observer<Array<{ rolsuper: boolean }>>`
      SELECT rolsuper FROM pg_roles WHERE rolname = current_user
    `;
    if (roles[0]?.rolsuper !== true) {
      throw new Error("migration serialization regression requires a PostgreSQL superuser for event triggers");
    }

    await observer.unsafe("CREATE SCHEMA drizzle");
    await observer.unsafe(`
      CREATE TABLE drizzle.__drizzle_migrations (
        id serial PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);
    await observer.unsafe("CREATE SCHEMA qa_migration_lock");
    await observer.unsafe("CREATE TABLE qa_migration_lock.config (final_when bigint NOT NULL)");
    await observer`INSERT INTO qa_migration_lock.config (final_when) VALUES (${finalJournalWhen})`;
    await observer.unsafe(`
      CREATE FUNCTION qa_migration_lock.gate_final_journal_insert()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF current_setting('application_name', true) = '${REPLICA_A}'
           AND NEW.created_at = (SELECT final_when FROM qa_migration_lock.config)
        THEN
          PERFORM pg_catalog.pg_advisory_lock(${QA_LOCK_CLASS}, ${FINAL_INSERT_GATE});
          PERFORM pg_catalog.pg_advisory_unlock(${QA_LOCK_CLASS}, ${FINAL_INSERT_GATE});
        END IF;
        RETURN NEW;
      END;
      $function$
    `);
    await observer.unsafe(`
      CREATE TRIGGER qa_gate_final_journal_insert
      BEFORE INSERT ON drizzle.__drizzle_migrations
      FOR EACH ROW
      EXECUTE FUNCTION qa_migration_lock.gate_final_journal_insert()
    `);
    await observer.unsafe(`
      CREATE FUNCTION qa_migration_lock.gate_replica_b_ddl()
      RETURNS event_trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF current_setting('application_name', true) = '${REPLICA_B}'
        THEN
          PERFORM pg_catalog.pg_advisory_lock(${QA_LOCK_CLASS}, ${REPLICA_B_DDL_GATE});
          PERFORM pg_catalog.pg_advisory_unlock(${QA_LOCK_CLASS}, ${REPLICA_B_DDL_GATE});
        END IF;
      END;
      $function$
    `);
    await observer.unsafe(`
      CREATE EVENT TRIGGER qa_gate_replica_b_ddl
      ON ddl_command_start
      EXECUTE FUNCTION qa_migration_lock.gate_replica_b_ddl()
    `);
    await controller.unsafe(`
      SELECT
        pg_advisory_lock(${QA_LOCK_CLASS}, ${FINAL_INSERT_GATE}),
        pg_advisory_lock(${QA_LOCK_CLASS}, ${REPLICA_B_DDL_GATE})
    `);

    return { name, url, admin, observer, controller, tracked: [] };
  } catch (error) {
    await Promise.allSettled([
      observer?.end({ timeout: 0 }) ?? Promise.resolve(),
      controller?.end({ timeout: 0 }) ?? Promise.resolve(),
    ]);
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
    await admin.end({ timeout: 0 }).catch(() => undefined);
    throw error;
  }
}

async function cleanupScratchDatabase(scratch: ScratchDatabase): Promise<void> {
  const cleanupErrors: unknown[] = [];
  try {
    await scratch.controller`SELECT pg_advisory_unlock_all()`;
  } catch (error) {
    cleanupErrors.push(error);
  }

  let dropped = false;
  if (!(await settlesWithin(scratch.tracked, SCRATCH_DRAIN_TIMEOUT_MS))) {
    try {
      await scratch.admin.unsafe(`DROP DATABASE IF EXISTS ${scratch.name} WITH (FORCE)`);
      dropped = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (!(await settlesWithin(scratch.tracked, SCRATCH_DRAIN_TIMEOUT_MS))) {
      cleanupErrors.push(new Error("migration promises did not settle after force-dropping the scratch database"));
    }
  }

  const connectionCleanup = await Promise.allSettled([
    scratch.observer.end({ timeout: 0 }),
    scratch.controller.end({ timeout: 0 }),
  ]);
  for (const result of connectionCleanup) {
    if (result.status === "rejected") cleanupErrors.push(result.reason);
  }

  if (!dropped) {
    try {
      await scratch.admin<Array<{ pg_terminate_backend: boolean }>>`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = ${scratch.name}
          AND backend_type = 'client backend'
          AND pid <> pg_backend_pid()
      `;
      await scratch.admin.unsafe(`DROP DATABASE IF EXISTS ${scratch.name} WITH (FORCE)`);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (!(await settlesWithin(scratch.tracked, SCRATCH_DRAIN_TIMEOUT_MS))) {
    cleanupErrors.push(new Error("migration promises did not settle during scratch database cleanup"));
  }
  try {
    await scratch.admin.end({ timeout: 0 });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "scratch database cleanup failed");
}

async function withScratchDatabase(run: (scratch: ScratchDatabase) => Promise<void>): Promise<void> {
  const scratch = await createScratchDatabase();
  const body = track(run(scratch));
  let hasPrimaryError = false;
  let primaryError: unknown;
  if (await settlesWithin([body], SCRATCH_BODY_TIMEOUT_MS)) {
    const outcome = await body;
    if (outcome.status === "rejected") {
      hasPrimaryError = true;
      primaryError = outcome.reason;
    }
  } else {
    hasPrimaryError = true;
    primaryError = new Error(`scratch test body did not settle within ${SCRATCH_BODY_TIMEOUT_MS}ms`);
  }

  const cleanupErrors: unknown[] = [];
  try {
    await cleanupScratchDatabase(scratch);
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError);
  }
  if (!(await settlesWithin([body], 2_000))) {
    cleanupErrors.push(new Error("scratch test body remained pending after cleanup"));
  }

  if (hasPrimaryError && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], "test and scratch cleanup both failed");
  }
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "scratch cleanup failed");
}

describe("startup migration advisory lock", () => {
  it("times out a contending session, leaves no waiter, then succeeds after release", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set by global setup").toBeTruthy();
    const url = databaseUrl ?? "";
    const applicationName = `ft_migration_contender_${randomUUID().slice(0, 8)}`;
    const contenderUrl = databaseUrlWithApplicationName(url, applicationName);
    const holder = postgres(url, { max: 1, ...sslOptions(url) });
    const observer = postgres(url, { max: 1, ...sslOptions(url) });
    let holderReleased = false;
    try {
      await holder`SELECT pg_advisory_lock(hashtext('drizzle_migrations'))`;
      const startedAt = performance.now();

      await expect(runMigrations(contenderUrl, { lockTimeoutMs: 2_000 })).rejects.toThrow(/migration lock contention/);

      const elapsedMs = performance.now() - startedAt;
      expect(elapsedMs).toBeGreaterThanOrEqual(1_800);
      expect(elapsedMs).toBeLessThan(5_000);
      const sessions = await observer<Array<{ count: number }>>`
        SELECT count(*)::int AS count
        FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = ${applicationName}
      `;
      expect(sessions[0]?.count).toBe(0);

      await holder`SELECT pg_advisory_unlock(hashtext('drizzle_migrations'))`;
      holderReleased = true;
      await expect(runMigrations(contenderUrl, { lockTimeoutMs: 2_000 })).resolves.toBeGreaterThan(0);
    } finally {
      if (!holderReleased) {
        await holder`SELECT pg_advisory_unlock(hashtext('drizzle_migrations'))`.catch(() => undefined);
      }
      await Promise.allSettled([holder.end({ timeout: 0 }), observer.end({ timeout: 0 })]);
    }
  });

  it("cancels a queued initial reconnect without creating a backend after returning", {
    timeout: RECONNECT_CASE_TIMEOUT_MS,
  }, async () => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set by global setup").toBeTruthy();
    const url = databaseUrl ?? "";
    const applicationName = `ft_migration_reconnect_${randomUUID().slice(0, 8)}`;
    const holder = postgres(url, { max: 1, ...sslOptions(url) });
    const observer = postgres(url, { max: 1, ...sslOptions(url) });
    const tcpGate = await createTcpForwardingGate(url);
    const migrationUrl = new URL(url);
    migrationUrl.hostname = "127.0.0.1";
    migrationUrl.port = String(tcpGate.port);
    migrationUrl.searchParams.set("application_name", applicationName);
    migrationUrl.searchParams.set("backoff", String(RECONNECT_BACKOFF_MS / 1_000));

    let holderLocked = false;
    let migrationSettled = false;
    let migration: Promise<Outcome<number>> | undefined;
    let hasPrimaryError = false;
    let primaryError: unknown;
    try {
      await holder`SELECT pg_advisory_lock(hashtext('drizzle_migrations'))`;
      holderLocked = true;
      const startedAt = performance.now();
      migration = track(runMigrations(migrationUrl.toString(), { lockTimeoutMs: RECONNECT_LOCK_TIMEOUT_MS })).then(
        (outcome) => {
          migrationSettled = true;
          return outcome;
        },
      );

      const firstBackend = await waitForBackendState(
        observer,
        applicationName,
        (state) => state.state === "idle" && /pg_try_advisory_lock/i.test(state.query),
        "the first migration lock miss before forcing a reconnect",
      );
      expect(tcpGate.acceptedConnections()).toBeGreaterThan(0);
      const closesBeforeTermination = tcpGate.downstreamCloses();
      const terminated = await observer<Array<{ terminated: boolean }>>`
          SELECT pg_terminate_backend(${firstBackend.pid}) AS terminated
        `;
      expect(terminated[0]?.terminated).toBe(true);
      const closeObservation = await tcpGate.waitForDownstreamCloseAfter(closesBeforeTermination, 2_000);
      tcpGate.setForwarding(false);
      await waitForNoBackend(observer, applicationName);

      // The first lock miss has completed and the migration-side socket has
      // observably closed. The acquisition loop sleeps for at most one second
      // before submitting its next try-lock query, so a full 1.25 seconds from
      // this close proves that query has entered postgres-js's initial
      // reconnect state. Keep a separate margin before the watchdog so the
      // critical setup cannot be inferred merely from a still-pending promise.
      const watchdogDeadline = startedAt + RECONNECT_LOCK_TIMEOUT_MS;
      const secondPollSubmittedBy = closeObservation.closedAt + RECONNECT_SECOND_POLL_WAIT_MS;
      expect(RECONNECT_BACKOFF_MS - RECONNECT_LOCK_TIMEOUT_MS).toBeGreaterThan(RECONNECT_RETURN_GRACE_MS);
      expect(watchdogDeadline - secondPollSubmittedBy).toBeGreaterThan(RECONNECT_RETURN_GRACE_MS);
      const acceptedAfterClose = tcpGate.acceptedConnections();
      while (performance.now() < secondPollSubmittedBy) {
        await delay(Math.ceil(secondPollSubmittedBy - performance.now()));
      }
      expect(performance.now()).toBeGreaterThanOrEqual(secondPollSubmittedBy);
      expect(watchdogDeadline - performance.now()).toBeGreaterThan(RECONNECT_RETURN_GRACE_MS);
      expect(tcpGate.acceptedConnections()).toBe(acceptedAfterClose);
      expect(migrationSettled).toBe(false);

      const migrationReturnDeadline = watchdogDeadline + RECONNECT_RETURN_GRACE_MS;
      const migrationReturnBudget = Math.max(1, migrationReturnDeadline - performance.now());
      const boundedOutcome = await valueWithin(migration, migrationReturnBudget);
      if (boundedOutcome.kind === "timed-out") {
        throw new Error(
          `migration reconnect regression did not settle by ${RECONNECT_RETURN_GRACE_MS}ms after its watchdog`,
        );
      }
      const outcome = boundedOutcome.value;
      const elapsedMs = performance.now() - startedAt;
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(outcome.reason).toBeInstanceOf(Error);
        if (outcome.reason instanceof Error) expect(outcome.reason.message).toMatch(/migration lock contention/);
      }
      expect(elapsedMs).toBeGreaterThanOrEqual(RECONNECT_LOCK_TIMEOUT_MS - 300);
      expect(elapsedMs).toBeLessThan(RECONNECT_LOCK_TIMEOUT_MS + 750);
      expect(await readBackendStates(observer, applicationName)).toEqual([]);

      const acceptedAtRejection = tcpGate.acceptedConnections();
      tcpGate.setForwarding(true);
      await delay(RECONNECT_OBSERVATION_MS);
      expect(tcpGate.acceptedConnections()).toBe(acceptedAtRejection);
      expect(await readBackendStates(observer, applicationName)).toEqual([]);
    } catch (error) {
      hasPrimaryError = true;
      primaryError = error;
    }

    const cleanupErrors: unknown[] = [];
    tcpGate.setForwarding(false);
    try {
      await tcpGate.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await observer<Array<{ terminated: boolean }>>`
          SELECT pg_terminate_backend(pid) AS terminated
          FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = ${applicationName}
        `;
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (holderLocked) {
      try {
        await holder`SELECT pg_advisory_unlock_all()`;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    const connectionCleanup = await Promise.allSettled([holder.end({ timeout: 0 }), observer.end({ timeout: 0 })]);
    for (const result of connectionCleanup) {
      if (result.status === "rejected") cleanupErrors.push(result.reason);
    }
    if (migration !== undefined && !(await settlesWithin([migration], RECONNECT_DRAIN_TIMEOUT_MS))) {
      cleanupErrors.push(new Error("migration reconnect regression did not settle after forced cleanup"));
    }

    if (hasPrimaryError && cleanupErrors.length > 0) {
      throw new AggregateError([primaryError, ...cleanupErrors], "test and reconnect cleanup both failed");
    }
    if (hasPrimaryError) throw primaryError;
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "reconnect cleanup failed");
  });

  it("serializes two real migrations through the final journal commit", {
    timeout: SCRATCH_CASE_TIMEOUT_MS,
  }, async () => {
    await withScratchDatabase(async (scratch) => {
      const replicaAUrl = databaseUrlWithApplicationName(scratch.url, REPLICA_A);
      const replicaBUrl = databaseUrlWithApplicationName(scratch.url, REPLICA_B);
      const replicaA = track(runMigrations(replicaAUrl));
      scratch.tracked.push(replicaA);

      const stateA = await waitForBackendState(
        scratch.observer,
        REPLICA_A,
        (state) =>
          state.holds_migration_lock &&
          state.waits_final_insert_gate &&
          state.wait_event_type === "Lock" &&
          state.wait_event === "advisory" &&
          /insert into "drizzle"\."__drizzle_migrations"/i.test(state.query),
        "replica A at the final journal insert while holding the migration lock",
      );
      expect(await readJournalWhens(scratch.observer)).toEqual([]);

      let replicaBSettled = false;
      const replicaB = track(runMigrations(replicaBUrl)).then((outcome) => {
        replicaBSettled = true;
        return outcome;
      });
      scratch.tracked.push(replicaB);
      await waitForBackendState(
        scratch.observer,
        REPLICA_B,
        (state) => /pg_try_advisory_lock/i.test(state.query),
        "replica B to attempt the migration lock",
      );

      await delay(1_250);
      expect(replicaBSettled).toBe(false);
      const blockedBStates = await readBackendStates(scratch.observer, REPLICA_B);
      expect(blockedBStates.some((state) => state.waits_replica_b_ddl_gate)).toBe(false);

      await releaseGate(scratch.controller, FINAL_INSERT_GATE);
      const stateB = await waitForBackendState(
        scratch.observer,
        REPLICA_B,
        (state) => state.holds_migration_lock && state.waits_replica_b_ddl_gate && /create schema/i.test(state.query),
        "replica B at its real Drizzle DDL after replica A committed",
      );
      expect(stateB.pid).not.toBe(stateA.pid);
      expect(await readJournalWhens(scratch.observer)).toEqual(expectedJournalWhens);

      await releaseGate(scratch.controller, REPLICA_B_DDL_GATE);
      const [outcomeA, outcomeB] = await Promise.all([replicaA, replicaB]);
      expect(outcomeA.status).toBe("fulfilled");
      expect(outcomeB.status).toBe("fulfilled");
      if (outcomeA.status === "fulfilled" && outcomeB.status === "fulfilled") {
        expect(outcomeA.value).toBeGreaterThan(0);
        expect(outcomeB.value).toBe(outcomeA.value);
      }
      expect(await readJournalWhens(scratch.observer)).toEqual(expectedJournalWhens);
    });
  });

  it("fails closed on backend loss without reconnecting and allows a later replica to recover", {
    timeout: SCRATCH_CASE_TIMEOUT_MS,
  }, async () => {
    await withScratchDatabase(async (scratch) => {
      const replicaAUrl = databaseUrlWithApplicationName(scratch.url, REPLICA_A);
      const replicaBUrl = databaseUrlWithApplicationName(scratch.url, REPLICA_B);
      const replicaA = track(runMigrations(replicaAUrl));
      scratch.tracked.push(replicaA);

      const stateA = await waitForBackendState(
        scratch.observer,
        REPLICA_A,
        (state) => state.holds_migration_lock && state.waits_final_insert_gate,
        "replica A at the final journal gate before backend termination",
      );

      const replicaB = track(runMigrations(replicaBUrl));
      scratch.tracked.push(replicaB);
      const waitingStateB = await waitForBackendState(
        scratch.observer,
        REPLICA_B,
        (state) => /pg_try_advisory_lock/i.test(state.query),
        "replica B to contend for replica A's migration lock",
      );
      expect(
        (await readBackendStates(scratch.observer, REPLICA_B)).some((state) => state.waits_replica_b_ddl_gate),
      ).toBe(false);

      const terminated = await scratch.observer<Array<{ terminated: boolean }>>`
        SELECT pg_terminate_backend(${stateA.pid}) AS terminated
      `;
      expect(terminated[0]?.terminated).toBe(true);

      const outcomeA = await replicaA;
      expect(outcomeA.status).toBe("rejected");
      await waitForNoBackend(scratch.observer, REPLICA_A);
      const recoveredStateB = await waitForBackendState(
        scratch.observer,
        REPLICA_B,
        (state) => state.holds_migration_lock && state.waits_replica_b_ddl_gate,
        "the already-contending replica B to acquire the released session lock",
      );
      expect(recoveredStateB.pid).toBe(waitingStateB.pid);
      await delay(1_250);
      expect(await readBackendStates(scratch.observer, REPLICA_A)).toEqual([]);
      expect(await readJournalWhens(scratch.observer)).toEqual([]);

      await releaseGate(scratch.controller, FINAL_INSERT_GATE);
      await releaseGate(scratch.controller, REPLICA_B_DDL_GATE);
      const outcomeB = await replicaB;
      expect(outcomeB.status).toBe("fulfilled");
      if (outcomeB.status === "fulfilled") expect(outcomeB.value).toBeGreaterThan(0);
      expect(await readJournalWhens(scratch.observer)).toEqual(expectedJournalWhens);
    });
  });

  it("succeeds when the advisory lock is free", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    expect(databaseUrl, "DATABASE_URL must be set by global setup").toBeTruthy();
    await expect(runMigrations(databaseUrl ?? "")).resolves.toBeGreaterThan(0);
  });
});
