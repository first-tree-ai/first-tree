import { SdkError } from "@first-tree/client";
import type { MessageFormat } from "@first-tree/shared";
import type { Command } from "commander";
import { fail, success } from "../../cli/output.js";
import { captureOutboundDocs } from "../../core/doc-capture.js";
import { checkFeishuChatContext } from "../../core/feishu-chat-context.js";
import { createSdk, handleSdkError } from "../_shared/local-agent.js";
import { guardInlineDescription, readStdin } from "./_shared/io.js";
import { buildRequestMetadata } from "./_shared/request.js";

interface CreateOptions {
  to?: string[];
  with?: string[];
  topic?: string;
  description?: string;
  format: MessageFormat;
  metadata?: string;
  agent?: string;
  request?: boolean;
  options?: string;
  multiSelect?: boolean;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function handleCreateError(error: unknown): never {
  if (error instanceof SdkError && error.statusCode >= 500) {
    fail(
      "CREATE_RESULT_UNKNOWN",
      "The server returned an error after the create request was sent. The chat may already exist. " +
        "Check `chat list` or the Web UI before running `chat create` again; this command is not idempotent.",
      6,
    );
  }
  if (isUncertainNetworkError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    fail(
      "CREATE_RESULT_UNKNOWN",
      `The create request result is unknown (${message}). The chat may already exist. ` +
        "Check `chat list` or the Web UI before running `chat create` again; this command is not idempotent.",
      6,
    );
  }
  handleSdkError(error);
}

function isUncertainNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  if (error instanceof TypeError && "cause" in error) return true;
  let current: unknown = "cause" in error ? error.cause : undefined;
  let depth = 0;
  while (current && typeof current === "object" && depth < 5) {
    const obj = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (obj.name === "AbortError" || obj.name === "TimeoutError") return true;
    if (
      typeof obj.code === "string" &&
      ["ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(obj.code)
    ) {
      return true;
    }
    current = obj.cause;
    depth++;
  }
  return false;
}

function parseFormat(value: string): MessageFormat {
  if (value === "text" || value === "markdown" || value === "card") {
    return value;
  }
  fail("INVALID_FORMAT", "Format must be one of: text, markdown, card.", 2);
}

export function registerChatCreateCommand(chat: Command): void {
  chat
    .command("create [message]")
    .description(
      "Create a separate task chat and send its first message. --to recipients are mentioned and woken; --with " +
        "participants are added for context without being woken by the first message. Only an agent recipient can " +
        "start working: a chat whose only --to is a human sits idle until they reply, while --to <your own agent " +
        "name> wakes you in the new chat (the server rewrites the opening message's sender to your manager). This " +
        "command does not create empty chats and is not idempotent. For same-task agent handoffs, use `chat invite` " +
        "in the current chat.",
    )
    .option(
      "--to <name>",
      "Initial recipient to @mention and wake; a human recipient is notified but starts no work; repeatable",
      collect,
      [],
    )
    .option("--with <name>", "Context participant to add without waking on the first message; repeatable", collect, [])
    .option("--topic <text>", "Stable chat topic")
    .option("--description <text>", "Current-state chat description")
    .option("-f, --format <format>", "Initial message format (text|markdown|card)", "text")
    .option("-m, --metadata <json>", "JSON metadata to attach; routing/provenance keys are controlled by the server")
    .option("--agent <name>", "Agent name on the First Tree server (default: first configured on this client)")
    .option(
      "--request",
      "Create the task with an open question. Requires exactly one --to human; the message body IS the ask and " +
        "must be decision-self-sufficient for a human who remembers nothing of the work — (1) why this question " +
        "exists, (2) a recap of the interactions that led here, (3) the single question plus your recommendation — " +
        "written for a reader holding none of the context (unpack every shorthand; name options by their concrete " +
        "consequence).",
    )
    .option(
      "--options <json>",
      "Answer options as a JSON array, 2–4 items of {label (1–5 words), description, preview?} (with --request)",
    )
    .option("--multi-select", "Allow picking more than one option (with --request; requires --options)")
    .action(async (message: string | undefined, options: CreateOptions) => {
      try {
        const to = options.to ?? [];
        if (to.length === 0) {
          fail("NO_TARGET", "Pass at least one --to <name> recipient.", 2);
        }

        const content = message ?? (await readStdin());
        if (!content || content.trim().length === 0) {
          fail("NO_MESSAGE", "No message provided. Pass as argument or pipe via stdin.", 2);
        }

        // The initial message already consumes stdin, so `--description` is
        // inline-only here: reject a literal `\n`-escaped value before the
        // chat is created (the hint points to ANSI-C `$'...'` quoting).
        if (options.description !== undefined) {
          guardInlineDescription(options.description, { supportsStdin: false });
        }

        let metadata: Record<string, unknown> | undefined;
        if (options.metadata) {
          try {
            metadata = JSON.parse(options.metadata) as Record<string, unknown>;
          } catch {
            fail("INVALID_METADATA", "Metadata must be valid JSON.", 2);
          }
        }

        let format = parseFormat(options.format);
        if (options.request === true) {
          if (to.length !== 1) {
            fail("REQUEST_NEEDS_ONE_TARGET", "--request task creation requires exactly one --to recipient.", 2);
          }
          format = "request";
          metadata = buildRequestMetadata(metadata, options);
        }

        const sdk = createSdk(options.agent);

        // The server cannot enforce this one: `POST /agent/chats` never
        // receives the originating chat. Refuse client-side so a Feishu-bound
        // session does not spawn a First Tree chat its humans cannot see.
        //
        // The origin lookup deliberately runs under the SESSION identity
        // (`createSdk()` resolves from FIRST_TREE_AGENT_ID), never under
        // `--agent`. `--agent` picks who creates the new chat; it must not pick
        // who answers "is the chat I am sitting in bridged?" — an overridden
        // agent that is not a member of the origin chat gets a 403, and reading
        // that as "not a Feishu chat" was a straight bypass of this refusal.
        // Requiring the session agent here also keeps an unrelated agent's
        // membership from becoming a precondition for ordinary creates.
        //
        // The whole decision lives in `checkFeishuChatContext`: no chat id at
        // all is an operator terminal and proceeds without a lookup, while a
        // chat id whose bridged-ness cannot be established — no session agent
        // to read it as, an unreachable or older server, an unrecognised
        // value — refuses. A half-configured environment must not be the
        // cheapest way past the guard.
        const refusal = await checkFeishuChatContext(
          () => createSdk(),
          { chatId: process.env.FIRST_TREE_CHAT_ID, agentId: process.env.FIRST_TREE_AGENT_ID },
          "create",
        );
        if (refusal) fail(refusal.code, refusal.message, 2);

        // KNOWN GAP (follow-up #1069), out of scope for this PR: no chat exists
        // yet, so the upload org can't be resolved from a chat — doc capture is a
        // pass-through for `chat create`'s initial message (doc mentions render as
        // plain text). Subsequent `chat send` captures normally.
        const captured = await captureOutboundDocs(content, { sdk });
        const outboundMetadata =
          captured.attachments || captured.documentContext
            ? {
                ...(metadata ?? {}),
                ...(captured.attachments ? { attachments: captured.attachments } : {}),
                ...(captured.documentContext ? { documentContext: captured.documentContext } : {}),
              }
            : metadata;
        const result = await sdk.createTaskChat({
          mode: "task",
          initialRecipientAgentIds: [],
          initialRecipientNames: to,
          contextParticipantAgentIds: [],
          contextParticipantNames: options.with ?? [],
          ...(options.topic ? { topic: options.topic } : {}),
          ...(options.description ? { description: options.description } : {}),
          initialMessage: {
            format,
            content: captured.content,
            ...(outboundMetadata ? { metadata: outboundMetadata } : {}),
            source: "cli",
          },
        });
        success(result);
      } catch (error) {
        handleCreateError(error);
      }
    });
}
