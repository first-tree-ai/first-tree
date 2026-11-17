import { mkdir, mkdtemp, open, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "../errors.js";
import { getMeDocPreview, type WorkspaceDocPreviewInput } from "../services/chat/workspace/document-preview.js";

/**
 * SEC-020: containment has to be decided on the object that is read.
 *
 * A parent `realpath` plus a later `lstat` of a name are two observations of a
 * tree the agent rewrites, so they can be made to agree about different objects.
 * These cases cover the three shapes that matters for:
 *
 * 1. an ancestor swapped for an outside symlink — refused before the open;
 * 2. a leaf swapped for a symlink — refused by `O_NOFOLLOW`;
 * 3. descriptor answers that disagree with the anchored directory — refused by
 *    the containment proof itself, which is what `readDescriptorPath` models
 *    (production reads `/proc/self/fd`, so the stub is the test seam).
 */
const baseInput = { chatId: "chat-1", agentId: "agent-1", agentName: "coder" };

/** Answers for the two descriptors a call opens, in order: directory, then file. */
function descriptorAnswers(...answers: Array<string | null>): (handle: { fd: number }) => Promise<string | null> {
  let index = 0;
  return async () => {
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    return answer ?? null;
  };
}

/** Tracks the paths the module actually opened, so the stub can answer for real descriptors. */
function descriptorSeam(): Pick<WorkspaceDocPreviewInput, "openDir" | "openFile" | "readDescriptorPath"> {
  const opened = new Map<number, string>();
  const track = async (path: string, flags: number) => {
    const handle = await open(path, flags);
    opened.set(handle.fd, path);
    return handle;
  };
  return {
    openDir: track,
    openFile: track,
    readDescriptorPath: async (handle) => opened.get(handle.fd) ?? null,
  };
}

async function fixture(): Promise<{ workspacesRoot: string; subDir: string; outsideDir: string }> {
  const workspacesRoot = await mkdtemp(join(tmpdir(), "first-tree-doc-parent-"));
  const workspaceRoot = join(workspacesRoot, baseInput.agentName, baseInput.chatId);
  const subDir = join(workspaceRoot, "sub");
  await mkdir(subDir, { recursive: true });
  await writeFile(join(subDir, "guide.md"), "# Guide", "utf8");

  const outsideDir = await mkdtemp(join(tmpdir(), "first-tree-doc-parent-outside-"));
  await writeFile(join(outsideDir, "guide.md"), "# OUTSIDE SECRET", "utf8");
  return { workspacesRoot, subDir, outsideDir };
}

describe("getMeDocPreview directory anchoring", () => {
  it("never serves an ancestor that was swapped for an outside symlink", async () => {
    const { workspacesRoot, subDir, outsideDir } = await fixture();

    const preview = await getMeDocPreview({
      ...baseInput,
      ...descriptorSeam(),
      basePath: "sub",
      path: "guide.md",
      workspacesRoot,
      openDir: async (path, flags) => {
        // The name resolved a moment ago was a directory; by the time the anchor
        // is opened, it is a symlink pointing outside the workspace.
        await rename(subDir, `${subDir}-moved`);
        await symlink(outsideDir, subDir);
        return open(path, flags);
      },
    }).catch((thrown: unknown) => thrown);

    expect(preview).toBeInstanceOf(NotFoundError);
    expect(String((preview as Error).message)).not.toContain("OUTSIDE");
  });

  it("still reads the same file when the directory is untouched", async () => {
    const { workspacesRoot } = await fixture();
    const preview = await getMeDocPreview({
      ...baseInput,
      ...descriptorSeam(),
      basePath: "sub",
      path: "guide.md",
      workspacesRoot,
    });
    expect(preview.content).toBe("# Guide");
    expect(preview.path).toBe("sub/guide.md");
  });

  it("refuses a leaf replaced by a symlink between resolution and open", async () => {
    const { workspacesRoot, outsideDir } = await fixture();

    const preview = await getMeDocPreview({
      ...baseInput,
      ...descriptorSeam(),
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

  it("refuses when the opened file reports a location outside the workspace", async () => {
    const { workspacesRoot, subDir, outsideDir } = await fixture();

    const preview = await getMeDocPreview({
      ...baseInput,
      basePath: "sub",
      path: "guide.md",
      workspacesRoot,
      ...descriptorSeam(),
      // Directory answer is truthful; the file's descriptor claims elsewhere.
      readDescriptorPath: descriptorAnswers(await realpath(subDir), join(await realpath(outsideDir), "guide.md")),
    }).catch((thrown: unknown) => thrown);

    expect(preview).toBeInstanceOf(ForbiddenError);
    expect(String((preview as Error).message)).toContain("inside the agent workspace");
  });

  it("refuses when the opened file sits in a different directory than the anchor", async () => {
    const { workspacesRoot, subDir } = await fixture();

    const preview = await getMeDocPreview({
      ...baseInput,
      basePath: "sub",
      path: "guide.md",
      workspacesRoot,
      ...descriptorSeam(),
      // Inside the workspace, but not in the directory the leaf was opened
      // against: the two observations do not describe one object.
      readDescriptorPath: descriptorAnswers(
        await realpath(subDir),
        join(await realpath(join(workspacesRoot, "coder", "chat-1")), "other.md"),
      ),
    }).catch((thrown: unknown) => thrown);

    expect(preview).toBeInstanceOf(ForbiddenError);
  });

  it("refuses when the platform cannot report a descriptor's location", async () => {
    const { workspacesRoot } = await fixture();

    const preview = await getMeDocPreview({
      ...baseInput,
      basePath: "sub",
      path: "guide.md",
      workspacesRoot,
      ...descriptorSeam(),
      readDescriptorPath: descriptorAnswers(null),
    }).catch((thrown: unknown) => thrown);

    expect(preview).toBeInstanceOf(ForbiddenError);
    expect(String((preview as Error).message)).toContain("cannot prove");
  });
});
