import type { FileHandle } from "node:fs/promises";
import { AppError } from "../../../errors.js";

/** Largest preview this API will return, in bytes. */
export const MAX_DOC_BYTES = 5 * 1024 * 1024;

/**
 * Read at most `MAX_DOC_BYTES` from an already-validated descriptor.
 *
 * `handle.readFile()` reads until EOF, so a file that grows between the size
 * check and the read could return more than the preview limit (SEC-020). Reading
 * one byte past the limit makes the overflow visible instead of silently
 * truncating it.
 */
export async function readBounded(handle: Pick<FileHandle, "read">): Promise<string> {
  const buffer = Buffer.alloc(MAX_DOC_BYTES + 1);
  let filled = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
    if (filled > MAX_DOC_BYTES) {
      throw new AppError(413, "Document is larger than the 5MB preview limit");
    }
  }
  return buffer.subarray(0, filled).toString("utf8");
}
