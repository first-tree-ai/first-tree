import { buildMessageImageSnapshots, type FirstTreeHubSDK } from "@first-tree/client";
import type { AttachmentRef, ImageRefContent } from "@first-tree/shared";
import { resolveChatOrgId, resolveImageFenceFromEnv } from "./capture-context.js";

/**
 * Capture the workspace images an outbound `chat send` body references, the
 * picture sibling of `captureOutboundDocs`. An agent that writes a markdown
 * image `![alt](path)` pointing at a local image inside its own workspace gets
 * the bytes uploaded to the org attachment store; the caller then chooses the
 * persisted reference shape. Ordinary sends use a `format: "file"` image batch,
 * while tracked asks adapt the refs into generic metadata attachments and keep
 * the request content textual.
 *
 * Like doc capture, this resolves the send-side fence from the runtime-injected
 * env and the upload org from the target chat, so it is a pure pass-through
 * (empty refs, unchanged content) outside an agent session or when the org
 * can't be resolved. Capture failure NEVER blocks the send.
 */
export async function captureOutboundImages(
  content: string,
  ctx: { sdk: FirstTreeHubSDK; chatId?: string; maxAttachments?: number },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ caption: string; imageRefs: ImageRefContent[] }> {
  const self = resolveImageFenceFromEnv(env);
  if (!self || !ctx.chatId) return { caption: content, imageRefs: [] };

  try {
    const orgId = await resolveChatOrgId(ctx.sdk, ctx.chatId);
    if (!orgId) return { caption: content, imageRefs: [] };
    const { imageRefs, strippedText } = await buildMessageImageSnapshots(content, self, {
      uploader: ctx.sdk,
      orgId,
      ...(ctx.maxAttachments !== undefined ? { maxAttachments: ctx.maxAttachments } : {}),
    });
    return { caption: strippedText, imageRefs };
  } catch {
    return { caption: content, imageRefs: [] };
  }
}

/**
 * Adapt freshly uploaded legacy image refs into the generic metadata ref used
 * by tracked requests. Capture always supplies `size`; an incomplete ref is
 * dropped so the server never receives metadata that cannot pass blob
 * integrity validation.
 */
export function toGenericImageAttachmentRefs(imageRefs: readonly ImageRefContent[]): AttachmentRef[] {
  return imageRefs.flatMap((ref) =>
    ref.size === undefined
      ? []
      : [
          {
            attachmentId: ref.imageId,
            kind: "image" as const,
            mimeType: ref.mimeType,
            filename: ref.filename,
            size: ref.size,
          },
        ],
  );
}
