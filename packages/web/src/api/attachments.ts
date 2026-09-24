import {
  ATTACHMENT_FILENAME_HEADER,
  ATTACHMENT_MIME_HEADER,
  getAttachmentFilenameError,
  normalizeAttachmentFilename,
  type UploadAttachmentResponse,
  uploadAttachmentResponseSchema,
} from "@first-tree/shared";
import { apiFetchRaw, withOrg } from "./client.js";

/**
 * Upload a file's bytes to the org-scoped attachment store and return its
 * metadata — consumers persist the returned `id`. Targets the currently
 * viewed org via `withOrg`.
 *
 * The filename is `encodeURIComponent`-escaped because HTTP header values are
 * limited to ISO-8859-1 and a raw unicode name would make `fetch` throw. The
 * The header feeds attachment metadata and download `Content-Disposition`.
 */
/**
 * Best-effort MIME for an upload: browsers leave `File.type` empty for several
 * text-native formats (`.md`, `.csv`, source files). The server requires a
 * non-empty MIME and stores it verbatim, and a message's `AttachmentRef` must
 * declare the SAME value it was stored with, so both the upload header and the
 * ref derive their MIME from this one deterministic function. Kind/rendering is
 * driven by the filename extension, not this MIME, so the octet-stream fallback
 * is harmless.
 */
export function uploadMimeFor(file: Blob): string {
  return file.type || "application/octet-stream";
}

export async function uploadAttachment(file: Blob, filename?: string): Promise<UploadAttachmentResponse> {
  const inferredName =
    filename ?? ("name" in file && typeof file.name === "string" && file.name.trim().length > 0 ? file.name : "blob");
  const canonicalName = normalizeAttachmentFilename(inferredName);
  const filenameError = getAttachmentFilenameError(canonicalName);
  if (filenameError) throw new TypeError(filenameError);
  const res = await apiFetchRaw(withOrg("/attachments"), {
    method: "POST",
    // Passing the Blob directly lets fetch stream it; do not materialize a
    // second full ArrayBuffer in browser memory.
    body: file,
    headers: {
      "Content-Type": "application/octet-stream",
      [ATTACHMENT_MIME_HEADER]: uploadMimeFor(file),
      [ATTACHMENT_FILENAME_HEADER]: encodeURIComponent(canonicalName),
    },
  });
  return uploadAttachmentResponseSchema.parse(await res.json());
}

/** @deprecated Use {@link uploadAttachment}; the primitive is not image-specific. */
export const uploadImageAttachment = uploadAttachment;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Unexpected FileReader result"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Download attachment bytes (capability model — a valid session plus the
 * unguessable id is sufficient). Returns base64 + the served MIME so callers
 * can render a `data:` URL and warm the IndexedDB cache with one shape.
 */
export async function fetchAttachmentBase64(id: string): Promise<{ base64: string; mimeType: string }> {
  const res = await apiFetchRaw(`/attachments/${encodeURIComponent(id)}`);
  const blob = await res.blob();
  const mimeType = res.headers.get("content-type") ?? blob.type ?? "application/octet-stream";
  return { base64: await blobToBase64(blob), mimeType };
}

/**
 * Download attachment bytes as decoded text — the doc-preview drawer's data
 * source. Returns the UTF-8 text, the served MIME, and the raw byte length so
 * callers can verify integrity (sha256) and enforce a render size cap.
 */
export async function fetchAttachmentText(id: string): Promise<{ text: string; mimeType: string; sizeBytes: number }> {
  const res = await apiFetchRaw(`/attachments/${encodeURIComponent(id)}`);
  const buffer = await res.arrayBuffer();
  const mimeType = res.headers.get("content-type") ?? "application/octet-stream";
  const text = new TextDecoder("utf-8").decode(buffer);
  return { text, mimeType, sizeBytes: buffer.byteLength };
}

/**
 * Download attachment bytes through the authed api helper and trigger a browser
 * save dialog. The `<a href="/api/v1/attachments/:id">` shortcut cannot be used
 * for a real download: that navigation carries no `Authorization` header (the
 * token lives in localStorage, only `apiFetchRaw` injects it) → 401, and a
 * page-relative `/api/v1/...` points at the wrong origin when web and API are
 * deployed separately → 404. Fetch the blob authenticated, hand it to the
 * browser via an object URL, then revoke the URL once the click is dispatched.
 */
export async function downloadAttachment(id: string, filename: string): Promise<void> {
  const res = await apiFetchRaw(`/attachments/${encodeURIComponent(id)}`);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Compute the lowercase hex SHA-256 of a UTF-8 string via the Web Crypto API —
 * used by the doc-preview drawer to verify fetched bytes against the captured
 * `ref.sha256`. Throws when `crypto.subtle` is unavailable (insecure context);
 * callers treat that as "skip verification".
 */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto subtle digest is unavailable");
  const bytes = new TextEncoder().encode(text);
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
