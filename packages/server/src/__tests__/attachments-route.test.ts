import { validateHeaderValue } from "node:http";
import { Readable } from "node:stream";
import { FirstTreeHubSDK } from "@first-tree/client/cloud";
import {
  ATTACHMENT_FILENAME_HEADER,
  ATTACHMENT_MIME_HEADER,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_FILENAME_BYTES,
} from "@first-tree/shared";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import type { Database } from "../db/connection.js";
import { attachments } from "../db/schema/attachments.js";
import { chats } from "../db/schema/chats.js";
import { messages } from "../db/schema/messages.js";
import { organizations } from "../db/schema/organizations.js";
import {
  backfillExternalAttachmentsToPostgres,
  createAttachment,
  deleteAttachmentIfUnreferenced,
  MAX_CONCURRENT_ATTACHMENT_UPLOADS_PER_CALLER,
} from "../services/attachment.js";
import { MemoryAttachmentBlobStore } from "../services/attachment-blob-store.js";
import { editMessage, lockFileAttachmentRefsIfPresent, sendMessage } from "../services/chat/message.js";
import { validateMessageAttachmentRefs } from "../services/chat/message-attachment-validation.js";
import { ensureMembership } from "../services/team/membership.js";
import { uuidv7 } from "../uuid.js";
import { createAdminContext, createTestAdmin, createTestApp, useTestApp } from "./helpers.js";

type Admin = Awaited<ReturnType<typeof createTestAdmin>>;

const TEST_ATTACHMENT_QUOTA = { maxOrganizationAttachments: 10_000 };

function postAttachment(
  app: FastifyInstance,
  caller: Admin,
  payload: Buffer,
  overrides: Partial<{ mime: string; filename: string; contentType: string; orgId: string }> = {},
) {
  const orgId = overrides.orgId ?? caller.organizationId;
  return app.inject({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/attachments`,
    headers: {
      authorization: `Bearer ${caller.accessToken}`,
      "content-type": overrides.contentType ?? "application/octet-stream",
      [ATTACHMENT_MIME_HEADER]: overrides.mime ?? "image/png",
      [ATTACHMENT_FILENAME_HEADER]: overrides.filename ?? "test.png",
    },
    payload,
  });
}

function getAttachment(app: FastifyInstance, caller: Admin, id: string) {
  return app.inject({
    method: "GET",
    url: `/api/v1/attachments/${id}`,
    headers: { authorization: `Bearer ${caller.accessToken}` },
  });
}

describe("attachments route — upload + capability download", () => {
  const getApp = useTestApp();

  it("uploads then downloads via uploader", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `up-self-${crypto.randomUUID().slice(0, 6)}` });

    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const upload = await postAttachment(app, admin, bytes, { filename: "kitten.png" });
    expect(upload.statusCode).toBe(201);
    const body = upload.json() as { id: string; sizeBytes: number; uploadedBy: string };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.sizeBytes).toBe(bytes.byteLength);
    expect(body.uploadedBy).toBe(admin.humanAgentUuid);

    const download = await getAttachment(app, admin, body.id);
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-type"]).toBe("image/png");
    expect(download.headers["content-length"]).toBe(String(bytes.byteLength));
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    expect(download.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(download.headers.etag).toBe(`"${body.id}"`);
    expect(download.headers["content-disposition"]).toBe('inline; filename="kitten.png"');
    expect(download.rawPayload.equals(bytes)).toBe(true);

    const [stored] = await app.db.select().from(attachments).where(eq(attachments.id, body.id));
    expect(stored).toMatchObject({
      organizationId: admin.organizationId,
      objectKey: null,
      lifecycleState: "ready",
      data: bytes,
    });
  });

  it("serves Unicode filenames through an ASCII-safe Content-Disposition header", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `up-unicode-${crypto.randomUUID().slice(0, 6)}` });
    const filename = "\u4f1a\u8bdd\u9644\u4ef6 100%\uff08\u7ec8\u7248\uff09.docx";
    const encodedFilename = encodeURIComponent(filename);
    const bytes = Buffer.from("unicode filename payload");

    const upload = await postAttachment(app, admin, bytes, {
      filename: encodedFilename,
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(upload.statusCode).toBe(201);
    const body = upload.json() as { id: string; filename: string };
    expect(body.filename).toBe(filename);

    const download = await getAttachment(app, admin, body.id);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(bytes)).toBe(true);
    const contentDisposition = download.headers["content-disposition"];
    expect(contentDisposition).toBe(`inline; filename="${encodedFilename}"`);
    if (typeof contentDisposition !== "string") throw new Error("Content-Disposition header is missing");
    expect(() => validateHeaderValue("Content-Disposition", contentDisposition)).not.toThrow();
  });

  it("accepts the maximum filename size and downloads through Node fetch", async () => {
    const isolatedApp = await createTestApp();
    try {
      const admin = await createTestAdmin(isolatedApp, { username: `up-max-name-${crypto.randomUUID().slice(0, 6)}` });
      const filename = ";".repeat(MAX_ATTACHMENT_FILENAME_BYTES);
      const upload = await postAttachment(isolatedApp, admin, Buffer.from("maximum filename"), {
        filename: encodeURIComponent(filename),
      });
      expect(upload.statusCode).toBe(201);
      const body = upload.json() as { id: string; filename: string };
      expect(body.filename).toBe(filename);

      await isolatedApp.listen({ port: 0, host: "127.0.0.1" });
      const address = isolatedApp.server.address();
      if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP address");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/attachments/${body.id}`, {
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from("maximum filename"));
      const contentDisposition = response.headers.get("content-disposition");
      expect(contentDisposition).toBe(`inline; filename="${encodeURIComponent(filename)}"`);
      if (!contentDisposition) throw new Error("Content-Disposition header is missing");
      expect(() => validateHeaderValue("Content-Disposition", contentDisposition)).not.toThrow();
    } finally {
      await isolatedApp.close();
    }
  });

  it("bounds legacy stored filenames before sending response headers", async () => {
    const isolatedApp = await createTestApp();
    try {
      const admin = await createTestAdmin(isolatedApp, { username: `legacy-long-${crypto.randomUUID().slice(0, 6)}` });
      const id = crypto.randomUUID();
      const filename = ";".repeat(5_500);
      const bytes = Buffer.from("legacy filename");
      await isolatedApp.db.insert(attachments).values({
        id,
        organizationId: admin.organizationId,
        objectKey: null,
        lifecycleState: "ready",
        mimeType: "application/octet-stream",
        filename,
        sizeBytes: bytes.byteLength,
        data: bytes,
        uploadedBy: admin.humanAgentUuid,
      });

      await isolatedApp.listen({ port: 0, host: "127.0.0.1" });
      const address = isolatedApp.server.address();
      if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP address");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/attachments/${id}`, {
        headers: { authorization: `Bearer ${admin.accessToken}` },
      });
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
      const contentDisposition = response.headers.get("content-disposition");
      expect(contentDisposition).toBe(
        `inline; filename="${encodeURIComponent(";".repeat(MAX_ATTACHMENT_FILENAME_BYTES))}"`,
      );
    } finally {
      await isolatedApp.close();
    }
  });

  it("dual-reads and reverse-backfills a pre-existing S3-only row", async () => {
    const app = getApp();
    const store = app.attachmentBlobStore as MemoryAttachmentBlobStore;
    const admin = await createTestAdmin(app, { username: `s3-reverse-${crypto.randomUUID().slice(0, 6)}` });
    const id = crypto.randomUUID();
    const objectKey = `attachments/${admin.organizationId}/${id}`;
    const bytes = Buffer.from("legacy-s3-payload");
    store.objects.set(objectKey, bytes);
    await app.db.insert(attachments).values({
      id,
      organizationId: admin.organizationId,
      objectKey,
      lifecycleState: "ready",
      mimeType: "application/octet-stream",
      filename: "legacy.bin",
      sizeBytes: bytes.byteLength,
      data: null,
      uploadedBy: admin.humanAgentUuid,
    });

    const beforeBackfill = await getAttachment(app, admin, id);
    expect(beforeBackfill.statusCode).toBe(200);
    expect(beforeBackfill.rawPayload).toEqual(bytes);

    await expect(backfillExternalAttachmentsToPostgres(app.db, store)).resolves.toEqual({
      migrated: 1,
      skipped: 0,
    });
    const [stored] = await app.db.select().from(attachments).where(eq(attachments.id, id));
    expect(stored).toMatchObject({ data: bytes, objectKey, lifecycleState: "ready" });

    // The pointer and S3 copy stay available to pre-transition replicas, but
    // this version reads PostgreSQL first.
    store.objects.delete(objectKey);
    const afterBackfill = await getAttachment(app, admin, id);
    expect(afterBackfill.statusCode).toBe(200);
    expect(afterBackfill.rawPayload).toEqual(bytes);
  });

  it("database-fences the old PostgreSQL-to-S3 backfill during a rolling deploy", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `storage-fence-${crypto.randomUUID().slice(0, 6)}` });
    const stored = await createAttachment(
      app.db,
      {
        organizationId: admin.organizationId,
        mimeType: "application/octet-stream",
        filename: "postgres.bin",
        body: Buffer.from("postgres-authoritative"),
        uploadedBy: admin.humanAgentUuid,
      },
      TEST_ATTACHMENT_QUOTA,
    );
    const legacyObjectKey = `attachments/${admin.organizationId}/${stored.id}`;

    // This is the claim UPDATE issued by #2062's old replica before it would
    // upload the bytes and clear `data`.
    const claimError = await app.db
      .update(attachments)
      .set({ objectKey: legacyObjectKey, lifecycleState: "uploading", updatedAt: new Date() })
      .where(eq(attachments.id, stored.id))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(claimError).toBeInstanceOf(Error);
    const wrapped = claimError as Error & { cause?: unknown };
    const causeMessage = wrapped.cause instanceof Error ? wrapped.cause.message : String(wrapped.cause ?? "");
    expect(`${wrapped.message} ${causeMessage}`).toContain("attachment payload externalization is disabled");

    const [afterClaim] = await app.db.select().from(attachments).where(eq(attachments.id, stored.id));
    expect(afterClaim).toMatchObject({
      objectKey: null,
      lifecycleState: "ready",
      data: Buffer.from("postgres-authoritative"),
    });
  });

  it("does not overwrite a concurrent S3-to-PostgreSQL backfill winner", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `reverse-cas-${crypto.randomUUID().slice(0, 6)}` });
    const id = crypto.randomUUID();
    const objectKey = `attachments/${admin.organizationId}/${id}`;
    const legacyBytes = Buffer.from("legacy-copy");
    const winningBytes = Buffer.from("winning-copy");
    let signalReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let releaseRead!: () => void;
    const readReleased = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    class BlockingLegacyStore extends MemoryAttachmentBlobStore {
      override async get(key: string): Promise<Readable> {
        signalReadStarted();
        await readReleased;
        return super.get(key);
      }
    }
    const store = new BlockingLegacyStore();
    store.objects.set(objectKey, legacyBytes);
    await app.db.insert(attachments).values({
      id,
      organizationId: admin.organizationId,
      objectKey,
      lifecycleState: "ready",
      mimeType: "application/octet-stream",
      filename: "legacy-race.bin",
      sizeBytes: legacyBytes.byteLength,
      data: null,
      uploadedBy: admin.humanAgentUuid,
    });

    const staleBackfill = backfillExternalAttachmentsToPostgres(app.db, store);
    await readStarted;
    await app.db
      .update(attachments)
      .set({ data: winningBytes, sizeBytes: winningBytes.byteLength, updatedAt: new Date() })
      .where(eq(attachments.id, id));
    releaseRead();

    await expect(staleBackfill).resolves.toEqual({ migrated: 0, skipped: 1 });
    const [stored] = await app.db.select().from(attachments).where(eq(attachments.id, id));
    expect(stored).toMatchObject({ data: winningBytes, objectKey, lifecycleState: "ready" });
  });

  it("bounds simultaneous PostgreSQL upload reservations for one caller", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `upload-bound-${crypto.randomUUID().slice(0, 6)}` });
    let startedCount = 0;
    let signalLimitReached!: () => void;
    const limitReached = new Promise<void>((resolve) => {
      signalLimitReached = resolve;
    });
    let releaseUploads!: () => void;
    const uploadsReleased = new Promise<void>((resolve) => {
      releaseUploads = resolve;
    });
    const input = (index: number) => ({
      organizationId: admin.organizationId,
      mimeType: "application/octet-stream",
      filename: `parallel-${index}.bin`,
      body: Readable.from(
        (async function* () {
          startedCount += 1;
          if (startedCount === MAX_CONCURRENT_ATTACHMENT_UPLOADS_PER_CALLER) signalLimitReached();
          await uploadsReleased;
          yield Buffer.from(`parallel-${index}`);
        })(),
      ),
      uploadedBy: admin.humanAgentUuid,
    });
    const active = Array.from({ length: MAX_CONCURRENT_ATTACHMENT_UPLOADS_PER_CALLER }, (_, index) =>
      createAttachment(app.db, input(index), TEST_ATTACHMENT_QUOTA),
    );

    await limitReached;
    await expect(
      createAttachment(app.db, input(MAX_CONCURRENT_ATTACHMENT_UPLOADS_PER_CALLER), TEST_ATTACHMENT_QUOTA),
    ).rejects.toThrow(`already has ${MAX_CONCURRENT_ATTACHMENT_UPLOADS_PER_CALLER}`);
    expect(startedCount).toBe(MAX_CONCURRENT_ATTACHMENT_UPLOADS_PER_CALLER);

    releaseUploads();
    const completed = await Promise.all(active);
    expect(completed).toHaveLength(MAX_CONCURRENT_ATTACHMENT_UPLOADS_PER_CALLER);
    expect(completed.every((row) => row.lifecycleState === "ready")).toBe(true);
    expect(completed.every((row) => row.data !== null)).toBe(true);
  });

  it("removes the PostgreSQL reservation when upload validation fails", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `failed-delete-${crypto.randomUUID().slice(0, 6)}` });
    const id = crypto.randomUUID();

    await expect(
      createAttachment(
        app.db,
        {
          id,
          organizationId: admin.organizationId,
          mimeType: "application/octet-stream",
          filename: "failed-delete.bin",
          body: Buffer.from("three"),
          contentLength: 3,
          uploadedBy: admin.humanAgentUuid,
        },
        TEST_ATTACHMENT_QUOTA,
      ),
    ).rejects.toThrow("Content-Length does not match");

    expect(await app.db.select().from(attachments).where(eq(attachments.id, id))).toHaveLength(0);
  });

  it("holds attachment reference locks until the message transaction commits", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `ref-lock-${crypto.randomUUID().slice(0, 6)}` });
    const stored = await createAttachment(
      app.db,
      {
        organizationId: admin.organizationId,
        mimeType: "text/markdown",
        filename: "locked.md",
        body: Buffer.from("locked"),
        uploadedBy: admin.humanAgentUuid,
      },
      TEST_ATTACHMENT_QUOTA,
    );
    const chatId = uuidv7();
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "group" });
    const metadata = {
      attachments: [
        {
          attachmentId: stored.id,
          kind: "document" as const,
          mimeType: stored.mimeType,
          filename: stored.filename,
          size: stored.sizeBytes,
          sha256: "a".repeat(64),
          source: { path: "locked.md" },
        },
      ],
    };

    await app.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Database;
      await validateMessageAttachmentRefs(tx, metadata);
      const lockError = await app.db
        .transaction(async (cleanupTx) => {
          await cleanupTx.execute(sql`SET LOCAL lock_timeout = '100ms'`);
          await cleanupTx
            .select({ id: attachments.id })
            .from(attachments)
            .where(eq(attachments.id, stored.id))
            .for("update");
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(lockError).toBeInstanceOf(Error);
      const wrapped = lockError as Error & { cause?: unknown };
      const causeMessage = wrapped.cause instanceof Error ? wrapped.cause.message : String(wrapped.cause ?? "");
      expect(`${wrapped.message} ${causeMessage}`).toMatch(/lock timeout/);
      await tx.insert(messages).values({
        id: uuidv7(),
        chatId,
        senderId: admin.humanAgentUuid,
        format: "markdown",
        content: "message keeps the attachment",
        metadata,
        source: "api",
      });
    });

    await expect(deleteAttachmentIfUnreferenced(app.db, app.attachmentBlobStore, stored.id)).resolves.toBe(false);
    expect(await app.db.select().from(attachments).where(eq(attachments.id, stored.id))).toHaveLength(1);
  });

  it("holds single and batch file-content reference locks until message commit", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `file-ref-lock-${crypto.randomUUID().slice(0, 6)}` });
    const stored = await createAttachment(
      app.db,
      {
        organizationId: admin.organizationId,
        mimeType: "image/png",
        filename: "locked.png",
        body: Buffer.from("locked-image"),
        uploadedBy: admin.humanAgentUuid,
      },
      TEST_ATTACHMENT_QUOTA,
    );
    const chatId = uuidv7();
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "group" });
    const ref = {
      imageId: stored.id,
      mimeType: "image/png" as const,
      filename: stored.filename,
      size: stored.sizeBytes,
    };
    const contents = [ref, { caption: "batch", attachments: [ref] }];

    for (const content of contents) {
      await app.db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Database;
        await lockFileAttachmentRefsIfPresent(tx, "file", content);
        const lockError = await app.db
          .transaction(async (cleanupTx) => {
            await cleanupTx.execute(sql`SET LOCAL lock_timeout = '100ms'`);
            await cleanupTx
              .select({ id: attachments.id })
              .from(attachments)
              .where(eq(attachments.id, stored.id))
              .for("update");
          })
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(lockError).toBeInstanceOf(Error);
        const wrapped = lockError as Error & { cause?: unknown };
        const causeMessage = wrapped.cause instanceof Error ? wrapped.cause.message : String(wrapped.cause ?? "");
        expect(`${wrapped.message} ${causeMessage}`).toMatch(/lock timeout/);
        await tx.insert(messages).values({
          id: uuidv7(),
          chatId,
          senderId: admin.humanAgentUuid,
          format: "file",
          content,
          source: "web",
        });
      });
    }

    await expect(deleteAttachmentIfUnreferenced(app.db, app.attachmentBlobStore, stored.id)).resolves.toBe(false);
  });

  it("keeps legacy single and batch file references shape-only", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `file-ref-send-${crypto.randomUUID().slice(0, 6)}` });
    const chatId = uuidv7();
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "group" });
    const missingRef = {
      imageId: crypto.randomUUID(),
      mimeType: "image/png" as const,
      filename: "missing.png",
    };

    await sendMessage(
      app.db,
      chatId,
      admin.humanAgentUuid,
      { format: "file", content: missingRef, source: "web" },
      { allowRecipientlessSend: true },
    );
    await sendMessage(
      app.db,
      chatId,
      admin.humanAgentUuid,
      { format: "file", content: { attachments: [missingRef] }, source: "web" },
      { allowRecipientlessSend: true },
    );

    const stored = await createAttachment(
      app.db,
      {
        organizationId: admin.organizationId,
        mimeType: "image/png",
        filename: "actual.png",
        body: Buffer.from("actual"),
        uploadedBy: admin.humanAgentUuid,
      },
      TEST_ATTACHMENT_QUOTA,
    );
    await sendMessage(
      app.db,
      chatId,
      admin.humanAgentUuid,
      {
        format: "file",
        content: {
          imageId: stored.id,
          mimeType: "image/jpeg",
          filename: "declared.jpg",
          size: stored.sizeBytes + 1,
        },
        source: "web",
      },
      { allowRecipientlessSend: true },
    );

    const existingId = uuidv7();
    await app.db.insert(messages).values({
      id: existingId,
      chatId,
      senderId: admin.humanAgentUuid,
      format: "text",
      content: "before edit",
      source: "web",
    });
    await editMessage(
      app.db,
      chatId,
      existingId,
      admin.humanAgentUuid,
      {
        format: "file",
        content: missingRef,
      },
      app.attachmentBlobStore,
    );
    const edited = await editMessage(
      app.db,
      chatId,
      existingId,
      admin.humanAgentUuid,
      {
        format: "file",
        content: { attachments: [missingRef] },
      },
      app.attachmentBlobStore,
    );

    expect(edited).toMatchObject({ format: "file", content: { attachments: [missingRef] } });
    expect(await app.db.select().from(messages).where(eq(messages.chatId, chatId))).toHaveLength(4);
  });

  it("immediately deletes PostgreSQL rows released by replacement and file-to-text edits", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `file-ref-edit-${crypto.randomUUID().slice(0, 6)}` });
    const chatId = uuidv7();
    await app.db.insert(chats).values({ id: chatId, organizationId: admin.organizationId, type: "group" });
    const previous = await createAttachment(
      app.db,
      {
        organizationId: admin.organizationId,
        mimeType: "image/png",
        filename: "previous.png",
        body: Buffer.from("previous"),
        uploadedBy: admin.humanAgentUuid,
      },
      TEST_ATTACHMENT_QUOTA,
    );
    const replacement = await createAttachment(
      app.db,
      {
        organizationId: admin.organizationId,
        mimeType: "image/png",
        filename: "replacement.png",
        body: Buffer.from("replacement"),
        uploadedBy: admin.humanAgentUuid,
      },
      TEST_ATTACHMENT_QUOTA,
    );
    const messageId = uuidv7();
    await app.db.insert(messages).values({
      id: messageId,
      chatId,
      senderId: admin.humanAgentUuid,
      format: "file",
      content: {
        imageId: previous.id,
        mimeType: "image/svg+xml",
        filename: previous.filename,
        size: previous.sizeBytes,
      },
      source: "web",
    });

    await editMessage(
      app.db,
      chatId,
      messageId,
      admin.humanAgentUuid,
      {
        content: {
          caption: "replacement",
          attachments: [
            {
              imageId: replacement.id,
              mimeType: "image/png",
              filename: replacement.filename,
              size: replacement.sizeBytes,
            },
          ],
        },
      },
      app.attachmentBlobStore,
    );
    expect(await app.db.select().from(attachments).where(eq(attachments.id, previous.id))).toHaveLength(0);
    expect(await app.db.select().from(attachments).where(eq(attachments.id, replacement.id))).toHaveLength(1);

    await editMessage(
      app.db,
      chatId,
      messageId,
      admin.humanAgentUuid,
      { format: "text", content: "images removed" },
      app.attachmentBlobStore,
    );
    expect(await app.db.select().from(attachments).where(eq(attachments.id, replacement.id))).toHaveLength(0);
  });

  it("capability model: any authenticated user with the id can download", async () => {
    const app = getApp();
    const uploader = await createAdminContext(app, { username: `cap-up-${crypto.randomUUID().slice(0, 6)}` });
    const other = await createAdminContext(app, { username: `cap-ot-${crypto.randomUUID().slice(0, 6)}` });

    const bytes = Buffer.from("shared-by-capability");
    const upload = await postAttachment(app, uploader, bytes);
    const id = (upload.json() as { id: string }).id;

    // A different authenticated user who knows the id downloads it — the
    // unguessable id is the bearer capability; no chat/uploader relation
    // required. Stronger ACL is the consumer's job, not the primitive's.
    const download = await getAttachment(app, other, id);
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(bytes)).toBe(true);
  });

  it("rejects download without a JWT (401)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `noauth-${crypto.randomUUID().slice(0, 6)}` });
    const upload = await postAttachment(app, admin, Buffer.from("guarded"));
    const id = (upload.json() as { id: string }).id;

    const reply = await app.inject({ method: "GET", url: `/api/v1/attachments/${id}` });
    expect(reply.statusCode).toBe(401);
  });

  it("ETag 304 on If-None-Match hit", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `etag-${crypto.randomUUID().slice(0, 6)}` });
    const upload = await postAttachment(app, admin, Buffer.from("hi"));
    const id = (upload.json() as { id: string }).id;

    const reply = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${id}`,
      headers: {
        authorization: `Bearer ${admin.accessToken}`,
        "if-none-match": `"${id}"`,
      },
    });
    expect(reply.statusCode).toBe(304);
  });

  it("rejects upload with wrong Content-Type", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `wct-${crypto.randomUUID().slice(0, 6)}` });
    const reply = await postAttachment(app, admin, Buffer.from("hi"), { contentType: "application/json" });
    expect(reply.statusCode).toBe(400);
  });

  it("rejects upload missing the mime header", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `mh-${crypto.randomUUID().slice(0, 6)}` });
    const reply = await app.inject({
      method: "POST",
      url: `/api/v1/orgs/${admin.organizationId}/attachments`,
      headers: {
        authorization: `Bearer ${admin.accessToken}`,
        "content-type": "application/octet-stream",
        [ATTACHMENT_FILENAME_HEADER]: "x.bin",
      },
      payload: Buffer.from("hi"),
    });
    expect(reply.statusCode).toBe(400);
  });

  it("rejects empty body", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `eb-${crypto.randomUUID().slice(0, 6)}` });
    const reply = await postAttachment(app, admin, Buffer.alloc(0));
    expect(reply.statusCode).toBe(400);
  });

  it("rejects blank attachment mime type and filename", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `blank-attachment-${crypto.randomUUID().slice(0, 6)}` });

    const blankMime = await postAttachment(app, admin, Buffer.from("mime"), { mime: " " });
    expect(blankMime.statusCode).toBe(400);

    await expect(
      createAttachment(
        app.db,
        {
          organizationId: admin.organizationId,
          mimeType: "image/png",
          filename: " ",
          body: Buffer.from("filename"),
          uploadedBy: admin.humanAgentUuid,
        },
        TEST_ATTACHMENT_QUOTA,
      ),
    ).rejects.toThrow("Attachment filename is required");

    await expect(
      createAttachment(
        app.db,
        {
          organizationId: admin.organizationId,
          mimeType: "application/octet-stream",
          filename: ";".repeat(MAX_ATTACHMENT_FILENAME_BYTES + 1),
          body: Buffer.from("long filename"),
          uploadedBy: admin.humanAgentUuid,
        },
        TEST_ATTACHMENT_QUOTA,
      ),
    ).rejects.toThrow("Attachment filename exceeds maximum length");

    await expect(
      createAttachment(
        app.db,
        {
          organizationId: admin.organizationId,
          mimeType: "application/octet-stream",
          filename: "\ud800",
          body: Buffer.from("invalid unicode"),
          uploadedBy: admin.humanAgentUuid,
        },
        TEST_ATTACHMENT_QUOTA,
      ),
    ).rejects.toThrow("Attachment filename must contain valid Unicode characters");
  });

  it("rejects a mismatched declared byte length", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `length-${crypto.randomUUID().slice(0, 6)}` });
    await expect(
      createAttachment(
        app.db,
        {
          organizationId: admin.organizationId,
          mimeType: "application/octet-stream",
          filename: "length.bin",
          body: Buffer.from("three"),
          contentLength: 3,
          uploadedBy: admin.humanAgentUuid,
        },
        TEST_ATTACHMENT_QUOTA,
      ),
    ).rejects.toThrow("Content-Length does not match");
  });

  it("rejects oversize at bodyLimit (413) or service cap (400)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `os-${crypto.randomUUID().slice(0, 6)}` });
    // 1 KB over the cap — well under the route bodyLimit, so the service-
    // layer cap is what fires.
    const oversize = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1024);
    const reply = await postAttachment(app, admin, oversize);
    expect([400, 413]).toContain(reply.statusCode);
  });

  it("rejects filenames that could overflow the encoded response header", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `name-limit-${crypto.randomUUID().slice(0, 6)}` });
    const filename = ";".repeat(MAX_ATTACHMENT_FILENAME_BYTES + 1);
    const reply = await postAttachment(app, admin, Buffer.from("too long"), {
      filename: encodeURIComponent(filename),
    });
    expect(reply.statusCode).toBe(400);
    expect(reply.json<{ error: string }>().error).toContain("Attachment filename exceeds maximum length");
  });

  it("accepts an encoded filename after trimming request padding", async () => {
    const isolatedApp = await createTestApp();
    try {
      const admin = await createTestAdmin(isolatedApp, {
        username: `padded-name-${crypto.randomUUID().slice(0, 6)}`,
      });
      await isolatedApp.listen({ port: 0, host: "127.0.0.1" });
      const address = isolatedApp.server.address();
      if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP address");
      const sdk = new FirstTreeHubSDK({
        serverUrl: `http://127.0.0.1:${address.port}`,
        agentId: admin.humanAgentUuid,
        runtimeSessionToken: "test-runtime-session",
        userAgent: "first-tree-test",
        getAccessToken: () => admin.accessToken,
      });

      await expect(
        sdk.uploadAttachment({
          orgId: admin.organizationId,
          bytes: Buffer.from("padded"),
          mimeType: "text/plain",
          filename: `${" ".repeat(6000)}padded.txt `,
        }),
      ).resolves.toMatchObject({ filename: "padded.txt" });
    } finally {
      await isolatedApp.close();
    }
  });

  it("returns 404 for unknown attachment id", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `nf-${crypto.randomUUID().slice(0, 6)}` });
    const reply = await getAttachment(app, admin, "00000000-0000-4000-8000-000000000000");
    expect(reply.statusCode).toBe(404);
  });

  it("rejects upload to an org the caller is not a member of (403)", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `noorg-${crypto.randomUUID().slice(0, 6)}` });

    const foreignOrgId = uuidv7();
    await app.db
      .insert(organizations)
      .values({ id: foreignOrgId, name: foreignOrgId.slice(0, 30), displayName: "Foreign Org" });

    const reply = await postAttachment(app, admin, Buffer.from("nope"), { orgId: foreignOrgId });
    expect(reply.statusCode).toBe(403);
  });

  it("uploaded_by is determined by the org in the path (multi-org caller)", async () => {
    const app = getApp();
    const admin = await createAdminContext(app, { username: `mo-${crypto.randomUUID().slice(0, 6)}` });

    // Seed a second org with a brand-new humanAgent for the same user.
    const otherOrgId = uuidv7();
    await app.db
      .insert(organizations)
      .values({ id: otherOrgId, name: otherOrgId.slice(0, 30), displayName: "Other Org" });
    const otherMember = await ensureMembership(app.db, {
      userId: admin.userId,
      organizationId: otherOrgId,
      role: "member",
      displayName: "Other Org Agent",
      username: admin.username,
    });

    // Upload via the first org → uploaded_by = first org's humanAgent.
    const first = await postAttachment(app, admin, Buffer.from("first"));
    expect(first.statusCode).toBe(201);
    expect((first.json() as { uploadedBy: string }).uploadedBy).toBe(admin.humanAgentUuid);

    // Upload via the second org → uploaded_by = second org's humanAgent.
    const second = await postAttachment(app, admin, Buffer.from("second"), { orgId: otherOrgId });
    expect(second.statusCode).toBe(201);
    expect((second.json() as { uploadedBy: string }).uploadedBy).toBe(otherMember.agentId);
  });
});

describe("organization attachment object quota", () => {
  const getApp = useTestApp();

  it("enforces the caller-supplied object quota at the service layer", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `quota-${crypto.randomUUID().slice(0, 6)}` });
    const quota = { maxOrganizationAttachments: 2 };
    const input = (name: string) => ({
      organizationId: admin.organizationId,
      mimeType: "application/octet-stream",
      filename: name,
      body: Buffer.from(name),
      uploadedBy: admin.humanAgentUuid,
    });

    await createAttachment(app.db, input("quota-1.bin"), quota);
    await createAttachment(app.db, input("quota-2.bin"), quota);
    await expect(createAttachment(app.db, input("quota-3.bin"), quota)).rejects.toThrow(
      "Organization attachment quota of 2 objects exceeded",
    );
  });
});

describe("organization attachment object quota — route wiring", () => {
  const getApp = useTestApp({ attachmentObjectQuota: 2 });

  it("rejects the upload beyond the deployment-configured object quota", async () => {
    const app = getApp();
    const admin = await createTestAdmin(app, { username: `quota-route-${crypto.randomUUID().slice(0, 6)}` });

    expect((await postAttachment(app, admin, Buffer.from("one"), { filename: "one.bin" })).statusCode).toBe(201);
    expect((await postAttachment(app, admin, Buffer.from("two"), { filename: "two.bin" })).statusCode).toBe(201);
    const third = await postAttachment(app, admin, Buffer.from("three"), { filename: "three.bin" });
    expect(third.statusCode).toBe(400);
    expect(third.json<{ error: string }>().error).toContain("Organization attachment quota of 2 objects exceeded");
  });
});
