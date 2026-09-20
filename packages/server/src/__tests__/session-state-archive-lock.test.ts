import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { connectDatabase, type Database } from "../db/connection.js";
import { agentChatSessions } from "../db/schema/agent-chat-sessions.js";
import { agents } from "../db/schema/agents.js";
import { createAgent } from "../services/agents/identity.js";
import { createChat } from "../services/chat/conversation.js";
import { upsertSessionState } from "../services/chat/sessions/activity.js";
import { createAdminContext, useTestApp } from "./helpers.js";

async function waitForAgentLock(db: Database, applicationName: string, blockerPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await db.execute<{ blocked: boolean }>(sql`
      SELECT ${blockerPid} = ANY(pg_blocking_pids(pid)) AS blocked
      FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = ${applicationName}
    `);
    if (rows.some((row) => row.blocked)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Session upsert did not wait for the archive's agent lock");
}

describe("session state versus agent archive locking", () => {
  const getApp = useTestApp();

  it("waits for the agent before taking the session row needed by runtime-switch archive", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `archive-${randomUUID().slice(0, 6)}` });
    const agent = await createAgent(app.db, {
      name: `archive-agent-${randomUUID().slice(0, 6)}`,
      type: "agent",
      displayName: "Archive lock target",
      managerId: admin.memberId,
      clientId: admin.clientId,
    });
    const chat = await createChat(app.db, admin.humanAgentUuid, { type: "group", participantIds: [agent.uuid] });
    // No presence row: the old code updates this session, then waits for the
    // presence INSERT's agent FK, holding the session the archive needs.
    await app.db.insert(agentChatSessions).values({ agentId: agent.uuid, chatId: chat.id, state: "suspended" });
    const applicationName = `session-archive-${randomUUID()}`;
    const url = new URL(process.env.DATABASE_URL ?? "");
    url.searchParams.set("application_name", applicationName);
    const writer = connectDatabase(url.toString());
    let write: Promise<unknown> | undefined;
    try {
      await app.db.transaction(async (archive) => {
        // Runtime-switch archiveAllSessionsForAgent claims agent authority
        // FOR UPDATE before it evicts session rows. Stage that same order.
        const [pid] = await archive.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        if (!pid) throw new Error("Missing archive backend pid");
        await archive.select({ uuid: agents.uuid }).from(agents).where(eq(agents.uuid, agent.uuid)).for("update");
        write = upsertSessionState(writer, agent.uuid, chat.id, "active", admin.organizationId).then(
          () => undefined,
          (error: unknown) => error,
        );
        await waitForAgentLock(app.db, applicationName, pid.pid);

        // NOWAIT makes this an ordering assertion, not a test that can pass
        // merely because PostgreSQL aborts and the retry hides a deadlock.
        await archive
          .select({ agentId: agentChatSessions.agentId })
          .from(agentChatSessions)
          .where(and(eq(agentChatSessions.agentId, agent.uuid), eq(agentChatSessions.chatId, chat.id)))
          .for("update", { noWait: true });
        await archive
          .update(agentChatSessions)
          .set({ state: "evicted", runtimeState: "idle" })
          .where(and(eq(agentChatSessions.agentId, agent.uuid), eq(agentChatSessions.chatId, chat.id)));
      });
      expect(await write).toBeUndefined();
      const [session] = await app.db
        .select({ state: agentChatSessions.state })
        .from(agentChatSessions)
        .where(and(eq(agentChatSessions.agentId, agent.uuid), eq(agentChatSessions.chatId, chat.id)));
      expect(session?.state).toBe("active");
    } finally {
      await write;
      await writer.end();
    }
  });
});
