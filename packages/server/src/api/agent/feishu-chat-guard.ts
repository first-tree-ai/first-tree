import type { Database } from "../../db/connection.js";
import { ForbiddenError } from "../../errors.js";
import { isFeishuBridgedChat } from "../../services/integrations/feishu/chat-binding.js";

/**
 * Agent-scope counterpart of `assertWebMutableChat` in `api/chats.ts`.
 *
 * A chat bridged to a Feishu conversation lives in Feishu: the humans in it
 * read the Feishu group, not the First Tree web app. An agent that answers
 * with `chat send` / `chat ask` / `chat invite` writes into a surface nobody
 * on the other side can see, so the reply is silently lost. These routes fail
 * fast instead and name the path that actually delivers.
 *
 * GUARDED ROUTES, matching the documented "messages and membership changes"
 * boundary — a partial application would just be a differently-shaped hole:
 *   - `POST   /agent/chats/:chatId/messages`             (`chat send`, `chat ask`)
 *   - `PATCH  /agent/chats/:chatId/messages/:messageId`  (message edit)
 *   - `POST   /agent/chats/:chatId/participants`         (`chat invite`)
 *   - `DELETE /agent/chats/:chatId/participants/:agentId` (membership removal)
 *
 * Authority is the shared `isFeishuBridgedChat` predicate — live
 * `im_chat_bindings` state restricted to `status = 'active'`, NOT
 * `chats.metadata.source`, which is a soft label that stays `"feishu"` after a
 * binding detaches. The Web boundary uses the very same predicate so the two
 * scopes cannot drift apart on what "bridged" means.
 *
 * DELIBERATELY NOT GUARDED HERE:
 *   - `messageService.sendMessage` itself. The Feishu bridge's own outbound
 *     delivery (`POST /agent/feishu/intents`) reuses that exact service call
 *     with the same `source: "cli"` and the same agent `senderId`; a guard in
 *     the service layer would break the bot's own replies. The bridge is
 *     distinguishable only by its route, which is why this lives in the
 *     route/adapter layer and is applied per-route.
 *   - `POST /agent/chats/:chatId/runtime-notices`. Operator-facing runtime
 *     notices must survive the boundary — an agent that cannot run at all must
 *     not also go silent. That route is exempt because of WHICH ROUTE IT IS.
 *     Be honest about what that buys: the route is membership-gated exactly
 *     like an ordinary send, so it is a misuse-prevention rail around a
 *     client-runtime-reported notice, not an unforgeable authorization
 *     boundary. See the note below.
 *   - `PATCH /agent/chats/:chatId` (`chat update`). Topic/description are
 *     First-Tree-side metadata the agent briefing requires it to maintain;
 *     they are not a message to a human in the Feishu group.
 *   - `POST /agent/chats/:chatId/archive`. That writes the calling human's
 *     private engagement row, i.e. personal view state — the same class the
 *     Web boundary deliberately keeps working on Feishu chats (`/read`,
 *     `/unread`, `/pin` are all unguarded there).
 *
 * NO GENERAL CONTENT-DERIVED EXEMPTION. An earlier revision let ANY send
 * decorated with `purpose: "agent-final-text"` plus `metadata.runtimeNotice`
 * through, which made the boundary depend on what a caller claimed to be
 * sending. Runtime notices now have their own route, the stored marker is
 * server-stamped (`stripUntrustedMetadataKeys` removes any inbound copy), and
 * `POST /messages` is guarded regardless of body.
 *
 * The single remaining body-shaped path is the ROLLING-DEPLOY COMPATIBILITY
 * one in `api/agent/messages.ts`: a body that matches the exact legacy
 * runtime-notice wire shape is handled as the notice it is, because clients
 * upgrade independently of the server and a provider-failure notice matters
 * most mid-deploy. It is not a privilege escalation — the runtime-notice route
 * is membership-gated exactly like the send route, so that body buys a caller
 * nothing it could not get by calling the endpoint directly. It should be
 * deleted once no supported client predates the endpoint.
 */

/** Machine-readable code surfaced to the CLI through `AppError.attrs.code`. */
export const FEISHU_AGENT_CHAT_WRITE_CODE = "FEISHU_CHAT_AGENT_WRITE_FORBIDDEN";

/**
 * Wording matters here: the boundary blocks MESSAGES AND MEMBERSHIP CHANGES,
 * not every write. `chat update`, `chat archive` and the agent's own read/view
 * state all keep working, and saying "read-only" would send an agent hunting
 * for a workaround it does not need.
 */
export const FEISHU_AGENT_CHAT_WRITE_MESSAGE =
  "This chat is bridged to a Feishu conversation, so messages and membership changes are blocked here: " +
  "a First Tree message reaches nobody, because the humans in this chat only ever see the Feishu group. " +
  "Reply through the Feishu path instead — record the delivery with `feishu intent`, then send it with the " +
  "official `lark-cli --as bot`. Reads, `chat update` and your own archive/read state still work normally.";

export { isFeishuBridgedChat };

/**
 * Reject an agent-scope chat write that would land outside the Feishu group.
 *
 * Call this only AFTER the route has authorized the caller's membership.
 * Running it first would turn the boundary into an oracle: a non-member who
 * guesses a chat UUID could tell bridged chats from ordinary ones by the
 * difference between this 403 and the ordinary not-a-participant error.
 */
export async function assertAgentMutableChat(db: Database, chatId: string): Promise<void> {
  if (await isFeishuBridgedChat(db, chatId)) {
    throw new ForbiddenError(FEISHU_AGENT_CHAT_WRITE_MESSAGE, { code: FEISHU_AGENT_CHAT_WRITE_CODE });
  }
}
