import { mkdir, mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { MAX_DOC_BYTES } from "../services/chat/workspace/bounded-read.js";
import { getMeDocPreview } from "../services/chat/workspace/document-preview.js";

/**
 * SEC-020: the descriptor check is only worth something if the read from that
 * same descriptor is bounded too.
 *
 * A real file cannot be made to report one size and then serve more bytes on
 * demand, so the descriptor is injected (`openFile`) rather than mocked through
 * a Node builtin — that keeps the case deterministic and independent of module
 * cache / test-file order.
 */
const input = { chatId: "chat-1", agentId: "agent-1", agentName: "coder" };

async function fixture(): Promise<{ workspacesRoot: string; file: string }> {
  const workspacesRoot = await mkdtemp(join(tmpdir(), "first-tree-doc-growth-"));
  const workspaceRoot = join(workspacesRoot, input.agentName, input.chatId);
  await mkdir(workspaceRoot, { recursive: true });
  const file = join(workspaceRoot, "guide.md");
  await writeFile(file, "# Guide", "utf8");
  return { workspacesRoot, file };
}

/**
 * Descriptor-path answers: production reads `/proc/self/fd`, which does not
 * exist on every host, so the stub answers for the directory and then the file —
 * both truthful, so only the read bound is under test here.
 */
function truthfulAnswers(file: string): () => Promise<string | null> {
  let index = 0;
  return async () => {
    index += 1;
    return index === 1 ? dirname(file) : file;
  };
}

describe("getMeDocPreview byte bound", () => {
  it("returns 413 when the descriptor yields more than the preview limit", async () => {
    const { workspacesRoot, file } = await fixture();
    // The identity check compares the descriptor stat with the path stat, so the
    // fake reports the real inode and then serves one byte past the limit.
    const real = await stat(file);

    const error = await getMeDocPreview({
      ...input,
      path: "guide.md",
      workspacesRoot,
      readDescriptorPath: truthfulAnswers(await realpath(file)),
      openFile: async () =>
        ({
          stat: async () => real,
          read: async (buffer: Buffer, offset: number, length: number) => {
            const available = Math.min(length, MAX_DOC_BYTES + 1);
            buffer.fill("a", offset, offset + available);
            return { bytesRead: available, buffer };
          },
          readFile: async () => {
            throw new Error("readFile() is unbounded and must not be used");
          },
          close: async () => undefined,
        }) as never,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(413);
    expect((error as Error).message).toContain("5MB preview limit");
  });

  it("still reads a file that fits through the injected descriptor", async () => {
    const { workspacesRoot, file } = await fixture();
    const real = await stat(file);

    const preview = await getMeDocPreview({
      ...input,
      path: "guide.md",
      workspacesRoot,
      readDescriptorPath: truthfulAnswers(await realpath(file)),
      openFile: async () => {
        const bytes = Buffer.from("# Guide", "utf8");
        return {
          stat: async () => real,
          read: async (buffer: Buffer, offset: number, length: number, position: number) => {
            const slice = bytes.subarray(position, position + length);
            buffer.set(slice, offset);
            return { bytesRead: slice.length, buffer };
          },
          close: async () => undefined,
        } as never;
      },
    });

    expect(preview.content).toBe("# Guide");
    expect(preview.ref.path).toBe("guide.md");
  });
});
