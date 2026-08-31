import { EventEmitter } from "node:events";

import { SdkError } from "@first-tree/client";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bootstrapMocks = vi.hoisted(() => ({
  ensureFreshAccessToken: vi.fn(),
  resolveServerUrl: vi.fn(),
}));

const cliFetchMock = vi.hoisted(() => vi.fn());

const resolveAgentMock = vi.hoisted(() => vi.fn());

const localAgentMocks = vi.hoisted(() => ({
  createSdk: vi.fn(),
  handleSdkError: vi.fn((error: unknown) => {
    throw error;
  }),
}));

const docCaptureMock = vi.hoisted(() => ({
  captureOutboundDocs: vi.fn(),
}));

const imageCaptureMock = vi.hoisted(() => ({
  captureOutboundImages: vi.fn(),
}));

const ioMocks = vi.hoisted(() => ({
  readStdin: vi.fn(),
}));

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
  success: vi.fn(),
}));

const printLineMock = vi.hoisted(() => vi.fn());

const readlineMocks = vi.hoisted(() => ({
  createInterface: vi.fn(),
}));

vi.mock("../core/bootstrap.js", () => bootstrapMocks);
vi.mock("../core/cli-fetch.js", () => ({ cliFetch: cliFetchMock }));
vi.mock("../commands/_shared/resolve-agent.js", () => ({ resolveAgent: resolveAgentMock }));
vi.mock("../commands/_shared/local-agent.js", () => localAgentMocks);
vi.mock("../core/doc-capture.js", () => docCaptureMock);
vi.mock("../core/image-capture.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/image-capture.js")>()),
  captureOutboundImages: imageCaptureMock.captureOutboundImages,
}));
vi.mock("../commands/chat/_shared/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/chat/_shared/io.js")>()),
  readStdin: ioMocks.readStdin,
}));
vi.mock("../cli/output.js", () => outputMocks);
vi.mock("../core/output.js", () => ({
  print: { line: printLineMock, result: outputMocks.success, fail: outputMocks.fail },
}));
vi.mock("node:readline", () => readlineMocks);

const originalChatId = process.env.FIRST_TREE_CHAT_ID;
const originalExit = process.exit;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn(async () => body),
    text: vi.fn(async () => (typeof body === "string" ? body : JSON.stringify(body))),
  } as unknown as Response;
}

async function runChat(args: string[]): Promise<void> {
  const { registerChatCommands } = await import("../commands/chat/index.js");
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  registerChatCommands(program);
  await program.parseAsync(["node", "test", "chat", ...args]);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FIRST_TREE_CHAT_ID = "chat-env";
  bootstrapMocks.ensureFreshAccessToken.mockResolvedValue("user-token");
  bootstrapMocks.resolveServerUrl.mockReturnValue("https://hub.example");
  resolveAgentMock.mockResolvedValue({ uuid: "agent-1", name: "nova", displayName: "Nova" });
  docCaptureMock.captureOutboundDocs.mockImplementation(async (content: string) => ({ content }));
  imageCaptureMock.captureOutboundImages.mockImplementation(async (content: string) => ({
    caption: content,
    imageRefs: [],
  }));
  ioMocks.readStdin.mockResolvedValue("stdin message");
  localAgentMocks.createSdk.mockReturnValue({
    agentId: "agent-self",
    attention: { raise: vi.fn() },
    createTaskChat: vi.fn(async () => ({
      chatId: "chat-created",
      messageId: "msg-created",
      initialRecipientAgentIds: ["agent-1"],
      contextParticipantAgentIds: [],
      effectiveSenderId: "agent-self",
    })),
    sendMessage: vi.fn(async () => ({ id: "msg-1" })),
    archiveChat: vi.fn(async (chatId: string) => ({ chatId, engagementStatus: "archived" })),
    updateChat: vi.fn(async (_chatId: string, patch: unknown) => {
      const patchObject = patch && typeof patch === "object" ? patch : {};
      return { id: "chat-1", ...patchObject };
    }),
  });
  process.exit = vi.fn(((code?: number) => {
    throw Object.assign(new Error("process.exit"), { code });
  }) as never);
});

afterEach(() => {
  if (originalChatId === undefined) {
    delete process.env.FIRST_TREE_CHAT_ID;
  } else {
    process.env.FIRST_TREE_CHAT_ID = originalChatId;
  }
  process.exit = originalExit;
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
});

describe("chat command behavior", () => {
  it("keeps outbound attachment capture discoverable in `chat send --help`", async () => {
    const { registerChatCommands } = await import("../commands/chat/index.js");
    const program = new Command();
    registerChatCommands(program);
    const chat = program.commands.find((command) => command.name() === "chat");
    const send = chat?.commands.find((command) => command.name() === "send");
    let output = "";
    send?.configureOutput({
      writeOut: (text) => {
        output += text;
      },
      writeErr: (text) => {
        output += text;
      },
    });
    send?.outputHelp();
    const help = output.replace(/\s+/gu, " ");

    expect(help).toContain("This reads only the message body; it does not attach <path>");
    expect(help).toContain("Attachment capture (agent sessions; best-effort and body-reference based)");
    expect(help).toContain("best-effort and body-reference based");
    expect(help).toContain("PNG/JPEG/GIF/WebP");
    expect(help).toContain("sending agent's own workspace");
    expect(help).toContain("10 MiB each, up to 20 images per message");
    expect(help).toContain("workspace `.md` path");
    expect(help).toContain("10 MiB each, up to 10 documents per message");
    expect(help).toContain("Other outbound file types are not captured");
    // Who a send actually wakes: an agent recipient starts a session, a human
    // is only notified. The sentence had no coverage and shipped with a
    // duplicated "first)." fragment before this assertion existed.
    expect(help).toContain("an agent recipient is woken, a human is not");
    expect(help).toContain("a send never carries a question");
    expect(help).toContain("settled and reported, not asked");
    expect(help).toContain("`chat invite` an agent first). A plain send to a human is informational only");
    expect(help).not.toMatch(/first\)\. first\)\./u);
  });

  it("sends messages with metadata, stdin fallback, document context, and validation errors", async () => {
    docCaptureMock.captureOutboundDocs.mockResolvedValueOnce({
      content: "see docs/plan.md",
      documentContext: [{ path: "docs/plan.md", content: "Plan" }],
    });
    const sdk = localAgentMocks.createSdk();
    await runChat(["send", "nova", "see docs/plan.md", "--metadata", '{"priority":2}', "--format", "markdown"]);

    expect(sdk.sendMessage).toHaveBeenCalledWith("chat-env", {
      format: "markdown",
      content: "see docs/plan.md",
      metadata: { priority: 2, documentContext: [{ path: "docs/plan.md", content: "Plan" }] },
      source: "cli",
      receiverNames: ["nova"],
    });
    expect(outputMocks.success).toHaveBeenCalledWith({ id: "msg-1" });

    await runChat(["send", "nova"]);
    expect(sdk.sendMessage).toHaveBeenLastCalledWith("chat-env", expect.objectContaining({ content: "stdin message" }));

    delete process.env.FIRST_TREE_CHAT_ID;
    await expect(runChat(["send", "nova", "hello"])).rejects.toMatchObject({ code: "NO_CHAT_CONTEXT", exitCode: 2 });

    process.env.FIRST_TREE_CHAT_ID = "chat-env";
    await expect(runChat(["send"])).rejects.toMatchObject({ code: "NO_TARGET", exitCode: 2 });
    await expect(runChat(["send", "nova", "hello", "--message-file", "-"])).rejects.toMatchObject({
      code: "CONFLICTING_ARGS",
      exitCode: 2,
    });

    await expect(runChat(["send", "nova", "hello", "--metadata", "{bad"])).rejects.toMatchObject({
      code: "INVALID_METADATA",
      exitCode: 2,
    });

    ioMocks.readStdin.mockResolvedValueOnce(null);
    await expect(runChat(["send", "nova"])).rejects.toMatchObject({ code: "NO_MESSAGE", exitCode: 2 });
  });

  it("chat send merges captured metadata without caller metadata and continues through defensive fail fallbacks", async () => {
    const sdk = localAgentMocks.createSdk();

    docCaptureMock.captureOutboundDocs.mockResolvedValueOnce({
      content: "attachment only",
      attachments: [{ kind: "doc", id: "doc-attachment" }],
    });
    await runChat(["send", "nova", "attachment only"]);
    expect(sdk.sendMessage).toHaveBeenLastCalledWith(
      "chat-env",
      expect.objectContaining({
        metadata: { attachments: [{ kind: "doc", id: "doc-attachment" }] },
      }),
    );

    docCaptureMock.captureOutboundDocs.mockResolvedValueOnce({
      content: "context only",
      documentContext: [{ path: "docs/context.md", content: "Context" }],
    });
    await runChat(["send", "nova", "context only"]);
    expect(sdk.sendMessage).toHaveBeenLastCalledWith(
      "chat-env",
      expect.objectContaining({
        metadata: { documentContext: [{ path: "docs/context.md", content: "Context" }] },
      }),
    );

    outputMocks.fail.mockImplementationOnce(() => undefined as never);
    await runChat(["send"]);
    expect(sdk.sendMessage).toHaveBeenLastCalledWith(
      "chat-env",
      expect.objectContaining({ content: "stdin message", source: "cli" }),
    );
    expect(sdk.sendMessage).toHaveBeenLastCalledWith(
      "chat-env",
      expect.not.objectContaining({ receiverNames: expect.any(Array) }),
    );

    outputMocks.fail.mockImplementationOnce(() => undefined as never);
    ioMocks.readStdin.mockResolvedValueOnce(null);
    docCaptureMock.captureOutboundDocs.mockResolvedValueOnce({ content: "" });
    await runChat(["send", "nova"]);
    expect(docCaptureMock.captureOutboundDocs).toHaveBeenCalledWith(
      "",
      expect.objectContaining({ chatId: "chat-env" }),
    );
  });

  it("chat ask sends an open question with the body as the ask and JSON --options", async () => {
    const sdk = localAgentMocks.createSdk();
    await runChat([
      "ask",
      "nova",
      "Rollout at 5%, error flat 24h — ship to 20%?",
      "--options",
      JSON.stringify([
        { label: "Ship", description: "Roll to 20% now" },
        { label: "Hold", description: "Wait another 24h" },
      ]),
    ]);

    expect(sdk.sendMessage).toHaveBeenCalledWith(
      "chat-env",
      expect.objectContaining({
        format: "request",
        content: "Rollout at 5%, error flat 24h — ship to 20%?",
        receiverNames: ["nova"],
        metadata: expect.objectContaining({
          request: {
            options: [
              { label: "Ship", description: "Roll to 20% now" },
              { label: "Hold", description: "Wait another 24h" },
            ],
          },
        }),
      }),
    );
  });

  it("chat ask without --options is a free-text ask (empty request payload)", async () => {
    const sdk = localAgentMocks.createSdk();
    await runChat(["ask", "nova", "What's the rollback window?"]);
    expect(sdk.sendMessage).toHaveBeenCalledWith(
      "chat-env",
      expect.objectContaining({
        format: "request",
        content: "What's the rollback window?",
        metadata: expect.objectContaining({ request: {} }),
      }),
    );
  });

  it("chat ask preserves request semantics when image capture returns refs", async () => {
    const sdk = localAgentMocks.createSdk();
    const imageRef = {
      imageId: "11111111-1111-4111-8111-111111111111",
      mimeType: "image/png",
      filename: "decision.png",
      size: 42,
    };
    imageCaptureMock.captureOutboundImages.mockResolvedValueOnce({
      caption: "Which layout should ship?",
      imageRefs: [imageRef],
    });

    await runChat(["ask", "nova", "Which layout should ship?\n\n![layout](output/decision.png)"]);

    expect(imageCaptureMock.captureOutboundImages).toHaveBeenCalledWith(
      "Which layout should ship?\n\n![layout](output/decision.png)",
      expect.objectContaining({ chatId: "chat-env", maxAttachments: 10 }),
    );
    expect(sdk.sendMessage).toHaveBeenLastCalledWith(
      "chat-env",
      expect.objectContaining({
        format: "request",
        content: "Which layout should ship?",
        metadata: expect.objectContaining({
          attachments: [
            {
              attachmentId: imageRef.imageId,
              kind: "image",
              mimeType: "image/png",
              filename: "decision.png",
              size: 42,
            },
          ],
        }),
      }),
    );
  });

  it("chat ask shares one attachment budget across caller refs, documents, and images", async () => {
    const sdk = localAgentMocks.createSdk();
    const existingRef = {
      attachmentId: "21111111-1111-4111-8111-111111111111",
      kind: "file",
      mimeType: "text/plain",
      filename: "existing.txt",
      size: 8,
    };
    const documentRef = {
      attachmentId: "31111111-1111-4111-8111-111111111111",
      kind: "document",
      mimeType: "text/markdown",
      filename: "plan.md",
      size: 16,
    };
    const imageRef = {
      imageId: "41111111-1111-4111-8111-111111111111",
      mimeType: "image/png",
      filename: "decision.png",
      size: 42,
    };
    const body = "Which layout should ship?\n\nsee plan.md\n\n![layout](decision.png)";
    const docCapturedBody =
      "Which layout should ship?\n\nsee [plan.md](attachment:31111111-1111-4111-8111-111111111111)\n\n![layout](decision.png)";
    docCaptureMock.captureOutboundDocs.mockResolvedValueOnce({
      content: docCapturedBody,
      attachments: [documentRef],
    });
    imageCaptureMock.captureOutboundImages.mockResolvedValueOnce({
      caption: "Which layout should ship?",
      imageRefs: [imageRef],
    });

    await runChat(["ask", "nova", body, "--metadata", JSON.stringify({ attachments: [existingRef] })]);

    expect(docCaptureMock.captureOutboundDocs).toHaveBeenCalledWith(
      body,
      expect.objectContaining({ chatId: "chat-env", maxAttachments: 9 }),
    );
    expect(imageCaptureMock.captureOutboundImages).toHaveBeenCalledWith(
      docCapturedBody,
      expect.objectContaining({ chatId: "chat-env", maxAttachments: 8 }),
    );
    expect(sdk.sendMessage).toHaveBeenLastCalledWith(
      "chat-env",
      expect.objectContaining({
        format: "request",
        content: "Which layout should ship?",
        metadata: expect.objectContaining({
          attachments: [
            existingRef,
            documentRef,
            {
              attachmentId: imageRef.imageId,
              kind: "image",
              mimeType: "image/png",
              filename: "decision.png",
              size: 42,
            },
          ],
        }),
      }),
    );
  });

  it("chat ask rejects malformed caller attachment metadata before capture", async () => {
    await expect(
      runChat(["ask", "nova", "Which layout?", "--metadata", JSON.stringify({ attachments: [{ bad: true }] })]),
    ).rejects.toMatchObject({ code: "INVALID_METADATA", exitCode: 2 });

    expect(docCaptureMock.captureOutboundDocs).not.toHaveBeenCalled();
    expect(imageCaptureMock.captureOutboundImages).not.toHaveBeenCalled();
    expect(localAgentMocks.createSdk).not.toHaveBeenCalled();
  });

  it("chat ask --multi-select records multiSelect alongside options", async () => {
    const sdk = localAgentMocks.createSdk();
    await runChat([
      "ask",
      "nova",
      "Which surfaces to ship?",
      "--multi-select",
      "--options",
      JSON.stringify([
        { label: "Web", description: "ship web" },
        { label: "CLI", description: "ship cli" },
        { label: "API", description: "ship api" },
      ]),
    ]);
    expect(sdk.sendMessage).toHaveBeenCalledWith(
      "chat-env",
      expect.objectContaining({
        metadata: expect.objectContaining({
          request: expect.objectContaining({ multiSelect: true }),
        }),
      }),
    );
  });

  it("chat ask rejects no body — the body is the ask", async () => {
    ioMocks.readStdin.mockResolvedValueOnce(null);
    await expect(runChat(["ask", "nova"])).rejects.toMatchObject({ code: "ASK_NEEDS_BODY", exitCode: 2 });
  });

  it("chat ask never threads — it always opens a fresh top-level question (no inReplyTo)", async () => {
    const sdk = localAgentMocks.createSdk();
    await runChat(["ask", "nova", "Ship the rollout?"]);
    const [, payload] = sdk.sendMessage.mock.calls.at(-1) ?? [];
    expect(payload).toMatchObject({ format: "request", content: "Ship the rollout?" });
    expect(payload).not.toHaveProperty("inReplyTo");
  });

  it("chat ask validates --options: bad JSON, count, label length, and multi-select without options", async () => {
    await expect(runChat(["ask", "nova", "body", "--options", "{nope"])).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      exitCode: 2,
    });
    await expect(
      runChat(["ask", "nova", "body", "--options", JSON.stringify([{ label: "Only", description: "one" }])]),
    ).rejects.toMatchObject({ code: "INVALID_OPTIONS", exitCode: 2 });
    await expect(
      runChat([
        "ask",
        "nova",
        "body",
        "--options",
        JSON.stringify(["a", "b", "c", "d", "e"].map((l) => ({ label: l, description: "d" }))),
      ]),
    ).rejects.toMatchObject({ code: "INVALID_OPTIONS", exitCode: 2 });
    await expect(
      runChat([
        "ask",
        "nova",
        "body",
        "--options",
        JSON.stringify([
          { label: "this label is way too long", description: "d" },
          { label: "Fine", description: "d" },
        ]),
      ]),
    ).rejects.toMatchObject({ code: "INVALID_OPTIONS", exitCode: 2 });
    await expect(runChat(["ask", "nova", "body", "--multi-select"])).rejects.toMatchObject({
      code: "MULTISELECT_NEEDS_OPTIONS",
      exitCode: 2,
    });
  });

  it("chat ask validates context, target, body source, escaped newlines, metadata, and doc capture metadata", async () => {
    const sdk = localAgentMocks.createSdk();

    delete process.env.FIRST_TREE_CHAT_ID;
    await expect(runChat(["ask", "nova", "body"])).rejects.toMatchObject({ code: "NO_CHAT_CONTEXT", exitCode: 2 });

    process.env.FIRST_TREE_CHAT_ID = "chat-env";
    await expect(runChat(["ask"])).rejects.toMatchObject({ code: "NO_TARGET", exitCode: 2 });
    await expect(runChat(["ask", "nova", "inline", "--message-file", "body.md"])).rejects.toMatchObject({
      code: "CONFLICTING_ARGS",
      exitCode: 2,
    });
    await expect(runChat(["ask", "nova", "line1\\n\\nline2"])).rejects.toMatchObject({
      code: "ESCAPED_NEWLINES",
      exitCode: 2,
    });
    await expect(runChat(["ask", "nova", "body", "--metadata", "{bad"])).rejects.toMatchObject({
      code: "INVALID_METADATA",
      exitCode: 2,
    });

    docCaptureMock.captureOutboundDocs.mockResolvedValueOnce({
      content: "body with docs",
      attachments: [{ kind: "doc", id: "doc-1" }],
      documentContext: [{ path: "docs/plan.md", content: "Plan" }],
    });
    await runChat(["ask", "nova", "body with docs", "--metadata", '{"priority":1}']);
    expect(sdk.sendMessage).toHaveBeenLastCalledWith(
      "chat-env",
      expect.objectContaining({
        content: "body with docs",
        metadata: expect.objectContaining({
          priority: 1,
          attachments: [{ kind: "doc", id: "doc-1" }],
          documentContext: [{ path: "docs/plan.md", content: "Plan" }],
        }),
      }),
    );
  });

  it("chat ask merges attachment and document capture metadata without caller metadata", async () => {
    const sdk = localAgentMocks.createSdk();

    docCaptureMock.captureOutboundDocs.mockResolvedValueOnce({
      content: "attachment only",
      attachments: [{ kind: "doc", id: "doc-attachment" }],
    });
    await runChat(["ask", "nova", "attachment only"]);
    expect(sdk.sendMessage).toHaveBeenLastCalledWith(
      "chat-env",
      expect.objectContaining({
        metadata: { request: {}, attachments: [{ kind: "doc", id: "doc-attachment" }] },
      }),
    );

    docCaptureMock.captureOutboundDocs.mockResolvedValueOnce({
      content: "context only",
      documentContext: [{ path: "docs/context.md", content: "Context" }],
    });
    await runChat(["ask", "nova", "context only"]);
    expect(sdk.sendMessage).toHaveBeenLastCalledWith(
      "chat-env",
      expect.objectContaining({
        metadata: { request: {}, documentContext: [{ path: "docs/context.md", content: "Context" }] },
      }),
    );
  });

  it("chat ask continues through defensive non-throwing fail fallbacks", async () => {
    const sdk = localAgentMocks.createSdk();
    outputMocks.fail.mockImplementationOnce(() => undefined as never);

    await runChat(["ask"]);

    expect(sdk.sendMessage).toHaveBeenLastCalledWith(
      "chat-env",
      expect.objectContaining({ content: "stdin message", source: "cli" }),
    );
    expect(sdk.sendMessage).toHaveBeenLastCalledWith(
      "chat-env",
      expect.not.objectContaining({ receiverNames: expect.any(Array) }),
    );

    outputMocks.fail.mockImplementationOnce(() => undefined as never);
    ioMocks.readStdin.mockResolvedValueOnce(null);
    docCaptureMock.captureOutboundDocs.mockResolvedValueOnce({ content: "" });

    await runChat(["ask", "nova"]);

    expect(docCaptureMock.captureOutboundDocs).toHaveBeenCalledWith(
      "",
      expect.objectContaining({ chatId: "chat-env" }),
    );
  });

  it("chat ask is ask-only: it accepts neither --answer nor --reply-to", async () => {
    // The agent can only ASK; the human resolves in the web UI. `--answer`
    // (resolve) and `--reply-to` (thread) were both removed, so each is an
    // unknown-option error.
    await expect(runChat(["ask", "nova", "Ship it.", "--answer", "req-1"])).rejects.toThrow(
      /unknown option.*--answer/i,
    );
    await expect(runChat(["ask", "nova", "Ship it.", "--reply-to", "msg-7"])).rejects.toThrow(
      /unknown option.*--reply-to/i,
    );
  });

  it("chat send no longer accepts --request (moved to chat ask)", async () => {
    await expect(runChat(["send", "nova", "body", "--request"])).rejects.toThrow();
  });

  it("creates task chats with first-message routing and silent context participants", async () => {
    docCaptureMock.captureOutboundDocs.mockResolvedValueOnce({
      content: "see docs/plan.md",
      documentContext: [{ path: "docs/plan.md", content: "Plan" }],
    });
    const sdk = localAgentMocks.createSdk();
    await runChat([
      "create",
      "see docs/plan.md",
      "--to",
      "nova",
      "--to",
      "design",
      "--with",
      "observer",
      "--topic",
      "Review plan",
      "--description",
      "reviewing the new CLI flow",
      "--metadata",
      '{"priority":2}',
      "--format",
      "markdown",
    ]);

    expect(docCaptureMock.captureOutboundDocs).toHaveBeenCalledWith(
      "see docs/plan.md",
      expect.objectContaining({ sdk }),
    );
    expect(sdk.createTaskChat).toHaveBeenCalledWith({
      mode: "task",
      initialRecipientAgentIds: [],
      initialRecipientNames: ["nova", "design"],
      contextParticipantAgentIds: [],
      contextParticipantNames: ["observer"],
      topic: "Review plan",
      description: "reviewing the new CLI flow",
      initialMessage: {
        format: "markdown",
        content: "see docs/plan.md",
        metadata: { priority: 2, documentContext: [{ path: "docs/plan.md", content: "Plan" }] },
        source: "cli",
      },
    });
    expect(sdk.sendMessage).not.toHaveBeenCalled();
    expect(outputMocks.success).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: "chat-created", messageId: "msg-created" }),
    );
  });

  it("creates task chats from stdin and supports request metadata", async () => {
    const sdk = localAgentMocks.createSdk();
    await runChat([
      "create",
      "--to",
      "nova",
      "--agent",
      "worker",
      "--request",
      "--options",
      JSON.stringify([
        { label: "Ship", description: "Roll to 20% now" },
        { label: "Hold", description: "Wait another 24h" },
      ]),
    ]);

    expect(localAgentMocks.createSdk).toHaveBeenCalledWith("worker");
    expect(sdk.createTaskChat).toHaveBeenCalledWith(
      expect.objectContaining({
        initialRecipientNames: ["nova"],
        initialMessage: expect.objectContaining({
          format: "request",
          content: "stdin message",
          metadata: {
            request: {
              options: [
                { label: "Ship", description: "Roll to 20% now" },
                { label: "Hold", description: "Wait another 24h" },
              ],
            },
          },
        }),
      }),
    );

    // --request still requires exactly one --to human.
    await expect(runChat(["create", "body", "--request", "--to", "nova", "--to", "design"])).rejects.toMatchObject({
      code: "REQUEST_NEEDS_ONE_TARGET",
      exitCode: 2,
    });
    // A --request with no --options is a valid free-text ask (empty payload).
    await runChat(["create", "body", "--request", "--to", "nova"]);
    expect(sdk.createTaskChat).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialMessage: expect.objectContaining({ format: "request", metadata: { request: {} } }),
      }),
    );
    // Malformed options / multi-select without options are rejected.
    await expect(runChat(["create", "body", "--request", "--to", "nova", "--options", "{nope"])).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      exitCode: 2,
    });
    await expect(runChat(["create", "body", "--request", "--to", "nova", "--multi-select"])).rejects.toMatchObject({
      code: "MULTISELECT_NEEDS_OPTIONS",
      exitCode: 2,
    });
  });

  it("creates task chats with attachment-only doc capture metadata", async () => {
    docCaptureMock.captureOutboundDocs.mockResolvedValueOnce({
      content: "see attached notes",
      attachments: [{ id: "att-1", kind: "document" }],
    });
    const sdk = localAgentMocks.createSdk();

    await runChat(["create", "see attached notes", "--to", "nova"]);

    expect(sdk.createTaskChat).toHaveBeenCalledWith(
      expect.objectContaining({
        contextParticipantNames: [],
        initialMessage: expect.objectContaining({
          metadata: { attachments: [{ id: "att-1", kind: "document" }] },
        }),
      }),
    );
  });

  it("validates chat create input and treats uncertain create outcomes as non-retryable", async () => {
    const sdk = localAgentMocks.createSdk();

    await expect(runChat(["create", "body"])).rejects.toMatchObject({ code: "NO_TARGET", exitCode: 2 });
    await expect(runChat(["create", "body", "--to", "nova", "--metadata", "{bad"])).rejects.toMatchObject({
      code: "INVALID_METADATA",
      exitCode: 2,
    });
    await expect(runChat(["create", "body", "--to", "nova", "--format", "html"])).rejects.toMatchObject({
      code: "INVALID_FORMAT",
      exitCode: 2,
    });
    ioMocks.readStdin.mockResolvedValueOnce("   ");
    await expect(runChat(["create", "--to", "nova"])).rejects.toMatchObject({ code: "NO_MESSAGE", exitCode: 2 });

    sdk.createTaskChat.mockRejectedValueOnce(new SdkError(503, "temporarily unavailable"));
    await expect(runChat(["create", "body", "--to", "nova"])).rejects.toMatchObject({
      code: "CREATE_RESULT_UNKNOWN",
      exitCode: 6,
    });
    expect(sdk.createTaskChat).toHaveBeenCalledTimes(1);

    const nestedNetworkError = new TypeError("fetch failed");
    Object.assign(nestedNetworkError, { cause: { cause: { code: "ECONNRESET" } } });
    sdk.createTaskChat.mockRejectedValueOnce(nestedNetworkError);
    await expect(runChat(["create", "body", "--to", "nova"])).rejects.toMatchObject({
      code: "CREATE_RESULT_UNKNOWN",
      exitCode: 6,
    });

    const nestedPlainError = new Error("socket failed");
    Object.assign(nestedPlainError, { cause: { name: "Wrapper", cause: { code: "UND_ERR_SOCKET" } } });
    sdk.createTaskChat.mockRejectedValueOnce(nestedPlainError);
    await expect(runChat(["create", "body", "--to", "nova"])).rejects.toMatchObject({
      code: "CREATE_RESULT_UNKNOWN",
      exitCode: 6,
    });

    const abortError = new Error("request aborted");
    abortError.name = "AbortError";
    sdk.createTaskChat.mockRejectedValueOnce(abortError);
    await expect(runChat(["create", "body", "--to", "nova"])).rejects.toMatchObject({
      code: "CREATE_RESULT_UNKNOWN",
      exitCode: 6,
    });

    const nestedTimeout = new Error("wrapped timeout");
    Object.assign(nestedTimeout, { cause: { name: "TimeoutError" } });
    sdk.createTaskChat.mockRejectedValueOnce(nestedTimeout);
    await expect(runChat(["create", "body", "--to", "nova"])).rejects.toMatchObject({
      code: "CREATE_RESULT_UNKNOWN",
      exitCode: 6,
    });

    sdk.createTaskChat.mockRejectedValueOnce("plain sdk failure");
    await expect(runChat(["create", "body", "--to", "nova"])).rejects.toBe("plain sdk failure");
    expect(localAgentMocks.handleSdkError).toHaveBeenCalledWith("plain sdk failure");

    const certainError = new Error("validation failed");
    Object.assign(certainError, { cause: { code: "EINVAL" } });
    sdk.createTaskChat.mockRejectedValueOnce(certainError);
    await expect(runChat(["create", "body", "--to", "nova"])).rejects.toThrow("validation failed");
    expect(localAgentMocks.handleSdkError).toHaveBeenCalledWith(certainError);
  });

  it("sets, clears, and validates chat topics", async () => {
    const sdk = localAgentMocks.createSdk();

    await runChat(["set-topic", "  Launch plan  ", "--chat", "chat-1", "--agent", "nova"]);
    expect(localAgentMocks.createSdk).toHaveBeenCalledWith("nova");
    expect(sdk.updateChat).toHaveBeenCalledWith("chat-1", { topic: "Launch plan" });

    await runChat(["set-topic", "--clear"]);
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-env", { topic: null });

    await expect(runChat(["set-topic", "bad", "--clear"])).rejects.toMatchObject({
      code: "CONFLICTING_ARGS",
      exitCode: 2,
    });
    await expect(runChat(["set-topic", "   "])).rejects.toMatchObject({ code: "EMPTY_TOPIC", exitCode: 2 });

    delete process.env.FIRST_TREE_CHAT_ID;
    await expect(runChat(["set-topic", "Launch"])).rejects.toMatchObject({ code: "NO_CHAT_CONTEXT", exitCode: 2 });
  });

  it("sets, clears, and validates chat descriptions; updates both fields together", async () => {
    const sdk = localAgentMocks.createSdk();

    await runChat(["set-topic", "--description", "  reviewing PR #42  ", "--chat", "chat-1"]);
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-1", { description: "reviewing PR #42" });

    await runChat(["set-topic", "--clear-description"]);
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-env", { description: null });

    await runChat(["set-topic", "Launch plan", "--description", "drafting steps"]);
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-env", {
      topic: "Launch plan",
      description: "drafting steps",
    });

    await expect(runChat(["set-topic", "--description", "x", "--clear-description"])).rejects.toMatchObject({
      code: "CONFLICTING_ARGS",
      exitCode: 2,
    });
    ioMocks.readStdin.mockResolvedValueOnce(null);
    await expect(runChat(["set-topic", "--description", "-"])).rejects.toMatchObject({
      code: "NO_STDIN",
      exitCode: 2,
    });
    await expect(runChat(["set-topic", "--description", "   "])).rejects.toMatchObject({
      code: "EMPTY_DESCRIPTION",
      exitCode: 2,
    });
    await expect(runChat(["set-topic"])).rejects.toMatchObject({ code: "NOTHING_TO_UPDATE", exitCode: 2 });
  });

  it("delegates chat history SDK failures to the shared handler", async () => {
    const error = new Error("history failed");
    localAgentMocks.createSdk.mockReturnValueOnce({
      listMessages: vi.fn(async () => {
        throw error;
      }),
    });

    await expect(runChat(["history", "chat-1"])).rejects.toBe(error);
    expect(localAgentMocks.handleSdkError).toHaveBeenCalledWith(error);
  });

  it("archives an explicit or current chat and requires one of those targets", async () => {
    const sdk = localAgentMocks.createSdk();

    await runChat(["archive", "chat-1", "--agent", "nova"]);
    expect(localAgentMocks.createSdk).toHaveBeenCalledWith("nova");
    expect(sdk.archiveChat).toHaveBeenCalledWith("chat-1");
    expect(outputMocks.success).toHaveBeenLastCalledWith({
      chatId: "chat-1",
      engagementStatus: "archived",
    });

    await runChat(["archive"]);
    expect(sdk.archiveChat).toHaveBeenLastCalledWith("chat-env");

    delete process.env.FIRST_TREE_CHAT_ID;
    await expect(runChat(["archive"])).rejects.toMatchObject({ code: "NO_CHAT_CONTEXT", exitCode: 2 });
  });

  it("updates topic and description independently via `chat update`", async () => {
    const sdk = localAgentMocks.createSdk();

    await runChat(["update", "--topic", "  Launch plan  ", "--chat", "chat-1", "--agent", "nova"]);
    expect(localAgentMocks.createSdk).toHaveBeenCalledWith("nova");
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-1", { topic: "Launch plan" });

    await runChat(["update", "--clear-topic"]);
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-env", { topic: null });

    await runChat(["update", "--description", "  reviewing PR #42  ", "--chat", "chat-1"]);
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-1", { description: "reviewing PR #42" });

    await runChat(["update", "--clear-description"]);
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-env", { description: null });

    await runChat(["update", "--topic", "Launch plan", "--description", "drafting steps"]);
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-env", {
      topic: "Launch plan",
      description: "drafting steps",
    });

    await expect(runChat(["update", "--topic", "x", "--clear-topic"])).rejects.toMatchObject({
      code: "CONFLICTING_ARGS",
      exitCode: 2,
    });
    await expect(runChat(["update", "--description", "x", "--clear-description"])).rejects.toMatchObject({
      code: "CONFLICTING_ARGS",
      exitCode: 2,
    });
    await expect(runChat(["update", "--topic", "   "])).rejects.toMatchObject({ code: "EMPTY_TOPIC", exitCode: 2 });
    await expect(runChat(["update", "--description", "   "])).rejects.toMatchObject({
      code: "EMPTY_DESCRIPTION",
      exitCode: 2,
    });
    await expect(runChat(["update"])).rejects.toMatchObject({ code: "NOTHING_TO_UPDATE", exitCode: 2 });

    delete process.env.FIRST_TREE_CHAT_ID;
    await expect(runChat(["update", "--topic", "Launch"])).rejects.toMatchObject({
      code: "NO_CHAT_CONTEXT",
      exitCode: 2,
    });
  });

  it("guards --description against literal \\n escapes on update and create, with a stdin escape hatch", async () => {
    const sdk = localAgentMocks.createSdk();

    // update: a one-line description whose newlines are literal `\n` escapes is
    // rejected before any write, with a copyable heredoc hint on stderr.
    await expect(
      runChat(["update", "--description", "line1\\n\\n**title**\\nline3", "--chat", "chat-1"]),
    ).rejects.toMatchObject({ code: "ESCAPED_NEWLINES", exitCode: 2 });
    expect(sdk.updateChat).not.toHaveBeenCalled();
    const updateHint = printLineMock.mock.calls.map((call) => String(call[0])).join("");
    expect(updateHint).toContain("chat update --description -");

    // Narrow by design: a single escaped `\n` in prose stays writable.
    await runChat(["update", "--description", "see `\\n` in the logs", "--chat", "chat-1"]);
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-1", { description: "see `\\n` in the logs" });

    // `--description -` reads the description from stdin (real newlines) and
    // skips the guard — the escape hatch for an intentional literal `\n` body.
    ioMocks.readStdin.mockResolvedValueOnce("first line\n\n**second** line");
    await runChat(["update", "--description", "-", "--chat", "chat-1"]);
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-1", { description: "first line\n\n**second** line" });

    // `--description -` with no piped stdin (TTY) is a usage error, not a write.
    ioMocks.readStdin.mockResolvedValueOnce(null);
    await expect(runChat(["update", "--description", "-", "--chat", "chat-1"])).rejects.toMatchObject({
      code: "NO_STDIN",
      exitCode: 2,
    });

    // The deprecated `set-topic` / `rename` alias is also a description write
    // entry point, so it inherits the same guard and `--description -` hatch.
    await expect(runChat(["set-topic", "--description", "x\\ny\\nz", "--chat", "chat-1"])).rejects.toMatchObject({
      code: "ESCAPED_NEWLINES",
      exitCode: 2,
    });
    await expect(runChat(["rename", "Launch", "--description", "x\\ny\\nz", "--chat", "chat-1"])).rejects.toMatchObject(
      { code: "ESCAPED_NEWLINES", exitCode: 2 },
    );
    ioMocks.readStdin.mockResolvedValueOnce("alpha\n\nbeta");
    await runChat(["set-topic", "--description", "-", "--chat", "chat-1"]);
    expect(sdk.updateChat).toHaveBeenLastCalledWith("chat-1", { description: "alpha\n\nbeta" });

    // create: the same inline guard fires before the chat is created; its hint
    // points at ANSI-C `$'...'` quoting (stdin is taken by the first message).
    printLineMock.mockClear();
    await expect(
      runChat(["create", "--to", "nova", "hello", "--description", "alpha\\nbeta\\ngamma"]),
    ).rejects.toMatchObject({ code: "ESCAPED_NEWLINES", exitCode: 2 });
    expect(sdk.createTaskChat).not.toHaveBeenCalled();
    const createHint = printLineMock.mock.calls.map((call) => String(call[0])).join("");
    expect(createHint).toContain("$'first line");
  });

  it("opens an interactive chat, polls, sends input, handles send failures, and closes cleanly", async () => {
    const emitter = new EventEmitter() as EventEmitter & { prompt: () => void };
    emitter.prompt = vi.fn();
    readlineMocks.createInterface.mockReturnValue(emitter);
    globalThis.setInterval = vi.fn(() => 42) as unknown as typeof setInterval;
    globalThis.clearInterval = vi.fn() as unknown as typeof clearInterval;
    cliFetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "dm-1" }))
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: "old", senderId: "agent-1", content: "old", createdAt: "2026-06-01T00:00:00.000Z" }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ createdAt: "2026-06-01T00:00:01.000Z" }))
      .mockResolvedValueOnce(jsonResponse("nope", false, 500));

    await runChat(["open", "nova"]);

    emitter.emit("line", " hello ");
    await Promise.resolve();
    await Promise.resolve();
    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://hub.example/api/v1/chats/dm-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ format: "text", content: "hello" }),
      }),
    );

    emitter.emit("line", "again");
    await Promise.resolve();
    await Promise.resolve();
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("Failed to send: 500");

    emitter.emit("line", "   ");
    expect(() => emitter.emit("close")).toThrow("process.exit");
    expect(globalThis.clearInterval).toHaveBeenCalledWith(42);
  });

  it("chat open handles DM creation failures, polling updates, and send exceptions", async () => {
    cliFetchMock.mockResolvedValueOnce(jsonResponse("denied", false, 403));
    await expect(runChat(["open", "nova"])).rejects.toMatchObject({ code: "CHAT_ERROR" });

    const emitter = new EventEmitter() as EventEmitter & { prompt: () => void };
    emitter.prompt = vi.fn();
    readlineMocks.createInterface.mockReturnValue(emitter);
    let intervalCallback: (() => void) | undefined;
    globalThis.setInterval = vi.fn((callback: () => void) => {
      intervalCallback = callback;
      return 99 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = vi.fn() as unknown as typeof clearInterval;
    cliFetchMock.mockResolvedValueOnce(jsonResponse({ id: "dm-2" })).mockResolvedValueOnce(
      jsonResponse({
        items: [{ id: "old", senderId: "agent-1", content: "old", createdAt: "2026-06-01T00:00:00.000Z" }],
      }),
    );

    await runChat(["open", "nova"]);
    cliFetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [
          {
            id: "new",
            senderId: "agent-1",
            content: { card: "x".repeat(520) },
            createdAt: "2026-06-01T00:00:02.000Z",
          },
          { id: "other", senderId: "member-1", content: "ignore", createdAt: "2026-06-01T00:00:01.000Z" },
        ],
      }),
    );
    intervalCallback?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("[Nova]");
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("...");

    cliFetchMock.mockRejectedValueOnce(new Error("poll down"));
    intervalCallback?.();
    await Promise.resolve();
    await Promise.resolve();

    cliFetchMock.mockRejectedValueOnce(new Error("network down"));
    emitter.emit("line", "hello");
    await Promise.resolve();
    await Promise.resolve();
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("network down");

    expect(() => emitter.emit("close")).toThrow("process.exit");
    expect(globalThis.clearInterval).toHaveBeenCalledWith(99);
  });

  it("chat open uses agent id fallbacks and ignores failed polling responses", async () => {
    resolveAgentMock.mockResolvedValueOnce({ uuid: "agent-fallback" });
    const emitter = new EventEmitter() as EventEmitter & { prompt: () => void };
    emitter.prompt = vi.fn();
    readlineMocks.createInterface.mockReturnValue(emitter);
    let intervalCallback: (() => void) | undefined;
    globalThis.setInterval = vi.fn((callback: () => void) => {
      intervalCallback = callback;
      return 100 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = vi.fn() as unknown as typeof clearInterval;
    cliFetchMock
      .mockResolvedValueOnce(jsonResponse({ id: "dm-fallback" }))
      .mockResolvedValueOnce(
        jsonResponse({ items: [{ id: "old", senderId: "agent-fallback", content: "old", createdAt: "1" }] }),
      )
      .mockResolvedValueOnce(jsonResponse("poll failed", false, 502));

    await runChat(["open", "fallback"]);
    intervalCallback?.();
    await Promise.resolve();
    await Promise.resolve();

    const output = printLineMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Chat with agent-fallback");

    cliFetchMock.mockRejectedValueOnce("send string failure");
    emitter.emit("line", "hello");
    await Promise.resolve();
    await Promise.resolve();
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("send string failure");

    expect(() => emitter.emit("close")).toThrow("process.exit");
    expect(globalThis.clearInterval).toHaveBeenCalledWith(100);
  });

  it("chat open prints short string previews with name and generic sender fallbacks", async () => {
    const namedEmitter = new EventEmitter() as EventEmitter & { prompt: () => void };
    namedEmitter.prompt = vi.fn();
    readlineMocks.createInterface.mockReturnValueOnce(namedEmitter);
    let namedInterval: (() => void) | undefined;
    globalThis.setInterval = vi.fn((callback: () => void) => {
      namedInterval = callback;
      return 101 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = vi.fn() as unknown as typeof clearInterval;
    resolveAgentMock.mockResolvedValueOnce({ uuid: "agent-named", name: "NamedOnly" });
    cliFetchMock.mockResolvedValueOnce(jsonResponse({ id: "dm-named" })).mockResolvedValueOnce(
      jsonResponse({
        items: [{ id: "old", senderId: "agent-named", content: "old", createdAt: "2026-06-01T00:00:00.000Z" }],
      }),
    );

    await runChat(["open", "named"]);
    cliFetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [{ id: "new", senderId: "agent-named", content: "short reply", createdAt: "2026-06-01T00:00:02.000Z" }],
      }),
    );
    namedInterval?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain("[NamedOnly] short reply");
    expect(() => namedEmitter.emit("close")).toThrow("process.exit");

    const genericEmitter = new EventEmitter() as EventEmitter & { prompt: () => void };
    genericEmitter.prompt = vi.fn();
    readlineMocks.createInterface.mockReturnValueOnce(genericEmitter);
    let genericInterval: (() => void) | undefined;
    globalThis.setInterval = vi.fn((callback: () => void) => {
      genericInterval = callback;
      return 102 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval;
    resolveAgentMock.mockResolvedValueOnce({ uuid: "agent-generic" });
    cliFetchMock.mockResolvedValueOnce(jsonResponse({ id: "dm-generic" })).mockResolvedValueOnce(
      jsonResponse({
        items: [{ id: "old", senderId: "agent-generic", content: "old", createdAt: "2026-06-01T00:00:00.000Z" }],
      }),
    );

    await runChat(["open", "generic"]);
    cliFetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [
          {
            id: "new",
            senderId: "agent-generic",
            content: { text: "short object" },
            createdAt: "2026-06-01T00:00:02.000Z",
          },
        ],
      }),
    );
    genericInterval?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(printLineMock.mock.calls.map((call) => String(call[0])).join("")).toContain(
      '[agent] {"text":"short object"}',
    );
    expect(() => genericEmitter.emit("close")).toThrow("process.exit");
  });

  it("chat open reports non-Error top-level failures", async () => {
    resolveAgentMock.mockRejectedValueOnce("agent lookup failed");

    await expect(runChat(["open", "nova"])).rejects.toMatchObject({ code: "CHAT_ERROR" });
    expect(outputMocks.fail).toHaveBeenCalledWith("CHAT_ERROR", "agent lookup failed");
  });
});
