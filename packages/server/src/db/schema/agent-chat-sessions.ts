import { index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
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
     * report (transition + ~20s re-affirm). NULLABLE on purpose: a NULL
     * means "client is bound but hasn't sent its first session:runtime
     * frame for this chat yet" (transient sentinel between session:state
     * active and the first runtime report). The composite reads NULL as
     * fail-closed for working and falls back to legacy activity / presence
     * error. Never stamp it from a predictive active write: a non-null
     * value is the discriminator that the client has reported per-chat
     * runtime. Lifecycle inactivation and a wake that clears an already-
     * stamped in-flight D-axis may write idle + now.
     */
    runtimeStateAt: timestamp("runtime_state_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.agentId, table.chatId] }),
    index("idx_agent_chat_sessions_chat_agent").on(table.chatId, table.agentId),
  ],
);
