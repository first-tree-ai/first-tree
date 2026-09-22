import { and, eq } from "drizzle-orm";
import type { Database } from "../../../db/connection.js";
import { imChatBindings } from "../../../db/schema/im-chat-bindings.js";

/**
 * The single "is this chat mirrored to a Feishu conversation right now?"
 * predicate. Both write boundaries — the Web one in `api/chats.ts` and the
 * agent one in `api/agent/feishu-chat-guard.ts` — must answer this question
 * identically, so they share this function rather than each writing their own
 * query.
 *
 * ACTIVE-ONLY is the rule. `im_chat_bindings.status` is `'active' | 'detached'`;
 * a detached row is history, not a live mirror. Once a binding detaches the
 * chat is no longer projected into any Feishu conversation, so writing to it
 * reaches the same people it always did and the boundary has nothing left to
 * protect. Treating a detached row as still-bridged would strand the chat
 * permanently read-only with no way back.
 *
 * The two scopes previously disagreed here — the agent scope filtered on
 * `status`, the Web scope matched any row — which left a detached chat
 * agent-writable but Web-read-only. This module exists so that cannot recur.
 */

/** The one binding status that means "currently mirrored to Feishu". */
export const FEISHU_ACTIVE_CHAT_BINDING_STATUS = "active";

/** True when the chat currently has an active Feishu conversation binding. */
export async function isFeishuBridgedChat(db: Database, chatId: string): Promise<boolean> {
  const [binding] = await db
    .select({ id: imChatBindings.id })
    .from(imChatBindings)
    .where(and(eq(imChatBindings.chatId, chatId), eq(imChatBindings.status, FEISHU_ACTIVE_CHAT_BINDING_STATUS)))
    .limit(1);
  return binding !== undefined;
}
