import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { getMeDocPreview } from "../services/chat/workspace/document-preview.js";

/**
 * SEC-020 follow-up: the descriptor check is only worth something if the read
 * from that same descriptor is bounded too. A file that passes a 5 MiB size
 * check and then grows — or a descriptor whose reported size is simply a lie —
 * must not stream past the limit into the response.
 */
const growth = vi.hoisted(() => ({ armed: false, payload: "" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (async (path: unknown, ...rest: unknown[]) => {
      const real = await (actual.open as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof actual.open>>>)(
        path,
        ...rest,
      );
      if (!growth.armed) return real;
      const reported = await real.stat();
      growth.armed = false;
      const bytes = Buffer.from(growth.payload, "utf8");
      return {
        stat: async () => reported,
        // Serves the payload while the reported stat above says it is small.
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const slice = bytes.subarray(position, position + length);
          buffer.set(slice, offset);
          return { bytesRead: slice.length, buffer };
        },
        close: async () => real.close(),
        readFile: async () => {
          throw new Error("readFile() is unbounded and must not be used");
        },
      };
    }) as typeof actual.open,
  };
});

const input = { chatId: "chat-1", agentId: "agent-1", agentName: "coder" };

async function fixture(): Promise<{ workspacesRoot: string; workspaceRoot: string }> {
  const workspacesRoot = await mkdtemp(join(tmpdir(), "first-tree-doc-growth-"));
  const workspaceRoot = join(workspacesRoot, input.agentName, input.chatId);
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, "guide.md"), "# Guide", "utf8");
  return { workspacesRoot, workspaceRoot };
}

const FIVE_MIB = 5 * 1024 * 1024;

describe("getMeDocPreview byte bound", () => {
  it("returns 413 when the descriptor yields more than the preview limit", async () => {
    const { workspacesRoot } = await fixture();
    growth.armed = true;
    growth.payload = "a".repeat(FIVE_MIB + 1);

    const error = await getMeDocPreview({ ...input, path: "guide.md", workspacesRoot }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(413);
    expect((error as Error).message).toContain("5MB preview limit");
  });

  it("still reads a file that fits, through the checked descriptor", async () => {
    const { workspacesRoot } = await fixture();
    growth.armed = true;
    growth.payload = "# Guide";

    const preview = await getMeDocPreview({ ...input, path: "guide.md", workspacesRoot });
    expect(preview.content).toBe("# Guide");
    expect(preview.path).toBe("guide.md");
  });
});
