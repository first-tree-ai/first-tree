import type { ChatExternalChannel } from "@first-tree/shared";

/**
 * Agent-session preconditions for the two chat commands the server cannot gate.
 *
 * `POST /agent/chats` never learns which chat the caller is sitting in — the
 * originating chat is not in `createTaskChatSchema`, not a header, and the
 * route has nothing to look up. `chat open` is worse: it runs on the user scope
 * and starts an interactive REPL, which is meaningless in a non-interactive
 * agent session. So both are refused client-side, before anything is created.
 *
 * The signal is `ChatDetail.externalChannel`, the same live `im_chat_bindings`
 * state the server-side guard enforces — not `metadata.source`, which stays
 * `"feishu"` after a binding detaches and would refuse commands the server
 * would happily accept.
 *
 * FAIL CLOSED. An earlier revision treated any lookup failure as "not a Feishu
 * chat" and proceeded. That was a real bypass, not just a rough edge: `chat
 * create --agent <other>` ran the origin lookup as the overridden agent, and an
 * agent that is not a member of the origin chat gets a 403 — which the
 * fail-open path read as permission to create. Three changes close it:
 *
 *   1. The origin chat is resolved under the SESSION identity (see
 *      `chat create`), so the lookup is performed by an agent that can
 *      actually see the chat. `--agent` still chooses who creates the new
 *      chat; it no longer decides who is allowed to answer the origin
 *      question. An unrelated agent's membership never becomes a requirement
 *      for an ordinary create.
 *   2. An inconclusive answer refuses instead of allowing.
 *   3. Only an EXPLICIT `null` counts as "not bridged". A missing field, a
 *      value this CLI does not recognise, or a session that carries a chat id
 *      but no agent id are all `unknown`, because each of them is a state a
 *      rolling deploy actually produces: a server older than
 *      `externalChannel` omits it, and a half-configured session cannot read
 *      the chat as the session agent. Reading any of those as "ordinary chat"
 *      is how the guard silently switches itself off mid-deploy.
 *
 * Refusing on an inconclusive lookup costs nothing in practice: the lookup and
 * the create talk to the same server with the same credentials, so a failure
 * here means the create was going to fail anyway. All the refusal changes is
 * that the operator gets a precise reason instead of a confusing downstream
 * error — and in the one case where the lookup fails but the create would have
 * succeeded, guessing is exactly what produced this bug.
 *
 * THE ONE ALLOWED SILENCE is "no chat context at all". `chat open` is a human
 * operator's command; that terminal exports neither variable and may have no
 * agent configured. Absent `FIRST_TREE_CHAT_ID` therefore means "not running
 * inside a chat" and is allowed without any lookup. Present-but-unresolvable
 * is the opposite case and refuses.
 */

export const FEISHU_CHAT_CONTEXT_CODE = "FEISHU_CHAT_CONTEXT";
export const FEISHU_CHAT_CONTEXT_UNKNOWN_CODE = "FEISHU_CHAT_CONTEXT_UNKNOWN";

export const FEISHU_GUARDED_COMMANDS = ["create", "open"] as const;
export type FeishuGuardedCommand = (typeof FEISHU_GUARDED_COMMANDS)[number];

/**
 * Minimal SDK surface this check needs, so tests can supply a stub.
 * `externalChannel` is optional here even though `ChatDetail` declares it:
 * a server older than the field simply omits it from the JSON body, and the
 * SDK does not re-parse the response through Zod. That is exactly why the
 * resolver below treats "absent" as `unknown` rather than as `null`.
 */
export type ChatDetailReader = {
  getChatDetail(chatId: string): Promise<{ externalChannel?: ChatExternalChannel | null }>;
};

/**
 * Built lazily, because an operator terminal running `chat open` may have no
 * agent configured at all — constructing an SDK there would fail on a machine
 * where the command is perfectly legitimate. The factory runs only once a chat
 * id proves there is a session to check.
 */
export type ChatDetailReaderFactory = () => ChatDetailReader;

/** The agent-session environment the check reads its context from. */
export type FeishuSessionContext = {
  /** `FIRST_TREE_CHAT_ID` — the chat this session is running inside. */
  chatId: string | undefined;
  /** `FIRST_TREE_AGENT_ID` — the identity that can read that chat. */
  agentId: string | undefined;
};

export type FeishuChatContextRefusal = {
  code: string;
  message: string;
};

/**
 * Tri-state on purpose. Collapsing `unknown` into `unbridged` is precisely the
 * fail-open that let `--agent <other>` through.
 */
export type FeishuChatContextState = { kind: "bridged" } | { kind: "unbridged" } | { kind: "unknown"; reason: string };

const REASONS: Record<FeishuGuardedCommand, string> = {
  create:
    "`chat create` would open a First Tree task chat nobody in the Feishu group can see, and the new chat would " +
    "carry no way back to them.",
  open: "`chat open` starts an interactive REPL against a First Tree chat, which an agent session cannot drive.",
};

/** Build the refusal text for one guarded command in a confirmed bridged chat. */
export function feishuChatContextMessage(command: FeishuGuardedCommand): string {
  return (
    `This agent session is running inside a chat bridged to a Feishu conversation. ${REASONS[command]} ` +
    "Reply in the Feishu conversation instead — record the delivery with `feishu intent`, then send it with the " +
    "official `lark-cli --as bot`. To reach a First Tree teammate about this work, hand off from a chat that is " +
    "not bridged."
  );
}

/** Build the refusal text for an origin check that could not be completed. */
export function feishuChatContextUnknownMessage(command: FeishuGuardedCommand, reason: string): string {
  return (
    `Could not determine whether this agent session's chat is bridged to a Feishu conversation (${reason}). ` +
    `\`chat ${command}\` is refused rather than guessed, because ${REASONS[command]} ` +
    "Retry once the server is reachable and up to date; export FIRST_TREE_AGENT_ID so the chat can be read as the " +
    "session agent; if this session is not attached to a chat at all, unset FIRST_TREE_CHAT_ID; or run the command " +
    "from a session whose chat is not bridged."
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return String(error);
}

/**
 * Resolve whether the current session's chat is bridged to Feishu.
 *
 * The caller must pass an SDK bound to an identity that can actually read the
 * chat — in practice the session agent, never a `--agent` override.
 */
export async function resolveFeishuChatContext(sdk: ChatDetailReader, chatId: string): Promise<FeishuChatContextState> {
  let detail: { externalChannel?: ChatExternalChannel | null };
  try {
    detail = await sdk.getChatDetail(chatId);
  } catch (error) {
    return { kind: "unknown", reason: describeError(error) };
  }
  if (detail === null || typeof detail !== "object") {
    return { kind: "unknown", reason: "the server returned a chat detail this CLI cannot read" };
  }
  const channel: unknown = detail.externalChannel;
  // ONLY an explicit null is "this chat is not bridged". Everything else is a
  // state we cannot interpret, and a guard that guesses in that state is not a
  // guard.
  if (channel === null) return { kind: "unbridged" };
  if (channel === "feishu") return { kind: "bridged" };
  if (channel === undefined) {
    return {
      kind: "unknown",
      reason:
        "the server did not report this chat's externalChannel — it is probably older than the field, " +
        "which a rolling deploy makes temporary",
    };
  }
  return {
    kind: "unknown",
    reason: `the server reported an externalChannel this CLI does not recognise (${JSON.stringify(channel)})`,
  };
}

/**
 * Full precondition for a guarded command: returns the refusal to report, or
 * `null` when the command may proceed.
 *
 * The distinction that matters is NOT "is an agent configured" but "is there a
 * chat context at all":
 *
 *   - no `FIRST_TREE_CHAT_ID` → the command is not running inside a chat.
 *     Ordinary operator terminal; allowed without a lookup, and the reader is
 *     never even constructed.
 *   - `FIRST_TREE_CHAT_ID` with no `FIRST_TREE_AGENT_ID` → there IS a chat
 *     context, but nothing can read it as the session agent, so its
 *     bridged-ness cannot be established. Refused as `unknown`, because
 *     skipping the check here used to make an incomplete environment the
 *     easiest way around the guard.
 */
export async function checkFeishuChatContext(
  readerFactory: ChatDetailReaderFactory,
  session: FeishuSessionContext,
  command: FeishuGuardedCommand,
): Promise<FeishuChatContextRefusal | null> {
  if (!session.chatId) return null;

  const state = await resolveSessionState(readerFactory, session);
  if (state.kind === "unbridged") return null;
  if (state.kind === "bridged") {
    return { code: FEISHU_CHAT_CONTEXT_CODE, message: feishuChatContextMessage(command) };
  }
  return {
    code: FEISHU_CHAT_CONTEXT_UNKNOWN_CODE,
    message: feishuChatContextUnknownMessage(command, state.reason),
  };
}

async function resolveSessionState(
  readerFactory: ChatDetailReaderFactory,
  session: FeishuSessionContext,
): Promise<FeishuChatContextState> {
  const chatId = session.chatId;
  if (!chatId) return { kind: "unbridged" };
  if (!session.agentId) {
    return {
      kind: "unknown",
      reason:
        "FIRST_TREE_CHAT_ID names a chat but FIRST_TREE_AGENT_ID is unset, so this CLI cannot read that chat " +
        "as the session agent",
    };
  }
  let reader: ChatDetailReader;
  try {
    reader = readerFactory();
  } catch (error) {
    return { kind: "unknown", reason: describeError(error) };
  }
  return resolveFeishuChatContext(reader, chatId);
}
