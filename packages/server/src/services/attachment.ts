import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  getAttachmentFilenameError,
  MAX_ATTACHMENT_BYTES,
  MESSAGE_ATTACHMENT_RETENTION_DAYS,
} from "@first-tree/shared";
import { and, asc, eq, inArray, isNotNull, isNull, lt, ne, or, type SQLWrapper, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agentTemplates } from "../db/schema/agent-templates.js";
import { attachments } from "../db/schema/attachments.js";
import { messages } from "../db/schema/messages.js";
import { resources } from "../db/schema/resources.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import { createLogger } from "../observability/index.js";
import type { AttachmentBlobStore } from "./attachment-blob-store.js";

const log = createLogger("attachment");

export const MAX_ORGANIZATION_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_CONCURRENT_ATTACHMENT_UPLOADS_PER_CALLER = 3;
export const ORPHAN_ATTACHMENT_AGE_MS = 24 * 60 * 60 * 1_000;

/**
 * Deployment-resolved attachment object quota. Every creation path must pass
 * the value parsed at server startup
 * (`attachments.organizationObjectQuota`, env
 * `FIRST_TREE_ATTACHMENT_ORG_QUOTA_COUNT`) so HTTP uploads, Feishu inbound
 * hydration, Skill bundle backfills, and Template adoption copies all enforce
 * the same limit.
 */
export type AttachmentObjectQuota = {
  maxOrganizationAttachments: number;
};

export type AttachmentRow = typeof attachments.$inferSelect;

export type CreateAttachmentInput = {
  /** Optional caller-supplied id (UUIDv4). Generated when absent. */
  id?: string;
  organizationId: string;
  mimeType: string;
  filename: string;
  body: Buffer | Readable;
  /** Parsed Content-Length, when the transport supplied one. */
  contentLength?: number;
  /** Stable uploader actor id (member uuid or a trusted integration actor id). */
  uploadedBy: string;
};

/**
 * Reserve team quota, read one bounded upload, and publish the immutable
 * bytes together with their metadata in PostgreSQL.
 */
export async function createAttachment(
  db: Database,
  input: CreateAttachmentInput,
  quota: AttachmentObjectQuota,
): Promise<AttachmentRow> {
  validateCreateInput(input);
  const id = input.id ?? randomUUID();
  const reservedBytes = input.contentLength ?? MAX_ATTACHMENT_BYTES;

  await db.transaction(async (tx) => {
    const targetDb = tx as unknown as Database;
    await lockOrganizationAttachmentQuota(targetDb, input.organizationId);
    await assertCallerUploadConcurrency(targetDb, input.organizationId, input.uploadedBy);
    await assertOrganizationQuota(
      targetDb,
      input.organizationId,
      {
        additionalObjects: 1,
        additionalBytes: reservedBytes,
      },
      quota,
    );
    await targetDb.insert(attachments).values({
      id,
      organizationId: input.organizationId,
      objectKey: null,
      lifecycleState: "uploading",
      mimeType: input.mimeType.trim(),
      filename: input.filename.trim(),
      sizeBytes: reservedBytes,
      data: null,
      uploadedBy: input.uploadedBy,
    });
  });

  let bytes: Buffer;
  try {
    bytes = await readAttachmentBody(input.body, input.contentLength);
  } catch (error) {
    try {
      await db.delete(attachments).where(and(eq(attachments.id, id), eq(attachments.lifecycleState, "uploading")));
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Attachment upload and reservation cleanup both failed");
    }
    throw error;
  }

  try {
    return await db.transaction(async (tx) => {
      const targetDb = tx as unknown as Database;
      await lockOrganizationAttachmentQuota(targetDb, input.organizationId);
      await assertOrganizationQuota(
        targetDb,
        input.organizationId,
        {
          excludeId: id,
          additionalObjects: 1,
          additionalBytes: bytes.byteLength,
        },
        quota,
      );
      const [row] = await targetDb
        .update(attachments)
        .set({
          data: bytes,
          lifecycleState: "ready",
          sizeBytes: bytes.byteLength,
          updatedAt: new Date(),
        })
        .where(and(eq(attachments.id, id), eq(attachments.lifecycleState, "uploading")))
        .returning();
      if (!row) throw new Error("Attachment reservation disappeared before PostgreSQL publish");
      return row;
    });
  } catch (error) {
    try {
      await db.delete(attachments).where(and(eq(attachments.id, id), eq(attachments.lifecycleState, "uploading")));
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Attachment publish and reservation cleanup both failed");
    }
    throw error;
  }
}

async function readAttachmentBody(body: Buffer | Readable, contentLength?: number): Promise<Buffer> {
  const source = Buffer.isBuffer(body) ? Readable.from([body]) : body;
  const chunks: Buffer[] = [];
  let measuredBytes = 0;
  for await (const chunk of source) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    measuredBytes += bytes.byteLength;
    if (measuredBytes > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestError(`Attachment exceeds maximum size of ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    chunks.push(bytes);
  }
  if (measuredBytes === 0) throw new BadRequestError("Attachment is empty");
  if (contentLength !== undefined && measuredBytes !== contentLength) {
    throw new BadRequestError("Attachment Content-Length does not match the uploaded bytes");
  }
  return Buffer.concat(chunks, measuredBytes);
}

function validateCreateInput(input: CreateAttachmentInput): void {
  if (input.organizationId.trim().length === 0) {
    throw new BadRequestError("Attachment organization is required");
  }
  if (input.mimeType.trim().length === 0) {
    throw new BadRequestError("Attachment mime type is required");
  }
  const filenameError = getAttachmentFilenameError(input.filename);
  if (filenameError) throw new BadRequestError(filenameError);
  if (input.contentLength !== undefined) {
    if (!Number.isSafeInteger(input.contentLength) || input.contentLength <= 0) {
      throw new BadRequestError("Attachment Content-Length must be a positive integer");
    }
    if (input.contentLength > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestError(`Attachment exceeds maximum size of ${MAX_ATTACHMENT_BYTES} bytes`);
    }
  }
}

async function assertCallerUploadConcurrency(db: Database, organizationId: string, uploadedBy: string): Promise<void> {
  const [usage] = await db
    .select({ activeCount: sql<number>`count(*)` })
    .from(attachments)
    .where(
      and(
        eq(attachments.organizationId, organizationId),
        eq(attachments.uploadedBy, uploadedBy),
        eq(attachments.lifecycleState, "uploading"),
      ),
    );
  const activeCount = Number(usage?.activeCount ?? 0);
  if (activeCount >= MAX_CONCURRENT_ATTACHMENT_UPLOADS_PER_CALLER) {
    throw new ConflictError(
      `Caller already has ${MAX_CONCURRENT_ATTACHMENT_UPLOADS_PER_CALLER} attachment uploads in progress`,
    );
  }
}

async function lockOrganizationAttachmentQuota(db: Database, organizationId: string): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('organization_attachment_quota'), hashtext(${organizationId}))`,
  );
}

async function assertOrganizationQuota(
  db: Database,
  organizationId: string,
  input: {
    excludeId?: string;
    additionalObjects: number;
    additionalBytes: number;
  },
  quota: AttachmentObjectQuota,
): Promise<void> {
  const conditions = [
    eq(attachments.organizationId, organizationId),
    inArray(attachments.lifecycleState, ["uploading", "ready", "deleting"]),
  ];
  if (input.excludeId) conditions.push(ne(attachments.id, input.excludeId));
  const [usage] = await db
    .select({
      objectCount: sql<number>`count(*)`,
      sizeBytes: sql<number>`coalesce(sum(${attachments.sizeBytes}), 0)`,
    })
    .from(attachments)
    .where(and(...conditions));
  const objectCount = Number(usage?.objectCount ?? 0);
  const sizeBytes = Number(usage?.sizeBytes ?? 0);
  if (objectCount + input.additionalObjects > quota.maxOrganizationAttachments) {
    throw new BadRequestError(`Organization attachment quota of ${quota.maxOrganizationAttachments} objects exceeded`);
  }
  if (sizeBytes + input.additionalBytes > MAX_ORGANIZATION_ATTACHMENT_BYTES) {
    throw new BadRequestError(`Organization attachment quota of ${MAX_ORGANIZATION_ATTACHMENT_BYTES} bytes exceeded`);
  }
}

/** Everything in `AttachmentRow` except the PostgreSQL payload and legacy pointer. */
export type AttachmentMeta = Omit<AttachmentRow, "data" | "objectKey">;

/**
 * Copy a ready attachment's bytes into another organization as a brand-new
 * ready row, inside the caller's transaction. Used by Agent Template
 * adoption: the adopting Team gets its own byte copy of the official Skill
 * bundle, so the Publisher Team's attachment lifecycle can never break an
 * adopted Resource. Quota accounting follows the normal upload path; a
 * failing copy rolls back with the surrounding transaction and leaves no
 * orphan.
 */
export async function copyAttachmentForOrganization(
  db: Database,
  blobStore: AttachmentBlobStore,
  sourceId: string,
  targetOrganizationId: string,
  uploadedBy: string,
  quota: AttachmentObjectQuota,
): Promise<AttachmentRow> {
  // Quota-first, matching the normal upload path: the target Team's advisory
  // lock is always taken before any source row lock, so concurrent
  // adoptions cannot interleave source-lock → quota-lock into a cycle.
  await lockOrganizationAttachmentQuota(db, targetOrganizationId);
  const [source] = await db.select().from(attachments).where(eq(attachments.id, sourceId)).for("update").limit(1);
  if (!source || source.lifecycleState !== "ready" || (source.data === null && source.objectKey === null)) {
    throw new BadRequestError("Source attachment is not a ready attachment with available bytes");
  }
  let bytes: Buffer;
  if (source.data) {
    if (source.data.byteLength !== source.sizeBytes) {
      throw new BadRequestError("Source attachment byte length does not match its metadata");
    }
    bytes = source.data;
  } else if (source.objectKey) {
    // Legacy external-store row: read through the blob store and persist the
    // copy PostgreSQL-backed like every new upload.
    bytes = await readAttachmentBody(await blobStore.get(source.objectKey), source.sizeBytes);
  } else {
    throw new BadRequestError("Source attachment bytes are unavailable");
  }
  await assertOrganizationQuota(
    db,
    targetOrganizationId,
    {
      additionalObjects: 1,
      additionalBytes: bytes.byteLength,
    },
    quota,
  );
  const id = randomUUID();
  const [row] = await db
    .insert(attachments)
    .values({
      id,
      organizationId: targetOrganizationId,
      objectKey: null,
      lifecycleState: "ready",
      mimeType: source.mimeType,
      filename: source.filename,
      sizeBytes: bytes.byteLength,
      data: bytes,
      uploadedBy,
    })
    .returning();
  if (!row) throw new Error("Attachment copy insert returned no row");
  return row;
}

export type AttachmentReader = Pick<Database, "select">;

export async function loadAttachmentMeta(db: AttachmentReader, id: string): Promise<AttachmentMeta | null> {
  const [row] = await db
    .select({
      id: attachments.id,
      organizationId: attachments.organizationId,
      lifecycleState: attachments.lifecycleState,
      mimeType: attachments.mimeType,
      filename: attachments.filename,
      sizeBytes: attachments.sizeBytes,
      uploadedBy: attachments.uploadedBy,
      createdAt: attachments.createdAt,
      updatedAt: attachments.updatedAt,
    })
    .from(attachments)
    .where(
      and(
        eq(attachments.id, id),
        eq(attachments.lifecycleState, "ready"),
        or(isNotNull(attachments.data), isNotNull(attachments.objectKey)),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Validate a reference while holding a lock that conflicts with orphan
 * cleanup. When called inside the message write transaction, the lock remains
 * held until the message row is committed.
 */
export async function loadAttachmentMetaForReference(db: AttachmentReader, id: string): Promise<AttachmentMeta | null> {
  const [row] = await db
    .select({
      id: attachments.id,
      organizationId: attachments.organizationId,
      lifecycleState: attachments.lifecycleState,
      mimeType: attachments.mimeType,
      filename: attachments.filename,
      sizeBytes: attachments.sizeBytes,
      uploadedBy: attachments.uploadedBy,
      createdAt: attachments.createdAt,
      updatedAt: attachments.updatedAt,
    })
    .from(attachments)
    .where(
      and(
        eq(attachments.id, id),
        eq(attachments.lifecycleState, "ready"),
        or(isNotNull(attachments.data), isNotNull(attachments.objectKey)),
      ),
    )
    .for("key share")
    .limit(1);
  return row ?? null;
}

/**
 * Prefer the authoritative PostgreSQL payload. The legacy object-store read
 * path remains only for rows that have not completed the reverse backfill.
 */
export async function openAttachmentStream(
  db: Database,
  blobStore: AttachmentBlobStore,
  id: string,
): Promise<Readable | null> {
  const [row] = await db
    .select({
      objectKey: attachments.objectKey,
      lifecycleState: attachments.lifecycleState,
      data: attachments.data,
    })
    .from(attachments)
    .where(eq(attachments.id, id))
    .limit(1);
  if (!row || row.lifecycleState !== "ready") return null;
  if (row.data) return Readable.from([row.data]);
  if (!row.objectKey) return null;
  try {
    return await blobStore.get(row.objectKey);
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

/**
 * Team Skill Resources and official Agent Template bundles are the
 * authoritative, permanently-protected references: an attachment held by
 * either must survive every cleanup path until the last such reference is
 * explicitly released. Message references do NOT protect against the 14-day
 * retention sweep, so this check is kept separate from
 * `isAttachmentReferenced`.
 */
export async function isAttachmentProtectedByBundleReference(db: Database, id: string): Promise<boolean> {
  const [resourceRef] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(eq(resources.bundleAttachmentId, id))
    .limit(1);
  if (resourceRef) return true;

  // Official Agent Template Skill components hold immutable complete-directory
  // ZIP bundles at `payload.components[].bundle.attachmentId`. A bundle
  // referenced only by a Template must survive the orphan sweep until every
  // Template releases it. The CASE keeps malformed payload rows (non-array
  // `components`) out of jsonb_array_elements deterministically — boolean
  // reordering means an outer AND guard is not a reliable barrier, and one
  // raising row would break the whole sweep. Valid schemaVersion=1 payloads
  // always carry an array here.
  const [templateRef] = await db
    .select({ id: agentTemplates.id })
    .from(agentTemplates)
    .where(
      sql`EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(${agentTemplates.payload} -> 'components') = 'array'
            THEN ${agentTemplates.payload} -> 'components'
            ELSE '[]'::jsonb
          END
        ) AS component
        WHERE component -> 'bundle' ->> 'attachmentId' = ${id}
      )`,
    )
    .limit(1);
  return !!templateRef;
}

/**
 * Four JSONB shapes that count as a message reference to an attachment.
 * Kept as one SQL owner so `isAttachmentReferenced` and the retention
 * selector cannot drift. Expressions match the existing btree
 * (`content ->> 'imageId'`) and GIN jsonb_path_ops indexes
 * (`content -> 'attachments'`, `metadata -> 'attachments'`).
 */
function messageReferencesAttachmentSql(attachmentId: SQLWrapper) {
  return sql`(
    ${messages.content} ->> 'imageId' = (${attachmentId})::text
    OR ${messages.content} -> 'attachments' @> jsonb_build_array(jsonb_build_object('imageId', (${attachmentId})::text))
    OR ${messages.content} -> 'attachments' @> jsonb_build_array(jsonb_build_object('attachmentId', (${attachmentId})::text))
    OR ${messages.metadata} -> 'attachments' @> jsonb_build_array(jsonb_build_object('attachmentId', (${attachmentId})::text))
  )`;
}

function messageReferencesAttachmentExistsSql(attachmentId: SQLWrapper) {
  return sql`EXISTS (
    SELECT 1 FROM ${messages}
    WHERE ${messageReferencesAttachmentSql(attachmentId)}
  )`;
}

async function isAttachmentReferencedByMessage(db: Database, id: string): Promise<boolean> {
  const [messageRef] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(messageReferencesAttachmentSql(sql`${id}`))
    .limit(1);
  return !!messageRef;
}

export async function isAttachmentReferenced(db: Database, id: string): Promise<boolean> {
  if (await isAttachmentProtectedByBundleReference(db, id)) return true;
  return isAttachmentReferencedByMessage(db, id);
}

/** Delete an immutable PostgreSQL row only after every known consumer releases it. */
export async function deleteAttachmentIfUnreferenced(
  db: Database,
  blobStore: AttachmentBlobStore,
  id: string,
  options: { orphanCutoff?: Date } = {},
): Promise<boolean> {
  let legacyObjectKey: string | null = null;
  let deletePostgresRow = false;
  await db.transaction(async (tx) => {
    const targetDb = tx as unknown as Database;
    const [row] = await targetDb
      .select({
        id: attachments.id,
        objectKey: attachments.objectKey,
        lifecycleState: attachments.lifecycleState,
        updatedAt: attachments.updatedAt,
      })
      .from(attachments)
      .where(eq(attachments.id, id))
      .for("update")
      .limit(1);
    if (!row) return;
    if (
      options.orphanCutoff &&
      row.lifecycleState !== "deleting" &&
      !((row.lifecycleState === "uploading" || row.lifecycleState === "ready") && row.updatedAt < options.orphanCutoff)
    ) {
      return;
    }
    if (await isAttachmentReferenced(targetDb, id)) {
      if (row.lifecycleState !== "deleting") {
        await targetDb.update(attachments).set({ updatedAt: new Date() }).where(eq(attachments.id, id));
      }
      return;
    }
    legacyObjectKey = row.objectKey;
    deletePostgresRow = true;
    if (legacyObjectKey) {
      await targetDb
        .update(attachments)
        .set({ lifecycleState: "deleting", updatedAt: new Date() })
        .where(eq(attachments.id, id));
      return;
    }
    await targetDb.delete(attachments).where(eq(attachments.id, id));
  });
  if (!deletePostgresRow) return false;
  if (!legacyObjectKey) return true;
  await blobStore.delete(legacyObjectKey);
  await db.delete(attachments).where(and(eq(attachments.id, id), eq(attachments.lifecycleState, "deleting")));
  return true;
}

/**
 * Remove uploads that stayed unreferenced for the 24-hour grace period.
 * Transitional S3 copies are deleted before their PostgreSQL lifecycle row.
 */
export async function sweepOrphanAttachments(
  db: Database,
  blobStore: AttachmentBlobStore,
  now = new Date(),
  batchSize = 100,
): Promise<{ examined: number; deleted: number }> {
  const cutoff = new Date(now.getTime() - ORPHAN_ATTACHMENT_AGE_MS);
  const candidates = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(
      or(
        eq(attachments.lifecycleState, "deleting"),
        and(inArray(attachments.lifecycleState, ["uploading", "ready"]), lt(attachments.updatedAt, cutoff)),
      ),
    )
    .limit(batchSize);
  let deleted = 0;
  for (const candidate of candidates) {
    try {
      if (await deleteAttachmentIfUnreferenced(db, blobStore, candidate.id, { orphanCutoff: cutoff })) deleted++;
    } catch (error) {
      // Keep the row for the next retry.
      log.warn({ err: error, attachmentId: candidate.id }, "orphan attachment cleanup will retry");
    }
  }
  return { examined: candidates.length, deleted };
}

/**
 * Message-class attachments (chat images/documents, Feishu inbound resources)
 * expire after {@link MESSAGE_ATTACHMENT_RETENTION_DAYS} even while historical
 * messages still reference them — messages stay immutable and render an
 * explicit expired/unavailable state. Eligibility is positive: a row must
 * actually be referenced by a message. Attachments held by a Team Skill
 * Resource or an Agent Template bundle are permanently protected and never
 * expire here. After the last bundle reference is released, a remaining
 * message reference still makes the row retention-eligible; with no message
 * reference, the release/orphan lifecycle reclaims it.
 */
export const MESSAGE_ATTACHMENT_RETENTION_MS = MESSAGE_ATTACHMENT_RETENTION_DAYS * 24 * 60 * 60 * 1_000;

export type AttachmentRetentionSweepOptions = {
  /**
   * false (the deployment default) runs a dry-run: the sweep only counts and
   * logs eligible rows. true actually deletes them. Rollback = flip back to
   * false; already-deleted bytes can only be restored from a database backup.
   */
  deleteEnabled: boolean;
  now?: Date;
  batchSize?: number;
  /** Hard cap on batches per run so one daily sweep stays bounded; the next run resumes where this one stopped. */
  maxBatches?: number;
};

export type AttachmentRetentionSweepResult = {
  eligibleObjects: number;
  eligibleBytes: number;
  deleted: number;
  reclaimedBytes: number;
  batches: number;
};

/**
 * Eligible = ready, older than the retention window, referenced by at least
 * one message, and not protected by any Resource/Template bundle reference.
 * The positive message EXISTS keeps generic (non-message) attachments out of
 * this sweep. Excluding protected rows in SQL keeps long-lived bundles from
 * permanently filling each batch and starving ordinary message attachments.
 */
function retentionEligibleConditions(cutoff: Date) {
  return and(
    eq(attachments.lifecycleState, "ready"),
    lt(attachments.createdAt, cutoff),
    messageReferencesAttachmentExistsSql(attachments.id),
    sql`NOT EXISTS (
      SELECT 1 FROM ${resources}
      WHERE ${resources.bundleAttachmentId} = ${attachments.id}
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${agentTemplates}
      WHERE EXISTS (
        SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(${agentTemplates.payload} -> 'components') = 'array'
            THEN ${agentTemplates.payload} -> 'components'
            ELSE '[]'::jsonb
          END
        ) AS component
        WHERE component -> 'bundle' ->> 'attachmentId' = ${attachments.id}
      )
    )`,
  );
}

/**
 * Delete one expired message-class attachment. The row is locked FOR UPDATE —
 * which conflicts with the FOR KEY SHARE reference lock the Skill/Template
 * bind path takes — and both the message-class proof and the bundle
 * protections are re-checked inside the transaction, so a reference that
 * lands (or a message reference that disappears) between candidate selection
 * and deletion is always honored.
 */
async function deleteExpiredAttachmentIfUnprotected(
  db: Database,
  blobStore: AttachmentBlobStore,
  id: string,
): Promise<boolean> {
  let legacyObjectKey: string | null = null;
  let deletePostgresRow = false;
  await db.transaction(async (tx) => {
    const targetDb = tx as unknown as Database;
    const [row] = await targetDb
      .select({
        id: attachments.id,
        objectKey: attachments.objectKey,
        lifecycleState: attachments.lifecycleState,
      })
      .from(attachments)
      .where(eq(attachments.id, id))
      .for("update")
      .limit(1);
    if (!row || row.lifecycleState !== "ready") return;
    if (await isAttachmentProtectedByBundleReference(targetDb, id)) return;
    if (!(await isAttachmentReferencedByMessage(targetDb, id))) return;
    legacyObjectKey = row.objectKey;
    deletePostgresRow = true;
    if (legacyObjectKey) {
      await targetDb
        .update(attachments)
        .set({ lifecycleState: "deleting", updatedAt: new Date() })
        .where(eq(attachments.id, id));
      return;
    }
    await targetDb.delete(attachments).where(eq(attachments.id, id));
  });
  if (!deletePostgresRow) return false;
  if (!legacyObjectKey) return true;
  await blobStore.delete(legacyObjectKey);
  await db.delete(attachments).where(and(eq(attachments.id, id), eq(attachments.lifecycleState, "deleting")));
  return true;
}

/**
 * Daily retention sweep for expired message-class attachments. Dry-run by
 * default; with deletion enabled it processes bounded batches (oldest first)
 * so a large backlog cannot monopolize the database in one run — remaining
 * candidates are picked up by the next daily run.
 */
export async function sweepExpiredMessageAttachments(
  db: Database,
  blobStore: AttachmentBlobStore,
  options: AttachmentRetentionSweepOptions,
): Promise<AttachmentRetentionSweepResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 100;
  const maxBatches = options.maxBatches ?? 10;
  const cutoff = new Date(now.getTime() - MESSAGE_ATTACHMENT_RETENTION_MS);
  const conditions = retentionEligibleConditions(cutoff);

  const [usage] = await db
    .select({
      objectCount: sql<number>`count(*)`,
      sizeBytes: sql<number>`coalesce(sum(${attachments.sizeBytes}), 0)`,
    })
    .from(attachments)
    .where(conditions);
  const eligibleObjects = Number(usage?.objectCount ?? 0);
  const eligibleBytes = Number(usage?.sizeBytes ?? 0);

  if (!options.deleteEnabled) {
    // Always log, even at zero — a silent dry-run leaves operators unable to
    // tell "nothing to clean" from "the sweep never ran". Resolve the logger at
    // call time so the live createLogger export remains observable after this
    // module has already been evaluated.
    createLogger("attachment").info(
      { eligibleObjects, eligibleBytes, cutoff },
      "attachment retention sweep dry-run — no rows deleted",
    );
    return { eligibleObjects, eligibleBytes, deleted: 0, reclaimedBytes: 0, batches: 0 };
  }

  let deleted = 0;
  let reclaimedBytes = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const candidates = await db
      .select({ id: attachments.id, sizeBytes: attachments.sizeBytes })
      .from(attachments)
      .where(conditions)
      .orderBy(asc(attachments.createdAt))
      .limit(batchSize);
    if (candidates.length === 0) break;
    batches++;
    for (const candidate of candidates) {
      try {
        if (await deleteExpiredAttachmentIfUnprotected(db, blobStore, candidate.id)) {
          deleted++;
          reclaimedBytes += candidate.sizeBytes;
        }
      } catch (error) {
        // Keep the row for the next daily run.
        log.warn({ err: error, attachmentId: candidate.id }, "expired attachment cleanup will retry");
      }
    }
  }
  if (deleted > 0) {
    log.info(
      { deleted, reclaimedBytes, eligibleObjects, eligibleBytes, batches },
      "attachment retention sweep deleted expired message attachments",
    );
  }
  return { eligibleObjects, eligibleBytes, deleted, reclaimedBytes, batches };
}

/**
 * Expand phase for reverting #2062: copy S3-only payloads back into
 * PostgreSQL with a compare-and-set update. Keep `objectKey` and the S3 copy
 * until every pre-transition replica has drained, because those replicas
 * still prefer S3 whenever the pointer is present.
 */
export async function backfillExternalAttachmentsToPostgres(
  db: Database,
  blobStore: AttachmentBlobStore,
  batchSize = 25,
): Promise<{ migrated: number; skipped: number }> {
  const rows = await db
    .select({
      id: attachments.id,
      objectKey: attachments.objectKey,
      sizeBytes: attachments.sizeBytes,
    })
    .from(attachments)
    .where(and(eq(attachments.lifecycleState, "ready"), isNull(attachments.data), isNotNull(attachments.objectKey)))
    .limit(batchSize);
  let migrated = 0;
  let skipped = 0;
  for (const row of rows) {
    if (!row.objectKey) {
      skipped++;
      continue;
    }
    try {
      const stream = await blobStore.get(row.objectKey);
      const bytes = await readAttachmentBody(stream, row.sizeBytes);
      const [updated] = await db
        .update(attachments)
        .set({ data: bytes, updatedAt: new Date() })
        .where(
          and(
            eq(attachments.id, row.id),
            eq(attachments.lifecycleState, "ready"),
            eq(attachments.objectKey, row.objectKey),
            isNull(attachments.data),
          ),
        )
        .returning({ id: attachments.id });
      if (updated) migrated++;
      else skipped++;
    } catch (error) {
      skipped++;
      log.warn(
        { err: error, attachmentId: row.id, objectKey: row.objectKey },
        "legacy S3 attachment reverse backfill will retry",
      );
    }
  }
  return { migrated, skipped };
}
