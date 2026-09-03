import { createHash } from "node:crypto";
import { type Readable, Transform } from "node:stream";
import {
  type AttachmentRef,
  type FeishuResource,
  type FeishuResourceUnavailableReason,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_FILENAME_BYTES,
  MAX_MESSAGE_ATTACHMENT_REFS,
  SUPPORTED_IMAGE_MIMES,
  truncateUtf8ByBytes,
} from "@first-tree/shared";
import type { Database } from "../../../db/connection.js";
import { type AttachmentObjectQuota, createAttachment } from "../../attachment.js";
import type { FeishuResourceDescriptor } from "./content.js";

const SUPPORTED_IMAGE_MIME_SET = new Set<string>(SUPPORTED_IMAGE_MIMES);
const HYDRATION_CONCURRENCY = 2;

export type FeishuResourceDownload = {
  stream: Readable;
  headers?: Record<string, unknown>;
};

export type FeishuResourceDownloader = (input: {
  messageId: string;
  fileKey: string;
  type: "image" | "file";
}) => Promise<FeishuResourceDownload>;

export type HydratedFeishuResources = {
  resources: FeishuResource[];
  attachments: AttachmentRef[];
  unavailableNotes: string[];
};

export async function hydrateFeishuResources(
  db: Database,
  input: {
    organizationId: string;
    botBindingId: string;
    messageId: string;
    descriptors: readonly FeishuResourceDescriptor[];
    download: FeishuResourceDownloader;
    attachmentObjectQuota: AttachmentObjectQuota;
  },
): Promise<HydratedFeishuResources> {
  const results = new Array<HydratedOne>(input.descriptors.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(HYDRATION_CONCURRENCY, input.descriptors.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= input.descriptors.length) return;
      const descriptor = input.descriptors[index];
      if (!descriptor) continue;
      results[index] =
        index >= MAX_MESSAGE_ATTACHMENT_REFS
          ? unavailable(descriptor, "too_many", `每条消息最多保存 ${MAX_MESSAGE_ATTACHMENT_REFS} 个附件`)
          : await hydrateOne(db, input, descriptor);
    }
  });
  await Promise.all(workers);

  const attachments = results.flatMap((result) => (result?.attachment ? [result.attachment] : []));
  const resources = results.flatMap((result) => (result ? [result.resource] : []));
  const unavailableNotes = results.flatMap((result) => (result?.note ? [result.note] : []));
  return { attachments, resources, unavailableNotes };
}

type HydratedOne = { resource: FeishuResource; attachment?: AttachmentRef; note?: string };

async function hydrateOne(
  db: Database,
  input: Parameters<typeof hydrateFeishuResources>[1],
  descriptor: FeishuResourceDescriptor,
): Promise<HydratedOne> {
  if (descriptor.type === "sticker" || descriptor.origin === "interactive" || descriptor.origin === "merge_forward") {
    return unavailable(descriptor, "unsupported", "飞书不支持从该消息结构下载此资源");
  }

  try {
    const response = await input.download({
      messageId: input.messageId,
      fileKey: descriptor.fileKey,
      type: descriptor.type === "image" ? "image" : "file",
    });
    const contentLength = positiveHeaderInteger(response.headers, "content-length");
    if (contentLength !== undefined && contentLength > MAX_ATTACHMENT_BYTES) {
      response.stream.destroy();
      return unavailable(descriptor, "too_large", `资源大小超过 First Tree 的 ${MAX_ATTACHMENT_BYTES} 字节上限`);
    }

    const mimeType = normalizeMime(headerString(response.headers, "content-type"), descriptor);
    const filename = chooseFilename(descriptor, headerString(response.headers, "content-disposition"), mimeType);
    const digest = createHash("sha256");
    const hashingStream = new Transform({
      transform(chunk, _encoding, callback) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        digest.update(bytes);
        callback(null, bytes);
      },
    });
    response.stream.once("error", (error) => hashingStream.destroy(error));
    response.stream.pipe(hashingStream);
    const row = await createAttachment(
      db,
      {
        organizationId: input.organizationId,
        mimeType,
        filename,
        body: hashingStream,
        ...(contentLength !== undefined ? { contentLength } : {}),
        uploadedBy: `integration:feishu:${input.botBindingId}`,
      },
      input.attachmentObjectQuota,
    );
    const attachment: AttachmentRef = {
      attachmentId: row.id,
      kind: descriptor.type === "image" && SUPPORTED_IMAGE_MIME_SET.has(mimeType) ? "image" : "file",
      mimeType,
      filename: row.filename,
      size: row.sizeBytes,
      sha256: digest.digest("hex"),
    };
    return {
      attachment,
      resource: {
        ...baseResource(descriptor),
        hydration: {
          state: "succeeded",
          attachmentId: row.id,
          mimeType,
          size: row.sizeBytes,
        },
      },
    };
  } catch (error) {
    const reason = classifyUnavailable(error);
    return unavailable(descriptor, reason, safeErrorDetail(error));
  }
}

function unavailable(
  descriptor: FeishuResourceDescriptor,
  reason: FeishuResourceUnavailableReason,
  detail: string,
): HydratedOne {
  const label = descriptor.fileName || resourceLabel(descriptor.type);
  return {
    resource: {
      ...baseResource(descriptor),
      hydration: { state: "unavailable", reason, detail: detail.slice(0, 500) },
    },
    note: `飞书资源“${label}”不可用：${humanReason(reason)}`,
  };
}

function baseResource(descriptor: FeishuResourceDescriptor): Omit<FeishuResource, "hydration"> {
  return {
    type: descriptor.type,
    fileKey: descriptor.fileKey,
    fileName: descriptor.fileName ?? null,
    durationMs: descriptor.durationMs ?? null,
    coverImageKey: descriptor.coverImageKey ?? null,
    origin: descriptor.origin,
  };
}

function classifyUnavailable(error: unknown): FeishuResourceUnavailableReason {
  const message = safeErrorDetail(error).toLowerCase();
  const code = errorCode(error);
  if (message.includes("exceeds maximum") || message.includes("too large") || code === "234006") return "too_large";
  if (code === "234043" || message.includes("merge_forward") || message.includes("card message")) return "unsupported";
  if (code === "99991663" || code === "99991400" || message.includes("permission") || message.includes("forbidden")) {
    return "permission_denied";
  }
  if (message.includes("confidential") || message.includes("secret message")) return "confidential";
  if (message.includes("deleted") || message.includes("not found") || code === "230001") return "deleted";
  if (message.includes("empty") || message.includes("content-length")) return "invalid_response";
  return "download_failed";
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === "number" || typeof direct === "string") return String(direct);
  const response = (error as { response?: { data?: { code?: unknown }; status?: unknown } }).response;
  const nested = response?.data?.code ?? response?.status;
  return typeof nested === "number" || typeof nested === "string" ? String(nested) : null;
}

function safeErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 500) || "资源下载失败";
}

function headerString(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function positiveHeaderInteger(headers: Record<string, unknown> | undefined, name: string): number | undefined {
  const value = Number(headerString(headers, name));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function normalizeMime(value: string | undefined, descriptor: FeishuResourceDescriptor): string {
  const headerMime = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (headerMime && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(headerMime)) return headerMime;
  if (descriptor.type === "image") return mimeFromFilename(descriptor.fileName) ?? "image/jpeg";
  if (descriptor.type === "audio") return mimeFromFilename(descriptor.fileName) ?? "audio/ogg";
  if (descriptor.type === "video") return mimeFromFilename(descriptor.fileName) ?? "video/mp4";
  return mimeFromFilename(descriptor.fileName) ?? "application/octet-stream";
}

function chooseFilename(
  descriptor: FeishuResourceDescriptor,
  contentDisposition: string | undefined,
  mimeType: string,
): string {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition ?? "")?.[1];
  const plain = /filename="?([^";]+)"?/i.exec(contentDisposition ?? "")?.[1];
  let fromHeader: string | undefined;
  try {
    fromHeader = encoded ? decodeURIComponent(encoded) : plain;
  } catch {
    fromHeader = plain;
  }
  const raw = descriptor.fileName || fromHeader || `${resourceLabel(descriptor.type)}${extensionForMime(mimeType)}`;
  const sanitized = truncateUtf8ByBytes(
    Array.from(raw)
      .map((character) => {
        const code = character.charCodeAt(0);
        return character === "/" || character === "\\" || code < 32 || code === 127 ? "_" : character;
      })
      .join("")
      .trim(),
    MAX_ATTACHMENT_FILENAME_BYTES,
  );
  return sanitized || `feishu-resource${extensionForMime(mimeType)}`;
}

function mimeFromFilename(filename: string | undefined): string | null {
  const extension = filename?.toLowerCase().split(".").pop();
  return (
    (
      {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        pdf: "application/pdf",
        txt: "text/plain",
        md: "text/markdown",
        mp3: "audio/mpeg",
        opus: "audio/ogg",
        mp4: "video/mp4",
      } as Record<string, string>
    )[extension ?? ""] ?? null
  );
}

function extensionForMime(mimeType: string): string {
  return (
    (
      {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "audio/ogg": ".opus",
        "audio/mpeg": ".mp3",
        "video/mp4": ".mp4",
        "application/pdf": ".pdf",
      } as Record<string, string>
    )[mimeType] ?? ""
  );
}

function resourceLabel(type: FeishuResourceDescriptor["type"]): string {
  return { image: "图片", file: "文件", audio: "音频", video: "视频", sticker: "表情包" }[type];
}

function humanReason(reason: FeishuResourceUnavailableReason): string {
  return {
    too_many: "超过每条消息的附件数量上限",
    too_large: "超过 First Tree 的附件大小上限",
    permission_denied: "Bot 无权读取",
    confidential: "保密消息不允许下载",
    deleted: "资源已删除或不存在",
    unsupported: "飞书当前不支持下载此类资源",
    download_failed: "下载失败",
    invalid_response: "飞书返回了无效资源",
  }[reason];
}
