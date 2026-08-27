import type { FirstTreeHubSDK } from "../cloud/sdk.js";
import type { AgentIdentity } from "./handler.js";

/**
 * Chat-level identity block injected into the agent's workspace at bootstrap
 * so the LLM can reason about who else is in the room and (for delegates)
 * who owns it. Deliberately narrow:
 *
 *   - `participants` only contains `name / displayName / type` so the LLM can
 *     decide "do I @-send this human or this agent?" without leaking internal
 *     state. Watcher rows (`access_mode = "watcher"`) are filtered out — they
 *     are silent observers, not participants of the conversation.
 *   - `agentId / access_mode / role / mode` are intentionally NOT exposed —
 *     they're either internal IDs (`@<name>` is the wire mention token) or
 *     decisions that don't help the agent's communication choice.
 *   - `selfOwner` only appears when self is a delegate agent (i.e. has a
 *     `delegateMention` pointing to a participant). Semantically it is the
 *     **human user the delegate represents**, not the chat creator.
 *   - `title` is the server-resolved display title (`chats.topic >` first
 *     message preview `>` participant join) — always non-empty so the agent
 *     can render a meaningful label even when the chat creator didn't set
 *     an explicit topic. `topic` carries the raw column for callers who want
 *     to distinguish "no topic set" from "auto-derived label".
 *
 * See proposals/hub-chat-message-v1-design §四 改造 3.
 */
export type ChatContextParticipant = {
  name: string;
  displayName: string;
  type: "human" | "agent";
};

export type ChatContext = {
  chatId: string;
  /**
   * The chat's owning Team id (`chats.organization_id`), passed through from
   * the server-authored chat detail so skills that need the exact Team (for
   * example Context Tree Seed's `--team`) never have to guess it from the
   * topic, title, or display name. Optional for additive compatibility with
   * contexts built by older runtimes; `fetchChatContext` always populates it.
   */
  organizationId?: string;
  /** Server-resolved display title; always non-empty. */
  title: string;
  /** Raw `chats.topic` column — null when the creator didn't set an explicit topic. */
  topic: string | null;
  /** Raw `chats.description` column — a running "what + current state"
   *  summary; null when never written. */
  description: string | null;
  selfOwner?: { name: string; displayName: string };
  participants: ChatContextParticipant[];
};

/**
 * Build a narrow `ChatContext` snapshot for the current session.
 *
 * Calls the two existing agent-scoped endpoints in parallel:
 *   - `GET /agent/chats/:chatId`              — chat detail (topic)
 *   - `GET /agent/chats/:chatId/participants` — participant rows with names
 *
 * Throws on either HTTP failure so the caller (handler) can log + degrade
 * to the no-context path. The handler then writes neither the identity.json
 * `chatContext` field nor a provider/session Current Chat Context prompt.
 */
export async function fetchChatContext(
  sdk: Pick<FirstTreeHubSDK, "getChatDetail" | "listChatParticipants">,
  chatId: string,
  identity: Pick<AgentIdentity, "type" | "delegateMention">,
): Promise<ChatContext> {
  const [detail, participants] = await Promise.all([sdk.getChatDetail(chatId), sdk.listChatParticipants(chatId)]);

  // Drop participants without a stable `name` slug — rendering them with
  // `displayName` as the `@<token>` would teach the LLM an unresolvable
  // mention (displayName is free text, not a wire-token). Keeps the list
  // path symmetric with `resolveSelfOwner` below, which already hard-filters
  // null names. v1 server-side participants are guaranteed to have a name,
  // so this is currently a defensive no-op; future schema relaxations stay
  // safe by construction.
  //
  // `listChatParticipants` already filters `access_mode = "speaker"` (the
  // server-side query in services/chat/conversation.ts:listChatParticipantsWithNames does
  // the WHERE clause) — watcher rows do not surface here, so no additional
  // client-side filter is needed.
  const filteredParticipants: ChatContextParticipant[] = participants
    .filter((p): p is typeof p & { name: string } => p.name !== null && p.name.length > 0)
    .map((p) => ({
      name: p.name,
      displayName: p.displayName,
      type: p.type === "human" ? "human" : "agent",
    }));

  const selfOwner = resolveSelfOwner(identity, participants);

  return {
    chatId,
    organizationId: detail.organizationId,
    title: detail.title,
    topic: detail.topic,
    description: detail.description,
    ...(selfOwner ? { selfOwner } : {}),
    participants: filteredParticipants,
  };
}

/**
 * For delegate agents (an `agent` whose `delegateMention` points at a chat
 * participant) return `{name, displayName}` of the human owner; for plain
 * `agent` rows with no delegateMention return `undefined`.
 *
 * `delegateMention` holds the OWNER'S `name` slug — see
 * web/.../identity-section.tsx ("delegate <AgentChip ...>").
 */
function resolveSelfOwner(
  identity: Pick<AgentIdentity, "type" | "delegateMention">,
  participants: ReadonlyArray<{ name: string | null; displayName: string; type: string }>,
): { name: string; displayName: string } | undefined {
  if (identity.type !== "agent") return undefined;
  if (!identity.delegateMention) return undefined;
  const owner = participants.find((p) => p.name === identity.delegateMention && p.type === "human");
  if (!owner || !owner.name) return undefined;
  return { name: owner.name, displayName: owner.displayName };
}
