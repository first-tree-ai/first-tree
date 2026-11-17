import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubPollFetch } from "../services/scm/github/poll.js";

const loggerMocks = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

const serviceMocks = {
  cleanupStaleClients: vi.fn(),
  cleanupStalePresence: vi.fn(),
  cronStart: vi.fn(),
  cronStop: vi.fn(),
  heartbeatInstance: vi.fn(),
  markStaleAgents: vi.fn(),
  notifyAgentEvent: vi.fn(),
  pruneStaleSilentEntries: vi.fn(),
  sweepChatArchive: vi.fn(),
  sweepExpiredMessageAttachments: vi.fn(),
};

const mockedModules = [
  "../observability/index.js",
  "../services/attachment.js",
  "../services/chat/workspace/archive.js",
  "../services/runtime/client.js",
  "../services/chat/scheduled-jobs/scheduler.js",
  "../services/chat/inbox.js",
  "../services/notification.js",
  "../services/runtime/presence.js",
];

function mockBackgroundTaskDependencies(): void {
  vi.doMock("../observability/index.js", () => ({
    createLogger: () => loggerMocks,
  }));
  vi.doMock("../services/attachment.js", () => ({
    backfillExternalAttachmentsToPostgres: vi.fn().mockResolvedValue({ migrated: 0, skipped: 0 }),
    backfillSkillResourceBundles: vi.fn().mockResolvedValue({ migrated: 0, skipped: 0 }),
    sweepOrphanAttachments: vi.fn().mockResolvedValue({ examined: 0, deleted: 0 }),
    sweepExpiredMessageAttachments: serviceMocks.sweepExpiredMessageAttachments,
  }));
  vi.doMock("../services/chat/workspace/archive.js", () => ({
    sweepChatArchive: serviceMocks.sweepChatArchive,
  }));
  vi.doMock("../services/runtime/client.js", () => ({
    cleanupStaleClients: serviceMocks.cleanupStaleClients,
  }));
  vi.doMock("../services/chat/scheduled-jobs/scheduler.js", () => ({
    createCronScheduler: () => ({
      start: serviceMocks.cronStart,
      stop: serviceMocks.cronStop,
    }),
  }));
  vi.doMock("../services/chat/inbox.js", () => ({
    pruneStaleSilentEntries: serviceMocks.pruneStaleSilentEntries,
  }));
  vi.doMock("../services/notification.js", () => ({
    notifyAgentEvent: serviceMocks.notifyAgentEvent,
  }));
  vi.doMock("../services/runtime/presence.js", () => ({
    heartbeatInstance: serviceMocks.heartbeatInstance,
    cleanupStalePresence: serviceMocks.cleanupStalePresence,
    markStaleAgents: serviceMocks.markStaleAgents,
  }));
  vi.doMock("../services/skill-bundle.js", () => ({
    backfillSkillResourceBundles: vi.fn().mockResolvedValue({ migrated: 0, skipped: 0 }),
  }));
}

function makeApp(): FastifyInstance {
  return {
    config: {
      attachments: { organizationObjectQuota: 10_000 },
      runtime: { archiveMappedIdleSeconds: 3_600, archiveSweepIntervalSeconds: 0, presenceCleanupSeconds: 60 },
    },
    db: { name: "db" },
    attachmentBlobStore: {},
  } as unknown as FastifyInstance;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  vi.clearAllMocks();
  mockBackgroundTaskDependencies();
  serviceMocks.cleanupStaleClients.mockResolvedValue(undefined);
  serviceMocks.cleanupStalePresence.mockResolvedValue(undefined);
  serviceMocks.cronStop.mockResolvedValue(undefined);
  serviceMocks.heartbeatInstance.mockResolvedValue(undefined);
  serviceMocks.markStaleAgents.mockResolvedValue([]);
  serviceMocks.notifyAgentEvent.mockResolvedValue(undefined);
  serviceMocks.pruneStaleSilentEntries.mockResolvedValue({ ackedDeleted: 0, stalePendingDeleted: 0 });
  serviceMocks.sweepChatArchive.mockResolvedValue({ mappedRowsArchived: 0, unmappedRowsArchived: 0 });
  serviceMocks.sweepExpiredMessageAttachments.mockResolvedValue({
    eligibleObjects: 0,
    eligibleBytes: 0,
    deleted: 0,
    reclaimedBytes: 0,
    batches: 0,
  });
});

afterEach(() => {
  vi.useRealTimers();
  for (const moduleId of mockedModules) {
    vi.doUnmock(moduleId);
  }
  vi.resetModules();
});

function recordingFetch(): { fetch: GithubPollFetch; calls: string[] } {
  const calls: string[] = [];
  const fetch: GithubPollFetch = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => [],
    };
  };
  return { fetch, calls };
}

describe("github poll dry run wiring", () => {
  it("polls nothing unless the operator names repositories", async () => {
    const { createBackgroundTasks } = await import("../services/background-tasks.js");
    const { calls } = recordingFetch();

    const tasks = createBackgroundTasks(makeApp(), "srv_poll_off");
    tasks.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await tasks.stop();

    expect(calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("polls on the configured interval and stops with the tasks", async () => {
    const { createBackgroundTasks } = await import("../services/background-tasks.js");
    const { fetch, calls } = recordingFetch();

    const tasks = createBackgroundTasks(makeApp(), "srv_poll_on", {
      attachmentRetentionSweepEnabled: false,
      githubPollDryRun: {
        targets: [{ organizationId: "org_1", repository: "acme/widgets" }],
        fetch,
        intervalMs: 60_000,
      },
    });
    tasks.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/repos/acme/widgets/issues");

    const beforeStop = calls.length;
    await tasks.stop();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toHaveLength(beforeStop);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clamps an absurdly small interval instead of hammering the API", async () => {
    const { createBackgroundTasks } = await import("../services/background-tasks.js");
    const { fetch, calls } = recordingFetch();

    const tasks = createBackgroundTasks(makeApp(), "srv_poll_clamp", {
      attachmentRetentionSweepEnabled: false,
      githubPollDryRun: {
        targets: [{ organizationId: "org_1", repository: "acme/widgets" }],
        fetch,
        intervalMs: 1,
      },
    });
    tasks.start();
    await vi.advanceTimersByTimeAsync(1_000);
    // Under the 30s floor nothing has run yet.
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(1);
    await tasks.stop();
  });
});
