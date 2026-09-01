import { boolean, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { chats } from "./chats.js";

/** Per-session state snapshot. One row per (agent, chat) pair, upserted on each session:state message. */
export const agentChatSessions = pgTable(
  "agent_chat_sessions",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.uuid, { onDelete: "cascade" }),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    state: text("state").notNull(),
    /**
     * D-axis: is a turn in flight for THIS (agent, chat) right now. Mirrors
     * the client's per-chat `sessionRuntimeStates` map. One of
     * `idle | working | blocked | error`. This is the per-chat home of the
     * runtime state that historically only lived agent-global on
     * `agent_presence.runtime_state` — the composite status reads this
     * authoritatively so it no longer has to reconstruct "working" from a
     * decaying `session_events` proxy.
     */
    runtimeState: text("runtime_state").notNull().default("idle"),
    /**
     * Freshness stamp for `runtime_state`, bumped on every per-chat runtime
     * report (transition + ~30s re-affirm). NULLABLE on purpose: a NULL
     * means "client is bound but hasn't sent its first session:runtime
     * frame for this chat yet" (transient sentinel between session:state
     * active and the first runtime report). The composite reads NULL as
     * fail-closed (not working / not errored). Never default it to `now()`:
     * a fresh default would be indistinguishable from a real report and
     * would let the producer light up agents that never reported anything.
     */
    runtimeStateAt: timestamp("runtime_state_at", { withTimezone: true }),
    /**
     * Descriptive companion to `runtime_state`: the provider for this pair is
     * parked on work it started itself (a background task) and will resume
     * without anyone messaging it. Written by the same `session:runtime`
     * frame and therefore governed by the same `runtime_state_at` freshness
     * — a client that stops reporting stops asserting background work. It is
     * NOT an input to the composite `main`; an agent carrying it is still
     * `ready`, just not finished.
     */
    backgroundWork: boolean("background_work").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.chatId] }),
    index("idx_agent_chat_sessions_chat_agent").on(table.chatId, table.agentId),
  ],
);
