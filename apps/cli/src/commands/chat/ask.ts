import {
  type AttachmentRef,
  attachmentRefSchema,
  CLI_BODY_ORIGIN_METADATA_KEY,
  CLI_BODY_ORIGINS,
  MAX_MESSAGE_ATTACHMENT_REFS,
  type MessageFormat,
} from "@first-tree/shared";
import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { channelConfig } from "../../core/channel.js";
import { captureOutboundDocs } from "../../core/doc-capture.js";
import { captureOutboundImages, toGenericImageAttachmentRefs } from "../../core/image-capture.js";
import { print } from "../../core/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import { guardInlineShellResidue, looksLikeEscapedNewlineBody, readMessageBody, readStdin } from "./_shared/io.js";
import { buildRequestMetadata } from "./_shared/request.js";

interface AskOptions {
  format: MessageFormat;
  metadata?: string;
  agent?: string;
  options?: string;
  multiSelect?: boolean;
  messageFile?: string;
}

/**
 * Write-side reader for caller-supplied attachment metadata. Render paths are
 * intentionally tolerant of malformed history, but a new send must fail
 * closed instead of silently dropping bad entries while merging captures.
 */
function readOutboundAttachmentRefs(metadata: Record<string, unknown> | undefined): AttachmentRef[] {
  const raw = metadata?.attachments;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    fail("INVALID_METADATA", "metadata.attachments must be an array of attachment references.", 2);
  }
  if (raw.length > MAX_MESSAGE_ATTACHMENT_REFS) {
    fail(
      "INVALID_METADATA",
      `metadata.attachments exceeds the per-message limit of ${MAX_MESSAGE_ATTACHMENT_REFS}.`,
      2,
    );
  }
  return raw.map((entry, index) => {
    const parsed = attachmentRefSchema.safeParse(entry);
    if (!parsed.success) {
      fail("INVALID_METADATA", `metadata.attachments[${index}] is not a valid attachment reference.`, 2);
    }
    return parsed.data;
  });
}

export function registerChatAskCommand(chat: Command): void {
  chat
    .command("ask [name] [message]")
    .description(
      "Ask a HUMAN in the caller's current chat (FIRST_TREE_CHAT_ID) a tracked question — a decision, approval, or " +
        "answer. Every question you put to a human goes through `chat ask` — whether or not your next step is " +
        "blocked on it, and including an optional offer or a one-line confirmation — never a plain `chat send`. " +
        "Writes " +
        "an open question (format=request) directed at a single human <name>: the message body IS the ask, and it " +
        "must be decision-self-sufficient for a human who remembers nothing of this chat — (1) why this question " +
        "exists, (2) a recap of the recent interactions, (3) the single question plus your recommendation — written " +
        "for a reader holding none of the context (unpack every shorthand; name options by their concrete " +
        "consequence). Omit " +
        "--options for a free-text answer, or pass 2–4 --options for a choice. Raises a tracked red dot and blocks " +
        "the chat for them until they answer. The human resolves it in the web UI — an agent can only ASK; it " +
        "cannot answer or close a question. The body can be the [message] argument, piped via stdin (omit " +
        "[message]), or read from a file with --message-file <path> (`-` = stdin); prefer stdin or --message-file " +
        "for any rich or multi-line body so the shell cannot mangle backticks, quotes, or newlines.",
    )
    .option("-f, --format <format>", "Message format (text|markdown|card)", "text")
    .option("-m, --metadata <json>", "JSON metadata to attach")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .option(
      "-F, --message-file <path>",
      "Read the ask body from <path> (or `-` for stdin) instead of the [message] argument. Preferred for any rich " +
        "or multi-line body: the content never passes through the shell, so backticks, quotes, and newlines are " +
        "sent verbatim.",
    )
    .option(
      "--options <json>",
      "Answer options as a JSON array, 2–4 items of {label (1–5 words), description, preview?}. e.g. " +
        `'[{"label":"Ship","description":"Roll to 20% now"},{"label":"Hold","description":"Wait 24h"}]'`,
    )
    .option("--multi-select", "Allow picking more than one option (requires --options)")
    .action(async (name: string | undefined, message: string | undefined, options: AskOptions) => {
      try {
        const chatId = process.env.FIRST_TREE_CHAT_ID;
        if (!chatId) {
          fail(
            "NO_CHAT_CONTEXT",
            "`chat ask` must be run from within an agent session that exports FIRST_TREE_CHAT_ID. " +
              "To ask from a shell, open the chat in the web UI instead.",
            2,
          );
        }

        const target = name;
        const inlineBody = message;

        if (!target) {
          fail("NO_TARGET", "Pass <name> to direct the question at a single human member.", 2);
        }

        // --message-file (a path, or `-` for stdin) is the shell-safe path for
        // a rich body; it cannot also take an inline [message].
        if (options.messageFile !== undefined && inlineBody !== undefined) {
          fail("CONFLICTING_ARGS", "Pass the ask body either inline as [message] or via --message-file, not both.", 2);
        }

        // Reject an inline body whose newlines are the two-character escape
        // `\n` — shell quotes do not expand it, so the row would render as one
        // long unformatted line. Stdin bodies are never checked.
        if (inlineBody !== undefined && looksLikeEscapedNewlineBody(inlineBody)) {
          print.line(
            "chat ask: the message body arrived with literal \\n escapes — shell quotes do not expand \\n, " +
              "so it would render as one long unformatted line. Resend with real newlines via stdin:\n\n" +
              `  cat <<'EOF' | ${channelConfig.binName} chat ask <name> -f markdown\n` +
              "  background / context line\n" +
              "  EOF\n\n" +
              "(stdin is not checked — pipe the body if the literal \\n text is intentional.)\n\n",
          );
          fail(
            "ESCAPED_NEWLINES",
            'Inline message body contains literal "\\n" escapes and no real newlines — it would render as one ' +
              "long unformatted line. Resend the body via stdin/heredoc with real newlines.",
            2,
          );
        }

        // Catch the two shell-residue shapes the CLI can still recognise in an
        // inline body: a collapsed-heredoc delimiter (`@EOF`) and a
        // JSON.stringify wrapper. Inline-only — `-F`/stdin is never checked.
        if (inlineBody !== undefined) {
          guardInlineShellResidue(inlineBody, { command: "ask" });
        }

        const content =
          options.messageFile !== undefined
            ? await readMessageBody(options.messageFile)
            : (inlineBody ?? (await readStdin()));

        let metadata: Record<string, unknown> | undefined;
        if (options.metadata) {
          try {
            metadata = JSON.parse(options.metadata) as Record<string, unknown>;
          } catch {
            fail("INVALID_METADATA", "Metadata must be valid JSON.", 2);
          }
          if (metadata && typeof metadata === "object" && CLI_BODY_ORIGIN_METADATA_KEY in metadata) {
            metadata = Object.fromEntries(
              Object.entries(metadata).filter(([key]) => key !== CLI_BODY_ORIGIN_METADATA_KEY),
            );
          }
        }

        // `chat ask` only ASKS. The body IS the ask — decision-self-sufficient:
        // why the question exists + a recap of recent interactions + the single
        // question and recommendation. `--options` (2–4) adds a choice, omit
        // them for a free-text answer. There is no resolve path here — the
        // human answers in the web UI; an agent cannot mark a question
        // answered or close it.
        if (!content) {
          fail(
            "ASK_NEEDS_BODY",
            "`chat ask` needs a message body — the body is the ask (why the question exists + a recap of recent " +
              "interactions + the single question and your recommendation). " +
              "Pass it as the [message] argument, via stdin, or with --message-file <path>.",
            2,
          );
        }
        const format: MessageFormat = "request";
        metadata = buildRequestMetadata(metadata, options);
        const existingAttachments = readOutboundAttachmentRefs(metadata);

        const sdk = createSdk(options.agent);

        const captured = await captureOutboundDocs(content ?? "", {
          sdk,
          chatId,
          maxAttachments: MAX_MESSAGE_ATTACHMENT_REFS - existingAttachments.length,
        });
        const documentAttachments = captured.attachments ?? [];
        const imageCapacity = Math.max(
          0,
          MAX_MESSAGE_ATTACHMENT_REFS - existingAttachments.length - documentAttachments.length,
        );
        const capturedImages = await captureOutboundImages(captured.content, {
          sdk,
          chatId,
          maxAttachments: imageCapacity,
        });
        const imageAttachments = toGenericImageAttachmentRefs(capturedImages.imageRefs);
        const outboundAttachments = [...existingAttachments, ...documentAttachments, ...imageAttachments];
        const outboundContent = imageAttachments.length > 0 ? capturedImages.caption : captured.content;
        const cliBodyOrigin =
          options.messageFile !== undefined
            ? CLI_BODY_ORIGINS.MESSAGE_FILE
            : inlineBody === undefined
              ? CLI_BODY_ORIGINS.STDIN
              : undefined;
        const metadataWithBodyOrigin =
          cliBodyOrigin !== undefined
            ? { ...(metadata ?? {}), [CLI_BODY_ORIGIN_METADATA_KEY]: cliBodyOrigin }
            : metadata;
        const outboundMetadata =
          outboundAttachments.length > 0 || captured.documentContext
            ? {
                ...(metadataWithBodyOrigin ?? {}),
                ...(outboundAttachments.length > 0 ? { attachments: outboundAttachments } : {}),
                ...(captured.documentContext ? { documentContext: captured.documentContext } : {}),
              }
            : metadataWithBodyOrigin;

        // `chat ask` always opens a fresh top-level question; it does not thread
        // under another message (no `inReplyTo`).
        const result = await sdk.sendMessage(chatId, {
          format,
          content: outboundContent,
          metadata: outboundMetadata,
          source: "cli",
          ...(target ? { receiverNames: [target] } : {}),
        });
        success(result);
      } catch (error) {
        handleSdkError(error);
      }
    });
}
