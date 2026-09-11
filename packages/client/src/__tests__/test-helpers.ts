import type { InboxEntryWithMessage, PrecedingMessage } from "@first-tree/shared";
import type { SessionMessage } from "../runtime/handler.js";

/**
 * Minimal stub for the runtime-provided `SessionContext` plumbing fields
 * (forwardResult / buildAgentEnv / formatInboundContent / resolveSenderLabel),
 * so handler tests don't re-stub them in every file.
 *
 * `forwardResult` is a production-faithful NO-OP: the per-turn final-text
 * mirror is retired, so the real `runtime/result-sink.ts` does not deliver to
 * chat — it only closes the turn trigger. The agent's text is captured via
 * `assistant_text` events, not this hook. A handler test that needs to assert
 * an EXPLICIT chat write (e.g. the codex usage-limit runtime notice) mocks
 * `sdk.postRuntimeNotice` on the ctx directly, not through here.
 *
 * The stubbed name-resolution path returns the raw senderId — the production
 * `[From: <name>]` path is covered separately in `agent-io.test.ts`.
 */
export function mockCtxPlumbing(
  _sdk: { sendMessage: (chatId: string, body: Record<string, unknown>) => Promise<unknown> },
  _chatId: string,
): {
  forwardResult: (text: string) => Promise<void>;
  markMessagesConsumed: (messages: SessionMessage | readonly SessionMessage[]) => void;
  finishTurn: (
    messages: SessionMessage | readonly SessionMessage[],
    outcome: { status: "success" | "error"; terminal?: boolean },
  ) => Promise<void>;
  retryTurn: (messages: SessionMessage | readonly SessionMessage[], reason: string) => void;
  buildAgentEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  formatInboundContent: (msg: SessionMessage) => Promise<string>;
  resolveSenderLabel: (senderId: string) => Promise<string>;
  formatFromHeader: (msg: SessionMessage) => Promise<string>;
  publishTeamSkillCommands: (
    commands: readonly { requestedSlug: string; effectiveName: string | null }[] | null,
    provenVersion: number | null,
  ) => void;
} {
  return {
    // Turn-completion hook — delivers nothing (final-text mirror retired).
    forwardResult: async () => {},
    // Default stub: tests that care about ack timing override via spies.
    markMessagesConsumed: () => {},
    finishTurn: async () => {},
    retryTurn: () => {},
    buildAgentEnv: (env) => env,
    formatInboundContent: async (msg) => {
      const raw = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      return msg.senderId ? `[From: ${msg.senderId}]\n\n${raw}` : raw;
    },
    resolveSenderLabel: async (senderId) => senderId,
    formatFromHeader: async (msg) => (msg.senderId ? `[From: ${msg.senderId}]` : ""),
    // Default no-op registry sink; tests that assert the Team Skill command
    // registry override with a capturing stub.
    publishTeamSkillCommands: () => {},
  };
}

/** Create a mock inbox entry for testing. */
export function mockEntry(
  opts: {
    id?: number;
    chatId?: string;
    content?: string;
    senderId?: string;
    inReplyTo?: string | null;
    recipientMode?: "full" | "mention_only";
    metadata?: Record<string, unknown>;
    precedingMessages?: PrecedingMessage[];
    /** Override the derived `message.id`. */
    messageId?: string;
    /** Override the stamped `configVersion` (default 1). */
    configVersion?: number;
  } = {},
): InboxEntryWithMessage {
  const chatId = opts.chatId ?? "chat-1";
  const messageId = opts.messageId ?? `msg-${opts.id ?? 1}`;
  return {
    id: opts.id ?? 1,
    inboxId: "inbox-test",
    messageId,
    chatId,
    status: "delivered",
    retryCount: 0,
    createdAt: new Date().toISOString(),
    deliveredAt: new Date().toISOString(),
    ackedAt: null,
    message: {
      id: messageId,
      chatId,
      senderId: opts.senderId ?? "sender-1",
      senderKind: "member",
      senderProvider: null,
      format: "text",
      content: opts.content ?? "hello",
      metadata: opts.metadata ?? {},
      inReplyTo: opts.inReplyTo ?? null,
      source: null,
      createdAt: new Date().toISOString(),
      configVersion: opts.configVersion ?? 1,
      recipientMode: opts.recipientMode ?? "full",
      precedingMessages: opts.precedingMessages ?? [],
    },
  };
}
