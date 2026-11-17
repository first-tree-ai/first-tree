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

/**
 * Descriptor seam.
 *
 * Production opens the leaf as `/proc/self/fd/<dirfd>/<name>`, which the kernel
 * resolves inside the directory *object*. macOS has no procfs, so these cases
 * resolve that form through the directory handle the module actually holds; the
 * "opens the leaf through the descriptor" case asserts the module asked for the
 * descriptor-backed path, so this translation cannot hide a regression back to
 * a plain pathname lookup.
 */
function descriptorSeam(): {
  resolve(path: string): string;
  seam: Pick<WorkspaceDocPreviewInput, "openDir" | "openFile" | "readDescriptorPath">;
} {
  const opened = new Map<number, string>();
  const resolve = (path: string): string => {
    const match = /^\/proc\/self\/fd\/(\d+)\/([^/]+)$/.exec(path);
    if (!match) return path;
    const directory = opened.get(Number(match[1]));
    return directory === undefined ? path : join(directory, match[2] as string);
  };
  const track = async (path: string, flags: number) => {
    const real = resolve(path);
    const handle = await open(real, flags);
    opened.set(handle.fd, real);
    return handle;
  };
  return {
    resolve,
    seam: {
      openDir: track,
      openFile: track,
      readDescriptorPath: async (handle) => opened.get(handle.fd) ?? null,
    },
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
      ...descriptorSeam().seam,
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
      ...descriptorSeam().seam,
      basePath: "sub",
      path: "guide.md",
      workspacesRoot,
    });
    expect(preview.content).toBe("# Guide");
    expect(preview.path).toBe("sub/guide.md");
  });

  it("opens the leaf through the directory descriptor, not through a path string", async () => {
    const { workspacesRoot } = await fixture();
    const opened = new Map<number, string>();
    const leafPaths: string[] = [];
    let directoryFd: number | null = null;

    const preview = await getMeDocPreview({
      ...baseInput,
      basePath: "sub",
      path: "guide.md",
      workspacesRoot,
      openDir: async (path, flags) => {
        const handle = await open(path, flags);
        directoryFd = handle.fd;
        opened.set(handle.fd, path);
        return handle;
      },
      openFile: async (path, flags) => {
        leafPaths.push(path);
        const match = /^\/proc\/self\/fd\/(\d+)\/([^/]+)$/.exec(path);
        // A plain `join(realParentPath, name)` would land here and be refused by
        // the assertion below: the whole point is that the leaf is resolved
        // inside the object the anchor holds.
        if (!match) throw new Error(`leaf was opened by name: ${path}`);
        const directory = opened.get(Number(match[1]));
        if (directory === undefined) throw new Error(`unknown descriptor ${match[1]}`);
        const real = join(directory, match[2] as string);
        const handle = await open(real, flags);
        opened.set(handle.fd, real);
        return handle;
      },
      readDescriptorPath: async (handle) => opened.get(handle.fd) ?? null,
    });

    expect(preview.content).toBe("# Guide");
    expect(leafPaths).toHaveLength(1);
    expect(leafPaths[0]).toBe(`/proc/self/fd/${directoryFd}/guide.md`);
  });

  it("refuses a leaf replaced by a symlink between resolution and open", async () => {
    const { workspacesRoot, outsideDir } = await fixture();
    const { resolve, seam } = descriptorSeam();

    const preview = await getMeDocPreview({
      ...baseInput,
      ...seam,
      basePath: "sub",
      path: "guide.md",
      workspacesRoot,
      openFile: async (path, flags) => {
        // `path` is the descriptor-backed form; swap the name it resolves to.
        const real = resolve(path);
        await rename(real, `${real}-moved`);
        await symlink(join(outsideDir, "guide.md"), real);
        return open(real, flags);
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
      ...descriptorSeam().seam,
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
      ...descriptorSeam().seam,
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
      ...descriptorSeam().seam,
      readDescriptorPath: descriptorAnswers(null),
    }).catch((thrown: unknown) => thrown);

    expect(preview).toBeInstanceOf(ForbiddenError);
    expect(String((preview as Error).message)).toContain("cannot prove");
  });
});
