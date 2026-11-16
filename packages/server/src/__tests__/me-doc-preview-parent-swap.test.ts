import { mkdir, mkdtemp, open, rename, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ForbiddenError } from "../errors.js";
import { getMeDocPreview } from "../services/chat/workspace/document-preview.js";

/**
 * SEC-020: identity checks are not containment checks.
 *
 * Swapping the *file* is caught by dev/ino. Swapping an ancestor **directory**
 * for a symlink is not: the descriptor and the name still agree (both now
 * resolve through the symlink), so only re-resolving the parent after the read
 * can tell that the bytes came from outside the workspace.
 *
 * The descriptor factory is injected rather than module-mocked, so the swap
 * happens at a deterministic point and the case does not depend on test order.
 */
const input = { chatId: "chat-1", agentId: "agent-1", agentName: "coder" };

async function fixture(): Promise<{ workspacesRoot: string; subDir: string; outsideDir: string }> {
  const workspacesRoot = await mkdtemp(join(tmpdir(), "first-tree-doc-parent-"));
  const workspaceRoot = join(workspacesRoot, input.agentName, input.chatId);
  const subDir = join(workspaceRoot, "sub");
  await mkdir(subDir, { recursive: true });
  await writeFile(join(subDir, "guide.md"), "# Guide", "utf8");

  const outsideDir = await mkdtemp(join(tmpdir(), "first-tree-doc-parent-outside-"));
  await writeFile(join(outsideDir, "guide.md"), "# OUTSIDE SECRET", "utf8");
  return { workspacesRoot, subDir, outsideDir };
}

describe("getMeDocPreview parent-directory swap", () => {
  it("refuses a parent directory swapped for an outside symlink after resolution", async () => {
    const { workspacesRoot, subDir, outsideDir } = await fixture();

    const preview = await getMeDocPreview({
      ...input,
      basePath: "sub",
      path: "guide.md",
      workspacesRoot,
      openFile: async (path, flags) => {
        // The name resolved a moment ago was inside; by the time the descriptor
        // is opened, an ancestor is a symlink to somewhere else.
        await rename(subDir, `${subDir}-moved`);
        await symlink(outsideDir, subDir);
        return open(path, flags);
      },
    }).catch((thrown: unknown) => thrown);

    expect(preview).toBeInstanceOf(ForbiddenError);
    expect((preview as Error).message).toContain("changed while it was being read");
  });

  it("still reads the same file when the parent is untouched", async () => {
    const { workspacesRoot } = await fixture();
    const preview = await getMeDocPreview({
      ...input,
      basePath: "sub",
      path: "guide.md",
      workspacesRoot,
    });
    expect(preview.content).toBe("# Guide");
    expect(preview.path).toBe("sub/guide.md");
  });

  it("refuses a leaf replaced by a symlink between resolution and open", async () => {
    const { workspacesRoot, subDir, outsideDir } = await fixture();
    const target = join(subDir, "guide.md");
    // Precondition: the file is a regular file right now.
    expect((await stat(target)).isFile()).toBe(true);

    const preview = await getMeDocPreview({
      ...input,
      basePath: "sub",
      path: "guide.md",
      workspacesRoot,
      openFile: async (path, flags) => {
        await rename(path, `${path}-moved`);
        await symlink(join(outsideDir, "guide.md"), path);
        return open(path, flags);
      },
    }).catch((thrown: unknown) => thrown);

    // `O_NOFOLLOW` turns the swapped leaf into ELOOP, which is reported as a
    // refusal rather than surfacing as "not found".
    expect(preview).toBeInstanceOf(ForbiddenError);
    expect((preview as Error).message).toContain("must not be a symlink");
  });
});
