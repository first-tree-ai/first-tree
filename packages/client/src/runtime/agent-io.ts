import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  attachmentRefsFromMetadata,
  type ChatParticipantDetail,
  extractCaption,
  type ImageRefContent,
  imageAttachmentRefsFromMetadata,
  isImageBatchRefContent,
  isImageRefContent,
  readAskAgentMessageMetadata,
  readFeishuMessageMetadata,
  resolveTrustedSystemSender,
  TRUSTED_SYSTEM_SENDER_NAMES,
} from "@first-tree/shared";
import type { FirstTreeHubSDK } from "../cloud/sdk.js";
import { findAttachmentFile } from "./attachment-store.js";
import { getCliBinding } from "./cli-binding.js";
import { contextTreeShimDir, contextTreeShimName } from "./external-context-tree.js";
import type { AgentIdentity, SessionMessage } from "./handler.js";
import { findImagePath } from "./image-store.js";
import { ATTACHMENT_UNAVAILABLE_NOTE } from "./provider-support/attachment-availability.js";

/**
 * Cross-handler plumbing for First Tree ↔ agent-runtime interaction.
 *
 * Every handler that shells out to the First Tree CLI or otherwise acts
 * on behalf of the agent needs the same envelope variables (server URL, agent
 * id, inbox id, chat id). And every handler that hands inbound messages to an
 * LLM benefits from the same `[From: <name>]` attribution header so the LLM
 * can see who authored each message in human-readable terms.
 *
 * Keeping these helpers in one place means adding a second handler (Gemini,
 * Cursor Agent, custom LLM, …) does not reimplement either concern.
 */

/**
 * Build the env for CLI sub-processes that need to call `<binName> ...`.
 * Layers the First Tree envelope variables on top of the parent env. Handlers
 * that start sub-processes should call this so every one of them sees the same
 * envelope — enabling replyTo inference, access-token propagation, agent-id
 * binding, and channel-correct CLI command text without per-handler duplication.
 *
 * `FIRST_TREE_HOME` is state/config storage, not a CLI install prefix. Only an
 * explicit `FIRST_TREE_CLI_BIN_DIR` asks this helper to put a channel-specific
 * CLI directory ahead of the parent PATH. First Tree's own `context-tree` shim
 * directory, when the shim exists, goes ahead of everything so the external
 * Context Tree Skills run the CLI release they were installed from.
 */
export function buildAgentEnv(
  parentEnv: NodeJS.ProcessEnv,
  ctx: {
    sdk: Pick<FirstTreeHubSDK, "serverUrl"> & { runtimeSessionToken?: string | undefined };
    agent: AgentIdentity;
    chatId: string;
    clientId?: string;
    runtimeSessionTokenFile?: string;
    provider?: string;
    /**
     * Resolved doc-preview context for this session, so a `first-tree
     * chat send` sub-process can snapshot referenced `.md`. (The result-sink's
     * own doc-capture was retired with the final-text mirror, so this is now a
     * CLI-`chat send`-only path.) Absent → `chat send` skips snapshotting.
     *
     * Two boundaries are exported:
     *  - `agentHome` — the WIDE fence: per-agent home (or legacy per-chat
     *    dir for pre-#506 chats). Covers on-demand `worktrees/<task>/`
     *    checkouts that #498's idiom puts here. New chat-send binaries read
     *    `FIRST_TREE_DOC_AGENT_HOME`.
     *  - `base` — the NARROW fence: source repo top
     *    (`<agentHome>/source-repos/<localPath>` for single-repo, `agentHome`
     *    otherwise). Kept emitting under the
     *    legacy `FIRST_TREE_DOC_BASE` name so a stale pre-fix `chat send`
     *    binary still snapshots like it used to (graceful degradation: no
     *    worktree preview, but source-repo docs work).
     *
     * Cross-agent resolution needs `workspacesRoot` + `selfSlug` + chatId;
     * `agentHome` alone (or `base` alone for legacy) still enables self
     * snapshots.
     */
    docContext?: {
      /** Legacy narrow fence (source-repo top); ridden by pre-fix `chat send`. */
      base: string;
      /** Wide fence (agent home / legacy per-chat dir). */
      agentHome: string;
      /** Single declared source-repo `localPath` — promotes relative `docs/foo.md`
       *  to the same canonical key as the absolute form. */
      singleRepoLocalPath?: string;
      workspacesRoot: string;
      selfSlug: string;
    };
    log?: (msg: string) => void;
  },
): NodeJS.ProcessEnv {
  const env = withContextTreeShimDirOnPath(withExplicitCliBinDirOnPath(parentEnv, ctx.log));
  delete env.FIRST_TREE_RUNTIME_SESSION_TOKEN;
  delete env.FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE;
  return {
    ...env,
    FIRST_TREE_SERVER_URL: ctx.sdk.serverUrl,
    FIRST_TREE_AGENT_ID: ctx.agent.agentId,
    ...(ctx.runtimeSessionTokenFile ? { FIRST_TREE_RUNTIME_SESSION_TOKEN_FILE: ctx.runtimeSessionTokenFile } : {}),
    FIRST_TREE_INBOX_ID: ctx.agent.inboxId,
    FIRST_TREE_CHAT_ID: ctx.chatId,
    ...(ctx.clientId ? { FIRST_TREE_CLIENT_ID: ctx.clientId } : {}),
    ...(ctx.provider
      ? {
          FIRST_TREE_PROVIDER: ctx.provider,
          FIRST_TREE_SWITCH_DRAIN_VERSION: "1",
        }
      : {}),
    ...(ctx.docContext
      ? {
          FIRST_TREE_DOC_BASE: ctx.docContext.base,
          FIRST_TREE_DOC_AGENT_HOME: ctx.docContext.agentHome,
          ...(ctx.docContext.singleRepoLocalPath
            ? { FIRST_TREE_DOC_REPO_LOCAL_PATH: ctx.docContext.singleRepoLocalPath }
            : {}),
          FIRST_TREE_WORKSPACES_ROOT: ctx.docContext.workspacesRoot,
          FIRST_TREE_AGENT_SLUG: ctx.docContext.selfSlug,
        }
      : {}),
  };
}

const warnedCliResolutionKeys = new Set<string>();

function withExplicitCliBinDirOnPath(parentEnv: NodeJS.ProcessEnv, log?: (msg: string) => void): NodeJS.ProcessEnv {
  const cliBinDir = parentEnv.FIRST_TREE_CLI_BIN_DIR;
  if (!cliBinDir) {
    return { ...parentEnv };
  }

  const pathKey = resolvePathKey(parentEnv);
  const currentPath = parentEnv[pathKey] ?? "";
  const existing = currentPath.split(delimiter).filter((part) => part.length > 0 && part !== cliBinDir);
  const nextPath = [cliBinDir, ...existing].join(delimiter);
  const env = { ...parentEnv, [pathKey]: nextPath };

  const { binName } = getCliBinding();
  if (!canResolveExecutable(cliBinDir, binName, parentEnv)) {
    warnCliResolutionOnce(
      `missing-explicit-bin:${cliBinDir}:${binName}`,
      log,
      `FIRST_TREE_CLI_BIN_DIR is set to ${cliBinDir}, but ${binName} was not found there`,
    );
  }

  return env;
}

/** Prepend the `context-tree` shim directory when external mode has written the shim. */
export function withContextTreeShimDirOnPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const shimDir = contextTreeShimDir();
  if (!existsSync(join(shimDir, contextTreeShimName()))) return env;
  const pathKey = resolvePathKey(env);
  const existing = (env[pathKey] ?? "").split(delimiter).filter((part) => part.length > 0 && part !== shimDir);
  return { ...env, [pathKey]: [shimDir, ...existing].join(delimiter) };
}

function resolvePathKey(env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32") {
    if ("Path" in env) return "Path";
    if ("PATH" in env) return "PATH";
    if ("path" in env) return "path";
    return "Path";
  }
  return "PATH";
}

function canResolveExecutable(binDir: string, binName: string, env: NodeJS.ProcessEnv): boolean {
  for (const candidate of executableCandidates(binDir, binName, env)) {
    try {
      accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      // Keep probing.
    }
  }
  return false;
}

function executableCandidates(binDir: string, binName: string, env: NodeJS.ProcessEnv): string[] {
  const bare = join(binDir, binName);
  if (process.platform !== "win32") return [bare];
  const pathExts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  return [bare, ...pathExts.map((ext) => `${bare}${ext.toLowerCase()}`), ...pathExts.map((ext) => `${bare}${ext}`)];
}

function warnCliResolutionOnce(key: string, log: ((msg: string) => void) | undefined, message: string): void {
  if (!log) return;
  if (warnedCliResolutionKeys.has(key)) return;
  warnedCliResolutionKeys.add(key);
  log(message);
}

/** Session-scoped participant cache shared by result-sink and inbound formatter. */
export type ParticipantCache = {
  get: () => Promise<ChatParticipantDetail[]>;
};

export function createParticipantCache(
  sdk: Pick<FirstTreeHubSDK, "listChatParticipants"> | (() => Pick<FirstTreeHubSDK, "listChatParticipants">),
  chatId: string,
  log: (msg: string) => void,
): ParticipantCache {
  let cached: ChatParticipantDetail[] | null = null;
  let inflight: Promise<ChatParticipantDetail[]> | null = null;
  return {
    async get() {
      if (cached) return cached;
      if (!inflight) {
        inflight = (async () => {
          try {
            const currentSdk = typeof sdk === "function" ? sdk() : sdk;
            const rows = await currentSdk.listChatParticipants(chatId);
            cached = rows;
            return rows;
          } catch (err) {
            log(`listChatParticipants failed: ${err instanceof Error ? err.message : String(err)}`);
            return [];
          } finally {
            inflight = null;
          }
        })();
      }
      return inflight;
    },
  };
}

/**
 * Resolve `senderId` → display-friendly label the LLM can actually
 * disambiguate. Prefers `name` (unique per chat, used as the `@<name>`
 * mention token), falls back to `displayName`, then to the raw id. The last
 * fallback matters for edge cases — e.g. a participant removed mid-session
 * after we cached an earlier participants snapshot.
 */
export function resolveSenderLabel(senderId: string, participants: ChatParticipantDetail[]): string {
  for (const p of participants) {
    if (p.agentId !== senderId) continue;
    if (p.name) return p.name;
    if (p.displayName) return p.displayName;
    return senderId;
  }
  return senderId;
}

/**
 * Resolve `senderId` → participant `type` ("human" | "agent" | …). Returns
 * null when the sender is not among the known participants (stale cache /
 * ex-member) or carries an empty type. The `[From: …]` header surfaces this so
 * the agent applies the right reply discipline — a human directing a message
 * requires a `chat send` reply; an agent wake-up with nothing new does not.
 */
export function resolveSenderType(senderId: string, participants: ChatParticipantDetail[]): string | null {
  for (const p of participants) {
    if (p.agentId !== senderId) continue;
    return p.type.length > 0 ? p.type : null;
  }
  return null;
}

/**
 * Build the `[From: …]` attribution line for an inbound message: the sender's
 * chat-local name plus, when available, the participant `type` and the message
 * send time (ISO 8601). Both annotations are appended as ` · key=value`
 * segments and omitted when unknown, so callers without participant or
 * timestamp data degrade cleanly to the bare `[From: <name>]` form.
 */
export function formatFromHeaderLine(
  senderId: string,
  createdAt: string | undefined,
  participants: ChatParticipantDetail[],
): string {
  const parts = [resolveSenderLabel(senderId, participants)];
  const type = resolveSenderType(senderId, participants);
  if (type) parts.push(`type=${type}`);
  if (createdAt) parts.push(`sent=${createdAt}`);
  return `[From: ${parts.join(" · ")}]`;
}

type AttributedMessage = {
  senderId: string;
  senderKind?: "member" | "integration";
  senderProvider?: "feishu" | null;
  source?: string | null;
  format: string;
  content: unknown;
  metadata: Record<string, unknown> | null;
  createdAt?: string;
};

/**
 * Format one inbound sender header using the shared trusted-system gate.
 * The persisted participant `senderId` remains the delivery carrier; only
 * the agent-visible attribution changes for server-authored SCM messages.
 */
export function formatMessageFromHeaderLine(message: AttributedMessage, participants: ChatParticipantDetail[]): string {
  if (message.senderKind === "integration" && message.senderProvider === "feishu") {
    const metadata = readFeishuMessageMetadata(message.metadata);
    const author = metadata?.direction === "inbound" ? metadata.externalAuthor : null;
    const authorLabel = author
      ? JSON.stringify({ displayName: author.displayName, openId: author.openId, userId: author.userId ?? null })
      : "unknown";
    const parts = ["Feishu", "type=integration", `externalUser=${authorLabel}`];
    if (message.createdAt) parts.push(`sent=${message.createdAt}`);
    return `[From: ${parts.join(" · ")}]`;
  }

  const systemSender = resolveTrustedSystemSender(message);
  if (!systemSender) return formatFromHeaderLine(message.senderId, message.createdAt, participants);

  const parts = [TRUSTED_SYSTEM_SENDER_NAMES[systemSender], "type=system"];
  if (message.createdAt) parts.push(`sent=${message.createdAt}`);
  return `[From: ${parts.join(" · ")}]`;
}

function renderFeishuReferenceForLLM(message: AttributedMessage & { id: string }): string | null {
  const metadata = readFeishuMessageMetadata(message.metadata);
  if (!metadata || metadata.direction !== "inbound") return null;
  const reference = metadata.reference;
  const { binName } = getCliBinding();
  const lines = [
    "<feishu-message-reference>",
    "This block is trusted routing context from First Tree. Choose the target yourself when replying.",
    "This is ordinary external-channel work, not a First Tree onboarding chat. Do not load first-tree-welcome merely because this is a new chat or the message is a greeting.",
    `Only the Bot-bound primary Agent may reply externally. First run \`${binName} feishu intent\` to record the immutable delivery. Then run \`${binName} feishu credential-env\`, source the returned private file, and call the official lark-cli with \`--as bot\` and the canonical message id as its idempotency key. Do not use an existing global Bot or \`--as user\`. Internal collaborators must return their work to the primary Agent.`,
    `firstTreeMessageId: ${message.id}`,
    `messageId: ${reference.messageId}`,
    `chatId: ${reference.chatId}`,
    `chatType: ${reference.chatType}`,
  ];
  if (reference.threadId) lines.push(`threadId: ${reference.threadId}`);
  if (reference.rootId) lines.push(`rootId: ${reference.rootId}`);
  if (reference.parentId) lines.push(`parentId: ${reference.parentId}`);
  if (reference.sentAt) lines.push(`sentAt: ${reference.sentAt}`);
  lines.push("</feishu-message-reference>");
  return lines.join("\n");
}

/**
 * SessionContext-facing wrapper: resolve the participant cache and build the
 * `[From: …]` header for `message`, or `""` when it has no sender. Shared by
 * the runtime text path and the handlers' synthesised (image) path so every
 * inbound header is framed identically.
 */
export async function buildFromHeader(message: SessionMessage, participants: ParticipantCache): Promise<string> {
  if (!message.senderId) return "";
  return formatMessageFromHeaderLine(message, await participants.get());
}

/**
 * Produce the handler-facing string form of an inbound message. Prefixes a
 * `[From: <name>]` line when the sender is a known participant. Structured
 * content is serialised to JSON — handlers that want to feed structured
 * content some other way should opt out and format themselves.
 *
 * If the server attached `precedingMessages` (silent group-chat history the
 * recipient missed because it was `mention_only` and not @mentioned), prepend
 * them under an `[Earlier in chat]` block so the LLM sees what came before
 * the @mention that woke this turn — see proposals/group-chat-ux-improvements §1.
 *
 * Async because the participant list may need a server round-trip on first
 * use; subsequent messages in the same session hit the cache.
 */
/**
 * Convert a SessionMessage's payload to a plain-text snippet the LLM can
 * read as user input. Most formats are already strings; non-string
 * payloads are stringified so the resumed turn still sees readable text.
 *
 * `format: "file"` image messages (single-ref or batched caption + N refs)
 * get a human-readable rendering. Generic image attachments on a textual
 * request are appended through the same path-based note without changing the
 * request body shape.
 */
function renderForLLM(message: SessionMessage): string {
  let base: string;
  if (typeof message.content === "string") {
    base = message.content;
  } else if (message.format === "file") {
    base = renderFileMessageForLLM(message) ?? JSON.stringify(message.content);
  } else {
    base = JSON.stringify(message.content);
  }
  const imageNote = renderImageAttachmentsForLLM(message);
  if (imageNote) base = base.length > 0 ? `${base}\n\n${imageNote}` : imageNote;
  // Document/file attachments ride metadata.attachments on any format — append
  // their on-disk paths so a shell-capable agent can open them.
  const docNote = renderDocumentAttachmentsForLLM(message);
  if (docNote) base = base.length > 0 ? `${base}\n\n${docNote}` : docNote;

  return base;
}

/**
 * Placeholder line for an attachment whose bytes never made it to disk. When
 * this delivery's fetch pass saw a 404 the row is gone server-side and the
 * note carries the retention window; anything else (transient failure, never
 * attempted) keeps the generic device-availability wording.
 */
function unavailableAttachmentNote(
  unavailableIds: ReadonlySet<string> | undefined,
  attachmentId: string,
  kind: "File" | "Image",
  filename: string,
): string {
  return unavailableIds?.has(attachmentId)
    ? `\n[${kind} "${filename}" expired or unavailable — ${ATTACHMENT_UNAVAILABLE_NOTE}]`
    : `\n[${kind} "${filename}" not available on this device]`;
}

/**
 * A text note listing the on-disk paths of any document/file attachments on
 * this message (`metadata.attachments`, non-image), so a shell-capable agent
 * can open them. Returns null when there are none. Generic image refs are
 * handled separately by `renderImageAttachmentsForLLM`; legacy image messages
 * remain content-backed.
 */
export function renderDocumentAttachmentsForLLM(message: SessionMessage): string | null {
  const refs = attachmentRefsFromMetadata(message.metadata ?? undefined).filter((ref) => ref.kind !== "image");
  if (refs.length === 0) return null;
  const lines: string[] = [
    refs.length === 1
      ? "A file was shared in this chat. Open it before responding — use the Read tool for text/PDF, or a shell parser (e.g. python) for spreadsheets / office documents."
      : `${refs.length} files were shared in this chat. Open each before responding — use the Read tool for text/PDF, or a shell parser (e.g. python) for spreadsheets / office documents.`,
  ];
  for (const ref of refs) {
    const path = findAttachmentFile(message.chatId, ref.attachmentId, ref.filename);
    lines.push(
      path
        ? `\nFilename: ${ref.filename}\nPath: ${path}`
        : unavailableAttachmentNote(message.unavailableAttachmentIds, ref.attachmentId, "File", ref.filename),
    );
  }
  return lines.join("\n");
}

/** Render generic image attachments as local paths for the receiving agent. */
export function renderImageAttachmentsForLLM(
  message: Pick<SessionMessage, "chatId" | "metadata" | "unavailableAttachmentIds">,
): string | null {
  const refs = imageAttachmentRefsFromMetadata(message.metadata ?? undefined);
  if (refs.length === 0) return null;
  const lines: string[] = [
    refs.length === 1
      ? "An image was shared in this chat. Use the Read tool / shell to open it before responding."
      : `${refs.length} images were shared in this chat. Use the Read tool / shell to open each before responding.`,
  ];
  for (const ref of refs) {
    const path = findImagePath(message.chatId, ref.attachmentId, ref.mimeType);
    lines.push(
      path
        ? `\nFilename: ${ref.filename}\nPath: ${path}`
        : unavailableAttachmentNote(message.unavailableAttachmentIds, ref.attachmentId, "Image", ref.filename),
    );
  }
  return lines.join("\n");
}

/** Return a text rendering for a file message's content, or null when the
 * shape isn't a known image variant — caller falls back to JSON. */
function renderFileMessageForLLM(message: SessionMessage): string | null {
  const content = message.content;

  // Batch shape: caption + N image refs.
  if (isImageBatchRefContent(content)) {
    const attachments: readonly ImageRefContent[] = content.attachments;
    const caption = extractCaption(content).trim();
    const lines: string[] = [];
    if (caption.length > 0) lines.push(caption);
    lines.push(
      attachments.length === 1
        ? "An image was shared in this chat. Use the Read tool / shell to open it before responding."
        : `${attachments.length} images were shared in this chat. Use the Read tool / shell to open each before responding.`,
    );
    for (const att of attachments) {
      const path = findImagePath(message.chatId, att.imageId, att.mimeType);
      lines.push(
        path
          ? `\nFilename: ${att.filename}\nPath: ${path}`
          : unavailableAttachmentNote(message.unavailableAttachmentIds, att.imageId, "Image", att.filename),
      );
    }
    return lines.join("\n");
  }

  // Single image ref (pre-batch shape, kept for backward compatibility).
  if (isImageRefContent(content)) {
    const path = findImagePath(message.chatId, content.imageId, content.mimeType);
    return path
      ? `An image was shared in this chat. Use the Read tool / shell to open it before responding.\n\nFilename: ${content.filename}\nPath: ${path}`
      : unavailableAttachmentNote(
          message.unavailableAttachmentIds,
          content.imageId,
          "Image",
          content.filename,
        ).trimStart();
  }

  return null;
}

export async function formatInboundContent(message: SessionMessage, participants: ParticipantCache): Promise<string> {
  const rawContent = renderForLLM(message);
  const preceding = message.precedingMessages ?? [];

  let header = "";
  if (preceding.length > 0) {
    const ps = await participants.get();
    const lines: string[] = ["[Earlier in chat — context you missed]"];
    for (const p of preceding) {
      let text = typeof p.content === "string" ? p.content : JSON.stringify(p.content);
      const imageNote =
        p.format === "request"
          ? renderImageAttachmentsForLLM({
              chatId: message.chatId,
              metadata: p.metadata,
              // Preceding request images were fetched in this delivery's
              // pass, so the current message carries their 404 verdicts.
              unavailableAttachmentIds: message.unavailableAttachmentIds,
            })
          : null;
      if (imageNote) text = `${text}\n\n${imageNote}`;
      const feishuReference = renderFeishuReferenceForLLM(p);
      if (feishuReference) text = `${text}\n\n${feishuReference}`;
      lines.push(`${formatMessageFromHeaderLine(p, ps)} ${text}`);
    }
    header = `${lines.join("\n")}\n\n`;
  }

  const feishuReferenceContext = renderFeishuReferenceContext(message);
  const nowMarker = preceding.length > 0 || message.feishuReferenceContext ? "[Now — message that woke you]\n\n" : "";

  const currentHeader = await buildFromHeader(message, participants);
  const feishuReference = renderFeishuReferenceForLLM(message);
  const content = feishuReference ? `${rawContent}\n\n${feishuReference}` : rawContent;
  const beforeCurrent = `${header}${feishuReferenceContext}${nowMarker}`;
  const base = currentHeader ? `${beforeCurrent}${currentHeader}\n\n${content}` : `${beforeCurrent}${content}`;

  const askAgent = readAskAgentMessageMetadata(message.metadata);
  if (!askAgent) return base;

  const participantRows = await participants.get();
  const humanName =
    participantRows.find((participant) => participant.agentId === message.senderId)?.name ??
    resolveSenderLabel(message.senderId, participantRows);
  const { binName } = getCliBinding();
  const steering = [
    "<first-tree-ask-agent-contract>",
    "This block is authored by the First Tree runtime.",
    "",
    `The human is asking for clarification about the still-open request ${askAgent.requestId}.`,
    `This clarification message id is ${message.id}.`,
    "Answer only from context already present in this session. Do not continue the original task.",
    "Do not run tools or take external actions, except for the single chat send command below.",
    "Do not call chat ask or chat update, and do not answer, close, skip, or otherwise resolve the open request.",
    "If the existing context is insufficient, say that plainly in the reply instead of investigating.",
    "",
    "Your normal final output is not delivered to the human. Send the clarification response by running exactly one:",
    `  ${binName} chat send ${humanName} --reply-to ${message.id} -f markdown -F -`,
    "Write the complete clarification answer on stdin for that command.",
    "</first-tree-ask-agent-contract>",
  ].join("\n");

  return `${steering}\n\n${base}`;
}

function renderFeishuReferenceContext(message: SessionMessage): string {
  const context = message.feishuReferenceContext;
  if (!context) return "";
  const scopeLabel = context.scope === "thread" ? "thread" : "chat";
  const header = `[Earlier in Feishu ${scopeLabel} — reference context, not complete history]`;
  const lines = [header];
  if (context.state === "unavailable") {
    lines.push("Earlier Feishu context could not be loaded");
  } else {
    const messageLines = context.messages.map((item) => {
      const senderName = item.senderName.replace(/[\r\n]+/g, " ").trim() || "Feishu user";
      return `[From: ${senderName} · sent=${item.sentAt}] ${item.content}`;
    });
    const fitted = fitFeishuReferenceLines(header, messageLines, context.truncated);
    lines.push(...fitted.lines);
    if (fitted.truncated) lines.push("[Only the most recent bounded Feishu context is shown]");
  }
  return `${lines.join("\n")}\n\n`;
}

const MAX_FEISHU_REFERENCE_CONTEXT_BYTES = 64 * 1024;
const FEISHU_REFERENCE_TRUNCATED_LINE = "[Only the most recent bounded Feishu context is shown]";

function fitFeishuReferenceLines(
  header: string,
  messageLines: string[],
  providerTruncated: boolean,
): { lines: string[]; truncated: boolean } {
  const render = (lines: string[], truncated: boolean) =>
    `${header}\n${lines.join("\n")}${lines.length > 0 ? "\n" : ""}${truncated ? `${FEISHU_REFERENCE_TRUNCATED_LINE}\n` : ""}\n`;
  if (Buffer.byteLength(render(messageLines, providerTruncated), "utf8") <= MAX_FEISHU_REFERENCE_CONTEXT_BYTES) {
    return { lines: messageLines, truncated: providerTruncated };
  }

  const keptNewestFirst: string[] = [];
  for (let index = messageLines.length - 1; index >= 0; index -= 1) {
    const candidate = [messageLines[index] as string, ...keptNewestFirst];
    if (Buffer.byteLength(render(candidate, true), "utf8") > MAX_FEISHU_REFERENCE_CONTEXT_BYTES) {
      if (keptNewestFirst.length === 0) {
        const codePoints = Array.from(messageLines[index] as string);
        let low = 0;
        let high = codePoints.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          const shortened = `${codePoints.slice(0, middle).join("")}…`;
          if (Buffer.byteLength(render([shortened], true), "utf8") <= MAX_FEISHU_REFERENCE_CONTEXT_BYTES) {
            low = middle;
          } else {
            high = middle - 1;
          }
        }
        keptNewestFirst.push(`${codePoints.slice(0, low).join("")}…`);
      }
      break;
    }
    keptNewestFirst.unshift(messageLines[index] as string);
  }
  return { lines: keptNewestFirst, truncated: true };
}
