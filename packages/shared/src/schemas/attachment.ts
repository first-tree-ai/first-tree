import { z } from "zod";

/**
 * Per-attachment hard byte cap enforced server-side.
 *
 * Sized for the foreseeable upload mix (mostly images, occasional small docs)
 * while keeping a single `attachments.data` bytea row comfortably inside
 * PostgreSQL TOAST's compressed-out-of-line sweet spot. Bumping requires both
 * a route-level `bodyLimit` raise and a re-examination of any downstream
 * consumer that streams the bytes back through Node's heap.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Maximum UTF-8 byte length of a stored filename.
 *
 * Download responses percent-encode the complete filename for the quoted
 * `Content-Disposition` parameter. A 255-byte filename expands to at most
 * 765 ASCII characters, leaving ample room for the other response headers
 * under Node's default 16 KiB header limit.
 */
export const MAX_ATTACHMENT_FILENAME_BYTES = 255;

/** Normalize the filename value shared by every upload ingress. */
export function normalizeAttachmentFilename(value: string): string {
  return value.trim();
}

/** Truncate a string without splitting a Unicode code point. */
export function truncateUtf8ByBytes(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

/** Return the canonical filename validation error shared by every ingress. */
export function getAttachmentFilenameError(value: string): string | null {
  const filename = normalizeAttachmentFilename(value);
  if (filename.length === 0) return "Attachment filename is required";
  try {
    encodeURIComponent(filename);
  } catch {
    return "Attachment filename must contain valid Unicode characters";
  }
  if (new TextEncoder().encode(filename).byteLength > MAX_ATTACHMENT_FILENAME_BYTES) {
    return `Attachment filename exceeds maximum length of ${MAX_ATTACHMENT_FILENAME_BYTES} UTF-8 bytes`;
  }
  return null;
}

/**
 * Cloud message-class attachment retention window, in days.
 *
 * Single numeric owner for the policy: Server derives the millisecond cutoff
 * from this value, and Client/Web interpolate it into user-facing copy.
 * Changing the number here is the only production policy edit.
 */
export const MESSAGE_ATTACHMENT_RETENTION_DAYS = 14;

/**
 * Header name (case-insensitive) carrying the original filename on upload.
 * Octet-stream uploads do not carry a filename in `Content-Disposition`, so
 * the SDK forwards the user-visible name in this header. Server falls back
 * to a generic name when the header is absent or empty.
 */
export const ATTACHMENT_FILENAME_HEADER = "x-attachment-filename";

/**
 * Header name (case-insensitive) carrying the original MIME type on upload.
 * The wire-level `Content-Type` is always `application/octet-stream` so the
 * server's body parser stays uniform; the *logical* mime (e.g. `image/png`)
 * rides in this header and is what we persist into `attachments.mime_type`.
 */
export const ATTACHMENT_MIME_HEADER = "x-attachment-mime";

/**
 * What the server returns on successful upload and what GET responses for
 * an `?meta=1` style probe would return. Today GET only streams bytes, but
 * the shape is the canonical metadata contract.
 */
export const attachmentMetadataSchema = z.object({
  id: z.string().uuid(),
  mimeType: z.string().min(1),
  filename: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  uploadedBy: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type AttachmentMetadata = z.infer<typeof attachmentMetadataSchema>;

export const uploadAttachmentResponseSchema = attachmentMetadataSchema;
export type UploadAttachmentResponse = z.infer<typeof uploadAttachmentResponseSchema>;
