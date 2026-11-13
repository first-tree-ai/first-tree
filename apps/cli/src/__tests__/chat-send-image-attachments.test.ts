import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
  success: vi.fn(),
}));

vi.mock("../commands/_shared/local-agent.js", () => localAgentMocks);
vi.mock("../core/doc-capture.js", () => docCaptureMock);
vi.mock("../core/image-capture.js", async () => {
  const actual = await vi.importActual<typeof import("../core/image-capture.js")>("../core/image-capture.js");
  return { ...actual, captureOutboundImages: imageCaptureMock.captureOutboundImages };
});
vi.mock("../cli/output.js", () => outputMocks);

const IMAGE_REF = {
  imageId: "00000000-0000-4000-8000-000000000001",
  mimeType: "image/png",
  filename: "shot.png",
  size: 8,
};

async function runChat(args: string[]): Promise<void> {
  const { registerChatCommands } = await import("../commands/chat/index.js");
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  registerChatCommands(program);
  await program.parseAsync(["node", "test", "chat", "send", ...args]);
}

/**
 * `chat send` captures workspace images like `chat ask`, but it used to rewrite
 * the message into a legacy `format: "file"` image batch, which the
 * post-convergence server never folded into `metadata.attachments` — so the
 * recipient got a message with the image silently removed (issue 2372). The
 * send must use the same generic roster `chat ask` writes.
 */
describe("chat send — captured images ride metadata.attachments (issue 2372)", () => {
  const originalChatId = process.env.FIRST_TREE_CHAT_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FIRST_TREE_CHAT_ID = "chat-env";
    docCaptureMock.captureOutboundDocs.mockImplementation(async (content: string) => ({ content }));
    localAgentMocks.createSdk.mockReturnValue({
      sendMessage: vi.fn(async () => ({ id: "msg-1" })),
    });
  });

  afterEach(() => {
    if (originalChatId === undefined) {
      delete process.env.FIRST_TREE_CHAT_ID;
    } else {
      process.env.FIRST_TREE_CHAT_ID = originalChatId;
    }
  });

  it("keeps the markdown body and attaches the captured image as a generic ref", async () => {
    imageCaptureMock.captureOutboundImages.mockResolvedValue({ caption: "看图：", imageRefs: [IMAGE_REF] });

    await runChat(["code-agent", "看图：![shot](shot.png)", "-f", "markdown"]);

    const sdk = localAgentMocks.createSdk.mock.results.at(-1)?.value;
    expect(sdk.sendMessage).toHaveBeenCalledWith(
      "chat-env",
      expect.objectContaining({
        // Not "file": the body stays markdown and the image is a metadata ref.
        format: "markdown",
        content: "看图：",
        metadata: expect.objectContaining({
          attachments: [
            {
              attachmentId: IMAGE_REF.imageId,
              kind: "image",
              mimeType: "image/png",
              filename: "shot.png",
              size: 8,
            },
          ],
        }),
      }),
    );
  });

  it("leaves an image-free send exactly as before, with no attachments key", async () => {
    imageCaptureMock.captureOutboundImages.mockResolvedValue({ caption: "hello", imageRefs: [] });

    await runChat(["code-agent", "hello", "-f", "markdown"]);

    const sdk = localAgentMocks.createSdk.mock.results.at(-1)?.value;
    const [, payload] = sdk.sendMessage.mock.calls[0] as [
      string,
      { format: string; content: string; metadata?: Record<string, unknown> },
    ];
    expect(payload.format).toBe("markdown");
    expect(payload.content).toBe("hello");
    expect(payload.metadata?.attachments).toBeUndefined();
  });

  it("spends the per-message budget in the shared order: caller refs, documents, then images", async () => {
    const callerRefs = Array.from({ length: 9 }, (_, index) => ({
      attachmentId: `00000000-0000-4000-8000-0000000000${10 + index}`,
      kind: "image",
      mimeType: "image/png",
      filename: `shot-${index}.png`,
      size: 8,
    }));
    const docRef = {
      attachmentId: "00000000-0000-4000-8000-000000000099",
      kind: "file",
      mimeType: "text/markdown",
      filename: "design.md",
      size: 12,
    };
    // The server caps the combined roster at 10; a capture that ignores the
    // caller's refs would put 11 in it and be rejected (review round 1).
    // Honour the capacity the command passes, as the real capture does.
    docCaptureMock.captureOutboundDocs.mockImplementation(
      async (content: string, ctx: { maxAttachments?: number }) => ({
        content,
        attachments: (ctx.maxAttachments ?? 1) > 0 ? [docRef] : [],
      }),
    );
    imageCaptureMock.captureOutboundImages.mockImplementation(
      async (content: string, ctx: { maxAttachments?: number }) => ({
        caption: content,
        imageRefs: (ctx.maxAttachments ?? 1) > 0 ? [IMAGE_REF] : [],
      }),
    );

    await runChat(["code-agent", "hi", "-f", "markdown", "-m", JSON.stringify({ attachments: callerRefs })]);

    expect(docCaptureMock.captureOutboundDocs).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({ maxAttachments: 1 }),
    );
    expect(imageCaptureMock.captureOutboundImages).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({ maxAttachments: 0 }),
    );
    const sdk = localAgentMocks.createSdk.mock.results.at(-1)?.value;
    const [, payload] = sdk.sendMessage.mock.calls[0] as [string, { metadata?: { attachments?: unknown[] } }];
    expect(payload.metadata?.attachments).toHaveLength(10);
  });

  it("gives document capture no room when the caller already filled the roster", async () => {
    const callerRefs = Array.from({ length: 10 }, (_, index) => ({
      attachmentId: `00000000-0000-4000-8000-0000000000${10 + index}`,
      kind: "image",
      mimeType: "image/png",
      filename: `shot-${index}.png`,
      size: 8,
    }));
    docCaptureMock.captureOutboundDocs.mockImplementation(
      async (content: string, ctx: { maxAttachments?: number }) => ({
        content,
        attachments:
          (ctx.maxAttachments ?? 1) > 0
            ? [
                {
                  attachmentId: "00000000-0000-4000-8000-000000000099",
                  kind: "file",
                  mimeType: "text/markdown",
                  filename: "design.md",
                  size: 12,
                },
              ]
            : [],
      }),
    );

    await runChat(["code-agent", "hi", "-f", "markdown", "-m", JSON.stringify({ attachments: callerRefs })]);

    expect(docCaptureMock.captureOutboundDocs).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({ maxAttachments: 0 }),
    );
    const sdk = localAgentMocks.createSdk.mock.results.at(-1)?.value;
    const [, payload] = sdk.sendMessage.mock.calls[0] as [string, { metadata?: { attachments?: unknown[] } }];
    expect(payload.metadata?.attachments).toHaveLength(10);
  });

  it("does not capture images for a card body", async () => {
    imageCaptureMock.captureOutboundImages.mockResolvedValue({ caption: "cap", imageRefs: [IMAGE_REF] });

    await runChat(["code-agent", "card-body", "-f", "card"]);

    expect(imageCaptureMock.captureOutboundImages).not.toHaveBeenCalled();
    const sdk = localAgentMocks.createSdk.mock.results.at(-1)?.value;
    const [, payload] = sdk.sendMessage.mock.calls[0] as [string, { format: string; content: string }];
    expect(payload.format).toBe("card");
    expect(payload.content).toBe("card-body");
  });
});
