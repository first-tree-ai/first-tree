import { describe, expect, it } from "vitest";
import { createChat, leaveChat, removeParticipant } from "../services/chat/conversation.js";
import { createCronJob, updateCronJob } from "../services/chat/scheduled-jobs/job.js";
import { createTestAgent, useTestApp } from "./helpers.js";

/**
 * `GET /api/v1/me/cron-jobs` — Class A user-scope listing.
 *
 * The per-chat route answers "what runs from this chat". A client asking "what
 * do I have scheduled" had no way to ask it without one request per chat, so
 * this route exists; ownership is already the mutation boundary for a job, so
 * listing by owner exposes nothing the caller could not already read one id at
 * a time.
 */
describe("GET /me/cron-jobs", () => {
  const getApp = useTestApp();

  async function seedJob(
    runtime: Awaited<ReturnType<typeof createTestAgent>>,
    name: string,
    schedule: string,
  ): Promise<{ chatId: string; jobId: string; revision: number }> {
    const app = getApp();
    const chat = await createChat(app.db, runtime.humanAgentUuid, {
      type: "group",
      participantIds: [runtime.agent.uuid],
    });
    const job = await createCronJob(app.db, {
      controlChatId: chat.id,
      agentId: runtime.agent.uuid,
      body: { name, schedule, timezone: "UTC", prompt: "run" },
    });
    return { chatId: chat.id, jobId: job.id, revision: job.revision };
  }

  it("returns the caller's schedules across chats, and nobody else's", async () => {
    const app = getApp();
    const mine = await createTestAgent(app, { name: `cron-mine-${crypto.randomUUID().slice(0, 6)}` });
    const theirs = await createTestAgent(app, { name: `cron-theirs-${crypto.randomUUID().slice(0, 6)}` });

    await seedJob(mine, "morning", "0 9 * * *");
    await seedJob(mine, "evening", "0 21 * * *");
    await seedJob(theirs, "not-mine", "0 12 * * *");

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/cron-jobs",
      headers: { authorization: `Bearer ${mine.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ name: string; controlChatId: string }> };
    expect(body.items.map((job) => job.name).sort()).toEqual(["evening", "morning"]);
    // Two chats, two jobs — the point of the route is that it spans them.
    expect(new Set(body.items.map((job) => job.controlChatId)).size).toBe(2);
  });

  it("orders by what runs next, with paused jobs after the scheduled ones", async () => {
    const app = getApp();
    const owner = await createTestAgent(app, { name: `cron-order-${crypto.randomUUID().slice(0, 6)}` });

    const later = await seedJob(owner, "later-today", "0 23 * * *");
    const sooner = await seedJob(owner, "sooner-today", "1 0 * * *");
    const paused = await seedJob(owner, "paused-job", "0 12 * * *");
    await updateCronJob(app.db, {
      jobId: paused.jobId,
      expectedRevision: paused.revision,
      callerMemberId: owner.memberId,
      body: { state: "paused" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/cron-jobs",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ id: string; state: string; nextRunAt: string | null }> };
    const ids = body.items.map((job) => job.id);
    // A paused job has no next occurrence, so it cannot be sorted among the
    // ones that do — it comes after them rather than before or between.
    expect(ids.indexOf(paused.jobId)).toBe(ids.length - 1);
    const active = body.items.filter((job) => job.state === "active");
    expect(active.map((job) => job.id)).toContain(sooner.jobId);
    expect(active.map((job) => job.id)).toContain(later.jobId);
    const times = active.map((job) => Date.parse(job.nextRunAt ?? ""));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("drops a job once the owner loses access to its control chat", async () => {
    // Ownership is not the visibility boundary: `requireCronJobAccess` gates
    // reads on `requireChatAccess` first and only adds an ownership check for
    // mutations. A user can stay active in the org and still lose a chat — the
    // managed agent is removed, then the human leaves — after which the job is
    // 404 by id and through its chat. This listing must agree.
    const app = getApp();
    const owner = await createTestAgent(app, { name: `cron-revoked-${crypto.randomUUID().slice(0, 6)}` });
    const seeded = await seedJob(owner, "revoked-later", "0 7 * * *");

    const before = await app.inject({
      method: "GET",
      url: "/api/v1/me/cron-jobs",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect((before.json() as { items: Array<{ id: string }> }).items.map((job) => job.id)).toContain(seeded.jobId);

    await removeParticipant(app.db, seeded.chatId, owner.humanAgentUuid, owner.agent.uuid);
    await leaveChat(app.db, seeded.chatId, owner.humanAgentUuid);

    const after = await app.inject({
      method: "GET",
      url: "/api/v1/me/cron-jobs",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(after.statusCode).toBe(200);
    expect((after.json() as { items: Array<{ id: string }> }).items.map((job) => job.id)).not.toContain(seeded.jobId);

    // The pre-existing routes are the contract this one is being held to.
    const byId = await app.inject({
      method: "GET",
      url: `/api/v1/cron-jobs/${seeded.jobId}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(byId.statusCode).toBe(404);
    const byChat = await app.inject({
      method: "GET",
      url: `/api/v1/chats/${seeded.chatId}/cron-jobs`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(byChat.statusCode).toBe(404);
  });

  it("keeps a job visible to a manager who supervises a speaker in its chat", async () => {
    // The other half of `requireChatAccess`: no direct membership row, but a
    // speaker in the chat is an agent this member manages. Dropping that path
    // would hide jobs the caller can still read by id.
    const app = getApp();
    const owner = await createTestAgent(app, { name: `cron-supervised-${crypto.randomUUID().slice(0, 6)}` });
    const seeded = await seedJob(owner, "supervised", "0 8 * * *");

    // The human leaves; their managed agent stays a speaker in the chat.
    await leaveChat(app.db, seeded.chatId, owner.humanAgentUuid);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me/cron-jobs",
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { items: Array<{ id: string }> }).items.map((job) => job.id)).toContain(seeded.jobId);
    // ...and the by-id route agrees, which is the contract being mirrored.
    const byId = await app.inject({
      method: "GET",
      url: `/api/v1/cron-jobs/${seeded.jobId}`,
      headers: { authorization: `Bearer ${owner.accessToken}` },
    });
    expect(byId.statusCode).toBe(200);
  });

  it("requires a signed-in user", async () => {
    const app = getApp();
    const res = await app.inject({ method: "GET", url: "/api/v1/me/cron-jobs" });
    expect(res.statusCode).toBe(401);
  });
});
