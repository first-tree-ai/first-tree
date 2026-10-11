import type {
  CreateCronJobRequest,
  CronJob,
  CronJobErrorCode,
  CronJobPauseReason,
  CronOutstanding,
  CronPreviewResponse,
  DeleteCronJobResponse,
  UpdateCronJobRequest,
} from "@first-tree/shared";
import { and, asc, eq, exists, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "../../../db/connection.js";
import { agents } from "../../../db/schema/agents.js";
import { chatMembership } from "../../../db/schema/chat-membership.js";
import { chatUserState } from "../../../db/schema/chat-user-state.js";
import { chats } from "../../../db/schema/chats.js";
import { type CronJobRow, cronJobs } from "../../../db/schema/cron-jobs.js";
import { inboxEntries } from "../../../db/schema/inbox-entries.js";
import { members } from "../../../db/schema/members.js";
import { messages } from "../../../db/schema/messages.js";
import { AppError } from "../../../errors.js";
import { createLogger } from "../../../observability/index.js";
import { uuidv7 } from "../../../uuid.js";
import { assertSchedulable, InvalidCronScheduleError, previewOccurrences } from "./schedule.js";

const log = createLogger("CronJob");

export class CronJobAppError extends AppError {
  readonly code: CronJobErrorCode;
  constructor(statusCode: number, code: CronJobErrorCode, message: string) {
    super(statusCode, message, { code });
    this.name = "CronJobAppError";
    this.code = code;
  }
}

export async function databaseNow(db: Database): Promise<Date> {
  const rows = (await db.execute(sql`SELECT clock_timestamp() AS now`)) as unknown as Array<{
    now: Date | string;
  }>;
  const raw = rows[0]?.now;
  if (!raw) throw new Error("failed to read database clock");
  return raw instanceof Date ? raw : new Date(raw);
}

export async function loadOutstanding(
  db: Database,
  job: Pick<CronJobRow, "agentId" | "controlChatId" | "lastTriggerMessageId">,
): Promise<CronOutstanding | null | "missing"> {
  if (!job.lastTriggerMessageId) return null;

  const [agent] = await db
    .select({ inboxId: agents.inboxId })
    .from(agents)
    .where(eq(agents.uuid, job.agentId))
    .limit(1);
  if (!agent) return "missing";

  const [message] = await db
    .select({ id: messages.id, chatId: messages.chatId })
    .from(messages)
    .where(eq(messages.id, job.lastTriggerMessageId))
    .limit(1);
  if (!message || message.chatId !== job.controlChatId) return "missing";

  const [entry] = await db
    .select({ status: inboxEntries.status })
    .from(inboxEntries)
    .where(
      and(
        eq(inboxEntries.inboxId, agent.inboxId),
        eq(inboxEntries.messageId, job.lastTriggerMessageId),
        eq(inboxEntries.chatId, job.controlChatId),
        eq(inboxEntries.notify, true),
      ),
    )
    .limit(1);
  if (!entry) return "missing";
  if (entry.status === "acked") return null;
  if (entry.status === "pending" || entry.status === "delivered") {
    return { messageId: job.lastTriggerMessageId, status: entry.status };
  }
  return "missing";
}

export async function projectCronJob(db: Database, job: CronJobRow): Promise<CronJob> {
  const outstanding = await loadOutstanding(db, job);
  return {
    id: job.id,
    ownerMemberId: job.ownerMemberId,
    controlChatId: job.controlChatId,
    agentId: job.agentId,
    name: job.name,
    chatMode: "reuse_control_chat",
    schedule: job.cronExpression,
    timezone: job.timezone,
    prompt: job.prompt,
    state: job.state as "active" | "paused",
    stateReason: job.stateReason,
    revision: job.revision,
    nextRunAt: job.nextRunAt ? job.nextRunAt.toISOString() : null,
    outstanding: outstanding === "missing" ? null : outstanding,
    createdAt: job.createdAt.toISOString(),
  };
}

export async function previewCronSchedule(
  schedule: string,
  timezone: string,
  after?: Date,
): Promise<CronPreviewResponse> {
  try {
    return previewOccurrences(schedule, timezone, after ?? new Date());
  } catch (err) {
    if (err instanceof InvalidCronScheduleError) {
      throw new CronJobAppError(400, "CRON_JOB_INVALID_SCHEDULE", err.message);
    }
    throw err;
  }
}

type AuthorizationSnapshot = {
  ownerMemberId: string;
  ownerHumanAgentId: string;
  agentInboxId: string;
  organizationId: string;
  agentName: string | null;
  agentDisplayName: string;
};

type PermanentFail = { ok: false; reason: CronJobPauseReason };
type PermanentOk = { ok: true } & AuthorizationSnapshot;
type PermanentResult = PermanentFail | PermanentOk;

export async function revalidateOwnerChatAgent(
  db: Database,
  job: Pick<CronJobRow, "ownerMemberId" | "controlChatId" | "agentId" | "chatMode">,
): Promise<PermanentResult> {
  if (job.chatMode !== "reuse_control_chat") {
    return { ok: false, reason: "unsupported_chat_mode" };
  }

  const [chat] = await db.select().from(chats).where(eq(chats.id, job.controlChatId)).limit(1);
  if (!chat) return { ok: false, reason: "chat_invalid" };

  const [owner] = await db.select().from(members).where(eq(members.id, job.ownerMemberId)).limit(1);
  if (!owner || owner.status !== "active" || owner.organizationId !== chat.organizationId) {
    return { ok: false, reason: "owner_inactive" };
  }

  const [agent] = await db.select().from(agents).where(eq(agents.uuid, job.agentId)).limit(1);
  if (!agent || agent.status !== "active" || agent.organizationId !== chat.organizationId) {
    return { ok: false, reason: "agent_inactive" };
  }
  if (agent.managerId !== job.ownerMemberId) {
    return { ok: false, reason: "agent_manager_changed" };
  }

  const [ownerSpeaker] = await db
    .select({ agentId: chatMembership.agentId })
    .from(chatMembership)
    .where(
      and(
        eq(chatMembership.chatId, job.controlChatId),
        eq(chatMembership.agentId, owner.agentId),
        eq(chatMembership.accessMode, "speaker"),
      ),
    )
    .limit(1);
  if (!ownerSpeaker) return { ok: false, reason: "owner_not_speaker" };

  const [agentSpeaker] = await db
    .select({ agentId: chatMembership.agentId })
    .from(chatMembership)
    .where(
      and(
        eq(chatMembership.chatId, job.controlChatId),
        eq(chatMembership.agentId, job.agentId),
        eq(chatMembership.accessMode, "speaker"),
      ),
    )
    .limit(1);
  if (!agentSpeaker) return { ok: false, reason: "agent_not_speaker" };

  const [engagement] = await db
    .select({ status: chatUserState.engagementStatus })
    .from(chatUserState)
    .where(and(eq(chatUserState.chatId, job.controlChatId), eq(chatUserState.agentId, owner.agentId)))
    .limit(1);
  if (engagement?.status === "deleted") {
    return { ok: false, reason: "owner_chat_deleted" };
  }

  return {
    ok: true,
    ownerMemberId: owner.id,
    ownerHumanAgentId: owner.agentId,
    agentInboxId: agent.inboxId,
    organizationId: chat.organizationId,
    agentName: agent.name,
    agentDisplayName: agent.displayName,
  };
}

export async function listCronJobsForChat(db: Database, controlChatId: string): Promise<CronJob[]> {
  const rows = await db
    .select()
    .from(cronJobs)
    .where(eq(cronJobs.controlChatId, controlChatId))
    .orderBy(asc(cronJobs.createdAt), asc(cronJobs.id));
  return Promise.all(rows.map((row) => projectCronJob(db, row)));
}

/**
 * Every schedule owned by a user that the user can still see, across the orgs
 * they belong to.
 *
 * The per-chat listing answers "what runs from here", which leaves a client
 * that wants "what do I have scheduled" fanning out across every chat it knows
 * about — one request per chat to find the handful that have any.
 *
 * Ownership alone is NOT the boundary. `requireCronJobAccess` gates reads and
 * mutations alike on `requireChatAccess` first, and only adds an ownership
 * check for mutations, so a job whose control chat the caller has lost access
 * to is already invisible to them by id and through its chat. This listing
 * intersects ownership with that same visibility rule — a direct membership
 * row (speaker or watcher), or a speaker in the chat the caller manages — so
 * revoking chat access removes the job here exactly as it does everywhere
 * else. Losing access without losing org membership is a real transition:
 * remove the manager's agent from the chat, then have the human leave it.
 *
 * Ordered by next run so the answer matches the question — what happens
 * soonest — with paused jobs after, since a job with no next occurrence
 * cannot be sorted among the ones that have one.
 */
export async function listCronJobsForUser(db: Database, userId: string): Promise<CronJob[]> {
  const owner = alias(members, "cron_owner_member");
  const managedAgent = alias(agents, "cron_managed_agent");

  const directMembership = db
    .select({ one: sql`1` })
    .from(chatMembership)
    .where(and(eq(chatMembership.chatId, cronJobs.controlChatId), eq(chatMembership.agentId, owner.agentId)));

  const supervisedSpeaker = db
    .select({ one: sql`1` })
    .from(chatMembership)
    .innerJoin(managedAgent, eq(managedAgent.uuid, chatMembership.agentId))
    .where(
      and(
        eq(chatMembership.chatId, cronJobs.controlChatId),
        eq(chatMembership.accessMode, "speaker"),
        eq(managedAgent.managerId, owner.id),
      ),
    );

  const rows = await db
    .select({ job: cronJobs })
    .from(cronJobs)
    .innerJoin(owner, eq(owner.id, cronJobs.ownerMemberId))
    .where(
      and(
        eq(owner.userId, userId),
        eq(owner.status, "active"),
        or(exists(directMembership), exists(supervisedSpeaker)),
      ),
    )
    .orderBy(asc(cronJobs.nextRunAt), asc(cronJobs.createdAt), asc(cronJobs.id));
  return Promise.all(rows.map((row) => projectCronJob(db, row.job)));
}

export async function getCronJobRow(db: Database, id: string): Promise<CronJobRow | null> {
  const [row] = await db.select().from(cronJobs).where(eq(cronJobs.id, id)).limit(1);
  return row ?? null;
}

export async function getCronJobForAgent(
  db: Database,
  chatId: string,
  agentId: string,
  jobId: string,
): Promise<CronJob> {
  const [row] = await db
    .select()
    .from(cronJobs)
    .where(and(eq(cronJobs.id, jobId), eq(cronJobs.controlChatId, chatId), eq(cronJobs.agentId, agentId)))
    .limit(1);
  if (!row) throw new CronJobAppError(404, "CRON_JOB_NOT_FOUND", "Cron job not found");
  return projectCronJob(db, row);
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}

/**
 * Serialize owner-chat delete/pause against create/resume so an active row
 * cannot be inserted after the pause scan but before the engagement UPSERT.
 */
export async function lockOwnerChatCronBarrier(
  db: Database,
  controlChatId: string,
  ownerMemberId: string,
): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${controlChatId}), hashtext(${ownerMemberId}))`);
}

async function resolveIdenticalCreateConflict(
  db: Database,
  input: {
    controlChatId: string;
    agentId: string;
    name: string;
    schedule: string;
    timezone: string;
    prompt: string;
  },
): Promise<CronJob | null> {
  const [existing] = await db
    .select()
    .from(cronJobs)
    .where(
      and(
        eq(cronJobs.controlChatId, input.controlChatId),
        eq(cronJobs.agentId, input.agentId),
        eq(cronJobs.name, input.name),
      ),
    )
    .limit(1);
  if (!existing) return null;
  const identical =
    existing.cronExpression === input.schedule &&
    existing.timezone === input.timezone &&
    existing.prompt === input.prompt;
  if (identical) return projectCronJob(db, existing);
  return null;
}

export async function createCronJob(
  db: Database,
  input: {
    controlChatId: string;
    agentId: string;
    body: CreateCronJobRequest;
    /** Class D: authenticated managing member; revalidated inside the txn. */
    callerMemberId?: string;
    callerHumanAgentId?: string;
  },
): Promise<CronJob> {
  const now = await databaseNow(db);
  let scheduled: { schedule: string; timezone: string; nextRunAt: Date };
  try {
    scheduled = assertSchedulable(input.body.schedule, input.body.timezone, now);
  } catch (err) {
    if (err instanceof InvalidCronScheduleError) {
      throw new CronJobAppError(400, "CRON_JOB_INVALID_SCHEDULE", err.message);
    }
    throw err;
  }

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;

    // Class D global order: member→agent→speakers → advisory → engagement
    // recheck → cron/insert. Advisory serializes with setChatEngagement(deleted).
    let ownerMemberId: string;
    if (input.callerMemberId && input.callerHumanAgentId) {
      await assertCronAgentRouteAccess(txDb, {
        chatId: input.controlChatId,
        agentId: input.agentId,
        callerMemberId: input.callerMemberId,
        callerHumanAgentId: input.callerHumanAgentId,
      });
      ownerMemberId = input.callerMemberId;
      await lockOwnerChatCronBarrier(txDb, input.controlChatId, ownerMemberId);
      await assertCronOwnerEngagementAllowed(txDb, {
        controlChatId: input.controlChatId,
        callerHumanAgentId: input.callerHumanAgentId,
      });
    } else {
      const [agent] = await txDb.select().from(agents).where(eq(agents.uuid, input.agentId)).for("update").limit(1);
      if (!agent || agent.status !== "active") {
        throw new CronJobAppError(403, "CRON_JOB_FORBIDDEN", "Agent is not eligible to create scheduled jobs");
      }
      ownerMemberId = agent.managerId;
      await lockOwnerChatCronBarrier(txDb, input.controlChatId, ownerMemberId);
    }

    const validated = await revalidateOwnerChatAgent(txDb, {
      ownerMemberId,
      controlChatId: input.controlChatId,
      agentId: input.agentId,
      chatMode: "reuse_control_chat",
    });
    if (!validated.ok) {
      throw new CronJobAppError(403, "CRON_JOB_FORBIDDEN", `Cannot create schedule (${validated.reason})`);
    }

    const identicalPre = await resolveIdenticalCreateConflict(txDb, {
      controlChatId: input.controlChatId,
      agentId: input.agentId,
      name: input.body.name,
      schedule: scheduled.schedule,
      timezone: scheduled.timezone,
      prompt: input.body.prompt,
    });
    if (identicalPre) return identicalPre;

    const [conflicting] = await txDb
      .select({ id: cronJobs.id })
      .from(cronJobs)
      .where(
        and(
          eq(cronJobs.controlChatId, input.controlChatId),
          eq(cronJobs.agentId, input.agentId),
          eq(cronJobs.name, input.body.name),
        ),
      )
      .limit(1);
    if (conflicting) {
      throw new CronJobAppError(409, "CRON_JOB_NAME_CONFLICT", "A cron job with this name already exists");
    }

    const id = uuidv7();
    // ON CONFLICT DO NOTHING avoids aborting the txn on a racing rename
    // (catching 23505 then querying would raise 25P02).
    const inserted = await tx
      .insert(cronJobs)
      .values({
        id,
        ownerMemberId: validated.ownerMemberId,
        controlChatId: input.controlChatId,
        agentId: input.agentId,
        name: input.body.name,
        chatMode: "reuse_control_chat",
        cronExpression: scheduled.schedule,
        timezone: scheduled.timezone,
        prompt: input.body.prompt,
        state: "active",
        stateReason: null,
        revision: 1,
        nextRunAt: scheduled.nextRunAt,
        lastTriggerMessageId: null,
      })
      .onConflictDoNothing({
        target: [cronJobs.controlChatId, cronJobs.agentId, cronJobs.name],
      })
      .returning();

    if (!inserted[0]) {
      const identical = await resolveIdenticalCreateConflict(txDb, {
        controlChatId: input.controlChatId,
        agentId: input.agentId,
        name: input.body.name,
        schedule: scheduled.schedule,
        timezone: scheduled.timezone,
        prompt: input.body.prompt,
      });
      if (identical) return identical;
      throw new CronJobAppError(409, "CRON_JOB_NAME_CONFLICT", "A cron job with this name already exists");
    }

    log.info(
      {
        jobId: inserted[0].id,
        organizationId: validated.organizationId,
        controlChatId: inserted[0].controlChatId,
        agentId: inserted[0].agentId,
        metric: "cron_job_created_total",
      },
      "cron.job.created",
    );
    return projectCronJob(txDb, inserted[0]);
  });
}

async function lockJob(db: Database, jobId: string): Promise<CronJobRow> {
  const locked = await db.select().from(cronJobs).where(eq(cronJobs.id, jobId)).for("update").limit(1);
  if (!locked[0]) throw new CronJobAppError(404, "CRON_JOB_NOT_FOUND", "Cron job not found");
  return locked[0];
}

function assertRevision(job: CronJobRow, expected: number): void {
  if (job.revision !== expected) {
    throw new CronJobAppError(409, "CRON_JOB_REVISION_MISMATCH", "Cron job revision mismatch");
  }
}

export async function updateCronJob(
  db: Database,
  input: {
    jobId: string;
    expectedRevision: number;
    body: UpdateCronJobRequest;
    /** When set, require job.agentId === agentId and controlChatId match. */
    agentScope?: { agentId: string; controlChatId: string };
    /** When set, require job.ownerMemberId === memberId for mutations. */
    ownerMemberId?: string;
    /** Class D: authenticated managing member; revalidated inside the txn. */
    callerMemberId?: string;
    callerHumanAgentId?: string;
  },
): Promise<CronJob> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const body = input.body;

    // Peek identity without row locks so Class D auth can take member→agent
    // locks before the owner-chat advisory / cron FOR UPDATE locks.
    const [peek] = await txDb
      .select({
        controlChatId: cronJobs.controlChatId,
        ownerMemberId: cronJobs.ownerMemberId,
        agentId: cronJobs.agentId,
      })
      .from(cronJobs)
      .where(eq(cronJobs.id, input.jobId))
      .limit(1);
    if (!peek) throw new CronJobAppError(404, "CRON_JOB_NOT_FOUND", "Cron job not found");

    if (input.agentScope) {
      if (peek.agentId !== input.agentScope.agentId || peek.controlChatId !== input.agentScope.controlChatId) {
        throw new CronJobAppError(404, "CRON_JOB_NOT_FOUND", "Cron job not found");
      }
    }
    if (input.ownerMemberId && peek.ownerMemberId !== input.ownerMemberId) {
      throw new CronJobAppError(403, "CRON_JOB_FORBIDDEN", "Only the schedule owner may modify this job");
    }
    // Class D: owner is immutable. Current manager alone is not enough —
    // otherwise a reassignment lets B mutate A's job while locking A's
    // advisory and checking B's engagement.
    if (input.callerMemberId && peek.ownerMemberId !== input.callerMemberId) {
      throw new CronJobAppError(403, "CRON_JOB_FORBIDDEN", "Only the schedule owner may modify this job");
    }

    if (input.callerMemberId && input.callerHumanAgentId) {
      await assertCronAgentRouteAccess(txDb, {
        chatId: peek.controlChatId,
        agentId: peek.agentId,
        callerMemberId: input.callerMemberId,
        callerHumanAgentId: input.callerHumanAgentId,
      });
      // Always take the owner-chat barrier for Class D so pause/config/delete
      // serialize with setChatEngagement(deleted) even when not resuming.
      // Advisory key matches job.ownerMemberId (same as caller after the check).
      await lockOwnerChatCronBarrier(txDb, peek.controlChatId, peek.ownerMemberId);
      await assertCronOwnerEngagementAllowed(txDb, {
        controlChatId: peek.controlChatId,
        callerHumanAgentId: input.callerHumanAgentId,
      });
    } else if (body.state === "active") {
      await lockOwnerChatCronBarrier(txDb, peek.controlChatId, peek.ownerMemberId);
    }

    const job = await lockJob(txDb, input.jobId);
    if (input.agentScope) {
      if (job.agentId !== input.agentScope.agentId || job.controlChatId !== input.agentScope.controlChatId) {
        throw new CronJobAppError(404, "CRON_JOB_NOT_FOUND", "Cron job not found");
      }
    }
    if (input.ownerMemberId && job.ownerMemberId !== input.ownerMemberId) {
      throw new CronJobAppError(403, "CRON_JOB_FORBIDDEN", "Only the schedule owner may modify this job");
    }
    if (input.callerMemberId && job.ownerMemberId !== input.callerMemberId) {
      throw new CronJobAppError(403, "CRON_JOB_FORBIDDEN", "Only the schedule owner may modify this job");
    }
    assertRevision(job, input.expectedRevision);

    const name = body.name ?? job.name;
    const prompt = body.prompt ?? job.prompt;
    let schedule = job.cronExpression;
    let timezone = job.timezone;

    let nextState: "active" | "paused" = job.state as "active" | "paused";
    let nextReason: string | null = job.stateReason;
    let nextRunAt: Date | null = job.nextRunAt;

    if (body.state === "paused") {
      nextState = "paused";
      nextReason = "user_paused";
      nextRunAt = null;
    } else if (body.state === "active") {
      const auth = await revalidateOwnerChatAgent(txDb, job);
      if (!auth.ok) {
        throw new CronJobAppError(403, "CRON_JOB_FORBIDDEN", `Cannot resume schedule (${auth.reason})`);
      }
      nextState = "active";
      nextReason = null;
    }

    const resuming = body.state === "active" && job.state !== "active";
    const scheduleFieldsPresent = body.schedule !== undefined || body.timezone !== undefined;
    // Normalize/validate when schedule/timezone are supplied or a real resume
    // needs a fresh fire. Recompute nextRunAt only for an effective schedule
    // change or real resume — identical schedule/timezone must not discard a
    // due occurrence or bump revision alone.
    if (scheduleFieldsPresent || resuming) {
      try {
        const candidateSchedule = body.schedule ?? job.cronExpression;
        const candidateTimezone = body.timezone ?? job.timezone;
        const normalized = assertSchedulable(candidateSchedule, candidateTimezone, await databaseNow(txDb));
        const scheduleChanged = normalized.schedule !== job.cronExpression || normalized.timezone !== job.timezone;
        schedule = normalized.schedule;
        timezone = normalized.timezone;
        if (nextState === "active" && (resuming || scheduleChanged)) {
          nextRunAt = normalized.nextRunAt;
        }
      } catch (err) {
        if (err instanceof InvalidCronScheduleError) {
          throw new CronJobAppError(400, "CRON_JOB_INVALID_SCHEDULE", err.message);
        }
        throw err;
      }
    }

    if (nextState === "paused") {
      nextRunAt = null;
    }

    const unchanged =
      name === job.name &&
      prompt === job.prompt &&
      schedule === job.cronExpression &&
      timezone === job.timezone &&
      nextState === job.state &&
      nextReason === job.stateReason &&
      (nextRunAt?.getTime() ?? null) === (job.nextRunAt?.getTime() ?? null);
    if (unchanged) {
      return projectCronJob(txDb, job);
    }

    try {
      const [updated] = await tx
        .update(cronJobs)
        .set({
          name,
          prompt,
          cronExpression: schedule,
          timezone,
          state: nextState,
          stateReason: nextReason,
          nextRunAt,
          revision: job.revision + 1,
        })
        .where(eq(cronJobs.id, job.id))
        .returning();
      if (!updated) throw new Error("failed to update cron job");
      if (body.state === "paused" && job.state !== "paused") {
        log.info({ jobId: job.id, decisionReason: "user_paused" }, "cron.job.paused");
      } else if (body.state === "active" && job.state !== "active") {
        log.info({ jobId: job.id }, "cron.job.resumed");
      } else {
        log.info({ jobId: job.id }, "cron.job.updated");
      }
      return projectCronJob(txDb, updated);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new CronJobAppError(409, "CRON_JOB_NAME_CONFLICT", "A cron job with this name already exists");
      }
      throw err;
    }
  });
}

export async function deleteCronJob(
  db: Database,
  input: {
    jobId: string;
    expectedRevision: number;
    agentScope?: { agentId: string; controlChatId: string };
    ownerMemberId?: string;
    callerMemberId?: string;
    callerHumanAgentId?: string;
  },
): Promise<DeleteCronJobResponse> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const [peek] = await txDb
      .select({
        controlChatId: cronJobs.controlChatId,
        ownerMemberId: cronJobs.ownerMemberId,
        agentId: cronJobs.agentId,
      })
      .from(cronJobs)
      .where(eq(cronJobs.id, input.jobId))
      .limit(1);
    if (!peek) throw new CronJobAppError(404, "CRON_JOB_NOT_FOUND", "Cron job not found");

    if (input.agentScope) {
      if (peek.agentId !== input.agentScope.agentId || peek.controlChatId !== input.agentScope.controlChatId) {
        throw new CronJobAppError(404, "CRON_JOB_NOT_FOUND", "Cron job not found");
      }
    }
    if (input.ownerMemberId && peek.ownerMemberId !== input.ownerMemberId) {
      throw new CronJobAppError(403, "CRON_JOB_FORBIDDEN", "Only the schedule owner may delete this job");
    }
    if (input.callerMemberId && peek.ownerMemberId !== input.callerMemberId) {
      throw new CronJobAppError(403, "CRON_JOB_FORBIDDEN", "Only the schedule owner may delete this job");
    }
    if (input.callerMemberId && input.callerHumanAgentId) {
      await assertCronAgentRouteAccess(txDb, {
        chatId: peek.controlChatId,
        agentId: peek.agentId,
        callerMemberId: input.callerMemberId,
        callerHumanAgentId: input.callerHumanAgentId,
      });
      await lockOwnerChatCronBarrier(txDb, peek.controlChatId, peek.ownerMemberId);
      await assertCronOwnerEngagementAllowed(txDb, {
        controlChatId: peek.controlChatId,
        callerHumanAgentId: input.callerHumanAgentId,
      });
    }

    const job = await lockJob(txDb, input.jobId);
    if (input.agentScope) {
      if (job.agentId !== input.agentScope.agentId || job.controlChatId !== input.agentScope.controlChatId) {
        throw new CronJobAppError(404, "CRON_JOB_NOT_FOUND", "Cron job not found");
      }
    }
    if (input.ownerMemberId && job.ownerMemberId !== input.ownerMemberId) {
      throw new CronJobAppError(403, "CRON_JOB_FORBIDDEN", "Only the schedule owner may delete this job");
    }
    if (input.callerMemberId && job.ownerMemberId !== input.callerMemberId) {
      throw new CronJobAppError(403, "CRON_JOB_FORBIDDEN", "Only the schedule owner may delete this job");
    }
    assertRevision(job, input.expectedRevision);
    await tx.delete(cronJobs).where(eq(cronJobs.id, job.id));
    log.info({ jobId: job.id }, "cron.job.deleted");
    return {
      id: job.id,
      deleted: true as const,
      acceptedWorkPreserved: job.lastTriggerMessageId !== null,
      lastTriggerMessageId: job.lastTriggerMessageId,
    };
  });
}

/**
 * Pause all active jobs for an owner on a control chat. Caller must hold or
 * be about to take the chat_user_state write. Lock order: owner-chat advisory
 * barrier, then cron rows FOR UPDATE ORDER BY id, then engagement UPSERT in
 * `setChatEngagement`. Class D mutations use member→agent→speakers→advisory→
 * engagement recheck→cron so both paths share advisory-before-engagement.
 */
export async function pauseActiveJobsForOwnerChatDelete(
  db: Database,
  input: { controlChatId: string; ownerMemberId: string },
): Promise<number> {
  await lockOwnerChatCronBarrier(db, input.controlChatId, input.ownerMemberId);

  const locked = await db
    .select({ id: cronJobs.id })
    .from(cronJobs)
    .where(
      and(
        eq(cronJobs.controlChatId, input.controlChatId),
        eq(cronJobs.ownerMemberId, input.ownerMemberId),
        eq(cronJobs.state, "active"),
      ),
    )
    .orderBy(asc(cronJobs.id))
    .for("update");

  if (locked.length === 0) return 0;

  await db
    .update(cronJobs)
    .set({
      state: "paused",
      stateReason: "owner_chat_deleted",
      nextRunAt: null,
      revision: sql`${cronJobs.revision} + 1`,
    })
    .where(
      and(
        eq(cronJobs.controlChatId, input.controlChatId),
        eq(cronJobs.ownerMemberId, input.ownerMemberId),
        eq(cronJobs.state, "active"),
      ),
    );

  for (const row of locked) {
    log.info({ jobId: row.id, decisionReason: "owner_chat_deleted" }, "cron.job.auto_paused");
  }
  return locked.length;
}

/**
 * Class D manager/speaker authorization held until commit.
 *
 * Lock order (must stay ahead of owner-chat advisory + engagement recheck + cron):
 *   1. caller member row
 *   2. agent row
 *   3. chat_membership speaker rows (`agent_id` ASC)
 *
 * Engagement is intentionally *not* locked here — `setChatEngagement(deleted)`
 * takes the owner-chat advisory before upserting `chat_user_state`, so Class D
 * must take that advisory next and only then re-read engagement (see
 * `assertCronOwnerEngagementAllowed`). Locking engagement before advisory
 * deadlocks against chat deletion.
 */
export async function assertCronAgentRouteAccess(
  db: Database,
  input: { chatId: string; agentId: string; callerMemberId: string; callerHumanAgentId: string },
): Promise<void> {
  const [callerMember] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.id, input.callerMemberId), eq(members.status, "active")))
    .for("update")
    .limit(1);
  if (!callerMember) {
    throw new CronJobAppError(
      403,
      "CRON_JOB_FORBIDDEN",
      "Only the managing human may manage scheduled jobs for this agent",
    );
  }

  const [agent] = await db
    .select({ managerId: agents.managerId, status: agents.status })
    .from(agents)
    .where(eq(agents.uuid, input.agentId))
    .for("update")
    .limit(1);
  if (!agent || agent.status !== "active" || agent.managerId !== input.callerMemberId) {
    throw new CronJobAppError(
      403,
      "CRON_JOB_FORBIDDEN",
      "Only the managing human may manage scheduled jobs for this agent",
    );
  }

  const speakerAgentIds = [input.callerHumanAgentId, input.agentId].slice().sort((a, b) => a.localeCompare(b));
  for (const speakerAgentId of speakerAgentIds) {
    const [speaker] = await db
      .select({ agentId: chatMembership.agentId })
      .from(chatMembership)
      .where(
        and(
          eq(chatMembership.chatId, input.chatId),
          eq(chatMembership.agentId, speakerAgentId),
          eq(chatMembership.accessMode, "speaker"),
        ),
      )
      .for("update")
      .limit(1);
    if (!speaker) {
      throw new CronJobAppError(
        403,
        "CRON_JOB_FORBIDDEN",
        speakerAgentId === input.callerHumanAgentId
          ? "Managing human must be a speaker in this chat"
          : "Agent must be a speaker in this chat",
      );
    }
  }
}

/**
 * Engagement gate for Class D mutations. Call only *after* holding
 * `lockOwnerChatCronBarrier` for `(controlChatId, ownerMemberId)`.
 *
 * Chat deletion takes that same advisory before upserting `deleted`, so a
 * missing `chat_user_state` row is still serialized: the delete path cannot
 * insert `deleted` while we hold the barrier.
 */
export async function assertCronOwnerEngagementAllowed(
  db: Database,
  input: { controlChatId: string; callerHumanAgentId: string },
): Promise<void> {
  const [engagement] = await db
    .select({ status: chatUserState.engagementStatus })
    .from(chatUserState)
    .where(and(eq(chatUserState.chatId, input.controlChatId), eq(chatUserState.agentId, input.callerHumanAgentId)))
    .limit(1);
  if (engagement?.status === "deleted") {
    throw new CronJobAppError(403, "CRON_JOB_FORBIDDEN", "Control chat is deleted for the schedule owner");
  }
}

export type { AuthorizationSnapshot, PermanentResult };
