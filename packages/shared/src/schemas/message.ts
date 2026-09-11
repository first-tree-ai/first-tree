import { z } from "zod";

// -- Message Source (which entry point created this message) --

/**
 * Entry point that produced this message. Required (NOT NULL) after v2 —
 * every write path must declare its caller-stack origin so observability /
 * loop / egress diagnostics can join on it.
 *
 *   - "web"     — First Tree web UI (POST /chats/:id/messages from a browser
 *                 session).
 *   - "cli"     — Agent's First Tree CLI (`chat send` / `chat invite`
 *                 / etc.).
 *   - "api"     — Agent SDK direct API call (incl. deliberate runtime notices
 *                 such as the codex usage-limit notice, in-process tool
 *                 integrations); the catch-all for client runtime-initiated
 *                 writes that aren't typed via the CLI.
 *   - "github"  — Inbound message bridged from a GitHub webhook.
 *   - "feishu"  — Inbound message accepted from the trusted Feishu channel.
 *
 * NOT a behaviour discriminator — use `purpose` for that (e.g. distinguishing
 * a regular agent send from a deliberate `agent-final-text` runtime notice,
 * which may carry source='api'). `source` is the caller-stack origin, intended
 * for observability and loop / egress diagnostics.
 */
export const MESSAGE_SOURCES = {
  WEB: "web",
  CLI: "cli",
  GITHUB: "github",
  GITLAB: "gitlab",
  API: "api",
  FEISHU: "feishu",
} as const;

export const messageSourceSchema = z.enum(["web", "cli", "github", "gitlab", "api", "feishu"]);
export type MessageSource = z.infer<typeof messageSourceSchema>;

export const MESSAGE_SENDER_KINDS = {
  MEMBER: "member",
  INTEGRATION: "integration",
} as const;
export const messageSenderKindSchema = z.enum(["member", "integration"]);
export type MessageSenderKind = z.infer<typeof messageSenderKindSchema>;

export const MESSAGE_SENDER_PROVIDERS = {
  FEISHU: "feishu",
} as const;
export const messageSenderProviderSchema = z.enum(["feishu"]);
export type MessageSenderProvider = z.infer<typeof messageSenderProviderSchema>;

/** Stable sender id used by trusted Feishu ingress. It never resolves to an Agent row. */
export const FEISHU_INTEGRATION_SENDER_ID = "integration:feishu";

export const feishuExternalAuthorSchema = z.object({
  openId: z.string().min(1),
  unionId: z.string().min(1).nullable().optional(),
  userId: z.string().min(1).nullable().optional(),
  displayName: z.string().min(1),
  tenantKey: z.string().min(1).nullable().optional(),
});
export type FeishuExternalAuthor = z.infer<typeof feishuExternalAuthorSchema>;

export const feishuMessageReferenceSchema = z.object({
  messageId: z.string().min(1),
  chatId: z.string().min(1),
  chatType: z.enum(["p2p", "group"]),
  threadId: z.string().min(1).nullable().optional(),
  rootId: z.string().min(1).nullable().optional(),
  parentId: z.string().min(1).nullable().optional(),
  sentAt: z.string().datetime().nullable().optional(),
});
export type FeishuMessageReference = z.infer<typeof feishuMessageReferenceSchema>;

export const feishuMentionSchema = z.object({
  key: z.string().min(1),
  openId: z.string().min(1).nullable().optional(),
  userId: z.string().min(1).nullable().optional(),
  name: z.string().nullable().optional(),
  isBot: z.boolean().default(false),
});
export type FeishuMention = z.infer<typeof feishuMentionSchema>;

export const feishuResourceUnavailableReasonSchema = z.enum([
  "too_many",
  "too_large",
  "permission_denied",
  "confidential",
  "deleted",
  "unsupported",
  "download_failed",
  "invalid_response",
]);
export type FeishuResourceUnavailableReason = z.infer<typeof feishuResourceUnavailableReasonSchema>;

/** A provider resource reference plus the result of the one ingress hydration attempt. */
export const feishuResourceSchema = z.object({
  type: z.enum(["image", "file", "audio", "video", "sticker"]),
  fileKey: z.string().min(1),
  fileName: z.string().min(1).nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  coverImageKey: z.string().min(1).nullable().optional(),
  origin: z.enum(["message", "post", "interactive", "merge_forward"]).default("message"),
  hydration: z.discriminatedUnion("state", [
    z.object({
      state: z.literal("succeeded"),
      attachmentId: z.string().uuid(),
      mimeType: z.string().min(1),
      size: z.number().int().positive(),
    }),
    z.object({
      state: z.literal("unavailable"),
      reason: feishuResourceUnavailableReasonSchema,
      detail: z.string().min(1).max(500).nullable().optional(),
    }),
  ]),
});
export type FeishuResource = z.infer<typeof feishuResourceSchema>;

export const feishuOutboundMediaIdentitySchema = z.object({
  kind: z.enum(["file", "image", "video", "audio"]),
  filename: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  cover: z
    .object({
      filename: z.string().min(1).max(255),
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .optional(),
});
export type FeishuOutboundMediaIdentity = z.infer<typeof feishuOutboundMediaIdentitySchema>;

/** Immutable external target chosen by the Agent for one outbound message. */
export const feishuOutboundIntentSchema = z.object({
  operation: z.enum(["send", "reply"]),
  chatId: z.string().min(1),
  chatType: z.enum(["p2p", "group"]),
  targetMessageId: z.string().min(1).nullable().optional(),
  replyInThread: z.boolean().default(false),
  /** First Tree message id, also supplied to Feishu as its one-hour idempotency key. */
  idempotencyKey: z.string().min(1).max(50),
  /** Digest of the exact provider payload accepted when this intent was created. */
  payloadSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Stable byte identity for media sent directly by official lark-cli. */
  media: feishuOutboundMediaIdentitySchema.nullable().optional(),
});
export type FeishuOutboundIntent = z.infer<typeof feishuOutboundIntentSchema>;

/** Server-authored metadata for a canonical message bridged to or from Feishu. */
export const feishuMessageMetadataSchema = z.discriminatedUnion("direction", [
  z.object({
    version: z.literal(1),
    direction: z.literal("inbound"),
    botBindingId: z.string().min(1),
    reference: feishuMessageReferenceSchema,
    externalAuthor: feishuExternalAuthorSchema,
    eventId: z.string().min(1).nullable().optional(),
    messageType: z.string().min(1),
    mentions: z.array(feishuMentionSchema).default([]),
    resources: z.array(feishuResourceSchema).default([]),
  }),
  z.object({
    version: z.literal(1),
    direction: z.literal("outbound"),
    botBindingId: z.string().min(1),
    intent: feishuOutboundIntentSchema,
  }),
]);
export type FeishuMessageMetadata = z.infer<typeof feishuMessageMetadataSchema>;

export function readFeishuMessageMetadata(
  metadata: Record<string, unknown> | null | undefined,
): FeishuMessageMetadata | null {
  const parsed = feishuMessageMetadataSchema.safeParse(metadata?.feishu);
  return parsed.success ? parsed.data : null;
}

/**
 * Send-time-only marker set by the CLI for body channels that intentionally
 * bypass inline shell-shape guards. The server may use it with source="cli" to
 * preserve the stdin/message-file escape hatch for literal `\n` text, but must
 * strip it before storage so user metadata cannot become a durable trust flag.
 */
export const CLI_BODY_ORIGIN_METADATA_KEY = "cliBodyOrigin";
export const CLI_BODY_ORIGINS = {
  STDIN: "stdin",
  MESSAGE_FILE: "message-file",
} as const;
export type CliBodyOrigin = (typeof CLI_BODY_ORIGINS)[keyof typeof CLI_BODY_ORIGINS];

/**
 * Server-owned marker on a human's "Ask agent" clarification message.
 *
 * The browser never writes this metadata directly. It posts the visible
 * clarification text to the request-scoped endpoint; the server validates the
 * still-open request + its original asker, then stamps this marker and routes
 * the message to that agent. Ordinary message sends strip the key, so the
 * runtime may safely use it to attach a fixed steering envelope without
 * persisting hidden prompt text in chat history.
 */
export const ASK_AGENT_METADATA_KEY = "askAgent";
export const askAgentMessageMetadataSchema = z.object({
  requestId: z.string().min(1),
  agentId: z.string().min(1),
});
export type AskAgentMessageMetadata = z.infer<typeof askAgentMessageMetadataSchema>;

export function readAskAgentMessageMetadata(
  metadata: Record<string, unknown> | null | undefined,
): AskAgentMessageMetadata | null {
  const parsed = askAgentMessageMetadataSchema.safeParse(metadata?.[ASK_AGENT_METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}

/**
 * Server-owned marker on the stored bootstrap message of an ordinary first
 * chat. Web uses it to replace that row with the senderless Orientation
 * surface: the member does not see the bootstrap body or its persisted human
 * sender attribution. It is presentation metadata only and never becomes
 * agent prompt text; the stored bootstrap and the user's next visible turn
 * remain the complete conversational context replayed to the original target.
 */
export const FIRST_CHAT_ORIENTATION_METADATA_KEY = "firstChatOrientation";
export const firstChatOrientationMessageMetadataSchema = z.object({
  version: z.literal(1),
});
export type FirstChatOrientationMessageMetadata = z.infer<typeof firstChatOrientationMessageMetadataSchema>;

export function readFirstChatOrientationMessageMetadata(
  metadata: Record<string, unknown> | null | undefined,
): FirstChatOrientationMessageMetadata | null {
  const parsed = firstChatOrientationMessageMetadataSchema.safeParse(metadata?.[FIRST_CHAT_ORIENTATION_METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}

/**
 * Server-owned marker on the first visible human turn that consumes a pending
 * first-chat Orientation handoff. It binds the deferred bootstrap replay to
 * that exact notify trigger and the original bootstrap target. Ordinary
 * message writes cannot supply it.
 */
export const FIRST_CHAT_ORIENTATION_CONTINUATION_METADATA_KEY = "firstChatOrientationContinuation";
export const firstChatOrientationContinuationMessageMetadataSchema = z.object({
  version: z.literal(1),
  targetAgentId: z.string().min(1),
});
export type FirstChatOrientationContinuationMessageMetadata = z.infer<
  typeof firstChatOrientationContinuationMessageMetadataSchema
>;

export function readFirstChatOrientationContinuationMessageMetadata(
  metadata: Record<string, unknown> | null | undefined,
): FirstChatOrientationContinuationMessageMetadata | null {
  const parsed = firstChatOrientationContinuationMessageMetadataSchema.safeParse(
    metadata?.[FIRST_CHAT_ORIENTATION_CONTINUATION_METADATA_KEY],
  );
  return parsed.success ? parsed.data : null;
}

/** Human-authored visible body accepted by the request-scoped Ask agent route. */
export const askAgentQuestionSchema = z.object({
  content: z.string().trim().min(1).max(4_000),
});
export type AskAgentQuestion = z.infer<typeof askAgentQuestionSchema>;

export const MESSAGE_FORMATS = {
  TEXT: "text",
  MARKDOWN: "markdown",
  CARD: "card",
  REFERENCE: "reference",
  FILE: "file",
  /**
   * Open question — an "ask" directed at a single human (the sole entry in
   * `metadata.mentions`). The ask itself is the message body (`content`);
   * `metadata.request` carries only the answer affordance (optional `options`
   * + `multiSelect`). No lifecycle state is stored on the message.
   *
   * BLOCKING: while such a question is unresolved, the web UI blocks that chat
   * for the target human — it pins the question and hides every message after
   * it until the human answers (several open questions are worked
   * oldest-first / FIFO). The block is viewer-local: only the target is
   * blocked; other participants see the full timeline with a read-only card.
   *
   * Lifecycle is driven by an EXPLICIT resolution signal: a question is
   * answered/closed only by a later message carrying `metadata.resolves` (see
   * `requestResolutionSchema`), which drives `chat_user_state.open_request_count`
   * down. The target's Submit resolves it with `kind="answered"`; Skip resolves
   * it with `kind="closed"`. NEW resolutions are human-only — the server accepts
   * a `resolves` write only from the target. An
   * agent CAN post a plain `chat send <human>` follow-up (an informational free
   * reply; it carries no `resolves`, raises no red dot, and never resolves the
   * question), but it cannot answer/close the question itself. Lifecycle readers
   * additionally honor a legacy asker-authored resolution row (written before
   * the refinement) for backward-compat. `inReplyTo` itself is pure threading
   * and never changes a question's lifecycle.
   */
  REQUEST: "request",
} as const;

export const messageFormatSchema = z.enum(["text", "markdown", "card", "reference", "file", "request"]);
export type MessageFormat = z.infer<typeof messageFormatSchema>;

/**
 * One answer option on an ask. Options come 2–4 at a time, or are omitted
 * entirely for a free-text answer.
 */
export const askOptionSchema = z.object({
  /**
   * 1–5 words. Hard-capped: a label longer than five words is a description,
   * not a label — put the explanation in `description`.
   */
  label: z
    .string()
    .min(1)
    .refine(
      (s) => {
        const words = s.trim().split(/\s+/).filter(Boolean).length;
        return words >= 1 && words <= 5;
      },
      { message: "label must be 1–5 words" },
    ),
  /** Explains the option's meaning / trade-off. */
  description: z.string().min(1),
  /** Optional mockup / code snippet rendered when the option is focused. */
  preview: z.string().optional(),
});
export type AskOption = z.infer<typeof askOptionSchema>;

/**
 * Shape of `metadata.request` on a `format="request"` message. The ask itself
 * is the message body (`content`); this payload carries only the answer
 * affordance:
 *   - omit `options` → free-text answer.
 *   - 2–4 `options` → a choice; `multiSelect` toggles single vs. multiple.
 * Server-opaque (the send path validates only the single-human-target rule,
 * not this payload) — the web parses it with `safeParse` to render the answer
 * block, mirroring how `githubEventCardSchema` gates card rendering.
 */
export const askRequestSchema = z
  .object({
    options: z.array(askOptionSchema).min(2).max(4).optional(),
    multiSelect: z.boolean().default(false),
  })
  .refine((r) => r.options !== undefined || r.multiSelect === false, {
    message: "multiSelect requires options",
  });
export type AskRequest = z.infer<typeof askRequestSchema>;

/**
 * Explicit lifecycle signal carried in `metadata.resolves` on a reply to a
 * `format="request"` message. This is the ONLY thing that answers or closes
 * an open question — `inReplyTo` no longer does (it is pure threading now).
 *
 * Written ONLY by the target human's web answer surface — picking an option OR
 * typing free text attaches `resolves` (kind="answered"), while Skip attaches
 * `resolves` (kind="closed"). The surface has no "reply without resolving"
 * path, so every action completes the request lifecycle.
 * An agent (including the asker) **cannot** write a resolution: the server
 * authorizes a NEW resolution only from the question's target, so an agent
 * answers nothing and closes nothing. (Pre-refinement history may still hold
 * asker-authored resolution rows from when an agent could resolve; readers and
 * the idempotency scan honor those for backward-compat, but no new ones can be
 * written.) A bare threaded reply that carries no `resolves` does not resolve —
 * `inReplyTo` is pure threading.
 *
 *   - kind="answered" — the question is answered. The readable answer stays in
 *     the message `content`.
 *   - kind="closed"   — the target human skipped the question without providing
 *     an answer. The readable Skip note stays in `content`; `reason` optionally
 *     explains why.
 *
 * Server-opaque except for the `open_request_count` counter, whose −1 keys
 * off `resolves.request`. The web parses it with `safeParse`.
 */
export const requestResolutionSchema = z.object({
  request: z.string().min(1),
  kind: z.enum(["answered", "closed"]),
  reason: z.string().optional(),
});
export type RequestResolution = z.infer<typeof requestResolutionSchema>;

/**
 * Optional intent tag set by the client when posting a message. Tells the
 * server *why* this write is happening so it can pick the right
 * enforcement profile. `purpose` is consumed by the server during the
 * write and is NEVER persisted — no value of it is written to message
 * metadata or any durable store.
 *
 *   - `"agent-final-text"`: a recipientless, human-observable runtime message.
 *     It lands in chat history for human observers, does not wake other agents,
 *     and is not subject to the group-chat `@mention required` guard — it is
 *     surfaced for humans, not addressed into the room. The per-turn final-text
 *     MIRROR that used to ride this purpose is RETIRED (an agent's final text is
 *     its output stream, not a chat message — see `runtime/result-sink.ts`);
 *     the purpose still supplies the silent recipientless delivery profile for
 *     deliberate handler-emitted runtime notices when paired with
 *     `metadata.runtimeNotice=true`.
 *
 *   - `TEAM_SKILL_INVOCATION_MESSAGE_PURPOSE` (`"team-skill-invocation-v1"`):
 *     the versioned protocol sentinel for a Team Skill slash invocation
 *     send. A Web client that carries a `skillPrecondition` MUST also send
 *     this purpose, and the server enforces the pair in BOTH directions
 *     (precondition without sentinel and sentinel without precondition are
 *     both rejected before any insert). Because the LEGACY server's
 *     `messagePurposeSchema` accepts only `agent-final-text`, a new-Web →
 *     old-Server send fails schema validation outright — an old server can
 *     never silently strip an unknown top-level `skillPrecondition` and
 *     persist the bare `/slug` as an unmarked local command. The sentinel
 *     takes the ORDINARY routing profile: none of the `agent-final-text`
 *     silent/recipientless privileges apply.
 *
 * Default-`undefined` means a regular agent-initiated send (CLI `chat send`,
 * API, etc.) and goes through the normal enforcement profile.
 */
export const TEAM_SKILL_INVOCATION_MESSAGE_PURPOSE = "team-skill-invocation-v1";
export const messagePurposeSchema = z.enum(["agent-final-text", TEAM_SKILL_INVOCATION_MESSAGE_PURPOSE]);
export type MessagePurpose = z.infer<typeof messagePurposeSchema>;

/**
 * Metadata flag the server stamps on a STORED message when it was sent with
 * `purpose: "agent-final-text"` (see client `runtime/result-sink.ts` for the
 * now-retired per-turn mirror; the purpose lives on as a recipientless runtime
 * notice). `purpose` itself is a send-time-only intent tag that the server
 * consumes for enforcement and does NOT persist, so this boolean is the only
 * durable post-save signal distinguishing such a message from a deliberate
 * agent `chat send`. Server-owned: stamped only for a NON-HUMAN sender with the
 * final-text purpose and never honored from inbound client metadata, so a
 * human/web send carrying `purpose` cannot masquerade as one. The web reads it
 * to optionally hide these rows behind a staging-only view toggle; absent /
 * false on every other message.
 */
export const AGENT_FINAL_TEXT_METADATA_KEY = "agentFinalText";

/**
 * Metadata flag marking a STORED message as an operator-facing runtime notice
 * ("the provider failed", "the usage limit is reached") rather than anything
 * the agent chose to say.
 *
 * SERVER-OWNED, like `AGENT_FINAL_TEXT_METADATA_KEY`: the server strips any
 * inbound copy on every write path and re-stamps the flag itself, so the stored
 * value always reflects which endpoint was called rather than what a body
 * claimed. That keeps the classification honest — the flag decides whether a
 * row counts as an agent final-text mirror, which the staging view toggle
 * filters on.
 *
 * It is a CLASSIFICATION LABEL, not a capability. It confers no authority a
 * caller does not already have: the dedicated runtime-notice endpoint is gated
 * on chat membership exactly like an ordinary send, so any credential that can
 * reach one can reach the other.
 */
export const RUNTIME_NOTICE_METADATA_KEY = "runtimeNotice";

/**
 * Upper bound on a runtime notice's text. The longest notice the runtime
 * composes today is a provider-failure lead plus a 500-character redacted
 * provider preview; this leaves generous headroom while keeping the dedicated
 * route from becoming a general-purpose writing surface.
 */
export const RUNTIME_NOTICE_MAX_LENGTH = 4_000;

/**
 * Body of `POST /api/v1/agent/chats/:chatId/runtime-notices`.
 *
 * Deliberately carries ONLY the notice text: `source`, `format`, `purpose` and
 * every metadata marker are authored by the server. `.strict()` makes an
 * attempt to smuggle those fields a 400 rather than a silent drop, so a caller
 * that still believes it can shape the stored row fails loudly.
 */
export const runtimeNoticeRequestSchema = z
  .object({
    content: z.string().min(1).max(RUNTIME_NOTICE_MAX_LENGTH),
  })
  .strict();
export type RuntimeNoticeRequest = z.infer<typeof runtimeNoticeRequestSchema>;

/**
 * The wire shape a client OLDER than the runtime-notice endpoint uses to
 * publish the same notice: an ordinary agent send decorated with the marker and
 * the silent final-text delivery purpose. Every pre-endpoint call site — the
 * provider-failure notice and both Codex usage-limit notices — emitted exactly
 * these five fields.
 *
 * It exists in shared so the two halves of the rolling-deploy story cannot
 * drift: the SDK falls back to this body when the new endpoint 404s on an older
 * server, and the server recognises this body with
 * `isLegacyRuntimeNoticeSend()` when an older client posts to a new server. A
 * provider-failure notice is most valuable exactly during a deploy, so neither
 * direction may drop it.
 */
export function legacyRuntimeNoticeSendBody(content: string): SendMessage {
  return {
    source: "api",
    format: "text",
    content,
    metadata: { [RUNTIME_NOTICE_METADATA_KEY]: true },
    purpose: "agent-final-text",
  };
}

/**
 * True when a send body is exactly the legacy runtime-notice shape above.
 *
 * SHAPE MATCHING, NOT AUTHORIZATION. The match is deliberately exact — the
 * final-text purpose, `format: "text"`, `source: "api"`, and `runtimeNotice`
 * as the sole metadata key — so it recognises the bodies real older clients
 * emit and nothing else. It is not a permission check and must not be read as
 * one: any caller could assemble this body, just as any caller could POST to
 * the runtime-notice endpoint directly. Both are membership-gated and neither
 * is a security boundary; matching here only preserves the delivery an older
 * client already had.
 */
export function isLegacyRuntimeNoticeSend(body: {
  format?: unknown;
  source?: unknown;
  purpose?: unknown;
  metadata?: Record<string, unknown> | null;
}): boolean {
  if (body.purpose !== "agent-final-text") return false;
  if (body.format !== "text") return false;
  if (body.source !== "api") return false;
  const metadata = body.metadata;
  if (!metadata) return false;
  const keys = Object.keys(metadata);
  return keys.length === 1 && keys[0] === RUNTIME_NOTICE_METADATA_KEY && metadata[RUNTIME_NOTICE_METADATA_KEY] === true;
}

/** True when a stored message's metadata marks it as an agent final-text mirror. */
export function isAgentFinalTextMetadata(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.[AGENT_FINAL_TEXT_METADATA_KEY] === true;
}

/** True when a stored message was emitted by the runtime as an operator notice. */
export function isRuntimeNoticeMetadata(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.[RUNTIME_NOTICE_METADATA_KEY] === true;
}

// -- Team Skill invocation marker (server-owned, persisted) --

/**
 * Server-owned marker stamped into a stored message's `metadata` when the
 * send carried a valid `skillPrecondition`: proof that the leading slash
 * command was chosen from the recipient agent's First Tree Team Skill menu,
 * not typed as a local/runtime command. The marker is what lets the
 * recipient's Client tell "Team Skill intent selected at config version N"
 * apart from "a hand-typed local command" no matter how long the message
 * sat in the inbox queue or how the config changed in between — the
 * delivery-time `configVersion` stamp alone cannot carry that distinction.
 *
 * SERVER-OWNED and CANONICAL: the message transaction writes this field
 * only after the precondition validates, builds it from the validated
 * EFFECTIVE resource row (never from the request's untrusted fields),
 * overwrites any client-supplied value, and strips it from sends without a
 * valid precondition, so a forged marker never survives the write path.
 *
 * Presence semantics for consumers: the KEY being present always means
 * "server-validated Team intent" — a present-but-malformed or mismatched
 * marker is NOT equivalent to an absent one. Only a truly absent key lets
 * a strict slash command fall through to local/runtime Skills; anything
 * else must fail closed (see the Client's rewrite boundary).
 */
export const TEAM_SKILL_INVOCATION_METADATA_KEY = "teamSkillInvocation";

export const TEAM_SKILL_INVOCATION_MARKER_VERSION = 1;

/**
 * Versioned invocation marker. `requestedSlug` is the canonical
 * `normalizeTeamSkillTargetSlug` output — the schema deliberately does NOT
 * re-invent slug charset/length/reserved-name rules; the materializer's
 * normalizer is the single identity rule, applied by the server at stamp
 * time and by the client at resolve time.
 */
export const teamSkillInvocationSchema = z.object({
  /** Marker contract version. Unknown versions read as malformed. */
  version: z.literal(TEAM_SKILL_INVOCATION_MARKER_VERSION),
  /** The single agent the command was addressed to. */
  recipientAgentId: z.string().min(1),
  /** Team resource id the command was chosen from. */
  resourceId: z.string().min(1),
  /** Canonical base slug the user typed (pre-collision-suffix). */
  requestedSlug: z.string().min(1),
  /** The agent's `agent_configs.version` at selection time. */
  configVersion: z.number().int().positive(),
});
export type TeamSkillInvocation = z.infer<typeof teamSkillInvocationSchema>;

/** True when the metadata carries the marker KEY at all — even a malformed value. */
export function hasTeamSkillInvocationMarker(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata != null && TEAM_SKILL_INVOCATION_METADATA_KEY in metadata;
}

/**
 * Wire-only inert replacement for a marker-carrying message delivered to a
 * client whose `sdk_version` does not support the invocation marker. An old
 * client would ignore the marker and hand the base literal to a same-named
 * local Skill, so the server's DB-row→wire boundary replaces the command
 * content (text or image caption) with this notice instead — the stored
 * message, attachments, and metadata are never touched, and the turn still
 * settles normally (no parked FIFO behind a rollback). The text keeps NO
 * leading slash token, so it can never parse as a command itself.
 */
export const TEAM_SKILL_INVOCATION_UNSUPPORTED_CLIENT_NOTICE =
  "[First Tree] The user invoked a configured Team Skill command, but the currently connected agent client " +
  "is too old to run it safely, so the command was not run. Do NOT invoke any slash command or a same-named " +
  "local Skill on their behalf. Briefly explain to the user that the command could not run on the current " +
  "client and ask them to send it again once the agent's client is up to date.";

/**
 * Parse the server-owned Team Skill invocation marker from message metadata.
 * Absent or malformed → null; callers that must distinguish "no Team
 * intent" from "unverifiable Team intent" check
 * {@link hasTeamSkillInvocationMarker} first.
 */
export function teamSkillInvocationFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): TeamSkillInvocation | null {
  const raw = metadata?.[TEAM_SKILL_INVOCATION_METADATA_KEY];
  if (raw === undefined || raw === null) return null;
  const parsed = teamSkillInvocationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export const sendMessageSchema = z.object({
  format: messageFormatSchema.default("text"),
  content: z.unknown(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  inReplyTo: z.string().optional(),
  /**
   * Required output (NOT NULL in `messages.source`). The Zod `.default("api")`
   * lets HTTP request bodies omit the field — pre-v2 HTTP clients still
   * send messages without `source`, and a deploy that suddenly 422'd those
   * requests would be a needless coupling break. The default fills in for
   * those callers; in-process TS callers go through `z.infer<>` (= the
   * `SendMessage` type), where `source` is structurally required and must be
   * passed explicitly so a forgotten value surfaces as a compile error
   * rather than silently labelling everything `'api'`.
   */
  source: messageSourceSchema.default("api"),
  purpose: messagePurposeSchema.optional(),
  /**
   * Recipient agent names that the server should resolve to uuids against
   * the chat's participant list and add to the message's `mentions`. Lets
   * a caller who knows the recipient by name (CLI `chat send <name>`,
   * tool integrations, etc.) declare routing intent without having to
   * pre-resolve uuids client-side. Server cross-validates each name
   * against the chat's speakers — an unknown name fails the write with
   * a hint pointing at `chat invite`. Agent-typed clients should always
   * prefer this over relying on `@<name>` extraction from `content`.
   */
  receiverNames: z.array(z.string().min(1)).optional(),
  /**
   * Transient, request-level precondition for a Team Skill slash command
   * chosen from the slash menu. The sender asserts the command was selected
   * for exactly this recipient, from this Team resource, while the agent's
   * runtime config was at this version. The message transaction re-validates
   * the recipient set and the config version before inserting: a removed or
   * renamed Team Skill (version bump) or a different routing set rejects the
   * send with a conflict instead of letting the command fall through to a
   * same-named LOCAL Skill. On success the server persists a server-owned
   * `teamSkillInvocation` metadata marker built from these fields, so the
   * recipient's Client can still recognise the Team intent after a delayed
   * delivery. Request-level only — the precondition itself is never
   * persisted into message metadata.
   */
  skillPrecondition: z
    .object({
      recipientAgentId: z.string().uuid(),
      expectedConfigVersion: z.number().int().positive(),
      resourceId: z.string().uuid(),
      requestedSlug: z.string().min(1),
    })
    .optional(),
});
export type SendMessage = z.infer<typeof sendMessageSchema>;

export const messageSchema = z
  .object({
    id: z.string(),
    chatId: z.string(),
    senderId: z.string(),
    senderKind: messageSenderKindSchema.default("member"),
    senderProvider: messageSenderProviderSchema.nullable().default(null),
    format: z.string(),
    content: z.unknown(),
    metadata: z.record(z.string(), z.unknown()),
    inReplyTo: z.string().nullable(),
    source: messageSourceSchema.nullable(),
    createdAt: z.string(),
  })
  .refine((message) => (message.senderKind === "member") === (message.senderProvider === null), {
    message: "member senders cannot declare a provider and integration senders must declare one",
  });
export type Message = z.infer<typeof messageSchema>;

/** Per-chat participation mode exposed to the recipient runtime. */
export const participantModeSchema = z.enum(["full", "mention_only"]);
export type ParticipantMode = z.infer<typeof participantModeSchema>;

/**
 * Lightweight snapshot of an earlier message in the same chat that the
 * recipient missed (because it was `mention_only` + not @mentioned). Server
 * attaches a list of these to the next active delivery in the chat so the
 * agent's prompt carries enough context to reply meaningfully.
 *
 * Smaller than `messageSchema` on purpose — drops reply envelopes and other
 * fields that don't help the LLM. `source` is retained because trusted SCM
 * attribution requires provenance together with the card shape and reserved
 * metadata marker. It is optional for rolling compatibility with older
 * servers that did not include it in preceding context.
 */
export const precedingMessageSchema = z
  .object({
    id: z.string(),
    senderId: z.string(),
    senderKind: messageSenderKindSchema.default("member"),
    senderProvider: messageSenderProviderSchema.nullable().default(null),
    format: z.string(),
    content: z.unknown(),
    metadata: z.record(z.string(), z.unknown()).default({}),
    source: messageSourceSchema.nullable().catch(null).optional(),
    createdAt: z.string(),
  })
  .refine((message) => (message.senderKind === "member") === (message.senderProvider === null), {
    message: "member senders cannot declare a provider and integration senders must declare one",
  });
export type PrecedingMessage = z.infer<typeof precedingMessageSchema>;

/**
 * Wire format for messages routed FROM the server TO a client runtime.
 *
 * Adds `configVersion` so the client can compare against its locally cached
 * agent runtime config and refresh before delivering the message to the SDK.
 *
 * Step 3: this is the single shape used by `buildClientMessagePayload` —
 * never serialise a raw `messageSchema` row to a client; always go through
 * the dispatcher.
 *
 * `recipientMode` is the receiving agent's own mode in the entry's chat —
 * `mention_only` participants must only start a session when they appear in
 * `metadata.mentions` (see session-runtime.ts).
 *
 * `precedingMessages` is a (possibly empty) list of older messages in the
 * same chat that this recipient did not previously receive (silent inbox
 * context). The runtime renders them as "earlier in chat" before the
 * triggering message — see proposals/group-chat-ux-improvements §1.
 */
export const clientMessageSchema = messageSchema.safeExtend({
  configVersion: z.number().int().positive(),
  // Forward-roll defence: the server may push new source values before the
  // client ships the matching enum update (e.g. a new source is added).
  // Without `.catch`, the strict enum rejects the whole inbox frame; the
  // entry stays `delivered` server-side and every subsequent `agent:bind`
  // resets it back to `pending` and re-pushes the same un-parseable frame
  // (see inflight-message-recovery-design.md §4). That loop only ends when
  // the client process restarts (dedup window clears + this build is still
  // out of date so the row would re-loop), the deploy ships the matching
  // enum update, or a `session:terminate` clears the row — none of which
  // a reader of "chat was restarted" would expect. Degrading unknown values
  // to `null` keeps the frame parseable so the handler still receives the
  // message body; only the audit-trail `source` label is lost. Mirrors the
  // inboxDeliverFrameSchema `.passthrough()` policy for top-level fields.
  //
  // Scope: `.catch` is field-scoped — it fires for ANY shape mismatch on
  // `source` (unknown enum value, wrong type like `12345`, missing /
  // undefined), not just enum drift. Acceptable because `source` is a
  // pure audit label that handlers never branch on. Other fields' parse
  // errors still bubble up to the parent `safeParse`, so required-shape
  // drift on id / chatId / format is NOT silently swallowed.
  source: messageSourceSchema.nullable().catch(null),
  recipientMode: participantModeSchema.default("full"),
  precedingMessages: z.array(precedingMessageSchema).default([]),
});
export type ClientMessage = z.infer<typeof clientMessageSchema>;
