import {
  AGENT_FINAL_TEXT_METADATA_KEY,
  ASK_AGENT_METADATA_KEY,
  attachmentRefsFromMetadata,
  CLI_BODY_ORIGIN_METADATA_KEY,
  CLI_BODY_ORIGINS,
  CONTEXT_DECISION_METADATA_KEY,
  CRON_TRIGGER_METADATA_KEY,
  contextDecisionFromImpactNote,
  contextDecisionSchema,
  extractCaption,
  FIRST_CHAT_ORIENTATION_CHAT_METADATA_KEY,
  FIRST_CHAT_ORIENTATION_CHAT_STATES,
  FIRST_CHAT_ORIENTATION_CONTINUATION_METADATA_KEY,
  FIRST_CHAT_ORIENTATION_METADATA_KEY,
  feishuMessageMetadataSchema,
  imageBatchRefContentSchema,
  imageRefContentSchema,
  MAX_BATCH_ATTACHMENTS,
  MESSAGE_FORMATS,
  MESSAGE_SOURCES,
  parseContextImpactNotes,
  RUNTIME_NOTICE_METADATA_KEY,
  readFirstChatOrientationChatState,
  readFirstChatOrientationMessageMetadata,
  requestResolutionSchema,
  type SendMessage,
  scanMentionTokens,
  TEAM_SKILL_INVOCATION_MARKER_VERSION,
  TEAM_SKILL_INVOCATION_MESSAGE_PURPOSE,
  TEAM_SKILL_INVOCATION_METADATA_KEY,
} from "@first-tree/shared";
import { getServerCliBinding } from "@first-tree/shared/channel";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "../../db/connection.js";
import { agentConfigs } from "../../db/schema/agent-configs.js";
import { agents } from "../../db/schema/agents.js";
import { chatMembership } from "../../db/schema/chat-membership.js";
import { chats } from "../../db/schema/chats.js";
import { inboxEntries } from "../../db/schema/inbox-entries.js";
import { messages } from "../../db/schema/messages.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../errors.js";
import { createLogger, messageAttrs, withSpan } from "../../observability/index.js";
import { uuidv7 } from "../../uuid.js";
import {
  type AttachmentReader,
  deleteAttachmentIfUnreferenced,
  loadAttachmentMetaForReference,
} from "../attachment.js";
import type { AttachmentBlobStore } from "../attachment-blob-store.js";
import { hasRemainingLandingCampaignTrialBudget } from "../landing-campaigns/chat-state.js";
import { getLandingCampaignTrialChat, withLandingCampaignChatState } from "../landing-campaigns/metadata.js";
import { validateDocumentContext, validateMessageAttachmentRefs } from "./message-attachment-validation.js";
import { upsertSessionState } from "./sessions/activity.js";
import { applyAfterFanOut, fireChatMessageKick } from "./workspace/projection.js";

const log = createLogger("message");
const ADDRESSED_AGENT_IDS_METADATA_KEY = "addressedAgentIds";

/**
 * Metadata keys reserved for server-owned write paths. UI-only markers are
 * stripped from caller input; publication-authority markers fail closed so an
 * HTTP POST cannot smuggle them into a regular message. See the matching
 * trusted-internal fields on `SendMessageOptions` for each threat model.
 *
 * Returns the same reference when nothing is stripped, so the common case
 * (no reserved keys present) does not allocate.
 */
function stripUntrustedMetadataKeys(
  meta: Record<string, unknown>,
  options: SendMessageOptions,
): Record<string, unknown> {
  const contextReviewKey = Object.keys(meta).find(
    (key) => key === "contextTreeReviewer" || key.startsWith("contextReview"),
  );
  if (contextReviewKey && !options.allowContextReviewRun) {
    throw new BadRequestError(
      `Metadata key "${contextReviewKey}" is reserved for server-authored Context Reviewer runs.`,
    );
  }
  const githubTaskKey = Object.keys(meta).find(
    (key) => key === "teamAgentTask" || key === "githubTaskRun" || key.startsWith("githubTask"),
  );
  if (githubTaskKey && !options.allowGithubTaskRun) {
    throw new BadRequestError(
      `Metadata key "${githubTaskKey}" is reserved for server-authored GitHub task reply runs.`,
    );
  }
  if (CRON_TRIGGER_METADATA_KEY in meta && !options.allowCronTrigger) {
    throw new BadRequestError(
      `Metadata key "${CRON_TRIGGER_METADATA_KEY}" is reserved for server-authored scheduled job triggers.`,
      { code: "CRON_TRIGGER_METADATA_RESERVED" },
    );
  }
  const shouldStripSystemSender = !options.allowSystemSender && "systemSender" in meta;
  const shouldStripAddressedAgentIds = ADDRESSED_AGENT_IDS_METADATA_KEY in meta;
  const shouldStripAskAgent = ASK_AGENT_METADATA_KEY in meta;
  const shouldStripCliBodyOrigin = CLI_BODY_ORIGIN_METADATA_KEY in meta;
  const shouldStripEditedAt = "editedAt" in meta;
  const shouldStripFirstChatOrientationContinuation = FIRST_CHAT_ORIENTATION_CONTINUATION_METADATA_KEY in meta;
  const shouldStripFirstChatOrientation =
    !options.allowFirstChatOrientation && FIRST_CHAT_ORIENTATION_METADATA_KEY in meta;
  const shouldStripFeishu = !options.allowFeishuMetadata && "feishu" in meta;
  // Always stripped, never allow-listed: the runtime-notice marker is re-stamped
  // below from `options.runtimeNotice`, which only the dedicated runtime-notice
  // route can set. The key grants an exemption from the Feishu-bridged chat
  // write boundary, so accepting it from a request body would let any agent
  // credential mint that exemption for itself.
  const shouldStripRuntimeNotice = RUNTIME_NOTICE_METADATA_KEY in meta;
  if (
    !shouldStripSystemSender &&
    !shouldStripAddressedAgentIds &&
    !shouldStripAskAgent &&
    !shouldStripCliBodyOrigin &&
    !shouldStripEditedAt &&
    !shouldStripFirstChatOrientationContinuation &&
    !shouldStripFirstChatOrientation &&
    !shouldStripFeishu &&
    !shouldStripRuntimeNotice
  ) {
    return meta;
  }
  return Object.fromEntries(
    Object.entries(meta).filter(
      ([key]) =>
        key !== ADDRESSED_AGENT_IDS_METADATA_KEY &&
        key !== ASK_AGENT_METADATA_KEY &&
        key !== CLI_BODY_ORIGIN_METADATA_KEY &&
        key !== "editedAt" &&
        key !== FIRST_CHAT_ORIENTATION_CONTINUATION_METADATA_KEY &&
        key !== RUNTIME_NOTICE_METADATA_KEY &&
        (options.allowFeishuMetadata || key !== "feishu") &&
        (options.allowFirstChatOrientation || key !== FIRST_CHAT_ORIENTATION_METADATA_KEY) &&
        (options.allowSystemSender || key !== "systemSender"),
    ),
  );
}

/**
 * Trust boundary for `metadata.contextDecision` — the record that Context Tree
 * content shaped the choice carried by this message.
 *
 * Current agents author only the visible impact note in the body; the Server
 * derives the structured receipt from that note. Deriving rather than accepting
 * a parallel payload is the whole point: a hand-maintained second copy can
 * disagree with the sentence the reader sees, and nothing at runtime would
 * notice. One source, one claim.
 *
 * Three rules, all fail-closed:
 *   1. A HUMAN sender never carries one, derived or supplied. The key is
 *      stripped rather than rejected (a human's message body is fine, note and
 *      all; only the agent-attribution claim is not theirs to make), so a
 *      browser/API write cannot dress a human message as agent-reported
 *      Context Tree influence.
 *   2. An AGENT sender's note, when it converts, IS the receipt — it overrides
 *      any caller-supplied payload, so the stored record can never contradict
 *      the visible text.
 *   3. A caller-supplied receipt still parses or the write fails. Legacy agents
 *      predate the note and send only metadata; rejecting a malformed one
 *      surfaces the mistake so the agent fixes and resends, where storing it
 *      would leave an unrenderable receipt no consumer can show.
 *
 * A note that does not convert (unknown effect label, a source that is not an
 * exact-commit link, an over-long summary) yields no receipt. That is the same
 * outcome as writing no note at all, so it is logged — otherwise a formatting
 * regression would quietly stop counting influence with nothing to show for it.
 */
function applyContextDecisionTrustBoundary(
  meta: Record<string, unknown>,
  senderType: string,
  body: unknown,
): Record<string, unknown> {
  if (senderType === "human") {
    if (!(CONTEXT_DECISION_METADATA_KEY in meta)) return meta;
    return Object.fromEntries(Object.entries(meta).filter(([key]) => key !== CONTEXT_DECISION_METADATA_KEY));
  }

  const notes = typeof body === "string" && body.length > 0 ? parseContextImpactNotes(body) : [];
  if (notes.length > 0) {
    // Exactly one note or nothing: a body carrying two notes attributes two
    // different things, and no reader — human or machine — can tell which one
    // governed the message. Picking either would be a guess.
    const note = notes.length === 1 ? notes[0] : undefined;
    const derived = note ? contextDecisionFromImpactNote(note) : null;
    if (derived) return { ...meta, [CONTEXT_DECISION_METADATA_KEY]: derived };
    log.info(
      { event: "context_decision_note_unreadable", noteCount: notes.length },
      "Context Tree impact note present but not convertible to a receipt",
    );
    // Do NOT fall through to a caller-supplied receipt here. The body already
    // shows the reader note-shaped content; accepting a parallel payload
    // alongside it would let the stored claim contradict the visible one —
    // exactly the divergence deriving from the note exists to remove. The
    // legacy payload path is only for bodies carrying no note at all.
    return Object.fromEntries(Object.entries(meta).filter(([key]) => key !== CONTEXT_DECISION_METADATA_KEY));
  }

  if (!(CONTEXT_DECISION_METADATA_KEY in meta)) return meta;
  const parsed = contextDecisionSchema.safeParse(meta[CONTEXT_DECISION_METADATA_KEY]);
  if (!parsed.success) {
    throw new BadRequestError(
      'Malformed "metadata.contextDecision": expected {version: 1, effect: ' +
        '"conflicted"|"redirected"|"constrained"|"confirmed", summary: <one sentence>, ' +
        "evidence: [{repoUrl, commit, nodePath, heading?}] with 1-3 rows}.",
    );
  }
  // Persist the PARSED receipt, not the caller's object. Validation is not the
  // same as normalization: the schema strips unknown keys and trims `summary`,
  // so storing the raw value would durably keep an extra (possibly
  // credential-bearing) field and a summary longer than the declared bound —
  // invisibly, because every reader re-parses and drops them. The row must hold
  // exactly the shape the contract promises.
  return { ...meta, [CONTEXT_DECISION_METADATA_KEY]: parsed.data };
}

/**
 * Fail-closed guard for `format: "file"` writes. `sendMessageSchema.content`
 * is `z.unknown()` (format-agnostic), so without this the message write
 * boundary would persist and fan out malformed, unsupported-MIME, or
 * over-limit image batches — recipients would then either not recognise the
 * batch or fan out unbounded attachment fetches. The only legal `file`
 * content is a single image ref or a 1..MAX_BATCH_ATTACHMENTS batch, both
 * restricted to supported MIME types. Reuses the shared schemas so this guard
 * can't drift from the renderers' contract.
 */
function validateFileContent(content: unknown): void {
  if (imageBatchRefContentSchema.safeParse(content).success) return;
  if (imageRefContentSchema.safeParse(content).success) return;
  throw new BadRequestError(
    `Invalid file message content: expected an image reference ({imageId, mimeType, filename}) or a batch ` +
      `({caption?, attachments[1..${MAX_BATCH_ATTACHMENTS}]}), with MIME one of png/jpeg/gif/webp.`,
  );
}

/**
 * Hold cleanup-conflicting locks for legacy file refs that currently resolve
 * to ready attachment rows. Missing rows and stored metadata mismatches remain
 * valid: the decision-locked legacy contract is shape-only.
 */
export async function lockFileAttachmentRefsIfPresent(
  db: AttachmentReader,
  format: string,
  content: unknown,
): Promise<void> {
  if (format !== "file") return;

  const batch = imageBatchRefContentSchema.safeParse(content);
  const single = batch.success ? null : imageRefContentSchema.safeParse(content);
  const refs = batch.success ? batch.data.attachments : single?.success ? [single.data] : [];
  await Promise.all(refs.map((ref) => loadAttachmentMetaForReference(db, ref.imageId)));
}

function legacyFileAttachmentIds(format: string, content: unknown): string[] {
  if (format !== "file" || !content || typeof content !== "object") return [];
  const record = content as Record<string, unknown>;
  const ids: string[] = [];
  if (typeof record.imageId === "string") ids.push(record.imageId);
  if (Array.isArray(record.attachments)) {
    for (const item of record.attachments) {
      if (!item || typeof item !== "object") continue;
      const imageId = (item as Record<string, unknown>).imageId;
      if (typeof imageId === "string") ids.push(imageId);
    }
  }
  return ids;
}

/**
 * Placeholder sentinels that are never a legitimate whole message body. They
 * are the residue of a half-built send — e.g. `chat send "$(cat plan.md
 * 2>/dev/null || echo PLACEHOLDER)"` run before `plan.md` was written, which
 * fires a real, irreversible message (and for `request`, a blocking human ask)
 * carrying only the scaffold token. Matched case-insensitively against the
 * ENTIRE trimmed body, so a message that merely mentions the word is untouched.
 */
const PLACEHOLDER_BODY_SENTINELS = new Set(["placeholder", "todo", "fixme", "tbd", "xxx"]);

/**
 * Guard a string message body before it is persisted and fanned out. A text
 * body (text / markdown / request — the human-readable formats carry their
 * content as a string) must be real content: not empty, not whitespace-only,
 * and not a lone placeholder sentinel. This fails closed at the write boundary
 * so a half-built send (an empty command substitution, a `|| echo PLACEHOLDER`
 * fallback) surfaces as an error the caller must fix instead of a meaningless
 * message — for a `request`, a blocking ask card the target human must skip.
 */
function validateTextBody(content: string, isRequest: boolean, allowEmptyWithAttachments = false): void {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    if (!isRequest && allowEmptyWithAttachments) return;
    throw new BadRequestError(
      isRequest
        ? "An ask ('request') needs a non-empty body — the question/background IS the message content."
        : "Message content cannot be empty or whitespace-only.",
    );
  }
  if (PLACEHOLDER_BODY_SENTINELS.has(trimmed.toLowerCase())) {
    throw new BadRequestError(
      `Message content is just a placeholder ("${trimmed}") — this is almost always a half-built send ` +
        "(e.g. a file read that ran before the file was written). Compose the real body, then send.",
    );
  }
}

/**
 * Detect an agent-authored body whose intended markdown line structure arrived
 * as literal `\n` tokens. CLI inline sends already reject this shape, but
 * agent outbox/API callers can bypass the CLI and write directly through the
 * server boundary; fail here before the row becomes durable.
 */
function looksLikeEscapedNewlineBody(content: string): boolean {
  if (content.includes("\n")) return false;
  const escapes = content.match(/\\n/g);
  return (escapes?.length ?? 0) >= 2;
}

function validateAgentTextEncoding(content: string): void {
  if (!looksLikeEscapedNewlineBody(content)) return;
  throw new BadRequestError(
    'Message content contains literal "\\n" escapes and no real newlines — this looks like a multi-line ' +
      "markdown body that was shell-escaped or JSON-escaped before sending. Send the body with real newlines " +
      "via stdin, a message file, or an unescaped API string before retrying.",
  );
}

function normalizeNonHumanTextContent(input: {
  chatId: string;
  senderId: string;
  senderType: string;
  content: unknown;
  allowEscapedNewlineBody?: boolean;
}): unknown {
  if (input.senderType === "human" || typeof input.content !== "string") return input.content;

  let textContent = input.content;
  const unwrapped = maybeUnwrapDoubleEncoded(textContent);
  if (unwrapped !== null) {
    log.warn(
      { metric: "double_encoded_content_unwrapped_total", chatId: input.chatId, senderId: input.senderId },
      "agent sent JSON-encoded string content — unwrapping to restore markdown rendering",
    );
    textContent = unwrapped;
  }
  if (!input.allowEscapedNewlineBody) validateAgentTextEncoding(textContent);
  return textContent;
}

function allowsCliEscapedNewlineBody(data: SendMessage, metadata: Record<string, unknown>): boolean {
  if (data.source !== MESSAGE_SOURCES.CLI) return false;
  const bodyOrigin = metadata[CLI_BODY_ORIGIN_METADATA_KEY];
  return bodyOrigin === CLI_BODY_ORIGINS.STDIN || bodyOrigin === CLI_BODY_ORIGINS.MESSAGE_FILE;
}

// Structural param (not `SendMessage`) so the edit path can reuse it against
// the effective post-edit `{ format, content }`, where `format` is a plain
// string off the stored row.
function validateMessageContent(
  data: { format: string; content: unknown },
  opts?: { hasAttachmentRefs?: boolean },
): void {
  if (data.format === "file") {
    validateFileContent(data.content);
    return;
  }
  if (data.format === "request") {
    if (typeof data.content !== "string") {
      throw new BadRequestError("Invalid request message content: expected a non-empty text question.");
    }
    validateTextBody(data.content, true);
    return;
  }
  // Non-string content (card / reference object shapes) is out of scope here;
  // only string-bearing bodies are guarded against empty / placeholder sends.
  if (typeof data.content === "string") {
    validateTextBody(data.content, false, opts?.hasAttachmentRefs === true);
  }
}

function assertLandingCampaignTrialMessageAllowed(input: {
  chat: { metadata: Record<string, unknown> | null } | null | undefined;
  senderId: string;
  senderType: string;
  data: SendMessage;
  metadataToStore: Record<string, unknown>;
  options: SendMessageOptions;
}): void {
  const trial = getLandingCampaignTrialChat(input.chat);
  if (!trial) return;

  if (trial.state === "completed" || trial.state === "failed") {
    throw new ForbiddenError("Landing campaign trial chat is already complete.");
  }

  if (input.senderId === trial.agentId && input.senderType !== "human") {
    if (trial.state !== "running") {
      throw new ForbiddenError("Landing campaign trial agent can only send while the trial is running.");
    }
    return;
  }

  if (input.senderType === "human") {
    const isSystemBootstrap =
      input.options.allowSystemSender === true &&
      input.metadataToStore.systemSender === "first_tree_onboarding" &&
      trial.state === "running";
    if (isSystemBootstrap) return;

    if (!hasRemainingLandingCampaignTrialBudget(trial)) {
      throw new ForbiddenError("Landing campaign trial chat is locked.");
    }

    const resolvesRequest = requestResolutionSchema.safeParse(input.metadataToStore.resolves).success;
    if (trial.state === "awaiting_user" && trial.awaitingUserKind !== "follow_up" && !resolvesRequest) {
      throw new ForbiddenError("Landing campaign trial chat is waiting for a request answer.");
    }
    return;
  }

  throw new ForbiddenError("Landing campaign trial chat is locked.");
}

export type SendMessageResult = {
  message: typeof messages.$inferSelect;
  /** Inbox IDs that received this message (for notification). */
  recipients: string[];
  /**
   * Present only when an internal caller explicitly defers effects until its
   * own outer transaction commits. Pass this to
   * `runDeferredSendMessagePostCommitEffects` exactly once after commit.
   */
  deferredPostCommitEffects?: DeferredSendMessagePostCommitEffects;
};

export type DeferredSendMessagePostCommitEffects = {
  chatId: string;
  messageId: string;
  organizationId: string;
  recipientAgentIds: string[];
};

export type SendMessageOptions = {
  /** Trusted caller-provided UUIDv7, used when external delivery metadata must derive its idempotency key before insert. */
  messageId?: string;
  /** Trusted Feishu ingress identity. Never exposed through an HTTP request body. */
  integrationSender?: {
    kind: "integration";
    provider: "feishu";
    organizationId: string;
  };
  /** Allow the trusted integration/CLI bridge to persist server-authored `metadata.feishu`. */
  allowFeishuMetadata?: boolean;
  /**
   * Trusted runtime-notice write, set only by
   * `POST /agent/chats/:chatId/runtime-notices`. The service stamps
   * `metadata.runtimeNotice` itself; ordinary sends cannot mint the marker
   * because `stripUntrustedMetadataKeys` always removes an inbound copy.
   *
   * The marker is what exempts a message from the Feishu-bridged chat write
   * boundary, so it is a capability, not a label — which is exactly why it is
   * a trusted option rather than a request field.
   */
  runtimeNotice?: boolean;
  /**
   * Trusted internal delivery mode that persists an explicitly addressed
   * message as replayable context without waking any recipient. The ordinary
   * onboarding kickoff uses it until the user's next visible turn.
   */
  forceSilentFanOut?: boolean;
  /**
   * Trusted onboarding-kickoff capability for the presentation-only first-chat
   * Orientation marker. Ordinary message writes always strip the key so a
   * caller cannot manufacture onboarding chrome in an unrelated chat.
   */
  allowFirstChatOrientation?: boolean;
  /**
   * Trusted request-scoped Ask agent send. The route supplies only the
   * original request id; this service re-validates the still-open request,
   * target human, and original active asker inside the message transaction,
   * then stamps the server-owned metadata marker. Ordinary HTTP sends cannot
   * mint the marker because `stripUntrustedMetadataKeys` always removes it.
   */
  askAgentRequestId?: string;
  /**
   * Trusted-internal opt-out from the default explicit-recipient guard.
   *
   * `sendMessage()` enforces explicit-recipient routing **by default**: a send
   * that declares no recipient (no `metadata.mentions`, no `data.receiverNames`,
   * no `addressedToAgentIds`) is rejected with `BadRequestError`. This is the
   * durable contract — the server rejects a no-recipient send regardless of
   * caller (see `system/cloud/chat/messaging.md` "Addressing Is Required To
   * Send"). The two user entry points (web `api/chats.ts`, agent SDK
   * `api/agent/messages.ts`) therefore carry no business flag; they inherit the
   * default.
   *
   * The one other send shape that legitimately carries no recipient bypasses
   * the guard without this option: `data.purpose === "agent-final-text"` — an
   * agent's own final response surfaced for human observers, silent by
   * construction (self-declared via `purposeProfile.skipMentionEnforcement`).
   *
   * This option is the **only** other escape hatch, reserved for trusted
   * server-internal delivery paths whose addressing is owned and validated by
   * the caller and **can legitimately resolve to no live speaker for some
   * events** — currently the trusted GitHub/GitLab SCM card dispatchers. Their
   * provider-owned audience may resolve to a card with no live speaker wake
   * target in the bound chat. Such a send writes a
   * silent history/context row for human observers rather than reaching an
   * inbox. Set it only on a path you have audited; never thread it through an
   * HTTP boundary.
   */
  allowRecipientlessSend?: boolean;
  /**
   * Trusted-internal opt-in that drops suspended or deleted participants from
   * `metadata.mentions` instead of rejecting the entire send. SCM mappings can
   * outlive a wake agent's active lifecycle; their cards must still reach the
   * bound chat and any other active wake agents without a stale sibling line
   * poisoning the shared delivery. The normalized metadata persists only the
   * surviving active mentions.
   *
   * Keep this off for ordinary human/agent sends: an explicitly addressed
   * inactive recipient is normally a caller error that should fail closed.
   */
  dropInactiveMentionTargets?: boolean;
  /**
   * When true and `data.content` is a string, prepend `@<name>` tokens for
   * any participant in `metadata.mentions` whose name is missing from the
   * content. Used by the agent endpoint so the rendered message stays in
   * sync with the routing decision (e.g.
   * `result-sink` enrichment puts the trigger sender in
   * `metadata.mentions` but the agent's text rarely includes the @).
   * Web endpoint leaves this off — the composer has the user write the @
   * themselves; we don't want server to silently mutate human-typed
   * content.
   */
  normalizeMentionsInContent?: boolean;
  /**
   * Trusted validation seam for a Team Skill slash `skillPrecondition`.
   * The precondition itself is untrusted request data; only a caller that
   * injects this seam (the web message route, backed by the resources
   * service) can have the server persist the server-owned
   * `metadata.teamSkillInvocation` marker. The seam resolves the
   * recipient's CURRENT effective resources inside the message transaction
   * (after the config row lock) and returns the CANONICAL invocation
   * identity — validated resourceId + the slug derived from the effective
   * row's own payload — or null when the asserted resource/slug is not an
   * enabled, unambiguous Team Skill. A send carrying a precondition without
   * this seam is rejected: untrusted fields must never mint a marker.
   */
  validateTeamSkillInvocation?: (precondition: {
    recipientAgentId: string;
    resourceId: string;
    requestedSlug: string;
  }) => Promise<{ resourceId: string; requestedSlug: string } | null>;
  /**
   * Agent IDs that this message is **addressed to** by construction — used
   * for trusted system-routed messages whose recipient is fixed at write time.
   * Within the non-silenced fan-out branch, addressed agents always receive
   * `notify=true` regardless of `metadata.mentions`.
   *
   * `purpose === "agent-final-text"` still takes precedence (it forces
   * `notify=false` for everyone); this only widens the notify set within
   * the non-silenced branch.
   */
  addressedToAgentIds?: readonly string[];
  /**
   * Trusted-internal opt-in for writing `metadata.systemSender`. The web UI
   * uses that key to re-attribute a row to a synthetic SCM provider sender
   * (avatar + name override) instead of the row's actual `senderId`. To
   * prevent a non-dispatcher caller (HTTP POST from web / agent SDK) from
   * smuggling the same marker into an ordinary message — which would let
   * an arbitrary agent post a phishing message that renders as if from a
   * provider — the service unconditionally strips the key from
   * `data.metadata` when this option is not set. Only the trusted GitHub/GitLab
   * card dispatchers are expected to set this to `true`. Defense-in-depth
   * alongside each provider card's conjunctive UI trust gate.
   */
  allowSystemSender?: boolean;
  /**
   * Trusted-internal capability for creating a Context Reviewer run message.
   * The `contextTreeReviewer` and `contextReview*` metadata namespace carries
   * publication authority and is rejected at every ordinary message boundary.
   * Only the GitHub App Context Reviewer webhook dispatcher may set this option.
   */
  allowContextReviewRun?: boolean;
  /**
   * Trusted-internal capability for creating an automatically routed GitHub
   * task run. The `teamAgentTask` marker and `githubTask*` metadata namespace
   * carry recipient-bound App comment publication authority and are rejected
   * at every ordinary message boundary.
   */
  allowGithubTaskRun?: boolean;
  /**
   * Trusted-internal capability for materializing a scheduled job trigger
   * message. The `cronTrigger` metadata namespace is rejected at every
   * ordinary message boundary.
   */
  allowCronTrigger?: boolean;
  /**
   * Trusted-internal escape hatch for a send performed inside an existing
   * outer database transaction. When enabled, session activation and the
   * workspace kick are returned as a descriptor instead of running before
   * that outer transaction commits. The caller MUST flush the descriptor
   * with `runDeferredSendMessagePostCommitEffects` after commit.
   */
  deferPostCommitEffects?: boolean;
  /** Test-only barrier for deterministic mixed-version lock-order coverage. */
  beforeFirstChatOrientationLockForTest?: () => Promise<void>;
};

export type SendIntentParticipant = {
  agentId: string;
  name: string | null;
  displayName: string;
  status: string;
  type: string;
};

export type SendMessagePreflightResult = {
  content: SendMessage["content"];
  metadata: Record<string, unknown>;
  mentionedAgentIds: string[];
  isAgentFinalText: boolean;
  forceSilentFanOut: boolean;
};

export function preflightMessageSendIntent(input: {
  chatId: string;
  senderId: string;
  senderType: string;
  data: SendMessage;
  options?: SendMessageOptions;
  participants: ReadonlyArray<SendIntentParticipant>;
}): SendMessagePreflightResult {
  const options = input.options ?? {};
  const { chatId, senderId, senderType, data, participants } = input;

  const rawIncomingMeta = (data.metadata ?? {}) as Record<string, unknown>;
  const hasAttachmentRefs = attachmentRefsFromMetadata(rawIncomingMeta).length > 0;

  validateMessageContent(data, { hasAttachmentRefs });

  const allowEscapedNewlineBody = allowsCliEscapedNewlineBody(data, rawIncomingMeta);

  let effectiveContent: SendMessage["content"] = data.content;
  effectiveContent = normalizeNonHumanTextContent({
    chatId,
    senderId,
    senderType,
    content: effectiveContent,
    allowEscapedNewlineBody,
  }) as SendMessage["content"];

  // Re-validate the UNWRAPPED body. `validateMessageContent(data)` above checked
  // the raw `data.content`, but for a non-human sender a double-encoded string
  // (e.g. `JSON.stringify("TODO\n")`) only reveals its empty / whitespace /
  // placeholder body after `maybeUnwrapDoubleEncoded`. `effectiveContent` is
  // what gets normalized and persisted, so guard it here too — before mention
  // normalization can salvage an empty body into a bare "@name".
  validateMessageContent({ format: data.format, content: effectiveContent }, { hasAttachmentRefs });

  // `effectiveContent`, not `data.content`: the receipt is derived from the
  // body that actually gets persisted, so a double-encoded send cannot store a
  // note the reader sees while the Server parsed a JSON string around it.
  let incomingMeta = applyContextDecisionTrustBoundary(
    stripUntrustedMetadataKeys(rawIncomingMeta, options),
    senderType,
    effectiveContent,
  );
  if (options.allowFeishuMetadata && "feishu" in incomingMeta) {
    const parsedFeishu = feishuMessageMetadataSchema.safeParse(incomingMeta.feishu);
    if (!parsedFeishu.success) throw new BadRequestError("Malformed trusted Feishu message metadata");
    if (Boolean(options.integrationSender) !== (parsedFeishu.data.direction === "inbound")) {
      throw new BadRequestError(
        "Feishu integration senders are inbound-only; outbound intents require a member sender",
      );
    }
    incomingMeta = { ...incomingMeta, feishu: parsedFeishu.data };
  }
  validateDocumentContext(incomingMeta);
  const parsedResolution = requestResolutionSchema.safeParse(incomingMeta.resolves);
  if (incomingMeta.resolves !== undefined && !parsedResolution.success) {
    throw new BadRequestError(
      'Malformed "metadata.resolves": expected {request: <messageId>, kind: "answered"|"closed", reason?}.',
    );
  }
  // Skip is a lifecycle close, not an ordinary message. The web still declares
  // the original asker so an active agent is notified and can continue. If that
  // asker is no longer a live participant, preflight may drop only that stale
  // route and let the durable close reach the transaction-level request/chat/
  // target-human authorization below. Answers and every other send keep the
  // normal fail-closed recipient contract.
  const isHumanClosedResolution =
    senderType === "human" && parsedResolution.success && parsedResolution.data.kind === "closed";

  const explicitMentionsRaw = incomingMeta.mentions;
  const explicitMentionsRawList = Array.isArray(explicitMentionsRaw)
    ? explicitMentionsRaw.filter((m): m is string => typeof m === "string")
    : [];
  const participantsById = new Map(participants.map((p) => [p.agentId, p]));
  let droppedClosedResolutionMention = false;
  const dropInactiveMentionTargets = options.dropInactiveMentionTargets || isHumanClosedResolution;
  const explicitMentions = explicitMentionsRawList.filter((id) => {
    if (id === senderId) return true;
    const participant = participantsById.get(id);
    if (!participant) {
      if (isHumanClosedResolution) droppedClosedResolutionMention = true;
      return false;
    }
    if (dropInactiveMentionTargets && participant.status !== "active") {
      if (isHumanClosedResolution) droppedClosedResolutionMention = true;
      return false;
    }
    return true;
  });

  const receiverNames = data.receiverNames ?? [];
  const speakersByName = new Map<string, string>();
  for (const p of participants) {
    if (p.name) speakersByName.set(p.name.toLowerCase(), p.agentId);
  }
  const resolvedFromNames: string[] = [];
  const unresolvedNames: string[] = [];
  for (const name of receiverNames) {
    const id = speakersByName.get(name.toLowerCase());
    if (id) resolvedFromNames.push(id);
    else unresolvedNames.push(name);
  }
  if (unresolvedNames.length > 0) {
    const sample = unresolvedNames[0];
    throw new BadRequestError(
      `Cannot route to "${sample}" — they are not a participant of this chat. ` +
        "Add them first:\n" +
        `  ${getServerCliBinding().binName} chat invite ${sample}\n` +
        "Then retry your send. Or ask a human in this chat to add them.",
    );
  }

  const mergedMentions = [...new Set([...explicitMentions, ...resolvedFromNames])];
  const mentionTargets = mergedMentions.filter((id) => id !== senderId);
  for (const id of mentionTargets) {
    const participant = participantsById.get(id);
    if (!participant) {
      throw new BadRequestError(`Cannot route to "${id}" — they are not a participant of this chat.`);
    }
    if (participant.status !== "active") {
      const label = participant.displayName || participant.name || id;
      const recovery =
        participant.status === "suspended"
          ? "Reactivate it before sending."
          : "Deleted agents cannot receive new messages.";
      throw new BadRequestError(`Cannot route to "${label}" because the agent is ${participant.status}. ${recovery}`);
    }
  }
  const routedRecipientIds = new Set([
    ...mentionTargets,
    ...(options.addressedToAgentIds ?? []).filter((id) => id !== senderId),
  ]);
  for (const id of routedRecipientIds) {
    const participant = participantsById.get(id);
    if (!participant || participant.status === "active") continue;
    const label = participant.displayName || participant.name || id;
    const recovery =
      participant.status === "suspended"
        ? "Reactivate it before sending."
        : "Deleted agents cannot receive new messages.";
    throw new BadRequestError(`Cannot route to "${label}" because the agent is ${participant.status}. ${recovery}`);
  }

  const isAgentFinalText = data.purpose === "agent-final-text";
  const purposeProfile = isAgentFinalText
    ? {
        skipMentionEnforcement: true,
        forceSilentFanOut: true,
      }
    : {
        skipMentionEnforcement: false,
        forceSilentFanOut: options.forceSilentFanOut === true,
      };
  // Persist the notify-worthy live non-human agents — the recipients whose
  // sessions the send is expected to wake. `mentions` only carries explicit @s /
  // receiverNames, NOT system `addressedToAgentIds` routing (e.g. onboarding
  // kickoff bootstrap), so a surface that needs to know who a turn awaits a
  // reply from can't rely on `mentions` alone. This projection is server-owned
  // and mirrors fan-out notify semantics: final-text recipients are silent
  // context, not awaited agents.
  const addressedAgentIds = !purposeProfile.forceSilentFanOut
    ? [...routedRecipientIds].filter((id) => {
        const participant = participantsById.get(id);
        return participant !== undefined && participant.status === "active" && participant.type !== "human";
      })
    : [];
  const metadataToStore: Record<string, unknown> = {
    ...incomingMeta,
    ...(dropInactiveMentionTargets
      ? { mentions: mergedMentions }
      : mergedMentions.length > 0
        ? { mentions: mergedMentions }
        : {}),
    ...(addressedAgentIds.length > 0 ? { [ADDRESSED_AGENT_IDS_METADATA_KEY]: addressedAgentIds } : {}),
  };
  // The Team Skill invocation marker is SERVER-OWNED: an inbound value is
  // never honored. The message transaction re-stamps it only after the
  // request-level skillPrecondition validates (recipient set + config
  // version), so a forged marker cannot survive the write path.
  delete metadataToStore[TEAM_SKILL_INVOCATION_METADATA_KEY];

  if (data.format === MESSAGE_FORMATS.REQUEST) {
    const targetId = mergedMentions[0];
    if (mergedMentions.length !== 1 || !targetId) {
      throw new BadRequestError(
        `A 'request' message must mention exactly one recipient (got ${mergedMentions.length}). ` +
          "An open question is directed at a single human.",
      );
    }
    const target = participantsById.get(targetId);
    if (!target || target.type !== "human") {
      throw new BadRequestError("A 'request' message must be directed at a human member.");
    }
  }

  // An agent may `chat send` any participant — agent or human. A plain
  // agent→human send is a free reply / conversational answer; a tracked
  // decision goes through `chat ask` (format=request) and progress through
  // `chat update --description`, but neither is the only path to a human.
  // (Resolution stays human-only — enforced by the resolution authorization
  // below, independent of who may send.)

  const skipRecipientEnforcement =
    purposeProfile.skipMentionEnforcement ||
    options.allowRecipientlessSend === true ||
    (isHumanClosedResolution && droppedClosedResolutionMention);
  if (!skipRecipientEnforcement) {
    const hasActiveAddressed = (options.addressedToAgentIds ?? []).some(
      (id) => id !== senderId && participantsById.get(id)?.status === "active",
    );
    if (mentionTargets.length === 0 && !hasActiveAddressed) {
      throw new BadRequestError(
        "Sending a message requires an explicit recipient. " +
          "Pass `metadata.mentions: [agentId]` (or `receiverNames: [name]`) to declare routing, " +
          'or set `purpose: "agent-final-text"` for silent history-only sends.',
      );
    }
  }

  let outboundContent = effectiveContent;
  if (options.normalizeMentionsInContent && typeof outboundContent === "string") {
    const present = new Set(scanMentionTokens(outboundContent));
    const missingNames: string[] = [];
    for (const id of mergedMentions) {
      if (id === senderId) continue;
      const p = participants.find((q) => q.agentId === id);
      if (!p?.name) continue;
      if (present.has(p.name.toLowerCase())) continue;
      missingNames.push(p.name);
    }
    if (missingNames.length > 0) {
      const prefix = missingNames.map((n) => `@${n}`).join(" ");
      outboundContent = outboundContent.length > 0 ? `${prefix} ${outboundContent}` : prefix;
    }
  }

  // Persist the final-text intent as a durable metadata flag. `purpose` is a
  // send-time-only tag that the server consumes above but never stores, so
  // without this stamp the web cannot tell a silent `agent-final-text` mirror
  // apart from a deliberate agent `chat send`. Handler-emitted runtime notices
  // reuse the same purpose only for delivery semantics; they are operator
  // status rows and must not be hidden by the staging final-text toggle.
  //
  // The flag is SERVER-OWNED:
  //   1. strip any inbound client-supplied value, then
  //   2. set it true ONLY for a genuine mirror — a NON-HUMAN sender with the
  //      final-text purpose, excluding a runtime notice.
  // `purpose` rides the shared send schema, so a human/web send can carry it
  // (and gets the silent enforcement profile above) — but it must never be
  // persisted as a mirror, matching the unread-projection's
  // `senderRow.type !== "human"` gate. The staging-only "hide agent final
  // text" toggle filters on this flag.
  // Server-owned too — `stripUntrustedMetadataKeys` has already removed any
  // inbound copy, so the only way this is true is the dedicated runtime-notice
  // route asking for it.
  const isRuntimeNotice = options.runtimeNotice === true;
  const isAgentFinalTextMirror = isAgentFinalText && senderType !== "human" && !isRuntimeNotice;
  const metadataSansFlag =
    AGENT_FINAL_TEXT_METADATA_KEY in metadataToStore
      ? Object.fromEntries(Object.entries(metadataToStore).filter(([key]) => key !== AGENT_FINAL_TEXT_METADATA_KEY))
      : metadataToStore;
  const metadataWithFinalTextFlag = isAgentFinalTextMirror
    ? { ...metadataSansFlag, [AGENT_FINAL_TEXT_METADATA_KEY]: true }
    : metadataSansFlag;
  const storedMetadata = isRuntimeNotice
    ? { ...metadataWithFinalTextFlag, [RUNTIME_NOTICE_METADATA_KEY]: true }
    : metadataWithFinalTextFlag;

  return {
    content: outboundContent,
    metadata: storedMetadata,
    mentionedAgentIds: mergedMentions,
    isAgentFinalText,
    forceSilentFanOut: purposeProfile.forceSilentFanOut,
  };
}

export async function sendMessage(
  db: Database,
  chatId: string,
  senderId: string,
  data: SendMessage,
  options: SendMessageOptions = {},
): Promise<SendMessageResult> {
  validateMessageContent(data, { hasAttachmentRefs: attachmentRefsFromMetadata(data.metadata).length > 0 });
  return withSpan("inbox.enqueue", messageAttrs({ chatId, senderAgentId: senderId, source: data.source }), () =>
    sendMessageInner(db, chatId, senderId, data, options),
  );
}

/**
 * Routing contract (post-retire of content extraction)
 * ====================================================
 *
 * Every wake-up requires the caller to declare routing intent explicitly.
 * Explicit-recipient enforcement is ON BY DEFAULT in `sendMessage()`; a send
 * that declares no recipient is rejected unless it is one of the silent shapes
 * below. Routing is declared by one of:
 *
 *   - `data.metadata.mentions: string[]` — agent uuids (resolved upstream)
 *   - `data.receiverNames: string[]` — agent names; resolved here against
 *     the chat's speaker list
 *   - `options.addressedToAgentIds` — system-routed override (e.g. github
 *     delivery), counted only when it resolves to an active speaker
 *
 * Recipient-less sends are rejected by default, except these declared-silent
 * shapes:
 *   - `data.purpose === "agent-final-text"` — silent history-only write
 *   - `options.allowRecipientlessSend === true` — trusted system opt-out
 *   - a target human's `kind="closed"` request resolution after preflight
 *     drops its declared asker because that agent is inactive or missing;
 *     transaction-level request/chat/target authorization still applies
 *
 * The server never parses `@<name>` tokens out of content. Clients that
 * surface IM-style `@-mention` UX (web composer, future mobile) must
 * resolve mentions client-side and pass uuids on the wire. The 1:1
 * "implicit wake" rule that previously bypassed the routing check was
 * removed when the explicit contract took its place — web clients now
 * auto-inject the peer's uuid into `metadata.mentions` in 2-speaker chats.
 */

async function sendMessageInner(
  db: Database,
  chatId: string,
  senderId: string,
  data: SendMessage,
  options: SendMessageOptions,
): Promise<SendMessageResult> {
  const txResult = await db.transaction(async (tx) => {
    // 1. Load participants and sender (inbox + org) in parallel — both are
    //    needed for fan-out + mention enforcement + post-tx session
    //    activation. Running concurrently keeps the hot send path on a
    //    single round-trip rather than two sequential lookups. Sender's
    //    organizationId is reused for predictive session activation
    //    (chat-internal participants share the same org under multi-tenant).
    //
    //    v2: `chat_membership.mode` is **not** SELECTed — fan-out no longer
    //    reads it. Likewise `chats.type` is locked to 'group' since
    //    first-tree-context PR #465 and no longer drives any decision here.
    const [participants, [storedSenderRow], [chatRowSnapshot]] = await Promise.all([
      tx
        .select({
          agentId: chatMembership.agentId,
          inboxId: agents.inboxId,
          name: agents.name,
          displayName: agents.displayName,
          status: agents.status,
          type: agents.type,
        })
        .from(chatMembership)
        .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
        .where(and(eq(chatMembership.chatId, chatId), eq(chatMembership.accessMode, "speaker"))),
      tx
        .select({ inboxId: agents.inboxId, organizationId: agents.organizationId, type: agents.type })
        .from(agents)
        .where(eq(agents.uuid, senderId))
        .limit(1),
      tx
        .select({ metadata: chats.metadata, organizationId: chats.organizationId })
        .from(chats)
        .where(eq(chats.id, chatId))
        .limit(1),
    ]);
    const senderRow =
      storedSenderRow ??
      (options.integrationSender
        ? {
            inboxId: "",
            organizationId: options.integrationSender.organizationId,
            type: "integration",
          }
        : undefined);
    if (!senderRow) {
      throw new NotFoundError(`Sender agent "${senderId}" not found`);
    }
    if (!chatRowSnapshot) throw new NotFoundError(`Chat "${chatId}" not found`);
    if (chatRowSnapshot.organizationId !== senderRow.organizationId) {
      throw new ForbiddenError("Message sender and chat belong to different organizations");
    }
    const prepared = preflightMessageSendIntent({
      chatId,
      senderId,
      senderType: senderRow.type,
      data,
      options,
      participants,
    });
    const { content: outboundContent, metadata: preparedMetadata, mentionedAgentIds: mergedMentions } = prepared;
    let metadataToStore = preparedMetadata;
    const initialTrial = getLandingCampaignTrialChat(chatRowSnapshot);
    const initialOrientationState = readFirstChatOrientationChatState(chatRowSnapshot?.metadata);
    const mayContinueFirstChatOrientation =
      senderRow.type === "human" &&
      !options.allowFirstChatOrientation &&
      (initialOrientationState === FIRST_CHAT_ORIENTATION_CHAT_STATES.PENDING ||
        initialOrientationState === FIRST_CHAT_ORIENTATION_CHAT_STATES.LEGACY_STARTED);
    if (mayContinueFirstChatOrientation) {
      await options.beforeFirstChatOrientationLockForTest?.();
    }
    // Trial chat state is a server-owned single-run state machine. Lock and
    // re-read only stateful rows. First-chat Orientation shares this same row
    // lock with legacy kickoff reuse so exactly one transition owns the wake.
    const chatRow =
      initialTrial || mayContinueFirstChatOrientation
        ? (
            await tx.select({ metadata: chats.metadata }).from(chats).where(eq(chats.id, chatId)).for("update").limit(1)
          )[0]
        : chatRowSnapshot;
    const lockedOrientationState = readFirstChatOrientationChatState(chatRow?.metadata);
    let orientationTargetAgentId: string | null = null;
    let openingMessage: { id: string; metadata: Record<string, unknown> } | undefined;
    if (
      mayContinueFirstChatOrientation &&
      (lockedOrientationState === FIRST_CHAT_ORIENTATION_CHAT_STATES.PENDING ||
        lockedOrientationState === FIRST_CHAT_ORIENTATION_CHAT_STATES.LEGACY_STARTED)
    ) {
      [openingMessage] = await tx
        .select({ id: messages.id, metadata: messages.metadata })
        .from(messages)
        .where(eq(messages.chatId, chatId))
        .orderBy(asc(messages.createdAt), asc(messages.id))
        .limit(1);
      const openingMentions = Array.isArray(openingMessage?.metadata.mentions)
        ? openingMessage.metadata.mentions.filter((value): value is string => typeof value === "string")
        : [];
      const candidateTargetAgentId = openingMentions.length === 1 ? openingMentions[0] : undefined;
      if (
        !openingMessage ||
        readFirstChatOrientationMessageMetadata(openingMessage.metadata) === null ||
        !candidateTargetAgentId
      ) {
        throw new Error(`Unexpected: pending first-chat Orientation "${chatId}" has no trusted target bootstrap`);
      }
      orientationTargetAgentId = candidateTargetAgentId;
    }
    const routedRecipientIds = new Set([
      ...mergedMentions.filter((id) => id !== senderId),
      ...(options.addressedToAgentIds ?? []).filter((id) => id !== senderId),
    ]);

    // Team Skill invocation protocol pair, enforced at the SERVICE layer
    // (not just one HTTP caller): the versioned purpose sentinel and the
    // request-level skillPrecondition must arrive together or not at all.
    // A new Web always sends both; an old Server's purpose enum rejects
    // the sentinel at parse time, so a rollback can never silently strip
    // the precondition and persist a bare, unmarked slash command.
    const hasSkillInvocationSentinel = data.purpose === TEAM_SKILL_INVOCATION_MESSAGE_PURPOSE;
    if (hasSkillInvocationSentinel !== (data.skillPrecondition !== undefined)) {
      throw new BadRequestError(
        "Team Skill invocation sends must carry the team-skill-invocation-v1 purpose and a skillPrecondition together. Re-open the slash menu and pick the command again.",
      );
    }

    // Team Skill slash precondition (request-level, never persisted): the
    // sender asserts this command was chosen for exactly one recipient while
    // the agent's runtime config was at a known version. Re-validate inside
    // the message transaction — the web's fresh pre-send check and this POST
    // are not atomic, so the version must be proven here, not trusted. A
    // removed or renamed Team Skill bumps the config version and turns this
    // into a conflict instead of falling through to a same-named LOCAL Skill.
    //
    // Atomicity: the agent_configs row is taken FOR UPDATE, so a concurrent
    // configuration update (whose own transaction always bumps that row's
    // version) serializes against this send. Either it committed first —
    // then the version below differs and this send conflicts — or it blocks
    // on the lock until after this commit, in which case this message's
    // marker carries the older version and the delivery-time stamp will
    // diverge, settling as a terminal notice on the Client. There is no
    // interleaving that commits a message validated against v1 as a
    // marker-less v2 message.
    let canonicalSkillInvocation: { resourceId: string; requestedSlug: string } | null = null;
    if (data.skillPrecondition) {
      const { recipientAgentId, expectedConfigVersion, resourceId, requestedSlug } = data.skillPrecondition;
      if (routedRecipientIds.size !== 1 || !routedRecipientIds.has(recipientAgentId)) {
        throw new ConflictError(
          "Skill command precondition failed: the message is not addressed to exactly the agent the command was chosen for. Re-open the slash menu and pick the command again.",
        );
      }
      const [configRow] = await tx
        .select({ version: agentConfigs.version })
        .from(agentConfigs)
        .where(eq(agentConfigs.agentId, recipientAgentId))
        .for("update")
        .limit(1);
      if (!configRow || configRow.version !== expectedConfigVersion) {
        throw new ConflictError(
          "Skill command precondition failed: the recipient agent's configuration changed after the command was chosen. Re-open the slash menu and pick the command again.",
        );
      }
      // Untrusted request fields can never mint the marker on their own:
      // the canonical identity must come from the trusted seam reading the
      // CURRENT effective resources. The seam reads committed state on its
      // own connection — exactly the state at the locked version, since a
      // concurrent update is still blocked on the row lock above and its
      // writes are not yet visible.
      if (!options.validateTeamSkillInvocation) {
        throw new ConflictError(
          "Skill command precondition failed: this send path cannot validate Team Skill commands.",
        );
      }
      canonicalSkillInvocation = await options.validateTeamSkillInvocation({
        recipientAgentId,
        resourceId,
        requestedSlug,
      });
      if (!canonicalSkillInvocation) {
        throw new ConflictError(
          "Skill command precondition failed: the Team Skill is no longer an enabled, unambiguous command for the recipient. Re-open the slash menu and pick the command again.",
        );
      }
    }

    const continuesFirstChatOrientation =
      orientationTargetAgentId !== null &&
      !prepared.forceSilentFanOut &&
      routedRecipientIds.has(orientationTargetAgentId);

    if (continuesFirstChatOrientation) {
      if (lockedOrientationState === FIRST_CHAT_ORIENTATION_CHAT_STATES.LEGACY_STARTED) {
        const recipientInboxIds = participants
          .filter((participant) => participant.agentId === orientationTargetAgentId && participant.status === "active")
          .map((participant) => participant.inboxId);
        if (openingMessage && recipientInboxIds.length > 0) {
          // A legacy retry may already have signalled the silent bootstrap. If
          // the agent has not claimed it, transfer the pending trigger to this
          // substantive human turn so inbox replay delivers bootstrap context
          // followed by the user's actual message. If it was already claimed,
          // this update is a no-op and the new message wakes as a normal next
          // turn; user content is never left behind as silent future context.
          await tx
            .update(inboxEntries)
            .set({ notify: false })
            .where(
              and(
                eq(inboxEntries.chatId, chatId),
                eq(inboxEntries.messageId, openingMessage.id),
                eq(inboxEntries.status, "pending"),
                eq(inboxEntries.notify, true),
                inArray(inboxEntries.inboxId, recipientInboxIds),
              ),
            );
        }
      }
      await tx
        .update(chats)
        .set({
          metadata: sql`jsonb_set(
            ${chats.metadata},
            ARRAY[${FIRST_CHAT_ORIENTATION_CHAT_METADATA_KEY}]::text[],
            ${JSON.stringify({ version: 1, state: FIRST_CHAT_ORIENTATION_CHAT_STATES.CONTINUED })}::jsonb,
            true
          )`,
        })
        .where(eq(chats.id, chatId));
    }

    // Ask agent is a constrained clarification turn under an existing open
    // request. Re-check every relation under the same transaction that stores
    // the clarification; the browser-supplied route param is never treated as
    // trusted metadata.
    if (options.askAgentRequestId) {
      const requestId = options.askAgentRequestId;
      if (senderRow.type !== "human") {
        throw new ForbiddenError("Only the question's target human may ask the agent for clarification.");
      }
      if (data.inReplyTo !== requestId || (data.format !== "text" && data.format !== "markdown")) {
        throw new BadRequestError("Ask agent must be a text reply to the open question.");
      }

      const [parent] = await tx
        .select({ format: messages.format, metadata: messages.metadata, senderId: messages.senderId })
        .from(messages)
        .where(and(eq(messages.id, requestId), eq(messages.chatId, chatId)))
        .for("update")
        .limit(1);
      const parentMentions = Array.isArray(parent?.metadata?.mentions) ? parent.metadata.mentions : [];
      if (
        !parent ||
        parent.format !== MESSAGE_FORMATS.REQUEST ||
        parentMentions.length !== 1 ||
        parentMentions[0] !== senderId
      ) {
        throw new ForbiddenError("This question is not an open request directed at you.");
      }

      const asker = participants.find((participant) => participant.agentId === parent.senderId);
      if (!asker || asker.type === "human" || asker.status !== "active") {
        throw new BadRequestError("The agent that asked this question is not available for clarification.");
      }
      if (mergedMentions.length !== 1 || mergedMentions[0] !== asker.agentId) {
        throw new BadRequestError("Ask agent must be routed only to the agent that asked the question.");
      }

      const priorResolution = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.chatId, chatId),
            sql`${messages.metadata} -> 'resolves' ->> 'request' = ${requestId}`,
            sql`${messages.metadata} -> 'resolves' ->> 'kind' IN ('answered', 'closed')`,
            inArray(messages.senderId, [senderId, parent.senderId]),
          ),
        )
        .limit(1);
      if (priorResolution.length > 0) {
        throw new BadRequestError("This question has already been handled.");
      }

      metadataToStore = {
        ...preparedMetadata,
        [ASK_AGENT_METADATA_KEY]: {
          requestId,
          agentId: asker.agentId,
        },
      };
    }

    if (continuesFirstChatOrientation) {
      metadataToStore = {
        ...metadataToStore,
        [FIRST_CHAT_ORIENTATION_CONTINUATION_METADATA_KEY]: {
          version: 1,
          targetAgentId: orientationTargetAgentId,
        },
      };
    }

    if (canonicalSkillInvocation && data.skillPrecondition) {
      // The precondition held at insert time, so persist the SERVER-OWNED
      // invocation marker with the message — built from the CANONICAL
      // identity the trusted seam validated (never the request's untrusted
      // fields). The delivery-time configVersion stamp alone cannot
      // distinguish "Team Skill chosen at v1, delivered after the config
      // moved to v2" from "a hand-typed local command sent against v2" —
      // this marker can, and the recipient's Client resolves the command
      // fail-closed against it (never a same-named local Skill) no matter
      // how long the inbox queue delayed delivery. Stamped AFTER every
      // branch that rebuilds metadataToStore from preparedMetadata (which
      // has the inbound value stripped).
      const { recipientAgentId, expectedConfigVersion } = data.skillPrecondition;
      metadataToStore = {
        ...metadataToStore,
        [TEAM_SKILL_INVOCATION_METADATA_KEY]: {
          version: TEAM_SKILL_INVOCATION_MARKER_VERSION,
          recipientAgentId,
          resourceId: canonicalSkillInvocation.resourceId,
          requestedSlug: canonicalSkillInvocation.requestedSlug,
          configVersion: expectedConfigVersion,
        },
      };
    }

    assertLandingCampaignTrialMessageAllowed({
      chat: chatRow,
      senderId,
      senderType: senderRow.type,
      data,
      metadataToStore,
      options,
    });

    // 2b. Validate generic attachment refs (`metadata.attachments[]`) against
    //     the blob store: each referenced attachment must exist and its
    //     declared mime/size must match the stored row. Async (DB lookup), so
    //     it runs here rather than in the sync preflight. Byte integrity is
    //     checked client-side at render via `ref.sha256`; uploader != sender by
    //     design (see validateMessageAttachmentRefs).
    await validateMessageAttachmentRefs(tx, metadataToStore);
    await lockFileAttachmentRefsIfPresent(tx, data.format, outboundContent);

    // 3. Store the message (with merged metadata + normalised content).
    // UUID v7 per the "UUID v7 as Message ID" architecture rule in
    // CLAUDE.md — time-ordered so message id lex order matches creation
    // order. randomUUID() (v4) was the pre-existing implementation; the
    // mismatch was caught when the web client's "new messages" divider
    // relied on lex ordering to find newer-than-anchor messages and
    // silently dropped some (PR #286, rev 8).
    const messageId = options.messageId ?? uuidv7();
    const [msg] = await tx
      .insert(messages)
      .values({
        id: messageId,
        chatId,
        senderId,
        senderKind: options.integrationSender?.kind ?? "member",
        senderProvider: options.integrationSender?.provider ?? null,
        format: data.format,
        content: outboundContent,
        metadata: metadataToStore,
        inReplyTo: data.inReplyTo ?? null,
        source: data.source,
      })
      .returning();

    // 4. Fan-out: create inbox entries for every non-sender participant.
    //    The `notify` flag splits them in two:
    //    - `notify=true`  — wakes the recipient's session (the existing path).
    //    - `notify=false` — silent context row, written so a future active
    //      delivery to the same chat can replay it as preceding history.
    //
    //    Explicit-only contract (see file-level "Routing contract"):
    //    - sender is always filtered out (no self-delivery).
    //    - explicit wake triggers `notify=true`:
    //        * agentId in `addressedToAgentIds` (system-routed override), OR
    //        * agentId in `metadata.mentions` (mergedMentions, post-resolve).
    //    - `purposeProfile.forceSilentFanOut` (agent final-text or another
    //      explicitly trusted internal silent-delivery path) forces
    //      notify=false for every row regardless.
    //      Inbox entries are still written so history replay still works;
    //      nobody is woken.
    const mentionSet = new Set(mergedMentions);
    const addressedSet = new Set(options.addressedToAgentIds ?? []);
    // Build a single fan-out structure that carries agentId alongside the
    // inbox row. agentId is needed by the post-tx session-activation step
    // (Step 1b) but is not part of the inbox_entries schema — it's stripped
    // back out at insert time below.
    const fanout = participants
      .filter((p) => p.agentId !== senderId)
      .filter((p) => p.status === "active")
      .map((p) => ({
        agentId: p.agentId,
        inboxId: p.inboxId,
        notify: !prepared.forceSilentFanOut && (addressedSet.has(p.agentId) || mentionSet.has(p.agentId)),
      }));

    if (fanout.length > 0) {
      await tx
        .insert(inboxEntries)
        .values(fanout.map((f) => ({ inboxId: f.inboxId, messageId, chatId, notify: f.notify })));
    }

    // notify=true entries serve two consumers:
    //   - `recipients` (inboxIds) — feeds the route-layer PG NOTIFY for
    //     wake-up. Silent entries piggy-back on the next active delivery
    //     (see services/chat/inbox.ts pollInbox).
    //   - `recipientAgentIds` — feeds the post-transaction predictive
    //     session-activation block (Step 1b below; M-plan N1-B range).
    const notified = fanout.filter((f) => f.notify);
    const recipients = notified.map((f) => f.inboxId);
    const recipientAgentIds = notified.map((f) => f.agentId);

    // 5. Update chat.updatedAt so chat list sorting reflects latest activity
    await tx.update(chats).set({ updatedAt: new Date() }).where(eq(chats.id, chatId));

    if (!msg) throw new Error("Unexpected: INSERT RETURNING produced no row");

    // 6. Chat-first workspace projection (append-only, post-fan-out).
    //    Updates chats.last_message_*, increments the directly-mentioned human
    //    speaker's unread-mention counter (plus the agent-final-text bump). See
    //    first-tree-context:agent-hub/web-console.md "Risk Constraints".
    // Chat-list preview: prefer string content (text/markdown) verbatim;
    // fall back to the caption of a batched image send (`format: "file"`
    // with `{caption?, attachments[]}` shape) so a "text + N images" send
    // still surfaces its text in the conversation list. Pure single-image
    // messages (no caption) stay empty — same as before.
    const previewText =
      typeof outboundContent === "string" ? outboundContent.trim() : extractCaption(outboundContent).trim();
    await applyAfterFanOut(tx, {
      chatId,
      messageId: msg.id,
      senderId,
      mentionedAgentIds: mergedMentions,
      contentPreview: previewText,
      messageCreatedAt: msg.createdAt,
      // Restrict the final-text unread bump to non-human senders.
      // `purpose` lives on the shared sendMessage schema, so a human-
      // authored web send could in principle set it; gating here keeps
      // the human-as-sender path out of the new projection branch even
      // if the rest of `agent-final-text` semantics (skipMentionEnforcement,
      // forceSilentFanOut) happen to fire for that caller.
      bumpForAgentFinalText: prepared.isAgentFinalText && senderRow.type !== "human",
    });

    // 7. Open-question counter (`chat_user_state.open_request_count`) — see
    //    proposals/group-chat-unified-send §D1. TWO INDEPENDENT effects:
    //      +1 — ANY `format=request` opens a question for its single human
    //           target. (A request-shaped reply also +1's — it is a new,
    //           independently-answerable question; it does NOT auto-close the
    //           one it replies to. Both stay open, worked oldest-first.)
    //      -1 — an EXPLICIT resolution: a message carrying `metadata.resolves`
    //           pointed at a prior open question. Resolution is human-only — the
    //           target's web answer; an agent (even the asker) cannot resolve.
    //           `inReplyTo` no longer resolves anything — it is pure threading,
    //           so a "chat about this" discussion can thread under the question
    //           without clearing the red dot. Idempotent — only the first
    //           resolution decrements; `GREATEST(0, …)` floors at zero.
    const requestTarget = mergedMentions[0];
    if (data.format === MESSAGE_FORMATS.REQUEST && requestTarget) {
      await tx.execute(sql`
        INSERT INTO chat_user_state (chat_id, agent_id, open_request_count)
        VALUES (${chatId}, ${requestTarget}, 1)
        ON CONFLICT (chat_id, agent_id)
        DO UPDATE SET open_request_count = chat_user_state.open_request_count + 1
      `);
    }
    // ANY presence of the reserved `resolves` key must parse — a malformed
    // shape (e.g. bogus `kind`) is rejected, not stored as inert metadata.
    // Storing it would both mislead readers and poison the prior-resolution
    // idempotency scan below (which matches on `resolves ->> 'request'`),
    // permanently blocking the legitimate decrement.
    let resolvedRequest = false;
    const resolution = requestResolutionSchema.safeParse(metadataToStore.resolves);
    if (resolution.success) {
      const requestId = resolution.data.request;
      // Lock the target request row FIRST so concurrent resolutions of the
      // SAME question serialise — otherwise two could both observe no prior
      // resolution under READ COMMITTED and each decrement (double-decrement).
      const [parent] = await tx
        .select({ format: messages.format, metadata: messages.metadata, senderId: messages.senderId })
        .from(messages)
        .where(and(eq(messages.id, requestId), eq(messages.chatId, chatId)))
        .for("update")
        .limit(1);
      // FAIL LOUD on an invalid resolution target. Throwing here rolls back
      // the whole transaction (including the message INSERT above), so no
      // misleading "answered"/"closed" message with a dangling
      // `metadata.resolves.request` / `inReplyTo` ever lands in history.
      if (!parent) {
        throw new BadRequestError(
          `Cannot resolve "${requestId}": no such message in this chat. Pass the id of the open question you asked.`,
        );
      }
      const parentMentions = Array.isArray(parent.metadata?.mentions) ? parent.metadata.mentions : [];
      const target =
        parent.format === MESSAGE_FORMATS.REQUEST && parentMentions.length === 1 ? parentMentions[0] : undefined;
      if (typeof target !== "string") {
        throw new BadRequestError(
          `Cannot resolve "${requestId}": it is not a tracked request. Only a question raised with \`chat ask\` can be answered.`,
        );
      }
      // Resolution is human-only: ONLY the target human resolves it, by
      // answering in the web UI. An agent — including the asker — cannot mark a
      // question answered or close it. A plain agent→human `chat send` is allowed
      // (a free reply), but it can never carry a resolution: this authz is the
      // authoritative gate for the resolution itself.
      if (senderId !== target) {
        throw new ForbiddenError("Only the question's target may resolve it — the human answers in the web UI.");
      }
      // A Skip still routes to and wakes a live asker. Recipientless close is
      // only the degraded lifecycle path for an asker that preflight found
      // suspended, deleted, or missing. This check prevents a caller from
      // smuggling an unrelated stale mention through preflight to suppress
      // routing to an otherwise-active asker.
      const activeAsker = participants.find(
        (participant) => participant.agentId === parent.senderId && participant.status === "active",
      );
      if (resolution.data.kind === "closed") {
        const declaredMentions = Array.isArray(data.metadata?.mentions)
          ? data.metadata.mentions.filter((mention): mention is string => typeof mention === "string")
          : [];
        if (activeAsker && !mergedMentions.includes(activeAsker.agentId)) {
          throw new BadRequestError("Closing a request from an active asker must route the resolution to that asker.");
        }
        if (!activeAsker && !declaredMentions.includes(parent.senderId)) {
          throw new BadRequestError("Closing a request must declare the original asker before routing can degrade.");
        }
      }
      // Idempotency: only the FIRST resolution decrements (exclude the row we
      // just inserted). A prior resolution is any other message in this chat
      // whose `metadata.resolves.request` points at the same question, from a
      // sender in the resolver scope. The scope is the target human (the only
      // authorized resolver now) PLUS the asker — the asker is kept ONLY to
      // recognize legacy pre-gate rows it may have written back when an agent
      // could resolve; it can no longer write a NEW resolution (the authz above
      // rejects it). The scope matters because, without it, any participant
      // could pre-write a stray `metadata.resolves` (itself never decrementing,
      // being unauthorized) that would count as a "prior" and permanently block
      // the legitimate resolution from clearing the red dot. A re-resolve of an
      // already-resolved question stays a soft success: it threads as a
      // confirmation and simply skips the decrement, so a duplicate human answer
      // never errors.
      const resolvers = [target, parent.senderId];
      const priors = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.chatId, chatId),
            ne(messages.id, messageId),
            sql`${messages.metadata} -> 'resolves' ->> 'request' = ${requestId}`,
            // Only schema-valid resolution rows count as a "prior" — a
            // malformed legacy row (pre-validation `kind`) must not block
            // the legitimate resolution from clearing the red dot.
            sql`${messages.metadata} -> 'resolves' ->> 'kind' IN ('answered', 'closed')`,
            inArray(messages.senderId, resolvers),
          ),
        );
      if (priors.length === 0) {
        await tx.execute(sql`
          UPDATE chat_user_state
             SET open_request_count = GREATEST(0, open_request_count - 1)
           WHERE chat_id = ${chatId} AND agent_id = ${target}
        `);
      }
      resolvedRequest = true;
    }

    const trial = getLandingCampaignTrialChat(chatRow);
    if (chatRow && trial) {
      let nextMetadata: Record<string, unknown> | null = null;
      if (senderId === trial.agentId && senderRow.type !== "human") {
        if (data.format === MESSAGE_FORMATS.REQUEST) {
          nextMetadata = withLandingCampaignChatState(chatRow.metadata, "awaiting_user", false, {
            awaitingUserKind: "request",
          });
        }
      } else if (
        senderRow.type === "human" &&
        trial.state === "awaiting_user" &&
        (resolvedRequest || trial.awaitingUserKind === "follow_up")
      ) {
        nextMetadata = withLandingCampaignChatState(chatRow.metadata, "running", false);
      }
      if (nextMetadata) {
        await tx.update(chats).set({ metadata: nextMetadata, updatedAt: new Date() }).where(eq(chats.id, chatId));
      }
    }

    return {
      message: msg,
      recipients,
      recipientAgentIds,
      organizationId: senderRow.organizationId,
    };
  });

  const postCommitEffects: DeferredSendMessagePostCommitEffects = {
    chatId,
    messageId: txResult.message.id,
    organizationId: txResult.organizationId,
    recipientAgentIds: txResult.recipientAgentIds,
  };
  if (!options.deferPostCommitEffects) {
    await runDeferredSendMessagePostCommitEffects(db, postCommitEffects);
  }

  return {
    message: txResult.message,
    recipients: txResult.recipients,
    ...(options.deferPostCommitEffects ? { deferredPostCommitEffects: postCommitEffects } : {}),
  };
}

/**
 * Run the non-transactional effects for a durable message. Ordinary sends call
 * this immediately after their own transaction commits. A caller that sent
 * through an existing outer transaction uses the deferred descriptor and
 * invokes this helper only after that outer transaction has committed.
 */
export async function runDeferredSendMessagePostCommitEffects(
  db: Database,
  effects: DeferredSendMessagePostCommitEffects,
): Promise<void> {
  // Predictive session-state activation: best-effort upsert an `active`
  // agent_chat_sessions row for every notify=true recipient so the First Tree
  // UI list refreshes immediately on send. Failure is logged but never thrown:
  // the message is durable, and a later session-state frame self-heals the row.
  const settled = await Promise.allSettled(
    effects.recipientAgentIds.map((agentId) =>
      upsertSessionState(db, agentId, effects.chatId, "active", effects.organizationId, undefined, {
        touchPresenceLastSeen: false,
      }),
    ),
  );
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result?.status === "rejected") {
      log.error(
        { err: result.reason, chatId: effects.chatId, agentId: effects.recipientAgentIds[i] },
        "predictive session activation failed",
      );
    }
  }

  // Best-effort chat-first workspace kick — speakers also get the existing
  // inbox NOTIFY; this reaches watcher rows with no inbox entry. Failure is
  // dropped; web reconnect refetches.
  fireChatMessageKick(effects.chatId, effects.messageId);
}

/**
 * Detect agent-sent content that was JSON.stringify-ed once before reaching
 * the CLI / API. The bad shape is an outer `"..."` wrapper + interior `\n` /
 * `\"` escape sequences, which the UI renders as a quoted literal instead of
 * markdown (issue #389). Returns the unwrapped inner string on a confident
 * match, or `null` to leave the content alone.
 *
 * Match conditions (all required) — kept strict so legitimate human content
 * that happens to look like a quoted phrase is never touched. The caller is
 * additionally responsible for restricting this to non-human senders.
 *
 *   - first and last char are `"`
 *   - body contains at least one typical JSON escape sequence
 *     (`\n`, `\r`, `\t`, `\"`, or `\\`)
 *   - `JSON.parse` succeeds
 *   - the parse result is a `string` (excludes `{...}`, `[...]`, numbers)
 */
export function maybeUnwrapDoubleEncoded(content: string): string | null {
  if (content.length < 4) return null;
  if (content.charCodeAt(0) !== 0x22 /* " */) return null;
  if (content.charCodeAt(content.length - 1) !== 0x22 /* " */) return null;
  if (!/\\[nrt"\\]/.test(content)) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export async function editMessage(
  db: Database,
  chatId: string,
  messageId: string,
  senderId: string,
  data: { format?: string; content?: unknown },
  blobStore: AttachmentBlobStore,
) {
  const { updated, releasedAttachmentIds } = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const [msg] = await tx.select().from(messages).where(eq(messages.id, messageId)).for("update").limit(1);
    if (!msg) throw new NotFoundError(`Message "${messageId}" not found`);
    if (msg.chatId !== chatId) throw new NotFoundError(`Message "${messageId}" not found in this chat`);
    if (msg.senderId !== senderId) throw new ForbiddenError("Only the sender can edit a message");
    if (feishuMessageMetadataSchema.safeParse(msg.metadata.feishu).success) {
      throw new ForbiddenError("Feishu message history cannot be edited");
    }
    const protectedContextReviewKey = Object.keys(msg.metadata).find(
      (key) => key === "contextTreeReviewer" || key.startsWith("contextReview"),
    );
    if (protectedContextReviewKey) {
      throw new ForbiddenError("Context Reviewer run history cannot be edited");
    }
    const protectedGithubTaskKey = Object.keys(msg.metadata).find(
      (key) => key === "teamAgentTask" || key === "githubTaskRun" || key.startsWith("githubTask"),
    );
    if (protectedGithubTaskKey) {
      throw new ForbiddenError("GitHub task reply run history cannot be edited");
    }
    const previousAttachmentIds = legacyFileAttachmentIds(msg.format, msg.content);

    // The open-question counter (`open_request_count`) is maintained only on the
    // send path, keyed off `format=request`. Allowing an edit to flip a message
    // into or out of `request` would desync that counter (a request edited to
    // text leaves a stuck +1; text edited to request renders an open card with
    // no count). Forbid format changes that touch `request`; content edits and
    // other format changes are unaffected. See proposals/group-chat-unified-send §D1.
    if (
      data.format !== undefined &&
      data.format !== msg.format &&
      (data.format === MESSAGE_FORMATS.REQUEST || msg.format === MESSAGE_FORMATS.REQUEST)
    ) {
      throw new BadRequestError("Cannot change a message's format to or from 'request'.");
    }

    const setClause: Record<string, unknown> = {};
    if (data.format !== undefined) setClause.format = data.format;
    let effectiveContent = msg.content;
    if (data.content !== undefined) {
      // An edit can replace the body of any message — including an already-open
      // `format=request` ask whose format is frozen above. Reuse the send-path
      // guards against the effective post-edit `{ format, content }` so an edit
      // can't turn a live message into an empty / placeholder blocking card or an
      // agent-authored escaped-newline body.
      const [senderRow] = await tx.select({ type: agents.type }).from(agents).where(eq(agents.uuid, senderId)).limit(1);
      if (!senderRow) throw new NotFoundError(`Sender agent "${senderId}" not found`);
      effectiveContent = normalizeNonHumanTextContent({
        chatId,
        senderId,
        senderType: senderRow.type,
        content: data.content,
      });
      setClause.content = effectiveContent;
    }

    const effectiveFormat = data.format ?? msg.format;
    if (data.content !== undefined || data.format !== undefined) {
      validateMessageContent(
        { format: effectiveFormat, content: effectiveContent },
        { hasAttachmentRefs: attachmentRefsFromMetadata(msg.metadata ?? undefined).length > 0 },
      );
      await lockFileAttachmentRefsIfPresent(tx, effectiveFormat, effectiveContent);
    }

    // Patch only the edit timestamp in Postgres so concurrent server-owned
    // metadata transitions cannot be overwritten by a stale read of the row.
    setClause.metadata = sql`jsonb_set(${messages.metadata}, '{editedAt}', ${JSON.stringify(
      new Date().toISOString(),
    )}::jsonb)`;

    const [updated] = await tx.update(messages).set(setClause).where(eq(messages.id, messageId)).returning();
    if (!updated) throw new Error("Unexpected: UPDATE RETURNING produced no row");
    const nextAttachmentIds = new Set(legacyFileAttachmentIds(updated.format, updated.content));
    return {
      updated,
      releasedAttachmentIds: [...new Set(previousAttachmentIds)].filter((id) => !nextAttachmentIds.has(id)),
    };
  });

  await Promise.all(
    releasedAttachmentIds.map(async (id) => {
      try {
        await deleteAttachmentIfUnreferenced(db, blobStore, id);
      } catch (error) {
        log.warn({ err: error, attachmentId: id, messageId }, "post-edit attachment cleanup will retry");
      }
    }),
  );
  return updated;
}

/**
 * Opaque message-history cursor. The base64url envelope is safe to copy into
 * `chat history --cursor` without shell quoting; the id is the deterministic
 * tie-breaker for messages that share one cursor millisecond.
 */
function parseMessageHistoryCursor(cursor: string): { date: Date; id: string } {
  let decoded = "";
  if (/^[A-Za-z0-9_-]+$/.test(cursor)) {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") === cursor) decoded = bytes.toString("utf8");
  }
  const [version, iso, id, ...extra] = decoded.split("|");
  const date = new Date(iso ?? "");
  if (version !== "v1" || Number.isNaN(date.getTime()) || !id || extra.length > 0) {
    throw new BadRequestError("cursor must be the nextCursor value from a previous message-history page");
  }
  return { date, id };
}

export function messageHistoryWhere(chatId: string, cursor?: string) {
  if (!cursor) return eq(messages.chatId, chatId);
  const { date, id } = parseMessageHistoryCursor(cursor);
  return and(
    eq(messages.chatId, chatId),
    sql`(date_trunc('milliseconds', ${messages.createdAt}), ${messages.id}) < (${date.toISOString()}::timestamptz, ${id}::text)`,
  );
}

export function messageHistoryOrderBy() {
  // Postgres preserves microseconds while JS Date/ISO retains milliseconds.
  // Compare and order on the same truncated expression so a boundary cursor
  // cannot skip rows whose raw timestamps differ inside one millisecond.
  return [sql`date_trunc('milliseconds', ${messages.createdAt}) DESC`, desc(messages.id)] as const;
}

export function encodeMessageHistoryCursor(createdAt: Date, id: string): string {
  return Buffer.from(`v1|${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

export async function listMessages(db: Database, chatId: string, limit: number, cursor?: string) {
  const where = messageHistoryWhere(chatId, cursor);

  const query = db
    .select()
    .from(messages)
    .where(where)
    .orderBy(...messageHistoryOrderBy())
    .limit(limit + 1);

  const rows = await query;
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeMessageHistoryCursor(last.createdAt, last.id) : null;

  return { items, nextCursor };
}

/**
 * Every `format=request` message in `chatId` directed at `viewerAgentId` (its
 * single human target) that has NO authorized resolution yet — i.e. the
 * viewer's currently-open questions, oldest-first.
 *
 * "Open" mirrors the `open_request_count` decrement rule in `sendMessage`:
 * resolution is human-only, so a request is resolved iff a later message in the
 * chat carries `metadata.resolves.request = <this id>` with a valid kind from an
 * authorized resolver — the target (the viewer) or the asker. Anything else
 * (a bare threaded reply, a stray `resolves` from a third party) leaves it open.
 *
 * This is deliberately WINDOW-INDEPENDENT: it is the source the blocking
 * answer UI uses so an open ask that has scrolled past the latest message page
 * still surfaces (the timeline fetch is capped + unpaginated). Oldest-first so
 * the caller's FIFO blocking pick matches the client's `findBlockingRequest`.
 */
export async function listOpenRequestsForViewer(
  db: Database,
  chatId: string,
  viewerAgentId: string,
): Promise<(typeof messages.$inferSelect)[]> {
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        eq(messages.format, MESSAGE_FORMATS.REQUEST),
        sql`${messages.metadata} -> 'mentions' @> jsonb_build_array(${viewerAgentId}::text)`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${messages} AS resolver
          WHERE resolver.chat_id = ${messages.chatId}
            AND resolver.metadata -> 'resolves' ->> 'request' = ${messages.id}::text
            AND (resolver.metadata -> 'resolves' ->> 'kind') IN ('answered', 'closed')
            AND resolver.sender_id IN (${messages.senderId}, ${viewerAgentId})
        )`,
      ),
    )
    .orderBy(asc(messages.createdAt));
}
