import type { FastifyInstance } from "fastify";
import { NotFoundError } from "../errors.js";
import { loadAttachmentMeta, openAttachmentStream } from "../services/attachment.js";

/**
 * Object-storage primitive — download surface.
 *
 *   GET /api/v1/attachments/:id   — download bytes
 *
 * Mounted under `userScope` (app.ts), so a valid user JWT is required.
 *
 * Download auth is a **capability model**: the only gates are (1) a valid
 * user JWT — enforced by the scope's `userAuth` hook — and (2) knowledge of
 * the unguessable UUIDv4 id. There is no per-attachment ACL: the id itself
 * is the bearer capability. A consumer that wants stronger, attachment-scoped
 * authorization layers it on top (e.g. an image message hands the id only to
 * its legitimate recipients); the primitive deliberately stays thin.
 *
 * Upload lives separately at `POST /api/v1/orgs/:orgId/attachments`
 * (Class B) because the uploader identity is org-scoped — see
 * api/orgs/attachments.ts.
 */
export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
    const { id } = request.params;

    // Load metadata only — the ETag check runs off this, so a 304 cache hit
    // never drags the bytea payload out of PG.
    const meta = await loadAttachmentMeta(app.db, id);
    if (!meta) {
      throw new NotFoundError(`Attachment "${id}" not found`);
    }

    // If-None-Match: cheap ETag check. id is content-stable (UUIDv4 + bytes
    // are immutable once written), so we never need to vary on anything else.
    const ifNoneMatch = request.headers["if-none-match"];
    const etag = `"${meta.id}"`;
    if (ifNoneMatch === etag) {
      return reply.status(304).send();
    }

    const stream = await openAttachmentStream(app.db, app.attachmentBlobStore, id);
    if (!stream) {
      // Deleted between the metadata read and now — vanishingly rare, but
      // surface it honestly rather than streaming an empty body.
      throw new NotFoundError(`Attachment "${id}" not found`);
    }

    reply
      .header("Content-Type", meta.mimeType)
      .header("Content-Length", meta.sizeBytes)
      .header("Cache-Control", "private, max-age=31536000, immutable")
      .header("ETag", etag)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", `inline; filename="${encodeRfc6266Filename(meta.filename)}"`);
    return reply.send(stream);
  });
}

/**
 * Encode the filename into an ASCII-only quoted `Content-Disposition`
 * `filename` parameter.
 * Node rejects non-Latin-1 response-header characters, and the client already
 * decodes this percent-encoded wire form when it reads attachment metadata.
 * Encoding the whole value also protects quotes, slashes, control characters,
 * and literal percent signs without introducing an ambiguous partial encoding.
 */
function encodeRfc6266Filename(name: string): string {
  return encodeURIComponent(name);
}
