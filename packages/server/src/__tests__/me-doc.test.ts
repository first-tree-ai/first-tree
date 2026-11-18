import { mkdir, mkdtemp, open, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "../errors.js";
import { getMeDocPreview, type WorkspaceDocPreviewInput } from "../services/chat/workspace/document-preview.js";

/**
 * Descriptor-path seam.
 *
 * Production reads `/proc/self/fd/<fd>`, which only exists on Linux; these cases
 * wrap the real `open` so the stub answers with the path the module actually
 * opened, which is exactly what the kernel reports there.
 */
function descriptorSeam(): Pick<WorkspaceDocPreviewInput, "openDir" | "openFile" | "readDescriptorPath"> {
  const opened = new Map<number, string>();
  // The module opens the leaf as `/proc/self/fd/<dirfd>/<name>`. macOS has no
  // procfs, so the seam resolves that form through the directory handle the
  // module holds; the descriptor-backed open itself is asserted in
  // `me-doc-preview-parent-swap.test.ts`.
  const track = async (path: string, flags: number) => {
    const match = /^\/proc\/self\/fd\/(\d+)\/([^/]+)$/.exec(path);
    const directory = match ? opened.get(Number(match[1])) : undefined;
    const real = match && directory !== undefined ? join(directory, match[2] as string) : path;
    const handle = await open(real, flags);
    opened.set(handle.fd, real);
    return handle;
  };
  return {
    openDir: track,
    openFile: track,
    readDescriptorPath: async (handle) => opened.get(handle.fd) ?? null,
  };
}

const baseInput = {
  chatId: "chat-1",
  agentId: "agent-1",
  agentName: "coder",
};

async function makeWorkspace(): Promise<{ workspacesRoot: string; workspaceRoot: string }> {
  const workspacesRoot = await mkdtemp(join(tmpdir(), "first-tree-workspaces-"));
  const workspaceRoot = join(workspacesRoot, baseInput.agentName, baseInput.chatId);
  await mkdir(workspaceRoot, { recursive: true });
  return { workspacesRoot, workspaceRoot };
}

describe("getMeDocPreview", () => {
  it("reads markdown files under an agent chat workspace", async () => {
    const { workspacesRoot, workspaceRoot } = await makeWorkspace();
    await writeFile(join(workspaceRoot, "guide.md"), "# Guide\n\nHello.", "utf8");

    await expect(
      getMeDocPreview({ ...baseInput, ...descriptorSeam(), path: "guide.md", workspacesRoot }),
    ).resolves.toEqual({
      ref: { type: "workspace", chatId: "chat-1", agentId: "agent-1", path: "guide.md" },
      path: "guide.md",
      content: "# Guide\n\nHello.",
    });
  });

  it("supports an optional base path inside the workspace", async () => {
    const { workspacesRoot, workspaceRoot } = await makeWorkspace();
    await mkdir(join(workspaceRoot, "first-tree", "docs"), { recursive: true });
    await writeFile(join(workspaceRoot, "first-tree", "docs", "design.md"), "# Design", "utf8");

    await expect(
      getMeDocPreview({
        ...baseInput,
        ...descriptorSeam(),
        basePath: "first-tree",
        path: "docs/design.md",
        workspacesRoot,
      }),
    ).resolves.toMatchObject({
      ref: {
        type: "workspace",
        chatId: "chat-1",
        agentId: "agent-1",
        basePath: "first-tree",
        path: "docs/design.md",
      },
      path: "first-tree/docs/design.md",
      content: "# Design",
    });
  });

  it("rejects paths that escape the workspace", async () => {
    const { workspacesRoot, workspaceRoot } = await makeWorkspace();
    await writeFile(join(workspaceRoot, "inside.md"), "inside", "utf8");

    await expect(
      getMeDocPreview({ ...baseInput, ...descriptorSeam(), path: "../package.md", workspacesRoot }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects non-markdown files", async () => {
    const { workspacesRoot, workspaceRoot } = await makeWorkspace();
    await writeFile(join(workspaceRoot, "notes.txt"), "notes", "utf8");

    await expect(
      getMeDocPreview({ ...baseInput, ...descriptorSeam(), path: "notes.txt", workspacesRoot }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects symlinks that escape the workspace", async () => {
    const { workspacesRoot, workspaceRoot } = await makeWorkspace();
    const outside = join(workspacesRoot, "outside.md");
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, join(workspaceRoot, "linked.md"));

    await expect(
      getMeDocPreview({ ...baseInput, ...descriptorSeam(), path: "linked.md", workspacesRoot }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects documents above the preview size limit", async () => {
    const { workspacesRoot, workspaceRoot } = await makeWorkspace();
    await writeFile(join(workspaceRoot, "large.md"), "x".repeat(5 * 1024 * 1024 + 1), "utf8");

    await expect(
      getMeDocPreview({ ...baseInput, ...descriptorSeam(), path: "large.md", workspacesRoot }),
    ).rejects.toMatchObject({
      statusCode: 413,
    });
  });

  it("returns not found for missing markdown files", async () => {
    const { workspacesRoot } = await makeWorkspace();

    await expect(
      getMeDocPreview({ ...baseInput, ...descriptorSeam(), path: "missing.md", workspacesRoot }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("returns not found when the workspace root itself is missing", async () => {
    const workspacesRoot = await mkdtemp(join(tmpdir(), "first-tree-workspaces-missing-"));

    await expect(
      getMeDocPreview({ ...baseInput, ...descriptorSeam(), path: "guide.md", workspacesRoot }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("returns not found when the markdown path is a directory", async () => {
    const { workspacesRoot, workspaceRoot } = await makeWorkspace();
    await mkdir(join(workspaceRoot, "directory.md"));

    await expect(
      getMeDocPreview({ ...baseInput, ...descriptorSeam(), path: "directory.md", workspacesRoot }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("normalizes the public ref path separately from the resolved workspace path", async () => {
    const { workspacesRoot, workspaceRoot } = await makeWorkspace();
    await mkdir(join(workspaceRoot, "nested"));
    await writeFile(join(workspaceRoot, "guide.md"), "# Guide", "utf8");

    await expect(
      getMeDocPreview({ ...baseInput, ...descriptorSeam(), basePath: "nested", path: "../guide.md", workspacesRoot }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects empty public ref paths even when the base path resolves to a markdown file", async () => {
    const { workspacesRoot, workspaceRoot } = await makeWorkspace();
    await writeFile(join(workspaceRoot, "guide.md"), "# Guide", "utf8");

    await expect(
      getMeDocPreview({ ...baseInput, ...descriptorSeam(), basePath: "guide.md", path: "", workspacesRoot }),
    ).rejects.toThrow(/must name a markdown file/);
  });
});
