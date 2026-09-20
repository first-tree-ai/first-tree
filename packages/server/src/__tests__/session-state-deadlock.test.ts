import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { type Database, sslOptions } from "../db/connection.js";
import { createAgent } from "../services/agents/identity.js";
import { createChat } from "../services/chat/conversation.js";
import { lockChatSpeakerSnapshot } from "../services/chat/membership/lock.js";
import { upsertSessionState } from "../services/chat/sessions/activity.js";
import type { Notifier } from "../services/notifier.js";
import { createAdminContext, useTestApp } from "./helpers.js";
import { readPresence, readSessionState } from "./session-state-helpers.js";

/**
 * Regression coverage for session-state lock ordering and transaction retry.
 *
 * Production diagnosis: `upsertSessionState`'s session INSERT implicitly
 * locked `agents` then `chats` (FK KEY SHARE), while the
 * GitHub snapshot path (`lockChatMembershipAndAgentRows`) locked `chats`
 * FOR UPDATE then `agents` FOR UPDATE — a classic lock-order inversion that
 * Aurora PostgreSQL 17 aborted with 40P01. The fix (a) takes explicit
 * chat-then-agent FOR KEY SHARE pre-locks inside the upsert transaction and
 * (b) retries the whole transaction on SQLSTATE 40P01 only, up to 3 total
 * attempts, with notifications emitted only after a successful changed
 * commit.
 */

function makeNotifier(): Notifier {
  return {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    notify: vi.fn(async () => {}),
    notifyStrict: vi.fn(async () => {}),
    notifyConfigChange: vi.fn(async () => {}),
    notifySessionStateChange: vi.fn(async () => {}),
    notifyRuntimeStateChange: vi.fn(async () => {}),
    notifySessionRuntime: vi.fn(async () => {}),
    notifyChatMessage: vi.fn(async () => {}),
    notifyChatAudience: vi.fn(async () => {}),
    notifyChatUpdated: vi.fn(async () => {}),
    notifyMeChatsChanged: vi.fn(async () => {}),
    notifyMembershipChanged: vi.fn(async () => {}),
    notifyAgentRouteChange: vi.fn(async () => {}),
    notifyDaemonClientCommand: vi.fn(async () => {}),
    notifyDaemonClientCommandResult: vi.fn(async () => {}),
    notifySessionEvent: vi.fn(async () => {}),
    pushFrameToInbox: vi.fn(async () => 0),
    onConfigChange: vi.fn(),
    onSessionStateChange: vi.fn(),
    onSessionEvent: vi.fn(),
    onRuntimeStateChange: vi.fn(),
    onSessionRuntime: vi.fn(),
    onChatMessage: vi.fn(),
    onChatAudience: vi.fn(),
    onChatUpdated: vi.fn(),
    onMeChatsChanged: vi.fn(),
    onMembershipChanged: vi.fn(),
    onAgentRouteChange: vi.fn(),
    onDaemonClientCommand: vi.fn(),
    onDaemonClientCommandResult: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  } satisfies Notifier;
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out — possible deadlock`)), 15_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fabricate a PostgreSQL-flavored error: an Error carrying a SQLSTATE
 * `code`, like postgres-js's PostgresError. Used where the test's focus is
 * the retry predicate, not the driver; driver-real 40P01s are covered by
 * the trigger-injected tests below.
 */
function makePgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** Two errors whose `cause` chains point at each other. */
function makeCyclicError(opts: { withDeadlockCode: boolean }): Error {
  const first = new Error("cycle: first");
  const second = Object.assign(new Error("cycle: second"), opts.withDeadlockCode ? { code: "40P01" } : {});
  Object.assign(first, { cause: second });
  Object.assign(second, { cause: first });
  return first;
}

/**
 * Wrap a Database so each `transaction()` invocation is counted and can
 * inject deterministic failures. `failures[i]` (0-based by attempt) is
 * thrown AFTER the attempt's callback has completed its real work inside a
 * real transaction, so the injection rolls the whole attempt back exactly
 * like a deadlock detected late in (or at) commit. `onError` runs between a
 * failed attempt's rollback and the retry decision, letting a test wrap the
 * error (cause chains) or interleave a committed write before the replay.
 * Only `transaction` is intercepted; every other property is forwarded to
 * the real database.
 */
function interceptTransactions(
  db: Database,
  options: {
    failures?: ReadonlyArray<(() => unknown) | undefined>;
    onError?: (error: unknown, attempt: number) => unknown | Promise<unknown>;
  } = {},
): { db: Database; attempts: () => number } {
  let attempts = 0;
  const proxied = new Proxy(db, {
    get(target, prop) {
      if (prop !== "transaction") {
        const value: unknown = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (callback: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
        const attempt = ++attempts;
        try {
          return await target.transaction(async (tx) => {
            const result: unknown = await callback(tx);
            const inject = options.failures?.[attempt - 1];
            if (inject) throw inject();
            return result;
          });
        } catch (error) {
          if (!options.onError) throw error;
          throw await options.onError(error, attempt);
        }
      };
    },
  });
  return { db: proxied, attempts: () => attempts };
}

/**
 * Install a temporary BEFORE INSERT trigger on `agent_presence` that raises
 * the given SQLSTATE for the first `failFirst` firing(s) (use a large
 * number to fail every attempt). A sequence counts firings across
 * transaction boundaries (sequences survive rollback), so `calls()` doubles
 * as an attempt counter. Always `drop()` in a finally.
 */
async function installPresenceFailureTrigger(
  app: FastifyInstance,
  suffix: string,
  opts: { failFirst: number; errcode?: string },
): Promise<{ calls: () => Promise<number>; drop: () => Promise<void> }> {
  const seq = `test_upsert_dl_${suffix}_seq`;
  const fn = `test_upsert_dl_${suffix}_fn`;
  const trg = `test_upsert_dl_${suffix}_trg`;
  const errcode = opts.errcode ?? "40P01";
  await app.db.execute(sql.raw(`CREATE SEQUENCE ${seq}`));
  await app.db.execute(
    sql.raw(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        IF nextval('${seq}') <= ${opts.failFirst} THEN
          RAISE EXCEPTION 'injected session-state test failure' USING ERRCODE = '${errcode}';
        END IF;
        RETURN NEW;
      END $body$`),
  );
  await app.db.execute(
    sql.raw(`CREATE TRIGGER ${trg} BEFORE INSERT ON agent_presence FOR EACH ROW EXECUTE FUNCTION ${fn}()`),
  );
  return {
    calls: async () => {
      const rows = await app.db.execute<{ last_value: string }>(sql.raw(`SELECT last_value FROM ${seq}`));
      return Number(rows[0]?.last_value ?? "0");
    },
    drop: async () => {
      await app.db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${trg} ON agent_presence`));
      await app.db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${fn}()`));
      await app.db.execute(sql.raw(`DROP SEQUENCE IF EXISTS ${seq}`));
    },
  };
}

/**
 * Walk an error + cause chain for a SQLSTATE — mirrors the production
 * narrowing (drizzle wraps PostgresError in DrizzleQueryError, so the code
 * is never at a fixed depth).
 */
function chainHasSqlstate(error: unknown, code: string): boolean {
  const visited = new Set<object>();
  let current: unknown = error;
  while (current !== null && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    if (Reflect.get(current, "code") === code) return true;
    current = Reflect.get(current, "cause");
  }
  return false;
}

async function expectRejectsWithSqlstate(promise: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  if (error === null) throw new Error(`expected rejection with SQLSTATE ${code}, but the promise resolved`);
  expect(chainHasSqlstate(error, code)).toBe(true);
}

/**
 * Observe the staged snapshot's lock waiter in this worker's database.
 * The polling interval only sets observation cadence, not interleaving.
 */
async function waitForSnapshotBlock(probe: postgres.Sql, blockerPid: number, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = await probe`
      SELECT count(*)::int AS waiters
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND ${blockerPid} = ANY(pg_blocking_pids(pid))`;
    if (row && Number(row.waiters) > 0) return;
    if (Date.now() > deadline) throw new Error(`${label} did not wait for the snapshot lock in time`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("upsertSessionState — deadlock repair", () => {
  const getApp = useTestApp();

  async function setupAgentChat() {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `dl-${crypto.randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `dl-target-${crypto.randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Deadlock target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, {
      type: "group",
      participantIds: [agent.uuid],
    });
    return { app, admin, agent, chat };
  }

  // The production interleaving, staged deterministically: a membership
  // snapshot holds the chat row FOR UPDATE (phase 1 of
  // `lockChatMembershipAndAgentRows`), the upsert must block on its chat
  // FOR KEY SHARE pre-lock while holding NOTHING else, then the snapshot
  // takes the agent row FOR UPDATE (phase 2) and commits. Pre-fix, the
  // upsert's INSERT already held the agent's KEY SHARE at that point, so
  // phase 2 deadlocked (PostgreSQL aborts one side with 40P01 — this test
  // uses NOWAIT to reject that lock inversion before retry can conceal it).
  // Post-fix both transactions complete.
  it("locks chat before agent so a concurrent membership snapshot cannot deadlock it", async () => {
    const { app, admin, agent, chat } = await setupAgentChat();

    const url = process.env.DATABASE_URL ?? "";
    const snapshot = postgres(url, { max: 1, ...sslOptions(url) });
    const probe = postgres(url, { max: 1, ...sslOptions(url) });
    const notifier = makeNotifier();
    let upsertPromise: Promise<void> | undefined;
    let snapshotInTransaction = false;
    try {
      await snapshot`BEGIN`;
      snapshotInTransaction = true;
      const [backend] = await snapshot<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (!backend) throw new Error("Missing snapshot backend pid");
      // Snapshot phase 1 (mirrors lockChatMembershipAndAgentRows): chat FOR UPDATE.
      await snapshot`SELECT id FROM chats WHERE id = ${chat.id} FOR UPDATE`;

      upsertPromise = upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId, notifier);

      await waitForSnapshotBlock(probe, backend.pid, "upsert behind snapshot chat lock");

      // Snapshot phase 2: agent FOR UPDATE. Pre-fix this deadlocks against
      // the upsert's held agent KEY SHARE; post-fix the upsert holds no
      // agent lock yet, so this succeeds.
      await snapshot`SELECT uuid FROM agents WHERE uuid = ${agent.uuid} FOR UPDATE NOWAIT`;
      await snapshot`COMMIT`;
      snapshotInTransaction = false;

      await withTimeout(upsertPromise, "upsertSessionState behind chat FOR UPDATE");
    } finally {
      if (snapshotInTransaction) await snapshot`ROLLBACK`.catch(() => undefined);
      await Promise.allSettled([upsertPromise].filter((promise) => promise !== undefined));
      await snapshot.end({ timeout: 1 }).catch(() => undefined);
      await probe.end({ timeout: 1 }).catch(() => undefined);
    }

    // Both sides completed; the upsert landed after the snapshot released.
    expect(await readSessionState(app, agent.uuid, chat.id)).toBe("active");
    const presence = await readPresence(app, agent.uuid);
    expect(presence?.activeSessions).toBe(1);
    expect(presence?.totalSessions).toBe(1);
    expect(notifier.notifySessionStateChange).toHaveBeenCalledTimes(1);
    expect(notifier.notifySessionStateChange).toHaveBeenCalledWith(agent.uuid, chat.id, "active", admin.organizationId);
  });

  // Same guarantee through the real exported snapshot helper instead of a
  // hand-staged phase split: a transaction holding the full
  // `lockChatSpeakerSnapshot` lock set (advisory fence + chats FOR UPDATE +
  // memberships FOR UPDATE + agents FOR UPDATE) must only ever *delay* the
  // upsert, never deadlock it.
  it("completes behind the real lockChatSpeakerSnapshot lock set once it commits", async () => {
    const { app, admin, agent, chat } = await setupAgentChat();

    const url = process.env.DATABASE_URL ?? "";
    const probe = postgres(url, { max: 1, ...sslOptions(url) });
    const notifier = makeNotifier();
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    let releaseSnapshot!: () => void;
    const holdOpen = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });

    let snapshotPid: number | undefined;
    const snapshotPromise = app.db.transaction(async (tx) => {
      await lockChatSpeakerSnapshot(tx, [chat.id]);
      const [backend] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      if (!backend) throw new Error("Missing snapshot backend pid");
      snapshotPid = backend.pid;
      markLocked();
      await holdOpen;
    });

    let upsertPromise: Promise<void> | undefined;
    try {
      await withTimeout(locked, "speaker snapshot lock acquisition");
      if (snapshotPid === undefined) throw new Error("Missing locked snapshot pid");
      upsertPromise = upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId, notifier);
      await waitForSnapshotBlock(probe, snapshotPid, "upsert behind speaker snapshot");
      releaseSnapshot();
      await withTimeout(upsertPromise, "upsert behind speaker snapshot");
      await withTimeout(snapshotPromise, "speaker snapshot commit");
    } finally {
      releaseSnapshot();
      await Promise.allSettled([upsertPromise, snapshotPromise].filter((promise) => promise !== undefined));
      await probe.end({ timeout: 1 }).catch(() => undefined);
    }

    expect(await readSessionState(app, agent.uuid, chat.id)).toBe("active");
    expect(notifier.notifySessionStateChange).toHaveBeenCalledTimes(1);
  });

  // Whole-transaction retry against a driver-real 40P01: the first attempt
  // completes the session INSERT and is then aborted at the presence write;
  // the replay must redo everything (exactly one consistent commit), and
  // the notification fires exactly once for the call.
  it("retries the whole transaction once on a real 40P01 and notifies exactly once", async () => {
    const { app, admin, agent, chat } = await setupAgentChat();
    const trigger = await installPresenceFailureTrigger(app, "once", { failFirst: 1 });
    const notifier = makeNotifier();
    let calls = 0;
    try {
      await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId, notifier);
      calls = await trigger.calls();
    } finally {
      await trigger.drop();
    }

    // Exactly two trigger firings: attempt 1 aborted, attempt 2 committed.
    expect(calls).toBe(2);
    expect(await readSessionState(app, agent.uuid, chat.id)).toBe("active");
    const presence = await readPresence(app, agent.uuid);
    // Rolled-back attempt 1 must not double-apply the aggregate refresh.
    expect(presence?.activeSessions).toBe(1);
    expect(presence?.totalSessions).toBe(1);
    expect(notifier.notifySessionStateChange).toHaveBeenCalledTimes(1);
    expect(notifier.notifySessionStateChange).toHaveBeenCalledWith(agent.uuid, chat.id, "active", admin.organizationId);
    // An "active" upsert never revokes the runtime axis.
    expect(notifier.notifySessionRuntime).not.toHaveBeenCalled();
  });

  // The retry predicate must find the SQLSTATE anywhere along the cause
  // chain — here the driver-real 40P01 is wrapped twice before it reaches
  // upsertSessionState.
  it("retries when the 40P01 reaches the caller wrapped in a cause chain", async () => {
    const { app, admin, agent, chat } = await setupAgentChat();
    const trigger = await installPresenceFailureTrigger(app, "wrapped", { failFirst: 1 });
    const notifier = makeNotifier();
    const { db: proxiedDb, attempts } = interceptTransactions(app.db, {
      onError: (error) =>
        new Error("drizzle transaction failed", { cause: new Error("postgres.js query failed", { cause: error }) }),
    });
    try {
      await upsertSessionState(proxiedDb, agent.uuid, chat.id, "active", admin.organizationId, notifier);
    } finally {
      await trigger.drop();
    }

    expect(attempts()).toBe(2);
    expect(await readSessionState(app, agent.uuid, chat.id)).toBe("active");
    expect(notifier.notifySessionStateChange).toHaveBeenCalledTimes(1);
  });

  // Bounded retry: a persistent 40P01 exhausts the 3 total attempts and the
  // original error propagates — nothing commits, nothing notifies.
  it("gives up after 3 total attempts on persistent 40P01 and commits nothing", async () => {
    const { app, admin, agent, chat } = await setupAgentChat();
    const trigger = await installPresenceFailureTrigger(app, "exhaust", { failFirst: 100 });
    const notifier = makeNotifier();
    let calls = 0;
    try {
      await expectRejectsWithSqlstate(
        upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId, notifier),
        "40P01",
      );
      calls = await trigger.calls();
    } finally {
      await trigger.drop();
    }

    expect(calls).toBe(3);
    expect(await readSessionState(app, agent.uuid, chat.id)).toBeNull();
    expect(await readPresence(app, agent.uuid)).toBeUndefined();
    expect(notifier.notifySessionStateChange).not.toHaveBeenCalled();
    expect(notifier.notifySessionRuntime).not.toHaveBeenCalled();
  });

  // Only 40P01 is retried — any other SQLSTATE propagates immediately.
  it("does not retry non-deadlock SQLSTATEs", async () => {
    const { app, admin, agent, chat } = await setupAgentChat();
    const trigger = await installPresenceFailureTrigger(app, "plain", { failFirst: 1, errcode: "P0001" });
    const notifier = makeNotifier();
    let calls = 0;
    try {
      await expectRejectsWithSqlstate(
        upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId, notifier),
        "P0001",
      );
      calls = await trigger.calls();
    } finally {
      await trigger.drop();
    }

    expect(calls).toBe(1);
    expect(await readSessionState(app, agent.uuid, chat.id)).toBeNull();
    expect(notifier.notifySessionStateChange).not.toHaveBeenCalled();
  });

  // Cycle protection in the cause walk: a cyclic chain without a 40P01 must
  // propagate untouched after a single attempt (no hang, no retry).
  it("does not retry a cyclic cause chain that never carries 40P01", async () => {
    const { app, admin, agent, chat } = await setupAgentChat();
    const cyclic = makeCyclicError({ withDeadlockCode: false });
    const notifier = makeNotifier();
    const { db: proxiedDb, attempts } = interceptTransactions(app.db, { failures: [() => cyclic] });

    await expect(
      upsertSessionState(proxiedDb, agent.uuid, chat.id, "active", admin.organizationId, notifier),
    ).rejects.toBe(cyclic);

    expect(attempts()).toBe(1);
    expect(await readSessionState(app, agent.uuid, chat.id)).toBeNull();
    expect(notifier.notifySessionStateChange).not.toHaveBeenCalled();
  });

  // …but a 40P01 found before the cycle closes must still trigger a retry.
  it("retries a 40P01 found inside a cyclic cause chain", async () => {
    const { app, admin, agent, chat } = await setupAgentChat();
    const notifier = makeNotifier();
    const { db: proxiedDb, attempts } = interceptTransactions(app.db, {
      failures: [() => makeCyclicError({ withDeadlockCode: true })],
    });

    await upsertSessionState(proxiedDb, agent.uuid, chat.id, "active", admin.organizationId, notifier);

    expect(attempts()).toBe(2);
    expect(await readSessionState(app, agent.uuid, chat.id)).toBe("active");
    expect(notifier.notifySessionStateChange).toHaveBeenCalledTimes(1);
  });

  // Attempt-local projectionChanged: attempt 1 changes the projection but
  // rolls back; before the replay, a third party commits the same state, so
  // the replayed attempt is a same-state no-op. No notification may leak
  // from either attempt.
  it("emits no notification when the replayed attempt becomes a same-state no-op", async () => {
    const { app, admin, agent, chat } = await setupAgentChat();
    const notifier = makeNotifier();
    const { db: proxiedDb, attempts } = interceptTransactions(app.db, {
      failures: [() => makePgError("40P01", "deadlock detected")],
      onError: async (error, attempt) => {
        if (attempt === 1) {
          // The whole attempt-1 transaction must have rolled back — its
          // session INSERT is no longer visible.
          expect(await readSessionState(app, agent.uuid, chat.id)).toBeNull();
          // A third party commits the same state before the replay (e.g. a
          // concurrent predictive activation from another message).
          await upsertSessionState(app.db, agent.uuid, chat.id, "active", admin.organizationId);
        }
        return error;
      },
    });

    await upsertSessionState(proxiedDb, agent.uuid, chat.id, "active", admin.organizationId, notifier);

    expect(attempts()).toBe(2);
    expect(await readSessionState(app, agent.uuid, chat.id)).toBe("active");
    expect(notifier.notifySessionStateChange).not.toHaveBeenCalled();
    expect(notifier.notifySessionRuntime).not.toHaveBeenCalled();
  });

  // The FOR KEY SHARE pre-locks must not change the missing-parent
  // contract: a SELECT that matches no row takes no lock, and the INSERT
  // raises the same 23503 FK violation as before — never retried.
  it("preserves the FK-violation contract for a missing chat parent (no retry)", async () => {
    const { app, admin, agent } = await setupAgentChat();
    const { db: proxiedDb, attempts } = interceptTransactions(app.db);

    await expectRejectsWithSqlstate(
      upsertSessionState(proxiedDb, agent.uuid, crypto.randomUUID(), "active", admin.organizationId),
      "23503",
    );
    expect(attempts()).toBe(1);
  });

  it("preserves the FK-violation contract for a missing agent parent (no retry)", async () => {
    const { app, admin, chat } = await setupAgentChat();
    const { db: proxiedDb, attempts } = interceptTransactions(app.db);

    await expectRejectsWithSqlstate(
      upsertSessionState(proxiedDb, crypto.randomUUID(), chat.id, "active", admin.organizationId),
      "23503",
    );
    expect(attempts()).toBe(1);
  });
});
