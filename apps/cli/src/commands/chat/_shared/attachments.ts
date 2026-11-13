import { type AttachmentRef, attachmentRefSchema, MAX_MESSAGE_ATTACHMENT_REFS } from "@first-tree/shared";
import { fail } from "../../../cli/output.js";

/**
 * Write-side reader for caller-supplied attachment metadata. Render paths are
 * intentionally tolerant of malformed history, but a new send must fail
 * closed instead of silently dropping bad entries while merging captures.
 */
export function readOutboundAttachmentRefs(metadata: Record<string, unknown> | undefined): AttachmentRef[] {
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
