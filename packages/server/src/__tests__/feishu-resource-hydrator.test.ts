import { Readable } from "node:stream";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_FILENAME_BYTES, MAX_MESSAGE_ATTACHMENT_REFS } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { attachments } from "../db/schema/attachments.js";
import { hydrateFeishuResources } from "../services/integrations/feishu/resource-hydrator.js";
import { useTestApp } from "./helpers.js";
import { DEFAULT_ORG_ID } from "./setup.js";

describe("Feishu resource hydration", () => {
  const getApp = useTestApp();

  it("publishes bytes through the existing attachment primitive under the Integration actor", async () => {
    const app = getApp();
    const bytes = Buffer.from("real-image-bytes");
    const download = vi.fn().mockResolvedValue({
      stream: Readable.from([bytes]),
      headers: { "content-type": "image/png", "content-length": String(bytes.length) },
    });
    const result = await hydrateFeishuResources(app.db, {
      organizationId: DEFAULT_ORG_ID,
      botBindingId: "bot-binding-a",
      messageId: "om_message",
      descriptors: [{ type: "image", fileKey: "img_a", fileName: "picture.png", origin: "message" }],
      download,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
    });

    expect(download).toHaveBeenCalledWith({ messageId: "om_message", fileKey: "img_a", type: "image" });
    expect(result.unavailableNotes).toEqual([]);
    expect(result.attachments[0]).toMatchObject({
      kind: "image",
      mimeType: "image/png",
      filename: "picture.png",
      size: bytes.length,
    });
    const attachmentId = result.attachments[0]?.attachmentId;
    expect(attachmentId).toBeTruthy();
    const [stored] = await app.db
      .select()
      .from(attachments)
      .where(eq(attachments.id, attachmentId ?? ""));
    expect(stored).toMatchObject({
      organizationId: DEFAULT_ORG_ID,
      lifecycleState: "ready",
      uploadedBy: "integration:feishu:bot-binding-a",
      mimeType: "image/png",
      data: bytes,
    });
    expect(result.resources[0]?.hydration).toMatchObject({ state: "succeeded", attachmentId });
  });

  it("keeps the message usable when downloads fail or exceed First Tree limits", async () => {
    const app = getApp();
    const download = vi.fn(async ({ fileKey }: { fileKey: string }) => {
      if (fileKey === "too-big") {
        return {
          stream: Readable.from([Buffer.from("unused")]),
          headers: { "content-length": String(MAX_ATTACHMENT_BYTES + 1), "content-type": "application/pdf" },
        };
      }
      throw Object.assign(new Error("permission denied"), { code: 99991663 });
    });
    const result = await hydrateFeishuResources(app.db, {
      organizationId: DEFAULT_ORG_ID,
      botBindingId: "bot-binding-a",
      messageId: "om_message",
      descriptors: [
        { type: "file", fileKey: "too-big", fileName: "large.pdf", origin: "message" },
        { type: "audio", fileKey: "denied", fileName: "voice.opus", origin: "message" },
        { type: "sticker", fileKey: "sticker", origin: "message" },
        { type: "image", fileKey: "card-image", origin: "interactive" },
      ],
      download,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
    });

    expect(result.attachments).toEqual([]);
    expect(result.resources.map((resource) => resource.hydration)).toEqual([
      expect.objectContaining({ state: "unavailable", reason: "too_large" }),
      expect.objectContaining({ state: "unavailable", reason: "permission_denied" }),
      expect.objectContaining({ state: "unavailable", reason: "unsupported" }),
      expect.objectContaining({ state: "unavailable", reason: "unsupported" }),
    ]);
    expect(result.unavailableNotes).toHaveLength(4);
    expect(download).toHaveBeenCalledTimes(2);
  });

  it("truncates long Unicode filenames at the UTF-8 byte boundary", async () => {
    const app = getApp();
    const filename = "\u4e2d".repeat(86);
    const bytes = Buffer.from("unicode-feishu-file");
    const result = await hydrateFeishuResources(app.db, {
      organizationId: DEFAULT_ORG_ID,
      botBindingId: "bot-binding-unicode",
      messageId: "om_unicode_message",
      descriptors: [{ type: "file", fileKey: "unicode-file", fileName: filename, origin: "message" }],
      download: vi.fn().mockResolvedValue({
        stream: Readable.from([bytes]),
        headers: { "content-type": "text/plain", "content-length": String(bytes.length) },
      }),
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
    });

    expect(result.unavailableNotes).toEqual([]);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]?.filename).toBe("\u4e2d".repeat(MAX_ATTACHMENT_FILENAME_BYTES / 3));
    expect(new TextEncoder().encode(result.attachments[0]?.filename ?? "").byteLength).toBe(
      MAX_ATTACHMENT_FILENAME_BYTES,
    );
  });

  it("never downloads more than the existing per-message attachment-ref cap", async () => {
    const app = getApp();
    const download = vi.fn(async ({ fileKey }: { fileKey: string }) => ({
      stream: Readable.from([Buffer.from(fileKey)]),
      headers: { "content-type": "application/octet-stream", "content-length": String(fileKey.length) },
    }));
    const descriptors = Array.from({ length: MAX_MESSAGE_ATTACHMENT_REFS + 2 }, (_, index) => ({
      type: "file" as const,
      fileKey: `file-${index}`,
      origin: "message" as const,
    }));
    const result = await hydrateFeishuResources(app.db, {
      organizationId: DEFAULT_ORG_ID,
      botBindingId: "bot-binding-a",
      messageId: "om_message",
      descriptors,
      download,
      attachmentObjectQuota: { maxOrganizationAttachments: 10_000 },
    });

    expect(download).toHaveBeenCalledTimes(MAX_MESSAGE_ATTACHMENT_REFS);
    expect(result.attachments).toHaveLength(MAX_MESSAGE_ATTACHMENT_REFS);
    expect(result.resources.slice(MAX_MESSAGE_ATTACHMENT_REFS).map((resource) => resource.hydration)).toEqual([
      expect.objectContaining({ state: "unavailable", reason: "too_many" }),
      expect.objectContaining({ state: "unavailable", reason: "too_many" }),
    ]);
  });
});
