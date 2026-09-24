import { describe, expect, it, vi } from "vitest";
import { type RunMigrationsDependencies, runMigrationsWithDependencies } from "../db/migrate.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type Outcome<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown };

function track<T>(promise: Promise<T>): Promise<Outcome<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

async function waitForCall(mock: ReturnType<typeof vi.fn>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (mock.mock.calls.length > 0) return;
    await Promise.resolve();
  }
  throw new Error("timed out waiting for mocked operation");
}

function makeHarness() {
  let nowMs = 0;
  let onLockAcquired: (() => void) | undefined;
  let onClose: ((connectionId: number) => void) | undefined;
  let fireWatchdog: (() => void) | undefined;
  const cancelWatchdog = vi.fn();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  const session = {
    tryAcquireLock: vi.fn(async () => true),
    migrate: vi.fn(async () => undefined),
    countTables: vi.fn(async () => 7),
    unlock: vi.fn(async () => true),
    end: vi.fn(async (_options: { timeout: 0 }) => undefined),
  };
  const openSession = vi.fn((input: Parameters<RunMigrationsDependencies["openSession"]>[0]) => {
    onLockAcquired = input.onLockAcquired;
    onClose = input.onClose;
    return session;
  });
  const dependencies: RunMigrationsDependencies = {
    openSession,
    logger,
    now: () => nowMs,
    sleep: vi.fn(async (ms: number) => {
      nowMs += ms;
    }),
    armWatchdog: vi.fn((fire: () => void, _timeoutMs: number) => {
      fireWatchdog = fire;
      return cancelWatchdog;
    }),
  };

  return {
    dependencies,
    logger,
    openSession,
    session,
    cancelWatchdog,
    advanceTime(ms: number) {
      nowMs += ms;
    },
    acquireLock() {
      if (!onLockAcquired) throw new Error("session has not been opened");
      onLockAcquired();
    },
    close(connectionId = 4242) {
      if (!onClose) throw new Error("session has not been opened");
      onClose(connectionId);
    },
    fireWatchdog() {
      if (!fireWatchdog) throw new Error("watchdog has not been armed");
      fireWatchdog();
    },
  };
}

function runHarness(harness: ReturnType<typeof makeHarness>, lockTimeoutMs?: number): Promise<number> {
  return runMigrationsWithDependencies(
    "postgres://credentials-must-not-be-logged.invalid/database",
    "/valid/migrations",
    lockTimeoutMs === undefined ? {} : { lockTimeoutMs },
    harness.dependencies,
  );
}

describe("runMigrations fixed-session lifecycle", () => {
  it("preserves the exact migration error when unlock and end both fail", async () => {
    const harness = makeHarness();
    const primary = new Error("migration failed");
    const unlockError = new Error("unlock failed");
    const endError = new Error("end failed");
    harness.session.migrate.mockRejectedValueOnce(primary);
    harness.session.unlock.mockRejectedValueOnce(unlockError);
    harness.session.end.mockRejectedValueOnce(endError);

    const outcome = await track(runHarness(harness));

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.reason).toBe(primary);
    expect(harness.session.unlock).toHaveBeenCalledTimes(1);
    expect(harness.session.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    expect(harness.logger.warn.mock.calls).toEqual([
      [{ err: unlockError }, "migration cleanup failed after primary error"],
      [{ err: endError }, "migration cleanup failed after primary error"],
    ]);
    expect(harness.cancelWatchdog).toHaveBeenCalledTimes(1);
  });

  it("fails a successful migration when advisory unlock returns false", async () => {
    const harness = makeHarness();
    harness.session.unlock.mockResolvedValueOnce(false);

    await expect(runHarness(harness)).rejects.toThrow(/unlock was not confirmed/);

    expect(harness.session.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    expect(harness.cancelWatchdog).toHaveBeenCalledTimes(1);
  });

  it("fails a successful migration with the exact advisory unlock error", async () => {
    const harness = makeHarness();
    const unlockError = new Error("unlock query failed");
    harness.session.unlock.mockRejectedValueOnce(unlockError);

    const outcome = await track(runHarness(harness));

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.reason).toBe(unlockError);
    expect(harness.session.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
  });

  it("fails a successful migration with the exact final close error", async () => {
    const harness = makeHarness();
    const endError = new Error("final close failed");
    harness.session.end.mockRejectedValueOnce(endError);

    const outcome = await track(runHarness(harness));

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.reason).toBe(endError);
    expect(harness.session.unlock).toHaveBeenCalledTimes(1);
  });

  it("does not treat an undefined cleanup rejection as success", async () => {
    const harness = makeHarness();
    harness.session.end.mockRejectedValueOnce(undefined);

    const outcome = await track(runHarness(harness));

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.reason).toBeUndefined();
    expect(harness.session.unlock).toHaveBeenCalledTimes(1);
  });

  it("poisons protected work and force-ends once when the backend closes", async () => {
    const harness = makeHarness();
    harness.session.migrate.mockImplementationOnce(async () => {
      harness.close(111);
    });
    // Exercise the re-entrancy guard: a driver may synchronously notify close
    // while force-end is being invoked.
    harness.session.end.mockImplementationOnce(async () => {
      harness.close(111);
    });

    await expect(runHarness(harness)).rejects.toThrow(
      /migration postgres-js connection 111 closed before advisory lock release was confirmed/,
    );

    expect(harness.session.countTables).not.toHaveBeenCalled();
    expect(harness.session.unlock).not.toHaveBeenCalled();
    expect(harness.session.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    expect(harness.cancelWatchdog).toHaveBeenCalledTimes(1);
  });

  it("arms the acquisition watchdog with the default timeout", async () => {
    const harness = makeHarness();

    await expect(runHarness(harness)).resolves.toBe(7);

    expect(harness.dependencies.armWatchdog).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 15_000);
    expect(harness.openSession).toHaveBeenCalledWith(expect.objectContaining({ connectTimeoutSeconds: 15 }));
  });

  it("passes a timeout override to both the watchdog and connection timer", async () => {
    const harness = makeHarness();

    await expect(runHarness(harness, 1_501)).resolves.toBe(7);

    expect(harness.dependencies.armWatchdog).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 1_501);
    expect(harness.openSession).toHaveBeenCalledWith(expect.objectContaining({ connectTimeoutSeconds: 2 }));
  });

  it("keeps connection loss primary when forced termination also fails", async () => {
    const harness = makeHarness();
    const endError = new Error("forced end failed");
    harness.session.migrate.mockImplementationOnce(async () => {
      harness.close(155);
    });
    harness.session.end.mockRejectedValueOnce(endError);

    await expect(runHarness(harness)).rejects.toThrow(
      /migration postgres-js connection 155 closed before advisory lock release was confirmed/,
    );

    expect(harness.logger.warn.mock.calls).toEqual([
      [{ err: endError }, "migration cleanup failed after primary error"],
    ]);
  });

  it("poisons a close after the lock result but before the acquire promise resolves", async () => {
    const harness = makeHarness();
    harness.session.tryAcquireLock.mockImplementationOnce(async () => {
      harness.acquireLock();
      harness.close(166);
      return true;
    });

    await expect(runHarness(harness)).rejects.toThrow(
      /migration postgres-js connection 166 closed before advisory lock release was confirmed/,
    );

    expect(harness.session.migrate).not.toHaveBeenCalled();
    expect(harness.session.unlock).not.toHaveBeenCalled();
    expect(harness.session.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    expect(harness.cancelWatchdog).toHaveBeenCalledTimes(1);
  });

  it("poisons the cleanup gap after count resolves without issuing unlock SQL", async () => {
    const harness = makeHarness();
    const count = deferred<number>();
    harness.session.countTables.mockImplementationOnce(() => count.promise);
    const outcomePromise = track(runHarness(harness));
    await waitForCall(harness.session.countTables);

    count.resolve(7);
    harness.close(222);
    const outcome = await outcomePromise;

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.reason).toEqual(
        expect.objectContaining({
          message: "migration postgres-js connection 222 closed before advisory lock release was confirmed",
        }),
      );
    }
    expect(harness.session.unlock).not.toHaveBeenCalled();
    expect(harness.session.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    expect(harness.cancelWatchdog).toHaveBeenCalledTimes(1);
  });

  it("keeps the session poisoned until an in-flight unlock is confirmed", async () => {
    const harness = makeHarness();
    const unlock = deferred<boolean>();
    harness.session.unlock.mockImplementationOnce(() => unlock.promise);
    const outcomePromise = track(runHarness(harness));
    await waitForCall(harness.session.unlock);

    harness.close(333);
    unlock.resolve(true);
    const outcome = await outcomePromise;

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.reason).toEqual(
        expect.objectContaining({
          message: "migration postgres-js connection 333 closed before advisory lock release was confirmed",
        }),
      );
    }
    expect(harness.session.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    expect(harness.cancelWatchdog).toHaveBeenCalledTimes(1);
  });

  it("does not poison an intentional bounded close after unlock", async () => {
    const harness = makeHarness();
    harness.session.end.mockImplementationOnce(async () => {
      harness.close(444);
    });

    await expect(runHarness(harness)).resolves.toBe(7);

    expect(harness.session.unlock).toHaveBeenCalledTimes(1);
    expect(harness.session.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    expect(harness.logger.info).not.toHaveBeenCalled();
    expect(harness.logger.warn).not.toHaveBeenCalled();
    expect(harness.openSession).toHaveBeenCalledWith(expect.objectContaining({ connectTimeoutSeconds: 15 }));
    expect(harness.cancelWatchdog).toHaveBeenCalledTimes(1);
  });

  it("deduplicates connection loss captured again by unlock cleanup", async () => {
    const harness = makeHarness();
    const primary = new Error("migration failed first");
    const unlock = deferred<boolean>();
    harness.session.migrate.mockRejectedValueOnce(primary);
    harness.session.unlock.mockImplementationOnce(() => unlock.promise);
    const outcomePromise = track(runHarness(harness));
    await waitForCall(harness.session.unlock);

    harness.close(455);
    unlock.resolve(true);
    const outcome = await outcomePromise;

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.reason).toBe(primary);
    expect(harness.logger.warn).toHaveBeenCalledTimes(1);
    expect(harness.logger.warn).toHaveBeenCalledWith(
      {
        err: expect.objectContaining({
          message: "migration postgres-js connection 455 closed before advisory lock release was confirmed",
        }),
      },
      "migration cleanup failed after primary error",
    );
  });

  it("logs one wait and one acquisition without polling spam or credentials", async () => {
    const harness = makeHarness();
    harness.session.tryAcquireLock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(runHarness(harness)).resolves.toBe(7);

    expect(harness.logger.info.mock.calls).toEqual([
      [
        { lockKey: "hashtext('drizzle_migrations')", timeoutMs: 15_000 },
        "waiting for migration lock held by another session",
      ],
      [
        { lockKey: "hashtext('drizzle_migrations')", waitMs: 2_000, timeoutMs: 15_000 },
        "acquired migration lock after waiting",
      ],
    ]);
    expect(JSON.stringify(harness.logger.info.mock.calls)).not.toContain("credentials-must-not-be-logged");
    expect(harness.cancelWatchdog).toHaveBeenCalledTimes(1);
  });

  it("clears the watchdog and preserves an ordinary acquisition error", async () => {
    const harness = makeHarness();
    const primary = new Error("authentication failed");
    harness.session.tryAcquireLock.mockRejectedValueOnce(primary);

    const outcome = await track(runHarness(harness));

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.reason).toBe(primary);
    expect(harness.session.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    expect(harness.cancelWatchdog).toHaveBeenCalledTimes(1);
  });

  it("force-ends and drains a pending acquisition at the hard deadline", async () => {
    const harness = makeHarness();
    const acquisition = deferred<boolean>();
    const ended = new Error("connection destroyed");
    harness.session.tryAcquireLock.mockImplementationOnce(() => acquisition.promise);
    harness.session.end.mockImplementationOnce(async () => {
      acquisition.reject(ended);
    });
    const outcomePromise = track(runHarness(harness));
    await waitForCall(harness.session.tryAcquireLock);

    harness.fireWatchdog();
    const outcome = await outcomePromise;

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.reason).toEqual(
        expect.objectContaining({ message: "migration lock acquisition timed out after 15000ms" }),
      );
    }
    expect(harness.session.migrate).not.toHaveBeenCalled();
    expect(harness.session.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    expect(harness.cancelWatchdog).toHaveBeenCalledTimes(1);
  });

  it("rejects a lock acquired after the hard deadline before migration starts", async () => {
    const harness = makeHarness();
    harness.session.tryAcquireLock.mockImplementationOnce(async () => {
      harness.acquireLock();
      harness.advanceTime(15_000);
      return true;
    });

    await expect(runHarness(harness)).rejects.toThrow(/migration lock acquisition timed out after 15000ms/);

    expect(harness.session.migrate).not.toHaveBeenCalled();
    expect(harness.session.unlock).not.toHaveBeenCalled();
    expect(harness.session.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
    expect(harness.cancelWatchdog).toHaveBeenCalledTimes(1);
  });

  it("retains contention diagnostics when a lock miss arrives at the hard deadline", async () => {
    const harness = makeHarness();
    harness.session.tryAcquireLock.mockImplementationOnce(async () => {
      harness.advanceTime(15_000);
      return false;
    });

    await expect(runHarness(harness)).rejects.toThrow(/migration lock contention/);

    expect(harness.session.tryAcquireLock).toHaveBeenCalledTimes(1);
    expect(harness.session.migrate).not.toHaveBeenCalled();
    expect(harness.logger.info.mock.calls).toEqual([
      [
        { lockKey: "hashtext('drizzle_migrations')", timeoutMs: 15_000 },
        "waiting for migration lock held by another session",
      ],
    ]);
    expect(harness.session.end).toHaveBeenCalledExactlyOnceWith({ timeout: 0 });
  });

  it("reports contention when the hard deadline fires while sleeping after a miss", async () => {
    const harness = makeHarness();
    const sleep = deferred<void>();
    harness.session.tryAcquireLock.mockResolvedValueOnce(false);
    harness.dependencies.sleep = vi.fn(async (_ms: number, terminalSignal: Promise<void>) => {
      await Promise.race([sleep.promise, terminalSignal]);
    });
    const outcomePromise = track(runHarness(harness));
    await waitForCall(harness.dependencies.sleep as ReturnType<typeof vi.fn>);

    harness.fireWatchdog();
    sleep.resolve();
    const outcome = await outcomePromise;

    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") {
      expect(outcome.reason).toEqual(
        expect.objectContaining({ message: expect.stringMatching(/migration lock contention/) }),
      );
    }
    expect(harness.session.tryAcquireLock).toHaveBeenCalledTimes(1);
    expect(harness.logger.info.mock.calls).toEqual([
      [
        { lockKey: "hashtext('drizzle_migrations')", timeoutMs: 15_000 },
        "waiting for migration lock held by another session",
      ],
    ]);
    expect(harness.cancelWatchdog).toHaveBeenCalledTimes(1);
  });

  it("clamps the connection timer at Node's safe maximum while preserving the watchdog deadline", async () => {
    const harness = makeHarness();
    const maximumTimerDelayMs = 2_147_483_647;

    await expect(runHarness(harness, maximumTimerDelayMs)).resolves.toBe(7);

    expect(harness.openSession).toHaveBeenCalledWith(expect.objectContaining({ connectTimeoutSeconds: 2_147_483 }));
    expect(harness.dependencies.armWatchdog).toHaveBeenCalledExactlyOnceWith(expect.any(Function), maximumTimerDelayMs);
  });

  it.each([
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2_147_483_648,
  ])("rejects invalid lock timeout %s before opening a session", async (lockTimeoutMs) => {
    const harness = makeHarness();

    await expect(runHarness(harness, lockTimeoutMs)).rejects.toThrow(/finite positive value/);

    expect(harness.openSession).not.toHaveBeenCalled();
    expect(harness.dependencies.armWatchdog).not.toHaveBeenCalled();
  });
});
