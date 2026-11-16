import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { MAX_DOC_BYTES, readBounded } from "../services/chat/workspace/bounded-read.js";

/**
 * SEC-020 follow-up: the descriptor check is only worth something if the read
 * from that same descriptor is bounded too. A file that passes the 5 MiB size
 * check and then grows must not stream past the limit into the response.
 *
 * The helper takes the descriptor, so the test drives it with a fake `read`
 * instead of mocking a Node builtin — no module-cache or file-order coupling.
 */
function descriptor(payload: Buffer): { reads: number; read: () => Promise<{ bytesRead: number; buffer: Buffer }> } {
  const fake = {
    reads: 0,
    // eslint-disable-next-line @typescript-eslint/require-await
    read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      fake.reads += 1;
      const slice = payload.subarray(position, position + length);
      buffer.set(slice, offset);
      return { bytesRead: slice.length, buffer };
    },
  };
  return fake as unknown as { reads: number; read: () => Promise<{ bytesRead: number; buffer: Buffer }> };
}

describe("readBounded", () => {
  it("returns the content of a file that fits", async () => {
    const handle = descriptor(Buffer.from("# Guide", "utf8"));
    await expect(readBounded(handle)).resolves.toBe("# Guide");
  });

  it("returns 413 when the descriptor yields more than the preview limit", async () => {
    // One byte past the limit: exactly the case a post-stat growth produces.
    const handle = descriptor(Buffer.alloc(MAX_DOC_BYTES + 1, "a"));

    const error = await readBounded(handle).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(413);
    expect((error as Error).message).toContain("5MB preview limit");
  });

  it("accepts a file of exactly the limit", async () => {
    const content = "a".repeat(MAX_DOC_BYTES);
    await expect(readBounded(descriptor(Buffer.from(content, "utf8")))).resolves.toBe(content);
  });

  it("stops at the first short read", async () => {
    const handle = descriptor(Buffer.from("short", "utf8"));
    await readBounded(handle);
    // One read returns the whole payload, the second returns 0 and ends it.
    expect(handle.reads).toBe(2);
  });
});
