import type { FastifyInstance } from "fastify";
import { createLogger } from "../observability/index.js";
import {
  backfillExternalAttachmentsToPostgres,
  sweepExpiredMessageAttachments,
  sweepOrphanAttachments,
} from "./attachment.js";
import * as inboxService from "./chat/inbox.js";
import { createCronScheduler } from "./chat/scheduled-jobs/scheduler.js";
import * as chatArchiveService from "./chat/workspace/archive.js";
import * as notificationService from "./notification.js";
import * as clientService from "./runtime/client.js";
import * as presenceService from "./runtime/presence.js";
import {
  createGithubPollDryRunState,
  GITHUB_POLL_DRY_RUN_DEFAULT_INTERVAL_MS,
  GITHUB_POLL_DRY_RUN_MIN_INTERVAL_MS,
  type GithubPollDryRunOptions,
  type GithubPollFetch,
  runGithubPollDryRunOnce,
} from "./scm/github/poll.js";
import { backfillSkillResourceBundles } from "./skill-bundle.js";

const log = createLogger("BackgroundTasks");

/** The 14-day message-attachment retention sweep runs once at startup and then every 24 hours — deliberately separate from the hourly orphan-sweep timer. */
const ATTACHMENT_RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type BackgroundTasks = {
  start(): void;
  stop(): Promise<void>;
};

export type BackgroundTaskOptions = {
  cronSchedulerEnabled?: boolean;
  attachmentRetentionSweepEnabled?: boolean;
  /** Observe-only GitHub polling; delivers nothing, logs what it would deliver. */
  githubPollDryRun?: GithubPollDryRunOptions;
};

export function createBackgroundTasks(
  app: FastifyInstance,
  instanceId: string,
  options: BackgroundTaskOptions = {},
): BackgroundTasks {
  let inboxTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let archiveSweepTimer: ReturnType<typeof setInterval> | null = null;
  let attachmentSweepTimer: ReturnType<typeof setInterval> | null = null;
  let attachmentRetentionTimer: ReturnType<typeof setInterval> | null = null;
  let githubPollTimer: ReturnType<typeof setInterval> | null = null;
  const attachmentRetentionRuns = new Set<Promise<void>>();
  const cronScheduler = options.cronSchedulerEnabled === false ? null : createCronScheduler(app);

  async function maintainAttachments(): Promise<void> {
    const legacyAttachments = await backfillExternalAttachmentsToPostgres(app.db, app.attachmentBlobStore);
    const legacySkills = await backfillSkillResourceBundles(app.db, app.attachmentBlobStore, {
      maxOrganizationAttachments: app.config.attachments.organizationObjectQuota,
    });
    const sweep = await sweepOrphanAttachments(app.db, app.attachmentBlobStore);
    if (legacyAttachments.migrated > 0 || legacySkills.migrated > 0 || sweep.deleted > 0) {
      log.info({ legacyAttachments, legacySkills, sweep }, "attachment maintenance completed");
    }
  }

  function startAttachmentRetentionSweep(): void {
    const run = sweepExpiredMessageAttachments(app.db, app.attachmentBlobStore, {
      deleteEnabled: app.config.attachments.retention?.deleteEnabled ?? false,
    })
      .then(() => undefined)
      .catch((err) => {
        log.error({ err }, "attachment retention sweep failed");
      });
    attachmentRetentionRuns.add(run);
    void run.finally(() => {
      attachmentRetentionRuns.delete(run);
    });
  }

  return {
    start() {
      inboxTimer = setInterval(async () => {
        try {
          const pruned = await inboxService.pruneStaleSilentEntries(app.db);
          if (pruned.ackedDeleted > 0 || pruned.stalePendingDeleted > 0) {
            log.debug(
              { ackedDeleted: pruned.ackedDeleted, stalePendingDeleted: pruned.stalePendingDeleted },
              "pruned silent inbox rows",
            );
          }
        } catch (err) {
          log.error({ err }, "failed to prune silent inbox rows");
        }
      }, 60_000);

      heartbeatTimer = setInterval(async () => {
        try {
          await presenceService.heartbeatInstance(app.db, instanceId);
          const staleSeconds = app.config.runtime.presenceCleanupSeconds;
          await presenceService.cleanupStalePresence(app.db, staleSeconds);
          await clientService.cleanupStaleClients(app.db, staleSeconds);
          const staleAgents = await presenceService.markStaleAgents(app.db, staleSeconds);
          if (staleAgents.length > 0) {
            log.info({ count: staleAgents.length, agentIds: staleAgents }, "marked agents as stale");
            for (const agentId of staleAgents) {
              notificationService.notifyAgentEvent(app.db, agentId, "agent_stale", "medium").catch(() => {});
            }
          }
        } catch (err) {
          log.error({ err }, "failed to heartbeat / cleanup presence");
        }
      }, 30_000);

      const archiveSweepSeconds = app.config.runtime.archiveSweepIntervalSeconds;
      if (archiveSweepSeconds > 0) {
        archiveSweepTimer = setInterval(async () => {
          try {
            const stats = await chatArchiveService.sweepChatArchive(app.db, {
              mappedIdleSeconds: app.config.runtime.archiveMappedIdleSeconds,
            });
            if (stats.mappedRowsArchived > 0 || stats.unmappedRowsArchived > 0) {
              log.info(stats, "chat auto-archive sweep flipped rows to archived");
            }
          } catch (err) {
            log.error({ err }, "chat auto-archive sweep failed");
          }
        }, archiveSweepSeconds * 1000);
      }

      attachmentSweepTimer = setInterval(
        async () => {
          try {
            await maintainAttachments();
          } catch (err) {
            log.error({ err }, "attachment maintenance failed");
          }
        },
        60 * 60 * 1000,
      );

      if (options.attachmentRetentionSweepEnabled !== false) {
        attachmentRetentionTimer = setInterval(startAttachmentRetentionSweep, ATTACHMENT_RETENTION_SWEEP_INTERVAL_MS);
        startAttachmentRetentionSweep();
      }

      const pollDryRun = options.githubPollDryRun;
      if (pollDryRun && pollDryRun.targets.length > 0) {
        const state = createGithubPollDryRunState();
        const intervalMs = Math.max(
          pollDryRun.intervalMs ?? GITHUB_POLL_DRY_RUN_DEFAULT_INTERVAL_MS,
          GITHUB_POLL_DRY_RUN_MIN_INTERVAL_MS,
        );
        const pollFetch = pollDryRun.fetch ?? (globalThis.fetch as unknown as GithubPollFetch);
        log.info({ repositories: pollDryRun.targets.length, intervalMs }, "github poll dry run enabled");
        githubPollTimer = setInterval(() => {
          void runGithubPollDryRunOnce({
            targets: pollDryRun.targets,
            state,
            fetch: pollFetch,
            token: pollDryRun.token ?? null,
          });
        }, intervalMs);
      }

      cronScheduler?.start();

      presenceService.heartbeatInstance(app.db, instanceId).catch((err) => {
        log.error({ err }, "failed initial heartbeat");
      });
      sweepOrphanAttachments(app.db, app.attachmentBlobStore).catch((err) => {
        log.error({ err }, "initial orphan attachment sweep failed");
      });
    },

    async stop() {
      await cronScheduler?.stop();
      if (inboxTimer) {
        clearInterval(inboxTimer);
        inboxTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (archiveSweepTimer) {
        clearInterval(archiveSweepTimer);
        archiveSweepTimer = null;
      }
      if (attachmentSweepTimer) {
        clearInterval(attachmentSweepTimer);
        attachmentSweepTimer = null;
      }
      if (attachmentRetentionTimer) {
        clearInterval(attachmentRetentionTimer);
        attachmentRetentionTimer = null;
      }
      if (githubPollTimer) {
        clearInterval(githubPollTimer);
        githubPollTimer = null;
      }
      await Promise.allSettled([...attachmentRetentionRuns]);
    },
  };
}
