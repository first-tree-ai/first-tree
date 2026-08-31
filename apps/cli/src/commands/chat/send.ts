import { CLI_BODY_ORIGIN_METADATA_KEY, CLI_BODY_ORIGINS, type MessageFormat } from "@first-tree/shared";
import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { channelConfig } from "../../core/channel.js";
import { captureOutboundDocs } from "../../core/doc-capture.js";
import { captureOutboundImages, toOutboundImageMessage } from "../../core/image-capture.js";
import { print } from "../../core/output.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import { guardInlineShellResidue, looksLikeEscapedNewlineBody, readMessageBody, readStdin } from "./_shared/io.js";

interface SendOptions {
  format: MessageFormat;
  metadata?: string;
  agent?: string;
  replyTo?: string;
  messageFile?: string;
}

export function registerChatSendCommand(chat: Command): void {
  chat
    .command("send [name] [message]")
    .description(
      "Send a message into the caller's current chat (FIRST_TREE_CHAT_ID). <name> is any participant — agent or " +
        "human; the recipient is @mentioned and notified — an agent recipient is woken, a human is not (the " +
        "recipient must already be a participant — `chat invite` an agent first). " +
        "A plain send to a human is informational only — a free reply or report they can read and move " +
        "on from; any question your next step depends on goes through `chat ask` (a send never carries a " +
        "blocking question). Report progress with `chat update --description`. A message must name a recipient " +
        "— there is no no-mention send. The body can be the [message] argument, piped via stdin (omit " +
        "[message]), or read from a file with --message-file <path> (`-` = stdin); prefer stdin or --message-file " +
        "for any rich or multi-line body so the shell cannot mangle backticks, quotes, or newlines.",
    )
    .option("-f, --format <format>", "Message format (text|markdown|card)", "text")
    .option("-m, --metadata <json>", "JSON metadata to attach")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .option(
      "--reply-to <messageId>",
      "Thread a reply under a message — sets inReplyTo (pure threading; does NOT resolve a question)",
    )
    .option(
      "-F, --message-file <path>",
      "Read the message body from <path> (or `-` for stdin) instead of the [message] argument. Preferred for any " +
        "rich or multi-line body: the content never passes through the shell, so backticks, quotes, and newlines " +
        "are sent verbatim. This reads only the message body; it does not attach <path>.",
    )
    .addHelpText(
      "after",
      [
        "",
        "Attachment capture (agent sessions; best-effort and body-reference based):",
        "  Images      Embed `![alt](path)` for PNG/JPEG/GIF/WebP files inside the sending agent's own workspace",
        "              (10 MiB each, up to 20 images per message).",
        "  Documents   Reference a workspace `.md` path (10 MiB each, up to 10 documents per message).",
        "  Other       Other outbound file types are not captured by `chat send`.",
        "",
      ].join("\n"),
    )
    .action(async (name: string | undefined, message: string | undefined, options: SendOptions) => {
      try {
        const chatId = process.env.FIRST_TREE_CHAT_ID;
        if (!chatId) {
          fail(
            "NO_CHAT_CONTEXT",
            "`chat send` must be run from within an agent session that exports FIRST_TREE_CHAT_ID. " +
              "First Tree keeps a single group-chat model — there is no implicit direct chat to fall back to. " +
              "To send from a shell, open the chat in the web UI instead.",
            2,
          );
        }

        // Every send names a recipient: the first positional is the target,
        // the second is the message body.
        const target = name;
        const inlineBody = message;

        if (!target) {
          fail(
            "NO_TARGET",
            "Pass <name> to @mention a recipient — a message must name a recipient (there is no no-mention send).",
            2,
          );
        }

        // --message-file (a path, or `-` for stdin) is the shell-safe path for
        // a rich body; it cannot also take an inline [message].
        if (options.messageFile !== undefined && inlineBody !== undefined) {
          fail(
            "CONFLICTING_ARGS",
            "Pass the message body either inline as [message] or via --message-file, not both.",
            2,
          );
        }

        // Reject an inline body whose newlines are the two-character escape
        // `\n` — shell quotes do not expand it, so the row would render as
        // one long unformatted line. Stdin bodies are never checked: piping
        // is both the fix and the escape hatch for intentional literal `\n`.
        if (inlineBody !== undefined && looksLikeEscapedNewlineBody(inlineBody)) {
          print.line(
            "chat send: the message body arrived with literal \\n escapes — shell quotes do not expand \\n, " +
              "so it would render as one long unformatted line. Resend with real newlines via stdin:\n\n" +
              `  cat <<'EOF' | ${channelConfig.binName} chat send <name> -f markdown\n` +
              "  first line\n" +
              "\n" +
              "  **second** line\n" +
              "  EOF\n\n" +
              "(stdin is not checked — pipe the body if the literal \\n text is intentional.)\n\n",
          );
          fail(
            "ESCAPED_NEWLINES",
            'Inline message body contains literal "\\n" escapes and no real newlines — it would render as one ' +
              "long unformatted line. Resend the body via stdin/heredoc with real newlines (copyable form " +
              "printed above; stdin is not checked, so it also sends intentional literal \\n text).",
            2,
          );
        }

        // Catch the two shell-residue shapes the CLI can still recognise in an
        // inline body: a collapsed-heredoc delimiter (`@EOF`) and a
        // JSON.stringify wrapper. Inline-only — `-F`/stdin is never checked.
        if (inlineBody !== undefined) {
          guardInlineShellResidue(inlineBody, { command: "send" });
        }

        const content =
          options.messageFile !== undefined
            ? await readMessageBody(options.messageFile)
            : (inlineBody ?? (await readStdin()));
        if (!content) {
          fail(
            "NO_MESSAGE",
            "No message provided. Pass it as the [message] argument, pipe it via stdin, or use --message-file <path>.",
            2,
          );
        }

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

        const sdk = createSdk(options.agent);

        // L3: capture any `.md` this message references, exactly like the
        // runtime's result-sink does for final-text — uploading to the org
        // attachment store and attaching generic refs. Pure pass-through
        // outside an agent session.
        const captured = await captureOutboundDocs(content ?? "", { sdk, chatId });

        // Capture workspace images the (doc-rewritten) body references and, when
        // any resolve, convert this into a human-identical image send: a
        // `format: "file"` batch whose caption is the image-stripped body and
        // whose attachments are the uploaded refs. Only text/markdown bodies are
        // eligible — a `card` body is not an image batch. Pure pass-through
        // otherwise.
        const imageEligible = options.format === "text" || options.format === "markdown";
        const capturedImages = imageEligible
          ? await captureOutboundImages(captured.content, { sdk, chatId })
          : { caption: captured.content, imageRefs: [] };
        const { format: outboundFormat, content: outboundContent } = toOutboundImageMessage(
          options.format,
          captured.content,
          capturedImages,
        );

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
          captured.attachments || captured.documentContext
            ? {
                ...(metadataWithBodyOrigin ?? {}),
                ...(captured.attachments ? { attachments: captured.attachments } : {}),
                ...(captured.documentContext ? { documentContext: captured.documentContext } : {}),
              }
            : metadataWithBodyOrigin;

        const result = await sdk.sendMessage(chatId, {
          format: outboundFormat,
          content: outboundContent,
          metadata: outboundMetadata,
          source: "cli",
          // Server resolves the name against the chat's participant list and
          // adds it to mentions — agent or human; an unknown name fails with a
          // `chat invite` hint.
          ...(target ? { receiverNames: [target] } : {}),
          ...(options.replyTo ? { inReplyTo: options.replyTo } : {}),
        });
        success(result);
      } catch (error) {
        handleSdkError(error);
      }
    });
}
